# Porting Annado to Windows and iOS/iPadOS — Analysis & Plan

*Goal: keep all features and the existing design on every platform.*

## TL;DR

- **Windows is very feasible.** The stack (Tauri 2 + React) is cross-platform by design, and the
  codebase is already ~90% portable: path handling uses `PathBuf`, config storage uses Tauri's
  platform-aware dirs, and dialogs/notifications/tray/global shortcuts/deep links all go through
  cross-platform Tauri plugins. A working Windows build (everything except calendar) is roughly
  **1–2 weeks** of work. The one genuinely hard feature is **calendar integration**, which is
  503 lines of macOS-only EventKit FFI and needs a different approach on Windows (see below).
- **iOS/iPadOS is possible but a much bigger project (~4–8 weeks).** Tauri 2 ships iOS support,
  and ironically the EventKit calendar code mostly *carries over* to iOS — but vault access
  (sandboxing), file watching, no tray/global shortcuts, and touch-first UI adaptation are
  substantial. Recommended order: **Windows → iPad → iPhone**.

---

## 1. Current architecture snapshot

| Component | Size | Portability |
|---|---|---|
| Rust backend (`src-tauri/src`) | 5,608 lines / 6 modules | Portable except `calendar.rs` (503 lines) |
| Frontend (`src`) | 12,847 lines / 133 files | Fully portable; a few cosmetic macOS assumptions |
| Tauri plugins | dialog, opener, deep-link, global-shortcut, notification | All cross-platform on desktop |

What is **already cross-platform** (no work needed):

