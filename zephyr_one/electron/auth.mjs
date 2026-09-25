/**
 * OS unlock for Zephyr One. Same product rule as the old Tauri shell:
 * Windows Hello / macOS LocalAuthentication only; Linux reports unavailable.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

/* electron-builder packs the app into app.asar, but powershell.exe cannot
 * read inside an archive: -File must point at a real file on disk. The
 * script is therefore asarUnpack'ed; resolve the extracted copy when we are
 * running from an archive, and fall back to the source tree in dev. */
function resolveWindowsHelloScript() {
  const candidates = [];
  if (process.env.ZEPHYR_ONE_WINDOWS_HELLO_SCRIPT) {
    candidates.push(process.env.ZEPHYR_ONE_WINDOWS_HELLO_SCRIPT);
  }
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'electron', 'windows-hello.ps1'));
  }
  candidates.push(path.join(here, 'windows-hello.ps1'));
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* try next */ }
  }
  return null;
}
const WINDOWS_HELLO_SCRIPT = (() => { try { return resolveWindowsHelloScript(); } catch { return null; } })();

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
      reason: 'Windows 安全性凭据对话框（密码 / PIN / Windows Hello）',
    };
  }
  return {
    available: false,
    biometry: false,
    reason: 'Linux 无统一系统解锁 API',
  };
}

function mapWindowsHello(code, stdout) {
  /* The script's protocol tokens are ASCII, but a failure path can emit an
   * exception message in the console codepage. Strip a leading BOM, trim
   * control characters, and only accept known tokens verbatim; anything else
   * is surfaced as-is (it is already a readable cause after the UTF-8 fix). */
  const name = String(stdout || '').replace(/^\uFEFF/, '').replace(/[\x00-\x1f]+/g, ' ').trim() || String(code);
  if (code === 0 || name === 'Verified') {
    return { ok: true, method: 'windows_credential_picker' };
  }
  if (code === 1 || name === 'Canceled') {
    return { ok: false, error: '系统解锁失败或已取消' };
  }
  if (code === 2) {
    return { ok: false, error: '系统凭据对话框不可用。请保持此开关关闭。' };
  }
  return { ok: false, error: name || '系统解锁失败或已取消' };
}

async function unlockWindows(reason) {
  if (!WINDOWS_HELLO_SCRIPT) {
    return { ok: false, error: '安装包缺少 Windows Hello 脚本，无法调用系统解锁。请重新安装或保持开关关闭。' };
  }
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
      {
        windowsHide: true,
        timeout: 120000,
        windowsVerbatimArguments: false,
        /* powershell.exe inherits the OEM codepage (GBK on zh-CN) and its
         * stdout bytes would decode as mojibake; the script sets UTF-8 and
         * execFile decodes with the same encoding. */
        encoding: 'utf8',
      },
    );
    return mapWindowsHello(0, stdout);
  } catch (error) {
    const code = Number(error?.code);
    if (Number.isInteger(code)) return mapWindowsHello(code, error.stdout);
    /* Surface a readable cause instead of a raw spawn error; the raw message
     * is kept for the runtime log. */
    const raw = String(error?.message || '');
    if (raw.includes('ENOENT')) {
      return { ok: false, error: '找不到 powershell.exe，无法调用系统解锁。请检查系统环境后重试。' };
    }
    return { ok: false, error: raw || '系统解锁失败或已取消' };
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
