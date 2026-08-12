#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const MAX_ITEMS = 20;
const MAX_TEXT = 500;
const FIELD_PATTERN = /^\s+(error|code|name|failureType):\s*(.*?)\s*$/;
const TEST_PATTERN = /^\s*not ok\s+\d+\s+-\s+(.+?)(?:\s+#\s+(?:SKIP|TODO).*)?$/i;

function redactCredentials(value) {
  let text = value;

  text = text.replace(
    /\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*(?:(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+|"[^"]*"|'[^']*'|[^\s,;]*)/gi,
    (match) => `${match.split(/[:=]/, 1)[0]}=[REDACTED]`,
  );
  text = text.replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED]');
  text = text.replace(
    /\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|passwd|secret|api[_-]?key|private[_-]?key|client[_-]?secret|canary|key)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]*)/gi,
    (match) => `${match.split(/[:=]/, 1)[0]}=[REDACTED]`,
  );
  text = text.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|AKIA[0-9A-Z]{12,})\b/g, '[REDACTED]');
  text = text.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]');
  text = text.replace(/\b[A-Za-z0-9_-]*canary[A-Za-z0-9_-]*\b/gi, '[REDACTED]');
  text = text.replace(/([?&](?:token|password|secret|key|authorization)=)[^&#\s]*/gi, '$1[REDACTED]');

  return text;
}

function hasResidualSensitiveAssignment(value) {
  const pattern = /\b(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|token|canary|api[_-]?key|private[_-]?key)\b\s*[:=]\s*([^\s,;]+)/gi;
  for (const match of value.matchAll(pattern)) {
    if (match[1] !== '[REDACTED]') return true;
  }
  return false;
}

function redactAbsolutePaths(value) {
  let text = value;

  text = text.replace(/file:\/{2,3}(?:[A-Za-z]:)?\/[^\s'"<>|]*/gi, '[PATH]');
  text = text.replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s'"<>|]*/g, '[PATH]');
  text = text.replace(/(^|[\s('"=])\/(?!\/)[^\s'"<>|]*/g, '$1[PATH]');

  return text;
}

export function sanitizePublicText(value) {
  let text = String(value ?? '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim();

  if ((text.startsWith("'") && text.endsWith("'")) ||
      (text.startsWith('"') && text.endsWith('"'))) {
    text = text.slice(1, -1);
  }

  text = redactAbsolutePaths(redactCredentials(text)).replace(/\s+/g, ' ').trim();

  // If a credential or absolute-path shape survived, publish no source text.
  if (hasResidualSensitiveAssignment(text) ||
      /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/i.test(text) ||
      /(?:[A-Za-z]:[\\/]|\\\\|file:\/{2,3})/.test(text) ||
      /(^|[\s('"=])\/(?!\/)/.test(text)) {
    return '[REDACTED DIAGNOSTIC]';
  }

  return text.slice(0, MAX_TEXT);
}

function unique(items) {
  return [...new Set(items.filter(Boolean))].slice(0, MAX_ITEMS);
}

export function extractPublicDiagnostics(logText) {
  const tests = [];
  const reasons = [];

  for (const line of String(logText ?? '').split(/\r?\n/)) {
    const testMatch = line.match(TEST_PATTERN);
    if (testMatch) {
      tests.push(sanitizePublicText(testMatch[1]));
      continue;
    }

    const fieldMatch = line.match(FIELD_PATTERN);
    if (fieldMatch) {
      const value = sanitizePublicText(fieldMatch[2]);
      if (value) reasons.push(`${fieldMatch[1]}: ${value}`);
    }
  }

  return { tests: unique(tests), reasons: unique(reasons) };
}

function escapeWorkflowData(value) {
  return String(value)
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
}

function escapeWorkflowProperty(value) {
  return escapeWorkflowData(value)
    .replaceAll(':', '%3A')
    .replaceAll(',', '%2C');
}

function emitError(title, message) {
  process.stdout.write(`::error title=${escapeWorkflowProperty(title)}::${escapeWorkflowData(message)}\n`);
}

function parseArguments(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    args.set(argv[index], argv[index + 1]);
  }
  return args;
}

function safeExit(value) {
  return /^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/.test(value ?? '')
    ? value
    : 'unknown';
}

function safePlatform(value) {
  return /^(?:Linux|macOS|Windows)(?:\/(?:X64|ARM64|ARM))?$/.test(value ?? '')
    ? value
    : 'unknown';
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const exitCode = safeExit(args.get('--exit'));
  const platform = safePlatform(args.get('--platform'));
  const logPath = args.get('--log');

  emitError(
    'Zephyr One mobile contracts',
    `Contract suite failed (exit ${exitCode}; platform ${platform}).`,
  );

  if (!logPath) return;

  let logText;
  try {
    logText = await readFile(logPath, 'utf8');
  } catch {
    emitError('Zephyr One mobile contracts', 'Sanitized diagnostics were unavailable.');
    return;
  }

  const diagnostics = extractPublicDiagnostics(logText);
  for (const test of diagnostics.tests) {
    emitError('Mobile contract test failed', test);
  }
  for (const reason of diagnostics.reasons) {
    emitError('Mobile contract failure reason', reason);
  }

  if (diagnostics.tests.length === 0 && diagnostics.reasons.length === 0) {
    emitError('Zephyr One mobile contracts', 'No allowlisted diagnostic was available.');
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  main().catch(() => {
    emitError('Zephyr One mobile contracts', 'Sanitized diagnostics were unavailable.');
  });
}
