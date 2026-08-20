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
