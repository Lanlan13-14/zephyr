package one.zephyr.mobile.feature.connections

import one.zephyr.mobile.contracts.EntityRegistry
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.ConnectionMode
import one.zephyr.mobile.model.FileSyncDirectoryIntent
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.model.SecretPresence
import one.zephyr.mobile.model.SecretState
import one.zephyr.mobile.model.TerminalEncoding
import one.zephyr.mobile.model.sync.FieldMask
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S11 editor logic.
 *
 * The mask assertions matter most: LocalWriteGateway sanitises the mask again and rejects the write
 * outright when nothing survives, so a draft that produces a field the registry does not publish
 * would fail at save time rather than here.
 */
class ConnectionDraftTest {

    @Test
    fun `superseded and disposed secret buffers are overwritten`() {
        val originalPassword = SecretState.Replace("first-password")
        val replacementPassword = SecretState.Replace("second-password")
        val privateKey = SecretState.Replace("private-key")
        val draft = ConnectionDraft.create("owner", "connection")
            .withPassword(originalPassword)
            .withPassword(replacementPassword)
            .withPrivateKey(privateKey)

        assertTrue(originalPassword.isWiped())

        val cleared = draft.wipeSecretBuffers()
        assertTrue(replacementPassword.isWiped())
        assertTrue(privateKey.isWiped())
        assertEquals(SecretState.Unchanged, cleared.password)
        assertEquals(SecretState.Unchanged, cleared.privateKey)
    }

    // ---- port and protocol ---------------------------------------------------------------------

    @Test
    fun createUsesProtocolDefaultPort() {
        assertEquals(22, ConnectionDraft.create(Fixtures.OWNER, "c-new", Protocol.SSH).current.port)
        assertEquals(3389, ConnectionDraft.create(Fixtures.OWNER, "c-new", Protocol.RDP).current.port)
        assertEquals(5900, ConnectionDraft.create(Fixtures.OWNER, "c-new", Protocol.VNC).current.port)
        assertEquals(23, ConnectionDraft.create(Fixtures.OWNER, "c-new", Protocol.TELNET).current.port)
    }

    @Test
    fun untouchedPortFollowsProtocolSwitch() {
        val draft = ConnectionDraft.create(Fixtures.OWNER, "c-new", Protocol.SSH)
            .withProtocol(Protocol.RDP)
        assertEquals(3389, draft.current.port)
    }

    @Test
    fun editedPortSurvivesProtocolSwitch() {
        val draft = ConnectionDraft.create(Fixtures.OWNER, "c-new", Protocol.SSH)
            .withPort(2222)
            .withProtocol(Protocol.RDP)
        assertEquals(2222, draft.current.port)
    }

    @Test
    fun storedDefaultPortStillFollowsProtocolSwitch() {
        // A saved SSH row on 22 never had a deliberate port, so switching to RDP should land on 3389
        // rather than leaving the user on a port RDP does not serve.
        val draft = ConnectionDraft.edit(Fixtures.connection(protocol = Protocol.SSH, port = 22))
        assertFalse(draft.portWasEdited)
        assertEquals(3389, draft.withProtocol(Protocol.RDP).current.port)
    }

    @Test
    fun storedCustomPortSurvivesProtocolSwitch() {
        val draft = ConnectionDraft.edit(Fixtures.connection(protocol = Protocol.SSH, port = 2222))
        assertTrue(draft.portWasEdited)
        assertEquals(2222, draft.withProtocol(Protocol.RDP).current.port)
    }

    @Test
    fun switchingToTheSameProtocolIsANoOp() {
        val draft = ConnectionDraft.create(Fixtures.OWNER, "c-new", Protocol.SSH)
        assertEquals(draft, draft.withProtocol(Protocol.SSH))
    }

    // ---- telnet incompatibility ------------------------------------------------------------------

    @Test
    fun telnetClearsSshKeyAndStoredPrivateKey() {
        val stored = Fixtures.connection(
            protocol = Protocol.SSH,
            privateKey = SecretPresence(hasValue = true),
        ).copy(sshKeyId = "k-1")
        val draft = ConnectionDraft.edit(stored).withProtocol(Protocol.TELNET)
        assertNull(draft.current.sshKeyId)
        // The stored secret is explicitly cleared rather than orphaned: Telnet cannot use it and a
        // silently retained private key would still be pushed on the next edit.
        assertEquals(SecretState.Clear, draft.privateKey)
    }

