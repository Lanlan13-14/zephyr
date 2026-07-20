const std = @import("std");
const cell_mod = @import("cell.zig");
const grid_mod = @import("grid.zig");
const parser_mod = @import("parser.zig");
const scrollback_mod = @import("scrollback.zig");

const Cell = cell_mod.Cell;
const Grid = grid_mod.Grid;
const Parser = parser_mod.Parser;
const Action = parser_mod.Action;
const Scrollback = scrollback_mod.Scrollback;

pub const DEBUG_LOG_MAX: u8 = 32;

// Width-reflow scratch storage lives in static WASM memory, not the call
// stack. 1000 scrollback rows * 256 cells * 20-byte Cell is ~5 MiB; placing
// that as a local would overflow the freestanding WASM stack at runtime.
const MAX_REFLOW_CELLS = (scrollback_mod.MAX_SCROLLBACK_LINES + grid_mod.MAX_ROWS) * grid_mod.MAX_COLS;
const MAX_REFLOW_LOGICAL = scrollback_mod.MAX_SCROLLBACK_LINES + grid_mod.MAX_ROWS;
var reflow_cells: [MAX_REFLOW_CELLS]Cell = undefined;
var reflow_starts: [MAX_REFLOW_LOGICAL + 1]u32 = undefined;
var reflow_lengths: [MAX_REFLOW_LOGICAL]u32 = undefined;

pub const DebugLogEntry = struct {
    final_byte: u8 = 0,
    private_marker: u8 = 0,
    param_count: u8 = 0,
    _pad: u8 = 0,
    params: [4]u16 = [_]u16{0} ** 4,
};

comptime {
    if (@sizeOf(DebugLogEntry) != 12)
        @compileError("DebugLogEntry size changed — update wasm-bridge.ts entrySize");
}

const MAX_LINKS: usize = 256;
const MAX_LINK_URI: usize = 512;

