// public/liquid-glass/src/zephyr-liquid-glass.ts
// Zephyr WebGL Liquid Glass Integration Runtime
// Authentic port of martin65536/liquid-glass-webgl & Kyant0/AndroidLiquidGlass
// Full WebGL pipeline: G2 continuous curvature, refractive lens, chromatic aberration,
// specular rim highlights, radial press glow, spring dynamics, and LiquidBottomTabs.

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

interface ActiveTabDrag {
  groupId: string
  containerEl: HTMLElement
  tabs: HTMLElement[]
  tabWidth: number
  startTabIndex: number
  startX: number
  pointerId: number
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
  private activeTabDrag: ActiveTabDrag | null = null
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

    // Generate and load authentic ambient light caustics
    this.initAmbientAtmosphere()

    // Track existing DOM elements
    this.scanAndTrack()

    // Attach event listeners including fluid tab dragging
    this.attachEvents()

    // Start render loop
    this.start()

    console.info('[Zephyr Liquid Glass] Running WebGL G2 Continuous Curvature Liquid Glass Engine with LiquidTabs')
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

  /**
   * Generates a sleek, high-fidelity ambient chromatic lightfield on an offscreen canvas.
   * This provides the physical light gradients and caustics necessary for the WebGL
   * chromatic aberration and circleMap refraction to displace into realistic optical glass,
   * without using a photo wallpaper.
   */
  private initAmbientAtmosphere(): void {
    if (!this.renderer) return
    const w = 1024
    const h = 1024
    const bgCanvas = document.createElement('canvas')
    bgCanvas.width = w
    bgCanvas.height = h
    const ctx = bgCanvas.getContext('2d')
    if (!ctx) return

    if (this.isDark) {
      // Deep obsidian slate with rich chromatic caustics
      const grad = ctx.createLinearGradient(0, 0, 0, h)
      grad.addColorStop(0, '#0a0d14')
      grad.addColorStop(0.5, '#0e121a')
      grad.addColorStop(1, '#07090f')
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, w, h)

      // Light caustics positioned to cast prismatic dispersion through top bars
      this.drawLightOrb(ctx, w * 0.5, h * 0.08, 480, 'rgba(56, 189, 248, 0.16)') // Azure caustic bloom
      this.drawLightOrb(ctx, w * 0.2, h * 0.15, 360, 'rgba(99, 102, 241, 0.14)') // Indigo bloom
      this.drawLightOrb(ctx, w * 0.8, h * 0.18, 380, 'rgba(168, 85, 247, 0.13)') // Violet bloom
      this.drawLightOrb(ctx, w * 0.35, h * 0.65, 520, 'rgba(14, 165, 233, 0.08)')
      this.drawLightOrb(ctx, w * 0.75, h * 0.75, 460, 'rgba(139, 92, 246, 0.09)')
    } else {
      // Crisp luminous daylight with pristine sky & lavender caustics
      const grad = ctx.createLinearGradient(0, 0, 0, h)
      grad.addColorStop(0, '#f8fafc')
      grad.addColorStop(0.5, '#f1f5f9')
      grad.addColorStop(1, '#edf2f7')
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, w, h)

