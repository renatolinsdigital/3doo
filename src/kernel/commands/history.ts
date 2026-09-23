import type { ProjectDocument } from '../io/project';

export interface HistoryEntry {
  label: string;
  document: ProjectDocument;
}

/**
 * The whole timeline, in a form that can be stored and handed back.
 *
 * Both halves in the order the class holds them: the next undo and the next
 * redo are the last entry of each.
 */
export interface HistorySnapshot {
  past: HistoryEntry[];
  future: HistoryEntry[];
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

  constructor(private limit = 64) {}

  /** Call with the document as it looks *before* the mutation. */
  record(label: string, document: ProjectDocument): void {
    this.past.push({ label, document });
    this.trim();
    this.future = [];
  }

  /**
   * Re-caps the timeline.
   *
   * Every entry holds a whole scene, so the cap is the memory this class costs.
   * Lowering it drops the oldest steps then and there rather than waiting for
   * the next edit, which is the point of lowering it.
   */
  setLimit(limit: number): void {
    this.limit = Math.max(1, Math.floor(limit));
    this.trim();
  }

  private trim(): void {
    if (this.past.length > this.limit) this.past.splice(0, this.past.length - this.limit);
    if (this.future.length > this.limit) this.future.splice(0, this.future.length - this.limit);
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

  /**
   * Travels several steps at once, for a click straight into the timeline.
   *
   * The document each step hands back is the one the next step starts from, so
   * the trip costs no more than a single step does: only the state it lands on
   * is ever loaded into the scene. Runs out quietly at the end of the timeline
   * and reports the last entry it reached.
   */
  undoTimes(count: number, current: ProjectDocument): HistoryEntry | null {
    return this.travel(count, current, (document) => this.undo(document));
  }

  redoTimes(count: number, current: ProjectDocument): HistoryEntry | null {
    return this.travel(count, current, (document) => this.redo(document));
  }

  private travel(
    count: number,
    current: ProjectDocument,
    step: (document: ProjectDocument) => HistoryEntry | null,
  ): HistoryEntry | null {
    let landed: HistoryEntry | null = null;
    let document = current;

    for (let taken = 0; taken < count; taken++) {
      const entry = step(document);
      if (!entry) break;
      landed = entry;
      document = entry.document;
    }

    return landed;
  }

  /** What each undo would take back, newest first: the order a list reads in. */
  get undoLabels(): string[] {
    return this.past.map((entry) => entry.label).reverse();
  }

  /** What each redo would put back, the next one first. */
  get redoLabels(): string[] {
    return this.future.map((entry) => entry.label).reverse();
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

  /**
   * The timeline as plain data, for the autosave to keep.
   *
   * Shallow: the documents are already the immutable snapshots this class was
   * handed, and nothing here edits one in place.
   */
  snapshot(): HistorySnapshot {
    return { past: [...this.past], future: [...this.future] };
  }

  /**
   * Takes a stored timeline back on, in place of whatever is here now.
   *
   * Trimmed on the way in, because the snapshot may have been written while
   * the size preference was higher than it is now.
   */
  restore(snapshot: HistorySnapshot): void {
    this.past = [...snapshot.past];
    this.future = [...snapshot.future];
    this.trim();
  }
}
