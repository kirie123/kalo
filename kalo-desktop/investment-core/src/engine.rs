use crate::model::*;
use chrono::{NaiveDate, Utc};
use rust_decimal::{prelude::ToPrimitive, Decimal};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

fn dec(n: f64) -> Result<Decimal, String> {
    n.to_string()
        .parse::<Decimal>()
        .map_err(|_| "数值超出精度范围".into())
}
fn value(n: Decimal) -> f64 {
    n.to_f64().unwrap_or(0.0)
}

pub fn validate(snapshot: &Snapshot, spec: &Spec) -> Result<(), String> {
    if spec.snapshot_id != snapshot.id {
        return Err("快照 ID 不一致".into());
    }
    for d in [&spec.start, &spec.end] {
        NaiveDate::parse_from_str(d, "%Y-%m-%d").map_err(|_| "日期格式错误")?;
    }
    if spec.start > spec.end
        || spec.lookback < 2
        || spec.lookback > 120
        || spec.rebalance < 1
        || spec.rebalance > 60
        || spec.holdings == 0
        || spec.holdings > snapshot.instruments.len()
    {
        return Err("请检查日期、动量窗口（2–120）、调仓间隔（1–60）和持仓数".into());
    }
    for (n, min, max) in [
        (spec.capital, 1000.0, 100_000_000.0),
        (spec.commission_bps, 0.0, 100.0),
        (spec.minimum_fee, 0.0, 1000.0),
        (spec.slippage_bps, 0.0, 100.0),
    ] {
        if !n.is_finite() || n < min || n > max {
            return Err("资金或费用参数超出范围".into());
        }
    }
    if snapshot.instruments.is_empty() {
        return Err("快照没有证券".into());
    }
    let reference = &snapshot.instruments[0].bars;
    if reference.len() < spec.lookback + 3 {
        return Err("历史不足，请先同步更多日线".into());
    }
    if spec.start < reference[spec.lookback + 1].date || spec.end > reference.last().unwrap().date {
        return Err(format!(
            "可回测日期：{} 至 {}（已预留信号预热）",
            reference[spec.lookback + 1].date,
            reference.last().unwrap().date
        ));
    }
    for instrument in &snapshot.instruments {
        if !["510300.SH", "510500.SH", "512100.SH"].contains(&instrument.code.as_str()) {
            return Err("此版本仅支持配置的沪市宽基 ETF".into());
        }
        if instrument.bars.len() != reference.len()
            || instrument
                .bars
                .iter()
                .zip(reference)
                .any(|(a, b)| a.date != b.date)
        {
            return Err(format!(
                "{} 行情日期存在缺口，禁止取交集掩盖缺失",
                instrument.code
            ));
        }
        for b in &instrument.bars {
            if [b.open, b.high, b.low, b.close, b.adjusted_close, b.volume]
                .iter()
                .any(|n| !n.is_finite())
                || b.low <= 0.0
                || b.adjusted_close <= 0.0
                || b.low > b.open
                || b.high < b.open
                || b.low > b.close
                || b.high < b.close
                || b.volume < 0.0
            {
                return Err("快照行情无效".into());
            }
        }
        for pair in instrument.bars.windows(2) {
            if pair[1].date <= pair[0].date {
                return Err("行情日期必须严格递增".into());
            }
            if pair[1].date >= spec.start && pair[1].date <= spec.end {
                let ratio = (pair[1].close / pair[1].adjusted_close)
                    / (pair[0].close / pair[0].adjusted_close);
                if (ratio - 1.0).abs() > 0.002 {
                    return Err(format!(
                        "{} {} 疑似分红/拆分，本版暂未处理，请将开始日期设在此日之后",
                        instrument.code, pair[1].date
                    ));
                }
            }
        }
    }
    Ok(())
}

