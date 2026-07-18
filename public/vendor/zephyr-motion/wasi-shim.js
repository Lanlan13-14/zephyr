/**
 * wasi-shim.js — minimal wasi_snapshot_preview1 implementation for
 * TinyGo-built modules.
 *
 * TinyGo's `-target wasm` emits WASI imports even for pure-numeric code
 * (runtime init references random_get/clock/fd_write). The module only ever
 * calls these during startup/panic paths; providing no-op-correct stubs is
 * sufficient and standard practice. Shared by runtime.js (browser) and the
 * Node ABI tests so both exercise the SAME import surface.
 *
 * Usage:
 *   const { imports, setMemory } = createWasiShim();
 *   const { instance } = await WebAssembly.instantiate(bytes, {
 *     wasi_snapshot_preview1: imports,
 *   });
 *   setMemory(instance.exports.memory ?? instance.exports.mem);
 */
export function createWasiShim() {
  const ctx = { mem: null };
  const dv = () => new DataView(ctx.mem.buffer);
  const ERRNO_BADF = 8;

  const imports = {
    // No args / no environ.
    args_sizes_get(argcPtr, argvBufSizePtr) {
      dv().setUint32(argcPtr, 0, true);
      dv().setUint32(argvBufSizePtr, 0, true);
      return 0;
    },
    args_get() { return 0; },
    environ_sizes_get(countPtr, bufSizePtr) {
      dv().setUint32(countPtr, 0, true);
      dv().setUint32(bufSizePtr, 0, true);
      return 0;
    },
    environ_get() { return 0; },

    // Clocks (ms precision; wall clock from Date).
    clock_res_get(_id, outPtr) {
      dv().setBigUint64(outPtr, 1000000n, true);
      return 0;
    },
    clock_time_get(_id, _precision, outPtr) {
      dv().setBigUint64(outPtr, BigInt(Date.now()) * 1000000n, true);
      return 0;
    },

    // File descriptors: accept writes (dropped), fail everything fs-ish.
    fd_advise() { return 0; },
    fd_close() { return 0; },
    fd_datasync() { return 0; },
    fd_fdstat_get(_fd, outPtr) {
      // filetype 0 (unknown) + flags 0 + rights all-ones is fine for our use
      for (let i = 0; i < 24; i++) dv().setUint8(outPtr + i, 0);
      return 0;
    },
    fd_fdstat_set_flags() { return 0; },
    fd_filestat_get() { return 0; },
    fd_prestat_get() { return ERRNO_BADF; },
    fd_prestat_dir_name() { return ERRNO_BADF; },
    fd_read(_fd, _iovs, _iovsLen, nreadPtr) {
      dv().setUint32(nreadPtr, 0, true); // EOF
      return 0;
    },
    fd_readdir() { return ERRNO_BADF; },
    fd_seek(_fd, _offset, _whence, outPtr) {
      dv().setUint32(outPtr, 0, true);
      return 0;
    },
    fd_sync() { return 0; },
    fd_tell(_fd, outPtr) {
      dv().setUint32(outPtr, 0, true);
      return 0;
    },
    fd_write(_fd, iovsPtr, iovsLen, nwrittenPtr) {
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        total += dv().getUint32(iovsPtr + i * 8 + 4, true);
      }
      dv().setUint32(nwrittenPtr, total, true);
      return 0;
    },
    path_open() { return ERRNO_BADF; },
    poll_oneoff() { return 0; },

    // Entropy: real CSPRNG where available.
    random_get(ptr, len) {
      const b = new Uint8Array(ctx.mem.buffer, ptr, len);
      if (globalThis.crypto?.getRandomValues) {
        globalThis.crypto.getRandomValues(b);
      } else {
        for (let i = 0; i < len; i++) b[i] = (Math.random() * 256) | 0;
      }
      return 0;
    },

    sched_yield() { return 0; },

    // Exit: unwind via a catchable tagged error; callers treat it as a
    // normal termination signal (init completed before main returned).
    proc_exit(code) {
      const err = new Error(`wasi proc_exit(${code})`);
      err.wasiExit = true;
      err.code = code;
      throw err;
    },
  };

  return {
    imports,
    setMemory(mem) { ctx.mem = mem; },
  };
}

/** True when an error is the shim's normal-exit signal. */
export function isWasiExit(err) {
  return !!err && (err.wasiExit === true || /proc_exit/.test(String(err)));
}
