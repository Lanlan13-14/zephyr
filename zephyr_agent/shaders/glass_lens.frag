precision mediump float;

#include <flutter/runtime_effect.glsl>

// Liquid-glass lens for the LiquidToggle thumb, after Kyant0/AndroidLiquidGlass
// lens(): a capsule-shaped height field bends the sampled backdrop inward
// toward the rim, with a slight chromatic split on the bend band.
//
// uSize        – thumb size in px
// uRadius      – capsule corner radius (= thumbHeight / 2)
// uRefrHeight  – rim band height that refracts (px)
// uRefrAmount  – max bend distance (px)
// uChroma      – chromatic aberration strength (0 = off)

uniform vec2 uSize;
uniform float uRadius;
uniform float uRefrHeight;
uniform float uRefrAmount;
uniform float uChroma;
uniform sampler2D uTexture;

out vec4 fragColor;

float sdCapsule(vec2 p, vec2 halfSize, float r) {
  vec2 q = abs(p - halfSize) - (halfSize - vec2(r));
  return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  vec2 fragCoord = FlutterFragCoord().xy;
  vec2 uv = fragCoord / uSize;

  float dist = -sdCapsule(fragCoord, uSize * 0.5, uRadius);
  float band = clamp(dist / max(uRefrHeight, 0.001), 0.0, 1.0);
  // Smoothstep falloff: full bend at the edge, none past the rim band.
  float bend = (1.0 - band) * (1.0 - band) * (3.0 - 2.0 * (1.0 - band));

  // Bend direction: toward the capsule center.
  vec2 center = uSize * 0.5;
  vec2 dir = normalize(center - fragCoord + vec2(1e-4));

  vec2 offset = dir * bend * uRefrAmount / uSize;
  vec2 chroma = dir * (bend * uChroma) / uSize;

  vec4 c;
  c.r = texture(uTexture, uv + offset + chroma).r;
  c.g = texture(uTexture, uv + offset).g;
  c.b = texture(uTexture, uv + offset - chroma).b;
  c.a = 1.0;
  fragColor = c;
}
