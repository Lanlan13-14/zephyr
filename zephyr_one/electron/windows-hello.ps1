param(
    [Parameter(Mandatory = $true)]
    [string]$ReasonBase64
)

# Desktop Windows credential prompt, the same dialog Chrome raises for a saved
# password: caption "Windows Security", the signed-in account, a password box
# and the PIN / Windows Hello choices underneath.
#
# Official surface, not a hand-rolled dialog:
#   Windows.Security.Credentials.UI.CredentialPicker.PickAsync(caption, message, targetName)
# Microsoft documents the options-object overload as UWP-only: a desktop app
# must call this three-parameter overload. It projects
# CredUIPromptForWindowsCredentials, so the dialog, the buffer and the
# authentication providers are the OS's.
#
#   powershell.exe -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File this.ps1 -ReasonBase64 ...
# Exit codes:
#   0 verified
#   1 cancelled
#   2 not available
#   3 other failure
# stdout: Verified | Canceled | <error text>

$ErrorActionPreference = 'Stop'
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

$reason = 'Unlock Zephyr One'
try {
    $decoded = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($ReasonBase64))
    if (-not [string]::IsNullOrWhiteSpace($decoded)) { $reason = $decoded }
} catch { }

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

try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
} catch {
    Write-Output $_.Exception.Message
    exit 3
}

try {
    $null = [Windows.Security.Credentials.UI.CredentialPicker, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
    # Three-parameter overload: the one Microsoft documents for desktop apps.
    $result = Await-WinRT ([Windows.Security.Credentials.UI.CredentialPicker]::PickAsync(
        'Zephyr One',
        $reason,
        'Zephyr One'
    ))
    if ($null -eq $result) {
        Write-Output 'Canceled'
        exit 1
    }
    $code = [int]$result.ErrorCode
    if ($code -ne 0) {
        # 1223 is ERROR_CANCELLED: the user dismissed the dialog.
        if ($code -eq 1223) {
            Write-Output 'Canceled'
            exit 1
        }
        Write-Output ("ErrorCode " + $code)
        exit 3
    }
    # The OS verified the credential before returning it. The secret itself is
    # never printed: this prompt is an unlock, not a password capture.
    $password = $result.CredentialPassword
    if ([string]::IsNullOrEmpty($password)) {
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
    Write-Output $message
    exit 3
}
