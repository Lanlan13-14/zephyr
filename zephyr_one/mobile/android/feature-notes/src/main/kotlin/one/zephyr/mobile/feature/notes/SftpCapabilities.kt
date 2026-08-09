package one.zephyr.mobile.feature.notes

import one.zephyr.mobile.contracts.Capability
import one.zephyr.mobile.model.ActionGate
import one.zephyr.mobile.model.CapabilitySet

/**
 * The S31 action set.
 *
 * An enum rather than loose call sites so every action has exactly one gate; a new action fails to
 * compile in [SftpCapabilities.gate] until its capability is stated.
 */
enum class SftpAction {
    LIST,
    STAT,
    READ,
    DOWNLOAD,
    UPLOAD,
    CREATE,
    EDIT,
    RENAME,
    DELETE,
}

/**
 * The frozen capability map from SCREEN_CATALOG.md 12.
 *
 * list/stat/read/download require fileRead; upload/new/edit/rename/delete require fileWrite. The
 * split is transcribed here as a table rather than checked at each call site, because a screen that
 * guessed "delete probably needs delete" would be gating on the wrong capability and would let a
 * read-only grant reach a write call.
 */
object SftpCapabilities {

    fun required(action: SftpAction): Capability = when (action) {
        SftpAction.LIST, SftpAction.STAT, SftpAction.READ, SftpAction.DOWNLOAD -> Capability.FILE_READ
        SftpAction.UPLOAD,
        SftpAction.CREATE,
        SftpAction.EDIT,
        SftpAction.RENAME,
        SftpAction.DELETE,
        -> Capability.FILE_WRITE
    }

    /**
     * Read actions are hidden without fileRead: without it the whole browser is unavailable, so an
     * individual disabled row would be noise. Write actions stay visible and disabled with a reason,
     * because the user can see the files and would otherwise wonder why editing vanished.
     */
    fun gate(capabilities: CapabilitySet, action: SftpAction): ActionGate {
        val needed = required(action)
        if (capabilities.contains(needed)) return ActionGate.Allowed
        return if (needed == Capability.FILE_READ) {
            ActionGate.Hidden(needed)
        } else {
            ActionGate.Disabled(needed, REASON_NO_WRITE)
        }
    }

    fun allowed(capabilities: CapabilitySet, action: SftpAction): Boolean =
        gate(capabilities, action).isAllowed

    fun visibleActions(capabilities: CapabilitySet): List<SftpAction> =
        SftpAction.entries.filter { gate(capabilities, it).isVisible }

    /** True when the browser itself cannot be shown at all. */
    fun canBrowse(capabilities: CapabilitySet): Boolean = capabilities.canReadFiles

    const val REASON_NO_WRITE = "此连接只授予了只读文件权限"
    const val REASON_NO_READ = "此连接没有文件读取权限"
}
