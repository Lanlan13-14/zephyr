//! Zephyr audio output backend for RDPSND.
//!
//! Replaces IronRDP's NoopRdpsndBackend. When the RDP server sends PCM wave
//! data, this backend forwards it to globalThis.rdpAudioPlay(sample_rate,
//! channels, bits_per_sample, Uint8Array) which the Worker postMessages to
//! the main thread for AudioContext scheduling.

use std::borrow::Cow;

use ironrdp::rdpsnd::client::{RdpsndClientHandler};
use ironrdp::rdpsnd::pdu::{AudioFormat, AudioFormatFlags, PitchPdu, VolumePdu, WaveFormat};
use js_sys::{Function, Reflect, Uint8Array};
use wasm_bindgen::{JsCast as _, JsValue};

#[derive(Debug)]
pub(crate) struct ZephyrRdpsndBackend {
    formats: Vec<AudioFormat>,
}

impl ZephyrRdpsndBackend {
    pub(crate) fn new() -> Self {
        // Advertise PCM formats commonly produced by Windows RDP servers.
        // The server will pick one and send wave data in that format.
        Self {
            formats: vec![
                AudioFormat {
                    format: WaveFormat::PCM,
                    n_channels: 2,
                    n_samples_per_sec: 44100,
                    n_avg_bytes_per_sec: 44100 * 2 * 2,
                    n_block_align: 4,
                    bits_per_sample: 16,
                    data: None,
                },
                AudioFormat {
                    format: WaveFormat::PCM,
                    n_channels: 2,
                    n_samples_per_sec: 48000,
                    n_avg_bytes_per_sec: 48000 * 2 * 2,
                    n_block_align: 4,
                    bits_per_sample: 16,
                    data: None,
                },
                AudioFormat {
                    format: WaveFormat::PCM,
                    n_channels: 1,
                    n_samples_per_sec: 22050,
                    n_avg_bytes_per_sec: 22050 * 1 * 2,
                    n_block_align: 2,
                    bits_per_sample: 16,
                    data: None,
                },
            ],
        }
    }
}

impl RdpsndClientHandler for ZephyrRdpsndBackend {
    fn get_flags(&self) -> AudioFormatFlags {
        AudioFormatFlags::ALIVE
    }

    fn get_formats(&self) -> &[AudioFormat] {
        &self.formats
    }

    fn wave(&mut self, format_no: usize, _ts: u32, data: Cow<'_, [u8]>) {
        let format = self.formats.get(format_no);
        let (sr, ch, bps) = match format {
            Some(f) => (f.n_samples_per_sec, f.n_channels, f.bits_per_sample),
            None => (44100u32, 2u16, 16u16),
        };
        let global = js_sys::global();
        let func = match Reflect::get(&global, &JsValue::from_str("rdpAudioPlay")) {
            Ok(v) if v.is_function() => v,
            _ => return,
        };
        let func = func.unchecked_into::<Function>();
        let arr = Uint8Array::from(&data[..]);
        let _ = func.call4(
            &JsValue::NULL,
            &JsValue::from_f64(sr as f64),
            &JsValue::from_f64(ch as f64),
            &JsValue::from_f64(bps as f64),
            &arr,
        );
    }

    fn set_volume(&mut self, _volume: VolumePdu) {
        // Volume control is handled by the main-thread AudioContext gain node.
    }

    fn set_pitch(&mut self, _pitch: PitchPdu) {}

    fn close(&mut self) {
        let global = js_sys::global();
        if let Ok(v) = Reflect::get(&global, &JsValue::from_str("rdpAudioReset")) {
            if v.is_function() {
                let _ = v.unchecked_into::<Function>().call0(&JsValue::NULL);
            }
        }
    }
}
