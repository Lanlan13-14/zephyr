package one.zephyr.mobile.feature.filesync

import one.zephyr.mobile.protocol.rdp.FileSyncShareProfile

/**
 * Turns an authorised directory into the profile an RDP session can resolve a drive from.
 *
 * This is the seam that was missing. `SafZft2FileProvider` could serve bytes and `SafShareGrants`
 * could hold a grant, but `ZephyrOneRoot` passed `driveProfileProvider = { null }`, so
 * `RdpDrivePolicy` could only ever answer `file_share_unavailable` and both were unreachable code.
 *
 * The mapping lives here rather than in `protocol-rdp` because the direction of knowledge matters:
 * file-sync knows what a SAF grant is and what an RDP profile needs, while `protocol-rdp` must stay
 * ignorant of SAF so it can also be driven by the iOS bookmark chain and by tests.
 *
 * Every field is carried across unchanged, including [SafShareGrant.grantValid]. Filtering invalid
 * grants out here would be the wrong place: `RdpDrivePolicy.resolve` distinguishes "no directory is
 * authorised" from "the directory grant is no longer valid", and the second produces a message that
 * tells the user which directory to re-authorise. Dropping the row would collapse both into the
 * first.
 */
fun SafShareGrant.toDriveProfile(): FileSyncShareProfile = FileSyncShareProfile(
    profileId = profileId,
    shareName = shareName,
    readOnly = readOnly,
    grantValid = grantValid,
)

/**
 * Chooses which authorised directory a connection uses, and builds a provider for it.
 *
 * Deliberately a small object with no Android types: the selection rule is a product decision
 * (DEVELOPMENT.md 13.2 allows several profiles and puts the chosen id on the device-local override),
 * and the rule is what a JVM test can check. Building the [SafZft2FileProvider] is a one-line
 * factory call, but it belongs next to the selection so the readOnly value that reaches the provider
 * is the same one the profile advertised.
 */
class FileSyncShareCoordinator(
    private val grants: SafShareGrants,
    /**
     * Which profile a given connection should use, when the user has chosen one.
     *
     * Device-local, per DEVELOPMENT.md 13.2: the synced connection carries only
     * `storageIntent=enabled/ask/off`, never a profile id, because a profile id names a grant that
     * exists on exactly one device.
     */
    private val profileForConnection: (String) -> String?,
    private val treeFactory: (String) -> SafDocumentTree,
) {

    /**
     * The profile for [connectionId], or null when the user has not chosen a directory.
     *
     * Null is the correct answer for `storageIntent=ask` before the user answers: the RDP policy
     * turns it into `NeedsUserChoice` and the session prompts, which is what DEVELOPMENT.md 13.2
     * asks for. It must not be confused with "a directory is chosen but its grant died", which
     * returns a profile with `grantValid = false`.
     */
    fun profile(connectionId: String): FileSyncShareProfile? {
        val explicit = profileForConnection(connectionId)
        if (explicit != null) return grants.grant(explicit)?.toDriveProfile()
        /* No explicit choice, so fall back only when exactly one directory is authorised.
         *
         * Picking the first of several would silently share a directory the user did not mean for
         * this connection, and the whole point of the per-connection override is that the choice is
         * explicit. One authorised directory has no ambiguity to resolve. */
        return grants.usable().singleOrNull()?.toDriveProfile()
    }

    /**
     * A provider bound to [profileId], or null when its grant cannot serve.
     *
     * The provider's `readOnly` comes from the stored grant rather than from the caller, so the
     * value that reaches the per-operation checks is the one the grant was narrowed to. ADR-004
     * requires the provider to enforce read-only itself, and handing it a value from somewhere else
     * is how the two drift.
     */
    fun provider(profileId: String): SafZft2FileProvider? {
        val grant = grants.grant(profileId)?.takeIf { it.grantValid } ?: return null
        return SafZft2FileProvider(
            tree = treeFactory(grant.treeUri),
            readOnly = grant.readOnly,
        )
    }
}
