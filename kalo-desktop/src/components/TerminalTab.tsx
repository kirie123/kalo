/**
 * One shell tab: an interactive PTY mounted in one xterm instance.
 *
 * All lifecycle logic (including unmount-during-await) is in
 * `lib/terminal-session.ts`; this file only wires the real xterm loader, the
 * real ResizeObserver and the pi-bridge pty commands. Unmount kills the shell
 * tree — a closed tab must not leave a process behind.
 */

import { useEffect, useRef } from "react";
import { chatStore } from "../lib/chat-store";
import { errText } from "../lib/chat-store-helpers";
import {
  onTerminalExit,
  onTerminalOutput,
  terminalClose,
  terminalOpen,
  terminalResize,
  terminalWrite,
} from "../lib/pi-bridge";
import { startTerminalSession } from "../lib/terminal-session";
import { loadXterm } from "./xterm";

export default function TerminalTab({ id, cwd }: { id: string; cwd: string | null }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const session = startTerminalSession({
      id,
      cwd,
      pty: {
        open: terminalOpen,
        write: terminalWrite,
        resize: terminalResize,
        close: terminalClose,
        onOutput: onTerminalOutput,
        onExit: onTerminalExit,
      },
      loadXterm,
      el,
      observeResize: (target, cb) => {
        const observer = new ResizeObserver(cb);
        observer.observe(target as Element);
        return { disconnect: () => observer.disconnect() };
      },
      onError: (err) => chatStore.pushToast(`终端启动失败：${errText(err)}`, "error"),
    });
    return () => session.dispose();
  }, [id, cwd]);

  return <div ref={containerRef} className="h-full w-full overflow-hidden bg-[#1a1a1a] p-1" />;
}