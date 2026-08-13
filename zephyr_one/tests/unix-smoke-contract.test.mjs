import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const smoke = fs.readFileSync(path.join(ROOT, 'scripts', 'smoke-core.sh'), 'utf8');

test('packaged Unix smoke binds UI-ready to the exact bundled Node descendant', () => {
  const packaged = smoke.slice(
    smoke.indexOf('smoke_packaged_shell()'),
    smoke.indexOf('if [ "$MODE" = "--packaged-shell" ]'),
  );

  assert.match(smoke, /descendant_pids "\$SHELL_PID"/);
  assert.match(smoke, /for child_pid in \$\(pgrep -P "\$1"/);
  assert.match(smoke, /Linux\) readlink "\/proc\/\$1\/exe"/);
  assert.match(smoke, /Darwin\) \/usr\/sbin\/lsof -a -p "\$1" -d txt -Fn/);
  assert.match(smoke, /if \[ "\$candidate_executable" = "\$expected_node" \]/);
  assert.match(smoke, /multiple exact bundled Node children/);
  assert.match(packaged, /--core-pid "\$PACKAGED_CORE_PID"/);
  assert.match(packaged, /bundled Node child PID changed/);
  assert.match(packaged, /left the shell process tree/);
  assert.doesNotMatch(packaged, /pgrep[^\n]*(?:node|Node)/);
  assert.doesNotMatch(packaged, /ps[^\n]*(?:grep|awk)[^\n]*(?:node|Node)/);
});

test('non-packaged core smoke keeps its direct child PID behavior', () => {
  const core = smoke.slice(smoke.indexOf('PORT="${ZEPHYR_ONE_SMOKE_PORT:-3921}"'));

  assert.match(core, /node server\.js >"\$LOG" 2>&1 &\s+CORE_PID=\$!/);
  assert.doesNotMatch(core, /PACKAGED_CORE_PID|--core-pid|capture_bundled_node_pid/);
});

test('packaged Unix smoke owns and drains a dedicated process group before cleanup', () => {
  assert.match(smoke, /subprocess\.Popen\(sys\.argv\[1:\], start_new_session=True\)/);
  assert.match(smoke, /os\.killpg\(child\.pid, signum\)/);
  assert.match(smoke, /signal\.alarm\(4\)[\s\S]*signal_group\(signal\.SIGKILL\)/);
  assert.match(smoke, /return_code = child\.wait\(\)[\s\S]*signal_group\(signal\.SIGKILL\)[\s\S]*os\.killpg\(child\.pid, 0\)/);
  assert.match(smoke, /kill -TERM "\$SHELL_PID"[\s\S]*wait "\$SHELL_PID"/);
  assert.match(smoke, /while \[ "\$attempts" -lt 10 \]; do\s+rm -rf -- "\$RUN_DIR"/);
  assert.match(smoke, /remove_run_dir \|\| \{ \[ "\$status" -ne 0 \] \|\| status=1; \}/);
});
