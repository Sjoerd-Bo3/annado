import type { Backend, BackendEvent, UnlistenFn } from './types';
import { TauriBackend } from './tauri';

export type { Backend, BackendEvent, UnlistenFn } from './types';

// The active backend. Defaults to Tauri; a different host (Obsidian plugin,
// web build) calls `setBackend()` once at startup to swap the implementation.
let active: Backend = new TauriBackend();

export function getBackend(): Backend {
  return active;
}

export function setBackend(backend: Backend): void {
  active = backend;
}

// Thin delegators so call sites read almost exactly like the old
// `@tauri-apps/*` imports — only the import source changes.
export function invoke<T = void>(command: string, args?: Record<string, unknown>): Promise<T> {
  return active.invoke<T>(command, args);
}

export function listen<T = unknown>(
  event: string,
  handler: (event: BackendEvent<T>) => void,
): Promise<UnlistenFn> {
  return active.listen<T>(event, handler);
}

export function openExternal(url: string): Promise<void> {
  return active.openExternal(url);
}

export function pickDirectory(title: string): Promise<string | null> {
  return active.pickDirectory(title);
}

export function getAppVersion(): Promise<string> {
  return active.getAppVersion();
}

export function getWindowLabel(): string {
  return active.getWindowLabel();
}

export function startWindowDrag(): void {
  active.startWindowDrag();
}

export function hideWindow(): Promise<void> {
  return active.hideWindow();
}

export function setWindowBackground(rgb: [number, number, number]): Promise<void> {
  return active.setWindowBackground(rgb);
}
