/* tslint:disable */
/* eslint-disable */
export function bgra_to_rgba(src: Uint8Array): Uint8Array;
export function bgr24_to_bgra(src: Uint8Array): Uint8Array;
export function rgb565_to_bgra(src: Uint8Array): Uint8Array;
export function crop_bgra(src: Uint8Array, src_w: number, src_h: number, x: number, y: number, w: number, h: number): Uint8Array;
export class DirtyQueue {
  free(): void;
  constructor();
  push(x: number, y: number, w: number, h: number): void;
  clear(): void;
  len(): number;
  is_empty(): boolean;
  take_merged(): Uint32Array;
}
export class FrameCompositor {
  free(): void;
  constructor(width: number, height: number);
  width(): number;
  height(): number;
  blit_tile(x: number, y: number, w: number, h: number, data: Uint8Array): boolean;
  take_dirty(): Uint32Array;
  get_dirty_pixels(x: number, y: number, w: number, h: number): Uint8Array;
  resize(w: number, h: number): void;
  clear(r: number, g: number, b: number, a: number): void;
}
export class TilePool {
  free(): void;
  constructor(tile_w: number, tile_h: number, capacity: number);
  tile_width(): number;
  tile_height(): number;
  available(): number;
  release(data: Uint8Array): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_tilepool_free: (a: number, b: number) => void;
  readonly tilepool_new: (a: number, b: number, c: number) => number;
  readonly tilepool_available: (a: number) => number;
  readonly tilepool_release: (a: number, b: number, c: number) => void;
  readonly __wbg_dirtyqueue_free: (a: number, b: number) => void;
  readonly dirtyqueue_new: () => number;
  readonly dirtyqueue_push: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly dirtyqueue_clear: (a: number) => void;
  readonly dirtyqueue_len: (a: number) => number;
  readonly dirtyqueue_is_empty: (a: number) => number;
  readonly dirtyqueue_take_merged: (a: number) => [number, number];
  readonly __wbg_framecompositor_free: (a: number, b: number) => void;
  readonly framecompositor_new: (a: number, b: number) => number;
  readonly framecompositor_width: (a: number) => number;
  readonly framecompositor_height: (a: number) => number;
  readonly framecompositor_blit_tile: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
  readonly framecompositor_take_dirty: (a: number) => [number, number];
  readonly framecompositor_get_dirty_pixels: (a: number, b: number, c: number, d: number, e: number) => [number, number];
  readonly framecompositor_resize: (a: number, b: number, c: number) => void;
  readonly framecompositor_clear: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly bgra_to_rgba: (a: number, b: number) => [number, number];
  readonly bgr24_to_bgra: (a: number, b: number) => [number, number];
  readonly rgb565_to_bgra: (a: number, b: number) => [number, number];
  readonly crop_bgra: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
  readonly tilepool_tile_width: (a: number) => number;
  readonly tilepool_tile_height: (a: number) => number;
  readonly __wbindgen_export_0: WebAssembly.Table;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
