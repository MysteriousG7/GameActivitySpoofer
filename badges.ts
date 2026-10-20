// SPDX-License-Identifier: GPL-3.0-or-later
// Read-only badge data. Never derive Discord credit from the local session timer.

export const GAME_BADGES = [
    { id: 20, name: "Game Time" },
    { id: 21, name: "Game Variety" }
] as const;

export interface BadgeProgress {
    tier: string;
    nextTier?: string;
    helperText?: string;
    percent?: number;
    maxed: boolean;
}
export interface BadgeEntry {
    id: number;
    name: string;
    data?: BadgeProgress;
    updatedAt?: number;
    error?: string;
}
export interface BadgeSnapshot {
    userId?: string;
    entries: BadgeEntry[];
    loading: boolean;
    lastAttemptAt?: number;
    nextRequestAt: number;
    automaticRefreshPaused: boolean;
}
interface BadgeHost {
    getAccountId(): string | undefined;
    get(url: string): Promise<{ body: unknown; }>;
    now(): number;
    changed(): void;
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim().slice(0, 1000) : undefined;
}
function count(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function parseBadgeProgress(body: unknown, badgeId: number): BadgeProgress {
    const badge = record(body);
    if (!badge || Number(badge.badge_id) !== badgeId || !Array.isArray(badge.tiers))
        throw new Error("Discord returned an unexpected badge response.");
    const tiers = badge.tiers.map(record).filter((tier): tier is Record<string, unknown> => !!tier);
    const findTier = (key: unknown) => key === null || key === undefined ? undefined
        : tiers.find(tier => String(tier.key) === String(key));
    const currentTier = findTier(badge.current_tier);
    const nextTier = findTier(badge.next_tier);
    const label = (tier: Record<string, unknown> | undefined) => text(tier?.name)
        ?? (typeof tier?.key === "string" || typeof tier?.key === "number" ? `Tier ${tier.key}` : undefined);
    const progress = Array.isArray(badge.progress) ? record(badge.progress[0]) : undefined;
    const requirement = Array.isArray(nextTier?.requirements) ? record(nextTier.requirements[0]) : undefined;
    const current = count(progress?.current);
    const floor = count(progress?.floor) ?? 0;
    const threshold = count(progress?.threshold) ?? count(requirement?.threshold);
    // Match Discord's progress bar: its range begins at the current tier's floor.
    const maxed = badge.owned === true && badge.next_tier === null && !!currentTier
        && tiers.length > 0 && currentTier === tiers[tiers.length - 1];
    const percent = maxed ? 100 : current !== undefined && threshold !== undefined && threshold > floor
        ? Math.max(0, Math.min(100, (current - floor) / (threshold - floor) * 100)) : undefined;
    return {
        tier: label(currentTier) ?? (badge.owned === true ? "Unlocked" : "Not earned"),
        nextTier: label(nextTier),
        helperText: text(progress?.progress_helper_text) ?? text(badge.info_label),
        percent,
        maxed
    };
}

function requestError(error: unknown): { message: string; retryMs: number; } {
    const details = record(error);
    const response = record(details?.response);
    const body = record(details?.body) ?? record(response?.body);
    const status = Number(details?.status ?? details?.statusCode ?? response?.status);
    if (status === 429) return {
        message: "Discord asked us to wait before refreshing.",
        retryMs: Math.max(60_000, Math.ceil((count(body?.retry_after) ?? 60) * 1000))
    };
    if (status === 401) return { message: "Sign in to Discord to read badge progress.", retryMs: 15_000 };
    if (status === 403 || status === 404) return {
        message: "Discord has not made this badge's progress available for this account.", retryMs: 15_000
    };
    return { message: "Could not read badge progress from Discord. Try refreshing later.", retryMs: 15_000 };
}

export class BadgeProgressReader {
    private state: BadgeSnapshot = this.empty();
    private generation = 0;
    private request?: Promise<void>;

    constructor(private host: BadgeHost) { }

    get snapshot(): BadgeSnapshot { return this.state; }

    private empty(userId?: string): BadgeSnapshot {
        return { userId, entries: GAME_BADGES.map(badge => ({ ...badge })), loading: false, nextRequestAt: 0, automaticRefreshPaused: false };
    }

    reset(userId?: string) {
        this.generation++;
        this.request = undefined;
        this.state = this.empty(userId);
        this.host.changed();
    }

    refresh(manual = false): Promise<void> {
        const userId = this.host.getAccountId();
        if (!userId) {
            if (this.state.userId) this.reset();
            return Promise.resolve();
        }
        if (userId !== this.state.userId) this.reset(userId);
        if (this.request) return this.request;
        const now = this.host.now();
        if (now < this.state.nextRequestAt) return Promise.resolve();
        if (!manual && (this.state.automaticRefreshPaused
            || (this.state.lastAttemptAt !== undefined && now - this.state.lastAttemptAt < 60_000)))
            return Promise.resolve();
        const generation = this.generation;
        this.state = { ...this.state, loading: true, lastAttemptAt: now };
        this.host.changed();
        const request = Promise.allSettled(GAME_BADGES.map(async badge => {
            const response = await this.host.get(`/users/@me/badges/${badge.id}`);
            return parseBadgeProgress(response.body, badge.id);
        })).then(results => {
            if (generation !== this.generation) return;
            if (this.host.getAccountId() !== userId) { this.reset(); return; }
            const updatedAt = this.host.now();
            let retryMs = 15_000;
            let failed = false;
            const entries = results.map((result, index): BadgeEntry => {
                const badge = GAME_BADGES[index];
                if (result.status === "fulfilled") return { ...badge, data: result.value, updatedAt };
                failed = true;
                const error = requestError(result.reason);
                retryMs = Math.max(retryMs, error.retryMs);
                return { ...this.state.entries[index], error: error.message };
            });
            this.state = { ...this.state, entries, loading: false, nextRequestAt: updatedAt + retryMs, automaticRefreshPaused: failed };
            this.host.changed();
        }).finally(() => {
            if (this.request === request) this.request = undefined;
        });
        this.request = request;
        return request;
    }
}