var es=Object.defineProperty;var ts=(e,r,t)=>r in e?es(e,r,{enumerable:!0,configurable:!0,writable:!0,value:t}):e[r]=t;var d=(e,r,t)=>ts(e,typeof r!="symbol"?r+"":r,t);var ae=`
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
`,xe=`
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
`;var Jt=`
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
`;function rs(e){let r=[];if(e<=1)return r.push({x:0,y:0,w:1}),r;let t=Math.PI*(3-Math.sqrt(5)),s=3,a=0;for(let i=0;i<e;i++){let o=(i+.5)/e,u=s*Math.sqrt(o),l=i*t,f=u*Math.cos(l),c=u*Math.sin(l),n=f*f+c*c,h=Math.exp(-.5*n);r.push({x:f,y:c,w:h}),a+=h}if(a>0)for(let i of r)i.w/=a;return r}function er(e,r,t,s){if(e.length===1)return`    return texture2D(${r}, ${t});
`;let a="";for(let i of e){let o=i.x.toFixed(6),u=i.y.toFixed(6),l=i.w.toFixed(8);a+=`    sum += texture2D(${r}, ${t} + vec2(${o}, ${u}) * ${s}) * ${l};
`}return a}var He=16;function tr(e=He){let r=rs(e),t=er(r,"uBackdrop","uv","pxToUv"),s=er(r,"uWallpaperSampler","uv","pxToUv");return`
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

// Gaussian disc blur \u2014 ${e} taps, dynamically generated in JS.
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
${s}            c = sum;
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
${t}    return sum;
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
${s}    return sum;
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
`}function ss(e=He){let r=tr(e);return`
precision highp float;

${Jt}

${ae}

${xe}

${r}

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
`}var Ze=ss(He);var je=`
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

${ae}

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
`,as=`
precision highp float;

uniform vec2  uCanvasSize;
uniform vec2  uElementOffset;
uniform vec2  uElementSize;
uniform vec4  uCornerRadii;
uniform float uInnerShadowRadius;
uniform float uInnerShadowAlpha;
uniform vec2  uInnerShadowOffset;

${ae}

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
`;var Qe=`
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

${ae}

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
`,Je=`
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

${ae}

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
`,et=`
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

${ae}

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
`,tt=`
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

${ae}

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
`,rt=`
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

${ae}

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
`,st=`
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

${ae}

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
`;var at=`
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

${ae}

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
`;var Q=`
attribute vec2 aPos;
void main() {
    gl_Position = vec4(aPos, 0.0, 1.0);
}
`,it=`
precision highp float;

uniform sampler2D uBackdrop;
uniform vec2 uCanvasSize;
uniform vec2 uWallpaperSize;

${xe}

void main() {
    vec2 screenCoord = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);
    vec2 uv = coverUv(screenCoord);
    gl_FragColor = texture2D(uBackdrop, uv);
}
`,ot=`
precision highp float;

uniform sampler2D uTexture;
uniform vec2 uCanvasSize;

void main() {
    vec2 uv = vec2(gl_FragCoord.x / uCanvasSize.x, gl_FragCoord.y / uCanvasSize.y);
    gl_FragColor = texture2D(uTexture, uv);
}
`,nt=`
precision highp float;

uniform vec4 uColor;

void main() {
    gl_FragColor = uColor;
}
`,lt=`
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
`,ut=`
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
`,ct=`
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
`,dt=`
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
`;var ht=`
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

${ae}

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
`,ft=`
precision highp float;

uniform vec2  uCanvasSize;
uniform vec2  uOffset;
uniform vec2  uSize;
uniform vec4  uCornerRadii;
uniform vec4  uColor;       // rgba (premultiplied not required; alpha used as-is)

${ae}

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
`,mt=`
precision highp float;

uniform sampler2D uBackdrop;
uniform vec2  uCanvasSize;
uniform vec2  uWallpaperSize;
uniform vec2  uOffset;          // band top-left in canvas px (top-left origin)
uniform vec2  uSize;            // band size in canvas px
uniform float uBlurRadius;      // px in canvas space
uniform vec4  uTintColor;       // rgba
uniform float uTintIntensity;   // 0..1

${xe}

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
`;function is(e){if(e<=1)return[{offset:0,weight:1}];let r=[],t=Math.floor(e/2),s=3,a=0;for(let i=0;i<e;i++){let u=(e%2===1?i-t:i-t+.5)/t*s,l=Math.exp(-.5*u*u);r.push({offset:u,weight:l}),a+=l}if(a>0)for(let i of r)i.weight/=a;return r}function gt(e,r){let t=is(e),a=r==="horizontal"?"vec2(1.0, 0.0)":"vec2(0.0, 1.0)",i="";if(t.length===1)i=`    gl_FragColor = texture2D(uTexture, uv);
`;else{i=`    vec3 rgbSum = vec3(0.0);
    float rgbW = 0.0;
`;for(let o of t){let u=o.offset.toFixed(6),l=o.weight.toFixed(8);i+=`    { vec4 s = texture2D(uTexture, uv + ${a} * ${u} * pxToUv); float aw = s.a * ${l}; rgbSum += s.rgb * aw; rgbW += aw; }
`}i+=`    float origA = texture2D(uTexture, uv).a;
    gl_FragColor = vec4(rgbW > 0.001 ? rgbSum / rgbW : vec3(0.0), origA);
`}return`
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
${i}}
`}function Me(e){if(e<.5)return 1;let r=e*.57735+.5,t=2*Math.ceil(3*r)+1;return Math.min(33,Math.max(1,t))}function os(e){if(e<=1)return[{offset:0,weight:1}];let r=[],t=Math.floor(e/2),s=0;for(let a=0;a<e;a++){let i=a-t,o=Math.exp(-.5*i*i);r.push({offset:i,weight:o}),s+=o}if(s>0)for(let a of r)a.weight/=s;return r}function pt(e,r){let t=os(e),a=r==="horizontal"?"vec2(1.0, 0.0)":"vec2(0.0, 1.0)",i="";if(t.length===1)i=`    gl_FragColor = texture2D(uTexture, uv);
`;else{i=`    float aSum = 0.0;
`;for(let o of t){let u=o.offset.toFixed(6),l=o.weight.toFixed(8);i+=`    aSum += texture2D(uTexture, uv + ${a} * ${u} * pxToUv).a * ${l};
`}i+=`    gl_FragColor = vec4(0.0, 0.0, 0.0, aSum);
`}return`
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
${i}}
`}function bt(e){if(e<.01)return 1;let r=2*Math.ceil(3*e)+1;return Math.min(33,Math.max(3,r))}function Be(e,r=1){let t;e<1.5?t=2:e<3?t=3:e<6?t=4:e<12?t=6:t=8;let s=Math.round(t*r);return Math.max(2,Math.min(8,s))}function St(){return`precision highp float;
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
`}function Te(e,r,t){let s=e.createShader(r);if(e.shaderSource(s,t),e.compileShader(s),!e.getShaderParameter(s,e.COMPILE_STATUS)){let a=e.getShaderInfoLog(s);throw e.deleteShader(s),new Error("Shader compile error: "+a)}return s}function ee(e,r,t){let s=Te(e,e.VERTEX_SHADER,r),a=Te(e,e.FRAGMENT_SHADER,t),i=e.createProgram();if(e.attachShader(i,s),e.attachShader(i,a),e.linkProgram(i),!e.getProgramParameter(i,e.LINK_STATUS)){let o=e.getProgramInfoLog(i);throw e.deleteProgram(i),new Error("Program link error: "+o)}return i}function xt(e,r,t){let s=r.split(/\s+/).filter(o=>o.length>0),a=[],i="";for(let o of s){let u=i?i+" "+o:o;if(e.measureText(u).width<=t){i=u;continue}i&&(a.push(i),i="");for(let l of o){let f=i+l;e.measureText(f).width<=t||!i?i=f:(a.push(i),i=l)}}return i&&a.push(i),a}function ve(e){if(e<=0)return 0;if(e>=1)return 1;let r=.42,t=0,s=1,a=1,i=e;for(let o=0;o<8;o++){let u=3*(1-i)*(1-i)*i*r+3*(1-i)*i*i*s+i*i*i,l=3*(1-i)*(1-i)*r+6*(1-i)*i*(s-r)+3*i*i*(1-s);if(Math.abs(u-e)<.001||Math.abs(l)<1e-6)break;i-=(u-e)/l,i=Math.max(0,Math.min(1,i))}return 3*(1-i)*(1-i)*i*t+3*(1-i)*i*i*a+i*i*i}var ze=class{constructor(){d(this,"enabled",!1);d(this,"gl",null);d(this,"HISTORY_SIZE",240);d(this,"frameTimes",new Float32Array(this.HISTORY_SIZE));d(this,"frameTimeIdx",0);d(this,"frameTimeCount",0);d(this,"prevFrameEndTime",0);d(this,"totalFrames",0);d(this,"jank16Count",0);d(this,"jank33Count",0);d(this,"drawCalls",0);d(this,"glassElements",0);d(this,"perElementFboCount",0);d(this,"pingPongCount",0);d(this,"nonGlassElements",0);d(this,"blurPasses",0);d(this,"dirtyElements",0);d(this,"totalElements",0);d(this,"cachedElements",0);d(this,"lastDrawCalls",0);d(this,"lastGlassElements",0);d(this,"lastPerElementFboCount",0);d(this,"lastPingPongCount",0);d(this,"lastNonGlassElements",0);d(this,"lastBlurPasses",0);d(this,"lastDirtyElements",0);d(this,"lastTotalElements",0);d(this,"lastCachedElements",0);d(this,"lastFrameTimeMs",0);d(this,"gpuInfoCollected",!1);d(this,"gpuVendor","");d(this,"gpuRenderer","");d(this,"maxTextureSize",0);d(this,"extensionCount",0);d(this,"isSoftwareRenderer",!1);d(this,"canvasCssW",0);d(this,"canvasCssH",0);d(this,"canvasDevW",0);d(this,"canvasDevH",0);d(this,"dpr",0);d(this,"deviceDpr",0)}attachGl(r){this.gl=r}collectGpuInfo(){if(!this.gl||this.gpuInfoCollected)return;this.gpuInfoCollected=!0;let r=this.gl,t=r.getExtension("WEBGL_debug_renderer_info");try{this.gpuVendor=String(t?r.getParameter(t.UNMASKED_VENDOR_WEBGL)||"":r.getParameter(r.VENDOR)||""),this.gpuRenderer=String(t?r.getParameter(t.UNMASKED_RENDERER_WEBGL)||"":r.getParameter(r.RENDERER)||""),this.maxTextureSize=Number(r.getParameter(r.MAX_TEXTURE_SIZE))||0;let s=r.getSupportedExtensions()||[];this.extensionCount=s.length}catch{}}frameStart(){this.enabled&&(this.collectGpuInfo(),this.drawCalls=0,this.glassElements=0,this.perElementFboCount=0,this.pingPongCount=0,this.nonGlassElements=0,this.blurPasses=0,this.dirtyElements=0,this.totalElements=0,this.cachedElements=0)}frameEnd(){if(!this.enabled)return;let r=performance.now(),t=this.prevFrameEndTime>0?r-this.prevFrameEndTime:0;this.prevFrameEndTime=r,t>0&&t<=500&&(this.lastFrameTimeMs=t,this.frameTimes[this.frameTimeIdx]=t,this.frameTimeIdx=(this.frameTimeIdx+1)%this.HISTORY_SIZE,this.frameTimeCount<this.HISTORY_SIZE&&this.frameTimeCount++,t>16.67&&this.jank16Count++,t>33.33&&this.jank33Count++),this.totalFrames++,this.lastDrawCalls=this.drawCalls,this.lastGlassElements=this.glassElements,this.lastPerElementFboCount=this.perElementFboCount,this.lastPingPongCount=this.pingPongCount,this.lastNonGlassElements=this.nonGlassElements,this.lastBlurPasses=this.blurPasses,this.lastDirtyElements=this.dirtyElements,this.lastTotalElements=this.totalElements,this.lastCachedElements=this.cachedElements}incDrawCall(r=1){this.enabled&&(this.drawCalls+=r)}incGlassElement(){this.enabled&&this.glassElements++}incPerElementFbo(){this.enabled&&this.perElementFboCount++}incPingPong(){this.enabled&&this.pingPongCount++}incNonGlass(){this.enabled&&this.nonGlassElements++}incBlurPass(){this.enabled&&this.blurPasses++}incDirty(){this.enabled&&this.dirtyElements++}incTotal(){this.enabled&&this.totalElements++}incCachedElement(){this.enabled&&this.cachedElements++}reset(){this.frameTimes.fill(0),this.frameTimeIdx=0,this.frameTimeCount=0,this.prevFrameEndTime=0,this.totalFrames=0,this.jank16Count=0,this.jank33Count=0,this.lastFrameTimeMs=0,this.lastDrawCalls=0,this.lastGlassElements=0,this.lastPerElementFboCount=0,this.lastPingPongCount=0,this.lastSkipPingPongCount=0,this.lastNonGlassElements=0,this.lastBlurPasses=0,this.lastDirtyElements=0,this.lastTotalElements=0,this.lastCachedElements=0}getSnapshot(){let r=[];if(this.frameTimeCount>0)if(this.frameTimeCount<this.HISTORY_SIZE)for(let l=0;l<this.frameTimeCount;l++)r.push(this.frameTimes[l]);else for(let l=0;l<this.HISTORY_SIZE;l++)r.push(this.frameTimes[(this.frameTimeIdx+l)%this.HISTORY_SIZE]);let t=0,s=1/0,a=0;for(let l of r)t+=l,l<s&&(s=l),l>a&&(a=l);let i=r.length,o=i>0?t/i:0,u=this.lastFrameTimeMs;return{frameTimeMs:u,avgFrameTimeMs:o,minFrameTimeMs:i>0?s:0,maxFrameTimeMs:i>0?a:0,fps:u>0?1e3/u:0,avgFps:o>0?1e3/o:0,jank16Count:this.jank16Count,jank33Count:this.jank33Count,totalFrames:this.totalFrames,drawCalls:this.lastDrawCalls,glassElements:this.lastGlassElements,perElementFboCount:this.lastPerElementFboCount,pingPongCount:this.lastPingPongCount,nonGlassElements:this.lastNonGlassElements,blurPasses:this.lastBlurPasses,dirtyElements:this.lastDirtyElements,totalElements:this.lastTotalElements,cachedElements:this.lastCachedElements,gpuVendor:this.gpuVendor,gpuRenderer:this.gpuRenderer,maxTextureSize:this.maxTextureSize,extensionCount:this.extensionCount,isSoftwareRenderer:this.isSoftwareRenderer,canvasCssW:this.canvasCssW,canvasCssH:this.canvasCssH,canvasDevW:this.canvasDevW,canvasDevH:this.canvasDevH,dpr:this.dpr,deviceDpr:this.deviceDpr,pixelsPerFrame:this.canvasDevW*this.canvasDevH,history:r,timestamp:performance.now()}}};var rr={createFBO(e,r){let t=this.gl,s=t.createTexture();t.bindTexture(t.TEXTURE_2D,s),t.texImage2D(t.TEXTURE_2D,0,t.RGBA,e,r,0,t.RGBA,t.UNSIGNED_BYTE,null),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MAG_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_S,t.CLAMP_TO_EDGE),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_T,t.CLAMP_TO_EDGE);let a=t.createFramebuffer();return t.bindFramebuffer(t.FRAMEBUFFER,a),t.framebufferTexture2D(t.FRAMEBUFFER,t.COLOR_ATTACHMENT0,t.TEXTURE_2D,s,0),t.bindFramebuffer(t.FRAMEBUFFER,null),{fb:a,tex:s}},resizeFBOs(e,r,t=!1){if(!t&&this.fboW===e&&this.fboH===r&&this.fboA&&this.fboB)return;let s=this.gl;this.fboA&&s.deleteFramebuffer(this.fboA),this.fboATex&&s.deleteTexture(this.fboATex),this.fboB&&s.deleteFramebuffer(this.fboB),this.fboBTex&&s.deleteTexture(this.fboBTex);let a=this.createFBO(e,r),i=this.createFBO(e,r);this.fboA=a.fb,this.fboATex=a.tex,this.fboB=i.fb,this.fboBTex=i.tex,this.tabsBackdropFbo&&s.deleteFramebuffer(this.tabsBackdropFbo),this.tabsBackdropTex&&s.deleteTexture(this.tabsBackdropTex);let o=this.createFBO(e,r);this.tabsBackdropFbo=o.fb,this.tabsBackdropTex=o.tex,this.tabsBackdropDirty=!0,this.wallpaperBlurFbo&&s.deleteFramebuffer(this.wallpaperBlurFbo),this.wallpaperBlurTex&&s.deleteTexture(this.wallpaperBlurTex),this.blurFboA&&s.deleteFramebuffer(this.blurFboA),this.blurFboATex&&s.deleteTexture(this.blurFboATex),this.blurFboB&&s.deleteFramebuffer(this.blurFboB),this.blurFboBTex&&s.deleteTexture(this.blurFboBTex),this.dsBlurFboA&&s.deleteFramebuffer(this.dsBlurFboA),this.dsBlurFboATex&&s.deleteTexture(this.dsBlurFboATex),this.dsBlurFboB&&s.deleteFramebuffer(this.dsBlurFboB),this.dsBlurFboBTex&&s.deleteTexture(this.dsBlurFboBTex);for(let v of this.dsBlurLevels)s.deleteFramebuffer(v.fboA),s.deleteTexture(v.texA),s.deleteFramebuffer(v.fboB),s.deleteTexture(v.texB);this.dsBlurLevels=[];let u=Math.max(1,this.blurDownsample),l=u<=1?1:Math.max(1,Math.min(u*(this.dpr||1),64));this.effectiveBlurDownsample=l;let f=this.createFBO(e,r),c=this.createFBO(e,r),n=this.createFBO(e,r);this.wallpaperBlurFbo=f.fb,this.wallpaperBlurTex=f.tex,this.blurFboA=c.fb,this.blurFboATex=c.tex,this.blurFboB=n.fb,this.blurFboBTex=n.tex;let h=Math.max(1,Math.floor(e/l)),m=Math.max(1,Math.floor(r/l)),x=this.createFBO(h,m),p=this.createFBO(h,m);this.dsBlurFboA=x.fb,this.dsBlurFboATex=x.tex,this.dsBlurFboB=p.fb,this.dsBlurFboBTex=p.tex,this.dsBlurFboW=h,this.dsBlurFboH=m;let g=[];for(let v=1;v<=l;v*=2)g.push(v);for(let v of g){let E=Math.max(1,Math.floor(e/v)),A=Math.max(1,Math.floor(r/v)),B=this.createFBO(E,A),R=this.createFBO(E,A);this.dsBlurLevels.push({ds:v,fboA:B.fb,texA:B.tex,fboB:R.fb,texB:R.tex,w:E,h:A})}this.highlightMaskFbo&&s.deleteFramebuffer(this.highlightMaskFbo),this.highlightMaskTex&&s.deleteTexture(this.highlightMaskTex);let C=this.createFBO(e,r);this.highlightMaskFbo=C.fb,this.highlightMaskTex=C.tex,this.dialogBackdropFbo&&s.deleteFramebuffer(this.dialogBackdropFbo),this.dialogBackdropTex&&s.deleteTexture(this.dialogBackdropTex);let S=this.createFBO(e,r);this.dialogBackdropFbo=S.fb,this.dialogBackdropTex=S.tex,this.dialogBackdropKey=null,this.bgOnlyFbo&&s.deleteFramebuffer(this.bgOnlyFbo),this.bgOnlyTex&&s.deleteTexture(this.bgOnlyTex);let T=this.createFBO(e,r);this.bgOnlyFbo=T.fb,this.bgOnlyTex=T.tex;let b=this.fboW!==e||this.fboH!==r;this.fboW=e,this.fboH=r,b&&this.clearBackdropBlurCache()},clearBackdropBlurCache(){let e=this.gl;for(let r of this.backdropBlurCache.values())e.deleteTexture(r.tex),e.deleteFramebuffer(r.fb);this.backdropBlurCache.clear();for(let r of this.backdropBlurCacheFboPool)e.deleteTexture(r.tex),e.deleteFramebuffer(r.fb);this.backdropBlurCacheFboPool.length=0,this.backdropBlurCacheSnapshots.length=0,this.cacheCopyReadFbo&&(e.deleteFramebuffer(this.cacheCopyReadFbo),this.cacheCopyReadFbo=null)},evictBackdropBlurCacheIfNeeded(){for(;this.backdropBlurCache.size>this.backdropBlurCacheMax;){let e=this.backdropBlurCache.keys().next().value;if(!e)break;let r=this.backdropBlurCache.get(e);r&&this.releaseCacheFBO(r),this.backdropBlurCache.delete(e)}for(;this.backdropBlurCacheSnapshots.length>this.backdropBlurCacheMax;)this.backdropBlurCacheSnapshots.shift()},acquireCacheFBO(e,r){let t=this.backdropBlurCacheFboPool;for(let a=t.length-1;a>=0;a--){let i=t[a];if(i.w===e&&i.h===r)return t.splice(a,1),i}let s=this.createFBO(e,r);return{fb:s.fb,tex:s.tex,w:e,h:r}},releaseCacheFBO(e){this.backdropBlurCacheFboPool.push(e)},bindFBO(e){let r=this.gl;r.bindFramebuffer(r.FRAMEBUFFER,e),r.viewport(0,0,this.fboW,this.fboH)},drawCopy(e){let r=this.gl;r.useProgram(this.copyProgram),r.bindBuffer(r.ARRAY_BUFFER,this.quadBuffer),r.enableVertexAttribArray(this.aPosLocCp),r.vertexAttribPointer(this.aPosLocCp,2,r.FLOAT,!1,0,0),r.activeTexture(r.TEXTURE0),r.bindTexture(r.TEXTURE_2D,e),r.uniform1i(this.uCp.uTexture,0),r.uniform2f(this.uCp.uCanvasSize,this.fboW,this.fboH),r.disable(r.BLEND),r.drawArrays(r.TRIANGLES,0,6)},drawSolidFill(e,r,t,s){let a=this.gl;a.useProgram(this.solidFillProgram),a.bindBuffer(a.ARRAY_BUFFER,this.quadBuffer),a.enableVertexAttribArray(this.aPosLocSf),a.vertexAttribPointer(this.aPosLocSf,2,a.FLOAT,!1,0,0),a.uniform4f(this.uSf.uColor,e,r,t,s),a.disable(a.BLEND),a.drawArrays(a.TRIANGLES,0,6)},drawColorControls(e,r,t,s){let a=this.gl;a.useProgram(this.colorControlsProgram),a.bindBuffer(a.ARRAY_BUFFER,this.quadBuffer),a.enableVertexAttribArray(this.aPosLocCc),a.vertexAttribPointer(this.aPosLocCc,2,a.FLOAT,!1,0,0),a.activeTexture(a.TEXTURE0),a.bindTexture(a.TEXTURE_2D,e),a.uniform1i(this.uCc.uTexture,0),a.uniform2f(this.uCc.uTexSize,this.fboW,this.fboH),a.uniform1f(this.uCc.uBrightness,r),a.uniform1f(this.uCc.uContrast,t),a.uniform1f(this.uCc.uSaturation,s),a.disable(a.BLEND),a.drawArrays(a.TRIANGLES,0,6)},ensureElementFBO(e,r){let t=Math.max(1,Math.round(e)),s=Math.max(1,Math.round(r));if(this.elFboW===t&&this.elFboH===s&&this.elFbo&&this.backdropCropFbo&&this.elBlurFboA&&this.elBlurFboB)return{w:t,h:s};let a=this.gl;this.elFbo&&a.deleteFramebuffer(this.elFbo),this.elFboTex&&a.deleteTexture(this.elFboTex);let i=this.createFBO(t,s);this.elFbo=i.fb,this.elFboTex=i.tex,this.backdropCropFbo&&a.deleteFramebuffer(this.backdropCropFbo),this.backdropCropTex&&a.deleteTexture(this.backdropCropTex);let o=this.createFBO(t,s);this.backdropCropFbo=o.fb,this.backdropCropTex=o.tex,this.elBlurFboA&&a.deleteFramebuffer(this.elBlurFboA),this.elBlurFboATex&&a.deleteTexture(this.elBlurFboATex),this.elBlurFboB&&a.deleteFramebuffer(this.elBlurFboB),this.elBlurFboBTex&&a.deleteTexture(this.elBlurFboBTex);let u=this.createFBO(t,s),l=this.createFBO(t,s);return this.elBlurFboA=u.fb,this.elBlurFboATex=u.tex,this.elBlurFboB=l.fb,this.elBlurFboBTex=l.tex,this.elFboW=t,this.elFboH=s,{w:t,h:s}},cropAndBlurBackdrop(e,r,t,s,a,i){let o=this.gl,u=this.elFboW,l=this.elFboH;if(o.bindFramebuffer(o.FRAMEBUFFER,this.backdropCropFbo),o.viewport(0,0,u,l),o.disable(o.BLEND),o.useProgram(this.elFboCropProgram),o.bindBuffer(o.ARRAY_BUFFER,this.quadBuffer),o.enableVertexAttribArray(this.aPosLocEc),o.vertexAttribPointer(this.aPosLocEc,2,o.FLOAT,!1,0,0),o.activeTexture(o.TEXTURE0),o.bindTexture(o.TEXTURE_2D,e),o.uniform1i(this.uEc.uTexture,0),o.uniform2f(this.uEc.uSrcOffset,r,t),o.uniform2f(this.uEc.uSrcSize,this.fboW,this.fboH),o.uniform2f(this.uEc.uDstSize,u,l),o.drawArrays(o.TRIANGLES,0,6),i<.5)return this.backdropCropTex;if(this.useKawaseBlur){let c=Be(i,this.kawaseQuality),n=i*Math.sqrt(6*c/((c+1)*(2*c+1)));this.lastBlurStats={type:"kawase",passes:c,taps:4*c,maxSample:n*Math.SQRT2},this.ensureKawaseProgram();let h=this.kawasePrograms,m=o.getParameter(o.FRAMEBUFFER_BINDING),x=o.isEnabled(o.SCISSOR_TEST),p=o.getParameter(o.SCISSOR_BOX);o.disable(o.SCISSOR_TEST),o.disable(o.BLEND);let g=this.backdropCropTex;for(let S=0;S<c;S++){let T=S%2===0,b=T?this.elBlurFboA:this.elBlurFboB;o.bindFramebuffer(o.FRAMEBUFFER,b),o.viewport(0,0,u,l),o.useProgram(h.prog),o.bindBuffer(o.ARRAY_BUFFER,this.quadBuffer),o.enableVertexAttribArray(h.aPos),o.vertexAttribPointer(h.aPos,2,o.FLOAT,!1,0,0),o.activeTexture(o.TEXTURE0),o.bindTexture(o.TEXTURE_2D,g),o.uniform1i(h.uTexture,0),o.uniform2f(h.uTexSize,u,l),o.uniform1f(h.uRadius,i),o.uniform1f(h.uIteration,S),o.uniform1f(h.uTotalIters,c),o.drawArrays(o.TRIANGLES,0,6),g=T?this.elBlurFboATex:this.elBlurFboBTex}return o.bindFramebuffer(o.FRAMEBUFFER,m),o.viewport(0,0,this.fboW,this.fboH),x&&(o.enable(o.SCISSOR_TEST),o.scissor(p[0],p[1],p[2],p[3])),(c-1)%2===0?this.elBlurFboATex:this.elBlurFboBTex}let f=Me(i);return f=Math.min(f,Math.max(1,this.blurTapCap|0)),this.lastBlurStats={type:"gauss",passes:2,taps:f,maxSample:3*i},this.runBlurPasses(this.backdropCropTex,this.elBlurFboA,this.elBlurFboATex,this.elBlurFboB,this.elBlurFboBTex,u,l,i,f,!0)},drawElFboComposite(e,r,t,s,a,i,o,u){let l=this.gl;l.useProgram(this.elFboCompositeProgram),l.bindBuffer(l.ARRAY_BUFFER,this.quadBuffer),l.enableVertexAttribArray(this.aPosLocEf),l.vertexAttribPointer(this.aPosLocEf,2,l.FLOAT,!1,0,0),l.activeTexture(l.TEXTURE0),l.bindTexture(l.TEXTURE_2D,e),l.uniform1i(this.uEf.uTexture,0),l.uniform2f(this.uEf.uCanvasSize,this.fboW,this.fboH),l.uniform2f(this.uEf.uElementCenter,s,a),l.uniform2f(this.uEf.uElementSize,i,o),l.uniform1f(this.uEf.uRotation,u),l.uniform2f(this.uEf.uSrcSize,r,t),l.enable(l.BLEND),l.blendFuncSeparate(l.ONE,l.ONE_MINUS_SRC_ALPHA,l.ONE,l.ONE_MINUS_SRC_ALPHA),l.drawArrays(l.TRIANGLES,0,6)},intersectClipScissor(e,r,t,s,a){let i=e.clipRect;if(!i)return{x:r,y:t,w:s,h:a};let o=Math.round(i.x*this.dpr),u=Math.round((this.cssHeight-(i.y+i.h))*this.dpr),l=Math.round(i.w*this.dpr),f=Math.round(i.h*this.dpr),c=Math.max(r,o),n=Math.max(t,u),h=Math.min(r+s,o+l),m=Math.min(t+a,u+f);return{x:c,y:n,w:Math.max(0,h-c),h:Math.max(0,m-n)}}};var le=1.4142135623730951,ns=.7853981633974483,he=.7071067811865476;function Tt(e,r,t,s){let a=(3*t/e-r*r/(e*e))/3,i=(2*r*r*r/(e*e*e)-9*r*t/(e*e)+27*s/e)/27,o=i*i/4+a*a*a/27,u=Math.sqrt(o);return Math.cbrt(-i/2+u)+Math.cbrt(-i/2-u)-r/(3*e)}function ls(e,r,t){let s=-e/2,a=-t,i=t*e/2-r*r/8,o=(3*a-s*s)/3,u=(2*s*s*s-9*s*a+27*i)/27,l=Math.sqrt(-o*o*o/27),f=Math.acos(-u/(2*l)),n=2*Math.sqrt(-o/3)*Math.cos(f/3)-s/3,h=Math.sqrt(2*n-e);return(h-Math.sqrt(h*h-4*(n+r/(2*h))))/2}var vt=class{constructor(r=2/3,t=.5){d(this,"extendedFraction");d(this,"arcFraction");d(this,"theta");d(this,"cos");d(this,"sin");d(this,"cot");d(this,"cos2");d(this,"sin2");d(this,"cos3");d(this,"sin3");d(this,"k0");d(this,"k1");d(this,"k2");d(this,"k3");this.extendedFraction=r,this.arcFraction=t,this.theta=(1-t)*ns,this.cos=Math.cos(this.theta),this.sin=Math.sin(this.theta),this.cot=1/Math.tan(this.theta),this.cos2=this.cos*this.cos,this.sin2=this.sin*this.sin,this.cos3=this.cos2*this.cos,this.sin3=this.sin2*this.sin;let s=this.cos,a=this.sin,i=this.cot,o=this.cos2,u=this.sin2,l=this.cos3,f=this.sin3;this.k0=27*(le-6*s+6*le*o-4*l)*i+2*a*(-9+2*(le-2*a)*f+2*le*s*(9+u)-2*o*(9+2*u)),this.k1=-81*(-2+le+4*(-1+le)*s+2*(-2+le)*o)*i-4*a*(-9+9*le+le*f+(-2+le)*s*(9+u)),this.k2=9*(9*(-4+3*le+(-6+4*le)*s)*i+(-6+4*le)*a),this.k3=27*(10-7*le)*i}buildEvenCornerBezierPoints(r){let t=this.extendedFraction*r,s=Tt(this.k3,this.k2,this.k1+8*-t*this.sin3*this.sin,this.k0),a=he+(-he+this.sin)/s,i=1-he+(he-this.cos)/s,o=a-i*this.cot,u=o-1.5*s*i*i/this.sin3,l=-t,f=1-i,c=1-a,n=1-o,h=1-u,m=1-l,x=1.5*s,p=this.cos2-this.sin2,g=f-a,C=c-i,S=-(this.cos*C-this.sin*g),T=(-p+Math.sqrt(p*p-4*x*S))/(2*x),b=a+T*this.cos,v=i+T*this.sin,E=f-T*this.sin,A=c-T*this.cos;return[l,0,u,0,o,0,a,i,b,v,E,A,f,c,1,n,1,h,1,m]}buildUnevenCornerBezierPoints(r,t){let s=this.extendedFraction*r,a=this.extendedFraction*t,i=Tt(this.k3,this.k2,this.k1+8*-s*this.sin3*this.sin,this.k0),o=Tt(this.k3,this.k2,this.k1+8*-a*this.sin3*this.sin,this.k0),u=he+(-he+this.sin)/i,l=1-he+(he-this.cos)/i,f=u-l*this.cot,c=f-1.5*i*l*l/this.sin3,n=-s,h=he+(-he+this.sin)/o,m=1-he+(he-this.cos)/o,x=h-m*this.cot,p=x-1.5*o*m*m/this.sin3,g=-a,C=1-m,S=1-h,T=1-x,b=1-p,v=1-g,E=1.5*i,A=1.5*o,B=this.cos2-this.sin2,R=C-u,y=S-l,M=-(this.cos*y-this.sin*R),w=this.sin*y-this.cos*R,I=2*(w/A),k=B*B*B/(E*A*A),H=(E*w*w+M*B*B)/(E*A*A),L=ls(I,k,H),P=(-w-A*L*L)/B,X=u+P*this.cos,$=l+P*this.sin,V=C-L*this.sin,G=S-L*this.cos;return[n,0,c,0,f,0,u,l,X,$,V,G,C,S,1,T,1,b,1,v]}getCornerBezierPoints(r,t){let s=r===0?0:r===1?1:-1,a=t===0?0:t===1?1:-1;return s>=0&&a>=0?s===0&&a===0?this.buildEvenCornerBezierPoints(0):s===1&&a===1?this.buildEvenCornerBezierPoints(1):this.buildUnevenCornerBezierPoints(s===1?1:0,a===1?1:0):this.buildUnevenCornerBezierPoints(Math.max(0,Math.min(1,r)),Math.max(0,Math.min(1,t)))}};function Ee(e,r,t,s){let a=new vt,i=s,o=Math.max(0,Math.min(1,(r*.5-i)/i)),u=Math.max(0,Math.min(1,(t*.5-i)/i)),l=a.getCornerBezierPoints(o,u);if(l.length<20)return new Path2D;let f=new Path2D,c=r-i,n=0;return f.moveTo(c+l[0]*i,n+l[1]*i),f.bezierCurveTo(c+l[2]*i,n+l[3]*i,c+l[4]*i,n+l[5]*i,c+l[6]*i,n+l[7]*i),f.bezierCurveTo(c+l[8]*i,n+l[9]*i,c+l[10]*i,n+l[11]*i,c+l[12]*i,n+l[13]*i),f.bezierCurveTo(c+l[14]*i,n+l[15]*i,c+l[16]*i,n+l[17]*i,c+l[18]*i,n+l[19]*i),c=r-i,n=t,f.lineTo(c+l[18]*i,n-l[19]*i),f.bezierCurveTo(c+l[16]*i,n-l[17]*i,c+l[14]*i,n-l[15]*i,c+l[12]*i,n-l[13]*i),f.bezierCurveTo(c+l[10]*i,n-l[11]*i,c+l[8]*i,n-l[9]*i,c+l[6]*i,n-l[7]*i),f.bezierCurveTo(c+l[4]*i,n-l[5]*i,c+l[2]*i,n-l[3]*i,c+l[0]*i,n-l[1]*i),c=i,n=t,f.lineTo(c-l[0]*i,n-l[1]*i),f.bezierCurveTo(c-l[2]*i,n-l[3]*i,c-l[4]*i,n-l[5]*i,c-l[6]*i,n-l[7]*i),f.bezierCurveTo(c-l[8]*i,n-l[9]*i,c-l[10]*i,n-l[11]*i,c-l[12]*i,n-l[13]*i),f.bezierCurveTo(c-l[14]*i,n-l[15]*i,c-l[16]*i,n-l[17]*i,c-l[18]*i,n-l[19]*i),c=i,n=0,f.lineTo(c-l[18]*i,n+l[19]*i),f.bezierCurveTo(c-l[16]*i,n+l[17]*i,c-l[14]*i,n+l[15]*i,c-l[12]*i,n+l[13]*i),f.bezierCurveTo(c-l[10]*i,n+l[11]*i,c-l[8]*i,n+l[9]*i,c-l[6]*i,n+l[7]*i),f.bezierCurveTo(c-l[4]*i,n+l[5]*i,c-l[2]*i,n+l[3]*i,c-l[0]*i,n+l[1]*i),f.closePath(),f}var pe=new Map,us=32*1024*1024,Ct=0,Et=new Uint8Array(16384),sr=new Int32Array(16384),ar=new Int32Array(16384),ir=new Uint8Array(16384*4),or=32,Re=[];function nr(){return Array.from(pe.entries()).map(([e,r])=>({key:e,tex:r.tex,texSize:r.texSize}))}function lr(e,r,t,s=1,a=1,i=!1){let u=Math.max(e,r)*(s||1)*2,l=128;for(;l<u&&l<1024;)l<<=1;let f=Math.max(32,Math.ceil(l*a)),c=`${e},${r},${t},${f},s${i?1:0}`,n=pe.get(c);if(n)return pe.delete(c),pe.set(c,n),Re.length>=or&&Re.shift(),Re.push({timestamp:performance.now(),key:c,w:e,h:r,radius:t,texSize:f,cacheHit:!0,stepCanvasSetup:0,stepPathDraw:0,stepGetImageData:0,stepAlphaExtract:0,stepInitArrays:0,stepForwardPass:0,stepBackwardPass:0,stepPack:0,stepTotal:0}),{tex:n.tex,texSize:f};let h=performance.now(),m=Math.max(e,r),x=e/m,p=r/m,g=document.createElement("canvas");g.width=f,g.height=f;let C=g.getContext("2d",{willReadFrequently:!0});C.clearRect(0,0,f,f);let S=performance.now(),T=4,b=(f-2*T)*x,v=(f-2*T)*p,E=(f-b)/2,A=(f-v)/2,B=b/e,R=t*B,y=Ee(C,b,v,R);C.fillStyle="white",C.translate(E,A),C.fill(y),C.translate(-E,-A);let M=performance.now(),w=C.getImageData(0,0,f,f),I=performance.now(),k=f*f;Et.length<k&&(Et=new Uint8Array(k),sr=new Int32Array(k),ar=new Int32Array(k),ir=new Uint8Array(k*4));let H=Et,L=sr,P=ar,X=2147483647,$=new Uint32Array(w.data.buffer);for(let F=0;F<k;F++){let O=$[F]>>>24&255;H[F]=O,O>128?(L[F]=0,P[F]=X):(L[F]=X,P[F]=0)}let V=performance.now(),G=V,_=G,Z=G;if(!i){let F=f;for(let O=0;O<F;O++)for(let K=0;K<F;K++){let Y=O*F+K,D=L[Y],z=P[Y];if(K>0&&O>1){let U=Y-F-1-F,W=11,N=L[U]+W;N<D&&(D=N);let q=P[U]+W;q<z&&(z=q)}if(K>0){let U=Y-1,W=5,N=L[U]+W;N<D&&(D=N);let q=P[U]+W;q<z&&(z=q)}if(K>0&&O>0){let U=Y-F-1,W=7,N=L[U]+W;N<D&&(D=N);let q=P[U]+W;q<z&&(z=q)}if(O>0){let U=Y-F,W=5,N=L[U]+W;N<D&&(D=N);let q=P[U]+W;q<z&&(z=q)}if(K<F-1&&O>0){let U=Y-F+1,W=7,N=L[U]+W;N<D&&(D=N);let q=P[U]+W;q<z&&(z=q)}if(K<F-2&&O>0){let U=Y-F+2,W=11,N=L[U]+W;N<D&&(D=N);let q=P[U]+W;q<z&&(z=q)}L[Y]=D,P[Y]=z}_=performance.now();for(let O=F-1;O>=0;O--)for(let K=F-1;K>=0;K--){let Y=O*F+K,D=L[Y],z=P[Y];if(K<F-1&&O<F-2){let U=Y+F+1+F,W=11,N=L[U]+W;N<D&&(D=N);let q=P[U]+W;q<z&&(z=q)}if(K<F-1){let U=Y+1,W=5,N=L[U]+W;N<D&&(D=N);let q=P[U]+W;q<z&&(z=q)}if(K<F-1&&O<F-1){let U=Y+F+1,W=7,N=L[U]+W;N<D&&(D=N);let q=P[U]+W;q<z&&(z=q)}if(O<F-1){let U=Y+F,W=5,N=L[U]+W;N<D&&(D=N);let q=P[U]+W;q<z&&(z=q)}if(K>0&&O<F-1){let U=Y+F-1,W=7,N=L[U]+W;N<D&&(D=N);let q=P[U]+W;q<z&&(z=q)}if(K>1&&O<F-1){let U=Y+F-2,W=11,N=L[U]+W;N<D&&(D=N);let q=P[U]+W;q<z&&(z=q)}L[Y]=D,P[Y]=z}Z=performance.now()}let j=R,se=ir,de=new Uint32Array(se.buffer),oe=4278190080;if(i)for(let F=0;F<k;F++)de[F]=oe|H[F];else for(let F=0;F<k;F++){let O=(L[F]-P[F])/5,Y=((O/j>1?1:O/j<-1?-1:O/j)*.5+.5)*255+.5|0;de[F]=oe|Y<<8|H[F]}let ne=performance.now(),re=se.slice(0,k*4);for(pe.set(c,{tex:re,texSize:f}),Ct+=re.byteLength;Ct>us&&pe.size>1;){let F=pe.keys().next().value;if(F===void 0)break;let O=pe.get(F);O&&(Ct-=O.tex.byteLength),pe.delete(F)}return Re.length>=or&&Re.shift(),Re.push({timestamp:ne,key:c,w:e,h:r,radius:t,texSize:f,cacheHit:!1,stepCanvasSetup:S-h,stepPathDraw:M-S,stepGetImageData:I-M,stepAlphaExtract:V-I,stepInitArrays:0,stepForwardPass:_-G,stepBackwardPass:Z-_,stepPack:ne-Z,stepTotal:ne-h}),{tex:se,texSize:f}}var ur={async loadWallpaper(e){let r=new Image;r.crossOrigin="anonymous",await new Promise((u,l)=>{r.onload=()=>u(),r.onerror=()=>l(new Error("Failed to load wallpaper: "+e)),r.src=e});let t=this.gl;this.wallpaperTexture&&t.deleteTexture(this.wallpaperTexture);let s=t.createTexture();t.bindTexture(t.TEXTURE_2D,s),t.pixelStorei(t.UNPACK_FLIP_Y_WEBGL,!1),t.texImage2D(t.TEXTURE_2D,0,t.RGBA,t.RGBA,t.UNSIGNED_BYTE,r);let a=r.naturalWidth,i=r.naturalHeight;(a&a-1)===0&&(i&i-1)===0?(t.generateMipmap(t.TEXTURE_2D),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.LINEAR_MIPMAP_LINEAR)):t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MAG_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_S,t.CLAMP_TO_EDGE),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_T,t.CLAMP_TO_EDGE),this.wallpaperTexture=s,this.wallpaperSize=[a||1,i||1],this.wallpaperReady=!0,this.clearBackdropBlurCache(),this.wallpaperVersion++,this.markAllDirty(),this.requestRender()},async loadSdfTexture(e){let r=new Image;r.crossOrigin="anonymous",await new Promise((a,i)=>{r.onload=()=>a(),r.onerror=()=>i(new Error("Failed to load SDF texture: "+e)),r.src=e});let t=this.gl;this.sdfTexture&&t.deleteTexture(this.sdfTexture);let s=t.createTexture();t.bindTexture(t.TEXTURE_2D,s),t.pixelStorei(t.UNPACK_FLIP_Y_WEBGL,!1),t.texImage2D(t.TEXTURE_2D,0,t.RGBA,t.RGBA,t.UNSIGNED_BYTE,r),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MAG_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_S,t.CLAMP_TO_EDGE),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_T,t.CLAMP_TO_EDGE),this.sdfTexture=s,this.sdfTextureSize=[r.naturalWidth||1,r.naturalHeight||1],this.sdfTextureReady=!0,this.markAllDirty(),this.requestRender()},loadSdfTextureFromData(e,r,t){this.loadTextSdfTextureFromData(e,r,t)},loadTextSdfTextureFromData(e,r,t){if(r<1||t<1)return;let s=this.gl;this.textSdfTexture&&s.deleteTexture(this.textSdfTexture);let a=s.createTexture();s.bindTexture(s.TEXTURE_2D,a),s.pixelStorei(s.UNPACK_FLIP_Y_WEBGL,!1),s.texImage2D(s.TEXTURE_2D,0,s.RGBA,r,t,0,s.RGBA,s.UNSIGNED_BYTE,e),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_MIN_FILTER,s.LINEAR),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_MAG_FILTER,s.LINEAR),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_WRAP_S,s.CLAMP_TO_EDGE),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_WRAP_T,s.CLAMP_TO_EDGE),this.textSdfTexture=a,this.textSdfTextureSize=[r,t],this.textSdfTextureReady=!0,this.markAllDirty(),this.requestRender()},loadContinuousSdf(e,r,t){let s=this.debugSdfHoleTopLeftR,a=this.debugSdfHoleTopLeftG,i=!!this.noContinuousSdf,o=this.capsuleSdfQuality,u=`${e},${r},${t},${this.dpr},q${o},s${i?1:0},r${s?1:0},g${a?1:0}`,l=this.continuousSdfPool.get(u);if(l)this._lastCapsuleUploadMs=0,this._lastCapsuleGenMs=0,this._lastCapsuleKey=u+" (pool hit)";else{let f=performance.now(),{tex:c,texSize:n}=lr(e,r,t,this.dpr,this.capsuleSdfQuality,i),h=performance.now(),m=this.gl,x=m.createTexture();m.bindTexture(m.TEXTURE_2D,x),m.pixelStorei(m.UNPACK_FLIP_Y_WEBGL,!0);let p=c;if(s||a){p=c.slice();let S=n>>1;for(let T=0;T<S;T++){let b=T*n*4;for(let v=0;v<S;v++){let E=b+v*4;s&&(p[E]=0),a&&(p[E+1]=0)}}}let g=performance.now();m.texImage2D(m.TEXTURE_2D,0,m.RGBA,n,n,0,m.RGBA,m.UNSIGNED_BYTE,p),m.finish();let C=performance.now();if((s||a)&&this._debugUploadedSdfTexMap.set(u,{tex:p.slice(),texSize:n}),m.texParameteri(m.TEXTURE_2D,m.TEXTURE_MIN_FILTER,m.LINEAR),m.texParameteri(m.TEXTURE_2D,m.TEXTURE_MAG_FILTER,m.LINEAR),m.texParameteri(m.TEXTURE_2D,m.TEXTURE_WRAP_S,m.CLAMP_TO_EDGE),m.texParameteri(m.TEXTURE_2D,m.TEXTURE_WRAP_T,m.CLAMP_TO_EDGE),l={tex:x,texSize:n},this.continuousSdfPool.set(u,l),this._lastCapsuleUploadMs=C-g,this._lastCapsuleGenMs=h-f,this._lastCapsuleKey=u,this.continuousSdfPool.size>16){let S=this.continuousSdfPool.keys().next().value;if(S){let T=this.continuousSdfPool.get(S);T&&m.deleteTexture(T.tex),this.continuousSdfPool.delete(S)}}}this.continuousSdfTexture=l.tex,this.continuousSdfTexSize=[l.texSize,l.texSize],this.continuousSdfKey=u},resize(e,r){this.dpr<=0&&(this.dpr=Math.min(window.devicePixelRatio||1,3));let t=Math.round(e*this.dpr),s=Math.round(r*this.dpr);(this.canvas.width!==t||this.canvas.height!==s)&&(this.canvas.width=t,this.canvas.height=s,this.gl.viewport(0,0,t,s),this.resizeFBOs(t,s));for(let a of this.buttonConfigs)this.fgDirtyIds.add(a.id);if(this.cssWidth=e,this.cssHeight=r,this.elFboCache.size>0){let a=this.gl;for(let i of this.elFboCache.values())a.deleteFramebuffer(i.fb),a.deleteTexture(i.tex);this.elFboCache.clear()}this.markAllDirty(),this.requestRender()}};var cr={setContentHeight(e){this.contentHeight=e,this.clampScrollY(),this.requestRender()},setScrollY(e){this.scrollVelocity=0,this.scrollY=this.clampScrollValue(e),this.requestRender()},setScrollVelocity(e){this.scrollVelocity=Math.max(-4e3,Math.min(4e3,e)),this.startAnimation()},getScrollY(){return this.scrollY},getScrollVelocity(){return this.scrollVelocity},clampScrollValue(e){let r=Math.max(0,this.contentHeight-this.cssHeight);return e<0?0:e>r?r:e},clampScrollY(){this.scrollY=this.clampScrollValue(this.scrollY)},setBackgroundColor(e){this.backgroundColor!==e&&(this.backgroundColor&&e&&this.backgroundColor[0]===e[0]&&this.backgroundColor[1]===e[1]&&this.backgroundColor[2]===e[2]||(this.backgroundColor=e,this.markAllDirty(),this.requestRender()))},setGravityAngle(e){Math.abs(this.gravityAngle-e)<.02||(this.gravityAngle=e,this.markGravityDirty(),this.requestRender())}};var Ue=class{constructor(){d(this,"samples",[])}resetTracking(){this.samples.length=0}addPosition(r,t){this.samples.push({t:r,p:t}),this.samples.length>20&&this.samples.shift()}calculateVelocity(r=100){let t=this.samples;if(t.length<2)return 0;let s=t[t.length-1].t,a=s-r,i=0,o=0,u=0,l=0,f=0;for(let h=t.length-1;h>=0;h--){let m=t[h];if(m.t<a)break;let x=(m.t-s)/1e3;o+=x,u+=m.p,l+=x*x,f+=x*m.p,i++}if(i<2)return 0;let c=i*l-o*o;return Math.abs(c)<1e-9?0:(i*f-o*u)/c}};var dr={ensureToggleState(e,r,t=1.5,s=1){let a=this.toggleStates.get(e);return a?(t!==1.5&&(a.pressedScale=t),s!==1&&(a.valueRangeSpan=s)):(a={fraction:r,fractionVelocity:0,targetFraction:r,pressProgress:0,pressVelocity:0,targetPress:0,scaleX:1,scaleXVelocity:0,targetScaleX:1,scaleY:1,scaleYVelocity:0,targetScaleY:1,velocity:0,velocityVelocity:0,targetVelocity:0,isDragging:!1,trackVelocityAfterRelease:!1,velocityTracker:new Ue,lastFractionForVelocity:r,lastFractionTime:0,pressedScale:t,valueRangeSpan:s,panelOffset:0,panelOffsetVelocity:0,targetPanelOffset:0},this.toggleStates.set(e,a)),a},setToggleTarget(e,r){let t=this.ensureToggleState(e,r);t.isDragging||t.targetFraction!==r&&(t.targetFraction=r,t.trackVelocityAfterRelease=!1,t.targetVelocity=0,t.velocity=0,t.velocityVelocity=0,t.velocityTracker.resetTracking(),t.targetPress===0&&(t.targetPress=1,t.targetScaleX=t.pressedScale,t.targetScaleY=t.pressedScale),this.markGroupDirty(e),this.startAnimation())},beginToggleDrag(e,r){let t=this.ensureToggleState(e,r);t.isDragging=!0,t.targetPress=1,t.targetScaleX=t.pressedScale,t.targetScaleY=t.pressedScale,t.velocityTracker.resetTracking(),t.targetVelocity=0,t.velocity=0,t.velocityVelocity=0,this.markGroupDirty(e),this.startAnimation()},dragToggle(e,r,t,s,a){let i=this.ensureToggleState(e,r);if(!i.isDragging)return;let o=(t-s)/Math.max(1,a),u=Math.max(0,Math.min(1,r+o));i.targetFraction=u,this.markGroupDirty(e),this.startAnimation()},endToggleDrag(e){let r=this.toggleStates.get(e);if(!r)return 0;r.isDragging=!1;let t=r.targetFraction>=.5?1:0;return r.targetFraction=t,r.trackVelocityAfterRelease=!0,this.markGroupDirty(e),this.startAnimation(),t},endSliderDrag(e){let r=this.toggleStates.get(e);if(!r)return 0;r.isDragging=!1;let t=r.targetFraction;return r.trackVelocityAfterRelease=!0,this.markGroupDirty(e),this.startAnimation(),t},getToggleFraction(e){return this.toggleStates.get(e)?.fraction??0},setSliderDragPosition(e,r){let t=this.toggleStates.get(e);if(!t)return;let s=Math.max(0,Math.min(1,r));t.targetFraction!==s&&(t.targetFraction=s,this.markGroupDirty(e),this.startAnimation())},getToggleTarget(e){return this.toggleStates.get(e)?.targetFraction??0}};var ue=1,ba=300,Sa=.5,Le=Math.sqrt(300),ye=Le*Math.sqrt(1-.5*.5),J=.003,cs=1e3,Rt=Math.sqrt(cs),ds=250,We=.6,yt=Math.sqrt(ds),xa=yt*Math.sqrt(1-We*We),hs=250,Ne=.7,wt=Math.sqrt(hs),Ta=wt*Math.sqrt(1-Ne*Ne),fs=300,Xe=.5,At=Math.sqrt(fs),va=At*Math.sqrt(1-Xe*Xe);function Pe(e,r,t,s){let a=e-t,i=r,o=Math.exp(-.5*Le*s),u=Math.cos(ye*s),l=Math.sin(ye*s),f=a*o*u+(i+.5*Le*a)/ye*o*l,c=(i+.5*Le*a)/ye,n=-.5*Le*f+o*(-a*ye*l+c*ye*u);return{current:t+f,velocity:n}}function qe(e,r,t,s,a){let i=e-t,o=r,u=Math.exp(-a*s),l=i*u+(o+a*i)*s*u,f=-a*i*u+(o+a*i)*(u-a*s*u);return{current:t+l,velocity:f}}function Ye(e,r,t,s,a,i){let o=e-t,u=r,l=a*Math.sqrt(1-i*i),f=Math.exp(-i*a*s),c=Math.cos(l*s),n=Math.sin(l*s),h=o*f*c+(u+i*a*o)/l*f*n,m=(u+i*a*o)/l,x=-i*a*h+f*(-o*l*n+m*l*c);return{current:t+h,velocity:x}}var hr={setTabSelected(e,r,t){let s=this.ensureToggleState(e,r,me.TAB_PRESSED_SCALE,t-1);s.isDragging||s.targetFraction!==r&&(s.targetFraction=r,s.trackVelocityAfterRelease=!1,s.targetVelocity=0,s.velocity=0,s.velocityVelocity=0,s.velocityTracker.resetTracking(),s.targetPress===0&&(s.targetPress=1,s.targetScaleX=s.pressedScale,s.targetScaleY=s.pressedScale),this.markGroupDirty(e),this.startAnimation())},beginTabDrag(e,r,t){let s=this.ensureToggleState(e,r,me.TAB_PRESSED_SCALE,t-1);s.isDragging=!0,s.targetPress=1,s.targetScaleX=s.pressedScale,s.targetScaleY=s.pressedScale,s.velocityTracker.resetTracking(),s.targetVelocity=0,s.velocity=0,s.velocityVelocity=0,this.markGroupDirty(e),this.startAnimation()},dragTab(e,r,t,s,a,i){let o=this.ensureToggleState(e,r,me.TAB_PRESSED_SCALE,i-1);if(!o.isDragging)return;let u=(t-s)/Math.max(1,a),l=Math.max(0,Math.min(i-1,r+u));o.targetFraction=l;let f=a*i,c=Math.max(-1,Math.min(1,(t-s)/Math.max(1,f))),n=1-Math.pow(1-Math.abs(c),2);o.targetPanelOffset=4*Math.sign(c)*n,this.markGroupDirty(e),this.startAnimation()},endTabDrag(e,r){let t=this.toggleStates.get(e);if(!t)return 0;t.isDragging=!1;let s=Math.round(t.targetFraction),a=Math.max(0,Math.min(r-1,s));return t.targetFraction=a,t.velocityTracker.resetTracking(),t.trackVelocityAfterRelease=!1,t.targetVelocity=0,t.targetPanelOffset=0,this.markGroupDirty(e),this.startAnimation(),a},getTabFraction(e){return this.toggleStates.get(e)?.fraction??0},getTabTarget(e){return this.toggleStates.get(e)?.targetFraction??0}};function fr(e){return JSON.stringify([e.rect.w,e.rect.h,e.cornerRadius,e.blurRadius,e.useSeparableBlur,e.scrimColor,e.surfaceColor,e.tintColor,e.independentBackdrop,e.sampleWallpaper,e.chromaticAberration,e.outerShadow,e.highlight,e.isMagnifier,e.isSdfTexture,e.enterProgress,e.enterSafeProgress,e.enterStretchFactor,e.useGravityAngle,e.elementRotation,e.backdropFbo,e.brightness,e.contrast,e.saturation,e.useContinuousSdf,e.isToggleKnob,e.isToggleTrack,e.isSliderFill,e.isBottomTabContainer,e.isBottomTabContent,e.isBottomTabIndicator,e.sceneBlurRadius,e.refractionHeight,e.refractionAmount,e.depthEffect])}var mr={setElements(e){this.setButtons(e)},setButtons(e){let r=new Set(this.buttonConfigs.map(o=>o.id)),t=new Set(e.map(o=>o.id));for(let o of t)r.has(o)||this.fgDirtyIds.add(o);for(let o of e){let u=this.buttonConfigs.find(S=>S.id===o.id);if(!u)continue;let l=(S,T)=>{if(!S||!T)return S===T;if(S.length!==T.length)return!1;for(let b=0;b<S.length;b++)if(S[b]!==T[b])return!1;return!0},f=u.text?.icon,c=o.text?.icon,n=!!f!=!!c||f&&c&&(f.path!==c.path||f.size!==c.size||!l(f.color,c.color)),h=u.icon,m=o.icon,x=!!h!=!!m||h&&m&&(h.path!==m.path||h.size!==m.size||!l(h.color,m.color)),p=u.text,g=o.text,C=!!p!=!!g||p&&g&&(!l(p.color,g.color)||p.halo!==g.halo||p.fontSizePx!==g.fontSizePx||p.fontWeight!==g.fontWeight||p.align!==g.align||p.wrap!==g.wrap||p.paddingPx!==g.paddingPx||p.valign!==g.valign||p.maxLines!==g.maxLines);(u.label!==o.label||!l(u.labelColor,o.labelColor)||u.showChevron!==o.showChevron||u.rect.w!==o.rect.w||u.rect.h!==o.rect.h||o.text&&u.text&&u.text.content!==o.text.content||o.text&&!u.text||!o.text&&u.text||n||x||C)&&this.fgDirtyIds.add(o.id)}for(let o of r)if(!t.has(o)){this.buttonStates.delete(o);let u=this.fgTextures.get(o);u&&(this.gl.deleteTexture(u),this.fgTextures.delete(o)),this.fgDirtyIds.delete(o),this.deleteElFboCacheEntry(o)}for(let o of e)this.buttonStates.has(o.id)||this.buttonStates.set(o.id,{pressProgress:0,pressVelocity:0,targetPress:0,dragX:0,dragY:0,dragVx:0,dragVy:0,targetDragX:0,targetDragY:0,startDragX:0,startDragY:0,interactiveValue:0,interactiveVelocity:0,targetInteractiveValue:0});let s=new Map;for(let o of this.buttonConfigs)s.set(o.id,fr(o));for(let o of e){let u=s.get(o.id);u!==void 0&&u!==fr(o)&&this.markElementDirty(o.id)}let a=this.buttonConfigs.some(o=>o.isBottomTabIndicator),i=e.some(o=>o.isBottomTabIndicator);!a&&i&&(this.pendingExtraRenders=1),this.buttonConfigs=e,this.requestRender()},setInteractiveValue(e,r){let t=this.buttonStates.get(e);t&&t.targetInteractiveValue!==r&&(t.targetInteractiveValue=r,this.markElementDirty(e),this.startAnimation(),this.requestRender())},setPressed(e,r,t){let s=this.buttonStates.get(e);if(s){if(r){let a=this.buttonConfigs.find(i=>i.id===e);if(a&&t){let i=t.x-a.rect.x,o=t.y-a.rect.y;s.targetPress===0&&(s.startDragX=i,s.startDragY=o,s.dragX=i,s.dragY=o,s.dragVx=0,s.dragVy=0),s.dragX=i,s.dragY=o,s.dragVx=0,s.dragVy=0,s.targetDragX=i,s.targetDragY=o}s.targetPress=1}else s.targetPress=0,s.targetDragX=s.startDragX,s.targetDragY=s.startDragY;this.markElementDirty(e),this.startAnimation()}},setDragPosition(e,r){let t=this.buttonStates.get(e);if(!t||t.targetPress===0)return;let s=this.buttonConfigs.find(o=>o.id===e);if(!s)return;let a=r.x-s.rect.x,i=r.y-s.rect.y;t.dragX=a,t.dragY=i,t.dragVx=0,t.dragVy=0,t.targetDragX=a,t.targetDragY=i,this.markElementDirty(e),this.requestRender()}};var gr={startAnimation(){if(this.animRafId!==null)return;let e=performance.now(),r=()=>{let t=performance.now(),s=Math.min((t-e)/1e3,.05);e=t;let a=!1;for(let[i,o]of this.buttonStates.entries()){let u=!1;if(Math.abs(o.targetPress-o.pressProgress)>J||Math.abs(o.pressVelocity)>J){let c=Pe(o.pressProgress,o.pressVelocity,o.targetPress,s);o.pressProgress=c.current,o.pressVelocity=c.velocity,a=!0,u=!0}else o.pressProgress=o.targetPress,o.pressVelocity=0;if(Math.abs(o.targetDragX-o.dragX)>J||Math.abs(o.dragVx)>J){let c=Pe(o.dragX,o.dragVx,o.targetDragX,s);o.dragX=c.current,o.dragVx=c.velocity,a=!0,u=!0}else o.dragX=o.targetDragX,o.dragVx=0;if(Math.abs(o.targetDragY-o.dragY)>J||Math.abs(o.dragVy)>J){let c=Pe(o.dragY,o.dragVy,o.targetDragY,s);o.dragY=c.current,o.dragVy=c.velocity,a=!0,u=!0}else o.dragY=o.targetDragY,o.dragVy=0;if(Math.abs(o.targetInteractiveValue-o.interactiveValue)>J||Math.abs(o.interactiveVelocity)>J){let c=Pe(o.interactiveValue,o.interactiveVelocity,o.targetInteractiveValue,s);o.interactiveValue=c.current,o.interactiveVelocity=c.velocity,a=!0,u=!0}else o.interactiveValue=o.targetInteractiveValue,o.interactiveVelocity=0;u&&this.markElementDirty(i)}for(let[i,o]of this.toggleStates){let u=!1;if(o.targetPress===1&&!o.isDragging&&Math.abs(o.targetFraction-o.fraction)<.02&&(o.targetPress=0,o.targetScaleX=1,o.targetScaleY=1,u=!0,this.startAnimation()),Math.abs(o.targetFraction-o.fraction)>J||Math.abs(o.fractionVelocity)>J){let x=qe(o.fraction,o.fractionVelocity,o.targetFraction,s,Rt);if(o.fraction=x.current,o.fractionVelocity=x.velocity,o.trackVelocityAfterRelease||o.isDragging){let p=performance.now();o.velocityTracker.addPosition(p,o.fraction);let g=o.velocityTracker.calculateVelocity(),C=o.valueRangeSpan||1;o.targetVelocity=g/C}a=!0,u=!0}else o.fraction=o.targetFraction,o.fractionVelocity=0,o.isDragging||(o.targetVelocity=0,o.trackVelocityAfterRelease=!1,o.velocityTracker.resetTracking());if(Math.abs(o.targetPress-o.pressProgress)>J||Math.abs(o.pressVelocity)>J){let x=qe(o.pressProgress,o.pressVelocity,o.targetPress,s,Rt);o.pressProgress=x.current,o.pressVelocity=x.velocity,a=!0,u=!0}else o.pressProgress=o.targetPress,o.pressVelocity=0;if(Math.abs(o.targetScaleX-o.scaleX)>J||Math.abs(o.scaleXVelocity)>J){let x=Ye(o.scaleX,o.scaleXVelocity,o.targetScaleX,s,yt,We);o.scaleX=x.current,o.scaleXVelocity=x.velocity,a=!0,u=!0}else o.scaleX=o.targetScaleX,o.scaleXVelocity=0;if(Math.abs(o.targetScaleY-o.scaleY)>J||Math.abs(o.scaleYVelocity)>J){let x=Ye(o.scaleY,o.scaleYVelocity,o.targetScaleY,s,wt,Ne);o.scaleY=x.current,o.scaleYVelocity=x.velocity,a=!0,u=!0}else o.scaleY=o.targetScaleY,o.scaleYVelocity=0;if(Math.abs(o.targetVelocity-o.velocity)>J||Math.abs(o.velocityVelocity)>J){let x=Ye(o.velocity,o.velocityVelocity,o.targetVelocity,s,At,Xe);o.velocity=x.current,o.velocityVelocity=x.velocity,a=!0,u=!0}else o.velocity=o.targetVelocity,o.velocityVelocity=0;if(Math.abs(o.targetPanelOffset-o.panelOffset)>J||Math.abs(o.panelOffsetVelocity)>J){let x=qe(o.panelOffset,o.panelOffsetVelocity,o.targetPanelOffset,s,Math.sqrt(300));o.panelOffset=x.current,o.panelOffsetVelocity=x.velocity,a=!0,u=!0}else o.panelOffset=o.targetPanelOffset,o.panelOffsetVelocity=0;u&&this.markGroupDirty(i)}if(Math.abs(this.scrollVelocity)>.5){let o=this.scrollY+this.scrollVelocity*s,u=this.clampScrollValue(o);u!==o?(this.scrollY=u,this.scrollVelocity=0):(this.scrollY=u,this.scrollVelocity*=Math.exp(-4*s)),a=!0}else this.scrollVelocity=0;a?(this.requestRender(),this.animRafId=requestAnimationFrame(r)):(this.requestRender(),this.animRafId=null)};this.animRafId=requestAnimationFrame(r)},requestRender(){this.needsRedraw=!0,this.rafId===null&&(this.rafId=requestAnimationFrame(()=>{this.rafId=null,this.render()}))}};var pr={rasterizeForeground(e){if(e.kind==="text"&&e.text){this.rasterizeText(e);return}if(e.kind!=="button"&&!e.label&&!e.icon){this.fgDirtyIds.delete(e.id);return}let r=this.dpr,t=Math.max(1,Math.round(e.rect.w*r)),s=Math.max(1,Math.round(e.rect.h*r));this.fgCanvas.width!==t&&(this.fgCanvas.width=t),this.fgCanvas.height!==s&&(this.fgCanvas.height=s);let a=this.fgCtx;a.setTransform(1,0,0,1,0,0),a.clearRect(0,0,t,s),a.scale(r,r);let i=e.rect.w,o=e.rect.h;if(e.icon){let n=e.icon.size,h=e.icon.color;a.save(),a.translate(i/2-n/2,o/2-n/2);let m=e.icon.viewport??24;a.scale(n/m,n/m);let x=new Path2D(e.icon.path);a.fillStyle=`rgba(${Math.round(h[0]*255)}, ${Math.round(h[1]*255)}, ${Math.round(h[2]*255)}, ${h[3]})`,a.fill(x),a.restore(),this.uploadForegroundTexture(e.id),this.fgDirtyIds.delete(e.id);return}let u=e.labelFontSizePx??o*(15/48),l='-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';a.font=`400 ${u}px ${l}`,a.textBaseline="middle",a.textAlign="center";let f=`rgba(${Math.round(e.labelColor[0]*255)}, ${Math.round(e.labelColor[1]*255)}, ${Math.round(e.labelColor[2]*255)}, ${e.labelColor[3]})`,c=e.labelColor[0]+e.labelColor[1]+e.labelColor[2]<1.5;if(a.save(),a.shadowColor=c?"rgba(255,255,255,0.45)":"rgba(0,0,0,0.15)",a.shadowBlur=c?u*.12:u*.05,a.fillStyle=f,a.fillText(e.label,i/2,o/2+.5),a.restore(),e.showChevron){let n=u*.93,h=a.measureText(e.label).width,m=i/2+h/2+u*.53+n/2,x=o/2;a.save(),a.strokeStyle=f,a.globalAlpha=.6,a.lineWidth=u*.107,a.lineCap="round",a.lineJoin="round",a.beginPath(),a.moveTo(m-n*.3,x-n*.4),a.lineTo(m+n*.2,x),a.lineTo(m-n*.3,x+n*.4),a.stroke(),a.restore()}this.uploadForegroundTexture(e.id),this.fgDirtyIds.delete(e.id)},rasterizeText(e){if(!e.text)return;let r=this.dpr,t=Math.max(1,Math.round(e.rect.w*r)),s=Math.max(1,Math.round(e.rect.h*r));this.fgCanvas.width!==t&&(this.fgCanvas.width=t),this.fgCanvas.height!==s&&(this.fgCanvas.height=s);let a=this.fgCtx;a.setTransform(1,0,0,1,0,0),a.clearRect(0,0,t,s),a.scale(r,r);let i=e.text,o=e.rect.w,u=e.rect.h,l='-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';a.font=`${i.fontWeight} ${i.fontSizePx}px ${l}`,a.textBaseline="middle";let f=i.paddingPx??0,c="none";i.halo==="light"?c="light":i.halo==="dark"?c="dark":(i.halo==="auto"||i.halo===void 0)&&(c=i.color[0]+i.color[1]+i.color[2]<1.5?"light":"dark"),c==="light"?(a.shadowColor="rgba(255,255,255,0.55)",a.shadowBlur=i.fontSizePx*.16):c==="dark"?(a.shadowColor="rgba(0,0,0,0.28)",a.shadowBlur=i.fontSizePx*.1):(a.shadowColor="transparent",a.shadowBlur=0);let n=`rgba(${Math.round(i.color[0]*255)}, ${Math.round(i.color[1]*255)}, ${Math.round(i.color[2]*255)}, ${i.color[3]})`;a.fillStyle=n;let h=0;if(i.icon){let m=i.icon.size,x=i.icon.layoutSize??m,p=i.content?2:0,g=x+p+(i.content?i.fontSizePx:0),C=u/2-g/2,S=o/2,T=C+x/2;a.save(),a.translate(S-m/2,T-m/2);let b=i.icon.viewport??24;a.scale(m/b,m/b);let v=new Path2D(i.icon.path),E=i.icon.color;a.fillStyle=`rgba(${Math.round(E[0]*255)}, ${Math.round(E[1]*255)}, ${Math.round(E[2]*255)}, ${E[3]})`,a.fill(v),a.restore(),h=(x+p)/2}if(i.align==="center")if(a.textAlign="center",i.wrap){let m=xt(a,i.content,o-f*2);i.maxLines!=null&&m.length>i.maxLines&&(m=m.slice(0,i.maxLines));let x=i.fontSizePx*1.35,p=x*m.length,g;i.valign==="top"?g=x/2+h:i.valign==="bottom"?g=u-p+x/2+h:g=u/2-p/2+x/2+h;for(let C of m)a.fillText(C,o/2,g),g+=x}else a.fillText(i.content,o/2,u/2+.5+h);else if(i.align==="left")if(a.textAlign="left",i.wrap){let m=xt(a,i.content,o-f*2);i.maxLines!=null&&m.length>i.maxLines&&(m=m.slice(0,i.maxLines));let x=i.fontSizePx*1.35,p=x*m.length,g;i.valign==="top"?g=x/2+h:i.valign==="bottom"?g=u-p+x/2+h:g=u/2-p/2+x/2+h;for(let C of m)a.fillText(C,f,g),g+=x}else a.fillText(i.content,f,u/2+.5+h);else a.textAlign="right",a.fillText(i.content,o-f,u/2+.5+h);this.uploadForegroundTexture(e.id),this.fgDirtyIds.delete(e.id)},uploadForegroundTexture(e){let r=this.gl,t=this.fgTextures.get(e);t||(t=r.createTexture(),this.fgTextures.set(e,t)),r.bindTexture(r.TEXTURE_2D,t),r.pixelStorei(r.UNPACK_PREMULTIPLY_ALPHA_WEBGL,!0),r.pixelStorei(r.UNPACK_FLIP_Y_WEBGL,!1),r.texImage2D(r.TEXTURE_2D,0,r.RGBA,r.RGBA,r.UNSIGNED_BYTE,this.fgCanvas),r.texParameteri(r.TEXTURE_2D,r.TEXTURE_MIN_FILTER,r.LINEAR),r.texParameteri(r.TEXTURE_2D,r.TEXTURE_MAG_FILTER,r.LINEAR),r.texParameteri(r.TEXTURE_2D,r.TEXTURE_WRAP_S,r.CLAMP_TO_EDGE),r.texParameteri(r.TEXTURE_2D,r.TEXTURE_WRAP_T,r.CLAMP_TO_EDGE),r.pixelStorei(r.UNPACK_PREMULTIPLY_ALPHA_WEBGL,!1)}};function Ge(e,r,t){if(!e.outerShadow||e.outerShadow.radius<=.5||!t.outerShadow)return 3;let a=e.outerShadow.radius,i=Math.max(Math.abs(e.outerShadow.offsetX),Math.abs(e.outerShadow.offsetY)),o=(a+i)*r;return Math.max(3,o+2)}function ge(e,r,t,s,a,i=0){let o=e.isToggleKnob||e.isBottomTabIndicator?Math.max(0,Math.min(1,i)):1,u=(e.blurRadius||0)*o,l=0;e.outerShadow&&e.outerShadow.alpha*o>=.15&&(l=(e.outerShadow.radius+Math.max(Math.abs(e.outerShadow.offsetX),Math.abs(e.outerShadow.offsetY)))*o),e.isToggleKnob&&(u=(e.blurRadius||0)*(1-o)*0+8*(1-o));let f=Math.max(u,l,3)+4,c=r-f,n=t-f,h=s+2*f,m=a+2*f,x=e.elementRotation??0;if(Math.abs(x)>.001){let p=r+s/2,g=t+a/2,C=Math.abs(Math.cos(x)),S=Math.abs(Math.sin(x)),T=h*C+m*S,b=h*S+m*C;c=p-T/2,n=g-b/2,h=T,m=b}return{x:c,y:n,w:h,h:m}}function kt(e,r,t,s,a,i,o,u){if(!e.outerShadow||e.outerShadow.radius<=.5||!u.outerShadow)return null;let l=e.outerShadow.radius,f=e.outerShadow.offsetX,c=e.outerShadow.offsetY,n=Math.max(0,l-f)*i,h=Math.max(0,l+f)*i,m=Math.max(0,l-c)*o,x=Math.max(0,l+c)*o;return{x:r-n,y:t-m,w:s+n+h,h:a+m+x}}function Ft(e,r){return e.x<r.x+r.w&&e.x+e.w>r.x&&e.y<r.y+r.h&&e.y+e.h>r.y}function br(e,r,t){let s=e.kind==="button",a=r?.pressProgress??0,i=4/48,o=1,u=0,l=0,f=1,c=1;if(e.enterProgress!=null){let R=e.enterProgress,y=R<0?(1-Math.exp(-Math.abs(R)))*-1:R<=1?R:1+(1-Math.exp(-(R-1)));l+=-48*(1-y),e.enterStretchFactor!=null&&y>1&&(l+=e.enterStretchFactor*(y-1)*32*1);let M=1+.1*Math.max(0,y-1);f/=M,c*=M}if(s&&e.isInteractive&&r){let R=e.rect.w,y=e.rect.h,M=Math.max(R,y),I=Math.min(R,y),k=.05,H=i;o=1+i*a;let L=r.dragX-r.startDragX,P=r.dragY-r.startDragY;u=I*Math.tanh(k*L/I),l=I*Math.tanh(k*P/I);let X=Math.atan2(P,L),$=Math.min(R/y,1),V=Math.min(y/R,1);f=o+H*Math.abs(Math.cos(X)*L/M)*$,c=o+H*Math.abs(Math.sin(X)*P/M)*V}else e.enterProgress==null&&(f=o,c=o);let n=0,h=1,m=1,x=0;if(e.isToggleKnob){let R=this.toggleStates.get(e.isToggleKnob.groupId);if(R){n=R.fraction*e.isToggleKnob.dragWidth,h=R.scaleX,m=R.scaleY,x=R.pressProgress;let y=e.isToggleKnob.velocityDivisor??50,M=R.velocity/y,w=Math.max(-.2,Math.min(.2,M*.75)),I=Math.max(-.2,Math.min(.2,M*.25));h=h/(1-w),m=m*(1-I)}}if(f*=h,c*=m,e.isBottomTabContainer){let R=this.toggleStates.get(e.isBottomTabContainer.groupId);if(R){let y=1+16/e.rect.w*R.pressProgress;f*=y,c*=y,u+=R.panelOffset,x=R.pressProgress}}if(e.isBottomTabContent){let R=this.toggleStates.get(e.isBottomTabContent.groupId);if(R){let y=e.isBottomTabContent.containerWidth??e.rect.w,M=1+16/y*R.pressProgress;f*=M;let w=1+.2*R.pressProgress;f*=w,c*=M*w,u+=R.panelOffset}}if(e.isBottomTabIndicator){let R=this.toggleStates.get(e.isBottomTabIndicator.groupId);if(R){n+=R.fraction*e.isBottomTabIndicator.dragWidth,n+=R.panelOffset;let y=R.scaleX,M=R.scaleY,w=R.velocity/10,I=Math.max(-.2,Math.min(.2,w*.75)),k=Math.max(-.2,Math.min(.2,w*.25)),H=y/(1-I),L=M*(1-k);f*=H,c*=L,x=Math.max(x,R.pressProgress)}}e.elementScaleX!=null&&(f*=e.elementScaleX),e.elementScaleY!=null&&(c*=e.elementScaleY);let p=t.x+e.rect.w/2+u+n,g=t.y+e.rect.h/2+l,C=e.rect.w*f,S=e.rect.h*c,T=p-C/2,b=g-S/2,v=e.cornerRadius*Math.min(f,c),E=[v,v,v,v],B=!!((e.independentBackdrop||e.directBackdropSample&&this.directBackdropSample)&&!this.backgroundColor&&this.wallpaperTexture);return{sx:T,sy:b,sw:C,sh:S,radii:E,scaleX:f,scaleY:c,isButton:s,p:a,togglePressProgress:x,translationX:u,translationY:l,independent:B}}function _e(e,r){return!(e.isToggleKnob||e.isBottomTabIndicator||e.blurRadius<.5||e.sampleWallpaper||e.isSdfTexture&&!e.isSdfTexture.useSeparableBlur)}function Ve(e){let{el:r,st:t,transform:s,usePerElementFbo:a,sceneRectOffsetX:i,sceneRectOffsetY:o,elFboW:u,elFboH:l}=e,{sx:f,sy:c,sw:n,sh:h,radii:m,scaleX:x,scaleY:p,isButton:g,p:C,togglePressProgress:S,independent:T}=s;return{el:r,st:t,isButton:g,p:C,sx:f,sy:c,sw:n,sh:h,radii:m,togglePressProgress:S,elHighlightAlpha:r.isToggleKnob||r.isBottomTabIndicator?(r.highlight?r.highlight.alpha:0)*S:r.highlight?r.highlight.alpha:0,enterAlpha:r.enterProgress!=null?ve(r.enterSafeProgress!=null?Math.max(0,Math.min(1,r.enterSafeProgress)):Math.max(0,Math.min(1,r.enterProgress))):1,layerScaleX:x,layerScaleY:p,layerScale:Math.min(x,p),origW:r.rect.w,origH:r.rect.h,origCornerRadius:r.cornerRadius,elementRotation:r.elementRotation??0,independent:T,usePerElementFbo:a,sceneRectOffsetX:i,sceneRectOffsetY:o,elFboW:u,elFboH:l}}function Ke(e,r,t){let{el:s,independent:a,sx:i,sy:o,sw:u,sh:l,layerScale:f}=e;if(a&&_e(s,e)&&this.quickToggles.backdropBlur){let c=this.gl,n=s.blurRadius*f*this.dpr,h=s.blurRadius*f,m=Math.round(h*10)/10,x=this.useBlurCache?`wallpaper_${m}_${this.useKawaseBlur?"k":"g"}`:null,p=x?this.backdropBlurCache.get(x):void 0,g,C=!1;if(p)g=p.tex,C=!0,this.lastBlurStats={type:p.blurType,passes:0,taps:0,maxSample:0,w:p.w,h:p.h,progMs:0,stateMs:0,drawMs:0};else if(!x)g=this.blurTexture(this.wallpaperBlurTex,n);else{if(this._blurCacheMissesThisFrame>=this.blurCacheMissesPerFrame)return{backdropTex:r,didBlur:!1};this._blurCacheMissesThisFrame++;let T=performance.now(),b=this.blurTexture(this.wallpaperBlurTex,n),v=performance.now(),E=this.lastBlurStats?.progMs??0,A=this.lastBlurStats?.stateMs??0,B=this.lastBlurStats?.drawMs??v-T,R=this.lastBlurStats?.w??this.dsBlurFboW??this.fboW,y=this.lastBlurStats?.h??this.dsBlurFboH??this.fboH,M=this.acquireCacheFBO(R,y),w=this.gl,I=w.getParameter(w.FRAMEBUFFER_BINDING),k=w.isEnabled(w.SCISSOR_TEST),H=w.getParameter(w.SCISSOR_BOX);if(w.disable(w.SCISSOR_TEST),this.cacheCopyReadFbo||(this.cacheCopyReadFbo=w.createFramebuffer()),w.bindFramebuffer(w.FRAMEBUFFER,this.cacheCopyReadFbo),w.framebufferTexture2D(w.FRAMEBUFFER,w.COLOR_ATTACHMENT0,w.TEXTURE_2D,b,0),w.activeTexture(w.TEXTURE0),w.bindTexture(w.TEXTURE_2D,null),w.bindTexture(w.TEXTURE_2D,M.tex),w.copyTexImage2D(w.TEXTURE_2D,0,w.RGBA,0,0,R,y,0),this.showBlurCacheCheckerboard){w.bindFramebuffer(w.FRAMEBUFFER,M.fb),w.viewport(0,0,R,y);let re=Math.max(8,Math.floor(R/20));w.enable(w.SCISSOR_TEST),w.clearColor(0,0,0,0);for(let F=0;F<y;F+=re)for(let O=0;O<R;O+=re)(Math.floor(O/re)+Math.floor(F/re))%2!==0&&(w.scissor(O,F,Math.min(re,R-O),Math.min(re,y-F)),w.clear(w.COLOR_BUFFER_BIT));w.disable(w.SCISSOR_TEST)}let L=performance.now(),P=v-T,X=L-v,$=0,V=0,G=0,_=0,Z=new Uint8Array(0),j=0,se=0,de=0,oe=0,ne=0;if(this.showBlurCachePreview){G=R,_=y;let re=performance.now();Z=new Uint8Array(G*_*4);let F=performance.now();w.bindFramebuffer(w.FRAMEBUFFER,M.fb),w.readPixels(0,0,G,_,w.RGBA,w.UNSIGNED_BYTE,Z);let O=performance.now();for(let Y=0;Y<_;Y++)for(let D=0;D<G;D++){let z=(Y*G+D)*4;Z[z]+Z[z+1]+Z[z+2]+Z[z+3]>0&&(j++,(D<se||j===1)&&(se=D),D>oe&&(oe=D),(Y<de||j===1)&&(de=Y),Y>ne&&(ne=Y))}let K=performance.now();$=O-F,V=K-O+(F-re)}this.backdropBlurCacheSnapshots.push({key:G>0?`${x} [${se},${de}-${oe},${ne}]`:x,w:G,h:_,rgba:Z,nonZero:j,progMs:E,stateMs:A,drawMs:B,copyMs:X,readPixelsMs:$,scanMs:V,totalMs:E+A+B+X+$+V}),this.bindFBO(I),k&&(w.enable(w.SCISSOR_TEST),w.scissor(H[0],H[1],H[2],H[3])),this.backdropBlurCache.set(x,{fb:M.fb,tex:M.tex,w:R,h:y,blurType:this.lastBlurStats?.type??"gauss"}),this.evictBackdropBlurCacheIfNeeded(),g=M.tex}if(this.showBlurDebug){let T=this.lastBlurStats;this.debugBlurRegions.push({x:i,y:o,w:u,h:l,radius:n,ds:this.effectiveBlurDownsample,blurW:this.dsBlurFboW,blurH:this.dsBlurFboH,blurType:T?.type??"gauss",passes:T?.passes??0,taps:T?.taps??0,maxSample:T?.maxSample??0,cached:C})}this.perfMonitor.incBlurPass(),this.perfMonitor.incDrawCall(3),c.enable(c.BLEND),c.blendFunc(c.SRC_ALPHA,c.ONE_MINUS_SRC_ALPHA),this.bindFBO(t),c.viewport(0,0,this.fboW,this.fboH);let S={...e,independent:!1};return{backdropTex:g,passState:S,didBlur:!0}}if(a)return{backdropTex:r,didBlur:!1};if(_e(s,e)&&this.quickToggles.backdropBlur){let c=s.blurRadius*f*this.dpr,n;s.backdropFbo&&this.dialogBackdropTex?n=this.dialogBackdropTex:this.quickToggles.isolateBackdrop&&this.bgOnlyTex?n=this.bgOnlyTex:n=r;let h=this.useBlurCache&&n===r&&!s.backdropFbo,m=this.scrollY!==this._lastBlurCacheScrollY;this._lastBlurCacheScrollY=this.scrollY;let x=s.blurRadius*f,p=Math.round(x*10)/10,g=h&&!m?`scene_${s.id}_${p}_${this.useKawaseBlur?"k":"g"}`:null,C,S=!1;if(g){let v=this.backdropBlurCache.get(g);if(v)C=v.tex,S=!0,this.lastBlurStats={type:v.blurType,passes:0,taps:0,maxSample:0,w:v.w,h:v.h,progMs:0,stateMs:0,drawMs:0};else{if(this._blurCacheMissesThisFrame>=this.blurCacheMissesPerFrame)return{backdropTex:n,didBlur:!1};this._blurCacheMissesThisFrame++;let E=performance.now();C=this.blurTexture(n,c);let A=performance.now(),B=this.lastBlurStats?.progMs??0,R=this.lastBlurStats?.stateMs??0,y=this.lastBlurStats?.drawMs??A-E,M=this.lastBlurStats?.w??this.dsBlurFboW??this.fboW,w=this.lastBlurStats?.h??this.dsBlurFboH??this.fboH,I=this.acquireCacheFBO(M,w),k=this.gl,H=k.getParameter(k.FRAMEBUFFER_BINDING),L=k.isEnabled(k.SCISSOR_TEST),P=k.getParameter(k.SCISSOR_BOX);if(k.disable(k.SCISSOR_TEST),this.cacheCopyReadFbo||(this.cacheCopyReadFbo=k.createFramebuffer()),k.bindFramebuffer(k.FRAMEBUFFER,this.cacheCopyReadFbo),k.framebufferTexture2D(k.FRAMEBUFFER,k.COLOR_ATTACHMENT0,k.TEXTURE_2D,C,0),k.activeTexture(k.TEXTURE0),k.bindTexture(k.TEXTURE_2D,null),k.bindTexture(k.TEXTURE_2D,I.tex),k.copyTexImage2D(k.TEXTURE_2D,0,k.RGBA,0,0,M,w,0),this.showBlurCacheCheckerboard){k.bindFramebuffer(k.FRAMEBUFFER,I.fb),k.viewport(0,0,M,w);let F=Math.max(8,Math.floor(M/20));k.enable(k.SCISSOR_TEST),k.clearColor(0,0,0,0);for(let O=0;O<w;O+=F)for(let K=0;K<M;K+=F)(Math.floor(K/F)+Math.floor(O/F))%2!==0&&(k.scissor(K,O,Math.min(F,M-K),Math.min(F,w-O)),k.clear(k.COLOR_BUFFER_BIT));k.disable(k.SCISSOR_TEST)}let $=performance.now()-A,V=0,G=0,_=0,Z=0,j=new Uint8Array(0),se=0,de=0,oe=0,ne=0,re=0;if(this.showBlurCachePreview){_=M,Z=w;let F=performance.now();j=new Uint8Array(_*Z*4);let O=performance.now();k.bindFramebuffer(k.FRAMEBUFFER,I.fb),k.readPixels(0,0,_,Z,k.RGBA,k.UNSIGNED_BYTE,j);let K=performance.now();for(let D=0;D<Z;D++)for(let z=0;z<_;z++){let U=(D*_+z)*4;j[U]+j[U+1]+j[U+2]+j[U+3]>0&&(se++,(z<de||se===1)&&(de=z),z>ne&&(ne=z),(D<oe||se===1)&&(oe=D),D>re&&(re=D))}let Y=performance.now();V=K-O,G=Y-K+(O-F)}this.backdropBlurCacheSnapshots.push({key:_>0?`${g} [${de},${oe}-${ne},${re}]`:g,w:_,h:Z,rgba:j,nonZero:se,progMs:B,stateMs:R,drawMs:y,copyMs:$,readPixelsMs:V,scanMs:G,totalMs:B+R+y+$+V+G}),k.bindFramebuffer(k.FRAMEBUFFER,H),L&&(k.enable(k.SCISSOR_TEST),k.scissor(P[0],P[1],P[2],P[3])),this.backdropBlurCache.set(g,{fb:I.fb,tex:I.tex,w:M,h:w,blurType:this.lastBlurStats?.type??"gauss"}),this.evictBackdropBlurCacheIfNeeded(),C=I.tex}}else{if(this.useBlurCache&&this._blurCacheMissesThisFrame>=this.blurCacheMissesPerFrame)return{backdropTex:n,didBlur:!1};this.useBlurCache&&this._blurCacheMissesThisFrame++,C=this.blurTexture(n,c)}if(this.showBlurDebug){let v=this.lastBlurStats;this.debugBlurRegions.push({x:i,y:o,w:u,h:l,radius:c,ds:this.effectiveBlurDownsample,blurW:this.dsBlurFboW,blurH:this.dsBlurFboH,blurType:v?.type??"gauss",passes:v?.passes??0,taps:v?.taps??0,maxSample:v?.maxSample??0,cached:S})}this.perfMonitor.incBlurPass(),this.perfMonitor.incDrawCall(2);let T=this.gl;T.enable(T.BLEND),T.blendFunc(T.SRC_ALPHA,T.ONE_MINUS_SRC_ALPHA),this.bindFBO(t),T.viewport(0,0,this.fboW,this.fboH);let b=s.backdropFbo?{...e,el:{...s,backdropFbo:!1}}:e;return{backdropTex:C,passState:b,didBlur:!0}}return this.quickToggles.isolateBackdrop&&this.bgOnlyTex&&!s.backdropFbo?{backdropTex:this.bgOnlyTex,didBlur:!1}:{backdropTex:r,didBlur:!1}}function Sr(e,r,t,s,a,i,o){let u=this.gl,l=br.call(this,e,r,o),{sx:f,sy:c,sw:n,sh:h,scaleX:m,scaleY:x,togglePressProgress:p}=l;if(this.quickToggles.perElementFbo){this.perfMonitor.incGlassElement(),this.perfMonitor.incPerElementFbo();let B=this.allDirty||this.dirtyElementIds.has(e.id);return this.renderGlassElementPerFbo(e,r,t,s,a,i,{sx:f,sy:c,sw:n,sh:h,radii:l.radii,scaleX:m,scaleY:x,isButton:l.isButton,p:l.p,togglePressProgress:p,independent:l.independent,translationX:l.translationX,translationY:l.translationY,elDirty:B})}this._dbgLastGlassCacheHit=!1,this.showDirtyMarkers&&this.debugCacheMissLog.push({id:e.id,reason:"ping_pong",x:f,y:c,w:n,h}),this.dirtyRectsThisFrame.push({...ge(e,f,c,n,h,p),source:`pingpong:${e.id}`}),this.perfMonitor.incGlassElement(),this.perfMonitor.incPingPong(),this.bindFBO(a),this.drawCopy(s),this.perfMonitor.incDrawCall(),u.enable(u.BLEND),u.blendFunc(u.SRC_ALPHA,u.ONE_MINUS_SRC_ALPHA);let g=Ge(e,Math.min(m,x),this.quickToggles),C=Math.max(0,Math.round((f-g)*this.dpr)),S=Math.max(0,Math.round((this.cssHeight-(c+h+g))*this.dpr)),T=Math.min(this.fboW-C,Math.round((n+2*g)*this.dpr)),b=Math.min(this.fboH-S,Math.round((h+2*g)*this.dpr)),v=this.intersectClipScissor(e,C,S,T,b);if(u.enable(u.SCISSOR_TEST),u.scissor(v.x,v.y,v.w,v.h),this.showPefBbox){let B=C/this.dpr,R=(this.fboH-S-b)/this.dpr;this.debugPefBboxes.push({x:B,y:R,w:T/this.dpr,h:b/this.dpr,fbo:!1})}let E=Ve({el:e,st:r,transform:l,usePerElementFbo:!1,sceneRectOffsetX:0,sceneRectOffsetY:0,elFboW:0,elFboH:0});this.renderGlassShadowPass(E);let A=Ke.call(this,E,s,a);return this.renderGlassElementPass(A.passState??E,A.backdropTex,A.backdropBbox),this.renderGlassPostPasses(E),u.disable(u.SCISSOR_TEST),{curFbo:a,curTex:i,otherFbo:t,otherTex:s}}function Mt(e,r,t,s,a,i){let o=Ge(e,i,this.quickToggles),l=(2+1)/this.dpr,f=Math.round((r-o)*this.dpr),c=Math.round((t-o)*this.dpr),n=Math.max(0,Math.min(this.fboW,f)),h=Math.max(0,Math.min(this.fboH,c)),m=Math.max(0,Math.min(this.fboW-n,Math.round((s+2*o)*this.dpr))),x=Math.max(0,Math.min(this.fboH-h,Math.round((a+2*o)*this.dpr))),p=Math.max(0,this.fboH-h-x),g=Math.max(1,Math.round((e.rect.w+2*l)*this.dpr)),C=Math.max(1,Math.round((e.rect.h+2*l)*this.dpr)),S=Math.round((r-l)*this.dpr),T=Math.round((t-l)*this.dpr),b=S,v=T,E=Math.max(0,Math.min(this.fboW,S)),A=Math.max(0,Math.min(this.fboH,T)),B=Math.max(0,Math.min(this.fboW-E,g)),R=Math.max(0,Math.min(this.fboH-A,C)),y=Math.max(0,this.fboH-A-R);return{bx0:n,by0Top:h,bboxW:m,bboxH:x,bboxScissorY:p,elFboRectW:g,elFboRectH:C,ex0:b,ey0Top:v,scissorX:E,scissorYTop:A,scissorW:B,scissorH:R,elFboScissorY:y,sceneOffsetX:S,sceneOffsetY:T,scissorMarginCss:o}}function Bt(e){let r=!!(this.wallpaperTexture&&!e.backdropFbo),t=!!(e.isToggleKnob?.solidBackdropColor&&!e.backdropFbo),s=!!(e.isToggleKnob&&!e.isToggleKnob.solidBackdropColor&&!e.isToggleKnob.trackColorOff&&this.backgroundColor&&!e.backdropFbo);return{cacheable:r,positionInvariant:t,scrollInvariant:s}}function Lt(e,r,t,s){let{sx:a,sy:i,sw:o,sh:u,togglePressProgress:l,independent:f}=r,{elFboRectW:c,elFboRectH:n,sceneOffsetX:h,sceneOffsetY:m}=t,{cacheable:x,positionInvariant:p,scrollInvariant:g}=s,C=this.gl;if(!x){if(this.showDirtyMarkers){let A=this.wallpaperTexture?e.backdropFbo?"non_cacheable:backdropFbo":"non_cacheable:unknown":"non_cacheable:no_wp";this.debugCacheMissLog.push({id:e.id,reason:A,x:a,y:i,w:o,h:u})}let E=this.ensureElementFBO(c,n);return{cacheHit:!1,cacheWrite:!1,renderFbo:this.elFbo,renderTex:this.elFboTex,elFboW:E.w,elFboH:E.h}}let S=this.elFboCache.get(e.id),T=null,b=p||g;if(!S)T="no_entry";else if(S.w!==c||S.h!==n)T="size_mismatch";else if(!b&&(S.ex0!==h||S.ey0Top!==m))T="position_mismatch";else if(!S.valid)T="invalidated";else if(S.wallpaperVersion!==this.wallpaperVersion)T="wallpaper_version";else if(S.dpr!==this.dpr)T="dpr";else if(!p&&!f){let E=ge(e,a,i,o,u,l),A=this.dirtyRectsThisFrame.find(B=>Ft(B,E)&&!(g&&B.source==="scroll"));A&&(T=`backdrop_overlap:${A.source}`)}if(T&&this.showDirtyMarkers&&this.debugCacheMissLog.push({id:e.id,reason:T,x:a,y:i,w:o,h:u}),S&&T===null)return(p||g)&&(S.ex0=h,S.ey0Top=m),this.perfMonitor.incCachedElement(),{cacheHit:!0,cacheWrite:!1,renderFbo:S.fb,renderTex:S.tex,elFboW:S.w,elFboH:S.h};if(S){if(S.w!==c||S.h!==n){C.deleteFramebuffer(S.fb),C.deleteTexture(S.tex);let E=this.createFBO(c,n);S.fb=E.fb,S.tex=E.tex,S.w=c,S.h=n}}else{let E=this.createFBO(c,n);this.elFboCache.set(e.id,{fb:E.fb,tex:E.tex,w:c,h:n,ex0:h,ey0Top:m,valid:!1,wallpaperVersion:this.wallpaperVersion,dpr:this.dpr})}let v=this.elFboCache.get(e.id);return v.ex0=h,v.ey0Top=m,v.valid=!1,v.wallpaperVersion=this.wallpaperVersion,v.dpr=this.dpr,{cacheHit:!1,cacheWrite:!0,renderFbo:v.fb,renderTex:v.tex,elFboW:v.w,elFboH:v.h}}function xr(e,r,t,s,a,i,o){let u=this.gl,l=Math.min(o.scaleX,o.scaleY),f=Mt.call(this,e,o.sx,o.sy,o.sw,o.sh,l),c=e.elementRotation??0,n=Math.abs(Math.cos(c)),h=Math.abs(Math.sin(c)),m=f.scissorMarginCss,x=o.sw+2*m,p=o.sh+2*m,g=x*n+p*h,C=x*h+p*n,S=o.sx+o.sw/2,T=o.sy+o.sh/2,b=Math.max(0,Math.min(this.fboW,Math.round((S-g/2)*this.dpr))),v=Math.max(0,Math.min(this.fboH,Math.round((this.cssHeight-(T+C/2))*this.dpr))),E=Math.max(0,Math.min(this.fboW-b,Math.round(g*this.dpr))),A=Math.max(0,Math.min(this.fboH-v,Math.round(C*this.dpr)));this.showPefBbox&&this.debugPefBboxes.push({x:f.ex0/this.dpr,y:f.ey0Top/this.dpr,w:f.elFboRectW/this.dpr,h:f.elFboRectH/this.dpr,fbo:!0});let B=Bt.call(this,e),R=Ve({el:e,st:r,transform:o,usePerElementFbo:!0,sceneRectOffsetX:f.sceneOffsetX,sceneRectOffsetY:f.sceneOffsetY,elFboW:0,elFboH:0}),y=Lt.call(this,e,R,f,B);R={...R,elFboW:y.elFboW,elFboH:y.elFboH};let M=this.intersectClipScissor(e,b,v,E,A);if(this.bindFBO(t),u.enable(u.SCISSOR_TEST),u.scissor(M.x,M.y,M.w,M.h),u.enable(u.BLEND),u.blendFunc(u.SRC_ALPHA,u.ONE_MINUS_SRC_ALPHA),this.renderGlassShadowPass(R),!y.cacheHit){this.dirtyRectsThisFrame.push({...ge(e,o.sx,o.sy,o.sw,o.sh,o.togglePressProgress),source:`glass:${e.id}`});let _=Ke.call(this,R,s,y.renderFbo);if(u.bindFramebuffer(u.FRAMEBUFFER,y.renderFbo),u.viewport(0,0,y.elFboW,y.elFboH),u.disable(u.SCISSOR_TEST),u.clearColor(0,0,0,0),u.clear(u.COLOR_BUFFER_BIT),u.disable(u.BLEND),this.renderGlassElementPass(_.passState??R,_.backdropTex,_.backdropBbox),y.cacheWrite){let Z=this.elFboCache.get(e.id);Z&&(Z.valid=!0)}}let w=S,I=T,k=o.sw*n+o.sh*h,H=o.sw*h+o.sh*n,L=Math.max(0,Math.min(this.fboW,Math.round((w-k/2)*this.dpr))),P=Math.max(0,Math.min(this.fboH,Math.round((this.cssHeight-(I+H/2))*this.dpr))),X=Math.max(0,Math.min(this.fboW-L,Math.round(k*this.dpr))),$=Math.max(0,Math.min(this.fboH-P,Math.round(H*this.dpr))),V=this.intersectClipScissor(e,L,P,X,$);this.bindFBO(t),u.enable(u.SCISSOR_TEST),u.scissor(V.x,V.y,V.w,V.h),this.drawElFboComposite(y.renderTex,y.elFboW,y.elFboH,w*this.dpr,I*this.dpr,o.sw*this.dpr,o.sh*this.dpr,c);let G=this.intersectClipScissor(e,b,v,E,A);if(u.scissor(G.x,G.y,G.w,G.h),this.renderGlassPostPasses(R),u.disable(u.SCISSOR_TEST),this._dbgLastGlassCacheHit=y.cacheHit,this.showPefPassDebug){let _=f.ex0/this.dpr,Z=f.ey0Top/this.dpr,j=f.elFboRectW/this.dpr,se=f.elFboRectH/this.dpr,de=f.bx0/this.dpr,oe=f.by0Top/this.dpr,ne=f.bboxW/this.dpr,re=f.bboxH/this.dpr;this.debugPefPasses.push({id:e.id,cacheHit:y.cacheHit,missReason:y.cacheHit?null:"MISS",composite:{x:_,y:Z,w:j,h:se},postPass:{x:de,y:oe,w:ne,h:re},isBottomTabIndicator:!!e.isBottomTabIndicator,togglePressProgress:R.togglePressProgress,elHighlightAlpha:R.elHighlightAlpha})}return{curFbo:t,curTex:s,otherFbo:a,otherTex:i}}function Tr(e){let r=this.gl,{el:t,sx:s,sy:a,sw:i,sh:o,radii:u}=e;if(!t.outerShadow||t.outerShadow.radius<=.5||!this.quickToggles.outerShadow)return;let l=t.outerShadow.alpha;if(t.isBottomTabIndicator&&(l*=e.togglePressProgress),this.showShadowBbox){let f=kt(t,s,a,i,o,e.layerScaleX,e.layerScaleY,this.quickToggles);f&&this.debugShadowBboxes.push({...f,alpha:l,skipped:l<=.001,r:t.outerShadow.radius,ox:t.outerShadow.offsetX,oy:t.outerShadow.offsetY})}l<=.001||(r.useProgram(this.shadowProgram),r.bindBuffer(r.ARRAY_BUFFER,this.quadBuffer),r.enableVertexAttribArray(this.aPosLocSh),r.vertexAttribPointer(this.aPosLocSh,2,r.FLOAT,!1,0,0),r.blendFunc(r.SRC_ALPHA,r.ONE_MINUS_SRC_ALPHA),r.uniform2f(this.uSh.uCanvasSize,this.canvas.width,this.canvas.height),r.uniform2f(this.uSh.uElementOffset,s*this.dpr,a*this.dpr),r.uniform2f(this.uSh.uElementSize,i*this.dpr,o*this.dpr),r.uniform4f(this.uSh.uCornerRadii,u[0]*this.dpr,u[1]*this.dpr,u[2]*this.dpr,u[3]*this.dpr),r.uniform2f(this.uSh.uOriginalSize,e.origW*this.dpr,e.origH*this.dpr),r.uniform1f(this.uSh.uOriginalCornerRadius,e.origCornerRadius*this.dpr),r.uniform2f(this.uSh.uLayerScale,e.layerScaleX,e.layerScaleY),r.uniform1f(this.uSh.uElementRotation,e.elementRotation),r.uniform1f(this.uSh.uCornerStyle,this.cornerStyle),r.uniform1f(this.uSh.uShadowRadius,t.outerShadow.radius*this.dpr),r.uniform2f(this.uSh.uShadowOffset,t.outerShadow.offsetX*this.dpr,t.outerShadow.offsetY*this.dpr),r.uniform4f(this.uSh.uShadowColor,t.outerShadow.color[0],t.outerShadow.color[1],t.outerShadow.color[2],l),r.drawArrays(r.TRIANGLES,0,6))}var vr={renderGlassElement:Sr,renderGlassElementPerFbo:xr,renderGlassShadowPass:Tr};var Cr={render(){if(!this.needsRedraw)return;if(this.needsRedraw=!1,this.dirtyRectsThisFrame.length=0,this.debugCacheMissLog.length=0,this.debugDirtySourceLog.length=0,this._blurCacheMissesThisFrame=0,(this.allDirty||this.scrollY!==this.lastRenderedScrollY)&&this.dirtyRectsThisFrame.push({x:0,y:0,w:this.cssWidth,h:this.cssHeight,source:this.allDirty?"all_dirty":"scroll"}),this.lastRenderedScrollY=this.scrollY,this.perfMonitor.canvasCssW=this.cssWidth,this.perfMonitor.canvasCssH=this.cssHeight,this.perfMonitor.canvasDevW=this.canvas.width,this.perfMonitor.canvasDevH=this.canvas.height,this.perfMonitor.dpr=this.dpr,this.perfMonitor.deviceDpr=typeof window<"u"&&window.devicePixelRatio||1,this.perfMonitor.frameStart(),this.debugPefBboxes.length=0,this.debugBlurRegions.length=0,this.debugShadowBboxes.length=0,this.debugDirtyMarkers.length=0,this.debugCullRects.length=0,this.debugPefPasses.length=0,this.debugPlainRects.length=0,!this.wallpaperReady&&!this.backgroundColor){this.perfMonitor.frameEnd();return}let e=this.gl;this.resizeFBOs(this.canvas.width,this.canvas.height);for(let n of this.buttonConfigs)this.fgDirtyIds.has(n.id)&&this.rasterizeForeground(n);if(this.renderBackground(),this.perfMonitor.incDrawCall(),this.buttonConfigs.length===0){this.bindFBO(null),this.drawCopy(this.fboATex),this.perfMonitor.incDrawCall(),this.perfMonitor.frameEnd();return}let r=this.buttonConfigs.find(n=>(n.sceneBlurRadius??0)>=.5);if(r){let n=r.sceneBlurRadius*this.dpr,h=this.blurTexture(this.fboATex,n);this.bindFBO(this.fboA),this.drawCopy(h),this.perfMonitor.incBlurPass(),this.perfMonitor.incDrawCall(2)}e.enable(e.BLEND),e.blendFunc(e.SRC_ALPHA,e.ONE_MINUS_SRC_ALPHA);let t=this.quickToggles.isolateBackdrop;t&&this.bgOnlyFbo&&this.bgOnlyTex&&(this.bindFBO(this.bgOnlyFbo),this.gl.viewport(0,0,this.fboW,this.fboH),this.drawCopy(this.fboATex),this.gl.enable(this.gl.BLEND),this.gl.blendFunc(this.gl.SRC_ALPHA,this.gl.ONE_MINUS_SRC_ALPHA));let s=this.scrollY,a=120,i=n=>Math.max(a,n.rect.h),o=n=>{let h=n.scroll?n.rect.y-s:n.rect.y;return{x:n.rect.x,y:h,w:n.rect.w,h:n.rect.h}},u=this.fboA,l=this.fboATex,f=this.fboB,c=this.fboBTex;for(let n of this.buttonConfigs){if(n.renderOnTop)continue;let h=n.scroll?n.rect.y-s:n.rect.y,m=i(n),x=h+n.rect.h<-m||h>this.cssHeight+m;if(this.showCullDebug&&this.debugCullRects.push({id:n.id,x:n.rect.x,y:h,w:n.rect.w,h:n.rect.h,margin:m,culled:x,scroll:!!n.scroll,viewportH:this.cssHeight,pass:"main"}),x)continue;let p=o(n),g=this.buttonStates.get(n.id),C=this.allDirty||this.dirtyElementIds.has(n.id);if(this.perfMonitor.incTotal(),C&&this.perfMonitor.incDirty(),this.renderNonGlassElement(n,p,g,u)){this.showDirtyMarkers&&this.debugDirtyMarkers.push({x:p.x,y:p.y,w:p.w,h:p.h,dirty:C}),C&&this.dirtyRectsThisFrame.push({...ge(n,p.x,p.y,p.w,p.h),source:`nonglass:${n.id}`}),t&&this.bgOnlyFbo&&this.renderNonGlassElement(n,p,g,this.bgOnlyFbo);continue}n.backdropFbo&&n.scrimColor&&this.renderDialogBackdrop(n.scrimColor,n.brightness,n.contrast,n.saturation),n.useContinuousSdf&&this.loadContinuousSdf(n.rect.w,n.rect.h,n.cornerRadius);let S=this.renderGlassElement(n,g,u,l,f,c,p);u=S.curFbo,l=S.curTex,f=S.otherFbo,c=S.otherTex,this.showDirtyMarkers&&this.debugDirtyMarkers.push({x:p.x,y:p.y,w:p.w,h:p.h,dirty:!this._dbgLastGlassCacheHit}),n.isBottomTabContainer&&this.tabsBackdropFbo&&this.tabsBackdropTex&&(this.bindFBO(this.tabsBackdropFbo),this.gl.clearColor(0,0,0,0),this.gl.clear(this.gl.COLOR_BUFFER_BIT),this.drawCopy(l),this.bindFBO(u),this.gl.enable(this.gl.BLEND),this.gl.blendFunc(this.gl.SRC_ALPHA,this.gl.ONE_MINUS_SRC_ALPHA))}for(let n of this.buttonConfigs){if(!n.renderOnTop)continue;let h=n.scroll?n.rect.y-s:n.rect.y,m=i(n),x=h+n.rect.h<-m||h>this.cssHeight+m;if(this.showCullDebug&&this.debugCullRects.push({id:n.id,x:n.rect.x,y:h,w:n.rect.w,h:n.rect.h,margin:m,culled:x,scroll:!!n.scroll,viewportH:this.cssHeight,pass:"onTop"}),x)continue;let p=o(n),g=this.buttonStates.get(n.id),C=this.allDirty||this.dirtyElementIds.has(n.id);if(this.perfMonitor.incTotal(),C&&this.perfMonitor.incDirty(),this.renderNonGlassElement(n,p,g,u)){this.showDirtyMarkers&&this.debugDirtyMarkers.push({x:p.x,y:p.y,w:p.w,h:p.h,dirty:C}),C&&this.dirtyRectsThisFrame.push({...ge(n,p.x,p.y,p.w,p.h),source:`nonglass:${n.id}`}),t&&this.bgOnlyFbo&&this.renderNonGlassElement(n,p,g,this.bgOnlyFbo);continue}let S=this.renderGlassElement(n,g,u,l,f,c,p);u=S.curFbo,l=S.curTex,f=S.otherFbo,c=S.otherTex,this.showDirtyMarkers&&this.debugDirtyMarkers.push({x:p.x,y:p.y,w:p.w,h:p.h,dirty:!this._dbgLastGlassCacheHit})}if(this.bindFBO(null),this.drawCopy(l),this.perfMonitor.incDrawCall(),this._pendingEdgeScan&&this._debugFlushPendingEdgeScan(),this.dirtyElementIds.clear(),this.allDirty=!1,this.pendingExtraRenders>0){this.pendingExtraRenders--;for(let n of this.buttonConfigs)n.isBottomTabIndicator&&this.markGroupDirty(n.isBottomTabIndicator.groupId);this.requestRender()}this.perfMonitor.frameEnd()}};var Er={setSdfUniforms(e,r,t,s){let a=this.gl;a.bindBuffer(a.ARRAY_BUFFER,this.quadBuffer),a.enableVertexAttribArray(r),a.vertexAttribPointer(r,2,a.FLOAT,!1,0,0),a.uniform2f(e.uCanvasSize,this.canvas.width,this.canvas.height),a.uniform2f(e.uOffset,t.x*this.dpr,t.y*this.dpr),a.uniform2f(e.uSize,t.w*this.dpr,t.h*this.dpr),a.uniform4f(e.uCornerRadii,s*this.dpr,s*this.dpr,s*this.dpr,s*this.dpr)},renderBackground(){let e=this.gl;if(this.bindFBO(this.fboA),e.disable(e.BLEND),this.backgroundColor){let[r,t,s]=this.backgroundColor;this.drawSolidFill(r,t,s,1)}else e.useProgram(this.wallpaperProgram),e.bindBuffer(e.ARRAY_BUFFER,this.quadBuffer),e.enableVertexAttribArray(this.aPosLocWp),e.vertexAttribPointer(this.aPosLocWp,2,e.FLOAT,!1,0,0),e.activeTexture(e.TEXTURE0),e.bindTexture(e.TEXTURE_2D,this.wallpaperTexture),e.uniform1i(this.uWp.uBackdrop,0),e.uniform2f(this.uWp.uCanvasSize,this.canvas.width,this.canvas.height),e.uniform2f(this.uWp.uWallpaperSize,this.wallpaperSize[0],this.wallpaperSize[1]),e.drawArrays(e.TRIANGLES,0,6),this.wallpaperBlurFbo&&(e.bindFramebuffer(e.FRAMEBUFFER,this.wallpaperBlurFbo),e.viewport(0,0,this.fboW,this.fboH),e.disable(e.SCISSOR_TEST),e.drawArrays(e.TRIANGLES,0,6))},renderDialogBackdrop(e,r,t,s){let a=`${e.join(",")}|${r},${t},${s}`;if(this.dialogBackdropKey===a)return;this.dialogBackdropKey=a;let i=this.gl;if(this.bindFBO(this.dialogBackdropFbo),i.disable(i.BLEND),this.backgroundColor){let[o,u,l]=this.backgroundColor;this.drawSolidFill(o,u,l,1)}else i.useProgram(this.wallpaperProgram),i.bindBuffer(i.ARRAY_BUFFER,this.quadBuffer),i.enableVertexAttribArray(this.aPosLocWp),i.vertexAttribPointer(this.aPosLocWp,2,i.FLOAT,!1,0,0),i.activeTexture(i.TEXTURE0),i.bindTexture(i.TEXTURE_2D,this.wallpaperTexture),i.uniform1i(this.uWp.uBackdrop,0),i.uniform2f(this.uWp.uCanvasSize,this.canvas.width,this.canvas.height),i.uniform2f(this.uWp.uWallpaperSize,this.wallpaperSize[0],this.wallpaperSize[1]),i.drawArrays(i.TRIANGLES,0,6);e[3]>.001&&(i.enable(i.BLEND),i.blendFuncSeparate(i.SRC_ALPHA,i.ONE_MINUS_SRC_ALPHA,i.ONE,i.ONE_MINUS_SRC_ALPHA),this.drawSolidFill(e[0],e[1],e[2],e[3]),i.blendFunc(i.SRC_ALPHA,i.ONE_MINUS_SRC_ALPHA)),this.bindFBO(this.blurFboA),this.drawColorControls(this.dialogBackdropTex,r,t,s),this.bindFBO(this.dialogBackdropFbo),this.drawCopy(this.blurFboATex)}};var Rr={renderNonGlassElement(e,r,t,s){let a=r;if(e.enterProgress!=null){let i=e.enterProgress,o=i<0?(1-Math.exp(-Math.abs(i)))*-1:i<=1?i:1+(1-Math.exp(-(i-1))),u=-48*(1-o),l=e.enterStretchFactor!=null&&o>1?e.enterStretchFactor*(o-1)*32*1:0;a={x:r.x,y:r.y+u+l,w:r.w,h:r.h}}return e.kind==="plain-rect"&&e.plainRect?this.renderPlainRectElement(e,r,a,s):e.kind==="progressive-blur"&&e.progressiveBlur?this.renderProgressiveBlurElement(e,a,s):e.kind==="text"?this.renderTextElement(e,a,t,s):!1}};function Pt(e,r,t,s,a,i){return e?{verdict:"SKIPPED",detail:r??"unknown"}:!isFinite(t)||t<=0?{verdict:"INVISIBLE",detail:`finalAlpha=${t} (colorA*enterA)`}:s<=0||a<=0?{verdict:"DEGENERATE",detail:`rect ${s.toFixed(1)}x${a.toFixed(1)} \u2264 0`}:i?{verdict:"OK",detail:`finalAlpha=${t.toFixed(3)}`}:{verdict:"NO_OP",detail:"BLEND disabled by prior element"}}var yr={renderPlainRectElement(e,r,t,s){let a=this.gl,i=e.isToggleTrack?null:e.plainRect.color;if(i&&i[3]<=0){if(this.showPlainRectDebug&&s!==this.bgOnlyFbo){let c=e.plainRect.color,n=e.enterSafeProgress!=null?Math.max(0,Math.min(1,e.enterSafeProgress)):e.enterProgress!=null?Math.max(0,Math.min(1,e.enterProgress)):1,h=e.enterProgress!=null?ve(n):1,m=c[3]*h,x=this.gl.isEnabled(this.gl.BLEND),p=`color alpha=${c[3]} \u2264 0`,g=Pt(!0,p,m,t.w,t.h,x);this.debugPlainRects.push({id:e.id,x:t.x,y:t.y,w:t.w,h:t.h,origH:e.rect.h,colorR:c[0],colorG:c[1],colorB:c[2],colorA:c[3],enterProgress:e.enterProgress??null,enterSafeProgress:e.enterSafeProgress??null,enterA:h,finalAlpha:m,skipped:!0,skipReason:p,drawn:!1,blendEnabled:x,curFboIsA:s===this.fboA,diagnosis:g.verdict,diagnosisDetail:g.detail})}return!0}this.bindFBO(s);let o=!1;if(e.clipRect){let c=Math.max(0,Math.round(t.x*this.dpr)),n=Math.max(0,Math.round((this.cssHeight-(t.y+t.h))*this.dpr)),h=Math.min(this.fboW-c,Math.round(t.w*this.dpr)),m=Math.min(this.fboH-n,Math.round(t.h*this.dpr)),x=this.intersectClipScissor(e,c,n,h,m);a.enable(a.SCISSOR_TEST),a.scissor(x.x,x.y,x.w,x.h),o=!0}let u;if(e.isToggleTrack){let c=this.toggleStates.get(e.isToggleTrack.groupId),n=c?c.fraction:0,h=e.isToggleTrack.offColor,m=e.isToggleTrack.onColor;u=[h[0]+(m[0]-h[0])*n,h[1]+(m[1]-h[1])*n,h[2]+(m[2]-h[2])*n,h[3]+(m[3]-h[3])*n]}else u=e.plainRect.color;let l=t;if(e.isSliderFill){let c=this.toggleStates.get(e.isSliderFill.groupId),n=c?c.fraction:0,h=Math.max(e.isSliderFill.minW,e.isSliderFill.trackW*n);l={x:r.x,y:r.y,w:h,h:r.h}}a.useProgram(this.plainRectProgram),this.setSdfUniforms(this.uPr,this.aPosLocPr,l,e.cornerRadius),a.blendFuncSeparate(a.SRC_ALPHA,a.ONE_MINUS_SRC_ALPHA,a.ONE,a.ONE_MINUS_SRC_ALPHA);let f=e.enterProgress!=null?(()=>{let c=e.enterSafeProgress!=null?Math.max(0,Math.min(1,e.enterSafeProgress)):Math.max(0,Math.min(1,e.enterProgress));return ve(c)})():1;if(a.uniform4f(this.uPr.uColor,u[0],u[1],u[2],u[3]*f),a.uniform1f(this.uPr.uCornerStyle,this.cornerStyle),e.useContinuousSdf&&this.loadContinuousSdf(t.w,t.h,e.cornerRadius),e.useContinuousSdf&&this.continuousSdfTexture?(a.activeTexture(a.TEXTURE2),a.bindTexture(a.TEXTURE_2D,this.continuousSdfTexture),a.uniform1i(this.uPr.uContinuousSdf,2),a.uniform1f(this.uPr.uUseContinuousSdf,1),a.uniform2f(this.uPr.uContinuousSdfTexSize,this.continuousSdfTexSize[0],this.continuousSdfTexSize[1]),a.uniform2f(this.uPr.uContinuousSdfElementSize,t.w*this.dpr,t.h*this.dpr)):a.uniform1f(this.uPr.uUseContinuousSdf,0),a.drawArrays(a.TRIANGLES,0,6),o&&a.disable(a.SCISSOR_TEST),this.perfMonitor.incNonGlass(),this.perfMonitor.incDrawCall(),this.showPlainRectDebug&&s!==this.bgOnlyFbo){let c=u[3]*f,n=this.gl.isEnabled(this.gl.BLEND),h=Pt(!1,null,c,l.w,l.h,n);this.debugPlainRects.push({id:e.id,x:l.x,y:l.y,w:l.w,h:l.h,origH:e.rect.h,colorR:u[0],colorG:u[1],colorB:u[2],colorA:u[3],enterProgress:e.enterProgress??null,enterSafeProgress:e.enterSafeProgress??null,enterA:f,finalAlpha:c,skipped:!1,skipReason:null,drawn:!0,blendEnabled:n,curFboIsA:s===this.fboA,diagnosis:h.verdict,diagnosisDetail:h.detail})}return!0}};var wr={renderTextElement(e,r,t,s){let a=this.gl;this.bindFBO(s);let i=r,o=1,u=1;if(e.isBottomTabContent){let n=this.toggleStates.get(e.isBottomTabContent.groupId);if(n){let h=e.isBottomTabContent.containerWidth??e.rect.w*4,m=1+16/h*n.pressProgress;o=m,u=m;let x=e.isBottomTabContent.containerCenterX??e.rect.x+e.rect.w/2,p=e.isBottomTabContent.containerCenterY??e.rect.y+e.rect.h/2,g=e.rect.x+e.rect.w/2,C=e.rect.y+e.rect.h/2,S=x+(g-x)*m+n.panelOffset,T=p+(C-p)*m,b=e.rect.w*o,v=e.rect.h*u;i={x:S-b/2,y:T-v/2,w:b,h:v}}}let l=t?.pressProgress??0,f=!1;if(e.clipRect){let n=Math.max(0,Math.round(i.x*this.dpr)),h=Math.max(0,Math.round((this.cssHeight-(i.y+i.h))*this.dpr)),m=Math.min(this.fboW-n,Math.round(i.w*this.dpr)),x=Math.min(this.fboH-h,Math.round(i.h*this.dpr)),p=this.intersectClipScissor(e,n,h,m,x);a.enable(a.SCISSOR_TEST),a.scissor(p.x,p.y,p.w,p.h),f=!0}if(e.isInteractive&&l>.001){let n=e.pressTintColor;a.useProgram(this.tintProgram),a.bindBuffer(a.ARRAY_BUFFER,this.quadBuffer),a.enableVertexAttribArray(this.aPosLocTn),a.vertexAttribPointer(this.aPosLocTn,2,a.FLOAT,!1,0,0),n?a.blendFunc(a.SRC_ALPHA,a.ONE_MINUS_SRC_ALPHA):a.blendFunc(a.SRC_ALPHA,a.ONE),a.uniform2f(this.uTn.uCanvasSize,this.canvas.width,this.canvas.height),a.uniform2f(this.uTn.uOffset,i.x*this.dpr,i.y*this.dpr),a.uniform2f(this.uTn.uSize,i.w*this.dpr,i.h*this.dpr),a.uniform4f(this.uTn.uCornerRadii,0,0,0,0),a.uniform2f(this.uTn.uOriginalSize,i.w*this.dpr,i.h*this.dpr),a.uniform1f(this.uTn.uOriginalCornerRadius,0),a.uniform2f(this.uTn.uLayerScale,1,1),n?a.uniform4f(this.uTn.uColor,n[0],n[1],n[2],.1*l):a.uniform4f(this.uTn.uColor,1,1,1,.1*l),a.drawArrays(a.TRIANGLES,0,6),a.blendFunc(a.SRC_ALPHA,a.ONE_MINUS_SRC_ALPHA)}let c=this.fgTextures.get(e.id);return c&&(a.useProgram(this.foregroundProgram),a.bindBuffer(a.ARRAY_BUFFER,this.quadBuffer),a.enableVertexAttribArray(this.aPosLocFg),a.vertexAttribPointer(this.aPosLocFg,2,a.FLOAT,!1,0,0),a.blendFunc(a.ONE,a.ONE_MINUS_SRC_ALPHA),a.activeTexture(a.TEXTURE0),a.bindTexture(a.TEXTURE_2D,c),a.uniform1i(this.uFg.uTexture,0),a.uniform2f(this.uFg.uCanvasSize,this.canvas.width,this.canvas.height),a.uniform2f(this.uFg.uOffset,i.x*this.dpr,i.y*this.dpr),a.uniform2f(this.uFg.uSize,i.w*this.dpr,i.h*this.dpr),a.uniform4f(this.uFg.uCornerRadii,e.cornerRadius*this.dpr,e.cornerRadius*this.dpr,e.cornerRadius*this.dpr,e.cornerRadius*this.dpr),a.uniform2f(this.uFg.uOriginalSize,e.rect.w*this.dpr,e.rect.h*this.dpr),a.uniform1f(this.uFg.uOriginalCornerRadius,e.cornerRadius*this.dpr),a.uniform2f(this.uFg.uLayerScale,o,u),a.uniform1f(this.uFg.uCornerStyle,this.cornerStyle),a.uniform1f(this.uFg.uUseContinuousSdf,0),a.uniform1f(this.uFg.uAlpha,e.enterProgress!=null?(()=>{let n=e.enterSafeProgress!=null?Math.max(0,Math.min(1,e.enterSafeProgress)):Math.max(0,Math.min(1,e.enterProgress));return ve(n)})():1),a.drawArrays(a.TRIANGLES,0,6),a.blendFunc(a.SRC_ALPHA,a.ONE_MINUS_SRC_ALPHA)),this.perfMonitor.incNonGlass(),this.perfMonitor.incDrawCall(),f&&a.disable(a.SCISSOR_TEST),!0}};var Ar={renderProgressiveBlurElement(e,r,t){let s=this.gl;this.bindFBO(t),s.useProgram(this.progressiveBlurProgram),this.setSdfUniforms(this.uPb,this.aPosLocPb,r,e.cornerRadius),s.blendFunc(s.ONE,s.ONE_MINUS_SRC_ALPHA),s.activeTexture(s.TEXTURE0),s.bindTexture(s.TEXTURE_2D,this.wallpaperTexture),s.uniform1i(this.uPb.uBackdrop,0),s.uniform2f(this.uPb.uWallpaperSize,this.wallpaperSize[0],this.wallpaperSize[1]),s.uniform1f(this.uPb.uBlurRadius,e.progressiveBlur.blurRadius*this.dpr);let a=e.progressiveBlur.tintColor;return s.uniform4f(this.uPb.uTintColor,a[0],a[1],a[2],a[3]),s.uniform1f(this.uPb.uTintIntensity,e.progressiveBlur.tintIntensity),s.drawArrays(s.TRIANGLES,0,6),this.perfMonitor.incNonGlass(),this.perfMonitor.incDrawCall(),!0}};function kr(e){return{elRefractionHeight:e.refractionHeight,elRefractionAmount:e.refractionAmount,elBlurRadius:e.blurRadius,elHighlightAlpha:e.highlight?e.highlight.alpha:0,elSurfaceAlpha:e.surfaceColor[3],elContentScaleX:1,elContentScaleY:1,useToggleBackdrop:0,useSolidBackdrop:0,solidR:1,solidG:1,solidB:1,solidA:1,trackColorR:0,trackColorG:0,trackColorB:0,trackColorA:0,trackCenterX:0,trackCenterY:0,trackHalfW:0,trackHalfH:0,trackCornerRadius:0,useIndicatorBackdrop:0,containerRectX:0,containerRectY:0,containerHalfW:0,containerHalfH:0,containerCornerRadius:0,indicatorAccentR:0,indicatorAccentG:0,indicatorAccentB:0,indicatorAccentA:0}}function Fr(e,r,t){let{el:s,sx:a,sy:i,sw:o,sh:u,togglePressProgress:l}=r;if(!s.isToggleKnob)return;let f=l;t.elRefractionHeight=s.refractionHeight*f,t.elRefractionAmount=s.refractionAmount*f,t.elBlurRadius=8*(1-f),t.elHighlightAlpha=(s.highlight?.alpha??0)*f,t.elSurfaceAlpha=0;let c=s.isToggleKnob.velocityDivisor===10,n=c?1:.75,h=c?1:.75;if(t.elContentScaleX=2/3+(n-2/3)*f,t.elContentScaleY=0+(h-0)*f,s.isToggleKnob.trackColorOff&&s.isToggleKnob.trackColorOn&&s.isToggleKnob.trackW&&s.isToggleKnob.trackH){let m=e.toggleStates.get(s.isToggleKnob.groupId),x=m?m.fraction:0,p=s.isToggleKnob.trackColorOff,g=s.isToggleKnob.trackColorOn;t.trackColorR=p[0]+(g[0]-p[0])*x,t.trackColorG=p[1]+(g[1]-p[1])*x,t.trackColorB=p[2]+(g[2]-p[2])*x,t.trackColorA=p[3]+(g[3]-p[3])*x;let C=(a+o/2)*e.dpr,S=(i+u/2)*e.dpr,T=s.isToggleKnob.trackOriginalX??s.rect.x,b=s.isToggleKnob.trackOriginalY??s.rect.y,v=s.scroll?b-e.scrollY:b,E=(T+s.isToggleKnob.trackW/2)*e.dpr,A=(v+s.isToggleKnob.trackH/2)*e.dpr,B=2/3+(n-2/3)*f,R=0+(h-0)*f;t.trackCenterX=C+(E-C)*B,t.trackCenterY=S+(A-S)*R;let y=s.isToggleKnob.trackW*e.dpr,M=s.isToggleKnob.trackH*e.dpr;if(t.trackHalfW=y*B*.5,t.trackHalfH=M*R*.5,t.trackCornerRadius=M*.5*Math.min(B,R),t.useToggleBackdrop=1,s.isToggleKnob.solidBackdropColor){let w=s.isToggleKnob.solidBackdropColor;t.solidR=w[0],t.solidG=w[1],t.solidB=w[2],t.solidA=w[3],t.useSolidBackdrop=1}t.elContentScaleX=1,t.elContentScaleY=1}}function Mr(e,r,t){let s=e.gl,{el:a,sx:i,sy:o,sw:u,sh:l,togglePressProgress:f}=r;if(!a.isBottomTabIndicator){s.uniform1f(e.uEl.uIndicatorPressProgress,0),s.uniform1f(e.uEl.uIndicatorPanelOffset,0),s.uniform1f(e.uEl.uDpr,e.dpr),s.uniform2f(e.uEl.uContainerCenter,0,0),s.uniform1f(e.uEl.uContainerScale,1),s.uniform1f(e.uEl.uTabContentCount,0),s.uniform2f(e.uEl.uInnerStrokeMaskOffset,1,1),s.uniform2f(e.uEl.uInnerStrokeMaskSize,1,1);return}let c=f;if(t.elRefractionHeight=a.refractionHeight*c,t.elRefractionAmount=a.refractionAmount*c,t.elBlurRadius=0,t.elHighlightAlpha=(a.highlight?.alpha??0)*c,a.isBottomTabIndicator.accentColor&&a.isBottomTabIndicator.containerRect){let b=a.isBottomTabIndicator.accentColor,v=a.isBottomTabIndicator.containerRect;t.indicatorAccentR=b[0],t.indicatorAccentG=b[1],t.indicatorAccentB=b[2],t.indicatorAccentA=1,t.containerRectX=(v.x+v.w/2)*e.dpr,t.containerRectY=(v.y+v.h/2)*e.dpr,t.containerHalfW=v.w/2*e.dpr,t.containerHalfH=v.h/2*e.dpr,t.containerCornerRadius=v.h/2*e.dpr,t.useIndicatorBackdrop=1}let n=e.toggleStates.get(a.isBottomTabIndicator.groupId);s.uniform1f(e.uEl.uIndicatorPressProgress,n?n.pressProgress:0),s.uniform1f(e.uEl.uIndicatorPanelOffset,n?n.panelOffset*e.dpr:0),s.uniform1f(e.uEl.uDpr,e.dpr);let h=a.isBottomTabIndicator.containerCenterX??0,m=a.isBottomTabIndicator.containerCenterY??0,x=a.isBottomTabIndicator.containerWidth??a.rect.w,p=n?1+16/x*n.pressProgress:1;s.uniform2f(e.uEl.uContainerCenter,h*e.dpr,m*e.dpr),s.uniform1f(e.uEl.uContainerScale,p);let g=a.isBottomTabIndicator.tabContentIds??[],C=a.isBottomTabIndicator.tabContentRects??[],S=Math.min(g.length,C.length,8),T=0;for(let b=0;b<8;b++)if(b<S){let v=e.fgTextures.get(g[b]);if(v){s.activeTexture(s.TEXTURE3+T),s.bindTexture(s.TEXTURE_2D,v),s.uniform1i(e.uEl[`uTabContentTex${T}`],3+T);let E=C[b];s.uniform4f(e.uEl[`uTabContentRects[${T}]`],(E.x+E.w/2)*e.dpr,(E.y+E.h/2)*e.dpr,E.w/2*e.dpr,E.h/2*e.dpr),T++}}for(let b=T;b<8;b++)s.uniform4f(e.uEl[`uTabContentRects[${b}]`],0,0,0,0);s.uniform1f(e.uEl.uTabContentCount,T),e.tabsBackdropTex&&(s.activeTexture(s.TEXTURE11),s.bindTexture(s.TEXTURE_2D,e.tabsBackdropTex),s.uniform1i(e.uEl.uTabsGlassLayer,11)),ms(e,t)}function ms(e,r){let t=e.gl,s=2*r.containerHalfW,a=2*r.containerHalfH,i=r.containerCornerRadius,o=Math.min(.5*e.dpr,Math.min(s,a)*.5),u=Math.max(1,Math.ceil(o)*2),l=Math.max(0,.25*e.dpr),f=Math.ceil(u)+4,c=Math.max(1,Math.ceil(s+2*f)),n=Math.max(1,Math.ceil(a+2*f)),h=window.devicePixelRatio||1,m=Math.min(2,Math.max(1,Math.floor(h/e.dpr))),x=c*m,p=n*m,g=["inner-rr",s.toFixed(3),a.toFixed(3),i.toFixed(3),u,l.toFixed(3),f,c,n,`ss${m}`].join(":"),C=e.strokeMaskCache.get(g);if(!C){let S=document.createElement("canvas");S.width=x,S.height=p;let T=S.getContext("2d",{alpha:!0});if(!T)throw new Error("2D canvas not supported");let b=t.createTexture();if(!b)throw new Error("WebGL texture allocation failed");if(C={tex:b,canvas:S,ctx:T,w:c,h:n,ready:!1},e.strokeMaskCache.set(g,C),e.strokeMaskCache.size>32){let v=e.strokeMaskCache.keys().next().value;if(v&&v!==g){let E=e.strokeMaskCache.get(v);E&&t.deleteTexture(E.tex),e.strokeMaskCache.delete(v)}}}if(!C.ready){let S=C.ctx;S.clearRect(0,0,x,p),S.save(),S.scale(m,m),S.translate(f,f);let T=Math.min(i,s/2,a/2),b=new Path2D;b.moveTo(T,0),b.lineTo(s-T,0),b.arcTo(s,0,s,T,T),b.lineTo(s,a-T),b.arcTo(s,a,s-T,a,T),b.lineTo(T,a),b.arcTo(0,a,0,a-T,T),b.lineTo(0,T),b.arcTo(0,0,T,0,T),b.closePath(),S.clip(b),S.lineWidth=u,S.strokeStyle="rgba(255,255,255,1)",S.lineJoin="round",S.lineCap="round",S.filter=l>.01?`blur(${l}px)`:"none",S.stroke(b),S.filter="none",S.restore(),t.bindTexture(t.TEXTURE_2D,C.tex),t.pixelStorei(t.UNPACK_FLIP_Y_WEBGL,!1),t.texImage2D(t.TEXTURE_2D,0,t.RGBA,t.RGBA,t.UNSIGNED_BYTE,C.canvas),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MAG_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_S,t.CLAMP_TO_EDGE),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_T,t.CLAMP_TO_EDGE),C.ready=!0}t.activeTexture(t.TEXTURE12),t.bindTexture(t.TEXTURE_2D,C.tex),t.uniform1i(e.uEl.uInnerStrokeMask,12),t.uniform2f(e.uEl.uInnerStrokeMaskOffset,f,f),t.uniform2f(e.uEl.uInnerStrokeMaskSize,C.w,C.h)}var Br={renderGlassElementPass(e,r,t){let s=this.gl,{el:a,sx:i,sy:o,sw:u,sh:l,radii:f,togglePressProgress:c,layerScale:n}=e;if(s.useProgram(this.elementProgram),s.bindBuffer(s.ARRAY_BUFFER,this.quadBuffer),s.enableVertexAttribArray(this.aPosLocEl),s.vertexAttribPointer(this.aPosLocEl,2,s.FLOAT,!1,0,0),s.blendFuncSeparate(s.ONE,s.ONE_MINUS_SRC_ALPHA,s.ONE,s.ONE_MINUS_SRC_ALPHA),s.activeTexture(s.TEXTURE0),s.bindTexture(s.TEXTURE_2D,r),s.uniform1i(this.uEl.uBackdrop,0),this.wallpaperTexture&&(s.activeTexture(s.TEXTURE1),s.bindTexture(s.TEXTURE_2D,this.wallpaperTexture),s.uniform1i(this.uEl.uWallpaperSampler,1)),s.uniform2f(this.uEl.uCanvasSize,this.canvas.width,this.canvas.height),s.uniform2f(this.uEl.uWallpaperSize,this.wallpaperSize[0],this.wallpaperSize[1]),s.uniform2f(this.uEl.uElementOffset,i*this.dpr,o*this.dpr),s.uniform2f(this.uEl.uElementSize,u*this.dpr,l*this.dpr),t){let b=this.canvas.width,v=this.canvas.height,E=t.x/b,A=(t.x+t.w)/b,B=1-t.y/v,R=1-(t.y+t.h)/v;s.uniform4f(this.uEl.uBackdropBbox,E,R,A-E,B-R)}else s.uniform4f(this.uEl.uBackdropBbox,0,0,1,1);s.uniform4f(this.uEl.uCornerRadii,f[0]*this.dpr,f[1]*this.dpr,f[2]*this.dpr,f[3]*this.dpr),s.uniform2f(this.uEl.uOriginalSize,e.origW*this.dpr,e.origH*this.dpr),s.uniform1f(this.uEl.uOriginalCornerRadius,e.origCornerRadius*this.dpr),s.uniform2f(this.uEl.uLayerScale,e.layerScaleX,e.layerScaleY),s.uniform1f(this.uEl.uElementRotation,a.elementRotation??0),s.uniform1f(this.uEl.uUsePerElementFbo,e.usePerElementFbo?1:0),e.usePerElementFbo&&(s.uniform2f(this.uEl.uSceneRectOffset,e.sceneRectOffsetX,e.sceneRectOffsetY),s.uniform2f(this.uEl.uElFboSize,e.elFboW,e.elFboH));let h=kr(a);Fr(this,e,h),Mr(this,e,h),s.uniform1f(this.uEl.uUseToggleBackdrop,h.useToggleBackdrop),s.uniform1f(this.uEl.uUseSolidBackdrop,h.useSolidBackdrop),s.uniform4f(this.uEl.uSolidBackdropColor,h.solidR,h.solidG,h.solidB,h.solidA),s.uniform4f(this.uEl.uTrackColor,h.trackColorR,h.trackColorG,h.trackColorB,h.trackColorA),s.uniform4f(this.uEl.uTrackRect,h.trackCenterX,h.trackCenterY,h.trackHalfW,h.trackHalfH),s.uniform1f(this.uEl.uTrackCornerRadius,h.trackCornerRadius),s.uniform1f(this.uEl.uIndicatorBackdrop,h.useIndicatorBackdrop),s.uniform4f(this.uEl.uContainerRect,h.containerRectX,h.containerRectY,h.containerHalfW,h.containerHalfH),s.uniform1f(this.uEl.uContainerCornerRadius,h.containerCornerRadius),s.uniform4f(this.uEl.uIndicatorAccent,h.indicatorAccentR,h.indicatorAccentG,h.indicatorAccentB,h.indicatorAccentA),s.uniform1f(this.uEl.uInsetPx,4*this.dpr);let m=this.quickToggles.refraction?h.elRefractionHeight:0,x=this.quickToggles.refraction?h.elRefractionAmount:0;s.uniform1f(this.uEl.uRefractionHeight,m*this.dpr),s.uniform1f(this.uEl.uRefractionAmount,x*this.dpr),s.uniform1f(this.uEl.uDepthEffect,a.depthEffect?1:0),s.uniform1f(this.uEl.uChromaticAberration,a.chromaticAberration&&this.quickToggles.chromatic?1:0);let p=a.sampleWallpaper||e.independent,g=_e(a,e)?0:h.elBlurRadius;if(s.uniform1f(this.uEl.uBlurRadius,g*n*this.dpr),s.uniform1f(this.uEl.uSaturation,a.saturation),s.uniform1f(this.uEl.uBrightness,a.brightness),s.uniform1f(this.uEl.uContrast,a.contrast),s.uniform1f(this.uEl.uContentScaleX,h.elContentScaleX),s.uniform1f(this.uEl.uContentScaleY,h.elContentScaleY),s.uniform4f(this.uEl.uTintColor,a.tintColor[0],a.tintColor[1],a.tintColor[2],a.tintColor[3]),s.uniform4f(this.uEl.uSurfaceColor,a.surfaceColor[0],a.surfaceColor[1],a.surfaceColor[2],h.elSurfaceAlpha),a.highlight){s.uniform3f(this.uEl.uHighlightColor,a.highlight.color[0],a.highlight.color[1],a.highlight.color[2]),s.uniform1f(this.uEl.uHighlightAngle,a.highlight.angle),s.uniform1f(this.uEl.uHighlightFalloff,a.highlight.falloff),s.uniform1f(this.uEl.uHighlightAlpha,h.elHighlightAlpha),s.uniform1f(this.uEl.uHighlightMode,a.highlight.mode);let b=Math.min(e.origW,e.origH)*this.dpr,v=Math.min(a.highlight.widthDp*this.dpr,b*.5),E=(a.highlight.blurRadiusDp??a.highlight.widthDp/2)*this.dpr,A=a.highlight.aa!==!1?Math.ceil(v)*2:Math.max(1,v)*2;s.uniform1f(this.uEl.uHighlightStrokeWidth,A),s.uniform1f(this.uEl.uHighlightBlur,E)}else s.uniform1f(this.uEl.uHighlightAlpha,0),s.uniform1f(this.uEl.uHighlightMode,0),s.uniform1f(this.uEl.uHighlightStrokeWidth,0),s.uniform1f(this.uEl.uHighlightBlur,0);let C=a.isSdfTexture?.textureSource??"clock",S=C==="text"?this.textSdfTexture:this.sdfTexture,T=C==="text"?this.textSdfTextureSize:this.sdfTextureSize;if(a.isSdfTexture&&S){s.activeTexture(s.TEXTURE2),s.bindTexture(s.TEXTURE_2D,S),s.uniform1i(this.uEl.uSdfTexSampler,2),s.uniform1f(this.uEl.uUseSdfTexture,1),s.uniform2f(this.uEl.uSdfTexSize,T[0],T[1]),s.uniform1f(this.uEl.uSdfLightAngle,a.useGravityAngle?this.gravityAngle*180/Math.PI:a.isSdfTexture.lightAngle),s.uniform1f(this.uEl.uRefractionHeight,(this.quickToggles.refraction?a.isSdfTexture.refractionHeight:0)*this.dpr),s.uniform1f(this.uEl.uSdfHighlightScale,a.isSdfTexture.highlightScale??1.5),s.uniform1f(this.uEl.uSdfBevelEnabled,a.isSdfTexture.bevelEnabled??!0?1:0),s.uniform1f(this.uEl.uSdfGlassTintHue,a.isSdfTexture.glassTintHue??0),s.uniform1f(this.uEl.uSdfGlassTintEnabled,a.isSdfTexture.glassTintEnabled??!1?1:0),s.uniform1f(this.uEl.uSdfGlassTintMix,a.isSdfTexture.glassTintMix??0),s.uniform1f(this.uEl.uSdfGlassTintStrength,a.isSdfTexture.glassTintStrength??.85),s.uniform1f(this.uEl.uSdfGlassTintSaturation,a.isSdfTexture.glassTintSaturation??1),s.uniform1f(this.uEl.uSdfGlassTintLightness,a.isSdfTexture.glassTintLightness??1),s.uniform1f(this.uEl.uSdfEdgeMatteEnabled,a.isSdfTexture.edgeMatteEnabled??!1?1:0),s.uniform1f(this.uEl.uSdfEdgeMatteTargets,a.isSdfTexture.edgeMatteTargets??7);let b=a.isSdfTexture.edgeMatteBevelParams??[1,0];s.uniform2f(this.uEl.uSdfEdgeMatteBevelParams,b[0],b[1]);let v=a.isSdfTexture.edgeMatteTintParams??[1,0];s.uniform2f(this.uEl.uSdfEdgeMatteTintParams,v[0],v[1]);let E=a.isSdfTexture.edgeMatteBaseParams??[1,0];s.uniform2f(this.uEl.uSdfEdgeMatteBaseParams,E[0],E[1]);let A=a.isSdfTexture.edgeMatteBrightenParams??[1,0];s.uniform2f(this.uEl.uSdfEdgeMatteBrightenParams,A[0],A[1]),s.uniform1f(this.uEl.uSdfEdgeMatteBevelStrength,a.isSdfTexture.edgeMatteBevelStrength??1),s.uniform1f(this.uEl.uSdfEdgeMatteTintStrength,a.isSdfTexture.edgeMatteTintStrength??1),s.uniform1f(this.uEl.uSdfEdgeMatteBaseStrength,a.isSdfTexture.edgeMatteBaseStrength??1),s.uniform1f(this.uEl.uSdfEdgeMatteBrightenStrength,a.isSdfTexture.edgeMatteBrightenStrength??1),s.uniform1f(this.uEl.uSdfDebugMode,a.isSdfTexture.debugMode?1:0),s.uniform1f(this.uEl.uSdfAaMin,a.isSdfTexture.aaMin??.5)}else s.uniform1f(this.uEl.uUseSdfTexture,0),s.uniform1f(this.uEl.uSdfHighlightScale,1.5),s.uniform1f(this.uEl.uSdfBevelEnabled,1),s.uniform1f(this.uEl.uSdfGlassTintHue,0),s.uniform1f(this.uEl.uSdfGlassTintEnabled,0),s.uniform1f(this.uEl.uSdfGlassTintMix,0),s.uniform1f(this.uEl.uSdfGlassTintStrength,.85),s.uniform1f(this.uEl.uSdfGlassTintSaturation,1),s.uniform1f(this.uEl.uSdfGlassTintLightness,1),s.uniform1f(this.uEl.uSdfEdgeMatteEnabled,0),s.uniform1f(this.uEl.uSdfEdgeMatteTargets,7),s.uniform2f(this.uEl.uSdfEdgeMatteBevelParams,1,0),s.uniform2f(this.uEl.uSdfEdgeMatteTintParams,1,0),s.uniform2f(this.uEl.uSdfEdgeMatteBaseParams,1,0),s.uniform2f(this.uEl.uSdfEdgeMatteBrightenParams,1,0),s.uniform1f(this.uEl.uSdfEdgeMatteBevelStrength,1),s.uniform1f(this.uEl.uSdfEdgeMatteTintStrength,1),s.uniform1f(this.uEl.uSdfEdgeMatteBaseStrength,1),s.uniform1f(this.uEl.uSdfEdgeMatteBrightenStrength,1),s.uniform1f(this.uEl.uSdfDebugMode,0),s.uniform1f(this.uEl.uSdfAaMin,.5),this.dummyTex&&(s.activeTexture(s.TEXTURE2),s.bindTexture(s.TEXTURE_2D,this.dummyTex));a.useContinuousSdf&&this.continuousSdfTexture?(s.activeTexture(s.TEXTURE2),s.bindTexture(s.TEXTURE_2D,this.continuousSdfTexture),s.uniform1i(this.uEl.uContinuousSdf,2),s.uniform1f(this.uEl.uUseContinuousSdf,1),s.uniform2f(this.uEl.uContinuousSdfTexSize,this.continuousSdfTexSize[0],this.continuousSdfTexSize[1]),s.uniform2f(this.uEl.uContinuousSdfElementSize,e.origW*this.dpr,e.origH*this.dpr)):(s.uniform1f(this.uEl.uUseContinuousSdf,0),this.dummyTex&&!a.isSdfTexture&&(s.activeTexture(s.TEXTURE2),s.bindTexture(s.TEXTURE_2D,this.dummyTex))),s.uniform1f(this.uEl.uNoContinuousSdfInRefraction,a.useContinuousSdf&&!this.noContinuousSdf?0:1),s.uniform1f(this.uEl.uEnterAlpha,e.enterAlpha),s.uniform1f(this.uEl.uCornerStyle,this.cornerStyle),a.isMagnifier?(s.uniform1f(this.uEl.uUseMagnifier,1),s.uniform1f(this.uEl.uMagnifierZoom,a.isMagnifier.zoom),s.uniform1f(this.uEl.uMagnifierOffsetY,a.isMagnifier.sampleOffsetY*this.dpr)):s.uniform1f(this.uEl.uUseMagnifier,0),s.uniform1f(this.uEl.uSkipColorControls,a.backdropFbo&&_e(a,e)?1:0),s.uniform1f(this.uEl.uSampleWallpaper,p?1:0),a.scrimColor?s.uniform4f(this.uEl.uScrimColor,a.scrimColor[0],a.scrimColor[1],a.scrimColor[2],a.scrimColor[3]):s.uniform4f(this.uEl.uScrimColor,0,0,0,0),s.drawArrays(s.TRIANGLES,0,6),e.elHighlightAlpha=h.elHighlightAlpha}};function gs(e,r,t,s){if(s){let o=new OffscreenCanvas(1,1).getContext("2d");return Ee(o,e,r,t)}let a=new Path2D;if(typeof a.roundRect=="function")a.roundRect(0,0,e,r,t);else{let i=Math.min(t,e/2,r/2);a.moveTo(i,0),a.lineTo(e-i,0),a.arcTo(e,0,e,i,i),a.lineTo(e,r-i),a.arcTo(e,r,e-i,r,i),a.lineTo(i,r),a.arcTo(0,r,0,r-i,i),a.lineTo(0,i),a.arcTo(0,0,i,0,i),a.closePath()}return a}function Lr(e,r){let t=new OffscreenCanvas(e,r),s=t.getContext("2d",{alpha:!0});return{canvas:t,ctx:s}}function Pr(e){let{w:r,h:t,radius:s,offsetX:a,offsetY:i,blurSigma:o,margin:u,useG2:l,supersample:f}=e,c=Math.max(1,Math.ceil(r+2*u)),n=Math.max(1,Math.ceil(t+2*u)),h=c*f,m=n*f,{canvas:x,ctx:p}=Lr(h,m),{canvas:g,ctx:C}=Lr(h,m);p.save(),p.scale(f,f),p.translate(u,u);let S=gs(r,t,s,l);return p.clip(S),p.globalCompositeOperation="source-over",p.fillStyle="white",p.fill(S),p.globalCompositeOperation="destination-out",p.save(),p.translate(a,i),p.fill(S),p.restore(),p.globalCompositeOperation="source-over",p.restore(),o>.01?C.filter=`blur(${o*f}px)`:C.filter="none",C.drawImage(x,0,0),C.filter="none",{canvas:g,maskW:c,maskH:n,margin:u}}function Gr(e,r){return["is",e,r.useG2?"g2":"rr",r.w.toFixed(3),r.h.toFixed(3),r.radius.toFixed(3),r.offsetX.toFixed(3),r.offsetY.toFixed(3),r.blurSigma.toFixed(3),r.margin,Math.ceil(r.w+2*r.margin),Math.ceil(r.h+2*r.margin),`ss${r.supersample}`].join(":")}function _r(e,r,t,s,a){let i=e.get(t);if(i)return i;let o=r.createTexture();if(!o)throw new Error("WebGL texture allocation failed");if(i={tex:o,w:s,h:a,ready:!1},e.set(t,i),e.size>32){let u=e.keys().next().value;if(u&&u!==t){let l=e.get(u);l&&r.deleteTexture(l.tex),e.delete(u)}}return i}function Or(e,r,t){e.bindTexture(e.TEXTURE_2D,r.tex),e.pixelStorei(e.UNPACK_FLIP_Y_WEBGL,!1),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,e.RGBA,e.UNSIGNED_BYTE,t.canvas),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),r.ready=!0}function Dr(e,r){for(let t of r.values())e.deleteTexture(t.tex);r.clear()}function Ir(e,r){let t=e.gl,{el:s,sx:a,sy:i,sw:o,sh:u,radii:l,togglePressProgress:f}=r;if(!s.innerShadow||!e.quickToggles.innershadow)return;let c=r.origW*e.dpr,n=r.origH*e.dpr,h=r.origCornerRadius*e.dpr,m=r.layerScaleX,x=r.layerScaleY;p(e,r,s.innerShadow,0);function p(g,C,S,T){let b=C.el.isToggleKnob||C.el.isBottomTabIndicator?f:1,v=S.alpha*b*C.enterAlpha,E=S.radius*b,A=S.offsetX*b,B=S.offsetY*b;if(v<=.001||E<=.5)return;let R=E*g.dpr,y=Math.ceil(R*3)+2,M=Math.max(1,Math.ceil(c+2*y)),w=Math.max(1,Math.ceil(n+2*y)),I=window.devicePixelRatio||1,k=Math.min(2,Math.max(1,Math.floor(I/g.dpr))),H=!!C.el.useContinuousSdf,L=A*g.dpr,P=B*g.dpr,X={w:c,h:n,radius:h,offsetX:L,offsetY:P,blurSigma:R,margin:y,useG2:H,supersample:k},$=Gr(T,X),V=_r(g.innerShadowMaskCache,t,$,M,w);if(!V.ready){let _=Pr(X);Or(t,V,_)}t.enable(t.BLEND),t.blendFunc(t.ONE,t.ONE_MINUS_SRC_ALPHA),t.useProgram(g.innerShadowMaskCompositeProgram),t.bindBuffer(t.ARRAY_BUFFER,g.quadBuffer),t.enableVertexAttribArray(g.aPosLocIs),t.vertexAttribPointer(g.aPosLocIs,2,t.FLOAT,!1,0,0),t.uniform2f(g.uIs.uCanvasSize,g.canvas.width,g.canvas.height),t.uniform2f(g.uIs.uOffset,a*g.dpr,i*g.dpr),t.uniform2f(g.uIs.uSize,o*g.dpr,u*g.dpr),t.uniform4f(g.uIs.uCornerRadii,l[0]*g.dpr,l[1]*g.dpr,l[2]*g.dpr,l[3]*g.dpr),t.activeTexture(t.TEXTURE0),t.bindTexture(t.TEXTURE_2D,V.tex),t.uniform1i(g.uIs.uInnerShadowMask,0),t.uniform2f(g.uIs.uMaskOffset,y,y),t.uniform2f(g.uIs.uMaskSize,V.w,V.h);let G=S.color??[0,0,0];t.uniform3f(g.uIs.uInnerShadowColor,G[0],G[1],G[2]),t.uniform1f(g.uIs.uInnerShadowAlpha,v),t.uniform2f(g.uIs.uOriginalSize,c,n),t.uniform1f(g.uIs.uOriginalCornerRadius,h),t.uniform2f(g.uIs.uLayerScale,m,x),t.uniform1f(g.uIs.uElementRotation,C.elementRotation),t.drawArrays(t.TRIANGLES,0,6)}}function Hr(e,r){let t=e.gl,{el:s,st:a,isButton:i,p:o,sx:u,sy:l,sw:f,sh:c,radii:n,togglePressProgress:h}=r,m=r.origW*e.dpr,x=r.origH*e.dpr,p=r.origCornerRadius*e.dpr,g=r.layerScaleX,C=r.layerScaleY,S=()=>{s.useContinuousSdf&&e.continuousSdfTexture?(t.activeTexture(t.TEXTURE2),t.bindTexture(t.TEXTURE_2D,e.continuousSdfTexture),t.uniform1i(e.uTn.uContinuousSdf,2),t.uniform1f(e.uTn.uUseContinuousSdf,1),t.uniform2f(e.uTn.uContinuousSdfTexSize,e.continuousSdfTexSize[0],e.continuousSdfTexSize[1]),t.uniform2f(e.uTn.uContinuousSdfElementSize,r.origW*e.dpr,r.origH*e.dpr)):t.uniform1f(e.uTn.uUseContinuousSdf,0)},T=!!s.isBottomTabContainer,b=i?o:T?h:0;if(i&&s.isInteractive&&a&&o>.001||T&&h>.001){t.useProgram(e.tintProgram),t.bindBuffer(t.ARRAY_BUFFER,e.quadBuffer),t.enableVertexAttribArray(e.aPosLocTn),t.vertexAttribPointer(e.aPosLocTn,2,t.FLOAT,!1,0,0),t.blendFunc(t.SRC_ALPHA,t.ONE),t.uniform2f(e.uTn.uCanvasSize,e.canvas.width,e.canvas.height),t.uniform2f(e.uTn.uOffset,u*e.dpr,l*e.dpr),t.uniform2f(e.uTn.uSize,f*e.dpr,c*e.dpr),t.uniform4f(e.uTn.uCornerRadii,n[0]*e.dpr,n[1]*e.dpr,n[2]*e.dpr,n[3]*e.dpr),t.uniform2f(e.uTn.uOriginalSize,m,x),t.uniform1f(e.uTn.uOriginalCornerRadius,p),t.uniform2f(e.uTn.uLayerScale,g,C),t.uniform1f(e.uTn.uElementRotation,r.elementRotation),t.uniform1f(e.uTn.uCornerStyle,e.cornerStyle),S(),t.uniform4f(e.uTn.uColor,1,1,1,.08*b),t.drawArrays(t.TRIANGLES,0,6),t.useProgram(e.highlightProgram),t.bindBuffer(t.ARRAY_BUFFER,e.quadBuffer),t.enableVertexAttribArray(e.aPosLocHl),t.vertexAttribPointer(e.aPosLocHl,2,t.FLOAT,!1,0,0),t.blendFunc(t.ONE,t.ONE),t.uniform2f(e.uHl.uCanvasSize,e.canvas.width,e.canvas.height),t.uniform2f(e.uHl.uOffset,u*e.dpr,l*e.dpr),t.uniform2f(e.uHl.uSize,f*e.dpr,c*e.dpr),t.uniform4f(e.uHl.uCornerRadii,n[0]*e.dpr,n[1]*e.dpr,n[2]*e.dpr,n[3]*e.dpr),t.uniform2f(e.uHl.uOriginalSize,m,x),t.uniform1f(e.uHl.uOriginalCornerRadius,p),t.uniform2f(e.uHl.uLayerScale,g,C),t.uniform1f(e.uHl.uElementRotation,r.elementRotation),t.uniform1f(e.uHl.uCornerStyle,e.cornerStyle),t.uniform4f(e.uHl.uColor,1,1,1,.15*b);let v=Math.min(f,c)*e.dpr;t.uniform1f(e.uHl.uRadius,v*1.5);let E,A;if(T){let B=e.toggleStates.get(s.isBottomTabContainer.groupId),R=s.isBottomTabContainer.tabsCount??4,y=s.rect.w/R,w=((B?B.fraction:0)+.5)*y,I=f/s.rect.w;E=Math.max(0,Math.min(f,w*I))*e.dpr,A=c/2*e.dpr}else E=Math.max(0,Math.min(f,a.dragX*r.layerScaleX))*e.dpr,A=Math.max(0,Math.min(c,a.dragY*r.layerScaleY))*e.dpr;t.uniform2f(e.uHl.uPosition,E,A),t.drawArrays(t.TRIANGLES,0,6),t.blendFunc(t.SRC_ALPHA,t.ONE_MINUS_SRC_ALPHA)}if(s.isToggleKnob&&h<.999){let v=1*(1-h);t.useProgram(e.tintProgram),t.bindBuffer(t.ARRAY_BUFFER,e.quadBuffer),t.enableVertexAttribArray(e.aPosLocTn),t.vertexAttribPointer(e.aPosLocTn,2,t.FLOAT,!1,0,0),t.blendFunc(t.SRC_ALPHA,t.ONE_MINUS_SRC_ALPHA),t.uniform2f(e.uTn.uCanvasSize,e.canvas.width,e.canvas.height),t.uniform2f(e.uTn.uOffset,u*e.dpr,l*e.dpr),t.uniform2f(e.uTn.uSize,f*e.dpr,c*e.dpr),t.uniform4f(e.uTn.uCornerRadii,n[0]*e.dpr,n[1]*e.dpr,n[2]*e.dpr,n[3]*e.dpr),t.uniform2f(e.uTn.uOriginalSize,m,x),t.uniform1f(e.uTn.uOriginalCornerRadius,p),t.uniform2f(e.uTn.uLayerScale,g,C),t.uniform1f(e.uTn.uElementRotation,r.elementRotation),t.uniform1f(e.uTn.uCornerStyle,e.cornerStyle),S(),t.uniform4f(e.uTn.uColor,1,1,1,v),t.drawArrays(t.TRIANGLES,0,6)}if(s.isBottomTabIndicator&&s.isBottomTabIndicator.dimColor){let v=s.isBottomTabIndicator.dimColor,E=h;t.useProgram(e.tintProgram),t.bindBuffer(t.ARRAY_BUFFER,e.quadBuffer),t.enableVertexAttribArray(e.aPosLocTn),t.vertexAttribPointer(e.aPosLocTn,2,t.FLOAT,!1,0,0),t.blendFunc(t.SRC_ALPHA,t.ONE_MINUS_SRC_ALPHA),t.uniform2f(e.uTn.uCanvasSize,e.canvas.width,e.canvas.height),t.uniform2f(e.uTn.uOffset,u*e.dpr,l*e.dpr),t.uniform2f(e.uTn.uSize,f*e.dpr,c*e.dpr),t.uniform4f(e.uTn.uCornerRadii,n[0]*e.dpr,n[1]*e.dpr,n[2]*e.dpr,n[3]*e.dpr),t.uniform2f(e.uTn.uOriginalSize,m,x),t.uniform1f(e.uTn.uOriginalCornerRadius,p),t.uniform2f(e.uTn.uLayerScale,g,C),t.uniform1f(e.uTn.uElementRotation,r.elementRotation),t.uniform1f(e.uTn.uCornerStyle,e.cornerStyle),S(),t.uniform4f(e.uTn.uColor,v[0],v[1],v[2],.1*(1-E)),t.drawArrays(t.TRIANGLES,0,6),t.uniform4f(e.uTn.uColor,0,0,0,.03*E),t.drawArrays(t.TRIANGLES,0,6),t.blendFunc(t.SRC_ALPHA,t.ONE_MINUS_SRC_ALPHA)}}function zr(e,r){let t=e.gl,{el:s,sx:a,sy:i,sw:o,sh:u,radii:l,togglePressProgress:f,elHighlightAlpha:c}=r;if(!s.highlight||s.highlight.alpha<=.001||!e.quickToggles.highlight)return;let n=r.origW*e.dpr,h=r.origH*e.dpr,m=r.origCornerRadius*e.dpr,x=r.layerScaleX,p=r.layerScaleY,g=s.isToggleKnob||s.isBottomTabIndicator?c:s.highlight.alpha,C=s.highlight.mode===1?.38:1,S=g*r.enterAlpha*C;if(S<=.001)return;let T=Math.min(s.highlight.widthDp*e.dpr,Math.min(n,h)*.5),b=s.highlight.aa!==!1?Math.max(1,Math.ceil(T)*2):Math.max(1,Math.round(T)*2),v=Math.max(0,(s.highlight.blurRadiusDp??s.highlight.widthDp/2)*e.dpr),E=Math.ceil(b)+4,A=Math.max(1,Math.ceil(n+2*E)),B=Math.max(1,Math.ceil(h+2*E)),R=window.devicePixelRatio||1,y=Math.min(2,Math.max(1,Math.floor(R/e.dpr))),M=A*y,w=B*y,I=!!s.useContinuousSdf,k=[I?"g2":"rr",n.toFixed(3),h.toFixed(3),m.toFixed(3),b,v.toFixed(3),E,A,B,`ss${y}`].join(":"),H=e.strokeMaskCache.get(k);if(!H){let L=document.createElement("canvas");L.width=M,L.height=w;let P=L.getContext("2d",{alpha:!0});if(!P)throw new Error("2D canvas not supported");let X=t.createTexture();if(!X)throw new Error("WebGL texture allocation failed");if(H={tex:X,canvas:L,ctx:P,w:A,h:B,ready:!1},e.strokeMaskCache.set(k,H),e.strokeMaskCache.size>32){let $=e.strokeMaskCache.keys().next().value;if($&&$!==k){let V=e.strokeMaskCache.get($);V&&t.deleteTexture(V.tex),e.strokeMaskCache.delete($)}}}if(!H.ready){let L=H.ctx;L.clearRect(0,0,M,w),L.save(),L.scale(y,y),L.translate(E,E);let P;if(I)P=Ee(L,n,h,m);else{P=new Path2D;let X=Math.min(m,n/2,h/2);P.moveTo(X,0),P.lineTo(n-X,0),P.arcTo(n,0,n,X,X),P.lineTo(n,h-X),P.arcTo(n,h,n-X,h,X),P.lineTo(X,h),P.arcTo(0,h,0,h-X,X),P.lineTo(0,X),P.arcTo(0,0,X,0,X),P.closePath()}L.clip(P),L.lineWidth=b,L.strokeStyle="rgba(255,255,255,1)",L.lineJoin="round",L.lineCap="round",L.filter=v>.01?`blur(${v}px)`:"none",L.stroke(P),L.filter="none",L.restore(),t.bindTexture(t.TEXTURE_2D,H.tex),t.pixelStorei(t.UNPACK_FLIP_Y_WEBGL,!1),t.texImage2D(t.TEXTURE_2D,0,t.RGBA,t.RGBA,t.UNSIGNED_BYTE,H.canvas),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MAG_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_S,t.CLAMP_TO_EDGE),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_T,t.CLAMP_TO_EDGE),H.ready=!0}t.enable(t.BLEND),s.highlight.mode===1?t.blendFunc(t.ONE,t.ONE_MINUS_SRC_ALPHA):t.blendFunc(t.ONE,t.ONE),t.useProgram(e.strokeMaskCompositeProgram),t.bindBuffer(t.ARRAY_BUFFER,e.quadBuffer),t.enableVertexAttribArray(e.aPosLocSm),t.vertexAttribPointer(e.aPosLocSm,2,t.FLOAT,!1,0,0),t.uniform2f(e.uSm.uCanvasSize,e.canvas.width,e.canvas.height),t.uniform2f(e.uSm.uOffset,a*e.dpr,i*e.dpr),t.uniform2f(e.uSm.uSize,o*e.dpr,u*e.dpr),t.uniform4f(e.uSm.uCornerRadii,l[0]*e.dpr,l[1]*e.dpr,l[2]*e.dpr,l[3]*e.dpr),t.activeTexture(t.TEXTURE0),t.bindTexture(t.TEXTURE_2D,H.tex),t.uniform1i(e.uSm.uStrokeMask,0),t.uniform2f(e.uSm.uMaskOffset,E,E),t.uniform2f(e.uSm.uMaskSize,H.w,H.h),t.uniform4f(e.uSm.uHighlightColor,s.highlight.color[0],s.highlight.color[1],s.highlight.color[2],1),t.uniform1f(e.uSm.uHighlightAngle,s.useGravityAngle?e.gravityAngle:s.highlight.angle),t.uniform1f(e.uSm.uHighlightFalloff,s.highlight.falloff),t.uniform1f(e.uSm.uHighlightAlpha,S),t.uniform1f(e.uSm.uHighlightMode,s.highlight.mode),t.uniform2f(e.uSm.uOriginalSize,n,h),t.uniform1f(e.uSm.uOriginalCornerRadius,m),t.uniform2f(e.uSm.uLayerScale,x,p),t.uniform1f(e.uSm.uElementRotation,r.elementRotation),t.drawArrays(t.TRIANGLES,0,6),t.blendFunc(t.SRC_ALPHA,t.ONE_MINUS_SRC_ALPHA)}var Ur={renderGlassPostPasses(e){let r=this.gl,{el:t,st:s,isButton:a,p:i,sx:o,sy:u,sw:l,sh:f,radii:c}=e,n=e.origW*this.dpr,h=e.origH*this.dpr,m=e.origCornerRadius*this.dpr,x=e.layerScaleX,p=e.layerScaleY;if(Ir(this,e),Hr(this,e),a&&(t.label||t.icon)){let g=this.fgTextures.get(t.id);g&&(r.useProgram(this.foregroundProgram),r.bindBuffer(r.ARRAY_BUFFER,this.quadBuffer),r.enableVertexAttribArray(this.aPosLocFg),r.vertexAttribPointer(this.aPosLocFg,2,r.FLOAT,!1,0,0),r.blendFunc(r.ONE,r.ONE_MINUS_SRC_ALPHA),r.activeTexture(r.TEXTURE0),r.bindTexture(r.TEXTURE_2D,g),r.uniform1i(this.uFg.uTexture,0),r.uniform2f(this.uFg.uCanvasSize,this.canvas.width,this.canvas.height),r.uniform2f(this.uFg.uOffset,o*this.dpr,u*this.dpr),r.uniform2f(this.uFg.uSize,l*this.dpr,f*this.dpr),r.uniform4f(this.uFg.uCornerRadii,c[0]*this.dpr,c[1]*this.dpr,c[2]*this.dpr,c[3]*this.dpr),r.uniform2f(this.uFg.uOriginalSize,n,h),r.uniform1f(this.uFg.uOriginalCornerRadius,m),r.uniform2f(this.uFg.uLayerScale,x,p),r.uniform1f(this.uFg.uCornerStyle,this.cornerStyle),t.useContinuousSdf&&this.continuousSdfTexture?(r.activeTexture(r.TEXTURE2),r.bindTexture(r.TEXTURE_2D,this.continuousSdfTexture),r.uniform1i(this.uFg.uContinuousSdf,2),r.uniform1f(this.uFg.uUseContinuousSdf,1),r.uniform2f(this.uFg.uContinuousSdfTexSize,this.continuousSdfTexSize[0],this.continuousSdfTexSize[1]),r.uniform2f(this.uFg.uContinuousSdfElementSize,e.origW*this.dpr,e.origH*this.dpr)):r.uniform1f(this.uFg.uUseContinuousSdf,0),r.uniform1f(this.uFg.uAlpha,1-.15*i),r.drawArrays(r.TRIANGLES,0,6),r.blendFunc(r.SRC_ALPHA,r.ONE_MINUS_SRC_ALPHA))}zr(this,e)}};var Wr={markElementDirty(e){this.dirtyElementIds.add(e);let r=this.elFboCache.get(e);if(r&&(r.valid=!1),this.showDirtyMarkers){let s=(new Error().stack??"").split(`
`),a="unknown";for(let i=2;i<s.length;i++){let o=s[i].trim();if(!o||o.includes("markElementDirty")||o.includes("markGroupDirty")||o.includes("markAllDirty"))continue;let u=o.match(/at\s+(\S+)\s+\(/);a=u?u[1]:o.slice(0,60);break}this.debugDirtySourceLog.push({id:e,source:a})}},markAllDirty(){this.allDirty=!0,this.dirtyElementIds.clear();for(let e of this.elFboCache.values())e.valid=!1},markGroupDirty(e){for(let r of this.buttonConfigs)(r.isToggleKnob?.groupId===e||r.isToggleTrack?.groupId===e||r.isSliderFill?.groupId===e||r.isBottomTabContainer?.groupId===e||r.isBottomTabContent?.groupId===e||r.isBottomTabIndicator?.groupId===e)&&this.markElementDirty(r.id)},markGravityDirty(){for(let e of this.buttonConfigs)e.useGravityAngle&&this.markElementDirty(e.id)},hasDirtyElements(){return this.allDirty||this.dirtyElementIds.size>0},deleteElFboCacheEntry(e){let r=this.elFboCache.get(e);if(!r)return;let t=this.gl;t.deleteFramebuffer(r.fb),t.deleteTexture(r.tex),this.elFboCache.delete(e)}};function ps(e){let{pixels:r,dpr:t}=e,s=r.length;if(s<4)return{edgeIdx:0,edgeOffsetCss:0,transitionHalfW:0,rgbInside:0,rgbOutside:0,minRgbInTransition:0,blackFringeDetected:!1,hasNearBlackPx:!1,canvasOpaque:!0,verdict:"Scan too short (element not found or off-screen)."};let a=new Float32Array(s),i=0;for(let y=0;y<s;y++){let M=r[y];a[y]=.299*M.r+.587*M.g+.114*M.b,M.a>=250&&i++}let o=i>s*.9,u=0,l=Math.floor(s/2);for(let y=2;y<s-2;y++){let M=Math.abs(a[y+1]-a[y-1]);M>u&&(u=M,l=y)}let f=r[l].offset,c=Math.max(3,Math.floor(s/8)),n=Math.max(0,l-c),h=Math.min(s-1,l+c),m=Math.max(0,n-3),x=Math.max(m,n-1),p=0,g=0;for(let y=m;y<=x;y++)p+=a[y],g++;p=g>0?p/g:a[0];let C=Math.min(s-1,h+1),S=Math.min(s-1,h+3),T=0,b=0;for(let y=C;y<=S;y++)T+=a[y],b++;T=b>0?T/b:a[s-1];let v=255,E=!1;for(let y=n;y<=h;y++){let M=a[y];M<v&&(v=M),M<30&&(E=!0)}let B=u>10&&v<Math.min(p,T)-25&&v<100,R;return B&&E?R=`\u26A0 BLACK FRINGE: RGB dips to ${v.toFixed(0)} at edge (inside=${p.toFixed(0)}, outside=${T.toFixed(0)}). Near-black pixels in transition zone \u2192 premult-alpha leak or refraction reads outside FBO.`:B?R=`\u26A0 DARK EDGE: RGB dips to ${v.toFixed(0)} at edge (inside=${p.toFixed(0)}, outside=${T.toFixed(0)}). Edge is darker than both sides.`:E&&u>10?R=`\u26A0 NEAR-BLACK PX at edge: min RGB ${v.toFixed(0)} (inside=${p.toFixed(0)}, outside=${T.toFixed(0)}). Investigate.`:u<=10?R=`~ Flat scan (no sharp edge detected). Max gradient ${u.toFixed(1)}. Element may be off-screen or uniformly colored.`:R=`\u2713 Clean edge. Transition RGB ${v.toFixed(0)} is between inside ${p.toFixed(0)} and outside ${T.toFixed(0)}. No black fringe.`,{edgeIdx:l,edgeOffsetCss:f,transitionHalfW:c,rgbInside:p,rgbOutside:T,minRgbInTransition:v,blackFringeDetected:B,hasNearBlackPx:E,canvasOpaque:o,verdict:R}}var Nr={debugReadEdgeScanline(e=20){this._pendingEdgeScan={halfRangeCss:e},this.requestRender()},debugCycleEdgeScanTarget(){let e=this.buttonConfigs.filter(r=>r.useContinuousSdf&&r.rect.w>0&&r.rect.h>0);return e.length===0?0:(this._edgeScanTargetIdx=(this._edgeScanTargetIdx+1)%e.length,this._pendingEdgeScan={halfRangeCss:20},this.requestRender(),this._edgeScanTargetIdx)},debugClearEdgeScan(){this._pendingEdgeScan=null,this._edgeScanResult=null,this._edgeScanCounter++},_debugFlushPendingEdgeScan(){let e=this._pendingEdgeScan;if(!e)return;this._pendingEdgeScan=null;let r=this.buttonConfigs.filter(G=>G.useContinuousSdf&&G.rect.w>0&&G.rect.h>0).map(G=>{let _=Math.min(G.rect.w,G.rect.h),Z=G.cornerRadius>=_/2-.5;return{el:G,isCapsule:Z}}).sort((G,_)=>Number(_.isCapsule)-Number(G.isCapsule));if(r.length===0){this._edgeScanCounter++,this._edgeScanResult={scanId:this._edgeScanCounter,elementId:"(none)",targetIdx:0,targetCount:0,isCapsule:!1,rect:{x:0,y:0,w:0,h:0},cornerRadius:0,dpr:this.dpr||1,cornerCenter:{x:0,y:0},cornerPoint45:{x:0,y:0},patchCssX:0,patchCssY:0,patchDevSize:0,halfRange:e.halfRangeCss,patch:new Uint8Array(0),pixels:[],sdfProfile:null,sdfTexSize:0,analysis:{edgeIdx:0,edgeOffsetCss:0,transitionHalfW:0,rgbInside:0,rgbOutside:0,minRgbInTransition:0,blackFringeDetected:!1,hasNearBlackPx:!1,canvasOpaque:!0,verdict:"No useContinuousSdf element found on screen."}};return}let t=this._edgeScanTargetIdx%r.length,s=r[t],a=s.el,{rect:i,cornerRadius:o}=a,u=this.dpr||1,l=this.gl,f=e.halfRangeCss,c=Math.SQRT2,n=i.x+i.w-o,h=i.y+o,m=n+o/c,x=h-o/c,p=m-f,g=x-f,C=f*2,S=Math.max(1,Math.round(C*u)),T=Math.round(p*u),b=Math.round(g*u),v=Math.min(S,this.canvas.width-T),E=Math.min(S,this.canvas.height-b);if(v<=0||E<=0)return;let A=this.canvas.height-(b+E),B=Math.max(0,Math.min(this.canvas.height-E,A));l.bindFramebuffer(l.FRAMEBUFFER,null);let R=new Uint8Array(v*E*4);l.readPixels(T,B,v,E,l.RGBA,l.UNSIGNED_BYTE,R);let y=new Uint8Array(v*E*4);for(let G=0;G<E;G++){let _=E-1-G;y.set(R.subarray(_*v*4,(_+1)*v*4),G*v*4)}let M=Math.min(v,E),w=[];for(let G=0;G<M;G++){let _=v-1-G,j=(G*v+_)*4,se=(M/2-G)/u;w.push({offset:se,r:y[j],g:y[j+1],b:y[j+2],a:y[j+3]})}this._edgeScanCounter++;let I=null,k=0,H=nr(),L=i.w,P=i.h,X=Math.round(o),$=H.find(G=>{let _=G.key.split(",");return Math.round(parseFloat(_[0]))===Math.round(L)&&Math.round(parseFloat(_[1]))===Math.round(P)&&Math.round(parseFloat(_[2]))===X});if($){k=$.texSize;let G=$.tex,_=$.texSize,Z=L*u,j=P*u,se=Math.max(Z,j),oe=(_-2*4)/se,ne=i.x+i.w/2,re=i.y+i.h/2;I=[];for(let F=0;F<M;F++){let O=v-1-F,K=F,Y=p+O/u,D=g+K/u,z=(Y-ne)*u,U=(D-re)*u,W=_/2+z*oe,N=_/2+U*oe,q=W/_,Es=N/_,Nt=W,Xt=N,ke=Math.floor(Nt),Fe=Math.floor(Xt),De=Nt-ke,Ie=Xt-Fe,be=Jr=>Math.max(0,Math.min(_-1,Jr)),qt=(be(Fe)*_+be(ke))*4,Yt=(be(Fe)*_+be(ke+1))*4,Vt=(be(Fe+1)*_+be(ke))*4,Kt=(be(Fe+1)*_+be(ke+1))*4,$t=(1-De)*(1-Ie),Zt=De*(1-Ie),jt=(1-De)*Ie,Qt=De*Ie,Zr=G[qt]*$t+G[Yt]*Zt+G[Vt]*jt+G[Kt]*Qt,jr=G[qt+1]*$t+G[Yt+1]*Zt+G[Vt+1]*jt+G[Kt+1]*Qt,Qr=(M/2-F)/u;I.push({r:Zr,g:jr,offset:Qr})}}let V={scanId:this._edgeScanCounter,elementId:a.id,targetIdx:t,targetCount:r.length,isCapsule:s.isCapsule,rect:{x:i.x,y:i.y,w:i.w,h:i.h},cornerRadius:o,dpr:u,cornerCenter:{x:n,y:h},cornerPoint45:{x:m,y:x},patchCssX:p,patchCssY:g,patchDevSize:v,halfRange:f,patch:y,pixels:w,sdfProfile:I,sdfTexSize:k};this._edgeScanResult={...V,analysis:ps(V)}}};var Xr={cacheUniforms(){let e=this.gl,r=["uBackdrop","uWallpaperSampler","uTabsBackdropSampler","uCanvasSize","uWallpaperSize","uElementOffset","uElementSize","uBackdropBbox","uCornerRadii","uRefractionHeight","uRefractionAmount","uDepthEffect","uChromaticAberration","uBlurRadius","uSaturation","uBrightness","uContrast","uTintColor","uSurfaceColor","uHighlightColor","uHighlightAngle","uHighlightFalloff","uHighlightAlpha","uHighlightMode","uHighlightStrokeWidth","uHighlightBlur","uContentScaleX","uContentScaleY","uUseToggleBackdrop","uUseSolidBackdrop","uSolidBackdropColor","uTrackColor","uTrackRect","uTrackCornerRadius","uOriginalSize","uOriginalCornerRadius","uLayerScale","uIndicatorBackdrop","uContainerRect","uContainerCornerRadius","uIndicatorAccent","uInsetPx","uIndicatorPressProgress","uIndicatorPanelOffset","uDpr","uContainerCenter","uContainerScale","uTabContentTex0","uTabContentTex1","uTabContentTex2","uTabContentTex3","uTabContentTex4","uTabContentTex5","uTabContentTex6","uTabContentTex7","uTabContentRects[0]","uTabContentRects[1]","uTabContentRects[2]","uTabContentRects[3]","uTabContentRects[4]","uTabContentRects[5]","uTabContentRects[6]","uTabContentRects[7]","uTabContentCount","uTabsGlassLayer","uSdfTexSampler","uUseSdfTexture","uSdfTexSize","uSdfLightAngle","uEnterAlpha","uSdfHighlightScale","uSdfBevelEnabled","uSdfGlassTintHue","uSdfGlassTintEnabled","uSdfGlassTintMix","uSdfGlassTintStrength","uSdfGlassTintSaturation","uSdfGlassTintLightness","uSdfEdgeMatteEnabled","uSdfEdgeMatteTargets","uSdfEdgeMatteBevelParams","uSdfEdgeMatteTintParams","uSdfEdgeMatteBaseParams","uSdfEdgeMatteBrightenParams","uSdfEdgeMatteBevelStrength","uSdfEdgeMatteTintStrength","uSdfEdgeMatteBaseStrength","uSdfEdgeMatteBrightenStrength","uSdfDebugMode","uSdfAaMin","uUsePerElementFbo","uSceneRectOffset","uElFboSize","uBackdropRect","uCornerStyle","uSkipColorControls","uUseMagnifier","uMagnifierZoom","uMagnifierOffsetY","uElementRotation","uContinuousSdf","uUseContinuousSdf","uContinuousSdfTexSize","uContinuousSdfElementSize","uNoContinuousSdfInRefraction","uInnerStrokeMask","uInnerStrokeMaskOffset","uInnerStrokeMaskSize"];for(let b of r)this.uEl[b]=e.getUniformLocation(this.elementProgram,b);let t=["uCanvasSize","uElementOffset","uElementSize","uCornerRadii","uShadowRadius","uShadowOffset","uShadowColor","uOriginalSize","uOriginalCornerRadius","uLayerScale","uElementRotation","uCornerStyle"];for(let b of t)this.uSh[b]=e.getUniformLocation(this.shadowProgram,b);let s=["uBackdrop","uCanvasSize","uWallpaperSize"];for(let b of s)this.uWp[b]=e.getUniformLocation(this.wallpaperProgram,b);let a=["uTexture","uCanvasSize","uOffset","uSize","uCornerRadii","uAlpha","uOriginalSize","uOriginalCornerRadius","uLayerScale","uCornerStyle","uUseContinuousSdf","uContinuousSdf","uContinuousSdfTexSize","uContinuousSdfElementSize"];for(let b of a)this.uFg[b]=e.getUniformLocation(this.foregroundProgram,b);let i=["uCanvasSize","uOffset","uSize","uCornerRadii","uColor","uRadius","uPosition","uOriginalSize","uOriginalCornerRadius","uLayerScale","uElementRotation","uCornerStyle"];for(let b of i)this.uHl[b]=e.getUniformLocation(this.highlightProgram,b);let o=["uCanvasSize","uOffset","uSize","uCornerRadii","uColor","uOriginalSize","uOriginalCornerRadius","uLayerScale","uElementRotation","uCornerStyle"];for(let b of o)this.uTn[b]=e.getUniformLocation(this.tintProgram,b);let u=["uCanvasSize","uOffset","uSize","uCornerRadii","uHighlightColor","uHighlightAngle","uHighlightFalloff","uHighlightAlpha","uHighlightMode","uHighlightStrokeWidth","uHighlightBlur","uOriginalSize","uOriginalCornerRadius","uLayerScale","uElementRotation","uCornerStyle","uUseContinuousSdf","uContinuousSdf","uContinuousSdfTexSize","uContinuousSdfElementSize"];for(let b of u)this.uRm[b]=e.getUniformLocation(this.rimHighlightProgram,b);let l=["uCanvasSize","uOffset","uSize","uCornerRadii","uHighlightStrokeWidth","uOriginalSize","uOriginalCornerRadius","uLayerScale","uElementRotation","uCornerStyle","uUseContinuousSdf","uContinuousSdf","uContinuousSdfTexSize","uContinuousSdfElementSize"];for(let b of l)this.uHs[b]=e.getUniformLocation(this.highlightStrokeProgram,b);let f=["uCanvasSize","uOffset","uSize","uCornerRadii","uBlurredMask","uMaskTexSize","uHighlightColor","uHighlightAngle","uHighlightFalloff","uHighlightAlpha","uHighlightMode","uOriginalSize","uOriginalCornerRadius","uLayerScale","uElementRotation","uCornerStyle","uUseContinuousSdf","uContinuousSdf","uContinuousSdfTexSize","uContinuousSdfElementSize"];for(let b of f)this.uHc[b]=e.getUniformLocation(this.highlightCompositeProgram,b);let c=["uCanvasSize","uOffset","uSize","uCornerRadii","uStrokeMask","uMaskOffset","uMaskSize","uHighlightColor","uHighlightAngle","uHighlightFalloff","uHighlightAlpha","uHighlightMode","uOriginalSize","uOriginalCornerRadius","uLayerScale","uElementRotation"];for(let b of c)this.uSm[b]=e.getUniformLocation(this.strokeMaskCompositeProgram,b);let n=["uCanvasSize","uOffset","uSize","uCornerRadii","uInnerShadowMask","uMaskOffset","uMaskSize","uInnerShadowColor","uInnerShadowAlpha","uOriginalSize","uOriginalCornerRadius","uLayerScale","uElementRotation"];for(let b of n)this.uIs[b]=e.getUniformLocation(this.innerShadowMaskCompositeProgram,b);let h=["uCanvasSize","uOffset","uSize","uCornerRadii","uColor","uCornerStyle","uUseContinuousSdf","uContinuousSdf","uContinuousSdfTexSize","uContinuousSdfElementSize"];for(let b of h)this.uPr[b]=e.getUniformLocation(this.plainRectProgram,b);let m=["uBackdrop","uCanvasSize","uWallpaperSize","uOffset","uSize","uBlurRadius","uTintColor","uTintIntensity"];for(let b of m)this.uPb[b]=e.getUniformLocation(this.progressiveBlurProgram,b);let x=["uTexture","uCanvasSize"];for(let b of x)this.uCp[b]=e.getUniformLocation(this.copyProgram,b);let p=["uColor"];for(let b of p)this.uSf[b]=e.getUniformLocation(this.solidFillProgram,b);let g=["uTexture","uTexSize","uBrightness","uContrast","uSaturation"];for(let b of g)this.uCc[b]=e.getUniformLocation(this.colorControlsProgram,b);let C=["uTexture","uCanvasSize","uTintColor"];for(let b of C)this.uSt[b]=e.getUniformLocation(this.sceneTintProgram,b);let S=["uTexture","uCanvasSize","uElementCenter","uElementSize","uRotation","uSrcSize"];for(let b of S)this.uEf[b]=e.getUniformLocation(this.elFboCompositeProgram,b);let T=["uTexture","uSrcOffset","uSrcSize","uDstSize"];for(let b of T)this.uEc[b]=e.getUniformLocation(this.elFboCropProgram,b)}};function qr(e,r,t,s){let a=f=>{let c=Te(e,e.FRAGMENT_SHADER,t(r,f)),n=Te(e,e.VERTEX_SHADER,Q),h=e.createProgram();if(e.attachShader(h,n),e.attachShader(h,c),e.bindAttribLocation(h,0,"aPos"),e.linkProgram(h),e.deleteShader(n),e.deleteShader(c),!e.getProgramParameter(h,e.LINK_STATUS)){let m=e.getProgramInfoLog(h);throw e.deleteProgram(h),new Error(s+" (taps="+r+","+f+"): "+m)}return h},i=a("horizontal"),o=a("vertical"),u={uTexture:e.getUniformLocation(i,"uTexture"),uTexSize:e.getUniformLocation(i,"uTexSize"),uRadius:e.getUniformLocation(i,"uRadius")},l={uTexture:e.getUniformLocation(o,"uTexture"),uTexSize:e.getUniformLocation(o,"uTexSize"),uRadius:e.getUniformLocation(o,"uRadius")};return{hProg:i,vProg:o,uH:u,uV:l,aPosH:0,aPosV:0}}var Yr={ensureBlurPrograms(e){this.blurPrograms.has(e)||this.blurPrograms.set(e,qr(this.gl,e,gt,"Blur program link error"))},pickDsBlurLevel(e){if(!this.dynamicBlurDownsample||this.dsBlurLevels.length===0)return{ds:this.effectiveBlurDownsample||1,fboA:this.dsBlurFboA,texA:this.dsBlurFboATex,fboB:this.dsBlurFboB,texB:this.dsBlurFboBTex,w:this.dsBlurFboW||this.fboW,h:this.dsBlurFboH||this.fboH};let r=this.dsBlurLevels,t=Math.max(.5,e),s=r[r.length-1].ds,a=1;if(t>=6){let i=Math.floor(Math.log2(t/6));a=Math.pow(2,i)}a>s&&(a=s),a<1&&(a=1);for(let i=r.length-1;i>=0;i--)if(r[i].ds<=a)return r[i];return r[0]},runBlurPasses(e,r,t,s,a,i,o,u,l,f){let c=this.gl,n=performance.now();f?this.ensureBlurPrograms(l):this.ensureHighlightBlurPrograms(l);let h=(f?this.blurPrograms:this.highlightBlurPrograms).get(l),m=performance.now(),x=performance.now(),p=c.getParameter(c.FRAMEBUFFER_BINDING),g=c.isEnabled(c.SCISSOR_TEST),C=c.getParameter(c.SCISSOR_BOX);c.disable(c.SCISSOR_TEST),c.disable(c.BLEND);let S=performance.now(),T=performance.now();c.bindFramebuffer(c.FRAMEBUFFER,r),c.viewport(0,0,i,o),c.useProgram(h.hProg),c.bindBuffer(c.ARRAY_BUFFER,this.quadBuffer),c.enableVertexAttribArray(h.aPosH),c.vertexAttribPointer(h.aPosH,2,c.FLOAT,!1,0,0),c.activeTexture(c.TEXTURE0),c.bindTexture(c.TEXTURE_2D,e),c.uniform1i(h.uH.uTexture,0),c.uniform2f(h.uH.uTexSize,i,o),c.uniform1f(h.uH.uRadius,u),c.drawArrays(c.TRIANGLES,0,6);let b=performance.now(),v=performance.now();c.bindFramebuffer(c.FRAMEBUFFER,s),c.viewport(0,0,i,o),c.useProgram(h.vProg),c.bindBuffer(c.ARRAY_BUFFER,this.quadBuffer),c.enableVertexAttribArray(h.aPosV),c.vertexAttribPointer(h.aPosV,2,c.FLOAT,!1,0,0),c.activeTexture(c.TEXTURE0),c.bindTexture(c.TEXTURE_2D,t),c.uniform1i(h.uV.uTexture,0),c.uniform2f(h.uV.uTexSize,i,o),c.uniform1f(h.uV.uRadius,u),c.drawArrays(c.TRIANGLES,0,6);let E=performance.now(),A=performance.now();c.bindFramebuffer(c.FRAMEBUFFER,p),c.viewport(0,0,this.fboW,this.fboH),g&&(c.enable(c.SCISSOR_TEST),c.scissor(C[0],C[1],C[2],C[3]));let B=performance.now();return this.lastBlurStats&&(this.lastBlurStats.progMs=m-n,this.lastBlurStats.stateMs=S-x+(B-A),this.lastBlurStats.drawMs=b-T+(E-v)),a},blurTexture(e,r,t){if(t)return this.ensureElementFBO(t.w,t.h),this.cropAndBlurBackdrop(e,t.x,t.y,t.w,t.h,r);if(this.useKawaseBlur)return this.kawaseBlurTexture(e,r);let s=this.pickDsBlurLevel(r),a=s.ds,i=a>1?r/a:r;if(i<.5)return this.lastBlurStats={type:"gauss",passes:0,taps:0,maxSample:0,w:s.w,h:s.h,progMs:0,stateMs:0,drawMs:0},e;let o=Me(i);return o=Math.min(o,Math.max(1,this.blurTapCap|0)),this.lastBlurStats={type:"gauss",passes:2,taps:o,maxSample:3*i,w:s.w,h:s.h,progMs:0,stateMs:0,drawMs:0},this.runBlurPasses(e,s.fboA,s.texA,s.fboB,s.texB,s.w,s.h,i,o,!0)},ensureKawaseProgram(){if(this.kawasePrograms)return;let e=this.gl,r=Te(e,e.FRAGMENT_SHADER,St()),t=Te(e,e.VERTEX_SHADER,Q),s=e.createProgram();if(e.attachShader(s,t),e.attachShader(s,r),e.bindAttribLocation(s,0,"aPos"),e.linkProgram(s),e.deleteShader(t),e.deleteShader(r),!e.getProgramParameter(s,e.LINK_STATUS)){let a=e.getProgramInfoLog(s);throw e.deleteProgram(s),new Error("Kawase program link error: "+a)}this.kawasePrograms={prog:s,uTexture:e.getUniformLocation(s,"uTexture"),uTexSize:e.getUniformLocation(s,"uTexSize"),uRadius:e.getUniformLocation(s,"uRadius"),uIteration:e.getUniformLocation(s,"uIteration"),uTotalIters:e.getUniformLocation(s,"uTotalIters"),aPos:0}},kawaseBlurTexture(e,r){let t=this.pickDsBlurLevel(r),s=t.ds,a=s>1?r/s:r;if(a<.5)return this.lastBlurStats={type:"kawase",passes:0,taps:0,maxSample:0,w:t.w,h:t.h,progMs:0,stateMs:0,drawMs:0},e;let i=Be(a,this.kawaseQuality),o=a*Math.sqrt(6*i/((i+1)*(2*i+1)));this.lastBlurStats={type:"kawase",passes:i,taps:4*i,maxSample:o*Math.SQRT2,w:t.w,h:t.h,progMs:0,stateMs:0,drawMs:0};let u=performance.now();this.ensureKawaseProgram();let l=this.kawasePrograms,f=performance.now(),c=performance.now(),n=this.gl,h=t.w,m=t.h,x=n.getParameter(n.FRAMEBUFFER_BINDING),p=n.isEnabled(n.SCISSOR_TEST),g=n.getParameter(n.SCISSOR_BOX);n.disable(n.SCISSOR_TEST),n.disable(n.BLEND);let C=performance.now(),S=performance.now(),T=e;for(let B=0;B<i;B++){let R=B%2===0,y=R?t.fboA:t.fboB;n.bindFramebuffer(n.FRAMEBUFFER,y),n.viewport(0,0,h,m),n.useProgram(l.prog),n.bindBuffer(n.ARRAY_BUFFER,this.quadBuffer),n.enableVertexAttribArray(l.aPos),n.vertexAttribPointer(l.aPos,2,n.FLOAT,!1,0,0),n.activeTexture(n.TEXTURE0),n.bindTexture(n.TEXTURE_2D,T),n.uniform1i(l.uTexture,0),n.uniform2f(l.uTexSize,h,m),n.uniform1f(l.uRadius,a),n.uniform1f(l.uIteration,B),n.uniform1f(l.uTotalIters,i),n.drawArrays(n.TRIANGLES,0,6),T=R?t.texA:t.texB}let b=performance.now(),v=performance.now();n.bindFramebuffer(n.FRAMEBUFFER,x),n.viewport(0,0,this.fboW,this.fboH),p&&(n.enable(n.SCISSOR_TEST),n.scissor(g[0],g[1],g[2],g[3]));let E=performance.now();return this.lastBlurStats.progMs=f-u,this.lastBlurStats.stateMs=C-c+(E-v),this.lastBlurStats.drawMs=b-S,(i-1)%2===0?t.texA:t.texB},ensureHighlightBlurPrograms(e){this.highlightBlurPrograms.has(e)||this.highlightBlurPrograms.set(e,qr(this.gl,e,pt,"Highlight blur program link error"))},blurHighlightMask(e,r){let t=this.pickDsBlurLevel(r),s=t.ds,a=s>1?r/s:r;if(a<.01)return e;let i=bt(a);return i=Math.min(i,Math.max(3,this.blurTapCap|0)),this.runBlurPasses(e,t.fboA,t.texA,t.fboB,t.texB,t.w,t.h,a,i,!1)}};var Vr={dispose(){this.rafId!==null&&cancelAnimationFrame(this.rafId),this.rafId=null,this.animRafId!==null&&cancelAnimationFrame(this.animRafId),this.animRafId=null;let e=this.gl;this.wallpaperTexture&&e.deleteTexture(this.wallpaperTexture);for(let r of this.fgTextures.values())e.deleteTexture(r);this.fgTextures.clear();for(let r of this.strokeMaskCache.values())e.deleteTexture(r.tex);this.strokeMaskCache.clear(),Dr(e,this.innerShadowMaskCache),this.fboA&&e.deleteFramebuffer(this.fboA),this.fboATex&&e.deleteTexture(this.fboATex),this.fboB&&e.deleteFramebuffer(this.fboB),this.fboBTex&&e.deleteTexture(this.fboBTex),this.fboA=this.fboB=null,this.fboATex=this.fboBTex=null,this.tabsBackdropFbo&&e.deleteFramebuffer(this.tabsBackdropFbo),this.tabsBackdropTex&&e.deleteTexture(this.tabsBackdropTex),this.tabsBackdropFbo=null,this.tabsBackdropTex=null,this.wallpaperBlurFbo&&e.deleteFramebuffer(this.wallpaperBlurFbo),this.wallpaperBlurTex&&e.deleteTexture(this.wallpaperBlurTex),this.blurFboA&&e.deleteFramebuffer(this.blurFboA),this.blurFboATex&&e.deleteTexture(this.blurFboATex),this.blurFboB&&e.deleteFramebuffer(this.blurFboB),this.blurFboBTex&&e.deleteTexture(this.blurFboBTex),this.dsBlurFboA&&e.deleteFramebuffer(this.dsBlurFboA),this.dsBlurFboATex&&e.deleteTexture(this.dsBlurFboATex),this.dsBlurFboB&&e.deleteFramebuffer(this.dsBlurFboB),this.dsBlurFboBTex&&e.deleteTexture(this.dsBlurFboBTex);for(let r of this.dsBlurLevels)e.deleteFramebuffer(r.fboA),e.deleteTexture(r.texA),e.deleteFramebuffer(r.fboB),e.deleteTexture(r.texB);this.dsBlurLevels=[],this.wallpaperBlurFbo=this.blurFboA=this.blurFboB=this.dsBlurFboA=this.dsBlurFboB=null,this.wallpaperBlurTex=this.blurFboATex=this.blurFboBTex=this.dsBlurFboATex=this.dsBlurFboBTex=null,this.highlightMaskFbo&&e.deleteFramebuffer(this.highlightMaskFbo),this.highlightMaskTex&&e.deleteTexture(this.highlightMaskTex),this.highlightMaskFbo=null,this.highlightMaskTex=null,this.dialogBackdropFbo&&e.deleteFramebuffer(this.dialogBackdropFbo),this.dialogBackdropTex&&e.deleteTexture(this.dialogBackdropTex),this.dialogBackdropFbo=null,this.dialogBackdropTex=null,this.dialogBackdropKey=null,this.bgOnlyFbo&&e.deleteFramebuffer(this.bgOnlyFbo),this.bgOnlyTex&&e.deleteTexture(this.bgOnlyTex),this.bgOnlyFbo=null,this.bgOnlyTex=null,this.elFbo&&e.deleteFramebuffer(this.elFbo),this.elFboTex&&e.deleteTexture(this.elFboTex),this.elFbo=null,this.elFboTex=null,this.elFboW=this.elFboH=0,this.backdropCropFbo&&e.deleteFramebuffer(this.backdropCropFbo),this.backdropCropTex&&e.deleteTexture(this.backdropCropTex),this.backdropCropFbo=null,this.backdropCropTex=null,this.elBlurFboA&&e.deleteFramebuffer(this.elBlurFboA),this.elBlurFboATex&&e.deleteTexture(this.elBlurFboATex),this.elBlurFboB&&e.deleteFramebuffer(this.elBlurFboB),this.elBlurFboBTex&&e.deleteTexture(this.elBlurFboBTex),this.elBlurFboA=this.elBlurFboB=null,this.elBlurFboATex=this.elBlurFboBTex=null;for(let r of this.elFboCache.values())e.deleteFramebuffer(r.fb),e.deleteTexture(r.tex);this.elFboCache.clear();for(let{hProg:r,vProg:t}of this.blurPrograms.values())e.deleteProgram(r),e.deleteProgram(t);this.blurPrograms.clear();for(let{hProg:r,vProg:t}of this.highlightBlurPrograms.values())e.deleteProgram(r),e.deleteProgram(t);this.highlightBlurPrograms.clear(),this.kawasePrograms&&(e.deleteProgram(this.kawasePrograms.prog),this.kawasePrograms=null);for(let r of this.backdropBlurCache.values())e.deleteTexture(r.tex),e.deleteFramebuffer(r.fb);this.backdropBlurCache.clear();for(let r of this.backdropBlurCacheFboPool)e.deleteTexture(r.tex),e.deleteFramebuffer(r.fb);this.backdropBlurCacheFboPool.length=0,this.cacheCopyReadFbo&&(e.deleteFramebuffer(this.cacheCopyReadFbo),this.cacheCopyReadFbo=null),this.sdfTexture&&e.deleteTexture(this.sdfTexture),this.sdfTexture=null,this.textSdfTexture&&e.deleteTexture(this.textSdfTexture),this.textSdfTexture=null;for(let{tex:r}of this.continuousSdfPool.values())e.deleteTexture(r);this.continuousSdfPool.clear(),this.continuousSdfTexture=null,this.continuousSdfKey=null,this._debugUploadedSdfTexMap.clear(),e.deleteProgram(this.elementProgram),e.deleteProgram(this.shadowProgram),e.deleteProgram(this.wallpaperProgram),e.deleteProgram(this.foregroundProgram),e.deleteProgram(this.highlightProgram),e.deleteProgram(this.tintProgram),e.deleteProgram(this.rimHighlightProgram),e.deleteProgram(this.highlightStrokeProgram),e.deleteProgram(this.highlightCompositeProgram),e.deleteProgram(this.strokeMaskCompositeProgram),e.deleteProgram(this.innerShadowMaskCompositeProgram),e.deleteProgram(this.plainRectProgram),e.deleteProgram(this.progressiveBlurProgram),e.deleteProgram(this.copyProgram),e.deleteProgram(this.solidFillProgram),e.deleteProgram(this.colorControlsProgram),e.deleteProgram(this.sceneTintProgram),e.deleteProgram(this.elFboCompositeProgram),e.deleteProgram(this.elFboCropProgram),e.deleteBuffer(this.quadBuffer)}};var me=class{constructor(r){d(this,"gl");d(this,"elementProgram");d(this,"shadowProgram");d(this,"wallpaperProgram");d(this,"foregroundProgram");d(this,"highlightProgram");d(this,"tintProgram");d(this,"rimHighlightProgram");d(this,"highlightStrokeProgram");d(this,"highlightCompositeProgram");d(this,"strokeMaskCompositeProgram");d(this,"innerShadowMaskCompositeProgram");d(this,"plainRectProgram");d(this,"progressiveBlurProgram");d(this,"copyProgram");d(this,"solidFillProgram");d(this,"colorControlsProgram");d(this,"sceneTintProgram");d(this,"elFboCompositeProgram");d(this,"elFboCropProgram");d(this,"quadBuffer");d(this,"wallpaperTexture",null);d(this,"wallpaperReady",!1);d(this,"wallpaperSize",[1,1]);d(this,"canvas");d(this,"dpr",0);d(this,"buttonConfigs",[]);d(this,"buttonStates",new Map);d(this,"toggleStates",new Map);d(this,"scrollY",0);d(this,"scrollVelocity",0);d(this,"contentHeight",0);d(this,"cssWidth",0);d(this,"cssHeight",0);d(this,"wheelTarget",null);d(this,"backgroundColor",null);d(this,"needsRedraw",!0);d(this,"dirtyElementIds",new Set);d(this,"allDirty",!0);d(this,"showDirtyMarkers",!1);d(this,"debugDirtyMarkers",[]);d(this,"_dbgLastGlassCacheHit",!1);d(this,"dirtyRectsThisFrame",[]);d(this,"lastRenderedScrollY",0);d(this,"debugCacheMissLog",[]);d(this,"debugDirtySourceLog",[]);d(this,"fboA",null);d(this,"fboATex",null);d(this,"fboB",null);d(this,"fboBTex",null);d(this,"fboW",0);d(this,"fboH",0);d(this,"tabsBackdropFbo",null);d(this,"tabsBackdropTex",null);d(this,"tabsBackdropDirty",!0);d(this,"wallpaperBlurFbo",null);d(this,"wallpaperBlurTex",null);d(this,"blurFboA",null);d(this,"blurFboATex",null);d(this,"blurFboB",null);d(this,"blurFboBTex",null);d(this,"dsBlurFboA",null);d(this,"dsBlurFboATex",null);d(this,"dsBlurFboB",null);d(this,"dsBlurFboBTex",null);d(this,"highlightMaskFbo",null);d(this,"highlightMaskTex",null);d(this,"dialogBackdropFbo",null);d(this,"dialogBackdropTex",null);d(this,"dialogBackdropKey",null);d(this,"bgOnlyFbo",null);d(this,"bgOnlyTex",null);d(this,"blurPrograms",new Map);d(this,"highlightBlurPrograms",new Map);d(this,"kawasePrograms",null);d(this,"useKawaseBlur",!0);d(this,"useBlurCache",!0);d(this,"kawaseQuality",1);d(this,"gravityAngle",45*Math.PI/180);d(this,"blurTapCap",9);d(this,"blurDownsample",4);d(this,"dsBlurFboW",0);d(this,"dsBlurFboH",0);d(this,"effectiveBlurDownsample",4);d(this,"dynamicBlurDownsample",!1);d(this,"dsBlurLevels",[]);d(this,"cornerStyle",1);d(this,"capsuleSdfQuality",.5);d(this,"noContinuousSdf",!0);d(this,"directBackdropSample",!0);d(this,"usePerElementFbo",!1);d(this,"quickToggles",{highlight:!0,backdropBlur:!0,chromatic:!0,refraction:!0,outerShadow:!0,innershadow:!0,perElementFbo:!1,isolateBackdrop:!1});d(this,"isSoftwareRenderer",!1);d(this,"showPefBbox",!1);d(this,"debugPefBboxes",[]);d(this,"showBlurDebug",!1);d(this,"debugBlurRegions",[]);d(this,"lastBlurStats",null);d(this,"backdropBlurCache",new Map);d(this,"backdropBlurCacheFboPool",[]);d(this,"cacheCopyReadFbo",null);d(this,"backdropBlurCacheMax",64);d(this,"_blurCacheMissesThisFrame",0);d(this,"blurCacheMissesPerFrame",1);d(this,"_lastBlurCacheScrollY",0);d(this,"showBlurCacheCheckerboard",!1);d(this,"showBlurCachePreview",!1);d(this,"backdropBlurCacheSnapshots",[]);d(this,"showShadowBbox",!1);d(this,"debugShadowBboxes",[]);d(this,"debugSdfHoleTopLeftR",!1);d(this,"debugSdfHoleTopLeftG",!1);d(this,"showCullDebug",!1);d(this,"debugCullRects",[]);d(this,"showPefPassDebug",!1);d(this,"debugPefPasses",[]);d(this,"showPlainRectDebug",!1);d(this,"debugPlainRects",[]);d(this,"perfMonitor",new ze);d(this,"elFbo",null);d(this,"elFboTex",null);d(this,"elFboW",0);d(this,"elFboH",0);d(this,"elFboCache",new Map);d(this,"wallpaperVersion",0);d(this,"backdropCropFbo",null);d(this,"backdropCropTex",null);d(this,"elBlurFboA",null);d(this,"elBlurFboATex",null);d(this,"elBlurFboB",null);d(this,"elBlurFboBTex",null);d(this,"sdfTexture",null);d(this,"sdfTextureReady",!1);d(this,"sdfTextureSize",[1,1]);d(this,"textSdfTexture",null);d(this,"textSdfTextureReady",!1);d(this,"textSdfTextureSize",[1,1]);d(this,"continuousSdfPool",new Map);d(this,"continuousSdfTexture",null);d(this,"continuousSdfTexSize",[128,128]);d(this,"continuousSdfKey",null);d(this,"dummyTex",null);d(this,"_lastCapsuleGenMs",0);d(this,"_lastCapsuleUploadMs",0);d(this,"_lastCapsuleKey","");d(this,"_debugUploadedSdfTexMap",new Map);d(this,"_pendingEdgeScan",null);d(this,"_edgeScanResult",null);d(this,"_edgeScanCounter",0);d(this,"_edgeScanTargetIdx",0);d(this,"fgCanvas");d(this,"fgCtx");d(this,"fgTextures",new Map);d(this,"fgDirtyIds",new Set);d(this,"strokeMaskCache",new Map);d(this,"innerShadowMaskCache",new Map);d(this,"rafId",null);d(this,"animRafId",null);d(this,"pendingExtraRenders",0);d(this,"aPosLocEl");d(this,"aPosLocSh");d(this,"aPosLocWp");d(this,"aPosLocFg");d(this,"aPosLocHl");d(this,"aPosLocTn");d(this,"aPosLocRm");d(this,"aPosLocHs");d(this,"aPosLocHc");d(this,"aPosLocSm");d(this,"aPosLocIs");d(this,"aPosLocPr");d(this,"aPosLocPb");d(this,"aPosLocCp");d(this,"aPosLocSf");d(this,"aPosLocCc");d(this,"aPosLocSt");d(this,"aPosLocEf");d(this,"aPosLocEc");d(this,"uEl",{});d(this,"uSh",{});d(this,"uWp",{});d(this,"uFg",{});d(this,"uHl",{});d(this,"uTn",{});d(this,"uRm",{});d(this,"uHs",{});d(this,"uHc",{});d(this,"uSm",{});d(this,"uIs",{});d(this,"uPr",{});d(this,"uPb",{});d(this,"uCp",{});d(this,"uSf",{});d(this,"uCc",{});d(this,"uSt",{});d(this,"uEf",{});d(this,"uEc",{});this.canvas=r;let t=r.getContext("webgl",{premultipliedAlpha:!1,alpha:!1,antialias:!1,preserveDrawingBuffer:!0,powerPreference:"high-performance"});if(!t)throw new Error("WebGL not supported");this.gl=t,this.elementProgram=ee(t,Q,Ze),this.shadowProgram=ee(t,Q,je),this.wallpaperProgram=ee(t,Q,it),this.foregroundProgram=ee(t,Q,ht),this.highlightProgram=ee(t,Q,Qe),this.tintProgram=ee(t,Q,Je),this.rimHighlightProgram=ee(t,Q,et),this.highlightStrokeProgram=ee(t,Q,tt),this.highlightCompositeProgram=ee(t,Q,rt),this.strokeMaskCompositeProgram=ee(t,Q,st),this.innerShadowMaskCompositeProgram=ee(t,Q,at),this.plainRectProgram=ee(t,Q,ft),this.progressiveBlurProgram=ee(t,Q,mt),this.copyProgram=ee(t,Q,ot),this.solidFillProgram=ee(t,Q,nt),this.colorControlsProgram=ee(t,Q,ct),this.sceneTintProgram=ee(t,Q,dt),this.elFboCompositeProgram=ee(t,Q,ut),this.elFboCropProgram=ee(t,Q,lt),this.quadBuffer=t.createBuffer(),t.bindBuffer(t.ARRAY_BUFFER,this.quadBuffer),t.bufferData(t.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),t.STATIC_DRAW),this.aPosLocEl=t.getAttribLocation(this.elementProgram,"aPos"),this.aPosLocSh=t.getAttribLocation(this.shadowProgram,"aPos"),this.aPosLocWp=t.getAttribLocation(this.wallpaperProgram,"aPos"),this.aPosLocFg=t.getAttribLocation(this.foregroundProgram,"aPos"),this.aPosLocHl=t.getAttribLocation(this.highlightProgram,"aPos"),this.aPosLocTn=t.getAttribLocation(this.tintProgram,"aPos"),this.aPosLocRm=t.getAttribLocation(this.rimHighlightProgram,"aPos"),this.aPosLocHs=t.getAttribLocation(this.highlightStrokeProgram,"aPos"),this.aPosLocHc=t.getAttribLocation(this.highlightCompositeProgram,"aPos"),this.aPosLocSm=t.getAttribLocation(this.strokeMaskCompositeProgram,"aPos"),this.aPosLocIs=t.getAttribLocation(this.innerShadowMaskCompositeProgram,"aPos"),this.aPosLocPr=t.getAttribLocation(this.plainRectProgram,"aPos"),this.aPosLocPb=t.getAttribLocation(this.progressiveBlurProgram,"aPos"),this.aPosLocCp=t.getAttribLocation(this.copyProgram,"aPos"),this.aPosLocSf=t.getAttribLocation(this.solidFillProgram,"aPos"),this.aPosLocCc=t.getAttribLocation(this.colorControlsProgram,"aPos"),this.aPosLocSt=t.getAttribLocation(this.sceneTintProgram,"aPos"),this.aPosLocEf=t.getAttribLocation(this.elFboCompositeProgram,"aPos"),this.aPosLocEc=t.getAttribLocation(this.elFboCropProgram,"aPos"),this.fgCanvas=typeof document<"u"?document.createElement("canvas"):null;let s=this.fgCanvas?.getContext("2d",{alpha:!0});if(!s)throw new Error("2D canvas not supported");this.fgCtx=s,this.dummyTex=t.createTexture(),t.bindTexture(t.TEXTURE_2D,this.dummyTex),t.texImage2D(t.TEXTURE_2D,0,t.RGBA,1,1,0,t.RGBA,t.UNSIGNED_BYTE,new Uint8Array([0,0,0,0])),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MAG_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_S,t.CLAMP_TO_EDGE),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_T,t.CLAMP_TO_EDGE),this.cacheUniforms(),this.perfMonitor.attachGl(t),this.detectSoftwareRenderer(),this.perfMonitor.isSoftwareRenderer=this.isSoftwareRenderer}get _debugLastUploadedSdfTex(){let r=Array.from(this._debugUploadedSdfTexMap.values());return r.length?r[r.length-1].tex:null}get _debugLastUploadedSdfKey(){let r=Array.from(this._debugUploadedSdfTexMap.keys());return r.length?r[r.length-1]:""}get _debugLastUploadedSdfTexSize(){let r=Array.from(this._debugUploadedSdfTexMap.values());return r.length?r[r.length-1].texSize:0}clearCapsuleSdfPool(){let r=this.gl;for(let{tex:t}of this.continuousSdfPool.values())r.deleteTexture(t);this.continuousSdfPool.clear(),this.continuousSdfTexture=null,this.continuousSdfKey=null,this._lastCapsuleGenMs=0,this._lastCapsuleUploadMs=0,this._lastCapsuleKey="",this._debugUploadedSdfTexMap.clear()}clearStrokeMaskCache(){let r=this.gl,t=this.strokeMaskCache.size;for(let s of this.strokeMaskCache.values())r.deleteTexture(s.tex);return this.strokeMaskCache.clear(),t}detectSoftwareRenderer(){let r=this.gl;try{let t=r.getExtension("WEBGL_debug_renderer_info"),a=String(t?r.getParameter(t.UNMASKED_RENDERER_WEBGL)||"":r.getParameter(r.RENDERER)||"").toLowerCase();this.isSoftwareRenderer=a.includes("swiftshader")||a.includes("llvmpipe")||a.includes("softpipe")||a.includes("swrast")||a.includes("software")||a.includes("basic render")||a.includes("mesa software")||a.includes("apple software")}catch{}}anyDebugOverlayOn(){return this.showPefBbox||this.showBlurDebug||this.showShadowBbox||this.showCullDebug||this.showPlainRectDebug||this.showPefPassDebug||this.showDirtyMarkers}};d(me,"TAB_PRESSED_SCALE",78/56);Object.assign(me.prototype,rr,ur,cr,dr,hr,mr,gr,pr,Cr,Er,Rr,yr,wr,Ar,vr,Br,Ur,Wr,Nr,Xr,Yr,Vr);var ce=1.4142135623730951,bs=.7853981633974483,fe=.7071067811865476,Gt=2/3,Ss=.5,Wt=(1-Ss)*bs,ie=Math.cos(Wt),te=Math.sin(Wt),Ce=1/Math.tan(Wt),we=ie*ie,Ae=te*te,xs=we*ie,Se=Ae*te,_t=27*(ce-6*ie+6*ce*we-4*xs)*Ce+te*(-9+2*(ce-2*te)*Se+2*ce*ie*(9+Ae)-2*we*(9+2*Ae)),Ot=-81*(-2+ce+4*(-1+ce)*ie+2*(-2+ce)*we)*Ce-4*te*(-9+9*ce+ce*Se+(-2+ce)*ie*(9+Ae)),Dt=9*(9*(-4+3*ce+(-6+4*ce)*ie)*Ce+(-6+4*ce)*te),It=27*(10-7*ce)*Ce;function Ht(e,r,t,s){let a=(3*t/e-r*r/(e*e))/3,i=(2*r*r*r/(e*e*e)-9*r*t/(e*e)+27*s/e)/27,o=i*i/4+a*a*a/27,u=Math.sqrt(o);return Math.cbrt(-i/2+u)+Math.cbrt(-i/2-u)-r/(3*e)}function Ts(e,r,t){let s=-e/2,a=-t,i=t*e/2-r*r/8,o=(3*a-s*s)/3,u=(2*s*s*s-9*s*a+27*i)/27,l=Math.sqrt(-o*o*o/27),f=Math.acos(-u/(2*l)),n=2*Math.sqrt(-o/3)*Math.cos(f/3)-s/3,h=Math.sqrt(2*n-e);return(h-Math.sqrt(h*h-4*(n+r/(2*h))))/2}function zt(e){let r=Gt*e,t=Ht(It,Dt,Ot+8*-r*Se*te,_t),s=fe+(-fe+te)/t,a=1-fe+(fe-ie)/t,i=s-a*Ce,o=i-1.5*t*a*a/Se,u=-r,l=1-a,f=1-s,c=1-i,n=1-o,h=1-u,m=1.5*t,x=we-Ae,p=l-s,g=f-a,C=-(ie*g-te*p),S=(-x+Math.sqrt(x*x-4*m*C))/(2*m),T=s+S*ie,b=a+S*te,v=l-S*te,E=f-S*ie;return[u,0,o,0,i,0,s,a,T,b,v,E,l,f,1,c,1,n,1,h]}function Ut(e,r){let t=Gt*e,s=Gt*r,a=Ht(It,Dt,Ot+8*-t*Se*te,_t),i=Ht(It,Dt,Ot+8*-s*Se*te,_t),o=fe+(-fe+te)/a,u=1-fe+(fe-ie)/a,l=o-u*Ce,f=l-1.5*a*u*u/Se,c=-t,n=fe+(-fe+te)/i,h=1-fe+(fe-ie)/i,m=n-h*Ce,x=m-1.5*i*h*h/Se,p=-s,g=1-h,C=1-n,S=1-m,T=1-x,b=1-p,v=1.5*a,E=1.5*i,A=we-Ae,B=g-o,R=C-u,y=-(ie*R-te*B),M=te*R-ie*B,w=2*(M/E),I=A*A*A/(v*E*E),k=(v*M*M+y*A*A)/(v*E*E),H=Ts(w,I,k),L=(-M-E*H*H)/A,P=o+L*ie,X=u+L*te,$=g-H*te,V=C-H*ie;return[c,0,f,0,l,0,o,u,P,X,$,V,g,C,1,S,1,T,1,b]}function Kr(e,r){return e===r?zt(e):Ut(e,r)}var vs=[[zt(0),Ut(0,1)],[Ut(1,0),zt(1)]];function Cs(e=1,r=1){let t;if(e===0)t=0;else if(e===1)t=1;else return Kr(e,r);let s;if(r===0)s=0;else if(r===1)s=1;else return Kr(e,r);return vs[t][s]}function Mo(e,r){let t=Math.min(e,r)/2,s=$r((e*.5-t)/t,0,1),a=$r((r*.5-t)/t,0,1);return Cs(s,a)}function $r(e,r,t){return e<r?r:e>t?t:e}var Oe=class{constructor(r={}){d(this,"renderer",null);d(this,"canvas",null);d(this,"trackedElements",new Map);d(this,"elementIdCounter",0);d(this,"elToId",new WeakMap);d(this,"isRunning",!1);d(this,"rafId",null);d(this,"pointerX",0);d(this,"pointerY",0);d(this,"isDark",!0);d(this,"resizeObserver",null);d(this,"mutationObserver",null);d(this,"lastUpdate",0);d(this,"activePressedId",null);d(this,"options");this.options={canvasId:"zephyr-liquid-canvas",enableDynamicHighlight:!0,enableSprings:!0,...r}}init(){if(typeof window>"u"||typeof document>"u")return!1;let r=document.getElementById(this.options.canvasId||"zephyr-liquid-canvas");r||(r=document.createElement("canvas"),r.id=this.options.canvasId||"zephyr-liquid-canvas",r.className="zephyr-liquid-canvas",r.setAttribute("aria-hidden","true"),r.style.position="fixed",r.style.top="0",r.style.left="0",r.style.width="100vw",r.style.height="100vh",r.style.zIndex="0",r.style.pointerEvents="none",r.style.display="block",document.body.prepend(r)),this.canvas=r;try{this.renderer=new me(r)}catch(t){return console.warn("[Zephyr Liquid Glass] WebGL renderer could not initialize:",t),!1}return this.renderer?(this.renderer.useContinuousSdf=!0,this.renderer.cornerStyle=1,this.renderer.directBackdropSample=!1,this.detectTheme(),this.resize(),this.applyThemeBackground(),this.scanAndTrack(),this.attachEvents(),this.start(),console.info("[Zephyr Liquid Glass] Running WebGL G2 Continuous Curvature Liquid Glass Engine"),!0):!1}detectTheme(){let t=document.documentElement.getAttribute("data-theme");t?this.isDark=t==="dark":this.isDark=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches}applyThemeBackground(){if(!this.renderer)return;let r=[.055,.063,.082],t=[.957,.96,.968];this.renderer.setBackgroundColor(this.isDark?r:t),this.renderer.wallpaperReady=!0,this.renderer.markAllDirty(),this.renderer.needsRedraw=!0}updateTheme(){this.detectTheme(),this.applyThemeBackground(),this.refreshElements()}registerElement(r,t="default",s){let a=this.elToId.get(r);return a||(a=`lg-el-${++this.elementIdCounter}`,this.elToId.set(r,a)),this.trackedElements.set(a,{id:a,el:r,type:t,customRadius:s}),this.resizeObserver&&this.resizeObserver.observe(r),this.requestRedraw(),a}unregisterElement(r){let t=this.elToId.get(r);t&&(this.trackedElements.delete(t),this.elToId.delete(r),this.resizeObserver&&this.resizeObserver.unobserve(r),this.requestRedraw())}scanAndTrack(r=document){let t=[".main-nav",".nav-tab",".nav-actions .btn-sm",".btn-primary",".add-btn",".btn.danger",".btn",".tool-btn",".login-card",".auth-card",".connection-card",".protocol-badge",".modal-content",".terminal-smartbar",".smartbar-tab",".activity-range-tabs",".activity-range-btn",".activity-item",".activity-card",".search-input",".action-bar select",".settings-menu",".settings-tab",".settings-content",".settings-section-card",".ai-chat-container",".ai-floating-btn",".floating-panel",".toast","[data-liquid-glass]"];r.querySelectorAll(t.join(", ")).forEach(a=>{let i="default";a.classList.contains("main-nav")||a.classList.contains("terminal-smartbar")?i="nav":a.classList.contains("btn-primary")||a.classList.contains("add-btn")?i="btn-primary":a.classList.contains("danger")?i="btn-danger":a.classList.contains("btn")||a.tagName==="BUTTON"||a.classList.contains("tool-btn")?i="button":a.classList.contains("connection-card")||a.classList.contains("login-card")||a.classList.contains("auth-card")||a.classList.contains("settings-section-card")||a.classList.contains("settings-content")?i="card":a.classList.contains("modal-content")?i="modal":a.classList.contains("nav-tab")||a.classList.contains("smartbar-tab")||a.classList.contains("settings-tab")?i="tab":a.classList.contains("protocol-badge")||a.classList.contains("activity-range-btn")||a.classList.contains("activity-range-tabs")?i="pill":(a.classList.contains("search-input")||a.tagName==="INPUT"||a.tagName==="SELECT")&&(i="input"),this.registerElement(a,i)})}attachEvents(){window.addEventListener("resize",()=>this.resize(),{passive:!0}),window.addEventListener("scroll",()=>{this.refreshElements(),this.requestRedraw()},{passive:!0,capture:!0}),window.addEventListener("pointermove",r=>{this.pointerX=r.clientX,this.pointerY=r.clientY,this.renderer&&(this.renderer.needsRedraw=!0)},{passive:!0}),window.addEventListener("pointerdown",r=>{let t=r.target?.closest?.("button, .btn, .nav-tab, .smartbar-tab, .connection-card, .login-card, [data-liquid-glass]");if(t&&this.renderer){let s=this.elToId.get(t);if(s){this.activePressedId=s;let a=t.getBoundingClientRect();this.renderer.setPressed(s,!0,{x:r.clientX-a.left,y:r.clientY-a.top}),this.renderer.needsRedraw=!0}}},{passive:!0}),window.addEventListener("pointerup",()=>{this.activePressedId&&this.renderer&&(this.renderer.setPressed(this.activePressedId,!1),this.activePressedId=null,this.renderer.needsRedraw=!0)},{passive:!0}),window.addEventListener("pointercancel",()=>{this.activePressedId&&this.renderer&&(this.renderer.setPressed(this.activePressedId,!1),this.activePressedId=null,this.renderer.needsRedraw=!0)},{passive:!0}),typeof ResizeObserver<"u"&&(this.resizeObserver=new ResizeObserver(()=>{this.requestRedraw()})),typeof MutationObserver<"u"&&(this.mutationObserver=new MutationObserver(r=>{let t=!1,s=!1;for(let a of r)a.type==="attributes"&&a.attributeName==="data-theme"?t=!0:a.type==="childList"&&(s=!0);t&&this.updateTheme(),s&&(this.scanAndTrack(),this.requestRedraw())}),this.mutationObserver.observe(document.documentElement,{attributes:!0,attributeFilter:["data-theme"]}),this.mutationObserver.observe(document.body,{childList:!0,subtree:!0}))}resize(){if(!this.canvas||!this.renderer)return;let r=window.innerWidth,t=window.innerHeight,s=Math.min(window.devicePixelRatio||1,2);this.canvas.width=Math.round(r*s),this.canvas.height=Math.round(t*s),this.canvas.style.width=r+"px",this.canvas.style.height=t+"px",this.renderer.resize(r,t),this.refreshElements(),this.renderer.markAllDirty(),this.renderer.needsRedraw=!0}computeCornerRadius(r,t,s){if(typeof s=="number")return s;let a=window.getComputedStyle(r),i=parseFloat(a.borderRadius);return!isNaN(i)&&i>0?a.borderRadius.includes("50%")||a.borderRadius.includes("9999px")||i>=Math.min(t.width,t.height)/2?Math.min(t.width,t.height)/2:i:16}refreshElements(){if(!this.renderer)return;let r=[],t=window.innerWidth,s=window.innerHeight,a={nav:10,card:20,panel:25,pill:30,tab:35,input:40,button:50,"btn-primary":60,"btn-danger":60,modal:100,default:20};Array.from(this.trackedElements.values()).sort((o,u)=>(a[o.type]||20)-(a[u.type]||20)).forEach(o=>{let{el:u,id:l,type:f,customRadius:c}=o;if(!u.isConnected||u.offsetParent===null)return;let n=u.getBoundingClientRect();if(n.bottom<-80||n.top>s+80||n.right<-80||n.left>t+80||n.width<=2||n.height<=2)return;let h=this.computeCornerRadius(u,n,c),m=n.left+n.width/2,x=n.top+n.height/2,p=this.options.enableDynamicHighlight?Math.atan2(this.pointerY-x,this.pointerX-m):Math.PI/4,g=this.isDark,C=14,S=-24,T=14,b=g?1.45:1.25,v=1.05,E=.02,A=g?.12:.45,B=[0,0,0,0],R=g?[1,1,1,A]:[1,1,1,A],y=24,M=g?.35:.12,w=6,I=g?.65:.85,k=.75;switch(f){case"nav":C=14,S=-24,T=20,A=g?.08:.4,R=g?[1,1,1,A]:[1,1,1,A],y=28,w=8;break;case"card":C=14,S=-24,T=16,A=g?.09:.42,R=g?[1,1,1,A]:[1,1,1,A],y=24,w=6;break;case"modal":C=18,S=-30,T=28,A=g?.22:.6,R=g?[.15,.2,.3,A]:[1,1,1,A],y=48,M=g?.6:.25,w=16,I=.95;break;case"btn-primary":C=12,S=-24,T=10,B=[.04,.52,.98,.85],R=[.2,.65,1,.3],y=16,M=.4,w=4,I=.9;break;case"btn-danger":C=12,S=-24,T=10,B=[.95,.22,.22,.85],R=[1,.35,.35,.3],y=16,M=.4,w=4,I=.9;break;case"button":case"tab":C=10,S=-18,T=8,A=g?.16:.45,R=g?[1,1,1,A]:[1,1,1,A],y=12,w=3;break;case"input":C=8,S=-14,T=8,A=g?.06:.25,R=g?[1,1,1,A]:[1,1,1,A],y=8,w=2;break;case"pill":C=8,S=-14,T=8,A=g?.14:.4,R=g?[1,1,1,A]:[1,1,1,A],y=8,w=2;break}let H={mode:0,color:[1,1,1],angle:p,falloff:1.2,alpha:I,widthDp:k,blurRadiusDp:.5};r.push({id:l,kind:f==="button"||f==="btn-primary"||f==="btn-danger"?"button":"glass-shape",rect:{x:n.left,y:n.top,w:n.width,h:n.height},cornerRadius:h,refractionHeight:C,refractionAmount:S,depthEffect:!0,chromaticAberration:!0,blurRadius:T,saturation:b,brightness:E,contrast:v,tintColor:B,surfaceColor:R,highlight:H,outerShadow:{radius:y,alpha:M,offsetX:0,offsetY:w,color:[0,0,0]},label:"",labelColor:[1,1,1,1],showChevron:!1,isInteractive:f==="button"||f==="btn-primary"||f==="btn-danger"||f==="tab",useContinuousSdf:!0})}),this.renderer.setElements(r)}requestRedraw(){this.renderer&&(this.renderer.needsRedraw=!0)}start(){if(this.isRunning)return;this.isRunning=!0;let r=t=>{this.isRunning&&(t-this.lastUpdate>30&&(this.lastUpdate=t,this.refreshElements()),this.renderer&&this.renderer.render(),this.rafId=requestAnimationFrame(r))};this.rafId=requestAnimationFrame(r)}stop(){this.isRunning=!1,this.rafId!==null&&(cancelAnimationFrame(this.rafId),this.rafId=null),this.resizeObserver&&(this.resizeObserver.disconnect(),this.resizeObserver=null),this.mutationObserver&&(this.mutationObserver.disconnect(),this.mutationObserver=null)}};function $e(e){if(typeof window>"u")return null;let r=window.__zephyrLiquidGlass;if(r)return r;let t=new Oe(e);return t.init()?(window.__zephyrLiquidGlass=t,t):null}typeof window<"u"&&(window.ZephyrLiquidGlass=Oe,window.initZephyrLiquidGlass=$e,document.readyState==="loading"?document.addEventListener("DOMContentLoaded",()=>{$e()}):$e());export{vt as ContinuousCurvatureRoundedRectangleCornerBuilder,ue as DP,fe as FRAC_1_SQRT_2,bs as FRAC_PI_4,me as LiquidGlassRenderer,Sa as SPRING_DAMPING_RATIO,ba as SPRING_K,ye as SPRING_OMEGA_D,Le as SPRING_OMEGA_N,J as SPRING_THRESHOLD,ce as SQRT_2,We as TOGGLE_SCALE_X_DAMPING_RATIO,ds as TOGGLE_SCALE_X_K,xa as TOGGLE_SCALE_X_OMEGA_D,yt as TOGGLE_SCALE_X_OMEGA_N,Ne as TOGGLE_SCALE_Y_DAMPING_RATIO,hs as TOGGLE_SCALE_Y_K,Ta as TOGGLE_SCALE_Y_OMEGA_D,wt as TOGGLE_SCALE_Y_OMEGA_N,cs as TOGGLE_VALUE_K,Rt as TOGGLE_VALUE_OMEGA_N,Xe as TOGGLE_VELOCITY_DAMPING_RATIO,fs as TOGGLE_VELOCITY_K,va as TOGGLE_VELOCITY_OMEGA_D,At as TOGGLE_VELOCITY_OMEGA_N,Ue as VelocityTracker1D,Oe as ZephyrLiquidGlass,Mo as continuousCapsuleCornerPoints,Ee as continuousCurvatureRoundedRectPath,Cs as getContinuousCornerBezierPoints,$e as initZephyrLiquidGlass,Pe as springStep1D,qe as springStepCritical,Ye as springStepUnderdamped};
