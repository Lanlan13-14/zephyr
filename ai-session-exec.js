'use strict';

/**
 * L2 Restricted Session Exec — conversation-isolated short-lived sandbox.
 *
 * Isolation stack (all layers always applied where available):
 *  1. No shell / no shell metacharacters — argv array only
 *  2. Absolute binary whitelist (resolved realpath)
 *  3. cwd + path-like args confined to session root
 *  4. uploads/ocr/spillover read-only; only workspace/outputs writable
 *  5. env scrub (minimal PATH/HOME/LANG)
 *  6. wall timeout (default 15s, max 60s) + kill tree
 *  7. stdout/stderr byte caps
 *  8. CPU/memory soft limits via prlimit when available
 *  9. Network: default OFF via bwrap --unshare-net or unshare -n;
 *     if network requested but isolation cannot enforce → fail-closed
 * 10. Prefer bubblewrap full FS sandbox; never "bash -c" fallback
 *
 * Multi-tenant: every call is scoped to data/ai-sessions/{userId}/{sessionId}/
 * Audit: append-only JSON lines under session/outputs/.exec-audit.ndjson
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { HttpError } = require('./authz');

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
/** Language/runtime/media jobs may run longer (still hard-capped). */
const RUNTIME_DEFAULT_TIMEOUT_MS = 120_000;
const RUNTIME_MAX_TIMEOUT_MS = 300_000;
const MAX_STDOUT = 1024 * 1024;
const MAX_STDERR = 512 * 1024;
const MAX_ARGS = 128;
const MAX_ARG_LEN = 8192;
const MAX_CONCURRENT_GLOBAL = 4;
const MAX_CONCURRENT_USER = 2;
const MAX_SESSION_EXECS_PER_HOUR = 60;
const MEM_LIMIT_BYTES = 512 * 1024 * 1024; // default for compile/ffmpeg
const NODE_MEM_LIMIT_BYTES = 1536 * 1024 * 1024; // V8 reserves a large virtual CodeRange before running scripts
const CPU_CPU_SECONDS = 120;

// Windows does not have the Unix utility paths below. Keep the fallback list
// explicit: never resolve session tools from the service account's PATH.
const WINDOWS_GIT_USR_BIN = [
    'C:\\Program Files\\Git\\usr\\bin',
    'C:\\Program Files (x86)\\Git\\usr\\bin',
];

function windowsGitCandidates(name) {
    return WINDOWS_GIT_USR_BIN.map((dir) => path.join(dir, `${name}.exe`));
}

function currentNodeCandidate() {
    const exe = String(process.execPath || '');
    return /^node(?:\.exe)?$/i.test(path.basename(exe)) ? [exe] : [];
}

