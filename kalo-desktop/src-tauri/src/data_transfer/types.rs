use serde::{Deserialize, Serialize};

pub type TransferResult<T> = Result<T, String>;
pub const MAX_FILE: u64 = 512 * 1024 * 1024;
pub const MAX_TOTAL: u64 = 5 * 1024 * 1024 * 1024;
pub const MAX_ENTRIES: usize = 100_000;
pub const MAX_MANIFEST: u64 = 16 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Memory,
    Archive,
    Note,
    Domain,
    Attachment,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub kind: Kind,
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scopes {
    pub memory: bool,
    pub notes: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub format: String,
    pub format_version: u32,
    pub export_id: String,
    pub exported_at_ms: u64,
    pub app_version: String,
    pub scopes: Scopes,
    pub directories: Vec<String>,
    pub entries: Vec<Entry>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Choice {
    KeepBoth,
    KeepLocal,
    Replace,
    Stage,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Decision {
    pub path: String,
    pub choice: Choice,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    pub source: String,
    pub target: String,
    pub kind: Kind,
    pub status: String,
    pub choice: Choice,
    pub incoming_hash: String,
    pub local_hash: Option<String>,
    pub before_hash: Option<String>,
    pub after_hash: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub operation_id: String,
    pub mode: String,
    pub manifest: Manifest,
    pub items: Vec<PlanItem>,
    pub revision: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Journal {
    pub id: String,
    pub created_at_ms: u64,
    pub state: String,
    pub items: Vec<PlanItem>,
    pub directories: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub maintenance: bool,
    pub armed: bool,
    pub recovery_error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub phase: String,
    pub completed: usize,
    pub total: usize,
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
