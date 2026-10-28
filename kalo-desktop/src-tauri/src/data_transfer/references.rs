//! Rewrite only Markdown destinations; prose, metadata and fenced examples retain their bytes.
use super::{
    platform,
    types::{TransferResult, MAX_FILE},
};
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, CONTROLS};
use pulldown_cmark::{Event, LinkType, Options, Parser, Tag};
use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;
use std::path::Path;

const URL_PATH: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'%')
    .add(b'#')
    .add(b'?')
    .add(b'<')
    .add(b'>')
    .add(b'(')
    .add(b')')
    .add(b'"')
    .add(b'\\');

fn body_offset(text: &str) -> usize {
    if !text.starts_with("---\n") && !text.starts_with("---\r\n") {
        return 0;
    }
    let mut offset = text.find('\n').unwrap_or(0) + 1;
    for line in text[offset..].split_inclusive('\n') {
        offset += line.len();
        if line.trim_end() == "---" {
            return offset;
        }
    }
    0
}

fn destination(text: &str, mut start: usize) -> Option<Range<usize>> {
    let b = text.as_bytes();
    while b.get(start).is_some_and(u8::is_ascii_whitespace) {
        start += 1;
    }
    let angle = b.get(start) == Some(&b'<');
    if angle {
        start += 1;
    }
    let mut i = start;
    let mut depth = 0;
    while let Some(&c) = b.get(i) {
        if c == b'\\' {
            i += 2;
            continue;
        }
        if angle && c == b'>' {
            return Some(start..i);
        }
        if !angle {
            if c.is_ascii_whitespace() || (c == b')' && depth == 0) {
                return Some(start..i);
            }
            if c == b'(' {
                depth += 1;
            }
            if c == b')' {
                depth -= 1;
            }
        }
        i += 1;
    }
    if angle {
        None
    } else {
        Some(start..i)
    }
}

fn parsed_url(raw: &str) -> Option<String> {
    let sample = format!("[x](<{raw}>)");
    Parser::new(&sample).find_map(|e| match e {
        Event::Start(Tag::Link { dest_url, .. }) => Some(dest_url.to_string()),
        _ => None,
    })
}

fn locate(
    text: &str,
    span: Range<usize>,
    separator: &str,
    url: &str,
) -> TransferResult<Range<usize>> {
    let source = text.get(span.clone()).ok_or("链接位置无效")?;
    for (at, _) in source.match_indices(separator) {
        if let Some(r) = destination(source, at + separator.len()) {
            if parsed_url(&source[r.clone()]).as_deref() == Some(url)
                && valid_tail(source, &r, separator == "](")
            {
                return Ok(span.start + r.start..span.start + r.end);
            }
        }
    }
    Err(format!(
        "无法安全定位 Markdown 链接，请改为普通内联链接：{url}"
    ))
}

fn valid_tail(source: &str, range: &Range<usize>, inline: bool) -> bool {
    let bytes = source.as_bytes();
    let mut i = range.end;
    if range.start > 0 && bytes[range.start - 1] == b'<' {
        i += 1;
    }
    while bytes.get(i).is_some_and(u8::is_ascii_whitespace) {
        i += 1;
    }
    if let Some(&opener) = bytes.get(i).filter(|c| [b'"', b'\'', b'('].contains(c)) {
        let closer = if opener == b'(' { b')' } else { opener };
        i += 1;
        loop {
            match bytes.get(i) {
                Some(b'\\') => i += 2,
                Some(c) if *c == closer => {
                    i += 1;
                    break;
                }
                Some(_) => i += 1,
                None => return false,
            }
        }
        while bytes.get(i).is_some_and(u8::is_ascii_whitespace) {
            i += 1;
        }
    }
    if inline {
        bytes.get(i) == Some(&b')') && i + 1 == bytes.len()
    } else {
        i == bytes.len()
    }
}

