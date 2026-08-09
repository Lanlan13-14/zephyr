package one.zephyr.mobile.feature.tools

/**
 * What a finished batch run is allowed to leave behind.
 *
 * SCREEN_CATALOG.md 16 is explicit: the command audit keeps truncated metadata only, and neither
 * secrets nor whole stdout may be pushed into core sync. Two consequences are encoded here rather
 * than left to a caller's discretion.
 *
 * First, [BatchAuditRecord] carries no stdout or stderr at all. Truncating output does not sanitise
 * it - a token printed in the first line of `env` survives any prefix cut - so the only safe rule is
 * exclusion, with [BatchTargetAudit.outputBytes] recording that output existed and how much.
 *
 * Second, there is deliberately no repository write here. `activityEvent` is append-only with no
 * editable fields in the frozen registry, so [LocalWriteGateway] rejects an attempt to queue one; the
 * audit therefore travels through [BatchAuditSink], which the app module binds to a device-local
 * store. That is the structural version of "never into core sync".
 *
 * [BatchAudit.exportText] is the separate, explicit export DEVELOPMENT.md 14.5 permits. It does
 * include output, because the user asked for it by name and chose the destination themselves; that is
 * a different act from an audit trail written behind their back.
 */
data class BatchAuditRecord(
    /** Truncated command. The user authored it and it is already on screen, so a prefix is enough. */
    val commandPreview: String,
    val commandLength: Int,
    val timeoutSeconds: Int,
    val concurrency: Int,
    val failFast: Boolean,
    val startedAt: Long?,
    val finishedAt: Long?,
    val summary: BatchSummary,
    val targets: List<BatchTargetAudit>,
) {
    val durationMs: Long?
        get() = if (startedAt != null && finishedAt != null) finishedAt - startedAt else null

    val commandWasTruncated: Boolean get() = commandLength > commandPreview.length
}

/** Per-host metadata. Status, code and timing only: enough to audit, not enough to leak. */
data class BatchTargetAudit(
    val connectionId: String,
    val status: BatchTargetStatus,
    val exitCode: Int?,
    val durationMs: Long?,
    /** Byte count only. Records that output happened without recording what it said. */
    val outputBytes: Int,
    /** Stable error code, never the message: a message can quote the offending command. */
    val errorCode: String?,
)

/**
 * Where an audit record goes.
 *
 * A port because the destination is a device-local store the app module owns, and because a feature
 * module must not be able to reach the sync queue by accident.
 */
interface BatchAuditSink {
    suspend fun record(record: BatchAuditRecord)
}

/** Drops the record. Used where no audit store is wired yet, so the run itself still works. */
object NoopBatchAuditSink : BatchAuditSink {
    override suspend fun record(record: BatchAuditRecord) = Unit
}

object BatchAudit {

    /** Command prefix kept in the audit. Long enough to identify the run, short enough to stay metadata. */
    const val COMMAND_PREVIEW_CHARS = 120

    fun recordOf(state: BatchRunState): BatchAuditRecord = BatchAuditRecord(
        commandPreview = state.plan.command.take(COMMAND_PREVIEW_CHARS),
        commandLength = state.plan.command.length,
        timeoutSeconds = state.plan.timeoutSeconds,
        concurrency = state.plan.concurrency,
        failFast = state.plan.failFast,
        startedAt = state.startedAt,
        finishedAt = state.finishedAt,
        summary = state.summary,
        targets = state.targets.map { row ->
            BatchTargetAudit(
                connectionId = row.target.connectionId,
                status = row.status,
                exitCode = row.exitCode,
                durationMs = row.durationMs,
                outputBytes = row.stdout.length + row.stderr.length,
                errorCode = row.error?.code,
            )
        },
    )

    /**
     * The user's explicit export.
     *
     * Includes stdout and stderr in full: this is the artefact the operator asked for, written to a
     * location they picked through the system picker. It is never produced as a side effect of
     * viewing results, and it never goes through the sync queue.
     */
    fun exportText(state: BatchRunState): String = buildString {
        appendLine("# Zephyr One 批量执行结果")
        appendLine("命令: " + state.plan.command)
        appendLine("超时: " + state.plan.timeoutSeconds + "s  并发: " + state.plan.concurrency +
            "  fail-fast: " + (if (state.plan.failFast) "开" else "关"))
        val counts = state.summary
        appendLine(
            "主机: " + counts.total + "  成功: " + counts.succeeded + "  失败: " + counts.failed +
                "  超时: " + counts.timedOut + "  已取消: " + counts.cancelled + "  无权限: " + counts.denied,
        )
        appendLine()
        for (row in state.targets) {
            appendLine("## " + row.target.name + " (" + row.target.displayAddress + ")")
            appendLine("状态: " + row.status.name + "  exit: " + (row.exitCode?.toString() ?: "-") +
                "  耗时: " + (row.durationMs?.toString() ?: "-") + "ms")
            row.error?.let { appendLine("错误: " + it.code + " " + it.message) }
            if (row.stdout.isNotEmpty()) {
                appendLine("--- stdout ---")
                appendLine(row.stdout)
            }
            if (row.stderr.isNotEmpty()) {
                appendLine("--- stderr ---")
                appendLine(row.stderr)
            }
            appendLine()
        }
    }
}