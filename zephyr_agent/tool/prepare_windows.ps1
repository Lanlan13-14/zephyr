param()

Copy-Item "platform_assets/windows/app_icon.ico" "windows/runner/resources/app_icon.ico" -Force

$rc = "windows/runner/Runner.rc"
(Get-Content $rc) `
  -replace 'zephyr_agent', 'Zephyr Agent' |
  Set-Content $rc
