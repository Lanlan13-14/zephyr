import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { Authz, CAP, TIERS, expandTier, normalizeCapabilities, HttpError } from '../authz.js';

const DDL = `
CREATE TABLE resource_acl (
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  subject_type TEXT NOT NULL DEFAULT 'user',
  subject_id TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  granted_by_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  PRIMARY KEY (resource_type, resource_id, subject_type, subject_id)
);
CREATE TABLE audit_events (
  event_id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  target_user_id TEXT,
  resource_type TEXT,
  resource_id TEXT,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
`;

function setup(now = () => 1_000_000) {
    const db = new Database(':memory:');
    db.exec(DDL);
    const users = {
        owner: { userId: 'owner', role: 'user', status: 'active' },
        alice: { userId: 'alice', role: 'user', status: 'active' },
        admin: { userId: 'admin', role: 'admin', status: 'active' },
        suspended: { userId: 'sus', role: 'user', status: 'suspended' },
    };
    const authz = new Authz(db, { getUserById: (id) => Object.values(users).find((u) => u.userId === id) || null, now });
    return { db, authz, users };
}

test('owner holds every capability including revealSecret and administer', () => {
    const { authz, users } = setup();
    const resource = { ownerUserId: 'owner' };
    for (const cap of Object.values(CAP)) {
        assert.ok(authz.can(users.owner, cap, 'connection', 'c1', resource), `owner must hold ${cap}`);
    }
});

test('admin gets only metadata-level governance over others\' private resources', () => {
    const { authz, users } = setup();
    const resource = { ownerUserId: 'owner' };
    assert.ok(authz.can(users.admin, CAP.VIEW, 'connection', 'c1', resource));
    for (const cap of [CAP.USE, CAP.CONTROL, CAP.EXECUTE, CAP.REVEAL_SECRET, CAP.EDIT, CAP.DELETE, CAP.DISCOVER]) {
        assert.ok(!authz.can(users.admin, cap, 'connection', 'c1', resource), `admin must NOT implicitly hold ${cap} over user-private resources`);
    }
});

test('strangers get nothing; suspended users get nothing even when owning', () => {
    const { authz, users } = setup();
    const resource = { ownerUserId: 'owner' };
    assert.equal(authz.effectiveCapabilities(users.alice, 'connection', 'c1', resource).size, 0);
    const ownResource = { ownerUserId: 'sus' };
    assert.equal(authz.effectiveCapabilities(users.suspended, 'connection', 'cX', ownResource).size, 0, 'suspended user loses all effective access');
});

test('grant → effective capabilities; expiry and revocation apply', () => {
    let nowTs = 1_000_000;
    const { authz, users } = setup(() => nowTs);
    const resource = { ownerUserId: 'owner' };
    authz.grant({ resourceType: 'connection', resourceId: 'c1', subjectId: 'alice', capabilities: expandTier('observer'), grantedByUserId: 'owner' });
    for (const cap of [CAP.DISCOVER, CAP.VIEW, CAP.OBSERVE]) assert.ok(authz.can(users.alice, cap, 'connection', 'c1', resource));
    for (const cap of [CAP.USE, CAP.CONTROL, CAP.EDIT, CAP.DELETE, CAP.REVEAL_SECRET]) assert.ok(!authz.can(users.alice, cap, 'connection', 'c1', resource), `observer must not hold ${cap}`);

    // upgrade to operator
    authz.grant({ resourceType: 'connection', resourceId: 'c1', subjectId: 'alice', capabilities: expandTier('operator'), grantedByUserId: 'owner' });
    assert.ok(authz.can(users.alice, CAP.USE, 'connection', 'c1', resource));
    assert.ok(authz.can(users.alice, CAP.CONTROL, 'connection', 'c1', resource));
    assert.ok(!authz.can(users.alice, CAP.EDIT, 'connection', 'c1', resource));

    // expiry
    authz.grant({ resourceType: 'connection', resourceId: 'c2', subjectId: 'alice', capabilities: [CAP.VIEW, CAP.DISCOVER], grantedByUserId: 'owner', expiresAt: nowTs + 1000 });
    assert.ok(authz.can(users.alice, CAP.VIEW, 'connection', 'c2', { ownerUserId: 'owner' }));
    nowTs += 2000;
    assert.ok(!authz.can(users.alice, CAP.VIEW, 'connection', 'c2', { ownerUserId: 'owner' }), 'expired grant no longer applies');

    // revocation
    assert.ok(authz.revoke({ resourceType: 'connection', resourceId: 'c1', subjectId: 'alice', revokedByUserId: 'owner' }));
    assert.ok(!authz.can(users.alice, CAP.USE, 'connection', 'c1', resource), 'revoked grant stops immediately');
});

