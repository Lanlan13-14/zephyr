//go:build darwin && cgo

package aac

/*
#cgo LDFLAGS: -framework AudioToolbox
#cgo nocallback grdp_aac_converter_new
#cgo nocallback grdp_aac_decode
#cgo nocallback AudioConverterDispose
#cgo noescape grdp_aac_converter_new
#cgo noescape grdp_aac_decode
#include <AudioToolbox/AudioToolbox.h>
#include <stdlib.h>

typedef struct {
	const uint8_t *data;
	uint32_t       size;
	int            consumed;
} grdp_aac_input_t;

// AudioConverter input callback — called by AudioToolbox to pull one AAC
// packet per invocation.  Returns noErr on the first call, then -1 (no data)
// on subsequent calls to signal end-of-input for the current decode round.
static OSStatus grdp_aac_input_proc(
	AudioConverterRef              inConverter,
	UInt32                        *ioNumberDataPackets,
	AudioBufferList               *ioData,
	AudioStreamPacketDescription **outDataPacketDescription,
	void                          *inUserData)
{
	grdp_aac_input_t *state = (grdp_aac_input_t *)inUserData;
	if (state->consumed || state->size == 0) {
		*ioNumberDataPackets = 0;
		ioData->mBuffers[0].mData         = NULL;
		ioData->mBuffers[0].mDataByteSize = 0;
		return -1;
	}
	*ioNumberDataPackets = 1;
	ioData->mBuffers[0].mData         = (void *)state->data;
	ioData->mBuffers[0].mDataByteSize = state->size;
	if (outDataPacketDescription != NULL) {
		static AudioStreamPacketDescription desc;
		desc.mStartOffset             = 0;
		desc.mDataByteSize            = state->size;
		desc.mVariableFramesInPacket  = 0;
		*outDataPacketDescription = &desc;
	}
	state->consumed = 1;
	return noErr;
}

// grdp_aac_converter_new creates an AudioConverter that decodes MPEG-4 AAC at
// the given sample rate / channel count.  asc/ascLen is the AudioSpecificConfig
// stored in the WAVEFORMATEX ExtraData field; it may be NULL/0 for ADTS input.
static AudioConverterRef grdp_aac_converter_new(
	double          sampleRate,
	uint32_t        channels,
	const uint8_t  *asc,
	uint32_t        ascLen,
	OSStatus       *outErr)
{
	AudioStreamBasicDescription inFmt = {
		.mSampleRate       = sampleRate,
		.mFormatID         = kAudioFormatMPEG4AAC,
		.mChannelsPerFrame = channels,
	};
	AudioStreamBasicDescription outFmt = {
		.mSampleRate       = sampleRate,
		.mFormatID         = kAudioFormatLinearPCM,
		.mFormatFlags      = kLinearPCMFormatFlagIsSignedInteger |
		                     kLinearPCMFormatFlagIsPacked,
		.mBitsPerChannel   = 16,
		.mChannelsPerFrame = channels,
		.mBytesPerFrame    = (uint32_t)(2 * channels),
		.mFramesPerPacket  = 1,
		.mBytesPerPacket   = (uint32_t)(2 * channels),
	};
	AudioConverterRef conv = NULL;
	OSStatus err = AudioConverterNew(&inFmt, &outFmt, &conv);
	if (err != noErr) { *outErr = err; return NULL; }
	if (ascLen > 0 && asc != NULL) {
		err = AudioConverterSetProperty(
			conv,
			kAudioConverterDecompressionMagicCookie,
			ascLen, asc);
		if (err != noErr) {
			AudioConverterDispose(conv);
			*outErr = err;
			return NULL;
		}
	}
	*outErr = noErr;
	return conv;
}

// grdp_aac_decode decodes one AAC packet (inData/inSize) into signed 16-bit
// little-endian PCM stored in outBuf.  *outBytesWritten is set to the number
// of bytes actually written.  Returns noErr on success.
static OSStatus grdp_aac_decode(
	AudioConverterRef  conv,
	const uint8_t     *inData,
	uint32_t           inSize,
	uint8_t           *outBuf,
	uint32_t           outBufSize,
	uint32_t          *outBytesWritten)
{
	grdp_aac_input_t state = { inData, inSize, 0 };
	AudioBufferList outList = {
		.mNumberBuffers       = 1,
		.mBuffers[0] = {
			.mNumberChannels  = 0,
			.mDataByteSize    = outBufSize,
			.mData            = outBuf,
		},
	};
	// AAC-LC produces 1024 samples/channel per frame; AAC-HE produces 2048.
	// 4096 is large enough for both at up to 2 channels.
	UInt32 numFrames = 4096;
	OSStatus err = AudioConverterFillComplexBuffer(
		conv, grdp_aac_input_proc, &state, &numFrames, &outList, NULL);
	// -1 from the input callback signals "no more data"; that is not an error.
	if (err != noErr && err != -1) {
		*outBytesWritten = 0;
		return err;
	}
	*outBytesWritten = outList.mBuffers[0].mDataByteSize;
	return noErr;
}
*/
import "C"

