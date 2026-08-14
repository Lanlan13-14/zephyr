package one.zephyr.mobile.feature.tools

import one.zephyr.mobile.contracts.Capability
import one.zephyr.mobile.model.ActionGate

/**
 * The role the main end reports for the bound account.
 *
 * SCREEN_CATALOG.md 23 gates whole sections on it: a normal user sees effective settings read-only
 * while an admin sees editable sections. Modelled here rather than as a boolean because
 * super-admin and admin differ for backup restore, and a boolean would erase that.
 */
enum class ServerRole(val wireName: String) {
    USER("user"),
    ADMIN("admin"),
    SUPER_ADMIN("superAdmin"),
    ;

    val canEditServerSettings: Boolean get() = this != USER

    /** A restore rewrites the whole main end, so it stays with the highest role only. */
    val canRestoreBackup: Boolean get() = this == SUPER_ADMIN

    val canExportBackup: Boolean get() = this != USER

    companion object {
        val default = USER

        fun fromWire(value: String?): ServerRole =
            entries.firstOrNull { it.wireName == value } ?: default
    }
}

/**
 * The six S40 sections, in the frozen order (SCREEN_CATALOG.md 15).
 *
 * An enum rather than a list the screen builds: the island has only four root slots, so this page is
 * the only route to 服务器设置 and 备份与恢复, and a section that could be dropped by a refactor would
 * make them unreachable.
 */
enum class ToolSection { REMOTE_OPS, RESOURCES, AI, FILE_SYNC, SERVER, ONE }

/** Route names the app module's nav graph binds to. Kept as constants so both sides agree. */
object ToolRoutes {
    const val HOME = "tools"
    const val BATCH_EXEC = "tools/batch"
    const val DOCKER = "tools/ops/docker"
    const val MONITOR = "tools/ops/monitor"
    const val LOGS = "tools/ops/logs"
    const val PROXIES = "tools/resources/proxy"
    const val SSH_KEYS = "tools/resources/sshKey"
    const val JUMP_HOSTS = "tools/resources/jumpHost"
    const val AI = "tools/ai"
    const val FILE_SYNC = "tools/fileSync"
    const val CLIENT_TOKEN = "tools/fileSync/clientToken"
    const val SERVER_SETTINGS = "tools/server/settings"
    const val BACKUP = "tools/server/backup"
    const val RUNTIME_STATUS = "tools/server/status"
    const val ONE_SETTINGS = "tools/one"
}

/**
 * One S40 row.
 *
 * [anchor] exists because 外观 / 语言 / 本地解锁 / 网络 / 诊断 are five entries in the frozen list but
 * one screen (S50): the row scrolls the destination to its section instead of five near-identical
 * screens drifting apart.
 */
enum class ToolEntry(
    val section: ToolSection,
    val route: String,
    val anchor: OneSettingsAnchor? = null,
) {
    BATCH_EXEC(ToolSection.REMOTE_OPS, ToolRoutes.BATCH_EXEC),
    DOCKER(ToolSection.REMOTE_OPS, ToolRoutes.DOCKER),
    MONITOR(ToolSection.REMOTE_OPS, ToolRoutes.MONITOR),
    LOGS(ToolSection.REMOTE_OPS, ToolRoutes.LOGS),

    PROXY(ToolSection.RESOURCES, ToolRoutes.PROXIES),
    SSH_KEY(ToolSection.RESOURCES, ToolRoutes.SSH_KEYS),
    JUMP_HOST(ToolSection.RESOURCES, ToolRoutes.JUMP_HOSTS),

    AI_WORKSPACE(ToolSection.AI, ToolRoutes.AI),

    FILE_SYNC(ToolSection.FILE_SYNC, ToolRoutes.FILE_SYNC),
    CLIENT_TOKEN(ToolSection.FILE_SYNC, ToolRoutes.CLIENT_TOKEN),

    SERVER_SETTINGS(ToolSection.SERVER, ToolRoutes.SERVER_SETTINGS),
    BACKUP_RESTORE(ToolSection.SERVER, ToolRoutes.BACKUP),
    RUNTIME_STATUS(ToolSection.SERVER, ToolRoutes.RUNTIME_STATUS),

    APPEARANCE(ToolSection.ONE, ToolRoutes.ONE_SETTINGS, OneSettingsAnchor.APPEARANCE),
    LANGUAGE(ToolSection.ONE, ToolRoutes.ONE_SETTINGS, OneSettingsAnchor.LANGUAGE),
    APP_LOCK(ToolSection.ONE, ToolRoutes.ONE_SETTINGS, OneSettingsAnchor.APP_LOCK),
    NETWORK(ToolSection.ONE, ToolRoutes.ONE_SETTINGS, OneSettingsAnchor.NETWORK),
    DIAGNOSTICS(ToolSection.ONE, ToolRoutes.ONE_SETTINGS, OneSettingsAnchor.DIAGNOSTICS),
    ;

    companion object {
        fun of(section: ToolSection): List<ToolEntry> = entries.filter { it.section == section }
    }
}

/** Anchors inside S50, so the five One rows land on the right block. */
enum class OneSettingsAnchor { APPEARANCE, LANGUAGE, APP_LOCK, NETWORK, DIAGNOSTICS }

/**
 * What the tools page knows about the account and the mirror.
 *
 * Counts rather than lists: the page only decides whether an entry is reachable, and holding the
 * rows here would tempt a screen into rendering a connection picker it has no business owning.
 */
