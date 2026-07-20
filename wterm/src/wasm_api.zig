const terminal_mod = @import("terminal.zig");
const grid_mod = @import("grid.zig");
const cell_mod = @import("cell.zig");
const scrollback_mod = @import("scrollback.zig");
const graphics_mod = @import("graphics.zig");
const sixel_mod = @import("sixel.zig");

const Terminal = terminal_mod.Terminal;

var terminal: Terminal = undefined;
var scrollback: scrollback_mod.Scrollback = .{};
var alt_grid: grid_mod.Grid = undefined;
var graphics: graphics_mod.Store = .{};
var input_buffer: [8192]u8 = undefined;
var initialized: bool = false;

// -- Lifecycle --

export fn init(cols: u32, rows: u32) void {
    const c: u16 = if (cols > grid_mod.MAX_COLS) grid_mod.MAX_COLS else if (cols == 0) 1 else @intCast(cols);
    const r: u16 = if (rows > grid_mod.MAX_ROWS) grid_mod.MAX_ROWS else if (rows == 0) 1 else @intCast(rows);
    terminal.reset(c, r);
    terminal.scrollback = &scrollback;
    terminal.alt_grid = &alt_grid;
    terminal.graphics = &graphics;
    scrollback.reset();
    graphics.reset();
    initialized = true;
}

export fn resizeTerminal(cols: u32, rows: u32) void {
    const c: u16 = if (cols > grid_mod.MAX_COLS) grid_mod.MAX_COLS else if (cols == 0) 1 else @intCast(cols);
    const r: u16 = if (rows > grid_mod.MAX_ROWS) grid_mod.MAX_ROWS else if (rows == 0) 1 else @intCast(rows);
    terminal.resize(c, r);
}

// -- Input --

export fn getWriteBuffer() [*]u8 {
    return &input_buffer;
}

export fn writeBytes(len: u32) void {
    const n = if (len > input_buffer.len) input_buffer.len else len;
    terminal.write(input_buffer[0..n]);
}

// -- Grid data --

export fn getGridPtr() [*]const u8 {
    return @ptrCast(&terminal.grid.cells);
}

export fn getDirtyPtr() [*]const u8 {
    return @ptrCast(&terminal.grid.dirty);
}

export fn clearDirty() void {
    terminal.grid.clearDirty();
}

// -- Terminal state --

export fn getCursorRow() u32 {
    return terminal.cursor_row;
}

export fn getCursorCol() u32 {
    return terminal.cursor_col;
}

export fn getCursorVisible() u32 {
    return if (terminal.cursor_visible) 1 else 0;
}

export fn getCursorStyle() u32 {
    return terminal.cursor_style;
}

export fn getCols() u32 {
    return terminal.cols;
}

export fn getRows() u32 {
    return terminal.rows;
}

export fn getCursorKeysApp() u32 {
    return if (terminal.cursor_keys_app) 1 else 0;
}

export fn getBracketedPaste() u32 {
    return if (terminal.bracketed_paste) 1 else 0;
}

// P2-3: Mouse reporting
export fn getMouseMode() u32 {
    return terminal.mouse_mode;
}

export fn getMouseSGR() u32 {
    return if (terminal.mouse_sgr) 1 else 0;
}

// P2-4: Bell
export fn getBellPending() u32 {
    return if (terminal.bell_pending) 1 else 0;
}

export fn clearBell() void {
    terminal.bell_pending = false;
}

export fn getSyncOutput() u32 {
    return if (terminal.sync_output) 1 else 0;
}
export fn getFocusReporting() u32 { return if (terminal.focus_reporting) 1 else 0; }
export fn getReverseScreen() u32 { return if (terminal.reverse_screen) 1 else 0; }
export fn getKittyKeyboardFlags() u32 { return terminal.kitty_flags; }

export fn getUsingAltScreen() u32 {
    return if (terminal.using_alt_screen) 1 else 0;
}

// -- Title --

export fn getTitlePtr() [*]const u8 {
    return &terminal.title_buf;
}

export fn getTitleLen() u32 {
    return terminal.title_len;
}

export fn getHyperlinkPtr(id: u32) [*]const u8 { return terminal.getLinkPtr(@intCast(id)); }
export fn getHyperlinkLen(id: u32) u32 { return terminal.getLinkLen(@intCast(id)); }

