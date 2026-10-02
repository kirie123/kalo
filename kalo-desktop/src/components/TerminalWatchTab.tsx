/**
 * Read-only mirror of one bash command's live output, rendered in a terminal.
 *
 * The data comes from `tool-watch-registry` (fed by chat-store, active or
 * parked runtime alike), the incremental writing from `lib/terminal-watch`.
 * The terminal is `disableStdin` — the command runs inside the engine's
 * process, not under this pty, so there is nothing to type into it.
 */

import { useCallback, useEffect, useRef } from "react";
import type { PanelTab } from "../lib/panel-tabs";
import type { TerminalLike } from "../lib/terminal-session";
import { watchFeed, watchText } from "../lib/terminal-watch";
import { useToolWatch } from "../lib/tool-watch-registry";
import { loadXterm } from "./xterm";

type WatchTab = Extract<PanelTab, { kind: "watch" }>;

export default function TerminalWatchTab({ tab }: { tab: WatchTab }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<TerminalLike | null>(null);
  /** Everything already written to the terminal (the snapshot's tail). */
  const writtenRef = useRef("");
  /** The end notice is written once, on the running → settled transition. */
  const settledRef = useRef(false);
  const snapshot = useToolWatch(tab.toolCallId);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  /** Write whatever the snapshot grew by; a no-op before the terminal mounts. */
  const feed = useCallback(() => {
    const term = termRef.current;
    const snap = snapshotRef.current;
    if (!term || !snap) return;
    const text = watchText(snap);
    const step = watchFeed(writtenRef.current, text);
    if (step) {
      writtenRef.current = text;
      // The engine's snapshot is a rolling tail; when it stops being an
      // extension of what we wrote, the view has to start over.
      if (step.mode === "reset") term.reset();
      term.write(step.text);
    }
    if (snap.status !== "running" && !settledRef.current) {
      settledRef.current = true;
      term.write(`\r\n\x1b[90m[${snap.status === "error" ? "命令失败" : "命令结束"}]\x1b[0m\r\n`);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let term: TerminalLike | null = null;
    let observer: ResizeObserver | null = null;
    writtenRef.current = "";
    settledRef.current = false;
    void (async () => {
      const xterm = await loadXterm();
      const host = containerRef.current;
      if (disposed || !host) return;
      term = xterm.createTerminal({ readOnly: true });
      const fit = xterm.createFitAddon();
      term.loadAddon(fit);
      term.open(host);
      // Command echo, like a shell prompt: dim, newlines flattened.
      term.write(`\x1b[90m$ ${tab.command.replace(/[\r\n]+/g, " ")}\x1b[0m\r\n\r\n`);
      try {
        fit.fit();
      } catch {
        /* hidden container keeps the default grid */
      }
      termRef.current = term;
      observer = new ResizeObserver(() => {
        try {
          fit.fit();
        } catch {
          /* hidden */
        }
      });
      observer.observe(host);
      feed();
    })();
    return () => {
      disposed = true;
      observer?.disconnect();
      observer = null;
      term?.dispose();
      term = null;
      termRef.current = null;
    };
  }, [tab.id, tab.command, feed]);

  useEffect(() => {
    feed();
  }, [snapshot, feed]);

  return <div ref={containerRef} className="h-full w-full overflow-hidden bg-[#1a1a1a] p-1" />;
}