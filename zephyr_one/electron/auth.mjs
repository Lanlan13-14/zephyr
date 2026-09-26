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
  if (code === 2 || name === 'NotAvailable') {
    /* No device authentication configured, or no provider could satisfy the
     * call shape (0x80070490). Honest unavailable: the switch must stay off. */
    return { ok: false, error: '此设备尚未设置系统解锁（密码 / PIN / Windows Hello），无法启用该开关。请先在 Windows 设置中配置后再试。' };
  }
  return { ok: false, error: name || '系统解锁失败或已取消' };
}

/* Chromium's retry loop (kMaxPasswordRetries=3): after a failed attempt the
 * NEXT dialog shows the previous error inside it (dwAuthError relay). The
 * script accepts -PriorAuthError for that relay; the shell retries locally
 * so one transient provider hiccup does not fail the whole unlock. */
const WINDOWS_UNLOCK_MAX_ATTEMPTS = 3;

function priorAuthErrorFor(message) {
  const text = String(message || '');
  const match = text.match(/ErrorCode\s+(\d+)/);
  if (match) {
    const code = Number(match[1]);
    if (Number.isSafeInteger(code) && code > 0 && code < 0xffffffff) return code;
  }
  return 0;
}

async function runWindowsHelloOnce(encoded, { parentHwnd, priorAuthError }) {
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-STA',
    '-ExecutionPolicy', 'Bypass',
    '-File', WINDOWS_HELLO_SCRIPT,
    '-ReasonBase64', encoded,
  ];
  /* Parent HWND + prior error relay (Chromium cui.hwndParent + dwAuthError).
   * The script defaults both to 0, so only pass what the shell knows. */
  if (Number.isSafeInteger(parentHwnd) && parentHwnd > 0) {
    args.push('-ParentHwnd', String(parentHwnd));
  }
  if (Number.isSafeInteger(priorAuthError) && priorAuthError > 0) {
    args.push('-PriorAuthError', String(priorAuthError));
  }
  try {
    const { stdout } = await execFileAsync('powershell.exe', args, {
      windowsHide: true,
      timeout: 120000,
      windowsVerbatimArguments: false,
      /* powershell.exe inherits the OEM codepage (GBK on zh-CN) and its
       * stdout bytes would decode as mojibake; the script sets UTF-8 and
       * execFile decodes with the same encoding. */
      encoding: 'utf8',
    });
    return mapWindowsHello(0, stdout);
  } catch (error) {
    const code = Number(error?.code);
    if (Number.isInteger(code)) return mapWindowsHello(code, error.stdout);
    throw error;
  }
}

async function unlockWindows(reason, { parentHwnd } = {}) {
  if (!WINDOWS_HELLO_SCRIPT) {
    return { ok: false, error: '安装包缺少 Windows Hello 脚本，无法调用系统解锁。请重新安装或保持开关关闭。' };
  }
  const encoded = Buffer.from(String(reason || 'Unlock Zephyr One'), 'utf8').toString('base64');
  let priorAuthError = 0;
  let last = { ok: false, error: '系统解锁失败或已取消' };
  for (let attempt = 1; attempt <= WINDOWS_UNLOCK_MAX_ATTEMPTS; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      last = await runWindowsHelloOnce(encoded, { parentHwnd, priorAuthError });
    } catch (error) {
      /* Surface a readable cause instead of a raw spawn error; the raw message
       * is kept for the runtime log. */
      const raw = String(error?.message || '');
      if (raw.includes('ENOENT')) {
        return { ok: false, error: '找不到 powershell.exe，无法调用系统解锁。请检查系统环境后重试。' };
      }
      return { ok: false, error: raw || '系统解锁失败或已取消' };
    }
    if (last.ok) return last;
    /* Cancel and unavailable are verdicts, not transient failures: relaying
     * them into another dialog would nag the user for nothing. Only a
     * provider-side ErrorCode (exit 3 with an ErrorCode relay) retries, with
     * the code shown inside the next dialog like Chromium does. */
    const next = priorAuthErrorFor(last.error);
    if (!next || attempt >= WINDOWS_UNLOCK_MAX_ATTEMPTS) return last;
    priorAuthError = next;
  }
  return last;
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

export { unlockWindows };

export async function unlock(payload) {
  if (process.env.ZEPHYR_ONE_DEV_SYSTEM_UNLOCK_BYPASS === '1') {
    return { ok: true, method: 'dev-system-unlock-bypass' };
  }
  const reason = unlockReason(payload);
  if (process.platform === 'win32') return unlockWindows(reason);
  if (process.platform === 'darwin') return unlockMacos(reason);
  return { ok: false, error: 'Linux 当前不支持系统解锁，请保持开关关闭' };
}
