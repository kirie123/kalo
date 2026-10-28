//! Durable multi-file transactions. The journal is persisted before the first live write.
use super::{archive, plan, platform as p, types::*};
use std::fs;
use std::path::{Path, PathBuf};

fn location(root: &Path, id: &str) -> TransferResult<PathBuf> {
    uuid::Uuid::parse_str(id).map_err(|_| "事务编号无效")?;
    p::safe(root, &format!("transfers/history/{id}"))
}

fn valid(j: &Journal) -> TransferResult<()> {
    uuid::Uuid::parse_str(&j.id).map_err(|_| "事务编号无效")?;
    if ![
        "prepared",
        "applying",
        "committed",
        "undoing",
        "undone",
        "rolledBack",
    ]
    .contains(&j.state.as_str())
    {
        return Err("事务状态无效".into());
    }
    if j.items.len() > MAX_ENTRIES || j.directories.len() > MAX_ENTRIES {
        return Err("事务条目过多".into());
    }
    for item in &j.items {
        archive::kind(&item.source)?;
        p::validate(&item.target)?;
        let conflict = format!("transfers/conflicts/{}/memory/", j.id);
        if item.target.starts_with(&conflict) {
            if item.kind != Kind::Memory || item.target[conflict.len()..].contains('/') {
                return Err("冲突暂存路径无效".into());
            }
        } else if archive::kind(&item.target)? != item.kind {
            return Err("事务目标类型不符".into());
        }
    }
    for dir in &j.directories {
        p::validate(dir)?;
        if !["memory", "knowledge", "attachments"]
            .iter()
            .any(|p| dir == p || dir.starts_with(&format!("{p}/")))
        {
            return Err("事务目录超出范围".into());
        }
    }
    Ok(())
}

fn save(root: &Path, j: &Journal) -> TransferResult<()> {
    valid(j)?;
    p::atomic_write(
        &location(root, &j.id)?.join("journal.json"),
        &serde_json::to_vec(j).map_err(|e| e.to_string())?,
    )
}

pub fn history(root: &Path) -> TransferResult<Vec<Journal>> {
    let dir = p::safe(root, "transfers/history")?;
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut list = vec![];
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        p::no_link(&path)?;
        let journal = path.join("journal.json");
        if !journal.exists() {
            continue;
        } // Crash while preparing backups: no live writes yet.
        let j: Journal = serde_json::from_slice(&p::read(&journal, MAX_MANIFEST * 4)?)
            .map_err(|e| format!("迁移日志损坏：{e}"))?;
        valid(&j)?;
        if path.file_name().and_then(|p| p.to_str()) != Some(&j.id) {
            return Err("迁移日志目录与编号不一致".into());
        }
        list.push(j);
    }
    list.sort_by_key(|j| j.created_at_ms);
    Ok(list)
}

pub fn pending(root: &Path) -> TransferResult<bool> {
    Ok(history(root)?
        .iter()
        .any(|j| ["prepared", "applying", "undoing"].contains(&j.state.as_str())))
}

fn verify_restore(root: &Path, j: &Journal) -> TransferResult<()> {
    for (i, item) in j.items.iter().enumerate().filter(|(_, i)| plan::writes(i)) {
        let current = p::file_hash(&p::target(root, &item.target)?)?;
        if current != item.before_hash && current.as_deref() != Some(&item.after_hash) {
            return Err(format!(
                "文件已被外部修改，自动恢复已停止。请保留备份并处理冲突：{}",
                item.target
            ));
        }
        if let Some(before) = &item.before_hash {
            let backup = p::safe(&location(root, &j.id)?, &format!("backup/{i}"))?;
            if p::file_hash(&backup)?.as_deref() != Some(before) {
                return Err(format!("原文件备份损坏，无法恢复：{}", item.target));
            }
        }
    }
    Ok(())
}

