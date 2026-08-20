#!/usr/bin/env bash
# market-data 运行环境一键初始化。
#
# 装完 Kalo 之后，skill 文件是现成的（`internal_skills.rs` 复制到
# ~/.kalo/skills/），但**解释器不是**——akshare + pandas 约 170MB，不打进
# 安装包。这个脚本负责补上那一步：在 ~/.kalo/market/venv 里建一个专用
# 环境并装好 requirements.txt。
#
# 三处调用，都是同一份脚本：
#   设置 → Skills → 市场数据运行环境 → 一键初始化   （前端当普通后台 job 跑）
#   bash ~/.kalo/skills/market-data/setup.sh        （用户或模型手工跑）
#
# 用法：
#   setup.sh [--mirror <index-url>] [--python <path>] [--force]
#
#   --mirror   PyPI 镜像。国内网络下这不是优化而是必需——era 那张安装卡片
#              已经证明过，没有镜像口子等于"一键"变"放弃"。
#   --python   指定用哪个解释器建 venv，跳过探测。
#   --force    venv 已存在也重建。
#
# 与 era 的安装脚本（kalo-desktop/src/features/era/install.ts）同构：
# 收尾打 `== 完成`，调用方用 /^== 完成$/m 判成功。

set -u

MARKET="$HOME/.kalo/market"
VENV="$MARKET/venv"
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
REQ="$SKILL_DIR/requirements.txt"

MIRROR=""
PYTHON=""
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --mirror) MIRROR="${2:-}"; shift 2 ;;
    --python) PYTHON="${2:-}"; shift 2 ;;
    --force)  FORCE=1; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "!! 不认识的参数：$1"; exit 2 ;;
  esac
done

[ -r "$REQ" ] || { echo "!! 找不到 $REQ"; exit 1; }

# uv 装的东西落在 ~/.local/bin，而刚装完的这个 shell 往往还没把它加进 PATH。
# 这个坑 era 那份脚本踩过，处理方式照搬：用之前先前置一次。
export PATH="$HOME/.local/bin:$PATH"

if [ -n "$MIRROR" ]; then
  echo "== 使用镜像 $MIRROR"
  export UV_DEFAULT_INDEX="$MIRROR"
  export PIP_INDEX_URL="$MIRROR"
else
  echo "== 使用默认索引 (pypi.org)"
fi

# 判据是「跑起来问它自己」，不是看目录名：这台开发机上 Python310 目录里装的
# 是 3.10.0a5，预发布版会让 pip 自己崩掉。与 ~/.kalo/market/py 同一套口径。
usable() {
  [ -n "${1:-}" ] || return 1
  "$1" -c 'import sys
v = sys.version_info
if v[:2] >= (3, 10) and v.releaselevel == "final":
    print("%d.%d.%d" % v[:3])' 2>/dev/null
}

find_python() {
  local p c lad
  lad="${LOCALAPPDATA:-/nonexistent}"
  for c in python3 python; do
    p="$(command -v "$c" 2>/dev/null)"
    [ -n "$p" ] && [ -n "$(usable "$p")" ] && { printf '%s\n' "$p"; return 0; }
  done
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
    "$lad/Programs/Python"/Python3*/python.exe \
    /usr/bin/python3 /usr/local/bin/python3 /opt/homebrew/bin/python3 ; do
    [ -x "$p" ] && [ -n "$(usable "$p")" ] && { printf '%s\n' "$p"; return 0; }
  done
  return 1
}

install_uv() {
  if command -v uv >/dev/null 2>&1; then
    echo "== uv 已存在: $(command -v uv)"
    return 0
  fi
  echo "== 装 uv（这台机器上没有可用的 Python，让 uv 自带一份）"
  # 平台差异照 era 的脚本处理：gateway 在 Windows 上也走 bash -c，所以
  # 不能假定 curl | sh 在 git-bash 里能用。
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex" \
        || { echo "!! uv 安装失败"; return 1; }
      ;;
    *)
      curl -LsSf https://astral.sh/uv/install.sh | sh || { echo "!! uv 安装失败"; return 1; }
      ;;
  esac
  export PATH="$HOME/.local/bin:$PATH"
  command -v uv >/dev/null 2>&1 || { echo "!! 装完还是找不到 uv，PATH=$PATH"; return 1; }
  echo "== uv $(uv --version 2>&1)"
}

