#!/usr/bin/env node
// Regenerates AI Contract v2 types from contracts/ai/v2.
//   node scripts/generate-ai-contracts.mjs
//   node scripts/generate-ai-contracts.mjs --check
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, errorTaxonomy } from './lib/ai-contract-v2.mjs';

const OUT = {
  node: 'src/generated/ai-contract-v2.js',
  go: 'zephyr-ai/contracts/v2/contract.go',
  kotlin: 'zephyr_one/mobile/android/core-contracts/src/main/kotlin/one/zephyr/mobile/contracts/aiv2/AIContractV2.kt',
  swift: 'zephyr_one/mobile/ios/Sources/ZephyrContracts/Generated/AIV2/AIContractV2.swift',
  manifest: 'contracts/ai/v2/GENERATED_MANIFEST.json',
};

const FAMILIES = ['openai', 'anthropic', 'google', 'deepseek', 'ollama', 'custom'];
const APIS = ['openai-responses', 'openai-chat-completions', 'anthropic-messages', 'google-generative-ai', 'ollama-openai'];
const AUTH_KINDS = ['api-key', 'bearer-token', 'device-envelope', 'none'];
const VISIBILITIES = ['private', 'shared'];
const PROMPT_CACHE = ['unsupported', 'auto', 'explicit'];
const REASONING_LEVELS = ['minimal', 'low', 'medium', 'high'];
const TIERS = ['fast', 'balanced', 'quality'];
const PROVENANCE = ['builtin', 'catalog-remote', 'user'];
const DNS_MODES = ['system', 'host-resolved', 'literal'];
const TLS = ['1.2', '1.3'];
const IP_FAMILIES = ['ipv4', 'ipv6'];
const RESOLUTION_SOURCES = ['android-jvm-dns', 'ios-system-dns', 'desktop-system-dns', 'literal'];
const STOP_REASONS = ['stop', 'length', 'tool_use', 'content_filter', 'cancelled', 'error'];
const EVENT_TYPES = ['start', 'text_start', 'text_delta', 'text_end', 'reasoning_start', 'reasoning_delta', 'reasoning_end', 'tool_call_start', 'tool_call_delta', 'tool_call_end', 'usage', 'done', 'error'];
const TRISTATE_MODES = ['inherit', 'omit', 'value'];
const FALLBACKS = ['ask', 'deny', 'automatic'];
const CELL_SCOPES = ['conversation', 'group'];
const RETENTION = ['retain', 'purge-on-delete'];
const BINDING_STATUS = ['active', 'retaining', 'migrating', 'destroyed'];
const ENTITY_TYPES = ['aiConversation', 'aiConversationBranch', 'aiMessage', 'aiAttachmentManifest', 'aiToolRun', 'aiConversationGroup', 'aiCellBinding', 'aiProviderAccount', 'aiSecretBinding', 'aiModelOverride', 'aiBehaviorProfile', 'aiCellProfile', 'aiExecutionPolicy'];
const CLIENT_ACTIONS = ['fix_input', 'reauthenticate', 'retry', 'abort', 'upgrade'];

