import Foundation
import ZephyrContracts

public enum SyncTrigger: String, Equatable, Sendable {
    case manual
    case interval
    case localWrite
    case foreground
    case recovery
}

/// Terminal server decisions that require destroying the complete local binding.
/// Access-credential expiry is deliberately absent: the refreshing transports can
/// recover those failures without deleting the refresh credential or local data.
public enum MobileServerRevocationReason: String, Equatable, Sendable {
    case clientRevoked = "client_revoked"
    case deviceRevoked = "device_revoked"
    case accountUnavailable = "account_unavailable"

    public init?(errorCode: String?) {
        guard let errorCode else { return nil }
        self.init(rawValue: errorCode)
    }
}

public typealias MobileServerRevocationHandler = @Sendable (MobileServerRevocationReason) async -> Void

public enum SyncRoundTermination: Equatable, Sendable {
    case completed
    case bootstrapIncomplete
    case failed
    case cancelled
    case bindingChanged
    case notRunnable
}

public enum SyncBootstrapOutcome: Equatable, Sendable {
    case complete
    case incomplete(SyncBootstrapCheckpoint)
}

public struct SyncRoundResult: Equatable, Sendable {
    public let trigger: SyncTrigger
    public let startedAtMilliseconds: Int64
    public let finishedAtMilliseconds: Int64
    public let phasesRun: [SyncPhase]
    public let endState: BindingState
    public let pushed: Int
    public let conflicts: Int
    public let applied: Int
    public let skipped: Int
    public let appliedCursor: Int64
    public let acknowledgedCursor: Int64
    public let termination: SyncRoundTermination
    public let bootstrapOutcome: SyncBootstrapOutcome?
    public let error: MobileApiError?

    public init(
        trigger: SyncTrigger,
        startedAtMilliseconds: Int64,
        finishedAtMilliseconds: Int64,
        phasesRun: [SyncPhase],
        endState: BindingState,
        pushed: Int,
        conflicts: Int,
        applied: Int,
        skipped: Int,
        appliedCursor: Int64,
        acknowledgedCursor: Int64,
        termination: SyncRoundTermination,
        bootstrapOutcome: SyncBootstrapOutcome? = nil,
        error: MobileApiError? = nil
    ) {
        self.trigger = trigger
        self.startedAtMilliseconds = startedAtMilliseconds
        self.finishedAtMilliseconds = finishedAtMilliseconds
        self.phasesRun = phasesRun
        self.endState = endState
        self.pushed = pushed
        self.conflicts = conflicts
        self.applied = applied
        self.skipped = skipped
        self.appliedCursor = appliedCursor
        self.acknowledgedCursor = acknowledgedCursor
        self.termination = termination
        self.bootstrapOutcome = bootstrapOutcome
        self.error = error
    }
}

