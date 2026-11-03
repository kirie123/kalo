use serde::{de::DeserializeOwned, Serialize};
use std::{fs, io::Write, path::Path};

fn check(id: &str) -> Result<(), String> {
    uuid::Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| "无效的数据 ID".into())
}
pub fn save<T: Serialize>(root: &Path, kind: &str, id: &str, value: &T) -> Result<(), String> {
    check(id)?;
    let dir = root.join(kind);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let target = dir.join(format!("{id}.json"));
    if target.exists() {
        return Err("不可覆盖已有快照或报告".into());
    }
    let tmp = dir.join(format!("{id}.{}.tmp", uuid::Uuid::new_v4()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(&tmp, target).map_err(|e| e.to_string())
}
pub fn read<T: DeserializeOwned>(root: &Path, kind: &str, id: &str) -> Result<T, String> {
    check(id)?;
    let bytes = fs::read(root.join(kind).join(format!("{id}.json")))
        .map_err(|e| format!("无法读取 {kind}：{e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("数据损坏：{e}"))
}
pub fn catalog(root: &Path) -> Result<serde_json::Value, String> {
    fn list(root: &Path, kind: &str) -> Result<Vec<serde_json::Value>, String> {
        let dir = root.join(kind);
        if !dir.exists() {
            return Ok(vec![]);
        }
        let mut paths: Vec<_> = fs::read_dir(dir)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("json"))
            .collect();
        paths.sort_by_key(|p| std::cmp::Reverse(p.metadata().and_then(|m| m.modified()).ok()));
        paths
            .into_iter()
            .take(30)
            .map(|p| {
                let v: serde_json::Value =
                    serde_json::from_slice(&fs::read(p).map_err(|e| e.to_string())?)
                        .map_err(|e| e.to_string())?;
                Ok(v)
            })
            .collect()
    }
    Ok(serde_json::json!({"snapshots": list(root,"snapshots")?, "reports":list(root,"reports")?}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn immutable_files_and_invalid_identifiers() {
        let root =
            std::env::temp_dir().join(format!("kalo-investment-test-{}", uuid::Uuid::new_v4()));
        let id = uuid::Uuid::new_v4().to_string();
        let v = serde_json::json!({"id":id,"value":42});
        save(&root, "snapshots", &id, &v).unwrap();
        assert!(save(&root, "snapshots", &id, &serde_json::json!({"value":0})).is_err());
        let loaded: serde_json::Value = read(&root, "snapshots", &id).unwrap();
        assert_eq!(loaded["value"], 42);
        assert!(read::<serde_json::Value>(&root, "snapshots", "../outside").is_err());
        assert_eq!(
            catalog(&root).unwrap()["snapshots"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        fs::remove_dir_all(&root).unwrap();
    }
}
