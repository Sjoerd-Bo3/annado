# Annado on iOS / iPadOS

Status of the mobile port and how to build it. The codebase is mobile-ready
(desktop-only features compile out, touch/safe-area support is in), but the
Xcode project itself is generated on a Mac and the result has **not yet been
verified on a device** — treat the first device build as a validation pass.

## What works on iOS

- The full task engine: markdown scanning/parsing, all 12 views, projects,
  people, tags, recurring tasks, smart lists, review, Wrapped.
- **Vault in the Files app**: on iOS the vault lives in the app's Documents
  folder (`On My iPad/iPhone › Annado`), created via the "Create Vault in
  Files App" button. Files there are editable by other apps and survive
  app updates.
- **Calendar via ICS subscriptions** (cross-platform provider).
- **Deep links** (`annado://quickadd?...`) — handler runs on mobile; see the
  Info.plist note below.
- **Notifications** while the app is running (the scheduler runs in
  foreground; see follow-ups for background delivery).
- **Touch**: long-press (250 ms) to drag in lists and the agenda, hit
  targets enlarged via `pointer: coarse` media queries, hover-revealed
  controls always visible, safe-area insets respected
  (`viewport-fit=cover`).
- **iPad hardware keyboards**: ⌘-based shortcuts work (the platform layer
  treats iOS like macOS for the primary modifier).
- Instead of a file watcher (suspended in the iOS sandbox), the app rescans
  the vault every time it returns to the foreground.

## What is intentionally not on iOS

- Global shortcuts and the tray popup (no OS equivalent; the
  `register_global_shortcuts` command is a no-op on mobile).
- The EventKit system-calendar integration (currently macOS-only; the FFI
  would largely carry over but needs UIColor/calshow:// changes and on-device
  testing — see follow-ups).

## Building (requires a Mac with Xcode)

```bash
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
npm install
npm run tauri ios init     # generates src-tauri/gen/apple (Xcode project)
npm run tauri ios dev      # simulator
npm run tauri ios build    # device/.ipa (configure signing team first)
```

After `ios init`, add to the generated `Info.plist`:

- `CFBundleURLTypes` with the `annado` scheme (deep links).
- `UIFileSharingEnabled` + `LSSupportsOpeningDocumentsInPlace` set to `true`
  so the Documents vault shows up in the Files app.

## Follow-ups (in rough priority order)

1. **External Obsidian vaults** — the headline feature for power users.
   Requires a small Swift plugin: `UIDocumentPickerViewController` in folder
   mode → persist a security-scoped bookmark → resolve +
   `startAccessingSecurityScopedResource()` on launch. Tauri's dialog plugin
   does not handle persistent security scope today. Until then, users can
   point Obsidian iOS at the Annado folder (Obsidian supports vaults in
   other apps' folders via the Files app).
2. **iCloud sync for the default vault** — add the iCloud Documents
   entitlement and container so `Annado/` syncs across devices.
3. **Scheduled local notifications** — compute deadline reminders and
   schedule them via the notification plugin when the app backgrounds, so
   they fire without the app open.
4. **EventKit on iOS** — port `calendar/eventkit.rs` (UIColor instead of
   NSColor/CIColor, `calshow://` instead of `open -a Calendar`, iOS
   permission strings).
5. **Share extension / widget** for quick-add from anywhere.

## iPhone

The iPad layout reuses the desktop split view. iPhone-width layouts
(sidebar as drawer, side panel as sheet) are a separate pass — see the
`claude/iphone-support` branch.
