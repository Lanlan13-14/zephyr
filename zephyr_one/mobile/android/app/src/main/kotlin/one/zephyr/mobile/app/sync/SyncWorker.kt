package one.zephyr.mobile.app.sync

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import one.zephyr.mobile.app.ZephyrApplication

/**
 * The WorkManager entry point for a background sync round.
 *
 * [SyncScheduler] is constructed with this class, so every periodic, one-shot and retry request the
 * engine schedules lands here. The worker itself owns no sync logic: it resolves the account graph,
 * asks the engine for one round and translates the outcome into a WorkManager result.
 *
 * A missing account graph is [Result.success], not failure or retry. An unbound app has nothing to
 * sync, and retrying would burn the backoff budget on work that cannot become possible until the
 * user completes S02 - at which point the engine schedules a fresh round anyway.
 */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val app = applicationContext as? ZephyrApplication ?: return Result.success()
        val account = app.container.account ?: return Result.success()

        val results = account.syncEngine.runScheduledRound()

        // The last round decides: an earlier round may have failed and been retried successfully
        // inside the same request, and reporting the first failure would hide that recovery.
        val last = results.lastOrNull() ?: return Result.success()
        if (last.succeeded) return Result.success()

        val error = last.error
        /* Retry only when the error says so. WorkManager's backoff is the wrong tool for a revoked
         * token or a rotated binding: those need the user, and retrying them on a schedule would
         * hammer the server until the backoff cap while the UI shows nothing. SyncEngine has already
         * recorded the failure and scheduled its own retry where one is warranted. */
        return if (error != null && error.retryable) Result.retry() else Result.success()
    }
}
