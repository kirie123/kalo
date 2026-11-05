//! Durable byte attachments. Never delete sent files by age.
use base64::Engine;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

const MAX_BYTES: usize = 32 * 1024 * 1024;

pub fn save(name: &str, data_base64: &str) -> Result<crate::files::AttachmentData, String> {
    if data_base64.len() > MAX_BYTES.div_ceil(3) * 4 {
        return Err("文件过大，粘贴附件最多 32 MB；已有文件可通过选择或拖入引用原路径".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|e| format!("附件数据无效：{e}"))?;
    if bytes.len() > MAX_BYTES {
        return Err("粘贴附件最多 32 MB".into());
    }
    let path = save_at(&crate::kalo_home::root()?, name, &bytes)?;
    Ok(crate::files::AttachmentData::File {
        name: path.file_name().unwrap().to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
    })
}

fn safe_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let mut length = 0;
    let cleaned: String = base
        .chars()
        .filter(|c| !matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|') && !c.is_control())
        .take_while(|c| {
            length += c.len_utf8();
            length <= 200
        })
        .collect();
    let cleaned = cleaned
        .trim()
        .trim_matches(|c: char| c == '.' || c.is_whitespace());
    if cleaned.is_empty() {
        return "attachment".into();
    }
    let stem = cleaned
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        });
    if reserved {
        format!("_{cleaned}")
    } else {
        cleaned.into()
    }
}

fn save_at(root: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let parent = root.join("attachments");
    fs::create_dir_all(&parent)
        .map_err(|e| format!("无法创建附件目录，请检查 KALO_HOME 的写入权限：{e}"))?;
    let dir = parent.join(uuid::Uuid::new_v4().to_string());
    fs::create_dir(&dir).map_err(|e| format!("无法创建附件目录：{e}"))?;
    let path = dir.join(safe_name(name));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path)?;
        file.write_all(bytes)?;
        file.sync_all()
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&path);
        let _ = fs::remove_dir(&dir);
        return Err(format!("保存附件失败，请检查磁盘空间和目录权限后重试：{e}"));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_portable_and_cannot_escape() {
        assert_eq!(safe_name("../../a.txt"), "a.txt");
        assert_eq!(safe_name("C:\\a\\CON.txt"), "_CON.txt");
        assert_eq!(safe_name("LPT1"), "_LPT1");
        assert_eq!(safe_name("..."), "attachment");
        assert_eq!(safe_name("a?.txt. "), "a.txt");
        assert_eq!(safe_name("中文.png"), "中文.png");
    }

    #[test]
    fn copies_are_unique_and_byte_exact() {
        let root =
            std::env::temp_dir().join(format!("kalo-attachment-test-{}", uuid::Uuid::new_v4()));
        let bytes = "  中文\r\n\n".as_bytes();
        let first = save_at(&root, "粘贴文本.txt", bytes).unwrap();
        let second = save_at(&root, "粘贴文本.txt", bytes).unwrap();
        assert_ne!(first, second);
        assert_eq!(fs::read(&first).unwrap(), bytes);
        assert_eq!(
            uuid::Uuid::parse_str(
                first
                    .parent()
                    .unwrap()
                    .file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
            )
            .unwrap()
            .get_version_num(),
            4
        );
        assert!(save_at(&first, "x", b"x").is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
