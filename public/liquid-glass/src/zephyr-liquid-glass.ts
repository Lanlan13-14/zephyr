// public/liquid-glass/src/zephyr-liquid-glass.ts
// Zephyr WebGL Liquid Glass Integration Runtime
// Connects the high-fidelity WebGL Liquid Glass shader engine to Zephyr DOM UI

import { LiquidGlassRenderer } from './renderer/index'
import type { GlassElementConfig, GlassHighlight } from './renderer/types'
import { ContinuousCurvatureRoundedRectangleCornerBuilder } from './shapes/continuous-corners'

export interface ZephyrLiquidGlassOptions {
  canvasId?: string
  enableDynamicHighlight?: boolean
  enableSprings?: boolean
  dpr?: number
}

interface TrackedElement {
  id: string
  el: HTMLElement
  type: 'nav' | 'card' | 'button' | 'modal' | 'pill' | 'panel' | 'input' | 'tab' | 'default'
  rect?: DOMRect
  customRadius?: number
}

export class ZephyrLiquidGlass {
  public renderer: LiquidGlassRenderer | null = null
  public canvas: HTMLCanvasElement | null = null
  private trackedElements = new Map<string, TrackedElement>()
  private elementIdCounter = 0
  private elToId = new WeakMap<HTMLElement, string>()
  private isRunning = false
  private rafId: number | null = null
  private pointerX = 0
  private pointerY = 0
  private lightAngle = Math.PI / 4 // 45 deg default
  private isDark = true
  private resizeObserver: ResizeObserver | null = null
  private mutationObserver: MutationObserver | null = null
  private bgCanvas: HTMLCanvasElement | null = null
  private lastUpdate = 0
  private activePressedId: string | null = null
  private options: ZephyrLiquidGlassOptions

  constructor(options: ZephyrLiquidGlassOptions = {}) {
    this.options = {
      canvasId: 'zephyr-liquid-canvas',
      enableDynamicHighlight: true,
      enableSprings: true,
      ...options,
    }
  }

  public init(): boolean {
    if (typeof window === 'undefined' || typeof document === 'undefined') return false

    // Check existing canvas or create one
    let canvas = document.getElementById(this.options.canvasId || 'zephyr-liquid-canvas') as HTMLCanvasElement | null
    if (!canvas) {
      canvas = document.createElement('canvas')
      canvas.id = this.options.canvasId || 'zephyr-liquid-canvas'
      canvas.className = 'zephyr-liquid-canvas'
      canvas.setAttribute('aria-hidden', 'true')
      // Position as fixed background layer
      canvas.style.position = 'fixed'
      canvas.style.top = '0'
      canvas.style.left = '0'
      canvas.style.width = '100vw'
      canvas.style.height = '100vh'
      canvas.style.zIndex = '0'
      canvas.style.pointerEvents = 'none'
      canvas.style.opacity = '1'
      canvas.style.display = 'block'
      document.body.prepend(canvas)
    }
    this.canvas = canvas

    try {
      this.renderer = new LiquidGlassRenderer(canvas)
    } catch (err) {
      console.warn('[Zephyr Liquid Glass] WebGL renderer could not initialize:', err)
      return false
    }

    if (!this.renderer) return false

    // Initial theme detection
    this.detectTheme()

    // Setup dimensions
    this.resize()

    // Initialize ambient background texture
    this.initAmbientBackground()

    // Track existing DOM elements
    this.scanAndTrack()

    // Attach event listeners
    this.attachEvents()

    // Start render loop
    this.start()

    console.info('[Zephyr Liquid Glass] Initialized with WebGL G2 Continuous Curvature & Refraction Lens')
    return true
  }

  private detectTheme(): void {
    const root = document.documentElement
    const themeAttr = root.getAttribute('data-theme')
    if (themeAttr) {
      this.isDark = themeAttr === 'dark'
    } else {
      this.isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
    }
  }

