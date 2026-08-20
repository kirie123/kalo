"""宏观快照与分析。

三个命令的分工：
    now      —— 现在的值（人看的）
    append   —— 落一行进 daily.jsonl（cron 用，**正常必须完全静默**）
    analyze  —— 读历史算出相对位置（模型看的，**输出必须小**）

analyze 的输出体积是硬约束：进上下文的只能是结论性数值，250 天历史留在
磁盘上。否则 token 就从"采集"漏到"分析"这一侧了。
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from . import fetch as fetch_mod
from . import metrics as m
from . import store
from .registry import load_sources

# 收益率、利差这类本身就是百分数的指标，变化要用「个百分点」而不是「百分比」
ABS_CHANGE_KEYS = {
    "us2y", "us5y", "us10y", "us30y",
    "cn2y", "cn5y", "cn10y", "cn30y",
    "term_spread_us", "cn_us_spread_10y", "vix",
}

# analyze 输出的指标清单：(字段, 中文名)。刻意收敛——不是每个采集到的
# 字段都值得进上下文。中文名不进输出（体积），它在这里是给读代码的人和
# SKILL.md 对照表用的。
ANALYZE_KEYS = [
    ("dxy", "美元指数"),
    ("us10y", "美债10Y"),
    ("us2y", "美债2Y"),
    ("term_spread_us", "美债10Y-2Y期限利差"),
    ("cn10y", "中债10Y"),
    ("cn_us_spread_10y", "中美10Y利差"),
    ("usdcny", "美元兑人民币"),
    ("gold", "纽约黄金"),
    ("copper", "纽约铜"),
    ("copper_gold_ratio", "铜金比"),
    ("oil", "纽约原油"),
    ("vix", "VIX"),
    ("btc", "比特币"),
    ("nasdaq", "纳斯达克"),
    ("hsi", "恒生指数"),
    ("sh_index", "上证指数"),
    ("cyb_index", "创业板指"),
    ("total_turnover_yi", "两市成交额(亿元)"),
    ("limit_up_count", "涨停家数"),
    ("broken_board_count", "炸板家数"),
    ("margin_balance", "两融余额"),
]


def derive_fields(values: dict[str, Any]) -> dict[str, Any]:
    """派生量：单个数字没意义，组合才有。

    这些是宏观分析真正要看的东西，而不是原始报价：
      - 期限利差倒挂是经典衰退信号
      - 中美利差决定人民币压力与外资流向
      - 铜金比是「经济动能 vs 避险」的经典比值
    """
    out: dict[str, Any] = {}

    def num(key: str) -> float | None:
        v = values.get(key)
        try:
            return float(v) if v is not None else None
        except (TypeError, ValueError):
            return None

    us10y, us2y = num("us10y"), num("us2y")
    if us10y is not None and us2y is not None:
        out["term_spread_us"] = round(us10y - us2y, 4)

    cn10y = num("cn10y")
    if cn10y is not None and us10y is not None:
        out["cn_us_spread_10y"] = round(cn10y - us10y, 4)

    copper, gold = num("copper"), num("gold")
    if copper is not None and gold is not None and gold != 0:
        out["copper_gold_ratio"] = round(copper / gold, 5)

    sh, sz = num("sh_turnover_wan"), num("sz_turnover_wan")
    if sh is not None and sz is not None:
        # 源的口径是万元，转成亿元：万元 / 10000
        out["total_turnover_yi"] = round((sh + sz) / 10000, 1)

    return out


def snapshot(fresh: bool = False) -> dict[str, Any]:
    """拉全部宏观源，合并成一行事实 + 派生量 + errors[]。

    单源失败只让那几个字段变 null 并记进 errors，绝不中断整体。
    """
    values: dict[str, Any] = {}
    errors: list[dict[str, str]] = []

    for src in load_sources():
        if src.group != "macro":
            continue
        res = fetch_mod.fetch(src, fresh=fresh)
        values.update(res.values)
        if not res.ok:
            errors.append({"source": src.id, "msg": res.error or "unknown"})

    values.update(derive_fields(values))
    values["date"] = date.today().isoformat()
    values["at"] = datetime.now().isoformat(timespec="seconds")
    if errors:
        values["errors"] = errors
    return values


def analyze(window: int = 250) -> dict[str, Any]:
    """读历史 → 每个指标的现值/分位数/多周期变化 + 几组背离检测。

    输出用「表头 + 数组行」而不是对象数组，纯粹是为了体积：同样的信息，
    对象数组要把 key/name/v/pct/d1... 这些字段名重复二十遍，实测 3.1 KB；
    表格形式压到 1 KB 以内。指标中文名不进输出，SKILL.md 里有对照表——
    那份表模型写报告时本来就要看。
    """
    rows = store.read_all()
    if window > 0:
        rows = rows[-window:]

    n = len(rows)
    table, pp_keys = [], []
    for key, _name in ANALYZE_KEYS:
        s = store.series(rows, key)
        is_pp = key in ABS_CHANGE_KEYS
        d = m.describe(s, abs_change=is_pp)
        if d.get("value") is None:
            continue  # 该指标还没攒到数据，不占上下文
        table.append([key, d["value"], d["pct_rank"], d["chg_1"], d["chg_5"], d["chg_20"], d["chg_60"]])
        if is_pp:
            pp_keys.append(key)

    # 背离：两个指标近 5 日方向是否相反。BTC/纳指背离通常领先风险偏好转向。
    pairs = [
        ("btc", "nasdaq", "BTC-纳指"),
        ("dxy", "gold", "美元-黄金"),
        ("sh_index", "total_turnover_yi", "上证-成交额"),
    ]
    divergences = []
    for a, b, label in pairs:
        verdict = m.divergence(store.series(rows, a), store.series(rows, b), periods=5)
        if verdict:
            divergences.append([label, verdict])

    out: dict[str, Any] = {
        "as_of": rows[-1].get("date") if rows else None,
        "samples": n,
        "window": window,
        "cols": ["key", "v", "pct", "d1", "d5", "d20", "d60"],
        "rows": table,
        # 这些 key 的 d* 是「个百分点」，其余是「百分比」
        "pp_keys": pp_keys,
        "divergences": divergences,
    }
    # 分位数在样本少时没有意义，必须让模型看见这一点
    if n < 60:
        out["warning"] = f"仅 {n} 个交易日样本，分位数不可靠，只看方向"
    return out
