import {
  type App,
  type Hotkey,
  type Modifier,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
} from 'obsidian';
import { setBackend } from '@app/backend';
import { setForcedNarrow } from '@app/hooks/useIsNarrow';
import { useTaskStore } from '@app/stores/taskStore';
import { KEYBINDING_DEFAULTS } from '@app/utils/keybindings';
import type { ViewType } from '@app/types/task';
import { AnnadoView, VIEW_TYPE_ANNADO } from './AnnadoView';
import { ObsidianBackend, type AnnadoData } from './ObsidianBackend';
import { initCore } from './core';

/** One actionable command we expose to Obsidian's command palette + hotkeys. */
interface AnnadoCommand {
  id: string;
  name: string;
  /** Keybinding-defaults key, used to derive a sensible default hotkey. */
  bindingKey?: keyof typeof KEYBINDING_DEFAULTS;
  /** What the command does once Annado is open + focused. */
  run: () => void;
}

/** A deadline check runs at most this often (ms) — hourly. */
const REMINDER_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The Annado Obsidian plugin entry point.
 *
 * On load it instantiates the Rust→WASM core, injects an {@link ObsidianBackend}
 * into the shared UI's platform seam (`setBackend`), registers a main-area leaf
 * that mounts the shared React `App`, exposes a ribbon icon + commands, and adds
 * a settings tab. The backend routes data commands to the WASM core / Vault API.
 *
 * Desktop-only integrations from the Tauri build are replaced here:
 *  - Global shortcuts → Obsidian commands with default hotkeys (Obsidian-scoped;
 *    true OS-global shortcuts are not available to a plugin).
 *  - Notifications → `new Notice(...)`; a deadline-reminder tick is scheduled via
 *    `registerInterval`. Background/OS-level delivery is NOT available in-plugin.
 *  - Tray / separate windows → no-ops (Obsidian has no app tray or extra windows).
 */
export default class AnnadoPlugin extends Plugin {
  private backend!: ObsidianBackend;

  async onload(): Promise<void> {
    // Instantiate the WASM engine before anything calls into it (it's bundled
    // as inlined bytes, so this is synchronous and offline-safe).
    initCore();

    // Swap the UI's platform/data boundary over to Obsidian before any view mounts.
    this.backend = new ObsidianBackend(this.app, this);
    setBackend(this.backend);

    // On a phone the shared UI should use its narrow (drawer/sheet) layout even
    // though an Obsidian leaf can be wider than the width breakpoint. Obsidian's
    // `Platform.isPhone` is authoritative here; feed it through the host-agnostic
    // seam so `src/` never has to import `obsidian`.
    setForcedNarrow(Platform.isPhone);

    this.registerView(VIEW_TYPE_ANNADO, (leaf) => new AnnadoView(leaf));

    this.addRibbonIcon('check-circle', 'Open Annado', () => {
      void this.activateView();
    });

    this.addCommand({
      id: 'open-annado',
      name: 'Open Annado',
      callback: () => {
        void this.activateView();
      },
    });

    this.registerAnnadoCommands();
    this.addSettingTab(new AnnadoSettingTab(this.app, this, this.backend));
    this.scheduleDeadlineReminders();
  }

