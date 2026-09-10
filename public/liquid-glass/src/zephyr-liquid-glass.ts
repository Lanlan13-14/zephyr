// public/liquid-glass/src/zephyr-liquid-glass.ts
// Zephyr WebGL Liquid Glass Integration Runtime
// Authentic port of martin65536/liquid-glass-webgl & Kyant0/AndroidLiquidGlass
// Full WebGL pipeline: G2 continuous curvature, refractive lens, chromatic aberration,
// specular rim highlights, radial press glow, and spring dynamics.

import { LiquidGlassRenderer } from './renderer/index'
import type { GlassElementConfig, GlassHighlight } from './renderer/types'

export interface ZephyrLiquidGlassOptions {
  canvasId?: string
  enableDynamicHighlight?: boolean
  enableSprings?: boolean
  dpr?: number
}

interface TrackedElement {
  id: string
  el: HTMLElement
  type: 'nav' | 'card' | 'button' | 'btn-primary' | 'btn-danger' | 'modal' | 'pill' | 'panel' | 'input' | 'tab' | 'default'
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
  private isDark = true
  private resizeObserver: ResizeObserver | null = null
  private mutationObserver: MutationObserver | null = null
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
      canvas.style.position = 'fixed'
      canvas.style.top = '0'
      canvas.style.left = '0'
      canvas.style.width = '100vw'
      canvas.style.height = '100vh'
      canvas.style.zIndex = '0'
      canvas.style.pointerEvents = 'none'
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

    // WebGL configuration: G2 continuous curvature, full refraction
    this.renderer.useContinuousSdf = true
    this.renderer.cornerStyle = 1 // Continuous G2 squircle
    this.renderer.directBackdropSample = false // Full refractive sampling

    // Initial theme detection
    this.detectTheme()

    // Setup dimensions
    this.resize()

    // Set authentic Zephyr theme background (NO mobile wallpapers!)
    this.applyThemeBackground()

    // Track existing DOM elements
    this.scanAndTrack()

    // Attach event listeners
    this.attachEvents()

    // Start render loop
    this.start()

    console.info('[Zephyr Liquid Glass] Running WebGL G2 Continuous Curvature Liquid Glass Engine')
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

  private applyThemeBackground(): void {
    if (!this.renderer) return
    // Authentic Zephyr theme colors: Deep obsidian dark (#0e1015) / Pristine light (#f4f5f7)
    // No external phone wallpaper is loaded!
    const darkBg: [number, number, number] = [0.055, 0.063, 0.082]
    const lightBg: [number, number, number] = [0.957, 0.960, 0.968]
    this.renderer.setBackgroundColor(this.isDark ? darkBg : lightBg)
    this.renderer.wallpaperReady = true
    this.renderer.markAllDirty()
    this.renderer.needsRedraw = true
  }

  public updateTheme(): void {
    this.detectTheme()
    this.applyThemeBackground()
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
    const selectors = [
      '.main-nav',
      '.nav-tab',
      '.nav-actions .btn-sm',
      '.btn-primary',
      '.add-btn',
      '.btn.danger',
      '.btn',
      '.tool-btn',
      '.login-card',
      '.auth-card',
      '.connection-card',
      '.protocol-badge',
      '.modal-content',
      '.terminal-smartbar',
      '.smartbar-tab',
      '.activity-range-tabs',
      '.activity-range-btn',
      '.activity-item',
      '.activity-card',
      '.search-input',
      '.action-bar select',
      '.settings-menu',
      '.settings-tab',
      '.settings-content',
      '.settings-section-card',
      '.ai-chat-container',
      '.ai-floating-btn',
      '.floating-panel',
      '.toast',
      '[data-liquid-glass]',
    ]

    const matched = root.querySelectorAll<HTMLElement>(selectors.join(', '))
    matched.forEach((el) => {
      let type: TrackedElement['type'] = 'default'
      if (el.classList.contains('main-nav') || el.classList.contains('terminal-smartbar')) {
        type = 'nav'
      } else if (el.classList.contains('btn-primary') || el.classList.contains('add-btn')) {
        type = 'btn-primary'
      } else if (el.classList.contains('danger')) {
        type = 'btn-danger'
      } else if (el.classList.contains('btn') || el.tagName === 'BUTTON' || el.classList.contains('tool-btn')) {
        type = 'button'
      } else if (el.classList.contains('connection-card') || el.classList.contains('login-card') || el.classList.contains('auth-card') || el.classList.contains('settings-section-card') || el.classList.contains('settings-content')) {
        type = 'card'
      } else if (el.classList.contains('modal-content')) {
        type = 'modal'
      } else if (el.classList.contains('nav-tab') || el.classList.contains('smartbar-tab') || el.classList.contains('settings-tab')) {
        type = 'tab'
      } else if (el.classList.contains('protocol-badge') || el.classList.contains('activity-range-btn') || el.classList.contains('activity-range-tabs')) {
        type = 'pill'
      } else if (el.classList.contains('search-input') || el.tagName === 'INPUT' || el.tagName === 'SELECT') {
        type = 'input'
      }
      this.registerElement(el, type)
    })
  }

