'use strict';

const Ajv = require('ajv');
const { executionPolicyForTool } = require('./ai-capabilities');

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map();

function validatorFor(toolId, schema) {
    const key = String(toolId || '');
    const cached = validators.get(key);
    if (cached && cached.schema === schema) return cached.validate;
    const validate = ajv.compile(schema || { type: 'object', additionalProperties: false });
    validators.set(key, { schema, validate });
    return validate;
}

function validationError(validate) {
    const first = Array.isArray(validate.errors) ? validate.errors[0] : null;
    const field = first?.instancePath || first?.params?.missingProperty || '';
    const error = new Error(first?.message ? `参数无效：${first.message}` : '参数无效');
    error.code = 'invalid_tool_arguments';
    error.field = field;
    error.retryable = false;
    return error;
}

function toToolResult(toolId, policy, value, durationMs) {
    if (value && typeof value === 'object' && value.ok === true && value.meta) {
        return {
            ...value,
            meta: {
                ...value.meta,
                tool: String(value.meta.tool || toolId),
                capabilityId: policy.capabilityId,
                risk: policy.risk,
                durationMs,
            },
        };
    }
    return {
        ok: true,
        data: value === undefined ? null : value,
        meta: {
            tool: toolId,
            capabilityId: policy.capabilityId,
            risk: policy.risk,
            durationMs,
        },
    };
}

async function executeCanonicalTool({ toolId, schema, args, ctx, authorize, execute }) {
    const policy = executionPolicyForTool(toolId);
    if (!policy) return execute();

    const input = args === undefined ? {} : args;
    const validate = validatorFor(toolId, schema);
    if (!validate(input)) throw validationError(validate);
    if (typeof authorize === 'function') await authorize();
    if (policy.confirmation === 'always' && ctx?.confirmedToolId !== toolId) {
        return ctx.requireConfirmation();
    }

    const startedAt = Date.now();
    const value = await execute();
    return toToolResult(toolId, policy, value, Date.now() - startedAt);
}

module.exports = {
    executeCanonicalTool,
};
