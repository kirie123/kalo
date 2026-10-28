//! Personal data transfer commands; all data mutations run in an isolated startup mode.
mod archive;
mod plan;
mod platform;
mod references;
mod snapshot;
mod transaction;
mod types;

use std::fs::{self, File};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{AppHandle, Emitter, State};
use types::*;

// Fail closed until the profile lock and recovery inspection have succeeded.
static MAINTENANCE: AtomicBool = AtomicBool::new(true);

pub fn normal_only() -> TransferResult<()> {
    if MAINTENANCE.load(Ordering::SeqCst) {
        Err("数据管理维护模式中，请返回普通模式后再执行此操作".into())
    } else {
        Ok(())
    }
}

pub struct TransferState {
    _profile_lock: File,
    root: PathBuf,
    maintenance: bool,
    busy: Mutex<()>,
    recovery_error: Mutex<Option<String>>,
    leaving: AtomicBool,
}

impl TransferState {
    pub fn initialize() -> TransferResult<Self> {
        let root = platform::root()?;
        let lock = platform::profile_lock(&root)?;
        let inspection = transaction::pending(&root);
        let armed = platform::safe(&root, "transfers/maintenance")?.exists();
        let maintenance = armed || inspection.as_ref().map(|v| *v).unwrap_or(true);
        let error = if maintenance {
            transaction::recover(&root).err()
        } else {
            None
        };
        MAINTENANCE.store(maintenance, Ordering::SeqCst);
        Ok(Self {
            _profile_lock: lock,
            root,
            maintenance,
            busy: Mutex::new(()),
            recovery_error: Mutex::new(error),
            leaving: AtomicBool::new(false),
        })
    }
    pub fn maintenance(&self) -> bool {
        self.maintenance
    }
    fn require_maintenance(&self) -> TransferResult<()> {
        if self.leaving.load(Ordering::SeqCst) {
            return Err("正在返回 Kalo，请稍候".into());
        }
        if !self.maintenance {
            return Err("请先准备迁移，退出并重新打开 Kalo 进入数据管理".into());
        }
        if let Some(error) = self
            .recovery_error
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
        {
            return Err(format!("上次迁移尚未恢复：{error}"));
        }
        if transaction::pending(&self.root)? {
            return Err("存在未完成事务，请先点击重试恢复".into());
        }
        Ok(())
    }
    fn stage(&self, id: &str) -> TransferResult<PathBuf> {
        uuid::Uuid::parse_str(id).map_err(|_| "无效操作编号")?;
        platform::safe(&self.root, &format!("transfers/staging/{id}"))
    }
}

fn progress(app: &AppHandle) -> impl Fn(Progress) + '_ {
    |value| {
        let _ = app.emit("data-transfer-progress", value);
    }
}

#[tauri::command(async)]
pub fn data_transfer_status(state: State<TransferState>) -> TransferResult<Status> {
    Ok(Status {
        maintenance: state.maintenance,
        armed: platform::safe(&state.root, "transfers/maintenance")?.exists(),
        recovery_error: state
            .recovery_error
            .lock()
            .map_err(|e| e.to_string())?
            .clone(),
    })
}

