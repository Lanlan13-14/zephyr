/**
 * System unlock helpers — OS only, no app password.
 * Setting "启动时要求系统解锁" defaults to OFF in main shell storage.
 */

export async function unlockViaNative(invoke, reason) {
  return invoke('auth_unlock', { reason });
}

export async function queryCapabilities(invoke) {
  return invoke('auth_capabilities');
}
