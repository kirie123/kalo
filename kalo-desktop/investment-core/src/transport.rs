//! Bounded, read-only data requests. Never fall back to unverified TLS or sample data.
use reqwest::blocking::Client;
use serde_json::Value;
use std::{io::Read, time::Duration};

fn retryable(status: Option<u16>, transient: bool, certificate: bool) -> bool {
    !certificate && (transient || matches!(status, Some(408 | 429 | 500..=599)))
}

fn certificate_error(error: &reqwest::Error) -> bool {
    use std::error::Error;
    let mut source = error.source();
    while let Some(cause) = source {
        let message = cause.to_string().to_ascii_lowercase();
        if message.contains("certificate") || message.contains("certvalid") {
            return true;
        }
        source = cause.source();
    }
    false
}

pub fn fetch(
    client: &Client,
    url: &str,
    params: &[(&str, String)],
    referer: &str,
) -> Result<Value, String> {
    let provider = if url.contains("gtimg.cn") {
        "腾讯行情"
    } else if url.contains("sse.com.cn") {
        "上交所数据"
    } else if url.contains("szse.cn") {
        "深交所数据"
    } else {
        "东方财富净值"
    };
    for attempt in 1..=3 {
        let response = client
            .get(url)
            .query(params)
            .header("Referer", referer)
            .send()
            .and_then(|r| r.error_for_status());
        let mut response = match response {
            Ok(response) => response,
            Err(error) => {
                let certificate = certificate_error(&error);
                let status = error.status().map(|s| s.as_u16());
                let transient = error.is_connect() || error.is_timeout() || error.is_body();
                if attempt < 3 && retryable(status, transient, certificate) {
                    eprintln!("{provider}连接暂时失败，正在重试（{}/3）", attempt + 1);
                    std::thread::sleep(Duration::from_millis(500 * attempt));
                    continue;
                }
                let reason = if certificate {
                    "HTTPS 证书验证失败，请检查系统时间及受信任证书".into()
                } else if error.is_timeout() {
                    "请求超时，请检查网络后重试".into()
                } else if let Some(status) = status {
                    format!("服务返回 HTTP {status}，请稍后重试")
                } else {
                    "连接未建立，请检查网络、代理或防火墙后重试".into()
                };
                return Err(format!(
                    "{provider}同步失败（已尝试 {attempt} 次）：{reason}。已有数据保留。"
                ));
            }
        };
        let mut bytes = Vec::new();
        if response
            .by_ref()
            .take(8_000_001)
            .read_to_end(&mut bytes)
            .is_err()
        {
            if attempt < 3 {
                eprintln!("{provider}响应中断，正在重试（{}/3）", attempt + 1);
                std::thread::sleep(Duration::from_millis(500 * attempt));
                continue;
            }
            return Err(format!(
                "{provider}响应传输中断（已尝试 {attempt} 次），请检查网络后重试。"
            ));
        }
        if bytes.len() > 8_000_000 {
            return Err(format!("{provider}返回超过 8MB 限制"));
        }
        // Tencent's minute endpoint can return GBK despite a JSON content type.
        let decoded;
        let body = if std::str::from_utf8(&bytes).is_err() && url.contains("gtimg.cn") {
            let (text, _, malformed) = encoding_rs::GBK.decode(&bytes);
            if malformed {
                return Err("腾讯行情字符编码损坏".into());
            }
            decoded = text.into_owned();
            decoded.as_bytes()
        } else {
            &bytes
        };
        return serde_json::from_slice(body)
            .map_err(|_| format!("{provider}返回格式异常，请稍后重试；没有生成替代数据。"));
    }
    unreachable!("each final attempt returns")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retries_only_transient_failures_and_never_certificate_errors() {
        for status in [408, 429, 500, 502, 503, 504] {
            assert!(retryable(Some(status), false, false));
        }
        for status in [200, 400, 401, 403, 404] {
            assert!(!retryable(Some(status), false, false));
        }
        assert!(retryable(None, true, false));
        assert!(!retryable(None, false, false));
        assert!(!retryable(None, true, true));
        assert!(!retryable(Some(503), true, true));
    }
}
