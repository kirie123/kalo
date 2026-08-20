"""个股体检：把一只股票的取数与计算收成一份**事实 JSON**。

这里不写任何「健康 / 危险 / 该买该卖」。输出的每一项都是可核对的数字或
原文（均线值、回撤幅度、公告标题、解禁日期），判断规则在
`internal-skills/stock-checkup/SKILL.md` 里由模型执行。

这条线同时也是 token 边界：取数与计算零 token，只有解读才动模型。

组织方式对着体检清单的三大类：
    risk    风险排查——财报、质押、公告、解禁、减持、大宗折价
    health  健康度——量价、压力位、均线、MACD、RSI/BIAS、K 线形态
    catalyst 催化——概念板块、资金流、涨停
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from . import fetch as fetch_mod
from . import metrics as m
from .registry import Source, find_source

KLINE_DAYS = 130  # 够算 MA60 与百日回撤，再多没用


# ---------------------------------------------------------------------------
# 代码 → 各家源要的不同写法
# ---------------------------------------------------------------------------


def code_params(code: str) -> dict[str, str]:
    """一个 6 位代码派生出五家源各自要的形态。

    交易所归属只看首位：6 = 沪（含 68 科创），其余为深（含 30 创业、8 北交
    在这套接口里也走深的前缀）。这是 A 股代码规则，不是猜的。

    只有 orgid 要联网查（巨潮那张 szse_stock.json，filing 模块已经缓存了
    一天），查不到就留空——只影响公告那一条源，其余照常。
    """
    code = code.strip()
    is_sh = code.startswith("6")
    params = {
        "code": code,
        "secid": f"{'1' if is_sh else '0'}.{code}",
        "secucode": f"{code}.{'SH' if is_sh else 'SZ'}",
        "tencent": f"{'sh' if is_sh else 'sz'}{code}",
        "cninfo_column": "sse" if is_sh else "szse",
        "days": str(KLINE_DAYS),
    }
    try:
        from . import filing

        params["orgid"] = filing.org_id(code) or ""
    except Exception:  # noqa: BLE001 — 查不到 orgId 不该让整份体检失败
        params["orgid"] = ""
    return params


def _rows(src_id: str, params: dict[str, str], fresh: bool, errors: list[dict]) -> list[Any]:
    """取一条表格源；失败只记进 errors 并返回空表——单源失败不中断体检。"""
    src: Source | None = find_source(src_id)
    if src is None:
        errors.append({"source": src_id, "msg": "源未注册"})
        return []
    rows, err = fetch_mod.fetch_rows(src, params=params, fresh=fresh)
    if err:
        errors.append({"source": src_id, "msg": err})
        return []
    return rows or []


def _num(v: Any) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _day(v: Any) -> str | None:
    """东财的日期统一是 "2026-08-03 00:00:00"，只留日期部分。"""
    return str(v)[:10] if v else None


def _within(date_str: str | None, days: int) -> bool:
    if not date_str:
        return False
    try:
        d = datetime.strptime(date_str[:10], "%Y-%m-%d")
    except ValueError:
        return False
    return abs((datetime.now() - d).days) <= days


# ---------------------------------------------------------------------------
# 三大类
# ---------------------------------------------------------------------------


def _parse_kline(rows: list[Any]) -> dict[str, list[float | None]]:
    """腾讯每行是 [日期, 开, 收, 高, 低, 成交量(手)]，转成按列的序列。

    最后一根在盘中是**未收盘**的临时值——不剔除，但会在输出里标出日期，
    让模型知道自己看的是不是当天的实时价。
    """
    out: dict[str, list[float | None]] = {"date": [], "open": [], "close": [], "high": [], "low": [], "volume": []}
    for r in rows:
        if not isinstance(r, list) or len(r) < 6:
            continue
        out["date"].append(r[0])
        out["open"].append(_num(r[1]))
        out["close"].append(_num(r[2]))
        out["high"].append(_num(r[3]))
        out["low"].append(_num(r[4]))
        out["volume"].append(_num(r[5]))
    return out


def _health(k: dict[str, list], quote: dict) -> dict:
    """量价 + 压力位 + 均线 + MACD + RSI/BIAS + 形态。清单第（2）大类。"""
    close, high, low, opn, vol = k["close"], k["high"], k["low"], k["open"], k["volume"]

    # 清单对 MACD 问了三件事：DIF 在不在 0 轴上、DIF 有没有拐头向下、
    # 红柱近 3 天是不是持续变长。后两件都需要历史值，所以把最近 4 天各算一遍。
    hist_seq: list[float | None] = []
    dif_seq: list[float | None] = []
    for cut in (3, 2, 1, 0):
        d = m.macd(close[: len(close) - cut] if cut else close)
        hist_seq.append(d["hist"])
        dif_seq.append(d["dif"])
    cur = m.macd(close)
    complete = not any(x is None for x in hist_seq)
    macd_out = {
        **cur,
        "dif_above_zero": None if cur["dif"] is None else cur["dif"] > 0,
        "hist_seq_4d": hist_seq,
        "hist_growing_3d": (
            all(hist_seq[i + 1] > hist_seq[i] for i in range(3)) if complete else None
        ),
        "dif_falling_3d": (
            None
            if any(x is None for x in dif_seq)
            else all(dif_seq[i + 1] < dif_seq[i] for i in range(3))
        ),
    }

    vol_ma5, vol_ma20 = m.sma(vol, 5), m.sma(vol, 20)
    return {
        "price": close[-1] if close else None,
        "chg_20d_pct": m.change_pct(close, 20),
        "chg_5d_pct": m.change_pct(close, 5),
        "turnover_rate": quote.get("turnover_rate"),
        "volume": {
            "ma5": round(vol_ma5, 0) if vol_ma5 else None,
            "ma20": round(vol_ma20, 0) if vol_ma20 else None,
            # >1 = 近期在放量。比"成交量多少手"更能直接看出变化
            "ratio_5_20": round(vol_ma5 / vol_ma20, 2) if vol_ma5 and vol_ma20 else None,
            "pct_rank_20d": m.percentile_rank(vol[-20:]) if len(vol) >= 20 else None,
        },
        "pressure": m.drawdown_rebound(high, low, close, window=100),
        "ma": m.ma_stack(close),
        "macd": macd_out,
        "rsi": {f"rsi{w}": m.rsi(close, w) for w in (6, 12, 24)},
        "bias": {f"bias{w}": m.bias(close, w) for w in (6, 12, 24)},
        "shapes_20d": m.candle_shapes(opn, high, low, close, window=20),
        "stagnation_10d": m.stagnation(close, high, window=10),
    }


def _risk(params: dict, fresh: bool, errors: list[dict], recent_days: int) -> dict:
    """质押 / 解禁 / 减持 / 大宗折价 / 公告。清单第（1）大类。"""
    pledge_rows = _rows("stock_pledge", params, fresh, errors)
    pledge = pledge_rows[0] if pledge_rows else {}

    # 解禁只看未来的：已经解禁完的批次不构成待兑现压力
    lifts = []
    for r in _rows("stock_lift", params, fresh, errors):
        d = _day(r.get("FREE_DATE"))
        if d and d >= datetime.now().strftime("%Y-%m-%d"):
            lifts.append({
                "date": d,
                "shares_wan": _num(r.get("CURRENT_FREE_SHARES")),
                "market_cap_wan": _num(r.get("LIFT_MARKET_CAP")),
                "ratio_of_float": _num(r.get("FREE_RATIO")),
                "type": r.get("FREE_SHARES_TYPE"),
            })
    lifts.sort(key=lambda x: x["date"])

    blocks = []
    for r in _rows("stock_block_trade", params, fresh, errors):
        d = _day(r.get("TRADE_DATE"))
        if _within(d, recent_days):
            blocks.append({
                "date": d,
                "price": _num(r.get("DEAL_PRICE")),
                "premium_ratio": _num(r.get("PREMIUM_RATIO")),
                "amount_wan": round((_num(r.get("DEAL_AMT")) or 0) / 1e4, 1),
                "buyer": r.get("BUYER_NAME"),
                "seller": r.get("SELLER_NAME"),
            })

    holder = []
    for r in _rows("stock_holder_change", params, fresh, errors):
        d = _day(r.get("NOTICE_DATE"))
        if _within(d, 365):  # 增减持看一年，20 天窗口太窄会全空
            holder.append({
                "notice_date": d,
                "direction": r.get("DIRECTION"),
                "shares_wan": _num(r.get("CHANGE_NUM")),
                "ratio_pct": _num(r.get("CHANGE_RATE")),
                "holder": r.get("HOLDER_NAME"),
            })

    anns = []
    for r in _rows("stock_announcements", params, fresh, errors):
        ts = r.get("announcementTime")
        d = None
        if isinstance(ts, (int, float)):
            d = datetime.fromtimestamp(ts / 1000).strftime("%Y-%m-%d")
        anns.append({"date": d, "title": (r.get("announcementTitle") or "").replace("<em>", "").replace("</em>", "")})

    return {
        "pledge": {
            "date": _day(pledge.get("TRADE_DATE")),
            "ratio_pct": _num(pledge.get("PLEDGE_RATIO")),
            "market_cap_wan": _num(pledge.get("PLEDGE_MARKET_CAP")),
        },
        "lift_upcoming": lifts[:5],
        "block_trades_recent": blocks,
        "block_discount_count": sum(1 for b in blocks if (b["premium_ratio"] or 0) < 0),
        "holder_changes_1y": holder[:10],
        "announcements_recent": anns[:20],
    }


def _catalyst(params: dict, fresh: bool, errors: list[dict]) -> dict:
    """概念板块 + 资金流。清单第（3）大类。"""
    boards = [
        {"name": r.get("BOARD_NAME"), "code": r.get("NEW_BOARD_CODE"), "rank": r.get("BOARD_RANK")}
        for r in _rows("stock_boards", params, fresh, errors)
        if r.get("BOARD_NAME")
    ]

    flow_rows = _rows("stock_fund_flow", params, fresh, errors)
    flows = []
    for r in flow_rows[-20:]:
        parts = str(r).split(",")
        if len(parts) < 7:
            continue
        flows.append({"date": parts[0], "main_net": _num(parts[1]), "main_pct": _num(parts[6])})
    main_series = [f["main_net"] for f in flows]
    net_sum = sum(v for v in main_series if v is not None) if main_series else None

    return {
        "boards": boards[:20],
        "fund_flow_20d": {
            "days": len(flows),
            "main_net_sum_yi": round(net_sum / 1e8, 2) if net_sum is not None else None,
            "inflow_days": sum(1 for v in main_series if v is not None and v > 0),
            "last5": flows[-5:],
        },
    }


def _limit_ups(code: str, k: dict[str, list], window: int = 20) -> dict:
    """近 N 日涨停。清单第（3）大类「主力发动」。

    没有现成的个股涨停历史接口，但涨停本身可以从日线判出来：涨幅贴着
    交易所的涨跌幅限制。阈值按板块——创业板 30 与科创板 688 是 20%，
    其余 10%；留 0.3 个点余量是因为**涨停价按四舍五入到分**，
    实际涨幅常常是 9.98% 或 10.03%，卡死 10% 会漏掉。

    "健康不健康"（是否放量、次日是否炸板）不在这里下结论，只给出
    当天的量比与次日涨跌，让模型自己看。
    """
    cap = 20.0 if code.startswith(("30", "688")) else 10.0
    close, vol = k["close"], k["volume"]
    out = []
    n = len(close)
    for i in range(max(1, n - window), n):
        prev, cur = close[i - 1], close[i]
        if prev is None or cur is None or prev == 0:
            continue
        chg = (cur - prev) / prev * 100
        if chg < cap - 0.3:
            continue
        ma5 = m.sma(vol[:i], 5)
        out.append({
            "date": k["date"][i],
            "chg_pct": round(chg, 2),
            # 涨停当天的量比：放量涨停与缩量涨停含义完全不同
            "vol_ratio_ma5": round(vol[i] / ma5, 2) if ma5 and vol[i] else None,
            # 次日涨跌：连板还是次日就回落，事实摆着
            "next_day_chg_pct": (
                round((close[i + 1] - cur) / cur * 100, 2)
                if i + 1 < n and close[i + 1] is not None
                else None
            ),
        })
    return {"limit_pct": cap, "count": len(out), "items": out}


def checkup(code: str, fresh: bool = False, recent_days: int = 20) -> dict:
    """一只股票的完整体检事实。永不抛异常——缺的部分进 errors[]。"""
    params = code_params(code)
    errors: list[dict] = []

    quote_src = find_source("stock_quote")
    quote: dict[str, Any] = {}
    if quote_src is not None:
        res = fetch_mod.fetch(quote_src, fresh=fresh, params=params)
        quote = res.values
        if not res.ok:
            errors.append({"source": "stock_quote", "msg": res.error})

    k = _parse_kline(_rows("stock_kline", params, fresh, errors))

    catalyst = _catalyst(params, fresh, errors)
    if k["close"]:
        catalyst["limit_ups_20d"] = _limit_ups(code, k, window=recent_days)

    out: dict[str, Any] = {
        "code": code,
        "name": quote.get("name"),
        "as_of": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "last_bar": k["date"][-1] if k["date"] else None,
        "bars": len(k["date"]),
        "quote": quote,
        "risk": _risk(params, fresh, errors, recent_days),
        "health": _health(k, quote) if k["close"] else {"samples": 0},
        "catalyst": catalyst,
    }
    if errors:
        out["errors"] = errors
    if len(k["date"]) < 60:
        out["warning"] = f"仅 {len(k['date'])} 根日线，MA60 与百日回撤不可用"
    return out
