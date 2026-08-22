use std::collections::{HashMap, HashSet};
use std::error::Error as StdError;
use std::fmt;
use std::fs::{self, File};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use rusqlite::backup::Backup;
use rusqlite::{Connection, ErrorCode, OpenFlags, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZIP64_BYTES_THR, ZipArchive, ZipWriter};

use crate::cancel::check_cancelled;
use crate::catalog::Catalog;
use crate::catalog::DatabaseCleanupPlan;
use crate::source::{PreparedSource, SourceKind, inspect_source, prepare_source};

const HASH_BUFFER_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CandidateProgress {
    pub processed_bytes: u64,
    pub total_bytes: u64,
    pub processed_entries: u64,
    pub total_entries: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CandidateReport {
    pub source_path: String,
    pub output_path: String,
    pub input_entries: u64,
    pub output_entries: u64,
    pub removed_entries: u64,
    pub removed_chats: u64,
    pub removed_messages: u64,
    pub linked_duplicate_entries: u64,
    pub linked_duplicate_bytes: u64,
    pub rewritten_databases: Vec<String>,
    pub output_bytes: u64,
    pub used_zip64: bool,
    pub full_crc_verified: bool,
    pub protected_entries_verified: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CandidateOptions {
    pub full_crc: bool,
    pub link_duplicates: bool,
    pub allow_corrupt_line_square_rebuild: bool,
}

#[derive(Debug)]
pub struct LineSquareRebuildRequired;

impl fmt::Display for LineSquareRebuildRequired {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(
            "LineSquare.sqlite is corrupt and requires explicit authorization before it can be rebuilt as an empty database",
        )
    }
}

impl StdError for LineSquareRebuildRequired {}

pub fn line_square_rebuild_required(error: &anyhow::Error) -> bool {
    error.downcast_ref::<LineSquareRebuildRequired>().is_some()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileFingerprint {
    bytes: u64,
    modified_ns: u128,
}

struct ArchiveBuildInfo {
    entries: u64,
    compressed_bytes: u64,
    protected_hashes: HashMap<String, String>,
    warnings: Vec<String>,
}

#[derive(Debug)]
struct DatabaseRewrite {
    path: PathBuf,
    sha256: String,
    removed_chats: u64,
    removed_messages: u64,
}

#[derive(Debug, Default)]
struct DatabaseRewrites {
    entries: HashMap<String, DatabaseRewrite>,
    skipped_sidecars: HashSet<String>,
    warnings: Vec<String>,
}

#[derive(Debug)]
struct SchemaObject {
    object_type: String,
    name: String,
    sql: String,
}

#[derive(Debug, Default)]
struct EmptyDatabaseRebuild {
    used_minimal_schema: bool,
    skipped_schema_objects: usize,
}

#[derive(Debug)]
struct DuplicateSymlink {
    canonical_path: String,
    relative_target: String,
    replaced_bytes: u64,
}

#[derive(Debug, Default)]
struct DuplicateSymlinkPlan {
    links: HashMap<String, DuplicateSymlink>,
}

#[derive(Clone, Copy)]
struct CandidateBuildPlan<'a> {
    catalog: &'a Catalog,
    marked: &'a HashSet<String>,
    rewrites: &'a DatabaseRewrites,
    duplicate_symlinks: &'a DuplicateSymlinkPlan,
    full_crc: bool,
}

impl DuplicateSymlinkPlan {
    fn linked_entries(&self) -> u64 {
        self.links.len() as u64
    }

    fn linked_bytes(&self) -> u64 {
        self.links.values().map(|entry| entry.replaced_bytes).sum()
    }
}

impl DatabaseRewrites {
    fn removed_chats(&self) -> u64 {
        self.entries.values().map(|entry| entry.removed_chats).sum()
    }

    fn removed_messages(&self) -> u64 {
        self.entries
            .values()
            .map(|entry| entry.removed_messages)
            .sum()
    }

    fn rewritten_names(&self) -> Vec<String> {
        let mut names = self.entries.keys().cloned().collect::<Vec<_>>();
        names.sort();
        names
    }

    fn hashes(&self) -> HashMap<String, String> {
        self.entries
            .iter()
            .map(|(name, rewrite)| (name.clone(), rewrite.sha256.clone()))
            .collect()
    }
}

pub fn build_candidate<F>(
    source: &Path,
    output: &Path,
    catalog: &Catalog,
    full_crc: bool,
    link_duplicates: bool,
    on_progress: F,
) -> Result<CandidateReport>
where
    F: FnMut(CandidateProgress) -> Result<()>,
{
    build_candidate_with_options(
        source,
        output,
        catalog,
        CandidateOptions {
            full_crc,
            link_duplicates,
            allow_corrupt_line_square_rebuild: false,
        },
        on_progress,
    )
}

pub fn build_candidate_with_options<F>(
    source: &Path,
    output: &Path,
    catalog: &Catalog,
    options: CandidateOptions,
    mut on_progress: F,
) -> Result<CandidateReport>
where
    F: FnMut(CandidateProgress) -> Result<()>,
{
    check_cancelled()?;
    let CandidateOptions {
        full_crc,
        link_duplicates,
        allow_corrupt_line_square_rebuild,
    } = options;
    let source = source
        .canonicalize()
        .with_context(|| format!("source does not exist: {}", source.display()))?;
    let report = inspect_source(&source)?;
    if report.kind == SourceKind::Sqlite {
        bail!("a direct Line.sqlite is not a complete backup and cannot become .imazingapp");
    }
    validate_catalog_source(catalog, &source)?;
    if !catalog.source_matches_current(&source, report.kind)? {
        bail!("source changed since the last scan; rescan the backup before building a candidate");
    }
    validate_output(&source, output, report.kind)?;
    let marked: HashSet<String> = catalog.marked_paths()?.into_iter().collect();
    for path in &marked {
        if !is_removable_attachment(path) || is_protected(path) {
            bail!("removal plan contains a protected or non-attachment path: {path}");
        }
    }
    let duplicate_symlinks = if link_duplicates {
        plan_duplicate_symlinks(catalog, &marked)?
    } else {
        DuplicateSymlinkPlan::default()
    };
    let cleanup_plan = catalog.database_cleanup_plan()?;
    let rewrites = prepare_database_rewrites(
        &source,
        catalog,
        &cleanup_plan,
        allow_corrupt_line_square_rebuild,
    )?;
    let build_plan = CandidateBuildPlan {
        catalog,
        marked: &marked,
        rewrites: &rewrites,
        duplicate_symlinks: &duplicate_symlinks,
        full_crc,
    };

    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = partial_path(output);
    if temporary.exists() {
        bail!(
            "partial output already exists; inspect or remove it before retrying: {}",
            temporary.display()
        );
    }

    let build_result = match report.kind {
        SourceKind::Directory => {
            build_from_directory(&source, &temporary, build_plan, &mut on_progress)
        }
        SourceKind::ImazingArchive => {
            build_from_archive(&source, &temporary, build_plan, &mut on_progress)
        }
        SourceKind::Sqlite => unreachable!(),
    };
    match build_result {
        Ok(mut candidate) => {
            check_cancelled()?;
            fs::rename(&temporary, output)?;
            candidate.source_path = source.display().to_string();
            candidate.output_path = output.display().to_string();
            candidate.output_bytes = fs::metadata(output)?.len();
            for rewrite in rewrites.entries.values() {
                let _ = fs::remove_file(&rewrite.path);
            }
            Ok(candidate)
        }
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            for rewrite in rewrites.entries.values() {
                let _ = fs::remove_file(&rewrite.path);
            }
            Err(error)
        }
    }
}

