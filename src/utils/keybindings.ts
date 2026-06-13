export function matchesKeybinding(e: KeyboardEvent | React.KeyboardEvent, binding: string): boolean {
  const parts = binding.toLowerCase().split('+');
  const key = parts.pop();
  const mods = new Set(parts);

  const modMatch =
    mods.has('meta') === e.metaKey &&
    mods.has('shift') === e.shiftKey &&
    mods.has('ctrl') === e.ctrlKey &&
    mods.has('alt') === e.altKey;

  return modMatch && e.key.toLowerCase() === key;
}

import { PRIMARY_MOD, isMac } from './platform';

// Defaults follow the platform's primary modifier: Cmd on macOS, Ctrl elsewhere.
// Custom bindings persisted by the user always win over these.
const mod = PRIMARY_MOD;

export const KEYBINDING_DEFAULTS: Record<string, string> = {
  moveToProject: `${mod}+shift+m`, quickFind: `${mod}+f`,
  // macOS navigates lists with ctrl+j/k; elsewhere ctrl is the primary
  // modifier (completeTask is ctrl+k), so navigation moves to alt+j/k
  navigateDown: isMac ? 'ctrl+j' : 'alt+j',
  navigateUp: isMac ? 'ctrl+k' : 'alt+k',
  globalQuickAdd: `${mod}+shift+space`, globalShowApp: `${mod}+shift+a`,
  showWhen: `${mod}+s`, showDeadline: `${mod}+d`, startToday: `${mod}+t`,
  deleteTask: `${mod}+backspace`, completeTask: `${mod}+k`, toggleSidePanel: `${mod}+\\`,
  undo: `${mod}+z`,
  viewInbox: `${mod}+1`, viewToday: `${mod}+2`, viewAgenda: `${mod}+3`,
  viewUpcoming: `${mod}+4`, viewAnytime: `${mod}+5`, viewSomeday: `${mod}+6`,
  viewLogbook: `${mod}+7`, viewRecurring: `${mod}+8`, viewWrapped: `${mod}+9`,
  viewAddedToday: `${mod}+0`, viewReview: `${mod}+r`,
};
