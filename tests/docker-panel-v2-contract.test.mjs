import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/* Docker panel v2 contract: overview strip, show-running filter, prune
 * actions, create-container form, and a networks tab — all wired over the
 * existing SSH exec channel (no new transport). */

const root = path.resolve(import.meta.dirname, '..');
const terminalJs = fs.readFileSync(path.join(root, 'public', 'terminal.js'), 'utf8');
const terminalHtml = fs.readFileSync(path.join(root, 'public', 'terminal.html'), 'utf8');
const serverJs = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('terminal.html exposes the networks tab and overview strip', () => {
    assert.ok(/data-docker-tab="networks"/.test(terminalHtml), 'networks tab button');
    assert.ok(/id="dockerNetworksPanel"/.test(terminalHtml), 'networks panel');
    assert.ok(/id="dockerOverview"/.test(terminalHtml), 'overview strip');
    assert.ok(/data-docker-overview="running"/.test(terminalHtml), 'overview running count');
    assert.ok(/data-docker-overview="storage"/.test(terminalHtml), 'overview storage usage');
    assert.ok(/id="dockerShowAll"/.test(terminalHtml), 'show-all filter toggle');
    assert.ok(/id="dockerPruneBtn"/.test(terminalHtml), 'system prune button');
    assert.ok(/id="dockerCreateImage"/.test(terminalHtml), 'create-container image input');
    assert.ok(/id="dockerNetworkCreateBtn"/.test(terminalHtml), 'network create button');
});

test('terminal.js wires overview refresh, filter, prune, create, and networks', () => {
    assert.ok(/function renderDockerOverview\(\)/.test(terminalJs), 'overview renderer');
    assert.ok(/dockerSend\(\{ type: 'docker-system-df' \}\)/.test(terminalJs), 'refresh fetches system df');
    assert.ok(/dockerSend\(\{ type: 'docker-list-networks' \}\)/.test(terminalJs), 'refresh fetches networks');
    assert.ok(/dockerShowAll\?\.addEventListener\('change'/.test(terminalJs), 'show-all filter listener');
    assert.ok(/dockerSend\(\{ type: 'docker-prune', kind: 'system' \}\)/.test(terminalJs), 'system prune sender');
    assert.ok(/dockerSend\(\{ type: 'docker-prune', kind: 'images' \}\)/.test(terminalJs), 'image prune sender');
    assert.ok(/type: 'docker-create-container'/.test(terminalJs), 'create container sender');
    assert.ok(/type: 'docker-network-action', action: 'create'/.test(terminalJs), 'network create sender');
    assert.ok(/function renderDockerNetworks\(/.test(terminalJs), 'networks renderer');
    assert.ok(/case 'docker-system-df':/.test(terminalJs), 'system-df message handler');
    assert.ok(/case 'docker-networks':/.test(terminalJs), 'networks message handler');
    assert.ok(/case 'docker-create-container':/.test(terminalJs), 'create result handler');
    assert.ok(/case 'docker-prune':/.test(terminalJs), 'prune result handler');
});

test('server.js handles the new docker messages over SSH exec', () => {
    assert.ok(/msg\.type === 'docker-system-df'/.test(serverJs), 'system df handler');
    assert.ok(/docker system df --format/.test(serverJs), 'system df command');
    assert.ok(/msg\.type === 'docker-list-networks'/.test(serverJs), 'network list handler');
    assert.ok(/msg\.type === 'docker-network-action'/.test(serverJs), 'network action handler');
    assert.ok(/docker network create/.test(serverJs), 'network create command');
    assert.ok(/msg\.type === 'docker-create-container'/.test(serverJs), 'create container handler');
    assert.ok(/docker create /.test(serverJs), 'docker create command');
    assert.ok(/msg\.type === 'docker-prune'/.test(serverJs), 'prune handler');
    assert.ok(/docker system prune -f/.test(serverJs), 'system prune command');
    assert.ok(/docker image prune -f/.test(serverJs), 'image prune command');
    assert.ok(/docker network prune -f/.test(serverJs), 'network prune command');
});

test('server validates create-container inputs before exec', () => {
    const idx = serverJs.indexOf("msg.type === 'docker-create-container'");
    assert.ok(idx > 0, 'create handler exists');
    const body = serverJs.slice(idx, idx + 2200);
    assert.ok(/容器名不合法/.test(body), 'container name validation');
    assert.ok(/端口映射不合法/.test(body), 'port mapping validation');
    assert.ok(/环境变量不合法/.test(body), 'env validation');
});

/* DPanel/1Panel parity additions: per-container CPU/MEM stats, container
 * inspect drawer, image tag, and volume management. All over SSH exec. */

test('terminal.html has volumes tab and CPU/MEM columns in containers table', () => {
    assert.ok(/data-docker-tab="volumes"/.test(terminalHtml), 'volumes tab');
    assert.ok(/id="dockerVolumesPanel"/.test(terminalHtml), 'volumes panel');
    assert.ok(/<th>CPU<\/th>/.test(terminalHtml), 'CPU column');
    assert.ok(/data-i18n="内存"/.test(terminalHtml), 'MEM column');
    assert.ok(/id="dockerVolumeCreateBtn"/.test(terminalHtml), 'volume create button');
    assert.ok(/id="dockerInspectDrawer"/.test(terminalHtml), 'inspect drawer');
});

test('terminal.js wires container stats polling, inspect, tag, and volumes', () => {
    assert.ok(/startDockerStatsLoop/.test(terminalJs), 'stats loop');
    assert.ok(/dockerSend\(\{ type: 'docker-container-stats' \}\)/.test(terminalJs), 'stats request');
    assert.ok(/type: 'docker-container-inspect', id: target/.test(terminalJs), 'inspect request');
    assert.ok(/type: 'docker-image-tag', source: imageRef/.test(terminalJs), 'image tag request');
    assert.ok(/function renderDockerVolumes\(/.test(terminalJs), 'volumes renderer');
    assert.ok(/type: 'docker-volume-action', action: 'create'/.test(terminalJs), 'volume create');
    assert.ok(/case 'docker-container-stats':/.test(terminalJs), 'stats handler');
    assert.ok(/case 'docker-volumes':/.test(terminalJs), 'volumes handler');
    assert.ok(/case 'docker-image-tag':/.test(terminalJs), 'tag handler');
});

test('server.js handles container stats, inspect, image tag, and volumes', () => {
    assert.ok(/msg\.type === 'docker-container-stats'/.test(serverJs), 'stats handler');
    assert.ok(/docker stats --no-stream/.test(serverJs), 'stats command');
    assert.ok(/msg\.type === 'docker-container-inspect'/.test(serverJs), 'inspect handler');
    assert.ok(/docker inspect/.test(serverJs), 'inspect command');
    assert.ok(/msg\.type === 'docker-image-tag'/.test(serverJs), 'tag handler');
    assert.ok(/docker tag /.test(serverJs), 'tag command');
    assert.ok(/msg\.type === 'docker-list-volumes'/.test(serverJs), 'volume list');
    assert.ok(/msg\.type === 'docker-volume-action'/.test(serverJs), 'volume action');
    assert.ok(/docker volume create/.test(serverJs), 'volume create command');
    assert.ok(/docker volume rm/.test(serverJs), 'volume rm command');
    assert.ok(/docker volume prune -f/.test(serverJs), 'volume prune');
});
