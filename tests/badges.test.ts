// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";

import { BadgeProgressReader, parseBadgeProgress } from "../badges";

function badge(id = 20) {
    return {
        badge_id: id, owned: true, current_tier: "one", next_tier: "two",
        tiers: [
            { key: "one", name: "Tier one", requirements: [{ threshold: 25 }] },
            { key: "two", name: "Tier two", requirements: [{ threshold: 100 }] }
        ],
        progress: [{ current: 50, floor: 25, threshold: 100, progress_helper_text: "Server-provided progress text" }]
    };
}
function harness() {
    let now = 100_000;
    let account: string | undefined = "account-a";
    const calls: string[] = [];
    let get = async (url: string): Promise<{ body: unknown; }> => ({ body: badge(Number(url.split("/").pop())) });
    const reader = new BadgeProgressReader({
        getAccountId: () => account,
        get: url => { calls.push(url); return get(url); },
        now: () => now, changed() { }
    });
    return { reader, calls, advance: (ms: number) => { now += ms; }, account: (id?: string) => { account = id; }, get: (next: typeof get) => { get = next; } };
}

test("uses Discord's tier floor rather than lifetime totals for the percentage", () => {
    const parsed = parseBadgeProgress(badge(), 20);
    assert.ok(Math.abs(parsed.percent! - 100 / 3) < 0.001);
    assert.equal(parsed.helperText, "Server-provided progress text");
    assert.equal(parsed.nextTier, "Tier two");
});

test("missing progress is unknown rather than zero", () => {
    const response = { ...badge(), progress: [] };
    assert.equal(parseBadgeProgress(response, 20).percent, undefined);
});

test("a real zero is displayed as zero", () => {
    const response = badge();
    response.progress[0] = { ...response.progress[0], current: 0, floor: 0 };
    assert.equal(parseBadgeProgress(response, 20).percent, 0);
});

test("only an explicitly completed final tier is shown as maximum", () => {
    const response = { ...badge(), current_tier: "two", next_tier: null, progress: [] };
    assert.equal(parseBadgeProgress(response, 20).maxed, true);
    assert.equal(parseBadgeProgress(response, 20).percent, 100);
    assert.equal(parseBadgeProgress({ ...response, next_tier: undefined }, 20).maxed, false);
});

test("rejects responses for another badge and non-JSON bodies", () => {
    assert.throws(() => parseBadgeProgress(badge(21), 20));
    assert.throws(() => parseBadgeProgress("unexpected", 20));
});

test("invalid counters do not become percentages and overflows stay within the bar", () => {
    const response = badge();
    response.progress[0].current = NaN;
    assert.equal(parseBadgeProgress(response, 20).percent, undefined);
    response.progress[0].current = 500;
    assert.equal(parseBadgeProgress(response, 20).percent, 100);
    response.progress[0].current = 10;
    assert.equal(parseBadgeProgress(response, 20).percent, 0);
});

test("coalesces overlapping reads and only refreshes automatically once a minute", async () => {
    const h = harness();
    const first = h.reader.refresh();
    assert.equal(h.reader.refresh(), first);
    await first;
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.calls, ["/users/@me/badges/20", "/users/@me/badges/21"]);
    await h.reader.refresh(true);
    assert.equal(h.calls.length, 2);
    h.advance(15_000);
    await h.reader.refresh();
    assert.equal(h.calls.length, 2);
    h.advance(45_000);
    await h.reader.refresh();
    assert.equal(h.calls.length, 4);
});

test("preserves previous successful values on partial failure and pauses automatic retries", async () => {
    const h = harness();
    await h.reader.refresh();
    const previous = h.reader.snapshot.entries[1].updatedAt;
    h.advance(60_000);
    h.get(async url => {
        if (url.endsWith("21")) throw { status: 403 };
        return { body: badge(20) };
    });
    await h.reader.refresh();
    assert.equal(h.reader.snapshot.entries[0].error, undefined);
    assert.ok(h.reader.snapshot.entries[1].error);
    assert.equal(h.reader.snapshot.entries[1].updatedAt, previous);
    assert.ok(h.reader.snapshot.entries[1].data);
    h.advance(120_000);
    await h.reader.refresh();
    assert.equal(h.calls.length, 4);
});

test("honors rate-limit retry_after even for manual refresh", async () => {
    const h = harness();
    h.get(async () => { throw { status: 429, body: { retry_after: 90 } }; });
    await h.reader.refresh();
    assert.equal(h.reader.snapshot.nextRequestAt, 190_000);
    h.advance(89_000);
    await h.reader.refresh(true);
    assert.equal(h.calls.length, 2);
    h.advance(1000);
    await h.reader.refresh(true);
    assert.equal(h.calls.length, 4);
});

test("logout discards in-flight results", async () => {
    const h = harness();
    // Use one shared promise for both badge requests, then reset before it resolves.
    let finish!: (response: { body: unknown; }) => void;
    const response = new Promise<{ body: unknown; }>(done => { finish = done; });
    h.get(() => response);
    const request = h.reader.refresh();
    h.account(undefined);
    h.reader.reset();
    finish({ body: badge() });
    await request;
    assert.equal(h.reader.snapshot.userId, undefined);
    assert.ok(h.reader.snapshot.entries.every(entry => !entry.data));
});

test("late responses cannot overwrite a different account's results", async () => {
    const h = harness();
    const pending: Array<() => void> = [];
    h.get(url => new Promise(done => pending.push(() => done({ body: badge(Number(url.split("/").pop())) }))));
    const oldRequest = h.reader.refresh();
    h.account("account-b");
    h.get(async url => ({ body: badge(Number(url.split("/").pop())) }));
    await h.reader.refresh();
    assert.equal(h.reader.snapshot.userId, "account-b");
    pending.forEach(done => done());
    await oldRequest;
    assert.equal(h.reader.snapshot.userId, "account-b");
    assert.ok(h.reader.snapshot.entries.every(entry => !!entry.data && !entry.error));
});