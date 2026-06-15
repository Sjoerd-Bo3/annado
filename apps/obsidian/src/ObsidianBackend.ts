import {
  type App,
  type EventRef,
  type FrontMatterCache,
  type Plugin,
  type TFile,
  Notice,
  TFolder,
  normalizePath,
  requestUrl,
} from 'obsidian';
import type { Backend, BackendEvent, UnlistenFn } from '@app/backend';
import type {
  Task,
  ProjectInfo,
  ProjectMetadata,
  PersonInfo,
  PersonMetadata,
  TagInfo,
  FolderPaths,
  RecurringTemplate,
  RecurrenceType,
  IntervalUnit,
  CalendarInfo,
  CalendarEvent,
  IcsSubscription,
  WhenValue,
  TaskUpdatePayload,
  CreateTaskPayload,
  CreateRecurringTemplatePayload,
  UpdateRecurringTemplatePayload,
  Milestone,
} from '@app/types/task';
import {
  parse_file,
  format_task_line,
  apply_task_update,
  toggle_checklist_item,
  rename_checklist_item,
  delete_checklist_item,
  delete_task,
  daily_note_date_path,
  should_generate_instance,
  expand_ics,
  subscription_calendars,
} from './core';

/** Plugin data persisted via loadData()/saveData(). */
interface AnnadoData {
  folderPaths?: FolderPaths;
  excludedPaths?: string[];
  icsSubscriptions?: IcsSubscription[];
  notificationPrefs?: unknown;
}

const DEFAULT_FOLDER_PATHS: FolderPaths = {
  recurringTemplates: '12. System/recurring-tasks',
  projectsPattern: 'Projects',
  areasPattern: 'Areas',
  personsPattern: 'Persons',
  dailyNotesFolder: '00. Daily Notes',
  dailyNotesFormat: 'YYYY/MM-MMMM/YYYY-MM-DD',
};

/** Local `YYYY-MM-DD` for "today" — matches the engine's `today` contract. */
function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** A frontmatter value coerced to a single trimmed string, or null. */
function fmString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/** Strip a `[[path/to/Name]]` wikilink down to "Name"; pass other strings through. */
function parseWikilink(s: string): string {
  const trimmed = s.trim();
  if (trimmed.startsWith('[[') && trimmed.endsWith(']]')) {
    const inner = trimmed.slice(2, -2);
    const parts = inner.split('/');
    return parts[parts.length - 1];
  }
  return trimmed;
}

/** Coerce a frontmatter value (array | comma-string | scalar) to a string[]. */
function fmStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => fmString(v)).filter((v): v is string => v != null);
  }
  const s = fmString(value);
  if (s == null) return [];
  return s
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * The Obsidian implementation of the shared {@link Backend} seam.
 *
 * Data commands route to the Rust→WASM core (parsing, line surgery, recurrence,
 * ICS) over the Obsidian Vault API for reads/writes. Frontmatter parsing was
 * intentionally NOT ported to the core — for projects/persons we use Obsidian's
 * own parsed `metadataCache` frontmatter instead.
 *
 * The engine is synchronous and pure; this class owns the async Vault I/O and a
 * task cache (`taskById`) so commands that take only a task `id` (update,
 * toggle, checklist ops, delete) can locate the file + line to edit — mirroring
 * the Rust `Vault`'s in-memory task map.
 *
 * Build-verified only; runtime behaviour needs Obsidian (a Mac to package/run).
 */
export class ObsidianBackend implements Backend {
  private app: App;
  private plugin: Plugin;

  /** Last-scanned tasks keyed by id (the Rust `Vault.tasks` analogue). */
  private taskById = new Map<string, Task>();
  /** Cached folder config; loaded lazily from plugin data. */
  private folderPaths: FolderPaths = { ...DEFAULT_FOLDER_PATHS };
  private excludedPaths: string[] = [];
  private dataLoaded = false;

  constructor(app: App, plugin: Plugin) {
    this.app = app;
    this.plugin = plugin;
  }

  // ── Plugin data (loadData/saveData) ────────────────────────────────────

  private async data(): Promise<AnnadoData> {
    const raw = ((await this.plugin.loadData()) as AnnadoData) ?? {};
    if (!this.dataLoaded) {
      this.folderPaths = { ...DEFAULT_FOLDER_PATHS, ...(raw.folderPaths ?? {}) };
      this.excludedPaths = raw.excludedPaths ?? [];
      this.dataLoaded = true;
    }
    return raw;
  }

  private async patchData(patch: Partial<AnnadoData>): Promise<void> {
    const current = ((await this.plugin.loadData()) as AnnadoData) ?? {};
    await this.plugin.saveData({ ...current, ...patch });
  }

  // ── Vault scanning ─────────────────────────────────────────────────────

  /** A markdown file's relative path matches an exclusion entry (file or folder). */
  private isPathExcluded(relPath: string): boolean {
    for (const pattern of this.excludedPaths) {
      if (pattern.endsWith('/')) {
        const bare = pattern.slice(0, -1);
        if (relPath.startsWith(pattern) || relPath.startsWith(bare)) return true;
      } else {
        if (relPath === pattern) return true;
        if (relPath === `${pattern}.md`) return true;
        if (relPath.startsWith(`${pattern}/`)) return true;
      }
    }
    return false;
  }

