import type { App, EventRef, Plugin } from 'obsidian';
import type { Backend, BackendEvent, UnlistenFn } from '@app/backend';

/**
 * The Obsidian implementation of the shared {@link Backend} seam.
 *
 * PR 2 scope: this is a *skeleton*. Every data command returns a safe, typed
 * stub (`[]` / `null` / `undefined`) so the shared UI compiles and mounts
 * before the WASM core exists. PR 3 routes these commands to the Rust→WASM
 * core plus the Obsidian Vault API for reads/writes.
 *
 * What is real already: platform ops (`openExternal`, `getAppVersion`),
 * window no-ops, and vault change-event wiring for `tasks-updated`.
 */
export class ObsidianBackend implements Backend {
  private app: App;
  private plugin: Plugin;

  constructor(app: App, plugin: Plugin) {
    this.app = app;
    this.plugin = plugin;
  }

  async invoke<T = void>(command: string, _args?: Record<string, unknown>): Promise<T> {
    switch (command) {
      // ---- Task reads ---------------------------------------------------
      case 'get_tasks':
        // TODO(PR3): scan the vault + parse via WASM core → Task[]
        return [] as unknown as T;
      case 'get_all_projects':
        // TODO(PR3): collect project notes/frontmatter → ProjectInfo[]
        return [] as unknown as T;
      case 'get_all_persons':
        // TODO(PR3): collect person notes/frontmatter → PersonInfo[]
        return [] as unknown as T;
      case 'get_all_tags':
        // TODO(PR3): aggregate tags across parsed tasks → TagInfo[]
        return [] as unknown as T;
      case 'get_person_metadata':
        // TODO(PR3): read a person note's frontmatter → PersonMetadata
        return null as unknown as T;

      // ---- Task writes --------------------------------------------------
      case 'create_task':
      case 'update_task':
      case 'toggle_task_complete':
      case 'toggle_checklist_item':
      case 'rename_checklist_item':
      case 'delete_checklist_item':
        // TODO(PR3): WASM core line-surgery + vault.process() write → Task
        return null as unknown as T;
      case 'delete_task':
        // TODO(PR3): remove the task line via vault.process()
        return undefined as unknown as T;

      // ---- Projects & persons (writes) ----------------------------------
      case 'create_project':
      case 'rename_project':
      case 'update_project_metadata':
      case 'create_person':
      case 'rename_person':
        // TODO(PR3): create/rename notes + edit frontmatter via Vault API
        return undefined as unknown as T;

      // ---- Recurring templates ------------------------------------------
      case 'get_all_recurring_templates':
        // TODO(PR3): parse recurring templates → RecurringTemplate[]
        return [] as unknown as T;
      case 'create_recurring_template':
      case 'update_recurring_template':
        // TODO(PR3): persist a recurring template → RecurringTemplate
        return null as unknown as T;
      case 'delete_recurring_template':
        // TODO(PR3): remove a recurring template
        return undefined as unknown as T;
      case 'generate_recurring_instances':
        // TODO(PR3): recurrence math in WASM core → newly created Task[]
        return [] as unknown as T;

      // ---- Vault scanning / lifecycle -----------------------------------
      case 'rescan_vault':
        // TODO(PR3): force a re-scan + reparse → Task[]
        return [] as unknown as T;
      case 'use_default_vault':
        // The vault is implicit in Obsidian; nothing to choose.
        // TODO(PR3): confirm scan settings against the active vault
        return undefined as unknown as T;

      // ---- Settings: vault / folders ------------------------------------
      case 'set_vault_path':
        // The vault is fixed to Obsidian's; re-scan instead.
        // TODO(PR3): re-scan the active vault → Task[]
        return [] as unknown as T;
      case 'get_vault_path':
        // TODO(PR3): expose the Obsidian vault name/path
        return null as unknown as T;
      case 'get_folder_paths':
        // TODO(PR3): read configured tasks/projects/people folders → FolderPaths
        return null as unknown as T;
      case 'set_folder_paths':
        // TODO(PR3): persist folder paths via saveData() + re-scan → Task[]
        return [] as unknown as T;
      case 'get_excluded_paths':
        // TODO(PR3): read excluded paths from plugin data → string[]
        return [] as unknown as T;
      case 'set_excluded_paths':
        // TODO(PR3): persist excluded paths + re-scan → Task[]
        return [] as unknown as T;
      case 'set_annado_exclude_in_file':
        // TODO(PR3): toggle the in-file exclude marker via vault.process()
        return undefined as unknown as T;

      // ---- Settings: Obsidian / editor ----------------------------------
      case 'get_is_obsidian_vault':
        // We are, by definition, running inside Obsidian.
        return true as unknown as T;
      case 'set_is_obsidian_vault':
        // No-op: not user-configurable inside the plugin.
        return undefined as unknown as T;
      case 'get_editor_config':
        // Editing happens in Obsidian itself; no external editor.
        return { editorType: 'obsidian', editorCustomCommand: '' } as unknown as T;
      case 'set_editor_config':
        // No-op inside the plugin.
        return undefined as unknown as T;
      case 'open_file_in_editor':
        // TODO(PR3): open the note at args.path via workspace.openLinkText
        return undefined as unknown as T;

      // ---- Notifications ------------------------------------------------
      case 'get_notification_prefs':
        // TODO(PR6): persist notification prefs via loadData() → NotificationPrefs
        return null as unknown as T;
      case 'save_notification_prefs':
      case 'send_test_notification':
      case 'set_tray_enabled':
        // TODO(PR6): in-plugin Notice()/scheduling; no OS tray in Obsidian
        return undefined as unknown as T;

      // ---- Global shortcuts / deep links / tray / main window -----------
      case 'register_global_shortcuts':
        // OS-global shortcuts don't exist in-plugin; use addCommand hotkeys.
        return undefined as unknown as T;
      case 'get_pending_deep_link':
        // No external deep-link queue inside Obsidian.
        return null as unknown as T;
      case 'show_main_window':
      case 'open_task_in_main':
        // Tray→main-window flow is not applicable inside a single leaf.
        return undefined as unknown as T;

      // ---- Calendar / ICS -----------------------------------------------
      case 'is_system_calendar_supported':
        // No EventKit/system-calendar bridge inside Obsidian.
        return false as unknown as T;
      case 'check_calendar_access':
        return false as unknown as T;
      case 'get_calendars':
        return [] as unknown as T;
      case 'get_calendar_events':
        // TODO(PR6): expand ICS subscriptions via WASM core + requestUrl()
        return [] as unknown as T;
      case 'get_ics_subscriptions':
        // TODO(PR6): persist ICS subs via loadData() → IcsSubscription[]
        return [] as unknown as T;
      case 'add_ics_subscription':
        // TODO(PR6): persist a new ICS subscription → IcsSubscription
        return null as unknown as T;
      case 'remove_ics_subscription':
        // TODO(PR6): drop an ICS subscription
        return undefined as unknown as T;
      case 'open_calendar_at_date':
      case 'delete_calendar_event':
        // No system calendar to drive from the plugin.
        return undefined as unknown as T;

      default:
        // Unknown command: fail loud in dev, but don't crash the UI.
        console.warn(`[Annado] Unhandled backend command: ${command}`);
        return undefined as unknown as T;
    }
  }

