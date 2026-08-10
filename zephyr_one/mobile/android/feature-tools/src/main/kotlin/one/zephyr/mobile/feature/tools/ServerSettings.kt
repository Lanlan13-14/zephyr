package one.zephyr.mobile.feature.tools

import one.zephyr.mobile.contracts.EntityRegistry

/**
 * The four S48 sections.
 *
 * Frozen as exactly these by SCREEN_CATALOG.md 23: appearance, notes, AI runtime availability, and
 * version/capability/runtime status. Modelling them as an enum is what stops a later edit from
 * quietly adding SMTP or account security to the list, because a new entry has to name the registry
 * fields it edits and [ServerSettingsPolicy.assertNoExcludedScope] rejects an excluded scope.
 *
 * @param editableFields registry field names from EntityRegistry.byType("serverSettings"). Empty for
 *   a section that is read-only for everyone.
 */
enum class ServerSettingsSection(val key: String, val editableFields: List<String>) {
    APPEARANCE("appearance", listOf("appearance")),
    NOTES("notes", listOf("notes")),

    /**
     * AI *runtime availability*, not the AI settings surface.
     *
     * S48 shows whether the runtime is usable and what it permits. Providers, Memory, Skills and Env
     * are separate synced entities with their own screens, which is why only the ai.* flags the
     * registry publishes on serverSettings appear here.
     */
    AI_RUNTIME(
        "ai",
        listOf("ai.enabled", "ai.permissions", "ai.context", "ai.memory.enabled", "ai.memory.maxItems"),
    ),

    /** Version, capability set and runtime status are server authority: nobody edits them. */
    VERSION_STATUS("status", emptyList()),
    ;

    val isReadOnlyForEveryone: Boolean get() = editableFields.isEmpty()
}

/** One row of the read-only status block. */
data class ServerStatusItem(val label: String, val value: String)

/** What S48 renders. */
data class ServerSettingsUiState(
    val role: ServerRole,
    /** Sections the server authorised this account to edit. Intersected with the role gate. */
    val authorizedSections: Set<ServerSettingsSection> = emptySet(),
    val appearanceSummary: String = "",
    val notesEnabled: Boolean = false,
    val aiRuntimeAvailable: Boolean = false,
    val aiEnabled: Boolean = false,
    val aiMemoryEnabled: Boolean = false,
    val aiMemoryMaxItems: Int = 0,
    val serverVersion: String = "",
    val protocolVersion: Int = 0,
    val capabilityCount: Int = 0,
    val statusItems: List<ServerStatusItem> = emptyList(),
    val lastRefreshedAt: Long? = null,
) {
    fun isEditable(section: ServerSettingsSection): Boolean =
        ServerSettingsPolicy.isEditable(section, role, authorizedSections)
}

/**
 * S48 visibility and editability.
 *
 * Two rules, kept apart on purpose. Visibility is frozen by the spec and identical for every role:
 * a normal user still sees the effective settings, they simply cannot change them. Editability is the
 * intersection of the role gate and the server's own authorisation, so One never enables a control
 * the main end would refuse.
 */
object ServerSettingsPolicy {

    /**
     * Scopes One must never render, let alone edit.
     *
     * Read from the frozen registry rather than retyped: PRODUCT_REQUIREMENTS.md 3.2 keeps account
     * security, SMTP, CAPTCHA, IP policy, 备案, custom CSS/JS and multi-user administration on the
     * main end, and duplicating the list here is how the two copies eventually disagree.
     */
    val excludedScopes: List<String> = EntityRegistry.excludedEditableScopes

    /** Every role sees the same four sections; only editability differs. */
    fun visibleSections(role: ServerRole): List<ServerSettingsSection> =
        ServerSettingsSection.entries.toList()

    fun isEditable(
        section: ServerSettingsSection,
        role: ServerRole,
        authorizedSections: Set<ServerSettingsSection>,
    ): Boolean {
        if (section.isReadOnlyForEveryone) return false
        if (!role.canEditServerSettings) return false
        return section in authorizedSections
    }

    fun editableSections(
        role: ServerRole,
        authorizedSections: Set<ServerSettingsSection>,
    ): List<ServerSettingsSection> =
        visibleSections(role).filter { isEditable(it, role, authorizedSections) }

    /**
     * Fails fast if a section ever names an excluded scope.
     *
     * A real guard rather than a comment: it runs over the enum in a unit test, so reintroducing SMTP
     * as a section breaks the build's test phase instead of shipping a settings page the product spec
     * forbids.
     */
    fun assertNoExcludedScope() {
        for (section in ServerSettingsSection.entries) {
            require(EntityRegistry.isEditableScope(section.key) || section.isReadOnlyForEveryone) {
                "S48 section " + section.key + " is main-end only and must not appear in Zephyr One"
            }
            for (field in section.editableFields) {
                val scope = field.substringBefore('.')
                require(EntityRegistry.isEditableScope(scope)) {
                    "S48 field " + field + " names excluded scope " + scope
                }
            }
        }
    }

    /**
     * Registry fields a section may put in a fieldMask.
     *
     * Returns empty for a read-only section so a caller cannot accidentally build a mask for the
     * status block, which is entirely server authority.
     */
    fun maskFor(section: ServerSettingsSection): List<String> = section.editableFields

    /** The reason shown next to a disabled section, so read-only is never unexplained. */
    fun readOnlyReason(section: ServerSettingsSection, role: ServerRole): String = when {
        section.isReadOnlyForEveryone -> REASON_SERVER_AUTHORITY
        !role.canEditServerSettings -> REASON_NEEDS_ADMIN
        else -> REASON_NOT_AUTHORIZED
    }

    const val REASON_SERVER_AUTHORITY = "由主端维护，仅供查看"
    const val REASON_NEEDS_ADMIN = "需要管理员权限才能修改"
    const val REASON_NOT_AUTHORIZED = "主端未授权此账号修改该分区"

    const val SECTION_KEY = "default"
}