import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer } from './test-server.mjs';
import { singleAssetVersion } from './helpers/cache-version.mjs';

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

test('app HTML ships the current app and i18n cache-busting revisions', async () => {
    const response = await fetch(server.url('/app.html'), { headers: { cookie } });
    const html = await response.text();
    const appVersion = singleAssetVersion(html, 'app.js', 'served app.js');
    assert.equal(singleAssetVersion(html, 'style.css', 'served style.css'), appVersion);
    assert.equal(singleAssetVersion(html, 'i18n/runtime.js', 'served i18n runtime'), appVersion);
});

test('locale switch hook repaints state-derived security fragments', async () => {
    const source = await (await fetch(server.url('/app.js'))).text();
    for (const renderer of ['renderTotp', 'renderPasskeys', 'renderSecurityLists', 'renderAiProviderList']) {
        assert.match(source, new RegExp(`rerenderLocaleSensitiveContent[\\s\\S]{0,1800}${renderer}`));
    }
    assert.match(source, /onLocaleChange\(\(\) => \{[\s\S]{0,500}rerenderLocaleSensitiveContent\(\)/);
});
