// SPDX-License-Identifier: GPL-3.0-or-later
// Original implementation. No network, filesystem, or credential access here.

export type Platform = "win32" | "darwin" | "linux";
export interface CatalogGame {
    id: string;
    name: string;
    executable: string;
    coverUrl?: string;
    iconUrl?: string;
}
export interface RunningGame {
    id?: string;
    name: string;
    exePath: string;
    cmdLine: string;
    distributor: string;
    lastFocused: number;
    lastLaunched: number;
    nativeProcessObserverId: number;
    pid?: number;
    hidden?: boolean;
    isLauncher?: boolean;
    [key: string]: unknown;
}
export interface GameStore {
    getRunningGames(): RunningGame[];
    getGameForPID(pid: number): RunningGame | null | undefined;
    getCurrentGameForAnalytics(): RunningGame | null | undefined;
    getVisibleGame?(): RunningGame | null | undefined;
    getVisibleRunningGames?(): RunningGame[];
    getRunningDiscordApplicationIds?(): string[];
    getRunningVerifiedApplicationIds?(): string[];
    getGameOrTransformedSubgameForPID?(pid: number): RunningGame | null | undefined;
    isDetectionEnabled?(game: RunningGame): boolean;
}
export interface GameChange {
    type: "RUNNING_GAMES_CHANGE";
    removed: RunningGame[];
    added: RunningGame[];
    games: RunningGame[];
}
export interface SessionOptions {
    games: CatalogGame[];
    minutesPerGame: number;
    stopAfterHours: number;
    platform: Platform;
}
export interface Snapshot {
    active: boolean;
    game: string;
    index: number;
    total: number;
    elapsedMs: number;
    nextInMs: number | null;
    message: string;
}
interface Host {
    now(): number;
    // Schedule outside a Flux dispatch. Multiple changes before the callback
    // runs are coalesced, so stopping cannot publish an obsolete start event.
    defer(callback: () => void): void;
    dispatch(event: GameChange): void | Promise<unknown>;
    everySecond(callback: () => void): () => void;
    changed(): void;
}

