use super::{archive, platform as p, references, snapshot, transaction, types::*};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

pub fn revision(items: &[PlanItem], manifest: &Manifest) -> TransferResult<String> {
    Ok(p::hash(
        &serde_json::to_vec(&(items, manifest)).map_err(|e| e.to_string())?,
    ))
}

pub fn writes(item: &PlanItem) -> bool {
    item.status != "same" && item.choice != Choice::KeepLocal
}

pub fn bytes(
    stage: &Path,
    item: &PlanItem,
    mapping: &BTreeMap<String, String>,
) -> TransferResult<Vec<u8>> {
    let bytes = p::read(&p::safe(&stage.join("data"), &item.source)?, MAX_FILE)?;
    if item.kind == Kind::Attachment {
        return Ok(bytes);
    }
    let text = snapshot::text(bytes, &item.source)?;
    snapshot::validate_memory(&text, &item.kind, &item.source)?;
    Ok(references::remap(&item.source, &item.target, &text, mapping)?.into_bytes())
}

pub fn mapping(items: &[PlanItem]) -> BTreeMap<String, String> {
    items
        .iter()
        .map(|i| (i.source.clone(), i.target.clone()))
        .collect()
}

pub fn build(
    root: &Path,
    stage: &Path,
    id: &str,
    decisions: &[Decision],
) -> TransferResult<Preview> {
    let m = archive::load_manifest(stage)?;
    archive::verify(stage, &m)?;
    let mut choices = BTreeMap::new();
    for d in decisions {
        if choices.insert(d.path.clone(), d.choice.clone()).is_some()
            || !m.entries.iter().any(|e| e.path == d.path)
        {
            return Err("重复或未知冲突决定".into());
        }
    }
    let local = snapshot::inventory(
        root,
        &Scopes {
            memory: true,
            notes: true,
        },
    )?;
    let selected: BTreeSet<String> = local.files.keys().cloned().collect();
    let history = transaction::history(root)?;
    let mut items = Vec::new();
    let mut allocated: BTreeSet<_> = m.entries.iter().map(|e| p::key(&e.path)).collect();
    for entry in &m.entries {
        let original = p::target(root, &entry.path)?;
        let local_hash = p::file_hash(&original)?;
        let mut item = PlanItem {
            source: entry.path.clone(),
            target: entry.path.clone(),
            kind: entry.kind.clone(),
            status: "new".into(),
            choice: Choice::Replace,
            incoming_hash: entry.sha256.clone(),
            local_hash: local_hash.clone(),
            before_hash: local_hash.clone(),
            after_hash: entry.sha256.clone(),
        };
        // A receipt is a hint; never trust it without checking the current destination bytes.
        let receipt = history
            .iter()
            .filter(|j| j.state == "committed")
            .rev()
            .flat_map(|j| &j.items)
            .find(|i| {
                i.source == entry.path
                    && i.incoming_hash == entry.sha256
                    && writes(i)
                    && p::safe(root, &i.target)
                        .ok()
                        .and_then(|path| p::file_hash(&path).ok())
                        .flatten()
                        .as_deref()
                        == Some(&i.after_hash)
            });
        if let Some(receipt) = receipt {
            item.target = receipt.target.clone();
            item.status = "same".into();
            item.before_hash = Some(receipt.after_hash.clone());
            item.after_hash = receipt.after_hash.clone();
            items.push(item);
            continue;
        }
        let same = if let Some(hash) = &local_hash {
            if *hash == entry.sha256 {
                true
            } else if entry.kind != Kind::Attachment {
                let text = snapshot::text(p::read(&original, MAX_MANIFEST)?, &entry.path)?;
                references::portable(root, &entry.path, &text, &selected, &mut |path, _, _| {
                    Ok(path)
                })
                .map(|s| p::hash(s.as_bytes()) == entry.sha256)
                .unwrap_or(false)
            } else {
                false
            }
        } else {
            false
        };
        if same {
            item.status = "same".into();
            item.after_hash = local_hash.unwrap_or(entry.sha256.clone());
        } else if local_hash.is_some() {
            if entry.kind == Kind::Attachment {
                return Err(format!("本机内容寻址附件损坏，请先处理：{}", entry.path));
            }
            item.status = "conflict".into();
            item.choice = choices
                .get(&entry.path)
                .cloned()
                .unwrap_or(match entry.kind {
                    Kind::Memory => Choice::Stage,
                    Kind::Domain => Choice::KeepLocal,
                    _ => Choice::KeepBoth,
                });
            if item.choice == Choice::Stage && entry.kind != Kind::Memory
                || item.choice == Choice::KeepBoth
                    && matches!(entry.kind, Kind::Memory | Kind::Domain)
            {
                return Err(format!("不适用的冲突处理方式：{}", entry.path));
            }
            if item.choice == Choice::KeepLocal {
                item.after_hash = item.before_hash.clone().unwrap_or_default();
            } else if item.choice == Choice::Stage {
                item.target = format!("transfers/conflicts/{id}/{}", entry.path);
                item.before_hash = p::file_hash(&p::target(root, &item.target)?)?;
                if item.before_hash.is_some() {
                    return Err("冲突暂存目标已存在，请重新准备导入".into());
                }
            } else if item.choice == Choice::KeepBoth {
                let stem = entry.path.trim_end_matches(".md");
                for n in 0..10000 {
                    let suffix = if n == 0 {
                        String::new()
                    } else {
                        format!("-{n}")
                    };
                    let candidate = format!("{stem}-import-{}{suffix}.md", &entry.sha256[..16]);
                    if !allocated.contains(&p::key(&candidate))
                        && !p::target(root, &candidate)?.exists()
                    {
                        item.target = candidate;
                        item.before_hash = None;
                        break;
                    }
                }
                if item.before_hash.is_some() {
                    return Err("无法分配不重复的笔记名称".into());
                }
            }
        }
        allocated.insert(p::key(&item.target));
        items.push(item);
    }
    let map = mapping(&items);
    // Validate every imported reference, including files the user chooses to skip.
    for item in &mut items {
        let output = bytes(stage, item, &map)?;
        if writes(item) {
            item.after_hash = p::hash(&output);
        }
    }
    for dir in &m.directories {
        p::target(root, dir)?;
    }
    let rev = revision(&items, &m)?;
    Ok(Preview {
        operation_id: id.into(),
        mode: "import".into(),
        manifest: m,
        items,
        revision: rev,
    })
}