pub const Terminal = struct {
    grid: Grid,
    parser: Parser = .{},
    scrollback: ?*Scrollback = null,

    cols: u16,
    rows: u16,

    cursor_row: u16 = 0,
    cursor_col: u16 = 0,
    cursor_visible: bool = true,
    /// DECSCUSR cursor style: 0=default(block), 1=blinking block, 2=steady block,
    /// 3=blinking underline, 4=steady underline, 5=blinking bar, 6=steady bar.
    cursor_style: u8 = 0,
    wrap_pending: bool = false,
    /// Per-grid-row automatic-wrap metadata. row_wrapped[r] means row r is
    /// logically continued by row r+1. This is required for width reflow.
    row_wrapped: [grid_mod.MAX_ROWS]u8 = [_]u8{0} ** grid_mod.MAX_ROWS,

    saved_cursor_row: u16 = 0,
    saved_cursor_col: u16 = 0,
    saved_fg: u16 = cell_mod.DEFAULT_COLOR,
    saved_bg: u16 = cell_mod.DEFAULT_COLOR,
    saved_fg_rgb: u32 = 0,
    saved_bg_rgb: u32 = 0,
    saved_flags: u8 = 0,

    current_fg: u16 = cell_mod.DEFAULT_COLOR,
    current_bg: u16 = cell_mod.DEFAULT_COLOR,
    current_fg_rgb: u32 = 0,
    current_bg_rgb: u32 = 0,
    current_flags: u8 = 0,

    scroll_top: u16 = 0,
    scroll_bottom: u16 = 0,

    auto_wrap: bool = true,
    origin_mode: bool = false,
    cursor_keys_app: bool = false,
    bracketed_paste: bool = false,
    /// P2-3: Mouse reporting mode. 0=off, 1=normal(X10), 2=button-event, 3=any-event.
    mouse_mode: u8 = 0,
    /// P2-3: SGR mouse encoding (DECSET 1006).
    mouse_sgr: bool = false,
    /// P2-4: Bell flag - set when BEL (0x07) is received. Cleared by WASM API.
    bell_pending: bool = false,
    /// Synchronized output (DECSET 2026): when active, renderer should
    /// buffer frames until synchronized output ends.
    sync_output: bool = false,
    focus_reporting: bool = false,
    reverse_screen: bool = false,
    linefeed_mode: bool = false,

    // Alternate screen buffer (pointer to avoid doubling struct size)
    alt_grid: ?*Grid = null,
    alt_saved_cursor_row: u16 = 0,
    alt_saved_cursor_col: u16 = 0,
    alt_saved_fg: u16 = cell_mod.DEFAULT_COLOR,
    alt_saved_bg: u16 = cell_mod.DEFAULT_COLOR,
    alt_saved_fg_rgb: u32 = 0,
    alt_saved_bg_rgb: u32 = 0,
    alt_saved_flags: u8 = 0,
    using_alt_screen: bool = false,

    // Title (from OSC 0 / 2)
    title_buf: [256]u8 = undefined,
    title_len: u16 = 0,
    title_changed: bool = false,
    current_link_id: u16 = 0,
    last_printed_cell: Cell = Cell{},
    has_last_printed: bool = false,
    link_count: u16 = 0,
    link_lens: [MAX_LINKS]u16 = [_]u16{0} ** MAX_LINKS,
    link_uris: [MAX_LINKS][MAX_LINK_URI]u8 = undefined,
    clipboard_pending: bool = false,
    clipboard_query: bool = false,
    clipboard_selection: u8 = 'c',
    clipboard_len: u16 = 0,
    clipboard_data: [65535]u8 = undefined,

    // Response buffer for DSR and similar host-to-application replies
    response_buf: [64]u8 = undefined,
    response_len: u8 = 0,

    // Ring buffer of unhandled/ignored CSI sequences for debug introspection
    debug_log: [DEBUG_LOG_MAX]DebugLogEntry = [_]DebugLogEntry{.{}} ** DEBUG_LOG_MAX,
    debug_log_idx: u8 = 0,
    debug_log_count: u32 = 0,

    tab_stops: [grid_mod.MAX_COLS]u8 = initTabStops(),

    pub fn init(cols: u16, rows: u16) Terminal {
        return Terminal{
            .grid = Grid.init(cols, rows),
            .cols = cols,
            .rows = rows,
            .scroll_bottom = rows,
        };
    }

    /// Returns a blank (space) cell carrying only the current SGR background.
    /// Foreground and flags are intentionally omitted: ECMA-48 BCE specifies
    /// that erased cells inherit only the background color, not other attrs.
    fn blankCell(self: *const Terminal) Cell {
        return Cell{ .bg = self.current_bg };
    }

    fn logUnhandled(self: *Terminal, final: u8, private_marker: u8) void {
        var entry = DebugLogEntry{
            .final_byte = final,
            .private_marker = private_marker,
        };
        entry.param_count = self.parser.param_count;
        const copy_count: u8 = if (self.parser.param_count > 4) 4 else self.parser.param_count;
        var i: u8 = 0;
        while (i < copy_count) : (i += 1) {
            entry.params[i] = self.parser.params[i];
        }
        self.debug_log[self.debug_log_idx] = entry;
        self.debug_log_idx = (self.debug_log_idx + 1) % DEBUG_LOG_MAX;
        self.debug_log_count +|= 1;
    }

    /// Reset in-place without creating large stack temporaries.
    /// Preserves scrollback and alt_grid pointers (set by the host layer).
    pub fn reset(self: *Terminal, cols: u16, rows: u16) void {
        self.grid.reset(cols, rows);
        self.parser = .{};
        self.cols = cols;
        self.rows = rows;
        self.cursor_row = 0;
        self.cursor_col = 0;
        self.cursor_visible = true;
        self.cursor_style = 0;
        self.wrap_pending = false;
        self.row_wrapped = [_]u8{0} ** grid_mod.MAX_ROWS;
        self.saved_cursor_row = 0;
        self.saved_cursor_col = 0;
        self.saved_fg = cell_mod.DEFAULT_COLOR;
        self.saved_bg = cell_mod.DEFAULT_COLOR;
        self.saved_flags = 0;
        self.current_fg = cell_mod.DEFAULT_COLOR;
        self.current_bg = cell_mod.DEFAULT_COLOR;
        self.current_flags = 0;
        self.scroll_top = 0;
        self.scroll_bottom = rows;
        self.auto_wrap = true;
        self.origin_mode = false;
        self.cursor_keys_app = false;
        self.bracketed_paste = false;
        self.linefeed_mode = false;
        self.alt_saved_cursor_row = 0;
        self.alt_saved_cursor_col = 0;
        self.alt_saved_fg = cell_mod.DEFAULT_COLOR;
        self.alt_saved_bg = cell_mod.DEFAULT_COLOR;
        self.alt_saved_flags = 0;
        self.using_alt_screen = false;
        self.mouse_mode = 0;
        self.mouse_sgr = false;
        self.bell_pending = false;
        self.sync_output = false;
        self.focus_reporting = false;
        self.reverse_screen = false;
        self.title_len = 0;
        self.title_changed = false;
        self.current_link_id = 0;
        self.has_last_printed = false;
        self.link_count = 0;
        self.link_lens = [_]u16{0} ** MAX_LINKS;
        self.clipboard_pending = false;
        self.clipboard_query = false;
        self.clipboard_len = 0;
        self.response_len = 0;
        self.tab_stops = initTabStops();
    }

    // -- Public API --

    pub fn write(self: *Terminal, data: []const u8) void {
        for (data) |byte| {
            self.processByte(byte);
        }
    }

    fn effectiveLineLen(cells: []const Cell, width: u16) u16 {
        var len = width;
        while (len > 0) : (len -= 1) {
            const cell = cells[len - 1];
            if (cell.char != ' ' or cell.bg != cell_mod.DEFAULT_COLOR or cell.fg != cell_mod.DEFAULT_COLOR or cell.flags != 0 or cell.fg_rgb != 0 or cell.bg_rgb != 0 or cell.wide != 0) break;
        }
        return len;
    }

    fn appendReflowCell(dst: *[MAX_REFLOW_CELLS]Cell, len: *u32, cell: Cell) void {
        if (len.* >= dst.len) return;
        dst[len.*] = cell;
        len.* += 1;
    }

    /// Width-aware reflow for the normal screen. It joins only rows linked by
    /// automatic-wrap metadata; explicit LF/NEL boundaries remain distinct.
    /// Rewrapped output is split so the newest `rows` physical rows remain
    /// visible and older rows return to scrollback.
    fn reflowWidth(self: *Terminal, new_cols: u16, new_rows: u16) void {
        const sb = self.scrollback orelse return;
        const old_rows = self.rows;
        const old_cols = self.cols;
        const old_sb_count = sb.count;

        // Fixed-capacity module-level scratch keeps the core allocator-free
        // without putting ~5 MiB on the WASM stack.
        const flat = &reflow_cells;
        const starts = &reflow_starts;
        const lengths = &reflow_lengths;
        var logical_count: u16 = 0;
        var flat_len: u32 = 0;
        var logical_start: u32 = 0;

        // Append physical scrollback oldest -> newest, joining wrapped rows.
        var old_index: u32 = old_sb_count;
        while (old_index > 0) {
            old_index -= 1;
            const line = sb.getLine(old_index) orelse continue;
            const line_len = if (line.wrapped) line.len else effectiveLineLen(&line.cells, line.len);
            var c: u16 = 0;
            while (c < line_len) : (c += 1) appendReflowCell(flat, &flat_len, line.cells[c]);
            if (!line.wrapped) {
                starts[logical_count] = logical_start;
                lengths[logical_count] = flat_len - logical_start;
                logical_count += 1;
                logical_start = flat_len;
            }
        }

        // Append visible rows. Cursor logical offset is recorded before split.
        var cursor_logical: u16 = logical_count;
        var cursor_offset: u32 = 0;
        var r: u16 = 0;
        while (r < old_rows) : (r += 1) {
            if (r == self.cursor_row) {
                cursor_logical = logical_count;
                // wrap_pending means the cursor is logically one cell beyond
                // the final displayed column, waiting for the next printable
                // character to perform the wrap.
                const cursor_in_row: u32 = if (self.wrap_pending) old_cols else self.cursor_col;
                cursor_offset = (flat_len - logical_start) + cursor_in_row;
            }
            const line_len = if (self.row_wrapped[r] != 0) old_cols else effectiveLineLen(&self.grid.cells[r], old_cols);
            var c: u16 = 0;
            while (c < line_len) : (c += 1) appendReflowCell(flat, &flat_len, self.grid.cells[r][c]);
            if (self.row_wrapped[r] == 0) {
                starts[logical_count] = logical_start;
                lengths[logical_count] = flat_len - logical_start;
                logical_count += 1;
                logical_start = flat_len;
            }
        }
        if (logical_start < flat_len or logical_count == 0) {
            starts[logical_count] = logical_start;
            lengths[logical_count] = flat_len - logical_start;
            logical_count += 1;
        }

        // Count physical output rows after wrapping.
        var physical_total: u32 = 0;
        var l: u16 = 0;
        while (l < logical_count) : (l += 1) {
            const n = lengths[l];
            physical_total += if (n == 0) 1 else (n + new_cols - 1) / new_cols;
        }
        const visible_count: u32 = if (physical_total > new_rows) new_rows else physical_total;
        const history_count = physical_total - visible_count;

        sb.reset();
        var physical_index: u32 = 0;
        var visible_row: u16 = 0;
        var cursor_physical: u32 = 0;
        var cursor_col: u16 = 0;
        var cursor_wrap_pending = false;
        l = 0;
        while (l < logical_count) : (l += 1) {
            const logical_len = lengths[l];
            const chunks: u32 = if (logical_len == 0) 1 else (logical_len + new_cols - 1) / new_cols;
            var cursor_chunk: u32 = 0;
            var cursor_chunk_col: u16 = 0;
            if (l == cursor_logical) {
                cursor_wrap_pending = false;
                cursor_chunk = cursor_offset / new_cols;
                cursor_chunk_col = @intCast(cursor_offset % new_cols);
                if (cursor_chunk >= chunks) {
                    // Cursor sits just after a line that exactly fills the
                    // final chunk. Terminal semantics keep it on the final
                    // cell with wrap_pending set, not on a nonexistent row.
                    cursor_chunk = chunks - 1;
                    cursor_chunk_col = new_cols - 1;
                    cursor_wrap_pending = true;
                }
            }
            var chunk: u32 = 0;
            while (chunk < chunks) : (chunk += 1) {
                const chunk_start = starts[l] + chunk * new_cols;
                const remaining = if (logical_len > chunk * new_cols) logical_len - chunk * new_cols else 0;
                const chunk_len: u16 = @intCast(if (remaining > new_cols) new_cols else remaining);
                var row_buf: [grid_mod.MAX_COLS]Cell = [_]Cell{.{}} ** grid_mod.MAX_COLS;
                var c: u16 = 0;
                while (c < chunk_len) : (c += 1) row_buf[c] = flat[chunk_start + c];
                const wrapped = chunk + 1 < chunks;

                if (physical_index < history_count) {
                    sb.pushWrapped(&row_buf, chunk_len, wrapped);
                } else if (visible_row < new_rows) {
                    self.grid.cells[visible_row] = row_buf;
                    self.row_wrapped[visible_row] = if (wrapped) 1 else 0;
                    visible_row += 1;
                }

                if (l == cursor_logical and chunk == cursor_chunk) {
                    cursor_physical = physical_index;
                    cursor_col = cursor_chunk_col;
                }
                physical_index += 1;
            }
        }

        while (visible_row < new_rows) : (visible_row += 1) {
            self.grid.cells[visible_row] = [_]Cell{.{}} ** grid_mod.MAX_COLS;
            self.row_wrapped[visible_row] = 0;
        }

        self.cursor_row = if (cursor_physical < history_count) 0 else @intCast(cursor_physical - history_count);
        if (self.cursor_row >= new_rows) self.cursor_row = new_rows - 1;
        self.cursor_col = if (cursor_col >= new_cols) new_cols - 1 else cursor_col;
        self.wrap_pending = cursor_wrap_pending;
    }

    pub fn resize(self: *Terminal, new_cols: u16, new_rows: u16) void {
        const cols = if (new_cols > grid_mod.MAX_COLS) grid_mod.MAX_COLS else if (new_cols == 0) 1 else new_cols;
        const rows = if (new_rows > grid_mod.MAX_ROWS) grid_mod.MAX_ROWS else if (new_rows == 0) 1 else new_rows;
        const old_cols = self.cols;
        const old_rows = self.rows;
        if (cols == old_cols and rows == old_rows) return;

        // Full normal-screen width reflow. Alternate screens intentionally do
        // not touch scrollback; they retain the conservative resize behavior.
        if (cols != old_cols and !self.using_alt_screen and self.scrollback != null) {
            self.reflowWidth(cols, rows);
            self.cols = cols;
            self.rows = rows;
            self.grid.cols = cols;
            self.grid.rows = rows;
        } else {
            // Vertical-only resize: top rows leave the viewport, bottom rows stay.
            if (rows < old_rows) {
                const excess = old_rows - rows;
                if (!self.using_alt_screen and self.scrollback != null) {
                    var r: u16 = 0;
                    while (r < excess) : (r += 1) {
                        self.scrollback.?.pushWrapped(&self.grid.cells[r], old_cols, self.row_wrapped[r] != 0);
                    }
                }
                var r: u16 = 0;
                while (r < rows) : (r += 1) {
                    self.grid.cells[r] = self.grid.cells[r + excess];
                    self.row_wrapped[r] = self.row_wrapped[r + excess];
                }
            }
            self.cols = cols;
            self.rows = rows;
            self.grid.cols = cols;
            self.grid.rows = rows;
            if (rows > old_rows) {
                var r: u16 = old_rows;
                while (r < rows) : (r += 1) {
                    self.grid.clearRow(r);
                    self.row_wrapped[r] = 0;
                }
            }
            if (cols > old_cols) {
                const preserve_rows = if (old_rows < rows) old_rows else rows;
                var r: u16 = 0;
                while (r < preserve_rows) : (r += 1) {
                    var c: u16 = old_cols;
                    while (c < cols) : (c += 1) self.grid.cells[r][c] = Cell{};
                }
            }
        }

        self.scroll_top = 0;
        self.scroll_bottom = rows;
        if (self.cursor_col >= cols) self.cursor_col = cols - 1;
        if (self.cursor_row >= rows) self.cursor_row = rows - 1;
        var r: u16 = 0;
        while (r < rows) : (r += 1) self.grid.dirty[r] = 1;
    }

    // -- Byte processing --

    fn processByte(self: *Terminal, byte: u8) void {
        const action = self.parser.feed(byte);
        switch (action) {
            .none => {},
            .print => self.printChar(self.parser.print_char),
            .execute => self.executeControl(self.parser.execute_byte),
            .csi_dispatch => self.handleCsi(),
            .esc_dispatch => self.handleEsc(),
            .osc_dispatch => self.handleOsc(),
        }
    }

    // -- Print --

    fn isWideCodepoint(cp: u21) bool {
        // East Asian Wide + Fullwidth + Emoji ranges (subset of Unicode EAW).
        // Covers CJK, CJK Ext, Hiragana, Katakana, Hangul, CJK punctuation,
        // fullwidth forms, and common emoji width ranges.
        if (cp < 0x1100) return false;
        if (cp <= 0x115F) return true; // Hangul Jamo
        if (cp >= 0x2E80 and cp <= 0x303E) return true; // CJK radicals, Kangxi
        if (cp >= 0x3041 and cp <= 0x33FF) return true; // Hiragana, Katakana, CJK sym
        if (cp >= 0x3400 and cp <= 0x4DBF) return true; // CJK Ext A
        if (cp >= 0x4E00 and cp <= 0x9FFF) return true; // CJK Unified
        if (cp >= 0xA000 and cp <= 0xA4CF) return true; // Yi
        if (cp >= 0xAC00 and cp <= 0xD7A3) return true; // Hangul Syllables
        if (cp >= 0xF900 and cp <= 0xFAFF) return true; // CJK Compatibility
        if (cp >= 0xFE30 and cp <= 0xFE4F) return true; // CJK Compatibility Forms
        if (cp >= 0xFF00 and cp <= 0xFF60) return true; // Fullwidth Forms
        if (cp >= 0xFFE0 and cp <= 0xFFE6) return true; // Fullwidth Signs
        if (cp >= 0x1F300 and cp <= 0x1F64F) return true; // Emoji
        if (cp >= 0x1F900 and cp <= 0x1F9FF) return true; // Supplemental Symbols
        if (cp >= 0x20000 and cp <= 0x3FFFD) return true; // CJK Ext B-F
        return false;
    }

    fn printChar(self: *Terminal, codepoint: u21) void {
        if (self.wrap_pending) {
            self.row_wrapped[self.cursor_row] = 1;
            self.cursor_col = 0;
            self.doLinefeed();
            self.wrap_pending = false;
        }

        const is_wide = isWideCodepoint(codepoint);

        // If wide char and not enough room (need 2 cells), wrap to next line
        if (is_wide and self.cursor_col >= self.cols - 1) {
            if (self.auto_wrap) {
                self.row_wrapped[self.cursor_row] = 1;
                self.cursor_col = 0;
                self.doLinefeed();
            }
        }

        // Write the wide lead cell and retain it for CSI REP.
        const printed = Cell{
            .char = @intCast(codepoint),
            .fg = self.current_fg,
            .bg = self.current_bg, .fg_rgb = self.current_fg_rgb, .bg_rgb = self.current_bg_rgb,
            .flags = self.current_flags,
            .link_id = self.current_link_id,
            .wide = if (is_wide) cell_mod.WIDE_LEAD else cell_mod.WIDE_NARROW,
        };
        self.grid.setCell(self.cursor_row, self.cursor_col, printed);
        self.last_printed_cell = printed;
        self.has_last_printed = true;

        if (is_wide and self.cursor_col < self.cols - 1) {
            // Write the continuation cell (placeholder, not rendered)
            self.cursor_col += 1;
            self.grid.setCell(self.cursor_row, self.cursor_col, Cell{
                .char = 0,
                .fg = self.current_fg,
                .bg = self.current_bg, .fg_rgb = self.current_fg_rgb, .bg_rgb = self.current_bg_rgb,
                .flags = self.current_flags,
                .link_id = self.current_link_id,
                .wide = cell_mod.WIDE_CONT,
            });
        }

        if (self.cursor_col < self.cols - 1) {
            self.cursor_col += 1;
        } else if (self.auto_wrap) {
            self.wrap_pending = true;
        }
    }

    // -- C0 control codes --

    fn executeControl(self: *Terminal, byte: u8) void {
        switch (byte) {
            0x07 => { self.bell_pending = true; }, // BEL (P2-4)
            0x08, 0x7F => self.backspace(),
            0x09 => self.horizontalTab(),
            0x0A, 0x0B, 0x0C => {
                self.row_wrapped[self.cursor_row] = 0;
                self.doLinefeed();
                if (self.linefeed_mode) self.carriageReturn();
            },
            0x0D => self.carriageReturn(),
            else => {},
        }
    }

    fn backspace(self: *Terminal) void {
        if (self.cursor_col > 0) {
            self.cursor_col -= 1;
            self.wrap_pending = false;
        }
    }

    fn horizontalTab(self: *Terminal) void {
        var col = self.cursor_col + 1;
        while (col < self.cols) : (col += 1) {
            if (self.tab_stops[col] == 1) break;
        }
        self.cursor_col = if (col >= self.cols) self.cols - 1 else col;
        self.wrap_pending = false;
    }

    fn doLinefeed(self: *Terminal) void {
        if (self.cursor_row + 1 >= self.scroll_bottom) {
            if (!self.using_alt_screen and self.scroll_top == 0) {
                if (self.scrollback) |sb| {
                    sb.pushWrapped(&self.grid.cells[self.scroll_top], self.cols, self.row_wrapped[self.scroll_top] != 0);
                }
            }
            self.grid.scrollUp(self.scroll_top, self.scroll_bottom, 1, self.blankCell());
            var r = self.scroll_top;
            while (r + 1 < self.scroll_bottom) : (r += 1) {
                self.row_wrapped[r] = self.row_wrapped[r + 1];
            }
            self.row_wrapped[self.scroll_bottom - 1] = 0;
        } else {
            self.cursor_row += 1;
        }
    }

    fn carriageReturn(self: *Terminal) void {
        self.cursor_col = 0;
        self.wrap_pending = false;
    }

    // -- ESC dispatch --

    fn handleEsc(self: *Terminal) void {
        const byte = self.parser.execute_byte;
        const has_inter = self.parser.intermediate_count > 0;
        const inter0 = if (has_inter) self.parser.intermediates[0] else @as(u8, 0);

        if (has_inter and inter0 == '#' and byte == '8') {
            self.decaln();
            return;
        }

        switch (byte) {
            '7' => self.saveCursor(),
            '8' => self.restoreCursor(),
            'D' => {
                self.row_wrapped[self.cursor_row] = 0;
                self.doLinefeed();
            },
            'E' => {
                self.row_wrapped[self.cursor_row] = 0;
                self.carriageReturn();
                self.doLinefeed();
            },
            'M' => self.reverseIndex(),
            'c' => self.fullReset(),
            'H' => self.setTabStop(),
            else => {},
        }
    }

    fn decaln(self: *Terminal) void {
        var r: u16 = 0;
        while (r < self.rows) : (r += 1) {
            var c: u16 = 0;
            while (c < self.cols) : (c += 1) {
                self.grid.setCell(r, c, Cell{ .char = 'E' });
            }
        }
        self.cursor_row = 0;
        self.cursor_col = 0;
    }

    fn setTabStop(self: *Terminal) void {
        if (self.cursor_col < grid_mod.MAX_COLS) {
            self.tab_stops[self.cursor_col] = 1;
        }
    }

    fn saveCursor(self: *Terminal) void {
        self.saved_cursor_row = self.cursor_row;
        self.saved_cursor_col = self.cursor_col;
        self.saved_fg = self.current_fg;
        self.saved_bg = self.current_bg;
        self.saved_fg_rgb = self.current_fg_rgb;
        self.saved_bg_rgb = self.current_bg_rgb;
        self.saved_flags = self.current_flags;
    }

    fn restoreCursor(self: *Terminal) void {
        self.cursor_row = self.saved_cursor_row;
        self.cursor_col = self.saved_cursor_col;
        self.current_fg = self.saved_fg;
        self.current_bg = self.saved_bg;
        self.current_fg_rgb = self.saved_fg_rgb;
        self.current_bg_rgb = self.saved_bg_rgb;
        self.current_flags = self.saved_flags;
        self.wrap_pending = false;
    }

    fn reverseIndex(self: *Terminal) void {
        if (self.cursor_row == self.scroll_top) {
            self.grid.scrollDown(self.scroll_top, self.scroll_bottom, 1, self.blankCell());
        } else if (self.cursor_row > 0) {
            self.cursor_row -= 1;
        }
    }

    fn fullReset(self: *Terminal) void {
        self.reset(self.cols, self.rows);
    }

    // -- CSI dispatch --

    fn handleCsi(self: *Terminal) void {
        const final = self.parser.execute_byte;

        if (self.parser.csi_private == '?') {
            if (final == 'p' and self.parser.intermediate_count > 0 and self.parser.intermediates[0] == '$') {
                self.handlePrivateModeQuery();
            } else {
                self.handlePrivateMode(final);
            }
            return;
        }
        if (self.parser.csi_private == '!' and final == 'p') {
            self.softReset();
            return;
        }
        if (self.parser.csi_private == '>') {
            if (final == 'c') {
                self.handleSecondaryDA();
            } else {
                self.logUnhandled(final, '>');
            }
            return;
        }

        switch (final) {
            'A' => self.cursorUp(self.parser.getParam(0, 1)),
            'B' => self.cursorDown(self.parser.getParam(0, 1)),
            'C' => self.cursorForward(self.parser.getParam(0, 1)),
            'D' => self.cursorBackward(self.parser.getParam(0, 1)),
            'E' => {
                self.cursorDown(self.parser.getParam(0, 1));
                self.cursor_col = 0;
            },
            'F' => {
                self.cursorUp(self.parser.getParam(0, 1));
                self.cursor_col = 0;
            },
            'G' => self.cursorToColumn(self.parser.getParam(0, 1)),
            'H', 'f' => self.cursorPosition(self.parser.getParam(0, 1), self.parser.getParam(1, 1)),
            'J' => self.eraseInDisplay(self.parser.getParam(0, 0)),
            'K' => self.eraseInLine(self.parser.getParam(0, 0)),
            'L' => self.insertLines(self.parser.getParam(0, 1)),
            'M' => self.deleteLines(self.parser.getParam(0, 1)),
            'P' => self.deleteChars(self.parser.getParam(0, 1)),
            'S' => self.scrollUpN(self.parser.getParam(0, 1)),
            'T' => self.scrollDownN(self.parser.getParam(0, 1)),
            'X' => self.eraseChars(self.parser.getParam(0, 1)),
            'a' => self.cursorForward(self.parser.getParam(0, 1)),
            'b' => self.repeatPreceding(self.parser.getParam(0, 1)),
            'd' => self.cursorToRow(self.parser.getParam(0, 1)),
            'e' => self.cursorDown(self.parser.getParam(0, 1)),
            'g' => self.clearTabStop(self.parser.getParam(0, 0)),
            'm' => self.handleSgr(),
            'n' => self.handleDeviceStatus(),
            'r' => self.setScrollRegion(self.parser.getParam(0, 1), self.parser.getParam(1, self.rows)),
            's' => self.saveCursor(),
            'c' => self.handleDeviceAttributes(),
            'q' => self.handleDecscusr(),
            't' => {}, // window manipulation - ignore
            'u' => self.restoreCursor(),
            '@' => self.insertBlanks(self.parser.getParam(0, 1)),
            '`' => self.cursorToColumn(self.parser.getParam(0, 1)),
            else => self.logUnhandled(final, 0),
        }
    }

    fn handlePrivateMode(self: *Terminal, final: u8) void {
        switch (final) {
            'h' => self.setPrivateMode(true),
            'l' => self.setPrivateMode(false),
            else => self.logUnhandled(final, '?'),
        }
    }

    fn handlePrivateModeQuery(self: *Terminal) void {
        const mode = self.parser.getParam(0, 0);
        const status: u16 = switch (mode) {
            1 => if (self.cursor_keys_app) 1 else 2,
            5 => if (self.reverse_screen) 1 else 2,
            6 => if (self.origin_mode) 1 else 2,
            7 => if (self.auto_wrap) 1 else 2,
            9 => if (self.mouse_mode == 1) 1 else 2,
            25 => if (self.cursor_visible) 1 else 2,
            47, 1047, 1049 => if (self.using_alt_screen) 1 else 2,
            1000 => if (self.mouse_mode == 2) 1 else 2,
            1002 => if (self.mouse_mode == 3) 1 else 2,
            1003 => if (self.mouse_mode == 4) 1 else 2,
            1004 => if (self.focus_reporting) 1 else 2,
            1006 => if (self.mouse_sgr) 1 else 2,
            2004 => if (self.bracketed_paste) 1 else 2,
            2026 => if (self.sync_output) 1 else 2,
            else => 0,
        };
        var len: u8 = 0;
        self.response_buf[len] = 0x1b; len += 1;
        self.response_buf[len] = '['; len += 1;
        self.response_buf[len] = '?'; len += 1;
        len = appendU16(self.response_buf[0..], len, mode);
        self.response_buf[len] = ';'; len += 1;
        len = appendU16(self.response_buf[0..], len, status);
        self.response_buf[len] = '$'; len += 1;
        self.response_buf[len] = 'y'; len += 1;
        self.response_len = len;
    }

    fn setPrivateMode(self: *Terminal, enabled: bool) void {
        var i: u8 = 0;
        const count = if (self.parser.param_count == 0) @as(u8, 1) else self.parser.param_count;
        while (i < count) : (i += 1) {
            const mode = self.parser.params[i];
            switch (mode) {
                1 => self.cursor_keys_app = enabled,
                6 => self.origin_mode = enabled,
                5 => self.reverse_screen = enabled,
                7 => self.auto_wrap = enabled,
                12 => {}, // cursor blink - handled by renderer
                20 => self.linefeed_mode = enabled,
                25 => self.cursor_visible = enabled,
                47 => self.switchScreen(enabled, false),
                1047 => self.switchScreen(enabled, false),
                1048 => {
                    if (enabled) self.saveCursor() else self.restoreCursor();
                },
                1049 => self.switchScreen(enabled, true),
                2004 => self.bracketed_paste = enabled,
                2026 => self.sync_output = enabled, // synchronized output
                9 => self.mouse_mode = if (enabled) 1 else 0, // X10 mouse
                1000 => self.mouse_mode = if (enabled) 2 else 0, // normal mouse
                1004 => self.focus_reporting = enabled,
                1002 => self.mouse_mode = if (enabled) 2 else 0, // button-event
                1003 => self.mouse_mode = if (enabled) 3 else 0, // any-event
                1006 => self.mouse_sgr = enabled, // SGR encoding
                else => {},
            }
        }
    }

    fn switchScreen(self: *Terminal, alt: bool, save_cursor: bool) void {
        if (alt == self.using_alt_screen) return;
        const ag = self.alt_grid orelse return;

        if (alt) {
            if (save_cursor) self.saveCursorToAlt();
            ag.* = self.grid;
            self.grid.reset(self.cols, self.rows);
            self.using_alt_screen = true;
        } else {
            self.grid = ag.*;
            self.using_alt_screen = false;
            if (save_cursor) self.restoreCursorFromAlt();
            var r: u16 = 0;
            while (r < self.rows) : (r += 1) {
                self.grid.dirty[r] = 1;
            }
        }
        self.scroll_top = 0;
        self.scroll_bottom = self.rows;
    }

    fn saveCursorToAlt(self: *Terminal) void {
        self.alt_saved_cursor_row = self.cursor_row;
        self.alt_saved_cursor_col = self.cursor_col;
        self.alt_saved_fg = self.current_fg;
        self.alt_saved_bg = self.current_bg;
        self.alt_saved_fg_rgb = self.current_fg_rgb;
        self.alt_saved_bg_rgb = self.current_bg_rgb;
        self.alt_saved_flags = self.current_flags;
    }

    fn restoreCursorFromAlt(self: *Terminal) void {
        self.cursor_row = self.alt_saved_cursor_row;
        self.cursor_col = self.alt_saved_cursor_col;
        self.current_fg = self.alt_saved_fg;
        self.current_bg = self.alt_saved_bg;
        self.current_fg_rgb = self.alt_saved_fg_rgb;
        self.current_bg_rgb = self.alt_saved_bg_rgb;
        self.current_flags = self.alt_saved_flags;
        self.wrap_pending = false;
    }

    fn softReset(self: *Terminal) void {
        self.cursor_visible = true;
        self.origin_mode = false;
        self.auto_wrap = true;
        self.cursor_keys_app = false;
        self.bracketed_paste = false;
        self.scroll_top = 0;
        self.scroll_bottom = self.rows;
        self.resetStyle();
    }

    fn handleDeviceStatus(self: *Terminal) void {
        const param = self.parser.getParam(0, 0);
        if (param == 6) {
            // CPR – Cursor Position Report: ESC [ row ; col R
            const row = self.cursor_row + 1;
            const col = self.cursor_col + 1;
            var buf: [64]u8 = undefined;
            var len: u8 = 0;
            buf[len] = 0x1B;
            len += 1;
            buf[len] = '[';
            len += 1;
            len = appendU16(buf[0..], len, row);
            buf[len] = ';';
            len += 1;
            len = appendU16(buf[0..], len, col);
            buf[len] = 'R';
            len += 1;
            self.response_buf = buf;
            self.response_len = len;
        }
    }

    // DA1 - Primary Device Attributes (ESC[c or ESC[0c)
    // Response: ESC[?62;22c  (62=VT220, 22=ANSI color)
    fn handleDeviceAttributes(self: *Terminal) void {
        const resp = "\x1b[?62;22c";
        var i: u8 = 0;
        while (i < resp.len and i < self.response_buf.len) : (i += 1) {
            self.response_buf[i] = resp[i];
        }
        self.response_len = i;
    }

    // DA2 - Secondary Device Attributes (ESC[>c)
    // Response: ESC[>0;0;0c  (0=VT220, 0=firmware, 0=ROM card)
    fn handleSecondaryDA(self: *Terminal) void {
        const resp = "\x1b[>0;0;0c";
        var i: u8 = 0;
        while (i < resp.len and i < self.response_buf.len) : (i += 1) {
            self.response_buf[i] = resp[i];
        }
        self.response_len = i;
    }

    // DECSCUSR - Cursor style (ESC[n q)
    fn handleDecscusr(self: *Terminal) void {
        self.cursor_style = @intCast(self.parser.getParam(0, 0));
    }

    // -- Cursor movement --

    fn cursorUp(self: *Terminal, n: u16) void {
        const amount = if (n == 0) 1 else n;
        self.cursor_row = if (amount > self.cursor_row) 0 else self.cursor_row - amount;
        self.wrap_pending = false;
    }

    fn cursorDown(self: *Terminal, n: u16) void {
        const amount = if (n == 0) 1 else n;
        const max = self.rows - 1;
        self.cursor_row = if (self.cursor_row + amount > max) max else self.cursor_row + amount;
        self.wrap_pending = false;
    }

    fn cursorForward(self: *Terminal, n: u16) void {
        const amount = if (n == 0) 1 else n;
        const max = self.cols - 1;
        self.cursor_col = if (self.cursor_col + amount > max) max else self.cursor_col + amount;
        self.wrap_pending = false;
    }

    fn cursorBackward(self: *Terminal, n: u16) void {
        const amount = if (n == 0) 1 else n;
        self.cursor_col = if (amount > self.cursor_col) 0 else self.cursor_col - amount;
        self.wrap_pending = false;
    }

    fn cursorPosition(self: *Terminal, row_param: u16, col_param: u16) void {
        const r = if (row_param == 0) 0 else row_param - 1;
        const c = if (col_param == 0) 0 else col_param - 1;
        self.cursor_row = if (r >= self.rows) self.rows - 1 else r;
        self.cursor_col = if (c >= self.cols) self.cols - 1 else c;
        self.wrap_pending = false;
    }

    fn cursorToColumn(self: *Terminal, col_param: u16) void {
        const c = if (col_param == 0) 0 else col_param - 1;
        self.cursor_col = if (c >= self.cols) self.cols - 1 else c;
        self.wrap_pending = false;
    }

    fn cursorToRow(self: *Terminal, row_param: u16) void {
        const r = if (row_param == 0) 0 else row_param - 1;
        self.cursor_row = if (r >= self.rows) self.rows - 1 else r;
        self.wrap_pending = false;
    }

    // -- Erase operations --

    fn eraseInDisplay(self: *Terminal, mode: u16) void {
        const blank = self.blankCell();
        switch (mode) {
            0 => {
                self.grid.clearRangeAs(self.cursor_row, self.cursor_col, self.cols, blank);
                var r = self.cursor_row + 1;
                while (r < self.rows) : (r += 1) {
                    self.grid.clearRowAs(r, blank);
                }
            },
            1 => {
                var r: u16 = 0;
                while (r < self.cursor_row) : (r += 1) {
                    self.grid.clearRowAs(r, blank);
                }
                self.grid.clearRangeAs(self.cursor_row, 0, self.cursor_col + 1, blank);
            },
            2, 3 => {
                var r: u16 = 0;
                while (r < self.rows) : (r += 1) {
                    self.grid.clearRowAs(r, blank);
                }
                if (mode == 3) {
                    if (self.scrollback) |sb| sb.reset();
                }
            },
            else => {},
        }
    }

    fn eraseInLine(self: *Terminal, mode: u16) void {
        const blank = self.blankCell();
        switch (mode) {
            0 => self.grid.clearRangeAs(self.cursor_row, self.cursor_col, self.cols, blank),
            1 => self.grid.clearRangeAs(self.cursor_row, 0, self.cursor_col + 1, blank),
            2 => self.grid.clearRowAs(self.cursor_row, blank),
            else => {},
        }
    }

    fn eraseChars(self: *Terminal, n: u16) void {
        const count = if (n == 0) 1 else n;
        const end = if (self.cursor_col + count > self.cols) self.cols else self.cursor_col + count;
        self.grid.clearRangeAs(self.cursor_row, self.cursor_col, end, self.blankCell());
    }

    // -- Insert / delete --

    fn insertLines(self: *Terminal, n: u16) void {
        if (self.cursor_row < self.scroll_top or self.cursor_row >= self.scroll_bottom) return;
        self.grid.scrollDown(self.cursor_row, self.scroll_bottom, if (n == 0) 1 else n, self.blankCell());
    }

    fn deleteLines(self: *Terminal, n: u16) void {
        if (self.cursor_row < self.scroll_top or self.cursor_row >= self.scroll_bottom) return;
        self.grid.scrollUp(self.cursor_row, self.scroll_bottom, if (n == 0) 1 else n, self.blankCell());
    }

    fn deleteChars(self: *Terminal, n: u16) void {
        const count = if (n == 0) 1 else n;
        const blank = self.blankCell();
        var col = self.cursor_col;
        while (col + count < self.cols) : (col += 1) {
            self.grid.cells[self.cursor_row][col] = self.grid.cells[self.cursor_row][col + count];
        }
        while (col < self.cols) : (col += 1) {
            self.grid.cells[self.cursor_row][col] = blank;
        }
        self.grid.dirty[self.cursor_row] = 1;
        self.sanitizeWideRow(self.cursor_row);
    }

    fn repeatPreceding(self: *Terminal, count: u16) void {
        if (!self.has_last_printed) return;
        const saved_fg = self.current_fg; const saved_bg = self.current_bg;
        const saved_fg_rgb = self.current_fg_rgb; const saved_bg_rgb = self.current_bg_rgb;
        const saved_flags = self.current_flags; const saved_link = self.current_link_id;
        const cell = self.last_printed_cell;
        self.current_fg = cell.fg; self.current_bg = cell.bg;
        self.current_fg_rgb = cell.fg_rgb; self.current_bg_rgb = cell.bg_rgb;
        self.current_flags = cell.flags; self.current_link_id = cell.link_id;
        var i: u16 = 0; const bounded = @min(count, 4096);
        while (i < bounded) : (i += 1) self.printChar(@intCast(cell.char));
        self.current_fg = saved_fg; self.current_bg = saved_bg;
        self.current_fg_rgb = saved_fg_rgb; self.current_bg_rgb = saved_bg_rgb;
        self.current_flags = saved_flags; self.current_link_id = saved_link;
    }

    fn sanitizeWideRow(self: *Terminal, row: u16) void {
        var col: u16 = 0;
        while (col < self.cols) : (col += 1) {
            const cell = self.grid.getCell(row, col);
            if (cell.wide == cell_mod.WIDE_LEAD and (col + 1 >= self.cols or self.grid.getCell(row, col + 1).wide != cell_mod.WIDE_CONT)) self.grid.setCell(row, col, Cell{});
            if (cell.wide == cell_mod.WIDE_CONT and (col == 0 or self.grid.getCell(row, col - 1).wide != cell_mod.WIDE_LEAD)) self.grid.setCell(row, col, Cell{});
        }
    }

    fn insertBlanks(self: *Terminal, n: u16) void {
        const count = if (n == 0) 1 else n;
        const blank = self.blankCell();
        if (self.cursor_col + count >= self.cols) {
            self.grid.clearRangeAs(self.cursor_row, self.cursor_col, self.cols, blank);
            self.sanitizeWideRow(self.cursor_row);
            return;
        }
        var col = self.cols - 1;
        while (col >= self.cursor_col + count) : (col -= 1) {
            self.grid.cells[self.cursor_row][col] = self.grid.cells[self.cursor_row][col - count];
            if (col == 0) break;
        }
        var c = self.cursor_col;
        const end = if (self.cursor_col + count > self.cols) self.cols else self.cursor_col + count;
        while (c < end) : (c += 1) {
            self.grid.cells[self.cursor_row][c] = blank;
        }
        self.grid.dirty[self.cursor_row] = 1;
        self.sanitizeWideRow(self.cursor_row);
    }

    fn scrollUpN(self: *Terminal, n: u16) void {
        const count = if (n == 0) 1 else n;
        if (!self.using_alt_screen and self.scroll_top == 0) {
            if (self.scrollback) |sb| {
                var i: u16 = 0;
                while (i < count and i < self.scroll_bottom - self.scroll_top) : (i += 1) {
                    sb.pushWrapped(&self.grid.cells[self.scroll_top + i], self.cols, self.row_wrapped[self.scroll_top + i] != 0);
                }
            }
        }
        self.grid.scrollUp(self.scroll_top, self.scroll_bottom, count, self.blankCell());
        const moved = if (count > self.scroll_bottom - self.scroll_top) self.scroll_bottom - self.scroll_top else count;
        var r = self.scroll_top;
        while (r + moved < self.scroll_bottom) : (r += 1) self.row_wrapped[r] = self.row_wrapped[r + moved];
        while (r < self.scroll_bottom) : (r += 1) self.row_wrapped[r] = 0;
    }

    fn scrollDownN(self: *Terminal, n: u16) void {
        self.grid.scrollDown(self.scroll_top, self.scroll_bottom, if (n == 0) 1 else n, self.blankCell());
    }

    // -- Scroll region --

    fn setScrollRegion(self: *Terminal, top_param: u16, bottom_param: u16) void {
        const top = if (top_param == 0) 0 else top_param - 1;
        const bottom = if (bottom_param > self.rows) self.rows else bottom_param;
        if (top < bottom) {
            self.scroll_top = top;
            self.scroll_bottom = bottom;
            self.cursor_row = if (self.origin_mode) top else 0;
            self.cursor_col = 0;
            self.wrap_pending = false;
        }
    }

    // -- Tab stops --

    fn clearTabStop(self: *Terminal, mode: u16) void {
        switch (mode) {
            0 => {
                if (self.cursor_col < grid_mod.MAX_COLS)
                    self.tab_stops[self.cursor_col] = 0;
            },
            3 => {
                var i: u16 = 0;
                while (i < grid_mod.MAX_COLS) : (i += 1) {
                    self.tab_stops[i] = 0;
                }
            },
            else => {},
        }
    }

    // -- SGR (Select Graphic Rendition) --

    fn handleSgr(self: *Terminal) void {
        if (self.parser.param_count == 0) {
            self.resetStyle();
            return;
        }

        var i: u8 = 0;
        while (i < self.parser.param_count) {
            const p = self.parser.params[i];
            switch (p) {
                0 => self.resetStyle(),
                1 => self.current_flags |= cell_mod.FLAG_BOLD,
                2 => self.current_flags |= cell_mod.FLAG_DIM,
                3 => self.current_flags |= cell_mod.FLAG_ITALIC,
                4 => {
                    if (i + 1 < self.parser.param_count and self.parser.subparam[i + 1]) {
                        const sub = self.parser.params[i + 1];
                        if (sub == 0) {
                            self.current_flags &= ~cell_mod.FLAG_UNDERLINE;
                        } else {
                            self.current_flags |= cell_mod.FLAG_UNDERLINE;
                        }
                        i += 1;
                    } else {
                        self.current_flags |= cell_mod.FLAG_UNDERLINE;
                    }
                },
                5 => self.current_flags |= cell_mod.FLAG_BLINK,
                7 => self.current_flags |= cell_mod.FLAG_REVERSE,
                8 => self.current_flags |= cell_mod.FLAG_INVISIBLE,
                9 => self.current_flags |= cell_mod.FLAG_STRIKETHROUGH,
                22 => self.current_flags &= ~(cell_mod.FLAG_BOLD | cell_mod.FLAG_DIM),
                23 => self.current_flags &= ~cell_mod.FLAG_ITALIC,
                24 => self.current_flags &= ~cell_mod.FLAG_UNDERLINE,
                25 => self.current_flags &= ~cell_mod.FLAG_BLINK,
                27 => self.current_flags &= ~cell_mod.FLAG_REVERSE,
                28 => self.current_flags &= ~cell_mod.FLAG_INVISIBLE,
                29 => self.current_flags &= ~cell_mod.FLAG_STRIKETHROUGH,
                30...37 => self.current_fg = @intCast(p - 30),
                38 => {
                    i += self.parseExtendedColor(i, &self.current_fg, &self.current_fg_rgb);
                },
                39 => { self.current_fg = cell_mod.DEFAULT_COLOR; self.current_fg_rgb = 0; },
                40...47 => self.current_bg = @intCast(p - 40),
                48 => {
                    i += self.parseExtendedColor(i, &self.current_bg, &self.current_bg_rgb);
                },
                49 => { self.current_bg = cell_mod.DEFAULT_COLOR; self.current_bg_rgb = 0; },
                90...97 => self.current_fg = @intCast(p - 90 + 8),
                100...107 => self.current_bg = @intCast(p - 100 + 8),
                else => {
                    // Skip colon sub-parameters we don't handle
                    while (i + 1 < self.parser.param_count and self.parser.subparam[i + 1]) {
                        i += 1;
                    }
                },
            }
            i += 1;
        }
    }

    /// Parses 38;5;n (256-color) and 38;2;r;g;b (24-bit color)
    fn parseExtendedColor(self: *Terminal, start: u8, color: *u16, rgb_out: *u32) u8 {
        if (start + 1 >= self.parser.param_count) return 0;
        const kind = self.parser.params[start + 1];
        if (kind == 5 and start + 2 < self.parser.param_count) {
            color.* = self.parser.params[start + 2];
            rgb_out.* = 0;
            return 2;
        }
        if (kind == 2 and start + 4 < self.parser.param_count) {
            const r = self.parser.params[start + 2];
            const g = self.parser.params[start + 3];
            const b_val = self.parser.params[start + 4];
            const packed_rgb: u32 = (@as(u32, @intCast(r)) << 16) | (@as(u32, @intCast(g)) << 8) | @as(u32, @intCast(b_val));
            color.* = rgbTo256(@intCast(r), @intCast(g), @intCast(b_val));
            rgb_out.* = packed_rgb;
            return 4;
        }
        return 0;
    }

    fn resetStyle(self: *Terminal) void {
        self.current_fg = cell_mod.DEFAULT_COLOR;
        self.current_bg = cell_mod.DEFAULT_COLOR;
        self.current_fg_rgb = 0;
        self.current_bg_rgb = 0;
        self.current_flags = 0;
    }

    // -- OSC --

    fn handleOsc(self: *Terminal) void {
        if (self.parser.osc_len < 2) return;
        const data = self.parser.osc_data[0..self.parser.osc_len];

        // OSC 0;title ST  or  OSC 2;title ST
        if ((data[0] == '0' or data[0] == '2') and data[1] == ';') {
            const title = data[2..];
            const len = if (title.len > self.title_buf.len) self.title_buf.len else title.len;
            var j: u16 = 0;
            while (j < len) : (j += 1) {
                self.title_buf[j] = title[j];
            }
            self.title_len = @intCast(len);
            self.title_changed = true;
            return;
        }

        // OSC 8 ; params ; URI ST. An empty URI closes the current link.
        if (data.len >= 3 and data[0] == '8' and data[1] == ';') {
            var sep: usize = 2;
            while (sep < data.len and data[sep] != ';') : (sep += 1) {}
            if (sep >= data.len) return;
            const uri = data[sep + 1 ..];
            if (uri.len == 0) { self.current_link_id = 0; return; }
            self.current_link_id = self.internLink(uri);
            return;
        }

        // OSC 52 ; selection ; base64 ST. Query payload '?' is surfaced but
        // never answered by the core, preventing silent clipboard reads.
        if (data.len >= 4 and data[0] == '5' and data[1] == '2' and data[2] == ';') {
            var sep: usize = 3;
            while (sep < data.len and data[sep] != ';') : (sep += 1) {}
            if (sep >= data.len) return;
            self.clipboard_selection = if (sep > 3) data[3] else 'c';
            const payload = data[sep + 1 ..];
            self.clipboard_query = payload.len == 1 and payload[0] == '?';
            const len = @min(payload.len, self.clipboard_data.len);
            @memcpy(self.clipboard_data[0..len], payload[0..len]);
            self.clipboard_len = @intCast(len);
            self.clipboard_pending = true;
        }
    }

    fn internLink(self: *Terminal, uri: []const u8) u16 {
        const len = @min(uri.len, MAX_LINK_URI);
        if (len == 0) return 0;
        var i: usize = 0;
        while (i < self.link_count) : (i += 1) {
            if (self.link_lens[i] == len and std.mem.eql(u8, self.link_uris[i][0..len], uri[0..len])) return @intCast(i + 1);
        }
        if (self.link_count >= MAX_LINKS) return 0;
        const slot: usize = self.link_count;
        @memcpy(self.link_uris[slot][0..len], uri[0..len]);
        self.link_lens[slot] = @intCast(len);
        self.link_count += 1;
        return @intCast(slot + 1);
    }

    pub fn getLinkPtr(self: *Terminal, id: u16) [*]const u8 {
        if (id == 0 or id > self.link_count) return &self.link_uris[0];
        return &self.link_uris[id - 1];
    }

    pub fn getLinkLen(self: *Terminal, id: u16) u16 {
        if (id == 0 or id > self.link_count) return 0;
        return self.link_lens[id - 1];
    }

    // -- Tab stops --

    fn initTabStops() [grid_mod.MAX_COLS]u8 {
        var stops = [_]u8{0} ** grid_mod.MAX_COLS;
        var i: u16 = 8;
        while (i < grid_mod.MAX_COLS) : (i += 8) {
            stops[i] = 1;
        }
        return stops;
    }
};

