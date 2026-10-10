/**
 * xterm loading + theme, shared by the shell tab and the watch tab.
 *
 * xterm is a few hundred KB; the JS payload is dynamically imported so it only
 * costs anything once a terminal actually opens. The CSS is static — it is
 * tiny and must exist before the first paint of a terminal.
 *
 * The theme is deliberately a fixed dark palette, not the app's light/dark
 * variables: a terminal reads as a terminal in either app theme, and color
 * following can be added later without touching the sessions.
 */

import "@xterm/xterm/css/xterm.css";
import type { FitAddonLike, TerminalLike } from "../lib/terminal-session";

export interface XtermBundle {
  /** `readOnly` disables keyboard input (the watch mirror). */
  createTerminal(options?: { readOnly?: boolean }): TerminalLike;
  createFitAddon(): FitAddonLike;
}

/**
 * The watch mirror's text comes from a *pipe* (the engine's bash tool), so its
 * lines end in a bare `\n` — no carriage return. A terminal that merely moves
 * the cursor down keeps the column, and every line then starts where the
 * previous one ended (the classic staircase). A real PTY never shows this
 * because the tty driver's ONLCR turns `\n` into `\r\n` on output, so the
 * conversion is scoped to the read-only mirror: the shell tab keeps the raw
 * byte stream its PTY already normalizes.
 */
export async function loadXterm(): Promise<XtermBundle> {
  const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
  return {
    createTerminal: (options) =>
      new Terminal({
        cursorBlink: options?.readOnly !== true,
        disableStdin: options?.readOnly === true,
        convertEol: options?.readOnly === true,
        fontFamily: 'JetBrains Mono, Menlo, Monaco, "Courier New", monospace',
        fontSize: 13,
        lineHeight: 1.4,
        scrollback: 5000,
        allowTransparency: false,
        theme: {
          background: "#1a1a1a",
          foreground: "#d4d4d4",
          cursor: "#d4d4d4",
          selectionBackground: "#264f78",
        },
      }),
    createFitAddon: () => new FitAddon(),
  };
}