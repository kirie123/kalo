use super::*;
use crate::market_model::{security, MarketBar};

struct Temp(std::path::PathBuf);
impl Temp {
    fn new() -> Self { Self(std::env::temp_dir().join(format!("kalo-series-test-{}", uuid::Uuid::new_v4()))) }
    fn save(&self, data: &Dataset) { crate::storage::save(&self.0, "datasets", &data.id, data).unwrap(); }
}
impl Drop for Temp { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

fn data(days: &[u32]) -> Dataset {
    Dataset {
        series_key: SINA_SERIES.into(), kind: "marketDataset".into(), schema_version: 1,
        id: uuid::Uuid::new_v4().to_string(), created_at: "2026-11-10T00:00:00Z".into(),
        security: security("002415.SZ").unwrap(), timeframe: "5m".into(), timezone: "Asia/Shanghai".into(),
        price_basis: "raw".into(), source: "新浪分钟 / 腾讯证券报价与原始、前复权日线".into(),
        source_hash: "fresh-evidence".into(), raw_ids: vec![uuid::Uuid::new_v4().to_string()],
        sessions: days.iter().map(|d| format!("2026-11-{d:02}")).collect(), warnings: vec![], blocked_sessions: vec![],
        bars: days.iter().flat_map(|day| crate::market_data::slots().into_iter().map(move |m| MarketBar {
            end: format!("2026-11-{day:02}T{:02}:{:02}:00+08:00", m/60, m%60), session: format!("2026-11-{day:02}"),
            open: 10.0, close: 10.0, high: 10.0, low: 10.0, volume: 100.0, previous_close: 10.0,
        })).collect(),
    }
}
fn daily() -> Vec<Bar> {
    (1..=9).map(|d| Bar { date:format!("2026-11-{d:02}"), open:10.0, close:10.0, high:11.0, low:9.0, volume:4800.0, adjusted_close:10.0 }).collect()
}
fn bars(data: &Dataset) -> serde_json::Value { serde_json::to_value(&data.bars).unwrap() }

#[test]
fn legacy_tencent_differences_do_not_block_new_sina_window_or_modify_old_files() {
    let temp = Temp::new();
    let mut old = data(&[3,4]);
    old.series_key.clear(); old.source = "腾讯5分钟 / 腾讯原始、前复权日线交叉校验".into();
    old.bars[0].close -= 0.01; old.bars[0].volume -= 68.0;
    temp.save(&old);
    let path = temp.0.join("datasets").join(format!("{}.json", old.id));
    let before = std::fs::read(&path).unwrap();
    let mut fresh = data(&[2,3,4]); let expected = bars(&fresh);
    extend(&temp.0, &mut fresh, &daily(), "2026-11-10").unwrap();
    assert_eq!(bars(&fresh), expected); assert_eq!(fresh.sessions.len(), 3);
    assert!(fresh.warnings.iter().any(|w| w.contains("来源或口径不同") && w.contains(&old.id)));
    assert!(!fresh.raw_ids.contains(&old.raw_ids[0]));
    assert_eq!(std::fs::read(path).unwrap(), before);
}

#[test]
fn legacy_sina_without_new_field_extends_and_revalidates_full_history() {
    let temp = Temp::new(); let mut old = data(&[2,3]); old.series_key.clear();
    let value = serde_json::to_value(&old).unwrap(); assert!(value.get("seriesKey").is_none());
    let old: Dataset = serde_json::from_value(value).unwrap(); temp.save(&old);
    let mut fresh = data(&[3,4]);
    extend(&temp.0, &mut fresh, &daily(), "2026-11-10").unwrap();
    assert_eq!(fresh.bars.len(), 144); assert_eq!(fresh.sessions, vec!["2026-11-02","2026-11-03","2026-11-04"]);
    assert!(fresh.raw_ids.contains(&old.raw_ids[0]));
    assert!(fresh.warnings.iter().any(|w| w.contains("已合并同源连续历史")));
}

#[test]
fn same_provider_revision_is_isolated_without_poisoning_compatible_history() {
    let temp = Temp::new(); let compatible = data(&[2,3]); temp.save(&compatible);
    let mut revised = data(&[3,4]); revised.bars[0].close = 10.01; revised.bars[0].volume = 200.0; temp.save(&revised);
    let mut fresh = data(&[3,4]);
    extend(&temp.0, &mut fresh, &daily(), "2026-11-10").unwrap();
    assert_eq!(fresh.bars.len(), 144); assert_eq!(fresh.bars[48].close, 10.0);
    assert!(!fresh.raw_ids.contains(&revised.raw_ids[0]));
    assert!(fresh.warnings.iter().any(|w| w.contains(&revised.id) && w.contains("2026-11-03T09:35") && w.contains("close、volume")));
}

#[test]
fn gaps_partial_sessions_and_missing_daily_evidence_cannot_enter_a_merge() {
    for case in 0..3 {
        let temp = Temp::new(); let mut old = data(&[2,3,4]);
        if case == 0 { old.bars.retain(|b| b.session != "2026-11-03"); }
        if case == 1 { old.bars.remove(0); }
        temp.save(&old); let mut fresh = data(&[4,5]); let expected = bars(&fresh);
        let evidence = if case == 2 { daily().into_iter().filter(|d| d.date >= "2026-11-03".to_string()).collect() } else { daily() };
        extend(&temp.0, &mut fresh, &evidence, "2026-11-10").unwrap();
        assert_eq!(bars(&fresh), expected); assert!(!fresh.raw_ids.contains(&old.raw_ids[0]));
        assert!(fresh.warnings.iter().any(|w| w.contains("未合并历史")));
    }
}

#[test]
fn chained_windows_are_deterministic_and_corrupt_files_do_not_block_verified_data() {
    let temp = Temp::new();
    let mut oldest = data(&[2,3]); oldest.created_at = "2099".into();
    temp.save(&oldest); temp.save(&data(&[4,5])); temp.save(&data(&[3,4]));
    std::fs::write(temp.0.join("datasets/broken.json"), "{invalid").unwrap();
    let original = data(&[5,6]); let mut a = original.clone(); let mut b = original;
    extend(&temp.0, &mut a, &daily(), "2026-11-10").unwrap();
    extend(&temp.0, &mut b, &daily(), "2026-11-10").unwrap();
    assert_eq!(a.bars.len(), 240); assert_eq!(a.source_hash, b.source_hash);
    assert_eq!(a.warnings, b.warnings); assert!(a.warnings.iter().any(|w| w.contains("broken")));
}

#[test]
fn unknown_sources_timezones_and_disconnected_windows_are_not_assumed_compatible() {
    let fresh = data(&[4,5]); let mut old = data(&[3,4]);
    old.series_key.clear(); old.source = "未知来源".into();
    assert_eq!(merge(&mut fresh.clone(), &old).unwrap(), Merge::Foreign);
    old.series_key = SINA_SERIES.into(); old.timezone = "UTC".into();
    assert_eq!(merge(&mut fresh.clone(), &old).unwrap(), Merge::Unrelated);
    assert_eq!(merge(&mut fresh.clone(), &data(&[2,3])).unwrap(), Merge::Disconnected);
}

#[test]
fn identical_resync_does_not_shrink_or_duplicate_bars() {
    let temp = Temp::new(); let old = data(&[2,3,4]); temp.save(&old);
    let mut fresh = old.clone(); let expected = bars(&fresh);
    extend(&temp.0, &mut fresh, &daily(), "2026-11-10").unwrap();
    assert_eq!(bars(&fresh), expected); assert_eq!(fresh.raw_ids.len(), 1);
    assert!(fresh.warnings.is_empty());
}
