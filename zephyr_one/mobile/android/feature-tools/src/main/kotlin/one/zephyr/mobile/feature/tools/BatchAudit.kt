package one.zephyr.mobile.feature.tools

import java.security.MessageDigest
import one.zephyr.mobile.contracts.ErrorRegistry

/**
 * What a finished batch run is allowed to leave behind.
 *
 * A command may contain credentials in forms no redactor can reliably recognise. The audit record
 * therefore has no command text field, including a shortened or redacted one. It keeps a
 * domain-separated SHA-256 digest and the UTF-8 byte count so an operator can correlate runs
 * without making command content available to persistence, sync, serialization, or logging.
 *
 * The feature exposes only [BatchAuditSink]. The app must bind it to a device-local store: audit
 * records are not sync operations. This module has no legacy audit store or reader, so removing
 * the old preview field also leaves no in-module migration path that could display or
 * rewrite historical command text.
 *
 * [BatchAudit.exportText] remains an explicit user-requested export. It is not an audit record and
 * may include command output because the operator selected its destination.
 */
data class BatchAuditRecord(
    /** SHA-256 of a versioned domain tag followed by the command's UTF-8 bytes. */
    val commandDigest: String,
    /** Command size in UTF-8 bytes, not UTF-16 code units. */
    val commandUtf8ByteLength: Int,
    /** Number of selected targets represented by [results]. */
    val targetCount: Int,
    /** Result metadata only. There is no target identity, output, duration, or error message. */
    val results: List<BatchTargetAudit>,
)

/** Stable per-target outcome metadata that is safe to retain. */
data class BatchTargetAudit(
    val status: BatchTargetStatus,
    val exitCode: Int?,
    /** A registry or local stable code, never an arbitrary remote string or display message. */
    val errorCode: String?,
)

/**
 * Where an audit record goes.
 *
 * A port keeps the feature module unable to reach the sync queue by accident. Implementations must
 * treat every [BatchAuditRecord] field as the complete persistence contract and must not retain a
 * [BatchRunState] or command alongside it.
 */
interface BatchAuditSink {
    suspend fun record(record: BatchAuditRecord)
}

/** Drops the record. Used where no device-local audit store is wired yet. */
object NoopBatchAuditSink : BatchAuditSink {
    override suspend fun record(record: BatchAuditRecord) = Unit
}

object BatchAudit {

    /** Versioned domain separator so this digest cannot be confused with another SHA-256 use. */
    const val COMMAND_DIGEST_DOMAIN = "zephyr-one/mobile/batch-audit/command/v1"

    private const val HASH_ALGORITHM = "SHA-256"
    private const val UNKNOWN_ERROR_CODE = "unknown_error"

    /**
     * Produces the only command-derived value permitted in an audit record.
     *
     * The NUL separator makes the domain framing unambiguous. `command` is never returned, stored,
     * or sent to an audit sink by this method.
     */
    fun commandDigest(command: String): String = MessageDigest.getInstance(HASH_ALGORITHM).run {
        update(COMMAND_DIGEST_DOMAIN.toByteArray(Charsets.UTF_8))
        update(0)
        update(command.toByteArray(Charsets.UTF_8))
        digest().toLowerHex()
    }

    fun recordOf(state: BatchRunState): BatchAuditRecord {
        val commandBytes = state.plan.command.toByteArray(Charsets.UTF_8)
        return BatchAuditRecord(
            commandDigest = commandDigest(state.plan.command),
            commandUtf8ByteLength = commandBytes.size,
            targetCount = state.targets.size,
            results = state.targets.map { row ->
                BatchTargetAudit(
                    status = row.status,
                    exitCode = row.exitCode,
                    errorCode = row.error?.code?.let(::stableErrorCode),
                )
            },
        )
    }

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

    private fun stableErrorCode(code: String): String = when (code) {
        BatchScheduler.CODE_CAPABILITY_DENIED,
        BatchScheduler.CODE_TIMED_OUT,
        UnavailableRemotePorts.CODE_ENGINE_UNAVAILABLE,
        in ErrorRegistry.byCode -> code
        else -> UNKNOWN_ERROR_CODE
    }

    private fun ByteArray.toLowerHex(): String = buildString(size * 2) {
        for (byte in this@toLowerHex) {
            val value = byte.toInt() and 0xff
            append(HEX[value ushr 4])
            append(HEX[value and 0x0f])
        }
    }

    private val HEX = "0123456789abcdef".toCharArray()
}
