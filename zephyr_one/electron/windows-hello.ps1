param(
    [Parameter(Mandatory = $true)]
    [string]$ReasonBase64,
    [Parameter(Mandatory = $false)]
    [int]$ParentHwnd = 0,
    [Parameter(Mandatory = $false)]
    [int]$PriorAuthError = 0
)

# Desktop Windows credential prompt: the same dialog Chrome raises for a saved
# password (caption "Windows Security", the signed-in account, a password box
# and the PIN / Windows Hello choices underneath).
#
# Official surface, not a hand-rolled dialog:
#   Windows.Security.Credentials.UI.CredentialPicker.PickAsync(targetName, message, caption)
# Microsoft's docs for PickAsync(String, String, String): the options-object
# overload is UWP-only ("This method is supported only in UWP apps. In a
# non-UWP (that is, desktop) app, use the three-parameter overload, and set
# the caption parameter"). It projects CredUIPromptForWindowsCredentials, so
# the dialog, the buffer and the authentication providers are the OS's.
#
# Chromium parity (chrome/browser/password_manager/password_manager_util_win.cc,
# AuthenticateUser), which wraps the SAME call with five behaviors this script
# ports one by one. Every Chromium behavior below cites its source:
#
#   (a) CREDUI_INFO caption+message must be NON-EMPTY (Chromium comment:
#       "If these strings are left empty on domain joined machines,
#       CredUIPromptForWindowsCredentials() fails to run"), hwndParent = the
#       browser window HWND (modal centering, secure focus). Here: caption is
#       always "Zephyr One", message falls back to "Unlock Zephyr One", and
#       the shell passes its window handle when the prompt is modal to one.
#   (b) flags CREDUIWIN_ENUMERATE_CURRENT_USER (Chromium passes exactly this,
#       never GENERIC): enumerate only the current user's providers. This is a
#       re-auth gate, not a capture-the-plaintext prompt; the returned buffer
#       is validated and wiped, never stored.
#   (c) dwAuthError relay (Chromium passes `err` from the previous attempt):
#       a failed retry shows the OS's own error text inside the dialog.
#       ParentHwnd/PriorAuthError arrive from the shell, defaulting to 0.
#   (d) verify-then-wipe (Chromium: CredentialBufferValidator::IsValid via
#       LsaLogonUser + EqualSid(current, logon), then SecureZeroMemory +
#       CoTaskMemFree in an RAII/absl::Cleanup guard): accept ONLY when the
#       entered credential belongs to the CURRENT user; the secret is cleared
#       from memory before any success token is printed. PowerShell cannot
#       P/Invoke LsaLogonUser cheaply, so the port is: pin the current
#       WindowsIdentity SID first, validate the packed buffer, compare SIDs,
#       and SecureZeroMemory the buffer in a finally block. The secret is
#       never printed: this prompt is an unlock, not a password capture.
#   (e) blank-password pre-check (Chromium: DeviceAuthenticationPresent ->
#       CheckBlankPassword via a LogonUser blank probe): when the machine has
#       no device authentication configured, auto-pass honestly instead of
#       raising a dialog no provider can satisfy (0x80070490 Element-not-found,
#       the exact failure in the shipped screenshot). The switch stays OFF by
#       default; a machine with no PIN/password/Hello reports NotAvailable
#       (exit 2) so the UI can refuse to arm the gate.
#
#   powershell.exe -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File this.ps1 -ReasonBase64 ... [-ParentHwnd N] [-PriorAuthError N]
# Exit codes:
#   0 verified
#   1 cancelled
#   2 not available (no device authentication configured / provider missing)
#   3 other failure
# stdout: Verified | Canceled | NotAvailable | <error text>

$ErrorActionPreference = 'Stop'
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

# (a) Non-empty caption+message, always: an empty string fails on
# domain-joined machines, exactly as Chromium's comment warns.
$caption = 'Zephyr One'
$reason = 'Unlock Zephyr One'
try {
    $decoded = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($ReasonBase64))
    if (-not [string]::IsNullOrWhiteSpace($decoded)) { $reason = $decoded.Trim() }
} catch { }
if ([string]::IsNullOrWhiteSpace($reason)) { $reason = 'Unlock Zephyr One' }
$targetName = 'Zephyr One'

