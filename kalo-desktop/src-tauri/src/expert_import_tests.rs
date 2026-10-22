use super::*;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("kalo-package-{}-{stamp}", std::process::id()));
        fs::create_dir_all(root.join("source/.codebuddy-plugin")).unwrap();
        fs::create_dir_all(root.join("source/agents")).unwrap();
        fs::create_dir_all(root.join("source/skills/layout/assets")).unwrap();
        fs::write(
            root.join("source/agents/lead.md"),
            "---\nname: lead\n---\n主理人",
        )
        .unwrap();
        fs::write(
            root.join("source/agents/writer.md"),
            "---\nname: writer\n---\n写稿",
        )
        .unwrap();
        fs::write(
            root.join("source/skills/layout/SKILL.md"),
            "---\nname: layout\ndescription: 排版\n---\n排版",
        )
        .unwrap();
        fs::write(
            root.join("source/skills/layout/assets/template.html"),
            "<p>模板</p>",
        )
        .unwrap();
        Self(root)
    }
    fn manifest(&self, value: Value) {
        fs::write(
            self.0.join("source/.codebuddy-plugin/plugin.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
    }
    fn install(&self) -> Result<Expert, String> {
        install(&self.0.join("source"), &self.0.join("installed"))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn manifest() -> Value {
    serde_json::json!({
        "name": "test-team", "version": "1.2.3", "expertType": "team",
        "displayName": {"zh": "编辑团", "en": "Editors"},
        "agents": ["./agents/lead.md", "./agents/writer.md"],
        "teamInfo": {"leadAgent": "lead", "memberAgents": ["writer"]},
        "members": [{"id": "writer", "name": {"zh": "作者"}, "profession": {"zh": "写作"}}],
        "skills": ["./skills/layout"]
    })
}

#[test]
fn imports_team_with_local_skills_and_runtime_index() {
    let f = Fixture::new();
    f.manifest(manifest());
    let expert = f.install().unwrap();
    assert_eq!(expert.name, "编辑团");
    assert_eq!(expert.members[1].name, "作者");
    assert_eq!(expert.entry_agent.as_deref(), Some("lead"));
    let definition = expert.definition_dir();
    let root = definition.as_path();
    assert!(expert.workdir.is_empty());
    assert_eq!(
        fs::read_to_string(root.join(".kalo/skills/layout/assets/template.html")).unwrap(),
        "<p>模板</p>"
    );
    assert!(root.join("skills/layout/SKILL.md").is_file());
    let restored: Expert =
        serde_json::from_slice(&fs::read(root.join(".kalo/expert.json")).unwrap()).unwrap();
    assert_eq!(restored.members[1].agent_path, "./agents/writer.md");
    assert!(f.install().unwrap_err().contains("已存在"));
}

#[test]
fn imports_single_expert_and_string_names() {
    let f = Fixture::new();
    let mut m = manifest();
    m["expertType"] = "agent".into();
    m["agentName"] = "writer".into();
    m["displayName"] = "单专家".into();
    f.manifest(m);
    let e = f.install().unwrap();
    assert_eq!(e.name, "单专家");
    assert_eq!(e.members.len(), 1);
    assert_eq!(e.members[0].id, "writer");
}

#[test]
fn imports_compact_manifest_without_agents_array() {
    let f = Fixture::new();
    let mut value = manifest();
    value.as_object_mut().unwrap().remove("agents");
    f.manifest(value);
    let expert = f.install().unwrap();
    assert_eq!(expert.members.len(), 2);
    assert_eq!(expert.members[1].agent_path, "agents/writer.md");
}

#[test]
fn rejects_missing_or_duplicate_members_before_install() {
    let f = Fixture::new();
    let mut m = manifest();
    m["teamInfo"]["memberAgents"] = serde_json::json!(["missing"]);
    f.manifest(m);
    assert!(f.install().unwrap_err().contains("未在 agents 中声明"));
    assert!(!f.0.join("installed/test-team").exists());
    let mut m = manifest();
    m["teamInfo"]["memberAgents"] = serde_json::json!(["lead"]);
    f.manifest(m);
    assert!(f.install().unwrap_err().contains("重复"));
}

#[test]
fn rejects_paths_from_either_platform() {
    for path in [
        "../escape.md",
        "..\\escape.md",
        "/tmp/a.md",
        "C:\\a.md",
        "\\\\server\\share\\a.md",
        "x/../../a.md",
    ] {
        assert!(relative_path(path).is_err(), "accepted {path}");
    }
    assert_eq!(
        relative_path(".\\agents\\writer.md").unwrap(),
        PathBuf::from("./agents/writer.md")
    );
}

#[test]
fn missing_skill_leaves_no_installed_directory() {
    let f = Fixture::new();
    let mut m = manifest();
    m["skills"] = serde_json::json!(["./skills/missing"]);
    f.manifest(m);
    assert!(f.install().is_err());
    assert!(!f.0.join("installed/test-team").exists());
}

#[cfg(unix)]
#[test]
fn rejects_symlinked_roles() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    f.manifest(manifest());
    fs::remove_file(f.0.join("source/agents/writer.md")).unwrap();
    symlink(
        f.0.join("source/agents/lead.md"),
        f.0.join("source/agents/writer.md"),
    )
    .unwrap();
    assert!(f.install().unwrap_err().contains("符号链接"));
}
