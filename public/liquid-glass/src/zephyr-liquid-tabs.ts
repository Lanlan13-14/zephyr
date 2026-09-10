// public/liquid-glass/src/zephyr-liquid-tabs.ts
// Authentic 1:1 port of LiquidBottomTabs from martin65536/liquid-glass-webgl
// Provides the exact G2 continuous curvature, refractive lens, 7-channel chromatic dispersion,
// inner shadow, and DampedDragAnimation spring physics for Zephyr tab navigation bars.

import { LiquidGlassRenderer } from './renderer/index'
import type { GlassElementConfig } from './renderer/types'
import { makeGlassShape, makeText } from './catalog/helpers-elements'
import { makeTabDragInteractions } from './catalog/helpers-drag'
import { DEFAULT_HIGHLIGHT, DEFAULT_SHADOW, DP, getPalette } from './catalog/types'

export interface ZephyrTabItem {
  id: string
  label: string
  key: string
  iconPath?: string
}

export interface ZephyrLiquidTabsOptions {
  groupId: string
  container: HTMLElement
  tabs: ZephyrTabItem[]
  selectedIndex?: number
  height?: number
  onSelect: (index: number, tab: ZephyrTabItem) => void
}

export class ZephyrLiquidTabs {
  public canvas: HTMLCanvasElement
  public renderer: LiquidGlassRenderer
  public groupId: string
  public tabs: ZephyrTabItem[]
  public selectedIndex: number
  public onSelect: (index: number, tab: ZephyrTabItem) => void
  private container: HTMLElement
  private resizeObserver: ResizeObserver | null = null
  private mutationObserver: MutationObserver | null = null
  private isDark = true
  private activeInteraction: {
    onDragStart?: (pos: { x: number; y: number }) => void
    onDrag?: (pos: { x: number; y: number }) => void
    onDragEnd?: () => void
    onTap?: (pos: { x: number; y: number }) => void
  } | null = null
  private elements: GlassElementConfig[] = []
  private interactions: Record<string, any> = {}
  private customHeight: number

