import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer } from './test-server.mjs';

let server;
let cookie;

before(async () => {
    server = new TestServer();
    await server.start();
    ({ cookie } = await server.bootstrapAdmin('i18n-rerender-pass-1'));
});

after(async () => {
    await server?.cleanup();
});

test('app HTML ships the current i18n cache-busting revision', async () => {
    const response = await fetch(server.url('/app.html'), { headers: { cookie } });
    const html = await response.text();
    assert.match(html, /app\.js\?v=20260727-ai-motion-engine1/);
    assert.match(html, /i18n\/runtime\.js\?v=20260727-ai-motion-engine1/);
});

test('locale switch hook repaints state-derived security fragments', async () => {
    const source = await (await fetch(server.url('/app.js?v=20260727-ai-motion-engine1'))).text();
    for (const renderer of ['renderTotp', 'renderPasskeys', 'renderSecurityLists', 'renderAiProviderList']) {
        assert.match(source, new RegExp(`rerenderLocaleSensitiveContent[\\s\\S]{0,1800}${renderer}`));
    }
    assert.match(source, /onLocaleChange\(\(\) => \{[\s\S]{0,500}rerenderLocaleSensitiveContent\(\)/);
});
