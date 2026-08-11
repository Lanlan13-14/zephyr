package one.zephyr.mobile.data.db

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

@Dao
interface SecretMutationJournalDao {

    @Query("SELECT * FROM secret_mutation_journal ORDER BY createdAt, journalId")
    suspend fun all(): List<SecretMutationJournalRow>

    @Query(
        "SELECT * FROM secret_mutation_journal " +
            "WHERE serverId = :serverId AND ownerUserId = :ownerUserId AND deviceId = :deviceId " +
            "AND bindingGeneration = :bindingGeneration ORDER BY sequence",
    )
    suspend fun forScope(
        serverId: String,
        ownerUserId: String,
        deviceId: String,
        bindingGeneration: String,
    ): List<SecretMutationJournalRow>

    @Query(
        "SELECT * FROM secret_mutation_journal " +
            "WHERE serverId = :serverId AND ownerUserId = :ownerUserId AND deviceId = :deviceId " +
            "AND bindingGeneration = :bindingGeneration AND operationId = :operationId ORDER BY sequence",
    )
    suspend fun forOperation(
        serverId: String,
        ownerUserId: String,
        deviceId: String,
        bindingGeneration: String,
        operationId: String,
    ): List<SecretMutationJournalRow>

    @Query(
        "SELECT MAX(sequence) FROM secret_mutation_journal " +
            "WHERE serverId = :serverId AND ownerUserId = :ownerUserId AND deviceId = :deviceId " +
            "AND bindingGeneration = :bindingGeneration",
    )
    suspend fun maxSequence(
        serverId: String,
        ownerUserId: String,
        deviceId: String,
        bindingGeneration: String,
    ): Long?

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertAll(rows: List<SecretMutationJournalRow>)

    @Query(
        "UPDATE secret_mutation_journal SET state = :nextState " +
            "WHERE serverId = :serverId AND ownerUserId = :ownerUserId AND deviceId = :deviceId " +
            "AND bindingGeneration = :bindingGeneration AND operationId = :operationId " +
            "AND state = :expectedState",
    )
    suspend fun transitionOperation(
        serverId: String,
        ownerUserId: String,
        deviceId: String,
        bindingGeneration: String,
        operationId: String,
        expectedState: String,
        nextState: String,
    ): Int

    @Query(
        "UPDATE secret_mutation_journal SET supersededByJournalId = :supersededByJournalId " +
            "WHERE serverId = :serverId AND ownerUserId = :ownerUserId AND deviceId = :deviceId " +
            "AND bindingGeneration = :bindingGeneration AND secretRef = :secretRef " +
            "AND sequence < :sequence AND state = :committedState " +
            "AND supersededByJournalId IS NULL",
    )
    suspend fun supersedeOlderForRef(
        serverId: String,
        ownerUserId: String,
        deviceId: String,
        bindingGeneration: String,
        secretRef: String,
        sequence: Long,
        committedState: String,
        supersededByJournalId: String,
    ): Int

    @Query(
        "UPDATE secret_mutation_journal SET operationId = :targetOperationId " +
            "WHERE serverId = :serverId AND ownerUserId = :ownerUserId AND deviceId = :deviceId " +
            "AND bindingGeneration = :bindingGeneration AND operationId IN (:sourceOperationIds)",
    )
    suspend fun rebindOperations(
        serverId: String,
        ownerUserId: String,
        deviceId: String,
        bindingGeneration: String,
        sourceOperationIds: List<String>,
        targetOperationId: String,
    ): Int

    @Query(
        "DELETE FROM secret_mutation_journal " +
            "WHERE serverId = :serverId AND ownerUserId = :ownerUserId AND deviceId = :deviceId " +
            "AND bindingGeneration = :bindingGeneration AND operationId IN (:operationIds)",
    )
    suspend fun deleteOperations(
        serverId: String,
        ownerUserId: String,
        deviceId: String,
        bindingGeneration: String,
        operationIds: List<String>,
    ): Int

    @Query("DELETE FROM secret_mutation_journal WHERE journalId IN (:journalIds)")
    suspend fun deleteRows(journalIds: List<String>): Int
}