data class ToolsInventory(
    val executableSshCount: Int = 0,
    val observableSshCount: Int = 0,
    val proxyCount: Int = 0,
    val sshKeyCount: Int = 0,
    val jumpHostCount: Int = 0,
    val role: ServerRole = ServerRole.default,
    /** Reported by the main end; false when no AI runtime is configured or licensed. */
    val aiRuntimeAvailable: Boolean = false,
    val online: Boolean = true,
    val pendingSyncCount: Int = 0,
    val conflictCount: Int = 0,
)

/**
 * Reachability for every S40 row.
 *
 * The rule this object exists to enforce is SCREEN_CATALOG.md 15's structural one: 服务器设置 and
 * 备份与恢复 must be reachable from here, because the root island is frozen at four slots and has no
 * room for them. So neither is ever [ActionGate.Hidden] - a missing role or a missing network
 * disables the row *with its reason* and the row stays on screen.
 */
object ToolsCatalog {

    fun gate(entry: ToolEntry, inventory: ToolsInventory): ActionGate = when (entry) {
        // Batch execution writes to every target, so it needs EXECUTE on at least one SSH row.
        // Disabled rather than hidden: a new account with no connections should still learn the
        // feature exists and what it needs.
        ToolEntry.BATCH_EXEC ->
            if (inventory.executableSshCount > 0) ActionGate.Allowed
            else ActionGate.Disabled(Capability.EXECUTE, REASON_NO_EXECUTABLE_SSH)

        ToolEntry.DOCKER, ToolEntry.MONITOR, ToolEntry.LOGS ->
            if (inventory.observableSshCount > 0) ActionGate.Allowed
            else ActionGate.Disabled(Capability.OBSERVE, REASON_NO_OBSERVABLE_SSH)

        // The three dependency editors are always reachable: an empty list is a legitimate state
        // whose remedy is the create action on the destination.
        ToolEntry.PROXY, ToolEntry.SSH_KEY, ToolEntry.JUMP_HOST -> ActionGate.Allowed

        // AI settings and the floating workspace are device-local. Provider keys,
        // models and skills live on this phone. The main end is optional sync only.
        ToolEntry.AI_WORKSPACE -> ActionGate.Allowed

        ToolEntry.FILE_SYNC, ToolEntry.CLIENT_TOKEN -> ActionGate.Allowed

        // Readable offline: the effective settings come from the mirror, and the screen labels them
        // as a mirror with its age rather than refusing to open.
        ToolEntry.SERVER_SETTINGS -> ActionGate.Allowed

        // Local export/import is a device feature. Binding only adds a server-side
        // backup job — it must not hide the page.
        ToolEntry.BACKUP_RESTORE -> ActionGate.Allowed

        ToolEntry.RUNTIME_STATUS -> ActionGate.Allowed

        // Device-local settings. Always available, including offline and unbound.
        ToolEntry.APPEARANCE,
        ToolEntry.LANGUAGE,
        ToolEntry.APP_LOCK,
        ToolEntry.NETWORK,
        ToolEntry.DIAGNOSTICS,
        -> ActionGate.Allowed
    }

    /** Sections in demo order. */
    fun sections(): List<ToolSection> = ToolSection.entries.toList()

    fun rows(section: ToolSection): List<ToolEntry> = when (section) {
        ToolSection.REMOTE_OPS -> listOf(ToolEntry.BATCH_EXEC)
        ToolSection.RESOURCES -> listOf(ToolEntry.PROXY, ToolEntry.SSH_KEY)
        ToolSection.AI -> listOf(ToolEntry.AI_WORKSPACE)
        ToolSection.FILE_SYNC -> listOf(ToolEntry.FILE_SYNC, ToolEntry.CLIENT_TOKEN)
        ToolSection.SERVER -> listOf(ToolEntry.SERVER_SETTINGS)
        ToolSection.ONE -> listOf(
            ToolEntry.APPEARANCE,
            ToolEntry.LANGUAGE,
            ToolEntry.APP_LOCK,
            ToolEntry.DIAGNOSTICS,
        )
    }

    /**
     * Rows a screen may render.
     *
     * Entries omitted by demo.html remain routable from contextual surfaces but are not shown on
     * the tools home page.
     */
    fun visibleRows(section: ToolSection, inventory: ToolsInventory): List<ToolEntry> =
        rows(section).filter { gate(it, inventory).isVisible }

    /** Secondary line for a row: a count, a role note or the gate reason. */
    fun detailCount(entry: ToolEntry, inventory: ToolsInventory): Int? = when (entry) {
        ToolEntry.PROXY -> inventory.proxyCount
        ToolEntry.SSH_KEY -> inventory.sshKeyCount
        ToolEntry.JUMP_HOST -> inventory.jumpHostCount
        ToolEntry.BATCH_EXEC -> inventory.executableSshCount
        ToolEntry.DOCKER, ToolEntry.MONITOR, ToolEntry.LOGS -> inventory.observableSshCount
        else -> null
    }

    const val REASON_NO_EXECUTABLE_SSH = "需要至少一台你有执行权限的 SSH 连接"
    const val REASON_NO_OBSERVABLE_SSH = "需要至少一台你有观察权限的 SSH 连接"
    const val REASON_NEEDS_ADMIN = "需要管理员权限"
    const val REASON_OFFLINE = "需要联网才能同步"
}
