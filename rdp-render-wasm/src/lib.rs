use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct TilePool {
    tile_w: u32,
    tile_h: u32,
    free: Vec<Vec<u8>>,
}

#[wasm_bindgen]
impl TilePool {
    #[wasm_bindgen(constructor)]
    pub fn new(tile_w: u32, tile_h: u32, capacity: u32) -> TilePool {
        let len = tile_w.saturating_mul(tile_h).saturating_mul(4) as usize;
        let mut free = Vec::with_capacity(capacity as usize);
        for _ in 0..capacity {
            free.push(vec![0; len]);
        }
        TilePool { tile_w, tile_h, free }
    }

    pub fn tile_width(&self) -> u32 { self.tile_w }
    pub fn tile_height(&self) -> u32 { self.tile_h }
    pub fn available(&self) -> u32 { self.free.len() as u32 }

    pub fn release(&mut self, data: Vec<u8>) {
        let expected = self.tile_w.saturating_mul(self.tile_h).saturating_mul(4) as usize;
        if data.len() == expected {
            self.free.push(data);
        }
    }
}

#[wasm_bindgen]
pub struct DirtyQueue {
    rects: Vec<u32>,
}

#[wasm_bindgen]
impl DirtyQueue {
    #[wasm_bindgen(constructor)]
    pub fn new() -> DirtyQueue {
        DirtyQueue { rects: Vec::new() }
    }

    pub fn push(&mut self, x: u32, y: u32, w: u32, h: u32) {
        if w == 0 || h == 0 { return; }
        self.rects.extend_from_slice(&[x, y, w, h]);
    }

    pub fn clear(&mut self) { self.rects.clear(); }
    pub fn len(&self) -> u32 { (self.rects.len() / 4) as u32 }
    pub fn is_empty(&self) -> bool { self.rects.is_empty() }

    pub fn take_merged(&mut self) -> Vec<u32> {
        if self.rects.is_empty() { return Vec::new(); }
        let mut x0 = u32::MAX;
        let mut y0 = u32::MAX;
        let mut x1 = 0u32;
        let mut y1 = 0u32;
        for rect in self.rects.chunks_exact(4) {
            let x = rect[0];
            let y = rect[1];
            let w = rect[2];
            let h = rect[3];
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x.saturating_add(w));
            y1 = y1.max(y.saturating_add(h));
        }
        self.rects.clear();
        vec![x0, y0, x1.saturating_sub(x0), y1.saturating_sub(y0)]
    }
}

#[wasm_bindgen]
pub struct FrameCompositor {
    width: u32,
    height: u32,
    shadow: Vec<u8>,
    dirty: bool,
    dx0: u32,
    dy0: u32,
    dx1: u32,
    dy1: u32,
}

#[wasm_bindgen]
impl FrameCompositor {
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32) -> FrameCompositor {
        let len = width.saturating_mul(height).saturating_mul(4) as usize;
        FrameCompositor {
            width,
            height,
            shadow: vec![0; len],
            dirty: false,
            dx0: 0,
            dy0: 0,
            dx1: 0,
            dy1: 0,
        }
    }

    pub fn width(&self) -> u32 { self.width }
    pub fn height(&self) -> u32 { self.height }

    pub fn blit_tile(&mut self, x: u32, y: u32, w: u32, h: u32, data: &[u8]) -> bool {
        if w == 0 || h == 0 || self.width == 0 || self.height == 0 { return false; }
        if x >= self.width || y >= self.height { return false; }

        let clipped_w = w.min(self.width - x);
        let clipped_h = h.min(self.height - y);
        if clipped_w == 0 || clipped_h == 0 { return false; }

        let src_stride = w.saturating_mul(4) as usize;
        let copy_bytes = clipped_w.saturating_mul(4) as usize;
        let required = src_stride.saturating_mul(clipped_h as usize);
        if data.len() < required { return false; }

        for row in 0..clipped_h {
            let src = row as usize * src_stride;
            let dst = ((y + row) as usize * self.width as usize + x as usize) * 4;
            let dst_end = dst.saturating_add(copy_bytes);
            let src_end = src.saturating_add(copy_bytes);
            if dst_end > self.shadow.len() || src_end > data.len() { return false; }
            self.shadow[dst..dst_end].copy_from_slice(&data[src..src_end]);
        }

        self.mark_dirty(x, y, clipped_w, clipped_h);
        true
    }

    pub fn take_dirty(&mut self) -> Vec<u32> {
        if !self.dirty { return Vec::new(); }
        self.dirty = false;
        let x = self.dx0;
        let y = self.dy0;
        vec![x, y, self.dx1.saturating_sub(x), self.dy1.saturating_sub(y)]
    }

    pub fn get_dirty_pixels(&self, x: u32, y: u32, w: u32, h: u32) -> Vec<u8> {
        if w == 0 || h == 0 || x >= self.width || y >= self.height {
            return Vec::new();
        }
        let clipped_w = w.min(self.width - x);
        let clipped_h = h.min(self.height - y);
        let row_bytes = clipped_w.saturating_mul(4) as usize;
        let mut out = Vec::with_capacity(row_bytes.saturating_mul(clipped_h as usize));
        for row in 0..clipped_h {
            let off = ((y + row) as usize * self.width as usize + x as usize) * 4;
            let end = off.saturating_add(row_bytes);
            if end > self.shadow.len() { return Vec::new(); }
            out.extend_from_slice(&self.shadow[off..end]);
        }
        out
    }

    pub fn resize(&mut self, w: u32, h: u32) {
        self.width = w;
        self.height = h;
        self.shadow = vec![0; w.saturating_mul(h).saturating_mul(4) as usize];
        self.dirty = false;
        self.dx0 = 0;
        self.dy0 = 0;
        self.dx1 = 0;
        self.dy1 = 0;
    }

    pub fn clear(&mut self, r: u8, g: u8, b: u8, a: u8) {
        for px in self.shadow.chunks_exact_mut(4) {
            px[0] = r;
            px[1] = g;
            px[2] = b;
            px[3] = a;
        }
        if self.width != 0 && self.height != 0 {
            self.mark_dirty(0, 0, self.width, self.height);
        }
    }

    fn mark_dirty(&mut self, x: u32, y: u32, w: u32, h: u32) {
        if !self.dirty {
            self.dx0 = x;
            self.dy0 = y;
            self.dx1 = x.saturating_add(w);
            self.dy1 = y.saturating_add(h);
            self.dirty = true;
        } else {
            self.dx0 = self.dx0.min(x);
            self.dy0 = self.dy0.min(y);
            self.dx1 = self.dx1.max(x.saturating_add(w));
            self.dy1 = self.dy1.max(y.saturating_add(h));
        }
    }
}