  private initAmbientBackground(): void {
    if (!this.renderer) return

    // Create an ambient gradient wallpaper texture to provide caustics and refraction depth
    const w = 512
    const h = 512
    const bgCanvas = document.createElement('canvas')
    bgCanvas.width = w
    bgCanvas.height = h
    const ctx = bgCanvas.getContext('2d')
    if (!ctx) return
    this.bgCanvas = bgCanvas

    this.drawAmbientBackground(ctx, w, h)

    const dataUrl = bgCanvas.toDataURL('image/webp', 0.9)
    this.renderer.loadWallpaper(dataUrl).then(() => {
      if (this.renderer) {
        this.renderer.wallpaperReady = true
        this.renderer.markAllDirty()
        this.renderer.needsRedraw = true
      }
    }).catch(() => {
      // Fallback to solid background color if wallpaper load fails
      if (this.renderer) {
        this.renderer.setBackgroundColor(this.isDark ? [0.07, 0.09, 0.14] : [0.94, 0.96, 0.98])
      }
    })
  }

  private drawAmbientBackground(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    if (this.isDark) {
      // Deep obsidian slate with subtle refractive cyan/indigo/violet caustics
      const grad = ctx.createLinearGradient(0, 0, w, h)
      grad.addColorStop(0, '#090d16')
      grad.addColorStop(0.5, '#0e1526')
      grad.addColorStop(1, '#080c14')
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, w, h)

      // Ambient light blooms for rich glass refraction
      this.drawLightOrb(ctx, w * 0.2, h * 0.2, 220, 'rgba(56, 189, 248, 0.12)') // cyan
      this.drawLightOrb(ctx, w * 0.8, h * 0.3, 260, 'rgba(99, 102, 241, 0.14)') // indigo
      this.drawLightOrb(ctx, w * 0.5, h * 0.8, 240, 'rgba(168, 85, 247, 0.10)') // purple
      this.drawLightOrb(ctx, w * 0.15, h * 0.85, 180, 'rgba(14, 165, 233, 0.08)') // sky
    } else {
      // Crisp luminous daylight glass with subtle pristine sky/azure caustics
      const grad = ctx.createLinearGradient(0, 0, w, h)
      grad.addColorStop(0, '#f8fafc')
      grad.addColorStop(0.5, '#eef2ff')
      grad.addColorStop(1, '#f1f5f9')
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, w, h)

