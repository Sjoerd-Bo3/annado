# Architecture Pivot Analysis — Obsidian Plugin vs. a Different Framework

*Decision-grade analysis of two proposed pivots for Annado, with phased plans and a
recommendation. Compiled from a full-codebase coupling audit, a backend-capability
mapping, an Obsidian-plugin feasibility study, and a framework-alternatives survey
(Tauri / Electron / Wails / Neutralino / PWA / Capacitor), each cross-checked against
2026 sources.*

---

## 0. TL;DR / Recommendation

Two questions were on the table:

1. **Pivot to an Obsidian plugin** (a sidebar/leaf inside Obsidian), keeping features + design.
2. **Or move off Tauri** to a "more robust, more lightweight" framework.

**Findings:**

- **Don't swap standalone frameworks.** None of Electron / Wails / Neutralino / PWA beats
  Tauri for *this* app's goals. "Lightweight" does **not** point to Electron (it's ~25×
  heavier and has no mobile); Wails (alpha, no mobile, would force a Rust→Go rewrite) and
  Neutralino (tiny but minimal, no mobile) discard your Rust asset; a pure PWA is the
  lightest but **can't read an Obsidian vault on iOS** (File System Access API is
  Chromium-only) and loses native integration. Tauri — despite real warts — is already the
  best standalone choice, and you've **already done** the Windows + iOS port work on it.

- **The genuinely compelling pivot is the Obsidian plugin** — precisely *because your data
  is already an Obsidian vault.* Living inside Obsidian solves, in one move, the four things
  you're actually chasing with "lightweight": **file access, mobile, sync, and
  distribution.** It retires the entire codesign/notarize/installer/auto-update pipeline and
  gives you iOS/iPad/Android **for free** via Obsidian's mature mobile apps.

- **Best strategy = the hybrid, enabled by one refactor.** The codebase is already
  ~92–95% platform-agnostic UI and ~55–60% portable backend logic. Extract a shared
  **`core` + `ui`** with a single **`VaultBackend` interface**, then ship the Obsidian plugin
  *and* keep the Tauri app from one monorepo. That refactor is low-risk and valuable on its
  own — it's the prerequisite for *either* pivot and improves the current app regardless.

- **A key refinement found late: keep the Rust core via WASM.** You don't have to rewrite
  `parser.rs`/`vault.rs` in TypeScript for the Obsidian plugin — you can **compile the Rust
  core to `wasm32`** and run it inside the plugin. This is a proven 2026 pattern
  (obsidian-rumdl, obsidian-semantic-search, etc.), is **mobile-safe** (pure WASM, no Node),
  and makes the scary "byte-identical parser" risk **disappear — it's literally the same
  code.** The hybrid then becomes **one React UI + one Rust→WASM core**, consumed by a thin
  Tauri shell *and* the Obsidian plugin — preserving *both* of your major investments.

- **On the literal "right sidebar" idea:** the app's 3-column layout (sidebar + list + side
  panel + agenda) **cannot breathe** in Obsidian's narrow right sidebar. Host it in a
  **main-area workspace leaf** (a full tab), optionally with a small right-sidebar
  *companion* view (a "Today/Inbox" mini-list). Design is preservable with scoped Tailwind.

**Recommended sequence:** (1) do the `core`/`ui`/`VaultBackend` refactor on the Tauri app
[~1–2 wks], (2) build the Obsidian plugin from the shared packages [~6–9 wks], (3) decide
later whether to keep the Tauri app long-term or let the plugin + a thin PWA cover everything.

---

## 1. Why this is even feasible: the coupling is small and concentrated

A full audit of `src/` (133 files) and `src-tauri/` (5.6–6.7k LOC) found the app is far
more portable than a typical Tauri app:

| Layer | Portability | Evidence |
|---|---|---|
| **React UI** | **~92–95% platform-agnostic** | Only **9 of 133** files import anything Tauri. All components, the 12 views, design system, date parsing, filtering, grouping are pure React. |
| **Backend logic** | **~55–60% pure portable logic** | `parser.rs` (~95% pure), `ics.rs` (~90% pure), recurring/date math, frontmatter semantics — all port ~1:1 to TypeScript. The rest is platform glue. |
| **The seam** | A single data-provider interface | Nearly all `invoke()` calls route through 3 Zustand slices; `tasks-updated` is the one sync event. A `VaultBackend` interface captures the whole contract (~41 commands). |

