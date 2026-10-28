use super::{platform as p, types::*};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

pub fn kind(path: &str) -> TransferResult<Kind> {
    p::validate(path)?;
    let parts: Vec<_> = path.split('/').collect();
    let name = parts.last().copied().unwrap_or("");
    if parts.first() == Some(&"attachments") && parts.len() == 3 && parts[1] == "portable" {
        let (hash, ext) = name.split_once('.').ok_or("附件名称无效")?;
        if hash.len() == 64
            && hash
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            && !ext.is_empty()
            && ext.len() <= 12
            && ext.bytes().all(|b| b.is_ascii_alphanumeric())
        {
            return Ok(Kind::Attachment);
        }
    }
    if !name.ends_with(".md") || name.starts_with('.') {
        return Err(format!("不允许的资料文件：{path}"));
    }
    if parts.first() == Some(&"knowledge")
        && ["INDEX.md", "AGENTS.md", "README.md"]
            .iter()
            .any(|n| p::key(n) == p::key(name))
    {
        return Err(format!("资料包不能导入保留文件：{path}"));
    }
    match parts.first().copied() {
        Some("memory") if parts.len() == 2 => Ok(Kind::Memory),
        Some("memory")
            if parts.len() >= 3
                && parts[1] == "archive"
                && parts[2..].iter().all(|p| !p.starts_with('.')) =>
        {
            Ok(Kind::Archive)
        }
        Some("knowledge") if parts.len() == 3 && parts[1] == "_types" => Ok(Kind::Domain),
        Some("knowledge")
            if parts.len() >= 2
                && !["INDEX.md", "AGENTS.md", "README.md"]
                    .iter()
                    .any(|n| p::key(n) == p::key(name))
                && parts[1..parts.len() - 1]
                    .iter()
                    .all(|s| !s.starts_with(['.', '_']) && *s != "attachments") =>
        {
            Ok(Kind::Note)
        }
        _ => Err(format!("资料包包含范围外文件：{path}")),
    }
}

pub fn validate_manifest(m: &Manifest) -> TransferResult<()> {
    if m.format != "kalo-personal-data" || m.format_version != 1 {
        return Err("不支持此资料包版本，请升级 Kalo 或重新导出".into());
    }
    if m.entries.len() + m.directories.len() > MAX_ENTRIES || m.warnings.len() > MAX_ENTRIES {
        return Err("资料包条目过多".into());
    }
    let mut total = 0u64;
    let mut names = BTreeMap::new();
    let mut files = BTreeSet::new();
    let mut spellings = BTreeMap::new();
    for path in m.entries.iter().map(|e| &e.path).chain(&m.directories) {
        let mut prefix = String::new();
        for part in path.split('/') {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(part);
            if let Some(old) = spellings.insert(p::key(&prefix), prefix.clone()) {
                if old != prefix {
                    return Err(format!(
                        "目录或文件的大小写/Unicode 名称冲突：{old} 与 {prefix}"
                    ));
                }
            }
        }
    }
    for entry in &m.entries {
        if kind(&entry.path)? != entry.kind {
            return Err(format!("内容类型不一致：{}", entry.path));
        }
        if matches!(entry.kind, Kind::Memory | Kind::Archive) && !m.scopes.memory
            || matches!(entry.kind, Kind::Note | Kind::Domain) && !m.scopes.notes
        {
            return Err("资料包内容超出声明范围".into());
        }
        if entry.bytes > MAX_FILE
            || entry.sha256.len() != 64
            || !entry
                .sha256
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err("文件大小或校验值无效".into());
        }
        total = total.checked_add(entry.bytes).ok_or("资料包体积溢出")?;
        if total > MAX_TOTAL {
            return Err("资料包解压后超过 5 GiB".into());
        }
        let key = p::key(&entry.path);
        if names.insert(key.clone(), entry.path.clone()).is_some() {
            return Err(format!("存在重名或大小写/Unicode 冲突：{}", entry.path));
        }
        files.insert(key);
        if entry.kind == Kind::Attachment
            && !entry.path.ends_with(&format!(
                "{}.{}",
                entry.sha256,
                entry.path.rsplit('.').next().unwrap_or("")
            ))
        {
            return Err("附件名称与内容哈希不一致".into());
        }
    }
    for dir in &m.directories {
        p::validate(dir)?;
        if dir != "memory"
            && dir != "memory/archive"
            && dir != "knowledge"
            && dir != "knowledge/_types"
            && !(dir.starts_with("knowledge/")
                && dir
                    .split('/')
                    .skip(1)
                    .all(|s| !s.starts_with(['.', '_']) && s != "attachments"))
            && !(dir.starts_with("memory/archive/")
                && dir.split('/').skip(2).all(|s| !s.starts_with('.')))
        {
            return Err(format!("不允许的目录：{dir}"));
        }
        let key = p::key(dir);
        if names.insert(key, dir.clone()).is_some() {
            return Err(format!("重复目录或文件目录冲突：{dir}"));
        }
    }
    for (key, original) in &names {
        let mut parent = key.as_str();
        while let Some((p, _)) = parent.rsplit_once('/') {
            if files.contains(p) {
                return Err(format!("文件与目录冲突：{original}"));
            }
            if let Some(spelling) = names.get(p) {
                let original_parent = original
                    .split('/')
                    .take(p.split('/').count())
                    .collect::<Vec<_>>()
                    .join("/");
                if *spelling != original_parent {
                    return Err(format!("目录大小写或 Unicode 拼写冲突：{original}"));
                }
            }
            parent = p;
        }
    }
    Ok(())
}

