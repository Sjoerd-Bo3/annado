import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getVersion } from '@tauri-apps/api/app';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { Backend, BackendEvent, UnlistenFn } from './types';

/**
 * The Tauri implementation of {@link Backend}. This is the ONLY module in the
 * app (besides its tests) that imports `@tauri-apps/*`.
 */
export class TauriBackend implements Backend {
  invoke<T = void>(command: string, args?: Record<string, unknown>): Promise<T> {
    return tauriInvoke<T>(command, args);
  }

  listen<T = unknown>(event: string, handler: (event: BackendEvent<T>) => void): Promise<UnlistenFn> {
    return tauriListen<T>(event, handler);
  }

  openExternal(url: string): Promise<void> {
    return openUrl(url);
  }

  async pickDirectory(title: string): Promise<string | null> {
    const selected = await openDialog({ directory: true, title });
    return typeof selected === 'string' ? selected : null;
  }

  getAppVersion(): Promise<string> {
    return getVersion();
  }

  getWindowLabel(): string {
    return getCurrentWindow().label;
  }

  startWindowDrag(): void {
    void getCurrentWindow().startDragging();
  }

  hideWindow(): Promise<void> {
    return getCurrentWindow().hide();
  }

  setWindowBackground(rgb: [number, number, number]): Promise<void> {
    // no-op outside Tauri (vitest, plain browser)
    return getCurrentWindow().setBackgroundColor(rgb).catch(() => {});
  }
}
