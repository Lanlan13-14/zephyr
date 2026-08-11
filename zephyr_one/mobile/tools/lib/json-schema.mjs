// Minimal JSON Schema 2020-12 validator covering the keywords used by mobile contracts.
// Deliberately small: contract drift should fail loudly instead of pulling a runtime dependency.
import fs from 'node:fs';
import path from 'node:path';
import { CONTRACTS_ROOT } from './contracts.mjs';

const cache = new Map();

function loadSchemaFile(relOrId) {
  const file = path.join(CONTRACTS_ROOT, 'schemas', path.basename(relOrId));
  if (!cache.has(file)) cache.set(file, JSON.parse(fs.readFileSync(file, 'utf8')));
  return cache.get(file);
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  if (typeof value === 'number') return 'number';
  return typeof value;
}

function typeMatches(expected, value) {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return expected === actual;
}

function pushError(errors, instancePath, message) {
  errors.push({ instancePath: instancePath || '/', message });
}

function validateNode(schema, value, instancePath, errors) {
  if (schema === true || schema === undefined) return;
  if (schema === false) return pushError(errors, instancePath, 'schema forbids any value');
  if (schema.$ref) return validateNode(loadSchemaFile(schema.$ref), value, instancePath, errors);

  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!expected.some((t) => typeMatches(t, value))) {
      pushError(errors, instancePath, `expected type ${expected.join('|')} but received ${typeOf(value)}`);
      return;
    }
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    pushError(errors, instancePath, `expected const ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((c) => JSON.stringify(c) === JSON.stringify(value))) {
    pushError(errors, instancePath, `value not in enum ${JSON.stringify(schema.enum)}`);
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      pushError(errors, instancePath, `shorter than minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      pushError(errors, instancePath, `longer than maxLength ${schema.maxLength}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) {
      pushError(errors, instancePath, `does not match pattern ${schema.pattern}`);
    }
    if (schema.contentEncoding === 'base64' && !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
      pushError(errors, instancePath, 'not standard base64');
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      pushError(errors, instancePath, `below minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      pushError(errors, instancePath, `above maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      pushError(errors, instancePath, `fewer than minItems ${schema.minItems}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      pushError(errors, instancePath, `more than maxItems ${schema.maxItems}`);
    }
    if (schema.uniqueItems) {
      const seen = new Set(value.map((v) => JSON.stringify(v)));
      if (seen.size !== value.length) pushError(errors, instancePath, 'array items are not unique');
    }
    if (schema.items) {
      value.forEach((item, index) => validateNode(schema.items, item, `${instancePath}/${index}`, errors));
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    for (const required of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) {
        pushError(errors, instancePath, `missing required property ${required}`);
      }
    }
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
      pushError(errors, instancePath, `more than maxProperties ${schema.maxProperties}`);
    }
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
      pushError(errors, instancePath, `fewer than minProperties ${schema.minProperties}`);
    }
    for (const key of keys) {
      const propSchema = schema.properties?.[key];
      if (propSchema !== undefined) {
        validateNode(propSchema, value[key], `${instancePath}/${key}`, errors);
      } else if (schema.additionalProperties === false) {
        pushError(errors, instancePath, `additional property ${key} is not allowed`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validateNode(schema.additionalProperties, value[key], `${instancePath}/${key}`, errors);
      }
    }
  }

  for (const sub of schema.allOf ?? []) validateNode(sub, value, instancePath, errors);
  if (schema.anyOf) {
    const matched = schema.anyOf.some((sub) => {
      const probe = [];
      validateNode(sub, value, instancePath, probe);
      return probe.length === 0;
    });
    if (!matched) pushError(errors, instancePath, 'value does not match any anyOf branch');
  }
  if (schema.not) {
    const probe = [];
    validateNode(schema.not, value, instancePath, probe);
    if (probe.length === 0) pushError(errors, instancePath, 'value matches a forbidden schema');
  }
  if (schema.if) {
    const probe = [];
    validateNode(schema.if, value, instancePath, probe);
    const branch = probe.length === 0 ? schema.then : schema.else;
    if (branch) validateNode(branch, value, instancePath, errors);
  }
}

export function validate(schema, value) {
  const errors = [];
  validateNode(schema, value, '', errors);
  return { valid: errors.length === 0, errors };
}

export function assertValid(schema, value, label) {
  const result = validate(schema, value);
  if (!result.valid) {
    const detail = result.errors.map((e) => `${e.instancePath}: ${e.message}`).join('; ');
    throw new Error(`${label ?? 'value'} failed schema validation -> ${detail}`);
  }
}
