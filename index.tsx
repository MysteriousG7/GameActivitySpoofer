// SPDX-License-Identifier: GPL-3.0-or-later
// GameActivitySpoofer 0.2.2 — Vencord / Equicord user plugin.

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin from "@utils/types";
import { findComponentByCodeLazy } from "@webpack";
import { closeModal, FluxDispatcher, Modal, openModal, React, RestAPI, RunningGameStore, UserStore } from "@webpack/common";

import { BadgeProgressReader } from "./badges";
import { CatalogGame, fetchCatalog, GameSession, GameStore, Platform } from "./core";
import { runSharedStreakTest } from "./streakTest";

const settings = definePluginSettings({}).withPrivateSettings<{
    gameIds?: string[];
    minutesPerGame?: number;
    stopAfterHours?: number;
}>();

let session: GameSession | undefined;
let enabled = false;
let initError = "";
let catalog: CatalogGame[] | undefined;
let catalogRequest: Promise<CatalogGame[]> | undefined;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(fn => fn());
let streakTestBusy = false;
let streakTestNextAt = 0;
let streakTestResult = "";
let streakTestRevision = 0;
function resetStreakTest() { streakTestRevision++; streakTestResult = ""; }

async function testSharedStreak(game: CatalogGame, requested: number) {
    if (!enabled || streakTestBusy || session?.snapshot.active || Date.now() < streakTestNextAt) return;
    if (!Number.isSafeInteger(requested) || requested < 1 || requested > 1000000) {
        streakTestResult = "Enter a whole streak number between 1 and 1000000."; notify(); return;
    }
    const revision = ++streakTestRevision;
    streakTestBusy = true;
    streakTestNextAt = Date.now() + 60000;
    streakTestResult = `Testing ${game.name}…`; notify();
    try {
        const result = await runSharedStreakTest(game, requested, {
            accountId: () => UserStore.getCurrentUser()?.id,
            get: url => RestAPI.get({ url, retries: 0 }),
            post: body => RestAPI.post({ url: "/activities", body, retries: 0 }),
            now: Date.now,
            sleep: ms => new Promise(resolve => setTimeout(resolve, ms))
        });
        if (revision !== streakTestRevision) return;
        const format = (values: (number | null)[]) => values.length ? values.map(n => n ?? "no streak tag").join(", ") : "no matching entry";
        streakTestResult = `${result.game}: requested ${result.requested}. Discord history before: ${format(result.before)}; after: ${format(result.after)}. Activity requests accepted; this does not confirm that Discord honored the requested streak.`;
    } catch (error) {
        const e = error as { status?: number; statusCode?: number; body?: { retry_after?: number; }; message?: string; };
        if (Number.isFinite(e?.body?.retry_after) && e.body!.retry_after! > 0)
            streakTestNextAt = Math.max(streakTestNextAt, Date.now() + e.body!.retry_after! * 1000);
        if (revision !== streakTestRevision) return;
        const status = e?.status ?? e?.statusCode;
        streakTestResult = status ? `Test failed (HTTP ${status}).${status === 429 ? " Wait for the cooldown before retrying." : ""}` : e?.message ?? "The streak test failed.";
    } finally { streakTestBusy = false; notify(); }
}

function ExperimentalStreakTest({ game, active }: { game?: CatalogGame; active: boolean; }) {
    const [requested, setRequested] = React.useState("99");
    const [now, setNow] = React.useState(Date.now);
    React.useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
    const cooldown = Math.max(0, Math.ceil((streakTestNextAt - now) / 1000));
    return <details style={{ padding: 12, border: "1px solid var(--background-modifier-accent, #48494e)", borderRadius: 6 }}>
        <summary style={{ cursor: "pointer" }}>Experimental shared streak test</summary>
        <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
            <p>Creates a brief recorded session for the first selected game and compares Discord's history before and after. Discord ignored the requested number in our previous test.</p>
            <p>Game: {game?.name ?? "Load the catalog and select a game."}</p>
            <label style={{ display: "grid", gap: 6 }}>Requested streak (days)
                <input type="number" min={1} max={1000000} step={1} style={fieldStyle} value={requested} disabled={streakTestBusy} onChange={e => setRequested(e.currentTarget.value)} />
            </label>
            <button type="button" style={buttonStyle} disabled={!enabled || !game || active || streakTestBusy || cooldown > 0} onClick={() => game && void testSharedStreak(game, Number(requested))}>
                {streakTestBusy ? "Testing…" : cooldown > 0 ? `Retry in ${cooldown}s` : "Run shared streak test"}
            </button>
            {active && <p>Stop the running session before testing.</p>}
            {streakTestResult && <p role="status" style={{ overflowWrap: "anywhere" }}>{streakTestResult}</p>}
        </div>
    </details>;
}
const badgeReader = new BadgeProgressReader({
    getAccountId: () => enabled ? UserStore.getCurrentUser()?.id : undefined,
    get: url => RestAPI.get({ url, retries: 0 }),
    now: Date.now,
    changed: notify
});

