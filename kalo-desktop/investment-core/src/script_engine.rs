use crate::{
    market_model::*,
    strategy_runtime::{self, Intent, Runtime},
};
use chrono::{Timelike, Utc};
use serde_json::json;
use sha2::{Digest, Sha256};

fn cents(v: f64) -> i64 {
    (v * 100.0).round() as i64
}
fn yuan(v: i64) -> f64 {
    v as f64 / 100.0
}
fn fees(amount: i64, buy: bool, spec: &ScriptSpec, security: &Security) -> (i64, i64, i64) {
    // Current A-share tariff, restricted to datasets after its effective date.
    let commission = cents((yuan(amount) * spec.commission_bps / 10000.0).max(spec.minimum_fee));
    let stamp = if buy || security.asset_type == "etf" {
        0
    } else {
        cents(yuan(amount) * 0.0005)
    };
    let transfer = if security.asset_type == "etf" {
        0
    } else {
        cents(yuan(amount) * 0.00001)
    };
    (commission, stamp, transfer)
}
struct Account {
    cash: i64,
    position: u64,
    sellable: u64,
}
fn execute(
    intent: &Intent,
    signal: &MarketBar,
    bar: Option<&MarketBar>,
    account: &mut Account,
    spec: &ScriptSpec,
    security: &Security,
    minutes: u32,
) -> ScriptOrder {
    let mut row = ScriptOrder {
        signal_at: signal.end.clone(),
        executed_at: None,
        side: intent.side.clone(),
        requested: intent.quantity,
        quantity: 0,
        price: 0.0,
        commission: 0.0,
        stamp_tax: 0.0,
        transfer_fee: 0.0,
        cash_after: yuan(account.cash),
        position_after: account.position,
        sellable_after: account.sellable,
        reason: String::new(),
    };
    let Some(bar) = bar else {
        row.reason = "区间结束，无下一根K线".into();
        return row;
    };
    if bar.session != signal.session {
        row.reason = "跨交易日订单失效".into();
        return row;
    }
    if bar.volume == 0.0 {
        row.reason = "下一根无实际成交，不能用陈旧价格撮合".into();
        return row;
    }
    if intent.quantity < crate::securities::minimum(security)
        || intent.quantity % security.lot_size != 0
    {
        row.reason = "订单数量未满足该证券最低申报数量或数量步长".into();
        return row;
    }
    let buy = intent.side == "buy";
    let upper = (bar.previous_close * (1.0 + security.price_limit) / security.tick_size).round()
        * security.tick_size;
    let lower = (bar.previous_close * (1.0 - security.price_limit) / security.tick_size).round()
        * security.tick_size;
    let price = ((bar.open
        * (1.0
            + if buy {
                spec.slippage_bps / 10000.0
            } else {
                -spec.slippage_bps / 10000.0
            }))
        / security.tick_size)
        .round()
        * security.tick_size;
    if (buy && (bar.open >= upper - 1e-8 || price > upper))
        || (!buy && (bar.open <= lower + 1e-8 || price < lower))
    {
        row.reason = "涨跌停或滑点后越过价格边界，保守拒单".into();
        return row;
    }
    let capacity =
        (signal.volume * 0.01 / security.lot_size as f64).floor() as u64 * security.lot_size;
    let mut quantity = intent.quantity.min(capacity);
    if !buy {
        quantity = quantity.min(account.sellable) / security.lot_size * security.lot_size;
    }
    if buy {
        let (mut lo, mut hi) = (0, quantity / security.lot_size);
        while lo < hi {
            let mid = (lo + hi + 1) / 2;
            let amount = cents(price * mid as f64 * security.lot_size as f64);
            let (c, s, t) = fees(amount, true, spec, security);
            if amount + c + s + t <= account.cash {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        quantity = lo * security.lot_size;
    }
    if quantity < crate::securities::minimum(security) {
        row.reason = if capacity == 0 {
            "前根成交量容量不足"
        } else if buy {
            "可用现金不足"
        } else {
            "可卖底仓不足或未满足最低申报数量（T+1新仓次日解锁）"
        }
        .into();
        return row;
    }
    let amount = cents(price * quantity as f64);
    let (c, s, t) = fees(amount, buy, spec, security);
    if buy {
        account.cash -= amount + c + s + t;
        account.position += quantity;
        if security.settlement_days == 0 {
            account.sellable += quantity;
        }
    } else {
        account.cash += amount - c - s - t;
        account.position -= quantity;
        account.sellable -= quantity;
    }
    row.quantity = quantity;
    row.executed_at = chrono::DateTime::parse_from_rfc3339(&bar.end)
        .ok()
        .map(|time| (time - chrono::Duration::minutes(i64::from(minutes))).to_rfc3339());
    row.price = price;
    row.commission = yuan(c);
    row.stamp_tax = yuan(s);
    row.transfer_fee = yuan(t);
    row.cash_after = yuan(account.cash);
    row.position_after = account.position;
    row.sellable_after = account.sellable;
    row.reason = if quantity < intent.quantity {
        "部分成交：现金、可卖库存或前根成交量1%限制"
    } else {
        "次根开盘成交"
    }
    .into();
    row
}

pub fn validate(data: &Dataset, spec: &ScriptSpec) -> Result<(), String> {
    crate::securities::verify(&data.security)?;
    let minutes = crate::securities::minutes(&data.timeframe)?;
    if data.kind != "marketDataset"
        || data.bars.len() > 10000
        || data.schema_version != 1
        || data.price_basis != "raw"
        || data.timezone != "Asia/Shanghai"
    {
        return Err("不支持的数据类型、规模、版本或价格口径".into());
    }
    if data.id != spec.dataset_id
        || spec.start > spec.end
        || data.bars.len() < 32
        || spec.title.trim().is_empty()
        || spec.title.len() > 200
    {
        return Err("数据集、标题或回测范围无效".into());
    }
    if spec.base_position > 10_000_000
        || spec.base_position % data.security.lot_size != 0
        || spec.trade_size < crate::securities::minimum(&data.security)
        || spec.trade_size > 10_000_000
        || spec.trade_size % data.security.lot_size != 0
    {
        return Err("底仓或每笔数量不符合冻结证券的数量规则（上限1000万股）".into());
    }
    for (v, min, max) in [
        (spec.cash, 0.0, 100_000_000.0),
        (spec.commission_bps, 0.0, 100.0),
        (spec.minimum_fee, 0.0, 1000.0),
        (spec.slippage_bps, 0.0, 100.0),
    ] {
        if !v.is_finite() || v < min || v > max {
            return Err("资金或费用参数超出范围".into());
        }
    }
    let start = data
        .bars
        .iter()
        .position(|b| b.end == spec.start)
        .ok_or("开始时间不在数据集中")?;
    let end = data
        .bars
        .iter()
        .position(|b| b.end == spec.end)
        .ok_or("结束时间不在数据集中")?;
    if start < 30 || end <= start {
        return Err(format!("开始时刻之前须有30根预热K线，最早可选 {}；结束时刻须晚于开始时刻。请使用目录返回的 defaultSpec 区间。", data.bars[30].end));
    }
    if data
        .blocked_sessions
        .iter()
        .any(|d| d >= &data.bars[start.saturating_sub(30)].session && d <= &data.bars[end].session)
    {
        return Err("所选区间或指标预热跨越除权除息，尚未支持分红送转账务。请选择同一公司行为区间并预留30根预热。".into());
    }
    let mut sessions: std::collections::BTreeMap<String, Vec<u32>> =
        std::collections::BTreeMap::new();
    for (i, b) in data.bars.iter().enumerate() {
        if b.session.as_str() < "2023-08-28"
            || !b.end.starts_with(&b.session)
            || chrono::DateTime::parse_from_rfc3339(&b.end).is_err()
        {
            return Err("行情时间或费用规则生效日无效".into());
        }
        if [b.open, b.high, b.low, b.close, b.volume, b.previous_close]
            .iter()
            .any(|n| !n.is_finite())
            || b.low <= 0.0
            || b.high > 1_000_000.0
            || b.low > b.open
            || b.high < b.open
            || b.low > b.close
            || b.high < b.close
            || b.volume < 0.0
            || b.previous_close <= 0.0
        {
            return Err("数据集OHLCV无效".into());
        }
        if i > 0 && b.end <= data.bars[i - 1].end {
            return Err("数据集时间重复或乱序".into());
        }
        let time = chrono::DateTime::parse_from_rfc3339(&b.end).map_err(|_| "时间无效")?;
        if time.offset().local_minus_utc() != 8 * 3600
            || time.second() != 0
            || time.nanosecond() != 0
        {
            return Err("分钟数据必须使用北京时间与整分钟边界".into());
        }
        sessions
            .entry(b.session.clone())
            .or_default()
            .push(time.hour() * 60 + time.minute());
        if i > 0
            && b.session == data.bars[i - 1].session
            && b.previous_close != data.bars[i - 1].previous_close
        {
            return Err("同一交易日前收盘价不一致".into());
        }
    }
    if sessions
        .values()
        .any(|times| *times != crate::market_data::slots_for(minutes))
        || sessions.keys().cloned().collect::<Vec<_>>() != data.sessions
    {
        return Err("冻结数据集交易日或分钟时段存在缺口".into());
    }
    Ok(())
}

pub fn run(data: &Dataset, spec: &ScriptSpec) -> Result<ScriptReport, String> {
    validate(data, spec)?;
    let runtime = Runtime::new(&spec.source)?;
    let indicators = strategy_runtime::kdj(data);
    let start = data.bars.iter().position(|b| b.end == spec.start).unwrap();
    let end = data.bars.iter().position(|b| b.end == spec.end).unwrap();
    let history_start = data.bars[..=start]
        .iter()
        .enumerate()
        .filter(|(i, b)| {
            data.blocked_sessions.contains(&b.session)
                && (*i == 0 || data.bars[*i - 1].session != b.session)
        })
        .map(|(i, _)| i)
        .last()
        .unwrap_or(0);
    let initial_equity = spec.cash + spec.base_position as f64 * data.bars[start].open;
    if initial_equity <= 0.0 {
        return Err("初始现金和底仓资产不能同时为零".into());
    }
    let mut account = Account {
        cash: cents(spec.cash),
        position: spec.base_position,
        sellable: spec.base_position,
    };
    let mut state = json!({});
    let mut pending: Option<(usize, Intent)> = None;
    let mut orders = vec![];
    let mut equity = vec![];
    let mut peak = initial_equity;
    let mut max_drawdown: f64 = 0.0;
    for i in start..=end {
        let bar = &data.bars[i];
        if i > start && bar.session != data.bars[i - 1].session {
            account.sellable = account.position;
        }
        if let Some((index, intent)) = pending.take() {
            orders.push(execute(
                &intent,
                &data.bars[index],
                Some(bar),
                &mut account,
                spec,
                &data.security,
                crate::securities::minutes(&data.timeframe)?,
            ));
        }
        let kdj = indicators[i];
        let intent=runtime.call(json!({"code":data.security.code,"date":bar.session,"time":&bar.end[11..16],"history":&data.bars[i.saturating_sub(119).max(history_start)..=i],"kdj":kdj,"previousKdj":indicators[i-1],"cash":yuan(account.cash),"position":account.position,"sellable":account.sellable,"basePosition":spec.base_position,"tradeSize":spec.trade_size,"state":state})).map_err(|e|format!("{} {e}",bar.end))?;
        if let Some(next) = &intent.state {
            state = next.clone();
        }
        if intent.side != "hold" {
            pending = Some((i, intent));
        }
        let value = yuan(account.cash) + account.position as f64 * bar.close;
        peak = peak.max(value);
        max_drawdown = max_drawdown.min(value / peak - 1.0);
        equity.push(ScriptEquity {
            time: bar.end.clone(),
            equity: value,
            benchmark: spec.cash + spec.base_position as f64 * bar.close,
            cash: yuan(account.cash),
            position: account.position,
            sellable: account.sellable,
            k: kdj.k,
            d: kdj.d,
            j: kdj.j,
        });
    }
    if let Some((index, intent)) = pending {
        orders.push(execute(
            &intent,
            &data.bars[index],
            None,
            &mut account,
            spec,
            &data.security,
            crate::securities::minutes(&data.timeframe)?,
        ));
    }
    let last = equity.last().unwrap();
    let total_return = last.equity / initial_equity - 1.0;
    let benchmark_return = last.benchmark / initial_equity - 1.0;
    let excess_pnl = last.equity - last.benchmark;
    let costs = orders
        .iter()
        .map(|o| o.commission + o.stamp_tax + o.transfer_fee)
        .sum();
    let mut warnings = data.warnings.clone();
    warnings.push("价格信号在收盘形成、下一根开盘撮合；跨日订单失效。成交量容量只使用前根已知成交量；涨跌停保守拒单，不模拟盘口队列。".into());
    warnings.push(
        if data.security.asset_type == "etf" {
            "ETF不计股票印花税与过户费；佣金含交易费用假设，滑点计入成交价。"
        } else {
            "佣金含经手/监管费用假设；卖出印花税0.05%，双边过户费0.001%，滑点计入成交价。"
        }
        .into(),
    );
    if account.position != spec.base_position {
        warnings.push(format!(
            "期末持仓{}股，初始底仓{}股；未强制回补，存在仓位偏离。",
            account.position, spec.base_position
        ));
    }
    Ok(ScriptReport {
        kind: "scriptReport".into(),
        timeframe: data.timeframe.clone(),
        id: uuid::Uuid::new_v4().to_string(),
        created_at: Utc::now().to_rfc3339(),
        dataset_hash: format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(data).map_err(|e| e.to_string())?)
        ),
        engine_hash: format!(
            "{:x}",
            Sha256::digest(format!(
                "{}{}{}{}{}{}",
                include_str!("script_engine.rs"),
                include_str!("strategy_runtime.rs"),
                include_str!("market_model.rs"),
                include_str!("securities.rs"),
                include_str!("../Cargo.toml"),
                include_str!("../Cargo.lock")
            ))
        ),
        spec: spec.clone(),
        security: data.security.clone(),
        equity,
        orders,
        initial_equity,
        total_return,
        benchmark_return,
        excess_pnl,
        max_drawdown,
        costs,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn spec() -> ScriptSpec {
        ScriptSpec {
            dataset_id: String::new(),
            title: "test".into(),
            source: String::new(),
            start: String::new(),
            end: String::new(),
            cash: 10000.0,
            base_position: 100,
            trade_size: 100,
            commission_bps: 2.5,
            minimum_fee: 5.0,
            slippage_bps: 0.0,
        }
    }
    fn bar() -> MarketBar {
        MarketBar {
            end: "2026-11-02T10:00:00+08:00".into(),
            session: "2026-11-02".into(),
            open: 10.0,
            high: 11.0,
            low: 9.0,
            close: 10.0,
            volume: 100000.0,
            previous_close: 10.0,
        }
    }
    fn dataset() -> Dataset {
        let mut bars = vec![];
        for day in ["2026-11-02", "2026-11-03"] {
            for minute in crate::market_data::slots() {
                let mut b = bar();
                b.session = day.into();
                b.end = format!("{day}T{:02}:{:02}:00+08:00", minute / 60, minute % 60);
                bars.push(b);
            }
        }
        Dataset {
            series_key: String::new(),
            kind: "marketDataset".into(),
            blocked_sessions: vec![],
            schema_version: 1,
            id: "frozen".into(),
            created_at: String::new(),
            security: security("002415.SZ").unwrap(),
            timeframe: "5m".into(),
            timezone: "Asia/Shanghai".into(),
            price_basis: "raw".into(),
            source: String::new(),
            source_hash: String::new(),
            raw_ids: vec![],
            bars,
            sessions: vec!["2026-11-02".into(), "2026-11-03".into()],
            warnings: vec![],
        }
    }
    #[test]
    fn future_prices_do_not_change_past_orders_and_fills_use_next_bar() {
        let data = dataset();
        let mut s = strategy_runtime::defaults(&data).unwrap();
        s.slippage_bps = 0.0;
        s.source="fn on_bar(ctx) { if ctx.history[ctx.history.len-1].close > 9.5 { #{side: \"buy\", quantity: 100} } else { #{side: \"hold\", quantity: 0} } }".into();
        let r = run(&data, &s).unwrap();
        assert_eq!(r.orders[0].signal_at, data.bars[30].end);
        assert_eq!(
            r.orders[0].executed_at.as_deref(),
            Some(data.bars[30].end.as_str())
        );
        assert_eq!(r.orders[0].price, data.bars[31].open);
        let mut changed = data.clone();
        changed.bars[70].close = 9.4;
        let next = run(&changed, &s).unwrap();
        assert_eq!(
            serde_json::to_value(&r.orders[..20]).unwrap(),
            serde_json::to_value(&next.orders[..20]).unwrap()
        );
        assert!(r
            .equity
            .iter()
            .all(|e| e.cash >= 0.0 && e.sellable <= e.position));
        changed.bars.remove(60);
        assert!(run(&changed, &s).is_err());
    }
    #[test]
    fn kdj_initialization_and_next_session_unlock_are_explicit() {
        let mut data = dataset();
        data.bars[8].close = 11.0;
        let k = strategy_runtime::kdj(&data);
        assert!(!k[7].ready);
        assert!((k[8].k - 66.6666666667).abs() < 1e-6);
        assert!((k[8].d - 55.5555555556).abs() < 1e-6);
        let mut s = strategy_runtime::defaults(&data).unwrap();
        s.base_position = 100;
        s.source="fn on_bar(ctx) { if !(\"day\" in ctx.state) || ctx.state.day != ctx.date { #{side: \"buy\",quantity: 100,state:#{day:ctx.date}} } else { #{side: \"sell\",quantity:200,state:ctx.state} } }".into();
        let r = run(&data, &s).unwrap();
        let sold: Vec<_> = r
            .orders
            .iter()
            .filter(|o| o.side == "sell" && o.quantity > 0)
            .collect();
        assert_eq!(sold.len(), 2);
        assert!(sold.iter().all(|o| o.quantity == 100));
        assert!(r.orders.iter().any(|o| o.reason.contains("T+1")));
    }
    #[test]
    fn buying_does_not_replenish_sellable_and_costs_are_separate() {
        let mut a = Account {
            cash: 1000000,
            position: 100,
            sellable: 100,
        };
        let b = bar();
        let s = spec();
        let sec = security("002415.SZ").unwrap();
        let buy = Intent {
            side: "buy".into(),
            quantity: 100,
            state: None,
        };
        let sell = Intent {
            side: "sell".into(),
            quantity: 200,
            state: None,
        };
        let bought = execute(&buy, &b, Some(&b), &mut a, &s, &sec, 5);
        assert_eq!(a.sellable, 100);
        assert_eq!(a.position, 200);
        assert_eq!(bought.stamp_tax, 0.0);
        let sold = execute(&sell, &b, Some(&b), &mut a, &s, &sec, 5);
        assert_eq!(sold.quantity, 100);
        assert_eq!(a.position, 100);
        assert_eq!(sold.stamp_tax, 0.5);
        assert_eq!(sold.transfer_fee, 0.01);
        assert_eq!(
            execute(&sell, &b, Some(&b), &mut a, &s, &sec, 5).quantity,
            0
        );
    }
    #[test]
    fn cross_day_limit_and_capacity_block_orders() {
        let mut a = Account {
            cash: 1000000,
            position: 100,
            sellable: 100,
        };
        let b = bar();
        let s = spec();
        let sec = security("002415.SZ").unwrap();
        let intent = Intent {
            side: "buy".into(),
            quantity: 100,
            state: None,
        };
        let mut next = b.clone();
        next.session = "2026-11-03".into();
        assert_eq!(
            execute(&intent, &b, Some(&next), &mut a, &s, &sec, 5).quantity,
            0
        );
        next = b.clone();
        next.open = 11.0;
        assert_eq!(
            execute(&intent, &b, Some(&next), &mut a, &s, &sec, 5).quantity,
            0
        );
        let mut no_capacity = b.clone();
        no_capacity.volume = 0.0;
        assert_eq!(
            execute(&intent, &no_capacity, Some(&b), &mut a, &s, &sec, 5).quantity,
            0
        );
        let blocked = execute(&intent, &b, Some(&no_capacity), &mut a, &s, &sec, 5);
        assert_eq!(blocked.quantity, 0);
        assert!(blocked.executed_at.is_none());
    }

    #[test]
    fn etf_uses_mill_ticks_no_stock_tax_and_explicit_same_day_inventory() {
        let mut sec = security("002415.SZ").unwrap();
        sec.code = "510300.SH".into();
        sec.exchange = "SSE".into();
        sec.asset_type = "etf".into();
        sec.tick_size = 0.001;
        sec.settlement_days = 0;
        let mut b = bar();
        b.open = 4.123;
        b.close = 4.123;
        b.low = 4.0;
        b.high = 4.2;
        b.previous_close = 4.1;
        let mut a = Account {
            cash: 1000000,
            position: 0,
            sellable: 0,
        };
        let buy = Intent {
            side: "buy".into(),
            quantity: 100,
            state: None,
        };
        let sell = Intent {
            side: "sell".into(),
            quantity: 100,
            state: None,
        };
        let bought = execute(&buy, &b, Some(&b), &mut a, &spec(), &sec, 60);
        assert!((bought.price - 4.123).abs() < 1e-8);
        assert_eq!(a.sellable, 100);
        assert_eq!(
            bought.executed_at.as_deref(),
            Some("2026-11-02T09:00:00+08:00")
        );
        let sold = execute(&sell, &b, Some(&b), &mut a, &spec(), &sec, 60);
        assert_eq!(sold.quantity, 100);
        assert_eq!(sold.stamp_tax, 0.0);
        assert_eq!(sold.transfer_fee, 0.0);
        assert_eq!(a.cash, 999000);
        sec.settlement_days = 1;
        execute(&buy, &b, Some(&b), &mut a, &spec(), &sec, 5);
        assert_eq!(
            execute(&sell, &b, Some(&b), &mut a, &spec(), &sec, 5).quantity,
            0
        );
    }

    #[test]
    fn star_minimum_and_single_share_increment_are_both_enforced() {
        let mut sec = security("002415.SZ").unwrap();
        sec.code = "688981.SH".into();
        sec.exchange = "SSE".into();
        sec.lot_size = 1;
        sec.price_limit = 0.2;
        let mut a = Account {
            cash: 1000000,
            position: 1000,
            sellable: 1000,
        };
        let b = bar();
        let mut intent = Intent {
            side: "buy".into(),
            quantity: 199,
            state: None,
        };
        assert_eq!(
            execute(&intent, &b, Some(&b), &mut a, &spec(), &sec, 5).quantity,
            0
        );
        intent.quantity = 201;
        assert_eq!(
            execute(&intent, &b, Some(&b), &mut a, &spec(), &sec, 5).quantity,
            201
        );
    }

    #[test]
    fn long_history_actions_block_only_affected_range_and_warmup() {
        let mut data = dataset();
        data.blocked_sessions = vec!["2026-11-02".into()];
        let safe = strategy_runtime::defaults(&data).unwrap();
        assert_eq!(safe.start, data.bars[78].end);
        assert!(validate(&data, &safe).is_ok());
        let mut crossing = safe.clone();
        crossing.start = data.bars[30].end.clone();
        assert!(validate(&data, &crossing).unwrap_err().contains("除权"));
        let indicators = strategy_runtime::kdj(&data);
        assert!(!indicators[0].ready);
        data.blocked_sessions = vec!["2026-11-03".into()];
        let indicators = strategy_runtime::kdj(&data);
        assert!(!indicators[48].ready);
        assert_eq!(indicators[48].k, 50.0);
        assert!(strategy_runtime::defaults(&data).is_none());
    }
}
