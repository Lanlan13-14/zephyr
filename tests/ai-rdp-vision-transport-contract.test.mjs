import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const read=(f)=>readFileSync(path.join(root,f),'utf8');
const app=read('public/app.js'),appHtml=read('public/app.html'),server=read('server.js'),bridge=read('ai-runtime-bridge.js'),loop=read('zephyr-ai/internal/agent/loop.go'),store=read('zephyr-ai/internal/agent/capture_store.go');

test('client keeps rendering local and uploads only captured image bytes',()=>{
 assert.match(app,/aiCaptureDataUrlToBlob/);
 assert.match(app,/capture-image\?callId=/);
 assert.match(app,/delete safeShot\.dataUrl/);
 assert.match(app,/captureAssetId: uploaded\.captureAssetId/);
 assert.doesNotMatch(app,/JSON\.stringify\(\{ callId[^\n]*dataUrl/);
});

test('capture image is proxied as binary into a temporary one-shot store',()=>{
 assert.match(server,/express\.raw\(\{ type: \['image\/png', 'image\/jpeg', 'image\/webp'\], limit: '8mb' \}\)/);
 assert.match(bridge,/uploadCaptureImage/);
 assert.match(store,/os\.(?:CreateTemp|WriteFile)/);
 assert.match(store,/os\.Remove\(asset\.Path\)/);
 assert.match(loop,/CaptureAssetID/);
 assert.match(loop,/Parts:\s+\[\]provider\.ContentPart/);
});

test('capture metadata remains separate from image payload',()=>{
 assert.match(app,/imageBytes: imageBlob\.size/);
 assert.match(loop,/remoteDesktopObservationText/);
 assert.doesNotMatch(store,/sqlite|AppendMessage|SaveRunResume/i);
});

test('remote desktop runs fail closed when provider vision is disabled',()=>{
 assert.match(server,/activeSurface\?\.kind === 'remote-desktop'[\s\S]*?providerPayload\.options\?\.vision === false/);
 assert.match(server,/code: 'vision_required'/);
 assert.match(appHtml,/id="aiProviderVision"/);
 assert.match(app,/vision: !!\$\('#aiProviderVision'\)\?\.checked/);
 assert.match(app,/activeSurface\?\.kind === 'remote-desktop' && !useRuntime/);
});
