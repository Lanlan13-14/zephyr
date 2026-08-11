# WebDAV account backups

Zephyr's WebDAV integration writes encrypted, account-scoped snapshots. It is
not the real-time or incremental Zephyr One synchronization channel. Zephyr One
uses the authenticated `/api/mobile/v1/*` change feed for cross-device changes;
WebDAV is a separate disaster-recovery copy that runs only when the user starts
an immediate backup.

## Provisioning

Set two independent secrets before starting the server:

```env
WEBDAV_BACKUP_KEY=<32 random bytes as unpadded Base64URL or hexadecimal>
WEBDAV_CREDENTIAL_KEY=<different 32 random bytes as unpadded Base64URL or hexadecimal>
```

Both keys must come from a cryptographically secure random generator. They must
be different from each other and from `ENCRYPTION_KEY`. Zephyr removes the two
WebDAV variables from `process.env` after startup so child processes cannot
inherit them. If either key is absent, malformed, visibly weak, or reused, the
main service remains available but every WebDAV API operation fails closed.

Persist the keys outside the database and back them up separately. Losing
`WEBDAV_BACKUP_KEY` makes existing WebDAV archives unreadable. Losing or
changing `WEBDAV_CREDENTIAL_KEY` makes stored WebDAV credentials unusable; the
user must delete and recreate the integration.

## Data and remote layout

Each archive contains a consistent SQLite read snapshot of the authenticated
owner's connections, jump hosts, notes, proxies, SSH keys, eligible personal
settings, workspaces, and portable workspace identities. Authentication,
sessions, passkeys, TOTP material, system metadata, WebDAV configuration, and
master encryption keys are excluded. The resulting ZIP is encrypted with a
dedicated AES-256-GCM key before it leaves Zephyr.

Remote data is isolated under an opaque account namespace:

```text
<base path>/<remote path>/u-<SHA-256-derived account id>/zephyr-backup.bin
```

User IDs and credentials never appear in the remote path. Temporary uploads use
random names in the same namespace and are removed after failed operations when
the server remains reachable.

## Conflict and network policy

Backups are uploaded to a create-only temporary object and committed with
WebDAV `MOVE`. The first backup uses `Overwrite: F`, so it will not silently
replace an object created by another installation. Later backups verify the
saved strong ETag and apply destination ETag conditions during `MOVE`. If a
server omits the ETag from a successful `MOVE`, Zephyr accepts a read-back ETag
only after a bounded `GET` exactly matches the encrypted bytes just uploaded.
Any mismatch is a conflict and is never adopted as the local baseline.

Only HTTPS targets are accepted in production. URLs cannot contain embedded
credentials, query strings, fragments, control characters, or traversal
segments. DNS is resolved for every request; all returned addresses must pass
the public-address policy, and the HTTP connection is pinned to those validated
addresses to prevent DNS rebinding. Redirects are not followed. HTTP and
loopback targets exist only behind the explicit test-only configuration.

Safe read operations may retry transient failures with bounded exponential
backoff. `PUT`, `MOVE`, and `DELETE` are never automatically retried. Public
errors use fixed messages and do not include target URLs, credentials, response
bodies, or upstream error text.

## Limits and lifecycle

The production limits are 100,000 records, 32 MiB of JSON snapshot data, and
40 MiB for the final encrypted archive. Metadata responses are capped at 1 MiB.
The exceptional body read used to validate an ETag-less `MOVE` is capped at the
same 40 MiB archive limit and requests identity encoding, so compressed response
bodies are never decompressed. Operations have a two-minute overall deadline,
ten-second request deadlines, global/account concurrency limits, and a durable
account/session/IP verification-attempt budget.

Deleting an account deletes its local WebDAV configuration, encrypted
credentials, and account/session rate-limit buckets. It deliberately does not
delete the remote backup. Database import first aborts and drains WebDAV work,
closes the old SQLite runtime, and rebuilds against the installed database; a
rollback performs the same rebuild. Config epochs prevent work from an old
database or deleted account from writing status into a replacement row.

The current API creates and verifies encrypted backups only. It does not restore
a WebDAV archive directly and does not treat WebDAV as a multi-writer live-sync
transport.