pub fn rewrite(
    text: &str,
    mut map: impl FnMut(&str) -> TransferResult<String>,
) -> TransferResult<String> {
    let offset = body_offset(text);
    let body = &text[offset..];
    let parser = Parser::new_ext(body, Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH);
    let definitions: BTreeMap<String, (String, Range<usize>)> = parser
        .reference_definitions()
        .iter()
        .map(|(label, def)| {
            (
                label.to_lowercase(),
                (def.dest.to_string(), def.span.clone()),
            )
        })
        .collect();
    let mut edits = BTreeMap::<usize, (Range<usize>, String)>::new();
    for (event, span) in parser.into_offset_iter() {
        match event {
            Event::Start(Tag::Link {
                link_type,
                dest_url,
                id,
                ..
            })
            | Event::Start(Tag::Image {
                link_type,
                dest_url,
                id,
                ..
            }) => {
                let next = map(&dest_url)?;
                if next == dest_url.as_ref() {
                    continue;
                }
                let range = match link_type {
                    LinkType::Inline => locate(body, span, "](", &dest_url)?,
                    LinkType::Reference | LinkType::Collapsed | LinkType::Shortcut => {
                        let (url, span) = definitions
                            .get(&id.to_lowercase())
                            .ok_or("找不到引用式链接定义")?;
                        locate(body, span.clone(), "]:", url)?
                    }
                    _ => return Err("无法改写自动链接，请改为普通 Markdown 链接".into()),
                };
                edits.insert(
                    range.start + offset,
                    (range.start + offset..range.end + offset, next),
                );
            }
            Event::Html(html) | Event::InlineHtml(html) => {
                let lower = html.to_lowercase();
                if lower.contains("src") || lower.contains("href") {
                    return Err("包含 HTML 文件引用，请先改为 Markdown 图片或链接".into());
                }
            }
            _ => {}
        }
    }
    let mut result = text.to_string();
    let mut last = result.len();
    for (_, (range, value)) in edits.into_iter().rev() {
        if range.end > last {
            return Err("链接位置重叠，无法安全改写".into());
        }
        last = range.start;
        result.replace_range(range, &value);
    }
    Ok(result)
}

pub fn local_url(url: &str) -> TransferResult<Option<(String, String)>> {
    let lower = url.to_lowercase();
    if url.is_empty()
        || url.starts_with('#')
        || ["https://", "http://", "mailto:", "data:"]
            .iter()
            .any(|s| lower.starts_with(s))
    {
        return Ok(None);
    }
    let (path, fragment) = url
        .split_once('#')
        .map(|(p, f)| (p, format!("#{f}")))
        .unwrap_or((url, String::new()));
    let decoded = percent_decode_str(path)
        .decode_utf8()
        .map_err(|_| "链接不是有效 UTF-8")?
        .into_owned();
    if decoded.contains(':')
        && !(decoded.as_bytes().get(1) == Some(&b':')
            && decoded
                .as_bytes()
                .get(2)
                .is_some_and(|c| *c == b'/' || *c == b'\\'))
    {
        return Err(format!("不支持此本地引用协议：{url}"));
    }
    Ok(Some((decoded, fragment)))
}

pub fn relative(from: &str, to: &str) -> String {
    let mut a: Vec<_> = from.split('/').collect();
    a.pop();
    let b: Vec<_> = to.split('/').collect();
    let common = a.iter().zip(&b).take_while(|(a, b)| a == b).count();
    let path = std::iter::repeat("..")
        .take(a.len() - common)
        .chain(b[common..].iter().copied())
        .collect::<Vec<_>>()
        .join("/");
    utf8_percent_encode(&path, URL_PATH).to_string()
}

