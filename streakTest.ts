// SPDX-License-Identifier: GPL-3.0-or-later

import type { CatalogGame } from "./core";

interface TestHost {
    accountId(): string | undefined;
    get(url: string): Promise<{ body: unknown; }>;
    post(body: Record<string, unknown>): Promise<{ body: unknown; }>;
    now(): number;
    sleep(ms: number): Promise<void>;
}

export interface StreakTestResult {
    game: string;
    requested: number;
    before: (number | null)[];
    after: (number | null)[];
}

function historyStreaks(body: unknown, game: CatalogGame): (number | null)[] {
    const matches: (number | null)[] = [];
    let visited = 0;
    function walk(value: unknown, depth: number) {
        if (!value || typeof value !== "object" || depth > 16 || ++visited > 20000) return;
        const entry = value as Record<string, unknown>;
        if (Array.isArray(entry.traits)) {
            const json = JSON.stringify(entry);
            if (json.includes(game.id) || json.toLowerCase().includes(game.name.toLowerCase())) {
                const trait = entry.traits.find(t => t?.type === 8);
                matches.push(typeof trait?.streak_count_days === "number" ? trait.streak_count_days : null);
            }
        }
        for (const item of Object.values(entry)) walk(item, depth + 1);
    }
    walk(body, 0);
    return matches;
}

export async function runSharedStreakTest(game: CatalogGame, requested: number, host: TestHost): Promise<StreakTestResult> {
    if (!Number.isSafeInteger(requested) || requested < 1 || requested > 1000000)
        throw new Error("Enter a whole streak number between 1 and 1000000.");
    const account = host.accountId();
    if (!account) throw new Error("Sign in before running the test.");
    const checkAccount = () => {
        if (host.accountId() !== account) throw new Error("Account changed. Test stopped.");
    };
    const historyUrl = `/content-inventory/users/${account}/outbox`;
    const base = { application_id: game.id, distributor: null, share_activity: true };
    const extras = { streak_count_days: requested, traits: [{ type: 8, streak_count_days: requested }] };
    let token: string | undefined;
    let began = 0;
    let closed = false;
    let cleanupDelayMs = 0;
    try {
        const before = historyStreaks((await host.get(historyUrl)).body, game);
        checkAccount();
        began = host.now();
        const response = await host.post({ ...base, ...extras, duration: 0, closed: false });
        checkAccount();
        const body = response.body as { token?: unknown; } | null;
        if (typeof body?.token !== "string" || !body.token) throw new Error("Discord did not return an activity session token.");
        token = body.token;
        await host.sleep(1600);
        checkAccount();
        await host.post({ ...base, ...extras, token, duration: Math.max(0, Math.floor((host.now() - began) / 1000)), closed: true });
        closed = true;
        await host.sleep(2000);
        checkAccount();
        const after = historyStreaks((await host.get(historyUrl)).body, game);
        checkAccount();
        return { game: game.name, requested, before, after };
    } catch (error) {
        const value = error as { status?: number; statusCode?: number; body?: { retry_after?: number; }; };
        if ((value?.status ?? value?.statusCode) === 429) {
            const retry = value.body?.retry_after;
            cleanupDelayMs = Math.max(60000, typeof retry === "number" && Number.isFinite(retry) ? retry * 1000 : 0);
        }
        throw error;
    } finally {
        // Close a started test even if the request with experimental fields failed.
        // Never send an old account's session token using a different account.
        if (token && !closed && host.accountId() === account) {
            if (cleanupDelayMs) await host.sleep(cleanupDelayMs);
            if (host.accountId() === account)
                await host.post({ ...base, token, duration: Math.max(0, Math.floor((host.now() - began) / 1000)), closed: true });
        }
        token = undefined;
    }
}
