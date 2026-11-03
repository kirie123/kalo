use super::*;

pub(crate) fn action() -> CorporateAction {
    CorporateAction {
        id: "event".into(),
        record_date: "2026-11-02".into(),
        ex_date: "2026-11-03".into(),
        pay_date: Some("2026-11-04".into()),
        listing_date: Some("2026-11-05".into()),
        cash_per_share: 1.0,
        bonus_per_share: 0.1,
        transfer_per_share: 0.4,
        announced_at: "2026-10-20".into(),
        reference_price: 6.0,
        source: "issuer".into(),
        evidence_ids: vec!["raw".into()],
    }
}
#[test]
fn delayed_cash_and_shares_preserve_assets_without_becoming_tradeable_early() {
    let mut a = Account::new(1000.0, 1000, 10.0);
    let mut log = vec![];
    a.record(&[action()], "2026-11-02", "strategy", &mut log)
        .unwrap();
    assert_eq!(a.value(10.0), 11000.0);
    a.open("2026-11-03", "strategy", &mut log);
    assert_eq!(
        (
            a.cash,
            a.receivable,
            a.position,
            a.sellable,
            a.pending_shares
        ),
        (100000, 100000, 1000, 1000, 500)
    );
    assert_eq!(a.value(6.0), 11000.0);
    assert_eq!(a.cost, 1000000);
    // Sell old shares on ex-date: the dividend entitlement is retained.
    a.sold(1000, 600000);
    a.cash += 600000;
    a.position = 0;
    a.sellable = 0;
    assert_eq!(a.value(6.0), 11000.0);
    a.open("2026-11-04", "strategy", &mut log);
    assert_eq!((a.cash, a.receivable, a.sellable), (800000, 0, 0));
    a.open("2026-11-05", "strategy", &mut log);
    assert_eq!((a.position, a.sellable, a.pending_shares), (500, 500, 0));
    assert!((a.average_cost() - 6.66666).abs() < 0.0001);
    a.open("2026-11-06", "strategy", &mut log);
    assert_eq!(log.iter().filter(|e| e.stage == "现金到账").count(), 1);
    assert_eq!(log.iter().filter(|e| e.stage == "股份上市").count(), 1);
}
#[test]
fn entitlement_uses_record_close_position_including_t1_buys_not_sellable_inventory() {
    let mut a = Account::new(1000.0, 100, 10.0);
    let mut log = vec![];
    a.bought(100, 100000);
    a.cash -= 100000;
    a.position += 100;
    a.record(&[action()], "2026-11-02", "strategy", &mut log)
        .unwrap();
    a.open("2026-11-03", "strategy", &mut log);
    assert_eq!(a.receivable, 20000);
    assert_eq!(a.pending_shares, 100);
    // New purchases after record date do not receive that event's distribution.
    a.position += 100;
    a.open("2026-11-04", "strategy", &mut log);
    assert_eq!(a.cash, 20000);
    assert_eq!(a.dividend_income, 20000);
}
#[test]
fn zero_holding_and_fractional_entitlement_are_never_invented() {
    let mut a = Account::default();
    let mut log = vec![];
    a.record(&[action()], "2026-11-02", "strategy", &mut log)
        .unwrap();
    a.open("2026-11-06", "strategy", &mut log);
    assert_eq!(a.value(6.0), 0.0);
    assert!(a
        .record(&[action()], "2026-11-02", "strategy", &mut log)
        .is_err());
    let mut b = Account::new(0.0, 101, 10.0);
    assert!(b
        .record(&[action()], "2026-11-02", "strategy", &mut vec![])
        .unwrap_err()
        .contains("零碎"));
}
#[test]
fn cash_distribution_does_not_reduce_cost_and_double_count_income() {
    let mut e = action();
    e.bonus_per_share = 0.0;
    e.transfer_per_share = 0.0;
    e.listing_date = None;
    let mut a = Account::new(0.0, 100, 10.0);
    let mut log = vec![];
    a.record(&[e], "2026-11-02", "strategy", &mut log).unwrap();
    a.open("2026-11-04", "strategy", &mut log);
    assert_eq!(a.average_cost(), 10.0);
    a.sold(100, 90000);
    a.position = 0;
    a.cash += 90000;
    assert_eq!(a.realized + a.dividend_income, 0);
    assert_eq!(a.value(9.0), 1000.0);
}
