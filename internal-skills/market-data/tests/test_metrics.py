"""metrics.py 的单测：合成数据，不联网。

对照标准是手算值，不是"跑一遍看着像"。联网数据会变，测试不能依赖它。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from lib import metrics as m  # noqa: E402


def test_percentile_rank():
    s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    assert m.percentile_rank(s) == 100.0  # 末值 10 是最大
    assert m.percentile_rank(s, 1) == 10.0  # 只有 1 个 <= 1
    assert m.percentile_rank(s, 5) == 50.0
    assert m.percentile_rank([]) is None


def test_percentile_rank_ignores_none():
    # 数据源缺一天是常态，不该让整条指标失效
    assert m.percentile_rank([1, None, 2, None, 3]) == 100.0
    assert m.percentile_rank([None, None]) is None


def test_change_pct():
    s = [100, 110, 121]
    assert m.change_pct(s, 1) == 10.0
    assert m.change_pct(s, 2) == 21.0
    # 样本不足返回 None 而不是 0——"没数据"与"没变化"必须可区分
    assert m.change_pct(s, 5) is None


def test_change_abs():
    # 收益率这类本身是百分数的指标走绝对变化
    assert m.change_abs([4.60, 4.62, 4.65], 1) == 0.03
    assert m.change_abs([4.60, 4.62, 4.65], 2) == 0.05


def test_sma():
    assert m.sma([1, 2, 3, 4, 5], 5) == 3.0
    assert m.sma([1, 2, 3], 5) is None


def test_ema_first_value_is_seed():
    assert m.ema_series([5, 5, 5], 3) == [5, 5, 5]
    assert m.ema_series([], 3) == []


def test_macd_flat_series_is_zero():
    # 恒定序列没有动量，DIF/DEA/柱都应为 0
    r = m.macd([100.0] * 60)
    assert r["dif"] == 0 and r["dea"] == 0 and r["hist"] == 0


def test_macd_uptrend_is_positive():
    r = m.macd([100 + i for i in range(60)])
    assert r["dif"] > 0  # 快线在慢线上方


def test_macd_insufficient_data():
    assert m.macd([1, 2, 3])["dif"] is None


def test_rsi_all_up_is_100():
    assert m.rsi([1, 2, 3, 4, 5, 6, 7, 8], 6) == 100.0


def test_rsi_all_down_is_0():
    assert m.rsi([8, 7, 6, 5, 4, 3, 2, 1], 6) == 0.0


def test_rsi_insufficient_data():
    assert m.rsi([1, 2, 3], 6) is None


def test_bias():
    # MA5 = 3，现价 5 → (5-3)/3*100 = 66.67
    assert m.bias([1, 2, 3, 4, 5], 5) == 66.67
    assert m.bias([5, 5, 5, 5, 5], 5) == 0.0


def test_correlation():
    assert m.correlation([1, 2, 3, 4], [2, 4, 6, 8]) == 1.0  # 完全正相关
    assert m.correlation([1, 2, 3, 4], [8, 6, 4, 2]) == -1.0  # 完全负相关
    assert m.correlation([1, 2], [1, 2]) is None  # 样本不足


def test_correlation_aligns_tails():
    # 两列历史长度不同时按尾部对齐
    assert m.correlation([9, 9, 1, 2, 3], [1, 2, 3]) == 1.0


def test_divergence():
    up = [1, 2, 3, 4, 5, 6]
    down = [6, 5, 4, 3, 2, 1]
    assert m.divergence(up, down, 5) == "diverging"
    assert m.divergence(up, up, 5) == "aligned"
    assert m.divergence([1, 2], [1, 2], 5) is None


def test_describe_shape():
    d = m.describe(list(range(1, 101)), name="测试")
    assert d["name"] == "测试"
    assert d["value"] == 100
    assert d["pct_rank"] == 100.0
    assert d["samples"] == 100
    assert d["chg_5"] is not None


def test_describe_abs_change_for_yields():
    # 收益率序列：变化应是"个百分点"而不是"百分比"
    d = m.describe([4.60, 4.61, 4.65], name="美债10Y", abs_change=True)
    assert d["chg_1"] == 0.04
    assert d["value"] == 4.65


def test_describe_empty():
    assert m.describe([], name="空")["samples"] == 0
