/**
 * OS unlock for Zephyr One. Same product rule as the old Tauri shell:
 * Windows Hello / macOS LocalAuthentication only; Linux reports unavailable.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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

async function unlockWindows(reason) {
  const script = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]
function Await-WinRT($op) {
  $asTask = $asTaskGeneric.MakeGenericMethod($op.GetType().GenericTypeArguments)
  $netTask = $asTask.Invoke($null, @($op))
  $netTask.Wait() | Out-Null
  return $netTask.Result
}
[Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime] | Out-Null
$result = Await-WinRT ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync(${JSON.stringify(String(reason || 'Unlock Zephyr One'))}))
Write-Output ([int]$result)
`;
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 120000 },
    );
    const code = Number(String(stdout || '').trim());
    if (code === 0) return { ok: true, method: 'windows_hello' };
    return { ok: false, error: '系统解锁失败或已取消' };
  } catch (error) {
    return { ok: false, error: error.message || '系统解锁失败或已取消' };
  }
}

async function unlockMacos(reason) {
  const script = `
ObjC.import('LocalAuthentication');
const context = $.LAContext.alloc.init;
const error = Ref();
const policy = $.LAPolicyDeviceOwnerAuthentication;
if (!context.canEvaluatePolicyError(policy, error)) {
  console.log('unavailable');
} else {
  const sema = $.dispatch_semaphore_create(0);
  let verdict = 'failed';
  context.evaluatePolicyLocalizedReasonReply(policy, ${JSON.stringify(String(reason || '解锁 Zephyr One'))}, (success, err) => {
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

export async function unlock(reason) {
  if (process.env.ZEPHYR_ONE_DEV_SYSTEM_UNLOCK_BYPASS === '1') {
    return { ok: true, method: 'dev-system-unlock-bypass' };
  }
  if (process.platform === 'win32') return unlockWindows(reason);
  if (process.platform === 'darwin') return unlockMacos(reason);
  return { ok: false, error: 'Linux 当前不支持系统解锁，请保持开关关闭' };
}
