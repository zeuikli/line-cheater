use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sha2::{Digest, Sha256};

const INVENTORY_TTL: Duration = Duration::from_secs(15 * 60);
const CACHE_ROOTS: [(&str, &str); 8] = [
    ("Sticker", "stickers"),
    ("Sticon", "sticons"),
    ("ChatEffect", "chat-effects"),
    ("bgChat", "chat-backgrounds"),
    ("advertisement", "advertisements"),
    ("resource", "resources"),
    ("sound", "sounds"),
    ("pizza", "media-cache"),
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Platform {
    Macos,
    Windows,
    Unsupported,
}

impl Platform {
    pub fn current() -> Self {
        match env::consts::OS {
            "macos" => Self::Macos,
            "windows" => Self::Windows,
            _ => Self::Unsupported,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Macos => "darwin",
            Self::Windows => "win32",
            Self::Unsupported => env::consts::OS,
        }
    }
}

#[derive(Clone, Debug)]
pub struct ProcessInfo {
    pub name: String,
    pub executable: PathBuf,
    pub pid: u32,
}

impl ProcessInfo {
    pub fn new(name: impl Into<String>, executable: impl Into<PathBuf>, pid: u32) -> Self {
        Self {
            name: name.into(),
            executable: executable.into(),
            pid,
        }
    }
}

pub fn is_recognized_line_process(platform: Platform, process: &ProcessInfo) -> bool {
    let executable = process.executable.to_string_lossy();
    match platform {
        Platform::Macos => {
            let helper = process.name == "LINE Helper"
                || (process.name.starts_with("LINE Helper (") && process.name.ends_with(')'));
            (process.name == "LINE" || helper)
                && executable.contains("/LINE.app/Contents/")
                && (executable.contains("/MacOS/") || executable.contains("/Frameworks/"))
        }
        Platform::Windows => {
            process.name.eq_ignore_ascii_case("LINE.exe")
                && (executable.as_ref().is_empty()
                    || executable.to_ascii_lowercase().contains("\\line\\")
                    || executable.to_ascii_lowercase().contains("/line/"))
        }
        Platform::Unsupported => false,
    }
}

pub fn discover_line_profile_from(
    platform: Platform,
    home: &Path,
    local_app_data: Option<&Path>,
    roaming_app_data: Option<&Path>,
) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    match platform {
        Platform::Macos => candidates.push(home.join(
            "Library/Containers/jp.naver.line.mac/Data/Library/Containers/jp.naver.line/Data",
        )),
        Platform::Windows => {
            for root in [local_app_data, roaming_app_data].into_iter().flatten() {
                candidates.push(root.join("LINE/Data"));
                candidates.push(root.join("LINE"));
            }
        }
        Platform::Unsupported => return None,
    }
    candidates.into_iter().find_map(|path| {
        let metadata = fs::symlink_metadata(&path).ok()?;
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            path.canonicalize().ok()
        } else {
            None
        }
    })
}

pub fn discover_line_profile() -> Option<PathBuf> {
    let home = env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })?;
    discover_line_profile_from(
        Platform::current(),
        Path::new(&home),
        env::var_os("LOCALAPPDATA").as_deref().map(Path::new),
        env::var_os("APPDATA").as_deref().map(Path::new),
    )
}

pub fn list_line_processes() -> Result<Vec<ProcessInfo>, String> {
    let platform = Platform::current();
    let processes = match platform {
        Platform::Macos => {
            let output = Command::new("/bin/ps")
                .args(["-axo", "pid=,comm="])
                .output()
                .map_err(|error| format!("無法檢查 LINE 執行狀態：{error}"))?;
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter_map(|line| {
                    let line = line.trim();
                    let split = line.find(char::is_whitespace)?;
                    let pid = line[..split].parse().ok()?;
                    let executable = line[split..].trim();
                    let name = Path::new(executable).file_name()?.to_string_lossy();
                    Some(ProcessInfo::new(name, executable, pid))
                })
                .collect()
        }
        Platform::Windows => {
            let output = Command::new("tasklist.exe")
                .args(["/FI", "IMAGENAME eq LINE.exe", "/FO", "CSV", "/NH"])
                .output()
                .map_err(|error| format!("無法檢查 LINE 執行狀態：{error}"))?;
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter_map(|line| {
                    let fields: Vec<_> = line.trim_matches('"').split("\",\"").collect();
                    Some(ProcessInfo::new(
                        *fields.first()?,
                        "",
                        fields.get(1)?.parse().ok()?,
                    ))
                })
                .collect()
        }
        Platform::Unsupported => Vec::new(),
    };
    Ok(processes
        .into_iter()
        .filter(|process| is_recognized_line_process(platform, process))
        .collect())
}

