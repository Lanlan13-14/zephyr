import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MOBILE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID_ROOT = path.join(MOBILE_ROOT, 'android');
const GLASS_ROOT = path.join(ANDROID_ROOT, 'core-ui', 'src', 'main', 'kotlin', 'one', 'zephyr', 'mobile', 'ui', 'glass');

function readSource(rel) {
  return fs.readFileSync(path.join(ANDROID_ROOT, rel), 'utf8');
}

test('Liquid Glass source files exist in core-ui', () => {
  const expectedFiles = [
    'Backdrop.kt',
    'BackdropEffectScope.kt',
    'DrawBackdropModifier.kt',
    'Effects.kt',
    'Highlight.kt',
    'Internal.kt',
    'LiquidGlass.kt',
    'Platform.kt',
    'RuntimeShader.kt',
    'Shadow.kt',
    'Shaders.kt',
  ];

  for (const file of expectedFiles) {
    const fullPath = path.join(GLASS_ROOT, file);
    assert.ok(fs.existsSync(fullPath), `Missing Liquid Glass file: ${file}`);
    const stat = fs.statSync(fullPath);
    assert.ok(stat.size > 100, `${file} should not be empty`);
  }
});

test('Liquid Glass declares Backdrop, LayerBackdrop and LocalBackdrop', () => {
  const backdropSource = fs.readFileSync(path.join(GLASS_ROOT, 'Backdrop.kt'), 'utf8');
  assert.ok(backdropSource.includes('interface Backdrop'));
  assert.ok(backdropSource.includes('class LayerBackdrop'));
  assert.ok(backdropSource.includes('fun rememberLayerBackdrop'));
  assert.ok(backdropSource.includes('val LocalBackdrop = staticCompositionLocalOf<Backdrop>'));
  assert.ok(backdropSource.includes('fun Modifier.layerBackdrop'));
});

test('Liquid Glass declares AGSL runtime shaders and SDF refraction', () => {
  const shaderSource = fs.readFileSync(path.join(GLASS_ROOT, 'Shaders.kt'), 'utf8');
  assert.ok(shaderSource.includes('RoundedRectRefractionShaderString'));
  assert.ok(shaderSource.includes('RoundedRectRefractionWithDispersionShaderString'));
  assert.ok(shaderSource.includes('DefaultHighlightShaderString'));
  assert.ok(shaderSource.includes('AmbientHighlightShaderString'));
  assert.ok(shaderSource.includes('sdRoundedRect'));
  assert.ok(shaderSource.includes('gradSdRoundedRect'));
  assert.ok(shaderSource.includes('chromaticAberration'));
});

test('Liquid Glass modifiers and high-level components are declared', () => {
  const liquidSource = fs.readFileSync(path.join(GLASS_ROOT, 'LiquidGlass.kt'), 'utf8');
  assert.ok(liquidSource.includes('fun Modifier.liquidGlass'));
  assert.ok(liquidSource.includes('fun LiquidButton'));
  assert.ok(liquidSource.includes('fun LiquidSurface'));
  assert.ok(liquidSource.includes('fun Capsule()'));

  const drawModifierSource = fs.readFileSync(path.join(GLASS_ROOT, 'DrawBackdropModifier.kt'), 'utf8');
  assert.ok(drawModifierSource.includes('fun Modifier.drawBackdrop'));
  assert.ok(drawModifierSource.includes('fun Modifier.drawPlainBackdrop'));
});

test('FloatingIsland integrates Liquid Glass with backdrop sampling and refraction', () => {
  const islandSource = readSource('core-ui/src/main/kotlin/one/zephyr/mobile/ui/island/FloatingIsland.kt');
  assert.ok(islandSource.includes('one.zephyr.mobile.ui.glass.drawBackdrop'));
  assert.ok(islandSource.includes('one.zephyr.mobile.ui.glass.LocalBackdrop'));
  assert.ok(islandSource.includes('lens('));
  assert.ok(islandSource.includes('vibrancy()'));
  assert.ok(islandSource.includes('chromaticAberration = true'));
  assert.ok(islandSource.includes('Highlight.Default'));
  assert.ok(
    islandSource.includes('palette.surfaces.floating.copy(alpha = if (palette.dark) 0.22f else 0.28f)'),
    'island surface tint must stay translucent enough to show the sampled backdrop',
  );
  assert.ok(
    islandSource.includes('palette.islandSelection.copy(alpha = 0.32f)'),
    'selected pill tint must stay translucent enough to show the sampled backdrop',
  );
  assert.equal(
    islandSource.includes('0.82f') || islandSource.includes('0.90f') || islandSource.includes('0.72f'),
    false,
    'opaque island tints hide liquid glass',
  );
});

