package one.zephyr.mobile.data.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.TypeConverters
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import java.io.File
import net.zetetic.database.Logger
import net.zetetic.database.NoopTarget
import net.zetetic.database.sqlcipher.SupportOpenHelperFactory

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
        SecretMutationJournalRow::class,
    ],
    version = 3,
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
    abstract fun secretMutationJournalDao(): SecretMutationJournalDao

    companion object {
        const val NAME: String = "zephyr-one.db"

        val MIGRATION_1_2: Migration = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "ALTER TABLE pending_operations " +
                        "ADD COLUMN clearedSecretFieldsJson TEXT NOT NULL DEFAULT '[]'",
                )
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS secret_mutation_journal (" +
                        "journalId TEXT NOT NULL, " +
                        "ownerUserId TEXT NOT NULL, " +
                        "bindingGeneration TEXT NOT NULL, " +
                        "operationId TEXT NOT NULL, " +
                        "secretRef TEXT NOT NULL, " +
                        "entityType TEXT NOT NULL, " +
                        "entityId TEXT NOT NULL, " +
                        "fieldName TEXT NOT NULL, " +
                        "mutation TEXT NOT NULL, " +
                        "state TEXT NOT NULL, " +
                        "retention TEXT NOT NULL, " +
                        "oldOpaqueBlob BLOB, " +
                        "newOpaqueBlob BLOB, " +
                        "createdAt INTEGER NOT NULL, " +
                        "PRIMARY KEY(journalId))",
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS " +
                        "index_secret_mutation_journal_ownerUserId_bindingGeneration_state " +
                        "ON secret_mutation_journal(ownerUserId, bindingGeneration, state)",
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS index_secret_mutation_journal_operationId " +
                        "ON secret_mutation_journal(operationId)",
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS index_secret_mutation_journal_entityType_entityId " +
                        "ON secret_mutation_journal(entityType, entityId)",
                )
            }
        }

        val MIGRATION_2_3: Migration = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS secret_mutation_journal_v3 (" +
                        "journalId TEXT NOT NULL, " +
                        "serverId TEXT NOT NULL, " +
                        "ownerUserId TEXT NOT NULL, " +
                        "deviceId TEXT NOT NULL, " +
                        "bindingGeneration TEXT NOT NULL, " +
                        "operationId TEXT NOT NULL, " +
                        "secretRef TEXT NOT NULL, " +
                        "entityType TEXT NOT NULL, " +
                        "entityId TEXT NOT NULL, " +
                        "fieldName TEXT NOT NULL, " +
                        "mutation TEXT NOT NULL, " +
                        "state TEXT NOT NULL, " +
                        "retention TEXT NOT NULL, " +
                        "oldOpaqueBlob BLOB, " +
                        "newOpaqueBlob BLOB, " +
                        "sequence INTEGER NOT NULL, " +
                        "supersededByJournalId TEXT, " +
                        "createdAt INTEGER NOT NULL, " +
                        "PRIMARY KEY(journalId))",
                )
                // v2 did not persist server/device. Recover it only from the exact account binding;
                // a missing row gets an invalid sentinel and recovery then fails closed.
                db.execSQL(
                    "INSERT INTO secret_mutation_journal_v3 (" +
                        "journalId, serverId, ownerUserId, deviceId, bindingGeneration, operationId, " +
                        "secretRef, entityType, entityId, fieldName, mutation, state, retention, " +
                        "oldOpaqueBlob, newOpaqueBlob, sequence, supersededByJournalId, createdAt) " +
                        "SELECT old.journalId, " +
                        "COALESCE((SELECT binding.serverProfileId FROM account_bindings binding " +
                        "WHERE binding.userId = old.ownerUserId LIMIT 1), '__invalid_scope__'), " +
                        "old.ownerUserId, " +
                        "COALESCE((SELECT binding.deviceId FROM account_bindings binding " +
                        "WHERE binding.userId = old.ownerUserId LIMIT 1), '__invalid_scope__'), " +
                        "old.bindingGeneration, old.operationId, old.secretRef, old.entityType, " +
                        "old.entityId, old.fieldName, old.mutation, old.state, old.retention, " +
                        "old.oldOpaqueBlob, old.newOpaqueBlob, old.rowid, NULL, old.createdAt " +
                        "FROM secret_mutation_journal old ORDER BY old.rowid",
                )
                // Make the latest migrated value permanently authoritative for each ref. A later
                // ACK may delete it, but that must never reactivate an older retained row.
                db.execSQL(
                    "UPDATE secret_mutation_journal_v3 SET supersededByJournalId = (" +
                        "SELECT newer.journalId FROM secret_mutation_journal_v3 AS newer " +
                        "WHERE newer.serverId = secret_mutation_journal_v3.serverId " +
                        "AND newer.ownerUserId = secret_mutation_journal_v3.ownerUserId " +
                        "AND newer.deviceId = secret_mutation_journal_v3.deviceId " +
                        "AND newer.bindingGeneration = secret_mutation_journal_v3.bindingGeneration " +
                        "AND newer.secretRef = secret_mutation_journal_v3.secretRef " +
                        "AND newer.sequence > secret_mutation_journal_v3.sequence " +
                        "ORDER BY newer.sequence DESC LIMIT 1) " +
                        "WHERE EXISTS (SELECT 1 FROM secret_mutation_journal_v3 AS newer " +
                        "WHERE newer.serverId = secret_mutation_journal_v3.serverId " +
                        "AND newer.ownerUserId = secret_mutation_journal_v3.ownerUserId " +
                        "AND newer.deviceId = secret_mutation_journal_v3.deviceId " +
                        "AND newer.bindingGeneration = secret_mutation_journal_v3.bindingGeneration " +
                        "AND newer.secretRef = secret_mutation_journal_v3.secretRef " +
                        "AND newer.sequence > secret_mutation_journal_v3.sequence)",
                )
                db.execSQL("DROP TABLE secret_mutation_journal")
                db.execSQL("ALTER TABLE secret_mutation_journal_v3 RENAME TO secret_mutation_journal")
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS " +
                        "index_secret_mutation_journal_serverId_ownerUserId_deviceId_bindingGeneration_state " +
                        "ON secret_mutation_journal(serverId, ownerUserId, deviceId, bindingGeneration, state)",
                )
                db.execSQL(
                    "CREATE UNIQUE INDEX IF NOT EXISTS " +
                        "index_secret_mutation_journal_serverId_ownerUserId_deviceId_bindingGeneration_sequence " +
                        "ON secret_mutation_journal(serverId, ownerUserId, deviceId, bindingGeneration, sequence)",
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS index_secret_mutation_journal_operationId " +
                        "ON secret_mutation_journal(operationId)",
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS index_secret_mutation_journal_entityType_entityId " +
                        "ON secret_mutation_journal(entityType, entityId)",
                )
            }
        }
    }
}

