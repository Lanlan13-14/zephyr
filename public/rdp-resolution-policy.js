const TIER_BOUNDS = Object.freeze({
    '1080p': Object.freeze({ longEdge: 1920, shortEdge: 1080 }),
    '2K': Object.freeze({ longEdge: 2560, shortEdge: 1440 }),
    '4K': Object.freeze({ longEdge: 3840, shortEdge: 2160 }),
});

function finitePositive(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function fitAspectInside(aspect, landscapeWidth, landscapeHeight) {
    const portrait = aspect < 1;
    const maxWidth = portrait ? landscapeHeight : landscapeWidth;
    const maxHeight = portrait ? landscapeWidth : landscapeHeight;
    let width = maxWidth;
    let height = width / aspect;
    if (height > maxHeight) {
        height = maxHeight;
        width = height * aspect;
    }
    return { width, height };
}

/**
 * Compute a safe single-monitor RDP desktop size for the current viewport.
 *
 * Resolution labels are upper bounds, not a promise that the short edge will
 * always equal the label. Treating 2K as "short edge = 1440" made a shallow
 * 4.3:1 browser stage request 6176x1440 and caused real RDP servers to reset
 * the TCP session. This policy preserves the viewport aspect while fitting it
 * inside the conventional 1920x1080 / 2560x1440 / 3840x2160 pixel envelope.
 */
export function computeSafeRdpSize({
    resolution = '1080p',
    viewportWidth,
    viewportHeight,
    devicePixelRatio = 1,
    minimumEdge = 200,
} = {}) {
    const cssWidth = finitePositive(viewportWidth, 1920);
    const cssHeight = finitePositive(viewportHeight, 1080);
    const aspect = cssWidth / cssHeight;
    const dpr = Math.max(0.5, Math.min(4, finitePositive(devicePixelRatio, 1)));
    const label = String(resolution || '1080p');
    const legacy = label.match(/^(\d+)x(\d+)$/);

    let size;
    if (label === 'auto') {
        size = { width: cssWidth * dpr, height: cssHeight * dpr };
        const hard = fitAspectInside(aspect, TIER_BOUNDS['4K'].longEdge, TIER_BOUNDS['4K'].shortEdge);
        const scale = Math.min(1, hard.width / size.width, hard.height / size.height);
        size.width *= scale;
        size.height *= scale;
    } else if (legacy) {
        const legacyWidth = finitePositive(legacy[1], 1920);
        const legacyHeight = finitePositive(legacy[2], 1080);
        const longEdge = Math.min(3840, Math.max(legacyWidth, legacyHeight));
        const shortEdge = Math.min(2160, Math.min(legacyWidth, legacyHeight));
        size = fitAspectInside(aspect, longEdge, shortEdge);
    } else {
        // 8K existed briefly in the toolbar but proved unsafe for browser RDP
        // hot-resize paths. Treat stored 8K values as the supported 4K ceiling.
        const normalized = label.toLowerCase() === '8k'
            ? '4K'
            : label.toLowerCase() === '2k'
                ? '2K'
                : label.toLowerCase() === '4k'
                    ? '4K'
                    : '1080p';
        const bounds = TIER_BOUNDS[normalized];
        size = fitAspectInside(aspect, bounds.longEdge, bounds.shortEdge);
    }

    const minEdge = Math.max(200, Math.trunc(Number(minimumEdge) || 200));
    let width = Math.max(minEdge, Math.round(size.width));
    let height = Math.max(minEdge, Math.round(size.height));

    // MS-RDPEDISP requires an even monitor width. Keeping both dimensions even
    // also avoids unnecessary codec padding changes during orientation swaps.
    width = Math.floor(width / 2) * 2;
    height = Math.floor(height / 2) * 2;
    return { width, height };
}

export const RDP_RESOLUTION_TIER_BOUNDS = TIER_BOUNDS;