fn plan_duplicate_symlinks(
    catalog: &Catalog,
    marked: &HashSet<String>,
) -> Result<DuplicateSymlinkPlan> {
    let mut plan = DuplicateSymlinkPlan::default();
    for members in catalog.duplicate_link_groups(marked)? {
        let Some(canonical) = members.first() else {
            continue;
        };
        for member in members.iter().skip(1) {
            let relative_target = relative_symlink_target(&member.path, &canonical.path)?;
            plan.links.insert(
                member.path.clone(),
                DuplicateSymlink {
                    canonical_path: canonical.path.clone(),
                    relative_target,
                    replaced_bytes: member.bytes,
                },
            );
        }
    }
    Ok(plan)
}

fn relative_symlink_target(link_path: &str, target_path: &str) -> Result<String> {
    let link_components = safe_archive_components(link_path)?;
    let target_components = safe_archive_components(target_path)?;
    let link_parent = &link_components[..link_components.len().saturating_sub(1)];
    let common = link_parent
        .iter()
        .zip(&target_components)
        .take_while(|(left, right)| left == right)
        .count();
    let mut relative = Vec::new();
    relative.extend(std::iter::repeat_n("..", link_parent.len() - common));
    relative.extend(target_components[common..].iter().copied());
    if relative.is_empty() {
        bail!("duplicate symlink target resolves to its own path: {link_path}");
    }
    Ok(relative.join("/"))
}

fn safe_archive_components(path: &str) -> Result<Vec<&str>> {
    let components = path.split('/').collect::<Vec<_>>();
    if path.is_empty()
        || path.starts_with('/')
        || path.contains('\\')
        || components
            .iter()
            .any(|component| component.is_empty() || matches!(*component, "." | ".."))
    {
        bail!("unsafe attachment path cannot be used for duplicate linking: {path}");
    }
    Ok(components)
}

fn prepare_database_rewrites(
    source: &Path,
    catalog: &Catalog,
    plan: &DatabaseCleanupPlan,
    allow_corrupt_line_square_rebuild: bool,
) -> Result<DatabaseRewrites> {
    if plan.is_empty() {
        return Ok(DatabaseRewrites::default());
    }
    let work_dir = catalog
        .path()
        .parent()
        .context("catalog path has no working directory")?;
    let prepared = prepare_source(source, work_dir)?;
    prepare_rewrites_from_prepared(&prepared, work_dir, plan, allow_corrupt_line_square_rebuild)
}

fn prepare_rewrites_from_prepared(
    prepared: &PreparedSource,
    work_dir: &Path,
    plan: &DatabaseCleanupPlan,
    allow_corrupt_line_square_rebuild: bool,
) -> Result<DatabaseRewrites> {
    let mut rewrites = DatabaseRewrites::default();
    let line_chats = plan
        .chats
        .iter()
        .filter(|chat| chat.source == "line")
        .map(|chat| chat.chat_pk)
        .collect::<Vec<_>>();
    let square_planned_chats = plan
        .chats
        .iter()
        .filter(|chat| chat.source == "square")
        .collect::<Vec<_>>();
    let square_chats = square_planned_chats
        .iter()
        .map(|chat| chat.chat_pk)
        .collect::<Vec<_>>();
    if plan
        .chats
        .iter()
        .any(|chat| !matches!(chat.source.as_str(), "line" | "square"))
        || plan
            .orphan_messages
            .iter()
            .any(|message| message.source != "square")
    {
        bail!("database cleanup plan contains an unsupported source");
    }
    let square_orphans = plan
        .orphan_messages
        .iter()
        .map(|message| message.message_pk)
        .collect::<Vec<_>>();
    let rewrite_directory = work_dir.join("candidate-databases");
    fs::create_dir_all(&rewrite_directory)?;

    if !line_chats.is_empty() {
        let destination = rewrite_directory.join("Line.cleaned.sqlite");
        let (removed_chats, removed_messages) =
            rewrite_database(&prepared.database_path, &destination, &line_chats, &[])?;
        insert_database_rewrite(
            &mut rewrites,
            prepared.report.database_path.clone(),
            destination,
            removed_chats,
            removed_messages,
        )?;
    }
    if !square_chats.is_empty() || !square_orphans.is_empty() {
        let source = prepared
            .square_database_path
            .as_deref()
            .context("cleanup plan references LineSquare.sqlite, but it is unavailable")?;
        let destination = rewrite_directory.join("LineSquare.cleaned.sqlite");
        let planned_messages = square_planned_chats
            .iter()
            .map(|chat| chat.message_count.max(0) as u64)
            .sum::<u64>()
            .saturating_add(square_orphans.len() as u64);
        let (removed_chats, removed_messages, warning) = rewrite_square_database(
            source,
            &destination,
            &square_chats,
            &square_orphans,
            planned_messages,
            allow_corrupt_line_square_rebuild,
        )?;
        if let Some(warning) = warning {
            rewrites.warnings.push(warning);
        }
        let entry_name = sibling_entry_name(&prepared.report.database_path, "LineSquare.sqlite");
        insert_database_rewrite(
            &mut rewrites,
            entry_name,
            destination,
            removed_chats,
            removed_messages,
        )?;
    }
    Ok(rewrites)
}