object DatabaseFactory {

    @Volatile
    private var sqlCipherLoaded = false

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
            .addMigrations(ZephyrDatabase.MIGRATION_1_2, ZephyrDatabase.MIGRATION_2_3)
            .setJournalMode(RoomDatabase.JournalMode.WRITE_AHEAD_LOGGING)
            .build()

    /** Builds an eagerly validated SQLCipher database for one opaque account namespace. */
    internal fun createEncrypted(context: Context, file: File, passphrase: ByteArray): ZephyrDatabase {
        loadSqlCipher()
        val factoryPassphrase = passphrase.copyOf()
        return Room.databaseBuilder(context, ZephyrDatabase::class.java, file.absolutePath)
            .openHelperFactory(SupportOpenHelperFactory(factoryPassphrase, null, true))
            .addCallback(
                object : RoomDatabase.Callback() {
                    override fun onOpen(db: SupportSQLiteDatabase) {
                        db.execSQL("PRAGMA foreign_keys = ON")
                    }
                },
            )
            .addMigrations(ZephyrDatabase.MIGRATION_1_2, ZephyrDatabase.MIGRATION_2_3)
            .setJournalMode(RoomDatabase.JournalMode.WRITE_AHEAD_LOGGING)
            .build()
    }

    @Synchronized
    private fun loadSqlCipher() {
        if (sqlCipherLoaded) return
        // Database paths are opaque, but SQLCipher logging is still disabled so native errors do
        // not grow into a second source of storage diagnostics in release builds.
        Logger.setTarget(NoopTarget())
        System.loadLibrary("sqlcipher")
        sqlCipherLoaded = true
    }
}
