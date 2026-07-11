try {
    await import('../public/vendor/rdp-wasm/wasm_exec.js');
    const GoRuntime = globalThis.Go;
    if (typeof GoRuntime !== 'function') throw new Error('globalThis.Go missing');
    const go = new GoRuntime();
    postMessage({ ok: true, hasImportObject: !!go.importObject });
} catch (error) {
    postMessage({ ok: false, error: error?.stack || String(error) });
}