fn insert_database_rewrite(
    rewrites: &mut DatabaseRewrites,
    entry_name: String,
    path: PathBuf,
    removed_chats: u64,
    removed_messages: u64,
) -> Result<()> {
    let sha256 = hash_reader(File::open(&path)?)?;
    rewrites
        .skipped_sidecars
        .insert(format!("{entry_name}-wal"));
    rewrites
        .skipped_sidecars
        .insert(format!("{entry_name}-shm"));
    rewrites.entries.insert(
        entry_name,
        DatabaseRewrite {
            path,
            sha256,
            removed_chats,
            removed_messages,
        },
    );
    Ok(())
}

fn rewrite_database(
    source: &Path,
    destination: &Path,
    chat_pks: &[i64],
    orphan_message_pks: &[i64],
) -> Result<(u64, u64)> {
    if destination.exists() {
        fs::remove_file(destination)?;
    }
    for suffix in ["-wal", "-shm"] {
        let sidecar = PathBuf::from(format!("{}{suffix}", destination.display()));
        if sidecar.exists() {
            fs::remove_file(sidecar)?;
        }
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
        | OpenFlags::SQLITE_OPEN_URI
        | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let source_connection = Connection::open_with_flags(source, flags)
        .with_context(|| format!("cannot snapshot SQLite: {}", source.display()))?;
    let mut destination_connection = Connection::open(destination)?;
    {
        let backup = Backup::new(&source_connection, &mut destination_connection)?;
        backup.run_to_completion(256, Duration::from_millis(10), None)?;
    }
    drop(source_connection);
    let journal_mode: String =
        destination_connection.query_row("PRAGMA journal_mode = DELETE", [], |row| row.get(0))?;
    if !journal_mode.eq_ignore_ascii_case("delete") {
        bail!("rewritten SQLite could not switch to DELETE journal mode");
    }

    let transaction = destination_connection.transaction()?;
    let mut removed_chats = 0_u64;
    let mut removed_messages = 0_u64;
    {
        let mut chat_exists =
            transaction.prepare("SELECT EXISTS(SELECT 1 FROM ZCHAT WHERE Z_PK = ?1)")?;
        let mut delete_messages = transaction.prepare("DELETE FROM ZMESSAGE WHERE ZCHAT = ?1")?;
        let mut delete_chat = transaction.prepare("DELETE FROM ZCHAT WHERE Z_PK = ?1")?;
        for chat_pk in chat_pks {
            let exists: bool = chat_exists.query_row([chat_pk], |row| row.get(0))?;
            if !exists {
                bail!("planned chat no longer exists in SQLite: {chat_pk}");
            }
            removed_messages =
                removed_messages.saturating_add(delete_messages.execute([chat_pk])? as u64);
            let deleted = delete_chat.execute([chat_pk])?;
            if deleted != 1 {
                bail!("failed to remove planned chat from SQLite: {chat_pk}");
            }
            removed_chats += 1;
        }
    }
    {
        let mut orphan_exists = transaction.prepare(
            "SELECT EXISTS(
                SELECT 1 FROM ZMESSAGE m
                LEFT JOIN ZCHAT c ON c.Z_PK = m.ZCHAT
                WHERE m.Z_PK = ?1 AND c.Z_PK IS NULL
             )",
        )?;
        let mut delete_orphan = transaction.prepare(
            "DELETE FROM ZMESSAGE
             WHERE Z_PK = ?1
               AND NOT EXISTS (
                   SELECT 1 FROM ZCHAT c WHERE c.Z_PK = ZMESSAGE.ZCHAT
               )",
        )?;
        for message_pk in orphan_message_pks {
            let exists: bool = orphan_exists.query_row([message_pk], |row| row.get(0))?;
            if !exists {
                bail!("planned community orphan is no longer orphaned: {message_pk}");
            }
            let deleted = delete_orphan.execute([message_pk])?;
            if deleted != 1 {
                bail!("failed to remove planned community orphan: {message_pk}");
            }
            removed_messages += 1;
        }
    }
    transaction.commit()?;
    destination_connection.execute_batch("VACUUM; PRAGMA optimize;")?;
    let quick_check: String =
        destination_connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    if quick_check != "ok" {
        bail!("rewritten SQLite failed quick_check: {quick_check}");
    }
    drop(destination_connection);
    Ok((removed_chats, removed_messages))
}

fn rewrite_square_database(
    source: &Path,
    destination: &Path,
    chat_pks: &[i64],
    orphan_message_pks: &[i64],
    planned_messages: u64,
    allow_corrupt_line_square_rebuild: bool,
) -> Result<(u64, u64, Option<String>)> {
    match rewrite_database(source, destination, chat_pks, orphan_message_pks) {
        Ok((removed_chats, removed_messages)) => {
            return Ok((removed_chats, removed_messages, None));
        }
        Err(error) if sqlite_integrity_failure(source, &error) => {
            if !allow_corrupt_line_square_rebuild {
                return Err(LineSquareRebuildRequired.into());
            }
        }
        Err(error) => return Err(error),
    }

    let source_chats = readable_table_count(source, "ZCHAT").unwrap_or(chat_pks.len() as u64);
    let source_messages = readable_table_count(source, "ZMESSAGE").unwrap_or(planned_messages);
    let rebuild = rebuild_empty_square_database(source, destination)
        .context("failed to replace corrupt LineSquare.sqlite with an empty database")?;
    let mut warning = "LineSquare.sqlite 完整性檢查失敗；候選檔已改用空白社群資料庫，所有可讀取的社群聊天室與訊息均未保留，原始備份未被修改。".to_string();
    if rebuild.used_minimal_schema {
        warning.push_str(" 原始 schema 無法完整讀取，已補建最低限度的 ZCHAT／ZMESSAGE 結構。");
    } else if rebuild.skipped_schema_objects > 0 {
        warning.push_str(&format!(
            " 有 {} 個非必要 schema 物件無法重建。",
            rebuild.skipped_schema_objects
        ));
    }
    Ok((source_chats, source_messages, Some(warning)))
}

