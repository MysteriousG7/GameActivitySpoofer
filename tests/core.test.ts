import assert from "node:assert/strict";
import test from "node:test";

import { GameChange, GameSession, GameStore, RunningGame } from "../core";

function fixture() {
    const real: RunningGame = {
        id: "555555", name: "Real game", exePath: "C:/Games/Real/game.exe", cmdLine: "",
        distributor: null, lastFocused: 0, lastLaunched: 0, nativeProcessObserverId: 12, pid: 12
    };
    const original = () => [real];
    const store: GameStore = {
        getRunningGames: original, getVisibleRunningGames: original,
        getGameForPID: pid => pid === 12 ? real : null,
        getCurrentGameForAnalytics: () => real
    };
    const deferred: (() => void)[] = [];
    const events: GameChange[] = [];
    const session = new GameSession(store, {
        now: () => 1000, defer: callback => { deferred.push(callback); },
        dispatch: event => { events.push(event); }, everySecond: () => () => {}, changed: () => {}
    });
    const start = () => session.start({
        games: [{ id: "123456", name: "Test game", executable: "test.exe" }],
        minutesPerGame: 30, stopAfterHours: 0, platform: "win32"
    });
    const flush = () => { while (deferred.length) deferred.shift()!(); };
    return { real, original, store, events, session, start, flush };
}

test("normal game-change events use a nullable unknown distributor and restore real games on stop", () => {
    const f = fixture();
    f.start(); f.flush();
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0].added[0].distributor, null);
    assert.deepEqual(f.store.getVisibleRunningGames!(), [f.real, f.events[0].added[0]]);
    f.session.stop(); f.flush();
    assert.equal(f.store.getRunningGames, f.original);
    assert.deepEqual(f.events[1].games, [f.real]);
    assert.equal(f.events[1].removed[0].id, "123456");
});

test("recording feedback follows only the selected game, including its final update", () => {
    const f = fixture();
    f.start(); f.flush();
    assert.equal(f.session.snapshot.recording, "pending");
    f.session.activityUpdate("555555", "failed");
    assert.equal(f.session.snapshot.recording, "pending");
    f.session.activityUpdate("123456", "accepted");
    assert.equal(f.session.snapshot.recording, "accepted");
    f.session.stop(); f.flush();
    f.session.activityUpdate("123456", "failed");
    assert.equal(f.session.snapshot.recording, "failed");
    f.start();
    assert.equal(f.session.snapshot.recording, "pending");
});
