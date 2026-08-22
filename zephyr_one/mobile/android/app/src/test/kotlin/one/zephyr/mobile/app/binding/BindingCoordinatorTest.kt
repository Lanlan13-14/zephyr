package one.zephyr.mobile.app.binding

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.test.runTest
import one.zephyr.mobile.contracts.BindingState
import one.zephyr.mobile.contracts.SyncPhase
import one.zephyr.mobile.model.AccountBinding
import one.zephyr.mobile.model.NetworkPolicy
import one.zephyr.mobile.model.ServerCapabilities
import one.zephyr.mobile.model.ServerProfile
import one.zephyr.mobile.model.SyncTrigger
import one.zephyr.mobile.model.TlsPolicy
import one.zephyr.mobile.network.ApiResult
import one.zephyr.mobile.security.DeviceIdentity
import one.zephyr.mobile.sync.SyncRoundResult
import one.zephyr.mobile.sync.SyncSettings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BindingCoordinatorTest {

    @Test
    fun `production login creates a gateway for the selected profile`() = runTest {
        val expectedProfile = profile()
        val gateway = FakeGateway()
        var createdFor: ServerProfile? = null
        val coordinator = coordinator(
            FakeStorage(mutableListOf()),
            FakeHost(mutableListOf()),
            mutableListOf(),
            mutableListOf(),
            gatewayFactory = BindingGatewayFactory { selected ->
                createdFor = selected
                gateway
            },
        )

        val password = "password".toCharArray()
        val result = coordinator.login(expectedProfile, "alice", password)

        assertTrue(result is BindingAuthenticationResult.Authenticated)
        assertEquals(expectedProfile, createdFor)
        assertTrue(password.all { it == '\u0000' })
    }

    @Test
    fun `bind persists credentials and enters bootstrap`() = runTest {
        val events = mutableListOf<String>()
        val storage = FakeStorage(events)
        val host = FakeHost(events)
        val graphs = mutableListOf<FakeGraph>()
        val gateway = FakeGateway()
        val coordinator = coordinator(storage, host, graphs, events)

        val password = "password".toCharArray()
        val login = coordinator.login(profile(), "alice", password, gateway)
        assertTrue(login is BindingAuthenticationResult.Authenticated)
        assertTrue(password.all { it == '\u0000' })

        val verificationSecret = "123456".toCharArray()
        val result = coordinator.completeBinding(bindingRequest(), verificationSecret)

        result as BindingCompletionResult.Completed
        assertTrue(result.bootstrapSucceeded)
        assertEquals(BindingState.IDLE, storage.active?.binding?.state)
        assertEquals(1, graphs.single().bootstrapCalls)
        assertEquals("access-1", graphs.single().storedAccess)
        assertEquals("refresh-1", graphs.single().storedRefresh)
        assertTrue(gateway.authenticationCleared)
        assertTrue(verificationSecret.all { it == '\u0000' })
        assertEquals("device.bind", gateway.sensitiveAction)
        assertEquals(listOf("token-1", "device-1"), gateway.sensitiveTargets)
        assertEquals("sensitive-grant-1", gateway.grantUsedForBind)
    }

    @Test
    fun `consumed enrollment binds without a Client Token or password`() = runTest {
        val events = mutableListOf<String>()
        val storage = FakeStorage(events)
        val host = FakeHost(events)
        val graphs = mutableListOf<FakeGraph>()
        val coordinator = coordinator(storage, host, graphs, events)
        val gateway = FakeGateway()
        val prepared = BindingCoordinator.PreparedEnrollment(
            profile = profile(),
            gateway = gateway,
            identity = FakeIdentity(),
            command = DeviceBindingCommand(
                deviceId = "device-1",
                deviceName = "Phone",
                tokenId = LINK_ENROLLMENT_TOKEN_ID,
                publicKeys = FakeIdentity().ensureKeys(),
                syncIntervalSec = 300,
            ),
            created = one.zephyr.mobile.network.dto.LinkEnrollmentCreateResponseDto(
                ok = true,
                bindId = "bind-1",
                userCode = "ABCD-EFGH",
                enrollmentSecret = "enrollment-secret-1",
                verificationUri = "https://zephyr.example/link/approve?bindId=bind-1",
                sas = "AAAA-BBBB-CCCC-DDDD",
                fingerprint = "a".repeat(64),
                expiresAt = 9_000L,
                serverId = "srv-1",
                deviceId = "device-1",
                deviceName = "Phone",
                platform = "android",
            ),
        )

        val result = coordinator.consumePreparedEnrollment(
            prepared = prepared,
            intervalSec = 300,
            automaticEnabled = true,
            networkPolicy = NetworkPolicy.ANY,
        )

        result as BindingCompletionResult.Completed
        assertTrue(result.bootstrapSucceeded)
        assertEquals(LINK_ENROLLMENT_TOKEN_ID, result.binding.tokenId)
        assertEquals("alice", result.binding.username)
        assertEquals("access-1", graphs.single().storedAccess)
        assertEquals(
            listOf(
                "storage.save",
                "graph.activate",
                "host.attach",
                "graph.bootstrap",
                "graph.database.ready",
                "storage.ready",
            ),
            events.takeLast(6),
        )
    }

    @Test
    fun `device local workspace binds as first persisted account`() = runTest {
        val events = mutableListOf<String>()
        val storage = FakeStorage(events)
        val host = FakeHost(events)
        val local = FakeGraph(
            binding = storedBinding().binding.copy(serverProfileId = "_local", userId = "local"),
            events = events,
            initiallyRecoverable = true,
            databaseRequiresBootstrap = false,
            deviceLocal = true,
        )
        host.attachGraph(local)
        events.clear()
        val graphs = mutableListOf<FakeGraph>()
        val gateway = FakeGateway()
        val coordinator = coordinator(storage, host, graphs, events)

        assertTrue(
            coordinator.login(profile(), "alice", "password".toCharArray(), gateway) is
                BindingAuthenticationResult.Authenticated,
        )
        val result = coordinator.completeBinding(bindingRequest(), "123456".toCharArray())

        assertTrue(result is BindingCompletionResult.Completed)
        assertEquals("server-1", storage.active?.binding?.serverProfileId)
        assertTrue("storage.save" in events)
        assertFalse("storage.replace" in events)
        assertTrue("graph.stop" in events)
    }

    @Test
    fun `must change password blocks binding and clears authentication`() = runTest {
        val gateway = FakeGateway(
            loginReply = BindingLoginReply.Authenticated(
                AuthenticatedBindingAccount("user-1", "alice", mustChangePassword = true),
            ),
        )
        val coordinator = coordinator(
            FakeStorage(mutableListOf()),
            FakeHost(mutableListOf()),
            mutableListOf(),
            mutableListOf(),
        )

        val result = coordinator.login(profile(), "alice", "password".toCharArray(), gateway)

        assertTrue(result is BindingAuthenticationResult.PasswordChangeRequired)
        assertTrue(gateway.authenticationCleared)
        assertTrue(
            coordinator.completeBinding(bindingRequest(), "123456".toCharArray()) is
                BindingCompletionResult.AuthenticationRequired,
        )
    }

    @Test
    fun `totp verification forwards the login temp token`() = runTest {
        val storage = FakeStorage(mutableListOf())
        val gateway = FakeGateway(loginReply = BindingLoginReply.TotpRequired("temporary-login-token"))
        val coordinator = coordinator(storage, FakeHost(mutableListOf()), mutableListOf(), mutableListOf())

        assertTrue(
            coordinator.login(profile(), "alice", "password".toCharArray(), gateway) is
                BindingAuthenticationResult.TotpRequired,
        )
        val code = "123456".toCharArray()
        val verified = coordinator.verifyTotp(code)

        assertTrue(verified is BindingAuthenticationResult.Authenticated)
        assertEquals("temporary-login-token" to "123456", gateway.totpCall)
        assertTrue(code.all { it == '\u0000' })
    }

    @Test
    fun `lock clears pending TOTP challenge and later verification fails closed`() = runTest {
        val tempToken = "temporary-login-token".toCharArray()
        val gateway = FakeGateway(loginReply = BindingLoginReply.TotpRequired(tempToken))
        val coordinator = coordinator(
            FakeStorage(mutableListOf()),
            FakeHost(mutableListOf()),
            mutableListOf(),
            mutableListOf(),
        )
        coordinator.login(profile(), "alice", "password".toCharArray(), gateway)

        coordinator.onLocked()

        assertTrue(tempToken.all { it == '\u0000' })
        assertTrue(gateway.authenticationCleared)
        val code = "123456".toCharArray()
        assertTrue(coordinator.verifyTotp(code) is BindingAuthenticationResult.Failed)
        assertTrue(code.all { it == '\u0000' })
    }

    @Test
    fun `lock overwrites password while login request is still in flight`() = runTest {
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val gateway = FakeGateway(loginEntered = entered, loginRelease = release)
        val coordinator = coordinator(
            FakeStorage(mutableListOf()),
            FakeHost(mutableListOf()),
            mutableListOf(),
            mutableListOf(),
        )
        val password = "password".toCharArray()
        val login = async { coordinator.login(profile(), "alice", password, gateway) }
        entered.await()

        coordinator.onLocked()

        assertTrue(password.all { it == '\u0000' })
        release.complete(Unit)
        assertTrue(login.await() is BindingAuthenticationResult.Failed)
        assertTrue(gateway.authenticationCleared)
    }

    @Test
    fun `unbind clears pending TOTP material before erasing storage`() = runTest {
        val tempToken = "temporary-login-token".toCharArray()
        val events = mutableListOf<String>()
        val gateway = FakeGateway(loginReply = BindingLoginReply.TotpRequired(tempToken))
        val storage = FakeStorage(events).apply { active = storedBinding() }
        val coordinator = coordinator(
            storage,
            FakeHost(events),
            mutableListOf(),
            events,
        )
        coordinator.login(profile(), "alice", "password".toCharArray(), gateway)

        coordinator.unbind()

        assertTrue(tempToken.all { it == '\u0000' })
        assertTrue(gateway.authenticationCleared)
        assertNull(storage.active)
        assertEquals("journal.clear", events.last())
    }

    @Test
    fun `process recreation restores graph and matching worker runs a pull round`() = runTest {
        val persisted = storedBinding(boundAt = 100L)
        val storage = FakeStorage(mutableListOf()).apply { active = persisted }

        val firstGraphs = mutableListOf<FakeGraph>()
        val first = coordinator(
            storage,
            FakeHost(mutableListOf()),
            firstGraphs,
            mutableListOf(),
            restoredGraphsAreRecoverable = true,
        )
        assertTrue(first.restoreActiveBinding() is BindingRestoreResult.Restored)

        // A new host/coordinator models process death: no in-memory graph is carried across.
        val recreatedGraphs = mutableListOf<FakeGraph>()
        val recreated = coordinator(
            storage,
            FakeHost(mutableListOf()),
            recreatedGraphs,
            mutableListOf(),
            restoredGraphsAreRecoverable = true,
        )
        assertTrue(recreated.restoreActiveBinding() is BindingRestoreResult.Restored)
        val graph = recreatedGraphs.single()

        val workerGraph = recreated.graphForWorker(graph.bindingKey, graph.generation)
        assertNotNull(workerGraph)
        workerGraph!!.runScheduledRound()
        assertEquals(1, graph.scheduledCalls)
    }

    @Test
    fun `legacy migration restore completes bootstrap before marking scoped database ready`() = runTest {
        val events = mutableListOf<String>()
        val storage = FakeStorage(events).apply {
            active = storedBinding().copy(requiresBootstrap = true)
        }
        val graphs = mutableListOf<FakeGraph>()
        val coordinator = coordinator(
            storage,
            FakeHost(events),
            graphs,
            events,
            restoredGraphsAreRecoverable = true,
        )

        val result = coordinator.restoreActiveBinding()

        assertTrue(result is BindingRestoreResult.Restored)
        assertEquals(1, graphs.single().bootstrapCalls)
        assertEquals(
            listOf(
                "graph.activate",
                "host.attach",
                "graph.bootstrap",
                "graph.database.ready",
                "storage.ready",
            ),
            events.takeLast(5),
        )
    }

    @Test
    fun `graph is not published when startup recovery fails`() = runTest {
        val events = mutableListOf<String>()
        val storage = FakeStorage(events).apply { active = storedBinding() }
        val host = FakeHost(events)
        val coordinator = coordinator(
            storage,
            host,
            mutableListOf(),
            events,
            restoredGraphsAreRecoverable = true,
            restoredGraphStartFailures = 1,
        )

        assertTrue(runCatching { coordinator.restoreActiveBinding() }.isFailure)
        assertNull(host.currentGraph())
        assertEquals(listOf("graph.activate"), events.takeLast(1))
        assertFalse(events.contains("host.attach"))
    }

    @Test
    fun `missing scoped readiness marker forces bootstrap after process recovery`() = runTest {
        val events = mutableListOf<String>()
        val storage = FakeStorage(events).apply { active = storedBinding() }
        val graphs = mutableListOf<FakeGraph>()
        val coordinator = coordinator(
            storage,
            FakeHost(events),
            graphs,
            events,
            restoredGraphsAreRecoverable = true,
            restoredDatabaseRequiresBootstrap = true,
        )

        assertTrue(coordinator.restoreActiveBinding() is BindingRestoreResult.Restored)

        assertEquals(1, graphs.single().bootstrapCalls)
        assertEquals(1, graphs.single().databaseReadyCalls)
        assertEquals(
            listOf("graph.bootstrap", "graph.database.ready", "storage.ready"),
            events.takeLast(3),
        )
    }

    @Test
    fun `legacy pending writes block restore without erasing storage or creating graph`() = runTest {
        val events = mutableListOf<String>()
        val persisted = storedBinding()
        val storage = FakeStorage(events).apply {
            active = persisted
            blockRestoreWithPendingWrites = 2
        }
        val graphs = mutableListOf<FakeGraph>()
        val coordinator = coordinator(
            storage,
            FakeHost(events),
            graphs,
            events,
            restoredGraphsAreRecoverable = true,
        )

        val result = coordinator.restoreActiveBinding()

        result as BindingRestoreResult.Invalidated
        assertEquals(LegacyAccountDatabaseMigration.BLOCKED_ERROR_CODE, result.reason)
        assertEquals(persisted, storage.active)
        assertTrue(graphs.isEmpty())
        assertFalse(events.contains("storage.erase"))
    }

    @Test
    fun `legacy pending writes reject a new bind before account graph opens`() = runTest {
        val events = mutableListOf<String>()
        val storage = FakeStorage(events).apply { blockSaveWithPendingWrites = 1 }
        val graphs = mutableListOf<FakeGraph>()
        val gateway = FakeGateway()
        val coordinator = coordinator(storage, FakeHost(events), graphs, events)
        coordinator.login(profile(), "alice", "password".toCharArray(), gateway)

        val result = coordinator.completeBinding(bindingRequest(), "123456".toCharArray())

        result as BindingCompletionResult.Failed
        assertEquals(LegacyAccountDatabaseMigration.BLOCKED_ERROR_CODE, result.error.code)
        assertNull(storage.active)
        assertTrue(graphs.isEmpty())
        assertTrue(gateway.authenticationCleared)
    }

    @Test
    fun `worker without current binding identity fails closed`() = runTest {
        val storage = FakeStorage(mutableListOf()).apply { active = storedBinding(boundAt = 200L) }
        val graphs = mutableListOf<FakeGraph>()
        val coordinator = coordinator(
            storage,
            FakeHost(mutableListOf()),
            graphs,
            mutableListOf(),
            restoredGraphsAreRecoverable = true,
        )
        coordinator.restoreActiveBinding()
        val current = graphs.single()

        assertNull(coordinator.graphForWorker(null, null))
        assertNull(coordinator.graphForWorker(current.bindingKey, "0:old-generation"))
        assertNull(coordinator.graphForWorker("different/account/device", current.generation))
        assertEquals(0, current.scheduledCalls)
    }

    @Test
    fun `worker gate remains closed until startup binding recovery has completed`() = runTest {
        val stored = storedBinding(boundAt = 200L)
        val coordinator = coordinator(
            FakeStorage(mutableListOf()).apply { active = stored },
            FakeHost(mutableListOf()),
            mutableListOf(),
            mutableListOf(),
            restoredGraphsAreRecoverable = true,
        )

        assertFalse(coordinator.workersAreReady())
        assertNull(coordinator.graphForWorker(BindingTeardownScope.of(stored.binding).bindingKey, BindingGeneration.of(stored.binding)))

        coordinator.restoreActiveBinding()

        assertTrue(coordinator.workersAreReady())
    }

    @Test
    fun `no-account startup persists cleanup intent before global sweep`() = runTest {
        val events = mutableListOf<String>()
        val journal = FakeNoAccountCleanupJournal(events = events)
        val wiper = FakeNoAccountStateWiper(events = events)
        val coordinator = coordinator(
            storage = FakeStorage(events),
            host = FakeHost(events),
            graphs = mutableListOf(),
            events = events,
            noAccountCleanupJournal = journal,
            noAccountStateWiper = wiper,
        )

        assertEquals(BindingRestoreResult.Unbound, coordinator.restoreActiveBinding())

        assertEquals(listOf("global.persist", "global.wipe", "global.clear"), events)
        assertFalse(journal.value)
        assertTrue(coordinator.workersAreReady())
    }

    @Test
    fun `failed no-account cleanup survives restart and blocks binding until retry succeeds`() = runTest {
        val events = mutableListOf<String>()
        val storage = FakeStorage(events)
        val journal = FakeNoAccountCleanupJournal()
        val wiper = FakeNoAccountStateWiper().apply { result = false }
        val first = coordinator(
            storage = storage,
            host = FakeHost(events),
            graphs = mutableListOf(),
            events = events,
            noAccountCleanupJournal = journal,
            noAccountStateWiper = wiper,
        )

        val failed = first.restoreActiveBinding() as BindingRestoreResult.LocalCleanupRequired
        assertEquals("local_cleanup_pending", failed.error.code)
        assertTrue(failed.error.retryable)
        assertTrue(journal.value)
        assertFalse(first.workersAreReady())

        val login = first.login(profile(), "alice", "password".toCharArray(), FakeGateway())
            as BindingAuthenticationResult.Failed
        assertEquals("local_cleanup_pending", login.error.code)
        assertTrue(login.error.retryable)

        wiper.result = true
        val restarted = coordinator(
            storage = storage,
            host = FakeHost(events),
            graphs = mutableListOf(),
            events = events,
            noAccountCleanupJournal = journal,
            noAccountStateWiper = wiper,
        )
        assertEquals(BindingRestoreResult.Unbound, restarted.restoreActiveBinding())
        assertFalse(journal.value)
        assertEquals(2, wiper.calls)
        assertTrue(restarted.workersAreReady())
    }

    @Test
    fun `no-account marker write failure blocks sweep and retries cleanly`() = runTest {
        val events = mutableListOf<String>()
        val journal = FakeNoAccountCleanupJournal().apply { persistFailures = 1 }
        val wiper = FakeNoAccountStateWiper()
        val coordinator = coordinator(
            storage = FakeStorage(events),
            host = FakeHost(events),
            graphs = mutableListOf(),
            events = events,
            noAccountCleanupJournal = journal,
            noAccountStateWiper = wiper,
        )

        assertTrue(coordinator.restoreActiveBinding() is BindingRestoreResult.LocalCleanupRequired)
        assertFalse(journal.value)
        assertEquals(0, wiper.calls)

        assertEquals(BindingRestoreResult.Unbound, coordinator.restoreActiveBinding())
        assertEquals(1, wiper.calls)
        assertFalse(journal.value)
    }

    @Test
    fun `no-account marker clear failure retains durable retry proof`() = runTest {
        val events = mutableListOf<String>()
        val journal = FakeNoAccountCleanupJournal().apply { clearFailures = 1 }
        val wiper = FakeNoAccountStateWiper()
        val coordinator = coordinator(
            storage = FakeStorage(events),
            host = FakeHost(events),
            graphs = mutableListOf(),
            events = events,
            noAccountCleanupJournal = journal,
            noAccountStateWiper = wiper,
        )

        assertTrue(coordinator.restoreActiveBinding() is BindingRestoreResult.LocalCleanupRequired)
        assertTrue(journal.value)
        assertFalse(coordinator.workersAreReady())

        assertEquals(BindingRestoreResult.Unbound, coordinator.restoreActiveBinding())
        assertEquals(2, wiper.calls)
        assertFalse(journal.value)
    }

    @Test
    fun `binding appearing during global sweep leaves marker and graph unpublished`() = runTest {
        val events = mutableListOf<String>()
        val storage = FakeStorage(events)
        val journal = FakeNoAccountCleanupJournal()
        val wiper = FakeNoAccountStateWiper().apply {
            onWipe = { storage.active = storedBinding(boundAt = 200L) }
        }
        val graphs = mutableListOf<FakeGraph>()
        val coordinator = coordinator(
            storage = storage,
            host = FakeHost(events),
            graphs = graphs,
            events = events,
            restoredGraphsAreRecoverable = true,
            noAccountCleanupJournal = journal,
            noAccountStateWiper = wiper,
        )

        assertTrue(coordinator.restoreActiveBinding() is BindingRestoreResult.LocalCleanupRequired)
        assertTrue(journal.value)
        assertTrue(graphs.isEmpty())
        assertFalse(coordinator.workersAreReady())

        assertTrue(coordinator.restoreActiveBinding() is BindingRestoreResult.LocalCleanupRequired)
        assertEquals(1, wiper.calls)
        assertTrue(graphs.isEmpty())
    }

    @Test
    fun `residual global marker never sweeps an active binding`() = runTest {
        val events = mutableListOf<String>()
        val journal = FakeNoAccountCleanupJournal(initialValue = true)
        val wiper = FakeNoAccountStateWiper()
        val graphs = mutableListOf<FakeGraph>()
        val coordinator = coordinator(
            storage = FakeStorage(events).apply { active = storedBinding(boundAt = 200L) },
            host = FakeHost(events),
            graphs = graphs,
            events = events,
            restoredGraphsAreRecoverable = true,
            noAccountCleanupJournal = journal,
            noAccountStateWiper = wiper,
        )

        val result = coordinator.restoreActiveBinding() as BindingRestoreResult.LocalCleanupRequired

        assertEquals("local_cleanup_pending", result.error.code)
        assertEquals(0, wiper.calls)
        assertTrue(graphs.isEmpty())
        assertTrue(journal.value)
        assertFalse(coordinator.workersAreReady())
    }

    @Test
    fun `startup aborts a prepared replacement and preserves the old credential winner`() = runTest {
        val events = mutableListOf<String>()
        val old = storedBinding(boundAt = 100L)
        val next = storedBinding(boundAt = 101L)
        val storage = FakeStorage(events).apply { active = old }
        val journal = FakeReplacementJournal(events).apply {
            value = BindingReplacementRecord(
                previous = BindingTeardownScope.of(old.binding),
                next = next,
                stage = BindingReplacementStage.PREPARED,
            )
        }
        val wiper = FakePreparedStateWiper(events)
        val graphs = mutableListOf<FakeGraph>()
        val coordinator = coordinator(
            storage = storage,
            host = FakeHost(events),
            graphs = graphs,
            events = events,
            graphRecoverability = { it.binding == old.binding },
            replacementJournal = journal,
            preparedStateWiper = wiper,
        )

        assertTrue(coordinator.restoreActiveBinding() is BindingRestoreResult.Restored)

        assertEquals(old.binding, storage.active?.binding)
        assertNull(journal.value)
        assertEquals(listOf(BindingTeardownScope.of(next.binding)), wiper.scopes)
        assertEquals(1, graphs.size)
        assertEquals(old.binding, graphs.single().binding)
        assertTrue(coordinator.workersAreReady())
    }

    @Test
    fun `startup promotes prepared replacement only when the new binding row is durable`() = runTest {
        val events = mutableListOf<String>()
        val old = storedBinding(boundAt = 100L)
        val next = storedBinding(boundAt = 101L)
        val storage = FakeStorage(events).apply { active = next }
        val journal = FakeReplacementJournal(events).apply {
            value = replacementRecord(old, next, BindingReplacementStage.PREPARED)
        }
        val wiper = FakeScopeStateWiper(events)
        val graphs = mutableListOf<FakeGraph>()
        val coordinator = coordinator(
            storage = storage,
            host = FakeHost(events),
            graphs = graphs,
            events = events,
            graphRecoverability = { it.binding == next.binding },
            replacementJournal = journal,
            scopeStateWiper = wiper,
        )

        assertTrue(coordinator.restoreActiveBinding() is BindingRestoreResult.Restored)

        assertEquals(next.binding, storage.active?.binding)
        assertNull(journal.value)
        assertEquals(listOf(BindingTeardownScope.of(old.binding)), wiper.scopes)
        assertEquals(next.binding, graphs.single().binding)
        assertTrue(events.indexOf("replacement.COMMITTED") < events.indexOf("replacement.OLD_FENCED"))
        assertTrue(events.indexOf("replacement.COMMITTED") < events.indexOf("graph.activate"))
        assertEquals(1, graphs.single().activationCalls)
    }

    @Test
    fun `committed marker cannot replace an old binding row that still owns the credentials`() = runTest {
        val events = mutableListOf<String>()
        val old = storedBinding(boundAt = 100L)
        val next = storedBinding(boundAt = 101L)
        val storage = FakeStorage(events).apply { active = old }
        val journal = FakeReplacementJournal(events).apply {
            value = replacementRecord(old, next, BindingReplacementStage.COMMITTED)
        }
        val wiper = FakePreparedStateWiper(events)
        val graphs = mutableListOf<FakeGraph>()

        val result = coordinator(
            storage = storage,
            host = FakeHost(events),
            graphs = graphs,
            events = events,
            graphRecoverability = { it.binding == old.binding },
            replacementJournal = journal,
            preparedStateWiper = wiper,
        ).restoreActiveBinding()

        assertTrue(result is BindingRestoreResult.Restored)
        assertEquals(old.binding, storage.active?.binding)
        assertNull(journal.value)
        assertEquals(listOf(BindingTeardownScope.of(next.binding)), wiper.scopes)
        assertEquals(old.binding, graphs.single().binding)
    }

    @Test
    fun `startup resumes every committed replacement transition`() = runTest {
        val resumableStages = listOf(
            BindingReplacementStage.COMMITTED,
            BindingReplacementStage.OLD_FENCED,
            BindingReplacementStage.NEXT_STARTED,
            BindingReplacementStage.PUBLISHED,
        )

        resumableStages.forEach { stage ->
            val events = mutableListOf<String>()
            val old = storedBinding(boundAt = 100L)
            val next = storedBinding(boundAt = 101L)
            val storage = FakeStorage(events).apply { active = next }
            val journal = FakeReplacementJournal(events).apply {
                value = replacementRecord(old, next, stage)
            }
            val wiper = FakeScopeStateWiper(events)
            val graphs = mutableListOf<FakeGraph>()
            val coordinator = coordinator(
                storage = storage,
                host = FakeHost(events),
                graphs = graphs,
                events = events,
                graphRecoverability = { it.binding == next.binding },
                replacementJournal = journal,
                scopeStateWiper = wiper,
            )

            assertTrue("stage=$stage", coordinator.restoreActiveBinding() is BindingRestoreResult.Restored)
            assertNull("stage=$stage", journal.value)
            assertEquals("stage=$stage", next.binding, storage.active?.binding)
            assertEquals("stage=$stage", listOf(BindingTeardownScope.of(old.binding)), wiper.scopes)
            assertEquals("stage=$stage", next.binding, graphs.single().binding)
            assertEquals("stage=$stage", 1, graphs.single().activationCalls)
        }
    }

    @Test
    fun `startup after old teardown only clears the replacement proof`() = runTest {
        val events = mutableListOf<String>()
        val old = storedBinding(boundAt = 100L)
        val next = storedBinding(boundAt = 101L)
        val storage = FakeStorage(events).apply { active = next }
        val journal = FakeReplacementJournal(events).apply {
            value = replacementRecord(old, next, BindingReplacementStage.OLD_TORN_DOWN)
        }
        val wiper = FakeScopeStateWiper(events)
        val graphs = mutableListOf<FakeGraph>()

        val result = coordinator(
            storage = storage,
            host = FakeHost(events),
            graphs = graphs,
            events = events,
            graphRecoverability = { it.binding == next.binding },
            replacementJournal = journal,
            scopeStateWiper = wiper,
        ).restoreActiveBinding()

        assertTrue(result is BindingRestoreResult.Restored)
        assertNull(journal.value)
        assertTrue(wiper.scopes.isEmpty())
        assertEquals(next.binding, graphs.single().binding)
    }

    @Test
    fun `replacement storage failure aborts prepare without disturbing the live old graph`() = runTest {
        val events = mutableListOf<String>()
        val old = storedBinding(boundAt = 99L)
        val storage = FakeStorage(events).apply {
            active = old
            replaceFailures = 1
        }
        val host = FakeHost(events)
        val journal = FakeReplacementJournal(events)
        val graphs = mutableListOf<FakeGraph>()
        val coordinator = coordinator(
            storage = storage,
            host = host,
            graphs = graphs,
            events = events,
            restoredGraphsAreRecoverable = true,
            replacementJournal = journal,
        )
        coordinator.restoreActiveBinding()
        val oldGraph = graphs.single()
        coordinator.login(profile(), "alice", "password".toCharArray(), FakeGateway())

        assertTrue(runCatching { coordinator.completeBinding(bindingRequest(), "123456".toCharArray()) }.isFailure)

        assertEquals(old.binding, storage.active?.binding)
        assertTrue(host.currentGraph() === oldGraph)
        assertFalse(oldGraph.wiped)
        assertTrue(oldGraph.isRecoverable())
        assertTrue(graphs.last().preparedDiscarded)
        assertFalse(graphs.last().wiped)
        assertFalse(graphs.last().isRecoverable())
        assertEquals(0, graphs.last().activationCalls)
        assertNull(journal.value)
        assertNotNull(coordinator.graphForWorker(oldGraph.bindingKey, oldGraph.generation))
    }

    @Test
    fun `replacement storage failure with journal clear failure retries before reopening old workers`() = runTest {
        val events = mutableListOf<String>()
        val old = storedBinding(boundAt = 99L)
        val storage = FakeStorage(events).apply {
            active = old
            replaceFailures = 1
        }
        val host = FakeHost(events)
        val journal = FakeReplacementJournal(events).apply { clearFailures = 1 }
        val wiper = FakePreparedStateWiper(events)
        val graphs = mutableListOf<FakeGraph>()
        val coordinator = coordinator(
            storage = storage,
            host = host,
            graphs = graphs,
            events = events,
            restoredGraphsAreRecoverable = true,
            replacementJournal = journal,
            preparedStateWiper = wiper,
        )
        coordinator.restoreActiveBinding()
        val oldGraph = graphs.single()
        coordinator.login(profile(), "alice", "password".toCharArray(), FakeGateway())

        assertTrue(runCatching { coordinator.completeBinding(bindingRequest(), "123456".toCharArray()) }.isFailure)
        assertEquals(BindingReplacementStage.PREPARED, journal.value?.stage)
        val preparedNextScope = checkNotNull(journal.value).nextScope
        assertNull(coordinator.graphForWorker(oldGraph.bindingKey, oldGraph.generation))
        assertFalse(oldGraph.wiped)
        assertTrue(graphs.last().preparedDiscarded)
        assertEquals(0, graphs.last().activationCalls)

        assertTrue(coordinator.restoreActiveBinding() is BindingRestoreResult.Restored)
        assertNull(journal.value)
        assertTrue(host.currentGraph() === oldGraph)
        assertFalse(oldGraph.wiped)
        assertEquals(listOf(preparedNextScope), wiper.scopes)
        assertNotNull(coordinator.graphForWorker(oldGraph.bindingKey, oldGraph.generation))
    }

    @Test
    fun `replacement retries cleanly after a storage failure`() = runTest {
        val events = mutableListOf<String>()
        val old = storedBinding(boundAt = 99L)
        val storage = FakeStorage(events).apply {
            active = old
            replaceFailures = 1
        }
        val host = FakeHost(events)
        val journal = FakeReplacementJournal(events)
        val graphs = mutableListOf<FakeGraph>()
        val coordinator = coordinator(
            storage = storage,
            host = host,
            graphs = graphs,
            events = events,
            restoredGraphsAreRecoverable = true,
            replacementJournal = journal,
        )
        coordinator.restoreActiveBinding()
        coordinator.login(profile(), "alice", "password".toCharArray(), FakeGateway())
        assertTrue(runCatching { coordinator.completeBinding(bindingRequest(), "123456".toCharArray()) }.isFailure)

        coordinator.login(profile(), "alice", "password".toCharArray(), FakeGateway())
        val retried = coordinator.completeBinding(bindingRequest(), "123456".toCharArray())

        assertTrue(retried is BindingCompletionResult.Completed)
        assertEquals(100L, storage.active?.binding?.boundAt)
        assertNull(journal.value)
        assertTrue(host.currentGraph() === graphs.last())
        assertTrue(coordinator.workersAreReady())
        assertTrue(events.lastIndexOf("replacement.COMMITTED") < events.lastIndexOf("graph.stop"))
        assertTrue(events.lastIndexOf("graph.stop") < events.lastIndexOf("graph.activate"))
    }

    @Test
    fun `post commit storage fault leaves credentials for recovery`() = runTest {
        val events = mutableListOf<String>()
        val old = storedBinding(boundAt = 99L)
        val storage = FakeStorage(events).apply {
            active = old
            replaceAfterWriteFailures = 1
            bindingForTeardownFailures = 1
        }
        val journal = FakeReplacementJournal(events)
        val firstGraphs = mutableListOf<FakeGraph>()
        val first = coordinator(
            storage = storage,
            host = FakeHost(events),
            graphs = firstGraphs,
            events = events,
            restoredGraphsAreRecoverable = true,
            replacementJournal = journal,
        )
        first.restoreActiveBinding()
        first.login(profile(), "alice", "password".toCharArray(), FakeGateway())

        assertTrue(runCatching { first.completeBinding(bindingRequest(), "123456".toCharArray()) }.isFailure)
        val preparedNext = firstGraphs.last()
        assertFalse(preparedNext.wiped)
        assertFalse(preparedNext.preparedDiscarded)
        assertEquals(0, preparedNext.activationCalls)
        assertEquals(BindingReplacementStage.PREPARED, journal.value?.stage)
        assertEquals(100L, storage.active?.binding?.boundAt)

        val recoveredGraphs = mutableListOf<FakeGraph>()
        val recovered = coordinator(
            storage = storage,
            host = FakeHost(events),
            graphs = recoveredGraphs,
            events = events,
            restoredGraphsAreRecoverable = true,
            replacementJournal = journal,
        )
        assertTrue(recovered.restoreActiveBinding() is BindingRestoreResult.Restored)
        assertNull(journal.value)
        assertEquals(100L, recoveredGraphs.single().binding.boundAt)
        assertEquals(1, recoveredGraphs.single().activationCalls)
    }

    @Test
    fun `commit marker failure recovers from the durable new binding row`() = runTest {
        val events = mutableListOf<String>()
        val old = storedBinding(boundAt = 99L)
        val storage = FakeStorage(events).apply { active = old }
        val journal = FakeReplacementJournal(events).apply { advanceFailures = 1 }
        val firstGraphs = mutableListOf<FakeGraph>()
        val first = coordinator(
            storage = storage,
            host = FakeHost(events),
            graphs = firstGraphs,
            events = events,
            restoredGraphsAreRecoverable = true,
            replacementJournal = journal,
        )
        first.restoreActiveBinding()
        first.login(profile(), "alice", "password".toCharArray(), FakeGateway())

        assertTrue(runCatching { first.completeBinding(bindingRequest(), "123456".toCharArray()) }.isFailure)
        assertEquals(BindingReplacementStage.PREPARED, journal.value?.stage)
        assertEquals(100L, storage.active?.binding?.boundAt)
        assertFalse(firstGraphs.last().wiped)
        assertEquals(0, firstGraphs.last().activationCalls)

        val recoveredGraphs = mutableListOf<FakeGraph>()
        val recovered = coordinator(
            storage = storage,
            host = FakeHost(events),
            graphs = recoveredGraphs,
            events = events,
            restoredGraphsAreRecoverable = true,
            replacementJournal = journal,
        )

        assertTrue(recovered.restoreActiveBinding() is BindingRestoreResult.Restored)
        assertNull(journal.value)
        assertEquals(100L, recoveredGraphs.single().binding.boundAt)
        assertEquals(1, recoveredGraphs.single().activationCalls)
    }

    @Test
    fun `prepared clear failure retries without wiping the old scope`() = runTest {
        val events = mutableListOf<String>()
        val old = storedBinding(boundAt = 100L)
        val next = storedBinding(boundAt = 101L)
        val storage = FakeStorage(events).apply { active = old }
        val journal = FakeReplacementJournal(events).apply {
            value = replacementRecord(old, next, BindingReplacementStage.PREPARED)
            clearFailures = 1
        }
        val wiper = FakePreparedStateWiper(events)
        val graphs = mutableListOf<FakeGraph>()
        val coordinator = coordinator(
            storage = storage,
            host = FakeHost(events),
            graphs = graphs,
            events = events,
            graphRecoverability = { it.binding == old.binding },
            replacementJournal = journal,
            preparedStateWiper = wiper,
        )

        assertTrue(runCatching { coordinator.restoreActiveBinding() }.isFailure)
        assertEquals(old.binding, storage.active?.binding)
        assertEquals(BindingReplacementStage.PREPARED, journal.value?.stage)
        assertEquals(listOf(BindingTeardownScope.of(next.binding)), wiper.scopes)

        assertTrue(coordinator.restoreActiveBinding() is BindingRestoreResult.Restored)
        assertNull(journal.value)
        assertEquals(listOf(BindingTeardownScope.of(next.binding), BindingTeardownScope.of(next.binding)), wiper.scopes)
        assertFalse(wiper.scopes.contains(BindingTeardownScope.of(old.binding)))
    }

    @Test
    fun `committed journal clear failure retries without repeating old teardown`() = runTest {
        val events = mutableListOf<String>()
        val old = storedBinding(boundAt = 100L)
        val next = storedBinding(boundAt = 101L)
        val storage = FakeStorage(events).apply { active = next }
        val journal = FakeReplacementJournal(events).apply {
            value = replacementRecord(old, next, BindingReplacementStage.OLD_TORN_DOWN)
            clearFailures = 1
        }
        val wiper = FakeScopeStateWiper(events)
        val graphs = mutableListOf<FakeGraph>()
        val coordinator = coordinator(
            storage = storage,
            host = FakeHost(events),
            graphs = graphs,
            events = events,
            graphRecoverability = { it.binding == next.binding },
            replacementJournal = journal,
            scopeStateWiper = wiper,
        )

        assertTrue(runCatching { coordinator.restoreActiveBinding() }.isFailure)
        assertEquals(BindingReplacementStage.OLD_TORN_DOWN, journal.value?.stage)
        assertTrue(wiper.scopes.isEmpty())

        assertTrue(coordinator.restoreActiveBinding() is BindingRestoreResult.Restored)
        assertNull(journal.value)
        assertTrue(wiper.scopes.isEmpty())
        assertEquals(next.binding, graphs.single().binding)
    }

    @Test
    fun `live replacement clear failure keeps the new graph and retries only the proof`() = runTest {
        val events = mutableListOf<String>()
        val old = storedBinding(boundAt = 99L)
        val storage = FakeStorage(events).apply { active = old }
        val host = FakeHost(events)
        val journal = FakeReplacementJournal(events).apply { clearFailures = 1 }
        val wiper = FakeScopeStateWiper(events)
        val graphs = mutableListOf<FakeGraph>()
        val coordinator = coordinator(
            storage = storage,
            host = host,
            graphs = graphs,
            events = events,
            restoredGraphsAreRecoverable = true,
            replacementJournal = journal,
            scopeStateWiper = wiper,
        )
        coordinator.restoreActiveBinding()
        coordinator.login(profile(), "alice", "password".toCharArray(), FakeGateway())

        assertTrue(runCatching { coordinator.completeBinding(bindingRequest(), "123456".toCharArray()) }.isFailure)
        val nextGraph = graphs.last()
        assertEquals(BindingReplacementStage.OLD_TORN_DOWN, journal.value?.stage)
        assertTrue(host.currentGraph() === nextGraph)
        assertFalse(nextGraph.wiped)
        assertEquals(listOf(BindingTeardownScope.of(old.binding)), wiper.scopes)
        assertFalse(coordinator.workersAreReady())

        assertTrue(coordinator.restoreActiveBinding() is BindingRestoreResult.Restored)
        assertNull(journal.value)
        assertTrue(host.currentGraph() === nextGraph)
        assertEquals(listOf(BindingTeardownScope.of(old.binding)), wiper.scopes)
        assertTrue(coordinator.workersAreReady())
    }

    @Test
    fun `unbind stops work before clearing graph and erasing all binding material`() = runTest {
        val events = mutableListOf<String>()
        val storage = FakeStorage(events).apply { active = storedBinding() }
        val graphs = mutableListOf<FakeGraph>()
        val coordinator = coordinator(
            storage,
            FakeHost(events),
            graphs,
            events,
            restoredGraphsAreRecoverable = true,
        )
        coordinator.restoreActiveBinding()
        events.clear()

        coordinator.unbind()

        assertEquals(
            listOf("journal.persist", "graph.stop", "host.clear", "graph.wipe", "storage.erase", "journal.clear"),
            events,
        )
        assertNull(storage.active)
        assertTrue(graphs.single().wiped)
    }

    @Test
    fun `device revoke erases only the matching live generation`() = runTest {
        val events = mutableListOf<String>()
        val storage = FakeStorage(events).apply { active = storedBinding(boundAt = 300L) }
        val graphs = mutableListOf<FakeGraph>()
        val coordinator = coordinator(
            storage,
            FakeHost(events),
            graphs,
            events,
            restoredGraphsAreRecoverable = true,
        )
        coordinator.restoreActiveBinding()
        val graph = graphs.single()
        events.clear()

        coordinator.onDeviceRevoked(graph.bindingKey, "0:old")
        assertNotNull(storage.active)
        assertFalse(graph.wiped)

        coordinator.onDeviceRevoked(graph.bindingKey, graph.generation)
        assertNull(storage.active)
        assertTrue(graph.wiped)
        assertEquals(
            listOf("journal.persist", "graph.stop", "host.clear", "graph.wipe", "storage.erase", "journal.clear"),
            events,
        )
    }

    @Test
    fun `wake terminal persists generation fence before graph teardown`() = runTest {
        val events = mutableListOf<String>()
        val storage = FakeStorage(events).apply { active = storedBinding(boundAt = 301L) }
        val journal = FakeTeardownJournal(events)
        val graphs = mutableListOf<FakeGraph>()
        val coordinator = coordinator(
            storage,
            FakeHost(events),
            graphs,
            events,
            restoredGraphsAreRecoverable = true,
            teardownJournal = journal,
        )
        coordinator.restoreActiveBinding()
        val graph = graphs.single()
        events.clear()

        assertFalse(coordinator.persistDeviceRevocationFence(graph.bindingKey, "old-generation"))
        assertTrue(events.isEmpty())
        assertTrue(coordinator.persistDeviceRevocationFence(graph.bindingKey, graph.generation))

        assertEquals(listOf("journal.persist"), events)
        assertEquals(BindingTeardownScope.of(graph.binding), journal.value)
        assertNotNull(storage.active)
        assertFalse(graph.wiped)

        coordinator.completePendingTeardown()

        assertNull(storage.active)
        assertTrue(graph.wiped)
        assertEquals(
            listOf("journal.persist", "graph.stop", "host.clear", "graph.wipe", "storage.erase", "journal.clear"),
            events,
        )
    }

    @Test
    fun `journal commit failure leaves graph and binding untouched`() = runTest {
        val events = mutableListOf<String>()
        val storage = FakeStorage(events).apply { active = storedBinding() }
        val journal = FakeTeardownJournal(events).apply { persistFailures = 1 }
        val graphs = mutableListOf<FakeGraph>()
        val coordinator = coordinator(
            storage,
            FakeHost(events),
            graphs,
            events,
            restoredGraphsAreRecoverable = true,
            teardownJournal = journal,
        )
        coordinator.restoreActiveBinding()
        events.clear()

        assertTrue(runCatching { coordinator.unbind() }.isFailure)

        assertNotNull(storage.active)
        assertFalse(graphs.single().wiped)
        assertNull(journal.value)
        assertEquals(listOf("journal.persist"), events)
    }

    @Test
    fun `restart completes teardown after crash while stopping graph`() = runTest {
        val events = mutableListOf<String>()
        val storage = FakeStorage(events).apply { active = storedBinding() }
        val journal = FakeTeardownJournal(events)
        val graphs = mutableListOf<FakeGraph>()
        val first = coordinator(
            storage,
            FakeHost(events),
            graphs,
            events,
            restoredGraphsAreRecoverable = true,
            teardownJournal = journal,
        )
        first.restoreActiveBinding()
        graphs.single().stopFailures = 1
        events.clear()

        assertTrue(runCatching { first.unbind() }.isFailure)
        assertNotNull(journal.value)
        assertNotNull(storage.active)

        val replayWiper = FakeScopeStateWiper(events)
        val recreated = coordinator(
            storage,
            FakeHost(events),
            mutableListOf(),
            events,
            teardownJournal = journal,
            scopeStateWiper = replayWiper,
        )
        recreated.completePendingTeardown()

        assertNull(storage.active)
        assertNull(journal.value)
        assertEquals(1, replayWiper.scopes.size)
        assertEquals(
            listOf(
                "journal.persist",
                "graph.stop",
                "scope.wipe",
                "storage.erase",
                "journal.clear",
            ),
            events,
        )
    }

    @Test
    fun `restart completes teardown after graph wipe failure`() = runTest {
        val events = mutableListOf<String>()
        val storage = FakeStorage(events).apply { active = storedBinding() }
        val journal = FakeTeardownJournal(events)
        val graphs = mutableListOf<FakeGraph>()
        val first = coordinator(
            storage,
            FakeHost(events),
            graphs,
            events,
            restoredGraphsAreRecoverable = true,
            teardownJournal = journal,
        )
        first.restoreActiveBinding()
        graphs.single().wipeFailures = 1
        events.clear()

        assertTrue(runCatching { first.unbind() }.isFailure)
        assertNotNull(journal.value)
        assertNotNull(storage.active)

        val wiper = FakeScopeStateWiper(events)
        coordinator(
            storage,
            FakeHost(events),
            mutableListOf(),
            events,
            teardownJournal = journal,
            scopeStateWiper = wiper,
        ).completePendingTeardown()

        assertNull(storage.active)
        assertNull(journal.value)
        assertEquals(1, wiper.scopes.size)
        assertEquals(2, events.count { it == "graph.wipe" || it == "scope.wipe" })
    }

    @Test
    fun `restart repeats idempotent wipe after binding row deletion failure`() = runTest {
        val events = mutableListOf<String>()
        val storage = FakeStorage(events).apply {
            active = storedBinding()
            eraseFailures = 1
        }
        val journal = FakeTeardownJournal(events)
        val graphs = mutableListOf<FakeGraph>()
        val first = coordinator(
            storage,
            FakeHost(events),
            graphs,
            events,
            restoredGraphsAreRecoverable = true,
            teardownJournal = journal,
        )
        first.restoreActiveBinding()
        events.clear()

        assertTrue(runCatching { first.unbind() }.isFailure)
        assertNotNull(storage.active)
        assertNotNull(journal.value)

        val wiper = FakeScopeStateWiper(events)
        coordinator(
            storage,
            FakeHost(events),
            mutableListOf(),
            events,
            teardownJournal = journal,
            scopeStateWiper = wiper,
        ).completePendingTeardown()

        assertNull(storage.active)
        assertNull(journal.value)
        assertEquals(1, wiper.scopes.size)
        assertEquals(2, events.count { it == "storage.erase" })
    }

    @Test
    fun `restart repeats wipe when crash happens after binding deletion before journal clear`() = runTest {
        val events = mutableListOf<String>()
        val storage = FakeStorage(events).apply { active = storedBinding() }
        val journal = FakeTeardownJournal(events).apply { clearFailures = 1 }
        val graphs = mutableListOf<FakeGraph>()
        val first = coordinator(
            storage,
            FakeHost(events),
            graphs,
            events,
            restoredGraphsAreRecoverable = true,
            teardownJournal = journal,
        )
        first.restoreActiveBinding()
        events.clear()

        assertTrue(runCatching { first.unbind() }.isFailure)
        assertNull(storage.active)
        assertNotNull(journal.value)

        val wiper = FakeScopeStateWiper(events)
        val recreated = coordinator(
            storage,
            FakeHost(events),
            mutableListOf(),
            events,
            teardownJournal = journal,
            scopeStateWiper = wiper,
        )
        recreated.completePendingTeardown()
        recreated.completePendingTeardown()

        assertNull(journal.value)
        assertEquals(1, wiper.scopes.size)
        assertEquals(2, events.count { it == "journal.clear" })
    }

    @Test
    fun `startup wipe failure keeps journal and retries before deleting binding`() = runTest {
        val events = mutableListOf<String>()
        val stored = storedBinding()
        val storage = FakeStorage(events).apply { active = stored }
        val journal = FakeTeardownJournal(events).apply {
            value = BindingTeardownScope.of(stored.binding)
        }
        val wiper = FakeScopeStateWiper(events).apply { failures = 1 }
        val coordinator = coordinator(
            storage,
            FakeHost(events),
            mutableListOf(),
            events,
            teardownJournal = journal,
            scopeStateWiper = wiper,
        )

        assertTrue(runCatching { coordinator.completePendingTeardown() }.isFailure)
        assertNotNull(storage.active)
        assertNotNull(journal.value)
        assertFalse(events.contains("storage.erase"))

        coordinator.completePendingTeardown()

        assertNull(storage.active)
        assertNull(journal.value)
        assertEquals(2, wiper.scopes.size)
    }

    @Test
    fun `old generation journal fails closed before touching same account rebound generation`() = runTest {
        val events = mutableListOf<String>()
        val old = storedBinding(boundAt = 100L)
        val rebound = storedBinding(boundAt = 101L)
        val storage = FakeStorage(events).apply { active = rebound }
        val journal = FakeTeardownJournal(events).apply {
            value = BindingTeardownScope.of(old.binding)
        }
        val wiper = FakeScopeStateWiper(events)
        val coordinator = coordinator(
            storage,
            FakeHost(events),
            mutableListOf(),
            events,
            teardownJournal = journal,
            scopeStateWiper = wiper,
        )

        assertTrue(runCatching { coordinator.completePendingTeardown() }.isFailure)

        assertEquals(rebound, storage.active)
        assertEquals(BindingTeardownScope.of(old.binding), journal.value)
        assertTrue(wiper.scopes.isEmpty())
        assertTrue(events.isEmpty())
    }

    @Test
    fun `restore drains pending teardown before constructing any account graph`() = runTest {
        val events = mutableListOf<String>()
        val stored = storedBinding()
        val storage = FakeStorage(events).apply { active = stored }
        val journal = FakeTeardownJournal(events).apply {
            value = BindingTeardownScope.of(stored.binding)
        }
        val wiper = FakeScopeStateWiper(events)
        val graphs = mutableListOf<FakeGraph>()
        val coordinator = coordinator(
            storage,
            FakeHost(events),
            graphs,
            events,
            teardownJournal = journal,
            scopeStateWiper = wiper,
        )

        assertEquals(BindingRestoreResult.Unbound, coordinator.restoreActiveBinding())

        assertTrue(graphs.isEmpty())
        assertEquals(listOf("scope.wipe", "storage.erase", "journal.clear"), events)
    }

    private fun coordinator(
        storage: FakeStorage,
        host: FakeHost,
        graphs: MutableList<FakeGraph>,
        events: MutableList<String>,
        restoredGraphsAreRecoverable: Boolean = false,
        restoredDatabaseRequiresBootstrap: Boolean = false,
        restoredGraphStartFailures: Int = 0,
        gatewayFactory: BindingGatewayFactory = BindingGatewayFactory { FakeGateway() },
        teardownJournal: FakeTeardownJournal = FakeTeardownJournal(events),
        replacementJournal: FakeReplacementJournal = FakeReplacementJournal(events),
        scopeStateWiper: FakeScopeStateWiper = FakeScopeStateWiper(events),
        preparedStateWiper: FakePreparedStateWiper = FakePreparedStateWiper(events),
        noAccountCleanupJournal: FakeNoAccountCleanupJournal = FakeNoAccountCleanupJournal(),
        noAccountStateWiper: FakeNoAccountStateWiper = FakeNoAccountStateWiper(),
        graphRecoverability: ((StoredBinding) -> Boolean)? = null,
    ): BindingCoordinator = BindingCoordinator(
        storage = storage,
        host = host,
        graphFactory = BindingGraphFactory { stored ->
            FakeGraph(
                stored.binding,
                events,
                initiallyRecoverable = graphRecoverability?.invoke(stored) ?: restoredGraphsAreRecoverable,
                databaseRequiresBootstrap = restoredDatabaseRequiresBootstrap,
            ).also {
                it.startFailures = restoredGraphStartFailures
                graphs += it
            }
        },
        identityFactory = PendingDeviceIdentityFactory { _, _, _ -> FakeIdentity() },
        gatewayFactory = gatewayFactory,
        teardownJournal = teardownJournal,
        replacementJournal = replacementJournal,
        scopeStateWiper = scopeStateWiper,
        preparedStateWiper = preparedStateWiper,
        noAccountCleanupJournal = noAccountCleanupJournal,
        noAccountStateWiper = noAccountStateWiper,
        deviceIdFactory = { "device-1" },
        now = { 1_000L },
    )

    private fun replacementRecord(
        previous: StoredBinding,
        next: StoredBinding,
        stage: BindingReplacementStage,
    ) = BindingReplacementRecord(
        previous = BindingTeardownScope.of(previous.binding),
        next = next,
        stage = stage,
    )

    private fun profile() = ServerProfile(
        id = "server-1",
        baseUrl = "https://zephyr.example",
        displayName = "Zephyr",
        tlsPolicy = TlsPolicy.SystemTrust,
        createdAt = 1L,
        lastUsedAt = null,
    )

    private fun bindingRequest() = CompleteBindingRequest(
        deviceName = "Phone",
        tokenId = "token-1",
        tokenName = "Primary",
        automaticEnabled = true,
        intervalSec = 300,
        networkPolicy = NetworkPolicy.ANY,
    )

    private fun storedBinding(boundAt: Long = 100L): StoredBinding = StoredBinding(
        binding = AccountBinding(
            serverProfileId = "server-1",
            userId = "user-1",
            username = "alice",
            deviceId = "device-1",
            deviceName = "Phone",
            tokenId = "token-1",
            tokenName = "Primary",
            state = BindingState.IDLE,
            registryHash = "registry-1",
            boundAt = boundAt,
            lastSyncAt = null,
            instanceEpoch = 0L,
        ),
        profile = profile(),
        settings = SyncSettings(true, 300, NetworkPolicy.ANY),
    )
}

