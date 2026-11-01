//! Explicit, paid-model development smoke test through the production desktop host.
use serde_json::{json, Value};
use std::{path::PathBuf, thread, time::{Duration, Instant}};
use tauri::{AppHandle, Manager};

fn request(app: &AppHandle, value: Value) -> Result<Value, String> {
    let reply = crate::task_workers::workbench_request(value, app.clone(), app.state())?;
    if reply["ok"] != true { return Err(reply["error"].to_string()); }
    Ok(reply)
}

fn wait_for(app: &AppHandle, id: &str, expected: &str) -> Result<Value, String> {
    let started = Instant::now();
    loop {
        let reply = request(app, json!({"action":"list"}))?;
        let task = reply["tasks"].as_array().and_then(|tasks| tasks.iter().find(|t| t["id"] == id))
            .ok_or("验收任务丢失")?;
        let status = task["status"].as_str().unwrap_or("");
        if status == expected { return Ok(task.clone()); }
        if matches!(status, "failed" | "stopped") || started.elapsed() > Duration::from_secs(240) {
            return Err(format!("等待 {expected} 失败：{task}"));
        }
        thread::sleep(Duration::from_millis(500));
    }
}

fn run(app: &AppHandle, cwd: &std::path::Path, evidence: &mut Value) -> Result<(), String> {
    if !cwd.join("input.md").is_file() || cwd.join("delivery.md").exists() {
        return Err("请准备包含 input.md、尚无 delivery.md 的独立验收目录".into());
    }
    let prompt = "请处理本目录 input.md，交付 delivery.md 摘要。Router 请接单并交给 Worker。Worker 必须先读取 input.md，再用 task_ask 询问用户交付语言（中文或英文），收到回答之前禁止创建交付文件；恢复后遵循用户回答，保留原始核验标记，写出项目、里程碑与负责人，最后 task_report 交付实际文件。";
    let created = request(app, json!({"action":"create","actionId":crate::gen_session_id(),"cwd":cwd,"prompt":prompt,"allowShell":false}))?;
    let task = created["tasks"].as_array().and_then(|tasks| tasks.iter().find(|t| t["prompt"] == prompt && t["cwd"] == cwd.to_string_lossy().as_ref()))
        .ok_or("创建任务未返回记录")?;
    let id = task["id"].as_str().ok_or("缺少 taskId")?.to_string();
    evidence["taskId"] = json!(id);
    let waiting = wait_for(app, &id, "waiting")?;
    evidence["waiting"] = waiting.clone();
    let runs = waiting["runs"].as_array().ok_or("缺少运行记录")?;
    if runs.len() != 2 || !runs.iter().any(|r| r["role"] == "router") || !runs.iter().any(|r| r["role"] == "worker")
        || runs.iter().any(|r| r["status"] != "ended") || cwd.join("delivery.md").exists() {
        return Err("Router 接单 / Worker 追问隔离检查失败".into());
    }
    let session = waiting["sessionFile"].as_str().ok_or("Worker 未保存恢复会话")?;
    if !std::path::Path::new(session).is_file() { return Err("恢复会话文件不存在".into()); }
    eprintln!("[workbench-smoke] Router accepted; Worker asked; both processes exited");
    request(app, json!({"action":"answer","actionId":crate::gen_session_id(),"taskId":id,"questionId":waiting["question"]["id"],"answer":"中文；请在交付末尾加入验收暗号「青竹归档」。"}))?;
    let review = wait_for(app, &id, "review")?;
    evidence["review"] = review.clone();
    let runs = review["runs"].as_array().ok_or("恢复后运行记录缺失")?;
    if review["sessionFile"] != session || runs.len() != 3 || runs.iter().any(|r| r["status"] != "ended") {
        return Err("原会话恢复 / 新 Run / 进程收尾检查失败".into());
    }
    let delivery = std::fs::read_to_string(cwd.join("delivery.md")).map_err(|e| e.to_string())?;
    if !["KALO-LIVE-1101", "青竹归档", "纸鹤"].iter().all(|s| delivery.contains(s)) {
        return Err("交付文件缺少源资料或恢复后指令".into());
    }
    evidence["delivery"] = json!(delivery);
    request(app, json!({"action":"accept","actionId":crate::gen_session_id(),"taskId":id}))?;
    evidence["completed"] = wait_for(app, &id, "completed")?;
    let sessions = app.state::<crate::session::SessionManager>();
    let live = sessions.sessions.lock().map_err(|_| "会话锁损坏")?.values()
        .filter(|p| p.source == "workbench" && p.is_alive()).count();
    if live != 0 { return Err("验收结束仍有存活 Worker".into()); }
    evidence["liveWorkers"] = json!(live);
    Ok(())
}

pub fn start_if_requested(app: &AppHandle) {
    let args: Vec<String> = std::env::args().collect();
    let Some(index) = args.iter().position(|arg| arg == "--workbench-smoke") else { return; };
    let app = app.clone();
    let cwd = args.get(index + 1).map(PathBuf::from);
    thread::spawn(move || {
        let Some(cwd) = cwd.filter(|path| path.is_dir()) else {
            eprintln!("--workbench-smoke 需要已存在的临时工作目录"); app.exit(2); return;
        };
        let mut evidence = json!({"ok":false,"mode":"real-native-host","shellEnabled":false});
        let result = run(&app, &cwd, &mut evidence);
        evidence["ok"] = json!(result.is_ok());
        if let Err(error) = &result {
            evidence["error"] = json!(error);
            eprintln!("[workbench-smoke] {error}");
            if let Some(id) = evidence["taskId"].as_str() {
                let _ = request(&app, json!({"action":"stop","actionId":crate::gen_session_id(),"taskId":id}));
            }
        }
        let saved = std::fs::write(cwd.join("smoke-evidence.json"), serde_json::to_vec_pretty(&evidence).expect("serialize evidence"));
        eprintln!("[workbench-smoke] passed={} evidence_saved={}", result.is_ok(), saved.is_ok());
        app.exit(if result.is_ok() && saved.is_ok() { 0 } else { 1 });
    });
}
