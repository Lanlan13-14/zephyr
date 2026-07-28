import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeModels,
  mergeModelList,
  findModelEntry,
  modelAcceptsImage,
  selectableModelIds,
} from '../ai-model-catalog.js';

test('legacy string models migrate to ModelEntry with provider vision default', () => {
  const models = normalizeModels(['gpt-a', 'gpt-b'], { providerVisionDefault: true });
  assert.equal(models.length, 2);
  assert.equal(models[0].id, 'gpt-a');
  assert.equal(models[0].input.image, true);
  assert.equal(models[0].input.pdf, false);
  assert.equal(models[1].label, 'gpt-b');
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