private class FakeStorage(private val events: MutableList<String>) : BindingStorage {
    var active: StoredBinding? = null
    var blockRestoreWithPendingWrites: Int = 0
    var blockSaveWithPendingWrites: Int = 0
    var replaceFailures: Int = 0
    var replaceAfterWriteFailures: Int = 0
    var bindingForTeardownFailures: Int = 0
    var eraseFailures: Int = 0
    private var profile: ServerProfile? = null

    override suspend fun saveProfile(profile: ServerProfile) {
        this.profile = profile
    }

    override suspend fun restore(): StoredBinding? {
        if (blockRestoreWithPendingWrites > 0) {
            throw LegacyPendingWritesException(blockRestoreWithPendingWrites)
        }
        return active
    }

    override suspend fun bindingForTeardown(): AccountBinding? {
        if (bindingForTeardownFailures > 0) {
            bindingForTeardownFailures -= 1
            error("simulated active binding read failure")
        }
        return active?.binding
    }

    override suspend fun save(binding: AccountBinding, settings: SyncSettings) {
        if (blockSaveWithPendingWrites > 0) {
            throw LegacyPendingWritesException(blockSaveWithPendingWrites)
        }
        events += "storage.save"
        active = StoredBinding(binding, profile ?: checkNotNull(active).profile, settings)
    }