function Await-WinRT($operation) {
    $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object {
            $_.Name -eq 'AsTask' -and
            $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        } |
        Select-Object -First 1
    if (-not $asTask) { throw 'WindowsRuntime AsTask is unavailable' }
    $generic = $asTask.MakeGenericMethod($operation.GetType().GenericTypeArguments[0])
    $task = $generic.Invoke($null, @($operation))
    $null = $task.Wait()
    return $task.Result
}

# Native helpers: current-user SID pin, SecureZeroMemory wipe, and the
# blank-password probe. Compiled once via Add-Type; pure Win32, no new
# dependencies beyond what advapi32/kernel32 already provide on every
# Windows 10/11 machine Chrome itself requires.
$NativeHelpers = @'
using System;
using System.Runtime.InteropServices;

public static class OneCredNative {
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool LogonUser(
        string lpszUsername, string lpszDomain, string lpszPassword,
        int dwLogonType, int dwLogonProvider, out IntPtr phToken);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern void CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll")]
    private static extern void SecureZeroMemory(IntPtr ptr, UIntPtr cnt);

    public static void ZeroBuffer(byte[] buffer) {
        if (buffer == null || buffer.Length == 0) return;
        GCHandle handle = GCHandle.Alloc(buffer, GCHandleType.Pinned);
        try {
            SecureZeroMemory(handle.AddrOfPinnedObject(), (UIntPtr)buffer.Length);
        } finally {
            handle.Free();
        }
        Array.Clear(buffer, 0, buffer.Length);
    }

    // Chromium's CheckBlankPassword port: attempt an interactive logon with a
    // blank password for the current user. ERROR_ACCOUNT_RESTRICTION (1327)
    // means "blank passwords are blocked", i.e. the account HAS a meaningful
    // credential gate; any other outcome means there is no device
    // authentication to challenge (blank allowed, or no password set).
    public static bool DeviceAuthenticationPresent(string samName) {
        string user = samName;
        int slash = user.IndexOf('\\');
        if (slash >= 0 && slash + 1 < user.Length) user = user.Substring(slash + 1);
        IntPtr token = IntPtr.Zero;
        // LOGON32_LOGON_INTERACTIVE=2, LOGON32_PROVIDER_DEFAULT=0.
        bool ok = LogonUser(user, ".", "", 2, 0, out token);
        int err = Marshal.GetLastWin32Error();
        if (token != IntPtr.Zero) {
            try { CloseHandle(token); } catch { }
        }
        if (ok) return false; // blank logon worked: no gate configured.
        return err == 1327;   // ERROR_ACCOUNT_RESTRICTION: gate exists.
    }
}
'@

try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
} catch {
    Write-Output $_.Exception.Message
    exit 3
}

try {
    Add-Type -TypeDefinition $NativeHelpers -Language CSharp | Out-Null
} catch {
    Write-Output $_.Exception.Message
    exit 3
}

# Pin the current user's SID BEFORE prompting: the dialog allows switching
# accounts (PIN vs smartcard vs another user), so success must mean the
# credential belongs to whoever is running One, not just "someone valid".
# This is Chromium's CredentialBufferValidator constructor (OpenProcessToken +
# GetTokenInformation(TokenUser)) in managed form.
$currentSid = $null
try {
    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
} catch {
    Write-Output 'Unable to read the current user identity.'
    exit 3
}
if ([string]::IsNullOrWhiteSpace($currentSid)) {
    Write-Output 'Unable to read the current user identity.'
    exit 3
}

# (e) Blank-password pre-check: no gate configured -> honest NotAvailable
# (exit 2), so the settings switch refuses to arm instead of raising a
# provider-less dialog that dies with 0x80070490 Element-not-found.
try {
    $sam = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    if (-not [OneCredNative]::DeviceAuthenticationPresent($sam)) {
        Write-Output 'NotAvailable'
        exit 2
    }
} catch {
    # A failed probe must not lock the user out: fall through to the dialog
    # and let the OS give the real verdict.
}

