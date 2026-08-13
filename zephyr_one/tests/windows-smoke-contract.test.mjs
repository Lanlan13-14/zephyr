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
    assert.match(lib, /RunEvent::Ready/);
    assert.match(runtime, /windows_release_autostarts_without_a_webview/);
    assert.match(runtime, /#\[cfg\(not\(target_os = "windows"\)\)\]\s*std::fs::create_dir_all\(&data_dir\)/);
  });

  it('uses an authenticated fail-closed launcher before Tauri starts', () => {
    const main = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'main.rs'), 'utf8');
    const runtime = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'runtime', 'mod.rs'), 'utf8');
    const launcher = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'windows_runtime_launcher.rs'), 'utf8');

    assert.match(main, /try_run_windows_runtime_launcher[\s\S]*zephyr_one_lib::run\(\)/);
    assert.match(launcher, /--zephyr-one-private-runtime-launcher-v2/);
    assert.match(launcher, /args\.len\(\) != 3/);
    assert.match(launcher, /verify_same_executable_parent/);
    assert.match(launcher, /GetNamedPipeClientProcessId/);
    assert.match(launcher, /client_pid != child\.id\(\)/);
    assert.match(launcher, /GetNamedPipeServerProcessId/);
    assert.match(launcher, /server_pid != parent_pid/);
    assert.match(launcher, /PIPE_REJECT_REMOTE_CLIENTS/);
    assert.match(launcher, /SetTokenInformation[\s\S]*TokenOwner/);
    assert.match(launcher, /query_token\(token\.0, TokenOwner\)/);
    assert.match(launcher, /O:\{sid_text\}D:P\(\{ace\};;;\{sid_text\}\)/);
    assert.match(launcher, /SE_DACL_PROTECTED/);
    assert.match(launcher, /AceCount != 1/);
    assert.match(launcher, /hold_resource_tree/);
    assert.match(launcher, /hold_path\(&resources, true, false\)/);
    assert.match(launcher, /hold_path\(&child, false, false\)/);
    assert.doesNotMatch(launcher, /FILE_SHARE_DELETE/);
    assert.match(launcher, /FILE_FLAG_OPEN_REPARSE_POINT/);
    assert.match(launcher, /hold_directory_chain/);
    assert.match(launcher, /verify_held_paths/);
    assert.match(launcher, /create_or_normalize_private_path\(&data_dir, true/);
    assert.match(launcher, /normalize_existing_data_tree/);
    assert.match(launcher, /nNumberOfLinks != 1/);
    assert.match(launcher, /\.env_clear\(\)/);
    assert.match(launcher, /\.env\("ZEPHYR_DATA_DIR", &data_dir\)/);
    assert.doesNotMatch(launcher, /env_remove\("NODE_OPTIONS"\)/);
    assert.match(launcher, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
    assert.match(launcher, /AssignProcessToJobObject/);
    assert.match(launcher, /WaitForMultipleObjects\(&\[parent, child_handle\]/);
    assert.match(launcher, /TerminateJobObject/);
    assert.doesNotMatch(launcher, /std::mem::forget\(job\)/);
    assert.match(runtime, /#\[cfg\(target_os = "windows"\)\]\s*let mut cmd = \{[\s\S]{0,500}windows_runtime_launcher::FLAG/);
    assert.match(runtime, /launcher_auth\.authenticate_and_send/);
    assert.doesNotMatch(runtime, /ALLOW_DEFAULT_PASSWORD_REMOTE_LOGIN/);
  });

  it('propagates the full static RDP closure to the Windows application bin', () => {
    const build = fs.readFileSync(path.join(ROOT, 'src-tauri', 'build.rs'), 'utf8');
    assert.match(build, /emit_windows_bin_link_closure\(&linked_libraries\)/);
    assert.match(build, /cargo:rustc-link-arg-bin=zephyr-one=/);
    assert.match(build, /for name in &library\.libs/);
    assert.match(build, /directory\.join\(&filename\)/);
    assert.match(build, /is_freerdp2_link_name\(name\)/);
  });
});
