use super::{archive, platform as p, references, types::*};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

pub struct Inventory {
    pub files: BTreeMap<String, Kind>,
    pub directories: Vec<String>,
    pub warnings: Vec<String>,
}

fn walk(root: &Path, rel: &str, out: &mut Inventory) -> TransferResult<()> {
    let dir = p::safe(root, rel)?;
    if !dir.exists() {
        return Ok(());
    }
    if out.files.len() + out.directories.len() >= MAX_ENTRIES {
        return Err("资料条目超过 10 万".into());
    }
    out.directories.push(rel.to_string());
    for entry in fs::read_dir(&dir).map_err(|e| format!("无法扫描 {rel}：{e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| format!("{rel} 中存在非 UTF-8 文件名"))?;
        let path = format!("{rel}/{name}");
        if name.starts_with('.') {
            continue;
        }
        let meta = entry.file_type().map_err(|e| e.to_string())?;
        if meta.is_symlink() {
            return Err(format!(
                "资料目录包含链接，请先替换为实际文件或目录：{path}"
            ));
        }
        if meta.is_dir() {
            if rel == "memory" && name != "archive" {
                continue;
            }
            if rel.starts_with("knowledge")
                && (name.starts_with('_') && path != "knowledge/_types" || name == "attachments")
            {
                continue;
            }
            if rel == "knowledge/_types" {
                continue;
            }
            walk(root, &path, out)?;
        } else if name.ends_with(".md") {
            if rel.starts_with("knowledge")
                && ["INDEX.md", "README.md", "AGENTS.md"]
                    .iter()
                    .any(|n| p::key(n) == p::key(&name))
            {
                out.warnings.push(format!("保留文件未导出：{path}"));
                continue;
            }
            p::safe(root, &path)?;
            let kind = archive::kind(&path)?;
            out.files.insert(path, kind);
        }
    }
    Ok(())
}

pub fn inventory(root: &Path, scopes: &Scopes) -> TransferResult<Inventory> {
    let mut out = Inventory {
        files: BTreeMap::new(),
        directories: vec![],
        warnings: vec![],
    };
    if !scopes.memory && !scopes.notes {
        return Err("请至少选择记忆或笔记".into());
    }
    if scopes.memory {
        walk(root, "memory", &mut out)?;
    }
    if scopes.notes {
        walk(root, "knowledge", &mut out)?;
    }
    out.directories.sort();
    Ok(out)
}

pub fn text(bytes: Vec<u8>, path: &str) -> TransferResult<String> {
    if bytes.len() > MAX_MANIFEST as usize {
        return Err(format!("Markdown 超过 16 MiB：{path}"));
    }
    String::from_utf8(bytes).map_err(|_| format!("Markdown 不是 UTF-8：{path}"))
}

pub fn validate_memory(text: &str, kind: &Kind, path: &str) -> TransferResult<()> {
    if matches!(kind, Kind::Memory | Kind::Archive) {
        let mut lines = text.lines();
        if lines.next() != Some("---") {
            return Err(format!("记忆缺少 frontmatter：{path}"));
        }
        let mut title = false;
        let mut closed = false;
        for line in lines {
            if line == "---" {
                closed = true;
                break;
            }
            if let Some(v) = line.strip_prefix("title:") {
                title = !v.trim().trim_matches(['\'', '"']).is_empty();
            }
        }
        if !closed || !title {
            return Err(format!("记忆缺少有效标题或 frontmatter 结束标记：{path}"));
        }
    }
    Ok(())
}

pub fn create(
    root: &Path,
    stage: &Path,
    scopes: Scopes,
    progress: &impl Fn(Progress),
) -> TransferResult<Manifest> {
    let initial = inventory(root, &scopes)?;
    let selected: BTreeSet<_> = initial.files.keys().cloned().collect();
    let mut observed = BTreeMap::<String, String>::new();
    let mut assets_by_hash = BTreeMap::<String, String>::new();
    let mut entries = BTreeMap::<String, Entry>::new();
    let mut total = 0u64;
    let mut write = |path: String, bytes: Vec<u8>, kind: Kind| -> TransferResult<()> {
        if entries.contains_key(&path) {
            return Ok(());
        }
        total = total
            .checked_add(bytes.len() as u64)
            .ok_or("资料体积溢出")?;
        if total > MAX_TOTAL || entries.len() >= MAX_ENTRIES {
            return Err("资料超过 5 GiB 或 10 万条目".into());
        }
        p::require_space(stage, bytes.len() as u64)?;
        p::write_new(&p::safe(&stage.join("data"), &path)?, &bytes)?;
        entries.insert(
            path.clone(),
            Entry {
                path,
                kind,
                bytes: bytes.len() as u64,
                sha256: p::hash(&bytes),
            },
        );
        Ok(())
    };
    for (i, (rel, kind)) in initial.files.iter().enumerate() {
        let bytes = p::read(&p::safe(root, rel)?, MAX_MANIFEST)?;
        observed.insert(rel.clone(), p::hash(&bytes));
        let original = text(bytes, rel)?;
        validate_memory(&original, kind, rel)?;
        let rewritten = references::portable(
            root,
            rel,
            &original,
            &selected,
            &mut |path, bytes, original_path| {
                let hash = p::hash(&bytes);
                if observed.get(&original_path).is_some_and(|old| *old != hash) {
                    return Err(format!("收集期间附件发生变化：{original_path}"));
                }
                observed.insert(original_path, hash);
                let hash = p::hash(&bytes);
                if let Some(existing) = assets_by_hash.get(&hash) {
                    return Ok(existing.clone());
                }
                assets_by_hash.insert(hash, path.clone());
                write(path.clone(), bytes, Kind::Attachment)?;
                Ok(path)
            },
        )?;
        write(rel.clone(), rewritten.into_bytes(), kind.clone())?;
        progress(Progress {
            phase: "收集笔记与附件".into(),
            completed: i + 1,
            total: initial.files.len(),
        });
    }
    // Detect external edits, including additions and removals, during the snapshot.
    let after = inventory(root, &scopes)?;
    if initial.files != after.files || initial.directories != after.directories {
        return Err("扫描期间目录发生变化，请暂停外部编辑后重试".into());
    }
    for (rel, hash) in observed {
        if p::file_hash(&p::safe(root, &rel)?)?.as_deref() != Some(&hash) {
            return Err(format!("扫描期间文件发生变化，请重试：{rel}"));
        }
    }
    let manifest = Manifest {
        format: "kalo-personal-data".into(),
        format_version: 1,
        export_id: uuid::Uuid::new_v4().to_string(),
        exported_at_ms: now_ms(),
        app_version: env!("CARGO_PKG_VERSION").into(),
        scopes,
        directories: initial.directories,
        entries: entries.into_values().collect(),
        warnings: initial.warnings,
    };
    archive::save_manifest(stage, &manifest)?;
    Ok(manifest)
}
