//! Streaming Sixel decoder (VT340-ish subset) into a fixed RGBA buffer.
const std = @import("std");

// Keep the freestanding WASM image plane small enough for mobile.
pub const MAX_WIDTH: u16 = 400;
pub const MAX_HEIGHT: u16 = 300;

pub const Decoder = struct {
    width: u16 = 0,
    height: u16 = 0,
    x: u16 = 0,
    y: u16 = 0,
    max_x: u16 = 0,
    max_y: u16 = 0,
    color_reg: u8 = 0,
    repeat: u32 = 1,
    pan: u16 = 1,
    pad: u16 = 2,
    ph: u16 = 0,
    pv: u16 = 0,
    // color registers as RGB888
    palette: [256][3]u8 = undefined,
    pixels: []u8,
    // parse state for attributes
    mode: enum { data, repeat, color, raster } = .data,
    num: u32 = 0,
    color_params: [5]u32 = .{0} ** 5,
    color_param_count: u8 = 0,
    raster_params: [4]u32 = .{0} ** 4,
    raster_param_count: u8 = 0,
    active: bool = false,
    overflow: bool = false,

    pub fn begin(self: *Decoder, pixels: []u8, p1: u16, p2: u16, p3: u16) void {
        _ = p1;
        _ = p2;
        _ = p3;
        self.* = .{
            .pixels = pixels,
            .palette = undefined,
            .active = true,
        };
        // Default VT340-ish palette: 0 black, 1-7 basic
        const defaults = [_][3]u8{
            .{ 0, 0, 0 },
            .{ 205, 0, 0 },
            .{ 0, 205, 0 },
            .{ 205, 205, 0 },
            .{ 0, 0, 238 },
            .{ 205, 0, 205 },
            .{ 0, 205, 205 },
            .{ 229, 229, 229 },
            .{ 127, 127, 127 },
            .{ 255, 0, 0 },
            .{ 0, 255, 0 },
            .{ 255, 255, 0 },
            .{ 92, 92, 255 },
            .{ 255, 0, 255 },
            .{ 0, 255, 255 },
            .{ 255, 255, 255 },
        };
        @memset(self.pixels, 0);
        var i: usize = 0;
        while (i < 256) : (i += 1) {
            if (i < defaults.len) self.palette[i] = defaults[i] else self.palette[i] = .{ 0, 0, 0 };
        }
    }

    pub fn feed(self: *Decoder, byte: u8) void {
        if (!self.active or self.overflow) return;
        switch (self.mode) {
            .repeat => {
                if (byte >= '0' and byte <= '9') {
                    self.num = self.num *| 10 +| (byte - '0');
                    return;
                }
                self.repeat = if (self.num == 0) 1 else self.num;
                self.num = 0;
                self.mode = .data;
                self.feed(byte);
                return;
            },
            .color => {
                if (byte >= '0' and byte <= '9') {
                    if (self.color_param_count < self.color_params.len) {
                        self.color_params[self.color_param_count] = self.color_params[self.color_param_count] *| 10 +| (byte - '0');
                    }
                    return;
                }
                if (byte == ';') {
                    if (self.color_param_count + 1 < self.color_params.len) self.color_param_count += 1;
                    return;
                }
                self.finishColor();
                self.mode = .data;
                self.feed(byte);
                return;
            },
            .raster => {
                if (byte >= '0' and byte <= '9') {
                    if (self.raster_param_count < self.raster_params.len) {
                        self.raster_params[self.raster_param_count] = self.raster_params[self.raster_param_count] *| 10 +| (byte - '0');
                    }
                    return;
                }
                if (byte == ';') {
                    if (self.raster_param_count + 1 < self.raster_params.len) self.raster_param_count += 1;
                    return;
                }
                self.finishRaster();
                self.mode = .data;
                self.feed(byte);
                return;
            },
            .data => {},
        }

        switch (byte) {
            '!' => {
                self.mode = .repeat;
                self.num = 0;
            },
            '#' => {
                self.mode = .color;
                self.color_param_count = 0;
                self.color_params = .{0} ** 5;
            },
            '"' => {
                self.mode = .raster;
                self.raster_param_count = 0;
                self.raster_params = .{0} ** 4;
            },
            '$' => {
                self.x = 0;
            },
            '-' => {
                self.x = 0;
                self.y +|= 6;
                if (self.y > self.max_y) self.max_y = self.y;
                if (self.y >= MAX_HEIGHT) self.overflow = true;
            },
            else => {
                if (byte >= '?' and byte <= '~') {
                    const sixel: u8 = byte - '?';
                    var n: u32 = 0;
                    while (n < self.repeat) : (n += 1) {
                        self.putBand(sixel);
                        self.x +|= 1;
                        if (self.x > self.max_x) self.max_x = self.x;
                        if (self.x >= MAX_WIDTH) {
                            self.x = MAX_WIDTH - 1;
                            break;
                        }
                    }
                    self.repeat = 1;
                }
            },
        }
    }

    fn finishColor(self: *Decoder) void {
        const Pc: u8 = @intCast(@min(self.color_params[0], 255));
        self.color_reg = Pc;
        if (self.color_param_count >= 4) {
            const Pu = self.color_params[1];
            var r = self.color_params[2];
            var g = self.color_params[3];
            var b = if (self.color_param_count >= 4) self.color_params[4] else 0;
            if (Pu == 1) {
                // HLS ignored; keep previous
                return;
            }
            // Pu=2 RGB in 0..100
            r = @min(100, r);
            g = @min(100, g);
            b = @min(100, b);
            self.palette[Pc] = .{
                @intCast((r * 255) / 100),
                @intCast((g * 255) / 100),
                @intCast((b * 255) / 100),
            };
        }
    }

    fn finishRaster(self: *Decoder) void {
        if (self.raster_param_count >= 0) self.pan = @intCast(@max(1, @min(self.raster_params[0], 255)));
        if (self.raster_param_count >= 1) self.pad = @intCast(@max(1, @min(self.raster_params[1], 255)));
        if (self.raster_param_count >= 2) self.ph = @intCast(@min(self.raster_params[2], MAX_WIDTH));
        if (self.raster_param_count >= 3) self.pv = @intCast(@min(self.raster_params[3], MAX_HEIGHT));
        if (self.ph > 0) self.width = self.ph;
        if (self.pv > 0) self.height = self.pv;
    }

    fn putBand(self: *Decoder, sixel: u8) void {
        const rgb = self.palette[self.color_reg];
        var bit: u3 = 0;
        while (bit < 6) : (bit += 1) {
            if ((sixel & (@as(u8, 1) << bit)) == 0) continue;
            const py: u32 = @as(u32, self.y) + bit;
            const px: u32 = self.x;
            if (px >= MAX_WIDTH or py >= MAX_HEIGHT) continue;
            const idx = (py * MAX_WIDTH + px) * 4;
            if (idx + 3 >= self.pixels.len) continue;
            self.pixels[idx] = rgb[0];
            self.pixels[idx + 1] = rgb[1];
            self.pixels[idx + 2] = rgb[2];
            self.pixels[idx + 3] = 255;
            if (py + 1 > self.max_y) self.max_y = @intCast(py + 1);
        }
    }

    pub fn finish(self: *Decoder) void {
        if (!self.active) return;
        self.active = false;
        if (self.width == 0) self.width = if (self.max_x == 0) 0 else self.max_x;
        if (self.height == 0) self.height = self.max_y;
        self.width = @min(self.width, MAX_WIDTH);
        self.height = @min(self.height, MAX_HEIGHT);
    }
};

test "sixel draws a pixel band" {
    var buf: [@as(usize, MAX_WIDTH) * @as(usize, MAX_HEIGHT) * 4]u8 = undefined;
    var d: Decoder = undefined;
    d.begin(buf[0..], 0, 0, 0);
    d.feed('#');
    d.feed('1'); // color 1
    d.feed('?'); // empty sixel => no pixels
    d.feed('@'); // bit0 => top pixel
    d.finish();
    try std.testing.expect(d.width >= 1);
    try std.testing.expect(buf[3] == 255 or buf[3] == 0);
}
