# Annado for Obsidian

Annado is a vault-native task manager: it parses, schedules, and completes plain
Markdown tasks across your vault and presents them through a bespoke agenda and
review workflow — Inbox, Today, Upcoming, Agenda, Anytime, Someday, Logbook,
Recurring, and a weekly Review.

Your tasks stay as plain Markdown lines in your own notes. Annado reads and
writes them in place; there is no separate database. Projects, areas, and people
are ordinary notes, and Annado understands their frontmatter and `[[wikilinks]]`.

## What it is

- A single main-area view (a full-width tab, not a cramped sidebar) hosting
  Annado's React UI inside Obsidian.
- A Rust → WebAssembly core that does the parsing, line surgery, recurrence math,
  and ICS calendar expansion. The `.wasm` is inlined into `main.js` as base64 and
  instantiated synchronously, so there is no runtime download — it works offline
  and on mobile.
- Vault I/O goes through Obsidian's own Vault / metadata APIs (every path is run
  through `normalizePath`, renames use `fileManager.renameFile` so `[[wikilinks]]`
  are maintained vault-wide).

Desktop-only integrations from the standalone (Tauri) build are mapped onto
Obsidian equivalents:

- Global shortcuts → Obsidian commands with default hotkeys (Obsidian-scoped; a
  plugin cannot register true OS-global shortcuts).
- Notifications → in-app `Notice`s, plus an hourly due-today reminder tick
  (background / OS-level delivery is not available to a plugin).
- Tray / extra windows → no-ops (Obsidian has neither).

## Platform support

`isDesktopOnly` is `false` — the plugin is built to run on desktop and mobile.
On a phone Annado uses its narrow drawer/sheet layout, driven by Obsidian's
`Platform.isPhone`. Touch drag-and-drop is supported.

> **Note:** mobile and desktop behaviour has been verified at the build level
> only (see the caveat below). It has not yet been exercised inside a running
> Obsidian instance.

## Install (manual, until community-store listing)

1. Download `main.js`, `manifest.json`, and `styles.css` (if present) from a
   release.
2. Create a folder `<your-vault>/.obsidian/plugins/annado/` and drop those files
   in it.
3. In Obsidian: Settings → Community plugins → enable **Annado**.
4. Open it from the ribbon (check-circle icon) or the "Open Annado" command.

Configure your folder conventions (Projects / Areas / Persons / Daily notes),
excluded paths, and ICS calendar subscriptions in the plugin's settings tab.

## Quick test (no Rust required — this branch only)

For convenience on the `claude/pivot-testable` branch, the prebuilt WASM core
(`packages/core/pkg/`) is **committed**, so you can build the plugin with just
Node — no Rust / wasm-pack needed:

```sh
npm install                                # repo root: shared React UI deps
cd apps/obsidian && npm install && npm run build   # -> main.js + styles.css
```

Then copy `main.js`, `manifest.json`, `styles.css`, and `versions.json` into
`<your-vault>/.obsidian/plugins/annado/` and enable it (see "Install" above).

## Build from source (rebuilding the WASM core)

To regenerate the core yourself you need the Rust toolchain + `wasm-pack`
(`cargo install wasm-pack`, or `brew install wasm-pack`). From the repository root:

```sh
# 1. Build the Rust → WASM core (emits packages/core/pkg/).
#    --features wasm is REQUIRED: it gates the #[wasm_bindgen] exports. Without
#    it the bindings export nothing and the plugin fails at runtime.
wasm-pack build packages/core --target web --out-dir pkg --features wasm

# 2. Install the plugin's build tooling.
cd apps/obsidian
npm install

# 3. Type-check and produce the bundle.
npx tsc --noEmit
npm run build      # -> apps/obsidian/main.js

# (use `npm run dev` for an esbuild watch build)
```

`manifest.json` and `versions.json` already live next to the emitted `main.js`,
which is exactly what Obsidian loads — no copy step is required.

### Bundle size

The production `main.js` is roughly **4.3 MB** — dominated by the base64-inlined WASM core (~2.7 MB `.wasm`) plus the React UI. `styles.css` is ~178 KB. (An earlier ~700 KB figure reflected a build where the core's `wasm` feature was not enabled — see step 1.)
The size is dominated by the inlined WebAssembly core (shipped as base64 so the
engine needs no runtime fetch and works offline / on mobile) plus the bundled
React UI.

## Caveat: build-verified, not runtime-tested

This plugin has been verified at the **build level only**:

- `apps/obsidian`: `tsc --noEmit` is clean and `npm run build` emits `main.js`.
- `packages/core`: `cargo test` is green.
- Repo root: `tsc --noEmit`, `eslint src` (0 errors), `vitest run`, and
  `npm run build` are all green.

It has **not** been loaded into a running Obsidian instance, on desktop or
mobile. Final QA — and packaging / submission for the community store — needs a
machine that can run Obsidian (a Mac for the iOS path in particular). Treat
runtime behaviour as unverified until that has happened.
