import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ResourceService } = require('../resource-service');
const { CAP, HttpError } = require('../authz');

function fixture() {
    const owner = { userId: 'owner', role: 'user', status: 'active' };
    const shared = { userId: 'shared', role: 'user', status: 'active' };
    const foreign = { userId: 'foreign', role: 'user', status: 'active' };
    const connections = [
        {
            id: 'target', ownerUserId: owner.userId, createdByUserId: owner.userId,
            name: 'target', host: 'target.example', port: 23, protocol: 'TELNET',
            connectionMode: 'proxy', proxyId: 'owner-proxy', jumpHostIds: [],
        },
        {
            id: 'hop', ownerUserId: owner.userId, createdByUserId: owner.userId,
            name: 'hop', host: 'hop.example', port: 22, protocol: 'SSH', username: 'root',
            password: 'owner-hop-secret', connectionMode: 'proxy', proxyId: 'owner-proxy', jumpHostIds: [],
        },
        {
            id: 'cycle-a', ownerUserId: owner.userId, createdByUserId: owner.userId,
            name: 'cycle-a', host: 'a.example', port: 22, protocol: 'SSH', username: 'root',
            password: 'secret-a', connectionMode: 'jump', jumpHostIds: ['jump-b'],
        },
        {
            id: 'cycle-b', ownerUserId: owner.userId, createdByUserId: owner.userId,
            name: 'cycle-b', host: 'b.example', port: 22, protocol: 'SSH', username: 'root',
            password: 'secret-b', connectionMode: 'jump', jumpHostIds: ['jump-a'],
        },
    ];
    const proxies = [
        { id: 'owner-proxy', ownerUserId: owner.userId, host: 'proxy.owner', port: 1080, password: 'owner-proxy-secret' },
        { id: 'shared-proxy', ownerUserId: shared.userId, host: 'proxy.shared', port: 1080, password: 'shared-proxy-secret' },
        { id: 'foreign-proxy', ownerUserId: foreign.userId, host: 'proxy.foreign', port: 1080, password: 'foreign-proxy-secret' },
    ];
    const jumpHosts = [
        { id: 'owner-jump', ownerUserId: owner.userId, name: 'owner jump', connectionId: 'hop' },
        { id: 'jump-a', ownerUserId: owner.userId, name: 'jump a', connectionId: 'cycle-a' },
        { id: 'jump-b', ownerUserId: owner.userId, name: 'jump b', connectionId: 'cycle-b' },
    ];
    const grants = new Set(['shared:connection:target']);
    const storage = {
        getConnectionById: (id) => connections.find((item) => item.id === id) || null,
        listAllConnectionRows: () => connections.map((item) => ({ ...item })),
        listJumpHosts: () => jumpHosts.map((item) => ({ ...item })),
        getProxyRaw: (id) => proxies.find((item) => item.id === id) || null,
        getSshKeyRaw: () => null,
    };
    const authz = {
        can(user, capability, resourceType, resourceId, resource) {
            return capability === CAP.USE && !!resource
                && (resource.ownerUserId === user.userId || grants.has(`${user.userId}:${resourceType}:${resourceId}`));
        },
        assertCan(user, capability, resourceType, resourceId, resource, { resourceExists = true } = {}) {
            if (!resourceExists || !this.can(user, capability, resourceType, resourceId, resource)) {
                throw new HttpError(resourceExists ? 403 : 404, 'denied', 'denied', false);
            }
        },
        audit() {},
    };
    return {
        owner,
        shared,
        foreign,
        connections,
        service: new ResourceService(storage, authz, { mobileChangeBridge: false }),
    };
}

test('unchanged shared connection keeps its owner-bound saved route', () => {
    const { service, shared, connections } = fixture();
    const saved = connections.find((item) => item.id === 'target');
    const result = service.resolveForConnectionTest(shared, { ...saved }, { savedConnectionId: saved.id });
    assert.equal(result.connection.host, 'target.example');
    assert.equal(result.routePlan.firstProxy.id, 'owner-proxy');
    assert.equal(result.routePlan.firstProxy.password, 'owner-proxy-secret');
});

test('shared-use caller cannot override any saved target or route dependency', () => {
    const { service, shared, connections } = fixture();
    const saved = connections.find((item) => item.id === 'target');
    const attempts = [
        { host: '127.0.0.1' },
        { port: 2375 },
        { protocol: 'RDP' },
        { connectionMode: 'direct', proxyId: null },
        { proxyId: 'foreign-proxy' },
        { connectionMode: 'jump', proxyId: null, jumpHostId: 'owner-jump', jumpHostIds: ['owner-jump'] },
        { sshKeyId: 'guessed-key' },
    ];
    for (const override of attempts) {
        assert.throws(
            () => service.resolveForConnectionTest(shared, { ...saved, ...override }, { savedConnectionId: saved.id }),
            (error) => error instanceof HttpError
                && error.status === 403
                && error.code === 'connection_test_override_forbidden',
        );
    }
});