    override suspend fun saveReplacing(
        expected: BindingTeardownScope,
        binding: AccountBinding,
        settings: SyncSettings,
    ): Boolean {
        events += "storage.replace"
        if (replaceFailures > 0) {
            replaceFailures -= 1
            error("simulated replacement storage failure")
        }
        if (active?.binding?.let(expected::matches) != true) return false
        active = StoredBinding(binding, profile ?: checkNotNull(active).profile, settings)
        if (replaceAfterWriteFailures > 0) {
            replaceAfterWriteFailures -= 1
            error("simulated replacement storage failure after commit")
        }
        return true
    }

    override suspend fun markAccountDatabaseReady(binding: AccountBinding, state: BindingState) {
        events += "storage.ready"
        active = checkNotNull(active).copy(binding = binding.copy(state = state), requiresBootstrap = false)
    }

    override suspend fun erase(scope: BindingTeardownScope) {
        events += "storage.erase"
        if (eraseFailures > 0) {
            eraseFailures -= 1
            error("simulated binding row erase failure")
        }
        if (active?.binding?.let(scope::matches) == true) active = null
    }
}

private class FakeTeardownJournal(private val events: MutableList<String>) : BindingTeardownJournal {
    var value: BindingTeardownScope? = null
    var persistFailures: Int = 0
    var clearFailures: Int = 0

