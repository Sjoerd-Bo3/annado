# Annado — Feature Map & Product Specification

A complete reference of everything the app does, written as a PRD-style spec.
Compiled from a full source pass (branch with Windows + calendar + iOS work
included). Use it for onboarding, regression checklists, and as the baseline
when scoping new features.

**Product in one sentence:** a native-feeling task manager whose only database
is your own markdown files (designed for Obsidian vaults), with scheduling,
projects/people/tags, recurring tasks, calendar overlay, and analytics on top.

**Design principles observed throughout the code:**
- Markdown is the source of truth; every edit writes straight back to the file
  at the exact line. No sidecar database, no export step.
- Native conventions per platform (⌘ vs Ctrl, menu bar vs tray, overlay
  titlebars) with one shared React UI.
- Keyboard-first; everything reachable without the mouse.
- Bilingual natural-language dates (English + Dutch).

---

## 1. Platform support matrix

| Feature | macOS | Windows | iPad | iPhone |
|---|---|---|---|---|
| Task engine (all views, projects, people, tags, recurring, smart lists, review, Wrapped) | ✓ | ✓ | ✓ | ✓ |
| System calendars (EventKit) | ✓ | — | future | future |
| ICS calendar subscriptions | ✓ | ✓ | ✓ | ✓ |
| Tray / menu-bar popup | ✓ | ✓ | — | — |
| Global shortcuts | ✓ | ✓ | — (no-op) | — (no-op) |
| In-app shortcuts | ✓ ⌘ | ✓ Ctrl | ✓ ⌘ (hardware kb) | ✓ ⌘ |
| Deep links `annado://` | ✓ | ✓ | ✓ | ✓ |
| OS notifications | ✓ | ✓ | foreground only | foreground only |
| File watcher | FSEvents | ReadDirectoryChangesW | rescan on foreground | rescan on foreground |
| Window chrome | native overlay titlebar | decorum overlay (Snap Layouts kept) | safe-area insets | safe-area insets + drawer/sheet layout |
| Editor integration (VS Code/custom) | ✓ | ✓ | Obsidian URL only | Obsidian URL only |

Platform detection lives in `src/utils/platform.ts` (`isMac`, `isWindows`,
`isIOS` incl. iPad-UA disambiguation via `maxTouchPoints`, `isDesktop`,
`PRIMARY_MOD`).

---

## 2. Data model & markdown format

### 2.1 Task line syntax

```markdown
- [ ] Title @when(...) @due(...) [[Project]] [[Person]] !(1) @time(09:00) @duration(1h30m) #tag @recurring(id) @created(date) @completed(date)
    Indented notes (4+ spaces), multiple lines preserved
    - [ ] Checklist sub-item
    - [x] Done sub-item
```

`- [ ]` / `- [x]` (case-insensitive `x`). Annotations are order-independent,
all optional, parsed out of the displayed title. Wikilinks stay in the title.

| Annotation | Values | Notes |
|---|---|---|
| `@when(...)` | `today`, `evening`, `tomorrow`, `anytime`, `someday`, `YYYY-MM-DD`; absent = inbox | `today`/`tomorrow` are normalized to concrete dates on write so they don't drift |
| `@due(YYYY-MM-DD)` | ISO date | deadline; independent of `@when` |
| `@time(HH:MM)` | 24h time | agenda time-blocking |
| `@duration(...)` | `15m`, `1h`, `1h30m`, … | stored as minutes |
| `!(1)`/`!(2)`/`!(3)` | 1=high, 2=med, 3=low | priority |
| `#tag` | `\w+` | extracted from title; deduplicated |
| `[[Name]]` | project or person | resolved by which folder the name's file lives in; case-sensitive exact match; multiple allowed |
| `@recurring(id)` | 12-hex template id | links instance → template |
| `@created(date)` | ISO date | auto-stamped ~2s after a new task appears (debounced for live Obsidian editing) |
| `@completed(date)` | ISO date | auto-stamped when checked |

Notes = lines indented 4+ spaces that aren't checklist items; replaced in full
on edit (checklists preserved). Checklist items have no annotations.

### 2.2 Identity & write-back
- Task ID = first 8 bytes of SHA-256 of `file_path:line_number` (16-hex).
  Stable while a task stays at its file+line; moving = new identity.
- Writes preserve field order, indentation, and surrounding content; only the
  task line + its notes block change.

