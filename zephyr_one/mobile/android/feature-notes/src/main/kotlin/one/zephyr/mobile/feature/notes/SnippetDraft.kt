package one.zephyr.mobile.feature.notes

import one.zephyr.mobile.model.Snippet

/** Why a snippet draft cannot be saved. Codes, not text: the wording lives in strings.xml. */
enum class SnippetIssueCode {
    NAME_REQUIRED,
    NAME_TOO_LONG,
    COMMAND_REQUIRED,
    COMMAND_TOO_LONG,
    GROUP_TOO_LONG,
    ACCOUNT_LIMIT_REACHED,
}

data class SnippetIssue(val field: String, val code: SnippetIssueCode)

/**
 * The S33 editor state.
 *
 * Same original/current shape as [NoteDraft], for the same reason: the fieldMask is a diff and
 * "unsaved changes" is a diff. The frozen limits (name 60, command 20000, group 40, 500 per
 * account) are checked here rather than at the repository, so an over-long command is a form error
 * the user can fix instead of a rejected push (SCREEN_CATALOG.md 14).
 */
data class SnippetDraft(
    val original: Snippet?,
    val current: Snippet,
    /** Snippets already stored for this account, so a create can enforce the 500 ceiling. */
    val existingCount: Int = 0,
) {
    val isCreate: Boolean get() = original == null

    val isDirty: Boolean get() = isCreate || current != original

    val nameLength: Int get() = current.name.length
    val commandLength: Int get() = current.command.length

    val remainingNameChars: Int get() = Snippet.MAX_NAME_CHARS - nameLength
    val remainingCommandChars: Int get() = Snippet.MAX_COMMAND_CHARS - commandLength

    fun withName(value: String): SnippetDraft = copy(current = current.copy(name = value))

    fun withCommand(value: String): SnippetDraft = copy(current = current.copy(command = value))

    fun withGroup(value: String): SnippetDraft = copy(current = current.copy(group = value))

    fun withAutoRun(value: Boolean): SnippetDraft = copy(current = current.copy(autoRun = value))

    /**
     * The row to persist.
     *
     * The command keeps its interior formatting verbatim, because a here-doc or an indented
     * continuation is meaningful shell text; only the trailing newline a multi-line text field adds
     * is dropped, so an "insert" does not turn into an accidental "execute". Name and group are
     * trimmed because they are labels.
     */
    fun normalized(): Snippet = current.copy(
        name = current.name.trim(),
        command = current.command.trimEnd('\n', '\r'),
        group = current.group.trim(),
    )

    fun validate(): List<SnippetIssue> = buildList {
        val candidate = normalized()
        if (candidate.name.isEmpty()) add(SnippetIssue("name", SnippetIssueCode.NAME_REQUIRED))
        if (candidate.name.length > Snippet.MAX_NAME_CHARS) {
            add(SnippetIssue("name", SnippetIssueCode.NAME_TOO_LONG))
        }
        // An empty command would insert nothing and execute nothing, so it is a form error rather
        // than a snippet that silently does not work.
        if (candidate.command.isEmpty()) {
            add(SnippetIssue("command", SnippetIssueCode.COMMAND_REQUIRED))
        }
        if (candidate.command.length > Snippet.MAX_COMMAND_CHARS) {
            add(SnippetIssue("command", SnippetIssueCode.COMMAND_TOO_LONG))
        }
        if (candidate.group.length > Snippet.MAX_GROUP_CHARS) {
            add(SnippetIssue("group", SnippetIssueCode.GROUP_TOO_LONG))
        }
        // Only a create can cross the ceiling; editing the 500th snippet must stay possible.
        if (isCreate && existingCount >= Snippet.MAX_PER_ACCOUNT) {
            add(SnippetIssue("name", SnippetIssueCode.ACCOUNT_LIMIT_REACHED))
        }
    }

    fun issueFor(field: String, issues: List<SnippetIssue>): SnippetIssue? =
        issues.firstOrNull { it.field == field }

    val canSave: Boolean get() = validate().isEmpty() && isDirty

    /**
     * Registry field names that changed.
     *
     * A create names all four, because the server has no row to merge against. An edit names only
     * what moved, which is what keeps a concurrent edit of a different field from becoming a
     * conflict (SYNC_STATE_MACHINE.md 4.3).
     */
    fun changedFields(): List<String> {
        val base = original ?: return FIELDS
        val candidate = normalized()
        return FIELDS.filter { field ->
            val read = READERS.getValue(field)
            read(candidate) != read(base)
        }
    }

    companion object {
        fun create(
            ownerUserId: String,
            snippetId: String,
            existingCount: Int = 0,
            group: String = "",
        ): SnippetDraft = SnippetDraft(
            original = null,
            current = Snippet(
                id = snippetId,
                ownerUserId = ownerUserId,
                name = "",
                command = "",
                group = group,
            ),
            existingCount = existingCount,
        )

        fun edit(snippet: Snippet, existingCount: Int = 0): SnippetDraft =
            SnippetDraft(original = snippet, current = snippet, existingCount = existingCount)

        /** Exactly the frozen registry's editableFields for snippet, in registry order. */
        val FIELDS: List<String> = listOf("name", "command", "group", "autoRun")

        /**
         * Field readers keyed by registry field name.
         *
         * A table rather than a when-chain so a field with no reader is simply never masked, which
         * fails closed instead of pushing an unverified value.
         */
        private val READERS: Map<String, (Snippet) -> Any?> = linkedMapOf(
            "name" to { s: Snippet -> s.name },
            "command" to { s: Snippet -> s.command },
            "group" to { s: Snippet -> s.group },
            "autoRun" to { s: Snippet -> s.autoRun },
        )
    }
}