**The coupling chokepoints** (the only files a pivot must rewrite/abstract):
`stores/slices/{taskSlice,settingsSlice,calendarSlice}.ts` (the `invoke` calls),
`hooks/useAppEvents.ts` (events, deep links, shortcuts), `features/tray/*` (separate
window — deleted for Obsidian), `App.tsx`/`main.tsx`/`useTheme.ts` (window chrome),
`utils/openInEditor.ts`, `features/notifications/NotificationSettings.tsx`,
`features/agenda/TimeBlock.tsx` (2 calendar writes).

**Window-chrome assumptions that break inside Obsidian** (must be removed for a leaf):
`data-tauri-drag-region` + `-webkit-app-region` drag strip, the macOS traffic-light
spacer (`Sidebar.tsx`), `pt-12`/`pl-[52px]` titlebar gutters, the `main.tsx`
`label === 'tray-popup'` multi-window branch, `getCurrentWindow().setBackgroundColor()`,
and `h-screen`/`100vh`/`overflow:hidden` (a leaf is a sub-pane, not the viewport).

**Implication:** introduce one `VaultBackend`/`PlatformBridge` interface behind the slices
and the port is isolated to ~9 files. Everything else — the design, the views, the
logic — travels unchanged. *This is the linchpin of the whole analysis.*

---

## 2. Option A — Obsidian plugin

### 2.1 Verdict: feasible, strong strategic fit, but a real data-layer rewrite (not a wrapper)

The React UI + Tailwind design + TS logic port cleanly into a plugin. The data engine lives
in **Rust** (`parser.rs` 856 LOC + `vault.rs` 2,859 LOC), reached via `invoke()`. There are
**two ways** to bring it into the plugin:

- **(a) Port the logic to TypeScript** — faithful, mechanical, but you maintain two parsers
  (Rust for Tauri, TS for the plugin) unless you later drop the Rust one, and you must prove
  byte-identical output with golden tests.
- **(b) Compile the Rust core to WASM (recommended).** Refactor `parser.rs` + the *pure*
  read/write/recurrence logic of `vault.rs` into a `core` crate that targets `wasm32`, doing
  all file I/O **through the JS/Vault API** (not `std::fs`). The plugin calls it via
  `wasm-bindgen`. This is **mobile-safe** (WASM runs in Obsidian's JS sandbox — it sidesteps
  the "no Node on mobile" rule), it's a **shipping 2026 pattern**
  (obsidian-rumdl, obsidian-semantic-search, the obsidian-rust-template), and **byte-identical
  output is free** because it's the same code. The same WASM artifact can back the Tauri shell
  too, collapsing two parsers into one.

Either way, the *platform glue* of `vault.rs` (the `notify` watcher, `WalkDir`, `fs`, locks)
is **dropped** — Obsidian's Vault API + `vault.on(...)` replace it.

### 2.2 What you GAIN (this is the case for it)

- **Mobile for free** — Obsidian ships first-class iOS/iPad/Android apps; community plugins
  run on them (`isDesktopOnly:false`). One TS codebase → all platforms. No Swift shell, no
  separate Tauri-iOS effort (which is "desktop-first with mobile reach" and rough at the
  edges today).
- **Sync for free** — files live in the vault; whatever syncs it (Obsidian Sync, iCloud,
  Dropbox, git) syncs Annado's data. The entire iOS vault-access / security-scoped-bookmark
  problem (a known hard spot in your current iOS plan) **disappears**.