fn sqlite_integrity_failure(source: &Path, rewrite_error: &anyhow::Error) -> bool {
    if rewrite_error
        .chain()
        .filter_map(|cause| cause.downcast_ref::<rusqlite::Error>())
        .any(is_sqlite_corruption_error)
    {
        return true;
    }
    if rewrite_error
        .to_string()
        .contains("rewritten SQLite failed quick_check")
    {
        return true;
    }
    match open_read_only_database(source).and_then(|connection| {
        connection
            .query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
            .map_err(Into::into)
    }) {
        Ok(result) => !result.eq_ignore_ascii_case("ok"),
        Err(error) => error
            .chain()
            .filter_map(|cause| cause.downcast_ref::<rusqlite::Error>())
            .any(is_sqlite_corruption_error),
    }
}

fn is_sqlite_corruption_error(error: &rusqlite::Error) -> bool {
    matches!(
        error.sqlite_error_code(),
        Some(ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase)
    )
}

fn readable_table_count(source: &Path, table: &str) -> Option<u64> {
    let connection = open_read_only_database(source).ok()?;
    let sql = format!("SELECT COUNT(*) FROM {}", quoted_identifier(table));
    connection
        .query_row(&sql, [], |row| row.get::<_, i64>(0))
        .ok()
        .map(|count| count.max(0) as u64)
}

fn rebuild_empty_square_database(
    source: &Path,
    destination: &Path,
) -> Result<EmptyDatabaseRebuild> {
    let (schema, source_user_version, source_application_id, schema_readable) =
        match read_database_schema(source) {
            Ok(value) => (value.0, value.1, value.2, true),
            Err(_) => (Vec::new(), None, None, false),
        };
    remove_database_files(destination)?;
    let destination_connection = Connection::open(destination)?;
    destination_connection.execute_batch(
        "PRAGMA foreign_keys = OFF;
         PRAGMA journal_mode = DELETE;",
    )?;

    let mut rebuild = EmptyDatabaseRebuild {
        used_minimal_schema: !schema_readable,
        skipped_schema_objects: 0,
    };
    for object in schema {
        if object.name.to_ascii_lowercase().starts_with("sqlite_")
            || schema_object_exists(&destination_connection, &object.object_type, &object.name)?
        {
            continue;
        }
        if destination_connection.execute_batch(&object.sql).is_err() {
            rebuild.skipped_schema_objects += 1;
        }
    }
    if !table_exists(&destination_connection, "ZCHAT")? {
        destination_connection.execute_batch(MINIMAL_SQUARE_CHAT_SCHEMA)?;
        rebuild.used_minimal_schema = true;
    }
    if !table_exists(&destination_connection, "ZMESSAGE")? {
        destination_connection.execute_batch(MINIMAL_SQUARE_MESSAGE_SCHEMA)?;
        rebuild.used_minimal_schema = true;
    }
    if let Some(user_version) = source_user_version {
        destination_connection.pragma_update(None, "user_version", user_version)?;
    }
    if let Some(application_id) = source_application_id {
        destination_connection.pragma_update(None, "application_id", application_id)?;
    }
    destination_connection.execute_batch("VACUUM; PRAGMA optimize;")?;
    let quick_check: String =
        destination_connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    if !quick_check.eq_ignore_ascii_case("ok") {
        bail!("empty LineSquare.sqlite failed quick_check: {quick_check}");
    }
    drop(destination_connection);
    Ok(rebuild)
}

fn read_database_schema(source: &Path) -> Result<(Vec<SchemaObject>, Option<i64>, Option<i64>)> {
    let connection = open_read_only_database(source)?;
    let user_version = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .ok();
    let application_id = connection
        .query_row("PRAGMA application_id", [], |row| row.get(0))
        .ok();
    let mut statement = connection.prepare(
        "SELECT type, name, sql
         FROM sqlite_schema
         WHERE sql IS NOT NULL
           AND type IN ('table', 'index', 'trigger', 'view')
         ORDER BY CASE type
                    WHEN 'table' THEN 0
                    WHEN 'index' THEN 1
                    WHEN 'trigger' THEN 2
                    ELSE 3
                  END,
                  rowid",
    )?;
    let schema = statement
        .query_map([], |row| {
            Ok(SchemaObject {
                object_type: row.get(0)?,
                name: row.get(1)?,
                sql: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok((schema, user_version, application_id))
}

fn schema_object_exists(connection: &Connection, object_type: &str, name: &str) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM sqlite_schema WHERE type = ?1 AND name = ?2
         )",
        params![object_type, name],
        |row| row.get(0),
    )?)
}

fn table_exists(connection: &Connection, name: &str) -> Result<bool> {
    schema_object_exists(connection, "table", name)
}

fn open_read_only_database(path: &Path) -> Result<Connection> {
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
        | OpenFlags::SQLITE_OPEN_URI
        | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    Ok(Connection::open_with_flags(path, flags)?)
}

fn remove_database_files(path: &Path) -> Result<()> {
    if path.exists() {
        fs::remove_file(path)?;
    }
    for suffix in ["-wal", "-shm"] {
        let sidecar = PathBuf::from(format!("{}{suffix}", path.display()));
        if sidecar.exists() {
            fs::remove_file(sidecar)?;
        }
    }
    Ok(())
}

