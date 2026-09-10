// public/liquid-glass/src/index.ts
// Export complete Liquid Glass WebGL engine + Zephyr DOM integration runtime

export * from './renderer/index'
export * from './shapes/continuous-corners'
export * from './renderer/continuous-curve'
export * from './renderer/spring'
export * from './renderer/velocity-tracker'
export * from './zephyr-liquid-glass'

import { initZephyrLiquidGlass, ZephyrLiquidGlass } from './zephyr-liquid-glass'

// Expose globally on window for easy access from app.js and other scripts
if (typeof window !== 'undefined') {
  ;(window as any).ZephyrLiquidGlass = ZephyrLiquidGlass
  ;(window as any).initZephyrLiquidGlass = initZephyrLiquidGlass

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initZephyrLiquidGlass()
    })
  } else {
    initZephyrLiquidGlass()
  }
}