import (
	"fmt"
	"log/slog"
	"runtime"
	"unsafe"

	"github.com/nakagami/grdp/plugin/rdpsnd"
)

// darwinDecoder decodes MPEG-4 AAC audio into signed 16-bit PCM using
// macOS AudioToolbox (hardware-accelerated on Apple Silicon / Intel iGPU).
type darwinDecoder struct {
	conv     C.AudioConverterRef
	channels int
	outBuf   []byte // reusable output scratch buffer
}

func newDecoder(format rdpsnd.AudioFormat) (Decoder, error) {
	var oscErr C.OSStatus
	var ascPtr *C.uint8_t
	ascLen := C.uint32_t(0)
	if len(format.ExtraData) > 0 {
		ascPtr = (*C.uint8_t)(unsafe.Pointer(&format.ExtraData[0]))
		ascLen = C.uint32_t(len(format.ExtraData))
	}
	conv := C.grdp_aac_converter_new(
		C.double(format.SamplesPerSec),
		C.uint32_t(format.Channels),
		ascPtr, ascLen,
		&oscErr)
	if len(format.ExtraData) > 0 {
		runtime.KeepAlive(format.ExtraData)
	}
	if conv == nil {
		return nil, fmt.Errorf("AudioToolbox: AudioConverterNew failed (err=%d)", int32(oscErr))
	}
	slog.Info("AAC decoder created",
		"rate", format.SamplesPerSec,
		"channels", format.Channels,
		"ascLen", len(format.ExtraData))
	// 4096 samples × channels × 2 bytes/sample — large enough for AAC-HE at 2 ch.
	outBufSize := 4096 * int(format.Channels) * 2
	return &darwinDecoder{conv: conv, channels: int(format.Channels), outBuf: make([]byte, outBufSize)}, nil
}

// Decode decodes one raw AAC packet into signed 16-bit little-endian PCM.
// Returns nil, nil when data is empty.
func (d *darwinDecoder) Decode(data []byte) ([]byte, error) {
	if len(data) == 0 {
		return nil, nil
	}
	var written C.uint32_t
	err := C.grdp_aac_decode(
		d.conv,
		(*C.uint8_t)(unsafe.Pointer(&data[0])),
		C.uint32_t(len(data)),
		(*C.uint8_t)(unsafe.Pointer(&d.outBuf[0])),
		C.uint32_t(len(d.outBuf)),
		&written)
	runtime.KeepAlive(data)
	runtime.KeepAlive(d.outBuf)
	if err != 0 {
		return nil, fmt.Errorf("AudioToolbox: decode error %d", int32(err))
	}
	if written == 0 {
		return nil, nil
	}
	out := make([]byte, int(written))
	copy(out, d.outBuf[:written])
	return out, nil
}

// Close releases the AudioConverter.
func (d *darwinDecoder) Close() {
	if d.conv != nil {
		C.AudioConverterDispose(d.conv)
		d.conv = nil
	}
}