fn quoted_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

const MINIMAL_SQUARE_CHAT_SCHEMA: &str = "
    CREATE TABLE ZCHAT (
        Z_PK INTEGER PRIMARY KEY,
        ZMID TEXT,
        ZTYPE INTEGER,
        ZSQUARE INTEGER,
        ZNAME TEXT
    );
";

const MINIMAL_SQUARE_MESSAGE_SCHEMA: &str = "
    CREATE TABLE ZMESSAGE (
        Z_PK INTEGER PRIMARY KEY,
        ZID TEXT,
        ZTIMESTAMP INTEGER,
        ZCHAT INTEGER,
        ZSENDER INTEGER,
        ZSENDSTATUS INTEGER,
        ZCONTENTTYPE INTEGER,
        ZMESSAGETYPE TEXT,
        ZTEXT TEXT,
        ZLATITUDE REAL,
        ZLONGITUDE REAL
    );
";

fn sibling_entry_name(database_name: &str, filename: &str) -> String {
    database_name
        .rsplit_once('/')
        .map(|(parent, _)| format!("{parent}/{filename}"))
        .unwrap_or_else(|| filename.to_string())
}

fn build_from_archive<F>(
    source: &Path,
    temporary: &Path,
    plan: CandidateBuildPlan<'_>,
    on_progress: &mut F,
) -> Result<CandidateReport>
where
    F: FnMut(CandidateProgress) -> Result<()>,
{
    let CandidateBuildPlan {
        catalog,
        marked,
        rewrites,
        duplicate_symlinks,
        full_crc,
    } = plan;
    let before_fingerprint = file_fingerprint(source)?;
    let build_info = inspect_archive_for_build(source)?;
    let input_entries = build_info.entries;
    let total_bytes = build_info.compressed_bytes;
    let protected_before = build_info.protected_hashes;
    let mut warnings = build_info.warnings;
    warnings.extend(rewrites.warnings.iter().cloned());
    if !protected_before
        .keys()
        .any(|path| path.ends_with("/Messages/Line.sqlite"))
    {
        bail!("source archive does not contain a protected Messages/Line.sqlite");
    }

    let input = File::open(source)?;
    let mut archive = ZipArchive::new(input)?;
    let output_file = File::create(temporary)?;
    let mut writer = ZipWriter::new(output_file).set_auto_large_file();
    let mut removed_found = HashSet::new();
    let mut skipped_sidecars_found = 0_u64;
    let mut processed_bytes = 0_u64;
    let mut output_entries = 0_u64;
    for index in 0..archive.len() {
        check_cancelled()?;
        let mut entry = archive.by_index(index)?;
        ensure_stable_archive_name(&entry)?;
        let name = entry.name().to_string();
        processed_bytes = processed_bytes.saturating_add(entry.compressed_size());
        if entry.is_dir() {
            drop(entry);
            writer.raw_copy_file(archive.by_index(index)?)?;
            output_entries += 1;
            on_progress(CandidateProgress {
                processed_bytes,
                total_bytes,
                processed_entries: (index + 1) as u64,
                total_entries: input_entries,
            })?;
            continue;
        }
        if marked.contains(&name) {
            removed_found.insert(name);
            on_progress(CandidateProgress {
                processed_bytes,
                total_bytes,
                processed_entries: (index + 1) as u64,
                total_entries: input_entries,
            })?;
            continue;
        }
        if rewrites.skipped_sidecars.contains(&name) {
            skipped_sidecars_found += 1;
            on_progress(CandidateProgress {
                processed_bytes,
                total_bytes,
                processed_entries: (index + 1) as u64,
                total_entries: input_entries,
            })?;
            continue;
        }
        if let Some(rewrite) = rewrites.entries.get(&name) {
            let metadata = fs::metadata(&rewrite.path)?;
            let options = SimpleFileOptions::default()
                .compression_method(CompressionMethod::Stored)
                .large_file(metadata.len() >= ZIP64_BYTES_THR);
            writer.start_file(&name, options)?;
            std::io::copy(&mut File::open(&rewrite.path)?, &mut writer)?;
            output_entries += 1;
            on_progress(CandidateProgress {
                processed_bytes,
                total_bytes,
                processed_entries: (index + 1) as u64,
                total_entries: input_entries,
            })?;
            continue;
        }
        if let Some(link) = duplicate_symlinks.links.get(&name) {
            let expected_digest = catalog
                .content_digest_for_path(&name)?
                .with_context(|| format!("catalog is missing a source content digest: {name}"))?;
            let digest = hash_reader(&mut entry)?;
            if digest != expected_digest {
                bail!("source archive entry changed while duplicate linking: {name}");
            }
            writer.add_symlink(&name, &link.relative_target, SimpleFileOptions::default())?;
            output_entries += 1;
            on_progress(CandidateProgress {
                processed_bytes,
                total_bytes,
                processed_entries: (index + 1) as u64,
                total_entries: input_entries,
            })?;
            continue;
        }
        let expected_digest = catalog
            .content_digest_for_path(&name)?
            .with_context(|| format!("catalog is missing a source content digest: {name}"))?;
        let digest = hash_reader(&mut entry)?;
        if digest != expected_digest {
            bail!("source archive entry changed while candidate was being written: {name}");
        }
        drop(entry);
        writer.raw_copy_file(archive.by_index(index)?)?;
        output_entries += 1;
        on_progress(CandidateProgress {
            processed_bytes,
            total_bytes,
            processed_entries: (index + 1) as u64,
            total_entries: input_entries,
        })?;
    }
    let output = writer.finish()?;
    output.sync_all()?;

    if removed_found.len() != marked.len() {
        let missing: Vec<&String> = marked.difference(&removed_found).collect();
        bail!("removal plan paths were not found in source archive: {missing:?}");
    }
    if file_fingerprint(source)? != before_fingerprint {
        bail!("source .imazingapp changed while candidate was being written");
    }
    if !catalog.source_matches_current(source, SourceKind::ImazingArchive)? {
        bail!("source .imazingapp content changed while candidate was being written");
    }
    verify_candidate(temporary, plan, &protected_before, output_entries)?;
    let output_bytes = fs::metadata(temporary)?.len();
    let mut protected_entries_verified: Vec<String> = protected_before
        .keys()
        .filter(|name| {
            !rewrites.entries.contains_key(*name) && !rewrites.skipped_sidecars.contains(*name)
        })
        .cloned()
        .collect();
    protected_entries_verified.sort();
    if duplicate_symlinks.linked_entries() > 0 {
        warnings.push(
            "duplicate attachments use relative symbolic links; verify iMazing restore compatibility before relying on this candidate"
                .to_string(),
        );
    }
    Ok(CandidateReport {
        source_path: String::new(),
        output_path: String::new(),
        input_entries,
        output_entries,
        removed_entries: removed_found.len() as u64 + skipped_sidecars_found,
        removed_chats: rewrites.removed_chats(),
        removed_messages: rewrites.removed_messages(),
        linked_duplicate_entries: duplicate_symlinks.linked_entries(),
        linked_duplicate_bytes: duplicate_symlinks.linked_bytes(),
        rewritten_databases: rewrites.rewritten_names(),
        output_bytes,
        used_zip64: output_bytes >= ZIP64_BYTES_THR || output_entries >= u16::MAX as u64,
        full_crc_verified: full_crc,
        protected_entries_verified,
        warnings,
    })
}

