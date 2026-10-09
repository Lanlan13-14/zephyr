// Shared by the desktop page and any host that loads this script. The Go
// process is the text buffer; this object only forwards calls.
// One browser client for the shared Go text core.
//
// The document lives in the editorcore-host process. This module sends the
// edit and reads the UTF-8 snapshot back. It does not keep its own buffer.
function createEditorCoreClient(call) {
  const docs = new Map();

  async function rpc(payload) {
    const response = await call(payload);
    if (!response || response.ok !== true) {
      throw new Error(response?.error || 'editorcore call failed');
    }
    if (response.snapshot) docs.set(response.snapshot.id, response.snapshot);
    return response;
  }

  return {
    async open(text, options = {}) {
      const payload = {op: 'open', text: String(text ?? '')};
      if (options.encoding) payload.encoding = options.encoding;
      if (options.eol) payload.eol = options.eol;
      if (options.tabSize) payload.tabSize = options.tabSize;
      const response = await rpc(payload);
      return response.snapshot;
    },
    async close(id) {
      docs.delete(id);
      await rpc({op: 'close', id});
    },
    async edit(id, {start, end, text, base, extent}) {
      const response = await rpc({
        op: 'replace',
        id,
        start,
        end,
        text: String(text ?? ''),
        base,
        extent,
        preserve: true,
      });
      return response.snapshot;
    },
    async select(id, base, extent) {
      const response = await rpc({op: 'setSelection', id, base, extent});
      return response.snapshot;
    },
    async text(id) {
      const response = await rpc({op: 'text', id});
      return response.text ?? '';
    },
    snapshot(id) {
      return docs.get(id) || null;
    },
    async command(id, op, fields = {}) {
      const response = await rpc({op, id, ...fields});
      return {snapshot: response.snapshot || null, payload: response.payload ?? null, text: response.text ?? ''};
    },
  };
}

globalThis.ZephyrEditorCoreClient = {create: createEditorCoreClient};
