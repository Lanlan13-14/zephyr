/**
 * RDP Audio Worklet Processor
 * 
 * Low-latency audio playback using SharedArrayBuffer ring buffer.
 * Receives float32 audio samples from main thread and outputs to speakers.
 * 
 * Ring Buffer Layout (SharedArrayBuffer):
 *   [0-3]:     writeIndex (Uint32) - where main thread writes next
 *   [4-7]:     readIndex (Uint32) - where worklet reads next (for debugging)
 *   [8-11]:    bufferSize (Uint32) - total samples per channel
 *   [12-15]:   channels (Uint32) - number of audio channels
 *   [16+]:     audio data (Float32) - interleaved stereo samples
 */

class RDPAudioProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        
        // Ring buffer state
        this.sharedBuffer = null;
        this.controlView = null;    // Uint32Array for control data
        this.audioView = null;      // Float32Array for audio samples
        this.localReadIndex = 0;
        this.bufferSize = 0;
        this.channels = 2;
        this.muted = false;
        this.initialized = false;
        
        // Stats
        this.underrunCount = 0;
        this.lastStatsTime = 0;
        this.samplesPlayed = 0;
        
        // Handle messages from main thread
        this.port.onmessage = (event) => {
            const { type, data } = event.data;
            
            switch (type) {
                case 'init':
                    this._initBuffer(data);
                    break;
                case 'mute':
                    this.muted = data.muted;
                    break;
                case 'reset':
                    this._reset();
                    break;
            }
        };
    }
    
    /**
     * Initialize the ring buffer from SharedArrayBuffer
     */
    _initBuffer(data) {
        const { sharedBuffer, bufferSize, channels } = data;
        
        this.sharedBuffer = sharedBuffer;
        this.bufferSize = bufferSize;
        this.channels = channels;
        
        // Control region: first 16 bytes (4 Uint32s)
        this.controlView = new Uint32Array(sharedBuffer, 0, 4);
        
        // Audio region: after control data
        const audioOffset = 16; // 4 * sizeof(Uint32)
        const audioLength = bufferSize * channels;
        this.audioView = new Float32Array(sharedBuffer, audioOffset, audioLength);
        
        this.localReadIndex = 0;
        this.initialized = true;
        
        this.port.postMessage({ type: 'ready' });
    }
    
    /**
     * Reset read position (e.g., on reconnect)
     */
    _reset() {
        this.localReadIndex = 0;
        this.underrunCount = 0;
        this.samplesPlayed = 0;
        
        if (this.controlView) {
            // Sync with current write position
            this.localReadIndex = Atomics.load(this.controlView, 0);
        }
    }
    
    /**
     * Get number of samples available to read
     */
    _availableSamples() {
        if (!this.controlView) return 0;
        
        const writeIndex = Atomics.load(this.controlView, 0);
        const readIndex = this.localReadIndex;
        
        if (writeIndex >= readIndex) {
            return writeIndex - readIndex;
        } else {
            // Wrapped around
            return (this.bufferSize - readIndex) + writeIndex;
        }
    }
    
    /**
     * Process audio - called by Web Audio API (~every 2.67ms at 48kHz)
     * @param {Float32Array[][]} inputs - Input audio (unused)
     * @param {Float32Array[][]} outputs - Output audio buffers
     * @param {Object} parameters - Audio parameters (unused)
     * @returns {boolean} - true to keep processor alive
     */
    process(inputs, outputs, parameters) {
        if (!this.initialized || this.muted) {
            // Output silence
            for (const output of outputs) {
                for (const channel of output) {
                    channel.fill(0);
                }
            }
            return true;
        }
        
        const output = outputs[0];
        const outputLength = output[0]?.length || 128;
        const numChannels = Math.min(output.length, this.channels);
        
        const available = this._availableSamples();
        const samplesToRead = Math.min(available, outputLength);
        
        if (samplesToRead === 0) {
            // Buffer underrun - output silence
            for (let ch = 0; ch < output.length; ch++) {
                output[ch].fill(0);
            }
            this.underrunCount++;
            
            // Report underrun periodically
            const now = currentTime;
            if (now - this.lastStatsTime > 1) {
                this.port.postMessage({
                    type: 'stats',
                    underruns: this.underrunCount,
                    samplesPlayed: this.samplesPlayed
                });
                this.lastStatsTime = now;
            }
            return true;
        }
        
        // Read samples from ring buffer
        for (let i = 0; i < outputLength; i++) {
            if (i < samplesToRead) {
                const bufferIndex = (this.localReadIndex + i) % this.bufferSize;
                
                // Read interleaved samples
                for (let ch = 0; ch < numChannels; ch++) {
                    const sampleIndex = bufferIndex * this.channels + ch;
                    output[ch][i] = this.audioView[sampleIndex];
                }
                
                // Fill remaining output channels with copy of last channel
                for (let ch = numChannels; ch < output.length; ch++) {
                    output[ch][i] = output[numChannels - 1][i];
                }
            } else {
                // Partial underrun - fill rest with silence
                for (let ch = 0; ch < output.length; ch++) {
                    output[ch][i] = 0;
                }
            }
        }
        
        // Update read index
        this.localReadIndex = (this.localReadIndex + samplesToRead) % this.bufferSize;
        this.samplesPlayed += samplesToRead;
        
        // Store read index for debugging (non-atomic is fine, just informational)
        if (this.controlView) {
            this.controlView[1] = this.localReadIndex;
        }
        
        // Periodic stats
        const now = currentTime;
        if (now - this.lastStatsTime > 5) {
            this.port.postMessage({
                type: 'stats',
                underruns: this.underrunCount,
                samplesPlayed: this.samplesPlayed,
                available: this._availableSamples()
            });
            this.lastStatsTime = now;
        }
        
        return true;
    }
}

registerProcessor('rdp-audio-processor', RDPAudioProcessor);
