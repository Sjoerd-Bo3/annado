# Pivot Implementation Plan — Annado as an Obsidian Plugin (the hybrid)

*The file-level build plan for the architecture pivot decided in
[`architecture-pivot.md`](./architecture-pivot.md). It turns the recommendation
into executable, stacked PRs and maps which can be built in parallel.*

Strategy recap: **one React UI + one Rust→WASM core**, consumed by a thin **Tauri
shell** (standalone, tray, hotkeys) *and* a thin **Obsidian plugin** (mobile +
sync + vault-native), behind the `VaultBackend`/`Backend` seam from PR #7.

---

## Status & foundation

- **PR #7 (done):** `src/backend/` seam. The UI imports only from `../backend`;
  `TauriBackend` is the sole `@tauri-apps/*` consumer; an ESLint guard enforces it.
  This is the injection point every other host plugs into via `setBackend()`.

Everything below stacks on PR #7's branch (`claude/pivot-vault-backend`).

---

## Verifiability ground rules (be honest about this)

| Can verify in this environment | Cannot verify here (needs a Mac + Obsidian / real devices) |
|---|---|
| `tsc`, ESLint, vitest, `vite build` | The plugin actually mounting in an Obsidian leaf |
| `cargo build --target wasm32-unknown-unknown`, `cargo test` | Vault read/write round-trips inside Obsidian |
| esbuild bundling the plugin to `main.js` | Mobile (iOS/Android) behavior, touch, CSS-bleed against live themes |
| Parser parity via ported golden tests (native + WASM) | Community-store review |

Every PR below states its verification level. "Build-verified" ≠ "runtime-verified."

---

## Monorepo shape (introduced in PR 2)

```
package.json            # npm workspaces root
packages/
  core/                 # (PR 3) Rust→WASM core: parser, recurrence, ICS  → wasm-bindgen
  ui/                   # (optional, PR 4+) shared React components extracted from src/
apps/
  tauri/                # the existing app (src/ + src-tauri/) — moved or referenced
  obsidian/             # (PR 2) the Obsidian plugin
```