      this.drawLightOrb(ctx, w * 0.25, h * 0.2, 240, 'rgba(125, 211, 252, 0.25)')
      this.drawLightOrb(ctx, w * 0.8, h * 0.35, 280, 'rgba(199, 210, 254, 0.30)')
      this.drawLightOrb(ctx, w * 0.45, h * 0.85, 260, 'rgba(221, 214, 254, 0.22)')
    }
  }

  private drawLightOrb(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
    const radial = ctx.createRadialGradient(x, y, 0, x, y, r)
    radial.addColorStop(0, color)
    radial.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = radial
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }

  public updateTheme(): void {
    this.detectTheme()
    if (this.bgCanvas && this.renderer) {
      const ctx = this.bgCanvas.getContext('2d')
      if (ctx) {
        this.drawAmbientBackground(ctx, this.bgCanvas.width, this.bgCanvas.height)
        const dataUrl = this.bgCanvas.toDataURL('image/webp', 0.9)
        this.renderer.loadWallpaper(dataUrl).catch(() => {})
      }
    }
    this.refreshElements()
  }

  public registerElement(el: HTMLElement, type: TrackedElement['type'] = 'default', customRadius?: number): string {
    let id = this.elToId.get(el)
    if (!id) {
      id = `lg-el-${++this.elementIdCounter}`
      this.elToId.set(el, id)
    }

    this.trackedElements.set(id, {
      id,
      el,
      type,
      customRadius,
    })

    if (this.resizeObserver) {
      this.resizeObserver.observe(el)
    }

    this.requestRedraw()
    return id
  }

  public unregisterElement(el: HTMLElement): void {
    const id = this.elToId.get(el)
    if (id) {
      this.trackedElements.delete(id)
      this.elToId.delete(el)
      if (this.resizeObserver) {
        this.resizeObserver.unobserve(el)
      }
      this.requestRedraw()
    }
  }

  public scanAndTrack(root: Document | HTMLElement = document): void {
    // Select all UI components that qualify for liquid glass styling
    const selectors = [
      '.main-nav',
      '.nav-tab.active',
      '.btn-primary',
      '.add-btn',
      '.login-card',
      '.auth-card',
      '.connection-card',
      '.modal-content',
      '.terminal-smartbar',
      '.smartbar-tab.active',
      '.activity-range-tabs',
      '.activity-card',
      '.ai-chat-container',
      '.ai-message.assistant',
      '.ai-message.user',
      '.notes-sidebar',
      '.settings-nav',
      '.settings-section-card',
      '.liquid-glass',
      '[data-liquid-glass]',
    ]

    const matched = root.querySelectorAll<HTMLElement>(selectors.join(', '))
    matched.forEach((el) => {
      // Determine element type
      let type: TrackedElement['type'] = 'default'
      if (el.classList.contains('main-nav') || el.classList.contains('terminal-smartbar')) {
        type = 'nav'
      } else if (el.classList.contains('btn') || el.tagName === 'BUTTON') {
        type = 'button'
      } else if (el.classList.contains('connection-card') || el.classList.contains('login-card') || el.classList.contains('auth-card') || el.classList.contains('settings-section-card')) {
        type = 'card'
      } else if (el.classList.contains('modal-content')) {
        type = 'modal'
      } else if (el.classList.contains('nav-tab') || el.classList.contains('smartbar-tab')) {
        type = 'tab'
      } else if (el.classList.contains('activity-range-tabs')) {
        type = 'pill'
      }
      this.registerElement(el, type)
    })
  }

  private attachEvents(): void {
    // Window resize
    window.addEventListener('resize', () => this.resize(), { passive: true })
    window.addEventListener('scroll', () => this.requestRedraw(), { passive: true, capture: true })

    // Mouse / pointer movement for dynamic specular rim lighting & refraction
    window.addEventListener('pointermove', (e) => {
      this.pointerX = e.clientX
      this.pointerY = e.clientY
      this.lightAngle = Math.atan2(e.clientY - window.innerHeight / 2, e.clientX - window.innerWidth / 2)
      if (this.renderer) {
        this.renderer.needsRedraw = true
      }
    }, { passive: true })

    // Press feedback for tactile spring animations
    window.addEventListener('pointerdown', (e) => {
      const target = (e.target as HTMLElement)?.closest?.('[data-liquid-glass], .btn, .nav-tab, .connection-card, .login-card') as HTMLElement | null
      if (target && this.renderer) {
        const id = this.elToId.get(target)
        if (id) {
          this.activePressedId = id
          const rect = target.getBoundingClientRect()
          this.renderer.setPressed(id, true, {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          })
          this.renderer.needsRedraw = true
        }
      }
    }, { passive: true })

    window.addEventListener('pointerup', () => {
      if (this.activePressedId && this.renderer) {
        this.renderer.setPressed(this.activePressedId, false)
        this.activePressedId = null
        this.renderer.needsRedraw = true
      }
    }, { passive: true })

    window.addEventListener('pointercancel', () => {
      if (this.activePressedId && this.renderer) {
        this.renderer.setPressed(this.activePressedId, false)
        this.activePressedId = null
        this.renderer.needsRedraw = true
      }
    }, { passive: true })

    // ResizeObserver for tracking geometry changes
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.requestRedraw()
      })
    }

    // MutationObserver to track theme and DOM changes
    if (typeof MutationObserver !== 'undefined') {
      this.mutationObserver = new MutationObserver((mutations) => {
        let themeChanged = false
        let domChanged = false
        for (const m of mutations) {
          if (m.type === 'attributes' && m.attributeName === 'data-theme') {
            themeChanged = true
          } else if (m.type === 'childList') {
            domChanged = true
          }
        }
        if (themeChanged) {
          this.updateTheme()
        }
        if (domChanged) {
          this.scanAndTrack()
          this.requestRedraw()
        }
      })

      this.mutationObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
      })
      this.mutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
      })
    }
  }

  public resize(): void {
    if (!this.canvas || !this.renderer) return
    const w = window.innerWidth
    const h = window.innerHeight
    this.canvas.width = w * (window.devicePixelRatio || 1)
    this.canvas.height = h * (window.devicePixelRatio || 1)
    this.canvas.style.width = w + 'px'
    this.canvas.style.height = h + 'px'
    this.renderer.resize(w, h)
    this.refreshElements()
    this.renderer.markAllDirty()
    this.renderer.needsRedraw = true
  }

  private computeCornerRadius(el: HTMLElement, rect: DOMRect, custom?: number): number {
    if (typeof custom === 'number') return custom
    const style = window.getComputedStyle(el)
    const br = parseFloat(style.borderRadius)
    if (!isNaN(br) && br > 0) {
      // If border radius is 50% or >= half min dimension, treat as capsule
      if (style.borderRadius.includes('50%') || style.borderRadius.includes('9999px') || br >= Math.min(rect.width, rect.height) / 2) {
        return Math.min(rect.width, rect.height) / 2
      }
      return br
    }
    return 16 // Default modern squircle radius
  }

  public refreshElements(): void {
    if (!this.renderer) return

    const configs: GlassElementConfig[] = []
    const viewportW = window.innerWidth
    const viewportH = window.innerHeight

    this.trackedElements.forEach((item) => {
      const { el, id, type, customRadius } = item
      if (!el.isConnected || el.offsetParent === null) {
        return // Hidden or detached
      }

      const rect = el.getBoundingClientRect()
      // Frustum culling: skip elements completely outside viewport
      if (rect.bottom < -40 || rect.top > viewportH + 40 || rect.right < -40 || rect.left > viewportW + 40) {
        return
      }

      if (rect.width <= 0 || rect.height <= 0) return

      const cornerRadius = this.computeCornerRadius(el, rect, customRadius)
      
      // Dynamic angle from center of element to current pointer position
      const centerX = rect.left + rect.width / 2
      const centerY = rect.top + rect.height / 2
      const elAngle = Math.atan2(this.pointerY - centerY, this.pointerX - centerX)

      const isDark = this.isDark

      // Create highlight tuned to type and theme
      const highlight: GlassHighlight = {
        mode: 0,
        color: isDark ? [1, 1, 1] : [1, 1, 1],
        angle: this.options.enableDynamicHighlight ? elAngle : Math.PI / 4,
        falloff: type === 'button' ? 1.4 : 1.0,
        alpha: isDark ? (type === 'button' ? 0.65 : 0.45) : (type === 'button' ? 0.85 : 0.65),
        widthDp: type === 'button' ? 0.75 : 0.5,
        blurRadiusDp: 0.5,
      }

      // Colors customized by element type
      let tintColor: [number, number, number, number]
      let surfaceColor: [number, number, number, number]
      let blurRadius = 16
      let refractionAmount = -24
      let refractionHeight = 12

      if (isDark) {
        // Deep obsidian crystal
        if (type === 'button') {
          tintColor = [0.12, 0.45, 0.95, 0.35] // Subtle electric azure
          surfaceColor = [0.25, 0.40, 0.75, 0.20]
          refractionAmount = -28
          refractionHeight = 14
        } else if (type === 'nav' || type === 'tab') {
          tintColor = [0.10, 0.14, 0.24, 0.30]
          surfaceColor = [0.18, 0.24, 0.36, 0.16]
          blurRadius = 24
        } else if (type === 'modal') {
          tintColor = [0.08, 0.12, 0.22, 0.50]
          surfaceColor = [0.15, 0.22, 0.34, 0.25]
          blurRadius = 32
        } else {
          tintColor = [0.09, 0.13, 0.22, 0.22]
          surfaceColor = [0.18, 0.24, 0.38, 0.14]
          blurRadius = 18
        }
      } else {
        // Pure luminous crystal water
        if (type === 'button') {
          tintColor = [0.20, 0.50, 0.95, 0.40]
          surfaceColor = [0.85, 0.92, 1.0, 0.45]
          refractionAmount = -26
          refractionHeight = 13
        } else if (type === 'nav' || type === 'tab') {
          tintColor = [0.95, 0.97, 1.0, 0.55]
          surfaceColor = [1.0, 1.0, 1.0, 0.40]
          blurRadius = 24
        } else if (type === 'modal') {
          tintColor = [0.96, 0.98, 1.0, 0.75]
          surfaceColor = [1.0, 1.0, 1.0, 0.60]
          blurRadius = 32
        } else {
          tintColor = [0.95, 0.97, 1.0, 0.45]
          surfaceColor = [1.0, 1.0, 1.0, 0.35]
          blurRadius = 18
        }
      }

      configs.push({
        id,
        kind: 'glass-shape',
        rect: {
          x: rect.left,
          y: rect.top,
          w: rect.width,
          h: rect.height,
        },
        cornerRadius,
        refractionHeight,
        refractionAmount,
        depthEffect: true,
        chromaticAberration: true, // Full chromatic aberration for authentic liquid glass!
        blurRadius,
        saturation: isDark ? 1.4 : 1.25,
        brightness: 0,
        contrast: 1.05,
        tintColor,
        surfaceColor,
        highlight,
        outerShadow: {
          radius: type === 'modal' ? 32 : (type === 'card' ? 20 : 12),
          alpha: isDark ? 0.25 : 0.12,
          offsetX: 0,
          offsetY: type === 'modal' ? 8 : 4,
          color: [0, 0, 0],
        },
        label: '',
        labelColor: [1, 1, 1, 1],
        showChevron: false,
        isInteractive: type === 'button' || type === 'tab',
      })
    })

    this.renderer.setElements(configs)
  }

  public requestRedraw(): void {
    if (this.renderer) {
      this.renderer.needsRedraw = true
    }
  }

  private start(): void {
    if (this.isRunning) return
    this.isRunning = true

    const tick = (now: number) => {
      if (!this.isRunning) return

      // Throttle DOM geometry updates to ~30Hz or on interaction, while WebGL renders at 60Hz
      if (now - this.lastUpdate > 33) {
        this.lastUpdate = now
        this.refreshElements()
      }

      if (this.renderer) {
        this.renderer.render()
      }

      this.rafId = requestAnimationFrame(tick)
    }

    this.rafId = requestAnimationFrame(tick)
  }

  public stop(): void {
    this.isRunning = false
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect()
      this.resizeObserver = null
    }
    if (this.mutationObserver) {
      this.mutationObserver.disconnect()
      this.mutationObserver = null
    }
  }
}

// Global auto-init helper
export function initZephyrLiquidGlass(options?: ZephyrLiquidGlassOptions): ZephyrLiquidGlass | null {
  if (typeof window === 'undefined') return null
  const existing = (window as unknown as { __zephyrLiquidGlass?: ZephyrLiquidGlass }).__zephyrLiquidGlass
  if (existing) return existing

  const instance = new ZephyrLiquidGlass(options)
  const success = instance.init()
  if (success) {
    ;(window as unknown as { __zephyrLiquidGlass: ZephyrLiquidGlass }).__zephyrLiquidGlass = instance
    return instance
  }
  return null
}