  constructor(options: ZephyrLiquidTabsOptions) {
    this.groupId = options.groupId
    this.container = options.container
    this.tabs = options.tabs
    this.selectedIndex = options.selectedIndex ?? 0
    this.onSelect = options.onSelect
    this.customHeight = options.height ?? 46

    // Create dedicated canvas inside container
    let existingCanvas = this.container.querySelector<HTMLCanvasElement>(`:scope > canvas.zephyr-liquid-tabs-canvas`)
    if (!existingCanvas) {
      existingCanvas = document.createElement('canvas')
      existingCanvas.className = 'zephyr-liquid-tabs-canvas'
      existingCanvas.setAttribute('aria-hidden', 'true')
      existingCanvas.style.display = 'block'
      existingCanvas.style.position = 'relative'
      existingCanvas.style.width = '100%'
      existingCanvas.style.height = '100%'
      existingCanvas.style.cursor = 'pointer'
      existingCanvas.style.touchAction = 'none'
      existingCanvas.style.userSelect = 'none'
      this.container.prepend(existingCanvas)
    }
    this.canvas = existingCanvas

    this.renderer = new LiquidGlassRenderer(this.canvas)
    this.renderer.cornerStyle = 1 // G2 continuous curvature
    this.renderer.useContinuousSdf = true

    this.detectTheme()
    this.initWallpaper()
    this.rebuild()
    this.attachEvents()
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

  private initWallpaper(): void {
    const wpPath = this.isDark
      ? '/liquid-glass/assets/wallpaper/wallpaper_dark.webp'
      : '/liquid-glass/assets/wallpaper/wallpaper_light.webp'

    this.renderer.loadWallpaper(wpPath).then(() => {
      this.renderer.wallpaperReady = true
      this.renderer.markAllDirty()
      this.renderer.needsRedraw = true
      this.renderer.render()
    }).catch(() => {
      // Relative fallback
      const rel = this.isDark
        ? 'liquid-glass/assets/wallpaper/wallpaper_dark.webp'
        : 'liquid-glass/assets/wallpaper/wallpaper_light.webp'
      this.renderer.loadWallpaper(rel).then(() => {
        this.renderer.wallpaperReady = true
        this.renderer.markAllDirty()
        this.renderer.needsRedraw = true
        this.renderer.render()
      }).catch(() => {})
    })
  }

  public setSelectedIndex(index: number): void {
    if (index < 0 || index >= this.tabs.length) return
    this.selectedIndex = index
    this.renderer.setTabSelected(this.groupId, index, this.tabs.length)
    this.renderer.markAllDirty()
    this.renderer.needsRedraw = true
  }

  public updateTabs(newTabs: ZephyrTabItem[], newSelectedIndex?: number): void {
    this.tabs = newTabs
    if (typeof newSelectedIndex === 'number') {
      this.selectedIndex = newSelectedIndex
    } else if (this.selectedIndex >= newTabs.length) {
      this.selectedIndex = Math.max(0, newTabs.length - 1)
    }
    this.rebuild()
  }

  public updateTheme(): void {
    this.detectTheme()
    this.initWallpaper()
    this.rebuild()
  }

  public resize(): void {
    const rect = this.container.getBoundingClientRect()
    if (rect.width <= 0) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = Math.round(rect.width)
    const h = Math.round(this.customHeight)

    this.canvas.width = Math.round(w * dpr)
    this.canvas.height = Math.round(h * dpr)
    this.canvas.style.width = `${w}px`
    this.canvas.style.height = `${h}px`

    this.renderer.resize(w, h)
    this.rebuild()
  }

  /**
   * Builds the 1:1 authentic 3-layer LiquidBottomTabs scene graph:
   * Layer 1: Container capsule (refraction + blur(8dp) + lens(24dp, 24dp) + highlight + shadow)
   * Layer 2: Tab labels & icons (makeText, rendered into fgTextures)
   * Layer 3: Sliding indicator (G2 capsule, lens(10dp, 14dp), chromatic aberration, inner shadow, blue tint)
   */
  public rebuild(): void {
    const W = this.renderer.cssWidth || this.container.clientWidth || 600
    const H = this.renderer.cssHeight || this.customHeight
    const tabsCount = this.tabs.length
    if (tabsCount === 0 || W <= 0) return

    this.elements = []
    this.interactions = {}

    const palette = getPalette(!this.isDark)
    const isDark = this.isDark

    const CONTAINER_H = H
    const GLASS_PAD = 4 * DP
    const GLASS_H = CONTAINER_H - 2 * GLASS_PAD
    const containerX = 0
    const containerW = W
    const containerR = CONTAINER_H / 2 // Pure capsule
    const glassX = containerX + GLASS_PAD
    const glassW = containerW - 2 * GLASS_PAD
    const glassR = GLASS_H / 2
    const tabW = glassW / tabsCount
    const glassY = GLASS_PAD

    const iconColor = palette.tabsContentColor
    const containerColor = isDark ? [0.10, 0.13, 0.20, 0.45] as [number, number, number, number] : [0.98, 0.98, 1.0, 0.50] as [number, number, number, number]
    const accentT = [0x00 / 255, 0x88 / 255, 0xff / 255] as [number, number, number]

    // Ensure toggle state exists in renderer
    this.renderer.ensureToggleState(this.groupId, this.selectedIndex, LiquidGlassRenderer.TAB_PRESSED_SCALE, tabsCount - 1)

    // === Layer 1: Container (Liquid Glass capsule bar, 48dp/64dp tall) ===
    const containerEl = makeGlassShape(
      `${this.groupId}-container`,
      { x: containerX, y: 0, w: containerW, h: CONTAINER_H },
      {
        cornerRadius: containerR,
        refractionHeight: 24 * DP,
        refractionAmount: -24 * DP,
        blurRadius: 8 * DP,
        saturation: 1.5,
        surfaceColor: containerColor,
        highlight: { ...DEFAULT_HIGHLIGHT, alpha: isDark ? 0.65 : 0.85 },
        depthEffect: true,
      },
      false
    )
    containerEl.isBottomTabContainer = { groupId: this.groupId, tabsCount }
    containerEl.independentBackdrop = true
    containerEl.useContinuousSdf = true
    this.elements.push(containerEl)

    // === Layer 2: Tab Content items ===
    const rendererRef = { current: this.renderer }
    const dragInteractions = makeTabDragInteractions(
      this.groupId,
      tabW,
      tabsCount,
      (idx) => {
        this.selectedIndex = idx
        if (this.tabs[idx]) {
          this.onSelect(idx, this.tabs[idx])
        }
      },
      rendererRef
    )

    for (let i = 0; i < tabsCount; i++) {
      const id = `${this.groupId}-tab-${i}`
      const tab = this.tabs[i]
      const tabEl = makeText(
        id,
        { x: glassX + tabW * i, y: glassY, w: tabW, h: GLASS_H },
        tab.label,
        {
          color: palette.tabsContentColor,
          fontSizePx: 13.5 * DP,
          fontWeight: 600,
          align: 'center',
          paddingPx: 0,
          halo: palette.tabsTextHalo,
          icon: tab.iconPath ? { path: tab.iconPath, size: 20, layoutSize: 24, color: iconColor, viewport: 960 } : undefined,
        },
        false
      )
      tabEl.isBottomTabContent = {
        groupId: this.groupId,
        containerCenterX: containerX + containerW / 2,
        containerCenterY: CONTAINER_H / 2,
        containerWidth: containerW,
      }
      this.elements.push(tabEl)

      this.interactions[id] = {
        onTap: () => {
          this.setSelectedIndex(i)
          if (this.tabs[i]) this.onSelect(i, this.tabs[i])
        },
        onDragStart: dragInteractions.onDragStart,
        onDrag: dragInteractions.onDrag,
        onDragEnd: dragInteractions.onDragEnd,
      }
    }

    this.interactions[`${this.groupId}-container`] = dragInteractions

    // === Layer 3: Selected Indicator (Sliding Optical Glass Capsule, TOPMOST) ===
    const indicatorEl = makeGlassShape(
      `${this.groupId}-indicator`,
      { x: containerX + GLASS_PAD, y: glassY, w: tabW, h: GLASS_H },
      {
        cornerRadius: glassR,
        refractionHeight: 12 * DP,
        refractionAmount: -16 * DP,
        blurRadius: 0, // Indicator has NO blur (pure lens)
        saturation: 1.0,
        tintColor: [0, 0, 0, 0],
        surfaceColor: [0, 0, 0, 0],
        highlight: { ...DEFAULT_HIGHLIGHT, alpha: 0.85 },
        outerShadow: { ...DEFAULT_SHADOW },
        innerShadow: { radius: 8 * DP, alpha: 0.35, offsetX: 0, offsetY: 8 * DP },
        chromaticAberration: true, // 7-channel dispersion
      },
      false
    )
    indicatorEl.independentBackdrop = false
    indicatorEl.useContinuousSdf = true
    indicatorEl.isBottomTabIndicator = {
      groupId: this.groupId,
      dragWidth: tabW,
      dimColor: isDark ? [1, 1, 1, 0.14] : [0, 0, 0, 0.08],
      accentColor: [...accentT] as [number, number, number],
      containerRect: { x: glassX - GLASS_PAD, y: glassY, w: glassW + 2 * GLASS_PAD, h: GLASS_H },
      containerCenterX: containerX + containerW / 2,
      containerCenterY: CONTAINER_H / 2,
      containerWidth: containerW,
      tabContentIds: Array.from({ length: tabsCount }, (_, i) => `${this.groupId}-tab-${i}`),
      tabContentRects: Array.from({ length: tabsCount }, (_, i) => ({
        x: glassX + tabW * i,
        y: glassY,
        w: tabW,
        h: GLASS_H,
      })),
    }
    this.elements.push(indicatorEl)

    this.renderer.setElements(this.elements)
    this.renderer.markAllDirty()
    this.renderer.needsRedraw = true
    this.renderer.render()
  }

  private attachEvents(): void {
    const canvas = this.canvas

    // Pointer events: direct 1:1 manipulation with setPointerCapture and spring physics
    canvas.addEventListener('pointerdown', (e) => {
      const rect = canvas.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top

      // Hit-test elements in reverse order (topmost first)
      for (let i = this.elements.length - 1; i >= 0; i--) {
        const el = this.elements[i]
        if (x >= el.rect.x && x <= el.rect.x + el.rect.w && y >= el.rect.y && y <= el.rect.y + el.rect.h) {
          if (this.interactions[el.id]) {
            this.activeInteraction = this.interactions[el.id]
            try { canvas.setPointerCapture(e.pointerId) } catch {}
            this.activeInteraction.onDragStart?.({ x, y })
            break
          }
        }
      }
    })

    canvas.addEventListener('pointermove', (e) => {
      if (this.activeInteraction) {
        const rect = canvas.getBoundingClientRect()
        const x = e.clientX - rect.left
        const y = e.clientY - rect.top
        this.activeInteraction.onDrag?.({ x, y })
      }
    })

    const handlePointerUp = (e: PointerEvent) => {
      if (this.activeInteraction) {
        this.activeInteraction.onDragEnd?.()
        this.activeInteraction = null
        try { canvas.releasePointerCapture(e.pointerId) } catch {}
      }
    }

    canvas.addEventListener('pointerup', handlePointerUp)
    canvas.addEventListener('pointercancel', handlePointerUp)

    // ResizeObserver
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.resize()
      })
      this.resizeObserver.observe(this.container)
    }

    // MutationObserver for theme detection
    if (typeof MutationObserver !== 'undefined') {
      this.mutationObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.type === 'attributes' && m.attributeName === 'data-theme') {
            this.updateTheme()
            break
          }
        }
      })
      this.mutationObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
      })
    }
  }

  public destroy(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect()
      this.resizeObserver = null
    }
    if (this.mutationObserver) {
      this.mutationObserver.disconnect()
      this.mutationObserver = null
    }
    this.renderer.dispose()
    this.canvas.remove()
  }
}
