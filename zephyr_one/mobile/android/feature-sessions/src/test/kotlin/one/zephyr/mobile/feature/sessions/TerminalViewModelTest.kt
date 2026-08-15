package one.zephyr.mobile.feature.sessions

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import one.zephyr.mobile.contracts.Capability
import one.zephyr.mobile.data.session.SessionRegistry
import one.zephyr.mobile.data.session.SessionTransport
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.PageState
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.model.Residency
import one.zephyr.mobile.model.SharedUsePolicy
import one.zephyr.mobile.model.TerminalEncoding
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * S21's ViewModel.
 *
 * Both engines are ports (ADR-002 for SSH, ADR-003 for the parser), so these tests are the only
 * place the blocked paths can be proven: a fake host and a fake emulator let the whole state
 * machine - blocked engine, revoked grant, host-key gate, credential lifetime - be asserted without
 * a socket. The device-level gate in COMPLETION_CRITERIA.md 27 still applies on top of this.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class TerminalViewModelTest {

    private val mainDispatcher = UnconfinedTestDispatcher()

    @Before
    fun setUp() {
        // viewModelScope is hard-wired to Dispatchers.Main. Unconfined rather than StandardTestDispatcher
        // because init and connect() both launch, and a test that had to advance the scheduler before
        // the ViewModel was usable would hide the ordering this class depends on.
        Dispatchers.setMain(mainDispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    // ---- doubles ---------------------------------------------------------------------------------

    private class RecordingTerminalTransport : TerminalTransport {
        val writes = mutableListOf<ByteArray>()
        override suspend fun write(bytes: ByteArray) {
            writes += bytes
        }
        override suspend fun resize(columns: Int, rows: Int, widthPx: Int, heightPx: Int) = Unit
    }

    private class FakeEmulator(
        override val isAvailable: Boolean = true,
        private var update: EmulatorUpdate = EmulatorUpdate(),
    ) : TerminalEmulator {
        val fed = mutableListOf<ByteArray>()
        val resizes = mutableListOf<Pair<Int, Int>>()
        var closed = false
            private set
        var snapshotTopRow = -1
            private set
        var lastColumns = 80
            private set
        var lastRows = 24
            private set
        override fun resize(columns: Int, rows: Int) {
            lastColumns = columns
            lastRows = rows
            resizes += columns to rows
        }

        fun nextUpdate(next: EmulatorUpdate) {
            update = next
        }

        override fun feed(bytes: ByteArray): EmulatorUpdate {
            fed += bytes
            return update
        }

        override fun snapshot(topRow: Int, rows: Int): List<TerminalLine> {
            snapshotTopRow = topRow
            return List(rows) { TerminalLine(listOf(TerminalCell(text = "x", foreground = 7, background = 0))) }
        }

        override fun cursor(): TerminalCursor = TerminalCursor(column = 3, row = 4, visible = true)

        override fun readScrollback(fromRow: Int, toRow: Int): String = "scrollback"

        override fun close() {
            closed = true
        }
    }

    private class FakeHost(
        override val isAvailable: Boolean = true,
        private val outcome: TerminalOpenOutcome = TerminalOpenOutcome.Opened("s1"),
    ) : TerminalHost {
        val outputFlow = MutableSharedFlow<ByteArray>(extraBufferCapacity = 8)
        val transport = RecordingTerminalTransport()
        var opens = 0
            private set
        var passwordSeen: String? = null
            private set
        var columnsSeen = 0
            private set
        var rowsSeen = 0
            private set
        var autoLoginSeen = false
            private set
        var closedSessions = mutableListOf<String>()
            private set
        var trusted = 0
            private set

        override suspend fun open(request: TerminalOpenRequest): TerminalOpenOutcome {
            opens++
            // Copied at call time. The ViewModel wipes the array immediately afterwards, so reading
            // it later would always see zeros and the assertion would pass for the wrong reason.
            passwordSeen = request.password?.concatToString()
            columnsSeen = request.columns
            rowsSeen = request.rows
            autoLoginSeen = request.autoLogin
            return outcome
        }

        override fun output(sessionId: String): Flow<ByteArray> = outputFlow

        override fun transportFor(sessionId: String): TerminalTransport = transport

        override suspend fun close(sessionId: String) {
            closedSessions += sessionId
        }

        override suspend fun trustHostKey(sessionId: String) {
            trusted++
        }
    }

    // ---- harness ---------------------------------------------------------------------------------

    private fun subject(
        registry: SessionRegistry = SessionRegistry(),
        connection: Connection? = SessionFixtures.connection(),
        host: TerminalHost = FakeHost(),
        emulator: TerminalEmulator = FakeEmulator(),
        credentials: TerminalCredentials = TerminalCredentials(),
    ): TerminalViewModel = TerminalViewModel(
        sessionId = SESSION,
        connectionId = "c1",
        registry = registry,
        findConnection = { id -> connection?.takeIf { it.id == id } },
        host = host,
        emulator = emulator,
        secretProvider = { credentials },
        clock = { NOW },
        emulatorDispatcher = mainDispatcher,
    )

    /** stateIn(WhileSubscribed) produces nothing without a collector. */
    private fun TestScope.subscribe(subject: TerminalViewModel) {
        backgroundScope.launch { subject.state.collect {} }
        runCurrent()
    }

    private fun contentOf(state: PageState<TerminalContent>): TerminalContent {
        assertTrue("expected Content but was " + state, state is PageState.Content)
        return (state as PageState.Content).value
    }

    private fun fatalOf(state: PageState<TerminalContent>): MobileError {
        assertTrue("expected FatalIncompatible but was " + state, state is PageState.FatalIncompatible)
        return (state as PageState.FatalIncompatible).error
    }

    // ---- blocked engines -------------------------------------------------------------------------

    @Test
    fun anUnlinkedParserIsFatalRatherThanRetryable() = runTest(mainDispatcher) {
        val subject = subject(emulator = FakeEmulator(isAvailable = false))
        subscribe(subject)

        subject.connect()
        runCurrent()

        // Retrying an unlinked engine would fail identically, so ADR-003 renders as fatal with a
        // copyable diagnostic instead of a retry button.
        val error = fatalOf(subject.state.value)
        assertEquals("engine_unavailable", error.code)
        assertFalse(error.retryable)
    }

    @Test
    fun anUnlinkedSshEngineReportsTheAdrGateAndNeverDials() = runTest(mainDispatcher) {
        val host = FakeHost(isAvailable = false)
        val subject = subject(host = host)
        subscribe(subject)

        subject.connect()
        runCurrent()

        assertEquals(UnavailableTerminalHost.SSH_BLOCKED.message, fatalOf(subject.state.value).message)
        assertEquals(0, host.opens)
    }

    @Test
    fun telnetReportsTheMissingSocketRatherThanTheSshGate() = runTest(mainDispatcher) {
        // The IAC state machine is complete; only the socket is the app module's job, and saying
        // "SSH engine missing" here would send a reader to the wrong ADR.
        val subject = subject(
            connection = SessionFixtures.connection(protocol = Protocol.TELNET, port = 23),
            host = FakeHost(isAvailable = false),
        )
        subscribe(subject)

        subject.connect()
        runCurrent()

        assertEquals(UnavailableTerminalHost.TELNET_NO_SOCKET.message, fatalOf(subject.state.value).message)
    }

    // ---- terminal states -------------------------------------------------------------------------

    @Test
    fun aConnectionThatVanishedFromTheMirrorIsTerminal() = runTest(mainDispatcher) {
        val subject = subject(connection = null)
        subscribe(subject)

        assertEquals(PageState.NotFoundOrRevoked, subject.state.value)
        assertTrue(subject.state.value.isTerminal)
    }

    @Test
    fun aGrantRevokedWhileTheTabWasOpenIsTerminal() = runTest(mainDispatcher) {
        val registry = SessionRegistry()
        registry.register(SessionFixtures.row(sessionId = SESSION))
        val subject = subject(registry = registry)
        subscribe(subject)
        assertTrue(subject.state.value is PageState.Content)

        registry.markRevoked(SESSION)
        runCurrent()

        // The tab keeps its explanation and offers no retry: the row is still there, but revoked.
        assertEquals(PageState.NotFoundOrRevoked, subject.state.value)
    }

    @Test
    fun losingUseRendersPermissionDeniedRatherThanAnEmptyTerminal() = runTest(mainDispatcher) {
        val subject = subject(connection = SessionFixtures.connection(capabilities = SessionFixtures.viewOnly))
        subscribe(subject)

        val state = subject.state.value
        assertTrue("expected PermissionDenied but was " + state, state is PageState.PermissionDenied)
        assertEquals(Capability.USE, (state as PageState.PermissionDenied).missing)
    }

    @Test
    fun aTabThatHasNeverDialledReportsDisconnectedRatherThanConnecting() = runTest(mainDispatcher) {
        val subject = subject()
        subscribe(subject)

        // connect() registers the row synchronously, so a missing row can only mean "never dialled".
        // Reporting 连接中 here would hide the one button that helps that user.
        assertEquals(SessionTransport.DISCONNECTED, contentOf(subject.state.value).transport)
    }

    // ---- open ------------------------------------------------------------------------------------

    @Test
    fun openingRegistersTheRowAndPassesTheMeasuredGeometry() = runTest(mainDispatcher) {
        val registry = SessionRegistry()
        val host = FakeHost()
        val subject = subject(registry = registry, host = host)
        subscribe(subject)

        subject.connect()
        runCurrent()

        assertEquals(1, host.opens)
        // The surface already has a size before the first frame, so the peer is never told 0x0.
        assertEquals(80, host.columnsSeen)
        assertEquals(24, host.rowsSeen)
        val row = registry.find(SESSION)
        assertTrue("expected a registered row", row != null)
        assertEquals(SessionTransport.CONNECTED, row?.transport)
        assertEquals("prod-web", row?.name)
    }

    @Test
    fun sshNeverRequestsInBandAutoLogin() = runTest(mainDispatcher) {
        val host = FakeHost()
        val subject = subject(host = host)
        subscribe(subject)

        subject.connect()
        runCurrent()

        // Auto-login is a Telnet-only concession (ADR-006); replaying a password into an SSH shell
        // would type the credential into the remote session.
        assertFalse(host.autoLoginSeen)
    }

    @Test
    fun telnetRequestsAutoLoginOnlyWhenAUsernameIsConfigured() = runTest(mainDispatcher) {
        val withUser = FakeHost()
        val named = subject(
            connection = SessionFixtures.connection(protocol = Protocol.TELNET, port = 23, username = "root"),
            host = withUser,
        )
        subscribe(named)
        named.connect()
        runCurrent()
        assertTrue(withUser.autoLoginSeen)

        val withoutUser = FakeHost()
        val anonymous = subject(
            connection = SessionFixtures.connection(protocol = Protocol.TELNET, port = 23, username = ""),
            host = withoutUser,
        )
        subscribe(anonymous)
        anonymous.connect()
        runCurrent()
        assertFalse(withoutUser.autoLoginSeen)
    }

    @Test
    fun outputFeedsTheEmulatorAndBumpsTheRevisionWithoutBadgingTheOpenTab() = runTest(mainDispatcher) {
        val registry = SessionRegistry()
        val host = FakeHost()
        val emulator = FakeEmulator()
        emulator.nextUpdate(EmulatorUpdate(newRows = 2, transcriptRows = 2, title = "remote-host"))
        val subject = subject(registry = registry, host = host, emulator = emulator)
        subscribe(subject)
        subject.connect()
        runCurrent()

        host.outputFlow.emit(ascii("hi"))
        runCurrent()

        assertEquals(1, emulator.fed.size)
        assertEquals("68 69", hex(emulator.fed[0]))
        // The grid is read on demand; this counter is the only thing that recomposes the screen.
        assertEquals(1, subject.surfaceRevision.value)
        assertEquals("remote-host", subject.title.value)
        // foreground = true: the tab the user is looking at must not badge itself as unread.
        assertFalse(registry.find(SESSION)?.unreadOutput ?: true)
    }

    @Test
    fun anOutputBurstIsMergedToOneImmediateAndOneTrailingRedraw() = runTest(mainDispatcher) {
        val host = FakeHost()
        val emulator = FakeEmulator()
        val subject = subject(host = host, emulator = emulator)
        subscribe(subject)
        subject.connect()
        runCurrent()

        repeat(20) { host.outputFlow.emit(ascii("x")) }
        runCurrent()

        assertEquals(20, emulator.fed.size)
        assertEquals(1, subject.surfaceRevision.value)

        advanceTimeBy(16)
        runCurrent()
        assertEquals(2, subject.surfaceRevision.value)
    }

    @Test
    fun theVisibleGridIsReadFromTheViewportRatherThanPushedIntoState() = runTest(mainDispatcher) {
        val emulator = FakeEmulator()
        val subject = subject(emulator = emulator)
        subscribe(subject)

        val lines = subject.visibleLines()

        assertEquals(24, lines.size)
        assertEquals(0, emulator.snapshotTopRow)
        assertEquals(4, subject.cursor().row)
    }

    @Test
    fun geometryChangesResizeTheEmulatorNotJustThePty() = runTest(mainDispatcher) {
        val emulator = FakeEmulator()
        val subject = subject(emulator = emulator)
        subscribe(subject)
        runCurrent()

        assertEquals(listOf(80 to 24), emulator.resizes)

        subject.controller.onGeometry(
            totalWidthPx = 800f,
            totalHeightPx = 1000f,
            imeHeightPx = 0f,
            shortcutMatrixHeightPx = 100f,
            dockHeightPx = 80f,
            cellWidthPx = 10f,
            lineHeightPx = 20f,
        )
        runCurrent()

        val last = emulator.resizes.last()
        assertTrue("emulator must leave the default 80x24, was $last", last != 80 to 24)
        assertEquals(last.first, subject.controller.state.value.size.columns)
        assertEquals(last.second, subject.controller.state.value.size.rows)
    }

    @Test
    fun anUnlinkedParserYieldsNoGridInsteadOfAFakeOne() = runTest(mainDispatcher) {
        val subject = subject(emulator = FakeEmulator(isAvailable = false))
        subscribe(subject)

        // A stand-in that echoed bytes back would look like a working terminal in a screenshot while
        // dropping every escape sequence, which is what the ADR-003 exit gate exists to prevent.
        assertEquals(0, subject.visibleLines().size)
    }

    // ---- host key --------------------------------------------------------------------------------

    @Test
    fun aHostKeyDecisionPromptsAndLeavesTheSessionConnecting() = runTest(mainDispatcher) {
        val registry = SessionRegistry()
        val host = FakeHost(outcome = TerminalOpenOutcome.HostKeyDecision("SHA256:abc", changed = false))
        val subject = subject(registry = registry, host = host)
        subscribe(subject)

        subject.connect()
        runCurrent()

        val content = contentOf(subject.state.value)
        assertEquals(HostKeyPrompt("SHA256:abc", changed = false), content.hostKeyPrompt)
        // Nothing was trusted, so the row stays CONNECTING rather than claiming a session.
        assertEquals(SessionTransport.CONNECTING, content.transport)
        assertEquals(0, host.trusted)
    }

    @Test
    fun acceptingAChangedHostKeyTrustsItRedialsAndSaysSo() = runTest(mainDispatcher) {
        val host = FakeHost(outcome = TerminalOpenOutcome.HostKeyDecision("SHA256:abc", changed = true))
        val subject = subject(host = host)
        subscribe(subject)
        val messages = mutableListOf<String>()
        backgroundScope.launch { subject.message.collect { messages += it } }
        runCurrent()

        subject.connect()
        runCurrent()
        subject.onHostKeyAccepted()
        runCurrent()

        assertEquals(1, host.trusted)
        assertEquals(2, host.opens)
        // A changed key that was accepted must leave a trace the user can see afterwards.
        assertTrue(messages.contains(TerminalViewModel.HOST_KEY_CHANGED_ACCEPTED))
    }

    @Test
    fun rejectingAHostKeyIsFatalAndLeavesTheRowDisconnected() = runTest(mainDispatcher) {
        val registry = SessionRegistry()
        val host = FakeHost(outcome = TerminalOpenOutcome.HostKeyDecision("SHA256:abc", changed = true))
        val subject = subject(registry = registry, host = host)
        subscribe(subject)
        subject.connect()
        runCurrent()

        subject.onHostKeyRejected()
        runCurrent()

        val error = fatalOf(subject.state.value)
        assertEquals("host_key_rejected", error.code)
        // Not retryable: retrying would re-present the same key and the user already said no.
        assertFalse(error.retryable)
        assertEquals(SessionTransport.DISCONNECTED, registry.find(SESSION)?.transport)
        assertEquals(0, host.trusted)
    }

    // ---- credential lifetime ---------------------------------------------------------------------

    @Test
    fun connectWipesTheCredentialsItWasGiven() = runTest(mainDispatcher) {
        val password = charArrayOf('h', 'u', 'n', 't', 'e', 'r')
        val passphrase = charArrayOf('p', 'p')
        val host = FakeHost()
        val subject = subject(
            host = host,
            credentials = TerminalCredentials(password = password, passphrase = passphrase),
        )
        subscribe(subject)

        subject.connect()
        runCurrent()

        assertEquals("hunter", host.passwordSeen)
        // SHARED_RESOURCE_RESIDENCY.md requires connection material to leave memory with the attempt.
        // A String could not be zeroed at all, which is why these are CharArrays.
        assertTrue(password.all { it.code == 0 })
        assertTrue(passphrase.all { it.code == 0 })
    }

    @Test
    fun aFailingSecretProviderStillAttemptsRatherThanCrashingTheTab() = runTest(mainDispatcher) {
        val host = FakeHost(outcome = TerminalOpenOutcome.Failed(MobileError.local("auth_failed", "认证失败", true)))
        val subject = TerminalViewModel(
            sessionId = SESSION,
            connectionId = "c1",
            registry = SessionRegistry(),
            findConnection = { SessionFixtures.connection() },
            host = host,
            emulator = FakeEmulator(),
            secretProvider = { error("keystore locked") },
            clock = { NOW },
        )
        subscribe(subject)

        subject.connect()
        runCurrent()

        // The attempt proceeds with no credential and fails on the wire, which is a structured error
        // the user can act on. A thrown exception would take the tab down with no explanation.
        assertEquals(1, host.opens)
        assertNull(host.passwordSeen)
        assertTrue(subject.state.value is PageState.RetryableError)
    }

    // ---- chrome ----------------------------------------------------------------------------------

    @Test
    fun theSurfaceExistsBeforeAnyConnectSoTheChromeCanRender() = runTest(mainDispatcher) {
        val subject = subject()
        subscribe(subject)

        val content = contentOf(subject.state.value)
        // TERMINAL_EXPERIENCE.md 9: the shortcut matrix is up before the session is, so a user can
        // see the keyboard they are about to type on.
        assertTrue(content.surface.chrome.shortcutMatrix)
        assertEquals(80, content.surface.size.columns)
        assertTrue(content.followingBottom)
    }

    @Test
    fun telnetCarriesTheCleartextWarningAndASelectableCodePage() = runTest(mainDispatcher) {
        val subject = subject(
            connection = SessionFixtures.connection(protocol = Protocol.TELNET, port = 23, encoding = TerminalEncoding.GBK),
        )
        subscribe(subject)

        val content = contentOf(subject.state.value)
        assertEquals(TerminalViewModel.CLEARTEXT_WARNING, content.cleartextWarning)
        assertTrue(content.encodingSelectable)
        assertEquals(TerminalEncoding.GBK, content.encoding)
        // No SFTP over Telnet: the dock entry is absent rather than present and dead.
        assertFalse(content.dock.contains(TerminalDockItem.FILES))
        assertEquals(TerminalCharset.GBK, subject.controller.state.value.charset)
    }

    @Test
    fun sshHasNoWarningNoCodePagePickerAndAFilesEntry() = runTest(mainDispatcher) {
        val subject = subject()
        subscribe(subject)

        val content = contentOf(subject.state.value)
        assertNull(content.cleartextWarning)
        // Offering a picker that changes nothing would suggest SSH negotiates a code page.
        assertFalse(content.encodingSelectable)
        assertTrue(content.dock.contains(TerminalDockItem.FILES))
    }

    @Test
    fun switchingTheCodePageRetargetsTheSurfaceWithoutReconnecting() = runTest(mainDispatcher) {
        val host = FakeHost()
        val subject = subject(
            connection = SessionFixtures.connection(protocol = Protocol.TELNET, port = 23),
            host = host,
        )
        subscribe(subject)
        subject.connect()
        runCurrent()

        subject.setEncoding(TerminalEncoding.BIG5)
        runCurrent()

        assertEquals(TerminalCharset.BIG5, subject.controller.state.value.charset)
        assertEquals(TerminalEncoding.BIG5, contentOf(subject.state.value).encoding)
        // A code page is a local decoding decision, not a renegotiation.
        assertEquals(1, host.opens)
    }

    // ---- disclosure ------------------------------------------------------------------------------

    @Test
    fun aSharedRelaySessionKeepsSayingHowItIsExecuted() = runTest(mainDispatcher) {
        val relayed = subject(
            connection = SessionFixtures.connection(
                residency = Residency.SHARED_ONLINE_ONLY,
                capabilities = SessionFixtures.useOnly,
                sharedUsePolicy = SharedUsePolicy.RELAY_ONLY,
            ),
        )
        subscribe(relayed)
        assertEquals(TerminalViewModel.DISCLOSURE_RELAY, contentOf(relayed.state.value).executionDisclosure)

        val direct = subject(
            connection = SessionFixtures.connection(
                residency = Residency.SHARED_ONLINE_ONLY,
                capabilities = SessionFixtures.useOnly,
                sharedUsePolicy = SharedUsePolicy.DIRECT_ALLOWED,
            ),
        )
        subscribe(direct)
        assertEquals(TerminalViewModel.DISCLOSURE_DIRECT, contentOf(direct.state.value).executionDisclosure)

        // An owned connection says nothing: there is nothing to disclose.
        val owned = subject()
        subscribe(owned)
        assertNull(contentOf(owned.state.value).executionDisclosure)
    }

    // ---- teardown --------------------------------------------------------------------------------

    @Test
    fun aFailedOpenKeepsTheReasonOnTheRow() = runTest(mainDispatcher) {
        val registry = SessionRegistry()
        val host = FakeHost(
            outcome = TerminalOpenOutcome.Failed(MobileError.local("auth_failed", "认证失败", retryable = true)),
        )
        val subject = subject(registry = registry, host = host)
        subscribe(subject)

        subject.connect()
        runCurrent()

        assertTrue(subject.state.value is PageState.RetryableError)
        val row = registry.find(SESSION)
        assertEquals(SessionTransport.DISCONNECTED, row?.transport)
        // The row explains itself in the list too, not only inside the tab.
        assertEquals("认证失败", row?.detail)
    }

    @Test
    fun disconnectClosesTheRowAndTheHost() = runTest(mainDispatcher) {
        val registry = SessionRegistry()
        val host = FakeHost()
        val subject = subject(registry = registry, host = host)
        subscribe(subject)
        subject.connect()
        runCurrent()

        subject.disconnect()
        runCurrent()

        assertEquals(SessionTransport.CLOSED, registry.find(SESSION)?.transport)
        assertEquals(NOW, registry.find(SESSION)?.endedAt ?: 0L)
        assertEquals(listOf(SESSION), host.closedSessions)
    }

    @Test
    fun minimisingKeepsTheSessionLive() = runTest(mainDispatcher) {
        val registry = SessionRegistry()
        val subject = subject(registry = registry)
        subscribe(subject)
        subject.connect()
        runCurrent()

        subject.minimise()
        runCurrent()

        val row = registry.find(SESSION)
        assertTrue(row?.minimised ?: false)
        // Minimised is a flag, not a transport state: the socket is untouched.
        assertEquals(SessionTransport.CONNECTED, row?.transport)
    }

    @Test
    fun clearingTheViewModelClosesTheEmulator() = runTest(mainDispatcher) {
        val emulator = FakeEmulator()
        val store = ViewModelStore()
        val factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = subject(emulator = emulator) as T
        }
        val subject = ViewModelProvider(store, factory)[TerminalViewModel::class.java]
        subscribe(subject)

        store.clear()

        // The emulator holds a native handle; leaking it would leak the whole scrollback buffer.
        assertTrue(emulator.closed)
    }

    private companion object {
        const val SESSION = "s1"
        const val NOW = 5_000L
    }
}
