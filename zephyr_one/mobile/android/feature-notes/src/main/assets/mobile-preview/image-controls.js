(function (root) {
    'use strict';
    class ImageTransform {
        constructor() { this.reset(); }
        reset() { this.zoom = 1; this.angle = 0; this.flipX = 1; this.flipY = 1; this.x = 0; this.y = 0; }
        scale(factor) { this.zoom = Math.max(0.05, Math.min(20, this.zoom * factor)); }
        rotate(degrees) { this.angle = (this.angle + degrees) % 360; }
        flip(axis) { if (axis === 'x') this.flipX *= -1; else if (axis === 'y') this.flipY *= -1; }
        pan(dx, dy) { if (Number.isFinite(dx) && Number.isFinite(dy)) { this.x += dx; this.y += dy; } }
        oneToOne(width, height, viewportWidth, viewportHeight) {
            const fit = Math.min(viewportWidth / width, viewportHeight / height, 1);
            if (fit > 0) this.zoom = 1 / fit;
            this.x = 0; this.y = 0;
        }
        css() { return `translate(${this.x}px,${this.y}px) rotate(${this.angle}deg) scale(${this.zoom * this.flipX},${this.zoom * this.flipY})`; }
    }
    if (typeof module !== 'undefined') module.exports = { ImageTransform };
    root.ImageTransform = ImageTransform;
})(typeof window === 'undefined' ? globalThis : window);
