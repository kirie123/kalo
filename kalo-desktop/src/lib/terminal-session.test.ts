import { describe, expect, it, vi } from "vitest";
import type { TerminalExitInfo } from "../types";
import {
  exitNotice,
  startTerminalSession,
  type FitAddonLike,
  type TerminalLike,
  type TerminalPtyBridge,
  type TerminalSessionDeps,
} from "./terminal-session";

/** Let every pending microtask/await in `init()` run to the next step. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeTerm() {
  let dataCb: ((data: string) => void) | null = null;
  const term: TerminalLike = {
    cols: 80,
    rows: 24,
    open: vi.fn(),
    write: vi.fn(),
    reset: vi.fn(),
    dispose: vi.fn(),
    loadAddon: vi.fn(),
    onData: vi.fn((cb: (data: string) => void) => {
      dataCb = cb;
    }),
  };
  return { term, emitData: (data: string) => dataCb?.(data) };
}

function makePty() {
  let outputCb: ((chunk: string) => void) | null = null;
  let exitCb: ((info: TerminalExitInfo) => void) | null = null;
  const onOutput = vi.fn(async (_id: string, cb: (chunk: string) => void) => {
      outputCb = cb;
      return () => {
        outputCb = null;
      };
    });
  const onExit = vi.fn(async (_id: string, cb: (info: TerminalExitInfo) => void) => {
      exitCb = cb;
      return () => {
        exitCb = null;
      };
    });
  // Left unannotated so tests can reach the mock handles; the structural
  // check happens where it is assigned to TerminalSessionDeps below.
  const pty = {
    open: vi.fn(async (_args: { id: string; cwd: string | null; cols: number; rows: number }) => {}),
    write: vi.fn(async (_id: string, _data: string) => {}),
    resize: vi.fn(async (_id: string, _cols: number, _rows: number) => {}),
    close: vi.fn(async (_id: string) => {}),
    onOutput,
    onExit,
  } satisfies TerminalPtyBridge;
  return {
    pty,
    emitOutput: (chunk: string) => outputCb?.(chunk),
    emitExit: (info: TerminalExitInfo) => exitCb?.(info),
  };
}

function makeDeps() {
  const { term, emitData } = makeTerm();
  const fit: FitAddonLike = { fit: vi.fn() };
  const { pty, emitOutput, emitExit } = makePty();
  const disconnect = vi.fn();
  let resizeCb: (() => void) | null = null;
  const onError = vi.fn();
  const deps: TerminalSessionDeps = {
    id: "t-1",
    cwd: "/tmp/work",
    pty,
    loadXterm: async () => ({ createTerminal: () => term, createFitAddon: () => fit }),
    el: {},
    observeResize: (_el, cb) => {
      resizeCb = cb;
      return { disconnect };
    },
    onError,
  };
  return { deps, term, fit, pty, emitOutput, emitExit, emitData, disconnect, triggerResize: () => resizeCb?.(), onError };
}

describe("startTerminalSession", () => {
  it("subscribes before spawning and opens with the fitted grid", async () => {
    const { deps, term, fit, pty } = makeDeps();
    startTerminalSession(deps);
    await flush();

    expect(term.open).toHaveBeenCalledWith(deps.el);
    expect(fit.fit).toHaveBeenCalled();
    // Output emitted during spawn is the easiest thing to lose: the listeners
    // must exist before `open` starts the shell.
    expect(pty.onOutput.mock.invocationCallOrder[0]).toBeLessThan(pty.open.mock.invocationCallOrder[0]);
    expect(pty.open).toHaveBeenCalledWith({ id: "t-1", cwd: "/tmp/work", cols: 80, rows: 24 });
  });

  it("writes shell output into the terminal", async () => {
    const { deps, term, emitOutput } = makeDeps();
    startTerminalSession(deps);
    await flush();
    emitOutput("hello\r\n");
    expect(term.write).toHaveBeenCalledWith("hello\r\n");
  });

  it("forwards typed data to the pty", async () => {
    const { deps, pty, emitData } = makeDeps();
    startTerminalSession(deps);
    await flush();
    emitData("ls\n");
    await flush();
    expect(pty.write).toHaveBeenCalledWith("t-1", "ls\n");
  });

  it("prints an exit notice when the shell ends on its own", async () => {
    const { deps, term, emitExit } = makeDeps();
    startTerminalSession(deps);
    await flush();
    emitExit({ code: 0 });
    expect(term.write).toHaveBeenCalledWith(exitNotice({ code: 0 }));
  });

  it("refits and resizes the pty when the container changes", async () => {
    const { deps, fit, pty, triggerResize } = makeDeps();
    startTerminalSession(deps);
    await flush();
    triggerResize();
    await flush();
    expect(fit.fit).toHaveBeenCalledTimes(2);
    expect(pty.resize).toHaveBeenCalledWith("t-1", 80, 24);
  });

  it("dispose tears down the terminal, the listeners, the observer, and the shell", async () => {
    const { deps, term, pty, disconnect } = makeDeps();
    const session = startTerminalSession(deps);
    await flush();
    session.dispose();
    expect(term.dispose).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalled();
    expect(pty.close).toHaveBeenCalledWith("t-1");
  });

  it("is idempotent", async () => {
    const { deps, pty } = makeDeps();
    const session = startTerminalSession(deps);
    await flush();
    session.dispose();
    session.dispose();
    expect(pty.close).toHaveBeenCalledTimes(1);
  });

  it("dispose before xterm loads never spawns a shell", async () => {
    const { deps, term, pty } = makeDeps();
    const loaded = deferred<Awaited<ReturnType<TerminalSessionDeps["loadXterm"]>>>();
    deps.loadXterm = () => loaded.promise;
    const session = startTerminalSession(deps);
    session.dispose();
    loaded.resolve({ createTerminal: () => term, createFitAddon: () => ({ fit: vi.fn() }) });
    await flush();
    expect(pty.open).not.toHaveBeenCalled();
    expect(pty.close).not.toHaveBeenCalled();
  });

  it("dispose while the output listener is registering unsubscribes and never spawns", async () => {
    const { deps, term, pty } = makeDeps();
    const unlisten = vi.fn();
    const pending = deferred<() => void>();
    pty.onOutput.mockReturnValueOnce(pending.promise);
    const session = startTerminalSession(deps);
    await flush();
    session.dispose();
    pending.resolve(unlisten);
    await flush();
    expect(unlisten).toHaveBeenCalled();
    expect(pty.open).not.toHaveBeenCalled();
    expect(term.dispose).toHaveBeenCalled();
  });

  it("dispose while the shell is spawning closes the fresh shell", async () => {
    const { deps, pty } = makeDeps();
    const spawning = deferred<void>();
    vi.mocked(pty.open).mockReturnValueOnce(spawning.promise);
    const session = startTerminalSession(deps);
    await flush();
    session.dispose();
    spawning.resolve();
    await flush();
    // The backend created the process after the unmount: it must not outlive
    // the tab. (Two closes are fine — the dispose-time close can race ahead of
    // the backend's spawn.)
    expect(pty.close).toHaveBeenCalledWith("t-1");
  });

  it("reports start-up failures instead of swallowing them", async () => {
    const { deps, onError } = makeDeps();
    const boom = new Error("xterm failed");
    deps.loadXterm = async () => {
      throw boom;
    };
    startTerminalSession(deps);
    await flush();
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it("reports a failed spawn", async () => {
    const { deps, pty, onError } = makeDeps();
    const boom = new Error("pty refused");
    pty.open.mockRejectedValueOnce(boom);
    startTerminalSession(deps);
    await flush();
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it("a hidden container does not abort the session", async () => {
    const { deps, term, pty, fit } = makeDeps();
    fit.fit = vi.fn(() => {
      throw new Error("zero-sized");
    });
    startTerminalSession(deps);
    await flush();
    expect(pty.open).toHaveBeenCalled();
    expect(term.dispose).not.toHaveBeenCalled();
  });
});

describe("exitNotice", () => {
  it("includes the exit code", () => {
    expect(exitNotice({ code: 1 })).toContain("进程已退出（代码 1）");
  });

  it("omits the code when the process was signalled", () => {
    const notice = exitNotice({ code: null });
    expect(notice).toContain("进程已退出");
    expect(notice).not.toContain("代码");
  });

  it("resets the line so the notice starts on a fresh row", () => {
    expect(exitNotice({ code: 0 }).startsWith("\r\n")).toBe(true);
  });
});