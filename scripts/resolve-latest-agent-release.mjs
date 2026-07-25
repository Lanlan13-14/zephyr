#!/usr/bin/env node
/**
 * Resolve the latest Zephyr Agent GitHub release (tag agent-v*) and write
 * public/agent-release.json so the running server can surface a direct link
 * without users jumping between Docker (v*) and Agent (agent-v*) release pages.
 *
 * Sources (first hit wins for the tag):
 *   1. ZEPHYR_AGENT_RELEASE_TAG env (manual override)
 *   2. GitHub Releases API (prefer non-draft, prefer non-prerelease, newest)
 *   3. git tag --sort=-creatordate matching ^agent-
 *   4. empty meta (server shows "尚未发布")
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outPath = process.env.ZEPHYR_AGENT_RELEASE_FILE
  || path.join(root, 'public', 'agent-release.json');
const repo = process.env.ZEPHYR_GITHUB_REPO
  || process.env.GITHUB_REPOSITORY
  || 'Lanlan13-14/zephyr-ssh';
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

function normalizeTag(raw) {
  return String(raw || '').trim().replace(/^refs\/tags\//, '');
}

function tagToDisplay(tag) {
  const t = normalizeTag(tag);
  if (!t) return '';
  if (t.startsWith('agent-')) return t.slice('agent-'.length);
  if (t.startsWith('v')) return t;
  return `v${t}`;
}

function releaseUrlFor(tag) {
  const t = normalizeTag(tag);
  if (!t) return '';
  return `https://github.com/${repo}/releases/tag/${t}`;
}

function isAgentTag(tag) {
  return /^agent-v?\d/i.test(normalizeTag(tag)) || /^agent-/i.test(normalizeTag(tag));
}

async function fromGithubApi() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'zephyr-ssh-agent-release-resolver',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  // Prefer the dedicated "latest" endpoint first (non-prerelease).
  try {
    const latestRes = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
    if (latestRes.ok) {
      const latest = await latestRes.json();
      if (latest?.tag_name && isAgentTag(latest.tag_name) && !latest.draft) {
        return {
          tag: normalizeTag(latest.tag_name),
          url: latest.html_url || releaseUrlFor(latest.tag_name),
          name: latest.name || null,
          publishedAt: latest.published_at || latest.created_at || null,
          source: 'github-latest',
        };
      }
    }
  } catch {
    // fall through to list
  }

  const listRes = await fetch(
    `https://api.github.com/repos/${repo}/releases?per_page=30`,
    { headers },
  );
  if (!listRes.ok) {
    throw new Error(`GitHub releases API ${listRes.status}`);
  }
  const list = await listRes.json();
  if (!Array.isArray(list)) throw new Error('GitHub releases API returned non-array');

  const agents = list
    .filter((r) => r && !r.draft && isAgentTag(r.tag_name))
    .sort((a, b) => {
      // non-prerelease first, then by published_at desc
      const pre = Number(Boolean(a.prerelease)) - Number(Boolean(b.prerelease));
      if (pre !== 0) return pre;
      return String(b.published_at || b.created_at || '').localeCompare(
        String(a.published_at || a.created_at || ''),
      );
    });
  const hit = agents[0];
  if (!hit) return null;
  return {
    tag: normalizeTag(hit.tag_name),
    url: hit.html_url || releaseUrlFor(hit.tag_name),
    name: hit.name || null,
    publishedAt: hit.published_at || hit.created_at || null,
    source: 'github-list',
  };
}

function fromGitTags() {
  try {
    const out = execFileSync(
      'git',
      ['tag', '--sort=-creatordate'],
      { cwd: root, encoding: 'utf8' },
    );
    const tag = out
      .split('\n')
      .map((s) => s.trim())
      .find((t) => isAgentTag(t));
    if (!tag) return null;
    return {
      tag: normalizeTag(tag),
      url: releaseUrlFor(tag),
      name: null,
      publishedAt: null,
      source: 'git-tag',
    };
  } catch {
    return null;
  }
}

function writeMeta(meta) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  console.log(`[agent-release] wrote ${outPath}`);
  console.log(`[agent-release] tag=${meta.tag || '(none)'} source=${meta.source || 'empty'}`);
}

async function main() {
  const override = normalizeTag(process.env.ZEPHYR_AGENT_RELEASE_TAG || '');
  let resolved = null;

  if (override) {
    resolved = {
      tag: override,
      url: process.env.ZEPHYR_AGENT_RELEASE_URL || releaseUrlFor(override),
      name: null,
      publishedAt: null,
      source: 'env',
    };
  } else {
    try {
      resolved = await fromGithubApi();
    } catch (err) {
      console.warn(`[agent-release] GitHub API failed: ${err.message}`);
    }
    if (!resolved) resolved = fromGitTags();
  }

  const meta = {
    tag: resolved?.tag || null,
    display: resolved?.tag ? tagToDisplay(resolved.tag) : null,
    url: resolved?.url || null,
    name: resolved?.name || null,
    publishedAt: resolved?.publishedAt || null,
    updatedAt: new Date().toISOString(),
    repo,
    source: resolved?.source || 'empty',
  };
  writeMeta(meta);
}

main().catch((err) => {
  console.error('[agent-release] fatal:', err);
  // Never fail the image build solely because release discovery failed —
  // write an empty meta so the UI can show a graceful fallback.
  writeMeta({
    tag: null,
    display: null,
    url: null,
    name: null,
    publishedAt: null,
    updatedAt: new Date().toISOString(),
    repo,
    source: 'error',
    error: String(err?.message || err),
  });
  process.exit(0);
});
