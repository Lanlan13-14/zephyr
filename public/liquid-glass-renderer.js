"use strict";
"use client";
var LiquidGlassWebGL = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/index.ts
  var index_exports = {};
  __export(index_exports, {
    LiquidGlassRenderer: () => LiquidGlassRenderer
  });

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/shaders/sdf.ts
  var SDF_GLSL = (
    /* glsl */
    `
// Corner style: 0 = circular (standard arc), 1 = continuous (squircle/superellipse).
// Declared here (in SDF_GLSL) because sdShape references it, and SDF_GLSL is
// included by multiple shaders (element, shadow, highlight, plain-rect).
uniform float uCornerStyle;

// --- Continuous-curvature SDF texture (capsule shape) ---
// When uUseContinuousSdf > 0.5, sdShape() dispatches to sdContinuousCurvature
// which samples a precomputed SDF texture (generated from the G2-continuous
// Bezier path in continuous-curve.ts). Only the dialog card sets this to 1;
// other shaders that include SDF_GLSL leave it at the default 0 \u2014 sdShape
// falls through to the analytic sdRoundedRect / sdContinuousRoundedRect path.
uniform sampler2D uContinuousSdf;
uniform float uUseContinuousSdf;        // 0 or 1
uniform float uNoContinuousSdfInRefraction;  // 0 or 1 \u2014 when 1, refraction/highlight SDF forces analytic sdRoundedRect (ignores uUseContinuousSdf). Mask/clip still uses uUseContinuousSdf.
uniform vec2  uContinuousSdfTexSize;    // SDF texture size in px (256, 256)
uniform vec2  uContinuousSdfElementSize; // element's original w,h in px

// radiusAt \u2014 picks the corner radius from cornerRadii based on which
// quadrant 'coord' is in. For uniform radii (the catalog case) this
// always returns the same value.
float radiusAt(vec2 coord, vec4 radii) {
    if (coord.x >= 0.0) {
        if (coord.y <= 0.0) return radii.y;
        else return radii.z;
    } else {
        if (coord.y <= 0.0) return radii.x;
        else return radii.w;
    }
}

// sdRoundedRect \u2014 signed distance to a rounded-rect boundary.
// Negative inside, positive outside, zero on the edge.
// Uses standard circular arcs for the corners.
float sdRoundedRect(vec2 coord, vec2 halfSize, float radius) {
    vec2 cornerCoord = abs(coord) - (halfSize - vec2(radius));
    float outside = length(max(cornerCoord, 0.0)) - radius;
    float inside = min(max(cornerCoord.x, cornerCoord.y), 0.0);
    return outside + inside;
}

// sdContinuousRoundedRect \u2014 continuous-curvature rounded rect.
// The original uses G2-continuous Bezier corners (ContinuousCurvatureRoundedRectangleCornerBuilder).
// The visual difference between Continuous and Circular is very subtle (only
// curvature continuity at the tangent points). For the SDF-based renderer,
// the circular arc SDF (sdRoundedRect) is a close enough approximation \u2014 the
// Bezier corners deviate from the arc by <0.5% of the radius, which is
// sub-pixel at typical element sizes.
//
// When uCornerStyle=1 (continuous), we use sdRoundedRect directly. The
// difference from the original is imperceptible. A future upgrade could
// implement exact Bezier SDF for pixel-perfect matching.
float sdContinuousRoundedRect(vec2 coord, vec2 halfSize, float radius) {
    return sdRoundedRect(coord, halfSize, radius);
}

// sampleClipMask \u2014 sample R channel (coverage) from the mask texture.
// Returns browser-native AA coverage [0,1] for clip + edgeAlpha.
float sampleClipMask(vec2 coord, vec2 halfSize, float radius) {
    float maxDim = max(max(uContinuousSdfElementSize.x, uContinuousSdfElementSize.y), 1e-4);
    float aspectW = uContinuousSdfElementSize.x / maxDim;
    float margin = 4.0;
    float drawW = (uContinuousSdfTexSize.x - 2.0 * margin) * aspectW;
    float scale = drawW / max(uContinuousSdfElementSize.x, 1e-4);
    vec2 tex = uContinuousSdfTexSize * 0.5 + coord * scale;
    vec2 uv = tex / uContinuousSdfTexSize;
    return texture2D(uContinuousSdf, uv).r;  // R = coverage [0,1]
}

// sampleClipSdf \u2014 sample G channel (SDF) from the mask texture.
// Returns signed distance: negative inside, positive outside, 0 at edge.
// Same shape as sampleClipMask (both from the same Bezier path), so clip
// and stroke shapes are always identical.
float sampleClipSdf(vec2 coord, vec2 halfSize, float radius) {
    float maxDim = max(max(uContinuousSdfElementSize.x, uContinuousSdfElementSize.y), 1e-4);
    float aspectW = uContinuousSdfElementSize.x / maxDim;
    float margin = 4.0;
    float drawW = (uContinuousSdfTexSize.x - 2.0 * margin) * aspectW;
    float scale = drawW / max(uContinuousSdfElementSize.x, 1e-4);
    vec2 tex = uContinuousSdfTexSize * 0.5 + coord * scale;
    vec2 uv = tex / uContinuousSdfTexSize;
    float g = texture2D(uContinuousSdf, uv).g;  // G = SDF [0,1]
    return (g * 2.0 - 1.0) * radius;  // decode to element-space distance
}

// sdClipShape \u2014 SDF for clip/discard when uUseContinuousSdf is OFF.
float sdClipShape(vec2 coord, vec2 halfSize, float radius) {
    return sdRoundedRect(coord, halfSize, radius);
}

// sdShape \u2014 SDF for refraction/highlight internal calculations.
// When uUseContinuousSdf=1 AND uNoContinuousSdfInRefraction=0, uses
// sampleClipSdf (same G2 shape as clip mask). Otherwise uses the analytic
// sdRoundedRect. This lets the "disable smooth SDF in glass" toggle strip
// the G2 SDF out of the refraction/lens computation while keeping the G2
// clip mask intact (capsuleShape still controls edge shape).
float sdShape(vec2 coord, vec2 halfSize, float radius) {
    if (uUseContinuousSdf > 0.5 && uNoContinuousSdfInRefraction < 0.5) {
        return sampleClipSdf(coord, halfSize, radius);
    }
    return sdRoundedRect(coord, halfSize, radius);
}

// gradSdRoundedRect \u2014 gradient of the SDF (points outward from edge).
// Used both for refraction direction and highlight specular.
vec2 gradSdRoundedRect(vec2 coord, vec2 halfSize, float radius) {
    vec2 cornerCoord = abs(coord) - (halfSize - vec2(radius));
    if (cornerCoord.x >= 0.0 || cornerCoord.y >= 0.0) {
        vec2 v = max(cornerCoord, vec2(0.0));
        // Guard against normalize(0,0) -> NaN
        float len = length(v);
        if (len < 1e-6) return vec2(0.0);
        return sign(coord) * (v / len);
    } else {
        float gradX = step(cornerCoord.y, cornerCoord.x);
        return sign(coord) * vec2(gradX, 1.0 - gradX);
    }
}

// rotateBy \u2014 rotate a 2D vector by angle (radians). Used to un-rotate the
// sample coord into the element's local space (so the SDF shape appears
// rotated by +uElementRotation), and to rotate refraction offsets back to
// screen space.
vec2 rotateBy(vec2 v, float angle) {
    float c = cos(angle);
    float s = sin(angle);
    return vec2(v.x * c - v.y * s, v.x * s + v.y * c);
}

// erfApprox \u2014 error function approximation (Abramowitz & Stegun 7.1.26).
// Max error < 2.5e-5. Used by inner shadow to model BlurMaskFilter's
// Gaussian convolution of a ring shape. erf(x) \u2208 [-1, 1].
float erfApprox(float x) {
    float a = abs(x);
    float t = 1.0 / (1.0 + 0.47047 * a);
    float y = 1.0 - (((0.3480242 * t - 0.0958798) * t + 0.7478556) * t * exp(-a * a));
    return sign(x) * y;
}
`
  );
  var COVER_GLSL = (
    /* glsl */
    `
// Returns wallpaper UV for a canvas pixel coordinate (top-left origin).
vec2 coverUv(vec2 canvasPx) {
    float canvasAspect = uCanvasSize.x / uCanvasSize.y;
    float wpAspect = uWallpaperSize.x / uWallpaperSize.y;
    vec2 uv = canvasPx / uCanvasSize;
    if (wpAspect > canvasAspect) {
        // Wallpaper is wider than canvas \u2014 crop horizontally.
        float s = canvasAspect / wpAspect;
        uv.x = (uv.x - 0.5) * s + 0.5;
    } else {
        // Wallpaper is taller than canvas \u2014 crop vertically.
        float s = wpAspect / canvasAspect;
        uv.y = (uv.y - 0.5) * s + 0.5;
    }
    return uv;
}

// Per-axis scale: 1 canvas pixel in wallpaper UV units.
// Used to convert a blur radius (in canvas px) into UV-space offsets
// for poisson-disc sampling.
vec2 canvasPxToUvScale() {
    float canvasAspect = uCanvasSize.x / uCanvasSize.y;
    float wpAspect = uWallpaperSize.x / uWallpaperSize.y;
    if (wpAspect > canvasAspect) {
        return vec2(canvasAspect / wpAspect, 1.0) / uCanvasSize;
    } else {
        return vec2(1.0, wpAspect / canvasAspect) / uCanvasSize;
    }
}
`
  );

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/shaders/element-uniforms.ts
  var ELEMENT_UNIFORMS_GLSL = (
    /* glsl */
    `
uniform sampler2D uBackdrop;
uniform sampler2D uWallpaperSampler;  // wallpaper texture (unscaled backdrop for toggle knobs)
uniform sampler2D uTabsBackdropSampler;  // tabsBackdrop FBO (tinted scene for indicator CombinedBackdrop)
uniform vec2  uCanvasSize;        // canvas size in px
uniform vec2  uWallpaperSize;     // UNUSED \u2014 kept for uniform-set compatibility
uniform vec2  uElementOffset;     // element top-left in canvas px (SCALED rect \u2014 where the quad is drawn)
uniform vec2  uElementSize;       // element size in px (SCALED \u2014 includes graphicsLayer scaleX/scaleY)
uniform vec4  uBackdropBbox;      // (offsetX, offsetY, sizeX, sizeY) in UV [0,1] \u2014 region of fullscreen scene the backdrop texture covers. Identity (0,0,1,1) when fullscreen.
uniform vec4  uCornerRadii;       // (topLeft, topRight, bottomRight, bottomLeft) in px (ORIGINAL, unscaled)
uniform float uRefractionHeight;  // px (ORIGINAL space \u2014 NOT scaled by layerScale, faithful to AGSL)
uniform float uRefractionAmount;  // px (ORIGINAL space \u2014 NOT scaled, faithful to AGSL)
// --- Layer transform (faithful to graphicsLayer { scaleX, scaleY }) ---
// The original applies the refraction shader at the ORIGINAL element size, THEN
// scales the entire rendered layer by (scaleX, scaleY) via graphicsLayer. To
// replicate this in a single-pass shader, we compute the SDF/refraction in
// ORIGINAL space (by dividing the screen-space centered coord by uLayerScale),
// then map the refraction offset back to screen space for backdrop sampling.
// This keeps the SDF shape correct (not stretched) while covering the scaled rect.
uniform vec2  uOriginalSize;        // element size in px (ORIGINAL, unscaled by graphicsLayer)
uniform float uOriginalCornerRadius; // corner radius in px (ORIGINAL, unscaled)
uniform vec2  uLayerScale;          // (scaleX, scaleY) from graphicsLayer \u2014 maps original\u2192screen
uniform float uElementRotation;    // rotation in radians (graphicsLayer rotationZ) \u2014 0 = none
uniform float uDepthEffect;       // 0 or 1
uniform float uChromaticAberration; // 0 or 1
uniform float uBlurRadius;        // px
uniform float uSaturation;        // vibrancy = 1.5
uniform float uBrightness;        // brightness offset (0 for vibrancy)
uniform float uContrast;          // 1.0 for vibrancy
uniform vec4  uTintColor;         // rgba; alpha 0 = no tint
uniform vec4  uSurfaceColor;      // rgba; alpha 0 = no surface
uniform vec4  uHighlightColor;    // rgb + 1.0 (alpha handled by uHighlightAlpha)
uniform float uHighlightAngle;    // radians
uniform float uHighlightFalloff;
uniform float uHighlightAlpha;
uniform float uHighlightMode;     // 0=default, 1=ambient, 2=plain
uniform float uHighlightStrokeWidth; // px (full stroke width, matching paint.strokeWidth)
uniform float uHighlightBlur;     // px (BlurMaskFilter radius)
// Content scale (non-uniform, faithful to LiquidToggle.kt / LiquidSlider.kt):
//   scale(scaleX, scaleY) { drawBackdrop() }
// Toggle: X lerp(2/3, 0.75, p), Y lerp(0, 0.75, p)
// Slider: X lerp(2/3, 1, p),    Y lerp(0, 1, p)
// At rest Y=0 \u2192 backdrop sampled from a single horizontal line (degenerate),
// but the white overlay (alpha=1) hides it. When pressed, scales to full.
uniform float uContentScaleX;
uniform float uContentScaleY;
// --- Toggle knob CombinedBackdrop effect (faithful to LiquidToggle.kt) ---
// The knob's backdrop is a CombinedBackdrop of:
//   1. Outer backdrop (LayerBackdrop wallpaper OR CanvasBackdrop solid color)
//   2. Scaled trackBackdrop (track color rect, scaled by lerp(2/3,0.75) x lerp(0,0.75))
// uUseToggleBackdrop = 1.0 \u2192 sample outer backdrop + composite scaled track color
// uUseToggleBackdrop = 0.0 \u2192 sample scene (uBackdrop) as before
//
// uUseSolidBackdrop = 1.0 \u2192 outer backdrop is solid color (uSolidBackdropColor)
// uUseSolidBackdrop = 0.0 \u2192 outer backdrop is wallpaper texture (uWallpaperSampler)
// Faithful to ToggleContent.kt:
//   - t1 (on wallpaper): backdrop = LayerBackdrop \u2192 sample wallpaper texture
//   - t2 (on card):      backdrop = rememberCanvasBackdrop { drawRect(color) } \u2192 solid color
uniform float uUseToggleBackdrop;
uniform float uUseSolidBackdrop;
uniform vec4  uSolidBackdropColor;  // rgba 0..1; used when uUseSolidBackdrop = 1.0
uniform vec4  uTrackColor;        // rgba 0..1; alpha 0 = no track color
uniform vec4  uTrackRect;         // (centerX, centerY, halfW, halfH) in canvas px (dpr-scaled)
uniform float uTrackCornerRadius; // canvas px (dpr-scaled)
// --- Bottom tab \u6307\u793A\u5668 CombinedBackdrop (faithful to LiquidBottomTabs.kt) ---
// The \u6307\u793A\u5668's backdrop = CombinedBackdrop(wallpaper, \u5185\u5C42\u80CC\u666F\u677F) where
// \u5185\u5C42\u80CC\u666F\u677F (tabsBackdrop) is a hidden Row with ColorFilter.tint(accentColor). Only the
// opaque \u6807\u7B7E\u5185\u5BB9 (icons/labels) becomes blue after tint \u2014 the glass part
// is transparent. We pass up to 8 tab content rects; pixels inside any rect
// (clipped to the \u5BB9\u5668 capsule) are tinted accentColor.
uniform float uIndicatorBackdrop;    // 0 or 1
uniform vec4  uContainerRect;        // (centerX, centerY, halfW, halfH) in canvas px (dpr-scaled)
uniform float uContainerCornerRadius; // canvas px (dpr-scaled)
uniform vec4  uIndicatorAccent;      // (r, g, b, a) \u2014 accentColor + unused
uniform float uInsetPx;              // indicator backdrop inset in device px (4dp * dpr)
uniform float uIndicatorPressProgress; // 0..1 press progress (for 2nd-layer scale)
uniform float uIndicatorPanelOffset; // panel offset in device px (2nd-layer x translation)
uniform float uDpr;                 // device pixel ratio (for dp\u2192px conversion)
uniform vec2  uContainerCenter;      // container center (scale origin) in canvas px (dpr-scaled)
uniform float uContainerScale;       // container layerBlock scale (1 + 16dp/width * pressProgress)
// Tab content fgTextures (icon+label alpha masks) for blue tint. Up to 8 tabs.
// Only opaque icon/label pixels become blue \u2014 the container glass stays natural.
uniform sampler2D uTabContentTex0;
uniform sampler2D uTabContentTex1;
uniform sampler2D uTabContentTex2;
uniform sampler2D uTabContentTex3;
uniform sampler2D uTabContentTex4;
uniform sampler2D uTabContentTex5;
uniform sampler2D uTabContentTex6;
uniform sampler2D uTabContentTex7;
uniform vec4  uTabContentRects[8];   // (centerX, centerY, halfW, halfH) per tab, canvas px (dpr-scaled)
uniform float uTabContentCount;      // number of valid tab rects (0..8)
uniform sampler2D uTabsGlassLayer;   // scene snapshot BEFORE tab-content (wallpaper+glass only, no text)
// --- SDF texture glass (faithful to SdfShader.kt) ---
uniform sampler2D uSdfTexSampler;   // clock_sdf texture (R=SDF, GB=normal, A=shape alpha)
uniform float uUseSdfTexture;       // 0 or 1
uniform vec2  uSdfTexSize;          // texture natural dimensions (px)
uniform float uSdfLightAngle;       // bevel light angle (degrees)
uniform float uEnterAlpha;          // global element alpha (enterProgress, 0..1)
// Highlight generation distance multiplier. The SDF-texture shader computes
// intensity = circleMap(1.0 - min(1.0, -sd * uSdfHighlightScale)) where sd is
// the normalized signed distance (-1 deep inside, 0 at edge, +1 far outside).
// The intensity field drives BOTH the refraction offset AND the bevel-lighting
// contribution. Physically it controls the WIDTH of the edge band where the
// glass effect transitions from full (at the edge) to zero (interior):
//   higher scale = narrower/sharper edge band (thinner glass edge feel)
//   lower scale  = wider/gentler edge band (thicker glass edge feel)
// Exposed as "\u73BB\u7483\u539A\u5EA6" (glass thickness) in the TextGlass UI. Default 1.5
// matches the original hardcoded constant in SdfShader.kt.
uniform float uSdfHighlightScale;   // default 1.5
// Bevel lighting on/off (0 or 1). When 0, the shader still computes
// intensity (so refraction \u2014 the glass distortion of the backdrop \u2014 still
// uses uSdfHighlightScale and stays fully adjustable), but the BEVEL
// brightness contribution (color *= 1 + 0.5 * intensity * bevel) is
// skipped entirely. This lets the TextGlass \u5149\u5F71 toggle turn the
// light/shadow layer on/off WITHOUT zeroing the thickness slider's shader
// value (so the slider is never dead). The base brightness dim (\u22120.1) is
// controlled separately via uBrightness on the JS side.
uniform float uSdfBevelEnabled;     // default 1 (on)
// Whole-glass tint dye hue (0..360 degrees). The TextGlass \u67D3\u8272 slider picks
// a hue; the ENTIRE glass body takes on that hue via BlendMode.Hue (faithful
// to Skia's non-separable Hue blend: result takes hue from the tint src, keeps
// the glass's own saturation + value). This is NOT a flat color overlay or CSS
// hue-rotate filter \u2014 it's a proper hue replacement that preserves the glass's
// luminance and saturation, so a dyed glass still looks like glass, just tinted.
// 0 = OFF (no tint \u2014 the slider's leftmost position). 1..360 = hue degrees
// (1 = red-ish, 120 = green, 240 = blue, 360 = red). The off-state is checked
// via uSdfGlassTintHue > 0.5 so the slider's leftmost (0) disables the tint
// entirely. Independent of the \u5149\u5F71 (bevel) toggle \u2014 dyes the whole glass body
// regardless of whether the edge lighting layer is on.
uniform float uSdfGlassTintHue;     // default 0 (off); 1..360 = hue
// Glass tint master switch (0 or 1). Gates BOTH the color-mix filter (below)
// AND the hue-dye (above). When OFF, no tint of any kind is applied regardless
// of uSdfGlassTintHue / uSdfGlassTintMix. Faithful to "\u67D3\u8272\u52A0\u4E00\u4E2A\u5F00\u5173".
uniform float uSdfGlassTintEnabled; // default 0 (off)
// Color-mix filter strength (0..1). BEFORE the hue-dye, the glass body is
// mixed toward a flat color (the pure saturated hue color) by this amount.
// This is a "color mix" filter (SrcOver-style blend toward a solid color) \u2014
// distinct from the hue-dye which replaces hue but preserves S/V. 0 = no
// color-mix (only the hue-dye applies); 1 = full color overlay. Faithful to
// "\u67D3\u8272\u524D\u52A0\u4E00\u4E2A\u6EE4\u955C\uFF08\u989C\u8272\u6DF7\u5408\uFF09\u6DF7\u5408\u5F3A\u5EA6\u8981\u53EF\u4EE5\u8C03".
uniform float uSdfGlassTintMix;     // default 0 (off); 0..1 = mix strength
// Hue-dye strength (0..1, default 0.85). Controls how strongly the
// BlendMode.Hue dye is applied to the glass body. 0 = no hue-dye (only the
// color-mix filter applies if any); 1 = full hue replacement. Originally
// hardcoded at 0.85 (matching the original's constant), now exposed as a
// slider so the user can tune the dye intensity independently of the
// color-mix filter. Faithful to "\u52A0\u4E00\u4E2A\u8C03\u67D3\u8272\u5F3A\u5EA6\u7684".
uniform float uSdfGlassTintStrength; // default 0.85; 0..1 = dye strength
// Tint color saturation (0..1, default 1.0). The tint source color is
// hsv2rgb(hue/360, S, V); S was hardcoded 1.0 before. 0 = gray, 1 = full.
uniform float uSdfGlassTintSaturation; // default 1.0; 0..1
// Tint color lightness/value (0..1, default 1.0). The V in hsv2rgb.
// 0 = black, 0.5 = mid, 1 = full brightness.
uniform float uSdfGlassTintLightness;  // default 1.0; 0..1
// Edge matte (0 or 1). When 1, the SDF edge band (where intensity is high,
// i.e. near the text boundary) is desaturated toward luminance AND slightly
// darkened \u2014 a frosted/matte rim. The edge band factor is intensity itself
// (1 at the very edge, 0 in the interior), so the matte effect fades smoothly
// into the clear glass interior. Faithful to the user request: "\u7528sdf\u6E32\u67D3\u8FB9\u7F18\uFF0C
// \u7136\u540E\u7ED9\u8FB9\u7F18\u964D\u4F4E\u63D0\u4EAE\u4E0E\u9971\u548C\u5EA6" (render the edge with SDF, then reduce the
// edge's brightness and saturation). Independent of the bevel toggle.
uniform float uSdfEdgeMatteEnabled; // default 0 (off)
// Edge matte target bitmask (default 7 = all). Controls WHICH layers the
// matte desaturate+darken applies to. bit 0 (1) = bevel (\u5149\u5F71 highlight),
// bit 1 (2) = tint (\u67D3\u8272), bit 2 (4) = base (refraction/body). When a bit is
// unset, that layer's edge contribution is preserved (not matted). The
// shader checks each bit independently so the user can matte only the bevel
// edge, or only the tint edge, etc. Faithful to "\u54D1\u5149\u5C42\u53EF\u4EE5\u8C03\u662F\u5426\u4F5C\u7528\u4E8E\u67D0
// \u4E9B\u5C42" (the matte layer can be tuned to apply to certain layers).
uniform float uSdfEdgeMatteTargets; // default 7 (all three layers)
// Per-layer matte tuning parameters. Each vec2 = (range, min):
//   range (0..1, default 1.0) \u2014 how far the matte effect extends from the
//     text boundary inward. 1.0 = the matte fades across the FULL intensity
//     field (edge = full strength, interior = zero, original behavior);
//     0.5 = the matte reaches full strength at intensity=0.5 and stays full
//     for intensity > 0.5 (a sharper/narrower matte band right at the rim);
//     small values = very thin matte rim. The edge factor is computed as
//     clamp(intensity / max(range, 0.001), 0.0, 1.0).
//   min (0..1, default 0.0) \u2014 minimum matte amount applied even in the deep
//     interior (where intensity \u2192 0). 0 = interior is clear (no matte);
//     0.3 = interior always has at least 30% matte. The final edge factor is
//     edgeClamped * (1.0 - min) + min. Faithful to "\u7ED9\u54D1\u5149\u6BCF\u5C42\u52A0\u4E0A\u4F5C\u7528\u53C2\u6570
//     \u8C03\u8282\uFF0C\u6BD4\u5982\u8303\u56F4\uFF0C\u6700\u5C0F\u503C".
// One vec2 per layer: bevel (bit 0), tint (bit 1), base (bit 2), brighten
// (bit 3). When the overall uSdfEdgeMatteEnabled is OFF, these are ignored.
// When a layer's bit in uSdfEdgeMatteTargets is unset, that layer's params
// are also ignored.
uniform vec2  uSdfEdgeMatteBevelParams; // (range, min) for bevel layer
uniform vec2  uSdfEdgeMatteTintParams;  // (range, min) for tint layer
uniform vec2  uSdfEdgeMatteBaseParams;  // (range, min) for base layer
uniform vec2  uSdfEdgeMatteBrightenParams; // (range, min) for brighten layer
// Per-layer matte STRENGTH (0..2, default 1.0). Scales the desaturate amount
// (matteStrength 0.65) AND the darken amount (matteDarken 0.18) for that
// layer. 0 = no matte effect at all (even at full edge); 1 = original
// strength; 2 = doubled. Independent per layer so the user can crank the
// bevel matte without affecting the tint/base matte. Faithful to "\u8C03\u6574\u63D0\u4EAE
// \u5C42\u54D1\u5149\u7684".
uniform float uSdfEdgeMatteBevelStrength; // default 1.0
uniform float uSdfEdgeMatteTintStrength;  // default 1.0
uniform float uSdfEdgeMatteBaseStrength;  // default 1.0
uniform float uSdfEdgeMatteBrightenStrength; // default 1.0
// Raw SDF debug render \u2014 when > 0.5, the SDF-texture glass path bypasses all
// glass effects and outputs the SDF's R channel directly as grayscale
// (inside = white, outside = black, AA via A channel). Used by TextGlass to
// inspect texture quality / aliasing / padding.
uniform float uSdfDebugMode;        // 0 or 1
// Coverage (A channel) \u2192 mask smoothstep range. The clock_sdf.webp texture
// uses (0.5, 1.0) \u2014 its A channel is 0 outside, 255 inside with a 1px AA
// edge, so smoothstep(0.5, 1.0) gives a 0.5px AA edge. The text SDF texture
// stores the raw Canvas2D alpha (0..255 with a 1-2px AA edge); using
// (0.5, 1.0) clips the lower half of the AA range \u2192 hard aliased edges,
// especially on small text. For text SDF, we widen to (0.0, 1.0) so the
// full Canvas2D AA gradient is preserved \u2192 smooth edges at all sizes.
uniform float uSdfAaMin;            // default 0.5 (clock_sdf); 0.0 for text SDF
// --- Per-element FBO optimization ---
// When uUsePerElementFbo > 0.5, the element is being rendered into a small
// bbox-sized FBO (NOT the fullscreen scene FBO). In that case gl_FragCoord
// ranges over [0..uElFboSize], so screenCoord must be reconstructed as
// uSceneRectOffset + (gl_FragCoord with Y flipped by uElFboSize.y) to map
// back into the full-canvas top-left-origin coordinate space that the rest
// of the shader (sampleBackdrop, coverUv, SDF, etc.) expects.
uniform float uUsePerElementFbo;    // 0 or 1
uniform vec2  uSceneRectOffset;     // element bbox top-left in canvas px (top-left origin, device px)
uniform vec2  uElFboSize;           // per-element FBO size in device px
// DEPRECATED: uBackdropRect was used by the old PEF path that sampled a
// cropped backdrop texture. The current PEF path samples the FULLSCREEN
// scene texture (same as ping-pong), so sceneUv no longer reads this.
// Kept in the uniform list for cache-index compatibility; not referenced
// by any shader code. Safe to remove once the uniform-cache list is cleaned.
uniform vec4  uBackdropRect;        // (x, y, w, h) top-left origin, scene device px (UNUSED)
// When 1.0, skip applyColorControls in the element shader (colorControls was
// already applied as a fullscreen pass BEFORE the 2-pass blur on the backdrop
// FBO, matching the original's colorControls\u2192blur\u2192lens order). Used by
// backdropFbo + useSeparableBlur elements (dialog card).
uniform float uSkipColorControls;   // 0 or 1
// (uNoContinuousSdfInRefraction is declared in SDF_GLSL \u2014 included by element.ts.
//  When 1.0, the refraction/lens computation forces analytic sdRoundedRect,
//  stripping the G2 SDF texture out of the glass-body refraction. The clip
//  mask is NOT affected \u2014 capsuleShape still controls the edge.)
// --- Magnifier glass (faithful to MagnifierContent.kt) ---
uniform float uUseMagnifier;        // 0 or 1
uniform float uMagnifierZoom;       // zoom factor (1.5)
uniform float uMagnifierOffsetY;    // sample Y offset to cursor (80dp, device px)
// --- Sample wallpaper directly (bypass scene FBO) ---
// When 1.0, sampleBackdrop uses coverUv + uWallpaperSampler (clean wallpaper)
// instead of sceneUv + uBackdrop (scene FBO). Used by elements that sit over
// a scrim/dim (Dialog card, ControlCenter tiles) so the glass refracts the
// clean wallpaper instead of the alpha-decayed scene FBO. Faithful to the
// original where LayerBackdrop captures the wallpaper Image (alpha=1).
uniform float uSampleWallpaper;     // 0 or 1
// --- Scrim color (applied to the wallpaper BEFORE colorControls/blur/lens) ---
// Faithful to DialogContent.kt / ControlCenterContent.kt where the scrim
// (drawRect(dimColor)) is painted onto the wallpaper Image (via
// BackdropDemoScaffold's modifier = drawWithContent { drawContent(); drawRect(dimColor) }),
// so the LayerBackdrop captures wallpaper+scrim as one opaque layer.
// In the port, when uSampleWallpaper=1 (clean wallpaper), we apply the scrim
// here in the shader to replicate that composited backdrop. uScrimColor.a=0
// means no scrim. Applied as SrcOver: backdrop.rgb = scrim.rgb*scrim.a + backdrop.rgb*(1-scrim.a).
uniform vec4 uScrimColor;           // rgba 0..1; a=0 = no scrim
// --- \u5185\u5C42\u80CC\u666F\u677F rim highlight stroke mask (Canvas2D, same approach as outer rim) ---
// When uIndicatorBackdrop=1, the inner backdrop plate's rim highlight is sampled
// from this pre-rasterized Canvas2D stroke mask instead of computed analytically.
// The mask is drawn for the \u5185\u5C42\u80CC\u666F\u677F capsule shape (uContainerRect dimensions)
// with clip(stroke) + BlurMaskFilter, giving browser-native Skia AA.
uniform sampler2D uInnerStrokeMask;   // Canvas2D stroke mask texture for inner backdrop highlight
uniform vec2  uInnerStrokeMaskOffset; // margin (strokeMargin) in device px \u2014 UV offset
uniform vec2  uInnerStrokeMaskSize;   // (maskW, maskH) in device px \u2014 total mask texture size
`
  );

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/shaders/element-utils.ts
  function generateGaussianDisc(tapCount) {
    const taps = [];
    if (tapCount <= 1) {
      taps.push({ x: 0, y: 0, w: 1 });
      return taps;
    }
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    const maxRadius = 3;
    let totalW = 0;
    for (let i = 0; i < tapCount; i++) {
      const t = (i + 0.5) / tapCount;
      const r = maxRadius * Math.sqrt(t);
      const angle = i * goldenAngle;
      const x = r * Math.cos(angle);
      const y = r * Math.sin(angle);
      const dist2 = x * x + y * y;
      const w = Math.exp(-0.5 * dist2);
      taps.push({ x, y, w });
      totalW += w;
    }
    if (totalW > 0) {
      for (const t of taps) t.w /= totalW;
    }
    return taps;
  }
  function generateBlurGLSL(taps, sampler, uvVar, pxToUvExpr) {
    if (taps.length === 1) {
      return `    return texture2D(${sampler}, ${uvVar});
`;
    }
    let code = "";
    for (const t of taps) {
      const ox = t.x.toFixed(6);
      const oy = t.y.toFixed(6);
      const w = t.w.toFixed(8);
      code += `    sum += texture2D(${sampler}, ${uvVar} + vec2(${ox}, ${oy}) * ${pxToUvExpr}) * ${w};
`;
    }
    return code;
  }
  var DEFAULT_BLUR_TAPS = 16;
  function generateElementUtilsGLSL(tapCount = DEFAULT_BLUR_TAPS) {
    const taps = generateGaussianDisc(tapCount);
    const backdropBlurCode = generateBlurGLSL(taps, "uBackdrop", "uv", "pxToUv");
    const wallpaperBlurCode = generateBlurGLSL(taps, "uWallpaperSampler", "uv", "pxToUv");
    return (
      /* glsl */
      `
// Forward declarations \u2014 blendHue/rgb2hsv/hsv2rgb are defined later but used
// by sampleIndicatorBackdrop (which must come before sampleToggleBackdrop in
// the file for readability). GLSL ES 1.00 requires declaration before use.
vec3 rgb2hsv(vec3 c);
vec3 hsv2rgb(vec3 c);
vec3 hsl2rgb(vec3 c);
vec3 blendHue(vec3 dst, vec3 src);

float circleMap(float x) {
    return 1.0 - sqrt(1.0 - x * x);
}

// SDF-texture glass sampling (faithful to SdfShader.kt).
// Samples the clock_sdf texture at element-local coords.
// Returns vec4(intensity, maskAlpha, normalX, normalY); zeroes if outside.
//
// uSdfHighlightScale controls how far from the text edge the bevel highlight
// extends into the interior. Original hardcoded constant was 1.5; exposed as
// a uniform so the TextGlass page can tune it live via a slider.
//
// uSdfAaMin controls the coverage\u2192mask smoothstep lower bound. clock_sdf uses
// 0.5 (narrow AA); text SDF uses 0.0 (full Canvas2D AA gradient \u2192 smooth at
// all sizes, no aliasing on small text).
vec4 sampleSdfTexture(vec2 localPx) {
    vec2 uv = vec2(localPx.x / uOriginalSize.x,
                   localPx.y / uOriginalSize.y);
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) {
        return vec4(0.0);
    }
    vec4 v = texture2D(uSdfTexSampler, uv);
    float sd = v.r * 2.0 - 1.0;
    float mask = smoothstep(uSdfAaMin, 1.0, v.a);
    if (mask <= 0.0) return vec4(0.0);
    if (mask < 1.0) sd = 0.0;
    vec2 normal = normalize(v.gb * 2.0 - 1.0);
    float intensity = circleMap(1.0 - min(1.0, -sd * uSdfHighlightScale));
    return vec4(intensity, mask, normal.x, normal.y);
}

// Convert a canvas-pixel coordinate (top-left origin) to scene-texture UV.
// The scene texture is the same size as the canvas, and is rendered with
// gl_FragCoord (bottom-left origin). So UV = (canvasPx.x / canvasW, 1 -
// canvasPx.y / canvasH). The Y flip happens here so the rest of the shader
// can work in top-left-origin canvas px.
//
// This is used by BOTH the ping-pong path and the per-element FBO path.
// In the PEF path, the element pass still samples the FULLSCREEN scene
// texture (uBackdrop = curTex or blurFboBTex), NOT a cropped region. The
// only PEF-specific work happens in element.ts's main(), where screenCoord
// is reconstructed from gl_FragCoord via uSceneRectOffset/uElFboSize. Once
// screenCoord is in canvas-px space, this function maps it to UV identically
// for both paths \u2014 keeping the shader's non-local reads (refraction offset,
// chromatic 7-tap spread, blur kernel) hitting real neighbor content.
vec2 sceneUv(vec2 canvasPx) {
    return vec2(canvasPx.x / uCanvasSize.x, 1.0 - canvasPx.y / uCanvasSize.y);
}

// Gaussian disc blur \u2014 ${tapCount} taps, dynamically generated in JS.
// Offsets are in units of radius (sigma = radius), scaled at runtime.
// radius < 0.5 falls back to single tap (no visible blur).
//
// When uSampleWallpaper > 0.5, samples the CLEAN wallpaper (uWallpaperSampler
// via coverUv) instead of the scene FBO (uBackdrop via sceneUv), AND applies
// the scrim (uScrimColor) to replicate the original's wallpaper+scrim composited
// LayerBackdrop. The scrim is applied INSIDE sampleBackdrop so EVERY sampling
// site \u2014 the initial backdrop sample, the refraction re-sample, and each
// chromatic-aberration channel \u2014 gets the same wallpaper+scrim composite.
// This fixes the "scrim not applied at edges" bug where the refraction band
// re-sampled the clean wallpaper (without scrim), making the edge brighter
// than the interior.
vec4 sampleBackdrop(vec2 canvasPx, float radius) {
    if (uSampleWallpaper > 0.5) {
        vec2 uv = coverUv(canvasPx);
        vec4 c;
        if (radius < 0.5) {
            c = texture2D(uWallpaperSampler, uv);
        } else {
            vec2 pxToUv = radius * canvasPxToUvScale();
            vec4 sum = vec4(0.0);
${wallpaperBlurCode}            c = sum;
        }
        // Apply scrim (SrcOver) so the backdrop = wallpaper+scrim, opaque.
        if (uScrimColor.a > 0.001) {
            c.rgb = uScrimColor.rgb * uScrimColor.a + c.rgb * (1.0 - uScrimColor.a);
            c.a = 1.0;
        }
        return c;
    }
    vec2 uv = sceneUv(canvasPx);
    // uBackdrop may be a bbox-sized texture (when blur ran in a bbox FBO via
    // cropAndBlurBackdrop). uBackdropBbox = (offsetX, offsetY, sizeX, sizeY)
    // in normalized UV [0,1] \u2014 the region of the fullscreen scene the bbox
    // texture covers. Map sceneUv into that region, clamp to avoid bleeding
    // at bbox edges. When uBackdropBbox.zw > 1.0 (sentinel = fullscreen),
    // the mapping is identity (uv unchanged).
    uv = (uv - uBackdropBbox.xy) / uBackdropBbox.zw;
    uv = clamp(uv, vec2(0.0), vec2(1.0));
    if (radius < 0.5) {
        return texture2D(uBackdrop, uv);
    }
    // Backdrop is always the fullscreen scene texture (both ping-pong and
    // PEF paths), so blur offsets scale by the canvas size.
    vec2 pxToUv = radius / uCanvasSize;
    vec4 sum = vec4(0.0);
${backdropBlurCode}    return sum;
}

// Gaussian disc blur of the WALLPAPER (uWallpaperSampler via coverUv).
// Used by the SDF-texture glass path (LockScreen) \u2014 faithful to the original's
// blur(2dp) effect applied before the SDF shader.
vec4 sampleWallpaperBlurred(vec2 canvasPx, float radius) {
    vec2 uv = coverUv(canvasPx);
    if (radius < 0.5) {
        return texture2D(uWallpaperSampler, uv);
    }
    vec2 pxToUv = radius * canvasPxToUvScale();
    vec4 sum = vec4(0.0);
${wallpaperBlurCode}    return sum;
}

// --- Toggle knob CombinedBackdrop sampling (faithful to LiquidToggle.kt) ---
// The knob's backdrop is a CombinedBackdrop of:
//   1. Outer backdrop:
//      - LayerBackdrop (wallpaper) for t1 \u2192 sample uWallpaperSampler
//      - CanvasBackdrop (solid color) for t2 \u2192 use uSolidBackdropColor
//   2. Scaled trackBackdrop (track color rect, clipped to Capsule, scaled
//      by lerp(2/3, 0.75, pressProgress) x lerp(0, 0.75, pressProgress)
//      around the knob's center)
//
// This function samples the outer backdrop (wallpaper OR solid color) with blur,
// then composites the scaled track color on top using a rounded-rect SDF
// at the uTrackRect position (center + half-size + corner radius).
//
// The track color SDF is also blurred by approximating the blur as a
// smoothstep over uBlurRadius \u2014 this matches the original where the blur
// effect is applied to the CombinedBackdrop (outer + track color).
vec4 sampleToggleBackdrop(vec2 canvasPx, float radius) {
    // 1. Sample outer backdrop with blur.
    vec4 wp;
    if (uUseSolidBackdrop > 0.5) {
        // CanvasBackdrop case (t2): solid color fills the entire knob area.
        // Faithful to: rememberCanvasBackdrop { drawRect(backgroundColor) }
        // The drawRect fills the DrawScope (knob's bounds) with the color,
        // so every pixel of the knob's backdrop is the solid color.
        wp = uSolidBackdropColor;
    } else if (radius < 0.5) {
        // LayerBackdrop case (t1): sample wallpaper texture unscaled.
        // IMPORTANT: use coverUv (cover-fit) to match the wallpaper background
        // pass (WALLPAPER_FRAGMENT_SHADER). Using sceneUv (raw normalization)
        // here would sample the wrong texel when the wallpaper aspect ratio
        // differs from the canvas \u2014 causing the knob to see a shifted/misaligned
        // wallpaper that doesn't match what's displayed behind it.
        vec2 uv = coverUv(canvasPx);
        wp = texture2D(uWallpaperSampler, uv);
    } else {
        // LayerBackdrop case (t1) with blur: 9-tap poisson disc on wallpaper.
        // Use coverUv for the center sample, and convert the blur radius from
        // canvas px to UV-space using canvasPxToUvScale() (which accounts for
        // the cover-fit aspect ratio cropping).
        vec2 uv = coverUv(canvasPx);
        vec2 pxToUv = radius * canvasPxToUvScale();
        vec4 sum = vec4(0.0);
        float total = 0.0;
        sum += texture2D(uWallpaperSampler, uv) * 0.25; total += 0.25;
        sum += texture2D(uWallpaperSampler, uv + vec2( 1.000,  0.000) * pxToUv) * 0.12; total += 0.12;
        sum += texture2D(uWallpaperSampler, uv + vec2(-1.000,  0.000) * pxToUv) * 0.12; total += 0.12;
        sum += texture2D(uWallpaperSampler, uv + vec2( 0.000,  1.000) * pxToUv) * 0.12; total += 0.12;
        sum += texture2D(uWallpaperSampler, uv + vec2( 0.000, -1.000) * pxToUv) * 0.12; total += 0.12;
        sum += texture2D(uWallpaperSampler, uv + vec2( 0.707,  0.707) * pxToUv) * 0.0675; total += 0.0675;
        sum += texture2D(uWallpaperSampler, uv + vec2( 0.707, -0.707) * pxToUv) * 0.0675; total += 0.0675;
        sum += texture2D(uWallpaperSampler, uv + vec2(-0.707,  0.707) * pxToUv) * 0.0675; total += 0.0675;
        sum += texture2D(uWallpaperSampler, uv + vec2(-0.707, -0.707) * pxToUv) * 0.0675; total += 0.0675;
        wp = sum / total;
    }

    // 2. Composite scaled track color on top.
    // The track rect is centered at uTrackRect.xy with half-size uTrackRect.zw,
    // and corner radius uTrackCornerRadius. We compute the SDF of this
    // rounded rect at canvasPx, then apply a smoothstep for edge AA + blur.
    // If uTrackColor.a == 0.0 OR the track rect is degenerate (halfW or
    // halfH < 0.5px, which happens at rest when scaleY=0), skip compositing.
    // Faithful to original: scale(scaleX, 0) { drawRect() } draws nothing.
    if (uTrackColor.a > 0.001 && uTrackRect.z > 0.5 && uTrackRect.w > 0.5) {
        vec2 trackCenter = uTrackRect.xy;
        vec2 trackHalf = uTrackRect.zw;
        vec2 trackLocal = canvasPx - trackCenter;
        // sdRoundedRect expects centered coord (relative to center).
        // Use uniform corner radius = uTrackCornerRadius.
        float tr = uTrackCornerRadius;
        // Approximate the rounded-rect SDF (matches sdRoundedRect from SDF_GLSL).
        vec2 q = abs(trackLocal) - trackHalf + vec2(tr);
        float trackSd = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - tr;
        // Blur the edge by uBlurRadius (approximate Gaussian edge feather).
        // Inside (trackSd < -radius) \u2192 mask=1; outside (trackSd > radius) \u2192 mask=0.
        // Use max(radius, 1.0) to guarantee at least 1px smoothstep for AA
        // \u2014 when fully pressed, blurRadius=0, but edges must still be smooth.
        float aaRadius = max(radius, 1.0);
        float mask = 1.0 - smoothstep(-aaRadius, aaRadius, trackSd);
        // Composite: srcOver (track color over outer backdrop).
        float a = mask * uTrackColor.a;
        wp.rgb = mix(wp.rgb, uTrackColor.rgb, a);
        wp.a = mix(wp.a, 1.0, a);
    }
    return wp;
}

// sampleIndicatorBackdrop \u2014 faithful to LiquidBottomTabs.kt indicator.
//
// Naming convention (used throughout the bottom-tabs code):
//   - \u5BB9\u5668 (Container)  = outer visible glass bar (64dp), Container Row in Kotlin
//   - \u6307\u793A\u5668 (Indicator) = selected sliding glass capsule (56dp), Indicator Box in Kotlin
//   - \u5185\u5C42\u80CC\u666F\u677F (Inner backdrop) = hidden 56dp glass captured by tabsBackdrop,
//     tinted blue by ColorFilter.tint(accentColor), sampled by the indicator
//   - \u6807\u7B7E\u5185\u5BB9 (Tab content) = icon + label inside each tab slot
//
// Original: indicator.drawBackdrop(backdrop = rememberCombinedBackdrop(backdrop, tabsBackdrop))
//   - backdrop (outer) = LayerBackdrop = wallpaper (sampled via coverUv)
//   - tabsBackdrop (inner) = hidden Row's 56dp glass, inset 4dp from the
//     indicator's draw area on all sides.
//
// Implementation (mirrors sampleToggleBackdrop):
//   1. Sample wallpaper (outer backdrop) with blur \u2014 same as toggle's outer.
//   2. Composite the scene FBO (uBackdrop = container glass + content)
//      inside an INSET capsule SDF (containerRect shrunk 4dp each side).
//      This is the "smaller background plate" refracted inside the indicator.
vec4 sampleIndicatorBackdrop(vec2 canvasPx, float radius) {
    // 1. Sample wallpaper (outer LayerBackdrop) via coverUv (cover-fit).
    vec4 wp;
    if (radius < 0.5) {
        vec2 uv = coverUv(canvasPx);
        wp = texture2D(uWallpaperSampler, uv);
    } else {
        vec2 uv = coverUv(canvasPx);
        vec2 pxToUv = radius * canvasPxToUvScale();
        vec4 sum = vec4(0.0);
        float total = 0.0;
        sum += texture2D(uWallpaperSampler, uv) * 0.25; total += 0.25;
        sum += texture2D(uWallpaperSampler, uv + vec2( 1.000,  0.000) * pxToUv) * 0.12; total += 0.12;
        sum += texture2D(uWallpaperSampler, uv + vec2(-1.000,  0.000) * pxToUv) * 0.12; total += 0.12;
        sum += texture2D(uWallpaperSampler, uv + vec2( 0.000,  1.000) * pxToUv) * 0.12; total += 0.12;
        sum += texture2D(uWallpaperSampler, uv + vec2( 0.000, -1.000) * pxToUv) * 0.12; total += 0.12;
        sum += texture2D(uWallpaperSampler, uv + vec2( 0.707,  0.707) * pxToUv) * 0.0675; total += 0.0675;
        sum += texture2D(uWallpaperSampler, uv + vec2( 0.707, -0.707) * pxToUv) * 0.0675; total += 0.0675;
        sum += texture2D(uWallpaperSampler, uv + vec2(-0.707,  0.707) * pxToUv) * 0.0675; total += 0.0675;
        sum += texture2D(uWallpaperSampler, uv + vec2(-0.707, -0.707) * pxToUv) * 0.0675; total += 0.0675;
        wp = sum / total;
    }

    // 2. \u5185\u5C42\u80CC\u666F\u677F (Inner backdrop) SDF \u2014 the hidden Row's 56dp glass capsule.
    //    Faithful to LiquidBottomTabs.kt: the hidden Row has NO layerBlock,
    //    so its glass does NOT scale with the container. Only panelOffset
    //    shifts it (translationX = panelOffset).
    vec2 capsuleHalf = max(uContainerRect.zw, vec2(0.0));
    float cr = max(uContainerCornerRadius, 0.0);
    // Center = rectCenter + panelOffset (NO container scale).
    vec2 scaledCenter = uContainerRect.xy + vec2(uIndicatorPanelOffset, 0.0);
    vec2 capsuleLocal = canvasPx - scaledCenter;
    vec2 cq = abs(capsuleLocal) - capsuleHalf + vec2(cr);
    float capsuleSd = length(max(cq, vec2(0.0))) + min(max(cq.x, cq.y), 0.0) - cr;
    // Mask: interpolate between 1.0 (at rest) and smoothstep (when pressed).
    // At rest (progress=0): mask=1.0 \u2014 no separate smoothstep transition at
    // the containerRect boundary, because it overlaps with the indicator's own
    // edge (both 56dp capsules). A second smoothstep here would reveal raw
    // wallpaper at the indicator edge, causing jagged aliasing. With mask=1.0,
    // the indicator always shows the glass scene inside its shape, and edgeAlpha
    // smoothly fades to transparent \u2014 matching the container glass behind it.
    // When pressed (progress=1): restore the original smoothstep mask for the
    // CombinedBackdrop clipping. Refraction displaces samples away from the
    // shared edge, so the smoothstep no longer causes jaggies; and the inner
    // backdrop capsule clip preserves the correct CombinedBackdrop visual
    // (scene inside capsule, wallpaper outside).
    float indicatorAaRadius = max(radius, 1.0);
    float smoothstepMask = 1.0 - smoothstep(-indicatorAaRadius, indicatorAaRadius, capsuleSd);
    float mask = mix(1.0, smoothstepMask, uIndicatorPressProgress);

    // 2b. \u5185\u5C42\u80CC\u666F\u677F shadow (Shadow.Default) \u2014 faithful to LiquidBottomTabs.kt
    //     hidden Row's drawBackdrop: shadow defaults to Shadow.Default when not specified.
    //     Shadow.Default: radius=24dp, offset=DpOffset(0, radius/6=4dp), color=Black@0.1, alpha=1.
    //     In the CombinedBackdrop, the shadow is composited between wallpaper (outer)
    //     and glass body (inner). Through the semi-transparent glass body, this shadow
    //     bleeds through near the capsule edges \u2014 most visible near the top edge where
    //     the shadow offset (0, +4dp) makes those pixels "outside" the shadow capsule
    //     (shadow capsule top = original top + 4dp, so original top is outside it).
    //     Implementation mirrors ShadowModifier.kt:
    //       1. Shift capsule by shadow offset \u2192 shadow shape SDF
    //       2. Gaussian falloff (MaskFilter.makeBlur sigma = radius directly)
    //       3. Mask inside original capsule (ShadowMaskPaint BlendMode.Clear)
    //       4. Darken wallpaper by Black@0.1 \xD7 shadowIntensity
    float shadowOffsetYpx = (24.0 / 6.0) * uDpr; // DpOffset(0, radius/6) in device px
    vec2 shadowLocal = capsuleLocal - vec2(0.0, shadowOffsetYpx);
    vec2 shadowCq2 = abs(shadowLocal) - capsuleHalf + vec2(cr);
    float shadowSd = length(max(shadowCq2, vec2(0.0))) + min(max(shadowCq2.x, shadowCq2.y), 0.0) - cr;
    // Shadow intensity: Gaussian falloff from shadow shape edge.
    // MaskFilter.makeBlur(FilterBlurMode.NORMAL, radius) takes sigma = radius directly.
    float shadowSigma = max(24.0 * uDpr, 1.0); // sigma = 24dp in device px
    float shadowIntensity = 0.5 * exp(-shadowSd * shadowSd / (2.0 * shadowSigma * shadowSigma));
    // Mask shadow inside the original capsule (ShadowMaskPaint BlendMode.Clear
    // removes shadow where the shape itself is drawn, so shadow only appears outside).
    shadowIntensity *= smoothstep(-1.0, 1.0, capsuleSd);
    // Darken wallpaper by Black@0.1 \xD7 shadowIntensity (SrcOver compositing).
    wp.rgb *= (1.0 - shadowIntensity * 0.1);

    // 3. Sample the GLASS LAYER FBO (wallpaper + container glass, NO tab text).
    //    This is a snapshot taken after the container glass is rendered but
    //    before tab-content is drawn \u2014 so it has no white/black text to bleed
    //    through. The blue tab text is drawn on top via fgTexture (step 4).
    vec2 sceneUv2 = sceneUv(canvasPx - vec2(uIndicatorPanelOffset, 0.0));
    vec4 scene = texture2D(uTabsGlassLayer, sceneUv2);

    // 4. Draw blue \u6807\u7B7E\u5185\u5BB9 (tab content: icons/labels) on top of the glass layer.
    //    Use each tab's fgTexture alpha as a hard mask (step) \u2014 pixels inside
    //    the icon/label shape become blue, everything else stays the glass
    //    layer's natural color. No white edges (hard replace, no mix).
    //    Faithful to LiquidBottomTabs.kt: the hidden Row's tab content gets
    //    LocalLiquidBottomTabScale = lerp(1, 1.2, pressProgress) + panelOffset
    //    (NOT the container scale \u2014 the hidden Row is a sibling of the
    //    container, not a child, so the container layerBlock doesn't apply).
    float contentScale = 1.0 + 0.2 * uIndicatorPressProgress;
    float tabMask = 0.0;
    for (int i = 0; i < 8; i++) {
        if (float(i) >= uTabContentCount) break;
        vec4 r = uTabContentRects[i];
        if (r.z > 0.5 && r.w > 0.5) {
            // Tab content scales around its OWN center (not container center)
            // by contentScale, then shifts by panelOffset.
            vec2 tabCenter = r.xy + vec2(uIndicatorPanelOffset, 0.0);
            vec2 scaledHalf = r.zw * contentScale;
            vec2 localPx = canvasPx - (tabCenter - scaledHalf);
            vec2 uv = localPx / (scaledHalf * 2.0);
            if (all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)))) {
                float a = 0.0;
                if (i == 0) a = texture2D(uTabContentTex0, uv).a;
                else if (i == 1) a = texture2D(uTabContentTex1, uv).a;
                else if (i == 2) a = texture2D(uTabContentTex2, uv).a;
                else if (i == 3) a = texture2D(uTabContentTex3, uv).a;
                else if (i == 4) a = texture2D(uTabContentTex4, uv).a;
                else if (i == 5) a = texture2D(uTabContentTex5, uv).a;
                else if (i == 6) a = texture2D(uTabContentTex6, uv).a;
                else if (i == 7) a = texture2D(uTabContentTex7, uv).a;
                tabMask = max(tabMask, a);
            }
        }
    }
    // Use fgTexture alpha directly as the blue compositing factor. fgTexture
    // is LINEAR-filtered so its alpha has smooth AA edges \u2014 no smoothstep
    // threshold needed (which caused jaggies by hard-clipping the AA gradient).
    vec3 sceneColor = mix(scene.rgb, uIndicatorAccent.rgb, tabMask);

    // 5. Composite scene over wallpaper (SrcOver).
    //    At rest (mask\u22481.0): a \u2248 scene.a \u2014 glass scene composited at natural opacity.
    //    When pressed (mask=smoothstep): a = scene.a * mask \u2014 CombinedBackdrop clip.
    float a = scene.a * mask;
    vec3 resultRgb = mix(wp.rgb, sceneColor, a);

    // 6. \u5185\u5C42\u80CC\u666F\u677F rim highlight \u2014 faithful to LiquidBottomTabs.kt hidden Row:
    //    highlight = { Highlight.Default.copy(alpha = progress) }
    //    The HighlightModifier draws a STROKE (width=0.5dp, strokeWidth=2px)
    //    blurred by 0.25dp, clipped inside the capsule, colored by the
    //    DefaultHighlightShaderString AGSL shader:
    //      float2 grad = gradSdRoundedRect(centeredCoord, halfSize, gradRadius);
    //      float2 normal = float2(cos(angle), sin(angle));
    //      float d = dot(grad, normal);
    //      float intensity = pow(abs(d), falloff);
    //      return color * intensity;   // color = White(1.0), alpha=1*progress
    //    with angle=45\xB0, falloff=1, gradRadius = min(radius*1.5, min(halfW, halfH)).
    //    The stroke's outward half (capsuleSd > 0) is clipped, leaving the inner
    //    half. Final contribution = White(1.0) * intensity * strokeMask * progress,
    //    added with Plus blend (additive).
    //    NOTE: this is the SAME as the \u6307\u793A\u5668's own rim highlight (step 2f in
    //    post-passes) \u2014 both use Highlight.Default. The only difference is the
    //    SDF: here it's the \u5185\u5C42\u80CC\u666F\u677F capsule (inset 4dp), there it's the
    //    \u6307\u793A\u5668's own capsule. The shader math is identical.
    //
    //    The stroke mask is now sampled from a pre-rasterized Canvas2D texture
    //    (uInnerStrokeMask) instead of computed analytically (65-tap Gaussian
    //    convolution of a hard-edge stroke band). This gives browser-native Skia
    //    hardware coverage AA \u2014 identical quality to the outer indicator rim
    //    highlight. The Canvas2D pipeline does ctx.clip(path) \u2192 ctx.stroke(path)
    //    \u2192 ctx.filter=blur, which naturally removes the outer half and provides
    //    sub-pixel AA. No per-pixel SDF loops, no smoothstep clipAA needed.
    float highlightAlpha = uIndicatorPressProgress;
    if (highlightAlpha > 0.001) {
        // SDF gradient + Default highlight intensity (angle=45\xB0, falloff=1).
        // This part is identical to the AGSL DefaultHighlightShaderString.
        float indRadius = max(cr, 0.0);
        float indHalfMin = min(capsuleHalf.x, capsuleHalf.y);
        float gradRadius = min(indRadius * 1.5, indHalfMin);
        vec2 grad = gradSdRoundedRect(capsuleLocal, capsuleHalf, gradRadius);
        vec2 normal = vec2(0.70710678, 0.70710678); // cos(45\xB0), sin(45\xB0)
        float d = dot(grad, normal);
        float intensity = pow(abs(d), 1.0);

        // Sample the pre-rasterized Canvas2D stroke mask texture.
        // UV mapping: capsuleLocal (centered, -halfW..+halfW) \u2192 element-local
        // (0..2*halfW) by adding capsuleHalf \u2192 add margin offset \u2192 divide
        // by maskSize. This is the same convention as the outer indicator
        // stroke mask (STROKE_MASK_COMPOSITE_FRAGMENT_SHADER).
        vec2 innerLocal = capsuleLocal + capsuleHalf;
        vec2 innerMaskUv = (innerLocal + uInnerStrokeMaskOffset) / uInnerStrokeMaskSize;
        // Bounds check \u2014 discard samples outside the mask texture.
        float innerMask = 0.0;
        if (innerMaskUv.x >= 0.0 && innerMaskUv.x <= 1.0 &&
            innerMaskUv.y >= 0.0 && innerMaskUv.y <= 1.0) {
            innerMask = texture2D(uInnerStrokeMask, innerMaskUv).a;
        }

        // White(0.5) * intensity * innerMask * progress, Plus blend (additive).
        // Faithful to HighlightStyle.Default: color = White.copy(alpha=0.5f).
        // The AGSL shader uses this 0.5 alpha, NOT color.copy(alpha=1f).
        // Same fix as DEFAULT_HIGHLIGHT.alpha = 0.5 (was previously 1.0).
        // No clipAA needed \u2014 the Canvas2D clip(path) before stroke already removes
        // the outer half, and Skia hardware coverage provides AA.
        resultRgb += vec3(0.5) * intensity * innerMask * highlightAlpha;
    }

    return vec4(resultRgb, 1.0);
}

// Magnifier backdrop sampling \u2014 faithful to MagnifierContent.kt's
// onDrawBackdrop: withTransform({ scale(1.5); translate(top=-80dp) }, drawBackdrop).
// Zoom around the magnifier center, then offset Y toward cursor.
vec4 sampleMagnifier(vec2 canvasPx, float radius) {
    vec2 magCenter = uElementOffset + uElementSize * 0.5;
    vec2 zoomedCoord = magCenter + (canvasPx - magCenter) / uMagnifierZoom;
    vec2 cursorCoord = vec2(zoomedCoord.x, zoomedCoord.y + uMagnifierOffsetY);
    return sampleBackdrop(cursorCoord, radius);
}

// colorControls \u2014 exact port of ColorFilter.kt colorControlsColorFilter.
// saturation 1.5, brightness 0, contrast 1 -> pure saturation boost.
vec3 applyColorControls(vec3 c, float brightness, float contrast, float saturation) {
    float invSat = 1.0 - saturation;
    float r = 0.213 * invSat;
    float g = 0.715 * invSat;
    float b = 0.072 * invSat;
    float t = (0.5 - contrast * 0.5 + brightness) * 255.0;
    float cs = contrast * saturation;
    float cr = contrast * r;
    float cg = contrast * g;
    float cb = contrast * b;
    vec3 outc;
    outc.r = (cr + cs) * c.r + cg * c.g + cb * c.b + t / 255.0;
    outc.g = cr * c.r + (cg + cs) * c.g + cb * c.b + t / 255.0;
    outc.b = cr * c.r + cg * c.g + (cb + cs) * c.b + t / 255.0;
    return outc;
}

// --- HSV conversion + BlendMode.Hue ---------------------------
// Faithful port of Skia's BlendMode.Hue (non-separable blend).
// Hue blend: result takes hue from src, saturation+value from dst.
// Used by drawRect(tint, BlendMode.Hue) in onDrawSurface.
vec3 rgb2hsv(vec3 c) {
    float maxC = max(c.r, max(c.g, c.b));
    float minC = min(c.r, min(c.g, c.b));
    float delta = maxC - minC;
    float v = maxC;
    float s = maxC < 1e-6 ? 0.0 : delta / maxC;
    float h = 0.0;
    if (delta > 1e-6) {
        if (maxC == c.r) {
            h = mod((c.g - c.b) / delta, 6.0);
        } else if (maxC == c.g) {
            h = (c.b - c.r) / delta + 2.0;
        } else {
            h = (c.r - c.g) / delta + 4.0;
        }
        h *= 60.0;
        if (h < 0.0) h += 360.0;
    }
    return vec3(h / 360.0, s, v);
}

vec3 hsv2rgb(vec3 c) {
    float h = c.x * 6.0;
    float s = c.y;
    float v = c.z;
    float i = floor(h);
    float f = h - i;
    float p = v * (1.0 - s);
    float q = v * (1.0 - s * f);
    float t = v * (1.0 - s * (1.0 - f));
    i = mod(i, 6.0);
    if (i < 1.0) return vec3(v, t, p);
    if (i < 2.0) return vec3(q, v, p);
    if (i < 3.0) return vec3(p, v, t);
    if (i < 4.0) return vec3(p, q, v);
    if (i < 5.0) return vec3(t, p, v);
    return vec3(v, p, q);
}

// HSL \u2192 RGB. Input: h in [0,1] (hue/360), s in [0,1], l in [0,1].
// Unlike HSV (where V=1 gives the pure hue color), HSL with L=1 gives
// WHITE and L=0 gives BLACK \u2014 so the 'lightness' slider behaves like a
// proper brightness control: 1 = white, 0.5 = pure color, 0 = black.
// L=0.5 + S=1 is the pure hue; S=0 makes it a grayscale by L.
vec3 hsl2rgb(vec3 c) {
    float h = c.x;
    float s = c.y;
    float l = c.z;
    if (s < 0.001) return vec3(l);
    float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
    float p = 2.0 * l - q;
    float r = clamp(abs(mod(h * 6.0 + 0.0, 6.0) - 3.0) - 1.0, 0.0, 1.0);
    float g = clamp(abs(mod(h * 6.0 + 2.0, 6.0) - 3.0) - 1.0, 0.0, 1.0);
    float b = clamp(abs(mod(h * 6.0 + 4.0, 6.0) - 3.0) - 1.0, 0.0, 1.0);
    r = p + (q - p) * r;
    g = p + (q - p) * g;
    b = p + (q - p) * b;
    return vec3(r, g, b);
}

// BlendMode.Hue: take hue from src, sat+val from dst.
vec3 blendHue(vec3 dst, vec3 src) {
    vec3 dh = rgb2hsv(dst);
    vec3 sh = rgb2hsv(src);
    return hsv2rgb(vec3(sh.x, dh.y, dh.z));
}
`
    );
  }

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/shaders/element.ts
  function generateElementFragmentShader(tapCount = DEFAULT_BLUR_TAPS) {
    const utilsGlsl = generateElementUtilsGLSL(tapCount);
    return (
      /* glsl */
      `
precision highp float;

${ELEMENT_UNIFORMS_GLSL}

${SDF_GLSL}

${COVER_GLSL}

${utilsGlsl}

void main() {
    // --- Coordinate reconstruction ---
    // Two paths: PEF (elFbo at BASELINE resolution) vs ping-pong (fullscreen).
    //
    // PEF path: elFbo is at baseline (origW*dpr + pad), NOT scaled by zoom.
    // gl_FragCoord ranges over [0, uElFboSize]. We compute:
    //   1. centeredOrigRot \u2014 un-rotated original-space coord (for SDF)
    //   2. screenCoord \u2014 rotated+scaled canvas position (for backdrop sampling)
    // The elFbo contains UN-ROTATED glass; rotation is applied at composite.
    // Backdrop sampling still needs the correct (rotated) screen position.
    //
    // Ping-pong path: fullscreen, rotation baked in shader (legacy).
    vec2 screenCoord;
    vec2 centeredOrigRot;  // un-rotated original-space coord for SDF
    vec2 elementCenter = uElementOffset + uElementSize * 0.5;
    vec2 layerScale = max(uLayerScale, vec2(1e-4));
    float rot = uElementRotation;

    if (uUsePerElementFbo > 0.5) {
        // elFbo fragment \u2192 centered local coord (Y-down, elFbo px)
        vec2 fboCenter = uElFboSize * 0.5;
        vec2 localUp = gl_FragCoord.xy - fboCenter;  // Y-up (gl_FragCoord BL origin)
        vec2 localDown = vec2(localUp.x, -localUp.y);  // Y-down (top-left origin)
        // Scale elFbo px \u2192 original px (accounts for AA pad: elFbo > origSize)
        vec2 origScale = uOriginalSize / uElFboSize;
        centeredOrigRot = localDown * origScale;  // un-rotated original space
        // Map to screen for backdrop sampling. When rot\u22480 (common case), skip
        // rotateBy entirely (4 mul + cos/sin per fragment saved). When rot\u22600,
        // apply rotation to map local-space coord to screen-space sample point.
        if (abs(rot) > 0.001) {
            screenCoord = elementCenter + rotateBy(centeredOrigRot, rot) * layerScale;
        } else {
            screenCoord = elementCenter + centeredOrigRot * layerScale;
        }
    } else {
        // Ping-pong: fullscreen, rotation in shader (legacy path)
        screenCoord = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);
        vec2 centeredScreen = screenCoord - elementCenter;
        vec2 centeredOrig = centeredScreen / layerScale;
        if (abs(rot) > 0.001) {
            centeredOrigRot = rotateBy(centeredOrig, -rot);
        } else {
            centeredOrigRot = centeredOrig;
        }
    }

    // Content scale (non-uniform): when < 1.0, compress the backdrop UV toward
    // the element center. Faithful to LiquidToggle.kt / LiquidSlider.kt.
    vec2 contentScale = vec2(uContentScaleX, uContentScaleY);
    vec2 sampleCoord = screenCoord;
    if (uContentScaleX < 0.999 || uContentScaleY < 0.999) {
        sampleCoord = elementCenter + (screenCoord - elementCenter) * contentScale;
    }

    vec2 origHalfSize = uOriginalSize * 0.5;
    float origRadius = uOriginalCornerRadius;

    // --- SDF-texture glass path (faithful to SdfShader.kt) ---
    if (uUseSdfTexture > 0.5) {
        vec2 localPx = centeredOrigRot + uOriginalSize * 0.5;
        vec4 sdfData = sampleSdfTexture(localPx);
        if (sdfData.y <= 0.0) discard;
        float intensity = sdfData.x;
        float sdfMask = sdfData.y;
        vec2 normal = sdfData.zw;

        // --- Raw SDF debug render -----------------------------------
        // Bypass all glass effects and output the SDF texture's R channel
        // directly as grayscale. Inside (sd<0) \u2192 white, edge (sd=0) \u2192 0.5,
        // outside (sd>0) \u2192 black. The A channel is preserved for AA. This
        // makes SDF quality / padding / aliasing directly visible \u2014 useful
        // when tuning DPR-adapted generation or highlight scale.
        if (uSdfDebugMode > 0.5) {
            vec2 uv = vec2(localPx.x / uOriginalSize.x,
                           localPx.y / uOriginalSize.y);
            vec4 v = texture2D(uSdfTexSampler, uv);
            // Decode R back to [-1,1]: negative = inside, positive = outside.
            float sd = v.r * 2.0 - 1.0;
            // Map sd \u2208 [-1, 1] \u2192 gray \u2208 [1, 0] (inside white, outside black).
            float gray = clamp(0.5 - sd * 0.5, 0.0, 1.0);
            // Overlay the normal as a faint RGB tint (so gradient direction is
            // visible). Multiplied by 0.15 so it doesn't swamp the gray.
            vec3 normalTint = vec3(v.g * 2.0 - 1.0, v.b * 2.0 - 1.0, 0.0) * 0.15;
            vec3 dbg = vec3(gray) + normalTint;
            // Use the same AA range as the non-debug path so the debug view
            // shows the real edge quality (not a hard threshold).
            float mask = smoothstep(uSdfAaMin, 1.0, v.a);
            float coverage = mask * uEnterAlpha;
            gl_FragColor = vec4(dbg * coverage, coverage);
            return;
        }

        // Compute the refracted sampling coordinate (SDF displacement).
        vec2 refractedOffsetOrig = intensity * uRefractionHeight * normal;
        vec2 refractedOffsetScreen = refractedOffsetOrig * layerScale;
        vec2 refractedScreen = screenCoord - refractedOffsetScreen;

        // Faithful to SdfShader.kt: color = content.eval(refractedCoord) * v.a
        // The content is the wallpaper after colorControls + blur(2dp).
        // FAITHFUL ORDERING: the original's onDrawBackdrop draws the wallpaper
        // AND drawRect(White 0.25) into the same buffer, THEN applies the
        // RenderEffect chain (colorControls, blur, SDF shader). So the white
        // overlay is PART of the SDF shader content input, and colorControls
        // is applied to the COMBINED (wallpaper + white) buffer.
        // We replicate: mix white into raw wallpaper FIRST, then apply
        // colorControls \u2014 so colorControls darkens the white too (matching
        // the original where contrast=0.75, brightness=-0.1 dims the white).
        //
        // TWO BACKDROP PATHS (adapted to global 2-pass blur):
        //   1. uSampleWallpaper > 0.5 (default / global-blur-OFF):
        //      Sample the WALLPAPER directly (uWallpaperSampler via coverUv)
        //      with inline poisson-disc blur (uBlurRadius). Faithful to the
        //      original's LayerBackdrop + blur(2dp).
        //   2. uSampleWallpaper < 0.5 (global-blur-ON, resolveBackdropTex has
        //      pre-blurred the cover-fitted wallpaper into uBackdrop):
        //      Sample uBackdrop via sceneUv with NO inline blur (it's already
        //      blurred by the 2-pass Gaussian pipeline). This adapts the SDF
        //      glass to the global separable blur setting, so the TextGlass
        //      respects blurDownsample / blurTapCap / dynamicBlurDownsample
        //      just like every other glass element. The cover-fitted wallpaper
        //      was rendered into wallpaperBlurFbo (canvas-sized) then 2-pass
        //      blurred, so sceneUv(refractedScreen) maps correctly.
        vec4 content;
        if (uSampleWallpaper > 0.5) {
            content = sampleWallpaperBlurred(refractedScreen, uBlurRadius);
        } else {
            content = sampleBackdrop(refractedScreen, 0.0);
        }
        vec3 rawContent = content.rgb;
        // Mix in white overlay (White 0.25 SrcOver) on RAW wallpaper first.
        if (uSurfaceColor.a > 0.001) {
            rawContent = uSurfaceColor.rgb * uSurfaceColor.a + rawContent * (1.0 - uSurfaceColor.a);
        }
        // THEN apply colorControls to the combined buffer.
        vec3 contentColor = applyColorControls(rawContent, uBrightness, uContrast, uSaturation);
        // Multiply by sdfMask (v.a) \u2014 faithful to content * v.a.
        vec3 color = contentColor * sdfMask;

        // Edge matte helpers \u2014 computed PER LAYER so each can be tuned
        // independently via uSdfEdgeMatte{Bevel,Tint,Base}Params. The base
        // edge factor is intensity (1 at the text boundary, \u21920 interior).
        // Per-layer params (vec2 = range, min) shape that into the final
        // matte weight:
        //   edge = clamp(intensity / max(range, 0.001), 0, 1) * (1 - min) + min
        //   range (0..1): how far the matte extends inward. 1 = full fade
        //     across the whole intensity field (original behavior); 0.5 =
        //     full strength by intensity=0.5 then flat (narrower rim); small
        //     = very thin matte line.
        //   min (0..1): floor matte amount in the deep interior. 0 = interior
        //     clear; 0.3 = interior always \u226530% matte.
        // bit 0 = bevel (\u5149\u5F71), bit 1 = tint (\u67D3\u8272), bit 2 = base (\u6298\u5C04/\u5E95\u8272).
        // When the overall uSdfEdgeMatteEnabled is OFF, no matte is applied
        // regardless of the bitmask. Faithful to "\u54D1\u5149\u5C42\u53EF\u4EE5\u8C03\u662F\u5426\u4F5C\u7528\u4E8E\u67D0\u4E9B\u5C42"
        // + "\u7ED9\u54D1\u5149\u6BCF\u5C42\u52A0\u4E0A\u4F5C\u7528\u53C2\u6570\u8C03\u8282\uFF0C\u6BD4\u5982\u8303\u56F4\uFF0C\u6700\u5C0F\u503C".
        float matteStrength = 0.65;   // desaturate toward luminance
        float matteDarken = 0.18;     // darken
        bool matteOn = uSdfEdgeMatteEnabled > 0.5;
        // bit 0 (bevel/\u63D0\u4EAE): targets mod 2. The previous code used
        // (targets - 8.0 * floor(targets / 8.0)) which is targets mod 8 \u2014
        // that returns a non-zero value for ANY non-zero targets (1..7), so
        // the bevel matte was ALWAYS on whenever matteOn was true, regardless
        // of whether bit 0 was actually set. This made the bevel matte toggle
        // ineffective \u2014 turning off bit 0 (bevel) still left the bevel matte
        // active. Fixed to use targets mod 2 which correctly extracts ONLY
        // bit 0.
        float t1 = floor(uSdfEdgeMatteTargets / 1.0);  // = targets
        bool matteBevel = matteOn && (t1 - 2.0 * floor(t1 / 2.0)) >= 1.0;
        // bit 1 (tint): floor(targets/2) mod 2
        float t2 = floor(uSdfEdgeMatteTargets / 2.0);
        bool matteTint = matteOn && (t2 - 2.0 * floor(t2 / 2.0)) >= 1.0;
        // bit 2 (base): floor(targets/4) mod 2
        float t4 = floor(uSdfEdgeMatteTargets / 4.0);
        bool matteBase = matteOn && (t4 - 2.0 * floor(t4 / 2.0)) >= 1.0;
        // bit 3 (brighten/\u63D0\u4EAE): floor(targets/8) mod 2. The brighten layer
        // is the overall brightness increment (uBrightness from the \u63D0\u4EAE
        // slider). When matteBrighten is true, the edge is pulled back toward
        // the pre-brightness rawContent \u2014 i.e. the edge gets LESS brightening
        // than the interior, producing a matte rim on the brightness layer.
        float t8 = floor(uSdfEdgeMatteTargets / 8.0);
        bool matteBrighten = matteOn && (t8 - 2.0 * floor(t8 / 2.0)) >= 1.0;
        // Per-layer matte edge factor \u2014 shaped by (range, min) params.
        float matteEdgeBase = clamp(intensity / max(uSdfEdgeMatteBaseParams.x, 0.001), 0.0, 1.0)
            * (1.0 - uSdfEdgeMatteBaseParams.y) + uSdfEdgeMatteBaseParams.y;
        // Brighten layer edge factor \u2014 shaped by the BRIGHTEN layer's params.
        float matteEdgeBrighten = clamp(intensity / max(uSdfEdgeMatteBrightenParams.x, 0.001), 0.0, 1.0)
            * (1.0 - uSdfEdgeMatteBrightenParams.y) + uSdfEdgeMatteBrightenParams.y;
        // Bevel / tint edge factors computed where they're used (below).

        // --- Brighten layer matte (bit 3) ---
        // \u63D0\u4EAE\u54D1\u5149: the brighten (uBrightness) amount is ATTENUATED at the
        // edge by edgeFactor \xD7 strength. So the edge gets LESS brightening
        // than the interior \u2014 a PURE brightness cut at the rim, NOT
        // desaturation. We re-apply colorControls with an attenuated
        // brightness (full interior \u2192 0 at edge when s=1); contrast +
        // saturation stay fully applied everywhere (NO saturation cut).
        // Faithful to "\u4E3A\u4EC0\u4E48\u4F1A\u540C\u65F6\u524A\u51CF\u9971\u548C\u5EA6\u5C42" \u2014 fixed: only brightness is
        // cut, saturation + contrast untouched.
        if (matteBrighten) {
            float s = uSdfEdgeMatteBrightenStrength;
            float attBrightness = uBrightness * (1.0 - matteEdgeBrighten * s);
            vec3 attenuated = applyColorControls(rawContent, attBrightness, uContrast, uSaturation);
            color.rgb = attenuated * sdfMask;
        }

        // --- Base layer matte (bit 2) ---
        // Desaturate + darken the base refraction/body color at the edge.
        // Strength scales both the desaturate and darken amounts.
        if (matteBase) {
            float s = uSdfEdgeMatteBaseStrength;
            float lum = dot(color.rgb, vec3(0.213, 0.715, 0.072));
            color.rgb = mix(color.rgb, vec3(lum), matteEdgeBase * matteStrength * s);
            color.rgb *= 1.0 - matteEdgeBase * matteDarken * s;
        }

        // Bevel lighting \u2014 gated by uSdfBevelEnabled so the TextGlass "\u5149\u5F71"
        // toggle can turn the light/shadow layer off WITHOUT zeroing
        // uSdfHighlightScale (which would also kill the refraction, since
        // intensity drives both). When bevel is off, the glass still refracts
        // the backdrop using the thickness slider's value \u2014 only the edge
        // brightness highlight is removed. The base dim is handled separately
        // via uBrightness on the JS side.
        // The bevel highlight is always pure white (no dye) \u2014 the whole-glass
        // tint (uSdfGlassTintHue) is applied separately below and affects the
        // ENTIRE glass body, not just the bevel band.
        // Edge matte (bit 0): when matteBevel is true, TWO visible effects
        // happen at the bevel band's edge, BOTH scaled by bevelMatteS (the
        // per-layer strength slider) so the user can actually SEE the matte
        //\u8C03\u8282:
        //   1. Weaken the bevel brightening (less shiny highlight at edge).
        //   2. APPLY a desaturate + darken to the color at the edge \u2014 this
        //      produces the visible frosted/matte rim. Without this, a small
        //      bevel value (e.g. 0.32) makes the weakening nearly invisible,
        //      so the strength slider appeared to "do nothing". Now both
        //      effects are driven by the same strength so the slider is
        //      always visually responsive.
        // The edge factor is shaped by the BEVEL layer's (range, min) params.
        float matteEdgeBevel = clamp(intensity / max(uSdfEdgeMatteBevelParams.x, 0.001), 0.0, 1.0)
            * (1.0 - uSdfEdgeMatteBevelParams.y) + uSdfEdgeMatteBevelParams.y;
        // Bevel matte strength \u2014 scales BOTH the weakening and the matte rim.
        float bevelMatteS = uSdfEdgeMatteBevelStrength;
        if (uSdfBevelEnabled > 0.5) {
            float angleRad = uSdfLightAngle * 3.1415926 / 180.0;
            vec2 lightDir = vec2(cos(angleRad), sin(angleRad));
            float bevel1 = clamp(dot(normal, lightDir), 0.0, 1.0);
            float bevel1Amt = 0.5 * intensity * bevel1;
            if (matteBevel) {
                // (1) Weaken the bevel brightening at the edge.
                bevel1Amt *= 1.0 - matteEdgeBevel * (matteStrength + matteDarken) * bevelMatteS;
            }
            color.rgb *= 1.0 + bevel1Amt;
            float bevel2 = clamp(dot(normal, -lightDir), 0.0, 1.0);
            float bevel2Amt = 0.5 * bevel2 * min(1.0, smoothstep(1.0, 0.0, abs(intensity - 0.25) * 6.0));
            if (matteBevel) {
                bevel2Amt *= 1.0 - matteEdgeBevel * (matteStrength + matteDarken) * bevelMatteS;
            }
            color.rgb *= 1.0 + bevel2Amt;
            // (2) APPLY the matte rim: desaturate toward luminance + darken at
            // the edge. This is the VISIBLE matte effect on the bevel layer \u2014
            // without it the strength slider had no visible feedback when the
            // bevel value was small. Faithful to "\u6211\u8981\u80FD\u8C03\u63D0\u4EAE\u5C42\u7684\u54D1\u5149".
            if (matteBevel) {
                float lum = dot(color.rgb, vec3(0.213, 0.715, 0.072));
                color.rgb = mix(color.rgb, vec3(lum), matteEdgeBevel * matteStrength * bevelMatteS);
                color.rgb *= 1.0 - matteEdgeBevel * matteDarken * bevelMatteS;
            }
        }

        // Whole-glass tint (\u67D3\u8272) \u2014 gated by uSdfGlassTintEnabled master switch.
        // Two stages, both using the same hue:
        //   1. Color-mix filter (\u67D3\u8272\u524D\u6EE4\u955C): mixes the glass body toward the
        //      pure saturated hue color by uSdfGlassTintMix amount (SrcOver-
        //      style blend toward a solid color). This is a "color mix" filter
        //      \u2014 distinct from the hue-dye. 0 = skip; 1 = full color overlay.
        //   2. Hue-dye: applies BlendMode.Hue (Skia non-separable Hue blend) at
        //      uSdfGlassTintStrength (default 0.85, adjustable) \u2014 takes hue from
        //      the tint source, keeps the glass's own saturation + value. So a
        //      dyed glass still looks like glass (luminance/sat preserved) just
        //      tinted. The strength slider lets the user tune how strong the
        //      dye is (0 = no dye, 1 = full hue replacement).
        // Both stages apply to the ENTIRE glass body (not just the bevel band).
        // Independent of the \u5149\u5F71 (bevel) toggle.
        // Edge matte (bit 1): when matteTint is true, the tint's blend factor
        // is reduced at the edge \u2014 the rim keeps more of the desaturated base
        // color instead of the dyed hue, so the edge looks matte while the
        // interior stays fully dyed. The edge factor is shaped by the TINT
        // layer's (range, min) params.
        float matteEdgeTint = clamp(intensity / max(uSdfEdgeMatteTintParams.x, 0.001), 0.0, 1.0)
            * (1.0 - uSdfEdgeMatteTintParams.y) + uSdfEdgeMatteTintParams.y;
        // Tint matte strength \u2014 scales how much the tint is suppressed at edge.
        float tintMatteS = uSdfEdgeMatteTintStrength;
        if (uSdfGlassTintEnabled > 0.5) {
            vec3 tintSrc = hsl2rgb(vec3(uSdfGlassTintHue / 360.0, uSdfGlassTintSaturation, uSdfGlassTintLightness));
            // Stage 1: color-mix filter (before hue-dye).
            if (uSdfGlassTintMix > 0.001) {
                float mixAmt = uSdfGlassTintMix;
                if (matteTint) {
                    mixAmt *= 1.0 - matteEdgeTint * matteStrength * tintMatteS;
                }
                color.rgb = mix(color.rgb, tintSrc, mixAmt);
            }
            // Stage 2: hue-dye (BlendMode.Hue at uSdfGlassTintStrength).
            // The dye strength is now adjustable (default 0.85, matching the
            // original's hardcoded constant). 0 = no hue-dye; 1 = full hue
            // replacement. Faithful to "\u52A0\u4E00\u4E2A\u8C03\u67D3\u8272\u5F3A\u5EA6\u7684".
            vec3 hueBlended = blendHue(color, tintSrc);
            float tintMix = uSdfGlassTintStrength;
            if (matteTint) {
                tintMix *= 1.0 - matteEdgeTint * matteStrength * tintMatteS;
            }
            color.rgb = mix(color.rgb, hueBlended, tintMix);
        }

        // NOTE: the old unconditional edge-matte block (which applied a single
        // global desaturate+darken to the composited color) has been replaced
        // by the per-layer matte applications above (base / bevel / tint),
        // each gated by its bit in uSdfEdgeMatteTargets.

        // PREMULTIPLIED output: RGB = color * coverage, A = coverage.
        // 'color' already includes '* sdfMask' (line above), so we only need
        // to also factor in uEnterAlpha to keep RGB and A consistent.
        // Premultiplied storage is REQUIRED for the elFbo: its texture uses
        // LINEAR filtering, and bilinear interpolation of non-premultiplied
        // alpha darkens RGB at the coverage boundary (the classic
        // "non-premult + bilinear" artifact that produces a dark fringe).
        // The composite pass then uses premult SrcOver (ONE, ONE_MINUS_SRC_ALPHA).
        float sdfCoverage = sdfMask * uEnterAlpha;
        gl_FragColor = vec4(color * uEnterAlpha, sdfCoverage);
        return;
    }

    // SDF for refraction/highlight \u2014 sdShape() dispatches to the G2 SDF
    // texture (sampleClipSdf) when uUseContinuousSdf=1 AND
    // uNoContinuousSdfInRefraction=0, else the analytic sdRoundedRect.
    float sd = sdShape(centeredOrigRot, origHalfSize, origRadius);
    // Clip + edgeAA: alpha mask (browser-native AA) when capsule enabled.
    float edgeAlpha;
    if (uUseContinuousSdf > 0.5) {
        float mask = sampleClipMask(centeredOrigRot, origHalfSize, origRadius);
        if (mask < 0.01) discard;
        edgeAlpha = mask;
    } else {
        if (sd > 0.5) discard;
        edgeAlpha = 1.0 - smoothstep(-0.5, 0.5, sd);
    }

    // --- 1. Backdrop sample (before refraction) -------------------
    // Use sampleCoord (content-scaled) so the backdrop shrinks inward when
    // uContentScaleX/Y < 1.0 (toggle/slider knob press effect).
    vec4 backdrop;
    if (uIndicatorBackdrop > 0.5) {
        backdrop = sampleIndicatorBackdrop(screenCoord, uBlurRadius);
    } else if (uUseToggleBackdrop > 0.5) {
        backdrop = sampleToggleBackdrop(screenCoord, uBlurRadius);
    } else if (uUseMagnifier > 0.5) {
        backdrop = sampleMagnifier(screenCoord, uBlurRadius);
    } else {
        backdrop = sampleBackdrop(sampleCoord, uBlurRadius);
    }
    // colorControls: for backdropFbo+useSeparableBlur elements, cc was already
    // applied as a fullscreen pass BEFORE the 2-pass blur (uSkipColorControls=1),
    // matching the original's colorControls\u2192blur order. Skip here to avoid
    // double-applying. For inline-blur elements, apply here.
    vec3 color = (uSkipColorControls > 0.5) ? backdrop.rgb : applyColorControls(backdrop.rgb, uBrightness, uContrast, uSaturation);
    // Magnifier glass is always OPAQUE \u2014 faithful to the original which
    // samples rememberCombinedBackdrop (wallpaper + content + cursor all
    // composited onto the opaque wallpaper). The port's scene texture may
    // carry partial alpha (e.g. card 0.9), which would make the glass
    // translucent. Force alpha=1 for magnifier.
    float alpha = (uUseMagnifier > 0.5) ? 1.0 : backdrop.a;

    // --- 2. Lens refraction (SDF + circleMap) ---------------------
    // Faithful port of RoundedRectRefractionWithDispersionShaderString.
    // SDF/grad computed in ORIGINAL space; uRefractionHeight/Amount are in
    // original px (NOT scaled by layerScale \u2014 the original AGSL shader receives
    // the original size and the graphicsLayer scales the OUTPUT, not the params).
    // Early-out: if we're deeper than refractionHeight from the edge,
    // skip refraction entirely (the lens doesn't reach here).
    if (uRefractionHeight > 0.5 && (-sd) < uRefractionHeight) {
        float sdClamped = min(sd, 0.0);
        float d = circleMap(1.0 - (-sdClamped) / uRefractionHeight) * uRefractionAmount;

        float gradRadius = min(origRadius * 1.5, min(origHalfSize.x, origHalfSize.y));
        vec2 grad = gradSdRoundedRect(centeredOrigRot, origHalfSize, gradRadius);
        // AGSL: normalize(grad + depthEffect * normalize(centeredCoord))
        vec2 depthVec = vec2(0.0);
        if (uDepthEffect > 0.5) {
            float dirLen = length(centeredOrigRot);
            if (dirLen > 1e-6) depthVec = centeredOrigRot / dirLen;
        }
        vec2 gradSum = grad + uDepthEffect * depthVec;
        float gradLen = length(gradSum);
        if (gradLen > 1e-6) grad = gradSum / gradLen;

        // Refraction offset in ORIGINAL space, then map to SCREEN space.
        //   offset_orig = d * grad          (original px)
        //   offset_screen = offset_orig * layerScale  (screen px, for sampling)
        // Faithful to: AGSL computes offset in original space, then graphicsLayer
        // scales the rendered output \u2014 so a pixel at original position p samples
        // the backdrop at p + offset_orig, and the result appears at screen
        // position center + p*layerScale. The backdrop sample position in screen
        // space is therefore center + (p + offset_orig)*layerScale
        // = screenCoord + offset_orig * layerScale.
        vec2 refractedOffsetOrig = d * grad;
        // Rotate the local-space offset BACK to screen space (by +rotation),
        // then scale by layerScale. Without the rotation, refraction points
        // in the wrong direction when the element is rotated.
        vec2 refractedOffsetScreen = rotateBy(refractedOffsetOrig, rot) * layerScale;
        vec2 refractedScreen = screenCoord + refractedOffsetScreen;
        vec2 refractedSampleCoord = refractedScreen;
        if (uIndicatorBackdrop < 0.5 && uUseToggleBackdrop < 0.5 &&
            (uContentScaleX < 0.999 || uContentScaleY < 0.999)) {
            refractedSampleCoord = elementCenter + (refractedScreen - elementCenter) * contentScale;
        }

        if (uChromaticAberration > 0.5) {
            // Faithful 7-path chromatic dispersion (ROYGBV + purple).
            // Original AGSL: dispersionIntensity = chromaticAberration * (cx*cy)/(hx*hy)
            //                dispersedCoord = d * grad * dispersionIntensity
            // 7 samples at dispersedCoord * {1, 2/3, 1/3, 0, -1/3, -2/3, -1}
            // with weighted channel accumulation.
            float dispersionIntensity = 1.0 * ((centeredOrigRot.x * centeredOrigRot.y) / (origHalfSize.x * origHalfSize.y));
            vec2 dispersedOffsetOrig = refractedOffsetOrig * dispersionIntensity;
            vec2 dispersedOffsetScreen = rotateBy(dispersedOffsetOrig, rot) * layerScale;

            // Sample helper \u2014 pick the right backdrop sampler.
            #define SAMPLE_DISPERSED(offset)                 (uIndicatorBackdrop > 0.5 ? sampleIndicatorBackdrop(refractedScreen + (offset), uBlurRadius) :                  uUseToggleBackdrop > 0.5 ? sampleToggleBackdrop(refractedScreen + (offset), uBlurRadius) :                  uUseMagnifier > 0.5 ? sampleMagnifier(refractedScreen + (offset), uBlurRadius) :                  sampleBackdrop(refractedSampleCoord + (offset), uBlurRadius))

            vec4 sRed    = SAMPLE_DISPERSED(+dispersedOffsetScreen);
            vec4 sOrange = SAMPLE_DISPERSED(+dispersedOffsetScreen * (2.0 / 3.0));
            vec4 sYellow = SAMPLE_DISPERSED(+dispersedOffsetScreen * (1.0 / 3.0));
            vec4 sGreen  = SAMPLE_DISPERSED(vec2(0.0));
            vec4 sCyan   = SAMPLE_DISPERSED(-dispersedOffsetScreen * (1.0 / 3.0));
            vec4 sBlue   = SAMPLE_DISPERSED(-dispersedOffsetScreen * (2.0 / 3.0));
            vec4 sPurple = SAMPLE_DISPERSED(-dispersedOffsetScreen);

            #undef SAMPLE_DISPERSED

            // Faithful channel weighting from the original AGSL shader.
            vec3 dispColor = vec3(0.0);
            float dispAlpha = 0.0;
            // red
            dispColor.r += sRed.r / 3.5;
            dispAlpha  += sRed.a / 7.0;
            // orange
            dispColor.r += sOrange.r / 3.5;
            dispColor.g += sOrange.g / 7.0;
            dispAlpha  += sOrange.a / 7.0;
            // yellow
            dispColor.r += sYellow.r / 3.5;
            dispColor.g += sYellow.g / 3.5;
            dispAlpha  += sYellow.a / 7.0;
            // green
            dispColor.g += sGreen.g / 3.5;
            dispAlpha  += sGreen.a / 7.0;
            // cyan
            dispColor.g += sCyan.g / 3.5;
            dispColor.b += sCyan.b / 3.0;
            dispAlpha  += sCyan.a / 7.0;
            // blue
            dispColor.b += sBlue.b / 3.0;
            dispAlpha  += sBlue.a / 7.0;
            // purple
            dispColor.r += sPurple.r / 7.0;
            dispColor.b += sPurple.b / 3.0;
            dispAlpha  += sPurple.a / 7.0;

            color = (uSkipColorControls > 0.5) ? dispColor : applyColorControls(dispColor, uBrightness, uContrast, uSaturation);
            // Magnifier chromatic aberration also forces opaque.
            alpha = (uUseMagnifier > 0.5) ? 1.0 : dispAlpha;
        } else {
            vec4 refracted;
            if (uIndicatorBackdrop > 0.5) {
                refracted = sampleIndicatorBackdrop(refractedScreen, uBlurRadius);
            } else if (uUseToggleBackdrop > 0.5) {
                refracted = sampleToggleBackdrop(refractedScreen, uBlurRadius);
            } else if (uUseMagnifier > 0.5) {
                refracted = sampleMagnifier(refractedScreen, uBlurRadius);
            } else {
                refracted = sampleBackdrop(refractedSampleCoord, uBlurRadius);
            }
            color = (uSkipColorControls > 0.5) ? refracted.rgb : applyColorControls(refracted.rgb, uBrightness, uContrast, uSaturation);
            // Magnifier refraction also forces opaque (see backdrop sample above).
            alpha = (uUseMagnifier > 0.5) ? 1.0 : refracted.a;
        }
    }

    // --- 3. onDrawSurface: tint (BlendMode.Hue + 0.75 alpha) -----
    // Faithful port of LiquidButton.kt onDrawSurface:
    //   drawRect(tint, blendMode = BlendMode.Hue)
    //   drawRect(tint.copy(alpha = 0.75f))
    // First pass: replace backdrop hue with tint hue (Hue blend, alpha = tint.a).
    // Second pass: overlay tint color at 0.75*alpha (SrcOver blend).
    if (uTintColor.a > 0.001) {
        vec3 hueBlended = blendHue(color, uTintColor.rgb);
        color = mix(color, hueBlended, uTintColor.a);
        color = mix(color, uTintColor.rgb, 0.75 * uTintColor.a);
    }

    // --- 4. onDrawSurface: surfaceColor (drawRect(surfaceColor)) --
    if (uSurfaceColor.a > 0.001) {
        color = mix(color, uSurfaceColor.rgb, uSurfaceColor.a);
    }

    // --- 5. Highlight (edge specular) -----------------------------
    // NOTE: The rim highlight is drawn as a SEPARATE pass (see
    // RIM_HIGHLIGHT_FRAGMENT_SHADER) with true Plus/SrcOver blend,
    // matching the original HighlightModifier.kt which records a separate
    // graphics layer. Doing it inline here would dim the highlight via the
    // element's edge AA, which is wrong \u2014 the highlight layer is composited
    // on top with its own blend mode.

    // --- 7. Edge anti-aliasing -----------------------------------
    // edgeAlpha was computed earlier (mask mode: direct coverage, analytic: smoothstep).
    //
    // PREMULTIPLIED output: RGB = color * coverage, A = coverage.
    // The elFbo texture uses LINEAR filtering; storing non-premultiplied
    // (color, coverage) causes bilinear interpolation between an edge texel
    // (color, 0.5) and the cleared-outside texel (0,0,0,0) to produce
    // ((1-t)*color, (1-t)*0.5) \u2014 RGB darkened by (1-t). The composite's
    // SrcOver blend then multiplies RGB by alpha AGAIN, squaring the
    // darkening \u2192 dark fringe at the glass edge.
    // Premultiplying here makes the linear filter mathematically correct:
    // lerp((color*a, a), (0,0,0,0), t) = ((1-t)*color*a, (1-t)*a), which
    // composites correctly with premult SrcOver (ONE, ONE_MINUS_SRC_ALPHA).
    float coverage = alpha * edgeAlpha * uEnterAlpha;
    gl_FragColor = vec4(color * coverage, coverage);
}
`
    );
  }
  var ELEMENT_FRAGMENT_SHADER = generateElementFragmentShader(DEFAULT_BLUR_TAPS);

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/shaders/shadow.ts
  var SHADOW_FRAGMENT_SHADER = (
    /* glsl */
    `
precision highp float;

uniform vec2  uCanvasSize;
uniform vec2  uElementOffset;   // SCALED rect top-left (where the quad is drawn)
uniform vec2  uElementSize;     // SCALED size (includes graphicsLayer scale)
uniform vec4  uCornerRadii;     // SCALED corner radii
uniform float uShadowRadius;    // ORIGINAL px (NOT scaled \u2014 faithful to BlurMaskFilter at original size)
uniform vec2  uShadowOffset;    // ORIGINAL px (offsetX, offsetY; +Y = downward)
uniform vec4  uShadowColor;     // rgba
// --- ORIGINAL-SPACE SDF (faithful to graphicsLayer { scaleX, scaleY }) ---
// Same approach as the element shader: compute the shadow SDF in ORIGINAL
// space (shape is a correct capsule, not stretched), then the graphicsLayer
// scales the entire shadow layer by (scaleX, scaleY). The shadow offset is
// in ORIGINAL px; we multiply by uLayerScale to map it to screen space for
// the SDF evaluation (offset_screen = offset_orig * layerScale). The shadow
// radius (blur sigma) stays in ORIGINAL px because the Gaussian falloff is
// computed in original space \u2014 the graphicsLayer then stretches the blurred
// result, which is the faithful behavior (BlurMaskFilter blurs at original
// resolution, then graphicsLayer scales the blurred pixels).
uniform vec2  uOriginalSize;        // element size in px (ORIGINAL, unscaled)
uniform float uOriginalCornerRadius; // corner radius in px (ORIGINAL, unscaled)
uniform vec2  uLayerScale;          // (scaleX, scaleY) from graphicsLayer
uniform float uElementRotation;     // rotation in radians (graphicsLayer rotationZ)

${SDF_GLSL}

void main() {
    // Flip gl_FragCoord (bottom-left origin) to top-left origin, so +Y
    // points downward \u2014 matching CSS convention.
    vec2 screenCoord = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);
    // elementCenter is the SAME for scaled and original rects (scaling is
    // around the center), so uElementOffset + uElementSize*0.5 gives the
    // correct center.
    vec2 elementCenter = uElementOffset + uElementSize * 0.5;
    vec2 centeredScreen = screenCoord - elementCenter;
    // Map to ORIGINAL space (guard against divide-by-zero).
    vec2 layerScale = max(uLayerScale, vec2(1e-4));
    vec2 centeredOrig = centeredScreen / layerScale;
    // Un-rotate into local space so the shadow shape rotates with the element.
    // Also rotate the shadow offset into local space so it stays consistent.
    vec2 centeredOrigRot = rotateBy(centeredOrig, -uElementRotation);
    vec2 shadowOffsetRot = rotateBy(uShadowOffset, -uElementRotation);

    vec2 origHalfSize = uOriginalSize * 0.5;
    float origRadius = uOriginalCornerRadius;

    // Shadow offset: defined in ORIGINAL px, applied in screen space.
    // The original draws the shadow at original size with this offset, then
    // graphicsLayer scales the whole layer \u2014 so the offset effectively
    // becomes offset_orig * layerScale in screen space. We map it back to
    // original space for the SDF: offset_orig = offset_screen / layerScale,
    // which cancels \u2014 so we use uShadowOffset directly in original space.
    vec2 shadowCenteredOrig = centeredOrigRot - shadowOffsetRot;
    float sd = sdShape(shadowCenteredOrig, origHalfSize, origRadius);
    // SDF of the element itself (not offset) \u2014 used to mask the shadow
    // inside the element so it doesn't bleed through the AA edge.
    float elementSd = sdShape(centeredOrigRot, origHalfSize, origRadius);

    // Shadow intensity: Gaussian falloff from the shadow shape's edge.
    // uShadowRadius is in ORIGINAL px (faithful to BlurMaskFilter at original
    // size). sigma = radius/3 matches the BlurMaskFilter spread.
    float sigma = max(uShadowRadius / 3.0, 1.0);
    float shadow = 0.5 * exp(-sd * sd / (2.0 * sigma * sigma));
    // Mask out the shadow inside the element (the element covers it).
    shadow *= smoothstep(-1.0, 1.0, elementSd);

    gl_FragColor = vec4(uShadowColor.rgb, uShadowColor.a * shadow);
}
`
  );
  var INNER_SHADOW_FRAGMENT_SHADER = (
    /* glsl */
    `
precision highp float;

uniform vec2  uCanvasSize;
uniform vec2  uElementOffset;
uniform vec2  uElementSize;
uniform vec4  uCornerRadii;
uniform float uInnerShadowRadius;
uniform float uInnerShadowAlpha;
uniform vec2  uInnerShadowOffset;

${SDF_GLSL}

void main() {
    vec2 screenCoord = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);
    vec2 localCoord = screenCoord - uElementOffset;
    vec2 halfSize = uElementSize * 0.5;
    vec2 centeredCoord = localCoord - halfSize;

    float radius = radiusAt(centeredCoord, uCornerRadii);
    float sd = sdShape(centeredCoord, halfSize, radius);
    if (sd > 0.5) discard;

    vec2 innerCentered = centeredCoord - uInnerShadowOffset;
    float innerSd = sdShape(innerCentered, halfSize, radius);
    float band = smoothstep(uInnerShadowRadius, 0.0, innerSd);
    band *= step(0.0, innerSd);
    gl_FragColor = vec4(0.0, 0.0, 0.0, band * uInnerShadowAlpha * 0.5);
}
`
  );

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/shaders/highlight.ts
  var HIGHLIGHT_FRAGMENT_SHADER = (
    /* glsl */
    `
precision highp float;

uniform vec2  uCanvasSize;
uniform vec2  uOffset;       // element top-left in canvas px (top-left origin) \u2014 SCALED rect
uniform vec2  uSize;         // element size in canvas px \u2014 SCALED
uniform vec4  uCornerRadii;  // capsule radii (topLeft, topRight, bottomRight, bottomLeft) in px \u2014 SCALED
uniform vec4  uColor;        // rgba; usually white * (alpha = 0.15 * progress)
uniform float uRadius;       // glow radius in canvas px (= minDim * 1.5, SCALED space)
uniform vec2  uPosition;     // finger position in element-local px (top-left origin, SCALED space)
// --- ORIGINAL-SPACE SDF clip (faithful to graphicsLayer { scaleX, scaleY }) ---
// The press glow (InteractiveHighlight) is drawn INSIDE the graphicsLayer, so
// it is clipped to the ORIGINAL capsule shape, then scaled with the layer.
// The glow position + radius are in SCALED space (they track the finger in
// screen px), but the clip SDF is in original space so the capsule clip stays
// correct when the button is stretched.
uniform vec2  uOriginalSize;
uniform float uOriginalCornerRadius;
uniform vec2  uLayerScale;
uniform float uElementRotation;

${SDF_GLSL}

void main() {
    vec2 screenCoord = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);
    vec2 localCoord = screenCoord - uOffset;

    // --- Capsule clip in ORIGINAL space (faithful to graphicsLayer clip) ---
    vec2 elementCenter = uOffset + uSize * 0.5;
    vec2 centeredScreen = screenCoord - elementCenter;
    vec2 layerScale = max(uLayerScale, vec2(1e-4));
    vec2 centeredOrig = centeredScreen / layerScale;
    vec2 origHalfSize = uOriginalSize * 0.5;
    float sd = sdShape(rotateBy(centeredOrig, -uElementRotation), origHalfSize, uOriginalCornerRadius);
    if (sd > 0.5) discard;
    float clipAlpha = 1.0 - smoothstep(-0.5, 0.5, sd);

    // Faithful AGSL port: smoothstep(radius, radius*0.5, dist) means
    // intensity = 1 at dist <= radius*0.5, fading to 0 at dist >= radius.
    // dist + uPosition are in SCALED local space (finger tracks screen px).
    float dist = distance(localCoord, uPosition);
    float intensity = smoothstep(uRadius, uRadius * 0.5, dist);

    // Premultiplied Plus-blend contribution. Renderer uses blendFunc(ONE, ONE)
    // so result.rgb = contribution + dst.rgb (clamped to 1).
    vec3 contribution = uColor.rgb * uColor.a * intensity * clipAlpha;
    gl_FragColor = vec4(contribution, 1.0);
}
`
  );
  var TINT_FRAGMENT_SHADER = (
    /* glsl */
    `
precision highp float;

uniform vec2  uCanvasSize;
uniform vec2  uOffset;
uniform vec2  uSize;
uniform vec4  uCornerRadii;
uniform vec4  uColor;
// --- ORIGINAL-SPACE SDF clip (faithful to graphicsLayer { scaleX, scaleY }) ---
// The white overlay (onDrawSurface drawRect) is drawn INSIDE the graphicsLayer,
// so it is clipped to the ORIGINAL capsule shape, then scaled with the layer.
// Computing the clip SDF in original space keeps the capsule clip correct when
// the button is stretched (no corner bleed, no stretched-clip artifacts).
uniform vec2  uOriginalSize;
uniform float uOriginalCornerRadius;
uniform vec2  uLayerScale;
uniform float uElementRotation;

${SDF_GLSL}

void main() {
    vec2 screenCoord = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);
    vec2 elementCenter = uOffset + uSize * 0.5;
    vec2 centeredScreen = screenCoord - elementCenter;
    vec2 layerScale = max(uLayerScale, vec2(1e-4));
    vec2 centeredOrig = centeredScreen / layerScale;
    vec2 origHalfSize = uOriginalSize * 0.5;
    vec2 centeredOrigRot = rotateBy(centeredOrig, -uElementRotation);

    // CLIP: for continuous-curvature (G2) elements, sample the R channel
    // (browser-native AA coverage) directly \u2014 this gives the most accurate
    // edge with NO exterior\u534A\u900F\u660E band. Using the G channel (SDF) with
    // smoothstep(-0.5, 0.5) leaves a ~1px half-transparent fringe OUTSIDE
    // the true shape edge (sd \u2208 [0, 0.5] is not discarded but has < 1
    // alpha), which lets the underlying glass body / shadow leak through
    // as a thin dark line ("capsule \u9ED1\u8FB9"). R coverage is 0 outside the
    // shape (browser AA only rasterizes the interior + edge), so the
    // fringe is eliminated and the clip is pixel-tight.
    // For G1 (analytic) elements, keep the SDF smoothstep \u2014 it's the
    // only shape source available.
    float clipAlpha;
    if (uUseContinuousSdf > 0.5) {
        clipAlpha = sampleClipMask(centeredOrigRot, origHalfSize, uOriginalCornerRadius);
    } else {
        float sd = sdRoundedRect(centeredOrigRot, origHalfSize, uOriginalCornerRadius);
        if (sd > 0.5) discard;
        clipAlpha = 1.0 - smoothstep(-0.5, 0.5, sd);
    }
    if (clipAlpha < 0.001) discard;

    gl_FragColor = vec4(uColor.rgb, uColor.a * clipAlpha);
}
`
  );
  var RIM_HIGHLIGHT_FRAGMENT_SHADER = (
    /* glsl */
    `
precision highp float;

uniform vec2  uCanvasSize;
uniform vec2  uOffset;          // element top-left in canvas px (top-left origin) \u2014 SCALED rect
uniform vec2  uSize;            // element size in canvas px \u2014 SCALED (includes graphicsLayer scale)
uniform vec4  uCornerRadii;     // (topLeft, topRight, bottomRight, bottomLeft) in px \u2014 SCALED
uniform vec4  uHighlightColor;  // rgb + 1.0
uniform float uHighlightAngle;  // radians
uniform float uHighlightFalloff;
uniform float uHighlightAlpha;
uniform float uHighlightMode;     // 0=Default, 1=Ambient, 2=Plain
uniform float uHighlightStrokeWidth;
uniform float uHighlightBlur;
// --- ORIGINAL-SPACE SDF (faithful to graphicsLayer { scaleX, scaleY }) ---
// Same approach as the element shader: compute SDF/stroke in ORIGINAL space
// (shape is correct, not stretched), so the highlight clip + stroke remain a
// correct capsule shape that is then scaled by graphicsLayer. Without this,
// a horizontally-stretched button would stretch the highlight clip too,
// making the stroke band uneven. See element.ts for the full rationale.
uniform vec2  uOriginalSize;        // element size in px (ORIGINAL, unscaled)
uniform float uOriginalCornerRadius; // corner radius in px (ORIGINAL, unscaled)
uniform vec2  uLayerScale;          // (scaleX, scaleY) from graphicsLayer
uniform float uElementRotation;     // rotation in radians (graphicsLayer rotationZ)

${SDF_GLSL}

void main() {
    vec2 screenCoord = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);
    // elementCenter is the SAME for scaled and original rects (scaling is
    // around the center), so uOffset + uSize*0.5 gives the correct center.
    vec2 elementCenter = uOffset + uSize * 0.5;
    vec2 centeredScreen = screenCoord - elementCenter;
    // Map to ORIGINAL space (guard against divide-by-zero).
    vec2 layerScale = max(uLayerScale, vec2(1e-4));
    vec2 centeredOrig = centeredScreen / layerScale;
    // Un-rotate into the element's local space so the SDF shape rotates.
    vec2 centeredOrigRot = rotateBy(centeredOrig, -uElementRotation);

    vec2 origHalfSize = uOriginalSize * 0.5;
    float origRadius = uOriginalCornerRadius;

    // SDF for stroke \u2014 analytic sdRoundedRect (matches the pre-capsule
    // highlight implementation). When capsule is OFF, this is the exact
    // shape. When capsule is ON, this is a close approximation (circular
    // arc vs G2 Bezier \u2014 the difference is sub-pixel within the 2px stroke
    // band, invisible in the highlight).
    float sd = sdRoundedRect(centeredOrigRot, origHalfSize, origRadius);

    // Outside the shape \u2014 clip (hard discard, matching pre-capsule behavior).
    if (sd > 0.0) discard;

    // Stroke mask \u2014 faithful to HighlightModifier.kt:
    //   paint.style = Stroke
    //   paint.strokeWidth = ceil(width.toPx()) * 2     // full stroke, centered on edge
    //   paint.blur(blurRadius.toPx())                   // BlurMaskFilter, Blur.NORMAL
    //   canvas.clipOutline(outline)                     // clip to inside the shape
    //   canvas.drawOutline(outline, paint)              // stroke centered on edge
    //
    // Implementation: first compute a HARD-EDGE stroke mask (1.0 inside the
    // stroke band, 0.0 outside), then convolve it with a Gaussian kernel by
    // sampling the SDF at multiple offsets along the gradient direction.
    // This mirrors the original's two-step process (draw stroke \u2192 blur),
    // rather than using an analytic erf approximation.
    //
    // The hard stroke band: sd in [-strokeHalf, +strokeHalf].
    // After clip (sd > 0 discarded by the outer if), only [-strokeHalf, 0] shows.
    //
    // Faithful to the original BlurMaskFilter:
    //   paint.blur(blurRadius.toPx())  \u2192  BlurMaskFilter(NORMAL, sigma=blurRadius_px)
    // In Skia/Android, BlurMaskFilter's radius param IS the Gaussian sigma
    // (not radius/3). blurRadius = width/2 = 0.25dp, so sigma = 0.25*dpr px.
    // uHighlightBlur is already in device px (set by the renderer as widthDp*dpr*0.5).
    float strokeHalf = uHighlightStrokeWidth * 0.5;
    float sigma = max(uHighlightBlur, 0.1);

    // Gaussian convolution of the hard stroke mask \u2014 3-tap (\u03C3-spaced).
    // The original's BlurMaskFilter has \u03C3 = blurRadius = 0.25dp \u2192 0.25px at
    // dpr=1. At this sub-pixel sigma, only 3 taps (at -\u03C3, 0, +\u03C3) are needed
    // \u2014 the Gaussian weight at \xB12\u03C3 is exp(-2) \u2248 0.14, negligible. This
    // replaces the old 65-tap loop (which computed 65 exp() calls per pixel,
    // ~650 cycles \u2014 the single biggest shader cost). 3 taps = 3 exp() = ~30
    // cycles, a 20\xD7 reduction with identical visual result at \u03C3=0.25.
    //   hardMask(sd) = 1.0 if |sd| < strokeHalf, else 0.0
    //   blurred(sd) = \u03A3 hardMask(sd - offset_k) * gauss(offset_k, \u03C3)
    // CLIP HALVING: the stroke is centered on sd=0; clip removes sd>0 (outer
    // half), so peak \u2248 0.5. We halve to match.
    float strokeMask = 0.0;
    float wSum = 0.0;
    for (int i = -1; i <= 1; i++) {
        float offset = float(i) * sigma;  // taps at -\u03C3, 0, +\u03C3
        float sampleSd = sd - offset;
        float hard = (abs(sampleSd) < strokeHalf) ? 1.0 : 0.0;
        float w = exp(-0.5 * (offset * offset) / (sigma * sigma));
        strokeMask += hard * w;
        wSum += w;
    }
    strokeMask /= wSum;
    strokeMask *= 0.5;  // clip halves the symmetric stroke at the edge

    if (uHighlightMode < 0.5) {
        // Default \u2014 shader returns color * intensity, Plus blend.
        float gradRadius = min(origRadius * 1.5, min(origHalfSize.x, origHalfSize.y));
        vec2 grad = gradSdRoundedRect(centeredOrigRot, origHalfSize, gradRadius);
        vec2 normal = vec2(cos(uHighlightAngle), sin(uHighlightAngle));
        float d = dot(grad, normal);
        float intensity = pow(abs(d), uHighlightFalloff);
        vec3 c = uHighlightColor.rgb * intensity * strokeMask * uHighlightAlpha;
        gl_FragColor = vec4(c, 1.0);
    } else if (uHighlightMode < 1.5) {
        // Ambient \u2014 premultiplied SrcOver blend (renderer uses ONE, ONE_MINUS_SRC_ALPHA).
        // Faithful to AmbientHighlightShaderString:
        //   float d = dot(grad, normal);
        //   float intensity = pow(abs(d), falloff);
        //   float t = step(0.0, d);  \u2190 half-black-half-white split
        //   return half4(t, t, t, 1.0) * intensity;
        // Output is premultiplied: vec4(color.rgb * t * i, i).
        // Bright side: adds white light. Dark side: dims scene \u2192 3D sphere.
        // paint.color(0.38) is overridden by shader; alpha = 1.0 not 0.38.
        float gradRadius = min(origRadius * 1.5, min(origHalfSize.x, origHalfSize.y));
        vec2 grad = gradSdRoundedRect(centeredOrigRot, origHalfSize, gradRadius);
        vec2 normal = vec2(cos(uHighlightAngle), sin(uHighlightAngle));
        float d = dot(grad, normal);
        float intensity = pow(abs(d), uHighlightFalloff);
        float t = step(0.0, d);  // 0 on dark side (d<0), 1 on bright side (d>=0)
        float i = intensity * strokeMask * uHighlightAlpha;
        gl_FragColor = vec4(uHighlightColor.rgb * t * i, i);
    } else {
        // Plain \u2014 even stroke, paint.color, Plus blend.
        vec3 c = uHighlightColor.rgb * strokeMask * uHighlightAlpha;
        gl_FragColor = vec4(c, 1.0);
    }
}
`
  );
  var HIGHLIGHT_STROKE_FRAGMENT_SHADER = (
    /* glsl */
    `
precision highp float;

uniform vec2  uCanvasSize;
uniform vec2  uOffset;          // element top-left (top-left origin) \u2014 SCALED
uniform vec2  uSize;            // element size \u2014 SCALED
uniform vec4  uCornerRadii;     // SCALED
uniform float uHighlightStrokeWidth;  // ceil(width*dpr)*2, device px
uniform vec2  uOriginalSize;
uniform float uOriginalCornerRadius;
uniform vec2  uLayerScale;
uniform float uElementRotation;
// uCornerStyle, uUseContinuousSdf, uContinuousSdf, uContinuousSdfTexSize,
// uContinuousSdfElementSize are declared in SDF_GLSL (do NOT redeclare here).

${SDF_GLSL}

void main() {
    vec2 screenCoord = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);
    vec2 elementCenter = uOffset + uSize * 0.5;
    vec2 centeredScreen = screenCoord - elementCenter;
    vec2 layerScale = max(uLayerScale, vec2(1e-4));
    vec2 centeredOrig = centeredScreen / layerScale;
    vec2 centeredOrigRot = rotateBy(centeredOrig, -uElementRotation);

    vec2 origHalfSize = uOriginalSize * 0.5;
    float origRadius = uOriginalCornerRadius;

    float sd = sdShape(centeredOrigRot, origHalfSize, origRadius);

    // clipOutline \u2014 clip to INSIDE the shape. Outside (sd > 0) is discarded.
    float edgeAA;
    if (uUseContinuousSdf > 0.5) {
        float mask = sampleClipMask(centeredOrigRot, origHalfSize, origRadius);
        if (mask < 0.01) discard;
        edgeAA = mask;
    } else {
        if (sd > 0.0) discard;
        edgeAA = 1.0 - smoothstep(-0.5, 0.5, sd);
    }

    // Stroke band centered on the edge (sd = 0), with 0.5px coverage AA on
    // the inner boundary. The outer boundary (sd = +strokeHalf) is clipped
    // away by edgeAA above. Faithful to Skia Paint.Stroke's coverage AA.
    // The BlurMaskFilter pass (when sigma >= 0.5px) softens this further;
    // at sub-pixel sigma (0.25px) the blur is skipped and this 0.5px AA
    // is what matches the original's look (Skia's 0.25px blur is negligibly
    // soft \u2014 essentially just AA).
    float strokeHalf = uHighlightStrokeWidth * 0.5;
    float strokeAA = 1.0 - smoothstep(strokeHalf - 0.5, strokeHalf, abs(sd));

    gl_FragColor = vec4(0.0, 0.0, 0.0, strokeAA * edgeAA);
}
`
  );
  var HIGHLIGHT_COMPOSITE_FRAGMENT_SHADER = (
    /* glsl */
    `
precision highp float;

uniform vec2  uCanvasSize;
uniform vec2  uOffset;
uniform vec2  uSize;
uniform vec4  uCornerRadii;
uniform sampler2D uBlurredMask;   // the 2-pass-blurred stroke mask FBO
uniform vec2  uMaskTexSize;       // size of the mask FBO (= canvas size)
uniform vec4  uHighlightColor;    // rgb + 1.0
uniform float uHighlightAngle;
uniform float uHighlightFalloff;
uniform float uHighlightAlpha;
uniform float uHighlightMode;     // 0=Default, 1=Ambient, 2=Plain
uniform vec2  uOriginalSize;
uniform float uOriginalCornerRadius;
uniform vec2  uLayerScale;
uniform float uElementRotation;
// uCornerStyle, uUseContinuousSdf, uContinuousSdf, uContinuousSdfTexSize,
// uContinuousSdfElementSize are declared in SDF_GLSL (do NOT redeclare here).

${SDF_GLSL}

void main() {
    vec2 screenCoord = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);

    // Sample the blurred stroke mask at this pixel. The mask FBO covers the
    // full canvas (same size), so UV = gl_FragCoord / maskTexSize.
    // Mask FBO is Y-down (top-left origin, like our scene FBOs), so flip Y
    // to match the screenCoord convention.
    vec2 maskUv = vec2(gl_FragCoord.x / uMaskTexSize.x, gl_FragCoord.y / uMaskTexSize.y);
    float mask = texture2D(uBlurredMask, maskUv).a;
    if (mask < 0.001) discard;

    // Compute intensity from the SDF gradient (AGSL DefaultHighlightShaderString).
    vec2 elementCenter = uOffset + uSize * 0.5;
    vec2 centeredScreen = screenCoord - elementCenter;
    vec2 layerScale = max(uLayerScale, vec2(1e-4));
    vec2 centeredOrig = centeredScreen / layerScale;
    vec2 centeredOrigRot = rotateBy(centeredOrig, -uElementRotation);
    vec2 origHalfSize = uOriginalSize * 0.5;
    float origRadius = uOriginalCornerRadius;

    // Faithful clip-after-blur: the original does clipOutline \u2192 stroke(blur),
    // but Skia applies clip at the canvas level AFTER the BlurMaskFilter
    // spreads alpha. So alpha that blurred OUTSIDE the shape is clipped away.
    // Our stroke shader clips before blur (discard sd>0), then blur spreads
    // alpha back outside \u2014 we must clip AGAIN here to match. Without this,
    // the highlight "leaks" outside the shape, making it brighter than the
    // original (which has zero contribution outside the clip region).
    float sd = sdShape(centeredOrigRot, origHalfSize, origRadius);
    float clipAA;
    if (uUseContinuousSdf > 0.5) {
        clipAA = sampleClipMask(centeredOrigRot, origHalfSize, origRadius);
    } else {
        clipAA = 1.0 - smoothstep(-0.5, 0.5, sd);
    }
    mask *= clipAA;
    if (mask < 0.001) discard;

    // Compute d (with sign) for Default + Ambient modes \u2014 needed for
    // Ambient's step(0,d) half-black-half-white split.
    float d = 0.0;  // signed dot(grad, normal) \u2014 0 for Plain mode
    float intensity;
    if (uHighlightMode < 1.5) {
        // Default + Ambient use the SDF gradient \xB7 normal.
        float gradRadius = min(origRadius * 1.5, min(origHalfSize.x, origHalfSize.y));
        vec2 grad = gradSdRoundedRect(centeredOrigRot, origHalfSize, gradRadius);
        vec2 normal = vec2(cos(uHighlightAngle), sin(uHighlightAngle));
        d = dot(grad, normal);
        intensity = pow(abs(d), uHighlightFalloff);
    } else {
        // Plain \u2014 no directional intensity (even stroke).
        intensity = 1.0;
    }

    float a = mask * uHighlightAlpha;

    if (uHighlightMode < 0.5) {
        // Default \u2014 Plus blend. Output premultiplied rgb (alpha=1 so blendFunc
        // (ONE, ONE) adds rgb directly).
        vec3 c = uHighlightColor.rgb * intensity * a;
        gl_FragColor = vec4(c, 1.0);
    } else if (uHighlightMode < 1.5) {
        // Ambient \u2014 PREMULTIPLIED SrcOver blend (renderer uses ONE, ONE_MINUS_SRC_ALPHA).
        // Faithful to AmbientHighlightShaderString:
        //   float t = step(0.0, d);  \u2190 half-black-half-white split
        // Bright side (d>=0): t=1 \u2192 white highlight. Dark side (d<0): t=0 \u2192
        // black overlay that reduces scene brightness via premultiplied SrcOver \u2192 3D sphere.
        // Output is premultiplied: vec4(color.rgb * t * i, i).
        // IMPORTANT: paint.color = White(0.38) is overridden by the shader.
        // The 0.38 does NOT scale the output; layer alpha (Highlight.alpha) is the
        // only modulation. For Ambient highlight, alpha = 1.0 (not 0.38).
        float t = step(0.0, d);
        float i = intensity * a;
        gl_FragColor = vec4(uHighlightColor.rgb * t * i, i);
    } else {
        // Plain \u2014 Plus blend, no intensity.
        vec3 c = uHighlightColor.rgb * a;
        gl_FragColor = vec4(c, 1.0);
    }
}
`
  );
  var STROKE_MASK_COMPOSITE_FRAGMENT_SHADER = (
    /* glsl */
    `
precision highp float;

uniform vec2  uCanvasSize;
uniform vec2  uOffset;
uniform vec2  uSize;
uniform vec4  uCornerRadii;
uniform sampler2D uStrokeMask;
uniform vec2  uMaskOffset;
uniform vec2  uMaskSize;
uniform vec4  uHighlightColor;
uniform float uHighlightAngle;
uniform float uHighlightFalloff;
uniform float uHighlightAlpha;
uniform float uHighlightMode;
uniform vec2  uOriginalSize;
uniform float uOriginalCornerRadius;
uniform vec2  uLayerScale;
uniform float uElementRotation;

${SDF_GLSL}

void main() {
    vec2 screenCoord = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);

    // Map screen coord \u2192 element-local ORIGINAL space (un-scale, un-rotate).
    // The stroke mask is drawn in original space (origSizeX \xD7 origSizeY + margin).
    // elementCenter is the same in scaled and original space (scaling is around center).
    vec2 elementCenter = uOffset + uSize * 0.5;
    vec2 centeredScreen = screenCoord - elementCenter;
    vec2 layerScale = max(uLayerScale, vec2(1e-4));
    vec2 centeredOrig = centeredScreen / layerScale;
    vec2 centeredOrigRot = rotateBy(centeredOrig, -uElementRotation);

    // Mask UV: map original-space coord \u2192 mask texture UV.
    // The mask was drawn with translate(margin, margin), so mask (0,0) =
    // element-local (-margin). Element-local coord 0..origSize maps to
    // mask UV (0+margin)/maskSize .. (origSize+margin)/maskSize.
    // uMaskOffset = margin (scalar, passed as vec2 for convenience).
    // uMaskSize = (origSize + 2*margin).
    vec2 origHalfSize = uOriginalSize * 0.5;
    vec2 maskTexCoord = centeredOrigRot + origHalfSize;  // 0..origSize (element-local)
    vec2 maskUv = (maskTexCoord + uMaskOffset) / uMaskSize;
    if (maskUv.x < 0.0 || maskUv.x > 1.0 || maskUv.y < 0.0 || maskUv.y > 1.0) discard;
    float mask = texture2D(uStrokeMask, maskUv).a;
    if (mask < 0.001) discard;

    float origRadius = uOriginalCornerRadius;

    // Compute d (with sign) for Default + Ambient modes \u2014 needed for
    // Ambient's step(0,d) half-black-half-white split.
    float d = 0.0;  // signed dot(grad, normal) \u2014 0 for Plain mode
    float intensity;
    if (uHighlightMode < 1.5) {
        float gradRadius = min(origRadius * 1.5, min(origHalfSize.x, origHalfSize.y));
        vec2 grad = gradSdRoundedRect(centeredOrigRot, origHalfSize, gradRadius);
        vec2 normal = vec2(cos(uHighlightAngle), sin(uHighlightAngle));
        d = dot(grad, normal);
        intensity = pow(abs(d), uHighlightFalloff);
    } else {
        intensity = 1.0;
    }

    float a = mask * uHighlightAlpha;
    if (uHighlightMode < 0.5) {
        gl_FragColor = vec4(uHighlightColor.rgb * intensity * a, 1.0);
    } else if (uHighlightMode < 1.5) {
        // Ambient \u2014 premultiplied SrcOver (renderer uses ONE, ONE_MINUS_SRC_ALPHA).
        // Faithful to AmbientHighlightShaderString:
        //   float t = step(0.0, d);  \u2190 bright/dark split
        // Bright side: t=1 \u2192 white highlight. Dark side: t=0 \u2192 dims scene.
        // Output is premultiplied: vec4(color.rgb * t * i, i).
        // paint.color(0.38) is overridden by shader; alpha should be 1.0 not 0.38.
        float t = step(0.0, d);
        float i = intensity * a;
        gl_FragColor = vec4(uHighlightColor.rgb * t * i, i);
    } else {
        gl_FragColor = vec4(uHighlightColor.rgb * a, 1.0);
    }
}
`
  );

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/shaders/inner-shadow.ts
  var INNER_SHADOW_MASK_COMPOSITE_FRAGMENT_SHADER = (
    /* glsl */
    `
precision highp float;

uniform vec2  uCanvasSize;
uniform vec2  uOffset;           // element top-left in canvas px (top-left origin) \u2014 SCALED rect
uniform vec2  uSize;             // element size in canvas px \u2014 SCALED
uniform vec4  uCornerRadii;      // (topLeft, topRight, bottomRight, bottomLeft) \u2014 SCALED
uniform sampler2D uInnerShadowMask; // Canvas2D-generated blurred ring mask
uniform vec2  uMaskOffset;       // margin in device px (for UV mapping: element-local \u2192 mask UV)
uniform vec2  uMaskSize;         // total mask size in device px (w+2*margin, h+2*margin)
uniform vec3  uInnerShadowColor; // shadow color RGB
uniform float uInnerShadowAlpha; // shadow alpha
// --- ORIGINAL-SPACE SDF clip (faithful to graphicsLayer { scaleX, scaleY }) ---
uniform vec2  uOriginalSize;        // element size in px (ORIGINAL, unscaled)
uniform float uOriginalCornerRadius; // corner radius in px (ORIGINAL, unscaled)
uniform vec2  uLayerScale;          // (scaleX, scaleY) from graphicsLayer
uniform float uElementRotation;     // rotation in radians (graphicsLayer rotationZ)

${SDF_GLSL}

void main() {
    vec2 screenCoord = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);

    // Map screen coord \u2192 element-local ORIGINAL space (un-scale, un-rotate).
    // The inner shadow mask is drawn in original space (origSize + margin).
    // elementCenter is the same in scaled and original space (scaling is
    // around center).
    vec2 elementCenter = uOffset + uSize * 0.5;
    vec2 centeredScreen = screenCoord - elementCenter;
    vec2 layerScale = max(uLayerScale, vec2(1e-4));
    vec2 centeredOrig = centeredScreen / layerScale;
    vec2 centeredOrigRot = rotateBy(centeredOrig, -uElementRotation);

    // SDF for shape clip \u2014 faithful to InnerShadowModifier.kt's final
    // clipOutline call before drawLayer. The original uses Skia's
    // geometric clip with smooth AA (sub-pixel transition).
    // We replicate with smoothstep \u2014 NO hard discard.
    vec2 origHalfSize = uOriginalSize * 0.5;
    float sd = sdShape(centeredOrigRot, origHalfSize, uOriginalCornerRadius);

    // Smooth clipAlpha: 1.0 fully inside (sd \u2264 0), smoothly fading
    // across the boundary (sd 0\u21921.5), 0.0 outside (sd \u2265 1.5).
    // The 1.5px transition width matches Skia's clipOutline AA behavior
    // \u2014 pixels at the exact boundary (sd=0) retain FULL intensity, with
    // a gentle fade that removes outward blur leakage smoothly.
    // This is NOT a hard discard \u2014 it's a smooth clip that matches the
    // original's geometric clipOutline exactly.
    float clipAlpha = 1.0 - smoothstep(0.0, 1.5, sd);

    // Skip truly invisible pixels for performance (not a visual clip)
    if (clipAlpha < 0.004) discard;

    // Map to mask UV: original-space coord \u2192 mask texture UV.
    vec2 maskTexCoord = centeredOrigRot + origHalfSize;  // 0..origSize (element-local)
    vec2 maskUv = (maskTexCoord + uMaskOffset) / uMaskSize;

    // Sample the mask texture. CLAMP_TO_EDGE wrapping handles UV values
    // slightly outside (0..1) gracefully \u2014 returns transparent at edges.
    float mask = texture2D(uInnerShadowMask, maskUv).a;

    // Skip truly invisible pixels for performance (not a visual clip)
    // Threshold is very low to avoid cutting off faint but visible shadow edges.
    if (mask < 0.003) discard;

    // Premultiplied SrcOver composite: shadowColor \xD7 mask \xD7 shadowAlpha \xD7 clipAlpha.
    // clipAlpha provides smooth shape-boundary transition (faithful to original's
    // clipOutline AA). Output is premultiplied (rgb = color * alpha).
    // Renderer uses gl.blendFunc(ONE, ONE_MINUS_SRC_ALPHA) \u2014 premultiplied SrcOver.
    float a = mask * uInnerShadowAlpha * clipAlpha;
    gl_FragColor = vec4(uInnerShadowColor * a, a);
}
`
  );

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/shaders/scene-bg.ts
  var VERTEX_SHADER = (
    /* glsl */
    `
attribute vec2 aPos;
void main() {
    gl_Position = vec4(aPos, 0.0, 1.0);
}
`
  );
  var WALLPAPER_FRAGMENT_SHADER = (
    /* glsl */
    `
precision highp float;

uniform sampler2D uBackdrop;
uniform vec2 uCanvasSize;
uniform vec2 uWallpaperSize;

${COVER_GLSL}

void main() {
    vec2 screenCoord = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);
    vec2 uv = coverUv(screenCoord);
    gl_FragColor = texture2D(uBackdrop, uv);
}
`
  );
  var COPY_FRAGMENT_SHADER = (
    /* glsl */
    `
precision highp float;

uniform sampler2D uTexture;
uniform vec2 uCanvasSize;

void main() {
    vec2 uv = vec2(gl_FragCoord.x / uCanvasSize.x, gl_FragCoord.y / uCanvasSize.y);
    gl_FragColor = texture2D(uTexture, uv);
}
`
  );
  var SOLID_FILL_FRAGMENT_SHADER = (
    /* glsl */
    `
precision highp float;

uniform vec4 uColor;

void main() {
    gl_FragColor = uColor;
}
`
  );
  var EL_FBO_CROP_FRAGMENT_SHADER = (
    /* glsl */
    `
precision highp float;

uniform sampler2D uTexture;
uniform vec2 uSrcOffset;   // region top-left in source texture (top-left origin, device px)
uniform vec2 uSrcSize;     // fullscreen source texture size (device px)
uniform vec2 uDstSize;     // destination (small) FBO size = region size (device px)

void main() {
    vec2 localTopLeft = vec2(gl_FragCoord.x, uDstSize.y - gl_FragCoord.y);
    vec2 srcTopLeft = uSrcOffset + localTopLeft;
    vec2 uv = vec2(srcTopLeft.x / uSrcSize.x, 1.0 - srcTopLeft.y / uSrcSize.y);
    gl_FragColor = texture2D(uTexture, uv);
}
`
  );
  var EL_FBO_COMPOSITE_FRAGMENT_SHADER = (
    /* glsl */
    `
precision highp float;

uniform sampler2D uTexture;
uniform vec2 uCanvasSize;     // bound FBO size in device px
uniform vec2 uElementCenter;  // element center (top-left origin, device px)
uniform vec2 uElementSize;    // SCALED element size (device px)
uniform float uRotation;      // element rotation in radians
uniform vec2 uSrcSize;        // elFbo texture size (baseline, device px)

// rotateBy \u2014 standard 2D rotation (counter-clockwise, math convention).
// Used consistently in Y-down (top-left origin) space \u2014 the Y-flip cancels
// because both element shader and composite use the same convention.
vec2 rotateBy(vec2 v, float angle) {
    float c = cos(angle);
    float s = sin(angle);
    return vec2(v.x * c - v.y * s, v.x * s + v.y * c);
}

void main() {
    // gl_FragCoord: bottom-left origin. Convert to top-left origin (Y-down).
    vec2 fragTopLeft = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);
    // Offset from element center (Y-down, screen px)
    vec2 centered = fragTopLeft - uElementCenter;
    // Un-rotate: screen \u2192 local (undo the element's rotation).
    // When rot\u22480 (common case \u2014 all non-GP elements), skip rotateBy entirely
    // (4 mul + cos/sin per fragment saved). This makes the composite shader
    // as cheap as the old 1:1 blit for the vast majority of elements.
    vec2 localCentered;
    if (abs(uRotation) > 0.001) {
        localCentered = rotateBy(centered, -uRotation);
    } else {
        localCentered = centered;
    }
    // Un-scale: screen px \u2192 elFbo px (baseline). Ratio = srcSize / elementSize.
    vec2 srcCentered = localCentered * uSrcSize / uElementSize;
    // Bounds check: discard if outside elFbo
    vec2 halfSrc = uSrcSize * 0.5;
    if (abs(srcCentered.x) > halfSrc.x || abs(srcCentered.y) > halfSrc.y) discard;
    // Map to UV. elFbo texture: UV (0,0) = gl_FragCoord (0,0) = bottom-left.
    // srcCentered is Y-down (top-left origin). Flip Y for texture UV.
    vec2 uv = vec2(
        (srcCentered.x + halfSrc.x) / uSrcSize.x,
        (halfSrc.y - srcCentered.y) / uSrcSize.y
    );
    gl_FragColor = texture2D(uTexture, uv);
}
`
  );
  var COLOR_CONTROLS_FRAGMENT_SHADER = (
    /* glsl */
    `
precision highp float;

uniform sampler2D uTexture;
uniform vec2 uTexSize;
uniform float uBrightness;
uniform float uContrast;
uniform float uSaturation;

void main() {
    vec2 uv = vec2(gl_FragCoord.x / uTexSize.x, gl_FragCoord.y / uTexSize.y);
    vec4 c = texture2D(uTexture, uv);
    float invSat = 1.0 - uSaturation;
    float r = 0.213 * invSat;
    float g = 0.715 * invSat;
    float b = 0.072 * invSat;
    float t = (0.5 - uContrast * 0.5 + uBrightness);
    float cs = uContrast * uSaturation;
    float cr = uContrast * r;
    float cg = uContrast * g;
    float cb = uContrast * b;
    vec3 outc;
    outc.r = (cr + cs) * c.r + cg * c.g + cb * c.b + t;
    outc.g = cr * c.r + (cg + cs) * c.g + cb * c.b + t;
    outc.b = cr * c.r + cg * c.g + (cb + cs) * c.b + t;
    gl_FragColor = vec4(outc, c.a);
}
`
  );
  var SCENE_TINT_FRAGMENT_SHADER = (
    /* glsl */
    `
precision highp float;

uniform sampler2D uTexture;
uniform vec2 uCanvasSize;
uniform vec3 uTintColor;   // rgb 0..1 (accentColor)

// ColorFilter.tint(color, blendMode = BlendMode.SrcIn):
//   result.rgb = src.rgb (the tint color)
//   result.a   = dst.a * src.a
// SrcIn replaces the destination's RGB with the tint color while
// preserving its alpha \u2014 opaque content becomes solid tint, transparent
// areas stay transparent. This matches Compose's ColorFilter.tint default.
void main() {
    vec2 uv = vec2(gl_FragCoord.x / uCanvasSize.x, gl_FragCoord.y / uCanvasSize.y);
    vec4 src = texture2D(uTexture, uv);
    gl_FragColor = vec4(uTintColor, src.a);
}
`
  );

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/shaders/scene-fg.ts
  var FOREGROUND_FRAGMENT_SHADER = (
    /* glsl */
    `
precision highp float;

uniform sampler2D uTexture;
uniform vec2 uCanvasSize;
uniform vec2 uOffset;   // foreground texture top-left in canvas px (top-left origin) \u2014 SCALED rect
uniform vec2 uSize;     // foreground texture size in canvas px \u2014 SCALED
uniform vec4 uCornerRadii;  // capsule radii (topLeft, topRight, bottomRight, bottomLeft) in px \u2014 SCALED
uniform float uAlpha;   // global alpha multiplier (used for press fade)
// --- ORIGINAL-SPACE SDF clip (faithful to graphicsLayer { scaleX, scaleY }) ---
// The original wraps everything (text included) in a graphicsLayer clipped to
// the capsule shape, THEN scales the layer. So the clip shape is the ORIGINAL
// capsule, not the stretched one. We compute the clip SDF in original space so
// a stretched button keeps correct capsule clipping (no corner bleed). The
// texture UV still uses the scaled rect (uOffset/uSize) since the foreground
// texture is rendered at the element's scaled on-screen size.
uniform vec2  uOriginalSize;        // element size in px (ORIGINAL, unscaled)
uniform float uOriginalCornerRadius; // corner radius in px (ORIGINAL, unscaled)
uniform vec2  uLayerScale;          // (scaleX, scaleY) from graphicsLayer

${SDF_GLSL}

void main() {
    // gl_FragCoord is bottom-left origin in WebGL framebuffer space.
    // Flip Y to get top-left origin (matching CSS / 2D canvas convention).
    vec2 screenCoord = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);
    vec2 localCoord = screenCoord - uOffset;
    // Scissor to the (scaled) foreground rectangle.
    if (localCoord.x < 0.0 || localCoord.x > uSize.x ||
        localCoord.y < 0.0 || localCoord.y > uSize.y) {
        discard;
    }

    // --- Capsule clip in ORIGINAL space (faithful to graphicsLayer clip) ---
    // elementCenter is the SAME for scaled and original rects (scaling is
    // around the center). Map screen coord \u2192 original space for the SDF so
    // the clip shape is the original capsule, not the stretched one.
    vec2 elementCenter = uOffset + uSize * 0.5;
    vec2 centeredScreen = screenCoord - elementCenter;
    vec2 layerScale = max(uLayerScale, vec2(1e-4));
    vec2 centeredOrig = centeredScreen / layerScale;
    vec2 origHalfSize = uOriginalSize * 0.5;
    float clipAlpha;
    if (uUseContinuousSdf > 0.5) {
        float mask = sampleClipMask(centeredOrig, origHalfSize, uOriginalCornerRadius);
        if (mask < 0.01) discard;
        clipAlpha = mask;
    } else {
        float sdClip = sdClipShape(centeredOrig, origHalfSize, uOriginalCornerRadius);
        if (sdClip > 0.5) discard;
        clipAlpha = 1.0 - smoothstep(-0.5, 0.5, sdClip);
    }

    // The texture is uploaded from a 2D canvas with UNPACK_FLIP_Y_WEBGL=false,
    // so texture row 0 (= v=0) is the TOP row of the source canvas. Combined
    // with the Y flip above, uv.y=0 corresponds to the top of the button rect
    // (which is what we want \u2014 text drawn at the middle of the source canvas
    // appears at the middle of the button).
    //
    // The texture is uploaded with UNPACK_PREMULTIPLY_ALPHA_WEBGL=true, so
    // c is already in premultiplied form (c.rgb <= c.a). We scale both
    // rgb and a by uAlpha * clipAlpha and output premultiplied rgba, paired
    // with blendFunc(ONE, ONE_MINUS_SRC_ALPHA) at the draw site.
    vec2 uv = localCoord / uSize;
    vec4 c = texture2D(uTexture, uv);
    float a = c.a * uAlpha * clipAlpha;
    gl_FragColor = vec4(c.rgb * uAlpha * clipAlpha, a);
}
`
  );
  var PLAIN_RECT_FRAGMENT_SHADER = (
    /* glsl */
    `
precision highp float;

uniform vec2  uCanvasSize;
uniform vec2  uOffset;
uniform vec2  uSize;
uniform vec4  uCornerRadii;
uniform vec4  uColor;       // rgba (premultiplied not required; alpha used as-is)

${SDF_GLSL}

void main() {
    vec2 screenCoord = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);
    vec2 localCoord = screenCoord - uOffset;
    vec2 halfSize = uSize * 0.5;
    vec2 centeredCoord = localCoord - halfSize;

    float radius = radiusAt(centeredCoord, uCornerRadii);
    float alpha;
    if (uUseContinuousSdf > 0.5) {
        float mask = sampleClipMask(centeredCoord, halfSize, radius);
        if (mask < 0.01) discard;
        alpha = mask;
    } else {
        float sdClip = sdClipShape(centeredCoord, halfSize, radius);
        if (sdClip > 0.5) discard;
        alpha = 1.0 - smoothstep(-0.5, 0.5, sdClip);
    }
    gl_FragColor = vec4(uColor.rgb, uColor.a * alpha);
}
`
  );
  var PROGRESSIVE_BLUR_FRAGMENT_SHADER = (
    /* glsl */
    `
precision highp float;

uniform sampler2D uBackdrop;
uniform vec2  uCanvasSize;
uniform vec2  uWallpaperSize;
uniform vec2  uOffset;          // band top-left in canvas px (top-left origin)
uniform vec2  uSize;            // band size in canvas px
uniform float uBlurRadius;      // px in canvas space
uniform vec4  uTintColor;       // rgba
uniform float uTintIntensity;   // 0..1

${COVER_GLSL}

// 9-tap poisson disc \u2014 offsets are inlined because GLSL ES 1.00 (WebGL 1)
// does not support array constructors or const-array initializers.
// The offsets are normalized (unit disc), multiplied by step (radius in UV).
vec4 sampleBackdrop(vec2 canvasPx, float radius) {
    vec2 uvScale = canvasPxToUvScale();
    vec2 uv = coverUv(canvasPx);
    vec2 st = radius * uvScale;
    vec4 sum = vec4(0.0);
    sum += texture2D(uBackdrop, uv + vec2( 0.0000,  0.0000) * st);
    sum += texture2D(uBackdrop, uv + vec2( 0.5000,  0.0000) * st);
    sum += texture2D(uBackdrop, uv + vec2(-0.5000,  0.0000) * st);
    sum += texture2D(uBackdrop, uv + vec2( 0.0000,  0.5000) * st);
    sum += texture2D(uBackdrop, uv + vec2( 0.0000, -0.5000) * st);
    sum += texture2D(uBackdrop, uv + vec2( 0.3536,  0.3536) * st);
    sum += texture2D(uBackdrop, uv + vec2(-0.3536,  0.3536) * st);
    sum += texture2D(uBackdrop, uv + vec2( 0.3536, -0.3536) * st);
    sum += texture2D(uBackdrop, uv + vec2(-0.3536, -0.3536) * st);
    return sum / 9.0;
}

void main() {
    vec2 screenCoord = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);
    vec2 localCoord = screenCoord - uOffset;
    // Outside the band \u2014 nothing to draw.
    if (localCoord.x < 0.0 || localCoord.x > uSize.x ||
        localCoord.y < 0.0 || localCoord.y > uSize.y) {
        discard;
    }

    // Alpha mask: opaque at top (coord.y = size.y, i.e. BOTTOM in top-left
    // origin = size.y in AGSL coord), transparent at bottom. Matches the
    // Kotlin smoothstep(size.y, size.y * 0.5, coord.y).
    float a = smoothstep(uSize.y, uSize.y * 0.5, localCoord.y);

    // Sample the (cover-fit) backdrop at the canvas pixel, blurred.
    vec4 blurred = sampleBackdrop(screenCoord, uBlurRadius);

    // Faithful to AlphaMask shader: mix(content * blurAlpha, tint * tintAlpha, tintIntensity)
    // This is PREMULTIPLIED (rgb already scaled by alpha). The renderer uses
    // premultiplied alpha blending for the progressive blur pass, so we output
    // premultiplied rgb with the mask alpha.
    vec3 premulRgb = mix(blurred.rgb * a, uTintColor.rgb * a, uTintIntensity);
    gl_FragColor = vec4(premulRgb, a);
}
`
  );

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/shaders/separable-blur.ts
  function generateGaussianKernel1D(tapCount) {
    if (tapCount <= 1) return [{ offset: 0, weight: 1 }];
    const taps = [];
    const half = Math.floor(tapCount / 2);
    const maxOffset = 3;
    let totalW = 0;
    for (let i = 0; i < tapCount; i++) {
      const t = tapCount % 2 === 1 ? i - half : i - half + 0.5;
      const offset = t / half * maxOffset;
      const w = Math.exp(-0.5 * offset * offset);
      taps.push({ offset, weight: w });
      totalW += w;
    }
    if (totalW > 0) {
      for (const t of taps) t.weight /= totalW;
    }
    return taps;
  }
  function generateSeparableBlurShader(tapCount, direction) {
    const kernel = generateGaussianKernel1D(tapCount);
    const isH = direction === "horizontal";
    const dirVec = isH ? "vec2(1.0, 0.0)" : "vec2(0.0, 1.0)";
    let sampleCode = "";
    if (kernel.length === 1) {
      sampleCode = `    gl_FragColor = texture2D(uTexture, uv);
`;
    } else {
      sampleCode = `    vec3 rgbSum = vec3(0.0);
    float rgbW = 0.0;
`;
      for (const t of kernel) {
        const off = t.offset.toFixed(6);
        const w = t.weight.toFixed(8);
        sampleCode += `    { vec4 s = texture2D(uTexture, uv + ${dirVec} * ${off} * pxToUv); float aw = s.a * ${w}; rgbSum += s.rgb * aw; rgbW += aw; }
`;
      }
      sampleCode += `    float origA = texture2D(uTexture, uv).a;
    gl_FragColor = vec4(rgbW > 0.001 ? rgbSum / rgbW : vec3(0.0), origA);
`;
    }
    return (
      /* glsl */
      `
precision highp float;

uniform sampler2D uTexture;
uniform vec2 uTexSize;
uniform float uRadius;

void main() {
    vec2 uv = vec2(gl_FragCoord.x / uTexSize.x, gl_FragCoord.y / uTexSize.y);
    if (uRadius < 0.5) {
        gl_FragColor = texture2D(uTexture, uv);
        return;
    }
    vec2 pxToUv = vec2(uRadius / uTexSize.x, uRadius / uTexSize.y);
${sampleCode}}
`
    );
  }
  function computeBlur1DTapCount(blurRadiusPx) {
    if (blurRadiusPx < 0.5) return 1;
    const sigma = blurRadiusPx * 0.57735 + 0.5;
    const n = 2 * Math.ceil(3 * sigma) + 1;
    return Math.min(33, Math.max(1, n));
  }
  function generateHighlightBlurKernel1D(tapCount) {
    if (tapCount <= 1) return [{ offset: 0, weight: 1 }];
    const taps = [];
    const half = Math.floor(tapCount / 2);
    let totalW = 0;
    for (let i = 0; i < tapCount; i++) {
      const offset = i - half;
      const w = Math.exp(-0.5 * offset * offset);
      taps.push({ offset, weight: w });
      totalW += w;
    }
    if (totalW > 0) {
      for (const t of taps) t.weight /= totalW;
    }
    return taps;
  }
  function generateHighlightBlurShader(tapCount, direction) {
    const kernel = generateHighlightBlurKernel1D(tapCount);
    const isH = direction === "horizontal";
    const dirVec = isH ? "vec2(1.0, 0.0)" : "vec2(0.0, 1.0)";
    let sampleCode = "";
    if (kernel.length === 1) {
      sampleCode = `    gl_FragColor = texture2D(uTexture, uv);
`;
    } else {
      sampleCode = `    float aSum = 0.0;
`;
      for (const t of kernel) {
        const off = t.offset.toFixed(6);
        const w = t.weight.toFixed(8);
        sampleCode += `    aSum += texture2D(uTexture, uv + ${dirVec} * ${off} * pxToUv).a * ${w};
`;
      }
      sampleCode += `    gl_FragColor = vec4(0.0, 0.0, 0.0, aSum);
`;
    }
    return (
      /* glsl */
      `
precision highp float;

uniform sampler2D uTexture;
uniform vec2 uTexSize;
uniform float uRadius;  // Gaussian sigma in pixels (Android BlurMaskFilter semantics)

void main() {
    vec2 uv = vec2(gl_FragCoord.x / uTexSize.x, gl_FragCoord.y / uTexSize.y);
    if (uRadius < 0.01) {
        gl_FragColor = texture2D(uTexture, uv);
        return;
    }
    // pxToUv converts a pixel offset to a UV offset. offset (in \u03C3 units) *
    // sigma_px = pixel offset; / uTexSize = UV offset.
    vec2 pxToUv = vec2(uRadius / uTexSize.x, uRadius / uTexSize.y);
${sampleCode}}
`
    );
  }
  function computeHighlightBlurTapCount(sigmaPx) {
    if (sigmaPx < 0.01) return 1;
    const n = 2 * Math.ceil(3 * sigmaPx) + 1;
    return Math.min(33, Math.max(3, n));
  }

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/shaders/kawase-blur.ts
  var MAX_KAWASE_ITERS = 8;
  var MIN_KAWASE_ITERS = 2;
  function kawaseIterationsForRadius(radius, quality = 1) {
    let base;
    if (radius < 1.5) base = 2;
    else if (radius < 3) base = 3;
    else if (radius < 6) base = 4;
    else if (radius < 12) base = 6;
    else base = 8;
    const scaled = Math.round(base * quality);
    return Math.max(MIN_KAWASE_ITERS, Math.min(MAX_KAWASE_ITERS, scaled));
  }
  function generateKawaseBlurShader() {
    return (
      /* glsl */
      `precision highp float;
uniform sampler2D uTexture;
uniform vec2 uTexSize;
uniform float uRadius;      // target Gaussian \u03C3 (px) \u2014 Kawase accumulates to match
uniform float uIteration;   // current iteration index, 0-based
uniform float uTotalIters;  // total iteration count N
void main() {
    vec2 uv = vec2(gl_FragCoord.x / uTexSize.x, gl_FragCoord.y / uTexSize.y);
    vec2 pxToUv = vec2(1.0 / uTexSize.x, 1.0 / uTexSize.y);
    // d_max = radius \xD7 \u221A(6N / ((N+1)(2N+1))) \u2014 variance-matched to Gaussian \u03C3.
    // d_i = d_max \xD7 (i+1)/N.
    float N = uTotalIters;
    float dMax = uRadius * sqrt(6.0 * N / ((N + 1.0) * (2.0 * N + 1.0)));
    float d = dMax * (uIteration + 1.0) / N;
    vec2 off = vec2(d, d) * pxToUv;
    // 4 diagonal taps (Kawase original): equal weight 0.25 each.
    vec4 s1 = texture2D(uTexture, uv + off);
    vec4 s2 = texture2D(uTexture, uv - off);
    vec4 s3 = texture2D(uTexture, uv + vec2(off.x, -off.y));
    vec4 s4 = texture2D(uTexture, uv + vec2(-off.x, off.y));
    // Premul-aware: RGB weighted by sample alpha, alpha = center.
    float aw1 = s1.a, aw2 = s2.a, aw3 = s3.a, aw4 = s4.a;
    float awSum = aw1 + aw2 + aw3 + aw4;
    vec3 rgb = awSum > 0.001 ? (s1.rgb * aw1 + s2.rgb * aw2 + s3.rgb * aw3 + s4.rgb * aw4) / awSum : vec3(0.0);
    float origA = texture2D(uTexture, uv).a;
    gl_FragColor = vec4(rgb, origA);
}
`
    );
  }

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/gl-utils.ts
  function compileShader(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error("Shader compile error: " + log);
    }
    return sh;
  }
  function createProgram(gl, vsSrc, fsSrc) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error("Program link error: " + log);
    }
    return p;
  }
  function wrapText(ctx, text, maxW) {
    const tokens = text.split(/\s+/).filter((t) => t.length > 0);
    const lines = [];
    let cur = "";
    for (const token of tokens) {
      const test = cur ? cur + " " + token : token;
      if (ctx.measureText(test).width <= maxW) {
        cur = test;
        continue;
      }
      if (cur) {
        lines.push(cur);
        cur = "";
      }
      for (const ch of token) {
        const t = cur + ch;
        if (ctx.measureText(t).width <= maxW || !cur) {
          cur = t;
        } else {
          lines.push(cur);
          cur = ch;
        }
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }
  function easeIn(t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    const x1 = 0.42, y1 = 0, x2 = 1, y2 = 1;
    let s = t;
    for (let i = 0; i < 8; i++) {
      const xs = 3 * (1 - s) * (1 - s) * s * x1 + 3 * (1 - s) * s * s * x2 + s * s * s;
      const dxs = 3 * (1 - s) * (1 - s) * x1 + 6 * (1 - s) * s * (x2 - x1) + 3 * s * s * (1 - x2);
      if (Math.abs(xs - t) < 1e-3) break;
      if (Math.abs(dxs) < 1e-6) break;
      s -= (xs - t) / dxs;
      s = Math.max(0, Math.min(1, s));
    }
    return 3 * (1 - s) * (1 - s) * s * y1 + 3 * (1 - s) * s * s * y2 + s * s * s;
  }

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/perf-monitor.ts
  var PerfMonitor = class {
    constructor() {
      /** Master toggle. When false, all increment methods are no-ops. */
      this.enabled = false;
      this.gl = null;
      // --- Frame timing ring buffer ---
      this.HISTORY_SIZE = 240;
      this.frameTimes = new Float32Array(this.HISTORY_SIZE);
      this.frameTimeIdx = 0;
      this.frameTimeCount = 0;
      /** Timestamp of the previous frameEnd() call. Used to compute the frame
       *  INTERVAL (frame-to-frame), NOT the render duration. The render duration
       *  (frameEnd - frameStart) can be sub-millisecond for a fast render, which
       *  would inflate FPS to thousands. The interval between consecutive
       *  frameEnd calls reflects the true rendered frame rate (≈16.67ms = 60fps
       *  when rendering every rAF tick). */
      this.prevFrameEndTime = 0;
      this.totalFrames = 0;
      this.jank16Count = 0;
      this.jank33Count = 0;
      // --- Per-frame counters (in-progress frame) ---
      this.drawCalls = 0;
      this.glassElements = 0;
      this.perElementFboCount = 0;
      this.pingPongCount = 0;
      this.nonGlassElements = 0;
      this.blurPasses = 0;
      this.dirtyElements = 0;
      this.totalElements = 0;
      this.cachedElements = 0;
      // --- Last completed frame counters (captured at frameEnd) ---
      this.lastDrawCalls = 0;
      this.lastGlassElements = 0;
      this.lastPerElementFboCount = 0;
      this.lastPingPongCount = 0;
      this.lastNonGlassElements = 0;
      this.lastBlurPasses = 0;
      this.lastDirtyElements = 0;
      this.lastTotalElements = 0;
      this.lastCachedElements = 0;
      this.lastFrameTimeMs = 0;
      // --- Static GPU info (collected lazily on first frameStart) ---
      this.gpuInfoCollected = false;
      this.gpuVendor = "";
      this.gpuRenderer = "";
      this.maxTextureSize = 0;
      this.extensionCount = 0;
      /** Set by the renderer after probing WEBGL_debug_renderer_info.
       *  Surfaced in the snapshot so the overlay can warn the user that the
       *  baseline cost is CPU rasterization (not shader passes). */
      this.isSoftwareRenderer = false;
      // --- Canvas info (pushed by the renderer each frame) ---
      this.canvasCssW = 0;
      this.canvasCssH = 0;
      this.canvasDevW = 0;
      this.canvasDevH = 0;
      this.dpr = 0;
      this.deviceDpr = 0;
    }
    attachGl(gl) {
      this.gl = gl;
    }
    collectGpuInfo() {
      if (!this.gl || this.gpuInfoCollected) return;
      this.gpuInfoCollected = true;
      const gl = this.gl;
      const dbgExt = gl.getExtension("WEBGL_debug_renderer_info");
      try {
        this.gpuVendor = dbgExt ? String(gl.getParameter(dbgExt.UNMASKED_VENDOR_WEBGL) || "") : String(gl.getParameter(gl.VENDOR) || "");
        this.gpuRenderer = dbgExt ? String(gl.getParameter(dbgExt.UNMASKED_RENDERER_WEBGL) || "") : String(gl.getParameter(gl.RENDERER) || "");
        this.maxTextureSize = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 0;
        const exts = gl.getSupportedExtensions() || [];
        this.extensionCount = exts.length;
      } catch (e) {
      }
    }
    /** Called at the top of render(). Resets per-frame counters.
     *  NOTE: we no longer record a start timestamp here — the frame time is
     *  measured as the interval between consecutive frameEnd() calls, which
     *  reflects the true rendered frame rate rather than the render duration. */
    frameStart() {
      if (!this.enabled) return;
      this.collectGpuInfo();
      this.drawCalls = 0;
      this.glassElements = 0;
      this.perElementFboCount = 0;
      this.pingPongCount = 0;
      this.nonGlassElements = 0;
      this.blurPasses = 0;
      this.dirtyElements = 0;
      this.totalElements = 0;
      this.cachedElements = 0;
    }
    /** Called at the bottom of render(). Records the frame INTERVAL (time
     *  since the previous frameEnd) into the ring buffer + captures counters.
     *
     *  Why interval not duration: render duration = frameEnd - frameStart can
     *  be sub-millisecond (0.2ms) for a fast render → 1000/0.2 = 5000 FPS,
     *  which is meaningless. The interval between consecutive frameEnd calls
     *  reflects how often frames are actually produced: ≈16.67ms = 60fps when
     *  rendering every rAF tick, larger when frames are skipped.
     *
     *  Gap filtering: if the interval > 500ms, the page was likely idle
     *  (needsRedraw was false for a while) — this isn't a real frame-to-frame
     *  interval, so we skip recording it in the timing ring buffer (but still
     *  count the frame + capture its counters). This keeps avg/min/max clean. */
    frameEnd() {
      if (!this.enabled) return;
      const now = performance.now();
      const dt = this.prevFrameEndTime > 0 ? now - this.prevFrameEndTime : 0;
      this.prevFrameEndTime = now;
      if (dt > 0 && dt <= 500) {
        this.lastFrameTimeMs = dt;
        this.frameTimes[this.frameTimeIdx] = dt;
        this.frameTimeIdx = (this.frameTimeIdx + 1) % this.HISTORY_SIZE;
        if (this.frameTimeCount < this.HISTORY_SIZE) this.frameTimeCount++;
        if (dt > 16.67) this.jank16Count++;
        if (dt > 33.33) this.jank33Count++;
      }
      this.totalFrames++;
      this.lastDrawCalls = this.drawCalls;
      this.lastGlassElements = this.glassElements;
      this.lastPerElementFboCount = this.perElementFboCount;
      this.lastPingPongCount = this.pingPongCount;
      this.lastNonGlassElements = this.nonGlassElements;
      this.lastBlurPasses = this.blurPasses;
      this.lastDirtyElements = this.dirtyElements;
      this.lastTotalElements = this.totalElements;
      this.lastCachedElements = this.cachedElements;
    }
    // --- Counter increments (called from renderer methods).
    //     Single boolean check → ~zero overhead when disabled. ---
    incDrawCall(n = 1) {
      if (this.enabled) this.drawCalls += n;
    }
    incGlassElement() {
      if (this.enabled) this.glassElements++;
    }
    incPerElementFbo() {
      if (this.enabled) this.perElementFboCount++;
    }
    incPingPong() {
      if (this.enabled) this.pingPongCount++;
    }
    incNonGlass() {
      if (this.enabled) this.nonGlassElements++;
    }
    incBlurPass() {
      if (this.enabled) this.blurPasses++;
    }
    incDirty() {
      if (this.enabled) this.dirtyElements++;
    }
    incTotal() {
      if (this.enabled) this.totalElements++;
    }
    incCachedElement() {
      if (this.enabled) this.cachedElements++;
    }
    /** Reset all accumulated stats (timing + counters + jank). */
    reset() {
      this.frameTimes.fill(0);
      this.frameTimeIdx = 0;
      this.frameTimeCount = 0;
      this.prevFrameEndTime = 0;
      this.totalFrames = 0;
      this.jank16Count = 0;
      this.jank33Count = 0;
      this.lastFrameTimeMs = 0;
      this.lastDrawCalls = 0;
      this.lastGlassElements = 0;
      this.lastPerElementFboCount = 0;
      this.lastPingPongCount = 0;
      this.lastSkipPingPongCount = 0;
      this.lastNonGlassElements = 0;
      this.lastBlurPasses = 0;
      this.lastDirtyElements = 0;
      this.lastTotalElements = 0;
      this.lastCachedElements = 0;
    }
    getSnapshot() {
      const history = [];
      if (this.frameTimeCount > 0) {
        if (this.frameTimeCount < this.HISTORY_SIZE) {
          for (let i = 0; i < this.frameTimeCount; i++) history.push(this.frameTimes[i]);
        } else {
          for (let i = 0; i < this.HISTORY_SIZE; i++) {
            history.push(this.frameTimes[(this.frameTimeIdx + i) % this.HISTORY_SIZE]);
          }
        }
      }
      let sum = 0, mn = Infinity, mx = 0;
      for (const v of history) {
        sum += v;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      const n = history.length;
      const avg = n > 0 ? sum / n : 0;
      const last = this.lastFrameTimeMs;
      return {
        frameTimeMs: last,
        avgFrameTimeMs: avg,
        minFrameTimeMs: n > 0 ? mn : 0,
        maxFrameTimeMs: n > 0 ? mx : 0,
        fps: last > 0 ? 1e3 / last : 0,
        avgFps: avg > 0 ? 1e3 / avg : 0,
        jank16Count: this.jank16Count,
        jank33Count: this.jank33Count,
        totalFrames: this.totalFrames,
        drawCalls: this.lastDrawCalls,
        glassElements: this.lastGlassElements,
        perElementFboCount: this.lastPerElementFboCount,
        pingPongCount: this.lastPingPongCount,
        nonGlassElements: this.lastNonGlassElements,
        blurPasses: this.lastBlurPasses,
        dirtyElements: this.lastDirtyElements,
        totalElements: this.lastTotalElements,
        cachedElements: this.lastCachedElements,
        gpuVendor: this.gpuVendor,
        gpuRenderer: this.gpuRenderer,
        maxTextureSize: this.maxTextureSize,
        extensionCount: this.extensionCount,
        isSoftwareRenderer: this.isSoftwareRenderer,
        canvasCssW: this.canvasCssW,
        canvasCssH: this.canvasCssH,
        canvasDevW: this.canvasDevW,
        canvasDevH: this.canvasDevH,
        dpr: this.dpr,
        deviceDpr: this.deviceDpr,
        pixelsPerFrame: this.canvasDevW * this.canvasDevH,
        history,
        timestamp: performance.now()
      };
    }
  };

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-fbo.ts
  var fboMethods = {
    createFBO(w, h) {
      const gl = this.gl;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { fb, tex };
    },
    resizeFBOs(w, h, force = false) {
      if (!force && this.fboW === w && this.fboH === h && this.fboA && this.fboB) return;
      const gl = this.gl;
      if (this.fboA) gl.deleteFramebuffer(this.fboA);
      if (this.fboATex) gl.deleteTexture(this.fboATex);
      if (this.fboB) gl.deleteFramebuffer(this.fboB);
      if (this.fboBTex) gl.deleteTexture(this.fboBTex);
      const a = this.createFBO(w, h);
      const b = this.createFBO(w, h);
      this.fboA = a.fb;
      this.fboATex = a.tex;
      this.fboB = b.fb;
      this.fboBTex = b.tex;
      if (this.tabsBackdropFbo) gl.deleteFramebuffer(this.tabsBackdropFbo);
      if (this.tabsBackdropTex) gl.deleteTexture(this.tabsBackdropTex);
      const tb = this.createFBO(w, h);
      this.tabsBackdropFbo = tb.fb;
      this.tabsBackdropTex = tb.tex;
      this.tabsBackdropDirty = true;
      if (this.wallpaperBlurFbo) gl.deleteFramebuffer(this.wallpaperBlurFbo);
      if (this.wallpaperBlurTex) gl.deleteTexture(this.wallpaperBlurTex);
      if (this.blurFboA) gl.deleteFramebuffer(this.blurFboA);
      if (this.blurFboATex) gl.deleteTexture(this.blurFboATex);
      if (this.blurFboB) gl.deleteFramebuffer(this.blurFboB);
      if (this.blurFboBTex) gl.deleteTexture(this.blurFboBTex);
      if (this.dsBlurFboA) gl.deleteFramebuffer(this.dsBlurFboA);
      if (this.dsBlurFboATex) gl.deleteTexture(this.dsBlurFboATex);
      if (this.dsBlurFboB) gl.deleteFramebuffer(this.dsBlurFboB);
      if (this.dsBlurFboBTex) gl.deleteTexture(this.dsBlurFboBTex);
      for (const lvl of this.dsBlurLevels) {
        gl.deleteFramebuffer(lvl.fboA);
        gl.deleteTexture(lvl.texA);
        gl.deleteFramebuffer(lvl.fboB);
        gl.deleteTexture(lvl.texB);
      }
      this.dsBlurLevels = [];
      const rawDs = Math.max(1, this.blurDownsample);
      const ds = rawDs <= 1 ? 1 : Math.max(1, Math.min(rawDs * (this.dpr || 1), 64));
      this.effectiveBlurDownsample = ds;
      const ge = this.createFBO(w, h);
      const ba = this.createFBO(w, h);
      const bb = this.createFBO(w, h);
      this.wallpaperBlurFbo = ge.fb;
      this.wallpaperBlurTex = ge.tex;
      this.blurFboA = ba.fb;
      this.blurFboATex = ba.tex;
      this.blurFboB = bb.fb;
      this.blurFboBTex = bb.tex;
      const legacyW = Math.max(1, Math.floor(w / ds));
      const legacyH = Math.max(1, Math.floor(h / ds));
      const legacyA = this.createFBO(legacyW, legacyH);
      const legacyB = this.createFBO(legacyW, legacyH);
      this.dsBlurFboA = legacyA.fb;
      this.dsBlurFboATex = legacyA.tex;
      this.dsBlurFboB = legacyB.fb;
      this.dsBlurFboBTex = legacyB.tex;
      this.dsBlurFboW = legacyW;
      this.dsBlurFboH = legacyH;
      const levels = [];
      for (let d = 1; d <= ds; d *= 2) levels.push(d);
      for (const d of levels) {
        const lw = Math.max(1, Math.floor(w / d));
        const lh = Math.max(1, Math.floor(h / d));
        const la = this.createFBO(lw, lh);
        const lb = this.createFBO(lw, lh);
        this.dsBlurLevels.push({ ds: d, fboA: la.fb, texA: la.tex, fboB: lb.fb, texB: lb.tex, w: lw, h: lh });
      }
      if (this.highlightMaskFbo) gl.deleteFramebuffer(this.highlightMaskFbo);
      if (this.highlightMaskTex) gl.deleteTexture(this.highlightMaskTex);
      const hm = this.createFBO(w, h);
      this.highlightMaskFbo = hm.fb;
      this.highlightMaskTex = hm.tex;
      if (this.dialogBackdropFbo) gl.deleteFramebuffer(this.dialogBackdropFbo);
      if (this.dialogBackdropTex) gl.deleteTexture(this.dialogBackdropTex);
      const db = this.createFBO(w, h);
      this.dialogBackdropFbo = db.fb;
      this.dialogBackdropTex = db.tex;
      this.dialogBackdropKey = null;
      if (this.bgOnlyFbo) gl.deleteFramebuffer(this.bgOnlyFbo);
      if (this.bgOnlyTex) gl.deleteTexture(this.bgOnlyTex);
      const bg = this.createFBO(w, h);
      this.bgOnlyFbo = bg.fb;
      this.bgOnlyTex = bg.tex;
      const sizeChanged = this.fboW !== w || this.fboH !== h;
      this.fboW = w;
      this.fboH = h;
      if (sizeChanged) this.clearBackdropBlurCache();
    },
    /** Clear the backdrop blur cache: delete all cached GL textures + FBOs +
     *  empty the Map + pool. Called on resize (cover-fit changes) +
     *  loadWallpaper (content changes). Everything is deleted (not pooled)
     *  because resize may change fboW/fboH, making pooled tex the wrong size. */
    clearBackdropBlurCache() {
      const gl = this.gl;
      for (const entry of this.backdropBlurCache.values()) {
        gl.deleteTexture(entry.tex);
        gl.deleteFramebuffer(entry.fb);
      }
      this.backdropBlurCache.clear();
      for (const p of this.backdropBlurCacheFboPool) {
        gl.deleteTexture(p.tex);
        gl.deleteFramebuffer(p.fb);
      }
      this.backdropBlurCacheFboPool.length = 0;
      this.backdropBlurCacheSnapshots.length = 0;
      if (this.cacheCopyReadFbo) {
        gl.deleteFramebuffer(this.cacheCopyReadFbo);
        this.cacheCopyReadFbo = null;
      }
    },
    /** Evict oldest entries (Map insertion order) while the cache exceeds
     *  backdropBlurCacheMax. Evicted {fb, tex} are returned to the FBO pool
     *  (not deleted) so the next cache miss can reuse them without GL
     *  allocation. Called after every cache-miss insert in both the
     *  independent (wallpaper) and scene blur paths. */
    evictBackdropBlurCacheIfNeeded() {
      while (this.backdropBlurCache.size > this.backdropBlurCacheMax) {
        const oldest = this.backdropBlurCache.keys().next().value;
        if (!oldest) break;
        const oldEntry = this.backdropBlurCache.get(oldest);
        if (oldEntry) this.releaseCacheFBO(oldEntry);
        this.backdropBlurCache.delete(oldest);
      }
      while (this.backdropBlurCacheSnapshots.length > this.backdropBlurCacheMax) {
        this.backdropBlurCacheSnapshots.shift();
      }
    },
    /** Acquire a cache {fb, tex, w, h}. Reuses a size-matched entry from the
     *  pool if available (tex already has filtering/wrap set + correct size,
     *  so copyTexImage2D just overwrites pixels — no texImage2D reallocation);
     *  otherwise creates a fresh tex+fb via createFBO. */
    acquireCacheFBO(w, h) {
      const pool = this.backdropBlurCacheFboPool;
      for (let i = pool.length - 1; i >= 0; i--) {
        const p = pool[i];
        if (p.w === w && p.h === h) {
          pool.splice(i, 1);
          return p;
        }
      }
      const fresh = this.createFBO(w, h);
      return { fb: fresh.fb, tex: fresh.tex, w, h };
    },
    /** Return a cache {fb, tex, w, h} to the pool for reuse. No GL deletion. */
    releaseCacheFBO(entry) {
      this.backdropBlurCacheFboPool.push(entry);
    },
    /** Bind an FBO as the render target, set viewport to its size. */
    bindFBO(fb) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.viewport(0, 0, this.fboW, this.fboH);
    },
    /** Fullscreen copy pass: copy src texture to the currently-bound FBO.
     *  Used for ping-pong blits (fboA → fboB) and the final blit to the
     *  default framebuffer (fboA → canvas). The caller must have already
     *  bound the destination FBO. */
    drawCopy(srcTex) {
      const gl = this.gl;
      gl.useProgram(this.copyProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
      gl.enableVertexAttribArray(this.aPosLocCp);
      gl.vertexAttribPointer(this.aPosLocCp, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.uniform1i(this.uCp["uTexture"], 0);
      gl.uniform2f(this.uCp["uCanvasSize"], this.fboW, this.fboH);
      gl.disable(gl.BLEND);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },
    /** Fullscreen solid-color fill — used when backgroundColor is set
     *  (e.g. black for the Home page). The caller must have already bound
     *  the destination FBO. */
    drawSolidFill(r, g, b, a) {
      const gl = this.gl;
      gl.useProgram(this.solidFillProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
      gl.enableVertexAttribArray(this.aPosLocSf);
      gl.vertexAttribPointer(this.aPosLocSf, 2, gl.FLOAT, false, 0, 0);
      gl.uniform4f(this.uSf["uColor"], r, g, b, a);
      gl.disable(gl.BLEND);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },
    /** Fullscreen colorControls pass — copies srcTex to the bound FBO applying
     *  brightness/contrast/saturation. Caller must bind the destination FBO. */
    drawColorControls(srcTex, brightness, contrast, saturation) {
      const gl = this.gl;
      gl.useProgram(this.colorControlsProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
      gl.enableVertexAttribArray(this.aPosLocCc);
      gl.vertexAttribPointer(this.aPosLocCc, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.uniform1i(this.uCc["uTexture"], 0);
      gl.uniform2f(this.uCc["uTexSize"], this.fboW, this.fboH);
      gl.uniform1f(this.uCc["uBrightness"], brightness);
      gl.uniform1f(this.uCc["uContrast"], contrast);
      gl.uniform1f(this.uCc["uSaturation"], saturation);
      gl.disable(gl.BLEND);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },
    /** Ensure the per-element FBO (elFbo) + backdrop crop FBO + element blur
     *  ping-pong FBOs exist at (w,h) device px. Lazily recreated when the
     *  required size changes. Returns the actual size used.
     *
     *  No clamp: the caller already clamps bbox to the canvas (fboW/fboH), so
     *  the elFbo never exceeds the scene FBO size. The old MAX_ELEMENT_FBO_SIZE
     *  = 1024 clamp + the bbox>1024 fallback in renderGlassElement have been
     *  removed — all glass elements now unconditionally use the PEF path. */
    ensureElementFBO(w, h) {
      const cw = Math.max(1, Math.round(w));
      const ch = Math.max(1, Math.round(h));
      if (this.elFboW === cw && this.elFboH === ch && this.elFbo && this.backdropCropFbo && this.elBlurFboA && this.elBlurFboB) {
        return { w: cw, h: ch };
      }
      const gl = this.gl;
      if (this.elFbo) gl.deleteFramebuffer(this.elFbo);
      if (this.elFboTex) gl.deleteTexture(this.elFboTex);
      const ef = this.createFBO(cw, ch);
      this.elFbo = ef.fb;
      this.elFboTex = ef.tex;
      if (this.backdropCropFbo) gl.deleteFramebuffer(this.backdropCropFbo);
      if (this.backdropCropTex) gl.deleteTexture(this.backdropCropTex);
      const bc = this.createFBO(cw, ch);
      this.backdropCropFbo = bc.fb;
      this.backdropCropTex = bc.tex;
      if (this.elBlurFboA) gl.deleteFramebuffer(this.elBlurFboA);
      if (this.elBlurFboATex) gl.deleteTexture(this.elBlurFboATex);
      if (this.elBlurFboB) gl.deleteFramebuffer(this.elBlurFboB);
      if (this.elBlurFboBTex) gl.deleteTexture(this.elBlurFboBTex);
      const ba = this.createFBO(cw, ch);
      const bb = this.createFBO(cw, ch);
      this.elBlurFboA = ba.fb;
      this.elBlurFboATex = ba.tex;
      this.elBlurFboB = bb.fb;
      this.elBlurFboBTex = bb.tex;
      this.elFboW = cw;
      this.elFboH = ch;
      return { w: cw, h: ch };
    },
    /** Scissor-crop a region of srcTex (fullscreen scene FBO texture) into
     *  backdropCropFbo. If blurRadius > 0, also runs a 2-pass separable Gaussian
     *  on the cropped result (using elBlurFboA/B) and returns blurFboBTex;
     *  otherwise returns backdropCropTex.
     *  (srcX, srcY) is the region top-left in the SOURCE texture, TOP-LEFT
     *  origin, device px. (srcW, srcH) is the region size. The destination
     *  FBO (backdropCropFbo) is assumed to already be at least (srcW, srcH). */
    cropAndBlurBackdrop(srcTex, srcX, srcY, srcW, srcH, blurRadius) {
      const gl = this.gl;
      const dw = this.elFboW;
      const dh = this.elFboH;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.backdropCropFbo);
      gl.viewport(0, 0, dw, dh);
      gl.disable(gl.BLEND);
      gl.useProgram(this.elFboCropProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
      gl.enableVertexAttribArray(this.aPosLocEc);
      gl.vertexAttribPointer(this.aPosLocEc, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.uniform1i(this.uEc["uTexture"], 0);
      gl.uniform2f(this.uEc["uSrcOffset"], srcX, srcY);
      gl.uniform2f(this.uEc["uSrcSize"], this.fboW, this.fboH);
      gl.uniform2f(this.uEc["uDstSize"], dw, dh);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      if (blurRadius < 0.5) {
        return this.backdropCropTex;
      }
      if (this.useKawaseBlur) {
        const iters = kawaseIterationsForRadius(blurRadius, this.kawaseQuality);
        const dMax = blurRadius * Math.sqrt(6 * iters / ((iters + 1) * (2 * iters + 1)));
        this.lastBlurStats = { type: "kawase", passes: iters, taps: 4 * iters, maxSample: dMax * Math.SQRT2 };
        this.ensureKawaseProgram();
        const kp = this.kawasePrograms;
        const savedFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
        const savedScissor = gl.isEnabled(gl.SCISSOR_TEST);
        const savedBox = gl.getParameter(gl.SCISSOR_BOX);
        gl.disable(gl.SCISSOR_TEST);
        gl.disable(gl.BLEND);
        let curSrc = this.backdropCropTex;
        for (let i = 0; i < iters; i++) {
          const writeFboA = i % 2 === 0;
          const dstFbo = writeFboA ? this.elBlurFboA : this.elBlurFboB;
          gl.bindFramebuffer(gl.FRAMEBUFFER, dstFbo);
          gl.viewport(0, 0, dw, dh);
          gl.useProgram(kp.prog);
          gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
          gl.enableVertexAttribArray(kp.aPos);
          gl.vertexAttribPointer(kp.aPos, 2, gl.FLOAT, false, 0, 0);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, curSrc);
          gl.uniform1i(kp.uTexture, 0);
          gl.uniform2f(kp.uTexSize, dw, dh);
          gl.uniform1f(kp.uRadius, blurRadius);
          gl.uniform1f(kp.uIteration, i);
          gl.uniform1f(kp.uTotalIters, iters);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
          curSrc = writeFboA ? this.elBlurFboATex : this.elBlurFboBTex;
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, savedFb);
        gl.viewport(0, 0, this.fboW, this.fboH);
        if (savedScissor) {
          gl.enable(gl.SCISSOR_TEST);
          gl.scissor(savedBox[0], savedBox[1], savedBox[2], savedBox[3]);
        }
        const lastWroteA = (iters - 1) % 2 === 0;
        return lastWroteA ? this.elBlurFboATex : this.elBlurFboBTex;
      }
      let taps = computeBlur1DTapCount(blurRadius);
      taps = Math.min(taps, Math.max(1, this.blurTapCap | 0));
      this.lastBlurStats = { type: "gauss", passes: 2, taps, maxSample: 3 * blurRadius };
      return this.runBlurPasses(
        this.backdropCropTex,
        this.elBlurFboA,
        this.elBlurFboATex,
        this.elBlurFboB,
        this.elBlurFboBTex,
        dw,
        dh,
        blurRadius,
        taps,
        true
      );
    },
    /** Composite the per-element FBO texture onto the currently-bound (fullscreen)
     *  scene FBO at the element's SCALED + ROTATED on-screen position. The elFbo
     *  contains un-rotated glass at baseline resolution; this shader applies
     *  rotation + zoom + translation to place it on screen.
     *
     *  Caller should set scissor to the rotated AABB of the scaled element
     *  (sw*|cos|+sh*|sin| × sw*|sin|+sh*|cos|) + have blending enabled. */
    drawElFboComposite(srcTex, srcW, srcH, elementCenterX, elementCenterY, elementW, elementH, rotation) {
      const gl = this.gl;
      gl.useProgram(this.elFboCompositeProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
      gl.enableVertexAttribArray(this.aPosLocEf);
      gl.vertexAttribPointer(this.aPosLocEf, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.uniform1i(this.uEf["uTexture"], 0);
      gl.uniform2f(this.uEf["uCanvasSize"], this.fboW, this.fboH);
      gl.uniform2f(this.uEf["uElementCenter"], elementCenterX, elementCenterY);
      gl.uniform2f(this.uEf["uElementSize"], elementW, elementH);
      gl.uniform1f(this.uEf["uRotation"], rotation);
      gl.uniform2f(this.uEf["uSrcSize"], srcW, srcH);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },
    /** Intersect a scissor rect (device px, BL origin) with el.clipRect (CSS px,
     *  top-left origin). No-op when clipRect is absent. Used by the TextGlass
     *  scrollable sheet to clip content to the sheet card's visible bounds. */
    intersectClipScissor(el, scX, scY, scW, scH) {
      const clip = el.clipRect;
      if (!clip) return { x: scX, y: scY, w: scW, h: scH };
      const clipX = Math.round(clip.x * this.dpr);
      const clipY = Math.round((this.cssHeight - (clip.y + clip.h)) * this.dpr);
      const clipW = Math.round(clip.w * this.dpr);
      const clipH = Math.round(clip.h * this.dpr);
      const ix0 = Math.max(scX, clipX);
      const iy0 = Math.max(scY, clipY);
      const ix1 = Math.min(scX + scW, clipX + clipW);
      const iy1 = Math.min(scY + scH, clipY + clipH);
      return {
        x: ix0,
        y: iy0,
        w: Math.max(0, ix1 - ix0),
        h: Math.max(0, iy1 - iy0)
      };
    }
  };

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/continuous-curve.ts
  var SQRT_2 = 1.4142135623730951;
  var FRAC_PI_4 = 0.7853981633974483;
  var FRAC_1_SQRT_2 = 0.7071067811865476;
  function solveCubicSingle(a, b, c, d) {
    const f = (3 * c / a - b * b / (a * a)) / 3;
    const g = (2 * b * b * b / (a * a * a) - 9 * b * c / (a * a) + 27 * d / a) / 27;
    const h = g * g / 4 + f * f * f / 27;
    const sqrtH = Math.sqrt(h);
    return Math.cbrt(-g / 2 + sqrtH) + Math.cbrt(-g / 2 - sqrtH) - b / (3 * a);
  }
  function solveDepressedQuarticSingle(p, q, r) {
    const b = -p / 2;
    const c = -r;
    const d = r * p / 2 - q * q / 8;
    const f = (3 * c - b * b) / 3;
    const g = (2 * b * b * b - 9 * b * c + 27 * d) / 27;
    const rVal = Math.sqrt(-f * f * f / 27);
    const phi = Math.acos(-g / (2 * rVal));
    const y = 2 * Math.sqrt(-f / 3) * Math.cos(phi / 3);
    const z = y - b / 3;
    const u = Math.sqrt(2 * z - p);
    return (u - Math.sqrt(u * u - 4 * (z + q / (2 * u)))) / 2;
  }
  var ContinuousCurvatureRoundedRectangleCornerBuilder = class {
    constructor(extendedFraction = 2 / 3, arcFraction = 0.5) {
      this.extendedFraction = extendedFraction;
      this.arcFraction = arcFraction;
      this.theta = (1 - arcFraction) * FRAC_PI_4;
      this.cos = Math.cos(this.theta);
      this.sin = Math.sin(this.theta);
      this.cot = 1 / Math.tan(this.theta);
      this.cos2 = this.cos * this.cos;
      this.sin2 = this.sin * this.sin;
      this.cos3 = this.cos2 * this.cos;
      this.sin3 = this.sin2 * this.sin;
      const cos = this.cos;
      const sin = this.sin;
      const cot = this.cot;
      const cos2 = this.cos2;
      const sin2 = this.sin2;
      const cos3 = this.cos3;
      const sin3 = this.sin3;
      this.k0 = 27 * (SQRT_2 - 6 * cos + 6 * SQRT_2 * cos2 - 4 * cos3) * cot + 2 * sin * (-9 + 2 * (SQRT_2 - 2 * sin) * sin3 + 2 * SQRT_2 * cos * (9 + sin2) - 2 * cos2 * (9 + 2 * sin2));
      this.k1 = -81 * (-2 + SQRT_2 + 4 * (-1 + SQRT_2) * cos + 2 * (-2 + SQRT_2) * cos2) * cot - 4 * sin * (-9 + 9 * SQRT_2 + SQRT_2 * sin3 + (-2 + SQRT_2) * cos * (9 + sin2));
      this.k2 = 9 * (9 * (-4 + 3 * SQRT_2 + (-6 + 4 * SQRT_2) * cos) * cot + (-6 + 4 * SQRT_2) * sin);
      this.k3 = 27 * (10 - 7 * SQRT_2) * cot;
    }
    buildEvenCornerBezierPoints(t) {
      const k = this.extendedFraction * t;
      const kappa = solveCubicSingle(this.k3, this.k2, this.k1 + 8 * -k * this.sin3 * this.sin, this.k0);
      const x3 = FRAC_1_SQRT_2 + (-FRAC_1_SQRT_2 + this.sin) / kappa;
      const y3 = 1 - FRAC_1_SQRT_2 + (FRAC_1_SQRT_2 - this.cos) / kappa;
      const x2 = x3 - y3 * this.cot;
      const x1 = x2 - 1.5 * kappa * y3 * y3 / this.sin3;
      const x0 = -k;
      const x6 = 1 - y3;
      const y6 = 1 - x3;
      const y7 = 1 - x2;
      const y8 = 1 - x1;
      const y9 = 1 - x0;
      const a = 1.5 * kappa;
      const g = this.cos2 - this.sin2;
      const x36 = x6 - x3;
      const y36 = y6 - y3;
      const c = -(this.cos * y36 - this.sin * x36);
      const lambda = (-g + Math.sqrt(g * g - 4 * a * c)) / (2 * a);
      const x4 = x3 + lambda * this.cos;
      const y4 = y3 + lambda * this.sin;
      const x5 = x6 - lambda * this.sin;
      const y5 = y6 - lambda * this.cos;
      return [x0, 0, x1, 0, x2, 0, x3, y3, x4, y4, x5, y5, x6, y6, 1, y7, 1, y8, 1, y9];
    }
    buildUnevenCornerBezierPoints(tH, tV) {
      const kH = this.extendedFraction * tH;
      const kV = this.extendedFraction * tV;
      const kappa3 = solveCubicSingle(this.k3, this.k2, this.k1 + 8 * -kH * this.sin3 * this.sin, this.k0);
      const kappa6 = solveCubicSingle(this.k3, this.k2, this.k1 + 8 * -kV * this.sin3 * this.sin, this.k0);
      const x3 = FRAC_1_SQRT_2 + (-FRAC_1_SQRT_2 + this.sin) / kappa3;
      const y3 = 1 - FRAC_1_SQRT_2 + (FRAC_1_SQRT_2 - this.cos) / kappa3;
      const x2 = x3 - y3 * this.cot;
      const x1 = x2 - 1.5 * kappa3 * y3 * y3 / this.sin3;
      const x0 = -kH;
      const x3p = FRAC_1_SQRT_2 + (-FRAC_1_SQRT_2 + this.sin) / kappa6;
      const y3p = 1 - FRAC_1_SQRT_2 + (FRAC_1_SQRT_2 - this.cos) / kappa6;
      const x2p = x3p - y3p * this.cot;
      const x1p = x2p - 1.5 * kappa6 * y3p * y3p / this.sin3;
      const x0p = -kV;
      const x6 = 1 - y3p;
      const y6 = 1 - x3p;
      const y7 = 1 - x2p;
      const y8 = 1 - x1p;
      const y9 = 1 - x0p;
      const a = 1.5 * kappa3;
      const b = 1.5 * kappa6;
      const g = this.cos2 - this.sin2;
      const x36 = x6 - x3;
      const y36 = y6 - y3;
      const c = -(this.cos * y36 - this.sin * x36);
      const d = this.sin * y36 - this.cos * x36;
      const p = 2 * (d / b);
      const q = g * g * g / (a * b * b);
      const r = (a * d * d + c * g * g) / (a * b * b);
      const lambda6 = solveDepressedQuarticSingle(p, q, r);
      const lambda3 = (-d - b * lambda6 * lambda6) / g;
      const x4 = x3 + lambda3 * this.cos;
      const y4 = y3 + lambda3 * this.sin;
      const x5 = x6 - lambda6 * this.sin;
      const y5 = y6 - lambda6 * this.cos;
      return [x0, 0, x1, 0, x2, 0, x3, y3, x4, y4, x5, y5, x6, y6, 1, y7, 1, y8, 1, y9];
    }
    /** Returns 20 Bezier control point values (10 pairs) for one corner.
     *  tW = (w/2 - r) / r clamped to [0,1], tH = (h/2 - r) / r clamped to [0,1].
     *  These define 3 cubic Bezier segments forming the G2-continuous corner. */
    getCornerBezierPoints(tW, tV) {
      const i = tW === 0 ? 0 : tW === 1 ? 1 : -1;
      const j = tV === 0 ? 0 : tV === 1 ? 1 : -1;
      if (i >= 0 && j >= 0) {
        if (i === 0 && j === 0) return this.buildEvenCornerBezierPoints(0);
        if (i === 1 && j === 1) return this.buildEvenCornerBezierPoints(1);
        return this.buildUnevenCornerBezierPoints(i === 1 ? 1 : 0, j === 1 ? 1 : 0);
      }
      return this.buildUnevenCornerBezierPoints(
        Math.max(0, Math.min(1, tW)),
        Math.max(0, Math.min(1, tV))
      );
    }
  };
  function continuousCurvatureRoundedRectPath(ctx, w, h, radius) {
    const builder = new ContinuousCurvatureRoundedRectangleCornerBuilder();
    const r = radius;
    const tW = Math.max(0, Math.min(1, (w * 0.5 - r) / r));
    const tH = Math.max(0, Math.min(1, (h * 0.5 - r) / r));
    const p = builder.getCornerBezierPoints(tW, tH);
    if (p.length < 20) return new Path2D();
    const path = new Path2D();
    let x = w - r;
    let y = 0;
    path.moveTo(x + p[0] * r, y + p[1] * r);
    path.bezierCurveTo(x + p[2] * r, y + p[3] * r, x + p[4] * r, y + p[5] * r, x + p[6] * r, y + p[7] * r);
    path.bezierCurveTo(x + p[8] * r, y + p[9] * r, x + p[10] * r, y + p[11] * r, x + p[12] * r, y + p[13] * r);
    path.bezierCurveTo(x + p[14] * r, y + p[15] * r, x + p[16] * r, y + p[17] * r, x + p[18] * r, y + p[19] * r);
    x = w - r;
    y = h;
    path.lineTo(x + p[18] * r, y - p[19] * r);
    path.bezierCurveTo(x + p[16] * r, y - p[17] * r, x + p[14] * r, y - p[15] * r, x + p[12] * r, y - p[13] * r);
    path.bezierCurveTo(x + p[10] * r, y - p[11] * r, x + p[8] * r, y - p[9] * r, x + p[6] * r, y - p[7] * r);
    path.bezierCurveTo(x + p[4] * r, y - p[5] * r, x + p[2] * r, y - p[3] * r, x + p[0] * r, y - p[1] * r);
    x = r;
    y = h;
    path.lineTo(x - p[0] * r, y - p[1] * r);
    path.bezierCurveTo(x - p[2] * r, y - p[3] * r, x - p[4] * r, y - p[5] * r, x - p[6] * r, y - p[7] * r);
    path.bezierCurveTo(x - p[8] * r, y - p[9] * r, x - p[10] * r, y - p[11] * r, x - p[12] * r, y - p[13] * r);
    path.bezierCurveTo(x - p[14] * r, y - p[15] * r, x - p[16] * r, y - p[17] * r, x - p[18] * r, y - p[19] * r);
    x = r;
    y = 0;
    path.lineTo(x - p[18] * r, y + p[19] * r);
    path.bezierCurveTo(x - p[16] * r, y + p[17] * r, x - p[14] * r, y + p[15] * r, x - p[12] * r, y + p[13] * r);
    path.bezierCurveTo(x - p[10] * r, y + p[11] * r, x - p[8] * r, y + p[9] * r, x - p[6] * r, y + p[7] * r);
    path.bezierCurveTo(x - p[4] * r, y + p[5] * r, x - p[2] * r, y + p[3] * r, x - p[0] * r, y + p[1] * r);
    path.closePath();
    return path;
  }

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/continuous-mask.ts
  var maskCache = /* @__PURE__ */ new Map();
  var MAX_MASK_CACHE_BYTES = 32 * 1024 * 1024;
  var maskCacheBytes = 0;
  var _alphaBuf = new Uint8Array(128 * 128);
  var _insideBuf = new Int32Array(128 * 128);
  var _outsideBuf = new Int32Array(128 * 128);
  var _texBuf = new Uint8Array(128 * 128 * 4);
  var TIMING_RING_SIZE = 32;
  var capsuleSdfTimings = [];
  function getMaskCacheEntries() {
    return Array.from(maskCache.entries()).map(([key, v]) => ({
      key,
      tex: v.tex,
      texSize: v.texSize
    }));
  }
  function generateContinuousCurvatureMask(w, h, radius, dpr = 1, quality = 1, skipSdf = false) {
    const devMaxDim = Math.max(w, h) * (dpr || 1);
    const target = devMaxDim * 2;
    let baseTexSize = 128;
    while (baseTexSize < target && baseTexSize < 1024) baseTexSize <<= 1;
    const texSize = Math.max(32, Math.ceil(baseTexSize * quality));
    const key = `${w},${h},${radius},${texSize},s${skipSdf ? 1 : 0}`;
    const cached = maskCache.get(key);
    if (cached) {
      maskCache.delete(key);
      maskCache.set(key, cached);
      if (capsuleSdfTimings.length >= TIMING_RING_SIZE) capsuleSdfTimings.shift();
      capsuleSdfTimings.push({
        timestamp: performance.now(),
        key,
        w,
        h,
        radius,
        texSize,
        cacheHit: true,
        stepCanvasSetup: 0,
        stepPathDraw: 0,
        stepGetImageData: 0,
        stepAlphaExtract: 0,
        stepInitArrays: 0,
        stepForwardPass: 0,
        stepBackwardPass: 0,
        stepPack: 0,
        stepTotal: 0
      });
      return { tex: cached.tex, texSize };
    }
    const t0 = performance.now();
    const maxDim = Math.max(w, h);
    const aspectW = w / maxDim;
    const aspectH = h / maxDim;
    const canvas = document.createElement("canvas");
    canvas.width = texSize;
    canvas.height = texSize;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.clearRect(0, 0, texSize, texSize);
    const t1 = performance.now();
    const margin = 4;
    const drawW = (texSize - 2 * margin) * aspectW;
    const drawH = (texSize - 2 * margin) * aspectH;
    const offsetX = (texSize - drawW) / 2;
    const offsetY = (texSize - drawH) / 2;
    const scale = drawW / w;
    const drawRadius = radius * scale;
    const path = continuousCurvatureRoundedRectPath(ctx, drawW, drawH, drawRadius);
    ctx.fillStyle = "white";
    ctx.translate(offsetX, offsetY);
    ctx.fill(path);
    ctx.translate(-offsetX, -offsetY);
    const t2 = performance.now();
    const imageData = ctx.getImageData(0, 0, texSize, texSize);
    const t3 = performance.now();
    const N = texSize * texSize;
    if (_alphaBuf.length < N) {
      _alphaBuf = new Uint8Array(N);
      _insideBuf = new Int32Array(N);
      _outsideBuf = new Int32Array(N);
      _texBuf = new Uint8Array(N * 4);
    }
    const alpha = _alphaBuf;
    const inside = _insideBuf;
    const outside = _outsideBuf;
    const INF = 2147483647;
    const data32 = new Uint32Array(imageData.data.buffer);
    for (let i = 0; i < N; i++) {
      const a = data32[i] >>> 24 & 255;
      alpha[i] = a;
      if (a > 128) {
        inside[i] = 0;
        outside[i] = INF;
      } else {
        inside[i] = INF;
        outside[i] = 0;
      }
    }
    const t4 = performance.now();
    const t5 = t4;
    let t6 = t5;
    let t7 = t5;
    if (!skipSdf) {
      const ts = texSize;
      for (let y = 0; y < ts; y++) {
        for (let x = 0; x < ts; x++) {
          const idx = y * ts + x;
          let ins = inside[idx];
          let out = outside[idx];
          if (x > 0 && y > 1) {
            const k = idx - ts - 1 - ts;
            const v = 11;
            const ti = inside[k] + v;
            if (ti < ins) ins = ti;
            const to = outside[k] + v;
            if (to < out) out = to;
          }
          if (x > 0) {
            const k = idx - 1;
            const v = 5;
            const ti = inside[k] + v;
            if (ti < ins) ins = ti;
            const to = outside[k] + v;
            if (to < out) out = to;
          }
          if (x > 0 && y > 0) {
            const k = idx - ts - 1;
            const v = 7;
            const ti = inside[k] + v;
            if (ti < ins) ins = ti;
            const to = outside[k] + v;
            if (to < out) out = to;
          }
          if (y > 0) {
            const k = idx - ts;
            const v = 5;
            const ti = inside[k] + v;
            if (ti < ins) ins = ti;
            const to = outside[k] + v;
            if (to < out) out = to;
          }
          if (x < ts - 1 && y > 0) {
            const k = idx - ts + 1;
            const v = 7;
            const ti = inside[k] + v;
            if (ti < ins) ins = ti;
            const to = outside[k] + v;
            if (to < out) out = to;
          }
          if (x < ts - 2 && y > 0) {
            const k = idx - ts + 2;
            const v = 11;
            const ti = inside[k] + v;
            if (ti < ins) ins = ti;
            const to = outside[k] + v;
            if (to < out) out = to;
          }
          inside[idx] = ins;
          outside[idx] = out;
        }
      }
      t6 = performance.now();
      for (let y = ts - 1; y >= 0; y--) {
        for (let x = ts - 1; x >= 0; x--) {
          const idx = y * ts + x;
          let ins = inside[idx];
          let out = outside[idx];
          if (x < ts - 1 && y < ts - 2) {
            const k = idx + ts + 1 + ts;
            const v = 11;
            const ti = inside[k] + v;
            if (ti < ins) ins = ti;
            const to = outside[k] + v;
            if (to < out) out = to;
          }
          if (x < ts - 1) {
            const k = idx + 1;
            const v = 5;
            const ti = inside[k] + v;
            if (ti < ins) ins = ti;
            const to = outside[k] + v;
            if (to < out) out = to;
          }
          if (x < ts - 1 && y < ts - 1) {
            const k = idx + ts + 1;
            const v = 7;
            const ti = inside[k] + v;
            if (ti < ins) ins = ti;
            const to = outside[k] + v;
            if (to < out) out = to;
          }
          if (y < ts - 1) {
            const k = idx + ts;
            const v = 5;
            const ti = inside[k] + v;
            if (ti < ins) ins = ti;
            const to = outside[k] + v;
            if (to < out) out = to;
          }
          if (x > 0 && y < ts - 1) {
            const k = idx + ts - 1;
            const v = 7;
            const ti = inside[k] + v;
            if (ti < ins) ins = ti;
            const to = outside[k] + v;
            if (to < out) out = to;
          }
          if (x > 1 && y < ts - 1) {
            const k = idx + ts - 2;
            const v = 11;
            const ti = inside[k] + v;
            if (ti < ins) ins = ti;
            const to = outside[k] + v;
            if (to < out) out = to;
          }
          inside[idx] = ins;
          outside[idx] = out;
        }
      }
      t7 = performance.now();
    }
    const refDist = drawRadius;
    const tex = _texBuf;
    const tex32 = new Uint32Array(tex.buffer);
    const ALPHA_OPAQUE = 4278190080;
    if (skipSdf) {
      for (let i = 0; i < N; i++) {
        tex32[i] = ALPHA_OPAQUE | alpha[i];
      }
    } else {
      for (let i = 0; i < N; i++) {
        const sd = (inside[i] - outside[i]) / 5;
        const normalized = sd / refDist > 1 ? 1 : sd / refDist < -1 ? -1 : sd / refDist;
        const g = (normalized * 0.5 + 0.5) * 255 + 0.5 | 0;
        tex32[i] = ALPHA_OPAQUE | g << 8 | alpha[i];
      }
    }
    const t8 = performance.now();
    const texCopy = tex.slice(0, N * 4);
    maskCache.set(key, { tex: texCopy, texSize });
    maskCacheBytes += texCopy.byteLength;
    while (maskCacheBytes > MAX_MASK_CACHE_BYTES && maskCache.size > 1) {
      const oldest = maskCache.keys().next().value;
      if (oldest === void 0) break;
      const old = maskCache.get(oldest);
      if (old) maskCacheBytes -= old.tex.byteLength;
      maskCache.delete(oldest);
    }
    if (capsuleSdfTimings.length >= TIMING_RING_SIZE) capsuleSdfTimings.shift();
    capsuleSdfTimings.push({
      timestamp: t8,
      key,
      w,
      h,
      radius,
      texSize,
      cacheHit: false,
      stepCanvasSetup: t1 - t0,
      stepPathDraw: t2 - t1,
      stepGetImageData: t3 - t2,
      stepAlphaExtract: t4 - t3,
      // now includes init (merged loop)
      stepInitArrays: 0,
      // merged — kept for overlay compat
      stepForwardPass: t6 - t5,
      stepBackwardPass: t7 - t6,
      stepPack: t8 - t7,
      stepTotal: t8 - t0
    });
    return { tex, texSize };
  }

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-wallpaper.ts
  var wallpaperMethods = {
    /** Load the wallpaper image as a texture. */
    async loadWallpaper(src) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      await new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Failed to load wallpaper: " + src));
        img.src = src;
      });
      const gl = this.gl;
      if (this.wallpaperTexture) gl.deleteTexture(this.wallpaperTexture);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const isPOT = (w & w - 1) === 0 && (h & h - 1) === 0;
      if (isPOT) {
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      } else {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.wallpaperTexture = tex;
      this.wallpaperSize = [w || 1, h || 1];
      this.wallpaperReady = true;
      this.clearBackdropBlurCache();
      this.wallpaperVersion++;
      this.markAllDirty();
      this.requestRender();
    },
    /** Load the SDF texture (clock_sdf) for LockScreen glass. */
    async loadSdfTexture(src) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      await new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Failed to load SDF texture: " + src));
        img.src = src;
      });
      const gl = this.gl;
      if (this.sdfTexture) gl.deleteTexture(this.sdfTexture);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.sdfTexture = tex;
      this.sdfTextureSize = [img.naturalWidth || 1, img.naturalHeight || 1];
      this.sdfTextureReady = true;
      this.markAllDirty();
      this.requestRender();
    },
    /** Upload precomputed RGBA SDF-texture pixels directly (no Image load).
     *  DEPRECATED — kept as a thin wrapper around loadTextSdfTextureFromData
     *  for backward compatibility. New code should call loadTextSdfTextureFromData
     *  directly. This now writes to the SEPARATE textSdfTexture slot, NOT the
     *  shared sdfTexture (clock_sdf) slot. */
    loadSdfTextureFromData(data, w, h) {
      this.loadTextSdfTextureFromData(data, w, h);
    },
    /** Upload text-glass SDF pixels to the SEPARATE textSdfTexture slot.
     *  Does NOT touch sdfTexture (clock_sdf) — the lock screen's texture is
     *  preserved across TextGlass page visits. "把这个和锁屏sdf彻底分开". */
    loadTextSdfTextureFromData(data, w, h) {
      if (w < 1 || h < 1) return;
      const gl = this.gl;
      if (this.textSdfTexture) gl.deleteTexture(this.textSdfTexture);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.textSdfTexture = tex;
      this.textSdfTextureSize = [w, h];
      this.textSdfTextureReady = true;
      this.markAllDirty();
      this.requestRender();
    },
    /** Generate + upload a continuous-curvature SDF texture for the dialog
     *  card's capsule shape. The texture is cached by (w, h, radius, dpr,
     *  capsuleSdfQuality); calling again with the same key is a no-op. The SDF
     *  encodes a G2-continuous Bezier rounded-rect path (faithful to
     *  kyant-shapes' ContinuousCurvatureRoundedRectangleCornerBuilder),
     *  normalized to [-1, 1] (negative inside, positive outside). Sampling it
     *  in the shader gives pixel-perfect squircle corners, vs the analytic
     *  sdRoundedRect which uses a circular arc approximation.
     *
     *  Texture format: RGBA, texSize² (chosen dynamically by
     *  generateContinuousCurvatureMask — 2× oversampling rounded up to POT,
     *  clamped [128,1024], then scaled by capsuleSdfQuality and Math.ceil'd),
     *  LINEAR filtering, CLAMP_TO_EDGE. The R channel holds the normalized
     *  SDF (decoded as sample*2 - 1 in the shader); G and B mirror R; A = 255. */
    loadContinuousSdf(w, h, radius) {
      const holeR = this.debugSdfHoleTopLeftR;
      const holeG = this.debugSdfHoleTopLeftG;
      const skipSdf = !!this.noContinuousSdf;
      const q = this.capsuleSdfQuality;
      const key = `${w},${h},${radius},${this.dpr},q${q},s${skipSdf ? 1 : 0},r${holeR ? 1 : 0},g${holeG ? 1 : 0}`;
      let entry = this.continuousSdfPool.get(key);
      if (!entry) {
        const genStart = performance.now();
        const { tex, texSize } = generateContinuousCurvatureMask(w, h, radius, this.dpr, this.capsuleSdfQuality, skipSdf);
        const genEnd = performance.now();
        const gl = this.gl;
        const texObj = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texObj);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        let uploadTex = tex;
        if (holeR || holeG) {
          uploadTex = tex.slice();
          const half = texSize >> 1;
          for (let row = 0; row < half; row++) {
            const rowBase = row * texSize * 4;
            for (let col = 0; col < half; col++) {
              const idx = rowBase + col * 4;
              if (holeR) uploadTex[idx] = 0;
              if (holeG) uploadTex[idx + 1] = 0;
            }
          }
        }
        const uploadStart = performance.now();
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, texSize, texSize, 0, gl.RGBA, gl.UNSIGNED_BYTE, uploadTex);
        gl.finish();
        const uploadEnd = performance.now();
        if (holeR || holeG) {
          this._debugUploadedSdfTexMap.set(key, { tex: uploadTex.slice(), texSize });
        }
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        entry = { tex: texObj, texSize };
        this.continuousSdfPool.set(key, entry);
        this._lastCapsuleUploadMs = uploadEnd - uploadStart;
        this._lastCapsuleGenMs = genEnd - genStart;
        this._lastCapsuleKey = key;
        if (this.continuousSdfPool.size > 16) {
          const oldest = this.continuousSdfPool.keys().next().value;
          if (oldest) {
            const old = this.continuousSdfPool.get(oldest);
            if (old) gl.deleteTexture(old.tex);
            this.continuousSdfPool.delete(oldest);
          }
        }
      } else {
        this._lastCapsuleUploadMs = 0;
        this._lastCapsuleGenMs = 0;
        this._lastCapsuleKey = key + " (pool hit)";
      }
      this.continuousSdfTexture = entry.tex;
      this.continuousSdfTexSize = [entry.texSize, entry.texSize];
      this.continuousSdfKey = key;
    },
    /** Set canvas size (CSS pixels) + handle DPR.
     *  PERFORMANCE: DPR capped at 1.5 (was 2). On Retina displays (DPR=2),
     *  this reduces pixel count by 44% (4x → 2.25x) with minimal visual
     *  difference. The original Android app relies on hardware RenderEffect
     *  which is far cheaper per-pixel, so it can afford full DPR; our
     *  software shader pipeline cannot.
     */
    resize(cssW, cssH) {
      if (this.dpr <= 0) {
        this.dpr = Math.min(window.devicePixelRatio || 1, 3);
      }
      const w = Math.round(cssW * this.dpr);
      const h = Math.round(cssH * this.dpr);
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
        this.gl.viewport(0, 0, w, h);
        this.resizeFBOs(w, h);
      }
      for (const b of this.buttonConfigs) this.fgDirtyIds.add(b.id);
      this.cssWidth = cssW;
      this.cssHeight = cssH;
      if (this.elFboCache.size > 0) {
        const gl = this.gl;
        for (const e of this.elFboCache.values()) {
          gl.deleteFramebuffer(e.fb);
          gl.deleteTexture(e.tex);
        }
        this.elFboCache.clear();
      }
      this.markAllDirty();
      this.requestRender();
    },
    setWallpaperClip(x, y, w, h) {
      this.wallpaperClipCss = { x: x || 0, y: y || 0, w: w || 0, h: h || 0 };
    }
  };

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-scroll.ts
  var scrollMethods = {
    /** Total scrollable content height in CSS px (set by the React layer). */
    setContentHeight(h) {
      this.contentHeight = h;
      this.clampScrollY();
      this.requestRender();
    },
    /**
     * Set the scroll offset directly (CSS px, positive = scrolled down).
     * Used during touch drag — the scroll position follows the finger with
     * no spring lag. Inertia velocity is reset to 0 (the finger is in control).
     * The value is clamped to [0, maxScroll].
     */
    setScrollY(y) {
      this.scrollVelocity = 0;
      this.scrollY = this.clampScrollValue(y);
      this.requestRender();
    },
    /**
     * Apply an inertia impulse to the scroll (CSS px / s). Used on touch
     * release — the drag velocity becomes the initial scroll velocity,
     * then exponentially decays. The renderer's animation loop applies
     * `scrollY += scrollVelocity * dt` each frame and decays the velocity.
     * No spring rebound at edges — scrolling just stops at the boundary.
     */
    setScrollVelocity(v) {
      const MAX_VEL = 4e3;
      this.scrollVelocity = Math.max(-MAX_VEL, Math.min(MAX_VEL, v));
      this.startAnimation();
    },
    /** Get current scroll offset (CSS px). */
    getScrollY() {
      return this.scrollY;
    },
    /** Get current scroll velocity (CSS px / s, for inertia). */
    getScrollVelocity() {
      return this.scrollVelocity;
    },
    /** Clamp a scroll value to [0, maxScroll]. */
    clampScrollValue(y) {
      const max = Math.max(0, this.contentHeight - this.cssHeight);
      if (y < 0) return 0;
      if (y > max) return max;
      return y;
    },
    /** Clamp current scrollY in place (called when content size changes). */
    clampScrollY() {
      this.scrollY = this.clampScrollValue(this.scrollY);
    },
    /**
     * Set the background color override. If non-null, the renderer fills
     * the canvas with this color instead of drawing the wallpaper image.
     * Used for the Home page (black background) per the user's request.
     */
    setBackgroundColor(color) {
      if (this.backgroundColor === color) return;
      if (this.backgroundColor && color && this.backgroundColor[0] === color[0] && this.backgroundColor[1] === color[1] && this.backgroundColor[2] === color[2]) return;
      this.backgroundColor = color;
      this.markAllDirty();
      this.requestRender();
    },
    setGravityAngle(angleRad) {
      const THRESHOLD = 0.02;
      if (Math.abs(this.gravityAngle - angleRad) < THRESHOLD) return;
      this.gravityAngle = angleRad;
      this.markGravityDirty();
      this.requestRender();
    }
  };

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/velocity-tracker.ts
  var MAX_SAMPLES = 20;
  var VelocityTracker1D = class {
    constructor() {
      this.samples = [];
    }
    resetTracking() {
      this.samples.length = 0;
    }
    addPosition(timeMillis, position) {
      this.samples.push({ t: timeMillis, p: position });
      if (this.samples.length > MAX_SAMPLES) {
        this.samples.shift();
      }
    }
    /**
     * Estimate velocity (units/second) at the latest sample using a
     * least-squares linear fit over samples within the last `windowMs`
     * (default 100ms, matching Compose's default cutoff).
     *
     * Returns 0 if fewer than 2 samples are in the window.
     */
    calculateVelocity(windowMs = 100) {
      const samples = this.samples;
      if (samples.length < 2) return 0;
      const now = samples[samples.length - 1].t;
      const cutoff = now - windowMs;
      let n = 0;
      let sumT = 0;
      let sumP = 0;
      let sumTT = 0;
      let sumTP = 0;
      for (let i = samples.length - 1; i >= 0; i--) {
        const s = samples[i];
        if (s.t < cutoff) break;
        const tt = (s.t - now) / 1e3;
        sumT += tt;
        sumP += s.p;
        sumTT += tt * tt;
        sumTP += tt * s.p;
        n++;
      }
      if (n < 2) return 0;
      const denom = n * sumTT - sumT * sumT;
      if (Math.abs(denom) < 1e-9) return 0;
      const b = (n * sumTP - sumT * sumP) / denom;
      return b;
    }
  };

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-toggle.ts
  var toggleMethods = {
    /** Ensure a toggle group state exists, initialized to the given fraction.
     *  pressedScale / valueRangeSpan are only applied on first creation
     *  (or, for non-default values, re-applied on existing groups so tabs
     *  always get 78/56 and the correct span even if setToggleTarget created
     *  the group first via the page.tsx toggleTargets sync). */
    ensureToggleState(groupId, initialFraction, pressedScale = 1.5, valueRangeSpan = 1) {
      let st = this.toggleStates.get(groupId);
      if (!st) {
        st = {
          fraction: initialFraction,
          fractionVelocity: 0,
          targetFraction: initialFraction,
          pressProgress: 0,
          pressVelocity: 0,
          targetPress: 0,
          scaleX: 1,
          scaleXVelocity: 0,
          targetScaleX: 1,
          scaleY: 1,
          scaleYVelocity: 0,
          targetScaleY: 1,
          velocity: 0,
          velocityVelocity: 0,
          targetVelocity: 0,
          isDragging: false,
          trackVelocityAfterRelease: false,
          velocityTracker: new VelocityTracker1D(),
          lastFractionForVelocity: initialFraction,
          lastFractionTime: 0,
          pressedScale,
          valueRangeSpan,
          panelOffset: 0,
          panelOffsetVelocity: 0,
          targetPanelOffset: 0
        };
        this.toggleStates.set(groupId, st);
      } else {
        if (pressedScale !== 1.5) st.pressedScale = pressedScale;
        if (valueRangeSpan !== 1) st.valueRangeSpan = valueRangeSpan;
      }
      return st;
    },
    /**
     * Set the toggle's target fraction (0..1). Animates with critically
     * damped spring. Also triggers a quick press-and-release cycle to
     * match the original `animateToValue` behavior (which calls press()
     * + animateTo + release()).
     *
     * Used for tap-to-toggle: the React layer flips `toggleOn`, then calls
     * this method with the new target.
     *
     * NOTE: If the target is unchanged (e.g. React re-renders after a drag
     * end and pushes the same target back), this is a no-op — we don't
     * re-trigger the press animation. This prevents a feedback loop where
     * drag-end → setState → useEffect → setToggleTarget would restart the
     * press animation that endToggleDrag just played.
     */
    setToggleTarget(groupId, target) {
      const st = this.ensureToggleState(groupId, target);
      if (st.isDragging) return;
      if (st.targetFraction === target) return;
      st.targetFraction = target;
      st.trackVelocityAfterRelease = false;
      st.targetVelocity = 0;
      st.velocity = 0;
      st.velocityVelocity = 0;
      st.velocityTracker.resetTracking();
      if (st.targetPress === 0) {
        st.targetPress = 1;
        st.targetScaleX = st.pressedScale;
        st.targetScaleY = st.pressedScale;
      }
      this.markGroupDirty(groupId);
      this.startAnimation();
    },
    /**
     * Begin a finger drag on a toggle group. Sets isDragging=true and
     * starts the press animation (scale → pressedScale, white overlay fades in).
     * The startFraction is recorded so drag deltas can be added to it.
     *
     * Faithful to DampedDragAnimation.press() which resets the VelocityTracker
     * (so samples from a previous gesture don't bleed into this one).
     */
    beginToggleDrag(groupId, startFraction) {
      const st = this.ensureToggleState(groupId, startFraction);
      st.isDragging = true;
      st.targetPress = 1;
      st.targetScaleX = st.pressedScale;
      st.targetScaleY = st.pressedScale;
      st.velocityTracker.resetTracking();
      st.targetVelocity = 0;
      st.velocity = 0;
      st.velocityVelocity = 0;
      this.markGroupDirty(groupId);
      this.startAnimation();
    },
    /**
     * Update the toggle's target fraction based on finger movement.
     * The new target is computed as `startFraction + (currentX - startX) / dragWidth`,
     * clamped to [0, 1]. The animated fraction then springs toward this
     * target with critically damped spec — so the knob tracks the finger
     * with a tiny smooth lag (matches the original's `updateValue(fraction)`
     * which animates toward the latest fraction state).
     *
     * VELOCITY TRACKING happens in the animation loop (methods-animation.ts),
     * NOT here. Faithful to DampedDragAnimation.kt: the tracker is fed
     * (time, valueAnimation.value) inside the valueAnimation.animateTo
     * block's per-frame callback (updateVelocity). The tracker uses a
     * least-squares fit (Compose VelocityTracker) rather than a spike-prone
     * ΔtargetFraction/Δt difference.
     */
    dragToggle(groupId, startFraction, currentX, startX, dragWidth) {
      const st = this.ensureToggleState(groupId, startFraction);
      if (!st.isDragging) return;
      const delta = (currentX - startX) / Math.max(1, dragWidth);
      const newTarget = Math.max(0, Math.min(1, startFraction + delta));
      st.targetFraction = newTarget;
      this.markGroupDirty(groupId);
      this.startAnimation();
    },
    /**
     * End a finger drag. Snaps the target to 0 or 1 based on the current
     * targetFraction (≥0.5 → 1, else 0). Returns the snapped value so the
     * React layer can sync its state.
     *
     * NOTE: We do NOT immediately release the press animation here. The
     * original `release()` waits for `value` to settle near `targetValue`
     * before animating press→0. Our animation loop's auto-release logic
     * handles this: when `isDragging === false` and `fraction` is within
     * 0.02 of `targetFraction`, it sets `targetPress = 0` and
     * `targetScaleX/Y = 1`. This gives a smooth "press stays until knob
     * settles, then releases" feel that matches the original.
     *
     * We also decay the velocity target to 0 (the drag is over).
     */
    endToggleDrag(groupId) {
      const st = this.toggleStates.get(groupId);
      if (!st) return 0;
      st.isDragging = false;
      const finalTarget = st.targetFraction >= 0.5 ? 1 : 0;
      st.targetFraction = finalTarget;
      st.trackVelocityAfterRelease = true;
      this.markGroupDirty(groupId);
      this.startAnimation();
      return finalTarget;
    },
    /**
     * End a finger drag on a SLIDER group. Unlike toggle (which snaps to 0/1),
     * a slider is a continuous (stepless) control — faithful to LiquidSlider.kt's
     * `onDragStopped = { if (didDrag) onValueChange(targetValue) }` which returns
     * the continuous targetValue WITHOUT snapping.
     *
     * Returns the continuous target fraction (0..1) so the React layer can sync
     * its state. The press animation auto-releases when the fraction settles.
     */
    endSliderDrag(groupId) {
      const st = this.toggleStates.get(groupId);
      if (!st) return 0;
      st.isDragging = false;
      const finalTarget = st.targetFraction;
      st.trackVelocityAfterRelease = true;
      this.markGroupDirty(groupId);
      this.startAnimation();
      return finalTarget;
    },
    /** Read the current animated fraction (0..1) for a toggle group. */
    getToggleFraction(groupId) {
      var _a, _b;
      return (_b = (_a = this.toggleStates.get(groupId)) == null ? void 0 : _a.fraction) != null ? _b : 0;
    },
    /**
     * Set the fraction to an absolute value during a slider drag. Used by the
     * slider track drag handler so the knob jumps to the finger position and
     * follows it (absolute positioning, like a tap but continuous). This matches
     * the original LiquidSlider.kt track tap-to-position behavior, extended to
     * drag for better usability on a small knob.
     *
     * Unlike setToggleTarget (which no-ops during isDragging), this directly
     * sets targetFraction so it works mid-drag.
     */
    setSliderDragPosition(groupId, fraction) {
      const st = this.toggleStates.get(groupId);
      if (!st) return;
      const clamped = Math.max(0, Math.min(1, fraction));
      if (st.targetFraction !== clamped) {
        st.targetFraction = clamped;
        this.markGroupDirty(groupId);
        this.startAnimation();
      }
    },
    /** Read the current target fraction (0..1) for a toggle group. */
    getToggleTarget(groupId) {
      var _a, _b;
      return (_b = (_a = this.toggleStates.get(groupId)) == null ? void 0 : _a.targetFraction) != null ? _b : 0;
    }
  };

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/spring.ts
  var DP = 1;
  var SPRING_K = 300;
  var SPRING_DAMPING_RATIO = 0.38;
  var SPRING_OMEGA_N = Math.sqrt(SPRING_K);
  var SPRING_OMEGA_D = SPRING_OMEGA_N * Math.sqrt(1 - SPRING_DAMPING_RATIO * SPRING_DAMPING_RATIO);
  var SPRING_THRESHOLD = 3e-3;
  var TOGGLE_VALUE_K = 1e3;
  var TOGGLE_VALUE_OMEGA_N = Math.sqrt(TOGGLE_VALUE_K);
  var TOGGLE_SCALE_X_K = 250;
  var TOGGLE_SCALE_X_DAMPING_RATIO = 0.42;
  var TOGGLE_SCALE_X_OMEGA_N = Math.sqrt(TOGGLE_SCALE_X_K);
  var TOGGLE_SCALE_X_OMEGA_D = TOGGLE_SCALE_X_OMEGA_N * Math.sqrt(1 - TOGGLE_SCALE_X_DAMPING_RATIO * TOGGLE_SCALE_X_DAMPING_RATIO);
  var TOGGLE_SCALE_Y_K = 250;
  var TOGGLE_SCALE_Y_DAMPING_RATIO = 0.48;
  var TOGGLE_SCALE_Y_OMEGA_N = Math.sqrt(TOGGLE_SCALE_Y_K);
  var TOGGLE_SCALE_Y_OMEGA_D = TOGGLE_SCALE_Y_OMEGA_N * Math.sqrt(1 - TOGGLE_SCALE_Y_DAMPING_RATIO * TOGGLE_SCALE_Y_DAMPING_RATIO);
  var TOGGLE_VELOCITY_K = 300;
  var TOGGLE_VELOCITY_DAMPING_RATIO = 0.38;
  var TOGGLE_VELOCITY_OMEGA_N = Math.sqrt(TOGGLE_VELOCITY_K);
  var TOGGLE_VELOCITY_OMEGA_D = TOGGLE_VELOCITY_OMEGA_N * Math.sqrt(1 - TOGGLE_VELOCITY_DAMPING_RATIO * TOGGLE_VELOCITY_DAMPING_RATIO);
  function springStep1D(current, velocity, target, dt) {
    const x0 = current - target;
    const v0 = velocity;
    const decay = Math.exp(-SPRING_DAMPING_RATIO * SPRING_OMEGA_N * dt);
    const cosWd = Math.cos(SPRING_OMEGA_D * dt);
    const sinWd = Math.sin(SPRING_OMEGA_D * dt);
    const offset = x0 * decay * cosWd + (v0 + SPRING_DAMPING_RATIO * SPRING_OMEGA_N * x0) / SPRING_OMEGA_D * decay * sinWd;
    const b0 = (v0 + SPRING_DAMPING_RATIO * SPRING_OMEGA_N * x0) / SPRING_OMEGA_D;
    const newVel = -SPRING_DAMPING_RATIO * SPRING_OMEGA_N * offset + decay * (-x0 * SPRING_OMEGA_D * sinWd + b0 * SPRING_OMEGA_D * cosWd);
    return { current: target + offset, velocity: newVel };
  }
  function springStepCritical(current, velocity, target, dt, omegaN) {
    const x0 = current - target;
    const v0 = velocity;
    const decay = Math.exp(-omegaN * dt);
    const offset = x0 * decay + (v0 + omegaN * x0) * dt * decay;
    const newVel = -omegaN * x0 * decay + (v0 + omegaN * x0) * (decay - omegaN * dt * decay);
    return { current: target + offset, velocity: newVel };
  }
  function springStepUnderdamped(current, velocity, target, dt, omegaN, dampingRatio) {
    const x0 = current - target;
    const v0 = velocity;
    const omegaD = omegaN * Math.sqrt(1 - dampingRatio * dampingRatio);
    const decay = Math.exp(-dampingRatio * omegaN * dt);
    const cosWd = Math.cos(omegaD * dt);
    const sinWd = Math.sin(omegaD * dt);
    const offset = x0 * decay * cosWd + (v0 + dampingRatio * omegaN * x0) / omegaD * decay * sinWd;
    const b0 = (v0 + dampingRatio * omegaN * x0) / omegaD;
    const newVel = -dampingRatio * omegaN * offset + decay * (-x0 * omegaD * sinWd + b0 * omegaD * cosWd);
    return { current: target + offset, velocity: newVel };
  }

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-tabs.ts
  var tabsMethods = {
    /**
     * Set the tab indicator's target index. Animates with critically
     * damped spring. Also triggers a quick press-and-release cycle.
     */
    setTabSelected(groupId, tabIndex, tabsCount) {
      const st = this.ensureToggleState(
        groupId,
        tabIndex,
        LiquidGlassRenderer.TAB_PRESSED_SCALE,
        tabsCount - 1
        // valueRangeSpan — faithful to DampedDragAnimation valueRange 0..(tabsCount-1)
      );
      if (st.isDragging) return;
      if (st.targetFraction === tabIndex) return;
      st.targetFraction = tabIndex;
      st.trackVelocityAfterRelease = false;
      st.targetVelocity = 0;
      st.velocity = 0;
      st.velocityVelocity = 0;
      st.velocityTracker.resetTracking();
      if (st.targetPress === 0) {
        st.targetPress = 1;
        st.targetScaleX = st.pressedScale;
        st.targetScaleY = st.pressedScale;
      }
      this.markGroupDirty(groupId);
      this.startAnimation();
    },
    /**
     * Begin a finger drag on the tab indicator. Sets isDragging=true and
     * starts the press animation (scale → 78/56).
     */
    beginTabDrag(groupId, startTabIndex, tabsCount) {
      const st = this.ensureToggleState(
        groupId,
        startTabIndex,
        LiquidGlassRenderer.TAB_PRESSED_SCALE,
        tabsCount - 1
        // valueRangeSpan — faithful to DampedDragAnimation valueRange 0..(tabsCount-1)
      );
      st.isDragging = true;
      st.targetPress = 1;
      st.targetScaleX = st.pressedScale;
      st.targetScaleY = st.pressedScale;
      st.velocityTracker.resetTracking();
      st.targetVelocity = 0;
      st.velocity = 0;
      st.velocityVelocity = 0;
      this.markGroupDirty(groupId);
      this.startAnimation();
    },
    /**
     * Update the tab indicator's target based on finger movement.
     * newTarget = startTabIndex + (currentX - startX) / tabWidth, clamped to [0, tabsCount-1].
     * Also updates panelOffset: 4dp * sign(fraction) * EaseOut(|fraction|).
     *
     * VELOCITY TRACKING happens in the animation loop (methods-animation.ts),
     * faithful to DampedDragAnimation.updateVelocity() which feeds (time, value)
     * to the VelocityTracker inside the valueAnimation.animateTo block.
     */
    dragTab(groupId, startTabIndex, currentX, startX, tabWidth, tabsCount) {
      const st = this.ensureToggleState(
        groupId,
        startTabIndex,
        LiquidGlassRenderer.TAB_PRESSED_SCALE,
        tabsCount - 1
        // valueRangeSpan — faithful to DampedDragAnimation valueRange 0..(tabsCount-1)
      );
      if (!st.isDragging) return;
      const delta = (currentX - startX) / Math.max(1, tabWidth);
      const newTarget = Math.max(0, Math.min(tabsCount - 1, startTabIndex + delta));
      st.targetFraction = newTarget;
      const maxWidth = tabWidth * tabsCount;
      const offsetFraction = Math.max(-1, Math.min(1, (currentX - startX) / Math.max(1, maxWidth)));
      const easeOut = 1 - Math.pow(1 - Math.abs(offsetFraction), 2);
      st.targetPanelOffset = 4 * DP * Math.sign(offsetFraction) * easeOut;
      this.markGroupDirty(groupId);
      this.startAnimation();
    },
    /**
     * End a finger drag. Snaps to nearest tab index. Returns the snapped index.
     * panelOffset springs back to 0 (spring(1f, 300f) — critically damped).
     */
    endTabDrag(groupId, tabsCount) {
      const st = this.toggleStates.get(groupId);
      if (!st) return 0;
      st.isDragging = false;
      const finalTarget = Math.round(st.targetFraction);
      const clamped = Math.max(0, Math.min(tabsCount - 1, finalTarget));
      st.targetFraction = clamped;
      st.velocityTracker.resetTracking();
      st.trackVelocityAfterRelease = false;
      st.targetVelocity = 0;
      st.targetPanelOffset = 0;
      this.markGroupDirty(groupId);
      this.startAnimation();
      return clamped;
    },
    /** Read the current animated tab fraction (0..tabsCount-1). */
    getTabFraction(groupId) {
      var _a, _b;
      return (_b = (_a = this.toggleStates.get(groupId)) == null ? void 0 : _a.fraction) != null ? _b : 0;
    },
    /** Read the current target tab index. */
    getTabTarget(groupId) {
      var _a, _b;
      return (_b = (_a = this.toggleStates.get(groupId)) == null ? void 0 : _a.targetFraction) != null ? _b : 0;
    }
  };

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-elements.ts
  function elementCacheSignature(el) {
    return JSON.stringify([
      el.rect.w,
      el.rect.h,
      el.cornerRadius,
      el.blurRadius,
      el.useSeparableBlur,
      el.scrimColor,
      el.surfaceColor,
      el.tintColor,
      el.independentBackdrop,
      el.sampleWallpaper,
      el.chromaticAberration,
      el.outerShadow,
      el.highlight,
      el.isMagnifier,
      el.isSdfTexture,
      el.enterProgress,
      el.enterSafeProgress,
      el.enterStretchFactor,
      el.useGravityAngle,
      el.elementRotation,
      el.backdropFbo,
      el.brightness,
      el.contrast,
      el.saturation,
      el.useContinuousSdf,
      el.isToggleKnob,
      el.isToggleTrack,
      el.isSliderFill,
      el.isBottomTabContainer,
      el.isBottomTabContent,
      el.isBottomTabIndicator,
      el.sceneBlurRadius,
      // Refraction params (refractionHeight / refractionAmount / depthEffect)
      // are baked into the elFbo by the element pass shader — changing them
      // WITHOUT invalidating the cache returns the stale baked elFbo. This was
      // the root cause of "GP refraction sliders don't refresh the glass body":
      // the catalog rebuilds gp-square with new refraction params, but the
      // signature matched → cache HIT → stale texture composited.
      el.refractionHeight,
      el.refractionAmount,
      el.depthEffect
      // NOTE: cornerStyle is a GLOBAL renderer field (this.cornerStyle), not
      // per-element — its change is handled by the context.tsx effect that
      // calls markAllDirty(). layerScale is derived at render time from
      // element state, not stored on the config. Both deliberately excluded.
      // elementScaleX/Y are also deliberately excluded — they only affect the
      // composite-time visual scale (elFbo stays at baseline resolution), so
      // zoom changes don't need to invalidate the baked glass body.
    ]);
  }
  var elementMethods = {
    /** Set the element list. Triggers foreground re-raster for changed elements. */
    setElements(configs) {
      this.setButtons(configs);
    },
    /** Set the element list (legacy name; same as setElements). */
    setButtons(configs) {
      var _a, _b;
      const prevIds = new Set(this.buttonConfigs.map((b) => b.id));
      const nextIds = new Set(configs.map((b) => b.id));
      for (const id of nextIds) if (!prevIds.has(id)) this.fgDirtyIds.add(id);
      for (const next of configs) {
        const prev = this.buttonConfigs.find((b) => b.id === next.id);
        if (!prev) continue;
        const eq4 = (a, b) => {
          if (!a || !b) return a === b;
          if (a.length !== b.length) return false;
          for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
          return true;
        };
        const prevTextIcon = (_a = prev.text) == null ? void 0 : _a.icon;
        const nextTextIcon = (_b = next.text) == null ? void 0 : _b.icon;
        const textIconChanged = !!prevTextIcon !== !!nextTextIcon || prevTextIcon && nextTextIcon && (prevTextIcon.path !== nextTextIcon.path || prevTextIcon.size !== nextTextIcon.size || !eq4(prevTextIcon.color, nextTextIcon.color));
        const prevBtnIcon = prev.icon;
        const nextBtnIcon = next.icon;
        const btnIconChanged = !!prevBtnIcon !== !!nextBtnIcon || prevBtnIcon && nextBtnIcon && (prevBtnIcon.path !== nextBtnIcon.path || prevBtnIcon.size !== nextBtnIcon.size || !eq4(prevBtnIcon.color, nextBtnIcon.color));
        const pt = prev.text;
        const nt = next.text;
        const textPropsChanged = !!pt !== !!nt || pt && nt && (!eq4(pt.color, nt.color) || pt.halo !== nt.halo || pt.fontSizePx !== nt.fontSizePx || pt.fontWeight !== nt.fontWeight || pt.align !== nt.align || pt.wrap !== nt.wrap || pt.paddingPx !== nt.paddingPx || pt.valign !== nt.valign || pt.maxLines !== nt.maxLines);
        if (prev.label !== next.label || !eq4(prev.labelColor, next.labelColor) || prev.showChevron !== next.showChevron || prev.rect.w !== next.rect.w || prev.rect.h !== next.rect.h || next.text && prev.text && prev.text.content !== next.text.content || next.text && !prev.text || !next.text && prev.text || textIconChanged || btnIconChanged || textPropsChanged) {
          this.fgDirtyIds.add(next.id);
        }
      }
      for (const id of prevIds) {
        if (!nextIds.has(id)) {
          this.buttonStates.delete(id);
          const tex = this.fgTextures.get(id);
          if (tex) {
            this.gl.deleteTexture(tex);
            this.fgTextures.delete(id);
          }
          this.fgDirtyIds.delete(id);
          this.deleteElFboCacheEntry(id);
        }
      }
      for (const c of configs) {
        if (!this.buttonStates.has(c.id)) {
          const initValue = 0;
          this.buttonStates.set(c.id, {
            pressProgress: 0,
            pressVelocity: 0,
            targetPress: 0,
            dragX: 0,
            dragY: 0,
            dragVx: 0,
            dragVy: 0,
            targetDragX: 0,
            targetDragY: 0,
            startDragX: 0,
            startDragY: 0,
            interactiveValue: initValue,
            interactiveVelocity: 0,
            targetInteractiveValue: initValue
          });
        }
      }
      const prevSigMap = /* @__PURE__ */ new Map();
      for (const p of this.buttonConfigs) prevSigMap.set(p.id, elementCacheSignature(p));
      for (const next of configs) {
        const prevSig = prevSigMap.get(next.id);
        if (prevSig !== void 0 && prevSig !== elementCacheSignature(next)) {
          this.markElementDirty(next.id);
        }
      }
      const hadIndicator = this.buttonConfigs.some((b) => b.isBottomTabIndicator);
      const hasIndicator = configs.some((b) => b.isBottomTabIndicator);
      if (!hadIndicator && hasIndicator) {
        this.pendingExtraRenders = 1;
      }
      this.buttonConfigs = configs;
      this.requestRender();
    },
    /**
     * Set the interactive value (0..1 for toggle/slider; integer index for
     * tabbar) for an element. The renderer springs `interactiveValue` toward
     * this target so motion looks animated, not snapped.
     */
    setInteractiveValue(id, value) {
      const st = this.buttonStates.get(id);
      if (!st) return;
      if (st.targetInteractiveValue !== value) {
        st.targetInteractiveValue = value;
        this.markElementDirty(id);
        this.startAnimation();
        this.requestRender();
      }
    },
    /**
     * Set the pressed state for a button. `position` is the finger position
     * in canvas CSS pixels (top-left origin). When pressed=true, the position
     * is recorded as the drag start; subsequent calls with pressed=true update
     * the drag target. When pressed=false, the drag target springs back to
     * the start position.
     *
     * FAITHFUL TO InteractiveHighlight.kt:
     *   - onDragStart: positionAnimation.snapTo(down.position)  // instant snap
     *   - onDrag:      positionAnimation.snapTo(change.position) // instant snap
     *   - onDragEnd:   positionAnimation.animateTo(startPosition, springSpec) // spring back
     *
     * So during a drag the position FOLLOWS the finger instantly (no spring
     * lag); only on release does the spring kick in to return to start.
     */
    setPressed(id, pressed, position) {
      const st = this.buttonStates.get(id);
      if (!st) return;
      if (pressed) {
        const btn = this.buttonConfigs.find((b) => b.id === id);
        if (btn && position) {
          const localX = position.x - btn.rect.x;
          const localY = position.y - btn.rect.y;
          if (st.targetPress === 0) {
            st.startDragX = localX;
            st.startDragY = localY;
            st.dragX = localX;
            st.dragY = localY;
            st.dragVx = 0;
            st.dragVy = 0;
          }
          st.dragX = localX;
          st.dragY = localY;
          st.dragVx = 0;
          st.dragVy = 0;
          st.targetDragX = localX;
          st.targetDragY = localY;
        }
        st.targetPress = 1;
      } else {
        st.targetPress = 0;
        st.targetDragX = st.startDragX;
        st.targetDragY = st.startDragY;
      }
      this.markElementDirty(id);
      this.startAnimation();
    },
    /**
     * Update the drag position while pressed (without changing press state).
     * Used for pointermove during a drag.
     *
     * FAITHFUL TO InteractiveHighlight.kt: positionAnimation.snapTo(change.position)
     * — the position FOLLOWS the finger instantly with no spring lag. Only
     * on release (setPressed false) does the spring kick in to return to start.
     */
    setDragPosition(id, position) {
      const st = this.buttonStates.get(id);
      if (!st || st.targetPress === 0) return;
      const btn = this.buttonConfigs.find((b) => b.id === id);
      if (!btn) return;
      const localX = position.x - btn.rect.x;
      const localY = position.y - btn.rect.y;
      st.dragX = localX;
      st.dragY = localY;
      st.dragVx = 0;
      st.dragVy = 0;
      st.targetDragX = localX;
      st.targetDragY = localY;
      this.markElementDirty(id);
      this.requestRender();
    }
  };

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-animation.ts
  var animationMethods = {
    /**
     * Spring-based animation loop. Matches InteractiveHighlight.kt's
     * spring(0.5f, 300f) spec — underdamped, with a small overshoot on
     * release. Uses real wall-clock dt for frame-rate-independent timing.
     */
    startAnimation() {
      if (this.animRafId !== null) return;
      let lastTime = performance.now();
      const tick = () => {
        const now = performance.now();
        const dt = Math.min((now - lastTime) / 1e3, 0.05);
        lastTime = now;
        let stillAnimating = false;
        for (const [id, st] of this.buttonStates.entries()) {
          let elementDirty = false;
          const pDelta = Math.abs(st.targetPress - st.pressProgress);
          if (pDelta > SPRING_THRESHOLD || Math.abs(st.pressVelocity) > SPRING_THRESHOLD) {
            const r = springStep1D(
              st.pressProgress,
              st.pressVelocity,
              st.targetPress,
              dt
            );
            st.pressProgress = r.current;
            st.pressVelocity = r.velocity;
            stillAnimating = true;
            elementDirty = true;
          } else {
            st.pressProgress = st.targetPress;
            st.pressVelocity = 0;
          }
          if (Math.abs(st.targetDragX - st.dragX) > SPRING_THRESHOLD || Math.abs(st.dragVx) > SPRING_THRESHOLD) {
            const r = springStep1D(st.dragX, st.dragVx, st.targetDragX, dt);
            st.dragX = r.current;
            st.dragVx = r.velocity;
            stillAnimating = true;
            elementDirty = true;
          } else {
            st.dragX = st.targetDragX;
            st.dragVx = 0;
          }
          if (Math.abs(st.targetDragY - st.dragY) > SPRING_THRESHOLD || Math.abs(st.dragVy) > SPRING_THRESHOLD) {
            const r = springStep1D(st.dragY, st.dragVy, st.targetDragY, dt);
            st.dragY = r.current;
            st.dragVy = r.velocity;
            stillAnimating = true;
            elementDirty = true;
          } else {
            st.dragY = st.targetDragY;
            st.dragVy = 0;
          }
          const iDelta = Math.abs(st.targetInteractiveValue - st.interactiveValue);
          if (iDelta > SPRING_THRESHOLD || Math.abs(st.interactiveVelocity) > SPRING_THRESHOLD) {
            const r = springStep1D(
              st.interactiveValue,
              st.interactiveVelocity,
              st.targetInteractiveValue,
              dt
            );
            st.interactiveValue = r.current;
            st.interactiveVelocity = r.velocity;
            stillAnimating = true;
            elementDirty = true;
          } else {
            st.interactiveValue = st.targetInteractiveValue;
            st.interactiveVelocity = 0;
          }
          if (elementDirty) this.markElementDirty(id);
        }
        for (const [groupId, tg] of this.toggleStates) {
          let groupDirty = false;
          if (tg.targetPress === 1 && !tg.isDragging && Math.abs(tg.targetFraction - tg.fraction) < 0.02) {
            tg.targetPress = 0;
            tg.targetScaleX = 1;
            tg.targetScaleY = 1;
            groupDirty = true;
            this.startAnimation();
          }
          const fDelta = Math.abs(tg.targetFraction - tg.fraction);
          if (fDelta > SPRING_THRESHOLD || Math.abs(tg.fractionVelocity) > SPRING_THRESHOLD) {
            const r = springStepCritical(
              tg.fraction,
              tg.fractionVelocity,
              tg.targetFraction,
              dt,
              TOGGLE_VALUE_OMEGA_N
            );
            tg.fraction = r.current;
            tg.fractionVelocity = r.velocity;
            if (tg.trackVelocityAfterRelease || tg.isDragging) {
              const nowMs = performance.now();
              tg.velocityTracker.addPosition(nowMs, tg.fraction);
              const tracked = tg.velocityTracker.calculateVelocity();
              const span = tg.valueRangeSpan || 1;
              tg.targetVelocity = tracked / span;
            }
            stillAnimating = true;
            groupDirty = true;
          } else {
            tg.fraction = tg.targetFraction;
            tg.fractionVelocity = 0;
            if (!tg.isDragging) {
              tg.targetVelocity = 0;
              tg.trackVelocityAfterRelease = false;
              tg.velocityTracker.resetTracking();
            }
          }
          const ppDelta = Math.abs(tg.targetPress - tg.pressProgress);
          if (ppDelta > SPRING_THRESHOLD || Math.abs(tg.pressVelocity) > SPRING_THRESHOLD) {
            const r = springStepCritical(
              tg.pressProgress,
              tg.pressVelocity,
              tg.targetPress,
              dt,
              TOGGLE_VALUE_OMEGA_N
            );
            tg.pressProgress = r.current;
            tg.pressVelocity = r.velocity;
            stillAnimating = true;
            groupDirty = true;
          } else {
            tg.pressProgress = tg.targetPress;
            tg.pressVelocity = 0;
          }
          const sx = Math.abs(tg.targetScaleX - tg.scaleX);
          if (sx > SPRING_THRESHOLD || Math.abs(tg.scaleXVelocity) > SPRING_THRESHOLD) {
            const r = springStepUnderdamped(
              tg.scaleX,
              tg.scaleXVelocity,
              tg.targetScaleX,
              dt,
              TOGGLE_SCALE_X_OMEGA_N,
              TOGGLE_SCALE_X_DAMPING_RATIO
            );
            tg.scaleX = r.current;
            tg.scaleXVelocity = r.velocity;
            stillAnimating = true;
            groupDirty = true;
          } else {
            tg.scaleX = tg.targetScaleX;
            tg.scaleXVelocity = 0;
          }
          const sy = Math.abs(tg.targetScaleY - tg.scaleY);
          if (sy > SPRING_THRESHOLD || Math.abs(tg.scaleYVelocity) > SPRING_THRESHOLD) {
            const r = springStepUnderdamped(
              tg.scaleY,
              tg.scaleYVelocity,
              tg.targetScaleY,
              dt,
              TOGGLE_SCALE_Y_OMEGA_N,
              TOGGLE_SCALE_Y_DAMPING_RATIO
            );
            tg.scaleY = r.current;
            tg.scaleYVelocity = r.velocity;
            stillAnimating = true;
            groupDirty = true;
          } else {
            tg.scaleY = tg.targetScaleY;
            tg.scaleYVelocity = 0;
          }
          const vDelta = Math.abs(tg.targetVelocity - tg.velocity);
          if (vDelta > SPRING_THRESHOLD || Math.abs(tg.velocityVelocity) > SPRING_THRESHOLD) {
            const r = springStepUnderdamped(
              tg.velocity,
              tg.velocityVelocity,
              tg.targetVelocity,
              dt,
              TOGGLE_VELOCITY_OMEGA_N,
              TOGGLE_VELOCITY_DAMPING_RATIO
            );
            tg.velocity = r.current;
            tg.velocityVelocity = r.velocity;
            stillAnimating = true;
            groupDirty = true;
          } else {
            tg.velocity = tg.targetVelocity;
            tg.velocityVelocity = 0;
          }
          const poDelta = Math.abs(tg.targetPanelOffset - tg.panelOffset);
          if (poDelta > SPRING_THRESHOLD || Math.abs(tg.panelOffsetVelocity) > SPRING_THRESHOLD) {
            const r = springStepCritical(
              tg.panelOffset,
              tg.panelOffsetVelocity,
              tg.targetPanelOffset,
              dt,
              Math.sqrt(300)
              // ω_n = sqrt(k) = sqrt(300) ≈ 17.32
            );
            tg.panelOffset = r.current;
            tg.panelOffsetVelocity = r.velocity;
            stillAnimating = true;
            groupDirty = true;
          } else {
            tg.panelOffset = tg.targetPanelOffset;
            tg.panelOffsetVelocity = 0;
          }
          if (groupDirty) this.markGroupDirty(groupId);
        }
        if (Math.abs(this.scrollVelocity) > 0.5) {
          const SCROLL_DECAY = 4;
          const newScrollY = this.scrollY + this.scrollVelocity * dt;
          const clamped = this.clampScrollValue(newScrollY);
          if (clamped !== newScrollY) {
            this.scrollY = clamped;
            this.scrollVelocity = 0;
          } else {
            this.scrollY = clamped;
            this.scrollVelocity *= Math.exp(-SCROLL_DECAY * dt);
          }
          stillAnimating = true;
        } else {
          this.scrollVelocity = 0;
        }
        if (stillAnimating) {
          this.requestRender();
          this.animRafId = requestAnimationFrame(tick);
        } else {
          this.requestRender();
          this.animRafId = null;
        }
      };
      this.animRafId = requestAnimationFrame(tick);
    },
    requestRender() {
      this.needsRedraw = true;
      if (this.rafId !== null) return;
      this.rafId = requestAnimationFrame(() => {
        this.rafId = null;
        this.render();
      });
    }
  };

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-raster.ts
  var rasterMethods = {
    rasterizeForeground(cfg) {
      var _a, _b;
      if (cfg.kind === "text" && cfg.text) {
        this.rasterizeText(cfg);
        return;
      }
      if (cfg.kind !== "button" && !cfg.label && !cfg.icon) {
        this.fgDirtyIds.delete(cfg.id);
        return;
      }
      const dpr = this.dpr;
      const w = Math.max(1, Math.round(cfg.rect.w * dpr));
      const h = Math.max(1, Math.round(cfg.rect.h * dpr));
      if (this.fgCanvas.width !== w) this.fgCanvas.width = w;
      if (this.fgCanvas.height !== h) this.fgCanvas.height = h;
      const ctx = this.fgCtx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.scale(dpr, dpr);
      const cssW = cfg.rect.w;
      const cssH = cfg.rect.h;
      if (cfg.icon) {
        const iconSize = cfg.icon.size;
        const ic = cfg.icon.color;
        ctx.save();
        ctx.translate(cssW / 2 - iconSize / 2, cssH / 2 - iconSize / 2);
        const vp = (_a = cfg.icon.viewport) != null ? _a : 24;
        ctx.scale(iconSize / vp, iconSize / vp);
        const p = new Path2D(cfg.icon.path);
        ctx.fillStyle = `rgba(${Math.round(ic[0] * 255)}, ${Math.round(
          ic[1] * 255
        )}, ${Math.round(ic[2] * 255)}, ${ic[3]})`;
        ctx.fill(p);
        ctx.restore();
        this.uploadForegroundTexture(cfg.id);
        this.fgDirtyIds.delete(cfg.id);
        return;
      }
      const fontPx = (_b = cfg.labelFontSizePx) != null ? _b : cssH * (15 / 48);
      const fontFamily = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
      ctx.font = `400 ${fontPx}px ${fontFamily}`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      const colorStr = `rgba(${Math.round(cfg.labelColor[0] * 255)}, ${Math.round(
        cfg.labelColor[1] * 255
      )}, ${Math.round(cfg.labelColor[2] * 255)}, ${cfg.labelColor[3]})`;
      const haloIsLight = cfg.labelColor[0] + cfg.labelColor[1] + cfg.labelColor[2] < 1.5;
      ctx.save();
      ctx.shadowColor = haloIsLight ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0.15)";
      ctx.shadowBlur = haloIsLight ? fontPx * 0.12 : fontPx * 0.05;
      ctx.fillStyle = colorStr;
      ctx.fillText(cfg.label, cssW / 2, cssH / 2 + 0.5);
      ctx.restore();
      if (cfg.showChevron) {
        const chevronSize = fontPx * 0.93;
        const labelWidth = ctx.measureText(cfg.label).width;
        const cx = cssW / 2 + labelWidth / 2 + fontPx * 0.53 + chevronSize / 2;
        const cy = cssH / 2;
        ctx.save();
        ctx.strokeStyle = colorStr;
        ctx.globalAlpha = 0.6;
        ctx.lineWidth = fontPx * 0.107;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(cx - chevronSize * 0.3, cy - chevronSize * 0.4);
        ctx.lineTo(cx + chevronSize * 0.2, cy);
        ctx.lineTo(cx - chevronSize * 0.3, cy + chevronSize * 0.4);
        ctx.stroke();
        ctx.restore();
      }
      this.uploadForegroundTexture(cfg.id);
      this.fgDirtyIds.delete(cfg.id);
    },
    /* ---------------------------------------------------------------- *
     * Text-element rasterizer — draws an arbitrary text label (with
     * optional word wrap) to the foreground texture. Used for section
     * titles, dialog body text, slider value labels, etc.
     * ---------------------------------------------------------------- */
    rasterizeText(cfg) {
      var _a, _b, _c;
      if (!cfg.text) return;
      const dpr = this.dpr;
      const w = Math.max(1, Math.round(cfg.rect.w * dpr));
      const h = Math.max(1, Math.round(cfg.rect.h * dpr));
      if (this.fgCanvas.width !== w) this.fgCanvas.width = w;
      if (this.fgCanvas.height !== h) this.fgCanvas.height = h;
      const ctx = this.fgCtx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.scale(dpr, dpr);
      const t = cfg.text;
      const cssW = cfg.rect.w;
      const cssH = cfg.rect.h;
      const fontFamily = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
      ctx.font = `${t.fontWeight} ${t.fontSizePx}px ${fontFamily}`;
      ctx.textBaseline = "middle";
      const pad = (_a = t.paddingPx) != null ? _a : 0;
      let halo = "none";
      if (t.halo === "light") halo = "light";
      else if (t.halo === "dark") halo = "dark";
      else if (t.halo === "auto" || t.halo === void 0) {
        const bright = t.color[0] + t.color[1] + t.color[2];
        halo = bright < 1.5 ? "light" : "dark";
      }
      if (halo === "light") {
        ctx.shadowColor = "rgba(255,255,255,0.55)";
        ctx.shadowBlur = t.fontSizePx * 0.16;
      } else if (halo === "dark") {
        ctx.shadowColor = "rgba(0,0,0,0.28)";
        ctx.shadowBlur = t.fontSizePx * 0.1;
      } else {
        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
      }
      const colorStr = `rgba(${Math.round(t.color[0] * 255)}, ${Math.round(
        t.color[1] * 255
      )}, ${Math.round(t.color[2] * 255)}, ${t.color[3]})`;
      ctx.fillStyle = colorStr;
      let textYOffset = 0;
      if (t.icon) {
        const iconDrawSize = t.icon.size;
        const iconLayoutSize = (_b = t.icon.layoutSize) != null ? _b : iconDrawSize;
        const gap = t.content ? 2 : 0;
        const totalBlockH = iconLayoutSize + gap + (t.content ? t.fontSizePx : 0);
        const blockTop = cssH / 2 - totalBlockH / 2;
        const iconCx = cssW / 2;
        const iconCy = blockTop + iconLayoutSize / 2;
        ctx.save();
        ctx.translate(iconCx - iconDrawSize / 2, iconCy - iconDrawSize / 2);
        const vp = (_c = t.icon.viewport) != null ? _c : 24;
        ctx.scale(iconDrawSize / vp, iconDrawSize / vp);
        const p = new Path2D(t.icon.path);
        const ic = t.icon.color;
        ctx.fillStyle = `rgba(${Math.round(ic[0] * 255)}, ${Math.round(
          ic[1] * 255
        )}, ${Math.round(ic[2] * 255)}, ${ic[3]})`;
        ctx.fill(p);
        ctx.restore();
        textYOffset = (iconLayoutSize + gap) / 2;
      }
      if (t.align === "center") {
        ctx.textAlign = "center";
        if (t.wrap) {
          let lines = wrapText(ctx, t.content, cssW - pad * 2);
          if (t.maxLines != null && lines.length > t.maxLines) {
            lines = lines.slice(0, t.maxLines);
          }
          const lineH = t.fontSizePx * 1.35;
          const totalH = lineH * lines.length;
          let y;
          if (t.valign === "top") {
            y = lineH / 2 + textYOffset;
          } else if (t.valign === "bottom") {
            y = cssH - totalH + lineH / 2 + textYOffset;
          } else {
            y = cssH / 2 - totalH / 2 + lineH / 2 + textYOffset;
          }
          for (const line of lines) {
            ctx.fillText(line, cssW / 2, y);
            y += lineH;
          }
        } else {
          ctx.fillText(t.content, cssW / 2, cssH / 2 + 0.5 + textYOffset);
        }
      } else if (t.align === "left") {
        ctx.textAlign = "left";
        if (t.wrap) {
          let lines = wrapText(ctx, t.content, cssW - pad * 2);
          if (t.maxLines != null && lines.length > t.maxLines) {
            lines = lines.slice(0, t.maxLines);
          }
          const lineH = t.fontSizePx * 1.35;
          const totalH = lineH * lines.length;
          let y;
          if (t.valign === "top") {
            y = lineH / 2 + textYOffset;
          } else if (t.valign === "bottom") {
            y = cssH - totalH + lineH / 2 + textYOffset;
          } else {
            y = cssH / 2 - totalH / 2 + lineH / 2 + textYOffset;
          }
          for (const line of lines) {
            ctx.fillText(line, pad, y);
            y += lineH;
          }
        } else {
          ctx.fillText(t.content, pad, cssH / 2 + 0.5 + textYOffset);
        }
      } else {
        ctx.textAlign = "right";
        ctx.fillText(t.content, cssW - pad, cssH / 2 + 0.5 + textYOffset);
      }
      this.uploadForegroundTexture(cfg.id);
      this.fgDirtyIds.delete(cfg.id);
    },
    uploadForegroundTexture(id) {
      const gl = this.gl;
      let tex = this.fgTextures.get(id);
      if (!tex) {
        tex = gl.createTexture();
        this.fgTextures.set(id, tex);
      }
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.fgCanvas);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    }
  };

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-render-glass-geometry.ts
  function computeScissorMarginCss(el, layerScale, toggles) {
    const FLOOR_CSS = 3;
    if (!el.outerShadow || el.outerShadow.radius <= 0.5 || !toggles.outerShadow) {
      return FLOOR_CSS;
    }
    const radius = el.outerShadow.radius;
    const maxOffset = Math.max(Math.abs(el.outerShadow.offsetX), Math.abs(el.outerShadow.offsetY));
    const shadowReachCss = (radius + maxOffset) * layerScale;
    return Math.max(FLOOR_CSS, shadowReachCss + 2);
  }
  function inflatedOutputRect(el, x, y, w, h, togglePressProgress = 0) {
    var _a;
    const mod = el.isToggleKnob || el.isBottomTabIndicator ? Math.max(0, Math.min(1, togglePressProgress)) : 1;
    let blur = (el.blurRadius || 0) * mod;
    let shadow = 0;
    if (el.outerShadow && el.outerShadow.alpha * mod >= 0.15) {
      shadow = (el.outerShadow.radius + Math.max(Math.abs(el.outerShadow.offsetX), Math.abs(el.outerShadow.offsetY))) * mod;
    }
    if (el.isToggleKnob) {
      blur = (el.blurRadius || 0) * (1 - mod) * 0 + 8 * (1 - mod);
    }
    const m = Math.max(blur, shadow, 3) + 4;
    let rx = x - m, ry = y - m, rw = w + 2 * m, rh = h + 2 * m;
    const rot = (_a = el.elementRotation) != null ? _a : 0;
    if (Math.abs(rot) > 1e-3) {
      const cx = x + w / 2;
      const cy = y + h / 2;
      const cosA = Math.abs(Math.cos(rot));
      const sinA = Math.abs(Math.sin(rot));
      const rotW = rw * cosA + rh * sinA;
      const rotH = rw * sinA + rh * cosA;
      rx = cx - rotW / 2;
      ry = cy - rotH / 2;
      rw = rotW;
      rh = rotH;
    }
    return { x: rx, y: ry, w: rw, h: rh };
  }
  function shadowBboxCss(el, x, y, w, h, layerScaleX, layerScaleY, toggles) {
    if (!el.outerShadow || el.outerShadow.radius <= 0.5) return null;
    if (!toggles.outerShadow) return null;
    const r = el.outerShadow.radius;
    const ox = el.outerShadow.offsetX;
    const oy = el.outerShadow.offsetY;
    const left = Math.max(0, r - ox) * layerScaleX;
    const right = Math.max(0, r + ox) * layerScaleX;
    const top = Math.max(0, r - oy) * layerScaleY;
    const bottom = Math.max(0, r + oy) * layerScaleY;
    return {
      x: x - left,
      y: y - top,
      w: w + left + right,
      h: h + top + bottom
    };
  }
  function rectsOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-render-glass-transform.ts
  function computeElementTransform(el, st, r) {
    var _a, _b, _c;
    const isButton = el.kind === "button";
    const p = (_a = st == null ? void 0 : st.pressProgress) != null ? _a : 0;
    const PRESS_SCALE_RATIO = 4 / 48;
    let scale = 1;
    let translationX = 0;
    let translationY = 0;
    let scaleX = 1;
    let scaleY = 1;
    if (el.enterProgress != null) {
      const raw = el.enterProgress;
      const derived = raw < 0 ? (1 - Math.exp(-Math.abs(raw))) * -1 : raw <= 1 ? raw : 1 + (1 - Math.exp(-(raw - 1)));
      translationY += -48 * DP * (1 - derived);
      if (el.enterStretchFactor != null && derived > 1) {
        translationY += el.enterStretchFactor * (derived - 1) * 32 * DP;
      }
      const sFactor = 1 + 0.1 * Math.max(0, derived - 1);
      scaleX /= sFactor;
      scaleY *= sFactor;
    }
    if (isButton && el.isInteractive && st) {
      const width = el.rect.w;
      const height = el.rect.h;
      const maxDim = Math.max(width, height);
      const minDim = Math.min(width, height);
      const maxOffset = minDim;
      const initialDerivative = 0.05;
      const maxDragScale = PRESS_SCALE_RATIO;
      scale = 1 + PRESS_SCALE_RATIO * p;
      const dx = st.dragX - st.startDragX;
      const dy = st.dragY - st.startDragY;
      translationX = maxOffset * Math.tanh(initialDerivative * dx / maxOffset);
      translationY = maxOffset * Math.tanh(initialDerivative * dy / maxOffset);
      const offsetAngle = Math.atan2(dy, dx);
      const whCap = Math.min(width / height, 1);
      const hwCap = Math.min(height / width, 1);
      scaleX = scale + maxDragScale * Math.abs(Math.cos(offsetAngle) * dx / maxDim) * whCap;
      scaleY = scale + maxDragScale * Math.abs(Math.sin(offsetAngle) * dy / maxDim) * hwCap;
    } else if (el.enterProgress == null) {
      scaleX = scale;
      scaleY = scale;
    }
    let toggleXOffset = 0;
    let toggleScaleX = 1;
    let toggleScaleY = 1;
    let togglePressProgress = 0;
    if (el.isToggleKnob) {
      const tg = this.toggleStates.get(el.isToggleKnob.groupId);
      if (tg) {
        toggleXOffset = tg.fraction * el.isToggleKnob.dragWidth;
        toggleScaleX = tg.scaleX;
        toggleScaleY = tg.scaleY;
        togglePressProgress = tg.pressProgress;
        const divisor = (_b = el.isToggleKnob.velocityDivisor) != null ? _b : 50;
        const vel = tg.velocity / divisor;
        const velX = Math.max(-0.2, Math.min(0.2, vel * 0.75));
        const velY = Math.max(-0.2, Math.min(0.2, vel * 0.25));
        toggleScaleX = toggleScaleX / (1 - velX);
        toggleScaleY = toggleScaleY * (1 - velY);
      }
    }
    scaleX *= toggleScaleX;
    scaleY *= toggleScaleY;
    if (el.isBottomTabContainer) {
      const tg = this.toggleStates.get(el.isBottomTabContainer.groupId);
      if (tg) {
        if (!el.freezePressScale) {
          const containerScale = 1 + 16 * DP / el.rect.w * tg.pressProgress;
          scaleX *= containerScale;
          scaleY *= containerScale;
        }
        translationX += tg.panelOffset;
        togglePressProgress = tg.pressProgress;
      }
    }
    if (el.isBottomTabContent) {
      const tg = this.toggleStates.get(el.isBottomTabContent.groupId);
      if (tg) {
        if (!el.freezePressScale) {
          const containerW = (_c = el.isBottomTabContent.containerWidth) != null ? _c : el.rect.w;
          const containerScale = 1 + 16 * DP / containerW * tg.pressProgress;
          const contentScale = 1 + 0.2 * tg.pressProgress;
          scaleX *= containerScale * contentScale;
          scaleY *= containerScale * contentScale;
        }
        translationX += tg.panelOffset;
      }
    }
    if (el.isBottomTabIndicator) {
      const tg = this.toggleStates.get(el.isBottomTabIndicator.groupId);
      if (tg) {
        toggleXOffset += tg.fraction * el.isBottomTabIndicator.dragWidth;
        toggleXOffset += tg.panelOffset;
        if (!el.freezePressScale) {
          const indScaleX = tg.scaleX;
          const indScaleY = tg.scaleY;
          const vel = tg.velocity / 10;
          const velX = Math.max(-0.2, Math.min(0.2, vel * 0.75));
          const velY = Math.max(-0.2, Math.min(0.2, vel * 0.25));
          scaleX *= indScaleX / (1 - velX);
          scaleY *= indScaleY * (1 - velY);
        }
        togglePressProgress = Math.max(togglePressProgress, tg.pressProgress);
      }
    }
    if (el.elementScaleX != null) scaleX *= el.elementScaleX;
    if (el.elementScaleY != null) scaleY *= el.elementScaleY;
    const cx = r.x + el.rect.w / 2 + translationX + toggleXOffset;
    const cy = r.y + el.rect.h / 2 + translationY;
    const sw = el.rect.w * scaleX;
    const sh = el.rect.h * scaleY;
    const sx = cx - sw / 2;
    const sy = cy - sh / 2;
    const cornerRadius = el.cornerRadius * Math.min(scaleX, scaleY);
    const radii = [
      cornerRadius,
      cornerRadius,
      cornerRadius,
      cornerRadius
    ];
    const eligibleForDirect = el.independentBackdrop || el.directBackdropSample && this.directBackdropSample;
    const independent = !!(eligibleForDirect && !this.backgroundColor && this.wallpaperTexture);
    return {
      sx,
      sy,
      sw,
      sh,
      radii,
      scaleX,
      scaleY,
      isButton,
      p,
      togglePressProgress,
      translationX,
      translationY,
      independent
    };
  }

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-render-glass-backdrop.ts
  function shouldUseSeparableBlur(el, state) {
    if (el.isToggleKnob || el.isBottomTabIndicator) return false;
    if (el.blurRadius < 0.5) return false;
    if (el.sampleWallpaper) return false;
    if (el.isSdfTexture && !el.isSdfTexture.useSeparableBlur) return false;
    return true;
  }
  function buildGlassRenderState(args) {
    var _a;
    const { el, st, transform, usePerElementFbo, sceneRectOffsetX, sceneRectOffsetY, elFboW, elFboH } = args;
    const {
      sx,
      sy,
      sw,
      sh,
      radii,
      scaleX,
      scaleY,
      isButton,
      p,
      togglePressProgress,
      independent
    } = transform;
    return {
      el,
      st,
      isButton,
      p,
      sx,
      sy,
      sw,
      sh,
      radii,
      togglePressProgress,
      // For toggle knobs + bottom-tab indicators, the rim highlight alpha is
      // modulated by pressProgress (faithful to Highlight.Default.copy(alpha=progress)).
      elHighlightAlpha: el.isToggleKnob || el.isBottomTabIndicator ? (el.highlight ? el.highlight.alpha : 0) * togglePressProgress : el.highlight ? el.highlight.alpha : 0,
      // Faithful to ControlCenterContent.kt: alpha = EaseIn.transform(safeProgress)
      // where safeProgress = safeEnterProgressAnimation.value (clamped 0..1).
      // EaseIn = CubicBezierEasing(0.42, 0, 1, 1). Use enterSafeProgress if
      // available, else fall back to clamped enterProgress.
      enterAlpha: el.enterProgress != null ? easeIn(
        el.enterSafeProgress != null ? Math.max(0, Math.min(1, el.enterSafeProgress)) : Math.max(0, Math.min(1, el.enterProgress))
      ) : 1,
      layerScaleX: scaleX,
      layerScaleY: scaleY,
      layerScale: Math.min(scaleX, scaleY),
      // ORIGINAL geometry (unscaled) for the element-pass SDF. The shader
      // computes SDF/refraction in original space, then maps the refraction
      // offset to screen space via uLayerScale — faithful to the original
      // which shades at original size then scales via graphicsLayer.
      origW: el.rect.w,
      origH: el.rect.h,
      origCornerRadius: el.cornerRadius,
      elementRotation: (_a = el.elementRotation) != null ? _a : 0,
      independent,
      usePerElementFbo,
      sceneRectOffsetX,
      sceneRectOffsetY,
      elFboW,
      elFboH
    };
  }
  function resolveBackdropTex(state, curTex, outFbo) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _A, _B, _C, _D, _E, _F, _G, _H, _I, _J;
    const { el, independent, sx, sy, sw, sh, layerScale } = state;
    if (independent && shouldUseSeparableBlur(el, state) && this.quickToggles.backdropBlur) {
      const gl = this.gl;
      const blurRadiusPx = el.blurRadius * layerScale * this.dpr;
      const cssRadius = el.blurRadius * layerScale;
      const qRadius = Math.round(cssRadius * 10) / 10;
      const cacheKey = this.useBlurCache ? `wallpaper_${qRadius}_${this.useKawaseBlur ? "k" : "g"}` : null;
      const entry = cacheKey ? this.backdropBlurCache.get(cacheKey) : void 0;
      let blurred;
      let cacheHit = false;
      if (entry) {
        blurred = entry.tex;
        cacheHit = true;
        this.lastBlurStats = { type: entry.blurType, passes: 0, taps: 0, maxSample: 0, w: entry.w, h: entry.h, progMs: 0, stateMs: 0, drawMs: 0 };
      } else if (!cacheKey) {
        blurred = this.blurTexture(this.wallpaperBlurTex, blurRadiusPx);
      } else {
        if (this._blurCacheMissesThisFrame >= this.blurCacheMissesPerFrame) {
          return { backdropTex: curTex, didBlur: false };
        }
        this._blurCacheMissesThisFrame++;
        const t0 = performance.now();
        const blurResult = this.blurTexture(this.wallpaperBlurTex, blurRadiusPx);
        const t1 = performance.now();
        const progMs = (_b = (_a = this.lastBlurStats) == null ? void 0 : _a.progMs) != null ? _b : 0;
        const stateMs = (_d = (_c = this.lastBlurStats) == null ? void 0 : _c.stateMs) != null ? _d : 0;
        const drawMs = (_f = (_e = this.lastBlurStats) == null ? void 0 : _e.drawMs) != null ? _f : t1 - t0;
        const blurW = (_i = (_h = (_g = this.lastBlurStats) == null ? void 0 : _g.w) != null ? _h : this.dsBlurFboW) != null ? _i : this.fboW;
        const blurH = (_l = (_k = (_j = this.lastBlurStats) == null ? void 0 : _j.h) != null ? _k : this.dsBlurFboH) != null ? _l : this.fboH;
        const cacheFbo = this.acquireCacheFBO(blurW, blurH);
        const gl2 = this.gl;
        const savedFb = gl2.getParameter(gl2.FRAMEBUFFER_BINDING);
        const savedScissor = gl2.isEnabled(gl2.SCISSOR_TEST);
        const savedBox = gl2.getParameter(gl2.SCISSOR_BOX);
        gl2.disable(gl2.SCISSOR_TEST);
        if (!this.cacheCopyReadFbo) this.cacheCopyReadFbo = gl2.createFramebuffer();
        gl2.bindFramebuffer(gl2.FRAMEBUFFER, this.cacheCopyReadFbo);
        gl2.framebufferTexture2D(gl2.FRAMEBUFFER, gl2.COLOR_ATTACHMENT0, gl2.TEXTURE_2D, blurResult, 0);
        gl2.activeTexture(gl2.TEXTURE0);
        gl2.bindTexture(gl2.TEXTURE_2D, null);
        gl2.bindTexture(gl2.TEXTURE_2D, cacheFbo.tex);
        gl2.copyTexImage2D(gl2.TEXTURE_2D, 0, gl2.RGBA, 0, 0, blurW, blurH, 0);
        if (this.showBlurCacheCheckerboard) {
          gl2.bindFramebuffer(gl2.FRAMEBUFFER, cacheFbo.fb);
          gl2.viewport(0, 0, blurW, blurH);
          const cellSize = Math.max(8, Math.floor(blurW / 20));
          gl2.enable(gl2.SCISSOR_TEST);
          gl2.clearColor(0, 0, 0, 0);
          for (let cy = 0; cy < blurH; cy += cellSize) {
            for (let cx = 0; cx < blurW; cx += cellSize) {
              if ((Math.floor(cx / cellSize) + Math.floor(cy / cellSize)) % 2 !== 0) {
                gl2.scissor(cx, cy, Math.min(cellSize, blurW - cx), Math.min(cellSize, blurH - cy));
                gl2.clear(gl2.COLOR_BUFFER_BIT);
              }
            }
          }
          gl2.disable(gl2.SCISSOR_TEST);
        }
        const t2 = performance.now();
        const blurMs = t1 - t0;
        const copyMs = t2 - t1;
        let readPixelsMs = 0;
        let scanMs = 0;
        let snapW = 0, snapH = 0;
        let snapBuf = new Uint8Array(0);
        let snapNZ = 0;
        let minX = 0, minY = 0, maxX = 0, maxY = 0;
        if (this.showBlurCachePreview) {
          snapW = blurW;
          snapH = blurH;
          const ta = performance.now();
          snapBuf = new Uint8Array(snapW * snapH * 4);
          const tr0 = performance.now();
          gl2.bindFramebuffer(gl2.FRAMEBUFFER, cacheFbo.fb);
          gl2.readPixels(0, 0, snapW, snapH, gl2.RGBA, gl2.UNSIGNED_BYTE, snapBuf);
          const tr1 = performance.now();
          for (let y = 0; y < snapH; y++) {
            for (let x = 0; x < snapW; x++) {
              const i = (y * snapW + x) * 4;
              if (snapBuf[i] + snapBuf[i + 1] + snapBuf[i + 2] + snapBuf[i + 3] > 0) {
                snapNZ++;
                if (x < minX || snapNZ === 1) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY || snapNZ === 1) minY = y;
                if (y > maxY) maxY = y;
              }
            }
          }
          const ts = performance.now();
          readPixelsMs = tr1 - tr0;
          scanMs = ts - tr1 + (tr0 - ta);
        }
        this.backdropBlurCacheSnapshots.push({
          key: snapW > 0 ? `${cacheKey} [${minX},${minY}-${maxX},${maxY}]` : cacheKey,
          w: snapW,
          h: snapH,
          rgba: snapBuf,
          nonZero: snapNZ,
          progMs,
          stateMs,
          drawMs,
          copyMs,
          readPixelsMs,
          scanMs,
          totalMs: progMs + stateMs + drawMs + copyMs + readPixelsMs + scanMs
        });
        this.bindFBO(savedFb);
        if (savedScissor) {
          gl2.enable(gl2.SCISSOR_TEST);
          gl2.scissor(savedBox[0], savedBox[1], savedBox[2], savedBox[3]);
        }
        this.backdropBlurCache.set(cacheKey, {
          fb: cacheFbo.fb,
          tex: cacheFbo.tex,
          w: blurW,
          h: blurH,
          blurType: (_n = (_m = this.lastBlurStats) == null ? void 0 : _m.type) != null ? _n : "gauss"
        });
        this.evictBackdropBlurCacheIfNeeded();
        blurred = cacheFbo.tex;
      }
      if (this.showBlurDebug) {
        const s = this.lastBlurStats;
        this.debugBlurRegions.push({
          x: sx,
          y: sy,
          w: sw,
          h: sh,
          radius: blurRadiusPx,
          ds: this.effectiveBlurDownsample,
          blurW: this.dsBlurFboW,
          blurH: this.dsBlurFboH,
          blurType: (_o = s == null ? void 0 : s.type) != null ? _o : "gauss",
          passes: (_p = s == null ? void 0 : s.passes) != null ? _p : 0,
          taps: (_q = s == null ? void 0 : s.taps) != null ? _q : 0,
          maxSample: (_r = s == null ? void 0 : s.maxSample) != null ? _r : 0,
          cached: cacheHit
        });
      }
      this.perfMonitor.incBlurPass();
      this.perfMonitor.incDrawCall(3);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      this.bindFBO(outFbo);
      gl.viewport(0, 0, this.fboW, this.fboH);
      const passState = { ...state, independent: false };
      return { backdropTex: blurred, passState, didBlur: true };
    }
    if (independent) {
      return { backdropTex: curTex, didBlur: false };
    }
    if (shouldUseSeparableBlur(el, state) && this.quickToggles.backdropBlur) {
      const blurRadiusPx = el.blurRadius * layerScale * this.dpr;
      let backdropSrc;
      if (el.backdropFbo && this.dialogBackdropTex) {
        backdropSrc = this.dialogBackdropTex;
      } else if (this.quickToggles.isolateBackdrop && this.bgOnlyTex) {
        backdropSrc = this.bgOnlyTex;
      } else {
        backdropSrc = curTex;
      }
      const canCacheSceneBlur = this.useBlurCache && backdropSrc === curTex && !el.backdropFbo;
      const isScrolling = this.scrollY !== this._lastBlurCacheScrollY;
      this._lastBlurCacheScrollY = this.scrollY;
      const cssRadius = el.blurRadius * layerScale;
      const qRadius = Math.round(cssRadius * 10) / 10;
      const sceneCacheKey = canCacheSceneBlur && !isScrolling ? `scene_${el.id}_${qRadius}_${this.useKawaseBlur ? "k" : "g"}` : null;
      let blurred;
      let cacheHit = false;
      if (sceneCacheKey) {
        const entry = this.backdropBlurCache.get(sceneCacheKey);
        if (entry) {
          blurred = entry.tex;
          cacheHit = true;
          this.lastBlurStats = { type: entry.blurType, passes: 0, taps: 0, maxSample: 0, w: entry.w, h: entry.h, progMs: 0, stateMs: 0, drawMs: 0 };
        } else {
          if (this._blurCacheMissesThisFrame >= this.blurCacheMissesPerFrame) {
            return { backdropTex: backdropSrc, didBlur: false };
          }
          this._blurCacheMissesThisFrame++;
          const sT0 = performance.now();
          blurred = this.blurTexture(backdropSrc, blurRadiusPx);
          const sT1 = performance.now();
          const sProgMs = (_t = (_s = this.lastBlurStats) == null ? void 0 : _s.progMs) != null ? _t : 0;
          const sStateMs = (_v = (_u = this.lastBlurStats) == null ? void 0 : _u.stateMs) != null ? _v : 0;
          const sDrawMs = (_x = (_w = this.lastBlurStats) == null ? void 0 : _w.drawMs) != null ? _x : sT1 - sT0;
          const blurW = (_A = (_z = (_y = this.lastBlurStats) == null ? void 0 : _y.w) != null ? _z : this.dsBlurFboW) != null ? _A : this.fboW;
          const blurH = (_D = (_C = (_B = this.lastBlurStats) == null ? void 0 : _B.h) != null ? _C : this.dsBlurFboH) != null ? _D : this.fboH;
          const cacheFbo = this.acquireCacheFBO(blurW, blurH);
          const gl2 = this.gl;
          const savedFb = gl2.getParameter(gl2.FRAMEBUFFER_BINDING);
          const savedSc = gl2.isEnabled(gl2.SCISSOR_TEST);
          const savedBox = gl2.getParameter(gl2.SCISSOR_BOX);
          gl2.disable(gl2.SCISSOR_TEST);
          if (!this.cacheCopyReadFbo) this.cacheCopyReadFbo = gl2.createFramebuffer();
          gl2.bindFramebuffer(gl2.FRAMEBUFFER, this.cacheCopyReadFbo);
          gl2.framebufferTexture2D(gl2.FRAMEBUFFER, gl2.COLOR_ATTACHMENT0, gl2.TEXTURE_2D, blurred, 0);
          gl2.activeTexture(gl2.TEXTURE0);
          gl2.bindTexture(gl2.TEXTURE_2D, null);
          gl2.bindTexture(gl2.TEXTURE_2D, cacheFbo.tex);
          gl2.copyTexImage2D(gl2.TEXTURE_2D, 0, gl2.RGBA, 0, 0, blurW, blurH, 0);
          if (this.showBlurCacheCheckerboard) {
            gl2.bindFramebuffer(gl2.FRAMEBUFFER, cacheFbo.fb);
            gl2.viewport(0, 0, blurW, blurH);
            const cellSize = Math.max(8, Math.floor(blurW / 20));
            gl2.enable(gl2.SCISSOR_TEST);
            gl2.clearColor(0, 0, 0, 0);
            for (let cy = 0; cy < blurH; cy += cellSize) {
              for (let cx = 0; cx < blurW; cx += cellSize) {
                if ((Math.floor(cx / cellSize) + Math.floor(cy / cellSize)) % 2 !== 0) {
                  gl2.scissor(cx, cy, Math.min(cellSize, blurW - cx), Math.min(cellSize, blurH - cy));
                  gl2.clear(gl2.COLOR_BUFFER_BIT);
                }
              }
            }
            gl2.disable(gl2.SCISSOR_TEST);
          }
          const sT2 = performance.now();
          const sCopyMs = sT2 - sT1;
          let sReadPixelsMs = 0;
          let sScanMs = 0;
          let sSnapW = 0, sSnapH = 0;
          let sBuf = new Uint8Array(0);
          let sNZ = 0;
          let sMinX = 0, sMinY = 0, sMaxX = 0, sMaxY = 0;
          if (this.showBlurCachePreview) {
            sSnapW = blurW;
            sSnapH = blurH;
            const sTa = performance.now();
            sBuf = new Uint8Array(sSnapW * sSnapH * 4);
            const sTr0 = performance.now();
            gl2.bindFramebuffer(gl2.FRAMEBUFFER, cacheFbo.fb);
            gl2.readPixels(0, 0, sSnapW, sSnapH, gl2.RGBA, gl2.UNSIGNED_BYTE, sBuf);
            const sTr1 = performance.now();
            for (let y = 0; y < sSnapH; y++) {
              for (let x = 0; x < sSnapW; x++) {
                const i = (y * sSnapW + x) * 4;
                if (sBuf[i] + sBuf[i + 1] + sBuf[i + 2] + sBuf[i + 3] > 0) {
                  sNZ++;
                  if (x < sMinX || sNZ === 1) sMinX = x;
                  if (x > sMaxX) sMaxX = x;
                  if (y < sMinY || sNZ === 1) sMinY = y;
                  if (y > sMaxY) sMaxY = y;
                }
              }
            }
            const sTs = performance.now();
            sReadPixelsMs = sTr1 - sTr0;
            sScanMs = sTs - sTr1 + (sTr0 - sTa);
          }
          this.backdropBlurCacheSnapshots.push({
            key: sSnapW > 0 ? `${sceneCacheKey} [${sMinX},${sMinY}-${sMaxX},${sMaxY}]` : sceneCacheKey,
            w: sSnapW,
            h: sSnapH,
            rgba: sBuf,
            nonZero: sNZ,
            progMs: sProgMs,
            stateMs: sStateMs,
            drawMs: sDrawMs,
            copyMs: sCopyMs,
            readPixelsMs: sReadPixelsMs,
            scanMs: sScanMs,
            totalMs: sProgMs + sStateMs + sDrawMs + sCopyMs + sReadPixelsMs + sScanMs
          });
          gl2.bindFramebuffer(gl2.FRAMEBUFFER, savedFb);
          if (savedSc) {
            gl2.enable(gl2.SCISSOR_TEST);
            gl2.scissor(savedBox[0], savedBox[1], savedBox[2], savedBox[3]);
          }
          this.backdropBlurCache.set(sceneCacheKey, {
            fb: cacheFbo.fb,
            tex: cacheFbo.tex,
            w: blurW,
            h: blurH,
            blurType: (_F = (_E = this.lastBlurStats) == null ? void 0 : _E.type) != null ? _F : "gauss"
          });
          this.evictBackdropBlurCacheIfNeeded();
          blurred = cacheFbo.tex;
        }
      } else {
        if (this.useBlurCache && this._blurCacheMissesThisFrame >= this.blurCacheMissesPerFrame) {
          return { backdropTex: backdropSrc, didBlur: false };
        }
        if (this.useBlurCache) this._blurCacheMissesThisFrame++;
        blurred = this.blurTexture(backdropSrc, blurRadiusPx);
      }
      if (this.showBlurDebug) {
        const s = this.lastBlurStats;
        this.debugBlurRegions.push({
          x: sx,
          y: sy,
          w: sw,
          h: sh,
          radius: blurRadiusPx,
          ds: this.effectiveBlurDownsample,
          blurW: this.dsBlurFboW,
          blurH: this.dsBlurFboH,
          blurType: (_G = s == null ? void 0 : s.type) != null ? _G : "gauss",
          passes: (_H = s == null ? void 0 : s.passes) != null ? _H : 0,
          taps: (_I = s == null ? void 0 : s.taps) != null ? _I : 0,
          maxSample: (_J = s == null ? void 0 : s.maxSample) != null ? _J : 0,
          cached: cacheHit
        });
      }
      this.perfMonitor.incBlurPass();
      this.perfMonitor.incDrawCall(2);
      const gl = this.gl;
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      this.bindFBO(outFbo);
      gl.viewport(0, 0, this.fboW, this.fboH);
      const passState = el.backdropFbo ? { ...state, el: { ...el, backdropFbo: false } } : state;
      return { backdropTex: blurred, passState, didBlur: true };
    }
    if (this.quickToggles.isolateBackdrop && this.bgOnlyTex && !el.backdropFbo) {
      return { backdropTex: this.bgOnlyTex, didBlur: false };
    }
    return { backdropTex: curTex, didBlur: false };
  }

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-render-glass-pingpong.ts
  function renderGlassElement(el, st, curFbo, curTex, otherFbo, otherTex, r) {
    var _a;
    const gl = this.gl;
    const t = computeElementTransform.call(this, el, st, r);
    const { sx, sy, sw, sh, scaleX, scaleY, togglePressProgress } = t;
    if (this.quickToggles.perElementFbo) {
      this.perfMonitor.incGlassElement();
      this.perfMonitor.incPerElementFbo();
      const elDirty = this.allDirty || this.dirtyElementIds.has(el.id);
      return this.renderGlassElementPerFbo(el, st, curFbo, curTex, otherFbo, otherTex, {
        sx,
        sy,
        sw,
        sh,
        radii: t.radii,
        scaleX,
        scaleY,
        isButton: t.isButton,
        p: t.p,
        togglePressProgress,
        independent: t.independent,
        translationX: t.translationX,
        translationY: t.translationY,
        elDirty
      });
    }
    this._dbgLastGlassCacheHit = false;
    if (this.showDirtyMarkers) {
      this.debugCacheMissLog.push({ id: el.id, reason: "ping_pong", x: sx, y: sy, w: sw, h: sh });
    }
    this.dirtyRectsThisFrame.push({
      ...inflatedOutputRect(el, sx, sy, sw, sh, togglePressProgress),
      source: `pingpong:${el.id}`
    });
    this.perfMonitor.incGlassElement();
    this.perfMonitor.incPingPong();
    this.bindFBO(otherFbo);
    this.drawCopy(curTex);
    this.perfMonitor.incDrawCall();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const MARGIN_CSS = computeScissorMarginCss(el, Math.min(scaleX, scaleY), this.quickToggles);
    const scissorX = Math.max(0, Math.round((sx - MARGIN_CSS) * this.dpr));
    const scissorY = Math.max(0, Math.round((this.cssHeight - (sy + sh + MARGIN_CSS)) * this.dpr));
    const scissorW = Math.min(this.fboW - scissorX, Math.round((sw + 2 * MARGIN_CSS) * this.dpr));
    const scissorH = Math.min(this.fboH - scissorY, Math.round((sh + 2 * MARGIN_CSS) * this.dpr));
    const clip = this.intersectClipScissor(el, scissorX, scissorY, scissorW, scissorH);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(clip.x, clip.y, clip.w, clip.h);
    if (this.showPefBbox) {
      const pxX = scissorX / this.dpr;
      const pxY = (this.fboH - scissorY - scissorH) / this.dpr;
      this.debugPefBboxes.push({
        x: pxX,
        y: pxY,
        w: scissorW / this.dpr,
        h: scissorH / this.dpr,
        fbo: false
      });
    }
    const state = buildGlassRenderState({
      el,
      st,
      transform: t,
      usePerElementFbo: false,
      sceneRectOffsetX: 0,
      sceneRectOffsetY: 0,
      elFboW: 0,
      elFboH: 0
    });
    this.renderGlassShadowPass(state);
    const backdrop = resolveBackdropTex.call(this, state, curTex, otherFbo);
    this.renderGlassElementPass((_a = backdrop.passState) != null ? _a : state, backdrop.backdropTex, backdrop.backdropBbox);
    this.renderGlassPostPasses(state);
    gl.disable(gl.SCISSOR_TEST);
    return {
      curFbo: otherFbo,
      curTex: otherTex,
      otherFbo: curFbo,
      otherTex: curTex
    };
  }

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-render-glass-pef-geometry.ts
  function computeElFboGeometry(el, sx, sy, sw, sh, layerScale) {
    const scissorMarginCss = computeScissorMarginCss(el, layerScale, this.quickToggles);
    const ELFBO_PAD_DEVICE = 2;
    const elFboMarginCss = (ELFBO_PAD_DEVICE + 1) / this.dpr;
    const rawBx0 = Math.round((sx - scissorMarginCss) * this.dpr);
    const rawBy0Top = Math.round((sy - scissorMarginCss) * this.dpr);
    const bx0 = Math.max(0, Math.min(this.fboW, rawBx0));
    const by0Top = Math.max(0, Math.min(this.fboH, rawBy0Top));
    const bboxW = Math.max(
      0,
      Math.min(this.fboW - bx0, Math.round((sw + 2 * scissorMarginCss) * this.dpr))
    );
    const bboxH = Math.max(
      0,
      Math.min(this.fboH - by0Top, Math.round((sh + 2 * scissorMarginCss) * this.dpr))
    );
    const bboxScissorY = Math.max(0, this.fboH - by0Top - bboxH);
    const elFboRectW = Math.max(1, Math.round((el.rect.w + 2 * elFboMarginCss) * this.dpr));
    const elFboRectH = Math.max(1, Math.round((el.rect.h + 2 * elFboMarginCss) * this.dpr));
    const rawEx0 = Math.round((sx - elFboMarginCss) * this.dpr);
    const rawEy0Top = Math.round((sy - elFboMarginCss) * this.dpr);
    const ex0 = rawEx0;
    const ey0Top = rawEy0Top;
    const scissorX = Math.max(0, Math.min(this.fboW, rawEx0));
    const scissorYTop = Math.max(0, Math.min(this.fboH, rawEy0Top));
    const scissorW = Math.max(0, Math.min(this.fboW - scissorX, elFboRectW));
    const scissorH = Math.max(0, Math.min(this.fboH - scissorYTop, elFboRectH));
    const elFboScissorY = Math.max(0, this.fboH - scissorYTop - scissorH);
    const sceneOffsetX = rawEx0;
    const sceneOffsetY = rawEy0Top;
    return {
      bx0,
      by0Top,
      bboxW,
      bboxH,
      bboxScissorY,
      elFboRectW,
      elFboRectH,
      ex0,
      ey0Top,
      scissorX,
      scissorYTop,
      scissorW,
      scissorH,
      elFboScissorY,
      sceneOffsetX,
      sceneOffsetY,
      scissorMarginCss
    };
  }

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-render-glass-pef-cache-flags.ts
  function computeCacheFlags(el) {
    var _a;
    const cacheable = !!(this.wallpaperTexture && !el.backdropFbo);
    const positionInvariant = !!(((_a = el.isToggleKnob) == null ? void 0 : _a.solidBackdropColor) && !el.backdropFbo);
    const scrollInvariant = !!(el.isToggleKnob && !el.isToggleKnob.solidBackdropColor && !el.isToggleKnob.trackColorOff && // slider knob (not toggle knob)
    this.backgroundColor && // solid-bg page (no wallpaper)
    !el.backdropFbo);
    return { cacheable, positionInvariant, scrollInvariant };
  }

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-render-glass-pef-cache-resolve.ts
  function resolveElFboCache(el, state, geom, flags) {
    const { sx, sy, sw, sh, togglePressProgress, independent } = state;
    const { elFboRectW, elFboRectH, sceneOffsetX, sceneOffsetY } = geom;
    const { cacheable, positionInvariant, scrollInvariant } = flags;
    const gl = this.gl;
    if (!cacheable) {
      if (this.showDirtyMarkers) {
        const ncReason = !this.wallpaperTexture ? "non_cacheable:no_wp" : el.backdropFbo ? "non_cacheable:backdropFbo" : "non_cacheable:unknown";
        this.debugCacheMissLog.push({ id: el.id, reason: ncReason, x: sx, y: sy, w: sw, h: sh });
      }
      const ensured = this.ensureElementFBO(elFboRectW, elFboRectH);
      return {
        cacheHit: false,
        cacheWrite: false,
        renderFbo: this.elFbo,
        renderTex: this.elFboTex,
        elFboW: ensured.w,
        elFboH: ensured.h
      };
    }
    const entry = this.elFboCache.get(el.id);
    let missReason = null;
    const skipPosition = positionInvariant || scrollInvariant;
    if (!entry) {
      missReason = "no_entry";
    } else if (entry.w !== elFboRectW || entry.h !== elFboRectH) {
      missReason = "size_mismatch";
    } else if (!skipPosition && (entry.ex0 !== sceneOffsetX || entry.ey0Top !== sceneOffsetY)) {
      missReason = "position_mismatch";
    } else if (!entry.valid) {
      missReason = "invalidated";
    } else if (entry.wallpaperVersion !== this.wallpaperVersion) {
      missReason = "wallpaper_version";
    } else if (entry.dpr !== this.dpr) {
      missReason = "dpr";
    } else if (!positionInvariant && !independent) {
      const myRect = inflatedOutputRect(el, sx, sy, sw, sh, togglePressProgress);
      const overlap = this.dirtyRectsThisFrame.find(
        (r) => rectsOverlap(r, myRect) && !(scrollInvariant && r.source === "scroll")
      );
      if (overlap) {
        missReason = `backdrop_overlap:${overlap.source}`;
      }
    }
    if (missReason && this.showDirtyMarkers) {
      this.debugCacheMissLog.push({ id: el.id, reason: missReason, x: sx, y: sy, w: sw, h: sh });
    }
    if (entry && missReason === null) {
      if (positionInvariant || scrollInvariant) {
        entry.ex0 = sceneOffsetX;
        entry.ey0Top = sceneOffsetY;
      }
      this.perfMonitor.incCachedElement();
      return {
        cacheHit: true,
        cacheWrite: false,
        renderFbo: entry.fb,
        renderTex: entry.tex,
        elFboW: entry.w,
        elFboH: entry.h
      };
    }
    if (!entry) {
      const created = this.createFBO(elFboRectW, elFboRectH);
      this.elFboCache.set(el.id, {
        fb: created.fb,
        tex: created.tex,
        w: elFboRectW,
        h: elFboRectH,
        ex0: sceneOffsetX,
        ey0Top: sceneOffsetY,
        valid: false,
        wallpaperVersion: this.wallpaperVersion,
        dpr: this.dpr
      });
    } else if (entry.w !== elFboRectW || entry.h !== elFboRectH) {
      gl.deleteFramebuffer(entry.fb);
      gl.deleteTexture(entry.tex);
      const created = this.createFBO(elFboRectW, elFboRectH);
      entry.fb = created.fb;
      entry.tex = created.tex;
      entry.w = elFboRectW;
      entry.h = elFboRectH;
    }
    const e = this.elFboCache.get(el.id);
    e.ex0 = sceneOffsetX;
    e.ey0Top = sceneOffsetY;
    e.valid = false;
    e.wallpaperVersion = this.wallpaperVersion;
    e.dpr = this.dpr;
    return {
      cacheHit: false,
      cacheWrite: true,
      renderFbo: e.fb,
      renderTex: e.tex,
      elFboW: e.w,
      elFboH: e.h
    };
  }

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-render-glass-pef.ts
  function renderGlassElementPerFbo(el, st, curFbo, curTex, otherFbo, otherTex, computed) {
    var _a, _b;
    const gl = this.gl;
    const layerScale = Math.min(computed.scaleX, computed.scaleY);
    const geom = computeElFboGeometry.call(this, el, computed.sx, computed.sy, computed.sw, computed.sh, layerScale);
    const rot = (_a = el.elementRotation) != null ? _a : 0;
    const rotCosAbs = Math.abs(Math.cos(rot));
    const rotSinAbs = Math.abs(Math.sin(rot));
    const m = geom.scissorMarginCss;
    const fullW = computed.sw + 2 * m;
    const fullH = computed.sh + 2 * m;
    const rotBboxW = fullW * rotCosAbs + fullH * rotSinAbs;
    const rotBboxH = fullW * rotSinAbs + fullH * rotCosAbs;
    const bboxCx = computed.sx + computed.sw / 2;
    const bboxCy = computed.sy + computed.sh / 2;
    const rotScX = Math.max(0, Math.min(this.fboW, Math.round((bboxCx - rotBboxW / 2) * this.dpr)));
    const rotScY = Math.max(0, Math.min(this.fboH, Math.round((this.cssHeight - (bboxCy + rotBboxH / 2)) * this.dpr)));
    const rotScW = Math.max(0, Math.min(this.fboW - rotScX, Math.round(rotBboxW * this.dpr)));
    const rotScH = Math.max(0, Math.min(this.fboH - rotScY, Math.round(rotBboxH * this.dpr)));
    if (this.showPefBbox) {
      this.debugPefBboxes.push({
        x: geom.ex0 / this.dpr,
        y: geom.ey0Top / this.dpr,
        w: geom.elFboRectW / this.dpr,
        h: geom.elFboRectH / this.dpr,
        fbo: true
      });
    }
    const flags = computeCacheFlags.call(this, el);
    let state = buildGlassRenderState({
      el,
      st,
      transform: computed,
      usePerElementFbo: true,
      sceneRectOffsetX: geom.sceneOffsetX,
      sceneRectOffsetY: geom.sceneOffsetY,
      elFboW: 0,
      // overwritten after cache resolution
      elFboH: 0
    });
    const cache = resolveElFboCache.call(this, el, state, geom, flags);
    state = { ...state, elFboW: cache.elFboW, elFboH: cache.elFboH };
    const shadowClip = this.intersectClipScissor(el, rotScX, rotScY, rotScW, rotScH);
    this.bindFBO(curFbo);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(shadowClip.x, shadowClip.y, shadowClip.w, shadowClip.h);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.renderGlassShadowPass(state);
    if (!cache.cacheHit) {
      this.dirtyRectsThisFrame.push({
        ...inflatedOutputRect(el, computed.sx, computed.sy, computed.sw, computed.sh, computed.togglePressProgress),
        source: `glass:${el.id}`
      });
      const backdrop = resolveBackdropTex.call(this, state, curTex, cache.renderFbo);
      gl.bindFramebuffer(gl.FRAMEBUFFER, cache.renderFbo);
      gl.viewport(0, 0, cache.elFboW, cache.elFboH);
      gl.disable(gl.SCISSOR_TEST);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.disable(gl.BLEND);
      this.renderGlassElementPass((_b = backdrop.passState) != null ? _b : state, backdrop.backdropTex, backdrop.backdropBbox);
      if (cache.cacheWrite) {
        const e = this.elFboCache.get(el.id);
        if (e) e.valid = true;
      }
    }
    const elemCx = bboxCx;
    const elemCy = bboxCy;
    const compAabbW = computed.sw * rotCosAbs + computed.sh * rotSinAbs;
    const compAabbH = computed.sw * rotSinAbs + computed.sh * rotCosAbs;
    const compScX = Math.max(0, Math.min(this.fboW, Math.round((elemCx - compAabbW / 2) * this.dpr)));
    const compScY = Math.max(0, Math.min(this.fboH, Math.round((this.cssHeight - (elemCy + compAabbH / 2)) * this.dpr)));
    const compScW = Math.max(0, Math.min(this.fboW - compScX, Math.round(compAabbW * this.dpr)));
    const compScH = Math.max(0, Math.min(this.fboH - compScY, Math.round(compAabbH * this.dpr)));
    const compClip = this.intersectClipScissor(el, compScX, compScY, compScW, compScH);
    this.bindFBO(curFbo);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(compClip.x, compClip.y, compClip.w, compClip.h);
    this.drawElFboComposite(
      cache.renderTex,
      cache.elFboW,
      cache.elFboH,
      elemCx * this.dpr,
      elemCy * this.dpr,
      // element center (device px, top-left origin)
      computed.sw * this.dpr,
      computed.sh * this.dpr,
      // SCALED element size (device px)
      rot
    );
    const postClip = this.intersectClipScissor(el, rotScX, rotScY, rotScW, rotScH);
    gl.scissor(postClip.x, postClip.y, postClip.w, postClip.h);
    this.renderGlassPostPasses(state);
    gl.disable(gl.SCISSOR_TEST);
    this._dbgLastGlassCacheHit = cache.cacheHit;
    if (this.showPefPassDebug) {
      const cssEx0 = geom.ex0 / this.dpr;
      const cssEy0 = geom.ey0Top / this.dpr;
      const cssEw = geom.elFboRectW / this.dpr;
      const cssEh = geom.elFboRectH / this.dpr;
      const cssBx0 = geom.bx0 / this.dpr;
      const cssBy0 = geom.by0Top / this.dpr;
      const cssBw = geom.bboxW / this.dpr;
      const cssBh = geom.bboxH / this.dpr;
      this.debugPefPasses.push({
        id: el.id,
        cacheHit: cache.cacheHit,
        missReason: cache.cacheHit ? null : "MISS",
        composite: { x: cssEx0, y: cssEy0, w: cssEw, h: cssEh },
        postPass: { x: cssBx0, y: cssBy0, w: cssBw, h: cssBh },
        isBottomTabIndicator: !!el.isBottomTabIndicator,
        togglePressProgress: state.togglePressProgress,
        elHighlightAlpha: state.elHighlightAlpha
      });
    }
    return { curFbo, curTex, otherFbo, otherTex };
  }

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-render-glass-shadow.ts
  function renderGlassShadowPass(state) {
    const gl = this.gl;
    const { el, sx, sy, sw, sh, radii } = state;
    if (!el.outerShadow || el.outerShadow.radius <= 0.5) return;
    if (!this.quickToggles.outerShadow) return;
    let shadowAlpha = el.outerShadow.alpha;
    if (el.isBottomTabIndicator) {
      shadowAlpha *= state.togglePressProgress;
    }
    if (this.showShadowBbox) {
      const bbox = shadowBboxCss(el, sx, sy, sw, sh, state.layerScaleX, state.layerScaleY, this.quickToggles);
      if (bbox) {
        this.debugShadowBboxes.push({
          ...bbox,
          alpha: shadowAlpha,
          skipped: shadowAlpha <= 1e-3,
          r: el.outerShadow.radius,
          ox: el.outerShadow.offsetX,
          oy: el.outerShadow.offsetY
        });
      }
    }
    if (shadowAlpha <= 1e-3) return;
    gl.useProgram(this.shadowProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(this.aPosLocSh);
    gl.vertexAttribPointer(this.aPosLocSh, 2, gl.FLOAT, false, 0, 0);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform2f(this.uSh["uCanvasSize"], this.canvas.width, this.canvas.height);
    gl.uniform2f(this.uSh["uElementOffset"], sx * this.dpr, sy * this.dpr);
    gl.uniform2f(this.uSh["uElementSize"], sw * this.dpr, sh * this.dpr);
    gl.uniform4f(
      this.uSh["uCornerRadii"],
      radii[0] * this.dpr,
      radii[1] * this.dpr,
      radii[2] * this.dpr,
      radii[3] * this.dpr
    );
    gl.uniform2f(this.uSh["uOriginalSize"], state.origW * this.dpr, state.origH * this.dpr);
    gl.uniform1f(this.uSh["uOriginalCornerRadius"], state.origCornerRadius * this.dpr);
    gl.uniform2f(this.uSh["uLayerScale"], state.layerScaleX, state.layerScaleY);
    gl.uniform1f(this.uSh["uElementRotation"], state.elementRotation);
    gl.uniform1f(this.uSh["uCornerStyle"], this.cornerStyle);
    gl.uniform1f(this.uSh["uShadowRadius"], el.outerShadow.radius * this.dpr);
    gl.uniform2f(
      this.uSh["uShadowOffset"],
      el.outerShadow.offsetX * this.dpr,
      el.outerShadow.offsetY * this.dpr
    );
    gl.uniform4f(
      this.uSh["uShadowColor"],
      el.outerShadow.color[0],
      el.outerShadow.color[1],
      el.outerShadow.color[2],
      shadowAlpha
    );
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-render-glass.ts
  var glassRenderMethods = {
    renderGlassElement,
    renderGlassElementPerFbo,
    renderGlassShadowPass
  };

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-render.ts
  var renderMethods = {
    render() {
      if (!this.needsRedraw) return;
      this.needsRedraw = false;
      this.dirtyRectsThisFrame.length = 0;
      this.debugCacheMissLog.length = 0;
      this.debugDirtySourceLog.length = 0;
      this._blurCacheMissesThisFrame = 0;
      if (this.allDirty || this.scrollY !== this.lastRenderedScrollY) {
        this.dirtyRectsThisFrame.push({
          x: 0,
          y: 0,
          w: this.cssWidth,
          h: this.cssHeight,
          source: this.allDirty ? "all_dirty" : "scroll"
        });
      }
      this.lastRenderedScrollY = this.scrollY;
      this.perfMonitor.canvasCssW = this.cssWidth;
      this.perfMonitor.canvasCssH = this.cssHeight;
      this.perfMonitor.canvasDevW = this.canvas.width;
      this.perfMonitor.canvasDevH = this.canvas.height;
      this.perfMonitor.dpr = this.dpr;
      this.perfMonitor.deviceDpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
      this.perfMonitor.frameStart();
      this.debugPefBboxes.length = 0;
      this.debugBlurRegions.length = 0;
      this.debugShadowBboxes.length = 0;
      this.debugDirtyMarkers.length = 0;
      this.debugCullRects.length = 0;
      this.debugPefPasses.length = 0;
      this.debugPlainRects.length = 0;
      if (!this.wallpaperReady && !this.backgroundColor) {
        this.perfMonitor.frameEnd();
        return;
      }
      const gl = this.gl;
      this.resizeFBOs(this.canvas.width, this.canvas.height);
      for (const cfg of this.buttonConfigs) {
        if (this.fgDirtyIds.has(cfg.id)) {
          this.rasterizeForeground(cfg);
        }
      }
      this.renderBackground();
      this.perfMonitor.incDrawCall();
      if (this.buttonConfigs.length === 0) {
        this.bindFBO(null);
        this.drawCopy(this.fboATex);
        this.perfMonitor.incDrawCall();
        this.perfMonitor.frameEnd();
        return;
      }
      const sceneBlurEl = this.buttonConfigs.find((e) => {
        var _a;
        return ((_a = e.sceneBlurRadius) != null ? _a : 0) >= 0.5;
      });
      if (sceneBlurEl) {
        const r = sceneBlurEl.sceneBlurRadius * this.dpr;
        const blurred = this.blurTexture(this.fboATex, r);
        this.bindFBO(this.fboA);
        this.drawCopy(blurred);
        this.perfMonitor.incBlurPass();
        this.perfMonitor.incDrawCall(2);
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      const isolate = this.quickToggles.isolateBackdrop;
      if (isolate && this.bgOnlyFbo && this.bgOnlyTex) {
        this.bindFBO(this.bgOnlyFbo);
        this.gl.viewport(0, 0, this.fboW, this.fboH);
        this.drawCopy(this.fboATex);
        this.gl.enable(this.gl.BLEND);
        this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);
      }
      const scrollY = this.scrollY;
      const CULL_MARGIN = 120;
      const cullMarginFor = (el) => Math.max(CULL_MARGIN, el.rect.h);
      const effRect = (el) => {
        const y = el.scroll ? el.rect.y - scrollY : el.rect.y;
        return { x: el.rect.x, y, w: el.rect.w, h: el.rect.h };
      };
      let curFbo = this.fboA;
      let curTex = this.fboATex;
      let otherFbo = this.fboB;
      let otherTex = this.fboBTex;
      for (const el of this.buttonConfigs) {
        if (el.renderOnTop) continue;
        const y = el.scroll ? el.rect.y - scrollY : el.rect.y;
        const margin = cullMarginFor(el);
        const culled = y + el.rect.h < -margin || y > this.cssHeight + margin;
        if (this.showCullDebug) {
          this.debugCullRects.push({
            id: el.id,
            x: el.rect.x,
            y,
            w: el.rect.w,
            h: el.rect.h,
            margin,
            culled,
            scroll: !!el.scroll,
            viewportH: this.cssHeight,
            pass: "main"
          });
        }
        if (culled) continue;
        const r = effRect(el);
        const st = this.buttonStates.get(el.id);
        const dirty = this.allDirty || this.dirtyElementIds.has(el.id);
        this.perfMonitor.incTotal();
        if (dirty) this.perfMonitor.incDirty();
        if (this.renderNonGlassElement(el, r, st, curFbo)) {
          if (this.showDirtyMarkers) {
            this.debugDirtyMarkers.push({ x: r.x, y: r.y, w: r.w, h: r.h, dirty });
          }
          if (dirty) this.dirtyRectsThisFrame.push({
            ...inflatedOutputRect(el, r.x, r.y, r.w, r.h),
            source: `nonglass:${el.id}`
          });
          if (isolate && this.bgOnlyFbo) {
            this.renderNonGlassElement(el, r, st, this.bgOnlyFbo);
          }
          continue;
        }
        if (el.backdropFbo && el.scrimColor) {
          this.renderDialogBackdrop(el.scrimColor, el.brightness, el.contrast, el.saturation);
        }
        if (el.useContinuousSdf) {
          this.loadContinuousSdf(el.rect.w, el.rect.h, el.cornerRadius);
        }
        const result = this.renderGlassElement(el, st, curFbo, curTex, otherFbo, otherTex, r);
        curFbo = result.curFbo;
        curTex = result.curTex;
        otherFbo = result.otherFbo;
        otherTex = result.otherTex;
        if (this.showDirtyMarkers) {
          this.debugDirtyMarkers.push({ x: r.x, y: r.y, w: r.w, h: r.h, dirty: !this._dbgLastGlassCacheHit });
        }
        if (el.isBottomTabContainer && this.tabsBackdropFbo && this.tabsBackdropTex) {
          this.bindFBO(this.tabsBackdropFbo);
          this.gl.clearColor(0, 0, 0, 0);
          this.gl.clear(this.gl.COLOR_BUFFER_BIT);
          this.drawCopy(curTex);
          this.bindFBO(curFbo);
          this.gl.enable(this.gl.BLEND);
          this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);
        }
      }
      for (const el of this.buttonConfigs) {
        if (!el.renderOnTop) continue;
        const y = el.scroll ? el.rect.y - scrollY : el.rect.y;
        const margin = cullMarginFor(el);
        const culled = y + el.rect.h < -margin || y > this.cssHeight + margin;
        if (this.showCullDebug) {
          this.debugCullRects.push({
            id: el.id,
            x: el.rect.x,
            y,
            w: el.rect.w,
            h: el.rect.h,
            margin,
            culled,
            scroll: !!el.scroll,
            viewportH: this.cssHeight,
            pass: "onTop"
          });
        }
        if (culled) continue;
        const r = effRect(el);
        const st = this.buttonStates.get(el.id);
        const dirty = this.allDirty || this.dirtyElementIds.has(el.id);
        this.perfMonitor.incTotal();
        if (dirty) this.perfMonitor.incDirty();
        if (this.renderNonGlassElement(el, r, st, curFbo)) {
          if (this.showDirtyMarkers) {
            this.debugDirtyMarkers.push({ x: r.x, y: r.y, w: r.w, h: r.h, dirty });
          }
          if (dirty) this.dirtyRectsThisFrame.push({
            ...inflatedOutputRect(el, r.x, r.y, r.w, r.h),
            source: `nonglass:${el.id}`
          });
          if (isolate && this.bgOnlyFbo) {
            this.renderNonGlassElement(el, r, st, this.bgOnlyFbo);
          }
          continue;
        }
        const result = this.renderGlassElement(el, st, curFbo, curTex, otherFbo, otherTex, r);
        curFbo = result.curFbo;
        curTex = result.curTex;
        otherFbo = result.otherFbo;
        otherTex = result.otherTex;
        if (this.showDirtyMarkers) {
          this.debugDirtyMarkers.push({ x: r.x, y: r.y, w: r.w, h: r.h, dirty: !this._dbgLastGlassCacheHit });
        }
      }
      this.bindFBO(null);
      this.drawCopy(curTex);
      this.perfMonitor.incDrawCall();
      if (this._pendingEdgeScan) {
        this._debugFlushPendingEdgeScan();
      }
      this.dirtyElementIds.clear();
      this.allDirty = false;
      if (this.pendingExtraRenders > 0) {
        this.pendingExtraRenders--;
        for (const el of this.buttonConfigs) {
          if (el.isBottomTabIndicator) {
            this.markGroupDirty(el.isBottomTabIndicator.groupId);
          }
        }
        this.requestRender();
      }
      this.perfMonitor.frameEnd();
    }
  };

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-render-background.ts
  var backgroundMethods = {
    /** Helper to set SDF uniforms (canvasSize + offset + size + cornerRadii)
     *  for any of the SDF-using programs. */
    setSdfUniforms(u, aPosLoc, r, cornerRadius) {
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
      gl.enableVertexAttribArray(aPosLoc);
      gl.vertexAttribPointer(aPosLoc, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(u["uCanvasSize"], this.canvas.width, this.canvas.height);
      gl.uniform2f(u["uOffset"], r.x * this.dpr, r.y * this.dpr);
      gl.uniform2f(u["uSize"], r.w * this.dpr, r.h * this.dpr);
      gl.uniform4f(
        u["uCornerRadii"],
        cornerRadius * this.dpr,
        cornerRadius * this.dpr,
        cornerRadius * this.dpr,
        cornerRadius * this.dpr
      );
    },
    /** Render wallpaper or solid background color into fboA.
     *  Also renders into wallpaperBlurFbo so it's always clean wallpaper
     *  (never composited with elements) — used by the blur cache. */
    renderBackground() {
      const gl = this.gl;
      this.bindFBO(this.fboA);
      gl.disable(gl.BLEND);
      gl.disable(gl.SCISSOR_TEST);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const clip = this.wallpaperClipCss;
      if (clip && clip.w > 0 && clip.h > 0) {
        const sx = Math.max(0, Math.round(clip.x * this.dpr));
        const sy = Math.max(0, Math.round((this.cssHeight - (clip.y + clip.h)) * this.dpr));
        const sw = Math.max(0, Math.round(clip.w * this.dpr));
        const sh = Math.max(0, Math.round(clip.h * this.dpr));
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(sx, sy, sw, sh);
      }
      if (this.backgroundColor) {
        const [r, g, b] = this.backgroundColor;
        this.drawSolidFill(r, g, b, 1);
      } else {
        gl.useProgram(this.wallpaperProgram);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
        gl.enableVertexAttribArray(this.aPosLocWp);
        gl.vertexAttribPointer(this.aPosLocWp, 2, gl.FLOAT, false, 0, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.wallpaperTexture);
        gl.uniform1i(this.uWp["uBackdrop"], 0);
        gl.uniform2f(this.uWp["uCanvasSize"], this.canvas.width, this.canvas.height);
        gl.uniform2f(this.uWp["uWallpaperSize"], this.wallpaperSize[0], this.wallpaperSize[1]);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        if (this.wallpaperBlurFbo) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.wallpaperBlurFbo);
          gl.viewport(0, 0, this.fboW, this.fboH);
          gl.disable(gl.SCISSOR_TEST);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
      }
      gl.disable(gl.SCISSOR_TEST);
    },
    /** Render wallpaper+scrim+colorControls into dialogBackdropFbo as ONE OPAQUE
     *  layer (alpha=1), replicating the original's LayerBackdrop (wallpaper+scrim)
     *  with colorControls applied — matching the original's colorControls→blur→lens
     *  effects order. The dialog card (backdropFbo + useSeparableBlur) 2-pass blurs
     *  this FBO then does lens refraction.
     *
     *  Order: wallpaper (opaque) → scrim (glBlendFuncSeparate, correct alpha) →
     *  colorControls (fullscreen pass). Cached by scrim+cc params. */
    renderDialogBackdrop(scrim, brightness, contrast, saturation) {
      const key = `${scrim.join(",")}|${brightness},${contrast},${saturation}`;
      if (this.dialogBackdropKey === key) return;
      this.dialogBackdropKey = key;
      const gl = this.gl;
      this.bindFBO(this.dialogBackdropFbo);
      gl.disable(gl.BLEND);
      if (this.backgroundColor) {
        const [r, g, b] = this.backgroundColor;
        this.drawSolidFill(r, g, b, 1);
      } else {
        gl.useProgram(this.wallpaperProgram);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
        gl.enableVertexAttribArray(this.aPosLocWp);
        gl.vertexAttribPointer(this.aPosLocWp, 2, gl.FLOAT, false, 0, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.wallpaperTexture);
        gl.uniform1i(this.uWp["uBackdrop"], 0);
        gl.uniform2f(this.uWp["uCanvasSize"], this.canvas.width, this.canvas.height);
        gl.uniform2f(this.uWp["uWallpaperSize"], this.wallpaperSize[0], this.wallpaperSize[1]);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
      if (scrim[3] > 1e-3) {
        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        this.drawSolidFill(scrim[0], scrim[1], scrim[2], scrim[3]);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      }
      this.bindFBO(this.blurFboA);
      this.drawColorControls(this.dialogBackdropTex, brightness, contrast, saturation);
      this.bindFBO(this.dialogBackdropFbo);
      this.drawCopy(this.blurFboATex);
    }
  };

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-render-nonglass.ts
  var nonGlassMethods = {
    /** Render a non-glass element (plain-rect / progressive-blur / text).
     *  Returns true if the element was handled (caller should `continue`).
     *  Returns false for glass elements (caller should run the ping-pong path).
     *
     *  Extracted verbatim from methods-render.ts — only the dispatcher /
     *  branch-routing glue lives here; each branch's body was moved to its
     *  own methods-render-nonglass-*.ts module. */
    renderNonGlassElement(el, r, st, curFbo) {
      let r2 = r;
      if (el.enterProgress != null) {
        const raw = el.enterProgress;
        const derived = raw < 0 ? (1 - Math.exp(-Math.abs(raw))) * -1 : raw <= 1 ? raw : 1 + (1 - Math.exp(-(raw - 1)));
        const ty = -48 * DP * (1 - derived);
        const stretch = el.enterStretchFactor != null && derived > 1 ? el.enterStretchFactor * (derived - 1) * 32 * DP : 0;
        r2 = { x: r.x, y: r.y + ty + stretch, w: r.w, h: r.h };
      }
      if (el.kind === "plain-rect" && el.plainRect) {
        return this.renderPlainRectElement(el, r, r2, curFbo);
      }
      if (el.kind === "progressive-blur" && el.progressiveBlur) {
        return this.renderProgressiveBlurElement(el, r2, curFbo);
      }
      if (el.kind === "text") {
        return this.renderTextElement(el, r2, st, curFbo);
      }
      return false;
    }
  };

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-render-diagnose.ts
  function diagnosePlainRect(skipped, skipReason, finalAlpha, w, h, blendEnabled) {
    if (skipped) return { verdict: "SKIPPED", detail: skipReason != null ? skipReason : "unknown" };
    if (!isFinite(finalAlpha) || finalAlpha <= 0) {
      return { verdict: "INVISIBLE", detail: `finalAlpha=${finalAlpha} (colorA*enterA)` };
    }
    if (w <= 0 || h <= 0) {
      return { verdict: "DEGENERATE", detail: `rect ${w.toFixed(1)}x${h.toFixed(1)} \u2264 0` };
    }
    if (!blendEnabled) {
      return { verdict: "NO_OP", detail: "BLEND disabled by prior element" };
    }
    return { verdict: "OK", detail: `finalAlpha=${finalAlpha.toFixed(3)}` };
  }

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-render-nonglass-plain-rect.ts
  var nonGlassPlainRectMethods = {
    /** plain-rect branch of renderNonGlassElement — see interface doc above.
     *  Extracted verbatim from methods-render.ts. */
    renderPlainRectElement(el, r, r2, curFbo) {
      var _a, _b, _c, _d;
      const gl = this.gl;
      const baseC = el.isToggleTrack ? null : el.plainRect.color;
      if (baseC && baseC[3] <= 0) {
        if (this.showPlainRectDebug && curFbo !== this.bgOnlyFbo) {
          const col = el.plainRect.color;
          const sp0 = el.enterSafeProgress != null ? Math.max(0, Math.min(1, el.enterSafeProgress)) : el.enterProgress != null ? Math.max(0, Math.min(1, el.enterProgress)) : 1;
          const ea = el.enterProgress != null ? easeIn(sp0) : 1;
          const fa = col[3] * ea;
          const blendOn = this.gl.isEnabled(this.gl.BLEND);
          const reason = `color alpha=${col[3]} \u2264 0`;
          const dg = diagnosePlainRect(true, reason, fa, r2.w, r2.h, blendOn);
          this.debugPlainRects.push({
            id: el.id,
            x: r2.x,
            y: r2.y,
            w: r2.w,
            h: r2.h,
            origH: el.rect.h,
            colorR: col[0],
            colorG: col[1],
            colorB: col[2],
            colorA: col[3],
            enterProgress: (_a = el.enterProgress) != null ? _a : null,
            enterSafeProgress: (_b = el.enterSafeProgress) != null ? _b : null,
            enterA: ea,
            finalAlpha: fa,
            skipped: true,
            skipReason: reason,
            drawn: false,
            blendEnabled: blendOn,
            curFboIsA: curFbo === this.fboA,
            diagnosis: dg.verdict,
            diagnosisDetail: dg.detail
          });
        }
        return true;
      }
      this.bindFBO(curFbo);
      let clipEnabled = false;
      if (el.clipRect) {
        const cx0 = Math.max(0, Math.round(r2.x * this.dpr));
        const cy0 = Math.max(0, Math.round((this.cssHeight - (r2.y + r2.h)) * this.dpr));
        const cw = Math.min(this.fboW - cx0, Math.round(r2.w * this.dpr));
        const ch = Math.min(this.fboH - cy0, Math.round(r2.h * this.dpr));
        const clip = this.intersectClipScissor(el, cx0, cy0, cw, ch);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(clip.x, clip.y, clip.w, clip.h);
        clipEnabled = true;
      }
      let c;
      if (el.isToggleTrack) {
        const tg = this.toggleStates.get(el.isToggleTrack.groupId);
        const f = tg ? tg.fraction : 0;
        const off = el.isToggleTrack.offColor;
        const on = el.isToggleTrack.onColor;
        c = [
          off[0] + (on[0] - off[0]) * f,
          off[1] + (on[1] - off[1]) * f,
          off[2] + (on[2] - off[2]) * f,
          off[3] + (on[3] - off[3]) * f
        ];
      } else {
        c = el.plainRect.color;
      }
      let fillRect = r2;
      if (el.isSliderFill) {
        const sf = this.toggleStates.get(el.isSliderFill.groupId);
        const fraction = sf ? sf.fraction : 0;
        const fillW = Math.max(el.isSliderFill.minW, el.isSliderFill.trackW * fraction);
        fillRect = { x: r.x, y: r.y, w: fillW, h: r.h };
      }
      gl.useProgram(this.plainRectProgram);
      this.setSdfUniforms(this.uPr, this.aPosLocPr, fillRect, el.cornerRadius);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      const enterA = el.enterProgress != null ? (() => {
        const sp = el.enterSafeProgress != null ? Math.max(0, Math.min(1, el.enterSafeProgress)) : Math.max(0, Math.min(1, el.enterProgress));
        return easeIn(sp);
      })() : 1;
      gl.uniform4f(this.uPr["uColor"], c[0], c[1], c[2], c[3] * enterA);
      gl.uniform1f(this.uPr["uCornerStyle"], this.cornerStyle);
      if (el.useContinuousSdf) {
        this.loadContinuousSdf(r2.w, r2.h, el.cornerRadius);
      }
      if (el.useContinuousSdf && this.continuousSdfTexture) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.continuousSdfTexture);
        gl.uniform1i(this.uPr["uContinuousSdf"], 2);
        gl.uniform1f(this.uPr["uUseContinuousSdf"], 1);
        gl.uniform2f(this.uPr["uContinuousSdfTexSize"], this.continuousSdfTexSize[0], this.continuousSdfTexSize[1]);
        gl.uniform2f(this.uPr["uContinuousSdfElementSize"], r2.w * this.dpr, r2.h * this.dpr);
      } else {
        gl.uniform1f(this.uPr["uUseContinuousSdf"], 0);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      if (clipEnabled) gl.disable(gl.SCISSOR_TEST);
      this.perfMonitor.incNonGlass();
      this.perfMonitor.incDrawCall();
      if (this.showPlainRectDebug && curFbo !== this.bgOnlyFbo) {
        const fa = c[3] * enterA;
        const blendOn = this.gl.isEnabled(this.gl.BLEND);
        const dg = diagnosePlainRect(false, null, fa, fillRect.w, fillRect.h, blendOn);
        this.debugPlainRects.push({
          id: el.id,
          x: fillRect.x,
          y: fillRect.y,
          w: fillRect.w,
          h: fillRect.h,
          origH: el.rect.h,
          colorR: c[0],
          colorG: c[1],
          colorB: c[2],
          colorA: c[3],
          enterProgress: (_c = el.enterProgress) != null ? _c : null,
          enterSafeProgress: (_d = el.enterSafeProgress) != null ? _d : null,
          enterA,
          finalAlpha: fa,
          skipped: false,
          skipReason: null,
          drawn: true,
          blendEnabled: blendOn,
          curFboIsA: curFbo === this.fboA,
          diagnosis: dg.verdict,
          diagnosisDetail: dg.detail
        });
      }
      return true;
    }
  };

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-render-nonglass-text.ts
  var nonGlassTextMethods = {
    /** text branch of renderNonGlassElement — see interface doc above.
     *  Extracted verbatim from methods-render.ts. */
    renderTextElement(el, r2, st, curFbo) {
      var _a, _b, _c, _d;
      const gl = this.gl;
      this.bindFBO(curFbo);
      let drawRect = r2;
      let fgScaleX = 1;
      let fgScaleY = 1;
      if (el.isBottomTabContent) {
        const tg = this.toggleStates.get(el.isBottomTabContent.groupId);
        if (tg) {
          const containerW = (_a = el.isBottomTabContent.containerWidth) != null ? _a : el.rect.w * 4;
          const containerScale = 1 + 16 * DP / containerW * tg.pressProgress;
          fgScaleX = containerScale;
          fgScaleY = containerScale;
          const pivotX = (_b = el.isBottomTabContent.containerCenterX) != null ? _b : el.rect.x + el.rect.w / 2;
          const pivotY = (_c = el.isBottomTabContent.containerCenterY) != null ? _c : el.rect.y + el.rect.h / 2;
          const tabCenterX = el.rect.x + el.rect.w / 2;
          const tabCenterY = el.rect.y + el.rect.h / 2;
          const cx = pivotX + (tabCenterX - pivotX) * containerScale + tg.panelOffset;
          const cy = pivotY + (tabCenterY - pivotY) * containerScale;
          const sw = el.rect.w * fgScaleX;
          const sh = el.rect.h * fgScaleY;
          drawRect = { x: cx - sw / 2, y: cy - sh / 2, w: sw, h: sh };
        }
      }
      const pText = (_d = st == null ? void 0 : st.pressProgress) != null ? _d : 0;
      let clipEnabled = false;
      if (el.clipRect) {
        const cx0 = Math.max(0, Math.round(drawRect.x * this.dpr));
        const cy0 = Math.max(0, Math.round((this.cssHeight - (drawRect.y + drawRect.h)) * this.dpr));
        const cw = Math.min(this.fboW - cx0, Math.round(drawRect.w * this.dpr));
        const ch = Math.min(this.fboH - cy0, Math.round(drawRect.h * this.dpr));
        const clip = this.intersectClipScissor(el, cx0, cy0, cw, ch);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(clip.x, clip.y, clip.w, clip.h);
        clipEnabled = true;
      }
      if (el.isInteractive && pText > 1e-3) {
        const pressTint = el.pressTintColor;
        gl.useProgram(this.tintProgram);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
        gl.enableVertexAttribArray(this.aPosLocTn);
        gl.vertexAttribPointer(this.aPosLocTn, 2, gl.FLOAT, false, 0, 0);
        if (pressTint) {
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        } else {
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        }
        gl.uniform2f(this.uTn["uCanvasSize"], this.canvas.width, this.canvas.height);
        gl.uniform2f(this.uTn["uOffset"], drawRect.x * this.dpr, drawRect.y * this.dpr);
        gl.uniform2f(this.uTn["uSize"], drawRect.w * this.dpr, drawRect.h * this.dpr);
        gl.uniform4f(this.uTn["uCornerRadii"], 0, 0, 0, 0);
        gl.uniform2f(this.uTn["uOriginalSize"], drawRect.w * this.dpr, drawRect.h * this.dpr);
        gl.uniform1f(this.uTn["uOriginalCornerRadius"], 0);
        gl.uniform2f(this.uTn["uLayerScale"], 1, 1);
        if (pressTint) {
          gl.uniform4f(this.uTn["uColor"], pressTint[0], pressTint[1], pressTint[2], 0.1 * pText);
        } else {
          gl.uniform4f(this.uTn["uColor"], 1, 1, 1, 0.1 * pText);
        }
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      }
      const fgTex = this.fgTextures.get(el.id);
      if (fgTex) {
        gl.useProgram(this.foregroundProgram);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
        gl.enableVertexAttribArray(this.aPosLocFg);
        gl.vertexAttribPointer(this.aPosLocFg, 2, gl.FLOAT, false, 0, 0);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, fgTex);
        gl.uniform1i(this.uFg["uTexture"], 0);
        gl.uniform2f(this.uFg["uCanvasSize"], this.canvas.width, this.canvas.height);
        gl.uniform2f(this.uFg["uOffset"], drawRect.x * this.dpr, drawRect.y * this.dpr);
        gl.uniform2f(this.uFg["uSize"], drawRect.w * this.dpr, drawRect.h * this.dpr);
        gl.uniform4f(
          this.uFg["uCornerRadii"],
          el.cornerRadius * this.dpr,
          el.cornerRadius * this.dpr,
          el.cornerRadius * this.dpr,
          el.cornerRadius * this.dpr
        );
        gl.uniform2f(this.uFg["uOriginalSize"], el.rect.w * this.dpr, el.rect.h * this.dpr);
        gl.uniform1f(this.uFg["uOriginalCornerRadius"], el.cornerRadius * this.dpr);
        gl.uniform2f(this.uFg["uLayerScale"], fgScaleX, fgScaleY);
        gl.uniform1f(this.uFg["uCornerStyle"], this.cornerStyle);
        gl.uniform1f(this.uFg["uUseContinuousSdf"], 0);
        gl.uniform1f(this.uFg["uAlpha"], el.enterProgress != null ? (() => {
          const sp = el.enterSafeProgress != null ? Math.max(0, Math.min(1, el.enterSafeProgress)) : Math.max(0, Math.min(1, el.enterProgress));
          return easeIn(sp);
        })() : 1);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      }
      this.perfMonitor.incNonGlass();
      this.perfMonitor.incDrawCall();
      if (clipEnabled) gl.disable(gl.SCISSOR_TEST);
      return true;
    }
  };

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-render-nonglass-progressive-blur.ts
  var nonGlassProgressiveBlurMethods = {
    /** progressive-blur branch of renderNonGlassElement — see interface doc above.
     *  Extracted verbatim from methods-render.ts. */
    renderProgressiveBlurElement(el, r2, curFbo) {
      const gl = this.gl;
      this.bindFBO(curFbo);
      gl.useProgram(this.progressiveBlurProgram);
      this.setSdfUniforms(this.uPb, this.aPosLocPb, r2, el.cornerRadius);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.wallpaperTexture);
      gl.uniform1i(this.uPb["uBackdrop"], 0);
      gl.uniform2f(this.uPb["uWallpaperSize"], this.wallpaperSize[0], this.wallpaperSize[1]);
      gl.uniform1f(this.uPb["uBlurRadius"], el.progressiveBlur.blurRadius * this.dpr);
      const tc = el.progressiveBlur.tintColor;
      gl.uniform4f(this.uPb["uTintColor"], tc[0], tc[1], tc[2], tc[3]);
      gl.uniform1f(this.uPb["uTintIntensity"], el.progressiveBlur.tintIntensity);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      this.perfMonitor.incNonGlass();
      this.perfMonitor.incDrawCall();
      return true;
    }
  };

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-render-glass-element-pass-context.ts
  function createElementPassContext(el) {
    return {
      elRefractionHeight: el.refractionHeight,
      elRefractionAmount: el.refractionAmount,
      elBlurRadius: el.blurRadius,
      elHighlightAlpha: el.highlight ? el.highlight.alpha : 0,
      elSurfaceAlpha: el.surfaceColor[3],
      elContentScaleX: 1,
      elContentScaleY: 1,
      useToggleBackdrop: 0,
      useSolidBackdrop: 0,
      solidR: 1,
      solidG: 1,
      solidB: 1,
      solidA: 1,
      trackColorR: 0,
      trackColorG: 0,
      trackColorB: 0,
      trackColorA: 0,
      trackCenterX: 0,
      trackCenterY: 0,
      trackHalfW: 0,
      trackHalfH: 0,
      trackCornerRadius: 0,
      useIndicatorBackdrop: 0,
      containerRectX: 0,
      containerRectY: 0,
      containerHalfW: 0,
      containerHalfH: 0,
      containerCornerRadius: 0,
      indicatorAccentR: 0,
      indicatorAccentG: 0,
      indicatorAccentB: 0,
      indicatorAccentA: 0
    };
  }

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-render-glass-element-pass-toggle.ts
  function applyToggleKnobBackdrop(renderer, state, ctx) {
    var _a, _b, _c, _d;
    const { el, sx, sy, sw, sh, togglePressProgress } = state;
    if (!el.isToggleKnob) return;
    const progress = togglePressProgress;
    ctx.elRefractionHeight = el.refractionHeight * progress;
    ctx.elRefractionAmount = el.refractionAmount * progress;
    ctx.elBlurRadius = 8 * (1 - progress);
    ctx.elHighlightAlpha = ((_b = (_a = el.highlight) == null ? void 0 : _a.alpha) != null ? _b : 0) * progress;
    ctx.elSurfaceAlpha = 0;
    const isSlider = el.isToggleKnob.velocityDivisor === 10;
    const xEnd = isSlider ? 1 : 0.75;
    const yEnd = isSlider ? 1 : 0.75;
    ctx.elContentScaleX = 2 / 3 + (xEnd - 2 / 3) * progress;
    ctx.elContentScaleY = 0 + (yEnd - 0) * progress;
    if (el.isToggleKnob.trackColorOff && el.isToggleKnob.trackColorOn && el.isToggleKnob.trackW && el.isToggleKnob.trackH) {
      const tg = renderer.toggleStates.get(el.isToggleKnob.groupId);
      const fraction = tg ? tg.fraction : 0;
      const off = el.isToggleKnob.trackColorOff;
      const on = el.isToggleKnob.trackColorOn;
      ctx.trackColorR = off[0] + (on[0] - off[0]) * fraction;
      ctx.trackColorG = off[1] + (on[1] - off[1]) * fraction;
      ctx.trackColorB = off[2] + (on[2] - off[2]) * fraction;
      ctx.trackColorA = off[3] + (on[3] - off[3]) * fraction;
      const knobCenterX = (sx + sw / 2) * renderer.dpr;
      const knobCenterY = (sy + sh / 2) * renderer.dpr;
      const trackOrigX = (_c = el.isToggleKnob.trackOriginalX) != null ? _c : el.rect.x;
      const trackOrigY_raw = (_d = el.isToggleKnob.trackOriginalY) != null ? _d : el.rect.y;
      const trackOrigY = el.scroll ? trackOrigY_raw - renderer.scrollY : trackOrigY_raw;
      const trackOrigCenterX = (trackOrigX + el.isToggleKnob.trackW / 2) * renderer.dpr;
      const trackOrigCenterY = (trackOrigY + el.isToggleKnob.trackH / 2) * renderer.dpr;
      const trackScaleX = 2 / 3 + (xEnd - 2 / 3) * progress;
      const trackScaleY = 0 + (yEnd - 0) * progress;
      ctx.trackCenterX = knobCenterX + (trackOrigCenterX - knobCenterX) * trackScaleX;
      ctx.trackCenterY = knobCenterY + (trackOrigCenterY - knobCenterY) * trackScaleY;
      const trackW = el.isToggleKnob.trackW * renderer.dpr;
      const trackH = el.isToggleKnob.trackH * renderer.dpr;
      ctx.trackHalfW = trackW * trackScaleX * 0.5;
      ctx.trackHalfH = trackH * trackScaleY * 0.5;
      ctx.trackCornerRadius = trackH * 0.5 * Math.min(trackScaleX, trackScaleY);
      ctx.useToggleBackdrop = 1;
      if (el.isToggleKnob.solidBackdropColor) {
        const sd = el.isToggleKnob.solidBackdropColor;
        ctx.solidR = sd[0];
        ctx.solidG = sd[1];
        ctx.solidB = sd[2];
        ctx.solidA = sd[3];
        ctx.useSolidBackdrop = 1;
      }
      ctx.elContentScaleX = 1;
      ctx.elContentScaleY = 1;
    }
  }

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-render-glass-element-pass-indicator.ts
  function applyIndicatorBackdrop(renderer, state, ctx) {
    var _a, _b, _c, _d, _e, _f, _g;
    const gl = renderer.gl;
    const { el, sx, sy, sw, sh, togglePressProgress } = state;
    if (!el.isBottomTabIndicator) {
      gl.uniform1f(renderer.uEl["uIndicatorPressProgress"], 0);
      gl.uniform1f(renderer.uEl["uIndicatorPanelOffset"], 0);
      gl.uniform1f(renderer.uEl["uDpr"], renderer.dpr);
      gl.uniform2f(renderer.uEl["uContainerCenter"], 0, 0);
      gl.uniform1f(renderer.uEl["uContainerScale"], 1);
      gl.uniform1f(renderer.uEl["uTabContentCount"], 0);
      gl.uniform2f(renderer.uEl["uInnerStrokeMaskOffset"], 1, 1);
      gl.uniform2f(renderer.uEl["uInnerStrokeMaskSize"], 1, 1);
      return;
    }
    const progress = togglePressProgress;
    ctx.elRefractionHeight = el.refractionHeight * progress;
    ctx.elRefractionAmount = el.refractionAmount * progress;
    ctx.elBlurRadius = 0;
    ctx.elHighlightAlpha = ((_b = (_a = el.highlight) == null ? void 0 : _a.alpha) != null ? _b : 0) * progress;
    if (el.isBottomTabIndicator.accentColor && el.isBottomTabIndicator.containerRect) {
      const ac = el.isBottomTabIndicator.accentColor;
      const cr = el.isBottomTabIndicator.containerRect;
      ctx.indicatorAccentR = ac[0];
      ctx.indicatorAccentG = ac[1];
      ctx.indicatorAccentB = ac[2];
      ctx.indicatorAccentA = 1;
      ctx.containerRectX = (cr.x + cr.w / 2) * renderer.dpr;
      ctx.containerRectY = (cr.y + cr.h / 2) * renderer.dpr;
      ctx.containerHalfW = cr.w / 2 * renderer.dpr;
      ctx.containerHalfH = cr.h / 2 * renderer.dpr;
      ctx.containerCornerRadius = cr.h / 2 * renderer.dpr;
      ctx.useIndicatorBackdrop = 1;
    }
    const tg = renderer.toggleStates.get(el.isBottomTabIndicator.groupId);
    gl.uniform1f(renderer.uEl["uIndicatorPressProgress"], tg ? tg.pressProgress : 0);
    gl.uniform1f(renderer.uEl["uIndicatorPanelOffset"], tg ? tg.panelOffset * renderer.dpr : 0);
    gl.uniform1f(renderer.uEl["uDpr"], renderer.dpr);
    const ccx = (_c = el.isBottomTabIndicator.containerCenterX) != null ? _c : 0;
    const ccy = (_d = el.isBottomTabIndicator.containerCenterY) != null ? _d : 0;
    const cw = (_e = el.isBottomTabIndicator.containerWidth) != null ? _e : el.rect.w;
    const cScale = tg ? 1 + 16 * DP / cw * tg.pressProgress : 1;
    gl.uniform2f(renderer.uEl["uContainerCenter"], ccx * renderer.dpr, ccy * renderer.dpr);
    gl.uniform1f(renderer.uEl["uContainerScale"], cScale);
    const ids = (_f = el.isBottomTabIndicator.tabContentIds) != null ? _f : [];
    const rects = (_g = el.isBottomTabIndicator.tabContentRects) != null ? _g : [];
    const n = Math.min(ids.length, rects.length, 8);
    let boundCount = 0;
    for (let i = 0; i < 8; i++) {
      if (i < n) {
        const tex = renderer.fgTextures.get(ids[i]);
        if (tex) {
          gl.activeTexture(gl.TEXTURE3 + boundCount);
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.uniform1i(renderer.uEl[`uTabContentTex${boundCount}`], 3 + boundCount);
          const r = rects[i];
          gl.uniform4f(
            renderer.uEl[`uTabContentRects[${boundCount}]`],
            (r.x + r.w / 2) * renderer.dpr,
            (r.y + r.h / 2) * renderer.dpr,
            r.w / 2 * renderer.dpr,
            r.h / 2 * renderer.dpr
          );
          boundCount++;
        }
      }
    }
    for (let i = boundCount; i < 8; i++) {
      gl.uniform4f(renderer.uEl[`uTabContentRects[${i}]`], 0, 0, 0, 0);
    }
    gl.uniform1f(renderer.uEl["uTabContentCount"], boundCount);
    if (renderer.tabsBackdropTex) {
      gl.activeTexture(gl.TEXTURE11);
      gl.bindTexture(gl.TEXTURE_2D, renderer.tabsBackdropTex);
      gl.uniform1i(renderer.uEl["uTabsGlassLayer"], 11);
    }
    generateInnerStrokeMask(renderer, ctx);
  }
  function generateInnerStrokeMask(renderer, ctx) {
    const gl = renderer.gl;
    const innerW = 2 * ctx.containerHalfW;
    const innerH = 2 * ctx.containerHalfH;
    const innerR = ctx.containerCornerRadius;
    const widthPx = Math.min(0.5 * renderer.dpr, Math.min(innerW, innerH) * 0.5);
    const strokeWidthDevice = Math.max(1, Math.ceil(widthPx) * 2);
    const blurPx = Math.max(0, 0.25 * renderer.dpr);
    const strokeMargin = Math.ceil(strokeWidthDevice) + 4;
    const maskW = Math.max(1, Math.ceil(innerW + 2 * strokeMargin));
    const maskH = Math.max(1, Math.ceil(innerH + 2 * strokeMargin));
    const deviceDpr = window.devicePixelRatio || 1;
    const SS = Math.min(2, Math.max(1, Math.floor(deviceDpr / renderer.dpr)));
    const canvasW = maskW * SS;
    const canvasH = maskH * SS;
    const maskKey = [
      "inner-rr",
      innerW.toFixed(3),
      innerH.toFixed(3),
      innerR.toFixed(3),
      strokeWidthDevice,
      blurPx.toFixed(3),
      strokeMargin,
      maskW,
      maskH,
      `ss${SS}`
      // cache key includes supersample factor
    ].join(":");
    let mask = renderer.strokeMaskCache.get(maskKey);
    if (!mask) {
      const canvas = document.createElement("canvas");
      canvas.width = canvasW;
      canvas.height = canvasH;
      const ctx2d = canvas.getContext("2d", { alpha: true });
      if (!ctx2d) throw new Error("2D canvas not supported");
      const tex = gl.createTexture();
      if (!tex) throw new Error("WebGL texture allocation failed");
      mask = { tex, canvas, ctx: ctx2d, w: maskW, h: maskH, ready: false };
      renderer.strokeMaskCache.set(maskKey, mask);
      if (renderer.strokeMaskCache.size > 32) {
        const oldestKey = renderer.strokeMaskCache.keys().next().value;
        if (oldestKey && oldestKey !== maskKey) {
          const oldest = renderer.strokeMaskCache.get(oldestKey);
          if (oldest) gl.deleteTexture(oldest.tex);
          renderer.strokeMaskCache.delete(oldestKey);
        }
      }
    }
    if (!mask.ready) {
      const smCtx = mask.ctx;
      smCtx.clearRect(0, 0, canvasW, canvasH);
      smCtx.save();
      smCtx.scale(SS, SS);
      smCtx.translate(strokeMargin, strokeMargin);
      const r = Math.min(innerR, innerW / 2, innerH / 2);
      const path = new Path2D();
      path.moveTo(r, 0);
      path.lineTo(innerW - r, 0);
      path.arcTo(innerW, 0, innerW, r, r);
      path.lineTo(innerW, innerH - r);
      path.arcTo(innerW, innerH, innerW - r, innerH, r);
      path.lineTo(r, innerH);
      path.arcTo(0, innerH, 0, innerH - r, r);
      path.lineTo(0, r);
      path.arcTo(0, 0, r, 0, r);
      path.closePath();
      smCtx.clip(path);
      smCtx.lineWidth = strokeWidthDevice;
      smCtx.strokeStyle = "rgba(255,255,255,1)";
      smCtx.lineJoin = "round";
      smCtx.lineCap = "round";
      smCtx.filter = blurPx > 0.01 ? `blur(${blurPx}px)` : "none";
      smCtx.stroke(path);
      smCtx.filter = "none";
      smCtx.restore();
      gl.bindTexture(gl.TEXTURE_2D, mask.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mask.canvas);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      mask.ready = true;
    }
    gl.activeTexture(gl.TEXTURE12);
    gl.bindTexture(gl.TEXTURE_2D, mask.tex);
    gl.uniform1i(renderer.uEl["uInnerStrokeMask"], 12);
    gl.uniform2f(renderer.uEl["uInnerStrokeMaskOffset"], strokeMargin, strokeMargin);
    gl.uniform2f(renderer.uEl["uInnerStrokeMaskSize"], mask.w, mask.h);
  }

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-render-glass-element-pass.ts
  var glassElementPassMethods = {
    /** Step 2b: Element pass — refraction + vibrancy + tint + highlight.
     *  Samples `curTex` (the scene built up so far) to compute refraction
     *  of the actual colors behind the glass (track color, card background,
     *  other glass elements), not just the wallpaper.
     *
     *  Orchestration only — the toggle-knob CombinedBackdrop and the
     *  bottom-tab-indicator CombinedBackdrop (+ tab content textures +
     *  inner stroke mask) live in their own files. The shading uniforms
     *  (refraction / blur / tint / highlight / SDF / magnifier) are set
     *  here from the `ElementPassContext` the helpers populated. */
    renderGlassElementPass(state, curTex, backdropBbox) {
      var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p, _q, _r, _s, _t, _u, _v, _w;
      const gl = this.gl;
      const { el, sx, sy, sw, sh, radii, togglePressProgress, layerScale } = state;
      gl.useProgram(this.elementProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
      gl.enableVertexAttribArray(this.aPosLocEl);
      gl.vertexAttribPointer(this.aPosLocEl, 2, gl.FLOAT, false, 0, 0);
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, curTex);
      gl.uniform1i(this.uEl["uBackdrop"], 0);
      if (this.wallpaperTexture) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.wallpaperTexture);
        gl.uniform1i(this.uEl["uWallpaperSampler"], 1);
      }
      gl.uniform2f(this.uEl["uCanvasSize"], this.canvas.width, this.canvas.height);
      gl.uniform2f(this.uEl["uWallpaperSize"], this.wallpaperSize[0], this.wallpaperSize[1]);
      gl.uniform2f(this.uEl["uElementOffset"], sx * this.dpr, sy * this.dpr);
      gl.uniform2f(this.uEl["uElementSize"], sw * this.dpr, sh * this.dpr);
      if (backdropBbox) {
        const cw = this.canvas.width;
        const ch = this.canvas.height;
        const u0 = backdropBbox.x / cw;
        const u1 = (backdropBbox.x + backdropBbox.w) / cw;
        const v1 = 1 - backdropBbox.y / ch;
        const v0 = 1 - (backdropBbox.y + backdropBbox.h) / ch;
        gl.uniform4f(this.uEl["uBackdropBbox"], u0, v0, u1 - u0, v1 - v0);
      } else {
        gl.uniform4f(this.uEl["uBackdropBbox"], 0, 0, 1, 1);
      }
      gl.uniform4f(
        this.uEl["uCornerRadii"],
        radii[0] * this.dpr,
        radii[1] * this.dpr,
        radii[2] * this.dpr,
        radii[3] * this.dpr
      );
      gl.uniform2f(this.uEl["uOriginalSize"], state.origW * this.dpr, state.origH * this.dpr);
      gl.uniform1f(this.uEl["uOriginalCornerRadius"], state.origCornerRadius * this.dpr);
      gl.uniform2f(this.uEl["uLayerScale"], state.layerScaleX, state.layerScaleY);
      gl.uniform1f(this.uEl["uElementRotation"], (_a = el.elementRotation) != null ? _a : 0);
      gl.uniform1f(this.uEl["uUsePerElementFbo"], state.usePerElementFbo ? 1 : 0);
      if (state.usePerElementFbo) {
        gl.uniform2f(this.uEl["uSceneRectOffset"], state.sceneRectOffsetX, state.sceneRectOffsetY);
        gl.uniform2f(this.uEl["uElFboSize"], state.elFboW, state.elFboH);
      }
      const ctx = createElementPassContext(el);
      applyToggleKnobBackdrop(this, state, ctx);
      applyIndicatorBackdrop(this, state, ctx);
      gl.uniform1f(this.uEl["uUseToggleBackdrop"], ctx.useToggleBackdrop);
      gl.uniform1f(this.uEl["uUseSolidBackdrop"], ctx.useSolidBackdrop);
      gl.uniform4f(this.uEl["uSolidBackdropColor"], ctx.solidR, ctx.solidG, ctx.solidB, ctx.solidA);
      gl.uniform4f(
        this.uEl["uTrackColor"],
        ctx.trackColorR,
        ctx.trackColorG,
        ctx.trackColorB,
        ctx.trackColorA
      );
      gl.uniform4f(
        this.uEl["uTrackRect"],
        ctx.trackCenterX,
        ctx.trackCenterY,
        ctx.trackHalfW,
        ctx.trackHalfH
      );
      gl.uniform1f(this.uEl["uTrackCornerRadius"], ctx.trackCornerRadius);
      gl.uniform1f(this.uEl["uIndicatorBackdrop"], ctx.useIndicatorBackdrop);
      gl.uniform4f(
        this.uEl["uContainerRect"],
        ctx.containerRectX,
        ctx.containerRectY,
        ctx.containerHalfW,
        ctx.containerHalfH
      );
      gl.uniform1f(this.uEl["uContainerCornerRadius"], ctx.containerCornerRadius);
      gl.uniform4f(
        this.uEl["uIndicatorAccent"],
        ctx.indicatorAccentR,
        ctx.indicatorAccentG,
        ctx.indicatorAccentB,
        ctx.indicatorAccentA
      );
      gl.uniform1f(this.uEl["uInsetPx"], 4 * this.dpr);
      const qsRefractionH = this.quickToggles.refraction ? ctx.elRefractionHeight : 0;
      const qsRefractionA = this.quickToggles.refraction ? ctx.elRefractionAmount : 0;
      gl.uniform1f(this.uEl["uRefractionHeight"], qsRefractionH * this.dpr);
      gl.uniform1f(this.uEl["uRefractionAmount"], qsRefractionA * this.dpr);
      gl.uniform1f(this.uEl["uDepthEffect"], el.depthEffect ? 1 : 0);
      gl.uniform1f(
        this.uEl["uChromaticAberration"],
        el.chromaticAberration && this.quickToggles.chromatic ? 1 : 0
      );
      const useSampleWallpaper = el.sampleWallpaper || state.independent;
      const inlineBlurRadius = shouldUseSeparableBlur(el, state) ? 0 : ctx.elBlurRadius;
      gl.uniform1f(this.uEl["uBlurRadius"], inlineBlurRadius * layerScale * this.dpr);
      gl.uniform1f(this.uEl["uSaturation"], el.saturation);
      gl.uniform1f(this.uEl["uBrightness"], el.brightness);
      gl.uniform1f(this.uEl["uContrast"], el.contrast);
      gl.uniform1f(this.uEl["uContentScaleX"], ctx.elContentScaleX);
      gl.uniform1f(this.uEl["uContentScaleY"], ctx.elContentScaleY);
      gl.uniform4f(
        this.uEl["uTintColor"],
        el.tintColor[0],
        el.tintColor[1],
        el.tintColor[2],
        el.tintColor[3]
      );
      gl.uniform4f(
        this.uEl["uSurfaceColor"],
        el.surfaceColor[0],
        el.surfaceColor[1],
        el.surfaceColor[2],
        ctx.elSurfaceAlpha
      );
      if (el.highlight) {
        gl.uniform3f(
          this.uEl["uHighlightColor"],
          el.highlight.color[0],
          el.highlight.color[1],
          el.highlight.color[2]
        );
        gl.uniform1f(this.uEl["uHighlightAngle"], el.highlight.angle);
        gl.uniform1f(this.uEl["uHighlightFalloff"], el.highlight.falloff);
        gl.uniform1f(this.uEl["uHighlightAlpha"], ctx.elHighlightAlpha);
        gl.uniform1f(this.uEl["uHighlightMode"], el.highlight.mode);
        const elMinDimPx = Math.min(state.origW, state.origH) * this.dpr;
        const elWidthPx = Math.min(el.highlight.widthDp * this.dpr, elMinDimPx * 0.5);
        const elBlurPx = ((_b = el.highlight.blurRadiusDp) != null ? _b : el.highlight.widthDp / 2) * this.dpr;
        const elStrokeWidth = el.highlight.aa !== false ? Math.ceil(elWidthPx) * 2 : Math.max(1, elWidthPx) * 2;
        gl.uniform1f(this.uEl["uHighlightStrokeWidth"], elStrokeWidth);
        gl.uniform1f(this.uEl["uHighlightBlur"], elBlurPx);
      } else {
        gl.uniform1f(this.uEl["uHighlightAlpha"], 0);
        gl.uniform1f(this.uEl["uHighlightMode"], 0);
        gl.uniform1f(this.uEl["uHighlightStrokeWidth"], 0);
        gl.uniform1f(this.uEl["uHighlightBlur"], 0);
      }
      const sdfSource = (_d = (_c = el.isSdfTexture) == null ? void 0 : _c.textureSource) != null ? _d : "clock";
      const sdfTex = sdfSource === "text" ? this.textSdfTexture : this.sdfTexture;
      const sdfTexSize = sdfSource === "text" ? this.textSdfTextureSize : this.sdfTextureSize;
      if (el.isSdfTexture && sdfTex) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, sdfTex);
        gl.uniform1i(this.uEl["uSdfTexSampler"], 2);
        gl.uniform1f(this.uEl["uUseSdfTexture"], 1);
        gl.uniform2f(this.uEl["uSdfTexSize"], sdfTexSize[0], sdfTexSize[1]);
        gl.uniform1f(
          this.uEl["uSdfLightAngle"],
          el.useGravityAngle ? this.gravityAngle * 180 / Math.PI : el.isSdfTexture.lightAngle
        );
        gl.uniform1f(
          this.uEl["uRefractionHeight"],
          (this.quickToggles.refraction ? el.isSdfTexture.refractionHeight : 0) * this.dpr
        );
        gl.uniform1f(
          this.uEl["uSdfHighlightScale"],
          (_e = el.isSdfTexture.highlightScale) != null ? _e : 1.5
        );
        gl.uniform1f(
          this.uEl["uSdfBevelEnabled"],
          ((_f = el.isSdfTexture.bevelEnabled) != null ? _f : true) ? 1 : 0
        );
        gl.uniform1f(
          this.uEl["uSdfGlassTintHue"],
          (_g = el.isSdfTexture.glassTintHue) != null ? _g : 0
        );
        gl.uniform1f(
          this.uEl["uSdfGlassTintEnabled"],
          ((_h = el.isSdfTexture.glassTintEnabled) != null ? _h : false) ? 1 : 0
        );
        gl.uniform1f(
          this.uEl["uSdfGlassTintMix"],
          (_i = el.isSdfTexture.glassTintMix) != null ? _i : 0
        );
        gl.uniform1f(
          this.uEl["uSdfGlassTintStrength"],
          (_j = el.isSdfTexture.glassTintStrength) != null ? _j : 0.85
        );
        gl.uniform1f(
          this.uEl["uSdfGlassTintSaturation"],
          (_k = el.isSdfTexture.glassTintSaturation) != null ? _k : 1
        );
        gl.uniform1f(
          this.uEl["uSdfGlassTintLightness"],
          (_l = el.isSdfTexture.glassTintLightness) != null ? _l : 1
        );
        gl.uniform1f(
          this.uEl["uSdfEdgeMatteEnabled"],
          ((_m = el.isSdfTexture.edgeMatteEnabled) != null ? _m : false) ? 1 : 0
        );
        gl.uniform1f(
          this.uEl["uSdfEdgeMatteTargets"],
          (_n = el.isSdfTexture.edgeMatteTargets) != null ? _n : 7
        );
        const bevelP = (_o = el.isSdfTexture.edgeMatteBevelParams) != null ? _o : [1, 0];
        gl.uniform2f(this.uEl["uSdfEdgeMatteBevelParams"], bevelP[0], bevelP[1]);
        const tintP = (_p = el.isSdfTexture.edgeMatteTintParams) != null ? _p : [1, 0];
        gl.uniform2f(this.uEl["uSdfEdgeMatteTintParams"], tintP[0], tintP[1]);
        const baseP = (_q = el.isSdfTexture.edgeMatteBaseParams) != null ? _q : [1, 0];
        gl.uniform2f(this.uEl["uSdfEdgeMatteBaseParams"], baseP[0], baseP[1]);
        const brightenP = (_r = el.isSdfTexture.edgeMatteBrightenParams) != null ? _r : [1, 0];
        gl.uniform2f(this.uEl["uSdfEdgeMatteBrightenParams"], brightenP[0], brightenP[1]);
        gl.uniform1f(this.uEl["uSdfEdgeMatteBevelStrength"], (_s = el.isSdfTexture.edgeMatteBevelStrength) != null ? _s : 1);
        gl.uniform1f(this.uEl["uSdfEdgeMatteTintStrength"], (_t = el.isSdfTexture.edgeMatteTintStrength) != null ? _t : 1);
        gl.uniform1f(this.uEl["uSdfEdgeMatteBaseStrength"], (_u = el.isSdfTexture.edgeMatteBaseStrength) != null ? _u : 1);
        gl.uniform1f(this.uEl["uSdfEdgeMatteBrightenStrength"], (_v = el.isSdfTexture.edgeMatteBrightenStrength) != null ? _v : 1);
        gl.uniform1f(
          this.uEl["uSdfDebugMode"],
          el.isSdfTexture.debugMode ? 1 : 0
        );
        gl.uniform1f(
          this.uEl["uSdfAaMin"],
          (_w = el.isSdfTexture.aaMin) != null ? _w : 0.5
        );
      } else {
        gl.uniform1f(this.uEl["uUseSdfTexture"], 0);
        gl.uniform1f(this.uEl["uSdfHighlightScale"], 1.5);
        gl.uniform1f(this.uEl["uSdfBevelEnabled"], 1);
        gl.uniform1f(this.uEl["uSdfGlassTintHue"], 0);
        gl.uniform1f(this.uEl["uSdfGlassTintEnabled"], 0);
        gl.uniform1f(this.uEl["uSdfGlassTintMix"], 0);
        gl.uniform1f(this.uEl["uSdfGlassTintStrength"], 0.85);
        gl.uniform1f(this.uEl["uSdfGlassTintSaturation"], 1);
        gl.uniform1f(this.uEl["uSdfGlassTintLightness"], 1);
        gl.uniform1f(this.uEl["uSdfEdgeMatteEnabled"], 0);
        gl.uniform1f(this.uEl["uSdfEdgeMatteTargets"], 7);
        gl.uniform2f(this.uEl["uSdfEdgeMatteBevelParams"], 1, 0);
        gl.uniform2f(this.uEl["uSdfEdgeMatteTintParams"], 1, 0);
        gl.uniform2f(this.uEl["uSdfEdgeMatteBaseParams"], 1, 0);
        gl.uniform2f(this.uEl["uSdfEdgeMatteBrightenParams"], 1, 0);
        gl.uniform1f(this.uEl["uSdfEdgeMatteBevelStrength"], 1);
        gl.uniform1f(this.uEl["uSdfEdgeMatteTintStrength"], 1);
        gl.uniform1f(this.uEl["uSdfEdgeMatteBaseStrength"], 1);
        gl.uniform1f(this.uEl["uSdfEdgeMatteBrightenStrength"], 1);
        gl.uniform1f(this.uEl["uSdfDebugMode"], 0);
        gl.uniform1f(this.uEl["uSdfAaMin"], 0.5);
        if (this.dummyTex) {
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, this.dummyTex);
        }
      }
      if (el.useContinuousSdf && this.continuousSdfTexture) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.continuousSdfTexture);
        gl.uniform1i(this.uEl["uContinuousSdf"], 2);
        gl.uniform1f(this.uEl["uUseContinuousSdf"], 1);
        gl.uniform2f(
          this.uEl["uContinuousSdfTexSize"],
          this.continuousSdfTexSize[0],
          this.continuousSdfTexSize[1]
        );
        gl.uniform2f(
          this.uEl["uContinuousSdfElementSize"],
          state.origW * this.dpr,
          state.origH * this.dpr
        );
      } else {
        gl.uniform1f(this.uEl["uUseContinuousSdf"], 0);
        if (this.dummyTex && !el.isSdfTexture) {
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, this.dummyTex);
        }
      }
      gl.uniform1f(
        this.uEl["uNoContinuousSdfInRefraction"],
        el.useContinuousSdf && !this.noContinuousSdf ? 0 : 1
      );
      gl.uniform1f(this.uEl["uEnterAlpha"], state.enterAlpha);
      gl.uniform1f(this.uEl["uCornerStyle"], this.cornerStyle);
      if (el.isMagnifier) {
        gl.uniform1f(this.uEl["uUseMagnifier"], 1);
        gl.uniform1f(this.uEl["uMagnifierZoom"], el.isMagnifier.zoom);
        gl.uniform1f(this.uEl["uMagnifierOffsetY"], el.isMagnifier.sampleOffsetY * this.dpr);
      } else {
        gl.uniform1f(this.uEl["uUseMagnifier"], 0);
      }
      gl.uniform1f(
        this.uEl["uSkipColorControls"],
        el.backdropFbo && shouldUseSeparableBlur(el, state) ? 1 : 0
      );
      gl.uniform1f(this.uEl["uSampleWallpaper"], useSampleWallpaper ? 1 : 0);
      if (el.scrimColor) {
        gl.uniform4f(
          this.uEl["uScrimColor"],
          el.scrimColor[0],
          el.scrimColor[1],
          el.scrimColor[2],
          el.scrimColor[3]
        );
      } else {
        gl.uniform4f(this.uEl["uScrimColor"], 0, 0, 0, 0);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      state.elHighlightAlpha = ctx.elHighlightAlpha;
    }
  };

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/inner-shadow-mask.ts
  function buildPath(w, h, radius, useG2) {
    if (useG2) {
      const dummyCanvas = new OffscreenCanvas(1, 1);
      const dummyCtx = dummyCanvas.getContext("2d");
      return continuousCurvatureRoundedRectPath(dummyCtx, w, h, radius);
    }
    const path = new Path2D();
    if (typeof path.roundRect === "function") {
      path.roundRect(0, 0, w, h, radius);
    } else {
      const r = Math.min(radius, w / 2, h / 2);
      path.moveTo(r, 0);
      path.lineTo(w - r, 0);
      path.arcTo(w, 0, w, r, r);
      path.lineTo(w, h - r);
      path.arcTo(w, h, w - r, h, r);
      path.lineTo(r, h);
      path.arcTo(0, h, 0, h - r, r);
      path.lineTo(0, r);
      path.arcTo(0, 0, r, 0, r);
      path.closePath();
    }
    return path;
  }
  function createCanvas(w, h) {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d", { alpha: true });
    return { canvas, ctx };
  }
  function generateInnerShadowMask(params) {
    const { w, h, radius, offsetX, offsetY, blurSigma, margin, useG2, supersample: SS } = params;
    const maskW = Math.max(1, Math.ceil(w + 2 * margin));
    const maskH = Math.max(1, Math.ceil(h + 2 * margin));
    const canvasW = maskW * SS;
    const canvasH = maskH * SS;
    const { canvas: tempCanvas, ctx: tCtx } = createCanvas(canvasW, canvasH);
    const { canvas: outputCanvas, ctx: oCtx } = createCanvas(canvasW, canvasH);
    tCtx.save();
    tCtx.scale(SS, SS);
    tCtx.translate(margin, margin);
    const path = buildPath(w, h, radius, useG2);
    tCtx.clip(path);
    tCtx.globalCompositeOperation = "source-over";
    tCtx.fillStyle = "white";
    tCtx.fill(path);
    tCtx.globalCompositeOperation = "destination-out";
    tCtx.save();
    tCtx.translate(offsetX, offsetY);
    tCtx.fill(path);
    tCtx.restore();
    tCtx.globalCompositeOperation = "source-over";
    tCtx.restore();
    if (blurSigma > 0.01) {
      oCtx.filter = `blur(${blurSigma * SS}px)`;
    } else {
      oCtx.filter = "none";
    }
    oCtx.drawImage(tempCanvas, 0, 0);
    oCtx.filter = "none";
    return { canvas: outputCanvas, maskW, maskH, margin };
  }

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/inner-shadow-cache.ts
  var MAX_CACHE_SIZE = 32;
  function buildMaskKey(shadowIndex, params) {
    return [
      "is",
      shadowIndex,
      params.useG2 ? "g2" : "rr",
      params.w.toFixed(3),
      params.h.toFixed(3),
      params.radius.toFixed(3),
      params.offsetX.toFixed(3),
      params.offsetY.toFixed(3),
      params.blurSigma.toFixed(3),
      params.margin,
      Math.ceil(params.w + 2 * params.margin),
      // maskW
      Math.ceil(params.h + 2 * params.margin),
      // maskH
      `ss${params.supersample}`
    ].join(":");
  }
  function getOrCreateMaskEntry(cache, gl, key, maskW, maskH) {
    let entry = cache.get(key);
    if (entry) return entry;
    const tex = gl.createTexture();
    if (!tex) throw new Error("WebGL texture allocation failed");
    entry = { tex, w: maskW, h: maskH, ready: false };
    cache.set(key, entry);
    if (cache.size > MAX_CACHE_SIZE) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey && oldestKey !== key) {
        const oldest = cache.get(oldestKey);
        if (oldest) gl.deleteTexture(oldest.tex);
        cache.delete(oldestKey);
      }
    }
    return entry;
  }
  function uploadMaskTexture(gl, entry, result) {
    gl.bindTexture(gl.TEXTURE_2D, entry.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, result.canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    entry.ready = true;
  }
  function destroyCache(gl, cache) {
    for (const entry of cache.values()) {
      gl.deleteTexture(entry.tex);
    }
    cache.clear();
  }

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-render-glass-post-passes-inner-shadow.ts
  function renderGlassInnerShadowPass(renderer, state) {
    const gl = renderer.gl;
    const { el, sx, sy, sw, sh, radii, togglePressProgress } = state;
    if (!el.innerShadow || !renderer.quickToggles.innershadow) return;
    const origSizeX = state.origW * renderer.dpr;
    const origSizeY = state.origH * renderer.dpr;
    const origRadius = state.origCornerRadius * renderer.dpr;
    const layerScaleX = state.layerScaleX;
    const layerScaleY = state.layerScaleY;
    drawInnerShadowPass(renderer, state, el.innerShadow, 0);
    function drawInnerShadowPass(r, st, shadowCfg, shadowIndex) {
      var _a;
      const progress = st.el.isToggleKnob || st.el.isBottomTabIndicator ? togglePressProgress : 1;
      const shadowAlpha = shadowCfg.alpha * progress * st.enterAlpha;
      const shadowRadius = shadowCfg.radius * progress;
      const shadowOffsetX = shadowCfg.offsetX * progress;
      const shadowOffsetY = shadowCfg.offsetY * progress;
      if (shadowAlpha <= 1e-3 || shadowRadius <= 0.5) return;
      const blurSigma = shadowRadius * r.dpr;
      const margin = Math.ceil(blurSigma * 3) + 2;
      const maskW = Math.max(1, Math.ceil(origSizeX + 2 * margin));
      const maskH = Math.max(1, Math.ceil(origSizeY + 2 * margin));
      const deviceDpr = window.devicePixelRatio || 1;
      const SS = Math.min(2, Math.max(1, Math.floor(deviceDpr / r.dpr)));
      const useG2 = !!st.el.useContinuousSdf;
      const offsetXDp = shadowOffsetX * r.dpr;
      const offsetYDp = shadowOffsetY * r.dpr;
      const maskParams = {
        w: origSizeX,
        h: origSizeY,
        radius: origRadius,
        offsetX: offsetXDp,
        offsetY: offsetYDp,
        blurSigma,
        margin,
        useG2,
        supersample: SS
      };
      const key = buildMaskKey(shadowIndex, maskParams);
      const entry = getOrCreateMaskEntry(r.innerShadowMaskCache, gl, key, maskW, maskH);
      if (!entry.ready) {
        const result = generateInnerShadowMask(maskParams);
        uploadMaskTexture(gl, entry, result);
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(r.innerShadowMaskCompositeProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, r.quadBuffer);
      gl.enableVertexAttribArray(r.aPosLocIs);
      gl.vertexAttribPointer(r.aPosLocIs, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(r.uIs["uCanvasSize"], r.canvas.width, r.canvas.height);
      gl.uniform2f(r.uIs["uOffset"], sx * r.dpr, sy * r.dpr);
      gl.uniform2f(r.uIs["uSize"], sw * r.dpr, sh * r.dpr);
      gl.uniform4f(
        r.uIs["uCornerRadii"],
        radii[0] * r.dpr,
        radii[1] * r.dpr,
        radii[2] * r.dpr,
        radii[3] * r.dpr
      );
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, entry.tex);
      gl.uniform1i(r.uIs["uInnerShadowMask"], 0);
      gl.uniform2f(r.uIs["uMaskOffset"], margin, margin);
      gl.uniform2f(r.uIs["uMaskSize"], entry.w, entry.h);
      const color = (_a = shadowCfg.color) != null ? _a : [0, 0, 0];
      gl.uniform3f(r.uIs["uInnerShadowColor"], color[0], color[1], color[2]);
      gl.uniform1f(r.uIs["uInnerShadowAlpha"], shadowAlpha);
      gl.uniform2f(r.uIs["uOriginalSize"], origSizeX, origSizeY);
      gl.uniform1f(r.uIs["uOriginalCornerRadius"], origRadius);
      gl.uniform2f(r.uIs["uLayerScale"], layerScaleX, layerScaleY);
      gl.uniform1f(r.uIs["uElementRotation"], st.elementRotation);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
  }

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-render-glass-post-passes-glow.ts
  function renderGlassGlowAndOverlays(renderer, state) {
    var _a;
    const gl = renderer.gl;
    const { el, st, isButton, p, sx, sy, sw, sh, radii, togglePressProgress } = state;
    const origSizeX = state.origW * renderer.dpr;
    const origSizeY = state.origH * renderer.dpr;
    const origRadius = state.origCornerRadius * renderer.dpr;
    const layerScaleX = state.layerScaleX;
    const layerScaleY = state.layerScaleY;
    const bindTintContinuousSdf = () => {
      if (el.useContinuousSdf && renderer.continuousSdfTexture) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, renderer.continuousSdfTexture);
        gl.uniform1i(renderer.uTn["uContinuousSdf"], 2);
        gl.uniform1f(renderer.uTn["uUseContinuousSdf"], 1);
        gl.uniform2f(
          renderer.uTn["uContinuousSdfTexSize"],
          renderer.continuousSdfTexSize[0],
          renderer.continuousSdfTexSize[1]
        );
        gl.uniform2f(
          renderer.uTn["uContinuousSdfElementSize"],
          state.origW * renderer.dpr,
          state.origH * renderer.dpr
        );
      } else {
        gl.uniform1f(renderer.uTn["uUseContinuousSdf"], 0);
      }
    };
    const isContainer = !!el.isBottomTabContainer;
    const glowP = isButton ? p : isContainer ? togglePressProgress : 0;
    if (isButton && el.isInteractive && st && p > 1e-3 || isContainer && togglePressProgress > 1e-3) {
      gl.useProgram(renderer.tintProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, renderer.quadBuffer);
      gl.enableVertexAttribArray(renderer.aPosLocTn);
      gl.vertexAttribPointer(renderer.aPosLocTn, 2, gl.FLOAT, false, 0, 0);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.uniform2f(renderer.uTn["uCanvasSize"], renderer.canvas.width, renderer.canvas.height);
      gl.uniform2f(renderer.uTn["uOffset"], sx * renderer.dpr, sy * renderer.dpr);
      gl.uniform2f(renderer.uTn["uSize"], sw * renderer.dpr, sh * renderer.dpr);
      gl.uniform4f(
        renderer.uTn["uCornerRadii"],
        radii[0] * renderer.dpr,
        radii[1] * renderer.dpr,
        radii[2] * renderer.dpr,
        radii[3] * renderer.dpr
      );
      gl.uniform2f(renderer.uTn["uOriginalSize"], origSizeX, origSizeY);
      gl.uniform1f(renderer.uTn["uOriginalCornerRadius"], origRadius);
      gl.uniform2f(renderer.uTn["uLayerScale"], layerScaleX, layerScaleY);
      gl.uniform1f(renderer.uTn["uElementRotation"], state.elementRotation);
      gl.uniform1f(renderer.uTn["uCornerStyle"], renderer.cornerStyle);
      bindTintContinuousSdf();
      gl.uniform4f(renderer.uTn["uColor"], 1, 1, 1, 0.08 * glowP);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.useProgram(renderer.highlightProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, renderer.quadBuffer);
      gl.enableVertexAttribArray(renderer.aPosLocHl);
      gl.vertexAttribPointer(renderer.aPosLocHl, 2, gl.FLOAT, false, 0, 0);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.uniform2f(renderer.uHl["uCanvasSize"], renderer.canvas.width, renderer.canvas.height);
      gl.uniform2f(renderer.uHl["uOffset"], sx * renderer.dpr, sy * renderer.dpr);
      gl.uniform2f(renderer.uHl["uSize"], sw * renderer.dpr, sh * renderer.dpr);
      gl.uniform4f(
        renderer.uHl["uCornerRadii"],
        radii[0] * renderer.dpr,
        radii[1] * renderer.dpr,
        radii[2] * renderer.dpr,
        radii[3] * renderer.dpr
      );
      gl.uniform2f(renderer.uHl["uOriginalSize"], origSizeX, origSizeY);
      gl.uniform1f(renderer.uHl["uOriginalCornerRadius"], origRadius);
      gl.uniform2f(renderer.uHl["uLayerScale"], layerScaleX, layerScaleY);
      gl.uniform1f(renderer.uHl["uElementRotation"], state.elementRotation);
      gl.uniform1f(renderer.uHl["uCornerStyle"], renderer.cornerStyle);
      gl.uniform4f(renderer.uHl["uColor"], 1, 1, 1, 0.15 * glowP);
      const minDim = Math.min(sw, sh) * renderer.dpr;
      gl.uniform1f(renderer.uHl["uRadius"], minDim * 1.5);
      let px, py;
      if (isContainer) {
        const tg = renderer.toggleStates.get(el.isBottomTabContainer.groupId);
        const tabsCount = (_a = el.isBottomTabContainer.tabsCount) != null ? _a : 4;
        const tabW = el.rect.w / tabsCount;
        const fraction = tg ? tg.fraction : 0;
        const indCenterX = (fraction + 0.5) * tabW;
        const scaleToLocal = sw / el.rect.w;
        px = Math.max(0, Math.min(sw, indCenterX * scaleToLocal)) * renderer.dpr;
        py = sh / 2 * renderer.dpr;
      } else {
        px = Math.max(0, Math.min(sw, st.dragX * state.layerScaleX)) * renderer.dpr;
        py = Math.max(0, Math.min(sh, st.dragY * state.layerScaleY)) * renderer.dpr;
      }
      gl.uniform2f(renderer.uHl["uPosition"], px, py);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }
    if (el.isToggleKnob && togglePressProgress < 0.999) {
      const whiteAlpha = 1 * (1 - togglePressProgress);
      gl.useProgram(renderer.tintProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, renderer.quadBuffer);
      gl.enableVertexAttribArray(renderer.aPosLocTn);
      gl.vertexAttribPointer(renderer.aPosLocTn, 2, gl.FLOAT, false, 0, 0);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform2f(renderer.uTn["uCanvasSize"], renderer.canvas.width, renderer.canvas.height);
      gl.uniform2f(renderer.uTn["uOffset"], sx * renderer.dpr, sy * renderer.dpr);
      gl.uniform2f(renderer.uTn["uSize"], sw * renderer.dpr, sh * renderer.dpr);
      gl.uniform4f(
        renderer.uTn["uCornerRadii"],
        radii[0] * renderer.dpr,
        radii[1] * renderer.dpr,
        radii[2] * renderer.dpr,
        radii[3] * renderer.dpr
      );
      gl.uniform2f(renderer.uTn["uOriginalSize"], origSizeX, origSizeY);
      gl.uniform1f(renderer.uTn["uOriginalCornerRadius"], origRadius);
      gl.uniform2f(renderer.uTn["uLayerScale"], layerScaleX, layerScaleY);
      gl.uniform1f(renderer.uTn["uElementRotation"], state.elementRotation);
      gl.uniform1f(renderer.uTn["uCornerStyle"], renderer.cornerStyle);
      bindTintContinuousSdf();
      gl.uniform4f(renderer.uTn["uColor"], 1, 1, 1, whiteAlpha);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    if (el.isBottomTabIndicator && el.isBottomTabIndicator.dimColor) {
      const dc = el.isBottomTabIndicator.dimColor;
      const prog = togglePressProgress;
      gl.useProgram(renderer.tintProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, renderer.quadBuffer);
      gl.enableVertexAttribArray(renderer.aPosLocTn);
      gl.vertexAttribPointer(renderer.aPosLocTn, 2, gl.FLOAT, false, 0, 0);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform2f(renderer.uTn["uCanvasSize"], renderer.canvas.width, renderer.canvas.height);
      gl.uniform2f(renderer.uTn["uOffset"], sx * renderer.dpr, sy * renderer.dpr);
      gl.uniform2f(renderer.uTn["uSize"], sw * renderer.dpr, sh * renderer.dpr);
      gl.uniform4f(
        renderer.uTn["uCornerRadii"],
        radii[0] * renderer.dpr,
        radii[1] * renderer.dpr,
        radii[2] * renderer.dpr,
        radii[3] * renderer.dpr
      );
      gl.uniform2f(renderer.uTn["uOriginalSize"], origSizeX, origSizeY);
      gl.uniform1f(renderer.uTn["uOriginalCornerRadius"], origRadius);
      gl.uniform2f(renderer.uTn["uLayerScale"], layerScaleX, layerScaleY);
      gl.uniform1f(renderer.uTn["uElementRotation"], state.elementRotation);
      gl.uniform1f(renderer.uTn["uCornerStyle"], renderer.cornerStyle);
      bindTintContinuousSdf();
      gl.uniform4f(renderer.uTn["uColor"], dc[0], dc[1], dc[2], 0.1 * (1 - prog));
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.uniform4f(renderer.uTn["uColor"], 0, 0, 0, 0.03 * prog);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }
  }

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-render-glass-post-passes-rim-highlight.ts
  function renderGlassRimHighlight(renderer, state) {
    var _a;
    const gl = renderer.gl;
    const { el, sx, sy, sw, sh, radii, togglePressProgress, elHighlightAlpha } = state;
    if (!el.highlight || el.highlight.alpha <= 1e-3 || !renderer.quickToggles.highlight) return;
    const origSizeX = state.origW * renderer.dpr;
    const origSizeY = state.origH * renderer.dpr;
    const origRadius = state.origCornerRadius * renderer.dpr;
    const layerScaleX = state.layerScaleX;
    const layerScaleY = state.layerScaleY;
    const rimAlpha = el.isToggleKnob || el.isBottomTabIndicator ? elHighlightAlpha : el.highlight.alpha;
    const paintAlpha = el.highlight.mode === 1 ? 0.38 : 1;
    const finalAlpha = rimAlpha * state.enterAlpha * paintAlpha;
    if (finalAlpha <= 1e-3) return;
    const widthPx = Math.min(
      el.highlight.widthDp * renderer.dpr,
      Math.min(origSizeX, origSizeY) * 0.5
    );
    const strokeWidthDevice = el.highlight.aa !== false ? Math.max(1, Math.ceil(widthPx) * 2) : Math.max(1, Math.round(widthPx) * 2);
    const blurPx = Math.max(0, ((_a = el.highlight.blurRadiusDp) != null ? _a : el.highlight.widthDp / 2) * renderer.dpr);
    const strokeMargin = Math.ceil(strokeWidthDevice) + 4;
    const maskW = Math.max(1, Math.ceil(origSizeX + 2 * strokeMargin));
    const maskH = Math.max(1, Math.ceil(origSizeY + 2 * strokeMargin));
    const deviceDpr = window.devicePixelRatio || 1;
    const SS = Math.min(2, Math.max(1, Math.floor(deviceDpr / renderer.dpr)));
    const canvasW = maskW * SS;
    const canvasH = maskH * SS;
    const useG2 = !!el.useContinuousSdf;
    const maskKey = [
      useG2 ? "g2" : "rr",
      origSizeX.toFixed(3),
      origSizeY.toFixed(3),
      origRadius.toFixed(3),
      strokeWidthDevice,
      blurPx.toFixed(3),
      strokeMargin,
      maskW,
      maskH,
      `ss${SS}`
      // cache key includes supersample factor
    ].join(":");
    let mask = renderer.strokeMaskCache.get(maskKey);
    if (!mask) {
      const canvas = document.createElement("canvas");
      canvas.width = canvasW;
      canvas.height = canvasH;
      const ctx2d = canvas.getContext("2d", { alpha: true });
      if (!ctx2d) throw new Error("2D canvas not supported");
      const tex = gl.createTexture();
      if (!tex) throw new Error("WebGL texture allocation failed");
      mask = { tex, canvas, ctx: ctx2d, w: maskW, h: maskH, ready: false };
      renderer.strokeMaskCache.set(maskKey, mask);
      if (renderer.strokeMaskCache.size > 32) {
        const oldestKey = renderer.strokeMaskCache.keys().next().value;
        if (oldestKey && oldestKey !== maskKey) {
          const oldest = renderer.strokeMaskCache.get(oldestKey);
          if (oldest) gl.deleteTexture(oldest.tex);
          renderer.strokeMaskCache.delete(oldestKey);
        }
      }
    }
    if (!mask.ready) {
      const smCtx = mask.ctx;
      smCtx.clearRect(0, 0, canvasW, canvasH);
      smCtx.save();
      smCtx.scale(SS, SS);
      smCtx.translate(strokeMargin, strokeMargin);
      let path;
      if (useG2) {
        path = continuousCurvatureRoundedRectPath(smCtx, origSizeX, origSizeY, origRadius);
      } else {
        path = new Path2D();
        const r = Math.min(origRadius, origSizeX / 2, origSizeY / 2);
        path.moveTo(r, 0);
        path.lineTo(origSizeX - r, 0);
        path.arcTo(origSizeX, 0, origSizeX, r, r);
        path.lineTo(origSizeX, origSizeY - r);
        path.arcTo(origSizeX, origSizeY, origSizeX - r, origSizeY, r);
        path.lineTo(r, origSizeY);
        path.arcTo(0, origSizeY, 0, origSizeY - r, r);
        path.lineTo(0, r);
        path.arcTo(0, 0, r, 0, r);
        path.closePath();
      }
      smCtx.clip(path);
      smCtx.lineWidth = strokeWidthDevice;
      smCtx.strokeStyle = "rgba(255,255,255,1)";
      smCtx.lineJoin = "round";
      smCtx.lineCap = "round";
      smCtx.filter = blurPx > 0.01 ? `blur(${blurPx}px)` : "none";
      smCtx.stroke(path);
      smCtx.filter = "none";
      smCtx.restore();
      gl.bindTexture(gl.TEXTURE_2D, mask.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mask.canvas);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      mask.ready = true;
    }
    gl.enable(gl.BLEND);
    if (el.highlight.mode === 1) {
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    } else {
      gl.blendFunc(gl.ONE, gl.ONE);
    }
    gl.useProgram(renderer.strokeMaskCompositeProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, renderer.quadBuffer);
    gl.enableVertexAttribArray(renderer.aPosLocSm);
    gl.vertexAttribPointer(renderer.aPosLocSm, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(renderer.uSm["uCanvasSize"], renderer.canvas.width, renderer.canvas.height);
    gl.uniform2f(renderer.uSm["uOffset"], sx * renderer.dpr, sy * renderer.dpr);
    gl.uniform2f(renderer.uSm["uSize"], sw * renderer.dpr, sh * renderer.dpr);
    gl.uniform4f(
      renderer.uSm["uCornerRadii"],
      radii[0] * renderer.dpr,
      radii[1] * renderer.dpr,
      radii[2] * renderer.dpr,
      radii[3] * renderer.dpr
    );
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, mask.tex);
    gl.uniform1i(renderer.uSm["uStrokeMask"], 0);
    gl.uniform2f(renderer.uSm["uMaskOffset"], strokeMargin, strokeMargin);
    gl.uniform2f(renderer.uSm["uMaskSize"], mask.w, mask.h);
    gl.uniform4f(
      renderer.uSm["uHighlightColor"],
      el.highlight.color[0],
      el.highlight.color[1],
      el.highlight.color[2],
      1
    );
    gl.uniform1f(
      renderer.uSm["uHighlightAngle"],
      el.useGravityAngle ? renderer.gravityAngle : el.highlight.angle
    );
    gl.uniform1f(renderer.uSm["uHighlightFalloff"], el.highlight.falloff);
    gl.uniform1f(renderer.uSm["uHighlightAlpha"], finalAlpha);
    gl.uniform1f(renderer.uSm["uHighlightMode"], el.highlight.mode);
    gl.uniform2f(renderer.uSm["uOriginalSize"], origSizeX, origSizeY);
    gl.uniform1f(renderer.uSm["uOriginalCornerRadius"], origRadius);
    gl.uniform2f(renderer.uSm["uLayerScale"], layerScaleX, layerScaleY);
    gl.uniform1f(renderer.uSm["uElementRotation"], state.elementRotation);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-render-glass-post-passes.ts
  var glassPostPassMethods = {
    /** Steps 2b–2f: Inner shadow, press glow, white overlay, foreground, rim highlight.
     *  These all composite on top of the glass body (already drawn to
     *  otherFbo by renderGlassElementPass).
     *
     *  Orchestration only — the inner-shadow pass, the press-glow + white-overlay
     *  + indicator-dim overlays, and the rim-highlight pass each live in their
     *  own file. Only the foreground (label/icon) pass is small enough to keep
     *  inline here. */
    renderGlassPostPasses(state) {
      const gl = this.gl;
      const { el, st, isButton, p, sx, sy, sw, sh, radii } = state;
      const origSizeX = state.origW * this.dpr;
      const origSizeY = state.origH * this.dpr;
      const origRadius = state.origCornerRadius * this.dpr;
      const layerScaleX = state.layerScaleX;
      const layerScaleY = state.layerScaleY;
      renderGlassInnerShadowPass(this, state);
      renderGlassGlowAndOverlays(this, state);
      if (isButton && (el.label || el.icon)) {
        const fgTex = this.fgTextures.get(el.id);
        if (fgTex) {
          gl.useProgram(this.foregroundProgram);
          gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
          gl.enableVertexAttribArray(this.aPosLocFg);
          gl.vertexAttribPointer(this.aPosLocFg, 2, gl.FLOAT, false, 0, 0);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, fgTex);
          gl.uniform1i(this.uFg["uTexture"], 0);
          gl.uniform2f(this.uFg["uCanvasSize"], this.canvas.width, this.canvas.height);
          gl.uniform2f(this.uFg["uOffset"], sx * this.dpr, sy * this.dpr);
          gl.uniform2f(this.uFg["uSize"], sw * this.dpr, sh * this.dpr);
          gl.uniform4f(
            this.uFg["uCornerRadii"],
            radii[0] * this.dpr,
            radii[1] * this.dpr,
            radii[2] * this.dpr,
            radii[3] * this.dpr
          );
          gl.uniform2f(this.uFg["uOriginalSize"], origSizeX, origSizeY);
          gl.uniform1f(this.uFg["uOriginalCornerRadius"], origRadius);
          gl.uniform2f(this.uFg["uLayerScale"], layerScaleX, layerScaleY);
          gl.uniform1f(this.uFg["uCornerStyle"], this.cornerStyle);
          if (el.useContinuousSdf && this.continuousSdfTexture) {
            gl.activeTexture(gl.TEXTURE2);
            gl.bindTexture(gl.TEXTURE_2D, this.continuousSdfTexture);
            gl.uniform1i(this.uFg["uContinuousSdf"], 2);
            gl.uniform1f(this.uFg["uUseContinuousSdf"], 1);
            gl.uniform2f(
              this.uFg["uContinuousSdfTexSize"],
              this.continuousSdfTexSize[0],
              this.continuousSdfTexSize[1]
            );
            gl.uniform2f(
              this.uFg["uContinuousSdfElementSize"],
              state.origW * this.dpr,
              state.origH * this.dpr
            );
          } else {
            gl.uniform1f(this.uFg["uUseContinuousSdf"], 0);
          }
          gl.uniform1f(this.uFg["uAlpha"], 1 - 0.15 * p);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        }
      }
      renderGlassRimHighlight(this, state);
    }
  };

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-dirty.ts
  var dirtyTrackingMethods = {
    markElementDirty(id) {
      var _a;
      this.dirtyElementIds.add(id);
      const entry = this.elFboCache.get(id);
      if (entry) entry.valid = false;
      if (this.showDirtyMarkers) {
        const stack = (_a = new Error().stack) != null ? _a : "";
        const lines = stack.split("\n");
        let source = "unknown";
        for (let i = 2; i < lines.length; i++) {
          const ln = lines[i].trim();
          if (!ln) continue;
          if (ln.includes("markElementDirty") || ln.includes("markGroupDirty") || ln.includes("markAllDirty")) continue;
          const m = ln.match(/at\s+(\S+)\s+\(/);
          source = m ? m[1] : ln.slice(0, 60);
          break;
        }
        this.debugDirtySourceLog.push({ id, source });
      }
    },
    markAllDirty() {
      this.allDirty = true;
      this.dirtyElementIds.clear();
      for (const entry of this.elFboCache.values()) entry.valid = false;
    },
    markGroupDirty(groupId) {
      var _a, _b, _c, _d, _e, _f;
      for (const el of this.buttonConfigs) {
        if (((_a = el.isToggleKnob) == null ? void 0 : _a.groupId) === groupId || ((_b = el.isToggleTrack) == null ? void 0 : _b.groupId) === groupId || ((_c = el.isSliderFill) == null ? void 0 : _c.groupId) === groupId || ((_d = el.isBottomTabContainer) == null ? void 0 : _d.groupId) === groupId || ((_e = el.isBottomTabContent) == null ? void 0 : _e.groupId) === groupId || ((_f = el.isBottomTabIndicator) == null ? void 0 : _f.groupId) === groupId) {
          this.markElementDirty(el.id);
        }
      }
    },
    markGravityDirty() {
      for (const el of this.buttonConfigs) {
        if (el.useGravityAngle) this.markElementDirty(el.id);
      }
    },
    hasDirtyElements() {
      return this.allDirty || this.dirtyElementIds.size > 0;
    },
    deleteElFboCacheEntry(id) {
      const entry = this.elFboCache.get(id);
      if (!entry) return;
      const gl = this.gl;
      gl.deleteFramebuffer(entry.fb);
      gl.deleteTexture(entry.tex);
      this.elFboCache.delete(id);
    }
  };

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-debug.ts
  function analyzeEdgeScan(scan) {
    const { pixels, dpr } = scan;
    const N = pixels.length;
    if (N < 4) {
      return {
        edgeIdx: 0,
        edgeOffsetCss: 0,
        transitionHalfW: 0,
        rgbInside: 0,
        rgbOutside: 0,
        minRgbInTransition: 0,
        blackFringeDetected: false,
        hasNearBlackPx: false,
        canvasOpaque: true,
        verdict: "Scan too short (element not found or off-screen)."
      };
    }
    const lum = new Float32Array(N);
    let opaqueCount = 0;
    for (let i = 0; i < N; i++) {
      const p = pixels[i];
      lum[i] = 0.299 * p.r + 0.587 * p.g + 0.114 * p.b;
      if (p.a >= 250) opaqueCount++;
    }
    const canvasOpaque = opaqueCount > N * 0.9;
    let maxGrad = 0;
    let edgeIdx = Math.floor(N / 2);
    for (let i = 2; i < N - 2; i++) {
      const g = Math.abs(lum[i + 1] - lum[i - 1]);
      if (g > maxGrad) {
        maxGrad = g;
        edgeIdx = i;
      }
    }
    const edgeOffsetCss = pixels[edgeIdx].offset;
    const transitionHalfW = Math.max(3, Math.floor(N / 8));
    const zoneStart = Math.max(0, edgeIdx - transitionHalfW);
    const zoneEnd = Math.min(N - 1, edgeIdx + transitionHalfW);
    const insideStart = Math.max(0, zoneStart - 3);
    const insideEnd = Math.max(insideStart, zoneStart - 1);
    let rgbInside = 0, insideCount = 0;
    for (let i = insideStart; i <= insideEnd; i++) {
      rgbInside += lum[i];
      insideCount++;
    }
    rgbInside = insideCount > 0 ? rgbInside / insideCount : lum[0];
    const outsideStart = Math.min(N - 1, zoneEnd + 1);
    const outsideEnd = Math.min(N - 1, zoneEnd + 3);
    let rgbOutside = 0, outsideCount = 0;
    for (let i = outsideStart; i <= outsideEnd; i++) {
      rgbOutside += lum[i];
      outsideCount++;
    }
    rgbOutside = outsideCount > 0 ? rgbOutside / outsideCount : lum[N - 1];
    let minRgbInTransition = 255;
    let hasNearBlackPx = false;
    for (let i = zoneStart; i <= zoneEnd; i++) {
      const l = lum[i];
      if (l < minRgbInTransition) minRgbInTransition = l;
      if (l < 30) hasNearBlackPx = true;
    }
    const threshold = 25;
    const blackFringeDetected = maxGrad > 10 && // only flag if there's a real edge (not a flat region)
    minRgbInTransition < Math.min(rgbInside, rgbOutside) - threshold && minRgbInTransition < 100;
    let verdict;
    if (blackFringeDetected && hasNearBlackPx) {
      verdict = `\u26A0 BLACK FRINGE: RGB dips to ${minRgbInTransition.toFixed(0)} at edge (inside=${rgbInside.toFixed(0)}, outside=${rgbOutside.toFixed(0)}). Near-black pixels in transition zone \u2192 premult-alpha leak or refraction reads outside FBO.`;
    } else if (blackFringeDetected) {
      verdict = `\u26A0 DARK EDGE: RGB dips to ${minRgbInTransition.toFixed(0)} at edge (inside=${rgbInside.toFixed(0)}, outside=${rgbOutside.toFixed(0)}). Edge is darker than both sides.`;
    } else if (hasNearBlackPx && maxGrad > 10) {
      verdict = `\u26A0 NEAR-BLACK PX at edge: min RGB ${minRgbInTransition.toFixed(0)} (inside=${rgbInside.toFixed(0)}, outside=${rgbOutside.toFixed(0)}). Investigate.`;
    } else if (maxGrad <= 10) {
      verdict = `~ Flat scan (no sharp edge detected). Max gradient ${maxGrad.toFixed(1)}. Element may be off-screen or uniformly colored.`;
    } else {
      verdict = `\u2713 Clean edge. Transition RGB ${minRgbInTransition.toFixed(0)} is between inside ${rgbInside.toFixed(0)} and outside ${rgbOutside.toFixed(0)}. No black fringe.`;
    }
    return {
      edgeIdx,
      edgeOffsetCss,
      transitionHalfW,
      rgbInside,
      rgbOutside,
      minRgbInTransition,
      blackFringeDetected,
      hasNearBlackPx,
      canvasOpaque,
      verdict
    };
  }
  var debugMethods = {
    /** Request an edge scan. Sets _pendingEdgeScan + calls requestRender().
     *  The actual readPixels happens at the end of the next render() frame
     *  (while the drawing buffer is still valid, before the browser composites
     *  and clears it). The overlay polls _edgeScanResult for the result. */
    debugReadEdgeScanline(halfRangeCss = 20) {
      this._pendingEdgeScan = { halfRangeCss };
      this.requestRender();
    },
    /** Cycle the scan target to the next useContinuousSdf element. Returns
     *  the new target index (0-based, modulo the element count). */
    debugCycleEdgeScanTarget() {
      const candidates = this.buttonConfigs.filter(
        (e) => e.useContinuousSdf && e.rect.w > 0 && e.rect.h > 0
      );
      if (candidates.length === 0) return 0;
      this._edgeScanTargetIdx = (this._edgeScanTargetIdx + 1) % candidates.length;
      this._pendingEdgeScan = { halfRangeCss: 20 };
      this.requestRender();
      return this._edgeScanTargetIdx;
    },
    /** Clear any pending + completed edge scan (toggle OFF). Clears
     *  _pendingEdgeScan so an in-flight request doesn't repopulate the result
     *  next frame, drops _edgeScanResult so the overlay's next poll sees null,
     *  and bumps _edgeScanCounter so the overlay's lastConsumedScanId is stale
     *  (a subsequent new scan will have a fresh scanId the overlay will pick
     *  up). No requestRender — clearing is purely state, no draw needed. */
    debugClearEdgeScan() {
      this._pendingEdgeScan = null;
      this._edgeScanResult = null;
      this._edgeScanCounter++;
    },
    /** Called from the render loop (methods-render.ts) right after the final
     *  drawCopy to the default framebuffer. If a scan is pending, reads a 2D
     *  patch around the target capsule element's TOP-RIGHT CORNER (the 45°
     *  point on the corner arc), extracts a diagonal through the arc edge,
     *  analyzes it, and stores the result in _edgeScanResult.
     *
     *  WHY THE CORNER (not the straight edge): the black-edge artifact only
     *  appears on curved (non-straight) edges. The straight edge maps to the
     *  middle of the SDF texture where coverage (R) and SDF (G) are both flat
     *  and clean — no fringe. The corner maps to the high-curvature region of
     *  the SDF texture where the chamfer distance transform has the most error,
     *  causing R (coverage) and G (SDF) to potentially misalign → black fringe.
     *
     *  MUST be called while the default framebuffer is still bound and the
     *  drawing buffer is valid (i.e. synchronously after drawCopy, within
     *  the same rAF tick). */
    _debugFlushPendingEdgeScan() {
      const pending = this._pendingEdgeScan;
      if (!pending) return;
      this._pendingEdgeScan = null;
      const candidates = this.buttonConfigs.filter((e) => e.useContinuousSdf && e.rect.w > 0 && e.rect.h > 0).map((e) => {
        const minDim = Math.min(e.rect.w, e.rect.h);
        const isCapsule = e.cornerRadius >= minDim / 2 - 0.5;
        return { el: e, isCapsule };
      }).sort((a, b) => Number(b.isCapsule) - Number(a.isCapsule));
      if (candidates.length === 0) {
        this._edgeScanCounter++;
        this._edgeScanResult = {
          scanId: this._edgeScanCounter,
          elementId: "(none)",
          targetIdx: 0,
          targetCount: 0,
          isCapsule: false,
          rect: { x: 0, y: 0, w: 0, h: 0 },
          cornerRadius: 0,
          dpr: this.dpr || 1,
          cornerCenter: { x: 0, y: 0 },
          cornerPoint45: { x: 0, y: 0 },
          patchCssX: 0,
          patchCssY: 0,
          patchDevSize: 0,
          halfRange: pending.halfRangeCss,
          patch: new Uint8Array(0),
          pixels: [],
          sdfProfile: null,
          sdfTexSize: 0,
          analysis: {
            edgeIdx: 0,
            edgeOffsetCss: 0,
            transitionHalfW: 0,
            rgbInside: 0,
            rgbOutside: 0,
            minRgbInTransition: 0,
            blackFringeDetected: false,
            hasNearBlackPx: false,
            canvasOpaque: true,
            verdict: "No useContinuousSdf element found on screen."
          }
        };
        return;
      }
      const targetIdx = this._edgeScanTargetIdx % candidates.length;
      const picked = candidates[targetIdx];
      const el = picked.el;
      const { rect, cornerRadius: r } = el;
      const dpr = this.dpr || 1;
      const gl = this.gl;
      const halfRangeCss = pending.halfRangeCss;
      const sqrt2 = Math.SQRT2;
      const cornerCx = rect.x + rect.w - r;
      const cornerCy = rect.y + r;
      const p45x = cornerCx + r / sqrt2;
      const p45y = cornerCy - r / sqrt2;
      const patchCssX = p45x - halfRangeCss;
      const patchCssY = p45y - halfRangeCss;
      const patchCssSize = halfRangeCss * 2;
      const patchDevSize = Math.max(1, Math.round(patchCssSize * dpr));
      const patchDevX = Math.round(patchCssX * dpr);
      const patchDevYTop = Math.round(patchCssY * dpr);
      const clampedW = Math.min(patchDevSize, this.canvas.width - patchDevX);
      const clampedH = Math.min(patchDevSize, this.canvas.height - patchDevYTop);
      if (clampedW <= 0 || clampedH <= 0) return;
      const readY = this.canvas.height - (patchDevYTop + clampedH);
      const clampedReadY = Math.max(0, Math.min(this.canvas.height - clampedH, readY));
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const buf = new Uint8Array(clampedW * clampedH * 4);
      gl.readPixels(patchDevX, clampedReadY, clampedW, clampedH, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      const patch = new Uint8Array(clampedW * clampedH * 4);
      for (let row = 0; row < clampedH; row++) {
        const srcRow = clampedH - 1 - row;
        patch.set(
          buf.subarray(srcRow * clampedW * 4, (srcRow + 1) * clampedW * 4),
          row * clampedW * 4
        );
      }
      const diagN = Math.min(clampedW, clampedH);
      const pixels = [];
      for (let i = 0; i < diagN; i++) {
        const col = clampedW - 1 - i;
        const row = i;
        const idx = (row * clampedW + col) * 4;
        const offset = (diagN / 2 - i) / dpr;
        pixels.push({
          offset,
          r: patch[idx],
          g: patch[idx + 1],
          b: patch[idx + 2],
          a: patch[idx + 3]
        });
      }
      this._edgeScanCounter++;
      let sdfProfile = null;
      let sdfTexSize = 0;
      const maskEntries = getMaskCacheEntries();
      const elW = rect.w;
      const elH = rect.h;
      const elR = Math.round(r);
      const matchedEntry = maskEntries.find((e) => {
        const parts = e.key.split(",");
        return Math.round(parseFloat(parts[0])) === Math.round(elW) && Math.round(parseFloat(parts[1])) === Math.round(elH) && Math.round(parseFloat(parts[2])) === elR;
      });
      if (matchedEntry) {
        sdfTexSize = matchedEntry.texSize;
        const texData = matchedEntry.tex;
        const ts = matchedEntry.texSize;
        const elementSizeX = elW * dpr;
        const elementSizeY = elH * dpr;
        const maxDim = Math.max(elementSizeX, elementSizeY);
        const margin = 4;
        const scale = (ts - 2 * margin) / maxDim;
        const elementCenterX = rect.x + rect.w / 2;
        const elementCenterY = rect.y + rect.h / 2;
        sdfProfile = [];
        for (let i = 0; i < diagN; i++) {
          const col = clampedW - 1 - i;
          const row = i;
          const patchCanvasX = patchCssX + col / dpr;
          const patchCanvasY = patchCssY + row / dpr;
          const centeredOrigX = (patchCanvasX - elementCenterX) * dpr;
          const centeredOrigY = (patchCanvasY - elementCenterY) * dpr;
          const texX = ts / 2 + centeredOrigX * scale;
          const texY = ts / 2 + centeredOrigY * scale;
          const u = texX / ts;
          const v = texY / ts;
          const fx = texX;
          const fy = texY;
          const ix = Math.floor(fx);
          const iy = Math.floor(fy);
          const fracX = fx - ix;
          const fracY = fy - iy;
          const clamp = (v2) => Math.max(0, Math.min(ts - 1, v2));
          const i00 = (clamp(iy) * ts + clamp(ix)) * 4;
          const i10 = (clamp(iy) * ts + clamp(ix + 1)) * 4;
          const i01 = (clamp(iy + 1) * ts + clamp(ix)) * 4;
          const i11 = (clamp(iy + 1) * ts + clamp(ix + 1)) * 4;
          const w00 = (1 - fracX) * (1 - fracY);
          const w10 = fracX * (1 - fracY);
          const w01 = (1 - fracX) * fracY;
          const w11 = fracX * fracY;
          const rVal = texData[i00] * w00 + texData[i10] * w10 + texData[i01] * w01 + texData[i11] * w11;
          const gVal = texData[i00 + 1] * w00 + texData[i10 + 1] * w10 + texData[i01 + 1] * w01 + texData[i11 + 1] * w11;
          const offset = (diagN / 2 - i) / dpr;
          sdfProfile.push({ r: rVal, g: gVal, offset });
        }
      }
      const base = {
        scanId: this._edgeScanCounter,
        elementId: el.id,
        targetIdx,
        targetCount: candidates.length,
        isCapsule: picked.isCapsule,
        rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
        cornerRadius: r,
        dpr,
        cornerCenter: { x: cornerCx, y: cornerCy },
        cornerPoint45: { x: p45x, y: p45y },
        patchCssX,
        patchCssY,
        patchDevSize: clampedW,
        // use clampedW (== clampedH for square patches)
        halfRange: halfRangeCss,
        patch,
        pixels,
        sdfProfile,
        sdfTexSize
      };
      this._edgeScanResult = { ...base, analysis: analyzeEdgeScan(base) };
    }
  };

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-uniforms.ts
  var uniformMethods = {
    cacheUniforms() {
      const gl = this.gl;
      const elNames = [
        "uBackdrop",
        "uWallpaperSampler",
        "uTabsBackdropSampler",
        "uCanvasSize",
        "uWallpaperSize",
        "uElementOffset",
        "uElementSize",
        "uBackdropBbox",
        "uCornerRadii",
        "uRefractionHeight",
        "uRefractionAmount",
        "uDepthEffect",
        "uChromaticAberration",
        "uBlurRadius",
        "uSaturation",
        "uBrightness",
        "uContrast",
        "uTintColor",
        "uSurfaceColor",
        "uHighlightColor",
        "uHighlightAngle",
        "uHighlightFalloff",
        "uHighlightAlpha",
        "uHighlightMode",
        "uHighlightStrokeWidth",
        "uHighlightBlur",
        "uContentScaleX",
        "uContentScaleY",
        "uUseToggleBackdrop",
        "uUseSolidBackdrop",
        "uSolidBackdropColor",
        "uTrackColor",
        "uTrackRect",
        "uTrackCornerRadius",
        "uOriginalSize",
        "uOriginalCornerRadius",
        "uLayerScale",
        "uIndicatorBackdrop",
        "uContainerRect",
        "uContainerCornerRadius",
        "uIndicatorAccent",
        "uInsetPx",
        "uIndicatorPressProgress",
        "uIndicatorPanelOffset",
        "uDpr",
        "uContainerCenter",
        "uContainerScale",
        "uTabContentTex0",
        "uTabContentTex1",
        "uTabContentTex2",
        "uTabContentTex3",
        "uTabContentTex4",
        "uTabContentTex5",
        "uTabContentTex6",
        "uTabContentTex7",
        "uTabContentRects[0]",
        "uTabContentRects[1]",
        "uTabContentRects[2]",
        "uTabContentRects[3]",
        "uTabContentRects[4]",
        "uTabContentRects[5]",
        "uTabContentRects[6]",
        "uTabContentRects[7]",
        "uTabContentCount",
        "uTabsGlassLayer",
        "uSdfTexSampler",
        "uUseSdfTexture",
        "uSdfTexSize",
        "uSdfLightAngle",
        "uEnterAlpha",
        "uSdfHighlightScale",
        "uSdfBevelEnabled",
        "uSdfGlassTintHue",
        "uSdfGlassTintEnabled",
        "uSdfGlassTintMix",
        "uSdfGlassTintStrength",
        "uSdfGlassTintSaturation",
        "uSdfGlassTintLightness",
        "uSdfEdgeMatteEnabled",
        "uSdfEdgeMatteTargets",
        "uSdfEdgeMatteBevelParams",
        "uSdfEdgeMatteTintParams",
        "uSdfEdgeMatteBaseParams",
        "uSdfEdgeMatteBrightenParams",
        "uSdfEdgeMatteBevelStrength",
        "uSdfEdgeMatteTintStrength",
        "uSdfEdgeMatteBaseStrength",
        "uSdfEdgeMatteBrightenStrength",
        "uSdfDebugMode",
        "uSdfAaMin",
        "uUsePerElementFbo",
        "uSceneRectOffset",
        "uElFboSize",
        "uBackdropRect",
        "uCornerStyle",
        "uSkipColorControls",
        "uUseMagnifier",
        "uMagnifierZoom",
        "uMagnifierOffsetY",
        "uElementRotation",
        "uContinuousSdf",
        "uUseContinuousSdf",
        "uContinuousSdfTexSize",
        "uContinuousSdfElementSize",
        "uNoContinuousSdfInRefraction",
        "uInnerStrokeMask",
        "uInnerStrokeMaskOffset",
        "uInnerStrokeMaskSize"
      ];
      for (const n of elNames) this.uEl[n] = gl.getUniformLocation(this.elementProgram, n);
      const shNames = [
        "uCanvasSize",
        "uElementOffset",
        "uElementSize",
        "uCornerRadii",
        "uShadowRadius",
        "uShadowOffset",
        "uShadowColor",
        "uOriginalSize",
        "uOriginalCornerRadius",
        "uLayerScale",
        "uElementRotation",
        "uCornerStyle"
      ];
      for (const n of shNames) this.uSh[n] = gl.getUniformLocation(this.shadowProgram, n);
      const wpNames = ["uBackdrop", "uCanvasSize", "uWallpaperSize"];
      for (const n of wpNames) this.uWp[n] = gl.getUniformLocation(this.wallpaperProgram, n);
      const fgNames = [
        "uTexture",
        "uCanvasSize",
        "uOffset",
        "uSize",
        "uCornerRadii",
        "uAlpha",
        "uOriginalSize",
        "uOriginalCornerRadius",
        "uLayerScale",
        "uCornerStyle",
        "uUseContinuousSdf",
        "uContinuousSdf",
        "uContinuousSdfTexSize",
        "uContinuousSdfElementSize"
      ];
      for (const n of fgNames) this.uFg[n] = gl.getUniformLocation(this.foregroundProgram, n);
      const hlNames = [
        "uCanvasSize",
        "uOffset",
        "uSize",
        "uCornerRadii",
        "uColor",
        "uRadius",
        "uPosition",
        "uOriginalSize",
        "uOriginalCornerRadius",
        "uLayerScale",
        "uElementRotation",
        "uCornerStyle"
      ];
      for (const n of hlNames) this.uHl[n] = gl.getUniformLocation(this.highlightProgram, n);
      const tnNames = [
        "uCanvasSize",
        "uOffset",
        "uSize",
        "uCornerRadii",
        "uColor",
        "uOriginalSize",
        "uOriginalCornerRadius",
        "uLayerScale",
        "uElementRotation",
        "uCornerStyle"
      ];
      for (const n of tnNames) this.uTn[n] = gl.getUniformLocation(this.tintProgram, n);
      const rmNames = [
        "uCanvasSize",
        "uOffset",
        "uSize",
        "uCornerRadii",
        "uHighlightColor",
        "uHighlightAngle",
        "uHighlightFalloff",
        "uHighlightAlpha",
        "uHighlightMode",
        "uHighlightStrokeWidth",
        "uHighlightBlur",
        "uOriginalSize",
        "uOriginalCornerRadius",
        "uLayerScale",
        "uElementRotation",
        "uCornerStyle",
        "uUseContinuousSdf",
        "uContinuousSdf",
        "uContinuousSdfTexSize",
        "uContinuousSdfElementSize"
      ];
      for (const n of rmNames) this.uRm[n] = gl.getUniformLocation(this.rimHighlightProgram, n);
      const hsNames = [
        "uCanvasSize",
        "uOffset",
        "uSize",
        "uCornerRadii",
        "uHighlightStrokeWidth",
        "uOriginalSize",
        "uOriginalCornerRadius",
        "uLayerScale",
        "uElementRotation",
        "uCornerStyle",
        "uUseContinuousSdf",
        "uContinuousSdf",
        "uContinuousSdfTexSize",
        "uContinuousSdfElementSize"
      ];
      for (const n of hsNames) this.uHs[n] = gl.getUniformLocation(this.highlightStrokeProgram, n);
      const hcNames = [
        "uCanvasSize",
        "uOffset",
        "uSize",
        "uCornerRadii",
        "uBlurredMask",
        "uMaskTexSize",
        "uHighlightColor",
        "uHighlightAngle",
        "uHighlightFalloff",
        "uHighlightAlpha",
        "uHighlightMode",
        "uOriginalSize",
        "uOriginalCornerRadius",
        "uLayerScale",
        "uElementRotation",
        "uCornerStyle",
        "uUseContinuousSdf",
        "uContinuousSdf",
        "uContinuousSdfTexSize",
        "uContinuousSdfElementSize"
      ];
      for (const n of hcNames) this.uHc[n] = gl.getUniformLocation(this.highlightCompositeProgram, n);
      const smNames = [
        "uCanvasSize",
        "uOffset",
        "uSize",
        "uCornerRadii",
        "uStrokeMask",
        "uMaskOffset",
        "uMaskSize",
        "uHighlightColor",
        "uHighlightAngle",
        "uHighlightFalloff",
        "uHighlightAlpha",
        "uHighlightMode",
        "uOriginalSize",
        "uOriginalCornerRadius",
        "uLayerScale",
        "uElementRotation"
      ];
      for (const n of smNames) this.uSm[n] = gl.getUniformLocation(this.strokeMaskCompositeProgram, n);
      const isNames = [
        "uCanvasSize",
        "uOffset",
        "uSize",
        "uCornerRadii",
        "uInnerShadowMask",
        "uMaskOffset",
        "uMaskSize",
        "uInnerShadowColor",
        "uInnerShadowAlpha",
        "uOriginalSize",
        "uOriginalCornerRadius",
        "uLayerScale",
        "uElementRotation"
      ];
      for (const n of isNames) this.uIs[n] = gl.getUniformLocation(this.innerShadowMaskCompositeProgram, n);
      const prNames = [
        "uCanvasSize",
        "uOffset",
        "uSize",
        "uCornerRadii",
        "uColor",
        "uCornerStyle",
        "uUseContinuousSdf",
        "uContinuousSdf",
        "uContinuousSdfTexSize",
        "uContinuousSdfElementSize"
      ];
      for (const n of prNames) this.uPr[n] = gl.getUniformLocation(this.plainRectProgram, n);
      const pbNames = [
        "uBackdrop",
        "uCanvasSize",
        "uWallpaperSize",
        "uOffset",
        "uSize",
        "uBlurRadius",
        "uTintColor",
        "uTintIntensity"
      ];
      for (const n of pbNames) this.uPb[n] = gl.getUniformLocation(this.progressiveBlurProgram, n);
      const cpNames = ["uTexture", "uCanvasSize"];
      for (const n of cpNames) this.uCp[n] = gl.getUniformLocation(this.copyProgram, n);
      const sfNames = ["uColor"];
      for (const n of sfNames) this.uSf[n] = gl.getUniformLocation(this.solidFillProgram, n);
      const ccNames = ["uTexture", "uTexSize", "uBrightness", "uContrast", "uSaturation"];
      for (const n of ccNames) this.uCc[n] = gl.getUniformLocation(this.colorControlsProgram, n);
      const stNames = ["uTexture", "uCanvasSize", "uTintColor"];
      for (const n of stNames) this.uSt[n] = gl.getUniformLocation(this.sceneTintProgram, n);
      const efNames = ["uTexture", "uCanvasSize", "uElementCenter", "uElementSize", "uRotation", "uSrcSize"];
      for (const n of efNames) this.uEf[n] = gl.getUniformLocation(this.elFboCompositeProgram, n);
      const ecNames = ["uTexture", "uSrcOffset", "uSrcSize", "uDstSize"];
      for (const n of ecNames) this.uEc[n] = gl.getUniformLocation(this.elFboCropProgram, n);
    }
  };

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-blur.ts
  function compileBlurPair(gl, tapCount, genShader, errLabel) {
    const mk = (dir) => {
      const fs = compileShader(gl, gl.FRAGMENT_SHADER, genShader(tapCount, dir));
      const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
      const p = gl.createProgram();
      gl.attachShader(p, vs);
      gl.attachShader(p, fs);
      gl.bindAttribLocation(p, 0, "aPos");
      gl.linkProgram(p);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(p);
        gl.deleteProgram(p);
        throw new Error(errLabel + " (taps=" + tapCount + "," + dir + "): " + log);
      }
      return p;
    };
    const hProg = mk("horizontal");
    const vProg = mk("vertical");
    const uH = {
      uTexture: gl.getUniformLocation(hProg, "uTexture"),
      uTexSize: gl.getUniformLocation(hProg, "uTexSize"),
      uRadius: gl.getUniformLocation(hProg, "uRadius")
    };
    const uV = {
      uTexture: gl.getUniformLocation(vProg, "uTexture"),
      uTexSize: gl.getUniformLocation(vProg, "uTexSize"),
      uRadius: gl.getUniformLocation(vProg, "uRadius")
    };
    return { hProg, vProg, uH, uV, aPosH: 0, aPosV: 0 };
  }
  var blurMethods = {
    /** Lazy-compile horizontal + vertical blur programs for a 1D tap count. */
    ensureBlurPrograms(tapCount) {
      if (this.blurPrograms.has(tapCount)) return;
      this.blurPrograms.set(tapCount, compileBlurPair(this.gl, tapCount, generateSeparableBlurShader, "Blur program link error"));
    },
    /** Pick the downsampled blur FBO level for a given radius.
     *
     *  - dynamicBlurDownsample OFF: returns the MAX-ds level (legacy behavior —
     *    every blur renders into the smallest buffer, maximum speed, lowest
     *    quality for small radii).
     *  - dynamicBlurDownsample ON: picks usedDs = clamp(2^floor(log2(R/6)), 1,
     *    maxLevelDs). Small radii (R≈6px) → ds=1 (full-res, crisp); large radii
     *    (R≈48px+) → ds=maxLevelDs (fast). Falls back to max-ds if the pool is
     *    empty or radius is degenerate.
     *
     *  The returned level's fboA/fboB are sized floor(fboW/level.ds) ×
     *  floor(fboH/level.ds); callers scale radius by 1/level.ds. */
    pickDsBlurLevel(radius) {
      if (!this.dynamicBlurDownsample || this.dsBlurLevels.length === 0) {
        return {
          ds: this.effectiveBlurDownsample || 1,
          fboA: this.dsBlurFboA,
          texA: this.dsBlurFboATex,
          fboB: this.dsBlurFboB,
          texB: this.dsBlurFboBTex,
          w: this.dsBlurFboW || this.fboW,
          h: this.dsBlurFboH || this.fboH
        };
      }
      const levels = this.dsBlurLevels;
      const r = Math.max(0.5, radius);
      const maxDs = levels[levels.length - 1].ds;
      let usedDs = 1;
      if (r >= 6) {
        const exp = Math.floor(Math.log2(r / 6));
        usedDs = Math.pow(2, exp);
      }
      if (usedDs > maxDs) usedDs = maxDs;
      if (usedDs < 1) usedDs = 1;
      for (let i = levels.length - 1; i >= 0; i--) {
        if (levels[i].ds <= usedDs) return levels[i];
      }
      return levels[0];
    },
    /** Shared 2-pass H→V separable blur driver. Renders srcTex blurred by
     *  `radius` px (in the dst FBO's coordinate space — caller has already
     *  scaled to downsampled space if needed) into dstFboA then dstFboB;
     *  returns dstTexB. Saves/restores FBO binding + scissor (enable bit AND
     *  box — the old code only saved the enable bit, leaving the box clobbered).
     *  Disables scissor + blend during the passes (the downsampled FBO coords
     *  don't match the caller's full-res scissor rect — disabling is the fix
     *  for the old "only a small block is normal" downsample bug). */
    runBlurPasses(srcTex, dstFboA, dstTexA, dstFboB, dstTexB, w, h, radius, tapCount, glassMode) {
      const gl = this.gl;
      const tProg0 = performance.now();
      if (glassMode) {
        this.ensureBlurPrograms(tapCount);
      } else {
        this.ensureHighlightBlurPrograms(tapCount);
      }
      const entry = (glassMode ? this.blurPrograms : this.highlightBlurPrograms).get(tapCount);
      const tProg1 = performance.now();
      const tState0 = performance.now();
      const savedFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      const savedScissor = gl.isEnabled(gl.SCISSOR_TEST);
      const savedBox = gl.getParameter(gl.SCISSOR_BOX);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.BLEND);
      const tState1 = performance.now();
      const tH0 = performance.now();
      gl.bindFramebuffer(gl.FRAMEBUFFER, dstFboA);
      gl.viewport(0, 0, w, h);
      gl.useProgram(entry.hProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
      gl.enableVertexAttribArray(entry.aPosH);
      gl.vertexAttribPointer(entry.aPosH, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.uniform1i(entry.uH["uTexture"], 0);
      gl.uniform2f(entry.uH["uTexSize"], w, h);
      gl.uniform1f(entry.uH["uRadius"], radius);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      const tH1 = performance.now();
      const tV0 = performance.now();
      gl.bindFramebuffer(gl.FRAMEBUFFER, dstFboB);
      gl.viewport(0, 0, w, h);
      gl.useProgram(entry.vProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
      gl.enableVertexAttribArray(entry.aPosV);
      gl.vertexAttribPointer(entry.aPosV, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, dstTexA);
      gl.uniform1i(entry.uV["uTexture"], 0);
      gl.uniform2f(entry.uV["uTexSize"], w, h);
      gl.uniform1f(entry.uV["uRadius"], radius);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      const tV1 = performance.now();
      const tR0 = performance.now();
      gl.bindFramebuffer(gl.FRAMEBUFFER, savedFb);
      gl.viewport(0, 0, this.fboW, this.fboH);
      if (savedScissor) {
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(savedBox[0], savedBox[1], savedBox[2], savedBox[3]);
      }
      const tR1 = performance.now();
      if (this.lastBlurStats) {
        this.lastBlurStats.progMs = tProg1 - tProg0;
        this.lastBlurStats.stateMs = tState1 - tState0 + (tR1 - tR0);
        this.lastBlurStats.drawMs = tH1 - tH0 + (tV1 - tV0);
      }
      return dstTexB;
    },
    /** Blur a source texture by `radius` px. If bbox (srcX/Y/W/H) is given,
     *  crops srcTex to that region and blurs in a bbox-sized FBO (cheap —
     *  fragment work scales with bbox area, not fullscreen). If no bbox,
     *  blurs the full srcTex in the fullscreen dsBlur FBO (used by scene-wide
     *  blur where the "bbox" IS the full screen).
     *
     *  Dispatches to Kawase (2D diagonal) or Gaussian (separable H+V) based
     *  on useKawaseBlur. No 0.6 clamp: radius < 0.5 returns srcTex. */
    blurTexture(srcTex, radius, bbox) {
      if (bbox) {
        this.ensureElementFBO(bbox.w, bbox.h);
        return this.cropAndBlurBackdrop(srcTex, bbox.x, bbox.y, bbox.w, bbox.h, radius);
      }
      if (this.useKawaseBlur) return this.kawaseBlurTexture(srcTex, radius);
      const lvl = this.pickDsBlurLevel(radius);
      const ds = lvl.ds;
      const dsRadius = ds > 1 ? radius / ds : radius;
      if (dsRadius < 0.5) {
        this.lastBlurStats = { type: "gauss", passes: 0, taps: 0, maxSample: 0, w: lvl.w, h: lvl.h, progMs: 0, stateMs: 0, drawMs: 0 };
        return srcTex;
      }
      let taps = computeBlur1DTapCount(dsRadius);
      taps = Math.min(taps, Math.max(1, this.blurTapCap | 0));
      this.lastBlurStats = { type: "gauss", passes: 2, taps, maxSample: 3 * dsRadius, w: lvl.w, h: lvl.h, progMs: 0, stateMs: 0, drawMs: 0 };
      return this.runBlurPasses(
        srcTex,
        lvl.fboA,
        lvl.texA,
        lvl.fboB,
        lvl.texB,
        lvl.w,
        lvl.h,
        dsRadius,
        taps,
        true
      );
    },
    /** Lazy-compile the Kawase blur program (single 2D program, not H+V pair).
     *  Kawase is NOT separable — one pass per iteration samples 4 diagonal
     *  points. One program serves all iterations via uIteration/uTotalIters. */
    ensureKawaseProgram() {
      if (this.kawasePrograms) return;
      const gl = this.gl;
      const fs = compileShader(gl, gl.FRAGMENT_SHADER, generateKawaseBlurShader());
      const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
      const p = gl.createProgram();
      gl.attachShader(p, vs);
      gl.attachShader(p, fs);
      gl.bindAttribLocation(p, 0, "aPos");
      gl.linkProgram(p);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(p);
        gl.deleteProgram(p);
        throw new Error("Kawase program link error: " + log);
      }
      this.kawasePrograms = {
        prog: p,
        uTexture: gl.getUniformLocation(p, "uTexture"),
        uTexSize: gl.getUniformLocation(p, "uTexSize"),
        uRadius: gl.getUniformLocation(p, "uRadius"),
        uIteration: gl.getUniformLocation(p, "uIteration"),
        uTotalIters: gl.getUniformLocation(p, "uTotalIters"),
        aPos: 0
      };
    },
    /** Kawase blur: N iterations of 2D 4-tap diagonal, ping-pong between
     *  fboA and fboB. Each iter is ONE pass (not H+V — Kawase is not separable).
     *  Iter 0: srcTex → fboA. Iter 1: texA → fboB. Iter 2: texB → fboA. ...
     *  Result ends in the buffer that the last iter wrote to.
     *
     *  radius < 0.5 → return srcTex (no blur). */
    kawaseBlurTexture(srcTex, radius) {
      const lvl = this.pickDsBlurLevel(radius);
      const ds = lvl.ds;
      const dsRadius = ds > 1 ? radius / ds : radius;
      if (dsRadius < 0.5) {
        this.lastBlurStats = { type: "kawase", passes: 0, taps: 0, maxSample: 0, w: lvl.w, h: lvl.h, progMs: 0, stateMs: 0, drawMs: 0 };
        return srcTex;
      }
      const iters = kawaseIterationsForRadius(dsRadius, this.kawaseQuality);
      const dMax = dsRadius * Math.sqrt(6 * iters / ((iters + 1) * (2 * iters + 1)));
      this.lastBlurStats = { type: "kawase", passes: iters, taps: 4 * iters, maxSample: dMax * Math.SQRT2, w: lvl.w, h: lvl.h, progMs: 0, stateMs: 0, drawMs: 0 };
      const tProg0 = performance.now();
      this.ensureKawaseProgram();
      const kp = this.kawasePrograms;
      const tProg1 = performance.now();
      const tState0 = performance.now();
      const gl = this.gl;
      const w = lvl.w, h = lvl.h;
      const savedFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      const savedScissor = gl.isEnabled(gl.SCISSOR_TEST);
      const savedBox = gl.getParameter(gl.SCISSOR_BOX);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.BLEND);
      const tState1 = performance.now();
      const tDraw0 = performance.now();
      let curSrc = srcTex;
      for (let i = 0; i < iters; i++) {
        const writeFboA = i % 2 === 0;
        const dstFbo = writeFboA ? lvl.fboA : lvl.fboB;
        gl.bindFramebuffer(gl.FRAMEBUFFER, dstFbo);
        gl.viewport(0, 0, w, h);
        gl.useProgram(kp.prog);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
        gl.enableVertexAttribArray(kp.aPos);
        gl.vertexAttribPointer(kp.aPos, 2, gl.FLOAT, false, 0, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, curSrc);
        gl.uniform1i(kp.uTexture, 0);
        gl.uniform2f(kp.uTexSize, w, h);
        gl.uniform1f(kp.uRadius, dsRadius);
        gl.uniform1f(kp.uIteration, i);
        gl.uniform1f(kp.uTotalIters, iters);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        curSrc = writeFboA ? lvl.texA : lvl.texB;
      }
      const tDraw1 = performance.now();
      const tR0 = performance.now();
      gl.bindFramebuffer(gl.FRAMEBUFFER, savedFb);
      gl.viewport(0, 0, this.fboW, this.fboH);
      if (savedScissor) {
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(savedBox[0], savedBox[1], savedBox[2], savedBox[3]);
      }
      const tR1 = performance.now();
      this.lastBlurStats.progMs = tProg1 - tProg0;
      this.lastBlurStats.stateMs = tState1 - tState0 + (tR1 - tR0);
      this.lastBlurStats.drawMs = tDraw1 - tDraw0;
      const lastWroteA = (iters - 1) % 2 === 0;
      return lastWroteA ? lvl.texA : lvl.texB;
    },
    /** Lazy-compile highlight blur programs (alpha-blurring, sigma semantics).
     *  Separate from ensureBlurPrograms because the shader is different
     *  (blurs alpha, no early-return, integer-σ-spaced taps). */
    ensureHighlightBlurPrograms(tapCount) {
      if (this.highlightBlurPrograms.has(tapCount)) return;
      this.highlightBlurPrograms.set(tapCount, compileBlurPair(this.gl, tapCount, generateHighlightBlurShader, "Highlight blur program link error"));
    },
    /** 2-pass Gaussian blur on a highlight stroke MASK (alpha only).
     *  Faithful to Android BlurMaskFilter(NORMAL, sigma):
     *    - sigma = blurRadiusPx (the Android radius param IS sigma)
     *    - convolves the mask's ALPHA with a Gaussian kernel
     *    - sub-pixel sigma (0.25px) still blurs (no 0.5 early-return)
     *  No 0.05 clamp: sigma < 0.01 returns srcTex (no blur). */
    blurHighlightMask(srcTex, sigmaPx) {
      const lvl = this.pickDsBlurLevel(sigmaPx);
      const ds = lvl.ds;
      const dsSigma = ds > 1 ? sigmaPx / ds : sigmaPx;
      if (dsSigma < 0.01) return srcTex;
      let taps = computeHighlightBlurTapCount(dsSigma);
      taps = Math.min(taps, Math.max(3, this.blurTapCap | 0));
      return this.runBlurPasses(
        srcTex,
        lvl.fboA,
        lvl.texA,
        lvl.fboB,
        lvl.texB,
        lvl.w,
        lvl.h,
        dsSigma,
        taps,
        false
      );
    }
  };

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-dispose.ts
  var disposeMethods = {
    dispose() {
      if (this.rafId !== null) cancelAnimationFrame(this.rafId);
      this.rafId = null;
      if (this.animRafId !== null) cancelAnimationFrame(this.animRafId);
      this.animRafId = null;
      const gl = this.gl;
      if (this.wallpaperTexture) gl.deleteTexture(this.wallpaperTexture);
      for (const tex of this.fgTextures.values()) gl.deleteTexture(tex);
      this.fgTextures.clear();
      for (const entry of this.strokeMaskCache.values()) gl.deleteTexture(entry.tex);
      this.strokeMaskCache.clear();
      destroyCache(gl, this.innerShadowMaskCache);
      if (this.fboA) gl.deleteFramebuffer(this.fboA);
      if (this.fboATex) gl.deleteTexture(this.fboATex);
      if (this.fboB) gl.deleteFramebuffer(this.fboB);
      if (this.fboBTex) gl.deleteTexture(this.fboBTex);
      this.fboA = this.fboB = null;
      this.fboATex = this.fboBTex = null;
      if (this.tabsBackdropFbo) gl.deleteFramebuffer(this.tabsBackdropFbo);
      if (this.tabsBackdropTex) gl.deleteTexture(this.tabsBackdropTex);
      this.tabsBackdropFbo = null;
      this.tabsBackdropTex = null;
      if (this.wallpaperBlurFbo) gl.deleteFramebuffer(this.wallpaperBlurFbo);
      if (this.wallpaperBlurTex) gl.deleteTexture(this.wallpaperBlurTex);
      if (this.blurFboA) gl.deleteFramebuffer(this.blurFboA);
      if (this.blurFboATex) gl.deleteTexture(this.blurFboATex);
      if (this.blurFboB) gl.deleteFramebuffer(this.blurFboB);
      if (this.blurFboBTex) gl.deleteTexture(this.blurFboBTex);
      if (this.dsBlurFboA) gl.deleteFramebuffer(this.dsBlurFboA);
      if (this.dsBlurFboATex) gl.deleteTexture(this.dsBlurFboATex);
      if (this.dsBlurFboB) gl.deleteFramebuffer(this.dsBlurFboB);
      if (this.dsBlurFboBTex) gl.deleteTexture(this.dsBlurFboBTex);
      for (const lvl of this.dsBlurLevels) {
        gl.deleteFramebuffer(lvl.fboA);
        gl.deleteTexture(lvl.texA);
        gl.deleteFramebuffer(lvl.fboB);
        gl.deleteTexture(lvl.texB);
      }
      this.dsBlurLevels = [];
      this.wallpaperBlurFbo = this.blurFboA = this.blurFboB = this.dsBlurFboA = this.dsBlurFboB = null;
      this.wallpaperBlurTex = this.blurFboATex = this.blurFboBTex = this.dsBlurFboATex = this.dsBlurFboBTex = null;
      if (this.highlightMaskFbo) gl.deleteFramebuffer(this.highlightMaskFbo);
      if (this.highlightMaskTex) gl.deleteTexture(this.highlightMaskTex);
      this.highlightMaskFbo = null;
      this.highlightMaskTex = null;
      if (this.dialogBackdropFbo) gl.deleteFramebuffer(this.dialogBackdropFbo);
      if (this.dialogBackdropTex) gl.deleteTexture(this.dialogBackdropTex);
      this.dialogBackdropFbo = null;
      this.dialogBackdropTex = null;
      this.dialogBackdropKey = null;
      if (this.bgOnlyFbo) gl.deleteFramebuffer(this.bgOnlyFbo);
      if (this.bgOnlyTex) gl.deleteTexture(this.bgOnlyTex);
      this.bgOnlyFbo = null;
      this.bgOnlyTex = null;
      if (this.elFbo) gl.deleteFramebuffer(this.elFbo);
      if (this.elFboTex) gl.deleteTexture(this.elFboTex);
      this.elFbo = null;
      this.elFboTex = null;
      this.elFboW = this.elFboH = 0;
      if (this.backdropCropFbo) gl.deleteFramebuffer(this.backdropCropFbo);
      if (this.backdropCropTex) gl.deleteTexture(this.backdropCropTex);
      this.backdropCropFbo = null;
      this.backdropCropTex = null;
      if (this.elBlurFboA) gl.deleteFramebuffer(this.elBlurFboA);
      if (this.elBlurFboATex) gl.deleteTexture(this.elBlurFboATex);
      if (this.elBlurFboB) gl.deleteFramebuffer(this.elBlurFboB);
      if (this.elBlurFboBTex) gl.deleteTexture(this.elBlurFboBTex);
      this.elBlurFboA = this.elBlurFboB = null;
      this.elBlurFboATex = this.elBlurFboBTex = null;
      for (const e of this.elFboCache.values()) {
        gl.deleteFramebuffer(e.fb);
        gl.deleteTexture(e.tex);
      }
      this.elFboCache.clear();
      for (const { hProg, vProg } of this.blurPrograms.values()) {
        gl.deleteProgram(hProg);
        gl.deleteProgram(vProg);
      }
      this.blurPrograms.clear();
      for (const { hProg, vProg } of this.highlightBlurPrograms.values()) {
        gl.deleteProgram(hProg);
        gl.deleteProgram(vProg);
      }
      this.highlightBlurPrograms.clear();
      if (this.kawasePrograms) {
        gl.deleteProgram(this.kawasePrograms.prog);
        this.kawasePrograms = null;
      }
      for (const entry of this.backdropBlurCache.values()) {
        gl.deleteTexture(entry.tex);
        gl.deleteFramebuffer(entry.fb);
      }
      this.backdropBlurCache.clear();
      for (const p of this.backdropBlurCacheFboPool) {
        gl.deleteTexture(p.tex);
        gl.deleteFramebuffer(p.fb);
      }
      this.backdropBlurCacheFboPool.length = 0;
      if (this.cacheCopyReadFbo) {
        gl.deleteFramebuffer(this.cacheCopyReadFbo);
        this.cacheCopyReadFbo = null;
      }
      if (this.sdfTexture) gl.deleteTexture(this.sdfTexture);
      this.sdfTexture = null;
      if (this.textSdfTexture) gl.deleteTexture(this.textSdfTexture);
      this.textSdfTexture = null;
      for (const { tex } of this.continuousSdfPool.values()) gl.deleteTexture(tex);
      this.continuousSdfPool.clear();
      this.continuousSdfTexture = null;
      this.continuousSdfKey = null;
      this._debugUploadedSdfTexMap.clear();
      gl.deleteProgram(this.elementProgram);
      gl.deleteProgram(this.shadowProgram);
      gl.deleteProgram(this.wallpaperProgram);
      gl.deleteProgram(this.foregroundProgram);
      gl.deleteProgram(this.highlightProgram);
      gl.deleteProgram(this.tintProgram);
      gl.deleteProgram(this.rimHighlightProgram);
      gl.deleteProgram(this.highlightStrokeProgram);
      gl.deleteProgram(this.highlightCompositeProgram);
      gl.deleteProgram(this.strokeMaskCompositeProgram);
      gl.deleteProgram(this.innerShadowMaskCompositeProgram);
      gl.deleteProgram(this.plainRectProgram);
      gl.deleteProgram(this.progressiveBlurProgram);
      gl.deleteProgram(this.copyProgram);
      gl.deleteProgram(this.solidFillProgram);
      gl.deleteProgram(this.colorControlsProgram);
      gl.deleteProgram(this.sceneTintProgram);
      gl.deleteProgram(this.elFboCompositeProgram);
      gl.deleteProgram(this.elFboCropProgram);
      gl.deleteBuffer(this.quadBuffer);
    }
  };

  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/index.ts
  var LiquidGlassRenderer = class {
    constructor(canvas) {
      this.wallpaperTexture = null;
      this.wallpaperReady = false;
      this.wallpaperSize = [1, 1];
      this.dpr = 0;
      // 0 = not yet set; resize() sets default cap on first call
      this.buttonConfigs = [];
      this.buttonStates = /* @__PURE__ */ new Map();
      /** Toggle group state — keyed by groupId. Faithful port of DampedDragAnimation.kt. */
      this.toggleStates = /* @__PURE__ */ new Map();
      this.scrollY = 0;
      this.scrollVelocity = 0;
      this.contentHeight = 0;
      this.cssWidth = 0;
      this.cssHeight = 0;
      this.wheelTarget = null;
      this.backgroundColor = null;
      /** PERFORMANCE: Dirty flag — set by any state change that requires a redraw.
       *  render() checks this and early-exits if false, avoiding redundant
       *  full-scene re-render when requestAnimationFrame fires but nothing changed. */
      this.needsRedraw = true;
      /** Event-driven per-element dirty tracking. Instead of hashing every
       *  element's visual state each frame, dirty status is marked at the source:
       *  setters (setPressed, setInteractiveValue, setScrollY, ...) and the spring
       *  animation tick call markElementDirty(id) / markAllDirty(). The render loop
       *  reads this set to count dirty elements (for the perf monitor) and to draw
       *  debug markers, then clears it. When nothing is dirty AND needsRedraw is
       *  false, no render happens at all (the rAF doesn't fire).
       *
       *  allDirty: set by global changes (wallpaper loaded, quickToggles flipped,
       *  element list rebuilt). Makes every element count as dirty for one frame. */
      this.dirtyElementIds = /* @__PURE__ */ new Set();
      this.allDirty = true;
      /** Debug overlay: when true, draw a colored border (green=clean, red=dirty)
       *  + a blinking red dot on dirty elements. The dot flashes ~30Hz and the
       *  whole overlay disappears when idle. Toggled from the perf-monitor
       *  overlay. */
      this.showDirtyMarkers = false;
      /** Debug overlay data — the dirty status of each element this frame,
       *  pushed during render() for the overlay to read. "dirty" here means
       *  "this element actually re-rasterized its glass body this frame"
       *  (cache MISS), NOT merely "was event-marked dirty". With the event-
       *  driven + signature-diff cache scheme, an element can be re-rasterized
       *  without being in dirtyElementIds (e.g. position changed → elFboCache
       *  position check misses → re-rasterize). The marker reflects the TRUE
       *  GPU work, which is what the user wants to see during optimization.
       *
       *  LIFECYCLE: cleared at the start of each render(), repopulated during
       *  the element loop, then CONSUMED (length=0) by the overlay's rAF after
       *  drawing. This means the list is non-empty only on rAF ticks that
       *  immediately follow a render — idle frames see an empty list and draw
       *  nothing, which is how the "no stale red when idle" behavior works. */
      this.debugDirtyMarkers = [];
      /** Internal scratch slot — set by renderGlassElementPerFbo to indicate
       *  whether the just-rendered glass element hit its elFboCache (true =
       *  cached, no glass-body re-raster). Read by the render() main loop to
       *  populate debugDirtyMarkers. Only valid between renderGlassElement()
       *  return and the next element's render. */
      this._dbgLastGlassCacheHit = false;
      /** Frame-local list of screen-space rects (CSS px, top-left origin) whose
       *  curFbo pixels changed this frame. Any element that actually re-rasterizes
       *  (glass cache MISS, dirty non-glass redraw, ping-pong path) pushes its
       *  inflated output rect here. Non-independent glass elements check this list
       *  in their elFboCache hit test — if no dirty rect overlaps the element's
       *  backdrop sampling region, the cached glass body is still valid and can be
       *  composited without re-rasterizing the backdrop blur. This is SPATIAL, not
       *  global: a tab bar animating on the left does NOT invalidate a static bar
       *  on the right, because their rects don't overlap.
       *
       *  Each entry carries a `source` tag identifying WHO pushed it:
       *    'all_dirty'      — markAllDirty() fired (global invalidation)
       *    'scroll'         — scrollY changed (scrolling elements moved)
       *    'glass:<id>'     — glass element <id> cache-missed (re-rasterized)
       *    'nonglass:<id>'  — non-glass element <id> was event-dirty
       *    'pingpong:<id>'  — glass element <id> on ping-pong path (PEF off)
       *  This source is surfaced in the debugCacheMissLog reason as
       *  `backdrop_overlap:<source>` so you can see EXACTLY which element or
       *  global event caused a non-independent element to miss its cache. */
      this.dirtyRectsThisFrame = [];
      /** Last frame's scrollY — when it changes, scrolling elements move and every
       *  non-independent element whose backdrop overlaps them must re-rasterize.
       *  Represented by pushing a full-screen rect into dirtyRectsThisFrame. */
      this.lastRenderedScrollY = 0;
      /** Debug trace: per-element cache MISS reason, populated during render when
       *  showDirtyMarkers is on. Each entry = { id, reason, x, y } so the overlay
       *  can draw the reason text next to the element's bbox. Reasons:
       *    'no_entry'           — first render, cache not yet populated
       *    'size_mismatch'      — w/h changed (scroll/scale moved elFboRect)
       *    'position_mismatch'  — ex0/ey0Top changed (element moved)
       *    'invalidated'        — entry.valid=false (markElementDirty/markAllDirty)
       *    'wallpaper_version'  — wallpaper reloaded
       *    'dpr'                — devicePixelRatio changed
       *    'backdrop_overlap:<source>' — a dirtyRect overlaps this element's
       *      backdrop. <source> identifies WHO pushed the overlapping rect:
       *      all_dirty / scroll / glass:<id> / nonglass:<id> / pingpong:<id>
       *    'non_cacheable'      — cacheable=false (no wallpaper / backdropFbo / SDF)
       *    'ping_pong'          — PEF toggle off, ping-pong path (never cached) */
      this.debugCacheMissLog = [];
      /** Debug trace: who called markElementDirty, populated when showDirtyMarkers
       *  is on. Each entry = { id, source } where source is the caller's caller
       *  function name (best-effort via stack parse). Helps answer "why is this
       *  element dirty every frame when nothing changed?" */
      this.debugDirtySourceLog = [];
      // --- Scene FBO ping-pong infrastructure ---
      // See render() for the full ping-pong pipeline description.
      this.fboA = null;
      this.fboATex = null;
      this.fboB = null;
      this.fboBTex = null;
      this.fboW = 0;
      this.fboH = 0;
      // --- tabsBackdrop FBO (indicator's hidden tinted layer) ---
      // Faithful to LiquidBottomTabs.kt: the indicator's backdrop is
      //   rememberCombinedBackdrop(backdrop, tabsBackdrop)
      // where tabsBackdrop is a HIDDEN Row (alpha=0) that captures the container
      // glass + tab content with ColorFilter.tint(accentColor). We render the
      // current scene (container+tabs already drawn) into this FBO, apply a blue
      // tint pass, then the indicator shader samples it as the second backdrop
      // layer (composited over wallpaper).
      this.tabsBackdropFbo = null;
      this.tabsBackdropTex = null;
      this.tabsBackdropDirty = true;
      // --- Separable 2-pass blur infrastructure (Glass Playground only) ---
      // wallpaperBlurFbo: element pass renders here (refraction on CLEAR backdrop,
      // uBlurRadius=0) for useSeparableBlur elements. Transparent background;
      // the element shader's discard leaves only the glass shape's refracted content.
      // blurFboA/blurFboB: FULL-RES scratch ping-pong. Used by the dialog backdrop
      //   colorControls pass (methods-render.ts) which needs a full-res temp buffer
      //   (bindFBO + drawColorControls both assume fboW×fboH). NOT used by
      //   blurTexture — must stay full-res to avoid the downsample viewport
      //   mismatch that broke dialog backdrops (only a small corner was written,
      //   the rest stayed transparent).
      // dsBlurFboA/dsBlurFboB: LEGACY downsampled ping-pong pair, sized
      //   floor(fboW/effectiveDs) × floor(fboH/effectiveDs) (RAW ds, NOT pow2-
      //   clamped). Used by the OFF path of blurTexture/blurHighlightMask (and as
      //   the empty-pool fallback) so OFF matches the pre-dynamic OLD behavior
      //   exactly. The ON path uses the dsBlurLevels pool instead. Half-res pixels
      //   are ds× wider, so radius is scaled by 1/ds to preserve the visual blur
      //   radius while cutting fragment invocations by ds².
      this.wallpaperBlurFbo = null;
      this.wallpaperBlurTex = null;
      this.blurFboA = null;
      this.blurFboATex = null;
      this.blurFboB = null;
      this.blurFboBTex = null;
      this.dsBlurFboA = null;
      this.dsBlurFboATex = null;
      this.dsBlurFboB = null;
      this.dsBlurFboBTex = null;
      // --- Highlight mask FBO (3-pass faithful highlight) ---
      // Pass 1: HIGHLIGHT_STROKE_FRAGMENT_SHADER renders the clipped stroke alpha
      //   mask here (transparent surround, alpha=1 in the stroke band).
      // Pass 2: blurHighlightMask(highlightMaskTex, sigma) → dsBlurFboB (2-pass
      //   Gaussian, faithful to Skia BlurMaskFilter NORMAL).
      // Pass 3: HIGHLIGHT_COMPOSITE_FRAGMENT_SHADER samples dsBlurFboB, multiplies
      //   by intensity+color, blends into the scene FBO.
      this.highlightMaskFbo = null;
      this.highlightMaskTex = null;
      // --- Dialog backdrop FBO ---
      // Holds wallpaper+scrim+colorControls as one opaque layer for the dialog
      // card's 2-pass blur path. Rendered by renderDialogBackdrop; the dialog card
      // (backdropFbo=true + useSeparableBlur) samples this via 2-pass blur.
      this.dialogBackdropFbo = null;
      this.dialogBackdropTex = null;
      /** Cache key for dialogBackdropFbo (scrim+cc params) — skip re-render if unchanged. */
      this.dialogBackdropKey = null;
      /** "Background-only" FBO — a parallel scene buffer that contains ONLY
       *  wallpaper + non-glass elements (never glass). When the
       *  `isolateBackdrop` quick-toggle is on, glass elements sample THIS
       *  texture instead of curTex, so they don't refract other glass — only
       *  the wallpaper + non-glass UI behind them. Lazily created in
       *  renderGlassElement when isolateBackdrop is first enabled; resized
       *  with the main FBOs. */
      this.bgOnlyFbo = null;
      this.bgOnlyTex = null;
      /** Blur shader variants keyed by 1D tap count (H + V programs each). */
      this.blurPrograms = /* @__PURE__ */ new Map();
      /** Highlight blur programs — separate from blurPrograms because these blur
       *  ALPHA (mask), use Android BlurMaskFilter sigma semantics (uRadius=sigma),
       *  and support sub-pixel sigma (no 0.5 early-return). */
      this.highlightBlurPrograms = /* @__PURE__ */ new Map();
      /** Kawase blur program (single 2D program — not separable, no H+V pair).
       *  One program serves all iterations via uIteration/uTotalIters uniforms.
       *  Lazily compiled by ensureKawaseProgram. Used when useKawaseBlur is on. */
      this.kawasePrograms = null;
      /** Use Kawase blur (4-tap tent-filter, N iterations) instead of the
       *  Gaussian separable path. Kawase is cheaper for large radii. Set from
       *  CatalogState.useKawaseBlur via use-renderer-prop-sync. Default true. */
      this.useKawaseBlur = true;
      /** Blur cache toggle. When true (default), resolveBackdropTex caches
       *  blurred backdrop textures (per-radius for wallpaper, per-element+radius
       *  for scene) so repeated frames at the same radius hit the cache (0 blur
       *  cost). When false, the cache lookup + store are skipped — every frame
       *  re-blurs from scratch. Toggling off also clears the existing cache. */
      this.useBlurCache = true;
      /** Kawase quality multiplier [0, 1], default 1.0 (full base iter count).
       *  Scales the iteration count (from kawaseIterationsForRadius) before
       *  clamping to [2, 8]. 0 = min iters (fastest), 1 = base iter count.
       *  Set from CatalogState.kawaseQuality. */
      this.kawaseQuality = 1;
      /** Gravity angle for glass highlight direction, in RADIANS. Updated live via
       *  setGravityAngle (no catalog rebuild). Default 45° = 0.785 rad.
       *  Elements with useGravityAngle=true read this at render time. */
      this.gravityAngle = 45 * Math.PI / 180;
      /** Max 1D taps per blur pass (1..33). Lower = faster, Higher = better quality.
       *  Set from CatalogState.blurTapCap. Default 9. */
      this.blurTapCap = 9;
      /** Blur downsample factor (float, slider range 1–8). Higher = much faster
       *  but lower quality. Set from CatalogState.blurDownsample. The downsampled
       *  blur FBOs (dsBlurFboA/dsBlurFboB) are sized floor(fboW/effectiveDs) ×
       *  floor(fboH/effectiveDs) where effectiveDs = blurDownsample × dpr. */
      this.blurDownsample = 4;
      /** Actual device-px size of dsBlurFboA/dsBlurFboB (= floor(fboW/effectiveBlurDownsample)).
       *  Set by resizeFBOs. blurTexture/blurHighlightMask viewport + uTexSize use
       *  THIS (not fboW/fboH) so the blur renders into the downsampled FBO. */
      this.dsBlurFboW = 0;
      this.dsBlurFboH = 0;
      /** DPR-adapted effective downsample factor = blurDownsample × dpr, clamped
       *  to [1, 64]. Set by resizeFBOs. blurTexture/blurHighlightMask use THIS
       *  (not the raw blurDownsample) to scale radius — otherwise radius/ds and
       *  the blur FBO size (which uses effectiveDs) mismatch → wrong visual radius.
       *
       *  Why adapt to DPR: blurDownsample (slider, range 1–8) is the user's
       *  quality choice relative to CSS (display) pixels. On a DPR=2 device,
       *  fboW = CSS×2, so raw ds=1 would produce blurFbo = CSS (already full
       *  display res — no actual quality loss). To make the same slider position
       *  produce the same VISUAL quality across devices, the blur FBO must be
       *  sized relative to CSS pixels: effectiveDs = rawDs × dpr →
       *  blurFbo = fboW / (rawDs×dpr) = CSS / rawDs. Now ds=4 always gives
       *  blurFbo = CSS/4 regardless of DPR.
       *
       *  Max clamp 64: prevents absurdly tiny FBOs at extreme slider (8) ×
       *  high DPR (8+) = 64. No min clamp — the slider min (1, full-res) is the
       *  floor and DPR ≥ 1 so effectiveDs ≥ 1 always. */
      this.effectiveBlurDownsample = 4;
      /** Dynamic blur downsample toggle (Settings). When ON, blurTexture/
       *  blurHighlightMask pick the downsample factor PER CALL based on the blur
       *  radius: small radii use a low-ds (high-quality) buffer, large radii use a
       *  high-ds (fast) buffer. This keeps small-radius glass crisp (no half-res
       *  pixelation) while still cutting fragment invocations on big blurs.
       *
       *  Implementation: a small pool of dsBlurFboA/B pairs at power-of-two ds
       *  levels {1, 2, 4, ..., largestPow2 ≤ effectiveBlurDownsample} is created in
       *  resizeFBOs. pickDsBlurLevel(radius) selects the level:
       *    usedDs = clamp(2^floor(log2(radius / 6)), 1, maxLevelDs)
       *  so radius=6px → ds=1, 12px → ds=2, 24px → ds=4, 48px → ds=8.
       *
       *  When OFF (default), the legacy behavior is used: every blur call renders
       *  into the SINGLE legacy dsBlurFboA/B pair with ds = effectiveBlurDownsample
       *  (RAW value, including non-pow2 like 6/12 — matches OLD exactly, so OFF
       *  never silently rounds the ds up to a pow2). */
      this.dynamicBlurDownsample = false;
      /** Pool of downsampled blur FBO pairs at power-of-two ds levels, populated
       *  by resizeFBOs. Index 0 is always ds=1 (full-res, largest), last index is
       *  the max pow2 ds (≤ effectiveBlurDownsample, smallest). blurTexture/
       *  blurHighlightMask pick from this pool ONLY when dynamicBlurDownsample is
       *  ON. When OFF, they bypass the pool and use the separate legacy
       *  dsBlurFboA/B pair below (sized at RAW effectiveDs, not pow2-clamped) so
       *  the buffer resolution + radius scaling match the pre-dynamic OLD path. */
      this.dsBlurLevels = [];
      /** Corner style: 0 = circular, 1 = continuous (squircle). Set from
       *  CatalogState.capsuleShape. Default 1 (Continuous, matching original). */
      this.cornerStyle = 1;
      /** Capsule SDF texture quality coefficient [0.25, 1.0]. Scales the base
       *  texSize (2× oversampling rounded up to POT, clamped [128,1024]) by this
       *  factor, then Math.ceil'd. Default 0.5 (halves texSize). When this
       *  changes, context.tsx clears the GPU pool + CPU maskCache + marks all
       *  elFbos dirty so new textures are generated at the new resolution.
       *  See generateContinuousCurvatureMask + loadContinuousSdf. */
      this.capsuleSdfQuality = 0.5;
      /** "Disable smooth-corner SDF" toggle (Settings) — controls ONLY the G
       *  channel (refraction SDF), NOT the R channel (clip/edgeAA coverage).
       *  When true (default): generate an R-only texture — skip the G-channel
       *  chamfer distance transform (forward + backward passes, the most
       *  CPU-expensive part of generateContinuousCurvatureMask). The texture is
       *  still generated, uploaded, and bound; uUseContinuousSdf=1.0 so
       *  sampleClipMask (clip + edgeAA, reads R) still gets pixel-perfect G2
       *  Bezier corners. The shader's uNoContinuousSdfInRefraction=1 forces
       *  sdShape (refraction/lens, reads G) to use analytic sdRoundedRect, so the
       *  skipped G is never sampled. Saves ~half the per-element SDF generation
       *  CPU on large elements (512²/1024²) while keeping capsule-shape corners.
       *  When false: full R+G texture; sdShape samples G for G2 curvature in the
       *  refraction/lens body (when capsuleShape is ON). loadContinuousSdf reads
       *  this flag to pass skipSdf to generateContinuousCurvatureMask + include
       *  it in the pool key. The GPU texture pool + CPU mask cache are cleared by
       *  context.tsx when the toggle flips (either direction) since the skipSdf
       *  flag changes the cache key. */
      this.noContinuousSdf = true;
      /** "Direct backdrop sample" toggle (Settings, default true). When true,
       *  glass elements that use the LayerBackdrop semantic in the original
       *  Android source (buttons, glass shapes, back/theme buttons — i.e. those
       *  with `independentBackdrop` set, OR eligible elements when this flag is
       *  on) sample the CLEAN wallpaper directly instead of the accumulated scene
       *  (curTex). computeElementTransform ORs this flag into the `independent`
       *  computation so toggling is live (no catalog rebuild needed).
       *
       *  Benefits: elFbo cache HIT every frame on static pages (the
       *  backdrop_overlap cache-miss check is skipped for independent elements),
       *  no invalidation cascade when one glass element moves, lower GPU/CPU
       *  usage. Matches the original where LayerBackdrop = wallpaper via
       *  RenderEffect (glass elements don't refract each other).
       *
       *  Elements with their own backdrop semantics are NOT affected:
       *    - CombinedBackdrop (toggle/slider knob, bottom-tab indicator) — they
       *      have shouldUseSeparableBlur()=false and sample wallpaper+track inline.
       *    - sampleWallpaper elements (dialog card, magnifier) — explicit flag.
       *    - backdropFbo elements — use their own dialogBackdropTex.
       *  On solid-background pages (Home/Settings/About), `independent` is forced
       *  false anyway (no wallpaper to sample), so this flag is a no-op there. */
      this.directBackdropSample = true;
      /** Per-element FBO optimization toggle (Settings). When true, each glass
       *  element renders into a small bbox-sized FBO instead of a fullscreen
       *  ping-pong blit. See methods-render-glass.ts.
       *  NOTE: this field is seeded from CatalogState.usePerElementFbo and also
       *  mirrored into quickToggles.perElementFbo (the live runtime gate) by
       *  context.tsx. The render path checks quickToggles.perElementFbo, not
       *  this field, so the perf-monitor toggle can override it live. */
      this.usePerElementFbo = false;
      /** Quick power-saving toggles — exposed live via the performance monitor
       *  overlay (NOT persisted to settings). Each flag gates a specific heavy
       *  GPU path so the user can isolate cost during a power-consumption
       *  investigation. When a flag is `false`, that path is skipped entirely
       *  for every element on the next frame (requestRender is called by the
       *  overlay when a flag flips so needsRedraw is set).
       *
       *  - highlight:     skip the Canvas2D mask + 3-pass highlight composite
       *                   (rim/stroke/blur). This is one of the most expensive
       *                   per-element paths due to per-frame Canvas2D rasterization.
       *  - backdropBlur:  skip the 2-pass separable Gaussian on the backdrop
       *                   (useSeparableBlur elements with blurRadius >= 0.5).
       *                   Saves 2 fullscreen-equivalent blur passes per element.
       *  - chromatic:     force uChromaticAberration=0 in the element pass
       *                   (removes the extra RGB-channel texture samples).
       *  - refraction:    force uRefractionHeight=0 and uRefractionAmount=0
       *                   (the lens distortion offset disappears, glass becomes
       *                   a flat tinted layer — much cheaper shader math).
       *  - outerShadow:   skip the outer drop-shadow pass entirely.
       *  - innershadow:   skip the inner shadow pass (Canvas2D ring-mask
       *                   generation + composite). The mask is cached, but the
       *                   composite draw still costs a fullscreen-equivalent pass.
       *  - perElementFbo: sole runtime gate for the per-element FBO path.
       *                   Seeded from CatalogState.usePerElementFbo (settings)
       *                   via context.tsx on mount + when settings changes.
       *                   The perf-monitor toggle can override it live — when
       *                   false, all glass elements fall back to the legacy
       *                   fullscreen ping-pong blit. Default false (matches the
       *                   settings default).
       *
       *  All flags default to `true` (full quality) EXCEPT perElementFbo which
       *  defaults to `false` to match the settings default. */
      this.quickToggles = {
        highlight: true,
        backdropBlur: true,
        chromatic: true,
        refraction: true,
        outerShadow: true,
        innershadow: true,
        perElementFbo: false,
        isolateBackdrop: false
      };
      /** True when the WebGL context is backed by a SOFTWARE rasterizer
       *  (SwiftShader / llvmpipe / Mesa softpipe / Apple software renderer).
       *  On software renderers every draw call burns CPU (not GPU), and the
       *  browser's "GPU process" is actually a heavy CPU process that stays
       *  alive as long as the context exists. This is the single biggest
       *  hidden power cost and is completely unaffected by the quickToggles
       *  (which only skip shader passes, not the context's existence).
       *  Detected lazily on first render via WEBGL_debug_renderer_info. */
      this.isSoftwareRenderer = false;
      /** Debug: when true, the renderer collects each glass element's PEF
       *  bbox (CSS px, top-left origin) into `debugPefBboxes` during render.
       *  The React overlay reads this array to draw visible rectangles over
       *  the canvas. CONSUME-AFTER-DRAW: the overlay clears the list after
       *  drawing it, so the data survives the async gap between render and the
       *  overlay's rAF tick. Only populated when this flag is true. */
      this.showPefBbox = false;
      this.debugPefBboxes = [];
      /** Debug: when true, the renderer collects each blurTexture call's element
       *  rect (CSS px, top-left origin) + radius + downsample into
       *  `debugBlurRegions` during render. The React overlay reads this to draw
       *  rectangles marking where backdrop blur was computed. Useful for diagnosing
       *  downsample / scissor / coverage bugs. CONSUME-AFTER-DRAW: the overlay
       *  clears the list after drawing it. Only populated when this flag is true. */
      this.showBlurDebug = false;
      this.debugBlurRegions = [];
      /** Last blur call's stats, written by blurTexture/kawaseBlurTexture so
       *  callers (e.g. the blur debug overlay push in render-glass-backdrop)
       *  can read what actually happened (type, pass count, tap count, farthest
       *  sample distance) without re-deriving it. Null until the first blur call.
       *  maxSample = the farthest tap distance from center (Gaussian: 3σ;
       *  Kawase: radius, the ±2d at the last iter). */
      this.lastBlurStats = null;
      /** Backdrop blur cache for the independent path (wallpaperBlurFbo).
       *  When independent=true, the backdrop is static cover-fit wallpaper —
       *  same radius → same blur result. Key = `wallpaper_${qRadius}_${type}`
       *  where qRadius = CSS px radius quantized to 0.1 (NOT × dpr).
       *  Cross-element + cross-frame: multiple elements at the same radius
       *  share one blurred wallpaper texture.
       *  Invalidated on resize (cover-fit ratio changes) + loadWallpaper. */
      this.backdropBlurCache = /* @__PURE__ */ new Map();
      /** Pool of freed cache FBOs ({fb, tex, w, h}). On cache miss we acquire
       *  from here (reusing a size-matched tex+fb, avoiding gl.createTexture /
       *  gl.createFramebuffer + texImage2D allocation cost); on LRU eviction we
       *  release back here instead of deleting. clearBackdropBlurCache (resize /
       *  loadWallpaper) deletes everything since sizes may change. */
      this.backdropBlurCacheFboPool = [];
      /** Lazy-created persistent read FBO for copyTexImage2D in the cache path.
       *  Reused across all cache-miss copies (independent + scene) to avoid the
       *  ~0.5-1ms per-miss cost of createFramebuffer + deleteFramebuffer + the
       *  driver-side object allocation they trigger. Created on first use;
       *  deleted in dispose + clearBackdropBlurCache (resize/loadWallpaper). */
      this.cacheCopyReadFbo = null;
      /** Hard cap on the number of cached backdrop blur textures. When exceeded,
       *  the oldest entry (Map insertion order) is evicted + returned to the
       *  FBO pool. Each cached texture is ~fboW*fboH*4 bytes, so this bounds VRAM.
       *  Applies to BOTH the independent (wallpaper_*) and scene (scene_*) paths.
       *  Default 64. */
      this.backdropBlurCacheMax = 64;
      /** Per-frame counter of cache-miss blur operations. Reset to 0 at the start
       *  of each render(). When >= blurCacheMissesPerFrame, further cache misses
       *  this frame fall back to didBlur=false (no separable blur, shader uses
       *  inline poisson) so a frame with N simultaneous misses doesn't pay
       *  N × full-screen 2-pass blur — only 1 does, the rest are deferred to
       *  subsequent frames (progressive cache fill). */
      this._blurCacheMissesThisFrame = 0;
      /** Max cache-miss blurs allowed per frame. 1 = strictest (smoothest but
       *  slowest cache fill); higher = faster fill but bigger spikes. */
      this.blurCacheMissesPerFrame = 1;
      /** Tracks scrollY between frames — scene blur cache disabled when scrolling. */
      this._lastBlurCacheScrollY = 0;
      /** Debug: when true, cached blur textures are masked with a checkerboard
       *  pattern (even cells keep blur content, odd cells cleared to transparent).
       *  This lets you visually compare blur vs no-blur in the live render. */
      this.showBlurCacheCheckerboard = false;
      /** Debug: when true, cache miss reads full-resolution texture for the
       *  debug overlay preview. When false, only reads 64×64 center (cheap). */
      this.showBlurCachePreview = false;
      /** Debug: snapshot of each cache entry's center pixels, taken at cache-miss
       *  time (when the texture is first created). Stored as {key, w, h, rgba}
       *  so the overlay can render without touching GL state. */
      this.backdropBlurCacheSnapshots = [];
      /** Debug: when true, the renderer collects each glass element's SHADOW
       *  bbox (the TRUE per-direction reach of the shadow shape on screen,
       *  computed by shadowBboxCss from outerShadow.radius + offsetX/Y +
       *  layerScaleX/Y) into `debugShadowBboxes` during render. The shadow
       *  bbox is DYNAMIC — it shrinks at rest when the indicator's
       *  pressProgress=0 (shadow alpha → 0 → pass skipped) and grows during
       *  drag/press. Unlike the scissor margin (uniform conservative), this
       *  reflects the actual shadow geometry: offset directionality means
       *  left/right/top/bottom reaches differ. This lets you visualize exactly
       *  how much screen area each shadow rasterizes into, which is the basis
       *  for the inflatedOutputRect overlap test.
       *  CONSUME-AFTER-DRAW: the overlay clears the list after drawing it.
       *  Only populated when this flag is true. */
      this.showShadowBbox = false;
      this.debugShadowBboxes = [];
      /** Debug probe: when true, the capsule SDF texture uploaded to the GPU has
       *  its R channel (coverage) zeroed in the TOP-LEFT QUADRANT of the SOURCE
       *  IMAGE (Canvas2D space: row < texSize/2 && col < texSize/2). Due to
       *  UNPACK_FLIP_Y=true on upload + the Y-down convention of
       *  centeredOrigRot in the element shader, this image-top-left region
       *  maps to the element's BOTTOM-LEFT quadrant on screen.
       *
       *  PURPOSE: prove whether the glass body's clip edge actually comes from
       *  sampling this SDF texture. If ON → the bottom-left corner of every
       *  capsule glass element should become transparent (sampleClipMask
       *  returns 0 → `mask < 0.01 discard`), confirming the SDF texture IS
       *  the clip source. If nothing changes, the clip edge is coming from
       *  somewhere else (analytic sdRoundedRect, scissor, elFbo composite
       *  bounds, …).
       *
       *  The挖0 happens on a COPY at GPU upload time — the CPU maskCache
       *  (continuous-mask.ts) is NEVER touched, so other elements + the cache
       *  hit-rate are unaffected. The GPU texture pool key includes this flag
       *  so toggling creates a fresh pool entry instantly (no eviction of the
       *  clean texture). Independent of debugSdfHoleTopLeftG — both can be ON
       *  at once to test both channels simultaneously. */
      this.debugSdfHoleTopLeftR = false;
      /** Debug probe: same as debugSdfHoleTopLeftR but zeroes the G channel
       *  (SDF) instead of R (coverage). Tests whether highlight / rim-stroke
       *  shapes that use sampleClipSdf are actually fed by this texture.
       *  Independent of debugSdfHoleTopLeftR. */
      this.debugSdfHoleTopLeftG = false;
      /** Debug: when true, the renderer records each element's CULL decision
       *  (made in methods-render.ts's two element loops) into `debugCullRects`
       *  during render. The React overlay draws each element's effective
       *  viewport rect (after scroll offset) + the cull margin that was applied
       *  (max(120, h)) + a KEPT/CULL label, so you can see EXACTLY why an
       *  element was or wasn't skipped this frame.
       *
       *  WHY THIS EXISTS: the "element disappeared before sliding off screen"
       *  symptom is frequently blamed on the cull logic, but the cull margin
       *  (max(120, h)) is deliberately generous — a 300px card stays rendered
       *  until it's FULLY off-screen + 300px beyond. This overlay proves
       *  whether the cull logic is actually the culprit: if a disappearing
       *  element still shows a green KEPT rect, the bug is elsewhere (PEF
       *  composite position, scissor rect, elFbo cache, etc.).
       *
       *  CONSUME-AFTER-DRAW: NO — structural overlay (persists across idle
       *  frames like showPefBbox). The renderer clears + repopulates it at the
       *  start of each actual render; idle frames leave the last render's data
       *  intact so the overlay stays visible. */
      this.showCullDebug = false;
      this.debugCullRects = [];
      /** Debug: when true, records each glass element's PEF step execution into
       *  `debugPefPasses` during render. The overlay draws, per glass element:
       *    - BLUE rect  = Step 4 composite rect (elFbo → curFbo blit area)
       *    - YELLOW rect = Step 5 post-pass scissor (shadow bbox)
       *    - RED badge  = cache HIT (Step 3 skipped → element-shader highlight /
       *      indicator backdrop NOT rendered this frame; only cached tex composited)
       *    - GREEN badge = cache MISS (Step 3 ran → full re-raster incl. highlight)
       *
       *  WHY: symptoms "highlight disappears" + "bottom-tab indicator content
       *  layer missing on first frame" both ONLY happen with PEF on. Root cause
       *  hypothesis: the element shader (renderGlassElementPass = Step 3) renders
       *  the refraction-embedded highlight AND the indicator's sampleIndicator
       *  Backdrop content layer INTO the elFbo. On PEF cache HIT, Step 3 is
       *  skipped → the cached elFbo tex (from a previous frame) is composited
       *  as-is. If the cached tex was rasterized when highlight.alpha=0 or
       *  pressProgress=0 (at rest), the highlight / indicator content baked
       *  into the cache is empty, and it NEVER refreshes until cache is
       *  invalidated. This overlay lets you verify: when highlight visually
       *  disappears, check if the element shows a RED (HIT) badge — if so,
       *  the cache is serving a stale tex without the highlight.
       *
       *  CONSUME-AFTER-DRAW: NO — structural overlay (persists across idle
       *  frames). Cleared + repopulated each render. */
      this.showPefPassDebug = false;
      this.debugPefPasses = [];
      /** Debug: when true, records each plain-rect element's RENDER DECISION
       *  (made in renderNonGlassElement) into `debugPlainRects` during render.
       *  The overlay draws each plain-rect's effective viewport rect color-coded
       *  by verdict, plus a detail info panel for settings-card-rendering-bg.
       *
       *  WHY THIS EXISTS: the "settings card background mysteriously disappears"
       *  symptom. The card bg is a plain-rect (NOT glass — it does NOT go through
       *  PEF / elFboCache / element-pass shader / uEnterAlpha). So the
       *  disappearance must be one of:
       *    1. SKIPPED    — color alpha ≤ 0 (palette.toggleCardBg alpha→0 or NaN)
       *                    → renderNonGlassElement early-returns before drawArrays.
       *    2. INVISIBLE  — finalAlpha = colorA * enterA ≤ 0. Two sub-causes:
       *                    (a) enterProgress leaked from ControlCenter page →
       *                        enterA=0 → uColor.a=0 (card draws fully transparent).
       *                    (b) color alpha is NaN (NaN≤0 is false → not SKIPPED,
       *                        but NaN*enterA=NaN → uColor.a=NaN→0 in GL).
       *    3. DEGENERATE — rect w/h ≤ 0 (cardBgEl.rect.h = nextY-cardStartY ≤ 0
       *                    due to a layout / scrollY / conditional-skip bug in
       *                    build-settings.ts). setSdfUniforms gets a 0-size quad.
       *    4. NO_OP      — BLEND disabled by a prior element (progressive-blur /
       *                    blurTexture) and not restored → drawArrays writes
       *                    nothing (plain-rect branch only sets blendFunc, never
       *                    re-enables BLEND).
       *    5. (else)     — drawn OK; the disappearance is elsewhere (ping-pong
       *                    blit curFbo/curTex desync, or a later opaque element
       *                    covering the card). curFboIsA is recorded as a clue.
       *
       *  CONSUME-AFTER-DRAW: NO — structural overlay (persists across idle
       *  frames like showCullDebug). The renderer clears + repopulates it at the
       *  start of each actual render; idle frames leave the last render's data
       *  intact so the overlay stays visible. */
      this.showPlainRectDebug = false;
      this.debugPlainRects = [];
      /** Performance monitor — frame timing + per-frame render counters +
       *  GPU info. When `perfMonitor.enabled === false` (default), every
       *  increment is a no-op. Toggled on by the Settings "Performance
       *  monitor" switch via the perfMonitorEnabled prop in context.tsx. */
      this.perfMonitor = new PerfMonitor();
      // --- Per-element FBO infrastructure (used when usePerElementFbo=true) ---
      // elFbo: the element's glass body is rendered here (transparent; the element
      // shader's discard leaves only the glass shape). Capped to 1024 device px.
      // Lazily (re)created by ensureElementFBO when the element's device-px bbox
      // size changes.
      this.elFbo = null;
      this.elFboTex = null;
      this.elFboW = 0;
      this.elFboH = 0;
      /** Per-element CACHED elFbo. Only INDEPENDENT elements (backdrop = static
       *  wallpaper via uSampleWallpaper=1) can be cached across frames — non-
       *  independent elements sample curTex (the accumulation buffer) which
       *  changes whenever an earlier element draws, so their backdrop is never
       *  stable across frames and caching would produce stale visuals.
       *
       *  Cache key: element.id. Entry validity is gated by:
       *    - entry.valid (set false by any global state change)
       *    - geometry match (elFboRectW/H + ex0/ey0Top — covers scroll, layerScale,
       *      translation, enterProgress)
       *    - entry.wallpaperVersion === this.wallpaperVersion (wallpaper reload)
       *    - entry.dpr === this.dpr
       *
       *  When all match AND the element is not dirty this frame, the render loop
       *  SKIPS shadow + element pass + blur + post passes, and just composites
       *  the cached tex onto curFbo. The cached tex contains the FULL element
       *  (shadow + glass body + foreground + highlight) with alpha, so SrcOver
       *  compositing is correct. */
      this.elFboCache = /* @__PURE__ */ new Map();
      /** Monotonically incremented each time the wallpaper texture is (re)loaded.
       *  Compared against each elFboCache entry's stored wallpaperVersion to
       *  invalidate cached independent elements when the backdrop they sampled
       *  has changed. */
      this.wallpaperVersion = 0;
      // backdropCropFbo: a scissor-cropped copy of curFbo covering the element's
      // bbox (+ blur margin). The element pass samples THIS (small) texture for
      // refraction/blur instead of doing a fullscreen blit.
      this.backdropCropFbo = null;
      this.backdropCropTex = null;
      // elBlurFboA/B: ping-pong for the 2-pass separable Gaussian on the cropped
      // backdrop (when useSeparableBlur). Same capped size as elFbo.
      this.elBlurFboA = null;
      this.elBlurFboATex = null;
      this.elBlurFboB = null;
      this.elBlurFboBTex = null;
      // SDF texture (clock_sdf) for LockScreen glass
      this.sdfTexture = null;
      this.sdfTextureReady = false;
      this.sdfTextureSize = [1, 1];
      // SEPARATE SDF texture slot for TextGlass (user-typed text SDF).
      // This is intentionally NOT the same slot as sdfTexture (clock_sdf) so
      // that generating a text SDF on the TextGlass page NEVER overwrites the
      // lock screen's clock_sdf texture. Previously both shared one slot,
      // which required a fragile reload-clock_sdf-on-LockScreen-entry hack
      // and could still flash the wrong texture during page transitions.
      // "把这个和锁屏sdf彻底分开" — completely separated.
      this.textSdfTexture = null;
      this.textSdfTextureReady = false;
      this.textSdfTextureSize = [1, 1];
      // Continuous-curvature mask texture pool: each unique (w,h,radius,dpr) gets
      // its own texture. The currently-bound one is in continuousSdfTexture.
      this.continuousSdfPool = /* @__PURE__ */ new Map();
      this.continuousSdfTexture = null;
      // texSize is dynamic (128/256/512/1024, chosen by generateContinuousCurvatureMask
      // based on element device-px size — 2× oversampling rounded up to POT).
      // Updated each loadContinuousSdf() call.
      this.continuousSdfTexSize = [128, 128];
      this.continuousSdfKey = null;
      /** 1×1 dummy texture (fully transparent black) bound to unused sampler
       *  units in the element pass. WebGL1 requires ALL sampler uniforms declared
       *  in a shader to point to texture units with a COMPLETE texture — even if
       *  the shader's current code path (via a uniform branch) never samples them.
       *  Without this, elements that render AFTER an element which bound a texture
       *  to a now-stale unit (e.g. toggle knob binding TEXTURE2 to the SDF texture,
       *  then the back button not rebinding it) get GL_INVALID_OPERATION from
       *  drawArrays → the glass body silently renders as empty/transparent.
       *  This is the root cause of the "back button background disappears on
       *  toggle/slider pages" bug. */
      this.dummyTex = null;
      // --- Capsule SDF profiling (debug layer) ---
      // Last generation's timings (ms). 0 when pool hit (no generation/upload).
      this._lastCapsuleGenMs = 0;
      // CPU: generateContinuousCurvatureMask total
      this._lastCapsuleUploadMs = 0;
      // GPU: texImage2D + gl.finish() sync
      this._lastCapsuleKey = "";
      /** Debug: a SNAPSHOT of the exact pixel bytes uploaded to the GPU in the
       *  last texImage2D call for a capsule SDF texture. This INCLUDES any
       * 挖0 applied by the debugSdfHoleTopLeftR/G probes (the挖0 happens on a
       *  copy at upload time — the CPU maskCache stays clean). The overlay's
       *  "Pack images" view reads this when a probe is active so the user can
       *  SEE the挖0'd region in the visualization, instead of the clean cache.
       *  null until the first upload, and cleared on pool hit (no upload that
       *  frame). Stays null if no probe is active (overlay reads the clean
       *  maskCache directly in that case — same data, less memory). */
      this._debugUploadedSdfTexMap = /* @__PURE__ */ new Map();
      /** Edge scan probe — pending request. Set by debugReadEdgeScanline(),
       *  consumed by _debugFlushPendingEdgeScan() at the end of render().
       *  Null when no scan is pending. */
      this._pendingEdgeScan = null;
      /** Edge scan probe — last completed result. The overlay polls this.
       *  Null until the first scan completes. Bumped with a new scanId on
       *  each completed scan so the overlay can detect fresh results. */
      this._edgeScanResult = null;
      /** Monotonic counter for edge scan results. */
      this._edgeScanCounter = 0;
      /** Index into the useContinuousSdf element list to scan next. Cycled by
       *  debugCycleEdgeScanTarget() — lets the user step through multiple
       *  capsule elements on the same page. */
      this._edgeScanTargetIdx = 0;
      this.fgTextures = /* @__PURE__ */ new Map();
      this.fgDirtyIds = /* @__PURE__ */ new Set();
      /** Canvas2D stroke-mask cache for rim highlight. Keyed by exact geometry
       *  (element size + corner radius + stroke width + path style at current dpr).
       *  The mask is independent of highlight angle/alpha/press progress, so it can
       *  be reused across frames without a resolution ceiling or UV mismatch. */
      this.strokeMaskCache = /* @__PURE__ */ new Map();
      /** Canvas2D inner-shadow-mask cache. Keyed by exact geometry
       *  (element size + corner radius + offset + blur sigma + path style).
       *  Two entries per element (shadow1 + shadow2). */
      this.innerShadowMaskCache = /* @__PURE__ */ new Map();
      this.rafId = null;
      this.animRafId = null;
      /** Bottom-tabs first-entry double-render counter.
       *  When >0, render() will — at the end of the frame — mark all bottom-tab
       *  indicator groups dirty (invalidating their elFbo cache) and request one
       *  more render, then decrement. This forces the indicator to re-rasterize
       *  on the second frame with a now-stable tabsBackdropTex (captured during
       *  the first frame), fixing the "first frame missing indicator content
       *  layer" PEF-only symptom without making indicators permanently
       *  non-cacheable. Set by setButtons when navigating TO a bottom-tabs page. */
      this.pendingExtraRenders = 0;
      // Program uniform locations (cached)
      this.uEl = {};
      this.uSh = {};
      this.uWp = {};
      this.uFg = {};
      this.uHl = {};
      this.uTn = {};
      this.uRm = {};
      this.uHs = {};
      this.uHc = {};
      this.uSm = {};
      this.uIs = {};
      this.uPr = {};
      this.uPb = {};
      this.uCp = {};
      this.uSf = {};
      this.uCc = {};
      this.uSt = {};
      this.uEf = {};
      this.uEc = {};
      var _a;
      this.canvas = canvas;
      const gl = canvas.getContext("webgl", {
        premultipliedAlpha: false,
        alpha: true,
        antialias: false,
        preserveDrawingBuffer: false,
        powerPreference: "low-power"
      });
      if (!gl) throw new Error("WebGL not supported");
      this.gl = gl;
      this.elementProgram = createProgram(gl, VERTEX_SHADER, ELEMENT_FRAGMENT_SHADER);
      this.shadowProgram = createProgram(gl, VERTEX_SHADER, SHADOW_FRAGMENT_SHADER);
      this.wallpaperProgram = createProgram(gl, VERTEX_SHADER, WALLPAPER_FRAGMENT_SHADER);
      this.foregroundProgram = createProgram(gl, VERTEX_SHADER, FOREGROUND_FRAGMENT_SHADER);
      this.highlightProgram = createProgram(gl, VERTEX_SHADER, HIGHLIGHT_FRAGMENT_SHADER);
      this.tintProgram = createProgram(gl, VERTEX_SHADER, TINT_FRAGMENT_SHADER);
      this.rimHighlightProgram = createProgram(gl, VERTEX_SHADER, RIM_HIGHLIGHT_FRAGMENT_SHADER);
      this.highlightStrokeProgram = createProgram(gl, VERTEX_SHADER, HIGHLIGHT_STROKE_FRAGMENT_SHADER);
      this.highlightCompositeProgram = createProgram(gl, VERTEX_SHADER, HIGHLIGHT_COMPOSITE_FRAGMENT_SHADER);
      this.strokeMaskCompositeProgram = createProgram(gl, VERTEX_SHADER, STROKE_MASK_COMPOSITE_FRAGMENT_SHADER);
      this.innerShadowMaskCompositeProgram = createProgram(gl, VERTEX_SHADER, INNER_SHADOW_MASK_COMPOSITE_FRAGMENT_SHADER);
      this.plainRectProgram = createProgram(gl, VERTEX_SHADER, PLAIN_RECT_FRAGMENT_SHADER);
      this.progressiveBlurProgram = createProgram(gl, VERTEX_SHADER, PROGRESSIVE_BLUR_FRAGMENT_SHADER);
      this.copyProgram = createProgram(gl, VERTEX_SHADER, COPY_FRAGMENT_SHADER);
      this.solidFillProgram = createProgram(gl, VERTEX_SHADER, SOLID_FILL_FRAGMENT_SHADER);
      this.colorControlsProgram = createProgram(gl, VERTEX_SHADER, COLOR_CONTROLS_FRAGMENT_SHADER);
      this.sceneTintProgram = createProgram(gl, VERTEX_SHADER, SCENE_TINT_FRAGMENT_SHADER);
      this.elFboCompositeProgram = createProgram(gl, VERTEX_SHADER, EL_FBO_COMPOSITE_FRAGMENT_SHADER);
      this.elFboCropProgram = createProgram(gl, VERTEX_SHADER, EL_FBO_CROP_FRAGMENT_SHADER);
      this.quadBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
        gl.STATIC_DRAW
      );
      this.aPosLocEl = gl.getAttribLocation(this.elementProgram, "aPos");
      this.aPosLocSh = gl.getAttribLocation(this.shadowProgram, "aPos");
      this.aPosLocWp = gl.getAttribLocation(this.wallpaperProgram, "aPos");
      this.aPosLocFg = gl.getAttribLocation(this.foregroundProgram, "aPos");
      this.aPosLocHl = gl.getAttribLocation(this.highlightProgram, "aPos");
      this.aPosLocTn = gl.getAttribLocation(this.tintProgram, "aPos");
      this.aPosLocRm = gl.getAttribLocation(this.rimHighlightProgram, "aPos");
      this.aPosLocHs = gl.getAttribLocation(this.highlightStrokeProgram, "aPos");
      this.aPosLocHc = gl.getAttribLocation(this.highlightCompositeProgram, "aPos");
      this.aPosLocSm = gl.getAttribLocation(this.strokeMaskCompositeProgram, "aPos");
      this.aPosLocIs = gl.getAttribLocation(this.innerShadowMaskCompositeProgram, "aPos");
      this.aPosLocPr = gl.getAttribLocation(this.plainRectProgram, "aPos");
      this.aPosLocPb = gl.getAttribLocation(this.progressiveBlurProgram, "aPos");
      this.aPosLocCp = gl.getAttribLocation(this.copyProgram, "aPos");
      this.aPosLocSf = gl.getAttribLocation(this.solidFillProgram, "aPos");
      this.aPosLocCc = gl.getAttribLocation(this.colorControlsProgram, "aPos");
      this.aPosLocSt = gl.getAttribLocation(this.sceneTintProgram, "aPos");
      this.aPosLocEf = gl.getAttribLocation(this.elFboCompositeProgram, "aPos");
      this.aPosLocEc = gl.getAttribLocation(this.elFboCropProgram, "aPos");
      this.fgCanvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
      const fgCtx = (_a = this.fgCanvas) == null ? void 0 : _a.getContext("2d", { alpha: true });
      if (!fgCtx) throw new Error("2D canvas not supported");
      this.fgCtx = fgCtx;
      this.dummyTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.dummyTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.cacheUniforms();
      this.perfMonitor.attachGl(gl);
      this.detectSoftwareRenderer();
      this.perfMonitor.isSoftwareRenderer = this.isSoftwareRenderer;
    }
    get _debugLastUploadedSdfTex() {
      const arr = Array.from(this._debugUploadedSdfTexMap.values());
      return arr.length ? arr[arr.length - 1].tex : null;
    }
    get _debugLastUploadedSdfKey() {
      const arr = Array.from(this._debugUploadedSdfTexMap.keys());
      return arr.length ? arr[arr.length - 1] : "";
    }
    get _debugLastUploadedSdfTexSize() {
      const arr = Array.from(this._debugUploadedSdfTexMap.values());
      return arr.length ? arr[arr.length - 1].texSize : 0;
    }
    /** Clear the GPU-side capsule SDF texture pool + reset binding. The CPU-side
     *  mask cache (continuous-mask.ts) must be cleared separately via
     *  clearMaskCache(). Next render re-generates textures on demand. */
    clearCapsuleSdfPool() {
      const gl = this.gl;
      for (const { tex } of this.continuousSdfPool.values()) gl.deleteTexture(tex);
      this.continuousSdfPool.clear();
      this.continuousSdfTexture = null;
      this.continuousSdfKey = null;
      this._lastCapsuleGenMs = 0;
      this._lastCapsuleUploadMs = 0;
      this._lastCapsuleKey = "";
      this._debugUploadedSdfTexMap.clear();
    }
    /** Clear the Canvas2D stroke-mask cache (highlight rim + inner-shadow
     *  masks). Deletes the WebGL textures + drops the HTMLCanvasElement refs
     *  so they can be GC'd. Next render re-rasterizes masks on demand via
     *  Canvas2D stroke(). Provided for the debug overlay's "clr masks" button
     *  so the user can force fresh mask generation to inspect the highlight
     *  stroke shape. Returns the number of entries evicted. */
    clearStrokeMaskCache() {
      const gl = this.gl;
      const n = this.strokeMaskCache.size;
      for (const entry of this.strokeMaskCache.values()) gl.deleteTexture(entry.tex);
      this.strokeMaskCache.clear();
      return n;
    }
    /** Probe WEBGL_debug_renderer_info (if available) and set
     *  isSoftwareRenderer. The unmasked renderer string contains markers like
     *  "SwiftShader", "llvmpipe", "softpipe", "Apple Software", "Microsoft
     *  Basic Render Driver", "Mesa software" that identify CPU rasterizers. */
    detectSoftwareRenderer() {
      const gl = this.gl;
      try {
        const dbgExt = gl.getExtension("WEBGL_debug_renderer_info");
        const rendererStr = dbgExt ? String(gl.getParameter(dbgExt.UNMASKED_RENDERER_WEBGL) || "") : String(gl.getParameter(gl.RENDERER) || "");
        const r = rendererStr.toLowerCase();
        this.isSoftwareRenderer = r.includes("swiftshader") || r.includes("llvmpipe") || r.includes("softpipe") || r.includes("swrast") || r.includes("software") || r.includes("basic render") || r.includes("mesa software") || r.includes("apple software");
      } catch (e) {
      }
    }
    /**
     * Returns true iff ANY of the 7 debug overlay flags is on. Used by the
     * overlay rAF loop in context.tsx to decide whether to keep ticking at
     * 60Hz or stop + switch to a 250ms poll. When all flags are off, the rAF
     * stops entirely so the browser compositor can enter deep idle — this is
     * the difference between ~0.3W and ~0.05W idle power on mobile.
     *
     * NOTE: the perf-monitor overlay's quick-toggles (perElementFbo,
     * isolateBackdrop, noContinuousSdf, sampleWallpaper, etc.) do NOT count
     * as "debug overlays" here — they affect rendering output, not the 2D
     * overlay canvas. The overlay canvas only draws when one of these 7
     * structural/show* flags is on.
     */
    anyDebugOverlayOn() {
      return this.showPefBbox || this.showBlurDebug || this.showShadowBbox || this.showCullDebug || this.showPlainRectDebug || this.showPefPassDebug || this.showDirtyMarkers;
    }
    // cacheUniforms, ensureBlurPrograms, pickDsBlurLevel, blurTexture,
    // ensureHighlightBlurPrograms, blurHighlightMask, and dispose are
    // defined in methods-uniforms.ts / methods-blur.ts / methods-dispose.ts
    // and merged onto the prototype via Object.assign below.
  };
  /** The pressed scale for bottom tabs indicator (78f/56f in Kotlin). */
  LiquidGlassRenderer.TAB_PRESSED_SCALE = 78 / 56;
  Object.assign(
    LiquidGlassRenderer.prototype,
    fboMethods,
    wallpaperMethods,
    scrollMethods,
    toggleMethods,
    tabsMethods,
    elementMethods,
    animationMethods,
    rasterMethods,
    renderMethods,
    backgroundMethods,
    nonGlassMethods,
    nonGlassPlainRectMethods,
    nonGlassTextMethods,
    nonGlassProgressiveBlurMethods,
    glassRenderMethods,
    glassElementPassMethods,
    glassPostPassMethods,
    dirtyTrackingMethods,
    debugMethods,
    uniformMethods,
    blurMethods,
    disposeMethods
  );
  return __toCommonJS(index_exports);
})();
