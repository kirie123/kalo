import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Same data-root contract as the desktop and engine; never changes OS home. */
export function getKaloHome(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.KALO_HOME || join(env.USERPROFILE || env.HOME || homedir(), ".kalo");
  const fullWindowsPath = /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(root);
  if (!isAbsolute(root) || (process.platform === "win32" && !fullWindowsPath)) {
    throw new Error("KALO_HOME must be an absolute data directory path");
  }
  return root;
}