  private frontmatterOf(file: TFile): FrontMatterCache | undefined {
    return this.app.metadataCache.getFileCache(file)?.frontmatter;
  }

  /** True if the file carries `annado_exclude: true` in its frontmatter. */
  private hasAnnadoExclude(file: TFile): boolean {
    return this.frontmatterOf(file)?.annado_exclude === true;
  }

  /**
   * The set of task-bearing markdown files: all markdown files minus hidden
   * paths, the recurring-templates folder, excluded paths, and `annado_exclude`
   * files. Mirrors `Vault::scan`'s filtering.
   */
  private taskFiles(): TFile[] {
    const recurring = this.folderPaths.recurringTemplates;
    return this.app.vault.getMarkdownFiles().filter((file) => {
      const path = file.path;
      if (path.split('/').some((seg) => seg.startsWith('.'))) return false;
      if (recurring && path.includes(recurring)) return false;
      if (this.isPathExcluded(path)) return false;
      if (this.hasAnnadoExclude(file)) return false;
      return true;
    });
  }

  /** Derive an Areas-folder project name for tasks that have no project yet. */
  private deriveAreaProject(filePath: string): string | null {
    const pattern = this.folderPaths.areasPattern;
    if (!pattern) return null;
    const parts = filePath.split('/');
    const idx = parts.findIndex((p) => p.includes(pattern) && !p.endsWith('.md'));
    if (idx < 0) return null;
    const after = parts.slice(idx + 1);
    const last = after[after.length - 1];
    if (!last?.endsWith('.md')) return null;
    const stem = last.replace(/\.md$/, '');
    if (after.length === 1) return stem;
    const parent = after[after.length - 2];
    const generic = ['tasks', 'notes', 'todo', 'index', 'readme', 'task', 'note'];
    if (generic.includes(stem.toLowerCase())) return parent;
    return stem;
  }

  /** Scan the whole vault, parse every task file, and refresh the id→task cache. */
  private async scanTasks(): Promise<Task[]> {
    await this.data();
    const today = todayStr();

    const personNames = new Set((await this.collectPersons()).map((p) => p.name));
    const projectNames = new Set((await this.collectProjects()).map((p) => p.name));

    const all: Task[] = [];
    for (const file of this.taskFiles()) {
      const contents = await this.app.vault.cachedRead(file);
      const tasks = parse_file(file.path, contents, today);
      for (const task of tasks) {
        // Areas fallback project (only when the parser found none).
        if (task.projects.length === 0) {
          const area = this.deriveAreaProject(task.filePath);
          if (area) task.projects = [area];
        }
        // Resolve [[wikilinks]] in the title into persons/projects.
        for (const link of extractWikilinks(task.title)) {
          if (personNames.has(link) && !task.persons.includes(link)) {
            task.persons.push(link);
          } else if (projectNames.has(link) && !task.projects.includes(link)) {
            task.projects.push(link);
          }
        }
        all.push(task);
      }
    }

    this.taskById.clear();
    for (const task of all) this.taskById.set(task.id, task);
    return all;
  }

  // ── Projects / persons (frontmatter via metadataCache) ──────────────────

  private async collectProjects(): Promise<ProjectInfo[]> {
    await this.data();
    const { projectsPattern, areasPattern } = this.folderPaths;
    const seen = new Set<string>();
    const out: ProjectInfo[] = [];

    for (const file of this.app.vault.getMarkdownFiles()) {
      const path = file.path;
      if (path.split('/').some((seg) => seg.startsWith('.'))) continue;
      if (this.isPathExcluded(path)) continue;

      const inProjects = path.includes(projectsPattern);
      const inAreas = !!areasPattern && path.includes(areasPattern);
      if (!inProjects && !inAreas) continue;
      const active = inProjects ? projectsPattern : areasPattern;

      const parts = path.split('/');
      const idx = parts.findIndex((p) => p.includes(active) && !p.endsWith('.md'));
      if (idx < 0) continue;

      const name = file.basename;
      if (!name || name.includes(active) || name.startsWith('.')) continue;
      if (seen.has(name)) continue;
      seen.add(name);

      const depth = parts.length > idx + 2 ? parts.length - idx - 2 : 0;
      const parentFolder = depth > 0 && parts.length > idx + 1 ? parts[parts.length - 2] : null;

      out.push({
        name,
        path,
        depth,
        parentFolder,
        metadata: this.parseProjectMetadata(file),
      });
    }

    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }

  private parseProjectMetadata(file: TFile): ProjectMetadata {
    const fm = this.frontmatterOf(file);
    const meta: ProjectMetadata = {
      description: null,
      deadline: null,
      startDate: null,
      ranking: null,
      persons: [],
      up: null,
      milestones: [],
    };
    if (!fm) return meta;

    const pick = (keys: string[]): string | null => {
      for (const k of keys) {
        if (k in fm) {
          const v = fmString(fm[k]);
          if (v != null) return v;
        }
      }
      return null;
    };

    meta.description = pick(['description', 'desc', 'summary']);
    meta.deadline = pick(['date_deadline', 'deadline', 'due', 'due_date']);
    meta.startDate = pick(['date_start', 'start', 'start_date', 'started']);
    meta.ranking = pick(['ranking', 'priority', 'rank']);

    for (const k of ['persons', 'person', 'people', 'assigned', 'assignee']) {
      if (k in fm) {
        const persons = fmStringArray(fm[k]).map((p) => {
          const cleaned = parseWikilink(p);
          const dot = cleaned.indexOf('. ');
          return dot >= 0 ? cleaned.slice(dot + 2) : cleaned;
        });
        if (persons.length > 0) {
          meta.persons = persons;
          break;
        }
      }
    }

    if ('up' in fm) {
      const up = fmString(fm.up);
      if (up != null) meta.up = parseWikilink(up);
    }

    if (Array.isArray(fm.milestones)) {
      meta.milestones = (fm.milestones as unknown[])
        .filter((m): m is Record<string, unknown> => typeof m === 'object' && m != null)
        .map((m) => ({
          name: fmString(m.name) ?? '',
          start: fmString(m.start),
          end: fmString(m.end),
          completed: m.completed === true,
        })) as Milestone[];
    }

    return meta;
  }