fn build_from_directory<F>(
    source: &Path,
    temporary: &Path,
    plan: CandidateBuildPlan<'_>,
    on_progress: &mut F,
) -> Result<CandidateReport>
where
    F: FnMut(CandidateProgress) -> Result<()>,
{
    let CandidateBuildPlan {
        catalog,
        marked,
        rewrites,
        duplicate_symlinks,
        full_crc,
    } = plan;
    let protected_before = hash_directory_protected(source)?;
    if !protected_before
        .keys()
        .any(|path| path.ends_with("/Messages/Line.sqlite"))
    {
        bail!("source directory does not contain a protected Messages/Line.sqlite");
    }
    let stats = catalog_directory_work(source, marked, rewrites)?;
    let output_file = File::create(temporary)?;
    let mut writer = ZipWriter::new(output_file).set_auto_large_file();
    let mut processed_bytes = 0_u64;
    let mut processed_entries = 0_u64;
    let mut output_entries = 0_u64;
    let mut removed_found = HashSet::new();
    let mut skipped_sidecars_found = 0_u64;

    for entry in WalkDir::new(source).follow_links(false) {
        check_cancelled()?;
        let entry = entry?;
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = normalized_relative_path(source, entry.path())?;
        processed_entries += 1;
        if marked.contains(&relative) {
            removed_found.insert(relative);
            on_progress(CandidateProgress {
                processed_bytes,
                total_bytes: stats.1,
                processed_entries,
                total_entries: stats.0,
            })?;
            continue;
        }
        if rewrites.skipped_sidecars.contains(&relative) {
            skipped_sidecars_found += 1;
            on_progress(CandidateProgress {
                processed_bytes,
                total_bytes: stats.1,
                processed_entries,
                total_entries: stats.0,
            })?;
            continue;
        }
        if let Some(rewrite) = rewrites.entries.get(&relative) {
            let metadata = fs::metadata(&rewrite.path)?;
            let options = SimpleFileOptions::default()
                .compression_method(CompressionMethod::Stored)
                .large_file(metadata.len() >= ZIP64_BYTES_THR);
            writer.start_file(&relative, options)?;
            let copied = std::io::copy(&mut File::open(&rewrite.path)?, &mut writer)?;
            processed_bytes = processed_bytes.saturating_add(copied);
            output_entries += 1;
            on_progress(CandidateProgress {
                processed_bytes,
                total_bytes: stats.1,
                processed_entries,
                total_entries: stats.0,
            })?;
            continue;
        }
        if let Some(link) = duplicate_symlinks.links.get(&relative) {
            let before = file_fingerprint(entry.path())?;
            let expected_digest =
                catalog
                    .content_digest_for_path(&relative)?
                    .with_context(|| {
                        format!("catalog is missing a source content digest: {relative}")
                    })?;
            let digest = hash_reader(BufReader::with_capacity(
                HASH_BUFFER_BYTES,
                File::open(entry.path())?,
            ))?;
            if digest != expected_digest || file_fingerprint(entry.path())? != before {
                bail!("source file changed while duplicate linking: {relative}");
            }
            writer.add_symlink(
                &relative,
                &link.relative_target,
                SimpleFileOptions::default(),
            )?;
            processed_bytes = processed_bytes.saturating_add(before.bytes);
            output_entries += 1;
            on_progress(CandidateProgress {
                processed_bytes,
                total_bytes: stats.1,
                processed_entries,
                total_entries: stats.0,
            })?;
            continue;
        }
        let before = file_fingerprint(entry.path())?;
        let expected_digest = catalog
            .content_digest_for_path(&relative)?
            .with_context(|| format!("catalog is missing a source content digest: {relative}"))?;
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .large_file(before.bytes >= ZIP64_BYTES_THR);
        writer.start_file(&relative, options)?;
        let input = BufReader::with_capacity(HASH_BUFFER_BYTES, File::open(entry.path())?);
        let (copied, digest) = copy_and_hash(input, &mut writer)?;
        if copied != before.bytes || file_fingerprint(entry.path())? != before {
            bail!("source file changed while it was being copied: {relative}");
        }
        if digest != expected_digest {
            bail!("source file content changed while it was being copied: {relative}");
        }
        processed_bytes = processed_bytes.saturating_add(copied);
        output_entries += 1;
        on_progress(CandidateProgress {
            processed_bytes,
            total_bytes: stats.1,
            processed_entries,
            total_entries: stats.0,
        })?;
    }
    let output = writer.finish()?;
    output.sync_all()?;
    if removed_found.len() != marked.len() {
        let missing: Vec<&String> = marked.difference(&removed_found).collect();
        bail!("removal plan paths were not found in source directory: {missing:?}");
    }
    let protected_after = hash_directory_protected(source)?;
    if protected_after != protected_before {
        bail!("protected source files changed while candidate was being written");
    }
    if !catalog.source_matches_current(source, SourceKind::Directory)? {
        bail!("source directory content changed while candidate was being written");
    }
    verify_candidate(temporary, plan, &protected_before, output_entries)?;
    let output_bytes = fs::metadata(temporary)?.len();
    let mut protected_entries_verified: Vec<String> = protected_before
        .keys()
        .filter(|name| {
            !rewrites.entries.contains_key(*name) && !rewrites.skipped_sidecars.contains(*name)
        })
        .cloned()
        .collect();
    protected_entries_verified.sort();
    Ok(CandidateReport {
        source_path: String::new(),
        output_path: String::new(),
        input_entries: stats.0,
        output_entries,
        removed_entries: removed_found.len() as u64 + skipped_sidecars_found,
        removed_chats: rewrites.removed_chats(),
        removed_messages: rewrites.removed_messages(),
        linked_duplicate_entries: duplicate_symlinks.linked_entries(),
        linked_duplicate_bytes: duplicate_symlinks.linked_bytes(),
        rewritten_databases: rewrites.rewritten_names(),
        output_bytes,
        used_zip64: output_bytes >= ZIP64_BYTES_THR || output_entries >= u16::MAX as u64,
        full_crc_verified: full_crc,
        protected_entries_verified,
        warnings: {
            let mut warnings = vec![
                "directory sources are stored without compression; ZIP metadata may differ from iMazing"
                    .to_string(),
            ];
            warnings.extend(rewrites.warnings.iter().cloned());
            if duplicate_symlinks.linked_entries() > 0 {
                warnings.push(
                    "duplicate attachments use relative symbolic links; verify iMazing restore compatibility before relying on this candidate"
                        .to_string(),
                );
            }
            warnings
        },
    })
}