- **Path handling** — `PathBuf`/`join()` everywhere, no hardcoded `/`, vault path canonicalized,
  config stored via `app.path().app_config_dir()` (resolves to `%APPDATA%\Annado\` on Windows).
- **File watching** — the `notify` crate auto-selects `ReadDirectoryChangesW` on Windows
  (one Cargo feature flag to fix, see below).
- **Markdown parsing, task CRUD, projects/people/tags, recurring tasks, smart lists, review,
  Wrapped** — all pure Rust + React, no platform code.
- **Keybinding matching** — `meta` maps to Cmd on macOS and Win-key on Windows via Tauri;
  the in-app matcher checks `e.metaKey`/`e.ctrlKey` explicitly, so it works — but defaults and
  labels need a per-platform pass (see §2.3).
- **Tray icon, notifications, deep links (`annado://`), folder picker** — Tauri plugins handle
  Windows natively (deep-link registers the protocol in the registry; notifications use WinRT).

---

## 2. Windows port

### 2.1 Build blockers (must fix before it compiles)

1. **`src-tauri/src/calendar.rs`** links EventKit/Foundation unconditionally
   (`#[link(name = "EventKit", kind = "framework")]`, raw `objc_msgSend` FFI, `dispatch_semaphore_*`).
   This fails at link time on Windows.
   **Fix:** gate the whole module and its 5 commands (`get_calendars`, `get_calendar_events`,
   `check_calendar_access`, `open_calendar_at_date`, `delete_calendar_event`) behind
   `#[cfg(target_os = "macos")]`, and register them conditionally in `lib.rs`. Introduce a small
   `CalendarProvider` trait so other platforms can plug in later (§2.4).
2. **`objc2` / `block2` are unconditional dependencies** in `Cargo.toml`.
   **Fix:** move to a target-specific section:
   ```toml
   [target.'cfg(any(target_os = "macos", target_os = "ios"))'.dependencies]
   objc2 = "0.6"
   block2 = "0.6"
   ```
3. **`notify = { version = "7", features = ["macos_fsevent"] }`** — requesting a macOS-only
   feature on Windows breaks the build. **Fix:** same target-specific dependency pattern
   (Windows gets the default `ReadDirectoryChangesW` backend automatically).

### 2.2 Window chrome (the main "keep the design" item)

`tauri.conf.json` uses `"titleBarStyle": "Overlay"` + `"hiddenTitle": true`, which is
**macOS-only**. On Windows this silently falls back to a standard title bar — functional, but it
breaks the seamless sidebar-into-titlebar design.

Options, in order of recommendation:

1. **`tauri-plugin-decorum`** (community plugin): transparent/overlay titlebar on Windows while
   keeping native behavior incl. Windows 11 Snap Layouts. Closest match to the current design
   with the least code.
2. `decorations: false` + custom min/max/close buttons in React (e.g. `tauri-controls` for
   native-looking controls). Full control, but you own snap layouts, double-click-to-maximize, etc.
3. Accept the native Windows titlebar for v1 (zero work, ship faster).

Related frontend tweaks (small, all in one pass):

- `Sidebar.tsx:566` — the 48px "traffic light" spacer should render only on macOS. On Windows the
  window controls are top-*right*, so instead reserve right-side space in the top bar if using
  overlay mode. Add a tiny `platform.ts` util (`import { platform } from '@tauri-apps/plugin-os'`
  or `navigator.userAgent`) used by all conditional UI.
- The existing `data-tauri-drag-region` strip and `-webkit-app-region` CSS already work on
  Windows — no change.

### 2.3 UI/UX polish for Windows

- **Shortcut labels:** keybindings *work* (Tauri maps `meta` → Win key), but on Windows the
  conventional modifier is **Ctrl**. Recommended: make `KEYBINDING_DEFAULTS` platform-aware
  (`meta+1` on macOS → `ctrl+1` on Windows) and render `⌘`/`Ctrl` symbols per platform in the
  sidebar, tooltips, and the keybinding editor. Defaults like `meta+shift+space` for global
  quick-add become `ctrl+shift+space` (the Win key is reserved by the OS for many combos).
- **Copy fixes:** `NotificationSettings.tsx:127` says "macOS menu bar" — switch to
  "system tray" on Windows.
- **Fonts:** add `'Segoe UI Variable', 'Segoe UI'` to the stack after the Apple fonts in
  `App.css` so Windows gets its native UI font instead of falling through to Helvetica.
- **Filename safety:** project/person note creation should sanitize Windows-reserved names
  (`CON`, `NUL`, `COM1`…) and characters (`<>:"|?*`) — cheap insurance, also benefits
  cross-platform vaults synced between machines.
- All `-webkit-*` CSS is fine: Windows uses WebView2 (Chromium), which supports it.

### 2.4 Calendar integration on Windows (the long pole)

A 1:1 translation of the EventKit code does **not** exist on Windows:

- The WinRT `Windows.ApplicationModel.Appointments` API requires MSIX packaging with package
  identity **plus** the restricted `appointmentsSystem` capability, and its backing store (the
  old Windows Mail/Calendar app) was deprecated by Microsoft in favor of the new Outlook.
  Dead end for a normally-distributed app.

Realistic options:

| Route | User setup | Read/write | Effort | Notes |
|---|---|---|---|---|
| **ICS feed subscriptions (recommended v1)** | Paste secret/published calendar URL | Read-only | ~1–2 weeks | Google, Outlook, iCloud, Fastmail all expose ICS URLs. Pure-Rust provider (fetch, parse, cache, periodic refresh); no OAuth, no app registrations, no token storage. Works on *every* platform incl. iOS later. |
| CalDAV | Server URL + app-specific password | Read/write | ~2–3 weeks | One protocol covers iCloud, Fastmail, Nextcloud. Google's CalDAV endpoint still requires OAuth, so it doesn't avoid that. |
| Google Calendar API | Google sign-in (OAuth) | Read/write | ~2–3 weeks + Google app verification | Calendar scopes are "sensitive" — Google reviews the app before general users can authorize it. Needs secure token storage (`keyring`). |
| Microsoft Graph (Outlook) | Microsoft sign-in (OAuth) | Read/write | ~2–3 weeks | Azure app registration; covers personal + work/school accounts. Same token-storage needs. |
| No calendar on Windows v1 | — | — | 0 | Hide calendar settings/strips behind a capability check the frontend queries (`check_calendar_access` returning an "unsupported" state). |

**Recommendation: ICS subscriptions as the cross-platform v1 backend.** Rationale:

- It matches the app's actual calendar surface: Annado *displays* events in Upcoming/Agenda.
  The only write operation today is `delete_calendar_event` (minor affordance, EventKit-only);
  read-only covers ~90% of the feature for ~30% of the effort of any OAuth route.
- One Rust implementation serves Windows, macOS, Linux, and iOS. Each OAuth route serves one
  ecosystem and drags in token storage, consent screens, and (for Google) a verification queue.
- **It adds to macOS too:** the `CalendarProvider` trait merges sources, so Mac keeps native
  EventKit calendars *and* can overlay ICS subscriptions (e.g. a shared Google calendar)
  without adding them to Calendar.app. Settings UI lists both source types uniformly.

Implementation notes for the ICS provider:

- Parsing: `icalendar`/`ical` crate; the hard part is **recurrence expansion**
  (RRULE/EXDATE/RDATE + VTIMEZONE handling) — use the `rrule` crate and give it real test
  coverage (this is where ICS implementations typically break).
- Refresh: poll on an interval + on app focus; cache last-good response so Agenda still renders
  offline. Note in the settings UI that Google's secret ICS feeds update on a delay
  (minutes–hours) — "today's schedule", not live sync.
- Hide write affordances (event delete) for subscribed calendars; keep them for EventKit
  sources on macOS.
- Graph/Google OAuth become an optional v2 if users want write access or one-click sign-in —
  they slot in as additional `CalendarProvider` implementations without UI rework.

Ship Windows v1 with calendar gated off but the `CalendarProvider` trait in place, then add the
ICS provider as phase W4 (it also de-risks iOS, where EventKit works but Google-calendar users
still benefit from ICS sources).

### 2.5 Packaging, CI, distribution

- `tauri.conf.json` already lists `icons/icon.ico` and `"targets": "all"` — Tauri produces
  **NSIS (.exe) and MSI** installers out of the box. WebView2 is auto-bootstrapped by the
  installer on Windows 10/11.
- Add a GitHub Actions matrix build (`macos-latest`, `windows-latest`) using `tauri-action`;
  this also acts as a regression gate so macOS-only code can't sneak back in un-gated
  (`cargo check --target x86_64-pc-windows-msvc` in CI).
- **Code signing:** unsigned installers trigger SmartScreen warnings. Options: an OV/EV
  Authenticode cert (~$100–400/yr), or **Azure Trusted Signing** (cheap, automatable), or accept
  SmartScreen warnings for early builds.

### 2.6 Windows phases & rough estimates

| Phase | Work | Estimate |
|---|---|---|
| W1 — Compiles & runs | Cfg-gate calendar, fix Cargo deps, notify feature | 1–2 days |
| W2 — Looks right | Titlebar overlay (decorum), traffic-light spacer, fonts, shortcut labels/defaults, copy | 2–4 days |
| W3 — Ships | CI matrix, installers, signing, manual test pass (watcher, tray, global shortcuts, deep links, notifications on real Windows) | 2–3 days |
| W4 — Calendar parity | ICS subscription provider behind `CalendarProvider` trait (also adds ICS sources on macOS) | 1–2 weeks |
| W5 — Optional, later | Google Calendar / Microsoft Graph OAuth providers (write access, one-click sign-in) | 2–3 weeks each, on demand |

**Total: ~1–2 weeks to a polished calendar-less Windows build; +1–2 weeks for calendar.**

---

## 3. iOS/iPadOS port

### 3.1 Feasibility

Tauri 2 has first-class iOS support (`tauri ios init` / `tauri ios build` generates an Xcode
project; the Rust core compiles to an iOS static lib; UI renders in WKWebView). The React app,
parser, and task logic carry over unchanged. But four things are fundamentally different:

1. **Vault access (the hard one).** iOS apps are sandboxed; you can't point a file scanner at an
   arbitrary folder. The standard pattern (what Obsidian iOS itself does for external vaults) is
   `UIDocumentPickerViewController` for folder selection + a **security-scoped bookmark**
   persisted across launches. Tauri's dialog/fs plugins have known gaps here (folder picking and
   persistent security-scoped access), so expect a **small custom Swift plugin** (~200–400 lines)
   exposing: pick folder → store bookmark → resolve & `startAccessingSecurityScopedResource()` on
   launch. Vault on iCloud Drive works through this same mechanism (with file-coordination
   caveats). Alternative fallback: keep the vault inside the app's own Documents folder (visible
   in Files app, syncable via iCloud) — much simpler, but users with an existing Obsidian vault
   would need it in iCloud Drive anyway, so the bookmark approach is the one that preserves the
   product promise.