fn appendU16(buf: []u8, start: u8, val: u16) u8 {
    var v = val;
    var tmp: [5]u8 = undefined;
    var count: u8 = 0;
    if (v == 0) {
        buf[start] = '0';
        return start + 1;
    }
    while (v > 0) : (count += 1) {
        tmp[count] = @intCast(v % 10 + '0');
        v /= 10;
    }
    var pos = start;
    var i = count;
    while (i > 0) {
        i -= 1;
        buf[pos] = tmp[i];
        pos += 1;
    }
    return pos;
}

fn rgbTo256(r: u8, g: u8, b: u8) u16 {
    // Check grayscale ramp first
    if (r == g and g == b) {
        if (r < 8) return 16;
        if (r > 248) return 231;
        const idx = @min(23, (@as(u32, r) - 8) / 10);
        return @as(u16, @intCast(idx)) + 232;
    }
    // Map to 6x6x6 color cube (indices 16-231)
    const ri: u16 = @intCast((@as(u32, r) * 5 + 127) / 255);
    const gi: u16 = @intCast((@as(u32, g) * 5 + 127) / 255);
    const bi: u16 = @intCast((@as(u32, b) * 5 + 127) / 255);
    return 16 + ri * 36 + gi * 6 + bi;
}

test "basic print" {
    var t = Terminal.init(80, 24);
    t.write("Hello");
    const h = t.grid.getCell(0, 0);
    const e = t.grid.getCell(0, 1);
    try @import("std").testing.expectEqual(@as(u32, 'H'), h.char);
    try @import("std").testing.expectEqual(@as(u32, 'e'), e.char);
    try @import("std").testing.expectEqual(@as(u16, 5), t.cursor_col);
}

