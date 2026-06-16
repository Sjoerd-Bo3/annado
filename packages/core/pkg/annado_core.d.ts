/* tslint:disable */
/* eslint-disable */

/**
 * Apply an updated `Task` (JS object) to `contents`, returning the new file
 * contents. `file_project` may be `null`; `project_names` is `string[]`.
 */
export function apply_task_update(contents: string, task: any, today: string, file_project: string | null | undefined, project_names: any): string;

/**
 * Render the date portion of a daily-note path (moment.js `format`).
 */
export function daily_note_date_path(today: string, format: string): string;

export function delete_checklist_item(contents: string, task_line_number: number, item_index: number): string;

export function delete_task(contents: string, task_line_number: number, task_indent: number): string;

/**
 * Expand an ICS feed body into `CalendarEvent[]` for `sub` (JS object) within
 * `[window_start, window_end]` (RFC 3339 / ISO-8601 strings, e.g.
 * `2026-06-14T00:00:00Z`). No network access happens here — the host fetches
 * the feed and passes the text in.
 */
export function expand_ics(ics_text: string, sub: any, window_start: string, window_end: string): any;

/**
 * Format a single `Task` (JS object) back to its markdown line.
 * `file_project` may be `null`; `project_names` is `string[]`.
 */
export function format_task_line(task: any, today: string, file_project: string | null | undefined, project_names: any): string;

/**
 * Parse a markdown file's `contents` into the task list. `today` is
 * `YYYY-MM-DD`. Returns `Task[]`.
 */
export function parse_file(path: string, contents: string, today: string): any;

export function rename_checklist_item(contents: string, task_line_number: number, item_index: number, new_title: string): string;

/**
 * Whether a recurring template (JS object) should generate a new instance as of
 * `today` (`YYYY-MM-DD`).
 */
export function should_generate_instance(template: any, today: string): boolean;

/**
 * The list of `CalendarInfo` produced by a set of ICS subscriptions
 * (`IcsSubscription[]`). Mirrors `calendar::subscription_calendars`.
 */
export function subscription_calendars(subs: any): any;

export function toggle_checklist_item(contents: string, task_line_number: number, item_index: number): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly apply_task_update: (a: number, b: number, c: any, d: number, e: number, f: number, g: number, h: any) => [number, number, number, number];
    readonly daily_note_date_path: (a: number, b: number, c: number, d: number) => [number, number];
    readonly delete_checklist_item: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly delete_task: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly expand_ics: (a: number, b: number, c: any, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly format_task_line: (a: any, b: number, c: number, d: number, e: number, f: any) => [number, number, number, number];
    readonly parse_file: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly rename_checklist_item: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly should_generate_instance: (a: any, b: number, c: number) => [number, number, number];
    readonly subscription_calendars: (a: any) => [number, number, number];
    readonly toggle_checklist_item: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
