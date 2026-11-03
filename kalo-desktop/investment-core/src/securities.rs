//! Normalize identifiers and freeze verified security metadata; no symbol allowlist.
use crate::market_model::Security;

pub fn code(input: &str) -> Result<String, String> {
    let input = input.trim().to_ascii_uppercase();
    let (digits, exchange) = input.split_once('.').unwrap_or((&input, ""));
    if digits.len() != 6 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err("请输入六位证券代码，例如 600519、159915.SZ 或 688981.SH".into());
    }
    let inferred = if digits.starts_with(['4', '8', '9']) {
        "BJ"
    } else if digits.starts_with(['5', '6']) {
        "SH"
    } else {
        "SZ"
    };
    if !exchange.is_empty() && exchange != inferred {
        return Err("代码与交易所后缀不匹配，仅支持沪深北 A 股与 ETF".into());
    }
    Ok(format!("{digits}.{inferred}"))
}

pub fn minimum(sec: &Security) -> u64 {
    if sec.code.starts_with("688") {
        200
    } else {
        100
    }
}
pub fn step(sec: &Security) -> u64 {
    if sec.code.starts_with("688") || sec.exchange == "BSE" {
        1
    } else {
        100
    }
}
pub fn verify(sec: &Security) -> Result<(), String> {
    if code(&sec.code)? != sec.code
        || sec.name.is_empty()
        || sec.currency != "CNY"
        || !["stock", "etf"].contains(&sec.asset_type.as_str())
        || sec.tick_size != if sec.asset_type == "etf" { 0.001 } else { 0.01 }
        || sec.settlement_days > 1
        || (sec.asset_type == "stock" && sec.settlement_days != 1)
        || sec.lot_size != step(sec)
        || ![0.05, 0.1, 0.2, 0.3].contains(&sec.price_limit)
        || sec.exchange
            != match &sec.code[7..] {
                "SH" => "SSE",
                "SZ" => "SZSE",
                _ => "BSE",
            }
    {
        return Err("冻结证券的类别、交易所或交易规则无效".into());
    }
    Ok(())
}

pub fn from_quote(code: &str, quote: &str, settlement: Option<u8>) -> Result<Security, String> {
    let code = self::code(code)?;
    let symbol = format!("{}{}", code[7..].to_ascii_lowercase(), &code[..6]);
    let body = quote
        .trim()
        .strip_prefix(&format!("v_{symbol}=\""))
        .and_then(|s| s.strip_suffix("\";"))
        .ok_or("未找到证券，请核对代码或稍后重试")?;
    let fields: Vec<_> = body.split('~').collect();
    if fields.len() < 62 || fields[2] != &code[..6] {
        return Err("证券报价身份不匹配".into());
    }
    let etf = fields[61] == "ETF";
    let stock = (code.starts_with("60")
        || code.starts_with("688")
        || code.starts_with("00")
        || code.starts_with("30")
        || code.ends_with(".BJ"))
        && fields[61].starts_with("GP");
    if !etf && !stock {
        return Err("仅支持 A 股和 ETF，不支持指数、B 股、债券或其他基金".into());
    }
    let n = |i: usize| {
        fields[i]
            .parse::<f64>()
            .ok()
            .filter(|n| n.is_finite() && *n > 0.0)
            .ok_or("证券当前价格边界缺失，无法核实交易规则")
    };
    let previous = n(4)?;
    let upper = n(47)?;
    let lower = n(48)?;
    let tick = if etf { 0.001 } else { 0.01 };
    let limit = [0.05, 0.1, 0.2, 0.3]
        .into_iter()
        .find(|l| {
            (upper - (previous * (1.0 + l) / tick).round() * tick).abs() < tick * 1.1
                && (lower - (previous * (1.0 - l) / tick).round() * tick).abs() < tick * 1.1
        })
        .ok_or("当前为无涨跌幅限制或特殊交易状态，暂不能验证撮合规则")?;
    let mut sec = Security {
        code: code.clone(),
        name: fields[1].into(),
        exchange: match &code[7..] {
            "SH" => "SSE",
            "SZ" => "SZSE",
            _ => "BSE",
        }
        .into(),
        asset_type: if etf { "etf" } else { "stock" }.into(),
        currency: "CNY".into(),
        tick_size: tick,
        lot_size: 100,
        settlement_days: settlement.unwrap_or(1),
        price_limit: limit,
    };
    sec.lot_size = step(&sec);
    verify(&sec)?;
    Ok(sec)
}

pub fn minutes(timeframe: &str) -> Result<u32, String> {
    match timeframe {
        "5m" => Ok(5),
        "15m" => Ok(15),
        "30m" => Ok(30),
        "60m" => Ok(60),
        _ => Err("周期支持 5m、15m、30m、60m".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identifiers_and_security_types_are_checked() {
        assert_eq!(code(" 159915 ").unwrap(), "159915.SZ");
        assert_eq!(code("688981.sh").unwrap(), "688981.SH");
        assert_eq!(code("920002").unwrap(), "920002.BJ");
        assert!(code("600519.SZ").is_err());
        assert!(code("12345&").is_err());
        let mut f = vec![""; 62];
        f[1] = "测试ETF";
        f[2] = "510300";
        f[4] = "4";
        f[47] = "4.4";
        f[48] = "3.6";
        f[61] = "ETF";
        let q = format!("v_sh510300=\"{}\";", f.join("~"));
        let s = from_quote("510300", &q, Some(0)).unwrap();
        assert_eq!(s.tick_size, 0.001);
        assert_eq!(s.settlement_days, 0);
        f[61] = "INDEX";
        assert!(from_quote("510300", &format!("v_sh510300=\"{}\";", f.join("~")), None).is_err());
    }
}