fn has_flow(instrument: &Instrument, signal_date: &str) -> Result<bool, String> {
    let cutoff = chrono::DateTime::parse_from_rfc3339(&format!("{signal_date}T15:00:00+08:00"))
        .map_err(|e| e.to_string())?;
    let points: Vec<_> = instrument
        .funds
        .iter()
        .filter(|p| {
            p.date.as_str() <= signal_date
                && chrono::DateTime::parse_from_rfc3339(&p.available_at).is_ok_and(|t| t <= cutoff)
        })
        .collect();
    let recent: Vec<_> = points.iter().rev().take(5).collect();
    if recent.len() < 5 || recent.iter().any(|p| p.net_flow.is_none()) {
        return Err(format!(
            "{} 在 {} 前没有已观察到的完整 5 日资金数据；请选择价格动量或继续积累",
            instrument.code, signal_date
        ));
    }
    // Require five adjacent price-calendar dates; no skipping missing observations.
    let last = recent[0].date.as_str();
    let signal_index = instrument
        .bars
        .iter()
        .position(|b| b.date == signal_date)
        .ok_or("信号日期不存在")?;
    if signal_index > 0 && last < instrument.bars[signal_index - 1].date.as_str() {
        return Err("资金数据陈旧，不能用于当前调仓决策".into());
    }
    let calendar: Vec<_> = instrument
        .bars
        .iter()
        .filter(|b| b.date.as_str() <= last)
        .rev()
        .take(5)
        .collect();
    if calendar.len() != 5 || recent.iter().zip(calendar).any(|(p, b)| p.date != b.date) {
        return Err("资金窗口交易日不连续".into());
    }
    Ok(recent.iter().map(|p| p.net_flow.unwrap()).sum::<f64>() > 0.0)
}

