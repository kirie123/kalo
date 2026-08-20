//! `~/.kalo/market/py` — the one answer to "which Python runs market-data".
//!
//! The market-data skill ships as plain files into `~/.kalo/skills/`
//! (`internal_skills.rs`), but **the interpreter does not live in the skill
//! directory** — akshare + pandas are ~170 MB and have no business being
//! copied around with a markdown file. So every caller (the SKILL.md a model
//! reads, the scheduler's daily `macro append` watch task, a user in a
//! terminal) has to answer "where is Python" on a machine we know nothing
//! about: it might be the venv `setup.sh` built, one uv manages, or a system
//! install. Three callers answering that separately means three
//! implementations that drift, and — as the first version of those SKILL.md
//! files proved — all three end up with a hardcoded
//! `venv/Scripts/python.exe` that is wrong everywhere but Windows.
//!
//! This module writes a single bash shim that answers it once. Callers only
//! ever say:
//!
//! ```text
//! ~/.kalo/market/py ~/.kalo/skills/market-data/md.py macro now
//! ```
//!
//! The resolution itself lives *inside the shim*, in bash, deliberately: it
//! then also works when Kalo is not running (cron, terminal, another tool),
//! and it is re-evaluated on every call, so a venv created five minutes ago
//! takes effect with nothing to invalidate.
//!
//! Update discipline is the same as `internal_skills.rs`: `.shim.json` records
//! the fingerprint of what we last wrote, so a newer Kalo can replace an
//! untouched shim while a hand-edited one is left alone.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::internal_skills::fingerprint;
use crate::proc::no_window;

/// Bookkeeping for the file we generate. Dot-prefixed: the market dir is also
/// a data dir the user browses.
const MANIFEST_NAME: &str = ".shim.json";
const SHIM_NAME: &str = "py";

/// What market-data imports. Order is "most fundamental first" so a partial
/// environment reads sensibly in the UI.
const DEPS: [&str; 5] = ["requests", "yaml", "pypdf", "akshare", "pandas"];

/// The generated shim. Kept as one string constant so its fingerprint is
/// exactly what ships — no formatting, no interpolation.
const SHIM: &str = r#"#!/usr/bin/env bash
# ~/.kalo/market/py — market-data 的 Python 入口。
# 由 Kalo 生成（kalo-desktop/src-tauri/src/market_env.rs），删掉会在下次启动重建。
#
# 为什么有这个文件：解释器不在 skill 目录里，而"哪个 Python"在每台机器上
# 答案都不同。让 SKILL.md、定时任务、终端各自解析，就会有三份互相漂移的
# 实现，而且全都写死 Windows 路径。这里是唯一的答案，调用方只需要：
#
#     ~/.kalo/market/py ~/.kalo/skills/market-data/md.py macro now
#
# 手工改这个文件是允许的——Kalo 认得出改过的版本，不会覆盖它。
# 只想临时换解释器的话有更省事的办法：export KALO_MARKET_PYTHON=/path/to/python
set -u

MARKET="$HOME/.kalo/market"
CACHE="$MARKET/.python-path"

# 打印版本号即代表可用：≥3.10 且非预发布。
# 两条都是实测倒逼的——这台开发机上的 3.10.0a5 会让 pip 自己崩溃，
# 而"目录名叫 Python310"什么都不证明，唯一可靠的判据是把它跑起来问它自己。
usable() {
  "$1" -c 'import sys
v = sys.version_info
if v[:2] >= (3, 10) and v.releaselevel == "final":
    print("%d.%d.%d" % v[:3])' 2>/dev/null
}

