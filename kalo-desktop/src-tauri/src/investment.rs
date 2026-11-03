//! Desktop adapter. Computation and data parsing live in kalo-investment.
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
};
use tauri::State;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub id: String,
    pub status: String,
    phase: String,
    error: Option<String>,
    pub result: Option<Value>,
}
struct Job {
    status: Status,
    child: Arc<Mutex<Child>>,
    owner: Option<String>,
    request_id: Option<String>,
    input: Vec<u8>,
}
#[derive(Clone, Default)]
pub struct InvestmentManager {
    jobs: Arc<Mutex<HashMap<String, Job>>>,
    activity: Arc<Mutex<Activity>>,
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    revision: u64,
    page: String,
    snapshot_id: Option<String>,
    report_id: Option<String>,
    days: Option<usize>,
    job_id: Option<String>,
    owner: Option<String>,
    dataset_id: Option<String>,
    script_report_id: Option<String>,
    margin_snapshot_id: Option<String>,
}
pub fn root() -> Result<std::path::PathBuf, String> {
    Ok(crate::data_transfer::data_root()?.join("investment"))
}

impl InvestmentManager {
    pub fn activity_snapshot(&self) -> Result<Value, String> {
        let activity = self.activity.lock().map_err(|_| "活动状态锁失败")?.clone();
        let jobs = self.jobs.lock().map_err(|_| "任务状态锁失败")?;
        let job = activity
            .job_id
            .as_ref()
            .and_then(|id| jobs.get(id))
            .or_else(|| jobs.values().find(|j| j.status.status == "running"))
            .map(|j| {
                let mut s = j.status.clone();
                s.result = None;
                s
            });
        Ok(serde_json::json!({"focus":activity,"job":job}))
    }
    pub fn release_owner(&self, owner: &str) {
        let ids: Vec<_> = self
            .jobs
            .lock()
            .map(|jobs| {
                jobs.values()
                    .filter(|j| j.owner.as_deref() == Some(owner))
                    .map(|j| j.status.id.clone())
                    .collect()
            })
            .unwrap_or_default();
        for id in ids {
            let _ = cancel(&id, self, Some(owner));
        }
        // Once the token is revoked no request can retry; retain results for panel restoration.
        if let Ok(mut jobs) = self.jobs.lock() {
            for job in jobs
                .values_mut()
                .filter(|j| j.owner.as_deref() == Some(owner))
            {
                job.owner = None;
            }
        }
    }
    pub fn focus(
        &self,
        page: &str,
        snapshot: Option<String>,
        report: Option<String>,
        days: Option<usize>,
        job: Option<String>,
        owner: Option<String>,
    ) {
        if let Ok(mut activity) = self.activity.lock() {
            *activity = Activity {
                revision: activity.revision + 1,
                page: page.into(),
                snapshot_id: snapshot,
                report_id: report,
                days,
                job_id: job,
                owner,
                dataset_id: None,
                script_report_id: None,
                margin_snapshot_id: None,
            };
        }
    }

    fn focus_code(&self, dataset: Option<String>, report: Option<String>, job: Option<String>, owner: Option<String>) {
        if let Ok(mut activity) = self.activity.lock() {
            *activity = Activity { revision: activity.revision + 1, page: "code".into(), dataset_id: dataset, script_report_id: report, job_id: job, owner, ..Default::default() };
        }
    }

    pub fn shutdown(&self) {
        if let Ok(jobs) = self.jobs.lock() {
            for job in jobs.values() {
                if job.status.status == "running" {
                    if let Ok(mut child) = job.child.lock() {
                        crate::proc::kill_tree(&mut child);
                    }
                }
            }
        }
    }
}

#[tauri::command(async)]
pub fn investment_start(
    request: kalo_investment::Request,
    state: State<InvestmentManager>,
) -> Result<String, String> {
    start(request, &state, None, None)
}

