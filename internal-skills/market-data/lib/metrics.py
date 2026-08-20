"""指标计算：纯函数，不联网、不读盘。

这里是「事实 → 事实」的加工层：给一列数，算出它的相对位置与变化方向。
**不产出任何判断**——"美债 4.65% 处于近一年 92 分位"是事实，
"利率太高了要跌"是判断，后者属于 SKILL.md 里的模型。

分位数是这套东西的核心：4.65% 这个数字单独看毫无意义，只有相对自己的
历史才知道是高是低。所有指标都走同一套刻画。

MA / MACD / RSI / BIAS 本期宏观分析用不满，是为下一期个股体检备的
（那份体检清单里的技术面判据正是这几个）。
"""

from __future__ import annotations

import math
from typing import Sequence


def _clean(series: Sequence[float | None]) -> list[float]:
    """丢掉 None 与 NaN。数据源缺一天是常态，不该让整条指标失效。"""
    out = []
    for v in series:
        if v is None:
            continue
        try:
            f = float(v)
        except (TypeError, ValueError):
            continue
        if not math.isnan(f):
            out.append(f)
    return out


def percentile_rank(series: Sequence[float | None], value: float | None = None) -> float | None:
    """value 在 series 中的百分位（0-100）。默认取 series 最后一个值。

    用「小于等于 value 的比例」定义：100 = 历史最高，0 = 历史最低。
    """
    data = _clean(series)
    if not data:
        return None
    if value is None:
        value = data[-1]
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    below = sum(1 for x in data if x <= value)
    return round(below / len(data) * 100, 1)


def change_pct(series: Sequence[float | None], periods: int) -> float | None:
    """相对 N 期前的变化百分比。样本不足返回 None，不返回 0——
    "没数据"和"没变化"是两回事，模型必须能区分。"""
    data = _clean(series)
    if len(data) <= periods:
        return None
    prev, cur = data[-periods - 1], data[-1]
    if prev == 0:
        return None
    return round((cur - prev) / abs(prev) * 100, 2)


def change_abs(series: Sequence[float | None], periods: int) -> float | None:
    """相对 N 期前的绝对变化。收益率、利差这类本身就是百分数的指标用它。"""
    data = _clean(series)
    if len(data) <= periods:
        return None
    return round(data[-1] - data[-periods - 1], 4)


def sma(series: Sequence[float | None], window: int) -> float | None:
    data = _clean(series)
    if len(data) < window:
        return None
    return round(sum(data[-window:]) / window, 4)


def ema_series(data: list[float], window: int) -> list[float]:
    """指数移动平均全序列。首值用首个数据点，与主流行情软件一致。"""
    if not data:
        return []
    k = 2 / (window + 1)
    out = [data[0]]
    for x in data[1:]:
        out.append(x * k + out[-1] * (1 - k))
    return out


def macd(
    series: Sequence[float | None], fast: int = 12, slow: int = 26, signal: int = 9
) -> dict[str, float | None]:
    """MACD。返回 DIF / DEA / 柱（已 ×2，与国内行情软件口径一致）。"""
    data = _clean(series)
    if len(data) < slow + signal:
        return {"dif": None, "dea": None, "hist": None}
    ef, es = ema_series(data, fast), ema_series(data, slow)
    dif = [a - b for a, b in zip(ef, es)]
    dea = ema_series(dif, signal)
    return {
        "dif": round(dif[-1], 4),
        "dea": round(dea[-1], 4),
        "hist": round((dif[-1] - dea[-1]) * 2, 4),
    }


def rsi(series: Sequence[float | None], window: int = 6) -> float | None:
    """RSI（Wilder 平滑）。"""
    data = _clean(series)
    if len(data) <= window:
        return None
    gains, losses = [], []
    for prev, cur in zip(data, data[1:]):
        d = cur - prev
        gains.append(max(d, 0.0))
        losses.append(max(-d, 0.0))
    avg_gain = sum(gains[:window]) / window
    avg_loss = sum(losses[:window]) / window
    for g, l in zip(gains[window:], losses[window:]):
        avg_gain = (avg_gain * (window - 1) + g) / window
        avg_loss = (avg_loss * (window - 1) + l) / window
    if avg_loss == 0:
        return 100.0 if avg_gain > 0 else 50.0
    rs = avg_gain / avg_loss
    return round(100 - 100 / (1 + rs), 2)


def bias(series: Sequence[float | None], window: int = 6) -> float | None:
    """乖离率：(现价 - MA) / MA × 100。衡量偏离均线多远。"""
    data = _clean(series)
    if len(data) < window:
        return None
    ma = sum(data[-window:]) / window
    if ma == 0:
        return None
    return round((data[-1] - ma) / ma * 100, 2)