  onunload(): void {
    // Detaching the leaves triggers AnnadoView.onClose(), which unmounts React
    // and (via the store's effect cleanup) detaches the vault listeners.
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_ANNADO);
    // Belt-and-suspenders: force-detach any vault listeners / pending timers the
    // backend still holds, so nothing outlives the plugin if a leaf was detached
    // without a clean React unmount. The reminder interval is registered via
    // `registerInterval`, so Obsidian clears that one automatically.
    this.backend.teardown();
  }

  /**
   * Reveal an existing Annado leaf, or open a new one in the main editor area
   * (a full-width tab — per the architecture analysis, not the narrow sidebar).
   */
  async activateView(): Promise<void> {
    const { workspace } = this.app;

    const existing = workspace.getLeavesOfType(VIEW_TYPE_ANNADO);
    let leaf: WorkspaceLeaf | null = existing[0] ?? null;

    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE_ANNADO, active: true });
    }

    workspace.revealLeaf(leaf);
  }

  /**
   * Register Annado's customizable actions as Obsidian commands. Obsidian owns
   * the hotkey registry (and its settings UI lets the user rebind them), so we
   * supply defaults derived from Annado's own keybinding map. These mirror the
   * actions the in-app keyboard handler dispatches — including the two that were
   * OS-global under Tauri (`globalQuickAdd`/`globalShowApp`), now Obsidian-scoped.
   *
   * Each command ensures Annado is open, then dispatches into the shared Zustand
   * store (the same singleton the React view uses, since esbuild bundles it once).
   */
  private registerAnnadoCommands(): void {
    const open = () => void this.activateView();
    const commands: AnnadoCommand[] = [
      {
        id: 'quick-add',
        name: 'Quick add task',
        bindingKey: 'globalQuickAdd',
        run: () => useTaskStore.getState().openQuickAdd(),
      },
      {
        id: 'show-app',
        name: 'Show Annado',
        bindingKey: 'globalShowApp',
        run: () => {},
      },
      { id: 'view-inbox', name: 'Go to Inbox', bindingKey: 'viewInbox', run: () => this.goToView('inbox') },
      { id: 'view-today', name: 'Go to Today', bindingKey: 'viewToday', run: () => this.goToView('today') },
      { id: 'view-agenda', name: 'Go to Agenda', bindingKey: 'viewAgenda', run: () => this.goToView('agenda') },
      { id: 'view-upcoming', name: 'Go to Upcoming', bindingKey: 'viewUpcoming', run: () => this.goToView('upcoming') },
      { id: 'view-anytime', name: 'Go to Anytime', bindingKey: 'viewAnytime', run: () => this.goToView('anytime') },
      { id: 'view-someday', name: 'Go to Someday', bindingKey: 'viewSomeday', run: () => this.goToView('someday') },
      { id: 'view-logbook', name: 'Go to Logbook', bindingKey: 'viewLogbook', run: () => this.goToView('logbook') },
      { id: 'view-recurring', name: 'Go to Recurring', bindingKey: 'viewRecurring', run: () => this.goToView('recurring') },
      { id: 'view-review', name: 'Go to Review', bindingKey: 'viewReview', run: () => this.goToView('review') },
    ];

    for (const cmd of commands) {
      const hotkeys = cmd.bindingKey ? toHotkeys(KEYBINDING_DEFAULTS[cmd.bindingKey]) : undefined;
      this.addCommand({
        id: cmd.id,
        name: cmd.name,
        ...(hotkeys ? { hotkeys } : {}),
        callback: () => {
          open();
          // Defer so a freshly created leaf has mounted the store-backed view.
          window.setTimeout(() => cmd.run(), 0);
        },
      });
    }
  }

  private goToView(view: ViewType): void {
    const state = useTaskStore.getState();
    state.setSelectedProject(null);
    state.setCurrentView(view);
  }

  /**
   * Schedule a periodic deadline-reminder tick. Obsidian plugins cannot deliver
   * background/OS notifications (the process only runs while Obsidian is open),
   * so this surfaces an in-app `Notice` for tasks due today while the app runs.
   */
  private scheduleDeadlineReminders(): void {
    const tick = () => {
      const { tasks } = useTaskStore.getState();
      if (!Array.isArray(tasks) || tasks.length === 0) return;
      const today = todayStr();
      const due = tasks.filter((t) => !t.completed && t.deadline === today);
      if (due.length > 0) {
        new Notice(
          `Annado: ${due.length} task${due.length === 1 ? '' : 's'} due today`,
          8000,
        );
      }
    };
    this.registerInterval(window.setInterval(tick, REMINDER_INTERVAL_MS));
  }
}

/** Local `YYYY-MM-DD` for "today". */
function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Convert an Annado keybinding string (e.g. `meta+shift+space`) into Obsidian's
 * {@link Hotkey} shape. `meta`/`ctrl` map to `Mod` so Obsidian picks the right
 * platform modifier; returns `undefined` for anything it can't parse cleanly.
 */
function toHotkeys(binding: string | undefined): Hotkey[] | undefined {
  if (!binding) return undefined;
  const parts = binding.toLowerCase().split('+');
  const rawKey = parts.pop();
  if (!rawKey) return undefined;

  const modifiers: Modifier[] = [];
  for (const part of parts) {
    if (part === 'meta' || part === 'ctrl') modifiers.push('Mod');
    else if (part === 'shift') modifiers.push('Shift');
    else if (part === 'alt') modifiers.push('Alt');
    else return undefined;
  }

  const keyMap: Record<string, string> = {
    space: ' ',
    backspace: 'Backspace',
    '\\': '\\',
  };
  const key = keyMap[rawKey] ?? rawKey;
  return [{ modifiers, key }];
}

