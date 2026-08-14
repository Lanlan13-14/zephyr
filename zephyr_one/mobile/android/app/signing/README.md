# Zephyr One Android pre-release signing

`zephyr-one-prerelease.p12` is the **stable** key every CI and local
`assembleDebug` / `assembleRelease` uses. It exists so two APKs built on
different machines can update each other.

This is **not** a Play Store upload key. The password is public because the
keystore is in the repository. Treat it as a shared sideload identity, not a
secret. A future store release must use a private upload key that never lands
in git.

| Field | Value |
| --- | --- |
| File | `zephyr-one-prerelease.p12` |
| Type | PKCS12 |
| Alias | `zephyr-one` |
| Store / key password | `zephyr-one-prerelease` |
| SHA-256 | `E1:AA:E3:16:75:50:8F:B9:F8:3F:24:83:6D:A2:B0:CB:49:5E:4C:71:57:2A:2F:3A:A9:10:46:B6:1C:AF:ED:8A` |

APKs signed with the previous per-runner debug key (`~/.android/debug.keystore`)
cannot be updated in place. Uninstall those builds once, then install a
keystore-signed APK. After that, later pre-releases overwrite normally.
