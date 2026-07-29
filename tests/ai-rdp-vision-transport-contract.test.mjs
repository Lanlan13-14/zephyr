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
 assert.match(server,/captureAssetId: req\.body\?\.captureAssetId/);
 assert.match(server,/rememberCapture/);
 assert.match(app,/activeTabIsRemoteDesktop/);
 assert.match(app,/item\.dataUrl \|\| item\.error \|\| item\.connected \|\| item\.pending/);
 assert.doesNotMatch(app,/JSON\.stringify\(\{ callId[^\n]*dataUrl/);
 assert.match(app,/vision_upload_failed|视觉帧上传失败/);
});

test('capture image is proxied as binary into a temporary one-shot store',()=>{
 assert.match(server,/express\.raw\(\{ type: \['image\/png', 'image\/jpeg', 'image\/webp'\], limit: '8mb' \}\)/);
 assert.match(bridge,/uploadCaptureImage/);
 assert.match(store,/os\.(?:CreateTemp|WriteFile)/);
 assert.match(store,/os\.Remove\(asset\.Path\)/);
 assert.match(loop,/CaptureAssetID/);
 assert.match(loop,/Parts:\s+\[\]provider\.ContentPart/);
 assert.match(loop,/buildModelMessages/);
 assert.match(loop,/visualObservationName/);
 assert.match(loop,/vision_missing_in_request/);
 assert.doesNotMatch(loop,/modelMessages = append\(modelMessages, visualObservations\.\.\.\)/);
});

test('capture metadata remains separate from image payload',()=>{
 assert.match(app,/imageBytes: imageBlob\.size/);
 assert.match(loop,/remoteDesktopObservationText/);
 assert.doesNotMatch(store,/sqlite|AppendMessage|SaveRunResume/i);
});

test('remote desktop runs fail closed when model/provider vision is disabled',()=>{
 assert.match(server,/activeSurface\?\.kind === 'remote-desktop'/);
 assert.match(server,/modelAcceptsImage|providerPayload\.options\?\.vision/);
 assert.match(server,/code: 'vision_required'/);
 assert.match(appHtml,/id="aiProviderVision"/);
 assert.match(app,/vision: !!\$\('#aiProviderVision'\)\?\.checked/);
 assert.match(app,/activeSurface\?\.kind === 'remote-desktop' && !useRuntime/);
});

test('legacy paths never embed remote desktop dataUrl into chat content',()=>{
 assert.doesNotMatch(app,/最新远程桌面截图（实时截取）：\\n\$\{shot\?\.dataUrl\}/);
 assert.doesNotMatch(app,/最新远程桌面截图[^\n]{0,40}\$\{shot\?\.dataUrl\}/);
 assert.match(app,/handleAiClientCapture[\s\S]{0,800}RDP\/VNC AI 视觉操作需要 Go Runtime/);
 assert.match(app,/continueAiAfterRemoteDesktopClientActions[\s\S]{0,500}remote-desktop[\s\S]{0,300}Go Runtime/);
});
