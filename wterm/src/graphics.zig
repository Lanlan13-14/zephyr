//! Fixed-capacity image plane for Sixel / Kitty graphics.
const std = @import("std");
const sixel_mod = @import("sixel.zig");

pub const MAX_IMAGES: u8 = 2;
pub const MAX_KITTY_B64: usize = 96 * 1024;

pub const Image = struct {
    used: bool = false,
    id: u32 = 0,
    x_cell: u16 = 0,
    y_cell: u16 = 0,
    width_px: u16 = 0,
    height_px: u16 = 0,
    // placement span in cells (for scrolling approx)
    cols: u16 = 0,
    rows: u16 = 0,
    z: i16 = 0,
    pixels: [@as(usize, sixel_mod.MAX_WIDTH) * @as(usize, sixel_mod.MAX_HEIGHT) * 4]u8 = undefined,
};

pub const Store = struct {
    images: [MAX_IMAGES]Image = .{Image{}} ** MAX_IMAGES,
    next_id: u32 = 1,
    // Kitty reassembly
    kitty_active: bool = false,
    kitty_more: bool = false,
    kitty_b64_len: usize = 0,
    kitty_b64: [MAX_KITTY_B64]u8 = undefined,
    kitty_format: u8 = 24, // 24=RGB, 32=RGBA
    kitty_width: u16 = 0,
    kitty_height: u16 = 0,
    kitty_x: u16 = 0,
    kitty_y: u16 = 0,
    kitty_id: u32 = 0,
    sixel: sixel_mod.Decoder = undefined,
    sixel_slot: u8 = 0,
    sixel_active: bool = false,

    pub fn reset(self: *Store) void {
        self.* = .{};
    }

    pub fn allocSlot(self: *Store) ?u8 {
        var i: u8 = 0;
        while (i < MAX_IMAGES) : (i += 1) {
            if (!self.images[i].used) return i;
        }
        // reuse oldest id
        var best: u8 = 0;
        var best_id: u32 = std.math.maxInt(u32);
        i = 0;
        while (i < MAX_IMAGES) : (i += 1) {
            if (self.images[i].id < best_id) {
                best_id = self.images[i].id;
                best = i;
            }
        }
        return best;
    }

    pub fn beginSixel(self: *Store, cursor_col: u16, cursor_row: u16, p1: u16, p2: u16, p3: u16) void {
        const slot = self.allocSlot() orelse return;
        self.sixel_slot = slot;
        self.sixel_active = true;
        self.images[slot] = .{
            .used = true,
            .id = self.next_id,
            .x_cell = cursor_col,
            .y_cell = cursor_row,
        };
        self.next_id +%= 1;
        self.sixel.begin(self.images[slot].pixels[0..], p1, p2, p3);
    }

    pub fn feedSixel(self: *Store, byte: u8) void {
        if (!self.sixel_active) return;
        self.sixel.feed(byte);
    }

    pub fn endSixel(self: *Store, cell_w: u16, cell_h: u16) void {
        if (!self.sixel_active) return;
        self.sixel.finish();
        const slot = self.sixel_slot;
        self.images[slot].width_px = self.sixel.width;
        self.images[slot].height_px = self.sixel.height;
        if (cell_w > 0) self.images[slot].cols = @intCast((self.sixel.width + cell_w - 1) / cell_w);
        if (cell_h > 0) self.images[slot].rows = @intCast((self.sixel.height + cell_h - 1) / cell_h);
        self.sixel_active = false;
    }

    pub fn beginKitty(self: *Store) void {
        self.kitty_active = true;
        self.kitty_more = false;
        self.kitty_b64_len = 0;
        self.kitty_format = 24;
        self.kitty_width = 0;
        self.kitty_height = 0;
        self.kitty_id = 0;
    }

    pub fn setKittyControl(self: *Store, key: []const u8, value: []const u8) void {
        if (std.mem.eql(u8, key, "f")) {
            self.kitty_format = std.fmt.parseInt(u8, value, 10) catch 24;
        } else if (std.mem.eql(u8, key, "s")) {
            self.kitty_width = std.fmt.parseInt(u16, value, 10) catch 0;
        } else if (std.mem.eql(u8, key, "v")) {
            self.kitty_height = std.fmt.parseInt(u16, value, 10) catch 0;
        } else if (std.mem.eql(u8, key, "m")) {
            self.kitty_more = std.mem.eql(u8, value, "1");
        } else if (std.mem.eql(u8, key, "i")) {
            self.kitty_id = std.fmt.parseInt(u32, value, 10) catch 0;
        } else if (std.mem.eql(u8, key, "X")) {
            self.kitty_x = std.fmt.parseInt(u16, value, 10) catch 0;
        } else if (std.mem.eql(u8, key, "Y")) {
            self.kitty_y = std.fmt.parseInt(u16, value, 10) catch 0;
        }
    }

    pub fn appendKittyPayload(self: *Store, chunk: []const u8) void {
        if (!self.kitty_active) return;
        const space = MAX_KITTY_B64 - self.kitty_b64_len;
        const n = @min(space, chunk.len);
        @memcpy(self.kitty_b64[self.kitty_b64_len .. self.kitty_b64_len + n], chunk[0..n]);
        self.kitty_b64_len += n;
    }

    pub fn finishKitty(self: *Store, cursor_col: u16, cursor_row: u16, cell_w: u16, cell_h: u16) bool {
        if (!self.kitty_active) return false;
        if (self.kitty_more) return false; // wait for more
        defer self.kitty_active = false;
        if (self.kitty_width == 0 or self.kitty_height == 0) return false;
        if (self.kitty_width > sixel_mod.MAX_WIDTH or self.kitty_height > sixel_mod.MAX_HEIGHT) return false;

        const slot = self.allocSlot() orelse return false;
        var img = &self.images[slot];
        // Decode base64 directly into a temporary area of the target pixel
        // buffer tail, then scatter-expand into RGBA. This avoids another
        // full-frame stack/global allocation.
        const bpp: usize = if (self.kitty_format == 32) 4 else 3;
        const need = @as(usize, self.kitty_width) * @as(usize, self.kitty_height) * bpp;
        if (need > img.pixels.len) return false;
        const out_len = base64Decode(self.kitty_b64[0..self.kitty_b64_len], img.pixels[0..]) orelse return false;
        if (out_len < need) return false;

        // Expand in reverse so RGB/RGBA source is not overwritten early.
        var px: isize = @as(isize, self.kitty_width) * @as(isize, self.kitty_height) - 1;
        while (px >= 0) : (px -= 1) {
            const p: usize = @intCast(px);
            const y: usize = p / self.kitty_width;
            const x: usize = p % self.kitty_width;
            const si = p * bpp;
            const di = (y * sixel_mod.MAX_WIDTH + x) * 4;
            const r = img.pixels[si];
            const g = img.pixels[si + 1];
            const b = img.pixels[si + 2];
            const a = if (bpp == 4) img.pixels[si + 3] else 255;
            img.pixels[di] = r;
            img.pixels[di + 1] = g;
            img.pixels[di + 2] = b;
            img.pixels[di + 3] = a;
        }

        img.used = true;
        img.id = if (self.kitty_id != 0) self.kitty_id else self.next_id;
        img.x_cell = if (self.kitty_x != 0) self.kitty_x else cursor_col;
        img.y_cell = if (self.kitty_y != 0) self.kitty_y else cursor_row;
        img.width_px = self.kitty_width;
        img.height_px = self.kitty_height;
        self.next_id +%= 1;
        if (cell_w > 0) img.cols = @intCast((self.kitty_width + cell_w - 1) / cell_w);
        if (cell_h > 0) img.rows = @intCast((self.kitty_height + cell_h - 1) / cell_h);
        return true;
    }

    pub fn count(self: *const Store) u32 {
        var n: u32 = 0;
        for (self.images) |img| {
            if (img.used) n += 1;
        }
        return n;
    }

    pub fn get(self: *Store, index: u32) ?*Image {
        var seen: u32 = 0;
        for (&self.images) |*img| {
            if (!img.used) continue;
            if (seen == index) return img;
            seen += 1;
        }
        return null;
    }
};

fn base64Decode(src: []const u8, out: []u8) ?usize {
    const table = blk: {
        var t: [256]u8 = .{255} ** 256;
        const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        for (chars, 0..) |c, i| t[c] = @intCast(i);
        break :blk t;
    };
    var oi: usize = 0;
    var buf: u32 = 0;
    var bits: u5 = 0;
    for (src) |c| {
        if (c == '=' or c == '\n' or c == '\r' or c == ' ') continue;
        const v = table[c];
        if (v == 255) return null;
        buf = (buf << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            if (oi >= out.len) return null;
            out[oi] = @intCast((buf >> bits) & 0xFF);
            oi += 1;
        }
    }
    return oi;
}

test "graphics slot lifecycle" {
    var store: Store = .{};
    store.beginSixel(0, 0, 0, 0, 0);
    store.feedSixel('#');
    store.feedSixel('1');
    store.feedSixel('@');
    store.endSixel(8, 16);
    try std.testing.expect(store.count() >= 1);
}