fn validate_catalog_source(catalog: &Catalog, source: &Path) -> Result<()> {
    let catalog_source = catalog
        .source_path()?
        .context("catalog has not been scanned yet")?
        .canonicalize()
        .context("catalog source no longer exists")?;
    if catalog_source != source {
        bail!("catalog belongs to another source");
    }
    Ok(())
}

fn validate_output(source: &Path, output: &Path, kind: SourceKind) -> Result<()> {
    if output.exists() {
        bail!("output already exists: {}", output.display());
    }
    if source == output {
        bail!("output must not overwrite the source");
    }
    if kind == SourceKind::Directory {
        let absolute_output = if output.is_absolute() {
            output.to_path_buf()
        } else {
            std::env::current_dir()?.join(output)
        };
        if absolute_output.starts_with(source) {
            bail!("directory candidate output must be outside the source tree");
        }
    }
    let output_name = output
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    if !output_name.ends_with(".imazingapp") && !output_name.ends_with(".imazingapp.candidate") {
        bail!("candidate output must end with .imazingapp or .imazingapp.candidate");
    }
    Ok(())
}

fn partial_path(output: &Path) -> PathBuf {
    let mut name = output.as_os_str().to_os_string();
    name.push(".partial");
    PathBuf::from(name)
}

fn is_removable_attachment(path: &str) -> bool {
    let wrapped = format!("/{}/", path.trim_matches('/'));
    wrapped.contains("/Message Attachments/") || wrapped.contains("/Message Thumbnails/")
}

fn is_protected(path: &str) -> bool {
    path == ".lock"
        || path == "iTunesArtwork"
        || path == "iTunesMetadata.plist"
        || path == "Payload/LINE.app/Info.plist"
        || path.ends_with("/Messages/Line.sqlite")
        || path.ends_with("/Messages/Line.sqlite-wal")
        || path.ends_with("/Messages/Line.sqlite-shm")
}

fn inspect_archive_for_build(source: &Path) -> Result<ArchiveBuildInfo> {
    let file = File::open(source)?;
    let mut archive = ZipArchive::new(file)?;
    let mut names = HashSet::with_capacity(archive.len());
    let mut protected_names = Vec::new();
    let mut total_bytes = 0_u64;
    for index in 0..archive.len() {
        check_cancelled()?;
        let entry = archive.by_index(index)?;
        ensure_stable_archive_name(&entry)?;
        if entry.encrypted() {
            bail!("encrypted ZIP entries are not supported: {}", entry.name());
        }
        let name = entry.name().to_string();
        if !names.insert(name.clone()) {
            bail!("source archive contains duplicate entry path: {name}");
        }
        if is_protected(&name) && !entry.is_dir() {
            protected_names.push(name);
        }
        total_bytes = total_bytes.saturating_add(entry.compressed_size());
    }
    let mut protected = HashMap::new();
    for name in protected_names {
        protected.insert(name.clone(), hash_archive_entry(source, &name)?);
    }
    let mut warnings = Vec::new();
    if !protected.contains_key(".lock") {
        warnings.push("source archive does not contain .lock".to_string());
    }
    if !protected.contains_key("Payload/LINE.app/Info.plist") {
        warnings.push("source archive does not contain Payload/LINE.app/Info.plist".to_string());
    }
    Ok(ArchiveBuildInfo {
        entries: archive.len() as u64,
        compressed_bytes: total_bytes,
        protected_hashes: protected,
        warnings,
    })
}

fn ensure_stable_archive_name<R: Read>(entry: &zip::read::ZipFile<'_, R>) -> Result<()> {
    let raw = std::str::from_utf8(entry.name_raw())
        .context("archive contains a non-UTF-8 entry path; refusing to rewrite it")?;
    if raw != entry.name() {
        bail!(
            "archive entry name does not round-trip without metadata changes: {}",
            entry.name()
        );
    }
    Ok(())
}