### 2.3 Vault scanning & watching
- Scans every `.md` recursively, skipping: dot-files/folders, the
  recurring-templates folder, `excluded_paths` (trailing `/` = folder),
  frontmatter `annado_exclude: true`, `.md.lock` files.
- Watcher debounces 250 ms, re-parses only changed files; folder-level events
  trigger a full rescan. New unchecked→checked transitions stamp
  `@completed(today)` immediately.
- iOS: no watcher; full rescan when the app returns to the foreground.

### 2.4 Projects, areas, people
- **Projects** = `.md` files under the Projects folder (pattern-matched name,
  default `Projects`); nesting via folders and/or frontmatter `up:` (parent).
  Frontmatter metadata (with aliases): `description`/`desc`/`summary`,
  `date_deadline`/`due`/`due_date`, `date_start`/`start`/…, `ranking`/`rank`/
  `priority`, `persons`/`people`/`assigned`, `up`, `milestones[]`
  (`name`,`start`,`end`,`completed`). Body's first paragraph is the
  description fallback.
- **Areas**: tasks without an explicit `[[Project]]` inside `Areas/<Name>/...`
  group under that area name.
- **People** = `.md` files under the Persons folder. Frontmatter:
  `organisation`/`org`/`company`, `relationship`/`relation`/`type`,
  `languages`, `projects` (wikilinks cleaned).

### 2.5 Recurring tasks
Templates live as markdown files (default `12. System/recurring-tasks/`) with
frontmatter: `recurrence_type` (`fixed` | `after_completion`), `interval`,
`interval_unit` (`days|weeks|months|years`), optional `start_date`,
`last_generated`, `last_completed`, `template_id` (12-hex),
`annado_exclude: true`; body = the task line + notes copied into each
instance.
- `fixed`: new instance every N units regardless of completion.
- `after_completion`: next instance N units after the previous was completed.
- First instance is generated atomically at template creation; generation
  dedupes against existing uncompleted instances. Instances carry
  `@recurring(template_id)`; completing one updates the template's
  `last_completed`.

### 2.6 Daily notes
Configurable folder + moment-style format (`YYYY/MM-MMMM/YYYY-MM-DD`; `/`
creates subfolders). If the vault is an Obsidian vault,
`.obsidian/daily-notes.json` overrides folder/format. New tasks created in the
app are appended under the daily note's `## Tasks` heading.

### 2.7 Backend config (`config.json` in the platform app-config dir)
`vaultPath`, `isObsidianVault` (auto-detected from `.obsidian/`),
`folderPaths` (recurringTemplates, projectsPattern, areasPattern,
personsPattern, dailyNotesFolder, dailyNotesFormat), `excludedPaths[]`,
`editorType` + `editorCustomCommand`, `icsSubscriptions[]`. Legacy
`vault_path.txt` migrates automatically.

---

## 3. Views (12)