test "linefeed and carriage return" {
    var t = Terminal.init(80, 24);
    t.write("AB\r\nCD");
    try @import("std").testing.expectEqual(@as(u32, 'A'), t.grid.getCell(0, 0).char);
    try @import("std").testing.expectEqual(@as(u32, 'C'), t.grid.getCell(1, 0).char);
    try @import("std").testing.expectEqual(@as(u16, 1), t.cursor_row);
    try @import("std").testing.expectEqual(@as(u16, 2), t.cursor_col);
}

test "cursor movement CSI" {
    var t = Terminal.init(80, 24);
    t.write("\x1b[5;10H");
    try @import("std").testing.expectEqual(@as(u16, 4), t.cursor_row);
    try @import("std").testing.expectEqual(@as(u16, 9), t.cursor_col);
}

test "SGR colors" {
    var t = Terminal.init(80, 24);
    t.write("\x1b[31mR\x1b[0mN");
    const r_cell = t.grid.getCell(0, 0);
    const n_cell = t.grid.getCell(0, 1);
    try @import("std").testing.expectEqual(@as(u16, 1), r_cell.fg);
    try @import("std").testing.expectEqual(cell_mod.DEFAULT_COLOR, n_cell.fg);
}

test "erase in display" {
    var t = Terminal.init(80, 24);
    t.write("ABCDE\x1b[1;3H\x1b[J");
    try @import("std").testing.expectEqual(@as(u32, 'A'), t.grid.getCell(0, 0).char);
    try @import("std").testing.expectEqual(@as(u32, 'B'), t.grid.getCell(0, 1).char);
    try @import("std").testing.expectEqual(@as(u32, ' '), t.grid.getCell(0, 2).char);
}

