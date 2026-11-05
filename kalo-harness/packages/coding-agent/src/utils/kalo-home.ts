import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Full data root; project-local config directories do not use this helper. */
export function getKaloHome(configDir = ".kalo", env: NodeJS.ProcessEnv = process.env): string {
	const root = env.KALO_HOME || join(env.USERPROFILE || env.HOME || homedir(), configDir);
	const fullWindowsPath = /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(root);
	if (!isAbsolute(root) || (process.platform === "win32" && !fullWindowsPath)) {
		throw new Error("KALO_HOME must be an absolute data directory path");
	}
	return root;
}