  private attachEvents(): void {
    window.addEventListener('resize', () => this.resize(), { passive: true })
    window.addEventListener('scroll', () => {
      this.refreshElements()
      this.requestRedraw()
    }, { passive: true, capture: true })

    // Mouse pointer movement drives dynamic specular highlights and Fresnel rim glints
    window.addEventListener('pointermove', (e) => {
      this.pointerX = e.clientX
      this.pointerY = e.clientY
      if (this.renderer) {
        this.renderer.needsRedraw = true
      }
    }, { passive: true })

    // Tactile spring press feedback with pointer coordinates
    window.addEventListener('pointerdown', (e) => {
      const target = (e.target as HTMLElement)?.closest?.(
        'button, .btn, .nav-tab, .smartbar-tab, .connection-card, .login-card, [data-liquid-glass]'
      ) as HTMLElement | null

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

    // ResizeObserver
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.requestRedraw()
      })
    }

    // MutationObserver
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
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    this.canvas.width = Math.round(w * dpr)
    this.canvas.height = Math.round(h * dpr)
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
      if (style.borderRadius.includes('50%') || style.borderRadius.includes('9999px') || br >= Math.min(rect.width, rect.height) / 2) {
        return Math.min(rect.width, rect.height) / 2
      }
      return br
    }
    return 16
  }

  public refreshElements(): void {
    if (!this.renderer) return

    const configs: GlassElementConfig[] = []
    const viewportW = window.innerWidth
    const viewportH = window.innerHeight

    // Render sequence: Nav & Cards (background) -> Pills & Tabs -> Buttons & Inputs -> Modals (foreground)
    const orderMap: Record<TrackedElement['type'], number> = {
      nav: 10,
      card: 20,
      panel: 25,
      pill: 30,
      tab: 35,
      input: 40,
      button: 50,
      'btn-primary': 60,
      'btn-danger': 60,
      modal: 100,
      default: 20,
    }

    const sortedItems = Array.from(this.trackedElements.values()).sort((a, b) => {
      return (orderMap[a.type] || 20) - (orderMap[b.type] || 20)
    })

    sortedItems.forEach((item) => {
      const { el, id, type, customRadius } = item
      if (!el.isConnected || el.offsetParent === null) {
        return
      }

      const rect = el.getBoundingClientRect()
      // Viewport culling
      if (rect.bottom < -80 || rect.top > viewportH + 80 || rect.right < -80 || rect.left > viewportW + 80) {
        return
      }

      if (rect.width <= 2 || rect.height <= 2) return

      const cornerRadius = this.computeCornerRadius(el, rect, customRadius)
      
      // Dynamic angle from center of element to current pointer position
      const centerX = rect.left + rect.width / 2
      const centerY = rect.top + rect.height / 2
      const elAngle = this.options.enableDynamicHighlight
        ? Math.atan2(this.pointerY - centerY, this.pointerX - centerX)
        : Math.PI / 4

      const isDark = this.isDark

      // Authentic Liquid Glass Parameters: G2 continuous curvature, chromatic aberration,
      // Fresnel specular reflection, and multi-tap drop shadow
      let refractionHeight = 14
      let refractionAmount = -24
      let blurRadius = 14
      let saturation = isDark ? 1.45 : 1.25
      let contrast = 1.05
      let brightness = 0.02
      let surfaceAlpha = isDark ? 0.12 : 0.45
      let tintColor: [number, number, number, number] = [0, 0, 0, 0]
      let surfaceColor: [number, number, number, number] = isDark
        ? [1.0, 1.0, 1.0, surfaceAlpha]
        : [1.0, 1.0, 1.0, surfaceAlpha]
      let shadowRadius = 24
      let shadowAlpha = isDark ? 0.35 : 0.12
      let shadowOffsetY = 6
      let highlightAlpha = isDark ? 0.65 : 0.85
      let highlightWidth = 0.75

      switch (type) {
        case 'nav':
          refractionHeight = 14
          refractionAmount = -24
          blurRadius = 20
          surfaceAlpha = isDark ? 0.08 : 0.40
          surfaceColor = isDark ? [1.0, 1.0, 1.0, surfaceAlpha] : [1.0, 1.0, 1.0, surfaceAlpha]
          shadowRadius = 28
          shadowOffsetY = 8
          break
        case 'card':
          refractionHeight = 14
          refractionAmount = -24
          blurRadius = 16
          surfaceAlpha = isDark ? 0.09 : 0.42
          surfaceColor = isDark ? [1.0, 1.0, 1.0, surfaceAlpha] : [1.0, 1.0, 1.0, surfaceAlpha]
          shadowRadius = 24
          shadowOffsetY = 6
          break
        case 'modal':
          refractionHeight = 18
          refractionAmount = -30
          blurRadius = 28
          surfaceAlpha = isDark ? 0.22 : 0.60
          surfaceColor = isDark ? [0.15, 0.20, 0.30, surfaceAlpha] : [1.0, 1.0, 1.0, surfaceAlpha]
          shadowRadius = 48
          shadowAlpha = isDark ? 0.60 : 0.25
          shadowOffsetY = 16
          highlightAlpha = 0.95
          break
        case 'btn-primary':
          refractionHeight = 12
          refractionAmount = -24
          blurRadius = 10
          tintColor = [0.04, 0.52, 0.98, 0.85] // Electric Azure Crystal
          surfaceColor = [0.20, 0.65, 1.0, 0.30]
          shadowRadius = 16
          shadowAlpha = 0.40
          shadowOffsetY = 4
          highlightAlpha = 0.90
          break
        case 'btn-danger':
          refractionHeight = 12
          refractionAmount = -24
          blurRadius = 10
          tintColor = [0.95, 0.22, 0.22, 0.85] // Ruby Crystal
          surfaceColor = [1.0, 0.35, 0.35, 0.30]
          shadowRadius = 16
          shadowAlpha = 0.40
          shadowOffsetY = 4
          highlightAlpha = 0.90
          break
        case 'button':
        case 'tab':
          refractionHeight = 10
          refractionAmount = -18
          blurRadius = 8
          surfaceAlpha = isDark ? 0.16 : 0.45
          surfaceColor = isDark ? [1.0, 1.0, 1.0, surfaceAlpha] : [1.0, 1.0, 1.0, surfaceAlpha]
          shadowRadius = 12
          shadowOffsetY = 3
          break
        case 'input':
          refractionHeight = 8
          refractionAmount = -14
          blurRadius = 8
          surfaceAlpha = isDark ? 0.06 : 0.25
          surfaceColor = isDark ? [1.0, 1.0, 1.0, surfaceAlpha] : [1.0, 1.0, 1.0, surfaceAlpha]
          shadowRadius = 8
          shadowOffsetY = 2
          break
        case 'pill':
          refractionHeight = 8
          refractionAmount = -14
          blurRadius = 8
          surfaceAlpha = isDark ? 0.14 : 0.40
          surfaceColor = isDark ? [1.0, 1.0, 1.0, surfaceAlpha] : [1.0, 1.0, 1.0, surfaceAlpha]
          shadowRadius = 8
          shadowOffsetY = 2
          break
      }

      const highlight: GlassHighlight = {
        mode: 0,
        color: [1, 1, 1],
        angle: elAngle,
        falloff: 1.2,
        alpha: highlightAlpha,
        widthDp: highlightWidth,
        blurRadiusDp: 0.5,
      }

      configs.push({
        id,
        kind: (type === 'button' || type === 'btn-primary' || type === 'btn-danger') ? 'button' : 'glass-shape',
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
        chromaticAberration: true, // 7-channel rainbow dispersion
        blurRadius,
        saturation,
        brightness,
        contrast,
        tintColor,
        surfaceColor,
        highlight,
        outerShadow: {
          radius: shadowRadius,
          alpha: shadowAlpha,
          offsetX: 0,
          offsetY: shadowOffsetY,
          color: [0, 0, 0],
        },
        label: '',
        labelColor: [1, 1, 1, 1],
        showChevron: false,
        isInteractive: type === 'button' || type === 'btn-primary' || type === 'btn-danger' || type === 'tab',
        useContinuousSdf: true,
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

      if (now - this.lastUpdate > 30) {
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
