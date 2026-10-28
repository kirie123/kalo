use super::*;
use std::io::Write;
use std::path::Path;

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("kalo-transfer-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn put(root: &Path, rel: &str, text: &str) {
    platform::write_new(&platform::safe(root, rel).unwrap(), text.as_bytes()).unwrap();
}
fn stage(root: &Path) -> (String, PathBuf) {
    let id = uuid::Uuid::new_v4().to_string();
    let path = root.join(format!("transfers/staging/{id}"));
    fs::create_dir_all(&path).unwrap();
    (id, path)
}

#[test]
fn roundtrip_attachments_metadata_empty_domains_reimport_and_undo() {
    let a = Temp::new();
    let b = Temp::new();
    let output = Temp::new();
    put(&a.0, "attachments/paste/chart.png", "image bytes");
    put(&a.0, "attachments/paste/chart-copy.bin", "image bytes");
    let image =
        a.0.join("attachments/paste/chart.png")
            .to_string_lossy()
            .replace('\\', "/");
    let note = format!("---\ntitle: 学习\ncustom: keep me\n---\n![image](<{image}>)\n[附件副本](../../attachments/paste/chart-copy.bin)\n");
    put(&a.0, "knowledge/研究/a.md", &note);
    put(
        &a.0,
        "memory/preference.md",
        "---\ntitle: 偏好\ncreated: 2020\n---\n中文回答\n",
    );
    fs::create_dir_all(a.0.join("knowledge/空分类")).unwrap();
    let (_, source) = stage(&a.0);
    let m = snapshot::create(
        &a.0,
        &source,
        Scopes {
            memory: true,
            notes: true,
        },
        &|_| {},
    )
    .unwrap();
    assert_eq!(m.entries.len(), 3);
    let archive_path = output.0.join("data.kalo-data.zip");
    archive::pack(&source, &archive_path, &|_| {}).unwrap();
    let (id, target) = stage(&b.0);
    archive::unpack(&archive_path, &target, &|_| {}).unwrap();
    let preview = plan::build(&b.0, &target, &id, &[]).unwrap();
    let journal = transaction::commit(&b.0, &target, &preview, &|_| {}).unwrap();
    let content = fs::read_to_string(b.0.join("knowledge/研究/a.md")).unwrap();
    assert!(content.contains("../../attachments/portable/"));
    assert!(content.contains("custom: keep me"));
    assert!(b.0.join("knowledge/空分类").is_dir());
    let (id2, target2) = stage(&b.0);
    archive::unpack(&archive_path, &target2, &|_| {}).unwrap();
    assert!(plan::build(&b.0, &target2, &id2, &[])
        .unwrap()
        .items
        .iter()
        .all(|i| i.status == "same"));
    transaction::undo(&b.0, &journal.id).unwrap();
    assert!(!b.0.join("knowledge/研究/a.md").exists());
    assert!(b.0.join("attachments/portable").exists());
}

#[test]
fn conflicts_preserve_local_memory_remap_note_links_and_are_idempotent() {
    let a = Temp::new();
    let b = Temp::new();
    put(&a.0, "knowledge/cards/a.md", "# incoming\n[next](b.md)\n");
    put(&a.0, "knowledge/cards/b.md", "# incoming b\n");
    put(&a.0, "memory/user.md", "---\ntitle: user\n---\nincoming\n");
    put(&b.0, "knowledge/cards/a.md", "# local\n");
    put(&b.0, "knowledge/cards/b.md", "# local b\n");
    put(&b.0, "memory/user.md", "---\ntitle: user\n---\nlocal\n");
    let (id, staging) = stage(&b.0);
    snapshot::create(
        &a.0,
        &staging,
        Scopes {
            memory: true,
            notes: true,
        },
        &|_| {},
    )
    .unwrap();
    let preview = plan::build(&b.0, &staging, &id, &[]).unwrap();
    assert!(preview.items.iter().all(|i| i.status == "conflict"));
    let memory = preview
        .items
        .iter()
        .find(|i| i.kind == Kind::Memory)
        .unwrap();
    assert!(memory.target.starts_with("transfers/conflicts/"));
    let a_path = preview
        .items
        .iter()
        .find(|i| i.source.ends_with("a.md"))
        .unwrap()
        .target
        .clone();
    let b_path = preview
        .items
        .iter()
        .find(|i| i.source.ends_with("b.md"))
        .unwrap()
        .target
        .clone();
    transaction::commit(&b.0, &staging, &preview, &|_| {}).unwrap();
    assert!(fs::read_to_string(b.0.join(&a_path))
        .unwrap()
        .contains(b_path.rsplit('/').next().unwrap()));
    assert!(fs::read_to_string(b.0.join("memory/user.md"))
        .unwrap()
        .contains("local"));
    let (id2, staging2) = stage(&b.0);
    snapshot::create(
        &a.0,
        &staging2,
        Scopes {
            memory: true,
            notes: true,
        },
        &|_| {},
    )
    .unwrap();
    let repeated = plan::build(&b.0, &staging2, &id2, &[]).unwrap();
    assert!(repeated.items.iter().all(|i| i.status == "same"));
}

