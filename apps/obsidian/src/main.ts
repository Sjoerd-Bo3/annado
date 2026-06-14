import { Plugin, WorkspaceLeaf } from 'obsidian';
import { setBackend } from '@app/backend';
import { AnnadoView, VIEW_TYPE_ANNADO } from './AnnadoView';
import { ObsidianBackend } from './ObsidianBackend';

/**
 * The Annado Obsidian plugin entry point.
 *
 * On load it injects an {@link ObsidianBackend} into the shared UI's platform
 * seam (`setBackend`), registers a main-area leaf that mounts the shared React
 * `App`, and exposes a ribbon icon + command to open it.
 *
 * PR 2 scope: this scaffolds the host. The data layer (tasks, projects, etc.)
 * is stubbed in ObsidianBackend until the WASM core lands in PR 3.
 */
export default class AnnadoPlugin extends Plugin {
  async onload(): Promise<void> {
    // Swap the UI's platform/data boundary over to Obsidian before any view mounts.
    setBackend(new ObsidianBackend(this.app, this));

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
  }

  onunload(): void {
    // Detaching the leaves triggers AnnadoView.onClose(), which unmounts React.
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_ANNADO);
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
}