    override fun pending(): BindingTeardownScope? = value

    override fun persist(scope: BindingTeardownScope) {
        events += "journal.persist"
        if (persistFailures > 0) {
            persistFailures -= 1
            error("simulated journal persist failure")
        }
        check(value == null || value == scope)
        value = scope
    }

    override fun clear(scope: BindingTeardownScope) {
        events += "journal.clear"
        if (clearFailures > 0) {
            clearFailures -= 1
            error("simulated journal clear failure")
        }
        check(value == null || value == scope)
        value = null
    }
}

private class FakeReplacementJournal(private val events: MutableList<String>) : BindingReplacementJournal {
    var value: BindingReplacementRecord? = null
    var advanceFailures = 0
    var clearFailures = 0

    override fun pending(): BindingReplacementRecord? = value

    override fun persist(record: BindingReplacementRecord) {
        events += "replacement.persist"
        check(value == null || sameReplacement(value!!, record))
        value = record
    }

    override fun advance(record: BindingReplacementRecord, stage: BindingReplacementStage) {
        events += "replacement.$stage"
        if (stage.ordinal <= checkNotNull(value).stage.ordinal) return
        if (advanceFailures > 0) {
            advanceFailures -= 1
            error("simulated replacement journal advance failure")
        }
        check(sameReplacement(checkNotNull(value), record))
        value = record.copy(stage = stage)
    }