const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');
const gameMenuKey = "vc-game-activity-spoofer-menu";

function openGameMenu() {
    if (!enabled) return;
    openModal(props => (
        <Modal {...props} title="Game Activity Spoofer" size="lg">
            <ErrorBoundary>
                <Panel />
            </ErrorBoundary>
        </Modal>
    ), { modalKey: gameMenuKey });
}

function GamepadIcon() {
    return (
        <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M7.5 6h9c2.2 0 3.4 1.5 4 3.8l1.2 6.1c.6 3-1.6 4.4-3.4 2.6L15.5 16h-7l-2.8 2.5c-1.8 1.8-4 .4-3.4-2.6l1.2-6.1C4.1 7.5 5.3 6 7.5 6Z" />
            <path d="M7.5 9v5M5 11.5h5" />
            <circle cx={16} cy={10} r={0.8} fill="currentColor" stroke="none" />
            <circle cx={18.5} cy={12.5} r={0.8} fill="currentColor" stroke="none" />
        </svg>
    );
}

function GameMenuButton() {
    const [, refresh] = React.useReducer(n => n + 1, 0);
    React.useEffect(() => { listeners.add(refresh); return () => { listeners.delete(refresh); }; }, []);
    if (!enabled) return null;
    return (
        <span style={{ display: "flex", alignItems: "center", WebkitAppRegion: "no-drag" } as React.CSSProperties}>
            <HeaderBarIcon
                tooltip="Game Activity Spoofer"
                aria-label="Open game activity menu"
                icon={GamepadIcon}
                onClick={openGameMenu}
            />
        </span>
    );
}

function platform(): Platform {
    const native = (globalThis as unknown as { DiscordNative?: { process?: { platform?: string; }; }; }).DiscordNative;
    const value = native?.process?.platform ?? navigator.platform;
    if (/darwin|mac/i.test(value)) return "darwin";
    if (/linux/i.test(value)) return "linux";
    return "win32";
}

async function loadCatalog(): Promise<CatalogGame[]> {
    if (catalog) return catalog;
    if (catalogRequest) return catalogRequest;
    catalogRequest = (async () => {
        try {
            // Read Discord's own catalog using the normal client API.
            const parsed = await fetchCatalog(url => RestAPI.get({ url, retries: 0 }), platform());
            catalog = parsed;
            return parsed;
        } finally {
            catalogRequest = undefined;
        }
    })();
    return catalogRequest;
}

