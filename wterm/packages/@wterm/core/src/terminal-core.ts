export interface CellData {
  char: number;
  fg: number;
  bg: number;
  flags: number;
  /** Resolved 24-bit foreground color (0xRRGGBB). Present when the core provides true color. */
  fgRgb?: number;
  /** Resolved 24-bit background color (0xRRGGBB). Present when the core provides true color. */
  bgRgb?: number;
  /** P2-1: Wide character width. 0 = narrow, 1 = wide lead (2 cells), 2 = continuation. */
  wide?: number;
  /** OSC 8 hyperlink table identifier. */
  linkId?: number;
}

export interface CursorState {
  row: number;
  col: number;
  visible: boolean;
  style?: number;
}

export interface UnhandledSequence {
  final: string;
  private: string;
  paramCount: number;
  params: number[];
}

/**
 * Abstract terminal emulation core. Both the built-in Zig WASM core
 * (`WasmBridge`) and alternative backends (e.g. `@wterm/ghostty`) implement
 * this interface so that `@wterm/dom` can render any core interchangeably.
 */
export interface TerminalCore {
  // -- Lifecycle --
  init(cols: number, rows: number): void;
  resize(cols: number, rows: number): void;

  // -- I/O --
  writeString(str: string): void;
  writeRaw(data: Uint8Array): void;

  // -- Grid --
  getCell(row: number, col: number): CellData;
  getHyperlink(id: number): string | null;
  isDirtyRow(row: number): boolean;
  clearDirty(): void;
  getCols(): number;
  getRows(): number;

  // -- Cursor --
  getCursor(): CursorState;
  cursorStyle(): number;

  // -- Modes --
  cursorKeysApp(): boolean;
  bracketedPaste(): boolean;
  mouseMode(): number;
  mouseSGR(): boolean;
  bellPending(): boolean;
  clearBell(): void;
  /** True while DECSET 2026 synchronized output is active. */
  syncOutput(): boolean;
  usingAltScreen(): boolean;

  // -- Side outputs --
  getTitle(): string | null;
  getResponse(): string | null;

  // -- Scrollback --
  getScrollbackCount(): number;
  getScrollbackCell(offset: number, col: number): CellData;
  getScrollbackLineLen(offset: number): number;

  // -- Debug --
  getUnhandledSequences(): UnhandledSequence[];
}
