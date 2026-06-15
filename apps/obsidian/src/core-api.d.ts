/**
 * Typed surface of the Rust→WASM core package (`packages/core`), as produced by
 * `wasm-pack build packages/core --target web --out-dir pkg --features wasm`.
 *
 * wasm-pack's own `annado_core.d.ts` types the `serde_wasm_bindgen` boundary as
 * `any` (it can't see through `JsValue`). This declaration narrows those `any`s
 * to the real Annado shapes so `core.ts` — and through it `ObsidianBackend` —
 * is fully type-checked against the engine. The shapes mirror
 * `packages/core/src/{parser,calendar}.rs` (all `#[serde(rename_all =
 * "camelCase")]`) and the app's own `@app/types/task`.
 *
 * Packaging note: `pkg/` is generated (git-ignored) — run the `wasm-pack`
 * command above (the `obsidian` CI job does this) before building the plugin.
 */
declare module 'annado-core' {
  import type {
    Task,
    RecurringTemplate,
    CalendarEvent,
    CalendarInfo,
    IcsSubscription,
  } from '@app/types/task';

  /** Parse one markdown file's contents into its task list. `today` = `YYYY-MM-DD`. */
  export function parse_file(path: string, contents: string, today: string): Task[];

  /** Format a single task back to its markdown line. */
  export function format_task_line(
    task: Task,
    today: string,
    file_project: string | null | undefined,
    project_names: string[],
  ): string;

  /** Apply an updated task to `contents`, returning the new file contents. */
  export function apply_task_update(
    contents: string,
    task: Task,
    today: string,
    file_project: string | null | undefined,
    project_names: string[],
  ): string;

  export function toggle_checklist_item(
    contents: string,
    task_line_number: number,
    item_index: number,
  ): string;

  export function rename_checklist_item(
    contents: string,
    task_line_number: number,
    item_index: number,
    new_title: string,
  ): string;

  export function delete_checklist_item(
    contents: string,
    task_line_number: number,
    item_index: number,
  ): string;

  export function delete_task(
    contents: string,
    task_line_number: number,
    task_indent: number,
  ): string;

  /** Render the date portion of a daily-note path (moment.js `format`). */
  export function daily_note_date_path(today: string, format: string): string;

  /** Whether a recurring template should generate a new instance as of `today`. */
  export function should_generate_instance(
    template: RecurringTemplate,
    today: string,
  ): boolean;

  /** Expand an ICS feed body into events for `sub` within the window (ISO-8601). */
  export function expand_ics(
    ics_text: string,
    sub: IcsSubscription,
    window_start: string,
    window_end: string,
  ): CalendarEvent[];

  /** The `CalendarInfo[]` produced by a set of ICS subscriptions. */
  export function subscription_calendars(subs: IcsSubscription[]): CalendarInfo[];

  export type SyncInitInput = BufferSource | WebAssembly.Module;

  /** Synchronously instantiate the wasm module from bytes (or a compiled module). */
  export function initSync(module: { module: SyncInitInput } | SyncInitInput): unknown;

  /** Async init: fetches/instantiates the `.wasm`. `default` export of the pkg. */
  export default function init(
    module_or_path?: { module_or_path: unknown } | unknown,
  ): Promise<unknown>;
}

/**
 * esbuild's `base64` loader turns the bundled `.wasm` into a base64 string.
 * `core.ts` decodes it and hands the bytes to `initSync`, so the whole engine
 * ships inside `main.js` (no runtime `.wasm` fetch — important on mobile).
 */
declare module 'annado-core/annado_core_bg.wasm' {
  const wasmBase64: string;
  export default wasmBase64;
}