venv_python() {
  local p
  for p in "$VENV/Scripts/python.exe" "$VENV/bin/python" "$VENV/bin/python3"; do
    [ -x "$p" ] && { printf '%s\n' "$p"; return 0; }
  done
  return 1
}

# ---------------------------------------------------------------- 建 venv

mkdir -p "$MARKET" || { echo "!! 建不了 $MARKET"; exit 1; }

if [ "$FORCE" = "1" ] && [ -d "$VENV" ]; then
  echo "== --force：删掉旧的 $VENV"
  rm -rf "$VENV" || { echo "!! 删不掉旧 venv，先关掉正在用它的进程"; exit 1; }
fi

if VP="$(venv_python)"; then
  echo "== venv 已存在: $VP（只补依赖；要重建加 --force）"
else
  [ -n "$PYTHON" ] || PYTHON="$(find_python || true)"
  if [ -n "$PYTHON" ]; then
    V="$(usable "$PYTHON")"
    if [ -z "$V" ]; then
      echo "!! $PYTHON 不可用（要 ≥3.10 正式版）"; exit 1
    fi
    echo "== 用系统 Python $V 建 venv: $PYTHON"
    "$PYTHON" -m venv "$VENV" || { echo "!! python -m venv 失败"; exit 1; }
  else
    echo "== 这台机器上没找到可用的 Python，转 uv"
    install_uv || exit 1
    # uv 会现下一份它自己管的 CPython——「没有解释器」与「缺一个包」
    # 两个问题合成一条命令，这是选 uv 而不是 pip 的唯一理由。
    uv venv --python 3.12 "$VENV" || { echo "!! uv venv 失败"; exit 1; }
  fi
  VP="$(venv_python)" || { echo "!! venv 建出来了但找不到解释器：$VENV"; exit 1; }
fi

echo "== venv 解释器 $VP"

# ---------------------------------------------------------------- 装依赖

echo "== 装依赖 $REQ"
# 三条路，按"手上已经有什么"排：
#   uv 在 → uv pip（最快，也是建这个 venv 的那个工具）
#   venv 自带 pip → 直接用
#   都没有 → uv 建的 venv **默认不装 pip**，先 ensurepip 补，补不出来就装 uv
# 第三条是实测倒逼的：这台机器的 venv 是 uv 建的，
# `python -m pip` 直接 "No module named pip"。
if command -v uv >/dev/null 2>&1; then
  uv pip install --python "$VP" -r "$REQ" || { echo "!! 依赖安装失败"; exit 1; }
elif "$VP" -m pip --version >/dev/null 2>&1; then
  "$VP" -m pip install --upgrade pip >/dev/null 2>&1
  "$VP" -m pip install -r "$REQ" || { echo "!! 依赖安装失败"; exit 1; }
else
  echo "== venv 里没有 pip（uv 建的 venv 默认不装），补一个"
  if "$VP" -m ensurepip --upgrade >/dev/null 2>&1 && "$VP" -m pip --version >/dev/null 2>&1; then
    "$VP" -m pip install -r "$REQ" || { echo "!! 依赖安装失败"; exit 1; }
  else
    echo "== ensurepip 也用不了，转 uv"
    install_uv || exit 1
    uv pip install --python "$VP" -r "$REQ" || { echo "!! 依赖安装失败"; exit 1; }
  fi
fi

# ---------------------------------------------------------------- 自检

echo "== 自检"
"$VP" "$SKILL_DIR/md.py" doctor || { echo "!! 自检没过"; exit 1; }

echo "== 完成"
