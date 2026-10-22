//! WorkBuddy package import. Only declared roles/skills and passive assets are installed.
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::experts::{self, Expert, ExpertMember};

fn localized(value: &Value) -> String {
    value
        .as_str()
        .or_else(|| value.get("zh").and_then(Value::as_str))
        .or_else(|| value.get("en").and_then(Value::as_str))
        .unwrap_or("")
        .to_string()
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Apply both platforms' restrictions on either host, including backslash traversal.
fn relative_path(raw: &str) -> Result<PathBuf, String> {
    let normalized = raw.replace('\\', "/");
    if normalized.is_empty()
        || normalized.contains(':')
        || normalized.starts_with('/')
        || normalized.split('/').any(|s| s == "..")
    {
        return Err(format!("包路径必须位于包目录内：{raw}"));
    }
    let path = PathBuf::from(normalized);
    if path
        .components()
        .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err(format!("无效的包路径：{raw}"));
    }
    Ok(path)
}

fn source_path(root: &Path, raw: &str) -> Result<PathBuf, String> {
    let relative = relative_path(raw)?;
    let mut current = root.to_path_buf();
    for part in relative.components() {
        current.push(part);
        let meta = fs::symlink_metadata(&current)
            .map_err(|e| format!("读取 {} 失败：{e}", current.display()))?;
        if meta.file_type().is_symlink() {
            return Err(format!("专家包不支持符号链接：{}", current.display()));
        }
    }
    let canonical = current.canonicalize().map_err(|e| e.to_string())?;
    if !canonical.starts_with(root) {
        return Err(format!("包路径越界：{raw}"));
    }
    Ok(current)
}

fn copy_tree(source: &Path, dest: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(source).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() {
        return Err(format!("专家包不支持符号链接：{}", source.display()));
    }
    if meta.is_dir() {
        fs::create_dir_all(dest).map_err(|e| e.to_string())?;
        for item in fs::read_dir(source).map_err(|e| e.to_string())? {
            let item = item.map_err(|e| e.to_string())?;
            copy_tree(&item.path(), &dest.join(item.file_name()))?;
        }
    } else if meta.is_file() {
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::copy(source, dest).map_err(|e| format!("复制 {} 失败：{e}", source.display()))?;
    } else {
        return Err(format!("专家包含不支持的文件：{}", source.display()));
    }
    Ok(())
}

struct Package {
    expert: Expert,
    files: Vec<PathBuf>,
    skills: Vec<PathBuf>,
}

fn parse_package(root: &Path, dest_root: &Path) -> Result<Package, String> {
    let manifest = [
        ".codebuddy-plugin/plugin.json",
        ".claude-plugin/plugin.json",
    ]
    .into_iter()
    .find(|p| root.join(p).is_file())
    .ok_or("请选择包含 .codebuddy-plugin/plugin.json 的专家包根目录")?;
    let text = fs::read_to_string(source_path(root, manifest)?).map_err(|e| e.to_string())?;
    let json: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|e| format!("解析专家包清单失败：{e}"))?;
    let id = json["name"].as_str().unwrap_or("");
    if !valid_id(id) {
        return Err("包名只能是 1-64 位字母数字/-/_".into());
    }
    let kind = json["expertType"].as_str().unwrap_or("agent");
    if kind != "team" && kind != "agent" {
        return Err(format!("不支持的专家类型：{kind}"));
    }
    let entry = if kind == "team" {
        &json["teamInfo"]["leadAgent"]
    } else {
        &json["agentName"]
    };
    let entry = entry
        .as_str()
        .filter(|s| valid_id(s))
        .ok_or("缺少有效的入口角色 ID")?;
    let mut ids = vec![entry.to_string()];
    if kind == "team" {
        let members = json["teamInfo"]["memberAgents"]
            .as_array()
            .ok_or("专家团缺少 memberAgents")?;
        if members.is_empty() {
            return Err("专家团至少需要一个成员".into());
        }
        for member in members {
            let member = member
                .as_str()
                .filter(|s| valid_id(s))
                .ok_or("成员 ID 无效")?;
            if ids.iter().any(|id| id.eq_ignore_ascii_case(member)) {
                return Err(format!("重复的团队角色：{member}"));
            }
            ids.push(member.to_string());
        }
    }
    let agents = match json.get("agents") {
        Some(value) => value
            .as_array()
            .ok_or("agents 必须是 Markdown 路径列表")?
            .clone(),
        None => ids
            .iter()
            .map(|id| Value::String(format!("agents/{id}.md")))
            .collect(),
    };
    let mut paths = HashMap::new();
    let mut seen = HashSet::new();
    let mut files = Vec::new();
    for item in &agents {
        let raw = item.as_str().ok_or("agents 必须是 Markdown 路径列表")?;
        let path = relative_path(raw)?;
        let role = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        if path.extension().and_then(|s| s.to_str()) != Some("md")
            || !valid_id(role)
            || !seen.insert(role.to_ascii_lowercase())
        {
            return Err(format!("无效或重复的角色路径：{raw}"));
        }
        if !source_path(root, raw)?.is_file() {
            return Err(format!("角色文件不存在：{raw}"));
        }
        paths.insert(role.to_string(), path.clone());
        files.push(path);
    }
    let mut members = Vec::new();
    for role in ids {
        let path = paths
            .get(&role)
            .ok_or_else(|| format!("角色未在 agents 中声明：{role}"))?;
        let meta = json["members"]
            .as_array()
            .and_then(|list| list.iter().find(|m| m["id"] == role));
        let name = meta
            .map(|m| localized(m.get("displayName").unwrap_or(&m["name"])))
            .unwrap_or_default();
        members.push(ExpertMember {
            id: role.clone(),
            name: if name.is_empty() { role } else { name },
            profession: meta
                .map(|m| localized(&m["profession"]))
                .unwrap_or_default(),
            agent_path: path.to_string_lossy().replace('\\', "/"),
        });
    }
    let mut skills = Vec::new();
    let mut skill_ids = HashSet::new();
    if let Some(items) = json.get("skills") {
        for item in items.as_array().ok_or("skills 必须是目录列表")? {
            let raw = item.as_str().ok_or("技能目录无效")?;
            let path = relative_path(raw)?;
            let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if !valid_id(name) || !skill_ids.insert(name.to_ascii_lowercase()) {
                return Err(format!("无效或重复的技能目录：{raw}"));
            }
            source_path(root, &format!("{raw}/SKILL.md"))?;
            skills.push(path.clone());
            files.push(path);
        }
    }
    for optional in ["assets", "avatars", "README.md"] {
        if root.join(optional).exists() {
            source_path(root, optional)?;
            files.push(PathBuf::from(optional));
        }
    }
    files.push(PathBuf::from(manifest));
    let name = localized(&json["displayName"]);
    let description = localized(&json["displayDescription"]);
    Ok(Package {
        expert: Expert {
            id: id.to_string(),
            name: if name.is_empty() {
                id.to_string()
            } else {
                name
            },
            workdir: String::new(),
            definition_dir: Some(dest_root.join(id).to_string_lossy().into_owned()),
            mission: if description.is_empty() {
                localized(&json["description"])
            } else {
                description
            },
            created_at: crate::sessions_store::iso_now(),
            enabled: true,
            kind: Some(kind.to_string()),
            entry_agent: Some(entry.to_string()),
            members,
            package_version: json["version"].as_str().map(String::from),
        },
        files,
        skills,
    })
}

