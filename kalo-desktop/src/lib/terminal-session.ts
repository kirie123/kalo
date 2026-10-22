/**
 * Lifecycle of one xterm terminal wired to a pty.
 *
 * The trap this file exists for: **unmount can land inside any `await`**.
 * The component's cleanup has already run by then (the terminal does not exist
 * yet, the listeners are not registered), and a naive `init()` keeps going —
 * producing an xterm nobody can dispose, a pty that lives until the app exits,
 * and listeners that keep writing into a torn-down component. So every await
 * is followed by one question: still alive? If not, tear down *exactly what
 * exists at that point*.
 *
 * Why this is testable: xterm, the resize observer and the pty are all
 * injected (`loadXterm` / `observeResize` / `pty`), so Node tests can drive
 * unmount-during-await precisely without importing `@xterm` or touching the
 * DOM (same split as the repo's other lib/ adapters).
 */

import type { TerminalExitInfo } from "../types";

/** The subset of xterm's Terminal this module drives. */
export interface TerminalLike {
  readonly cols: number;
  readonly rows: number;
  open(el: unknown): void;
  write(data: string): void;
  reset(): void;
  dispose(): void;
  onData(cb: (data: string) => void): void;
  loadAddon(addon: unknown): void;
}

export interface FitAddonLike {
  fit(): void;
}

/** The pty commands this module needs; wired to pi-bridge at the call site. */
export interface TerminalPtyBridge {
  open(args: { id: string; cwd: string | null; cols: number; rows: number }): Promise<void>;
  write(id: string, data: string): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  close(id: string): Promise<void>;
  onOutput(id: string, cb: (chunk: string) => void): Promise<() => void>;
  onExit(id: string, cb: (info: TerminalExitInfo) => void): Promise<() => void>;
}

export interface TerminalSessionDeps {
  id: string;
  cwd: string | null;
  pty: TerminalPtyBridge;
  /** Dynamic import lives at the call site: lib stays xterm-free. */
  loadXterm(): Promise<{ createTerminal(): TerminalLike; createFitAddon(): FitAddonLike }>;
  /** The element xterm mounts into. */
  el: unknown;
  /** Container size changes: refit xterm, then tell the pty the new grid. */
  observeResize(el: unknown, cb: () => void): { disconnect(): void };
  /** Start-up failures the user should hear about (toast), not swallow. */
  onError(err: unknown): void;
}

export interface TerminalSession {
  /** Idempotent; React's cleanup and a mid-init bail-out both call it. */
  dispose(): void;
}

/** The notice appended to the terminal when the shell exits on its own. */
export function exitNotice(info: TerminalExitInfo): string {
  const code = info.code === null ? "" : `（代码 ${info.code}）`;
  return `\r\n\x1b[90m[进程已退出${code}]\x1b[0m\r\n`;
}

export function startTerminalSession(deps: TerminalSessionDeps): TerminalSession {
  let disposed = false;
  /** Set right before the pty is actually asked to spawn: closing a session
   *  that was never created would target an id the backend does not know. */
  let opened = false;
  let term: TerminalLike | null = null;
  let fit: FitAddonLike | null = null;
  let observer: { disconnect(): void } | null = null;
  const unlisten: Array<() => void> = [];

  function dispose() {
    if (disposed) return;
    disposed = true;
    observer?.disconnect();
    observer = null;
    for (const off of unlisten.splice(0)) off();
    term?.dispose();
    term = null;
    if (opened) void deps.pty.close(deps.id).catch(() => undefined);
  }

  async function init() {
    const xterm = await deps.loadXterm();
    if (disposed) return;
    term = xterm.createTerminal();
    fit = xterm.createFitAddon();
    term.loadAddon(fit);
    term.open(deps.el);

    // Listeners before spawn: the backend starts the shell as part of
    // `open`, and output emitted between spawn and subscription would be lost.
    const offOutput = await deps.pty.onOutput(deps.id, (chunk) => term?.write(chunk));
    if (disposed) return offOutput();
    unlisten.push(offOutput);

    const offExit = await deps.pty.onExit(deps.id, (info) => term?.write(exitNotice(info)));
    if (disposed) return offExit();
    unlisten.push(offExit);

    term.onData((data) => {
      void deps.pty.write(deps.id, data).catch(() => undefined);
    });

    // A hidden container fits to nothing; defaults hold until a resize fires.
    try {
      fit.fit();
    } catch {
      // xterm's fit addon throws on a zero-sized element — fine.
    }

    opened = true;
    await deps.pty.open({ id: deps.id, cwd: deps.cwd, cols: term.cols, rows: term.rows });
    if (disposed) {
      // Unmounted while spawning: the shell exists now, kill it.
      void deps.pty.close(deps.id).catch(() => undefined);
      return;
    }

    observer = deps.observeResize(deps.el, () => {
      if (disposed || !term) return;
      try {
        fit?.fit();
      } catch {
        /* element hidden */
      }
      void deps.pty.resize(deps.id, term.cols, term.rows).catch(() => undefined);
    });
  }

  void init().catch((err) => deps.onError(err));
  return { dispose };
}