    @Test
    fun telnetKeepsPasswordAndRoute() {
        val stored = Fixtures.connection(protocol = Protocol.SSH)
            .copy(connectionMode = ConnectionMode.PROXY, proxyId = "p-1")
        val draft = ConnectionDraft.edit(stored)
            .withPassword(SecretState.Replace("hunter2"))
            .withProtocol(Protocol.TELNET)
        assertEquals("p-1", draft.current.proxyId)
        assertEquals(ConnectionMode.PROXY, draft.current.connectionMode)
        assertEquals(SecretState.Replace("hunter2"), draft.password)
    }

    @Test
    fun telnetWithoutAStoredKeyLeavesThePrivateKeyUnchanged() {
        val draft = ConnectionDraft.edit(Fixtures.connection(protocol = Protocol.SSH))
            .withProtocol(Protocol.TELNET)
        assertEquals(SecretState.Unchanged, draft.privateKey)
    }

    @Test
    fun telnetClearsAPrivateKeyTypedInThisSession() {
        val draft = ConnectionDraft.create(Fixtures.OWNER, "c-new", Protocol.SSH)
            .withPrivateKey(SecretState.Replace("-----BEGIN-----"))
            .withProtocol(Protocol.TELNET)
        assertEquals(SecretState.Clear, draft.privateKey)
    }

    @Test
    fun telnetOmitsThePrivateKeyFromSecretStatesUnlessCleared() {
        val plain = ConnectionDraft.create(Fixtures.OWNER, "c-new", Protocol.TELNET)
        assertFalse(plain.secretStates().containsKey("privateKey"))
        assertTrue(plain.secretStates().containsKey("password"))

        val cleared = ConnectionDraft.edit(
            Fixtures.connection(protocol = Protocol.SSH, privateKey = SecretPresence(hasValue = true)),
        ).withProtocol(Protocol.TELNET)
        assertEquals(SecretState.Clear, cleared.secretStates()["privateKey"])
    }

    // ---- connection mode -------------------------------------------------------------------------

    @Test
    fun directModeClearsProxyAndJumpChain() {
        val draft = ConnectionDraft.create(Fixtures.OWNER, "c-new")
            .withConnectionMode(ConnectionMode.JUMP)
            .withJumpHostAdded("j-1")
            .withProxy("p-1")
            .withConnectionMode(ConnectionMode.DIRECT)
        assertNull(draft.current.proxyId)
        assertEquals(0, draft.current.jumpHostIds.size)
    }

    @Test
    fun proxyModeClearsTheJumpChain() {
        val draft = ConnectionDraft.create(Fixtures.OWNER, "c-new")
            .withJumpHostAdded("j-1")
            .withConnectionMode(ConnectionMode.PROXY)
        assertEquals(0, draft.current.jumpHostIds.size)
    }

    @Test
    fun jumpModeClearsTheProxy() {
        val draft = ConnectionDraft.create(Fixtures.OWNER, "c-new")
            .withProxy("p-1")
            .withConnectionMode(ConnectionMode.JUMP)
        assertNull(draft.current.proxyId)
    }

    // ---- jump chain ------------------------------------------------------------------------------

    @Test
    fun jumpChainRefusesDuplicates() {
        val draft = ConnectionDraft.create(Fixtures.OWNER, "c-new")
            .withJumpHostAdded("j-1")
            .withJumpHostAdded("j-1")
        assertEquals(listOf("j-1"), draft.current.jumpHostIds)
    }

    @Test
    fun jumpChainStopsAtEightLevels() {
        var draft = ConnectionDraft.create(Fixtures.OWNER, "c-new")
        for (index in 1..12) draft = draft.withJumpHostAdded("j-" + index)
        assertEquals(Connection.MAX_JUMP_DEPTH, draft.current.jumpHostIds.size)
        assertEquals("j-8", draft.current.jumpHostIds.last())
    }

