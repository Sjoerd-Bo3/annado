/**
 * The platform/data boundary for the whole UI.
 *
 * Every call the React app makes into "the outside world" — backend commands,
 * file-change events, opening URLs, picking a folder, window chrome — goes
 * through this `Backend` interface. The app imports from `../backend`, never
 * from `@tauri-apps/*` directly, so the entire UI is host-agnostic: the Tauri
 * app injects `TauriBackend`, and an Obsidian plugin (or a web build) injects
 * its own implementation of the same interface.
 */

/** Mirrors Tauri's event shape so call sites read `e.payload` unchanged. */
export interface BackendEvent<T> {
  payload: T;
}

export type UnlistenFn = () => void;

export interface Backend {
  /** Invoke a backend command by name (the Tauri command contract). */
  invoke<T = void>(command: string, args?: Record<string, unknown>): Promise<T>;
  /** Subscribe to a backend-emitted event; resolves to an unsubscribe fn. */
  listen<T = unknown>(event: string, handler: (event: BackendEvent<T>) => void): Promise<UnlistenFn>;

  /** Open a URL/external link (https://, obsidian://, vscode://, file://, …). */
  openExternal(url: string): Promise<void>;
  /** Show a folder picker; resolves to the chosen path or null if cancelled. */
  pickDirectory(title: string): Promise<string | null>;
  /** The application version string. */
  getAppVersion(): Promise<string>;

  // Window chrome — no-ops outside a standalone OS window (e.g. an Obsidian leaf).
  /** The current window's label ("main" / "tray-popup"). */
  getWindowLabel(): string;
  /** Begin dragging the OS window (custom titlebar drag region). */
  startWindowDrag(): void;
  /** Hide the current window. */
  hideWindow(): Promise<void>;
  /** Paint the native window background so resize doesn't flash OS grey. */
  setWindowBackground(rgb: [number, number, number]): Promise<void>;
}
