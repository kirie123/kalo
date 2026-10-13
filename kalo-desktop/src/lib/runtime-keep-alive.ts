import type { RpcExtensionUIRequest } from "../types";

/** Undefined means this request does not change the runtime's keep-alive state. */
export function backgroundKeepAliveStatus(req: RpcExtensionUIRequest): boolean | undefined {
  if (req.method !== "setStatus" || req.statusKey !== "kalo-subagent-background") return undefined;
  return typeof req.statusText === "string" && req.statusText.length > 0;
}

interface ParkedRuntime {
  backgroundKeepAlive: boolean;
  lastActive: number;
  view: { isStreaming: boolean; connecting?: boolean };
}

/** Ordinary LRU only: explicit close/restart must not use this selection. */
export function selectIdleEvictions<T extends ParkedRuntime>(
  runtimes: Iterable<T>,
  active: T,
  maxParked: number,
): T[] {
  const idle = [...runtimes].filter(
    (rt) => rt !== active && !rt.view.isStreaming && !rt.view.connecting && !rt.backgroundKeepAlive,
  );
  return idle.sort((a, b) => a.lastActive - b.lastActive).slice(0, Math.max(0, idle.length - maxParked));
}