    @Test
    fun jumpChainReorders() {
        val draft = ConnectionDraft.create(Fixtures.OWNER, "c-new")
            .withJumpHostAdded("j-1")
            .withJumpHostAdded("j-2")
            .withJumpHostAdded("j-3")
        assertEquals(listOf("j-3", "j-1", "j-2"), draft.withJumpHostMoved(2, 0).current.jumpHostIds)
        assertEquals(listOf("j-2", "j-1", "j-3"), draft.withJumpHostMoved(0, 1).current.jumpHostIds)
    }

    @Test
    fun jumpChainMoveClampsInsteadOfThrowing() {
        val draft = ConnectionDraft.create(Fixtures.OWNER, "c-new")
            .withJumpHostAdded("j-1")
            .withJumpHostAdded("j-2")
        assertEquals(listOf("j-2", "j-1"), draft.withJumpHostMoved(0, 99).current.jumpHostIds)
        assertEquals(draft, draft.withJumpHostMoved(7, 0))
    }

    @Test
    fun jumpChainRemovesOneHop() {
        val draft = ConnectionDraft.create(Fixtures.OWNER, "c-new")
            .withJumpHostAdded("j-1")
            .withJumpHostAdded("j-2")
            .withJumpHostRemoved("j-1")
        assertEquals(listOf("j-2"), draft.current.jumpHostIds)
    }

    // ---- secrets ---------------------------------------------------------------------------------

    @Test
    fun blankReplacementFoldsToClear() {
        val draft = ConnectionDraft.create(Fixtures.OWNER, "c-new")
            .withPassword(SecretState.Replace("   "))
        // Storing an empty plaintext would leave a credential that cannot authenticate.
        assertEquals(SecretState.Clear, draft.password)
    }

    @Test
    fun secretOnlyChangeCountsAsUnsavedWork() {
        val draft = ConnectionDraft.edit(Fixtures.connection())
        assertFalse(draft.isDirty)
        assertTrue(draft.withPassword(SecretState.Replace("hunter2")).isDirty)
        assertTrue(draft.withPrivateKey(SecretState.Clear).isDirty)
    }

    @Test
    fun presenceReflectsTheTriState() {
        val stored = SecretPresence(hasValue = true, secretRef = "connection/c-1/password")
        assertEquals(stored, ConnectionDraft.presenceFor(SecretState.Unchanged, stored))
        assertEquals(SecretPresence.absent, ConnectionDraft.presenceFor(SecretState.Clear, stored))
        assertTrue(ConnectionDraft.presenceFor(SecretState.Replace("x"), stored).hasValue)
        // A replacement must not leak the stored ref, which would let the UI show an old secret.
        assertNull(ConnectionDraft.presenceFor(SecretState.Replace("x"), stored).secretRef)
    }

    // ---- normalisation ---------------------------------------------------------------------------

    @Test
    fun normalisationTrimsAndDropsBlankTags() {
        val draft = ConnectionDraft.create(Fixtures.OWNER, "c-new")
            .withName("  prod  ")
            .withHost("  10.0.0.9  ")
            .withUsername("  root ")
            .withTags(listOf("prod", "  ", "", " edge "))
        val normalized = draft.normalized()
        assertEquals("prod", normalized.name)
        assertEquals("10.0.0.9", normalized.host)
        assertEquals("root", normalized.username)
        assertEquals(listOf("prod", "edge"), normalized.tags)
    }

    @Test
    fun normalisationCollapsesRepeatedTags() {
        val draft = ConnectionDraft.create(Fixtures.OWNER, "c-new").withTags(listOf("a", "a", "b"))
        assertEquals(listOf("a", "b"), draft.normalized().tags)
    }

    @Test
    fun ephemeralConnectionWithoutANameGetsOneDerived() {
        val draft = ConnectionDraft.create(Fixtures.OWNER, "c-new", Protocol.SSH)
            .withHost("10.0.0.9")
        val ephemeral = draft.copy(current = draft.current.copy(ephemeral = true))
        assertEquals("SSH 10.0.0.9", ephemeral.normalized().name)
        // A persistent connection keeps the empty name so validation can reject it.
        assertEquals("", draft.normalized().name)
    }

