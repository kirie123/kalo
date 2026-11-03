use super::*;

#[test]
fn record_day_executed_buys_and_sells_change_actual_entitlement() {
    for (side, expected) in [("buy", 1100), ("sell", 900)] {
        let d = distributed();
        let mut s = strategy_runtime::defaults(&d).unwrap();
        s.source = format!("fn on_bar(ctx) {{ if !(\"done\" in ctx.state) {{ #{{side:\"{side}\", quantity:100, state:#{{done:true}}}} }} else {{ #{{side:\"hold\",quantity:0}} }} }}");
        let report = run(&d, &s).unwrap();
        let entry = report
            .action_ledger
            .iter()
            .find(|e| e.account == "strategy" && e.stage == "现金到账")
            .unwrap();
        assert_eq!(entry.eligible_shares, expected);
        assert_eq!(entry.cash_delta, expected as f64);
    }
}
fn distributed() -> Dataset {
    let mut d = dataset();
    d.corporate_actions = vec![crate::corporate_actions::CorporateAction {
        id: "dividend".into(),
        record_date: "2026-11-02".into(),
        ex_date: "2026-11-03".into(),
        pay_date: Some("2026-11-03".into()),
        listing_date: None,
        cash_per_share: 1.0,
        bonus_per_share: 0.0,
        transfer_per_share: 0.0,
        announced_at: "2026-10-20".into(),
        reference_price: 9.0,
        source: "issuer".into(),
        evidence_ids: vec!["raw".into()],
    }];
    for b in d.bars.iter_mut().skip(48) {
        b.open -= 1.0;
        b.high -= 1.0;
        b.low -= 1.0;
        b.close -= 1.0;
    }
    d
}
#[test]
fn full_range_hold_preserves_total_return_and_benchmark_across_distribution() {
    let d = distributed();
    let mut s = strategy_runtime::defaults(&d).unwrap();
    s.source = "fn on_bar(ctx) { #{side: \"hold\",quantity:0} }".into();
    let r = run(&d, &s).unwrap();
    assert_eq!(s.start, d.bars[30].end);
    assert_eq!(r.total_return, 0.0);
    assert_eq!(r.benchmark_return, 0.0);
    assert!(r
        .equity
        .iter()
        .all(|p| p.equity == r.initial_equity && p.equity == p.benchmark));
    assert_eq!(r.equity.last().unwrap().cash, s.cash + 1000.0);
    assert_eq!(
        r.action_ledger
            .iter()
            .filter(|e| e.stage == "现金到账")
            .count(),
        2
    );
}
#[test]
fn future_events_cannot_change_prior_signals_and_history_is_in_current_price_units() {
    let d = distributed();
    let plain = dataset();
    let k = strategy_runtime::kdj(&d);
    let before = strategy_runtime::kdj(&plain);
    for i in 0..48 {
        assert_eq!(k[i].k, before[i].k);
    }
    assert_eq!(k[48].k, 50.0);
    assert!(k[48].ready);
    let window = crate::corporate_actions::history(&d, 40, 48);
    assert!(window.iter().all(|b| b.close == 9.0));
    assert_eq!(d.bars[40].close, 10.0);
}
#[test]
fn initial_position_with_missing_prior_entitlement_requires_earlier_start() {
    let d = distributed();
    let mut s = strategy_runtime::defaults(&d).unwrap();
    s.start = d.bars[78].end.clone();
    assert!(validate(&d, &s).unwrap_err().contains("起点前"));
    s.base_position = 0;
    assert!(validate(&d, &s).is_ok());
    let mut duplicate = d.clone();
    duplicate
        .corporate_actions
        .push(d.corporate_actions[0].clone());
    assert!(validate(&duplicate, &s).unwrap_err().contains("重复"));
}
#[test]
fn next_day_signal_is_cancelled_and_ex_date_limit_uses_reference_price() {
    let d = distributed();
    let mut s = strategy_runtime::defaults(&d).unwrap();
    s.slippage_bps = 0.0;
    s.source="fn on_bar(ctx) { if ctx.time == \"15:00\" || ctx.time == \"09:35\" { #{side:\"sell\",quantity:100} } else { #{side:\"hold\",quantity:0} } }".into();
    let r = run(&d, &s).unwrap();
    assert!(r.orders.iter().any(|o| o.reason == "跨交易日订单失效"));
    assert!(r.orders.iter().any(|o| o.quantity == 100 && o.price == 9.0));
}
#[test]
fn split_cost_and_baseline_work_and_odd_lot_can_be_fully_sold() {
    let mut d = distributed();
    let a = &mut d.corporate_actions[0];
    a.cash_per_share = 0.0;
    a.pay_date = None;
    a.transfer_per_share = 0.5;
    a.listing_date = Some(a.ex_date.clone());
    a.reference_price = 10.0 / 1.5;
    for b in d.bars.iter_mut().skip(48) {
        b.open = 10.0 / 1.5;
        b.close = b.open;
        b.low = 6.0;
        b.high = 8.0;
    }
    let mut s = strategy_runtime::defaults(&d).unwrap();
    s.source = "fn on_bar(ctx) { #{side:\"hold\",quantity:0} }".into();
    let r = run(&d, &s).unwrap();
    let last = r.equity.last().unwrap();
    assert_eq!(last.position, 1500);
    assert!((last.equity - r.initial_equity).abs() < 1e-6);
    assert!((last.average_cost - 10.0 / 1.5).abs() < 1e-6);
    let mut account = Account::new(0.0, 105, 10.0);
    let b = bar();
    let sec = security("002415.SZ").unwrap();
    let order = Intent {
        side: "sell".into(),
        quantity: 105,
        state: None,
    };
    assert_eq!(
        execute(&order, &b, Some(&b), &mut account, &spec(), &sec, 5).quantity,
        105
    );
    assert_eq!(account.position, 0);
}
