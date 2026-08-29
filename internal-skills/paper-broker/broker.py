#!/usr/bin/env python3
"""paper-broker：本地纸交易账本 CLI。

设计见 kalo 仓库 doc/2026-08-29-digital-experts.md。要点：

- `ledger.jsonl` 是唯一真相：append-only 事件流，每条带 `prev`/`hash`
  （`hash = sha256(prev + "|" + canonical(entry))`）。`state.json` 只是从账本
  重放出来的派生缓存，随时可被 `verify` 推翻。
- 所有状态变更只能走本 CLI（买卖校验现金/持仓/T+1/整手，费用在代码里算）。
  agent 有 shell 权限，权限隔离是假的；防篡改靠哈希链可检测性——
  `verify` 重放全链 + 重算 state，不一致即非零退出（挂 watch 任务告警）。
- 定价：`--price` 显式指定优先；否则取 market-data 的前复权日线（腾讯源，
  带缓存）对应交易日收盘价，取不到就报错退出——不猜价。
- 费用模型（A 股）：佣金万 2.5 最低 5 元（买卖双向）；印花税千 1（仅卖出）。
- 这是纸交易记录工具，不构成投资建议，不发生任何真实交易。

用法（解释器入口见 SKILL.md）：
    broker.py init <dir> --cash 1000000
    broker.py deposit|withdraw <dir> <amount>
    broker.py buy  <dir> <code> <qty> [--price P] [--date D] [--name N]
    broker.py sell <dir> <code> <qty> [--price P] [--date D]
    broker.py positions|pnl|history|verify <dir>
    broker.py settle <dir> [--date D] [--prices '{"600519": 1500.0}']
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

COMMISSION_RATE = 0.00025  # 万 2.5，买卖双向
COMMISSION_MIN = 5.0
STAMP_TAX_RATE = 0.001  # 千 1，仅卖出
LOT = 100  # 买入整手

LEDGER = "ledger.jsonl"
STATE = "state.json"


# ---------------------------------------------------------------------------
# 账本读写
# ---------------------------------------------------------------------------


def _round2(x: float) -> float:
    return round(x + 1e-9, 2)


def _canonical(entry: dict[str, Any]) -> str:
    body = {k: v for k, v in entry.items() if k not in ("prev", "hash")}
    return json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _hash(prev: str, entry: dict[str, Any]) -> str:
    return hashlib.sha256(f"{prev}|{_canonical(entry)}".encode("utf-8")).hexdigest()


def _ledger_path(d: Path) -> Path:
    return d / LEDGER


def load_ledger(d: Path) -> list[dict[str, Any]]:
    path = _ledger_path(d)
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            out.append(json.loads(line))
    return out


def append_entry(d: Path, entry: dict[str, Any]) -> dict[str, Any]:
    """追加一条事件（带上 seq/prev/hash）并原子写。"""
    entries = load_ledger(d)
    prev = entries[-1]["hash"] if entries else "genesis"
    entry = {"seq": len(entries) + 1, "at": datetime.now().isoformat(timespec="seconds"), **entry}
    entry["prev"] = prev
    entry["hash"] = _hash(prev, entry)
    with _ledger_path(d).open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return entry


# ---------------------------------------------------------------------------
# 状态重放（账本 → 现金/持仓/已实现收益）
# ---------------------------------------------------------------------------


def replay(entries: list[dict[str, Any]]) -> dict[str, Any]:
    cash = 0.0
    positions: dict[str, dict[str, Any]] = {}
    realized = 0.0
    for e in entries:
        t = e["type"]
        if t == "init":
            cash = float(e["cash"])
        elif t == "deposit":
            cash += float(e["amount"])
        elif t == "withdraw":
            cash -= float(e["amount"])
        elif t == "buy":
            code = e["code"]
            pos = positions.setdefault(code, {"name": e.get("name") or code, "lots": []})
            pos["lots"].append({"date": e["date"], "qty": int(e["qty"]), "cost": float(e["price"])})
            cash -= _round2(float(e["qty"]) * float(e["price"])) + float(e["fee"])
        elif t == "sell":
            code = e["code"]
            pos = positions[code]
            remaining = int(e["qty"])
            cost_of_sold = 0.0
            while remaining > 0:
                lot = pos["lots"][0]
                take = min(lot["qty"], remaining)
                cost_of_sold += take * lot["cost"]
                lot["qty"] -= take
                remaining -= take
                if lot["qty"] == 0:
                    pos["lots"].pop(0)
            proceeds = _round2(float(e["qty"]) * float(e["price"])) - float(e["fee"]) - float(e["tax"])
            realized += proceeds - cost_of_sold
            cash += proceeds
            if not pos["lots"]:
                del positions[code]
        elif t == "settle":
            pass  # 估值快照，不改变现金/持仓
        else:
            raise ValueError(f"未知账本事件类型：{t}")
    return {"cash": _round2(cash), "positions": positions, "realized_pnl": _round2(realized)}


def position_view(pos: dict[str, Any]) -> dict[str, Any]:
    qty = sum(lot["qty"] for lot in pos["lots"])
    cost = sum(lot["qty"] * lot["cost"] for lot in pos["lots"])
    return {"qty": qty, "avg_cost": _round2(cost / qty) if qty else 0.0}


def save_state(d: Path, entries: list[dict[str, Any]]) -> dict[str, Any]:
    st = replay(entries)
    view = {
        "cash": st["cash"],
        "realized_pnl": st["realized_pnl"],
        "positions": {
            code: {"name": pos["name"], **position_view(pos), "lots": pos["lots"]}
            for code, pos in st["positions"].items()
        },
        "tip_seq": entries[-1]["seq"] if entries else 0,
        "tip_hash": entries[-1]["hash"] if entries else None,
    }
    tmp = d / (STATE + ".tmp")
    tmp.write_text(json.dumps(view, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(d / STATE)
    return view


# ---------------------------------------------------------------------------
# 校验与定价
# ---------------------------------------------------------------------------


def verify(d: Path) -> list[str]:
    """重放校验：哈希链完整 + state.json 与重放一致。返回问题列表（空 = 通过）。"""
    problems: list[str] = []
    entries = load_ledger(d)
    prev = "genesis"
    for i, e in enumerate(entries):
        if e.get("seq") != i + 1:
            problems.append(f"第 {i + 1} 条 seq 错位：{e.get('seq')}")
        if e.get("prev") != prev:
            problems.append(f"第 {i + 1} 条 prev 断链")
        if e.get("hash") != _hash(prev, e):
            problems.append(f"第 {i + 1} 条 hash 不匹配（内容被改过）")
        prev = e.get("hash", prev)
    try:
        st = replay(entries)
    except (ValueError, KeyError, IndexError) as exc:
        problems.append(f"账本重放失败：{exc}")
        return problems
    state_path = d / STATE
    if state_path.exists():
        saved = json.loads(state_path.read_text(encoding="utf-8"))
        if saved.get("cash") != st["cash"]:
            problems.append(f"state.json 现金 {saved.get('cash')} ≠ 重放 {st['cash']}")
        saved_qty = {c: p["qty"] for c, p in saved.get("positions", {}).items()}
        replay_qty = {c: position_view(p)["qty"] for c, p in st["positions"].items()}
        if saved_qty != replay_qty:
            problems.append(f"state.json 持仓 {saved_qty} ≠ 重放 {replay_qty}")
        if entries and saved.get("tip_hash") != entries[-1]["hash"]:
            problems.append("state.json 的 tip_hash 与账本顶端不一致")
    else:
        problems.append("state.json 缺失")
    return problems


def fetch_close(code: str, date: str) -> float:
    """market-data 腾讯前复权日线的收盘价；取不到就报错，不猜价。"""
    md_dir = Path(__file__).resolve().parent.parent / "market-data"
    if not md_dir.is_dir():
        raise SystemExit(f"找不到 market-data skill（{md_dir}），无法取价")
    if str(md_dir) not in sys.path:
        sys.path.insert(0, str(md_dir))
    from lib import fetch as fetch_mod  # noqa: PLC0415
    from lib.registry import find_source  # noqa: PLC0415
    from lib.stock import code_params  # noqa: PLC0415

    src = find_source("stock_kline")
    if src is None:
        raise SystemExit("market-data 未注册 stock_kline 源")
    rows, err = fetch_mod.fetch_rows(src, params=code_params(code), fresh=False)
    if err or not rows:
        raise SystemExit(f"取 {code} 日线失败：{err or '空返回'}")
    for r in rows:
        if isinstance(r, list) and len(r) >= 3 and str(r[0])[:10] == date:
            return float(r[2])
    raise SystemExit(f"{code} 在 {date} 没有日线收盘价（非交易日或超出缓存窗口）")


# ---------------------------------------------------------------------------
# 交易规则（在代码里，agent 绕不过）
# ---------------------------------------------------------------------------


def _commission(amount: float) -> float:
    return _round2(max(COMMISSION_MIN, amount * COMMISSION_RATE))


def _require_dir(d: Path) -> None:
    if not _ledger_path(d).exists():
        raise SystemExit(f"{d} 不是 paper-broker 账本（缺 {LEDGER}），先 init")


def _trade_date(args: argparse.Namespace) -> str:
    return args.date or datetime.now().date().isoformat()


def cmd_buy(d: Path, args: argparse.Namespace) -> None:
    qty = int(args.qty)
    if qty <= 0 or qty % LOT != 0:
        raise SystemExit(f"买入数量必须是 {LOT} 的整数倍：{qty}")
    date = _trade_date(args)
    price = float(args.price) if args.price is not None else fetch_close(args.code, date)
    if price <= 0:
        raise SystemExit(f"非法价格：{price}")
    entries = load_ledger(d)
    st = replay(entries)
    amount = _round2(qty * price)
    fee = _commission(amount)
    if st["cash"] < amount + fee:
        raise SystemExit(f"现金不足：需要 {amount + fee}（含佣金 {fee}），可用 {st['cash']}")
    append_entry(d, {"type": "buy", "code": args.code, "name": args.name or args.code,
                     "qty": qty, "price": price, "fee": fee, "date": date})
    view = save_state(d, load_ledger(d))
    print(json.dumps({"ok": True, "side": "buy", "code": args.code, "qty": qty,
                      "price": price, "fee": fee, "cash": view["cash"]},
                     ensure_ascii=False))


def cmd_sell(d: Path, args: argparse.Namespace) -> None:
    qty = int(args.qty)
    if qty <= 0:
        raise SystemExit(f"卖出数量必须为正：{qty}")
    date = _trade_date(args)
    price = float(args.price) if args.price is not None else fetch_close(args.code, date)
    if price <= 0:
        raise SystemExit(f"非法价格：{price}")
    entries = load_ledger(d)
    st = replay(entries)
    pos = st["positions"].get(args.code)
    if pos is None:
        raise SystemExit(f"没有持仓：{args.code}")
    # T+1：当日买入的 lot 当日不可卖
    available = sum(lot["qty"] for lot in pos["lots"] if lot["date"] < date)
    if qty > available:
        raise SystemExit(f"可用持仓不足（T+1）：可卖 {available}，要卖 {qty}")
    amount = _round2(qty * price)
    fee = _commission(amount)
    tax = _round2(amount * STAMP_TAX_RATE)
    append_entry(d, {"type": "sell", "code": args.code, "qty": qty, "price": price,
                     "fee": fee, "tax": tax, "date": date})
    view = save_state(d, load_ledger(d))
    print(json.dumps({"ok": True, "side": "sell", "code": args.code, "qty": qty,
                      "price": price, "fee": fee, "tax": tax,
                      "cash": view["cash"], "realized_pnl": view["realized_pnl"]},
                     ensure_ascii=False))


def cmd_settle(d: Path, args: argparse.Namespace) -> None:
    """收盘结算：按当日收盘价重估持仓，追加 settle 快照（进哈希链）。"""
    date = _trade_date(args)
    overrides: dict[str, float] = json.loads(args.prices) if args.prices else {}
    entries = load_ledger(d)
    st = replay(entries)
    prices: dict[str, float] = {}
    market_value = 0.0
    for code, pos in sorted(st["positions"].items()):
        price = float(overrides[code]) if code in overrides else fetch_close(code, date)
        prices[code] = price
        market_value += position_view(pos)["qty"] * price
    total = _round2(st["cash"] + market_value)
    append_entry(d, {"type": "settle", "date": date, "prices": prices,
                     "cash": st["cash"], "market_value": _round2(market_value),
                     "total_value": total})
    save_state(d, load_ledger(d))
    print(json.dumps({"ok": True, "date": date, "cash": st["cash"],
                      "market_value": _round2(market_value), "total_value": total},
                     ensure_ascii=False))


def cmd_pnl(d: Path, _args: argparse.Namespace) -> None:
    entries = load_ledger(d)
    st = replay(entries)
    settles = [e for e in entries if e["type"] == "settle"]
    net_in = 0.0
    for e in entries:
        if e["type"] == "init":
            net_in += float(e["cash"])
        elif e["type"] == "deposit":
            net_in += float(e["amount"])
        elif e["type"] == "withdraw":
            net_in -= float(e["amount"])
    last_value = float(settles[-1]["total_value"]) if settles else st["cash"]
    peak = 0.0
    max_dd = 0.0
    for e in settles:
        v = float(e["total_value"])
        peak = max(peak, v)
        if peak > 0:
            max_dd = min(max_dd, v / peak - 1)
    sells = [e for e in entries if e["type"] == "sell"]
    print(json.dumps({
        "net_deposits": _round2(net_in),
        "last_total_value": last_value,
        "total_pnl": _round2(last_value - net_in),
        "total_pnl_pct": round(last_value / net_in - 1, 6) if net_in > 0 else None,
        "realized_pnl": st["realized_pnl"],
        "max_drawdown_pct": round(max_dd, 6),
        "settle_days": len(settles),
        "sell_count": len(sells),
        "note": "纸交易记录，不构成投资建议",
    }, ensure_ascii=False))


def cmd_positions(d: Path, _args: argparse.Namespace) -> None:
    today = datetime.now().date().isoformat()
    st = replay(load_ledger(d))
    out = []
    for code, pos in sorted(st["positions"].items()):
        view = position_view(pos)
        available = sum(lot["qty"] for lot in pos["lots"] if lot["date"] < today)
        out.append({"code": code, "name": pos["name"], **view, "available": available})
    print(json.dumps({"cash": st["cash"], "positions": out}, ensure_ascii=False))


def cmd_history(d: Path, _args: argparse.Namespace) -> None:
    for e in load_ledger(d):
        print(json.dumps(e, ensure_ascii=False))


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------


def main() -> None:
    p = argparse.ArgumentParser(prog="broker", description="paper-broker 纸交易账本")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("init")
    sp.add_argument("dir")
    sp.add_argument("--cash", type=float, required=True)

    for name in ("deposit", "withdraw"):
        sp = sub.add_parser(name)
        sp.add_argument("dir")
        sp.add_argument("amount", type=float)

    for name in ("buy", "sell"):
        sp = sub.add_parser(name)
        sp.add_argument("dir")
        sp.add_argument("code")
        sp.add_argument("qty", type=int)
        sp.add_argument("--price", type=float, default=None)
        sp.add_argument("--date", default=None, help="交易日 YYYY-MM-DD，默认今天")
        sp.add_argument("--name", default=None)

    sp = sub.add_parser("settle")
    sp.add_argument("dir")
    sp.add_argument("--date", default=None)
    sp.add_argument("--prices", default=None, help='JSON：{"600519": 1500.0}，跳过取价')

    for name in ("positions", "pnl", "history", "verify"):
        sp = sub.add_parser(name)
        sp.add_argument("dir")

    args = p.parse_args()
    d = Path(args.dir)

    if args.cmd == "init":
        if _ledger_path(d).exists():
            raise SystemExit(f"{d} 已有账本，不能重复 init")
        d.mkdir(parents=True, exist_ok=True)
        if args.cash <= 0:
            raise SystemExit("初始资金必须为正")
        append_entry(d, {"type": "init", "cash": _round2(args.cash)})
        save_state(d, load_ledger(d))
        print(json.dumps({"ok": True, "cash": _round2(args.cash)}, ensure_ascii=False))
        return

    _require_dir(d)
    if args.cmd in ("deposit", "withdraw"):
        if args.amount <= 0:
            raise SystemExit("金额必须为正")
        st = replay(load_ledger(d))
        if args.cmd == "withdraw" and st["cash"] < args.amount:
            raise SystemExit(f"现金不足：可用 {st['cash']}，要取 {args.amount}")
        append_entry(d, {"type": args.cmd, "amount": _round2(args.amount)})
        view = save_state(d, load_ledger(d))
        print(json.dumps({"ok": True, "cash": view["cash"]}, ensure_ascii=False))
    elif args.cmd == "buy":
        cmd_buy(d, args)
    elif args.cmd == "sell":
        cmd_sell(d, args)
    elif args.cmd == "settle":
        cmd_settle(d, args)
    elif args.cmd == "positions":
        cmd_positions(d, args)
    elif args.cmd == "pnl":
        cmd_pnl(d, args)
    elif args.cmd == "history":
        cmd_history(d, args)
    elif args.cmd == "verify":
        problems = verify(d)
        if problems:
            print(json.dumps({"ok": False, "problems": problems}, ensure_ascii=False))
            sys.exit(1)
        print(json.dumps({"ok": True, "entries": len(load_ledger(d))}, ensure_ascii=False))


if __name__ == "__main__":
    main()