test('LayerBackdrop invalidates glass consumers after each recorded frame', () => {
  const backdrop = fs.readFileSync(path.join(GLASS_ROOT, 'Backdrop.kt'), 'utf8');
  assert.ok(backdrop.includes('recordGeneration'));
  assert.ok(backdrop.includes('fun notifyRecorded()'));
  assert.ok(backdrop.includes('backdrop.notifyRecorded()'));
});

test('ZephyrOneRoot establishes root Backdrop and propagates LocalBackdrop', () => {
  const rootSource = readSource('app/src/main/kotlin/one/zephyr/mobile/app/ZephyrOneRoot.kt');
  assert.ok(rootSource.includes('one.zephyr.mobile.ui.glass.rememberLayerBackdrop'));
  assert.ok(rootSource.includes('one.zephyr.mobile.ui.glass.LocalBackdrop'));
  assert.ok(rootSource.includes('one.zephyr.mobile.ui.glass.layerBackdrop'));
  assert.ok(rootSource.includes('rememberLayerBackdrop()'));
  assert.ok(rootSource.includes('LocalBackdrop provides'));
});

test('AGSL shaders use safeNormalize and skip a 0x0 first frame', () => {
  const shaderSource = fs.readFileSync(path.join(GLASS_ROOT, 'Shaders.kt'), 'utf8');
  assert.ok(shaderSource.includes('float2 safeNormalize(float2 v)'));
  assert.ok(shaderSource.includes('if (size.x < 1.0 || size.y < 1.0)'));
  assert.ok(shaderSource.includes('Adreno'));
  const agslBodies = [...shaderSource.matchAll(/"""([\s\S]*?)"""/g)].map((m) => m[1]);
  assert.ok(agslBodies.length >= 3, 'expected AGSL string bodies');
  for (const body of agslBodies) {
    assert.equal((body.match(/(?<!safe)normalize\s*\(/g) || []).length, 0);
  }
});

test('glass GPU path can disable itself instead of crashing composition', () => {
  const platform = fs.readFileSync(path.join(GLASS_ROOT, 'Platform.kt'), 'utf8');
  assert.ok(platform.includes('object GlassRuntime'));
  assert.ok(platform.includes('fun disableShaders'));
  assert.ok(platform.includes('fun disableEffects'));

  const runtime = fs.readFileSync(path.join(GLASS_ROOT, 'RuntimeShader.kt'), 'utf8');
  assert.ok(runtime.includes('GlassRuntime.disableShaders()'));
  assert.ok(runtime.includes('NoOpRuntimeShader'));

  const internal = fs.readFileSync(path.join(GLASS_ROOT, 'Internal.kt'), 'utf8');
  assert.ok(internal.includes('if (size.width <= 0 || size.height <= 0) return false'));
  assert.ok(internal.includes('GlassRuntime.disableEffects()'));

  const draw = fs.readFileSync(path.join(GLASS_ROOT, 'DrawBackdropModifier.kt'), 'utf8');
  assert.ok(draw.includes('GlassRuntime.disableEffects()'));
  assert.ok(draw.includes('backdrop draw failed; glass disabled'));
});

test('All Liquid Glass Kotlin sources are pure ASCII', () => {
  const files = fs.readdirSync(GLASS_ROOT).filter((f) => f.endsWith('.kt'));
  for (const file of files) {
    const raw = fs.readFileSync(path.join(GLASS_ROOT, file), 'utf8');
    for (let i = 0; i < raw.length; i++) {
      const code = raw.charCodeAt(i);
      assert.ok(
        code <= 127,
        `Non-ASCII character (code ${code}) in ${file} at position ${i}`,
      );
    }
  }
});