    // ---- field mask ------------------------------------------------------------------------------

    @Test
    fun createMasksEveryApplicableField() {
        val draft = ConnectionDraft.create(Fixtures.OWNER, "c-new", Protocol.SSH)
        assertEquals(ConnectionDraft.fieldsFor(Protocol.SSH), draft.changedFields())
    }

    @Test
    fun editMasksOnlyWhatChanged() {
        val draft = ConnectionDraft.edit(Fixtures.connection()).withName("renamed")
        assertEquals(listOf("name"), draft.changedFields())
    }

    @Test
    fun anUntouchedEditMasksNothing() {
        assertEquals(0, ConnectionDraft.edit(Fixtures.connection()).changedFields().size)
    }

    @Test
    fun jumpChainEditMasksBothChainAndLegacyField() {
        val draft = ConnectionDraft.edit(Fixtures.connection())
            .withConnectionMode(ConnectionMode.JUMP)
            .withJumpHostAdded("j-1")
        val mask = draft.changedFields()
        assertTrue(mask.contains("jumpHostIds"))
        // A server that only understands the single-hop field must still see the first hop.
        assertTrue(mask.contains("jumpHostId"))
    }

    @Test
    fun everyProtocolMaskSurvivesRegistrySanitation() {
        for (protocol in Protocol.entries) {
            val draft = ConnectionDraft.create(Fixtures.OWNER, "c-new", protocol)
            val mask = draft.changedFields()
            val sanitized = FieldMask.sanitize(Connection.ENTITY_TYPE, mask)
            assertEquals(protocol.wireName + " rejections", 0, sanitized.rejected.size)
            assertEquals(protocol.wireName + " accepted", mask, sanitized.accepted)
        }
    }

    @Test
    fun maskNeverNamesSecretsOrServerAuthorityFields() {
        val spec = EntityRegistry.byType.getValue(Connection.ENTITY_TYPE)
        val forbidden = spec.forbiddenMaskFields.toSet()
        for (protocol in Protocol.entries) {
            for (field in ConnectionDraft.fieldsFor(protocol)) {
                assertFalse(protocol.wireName + " masks " + field, forbidden.contains(field))
            }
        }
    }

    @Test
    fun secretMutationsStayOutsideEveryProtocolFieldMask() {
        for (protocol in Protocol.entries) {
            val draft = ConnectionDraft.create(Fixtures.OWNER, "c-new", protocol)
                .withPassword(SecretState.Replace("password"))

            assertFalse(protocol.wireName + " masks password", draft.changedFields().contains("password"))
            assertEquals(
                protocol.wireName + " sends password through secret states",
                SecretState.Replace("password"),
                draft.secretStates()["password"],
            )
        }

        val sshDraft = ConnectionDraft.create(Fixtures.OWNER, "c-new", Protocol.SSH)
            .withPrivateKey(SecretState.Clear)
        assertFalse(sshDraft.changedFields().contains("privateKey"))
        assertEquals(SecretState.Clear, sshDraft.secretStates()["privateKey"])
    }

    @Test
    fun sshMaskExcludesRdpFields() {
        val mask = ConnectionDraft.fieldsFor(Protocol.SSH)
        assertFalse(mask.any { it.startsWith("rdp") })
        assertTrue(mask.contains("sshKeyId"))
        assertTrue(mask.contains("encoding"))
    }

    @Test
    fun rdpMaskExcludesTerminalOnlyFields() {
        val mask = ConnectionDraft.fieldsFor(Protocol.RDP)
        assertTrue(mask.contains("rdpTouchSensitivity"))
        assertTrue(mask.contains("rdpDomain"))
        // A framebuffer protocol has no character set and no SSH key.
        assertFalse(mask.contains("encoding"))
        assertFalse(mask.contains("sshKeyId"))
    }

    @Test
    fun vncMaskCarriesNeitherRdpNorTerminalFields() {
        val mask = ConnectionDraft.fieldsFor(Protocol.VNC)
        assertFalse(mask.any { it.startsWith("rdp") })
        assertFalse(mask.contains("encoding"))
        assertFalse(mask.contains("sshKeyId"))
        assertTrue(mask.contains("host"))
    }