pub fn request_line_quit() -> Result<(), String> {
    match Platform::current() {
        Platform::Macos => {
            for process in list_line_processes()? {
                if process.pid > 1 {
                    let status = Command::new("/bin/kill")
                        .args(["-TERM", &process.pid.to_string()])
                        .status()
                        .map_err(|error| format!("無法要求 LINE 關閉：{error}"))?;
                    if !status.success() {
                        return Err("LINE 未接受關閉要求。".into());
                    }
                }
            }
        }
        Platform::Windows => {
            let status = Command::new("taskkill.exe")
                .args(["/IM", "LINE.exe"])
                .status()
                .map_err(|error| format!("無法要求 LINE 關閉：{error}"))?;
            if !status.success() && !list_line_processes()?.is_empty() {
                return Err("LINE 未接受關閉要求。".into());
            }
        }
        Platform::Unsupported => {}
    }
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupItem {
    pub id: String,
    pub name: String,
    pub relative_path: String,
    pub category: String,
    pub bytes: u64,
    pub modified_at: String,
}

#[derive(Clone, Serialize)]
pub struct CleanupTotals {
    pub files: usize,
    pub bytes: u64,
}

#[derive(Clone, Serialize)]
pub struct CloudCapability {
    pub supported: bool,
    #[serde(rename = "canClaimRemoteDeletion")]
    pub can_claim_remote_deletion: bool,
    pub reason: String,
}

fn cloud_capability() -> CloudCapability {
    CloudCapability {
        supported: false,
        can_claim_remote_deletion: false,
        reason: "LINE 沒有提供消費者聊天記錄的官方 authenticated deletion API；本機快取刪除不代表雲端刪除。".into(),
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupInventory {
    pub token: String,
    pub platform: String,
    pub profile_path: String,
    pub items: Vec<CleanupItem>,
    pub totals: CleanupTotals,
    pub cloud: CloudCapability,
}

#[derive(Clone)]
struct Record {
    public: CleanupItem,
    absolute_path: PathBuf,
    category_root: PathBuf,
    fingerprint: String,
}

struct StoredInventory {
    created_at: SystemTime,
    profile_root: PathBuf,
    records: HashMap<String, Record>,
}

#[derive(Serialize)]
pub struct LocalDeleteReport {
    pub deleted: usize,
    pub bytes: u64,
    pub failures: Vec<DeleteFailure>,
}

#[derive(Serialize)]
pub struct DeleteFailure {
    pub id: String,
    pub message: String,
}

#[derive(Serialize)]
pub struct CloudDeleteReport {
    pub status: String,
    pub deleted: usize,
    pub reason: String,
}

#[derive(Serialize)]
pub struct DeleteReport {
    pub local: LocalDeleteReport,
    pub cloud: CloudDeleteReport,
}

pub struct LocalCleanupManager {
    platform: Platform,
    profile_root: PathBuf,
    inventories: HashMap<String, StoredInventory>,
}

impl LocalCleanupManager {
    pub fn discover() -> Result<Self, String> {
        let root = discover_line_profile()
            .ok_or_else(|| "找不到可安全讀取的 LINE 桌面版資料夾。".to_string())?;
        Self::for_profile(Platform::current(), root)
    }

    pub fn for_profile(platform: Platform, root: impl AsRef<Path>) -> Result<Self, String> {
        let metadata = fs::symlink_metadata(root.as_ref())
            .map_err(|_| "找不到可安全讀取的 LINE 桌面版資料夾。".to_string())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("LINE 資料夾不是安全的實體資料夾。".into());
        }
        Ok(Self {
            platform,
            profile_root: root.as_ref().canonicalize().map_err(|e| e.to_string())?,
            inventories: HashMap::new(),
        })
    }

    pub fn profile_root(&self) -> &Path {
        &self.profile_root
    }

    pub fn scan(&mut self) -> Result<CleanupInventory, String> {
        self.scan_with(|| !list_line_processes().unwrap_or_default().is_empty())
    }

    pub fn scan_with(
        &mut self,
        line_running: impl Fn() -> bool,
    ) -> Result<CleanupInventory, String> {
        if line_running() {
            return Err("請先完全關閉 LINE，才能掃描或刪除本機資料。".into());
        }
        let mut records = Vec::new();
        for (directory, category) in CACHE_ROOTS {
            let root = self.profile_root.join(directory);
            let Ok(metadata) = fs::symlink_metadata(&root) else {
                continue;
            };
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                continue;
            }
            let Ok(root) = root.canonicalize() else {
                continue;
            };
            if !strictly_inside(&self.profile_root, &root) {
                continue;
            }
            walk_category(&self.profile_root, &root, category, &mut records)?;
        }
        if line_running() {
            return Err("掃描期間 LINE 已啟動，結果已取消。".into());
        }
        records.sort_by(|a, b| {
            b.public
                .bytes
                .cmp(&a.public.bytes)
                .then_with(|| a.public.relative_path.cmp(&b.public.relative_path))
        });
        let token = uuid::Uuid::new_v4().to_string();
        let totals = CleanupTotals {
            files: records.len(),
            bytes: records.iter().map(|record| record.public.bytes).sum(),
        };
        let items = records.iter().map(|record| record.public.clone()).collect();
        self.inventories.clear();
        self.inventories.insert(
            token.clone(),
            StoredInventory {
                created_at: SystemTime::now(),
                profile_root: self.profile_root.clone(),
                records: records
                    .into_iter()
                    .map(|record| (record.public.id.clone(), record))
                    .collect(),
            },
        );
        Ok(CleanupInventory {
            token,
            platform: self.platform.label().into(),
            profile_path: self.profile_root.display().to_string(),
            items,
            totals,
            cloud: cloud_capability(),
        })
    }

    pub fn delete(&mut self, token: &str, ids: &[String]) -> Result<DeleteReport, String> {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            self.delete_with(
                token,
                ids,
                || !list_line_processes().unwrap_or_default().is_empty(),
                |path| trash::delete(path).map_err(|error| error.to_string()),
            )
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = (token, ids);
            Err("手機版不提供桌面 LINE 快取清理。".into())
        }
    }

    pub fn delete_with<F>(
        &mut self,
        token: &str,
        ids: &[String],
        line_running: impl Fn() -> bool,
        mut trash_item: F,
    ) -> Result<DeleteReport, String>
    where
        F: FnMut(&Path) -> Result<(), String>,
    {
        if ids.is_empty() || ids.len() > 100_000 {
            return Err("請選擇至少一個且不超過十萬個檔案。".into());
        }
        let unique: HashSet<_> = ids.iter().collect();
        if unique.len() != ids.len()
            || ids
                .iter()
                .any(|id| id.len() != 64 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()))
        {
            return Err("本機清理選取項目無效。".into());
        }
        if line_running() {
            return Err("請先完全關閉 LINE，才能掃描或刪除本機資料。".into());
        }
        let inventory = self
            .inventories
            .get(token)
            .ok_or_else(|| "本機掃描結果已失效，請重新掃描後再刪除。".to_string())?;
        if inventory
            .created_at
            .elapsed()
            .unwrap_or(INVENTORY_TTL + Duration::from_secs(1))
            > INVENTORY_TTL
        {
            self.inventories.remove(token);
            return Err("本機掃描結果已失效，請重新掃描後再刪除。".into());
        }
        let records: Vec<_> = ids
            .iter()
            .map(|id| {
                inventory
                    .records
                    .get(id)
                    .cloned()
                    .ok_or_else(|| "選取的本機檔案不在目前掃描結果中。".to_string())
            })
            .collect::<Result<_, _>>()?;
        for record in &records {
            validate_unchanged(inventory, record)?;
        }
        let mut local = LocalDeleteReport {
            deleted: 0,
            bytes: 0,
            failures: Vec::new(),
        };
        for record in records {
            match trash_item(&record.absolute_path) {
                Ok(()) => {
                    local.deleted += 1;
                    local.bytes += record.public.bytes;
                }
                Err(message) => local.failures.push(DeleteFailure {
                    id: record.public.id,
                    message,
                }),
            }
        }
        self.inventories.remove(token);
        let cloud = cloud_capability();
        Ok(DeleteReport {
            local,
            cloud: CloudDeleteReport {
                status: "unsupported".into(),
                deleted: 0,
                reason: cloud.reason,
            },
        })
    }
}

