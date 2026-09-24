import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CONTRACT_DIR = path.join(REPO_ROOT, 'contracts', 'ai', 'v2');
export const SCHEMA_VERSION = 2;

const readJson = (name) => JSON.parse(fs.readFileSync(path.join(CONTRACT_DIR, name), 'utf8'));

export function loadSchemas() {
  const files = fs.readdirSync(CONTRACT_DIR).filter((name) => name.endsWith('.schema.json')).sort();
  const byId = new Map();
  const byFile = new Map();
  for (const file of files) {
    const schema = readJson(file);
    byFile.set(file, schema);
    byId.set(schema.$id, schema);
  }
  return { files, byId, byFile };
}

export function errorTaxonomy() {
  const taxonomy = readJson('error-taxonomy.json');
  const schema = readJson('error-taxonomy.schema.json');
  const problems = validate(taxonomy, schema, loadSchemas().byId, '');
  if (problems.length) throw new Error('error taxonomy is invalid: ' + problems.join('; '));
  const codes = taxonomy.errors.map((item) => item.code);
  if (new Set(codes).size !== codes.length) throw new Error('duplicate AI error code');
  return taxonomy;
}

function resolveRef(ref, currentId, byId) {
  const [base, pointer = ''] = ref.split('#');
  const id = base ? new URL(base, currentId).href : currentId;
  const schema = byId.get(id);
  if (!schema) throw new Error('unresolved schema id ' + id);
  if (!pointer) return schema;
  const parts = pointer.replace(/^\//, '').split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  let node = schema;
  for (const part of parts) {
    node = node?.[part];
    if (node === undefined) throw new Error('unresolved pointer ' + ref);
  }
  return { ...node, $id: schema.$id, $anchor: pointer };
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value, type) {
  const types = Array.isArray(type) ? type : [type];
  return types.some((expected) => {
    if (expected === 'integer') return typeof value === 'number' && Number.isInteger(value);
    return typeOf(value) === expected;
  });
}

export function validate(value, schema, byId, pathName = '', baseId = null) {
  const id = schema.$id || baseId || 'https://zephyr.local/contracts/ai/v2/common.schema.json';
  if (schema.$ref) return validate(value, resolveRef(schema.$ref, id, byId), byId, pathName, id);
  const problems = [];
  if (schema.oneOf) {
    const matched = schema.oneOf.filter((branch) => validate(value, branch, byId, pathName, id).length === 0);
    if (matched.length !== 1) problems.push(pathName + ' must match exactly one variant');
    return problems;
  }
  if (schema.const !== undefined && value !== schema.const) problems.push(pathName + ' must equal ' + JSON.stringify(schema.const));
  if (schema.enum && !schema.enum.includes(value)) problems.push(pathName + ' must be one of ' + schema.enum.join(','));
  if (schema.type && !matchesType(value, schema.type)) {
    problems.push(pathName + ' has wrong type');
    return problems;
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) problems.push(pathName + ' is too short');
    if (schema.maxLength !== undefined && value.length > schema.maxLength) problems.push(pathName + ' is too long');
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) problems.push(pathName + ' does not match ' + schema.pattern);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) problems.push(pathName + ' is below minimum');
    if (schema.maximum !== undefined && value > schema.maximum) problems.push(pathName + ' is above maximum');
    if (schema.type === 'integer' && !Number.isInteger(value)) problems.push(pathName + ' must be an integer');
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) problems.push(pathName + ' has too few items');
    if (schema.maxItems !== undefined && value.length > schema.maxItems) problems.push(pathName + ' has too many items');
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) problems.push(pathName + ' has duplicate items');
    if (schema.items) value.forEach((item, index) => problems.push(...validate(item, { ...schema.items, $id: schema.items.$id || id }, byId, pathName + '[' + index + ']', id)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (schema.additionalProperties === false && !schema.$anchor) {
      for (const key of Object.keys(value)) {
        if (!schema.properties?.[key]) problems.push(pathName + '.' + key + ' is not allowed');
      }
    }
    for (const key of schema.required || []) {
      if (!(key in value)) problems.push(pathName + '.' + key + ' is required');
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (key in value) problems.push(...validate(value[key], { ...child, $id: child.$id || id }, byId, pathName + '.' + key, id));
    }
  }
  for (const branch of schema.allOf || []) problems.push(...validate(value, branch, byId, pathName, id));
  if (schema.if && validate(value, schema.if, byId, pathName, id).length === 0 && schema.then) {
    problems.push(...validate(value, schema.then, byId, pathName, id));
  }
  return problems;
}

export function schemaFor(file) {
  const { byId, byFile } = loadSchemas();
  return { schema: byFile.get(file), byId };
}

function canonicalize(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalize(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function canonicalJson(value) {
  return canonicalize(value);
}
