//! Task-owned pi processes. The gateway owns business state; this host owns OS processes.
use crate::gateway::GatewayManager;
use crate::session::{PiProcess, SessionManager, TaskLaunch};
use std::collections::HashSet;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

#[derive(Default)]
pub struct TaskWorkers {
    starting: Mutex<HashSet<String>>,
    cancelled: Mutex<HashSet<String>>,
    prompted: Mutex<HashSet<String>>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Start {
    run_id: String,
    task_id: String,
    role: String,
    cwd: String,
    endpoint: String,
    token: String,
    session_file: Option<String>,
    allow_shell: bool,
    /// Effective tool allowlist computed by the gateway. Absent from an older gateway: the
    /// engine falls back to its built-in list and the gateway gate still enforces.
    #[serde(default)]
    tools: Vec<String>,
}

fn reply(app: &AppHandle, value: serde_json::Value) {
    if let Err(error) = app.state::<GatewayManager>().send(value.to_string()) {
        eprintln!("[task-worker] reply failed: {error}");
    }
}

fn valid_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-')
}

pub fn handle(app: &AppHandle, value: &serde_json::Value) {
    match value.get("type").and_then(|v| v.as_str()) {
        Some("task_worker_inspect") => {
            let workers = app.state::<TaskWorkers>();
            let mut ids: HashSet<String> = workers
                .starting
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone();
            if let Ok(sessions) = app.state::<SessionManager>().sessions.lock() {
                for (id, process) in sessions.iter() {
                    if process.source == "workbench" && process.is_alive() {
                        if let Some(run) = id.strip_prefix("workbench-") {
                            ids.insert(run.to_string());
                        }
                    }
                }
            }
            reply(
                app,
                serde_json::json!({"cmd":"task_worker_inventory", "runIds":ids}),
            );
        }
        Some("task_worker_cancel") => {
            let Some(run_id) = value
                .get("runId")
                .and_then(|v| v.as_str())
                .filter(|v| valid_id(v))
            else {
                return;
            };
            app.state::<TaskWorkers>()
                .cancelled
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(run_id.into());
            let app = app.clone();
            let run_id = run_id.to_string();
            thread::spawn(move || cancel(&app, &run_id));
        }
        Some("task_worker_start") => {
            let Ok(start) = serde_json::from_value::<Start>(value.clone()) else {
                return;
            };
            if !valid_id(&start.run_id) || !valid_id(&start.task_id) {
                return;
            }
            // Claim synchronously: duplicate deliveries cannot release another launch's slot.
            if !app
                .state::<TaskWorkers>()
                .starting
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(start.run_id.clone())
            {
                return;
            }
            let app = app.clone();
            thread::spawn(move || {
                let result = launch(&app, &start);
                app.state::<TaskWorkers>()
                    .starting
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&start.run_id);
                if let Err(error) = result {
                    // Once a process exists, report the error through its run then await real exit.
                    let id = format!("workbench-{}", start.run_id);
                    let exists = app
                        .state::<SessionManager>()
                        .sessions
                        .lock()
                        .map(|m| m.contains_key(&id))
                        .unwrap_or(true);
                    if exists {
                        reply(
                            &app,
                            serde_json::json!({"cmd":"event", "sessionId":id,"cwd":start.cwd,
                            "payload":{"type":"response","success":false,"error":error}}),
                        );
                        cancel(&app, &start.run_id);
                    } else {
                        reply(
                            &app,
                            serde_json::json!({"cmd":"task_worker_failed","runId":start.run_id,"error":error}),
                        );
                    }
                }
            });
        }
        Some("task_worker_prompt") => {
            let Some(run_id) = value
                .get("runId")
                .and_then(|v| v.as_str())
                .filter(|v| valid_id(v))
            else {
                return;
            };
            let Some(prompt) = value.get("prompt").and_then(|v| v.as_str()) else {
                return;
            };
            let workers = app.state::<TaskWorkers>();
            if workers
                .cancelled
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .contains(run_id)
            {
                return;
            }
            if !workers
                .prompted
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(run_id.into())
            {
                return;
            }
            let id = format!("workbench-{run_id}");
            let result = app.state::<SessionManager>().sessions.lock().map_err(|_| "会话锁损坏".to_string()).and_then(|map| {
                let process = map.get(&id).filter(|p| p.source == "workbench" && p.is_alive()).ok_or("任务执行器已关闭")?;
                process.send(serde_json::json!({"id":format!("task-prompt-{run_id}"),"type":"prompt","message":prompt}).to_string())
            });
            if let Err(error) = result {
                reply(
                    app,
                    serde_json::json!({"cmd":"event", "sessionId":id,"cwd":"",
                    "payload":{"type":"response","success":false,"error":error}}),
                );
                let app = app.clone();
                let run_id = run_id.to_string();
                thread::spawn(move || cancel(&app, &run_id));
            }
        }
        _ => {}
    }
}

