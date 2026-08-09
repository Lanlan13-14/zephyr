package one.zephyr.mobile.data.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.TypeConverters
import androidx.sqlite.db.SupportSQLiteDatabase

/**
 * The One local mirror.
 *
 * Only the bound account's own data lives here. Shared-to-me resources are online-only
 * (SHARED_RESOURCE_RESIDENCY.md 3), so there is deliberately no table for them: a shared resource
 * that reached SQLite would already be a residency violation.
 *
 * Schemas are exported to core-data/schemas so every migration is reviewable in a diff rather than
 * inferred from a destructive fallback.
 */
@Database(
    entities = [
        MirrorEntityRow::class,
        DeviceLocalOverlayRow::class,
        TombstoneRow::class,
        EntitySearchRow::class,
        PendingOperationRow::class,
        BootstrapStagingRow::class,
        BootstrapProgressRow::class,
        SyncStateRow::class,
        ConflictRow::class,
        AppliedOperationRow::class,
        BlobTransferRow::class,
        ServerProfileRow::class,
        AccountBindingRow::class,
        DevicePreferenceRow::class,
        TrustedCertificateRow::class,
    ],
    version = 1,
    exportSchema = true,
)
@TypeConverters(Converters::class)
abstract class ZephyrDatabase : RoomDatabase() {

    abstract fun mirrorDao(): MirrorDao
    abstract fun overlayDao(): OverlayDao
    abstract fun tombstoneDao(): TombstoneDao
    abstract fun pendingOperationDao(): PendingOperationDao
    abstract fun bootstrapDao(): BootstrapDao
    abstract fun syncStateDao(): SyncStateDao
    abstract fun conflictDao(): ConflictDao
    abstract fun appliedOperationDao(): AppliedOperationDao
    abstract fun blobTransferDao(): BlobTransferDao
    abstract fun serverProfileDao(): ServerProfileDao
    abstract fun accountBindingDao(): AccountBindingDao
    abstract fun devicePreferenceDao(): DevicePreferenceDao
    abstract fun trustedCertificateDao(): TrustedCertificateDao

    companion object {
        const val NAME: String = "zephyr-one.db"
    }
}

object DatabaseFactory {

    /**
     * @param directory the app's no-backup directory. DEVELOPMENT.md 1030 forbids the mirror from
     *   entering a cloud or adb backup, and placing the file outside the backup set is the only
     *   way to make that structural instead of a manifest flag someone can flip.
     */
    fun create(context: Context, directory: java.io.File): ZephyrDatabase =
        Room.databaseBuilder(context, ZephyrDatabase::class.java, java.io.File(directory, ZephyrDatabase.NAME).absolutePath)
            // No fallbackToDestructiveMigration: silently dropping the mirror would also drop
            // unpushed local writes, which is data loss the user never agreed to.
            .addCallback(
                object : RoomDatabase.Callback() {
                    override fun onOpen(db: SupportSQLiteDatabase) {
                        // Foreign keys are off by default in SQLite and WAL keeps the long
                        // bootstrap transaction from blocking UI reads.
                        db.execSQL("PRAGMA foreign_keys = ON")
                    }
                },
            )
            .setJournalMode(RoomDatabase.JournalMode.WRITE_AHEAD_LOGGING)
            .build()
}
