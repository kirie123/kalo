//! Unattended gateway sessions: startup, delivery and cleanup.

use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use crate::gateway::GatewayManager;
use crate::session::{PiProcess, SessionManager};

/// The gateway asked us to run an agent task: spawn a headless pi session
/// in `cwd`, wait for the engine's RPC loop (it silently drops commands
/// sent before that), then blind-send the prompt. Progress flows back to
/// the gateway through the normal event forwarding chain.
pub fn handle_session_request(app: &AppHandle, value: &serde_json::Value) {
    let task_id = value.get("taskId").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let mut cwd = value.get("cwd").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let prompt = value.get("prompt").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let model = value.get("model").and_then(|v| v.as_str()).map(String::from);
    let expert_id = value.get("expertId").and_then(|v| v.as_str()).map(String::from);

    let gateway = app.state::<GatewayManager>();
    let report_failure = |error: String| {
        let line = serde_json::json!({
            "cmd": "session_start_failed",
            "taskId": task_id,
            "error": error,
        });
        let _ = gateway.send(line.to_string());
    };

    if task_id.is_empty() || cwd.is_empty() || prompt.is_empty() {
        report_failure("session_request 缺少 taskId/cwd/prompt".into());
        return;
    }
    if model.as_deref().is_some_and(|value| value.split_once('/').map_or(true, |(provider, id)| provider.is_empty() || id.is_empty())) {
        report_failure("模型应为 provider/modelId，请修正后重试".into());
        return;
    }

    // Expert definitions supply identity/resources; task cwd supplies output location.
    let expert = match expert_id.as_deref() {
        Some(id) => match crate::experts::find(id) {
            Some(e) => {
                if e.contains_definition_path(std::path::Path::new(&cwd)) {
                    cwd = match crate::workspace::create_workspace() {
                        Ok(path) => path,
                        Err(error) => { report_failure(error); return; }
                    };
                }
                Some(e.ctx())
            }
            None => {
                report_failure(format!("专家不存在或已停用：{id}"));
                return;
            }
        },
        None => None,
    };

    let session_id = crate::gen_session_id();
    let mut process = match PiProcess::spawn(&session_id, &cwd, app.clone(), expert.as_ref(), true) {
        Ok(p) => p,
        Err(e) => {
            report_failure(e);
            return;
        }
    };
    process.source = "gateway".to_string();
    // Gateway sessions have nobody watching the screen: the ask_user tool must
    // not register itself. KALO_UNATTENDED=1 is read by the extension at load
    // time, before the first request is assembled. The env var is set in spawn.
    {
        let sessions = app.state::<SessionManager>();
        let Ok(mut map) = sessions.sessions.lock() else {
            report_failure("session manager lock poisoned".into());
            return;
        };
        map.insert(session_id.clone(), process);
    }
    // Probe readiness, then deliver the prompt. Runs on its own thread so
    // the gateway stdout reader is never blocked.
    let app = app.clone();
    thread::spawn(move || {
        if !wait_for_engine(&app, &session_id, Duration::from_secs(20)) {
            let _ = app.state::<GatewayManager>().send(serde_json::json!({
                "cmd": "session_start_failed", "taskId": task_id,
                "error": "引擎未能在 20 秒内就绪，请检查模型配置及引擎日志后重试",
            }).to_string());
            close_gateway_session(&app, &session_id);
            return;
        }
        let gateway = app.state::<GatewayManager>();
        let _ = gateway.send(serde_json::json!({
            "cmd": "session_started", "taskId": task_id, "sessionId": session_id,
        }).to_string());
        let sessions = app.state::<SessionManager>();
        let Ok(map) = sessions.sessions.lock() else {
            return;
        };
        let Some(process) = map.get(&session_id) else {
            return;
        };
        if let Some(model) = model.as_deref() {
            if let Some((provider, model_id)) = model.split_once('/') {
                let cmd = serde_json::json!({
                    "id": format!("sched-model-{session_id}"),
                    "type": "set_model",
                    "provider": provider,
                    "modelId": model_id,
                });
                if process.send(cmd.to_string()).is_err() {
                    gateway.forward_exit(&session_id, Some(1));
                    drop(map);
                    close_gateway_session(&app, &session_id);
                    return;
                }
            }
        }
        let cmd = serde_json::json!({
            "id": format!("sched-prompt-{session_id}"),
            "type": "prompt",
            "message": prompt,
        });
        if process.send(cmd.to_string()).is_err() {
            gateway.forward_exit(&session_id, Some(1));
            drop(map);
            close_gateway_session(&app, &session_id);
        }
    });
}

