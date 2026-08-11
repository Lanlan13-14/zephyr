# Backup encryption

Zephyr database exports contain the SQLite database and, for file-managed
installations, the ML-KEM private key needed to decrypt sensitive database
fields. Treat every export as a high-value secret.

## Key provisioning and rotation

On a new installation where `data/.env` does not exist and no externally
managed `ENCRYPTION_KEY` is present, Zephyr creates `data/.env` atomically with
a random 256-bit Base64URL backup secret. POSIX permissions are verified as
`0600`. On Windows, Zephyr locks the data directory and `.env` against writes
and replacement, verifies that both are owned by the service SID, replaces
their DACLs with a protected service-only grant, and reads `.env` from the same
verified handle. A reparse point, non-regular file, multiple hard links, or an
oversized `.env` is rejected. Persist the entire data directory and store a
protected copy of this secret separately from the backup archive.

An externally supplied `ENCRYPTION_KEY` is not copied into `data/.env`. It must
be a canonical encoding of exactly 32 random bytes: either 43-character
unpadded Base64URL or 64-character hexadecimal. Ordinary text passphrases,
even long ones, are rejected. Generate the value with a CSPRNG or secrets
manager.

The application can reject malformed encodings, recognizable repetition and a
bounded set of public-password digests, but a 32-byte value cannot prove how it
was generated. Externally managed keys therefore also require
`ZEPHYR_BACKUP_KEY_PROVENANCE=operator-attested-csprng-v1`. This is an explicit
operator assertion, not cryptographic proof of provenance. Zephyr-generated
keys carry `zephyr-generated-csprng-v1` automatically; do not set that value for
an externally generated key.

Existing installations with a missing, short, weak, or public
`please-change-this-key` value are not rotated automatically. Export and import
remain disabled until an operator explicitly replaces the value and restarts
Zephyr. An existing operator-managed random key also needs the operator
attestation above before new exports are enabled. Keep the old non-default key
only as long as needed to import old
archives, then rotate it and create a new export. Never continue trusting an
archive encrypted with the public default.

## Archive versions

New exports use `ZEPHYR4`. Each archive carries a random 128-bit salt and
versioned scrypt parameters (`N=32768`, `r=8`, `p=1`) and is encrypted with
AES-256-GCM. The authenticated header prevents KDF or cipher metadata from
being changed without detection. Reusing the same backup secret therefore
does not reuse the archive encryption key.

`ZEPHYR3` is disabled by default. A one-time migration requires both an
explicit `backupPassword` in the import form and
`ZEPHYR_ALLOW_LEGACY_BACKUP_IMPORT=true` at server startup. The compatibility
password is never taken implicitly from the current `ENCRYPTION_KEY`; it must
be at least 32 bytes, non-placeholder, and non-repeating. Remove the flag after
the migration attempt. After outer-envelope decryption, the payload must still
satisfy the current versioned `zephyr-backup` manifest policy; old unversioned
ZIP payloads are intentionally not trusted or imported. Archives made with the
public default are rejected before decryption. A wrong secret and a corrupted
archive return the same public authentication error, and secrets are never
written to logs.