    override fun clear(record: BindingReplacementRecord) {
        events += "replacement.clear"
        if (clearFailures > 0) {
            clearFailures -= 1
            error("simulated replacement journal clear failure")
        }
        check(value == null || sameReplacement(value!!, record))
        value = null
    }

    private fun sameReplacement(left: BindingReplacementRecord, right: BindingReplacementRecord): Boolean =
        left.previous == right.previous && left.nextScope == right.nextScope
}

private class FakeScopeStateWiper(private val events: MutableList<String>) : BindingScopeStateWiper {
    val scopes = mutableListOf<BindingTeardownScope>()
    var failures = 0

    override fun wipe(scope: BindingTeardownScope) {
        events += "scope.wipe"
        scopes += scope
        if (failures > 0) {
            failures -= 1
            error("simulated persisted state wipe failure")
        }
    }
}

private class FakePreparedStateWiper(private val events: MutableList<String>) : BindingPreparedStateWiper {
    val scopes = mutableListOf<BindingTeardownScope>()
    var failures = 0

    override fun discard(scope: BindingTeardownScope) {
        events += "prepared.discard"
        scopes += scope
        if (failures > 0) {
            failures -= 1
            error("simulated prepared state discard failure")
        }
    }
}

private class FakeNoAccountCleanupJournal(
    initialValue: Boolean = false,
    private val events: MutableList<String>? = null,
) : NoAccountCleanupJournal {
    var value = initialValue
    var persistFailures = 0
    var clearFailures = 0

    override fun pending(): Boolean = value

    override fun persist() {
        events?.add("global.persist")
        if (persistFailures > 0) {
            persistFailures -= 1
            error("simulated no-account journal persist failure")
        }
        value = true
    }

    override fun clear() {
        events?.add("global.clear")
        if (clearFailures > 0) {
            clearFailures -= 1
            error("simulated no-account journal clear failure")
        }
        value = false
    }
}

