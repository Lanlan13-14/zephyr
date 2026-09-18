precision mediump float;

#include <flutter/runtime_effect.glsl>

// Rounded-rect refraction, 1:1 after Kyant
// RoundedRectRefractionWithDispersionShaderString (AGSL), ported to Flutter
// runtime_effect.glsl. The only behavioral change is the texture source:
// Kyant samples its own backdrop layer (`uniform shader content`); Flutter
// samples the BackdropFilter snapshot through uTexture because the filter
// input IS the backdrop.
//
// uTexture   – backdrop snapshot (BackdopFilter input)
// uSize      – surface size in px
// uRadius    – capsule corner radius (= height / 2)
// uRefrHeight – rim band height that refracts (px)
// uRefrAmount – max bend distance (px)
// uChroma    – chromatic aberration strength (0 = off)
//
// uSize/uRadius let one shader serve capsules and rounded rects by
// construction: a capsule IS a rounded rect with radius = halfHeight.
// Padding/clip differences between BackdropFilter and Compose are absorbed
// by putting geometry padding outside this shader (per-widget BackdropFilter
// on an exactly-sized box), so coord/uSize stay in the same space.

// NOTE: Flutter runtime_effect reserves sampler slots by declaration order
// after the uniforms; Dart passes sampler implicitly via ImageFilter.shader,
// so NO setFloat slot is consumed by uTexture (floats are slots 0..5 only).
uniform vec2 uSize;
uniform float uRadius;
uniform float uRefrHeight;
uniform float uRefrAmount;
uniform float uChroma;
uniform sampler2D uTexture;

out vec4 fragColor;

// Same SDF as Kyant RoundedRectSDF with uniform radius.
float sdRoundedRect(vec2 coord, vec2 halfSize, float radius) {
  vec2 q = abs(coord) - (halfSize - vec2(radius));
  return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - radius;
}

// Gradient of the SDF = surface normal (Kyant gradSdRoundedRect, uniform-radius path).
vec2 gradSd(vec2 coord, vec2 halfSize, float radius) {
  vec2 q = abs(coord) - (halfSize - vec2(radius));
  if (q.x >= 0.0 || q.y >= 0.0) {
    // Guard the zero-length corner gradient (Kyant relies on AGSL normalize()
    // of vec2(0,0) being undefined; GLSL normalize(0) is also undefined).
    vec2 m = max(q, vec2(0.0));
    float len = length(m);
    if (len < 1e-4) return sign(coord);
    return sign(coord) * (m / len);
  }
  float gx = step(q.y, q.x);
  return sign(coord) * vec2(gx, 1.0 - gx);
}

// Kyant circleMap: 1 - sqrt(1 - x^2).
float circleMap(float x) {
  return 1.0 - sqrt(max(0.0, 1.0 - x * x));
}

void main() {
  vec2 fragCoord = FlutterFragCoord().xy;
  vec2 halfSize = uSize * 0.5;
  vec2 centered = fragCoord - halfSize;
  vec2 uv = fragCoord / uSize;

  // Inside-positive SDF so the band math matches Kyant's `-sd` convention.
  float sd = sdRoundedRect(centered, halfSize, uRadius);
  float inside = -sd;
  if (inside >= uRefrHeight) {
    fragColor = texture(uTexture, uv);
    return;
  }
  float clamped = max(inside, 0.0);

  // Bend peaks at the rim and falls to zero one band inward.
  float d = circleMap(1.0 - clamped / max(uRefrHeight, 1e-3)) * uRefrAmount;

  // Kyant gradRadius = min(radius * 1.5, min(halfSize)).
  float gradRadius = min(uRadius * 1.5, min(halfSize.x, halfSize.y));
  vec2 grad = gradSd(centered, halfSize, gradRadius);
  float glen = length(grad);
  grad = glen > 1e-4 ? grad / glen : vec2(0.0);

  // Refraction amount is positive inward toward the center, like Kyant's
  // negative-refraction convention after the sign flip: d * grad points
  // outward, so subtract.
  vec2 sampleUv = (fragCoord - d * grad) / uSize;

  // Kyant WaterDispersion: dispersion weight grows with |x*y| of the fragment.
  float disp = uChroma * ((centered.x * centered.y) / max(halfSize.x * halfSize.y, 1e-3));
  vec2 spread = d * grad * disp / max(uSize, vec2(1e-3));

  vec4 col = vec4(0.0);
  vec4 red = texture(sampleUv + spread);
  col.r += red.r / 3.5;
  col.a += red.a / 7.0;
  vec4 orange = texture(sampleUv + spread * (2.0 / 3.0));
  col.r += orange.r / 3.5;
  col.g += orange.g / 7.0;
  col.a += orange.a / 7.0;
  vec4 yellow = texture(sampleUv + spread * (1.0 / 3.0));
  col.r += yellow.r / 3.5;
  col.g += yellow.g / 3.5;
  col.a += yellow.a / 7.0;
  vec4 green = texture(sampleUv);
  col.g += green.g / 3.5;
  col.a += green.a / 7.0;
  vec4 cyan = texture(sampleUv - spread * (1.0 / 3.0));
  col.g += cyan.g / 3.5;
  col.b += cyan.b / 3.0;
  col.a += cyan.a / 7.0;
  vec4 blue = texture(sampleUv - spread * (2.0 / 3.0));
  col.b += blue.b / 3.0;
  col.a += blue.a / 7.0;
  vec4 purple = texture(sampleUv - spread);
  col.r += purple.r / 7.0;
  col.b += purple.b / 3.0;
  col.a += purple.a / 7.0;

  fragColor = col;
}
