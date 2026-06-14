import { describe, it, expect, afterEach, vi } from 'vitest';
import { getBackend, setBackend, invoke, openExternal } from './index';
import { TauriBackend } from './tauri';
import type { Backend } from './types';

const original = getBackend();
afterEach(() => setBackend(original));

describe('backend seam', () => {
  it('defaults to the Tauri backend', () => {
    expect(getBackend()).toBeInstanceOf(TauriBackend);
  });

  it('setBackend swaps the active implementation, and delegators follow it', async () => {
    const fake: Backend = {
      invoke: vi.fn().mockResolvedValue(['task']),
      listen: vi.fn().mockResolvedValue(() => {}),
      openExternal: vi.fn().mockResolvedValue(undefined),
      pickDirectory: vi.fn().mockResolvedValue(null),
      getAppVersion: vi.fn().mockResolvedValue('9.9.9'),
      getWindowLabel: vi.fn().mockReturnValue('main'),
      startWindowDrag: vi.fn(),
      hideWindow: vi.fn().mockResolvedValue(undefined),
      setWindowBackground: vi.fn().mockResolvedValue(undefined),
    };
    setBackend(fake);

    await invoke('get_tasks');
    await openExternal('https://example.com');

    expect(fake.invoke).toHaveBeenCalledWith('get_tasks', undefined);
    expect(fake.openExternal).toHaveBeenCalledWith('https://example.com');
  });
});