# 候选清单与 kalo-desktop/src/features/era/locate.ts 同源：PATH 上的名字、
# py launcher 注册的、uv 管的（它故意不放进 PATH）、conda 与官方安装器的常见位置。
#
# uv 那条要查两次：先问 uv 二进制，再直接翻它的 python 目录。这台开发机就是
# 反例——uv 装的 3.12 好好躺在 AppData/Roaming/uv/python 下，但 uv 自己不在
# PATH 上了，只问二进制就会宣布"没有 Python"。
probe() {
  local p c lad
  lad="${LOCALAPPDATA:-/nonexistent}"

  if command -v uv >/dev/null 2>&1; then
    p="$(uv python find '>=3.10' 2>/dev/null)"
    [ -n "$p" ] && [ -n "$(usable "$p")" ] && { printf '%s\n' "$p"; return 0; }
  fi

  for c in python3 python; do
    p="$(command -v "$c" 2>/dev/null)"
    [ -n "$p" ] && [ -n "$(usable "$p")" ] && { printf '%s\n' "$p"; return 0; }
  done

  # py launcher 只报它注册过的解释器；路径是版本标签后那一串空格之后的全部，
  # 这样带空格的路径也能完整取出。
  if command -v py >/dev/null 2>&1; then
    while IFS= read -r line; do
      p="$(printf '%s' "$line" | sed -n 's/^.*[[:space:]]\{2,\}\(.*\)$/\1/p')"
      [ -n "$p" ] && [ -n "$(usable "$p")" ] && { printf '%s\n' "$p"; return 0; }
    done <<EOF
$(py -0p 2>/dev/null)
EOF
  fi

  for p in \
    "${APPDATA:-/nonexistent}/uv/python"/cpython-3.*/python.exe \
    "$HOME/.local/share/uv/python"/cpython-3.*/bin/python3 \
    "$HOME/miniforge3/python.exe" "$HOME/miniconda3/python.exe" "$HOME/anaconda3/python.exe" \
    "$HOME/miniforge3/bin/python3" "$HOME/miniconda3/bin/python3" "$HOME/anaconda3/bin/python3" \
    "$lad/Programs/Python"/Python3*/python.exe \
    /c/Python3*/python.exe "/c/Program Files/Python3"*/python.exe \
    /usr/bin/python3 /usr/local/bin/python3 /opt/homebrew/bin/python3 ; do
    [ -x "$p" ] && [ -n "$(usable "$p")" ] && { printf '%s\n' "$p"; return 0; }
  done

  return 1
}

resolve() {
  local p
  # 1. 显式覆盖。不设版本门槛——用户说了算。
  if [ -n "${KALO_MARKET_PYTHON:-}" ] && [ -x "${KALO_MARKET_PYTHON}" ]; then
    printf '%s\n' "$KALO_MARKET_PYTHON"; return 0
  fi
  # 2. setup.sh 建出来的 venv：正常路径，命中就不再往下探。
  for p in "$MARKET/venv/Scripts/python.exe" "$MARKET/venv/bin/python" "$MARKET/venv/bin/python3"; do
    [ -x "$p" ] && { printf '%s\n' "$p"; return 0; }
  done
  # 3. 上一次探测的结果。排在 venv 之后是刻意的——venv 后来建好了要能立刻生效。
  if [ -r "$CACHE" ]; then
    p="$(cat "$CACHE" 2>/dev/null)"
    if [ -n "$p" ] && [ -x "$p" ] && [ -n "$(usable "$p")" ]; then
      printf '%s\n' "$p"; return 0
    fi
  fi
  # 4. 现探。命中后写进缓存，免得每次调用都 spawn 一串进程。
  p="$(probe)"
  if [ -n "$p" ]; then
    mkdir -p "$MARKET" 2>/dev/null && printf '%s' "$p" > "$CACHE" 2>/dev/null
    printf '%s\n' "$p"; return 0
  fi
  return 1
}

PY="$(resolve)" || PY=""
if [ -z "$PY" ]; then
  cat >&2 <<'MSG'
市场数据环境未就绪：这台机器上没找到可用的 Python（要 ≥3.10 正式版）。
  修：Kalo → 设置 → Skills → 市场数据运行环境 → 一键初始化
  或：bash ~/.kalo/skills/market-data/setup.sh
  已经有解释器的话直接指定也行：export KALO_MARKET_PYTHON=/path/to/python
MSG
  exit 1
fi

exec "$PY" "$@"
"#;

/// Where the shim and the data live. `~/.kalo/market`, same as `cache.py`.
fn market_dir() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "cannot resolve user home directory".to_string())?;
    Ok(PathBuf::from(home).join(".kalo").join("market"))
}

/// What one `ensure_shim` pass did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ShimState {
    /// Written for the first time.
    Installed,
    /// Ours, out of date, replaced.
    Updated,
    /// Already the bundled content.
    Unchanged,
    /// Locally edited — left alone.
    UserEdited,
}