    @Test
    fun switchingAwayFromRdpDoesNotMaskRdpFieldsSoServerValuesSurvive() {
        val stored = Fixtures.connection(protocol = Protocol.RDP, port = 3389)
        val draft = ConnectionDraft.edit(stored).withProtocol(Protocol.SSH)
        val mask = draft.changedFields()
        assertTrue(mask.contains("protocol"))
        // Omitting the RDP fields leaves the server copy untouched, so switching back restores them.
        assertFalse(mask.any { it.startsWith("rdp") })
    }

    @Test
    fun theDeviceLocalDirectoryIntentIsNeverMasked() {
        val draft = ConnectionDraft.edit(Fixtures.connection())
            .withFileSyncIntent(FileSyncDirectoryIntent.SERVER_BRIDGE)
        assertEquals(0, draft.changedFields().size)
        assertTrue(draft.fileSyncIntentChanged)
        assertTrue(draft.isDirty)
    }

    // ---- validation ------------------------------------------------------------------------------

    @Test
    fun aCompleteSshDraftValidates() {
        val draft = ConnectionDraft.create(Fixtures.OWNER, "c-new", Protocol.SSH)
            .withName("prod")
            .withHost("10.0.0.9")
            .withUsername("root")
        assertEquals(0, draft.validate().size)
        assertTrue(draft.canSave)
    }

    @Test
    fun missingNameAndHostAreReportedAgainstTheirFields() {
        val issues = ConnectionDraft.create(Fixtures.OWNER, "c-new", Protocol.VNC).validate()
        assertTrue(issues.contains(DraftIssue("name", ConnectionDraft.MSG_NAME_REQUIRED)))
        assertTrue(issues.contains(DraftIssue("host", ConnectionDraft.MSG_HOST_REQUIRED)))
    }

    @Test
    fun portRangeIsEnforced() {
        val base = ConnectionDraft.create(Fixtures.OWNER, "c-new", Protocol.VNC)
            .withName("v")
            .withHost("h")
        assertEquals(listOf(DraftIssue("port", ConnectionDraft.MSG_PORT_RANGE)), base.withPort(0).validate())
        assertEquals(listOf(DraftIssue("port", ConnectionDraft.MSG_PORT_RANGE)), base.withPort(65536).validate())
        assertEquals(0, base.withPort(65535).validate().size)
        assertEquals(0, base.withPort(1).validate().size)
    }

    @Test
    fun onlySshRequiresAUsername() {
        val ssh = ConnectionDraft.create(Fixtures.OWNER, "c-new", Protocol.SSH)
            .withName("n").withHost("h")
        assertTrue(ssh.validate().contains(DraftIssue("username", ConnectionDraft.MSG_USERNAME_REQUIRED)))
        for (protocol in listOf(Protocol.TELNET, Protocol.RDP, Protocol.VNC)) {
            val other = ConnectionDraft.create(Fixtures.OWNER, "c-new", protocol)
                .withName("n").withHost("h")
            assertEquals(protocol.wireName, 0, other.validate().size)
        }
    }

    @Test
    fun proxyModeRequiresAProxyAndJumpModeRequiresAChain() {
        val base = ConnectionDraft.create(Fixtures.OWNER, "c-new", Protocol.VNC)
            .withName("n").withHost("h")
        assertTrue(
            base.withConnectionMode(ConnectionMode.PROXY).validate()
                .contains(DraftIssue("proxyId", ConnectionDraft.MSG_PROXY_REQUIRED)),
        )
        assertTrue(
            base.withConnectionMode(ConnectionMode.JUMP).validate()
                .contains(DraftIssue("jumpHostIds", ConnectionDraft.MSG_JUMP_REQUIRED)),
        )
    }

    @Test
    fun aRevokedDependencyAsksForRouteRepair() {
        val stored = Fixtures.connection().copy(
            connectionMode = ConnectionMode.PROXY,
            proxyId = "p-gone",
            sshKeyId = "k-gone",
        )
        val issues = ConnectionDraft.edit(stored).validate(Fixtures.inventory())
        assertTrue(issues.contains(DraftIssue("proxyId", ConnectionDraft.MSG_ROUTE_REPAIR)))
        assertTrue(issues.contains(DraftIssue("sshKeyId", ConnectionDraft.MSG_ROUTE_REPAIR)))
    }

