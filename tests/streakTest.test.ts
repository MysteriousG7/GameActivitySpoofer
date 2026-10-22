import assert from "node:assert/strict";
import test from "node:test";

import { runSharedStreakTest } from "../streakTest";

const game = { id: "123456789012345678", name: "Test Game", executable: "game.exe" };
function fixture() {
    let now = 1000;
    let reads = 0;
    let account: string | undefined = "account-a";
    const requests: Record<string, unknown>[] = [];
    const history = (streak: number) => ({ entries: [{ application_id: game.id, traits: [{ type: 8, streak_count_days: streak }] }] });
    const host = {
        accountId: () => account,
        get: async (_url: string) => ({ body: history(++reads === 1 ? 4 : 5) }),
        post: async (body: Record<string, unknown>) => { requests.push(body); return { body: { token: "test-session-only" } }; },
        now: () => now,
        sleep: async (ms: number) => { now += ms; }
    };
    return { host, requests, switchAccount: () => { account = "account-b"; } };
}

test("reports the actual history even when accepted requests ignore the requested streak", async () => {
    const f = fixture();
    const result = await runSharedStreakTest(game, 99, f.host);
    assert.deepEqual(result, { game: game.name, requested: 99, before: [4], after: [5] });
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[0].duration, 0);
    assert.equal(f.requests[1].duration, 1);
    assert.equal(f.requests[1].closed, true);
    assert.equal(f.requests[1].streak_count_days, 99);
    assert.equal("token" in result, false);
});

test("closes the test with ordinary fields if the experimental closing request fails", async () => {
    const f = fixture();
    const post = f.host.post;
    f.host.post = async body => {
        const response = await post(body);
        if (f.requests.length === 2) throw new Error("Experimental fields rejected");
        return response;
    };
    await assert.rejects(runSharedStreakTest(game, 99, f.host), /Experimental fields rejected/);
    assert.equal(f.requests.length, 3);
    assert.equal(f.requests[2].closed, true);
    assert.equal(f.requests[2].token, "test-session-only");
    assert.equal("traits" in f.requests[2], false);
    assert.equal("streak_count_days" in f.requests[2], false);
});

test("never sends the previous account's activity token after switching accounts", async () => {
    const f = fixture();
    f.host.sleep = async () => { f.switchAccount(); };
    await assert.rejects(runSharedStreakTest(game, 99, f.host), /Account changed/);
    assert.equal(f.requests.length, 1);
});

test("waits for a rate-limit delay before attempting final session cleanup", async () => {
    const f = fixture();
    const sleeps: number[] = [];
    const sleep = f.host.sleep;
    f.host.sleep = async ms => { sleeps.push(ms); await sleep(ms); };
    const post = f.host.post;
    f.host.post = async body => {
        const response = await post(body);
        if (f.requests.length === 2) throw { status: 429, body: { retry_after: 120 } };
        return response;
    };
    await assert.rejects(runSharedStreakTest(game, 99, f.host));
    assert.deepEqual(sleeps, [1600, 120000]);
    assert.equal(f.requests.length, 3);
});

test("invalid requested streaks do not make activity requests", async () => {
    for (const value of [0, -1, 1.5, NaN, Infinity, 1000001]) {
        const f = fixture();
        await assert.rejects(runSharedStreakTest(game, value, f.host), /whole streak number/);
        assert.equal(f.requests.length, 0);
    }
});