/// Runtime status, as the settings card renders it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketEnv {
    /// Interpreter found **and** every dependency importable.
    pub ready: bool,
    /// Absolute path the shim resolved to, when it resolved one.
    pub python: Option<String>,
    /// `3.12.14`, straight from the interpreter.
    pub version: Option<String>,
    /// How it was found: `override` / `venv` / `uv` / `system` / `none`.
    pub route: String,
    /// The venv, when it exists — the card offers to (re)build it.
    pub venv: Option<String>,
    pub shim: String,
    pub shim_state: ShimState,
    /// Module name → importable.
    pub deps: BTreeMap<String, bool>,
    /// Just the false ones, in `DEPS` order, for the one-line summary.
    pub missing: Vec<String>,
    /// One line for the card. Present whether or not anything is wrong.
    pub detail: String,
    /// Why the probe itself failed (no bash, shim not executable, …).
    pub error: Option<String>,
}

/// Write the shim if it is ours to write. Cheap (pure filesystem) — safe to
/// call on the startup path.
pub fn ensure_shim() -> Result<ShimState, String> {
    ensure_shim_in(&market_dir()?)
}

fn ensure_shim_in(dir: &Path) -> Result<ShimState, String> {
    fs::create_dir_all(dir).map_err(|e| format!("failed to create {}: {e}", dir.display()))?;
    let target = dir.join(SHIM_NAME);
    let bundled = fingerprint(SHIM.as_bytes());

    let existing = fs::read(&target).ok();
    let state = match &existing {
        None => ShimState::Installed,
        Some(bytes) => {
            let current = fingerprint(bytes);
            if current == bundled {
                ShimState::Unchanged
            } else if read_manifest(dir).get(SHIM_NAME) == Some(&current) {
                // Untouched since we wrote it — safe to move it forward.
                ShimState::Updated
            } else {
                ShimState::UserEdited
            }
        }
    };

    if matches!(state, ShimState::Installed | ShimState::Updated) {
        fs::write(&target, SHIM).map_err(|e| format!("failed to write {}: {e}", target.display()))?;
        set_executable(&target);
    }
    if !matches!(state, ShimState::UserEdited) {
        let mut manifest = read_manifest(dir);
        if manifest.get(SHIM_NAME) != Some(&bundled) {
            manifest.insert(SHIM_NAME.to_string(), bundled);
            write_manifest(dir, &manifest);
        }
    }
    Ok(state)
}

fn read_manifest(dir: &Path) -> BTreeMap<String, String> {
    fs::read_to_string(dir.join(MANIFEST_NAME))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_manifest(dir: &Path, manifest: &BTreeMap<String, String>) {
    if let Ok(text) = serde_json::to_string_pretty(manifest) {
        let _ = fs::write(dir.join(MANIFEST_NAME), text);
    }
}

/// A bash script is only useful if the mode bits let it run. No-op on Windows,
/// where Git Bash reads the shebang itself.
fn set_executable(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o755));
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// Locate a bash that can run our scripts.
///
/// Same order and same reasoning as the gateway's `resolveBash()`
/// (`gateway/src/scheduler.ts`) — kept in both places because neither process
/// can call the other, and a mismatch would mean the settings card probes
/// through a different shell than the scheduler actually uses:
///
/// 1. `bash` on PATH is often WSL's (`System32\bash.exe`), which sees a
///    different filesystem than the paths our scripts talk about.
/// 2. `Git\bin\bash.exe` is a wrapper around `Git\usr\bin\bash.exe`; prefer
///    the real shell so there is no extra process layer.
pub fn resolve_bash() -> String {
    for var in ["KALO_BASH", "BASH"] {
        if let Ok(v) = std::env::var(var) {
            if !v.trim().is_empty() && Path::new(&v).exists() {
                return v;
            }
        }
    }
    #[cfg(windows)]
    {
        if let Ok(path) = std::env::var("PATH") {
            for dir in path.split(';') {
                if dir.trim().is_empty() || dir.to_lowercase().contains("system32") {
                    continue;
                }
                let candidate = Path::new(dir).join("bash.exe");
                if candidate.exists() {
                    return candidate.display().to_string();
                }
            }
        }
        for candidate in [
            r"C:\Program Files\Git\usr\bin\bash.exe",
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\Program Files (x86)\Git\usr\bin\bash.exe",
            r"C:\Program Files (x86)\Git\bin\bash.exe",
        ] {
            if Path::new(candidate).exists() {
                return candidate.to_string();
            }
        }
    }
    "bash".to_string()
}

