import type { ProjectDocument } from '../io/project';

export interface HistoryEntry {
  label: string;
  document: ProjectDocument;
}

/**
 * Snapshot-based undo.
 *
 * Structural operations rewrite topology in ways that are painful to invert
 * step by step, and a whole-document snapshot is fast enough well past the
 * scale this editor targets. History is capped so memory stays bounded.
 */
export class History {
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];

  constructor(private readonly limit = 64) {}

  /** Call with the document as it looks *before* the mutation. */
  record(label: string, document: ProjectDocument): void {
    this.past.push({ label, document });
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  /**
   * Forgets the newest entry.
   *
   * A modal transform records before it starts moving anything, because that is
   * the only moment the document is still untouched. Cancelling it puts
   * everything back, so the entry it recorded would undo to the state it is
   * already in.
   */
  drop(): void {
    this.past.pop();
  }

  undo(current: ProjectDocument): HistoryEntry | null {
    const entry = this.past.pop();
    if (!entry) return null;
    this.future.push({ label: entry.label, document: current });
    return entry;
  }

  redo(current: ProjectDocument): HistoryEntry | null {
    const entry = this.future.pop();
    if (!entry) return null;
    this.past.push({ label: entry.label, document: current });
    return entry;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get undoLabel(): string | null {
    return this.past[this.past.length - 1]?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.future[this.future.length - 1]?.label ?? null;
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }
}
