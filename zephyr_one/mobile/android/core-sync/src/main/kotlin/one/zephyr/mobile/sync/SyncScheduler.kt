package one.zephyr.mobile.sync

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.ListenableWorker
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequest
import androidx.work.WorkManager
import androidx.work.workDataOf
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import one.zephyr.mobile.contracts.SyncContract
import one.zephyr.mobile.model.NetworkPolicy

/**
 * Schedules sync rounds.
 *
 * Two mechanisms exist because one cannot cover the frozen interval range on Android. The user may
 * pick 30s-24h (SYNC_STATE_MACHINE.md 9), but a periodic WorkManager job cannot fire faster than
 * 15 minutes. Pretending otherwise would silently lie to the user, so instead:
 *
 *  - anything at or above [SyncContract.PERIODIC_WORK_MIN_INTERVAL_SEC] becomes a real periodic job;
 *  - anything below it is honoured only while the app is in the foreground, by
 *    [SyncEngine]'s ticker, and the background job still runs at the 15-minute floor.
 *
 * [effectivePeriodicIntervalSec] and [isForegroundOnly] exist so the 文件同步 card can show the
 * difference between the target interval and what the system will actually deliver, which
 * PRODUCT_REQUIREMENTS.md 12 requires rather than a single optimistic number.
 */