    @Test
    fun aBrokenJumpChainIsReportedOnceNotPerHop() {
        val stored = Fixtures.connection().copy(
            connectionMode = ConnectionMode.JUMP,
            jumpHostIds = listOf("j-gone-1", "j-gone-2"),
        )
        val issues = ConnectionDraft.edit(stored).routeIssues(Fixtures.inventory())
        assertEquals(1, issues.size)
        assertEquals(DraftIssue("jumpHostIds", ConnectionDraft.MSG_ROUTE_REPAIR), issues.first())
    }

    @Test
    fun usableDependenciesRaiseNoRouteIssue() {
        val stored = Fixtures.connection().copy(
            connectionMode = ConnectionMode.JUMP,
            jumpHostIds = listOf("j-1", "j-2"),
            sshKeyId = "k-1",
        )
        assertEquals(0, ConnectionDraft.edit(stored).routeIssues(Fixtures.inventory()).size)
    }

    @Test
    fun anInvalidDraftCannotBeSaved() {
        assertFalse(ConnectionDraft.create(Fixtures.OWNER, "c-new").canSave)
    }

    @Test
    fun anUnchangedEditCannotBeSaved() {
        // Nothing to push: saving would queue an operation with an empty mask, which the gateway
        // rejects as empty_field_mask anyway.
        assertFalse(ConnectionDraft.edit(Fixtures.connection()).canSave)
    }

    // ---- sections and options --------------------------------------------------------------------

    @Test
    fun sectionsKeepTheFrozenOrder() {
        val rdp = ConnectionDraft.create(Fixtures.OWNER, "c-new", Protocol.RDP).sections()
        assertEquals(EditorSection.entries.toList(), rdp)
    }

    @Test
    fun rdpSectionsAppearOnlyForRdp() {
        for (protocol in Protocol.entries) {
            val sections = ConnectionDraft.create(Fixtures.OWNER, "c-new", protocol).sections()
            val hasRdp = sections.contains(EditorSection.RDP_CHANNELS) &&
                sections.contains(EditorSection.RDP_DISPLAY)
            assertEquals(protocol.wireName, protocol == Protocol.RDP, hasRdp)
        }
    }

    @Test
    fun theFileSyncSectionAppearsOnlyWhereAFileChannelExists() {
        // SSH has SFTP and RDP has the drive channel; Telnet and VNC carry no file transport, so
        // offering a directory intent there would promise something the protocol cannot do.
        val expected = mapOf(
            Protocol.SSH to true,
            Protocol.RDP to true,
            Protocol.TELNET to false,
            Protocol.VNC to false,
        )
        for ((protocol, present) in expected) {
            val sections = ConnectionDraft.create(Fixtures.OWNER, "c-new", protocol).sections()
            assertEquals(protocol.wireName, present, sections.contains(EditorSection.FILE_SYNC))
        }
    }

    @Test
    fun basicSectionFieldVisibilityFollowsTheProtocol() {
        val ssh = ConnectionDraft.create(Fixtures.OWNER, "c-new", Protocol.SSH)
        assertFalse(ssh.showsDomainField)
        assertTrue(ssh.showsEncodingField)
        assertTrue(ssh.showsSshKeyField)

        val rdp = ConnectionDraft.create(Fixtures.OWNER, "c-new", Protocol.RDP)
        assertTrue(rdp.showsDomainField)
        assertFalse(rdp.showsEncodingField)
        assertFalse(rdp.showsSshKeyField)
    }

    @Test
    fun onlyTelnetOffersTheLegacyCodePages() {
        assertEquals(listOf(TerminalEncoding.UTF8), ConnectionDraft.availableEncodings(Protocol.SSH))
        val telnet = ConnectionDraft.availableEncodings(Protocol.TELNET)
        assertTrue(telnet.contains(TerminalEncoding.GBK))
        assertTrue(telnet.contains(TerminalEncoding.BIG5))
        assertTrue(telnet.contains(TerminalEncoding.LATIN1))
    }
}
