# GameActivitySpoofer

A custom Vencord desktop plugin for selecting and simulating detected game activity.

## Features

- Search Discord's detectable game catalog and select a game or queue.
- View game cover art beside each title, with game icons and a gamepad placeholder as fallbacks.
- Open the game controls from the gamepad button in Discord's top-right toolbar.
- Set a rotation interval and optional session time limit.
- View Discord-reported Game Time and Game Variety badge tiers, progress bars, and remaining requirements.
- Move to the next game or stop the session from the menu.
- Restore normal game detection when a session stops.

## Installation

This plugin is installed from source as part of a custom Vencord build. It requires the Discord desktop client.

1. Set up a Vencord source checkout following the [Vencord installation guide](https://docs.vencord.dev/installing/).
2. Download this repository's ZIP from **Code → Download ZIP**.
3. Create `src/userplugins/gameActivitySpoofer` inside your Vencord checkout.
4. Copy `index.tsx`, `core.ts`, and `badges.ts` into that folder. The resulting paths must be:

   ```text
   src/userplugins/gameActivitySpoofer/index.tsx
   src/userplugins/gameActivitySpoofer/core.ts
   src/userplugins/gameActivitySpoofer/badges.ts
   ```

5. From your Vencord checkout, run:

   ```sh
   pnpm build
   ```

6. If that checkout is not already installed, fully quit Discord and run `pnpm inject`, then follow the installer prompts.
7. Reopen Discord and enable **GameActivitySpoofer** in **Settings → Vencord → Plugins**. Restart if prompted.

See also the [Vencord custom plugin guide](https://docs.vencord.dev/installing/custom-plugins/).

## Usage

Open the gamepad button in the top-right toolbar, or open the plugin's settings. Click **Load game catalog**, search for a game, select it, and click **Start session**.

Select multiple games to rotate through them in selection order. Use **Next game** to advance, or **Stop session** before changing your selection. Closing the menu keeps the session running.

## Badge progress

The status panel reads your own Game Time and Game Variety badge data from Discord. Each card shows the current tier, next tier, a progress bar when Discord provides numeric counters, and Discord's own remaining-requirement text.

Progress is checked once a minute while the menu is open. **Refresh progress** requests another update after the short cooldown. Automatic refresh pauses after a failed request; manual refresh can retry after the cooldown. Rate-limit delays are respected.

These are server-reported counters, not estimates derived from the spoofer's timer. Discord may update them later than your session. Missing data is shown as unavailable rather than zero. The latest successful values remain visible and are marked if a refresh fails. Badge data stays in memory and is cleared on logout, disconnect, or plugin disable; late responses from another account are discarded.

## Artwork

Artwork comes from Discord's catalog and CDN. Covers are preferred; unavailable covers fall back to game icons, then a gamepad placeholder. Images load lazily as you scroll.

## Limitations

The plugin displays Discord-reported progress; whether a particular spoofed session earns badge credit remains unverified. The plugin cannot unlock a badge rollout or fast-forward hours. It stops on logout, disconnect, plugin disable, or a long sleep/suspension; starting again is manual.


## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
