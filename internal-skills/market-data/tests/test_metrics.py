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


# ---------------------------------------------------------------------------
# 形态类：个股体检清单用的四个（合成序列，与手算对照）
# ---------------------------------------------------------------------------


def test_ma_stack_bull_aligned():
    # 严格单调上涨 → MA5>MA10>MA20>MA60 必然成立，且都在向上
    rising = list(range(1, 101))
    s = m.ma_stack(rising)
    assert s["bull_aligned"] is True
    assert s["all_rising"] is True
    assert s["price_above_all"] is True
    assert s["ma"]["ma5"] == 98.0  # (96+..+100)/5


def test_ma_stack_bear():
    falling = list(range(100, 0, -1))
    s = m.ma_stack(falling)
    assert s["bull_aligned"] is False
    assert s["all_rising"] is False
    assert s["price_above_all"] is False


def test_ma_stack_short_series():
    # 不够 60 根时 ma60 为 None，多头排列判不出来 → 不能谎报 True
    s = m.ma_stack(list(range(1, 31)))
    assert s["ma"]["ma60"] is None
    assert s["bull_aligned"] is None


def test_drawdown_rebound_down_then_up():
    # 先从 100 跌到 50，再反弹到 75：跌一半、弹一半、修复一半
    closes = list(range(100, 49, -1)) + list(range(51, 76))
    d = m.drawdown_rebound(closes, closes, closes, window=100)
    assert d["shape"] == "down_then_up"
    assert d["drop_pct"] == -50.0
    assert d["rebound_pct"] == 50.0
    assert d["recovery_pct"] == 50.0


def test_drawdown_rebound_ignores_trough_before_peak():
    # 50 → 100 → 75：低点在高点之前，那 50% 的跌幅根本没发生过。
    # 回撤必须只算高点右侧的 100 → 75。
    closes = list(range(50, 101)) + list(range(99, 74, -1))
    d = m.drawdown_rebound(closes, closes, closes, window=100)
    assert d["shape"] == "down"
    assert d["drop_pct"] == -25.0
    assert d["rebound_pct"] == 0.0


def test_drawdown_rebound_still_climbing():
    # 高点就是最后一根 → 没有回撤可言
    closes = [float(x) for x in range(1, 51)]
    d = m.drawdown_rebound(closes, closes, closes, window=100)
    assert d["shape"] == "up"
    assert d["drop_pct"] == 0.0


def test_candle_shapes_counts():
    # 前 19 根是普通实体阳线，最后一根造一根长上影
    o = [10.0] * 19 + [10.0]
    c = [10.5] * 19 + [10.1]
    h = [10.6] * 19 + [12.0]
    lo = [9.9] * 19 + [9.95]
    s = m.candle_shapes(o, h, lo, c, window=20)
    assert s["counts"]["upper_shadow"] == 1
    assert s["bars_ago"]["upper_shadow"] == 0  # 就是最后一根


def test_candle_shapes_doji():
    # 开=收、上下影都有 → 十字星
    o = [10.0] * 5
    c = [10.0] * 5
    h = [10.5] * 5
    lo = [9.5] * 5
    s = m.candle_shapes(o, h, lo, c, window=5)
    assert s["counts"]["doji"] == 5


def test_stagnation_flat():
    # 10 天在 100 附近横住：区间涨幅≈0，且没有新高
    closes = [100.0, 100.5, 99.8, 100.2, 100.1, 99.9, 100.3, 100.0, 100.1, 99.95]
    highs = [c + 0.3 for c in closes]
    s = m.stagnation(closes, highs, window=10)
    assert abs(s["range_pct"]) < 1
    assert s["new_high_count"] <= 1


def test_stagnation_trending():
    closes = [float(x) for x in range(100, 120)]
    highs = [c + 0.5 for c in closes]
    s = m.stagnation(closes, highs, window=10)
    assert s["range_pct"] > 5
    assert s["new_high_count"] == 9  # 除首根外每天都创新高，不是滞涨