test('draft tests authorize own proxy and hide missing versus foreign dependencies', () => {
    const { service, shared } = fixture();
    const own = service.resolveForConnectionTest(shared, {
        host: 'target.example', port: 3389, protocol: 'RDP',
        connectionMode: 'proxy', proxyId: 'shared-proxy',
    });
    assert.equal(own.connection.protocol, 'RDP');
    assert.equal(own.routePlan.firstProxy.id, 'shared-proxy');

    const failures = ['foreign-proxy', 'missing-proxy'].map((proxyId) => {
        try {
            service.resolveForConnectionTest(shared, {
                host: 'target.example', port: 23, protocol: 'TELNET', connectionMode: 'proxy', proxyId,
            });
            assert.fail(`expected ${proxyId} to be rejected`);
        } catch (error) {
            return { status: error.status, code: error.code, message: error.message };
        }
    });
    assert.deepEqual(failures[0], failures[1]);
    assert.deepEqual(failures[0], {
        status: 403,
        code: 'connection_test_dependency_unavailable',
        message: 'A connection test dependency is unavailable',
    });
});

test('owner preview authorizes an own jump graph and rejects dependency cycles', () => {
    const { service, owner, connections } = fixture();
    const saved = connections.find((item) => item.id === 'target');
    const valid = service.resolveForConnectionTest(owner, {
        ...saved,
        connectionMode: 'jump', proxyId: null,
        jumpHostId: 'owner-jump', jumpHostIds: ['owner-jump'],
    }, { savedConnectionId: saved.id });
    assert.equal(valid.routePlan.hops.length, 1);
    assert.equal(valid.routePlan.hops[0].id, 'hop');
    assert.equal(valid.routePlan.hops[0].password, 'owner-hop-secret');
    assert.equal(valid.routePlan.firstProxy.id, 'owner-proxy');

    assert.throws(
        () => service.resolveForConnectionTest(owner, {
            ...saved,
            connectionMode: 'jump', proxyId: null,
            jumpHostId: 'missing-jump', jumpHostIds: ['missing-jump'],
        }, { savedConnectionId: saved.id }),
        (error) => error instanceof HttpError
            && error.status === 403
            && error.code === 'connection_test_dependency_unavailable',
    );

    const cycle = connections.find((item) => item.id === 'cycle-a');
    assert.throws(
        () => service.resolveForConnectionTest(owner, { ...cycle }, { savedConnectionId: cycle.id }),
        (error) => error instanceof HttpError
            && error.status === 400
            && error.code === 'connection_test_invalid_route',
    );
});

test('route graph bounds reject deep acyclic graphs and memoize shared subgraphs', () => {
    const { service, owner, connections } = fixture();
    const jumpHosts = service.storage.listJumpHosts;
    const mutableJumpHosts = jumpHosts();
    service.storage.listJumpHosts = () => mutableJumpHosts.map((item) => ({ ...item }));

    for (let depth = 0; depth <= 9; depth += 1) {
        connections.push({
            id: `deep-${depth}`,
            ownerUserId: owner.userId,
            createdByUserId: owner.userId,
            name: `deep-${depth}`,
            host: `deep-${depth}.example`,
            port: 22,
            protocol: 'SSH',
            username: 'root',
            password: 'secret',
            connectionMode: depth === 9 ? 'direct' : 'jump',
            jumpHostIds: depth === 9 ? [] : [`deep-jump-${depth}`],
        });
        if (depth < 9) {
            mutableJumpHosts.push({
                id: `deep-jump-${depth}`,
                ownerUserId: owner.userId,
                name: `deep jump ${depth}`,
                connectionId: `deep-${depth + 1}`,
            });
        }
    }
    assert.throws(
        () => service.resolveForConnectionTest(owner, { ...connections.find((item) => item.id === 'deep-0') }, {
            savedConnectionId: 'deep-0',
        }),
        (error) => error instanceof HttpError
            && error.status === 400
            && error.code === 'connection_test_invalid_route',
    );

    connections.push({
        id: 'shared-leaf', ownerUserId: owner.userId, createdByUserId: owner.userId,
        name: 'shared-leaf', host: 'leaf.example', port: 22, protocol: 'SSH',
        username: 'root', password: 'secret', connectionMode: 'direct', jumpHostIds: [],
    });
    const rootJumpIds = [];
    for (let index = 0; index < 8; index += 1) {
        const branchId = `shared-branch-${index}`;
        const rootJumpId = `shared-root-jump-${index}`;
        const leafJumpId = `shared-leaf-jump-${index}`;
        connections.push({
            id: branchId, ownerUserId: owner.userId, createdByUserId: owner.userId,
            name: branchId, host: `${branchId}.example`, port: 22, protocol: 'SSH',
            username: 'root', password: 'secret', connectionMode: 'jump', jumpHostIds: [leafJumpId],
        });
        mutableJumpHosts.push(
            { id: rootJumpId, ownerUserId: owner.userId, name: rootJumpId, connectionId: branchId },
            { id: leafJumpId, ownerUserId: owner.userId, name: leafJumpId, connectionId: 'shared-leaf' },
        );
        rootJumpIds.push(rootJumpId);
    }
    connections.push({
        id: 'shared-root', ownerUserId: owner.userId, createdByUserId: owner.userId,
        name: 'shared-root', host: 'root.example', port: 23, protocol: 'TELNET',
        connectionMode: 'jump', jumpHostIds: rootJumpIds,
    });
    const sharedGraph = service.resolveForConnectionTest(
        owner,
        { ...connections.find((item) => item.id === 'shared-root') },
        { savedConnectionId: 'shared-root' },
    );
    assert.equal(sharedGraph.routePlan.hops.length, 8);
});
