// SSR-environment stand-ins for the CodeMirror editor graph (wired through the
// SSR-guarded `resolveId` hook in vite.config.ts). Authed routes are
// client-only (`ssr: false`) and /share is read-only, so the Workers server
// build never mounts an editor; the browser build keeps the real packages.
// Every export is inert but call-shaped: importing or touching the module must
// not throw while the server bundle links its routes.
const extension = () => ({ of: () => extension(), is: () => false });

export const Annotation = { define: () => extension() };
export const StateEffect = { define: () => extension(), reconfigure: extension() };
export const StateField = { define: () => extension() };
export const Prec = {
  highest: <T>(value: T): T => value,
  high: <T>(value: T): T => value,
  default: <T>(value: T): T => value,
  low: <T>(value: T): T => value,
  lowest: <T>(value: T): T => value,
};

export class EditorState {
  static create(): Record<string, never> {
    return {};
  }
  static tabSize = extension();
  static transactionFilter = extension();
}

export class EditorView {
  static theme(): Record<string, never> {
    return {};
  }
  static domEventHandlers(): Record<string, never> {
    return {};
  }
  static updateListener = extension();
  static contentAttributes = extension();
  constructor(_args?: unknown) {}
  state: Record<string, never> = {};
  dispatch(_transaction?: unknown): void {}
  setState(_state?: unknown): void {}
}

export class ViewPlugin {
  static fromClass(_value: unknown): Record<string, never> {
    return {};
  }
}

export class Transaction {
  static addToHistory = extension();
}

export const getDefaultExtensions = (): unknown[] => [];
export const markdown = (): unknown[] => [];
export const ensureSyntaxTree = (): null => null;
export const invertedEffects = extension();
export const isolateHistory = extension();
export const redo = (): boolean => true;
export const undo = (): boolean => true;