  async listen<T = unknown>(
    event: string,
    handler: (event: BackendEvent<T>) => void,
  ): Promise<UnlistenFn> {
    if (event === 'tasks-updated') {
      // Re-emit on any vault mutation, debounced to coalesce bursts (e.g. sync).
      // PR 3 will replace the empty payload with a real re-scan of parsed tasks.
      let timer: ReturnType<typeof setTimeout> | null = null;
      const fire = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          // TODO(PR3): re-scan + reparse the vault → emit the real Task[].
          handler({ payload: [] as unknown as T });
        }, 200);
      };

      const refs: EventRef[] = [
        this.app.vault.on('modify', fire),
        this.app.vault.on('create', fire),
        this.app.vault.on('delete', fire),
        this.app.vault.on('rename', fire),
      ];

      return () => {
        if (timer) clearTimeout(timer);
        for (const ref of refs) this.app.vault.offref(ref);
      };
    }

    // global-quickadd / tray-open-task / deep-link-received: not applicable
    // inside a plugin leaf. Return a no-op unsubscribe.
    return () => {};
  }

  async openExternal(url: string): Promise<void> {
    // Internal Obsidian links open in the workspace; everything else externally.
    if (url.startsWith('obsidian://') || url.startsWith('[[')) {
      const target = url.replace(/^obsidian:\/\//, '').replace(/^\[\[|\]\]$/g, '');
      this.app.workspace.openLinkText(target, '', false);
      return;
    }
    window.open(url, '_blank');
  }

  async pickDirectory(_title: string): Promise<string | null> {
    // The vault is implicit in Obsidian; there is no folder picker.
    return null;
  }

  async getAppVersion(): Promise<string> {
    return this.plugin.manifest.version;
  }

  getWindowLabel(): string {
    return 'main';
  }

  startWindowDrag(): void {
    // No custom titlebar drag region inside an Obsidian leaf.
  }

  async hideWindow(): Promise<void> {
    // No standalone OS window to hide.
  }

  async setWindowBackground(_rgb: [number, number, number]): Promise<void> {
    // No native window background to paint.
  }
}