/**
 * Settings tab exposing the key Annado settings backed by loadData/saveData:
 * folder paths, excluded paths, the ICS-calendar toggle, and ICS subscriptions.
 */
class AnnadoSettingTab extends PluginSettingTab {
  private backend: ObsidianBackend;

  constructor(app: App, plugin: Plugin, backend: ObsidianBackend) {
    super(app, plugin);
    this.backend = backend;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    void this.render(containerEl);
  }

  private async render(containerEl: HTMLElement): Promise<void> {
    const data = await this.backend.readSettings();
    const defaults = ObsidianBackend.defaultFolderPaths();
    const folders = { ...defaults, ...(data.folderPaths ?? {}) };

    containerEl.createEl('h2', { text: 'Folder paths' });

    const folderFields: Array<[keyof typeof defaults, string, string]> = [
      ['projectsPattern', 'Projects folder', 'Folder (name match) holding project notes.'],
      ['areasPattern', 'Areas folder', 'Folder (name match) holding area notes.'],
      ['personsPattern', 'Persons folder', 'Folder (name match) holding person notes.'],
      ['dailyNotesFolder', 'Daily notes folder', 'Where daily task notes are created.'],
      ['dailyNotesFormat', 'Daily notes format', 'Moment-style path format for daily notes.'],
      ['recurringTemplates', 'Recurring templates folder', 'Folder holding recurring-task templates.'],
    ];

    for (const [key, name, desc] of folderFields) {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((text) =>
          text
            .setPlaceholder(defaults[key])
            .setValue(folders[key] ?? '')
            .onChange(async (value) => {
              const next = { ...folders, [key]: value };
              await this.backend.writeSettings({ folderPaths: next });
            }),
        );
    }

    containerEl.createEl('h2', { text: 'Excluded paths' });
    new Setting(containerEl)
      .setName('Excluded paths')
      .setDesc('Files/folders to skip when scanning for tasks. One per line.')
      .addTextArea((area) => {
        area
          .setPlaceholder('Archive/\nPrivate/secret.md')
          .setValue((data.excludedPaths ?? []).join('\n'))
          .onChange(async (value) => {
            const excludedPaths = value
              .split('\n')
              .map((p) => p.trim())
              .filter((p) => p.length > 0);
            await this.backend.writeSettings({ excludedPaths });
          });
        area.inputEl.rows = 4;
      });

    containerEl.createEl('h2', { text: 'Calendar' });
    new Setting(containerEl)
      .setName('Enable ICS calendars')
      .setDesc('Surface ICS subscription calendars and events in the agenda.')
      .addToggle((toggle) =>
        toggle.setValue(data.calendarEnabled !== false).onChange(async (value) => {
          await this.backend.writeSettings({ calendarEnabled: value });
        }),
      );

    containerEl.createEl('h2', { text: 'ICS subscriptions' });
    const subs = data.icsSubscriptions ?? [];
    if (subs.length === 0) {
      containerEl.createEl('p', {
        text: 'No subscriptions yet. Add one below (or from the in-app calendar settings).',
      });
    }
    for (const sub of subs) {
      new Setting(containerEl)
        .setName(sub.name)
        .setDesc(sub.url)
        .addButton((btn) =>
          btn
            .setButtonText('Remove')
            .setWarning()
            .onClick(async () => {
              const next = subs.filter((s) => s.id !== sub.id);
              await this.backend.writeSettings({ icsSubscriptions: next });
              this.display();
            }),
        );
    }

    let newName = '';
    let newUrl = '';
    new Setting(containerEl)
      .setName('Add ICS subscription')
      .addText((text) =>
        text.setPlaceholder('Name').onChange((value) => {
          newName = value;
        }),
      )
      .addText((text) =>
        text.setPlaceholder('https://…/calendar.ics').onChange((value) => {
          newUrl = value;
        }),
      )
      .addButton((btn) =>
        btn
          .setButtonText('Add')
          .setCta()
          .onClick(async () => {
            const name = newName.trim();
            const url = newUrl.trim();
            if (!name || !url) {
              new Notice('Annado: subscription needs a name and a URL');
              return;
            }
            const sub = { id: generateId(), name, url, color: '#4a90d9' };
            const next: AnnadoData['icsSubscriptions'] = [...subs, sub];
            await this.backend.writeSettings({ icsSubscriptions: next });
            this.display();
          }),
      );
  }
}

/** A short, unique-enough id for a new ICS subscription. */
function generateId(): string {
  return `${Date.now().toString(16)}${Math.floor(Math.random() * 0xffff).toString(16)}`;
}