/// Ask the shim which interpreter it picks, and what that interpreter can
/// import. Spawns two processes at most; safe to call from a command handler,
/// not from the startup path.
pub fn status() -> Result<MarketEnv, String> {
    let dir = market_dir()?;
    let shim_state = ensure_shim_in(&dir)?;
    let shim = dir.join(SHIM_NAME);
    let venv = ["Scripts/python.exe", "bin/python", "bin/python3"]
        .iter()
        .map(|p| dir.join("venv").join(p.replace('/', std::path::MAIN_SEPARATOR_STR)))
        .find(|p| p.exists())
        .map(|_| dir.join("venv").display().to_string());

    let mut env = MarketEnv {
        ready: false,
        python: None,
        version: None,
        route: "none".to_string(),
        venv,
        shim: shim.display().to_string(),
        shim_state,
        deps: DEPS.iter().map(|d| ((*d).to_string(), false)).collect(),
        missing: DEPS.iter().map(|d| (*d).to_string()).collect(),
        detail: String::new(),
        error: None,
    };

    // `find_spec` rather than `import`: importing akshare costs seconds (it
    // pulls in pandas), and "is it installed" is the only question here.
    // `md.py doctor` does the real imports, where the user is waiting on
    // purpose.
    let snippet = r#"import sys, json
try:
    import importlib.util as u
    deps = {}
    for m in ("requests", "yaml", "pypdf", "akshare", "pandas"):
        try:
            deps[m] = u.find_spec(m) is not None
        except Exception:
            deps[m] = False
    print(json.dumps({"python": sys.executable,
                      "version": "%d.%d.%d" % sys.version_info[:3],
                      "deps": deps}))
except Exception as exc:
    print(json.dumps({"error": "%s: %s" % (type(exc).__name__, exc)}))
"#;

    let mut cmd = Command::new(resolve_bash());
    cmd.arg(&shim).arg("-c").arg(snippet);
    let out = match no_window(&mut cmd).output() {
        Ok(out) => out,
        Err(e) => {
            env.error = Some(format!("无法执行 {}：{e}（需要系统可用 bash）", shim.display()));
            env.detail = "没能运行入口脚本，通常是这台机器上没有 bash（Windows 装 Git for Windows）".to_string();
            return Ok(env);
        }
    };

    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || stdout.is_empty() {
        // The shim's own "not ready" message goes to stderr; it is already
        // written for a human, so pass it through rather than paraphrasing.
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        env.error = (!stderr.is_empty()).then_some(stderr);
        env.detail = "没找到可用的 Python（要 ≥3.10 正式版）".to_string();
        return Ok(env);
    }

    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).map_err(|e| format!("解析自检输出失败：{e}\n{stdout}"))?;
    if let Some(err) = parsed.get("error").and_then(|v| v.as_str()) {
        env.error = Some(err.to_string());
        env.detail = "解释器跑起来了，但自检脚本报错".to_string();
        return Ok(env);
    }

    let python = parsed.get("python").and_then(|v| v.as_str()).unwrap_or("").to_string();
    env.version = parsed.get("version").and_then(|v| v.as_str()).map(str::to_string);
    env.route = classify(&python, &dir);
    for name in DEPS {
        let ok = parsed
            .get("deps")
            .and_then(|d| d.get(name))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        env.deps.insert(name.to_string(), ok);
    }
    env.missing = DEPS
        .iter()
        .filter(|n| !env.deps.get(**n).copied().unwrap_or(false))
        .map(|n| (*n).to_string())
        .collect();
    env.python = (!python.is_empty()).then_some(python);
    env.ready = env.python.is_some() && env.missing.is_empty();
    env.detail = describe(&env);
    Ok(env)
}

/// Which of the shim's branches produced this path. String comparison rather
/// than having the shim report it: the shim's contract is "exec the right
/// python", and adding a reporting mode to it would be a second contract to
/// keep in sync.
fn classify(python: &str, dir: &Path) -> String {
    if python.is_empty() {
        return "none".to_string();
    }
    let lower = python.replace('\\', "/").to_lowercase();
    if let Ok(over) = std::env::var("KALO_MARKET_PYTHON") {
        if !over.trim().is_empty() && lower == over.replace('\\', "/").to_lowercase() {
            return "override".to_string();
        }
    }
    let venv = dir.join("venv").display().to_string().replace('\\', "/").to_lowercase();
    if lower.starts_with(&venv) {
        return "venv".to_string();
    }
    if lower.contains("/uv/python/") {
        return "uv".to_string();
    }
    "system".to_string()
}

