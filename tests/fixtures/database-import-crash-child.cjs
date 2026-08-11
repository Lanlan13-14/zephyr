'use strict';

const fs = require('fs');
const path = require('path');
const { ml_kem768 } = require('@noble/post-quantum/ml-kem.js');

const [mode, directoryArg, killStage = ''] = process.argv.slice(2);
const dataDir = path.resolve(directoryArg || '');
const databaseFile = path.join(dataDir, 'zephyr.db');
const candidateDatabaseFile = path.join(dataDir, 'prepared-candidate.db');
const keyFile = path.join(dataDir, 'crypto', 'key.json');
const metadataFile = path.join(dataDir, 'fixture-metadata.json');

process.env.ZEPHYR_DATA_DIR = dataDir;
process.env.ZEPHYR_DATA_MLKEM768_KEY_FILE = keyFile;
delete process.env.ZEPHYR_DATA_MLKEM768_PUBLIC_KEY_B64;
delete process.env.ZEPHYR_DATA_MLKEM768_SECRET_KEY_B64;
delete process.env.DATA_MLKEM768_PUBLIC_KEY_B64;
delete process.env.DATA_MLKEM768_SECRET_KEY_B64;

const secretCrypto = require('../../secret-crypto');
const {
    beginImportInstall,
    commitImportInstall,
    installPreparedImport,
    recoverImportInstall,
    rollbackImportInstall,
} = require('../../database-import-install-journal');

function keyBackup(pair) {
    return Buffer.from(`${JSON.stringify({
        version: 1,
        alg: 'ML-KEM-768',
        publicKey: Buffer.from(pair.publicKey).toString('base64'),
        secretKey: Buffer.from(pair.secretKey).toString('base64'),
        createdAt: Date.now(),
    })}\n`, 'utf8');
}

function killAt(stage) {
    if (stage === killStage) process.kill(process.pid, 'SIGKILL');
}

function installKeyBuffer(buffer, options) {
    return secretCrypto.restoreKeyBackupAtomically(buffer, options);
}

function setup() {
    fs.mkdirSync(dataDir, { recursive: true });
    secretCrypto.ensureKeyPair();
    const oldKeyBuffer = fs.readFileSync(keyFile);
    const oldCiphertext = secretCrypto.encryptSecret('old-generation-readable', 'fixture-secret');

    const newKeyBuffer = keyBackup(ml_kem768.keygen());
    secretCrypto.restoreKeyBackupAtomically(newKeyBuffer);
    const newCiphertext = secretCrypto.encryptSecret('new-generation-readable', 'fixture-secret');
    secretCrypto.restoreKeyBackupAtomically(oldKeyBuffer);

    fs.writeFileSync(databaseFile, JSON.stringify({
        generation: 'old',
        liveCredential: 'current-only',
        archivedCredential: null,
        ciphertext: oldCiphertext,
    }));
    fs.writeFileSync(candidateDatabaseFile, JSON.stringify({
        generation: 'new',
        liveCredential: null,
        archivedCredential: 'archived-live-credential',
        candidatePrepared: false,
        ciphertext: newCiphertext,
    }));
    fs.writeFileSync(metadataFile, JSON.stringify({
        newKey: newKeyBuffer.toString('base64'),
    }));
    oldKeyBuffer.fill(0);
    newKeyBuffer.fill(0);
}

function prepareCandidate() {
    const candidate = JSON.parse(fs.readFileSync(candidateDatabaseFile, 'utf8'));
    if (candidate.archivedCredential !== 'archived-live-credential') {
        throw new Error('fixture candidate credential was not active before preparation');
    }
    candidate.archivedCredential = null;
    candidate.candidatePrepared = true;
    fs.writeFileSync(candidateDatabaseFile, JSON.stringify(candidate));
    const fd = fs.openSync(candidateDatabaseFile, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function begin(faultInjector) {
    const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
    const incomingKeyBuffer = Buffer.from(metadata.newKey, 'base64');
    try {
        return beginImportInstall({
            dataDir,
            databaseFile,
            candidateDatabaseFile,
            keyFile,
            incomingKeyBuffer,
            keyChanged: true,
            faultInjector,
        });
    } finally {
        incomingKeyBuffer.fill(0);
    }
}

if (mode === 'setup') {
    setup();
} else if (mode === 'crash-install') {
    prepareCandidate();
    killAt('after_candidate_prepared');
    const transaction = begin(killAt);
    installPreparedImport(transaction, { faultInjector: killAt, installKeyBuffer });
    commitImportInstall(transaction, { faultInjector: killAt });
    throw new Error(`hard-kill stage was not reached: ${killStage}`);
} else if (mode === 'crash-rollback') {
    prepareCandidate();
    const transaction = begin(null);
    installPreparedImport(transaction, { installKeyBuffer });
    rollbackImportInstall(transaction, { faultInjector: killAt, installKeyBuffer });
    throw new Error(`hard-kill stage was not reached: ${killStage}`);
} else if (mode === 'commit-existing') {
    const journal = JSON.parse(fs.readFileSync(path.join(dataDir, '.zephyr-import-journal.v1.json'), 'utf8'));
    commitImportInstall({ id: journal.id, nonce: journal.nonce, dataDir, databaseFile, keyFile });
} else if (mode === 'recover') {
    const result = recoverImportInstall({ dataDir, databaseFile, keyFile, installKeyBuffer });
    secretCrypto.resetKeyPairCache();
    const database = JSON.parse(fs.readFileSync(databaseFile, 'utf8'));
    const plaintext = secretCrypto.decryptSecret(database.ciphertext, 'fixture-secret');
    process.stdout.write(`${JSON.stringify({
        result,
        database,
        plaintext,
        archivedCredentialStatus: database.archivedCredential ? 200 : 401,
    })}\n`);
} else {
    throw new Error(`unsupported fixture mode: ${mode}`);
}
