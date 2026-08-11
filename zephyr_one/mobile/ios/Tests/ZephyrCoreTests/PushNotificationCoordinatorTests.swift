import Foundation
import XCTest
@testable import ZephyrCore

final class PushNotificationCoordinatorTests: XCTestCase {
    func testSilentPushValidatesDeviceGenerationAndCoalescesCursor() async {
        let identity = SyncBindingIdentity(
            serverID: "server-a",
            accountID: "account-a",
            deviceID: "device-a",
            generation: "generation-a"
        )
        let state = PushSchedulerState(
            snapshot: SyncRepositorySnapshot(
                identity: identity,
                bindingState: .idle,
                appliedCursor: 4,
                acknowledgedCursor: 4
            )
        )
        let scheduler = SyncScheduler(
            identity: identity,
            wakeTransport: NoopWakeTransport(),
            snapshotProvider: { await state.currentSnapshot() },
            syncRequest: { trigger in await state.record(trigger) }
        )
        let coordinator = PushNotificationCoordinator(identity: identity, scheduler: scheduler)
        let valid: [AnyHashable: Any] = [
            "aps": ["content-available": 1],
            SilentPushWake.envelopeKey: [
                "kind": "sync-wake",
                "deviceId": identity.deviceID,
                "generation": identity.generation,
                "cursor": 5,
            ],
        ]

        let first = await coordinator.handleSilentPush(userInfo: valid)
        let duplicate = await coordinator.handleSilentPush(userInfo: valid)
        let firstTriggers = await state.recordedTriggers()
        XCTAssertEqual(.newData, first)
        XCTAssertEqual(.noData, duplicate)
        XCTAssertEqual([.recovery], firstTriggers)

        var stale = valid
        stale[SilentPushWake.envelopeKey] = [
            "kind": "sync-wake",
            "deviceId": identity.deviceID,
            "generation": "old-generation",
            "cursor": 6,
        ]
        let ignored = await coordinator.handleSilentPush(userInfo: stale)
        let finalTriggers = await state.recordedTriggers()
        XCTAssertEqual(.ignored, ignored)
        XCTAssertEqual([.recovery], finalTriggers)
    }

    func testRejectsNonSilentAndContentBearingPayloadShapes() {
        XCTAssertNil(SilentPushWake.decode(userInfo: [:]))
        XCTAssertNil(
            SilentPushWake.decode(
                userInfo: [
                    "aps": ["alert": "Sync"],
                    SilentPushWake.envelopeKey: [
                        "kind": "sync-wake",
                        "deviceId": "device-a",
                        "generation": "generation-a",
                        "cursor": 5,
                    ],
                ]
            )
        )
        XCTAssertNil(
            SilentPushWake.decode(
                userInfo: [
                    "aps": ["content-available": 1],
                    SilentPushWake.envelopeKey: [
                        "kind": "sync-wake",
                        "deviceId": "device-a",
                        "generation": "generation-a",
                        "cursor": 5,
                        "owner": "must-not-be-present",
                    ],
                ]
            )
        )
    }
}

private actor PushSchedulerState {
    private let snapshot: SyncRepositorySnapshot
    private var triggers = [SyncTrigger]()

    init(snapshot: SyncRepositorySnapshot) {
        self.snapshot = snapshot
    }

    func currentSnapshot() -> SyncRepositorySnapshot { snapshot }

    func record(_ trigger: SyncTrigger) -> Bool {
        triggers.append(trigger)
        return true
    }

    func recordedTriggers() -> [SyncTrigger] { triggers }
}

private struct NoopWakeTransport: WakeStreamTransport {
    func open(
        lastEventID: String?,
        onWake: @escaping @Sendable (WakeStreamEvent) async -> Void
    ) async -> WakeStreamOutcome {
        WakeStreamOutcome()
    }
}