/// Create a portable view and collect only referenced, allowed attachments.
pub fn portable(
    root: &Path,
    document: &str,
    text: &str,
    selected: &BTreeSet<String>,
    assets: &mut impl FnMut(String, Vec<u8>, String) -> TransferResult<String>,
) -> TransferResult<String> {
    rewrite(text, |url| {
        let Some((path, fragment)) = local_url(url)? else {
            return Ok(url.to_string());
        };
        let resolved =
            platform::resolve(root, document, &path).map_err(|e| format!("{document}：{e}"))?;
        let rel = resolved
            .strip_prefix(root)
            .map_err(|_| "引用越界")?
            .to_string_lossy()
            .replace('\\', "/");
        if selected.contains(&rel) {
            return Ok(format!("{}{fragment}", relative(document, &rel)));
        }
        if !rel.starts_with("attachments/")
            && !(rel.starts_with("knowledge/") && !rel.ends_with(".md"))
        {
            return Err(format!("{document} 引用未选中的内容或非附件文件：{rel}"));
        }
        let bytes = platform::read(&resolved, MAX_FILE)
            .map_err(|e| format!("{document} 的附件无法迁移：{e}"))?;
        let ext = resolved
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("bin")
            .to_ascii_lowercase();
        let ext =
            if !ext.is_empty() && ext.len() <= 12 && ext.chars().all(|c| c.is_ascii_alphanumeric())
            {
                ext
            } else {
                "bin".into()
            };
        let target = format!("attachments/portable/{}.{ext}", platform::hash(&bytes));
        let target = assets(target, bytes, rel)?;
        Ok(format!("{}{fragment}", relative(document, &target)))
    })
}

pub fn package_target(document: &str, path: &str) -> TransferResult<String> {
    if path.starts_with(['/', '\\']) || path.contains(':') || path.contains('\\') {
        return Err("资料包内不允许绝对路径或特殊路径引用".into());
    }
    let mut parts: Vec<&str> = document.split('/').collect();
    parts.pop();
    for p in path.split('/') {
        match p {
            "." | "" => {}
            ".." => {
                parts.pop().ok_or("资料包引用越界")?;
            }
            _ => parts.push(p),
        }
    }
    let target = parts.join("/");
    platform::validate(&target)?;
    Ok(target)
}

pub fn remap(
    document: &str,
    target: &str,
    text: &str,
    mapping: &BTreeMap<String, String>,
) -> TransferResult<String> {
    rewrite(text, |url| {
        let Some((path, fragment)) = local_url(url)? else {
            return Ok(url.to_string());
        };
        let original = package_target(document, &path)?;
        let mapped = mapping
            .get(&original)
            .ok_or_else(|| format!("资料包缺少引用目标：{document} → {original}"))?;
        Ok(format!("{}{fragment}", relative(target, mapped)))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn changes_destinations_without_touching_examples_or_frontmatter() {
        let src = "---\nsource: a.png\n---\n[a.png](a.png \"title\") ![x](<a.png>)\n`[x](a.png)`\n```md\n![x](a.png)\n```\n![ref][a]\n\n[a]: a.png \"image\"\n";
        let out = rewrite(src, |s| {
            Ok(if s == "a.png" { "../new.png" } else { s }.into())
        })
        .unwrap();
        assert!(out.contains("[a.png](../new.png \"title\")"));
        assert!(out.contains("[a]: ../new.png \"image\""));
        assert!(out.contains("source: a.png"));
        assert!(out.contains("```md\n![x](a.png)\n```"));
    }
    #[test]
    fn encodes_fragments_and_preserves_relative_depth() {
        assert_eq!(
            relative("knowledge/a/b.md", "attachments/portable/a #b.png"),
            "../../attachments/portable/a%20%23b.png"
        );
        assert_eq!(
            local_url("../a%23b.png#part").unwrap(),
            Some(("../a#b.png".into(), "#part".into()))
        );
        assert!(package_target("memory/a.md", "../../secret").is_err());
    }
    #[test]
    fn link_like_text_in_titles_and_nested_labels_is_not_rewritten() {
        let source = "[![x](old.png)](old.png \"caption ](old.png)\")";
        let out = rewrite(source, |_| Ok("new.png".into())).unwrap();
        assert_eq!(out, "[![x](new.png)](new.png \"caption ](old.png)\")");
    }
}
