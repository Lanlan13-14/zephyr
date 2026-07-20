const cell_mod = @import("cell.zig");
const grid_mod = @import("grid.zig");
const Cell = cell_mod.Cell;

pub const MAX_SCROLLBACK_LINES: u32 = 1000;
pub const MAX_EVICTED_LINES: u32 = 256;

pub const ScrollbackLine = struct {
    cells: [grid_mod.MAX_COLS]Cell = undefined,
    len: u16 = 0,
    wrapped: bool = false,
};

pub const Scrollback = struct {
    lines: [MAX_SCROLLBACK_LINES]ScrollbackLine = undefined,
    count: u32 = 0,
    write_pos: u32 = 0,
    capture_evicted: bool = false,
    evicted: [MAX_EVICTED_LINES]ScrollbackLine = undefined,
    evicted_count: u32 = 0,
    evicted_read_pos: u32 = 0,
    evicted_write_pos: u32 = 0,

    pub fn reset(self: *Scrollback) void {
        self.count = 0;
        self.write_pos = 0;
        self.evicted_count = 0;
        self.evicted_read_pos = 0;
        self.evicted_write_pos = 0;
    }

    pub fn setCaptureEvicted(self: *Scrollback, enabled: bool) void {
        self.capture_evicted = enabled;
        self.evicted_count = 0;
        self.evicted_read_pos = 0;
        self.evicted_write_pos = 0;
    }

    pub fn push(self: *Scrollback, row: []const Cell, len: u16) void {
        self.pushWrapped(row, len, false);
    }

    fn captureOverwrite(self: *Scrollback) void {
        if (!self.capture_evicted or self.count < MAX_SCROLLBACK_LINES) return;
        const old = &self.lines[self.write_pos];
        const dst = &self.evicted[self.evicted_write_pos];
        dst.* = old.*;
        self.evicted_write_pos = (self.evicted_write_pos + 1) % MAX_EVICTED_LINES;
        if (self.evicted_count < MAX_EVICTED_LINES) self.evicted_count += 1 else self.evicted_read_pos = (self.evicted_read_pos + 1) % MAX_EVICTED_LINES;
    }

    pub fn pushWrapped(self: *Scrollback, row: []const Cell, len: u16, wrapped: bool) void {
        self.captureOverwrite();
        var line = &self.lines[self.write_pos];
        var i: u16 = 0;
        while (i < len) : (i += 1) line.cells[i] = row[i];
        line.len = len;
        line.wrapped = wrapped;
        self.write_pos = (self.write_pos + 1) % MAX_SCROLLBACK_LINES;
        if (self.count < MAX_SCROLLBACK_LINES) self.count += 1;
    }

    pub fn getLine(self: *const Scrollback, offset: u32) ?*const ScrollbackLine {
        if (offset >= self.count) return null;
        const idx = if (self.count < MAX_SCROLLBACK_LINES) self.count - 1 - offset else (self.write_pos + MAX_SCROLLBACK_LINES - 1 - offset) % MAX_SCROLLBACK_LINES;
        return &self.lines[idx];
    }

    pub fn peekEvicted(self: *const Scrollback) ?*const ScrollbackLine {
        if (self.evicted_count == 0) return null;
        return &self.evicted[self.evicted_read_pos];
    }

    pub fn popEvicted(self: *Scrollback) void {
        if (self.evicted_count == 0) return;
        self.evicted_read_pos = (self.evicted_read_pos + 1) % MAX_EVICTED_LINES;
        self.evicted_count -= 1;
    }
};