#[wasm_bindgen]
pub fn bgra_to_rgba(src: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(src.len());
    for px in src.chunks_exact(4) {
        out.push(px[2]);
        out.push(px[1]);
        out.push(px[0]);
        out.push(px[3]);
    }
    out
}

#[wasm_bindgen]
pub fn bgr24_to_bgra(src: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity((src.len() / 3) * 4);
    for px in src.chunks_exact(3) {
        out.push(px[0]);
        out.push(px[1]);
        out.push(px[2]);
        out.push(0xFF);
    }
    out
}

#[wasm_bindgen]
pub fn rgb565_to_bgra(src: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity((src.len() / 2) * 4);
    for px in src.chunks_exact(2) {
        let v = u16::from_le_bytes([px[0], px[1]]);
        let r5 = ((v >> 11) & 0x1F) as u8;
        let g6 = ((v >> 5) & 0x3F) as u8;
        let b5 = (v & 0x1F) as u8;
        let r = (r5 << 3) | (r5 >> 2);
        let g = (g6 << 2) | (g6 >> 4);
        let b = (b5 << 3) | (b5 >> 2);
        out.extend_from_slice(&[b, g, r, 0xFF]);
    }
    out
}

#[wasm_bindgen]
pub fn crop_bgra(src: &[u8], src_w: u32, src_h: u32, x: u32, y: u32, w: u32, h: u32) -> Vec<u8> {
    if src_w == 0 || src_h == 0 || x >= src_w || y >= src_h || w == 0 || h == 0 {
        return Vec::new();
    }
    let clipped_w = w.min(src_w - x);
    let clipped_h = h.min(src_h - y);
    let stride = src_w.saturating_mul(4) as usize;
    let row_bytes = clipped_w.saturating_mul(4) as usize;
    let mut out = Vec::with_capacity(row_bytes.saturating_mul(clipped_h as usize));
    for row in 0..clipped_h {
        let off = ((y + row) as usize * src_w as usize + x as usize) * 4;
        let end = off.saturating_add(row_bytes);
        if end > src.len() || end < off || stride == 0 { return Vec::new(); }
        out.extend_from_slice(&src[off..end]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compositor_merges_dirty_and_crops_edges() {
        let mut c = FrameCompositor::new(4, 3);
        assert!(c.blit_tile(1, 1, 3, 2, &[1; 3 * 2 * 4]));
        assert!(c.blit_tile(3, 0, 3, 2, &[2; 3 * 2 * 4]));
        assert_eq!(c.take_dirty(), vec![1, 0, 3, 3]);
        assert!(c.take_dirty().is_empty());
        assert_eq!(c.get_dirty_pixels(3, 0, 1, 2), vec![2; 8]);
    }

    #[test]
    fn conversions_keep_channel_order() {
        assert_eq!(bgra_to_rgba(&[1, 2, 3, 4]), vec![3, 2, 1, 4]);
        assert_eq!(bgr24_to_bgra(&[1, 2, 3]), vec![1, 2, 3, 255]);
        assert_eq!(rgb565_to_bgra(&[0x00, 0xF8]), vec![0, 0, 255, 255]);
    }
}