2. **File watching.** FSEvents-for-arbitrary-folders doesn't exist in the iOS sandbox. Replace the
   `notify` watcher with: full rescan on app foreground (`applicationDidBecomeActive`) + the
   existing mtime/hash-based incremental scan. Tasks are small markdown files; rescan is cheap.
3. **Desktop-only features need iOS equivalents** (to "keep all features" in spirit):
   - Global shortcuts → **iOS has none.** Map quick-add to: app shortcut (long-press icon),
     a **Share extension** ("send to Annado"), and/or a **widget** with a + button.
   - Tray popup → no tray on iOS. The closest equivalents: widget (today's tasks) and the
     quick-add share extension.
   - In-app keyboard shortcuts **do work on iPad with a hardware keyboard** (WKWebView delivers
     key events) — Cmd+1…9 view switching survives on iPad.
   - `open_file_in_editor` → "Open in Obsidian" via `obsidian://` URL scheme instead of VS Code.
4. **Calendar is surprisingly OK:** EventKit exists on iOS and `objc2`/`block2` compile for it.
   The existing FFI mostly carries over; needed changes: `NSColor`→`UIColor` in `color_to_hex`,
   replace `open -a Calendar` with the `calshow://` URL scheme, add
   `NSCalendarsFullAccessUsageDescription` to the iOS Info.plist.

### 3.2 Design adaptation (keep the design, adapt the ergonomics)

- The layout is desktop-first (persistent sidebar + list + side panel). On **iPad** it maps
  naturally (sidebar = split view); on **iPhone** the sidebar becomes a drawer/tab bar and the
  side panel becomes a sheet. Tailwind responsive classes get you most of the way.
- Touch: 44pt hit targets, no hover-revealed actions (audit hover-only affordances), safe-area
  insets (`env(safe-area-inset-*)`) replacing the traffic-light spacer.
- Drag & drop: `@dnd-kit` supports touch sensors — agenda drag-to-schedule survives, needs tuning
  (long-press to start drag, scroll vs drag disambiguation).
- Notifications: Tauri's notification plugin supports iOS; the 60s Rust scheduler only runs while
  the app is alive, so deadline reminders should move to **scheduled local notifications**
  (computed at app close/background) for parity.

### 3.3 Distribution

Apple Developer account ($99/yr), App Store review (a markdown task manager with
user-selected folder access is uncontroversial), TestFlight for beta. iPad and iPhone ship from
the same target with size classes.

### 3.4 iOS phases & rough estimates

| Phase | Work | Estimate |
|---|---|---|
| i1 — Boots on iPad | `tauri ios init`, gate desktop-only plugins (global-shortcut, tray), app icon/splash | 2–4 days |
| i2 — Vault access | Swift folder-picker + security-scoped bookmark plugin, foreground rescan instead of watcher | 1–2 weeks |
| i3 — Touch & layout | Responsive sidebar/panels, safe areas, touch targets, dnd tuning (iPad first, then iPhone) | 1–2 weeks |
| i4 — Feature mapping | Share extension / widget for quick-add, scheduled local notifications, EventKit-on-iOS fixes, Obsidian URL scheme | 1–2 weeks |
| i5 — Ship | TestFlight, App Store assets, review | 3–5 days + review time |

**Total: roughly 4–8 weeks, heavily front-loaded on the vault-access plugin.**

---

## 4. Recommended sequence

1. **W1–W3 now** — Windows build with calendar gated (small, mechanical, immediately useful).
   The `cfg`-gating work is *also* the prerequisite for iOS, since iOS needs the same
   desktop-only features (tray, global shortcuts) compiled out.
2. **W4** — cross-platform ICS calendar provider (pays off on Windows *and* iOS).
3. **iPad** — closest to the desktop experience (keyboard shortcuts, split view), validates the
   whole mobile pipeline with the least UI rework.
4. **iPhone** — the drawer/sheet layout pass on top of the iPad work.

## 5. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Tauri iOS folder-picker/bookmark gaps | High (known issues) | Custom Swift plugin (i2); prototype this *first* before committing to iOS |
| Windows overlay titlebar edge cases (snap layouts, maximize) | Medium | `tauri-plugin-decorum`; fall back to native titlebar |
| SmartScreen flags unsigned installer | Certain until signed | Azure Trusted Signing or Authenticode cert |
| iCloud Drive file-coordination quirks (partial writes during sync) | Medium | Existing hash/mtime checks already defend; add NSFileCoordinator in the Swift plugin if needed |
| App Store review friction | Low | Folder access via system picker is standard practice |