- **A big chunk of the backend disappears**, replaced by better primitives:
  - `vault.on('modify'|'create'|'delete'|'rename')` replaces the **entire 200-line `notify`
    watcher** (debounce, folder-op detection, lock/hidden filtering) — the single biggest win.
  - `metadataCache.getFileCache()` gives pre-parsed checkbox list-items (with line numbers +
    nesting), tags, `[[links]]`, frontmatter — replacing the file walk + structure scan.
  - `fileManager.renameFile()` auto-updates **every `[[link]]`** vault-wide — replacing the
    custom wikilink-rewrite walk in project/person rename.
  - `processFrontMatter()` replaces all the `serde_yml` plumbing.
  - The `obsidian-daily-notes-interface` + bundled moment.js replace all daily-note path/
    format/creation code.
  - `vault.process()` is a safer atomic read-modify-write than raw `fs::write`.
  - `saveData()`/`loadData()` replace `config.json` (now vault-relative — settings travel
    with the vault; "select a vault path" disappears entirely).
- **Distribution collapses from ~a dozen concerns to one.** Today: codesign + Apple
  notarization ($99/yr) + DMG/MSI/NSIS per-OS + auto-updater + Windows HSM/Azure signing
  (which got *worse* in 2026: 1-year certs, hardware tokens). As a plugin: PR your entry to
  `community-plugins.json` once; thereafter **tag a GitHub release with 3 files** and
  Obsidian pushes the update to all users, desktop **and mobile**, automatically. No signing,
  no notarization, no installers, no Apple account.

### 2.3 What you LOSE (the honest costs)