fn restore(root: &Path, j: &Journal) -> TransferResult<()> {
    verify_restore(root, j)?;
    for (i, item) in j
        .items
        .iter()
        .enumerate()
        .rev()
        .filter(|(_, i)| plan::writes(i))
    {
        let target = p::target(root, &item.target)?;
        let current = p::file_hash(&target)?;
        if current == item.before_hash {
            continue;
        }
        if current.as_deref() != Some(&item.after_hash) {
            return Err(format!("恢复期间文件变化：{}", item.target));
        }
        if item.before_hash.is_some() {
            let backup = p::safe(&location(root, &j.id)?, &format!("backup/{i}"))?;
            p::atomic_write(&target, &p::read(&backup, MAX_FILE)?)?;
        } else if item.kind != Kind::Attachment {
            fs::remove_file(&target).map_err(|e| format!("无法移除本次新增文件：{e}"))?;
            p::sync_parent(&target)?;
        }
    }
    for rel in j.directories.iter().rev() {
        let path = p::target(root, rel)?;
        if path.is_dir()
            && fs::read_dir(&path)
                .map_err(|e| e.to_string())?
                .next()
                .is_none()
        {
            fs::remove_dir(path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub fn recover(root: &Path) -> TransferResult<()> {
    for mut j in history(root)? {
        match j.state.as_str() {
            "prepared" => {
                j.state = "rolledBack".into();
                save(root, &j)?;
            }
            "applying" | "undoing" => {
                restore(root, &j)?;
                j.state = if j.state == "undoing" {
                    "undone"
                } else {
                    "rolledBack"
                }
                .into();
                save(root, &j)?;
            }
            _ => {}
        }
    }
    Ok(())
}

pub fn commit(
    root: &Path,
    stage: &Path,
    preview: &Preview,
    progress: &impl Fn(Progress),
) -> TransferResult<Journal> {
    let id = &preview.operation_id;
    let directory = location(root, id)?;
    if directory.exists() {
        return Err("此操作已执行，请重新预览或查看迁移记录".into());
    }
    let mut j = Journal {
        id: id.clone(),
        created_at_ms: now_ms(),
        state: "prepared".into(),
        items: preview.items.clone(),
        directories: vec![],
    };
    let needed: u64 = preview.manifest.entries.iter().map(|e| e.bytes).sum();
    let mut backup_bytes = 0;
    for item in j.items.iter().filter(|i| plan::writes(i)) {
        if item.before_hash.is_some() {
            backup_bytes += fs::metadata(p::target(root, &item.target)?)
                .map_err(|e| e.to_string())?
                .len();
        }
    }
    p::require_space(root, needed.saturating_mul(2).saturating_add(backup_bytes))?;
    p::create_dirs(&directory)?;
    let map = plan::mapping(&j.items);
    for (i, item) in j.items.iter().enumerate().filter(|(_, i)| plan::writes(i)) {
        let target = p::target(root, &item.target)?;
        if p::file_hash(&target)? != item.before_hash {
            return Err(format!("预览已过期，请重试：{}", item.target));
        }
        if let Some(expected) = &item.before_hash {
            let bytes = p::read(&target, MAX_FILE)?;
            if p::hash(&bytes) != *expected {
                return Err("备份期间文件发生变化".into());
            }
            p::write_new(&p::safe(&directory, &format!("backup/{i}"))?, &bytes)?;
        }
        let bytes = plan::bytes(stage, item, &map)?;
        if p::hash(&bytes) != item.after_hash {
            return Err("导入计划与暂存内容不一致".into());
        }
        p::write_new(&p::safe(&directory, &format!("new/{i}"))?, &bytes)?;
    }
    for dir in &preview.manifest.directories {
        if !p::target(root, dir)?.exists() {
            j.directories.push(dir.clone());
        }
    }
    save(root, &j)?;
    j.state = "applying".into();
    save(root, &j)?;
    let result = apply(root, &j, progress, None);
    if let Err(error) = result {
        match restore(root, &j) {
            Ok(()) => {
                j.state = "rolledBack".into();
                save(root, &j)?;
                return Err(format!("导入失败，已恢复原文件：{error}"));
            }
            Err(rollback) => {
                return Err(format!(
                    "导入失败：{error}。恢复尚未完成：{rollback}。请保留迁移记录与备份。"
                ))
            }
        }
    }
    j.state = "committed".into();
    save(root, &j)?;
    Ok(j)
}

/// `fail_after` is used by filesystem tests to interrupt a real transaction at a write boundary.
fn apply(
    root: &Path,
    j: &Journal,
    progress: &impl Fn(Progress),
    fail_after: Option<usize>,
) -> TransferResult<()> {
    for dir in &j.directories {
        p::create_dirs(&p::target(root, dir)?)?;
    }
    let mut writes: Vec<_> = j
        .items
        .iter()
        .enumerate()
        .filter(|(_, i)| plan::writes(i))
        .collect();
    writes.sort_by_key(|(_, i)| if i.kind == Kind::Attachment { 0 } else { 1 });
    for (done, (i, item)) in writes.iter().enumerate() {
        if fail_after == Some(done) {
            return Err("injected write failure".into());
        }
        let target = p::target(root, &item.target)?;
        if p::file_hash(&target)? != item.before_hash {
            return Err(format!("提交期间文件变化：{}", item.target));
        }
        let bytes = p::read(
            &p::safe(&location(root, &j.id)?, &format!("new/{i}"))?,
            MAX_FILE,
        )?;
        if p::hash(&bytes) != item.after_hash {
            return Err("待写文件损坏".into());
        }
        p::atomic_write(&target, &bytes)?;
        progress(Progress {
            phase: "写入资料".into(),
            completed: done + 1,
            total: writes.len(),
        });
    }
    Ok(())
}

pub fn undo(root: &Path, id: &str) -> TransferResult<Journal> {
    let mut j = history(root)?
        .into_iter()
        .find(|j| j.id == id)
        .ok_or("找不到迁移记录")?;
    if j.state != "committed" {
        return Err("仅能撤销已完成的导入".into());
    }
    verify_restore(root, &j)?;
    j.state = "undoing".into();
    save(root, &j)?;
    restore(root, &j)?;
    j.state = "undone".into();
    save(root, &j)?;
    Ok(j)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temp() -> PathBuf {
        let p = std::env::temp_dir().join(format!("kalo-transfer-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        p
    }
    #[test]
    fn interrupted_multi_file_write_is_recovered_and_external_edits_block_undo() {
        let root = temp();
        let id = uuid::Uuid::new_v4().to_string();
        let mut items = vec![];
        for (i, path) in ["knowledge/cards/a.md", "knowledge/cards/b.md"]
            .iter()
            .enumerate()
        {
            p::write_new(&p::safe(&root, path).unwrap(), b"old").unwrap();
            p::write_new(
                &location(&root, &id).unwrap().join(format!("backup/{i}")),
                b"old",
            )
            .unwrap();
            p::write_new(
                &location(&root, &id).unwrap().join(format!("new/{i}")),
                b"new",
            )
            .unwrap();
            items.push(PlanItem {
                source: path.to_string(),
                target: path.to_string(),
                kind: Kind::Note,
                status: "conflict".into(),
                choice: Choice::Replace,
                incoming_hash: p::hash(b"new"),
                local_hash: Some(p::hash(b"old")),
                before_hash: Some(p::hash(b"old")),
                after_hash: p::hash(b"new"),
            });
        }
        let mut j = Journal {
            id: id.clone(),
            created_at_ms: 1,
            state: "applying".into(),
            items,
            directories: vec![],
        };
        save(&root, &j).unwrap();
        assert!(apply(&root, &j, &|_| {}, Some(1)).is_err());
        assert_eq!(fs::read(root.join("knowledge/cards/a.md")).unwrap(), b"new");
        recover(&root).unwrap();
        assert_eq!(fs::read(root.join("knowledge/cards/a.md")).unwrap(), b"old");
        apply(&root, &j, &|_| {}, None).unwrap();
        j.state = "committed".into();
        save(&root, &j).unwrap();
        fs::write(root.join("knowledge/cards/a.md"), b"user edit").unwrap();
        assert!(undo(&root, &id).is_err());
        assert_eq!(fs::read(root.join("knowledge/cards/b.md")).unwrap(), b"new");
        fs::remove_dir_all(root).unwrap();
    }
}
