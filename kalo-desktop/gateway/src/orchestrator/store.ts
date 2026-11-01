import { Database } from "bun:sqlite";
import type { Task } from "./model";

/** Open only after the gateway owns the data-root singleton lock. */
export class TaskStore {
  private db: Database;
  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.db.exec("CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);");
  }
  atomic<T>(fn: () => T): T { return this.db.transaction(fn)(); }
  all(): Task[] {
    return (this.db.query("SELECT body FROM tasks").all() as { body: string }[]).map(row => JSON.parse(row.body) as Task);
  }
  get(id: string): Task {
    const row = this.db.query("SELECT body FROM tasks WHERE id=?").get(id) as { body: string } | null;
    if (!row) throw new Error("任务不存在，请刷新列表");
    return JSON.parse(row.body) as Task;
  }
  put(task: Task): void { this.db.query("INSERT OR REPLACE INTO tasks(id,body) VALUES(?,?)").run(task.id, JSON.stringify(task)); }
  once(id: string, fingerprint: string, fn: () => void): void {
    this.atomic(() => {
      const previous = this.db.query("SELECT fingerprint FROM actions WHERE id=?").get(id) as { fingerprint: string } | null;
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error("动作 ID 已用于不同请求");
        return;
      }
      fn();
      this.db.query("INSERT INTO actions(id,fingerprint) VALUES(?,?)").run(id, fingerprint);
    });
  }
  close(): void { this.db.close(); }
}