To avoid a disruptive big-bang move, **PR 2 introduces `apps/obsidian/` and an npm
workspace without relocating the existing app** (the Tauri app stays at repo root
initially; `apps/obsidian` imports shared code via a path alias / workspace dep).
A later optional PR can physically relocate `src/` → `apps/tauri/` once the dust
settles. This keeps the existing PR stack (#1–#7) mergeable.

---

## PR 2 — Obsidian plugin scaffold + `ObsidianBackend` skeleton

**Goal:** a plugin that *builds*, registers a main-area leaf, mounts the shared
React `App`, and injects an `ObsidianBackend` implementing the `Backend` interface.
Data commands are stubbed (return empty + TODO) so it compiles before the WASM core
lands; platform ops and vault change-events are real.

**New files (`apps/obsidian/`):**
- `manifest.json` — `id: annado`, `name`, `version`, `minAppVersion`,
  `isDesktopOnly: false`, `description`.
- `package.json` — deps: `obsidian` (devDep, types), `esbuild`, `react`, `react-dom`;
  scripts `build`/`dev`.
- `esbuild.config.mjs` — bundle `src/main.tsx` → `main.js` (CJS, external `obsidian`,
  `electron`, and Node builtins; `format: cjs`, `platform: browser`), copy
  `manifest.json` + `styles.css`.
- `tsconfig.json` — extends root, `jsx: react-jsx`, includes plugin + shared `src`.
- `src/main.ts` — `export default class AnnadoPlugin extends Plugin`:
  - `onload()`: `setBackend(new ObsidianBackend(this.app, this))`; `registerView(VIEW_TYPE, leaf => new AnnadoView(leaf))`; ribbon icon + `addCommand('open-annado')` → `activateView()` opening a **main-area** leaf (`workspace.getLeaf('tab')`), per the analysis (not the narrow sidebar). Optional second `registerView` for a right-sidebar "Today" companion (later).
  - `onunload()`: detach leaves.
- `src/AnnadoView.ts` — `extends ItemView`; `getViewType`/`getDisplayText`/`getIcon`;
  `onOpen()` mounts `createRoot(this.contentEl).render(<AnnadoRoot/>)`; `onClose()`
  unmounts. Wrap root in `<div className="annado-root">` (CSS scope anchor for PR 4).
- `src/ObsidianBackend.ts` — `class ObsidianBackend implements Backend`:
  - `invoke(command, args)`: a `switch` dispatcher. **PR 2:** stub each command
    (return `[]`/`null`/`undefined`) with `// TODO(PR3): route to WASM core + Vault API`.
    Wire the *trivial* ones now where cheap (`is_system_calendar_supported → false`).
  - `listen(event, handler)`: for `tasks-updated`, register `vault.on('modify'|'create'|'delete'|'rename')` → debounced re-scan → `handler({payload: tasks})`; return an unsubscribe that `offref`s. Other events (`global-quickadd`, `tray-open-task`, `deep-link-received`) → no-op unsub (not applicable in-plugin).
  - `openExternal(url)`: internal `obsidian://`/`[[wikilink]]` → `workspace.openLinkText`; else `window.open(url)`.
  - `pickDirectory` → not applicable (vault is implicit); return `null`.
  - `getAppVersion` → `this.plugin.manifest.version`.
  - window ops (`getWindowLabel`/`startWindowDrag`/`hideWindow`/`setWindowBackground`) → no-ops/sane defaults (`getWindowLabel: () => 'main'`).
- Settings: a later PR moves config to `loadData()/saveData()`; PR 2 leaves localStorage.

**Shared-code wiring:** `apps/obsidian/tsconfig` + esbuild alias map `@annado/*`
to the repo `src/` so the plugin imports the real components, slices, `backend`.

**Verification:** `npm run build` in `apps/obsidian` produces `main.js`; root `tsc`
still clean. **Build-verified only** (cannot mount in Obsidian here).

**Risk:** bundling React + the full app into one `main.js` (size); Obsidian's CJS
module expectations; `process`/Node references pulled in transitively (must be
shimmed/externalized — the seam already removed `@tauri-apps/*`, which helps).

---

## PR 3 — Rust→WASM core (the heart)

**Goal:** the markdown engine compiled to WASM, callable from `ObsidianBackend`, so
`get_tasks`/`update_task`/`toggle_task_complete`/recurrence/ICS work over the Vault
API with **byte-identical** output to the Tauri app.

**Approach:** extract the *pure* logic out of `src-tauri/src` into a `core` crate
that compiles to both native (for the Tauri app) and `wasm32-unknown-unknown`.

**New crate `packages/core/` (Rust):**
- `Cargo.toml` — `crate-type = ["cdylib", "rlib"]`; deps `serde`, `regex`, `chrono`,
  `rrule`, `chrono-tz`, `sha2`, `hex`; `wasm-bindgen` (+ `serde-wasm-bindgen`) under a
  `wasm` feature; `getrandom` with `js` feature for wasm.
- `src/lib.rs` — move `parser.rs` (verbatim — it's ~pure), plus the pure pieces of
  `vault.rs`: task-line format/round-trip, the notes/checklist line surgery,
  recurrence date math (`calculate_next_date`/`should_generate_instance`),
  project/person frontmatter parsing, daily-note format (`moment_to_chrono`), and the
  ICS module (`ics.rs`, already ~pure). **Exclude** the platform glue (`notify`
  watcher, `WalkDir`, `fs`, `std::process`) — that stays in the Tauri app / becomes
  Vault-API calls in the plugin.
- `src/wasm.rs` (under `feature = "wasm"`) — `#[wasm_bindgen]` wrappers:
  - `parse_file(path: &str, contents: &str) -> JsValue` (→ `Vec<Task>`)
  - `format_task_line(task: JsValue) -> String`
  - `apply_task_update(file_contents, line, payload) -> String` (pure string surgery)
  - `expand_ics(ics_text, sub, window_start, window_end) -> JsValue`
  - recurrence helpers
  All take/return strings or `serde_wasm_bindgen` values; **no file I/O inside WASM** —
  the plugin reads/writes via Vault API and passes contents in/out.
- Move the `#[cfg(test)]` suites along; they become the parity oracle.

**Tauri app change:** `src-tauri` depends on `packages/core` as a path dep and calls
into it instead of its inlined copies (keeps one source of truth). The `notify`
watcher + commands stay in `src-tauri`, now delegating parsing to `core`.

**`@annado/core` JS package:** `wasm-pack build --target web` (or bundler) emits a JS
package the plugin imports; `ObsidianBackend.invoke` routes commands to it +
`vault.process()` for writes.

**Verification:** `cargo test -p annado-core` (native), `cargo build -p annado-core
--target wasm32-unknown-unknown --features wasm`, `wasm-pack build`. Parser parity =
the ported tests passing on both targets. **Build-verified + test-verified.**

**Risk (highest in the stack):** `regex`/`chrono-tz`/`rrule` all compile to wasm32
(verify — `chrono` needs `wasmbind` feature; `getrandom` needs `js`). Bundle size of
the `.wasm`. Async boundary (Vault I/O is async in JS; core stays sync/pure so the
plugin orchestrates I/O around sync core calls).

---

## PR 4 — Scoped Tailwind so the design survives Obsidian's theme

**Goal:** the bespoke design renders intact inside a plugin leaf without bleeding
into (or being overridden by) Obsidian's theme.

**Changes (in `apps/obsidian` build):**
- Tailwind v4 build for the plugin emitting `styles.css`, with a **class prefix**
  (e.g. `tw-`) and **Preflight scoped** to `.annado-root` (via
  `tailwindcss-scoped-preflight` or `@layer` + `:where(.annado-root)`), so Tailwind's
  reset neither fights nor pollutes Obsidian.
- Move the `@theme` tokens + hardcoded colors in `src/App.css` under `.annado-root`
  rather than `:root`/`html`; gate the `-webkit-app-region`/scrollbar/global rules so
  they don't leak.
- Bundle the app fonts (don't rely on SF Pro on mobile/Windows).
- `h-screen`/`100vh`/`overflow:hidden` → `100%` of the leaf container (a leaf is a
  sub-pane, not the viewport) — gate behind a "hosted" flag.

**Verification:** `vite build`/esbuild emits scoped CSS; visual correctness is
**not** verifiable here (needs Obsidian + multiple themes). Flag for manual QA.

---

## PR 5 — Responsive / touch / mobile enablement

**Goal:** the plugin works on Obsidian mobile (iOS/iPad/Android).

**Changes:**
- `manifest.json` `isDesktopOnly: false`; audit the bundle for Node/Electron API use
  (must be zero on mobile — the seam + WASM core already avoid Node).
- Reuse the **iPhone-layout work** (from PR #4 of the port stack: `useIsNarrow`,
  sidebar drawer, full-screen side-panel sheet) — it largely transfers. Drive layout
  off `Platform.isPhone`/`isMobile` in addition to width.
- Touch: the `@dnd-kit` `TouchSensor` (already added in the port) for agenda
  drag-to-schedule; verify long-press tuning.
- iOS regex-lookbehind fallback in `dateParser.ts`/`detectDateHints.ts`.

**Verification:** builds; responsive testable by window resize. Real-device behavior
**not** verifiable here.

---

## PR 6 — Replace the lost desktop-integration features (Obsidian build)

**Goal:** sensible in-plugin equivalents for what doesn't exist inside Obsidian.

**Changes (mostly inside `ObsidianBackend` + small UI gates):**
- Notifications → `new Notice(...)` for in-app; deadline scheduling via
  `registerInterval`; document the background-delivery gap.
- Global shortcuts → `addCommand({ hotkeys })` (Obsidian-focused only); map Annado's
  bindings.
- Tray popup / separate windows → drop in the Obsidian build (optionally a
  right-sidebar "Today/Inbox" companion view).
- EventKit → gone; ICS subscriptions via the WASM core + Obsidian `requestUrl()`
  (CORS-free) instead of `ureq`.
- "Open in editor" → open the note in Obsidian (`workspace.openLinkText`).
- Config → `loadData()`/`saveData()` (vault-relative), replacing localStorage/config.json
  for the plugin build.
- Settings tab via `PluginSettingTab`.

**Verification:** builds + unit tests for the scheduling/mapping logic. Delivery
behavior needs Obsidian.

---

## PR 7 — Community-store readiness

**Goal:** pass Obsidian's automated review and ship.

**Changes:** `normalizePath()` on all vault paths; no `innerHTML` with untrusted data;
proper `onunload` cleanup (unmount React, offref events, clear intervals); remove
console noise; bundle-size pass; `versions.json`; README + screenshots; submit PR to
`obsidianmd/obsidian-releases`.

**Verification:** the submission checklist; final QA on desktop + mobile.

---

## Parallelization map (for the subagent build)

```
PR #7 seam ──┬── PR 2  Obsidian scaffold (frontend: apps/obsidian, package.json)        ┐
             │                                                                            ├─ disjoint file sets → parallel-safe
             └── PR 3  Rust→WASM core   (rust: packages/core, src-tauri)                  ┘
                          │
   (after 2 & 3 land) ── PR 4 Tailwind scope ─ PR 5 responsive ─ PR 6 lost-features ─ PR 7 store
```

- **PR 2 and PR 3 are independent and touch disjoint files** (PR 2 = TS/`apps/`;
  PR 3 = Rust/`packages/core` + `src-tauri`). They are the two parallel subagent
  tracks. PR 2 stubs the data layer so it builds without PR 3; PR 3 is a standalone
  crate with its own tests.
- **PR 4–7 are sequential**, layering on the scaffold once PR 2/PR 3 land; they're a
  later wave (some need Obsidian to verify, so they're lower-leverage to auto-build).

Each subagent: branch off `claude/pivot-vault-backend`, implement its track,
**build-verify** (commands above), push, open a PR stacked on the seam branch, and
report what's build-verified vs. needs-Obsidian.
