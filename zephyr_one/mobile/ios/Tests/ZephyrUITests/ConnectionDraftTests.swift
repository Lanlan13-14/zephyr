import XCTest
@testable import ZephyrUI

/// S11 editor logic, mirrored from the Kotlin ConnectionDraftTest.
///
/// The mask assertions matter most: the local write gateway sanitises the
/// mask again and rejects the write outright when nothing survives, so a
/// draft that produces a field the registry does not publish would fail at
/// save time rather than here.
final class ConnectionDraftTests: XCTestCase {

    // ---- port and protocol ------------------------------------------------------

    func testCreateUsesProtocolDefaultPort() {
        XCTAssertEqual(22, ConnectionDraft.create(ownerUserId: UiTestData.owner, connectionId: "c-new", protocol: .ssh).current.port)
        XCTAssertEqual(3389, ConnectionDraft.create(ownerUserId: UiTestData.owner, connectionId: "c-new", protocol: .rdp).current.port)
        XCTAssertEqual(5900, ConnectionDraft.create(ownerUserId: UiTestData.owner, connectionId: "c-new", protocol: .vnc).current.port)
        XCTAssertEqual(23, ConnectionDraft.create(ownerUserId: UiTestData.owner, connectionId: "c-new", protocol: .telnet).current.port)
    }

    func testUntouchedPortFollowsProtocolSwitch() {
        let draft = ConnectionDraft.create(ownerUserId: UiTestData.owner, connectionId: "c-new", protocol: .ssh)
            .withProtocol(.rdp)
        XCTAssertEqual(3389, draft.current.port)
    }

    func testEditedPortSurvivesProtocolSwitch() {
        let draft = ConnectionDraft.create(ownerUserId: UiTestData.owner, connectionId: "c-new", protocol: .ssh)
            .withPort(2222)
            .withProtocol(.rdp)
        XCTAssertEqual(2222, draft.current.port)
    }

    func testStoredDefaultPortStillFollowsProtocolSwitch() {
        let draft = ConnectionDraft.edit(UiTestData.connection(protocol: .ssh, port: 22))
        XCTAssertFalse(draft.portWasEdited)
        XCTAssertEqual(3389, draft.withProtocol(.rdp).current.port)
    }

    func testStoredCustomPortSurvivesProtocolSwitch() {
        let draft = ConnectionDraft.edit(UiTestData.connection(protocol: .ssh, port: 2222))
        XCTAssertTrue(draft.portWasEdited)
        XCTAssertEqual(2222, draft.withProtocol(.rdp).current.port)
    }

    func testSwitchingToTheSameProtocolIsANoOp() {
        let draft = ConnectionDraft.create(ownerUserId: UiTestData.owner, connectionId: "c-new", protocol: .ssh)
        XCTAssertEqual(draft, draft.withProtocol(.ssh))
    }

    // ---- telnet incompatibility --------------------------------------------------

    func testTelnetClearsSshKeyAndStoredPrivateKey() {
        var stored = UiTestData.connection(
            protocol: .ssh,
            privateKey: SecretPresence(hasValue: true)
        )
        stored.sshKeyId = "k-1"
        let draft = ConnectionDraft.edit(stored).withProtocol(.telnet)
        XCTAssertNil(draft.current.sshKeyId)
        /* The stored secret is explicitly cleared rather than orphaned: Telnet
         * cannot use it and a silently retained private key would still be
         * pushed on the next edit. */
        XCTAssertEqual(SecretState.clear, draft.privateKey)
    }

    func testTelnetKeepsPasswordAndRoute() {
        var stored = UiTestData.connection(protocol: .ssh)
        stored.connectionMode = .proxy
        stored.proxyId = "p-1"
        let draft = ConnectionDraft.edit(stored)
            .withPassword(.replace("hunter2"))
            .withProtocol(.telnet)
        XCTAssertEqual("p-1", draft.current.proxyId)
        XCTAssertEqual(ConnectionMode.proxy, draft.current.connectionMode)
        XCTAssertEqual(SecretState.replace("hunter2"), draft.password)
    }

    func testTelnetWithoutAStoredKeyLeavesThePrivateKeyUnchanged() {
        let draft = ConnectionDraft.edit(UiTestData.connection(protocol: .ssh))
            .withProtocol(.telnet)
        XCTAssertEqual(SecretState.unchanged, draft.privateKey)
    }