fn cancel(app: &AppHandle, run_id: &str) {
    let id = format!("workbench-{run_id}");
    let sessions = app.state::<SessionManager>();
    let mut map = sessions.sessions.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(process) = map.get_mut(&id) {
        if process.source == "workbench" {
            process.kill();
            // Exit watcher acknowledges actual exit; retain until then for inventory.
            if !process.is_alive() {
                map.remove(&id);
            }
        }
    } else if !app
        .state::<TaskWorkers>()
        .starting
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .contains(run_id)
    {
        reply(
            app,
            serde_json::json!({"cmd":"session_exit","sessionId":id,"code":null}),
        );
    }
}

/// Called by the exit watcher; release registry resources even when kill was asynchronous.
pub(crate) fn cleanup_exited(app: &AppHandle, session_id: &str) {
    if !session_id.starts_with("workbench-") {
        return;
    }
    let sessions = app.state::<SessionManager>();
    let mut map = sessions.sessions.lock().unwrap_or_else(|p| p.into_inner());
    if map
        .get(session_id)
        .is_some_and(|p| p.source == "workbench" && !p.is_alive())
    {
        map.remove(session_id);
    }
}

fn launch(app: &AppHandle, start: &Start) -> Result<(), String> {
    let workers = app.state::<TaskWorkers>();
    if workers
        .cancelled
        .lock()
        .map_err(|_| "Worker 取消锁损坏")?
        .contains(&start.run_id)
    {
        return Err("执行已取消".into());
    }
    let id = format!("workbench-{}", start.run_id);
    {
        let sessions = app.state::<SessionManager>();
        let map = sessions.sessions.lock().map_err(|_| "会话锁损坏")?;
        if map.contains_key(&id) {
            return Ok(());
        }
    }
    if !matches!(start.role.as_str(), "orchestrator" | "router" | "worker") {
        return Err("未知任务角色".into());
    }
    let port = start
        .endpoint
        .strip_prefix("http://127.0.0.1:")
        .and_then(|v| v.parse::<u16>().ok());
    if port == Some(0) || port.is_none() || !valid_id(&start.token) {
        return Err("无效的任务控制端点".into());
    }
    let cwd = std::fs::canonicalize(&start.cwd).map_err(|e| format!("无法打开任务目录：{e}"))?;
    if !cwd.is_dir() {
        return Err("任务工作目录不是目录".into());
    }
    let session_dir = crate::pi_config::agent_dir()?
        .join("task-sessions")
        .join(&start.task_id);
    std::fs::create_dir_all(&session_dir).map_err(|e| format!("无法创建任务会话目录：{e}"))?;
    if let Some(file) = &start.session_file {
        let path = std::fs::canonicalize(file).map_err(|e| format!("无法恢复原会话：{e}"))?;
        let root = std::fs::canonicalize(&session_dir).map_err(|e| e.to_string())?;
        if !path.starts_with(root) || !path.is_file() {
            return Err("恢复路径不属于会话目录".into());
        }
    }
    if !start
        .tools
        .iter()
        .all(|t| !t.is_empty() && t.len() <= 40 && t.bytes().all(|c| c.is_ascii_lowercase() || c == b'_'))
    {
        return Err("无效的任务工具清单".into());
    }
    let launch = TaskLaunch {
        role: start.role.clone(),
        endpoint: start.endpoint.clone(),
        token: start.token.clone(),
        session_file: start.session_file.clone(),
        session_dir,
        allow_shell: start.allow_shell,
        tools: start.tools.clone(),
    };
    let mut process = PiProcess::spawn_task(&id, &start.cwd, app.clone(), &launch)?;
    process.source = "workbench".into();
    app.state::<SessionManager>()
        .sessions
        .lock()
        .map_err(|_| "会话锁损坏")?
        .insert(id.clone(), process);
    if workers
        .cancelled
        .lock()
        .map_err(|_| "Worker 取消锁损坏")?
        .contains(&start.run_id)
    {
        return Err("执行已取消".into());
    }
    if !crate::gateway_sessions::wait_for_engine(app, &id, Duration::from_secs(30)) {
        return Err("任务引擎未就绪，请重建引擎 sidecar 后重试".into());
    }
    if workers
        .cancelled
        .lock()
        .map_err(|_| "Worker 取消锁损坏")?
        .contains(&start.run_id)
    {
        return Err("执行已取消".into());
    }
    reply(
        app,
        serde_json::json!({"cmd":"task_worker_started","runId":start.run_id}),
    );
    Ok(())
}

#[tauri::command(async)]
pub fn workbench_request(
    request: serde_json::Value,
    app: AppHandle,
    gateway: State<GatewayManager>,
) -> Result<serde_json::Value, String> {
    crate::data_transfer::normal_only()?;
    gateway.job_request(
        &app,
        serde_json::json!({"cmd":"workbench_request","request":request}),
        Duration::from_secs(15),
    )
}