/// A single-flight sync state machine for exactly one persisted binding.
///
/// Actor reentrancy is treated as hostile: every network request is bracketed by an exact
/// account/device/generation/binding-record-version check, and every repository mutation repeats
/// that check atomically. Overlapping requests collapse into the in-flight round plus at most one
/// trailing round.
public actor SyncEngine {
    public typealias JitterSource = @Sendable () -> Double
    public typealias IdentifierSource = @Sendable () -> String

    public nonisolated let identity: SyncBindingIdentity

    private let transport: any SyncTransport
    private let repository: any SyncRepository
    private let clock: any SyncClock
    private let jitter: JitterSource
    private let batchId: IdentifierSource
    private let stagingGeneration: IdentifierSource
    private let bootstrapPageSize: Int?
    private let changePageSize: Int?
    private let maxPagesPerRound: Int
    private let serverRevocationHandler: MobileServerRevocationHandler

    private var activeTask: Task<[SyncRoundResult], Never>?
    private var activeRunId: String?
    private var activeIdentity: SyncBindingIdentity?
    private var rerunRequested = false
    private var rerunTrigger: SyncTrigger?
    private var bootstrapContinuationPending = false
    private var invalidated = false

    public private(set) var phase: SyncPhase?

    init(
        identity: SyncBindingIdentity,
        transport: any SyncTransport,
        repository: any SyncRepository,
        clock: any SyncClock = SystemSyncClock(),
        jitter: @escaping JitterSource = { Double.random(in: 0.5...1.5) },
        batchId: @escaping IdentifierSource = { UUID().uuidString },
        stagingGeneration: @escaping IdentifierSource = { UUID().uuidString },
        bootstrapPageSize: Int? = nil,
        changePageSize: Int? = nil,
        maxPagesPerRound: Int = 512,
        serverRevocationHandler: @escaping MobileServerRevocationHandler = { _ in }
    ) {
        self.identity = identity
        self.transport = transport
        self.repository = repository
        self.clock = clock
        self.jitter = jitter
        self.batchId = batchId
        self.stagingGeneration = stagingGeneration
        self.bootstrapPageSize = bootstrapPageSize
        self.changePageSize = changePageSize
        self.maxPagesPerRound = max(1, maxPagesPerRound)
        self.serverRevocationHandler = serverRevocationHandler
    }

    /// An overlapping request is absorbed immediately and asks the owner invocation for one rerun.
    /// The empty result distinguishes an absorbed trigger from a round this call executed.
    public func request(_ trigger: SyncTrigger) async -> [SyncRoundResult] {
        guard !invalidated else { return [] }
        if activeTask != nil {
            rerunRequested = true
            if rerunTrigger == nil { rerunTrigger = trigger }
            return []
        }

        rerunRequested = false
        rerunTrigger = nil
        bootstrapContinuationPending = false

        let runId = UUID().uuidString
        let task = Task { await self.runInvocation(initialTrigger: trigger, runId: runId) }
        activeRunId = runId
        activeTask = task
        return await task.value
    }

    public func rerunPending() -> Bool {
        rerunRequested || bootstrapContinuationPending
    }

    /// Stops an in-flight binding before its transport can commit a response after unbind.
    public func cancelForUnbind(_ identity: SyncBindingIdentity? = nil) {
        cancelActiveBinding(identity)
    }

    /// Stops an in-flight binding before its transport can commit a response after revocation.
    public func cancelForRevocation(_ identity: SyncBindingIdentity? = nil) {
        cancelActiveBinding(identity)
    }

    private func cancelActiveBinding(_ identity: SyncBindingIdentity?) {
        if let identity, let activeIdentity, identity != activeIdentity { return }
        invalidated = true
        rerunRequested = false
        rerunTrigger = nil
        bootstrapContinuationPending = false
        activeTask?.cancel()
    }

    private func runInvocation(initialTrigger: SyncTrigger, runId: String) async -> [SyncRoundResult] {
        defer {
            phase = nil
            activeIdentity = nil
            if activeRunId == runId {
                activeTask = nil
                activeRunId = nil
            }
        }

        var results: [SyncRoundResult] = []
        var nextTrigger: SyncTrigger? = initialTrigger

        while let trigger = nextTrigger {
            let result = await runRound(trigger)
            results.append(result)

            if let reason = MobileServerRevocationReason(errorCode: result.error?.code) {
                invalidated = true
                rerunRequested = false
                rerunTrigger = nil
                bootstrapContinuationPending = false
                await serverRevocationHandler(reason)
                break
            }

            if result.termination == .bootstrapIncomplete {
                bootstrapContinuationPending = true
            }
            if result.error?.requiresBootstrapRestart == true {
                rerunRequested = true
                if rerunTrigger == nil { rerunTrigger = .recovery }
            }

            guard !Task.isCancelled, rerunRequested, results.count < 2 else { break }
            rerunRequested = false
            bootstrapContinuationPending = false
            nextTrigger = rerunTrigger ?? .localWrite
            rerunTrigger = nil
        }

        return results
    }

    private func runRound(_ trigger: SyncTrigger) async -> SyncRoundResult {
        let startedAt = clock.nowMilliseconds()
        guard let opening = try? await repository.runnableSnapshot(for: identity) else {
            return emptyResult(trigger, startedAt, state: .unbound, termination: .notRunnable)
        }
        guard opening.canRunSync else {
            return result(
                trigger: trigger,
                startedAt: startedAt,
                phases: [],
                state: opening.bindingState,
                accumulator: RoundAccumulator(),
                cursor: opening.appliedCursor,
                acknowledged: opening.acknowledgedCursor,
                termination: .notRunnable
            )
        }

        activeIdentity = identity
        var state = opening.bindingState
        var phases: [SyncPhase] = []
        var accumulator = RoundAccumulator()

        do {
            try Task.checkCancellation()
            try await repository.recordAttempt(at: startedAt, for: identity)

            if !Self.needsBootstrap(state) && state != .catchingUp {
                state = .running
                try await repository.saveBindingState(state, for: identity)
            }

            try enter(.validateBinding, phases: &phases)
            try await validateBinding(identity)

            if Self.needsBootstrap(state) {
                state = .bootstrapping
                try await repository.saveBindingState(state, for: identity)

                let checkpoint = try await currentSnapshot(identity).bootstrapCheckpoint
                let resumable = checkpoint.flatMap {
                    $0.isExpired(at: clock.nowMilliseconds()) ? nil : $0
                }
                if checkpoint != nil && resumable == nil {
                    try await repository.resetBootstrap(for: identity)
                }

                try enter(resumable == nil ? .bootstrapPage : .recoverBootstrap, phases: &phases)
                let bootstrap = try await runBootstrap(resume: resumable, identity: identity)
                accumulator.applied += bootstrap.entitiesStaged

                switch bootstrap.outcome {
                case .incomplete(let continuation):
                    try await repository.saveBindingState(.bootstrapping, for: identity)
                    let closing = try await currentSnapshot(identity)
                    return result(
                        trigger: trigger,
                        startedAt: startedAt,
                        phases: phases,
                        state: .bootstrapping,
                        accumulator: accumulator,
                        cursor: closing.appliedCursor,
                        acknowledged: closing.acknowledgedCursor,
                        termination: .bootstrapIncomplete,
                        bootstrapOutcome: .incomplete(continuation)
                    )
                case .complete:
                    state = .catchingUp
                    try await repository.saveBindingState(state, for: identity)
                    accumulator.bootstrapOutcome = .complete
                }
            }

            if state == .catchingUp {
                try enter(.catchUpPull, phases: &phases)
                try await pullChanges(identity, accumulator: &accumulator)
            }

            try enter(.pushPending, phases: &phases)
            try await pushPending(identity, accumulator: &accumulator)

            try enter(.pullChanges, phases: &phases)
            try await pullChanges(identity, accumulator: &accumulator)

            // Blob bodies have a separate transport; metadata sync still records the frozen phase.
            try enter(.applyBlobs, phases: &phases)

            try enter(.ackCursor, phases: &phases)
            try await acknowledge(identity)

            try enter(.commitSuccess, phases: &phases)
            state = accumulator.conflicts > 0 ? .conflicted : .idle
            try await repository.saveBindingState(state, for: identity)
            let finishedAt = clock.nowMilliseconds()
            try await repository.recordSuccess(at: finishedAt, for: identity)
            let closing = try await currentSnapshot(identity)

            return SyncRoundResult(
                trigger: trigger,
                startedAtMilliseconds: startedAt,
                finishedAtMilliseconds: finishedAt,
                phasesRun: phases,
                endState: state,
                pushed: accumulator.pushed,
                conflicts: accumulator.conflicts,
                applied: accumulator.applied,
                skipped: accumulator.skipped,
                appliedCursor: closing.appliedCursor,
                acknowledgedCursor: closing.acknowledgedCursor,
                termination: .completed,
                bootstrapOutcome: accumulator.bootstrapOutcome,
                error: nil
            )
        } catch is CancellationError {
            return result(
                trigger: trigger,
                startedAt: startedAt,
                phases: phases,
                state: state,
                accumulator: accumulator,
                cursor: opening.appliedCursor,
                acknowledged: opening.acknowledgedCursor,
                termination: .cancelled
            )
        } catch EngineAbort.bindingChanged {
            return result(
                trigger: trigger,
                startedAt: startedAt,
                phases: phases,
                state: state,
                accumulator: accumulator,
                cursor: opening.appliedCursor,
                acknowledged: opening.acknowledgedCursor,
                termination: .bindingChanged
            )
        } catch EngineAbort.bindingEnded(let endedState) {
            return result(
                trigger: trigger,
                startedAt: startedAt,
                phases: phases,
                state: endedState,
                accumulator: accumulator,
                cursor: opening.appliedCursor,
                acknowledged: opening.acknowledgedCursor,
                termination: .notRunnable
            )
        } catch {
            let apiError = Self.apiError(error)
            return await failedResult(
                trigger: trigger,
                startedAt: startedAt,
                opening: opening,
                currentState: state,
                phases: phases,
                accumulator: accumulator,
                error: apiError
            )
        }
    }

    private func validateBinding(_ identity: SyncBindingIdentity) async throws {
        _ = try await currentSnapshot(identity)
        let capabilities = try await transport.capabilities()
        _ = try await currentSnapshot(identity)
        guard capabilities.supports(protocolVersion: SyncContract.protocolVersion) else {
            throw MobileApiError.local(
                code: "unsupported_protocol_version",
                message: "The server does not support this mobile protocol version"
            )
        }
        try await repository.saveRegistryHash(capabilities.registryHash, for: identity)
    }

    private func runBootstrap(
        resume: SyncBootstrapCheckpoint?,
        identity: SyncBindingIdentity
    ) async throws -> BootstrapRun {
        do {
            return try await downloadBootstrap(resume: resume, identity: identity)
        } catch let error as MobileApiError
            where error.code == "bootstrap_expired" && resume != nil {
            try await repository.resetBootstrap(for: identity)
            return try await downloadBootstrap(resume: nil, identity: identity)
        }
    }

    private func downloadBootstrap(
        resume: SyncBootstrapCheckpoint?,
        identity: SyncBindingIdentity
    ) async throws -> BootstrapRun {
        let generation = resume?.stagingGeneration ?? stagingGeneration()
        var token = resume?.nextPageToken
        var bootstrapId = resume?.bootstrapId
        var snapshotCursor = resume?.snapshotCursor
        var pagesFetched = resume?.pagesFetched ?? 0
        var entitiesStaged = resume?.entitiesStaged ?? 0
        var tokensSeen = Set<String>()

        if resume == nil {
            try await repository.resetBootstrap(for: identity)
        }

        for _ in 0..<maxPagesPerRound {
            try Task.checkCancellation()
            if let token, !tokensSeen.insert(token).inserted {
                throw Self.invalidBootstrap("Bootstrap page token repeated")
            }

            let requestedToken = token
            _ = try await currentSnapshot(identity)
            let page = try await transport.bootstrap(pageToken: requestedToken, limit: bootstrapPageSize)
            _ = try await currentSnapshot(identity)

            if pagesFetched == 0 {
                bootstrapId = page.bootstrapId
                snapshotCursor = page.snapshotCursor
            } else if page.bootstrapId != bootstrapId || page.snapshotCursor != snapshotCursor {
                throw Self.invalidBootstrap("Bootstrap snapshot changed during pagination")
            }

            let nextToken = page.nextPageToken
            if !page.complete {
                guard let nextToken, nextToken != requestedToken, !tokensSeen.contains(nextToken) else {
                    throw Self.invalidBootstrap("Incomplete bootstrap page has no valid continuation")
                }
            }

            pagesFetched += 1
            let predictedTotal = entitiesStaged + page.entities.count
            let continuation = page.complete ? nil : SyncBootstrapCheckpoint(
                stagingGeneration: generation,
                bootstrapId: page.bootstrapId,
                snapshotCursor: page.snapshotCursor,
                nextPageToken: nextToken!,
                pagesFetched: pagesFetched,
                entitiesStaged: predictedTotal,
                expiresAtMilliseconds: Self.saturatingAdd(
                    clock.nowMilliseconds(),
                    Int64(SyncContract.bootstrapPageTokenTtlMinutes) * 60 * 1_000
                )
            )

            let staged = try await repository.stageBootstrapPage(
                page,
                requestedPageToken: requestedToken,
                stagingGeneration: generation,
                continuation: continuation,
                for: identity
            )
            entitiesStaged += staged

            if page.complete {
                try await repository.commitBootstrap(
                    stagingGeneration: generation,
                    snapshotCursor: page.snapshotCursor,
                    for: identity
                )
                return BootstrapRun(outcome: .complete, entitiesStaged: entitiesStaged)
            }

            token = nextToken
            if pagesFetched - (resume?.pagesFetched ?? 0) >= maxPagesPerRound {
                guard let continuation else { throw Self.invalidBootstrap("Missing continuation") }
                return BootstrapRun(outcome: .incomplete(continuation), entitiesStaged: entitiesStaged)
            }
        }

        throw Self.invalidBootstrap("Bootstrap page limit reached without a continuation")
    }

    private func pullChanges(
        _ identity: SyncBindingIdentity,
        accumulator: inout RoundAccumulator
    ) async throws {
        for _ in 0..<maxPagesPerRound {
            let before = try await currentSnapshot(identity)
            let page = try await transport.changes(cursor: before.appliedCursor, limit: changePageSize)
            _ = try await currentSnapshot(identity)

            guard page.fromCursor == before.appliedCursor, page.nextCursor >= page.fromCursor else {
                throw MobileApiError.local(
                    code: "cursor_invalid",
                    message: "The change page cursor does not match the durable cursor"
                )
            }

            let applied = try await repository.applyChangePage(
                page,
                expectedCursor: before.appliedCursor,
                for: identity
            )
            accumulator.applied += applied.applied
            accumulator.skipped += applied.skipped
            if !page.hasMore { return }
        }
    }

    private func pushPending(
        _ identity: SyncBindingIdentity,
        accumulator: inout RoundAccumulator
    ) async throws {
        let queued = try await repository.pendingOperations(
            limit: SyncContract.maxOpsPerBatch,
            for: identity
        )
        var seen = Set<String>()
        let unique = queued.filter { !$0.opId.isEmpty && seen.insert($0.opId).inserted }
        let residencyFailures = unique
            .filter { !Self.preservesSecretResidency($0) }
            .map {
                SyncPushOutcome.failed(
                    opId: $0.opId,
                    errorCode: "secret_plaintext_forbidden",
                    drop: false
                )
            }
        if !residencyFailures.isEmpty {
            try await repository.applyPushOutcomes(residencyFailures, for: identity)
        }
        let operations = unique.filter(Self.preservesSecretResidency)
        guard !operations.isEmpty else { return }

        let state = try await currentSnapshot(identity)
        let request = MobilePushRequest(
            deviceId: identity.deviceID,
            batchId: batchId(),
            baseCursor: state.appliedCursor,
            registryHash: state.registryHash ?? "",
            operations: operations
        )

        // This write precedes the network call. Unknown outcomes remain queued under the same opId.
        try await repository.markDispatched(
            opIds: operations.map(\.opId),
            batchId: request.batchId,
            at: clock.nowMilliseconds(),
            for: identity
        )

        _ = try await currentSnapshot(identity)
        let response = try await transport.push(request)
        _ = try await currentSnapshot(identity)
        guard response.batchId == request.batchId else {
            throw MobileApiError.local(
                code: "internal_error",
                message: "The push response did not match its request",
                retryable: true
            )
        }

        let outcomes = Self.pushOutcomes(operations: operations, response: response)
        try await repository.applyPushOutcomes(outcomes, for: identity)
        for outcome in outcomes {
            switch outcome {
            case .completed: accumulator.pushed += 1
            case .conflicted: accumulator.conflicts += 1
            case .failed: break
            }
        }
    }

    private func acknowledge(_ identity: SyncBindingIdentity) async throws {
        let state = try await currentSnapshot(identity)
        guard state.appliedCursor > state.acknowledgedCursor else { return }
        let response = try await transport.ack(MobileAckRequest(cursor: state.appliedCursor))
        _ = try await currentSnapshot(identity)
        if response.ok == false {
            throw MobileApiError.local(
                code: "internal_error",
                message: "The server did not acknowledge the durable cursor",
                retryable: true
            )
        }
        try await repository.saveAcknowledgedCursor(state.appliedCursor, for: identity)
    }

    private func currentSnapshot(_ identity: SyncBindingIdentity) async throws -> SyncRepositorySnapshot {
        try Task.checkCancellation()
        guard identity == self.identity,
              let current = try await repository.runnableSnapshot(for: identity) else {
            throw EngineAbort.bindingChanged
        }
        try Task.checkCancellation()
        if !current.canRunSync {
            throw EngineAbort.bindingEnded(current.bindingState)
        }
        return current
    }

    private func failedResult(
        trigger: SyncTrigger,
        startedAt: Int64,
        opening: SyncRepositorySnapshot,
        currentState: BindingState,
        phases: [SyncPhase],
        accumulator: RoundAccumulator,
        error apiError: MobileApiError
    ) async -> SyncRoundResult {
        let identity = opening.identity
        var state = Self.failureState(error: apiError, opening: opening.bindingState, current: currentState)
        let finishedAt = clock.nowMilliseconds()
        let delay = SyncRetryPolicy.delayMilliseconds(
            for: apiError,
            consecutiveFailures: opening.consecutiveFailures,
            jitter: jitter()
        )
        let nextEligible = delay.map { Self.saturatingAdd(finishedAt, $0) }

        do {
            _ = try await currentSnapshot(identity)
            if apiError.requiresBootstrapRestart {
                try await repository.resetBootstrap(for: identity)
                state = .boundNeedsBootstrap
            }
            try await repository.recordFailure(
                at: finishedAt,
                error: apiError,
                nextEligibleAtMilliseconds: nextEligible,
                for: identity
            )
            try await repository.saveBindingState(state, for: identity)
            guard let closing = try await repository.runnableSnapshot(for: identity) else {
                throw EngineAbort.bindingChanged
            }
            let cursor = closing.appliedCursor
            let acknowledged = closing.acknowledgedCursor
            return SyncRoundResult(
                trigger: trigger,
                startedAtMilliseconds: startedAt,
                finishedAtMilliseconds: finishedAt,
                phasesRun: phases,
                endState: state,
                pushed: accumulator.pushed,
                conflicts: accumulator.conflicts,
                applied: accumulator.applied,
                skipped: accumulator.skipped,
                appliedCursor: cursor,
                acknowledgedCursor: acknowledged,
                termination: .failed,
                bootstrapOutcome: accumulator.bootstrapOutcome,
                error: apiError
            )
        } catch is CancellationError {
            return result(
                trigger: trigger,
                startedAt: startedAt,
                phases: phases,
                state: state,
                accumulator: accumulator,
                cursor: opening.appliedCursor,
                acknowledged: opening.acknowledgedCursor,
                termination: .cancelled
            )
        } catch {
            return result(
                trigger: trigger,
                startedAt: startedAt,
                phases: phases,
                state: state,
                accumulator: accumulator,
                cursor: opening.appliedCursor,
                acknowledged: opening.acknowledgedCursor,
                termination: .bindingChanged,
                error: apiError
            )
        }
    }

    private func enter(_ next: SyncPhase, phases: inout [SyncPhase]) throws {
        try Task.checkCancellation()
        phase = next
        phases.append(next)
    }

    private func emptyResult(
        _ trigger: SyncTrigger,
        _ startedAt: Int64,
        state: BindingState,
        termination: SyncRoundTermination
    ) -> SyncRoundResult {
        result(
            trigger: trigger,
            startedAt: startedAt,
            phases: [],
            state: state,
            accumulator: RoundAccumulator(),
            cursor: 0,
            acknowledged: 0,
            termination: termination
        )
    }

    private func result(
        trigger: SyncTrigger,
        startedAt: Int64,
        phases: [SyncPhase],
        state: BindingState,
        accumulator: RoundAccumulator,
        cursor: Int64,
        acknowledged: Int64,
        termination: SyncRoundTermination,
        bootstrapOutcome: SyncBootstrapOutcome? = nil,
        error: MobileApiError? = nil
    ) -> SyncRoundResult {
        SyncRoundResult(
            trigger: trigger,
            startedAtMilliseconds: startedAt,
            finishedAtMilliseconds: clock.nowMilliseconds(),
            phasesRun: phases,
            endState: state,
            pushed: accumulator.pushed,
            conflicts: accumulator.conflicts,
            applied: accumulator.applied,
            skipped: accumulator.skipped,
            appliedCursor: cursor,
            acknowledgedCursor: acknowledged,
            termination: termination,
            bootstrapOutcome: bootstrapOutcome ?? accumulator.bootstrapOutcome,
            error: error
        )
    }

    private static func pushOutcomes(
        operations: [MobileSyncOperation],
        response: MobilePushResponse
    ) -> [SyncPushOutcome] {
        var byId: [String: MobilePushResult] = [:]
        for item in response.results where byId[item.opId] == nil {
            byId[item.opId] = item
        }

        return operations.map { operation in
            guard let item = byId[operation.opId] else {
                return .failed(opId: operation.opId, errorCode: "missing_push_result", drop: false)
            }
            switch item.status {
            case .accepted, .duplicate:
                return .completed(
                    opId: operation.opId,
                    entityId: item.entityId ?? operation.entityId,
                    revision: item.revision ?? operation.baseRevision,
                    duplicate: item.status == .duplicate
                )
            case .conflict:
                return .conflicted(conflict(operation: operation, result: item))
            case .rejected, .dependencyMissing:
                let code = item.error?.error.code
                    ?? (item.status == .dependencyMissing ? "dependency_missing" : "invalid_request")
                let action = ErrorRegistry.clientAction(code)
                let drop = item.status == .rejected
                    && (action == "drop_operation_and_report" || action == "upgrade_or_drop_operation")
                return .failed(opId: operation.opId, errorCode: code, drop: drop)
            }
        }
    }

    private static func conflict(
        operation: MobileSyncOperation,
        result: MobilePushResult
    ) -> SyncConflictRecord {
        let details = result.conflict ?? [:]
        let serverPayload = objectValue(details["serverPayload"])
            ?? objectValue(details["server"])
            ?? [:]
        let changed = stringArray(details["serverChangedFields"])
            ?? stringArray(details["changedFields"])
            ?? []
        let localFields = operation.fieldMask + (operation.secretEnvelopes?.keys.sorted() ?? [])
        let changedSet = Set(changed)
        let intersection = localFields.filter(changedSet.contains)
        let overlap = (intersection.isEmpty ? localFields : intersection).sorted()
        let code = result.error?.error.code

        return SyncConflictRecord(
            opId: operation.opId,
            entityType: operation.entityType,
            entityId: operation.entityId,
            localBaseRevision: operation.baseRevision,
            localFieldMask: operation.fieldMask.sorted(),
            localPayload: operation.payload,
            localSecretEnvelopes: operation.secretEnvelopes ?? [:],
            serverRevision: result.revision ?? operation.baseRevision,
            serverPayload: serverPayload,
            overlapFields: overlap,
            serverDeleted: code == "resource_not_found_or_inaccessible",
            aclRevoked: code?.hasPrefix("forbidden_") == true
        )
    }

    private static func objectValue(_ value: MobileJSONValue?) -> [String: MobileJSONValue]? {
        guard case .object(let object) = value else { return nil }
        return object
    }

    private static func stringArray(_ value: MobileJSONValue?) -> [String]? {
        guard case .array(let array) = value else { return nil }
        return array.compactMap {
            guard case .string(let string) = $0 else { return nil }
            return string
        }
    }

    private static func preservesSecretResidency(_ operation: MobileSyncOperation) -> Bool {
        guard let spec = EntityRegistry.entities.first(where: { $0.type == operation.entityType }) else {
            return true
        }
        let secretFields = Set(spec.secretFields)
        guard Set(operation.payload.keys).isDisjoint(with: secretFields) else { return false }
        guard Set(operation.fieldMask).isDisjoint(with: secretFields) else { return false }
        return Set(operation.secretEnvelopes?.keys.map { $0 } ?? []).isSubset(of: secretFields)
    }

    private static func needsBootstrap(_ state: BindingState) -> Bool {
        state == .boundNeedsBootstrap || state == .bootstrapping
    }

    private static func failureState(
        error: MobileApiError,
        opening: BindingState,
        current: BindingState
    ) -> BindingState {
        if error.requiresBootstrapRestart { return .boundNeedsBootstrap }
        if MobileServerRevocationReason(errorCode: error.code) != nil {
            return .revoked
        }
        if error.requiresRebind { return .reauthRequired }
        if error.code == "unsupported_protocol_version" || error.code == "registry_mismatch" {
            return .fatalIncompatible
        }
        if Self.needsBootstrap(opening) { return current }
        return opening == .conflicted ? .conflicted : .idle
    }

    private static func invalidBootstrap(_ message: String) -> MobileApiError {
        MobileApiError.local(code: "bootstrap_expired", message: message)
    }

    private static func apiError(_ error: Error) -> MobileApiError {
        if let error = error as? MobileApiError { return error }
        return MobileApiError.local(
            code: "network_offline",
            message: "A sync dependency was unavailable",
            retryable: true
        )
    }

    private static func saturatingAdd(_ left: Int64, _ right: Int64) -> Int64 {
        if right > 0 && left > Int64.max - right { return Int64.max }
        if right < 0 && left < Int64.min - right { return Int64.min }
        return left + right
    }

    private struct RoundAccumulator {
        var pushed = 0
        var conflicts = 0
        var applied = 0
        var skipped = 0
        var bootstrapOutcome: SyncBootstrapOutcome?
    }

    private struct BootstrapRun {
        let outcome: SyncBootstrapOutcome
        let entitiesStaged: Int
    }

    private enum EngineAbort: Error {
        case bindingChanged
        case bindingEnded(BindingState)
    }
}
