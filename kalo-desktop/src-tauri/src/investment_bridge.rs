//! Session-scoped loopback transport. No filesystem paths or executable commands on the wire.
use crate::investment::{self, InvestmentManager};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::Manager;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    version: u8,
    id: String,
    token: String,
    command: Operation,
}
#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
enum Operation {
    Catalog {},
    Flows {
        #[serde(rename = "snapshotId")]
        snapshot_id: String,
        days: usize,
    },
    Start {
        request: kalo_investment::Request,
    },
    Status {
        #[serde(rename = "jobId")]
        job_id: String,
    },
    Cancel {
        #[serde(rename = "jobId")]
        job_id: String,
    },
}

pub struct BridgeLease {
    pub stopped: Arc<AtomicBool>,
}
impl Drop for BridgeLease {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
    }
}

pub fn attach(
    app: &tauri::AppHandle,
    session: &str,
    command: &mut Command,
) -> Result<BridgeLease, String> {
    let manager = app.state::<InvestmentManager>().inner().clone();
    serve(manager, session.to_owned(), command)
}

pub(crate) fn serve(
    manager: InvestmentManager,
    owner: String,
    command: &mut Command,
) -> Result<BridgeLease, String> {
    let listener =
        TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("投行工具连接启动失败：{e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = uuid::Uuid::new_v4().to_string();
    command
        .env("KALO_INVESTMENT_PORT", port.to_string())
        .env("KALO_INVESTMENT_TOKEN", &token);
    let stopped = Arc::new(AtomicBool::new(false));
    let stop = stopped.clone();
    std::thread::spawn(move || {
        while !stop.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((mut socket, _)) => {
                    let _ = socket.set_read_timeout(Some(Duration::from_secs(10)));
                    let _ = socket.set_write_timeout(Some(Duration::from_secs(10)));
                    let response = exchange(&mut socket, &token, &owner, &manager, &stop);
                    let bytes = serde_json::to_vec(&response).unwrap_or_default();
                    if bytes.len() <= 16_000_000 {
                        let _ = socket
                            .write_all(&bytes)
                            .and_then(|_| socket.write_all(b"\n"));
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(50))
                }
                Err(_) => break,
            }
        }
        manager.release_owner(&owner);
    });
    Ok(BridgeLease { stopped })
}

fn exchange(
    socket: &mut TcpStream,
    token: &str,
    owner: &str,
    manager: &InvestmentManager,
    stopped: &AtomicBool,
) -> Value {
    let mut bytes = Vec::new();
    let result = BufReader::new(socket.take(65_537)).read_until(b'\n', &mut bytes);
    let envelope = if result.is_err() || bytes.len() > 65_536 || bytes.last() != Some(&b'\n') {
        Err("请求超时、过大或缺少换行".into())
    } else {
        decode(&bytes, token)
    };
    match envelope {
        Ok(e) => {
            let result = if stopped.load(Ordering::SeqCst) {
                Err("会话已关闭".into())
            } else {
                dispatch(e.command, &e.id, owner, manager)
            };
            match result {
                Ok(result) => json!({"version":1,"id":e.id,"ok":true,"result":result}),
                Err(error) => json!({"version":1,"id":e.id,"ok":false,"error":error}),
            }
        }
        Err(error) => json!({"version":1,"ok":false,"error":error}),
    }
}

fn decode(bytes: &[u8], token: &str) -> Result<Envelope, String> {
    let e: Envelope = serde_json::from_slice(bytes).map_err(|_| "投行请求格式无效")?;
    if e.version != 1 || e.token != token || e.id.is_empty() || e.id.len() > 128 {
        return Err("投行连接版本、凭据或请求 ID 无效".into());
    }
    Ok(e)
}

fn dispatch(
    operation: Operation,
    request_id: &str,
    owner: &str,
    manager: &InvestmentManager,
) -> Result<Value, String> {
    crate::data_transfer::normal_only()?;
    match operation {
        Operation::Catalog {} => {
            let catalog = kalo_investment::storage::catalog(&investment::root()?)?;
            let snapshots = catalog["snapshots"]
                .as_array()
                .ok_or("快照目录格式错误")?
                .iter()
                .map(kalo_investment::analysis::compact_result)
                .collect::<Result<Vec<_>, _>>()?;
            let reports = catalog["reports"]
                .as_array()
                .ok_or("报告目录格式错误")?
                .iter()
                .map(kalo_investment::analysis::compact_result)
                .collect::<Result<Vec<_>, _>>()?;
            Ok(json!({"snapshots":snapshots,"reports":reports}))
        }
        Operation::Flows { snapshot_id, days } => {
            let snapshot =
                kalo_investment::storage::read(&investment::root()?, "snapshots", &snapshot_id)?;
            let result = kalo_investment::analysis::flows(&snapshot, days)?;
            manager.focus(
                "flows",
                Some(snapshot_id),
                None,
                Some(days),
                None,
                Some(owner.into()),
            );
            Ok(result)
        }
        Operation::Start { request } => {
            let id = investment::start(
                request,
                manager,
                Some(owner.into()),
                Some(request_id.into()),
            )?;
            Ok(json!({"jobId":id}))
        }
        Operation::Status { job_id } => {
            let mut status = investment::status(&job_id, manager, Some(owner))?;
            status.result = status
                .result
                .as_ref()
                .map(kalo_investment::analysis::compact_result)
                .transpose()?;
            serde_json::to_value(status).map_err(|e| e.to_string())
        }
        Operation::Cancel { job_id } => {
            investment::cancel(&job_id, manager, Some(owner))?;
            Ok(json!({"jobId":job_id,"cancelRequested":true}))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_wrong_token_version_unknown_fields_and_commands() {
        let valid =
            json!({"version":1,"id":"test","token":"secret","command":{"operation":"catalog"}});
        assert!(decode(valid.to_string().as_bytes(), "secret").is_ok());
        assert!(decode(valid.to_string().as_bytes(), "other").is_err());
        let mut unknown = valid.clone();
        unknown["command"] = json!({"operation":"start","request":{"operation":"sync","url":"https://invalid.example"}});
        assert!(decode(unknown.to_string().as_bytes(), "secret").is_err());
        for (key, value) in [
            ("version", json!(2)),
            ("extra", json!(true)),
            ("id", json!("")),
            ("command", json!({"operation":"shell"})),
            ("command", json!({"operation":"catalog", "extra":true})),
        ] {
            let mut bad = valid.clone();
            bad[key] = value;
            assert!(decode(bad.to_string().as_bytes(), "secret").is_err());
        }
    }
}