test "scroll on linefeed at bottom" {
    var t = Terminal.init(80, 3);
    t.write("L1\r\nL2\r\nL3\r\nL4");
    try @import("std").testing.expectEqual(@as(u32, 'L'), t.grid.getCell(0, 0).char);
    try @import("std").testing.expectEqual(@as(u32, '2'), t.grid.getCell(0, 1).char);
}

test "wrap pending" {
    var t = Terminal.init(5, 3);
    t.write("12345");
    try @import("std").testing.expectEqual(true, t.wrap_pending);
    try @import("std").testing.expectEqual(@as(u16, 0), t.cursor_row);
    t.write("6");
    try @import("std").testing.expectEqual(@as(u16, 1), t.cursor_row);
    try @import("std").testing.expectEqual(@as(u16, 1), t.cursor_col);
}

test "alternate screen buffer" {
    const testing = @import("std").testing;
    var t = Terminal.init(80, 24);
    var ag = Grid.init(80, 24);
    t.alt_grid = &ag;
    t.write("main screen");
    try testing.expectEqual(@as(u32, 'm'), t.grid.getCell(0, 0).char);
    t.write("\x1b[?1049h");
    try testing.expect(t.using_alt_screen);
    try testing.expectEqual(@as(u32, ' '), t.grid.getCell(0, 0).char);
    t.write("alt screen");
    t.write("\x1b[?1049l");
    try testing.expect(!t.using_alt_screen);
    try testing.expectEqual(@as(u32, 'm'), t.grid.getCell(0, 0).char);
}

