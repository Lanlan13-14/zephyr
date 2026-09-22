param(
    [Parameter(Mandatory = $true)]
    [string]$ReasonBase64
)

# STA is required for UserConsentVerifier. Called with:
#   powershell.exe -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File this.ps1 -ReasonBase64 ...
# Exit codes:
#   0 verified
#   1 cancelled / retries exhausted
#   2 not available / not configured / disabled
#   3 other failure
# stdout: Verified | Canceled | NotConfiguredForUser | DeviceNotPresent | DisabledByPolicy | DeviceBusy | RetriesExhausted | error text

$ErrorActionPreference = 'Stop'
$reason = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($ReasonBase64))
if ([string]::IsNullOrWhiteSpace($reason)) { $reason = 'Unlock Zephyr One' }

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
    [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime] | Out-Null
    $availability = Await-WinRT ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync())
    $availabilityName = [string]$availability
    if ($availabilityName -ne 'Available') {
        Write-Output $availabilityName
        exit 2
    }
    $result = Await-WinRT ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync($reason))
    $name = [string]$result
    Write-Output $name
    if ($name -eq 'Verified') { exit 0 }
    if ($name -eq 'Canceled' -or $name -eq 'RetriesExhausted') { exit 1 }
    if ($name -eq 'DeviceNotPresent' -or $name -eq 'NotConfiguredForUser' -or $name -eq 'DisabledByPolicy' -or $name -eq 'DeviceBusy') { exit 2 }
    exit 3
} catch {
    Write-Output $_.Exception.Message
    exit 3
}
