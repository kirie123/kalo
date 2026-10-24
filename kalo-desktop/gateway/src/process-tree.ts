import { spawn } from "node:child_process";
import { join } from "node:path";

/** All callers own the target PID. POSIX callers spawn a detached process group. */
export function terminateProcessTree(pid: number): Promise<void> {
  const killDirectly = () => {
    try { process.kill(pid, "SIGTERM"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  if (process.platform !== "win32") {
    try { process.kill(-pid, "SIGTERM"); }
    catch { killDirectly(); }
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    // Resolve from the OS directory: PATH can be different in desktop launches.
    const executable = join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32", "taskkill.exe");
    const child = spawn(executable, ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    let settled = false;
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (!success) killDirectly(); resolve(); } catch (error) { reject(error); }
    };
    const timer = setTimeout(() => { child.kill(); finish(false); }, 3000);
    timer.unref();
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}
