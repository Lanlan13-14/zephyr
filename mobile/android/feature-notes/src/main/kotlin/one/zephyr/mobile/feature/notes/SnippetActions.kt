package one.zephyr.mobile.feature.notes

import one.zephyr.mobile.contracts.Capability
import one.zephyr.mobile.model.ActionGate
import one.zephyr.mobile.model.CapabilitySet
import one.zephyr.mobile.model.Snippet

/** The five S33 row actions (SCREEN_CATALOG.md 14). */
enum class SnippetAction { EDIT, DELETE, COPY, INSERT, EXECUTE }

/**
 * The terminal a snippet would be sent to.
 *
 * Carries the connection's [CapabilitySet] rather than a boolean so the gate reads the same
 * capability the server will re-check, and a null target means no session is open at all. The
 * session id is kept because "insert into the current terminal" has to name *which* terminal when
 * several are running.
 */
data class SnippetTarget(
    val sessionId: String,
    val connectionId: String,
    val displayName: String,
    val capabilities: CapabilitySet,
)

/** What has to happen before a snippet's text reaches a terminal. */
sealed interface SnippetSendDecision {

    /** The gate refused. [gate] is never Allowed here, so the UI already has its reason. */
    data class Blocked(val gate: ActionGate) : SnippetSendDecision

    /**
     * A blocking dialog must be shown first.
     *
     * @param execute true when confirming will run the command rather than only type it, which is
     *   the difference the dialog has to state.
     */
    data class NeedsConfirmation(val codes: Set<DangerCode>, val execute: Boolean) : SnippetSendDecision

    /** Nothing further is required. [execute] false means the text lands on the prompt unrun. */
    data class Send(val execute: Boolean) : SnippetSendDecision
}

/**
 * Capability gating and the confirmation policy for snippet actions.
 *
 * The frozen rule from SCREEN_CATALOG.md 14 is a two-part split that is easy to get wrong:
 * inserting into the current terminal does *not* need EXECUTE, while actually running the command
 * needs the connection's EXECUTE, and a dangerous command still goes through the confirmation
 * policy either way. Both halves live here as one decision table so no screen can implement half
 * of it.
 */
object SnippetActions {

    fun gate(snippet: Snippet, action: SnippetAction, target: SnippetTarget?): ActionGate = when (action) {
        SnippetAction.EDIT ->
            if (snippet.capabilities.canEdit) ActionGate.Allowed else ActionGate.Hidden(Capability.EDIT)

        SnippetAction.DELETE ->
            if (snippet.capabilities.canDelete) ActionGate.Allowed else ActionGate.Hidden(Capability.DELETE)

        // Copying is a clipboard action on text the user is already looking at, so it needs no
        // grant at all. Gating it would be theatre.
        SnippetAction.COPY -> ActionGate.Allowed

        SnippetAction.INSERT -> when {
            target == null -> ActionGate.Disabled(Capability.USE, REASON_NO_SESSION)
            // Insert does not need EXECUTE. autoRun is the one exception the frozen text implies
            // rather than spells out: an autoRun snippet runs the instant it lands, so inserting it
            // *is* executing it and it has to clear the same gate. Treating it as a plain insert
            // would be a capability bypass with an extra step.
            snippet.autoRun -> executeGate(target)
            else -> ActionGate.Allowed
        }

        SnippetAction.EXECUTE ->
            if (target == null) ActionGate.Disabled(Capability.USE, REASON_NO_SESSION) else executeGate(target)
    }

    private fun executeGate(target: SnippetTarget): ActionGate =
        if (target.capabilities.canExecute) {
            ActionGate.Allowed
        } else {
            // Disabled rather than hidden: the user can see the snippet and the terminal, so hiding
            // the action would read as a bug instead of as a permission boundary.
            ActionGate.Disabled(Capability.EXECUTE, REASON_NO_EXECUTE)
        }

    fun visibleActions(snippet: Snippet, target: SnippetTarget?): List<SnippetAction> =
        SnippetAction.entries.filter { gate(snippet, it, target).isVisible }

    /** Insert into the current terminal. Runs nothing unless autoRun says otherwise. */
    fun decideInsert(snippet: Snippet, target: SnippetTarget?): SnippetSendDecision {
        val gate = gate(snippet, SnippetAction.INSERT, target)
        if (!gate.isAllowed) return SnippetSendDecision.Blocked(gate)
        if (!snippet.autoRun) return SnippetSendDecision.Send(execute = false)
        return dangerDecision(snippet, execute = true)
    }

    fun decideExecute(snippet: Snippet, target: SnippetTarget?): SnippetSendDecision {
        val gate = gate(snippet, SnippetAction.EXECUTE, target)
        if (!gate.isAllowed) return SnippetSendDecision.Blocked(gate)
        return dangerDecision(snippet, execute = true)
    }

    private fun dangerDecision(snippet: Snippet, execute: Boolean): SnippetSendDecision {
        val codes = DangerousCommand.classify(snippet.command)
        return if (codes.isEmpty()) {
            SnippetSendDecision.Send(execute)
        } else {
            SnippetSendDecision.NeedsConfirmation(codes, execute)
        }
    }

    /**
     * The bytes-worth of text to send once every gate and prompt is satisfied.
     *
     * The trailing newline is the entire difference between insert and execute: without it the
     * command sits on the prompt for the user to read and edit, which is what makes insert the safe
     * action the spec says it is.
     */
    fun payload(snippet: Snippet, execute: Boolean): String =
        if (execute) snippet.command + "\n" else snippet.command

    /**
     * Reason text for [ActionGate.Disabled].
     *
     * Kept as constants because the core [ActionGate] type carries its reason as a String, which is
     * the same shape ConnectionActions uses. Everything a screen renders itself comes from
     * strings.xml instead.
     */
    const val REASON_NO_SESSION = "没有正在运行的终端会话"
    const val REASON_NO_EXECUTE = "此连接没有执行命令的权限"
}