def correlation(a: Sequence[float | None], b: Sequence[float | None]) -> float | None:
    """皮尔逊相关系数。两列按尾部对齐取等长（历史长度常常不同）。"""
    xa, xb = _clean(a), _clean(b)
    n = min(len(xa), len(xb))
    if n < 3:
        return None
    xa, xb = xa[-n:], xb[-n:]
    ma, mb = sum(xa) / n, sum(xb) / n
    cov = sum((x - ma) * (y - mb) for x, y in zip(xa, xb))
    va = math.sqrt(sum((x - ma) ** 2 for x in xa))
    vb = math.sqrt(sum((y - mb) ** 2 for y in xb))
    if va == 0 or vb == 0:
        return None
    return round(cov / (va * vb), 3)


def divergence(
    a: Sequence[float | None], b: Sequence[float | None], periods: int = 5
) -> str | None:
    """两个指标近 N 期的方向是否背离。

    返回 "diverging"（一涨一跌）/ "aligned"（同向）/ None（数据不足）。
    用途例：BTC 与纳指背离，通常意味着全球风险偏好正在边际转向。
    """
    ca, cb = change_pct(a, periods), change_pct(b, periods)
    if ca is None or cb is None:
        return None
    if ca == 0 or cb == 0:
        return "aligned"
    return "diverging" if (ca > 0) != (cb > 0) else "aligned"


def describe(
    series: Sequence[float | None], name: str = "", abs_change: bool = False
) -> dict:
    """一个指标的标准刻画：现值 + 分位数 + 多周期变化。

    abs_change=True 用于收益率/利差这类本身是百分数的指标——
    对它们说"上升 3.2%"没有意义，要说"上升 0.05 个百分点"。
    """
    data = _clean(series)
    if not data:
        return {"name": name, "value": None, "samples": 0}
    delta = change_abs if abs_change else change_pct
    return {
        "name": name,
        "value": data[-1],
        "pct_rank": percentile_rank(data),
        "chg_1": delta(data, 1),
        "chg_5": delta(data, 5),
        "chg_20": delta(data, 20),
        "chg_60": delta(data, 60),
        "samples": len(data),
    }


# ---------------------------------------------------------------------------
# K 线形态与结构（个股体检用）
#
# 下面这些函数只产出**事实**：均线值、方向、回撤幅度、形态出现次数。
# 「多头排列健康吗」「回撤够不够深」这类判断留给 SKILL.md 里的模型——
# 阈值是会随市场风格漂移的东西，写死在代码里会过期。
# ---------------------------------------------------------------------------


def ma_stack(closes: Sequence[float | None], windows: Sequence[int] = (5, 10, 20, 60)) -> dict:
    """多条均线的现值、近 3 日方向，以及是否从长到短依次递增（多头排列）。

    方向不用"这一根比上一根高"来判断——单日噪声太大。这里取 3 日前的
    均线值作比较，与清单里"近 3 天是否拐头向下"的问法一致。
    """
    data = _clean(closes)
    out: dict = {"ma": {}, "slope3": {}}
    values: list[float] = []
    for w in windows:
        cur = sma(data, w)
        out["ma"][f"ma{w}"] = cur
        # 3 日前的同周期均线：把序列尾部砍掉 3 根再算
        prev = sma(data[:-3], w) if len(data) > w + 3 else None
        out["slope3"][f"ma{w}"] = None if cur is None or prev is None else round(cur - prev, 4)
        values.append(cur if cur is not None else float("nan"))

    if any(v != v for v in values):  # NaN 检查：均线没算全就不下结论
        out["bull_aligned"] = None
        out["all_rising"] = None
    else:
        out["bull_aligned"] = all(values[i] > values[i + 1] for i in range(len(values) - 1))
        out["all_rising"] = all((out["slope3"][f"ma{w}"] or 0) > 0 for w in windows)
    out["price_above_all"] = (
        None if not data or any(v != v for v in values) else all(data[-1] > v for v in values)
    )
    return out