| Capability today | In an Obsidian plugin |
|---|---|
| Standalone OS window / app identity | **Gone** — lives inside Obsidian (can pop a leaf into its own window, but it's still Obsidian). |
| Menu-bar / system-tray popup (`TrayPopup.tsx`) | **Gone** — no tray API. Replace with a ribbon icon + optional right-sidebar mini-view. |
| True global hotkeys (system-wide) | **Lost** — Obsidian hotkeys fire only when Obsidian is focused. |
| OS/background reminders (`notification_scheduler`) | **Degraded** — in-app `Notice` toasts work; scheduled/background OS notifications are a long-standing Obsidian gap. Logic ports, delivery weakens. |
| Native macOS calendar (EventKit FFI) | **Gone** — no native FFI in the plugin sandbox. Replace with **ICS subscriptions in TS** (you already have the ICS logic — port it). |
| Deep-link `annado://` scheme | Replace with `obsidian://` protocol handler (weaker). |
| The bespoke design coexisting with themes | **At risk** — Obsidian's theme CSS will bleed in unless you scope it (see below). Solvable, but real work. |

### 2.4 Design preservation (the thing you most care about)

The Tailwind look **can** be kept, but Obsidian injects heavy global CSS, so you must isolate:
- **Baseline (recommended):** wrap the React root in `.annado-root`, give Tailwind v4 a
  **prefix**, and **scope Preflight** to your root (so Tailwind's reset doesn't fight
  Obsidian's, and yours doesn't pollute Obsidian). Keep your `@theme` tokens scoped under
  `.annado-root` rather than `:root`.
- **Fallback (strongest):** mount the React root in a **Shadow DOM** for near-total CSS
  encapsulation (precedent: the *obsidget* plugin). Trade-off: complicates `@dnd-kit`
  overlays/portals and focus, so use only if bleed proves stubborn.
- **Bundle your fonts** (don't rely on SF Pro; especially mobile/Windows).
- Expect a few days of CSS-collision whack-a-mole. The polished design **is** preservable.

### 2.5 Placement: main leaf, not the right sidebar

| Placement | Fit |
|---|---|
| Right/left sidebar leaf | **Poor** — sidebars are ~250–350px; the 3-column layout can't fit. |
| **Main-area workspace leaf (a tab)** | **Best** — full center pane, the width the app expects; pop-out-able. Open via ribbon + command. |
| Modal | Only for sub-dialogs (Quick Add, pickers). |

Precedents that prove big React UIs work this way: **Excalidraw** (large React app in an
`ItemView`, even pop-out windows), **Kanban**, and the now-discontinued **Obsidian
Projects** (table/board/calendar task manager — the closest analog, leaving an open niche).
Optionally add a small **right-sidebar companion** ("Today/Inbox" mini-list) as a second
view — the literal "right sidebar" idea, done as a complement rather than the home.

### 2.6 Mobile caveats (the asterisks on "free")

- **No Node/Electron APIs on mobile** — keep the bundle pure-browser (you're dropping
  `@tauri-apps/*` anyway). Audit deps.
- **Regex lookbehind only on iOS ≥16.4** — check `dateParser.ts`/`detectDateHints.ts`.
- **Responsive/touch redesign** of the agenda + multi-column views is real work (this is the
  same work item as the iPhone-layout PR you already did — much of it transfers).

### 2.7 Effort & risks (solo experienced dev)

| Phase | Work | Effort |
|---|---|---|
| 0 | Scaffold plugin (esbuild, `registerView`, ribbon), scoped Tailwind build, monorepo (`core`/`ui`/`apps`) | 3–5 days |
| 1 | **Port `parser.rs` + read/write half of `vault.rs` to TS** against Vault API/metadataCache; reuse Rust tests as golden cases; **byte-identical** round-trip tests | 1.5–2.5 wks |
| 2 | Wire data layer: every `invoke()` → Vault API; events → `vault.on`/`metadataCache.on`; settings → `loadData/saveData` | 1–1.5 wks |
| 3 | Mobile + responsive (Platform checks, touch sensors, lookbehind fallback) | 1–1.5 wks |
| 4 | Replace lost features: ICS-in-TS, `Notice`, Obsidian hotkeys, open-note-in-Obsidian | 1–2 wks |
| 5 | Polish, `normalizePath()` audit, CSS-bleed pass, submit to community store | 1 wk |

**~6–9 weeks** to first store release. **Top risks:** (1) parser/serializer fidelity —
the TS output must be **byte-identical** to the Rust output or the two apps fight over file
formatting (mitigate with shared golden tests); (2) CSS bleed; (3) JS parse performance on
large vaults (lean on metadataCache + incremental per-file reparse); (4) the genuine feature
regressions (tray, global hotkeys, OS reminders, EventKit).

---

## 3. Option B — a different standalone framework

Scored for *this* app (React UI + Rust backend, markdown/Obsidian data, wants macOS +
Windows + mobile, wants "lightweight"). ✅ good · ⚠️ caveat · ❌ poor.

| Criterion | **Tauri 2 (stay)** | Electron | Wails (Go) | Neutralino | PWA / pure web |
|---|---|---|---|---|---|
| Bundle size | ✅ ~8–10 MB | ❌ ~150–240 MB | ✅ ~4 MB | ✅ ~0.5–2 MB | ✅ ~0 (no install) |
| Idle RAM | ✅ ~30–170 MB | ❌ ~150–400 MB | ✅ low | ✅ lowest | ✅ browser tab |
| Reuse existing Rust backend | ✅ native | ⚠️ napi-rs/sidecar | ❌ rewrite→Go | ❌ drop it | ❌ rewrite→TS |
| Mobile (iOS/iPad/Android) | ⚠️ "desktop-first w/ reach" | ❌ none (needs Capacitor) | ❌ alpha/none | ❌ none | ⚠️ Android ok; **iOS ❌** |
| Local file access + watch | ✅ full (`notify`) | ✅ full (chokidar) | ✅ full | ⚠️ limited | ❌ no watch (poll), **Chromium-only** |
| Native integration (tray/shortcuts/notif) | ✅ full | ✅ full | ⚠️ partial | ❌ minimal | ❌ minimal |
| Signing/distribution burden | ⚠️ hard (improving) | ❌ hardest (1-yr certs, HSM) | ⚠️ | ⚠️ | ✅ none |
| Maturity / ecosystem | ✅ ~108k★, Commons Conservancy | ✅ most mature | ⚠️ v3 alpha | ⚠️ niche | ✅ the web |
| Keeps the React design | ✅ | ✅ | ✅ | ✅ | ✅ |

**Per-option read:**

- **Stay on Tauri (baseline).** Real warts: ~1-min default dev rebuilds (tunable to ~10s),
  CI 4–8 min cached, **Linux/WebKitGTK is the weak link** (maintainers themselves don't fully
  recommend Tauri for Linux), and mobile is rough (plugin fragmentation, no first-party
  remote push, recurring iOS signing bugs). But: tiny bundles, keeps the Rust backend
  natively, healthy ecosystem, and **you've already ported it to Windows + iOS.** For a
  standalone app, nothing here beats it.
- **Electron.** The *opposite* of "lightweight": ~25× larger, ~2–4× the RAM, **no mobile**
  (a separate Capacitor project), and the worst signing burden (2026 made Windows worse:
  1-year certs + mandatory HSM). Keeping the Rust backend means napi-rs or a sidecar. Only
  wins if you need Node-in-main or Chromium-exact rendering. **Reject** for this app.
- **Wails (Go).** Would require rewriting the Rust backend in Go; v3 is **alpha**; **no
  official mobile**. Step backward. **Reject.**
- **Neutralino.** Tiniest footprint, but minimal capabilities, small ecosystem, **no
  mobile**, discards the Rust backend. **Reject** for a feature-rich app.
- **PWA / pure web (the "most lightweight").** Zero install, auto-updates, works in any
  browser. But: the **File System Access API is Chromium-only** (no Safari → **no iOS vault
  access**), has **no background file watching** (poll only), and re-permission friction.
  Loses tray/shortcuts/notifications. **Verdict:** not viable as the *primary* vault app on
  iOS — but interesting as a *complement* to the Obsidian-plugin route (a zero-install
  desktop reader). **Capacitor** could wrap a web build for Android/iOS, but on iOS you're
  back to the sandbox/file-access problem the Obsidian route solves outright.

**Also considered and rejected (full UI rewrite):**

- **Flutter (Dart).** Renders its own widgets — **your ~21k-LOC React UI is unusable** and
  must be rewritten in Dart. You *could* keep the Rust core via the mature `flutter_rust_bridge`
  (2.x, a Flutter Favorite), and desktop matured in 2026 (Canonical now maintains it), but the
  bundle regresses vs Tauri and you'd discard the React design for a renderer you don't need.
  Only justified if you wanted unified *polished-native* mobile+desktop and were happy to throw
  away the UI. **Reject.**
- **.NET MAUI (C#/XAML).** Worst fit: **no Linux** (a regression — you support it today),
  Mac Catalyst is its weakest target, the ecosystem showed stability strain in 2026, and —
  critically — **Blazor Hybrid does *not* reuse React** (it runs *Razor* components, so it's a
  rewrite into a different web-component model, not React reuse). **Reject.**
- **React Native.** Despite the name, it doesn't render React-DOM — **the entire view layer is
  a rewrite** (`div`/CSS → `View`/`StyleSheet`); only non-UI logic is shareable. It buys no
  file-access advantage (same iOS sandbox limits). For an app that already has a complete React
  web UI, **Capacitor beats it** for any mobile-wrapper need. **Reject.**

**The decisive cross-cutting fact — iOS file access:** every non-Obsidian path collides with
the same wall. A **PWA cannot open a vault on iOS at all** (Safari has no File System Access
API — only the invisible OPFS sandbox; this is still true in 2026, even under the EU DMA since
no non-WebKit engine has actually shipped). **Capacitor/React Native on iOS** can only reach a
vault via the document-picker + **security-scoped bookmark** dance — *the exact constraint
Obsidian's own iOS app lives under* (vault must be in iCloud Drive or the app container). So
every standalone/web path re-encounters the iOS vault-access problem that the **Obsidian plugin
dissolves entirely** (Obsidian already owns that relationship). And **no** web/Capacitor/RN
path offers true background file watching — they all reduce to "re-scan on foreground."

**Conclusion for Option B:** *Switching standalone frameworks is not worth it.* The only
move that improves on Tauri-standalone is to **change category** — to the Obsidian plugin
(or a desktop-Chromium PWA complement) — not to swap one desktop shell for another.

---

## 4. The strategic synthesis: standalone vs plugin vs **both**

The deciding fact is that **Annado's data is already an Obsidian vault.** That makes "live
inside Obsidian" a structural fit, not a compromise — it's the one option that dissolves
file-access + mobile + sync + distribution simultaneously, which is exactly the bundle of
pains "go more lightweight" is really about.

But you don't have to choose, because of §1: the code is already mostly portable. The
**monorepo hybrid** is the recommended end-state:

```
packages/
  core/   ← parser, recurrence, filtering, ICS — ONE implementation:
            either pure TS, or the Rust core compiled to wasm32 (recommended)
  ui/     ← all React components + the Tailwind design system   (platform-agnostic)
apps/
  tauri/      ← thin VaultBackend over invoke()/Rust  (keeps tray, global hotkeys, EventKit)
  obsidian/   ← thin VaultBackend over the Vault API  (gets watch + sync + mobile free)
  (web/)      ← optional later: desktop-Chromium PWA reader
```

Each app provides a thin **`VaultBackend` adapter** implementing one interface; `core` + `ui`
are shared. **The "two parsers" objection — the main risk of a hybrid — dissolves with the
Rust→WASM core:** one Rust codebase compiles to a native lib for the Tauri shell *and* to WASM
for the Obsidian plugin (and could even replace the Tauri app's native parser with the WASM
one to truly unify on a single artifact). Rust stays only for the genuinely native desktop
bits the Tauri shell wants (tray, global hotkeys, EventKit FFI).

---

## 5. Recommended plan

**Phase 0 — The enabling refactor (do this regardless) [~1–2 wks].**
On the Tauri app, extract `core` (logic) + `ui` (components) packages and introduce the
**`VaultBackend` interface** behind the 3 Zustand slices; move the ~41 `invoke` calls behind
a `TauriBackend` adapter. Pure refactor, no behavior change, fully testable. This *de-risks
every other option* and improves the current codebase (clean seam, testable core).

**Phase 1 — Obsidian plugin from the shared packages [~6–9 wks].**
Implement `ObsidianBackend` over the Vault API; bring the parser/recurrence logic into `core`
— **preferably by compiling the Rust core to WASM** (byte-identical, mobile-safe) rather than
a TS rewrite; host the UI in a main-area leaf with scoped Tailwind; add the responsive/touch
pass; replace lost features (ICS-in-TS-or-WASM, `Notice`, Obsidian hotkeys); submit to the
community store. **This delivers mobile + sync + trivial distribution.** (The WASM path makes
the parser-fidelity risk effectively zero; budget toward the lower end if you take it.)

**Phase 2 — Decide the standalone story.**
With the plugin shipping, choose: (a) keep the Tauri app for users who want a standalone
window + tray + global hotkeys (now sharing 90%+ of code), or (b) let it lag/retire it if
the plugin + an optional zero-install PWA reader cover the audience. No need to decide now —
the refactor keeps both doors open.

**Explicitly do NOT:** rewrite onto Electron/Wails/Neutralino, or bet the product on a
PWA-only approach (iOS vault access blocks it).

---

## 6. One-screen decision summary

- **"Pivot to an Obsidian plugin?"** → **Yes, strongly worth it** — as a **main-area leaf**
  (not the narrow right sidebar), with an optional right-sidebar companion. It's the only
  option that gives mobile + sync + trivial distribution because your data already lives in
  Obsidian. Cost: bring the data layer over (ideally **Rust→WASM**, not a TS rewrite), scope
  the CSS, accept losing tray/global-hotkeys/OS-reminders/EventKit. ~6–9 wks after the refactor.
- **"Move off Tauri to something lighter/more robust?"** → **No** — for a *standalone* app,
  nothing beats Tauri here, and you've already ported it. Electron is heavier with no mobile;
  Wails/Neutralino discard your Rust and have no mobile; a PWA can't access a vault on iOS.
- **Best move:** the **`core`/`ui`/`VaultBackend` refactor first**, then the Obsidian plugin,
  keeping the Tauri app via the shared packages (the **hybrid**). One refactor unlocks
  everything and is worth doing on its own merits.

*(Sources for the external claims — Obsidian React/Views/Vault/MetadataCache/Mobile/Platform
docs, the Tailwind-scoping approaches, Excalidraw/Kanban/Projects precedents, the Tauri-vs-
Electron 2026 size/RAM data, Electron signing/mobile limits, File System Access API limits,
and Wails/Neutralino state — are cited inline in the underlying research notes that produced
this document.)*