      this.drawLightOrb(ctx, w * 0.5, h * 0.08, 500, 'rgba(14, 165, 233, 0.22)')
      this.drawLightOrb(ctx, w * 0.2, h * 0.15, 400, 'rgba(99, 102, 241, 0.18)')
      this.drawLightOrb(ctx, w * 0.8, h * 0.18, 420, 'rgba(168, 85, 247, 0.16)')
    }

    const dataUrl = bgCanvas.toDataURL('image/webp', 0.92)
    this.renderer.loadWallpaper(dataUrl).then(() => {
      if (this.renderer) {
        this.renderer.wallpaperReady = true
        this.renderer.markAllDirty()
        this.renderer.needsRedraw = true
      }
    }).catch(() => {
      if (this.renderer) {
        this.renderer.setBackgroundColor(this.isDark ? [0.055, 0.063, 0.082] : [0.957, 0.960, 0.968])
      }
    })
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
    this.initAmbientAtmosphere()
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
      '.activity-item',
      '.activity-card',
      '.search-input',
      '.action-bar select',
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
      // Skip items managed as unified LiquidBottomTabs
      if (el.classList.contains('nav-tab') || el.classList.contains('settings-tab') || el.classList.contains('activity-range-btn')) {
        return
      }

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
      } else if (el.classList.contains('smartbar-tab')) {
        type = 'tab'
      } else if (el.classList.contains('protocol-badge')) {
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

    // Pointer movement drives dynamic specular highlights and Fresnel rim glints
    window.addEventListener('pointermove', (e) => {
      this.pointerX = e.clientX
      this.pointerY = e.clientY

      // If a tab drag gesture is active, forward drag coordinates directly to WebGL renderer
      if (this.activeTabDrag && this.renderer) {
        const { groupId, startTabIndex, startX, tabWidth, tabs, containerEl } = this.activeTabDrag
        this.renderer.dragTab(groupId, startTabIndex, e.clientX, startX, tabWidth, tabs.length)
        this.renderer.needsRedraw = true

        const thumb = containerEl.querySelector<HTMLElement>('.liquid-tab-thumb')
        if (thumb && tabs[startTabIndex]) {
          const baseRect = tabs[startTabIndex].getBoundingClientRect()
          const containerRect = containerEl.getBoundingClientRect()
          const deltaX = e.clientX - startX
          const x = (baseRect.left - containerRect.left) + deltaX
          thumb.style.transition = 'none'
          thumb.style.transform = `translate3d(${x}px, 0, 0)`
        }
      } else if (this.renderer) {
        this.renderer.needsRedraw = true
      }
    }, { passive: true })

    // Gesture handling: supports both button press springs and fluid tab dragging
    window.addEventListener('pointerdown', (e) => {
      const target = e.target as HTMLElement | null

      // Check if pointer hit a tab inside a LiquidTabs container
      const navTab = target?.closest?.('.nav-tab') as HTMLElement | null
      const settingsTab = target?.closest?.('.settings-tab') as HTMLElement | null
      const activityBtn = target?.closest?.('.activity-range-btn') as HTMLElement | null

      if ((navTab || settingsTab || activityBtn) && this.renderer) {
        const tabEl = (navTab || settingsTab || activityBtn)!
        const containerEl = tabEl.parentElement
        if (containerEl) {
          const groupId = navTab ? 'nav-tabs' : settingsTab ? 'settings-tabs' : 'activity-tabs'
          const tabSelector = navTab ? '.nav-tab:not(.force-hidden)' : settingsTab ? '.settings-tab:not(.force-hidden)' : '.activity-range-btn'
          const tabs = Array.from(containerEl.querySelectorAll<HTMLElement>(tabSelector)).filter(t => t.offsetParent !== null)
          const startTabIndex = tabs.indexOf(tabEl)

          if (startTabIndex >= 0 && tabs.length > 0) {
            const containerRect = containerEl.getBoundingClientRect()
            const tabWidth = (containerRect.width - 6) / tabs.length

            this.activeTabDrag = {
              groupId,
              containerEl,
              tabs,
              tabWidth,
              startTabIndex,
              startX: e.clientX,
              pointerId: e.pointerId,
            }

            this.renderer.beginTabDrag(groupId, startTabIndex, tabs.length)
            this.renderer.needsRedraw = true
            return
          }
        }
      }

      // Other interactive elements: buttons, cards
      const pressTarget = target?.closest?.(
        'button, .btn, .smartbar-tab, .connection-card, .login-card, [data-liquid-glass]'
      ) as HTMLElement | null

      if (pressTarget && this.renderer) {
        const id = this.elToId.get(pressTarget)
        if (id) {
          this.activePressedId = id
          const rect = pressTarget.getBoundingClientRect()
          this.renderer.setPressed(id, true, {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          })
          this.renderer.needsRedraw = true
        }
      }
    }, { passive: true })

    const handlePointerUpOrCancel = (e: PointerEvent) => {
      // Complete active tab drag with critically damped spring snap
      if (this.activeTabDrag && this.renderer) {
        const { groupId, tabs, containerEl } = this.activeTabDrag
        const finalIndex = this.renderer.endTabDrag(groupId, tabs.length)
        if (finalIndex >= 0 && finalIndex < tabs.length) {
          tabs[finalIndex].click()
          const thumb = containerEl.querySelector<HTMLElement>('.liquid-tab-thumb')
          if (thumb) {
            thumb.style.transition = 'transform 260ms cubic-bezier(0.23, 1, 0.32, 1), width 260ms cubic-bezier(0.23, 1, 0.32, 1)'
            const targetRect = tabs[finalIndex].getBoundingClientRect()
            const containerRect = containerEl.getBoundingClientRect()
            thumb.style.transform = `translate3d(${targetRect.left - containerRect.left}px, 0, 0)`
            thumb.style.width = `${targetRect.width}px`
          }
        }
        this.activeTabDrag = null
        this.renderer.needsRedraw = true
      }

      if (this.activePressedId && this.renderer) {
        this.renderer.setPressed(this.activePressedId, false)
        this.activePressedId = null
        this.renderer.needsRedraw = true
      }
    }

    window.addEventListener('pointerup', handlePointerUpOrCancel, { passive: true })
    window.addEventListener('pointercancel', handlePointerUpOrCancel, { passive: true })

    // Tab click handlers for instantaneous programmatic tab jumps
    document.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null
      const navTab = target?.closest?.('.nav-tab') as HTMLElement | null
      if (navTab && this.renderer) {
        const parent = navTab.parentElement
        if (parent) {
          const tabs = Array.from(parent.querySelectorAll<HTMLElement>('.nav-tab:not(.force-hidden)'))
          const idx = tabs.indexOf(navTab)
          if (idx >= 0) {
            this.renderer.setTabSelected('nav-tabs', idx, tabs.length)
            this.requestRedraw()
          }
        }
      }

      const settingsTab = target?.closest?.('.settings-tab') as HTMLElement | null
      if (settingsTab && this.renderer) {
        const parent = settingsTab.parentElement
        if (parent) {
          const tabs = Array.from(parent.querySelectorAll<HTMLElement>('.settings-tab:not(.force-hidden)'))
          const idx = tabs.indexOf(settingsTab)
          if (idx >= 0) {
            this.renderer.setTabSelected('settings-tabs', idx, tabs.length)
            this.requestRedraw()
          }
        }
      }

      const activityBtn = target?.closest?.('.activity-range-btn') as HTMLElement | null
      if (activityBtn && this.renderer) {
        const parent = activityBtn.parentElement
        if (parent) {
          const tabs = Array.from(parent.querySelectorAll<HTMLElement>('.activity-range-btn'))
          const idx = tabs.indexOf(activityBtn)
          if (idx >= 0) {
            this.renderer.setTabSelected('activity-tabs', idx, tabs.length)
            this.requestRedraw()
          }
        }
      }
    }, true)

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

  /**
   * Builds the authentic 3-layer LiquidBottomTabs pipeline from martin65536/liquid-glass-webgl:
   * Layer 1: Floating Liquid Glass Capsule Container
   * Layer 2: Tab Content items
   * Layer 3: Sliding Optical Glass Capsule Indicator with Chromatic Dispersion & Spring Inertia
   */
  private buildLiquidTabs(
    groupId: string,
    containerEl: HTMLElement | null,
    tabSelector: string,
    configs: GlassElementConfig[],
    accentColor: [number, number, number] = [0.04, 0.52, 0.98]
  ): void {
    if (!this.renderer || !containerEl || !containerEl.isConnected || containerEl.offsetParent === null) return
    const containerRect = containerEl.getBoundingClientRect()
    if (containerRect.width <= 2 || containerRect.height <= 2) return

    const tabs = Array.from(containerEl.querySelectorAll<HTMLElement>(tabSelector)).filter(
      (el) => el.offsetParent !== null && !el.classList.contains('force-hidden')
    )
    const tabsCount = tabs.length
    if (tabsCount === 0) return

    const activeIndex = Math.max(0, tabs.findIndex((t) => t.classList.contains('active')))

    const isDark = this.isDark
    const GLASS_PAD = 3
    const containerH = containerRect.height
    const containerW = containerRect.width
    const containerR = containerH / 2 // Pure capsule
    const indicatorH = containerH - 2 * GLASS_PAD
    const indicatorR = indicatorH / 2
    const tabW = (containerW - 2 * GLASS_PAD) / tabsCount

    // Ensure the toggle state exists and has accurate span
    this.renderer.ensureToggleState(groupId, activeIndex, LiquidGlassRenderer.TAB_PRESSED_SCALE, tabsCount - 1)

    // Sync selected tab with renderer state
    const currentTarget = this.renderer.getTabTarget(groupId)
    if (currentTarget !== activeIndex && !this.activeTabDrag) {
      this.renderer.setTabSelected(groupId, activeIndex, tabsCount)
    }

    // Ensure the DOM container has a sliding thumb indicator
    let thumb = containerEl.querySelector<HTMLElement>('.liquid-tab-thumb')
    if (!thumb) {
      thumb = document.createElement('span')
      thumb.className = 'liquid-tab-thumb'
      thumb.setAttribute('aria-hidden', 'true')
      containerEl.prepend(thumb)
    }

    // Position the thumb over the active tab
    const activeTab = tabs[activeIndex]
    if (activeTab && thumb) {
      const activeRect = activeTab.getBoundingClientRect()
      const x = activeRect.left - containerRect.left
      const w = activeRect.width
      if (!this.activeTabDrag || this.activeTabDrag.groupId !== groupId) {
        thumb.style.transform = `translate3d(${x}px, 0, 0)`
        thumb.style.width = `${w}px`
      }
    }

    // --- Layer 1: Container (Floating Liquid Glass capsule bar) ---
    const containerConfig: GlassElementConfig = {
      id: `${groupId}-container`,
      kind: 'glass-shape',
      rect: {
        x: containerRect.left,
        y: containerRect.top,
        w: containerW,
        h: containerH,
      },
      cornerRadius: containerR,
      refractionHeight: 24,
      refractionAmount: -24,
      depthEffect: true,
      chromaticAberration: true,
      blurRadius: 8,
      saturation: 1.5,
      contrast: 1.06,
      brightness: 0.02,
      tintColor: [0, 0, 0, 0],
      surfaceColor: isDark ? [1.0, 1.0, 1.0, 0.12] : [1.0, 1.0, 1.0, 0.40],
      highlight: {
        mode: 0,
        color: [1, 1, 1],
        angle: Math.PI / 4,
        falloff: 1.0,
        alpha: isDark ? 0.65 : 0.85,
        widthDp: 0.5,
      },
      outerShadow: {
        radius: 24,
        alpha: isDark ? 0.35 : 0.15,
        offsetX: 0,
        offsetY: 4,
        color: [0, 0, 0],
      },
      label: '',
      labelColor: [1, 1, 1, 1],
      showChevron: false,
      isInteractive: false,
      isBottomTabContainer: { groupId, tabsCount },
      useContinuousSdf: true,
    }
    configs.push(containerConfig)

    // --- Layer 2: Tab Content items (for scaling/transform sync) ---
    tabs.forEach((tabEl, i) => {
      const tabRect = tabEl.getBoundingClientRect()
      const contentConfig: GlassElementConfig = {
        id: `${groupId}-tab-${i}`,
        kind: 'glass-shape',
        rect: {
          x: tabRect.left,
          y: tabRect.top,
          w: tabRect.width,
          h: tabRect.height,
        },
        cornerRadius: indicatorR,
        refractionHeight: 0,
        refractionAmount: 0,
        depthEffect: false,
        chromaticAberration: false,
        blurRadius: 0,
        saturation: 1,
        contrast: 1,
        brightness: 0,
        tintColor: [0, 0, 0, 0],
        surfaceColor: [0, 0, 0, 0],
        highlight: null,
        outerShadow: null,
        label: '',
        labelColor: [1, 1, 1, 1],
        showChevron: false,
        isInteractive: false,
        isBottomTabContent: {
          groupId,
          containerCenterX: containerRect.left + containerW / 2,
          containerCenterY: containerRect.top + containerH / 2,
          containerWidth: containerW,
        },
      }
      configs.push(contentConfig)
    })

    // --- Layer 3: Selected Indicator (Sliding Optical Glass Capsule, TOPMOST) ---
    const indicatorConfig: GlassElementConfig = {
      id: `${groupId}-indicator`,
      kind: 'glass-shape',
      rect: {
        x: containerRect.left + GLASS_PAD,
        y: containerRect.top + GLASS_PAD,
        w: tabW,
        h: indicatorH,
      },
      cornerRadius: indicatorR,
      refractionHeight: 12,
      refractionAmount: -16,
      depthEffect: true,
      chromaticAberration: true, // 7-path rainbow dispersion!
      blurRadius: 0,
      saturation: 1.0,
      contrast: 1.0,
      brightness: 0.0,
      tintColor: [0, 0, 0, 0],
      surfaceColor: isDark ? [1.0, 1.0, 1.0, 0.08] : [1.0, 1.0, 1.0, 0.20],
      highlight: {
        mode: 0,
        color: [1, 1, 1],
        angle: Math.PI / 4,
        falloff: 1.0,
        alpha: isDark ? 0.75 : 0.90,
        widthDp: 0.6,
      },
      outerShadow: {
        radius: 16,
        alpha: isDark ? 0.45 : 0.20,
        offsetX: 0,
        offsetY: 3,
        color: [0, 0, 0],
      },
      innerShadow: {
        radius: 8,
        alpha: 0.35,
        offsetX: 0,
        offsetY: 8,
      },
      label: '',
      labelColor: [1, 1, 1, 1],
      showChevron: false,
      isInteractive: false,
      isBottomTabIndicator: {
        groupId,
        dragWidth: tabW,
        dimColor: isDark ? [1, 1, 1, 0.15] : [0, 0, 0, 0.08],
        accentColor,
        containerRect: {
          x: containerRect.left,
          y: containerRect.top + GLASS_PAD,
          w: containerW,
          h: indicatorH,
        },
        containerCenterX: containerRect.left + containerW / 2,
        containerCenterY: containerRect.top + containerH / 2,
        containerWidth: containerW,
      },
      useContinuousSdf: true,
    }
    configs.push(indicatorConfig)
  }

  public refreshElements(): void {
    if (!this.renderer) return

    const configs: GlassElementConfig[] = []
    const viewportW = window.innerWidth
    const viewportH = window.innerHeight

    // 1. Top Navigation Bar LiquidTabs (.nav-tabs)
    const navTabsContainer = document.querySelector<HTMLElement>('.nav-tabs')
    this.buildLiquidTabs('nav-tabs', navTabsContainer, '.nav-tab', configs, [0.04, 0.52, 0.98])

    // 2. Settings Navigation Menu LiquidTabs (.settings-menu)
    const settingsMenuContainer = document.querySelector<HTMLElement>('.settings-menu')
    this.buildLiquidTabs('settings-tabs', settingsMenuContainer, '.settings-tab', configs, [0.04, 0.52, 0.98])

    // 3. Activity Range LiquidTabs (.activity-range-tabs)
    const activityTabsContainer = document.querySelector<HTMLElement>('.activity-range-tabs')
    this.buildLiquidTabs('activity-tabs', activityTabsContainer, '.activity-range-btn', configs, [0.04, 0.52, 0.98])

    // 4. Other tracked UI elements: cards, buttons, modals
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

      // Skip elements handled inside specialized LiquidTabs
      if (el.closest('.nav-tabs') || el.closest('.settings-menu') || el.closest('.activity-range-tabs')) {
        return
      }

      const rect = el.getBoundingClientRect()
      // Viewport culling
      if (rect.bottom < -80 || rect.top > viewportH + 80 || rect.right < -80 || rect.left > viewportW + 80) {
        return
      }

      if (rect.width <= 2 || rect.height <= 2) return

      const cornerRadius = this.computeCornerRadius(el, rect, customRadius)
      
      const centerX = rect.left + rect.width / 2
      const centerY = rect.top + rect.height / 2
      const elAngle = this.options.enableDynamicHighlight
        ? Math.atan2(this.pointerY - centerY, this.pointerX - centerX)
        : Math.PI / 4

      const isDark = this.isDark

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
        chromaticAberration: true,
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
