pub mod local_cleanup;

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, UNIX_EPOCH};

use line_backup_native::{CancellationToken, NativeSession};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use sha2::Digest;
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::{DialogExt, FilePath, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_fs::{FsExt, OpenOptions};
use tauri_plugin_opener::OpenerExt;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use local_cleanup::LocalCleanupManager;

const CACHE_VERSION_FILE: &str = ".line-cheater-cache-version";
const SESSION_MARKER_FILE: &str = ".line-cheater-session";
const MAX_DISCOVERED_SESSIONS: usize = 100;

#[derive(Default)]
struct RuntimeState {
    session: Mutex<Option<NativeSession>>,
    local_cleanup: Mutex<Option<LocalCleanupManager>>,
    shell: Mutex<ShellState>,
    active_cancellation: Mutex<Option<CancellationToken>>,
}

#[derive(Default)]
struct ShellState {
    source: Option<PathBuf>,
    work_dir: Option<PathBuf>,
    outputs: HashMap<String, AuthorizedOutput>,
    candidate_finalization_pending: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum OutputKind {
    Candidate,
    Attachments,
    Conversation,
}

#[derive(Clone)]
struct AuthorizedOutput {
    kind: OutputKind,
    staged_path: PathBuf,
    destination: Option<FilePath>,
    display_name: String,
}

#[tauri::command]
fn platform_capabilities() -> Value {
    let mobile = cfg!(mobile);
    json!({
        "platform": std::env::consts::OS,
        "desktopLocalCleanup": {
            "supported": !mobile && matches!(std::env::consts::OS, "macos" | "windows"),
            "migrationState": "native-rust"
        },
        "mobileImport": {
            "supported": mobile,
            "mode": "user-selected-backup",
            "canReadLineContainer": false,
            "reason": "iOS and Android sandbox other applications' private containers."
        },
        "cloudDeletion": {
            "supported": false,
            "canClaimRemoteDeletion": false,
            "reason": "LINE does not provide an authenticated consumer message deletion API."
        }
    })
}

#[tauri::command]
async fn native_request(
    app: tauri::AppHandle,
    method: String,
    mut params: Value,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        native_request_blocking(&app, &method, &mut params)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn native_request_blocking(
    app: &tauri::AppHandle,
    method: &str,
    params: &mut Value,
) -> Result<Value, String> {
    let state = app.state::<RuntimeState>();
    let authorized = authorize_request_output(&state, method, params)?;
    let job_id = matches!(
        method,
        "scanCatalog"
            | "searchMessages"
            | "applyCleanupPlan"
            | "exportAttachments"
            | "exportAttachmentsFiltered"
            | "exportConversation"
            | "buildCandidate"
    )
    .then(|| uuid::Uuid::new_v4().to_string());
    if let Some(job_id) = job_id.as_ref() {
        app.emit(
            "line-native:event",
            json!({ "event": "operationStarted", "method": method, "jobId": job_id }),
        )
        .map_err(|error| error.to_string())?;
    }
    let mut session_guard = state
        .session
        .lock()
        .map_err(|_| "The native session lock is unavailable.".to_string())?;
    let session = session_guard
        .as_mut()
        .ok_or_else(|| "請先選擇並開啟 LINE 備份。".to_string())?;
    let cancellation = begin_cancellable_operation(&state)?;
    let event_app = app.clone();
    let operation = line_backup_native::invoke_streaming_cancellable(
        session,
        method,
        params.take(),
        job_id,
        cancellation.clone(),
        move |event| {
            let _ = event_app.emit("line-native:event", event);
        },
    );
    end_cancellable_operation(&state, &cancellation);
    if operation
        .as_ref()
        .is_err_and(|error| format!("{error:#}").contains("operation_cancelled"))
    {
        let _ = line_backup_native::invoke(session, "recoverInterruptedOperations", json!({}));
    }
    drop(session_guard);
    let mut result = match operation {
        Ok(result) => result,
        Err(error) => {
            cleanup_failed_output(&state, authorized.as_ref());
            return Err(format!("{error:#}"));
        }
    };
    finish_authorized_output(app, &state, method, authorized, &mut result)?;
    Ok(result)
}

fn begin_cancellable_operation(
    state: &State<'_, RuntimeState>,
) -> Result<CancellationToken, String> {
    let mut active = state
        .active_cancellation
        .lock()
        .map_err(|_| "取消操作狀態鎖定失敗。")?;
    if active.is_some() {
        return Err("已有原生操作正在執行。".into());
    }
    let token = CancellationToken::new();
    *active = Some(token.clone());
    Ok(token)
}

fn end_cancellable_operation(state: &State<'_, RuntimeState>, token: &CancellationToken) {
    if let Ok(mut active) = state.active_cancellation.lock()
        && active
            .as_ref()
            .is_some_and(|current| current.same_operation(token))
    {
        *active = None;
    }
}

#[tauri::command]
fn cancel_operation(state: State<'_, RuntimeState>) -> Result<Value, String> {
    let active = state
        .active_cancellation
        .lock()
        .map_err(|_| "取消操作狀態鎖定失敗。")?
        .clone();
    if let Some(token) = active {
        token.cancel();
        Ok(json!({ "cancelRequested": true }))
    } else {
        Ok(json!({ "cancelRequested": false }))
    }
}

fn cleanup_failed_output(
    state: &State<'_, RuntimeState>,
    authorized: Option<&(String, AuthorizedOutput)>,
) {
    let Some((token, output)) = authorized else {
        return;
    };
    if let Ok(mut shell) = state.shell.lock() {
        shell.outputs.remove(token);
    }
    let partial = PathBuf::from(format!("{}.partial", output.staged_path.display()));
    if partial.is_dir() {
        let _ = fs::remove_dir_all(partial);
    } else {
        let _ = fs::remove_file(partial);
    }
    if output.destination.is_some() {
        if output.staged_path.is_dir() {
            let _ = fs::remove_dir_all(&output.staged_path);
        } else {
            let _ = fs::remove_file(&output.staged_path);
        }
    }
}

#[tauri::command]
fn local_cleanup_status() -> Result<Value, String> {
    let profile = local_cleanup::discover_line_profile();
    let line_running = !local_cleanup::list_line_processes()?.is_empty();
    let capabilities = platform_capabilities();
    Ok(json!({
        "supported": matches!(local_cleanup::Platform::current(), local_cleanup::Platform::Macos | local_cleanup::Platform::Windows),
        "profileFound": profile.is_some(),
        "profilePath": profile.as_ref().map(|path| path.display().to_string()).unwrap_or_default(),
        "lineRunning": line_running,
        "capabilities": capabilities,
    }))
}

#[tauri::command]
fn scan_local_cleanup(state: State<'_, RuntimeState>) -> Result<Value, String> {
    let mut guard = state
        .local_cleanup
        .lock()
        .map_err(|_| "本機清理狀態鎖定失敗。")?;
    let mut manager = LocalCleanupManager::discover()?;
    let inventory = manager.scan()?;
    *guard = Some(manager);
    serde_json::to_value(inventory).map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_local_selection(
    app: tauri::AppHandle,
    state: State<'_, RuntimeState>,
    token: String,
    item_ids: Vec<String>,
) -> Result<Option<Value>, String> {
    let confirmed = app.dialog()
        .message(format!("確定處理選取的 {} 個本機檔案嗎？\n\n這只會清除這台電腦的可重建快取，不會刪除 LINE 雲端、手機或聊天對象的副本；檔案會移到系統垃圾桶。", item_ids.len()))
        .title("確認將本機 LINE 快取移到垃圾桶")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("了解限制並移到垃圾桶".into(), "取消".into()))
        .blocking_show();
    if !confirmed {
        return Ok(None);
    }
    let mut guard = state
        .local_cleanup
        .lock()
        .map_err(|_| "本機清理狀態鎖定失敗。")?;
    let manager = guard
        .as_mut()
        .ok_or_else(|| "請先重新掃描本機 LINE 資料。".to_string())?;
    serde_json::to_value(manager.delete(&token, &item_ids)?)
        .map(Some)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_sessions(app: tauri::AppHandle) -> Result<Vec<Value>, String> {
    let root = managed_sessions_root(&app)?;
    let mut sessions = Vec::new();
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(sessions),
        Err(error) => return Err(error.to_string()),
    };
    for entry in entries
        .flatten()
        .filter(|entry| valid_session_id(&entry.file_name().to_string_lossy()))
        .take(MAX_DISCOVERED_SESSIONS)
    {
        if let Ok(Some(session)) = read_saved_session(&app, &entry.file_name().to_string_lossy()) {
            sessions.push(session);
        }
    }
    sessions.sort_by(|left, right| {
        right["reusable"]
            .as_bool()
            .cmp(&left["reusable"].as_bool())
            .then_with(|| {
                right["scanCompletedAt"]
                    .as_i64()
                    .cmp(&left["scanCompletedAt"].as_i64())
            })
            .then_with(|| right["updatedAt"].as_i64().cmp(&left["updatedAt"].as_i64()))
    });
    Ok(sessions)
}

#[tauri::command]
async fn open_saved_session(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<Option<Value>, String> {
    let state = app.state::<RuntimeState>();
    let cancellation = begin_cancellable_operation(&state)?;
    let operation_cancellation = cancellation.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = operation_cancellation.run(|| {
            let saved = read_saved_session(&app, &session_id)
                .map_err(anyhow::Error::msg)?
                .ok_or_else(|| anyhow::anyhow!("找不到指定的 Session。"))?;
            if saved["reusable"].as_bool() != Some(true) {
                anyhow::bail!(
                    "無法直接載入這個 Session：{}。",
                    saved["unavailableReason"]
                        .as_str()
                        .unwrap_or("Session 不完整")
                );
            }
            let source = PathBuf::from(
                saved["sourcePath"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Session 來源路徑無效。"))?,
            );
            let work_dir = managed_session_path(&app, &session_id).map_err(anyhow::Error::msg)?;
            open_source_at_work_dir(&app, source, work_dir, true, &operation_cancellation)
                .map_err(anyhow::Error::msg)
        });
        end_cancellable_operation(&app.state::<RuntimeState>(), &operation_cancellation);
        result.map_err(|error| format!("{error:#}"))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn delete_saved_session(
    app: tauri::AppHandle,
    state: State<'_, RuntimeState>,
    session_id: String,
) -> Result<Value, String> {
    let saved = read_saved_session(&app, &session_id)?
        .ok_or_else(|| "找不到指定的 Session。".to_string())?;
    let work_dir = managed_session_path(&app, &session_id)?;
    let active = state
        .shell
        .lock()
        .map_err(|_| "備份外殼狀態鎖定失敗。")?
        .work_dir
        .as_ref()
        .is_some_and(|active| active == &work_dir);
    if active {
        *state.session.lock().map_err(|_| "備份工作階段鎖定失敗。")? = None;
        let mut shell = state.shell.lock().map_err(|_| "備份外殼狀態鎖定失敗。")?;
        shell.source = None;
        shell.work_dir = None;
        shell.outputs.clear();
    }
    validate_managed_session_directory(&app, &work_dir)?;
    fs::remove_dir_all(&work_dir).map_err(|error| format!("無法刪除分析 Session：{error}"))?;
    Ok(json!({
        "deleted": true,
        "activeSessionClosed": active,
        "sourcePath": saved["sourcePath"],
        "sessionPath": work_dir.display().to_string(),
        "warning": ""
    }))
}

#[tauri::command]
async fn select_source(app: tauri::AppHandle, kind: String) -> Result<Option<Value>, String> {
    if !matches!(kind.as_str(), "directory" | "archive" | "sqlite") {
        return Err("備份來源類型無效。".into());
    }
    if cfg!(mobile) && kind == "directory" {
        return Err("手機版只能由系統檔案選擇器匯入 .imazingapp 或 SQLite 備份檔。".into());
    }
    let dialog = app.dialog().file().set_title("選擇 LINE 備份");
    #[cfg(mobile)]
    let selected = if kind == "sqlite" {
        dialog
            .add_filter("SQLite", &["sqlite", "db"])
            .blocking_pick_file()
    } else {
        dialog
            .add_filter("iMazing App Data", &["imazingapp"])
            .blocking_pick_file()
    };
    #[cfg(not(mobile))]
    let selected = if kind == "directory" {
        dialog.blocking_pick_folder()
    } else if kind == "sqlite" {
        dialog
            .add_filter("SQLite", &["sqlite", "db"])
            .blocking_pick_file()
    } else {
        dialog
            .add_filter("iMazing App Data", &["imazingapp"])
            .blocking_pick_file()
    };
    let Some(selected) = selected else {
        return Ok(None);
    };
    let state = app.state::<RuntimeState>();
    let cancellation = begin_cancellable_operation(&state)?;
    let app_for_open = app.clone();
    let operation_cancellation = cancellation.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = operation_cancellation.run(|| {
            open_selected_source(
                app_for_open.clone(),
                selected,
                &kind,
                &operation_cancellation,
            )
            .map_err(anyhow::Error::msg)
        });
        end_cancellable_operation(
            &app_for_open.state::<RuntimeState>(),
            &operation_cancellation,
        );
        result.map_err(|error| format!("{error:#}"))
    })
    .await
    .map_err(|error| error.to_string())?
}

fn open_selected_source(
    app: tauri::AppHandle,
    selected: FilePath,
    kind: &str,
    cancellation: &CancellationToken,
) -> Result<Option<Value>, String> {
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
    let source = if cfg!(mobile) {
        stage_selected_mobile_file(&app, selected, &data_dir, kind, cancellation)?
    } else {
        selected
            .into_path()
            .map_err(|_| "系統選取的備份不是可讀取的本機路徑。".to_string())?
    };
    let identity = format!(
        "{:x}",
        sha2::Sha256::digest(source.to_string_lossy().as_bytes())
    );
    let work_dir = data_dir.join("sessions").join(identity);
    let reuse_catalog = prepare_managed_session_directory(&app, &work_dir)?;
    open_source_at_work_dir(&app, source, work_dir, reuse_catalog, cancellation)
}

fn open_source_at_work_dir(
    app: &tauri::AppHandle,
    source: PathBuf,
    work_dir: PathBuf,
    reuse_catalog: bool,
    cancellation: &CancellationToken,
) -> Result<Option<Value>, String> {
    let event_app = app.clone();
    let mut session =
        NativeSession::open_streaming(&source, &work_dir, reuse_catalog, move |event| {
            let _ = event_app.emit("line-native:event", event);
        })
        .map_err(|error| format!("{error:#}"))?;
    line_backup_native::invoke(&mut session, "recoverInterruptedOperations", json!({}))
        .map_err(|error| format!("{error:#}"))?;
    if cancellation.is_cancelled() {
        return Err("operation_cancelled".into());
    }
    let ready = session.ready_info().map_err(|error| format!("{error:#}"))?;
    *app.state::<RuntimeState>()
        .session
        .lock()
        .map_err(|_| "備份工作階段鎖定失敗。")? = Some(session);
    let state = app.state::<RuntimeState>();
    let mut shell = state.shell.lock().map_err(|_| "備份外殼狀態鎖定失敗。")?;
    shell.source = Some(source);
    shell.work_dir = Some(work_dir.clone());
    shell.outputs.clear();
    shell.candidate_finalization_pending = false;
    Ok(Some(ready))
}

fn managed_sessions_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|path| path.join("sessions"))
        .map_err(|error| error.to_string())
}

fn valid_session_id(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn managed_session_path(app: &tauri::AppHandle, session_id: &str) -> Result<PathBuf, String> {
    if !valid_session_id(session_id) {
        return Err("Session ID 無效。".into());
    }
    Ok(managed_sessions_root(app)?.join(session_id))
}

fn prepare_managed_session_directory(
    app: &tauri::AppHandle,
    work_dir: &Path,
) -> Result<bool, String> {
    let name = work_dir
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Session 路徑無效。".to_string())?;
    if managed_session_path(app, name)? != work_dir {
        return Err("拒絕建立非受管的 Session 路徑。".into());
    }
    let version_path = work_dir.join(CACHE_VERSION_FILE);
    let current = fs::read_to_string(&version_path)
        .ok()
        .is_some_and(|version| version.trim() == env!("CARGO_PKG_VERSION"));
    if work_dir.exists() && !current {
        let metadata = fs::symlink_metadata(work_dir).map_err(|error| error.to_string())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("拒絕覆寫未通過驗證的 Session 路徑。".into());
        }
        fs::remove_dir_all(work_dir).map_err(|error| error.to_string())?;
    }
    fs::create_dir_all(work_dir).map_err(|error| error.to_string())?;
    fs::write(
        work_dir.join(CACHE_VERSION_FILE),
        format!("{}\n", env!("CARGO_PKG_VERSION")),
    )
    .map_err(|error| error.to_string())?;
    fs::write(work_dir.join(SESSION_MARKER_FILE), b"1\n").map_err(|error| error.to_string())?;
    Ok(current)
}

fn validate_managed_session_directory(
    app: &tauri::AppHandle,
    work_dir: &Path,
) -> Result<(), String> {
    let name = work_dir
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Session 路徑無效。".to_string())?;
    if managed_session_path(app, name)? != work_dir {
        return Err("拒絕處理非受管的 Session 路徑。".into());
    }
    let metadata = fs::symlink_metadata(work_dir).map_err(|error| error.to_string())?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || !work_dir.join(SESSION_MARKER_FILE).is_file()
        || !work_dir.join(CACHE_VERSION_FILE).is_file()
    {
        return Err("Session 路徑未通過安全驗證。".into());
    }
    Ok(())
}

fn read_saved_session(app: &tauri::AppHandle, session_id: &str) -> Result<Option<Value>, String> {
    let work_dir = managed_session_path(app, session_id)?;
    if !work_dir.exists() {
        return Ok(None);
    }
    validate_managed_session_directory(app, &work_dir)?;
    let catalog_path = work_dir.join("catalog.sqlite");
    let catalog_metadata =
        fs::symlink_metadata(&catalog_path).map_err(|error| error.to_string())?;
    if !catalog_metadata.is_file() || catalog_metadata.file_type().is_symlink() {
        return Ok(None);
    }
    let database = Connection::open_with_flags(&catalog_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| error.to_string())?;
    let mut statement = database
        .prepare("SELECT key, value FROM meta")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?;
    let mut meta = HashMap::new();
    for row in rows {
        let (key, value) = row.map_err(|error| error.to_string())?;
        meta.insert(key, value);
    }
    drop(statement);
    let attachment_count = database
        .query_row(
            "SELECT COUNT(*) FROM files WHERE attachment_kind IS NOT NULL",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?
        .max(0) as u64;
    let source_path = PathBuf::from(meta.get("source_path").cloned().unwrap_or_default());
    let source_kind = match meta.get("source_kind").map(String::as_str) {
        Some("Directory") => "directory",
        Some("ImazingArchive") => "archive",
        Some("Sqlite") => "sqlite",
        _ => return Ok(None),
    };
    let expected_id = format!(
        "{:x}",
        sha2::Sha256::digest(source_path.to_string_lossy().as_bytes())
    );
    if expected_id != session_id {
        return Err("Session 來源與受管路徑不一致。".into());
    }
    let source_metadata = fs::metadata(&source_path).ok();
    let source_exists = source_metadata.as_ref().is_some_and(|metadata| {
        if source_kind == "directory" {
            metadata.is_dir()
        } else {
            metadata.is_file()
        }
    });
    let source_current = if source_exists && source_kind != "directory" {
        meta.get("source_fingerprint")
            .zip(source_metadata.as_ref())
            .map(|(stored, metadata)| file_source_fingerprint(metadata) == *stored)
    } else {
        None
    };
    let cache_version = fs::read_to_string(work_dir.join(CACHE_VERSION_FILE))
        .unwrap_or_default()
        .trim()
        .to_string();
    let scan_status = meta
        .get("scan_status")
        .map(String::as_str)
        .unwrap_or("not_started");
    let context_status = meta
        .get("context_status")
        .map(String::as_str)
        .unwrap_or("not_started");
    let context_version = meta
        .get("context_index_version")
        .map(String::as_str)
        .unwrap_or_default();
    let unavailable_reason = session_unavailable_reason(
        &cache_version,
        source_exists,
        source_current,
        scan_status,
        context_status,
        context_version,
    );
    let updated_at = catalog_metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_secs());
    Ok(Some(json!({
        "id": session_id,
        "sessionPath": work_dir.display().to_string(),
        "sourcePath": source_path.display().to_string(),
        "sourceKind": source_kind,
        "sourceName": source_path.file_name().and_then(|name| name.to_str()).unwrap_or("LINE backup"),
        "sourceBytes": source_metadata.as_ref().filter(|metadata| metadata.is_file()).map_or(0, fs::Metadata::len),
        "sourceExists": source_exists,
        "sourceCurrent": source_current,
        "cacheVersion": cache_version,
        "versionCompatible": cache_version == env!("CARGO_PKG_VERSION"),
        "scanStatus": scan_status,
        "contextStatus": context_status,
        "contextIndexVersion": context_version,
        "scanCompletedAt": meta.get("scan_completed_at").and_then(|value| value.parse::<u64>().ok()).unwrap_or(0),
        "attachmentCount": attachment_count,
        "updatedAt": updated_at,
        "unavailableReason": unavailable_reason,
        "reusable": unavailable_reason.is_empty()
    })))
}

fn session_unavailable_reason(
    cache_version: &str,
    source_exists: bool,
    source_current: Option<bool>,
    scan_status: &str,
    context_status: &str,
    context_version: &str,
) -> String {
    if cache_version != env!("CARGO_PKG_VERSION") {
        format!("Session 版本 {cache_version} 不相容")
    } else if !source_exists {
        "原始備份已移動或不存在".into()
    } else if source_current == Some(false) {
        "原始備份在分析後已變更".into()
    } else if scan_status != "complete" {
        "附件掃描尚未完成".into()
    } else if context_status != "complete" {
        "SQLite 關聯分析尚未完成".into()
    } else if context_version != "5" {
        "Session 分析格式需要更新".into()
    } else {
        String::new()
    }
}

fn file_source_fingerprint(metadata: &fs::Metadata) -> String {
    let size = metadata.len().to_le_bytes();
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0_i64, |duration| duration.as_nanos() as i64)
        .to_le_bytes();
    let mut digest = sha2::Sha256::new();
    digest.update(size);
    digest.update(modified);
    format!("{:x}", digest.finalize())
}

fn stage_selected_mobile_file(
    app: &tauri::AppHandle,
    selected: FilePath,
    data_dir: &std::path::Path,
    kind: &str,
    cancellation: &CancellationToken,
) -> Result<PathBuf, String> {
    let extension = if kind == "sqlite" {
        "sqlite"
    } else {
        "imazingapp"
    };
    let imports = data_dir.join("imports");
    fs::create_dir_all(&imports).map_err(|error| error.to_string())?;
    let destination = imports.join(format!("{}.{}", uuid::Uuid::new_v4(), extension));
    let mut options = OpenOptions::default();
    options.read(true);
    let mut input = app
        .fs()
        .open(selected, options)
        .map_err(|error| format!("無法讀取系統選取的備份：{error}"))?;
    let mut output = fs::File::create(&destination).map_err(|error| error.to_string())?;
    let mut buffer = vec![0_u8; 4 * 1024 * 1024];
    loop {
        if cancellation.is_cancelled() {
            drop(output);
            let _ = fs::remove_file(&destination);
            return Err("operation_cancelled".into());
        }
        let read = input
            .read(&mut buffer)
            .map_err(|error| format!("匯入備份失敗：{error}"))?;
        if read == 0 {
            break;
        }
        output
            .write_all(&buffer[..read])
            .map_err(|error| format!("匯入備份失敗：{error}"))?;
    }
    output.flush().map_err(|error| error.to_string())?;
    Ok(destination)
}

#[tauri::command]
fn choose_candidate_output(
    app: tauri::AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<Option<Value>, String> {
    require_open_session(&state)?;
    let selected = app
        .dialog()
        .file()
        .set_title("儲存瘦身候選備份")
        .set_file_name("LINE-slim.imazingapp")
        .add_filter("iMazing App Data", &["imazingapp"])
        .blocking_save_file();
    authorize_selected_output(&app, &state, selected, OutputKind::Candidate)
}

#[tauri::command]
fn choose_conversation_output(
    app: tauri::AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<Option<Value>, String> {
    require_open_session(&state)?;
    let selected = app
        .dialog()
        .file()
        .set_title("輸出完整討論串")
        .set_file_name("LINE-conversation.zip")
        .add_filter("ZIP 封存檔", &["zip"])
        .blocking_save_file();
    authorize_selected_output(&app, &state, selected, OutputKind::Conversation)
}

#[tauri::command]
fn choose_export_output(
    app: tauri::AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<Option<Value>, String> {
    require_open_session(&state)?;
    #[cfg(mobile)]
    let selected = app
        .dialog()
        .file()
        .set_title("輸出附件 ZIP")
        .set_file_name("LINE-attachments.zip")
        .add_filter("ZIP 封存檔", &["zip"])
        .blocking_save_file();
    #[cfg(not(mobile))]
    let selected = app
        .dialog()
        .file()
        .set_title("選擇附件匯出目的地資料夾")
        .blocking_pick_folder();
    authorize_selected_output(&app, &state, selected, OutputKind::Attachments)
}

fn require_open_session(state: &State<'_, RuntimeState>) -> Result<(), String> {
    if state
        .session
        .lock()
        .map_err(|_| "備份工作階段鎖定失敗。")?
        .is_none()
    {
        return Err("請先開啟並掃描備份。".into());
    }
    Ok(())
}

fn authorize_selected_output(
    app: &tauri::AppHandle,
    state: &State<'_, RuntimeState>,
    selected: Option<FilePath>,
    kind: OutputKind,
) -> Result<Option<Value>, String> {
    let Some(selected) = selected else {
        return Ok(None);
    };
    let token = uuid::Uuid::new_v4().to_string();
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    let mut shell = state.shell.lock().map_err(|_| "輸出授權狀態鎖定失敗。")?;
    let (staged_path, destination, display_name) = if cfg!(mobile) {
        let exports = data_dir.join("exports");
        fs::create_dir_all(&exports).map_err(|error| error.to_string())?;
        let name = match kind {
            OutputKind::Candidate => "LINE-slim.imazingapp",
            OutputKind::Conversation => "LINE-conversation.zip",
            OutputKind::Attachments => "LINE-attachments.zip",
        };
        let staged = match kind {
            OutputKind::Attachments => exports.join(format!("attachments-{token}")),
            OutputKind::Candidate => exports.join(format!("candidate-{token}.imazingapp")),
            OutputKind::Conversation => exports.join(format!("conversation-{token}.zip")),
        };
        (staged, Some(selected), name.to_string())
    } else {
        let selected_path = selected
            .into_path()
            .map_err(|_| "系統選取的位置不是可寫入的本機路徑。".to_string())?;
        let staged = if kind == OutputKind::Attachments {
            selected_path.join(format!("LINE-Cheater-Export-{}", &token[..8]))
        } else {
            selected_path
        };
        if let Some(work_dir) = shell.work_dir.as_ref()
            && path_falls_inside(work_dir, &staged)
        {
            return Err("輸出位置不能位於 LINE Cheater 的分析快取內。".into());
        }
        let display = staged
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("LINE export")
            .to_string();
        (staged, None, display)
    };
    shell.outputs.insert(
        token.clone(),
        AuthorizedOutput {
            kind,
            staged_path,
            destination,
            display_name: display_name.clone(),
        },
    );
    Ok(Some(json!({ "token": token, "displayName": display_name })))
}

fn authorize_request_output(
    state: &State<'_, RuntimeState>,
    method: &str,
    params: &mut Value,
) -> Result<Option<(String, AuthorizedOutput)>, String> {
    let required_kind = match method {
        "buildCandidate" => Some(OutputKind::Candidate),
        "exportAttachments" | "exportAttachmentsFiltered" => Some(OutputKind::Attachments),
        "exportConversation" => Some(OutputKind::Conversation),
        _ => None,
    };
    let Some(required_kind) = required_kind else {
        return Ok(None);
    };
    let token = params
        .get("output")
        .and_then(Value::as_str)
        .ok_or_else(|| "缺少有效的輸出位置授權。".to_string())?
        .to_string();
    let output = state
        .shell
        .lock()
        .map_err(|_| "輸出授權狀態鎖定失敗。")?
        .outputs
        .get(&token)
        .filter(|output| output.kind == required_kind)
        .cloned()
        .ok_or_else(|| "輸出位置授權已失效，請重新選擇。".to_string())?;
    params["output"] = Value::String(output.staged_path.display().to_string());
    Ok(Some((token, output)))
}

fn finish_authorized_output(
    app: &tauri::AppHandle,
    state: &State<'_, RuntimeState>,
    method: &str,
    authorized: Option<(String, AuthorizedOutput)>,
    result: &mut Value,
) -> Result<(), String> {
    let Some((token, output)) = authorized else {
        return Ok(());
    };
    if method == "buildCandidate"
        && result
            .get("lineSquareRebuildRequired")
            .and_then(Value::as_bool)
            == Some(true)
    {
        return Ok(());
    }
    if let Some(destination) = output.destination.clone() {
        if output.kind == OutputKind::Attachments {
            let archive = output.staged_path.with_extension("zip");
            zip_directory(&output.staged_path, &archive)?;
            copy_to_selected_file(app, &archive, destination)?;
            let _ = fs::remove_file(archive);
            let _ = fs::remove_dir_all(&output.staged_path);
        } else {
            copy_to_selected_file(app, &output.staged_path, destination)?;
            let _ = fs::remove_file(&output.staged_path);
        }
        result["outputName"] = Value::String(output.display_name.clone());
    }
    let mut shell = state.shell.lock().map_err(|_| "輸出授權狀態鎖定失敗。")?;
    shell.outputs.remove(&token);
    if output.kind == OutputKind::Candidate {
        shell.candidate_finalization_pending = true;
        result["sessionFinalizationRequired"] = Value::Bool(true);
    }
    Ok(())
}

fn copy_to_selected_file(
    app: &tauri::AppHandle,
    source: &Path,
    destination: FilePath,
) -> Result<(), String> {
    let mut input = File::open(source).map_err(|error| error.to_string())?;
    let mut options = OpenOptions::default();
    options.write(true).create(true).truncate(true);
    let mut output = app
        .fs()
        .open(destination, options)
        .map_err(|error| format!("無法寫入系統選取的位置：{error}"))?;
    io::copy(&mut input, &mut output).map_err(|error| format!("輸出檔案失敗：{error}"))?;
    output.flush().map_err(|error| error.to_string())
}

fn zip_directory(directory: &Path, archive: &Path) -> Result<(), String> {
    let file = File::create(archive).map_err(|error| error.to_string())?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    append_zip_directory(&mut zip, directory, directory, options)?;
    zip.finish().map_err(|error| error.to_string())?;
    Ok(())
}

fn append_zip_directory<W: Write + io::Seek>(
    zip: &mut ZipWriter<W>,
    root: &Path,
    directory: &Path,
    options: SimpleFileOptions,
) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            append_zip_directory(zip, root, &path, options)?;
        } else if file_type.is_file() {
            let name = path
                .strip_prefix(root)
                .map_err(|error| error.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            zip.start_file(name, options)
                .map_err(|error| error.to_string())?;
            let mut input = File::open(path).map_err(|error| error.to_string())?;
            io::copy(&mut input, zip).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn path_falls_inside(parent: &Path, candidate: &Path) -> bool {
    let parent = parent
        .canonicalize()
        .unwrap_or_else(|_| parent.to_path_buf());
    let candidate = candidate
        .canonicalize()
        .or_else(|_| {
            candidate
                .parent()
                .unwrap_or(candidate)
                .canonicalize()
                .map(|base| base.join(candidate.file_name().unwrap_or_default()))
        })
        .unwrap_or_else(|_| candidate.to_path_buf());
    candidate.starts_with(parent)
}

#[tauri::command]
fn discard_candidate_output(state: State<'_, RuntimeState>, token: String) -> Result<bool, String> {
    let output = state
        .shell
        .lock()
        .map_err(|_| "輸出授權狀態鎖定失敗。")?
        .outputs
        .remove(&token);
    let Some(output) = output.filter(|output| output.kind == OutputKind::Candidate) else {
        return Ok(false);
    };
    let partial = PathBuf::from(format!("{}.partial", output.staged_path.display()));
    let mut removed = false;
    for path in [&output.staged_path, &partial] {
        if path.is_file() {
            fs::remove_file(path).map_err(|error| error.to_string())?;
            removed = true;
        } else if path.is_dir() {
            fs::remove_dir_all(path).map_err(|error| error.to_string())?;
            removed = true;
        }
    }
    Ok(removed)
}

#[tauri::command]
fn finalize_candidate_session(
    app: tauri::AppHandle,
    state: State<'_, RuntimeState>,
    retain_session: bool,
) -> Result<Value, String> {
    let work_dir = {
        let mut shell = state.shell.lock().map_err(|_| "備份外殼狀態鎖定失敗。")?;
        if !shell.candidate_finalization_pending {
            return Err("目前沒有等待處理的分析 Session。".into());
        }
        shell.candidate_finalization_pending = false;
        shell.work_dir.clone()
    };
    *state.session.lock().map_err(|_| "備份工作階段鎖定失敗。")? = None;
    if retain_session {
        return Ok(json!({
            "cacheCleared": false,
            "cacheRetained": true,
            "cacheCleanupWarning": ""
        }));
    }
    let work_dir = work_dir.ok_or_else(|| "找不到目前的分析 Session。".to_string())?;
    let sessions = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join("sessions");
    let valid_name = work_dir
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.len() == 64 && name.bytes().all(|byte| byte.is_ascii_hexdigit()));
    if !valid_name
        || !path_falls_inside(&sessions, &work_dir)
        || !work_dir.join(".line-cheater-session").is_file()
    {
        return Err("拒絕刪除未通過安全驗證的 Session 路徑。".into());
    }
    fs::remove_dir_all(&work_dir).map_err(|error| format!("無法刪除分析 Session：{error}"))?;
    Ok(json!({
        "cacheCleared": true,
        "cacheRetained": false,
        "cacheCleanupWarning": ""
    }))
}

#[tauri::command]
async fn attachment_preview(app: tauri::AppHandle, path: String) -> Result<String, String> {
    if path.is_empty() || path.len() > 4096 {
        return Err("附件預覽路徑無效。".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<RuntimeState>();
        let work_dir = state
            .shell
            .lock()
            .map_err(|_| "備份外殼狀態鎖定失敗。")?
            .work_dir
            .clone()
            .ok_or_else(|| "尚未開啟備份。".to_string())?;
        let mut session = state.session.lock().map_err(|_| "備份工作階段鎖定失敗。")?;
        let session = session
            .as_mut()
            .ok_or_else(|| "尚未開啟備份。".to_string())?;
        let preview = line_backup_native::invoke_streaming(
            session,
            "stageAttachmentPreview",
            json!({ "path": path }),
            None,
            |_| {},
        )
        .map_err(|error| format!("{error:#}"))?;
        let staged = preview
            .get("stagedPath")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .ok_or_else(|| "附件預覽結果無效。".to_string())?;
        let media_type = preview
            .get("mediaType")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let expected_bytes = preview
            .get("bytes")
            .and_then(Value::as_u64)
            .ok_or_else(|| "附件預覽大小無效。".to_string())?;
        let staged = staged
            .canonicalize()
            .map_err(|error| format!("無法驗證附件預覽：{error}"))?;
        let work_dir = work_dir
            .canonicalize()
            .map_err(|error| format!("無法驗證 Session：{error}"))?;
        let metadata = fs::metadata(&staged).map_err(|error| error.to_string())?;
        if !staged.starts_with(work_dir)
            || !metadata.is_file()
            || metadata.len() != expected_bytes
            || expected_bytes == 0
            || expected_bytes > 16 * 1024 * 1024
            || !media_type.starts_with("image/")
        {
            return Err("附件預覽未通過安全驗證。".into());
        }
        Ok(staged.display().to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn unsupported_shell_action(name: String) -> Result<Value, String> {
    Err(format!(
        "The Tauri migration has not implemented {name} yet."
    ))
}

#[tauri::command]
fn open_external(app: tauri::AppHandle, value: String) -> Result<(), String> {
    if value.len() > 4096 {
        return Err("外部連結過長。".into());
    }
    let url = url::Url::parse(&value).map_err(|_| "外部連結格式無效。".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
    {
        return Err("只能開啟不含帳號密碼的 HTTP(S) 連結。".into());
    }
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") { let _ = window.hide(); }
            if !local_cleanup::list_line_processes().unwrap_or_default().is_empty() {
                let accepted = app.dialog()
                    .message("LINE Cheater 必須先關閉 LINE，才能安全讀取或清理本機檔案。現在要關閉 LINE 嗎？")
                    .title("請先關閉 LINE")
                    .kind(MessageDialogKind::Warning)
                    .buttons(MessageDialogButtons::OkCancelCustom("關閉 LINE 並繼續".into(), "取消".into()))
                    .blocking_show();
                if !accepted { app.handle().exit(0); return Ok(()); }
                local_cleanup::request_line_quit().map_err(io::Error::other)?;
                for _ in 0..10 {
                    if local_cleanup::list_line_processes().unwrap_or_default().is_empty() { break; }
                    thread::sleep(Duration::from_millis(500));
                }
                if !local_cleanup::list_line_processes().unwrap_or_default().is_empty() {
                    return Err(io::Error::other("LINE 尚未完全關閉；為保護資料，LINE Cheater 已停止啟動。").into());
                }
            }
            if let Some(window) = app.get_webview_window("main") { let _ = window.show(); }
            Ok(())
        })
        .manage(RuntimeState::default())
        .invoke_handler(tauri::generate_handler![
            platform_capabilities,
            native_request,
            local_cleanup_status,
            scan_local_cleanup,
            delete_local_selection,
            list_sessions,
            open_saved_session,
            delete_saved_session,
            select_source,
            choose_candidate_output,
            choose_export_output,
            choose_conversation_output,
            discard_candidate_output,
            finalize_candidate_session,
            cancel_operation,
            attachment_preview,
            unsupported_shell_action,
            open_external
        ])
        .run(tauri::generate_context!())
        .expect("error while running LINE Cheater");
}