pub fn save(stage: &Path, preview: &Preview) -> TransferResult<()> {
    p::atomic_write(
        &stage.join("preview.json"),
        &serde_json::to_vec(preview).map_err(|e| e.to_string())?,
    )
}

pub fn load(stage: &Path) -> TransferResult<Preview> {
    serde_json::from_slice(&p::read(&stage.join("preview.json"), MAX_MANIFEST * 4)?)
        .map_err(|e| e.to_string())
}

pub fn details(root: &Path, stage: &Path, path: &str) -> TransferResult<serde_json::Value> {
    let preview = load(stage)?;
    let item = preview
        .items
        .iter()
        .find(|i| i.source == path)
        .ok_or("预览中没有此条目")?;
    if item.kind == Kind::Attachment {
        return Err("附件不提供文本比较".into());
    }
    let incoming = snapshot::text(
        p::read(&p::safe(&stage.join("data"), path)?, MAX_MANIFEST)?,
        path,
    )?;
    let local_path = p::safe(root, path)?;
    let local = if local_path.exists() {
        snapshot::text(p::read(&local_path, MAX_MANIFEST)?, path)?
    } else {
        String::new()
    };
    Ok(serde_json::json!({ "local": local, "incoming": incoming }))
}

pub fn clean_stage(root: &Path, id: &str) -> TransferResult<()> {
    uuid::Uuid::parse_str(id).map_err(|_| "无效操作编号")?;
    let stage = p::safe(root, &format!("transfers/staging/{id}"))?;
    if stage.exists() {
        // Only remove this app-generated staging tree; links are checked recursively.
        fn check(path: &Path) -> TransferResult<()> {
            p::no_link(path)?;
            if path.is_dir() {
                for e in fs::read_dir(path).map_err(|e| e.to_string())? {
                    check(&e.map_err(|e| e.to_string())?.path())?;
                }
            }
            Ok(())
        }
        check(&stage)?;
        fs::remove_dir_all(stage).map_err(|e| e.to_string())?;
    }
    Ok(())
}
