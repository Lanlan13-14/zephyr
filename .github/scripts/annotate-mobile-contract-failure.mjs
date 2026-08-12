#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const MAX_TESTS = 4;
const MAX_TEXT = 500;
const FIELD_ORDER = ['error', 'code', 'name', 'failureType'];
const FIELD_PATTERN = /^(\s+)(error|code|name|failureType):(?:\s*(.*?))?\s*$/;
const TEST_PATTERN = /^\s*not ok\s+\d+\s+-\s+(.+?)\s*$/i;
const BLOCK_SCALAR_PATTERN = /^[|>][+-]?$/;
const SERVER_OUTPUT_MARKER = '--- server output ---';

function redactCredentials(value) {
  let text = value;

  text = text.replace(
    /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi,
    '$1[REDACTED]@',
  );
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
  text = text.replace(/(^|[\s('"=])\.\.?[\\/][^\s'"<>|]*/g, '$1[PATH]');

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

function unique(items, limit = items.length) {
  return [...new Set(items.filter(Boolean))].slice(0, limit);
}

function indentation(line) {
  return line.match(/^\s*/)[0].length;
}

function readBlockScalar(lines, start, parentIndent) {
  const block = [];
  let index = start;

  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() !== '' && indentation(line) <= parentIndent) break;
    block.push(line);
    index += 1;
  }

  const contentIndent = block
    .filter((line) => line.trim() !== '')
    .reduce((minimum, line) => Math.min(minimum, indentation(line)), Infinity);
  const value = block
    .map((line) => Number.isFinite(contentIndent) ? line.slice(contentIndent) : '')
    .join('\n')
    .trim();

  return { value, nextIndex: index };
}

function firstMessageLine(value) {
  return String(value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? '';
}

function isAllowedServerCause(value) {
  return [
    /^(?:Error|TypeError|ReferenceError|SyntaxError|RangeError)(?:\s*\[[A-Z0-9_]+\])?:\s+.*\b(?:cannot|could not|failed|missing|not found|unsupported|unavailable|invalid|load|binding|module|package|listen|E[A-Z]{3,})\b.*$/i,
    /^(?:Cannot find (?:module|package)|Could not (?:find|load)|Failed to (?:find|load|initialize|start)|No native build was found|Module did not self-register|The module .+ was compiled against|listen E(?:ADDRINUSE|ACCES)\b).+$/i,
  ].some((pattern) => pattern.test(value));
}

function extractServerCause(errorValue) {
  const lines = String(errorValue ?? '').split(/\r?\n/);
  const markerIndex = lines.findIndex((line) => line.trim() === SERVER_OUTPUT_MARKER);
  if (markerIndex < 0) return '';

  for (const line of lines.slice(markerIndex + 1)) {
    const candidate = line.trim().replace(/^\[[^\]\r\n]{1,40}\]\s*/, '');
    if (!candidate || !isAllowedServerCause(candidate)) continue;
    return sanitizePublicText(candidate);
  }
  return '';
}

export function extractPublicDiagnostics(logText) {
  const lines = String(logText ?? '').split(/\r?\n/);
  const tests = [];
  let firstFailureIndex = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const testMatch = line.match(TEST_PATTERN);
    if (!testMatch || /\s+#\s+(?:SKIP|TODO)\b/i.test(testMatch[1])) continue;
    if (firstFailureIndex < 0) firstFailureIndex = index;
    tests.push(sanitizePublicText(testMatch[1]));
  }

  if (firstFailureIndex < 0) return { tests: [], reasons: [] };

  const fields = new Map();
  let errorValue = '';
  for (let index = firstFailureIndex + 1; index < lines.length;) {
    if (TEST_PATTERN.test(lines[index])) break;

    const fieldMatch = lines[index].match(FIELD_PATTERN);
    if (fieldMatch) {
      const [, whitespace, field, inlineValue = ''] = fieldMatch;
      let value = inlineValue;
      let nextIndex = index + 1;
      if (BLOCK_SCALAR_PATTERN.test(inlineValue)) {
        const scalar = readBlockScalar(lines, nextIndex, whitespace.length);
        value = scalar.value;
        nextIndex = scalar.nextIndex;
      }
      if (!fields.has(field) && value) fields.set(field, firstMessageLine(value));
      if (field === 'error' && !errorValue) errorValue = value;
      index = nextIndex;
      continue;
    }
    index += 1;
  }

  const reasons = FIELD_ORDER.flatMap((field) => {
    const value = sanitizePublicText(fields.get(field));
    return value ? [`${field}: ${value}`] : [];
  });
  const serverCause = extractServerCause(errorValue);
  if (serverCause) reasons.push(`server startup reason: ${serverCause}`);

  return { tests: unique(tests, MAX_TESTS), reasons: unique(reasons) };
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

  if (!logPath) {
    emitError('Zephyr One mobile contracts', 'Sanitized diagnostics were unavailable.');
    return;
  }

  let logText;
  try {
    logText = await readFile(logPath, 'utf8');
  } catch {
    emitError('Zephyr One mobile contracts', 'Sanitized diagnostics were unavailable.');
    return;
  }

  const diagnostics = extractPublicDiagnostics(logText);
  for (const reason of diagnostics.reasons) {
    emitError('Mobile contract failure reason', reason);
  }
  for (const test of diagnostics.tests) {
    emitError('Mobile contract test failed', test);
  }

  if (diagnostics.tests.length === 0 && diagnostics.reasons.length === 0) {
    emitError(
      'Zephyr One mobile contracts',
      `Contract suite failed (exit ${exitCode}; platform ${platform}); no allowlisted diagnostic was available.`,
    );
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  main().catch(() => {
    emitError('Zephyr One mobile contracts', 'Sanitized diagnostics were unavailable.');
  });
}
