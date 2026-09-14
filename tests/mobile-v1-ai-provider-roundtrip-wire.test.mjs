'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { safePatch } = require(path.join(root, 'mobile-v1-ai-provider-entities.js'));

/**
 * The closing half of the AI provider round-trip contract.
 *
 * The Kotlin suite (AiProviderRoundTripTest) runs the real One production mapping chain
 * (aiProvider -> toLocal -> toModel -> aiProviderValues) over a matrix of legal main-end
 * projections and exports the payloads it would push to
 * zephyr_one/mobile/android/core-data/src/test/resources/roundtrip/ai-provider-pushes.json.
 *
 * This suite replays every exported payload through the main end's real canonical validator
 * (safePatch). If any segment of the five-part mapping drifts -- a dropped field, a defaulted
 * enum, a rewritten apiMode -- the replay rejects here with the case name instead of a real
 * device surfacing invalid_ai_provider on a push.
 */

const FIXTURE = path.join(
    root,
    'zephyr_one', 'mobile', 'android', 'core-data', 'src', 'test', 'resources', 'roundtrip', 'ai-provider-pushes.json',
);

test('round-trip wire fixture exists and is committed', () => {
    assert.ok(fs.existsSync(FIXTURE), 'fixture missing: run the Kotlin AiProviderRoundTripTest and commit its export');
});

test('every pushed One payload passes the main end canonical validator', () => {
    const raw = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const cases = raw && typeof raw === 'object' && raw.cases ? raw.cases : null;
    assert.ok(cases && typeof cases === 'object', 'fixture must carry a cases object');
    const names = Object.keys(cases);
    assert.ok(names.length >= 5, `expected the matrix cases, got ${names.length}`);

    for (const name of names) {
        const pushed = cases[name];
        assert.ok(pushed && typeof pushed === 'object', `case ${name}: payload missing`);
        const accepted = safePatch(pushed, null);
        assert.ok(accepted, `case ${name}: safePatch returned nothing`);
        assert.equal(
            accepted.config.apiMode,
            pushed.config.apiMode,
            `case ${name}: apiMode drifted through validation`,
        );
        if (pushed.config.options && pushed.config.options.context) {
            assert.ok(
                accepted.config.options.context &&
                    accepted.config.options.context.windowTokens > 0,
                `case ${name}: context window lost through validation`,
            );
        }
        const pushedOptions = pushed.config.options || {};
        for (const field of ['temperature', 'top_p', 'max_tokens', 'max_output_tokens', 'presence_penalty', 'frequency_penalty']) {
            if (Object.prototype.hasOwnProperty.call(pushedOptions, field)) {
                assert.ok(
                    Object.prototype.hasOwnProperty.call(accepted.config.options, field) &&
                        Number.isFinite(accepted.config.options[field]),
                    `case ${name}: option ${field} lost through validation`,
                );
            }
        }
        if (Array.isArray(pushed.models)) {
            assert.ok(Array.isArray(accepted.models), `case ${name}: models array lost through validation`);
            assert.equal(accepted.models.length, pushed.models.length, `case ${name}: model count changed through validation`);
            for (const model of accepted.models) {
                assert.ok(model && typeof model.id === 'string' && model.id.trim(), `case ${name}: blank model id survived validation`);
            }
        }
    }
});

test('no exported payload carries the retired native apiMode', () => {
    const raw = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    for (const [name, pushed] of Object.entries(raw.cases || {})) {
        assert.notEqual(
            pushed.config && pushed.config.apiMode,
            'native',
            `case ${name}: the retired native apiMode must never be pushed`,
        );
    }
});