#[tauri::command(async)]
pub fn data_transfer_arm(armed: bool, state: State<TransferState>) -> TransferResult<()> {
    normal_only()?;
    let _guard = state
        .busy
        .try_lock()
        .map_err(|_| "数据管理正在处理其他操作")?;
    let marker = platform::safe(&state.root, "transfers/maintenance")?;
    if armed {
        platform::atomic_write(&marker, b"1")?;
    } else if marker.exists() {
        fs::remove_file(marker).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command(async)]
pub fn data_transfer_leave(state: State<TransferState>, app: AppHandle) -> TransferResult<()> {
    let _guard = state.busy.try_lock().map_err(|_| "请等待当前操作完成")?;
    state.require_maintenance()?;
    let marker = platform::safe(&state.root, "transfers/maintenance")?;
    if marker.exists() {
        fs::remove_file(marker).map_err(|e| e.to_string())?;
    }
    state.leaving.store(true, Ordering::SeqCst);
    // Tauri starts the replacement process before exiting the old one. Release only
    // after the transfer gate has closed, so the new process can acquire the lock.
    fs2::FileExt::unlock(&state._profile_lock).map_err(|e| e.to_string())?;
    app.request_restart();
    Ok(())
}

#[tauri::command(async)]
pub fn data_transfer_recover(state: State<TransferState>) -> TransferResult<()> {
    if !state.maintenance {
        return Err("请先进入维护模式".into());
    }
    let _guard = state.busy.try_lock().map_err(|_| "请等待当前操作完成")?;
    let result = transaction::recover(&state.root);
    *state.recovery_error.lock().map_err(|e| e.to_string())? = result.clone().err();
    result
}

#[tauri::command(async)]
pub fn prepare_data_export(
    scopes: Scopes,
    state: State<TransferState>,
    app: AppHandle,
) -> TransferResult<Preview> {
    let _guard = state
        .busy
        .try_lock()
        .map_err(|_| "数据管理正在处理其他操作")?;
    state.require_maintenance()?;
    let id = uuid::Uuid::new_v4().to_string();
    let stage = state.stage(&id)?;
    fs::create_dir_all(&stage).map_err(|e| e.to_string())?;
    let result = (|| {
        let manifest = snapshot::create(&state.root, &stage, scopes, &progress(&app))?;
        let preview = Preview {
            operation_id: id.clone(),
            mode: "export".into(),
            manifest,
            items: vec![],
            revision: String::new(),
        };
        plan::save(&stage, &preview)?;
        Ok(preview)
    })();
    if result.is_err() {
        let _ = plan::clean_stage(&state.root, &id);
    }
    result
}

#[tauri::command(async)]
pub fn prepare_data_import(
    path: String,
    state: State<TransferState>,
    app: AppHandle,
) -> TransferResult<Preview> {
    let _guard = state
        .busy
        .try_lock()
        .map_err(|_| "数据管理正在处理其他操作")?;
    state.require_maintenance()?;
    let id = uuid::Uuid::new_v4().to_string();
    let stage = state.stage(&id)?;
    fs::create_dir_all(&stage).map_err(|e| e.to_string())?;
    let result = (|| {
        archive::unpack(std::path::Path::new(&path), &stage, &progress(&app))?;
        let preview = plan::build(&state.root, &stage, &id, &[])?;
        plan::save(&stage, &preview)?;
        Ok(preview)
    })();
    if result.is_err() {
        let _ = plan::clean_stage(&state.root, &id);
    }
    result
}

#[tauri::command(async)]
pub fn resolve_data_import(
    operation_id: String,
    decisions: Vec<Decision>,
    state: State<TransferState>,
) -> TransferResult<Preview> {
    let _guard = state
        .busy
        .try_lock()
        .map_err(|_| "数据管理正在处理其他操作")?;
    state.require_maintenance()?;
    let stage = state.stage(&operation_id)?;
    if plan::load(&stage)?.mode != "import" {
        return Err("此操作不是导入".into());
    }
    let preview = plan::build(&state.root, &stage, &operation_id, &decisions)?;
    plan::save(&stage, &preview)?;
    Ok(preview)
}

#[tauri::command(async)]
pub fn data_transfer_details(
    operation_id: String,
    path: String,
    state: State<TransferState>,
) -> TransferResult<serde_json::Value> {
    let _guard = state
        .busy
        .try_lock()
        .map_err(|_| "数据管理正在处理其他操作")?;
    state.require_maintenance()?;
    plan::details(&state.root, &state.stage(&operation_id)?, &path)
}

#[tauri::command(async)]
pub fn finish_data_export(
    operation_id: String,
    path: String,
    state: State<TransferState>,
    app: AppHandle,
) -> TransferResult<()> {
    let _guard = state
        .busy
        .try_lock()
        .map_err(|_| "数据管理正在处理其他操作")?;
    state.require_maintenance()?;
    let stage = state.stage(&operation_id)?;
    if plan::load(&stage)?.mode != "export" {
        return Err("此操作不是导出".into());
    }
    archive::pack(&stage, std::path::Path::new(&path), &progress(&app))?;
    plan::clean_stage(&state.root, &operation_id)
}

#[tauri::command(async)]
pub fn commit_data_import(
    operation_id: String,
    revision: String,
    state: State<TransferState>,
    app: AppHandle,
) -> TransferResult<Journal> {
    let _guard = state
        .busy
        .try_lock()
        .map_err(|_| "数据管理正在处理其他操作")?;
    state.require_maintenance()?;
    let stage = state.stage(&operation_id)?;
    let old = plan::load(&stage)?;
    if old.mode != "import" {
        return Err("此操作不是导入".into());
    }
    let decisions: Vec<_> = old
        .items
        .iter()
        .filter(|i| i.status == "conflict")
        .map(|i| Decision {
            path: i.source.clone(),
            choice: i.choice.clone(),
        })
        .collect();
    let current = plan::build(&state.root, &stage, &operation_id, &decisions)?;
    if current.revision != revision {
        plan::save(&stage, &current)?;
        return Err("文件发生变化，预览已过期。请重新检查冲突后再导入".into());
    }
    let result = transaction::commit(&state.root, &stage, &current, &progress(&app));
    if result.is_ok() {
        // The durable transaction already owns the backups and installed bytes.
        // Cleanup failure must not turn a committed import into a reported failure.
        if let Err(error) = plan::clean_stage(&state.root, &operation_id) {
            eprintln!("[data-transfer] 暂存清理未完成：{error}");
        }
    }
    if result.is_err() && transaction::pending(&state.root).unwrap_or(true) {
        *state.recovery_error.lock().map_err(|e| e.to_string())? =
            Some("导入未完成，请重试恢复".into());
    }
    result
}

#[tauri::command(async)]
pub fn cancel_data_transfer(
    operation_id: String,
    state: State<TransferState>,
) -> TransferResult<()> {
    let _guard = state
        .busy
        .try_lock()
        .map_err(|_| "提交期间不能取消，请等待完成")?;
    state.require_maintenance()?;
    plan::clean_stage(&state.root, &operation_id)
}

#[tauri::command(async)]
pub fn list_data_transfers(state: State<TransferState>) -> TransferResult<Vec<Journal>> {
    let _guard = state
        .busy
        .try_lock()
        .map_err(|_| "数据管理正在处理其他操作")?;
    transaction::history(&state.root)
}

#[tauri::command(async)]
pub fn undo_data_import(
    transaction_id: String,
    state: State<TransferState>,
) -> TransferResult<Journal> {
    let _guard = state.busy.try_lock().map_err(|_| "请等待当前操作完成")?;
    state.require_maintenance()?;
    let result = transaction::undo(&state.root, &transaction_id);
    if result.is_err() && transaction::pending(&state.root).unwrap_or(true) {
        *state.recovery_error.lock().map_err(|e| e.to_string())? =
            Some("撤销未完成，请重试恢复".into());
    }
    result
}

#[cfg(test)]
mod tests;