private class FakeNoAccountStateWiper(
    private val events: MutableList<String>? = null,
) : NoAccountStateWiper {
    var result = true
    var calls = 0
    var onWipe: (() -> Unit)? = null

    override fun wipe(): Boolean {
        events?.add("global.wipe")
        calls += 1
        onWipe?.invoke()
        return result
    }
}

private class FakeHost(private val events: MutableList<String>) : BindingGraphHost {
    private var graph: ManagedBindingGraph? = null

    override fun currentGraph(): ManagedBindingGraph? = graph

    override fun attachGraph(graph: ManagedBindingGraph) {
        events += "host.attach"
        this.graph = graph
    }

    override fun clearGraph(expected: ManagedBindingGraph) {
        assertTrue(graph === expected)
        events += "host.clear"
        graph = null
    }
}

private class FakeGraph(
    override val binding: AccountBinding,
    private val events: MutableList<String>,
    initiallyRecoverable: Boolean,
    private val databaseRequiresBootstrap: Boolean,
    private val deviceLocal: Boolean = false,
) : ManagedBindingGraph {
    override val bindingKey = binding.serverProfileId + "/" + binding.userId + "/" + binding.deviceId
    override val generation = BindingGeneration.of(binding)
    override val isDeviceLocal: Boolean get() = deviceLocal

    private var recoverable = initiallyRecoverable
    private val job = SupervisorJob()
    private val scope = CoroutineScope(job + Dispatchers.Default)
    var bootstrapCalls = 0
    var scheduledCalls = 0
    var databaseReadyCalls = 0
    var storedAccess: String? = null
    var storedRefresh: String? = null
    var wiped = false
    var preparedDiscarded = false
    var activationCalls = 0
    var stopFailures = 0
    var wipeFailures = 0
    var startFailures = 0

    override fun isRecoverable(): Boolean = recoverable

    override fun storeCredentials(access: String, accessExpiresAt: Long?, refresh: String) {
        storedAccess = access
        storedRefresh = refresh
        recoverable = true
    }

    override suspend fun activate() {
        events += "graph.activate"
        activationCalls += 1
        if (startFailures > 0) {
            startFailures -= 1
            error("simulated startup recovery failure")
        }
    }

    override fun discardPreparedState() {
        events += "graph.discard"
        preparedDiscarded = true
        recoverable = false
        storedAccess = null
        storedRefresh = null
    }

    override suspend fun bootstrapAfterBind(): List<SyncRoundResult> = scope.async {
        events += "graph.bootstrap"
        bootstrapCalls += 1
        listOf(successfulRound(SyncTrigger.BIND_COMPLETE))
    }.await()

    override suspend fun runScheduledRound(): List<SyncRoundResult> = scope.async {
        scheduledCalls += 1
        listOf(successfulRound(SyncTrigger.INTERVAL))
    }.await()

    override suspend fun accountDatabaseRequiresBootstrap(): Boolean = databaseRequiresBootstrap

    override suspend fun markAccountDatabaseReady() {
        events += "graph.database.ready"
        databaseReadyCalls += 1
    }

    override suspend fun stopAndJoin() {
        events += "graph.stop"
        if (stopFailures > 0) {
            stopFailures -= 1
            error("simulated graph stop failure")
        }
        job.cancelAndJoin()
    }

    override fun wipeBindingState() {
        events += "graph.wipe"
        if (wipeFailures > 0) {
            wipeFailures -= 1
            error("simulated graph wipe failure")
        }
        recoverable = false
        wiped = true
        storedAccess = null
        storedRefresh = null
    }
}