function duration(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m ${seconds % 60}s`;
}

const fieldStyle: React.CSSProperties = {
    background: "var(--input-background, #1e1f22)", color: "var(--text-normal, #f2f3f5)",
    border: "1px solid var(--background-modifier-accent, #48494e)", borderRadius: 6,
    padding: "9px 11px", boxSizing: "border-box", width: "100%", font: "inherit"
};
const buttonStyle: React.CSSProperties = {
    border: "1px solid var(--background-modifier-accent, #48494e)", borderRadius: 6,
    padding: "9px 14px", background: "var(--background-secondary, #2b2d31)",
    color: "var(--text-normal, #f2f3f5)", font: "inherit", cursor: "pointer"
};

function GameArtwork({ game }: { game: CatalogGame; }) {
    const [failedUrls, setFailedUrls] = React.useState<Set<string>>(() => new Set());
    const imageUrl = [game.coverUrl, game.iconUrl].find(url => url && !failedUrls.has(url));
    return (
        <span aria-hidden="true" style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 56, height: 76, flexShrink: 0, overflow: "hidden", borderRadius: 6,
            background: "var(--background-tertiary, #1e1f22)", color: "var(--text-muted, #b5bac1)"
        }}>
            {imageUrl ? <img
                key={imageUrl}
                src={imageUrl}
                alt=""
                width={56}
                height={76}
                loading="lazy"
                decoding="async"
                referrerPolicy="no-referrer"
                style={{ display: "block", width: "100%", height: "100%", objectFit: imageUrl === game.coverUrl ? "cover" : "contain" }}
                onError={() => setFailedUrls(previous => new Set([...previous, imageUrl]))}
            /> : <GamepadIcon />}
        </span>
    );
}

function BadgeProgressPanel() {
    const [, refresh] = React.useReducer(n => n + 1, 0);
    const [now, setNow] = React.useState(Date.now);
    React.useEffect(() => {
        listeners.add(refresh);
        void badgeReader.refresh();
        const timer = setInterval(() => {
            setNow(Date.now());
            void badgeReader.refresh();
        }, 1000);
        return () => { clearInterval(timer); listeners.delete(refresh); };
    }, []);
    const snapshot = badgeReader.snapshot;
    const cooldown = Math.max(0, Math.ceil((snapshot.nextRequestAt - now) / 1000));
    return (
        <div style={{ display: "grid", gap: 10, marginTop: 12 }} aria-label="Discord badge progress">
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <strong>Badge progress</strong>
                <button type="button" style={{ ...buttonStyle, padding: "5px 9px" }}
                    disabled={!enabled || snapshot.loading || cooldown > 0}
                    onClick={() => void badgeReader.refresh(true)}>
                    {snapshot.loading ? "Refreshing…" : cooldown > 0 ? `Refresh in ${cooldown}s` : "Refresh progress"}
                </button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
                {snapshot.entries.map(entry => {
                    const data = entry.data;
                    const percent = data?.percent;
                    return (
                        <div key={entry.id} style={{ padding: 12, borderRadius: 6, background: "var(--background-tertiary, #1e1f22)", display: "grid", alignContent: "start", gap: 6 }}>
                            <strong>{entry.name}</strong>
                            {data ? <>
                                <span>{data.tier}{data.maxed ? " · Maximum tier" : data.nextTier ? ` → ${data.nextTier}` : ""}</span>
                                {percent !== undefined && <>
                                    <div role="progressbar" aria-label={`${entry.name} progress to next tier`}
                                        aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}
                                        style={{ height: 8, borderRadius: 4, overflow: "hidden", background: "var(--background-modifier-accent, #48494e)" }}>
                                        <div style={{ height: "100%", width: `${percent}%`, background: "#5865f2" }} />
                                    </div>
                                    <span>{data.maxed ? "Complete" : `${percent.toFixed(1)}% toward next tier`}</span>
                                </>}
                                {data.helperText && <p>{data.helperText}</p>}
                                {percent === undefined && !data.helperText && <p>Discord did not provide a progress counter.</p>}
                                {entry.updatedAt !== undefined && <small style={{ color: "var(--text-muted, #b5bac1)" }}>Last checked: {new Date(entry.updatedAt).toLocaleTimeString()}</small>}
                            </> : <p>{!enabled ? "Enable the plugin to load progress." : snapshot.loading ? "Loading Discord progress…" : "Progress unavailable"}</p>}
                            {entry.error && <p role="status" style={{ color: "var(--text-warning, #f0b232)" }}>
                                {data ? "Showing the last successful update. " : ""}{entry.error}
                            </p>}
                        </div>
                    );
                })}
            </div>
            <small style={{ color: "var(--text-muted, #b5bac1)" }}>
                {snapshot.automaticRefreshPaused
                    ? "Automatic refresh is paused after an error. Use Refresh progress to try again."
                    : "Read from Discord and checked once a minute while this menu is open. Discord may update counters later than the session timer."}
            </small>
        </div>
    );
}

function Panel() {
    const [, refresh] = React.useReducer(n => n + 1, 0);
    const [games, setGames] = React.useState<CatalogGame[]>(catalog ?? []);
    const [search, setSearch] = React.useState("");
    const [selected, setSelected] = React.useState<string[]>(settings.store.gameIds ?? []);
    const [minutes, setMinutes] = React.useState(String(settings.store.minutesPerGame ?? 30));
    const [hours, setHours] = React.useState(String(settings.store.stopAfterHours ?? 8));
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState("");
    React.useEffect(() => { listeners.add(refresh); return () => { listeners.delete(refresh); }; }, []);
    const state = session?.snapshot;
    const active = state?.active ?? false;
    const selectedSet = new Set(selected);
    const query = search.trim().toLowerCase();
    const matches = games.filter(g => g.name.toLowerCase().includes(query) || g.id.includes(query));
    const visible = matches.slice(0, 60);
    const missing = games.length ? selected.filter(id => !games.some(g => g.id === id)) : [];
    function toggle(id: string) {
        if (active) return;
        if (!selectedSet.has(id) && selected.length >= 100) { setError("Select at most 100 games."); return; }
        const next = selectedSet.has(id) ? selected.filter(value => value !== id) : [...selected, id];
        setSelected(next);
        settings.store.gameIds = next;
        setError("");
    }
    async function load() {
        setBusy(true); setError("");
        try { setGames(await loadCatalog()); }
        catch (err) {
            const detail = err instanceof Error ? err.message : "Discord did not return the catalog.";
            setError(`Could not load games. ${detail} Check your connection and try again.`);
        } finally { setBusy(false); }
    }
    function begin() {
        try {
            if (!enabled || !session) throw new Error(initError || "Enable the plugin first.");
            if (!minutes.trim() || !hours.trim()) throw new Error("Fill in both timing fields.");
            if (missing.length) throw new Error("Some saved games are no longer in the catalog. Clear the selection and choose again.");
            const byId = new Map(games.map(g => [g.id, g]));
            session.start({
                games: selected.map(id => byId.get(id)).filter((g): g is CatalogGame => !!g),
                minutesPerGame: Number(minutes), stopAfterHours: Number(hours), platform: platform()
            });
            settings.store.minutesPerGame = Number(minutes);
            settings.store.stopAfterHours = Number(hours);
            setError("");
        } catch (err) { setError(err instanceof Error ? err.message : "Could not start session."); }
    }
    return (
        <section style={{ color: "var(--text-normal, #f2f3f5)", display: "grid", gap: 14, fontSize: 14, lineHeight: 1.45 }}>
            <div>
                <h2 style={{ fontSize: 20, marginBottom: 6 }}>Game Activity Spoofer</h2>
                <p>Simulate a detected game, or rotate through a queue for Game Time / Game Variety experiments.</p>
                <p style={{ color: "var(--text-muted, #b5bac1)", marginTop: 6 }}>
                    Badge progress below is reported by Discord. Session time does not guarantee badge credit.
                    Your normal activity-sharing and data settings still apply.
                </p>
            </div>
            <div style={{ padding: 14, borderRadius: 8, background: "var(--background-secondary, #2b2d31)", borderLeft: `4px solid ${active ? "#43b581" : "#80848e"}` }}>
                <strong>{active ? `Active: ${state!.game}` : "Session stopped"}</strong>
                <p role="status" style={{ marginTop: 5 }}>{initError || state?.message || "Enable this plugin to start."}</p>
                {state && <p style={{ marginTop: 5 }}>Session time: {duration(state.elapsedMs)}</p>}
                {state && state.recording !== "idle" && <p role="status" style={{ marginTop: 5 }}>
                    {state.recording === "pending" ? "Activity recording: waiting for Discord…"
                        : state.recording === "accepted" ? "Activity recording: accepted by Discord. Recent Activity and badge updates may take time."
                            : "Activity recording: Discord rejected the update. Playing status may still appear, but history and badge credit are unconfirmed."}
                </p>}
                {active && state!.total > 1 && <p>Queue {state!.index}/{state!.total} · Next game in {duration(state!.nextInMs ?? 0)}</p>}
                <BadgeProgressPanel />
            </div>
            {error && <p role="alert" style={{ color: "var(--text-danger, #fa777c)" }}>{error}</p>}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <button style={buttonStyle} disabled={busy || active} onClick={() => void load()}>{busy ? "Loading…" : games.length ? "Catalog loaded" : "Load game catalog"}</button>
                <button style={buttonStyle} disabled={active || !selected.length} onClick={() => { setSelected([]); settings.store.gameIds = []; setError(""); }}>Clear selection</button>
            </div>
            <label style={{ display: "grid", gap: 6 }}>Find a game
                <input type="search" value={search} style={fieldStyle} placeholder="Search by game name" disabled={!games.length} onChange={e => setSearch(e.currentTarget.value)} />
            </label>
            {!!games.length && <>
                <p>{selected.length} selected · Showing {visible.length} of {matches.length} matches. Games rotate in selection order.</p>
                <div style={{ maxHeight: 360, overflowY: "auto", border: "1px solid var(--background-modifier-accent, #48494e)", borderRadius: 6 }}>
                    {visible.map(game => <label key={game.id} style={{ display: "flex", gap: 10, padding: "8px 10px", alignItems: "center", cursor: active ? "default" : "pointer" }}>
                        <input type="checkbox" checked={selectedSet.has(game.id)} disabled={active} onChange={() => toggle(game.id)} />
                        <GameArtwork game={game} />
                        <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{game.name}</span>
                    </label>)}
                    {!visible.length && <p style={{ padding: 10 }}>No matching games for this operating system.</p>}
                </div>
                {!!selected.length && <p style={{ color: "var(--text-muted, #b5bac1)", overflowWrap: "anywhere" }}>Queue: {selected.map(id => games.find(g => g.id === id)?.name ?? `Unavailable (${id})`).join(" → ")}</p>}
            </>}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
                <label style={{ display: "grid", gap: 6 }}>Minutes per game
                    <input type="number" min={1} max={1440} step={1} style={fieldStyle} value={minutes} disabled={active} onChange={e => setMinutes(e.currentTarget.value)} />
                </label>
                <label style={{ display: "grid", gap: 6 }}>Stop after hours (0 = unlimited)
                    <input type="number" min={0} max={168} step={0.5} style={fieldStyle} value={hours} disabled={active} onChange={e => setHours(e.currentTarget.value)} />
                </label>
            </div>
            <p style={{ color: "var(--text-muted, #b5bac1)" }}>The default 30 minutes is a rotation setting, not a verified badge requirement. One selected game stays active until stopped.</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <button style={{ ...buttonStyle, background: "#5865f2", color: "white" }} disabled={!enabled || !session || active || streakTestBusy || !games.length || !selected.length} onClick={begin}>Start session</button>
                <button style={buttonStyle} disabled={!active || (state?.total ?? 0) < 2} onClick={() => session?.next()}>Next game</button>
                <button style={buttonStyle} disabled={!active} onClick={() => session?.stop()}>Stop session</button>
            </div>
            <ExperimentalStreakTest game={games.find(game => game.id === selected[0])} active={active} />
            <p style={{ color: "var(--text-muted, #b5bac1)" }}>Stops on logout, disconnect, plugin disable, or a long sleep/suspension. Starting again is always manual. Check your actual badge counters in your Discord profile.</p>
        </section>
    );
}

export default definePlugin({
    name: "GameActivitySpoofer",
    description: "Simulate detected game activity with a selectable queue and view Discord-reported Game Time / Game Variety badge progress.",
    authors: [{ name: "Plugin author", id: 450897104626384907n }],
    settings,
    settingsAboutComponent: Panel,
    patches: [{
        find: '?"BACK_FORWARD_NAVIGATION":',
        replacement: {
            match: /(trailing:.{0,200}?children:\[)/,
            replace: "$1$self.renderToolbarButton(),"
        }
    }],
    renderToolbarButton() {
        return <ErrorBoundary key="vc-game-activity-menu" noop><GameMenuButton /></ErrorBoundary>;
    },
    start() {
        enabled = true;
        initError = "";
        try {
            if (!(globalThis as unknown as { DiscordNative?: unknown; }).DiscordNative)
                throw new Error("This plugin needs the Discord desktop client with game detection. Browser Discord is unsupported.");
            session = new GameSession(RunningGameStore as unknown as GameStore, {
                now: Date.now,
                defer: callback => {
                    if (FluxDispatcher.isDispatching()) FluxDispatcher.wait(callback);
                    else queueMicrotask(callback);
                },
                dispatch: event => FluxDispatcher.dispatch({ ...event }),
                everySecond: callback => {
                    const timer = setInterval(callback, 1000);
                    return () => clearInterval(timer);
                },
                changed: notify
            });
        } catch (err) { initError = err instanceof Error ? err.message : "Discord compatibility check failed."; }
        notify();
    },
    stop() { enabled = false; badgeReader.reset(); resetStreakTest(); closeModal(gameMenuKey); session?.stop("Plugin disabled. Normal game detection restored."); notify(); },
    flux: {
        ACTIVITY_UPDATE_START({ applicationId }: { applicationId: string; }) { session?.activityUpdate(applicationId, "pending"); },
        ACTIVITY_UPDATE_SUCCESS({ applicationId }: { applicationId: string; }) { session?.activityUpdate(applicationId, "accepted"); },
        ACTIVITY_UPDATE_FAIL({ applicationId }: { applicationId: string; }) { session?.activityUpdate(applicationId, "failed"); },
        LOGOUT() { badgeReader.reset(); resetStreakTest(); session?.stop("Signed out. Session stopped."); },
        CONNECTION_CLOSED() { badgeReader.reset(); resetStreakTest(); session?.stop("Disconnected. Start a new session after reconnecting."); }
    },
    toolboxActions: { "Open game activity menu": openGameMenu, "Stop game activity spoofing": () => session?.stop() }
});
