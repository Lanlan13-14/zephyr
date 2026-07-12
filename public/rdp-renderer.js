export const RDP_RENDER_EVENT = Object.freeze({
    RESET_GRAPHICS: 1,
    BEGIN_FRAME: 2,
    END_FRAME: 3,
    CREATE_SURFACE: 4,
    DELETE_SURFACE: 5,
    MAP_SURFACE: 6,
    MAP_SURFACE_SCALED: 7,
    BITMAP: 8,
    AVC420: 9,
    AVC444: 10,
    SURFACE_COPY: 11,
    SURFACE_TO_CACHE: 12,
    SOLID_FILL: 13,
    CACHE_TO_SURFACE: 14,
    CACHE_EVICT: 15,
    CLASSIC_BITMAP: 16,
});

const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
out vec2 v_texCoord;
void main() { v_texCoord = a_texCoord; gl_Position = vec4(a_position, 0.0, 1.0); }`;
const FRAGMENT_RGBA = `#version 300 es
precision mediump float;
in vec2 v_texCoord;
uniform sampler2D u_texture;
out vec4 outColor;
void main() { outColor = texture(u_texture, v_texCoord); }`;
const FRAGMENT_BGRA = `#version 300 es
precision mediump float;
in vec2 v_texCoord;
uniform sampler2D u_texture;
out vec4 outColor;
void main() { vec4 c = texture(u_texture, v_texCoord); outColor = vec4(c.b, c.g, c.r, 1.0); }`;

function compileProgram(gl, fragmentSource) {
    const compile = (type, source) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'shader compile failed');
        return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'program link failed');
    return program;
}

function clampRect(rect, width, height) {
    const left = Math.max(0, Math.min(width, Number(rect?.left) || 0));
    const top = Math.max(0, Math.min(height, Number(rect?.top) || 0));
    const right = Math.max(left, Math.min(width, Number(rect?.right) || 0));
    const bottom = Math.max(top, Math.min(height, Number(rect?.bottom) || 0));
    return { left, top, right, bottom, width: right - left, height: bottom - top };
}

export class RdpGpuSurfaceCompositor {
    constructor(canvas, { requestFrame = (callback) => requestAnimationFrame(callback), cancelFrame = (id) => cancelAnimationFrame(id), diagnostics = null, onFramesPresented = null, onContextRestoreNeeded = null } = {}) {
        this.onFramesPresented = onFramesPresented;
        this.onContextRestoreNeeded = onContextRestoreNeeded;
        this.canvas = canvas;
        this.requestFrame = requestFrame;
        this.cancelFrame = cancelFrame;
        this.diagnostics = diagnostics;
        this.surfaces = new Map();
        this.cacheEntries = new Map();
        this.width = canvas.width || 1;
        this.height = canvas.height || 1;
        this.raf = null;
        this.dirty = false;
        this.sealedFrames = new Set();
        this.framePending = new Map();
        this.presentedFrames = [];
        this.contextLost = false;
        this.gl = canvas.getContext('webgl2', {
            alpha: false,
            antialias: false,
            depth: false,
            stencil: false,
            desynchronized: true,
            preserveDrawingBuffer: false,
        });
        if (!this.gl) throw new Error('WebGL2 is unavailable');
        this._initGl();
        this._onContextLost = (event) => { event.preventDefault?.(); this.contextLost = true; this._cancelPresent(); };
        this._onContextRestored = () => {
            // GPU contents are undefined after context restore. Do not claim
            // the old surfaces were rebuilt: require the caller to request a
            // full server refresh/reset before presenting again.
            this.contextLost = false;
            this._initGl();
            for (const id of [...this.surfaces.keys()]) this.deleteSurface(id);
            // All resources from the lost context are invalid, including cache
            // textures/FBOs. Drop frame bookkeeping that can no longer finish.
            this.cacheEntries.clear();
            this.sealedFrames.clear();
            this.framePending.clear();
            this.activeFrame = null;
            this.presentedFrames.length = 0;
            this.dirty = false;
            this.onContextRestoreNeeded?.();
        };
        canvas.addEventListener?.('webglcontextlost', this._onContextLost);
        canvas.addEventListener?.('webglcontextrestored', this._onContextRestored);
    }

    _initGl() {
        const gl = this.gl;
        this.rgbaProgram = compileProgram(gl, FRAGMENT_RGBA);
        this.bgraProgram = compileProgram(gl, FRAGMENT_BGRA);
        this.vertexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1, -1, 0, 1, 1, -1, 1, 1, -1, 1, 0, 0, 1, 1, 1, 0,
        ]), gl.STATIC_DRAW);
        this.stagingTexture = this._newTexture(1, 1);
        this.stagingWidth = 1;
        this.stagingHeight = 1;
        gl.disable(gl.BLEND);
        gl.disable(gl.DEPTH_TEST);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    }

    _newTexture(width, height) {
        const gl = this.gl;
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        return texture;
    }

    _newSurface(id, width, height, pixelFormat = 0) {
        const gl = this.gl;
        const surface = { id, width, height, pixelFormat, texture: this._newTexture(width, height), framebuffer: gl.createFramebuffer(), mapped: false, outputX: 0, outputY: 0, outputWidth: width, outputHeight: height, shadow: null };
        gl.bindFramebuffer(gl.FRAMEBUFFER, surface.framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, surface.texture, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`surface ${id} framebuffer incomplete`);
        this.surfaces.set(id, surface);
        return surface;
    }

    ensureDesktopSurface(width = this.width, height = this.height) {
        const id = 0;
        let surface = this.surfaces.get(id);
        if (!surface || surface.width !== width || surface.height !== height) {
            if (surface) this.deleteSurface(id);
            surface = this.createSurface(id, width, height, 0);
            this.mapSurface(id, 0, 0, width, height);
        }
        return surface;
    }

    uploadClassicBitmap(rect, bytes, stride = 0) {
        const right = Math.max(this.width, Number(rect.right) || 0);
        const bottom = Math.max(this.height, Number(rect.bottom) || 0);
        this.ensureDesktopSurface(right, bottom);
        this.uploadBitmap(0, rect, bytes, stride);
        this.schedulePresent();
    }

    createSurface(id, width, height, pixelFormat = 0) {
        this.deleteSurface(id);
        return this._newSurface(Number(id), Number(width), Number(height), pixelFormat);
    }

    deleteSurface(id) {
        const surface = this.surfaces.get(Number(id));
        if (!surface) return;
        this.gl.deleteFramebuffer(surface.framebuffer);
        this.gl.deleteTexture(surface.texture);
        this.surfaces.delete(Number(id));
        this.dirty = true;
    }

    cacheSurface(sourceId, slot, rect) {
        const source = this._requireSurface(sourceId);
        const clipped = clampRect(rect, source.width, source.height);
        if (!clipped.width || !clipped.height) return;
        this.evictCache(slot);
        const gl = this.gl;
        const entry = { slot: Number(slot), width: clipped.width, height: clipped.height, texture: this._newTexture(clipped.width, clipped.height), framebuffer: gl.createFramebuffer() };
        gl.bindFramebuffer(gl.FRAMEBUFFER, entry.framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, entry.texture, 0);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, source.framebuffer);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, entry.framebuffer);
        gl.blitFramebuffer(clipped.left, source.height - clipped.bottom, clipped.right, source.height - clipped.top, 0, 0, clipped.width, clipped.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        this.cacheEntries.set(entry.slot, entry);
    }

    drawCache(slot, surfaceId, outputX, outputY) {
        const entry = this.cacheEntries.get(Number(slot));
        if (!entry) throw new Error(`unknown RDP cache slot ${slot}`);
        const target = this._requireSurface(surfaceId);
        const left = Number(outputX) || 0;
        const top = Number(outputY) || 0;
        this._drawTexture(entry.texture, target.framebuffer, target.width, target.height, { left, top, right: left + entry.width, bottom: top + entry.height, width: entry.width, height: entry.height }, this.rgbaProgram);
        this.dirty = true;
    }

    evictCache(slot) {
        const entry = this.cacheEntries.get(Number(slot));
        if (!entry) return;
        this.gl.deleteFramebuffer(entry.framebuffer);
        this.gl.deleteTexture(entry.texture);
        this.cacheEntries.delete(Number(slot));
    }

    mapSurface(id, outputX, outputY, outputWidth, outputHeight) {
        const surface = this._requireSurface(id);
        surface.mapped = true;
        surface.outputX = Number(outputX) || 0;
        surface.outputY = Number(outputY) || 0;
        surface.outputWidth = Number(outputWidth) || surface.width;
        surface.outputHeight = Number(outputHeight) || surface.height;
        this.dirty = true;
    }

    uploadBitmap(id, rect, bytes, stride = 0, bgra = true) {
        const surface = this._requireSurface(id);
        const clipped = clampRect(rect, surface.width, surface.height);
        if (!clipped.width || !clipped.height) return;
        const expectedStride = clipped.width * 4;
        const sourceStride = Number(stride) || expectedStride;
        let pixels = bytes;
        if (sourceStride !== expectedStride) {
            pixels = new Uint8Array(expectedStride * clipped.height);
            for (let row = 0; row < clipped.height; row++) pixels.set(bytes.subarray(row * sourceStride, row * sourceStride + expectedStride), row * expectedStride);
        }
        this._ensureStaging(clipped.width, clipped.height);
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.stagingTexture);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, clipped.width, clipped.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        this._drawTexture(this.stagingTexture, surface.framebuffer, surface.width, surface.height, clipped, bgra ? this.bgraProgram : this.rgbaProgram);
        this.dirty = true;
    }

    uploadVideoFrame(id, rect, frame) {
        const surface = this._requireSurface(id);
        const clipped = clampRect(rect, surface.width, surface.height);
        if (!clipped.width || !clipped.height) return;
        const sourceWidth = Number(frame.displayWidth || frame.codedWidth || clipped.width);
        const sourceHeight = Number(frame.displayHeight || frame.codedHeight || clipped.height);
        this._ensureStaging(sourceWidth, sourceHeight);
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.stagingTexture);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, frame);
        this._drawTexture(this.stagingTexture, surface.framebuffer, surface.width, surface.height, clipped, this.rgbaProgram, { sourceWidth, sourceHeight });
        this.dirty = true;
    }

    solidFill(id, rect, colorBGRA) {
        const surface = this._requireSurface(id);
        const clipped = clampRect(rect, surface.width, surface.height);
        if (!clipped.width || !clipped.height) return;
        const gl = this.gl;
        const b = colorBGRA & 255, g = (colorBGRA >>> 8) & 255, r = (colorBGRA >>> 16) & 255, a = (colorBGRA >>> 24) & 255;
        gl.bindFramebuffer(gl.FRAMEBUFFER, surface.framebuffer);
        gl.viewport(0, 0, surface.width, surface.height);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(clipped.left, surface.height - clipped.bottom, clipped.width, clipped.height);
        gl.clearColor(r / 255, g / 255, b / 255, a / 255);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.disable(gl.SCISSOR_TEST);
        this.dirty = true;
    }

    copySurface(srcId, dstId, srcRect, dstX, dstY) {
        const gl = this.gl, src = this._requireSurface(srcId), dst = this._requireSurface(dstId);
        const rect = clampRect(srcRect, src.width, src.height);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src.framebuffer);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.framebuffer);
        gl.blitFramebuffer(rect.left, src.height - rect.bottom, rect.right, src.height - rect.top, Number(dstX), dst.height - Number(dstY) - rect.height, Number(dstX) + rect.width, dst.height - Number(dstY), gl.COLOR_BUFFER_BIT, gl.NEAREST);
        this.dirty = true;
    }

    reset(width, height) {
        for (const id of [...this.surfaces.keys()]) this.deleteSurface(id);
        for (const slot of [...this.cacheEntries.keys()]) this.evictCache(slot);
        this.width = Number(width) || 1;
        this.height = Number(height) || 1;
        this.canvas.width = this.width;
        this.canvas.height = this.height;
        this.sealedFrames.clear();
        this.framePending.clear();
        this.activeFrame = null;
        this.presentedFrames.length = 0;
        this.dirty = true;
    }

    beginFrame(frameId) { this.activeFrame = Number(frameId); }
    addFramePending(frameId) { const id = Number(frameId); this.framePending.set(id, (this.framePending.get(id) || 0) + 1); }
    completeFramePending(frameId) { const id = Number(frameId); const left = Math.max(0, (this.framePending.get(id) || 0) - 1); if (left) this.framePending.set(id, left); else this.framePending.delete(id); this.schedulePresent(); }
    endFrame(frameId) { this.sealedFrames.add(Number(frameId)); this.activeFrame = null; this.schedulePresent(); }

    schedulePresent() {
        if (this.raf !== null || this.contextLost) return;
        this.raf = this.requestFrame(() => { this.raf = null; this.present(); });
    }

    present() {
        if (this.contextLost) return false;
        if (!this.dirty && !this.sealedFrames.size) return false;
        const orderedSealed = [...this.sealedFrames].sort((a, b) => a - b);
        if (orderedSealed.length && this.framePending.has(orderedSealed[0])) return false;
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.width, this.height);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        for (const surface of this.surfaces.values()) {
            if (!surface.mapped) continue;
            const rect = { left: surface.outputX, top: surface.outputY, right: surface.outputX + surface.outputWidth, bottom: surface.outputY + surface.outputHeight, width: surface.outputWidth, height: surface.outputHeight };
            this._drawTexture(surface.texture, null, this.width, this.height, rect, this.rgbaProgram);
        }
        const frames = [];
        for (const id of orderedSealed) {
            if (this.framePending.has(id)) break;
            frames.push(id);
        }
        this.presentedFrames.push(...frames);
        for (const id of frames) this.sealedFrames.delete(id);
        this.dirty = false;
        if (frames.length && this.onFramesPresented) this.onFramesPresented(frames);
        if (this.diagnostics) this.diagnostics.presents = (this.diagnostics.presents || 0) + 1;
        return true;
    }

    handleEvent(event) {
        const normalized = {
            ...event,
            kind: event.kind ?? event.Kind,
            frameId: event.frameId ?? event.FrameID,
            surfaceId: event.surfaceId ?? event.SurfaceID,
            surfaceId2: event.surfaceId2 ?? event.SurfaceID2,
            pixelFormat: event.pixelFormat ?? event.PixelFormat,
            outputX: event.outputX ?? event.OutputX,
            outputY: event.outputY ?? event.OutputY,
            width: event.width ?? event.Width,
            height: event.height ?? event.Height,
            rect: event.rect ?? event.Rect,
            data: event.data ?? event.Data,
            stride: event.stride ?? event.Stride,
            colorBGRA: event.colorBGRA ?? event.ColorBGRA,
        };
        event = normalized;
        switch (Number(event.kind)) {
        case RDP_RENDER_EVENT.RESET_GRAPHICS: this.reset(event.width, event.height); break;
        case RDP_RENDER_EVENT.BEGIN_FRAME: this.beginFrame(event.frameId); break;
        case RDP_RENDER_EVENT.END_FRAME: this.endFrame(event.frameId); break;
        case RDP_RENDER_EVENT.CREATE_SURFACE: this.createSurface(event.surfaceId, event.width, event.height, event.pixelFormat); break;
        case RDP_RENDER_EVENT.DELETE_SURFACE: this.deleteSurface(event.surfaceId); break;
        case RDP_RENDER_EVENT.MAP_SURFACE: this.mapSurface(event.surfaceId, event.outputX, event.outputY, event.width, event.height); break;
        case RDP_RENDER_EVENT.MAP_SURFACE_SCALED: this.mapSurface(event.surfaceId, event.outputX, event.outputY, event.width, event.height); break;
        case RDP_RENDER_EVENT.BITMAP: this.uploadBitmap(event.surfaceId, event.rect, event.data, event.stride); break;
        case RDP_RENDER_EVENT.CLASSIC_BITMAP: this.uploadClassicBitmap(event.rect, event.data, event.stride); break;
        case RDP_RENDER_EVENT.SURFACE_TO_CACHE: this.cacheSurface(event.surfaceId, event.surfaceId2, event.rect); break;
        case RDP_RENDER_EVENT.CACHE_TO_SURFACE: this.drawCache(event.surfaceId2, event.surfaceId, event.outputX, event.outputY); break;
        case RDP_RENDER_EVENT.CACHE_EVICT: this.evictCache(event.surfaceId); break;
        case RDP_RENDER_EVENT.SOLID_FILL: this.solidFill(event.surfaceId, event.rect, event.colorBGRA); break;
        case RDP_RENDER_EVENT.SURFACE_COPY: this.copySurface(event.surfaceId2, event.surfaceId, event.rect, event.outputX, event.outputY); break;
        }
        if (!Number(event.frameId) && ![RDP_RENDER_EVENT.BEGIN_FRAME, RDP_RENDER_EVENT.END_FRAME].includes(Number(event.kind))) this.schedulePresent();
    }

    _ensureStaging(width, height) {
        if (width <= this.stagingWidth && height <= this.stagingHeight) return;
        this.stagingWidth = Math.max(width, this.stagingWidth);
        this.stagingHeight = Math.max(height, this.stagingHeight);
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.stagingTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.stagingWidth, this.stagingHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }

    _drawTexture(texture, framebuffer, targetWidth, targetHeight, rect, program, sourceSize = null) {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.viewport(0, 0, targetWidth, targetHeight);
        gl.useProgram(program);
        const effectiveWidth = sourceSize?.sourceWidth || rect.width;
        const effectiveHeight = sourceSize?.sourceHeight || rect.height;
        const uMax = texture === this.stagingTexture ? effectiveWidth / this.stagingWidth : 1;
        const vMax = texture === this.stagingTexture ? effectiveHeight / this.stagingHeight : 1;
        const left = -1 + (2 * rect.left) / targetWidth;
        const right = -1 + (2 * rect.right) / targetWidth;
        const top = 1 - (2 * rect.top) / targetHeight;
        const bottom = 1 - (2 * rect.bottom) / targetHeight;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            left, bottom, 0, vMax,
            right, bottom, uMax, vMax,
            left, top, 0, 0,
            right, top, uMax, 0,
        ]), gl.DYNAMIC_DRAW);
        const position = gl.getAttribLocation(program, 'a_position');
        const texCoord = gl.getAttribLocation(program, 'a_texCoord');
        gl.enableVertexAttribArray(position);
        gl.enableVertexAttribArray(texCoord);
        gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 16, 0);
        gl.vertexAttribPointer(texCoord, 2, gl.FLOAT, false, 16, 8);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        const sampler = gl.getUniformLocation(program, 'u_texture');
        gl.uniform1i(sampler, 0);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(rect.left, targetHeight - rect.bottom, rect.width, rect.height);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.disable(gl.SCISSOR_TEST);
    }

    _requireSurface(id) {
        const surface = this.surfaces.get(Number(id));
        if (!surface) throw new Error(`unknown RDP surface ${id}`);
        return surface;
    }

    _cancelPresent() { if (this.raf !== null) { this.cancelFrame(this.raf); this.raf = null; } }
    // Context restoration intentionally waits for a full server refresh.

    destroy() {
        this._cancelPresent();
        for (const id of [...this.surfaces.keys()]) this.deleteSurface(id);
        for (const slot of [...this.cacheEntries.keys()]) this.evictCache(slot);
        this.sealedFrames.clear();
        this.framePending.clear();
        this.activeFrame = null;
        this.presentedFrames.length = 0;
        const gl = this.gl;
        if (gl) {
            if (this.rgbaProgram) gl.deleteProgram(this.rgbaProgram);
            if (this.bgraProgram) gl.deleteProgram(this.bgraProgram);
            if (this.vertexBuffer) gl.deleteBuffer(this.vertexBuffer);
            if (this.stagingTexture) gl.deleteTexture(this.stagingTexture);
        }
        this.rgbaProgram = this.bgraProgram = this.vertexBuffer = this.stagingTexture = null;
        this.canvas.removeEventListener?.('webglcontextlost', this._onContextLost);
        this.canvas.removeEventListener?.('webglcontextrestored', this._onContextRestored);
    }
}