    func testTelnetClearsAPrivateKeyTypedInThisSession() {
        let draft = ConnectionDraft.create(ownerUserId: UiTestData.owner, connectionId: "c-new", protocol: .ssh)
            .withPrivateKey(.replace("-----BEGIN-----"))
            .withProtocol(.telnet)
        XCTAssertEqual(SecretState.clear, draft.privateKey)
    }

    func testTelnetOmitsThePrivateKeyFromSecretStatesUnlessCleared() {
        let plain = ConnectionDraft.create(ownerUserId: UiTestData.owner, connectionId: "c-new", protocol: .telnet)
        XCTAssertNil(plain.secretStates()["privateKey"])
        XCTAssertNotNil(plain.secretStates()["password"])

        let cleared = plain.withPrivateKey(.clear)
        XCTAssertEqual(SecretState.clear, cleared.secretStates()["privateKey"])
    }

    // ---- secret tri-state --------------------------------------------------------

    func testBlankReplacementFoldsToClear() {
        let draft = ConnectionDraft.create(ownerUserId: UiTestData.owner, connectionId: "c-new")
            .withPassword(.replace("   "))
        XCTAssertEqual(SecretState.clear, draft.password)
    }

    func testSecretChangeAloneMakesTheDraftDirty() {
        let draft = ConnectionDraft.edit(UiTestData.connection())
            .withPassword(.replace("hunter2"))
        XCTAssertTrue(draft.isDirty)
        XCTAssertTrue(draft.changedFields().isEmpty)
    }

    func testUnchangedSecretNeverEntersTheMask() {
        let draft = ConnectionDraft.edit(UiTestData.connection())
            .withName("renamed")
        XCTAssertEqual(draft.changedFields(), ["name"])
        XCTAssertEqual(draft.secretStates()["password"], .unchanged)
        XCTAssertFalse(draft.secretStates()["password"]?.contributesToFieldMask ?? true)
    }

    func testPresenceForReflectsTheTriState() {
        let stored = SecretPresence(hasValue: true, secretRef: "connection/c-1/password")
        XCTAssertEqual(stored, ConnectionDraft.presenceFor(state: .unchanged, stored: stored))
        XCTAssertEqual(.absent, ConnectionDraft.presenceFor(state: .clear, stored: stored))
        XCTAssertEqual(
            SecretPresence(hasValue: true),
            ConnectionDraft.presenceFor(state: .replace("x"), stored: .absent)
        )
    }

    // ---- the field mask -------------------------------------------------------------

    func testCreateNamesEveryApplicableField() {
        let draft = ConnectionDraft.create(ownerUserId: UiTestData.owner, connectionId: "c-new", protocol: .ssh)
        let mask = draft.changedFields()
        XCTAssertEqual(mask, ConnectionDraft.fieldsFor(.ssh))
        XCTAssertTrue(mask.contains("name"))
        XCTAssertTrue(mask.contains("encoding"))
        XCTAssertTrue(mask.contains("sshKeyId"))
        XCTAssertFalse(mask.contains("rdpQuality"))
        XCTAssertFalse(mask.contains("password"))
        XCTAssertFalse(mask.contains("fileSyncIntent"))
    }

    func testEditMasksOnlyChangedFields() {
        let draft = ConnectionDraft.edit(UiTestData.connection())
            .withHost("10.0.0.9")
            .withRemark("迁移")
        XCTAssertEqual(draft.changedFields(), ["host", "remark"])
    }

    func testMaskOrderFollowsTheRegistryTable() {
        let draft = ConnectionDraft.edit(UiTestData.connection())
            .withRemark("z")
            .withName("a")
        XCTAssertEqual(draft.changedFields(), ["name", "remark"])
    }

    func testRdpFieldsAreMaskedOnlyForRdp() {
        XCTAssertTrue(ConnectionDraft.fieldsFor(.rdp).contains("rdpTouchSensitivity"))
        XCTAssertFalse(ConnectionDraft.fieldsFor(.ssh).contains("rdpTouchSensitivity"))
        XCTAssertFalse(ConnectionDraft.fieldsFor(.vnc).contains("encoding"))
        XCTAssertTrue(ConnectionDraft.fieldsFor(.telnet).contains("encoding"))
        XCTAssertFalse(ConnectionDraft.fieldsFor(.telnet).contains("sshKeyId"))
    }