test('tiers expand to documented capability sets (§12.4)', () => {
    assert.deepEqual(expandTier('observer'), [CAP.DISCOVER, CAP.VIEW, CAP.OBSERVE]);
    assert.ok(expandTier('operator').includes(CAP.CONTROL));
    assert.ok(!expandTier('operator').includes(CAP.EXECUTE), 'operator ≠ executor');
    assert.ok(expandTier('file-operator').includes(CAP.FILE_READ) && expandTier('file-operator').includes(CAP.FILE_WRITE));
    assert.ok(expandTier('executor').includes(CAP.EXECUTE));
    assert.ok(expandTier('editor').includes(CAP.EDIT));
    const manager = expandTier('manager');
    assert.ok(manager.includes(CAP.SHARE) && manager.includes(CAP.DELETE));
    assert.ok(!manager.includes(CAP.REVEAL_SECRET), 'manager tier never auto-includes secret reveal');
    assert.ok(!manager.includes(CAP.ADMINISTER));
    assert.equal(expandTier('bogus').length, 0);
});

test('normalizeCapabilities drops unknown and duplicates', () => {
    assert.deepEqual(normalizeCapabilities(['use', 'use', 'bogus', 'view', '', null]), [CAP.USE, CAP.VIEW]);
});

test('assertCan collapses missing and inaccessible to 404 for enumeration safety', () => {
    const { authz, users } = setup();
    try {
        authz.assertCan(users.alice, CAP.VIEW, 'connection', 'nope', { ownerUserId: 'owner' }, { resourceExists: false });
        assert.fail('must throw');
    } catch (err) {
        assert.ok(err instanceof HttpError);
        assert.equal(err.status, 404);
        assert.equal(err.code, 'resource_not_found_or_inaccessible');
    }
    try {
        authz.assertCan(users.alice, CAP.CONTROL, 'connection', 'c1', { ownerUserId: 'owner' }, { resourceExists: true });
        assert.fail('must throw');
    } catch (err) {
        assert.equal(err.status, 403);
        assert.equal(err.code, 'forbidden_resource_control');
    }
});

test('visibleIds: owned + discover-shared; admin governance alone is not discovery', () => {
    const { authz, users } = setup();
    const rows = [
        { id: 'mine', ownerUserId: 'alice' },
        { id: 'shared', ownerUserId: 'owner' },
        { id: 'viewOnly', ownerUserId: 'owner' },
        { id: 'hidden', ownerUserId: 'owner' },
    ];
    authz.grant({ resourceType: 'connection', resourceId: 'shared', subjectId: 'alice', capabilities: [CAP.DISCOVER, CAP.VIEW], grantedByUserId: 'owner' });
    authz.grant({ resourceType: 'connection', resourceId: 'viewOnly', subjectId: 'alice', capabilities: [CAP.VIEW], grantedByUserId: 'owner' });
    const ids = authz.visibleIds(users.alice, 'connection', rows);
    assert.deepEqual([...ids].sort(), ['mine', 'shared'], 'only owned + discover grants appear in lists');
    const adminIds = authz.visibleIds(users.admin, 'connection', rows);
    assert.deepEqual([...adminIds], [], 'admin does not discover user-private resources implicitly');
});

test('grants and revocations write audit events', () => {
    const { db, authz } = setup();
    authz.grant({ resourceType: 'connection', resourceId: 'c1', subjectId: 'alice', capabilities: [CAP.VIEW], grantedByUserId: 'owner' });
    authz.revoke({ resourceType: 'connection', resourceId: 'c1', subjectId: 'alice', revokedByUserId: 'owner' });
    const events = db.prepare('SELECT * FROM audit_events ORDER BY created_at').all();
    assert.equal(events.length, 2);
    assert.equal(events[0].action, 'acl.grant');
    assert.equal(events[1].action, 'acl.revoke');
    assert.equal(events[0].actor_user_id, 'owner');
    assert.equal(events[0].target_user_id, 'alice');
});

test('ACL rows never store secrets — only capability names', () => {
    const { db, authz } = setup();
    authz.grant({ resourceType: 'connection', resourceId: 'c1', subjectId: 'alice', capabilities: [CAP.USE, CAP.VIEW], grantedByUserId: 'owner' });
    const row = db.prepare('SELECT capabilities_json FROM resource_acl').get();
    const parsed = JSON.parse(row.capabilities_json);
    for (const cap of parsed) assert.ok(Object.values(CAP).includes(cap));
});
