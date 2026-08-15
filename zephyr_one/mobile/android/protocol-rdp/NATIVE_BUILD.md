# Android FreeRDP native build

`AndroidRdpEngine` loads `libzephyr_rdp_android.so`. The Gradle module only
enables its CMake target when either of these is set:

- Gradle property `zephyr.rdp.freerdpAndroidRoot`
- environment variable `ZEPHYR_ANDROID_FREERDP_ROOT`

The value is a directory containing one patched FreeRDP 3.30.0 static install
per Android ABI:

```text
<root>/arm64-v8a/
  .zephyr-freerdp-tag
  include/freerdp3/...
  include/winpr3/...
  lib/libfreerdp-client3.a
  lib/libfreerdp3.a
  lib/libwinpr3.a
  lib/libremdesk-common.a
  lib/librdpsnd-common.a
  lib/libssl.a
  lib/libcrypto.a
  lib/libcjson.a
```

The stamp must contain exactly:

```text
3.30.0+cliprdr-reassembly-limit-v1
```

Build every requested ABI with the Android NDK and the same pinned source and
clipboard reassembly patch used by `zephyr_one/native/freerdp-core`. Desktop
`.lib` or host `.a` files are not compatible and CMake deliberately rejects a
missing Android archive. Android zlib is linked from the NDK.

Android never exports `HOME`. FreeRDP 3.30 `freerdp_settings_new` fails
closed when `GetKnownPath(KNOWN_PATH_HOME)` is NULL, so the engine must
`setenv("HOME", filesDir)` before the first `create()`. Official aFreeRDP
does the same in `LibFreeRDP.freerdp_new`.

The current C shim cannot yet implement two mobile contracts:

- Certificate review: it exposes only a fingerprint log event, not certificate
  DER, subject, issuer, validity, or a paused trust decision. The Kotlin
  engine therefore connects with verification on, captures the fingerprint,
  prompts, and retries with `ignore_certificate` only after the user accepts
  or a stored fingerprint matches.
- SAF drive redirection: FreeRDP expects a POSIX directory path. A persisted
  Android document-tree URI needs a filesystem provider, not a fake path.

Until a filesystem provider exists, JNI rejects drive-enabled connect
requests.