export function parseCatalog(body: unknown, platform: Platform): CatalogGame[] {
    if (!Array.isArray(body)) throw new Error("Discord returned an unexpected game catalog format.");
    const found = new Map<string, CatalogGame>();
    for (const value of body) {
        if (!value || typeof value !== "object") continue;
        const app = value as Record<string, unknown>;
        if (typeof app.id !== "string" || !/^\d{5,22}$/.test(app.id)
            || typeof app.name !== "string" || !app.name.trim() || !Array.isArray(app.executables)) continue;
        const executable = app.executables.find((entry: unknown) => {
            if (!entry || typeof entry !== "object") return false;
            const exe = entry as Record<string, unknown>;
            return exe.os === platform && typeof exe.name === "string"
                && exe.name.length > 0 && !exe.name.includes("\0") && !exe.is_launcher && !exe.isLauncher;
        });
        if (executable) {
            // The detectable catalog uses *_hash; also accept application objects.
            const imageUrl = (...values: unknown[]): string | undefined => {
                const hash = values.find((value): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value));
                return hash ? `https://cdn.discordapp.com/app-icons/${app.id}/${hash}.png?size=256` : undefined;
            };
            found.set(app.id, {
                id: app.id, name: app.name, executable: executable.name,
                coverUrl: imageUrl(app.cover_image_hash, app.cover_image, app.coverImage),
                iconUrl: imageUrl(app.icon_hash, app.icon)
            });
        }
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function fetchCatalog(
    get: (url: string) => Promise<{ body: unknown; }>, platform: Platform
): Promise<CatalogGame[]> {
    let response: { body: unknown; };
    try {
        response = await get("/games/detectable");
    } catch (error) {
        // Only a missing route warrants trying the older catalog path.
        // Authentication failures and rate limits must not trigger retries.
        const value = error as { status?: number; statusCode?: number; response?: { status?: number; }; } | null;
        if ((value?.status ?? value?.statusCode ?? value?.response?.status) !== 404) throw error;
        response = await get("/applications/detectable");
    }
    const games = parseCatalog(response.body, platform);
    if (!games.length) throw new Error("No detectable games were returned for this operating system.");
    return games;
}

function makeGame(game: CatalogGame, platform: Platform, pid: number, now: number): RunningGame {
    // These are descriptive strings, never shell commands or files to execute.
    const name = game.name.replace(/[^a-zA-Z0-9 ._-]/g, "_").slice(0, 100) || "Game";
    const exe = game.executable.split(/[\\/]/).pop()!;
    const path = platform === "win32" ? `C:\\Games\\${name}\\${exe}`
        : platform === "darwin" ? `/Applications/${name}.app/Contents/MacOS/${exe}`
            : `/opt/games/${name}/${exe}`;
    return {
        id: game.id, name: game.name, exeName: exe, exePath: path,
        cmdLine: `"${path}"`, processName: game.name, distributor: "",
        pid, pidPath: [pid], nativeProcessObserverId: pid,
        start: now, lastFocused: now, lastLaunched: now,
        hidden: false, isLauncher: false, elevated: false, sandboxed: false
    };
}

export class GameSession {
    private current: RunningGame | undefined;
    private published: RunningGame | undefined;
    private options: SessionOptions | undefined;
    private undo: (() => void)[] = [];
    private ownedPids = new Set<number>();
    private rawGames: () => RunningGame[];
    private cancelTimer: (() => void) | undefined;
    private scheduled = false;
    private queued = 0;
    private index = 0;
    private began = 0;
    private gameBegan = 0;
    private lastTick = 0;
    private elapsed = 0;
    private nextPid = 2_000_000_000;
    private message = "Ready. Choose games, then start a session.";

    constructor(private store: GameStore, private host: Host) {
        for (const method of ["getRunningGames", "getGameForPID", "getCurrentGameForAnalytics"] as const) {
            if (typeof store?.[method] !== "function") {
                throw new Error(`Discord compatibility check failed: ${method} is unavailable. Update your client.`);
            }
        }
        this.rawGames = store.getRunningGames.bind(store);
    }

    get snapshot(): Snapshot {
        const now = this.host.now();
        return {
            active: !!this.current,
            game: this.current?.name ?? "None",
            index: this.index + 1,
            total: this.options?.games.length ?? 0,
            elapsedMs: this.current ? Math.max(0, now - this.began) : this.elapsed,
            nextInMs: this.current && this.options && this.options.games.length > 1
                ? Math.max(0, this.options.minutesPerGame * 60_000 - (now - this.gameBegan)) : null,
            message: this.message
        };
    }

    start(options: SessionOptions): void {
        if (this.current) throw new Error("Stop the current session before starting another.");
        const games = [...new Map(options.games.map(g => [g.id, g])).values()];
        if (!games.length) throw new Error("Select at least one game.");
        if (games.length > 100) throw new Error("Select at most 100 games in one queue.");
        if (!Number.isFinite(options.minutesPerGame) || options.minutesPerGame < 1 || options.minutesPerGame > 1440)
            throw new Error("Minutes per game must be between 1 and 1440.");
        if (!Number.isFinite(options.stopAfterHours) || options.stopAfterHours < 0 || options.stopAfterHours > 168)
            throw new Error("Session limit must be 0–168 hours (0 means no limit).");
        if (!games.every(g => /^\d{5,22}$/.test(g.id) && g.name && g.executable))
            throw new Error("The selected game data is incomplete. Reload the catalog.");
        this.options = { ...options, games };
        this.index = 0;
        this.began = this.gameBegan = this.lastTick = this.host.now();
        this.elapsed = 0;
        // Capture current methods afresh so other plugins' existing wrappers
        // are retained. Each installed wrapper gets its own disable switch.
        this.rawGames = this.store.getRunningGames.bind(this.store);
        try {
            this.install();
            this.selectCurrent();
            this.cancelTimer = this.host.everySecond(() => this.tick());
        } catch (error) {
            this.stop("Could not start; changes were restored.");
            throw error;
        }
    }

    next(): void {
        if (!this.current || !this.options || this.options.games.length < 2) return;
        try {
            this.index = (this.index + 1) % this.options.games.length;
            this.selectCurrent();
        } catch (error) {
            this.stop(`Session stopped: ${error instanceof Error ? error.message : "game selection failed"}`);
        }
    }

    stop(message = "Stopped. Normal game detection restored."): void {
        this.elapsed = this.current ? Math.max(0, this.host.now() - this.began) : this.elapsed;
        this.current = undefined;
        this.message = message;
        this.cancelTimer?.();
        this.cancelTimer = undefined;
        // Always remove wrappers, even if notifying Discord subsequently fails.
        for (const restore of this.undo.splice(0).reverse()) restore();
        this.queuePublish();
        this.host.changed();
    }

    private tick(): void {
        if (!this.current || !this.options) return;
        const now = this.host.now();
        const gap = now - this.lastTick;
        this.lastTick = now;
        if (gap > 90_000 || gap < 0) {
            this.stop("Stopped after sleep, suspension, or a clock change. Start again when ready.");
            return;
        }
        if (this.store.isDetectionEnabled?.(this.current) === false) {
            this.stop("Game detection was disabled. Session stopped.");
            return;
        }
        if (this.options.stopAfterHours > 0 && now - this.began >= this.options.stopAfterHours * 3_600_000) {
            this.stop("Session time limit reached. Normal game detection restored.");
            return;
        }
        if (this.options.games.length > 1 && now - this.gameBegan >= this.options.minutesPerGame * 60_000) this.next();
        this.host.changed();
    }

    private selectCurrent(): void {
        const now = this.host.now();
        const used = new Set(this.realGames().map(game => game.pid));
        while (used.has(this.nextPid) || this.ownedPids.has(this.nextPid)) this.nextPid--;
        const game = makeGame(this.options!.games[this.index], this.options!.platform, this.nextPid--, now);
        if (this.store.isDetectionEnabled?.(game) === false)
            throw new Error(`Detection is disabled for ${game.name}. Enable it in Registered Games first.`);
        this.current = game;
        this.ownedPids.add(game.pid!);
        this.gameBegan = now;
        this.message = "Simulating detected activity. Discord badge credit is unverified.";
        this.queuePublish();
        this.host.changed();
    }

    private realGames(): RunningGame[] {
        const games = this.rawGames();
        if (!Array.isArray(games)) throw new Error("Discord changed the running-game data format.");
        return games.filter(g => !this.ownedPids.has(g.pid!));
    }

    private merge(games: RunningGame[]): RunningGame[] {
        const real = games.filter(g => !this.ownedPids.has(g.pid!));
        if (!this.current || real.some(g => g.id === this.current!.id)) return real;
        return [...real, this.current];
    }

    private install(): void {
        this.patch("getRunningGames", original => (...args: unknown[]) => this.merge(original(...args)));
        this.patch("getVisibleRunningGames", original => (...args: unknown[]) => this.merge(original(...args)));
        for (const key of ["getGameForPID", "getGameOrTransformedSubgameForPID"])
            this.patch(key, original => (pid: number) => this.current?.pid === pid ? this.current : original(pid));
        for (const key of ["getVisibleGame", "getCurrentGameForAnalytics"])
            this.patch(key, original => (...args: unknown[]) => {
                if (!this.current) return original(...args);
                return this.realGames().find(g => g.id === this.current!.id) ?? this.current;
            });
        for (const key of ["getRunningDiscordApplicationIds", "getRunningVerifiedApplicationIds"])
            this.patch(key, original => (...args: unknown[]) => {
                const ids = original(...args);
                if (!this.current || !Array.isArray(ids)) return ids;
                return [...new Set([...ids, this.current.id])];
            });
    }

    private patch(key: string, wrap: (original: (...args: any[]) => any) => (...args: any[]) => any): void {
        const target = this.store as unknown as Record<string, any>;
        const original = target[key];
        if (typeof original !== "function") return;
        const descriptor = Object.getOwnPropertyDescriptor(target, key);
        let enabled = true;
        const replacement = wrap((...args) => Reflect.apply(original, target, args));
        const installed = function (this: unknown, ...args: any[]) {
            return enabled ? replacement(...args) : Reflect.apply(original, this, args);
        };
        Object.defineProperty(target, key, { configurable: true, writable: true, enumerable: descriptor?.enumerable ?? false, value: installed });
        this.undo.push(() => {
            enabled = false;
            // Do not overwrite a different plugin's later wrapper.
            if (target[key] !== installed) return;
            if (descriptor) Object.defineProperty(target, key, descriptor);
            else delete target[key];
        });
    }

    private queuePublish(): void {
        this.queued++;
        if (this.scheduled) return;
        this.scheduled = true;
        this.host.defer(() => {
            this.scheduled = false;
            const old = this.published;
            const next = this.current;
            if (old === next) return;
            const revision = this.queued;
            try {
                const games = this.merge(this.realGames());
                // Track before dispatch so an immediate error can send removal.
                this.published = next;
                const result = this.host.dispatch({
                    type: "RUNNING_GAMES_CHANGE",
                    removed: old ? [old] : [],
                    added: next && games.some(g => g.pid === next.pid) ? [next] : [], games
                });
                if (result && typeof result.then === "function")
                    void Promise.resolve(result).catch(() => this.publishFailed(revision));
            } catch {
                this.publishFailed(revision);
            }
        });
    }

    private publishFailed(revision: number): void {
        // Ignore a rejected old event after the user has changed sessions.
        if (revision !== this.queued) return;
        if (this.current) this.stop("Discord rejected the activity change. Session stopped; restart Discord if activity remains visible.");
        else {
            this.published = undefined;
            this.message = "Local changes restored, but Discord could not clear the activity. Restart Discord.";
            this.host.changed();
        }
    }
}