fn verify_candidate(
    candidate: &Path,
    plan: CandidateBuildPlan<'_>,
    protected_before: &HashMap<String, String>,
    expected_entries: u64,
) -> Result<()> {
    let CandidateBuildPlan {
        marked,
        rewrites,
        duplicate_symlinks,
        full_crc,
        ..
    } = plan;
    let rewritten_hashes = rewrites.hashes();
    let skipped_entries = &rewrites.skipped_sidecars;
    let file = File::open(candidate)?;
    let mut archive = ZipArchive::new(file)?;
    if archive.len() as u64 != expected_entries {
        bail!(
            "candidate entry count mismatch: expected {expected_entries}, got {}",
            archive.len()
        );
    }
    let mut names = HashSet::with_capacity(archive.len());
    let mut regular_names = HashSet::with_capacity(archive.len());
    for index in 0..archive.len() {
        check_cancelled()?;
        let mut entry = archive.by_index(index)?;
        ensure_stable_archive_name(&entry)?;
        let name = entry.name().to_string();
        if marked.contains(&name) {
            bail!("candidate still contains a marked removal: {name}");
        }
        if skipped_entries.contains(&name) {
            bail!("candidate still contains a stale SQLite sidecar: {name}");
        }
        if !names.insert(name.clone()) {
            bail!("candidate contains duplicate entry path: {name}");
        }
        if let Some(link) = duplicate_symlinks.links.get(&name) {
            if !entry.is_symlink() {
                bail!("candidate duplicate link is not a symbolic link: {name}");
            }
            let mut target = String::new();
            entry
                .read_to_string(&mut target)
                .with_context(|| format!("candidate duplicate link target is invalid: {name}"))?;
            if target != link.relative_target {
                bail!("candidate duplicate link target changed: {name}");
            }
        } else if !entry.is_dir() && !entry.is_symlink() {
            regular_names.insert(name.clone());
        }
        if full_crc && !entry.is_dir() {
            std::io::copy(&mut entry, &mut std::io::sink())
                .with_context(|| format!("CRC validation failed for {name}"))?;
        }
    }
    for (name, link) in &duplicate_symlinks.links {
        if !names.contains(name) {
            bail!("candidate is missing duplicate link entry: {name}");
        }
        if !regular_names.contains(&link.canonical_path) {
            bail!(
                "candidate duplicate link target is missing or not a regular file: {}",
                link.canonical_path
            );
        }
        if marked.contains(&link.canonical_path) {
            bail!(
                "candidate duplicate link targets a marked removal: {}",
                link.canonical_path
            );
        }
    }
    for (name, expected_hash) in protected_before {
        if rewritten_hashes.contains_key(name) || skipped_entries.contains(name) {
            continue;
        }
        let actual = hash_archive_entry(candidate, name)?;
        if &actual != expected_hash {
            bail!("protected entry hash changed in candidate: {name}");
        }
    }
    for (name, expected_hash) in &rewritten_hashes {
        let actual = hash_archive_entry(candidate, name)?;
        if &actual != expected_hash {
            bail!("rewritten SQLite entry hash changed in candidate: {name}");
        }
    }
    Ok(())
}

fn hash_directory_protected(root: &Path) -> Result<HashMap<String, String>> {
    let mut protected = HashMap::new();
    for entry in WalkDir::new(root).follow_links(false) {
        check_cancelled()?;
        let entry = entry?;
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = normalized_relative_path(root, entry.path())?;
        if is_protected(&relative) {
            protected.insert(relative, hash_reader(File::open(entry.path())?)?);
        }
    }
    Ok(protected)
}

fn hash_archive_entry(archive_path: &Path, name: &str) -> Result<String> {
    let file = File::open(archive_path)?;
    let mut archive = ZipArchive::new(file)?;
    let entry = archive
        .by_name(name)
        .with_context(|| format!("candidate is missing protected entry: {name}"))?;
    hash_reader(entry)
}

fn hash_reader(mut reader: impl Read) -> Result<String> {
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; HASH_BUFFER_BYTES];
    loop {
        check_cancelled()?;
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn copy_and_hash(mut reader: impl Read, mut writer: impl Write) -> Result<(u64, String)> {
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; HASH_BUFFER_BYTES];
    let mut copied = 0_u64;
    loop {
        check_cancelled()?;
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        writer.write_all(&buffer[..read])?;
        digest.update(&buffer[..read]);
        copied = copied.saturating_add(read as u64);
    }
    Ok((copied, format!("{:x}", digest.finalize())))
}

fn catalog_directory_work(
    root: &Path,
    marked: &HashSet<String>,
    rewrites: &DatabaseRewrites,
) -> Result<(u64, u64)> {
    let mut entries = 0_u64;
    let mut bytes = 0_u64;
    for entry in WalkDir::new(root).follow_links(false) {
        check_cancelled()?;
        let entry = entry?;
        if !entry.file_type().is_file() {
            continue;
        }
        entries += 1;
        let relative = normalized_relative_path(root, entry.path())?;
        if marked.contains(&relative) || rewrites.skipped_sidecars.contains(&relative) {
            continue;
        }
        if let Some(rewrite) = rewrites.entries.get(&relative) {
            bytes = bytes.saturating_add(fs::metadata(&rewrite.path)?.len());
        } else {
            bytes = bytes.saturating_add(entry.metadata()?.len());
        }
    }
    Ok((entries, bytes))
}

fn normalized_relative_path(root: &Path, path: &Path) -> Result<String> {
    let relative = path
        .strip_prefix(root)
        .with_context(|| format!("path escaped source root: {}", path.display()))?;
    let value = relative
        .to_str()
        .context("source contains a non-UTF-8 path; refusing to rewrite it")?
        .replace('\\', "/");
    if value.is_empty()
        || value
            .split('/')
            .any(|component| component.is_empty() || component == "." || component == "..")
    {
        bail!("source contains an unsafe relative path: {value}");
    }
    Ok(value)
}

fn file_fingerprint(path: &Path) -> Result<FileFingerprint> {
    let metadata = fs::metadata(path)?;
    Ok(FileFingerprint {
        bytes: metadata.len(),
        modified_ns: metadata
            .modified()
            .ok()
            .and_then(system_time_ns)
            .unwrap_or(0),
    })
}

fn system_time_ns(value: SystemTime) -> Option<u128> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|value| value.as_nanos())
}