fn describe(env: &MarketEnv) -> String {
    let route = match env.route.as_str() {
        "override" => "指定的解释器",
        "venv" => "专用 venv",
        "uv" => "uv 管理的 Python",
        "system" => "系统 Python",
        _ => "未知来源",
    };
    let version = env.version.as_deref().unwrap_or("?");
    if env.missing.is_empty() {
        format!("{route} · Python {version} · 依赖齐全")
    } else {
        format!("{route} · Python {version} · 缺 {}", env.missing.join(" / "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("kalo-market-env-{tag}"));
        let _ = fs::remove_dir_all(&p);
        p
    }

    #[test]
    fn writes_then_updates_but_keeps_local_edits() {
        let d = dir("shim");
        assert_eq!(ensure_shim_in(&d).unwrap(), ShimState::Installed);
        assert_eq!(fs::read_to_string(d.join(SHIM_NAME)).unwrap(), SHIM);

        // Idempotent: a second pass must not rewrite the file.
        assert_eq!(ensure_shim_in(&d).unwrap(), ShimState::Unchanged);

        // Ours but stale (as if a previous Kalo wrote an older shim): the
        // manifest still matches the file, so it may be moved forward.
        fs::write(d.join(SHIM_NAME), "old shim").unwrap();
        let mut m = BTreeMap::new();
        m.insert(SHIM_NAME.to_string(), fingerprint(b"old shim"));
        write_manifest(&d, &m);
        assert_eq!(ensure_shim_in(&d).unwrap(), ShimState::Updated);
        assert_eq!(fs::read_to_string(d.join(SHIM_NAME)).unwrap(), SHIM);

        // Hand-edited: left alone, and stays left alone on later passes.
        fs::write(d.join(SHIM_NAME), "mine\n").unwrap();
        assert_eq!(ensure_shim_in(&d).unwrap(), ShimState::UserEdited);
        assert_eq!(ensure_shim_in(&d).unwrap(), ShimState::UserEdited);
        assert_eq!(fs::read_to_string(d.join(SHIM_NAME)).unwrap(), "mine\n");
    }

    #[test]
    fn classify_reads_the_path_it_was_given() {
        let d = dir("classify");
        let venv = d.join("venv").join("Scripts").join("python.exe");
        assert_eq!(classify(&venv.display().to_string(), &d), "venv");
        assert_eq!(
            classify(r"C:\Users\x\AppData\Roaming\uv\python\cpython-3.12\python.exe", &d),
            "uv"
        );
        assert_eq!(classify("/usr/bin/python3", &d), "system");
        assert_eq!(classify("", &d), "none");
    }

    #[test]
    fn detail_names_the_missing_dependencies() {
        let mut env = MarketEnv {
            ready: false,
            python: Some("/usr/bin/python3".into()),
            version: Some("3.12.1".into()),
            route: "system".into(),
            venv: None,
            shim: String::new(),
            shim_state: ShimState::Unchanged,
            deps: BTreeMap::new(),
            missing: vec!["akshare".into(), "pandas".into()],
            detail: String::new(),
            error: None,
        };
        assert_eq!(describe(&env), "系统 Python · Python 3.12.1 · 缺 akshare / pandas");
        env.missing.clear();
        assert_eq!(describe(&env), "系统 Python · Python 3.12.1 · 依赖齐全");
    }

    /// The shim is a bash script whose text is the contract with three
    /// callers; these are the lines that would break them silently.
    #[test]
    fn shim_keeps_its_contract() {
        assert!(SHIM.starts_with("#!/usr/bin/env bash"));
        assert!(SHIM.contains("KALO_MARKET_PYTHON"));
        assert!(SHIM.contains("$MARKET/venv/Scripts/python.exe"));
        assert!(SHIM.contains("exec \"$PY\" \"$@\""));
        // No CRLF: Git Bash chokes on \r in a shebang line.
        assert!(!SHIM.contains('\r'));
    }
}