def drawdown_rebound(
    highs: Sequence[float | None],
    lows: Sequence[float | None],
    closes: Sequence[float | None],
    window: int = 100,
) -> dict:
    """近 N 日的「最高点 → 最低点跌了多少 → 又反弹了多少」。

    清单里问这个是为了看解套盘压力：反弹到接近前高时，套牢盘获得离场
    机会，抛压变大。所以还要给出**现价相对前高的位置**（0-100）。

    低点必须取**高点之后**的那个——同一窗口里若最低价出现在最高价之前，
    那段跌幅根本没发生过（50→100→75 不是「从 100 跌了 50%」）。
    先定 peak，再在其右侧找 trough，得到的才是真实的回撤路径。

    shape 三态：
        up            高点就是最后一根，仍在创新高，没有回撤
        down          低点就是最后一根，还在下跌途中
        down_then_up  跌完之后有反弹——解套盘压力的那种形态
    """
    h, lo, c = _clean(highs), _clean(lows), _clean(closes)
    if not h or not lo or not c:
        return {"samples": 0}
    h, lo, c = h[-window:], lo[-window:], c[-window:]
    hi_i = max(range(len(h)), key=lambda i: h[i])
    # 只在高点右侧找低点；高点就在最后一根时退化为它自己（回撤为 0）
    tail = range(hi_i, len(lo))
    lo_i = min(tail, key=lambda i: lo[i])
    peak, trough, last = h[hi_i], lo[lo_i], c[-1]

    if hi_i == len(h) - 1:
        shape = "up"
    elif lo_i == len(lo) - 1:
        shape = "down"
    else:
        shape = "down_then_up"

    return {
        "samples": len(c),
        "peak": round(peak, 3),
        "trough": round(trough, 3),
        "peak_idx_from_end": len(h) - 1 - hi_i,
        "trough_idx_from_end": len(lo) - 1 - lo_i,
        "shape": shape,
        "drop_pct": round((trough - peak) / peak * 100, 2) if peak else None,
        "rebound_pct": round((last - trough) / trough * 100, 2) if trough else None,
        # 0 = 还在最低点，100 = 已回到前高
        "recovery_pct": round((last - trough) / (peak - trough) * 100, 1)
        if peak > trough
        else None,
    }


def candle_shapes(
    opens: Sequence[float | None],
    highs: Sequence[float | None],
    lows: Sequence[float | None],
    closes: Sequence[float | None],
    window: int = 20,
) -> dict:
    """数近 N 根 K 线里的长上影 / 十字星 / 墓碑线，并给出最近一次的位置。

    定义（比例都相对当日全幅 high-low，避免受价格绝对水平影响）：
      长上影  上影线 ≥ 全幅 50%，且实体 ≤ 全幅 30%
      十字星  实体 ≤ 全幅 10%
      墓碑线  上影线 ≥ 全幅 60% 且下影线 ≤ 全幅 10%（十字星的一个子集）

    这几个阈值是形态识别的通行口径，写在这里是因为它们定义的是「什么叫
    长上影」这件事实，不是「长上影意味着该卖」那个判断。
    """
    o, h, lo, c = _clean(opens), _clean(highs), _clean(lows), _clean(closes)
    n = min(len(o), len(h), len(lo), len(c), window)
    if n == 0:
        return {"samples": 0}
    o, h, lo, c = o[-n:], h[-n:], lo[-n:], c[-n:]

    counts = {"upper_shadow": 0, "doji": 0, "gravestone": 0}
    last_seen: dict[str, int | None] = {k: None for k in counts}
    for i in range(n):
        span = h[i] - lo[i]
        if span <= 0:
            continue
        body = abs(c[i] - o[i])
        upper = h[i] - max(o[i], c[i])
        lower = min(o[i], c[i]) - lo[i]
        hits = []
        if upper >= span * 0.5 and body <= span * 0.3:
            hits.append("upper_shadow")
        if body <= span * 0.1:
            hits.append("doji")
        if upper >= span * 0.6 and lower <= span * 0.1:
            hits.append("gravestone")
        for k in hits:
            counts[k] += 1
            last_seen[k] = n - 1 - i  # 距今几根
    return {"samples": n, "counts": counts, "bars_ago": last_seen}


def stagnation(
    closes: Sequence[float | None], highs: Sequence[float | None], window: int = 10
) -> dict:
    """震荡滞涨的构成事实：区间涨幅、区间振幅、创新高次数、收盘价站上区间高位的比例。

    「滞涨」的判据是**涨幅小但振幅大**——天天在动，就是不往上走。
    这里给出两个数让模型自己比，不在代码里定阈值。
    """
    c, h = _clean(closes), _clean(highs)
    n = min(len(c), len(h), window)
    if n < 3:
        return {"samples": n}
    c, h = c[-n:], h[-n:]
    top, bottom = max(h), min(c)
    new_highs = sum(1 for i in range(1, n) if h[i] >= max(h[:i]))
    return {
        "samples": n,
        "range_pct": round((c[-1] - c[0]) / c[0] * 100, 2) if c[0] else None,
        "amplitude_pct": round((top - bottom) / bottom * 100, 2) if bottom else None,
        "new_high_count": new_highs,
        "close_in_range": round((c[-1] - bottom) / (top - bottom) * 100, 1)
        if top > bottom
        else None,
    }
