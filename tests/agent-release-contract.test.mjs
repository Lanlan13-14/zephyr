import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  normalizeTag,
  tagToDisplay,
  releaseUrlFor,
  readAgentReleaseMeta,
} from '../agent-release.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('tag helpers strip agent- prefix and keep v display', () => {
  assert.equal(normalizeTag('refs/tags/agent-v1.0.12'), 'agent-v1.0.12');
  assert.equal(tagToDisplay('agent-v1.0.12'), 'v1.0.12');
  assert.equal(tagToDisplay('v1.0.12'), 'v1.0.12');
  assert.equal(
    releaseUrlFor('Lanlan13-14/zephyr-ssh', 'agent-v1.0.12'),
    'https://github.com/Lanlan13-14/zephyr-ssh/releases/tag/agent-v1.0.12',
  );
});

test('readAgentReleaseMeta prefers env override and marks available', () => {
  const prevTag = process.env.ZEPHYR_AGENT_RELEASE_TAG;
  const prevUrl = process.env.ZEPHYR_AGENT_RELEASE_URL;
  process.env.ZEPHYR_AGENT_RELEASE_TAG = 'agent-v1.0.12';
  process.env.ZEPHYR_AGENT_RELEASE_URL = 'https://example.test/agent-v1.0.12';
  try {
    const meta = readAgentReleaseMeta({
      metaPath: path.join(root, 'public', 'agent-release.json'),
      repo: 'Lanlan13-14/zephyr-ssh',
    });
    assert.equal(meta.tag, 'agent-v1.0.12');
    assert.equal(meta.display, 'v1.0.12');
    assert.equal(meta.url, 'https://example.test/agent-v1.0.12');
    assert.equal(meta.available, true);
  } finally {
    if (prevTag === undefined) delete process.env.ZEPHYR_AGENT_RELEASE_TAG;
    else process.env.ZEPHYR_AGENT_RELEASE_TAG = prevTag;
    if (prevUrl === undefined) delete process.env.ZEPHYR_AGENT_RELEASE_URL;
    else process.env.ZEPHYR_AGENT_RELEASE_URL = prevUrl;
  }
});

test('Agent UI footer uses AgentVersion.tag (v-prefixed)', () => {
  const version = read('zephyr_agent/lib/app/agent_version.dart');
  const home = read('zephyr_agent/lib/screens/home_screen.dart');
  assert.match(version, /static String get tag/);
  assert.match(version, /return v\.startsWith\('v'\) \? v : 'v\$v'/);
  assert.match(home, /bottomNavigationBar:/);
  assert.match(home, /AgentVersion\.tag/);
  assert.match(home, /textAlign: TextAlign\.center/);
});

test('set_version.py parses agent-v tags into semver and keeps tag getter', () => {
  const src = read('zephyr_agent/tool/set_version.py');
  assert.match(src, /agent-v1\.0\.12/);
  assert.match(src, /static String get tag/);
  assert.match(src, /render_agent_version_dart/);
});

test('About and Agent settings pages expose release link slots', () => {
  const html = read('public/app.html');
  const js = read('public/app.js');
  assert.match(html, /id="aboutAgentReleaseLink"/);
  assert.match(html, /id="agentReleaseLink"/);
  assert.match(js, /function applyAgentReleaseLinks/);
  assert.match(js, /applyAgentReleaseLinks\(settings\.agentRelease\)/);
});

test('Docker image build resolves agent release metadata', () => {
  const dockerfile = read('Dockerfile');
  const workflow = read('.github/workflows/docker-build.yml');
  const resolver = read('scripts/resolve-latest-agent-release.mjs');
  assert.match(dockerfile, /resolve-latest-agent-release\.mjs/);
  assert.match(dockerfile, /ZEPHYR_AGENT_RELEASE_TAG/);
  assert.match(workflow, /Resolve latest Agent release tag/);
  assert.match(workflow, /ZEPHYR_AGENT_RELEASE_TAG=/);
  assert.match(workflow, /startswith\("agent-"\)/);
  assert.match(resolver, /agent-v/);
  assert.match(resolver, /public\/agent-release\.json/);
});

test('server injects agentRelease into settings payloads', () => {
  const server = read('server.js');
  const version = read('version.js');
  assert.match(version, /getAgentRelease/);
  assert.match(server, /const AGENT_RELEASE = getAgentRelease\(\)/);
  assert.match(server, /copy\.agentRelease = AGENT_RELEASE/);
  assert.match(server, /function withRuntimeMeta/);
  assert.match(server, /agentRelease: AGENT_RELEASE/);
});
