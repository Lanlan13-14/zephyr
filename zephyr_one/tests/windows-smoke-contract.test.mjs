import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ROOT, '..');

describe('Windows install smoke harness', () => {
  it('proves readiness only for the captured installed runtime tree', () => {
    const smoke = fs.readFileSync(path.join(ROOT, 'scripts', 'windows-install-smoke.ps1'), 'utf8');
    assert.match(smoke, /healthz/);
    assert.match(smoke, /HoldSec|ReadyTimeoutSec/);
    assert.match(smoke, /diagnostics-\{0\}\.txt/);
    assert.match(smoke, /Get-CapturedProcessTree/);
    assert.match(smoke, /ExpectedNode/);
    assert.match(smoke, /ExpectedServer/);
    assert.match(smoke, /Get-CimInstance Win32_Process/);
    assert.match(smoke, /ParentProcessId/);
    assert.match(smoke, /\$knownCandidates = @\(@\([\s\S]*Where-Object/);
    assert.match(smoke, /\$response\.StatusCode -eq 200/);
    assert.match(smoke, /\$body\.ok -eq \$true/);
    assert.match(smoke, /\$body\.instanceId/);
    assert.match(smoke, /Get-RedirectLocation/);
    assert.match(smoke, /---- autostart log ----/);
    assert.match(smoke, /zephyr-autostart\.log/);
    assert.match(smoke, /zephyr-one-recovery/); // '/' must serve the loop-breaking recovery doc
    assert.match(smoke, /appLocation -ne '\/'/);
    assert.match(smoke, /zephyr-one-embed\.css/);
    assert.match(smoke, /Content -notmatch 'Zephyr One'/);
    assert.doesNotMatch(smoke, /Get-Process -Name "zephyr-one","node"/);
    assert.doesNotMatch(smoke, /Get-Process -Name "node","zephyr-one"/);
    assert.doesNotMatch(smoke, /Get-ChildItem -Path \$env:APPDATA,\$env:LOCALAPPDATA -Recurse/);
  });

  it('wires smoke + cargo path tests into the Windows CI job', () => {
    const workflow = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'zephyr-one.yml'), 'utf8');
    assert.match(workflow, /windows-install-smoke\.ps1/);
    assert.match(workflow, /Cargo test Windows path helpers/);
    assert.match(workflow, /name: windows-install-smoke/);
    assert.match(workflow, /build-windows:/);
  });

  it('keeps Windows verbatim path stripping in the runtime', () => {
    const runtime = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'runtime', 'mod.rs'), 'utf8');
    const lib = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'lib.rs'), 'utf8');
    assert.match(runtime, /fn node_compatible_path/);
    assert.match(runtime, /strip_prefix\(r"\\\\\?\\"/);
    assert.match(runtime, /windows_verbatim_paths_are_safe_for_node/);
    assert.match(runtime, /EISDIR|verbatim/);
    assert.match(lib, /cfg!\(target_os = "windows"\).*cfg!\(debug_assertions\)/);
    assert.match(lib, /if autostart \{\s*runtime::spawn_autostart\(app\.handle\(\)\.clone\(\)\);\s*\}/);
    assert.doesNotMatch(lib, /RunEvent::Ready/);
    assert.match(runtime, /windows_release_autostarts_without_a_webview/);
    assert.match(runtime, /std::fs::create_dir_all\(&data_dir\)/);
  });

  it('starts the bundled Node runtime directly on every desktop platform', () => {
    const main = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'main.rs'), 'utf8');
    const lib = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'lib.rs'), 'utf8');
    const runtime = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'runtime', 'mod.rs'), 'utf8');
    const childJob = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'runtime', 'windows_child_job.rs'), 'utf8');

    assert.match(main, /fn main\(\)\s*\{\s*zephyr_one_lib::run\(\);\s*\}/);
    assert.doesNotMatch(main, /runtime_launcher/);
    assert.doesNotMatch(lib, /windows_runtime_launcher/);
    assert.match(runtime, /let mut command = Command::new\(&node\)/);
    assert.match(runtime, /command\.arg\(core\.join\("server\.js"\)\)/);
    assert.match(runtime, /\.current_dir\(&core\)/);
    assert.match(runtime, /\.env\("ZEPHYR_DATA_DIR", &data_dir\)/);
    assert.match(runtime, /\.env\(STARTUP_CHALLENGE_ENV, &startup_challenge_encoded\)/);
    assert.match(runtime, /\.env\("ZEPHYR_ONE_SHELL_SECRET", shell_secret\)/);
    assert.match(runtime, /\.env\("ZEPHYR_ONE_SHELL_INSTANCE", shell_instance\)/);
    assert.match(runtime, /\.env_remove\("NODE_OPTIONS"\)/);
    assert.match(runtime, /\.env_remove\("NODE_PATH"\)/);
    assert.match(runtime, /if cfg!\(debug_assertions\) \{[\s\S]*ZEPHYR_NODE_PATH/);
    assert.match(runtime, /if cfg!\(debug_assertions\) \{[\s\S]*which_node\(\)/);
    assert.match(runtime, /CREATE_NO_WINDOW/);
    assert.match(runtime, /\.stdout\(Stdio::piped\(\)\)/);
    assert.match(runtime, /\.stderr\(Stdio::piped\(\)\)/);
    assert.match(runtime, /ChildJob::assign\(&child\)/);
    assert.match(runtime, /embedded Node cannot enter its Windows cleanup job/);
    assert.match(childJob, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
    assert.match(childJob, /AssignProcessToJobObject/);
    assert.doesNotMatch(runtime, /launcher_auth|windows_runtime_launcher::FLAG/);
    assert.doesNotMatch(runtime, /ALLOW_DEFAULT_PASSWORD_REMOTE_LOGIN/);
  });

  it('propagates the full static RDP closure to Windows bins and the lib test harness', () => {
    const build = fs.readFileSync(path.join(ROOT, 'src-tauri', 'build.rs'), 'utf8');
    const workflow = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'zephyr-one.yml'), 'utf8');
    assert.match(build, /probe\(&FREERDP3_PACKAGES, !windows\)/);
    assert.match(build, /cargo:rerun-if-env-changed=STATIC_VCRUNTIME/);
    assert.match(build, /emit_windows_target_link_closure\(&linked_libraries\)/);
    assert.match(build, /cargo:rustc-link-arg=/);
    assert.doesNotMatch(build, /cargo:rustc-link-arg-(?:bin|bins|test|tests)=/);
    assert.match(build, /for file in &library\.link_files \{\s+if is_msvc_crt_link_file\(file\) \{\s+continue;/);
    assert.match(build, /for name in &library\.libs/);
    assert.match(build, /if is_msvc_crt_link_name\(name\) \{\s+continue;/);
    assert.match(build, /fn is_msvc_crt_link_file\(path: &Path\)/);
    assert.match(build, /\.is_some_and\(is_msvc_crt_link_name\)/);
    assert.match(build, /"msvcrt"[\s\S]*"ucrt"[\s\S]*"vcruntime"/);
    assert.match(build, /directory\.join\(&filename\)/);
    assert.match(build, /is_freerdp2_link_name\(name\)/);
    assert.match(workflow, /build-windows:[\s\S]*STATIC_VCRUNTIME: 'false'/);
    assert.match(workflow, /VCPKG_DEFAULT_TRIPLET=x64-windows-static-md/);
  });
});