    func testJumpHostIdMirrorsTheFirstHop() {
        var stored = UiTestData.connection()
        stored.jumpHostIds = ["j-1"]
        let draft = ConnectionDraft.edit(stored)
            .withJumpHostAdded("j-2")
        XCTAssertEqual(draft.changedFields(), ["jumpHostIds"])

        let fromEmpty = ConnectionDraft.edit(UiTestData.connection())
            .withJumpHostAdded("j-1")
        XCTAssertEqual(fromEmpty.changedFields(), ["jumpHostIds", "jumpHostId"])
    }

    // ---- jump chain -----------------------------------------------------------------

    func testJumpChainRefusesDuplicates() {
        let draft = ConnectionDraft.edit(UiTestData.connection())
            .withJumpHostAdded("j-1")
            .withJumpHostAdded("j-1")
        XCTAssertEqual(draft.current.jumpHostIds, ["j-1"])
    }

    func testJumpChainIsCappedAtEight() {
        var draft = ConnectionDraft.edit(UiTestData.connection())
        for index in 1...9 {
            draft = draft.withJumpHostAdded("j-\(index)")
        }
        XCTAssertEqual(draft.current.jumpHostIds.count, Connection.maxJumpDepth)
    }

    func testJumpMoveClampsOutOfRangeTargets() {
        let draft = ConnectionDraft.edit(UiTestData.connection())
            .withJumpHostAdded("j-1")
            .withJumpHostAdded("j-2")
            .withJumpHostMoved(from: 0, to: 99)
        XCTAssertEqual(draft.current.jumpHostIds, ["j-2", "j-1"])
        XCTAssertEqual(
            draft.withJumpHostMoved(from: 7, to: 0),
            draft
        )
    }

    // ---- normalisation ---------------------------------------------------------------

    func testNormalizedTrimsAndDeduplicates() {
        var stored = UiTestData.connection(host: "  10.0.0.1  ", username: " root ")
        stored.tags = [" a ", "", "a", "b"]
        let draft = ConnectionDraft.edit(stored)
        let row = draft.normalized()
        XCTAssertEqual("10.0.0.1", row.host)
        XCTAssertEqual("root", row.username)
        XCTAssertEqual(["a", "b"], row.tags)
    }

    func testEphemeralFallbackName() {
        var stored = UiTestData.connection(name: "", host: "example.org")
        stored.ephemeral = true
        let row = ConnectionDraft.edit(stored).normalized()
        XCTAssertEqual("SSH example.org", row.name)
    }

    func testNormalisationIsPartOfTheDiff() {
        // The stored row has an untrimmed host; normalising the draft produces
        // the same value, so host must not enter the mask.
        let stored = UiTestData.connection(host: "10.0.0.1")
        let draft = ConnectionDraft.edit(stored).withHost("  10.0.0.1 ")
        XCTAssertFalse(draft.changedFields().contains("host"))
    }

    // ---- validation -------------------------------------------------------------------

    func testNameHostAndPortAreRequired() {
        let draft = ConnectionDraft.create(ownerUserId: UiTestData.owner, connectionId: "c-new")
        let issues = draft.validate(inventory: UiTestData.inventory())
        XCTAssertTrue(issues.contains(DraftIssue(field: "name", message: ConnectionDraft.msgNameRequired)))
        XCTAssertTrue(issues.contains(DraftIssue(field: "host", message: ConnectionDraft.msgHostRequired)))
        XCTAssertFalse(issues.contains { $0.field == "port" })
    }

    func testPortRangeIsValidated() {
        let draft = ConnectionDraft.create(ownerUserId: UiTestData.owner, connectionId: "c-new")
            .withPort(0)
        XCTAssertTrue(draft.validate().contains(DraftIssue(field: "port", message: ConnectionDraft.msgPortRange)))
    }

    func testSshRequiresAUsername() {
        var stored = UiTestData.connection(username: "")
        stored.name = "x"
        let draft = ConnectionDraft.edit(stored)
        XCTAssertTrue(draft.validate().contains(DraftIssue(field: "username", message: ConnectionDraft.msgUsernameRequired)))

        let telnet = draft.withProtocol(.telnet)
        XCTAssertFalse(telnet.validate().contains { $0.field == "username" })
    }