pub fn run(snapshot: &Snapshot, spec: &Spec) -> Result<Report, String> {
    validate(snapshot, spec)?;
    let days = &snapshot.instruments[0].bars;
    let indices: Vec<_> = days
        .iter()
        .enumerate()
        .filter(|(_, b)| b.date >= spec.start && b.date <= spec.end)
        .map(|(i, _)| i)
        .collect();
    if indices.len() < 2 {
        return Err("回测至少需要两个交易日".into());
    }
    let mut cash = dec(spec.capital)?;
    let mut positions = vec![0u64; snapshot.instruments.len()];
    let mut trades = vec![];
    let mut equity = vec![];
    let mut peak = spec.capital;
    let mut fees = 0.0;
    let mut max_drawdown: f64 = 0.0;
    let benchmark_open = days[indices[0]].open;
    for (step, &i) in indices.iter().enumerate() {
        if step % spec.rebalance == 0 {
            let mut ranked = vec![];
            for (j, instrument) in snapshot.instruments.iter().enumerate() {
                if spec.flow_filter && !has_flow(instrument, &days[i - 1].date)? {
                    continue;
                }
                let score = instrument.bars[i - 1].adjusted_close
                    / instrument.bars[i - 1 - spec.lookback].adjusted_close
                    - 1.0;
                if score > 0.0 {
                    ranked.push((j, score));
                }
            }
            ranked.sort_by(|a, b| {
                b.1.total_cmp(&a.1).then_with(|| {
                    snapshot.instruments[a.0]
                        .code
                        .cmp(&snapshot.instruments[b.0].code)
                })
            });
            let selected: BTreeMap<usize, bool> = ranked
                .into_iter()
                .take(spec.holdings)
                .map(|(j, _)| (j, true))
                .collect();
            let budget = value(cash)
                + positions
                    .iter()
                    .enumerate()
                    .map(|(j, q)| *q as f64 * snapshot.instruments[j].bars[i - 1].close)
                    .sum::<f64>();
            let targets: Vec<u64> = snapshot
                .instruments
                .iter()
                .enumerate()
                .map(|(j, s)| {
                    if selected.contains_key(&j) {
                        (budget / spec.holdings as f64 / s.bars[i - 1].close / 100.0).floor() as u64
                            * 100
                    } else {
                        0
                    }
                })
                .collect();
            for buy in [false, true] {
                for (j, instrument) in snapshot.instruments.iter().enumerate() {
                    let current = positions[j];
                    let target = targets[j];
                    if (buy && target <= current) || (!buy && target >= current) {
                        continue;
                    }
                    let bar = &instrument.bars[i];
                    let prev = &instrument.bars[i - 1];
                    let requested = target.abs_diff(current);
                    let limit = (prev.volume * 0.01 / 100.0).floor() as u64 * 100;
                    let mut qty = requested.min(limit);
                    let slipped = bar.open
                        * (1.0
                            + if buy {
                                spec.slippage_bps / 10000.0
                            } else {
                                -spec.slippage_bps / 10000.0
                            });
                    let price = if buy {
                        (slipped * 1000.0).ceil() / 1000.0
                    } else {
                        (slipped * 1000.0).floor() / 1000.0
                    };
                    let blocked = bar.volume == 0.0
                        || (bar.high - bar.low).abs() < 0.00001
                        || price > bar.high
                        || price < bar.low
                        || (buy && bar.open >= prev.close * 1.099)
                        || (!buy && bar.open <= prev.close * 0.901);
                    if blocked {
                        qty = 0;
                    }
                    let price_d = dec(price)?;
                    let fee_for = |q: u64| -> Result<Decimal, String> {
                        Ok((price_d * Decimal::from(q) * dec(spec.commission_bps)?
                            / Decimal::from(10000))
                        .max(dec(spec.minimum_fee)?)
                        .round_dp(2))
                    };
                    if buy {
                        // Bounded decrement: first cap by cash, then account for fees.
                        qty = qty.min((value(cash) / price / 100.0).floor() as u64 * 100);
                        while qty > 0 && price_d * Decimal::from(qty) + fee_for(qty)? > cash {
                            qty -= 100;
                        }
                    }
                    let fee = if qty > 0 {
                        fee_for(qty)?
                    } else {
                        Decimal::ZERO
                    };
                    let notional = price_d * Decimal::from(qty);
                    if buy {
                        cash -= notional + fee;
                        positions[j] += qty;
                    } else {
                        cash += notional - fee;
                        positions[j] -= qty;
                    }
                    if cash < Decimal::ZERO {
                        return Err("账本异常：现金为负".into());
                    }
                    fees += value(fee);
                    trades.push(Trade {
                        date: bar.date.clone(),
                        code: instrument.code.clone(),
                        side: if buy { "买入" } else { "卖出" }.into(),
                        quantity: qty,
                        price,
                        fee: value(fee),
                        cash_after: value(cash),
                        reason: if blocked {
                            "停牌、价格限制或滑点超出日内范围"
                        } else if qty == 0 {
                            "资金不足或容量不足"
                        } else if qty < requested {
                            "部分成交：现金或前日成交量 1% 限制"
                        } else {
                            "调仓成交"
                        }
                        .into(),
                    });
                }
            }
        }
        let nav = value(cash)
            + positions
                .iter()
                .enumerate()
                .map(|(j, q)| *q as f64 * snapshot.instruments[j].bars[i].close)
                .sum::<f64>();
        peak = peak.max(nav);
        let drawdown = nav / peak - 1.0;
        max_drawdown = max_drawdown.min(drawdown);
        equity.push(Equity {
            date: days[i].date.clone(),
            equity: nav,
            cash: value(cash),
            benchmark: spec.capital * days[i].close / benchmark_open,
            drawdown,
        });
    }
    let total_return = equity.last().unwrap().equity / spec.capital - 1.0;
    let hash = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(snapshot).map_err(|e| e.to_string())?)
    );
    let engine_hash = format!(
        "{:x}",
        Sha256::digest(concat!(include_str!("engine.rs"), include_str!("model.rs")).as_bytes())
    );
    Ok(Report {
        id: uuid::Uuid::new_v4().to_string(),
        created_at: Utc::now().to_rfc3339(),
        snapshot_hash: hash,
        engine_version: env!("CARGO_PKG_VERSION").into(),
        engine_hash,
        spec: spec.clone(), equity, trades, total_return, max_drawdown, fees,
        warnings: vec![
            "固定存续 ETF 池的研究回测，存在选择偏差；非历史时点认证数据。".into(),
            "日线开盘模型，按前日成交量 1% 约束容量，不能还原真实盘口。".into(),
            "公司行为仅按复权比率变化检测，微小分红或供应商错误可能未被识别。".into(),
            "基准为沪深300 ETF 区间开盘买入持有，不计基准交易成本；期末持仓按收盘估值，未强制平仓。".into(),
        ],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Snapshot, Spec) {
        let bars = (1..=12)
            .map(|i| {
                let p = 10.0 + i as f64;
                Bar {
                    date: format!("2026-01-{i:02}"),
                    open: p,
                    close: p,
                    high: p + 1.0,
                    low: p - 1.0,
                    adjusted_close: p,
                    volume: 1e8,
                }
            })
            .collect();
        let snapshot = Snapshot {
            id: uuid::Uuid::new_v4().to_string(),
            created_at: "2026-11-03T00:00:00Z".into(),
            source: "test".into(),
            instruments: vec![Instrument {
                code: "510300.SH".into(),
                name: "test".into(),
                bars,
                funds: vec![],
            }],
            warnings: vec![],
        };
        let spec = Spec {
            snapshot_id: snapshot.id.clone(),
            start: "2026-01-05".into(),
            end: "2026-01-12".into(),
            capital: 100000.0,
            lookback: 2,
            rebalance: 60,
            holdings: 1,
            commission_bps: 0.0,
            minimum_fee: 0.0,
            slippage_bps: 0.0,
            flow_filter: false,
        };
        (snapshot, spec)
    }
    #[test]
    fn next_open_cash_and_benchmark() {
        let (s, p) = fixture();
        let r = run(&s, &p).unwrap();
        assert_eq!(r.trades[0].price, 15.0);
        assert_eq!(r.trades[0].quantity, 6600);
        assert_eq!(r.equity.last().unwrap().equity, 146200.0);
        assert_eq!(r.equity[0].equity, 100000.0);
        assert!(r.equity.iter().all(|e| e.cash >= 0.0));
    }
    #[test]
    fn fees_reduce_affordable_quantity() {
        let (s, mut p) = fixture();
        p.capital = 99000.0;
        p.minimum_fee = 5.0;
        let r = run(&s, &p).unwrap();
        assert_eq!(r.trades[0].quantity, 6500);
        assert_eq!(r.fees, 5.0);
        assert_eq!(r.trades[0].cash_after, 1495.0);
    }
    #[test]
    fn future_price_cannot_change_initial_signal() {
        let (mut s, p) = fixture();
        let a = run(&s, &p).unwrap();
        s.instruments[0].bars[8].close = 19.5;
        s.instruments[0].bars[8].adjusted_close = 19.5;
        let b = run(&s, &p).unwrap();
        assert_eq!(a.trades[0].quantity, b.trades[0].quantity);
    }
    #[test]
    fn corporate_action_blocks() {
        let (mut s, p) = fixture();
        s.instruments[0].bars[6].adjusted_close *= 0.5;
        assert!(run(&s, &p).unwrap_err().contains("分红"));
    }
    #[test]
    fn funds_not_known_at_signal_block() {
        let (s, mut p) = fixture();
        p.flow_filter = true;
        assert!(run(&s, &p).unwrap_err().contains("资金数据"));
    }
    #[test]
    fn price_gap_is_not_silently_intersected() {
        let (mut s, p) = fixture();
        let mut other = s.instruments[0].clone();
        other.code = "510500.SH".into();
        other.bars.remove(5);
        s.instruments.push(other);
        assert!(run(&s, &p).unwrap_err().contains("缺口"));
    }
}