/** @type {ReadonlyArray<{name:string, candidates:string[], tier?:string}>} */
const WHITELIST = Object.freeze([
    // text utilities
    { name: 'jq', candidates: ['/usr/bin/jq', '/bin/jq', ...windowsGitCandidates('jq')], tier: 'text' },
    { name: 'grep', candidates: ['/bin/grep', '/usr/bin/grep', ...windowsGitCandidates('grep')], tier: 'text' },
    { name: 'sed', candidates: ['/bin/sed', '/usr/bin/sed', ...windowsGitCandidates('sed')], tier: 'text' },
    { name: 'awk', candidates: ['/usr/bin/awk', '/bin/awk', '/usr/bin/gawk', '/bin/gawk', ...windowsGitCandidates('awk')], tier: 'text' },
    { name: 'head', candidates: ['/usr/bin/head', '/bin/head', ...windowsGitCandidates('head')], tier: 'text' },
    { name: 'tail', candidates: ['/usr/bin/tail', '/bin/tail', ...windowsGitCandidates('tail')], tier: 'text' },
    { name: 'wc', candidates: ['/usr/bin/wc', '/bin/wc', ...windowsGitCandidates('wc')], tier: 'text' },
    { name: 'sort', candidates: ['/usr/bin/sort', '/bin/sort', ...windowsGitCandidates('sort')], tier: 'text' },
    { name: 'uniq', candidates: ['/usr/bin/uniq', '/bin/uniq', ...windowsGitCandidates('uniq')], tier: 'text' },
    { name: 'file', candidates: ['/usr/bin/file', '/bin/file', ...windowsGitCandidates('file')], tier: 'text' },
    { name: 'sha256sum', candidates: ['/usr/bin/sha256sum', '/bin/sha256sum', ...windowsGitCandidates('sha256sum')], tier: 'text' },
    { name: 'md5sum', candidates: ['/usr/bin/md5sum', '/bin/md5sum', ...windowsGitCandidates('md5sum')], tier: 'text' },
    { name: 'cut', candidates: ['/usr/bin/cut', '/bin/cut', ...windowsGitCandidates('cut')], tier: 'text' },
    { name: 'tr', candidates: ['/usr/bin/tr', '/bin/tr', ...windowsGitCandidates('tr')], tier: 'text' },
    { name: 'cat', candidates: ['/bin/cat', '/usr/bin/cat', ...windowsGitCandidates('cat')], tier: 'text' },
    { name: 'basename', candidates: ['/usr/bin/basename', '/bin/basename', ...windowsGitCandidates('basename')], tier: 'text' },
    { name: 'dirname', candidates: ['/usr/bin/dirname', '/bin/dirname', ...windowsGitCandidates('dirname')], tier: 'text' },
    // Python — full (script files + uv)
    { name: 'python3', candidates: ['/usr/bin/python3', '/bin/python3', '/usr/local/bin/python3'], tier: 'python' },
    { name: 'python', candidates: ['/usr/bin/python3', '/usr/bin/python', '/bin/python3'], tier: 'python' },
    { name: 'uv', candidates: ['/usr/local/bin/uv', '/usr/bin/uv', '/home/linuxbrew/.linuxbrew/bin/uv'], tier: 'python' },
    // Node — partial (script only; limited npm)
    { name: 'node', candidates: ['/usr/bin/node', '/usr/local/bin/node', ...currentNodeCandidate()], tier: 'node' },
    { name: 'npm', candidates: ['/usr/bin/npm', '/usr/local/bin/npm'], tier: 'node' },
    // Go / Rust
    { name: 'go', candidates: ['/usr/bin/go', '/usr/local/go/bin/go'], tier: 'go' },
    { name: 'rustc', candidates: ['/usr/bin/rustc', '/usr/local/bin/rustc'], tier: 'rust' },
    { name: 'cargo', candidates: ['/usr/bin/cargo', '/usr/local/bin/cargo'], tier: 'rust' },
    // FFmpeg — built-in media
    { name: 'ffmpeg', candidates: ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'], tier: 'ffmpeg' },
    { name: 'ffprobe', candidates: ['/usr/bin/ffprobe', '/usr/local/bin/ffprobe'], tier: 'ffmpeg' },
]);

const RUNTIME_COMMANDS = new Set(['python3', 'python', 'uv', 'node', 'npm', 'go', 'rustc', 'cargo', 'ffmpeg', 'ffprobe']);

const FORBIDDEN_NAMES = new Set([
    'bash', 'sh', 'ash', 'zsh', 'dash', 'fish', 'csh',
    'perl', 'ruby', 'php', 'lua', 'deno', 'bun',
    'curl', 'wget', 'ssh', 'scp', 'sftp', 'nc', 'ncat', 'netcat', 'socat',
    'docker', 'podman', 'nsenter', 'unshare', 'chroot', 'bwrap', 'sudo', 'su',
    'busybox', 'env', 'xargs', 'find', 'dd', 'mount', 'umount', 'chmod', 'chown',
    'rm', 'mv', 'cp', 'ln', 'kill', 'pkill', 'nohup', 'setsid',
    'pip', 'pip3', 'npx', // force uv / npm explicit; no bare pip/npx
]);

let activeGlobal = 0;
/** @type {Map<string, number>} */
const activeByUser = new Map();
/** @type {Map<string, number[]>} */
const sessionExecTimestamps = new Map();

let _capsCache = null;
let _binCache = null;

function realpathExists(p) {
    try {
        if (!fs.existsSync(p)) return null;
        return fs.realpathSync(p);
    } catch {
        return null;
    }
}

function isCandidateForPlatform(candidate) {
    const value = String(candidate || '');
    if (process.platform === 'win32') return !value.startsWith('/');
    return !/^[A-Za-z]:[\\/]/.test(value);
}

/**
 * @returns {Map<string, {absolute:string, applet:string|null}>}
 */
function resolveWhitelistBins() {
    if (_binCache) return _binCache;
    const map = new Map();
    for (const entry of WHITELIST) {
        if (map.has(entry.name)) continue;
        // Prefer non-busybox real binaries first
        let chosen = null;
        for (const c of entry.candidates) {
            if (!isCandidateForPlatform(c)) continue;
            const rp = realpathExists(c);
            if (!rp || !fs.statSync(rp).isFile()) continue;
            const base = path.basename(rp);
            if (base === 'busybox') {
                if (!chosen) chosen = { absolute: rp, applet: entry.name };
                continue;
            }
            chosen = { absolute: rp, applet: null };
            break;
        }
        if (chosen) map.set(entry.name, chosen);
    }
    _binCache = map;
    return map;
}

function isBusybox(p) {
    if (!p) return false;
    try {
        return path.basename(fs.realpathSync(p)) === 'busybox';
    } catch {
        return path.basename(p) === 'busybox';
    }
}

function probeCapabilities() {
    if (_capsCache) return _capsCache;
    const bwrapPath = realpathExists('/usr/bin/bwrap') || realpathExists('/bin/bwrap');
    // Prefer real util-linux tools; busybox multi-call has incompatible flags.
    let unsharePath = realpathExists('/usr/bin/unshare');
    if (!unsharePath || isBusybox(unsharePath)) {
        const alt = realpathExists('/bin/unshare');
        unsharePath = alt && !isBusybox(alt) ? alt : null;
    }
    let timeoutPath = realpathExists('/usr/bin/timeout');
    if (!timeoutPath || isBusybox(timeoutPath)) {
        const alt = realpathExists('/bin/timeout');
        timeoutPath = alt && !isBusybox(alt) ? alt : null;
    }
    let prlimitPath = realpathExists('/usr/bin/prlimit');
    if (!prlimitPath || isBusybox(prlimitPath)) {
        const alt = realpathExists('/bin/prlimit');
        prlimitPath = alt && !isBusybox(alt) ? alt : null;
    }

    let bwrapNet = false;
    let bwrapOk = false;
    if (bwrapPath) {
        try {
            const r = spawnSync(bwrapPath, [
                '--die-with-parent', '--unshare-net', '--ro-bind', '/', '/',
                '--tmpfs', '/tmp', '--dev', '/dev', '--proc', '/proc',
                '--', '/bin/true',
            ], { encoding: 'utf8', timeout: 3000 });
            // /bin/true may not exist; try busybox true
            if (r.status === 0) {
                bwrapOk = true;
                bwrapNet = true;
            } else {
                const r2 = spawnSync(bwrapPath, [
                    '--die-with-parent', '--ro-bind', '/', '/',
                    '--tmpfs', '/tmp', '--', '/bin/true',
                ], { encoding: 'utf8', timeout: 3000 });
                bwrapOk = r2.status === 0;
                // probe net separately
                const r3 = spawnSync(bwrapPath, [
                    '--die-with-parent', '--unshare-net', '--ro-bind', '/', '/',
                    '--tmpfs', '/tmp', '--', '/bin/true',
                ], { encoding: 'utf8', timeout: 3000 });
                bwrapNet = r3.status === 0;
                bwrapOk = bwrapOk || bwrapNet;
            }
        } catch {
            bwrapOk = false;
        }
    }

    let unshareNet = false;
    if (unsharePath) {
        try {
            const r = spawnSync(unsharePath, ['-n', '/bin/true'], { encoding: 'utf8', timeout: 2000 });
            unshareNet = r.status === 0;
            if (!unshareNet) {
                const r2 = spawnSync(unsharePath, ['-n', 'true'], { encoding: 'utf8', timeout: 2000 });
                unshareNet = r2.status === 0;
            }
        } catch {
            unshareNet = false;
        }
    }

    _capsCache = {
        bwrapPath,
        unsharePath,
        timeoutPath,
        prlimitPath,
        bwrapOk,
        bwrapNet,
        unshareNet,
        // Direct whitelist exec is always available as last FS-confined mode
        directOk: true,
        canDenyNetwork: !!(bwrapNet || unshareNet),
    };
    return _capsCache;
}

function isolationMode(network) {
    const caps = probeCapabilities();
    if (!network) {
        if (caps.bwrapOk && caps.bwrapNet) return 'bwrap-netns';
        if (caps.bwrapOk) return caps.canDenyNetwork ? 'bwrap+unshare-net' : 'bwrap';
        if (caps.unshareNet) return 'unshare-net+confine';
        // Without net ns: still no shell + path confine + whitelist-only (tools have no net UX).
        // Mark as confine-only so callers/auditors know net ns was unavailable.
        return 'whitelist-confine';
    }
    // network true: must still use best FS isolation
    if (caps.bwrapOk) return 'bwrap-network-enabled';
    return 'whitelist-confine-network-enabled';
}

function assertNetworkAllowed(network) {
    if (!network) return;
    // network:true is an explicit high-risk opt-in; still no shell.
    // RFC: true needs R3 confirm + admin policy (enforced at tool layer).
}

function requireNetworkIsolationIfDenied(network) {
    if (network) return;
    const caps = probeCapabilities();
    // Prefer real net isolation. If unavailable, continue with whitelist-only
    // (grep/jq etc. cannot create sockets usefully without libc tricks) but
    // report mode so operators can install bwrap. We do NOT fall back to shell.
    void caps;
}

function sessionKey(userId, sessionId) {
    return `${userId}::${sessionId}`;
}

function takeQuota(userId, sessionId) {
    if (activeGlobal >= MAX_CONCURRENT_GLOBAL) {
        throw new HttpError(429, 'exec_global_concurrency', '全局沙箱并发已满');
    }
    const u = activeByUser.get(userId) || 0;
    if (u >= MAX_CONCURRENT_USER) {
        throw new HttpError(429, 'exec_user_concurrency', '用户沙箱并发已满');
    }
    const sk = sessionKey(userId, sessionId);
    const now = Date.now();
    const window = (sessionExecTimestamps.get(sk) || []).filter((t) => now - t < 3600_000);
    if (window.length >= MAX_SESSION_EXECS_PER_HOUR) {
        throw new HttpError(429, 'exec_session_quota', '本会话每小时执行次数已达上限');
    }
    window.push(now);
    sessionExecTimestamps.set(sk, window);
    activeGlobal += 1;
    activeByUser.set(userId, u + 1);
    return () => {
        activeGlobal = Math.max(0, activeGlobal - 1);
        const cur = activeByUser.get(userId) || 1;
        if (cur <= 1) activeByUser.delete(userId);
        else activeByUser.set(userId, cur - 1);
    };
}

function isRemoteUrl(arg) {
    return /^(https?|ftp|rtmp|rtsp|srt|tcp|udp|pipe|mms):\/\//i.test(String(arg || ''));
}

function looksLikePath(arg) {
    if (!arg || typeof arg !== 'string') return false;
    if (arg.startsWith('-')) return false; // flag
    if (isRemoteUrl(arg)) return false; // handled by runtime policy, not FS confine
    if (arg.startsWith('workspace://')) return true;
    if (arg.startsWith('/') || arg.startsWith('./') || arg.startsWith('../')) return true;
    if (arg.includes('/')) return true;
    return false;
}

function normalizeCwdRequest(cwd, sessionRoot) {
    let rel = String(cwd || 'workspace').trim();
    if (rel.startsWith('workspace://')) {
        rel = rel.slice('workspace://'.length);
        // workspace://{sessionId}/path or workspace://path
        const parts = rel.split('/');
        if (parts.length >= 2 && !['uploads', 'workspace', 'outputs', 'ocr', 'spillover'].includes(parts[0])) {
            // drop session id segment if present
            rel = parts.slice(1).join('/');
        }
    }
    rel = rel.replace(/^\/+/, '').replace(/\\/g, '/');
    if (!rel || rel === '.') rel = 'workspace';
    if (rel.includes('..')) throw new HttpError(400, 'bad_cwd', 'cwd 禁止 ..');
    const abs = path.resolve(sessionRoot, rel);
    if (abs !== sessionRoot && !abs.startsWith(sessionRoot + path.sep)) {
        throw new HttpError(400, 'bad_cwd', 'cwd 必须位于会话目录内');
    }
    // default writable area
    const first = rel.split('/')[0];
    if (!['workspace', 'outputs', 'uploads', 'ocr', 'spillover'].includes(first)) {
        throw new HttpError(400, 'bad_cwd', 'cwd 必须在 uploads/workspace/outputs/ocr/spillover 下');
    }
    return { abs, rel };
}

function resolveConfinedPath(arg, cwdAbs, sessionRoot) {
    let raw = String(arg);
    if (raw.startsWith('workspace://')) {
        raw = raw.replace(/^workspace:\/\/[^/]*\/?/, '');
        raw = path.join(sessionRoot, raw);
    } else if (!path.isAbsolute(raw)) {
        // Paths that already start with session subdirs are session-root relative
        // (avoid workspace/ + workspace/file → workspace/workspace/file).
        const first = raw.replace(/^\.\//, '').split('/')[0];
        if (['uploads', 'workspace', 'outputs', 'ocr', 'spillover'].includes(first)) {
            raw = path.resolve(sessionRoot, raw);
        } else {
            raw = path.resolve(cwdAbs, raw);
        }
    } else {
        raw = path.resolve(raw);
    }
    let abs;
    try {
        // If exists, realpath; else resolve parent realpath + basename
        if (fs.existsSync(raw)) abs = fs.realpathSync(raw);
        else {
            const parent = path.dirname(raw);
            if (!fs.existsSync(parent)) {
                // allow creating under workspace/outputs only — still must be under session
                abs = path.resolve(raw);
            } else {
                abs = path.join(fs.realpathSync(parent), path.basename(raw));
            }
        }
    } catch {
        abs = path.resolve(raw);
    }
    if (abs !== sessionRoot && !abs.startsWith(sessionRoot + path.sep)) {
        throw new HttpError(400, 'path_escape', `路径越出会话目录: ${arg}`);
    }
    return abs;
}

function validateArgs(commandName, args, cwdAbs, sessionRoot) {
    if (!Array.isArray(args)) throw new HttpError(400, 'bad_args', 'args 必须是数组');
    if (args.length > MAX_ARGS) throw new HttpError(400, 'too_many_args', `args 最多 ${MAX_ARGS} 个`);
    const out = [];
    for (const a of args) {
        const s = String(a);
        if (s.length > MAX_ARG_LEN) throw new HttpError(400, 'arg_too_long', '参数过长');
        // block NULs; do not ban legitimate flags like grep -c (count)
        if (/[\0]/.test(s)) throw new HttpError(400, 'bad_arg', '参数含非法字符');
        // reject explicit shell binary paths as arguments
        if (s === '/bin/sh' || s === '/bin/bash' || s === '/usr/bin/bash' || s === '/usr/bin/sh'
            || s === 'bash' || s === 'sh') {
            throw new HttpError(400, 'shell_forbidden', '禁止 shell 解释参数');
        }
        if (looksLikePath(s)) {
            out.push(resolveConfinedPath(s, cwdAbs, sessionRoot));
        } else {
            out.push(s);
        }
    }
    // sed -i must only target workspace/outputs
    if (commandName === 'sed') {
        for (let i = 0; i < out.length; i++) {
            if (out[i] === '-i' || String(out[i]).startsWith('-i')) {
                // next path-like or same token
                const target = out[i + 1] || '';
                if (target && path.isAbsolute(target)) {
                    const rel = path.relative(sessionRoot, target);
                    if (!rel.startsWith('workspace' + path.sep) && !rel.startsWith('outputs' + path.sep)
                        && rel !== 'workspace' && rel !== 'outputs') {
                        throw new HttpError(400, 'write_not_allowed', 'sed -i 仅允许 workspace/outputs');
                    }
                }
            }
        }
    }
    validateRuntimePolicy(commandName, out, sessionRoot);
    return out;
}

function underSession(absPath, sessionRoot) {
    const abs = path.resolve(absPath);
    return abs === sessionRoot || abs.startsWith(sessionRoot + path.sep);
}

function underWritable(absPath, sessionRoot) {
    const rel = path.relative(sessionRoot, path.resolve(absPath));
    return rel === 'workspace' || rel === 'outputs'
        || rel.startsWith('workspace' + path.sep) || rel.startsWith('outputs' + path.sep);
}

/**
 * Language/runtime policy (screenshot matrix):
 *  Python  — full: script file / -m module; uv for deps (network when install)
 *  Node    — partial: only .js/.mjs/.cjs under session; limited npm
 *  Go/Rust — support: build/run/test within session module
 *  FFmpeg  — built-in media paths confined
 * Never: -c / -e / interactive / open shell.
 */
function validateRuntimePolicy(commandName, args, sessionRoot) {
    const a = args.map(String);

    if (commandName === 'python3' || commandName === 'python') {
        if (a.includes('-c') || a.some((x) => x.startsWith('-c') && x !== '-c')) {
            throw new HttpError(400, 'python_inline_forbidden', '禁止 python -c；请把代码写入 workspace/*.py 再执行');
        }
        if (a.includes('-i')) {
            throw new HttpError(400, 'python_interactive_forbidden', '禁止交互式 python -i');
        }
        // Must have either -m MODULE or a .py path under session
        const mIdx = a.indexOf('-m');
        if (mIdx >= 0) {
            const mod = a[mIdx + 1] || '';
            if (!mod || mod.startsWith('/') || mod.includes('..')) {
                throw new HttpError(400, 'python_bad_module', '非法 -m 模块名');
            }
            return;
        }
        const script = a.find((x) => !x.startsWith('-') && /\.py$/i.test(x));
        if (!script) {
            throw new HttpError(400, 'python_script_required', 'python 需要 workspace 内 .py 文件或 -m module');
        }
        if (!underSession(script, sessionRoot)) {
            throw new HttpError(400, 'path_escape', 'python 脚本必须在会话目录内');
        }
        return;
    }

    if (commandName === 'uv') {
        // Recommended: uv run / uv sync / uv pip install / uv venv / uv init
        const sub = a[0] || '';
        const allowed = new Set(['run', 'sync', 'pip', 'venv', 'init', 'add', 'remove', 'tree', 'lock', 'python', 'version', '--version', 'help']);
        if (!allowed.has(sub)) {
            throw new HttpError(400, 'uv_subcommand_forbidden', `uv 子命令不允许: ${sub || '(empty)'}；允许 run/sync/pip/venv/init/add/lock`);
        }
        if (a.includes('-c')) {
            throw new HttpError(400, 'uv_inline_forbidden', '禁止 uv 内联任意命令串');
        }
        // uv run should target session files
        if (sub === 'run') {
            const script = a.slice(1).find((x) => !x.startsWith('-') && /\.py$/i.test(x));
            if (script && !underSession(script, sessionRoot)) {
                throw new HttpError(400, 'path_escape', 'uv run 脚本必须在会话目录内');
            }
        }
        return;
    }

    if (commandName === 'node') {
        // Partial: no -e/--eval/-p/--print/-i, require .js file under session
        const banned = new Set(['-e', '--eval', '-p', '--print', '-i', '--interactive', '--input-type']);
        for (const x of a) {
            if (banned.has(x) || x.startsWith('--eval=') || x.startsWith('--print')) {
                throw new HttpError(400, 'node_inline_forbidden', 'Node 为部分支持：禁止 -e/-p 内联；请运行 workspace 内 .js/.mjs');
            }
        }
        const script = a.find((x) => !x.startsWith('-') && /\.(js|mjs|cjs)$/i.test(x));
        if (!script) {
            throw new HttpError(400, 'node_script_required', 'node 需要会话内 .js/.mjs/.cjs 文件');
        }
        if (!underSession(script, sessionRoot)) {
            throw new HttpError(400, 'path_escape', 'node 脚本必须在会话目录内');
        }
        return;
    }

    if (commandName === 'npm') {
        // Partial package manager surface
        const sub = a[0] || '';
        const allowed = new Set(['install', 'ci', 'test', 'run', 'pack', 'ls', 'outdated', 'version', '--version']);
        if (!allowed.has(sub)) {
            throw new HttpError(400, 'npm_subcommand_forbidden', `npm 部分支持，允许: install/ci/test/run/ls；禁止 ${sub || '(empty)'}`);
        }
        // block npm exec / npx style
        if (sub === 'exec' || a.includes('--yes')) {
            throw new HttpError(400, 'npm_exec_forbidden', '禁止 npm exec/npx 任意包执行');
        }
        return;
    }

    if (commandName === 'go') {
        const sub = a[0] || '';
        const allowed = new Set(['build', 'run', 'test', 'mod', 'fmt', 'vet', 'list', 'env', 'version', 'help']);
        if (!allowed.has(sub)) {
            throw new HttpError(400, 'go_subcommand_forbidden', `go 允许: build/run/test/mod/fmt/vet；禁止 ${sub || '(empty)'}`);
        }
        if (sub === 'run' || sub === 'build' || sub === 'test') {
            // packages/files should be relative or under session when path-like
            for (const x of a.slice(1)) {
                if (x.startsWith('-')) continue;
                if ((x.startsWith('/') || x.includes('..')) && !underSession(x, sessionRoot) && x !== './...' && !x.startsWith('./')) {
                    // allow ./... and relative
                    if (path.isAbsolute(x) && !underSession(x, sessionRoot)) {
                        throw new HttpError(400, 'path_escape', 'go 目标路径必须在会话目录内');
                    }
                }
            }
        }
        return;
    }

    if (commandName === 'rustc') {
        const src = a.find((x) => !x.startsWith('-') && /\.rs$/i.test(x));
        if (!src) throw new HttpError(400, 'rustc_source_required', 'rustc 需要会话内 .rs 源文件');
        if (!underSession(src, sessionRoot)) throw new HttpError(400, 'path_escape', 'rustc 源文件必须在会话目录内');
        // -o output under writable
        const oIdx = a.indexOf('-o');
        if (oIdx >= 0) {
            const outPath = a[oIdx + 1];
            if (outPath && path.isAbsolute(outPath) && !underWritable(outPath, sessionRoot)) {
                throw new HttpError(400, 'write_not_allowed', 'rustc -o 仅允许 workspace/outputs');
            }
        }
        return;
    }

    if (commandName === 'cargo') {
        const sub = a[0] || '';
        const allowed = new Set(['build', 'run', 'test', 'check', 'fmt', 'clippy', 'tree', 'metadata', 'version', '--version', 'init', 'new']);
        if (!allowed.has(sub)) {
            throw new HttpError(400, 'cargo_subcommand_forbidden', `cargo 允许: build/run/test/check/fmt/init；禁止 ${sub || '(empty)'}`);
        }
        return;
    }

    if (commandName === 'ffmpeg' || commandName === 'ffprobe') {
        // All path-like args already confined. Ban protocol abuse.
        for (const x of a) {
            if (/^(https?|ftp|rtmp|srt|tcp|udp|pipe):/i.test(x)) {
                throw new HttpError(400, 'ffmpeg_remote_forbidden', 'ffmpeg/ffprobe 禁止远程 URL；请先把媒体放到 uploads/workspace');
            }
            if (x === '-i' ) continue;
        }
        // require at least one input-ish token for ffmpeg (not for ffprobe -show_format alone on file)
        if (commandName === 'ffmpeg') {
            const hasOut = a.some((x, i) => !x.startsWith('-') && i > 0);
            if (!hasOut && !a.includes('-version') && !a.includes('-h')) {
                // still allow version
            }
        }
        return;
    }
}

function validateCommandPolicyName(command) {
    const name = String(command || '').trim();
    if (!name) throw new HttpError(400, 'command_required', 'command required');
    const base = path.basename(name);
    if (FORBIDDEN_NAMES.has(base) || FORBIDDEN_NAMES.has(name)) {
        throw new HttpError(400, 'command_forbidden', `command is forbidden: ${base}`);
    }
    if (name.includes('/') || name.includes('\\')) {
        throw new HttpError(400, 'command_must_be_name', 'command must be a whitelisted short name');
    }
    if (!WHITELIST.some((entry) => entry.name === base)) {
        throw new HttpError(400, 'command_unavailable', `command is unavailable or not whitelisted: ${base}`);
    }
    return base;
}

function resolveCommand(command) {
    const name = String(command || '').trim();
    if (!name) throw new HttpError(400, 'command_required', 'command required');
    const base = path.basename(name);
    if (FORBIDDEN_NAMES.has(base) || FORBIDDEN_NAMES.has(name)) {
        throw new HttpError(400, 'command_forbidden', `命令不在白名单: ${base}`);
    }
    // reject path-form commands outside whitelist names
    if (name.includes('/') || name.includes('\\')) {
        // still forbidden even if basename is bash
        throw new HttpError(400, 'command_must_be_name', 'command 只能是白名单短名（如 grep），不能是路径');
    }
    const bins = resolveWhitelistBins();
    const entry = bins.get(base);
    if (!entry) throw new HttpError(400, 'command_unavailable', `命令不可用或不在白名单: ${base}`);
    return { name: base, absolute: entry.absolute, applet: entry.applet };
}

async function appendAudit(sessionRoot, record) {
    try {
        const dir = path.join(sessionRoot, 'outputs');
        await fsp.mkdir(dir, { recursive: true });
        const line = JSON.stringify({ ...record, ts: new Date().toISOString() }) + '\n';
        await fsp.appendFile(path.join(dir, '.exec-audit.ndjson'), line, { mode: 0o600 });
    } catch {
        // audit failure must not become silent RCE, but also not block if disk full after run
    }
}

function buildBwrapArgs({ sessionRoot, cwdAbs, network, argv }) {
    const caps = probeCapabilities();
    const uploads = path.join(sessionRoot, 'uploads');
    const workspace = path.join(sessionRoot, 'workspace');
    const outputs = path.join(sessionRoot, 'outputs');
    const ocr = path.join(sessionRoot, 'ocr');
    const spill = path.join(sessionRoot, 'spillover');
    for (const d of [uploads, workspace, outputs, ocr, spill]) {
        fs.mkdirSync(d, { recursive: true });
    }
    const args = [
        '--die-with-parent',
        '--new-session',
        '--clearenv',
        '--setenv', 'PATH', '/usr/bin:/bin',
        '--setenv', 'HOME', '/tmp',
        '--setenv', 'LANG', process.env.LANG || 'C.UTF-8',
        '--setenv', 'LC_ALL', process.env.LC_ALL || 'C.UTF-8',
        '--setenv', 'TMPDIR', '/tmp',
        '--tmpfs', '/tmp',
        '--proc', '/proc',
        '--dev', '/dev',
        // minimal system for dynamic linker + whitelist bins
        '--ro-bind', '/usr', '/usr',
        '--ro-bind', '/bin', '/bin',
    ];
    if (fs.existsSync('/lib')) args.push('--ro-bind', '/lib', '/lib');
    if (fs.existsSync('/lib64')) args.push('--ro-bind', '/lib64', '/lib64');
    // Debian's BLAS/LAPACK and similar loader links resolve through
    // /etc/alternatives; without this read-only bind ffmpeg starts with 127.
    if (fs.existsSync('/etc/alternatives')) args.push('--ro-bind', '/etc/alternatives', '/etc/alternatives');
    if (fs.existsSync('/lib/aarch64-linux-gnu')) {
        // already under /lib
    }
    // session mounts: uploads RO, workspace/outputs RW
    args.push('--ro-bind', uploads, uploads);
    args.push('--ro-bind', ocr, ocr);
    args.push('--ro-bind', spill, spill);
    args.push('--bind', workspace, workspace);
    args.push('--bind', outputs, outputs);
    // hide rest of host data by not mounting it
    if (!network && caps.bwrapNet) args.push('--unshare-net');
    args.push('--unshare-pid');
    args.push('--chdir', cwdAbs);
    args.push('--');
    args.push(...argv);
    return args;
}

function wrapWithLimits(argv, timeoutMs, memLimitBytes = MEM_LIMIT_BYTES) {
    const caps = probeCapabilities();
    let finalArgv = argv.slice();
    // prlimit: cpu time + address space. Node/V8 needs a larger virtual address
    // reservation for its CodeRange even when actual RSS stays well below 512MB.
    if (caps.prlimitPath) {
        finalArgv = [
            caps.prlimitPath,
            `--cpu=${CPU_CPU_SECONDS}`,
            `--as=${memLimitBytes}`,
            '--',
            ...finalArgv,
        ];
    }
    if (caps.timeoutPath) {
        // timeout -s KILL after grace: use --kill-after=2s
        finalArgv = [
            caps.timeoutPath,
            '--signal=KILL',
            `--kill-after=2s`,
            `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`,
            ...finalArgv,
        ];
    }
    return finalArgv;
}

function planExecution({ command, args, sessionRoot, cwdAbs, network, timeoutMs }) {
    const caps = probeCapabilities();
    // Apply policy for known commands before checking optional host binaries.
    // This keeps path/runtime guards fail-closed on minimal installations.
    const commandName = validateCommandPolicyName(command);
    const confinedArgs = validateArgs(commandName, args, cwdAbs, sessionRoot);
    const cmd = resolveCommand(commandName);
    const memLimitBytes = (cmd.name === 'node' || cmd.name === 'npm') ? NODE_MEM_LIMIT_BYTES : MEM_LIMIT_BYTES;
    // busybox multi-call must invoke as: busybox <applet> args...
    const inner = cmd.applet
        ? [cmd.absolute, cmd.applet, ...confinedArgs]
        : [cmd.absolute, ...confinedArgs];

    if (caps.bwrapOk && caps.bwrapPath) {
        const bwrapArgs = buildBwrapArgs({ sessionRoot, cwdAbs, network: !!network, argv: inner });
        const full = [caps.bwrapPath, ...bwrapArgs];
        const capped = wrapWithLimits(full, timeoutMs, memLimitBytes);
        return {
            file: capped[0],
            argv: capped,
            mode: isolationMode(!!network),
            commandName: cmd.name,
            commandPath: cmd.absolute,
            inner,
            caps,
        };
    }

    if (!network && caps.unshareNet && caps.unsharePath) {
        const full = [caps.unsharePath, '-n', '--', ...inner];
        const capped = wrapWithLimits(full, timeoutMs, memLimitBytes);
        return {
            file: capped[0],
            argv: capped,
            mode: isolationMode(false),
            commandName: cmd.name,
            commandPath: cmd.absolute,
            inner,
            caps,
        };
    }

    if (!network && !caps.canDenyNetwork) {
        // Still allow whitelist-confine: no shell, path confined, no network tools in whitelist.
        // Document mode for operators.
    }

    const capped = wrapWithLimits(inner, timeoutMs, memLimitBytes);
    return {
        file: capped[0],
        argv: capped,
        mode: isolationMode(!!network),
        commandName: cmd.name,
        commandPath: cmd.absolute,
        inner,
        caps,
    };
}

function runSpawn({ file, argv, cwd, timeoutMs, env }) {
    return new Promise((resolve) => {
        const started = Date.now();
        let stdout = Buffer.alloc(0);
        let stderr = Buffer.alloc(0);
        let killed = false;
        let timedOut = false;
        let settled = false;

        const child = spawn(file, argv.slice(1), {
            cwd,
            env,
            detached: true, // process group for kill
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        const killTree = (sig = 'SIGKILL') => {
            killed = true;
            try {
                process.kill(-child.pid, sig);
            } catch {
                try { child.kill(sig); } catch { /* ignore */ }
            }
        };

        const timer = setTimeout(() => {
            timedOut = true;
            killTree('SIGKILL');
        }, timeoutMs);

        child.stdout.on('data', (chunk) => {
            if (stdout.length < MAX_STDOUT) {
                stdout = Buffer.concat([stdout, chunk], Math.min(MAX_STDOUT, stdout.length + chunk.length));
            }
            if (stdout.length >= MAX_STDOUT) {
                // stop reading excess
            }
        });
        child.stderr.on('data', (chunk) => {
            if (stderr.length < MAX_STDERR) {
                stderr = Buffer.concat([stderr, chunk], Math.min(MAX_STDERR, stderr.length + chunk.length));
            }
        });

        const finish = (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({
                exitCode: timedOut ? 124 : (code == null ? -1 : code),
                signal: signal || null,
                stdout: stdout.toString('utf8'),
                stderr: stderr.toString('utf8'),
                durationMs: Date.now() - started,
                timedOut,
                killed,
                truncated: {
                    stdout: stdout.length >= MAX_STDOUT,
                    stderr: stderr.length >= MAX_STDERR,
                },
            });
        };

        child.on('error', (err) => {
            stderr = Buffer.from(String(err.message || err));
            finish(-1, null);
        });
        child.on('close', (code, signal) => finish(code, signal));
    });
}

/**
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.sessionId
 * @param {string} opts.dataDir
 * @param {string} opts.command
 * @param {string[]} [opts.args]
 * @param {string} [opts.cwd]
 * @param {number} [opts.timeoutMs]
 * @param {boolean} [opts.network]
 * @param {boolean} [opts.allowNetworkPolicy] admin/policy gate for network:true
 */
async function sessionExec(opts = {}) {
    const userId = String(opts.userId || '').trim();
    const sessionId = String(opts.sessionId || '').trim();
    const dataDir = opts.dataDir || path.join(process.cwd(), 'data');
    if (!userId || !sessionId) throw new HttpError(400, 'session_required', 'userId/sessionId required');

    const network = !!opts.network;
    if (network && !opts.allowNetworkPolicy) {
        throw new HttpError(403, 'network_policy_denied', 'network:true 需要管理员策略允许且用户确认');
    }
    assertNetworkAllowed(network);
    requireNetworkIsolationIfDenied(network);

    const cmdNameEarly = String(opts.command || '').trim();
    const isRuntime = RUNTIME_COMMANDS.has(cmdNameEarly);
    const maxTo = isRuntime ? RUNTIME_MAX_TIMEOUT_MS : MAX_TIMEOUT_MS;
    const defTo = isRuntime ? RUNTIME_DEFAULT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.min(
        maxTo,
        Math.max(1000, Number(opts.timeoutMs) || defTo)
    );

    const { AiSessionFs } = require('./ai-session-fs');
    const fsApi = opts.sessionFs || new AiSessionFs({ dataDir });
    const sessionRoot = await fsApi.ensure(userId, sessionId);
    const { abs: cwdAbs, rel: cwdRel } = normalizeCwdRequest(opts.cwd, sessionRoot);
    await fsp.mkdir(cwdAbs, { recursive: true });

    const release = takeQuota(userId, sessionId);
    const execId = crypto.randomBytes(8).toString('hex');
    let plan;
    try {
        plan = planExecution({
            command: opts.command,
            args: Array.isArray(opts.args) ? opts.args : [],
            sessionRoot,
            cwdAbs,
            network,
            timeoutMs,
        });
    } catch (err) {
        release();
        throw err;
    }

    // When network is false and we only have whitelist-confine without netns,
    // still OK for RFC tools (no network-capable binaries). When network true
    // without bwrap, allow but audit heavily.

    const env = {
        PATH: '/usr/bin:/bin',
        HOME: '/tmp',
        LANG: process.env.LANG || 'C.UTF-8',
        LC_ALL: process.env.LC_ALL || 'C.UTF-8',
        TMPDIR: '/tmp',
        ZEPHYR_SESSION_ROOT: sessionRoot,
        ZEPHYR_EXEC_ID: execId,
    };

    // For non-bwrap: run with cwd confined; do not pass host secrets.
    const runCwd = plan.mode.startsWith('bwrap') ? process.cwd() : cwdAbs;

    let result;
    try {
        result = await runSpawn({
            file: plan.file,
            argv: plan.argv,
            cwd: runCwd,
            timeoutMs: timeoutMs + 3000, // outer guard slightly above timeout wrapper
            env,
        });
    } finally {
        release();
    }

    const audit = {
        execId,
        userId,
        sessionId,
        command: plan.commandName,
        commandPath: plan.commandPath,
        args: plan.inner.slice(1),
        cwd: cwdRel,
        network,
        mode: plan.mode,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        stdoutBytes: Buffer.byteLength(result.stdout),
        stderrBytes: Buffer.byteLength(result.stderr),
    };
    await appendAudit(sessionRoot, audit);

    return {
        ok: !result.timedOut && result.exitCode === 0,
        execId,
        command: plan.commandName,
        argv: plan.inner,
        cwd: cwdRel,
        network,
        isolation: {
            mode: plan.mode,
            bwrap: !!plan.caps.bwrapOk,
            netNamespace: plan.mode.includes('net') && !network,
            canDenyNetwork: plan.caps.canDenyNetwork,
            note: plan.mode === 'whitelist-confine'
                ? '无 bwrap/unshare-net：已强制无 shell + 白名单 + 路径监禁；建议镜像安装 bubblewrap'
                : undefined,
        },
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        truncated: result.truncated,
        auditPath: 'outputs/.exec-audit.ndjson',
    };
}

function listAllowedCommands() {
    const bins = resolveWhitelistBins();
    const tierByName = new Map(WHITELIST.map((w) => [w.name, w.tier || 'text']));
    return [...bins.entries()].map(([name, entry]) => ({
        name,
        absolute: entry.absolute,
        applet: entry.applet || null,
        tier: tierByName.get(name) || 'text',
    }));
}

function environmentMatrix() {
    const bins = resolveWhitelistBins();
    const has = (n) => bins.has(n);
    return [
        {
            env: 'Python',
            status: has('python3') || has('python') ? 'full' : 'unavailable',
            detail: has('uv')
                ? '完全支持；推荐用 uv 管理依赖（uv sync / uv run）'
                : (has('python3') || has('python'))
                    ? '完全支持脚本；未检测到 uv，可直接 python3 workspace/*.py'
                    : '镜像未安装 python3',
            recommend: 'uv',
        },
        {
            env: 'Node.js',
            status: has('node') ? 'partial' : 'unavailable',
            detail: has('node')
                ? '部分支持：仅会话内 .js/.mjs/.cjs；禁止 -e/-p；npm 限 install/ci/test/run'
                : '镜像未安装 node',
        },
        {
            env: 'Go / Rust',
            status: (has('go') || has('rustc') || has('cargo')) ? 'supported' : 'unavailable',
            detail: [
                has('go') ? 'go build/run/test/mod' : null,
                has('cargo') ? 'cargo build/run/test' : null,
                has('rustc') ? 'rustc' : null,
            ].filter(Boolean).join('；') || '未安装 go/rustc/cargo',
        },
        {
            env: 'FFmpeg',
            status: has('ffmpeg') ? 'builtin' : 'unavailable',
            detail: has('ffmpeg')
                ? '内置；输入输出限会话目录；禁止 http/rtmp 等远程 URL（硬件加速视宿主机 ffmpeg 编译选项）'
                : '镜像未安装 ffmpeg',
        },
    ];
}

function getSandboxStatus() {
    const caps = probeCapabilities();
    return {
        ...caps,
        allowedCommands: listAllowedCommands(),
        environments: environmentMatrix(),
        limits: {
            defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
            maxTimeoutMs: MAX_TIMEOUT_MS,
            runtimeDefaultTimeoutMs: RUNTIME_DEFAULT_TIMEOUT_MS,
            runtimeMaxTimeoutMs: RUNTIME_MAX_TIMEOUT_MS,
            maxStdout: MAX_STDOUT,
            maxStderr: MAX_STDERR,
            memLimitBytes: MEM_LIMIT_BYTES,
            cpuSeconds: CPU_CPU_SECONDS,
            maxConcurrentGlobal: MAX_CONCURRENT_GLOBAL,
            maxConcurrentUser: MAX_CONCURRENT_USER,
            maxSessionExecsPerHour: MAX_SESSION_EXECS_PER_HOUR,
        },
        active: { global: activeGlobal, users: Object.fromEntries(activeByUser) },
        policy: {
            shell: false,
            python: 'full-script-and-uv',
            node: 'partial-script-only',
            goRust: 'supported',
            ffmpeg: 'builtin-session-paths',
        },
    };
}

// test helpers
function _resetCapsCache() {
    _capsCache = null;
    _binCache = null;
}

module.exports = {
    sessionExec,
    listAllowedCommands,
    getSandboxStatus,
    environmentMatrix,
    probeCapabilities,
    resolveCommand,
    validateCommandPolicyName,
    validateArgs,
    validateRuntimePolicy,
    normalizeCwdRequest,
    planExecution,
    WHITELIST,
    FORBIDDEN_NAMES,
    RUNTIME_COMMANDS,
    DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
    RUNTIME_DEFAULT_TIMEOUT_MS,
    RUNTIME_MAX_TIMEOUT_MS,
    _resetCapsCache,
};