export fn getClipboardPending() u32 { return if (terminal.clipboard_pending) 1 else 0; }
export fn getClipboardQuery() u32 { return if (terminal.clipboard_query) 1 else 0; }
export fn getClipboardSelection() u32 { return terminal.clipboard_selection; }
export fn getClipboardPtr() [*]const u8 { return &terminal.clipboard_data; }
export fn getClipboardLen() u32 { return terminal.clipboard_len; }
export fn clearClipboard() void { terminal.clipboard_pending = false; terminal.clipboard_len = 0; }
export fn getGraphemePtr(id: u32) [*]const u8 { if (id == 0 or id > terminal.grapheme_count) return &terminal.graphemes[0]; return &terminal.graphemes[id - 1]; }
export fn getGraphemeLen(id: u32) u32 { if (id == 0 or id > terminal.grapheme_count) return 0; return terminal.grapheme_lens[id - 1]; }
export fn getColorQueryCount() u32 { return terminal.color_query_count; }
export fn getColorQueryKind() u32 { return if (terminal.color_query_count > 0) terminal.color_query_kind[0] else 0; }
export fn getColorQueryIndex() u32 { return if (terminal.color_query_count > 0) terminal.color_query_index[0] else 0; }
export fn shiftColorQuery() void { terminal.shiftColorQuery(); }
export fn getColorChangeCount() u32 { return terminal.color_change_count; }
export fn getColorChangeKind() u32 { return if (terminal.color_change_count > 0) terminal.color_change_kind[0] else 0; }
export fn getColorChangeIndex() u32 { return if (terminal.color_change_count > 0) terminal.color_change_index[0] else 0; }
export fn getColorChangePtr() [*]const u8 { return &terminal.color_change_data[0]; }
export fn getColorChangeLen() u32 { return if (terminal.color_change_count > 0) terminal.color_change_lens[0] else 0; }
export fn shiftColorChange() void { terminal.shiftColorChange(); }

export fn getTitleChanged() u32 {
    if (terminal.title_changed) {
        terminal.title_changed = false;
        return 1;
    }
    return 0;
}

// -- Scrollback --

export fn getScrollbackCount() u32 {
    return scrollback.count;
}

var scrollback_line_buf: [grid_mod.MAX_COLS * cell_mod.Cell.BYTE_SIZE]u8 = undefined;

export fn getScrollbackLine(offset: u32) [*]const u8 {
    const line = scrollback.getLine(offset);
    if (line) |l| {
        return @ptrCast(&l.cells);
    }
    return &scrollback_line_buf;
}

export fn getScrollbackLineLen(offset: u32) u32 {
    const line = scrollback.getLine(offset);
    if (line) |l| {
        return l.len;
    }
    return 0;
}

// -- Response buffer (for DSR replies) --

export fn getResponsePtr() [*]const u8 {
    return &terminal.response_buf;
}

export fn getResponseLen() u32 {
    return terminal.response_len;
}

export fn clearResponse() void {
    terminal.response_len = 0;
}

// -- Graphics plane (Sixel / Kitty) --
export fn getImageCount() u32 {
    return graphics.count();
}
export fn getImageId(index: u32) u32 {
    if (graphics.get(index)) |img| return img.id;
    return 0;
}
export fn getImageX(index: u32) u32 {
    if (graphics.get(index)) |img| return img.x_cell;
    return 0;
}
export fn getImageY(index: u32) u32 {
    if (graphics.get(index)) |img| return img.y_cell;
    return 0;
}
export fn getImageWidth(index: u32) u32 {
    if (graphics.get(index)) |img| return img.width_px;
    return 0;
}
export fn getImageHeight(index: u32) u32 {
    if (graphics.get(index)) |img| return img.height_px;
    return 0;
}
export fn getImageCols(index: u32) u32 {
    if (graphics.get(index)) |img| return img.cols;
    return 0;
}
export fn getImageRows(index: u32) u32 {
    if (graphics.get(index)) |img| return img.rows;
    return 0;
}
export fn getImagePtr(index: u32) [*]const u8 {
    if (graphics.get(index)) |img| return @ptrCast(&img.pixels);
    return @ptrCast(&graphics.images[0].pixels);
}
export fn getImageStride() u32 {
    return sixel_mod.MAX_WIDTH * 4;
}

// -- Evicted scrollback export (server-side history indexer) --
export fn setCaptureEvicted(enabled: u32) void {
    scrollback.setCaptureEvicted(enabled != 0);
}
export fn getEvictedCount() u32 { return scrollback.evicted_count; }
export fn getEvictedLine() [*]const u8 {
    if (scrollback.peekEvicted()) |line| return @ptrCast(&line.cells);
    return &scrollback_line_buf;
}
export fn getEvictedLineLen() u32 {
    if (scrollback.peekEvicted()) |line| return line.len;
    return 0;
}
export fn getEvictedLineWrapped() u32 {
    if (scrollback.peekEvicted()) |line| return if (line.wrapped) 1 else 0;
    return 0;
}
export fn popEvictedLine() void { scrollback.popEvicted(); }

// -- Debug log (unhandled sequences ring buffer) --

export fn getDebugLogPtr() [*]const u8 {
    return @ptrCast(&terminal.debug_log);
}

export fn getDebugLogCount() u32 {
    return terminal.debug_log_count;
}

export fn getDebugLogEntrySize() u32 {
    return @sizeOf(terminal_mod.DebugLogEntry);
}

export fn getDebugLogMax() u32 {
    return terminal_mod.DEBUG_LOG_MAX;
}

// -- Constants --

export fn getCellSize() u32 {
    return cell_mod.Cell.BYTE_SIZE;
}

export fn getMaxCols() u32 {
    return grid_mod.MAX_COLS;
}
