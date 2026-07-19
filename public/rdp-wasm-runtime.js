const DEFAULT_RUNTIME_URL = './vendor/rdp-wasm/wasm_exec.mjs?v=20260719-panel-file1';

export async function loadGoRuntime({ runtimeUrl = DEFAULT_RUNTIME_URL, importer = (url) => import(url), pipeline = 'unknown' } = {}) {
    let runtime;
    try {
        runtime = await importer(runtimeUrl);
    } catch (error) {
        throw new Error(`Go WASM runtime import failed [pipeline=${pipeline}, url=${runtimeUrl}]: ${error?.message || error}`, { cause: error });
    }
    if (typeof runtime?.Go !== 'function') {
        const exports = Object.keys(runtime || {}).sort().join(',') || '(none)';
        throw new Error(`Go WASM runtime ESM export 'Go' is unavailable [pipeline=${pipeline}, url=${runtimeUrl}, exports=${exports}]`);
    }
    return runtime.Go;
}

export async function instantiateGoWasm(GoRuntime, {
    wasmUrl = './vendor/rdp-wasm/main.wasm?v=20260719-panel-file1',
    fetchImpl = globalThis.fetch,
    pipeline = 'unknown',
} = {}) {
    if (typeof GoRuntime !== 'function') throw new TypeError('GoRuntime must be a constructor');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch is unavailable');

    const go = new GoRuntime();
    let response;
    try {
        response = await fetchImpl(wasmUrl);
    } catch (error) {
        throw new Error(`RDP WASM fetch failed [pipeline=${pipeline}, url=${wasmUrl}]: ${error?.message || error}`, { cause: error });
    }
    if (!response?.ok) {
        throw new Error(`RDP WASM fetch failed [pipeline=${pipeline}, url=${wasmUrl}, status=${response?.status ?? 'unknown'}]`);
    }

    try {
        // instantiateStreaming requires application/wasm. Fall back to bytes for
        // WebViews/reverse proxies that serve a generic MIME type.
        const result = typeof WebAssembly.instantiateStreaming === 'function'
            ? await WebAssembly.instantiateStreaming(response.clone(), go.importObject)
                .catch(async () => WebAssembly.instantiate(await response.arrayBuffer(), go.importObject))
            : await WebAssembly.instantiate(await response.arrayBuffer(), go.importObject);
        return { go, result };
    } catch (error) {
        const mime = response.headers?.get?.('content-type') || 'unknown';
        throw new Error(`RDP WASM instantiate failed [pipeline=${pipeline}, url=${wasmUrl}, mime=${mime}]: ${error?.message || error}`, { cause: error });
    }
}