test "erase inherits current background color" {
    const testing = @import("std").testing;
    var t = Terminal.init(80, 24);
    // Set bg to red (index 1) and write some text
    t.write("\x1b[41m");
    try testing.expectEqual(@as(u16, 1), t.current_bg);
    // Erase the line — erased cells should inherit the red bg
    t.write("\x1b[2K");
    const cell = t.grid.getCell(0, 0);
    try testing.expectEqual(@as(u16, 1), cell.bg);
    try testing.expectEqual(@as(u32, ' '), cell.char);
    // Erase in display (mode 2) — all cells should have red bg
    t.write("\x1b[2J");
    const cell2 = t.grid.getCell(5, 10);
    try testing.expectEqual(@as(u16, 1), cell2.bg);
    // After SGR reset, erase should use default bg
    t.write("\x1b[0m\x1b[2K");
    const cell3 = t.grid.getCell(0, 0);
    try testing.expectEqual(cell_mod.DEFAULT_COLOR, cell3.bg);
}

test "scroll fills new lines with current background" {
    const testing = @import("std").testing;
    var t = Terminal.init(80, 3);
    t.write("\x1b[42m"); // green bg
    t.write("L1\r\nL2\r\nL3\r\nL4");
    // After scrolling, the bottom row's empty cells should have green bg
    const blank_cell = t.grid.getCell(2, 79);
    try testing.expectEqual(@as(u16, 2), blank_cell.bg);
}

test "scrollback" {
    const testing = @import("std").testing;
    const sb = try testing.allocator.create(Scrollback);
    defer testing.allocator.destroy(sb);
    sb.* = .{};
    var t = Terminal.init(80, 3);
    t.scrollback = sb;
    t.write("L1\r\nL2\r\nL3\r\nL4\r\nL5");
    try testing.expectEqual(@as(u32, 2), sb.count);
    const line0 = sb.getLine(0).?;
    try testing.expectEqual(@as(u32, 'L'), line0.cells[0].char);
    try testing.expectEqual(@as(u32, '2'), line0.cells[1].char);
}
