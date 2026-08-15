//! Skill management for pi Agent Skills.
//!
//! Skills live in two scopes:
//! - user (global): `~/.kalo/agent/skills/`
//! - project: `<cwd>/.kalo/skills/`
//!
//! Each skills root holds single-file skills (`<root>/<name>.md`) and
//! directory skills (`<root>/<name>/SKILL.md`). Both forms start with a YAML
//! frontmatter block (`---` fences) carrying `name:` and `description:`.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMeta {
    pub name: String,
    pub description: String,
    pub path: String,
    pub scope: String,
    pub is_dir: bool,
}

/// `~/.kalo/agent/skills` (`USERPROFILE`, then `HOME`).
fn user_skills_root() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "cannot resolve user home directory".to_string())?;
    Ok(PathBuf::from(home).join(".kalo").join("agent").join("skills"))
}

fn project_skills_root(cwd: &str) -> PathBuf {
    PathBuf::from(cwd).join(".kalo").join("skills")
}

/// List skills in the global scope, plus the project scope when `cwd` is
/// given. Missing directories are skipped silently.
pub fn list_skills(cwd: Option<&str>) -> Result<Vec<SkillMeta>, String> {
    let mut out = Vec::new();
    scan_root(&user_skills_root()?, "user", &mut out);
    if let Some(cwd) = cwd {
        scan_root(&project_skills_root(cwd), "project", &mut out);
    }
    Ok(out)
}

fn scan_root(root: &Path, scope: &str, out: &mut Vec<SkillMeta>) {
    let Ok(entries) = fs::read_dir(root) else {
        return; // missing or unreadable root is not an error
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let skill_file = path.join("SKILL.md");
            if skill_file.is_file() {
                out.push(build_meta(&skill_file, scope, true));
            }
        } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
            out.push(build_meta(&path, scope, false));
        }
    }
}

/// Build metadata for one skill file, parsing its frontmatter with a
/// filename fallback for the name.
fn build_meta(path: &Path, scope: &str, is_dir: bool) -> SkillMeta {
    let (fm_name, fm_description) = fs::read_to_string(path)
        .map(|text| parse_frontmatter(&text))
        .unwrap_or_default();

    let fallback_name = if is_dir {
        // <root>/<name>/SKILL.md -> directory name
        path.parent()
            .and_then(|dir| dir.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string()
    } else {
        // <root>/<name>.md -> file stem
        path.file_stem()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string()
    };

    SkillMeta {
        name: fm_name.filter(|n| !n.is_empty()).unwrap_or(fallback_name),
        description: fm_description.unwrap_or_default(),
        path: path.to_string_lossy().into_owned(),
        scope: scope.to_string(),
        is_dir,
    }
}

/// Minimal frontmatter parse: if the file opens with a `---` line, scan up
/// to the closing `---` line for top-level `name:` / `description:` values,
/// stripping surrounding whitespace and quotes. No full YAML support.
fn parse_frontmatter(text: &str) -> (Option<String>, Option<String>) {
    let mut lines = text.lines();
    if lines.next().map(|l| l.trim()) != Some("---") {
        return (None, None);
    }
    let mut name = None;
    let mut description = None;
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }
        if let Some((key, value)) = trimmed.split_once(':') {
            let value = value.trim().trim_matches('"').trim_matches('\'').to_string();
            match key.trim() {
                "name" => name = Some(value),
                "description" => description = Some(value),
                _ => {}
            }
        }
    }
    (name, description)
}

/// Read a skill file verbatim.
pub fn read_skill(path: &str) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| format!("failed to read skill {path}: {e}"))
}

/// Overwrite a skill file.
pub fn write_skill(path: &str, content: &str) -> Result<(), String> {
    fs::write(path, content).map_err(|e| format!("failed to write skill {path}: {e}"))
}

/// Create a new directory skill `<root>/<name>/SKILL.md` with a frontmatter
/// template. `scope` is "user" or "project" (project requires `cwd`).
/// Returns the new file path; fails if the skill already exists.
pub fn create_skill(name: &str, scope: &str, cwd: Option<&str>) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("skill name must not be empty".to_string());
    }
    if name.chars().any(|c| matches!(c, '/' | '\\' | ':')) {
        return Err(format!("skill name {name:?} must not contain path separators"));
    }

    let root = match scope {
        "user" => user_skills_root()?,
        "project" => {
            let cwd = cwd.ok_or_else(|| "project scope requires a cwd".to_string())?;
            project_skills_root(cwd)
        }
        other => return Err(format!("unknown skill scope: {other:?}")),
    };

    let skill_file = root.join(name).join("SKILL.md");
    if skill_file.exists() {
        return Err(format!("skill already exists: {}", skill_file.display()));
    }
    let dir = skill_file.parent().unwrap();
    fs::create_dir_all(dir).map_err(|e| format!("failed to create {}: {e}", dir.display()))?;
    let template = format!("---\nname: {name}\ndescription: \n---\n\n# {name}\n\n");
    fs::write(&skill_file, template)
        .map_err(|e| format!("failed to write {}: {e}", skill_file.display()))?;
    Ok(skill_file.to_string_lossy().into_owned())
}

/// Delete a skill. The canonicalized path must live under a known skills
/// root (the global root or any `<...>/.kalo/skills` directory); anything
/// else is refused. A `<root>/<name>/SKILL.md` path removes the whole
/// `<name>` directory; a single-file skill removes just that file.
pub fn delete_skill(path: &str) -> Result<(), String> {
    let canonical = fs::canonicalize(path)
        .map_err(|e| format!("failed to resolve skill path {path}: {e}"))?;
    if !is_under_skills_root(&canonical) {
        return Err(format!(
            "refusing to delete {}: not inside a pi skills directory",
            canonical.display()
        ));
    }

    let is_dir_skill = canonical.file_name().and_then(|n| n.to_str()) == Some("SKILL.md")
        && canonical
            .parent()
            .and_then(|dir| dir.parent())
            .map(is_skills_root_dir)
            .unwrap_or(false);

    if is_dir_skill {
        let dir = canonical.parent().unwrap();
        fs::remove_dir_all(dir).map_err(|e| format!("failed to delete {}: {e}", dir.display()))
    } else if canonical.is_file() {
        fs::remove_file(&canonical)
            .map_err(|e| format!("failed to delete {}: {e}", canonical.display()))
    } else {
        Err(format!("not a skill file: {}", canonical.display()))
    }
}

/// True when `path` sits under the global skills root or under any
/// directory named `skills` whose parent is `.kalo` (project roots).
fn is_under_skills_root(path: &Path) -> bool {
    if let Ok(root) = user_skills_root() {
        if let Ok(root) = fs::canonicalize(&root) {
            if path.starts_with(&root) {
                return true;
            }
        }
    }
    path.ancestors().any(|ancestor| is_skills_root_dir(ancestor))
}

/// True when `dir` is a `<something>/.kalo/skills` directory.
fn is_skills_root_dir(dir: &Path) -> bool {
    dir.file_name().and_then(|n| n.to_str()) == Some("skills")
        && dir
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            == Some(".kalo")
}