  private async collectPersons(): Promise<PersonInfo[]> {
    await this.data();
    const pattern = this.folderPaths.personsPattern;
    const seen = new Set<string>();
    const out: PersonInfo[] = [];

    for (const file of this.app.vault.getMarkdownFiles()) {
      const path = file.path;
      if (path.split('/').some((seg) => seg.startsWith('.'))) continue;
      if (this.isPathExcluded(path)) continue;
      if (!path.includes(pattern)) continue;

      const parts = path.split('/');
      const hasFolder = parts.some((p) => p.includes(pattern) && !p.endsWith('.md'));
      if (!hasFolder) continue;

      const name = file.basename;
      if (!name || name.includes(pattern) || name.startsWith('.')) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, path });
    }

    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  private findPersonFile(name: string): TFile | null {
    const pattern = this.folderPaths.personsPattern;
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.includes(pattern)) continue;
      if (file.basename === name) return file;
    }
    return null;
  }

  private parsePersonMetadata(file: TFile): PersonMetadata {
    const fm = this.frontmatterOf(file);
    const meta: PersonMetadata = {
      name: null,
      organisation: null,
      relationship: null,
      languages: [],
      projects: [],
    };
    if (!fm) return meta;

    if ('name' in fm) meta.name = fmString(fm.name);
    for (const k of ['organisation', 'organization', 'org', 'company']) {
      if (k in fm) {
        meta.organisation = fmString(fm[k]);
        if (meta.organisation != null) break;
      }
    }
    for (const k of ['relationship', 'relation', 'type']) {
      if (k in fm) {
        meta.relationship = fmString(fm[k]);
        if (meta.relationship != null) break;
      }
    }
    for (const k of ['languages', 'language', 'lang']) {
      if (k in fm) {
        meta.languages = fmStringArray(fm[k]);
        if (meta.languages.length > 0) break;
      }
    }
    for (const k of ['projects', 'project']) {
      if (k in fm) {
        meta.projects = fmStringArray(fm[k]).map(parseWikilink);
        if (meta.projects.length > 0) break;
      }
    }
    return meta;
  }

  // ── Tags (derived from parsed tasks) ────────────────────────────────────

  private allTags(): TagInfo[] {
    const counts = new Map<string, number>();
    for (const task of this.taskById.values()) {
      if (task.completed) continue;
      for (const tag of task.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  }

  // ── Task writes ─────────────────────────────────────────────────────────

  private getFile(path: string): TFile {
    const file = this.app.vault.getFileByPath(normalizePath(path));
    if (!file) throw new Error(`File not found: ${path}`);
    return file;
  }

  private requireTask(id: string): Task {
    const task = this.taskById.get(id);
    if (!task) throw new Error('Task not found');
    return task;
  }

  /** The Projects-folder name a file belongs to (for omitting it from a written line). */
  private fileProject(filePath: string): string | null {
    const pattern = this.folderPaths.projectsPattern;
    const parts = filePath.split('/');
    const idx = parts.findIndex((p) => p.includes(pattern) && !p.endsWith('.md'));
    if (idx < 0) return null;
    const after = parts.slice(idx + 1);
    const last = after[after.length - 1];
    if (!last?.endsWith('.md')) return null;
    const stem = last.replace(/\.md$/, '');
    if (after.length === 1) return stem;
    const parent = after[after.length - 2];
    if (parent === stem) return stem;
    const generic = ['tasks', 'notes', 'todo', 'index', 'readme', 'task', 'note'];
    if (generic.includes(stem.toLowerCase())) return parent;
    return stem;
  }

  private async projectNames(): Promise<string[]> {
    return (await this.collectProjects()).map((p) => p.name);
  }

  /** Re-read + re-parse a file and return the task at `lineNumber` (1-based). */
  private async reparseTaskAt(file: TFile, lineNumber: number): Promise<Task | null> {
    const contents = await this.app.vault.read(file);
    const tasks = parse_file(file.path, contents, todayStr());
    const found = tasks.find((t) => t.lineNumber === lineNumber) ?? null;
    if (found) this.taskById.set(found.id, found);
    return found;
  }

  private async writeFile(file: TFile, next: string): Promise<void> {
    await this.app.vault.process(file, () => next);
  }

  private async updateTask(payload: TaskUpdatePayload): Promise<Task> {
    const previous = this.requireTask(payload.id);
    const merged = applyTaskPayload(previous, payload);
    const file = this.getFile(previous.filePath);
    const contents = await this.app.vault.read(file);
    const next = apply_task_update(
      contents,
      merged,
      todayStr(),
      this.fileProject(previous.filePath),
      await this.projectNames(),
    );
    await this.writeFile(file, next);
    const reparsed = await this.reparseTaskAt(file, previous.lineNumber);
    return reparsed ?? merged;
  }

  private async toggleTaskComplete(id: string): Promise<Task> {
    const previous = this.requireTask(id);
    const completing = !previous.completed;
    const merged: Task = {
      ...previous,
      completed: completing,
      completedDate: completing ? todayStr() : null,
    };
    const file = this.getFile(previous.filePath);
    const contents = await this.app.vault.read(file);
    const next = apply_task_update(
      contents,
      merged,
      todayStr(),
      this.fileProject(previous.filePath),
      await this.projectNames(),
    );
    await this.writeFile(file, next);

    // Completing a recurring instance advances the template's last_completed.
    if (completing && previous.recurringTemplateId) {
      await this.setTemplateField(previous.recurringTemplateId, 'last_completed', todayStr());
    }

    const reparsed = await this.reparseTaskAt(file, previous.lineNumber);
    return reparsed ?? merged;
  }

  private async checklistOp(
    id: string,
    fn: (contents: string, line: number) => string,
  ): Promise<Task> {
    const task = this.requireTask(id);
    const file = this.getFile(task.filePath);
    const contents = await this.app.vault.read(file);
    const next = fn(contents, task.lineNumber);
    await this.writeFile(file, next);
    const reparsed = await this.reparseTaskAt(file, task.lineNumber);
    return reparsed ?? task;
  }

  private async deleteTaskById(id: string): Promise<void> {
    const task = this.requireTask(id);
    const file = this.getFile(task.filePath);
    const contents = await this.app.vault.read(file);
    const next = delete_task(contents, task.lineNumber, task.indentLevel);
    await this.writeFile(file, next);
    this.taskById.delete(id);
  }

  private async createTask(payload: CreateTaskPayload): Promise<Task> {
    const today = todayStr();
    const file = await this.ensureDailyNote(today);
    const contents = await this.app.vault.read(file);

    const newLineNumber =
      contents.length === 0
        ? 1
        : contents.split(/\r?\n/).length + (contents.endsWith('\n') ? 0 : 1);

    const task: Task = {
      id: '',
      title: payload.title,
      notes: '',
      when: normalizeWhen(payload.when ?? 'inbox', today),
      deadline: null,
      tags: [],
      checklist: [],
      completed: false,
      completedDate: null,
      createdDate: today,
      filePath: file.path,
      lineNumber: newLineNumber,
      projects: [],
      indentLevel: 0,
      priority: null,
      persons: [],
      recurringTemplateId: null,
      durationMinutes: null,
      scheduledTime: null,
    };

    const line = format_task_line(task, today, this.fileProject(file.path), await this.projectNames());
    const next =
      contents.endsWith('\n') || contents.length === 0
        ? `${contents}${line}\n`
        : `${contents}\n${line}\n`;
    await this.writeFile(file, next);

    const reparsed = await this.reparseTaskAt(file, newLineNumber);
    return reparsed ?? task;
  }

  // ── Daily notes ──────────────────────────────────────────────────────────

  /** Read Obsidian's own daily-notes config (`.obsidian/daily-notes.json`), if any. */
  private async readObsidianDailyNotes(): Promise<{ folder: string; format: string } | null> {
    try {
      const path = `${this.app.vault.configDir}/daily-notes.json`;
      if (!(await this.app.vault.adapter.exists(path))) return null;
      const raw = await this.app.vault.adapter.read(path);
      const cfg = JSON.parse(raw) as { folder?: string; format?: string };
      if (!cfg.format) return null;
      return { folder: (cfg.folder ?? '').replace(/\/$/, ''), format: cfg.format };
    } catch {
      return null;
    }
  }

  private async dailyNotePath(dateStr: string): Promise<string> {
    await this.data();
    const obsidian = await this.readObsidianDailyNotes();
    const folder = obsidian?.folder ?? this.folderPaths.dailyNotesFolder;
    const format = obsidian?.format ?? this.folderPaths.dailyNotesFormat;
    const stem = daily_note_date_path(dateStr, format);
    return normalizePath(`${folder}/${stem}.md`);
  }

  private async ensureFolder(folder: string): Promise<void> {
    const norm = normalizePath(folder);
    if (norm === '' || norm === '/' || norm === '.') return;
    if (this.app.vault.getFolderByPath(norm) instanceof TFolder) return;
    if (await this.app.vault.adapter.exists(norm)) return;
    await this.app.vault.createFolder(norm).catch(() => {
      /* already exists / race */
    });
  }

  private async ensureDailyNote(dateStr: string): Promise<TFile> {
    const path = await this.dailyNotePath(dateStr);
    const existing = this.app.vault.getFileByPath(path);
    if (existing) return existing;
    const slash = path.lastIndexOf('/');
    if (slash > 0) await this.ensureFolder(path.slice(0, slash));
    const heading = formatLongDate(dateStr);
    const body = `---\ndate: ${dateStr}\n---\n\n# ${heading}\n\n## Tasks\n\n`;
    return this.app.vault.create(path, body);
  }

  // ── Recurring templates ──────────────────────────────────────────────────

  private recurringFolder(): string {
    return normalizePath(this.folderPaths.recurringTemplates);
  }

  private parseRecurringTemplate(file: TFile, contents: string): RecurringTemplate | null {
    const fm = this.frontmatterOf(file);
    if (!fm || typeof fm.template_id !== 'string') return null;

    const recurrenceType: RecurrenceType =
      fm.recurrence_type === 'after_completion' ? 'after_completion' : 'fixed';
    const intervalUnit: IntervalUnit =
      fm.interval_unit === 'weeks'
        ? 'weeks'
        : fm.interval_unit === 'months'
          ? 'months'
          : fm.interval_unit === 'years'
            ? 'years'
            : 'days';

    // Parse the task line from the body (below the frontmatter block).
    const body = stripFrontmatter(contents);
    const today = todayStr();
    let title = '';
    let notes = '';
    let projects: string[] = [];
    let priority: number | null = null;
    let tags: string[] = [];

    const bodyTasks = parse_file(file.path, body, today);
    if (bodyTasks.length > 0) {
      const t = bodyTasks[0];
      title = t.title;
      notes = t.notes;
      projects = t.projects;
      priority = t.priority;
      tags = t.tags;
    }

    return {
      templateId: fm.template_id,
      title,
      notes,
      recurrenceType,
      interval: typeof fm.interval === 'number' ? fm.interval : 1,
      intervalUnit,
      startDate: fmString(fm.start_date),
      lastGenerated: fmString(fm.last_generated),
      lastCompleted: fmString(fm.last_completed),
      filePath: file.path,
      projects,
      priority,
      tags,
    };
  }

  private recurringTemplateFiles(): TFile[] {
    const folder = this.recurringFolder();
    return this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(`${folder}/`));
  }

  private async getAllRecurringTemplates(): Promise<RecurringTemplate[]> {
    await this.data();
    const out: RecurringTemplate[] = [];
    for (const file of this.recurringTemplateFiles()) {
      const contents = await this.app.vault.cachedRead(file);
      const tpl = this.parseRecurringTemplate(file, contents);
      if (tpl) out.push(tpl);
    }
    return out;
  }

  private findTemplateFile(templateId: string): TFile | null {
    for (const file of this.recurringTemplateFiles()) {
      if (this.frontmatterOf(file)?.template_id === templateId) return file;
    }
    return null;
  }

  /** Set/replace a single frontmatter scalar in a template file. */
  private async setTemplateField(templateId: string, key: string, value: string): Promise<void> {
    const file = this.findTemplateFile(templateId);
    if (!file) return;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm[key] = value;
    });
  }

  private async createRecurringTemplate(
    payload: CreateRecurringTemplatePayload,
  ): Promise<RecurringTemplate> {
    await this.data();
    await this.ensureFolder(this.recurringFolder());

    const templateId = generateTemplateId();
    const filename = `${sanitizeFilename(payload.title)}.md`;
    const path = normalizePath(`${this.recurringFolder()}/${filename}`);

    const parts: string[] = [payload.title];
    if (payload.project) parts.push(`[[${payload.project}]]`);
    if (payload.priority != null) parts.push(`!(${payload.priority})`);
    for (const tag of payload.tags ?? []) parts.push(`#${tag}`);
    const taskLine = `- [ ] ${parts.join(' ')}`;

    const notesBlock = payload.notes
      ? `\n${payload.notes
          .split('\n')
          .map((l) => `    ${l}`)
          .join('\n')}`
      : '';
    const startDateLine = payload.startDate ? `start_date: ${payload.startDate}\n` : '';

    const content =
      `---\nrecurrence_type: ${payload.recurrenceType}\ninterval: ${payload.interval}\n` +
      `interval_unit: ${payload.intervalUnit}\n${startDateLine}template_id: ${templateId}\n` +
      `annado_exclude: true\n---\n\n${taskLine}${notesBlock}\n`;

    await this.app.vault.create(path, content);

    // Generate the first instance immediately, then stamp last_generated.
    const instanceDate = payload.startDate ?? todayStr();
    const tpl: RecurringTemplate = {
      templateId,
      title: payload.title,
      notes: payload.notes ?? '',
      recurrenceType: payload.recurrenceType,
      interval: payload.interval,
      intervalUnit: payload.intervalUnit,
      startDate: payload.startDate ?? null,
      lastGenerated: null,
      lastCompleted: null,
      filePath: path,
      projects: payload.project ? [payload.project] : [],
      priority: payload.priority ?? null,
      tags: payload.tags ?? [],
    };
    await this.createRecurringInstance(tpl, instanceDate).catch(() => {
      /* instance may already exist */
    });
    await this.setTemplateField(templateId, 'last_generated', instanceDate);

    return { ...tpl, lastGenerated: instanceDate };
  }

  private async updateRecurringTemplate(
    payload: UpdateRecurringTemplatePayload,
  ): Promise<RecurringTemplate> {
    const file = this.findTemplateFile(payload.templateId);
    if (!file) throw new Error('Recurring template not found');

    await this.app.fileManager.processFrontMatter(file, (fm) => {
      if (payload.recurrenceType !== undefined) fm.recurrence_type = payload.recurrenceType;
      if (payload.interval !== undefined) fm.interval = payload.interval;
      if (payload.intervalUnit !== undefined) fm.interval_unit = payload.intervalUnit;
      if (payload.startDate !== undefined) fm.start_date = payload.startDate;
    });

    // Rewrite the body task line when title/project/priority/tags/notes change.
    if (
      payload.title !== undefined ||
      payload.project !== undefined ||
      payload.priority !== undefined ||
      payload.tags !== undefined ||
      payload.notes !== undefined
    ) {
      const existing = this.parseRecurringTemplate(file, await this.app.vault.read(file));
      const title = payload.title ?? existing?.title ?? '';
      const project = payload.project ?? existing?.projects[0];
      const priority =
        payload.priority !== undefined ? payload.priority : (existing?.priority ?? null);
      const tags = payload.tags ?? existing?.tags ?? [];
      const notes = payload.notes ?? existing?.notes ?? '';

      const parts: string[] = [title];
      if (project) parts.push(`[[${project}]]`);
      if (priority != null) parts.push(`!(${priority})`);
      for (const tag of tags) parts.push(`#${tag}`);
      const taskLine = `- [ ] ${parts.join(' ')}`;
      const notesBlock = notes
        ? `\n${notes
            .split('\n')
            .map((l) => `    ${l}`)
            .join('\n')}`
        : '';

      await this.app.vault.process(file, (data) => {
        const fmEnd = frontmatterEndIndex(data);
        const head = fmEnd >= 0 ? data.slice(0, fmEnd).replace(/\n+$/, '') : '';
        return `${head}\n\n${taskLine}${notesBlock}\n`;
      });
    }

    const refreshed = this.parseRecurringTemplate(file, await this.app.vault.read(file));
    if (!refreshed) throw new Error('Failed to re-read recurring template');
    return refreshed;
  }

  private async deleteRecurringTemplate(templateId: string): Promise<void> {
    const file = this.findTemplateFile(templateId);
    if (file) await this.app.vault.delete(file);
  }

  /** Append a recurring instance to the daily note for `dateStr`. */
  private async createRecurringInstance(
    tpl: RecurringTemplate,
    dateStr: string,
  ): Promise<Task | null> {
    const file = await this.ensureDailyNote(dateStr);
    const contents = await this.app.vault.read(file);
    const marker = `@recurring(${tpl.templateId})`;
    if (contents.includes(marker)) return null; // instance already present

    const parts: string[] = [tpl.title, `@when(${dateStr})`];
    for (const project of tpl.projects) parts.push(`[[${project}]]`);
    if (tpl.priority != null) parts.push(`!(${tpl.priority})`);
    for (const tag of tpl.tags) parts.push(`#${tag}`);
    parts.push(marker);
    let taskLine = `- [ ] ${parts.join(' ')}`;
    if (tpl.notes) {
      const indented = tpl.notes
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n');
      taskLine = `${taskLine}\n${indented}`;
    }

    const lineNumber =
      contents.length === 0
        ? 1
        : contents.split(/\r?\n/).length + (contents.endsWith('\n') ? 0 : 1);
    const next =
      contents.endsWith('\n') || contents.length === 0
        ? `${contents}${taskLine}\n`
        : `${contents}\n${taskLine}\n`;
    await this.writeFile(file, next);
    return this.reparseTaskAt(file, lineNumber);
  }

  private async generateRecurringInstances(): Promise<Task[]> {
    const today = todayStr();
    const templates = await this.getAllRecurringTemplates();
    const existing = [...this.taskById.values()];
    const created: Task[] = [];

    for (const tpl of templates) {
      if (!should_generate_instance(tpl, today)) continue;
      const alreadyOpen = existing.some(
        (t) => t.recurringTemplateId === tpl.templateId && !t.completed,
      );
      if (alreadyOpen) continue;

      const instanceDate = tpl.lastGenerated == null && tpl.startDate ? tpl.startDate : today;
      const task = await this.createRecurringInstance(tpl, instanceDate);
      if (task) {
        created.push(task);
        await this.setTemplateField(tpl.templateId, 'last_generated', instanceDate);
      }
    }
    return created;
  }

  // ── Calendar / ICS ────────────────────────────────────────────────────────

  private async getIcsSubscriptions(): Promise<IcsSubscription[]> {
    return (await this.data()).icsSubscriptions ?? [];
  }

  private async addIcsSubscription(name: string, url: string): Promise<IcsSubscription> {
    const subs = await this.getIcsSubscriptions();
    const sub: IcsSubscription = {
      id: generateTemplateId(),
      name,
      url,
      color: '#4a90d9',
    };
    await this.patchData({ icsSubscriptions: [...subs, sub] });
    return sub;
  }

  private async removeIcsSubscription(id: string): Promise<void> {
    const subs = await this.getIcsSubscriptions();
    await this.patchData({ icsSubscriptions: subs.filter((s) => s.id !== id) });
  }

  private async getCalendars(): Promise<CalendarInfo[]> {
    return subscription_calendars(await this.getIcsSubscriptions());
  }

  private async getCalendarEvents(args: {
    calendarNames: string[];
    startDate: string;
    endDate: string;
  }): Promise<CalendarEvent[]> {
    const subs = await this.getIcsSubscriptions();
    const wanted = new Set(args.calendarNames);
    const events: CalendarEvent[] = [];
    for (const sub of subs) {
      if (!wanted.has(sub.name)) continue;
      try {
        const res = await requestUrl({ url: sub.url });
        const expanded = expand_ics(res.text, sub, args.startDate, args.endDate);
        events.push(...expanded);
      } catch (err) {
        console.error(`[Annado] Failed to fetch ICS feed "${sub.name}":`, err);
      }
    }
    return events;
  }

  // ── Backend interface ──────────────────────────────────────────────────

  async invoke<T = void>(command: string, args?: Record<string, unknown>): Promise<T> {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (command) {
      // ---- Task reads ---------------------------------------------------
      case 'get_tasks':
      case 'rescan_vault':
      case 'set_vault_path':
        return (await this.scanTasks()) as unknown as T;
      case 'get_all_projects':
        return (await this.collectProjects()) as unknown as T;
      case 'get_all_persons':
        return (await this.collectPersons()) as unknown as T;
      case 'get_all_tags':
        return this.allTags() as unknown as T;
      case 'get_person_metadata': {
        const file = this.findPersonFile(a.personName as string);
        return (file
          ? this.parsePersonMetadata(file)
          : {
              name: null,
              organisation: null,
              relationship: null,
              languages: [],
              projects: [],
            }) as unknown as T;
      }

      // ---- Task writes --------------------------------------------------
      case 'create_task':
        return (await this.createTask(a.payload as CreateTaskPayload)) as unknown as T;
      case 'update_task':
        return (await this.updateTask(a.payload as TaskUpdatePayload)) as unknown as T;
      case 'toggle_task_complete':
        return (await this.toggleTaskComplete(a.id as string)) as unknown as T;
      case 'toggle_checklist_item':
        return (await this.checklistOp(a.taskId as string, (c, line) =>
          toggle_checklist_item(c, line, a.itemIndex as number),
        )) as unknown as T;
      case 'rename_checklist_item':
        return (await this.checklistOp(a.taskId as string, (c, line) =>
          rename_checklist_item(c, line, a.itemIndex as number, a.newTitle as string),
        )) as unknown as T;
      case 'delete_checklist_item':
        return (await this.checklistOp(a.taskId as string, (c, line) =>
          delete_checklist_item(c, line, a.itemIndex as number),
        )) as unknown as T;
      case 'delete_task':
        await this.deleteTaskById(a.id as string);
        return undefined as unknown as T;

      // ---- Projects & persons (writes) ----------------------------------
      // Creating/renaming notes + editing project frontmatter is deferred to a
      // later PR (PR 6); the read paths above already surface them. Kept as
      // explicit no-ops so the UI doesn't error.
      case 'create_project':
      case 'rename_project':
      case 'update_project_metadata':
      case 'create_person':
      case 'rename_person':
        console.warn(`[Annado] ${command} is not yet implemented in the Obsidian backend`);
        return undefined as unknown as T;

      // ---- Recurring templates ------------------------------------------
      case 'get_all_recurring_templates':
        return (await this.getAllRecurringTemplates()) as unknown as T;
      case 'create_recurring_template':
        return (await this.createRecurringTemplate(
          a.payload as CreateRecurringTemplatePayload,
        )) as unknown as T;
      case 'update_recurring_template':
        return (await this.updateRecurringTemplate(
          a.payload as UpdateRecurringTemplatePayload,
        )) as unknown as T;
      case 'delete_recurring_template':
        await this.deleteRecurringTemplate(a.templateId as string);
        return undefined as unknown as T;
      case 'generate_recurring_instances':
        return (await this.generateRecurringInstances()) as unknown as T;

      // ---- Vault lifecycle ----------------------------------------------
      case 'use_default_vault':
        return undefined as unknown as T;

      // ---- Settings: vault / folders ------------------------------------
      case 'get_vault_path':
        return this.app.vault.getName() as unknown as T;
      case 'get_folder_paths':
        await this.data();
        return { ...this.folderPaths } as unknown as T;
      case 'set_folder_paths':
        this.folderPaths = { ...DEFAULT_FOLDER_PATHS, ...(a.folderPaths as FolderPaths) };
        await this.patchData({ folderPaths: this.folderPaths });
        return (await this.scanTasks()) as unknown as T;
      case 'get_excluded_paths':
        await this.data();
        return [...this.excludedPaths] as unknown as T;
      case 'set_excluded_paths':
        this.excludedPaths = (a.excludedPaths as string[]) ?? [];
        await this.patchData({ excludedPaths: this.excludedPaths });
        return (await this.scanTasks()) as unknown as T;
      case 'set_annado_exclude_in_file': {
        const file = this.app.vault.getFileByPath(normalizePath(a.relativePath as string));
        if (file) {
          await this.app.fileManager.processFrontMatter(file, (fm) => {
            if (a.exclude) fm.annado_exclude = true;
            else delete fm.annado_exclude;
          });
        }
        return undefined as unknown as T;
      }

      // ---- Settings: Obsidian / editor ----------------------------------
      case 'get_is_obsidian_vault':
        return true as unknown as T;
      case 'set_is_obsidian_vault':
        return undefined as unknown as T;
      case 'get_editor_config':
        return { editorType: 'obsidian', editorCustomCommand: '' } as unknown as T;
      case 'set_editor_config':
        return undefined as unknown as T;
      case 'open_file_in_editor': {
        const filePath = a.filePath as string;
        if (filePath) {
          await this.app.workspace.openLinkText(filePath, '', false);
        }
        return undefined as unknown as T;
      }

      // ---- Notifications (PR 6) -----------------------------------------
      case 'get_notification_prefs':
        return ((await this.data()).notificationPrefs ?? null) as unknown as T;
      case 'save_notification_prefs':
        await this.patchData({ notificationPrefs: a.prefs ?? a.payload });
        return undefined as unknown as T;
      case 'send_test_notification':
        new Notice('Annado: test notification');
        return undefined as unknown as T;
      case 'set_tray_enabled':
        return undefined as unknown as T;

      // ---- Global shortcuts / deep links / tray / main window -----------
      case 'register_global_shortcuts':
      case 'show_main_window':
      case 'open_task_in_main':
        return undefined as unknown as T;
      case 'get_pending_deep_link':
        return null as unknown as T;

      // ---- Calendar / ICS -----------------------------------------------
      case 'is_system_calendar_supported':
      case 'check_calendar_access':
        return false as unknown as T;
      case 'get_calendars':
        return (await this.getCalendars()) as unknown as T;
      case 'get_calendar_events':
        return (await this.getCalendarEvents(
          a as unknown as { calendarNames: string[]; startDate: string; endDate: string },
        )) as unknown as T;
      case 'get_ics_subscriptions':
        return (await this.getIcsSubscriptions()) as unknown as T;
      case 'add_ics_subscription':
        return (await this.addIcsSubscription(a.name as string, a.url as string)) as unknown as T;
      case 'remove_ics_subscription':
        await this.removeIcsSubscription(a.id as string);
        return undefined as unknown as T;
      case 'open_calendar_at_date':
      case 'delete_calendar_event':
        return undefined as unknown as T;

      default:
        console.warn(`[Annado] Unhandled backend command: ${command}`);
        return undefined as unknown as T;
    }
  }

  async listen<T = unknown>(
    event: string,
    handler: (event: BackendEvent<T>) => void,
  ): Promise<UnlistenFn> {
    if (event === 'tasks-updated') {
      // Re-scan + reparse on any vault mutation, debounced to coalesce bursts.
      let timer: ReturnType<typeof setTimeout> | null = null;
      const fire = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          void this.scanTasks().then((tasks) => {
            handler({ payload: tasks as unknown as T });
          });
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

    // global-quickadd / tray-open-task / deep-link-received: not applicable.
    return () => {};
  }

  async openExternal(url: string): Promise<void> {
    if (url.startsWith('obsidian://') || url.startsWith('[[')) {
      const target = url.replace(/^obsidian:\/\//, '').replace(/^\[\[|\]\]$/g, '');
      this.app.workspace.openLinkText(target, '', false);
      return;
    }
    window.open(url, '_blank');
  }

  async pickDirectory(_title: string): Promise<string | null> {
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

// ── Module-level pure helpers ──────────────────────────────────────────────

/** Extract `[[wikilink]]` targets from text. */
function extractWikilinks(text: string): string[] {
  const out: string[] = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

/** Apply a partial update payload onto a task (the optimistic merge shape). */
function applyTaskPayload(task: Task, payload: TaskUpdatePayload): Task {
  const next: Task = { ...task };
  if (payload.title !== undefined) next.title = payload.title;
  if (payload.notes !== undefined) next.notes = payload.notes;
  if (payload.when !== undefined) next.when = normalizeWhen(payload.when, todayStr());
  if (payload.deadline !== undefined) next.deadline = payload.deadline;
  if (payload.tags !== undefined) next.tags = payload.tags;
  if (payload.completed !== undefined) {
    next.completed = payload.completed;
    next.completedDate = payload.completed ? (task.completedDate ?? todayStr()) : null;
  }
  if (payload.projects !== undefined) next.projects = payload.projects;
  if (payload.priority !== undefined) next.priority = payload.priority;
  if (payload.durationMinutes !== undefined) next.durationMinutes = payload.durationMinutes;
  if (payload.scheduledTime !== undefined) next.scheduledTime = payload.scheduledTime;
  return next;
}

/** Convert `today`/`tomorrow` symbolic when-values into concrete dates. */
function normalizeWhen(when: WhenValue, today: string): WhenValue {
  if (when === 'today') return { date: today };
  if (when === 'tomorrow') {
    const d = new Date(`${today}T00:00:00`);
    d.setDate(d.getDate() + 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return { date: `${y}-${m}-${day}` };
  }
  return when;
}

/** Friendly daily-note heading, e.g. "Monday, June 15, 2026". */
function formatLongDate(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/** Body of a markdown file with its leading YAML frontmatter block removed. */
function stripFrontmatter(content: string): string {
  const end = frontmatterEndIndex(content);
  return end >= 0 ? content.slice(end) : content;
}

/** Index just past the closing `---` line of a leading frontmatter block, or -1. */
function frontmatterEndIndex(content: string): number {
  if (!content.startsWith('---')) return -1;
  const rest = content.slice(3);
  const close = rest.indexOf('\n---');
  if (close < 0) return -1;
  const after = close + 4; // past "\n---"
  const nl = rest.indexOf('\n', after);
  return 3 + (nl < 0 ? rest.length : nl + 1);
}

/** A short, content-addressed id for a new recurring template. */
function generateTemplateId(): string {
  const seed = `${Date.now()}-${Math.random()}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0') + Date.now().toString(16).slice(-4);
}

/** Filesystem-safe filename stem (mirrors the Tauri `sanitize_filename`). */
function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '-').trim() || 'untitled';
}
