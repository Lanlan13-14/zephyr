package one.zephyr.mobile.data.repository

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import one.zephyr.mobile.data.db.ZephyrDatabase
import one.zephyr.mobile.data.mapper.ResourceMappers
import one.zephyr.mobile.model.ActivityEvent

/**
 * Activity feed (S43).
 *
 * activityEvent has no editable fields and deleteMode "append-only", so there is deliberately no
 * write path here: an attempt to edit one is rejected by the field-mask sanitiser before it reaches
 * the database.
 */
class ActivityRepository(private val db: ZephyrDatabase) {

    fun observeRecent(userId: String): Flow<List<ActivityEvent>> =
        db.mirrorDao().observeByType(ActivityEvent.ENTITY_TYPE, userId).map { rows ->
            // sortKey already encodes descending time, so no re-sort is needed here.
            rows.map(ResourceMappers::activityEvent)
        }

    suspend fun count(userId: String): Int =
        db.mirrorDao().countByType(ActivityEvent.ENTITY_TYPE, userId)
}
