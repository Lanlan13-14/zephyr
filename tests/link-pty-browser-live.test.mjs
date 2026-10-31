import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import ssh2 from 'ssh2';
import { TestServer } from './test-server.mjs';

// This suite is mandatory in its own Actions job; no skip/fake DOM if Chromium is absent.
test('shipped browser parser + renderer ACK transfer one real SSH shell without credential receive', { timeout: 120000 }, async () => {
    const peers = new Set(), streams = new Set(), inputs = [];
    let shells = 0;
    const ssh = new ssh2.Server({ hostKeys: [ssh2.utils.generateKeyPairSync('ed25519').private] }, client => {
        peers.add(client); client.on('error', () => {}); client.on('close', () => peers.delete(client));
        client.on('authentication', ctx => ctx.method === 'password' ? ctx.accept() : ctx.reject());
        client.on('ready', () => client.on('session', accept => {
            const session = accept();
            session.on('pty', acceptPty => acceptPty());
            session.on('window-change', acceptWindow => acceptWindow?.());
            session.on('shell', acceptShell => {
                shells++;
                const stream = acceptShell(); streams.add(stream); stream.on('error', () => {});
                stream.write('\x1b[2J\x1b[HBROWSER-PRIMARY\r\n\x1b[31mRED-CELL\x1b[0m\r\n');
                let line = '';
                stream.on('data', bytes => {
                    inputs.push(bytes.toString()); line += bytes.toString();
                    if (line.includes('\n') || line.includes('\r')) { stream.write('RECEIVED:' + line + '\r\n'); line = ''; }
                });
            });
            session.on('exec', acceptExec => { const stream = acceptExec(); stream.on('error', () => {}); stream.exit(0); stream.end(); });
        }));
    });
    await new Promise(resolve => ssh.listen(0, '127.0.0.1', resolve));
    const app = await new TestServer().start();
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    try {
        const { cookie } = await app.bootstrapAdmin('browser-pty-admin-password');
        const connection = await app.api(cookie, 'POST', '/api/connections', {
            name: 'Browser primary', protocol: 'SSH', host: '127.0.0.1', port: ssh.address().port,
            username: 'browser', password: 'server-only-password', connectionMode: 'direct',
        });
        assert.equal(connection.status, 200, JSON.stringify(connection.body));
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
        await context.addCookies([{ name: 'zephyr_sid', value: cookie.split('=')[1], url: app.url('/') }]);
        await context.route('https://cdn.jsdelivr.net/**', route => route.abort());
        const source = await context.newPage();
        await source.addInitScript(params => sessionStorage.setItem('zephyr_ssh_params_live-source', JSON.stringify(params)), {
            tabId: 'live-source', connectionId: connection.body.connection.id, protocol: 'SSH', host: '127.0.0.1', port: ssh.address().port, username: 'browser',
        });
        const errors = [];
        source.on('pageerror', error => errors.push(error.message));
        await source.goto(app.url('/terminal.html?tabId=live-source'));
        await source.waitForFunction(() => document.getElementById('statusDot')?.classList.contains('connected'), null, { timeout: 30000 });
        await source.waitForFunction(() => document.querySelector('.wterm')?.textContent?.includes('BROWSER-PRIMARY') || document.body.textContent.includes('BROWSER-PRIMARY'), null, { timeout: 15000 });
        await source.locator('#handoffBtn').click();
        await source.getByRole('button', { name: '允许接力当前会话', exact: true }).click();
        await source.getByRole('button', { name: '已允许本账号接力', exact: true }).waitFor();
        await source.getByRole('button', { name: '关闭', exact: true }).last().click();
        const receiver = await context.newPage();
        receiver.on('pageerror', error => errors.push(error.message));
        await receiver.goto(app.url('/terminal.html?handoff=1'));
        const receive = receiver.getByRole('button', { name: '接收：Browser primary', exact: true });
        await receive.waitFor({ timeout: 30000 });
        await receive.click();
        await receiver.waitForFunction(() => document.getElementById('statusText')?.textContent?.includes('已接收主端会话'), null, { timeout: 15000 });
        await source.waitForFunction(() => document.getElementById('statusText')?.textContent?.includes('会话已接力到另一端'), null, { timeout: 15000 });
        assert.equal(shells, 1, 'handoff must not open a second SSH shell');
        assert.match(await receiver.locator('body').innerText(), /BROWSER-PRIMARY/);
        assert.match(await receiver.locator('body').innerText(), /RED-CELL/);
        await receiver.locator('#pasteBtn').evaluate(button => button.blur());
        await receiver.locator('#wtermWrapper').click();
        await receiver.keyboard.type('accepted-browser');
        await receiver.keyboard.press('Enter');
        await receiver.waitForFunction(() => document.body.textContent.includes('RECEIVED:accepted-browser'), null, { timeout: 15000 });
        assert.match(inputs.join(''), /accepted-browser/);
        assert.equal(shells, 1);
        assert.equal(await receiver.evaluate(() => sessionStorage.getItem('zephyr_ssh_params')), null, 'receiver cannot need upstream credentials');
        assert.deepEqual(errors, [], 'unhandled page errors');
        fs.mkdirSync('.link-evidence', { recursive: true });
        await receiver.screenshot({ path: '.link-evidence/primary-pty-receiver.png' });
        fs.writeFileSync('.link-evidence/primary-pty-browser.json', JSON.stringify({ oneUpstreamShell: shells, rendererAck: true, oldOwnerStopped: true, credentialFreeReceive: true, pageErrors: errors }));
    } catch (error) {
        fs.mkdirSync('.link-evidence', { recursive: true });
        for (const [index, page] of browser.contexts().flatMap(context => context.pages()).entries()) {
            try {
                fs.writeFileSync(`.link-evidence/pty-failed-page-${index}.txt`, await page.locator('body').innerText());
                await page.screenshot({ path: `.link-evidence/pty-failed-page-${index}.png` });
            } catch {}
        }
        throw error;
    } finally {
        await browser.close();
        await app.cleanup();
        for (const stream of streams) stream.destroy();
        for (const peer of peers) peer.destroy();
        await new Promise(resolve => ssh.close(resolve));
    }
});