#[test]
fn rejects_traversal_archive_and_corrupt_payload() {
    let t = Temp::new();
    let zip_path = t.0.join("bad.zip");
    let mut zip = zip::ZipWriter::new(File::create(&zip_path).unwrap());
    zip.start_file("../escape", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(b"bad").unwrap();
    zip.finish().unwrap();
    let (_, target) = stage(&t.0);
    assert!(archive::unpack(&zip_path, &target, &|_| {}).is_err());
    assert!(!t.0.join("escape").exists());
    let source = Temp::new();
    put(&source.0, "knowledge/cards/a.md", "a");
    let (_, snapshot_dir) = stage(&source.0);
    let m = snapshot::create(
        &source.0,
        &snapshot_dir,
        Scopes {
            memory: false,
            notes: true,
        },
        &|_| {},
    )
    .unwrap();
    fs::write(snapshot_dir.join("data/knowledge/cards/a.md"), b"corrupt").unwrap();
    assert!(archive::verify(&snapshot_dir, &m).is_err());
}

#[test]
fn export_refuses_missing_and_external_attachments() {
    let source = Temp::new();
    let external = Temp::new();
    put(&external.0, "secret.png", "secret");
    put(
        &source.0,
        "knowledge/cards/a.md",
        "![x](../../attachments/missing.png)",
    );
    let (_, target) = stage(&source.0);
    assert!(snapshot::create(
        &source.0,
        &target,
        Scopes {
            memory: false,
            notes: true
        },
        &|_| {}
    )
    .is_err());
    fs::write(
        source.0.join("knowledge/cards/a.md"),
        format!("![x](<{}>)", external.0.join("secret.png").display()),
    )
    .unwrap();
    let (_, target2) = stage(&source.0);
    assert!(snapshot::create(
        &source.0,
        &target2,
        Scopes {
            memory: false,
            notes: true
        },
        &|_| {}
    )
    .is_err());
}

#[test]
fn changed_targets_invalidate_preview_and_snapshot_detects_external_edits() {
    let a = Temp::new();
    let b = Temp::new();
    put(&a.0, "knowledge/cards/a.md", "incoming");
    put(&b.0, "knowledge/cards/a.md", "before");
    let (id, staging) = stage(&b.0);
    snapshot::create(
        &a.0,
        &staging,
        Scopes {
            memory: false,
            notes: true,
        },
        &|_| {},
    )
    .unwrap();
    let decisions = [Decision {
        path: "knowledge/cards/a.md".into(),
        choice: Choice::Replace,
    }];
    let initial = plan::build(&b.0, &staging, &id, &decisions).unwrap();
    fs::write(
        b.0.join("knowledge/cards/a.md"),
        "user changed after preview",
    )
    .unwrap();
    let next = plan::build(&b.0, &staging, &id, &decisions).unwrap();
    assert_ne!(initial.revision, next.revision);
    assert!(transaction::commit(&b.0, &staging, &initial, &|_| {}).is_err());
    assert_eq!(
        fs::read_to_string(b.0.join("knowledge/cards/a.md")).unwrap(),
        "user changed after preview"
    );
    let (_, export_stage) = stage(&a.0);
    let result = snapshot::create(
        &a.0,
        &export_stage,
        Scopes {
            memory: false,
            notes: true,
        },
        &|_| {
            fs::write(
                a.0.join("knowledge/cards/a.md"),
                "external edit during snapshot",
            )
            .unwrap();
        },
    );
    assert!(result.is_err());
}

#[test]
fn rejects_implicit_parent_case_collisions_and_prevents_duplicate_publication() {
    let a = Temp::new();
    let out = Temp::new();
    put(&a.0, "knowledge/Cards/a.md", "a");
    let (_, staging) = stage(&a.0);
    let mut manifest = snapshot::create(
        &a.0,
        &staging,
        Scopes {
            memory: false,
            notes: true,
        },
        &|_| {},
    )
    .unwrap();
    let mut extra = manifest.entries[0].clone();
    extra.path = "knowledge/cards/b.md".into();
    manifest.directories.clear();
    manifest.entries.push(extra);
    assert!(archive::validate_manifest(&manifest).is_err());
    let output = out.0.join("backup.zip");
    archive::pack(&staging, &output, &|_| {}).unwrap();
    let hash = platform::file_hash(&output).unwrap();
    assert!(archive::pack(&staging, &output, &|_| {}).is_err());
    assert_eq!(platform::file_hash(&output).unwrap(), hash);
}

#[test]
fn profile_lock_excludes_another_writer_until_release() {
    let t = Temp::new();
    let lock = platform::profile_lock(&t.0).unwrap();
    assert!(platform::profile_lock(&t.0).is_err());
    fs2::FileExt::unlock(&lock).unwrap();
    assert!(platform::profile_lock(&t.0).is_ok());
}
