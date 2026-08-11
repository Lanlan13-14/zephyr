import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROBE_TIMEOUT_MS = 5_000;

function invocation(command, args = []) {
    if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)) {
        return {
            command: process.env.ComSpec || 'cmd.exe',
            args: ['/d', '/s', '/c', 'call', command, ...args],
        };
    }
    return { command, args };
}

function isPython3(candidate) {
    const probe = spawnSync(candidate.command, [...candidate.args, '--version'], {
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
    });
    return !probe.error
        && probe.status === 0
        && /Python 3(?:\.|\s|$)/.test(`${probe.stdout || ''}${probe.stderr || ''}`);
}

function uniqueCandidates(candidates) {
    const seen = new Set();
    return candidates.filter((candidate) => {
        const key = JSON.stringify([candidate.command, candidate.args]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export function resolveI18nPython(root) {
    const explicit = [
        process.env.ZEPHYR_I18N_PYTHON,
        process.env.ZEPHYR_TEST_PYTHON,
        process.env.PYTHON,
    ].filter(Boolean);
    const localCommands = [
        path.join(root, '.tooling', 'python', 'python.exe'),
        path.join(root, '.tooling', 'python', 'python3.exe'),
        path.join(root, '.tooling', 'bin', 'python3.cmd'),
        path.join(root, '.tooling', 'bin', 'python.cmd'),
        path.join(
            os.homedir(),
            '.cache',
            'codex-runtimes',
            'codex-primary-runtime',
            'dependencies',
            'python',
            'python.exe',
        ),
    ].filter((command) => fs.existsSync(command));
    const system = process.platform === 'win32'
        ? [
            { command: 'py', args: ['-3'] },
            { command: 'python3', args: [] },
            { command: 'python', args: [] },
        ]
        : [
            { command: 'python3', args: [] },
            { command: 'python', args: [] },
        ];
    const candidates = uniqueCandidates([
        ...explicit.map((command) => invocation(command)),
        ...localCommands.map((command) => invocation(command)),
        ...system,
    ]);
    return candidates.find(isPython3);
}

export function runI18nPython(python, args, options = {}) {
    const env = {
        ...process.env,
        ...options.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
    };
    try {
        return execFileSync(python.command, [...python.args, ...args], {
            windowsHide: true,
            ...options,
            env,
        });
    } catch (error) {
        const auditOutput = [error?.stdout, error?.stderr]
            .filter(Boolean)
            .map((value) => Buffer.isBuffer(value) ? value.toString(options.encoding || 'utf8') : String(value))
            .join('\n')
            .trim();
        if (auditOutput && !String(error.message).includes(auditOutput)) {
            error.message = `${error.message}\n${auditOutput}`;
        }
        throw error;
    }
}

export const missingI18nPythonReason =
    'requires Python 3; set ZEPHYR_I18N_PYTHON or ZEPHYR_TEST_PYTHON, provide the project .tooling runtime, install the Windows py launcher, or put python3/python on PATH';