    func testProxyModeRequiresAProxy() {
        let draft = ConnectionDraft.edit(UiTestData.connection())
            .withConnectionMode(.proxy)
        XCTAssertTrue(
            draft.validate(inventory: UiTestData.inventory())
                .contains(DraftIssue(field: "proxyId", message: ConnectionDraft.msgProxyRequired))
        )
    }

    func testJumpModeRequiresAtLeastOneHop() {
        let draft = ConnectionDraft.edit(UiTestData.connection())
            .withConnectionMode(.jump)
        XCTAssertTrue(
            draft.validate(inventory: UiTestData.inventory())
                .contains(DraftIssue(field: "jumpHostIds", message: ConnectionDraft.msgJumpRequired))
        )
    }

    func testRouteRepairIsReportedPerDependency() {
        var stored = UiTestData.connection()
        stored.proxyId = "p-gone"
        stored.sshKeyId = "k-1"
        let draft = ConnectionDraft.edit(stored)
        let issues = draft.routeIssues(inventory: UiTestData.inventory())
        XCTAssertEqual(issues, [DraftIssue(field: "proxyId", message: ConnectionDraft.msgRouteRepair)])
    }

    func testRouteRepairStopsAtTheFirstBrokenJump() {
        var stored = UiTestData.connection()
        stored.jumpHostIds = ["gone-1", "gone-2"]
        let draft = ConnectionDraft.edit(stored)
        XCTAssertEqual(draft.routeIssues(inventory: RouteInventory()).count, 1)
    }

    // ---- sections and visibility ---------------------------------------------------------

    func testSectionsFollowTheProtocol() {
        let ssh = ConnectionDraft.create(ownerUserId: UiTestData.owner, connectionId: "c-new", protocol: .ssh)
        XCTAssertEqual(
            ssh.sections(),
            [.basic, .auth, .route, .fileSync, .metadata]
        )

        let rdp = ConnectionDraft.create(ownerUserId: UiTestData.owner, connectionId: "c-new", protocol: .rdp)
        XCTAssertEqual(
            rdp.sections(),
            [.basic, .auth, .route, .rdpChannels, .rdpDisplay, .fileSync, .metadata]
        )

        let vnc = ConnectionDraft.create(ownerUserId: UiTestData.owner, connectionId: "c-new", protocol: .vnc)
        XCTAssertEqual(vnc.sections(), [.basic, .auth, .route, .metadata])
    }

    func testFieldVisibilityFlags() {
        let rdp = ConnectionDraft.create(ownerUserId: UiTestData.owner, connectionId: "c-new", protocol: .rdp)
        XCTAssertTrue(rdp.showsDomainField)
        XCTAssertFalse(rdp.showsEncodingField)
        XCTAssertFalse(rdp.showsSshKeyField)

        let ssh = ConnectionDraft.create(ownerUserId: UiTestData.owner, connectionId: "c-new", protocol: .ssh)
        XCTAssertTrue(ssh.showsEncodingField)
        XCTAssertTrue(ssh.showsSshKeyField)
    }

    func testAvailableEncodingsFollowTheProtocol() {
        XCTAssertEqual(ConnectionDraft.availableEncodings(.telnet), TerminalEncoding.allCases)
        XCTAssertEqual(ConnectionDraft.availableEncodings(.ssh), [.utf8])
    }

    // ---- dirty and canSave ------------------------------------------------------------------

    func testFileSyncIntentNeverEntersTheMask() {
        let draft = ConnectionDraft.edit(UiTestData.connection())
            .withFileSyncIntent(.localShare)
        XCTAssertTrue(draft.fileSyncIntentChanged)
        XCTAssertTrue(draft.changedFields().isEmpty)
        // The intent alone is not syncable work, so the draft is not dirty.
        XCTAssertFalse(draft.isDirty)
    }

    func testEditOfNothingIsNotDirty() {
        XCTAssertFalse(ConnectionDraft.edit(UiTestData.connection()).isDirty)
    }

    func testCreateIsAlwaysDirty() {
        XCTAssertTrue(
            ConnectionDraft.create(ownerUserId: UiTestData.owner, connectionId: "c-new").isDirty
        )
    }
}
