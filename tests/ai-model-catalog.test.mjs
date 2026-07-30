import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeModels,
  mergeModelList,
  findModelEntry,
  modelAcceptsImage,
  selectableModelIds,
} from '../ai-model-catalog.js';
import ThinkingPolicy from '../public/ai-thinking-policy.js';

const {
  declaredMaxLevel,
  effectiveMaxLevel,
  openAIWireLevel,
  optionsForProvider,
  rejectedThinkingLevel,
  sanitizeThinkingOptions,
} = ThinkingPolicy;

test('legacy string models migrate to ModelEntry with provider vision default', () => {
  const models = normalizeModels(['gpt-a', 'gpt-b'], { providerVisionDefault: true });
  assert.equal(models.length, 2);
  assert.equal(models[0].id, 'gpt-a');
  assert.equal(models[0].input.image, true);
  assert.equal(models[0].input.pdf, false);
  assert.equal(models[1].label, 'gpt-b');
});

test('legacy string GPT-5 models infer reasoning capability', () => {
  const [entry] = normalizeModels(['gpt-5.6-luna']);
  assert.equal(entry.reasoning, true);
  assert.equal(entry.reasoningConfigured, false);
});

test('legacy string models inherit vision=false default', () => {
  const models = normalizeModels('text-only-1\ntext-only-2', { providerVisionDefault: false });
  assert.equal(models.every((m) => m.input.image === false), true);
});

test('mergeModelList preserves existing modality config', () => {
  const existing = normalizeModels([
    { id: 'keep', input: { image: false, pdf: true, audio: false, video: false }, hidden: true },
  ]);
  const merged = mergeModelList(existing, ['keep', 'new-model'], { providerVisionDefault: true });
  const keep = merged.find((m) => m.id === 'keep');
  const neu = merged.find((m) => m.id === 'new-model');
  assert.equal(keep.input.image, false);
  assert.equal(keep.input.pdf, true);
  assert.equal(keep.hidden, true);
  assert.equal(neu.input.image, true);
  assert.deepEqual(merged.map((m) => m.id), ['keep', 'new-model']);
});

test('modelAcceptsImage prefers entry over provider vision', () => {
  const provider = {
    options: { vision: true },
    models: [
      { id: 'no-img', input: { image: false, pdf: false, audio: false, video: false } },
      { id: 'yes-img', input: { image: true, pdf: false, audio: false, video: false } },
    ],
  };
  assert.equal(modelAcceptsImage(provider, 'no-img'), false);
  assert.equal(modelAcceptsImage(provider, 'yes-img'), true);
});

test('selectableModelIds hides hidden models', () => {
  const provider = {
    models: [
      { id: 'visible', hidden: false },
      { id: 'ghost', hidden: true },
    ],
  };
  assert.deepEqual(selectableModelIds(provider), ['visible']);
  assert.equal(findModelEntry(provider.models, 'ghost')?.hidden, true);
});

test('legacy fetched GPT-5 models infer reasoning instead of staying false', () => {
  const [entry] = normalizeModels([{ id: 'gpt-5.6-luna', reasoning: false }]);
  assert.equal(entry.reasoning, true);
  assert.equal(entry.reasoningConfigured, false);
  assert.equal(effectiveMaxLevel({ models: [entry] }, entry.id), 'max');
});

test('explicitly disabled reasoning remains a hard capability gate', () => {
  const [entry] = normalizeModels([{ id: 'gpt-5.6-luna', reasoning: false, reasoningConfigured: true }]);
  assert.equal(entry.reasoning, false);
  assert.equal(effectiveMaxLevel({ models: [entry] }, entry.id), 'none');
  assert.deepEqual(optionsForProvider({ type: 'openai-compatible', models: [entry] }, entry.id), [['', '默认']]);
});

test('OpenMinis-aligned family ceilings clamp unsupported reasoning levels', () => {
  assert.equal(declaredMaxLevel('gpt-5.6-luna'), 'max');
  assert.equal(declaredMaxLevel('gpt-5.5'), 'xhigh');
  assert.equal(declaredMaxLevel('mimo-v2.5-pro'), 'high');
  assert.equal(declaredMaxLevel('bytedance-seed/seed-2.0'), 'high');
  const provider = { type: 'openai-compatible', models: [{ id: 'mimo-v2.5-pro', reasoning: true }] };
  assert.equal(openAIWireLevel(provider, 'mimo-v2.5-pro', 'xhigh'), 'high');
  assert.equal(sanitizeThinkingOptions(provider, 'mimo-v2.5-pro', { reasoning_effort: 'xhigh' }).reasoning_effort, 'high');
});

test('responses maps effort to reasoning object while chat uses reasoning_effort', () => {
  const model = { id: 'gpt-5.6-luna', reasoning: true };
  const responses = sanitizeThinkingOptions({ type: 'openai-compatible', config: { apiMode: 'responses' }, models: [model] }, model.id, { reasoning_effort: 'max' });
  assert.deepEqual(responses.reasoning, { effort: 'max' });
  assert.equal(responses.reasoning_effort, undefined);
  const chat = sanitizeThinkingOptions({ type: 'openai-compatible', config: { apiMode: 'chat' }, models: [model] }, model.id, { reasoning: { effort: 'max' } });
  assert.equal(chat.reasoning_effort, 'max');
  assert.equal(chat.reasoning, undefined);
});

test('Anthropic and Gemini mappings stay protocol-specific', () => {
  const claude = { type: 'anthropic', models: [{ id: 'claude-opus-4-8', reasoning: true }] };
  const claudeOptions = sanitizeThinkingOptions(claude, 'claude-opus-4-8', { effort: 'xhigh' });
  assert.equal(claudeOptions.effort, 'max');
  assert.equal(claudeOptions.output_config.effort, 'max');
  const gemini = { type: 'gemini', models: [{ id: 'gemini-2.5-pro', reasoning: true }] };
  assert.deepEqual(sanitizeThinkingOptions(gemini, 'gemini-2.5-pro', { thinkingConfig: { thinkingLevel: 'xhigh' } }).thinkingConfig, { thinkingBudget: 8192 });
});

test('reasoning rejection parser detects unsupported value for downgrade retry', () => {
  assert.equal(rejectedThinkingLevel(new Error('Invalid reasoning_effort: xhigh')), 'xhigh');
  assert.equal(rejectedThinkingLevel(new Error('Unsupported value: max for reasoning.effort')), 'max');
  assert.equal(rejectedThinkingLevel(new Error('temperature unsupported')), '');
});
