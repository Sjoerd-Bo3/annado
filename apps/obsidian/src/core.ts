/**
 * The single entry point to the Rust→WASM core for the Obsidian plugin.
 *
 * Everything the plugin needs from the engine — parsing, line surgery,
 * recurrence math, ICS expansion — is re-exported here so `ObsidianBackend`
 * imports from one place and the wasm lifecycle lives in one place.
 *
 * Loading model: the package is built with `--target web`, which expects an
 * async `init()` that fetches the sibling `.wasm`. Inside Obsidian (especially
 * mobile) a relative fetch isn't reliable, so esbuild's `base64` loader inlines
 * the `.wasm` bytes into the bundle and we instantiate them synchronously via
 * `initSync`. The result: a single self-contained `main.js`, no runtime fetch.
 *
 * Call {@link initCore} once before any other export (the plugin does this in
 * `onload`). All engine functions are synchronous and pure; the host
 * orchestrates the async Vault I/O around them.
 */
import { initSync } from 'annado-core';
import wasmBase64 from 'annado-core/annado_core_bg.wasm';

export {
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
} from 'annado-core';

let initialized = false;

/** Decode a base64 string to bytes without relying on Node's `Buffer`. */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Instantiate the wasm engine. Idempotent — safe to call more than once.
 * Must run before any other export is invoked.
 */
export function initCore(): void {
  if (initialized) return;
  initSync({ module: base64ToBytes(wasmBase64) });
  initialized = true;
}
