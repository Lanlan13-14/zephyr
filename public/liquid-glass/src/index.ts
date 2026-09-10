// public/liquid-glass/src/index.ts
// Export complete Liquid Glass WebGL engine + Zephyr DOM integration runtime

export * from './renderer/index'
export * from './shapes/continuous-corners'
export * from './renderer/continuous-curve'
export * from './renderer/spring'
export * from './renderer/velocity-tracker'
export * from './zephyr-liquid-glass'
export * from './zephyr-liquid-tabs'

import { initZephyrLiquidGlass, ZephyrLiquidGlass } from './zephyr-liquid-glass'
import { ZephyrLiquidTabs } from './zephyr-liquid-tabs'

// Auto-bind LiquidBottomTabs to Zephyr navigation bars
export function initZephyrNavigationLiquidTabs(): { navTabs?: ZephyrLiquidTabs; settingsTabs?: ZephyrLiquidTabs } {
  if (typeof window === 'undefined' || typeof document === 'undefined') return {}

  const result: { navTabs?: ZephyrLiquidTabs; settingsTabs?: ZephyrLiquidTabs } = {}

  // 1. Top Navigation Bar (.main-nav .nav-tabs)
  const navContainer = document.querySelector<HTMLElement>('.main-nav .nav-tabs')
  if (navContainer) {
    const getNavButtons = () => Array.from(navContainer.querySelectorAll<HTMLButtonElement>('.nav-tab:not(.force-hidden)'))
    const createNavTabs = () => {
      const buttons = getNavButtons()
      return buttons.map((b) => ({
        id: b.id || `nav-tab-${b.dataset.view}`,
        label: b.textContent?.trim() || b.dataset.view || '',
        key: b.dataset.view || '',
      }))
    }

    const buttons = getNavButtons()
    if (buttons.length > 0) {
      const activeIdx = Math.max(0, buttons.findIndex((b) => b.classList.contains('active')))
      const liquidNavTabs = new ZephyrLiquidTabs({
        groupId: 'zephyr-nav-tabs',
        container: navContainer,
        tabs: createNavTabs(),
        selectedIndex: activeIdx,
        height: 44,
        onSelect: (idx, tab) => {
          const btns = getNavButtons()
          if (btns[idx]) {
            btns[idx].click()
          }
        },
      })
      result.navTabs = liquidNavTabs
      ;(window as any).__zephyrNavLiquidTabs = liquidNavTabs

      // Watch for active tab changes from Zephyr internal routing (switchView / url hash)
      const observer = new MutationObserver(() => {
        const btns = getNavButtons()
        const currentActive = Math.max(0, btns.findIndex((b) => b.classList.contains('active')))
        if (currentActive !== liquidNavTabs.selectedIndex) {
          liquidNavTabs.setSelectedIndex(currentActive)
        }
      })
      observer.observe(navContainer, { attributes: true, subtree: true, attributeFilter: ['class'] })
    }
  }

  // 2. Settings Menu Navigation (.settings-menu)
  const settingsContainer = document.querySelector<HTMLElement>('.settings-menu')
  if (settingsContainer) {
    const getSettingsButtons = () => Array.from(settingsContainer.querySelectorAll<HTMLButtonElement>('.settings-tab:not(.force-hidden)'))
    const createSettingsTabs = () => {
      const buttons = getSettingsButtons()
      return buttons.map((b) => ({
        id: b.id || `settings-tab-${b.dataset.settings}`,
        label: b.textContent?.trim() || b.dataset.settings || '',
        key: b.dataset.settings || '',
      }))
    }

    const buttons = getSettingsButtons()
    if (buttons.length > 0) {
      const activeIdx = Math.max(0, buttons.findIndex((b) => b.classList.contains('active')))
      const liquidSettingsTabs = new ZephyrLiquidTabs({
        groupId: 'zephyr-settings-tabs',
        container: settingsContainer,
        tabs: createSettingsTabs(),
        selectedIndex: activeIdx,
        height: 44,
        onSelect: (idx, tab) => {
          const btns = getSettingsButtons()
          if (btns[idx]) {
            btns[idx].click()
          }
        },
      })
      result.settingsTabs = liquidSettingsTabs
      ;(window as any).__zephyrSettingsLiquidTabs = liquidSettingsTabs

      const observer = new MutationObserver(() => {
        const btns = getSettingsButtons()
        const currentActive = Math.max(0, btns.findIndex((b) => b.classList.contains('active')))
        if (currentActive !== liquidSettingsTabs.selectedIndex) {
          liquidSettingsTabs.setSelectedIndex(currentActive)
        }
      })
      observer.observe(settingsContainer, { attributes: true, subtree: true, attributeFilter: ['class'] })
    }
  }

  return result
}

// Expose globally on window for easy access from app.js and other scripts
if (typeof window !== 'undefined') {
  ;(window as any).ZephyrLiquidGlass = ZephyrLiquidGlass
  ;(window as any).initZephyrLiquidGlass = initZephyrLiquidGlass
  ;(window as any).ZephyrLiquidTabs = ZephyrLiquidTabs
  ;(window as any).initZephyrNavigationLiquidTabs = initZephyrNavigationLiquidTabs

  const setupAll = () => {
    initZephyrLiquidGlass()
    initZephyrNavigationLiquidTabs()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupAll)
  } else {
    setupAll()
  }
}