private class FakeIdentity : PendingDeviceIdentity {
    var wiped = false

    override fun ensureKeys() = DeviceIdentity.PublicKeys(
        encryptionAlg = "ML-KEM-768",
        encryptionPublicKeyBase64 = "public-key",
        signingAlg = "ES256",
        signingJwk = mapOf("kty" to "EC", "crv" to "P-256"),
    )

    override fun signPayload(payload: ByteArray) = "c2lnbmF0dXJl"

    override fun wipe() {
        wiped = true
    }
}

private class FakeGateway(
    private val loginReply: BindingLoginReply = BindingLoginReply.Authenticated(
        AuthenticatedBindingAccount("user-1", "alice"),
    ),
    private val loginEntered: CompletableDeferred<Unit>? = null,
    private val loginRelease: CompletableDeferred<Unit>? = null,
) : BindingGateway {
    var authenticationCleared = false
    var totpCall: Pair<String, String>? = null
    var sensitiveAction: String? = null
    var sensitiveTargets: List<String>? = null
    var grantUsedForBind: String? = null

    override suspend fun capabilities() = ApiResult.Success(
        ServerCapabilities(protocolVersions = listOf(1), registryHash = "registry-1"),
        requestId = null,
    )

    override suspend fun login(username: String, password: CharArray): ApiResult<BindingLoginReply> {
        loginEntered?.complete(Unit)
        loginRelease?.await()
        return ApiResult.Success(loginReply, requestId = null)
    }

    override suspend fun verifyTotp(
        tempToken: CharArray,
        code: CharArray,
    ): ApiResult<AuthenticatedBindingAccount> {
        totpCall = String(tempToken) to String(code)
        return ApiResult.Success(AuthenticatedBindingAccount("user-1", "alice"), requestId = null)
    }

    override suspend fun verifySensitive(
        action: String,
        secret: CharArray,
        targetIds: List<String>,
    ): ApiResult<SensitiveBindingGrant> {
        sensitiveAction = action
        sensitiveTargets = targetIds
        return ApiResult.Success(SensitiveBindingGrant("sensitive-grant-1"), requestId = null)
    }

    override suspend fun bind(
        command: DeviceBindingCommand,
        sensitiveGrant: CharArray,
    ): ApiResult<DeviceBindingReply> {
        grantUsedForBind = String(sensitiveGrant)
        return ApiResult.Success(
        DeviceBindingReply(
            deviceId = command.deviceId,
            deviceName = command.deviceName,
            tokenId = command.tokenId,
            accessCredential = "access-1",
            accessExpiresAt = 5_000L,
            refreshCredential = "refresh-1",
            registryHash = "registry-1",
            boundAt = 100L,
            instanceEpoch = 0L,
        ),
        requestId = null,
    )
    }

    override fun clearAuthentication() {
        authenticationCleared = true
    }

    override suspend fun createEnrollment(
        command: DeviceBindingCommand,
    ) = ApiResult.Success(
        one.zephyr.mobile.network.dto.LinkEnrollmentCreateResponseDto(
            ok = true,
            bindId = "bind-1",
            userCode = "ABCD-EFGH",
            enrollmentSecret = "enrollment-secret-1",
            verificationUri = "https://zephyr.example/link/approve?bindId=bind-1",
            sas = "AAAA-BBBB-CCCC-DDDD",
            fingerprint = "a".repeat(64),
            expiresAt = 9_000L,
            serverId = "srv-1",
            deviceId = command.deviceId,
            deviceName = command.deviceName,
            platform = "android",
        ),
        requestId = null,
    )

    override suspend fun enrollmentStatus(bindId: String, userCode: String) = ApiResult.Success(
        one.zephyr.mobile.network.dto.LinkEnrollmentStatusDto(
            ok = true,
            bindId = bindId,
            status = "approved",
            userCode = userCode,
        ),
        requestId = null,
    )

    override suspend fun consumeEnrollment(
        bindId: String,
        userCode: String,
        enrollmentSecret: CharArray,
        proof: String,
        command: DeviceBindingCommand,
    ) = ApiResult.Success(
        DeviceBindingReply(
            deviceId = command.deviceId,
            deviceName = command.deviceName,
            tokenId = LINK_ENROLLMENT_TOKEN_ID,
            accessCredential = "access-1",
            accessExpiresAt = 5_000L,
            refreshCredential = "refresh-1",
            registryHash = "registry-1",
            boundAt = 100L,
            instanceEpoch = 0L,
            userId = "user-1",
            username = "alice",
        ),
        requestId = null,
    )
}

private fun successfulRound(trigger: SyncTrigger) = SyncRoundResult(
    trigger = trigger,
    startedAt = 1L,
    finishedAt = 2L,
    phasesRun = listOf(SyncPhase.COMMIT_SUCCESS),
    endState = BindingState.IDLE,
    pushed = 0,
    conflicts = 0,
    deferred = emptyList(),
    applied = 1,
    skipped = 0,
    appliedCursor = 1L,
    ackedCursor = 1L,
)
