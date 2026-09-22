/**
 * OS unlock for Zephyr One. Same product rule as the old Tauri shell:
 * Windows Hello / macOS LocalAuthentication only; Linux reports unavailable.
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const WINDOWS_HELLO_SCRIPT = path.join(here, 'windows-hello.ps1');

export function unlockReason(payload, fallback = '解锁 Zephyr One') {
  if (payload == null || payload === '') return fallback;
  if (typeof payload === 'string') return payload;
  if (typeof payload === 'object' && payload.reason != null && payload.reason !== '') {
    return String(payload.reason);
  }
  return fallback;
}

export function capabilities() {
  if (process.platform === 'darwin') {
    return {
      available: true,
      biometry: true,
      reason: 'macOS LocalAuthentication（Touch ID / 密码）',
    };
  }
  if (process.platform === 'win32') {
    return {
      available: true,
      biometry: true,
      reason: 'Windows Hello / 设备 PIN',
    };
  }
  return {
    available: false,
    biometry: false,
    reason: 'Linux 无统一系统解锁 API',
  };
}

function mapWindowsHello(code, stdout) {
  const name = String(stdout || '').trim() || String(code);
  if (code === 0 || name === 'Verified') {
    return { ok: true, method: 'windows_hello' };
  }
  if (code === 1 || name === 'Canceled' || name === 'RetriesExhausted') {
    return { ok: false, error: '系统解锁失败或已取消' };
  }
  if (name === 'NotConfiguredForUser') {
    return { ok: false, error: '未配置 Windows Hello / 设备 PIN。请在系统设置中添加指纹、面容或 PIN，或保持此开关关闭。' };
  }
  if (name === 'DeviceNotPresent') {
    return { ok: false, error: '此设备没有可用的 Windows Hello 硬件。请保持此开关关闭。' };
  }
  if (name === 'DisabledByPolicy') {
    return { ok: false, error: 'Windows Hello 已被策略禁用。请保持此开关关闭。' };
  }
  if (name === 'DeviceBusy') {
    return { ok: false, error: 'Windows Hello 正忙，请稍后重试。' };
  }
  if (code === 2) {
    return { ok: false, error: 'Windows Hello 不可用。请在系统中配置指纹/面容/PIN，或保持此开关关闭。' };
  }
  return { ok: false, error: name || '系统解锁失败或已取消' };
}

async function unlockWindows(reason) {
  const encoded = Buffer.from(String(reason || 'Unlock Zephyr One'), 'utf8').toString('base64');
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-STA',
        '-ExecutionPolicy', 'Bypass',
        '-File', WINDOWS_HELLO_SCRIPT,
        '-ReasonBase64', encoded,
      ],
      { windowsHide: true, timeout: 120000, windowsVerbatimArguments: false },
    );
    return mapWindowsHello(0, stdout);
  } catch (error) {
    const code = Number(error?.code);
    if (Number.isInteger(code)) return mapWindowsHello(code, error.stdout);
    return { ok: false, error: error.message || '系统解锁失败或已取消' };
  }
}

async function unlockMacos(reason) {
  const message = JSON.stringify(String(reason || '解锁 Zephyr One'));
  const script = `
ObjC.import('LocalAuthentication');
const context = $.LAContext.alloc.init;
const error = Ref();
const policy = $.LAPolicyDeviceOwnerAuthentication;
let can = false;
try {
  can = context.canEvaluatePolicyError(policy, error);
} catch (e) {
  can = true;
}
if (!can) {
  console.log('unavailable');
} else {
  const sema = $.dispatch_semaphore_create(0);
  let verdict = 'failed';
  context.evaluatePolicyLocalizedReasonReply(policy, ${message}, (success, err) => {
    verdict = success ? 'ok' : 'failed';
    $.dispatch_semaphore_signal(sema);
  });
  $.dispatch_semaphore_wait(sema, $.DISPATCH_TIME_FOREVER);
  console.log(verdict);
}
`;
  try {
    const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', script], {
      timeout: 120000,
    });
    const text = String(stdout || '').trim();
    if (text.endsWith('ok')) return { ok: true, method: 'localauthentication' };
    if (text.includes('unavailable')) {
      return { ok: false, error: '系统解锁不可用。请关闭「启动时要求系统解锁」，或在系统中配置指纹/面容/锁屏密码。' };
    }
    return { ok: false, error: '系统解锁失败或已取消' };
  } catch (error) {
    return { ok: false, error: error.message || '系统解锁失败或已取消' };
  }
}

export async function unlock(payload) {
  if (process.env.ZEPHYR_ONE_DEV_SYSTEM_UNLOCK_BYPASS === '1') {
    return { ok: true, method: 'dev-system-unlock-bypass' };
  }
  const reason = unlockReason(payload);
  if (process.platform === 'win32') return unlockWindows(reason);
  if (process.platform === 'darwin') return unlockMacos(reason);
  return { ok: false, error: 'Linux 当前不支持系统解锁，请保持开关关闭' };
}
