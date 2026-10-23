export interface NoteSnapshot { path: string; text: string }

/** One ordered writer shared by autosave, explicit save and navigation. Failed writes do not poison the queue. */
export class NoteSaveQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private saved = new Map<string, string>();

  constructor(private write: (snapshot: NoteSnapshot) => Promise<unknown>) {}

  enqueue(snapshot: NoteSnapshot): Promise<void> {
    const task = this.tail.then(async () => {
      if (this.saved.get(snapshot.path) === snapshot.text) return;
      await this.write(snapshot);
      this.saved.set(snapshot.path, snapshot.text);
    });
    this.tail = task.catch(() => {});
    return task;
  }

  async idle(): Promise<void> { await this.tail; }

  forget(path: string): void { this.saved.delete(path); }
}
