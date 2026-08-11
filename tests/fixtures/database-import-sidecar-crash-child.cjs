'use strict';

const fs = require('fs');
const path = require('path');

const [mode, directoryArg, killStage = ''] = process.argv.slice(2);
const dataDir = path.resolve(directoryArg || '');
const databaseFile = path.join(dataDir, 'zephyr.db');
const candidateDatabaseFile = path.join(dataDir, 'prepared-candidate.db');
const { createDatabase } = require('../../sqlite-driver');
const {
    beginImportInstall,
    installPreparedImport,
    recoverImportInstall,
} = require('../../database-import-install-journal');

function killAt(stage) {
    if (stage === killStage) process.kill(process.pid, 'SIGKILL');
}

function createDatabaseGeneration(file, generation) {
    const db = createDatabase(file, { forceBuiltin: true });
    try {
        db.exec('CREATE TABLE generation_marker (value TEXT NOT NULL)');
        db.prepare('INSERT INTO generation_marker (value) VALUES (?)').run(generation);
    } finally {
        db.close();
    }
}

function setup() {
    fs.mkdirSync(dataDir, { recursive: true });
    createDatabaseGeneration(databaseFile, 'old');
    createDatabaseGeneration(candidateDatabaseFile, 'new');

    const db = createDatabase(databaseFile, { forceBuiltin: true });
    let wal;
    let shm;
    try {
        db.pragma('journal_mode=WAL');
        db.exec('CREATE TABLE sidecar_probe (value TEXT NOT NULL)');
        db.prepare('INSERT INTO sidecar_probe (value) VALUES (?)').run('stale-sidecar');
        wal = fs.readFileSync(`${databaseFile}-wal`);
        shm = fs.readFileSync(`${databaseFile}-shm`);
    } finally {
        db.close();
    }
    /* Closing checkpoints the real database. Restore captured, structurally
     * real SQLite sidecars to model a power loss before directory cleanup. */
    fs.writeFileSync(`${databaseFile}-wal`, wal);
    fs.writeFileSync(`${databaseFile}-shm`, shm);
}

if (mode === 'setup') {
    setup();
} else if (mode === 'crash') {
    const transaction = beginImportInstall({
        dataDir,
        databaseFile,
        candidateDatabaseFile,
        keyChanged: false,
    });
    installPreparedImport(transaction, { faultInjector: killAt });
    throw new Error(`hard-kill stage was not reached: ${killStage}`);
} else if (mode === 'recover') {
    const recovery = recoverImportInstall({ dataDir, databaseFile });
    const walExists = fs.existsSync(`${databaseFile}-wal`);
    const shmExists = fs.existsSync(`${databaseFile}-shm`);
    const db = createDatabase(databaseFile, { forceBuiltin: true });
    try {
        const marker = db.prepare('SELECT value FROM generation_marker').get()?.value;
        const integrity = db.pragma('quick_check(1)');
        process.stdout.write(`${JSON.stringify({
            recovery,
            marker,
            integrity: String(Object.values(integrity[0] || {})[0] || ''),
            walExists,
            shmExists,
        })}\n`);
    } finally {
        db.close();
    }
} else {
    throw new Error(`unsupported fixture mode: ${mode}`);
}
