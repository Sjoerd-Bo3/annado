import { ItemView, WorkspaceLeaf } from 'obsidian';
import { StrictMode, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from '@app/App';

export const VIEW_TYPE_ANNADO = 'annado-view';

/**
 * Hosts the shared Annado React `App` inside an Obsidian main-area leaf.
 *
 * The root is wrapped in `<div class="annado-root">` so PR 4 can scope the
 * bespoke Tailwind/design CSS to this subtree without bleeding into the rest
 * of Obsidian.
 */
export class AnnadoView extends ItemView {
  private root: Root | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_ANNADO;
  }

  getDisplayText(): string {
    return 'Annado';
  }

  getIcon(): string {
    return 'check-circle';
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    const mount = this.contentEl.createDiv({ cls: 'annado-root' });
    // "Hosted in a leaf" flag. A leaf is a sub-pane, not the viewport, so the
    // shared App's full-viewport sizing (h-screen / 100vh) must collapse to
    // 100% of this container. styles.css keys its leaf overrides off this
    // attribute; the Tauri app never sets it and keeps full-viewport sizing.
    mount.dataset.annadoHost = 'obsidian-leaf';
    this.root = createRoot(mount);
    this.root.render(createElement(StrictMode, null, createElement(App)));
  }

  async onClose(): Promise<void> {
    this.root?.unmount();
    this.root = null;
    this.contentEl.empty();
  }
}
