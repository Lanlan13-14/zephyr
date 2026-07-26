import test from 'node:test';
import assert from 'node:assert/strict';
import { AiBrowserService } from '../ai-browser-service.js';

function fakeService() {
  const service = new AiBrowserService();
  const page = { sessionId: 'cdp', url: 'https://example.test', domRevision: 4, refs: new Map([['el_4_1', { selector: '#submit', domRevision: 4 }]]) };
  service.getPage = async () => page;
  service.title = async () => 'Example';
  const calls = [];
  service.client = {
    send: async (method, params) => {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate') {
        if (String(params.expression).includes('getBoundingClientRect')) return { result: { value: { ok: true, x: 10, y: 20, text: 'Submit', tag: 'BUTTON' } } };
        return { result: { value: { ok: true, value: 'hello' } } };
      }
      return {};
    },
  };
  return { service, page, calls };
}

test('browser resolves elementRef only for matching DOM revision', () => {
  const { service, page } = fakeService();
  assert.equal(service.resolveElementRef(page, 'el_4_1', 4), '#submit');
  assert.throws(() => service.resolveElementRef(page, 'el_4_1', 3), (error) => error.code === 'stale_dom_revision');
  assert.throws(() => service.resolveElementRef(page, 'el_4_9', 4), (error) => error.code === 'stale_element_ref');
});

test('browser click and type use versioned references instead of model selectors', async () => {
  const { service, calls } = fakeService();
  const clicked = await service.click({ session: 's', elementRef: 'el_4_1', domRevision: 4 });
  assert.equal(clicked.elementRef, 'el_4_1');
  assert.ok(calls.some((call) => call.method === 'Runtime.evaluate' && String(call.params.expression).includes('#submit')));

  calls.length = 0;
  const typed = await service.type({ session: 's', elementRef: 'el_4_1', domRevision: 4, text: 'hello', clear: true });
  assert.equal(typed.domRevision, 4);
  assert.ok(calls.some((call) => call.method === 'Input.insertText' && call.params.text === 'hello'));
});
