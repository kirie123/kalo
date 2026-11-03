//! Opt-in development acceptance driver; no model credentials and no WebView required.
use std::process::{Command, Stdio};

pub fn run() -> Result<(), String> {
    if std::env::var("KALO_INVESTMENT_ACCEPTANCE").as_deref() != Ok("1")
        || std::env::var_os("KALO_HOME").is_none()
    {
        return Err("验收必须显式设置 KALO_INVESTMENT_ACCEPTANCE=1 和隔离的 KALO_HOME".into());
    }
    let args: Vec<_> = std::env::args_os().collect();
    if args.len() != 4 {
        return Err("用法：--investment-acceptance <node 可执行文件> <验收脚本>".into());
    }
    if crate::data_transfer::data_root()? != std::path::PathBuf::from(std::env::var_os("KALO_HOME").ok_or("缺少隔离目录")?) {
        return Err("验收目录与应用数据目录不一致；请同时将 USERPROFILE/HOME 指向隔离测试目录".into());
    }
    let _profile = crate::data_transfer::TransferState::initialize()?;
    crate::data_transfer::normal_only()?;
    let manager = crate::investment::InvestmentManager::default();
    let mut driver = Command::new(&args[2]);
    driver.env(
        "KALO_INVESTMENT_ACCEPTANCE_ENGINE",
        crate::session::engine_binary_path()?,
    );
    driver
        .arg(&args[3])
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    let first =
        crate::investment_bridge::serve(manager.clone(), "acceptance-a".into(), &mut driver)?;
    let mut other = Command::new(&args[2]);
    let second =
        crate::investment_bridge::serve(manager.clone(), "acceptance-b".into(), &mut other)?;
    for (key, value) in other.get_envs() {
        if let Some(value) = value {
            driver.env(format!("{}_SECOND", key.to_string_lossy()), value);
        }
    }
    let exit = crate::proc::no_window(&mut driver)
        .status()
        .map_err(|e| e.to_string())?;
    let activity = manager.activity_snapshot()?;
    std::fs::write(
        crate::investment::root()?.join("acceptance-activity.json"),
        serde_json::to_vec_pretty(&activity).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    drop(first);
    drop(second);
    manager.shutdown();
    if exit.success() {
        Ok(())
    } else {
        Err(format!("投行验收失败：{exit}"))
    }
}