fn walk_category(
    profile: &Path,
    category_root: &Path,
    category: &str,
    records: &mut Vec<Record>,
) -> Result<(), String> {
    let mut pending = vec![category_root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let metadata = fs::symlink_metadata(entry.path()).map_err(|error| error.to_string())?;
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                pending.push(entry.path());
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            let path = entry
                .path()
                .canonicalize()
                .map_err(|error| error.to_string())?;
            if !strictly_inside(category_root, &path) {
                continue;
            }
            let relative = path
                .strip_prefix(profile)
                .map_err(|_| "快取檔案超出 LINE 資料夾。")?;
            let relative_path = relative.to_string_lossy().replace('\\', "/");
            let fingerprint = metadata_fingerprint(&metadata)?;
            let mut hasher = Sha256::new();
            hasher.update(category.as_bytes());
            hasher.update([0]);
            hasher.update(relative_path.as_bytes());
            hasher.update([0]);
            hasher.update(fingerprint.as_bytes());
            let modified = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis().to_string())
                .unwrap_or_default();
            records.push(Record {
                public: CleanupItem {
                    id: format!("{:x}", hasher.finalize()),
                    name: path
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into(),
                    relative_path,
                    category: category.into(),
                    bytes: metadata.len(),
                    modified_at: modified,
                },
                absolute_path: path,
                category_root: category_root.to_path_buf(),
                fingerprint,
            });
        }
    }
    Ok(())
}