/// Bound central-directory allocation before giving untrusted input to the ZIP reader.
fn inspect_directory(file: &mut File) -> TransferResult<()> {
    let length = file.metadata().map_err(|e| e.to_string())?.len();
    let tail_len = length.min(65_557) as usize;
    file.seek(SeekFrom::End(-(tail_len as i64)))
        .map_err(|e| e.to_string())?;
    let mut tail = vec![0; tail_len];
    file.read_exact(&mut tail).map_err(|e| e.to_string())?;
    let at = (0..tail_len.saturating_sub(21))
        .rev()
        .find(|&i| {
            tail[i..].starts_with(b"PK\x05\x06")
                && i + 22 + u16::from_le_bytes([tail[i + 20], tail[i + 21]]) as usize == tail_len
        })
        .ok_or("ZIP 结束记录无效")?;
    let u16_at = |i| u16::from_le_bytes([tail[at + i], tail[at + i + 1]]);
    let u32_at = |i| {
        u32::from_le_bytes(
            tail[at + i..at + i + 4]
                .try_into()
                .expect("bounded ZIP record"),
        )
    };
    if u16_at(4) != 0 || u16_at(6) != 0 || u16_at(8) != u16_at(10) {
        return Err("不支持分卷 ZIP".into());
    }
    let mut count = u16_at(10) as u64;
    let mut size = u32_at(12) as u64;
    let mut offset = u32_at(16) as u64;
    if count == u16::MAX as u64 || size == u32::MAX as u64 || offset == u32::MAX as u64 {
        if at < 20 || &tail[at - 20..at - 16] != b"PK\x06\x07" {
            return Err("ZIP64 定位记录无效".into());
        }
        let locator = &tail[at - 20..at];
        if u32::from_le_bytes(locator[4..8].try_into().unwrap()) != 0
            || u32::from_le_bytes(locator[16..20].try_into().unwrap()) != 1
        {
            return Err("不支持分卷 ZIP64".into());
        }
        let pos = u64::from_le_bytes(locator[8..16].try_into().unwrap());
        if pos.saturating_add(56) > length {
            return Err("ZIP64 记录越界".into());
        }
        file.seek(SeekFrom::Start(pos)).map_err(|e| e.to_string())?;
        let mut record = [0u8; 56];
        file.read_exact(&mut record).map_err(|e| e.to_string())?;
        if &record[..4] != b"PK\x06\x06" || record[16..24] != [0u8; 8] {
            return Err("ZIP64 记录无效".into());
        }
        count = u64::from_le_bytes(record[32..40].try_into().unwrap());
        size = u64::from_le_bytes(record[40..48].try_into().unwrap());
        offset = u64::from_le_bytes(record[48..56].try_into().unwrap());
    }
    if count > (MAX_ENTRIES + 1) as u64
        || size > MAX_MANIFEST * 4
        || offset.saturating_add(size) > length
    {
        return Err("ZIP 目录超过限制或越界".into());
    }
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn save_manifest(stage: &Path, manifest: &Manifest) -> TransferResult<()> {
    validate_manifest(manifest)?;
    let bytes = serde_json::to_vec_pretty(manifest).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_MANIFEST {
        return Err("清单过大".into());
    }
    p::atomic_write(&stage.join("manifest.json"), &bytes)
}

pub fn load_manifest(stage: &Path) -> TransferResult<Manifest> {
    let m = serde_json::from_slice(&p::read(&stage.join("manifest.json"), MAX_MANIFEST)?)
        .map_err(|e| format!("清单无法读取：{e}"))?;
    validate_manifest(&m)?;
    Ok(m)
}

pub fn verify(stage: &Path, m: &Manifest) -> TransferResult<()> {
    validate_manifest(m)?;
    for entry in &m.entries {
        let path = p::safe(&stage.join("data"), &entry.path)?;
        let bytes = p::read(&path, MAX_FILE)?;
        if bytes.len() as u64 != entry.bytes || p::hash(&bytes) != entry.sha256 {
            return Err(format!("文件校验失败：{}", entry.path));
        }
    }
    Ok(())
}

pub fn unpack(
    source: &Path,
    stage: &Path,
    progress: &impl Fn(Progress),
) -> TransferResult<Manifest> {
    p::no_link(source)?;
    let mut f = File::open(source).map_err(|e| format!("无法打开资料包：{e}"))?;
    if f.metadata().map_err(|e| e.to_string())?.len() > MAX_TOTAL + MAX_MANIFEST {
        return Err("压缩包超过体积限制".into());
    }
    inspect_directory(&mut f)?;
    let mut zip = ZipArchive::new(f).map_err(|e| format!("无法读取 ZIP：{e}"))?;
    if zip.len() > MAX_ENTRIES + 1 {
        return Err("ZIP 条目过多".into());
    }
    let mut seen = BTreeSet::new();
    for i in 0..zip.len() {
        let entry = zip.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir()
            || entry
                .unix_mode()
                .is_some_and(|m| m & 0o170000 != 0 && m & 0o170000 != 0o100000)
        {
            return Err("ZIP 只允许普通文件条目".into());
        }
        p::validate(entry.name())?;
        if !seen.insert(p::key(entry.name())) {
            return Err("ZIP 存在重复或冲突条目".into());
        }
    }
    let m: Manifest = {
        let mut entry = zip
            .by_name("manifest.json")
            .map_err(|_| "缺少 manifest.json")?;
        let mut bytes = Vec::new();
        (&mut entry)
            .take(MAX_MANIFEST + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_MANIFEST {
            return Err("清单超过 16 MiB".into());
        }
        serde_json::from_slice(&bytes).map_err(|e| format!("清单格式无效：{e}"))?
    };
    validate_manifest(&m)?;
    if zip.len() != m.entries.len() + 1 {
        return Err("ZIP 与清单的文件数量不一致".into());
    }
    p::require_space(stage, m.entries.iter().map(|e| e.bytes).sum())?;
    for (i, entry) in m.entries.iter().enumerate() {
        let mut input = zip
            .by_name(&format!("data/{}", entry.path))
            .map_err(|_| format!("缺少文件：{}", entry.path))?;
        if input.size() != entry.bytes {
            return Err(format!("文件大小声明不符：{}", entry.path));
        }
        let mut bytes = Vec::new();
        (&mut input)
            .take(entry.bytes + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("解压失败：{e}"))?;
        if bytes.len() as u64 != entry.bytes || p::hash(&bytes) != entry.sha256 {
            return Err(format!("资料包损坏：{}", entry.path));
        }
        p::write_new(&p::safe(&stage.join("data"), &entry.path)?, &bytes)?;
        progress(Progress {
            phase: "校验资料包".into(),
            completed: i + 1,
            total: m.entries.len(),
        });
    }
    save_manifest(stage, &m)?;
    Ok(m)
}

pub fn pack(stage: &Path, destination: &Path, progress: &impl Fn(Progress)) -> TransferResult<()> {
    let m = load_manifest(stage)?;
    verify(stage, &m)?;
    if destination.exists() {
        return Err("目标文件已存在，请选择新文件名，原备份不会被覆盖".into());
    }
    let parent = destination
        .parent()
        .filter(|p| p.is_dir())
        .ok_or("请选择有效的保存目录")?;
    p::require_space(parent, m.entries.iter().map(|e| e.bytes).sum())?;
    let temp = parent.join(format!(".kalo-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        let mut zip = ZipWriter::new(f);
        let options = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o600);
        zip.start_file("manifest.json", options)
            .map_err(|e| e.to_string())?;
        zip.write_all(&serde_json::to_vec_pretty(&m).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        for (i, entry) in m.entries.iter().enumerate() {
            zip.start_file(format!("data/{}", entry.path), options)
                .map_err(|e| e.to_string())?;
            let bytes = p::read(&p::safe(&stage.join("data"), &entry.path)?, MAX_FILE)?;
            zip.write_all(&bytes).map_err(|e| e.to_string())?;
            progress(Progress {
                phase: "生成资料包".into(),
                completed: i + 1,
                total: m.entries.len(),
            });
        }
        zip.finish()
            .map_err(|e| e.to_string())?
            .sync_all()
            .map_err(|e| e.to_string())?;
        // Publish without replacing a competing file; FAT/exFAT cannot create hard links.
        if fs::hard_link(&temp, destination).is_err() {
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(destination)
                .map_err(|e| format!("无法新建导出文件：{e}"))?;
            let copied = (|| {
                let mut input = File::open(&temp).map_err(|e| e.to_string())?;
                std::io::copy(&mut input, &mut output).map_err(|e| e.to_string())?;
                output.sync_all().map_err(|e| e.to_string())
            })();
            drop(output);
            if let Err(e) = copied {
                let _ = fs::remove_file(destination);
                return Err(e);
            }
        }
        p::sync_parent(destination)
    })();
    let _ = fs::remove_file(temp);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_configuration_and_reserved_notes() {
        for path in [
            "agent/auth.json",
            "knowledge/AGENTS.md",
            "knowledge/.trash/a.md",
            "memory/a/b.md",
            "knowledge/x/README.md",
        ] {
            assert!(kind(path).is_err(), "{path}");
        }
        assert_eq!(kind("knowledge/custom/deep/a.md").unwrap(), Kind::Note);
        assert_eq!(kind("memory/archive/old/a.md").unwrap(), Kind::Archive);
    }
}