const pascal = (value) => value.split(/[^A-Za-z0-9]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join('');
const camel = (value) => {
  const name = pascal(value);
  return name[0].toLowerCase() + name.slice(1);
};
const goName = (value) => pascal(value)
  .replace(/Ai/g, 'AI')
  .replace(/Dns/g, 'DNS')
  .replace(/Tls/g, 'TLS')
  .replace(/Ip/g, 'IP')
  .replace(/Json/g, 'JSON')
  .replace(/Url/g, 'URL')
  .replace(/Openai/g, 'OpenAI')
  .replace(/Api/g, 'API')
  .replace(/Jvm/g, 'JVM')
  .replace(/Ios/g, 'IOS')
  .replace(/^(\d)/, 'V$1');
const ktConst = (value) => {
  const name = value.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  return /^[0-9]/.test(name) ? 'V' + name : name;
};
const SWIFT_KEYWORDS = new Set([
  'associatedtype', 'class', 'deinit', 'enum', 'extension', 'fileprivate', 'func',
  'import', 'init', 'inout', 'internal', 'let', 'open', 'operator', 'private',
  'precedencegroup', 'protocol', 'public', 'rethrows', 'static', 'struct',
  'subscript', 'typealias', 'var', 'break', 'case', 'catch', 'continue', 'default',
  'defer', 'do', 'else', 'fallthrough', 'for', 'guard', 'if', 'in', 'repeat',
  'return', 'throw', 'switch', 'where', 'while', 'as', 'false', 'is', 'nil',
  'self', 'super', 'throws', 'true', 'try',
]);
const swiftCase = (value) => {
  const name = camel(value);
  const safe = /^[0-9]/.test(name) ? 'v' + name : name;
  return SWIFT_KEYWORDS.has(safe) ? '`' + safe + '`' : safe;
};
const quote = (value) => JSON.stringify(value);

function enumBlock(kind, values) {
  return { kind, values };
}

const ENUMS = [
  enumBlock('ProviderFamily', FAMILIES),
  enumBlock('ProviderAPI', APIS),
  enumBlock('AuthKind', AUTH_KINDS),
  enumBlock('SharingVisibility', VISIBILITIES),
  enumBlock('PromptCache', PROMPT_CACHE),
  enumBlock('ReasoningLevel', REASONING_LEVELS),
  enumBlock('PerformanceTier', TIERS),
  enumBlock('ModelProvenance', PROVENANCE),
  enumBlock('DNSMode', DNS_MODES),
  enumBlock('TLSMinVersion', TLS),
  enumBlock('IPFamily', IP_FAMILIES),
  enumBlock('ResolutionSource', RESOLUTION_SOURCES),
  enumBlock('StopReason', STOP_REASONS),
  enumBlock('StreamEventType', EVENT_TYPES),
  enumBlock('TristateMode', TRISTATE_MODES),
  enumBlock('ExecutionFallback', FALLBACKS),
  enumBlock('CellScope', CELL_SCOPES),
  enumBlock('RetentionPolicy', RETENTION),
  enumBlock('CellBindingStatus', BINDING_STATUS),
  enumBlock('AIEntityType', ENTITY_TYPES),
  enumBlock('AIClientAction', CLIENT_ACTIONS),
];

function nodeSource() {
  const taxonomy = errorTaxonomy();
  const lines = [];
  lines.push('// GENERATED FILE - DO NOT EDIT.');
  lines.push('// Source: contracts/ai/v2. Regenerate with `node scripts/generate-ai-contracts.mjs`.');
  lines.push('');
  lines.push('export const AI_CONTRACT_SCHEMA_VERSION = 2;');
  lines.push('');
  for (const item of ENUMS) {
    lines.push('export const ' + item.kind + ' = Object.freeze({');
    for (const value of item.values) lines.push('  ' + ktConst(value) + ': ' + quote(value) + ',');
    lines.push('});');
    lines.push('');
  }
  lines.push('export const AI_ERROR_TAXONOMY = Object.freeze(' + JSON.stringify(taxonomy, null, 2).replace(/\n/g, '\n') + ');');
  lines.push('');
  lines.push('const byCode = new Map(AI_ERROR_TAXONOMY.errors.map((item) => [item.code, item]));');
  lines.push('');
  lines.push('export function aiErrorSpec(code) {');
  lines.push('  const spec = byCode.get(code);');
  lines.push('  if (!spec) throw new Error("unknown AI error code: " + code);');
  lines.push('  return spec;');
  lines.push('}');
  lines.push('');
  lines.push('export function isRetryableAIError(code) {');
  lines.push('  return aiErrorSpec(code).retryable;');
  lines.push('}');
  lines.push('');
  lines.push('function assertEnum(kind, value, allowed) {');
  lines.push('  if (!allowed.includes(value)) throw new Error(kind + " has unsupported value: " + value);');
  lines.push('}');
  lines.push('');
  lines.push('export function assertProviderAccountEnums(account) {');
  lines.push('  assertEnum("family", account.family, Object.values(ProviderFamily));');
  lines.push('  assertEnum("api", account.api, Object.values(ProviderAPI));');
  lines.push('  assertEnum("auth.kind", account.auth && account.auth.kind, Object.values(AuthKind));');
  lines.push('  if (account.sharing) assertEnum("sharing.visibility", account.sharing.visibility, Object.values(SharingVisibility));');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

function goEnum(item) {
  const lines = ['type ' + goName(item.kind) + ' string', '', 'const ('];
  for (const value of item.values) {
    lines.push('\t' + goName(item.kind) + goName(value) + ' ' + goName(item.kind) + ' = ' + quote(value));
  }
  lines.push(')', '');
  lines.push('func (v ' + goName(item.kind) + ') Valid() bool {');
  lines.push('\tswitch v {');
  lines.push('\tcase ' + item.values.map((value) => goName(item.kind) + goName(value)).join(', ') + ':');
  lines.push('\t\treturn true');
  lines.push('\tdefault:');
  lines.push('\t\treturn false');
  lines.push('\t}');
  lines.push('}', '');
  return lines.join('\n');
}

function goSource() {
  const taxonomy = errorTaxonomy();
  const lines = [];
  lines.push('// GENERATED FILE - DO NOT EDIT.');
  lines.push('// Source: contracts/ai/v2. Regenerate with `node scripts/generate-ai-contracts.mjs`.');
  lines.push('');
  lines.push('package contractv2');
  lines.push('');
  lines.push('const SchemaVersion = 2');
  lines.push('');
  for (const item of ENUMS) lines.push(goEnum(item));
  lines.push('type AIErrorSpec struct {');
  lines.push('\tCode string');
  lines.push('\tHTTPStatus int');
  lines.push('\tRetryable bool');
  lines.push('\tClientAction AIClientAction');
  lines.push('}');
  lines.push('');
  lines.push('var AIErrorTaxonomy = []AIErrorSpec{');
  for (const item of taxonomy.errors) {
    lines.push('\t{Code: ' + quote(item.code) + ', HTTPStatus: ' + item.httpStatus + ', Retryable: ' + item.retryable + ', ClientAction: ' + quote(item.clientAction) + '},');
  }
  lines.push('}');
  lines.push('');
  lines.push('func AIErrorByCode(code string) (AIErrorSpec, bool) {');
  lines.push('\tfor _, item := range AIErrorTaxonomy {');
  lines.push('\t\tif item.Code == code {');
  lines.push('\t\t\treturn item, true');
  lines.push('\t\t}');
  lines.push('\t}');
  lines.push('\treturn AIErrorSpec{}, false');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

function kotlinEnum(item) {
  const lines = ['enum class ' + item.kind + '(val wire: String) {'];
  item.values.forEach((value, index) => {
    const comma = index === item.values.length - 1 ? ';' : ',';
    lines.push('    ' + ktConst(value) + '(' + quote(value) + ')' + comma);
  });
  lines.push('    companion object {');
  lines.push('        fun fromWire(value: String): ' + item.kind + ' =');
  lines.push('            entries.firstOrNull { it.wire == value } ?: throw IllegalArgumentException("' + item.kind + ' has unsupported value: $value")');
  lines.push('    }');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

function kotlinSource() {
  const taxonomy = errorTaxonomy();
  const lines = [];
  lines.push('// GENERATED FILE - DO NOT EDIT.');
  lines.push('// Source: contracts/ai/v2. Regenerate with `node scripts/generate-ai-contracts.mjs`.');
  lines.push('');
  lines.push('package one.zephyr.mobile.contracts.aiv2');
  lines.push('');
  lines.push('const val AI_CONTRACT_SCHEMA_VERSION: Int = 2');
  lines.push('');
  for (const item of ENUMS) lines.push(kotlinEnum(item));
  lines.push('data class AIErrorSpec(');
  lines.push('    val code: String,');
  lines.push('    val httpStatus: Int,');
  lines.push('    val retryable: Boolean,');
  lines.push('    val clientAction: AIClientAction,');
  lines.push(')');
  lines.push('');
  lines.push('object AIErrorTaxonomy {');
  lines.push('    const val VERSION: Int = 2');
  lines.push('    val errors: List<AIErrorSpec> = listOf(');
  for (const item of taxonomy.errors) {
    lines.push('        AIErrorSpec(' + quote(item.code) + ', ' + item.httpStatus + ', ' + item.retryable + ', AIClientAction.' + ktConst(item.clientAction) + '),');
  }
  lines.push('    )');
  lines.push('');
  lines.push('    fun byCode(code: String): AIErrorSpec =');
  lines.push('        errors.firstOrNull { it.code == code } ?: throw IllegalArgumentException("unknown AI error code: $code")');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

function swiftEnum(item) {
  const lines = ['public enum ' + item.kind + ': String, Sendable, CaseIterable, Codable {'];
  for (const value of item.values) lines.push('    case ' + swiftCase(value) + ' = ' + quote(value));
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

function swiftSource() {
  const taxonomy = errorTaxonomy();
  const lines = [];
  lines.push('// GENERATED FILE - DO NOT EDIT.');
  lines.push('// Source: contracts/ai/v2. Regenerate with `node scripts/generate-ai-contracts.mjs`.');
  lines.push('');
  lines.push('import Foundation');
  lines.push('');
  lines.push('public enum AIContractV2 {');
  lines.push('    public static let schemaVersion = 2');
  lines.push('}');
  lines.push('');
  for (const item of ENUMS) lines.push(swiftEnum(item));
  lines.push('public struct AIErrorSpec: Sendable, Equatable, Codable {');
  lines.push('    public let code: String');
  lines.push('    public let httpStatus: Int');
  lines.push('    public let retryable: Bool');
  lines.push('    public let clientAction: AIClientAction');
  lines.push('');
  lines.push('    public init(_ code: String, _ httpStatus: Int, _ retryable: Bool, _ clientAction: AIClientAction) {');
  lines.push('        self.code = code');
  lines.push('        self.httpStatus = httpStatus');
  lines.push('        self.retryable = retryable');
  lines.push('        self.clientAction = clientAction');
  lines.push('    }');
  lines.push('}');
  lines.push('');
  lines.push('public enum AIErrorTaxonomy {');
  lines.push('    public static let version = 2');
  lines.push('    public static let errors: [AIErrorSpec] = [');
  for (const item of taxonomy.errors) {
    lines.push('        AIErrorSpec(' + quote(item.code) + ', ' + item.httpStatus + ', ' + item.retryable + ', .' + swiftCase(item.clientAction) + '),');
  }
  lines.push('    ]');
  lines.push('');
  lines.push('    public static func byCode(_ code: String) -> AIErrorSpec? {');
  lines.push('        errors.first { $0.code == code }');
  lines.push('    }');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

export function generatedFiles() {
  return {
    [OUT.node]: nodeSource(),
    [OUT.go]: goSource(),
    [OUT.kotlin]: kotlinSource(),
    [OUT.swift]: swiftSource(),
  };
}

function manifestFor(files) {
  const hashed = {};
  for (const [rel, body] of Object.entries(files).sort()) {
    hashed[rel] = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
  }
  return JSON.stringify({ generator: 'scripts/generate-ai-contracts.mjs', schemaVersion: 2, files: hashed }, null, 2) + '\n';
}

function main() {
  const check = process.argv.includes('--check');
  const files = generatedFiles();
  files[OUT.manifest] = manifestFor(Object.fromEntries(Object.entries(files).filter(([rel]) => rel !== OUT.manifest)));
  const drift = [];
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(REPO_ROOT, rel);
    const current = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    if (current === body) continue;
    if (check) {
      drift.push(current === null ? rel + ' (missing)' : rel + ' (stale)');
      continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  }
  if (check && drift.length) {
    console.error('AI contract artifacts are out of date:');
    for (const item of drift) console.error('  - ' + item);
    console.error('run: node scripts/generate-ai-contracts.mjs');
    process.exitCode = 1;
    return;
  }
  console.log((check ? 'checked' : 'generated') + ' ' + Object.keys(files).length + ' AI contract artifacts');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