fn install(root: &Path, dest_root: &Path) -> Result<Expert, String> {
    let root = root
        .canonicalize()
        .map_err(|e| format!("无法打开专家包：{e}"))?;
    let package = parse_package(&root, dest_root)?;
    let dest = package.expert.definition_dir();
    if dest.exists() {
        return Err(format!(
            "专家目录已存在，为保护用户资料不覆盖：{}",
            dest.display()
        ));
    }
    fs::create_dir_all(dest_root).map_err(|e| e.to_string())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let staging = dest_root.join(format!(".import-{}-{stamp}", std::process::id()));
    fs::create_dir(&staging).map_err(|e| e.to_string())?;
    let result = (|| {
        for file in &package.files {
            copy_tree(&root.join(file), &staging.join(file))?;
        }
        for skill in &package.skills {
            copy_tree(
                &root.join(skill),
                &staging
                    .join(".kalo/skills")
                    .join(skill.file_name().ok_or("技能目录无效")?),
            )?;
        }
        fs::create_dir_all(staging.join(".kalo")).map_err(|e| e.to_string())?;
        fs::write(
            staging.join(".kalo/expert.json"),
            serde_json::to_vec_pretty(&package.expert).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        fs::write(staging.join("AGENTS.md"), "# 专家定义\n\n身份与团队成员以 `.kalo/expert.json` 为准；角色正文在 agents/，技能在 .kalo/skills/。\n本目录提供角色与技能，不是任务工作目录；产出和 profile/ 写入当前任务目录。\n外部服务缺少配置时报告缺失项，不编造执行结果。\n").map_err(|e| e.to_string())?;
        if dest.exists() {
            return Err("专家目录在导入过程中已被创建，请刷新列表".to_string());
        }
        fs::rename(&staging, &dest).map_err(|e| e.to_string())?;
        Ok(package.expert)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

#[tauri::command(async)]
pub fn expert_import(path: String) -> Result<Expert, String> {
    let registry = experts::registry_file()?;
    let kalo = registry.parent().ok_or("无法确定 Kalo 数据目录")?;
    let source = Path::new(&path).canonicalize().map_err(|e| e.to_string())?;
    let dest_root = kalo.join("agent").join("experts");
    let parsed = parse_package(&source, &dest_root)?;
    if experts::list()?
        .iter()
        .any(|e| e.id.eq_ignore_ascii_case(&parsed.expert.id))
    {
        return Err(format!("专家已注册：{}；请使用现有专家", parsed.expert.id));
    }
    let expert = install(&source, &dest_root)?;
    experts::expert_upsert(expert.clone())
        .map_err(|e| format!("文件已安装至 {}，但注册失败：{e}", expert.definition_dir().display()))?;
    Ok(expert)
}

#[cfg(test)]
#[path = "expert_import_tests.rs"]
mod tests;