/// Only unattended processes can be closed through gateway messages.
pub fn close_gateway_session(app: &AppHandle, session_id: &str) {
    let sessions = app.state::<SessionManager>();
    let removed = {
        let Ok(mut map) = sessions.sessions.lock() else { return; };
        if map.get(session_id).is_some_and(|process| process.source == "gateway") {
            map.remove(session_id)
        } else { None }
    };
    if let Some(mut process) = removed { process.kill(); }
}

/// Deliver a follow-up prompt into a session that is already running.
///
/// This is the multi-turn path: the engine is past its readiness probe (it
/// answered an earlier prompt), so this sends directly instead of re-probing.
/// A missing/dead session is reported back rather than silently dropped —
/// the channel reacts by opening a fresh session, so the user's message is
/// never lost, only the conversation history is.
pub fn handle_session_prompt(app: &AppHandle, value: &serde_json::Value) {
    use std::sync::atomic::{AtomicU64, Ordering};
    static PROMPT_SEQ: AtomicU64 = AtomicU64::new(0);

    let session_id = value
        .get("sessionId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let prompt = value.get("prompt").and_then(|v| v.as_str()).unwrap_or("").to_string();

    let gateway = app.state::<GatewayManager>();
    let report_failure = |error: String| {
        let line = serde_json::json!({
            "cmd": "session_prompt_failed",
            "sessionId": session_id,
            "error": error,
        });
        let _ = gateway.send(line.to_string());
    };

    if session_id.is_empty() || prompt.is_empty() {
        report_failure("session_prompt 缺少 sessionId/prompt".into());
        return;
    }

    let sessions = app.state::<SessionManager>();
    let Ok(map) = sessions.sessions.lock() else {
        report_failure("session manager lock poisoned".into());
        return;
    };
    let Some(process) = map.get(&session_id) else {
        report_failure("会话已不存在".into());
        return;
    };
    let cmd = serde_json::json!({
        "id": format!("chat-prompt-{}", PROMPT_SEQ.fetch_add(1, Ordering::Relaxed)),
        "type": "prompt",
        "message": prompt,
    });
    if let Err(e) = process.send(cmd.to_string()) {
        report_failure(format!("会话已断开：{e}"));
    }
}

/// Retry `get_state` until the engine answers (exponential backoff +
/// jitter, mirroring the frontend's waitForEngine in chat-store.ts).
fn wait_for_engine(app: &AppHandle, session_id: &str, budget: Duration) -> bool {
    use std::sync::atomic::{AtomicU64, Ordering};
    static PROBE_SEQ: AtomicU64 = AtomicU64::new(0);

    let start = std::time::Instant::now();
    let mut delay = Duration::from_millis(250);
    while start.elapsed() < budget {
        let probe_id = format!("sched-probe-{}", PROBE_SEQ.fetch_add(1, Ordering::Relaxed));
        let sessions = app.state::<SessionManager>();
        let Some(rx) = sessions.register_probe(probe_id.clone()) else {
            return false;
        };
        {
            let Ok(map) = sessions.sessions.lock() else {
                sessions.unregister_probe(&probe_id);
                return false;
            };
            let Some(process) = map.get(session_id) else {
                sessions.unregister_probe(&probe_id);
                return false;
            };
            let cmd = serde_json::json!({ "id": probe_id, "type": "get_state" });
            if process.send(cmd.to_string()).is_err() {
                sessions.unregister_probe(&probe_id);
                return false;
            }
        }
        if rx.recv_timeout(Duration::from_secs(2)).is_ok() {
            return true;
        }
        sessions.unregister_probe(&probe_id);
        thread::sleep(delay);
        delay = (delay * 2).min(Duration::from_secs(2));
    }
    false
}