pub fn start(
    request: kalo_investment::Request,
    state: &InvestmentManager,
    owner: Option<String>,
    request_id: Option<String>,
) -> Result<String, String> {
    crate::data_transfer::normal_only()?;
    let root = root()?;
    let mut jobs = state.jobs.lock().map_err(|_| "任务状态锁失败")?;
    let input = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    if let Some(key) = request_id.as_ref() {
        if let Some(job) = jobs
            .values()
            .find(|j| j.owner == owner && j.request_id.as_ref() == Some(key))
        {
            return if job.input == input {
                Ok(job.status.id.clone())
            } else {
                Err("请求 ID 已用于不同参数，禁止重复执行".into())
            };
        }
        if jobs.values().filter(|j| j.owner == owner).count() >= 128 {
            return Err("本会话投行任务已达 128 个，请新建会话继续".into());
        }
    }
    if jobs.values().any(|j| j.status.status == "running") {
        return Err("已有投行任务正在运行，请等待或取消".into());
    }
    if jobs.len() > 20 {
        jobs.retain(|_, j| j.status.status == "running" || j.owner.is_some());
    }
    let mut command = Command::new(std::env::current_exe().map_err(|e| e.to_string())?);
    command
        .arg("--investment-worker")
        .env("KALO_INVESTMENT_WORKER_ROOT", &root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = crate::proc::no_window(&mut command)
        .spawn()
        .map_err(|e| format!("无法启动 Rust 计算进程：{e}"))?;
    let mut stdin = child.stdin.take().ok_or("无法打开工作进程输入")?;
    if let Err(e) = stdin.write_all(&input) {
        crate::proc::kill_tree(&mut child);
        return Err(e.to_string());
    }
    drop(stdin);
    let stdout = child.stdout.take().ok_or("无法读取计算结果")?;
    let stderr = child.stderr.take().ok_or("无法读取计算进度")?;
    let id = uuid::Uuid::new_v4().to_string();
    let child = Arc::new(Mutex::new(child));
    jobs.insert(
        id.clone(),
        Job {
            status: Status {
                id: id.clone(),
                status: "running".into(),
                phase: "启动 Rust 工作进程".into(),
                error: None,
                result: None,
            },
            child: child.clone(),
            owner: owner.clone(),
            request_id,
            input,
        },
    );
    drop(jobs);
    let (page, snapshot_id) = match &request {
        kalo_investment::Request::Sync {} => ("data", None),
        kalo_investment::Request::MarginSync {} => ("margin", None),
        kalo_investment::Request::Backtest { spec } => ("backtest", Some(spec.snapshot_id.clone())),
        kalo_investment::Request::MarketSync { .. } | kalo_investment::Request::ScriptBacktest { .. } => ("code", None),
    };
    state.focus(page, snapshot_id, None, None, Some(id.clone()), owner);
    let state_jobs = state.jobs.clone();
    let run_id = id.clone();
    let progress = std::thread::spawn(move || {
        let mut last = String::new();
        for line in BufReader::new(stderr).lines().take(1000) {
            if let Ok(line) = line {
                last = line.chars().take(2000).collect();
                if let Ok(mut jobs) = state_jobs.lock() {
                    if let Some(job) = jobs.get_mut(&run_id) {
                        if job.status.status == "running" {
                            job.status.phase = last.clone();
                        }
                    }
                }
            }
        }
        last
    });
    let state_jobs = state.jobs.clone();
    let run_id = id.clone();
    let manager = state.clone();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let read = stdout.take(16_000_001).read_to_end(&mut bytes);
        let exit = crate::proc::wait_released(&child);
        let message = progress.join().unwrap_or_default();
        if let Ok(mut jobs) = state_jobs.lock() {
            if let Some(job) = jobs.get_mut(&run_id) {
                if job.status.status == "cancelled" {
                    return;
                }
                if exit == Some(0) && read.is_ok() && bytes.len() <= 16_000_000 {
                    match serde_json::from_slice(&bytes) {
                        Ok(result) => match kalo_investment::commit(&root, &result) {
                            Ok(()) => {
                                job.status.status = "completed".into();
                                job.status.phase = "完成并保存".into();
                                job.status.result = Some(result);
                            }
                            Err(e) => {
                                job.status.status = "failed".into();
                                job.status.error = Some(e);
                            }
                        },
                        Err(e) => {
                            job.status.status = "failed".into();
                            job.status.error = Some(format!("结果格式无效：{e}"));
                        }
                    }
                } else {
                    job.status.status = "failed".into();
                    job.status.error = Some(if message.is_empty() {
                        "计算进程异常退出，请重新运行".into()
                    } else {
                        message
                    });
                }
                let result = job.status.result.as_ref();
                if page == "margin" {
                    if let Ok(mut activity) = manager.activity.lock() {
                        *activity = Activity { revision: activity.revision + 1, page: "margin".into(), margin_snapshot_id: result.and_then(|r| r["id"].as_str()).map(str::to_owned), job_id: Some(run_id.clone()), owner: job.owner.clone(), ..Default::default() };
                    }
                    return;
                }
                if page == "code" {
                    manager.focus_code(
                        result.and_then(|r| if r["kind"] == "scriptReport" { r["spec"]["datasetId"].as_str() } else { r["id"].as_str() }).map(str::to_owned),
                        result.filter(|r| r["kind"] == "scriptReport").and_then(|r|r["id"].as_str()).map(str::to_owned),
                        Some(run_id.clone()), job.owner.clone());
                    return;
                }
                let report = result.filter(|r| r.get("spec").is_some());
                manager.focus(
                    if report.is_some() { "backtest" } else { page },
                    result
                        .and_then(|r| {
                            r.get("spec")
                                .map(|s| &s["snapshotId"])
                                .or_else(|| r.get("id"))
                        })
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    report.and_then(|r| r["id"].as_str()).map(str::to_owned),
                    None,
                    Some(run_id.clone()),
                    job.owner.clone(),
                );
            }
        }
    });
    Ok(id)
}
#[tauri::command]
pub fn investment_status(id: String, state: State<InvestmentManager>) -> Result<Status, String> {
    status(&id, &state, None)
}
pub fn status(id: &str, state: &InvestmentManager, owner: Option<&str>) -> Result<Status, String> {
    state
        .jobs
        .lock()
        .map_err(|_| "任务状态锁失败")?
        .get(id)
        .filter(|j| owner.is_none() || j.owner.as_deref() == owner)
        .map(|j| j.status.clone())
        .ok_or("任务不存在；请在历史报告查看已完成结果".into())
}
#[tauri::command(async)]
pub fn investment_cancel(id: String, state: State<InvestmentManager>) -> Result<(), String> {
    cancel(&id, &state, None)
}
pub fn cancel(id: &str, state: &InvestmentManager, owner: Option<&str>) -> Result<(), String> {
    let mut jobs = state.jobs.lock().map_err(|_| "任务状态锁失败")?;
    let job = jobs
        .get_mut(id)
        .filter(|j| owner.is_none() || j.owner.as_deref() == owner)
        .ok_or("任务不存在或不属于本会话")?;
    if job.status.status != "running" {
        return Ok(());
    }
    let mut child = job.child.lock().map_err(|_| "计算进程锁失败")?;
    if child.try_wait().map_err(|e| e.to_string())?.is_some() {
        return Ok(());
    }
    job.status.status = "cancelled".into();
    job.status.phase = "已取消".into();
    crate::proc::kill_tree(&mut child);
    state.focus("data", None, None, None, Some(id.into()), job.owner.clone());
    Ok(())
}
#[tauri::command(async)]
pub fn investment_catalog() -> Result<Value, String> {
    kalo_investment::storage::catalog(&root()?)
}

#[tauri::command]
pub fn investment_activity(state: State<InvestmentManager>) -> Result<Value, String> {
    state.activity_snapshot()
}
