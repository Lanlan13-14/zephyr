'use strict';
/*
 * ai-contract-errors.js - Node compatibility adapter over the generated
 * Contract v2 error taxonomy. Centralizes the retryable/terminal decision so
 * every Node caller branches on `code`, never on message text.
 *
 * Contract source: contracts/ai/v2/error-taxonomy.json via
 * src/generated/ai-contract-v2.js. Do not fork the code list here.
 */
const { AI_ERROR_TAXONOMY, aiErrorSpec, isRetryableAIError } = require('./src/generated/ai-contract-v2');

/** Map an upstream/transport failure to the closest contract error code. */
function classifyUpstreamError(error) {
    const message = String((error && error.message) || error || '').toLowerCase();
    if (/abort|cancel|signal/.test(message)) return 'ai_cancelled';
    if (/eai_again|no such host|enotfound|getaddrinfo|dns/.test(message)) return 'ai_dns_failed';
    if (/certificate|hostname|sni|tls/.test(message)) return 'ai_tls_hostname_mismatch';
    if (/unauthorized|401|forbidden|403|invalid_api_key|incorrect api key/.test(message)) return 'ai_auth_failed';
    if (/429|rate.?limit|quota.*exceed|insufficient_quota/.test(message)) return 'ai_rate_limited';
    if (/context.?length|maximum context|too many tokens|tokens exceed/.test(message)) return 'ai_context_length_exceeded';
    if (/content.?filter|safety|blocked.*prompt|policy violation/.test(message)) return 'ai_content_filtered';
    if (/timeout|timed out|deadline/.test(message)) return 'ai_tool_timeout';
    if (/500|502|503|504|overloaded|unavailable|bad gateway|service unavailable/.test(message)) return 'ai_upstream_unavailable';
    return 'ai_upstream_unavailable';
}

function toContractError(error, fallbackCode) {
    const code = (error && error.code && AI_ERROR_TAXONOMY.errors.some((item) => item.code === error.code))
        ? error.code
        : (fallbackCode || classifyUpstreamError(error));
    const spec = aiErrorSpec(code);
    const out = new Error((error && error.message) || spec.code);
    out.code = code;
    out.httpStatus = spec.httpStatus;
    out.retryable = spec.retryable;
    out.clientAction = spec.clientAction;
    return out;
}

module.exports = { AI_ERROR_TAXONOMY, aiErrorSpec, isRetryableAIError, classifyUpstreamError, toContractError };
