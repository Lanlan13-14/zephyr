import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appJs = readFileSync(path.join(root, 'public/app.js'), 'utf8');
const styleCss = readFileSync(path.join(root, 'public/style.css'), 'utf8');
const motionJs = readFileSync(path.join(root, 'public/vendor/zephyr-motion/motion.js'), 'utf8');

function extractFn(src, name) {
  const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src);
  assert.ok(m, `${name} missing`);
  const paren = src.indexOf('(', m.index);
  let parenDepth = 0;
  let brace = -1;
  for (let i = paren; i < src.length; i++) {
    if (src[i] === '(') parenDepth++;
    else if (src[i] === ')') parenDepth--;
    else if (src[i] === '{' && parenDepth === 0) { brace = i; break; }
  }
  assert.ok(brace >= 0, `${name} body missing`);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(m.index, i + 1);
  }
  throw new Error(`failed to extract ${name}`);
}

test('AI assistant panel uses only zephyr-motion semantic APIs', () => {
  const open = extractFn(appJs, 'openAiAssistantPanel');
  const close = extractFn(appJs, 'closeAiAssistantPanel');
  assert.match(open, /Motion\.aiPanelOpen\(panel, sourceButton/);
  assert.match(close, /Motion\.aiPanelClose\(panel, trigger/);
  assert.doesNotMatch(appJs, /animateAiPanelFromButton|aiMorphCssTimeToMs|captureAiMorphButton|ghostAiMorphButton|restoreAiMorphButton/);
  assert.doesNotMatch(appJs, /ai-morphing|ai-morph-open|ai-morph-closing|_aiMorph/);
});

test('legacy AI entrance keyframes and layout-property morphs are gone', () => {
  for (const old of ['aiIosFadeLift', 'aiIosPopIn', 'aiIosSlideSheet', 'aiIosTraceGlow']) {
    assert.doesNotMatch(styleCss, new RegExp(old));
    assert.doesNotMatch(motionJs, new RegExp(old));
  }
  assert.doesNotMatch(styleCss, /--ai-morph-|\.ai-agent-panel\.ai-morphing/);
  assert.doesNotMatch(styleCss, /\.ai-agent-panel\.panel-opening|\.ai-agent-panel\.panel-closing/);
  assert.doesNotMatch(styleCss, /#settings-ai[^{]*[\s\S]{0,240}?animation:\s*ai/);
  assert.doesNotMatch(styleCss, /\.ai-provider-item[\s\S]{0,220}?animation:/);
});

test('provider modal originates from the exact action button', () => {
  const listener = appJs.match(/\$\('#aiProviderList'\)\?\.addEventListener\('click',[\s\S]*?\n\s*\}\);/);
  assert.ok(listener, 'provider delegated listener missing');
  assert.match(listener[0], /closest\?\.\('\[data-ai-fetch-provider-models\],[^']+\[data-ai-edit-provider\]/);
  assert.match(listener[0], /openAiProviderModal\(ai\.providers\.find\(\(p\) => p\.id === edit\), action\)/);
  assert.match(listener[0], /revealAiProviderKey\(reveal, action\)/);
  assert.doesNotMatch(listener[0], /openAiProviderModal\([^,]+\);/);
});

test('provider modal fully expands and delegates scrolling to backdrop', () => {
  const open = extractFn(appJs, 'openAiProviderModal');
  assert.match(open, /card\.style\.overflow = 'visible'/);
  assert.match(open, /card\.style\.maxHeight = 'none'/);
  assert.match(open, /card\.style\.height = 'auto'/);
  assert.match(open, /inner\.style\.overflow = 'visible'/);
  assert.match(styleCss, /#aiProviderModal \.ai-provider-modal[\s\S]*?max-height:\s*none\s*!important/);
  assert.match(styleCss, /#aiProviderModal \.ai-provider-modal[\s\S]*?overflow:\s*visible\s*!important/);
  assert.match(styleCss, /#aiProviderModal\.aiprovider1[\s\S]*?overflow-y:\s*auto/);
});

test('AI provider source button has a single motion owner', () => {
  assert.match(styleCss, /#aiAddProviderBtn,[\s\S]*?#aiAddProviderBtn\.btn-primary:active[\s\S]*?transform:\s*none\s*!important/);
  assert.doesNotMatch(appJs, /for \(const id of \[[^\]]*'aiAddProviderBtn'/);
  assert.doesNotMatch(appJs, /#aiAddProviderBtn[^\n]*connection-pressing/);
});

test('provider mutations update provider surfaces only', () => {
  const save = extractFn(appJs, 'saveAiProvider');
  const fetchModels = extractFn(appJs, 'fetchAiModelsForProvider');
  const del = extractFn(appJs, 'deleteAiProvider');
  for (const fn of [save, fetchModels, del]) {
    assert.doesNotMatch(fn, /renderAiSettingsForm\(/);
    assert.match(fn, /renderAiProviderList\(/);
  }
  assert.match(save, /classList\.contains\('closing'\)[\s\S]*?setTimeout\(refreshProviderSurfaces, 920\)/);
  assert.doesNotMatch(save, /closeAiProviderModal\(\);\s*renderAiProviderList\(\)/);
});

test('AI picker, usage popover, and confirm sheet use zephyr-motion', () => {
  assert.match(extractFn(appJs, 'openAiPicker'), /Motion\.popover\(pop, anchor/);
  assert.match(extractFn(appJs, 'closeAiPickerPopover'), /Motion\.dismiss\(pop/);
  assert.match(extractFn(appJs, 'openAiInlineConfirm'), /Motion\.present\(card/);
  assert.match(extractFn(appJs, 'openAiInlineConfirm'), /Motion\.dismiss\(card/);
  assert.match(extractFn(appJs, 'openAiUsageSheet'), /Motion\.popover\(pop, usageAnchor/);
  assert.doesNotMatch(styleCss, /\.ai-picker-popover\.open|\.ai-inline-confirm\.open|\.ai-inline-confirm\.closing/);
});

test('state feedback loops remain CSS-only and reduced-motion aware', () => {
  assert.match(styleCss, /@keyframes ai-bounce/);
  assert.match(styleCss, /@keyframes aiRunningPulse/);
  assert.match(styleCss, /@keyframes aiStopPulse/);
  assert.match(styleCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.ai-typing-indicator span[\s\S]*?animation:\s*none\s*!important/);
});