All views exclude completed tasks unless noted. Selecting a project/person/tag
overrides the view filter entirely (shows that entity's open tasks, flat).

| View | Default key | Filter | Grouping |
|---|---|---|---|
| Inbox | mod+1 | `when=inbox` AND no projects | by project (flat when filtered) |
| Today | mod+2 | `when ∈ {today, evening}` OR dated `when ≤ today` OR `deadline ≤ today` | day section, then **Evening** section (moon divider); project groups inside |
| Agenda | mod+3 | scheduled/dated tasks + calendar events on a time grid | day/week timeline |
| Upcoming | mod+4 | `when=tomorrow` OR dated `when > today` OR `deadline > today` | 60 day sections with month labels; deadline badges on top (this week / next 2 weeks / future) |
| Anytime | mod+5 | `when=anytime` | by project |
| Someday | mod+6 | `when=someday` | by project |
| Logbook | mod+7 | completed only | by completion date, newest first ("Today"/"Yesterday"/date/"Earlier"); paginated ×100 |
| Recurring | mod+8 | recurring templates (not tasks) | list with "Every N units" labels, start/last dates |
| Wrapped | mod+9 | analytics slides (see §8) | — |
| Added Today | mod+0 | `createdDate = today` | by project |
| Review | mod+R | guided 5-step workflow (see §7) | card stack |
| Smart Lists | sidebar | user-defined compound filter | by project |

Within groups, tasks sort by date urgency (overdue → today → future → none).
Calendar events render at the top of Today and inside Upcoming's day sections
(all-day first, then by time; collapsed past 6 with "X more").

**Smart list filter model:** optional `baseView` (inbox/today/upcoming/
anytime/someday), `priority`, `hasDeadline`, `minAgeDays`, `projects[]` (OR),
`person`, `tag`, `dueWithin {amount, unit}`. Stored per vault
(`smartLists:{vaultPath}`), with an emoji icon (8 options).

---

## 4. Navigation

### Sidebar
Nav items with configurable count badges; collapsible **People**, **Tags**,
and **Smart Lists** sections (counts, color pickers, rename/delete context
menus, + buttons); a hierarchical **projects/areas tree** (chevrons, expanded
state persisted, drag-to-reorder, per-project color from a 15/20-color
palette, "New Subproject"). Resizable 200–400 px (persisted). On phone widths
it becomes an overlay drawer (hamburger button, backdrop, auto-close on
navigation).

### Quick Find (`mod+F`, plus type-anywhere in list views)
Sections: recent items (≤20, persisted) when query is empty; priority search
(`!`, `!!`, `!!!`); views; projects (name/description); people; tags; tasks
(title/notes/tags, open only). Arrow keys / Enter / Escape. Selecting a task
jumps to its natural view, scrolls to it, and expands it.

### Side panel (`mod+\`)
A second, independent task list (own view selector: Today/Inbox/Upcoming/
Anytime/Someday/Logbook; own selection/expansion state) docked right,
resizable 280–600 px (persisted), with cross-panel drag & drop. Full-screen
sheet on phone widths.

---

## 5. Task editing & interactions

### Task item
- **Collapsed:** checkbox · when-pill (hidden where redundant) · duration ·
  title with clickable wikilinks · tags · notes/checklist indicators · project
  · deadline countdown (red when overdue). Click = select
  (mod+click multi-select), double-click/Enter = expand.
- **Expanded:** title input with `[[` autocomplete (people + projects),
  markdown notes (click-to-edit textarea, wikilinks clickable; `- [ ]` lines
  in notes convert to checklist items), tag editor (Enter/Tab/comma adds,
  Backspace removes last, suggestions with colors), checklist (toggle, inline
  rename, delete, rapid-entry subtask row), and a toolbar: When, Deadline,
  Project, Priority (!/!!/!!!), Duration, Add-subtask, plus "Open in
  Obsidian/editor". Click-outside saves and collapses.
- **Completion:** checkbox pop + fade/slide-out animation; `@completed` stamp;
  un-completable from Logbook.
- **Date hints while typing:** the title is scanned for natural-language
  dates ("friday", "volgende week", "in 3 days"); deadline prefixes ("by",
  "due", "voor", "uiterlijk") produce deadline hints. A banner offers
  Accept (applies + strips the phrase) / Dismiss (remembered per phrase).

### Quick Add
Opened by mod+N, the global shortcut, the tray, or a deep link (prefill:
title/notes/when/project). Same field set as the expanded editor incl. tags,
subtask row, and date hints; `!(N)` suffix in the title sets priority. Default
`when` follows the current view.

### Pickers
When/Deadline pickers render in portals: free-text input with bilingual
parsing + ranked suggestions, quick chips (Today, Tomorrow, This Weekend,
Next Week; When adds Anytime/Someday), optional month calendar, "No deadline"
clear. Duration picker: presets 15/30/45/60/90/120 + custom.

**Natural-language dates (EN + NL,** `src/utils/dateParser.ts` +
`src/config/locales.ts`**):** symbolic (today/vandaag, tonight/vanavond,
tomorrow/morgen, day after tomorrow/overmorgen, anytime/altijd, ooit),
relative (this/next weekend, next week/volgende week, end of week/month,
`in 3 days`/`over drie dagen` with spelled numbers to twelve), weekdays (full
+ short, prefix-matched in pickers, exact in free text), explicit dates (ISO,
`25-12`, `25/12/2026`, `feb 14`, `15 maart 2027`; past dates roll forward).

### Multi-select & bulk bar
2+ selected → floating bottom bar: count, When dropdown, Project dropdown,
Deadline picker, Complete, Cancel.

### Drag & drop
Pointer (8 px threshold) + touch (250 ms long-press) sensors. Targets: view
nav (sets `when`), sidebar projects (assigns project), Upcoming day sections
(sets date), agenda time slots (sets date+time, rejects overlaps), agenda
unscheduled zone (clears time). Cross-panel drops supported.

### Undo
LIFO stack of 50 inverse task mutations (create/update/delete/complete/bulk);
`mod+Z`; in-memory only.

---

## 6. Agenda & auto-scheduling

- **Day/Week modes**; 06:00–22:00 grid, 15-min snap; "now" line + auto-scroll
  on today; week view 5/7 days (weekend toggle), week start configurable.
  Keyboard: `T` today, `←/→` day, `Shift+←/→` week.
- **Block types:** `task-pinned` (user-placed; draggable + bottom-edge resize,
  min 15 min), `task-auto` (auto-scheduled into free gaps), `event` (calendar;
  tinted with calendar color; 50% opacity when non-blocking), `schedule`
  (work-hours/breaks, visual only).
- **Auto-scheduling:** occupied time = pinned tasks + blocking events + breaks
  + outside work hours; remaining tasks (deadline-holders, then dated, then
  anytime) sorted by priority then duration are fitted into the earliest gaps
  on the 15-min grid; non-fitting tasks land in the Unscheduled section.
- **Context menu on blocks:** tasks — remove time / complete; events — Create
  task (mod+T), Mark (non-)blocking (mod+B), Reset to calendar default, Edit
  event (mod+E, opens Calendar.app — hidden for read-only ICS events), Delete
  (Backspace — hidden for read-only).
- **Work schedule:** per-day on/off + start/end times (default Mon–Fri
  09:00–17:00) and named breaks with day masks — both block auto-scheduling.

---

## 7. Review (weekly workflow)

Card-stack UI, number keys 1–4 for actions, per-step progress bar, per-step
accent colors, Skip on every step, toast + undo:

1. **Process your inbox** — schedule / complete / park (anytime) / delete.
2. **Handle overdue tasks** — same actions, red accent.
3. **Review stalled tasks** (untouched 14+ days) — same actions, amber.
4. **Quiet projects** (no recent activity) — add task / archive / skip, teal.
5. **Coming up next week** — looks good / adjust deadline / needs work, blue.

`mod+K` completes the current card; `O` opens it in the editor.

---

## 8. Wrapped (year/month/week in review)

Periods: week / month / year with back-navigation. Slides: intro (animated
completed count, created, delta, completion rate) → productivity personality
(streaks, projects, high-priority counts) → GitHub-style heatmap → top
projects bar chart → task-age distribution → this-vs-last comparison →
day-of-week rhythm → priority breakdown → unfinished list → look-ahead →
outro. Falls back to a "no data" slide with insufficient history.

---

## 9. Calendar integration

Two sources behind one `CalendarProvider` seam, merged by the backend:

1. **EventKit (macOS):** system calendars after a permission prompt; read +
   delete; calendar colors from NSColor; all-day events as local
   `YYYY-MM-DD`, timed as ISO UTC.
2. **ICS subscriptions (all platforms):** read-only feeds by URL
   (`https://`/`webcal://`; Google secret address, Outlook published, iCloud
   public). RFC 5545 parsing with RRULE/EXDATE/RDATE expansion (DST-correct,
   IANA + Microsoft timezone names), RECURRENCE-ID overrides, CANCELLED
   skipping; 4-min cache with stale-on-offline; 10 MB cap.

Per-calendar (either source): visibility checkbox and a **Blocks** toggle
(busy time for auto-scheduling; default on) + per-event overrides. Events
show in Today (top strip), Upcoming (day sections), and Agenda (blocks);
read-only events hide edit/delete affordances. Frontend refreshes every 5
minutes and on enable.

---

## 10. Notifications & tray

**Scheduler** (Rust thread, 60 s tick, dedup key `taskId:date:kind`, runs in
foreground on mobile):
- Morning of deadline — default on, 09:00 ("Deadline Today").
- Evening before — default on, 18:00 ("Deadline Tomorrow").
- Daily overdue — default on, 08:00 ("Overdue Task: title (due date)").
- Launch banner (in-app summary) — default on.
Master toggle + test-notification button. Prefs in
`notification_prefs.json`.

**Tray / menu-bar popup** (320×480 frameless, always-on-top, hides on blur;
toggle via icon click; popup opens below the cursor on macOS, above near the
taskbar on Windows): quick-add input ("Add task for today…"), Deadlines
section (next 14 days, color-coded countdowns), Today section, expandable
rows (notes, when selector, deadline date input, "Open in Annado" which
navigates the main window to the task). Tray icon visibility is a setting.

---

## 11. Global shortcuts & deep links

- **Global Quick Add** default `mod+shift+space`, **Show App** default
  `mod+shift+a`; both customizable, re-registered live on change, validated
  with fallback to defaults; no-ops on mobile.
- **Deep link** `annado://quickadd?title=&notes=&when=&project=` (params ≤
  1000 chars) opens Quick Add prefilled; cold-start URLs are held in a
  pending slot and re-checked after startup.

---

## 12. Settings reference (defaults in parentheses)

**General:** vault picker · Obsidian-vault toggle (auto-detected) · external
editor: System/VS Code/Custom with `{file}`/`{line}` tokens (System) · theme
Light/Dark/System (System) · accent color, 20 swatches (#5C6BC0 indigo) ·
default task duration 15/30/45/60/120 (30 m) · confirm-before-delete (on) ·
sidebar count toggles · excluded paths (writes `annado_exclude` frontmatter) ·
six folder-path settings (see §2.7).

**Calendar:** week starts Monday/Sunday (Monday) · show weekends (on) · show
calendar events (off; EventKit permission flow where supported) · per-calendar
visibility + Blocks toggles · ICS subscriptions add/remove · work schedule
days/hours (Mon–Fri 9–17) · breaks (name, time range, day mask).

**Shortcuts:** fixed-shortcut reference (platform-correct symbols) + 24
customizable bindings with per-row reset and reset-all.

**Notifications:** tray icon toggle (on; "Menu Bar" on macOS / "System Tray"
elsewhere) · master toggle (on) · three deadline reminders with time pickers ·
launch banner · send-test button.

**About:** app version from `tauri.conf.json`.

---

## 13. Keyboard shortcuts (defaults; `mod` = ⌘ on macOS/iPad, Ctrl on Windows/Linux)

| Action | Binding | | Action | Binding |
|---|---|---|---|---|
| Quick Add | mod+N | | Complete task | mod+K |
| Global Quick Add | mod+shift+space | | Delete task | mod+backspace |
| Show app (global) | mod+shift+A | | When picker | mod+S |
| Quick Find | mod+F | | Deadline picker | mod+D |
| New recurring | mod+shift+R | | Start today | mod+T |
| Move to project | mod+shift+M | | Toggle side panel | mod+\ |
| Undo | mod+Z | | Settings | mod+, |
| Navigate down/up | ctrl+J/K (mac-style) or alt+J/K | | Views | mod+1…0, mod+R |
| Multi-select | mod+click | | Expand/collapse | Enter |
| Agenda today / day / week | T, ←→, shift+←→ | | Review actions | 1–4, mod+K, O |

All "customizable" bindings live in localStorage (`keybindings`) and are
edited via a record-keystroke widget; allowed keys: letters, digits, space,
enter, escape, backspace, tab + any modifier combo.

---

## 14. Theming & error handling

- Dark mode via `.dark` class (Light/Dark/System with media-query listener);
  window background color synced to avoid resize flash. Accent color drives
  `--color-primary` (+ derived dark/light variants) across checkboxes, links,
  selections, dots.
- Errors surface as a bottom-right toast (auto-dismiss 4 s, closable);
  destructive actions go through a confirm modal when confirm-delete is on;
  task mutations are undoable (§5).

---

## 15. Storage map

| Where | What |
|---|---|
| Markdown vault | tasks, notes, checklists, projects, people, recurring templates, daily notes — the only task data store |
| `config.json` (app config dir) | vault path, folder patterns, exclusions, editor, ICS subscriptions |
| `notification_prefs.json` | tray + notification preferences |
| localStorage | theme, accent, keybindings, confirm-delete, sidebar widths/counts/colors/order, expanded folders, recent items, side-panel state, calendar enablement/visibility/blocking, smart lists (per vault), work schedule |
| In-memory only | undo stack, ICS feed cache, notification dedup set |

---

## 16. Known gaps / roadmap pointers

Tracked in `docs/porting-plan.md` and `docs/ios.md`:
- iOS external Obsidian vaults (security-scoped bookmark Swift plugin),
  iCloud entitlement for the default vault, scheduled (background) local
  notifications, EventKit on iOS, share extension / widget.
- Optional OAuth calendar providers (Google API, Microsoft Graph) behind the
  existing provider seam; ICS subscription custom colors.
- Release engineering: a `release.yml` workflow builds macOS/Windows/Linux
  installers on tags and on demand (see `docs/builds.md`); still to do is code
  signing (Apple notarization, Windows Authenticode / Azure Trusted Signing).
