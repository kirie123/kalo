//! One source of truth for supported Shanghai-listed equity ETFs.
pub struct Entry {
    pub code: &'static str,
    pub name: &'static str,
    pub category: &'static str,
    pub price_limit: f64,
}

pub const ENTRIES: &[Entry] = &[
    Entry {
        code: "510300.SH",
        name: "沪深300 ETF",
        category: "宽基",
        price_limit: 0.10,
    },
    Entry {
        code: "510500.SH",
        name: "中证500 ETF",
        category: "宽基",
        price_limit: 0.10,
    },
    Entry {
        code: "512100.SH",
        name: "中证1000 ETF",
        category: "宽基",
        price_limit: 0.10,
    },
    Entry {
        code: "588300.SH",
        name: "双创50 ETF",
        category: "双创",
        price_limit: 0.20,
    },
    Entry {
        code: "588000.SH",
        name: "科创50 ETF",
        category: "双创",
        price_limit: 0.20,
    },
    Entry {
        code: "512480.SH",
        name: "半导体 ETF",
        category: "行业主题",
        price_limit: 0.10,
    },
    Entry {
        code: "512660.SH",
        name: "军工 ETF",
        category: "行业主题",
        price_limit: 0.10,
    },
    Entry {
        code: "512800.SH",
        name: "银行 ETF",
        category: "行业主题",
        price_limit: 0.10,
    },
    Entry {
        code: "512880.SH",
        name: "证券 ETF",
        category: "行业主题",
        price_limit: 0.10,
    },
    Entry {
        code: "512170.SH",
        name: "医疗 ETF",
        category: "行业主题",
        price_limit: 0.10,
    },
    Entry {
        code: "512010.SH",
        name: "医药 ETF",
        category: "行业主题",
        price_limit: 0.10,
    },
    Entry {
        code: "512690.SH",
        name: "酒 ETF",
        category: "行业主题",
        price_limit: 0.10,
    },
    Entry {
        code: "515030.SH",
        name: "新能源车 ETF",
        category: "行业主题",
        price_limit: 0.10,
    },
];

pub fn find(code: &str) -> Option<&'static Entry> {
    ENTRIES.iter().find(|entry| entry.code == code)
}

pub fn at_price_limit(code: &str, previous_close: f64, open: f64, buy: bool) -> bool {
    let limit = find(code).map_or(0.10, |entry| entry.price_limit);
    let boundary =
        (previous_close * (1.0 + if buy { limit } else { -limit }) * 1000.0).round() / 1000.0;
    if buy {
        open >= boundary - 1e-9
    } else {
        open <= boundary + 1e-9
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn innovation_uses_twenty_percent_and_tick_rounding() {
        assert!(!at_price_limit("588300.SH", 1.003, 1.15, true));
        assert!(at_price_limit("512480.SH", 1.003, 1.15, true));
        assert!(at_price_limit("588000.SH", 1.003, 1.204, true));
        assert!(!at_price_limit("588000.SH", 1.003, 1.203, true));
        assert!(at_price_limit("588300.SH", 1.003, 0.802, false));
        assert!(!at_price_limit("588300.SH", 1.003, 0.803, false));
    }
}