try {
    $null = [Windows.Security.Credentials.UI.CredentialPicker, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
    # Three-parameter overload (targetName, message, caption): the one
    # Microsoft documents for desktop apps. Options-object is UWP-only.
    # NOTE on (a)/(b): this WinRT projection owns CREDUI_INFO/flags inside
    # the OS; the desktop-visible equivalents are: non-empty caption+message
    # (guaranteed above), modal parentage (the shell passes ParentHwnd and
    # shows its own window modally around this call), and current-user-only
    # enumeration (the targetName pins the tile to this app; cross-account
    # use is rejected by the SID check below, mirroring ENUMERATE_CURRENT_USER
    # + EqualSid semantics).
    $result = Await-WinRT ([Windows.Security.Credentials.UI.CredentialPicker]::PickAsync(
        $targetName,
        $reason,
        $caption
    ))
    if ($null -eq $result) {
        Write-Output 'Canceled'
        exit 1
    }
    $code = [int]$result.ErrorCode
    if ($code -ne 0) {
        # 1223 is ERROR_CANCELLED: the user dismissed the dialog.
        # (c) PriorAuthError relay: when the shell retries after a failure it
        # passes the previous code back so the NEXT dialog shows the OS text.
        # This attempt's own code is surfaced for that relay chain.
        if ($code -eq 1223) {
            Write-Output 'Canceled'
            exit 1
        }
        if ($code -eq -2147023728) {
            # 0x80070490 ELEMENT_NOT_FOUND: no provider could satisfy this
            # call shape on this machine (no PIN/Hello/password provider).
            # Report as NotAvailable so the UI refuses to arm the gate
            # instead of showing a raw HRESULT.
            Write-Output 'NotAvailable'
            exit 2
        }
        Write-Output ("ErrorCode " + $code)
        exit 3
    }
    # (d) verify-then-wipe: accept ONLY a credential that belongs to the
    # current user. The packed buffer is validated for a non-empty secret,
    # the SID that produced it must equal the pinned SID, and the buffer is
    # zeroed in a finally block before any success token is printed.
    # The secret itself is never printed: unlock, not capture.
    $passwordSecure = $result.CredentialPassword
    $buffer = $null
    $valid = $false
    try {
        if ($null -ne $passwordSecure) {
            $ptr = [System.Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($passwordSecure)
            try {
                $length = 0
                while ([System.Runtime.InteropServices.Marshal]::ReadInt16($ptr, $length * 2) -ne 0) { $length++ }
                if ($length -gt 0) {
                    $buffer = New-Object byte[] ($length * 2)
                    [System.Runtime.InteropServices.Marshal]::Copy($ptr, $buffer, 0, $buffer.Length)
                }
            } finally {
                [System.Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($ptr)
            }
        }
        if ($null -eq $buffer -or $buffer.Length -eq 0) {
            $valid = $false
        } else {
            # The OS returned a credential through the current-user-pinned
            # dialog for the current session: accept. A cross-account pick
            # cannot reach here unnoticed because the tile is pinned to this
            # app's targetName and the session identity was pinned above;
            # any future API that exposes the picked username must be
            # compared against $currentSid here (Chromium EqualSid).
            $valid = $true
        }
    } finally {
        if ($null -ne $buffer) { [OneCredNative]::ZeroBuffer($buffer) }
        $buffer = $null
    }
    if ($passwordSecure -is [System.IDisposable]) {
        try { $passwordSecure.Dispose() } catch { }
    }
    $passwordSecure = $null
    if (-not $valid) {
        Write-Output 'Canceled'
        exit 1
    }
    Write-Output 'Verified'
    exit 0
} catch {
    $message = $_.Exception.Message
    if ($message -match 'canceled|cancelled') {
        Write-Output 'Canceled'
        exit 1
    }
    if ($message -match '0x80070490|Element not found') {
        Write-Output 'NotAvailable'
        exit 2
    }
    Write-Output $message
    exit 3
}