fn strictly_inside(root: &Path, candidate: &Path) -> bool {
    candidate != root && candidate.strip_prefix(root).is_ok()
}

fn metadata_fingerprint(metadata: &fs::Metadata) -> Result<String, String> {
    let modified = metadata
        .modified()
        .map_err(|error| error.to_string())?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?;
    #[cfg(unix)]
    let file_identity = {
        use std::os::unix::fs::MetadataExt;
        format!("{}:{}", metadata.dev(), metadata.ino())
    };
    #[cfg(windows)]
    let file_identity = {
        use std::os::windows::fs::MetadataExt;
        format!(
            "{}:{}",
            metadata.volume_serial_number().unwrap_or_default(),
            metadata.file_index().unwrap_or_default()
        )
    };
    #[cfg(not(any(unix, windows)))]
    let file_identity = "unsupported";
    Ok(format!(
        "{}:{}:{}:{}",
        file_identity,
        metadata.len(),
        modified.as_secs(),
        modified.subsec_nanos()
    ))
}

fn validate_unchanged(inventory: &StoredInventory, record: &Record) -> Result<(), String> {
    let metadata = fs::symlink_metadata(&record.absolute_path)
        .map_err(|_| "檔案在掃描後已變更，請重新掃描。".to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("檔案類型在掃描後已變更，請重新掃描。".into());
    }
    let real = record
        .absolute_path
        .canonicalize()
        .map_err(|_| "檔案在掃描後已變更，請重新掃描。".to_string())?;
    if !strictly_inside(&inventory.profile_root, &real)
        || !strictly_inside(&record.category_root, &real)
        || metadata_fingerprint(&metadata)? != record.fingerprint
    {
        return Err("檔案在掃描後已變更，請重新掃描。".into());
    }
    Ok(())
}
