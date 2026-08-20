/**
 * Installing era from inside the panel.
 *
 * The design principle the era panel already runs on is "era is just an
 * ordinary background job". This extends it one step: **installing era is also
 * an ordinary background job**. There is no new process management, no new
 * Rust command and no new protocol here — `job_start` runs a shell script and
 * `read_text_since` tails its log, both of which already exist for runs.
 *
 * uv is the tool of choice for one specific reason: it downloads its own
 * managed CPython. On a machine with no Python at all, or with the wrong one,
 * that turns two problems (an interpreter, and a package) into one command.
 */

import { appPaths, jobList, jobStart, readTextSince } from "../../lib/pi-bridge";
import { isJobTerminal } from "../../types";
import { invalidate } from "./locate";
import { shq } from "./spec";

/**
 * What gets installed.
 *
 * Pinned, never `latest`. era's trace format and CLI flags are the contract
 * `fold.ts` and `spec.ts` are written against; a floating version would let an
 * upstream release break this panel on a machine that changed nothing.
 */
export const ERA_PACKAGE = "era-evolve==0.1.0";

/** Used when the PyPI release is not reachable (or not published yet). */
export const ERA_GIT_FALLBACK = "git+https://github.com/kirie123/era-evolve@v0.1.0";

export interface InstallOptions {
  /**
   * Index URL for `UV_DEFAULT_INDEX`. PyPI is slow or unreachable from some
   * networks, and a mirror is the difference between "one click" and "give up".
   */
  mirror?: string;
}

/**
 * The installer script.
 *
 * Two things are worth reading closely:
 *
 * - uv's own installer differs per platform, and the gateway runs everything
 *   through `bash -c` even on Windows, so git-bash is detected explicitly
 *   rather than assuming `curl | sh` works there.
 * - uv installs tools into `~/.local/bin`, which is frequently **not** on PATH
 *   in the shell that just installed it. The script therefore prepends it
 *   before using `uv`, and `locate.ts` looks there directly afterwards rather
 *   than trusting PATH to have caught up.
 */
function installScript(opts: InstallOptions): string {
  const mirror = opts.mirror?.trim();
  return [
    mirror ? `export UV_DEFAULT_INDEX=${shq(mirror)}` : `echo "使用默认索引 (pypi.org)"`,
    String.raw`
export PATH="$HOME/.local/bin:$PATH"

if command -v uv >/dev/null 2>&1; then
  echo "== uv 已存在: $(command -v uv)"
else
  echo "== 安装 uv"
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex" || {
        echo "!! uv 安装失败"; exit 1; }
      ;;
    *)
      curl -LsSf https://astral.sh/uv/install.sh | sh || { echo "!! uv 安装失败"; exit 1; }
      ;;
  esac
  export PATH="$HOME/.local/bin:$PATH"
fi

command -v uv >/dev/null 2>&1 || { echo "!! 装完还是找不到 uv，PATH=$PATH"; exit 1; }
echo "== uv $(uv --version 2>&1)"
`,
    `echo "== 安装 ${ERA_PACKAGE}"`,
    `if uv tool install ${shq(ERA_PACKAGE)}; then`,
    `  echo "== 从 PyPI 装好了"`,
    `else`,
    `  echo "== PyPI 上没拿到，改从 git 装：${ERA_GIT_FALLBACK}"`,
    `  uv tool install ${shq(ERA_GIT_FALLBACK)} || { echo "!! 安装失败"; exit 1; }`,
    `fi`,
    String.raw`
era_bin=""
for p in "$HOME/.local/bin/era" "$HOME/.local/bin/era.exe"; do
  [ -x "$p" ] && era_bin="$p"
done
[ -n "$era_bin" ] || era_bin="$(command -v era 2>/dev/null)"
[ -n "$era_bin" ] || { echo "!! 装完了但找不到 era 可执行文件"; exit 1; }
echo "== $era_bin"
"$era_bin" --version || exit 1
echo "== 完成"
`,
  ].join("\n");
}

export interface InstallHandle {
  jobId: string;
  /** Absolute path of the log file, tailed with `readTextSince`. */
  logPath: string;
}

/**
 * Start the install and stream its log until the job settles.
 *
 * Resolves with the exit-ish verdict rather than throwing on a failed install:
 * "era did not install" is a result the card has to render, not an exception.
 */
export async function installEra(
  opts: InstallOptions,
  onLog: (text: string) => void,
): Promise<{ ok: boolean; log: string }> {
  const paths = await appPaths();
  const dir = `${paths.kaloRoot}/.era-install`;
  const logPath = `${dir}/log`;
  const cmd = [
    `mkdir -p ${shq(dir)}`,
    `: > ${shq(logPath)}`,
    `{`,
    installScript(opts),
    `} >> ${shq(logPath)} 2>&1`,
  ].join("\n");

  const jobId = await jobStart({
    label: "安装 era",
    cwd: paths.kaloRoot || paths.home,
    cmd,
    kind: "erainstall",
  });

  let offset = 0;
  let log = "";
  for (;;) {
    await new Promise((r) => setTimeout(r, 500));
    const slice = await readTextSince(logPath, offset, 128 * 1024).catch(() => null);
    if (slice && slice.text) {
      offset = slice.offset;
      log += slice.text;
      onLog(log);
    }
    const jobs = await jobList().catch(() => []);
    const job = jobs.find((j) => j.id === jobId);
    if (job && isJobTerminal(job.status)) break;
  }
  // One last read: the job can settle between two polls, leaving the tail
  // of the log — including the line that says why it failed — unread.
  const tail = await readTextSince(logPath, offset, 128 * 1024).catch(() => null);
  if (tail?.text) {
    log += tail.text;
    onLog(log);
  }

  invalidate();
  return { ok: /^== 完成$/m.test(log), log };
}
