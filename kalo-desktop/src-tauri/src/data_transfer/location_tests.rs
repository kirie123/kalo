use super::*;

struct Fixture {
    dir: PathBuf,
    home: PathBuf,
    source: PathBuf,
    parent: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("kalo-location-test-{}", uuid::Uuid::new_v4()));
        let home = dir.join("home");
        let source = dir.join("old/.kalo");
        let parent = dir.join("中文 target");
        for path in [&home, &source, &parent] {
            fs::create_dir_all(path).unwrap();
        }
        fs::create_dir_all(source.join("attachments/id")).unwrap();
        fs::write(
            source.join("attachments/id/图.bin"),
            vec![123u8; 2 * 1024 * 1024 + 1],
        )
        .unwrap();
        fs::write(source.join("auth.json"), b"private bytes\0unchanged").unwrap();
        Self {
            dir,
            home,
            source,
            parent,
        }
    }
    fn journal(&self) -> Journal {
        let id = uuid::Uuid::new_v4().to_string();
        Journal {
            stage: self.parent.join(format!(".kalo-moving-{id}")),
            backup: self
                .source
                .parent()
                .unwrap()
                .join(format!(".kalo-backup-{id}")),
            id,
            source: self.source.clone(),
            target: self.parent.join(".kalo"),
        }
    }
    fn write_journal(&self, j: &Journal) {
        platform::atomic_write(&journal_path(&self.home), &serde_json::to_vec(j).unwrap()).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // Remove only our known compatibility alias before recursively removing the fixture.
        if let Ok(Some(_)) = links::link_target(&self.source) {
            let _ = links::remove_alias(&self.source, &self.parent.join(".kalo"));
        }
        let _ = fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn entire_profile_moves_with_verified_bytes_backup_and_old_paths() {
    let f = Fixture::new();
    let mut lock = Some(platform::profile_lock(&f.source).unwrap());
    let external = f.dir.join("external");
    fs::create_dir(&external).unwrap();
    fs::write(external.join("keep"), b"outside").unwrap();
    links::alias(&external, &f.source.join("linked-environment")).unwrap();
    prepare(&f.source, Some(&f.parent)).unwrap();
    let moved = relocate(&f.source, &f.home, &|_| {}, || {
        lock.take();
        Ok(())
    })
    .unwrap();
    assert_eq!(
        fs::read(moved.root.join("auth.json")).unwrap(),
        b"private bytes\0unchanged"
    );
    assert_eq!(
        fs::read(moved.root.join("attachments/id/图.bin"))
            .unwrap()
            .len(),
        2 * 1024 * 1024 + 1
    );
    assert_eq!(
        fs::read(moved.root.join("linked-environment/keep")).unwrap(),
        b"outside"
    );
    assert!(links::link_target(&moved.root.join("linked-environment"))
        .unwrap()
        .is_some());
    assert!(!moved.root.join(REQUEST).exists());
    assert!(!moved.root.join("transfers/maintenance").exists());
    fs::write(moved.root.join("auth.json"), b"new").unwrap();
    assert_eq!(fs::read(f.source.join("auth.json")).unwrap(), b"new");
    assert_eq!(
        fs::read(moved.backup.join("auth.json")).unwrap(),
        b"private bytes\0unchanged"
    );
    assert_eq!(
        kalo_home::read_location(&f.home).unwrap().unwrap().root,
        moved.root
    );
    recover(&f.home).unwrap();
    // A second move preserves the chain of old absolute references.
    let next = f.dir.join("next");
    fs::create_dir(&next).unwrap();
    prepare(&moved.root, Some(&next)).unwrap();
    let twice = relocate(&moved.root, &f.home, &|_| {}, || Ok(())).unwrap();
    let old_attachment = f.source.join("attachments/id/图.bin");
    let mapped = twice.remap_reference(&old_attachment).unwrap();
    assert_eq!(mapped, twice.root.join("attachments/id/图.bin"));
    assert!(twice
        .remap_reference(&f.source.with_extension("unrelated").join("private"))
        .is_none());
    assert_eq!(
        fs::read(&mapped).unwrap(),
        fs::read(&old_attachment).unwrap()
    );
    assert_eq!(fs::read(f.source.join("auth.json")).unwrap(), b"new");
    links::remove_alias(&moved.root, &twice.root).unwrap();
    // Restore first-hop target for fixture cleanup.
    fs::rename(&twice.root, &moved.root).unwrap();
}

#[test]
fn rejects_existing_nested_and_alias_destinations_without_writing() {
    let f = Fixture::new();
    assert!(destination(&f.source, &f.source).is_err());
    assert!(destination(&f.source, f.source.parent().unwrap()).is_err());
    fs::create_dir(f.parent.join(".kalo")).unwrap();
    fs::write(f.parent.join(".kalo/keep"), b"untouched").unwrap();
    assert!(prepare(&f.source, Some(&f.parent)).is_err());
    assert_eq!(fs::read(f.parent.join(".kalo/keep")).unwrap(), b"untouched");
    assert!(!f.source.join(REQUEST).exists());
}

#[test]
fn changed_source_fails_verification_and_preserves_original() {
    let f = Fixture::new();
    let stage = f.parent.join("stage");
    fs::create_dir(&stage).unwrap();
    let entries = copy::inventory(&f.source, &|_| {}).unwrap();
    fs::write(f.source.join("auth.json"), b"external change").unwrap();
    assert!(copy::copy(&f.source, &stage, &entries, &|_| {}).is_err());
    assert_eq!(
        fs::read(f.source.join("auth.json")).unwrap(),
        b"external change"
    );
    assert!(kalo_home::read_location(&f.home).unwrap().is_none());
}

#[test]
fn interrupted_cutover_rolls_back_at_each_precommit_step() {
    for step in 0..5 {
        let f = Fixture::new();
        let j = f.journal();
        fs::create_dir(&j.stage).unwrap();
        fs::write(j.stage.join(OWNER), &j.id).unwrap();
        f.write_journal(&j);
        if step >= 1 {
            fs::rename(&j.stage, &j.target).unwrap();
        }
        if step >= 2 {
            fs::rename(&j.source, &j.backup).unwrap();
        }
        if step == 3 {
            links::alias(&j.target, &j.source).unwrap();
        }
        if step == 4 {
            fs::create_dir(&j.source).unwrap();
        }
        recover(&f.home).unwrap();
        recover(&f.home).unwrap();
        assert_eq!(
            fs::read(f.source.join("auth.json")).unwrap(),
            b"private bytes\0unchanged"
        );
        assert!(links::link_target(&f.source).unwrap().is_none());
        assert!(!j.target.exists());
        assert!(j.stage.exists());
    }
}

#[test]
fn interrupted_postcommit_keeps_new_root_and_repairs_missing_alias() {
    let f = Fixture::new();
    let j = f.journal();
    fs::create_dir(&j.target).unwrap();
    fs::write(j.target.join("new"), b"committed").unwrap();
    fs::rename(&j.source, &j.backup).unwrap();
    f.write_journal(&j);
    let location = Location {
        version: 1,
        root: j.target.clone(),
        backup: j.backup.clone(),
        aliases: vec![j.source.clone()],
    };
    platform::atomic_write(
        &kalo_home::location_file(&f.home),
        &serde_json::to_vec(&location).unwrap(),
    )
    .unwrap();
    recover(&f.home).unwrap();
    recover(&f.home).unwrap();
    assert_eq!(fs::read(f.source.join("new")).unwrap(), b"committed");
    assert!(j.backup.join("auth.json").is_file());
}

#[test]
fn recovery_never_overwrites_unrelated_files_and_locator_fails_closed() {
    let f = Fixture::new();
    let j = f.journal();
    fs::create_dir(&j.target).unwrap();
    fs::write(j.target.join("keep"), b"unrelated").unwrap();
    f.write_journal(&j);
    assert!(recover(&f.home).is_err());
    assert_eq!(fs::read(j.target.join("keep")).unwrap(), b"unrelated");
    assert!(journal_path(&f.home).exists());
    fs::write(kalo_home::location_file(&f.home), b"broken json").unwrap();
    assert!(kalo_home::read_location(&f.home).is_err());
}

#[test]
fn saved_location_survives_reload_overrides_env_and_missing_disk_fails_closed() {
    let f = Fixture::new();
    assert_eq!(
        kalo_home::startup_root(&f.home, None).unwrap(),
        f.home.join(".kalo")
    );
    assert_eq!(
        kalo_home::startup_root(&f.home, Some(&f.source)).unwrap(),
        f.source
    );
    let location = Location {
        version: 1,
        root: f.parent.clone(),
        backup: f.source.clone(),
        aliases: vec![f.source.clone()],
    };
    platform::atomic_write(
        &kalo_home::location_file(&f.home),
        &serde_json::to_vec(&location).unwrap(),
    )
    .unwrap();
    assert_eq!(
        kalo_home::startup_root(&f.home, Some(&f.source)).unwrap(),
        f.parent
    );
    assert_eq!(kalo_home::startup_root(&f.home, None).unwrap(), f.parent);
    fs::remove_dir(&f.parent).unwrap();
    assert!(kalo_home::startup_root(&f.home, Some(&f.source)).is_err());
    let invalid = Location {
        version: 1,
        root: "relative/.kalo".into(),
        backup: f.source.clone(),
        aliases: vec![],
    };
    platform::atomic_write(
        &kalo_home::location_file(&f.home),
        &serde_json::to_vec(&invalid).unwrap(),
    )
    .unwrap();
    assert!(kalo_home::startup_root(&f.home, None).is_err());
}

#[test]
fn exclusive_rename_and_application_lock_protect_existing_data() {
    let f = Fixture::new();
    let from = f.parent.join("from");
    let to = f.parent.join("to");
    fs::create_dir(&from).unwrap();
    fs::create_dir(&to).unwrap();
    fs::write(from.join("keep"), b"source").unwrap();
    assert!(links::rename_new(&from, &to).is_err());
    assert_eq!(fs::read(from.join("keep")).unwrap(), b"source");
    let held = lock(&f.home).unwrap();
    assert!(lock(&f.home).is_err());
    drop(held);
    assert!(lock(&f.home).is_ok());
}

#[test]
fn cutover_failure_restores_original_and_allows_retry() {
    let f = Fixture::new();
    prepare(&f.source, Some(&f.parent)).unwrap();
    let error = relocate(&f.source, &f.home, &|_| {}, || {
        Err("injected pre-move failure".into())
    })
    .unwrap_err();
    assert!(error.contains("injected pre-move failure"));
    assert_eq!(
        fs::read(f.source.join("auth.json")).unwrap(),
        b"private bytes\0unchanged"
    );
    assert!(!pending(&f.home));
    assert!(kalo_home::read_location(&f.home).unwrap().is_none());
    relocate(&f.source, &f.home, &|_| {}, || Ok(())).unwrap();
}

#[cfg(unix)]
#[test]
fn preserves_executable_modes_and_relative_symlinks() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let f = Fixture::new();
    fs::set_permissions(
        f.source.join("auth.json"),
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    symlink("auth.json", f.source.join("relative")).unwrap();
    prepare(&f.source, Some(&f.parent)).unwrap();
    let moved = relocate(&f.source, &f.home, &|_| {}, || Ok(())).unwrap();
    assert_eq!(
        fs::metadata(moved.root.join("auth.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(
        fs::read_link(moved.root.join("relative")).unwrap(),
        Path::new("auth.json")
    );
}

#[test]
#[ignore = "set KALO_RELOCATION_TEST_VOLUME to an existing folder on another local volume"]
fn relocate_across_volumes() {
    let f = Fixture::new();
    let base = PathBuf::from(
        std::env::var_os("KALO_RELOCATION_TEST_VOLUME").expect("test volume required"),
    );
    let base = links::canonical(&base).unwrap();
    let parent = base.join(format!(".kalo-volume-test-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&parent).unwrap();
    #[cfg(windows)]
    assert_ne!(
        links::canonical(&f.source).unwrap().components().next(),
        parent.components().next(),
        "choose a different volume"
    );
    #[cfg(unix)] {
        use std::os::unix::fs::MetadataExt;
        assert_ne!(fs::metadata(&f.source).unwrap().dev(), fs::metadata(&parent).unwrap().dev(), "choose a different volume");
    }
    prepare(&f.source, Some(&parent)).unwrap();
    let moved = relocate(&f.source, &f.home, &|_| {}, || Ok(())).unwrap();
    assert_eq!(
        fs::read(moved.root.join("auth.json")).unwrap(),
        fs::read(f.source.join("auth.json")).unwrap()
    );
    assert_eq!(
        fs::read(moved.root.join("attachments/id/图.bin"))
            .unwrap()
            .len(),
        2 * 1024 * 1024 + 1
    );
    links::remove_alias(&f.source, &moved.root).unwrap();
    // Delete only this test's newly created destination, never the selected volume folder.
    assert_eq!(
        links::canonical(&parent).unwrap().parent(),
        Some(base.as_path())
    );
    assert!(parent
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with(".kalo-volume-test-"));
    fs::remove_dir_all(&parent).unwrap();
}
