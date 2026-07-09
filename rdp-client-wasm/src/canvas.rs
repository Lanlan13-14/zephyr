use core::num::NonZeroU32;

use anyhow::anyhow;
use ironrdp::pdu::geometry::{InclusiveRectangle, Rectangle as _};
use js_sys::{Function, Reflect, Uint8Array};
use wasm_bindgen::{JsCast as _, JsValue};

/// Worker-friendly render surface.
///
/// IronRDP decodes into RGBA regions. Instead of touching an HtmlCanvasElement
/// (not available in a DedicatedWorker), forward the region to JS through
/// globalThis.rdpDrawBitmapRGBA. The Worker writes the tile into a
/// SharedArrayBuffer and the main thread flushes it from requestAnimationFrame.
pub(crate) struct Canvas {
    width: NonZeroU32,
    height: NonZeroU32,
}

impl Canvas {
    pub(crate) fn new(_render_canvas: JsValue, width: NonZeroU32, height: NonZeroU32) -> anyhow::Result<Self> {
        call_resize(width.get(), height.get())?;
        Ok(Self { width, height })
    }

    pub(crate) fn resize(&mut self, width: NonZeroU32, height: NonZeroU32) {
        self.width = width;
        self.height = height;
        let _ = call_resize(width.get(), height.get());
    }

    pub(crate) fn draw(&self, buffer: &mut [u8], region: InclusiveRectangle) -> anyhow::Result<()> {
        for pixel in buffer.chunks_exact_mut(4) {
            pixel[3] = 0xFF;
        }
        let global = js_sys::global();
        let func = Reflect::get(&global, &JsValue::from_str("rdpDrawBitmapRGBA"))
            .map_err(|err| anyhow!("get rdpDrawBitmapRGBA failed: {err:?}"))?
            .dyn_into::<Function>()
            .map_err(|_| anyhow!("globalThis.rdpDrawBitmapRGBA is not a function"))?;
        let bytes = Uint8Array::from(&*buffer);
        func.call5(
            &JsValue::NULL,
            &JsValue::from_f64(f64::from(region.left)),
            &JsValue::from_f64(f64::from(region.top)),
            &JsValue::from_f64(f64::from(region.width())),
            &JsValue::from_f64(f64::from(region.height())),
            &bytes,
        )
        .map_err(|err| anyhow!("rdpDrawBitmapRGBA failed: {err:?}"))?;
        Ok(())
    }
}

fn call_resize(width: u32, height: u32) -> anyhow::Result<()> {
    let global = js_sys::global();
    let value = Reflect::get(&global, &JsValue::from_str("rdpOnDesktopResize"))
        .map_err(|err| anyhow!("get rdpOnDesktopResize failed: {err:?}"))?;
    if value.is_undefined() || value.is_null() {
        return Ok(());
    }
    let func = value
        .dyn_into::<Function>()
        .map_err(|_| anyhow!("globalThis.rdpOnDesktopResize is not a function"))?;
    func.call2(
        &JsValue::NULL,
        &JsValue::from_f64(f64::from(width)),
        &JsValue::from_f64(f64::from(height)),
    )
    .map_err(|err| anyhow!("rdpOnDesktopResize failed: {err:?}"))?;
    Ok(())
}