class SyncScheduler(
    private val context: Context,
    private val workerClass: Class<out ListenableWorker>,
    val bindingKey: String,
    val generation: String,
) {

    private val workManager: WorkManager get() = WorkManager.getInstance(context)

    private val scopeId: String = scopeId(bindingKey, generation)

    private val workerInput = workDataOf(
        INPUT_BINDING_KEY to bindingKey,
        INPUT_BINDING_GENERATION to generation,
    )

    val workTag: String = TAG_SYNC + "-" + scopeId

    fun schedulePeriodic(intervalSec: Int, policy: NetworkPolicy) {
        val effective = effectivePeriodicIntervalSec(intervalSec)
        val request = PeriodicWorkRequest.Builder(
            workerClass,
            effective.toLong(),
            TimeUnit.SECONDS,
        )
            .setConstraints(constraintsFor(policy))
            .setBackoffCriteria(
                BackoffPolicy.EXPONENTIAL,
                SyncContract.retryBackoffMs.first(),
                TimeUnit.MILLISECONDS,
            )
            .setInputData(workerInput)
            .addTag(TAG_SYNC)
            .addTag(workTag)
            .build()

        // UPDATE rather than REPLACE: replacing would reset the period and drop the pending run
        // every time the user reopened the settings screen.
        workManager.enqueueUniquePeriodicWork(
            scopedName(PERIODIC_WORK_NAME),
            ExistingPeriodicWorkPolicy.UPDATE,
            request,
        )
    }

    /**
     * Background nudge for triggers that arrive while the process may be killed.
     *
     * KEEP, not REPLACE: the actor already coalesces to "current round plus at most one trailing
     * round", so replacing an enqueued request would cancel work that is about to satisfy this
     * exact trigger.
     */
    fun requestBackgroundRound(policy: NetworkPolicy, expedited: Boolean = false) {
        val builder = OneTimeWorkRequest.Builder(workerClass)
            .setConstraints(constraintsFor(policy))
            .setInputData(workerInput)
            .addTag(TAG_SYNC)
            .addTag(workTag)
        if (expedited) builder.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
        workManager.enqueueUniqueWork(scopedName(ONE_SHOT_WORK_NAME), ExistingWorkPolicy.KEEP, builder.build())
    }

    /**
     * Recovery lane for a push result that requires bootstrap.
     *
     * This deliberately has its own unique name. If the current worker is the normal one-shot,
     * enqueuing that same KEEP name would be ignored while it is still RUNNING and the durable
     * bootstrap transition could remain parked until the next interval.
     */
    fun requestBootstrapRound(policy: NetworkPolicy) {
        val request = OneTimeWorkRequest.Builder(workerClass)
            .setConstraints(constraintsFor(policy))
            .setInputData(workerInput)
            .addTag(TAG_SYNC)
            .addTag(workTag)
            .build()
        workManager.enqueueUniqueWork(
            scopedName(BOOTSTRAP_WORK_NAME),
            ExistingWorkPolicy.KEEP,
            request,
        )
    }

    /**
     * Retry after a failed round.
     *
     * REPLACE is correct here and only here: this is a *scheduled* retry, not a live round, and the
     * newest failure carries the newest backoff, including a server Retry-After.
     */
    fun scheduleRetry(delayMs: Long, policy: NetworkPolicy) {
        val request = OneTimeWorkRequest.Builder(workerClass)
            .setInitialDelay(delayMs.coerceAtLeast(0L), TimeUnit.MILLISECONDS)
            .setConstraints(constraintsFor(policy))
            .setInputData(workerInput)
            .addTag(TAG_SYNC)
            .addTag(workTag)
            .build()
        workManager.enqueueUniqueWork(scopedName(RETRY_WORK_NAME), ExistingWorkPolicy.REPLACE, request)
    }

    /** Called on unbind, revoke and fatal incompatibility: no further automatic rounds. */
    fun cancelAll() {
        cancellationOperations().forEach { /* Requesting cancellation is sufficient for UI toggles. */ }
    }

    /**
     * Account replacement needs a stronger guarantee than a settings toggle: wait until WorkManager
     * has accepted every cancellation before the old graph and its credentials are wiped.
     */
    suspend fun cancelAllAndAwait() {
        val operations = cancellationOperations()
        withContext(Dispatchers.IO) {
            operations.forEach { it.result.get() }
        }
    }

    private fun cancellationOperations(): List<androidx.work.Operation> = listOf(
        workManager.cancelUniqueWork(scopedName(PERIODIC_WORK_NAME)),
        workManager.cancelUniqueWork(scopedName(ONE_SHOT_WORK_NAME)),
        workManager.cancelUniqueWork(scopedName(BOOTSTRAP_WORK_NAME)),
        workManager.cancelUniqueWork(scopedName(RETRY_WORK_NAME)),
        /* Upgrade cleanup for requests created before work became binding-scoped. There is only one
         * active account, so these legacy global names can never belong to another live graph. */
        workManager.cancelUniqueWork(PERIODIC_WORK_NAME),
        workManager.cancelUniqueWork(ONE_SHOT_WORK_NAME),
        workManager.cancelUniqueWork(BOOTSTRAP_WORK_NAME),
        workManager.cancelUniqueWork(RETRY_WORK_NAME),
    )

    private fun scopedName(base: String): String = base + "-" + scopeId

    /**
     * wifiOnly maps to UNMETERED rather than to a wifi transport check, so a metered hotspot is
     * treated as metered even though it is technically wifi.
     */
    private fun constraintsFor(policy: NetworkPolicy): Constraints = Constraints.Builder()
        .setRequiredNetworkType(
            if (policy == NetworkPolicy.WIFI_ONLY) NetworkType.UNMETERED else NetworkType.CONNECTED,
        )
        .build()

    companion object {
        const val PERIODIC_WORK_NAME = "zephyr-one-sync-periodic"
        const val ONE_SHOT_WORK_NAME = "zephyr-one-sync-oneshot"
        const val BOOTSTRAP_WORK_NAME = "zephyr-one-sync-bootstrap"
        const val RETRY_WORK_NAME = "zephyr-one-sync-retry"
        const val TAG_SYNC = "zephyr-one-sync"
        const val INPUT_BINDING_KEY = "zephyr-one-binding-key"
        const val INPUT_BINDING_GENERATION = "zephyr-one-binding-generation"

        /** Stable across process recreation, opaque in WorkManager diagnostics and filesystem-safe. */
        fun scopeId(bindingKey: String, generation: String): String {
            val bytes = MessageDigest.getInstance("SHA-256")
                .digest((bindingKey + "\u0000" + generation).toByteArray(Charsets.UTF_8))
            return bytes.take(12).joinToString("") { "%02x".format(it) }
        }

        fun effectivePeriodicIntervalSec(targetSec: Int): Int =
            SyncContract.clampIntervalSec(targetSec)
                .coerceAtLeast(SyncContract.PERIODIC_WORK_MIN_INTERVAL_SEC)

        /** True when the user's target is faster than the platform can deliver in the background. */
        fun isForegroundOnly(targetSec: Int): Boolean =
            SyncContract.clampIntervalSec(targetSec) < SyncContract.PERIODIC_WORK_MIN_INTERVAL_SEC
    }
}
