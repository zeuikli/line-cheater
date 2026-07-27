use std::collections::HashMap;
use std::collections::HashSet;
use std::fs::{self, File, FileTimes, OpenOptions};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::sync_channel;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction, params};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;
use zip::ZipArchive;

use crate::database::{LineDatabase, LineSquareDatabase, OrphanMessage, UnifiedGroupDatabase};
use crate::model::{
    AdvancedCleanupReport, AttachmentContext, AttachmentCursor, AttachmentItem, AttachmentKind,
    AttachmentPage, AttachmentPreview, CatalogStats, Chat, CleanupActivity, CleanupAuditReport,
    CleanupCategoryTotal, CleanupGroup, CleanupGroupPage, CleanupOverview, CleanupPlanPreview,
    CleanupPlanSnapshot, CleanupReview, CleanupReviewPage, DuplicateGroup, DuplicateGroupCursor,
    DuplicateGroupPage, DuplicateHashProgress, DuplicateMemberPage, Message, MessageAttachment,
    checked_page_size,
};
use crate::performance::system_performance_profile;
use crate::source::SourceKind;

const CATALOG_BATCH_SIZE: usize = 1_000;
const HASH_UPDATE_BATCH_SIZE: usize = 100;
const HASH_BUFFER_BYTES: usize = 1024 * 1024;
const CONTEXT_BATCH_SIZE: usize = 900;
const MAX_CLEANUP_RESPONSE_FILES: usize = 1_000;
const MAX_PREVIEW_BYTES: u64 = 16 * 1024 * 1024;
const MAX_STAGED_PREVIEWS: usize = 32;
const CONTEXT_INDEX_VERSION: &str = "3";
const CHAT_INDEX_VERSION: &str = "1";
const CLEANUP_GROUP_EXPR: &str = "
    CASE f.reference_status
        WHEN 'unreferenced' THEN '__unreferenced__'
        WHEN 'unconfirmed' THEN '__unconfirmed__'
        ELSE 'chat:' || COALESCE(NULLIF(f.context_source, ''), 'unknown') || ':' ||
             COALESCE(CAST(f.message_chat_pk AS TEXT), NULLIF(f.context_chat_id, ''), f.chat_hint)
    END
";
const CLEANUP_CATEGORY_EXPR: &str = "
    CASE
        WHEN f.reference_status = 'unreferenced' THEN 'unreferenced'
        WHEN f.reference_status <> 'referenced' THEN 'unconfirmed'
        WHEN f.context_chat_kind = 'direct' THEN 'individual'
        WHEN f.context_chat_kind = 'group' THEN 'group'
        WHEN f.context_chat_kind = 'community' THEN 'community'
        ELSE 'unconfirmed'
    END
";
const THUMBNAIL_BACKED_IMAGE_EXPR: &str = "
    f.attachment_kind = 'original'
    AND f.reference_status = 'referenced'
    AND f.message_content_type IN (1, 16, 112)
    AND f.message_id <> ''
    AND EXISTS (
        SELECT 1
        FROM files thumbnail
        WHERE thumbnail.attachment_kind = 'thumbnail'
          AND thumbnail.reference_status = 'referenced'
          AND thumbnail.message_content_type IN (1, 16, 112)
          AND thumbnail.bytes > 0
          AND thumbnail.message_id = f.message_id
          AND thumbnail.chat_hint = f.chat_hint
    )
";
const IMAGE_THUMBNAIL_WITH_ORIGINAL_EXPR: &str = "
    f.attachment_kind = 'thumbnail'
    AND f.reference_status = 'referenced'
    AND f.message_content_type IN (1, 16, 112)
    AND f.bytes > 0
    AND f.message_id <> ''
    AND EXISTS (
        SELECT 1
        FROM files original
        WHERE original.attachment_kind = 'original'
          AND original.reference_status = 'referenced'
          AND original.message_content_type IN (1, 16, 112)
          AND original.message_id = f.message_id
          AND original.chat_hint = f.chat_hint
    )
";
const ATTACHMENT_COLUMNS: &str = "
    f.id, f.path, f.bytes, f.modified_ns, f.attachment_kind,
    f.message_id, f.chat_hint, p.path IS NOT NULL, COALESCE(p.reason, ''), f.reference_status,
    f.message_pk, f.message_chat_pk, f.context_source, f.context_chat_id,
    f.context_chat_title, f.context_chat_kind, f.message_timestamp,
    f.message_sender_pk, f.message_sender_name, f.message_content_type, f.message_text
";

#[derive(Debug, Clone, Copy)]
pub struct CatalogScanProgress {
    pub files: u64,
    pub bytes: u64,
    pub attachments: u64,
}

#[derive(Debug, Clone, Copy)]
pub struct CatalogContextProgress {
    pub processed_files: u64,
    pub total_files: u64,
    pub referenced_files: u64,
    pub unreferenced_files: u64,
    pub unconfirmed_files: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedChat {
    pub source: String,
    pub chat_pk: i64,
    pub message_count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedMessage {
    pub source: String,
    pub message_pk: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DatabaseCleanupPlan {
    pub chats: Vec<PlannedChat>,
    pub orphan_messages: Vec<PlannedMessage>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct OldAccountSummary {
    pub current_account_found: bool,
    pub account_folders: u64,
    pub old_account_folders: u64,
    pub old_account_files: u64,
    pub old_account_bytes: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BulkRemovalSummary {
    pub files: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DuplicateLinkMember {
    pub path: String,
    pub bytes: u64,
}

impl DatabaseCleanupPlan {
    pub fn is_empty(&self) -> bool {
        self.chats.is_empty() && self.orphan_messages.is_empty()
    }
}

#[derive(Debug)]
struct FileRecord {
    path: String,
    bytes: u64,
    modified_ns: i64,
    content_sha256: String,
    kind: Option<AttachmentKind>,
    message_id: String,
    chat_hint: String,
}

pub struct Catalog {
    path: PathBuf,
    connection: Connection,
}

impl Catalog {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(path)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "NORMAL")?;
        connection.pragma_update(
            None,
            "cache_size",
            system_performance_profile().catalog_cache_kib,
        )?;
        connection.pragma_update(
            None,
            "threads",
            system_performance_profile().sqlite_workers as i64,
        )?;
        connection.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS files (
                id INTEGER PRIMARY KEY,
                path TEXT NOT NULL UNIQUE,
                bytes INTEGER NOT NULL,
                modified_ns INTEGER NOT NULL,
                attachment_kind TEXT,
                message_id TEXT NOT NULL DEFAULT '',
                chat_hint TEXT NOT NULL DEFAULT '',
                seen_scan INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS files_attachment_page
                ON files(attachment_kind, id);
            CREATE INDEX IF NOT EXISTS files_message_id
                ON files(message_id) WHERE message_id <> '';
            CREATE TABLE IF NOT EXISTS removal_plan (
                path TEXT PRIMARY KEY REFERENCES files(path) ON DELETE CASCADE,
                marked_at INTEGER NOT NULL,
                reason TEXT NOT NULL DEFAULT 'manual'
            );
            CREATE TABLE IF NOT EXISTS chat_removal_plan (
                source TEXT NOT NULL CHECK(source IN ('line', 'square')),
                chat_pk INTEGER NOT NULL,
                chat_id TEXT NOT NULL,
                chat_title TEXT NOT NULL,
                chat_kind TEXT NOT NULL,
                message_count INTEGER NOT NULL,
                human_message_count INTEGER NOT NULL,
                reason TEXT NOT NULL CHECK(reason IN ('selected', 'empty', 'system_only')),
                marked_at INTEGER NOT NULL,
                PRIMARY KEY(source, chat_pk)
            );
            CREATE TABLE IF NOT EXISTS chat_removal_files (
                source TEXT NOT NULL,
                chat_pk INTEGER NOT NULL,
                path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
                marked_at INTEGER NOT NULL,
                PRIMARY KEY(source, chat_pk, path),
                FOREIGN KEY(source, chat_pk)
                    REFERENCES chat_removal_plan(source, chat_pk) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS orphan_message_removal_plan (
                source TEXT NOT NULL CHECK(source = 'square'),
                message_pk INTEGER NOT NULL,
                message_id TEXT NOT NULL,
                chat_pk INTEGER,
                marked_at INTEGER NOT NULL,
                PRIMARY KEY(source, message_pk)
            );
            CREATE TABLE IF NOT EXISTS cleanup_activity (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                action TEXT NOT NULL,
                scope TEXT NOT NULL,
                detail TEXT NOT NULL DEFAULT '',
                file_count INTEGER NOT NULL DEFAULT 0,
                bytes INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS cleanup_activity_recent
                ON cleanup_activity(created_at DESC, id DESC);
            CREATE TABLE IF NOT EXISTS bulk_removal_plan (
                reason TEXT NOT NULL CHECK(reason IN ('community', 'old_account')),
                path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
                marked_at INTEGER NOT NULL,
                PRIMARY KEY(reason, path)
            );
            CREATE INDEX IF NOT EXISTS bulk_removal_reason
                ON bulk_removal_plan(reason, path);
            CREATE TABLE IF NOT EXISTS bulk_cleanup_plan (
                reason TEXT PRIMARY KEY CHECK(reason IN ('community', 'old_account')),
                chat_count INTEGER NOT NULL DEFAULT 0,
                message_count INTEGER NOT NULL DEFAULT 0,
                marked_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS bulk_removal_scope (
                reason TEXT NOT NULL CHECK(reason = 'old_account'),
                path_prefix TEXT NOT NULL,
                marked_at INTEGER NOT NULL,
                PRIMARY KEY(reason, path_prefix)
            );
            CREATE TABLE IF NOT EXISTS all_chat_attachment_plan (
                path TEXT PRIMARY KEY REFERENCES files(path) ON DELETE CASCADE,
                marked_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS cleanup_scope_plan (
                scope TEXT PRIMARY KEY CHECK(scope = 'all_chat_attachments'),
                marked_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS chats (
                source TEXT NOT NULL CHECK(source IN ('line', 'square')),
                chat_pk INTEGER NOT NULL,
                chat_id TEXT NOT NULL,
                chat_type INTEGER NOT NULL,
                chat_kind TEXT NOT NULL,
                title TEXT NOT NULL,
                title_source TEXT NOT NULL,
                message_count INTEGER NOT NULL,
                human_message_count INTEGER NOT NULL,
                last_updated INTEGER NOT NULL,
                last_message TEXT NOT NULL,
                PRIMARY KEY(source, chat_pk)
            );
            CREATE INDEX IF NOT EXISTS chats_page
                ON chats(last_updated DESC, source ASC, chat_pk ASC)
                WHERE message_count > 0;
            DROP VIEW IF EXISTS all_removal_plan;
            CREATE VIEW all_removal_plan AS
                SELECT path FROM removal_plan
                UNION
                SELECT path FROM chat_removal_files
                UNION
                SELECT path FROM all_chat_attachment_plan
                UNION
                SELECT path FROM bulk_removal_plan;
            ",
        )?;
        ensure_column(&connection, "files", "sha256", "TEXT")?;
        ensure_column(&connection, "files", "content_sha256", "TEXT")?;
        ensure_column(&connection, "files", "message_pk", "INTEGER")?;
        ensure_column(&connection, "files", "message_chat_pk", "INTEGER")?;
        ensure_column(&connection, "files", "message_timestamp", "INTEGER")?;
        ensure_column(&connection, "files", "message_sender_pk", "INTEGER")?;
        ensure_column(&connection, "files", "message_sender_name", "TEXT")?;
        ensure_column(&connection, "files", "message_content_type", "INTEGER")?;
        ensure_column(&connection, "files", "message_text", "TEXT")?;
        ensure_column(&connection, "files", "context_chat_id", "TEXT")?;
        ensure_column(&connection, "files", "context_source", "TEXT")?;
        ensure_column(&connection, "files", "context_chat_title", "TEXT")?;
        ensure_column(&connection, "files", "context_chat_kind", "TEXT")?;
        ensure_column(
            &connection,
            "files",
            "reference_status",
            "TEXT NOT NULL DEFAULT 'unconfirmed'",
        )?;
        ensure_column(
            &connection,
            "removal_plan",
            "reason",
            "TEXT NOT NULL DEFAULT 'manual'",
        )?;
        connection.execute_batch(
            "
            DROP VIEW IF EXISTS all_removal_plan;
            CREATE VIEW all_removal_plan AS
                SELECT path, reason FROM removal_plan
                UNION ALL
                SELECT chat_files.path, 'chat'
                FROM (SELECT DISTINCT path FROM chat_removal_files) chat_files
                WHERE NOT EXISTS (
                    SELECT 1 FROM removal_plan direct WHERE direct.path = chat_files.path
                )
                UNION ALL
                SELECT all_chat.path, 'chat'
                FROM all_chat_attachment_plan all_chat
                WHERE NOT EXISTS (
                    SELECT 1 FROM removal_plan direct WHERE direct.path = all_chat.path
                )
                  AND NOT EXISTS (
                    SELECT 1 FROM chat_removal_files chat_files
                    WHERE chat_files.path = all_chat.path
                )
                UNION ALL
                SELECT bulk.path, bulk.reason
                FROM bulk_removal_plan bulk
                WHERE NOT EXISTS (
                    SELECT 1 FROM removal_plan direct WHERE direct.path = bulk.path
                )
                  AND NOT EXISTS (
                    SELECT 1 FROM chat_removal_files chat_files
                    WHERE chat_files.path = bulk.path
                )
                  AND NOT EXISTS (
                    SELECT 1 FROM all_chat_attachment_plan all_chat
                    WHERE all_chat.path = bulk.path
                );
            ",
        )?;
        connection.execute(
            "CREATE INDEX IF NOT EXISTS files_sha256 ON files(sha256, id) WHERE sha256 IS NOT NULL",
            [],
        )?;
        connection.execute(
            "CREATE INDEX IF NOT EXISTS files_cleanup_group
             ON files(reference_status, context_source, message_chat_pk, context_chat_id, chat_hint, id)
             WHERE attachment_kind IS NOT NULL",
            [],
        )?;
        connection.execute(
            "CREATE INDEX IF NOT EXISTS files_referenced_thumbnail_lookup
             ON files(message_id, chat_hint)
             WHERE attachment_kind = 'thumbnail'
               AND reference_status = 'referenced'
               AND message_content_type IN (1, 16, 112)
               AND bytes > 0",
            [],
        )?;
        connection.execute(
            "CREATE INDEX IF NOT EXISTS files_referenced_original_lookup
             ON files(message_id, chat_hint)
             WHERE attachment_kind = 'original'
               AND reference_status = 'referenced'
               AND message_content_type IN (1, 16, 112)",
            [],
        )?;
        connection.execute(
            "CREATE INDEX IF NOT EXISTS chat_removal_files_path
             ON chat_removal_files(path)",
            [],
        )?;
        Ok(Self {
            path: path.to_path_buf(),
            connection,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn source_path(&self) -> Result<Option<PathBuf>> {
        Ok(self.meta("source_path")?.map(PathBuf::from))
    }

    pub fn source_fingerprint(&self) -> Result<Option<String>> {
        self.meta("source_fingerprint")
    }

    pub fn source_matches_current(&self, source: &Path, kind: SourceKind) -> Result<bool> {
        let Some(bound) = self.source_path()? else {
            return Ok(false);
        };
        let bound = bound.canonicalize().ok();
        let current = source.canonicalize()?;
        if bound.as_ref() != Some(&current) {
            return Ok(false);
        }
        let Some(stored_fingerprint) = self.meta("source_fingerprint")? else {
            return Ok(false);
        };
        if stored_fingerprint != source_metadata_fingerprint(&current, kind)? {
            return Ok(false);
        }
        if !self.content_matches_catalog(&current, kind)? {
            return Ok(false);
        }
        if kind == SourceKind::ImazingArchive {
            return Ok(stored_fingerprint == source_metadata_fingerprint(&current, kind)?);
        }
        Ok(true)
    }

    fn content_matches_catalog(&self, source: &Path, kind: SourceKind) -> Result<bool> {
        if kind == SourceKind::ImazingArchive {
            let file_count =
                self.connection
                    .query_row("SELECT COUNT(*) FROM files", [], |row| row.get::<_, i64>(0))?;
            let source_bytes = fs::metadata(source)?.len();
            let workers = system_performance_profile()
                .archive_workers_for(source_bytes, file_count.max(0) as usize);
            if workers > 1 {
                return validate_archive_catalog_parallel(
                    source,
                    &self.path,
                    workers,
                    file_count.max(0) as usize,
                );
            }
        }
        let mut statement = self.connection.prepare(
            "SELECT path, bytes, modified_ns, content_sha256
             FROM files ORDER BY path ASC",
        )?;
        let mut rows = statement.query([])?;
        let mut archive = if kind == SourceKind::ImazingArchive {
            Some(ZipArchive::new(File::open(source)?)?)
        } else {
            None
        };
        while let Some(row) = rows.next()? {
            let path: String = row.get(0)?;
            let bytes = row.get::<_, i64>(1)?.max(0) as u64;
            let modified_ns: i64 = row.get(2)?;
            let Some(expected_digest) = row.get::<_, Option<String>>(3)? else {
                return Ok(false);
            };
            let digest = match archive.as_mut() {
                Some(archive) => {
                    let mut entry = match archive.by_name(&path) {
                        Ok(entry) => entry,
                        Err(_) => return Ok(false),
                    };
                    if entry.size() != bytes {
                        return Ok(false);
                    }
                    hash_reader(&mut entry)?
                }
                None => {
                    let file_path = if kind == SourceKind::Sqlite {
                        source.to_path_buf()
                    } else {
                        safe_source_join(source, &path)?
                    };
                    let before = file_record_fingerprint(&file_path)?;
                    if before != (bytes, modified_ns) {
                        return Ok(false);
                    }
                    let digest = hash_directory_file(&file_path, bytes, modified_ns)?;
                    if file_record_fingerprint(&file_path)? != before {
                        return Ok(false);
                    }
                    digest
                }
            };
            if digest != expected_digest {
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub fn recover_interrupted_operations(&self, source: &Path, kind: SourceKind) -> Result<()> {
        if self.meta("scan_status")?.as_deref() == Some("scanning") {
            if self.source_matches_current(source, kind)? {
                self.set_meta("scan_status", "resumable")?;
            } else {
                self.clear_all_removal_plans()?;
                self.set_meta("scan_status", "not_started")?;
                self.set_meta("scan_last_path", "")?;
            }
        }
        if self.meta("context_status")?.as_deref() == Some("indexing") {
            self.clear_all_removal_plans()?;
            self.connection.execute(
                "
                UPDATE files SET
                    message_pk = NULL,
                    message_chat_pk = NULL,
                    message_timestamp = NULL,
                    message_sender_pk = NULL,
                    message_sender_name = NULL,
                    message_content_type = NULL,
                    message_text = NULL,
                    context_source = NULL,
                    context_chat_id = NULL,
                    context_chat_title = NULL,
                    context_chat_kind = NULL,
                    reference_status = 'unconfirmed'
                WHERE attachment_kind IS NOT NULL
                ",
                [],
            )?;
            self.set_meta("context_status", "not_started")?;
        }
        if self.meta("hash_status")?.as_deref() == Some("running") {
            if self.source_matches_current(source, kind)? {
                self.set_meta("hash_status", "resumable")?;
            } else {
                self.clear_duplicate_hashes()?;
                self.set_meta("hash_status", "not_started")?;
            }
        }
        self.clear_active_job("search")?;
        self.clear_active_job("candidate")?;
        Ok(())
    }

    pub fn marked_paths(&self) -> Result<Vec<String>> {
        let mut statement = self
            .connection
            .prepare("SELECT path FROM all_removal_plan ORDER BY path")?;
        let rows = statement.query_map([], |row| row.get(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<String>>>()?)
    }

    pub fn bulk_removal_paths(&self) -> Result<Vec<String>> {
        let mut statement = self
            .connection
            .prepare("SELECT DISTINCT path FROM bulk_removal_plan ORDER BY path")?;
        let rows = statement.query_map([], |row| row.get(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<String>>>()?)
    }

    pub fn bulk_removal_prefixes(&self) -> Result<Vec<String>> {
        let mut statement = self
            .connection
            .prepare("SELECT DISTINCT path_prefix FROM bulk_removal_scope ORDER BY path_prefix")?;
        let rows = statement.query_map([], |row| row.get(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<String>>>()?)
    }

    pub fn content_digest_for_path(&self, path: &str) -> Result<Option<String>> {
        Ok(self
            .connection
            .query_row(
                "SELECT content_sha256 FROM files WHERE path = ?1",
                [path],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn scan_source<F>(
        &mut self,
        source: &Path,
        kind: SourceKind,
        mut on_progress: F,
    ) -> Result<CatalogStats>
    where
        F: FnMut(CatalogScanProgress),
    {
        let source = source
            .canonicalize()
            .with_context(|| format!("source does not exist: {}", source.display()))?;
        let source_key = source.display().to_string();
        let existing_source = self.meta("source_path")?;
        if existing_source
            .as_deref()
            .is_some_and(|value| value != source_key)
        {
            bail!(
                "catalog belongs to another source; create a new work directory instead of mixing backups"
            );
        }
        self.set_meta("source_path", &source_key)?;
        self.set_meta("source_kind", &format!("{kind:?}"))?;
        let source_fingerprint = source_metadata_fingerprint(&source, kind)?;
        let previous_fingerprint = self.meta("source_fingerprint")?;
        let source_changed = previous_fingerprint
            .as_ref()
            .is_some_and(|value| value != &source_fingerprint);
        let source_fingerprint_missing =
            existing_source.is_some() && previous_fingerprint.is_none();
        if source_changed || source_fingerprint_missing {
            self.clear_all_removal_plans()?;
            self.connection
                .execute("UPDATE files SET sha256 = NULL", [])?;
            self.connection.execute("DELETE FROM chats", [])?;
            self.set_meta("hash_status", "not_started")?;
            self.set_meta("chat_index_status", "not_started")?;
        }
        self.set_meta("source_fingerprint", &source_fingerprint)?;
        let resume_scan = matches!(
            self.meta("scan_status")?.as_deref(),
            Some("scanning" | "resumable")
        ) && !source_changed
            && !source_fingerprint_missing
            && kind == SourceKind::Directory
            && self.meta("scan_last_path")?.is_some();
        let scan_id = if resume_scan {
            self.meta("scan_id")?
                .and_then(|value| value.parse::<i64>().ok())
                .context("resumable scan is missing its scan ID")?
        } else {
            self.meta("scan_id")?
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(0)
                + 1
        };
        let resume_after = if resume_scan {
            self.meta("scan_last_path")?
                .filter(|value| !value.is_empty())
        } else {
            None
        };
        self.set_meta("scan_id", &scan_id.to_string())?;
        self.set_meta("scan_status", "scanning")?;
        self.set_meta("chat_index_status", "not_started")?;
        self.connection.execute("DELETE FROM chats", [])?;
        if !resume_scan {
            self.set_meta("scan_last_path", "")?;
        }

        let mut batch = Vec::with_capacity(CATALOG_BATCH_SIZE);
        let mut progress = CatalogScanProgress {
            files: 0,
            bytes: 0,
            attachments: 0,
        };
        match kind {
            SourceKind::Directory => {
                for entry in WalkDir::new(&source)
                    .follow_links(false)
                    .sort_by_file_name()
                {
                    let entry = match entry {
                        Ok(entry) => entry,
                        Err(error) => {
                            eprintln!("skipping unreadable path: {error}");
                            continue;
                        }
                    };
                    if !entry.file_type().is_file() {
                        continue;
                    }
                    let metadata = match entry.metadata() {
                        Ok(metadata) => metadata,
                        Err(error) => {
                            eprintln!("skipping unreadable metadata: {error}");
                            continue;
                        }
                    };
                    let relative = entry.path().strip_prefix(&source).unwrap_or(entry.path());
                    let relative = relative.to_string_lossy().replace('\\', "/");
                    if resume_after
                        .as_deref()
                        .is_some_and(|last| relative.as_str() <= last)
                    {
                        continue;
                    }
                    let content_sha256 = hash_directory_file(
                        entry.path(),
                        metadata.len(),
                        modified_ns(metadata.modified().ok()),
                    )?;
                    batch.push(file_record(
                        relative,
                        metadata.len(),
                        modified_ns(metadata.modified().ok()),
                        content_sha256,
                    ));
                    update_progress(&mut progress, batch.last().expect("record exists"));
                    if batch.len() == CATALOG_BATCH_SIZE {
                        let last_path = batch.last().expect("record exists").path.clone();
                        self.upsert_batch(scan_id, &mut batch)?;
                        self.set_meta("scan_last_path", &last_path)?;
                        on_progress(progress);
                    }
                }
            }
            SourceKind::ImazingArchive => {
                let file = File::open(&source)?;
                let archive = ZipArchive::new(file)?;
                let entry_count = archive.len();
                drop(archive);
                let workers = system_performance_profile()
                    .archive_workers_for(fs::metadata(&source)?.len(), entry_count);
                scan_archive_records_parallel(&source, entry_count, workers, |record| {
                    batch.push(record);
                    update_progress(&mut progress, batch.last().expect("record exists"));
                    if batch.len() == CATALOG_BATCH_SIZE {
                        let last_path = batch.last().expect("record exists").path.clone();
                        self.upsert_batch(scan_id, &mut batch)?;
                        self.set_meta("scan_last_path", &last_path)?;
                        on_progress(progress);
                    }
                    Ok(())
                })?;
            }
            SourceKind::Sqlite => {
                let metadata = fs::metadata(&source)?;
                let path = source
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                batch.push(file_record(
                    path,
                    metadata.len(),
                    modified_ns(metadata.modified().ok()),
                    hash_directory_file(
                        &source,
                        metadata.len(),
                        modified_ns(metadata.modified().ok()),
                    )?,
                ));
                update_progress(&mut progress, batch.last().expect("record exists"));
            }
        }
        if !batch.is_empty() {
            let last_path = batch.last().expect("record exists").path.clone();
            self.upsert_batch(scan_id, &mut batch)?;
            self.set_meta("scan_last_path", &last_path)?;
        }
        if kind == SourceKind::ImazingArchive
            && source_metadata_fingerprint(&source, kind)? != source_fingerprint
        {
            bail!("source .imazingapp changed while its catalog was being scanned");
        }
        self.connection
            .execute("DELETE FROM files WHERE seen_scan <> ?1", [scan_id])?;
        self.set_meta("scan_status", "complete")?;
        self.set_meta("scan_last_path", "")?;
        self.set_meta("scan_completed_at", &unix_seconds().to_string())?;
        on_progress(progress);
        self.stats()
    }

    pub fn list_attachments(
        &self,
        cursor: Option<AttachmentCursor>,
        limit: u32,
        kind: Option<AttachmentKind>,
        search: Option<&str>,
    ) -> Result<AttachmentPage> {
        let limit = checked_page_size(limit)?;
        let search = search
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| format!("%{}%", escape_like(value)));
        let kind_value = kind.map(AttachmentKind::as_str);
        let sql = format!(
            "
            SELECT {ATTACHMENT_COLUMNS}
            FROM files f
            LEFT JOIN all_removal_plan p ON p.path = f.path
            WHERE f.attachment_kind IS NOT NULL
              AND f.id > ?1
              AND (?2 IS NULL OR f.attachment_kind = ?2)
              AND (?3 IS NULL OR f.path LIKE ?3 ESCAPE '\\')
            ORDER BY f.id ASC
            LIMIT ?4
            "
        );
        let mut statement = self.connection.prepare(&sql)?;
        let rows = statement.query_map(
            params![
                cursor.map(|value| value.id).unwrap_or(0),
                kind_value,
                search,
                limit as i64 + 1
            ],
            attachment_from_row,
        )?;
        let mut items = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        let has_extra = items.len() > limit;
        if has_extra {
            items.pop();
        }
        let next_cursor = if has_extra {
            items
                .last()
                .map(|attachment| AttachmentCursor { id: attachment.id })
        } else {
            None
        };
        Ok(AttachmentPage { items, next_cursor })
    }

    pub fn set_marked(&self, path: &str, marked: bool) -> Result<()> {
        let exists: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM files WHERE path = ?1 AND attachment_kind IS NOT NULL)",
            [path],
            |row| row.get(0),
        )?;
        if !exists {
            bail!("attachment path is not present in this catalog");
        }
        let bytes: i64 = self.connection.query_row(
            "SELECT bytes FROM files WHERE path = ?1",
            [path],
            |row| row.get(0),
        )?;
        let transaction = self.connection.unchecked_transaction()?;
        if marked {
            transaction.execute(
                "INSERT INTO removal_plan(path, marked_at, reason) VALUES (?1, ?2, 'manual')
                 ON CONFLICT(path) DO UPDATE SET
                    marked_at = excluded.marked_at,
                    reason = 'manual'",
                params![path, unix_seconds()],
            )?;
        } else {
            transaction.execute("DELETE FROM removal_plan WHERE path = ?1", [path])?;
        }
        transaction.execute(
            "INSERT INTO cleanup_activity(
                action, scope, detail, file_count, bytes, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                if marked {
                    "mark_attachment"
                } else {
                    "unmark_attachment"
                },
                "attachment",
                path,
                1,
                bytes.max(0),
                unix_seconds(),
            ],
        )?;
        transaction.execute(
            "DELETE FROM cleanup_activity
             WHERE id < COALESCE(
                 (SELECT id FROM cleanup_activity ORDER BY id DESC LIMIT 1 OFFSET 499),
                 0
             )",
            [],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn clear_manual_attachment_plan(&self) -> Result<CleanupOverview> {
        let (file_count, bytes): (i64, i64) = self.connection.query_row(
            "SELECT COUNT(*), COALESCE(SUM(f.bytes), 0)
             FROM removal_plan p JOIN files f ON f.path = p.path
             WHERE p.reason = 'manual'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        self.connection
            .execute("DELETE FROM removal_plan WHERE reason = 'manual'", [])?;
        self.record_cleanup_activity(
            "clear_manual_plan",
            "attachment_plan",
            "manual",
            file_count.max(0) as u64,
            bytes.max(0) as u64,
        )?;
        self.cleanup_overview()
    }

    pub fn plan_safe_attachment_cleanup(&self) -> Result<CleanupOverview> {
        let already_planned: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM removal_plan WHERE reason = 'automatic')",
            [],
            |row| row.get(0),
        )?;
        if already_planned {
            self.connection
                .execute("DELETE FROM removal_plan WHERE reason = 'automatic'", [])?;
        } else {
            let sql = format!(
                "INSERT OR IGNORE INTO removal_plan(path, marked_at, reason)
                 SELECT f.path, ?1, 'automatic'
                 FROM files f
                 WHERE {THUMBNAIL_BACKED_IMAGE_EXPR}
                   AND NOT EXISTS (
                       SELECT 1 FROM all_removal_plan planned WHERE planned.path = f.path
                   )"
            );
            self.connection.execute(&sql, [unix_seconds()])?;
        }
        let overview = self.cleanup_overview()?;
        self.record_cleanup_activity(
            if already_planned {
                "clear_safe_automatic_plan"
            } else {
                "plan_safe_automatic"
            },
            "attachment_plan",
            "thumbnail_backed_images",
            overview.automatic_marked_count,
            overview.automatic_marked_bytes,
        )?;
        Ok(overview)
    }

    fn record_cleanup_activity(
        &self,
        action: &str,
        scope: &str,
        detail: &str,
        file_count: u64,
        bytes: u64,
    ) -> Result<()> {
        self.connection.execute(
            "INSERT INTO cleanup_activity(
                action, scope, detail, file_count, bytes, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                action,
                scope,
                detail,
                i64::try_from(file_count).unwrap_or(i64::MAX),
                i64::try_from(bytes).unwrap_or(i64::MAX),
                unix_seconds(),
            ],
        )?;
        self.connection.execute(
            "DELETE FROM cleanup_activity
             WHERE id < COALESCE(
                 (SELECT id FROM cleanup_activity ORDER BY id DESC LIMIT 1 OFFSET 499),
                 0
             )",
            [],
        )?;
        Ok(())
    }

    pub fn enrich_messages_with_attachments(&self, messages: &mut [Message]) -> Result<()> {
        if messages.len() > crate::model::MAX_PAGE_SIZE as usize {
            bail!(
                "message attachment enrichment cannot exceed {} messages",
                crate::model::MAX_PAGE_SIZE
            );
        }
        for message in messages.iter_mut() {
            message.attachments.clear();
        }
        if messages.is_empty() {
            return Ok(());
        }
        let mut message_indexes = HashMap::new();
        for (index, message) in messages.iter().enumerate() {
            message_indexes.insert(
                (
                    message.source.clone(),
                    message.pk,
                    message.chat_pk,
                    message.id.clone(),
                ),
                index,
            );
        }
        let mut message_pks = messages
            .iter()
            .map(|message| message.pk)
            .collect::<Vec<_>>();
        message_pks.sort_unstable();
        message_pks.dedup();
        for chunk in message_pks.chunks(200) {
            let placeholders = std::iter::repeat_n("?", chunk.len())
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "SELECT f.context_source, f.message_pk, f.message_chat_pk, f.message_id, \
                        f.path, f.bytes, f.attachment_kind \
                 FROM files f \
                 WHERE f.reference_status = 'referenced' \
                   AND f.attachment_kind IS NOT NULL \
                   AND f.message_pk IN ({placeholders}) \
                 ORDER BY f.message_pk, \
                          CASE f.attachment_kind WHEN 'original' THEN 0 ELSE 1 END, \
                          f.path"
            );
            let mut statement = self.connection.prepare(&sql)?;
            let mut rows = statement.query(rusqlite::params_from_iter(chunk.iter().copied()))?;
            while let Some(row) = rows.next()? {
                let source: String = row.get(0)?;
                let message_pk: i64 = row.get(1)?;
                let chat_pk: i64 = row.get(2)?;
                let message_id: String = row.get(3)?;
                let Some(index) = message_indexes
                    .get(&(source, message_pk, chat_pk, message_id))
                    .copied()
                else {
                    continue;
                };
                let bytes: i64 = row.get(5)?;
                messages[index].attachments.push(MessageAttachment {
                    path: row.get(4)?,
                    bytes: u64::try_from(bytes)
                        .context("catalog attachment has an invalid byte size")?,
                    kind: row.get::<_, String>(6)?.parse()?,
                });
            }
        }
        Ok(())
    }

    pub fn stage_attachment_preview(
        &self,
        source: &Path,
        source_kind: SourceKind,
        path: &str,
    ) -> Result<AttachmentPreview> {
        if path.is_empty() || path.len() > 4_096 {
            bail!("invalid attachment preview path");
        }
        let bytes = self
            .connection
            .query_row(
                "SELECT bytes FROM files
                 WHERE path = ?1 AND attachment_kind IS NOT NULL",
                [path],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .context("attachment preview path is not present in this catalog")?;
        let bytes = u64::try_from(bytes).context("attachment preview has an invalid size")?;
        if bytes == 0 || bytes > MAX_PREVIEW_BYTES {
            bail!("attachment preview must be between 1 byte and {MAX_PREVIEW_BYTES} bytes");
        }
        let source = source
            .canonicalize()
            .with_context(|| format!("source does not exist: {}", source.display()))?;
        validate_bound_source(self, &source)?;
        let staged_path = match source_kind {
            SourceKind::Directory => {
                let candidate = source.join(path);
                let candidate = candidate
                    .canonicalize()
                    .with_context(|| format!("attachment preview does not exist: {path}"))?;
                if !candidate.starts_with(&source) || !candidate.is_file() {
                    bail!("attachment preview escapes the selected source");
                }
                candidate
            }
            SourceKind::ImazingArchive => self.stage_archive_preview(&source, path, bytes)?,
            SourceKind::Sqlite => bail!("a direct Line.sqlite source has no attachment previews"),
        };
        let media_type = detect_image_media_type(&staged_path)?
            .context("attachment is not a supported image")?;
        Ok(AttachmentPreview {
            staged_path: staged_path.display().to_string(),
            media_type: media_type.to_string(),
            bytes,
        })
    }

    fn stage_archive_preview(&self, source: &Path, path: &str, bytes: u64) -> Result<PathBuf> {
        let cache = self
            .path
            .parent()
            .context("catalog has no working directory")?
            .join("preview-cache");
        fs::create_dir_all(&cache)?;
        let digest = Sha256::digest(path.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let extension = Path::new(path)
            .extension()
            .and_then(|value| value.to_str())
            .filter(|value| {
                !value.is_empty()
                    && value.len() <= 8
                    && value
                        .chars()
                        .all(|character| character.is_ascii_alphanumeric())
            })
            .unwrap_or("bin");
        let destination = cache.join(format!("{digest}.{extension}"));
        if destination
            .metadata()
            .is_ok_and(|metadata| metadata.len() == bytes)
        {
            OpenOptions::new()
                .read(true)
                .open(&destination)?
                .set_times(FileTimes::new().set_modified(SystemTime::now()))?;
            return Ok(destination);
        }
        trim_preview_cache(&cache, MAX_STAGED_PREVIEWS.saturating_sub(1))?;
        let file = File::open(source)?;
        let mut archive = ZipArchive::new(file)?;
        let mut entry = archive
            .by_name(path)
            .with_context(|| format!("attachment preview is missing from archive: {path}"))?;
        if entry.is_dir() || entry.size() != bytes || entry.size() > MAX_PREVIEW_BYTES {
            bail!("archive preview metadata does not match the catalog");
        }
        let temporary = destination.with_extension("part");
        {
            let mut output = BufWriter::new(File::create(&temporary)?);
            let copied = std::io::copy(&mut entry, &mut output)?;
            output.flush()?;
            if copied != bytes {
                let _ = fs::remove_file(&temporary);
                bail!("archive preview extraction was incomplete");
            }
        }
        fs::rename(&temporary, &destination)?;
        Ok(destination)
    }

    pub fn index_attachment_contexts<F>(
        &mut self,
        database: &LineDatabase,
        square_database: Option<&LineSquareDatabase>,
        unified_group_database: Option<&UnifiedGroupDatabase>,
        mut on_progress: F,
    ) -> Result<CatalogContextProgress>
    where
        F: FnMut(CatalogContextProgress),
    {
        let total_files = self.connection.query_row(
            "SELECT COUNT(*) FROM files WHERE attachment_kind IS NOT NULL",
            [],
            |row| row.get::<_, i64>(0),
        )?;
        self.set_meta("context_status", "indexing")?;
        let mut progress = CatalogContextProgress {
            processed_files: 0,
            total_files: total_files.max(0) as u64,
            referenced_files: 0,
            unreferenced_files: 0,
            unconfirmed_files: 0,
        };
        on_progress(progress);
        self.connection.execute(
            "
            UPDATE files SET
                message_pk = NULL,
                message_chat_pk = NULL,
                message_timestamp = NULL,
                message_sender_pk = NULL,
                message_sender_name = NULL,
                message_content_type = NULL,
                message_text = NULL,
                context_source = NULL,
                context_chat_id = NULL,
                context_chat_title = NULL,
                context_chat_kind = NULL,
                reference_status = 'unconfirmed'
            WHERE attachment_kind IS NOT NULL
            ",
            [],
        )?;
        let mut after_id = 0_i64;
        loop {
            let records = {
                let mut statement = self.connection.prepare(
                    "
                    SELECT id, message_id, chat_hint
                    FROM files
                    WHERE attachment_kind IS NOT NULL AND id > ?1
                    ORDER BY id ASC
                    LIMIT ?2
                    ",
                )?;
                let rows =
                    statement.query_map(params![after_id, CONTEXT_BATCH_SIZE as i64], |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    })?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            if records.is_empty() {
                break;
            }
            after_id = records.last().map(|record| record.0).unwrap_or(after_id);
            let mut message_ids = records
                .iter()
                .map(|record| record.1.clone())
                .filter(|message_id| !message_id.is_empty())
                .collect::<Vec<_>>();
            message_ids.sort_unstable();
            message_ids.dedup();
            let mut contexts = database.attachment_contexts(&message_ids)?;
            if let Some(square_database) = square_database {
                for (message_id, mut candidates) in
                    square_database.attachment_contexts(&message_ids)?
                {
                    contexts
                        .entry(message_id)
                        .or_default()
                        .append(&mut candidates);
                }
            }
            database.enrich_attachment_context_titles(
                &mut contexts,
                unified_group_database,
                square_database,
            )?;
            let transaction = self.connection.transaction()?;
            {
                let mut update = transaction.prepare(
                    "
                    UPDATE files SET
                        message_pk = ?2,
                        message_chat_pk = ?3,
                        message_timestamp = ?4,
                        message_sender_pk = ?5,
                        message_sender_name = ?6,
                        message_content_type = ?7,
                        message_text = ?8,
                        context_source = ?9,
                        context_chat_id = ?10,
                        context_chat_title = ?11,
                        context_chat_kind = ?12,
                        reference_status = ?13
                    WHERE id = ?1
                    ",
                )?;
                for (id, message_id, chat_hint) in &records {
                    let candidates = contexts.get(message_id).map(Vec::as_slice).unwrap_or(&[]);
                    let exact = candidates
                        .iter()
                        .filter(|context| context.chat_id.eq_ignore_ascii_case(chat_hint))
                        .collect::<Vec<_>>();
                    let context = (exact.len() == 1).then(|| exact[0]);
                    let reference_status = if context.is_some() {
                        progress.referenced_files += 1;
                        "referenced"
                    } else if message_id.is_empty()
                        || chat_hint.is_empty()
                        || !candidates.is_empty()
                    {
                        progress.unconfirmed_files += 1;
                        "unconfirmed"
                    } else {
                        progress.unreferenced_files += 1;
                        "unreferenced"
                    };
                    if let Some(context) = context {
                        update.execute(params![
                            id,
                            context.message_pk,
                            context.chat_pk,
                            context.timestamp,
                            context.sender_pk,
                            context.sender_name,
                            context.content_type,
                            context.text,
                            context.source,
                            context.chat_id,
                            context.chat_title,
                            context.chat_kind,
                            reference_status,
                        ])?;
                    } else {
                        update.execute(params![
                            id,
                            Option::<i64>::None,
                            Option::<i64>::None,
                            Option::<i64>::None,
                            Option::<i64>::None,
                            Option::<String>::None,
                            Option::<i64>::None,
                            Option::<String>::None,
                            Option::<String>::None,
                            Option::<String>::None,
                            Option::<String>::None,
                            Option::<String>::None,
                            reference_status,
                        ])?;
                    }
                    progress.processed_files += 1;
                }
            }
            transaction.commit()?;
            on_progress(progress);
        }
        self.set_meta("context_status", "complete")?;
        self.set_meta("context_index_version", CONTEXT_INDEX_VERSION)?;
        self.set_meta("context_completed_at", &unix_seconds().to_string())?;
        self.refresh_chat_removal_files()?;
        self.refresh_all_chat_attachment_plan()?;
        on_progress(progress);
        Ok(progress)
    }

    pub fn enrich_planned_chats(&self, chats: &mut [Chat]) -> Result<()> {
        let mut statement = self
            .connection
            .prepare("SELECT source, chat_pk FROM chat_removal_plan")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        let planned = rows.collect::<rusqlite::Result<std::collections::HashSet<_>>>()?;
        for chat in chats {
            chat.planned_for_removal = planned.contains(&(chat.source.clone(), chat.pk));
        }
        Ok(())
    }

    pub fn replace_chat_index(&mut self, chats: &[Chat]) -> Result<()> {
        self.set_meta("chat_index_status", "indexing")?;
        let transaction = self.connection.transaction()?;
        transaction.execute("DELETE FROM chats", [])?;
        {
            let mut insert = transaction.prepare(
                "
                INSERT OR REPLACE INTO chats(
                    source, chat_pk, chat_id, chat_type, chat_kind, title, title_source,
                    message_count, human_message_count, last_updated, last_message
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                ",
            )?;
            for chat in chats {
                if !matches!(chat.source.as_str(), "line" | "square") {
                    bail!("chat index source must be `line` or `square`");
                }
                insert.execute(params![
                    chat.source,
                    chat.pk,
                    chat.id,
                    chat.chat_type,
                    chat.kind,
                    chat.title,
                    chat.title_source,
                    chat.message_count,
                    chat.human_message_count,
                    chat.last_updated,
                    chat.last_message,
                ])?;
            }
        }
        transaction.commit()?;
        self.set_meta("chat_index_version", CHAT_INDEX_VERSION)?;
        self.set_meta("chat_index_status", "complete")?;
        self.set_meta("chat_index_completed_at", &unix_seconds().to_string())?;
        Ok(())
    }

    pub fn chat_index_is_current(&self) -> Result<bool> {
        Ok(
            self.meta("chat_index_status")?.as_deref() == Some("complete")
                && self.meta("chat_index_version")?.as_deref() == Some(CHAT_INDEX_VERSION),
        )
    }

    pub fn list_indexed_chats(
        &self,
        after_cursor: Option<crate::model::ChatCursor>,
        before_cursor: Option<crate::model::ChatCursor>,
        limit: u32,
    ) -> Result<crate::model::ChatPage> {
        if after_cursor.is_some() && before_cursor.is_some() {
            bail!("chat pagination cannot use both after and before cursors");
        }
        if !self.chat_index_is_current()? {
            bail!("derived chat index is not ready");
        }
        let limit = checked_page_size(limit)?;
        let boundary = after_cursor.as_ref().or(before_cursor.as_ref());
        let cursor_filter = if before_cursor.is_some() {
            "
            AND (
                c.last_updated > ?1
                OR (
                    c.last_updated = ?1
                    AND (
                        c.source < ?2
                        OR (c.source = ?2 AND c.chat_pk < ?3)
                    )
                )
            )
            "
        } else if after_cursor.is_some() {
            "
            AND (
                c.last_updated < ?1
                OR (
                    c.last_updated = ?1
                    AND (
                        c.source > ?2
                        OR (c.source = ?2 AND c.chat_pk > ?3)
                    )
                )
            )
            "
        } else {
            ""
        };
        let order = if before_cursor.is_some() {
            "c.last_updated ASC, c.source DESC, c.chat_pk DESC"
        } else {
            "c.last_updated DESC, c.source ASC, c.chat_pk ASC"
        };
        let sql = format!(
            "
            SELECT c.chat_pk, c.source, c.chat_id, c.chat_type, c.chat_kind, c.title,
                   c.title_source, c.message_count, c.human_message_count, c.last_updated,
                   c.last_message,
                   EXISTS(
                       SELECT 1 FROM chat_removal_plan planned
                       WHERE planned.source = c.source AND planned.chat_pk = c.chat_pk
                   )
            FROM chats c
            WHERE c.message_count > 0
            {cursor_filter}
            ORDER BY {order}
            LIMIT ?4
            "
        );
        let fallback_cursor = crate::model::ChatCursor {
            last_updated: i64::MAX,
            source: "line".to_string(),
            pk: 0,
        };
        let cursor = boundary.unwrap_or(&fallback_cursor);
        let mut statement = self.connection.prepare(&sql)?;
        let mut rows = statement.query(params![
            cursor.last_updated,
            cursor.source,
            cursor.pk,
            limit as i64 + 1
        ])?;
        let mut items = Vec::with_capacity(limit);
        while let Some(row) = rows.next()? {
            items.push(Chat {
                pk: row.get(0)?,
                source: row.get(1)?,
                id: row.get(2)?,
                chat_type: row.get(3)?,
                kind: row.get(4)?,
                title: row.get(5)?,
                title_source: row.get(6)?,
                message_count: row.get(7)?,
                human_message_count: row.get(8)?,
                last_updated: row.get(9)?,
                last_message: row.get(10)?,
                planned_for_removal: row.get(11)?,
            });
        }
        let has_extra = items.len() > limit;
        if has_extra {
            items.pop();
        }
        if before_cursor.is_some() {
            items.reverse();
        }
        let next_cursor = if (before_cursor.is_some() && !items.is_empty()) || has_extra {
            items.last().map(|chat| crate::model::ChatCursor {
                last_updated: chat.last_updated,
                source: chat.source.clone(),
                pk: chat.pk,
            })
        } else {
            None
        };
        Ok(crate::model::ChatPage {
            items,
            next_cursor,
            has_previous: if before_cursor.is_some() {
                has_extra
            } else {
                after_cursor.is_some()
            },
        })
    }

    pub fn set_chat_removal_planned(&self, chat: &Chat, planned: bool, reason: &str) -> Result<()> {
        if !matches!(chat.source.as_str(), "line" | "square") {
            bail!("chat cleanup source must be `line` or `square`");
        }
        if !matches!(reason, "selected" | "empty" | "system_only") {
            bail!("invalid chat cleanup reason");
        }
        if planned && chat.source == "square" && self.bulk_cleanup_planned("community")? {
            bail!("all community data is already included in the cleanup plan");
        }
        let transaction = self.connection.unchecked_transaction()?;
        if planned {
            transaction.execute(
                "
                INSERT INTO chat_removal_plan(
                    source, chat_pk, chat_id, chat_title, chat_kind,
                    message_count, human_message_count, reason, marked_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                ON CONFLICT(source, chat_pk) DO UPDATE SET
                    chat_id = excluded.chat_id,
                    chat_title = excluded.chat_title,
                    chat_kind = excluded.chat_kind,
                    message_count = excluded.message_count,
                    human_message_count = excluded.human_message_count,
                    reason = CASE
                        WHEN chat_removal_plan.reason = 'selected'
                        THEN chat_removal_plan.reason
                        ELSE excluded.reason
                    END,
                    marked_at = excluded.marked_at
                ",
                params![
                    chat.source,
                    chat.pk,
                    chat.id,
                    chat.title,
                    chat.kind,
                    chat.message_count,
                    chat.human_message_count,
                    reason,
                    unix_seconds(),
                ],
            )?;
            transaction.execute(
                "
                INSERT OR IGNORE INTO chat_removal_files(source, chat_pk, path, marked_at)
                SELECT ?1, ?2, f.path, ?3
                FROM files f
                WHERE f.attachment_kind IS NOT NULL
                  AND (
                      (
                          f.reference_status = 'referenced'
                          AND f.context_source = ?1
                          AND f.message_chat_pk = ?2
                      )
                      OR (
                          ?4 <> ''
                          AND LOWER(f.chat_hint) = LOWER(?4)
                          AND (
                              f.reference_status <> 'referenced'
                              OR (
                                  f.context_source = ?1
                                  AND f.message_chat_pk = ?2
                              )
                          )
                      )
                  )
                ",
                params![chat.source, chat.pk, unix_seconds(), chat.id],
            )?;
        } else {
            transaction.execute(
                "DELETE FROM chat_removal_files WHERE source = ?1 AND chat_pk = ?2",
                params![chat.source, chat.pk],
            )?;
            transaction.execute(
                "DELETE FROM chat_removal_plan WHERE source = ?1 AND chat_pk = ?2",
                params![chat.source, chat.pk],
            )?;
        }
        transaction.commit()?;
        self.record_cleanup_activity(
            if planned {
                "plan_chat_removal"
            } else {
                "clear_chat_removal"
            },
            "chat",
            &format!("{}:{}", chat.source, chat.pk),
            0,
            0,
        )?;
        Ok(())
    }

    pub fn set_community_cleanup_planned(
        &self,
        chats: &[Chat],
        message_count: u64,
        database_entry: &str,
        planned: bool,
    ) -> Result<()> {
        if database_entry.is_empty()
            || database_entry.starts_with('/')
            || database_entry.contains('\\')
            || !database_entry.ends_with("/Messages/LineSquare.sqlite")
        {
            bail!("invalid LineSquare.sqlite source path");
        }
        if chats.iter().any(|chat| chat.source != "square") {
            bail!("community cleanup received a non-community chat");
        }
        let cleanup_paths = self.community_cleanup_paths(chats, database_entry)?;
        let cleanup_file_count = cleanup_paths.len() as u64;
        let cleanup_bytes = cleanup_paths
            .iter()
            .map(|(_, bytes)| *bytes)
            .fold(0_u64, u64::saturating_add);
        if planned && !cleanup_paths.iter().any(|(path, _)| path == database_entry) {
            bail!("LineSquare.sqlite is missing from the attachment catalog");
        }
        let chat_count = i64::try_from(chats.len()).context("too many community chats")?;
        let message_count = i64::try_from(message_count).context("too many community messages")?;
        let transaction = self.connection.unchecked_transaction()?;
        if planned {
            transaction.execute("DELETE FROM chat_removal_files WHERE source = 'square'", [])?;
            transaction.execute("DELETE FROM chat_removal_plan WHERE source = 'square'", [])?;
            transaction.execute("DELETE FROM orphan_message_removal_plan", [])?;
            transaction.execute(
                "
                INSERT INTO bulk_cleanup_plan(
                    reason, chat_count, message_count, marked_at
                ) VALUES ('community', ?1, ?2, ?3)
                ON CONFLICT(reason) DO UPDATE SET
                    chat_count = excluded.chat_count,
                    message_count = excluded.message_count,
                    marked_at = excluded.marked_at
                ",
                params![chat_count, message_count, unix_seconds()],
            )?;
            {
                let mut insert = transaction.prepare(
                    "
                    INSERT OR IGNORE INTO bulk_removal_plan(reason, path, marked_at)
                    VALUES ('community', ?1, ?2)
                    ",
                )?;
                for (path, _) in cleanup_paths {
                    insert.execute(params![path, unix_seconds()])?;
                }
            }
        } else {
            transaction.execute(
                "DELETE FROM bulk_removal_plan WHERE reason = 'community'",
                [],
            )?;
            transaction.execute(
                "DELETE FROM bulk_cleanup_plan WHERE reason = 'community'",
                [],
            )?;
        }
        transaction.commit()?;
        self.record_cleanup_activity(
            if planned {
                "plan_community_cleanup"
            } else {
                "clear_community_cleanup"
            },
            "bulk_plan",
            "community",
            if planned { cleanup_file_count } else { 0 },
            if planned { cleanup_bytes } else { 0 },
        )?;
        Ok(())
    }

    pub fn community_cleanup_summary(
        &self,
        chats: &[Chat],
        database_entry: &str,
    ) -> Result<BulkRemovalSummary> {
        let paths = self.community_cleanup_paths(chats, database_entry)?;
        Ok(BulkRemovalSummary {
            files: paths.len() as u64,
            bytes: paths
                .iter()
                .map(|(_, bytes)| *bytes)
                .fold(0_u64, u64::saturating_add),
        })
    }

    fn community_cleanup_paths(
        &self,
        chats: &[Chat],
        database_entry: &str,
    ) -> Result<Vec<(String, u64)>> {
        let mut paths = HashMap::new();
        let database_paths = [
            database_entry.to_string(),
            format!("{database_entry}-wal"),
            format!("{database_entry}-shm"),
        ];
        {
            let mut statement = self.connection.prepare(
                "
                SELECT path, bytes
                FROM files
                WHERE path IN (?1, ?2, ?3)
                   OR (attachment_kind IS NOT NULL AND context_source = 'square')
                ",
            )?;
            let rows = statement.query_map(
                params![database_paths[0], database_paths[1], database_paths[2]],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )?;
            for row in rows {
                let (path, bytes) = row?;
                paths.insert(path, bytes.max(0) as u64);
            }
        }
        {
            let mut statement = self.connection.prepare(
                "
                SELECT path, bytes
                FROM files
                WHERE attachment_kind IS NOT NULL
                  AND ?1 <> ''
                  AND LOWER(chat_hint) = LOWER(?1)
                ",
            )?;
            for chat in chats {
                let rows = statement.query_map([&chat.id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })?;
                for row in rows {
                    let (path, bytes) = row?;
                    paths.insert(path, bytes.max(0) as u64);
                }
            }
        }
        let mut paths = paths.into_iter().collect::<Vec<_>>();
        paths.sort_by(|left, right| left.0.cmp(&right.0));
        Ok(paths)
    }

    pub fn old_account_summary(
        &self,
        current_account_id: Option<&str>,
    ) -> Result<OldAccountSummary> {
        let mut account_prefixes = HashSet::new();
        let mut old_account_prefixes = HashSet::new();
        let mut current_account_found = false;
        let mut old_account_files = 0_u64;
        let mut old_account_bytes = 0_u64;
        let mut statement = self
            .connection
            .prepare("SELECT path, bytes FROM files ORDER BY path")?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let path: String = row.get(0)?;
            let bytes: i64 = row.get(1)?;
            let Some((account_id, prefix)) = private_store_account_from_path(&path) else {
                continue;
            };
            account_prefixes.insert(prefix.clone());
            if current_account_id == Some(account_id) {
                current_account_found = true;
            } else if current_account_id.is_some() {
                old_account_prefixes.insert(prefix);
                old_account_files = old_account_files.saturating_add(1);
                old_account_bytes = old_account_bytes.saturating_add(bytes.max(0) as u64);
            }
        }
        let old_account_folders = if current_account_found {
            old_account_prefixes.len() as u64
        } else {
            0
        };
        Ok(OldAccountSummary {
            current_account_found,
            account_folders: account_prefixes.len() as u64,
            old_account_folders,
            old_account_files,
            old_account_bytes,
        })
    }

    pub fn set_old_account_cleanup_planned(
        &self,
        current_account_id: Option<&str>,
        planned: bool,
    ) -> Result<()> {
        let current_account_id =
            current_account_id.context("cannot identify the current LINE account")?;
        let summary = self.old_account_summary(Some(current_account_id))?;
        if !summary.current_account_found {
            bail!("the verified current LINE account folder is missing from the catalog");
        }
        let transaction = self.connection.unchecked_transaction()?;
        transaction.execute(
            "DELETE FROM bulk_removal_plan WHERE reason = 'old_account'",
            [],
        )?;
        transaction.execute(
            "DELETE FROM bulk_removal_scope WHERE reason = 'old_account'",
            [],
        )?;
        transaction.execute(
            "DELETE FROM bulk_cleanup_plan WHERE reason = 'old_account'",
            [],
        )?;
        if planned {
            let mut files = Vec::new();
            {
                let mut statement = transaction.prepare("SELECT path FROM files ORDER BY path")?;
                let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
                for row in rows {
                    let path = row?;
                    let Some((account_id, prefix)) = private_store_account_from_path(&path) else {
                        continue;
                    };
                    if account_id != current_account_id {
                        files.push((path, prefix.to_string()));
                    }
                }
            }
            let mut prefixes = HashSet::new();
            {
                let mut insert_file = transaction.prepare(
                    "
                    INSERT OR IGNORE INTO bulk_removal_plan(reason, path, marked_at)
                    VALUES ('old_account', ?1, ?2)
                    ",
                )?;
                for (path, prefix) in files {
                    insert_file.execute(params![path, unix_seconds()])?;
                    prefixes.insert(prefix);
                }
            }
            {
                let mut insert_scope = transaction.prepare(
                    "
                    INSERT OR IGNORE INTO bulk_removal_scope(reason, path_prefix, marked_at)
                    VALUES ('old_account', ?1, ?2)
                    ",
                )?;
                let has_old_accounts = !prefixes.is_empty();
                for prefix in prefixes {
                    insert_scope.execute(params![prefix, unix_seconds()])?;
                }
                if has_old_accounts {
                    transaction.execute(
                        "
                        INSERT INTO bulk_cleanup_plan(
                            reason, chat_count, message_count, marked_at
                        ) VALUES ('old_account', 0, 0, ?1)
                        ",
                        [unix_seconds()],
                    )?;
                }
            }
        }
        transaction.commit()?;
        self.record_cleanup_activity(
            if planned {
                "plan_old_account_cleanup"
            } else {
                "clear_old_account_cleanup"
            },
            "bulk_plan",
            "old_account",
            if planned {
                summary.old_account_files
            } else {
                0
            },
            if planned {
                summary.old_account_bytes
            } else {
                0
            },
        )?;
        Ok(())
    }

    pub fn bulk_cleanup_planned(&self, reason: &str) -> Result<bool> {
        if !matches!(reason, "community" | "old_account") {
            bail!("unsupported bulk cleanup reason");
        }
        self.connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM bulk_cleanup_plan WHERE reason = ?1)",
                [reason],
                |row| row.get(0),
            )
            .map_err(Into::into)
    }

    pub fn bulk_cleanup_counts(&self) -> Result<(u64, u64)> {
        let (chats, messages): (i64, i64) = self.connection.query_row(
            "
            SELECT COALESCE(SUM(chat_count), 0), COALESCE(SUM(message_count), 0)
            FROM bulk_cleanup_plan
            ",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok((chats.max(0) as u64, messages.max(0) as u64))
    }

    pub fn plan_automatic_cleanup(
        &self,
        chats: &[Chat],
        orphan_messages: &[OrphanMessage],
    ) -> Result<()> {
        if self.automatic_cleanup_planned()? {
            self.clear_automatic_cleanup_plan()?;
            self.record_cleanup_activity(
                "clear_automatic_advanced_plan",
                "database_plan",
                "automatic",
                0,
                0,
            )?;
            return Ok(());
        }
        let community_cleanup_planned = self.bulk_cleanup_planned("community")?;
        for chat in chats {
            if community_cleanup_planned && chat.source == "square" {
                continue;
            }
            let reason = if chat.message_count == 0 {
                "empty"
            } else {
                "system_only"
            };
            self.set_chat_removal_planned(chat, true, reason)?;
        }
        let transaction = self.connection.unchecked_transaction()?;
        {
            let mut insert = transaction.prepare(
                "
                INSERT INTO orphan_message_removal_plan(
                    source, message_pk, message_id, chat_pk, marked_at
                ) VALUES ('square', ?1, ?2, ?3, ?4)
                ON CONFLICT(source, message_pk) DO UPDATE SET
                    message_id = excluded.message_id,
                    chat_pk = excluded.chat_pk,
                    marked_at = excluded.marked_at
                ",
            )?;
            for message in orphan_messages
                .iter()
                .filter(|_| !community_cleanup_planned)
            {
                insert.execute(params![
                    message.pk,
                    message.id,
                    message.chat_pk,
                    unix_seconds()
                ])?;
            }
        }
        transaction.commit()?;
        self.record_cleanup_activity(
            "plan_automatic_advanced",
            "database_plan",
            "automatic",
            (chats.len() + orphan_messages.len()) as u64,
            0,
        )?;
        Ok(())
    }

    fn automatic_cleanup_planned(&self) -> Result<bool> {
        self.connection
            .query_row(
                "
            SELECT EXISTS(
                SELECT 1 FROM chat_removal_plan
                WHERE reason IN ('empty', 'system_only')
                UNION ALL
                SELECT 1 FROM orphan_message_removal_plan
            )
            ",
                [],
                |row| row.get(0),
            )
            .map_err(Into::into)
    }

    fn clear_automatic_cleanup_plan(&self) -> Result<()> {
        let transaction = self.connection.unchecked_transaction()?;
        transaction.execute(
            "
            DELETE FROM chat_removal_files
            WHERE (source, chat_pk) IN (
                SELECT source, chat_pk FROM chat_removal_plan
                WHERE reason IN ('empty', 'system_only')
            )
            ",
            [],
        )?;
        transaction.execute(
            "DELETE FROM chat_removal_plan WHERE reason IN ('empty', 'system_only')",
            [],
        )?;
        transaction.execute("DELETE FROM orphan_message_removal_plan", [])?;
        transaction.commit()?;
        Ok(())
    }

    pub fn clear_advanced_cleanup_plan(&self) -> Result<()> {
        let transaction = self.connection.unchecked_transaction()?;
        transaction.execute("DELETE FROM chat_removal_files", [])?;
        transaction.execute("DELETE FROM chat_removal_plan", [])?;
        transaction.execute("DELETE FROM orphan_message_removal_plan", [])?;
        transaction.execute("DELETE FROM bulk_removal_plan", [])?;
        transaction.execute("DELETE FROM bulk_removal_scope", [])?;
        transaction.execute("DELETE FROM bulk_cleanup_plan", [])?;
        transaction.commit()?;
        self.record_cleanup_activity("clear_advanced_plan", "database_plan", "all", 0, 0)?;
        Ok(())
    }

    pub fn clear_all_removal_plans(&self) -> Result<()> {
        let transaction = self.connection.unchecked_transaction()?;
        transaction.execute("DELETE FROM removal_plan", [])?;
        transaction.execute("DELETE FROM chat_removal_files", [])?;
        transaction.execute("DELETE FROM chat_removal_plan", [])?;
        transaction.execute("DELETE FROM orphan_message_removal_plan", [])?;
        transaction.execute("DELETE FROM bulk_removal_plan", [])?;
        transaction.execute("DELETE FROM bulk_removal_scope", [])?;
        transaction.execute("DELETE FROM bulk_cleanup_plan", [])?;
        transaction.execute("DELETE FROM all_chat_attachment_plan", [])?;
        transaction.execute("DELETE FROM cleanup_scope_plan", [])?;
        transaction.commit()?;
        Ok(())
    }

    pub fn clear_all_user_removal_plans(&self) -> Result<CleanupOverview> {
        self.clear_all_removal_plans()?;
        self.record_cleanup_activity("clear_all_plans", "cleanup_plan", "user_reset", 0, 0)?;
        self.cleanup_overview()
    }

    pub fn database_cleanup_plan(&self) -> Result<DatabaseCleanupPlan> {
        let mut chat_statement = self.connection.prepare(
            "SELECT source, chat_pk, message_count
             FROM chat_removal_plan ORDER BY source, chat_pk",
        )?;
        let chats = chat_statement
            .query_map([], |row| {
                Ok(PlannedChat {
                    source: row.get(0)?,
                    chat_pk: row.get(1)?,
                    message_count: row.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut message_statement = self.connection.prepare(
            "SELECT source, message_pk
             FROM orphan_message_removal_plan ORDER BY source, message_pk",
        )?;
        let orphan_messages = message_statement
            .query_map([], |row| {
                Ok(PlannedMessage {
                    source: row.get(0)?,
                    message_pk: row.get(1)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(DatabaseCleanupPlan {
            chats,
            orphan_messages,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn advanced_cleanup_report(
        &self,
        line_empty_chats: u64,
        line_system_only_chats: u64,
        square_available: bool,
        community_chats: u64,
        community_messages: u64,
        community_cleanup: BulkRemovalSummary,
        square_empty_chats: u64,
        square_system_only_chats: u64,
        orphan_community_messages: u64,
        current_account_detected: bool,
        old_accounts: OldAccountSummary,
    ) -> Result<AdvancedCleanupReport> {
        let automatic_cleanup_planned = self.automatic_cleanup_planned()?;
        let community_cleanup_planned = self.bulk_cleanup_planned("community")?;
        let old_account_cleanup_planned = self.bulk_cleanup_planned("old_account")?;
        let (planned_chats, planned_chat_messages): (i64, i64) = self.connection.query_row(
            "SELECT COUNT(*), COALESCE(SUM(message_count), 0)
                 FROM chat_removal_plan",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let planned_orphan_messages: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM orphan_message_removal_plan",
            [],
            |row| row.get(0),
        )?;
        let (planned_files, planned_bytes): (i64, i64) = self.connection.query_row(
            "SELECT COUNT(*), COALESCE(SUM(f.bytes), 0)
             FROM all_removal_plan planned
             JOIN files f ON f.path = planned.path",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok(AdvancedCleanupReport {
            line_empty_chats,
            line_system_only_chats,
            square_available,
            community_chats,
            community_messages,
            community_files: community_cleanup.files,
            community_bytes: community_cleanup.bytes,
            community_cleanup_planned,
            square_empty_chats,
            square_system_only_chats,
            orphan_community_messages,
            current_account_detected,
            account_folders: old_accounts.account_folders,
            old_account_folders: old_accounts.old_account_folders,
            old_account_files: old_accounts.old_account_files,
            old_account_bytes: old_accounts.old_account_bytes,
            old_account_cleanup_planned,
            automatic_cleanup_planned,
            planned_chats: (planned_chats.max(0) as u64).saturating_add(
                if community_cleanup_planned {
                    community_chats
                } else {
                    0
                },
            ),
            planned_database_messages: (planned_chat_messages
                .saturating_add(planned_orphan_messages)
                .max(0) as u64)
                .saturating_add(if community_cleanup_planned {
                    community_messages
                } else {
                    0
                }),
            planned_files: planned_files.max(0) as u64,
            planned_bytes: planned_bytes.max(0) as u64,
        })
    }

    fn refresh_chat_removal_files(&self) -> Result<()> {
        let transaction = self.connection.unchecked_transaction()?;
        transaction.execute("DELETE FROM chat_removal_files", [])?;
        transaction.execute(
            "
            INSERT INTO chat_removal_files(source, chat_pk, path, marked_at)
            SELECT crp.source, crp.chat_pk, f.path, ?1
            FROM chat_removal_plan crp
            JOIN files f
              ON (
                    (
                        f.reference_status = 'referenced'
                        AND f.context_source = crp.source
                        AND f.message_chat_pk = crp.chat_pk
                    )
                    OR (
                        crp.chat_id <> ''
                        AND LOWER(f.chat_hint) = LOWER(crp.chat_id)
                        AND (
                            f.reference_status <> 'referenced'
                            OR (
                                f.context_source = crp.source
                                AND f.message_chat_pk = crp.chat_pk
                            )
                        )
                    )
                 )
            WHERE f.attachment_kind IS NOT NULL
            ",
            [unix_seconds()],
        )?;
        transaction.commit()?;
        Ok(())
    }

    fn refresh_all_chat_attachment_plan(&self) -> Result<()> {
        let transaction = self.connection.unchecked_transaction()?;
        transaction.execute("DELETE FROM all_chat_attachment_plan", [])?;
        let planned: bool = transaction.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM cleanup_scope_plan
                WHERE scope = 'all_chat_attachments'
            )",
            [],
            |row| row.get(0),
        )?;
        if planned {
            transaction.execute(
                "
                INSERT INTO all_chat_attachment_plan(path, marked_at)
                SELECT f.path, ?1
                FROM files f
                WHERE f.attachment_kind IS NOT NULL
                  AND f.reference_status = 'referenced'
                  AND f.context_source IN ('line', 'square')
                  AND f.message_chat_pk IS NOT NULL
                ",
                [unix_seconds()],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn set_all_chat_attachments_planned(&self, planned: bool) -> Result<CleanupOverview> {
        if planned
            && (self.meta("context_index_version")?.as_deref() != Some(CONTEXT_INDEX_VERSION)
                || self.meta("context_status")?.as_deref() != Some("complete"))
        {
            bail!("請先重新掃描附件，再全選所有聊天室附件");
        }
        let transaction = self.connection.unchecked_transaction()?;
        transaction.execute("DELETE FROM all_chat_attachment_plan", [])?;
        transaction.execute(
            "DELETE FROM cleanup_scope_plan WHERE scope = 'all_chat_attachments'",
            [],
        )?;
        if planned {
            let now = unix_seconds();
            transaction.execute(
                "INSERT INTO cleanup_scope_plan(scope, marked_at)
                 VALUES ('all_chat_attachments', ?1)",
                [now],
            )?;
            transaction.execute(
                "
                INSERT INTO all_chat_attachment_plan(path, marked_at)
                SELECT f.path, ?1
                FROM files f
                WHERE f.attachment_kind IS NOT NULL
                  AND f.reference_status = 'referenced'
                  AND f.context_source IN ('line', 'square')
                  AND f.message_chat_pk IS NOT NULL
                ",
                [now],
            )?;
        }
        transaction.commit()?;
        let overview = self.cleanup_overview()?;
        let (file_count, bytes): (i64, i64) = self.connection.query_row(
            "SELECT COUNT(*), COALESCE(SUM(f.bytes), 0)
             FROM all_chat_attachment_plan planned
             JOIN files f ON f.path = planned.path",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        self.record_cleanup_activity(
            if planned {
                "plan_all_chat_attachments"
            } else {
                "clear_all_chat_attachments"
            },
            "attachment_plan",
            "all_chat_attachments",
            u64::try_from(file_count.max(0)).unwrap_or(0),
            u64::try_from(bytes.max(0)).unwrap_or(0),
        )?;
        Ok(overview)
    }

    pub fn cleanup_overview(&self) -> Result<CleanupOverview> {
        let sql = format!(
            "
            SELECT {CLEANUP_CATEGORY_EXPR} AS category,
                   COUNT(*), COALESCE(SUM(f.bytes), 0)
            FROM files f
            WHERE f.attachment_kind IS NOT NULL
            GROUP BY category
            "
        );
        let mut totals = [
            "all",
            "individual",
            "group",
            "community",
            "unreferenced",
            "unconfirmed",
        ]
        .into_iter()
        .map(|category| {
            (
                category.to_string(),
                CleanupCategoryTotal {
                    category: category.to_string(),
                    file_count: 0,
                    bytes: 0,
                },
            )
        })
        .collect::<HashMap<_, _>>();
        let mut statement = self.connection.prepare(&sql)?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?.max(0) as u64,
                row.get::<_, i64>(2)?.max(0) as u64,
            ))
        })?;
        for row in rows {
            let (category, file_count, bytes) = row?;
            let category_key = if totals.contains_key(&category) && category != "all" {
                category.as_str()
            } else {
                "unconfirmed"
            };
            {
                let target = totals.get_mut(category_key).expect("cleanup total exists");
                target.file_count = target.file_count.saturating_add(file_count);
                target.bytes = target.bytes.saturating_add(bytes);
            }
            let all = totals.get_mut("all").expect("all total exists");
            all.file_count = all.file_count.saturating_add(file_count);
            all.bytes = all.bytes.saturating_add(bytes);
        }
        let (marked_count, marked_bytes): (i64, i64) = self.connection.query_row(
            "SELECT COUNT(*), COALESCE(SUM(f.bytes), 0)
             FROM all_removal_plan p JOIN files f ON f.path = p.path",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let (manual_marked_count, manual_marked_bytes): (i64, i64) = self.connection.query_row(
            "SELECT COUNT(*), COALESCE(SUM(f.bytes), 0)
             FROM removal_plan p JOIN files f ON f.path = p.path
             WHERE p.reason = 'manual'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let automatic_candidate_sql = format!(
            "SELECT COUNT(*), COALESCE(SUM(f.bytes), 0)
             FROM files f WHERE {THUMBNAIL_BACKED_IMAGE_EXPR}"
        );
        let (automatic_candidate_count, automatic_candidate_bytes): (i64, i64) = self
            .connection
            .query_row(&automatic_candidate_sql, [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?;
        let (automatic_marked_count, automatic_marked_bytes): (i64, i64) =
            self.connection.query_row(
                "SELECT COUNT(*), COALESCE(SUM(f.bytes), 0)
             FROM removal_plan p JOIN files f ON f.path = p.path
             WHERE p.reason = 'automatic'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
        let categories = [
            "all",
            "individual",
            "group",
            "community",
            "unreferenced",
            "unconfirmed",
        ]
        .into_iter()
        .map(|category| totals.remove(category).expect("cleanup total exists"))
        .collect();
        let all_chat_attachments_planned: bool = self.connection.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM cleanup_scope_plan
                WHERE scope = 'all_chat_attachments'
            )",
            [],
            |row| row.get(0),
        )?;
        Ok(CleanupOverview {
            categories,
            marked_count: marked_count.max(0) as u64,
            marked_bytes: marked_bytes.max(0) as u64,
            manual_marked_count: manual_marked_count.max(0) as u64,
            manual_marked_bytes: manual_marked_bytes.max(0) as u64,
            automatic_candidate_count: automatic_candidate_count.max(0) as u64,
            automatic_candidate_bytes: automatic_candidate_bytes.max(0) as u64,
            automatic_marked_count: automatic_marked_count.max(0) as u64,
            automatic_marked_bytes: automatic_marked_bytes.max(0) as u64,
            context_status: if self.meta("context_index_version")?.as_deref()
                == Some(CONTEXT_INDEX_VERSION)
            {
                self.meta("context_status")?
                    .unwrap_or_else(|| "not_started".to_string())
            } else {
                "stale".to_string()
            },
            all_chat_attachments_planned,
        })
    }

    pub fn cleanup_plan_previews(&self) -> Result<Vec<CleanupPlanPreview>> {
        let safe_sql = format!(
            "SELECT COUNT(*), COALESCE(SUM(f.bytes), 0)
             FROM files f WHERE {THUMBNAIL_BACKED_IMAGE_EXPR}"
        );
        let (automatic_file_count, automatic_bytes): (i64, i64) =
            self.connection
                .query_row(&safe_sql, [], |row| Ok((row.get(0)?, row.get(1)?)))?;
        let (unreferenced_file_count, unreferenced_bytes): (i64, i64) = self
            .connection
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(bytes), 0)
                 FROM files WHERE attachment_kind IS NOT NULL AND reference_status = 'unreferenced'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
        let (unconfirmed_file_count, unconfirmed_bytes): (i64, i64) = self.connection.query_row(
            "SELECT COUNT(*), COALESCE(SUM(bytes), 0)
                 FROM files WHERE attachment_kind IS NOT NULL
                   AND reference_status NOT IN ('referenced', 'unreferenced')",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let planned_chat_count: i64 =
            self.connection
                .query_row("SELECT COUNT(*) FROM chat_removal_plan", [], |row| {
                    row.get(0)
                })?;
        let planned_chat_messages: i64 = self.connection.query_row(
            "SELECT COALESCE(SUM(message_count), 0) FROM chat_removal_plan",
            [],
            |row| row.get(0),
        )?;
        let planned_orphan_messages: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM orphan_message_removal_plan",
            [],
            |row| row.get(0),
        )?;
        let planned_message_count = planned_chat_messages.saturating_add(planned_orphan_messages);
        let automatic_file_count = automatic_file_count.max(0) as u64;
        let automatic_bytes = automatic_bytes.max(0) as u64;
        let unreferenced_file_count = unreferenced_file_count.max(0) as u64;
        let unreferenced_bytes = unreferenced_bytes.max(0) as u64;
        let unconfirmed_file_count = unconfirmed_file_count.max(0) as u64;
        let unconfirmed_bytes = unconfirmed_bytes.max(0) as u64;
        let planned_chat_count = planned_chat_count.max(0) as u64;
        let planned_message_count = planned_message_count.max(0) as u64;

        Ok(vec![
            CleanupPlanPreview {
                profile: "conservative".to_string(),
                title: "保守：只套用安全規則".to_string(),
                description: "只標記有 SQLite 內容與非空縮圖可交叉確認的圖片原檔。".to_string(),
                automatic_file_count,
                automatic_bytes,
                review_file_count: 0,
                review_bytes: 0,
                planned_chat_count,
                planned_message_count,
                warnings: vec![
                    "可直接套用；仍會在建立候選檔前再次驗證來源與保留檔案。".to_string(),
                ],
            },
            CleanupPlanPreview {
                profile: "balanced".to_string(),
                title: "平衡：安全項目＋未引用複核".to_string(),
                description: "保留安全自動標記，另外列出 SQLite 未引用附件供人工逐一確認。"
                    .to_string(),
                automatic_file_count,
                automatic_bytes,
                review_file_count: unreferenced_file_count,
                review_bytes: unreferenced_bytes,
                planned_chat_count,
                planned_message_count,
                warnings: vec![
                    "SQLite 未引用不等於可刪除；未經人工確認不會自動加入清理計畫。".to_string(),
                ],
            },
            CleanupPlanPreview {
                profile: "aggressive".to_string(),
                title: "積極：擴大人工複核範圍".to_string(),
                description: "在平衡方案上，再把無法確認來源的附件列為高風險複核項目。".to_string(),
                automatic_file_count,
                automatic_bytes,
                review_file_count: unreferenced_file_count.saturating_add(unconfirmed_file_count),
                review_bytes: unreferenced_bytes.saturating_add(unconfirmed_bytes),
                planned_chat_count,
                planned_message_count,
                warnings: vec![
                    "無法確認的附件可能屬於備份中未被目前資料庫索引的內容，必須人工檢查。"
                        .to_string(),
                    "現有聊天室與孤兒訊息計畫會另行顯示，不會因預演自動加入。".to_string(),
                ],
            },
        ])
    }

    pub fn cleanup_audit(&self, limit: u32) -> Result<CleanupAuditReport> {
        let limit = limit.clamp(1, 100);
        let plan = self.cleanup_plan_snapshot()?;
        let mut statement = self.connection.prepare(
            "SELECT id, action, scope, detail, file_count, bytes, created_at
             FROM cleanup_activity
             ORDER BY id DESC LIMIT ?1",
        )?;
        let events = statement
            .query_map([i64::from(limit)], |row| {
                Ok(CleanupActivity {
                    id: u64::try_from(row.get::<_, i64>(0)?.max(0)).unwrap_or(0),
                    action: row.get(1)?,
                    scope: row.get(2)?,
                    detail: row.get(3)?,
                    file_count: u64::try_from(row.get::<_, i64>(4)?.max(0)).unwrap_or(0),
                    bytes: u64::try_from(row.get::<_, i64>(5)?.max(0)).unwrap_or(0),
                    created_at: row.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(CleanupAuditReport { plan, events })
    }

    fn cleanup_plan_snapshot(&self) -> Result<CleanupPlanSnapshot> {
        let overview = self.cleanup_overview()?;
        let (chat_marked_count, chat_marked_bytes): (i64, i64) = self.connection.query_row(
            "SELECT COUNT(*), COALESCE(SUM(f.bytes), 0)
             FROM all_removal_plan p JOIN files f ON f.path = p.path
             WHERE p.reason = 'chat'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let (planned_chat_count, planned_chat_messages): (i64, i64) = self.connection.query_row(
            "SELECT COUNT(*), COALESCE(SUM(message_count), 0)
             FROM chat_removal_plan",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let planned_orphan_messages: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM orphan_message_removal_plan",
            [],
            |row| row.get(0),
        )?;
        let mut digest = Sha256::new();
        let mut statement = self.connection.prepare(
            "SELECT p.path, p.reason, f.bytes
             FROM all_removal_plan p JOIN files f ON f.path = p.path
             ORDER BY p.path, p.reason",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?;
        for row in rows {
            let (path, reason, bytes) = row?;
            digest.update(path.as_bytes());
            digest.update([0]);
            digest.update(reason.as_bytes());
            digest.update([0]);
            digest.update(bytes.max(0).to_le_bytes());
        }
        let mut statement = self.connection.prepare(
            "SELECT source, chat_pk, reason, message_count
             FROM chat_removal_plan ORDER BY source, chat_pk",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?;
        for row in rows {
            let (source, chat_pk, reason, message_count) = row?;
            digest.update(source.as_bytes());
            digest.update(chat_pk.to_le_bytes());
            digest.update(reason.as_bytes());
            digest.update(message_count.max(0).to_le_bytes());
        }
        let mut statement = self.connection.prepare(
            "SELECT source, message_pk, message_id, COALESCE(chat_pk, 0)
             FROM orphan_message_removal_plan ORDER BY source, message_pk",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?;
        for row in rows {
            let (source, message_pk, message_id, chat_pk) = row?;
            digest.update(source.as_bytes());
            digest.update(message_pk.to_le_bytes());
            digest.update(message_id.as_bytes());
            digest.update(chat_pk.to_le_bytes());
        }
        let plan_fingerprint = digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        Ok(CleanupPlanSnapshot {
            source_path: self.meta("source_path")?.unwrap_or_default(),
            source_fingerprint: self.meta("source_fingerprint")?,
            plan_fingerprint,
            generated_at: unix_seconds(),
            marked_count: overview.marked_count,
            marked_bytes: overview.marked_bytes,
            manual_marked_count: overview.manual_marked_count,
            manual_marked_bytes: overview.manual_marked_bytes,
            automatic_marked_count: overview.automatic_marked_count,
            automatic_marked_bytes: overview.automatic_marked_bytes,
            chat_marked_count: chat_marked_count.max(0) as u64,
            chat_marked_bytes: chat_marked_bytes.max(0) as u64,
            planned_chat_count: planned_chat_count.max(0) as u64,
            planned_message_count: planned_chat_messages
                .saturating_add(planned_orphan_messages)
                .max(0) as u64,
        })
    }

    pub fn indexed_attachment_chats(&self) -> Result<HashSet<(String, i64)>> {
        if self.meta("context_index_version")?.as_deref() != Some(CONTEXT_INDEX_VERSION)
            || self.meta("context_status")?.as_deref() != Some("complete")
        {
            bail!("請先重新掃描附件，再顯示沒有附件的聊天室");
        }
        let mut statement = self.connection.prepare(
            "
            SELECT DISTINCT context_source, message_chat_pk
            FROM files
            WHERE attachment_kind IS NOT NULL
              AND reference_status = 'referenced'
              AND context_source IS NOT NULL
              AND context_source <> ''
              AND message_chat_pk IS NOT NULL
            ",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        Ok(rows.collect::<rusqlite::Result<HashSet<_>>>()?)
    }

    pub fn list_empty_attachment_chats(
        &self,
        mut chats: Vec<Chat>,
        page: u32,
        page_size: u32,
        search: Option<&str>,
        kind: &str,
        sort: &str,
    ) -> Result<CleanupGroupPage> {
        if page == 0 {
            bail!("cleanup page must be at least 1");
        }
        let limit = checked_page_size(page_size)?;
        if kind != "all" {
            bail!("沒有附件的聊天室不支援檔案篩選");
        }
        if !matches!(sort, "recent" | "oldest" | "size" | "path") {
            bail!("cleanup sort must be recent, oldest, size, or path");
        }
        let indexed_chats = self.indexed_attachment_chats()?;
        chats.retain(|chat| !indexed_chats.contains(&(chat.source.clone(), chat.pk)));
        if let Some(search) = search.map(str::trim).filter(|value| !value.is_empty()) {
            let search = search.to_lowercase();
            chats.retain(|chat| {
                [
                    chat.title.as_str(),
                    chat.id.as_str(),
                    chat.last_message.as_str(),
                ]
                .into_iter()
                .any(|value| value.to_lowercase().contains(&search))
            });
        }
        self.enrich_planned_chats(&mut chats)?;
        chats.sort_by(|left, right| {
            let order = match sort {
                "recent" => right.last_updated.cmp(&left.last_updated),
                "oldest" => left.last_updated.cmp(&right.last_updated),
                _ => left.title.cmp(&right.title),
            };
            order
                .then_with(|| left.title.cmp(&right.title))
                .then_with(|| left.source.cmp(&right.source))
                .then_with(|| left.pk.cmp(&right.pk))
        });
        let total_items = chats.len() as u64;
        let offset = cleanup_offset(page, limit)?;
        let items = chats
            .into_iter()
            .skip(offset as usize)
            .take(limit)
            .map(|chat| CleanupGroup {
                key: format!("empty:{}:{}", chat.source, chat.pk),
                chat_source: chat.source,
                chat_pk: Some(chat.pk),
                chat_id: chat.id,
                chat_title: chat.title,
                chat_kind: chat.kind,
                reference_status: "no_attachments".to_string(),
                file_count: 0,
                total_bytes: 0,
                marked_count: 0,
                has_original: false,
                has_thumbnail: false,
                thumbnail_backed_image_count: 0,
                keeping_thumbnails: false,
                latest_timestamp: chat.last_updated,
                planned_for_chat_removal: chat.planned_for_removal,
            })
            .collect();
        Ok(CleanupGroupPage {
            items,
            page,
            page_size,
            total_items,
            total_pages: cleanup_total_pages(total_items, page_size),
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn list_cleanup_groups(
        &self,
        page: u32,
        page_size: u32,
        search: Option<&str>,
        kind: &str,
        category: &str,
        sort: &str,
    ) -> Result<CleanupGroupPage> {
        validate_cleanup_query(page, page_size, kind, category, sort)?;
        let limit = checked_page_size(page_size)?;
        let offset = cleanup_offset(page, limit)?;
        let search = cleanup_search_pattern(search);
        let sql = format!(
            "
            WITH base AS (
                SELECT f.*, p.path IS NOT NULL AS marked,
                       {CLEANUP_GROUP_EXPR} AS group_key,
                       {CLEANUP_CATEGORY_EXPR} AS category,
                       CASE WHEN {THUMBNAIL_BACKED_IMAGE_EXPR} THEN 1 ELSE 0 END
                           AS thumbnail_backed_image,
                       CASE WHEN {IMAGE_THUMBNAIL_WITH_ORIGINAL_EXPR} THEN 1 ELSE 0 END
                           AS image_thumbnail_with_original
                FROM files f
                LEFT JOIN all_removal_plan p ON p.path = f.path
                WHERE f.attachment_kind IS NOT NULL
            ),
            grouped AS (
                SELECT group_key,
                       MAX(CASE
                           WHEN reference_status <> 'referenced' THEN ''
                           ELSE COALESCE(context_source, '')
                       END) AS chat_source,
                       MAX(CASE
                           WHEN reference_status <> 'referenced' THEN NULL
                           ELSE message_chat_pk
                       END) AS chat_pk,
                       MAX(CASE
                           WHEN reference_status <> 'referenced' THEN ''
                           ELSE COALESCE(context_chat_id, '')
                       END) AS chat_id,
                       MAX(CASE reference_status
                           WHEN 'unreferenced' THEN '孤兒檔案（SQLite 未引用）'
                           WHEN 'unconfirmed' THEN '無法確認引用的附件'
                           ELSE COALESCE(NULLIF(context_chat_title, ''), NULLIF(chat_hint, ''), '無法辨識的聊天室')
                       END) AS chat_title,
                       MAX(CASE reference_status
                           WHEN 'unreferenced' THEN 'unreferenced'
                           WHEN 'unconfirmed' THEN 'unknown'
                           ELSE COALESCE(NULLIF(context_chat_kind, ''), 'unknown')
                       END) AS chat_kind,
                       MAX(reference_status) AS reference_status,
                       COUNT(*) AS file_count,
                       COALESCE(SUM(bytes), 0) AS total_bytes,
                       SUM(CASE WHEN marked THEN 1 ELSE 0 END) AS marked_count,
                       MAX(CASE WHEN attachment_kind = 'original' THEN 1 ELSE 0 END) AS has_original,
                       MAX(CASE WHEN attachment_kind = 'thumbnail' THEN 1 ELSE 0 END) AS has_thumbnail,
                       SUM(thumbnail_backed_image) AS thumbnail_backed_image_count,
                       CASE
                           WHEN SUM(thumbnail_backed_image) > 0
                            AND SUM(CASE WHEN thumbnail_backed_image AND marked THEN 1 ELSE 0 END)
                                = SUM(thumbnail_backed_image)
                            AND SUM(CASE WHEN image_thumbnail_with_original AND marked THEN 1 ELSE 0 END) = 0
                           THEN 1 ELSE 0
                       END AS keeping_thumbnails,
                       COALESCE(MAX(message_timestamp), 0) AS latest_timestamp,
                       MAX(CASE
                           WHEN EXISTS (
                               SELECT 1 FROM chat_removal_plan crp
                               WHERE crp.source = base.context_source
                                 AND crp.chat_pk = base.message_chat_pk
                           )
                           THEN 1 ELSE 0
                       END) AS planned_for_chat_removal,
                       MIN(path) AS path_sort
                FROM base
                GROUP BY group_key
                HAVING MAX(CASE WHEN
                    (?1 = 'all'
                     OR (?1 = 'original' AND attachment_kind = 'original')
                     OR (?1 = 'thumbnail' AND attachment_kind = 'thumbnail')
                     OR (?1 = 'marked' AND marked))
                    AND (?2 = 'all' OR category = ?2)
                    AND (?3 IS NULL
                         OR path LIKE ?3 ESCAPE '\\'
                         OR chat_hint LIKE ?3 ESCAPE '\\'
                         OR COALESCE(context_chat_title, '') LIKE ?3 ESCAPE '\\'
                         OR COALESCE(message_sender_name, '') LIKE ?3 ESCAPE '\\'
                         OR COALESCE(message_text, '') LIKE ?3 ESCAPE '\\')
                    THEN 1 ELSE 0 END) = 1
            )
            SELECT group_key, chat_source, chat_pk, chat_id, chat_title, chat_kind, reference_status,
                   file_count, total_bytes, marked_count, has_original,
                   has_thumbnail, thumbnail_backed_image_count, keeping_thumbnails,
                   latest_timestamp, planned_for_chat_removal, COUNT(*) OVER()
            FROM grouped
            ORDER BY
                CASE WHEN ?4 = 'size' THEN total_bytes END DESC,
                CASE WHEN ?4 = 'path' THEN chat_title END ASC,
                CASE WHEN ?4 = 'oldest' THEN latest_timestamp END ASC,
                CASE WHEN ?4 = 'recent' THEN latest_timestamp END DESC,
                chat_title ASC, group_key ASC
            LIMIT ?5 OFFSET ?6
            "
        );
        let mut statement = self.connection.prepare(&sql)?;
        let rows = statement.query_map(
            params![kind, category, search, sort, limit as i64, offset],
            cleanup_group_from_row,
        )?;
        let mut items = Vec::new();
        let mut total_items = 0_u64;
        for row in rows {
            let (group, total) = row?;
            total_items = total;
            items.push(group);
        }
        Ok(CleanupGroupPage {
            items,
            page,
            page_size,
            total_items,
            total_pages: cleanup_total_pages(total_items, page_size),
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn list_cleanup_reviews(
        &self,
        group_key: &str,
        page: u32,
        page_size: u32,
        search: Option<&str>,
        kind: &str,
        category: &str,
        sort: &str,
    ) -> Result<CleanupReviewPage> {
        validate_cleanup_group_key(group_key)?;
        validate_cleanup_query(page, page_size, kind, category, sort)?;
        let limit = checked_page_size(page_size)?;
        let offset = cleanup_offset(page, limit)?;
        let search = cleanup_search_pattern(search);
        let group = self.cleanup_group(group_key)?;
        let bundle_expr = "
            CASE
                WHEN f.message_id <> '' THEN 'message:' || f.message_id
                ELSE 'file:' || f.path
            END
        ";
        let bundle_sql = format!(
            "
            WITH base AS (
                SELECT f.*, p.path IS NOT NULL AS marked,
                       {CLEANUP_GROUP_EXPR} AS group_key,
                       {CLEANUP_CATEGORY_EXPR} AS category,
                       {bundle_expr} AS bundle_key
                FROM files f
                LEFT JOIN all_removal_plan p ON p.path = f.path
                WHERE f.attachment_kind IS NOT NULL
            ),
            bundles AS (
                SELECT bundle_key, COALESCE(SUM(bytes), 0) AS total_bytes,
                       COALESCE(MAX(message_timestamp), 0) AS latest_timestamp,
                       MIN(path) AS path_sort
                FROM base
                WHERE group_key = ?1
                  AND (?2 = 'all'
                       OR (?2 = 'original' AND attachment_kind = 'original')
                       OR (?2 = 'thumbnail' AND attachment_kind = 'thumbnail')
                       OR (?2 = 'marked' AND marked))
                  AND (?3 = 'all' OR category = ?3)
                  AND (?4 IS NULL
                       OR path LIKE ?4 ESCAPE '\\'
                       OR COALESCE(context_chat_title, '') LIKE ?4 ESCAPE '\\'
                       OR COALESCE(message_sender_name, '') LIKE ?4 ESCAPE '\\'
                       OR COALESCE(message_text, '') LIKE ?4 ESCAPE '\\')
                GROUP BY bundle_key
            )
            SELECT bundle_key, total_bytes, COUNT(*) OVER()
            FROM bundles
            ORDER BY
                CASE WHEN ?5 = 'size' THEN total_bytes END DESC,
                CASE WHEN ?5 = 'path' THEN path_sort END ASC,
                CASE WHEN ?5 = 'oldest' THEN latest_timestamp END ASC,
                CASE WHEN ?5 = 'recent' THEN latest_timestamp END DESC,
                path_sort ASC, bundle_key ASC
            LIMIT ?6 OFFSET ?7
            "
        );
        let mut bundle_statement = self.connection.prepare(&bundle_sql)?;
        let bundle_rows = bundle_statement.query_map(
            params![
                group_key,
                kind,
                category,
                search,
                sort,
                limit as i64,
                offset
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?.max(0) as u64,
                    row.get::<_, i64>(2)?.max(0) as u64,
                ))
            },
        )?;
        let mut bundle_keys = Vec::new();
        let mut bundle_bytes = HashMap::new();
        let mut total_items = 0_u64;
        for row in bundle_rows {
            let (key, bytes, total) = row?;
            total_items = total;
            bundle_bytes.insert(key.clone(), bytes);
            bundle_keys.push(key);
        }
        if bundle_keys.is_empty() {
            return Ok(CleanupReviewPage {
                group,
                items: Vec::new(),
                page,
                page_size,
                total_items,
                total_pages: cleanup_total_pages(total_items, page_size),
            });
        }
        let placeholders = std::iter::repeat_n("?", bundle_keys.len())
            .collect::<Vec<_>>()
            .join(",");
        let file_sql = format!(
            "
            SELECT {ATTACHMENT_COLUMNS}, {bundle_expr} AS bundle_key
            FROM files f
            LEFT JOIN all_removal_plan p ON p.path = f.path
            WHERE {CLEANUP_GROUP_EXPR} = ?
              AND {bundle_expr} IN ({placeholders})
              AND (? = 'all'
                   OR (? = 'original' AND f.attachment_kind = 'original')
                   OR (? = 'thumbnail' AND f.attachment_kind = 'thumbnail')
                   OR (? = 'marked' AND p.path IS NOT NULL))
              AND (? IS NULL
                   OR f.path LIKE ? ESCAPE '\\'
                   OR COALESCE(f.context_chat_title, '') LIKE ? ESCAPE '\\'
                   OR COALESCE(f.message_sender_name, '') LIKE ? ESCAPE '\\'
                   OR COALESCE(f.message_text, '') LIKE ? ESCAPE '\\')
            ORDER BY bundle_key ASC,
                     CASE f.attachment_kind WHEN 'original' THEN 0 ELSE 1 END,
                     f.bytes DESC, f.path ASC
            LIMIT {}
            ",
            MAX_CLEANUP_RESPONSE_FILES + 1
        );
        let mut values = Vec::<rusqlite::types::Value>::new();
        values.push(group_key.to_string().into());
        values.extend(
            bundle_keys
                .iter()
                .cloned()
                .map(rusqlite::types::Value::from),
        );
        values.extend([
            kind.to_string().into(),
            kind.to_string().into(),
            kind.to_string().into(),
            kind.to_string().into(),
            search.clone().into(),
            search.clone().into(),
            search.clone().into(),
            search.clone().into(),
            search.into(),
        ]);
        let mut file_statement = self.connection.prepare(&file_sql)?;
        let mut rows = file_statement.query(rusqlite::params_from_iter(values.iter()))?;
        let mut files_by_bundle = HashMap::<String, Vec<AttachmentItem>>::new();
        let mut response_files = 0_usize;
        while let Some(row) = rows.next()? {
            response_files += 1;
            if response_files > MAX_CLEANUP_RESPONSE_FILES {
                bail!(
                    "cleanup review page exceeds {MAX_CLEANUP_RESPONSE_FILES} files; narrow the filters"
                );
            }
            let item = attachment_from_row(row)?;
            let bundle_key: String = row.get(21)?;
            files_by_bundle.entry(bundle_key).or_default().push(item);
        }
        let items = bundle_keys
            .into_iter()
            .filter_map(|key| {
                let files = files_by_bundle.remove(&key)?;
                let first = files.first()?;
                Some(CleanupReview {
                    key: key.clone(),
                    message_id: first.message_id.clone(),
                    reference_status: first.reference_status.clone(),
                    context: first.context.clone(),
                    files,
                    total_bytes: bundle_bytes.remove(&key).unwrap_or(0),
                })
            })
            .collect();
        Ok(CleanupReviewPage {
            group,
            items,
            page,
            page_size,
            total_items,
            total_pages: cleanup_total_pages(total_items, page_size),
        })
    }

    pub fn apply_cleanup_group_action(
        &self,
        group_key: &str,
        action: &str,
    ) -> Result<CleanupOverview> {
        validate_cleanup_group_key(group_key)?;
        if !matches!(action, "toggle_all" | "keep_thumbnail") {
            bail!("cleanup group action must be `toggle_all` or `keep_thumbnail`");
        }
        let predicate = format!("f.attachment_kind IS NOT NULL AND {CLEANUP_GROUP_EXPR} = ?1");
        let (
            total,
            marked,
            thumbnail_backed_images,
            marked_thumbnail_backed_images,
            marked_image_thumbnails,
        ) = self.connection.query_row(
            &format!(
                "
                    SELECT COUNT(*),
                           SUM(CASE WHEN p.path IS NOT NULL THEN 1 ELSE 0 END),
                           SUM(CASE WHEN {THUMBNAIL_BACKED_IMAGE_EXPR} THEN 1 ELSE 0 END),
                           SUM(CASE
                               WHEN ({THUMBNAIL_BACKED_IMAGE_EXPR}) AND p.path IS NOT NULL
                               THEN 1 ELSE 0
                           END),
                           SUM(CASE
                               WHEN ({IMAGE_THUMBNAIL_WITH_ORIGINAL_EXPR}) AND p.path IS NOT NULL
                               THEN 1 ELSE 0
                           END)
                    FROM files f
                    LEFT JOIN all_removal_plan p ON p.path = f.path
                    WHERE {predicate}
                    "
            ),
            [group_key],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )?;
        if total == 0 {
            bail!("cleanup group does not exist");
        }
        let now = unix_seconds();
        if action == "toggle_all" {
            if marked == total {
                self.connection.execute(
                    &format!(
                        "DELETE FROM removal_plan
                         WHERE path IN (SELECT f.path FROM files f WHERE {predicate})"
                    ),
                    [group_key],
                )?;
            } else {
                self.connection.execute(
                    &format!(
                        "INSERT OR REPLACE INTO removal_plan(path, marked_at, reason)
                         SELECT f.path, ?2, 'manual' FROM files f WHERE {predicate}"
                    ),
                    params![group_key, now],
                )?;
            }
        } else {
            if thumbnail_backed_images == 0 {
                bail!("cleanup group does not contain image originals with matching thumbnails");
            }
            let keeping_thumbnails = marked_thumbnail_backed_images == thumbnail_backed_images
                && marked_image_thumbnails == 0;
            if keeping_thumbnails {
                self.connection.execute(
                    &format!(
                        "DELETE FROM removal_plan
                         WHERE path IN (
                             SELECT f.path FROM files f
                             WHERE {predicate} AND ({THUMBNAIL_BACKED_IMAGE_EXPR})
                         )"
                    ),
                    [group_key],
                )?;
            } else {
                self.connection.execute(
                    &format!(
                        "INSERT OR REPLACE INTO removal_plan(path, marked_at, reason)
                         SELECT f.path, ?2, 'manual' FROM files f
                         WHERE {predicate} AND ({THUMBNAIL_BACKED_IMAGE_EXPR})"
                    ),
                    params![group_key, now],
                )?;
                self.connection.execute(
                    &format!(
                        "DELETE FROM removal_plan
                         WHERE path IN (
                             SELECT f.path FROM files f
                             WHERE {predicate} AND ({IMAGE_THUMBNAIL_WITH_ORIGINAL_EXPR})
                         )"
                    ),
                    [group_key],
                )?;
            }
        }
        let overview = self.cleanup_overview()?;
        self.record_cleanup_activity(action, "cleanup_group", group_key, 0, 0)?;
        Ok(overview)
    }

    pub fn hash_duplicate_candidates<F>(
        &self,
        source: &Path,
        kind: SourceKind,
        mut on_progress: F,
    ) -> Result<DuplicateHashProgress>
    where
        F: FnMut(DuplicateHashProgress) -> Result<()>,
    {
        self.set_meta("hash_status", "running")?;
        let result = self.hash_duplicate_candidates_inner(source, kind, &mut on_progress);
        if result.is_err() {
            let _ = self.clear_duplicate_hashes();
            let _ = self.set_meta("hash_status", "not_started");
        } else {
            self.set_meta("hash_status", "complete")?;
        }
        result
    }

    fn hash_duplicate_candidates_inner<F>(
        &self,
        source: &Path,
        kind: SourceKind,
        on_progress: &mut F,
    ) -> Result<DuplicateHashProgress>
    where
        F: FnMut(DuplicateHashProgress) -> Result<()>,
    {
        if kind == SourceKind::Sqlite {
            bail!("a direct Line.sqlite source has no attachment files");
        }
        let source = source
            .canonicalize()
            .with_context(|| format!("source does not exist: {}", source.display()))?;
        validate_bound_source(self, &source)?;
        if !self.source_matches_current(&source, kind)? {
            bail!("source changed since the last scan; rescan before hashing duplicates");
        }
        let read_connection = Connection::open(&self.path)?;
        read_connection.pragma_update(None, "query_only", true)?;
        read_connection.pragma_update(None, "temp_store", "FILE")?;
        let mut write_connection = Connection::open(&self.path)?;
        let (candidate_files, total_bytes): (i64, i64) = read_connection.query_row(
            "
            SELECT COUNT(*), COALESCE(SUM(bytes), 0)
            FROM files
            WHERE attachment_kind IS NOT NULL
              AND bytes > 0
              AND sha256 IS NULL
              AND bytes IN (
                  SELECT bytes FROM files
                  WHERE attachment_kind IS NOT NULL AND bytes > 0
                  GROUP BY bytes HAVING COUNT(*) > 1
              )
            ",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let mut statement = read_connection.prepare(
            "
            SELECT path, bytes, modified_ns
            FROM files
            WHERE attachment_kind IS NOT NULL
              AND bytes > 0
              AND sha256 IS NULL
              AND bytes IN (
                  SELECT bytes FROM files
                  WHERE attachment_kind IS NOT NULL AND bytes > 0
                  GROUP BY bytes HAVING COUNT(*) > 1
              )
            ORDER BY id ASC
            ",
        )?;
        let mut rows = statement.query([])?;
        let archive_fingerprint = if kind == SourceKind::ImazingArchive {
            Some(source_metadata_fingerprint(&source, kind)?)
        } else {
            None
        };
        let mut archive = if kind == SourceKind::ImazingArchive {
            Some(ZipArchive::new(File::open(&source)?)?)
        } else {
            None
        };
        let mut pending = Vec::with_capacity(HASH_UPDATE_BATCH_SIZE);
        let mut progress = DuplicateHashProgress {
            candidate_files: candidate_files.max(0) as u64,
            processed_files: 0,
            total_bytes: total_bytes.max(0) as u64,
            processed_bytes: 0,
        };
        while let Some(row) = rows.next()? {
            let path: String = row.get(0)?;
            let bytes = row.get::<_, i64>(1)?.max(0) as u64;
            let modified_ns: i64 = row.get(2)?;
            let digest = match archive.as_mut() {
                Some(archive) => {
                    let entry = archive.by_name(&path).with_context(|| {
                        format!("archive entry disappeared during hash: {path}")
                    })?;
                    if entry.size() != bytes {
                        bail!("archive entry size changed since catalog scan: {path}");
                    }
                    hash_reader(entry)?
                }
                None => {
                    let file_path = safe_source_join(&source, &path)?;
                    let before = file_record_fingerprint(&file_path)?;
                    if before.0 != bytes || before.1 != modified_ns {
                        bail!("source file changed since catalog scan: {path}");
                    }
                    let digest = hash_reader(BufReader::with_capacity(
                        HASH_BUFFER_BYTES,
                        File::open(&file_path)?,
                    ))?;
                    if file_record_fingerprint(&file_path)? != before {
                        bail!("source file changed while hashing: {path}");
                    }
                    digest
                }
            };
            pending.push((path, digest));
            progress.processed_files += 1;
            progress.processed_bytes = progress.processed_bytes.saturating_add(bytes);
            if pending.len() == HASH_UPDATE_BATCH_SIZE {
                update_hash_batch(&mut write_connection, &mut pending)?;
            }
            on_progress(progress)?;
        }
        update_hash_batch(&mut write_connection, &mut pending)?;
        if let Some(before) = archive_fingerprint
            && source_metadata_fingerprint(&source, kind)? != before
        {
            bail!("source archive changed while hashing");
        }
        Ok(progress)
    }

    fn clear_duplicate_hashes(&self) -> Result<()> {
        self.connection
            .execute("UPDATE files SET sha256 = NULL", [])?;
        Ok(())
    }

    pub fn list_duplicate_groups(
        &self,
        cursor: Option<DuplicateGroupCursor>,
        limit: u32,
    ) -> Result<DuplicateGroupPage> {
        let limit = checked_page_size(limit)?;
        let reclaimable = "((COUNT(*) - 1) * bytes)";
        let cursor_filter = if cursor.is_some() {
            format!(
                "HAVING COUNT(*) > 1 AND ({reclaimable} < ?1 OR ({reclaimable} = ?1 AND sha256 > ?2))"
            )
        } else {
            "HAVING COUNT(*) > 1".to_string()
        };
        let sql = format!(
            "
            SELECT sha256, bytes, COUNT(*), {reclaimable},
                   MAX(CASE WHEN attachment_kind = 'original' THEN 1 ELSE 0 END),
                   MAX(CASE WHEN attachment_kind = 'thumbnail' THEN 1 ELSE 0 END),
                   MIN(path)
            FROM files
            WHERE sha256 IS NOT NULL
            GROUP BY sha256, bytes
            {cursor_filter}
            ORDER BY {reclaimable} DESC, sha256 ASC
            LIMIT ?3
            "
        );
        let cursor = cursor.unwrap_or(DuplicateGroupCursor {
            reclaimable_bytes: u64::MAX,
            sha256: String::new(),
        });
        let reclaimable_cursor = i64::try_from(cursor.reclaimable_bytes).unwrap_or(i64::MAX);
        let mut statement = self.connection.prepare(&sql)?;
        let rows = statement.query_map(
            params![reclaimable_cursor, cursor.sha256, limit as i64 + 1],
            |row| {
                Ok(DuplicateGroup {
                    sha256: row.get(0)?,
                    bytes: row.get::<_, i64>(1)?.max(0) as u64,
                    file_count: row.get::<_, i64>(2)?.max(0) as u64,
                    reclaimable_bytes: row.get::<_, i64>(3)?.max(0) as u64,
                    has_original: row.get::<_, i64>(4)? != 0,
                    has_thumbnail: row.get::<_, i64>(5)? != 0,
                    preview_path: row.get(6)?,
                })
            },
        )?;
        let mut items = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        let has_extra = items.len() > limit;
        if has_extra {
            items.pop();
        }
        let next_cursor = if has_extra {
            items.last().map(|group| DuplicateGroupCursor {
                reclaimable_bytes: group.reclaimable_bytes,
                sha256: group.sha256.clone(),
            })
        } else {
            None
        };
        Ok(DuplicateGroupPage { items, next_cursor })
    }

    pub fn list_duplicate_members(
        &self,
        sha256: &str,
        cursor: Option<AttachmentCursor>,
        limit: u32,
    ) -> Result<DuplicateMemberPage> {
        validate_sha256(sha256)?;
        let limit = checked_page_size(limit)?;
        let sql = format!(
            "
            SELECT {ATTACHMENT_COLUMNS}
            FROM files f
            LEFT JOIN all_removal_plan p ON p.path = f.path
            WHERE f.sha256 = ?1 AND f.id > ?2
            ORDER BY f.id ASC
            LIMIT ?3
            ",
        );
        let mut statement = self.connection.prepare(&sql)?;
        let rows = statement.query_map(
            params![
                sha256,
                cursor.map(|value| value.id).unwrap_or(0),
                limit as i64 + 1
            ],
            attachment_from_row,
        )?;
        let mut items = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        let has_extra = items.len() > limit;
        if has_extra {
            items.pop();
        }
        let next_cursor = if has_extra {
            items
                .last()
                .map(|attachment| AttachmentCursor { id: attachment.id })
        } else {
            None
        };
        Ok(DuplicateMemberPage { items, next_cursor })
    }

    pub(crate) fn duplicate_link_groups(
        &self,
        excluded: &HashSet<String>,
    ) -> Result<Vec<Vec<DuplicateLinkMember>>> {
        if self.meta("hash_status")?.as_deref() != Some("complete") {
            bail!("duplicate scan is not complete; scan exact duplicates before linking them");
        }
        let mut statement = self.connection.prepare(
            "
            SELECT sha256, bytes, path
            FROM files
            WHERE attachment_kind IS NOT NULL
              AND sha256 IS NOT NULL
              AND sha256 IN (
                  SELECT sha256
                  FROM files
                  WHERE attachment_kind IS NOT NULL
                    AND sha256 IS NOT NULL
                  GROUP BY sha256, bytes
                  HAVING COUNT(*) > 1
              )
            ORDER BY sha256 ASC, bytes ASC,
                     CASE reference_status
                         WHEN 'referenced' THEN 0
                         WHEN 'unconfirmed' THEN 1
                         ELSE 2
                     END,
                     CASE attachment_kind WHEN 'original' THEN 0 ELSE 1 END,
                     path ASC
            ",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?.max(0) as u64,
                DuplicateLinkMember {
                    path: row.get(2)?,
                    bytes: row.get::<_, i64>(1)?.max(0) as u64,
                },
            ))
        })?;

        let mut groups = Vec::new();
        let mut current_key: Option<(String, u64)> = None;
        let mut current_members = Vec::new();
        for row in rows {
            let (sha256, bytes, member) = row?;
            let key = (sha256, bytes);
            if current_key.as_ref().is_some_and(|value| value != &key) {
                if current_members.len() > 1 {
                    groups.push(std::mem::take(&mut current_members));
                } else {
                    current_members.clear();
                }
            }
            current_key = Some(key);
            if !excluded.contains(&member.path) {
                current_members.push(member);
            }
        }
        if current_members.len() > 1 {
            groups.push(current_members);
        }
        Ok(groups)
    }

    fn cleanup_group(&self, group_key: &str) -> Result<CleanupGroup> {
        let sql = format!(
            "
            SELECT {CLEANUP_GROUP_EXPR} AS group_key,
                   MAX(CASE
                       WHEN f.reference_status <> 'referenced' THEN ''
                       ELSE COALESCE(f.context_source, '')
                   END) AS chat_source,
                   MAX(CASE
                       WHEN f.reference_status <> 'referenced' THEN NULL
                       ELSE f.message_chat_pk
                   END) AS chat_pk,
                   MAX(CASE
                       WHEN f.reference_status <> 'referenced' THEN ''
                       ELSE COALESCE(f.context_chat_id, '')
                   END) AS chat_id,
                   MAX(CASE f.reference_status
                       WHEN 'unreferenced' THEN '孤兒檔案（SQLite 未引用）'
                       WHEN 'unconfirmed' THEN '無法確認引用的附件'
                       ELSE COALESCE(NULLIF(f.context_chat_title, ''), NULLIF(f.chat_hint, ''), '無法辨識的聊天室')
                   END) AS chat_title,
                   MAX(CASE f.reference_status
                       WHEN 'unreferenced' THEN 'unreferenced'
                       WHEN 'unconfirmed' THEN 'unknown'
                       ELSE COALESCE(NULLIF(f.context_chat_kind, ''), 'unknown')
                   END) AS chat_kind,
                   MAX(f.reference_status) AS reference_status,
                   COUNT(*) AS file_count,
                   COALESCE(SUM(f.bytes), 0) AS total_bytes,
                   SUM(CASE WHEN p.path IS NOT NULL THEN 1 ELSE 0 END) AS marked_count,
                   MAX(CASE WHEN f.attachment_kind = 'original' THEN 1 ELSE 0 END) AS has_original,
                   MAX(CASE WHEN f.attachment_kind = 'thumbnail' THEN 1 ELSE 0 END) AS has_thumbnail,
                   SUM(CASE WHEN {THUMBNAIL_BACKED_IMAGE_EXPR} THEN 1 ELSE 0 END)
                       AS thumbnail_backed_image_count,
                   CASE
                       WHEN SUM(CASE WHEN {THUMBNAIL_BACKED_IMAGE_EXPR} THEN 1 ELSE 0 END) > 0
                        AND SUM(CASE
                            WHEN ({THUMBNAIL_BACKED_IMAGE_EXPR}) AND p.path IS NOT NULL
                            THEN 1 ELSE 0
                        END) = SUM(CASE WHEN {THUMBNAIL_BACKED_IMAGE_EXPR} THEN 1 ELSE 0 END)
                        AND SUM(CASE
                            WHEN ({IMAGE_THUMBNAIL_WITH_ORIGINAL_EXPR}) AND p.path IS NOT NULL
                            THEN 1 ELSE 0
                        END) = 0
                       THEN 1 ELSE 0
                   END AS keeping_thumbnails,
                   COALESCE(MAX(f.message_timestamp), 0) AS latest_timestamp,
                   MAX(CASE
                       WHEN EXISTS (
                           SELECT 1 FROM chat_removal_plan crp
                           WHERE crp.source = f.context_source
                             AND crp.chat_pk = f.message_chat_pk
                       )
                       THEN 1 ELSE 0
                   END) AS planned_for_chat_removal,
                   1
            FROM files f
            LEFT JOIN all_removal_plan p ON p.path = f.path
            WHERE f.attachment_kind IS NOT NULL
              AND {CLEANUP_GROUP_EXPR} = ?1
            GROUP BY group_key
            "
        );
        self.connection
            .query_row(&sql, [group_key], cleanup_group_from_row)
            .optional()?
            .map(|value| value.0)
            .context("cleanup group does not exist")
    }

    pub fn stats(&self) -> Result<CatalogStats> {
        let (file_count, total_bytes): (i64, i64) = self.connection.query_row(
            "SELECT COUNT(*), COALESCE(SUM(bytes), 0) FROM files",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let (attachment_count, attachment_bytes): (i64, i64) = self.connection.query_row(
            "SELECT COUNT(*), COALESCE(SUM(bytes), 0) FROM files WHERE attachment_kind IS NOT NULL",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let (marked_count, marked_bytes): (i64, i64) = self.connection.query_row(
            "SELECT COUNT(*), COALESCE(SUM(f.bytes), 0)
             FROM all_removal_plan p JOIN files f ON f.path = p.path",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok(CatalogStats {
            source_path: self.meta("source_path")?.unwrap_or_default(),
            scan_status: self
                .meta("scan_status")?
                .unwrap_or_else(|| "not_started".to_string()),
            file_count: file_count.max(0) as u64,
            total_bytes: total_bytes.max(0) as u64,
            attachment_count: attachment_count.max(0) as u64,
            attachment_bytes: attachment_bytes.max(0) as u64,
            marked_count: marked_count.max(0) as u64,
            marked_bytes: marked_bytes.max(0) as u64,
        })
    }

    pub fn set_active_job(&self, kind: &str, job_id: Option<&str>) -> Result<()> {
        let key = format!("active_{kind}_job_id");
        match job_id.filter(|value| !value.is_empty()) {
            Some(value) => self.set_meta(&key, value),
            None => self.clear_meta(&key),
        }
    }

    pub fn clear_active_job(&self, kind: &str) -> Result<()> {
        self.clear_meta(&format!("active_{kind}_job_id"))
    }

    pub fn active_job(&self) -> Result<Option<(String, String)>> {
        for (kind, key) in [
            ("scan", "active_scan_job_id"),
            ("hash", "active_hash_job_id"),
            ("candidate", "active_candidate_job_id"),
        ] {
            if let Some(job_id) = self.meta(key)? {
                return Ok(Some((kind.to_string(), job_id)));
            }
        }
        Ok(None)
    }

    fn upsert_batch(&mut self, scan_id: i64, batch: &mut Vec<FileRecord>) -> Result<()> {
        if batch.is_empty() {
            return Ok(());
        }
        let transaction = self.connection.transaction()?;
        insert_records(&transaction, scan_id, batch)?;
        transaction.commit()?;
        batch.clear();
        Ok(())
    }

    fn meta(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .connection
            .query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
                row.get(0)
            })
            .optional()?)
    }

    fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.connection.execute(
            "INSERT INTO meta(key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    fn clear_meta(&self, key: &str) -> Result<()> {
        self.connection
            .execute("DELETE FROM meta WHERE key = ?1", [key])?;
        Ok(())
    }
}

fn insert_records(
    transaction: &Transaction<'_>,
    scan_id: i64,
    records: &[FileRecord],
) -> Result<()> {
    let mut statement = transaction.prepare(
        "
        INSERT INTO files(path, bytes, modified_ns, content_sha256, attachment_kind, message_id, chat_hint, seen_scan)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(path) DO UPDATE SET
            bytes = excluded.bytes,
            modified_ns = excluded.modified_ns,
            content_sha256 = excluded.content_sha256,
            attachment_kind = excluded.attachment_kind,
            message_id = excluded.message_id,
            chat_hint = excluded.chat_hint,
            sha256 = CASE
                WHEN files.content_sha256 = excluded.content_sha256
                THEN files.sha256
                ELSE NULL
            END,
            seen_scan = excluded.seen_scan
        ",
    )?;
    for record in records {
        let bytes = i64::try_from(record.bytes).context("file is too large for catalog SQLite")?;
        statement.execute(params![
            record.path,
            bytes,
            record.modified_ns,
            record.content_sha256,
            record.kind.map(AttachmentKind::as_str),
            record.message_id,
            record.chat_hint,
            scan_id
        ])?;
    }
    Ok(())
}

fn update_progress(progress: &mut CatalogScanProgress, record: &FileRecord) {
    progress.files += 1;
    progress.bytes = progress.bytes.saturating_add(record.bytes);
    if record.kind.is_some() {
        progress.attachments += 1;
    }
}

fn private_store_account_from_path(path: &str) -> Option<(&str, String)> {
    if path.contains('\\') {
        return None;
    }
    let segments = path.split('/').collect::<Vec<_>>();
    for index in 0..segments.len().saturating_sub(1) {
        if segments[index] != "PrivateStore" {
            continue;
        }
        let account_id = segments[index + 1].strip_prefix("P_")?;
        if account_id.is_empty() {
            return None;
        }
        return Some((account_id, segments[..=index + 1].join("/")));
    }
    None
}

fn file_record(path: String, bytes: u64, modified_ns: i64, content_sha256: String) -> FileRecord {
    let normalized = path.replace('\\', "/");
    let segments: Vec<&str> = normalized.split('/').collect();
    let attachment = segments
        .iter()
        .position(|segment| *segment == "Message Attachments" || *segment == "Message Thumbnails");
    let kind = attachment.map(|index| {
        if segments[index] == "Message Thumbnails" {
            AttachmentKind::Thumbnail
        } else {
            AttachmentKind::Original
        }
    });
    let filename = segments.last().copied().unwrap_or_default();
    let message_id = leading_message_id(filename);
    let chat_hint = attachment
        .and_then(|index| segments.get(index + 1))
        .filter(|value| **value != filename)
        .copied()
        .unwrap_or_default()
        .to_string();
    FileRecord {
        path: normalized,
        bytes,
        modified_ns,
        content_sha256,
        kind,
        message_id,
        chat_hint,
    }
}

fn leading_message_id(filename: &str) -> String {
    let digits: String = filename
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect();
    if digits.len() >= 8 {
        digits
    } else {
        String::new()
    }
}

fn modified_ns(value: Option<SystemTime>) -> i64 {
    value
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .and_then(|value| i64::try_from(value.as_nanos()).ok())
        .unwrap_or(0)
}

fn unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|value| i64::try_from(value.as_secs()).ok())
        .unwrap_or(0)
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn cleanup_search_pattern(search: Option<&str>) -> Option<String> {
    search
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("%{}%", escape_like(value)))
}

fn validate_cleanup_query(
    page: u32,
    page_size: u32,
    kind: &str,
    category: &str,
    sort: &str,
) -> Result<()> {
    if page == 0 {
        bail!("cleanup page must be at least 1");
    }
    checked_page_size(page_size)?;
    if !matches!(kind, "all" | "original" | "thumbnail" | "marked") {
        bail!("cleanup kind must be all, original, thumbnail, or marked");
    }
    if !matches!(
        category,
        "all" | "individual" | "group" | "community" | "unreferenced" | "unconfirmed"
    ) {
        bail!("unsupported cleanup category");
    }
    if !matches!(sort, "recent" | "oldest" | "size" | "path") {
        bail!("cleanup sort must be recent, oldest, size, or path");
    }
    Ok(())
}

fn validate_cleanup_group_key(group_key: &str) -> Result<()> {
    if group_key.is_empty() || group_key.len() > 1_024 {
        bail!("invalid cleanup group key");
    }
    Ok(())
}

fn cleanup_offset(page: u32, page_size: usize) -> Result<i64> {
    let offset = u64::from(page - 1)
        .checked_mul(page_size as u64)
        .context("cleanup page offset overflow")?;
    i64::try_from(offset).context("cleanup page offset is too large")
}

fn cleanup_total_pages(total_items: u64, page_size: u32) -> u64 {
    if total_items == 0 {
        1
    } else {
        total_items.div_ceil(u64::from(page_size))
    }
}

fn cleanup_group_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<(CleanupGroup, u64)> {
    Ok((
        CleanupGroup {
            key: row.get(0)?,
            chat_source: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            chat_pk: row.get(2)?,
            chat_id: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
            chat_title: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
            chat_kind: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
            reference_status: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
            file_count: row.get::<_, i64>(7)?.max(0) as u64,
            total_bytes: row.get::<_, i64>(8)?.max(0) as u64,
            marked_count: row.get::<_, i64>(9)?.max(0) as u64,
            has_original: row.get::<_, i64>(10)? != 0,
            has_thumbnail: row.get::<_, i64>(11)? != 0,
            thumbnail_backed_image_count: row.get::<_, i64>(12)?.max(0) as u64,
            keeping_thumbnails: row.get::<_, i64>(13)? != 0,
            latest_timestamp: row.get::<_, i64>(14)?,
            planned_for_chat_removal: row.get::<_, i64>(15)? != 0,
        },
        row.get::<_, i64>(16)?.max(0) as u64,
    ))
}

fn detect_image_media_type(path: &Path) -> Result<Option<&'static str>> {
    let mut file = File::open(path)?;
    let mut header = [0_u8; 16];
    let read = file.read(&mut header)?;
    let header = &header[..read];
    let media_type = if header.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if header.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if header.starts_with(b"GIF87a") || header.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if header.len() >= 12 && &header[..4] == b"RIFF" && &header[8..12] == b"WEBP" {
        Some("image/webp")
    } else if header.starts_with(b"BM") {
        Some("image/bmp")
    } else if header.len() >= 12
        && &header[4..8] == b"ftyp"
        && matches!(&header[8..12], b"avif" | b"avis")
    {
        Some("image/avif")
    } else {
        None
    };
    Ok(media_type)
}

fn trim_preview_cache(directory: &Path, keep: usize) -> Result<()> {
    let mut files = fs::read_dir(directory)?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            metadata
                .is_file()
                .then(|| (metadata.modified().unwrap_or(UNIX_EPOCH), entry.path()))
        })
        .collect::<Vec<_>>();
    files.sort_by_key(|entry| entry.0);
    let remove_count = files.len().saturating_sub(keep);
    for (_, path) in files.into_iter().take(remove_count) {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    declaration: &str,
) -> Result<()> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if !columns.iter().any(|name| name == column) {
        connection.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {declaration}"),
            [],
        )?;
    }
    Ok(())
}

fn validate_bound_source(catalog: &Catalog, source: &Path) -> Result<()> {
    let bound = catalog
        .source_path()?
        .context("catalog has not been scanned yet")?
        .canonicalize()
        .context("catalog source no longer exists")?;
    if bound != source {
        bail!("catalog belongs to another source");
    }
    Ok(())
}

fn update_hash_batch(
    connection: &mut Connection,
    pending: &mut Vec<(String, String)>,
) -> Result<()> {
    if pending.is_empty() {
        return Ok(());
    }
    let transaction = connection.transaction()?;
    {
        let mut statement = transaction.prepare("UPDATE files SET sha256 = ?2 WHERE path = ?1")?;
        for (path, digest) in pending.iter() {
            statement.execute(params![path, digest])?;
        }
    }
    transaction.commit()?;
    pending.clear();
    Ok(())
}

fn hash_reader(mut reader: impl Read) -> Result<String> {
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; HASH_BUFFER_BYTES];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn scan_archive_records_parallel<F>(
    source: &Path,
    entry_count: usize,
    workers: usize,
    mut on_record: F,
) -> Result<()>
where
    F: FnMut(FileRecord) -> Result<()>,
{
    let workers = workers.clamp(1, entry_count.max(1));
    if workers == 1 {
        let mut archive = ZipArchive::new(File::open(source)?)?;
        for index in 0..entry_count {
            let mut entry = archive.by_index(index)?;
            if entry.is_dir() {
                continue;
            }
            let path = String::from_utf8_lossy(entry.name_raw()).replace('\\', "/");
            let bytes = entry.size();
            let content_sha256 = hash_reader(&mut entry)?;
            on_record(file_record(path, bytes, 0, content_sha256))?;
        }
        return Ok(());
    }

    let next_index = AtomicUsize::new(0);
    let cancelled = AtomicBool::new(false);
    let (sender, receiver) = sync_channel::<Result<FileRecord>>(workers.saturating_mul(2));
    let mut callback_error = None;
    let mut worker_error = None;
    thread::scope(|scope| {
        let mut handles = Vec::with_capacity(workers);
        for _ in 0..workers {
            let sender = sender.clone();
            let next_index = &next_index;
            let cancelled = &cancelled;
            handles.push(scope.spawn(move || {
                let outcome = (|| -> Result<()> {
                    let mut archive = ZipArchive::new(File::open(source)?)?;
                    loop {
                        if cancelled.load(Ordering::Relaxed) {
                            return Ok(());
                        }
                        let index = next_index.fetch_add(1, Ordering::Relaxed);
                        if index >= entry_count {
                            return Ok(());
                        }
                        let mut entry = archive.by_index(index)?;
                        if entry.is_dir() {
                            continue;
                        }
                        let path = String::from_utf8_lossy(entry.name_raw()).replace('\\', "/");
                        let bytes = entry.size();
                        let content_sha256 = hash_reader(&mut entry)?;
                        if sender
                            .send(Ok(file_record(path, bytes, 0, content_sha256)))
                            .is_err()
                        {
                            return Ok(());
                        }
                    }
                })();
                if let Err(error) = outcome {
                    cancelled.store(true, Ordering::Relaxed);
                    let _ = sender.send(Err(error));
                }
            }));
        }
        drop(sender);
        for result in receiver {
            if callback_error.is_some() || worker_error.is_some() {
                continue;
            }
            match result {
                Ok(record) => {
                    if let Err(error) = on_record(record) {
                        cancelled.store(true, Ordering::Relaxed);
                        callback_error = Some(error);
                    }
                }
                Err(error) => {
                    cancelled.store(true, Ordering::Relaxed);
                    worker_error = Some(error);
                }
            }
        }
        for handle in handles {
            if handle.join().is_err() && worker_error.is_none() {
                worker_error = Some(anyhow::anyhow!("archive scan worker panicked"));
            }
        }
    });
    if let Some(error) = callback_error.or(worker_error) {
        return Err(error);
    }
    Ok(())
}

fn validate_archive_catalog_parallel(
    source: &Path,
    catalog_path: &Path,
    workers: usize,
    file_count: usize,
) -> Result<bool> {
    if file_count == 0 {
        return Ok(true);
    }
    let workers = workers.clamp(1, file_count);
    let bounds_connection = open_catalog_read_only(catalog_path)?;
    let (minimum_id, maximum_id): (i64, i64) = bounds_connection.query_row(
        "SELECT COALESCE(MIN(id), 0), COALESCE(MAX(id), 0) FROM files",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    drop(bounds_connection);
    let id_span = u64::try_from(i128::from(maximum_id) - i128::from(minimum_id) + 1)
        .context("catalog file ID range is invalid")?;
    let ids_per_worker = id_span.div_ceil(workers as u64);
    let cancelled = AtomicBool::new(false);
    let mut matches = true;
    thread::scope(|scope| -> Result<()> {
        let mut handles = Vec::with_capacity(workers);
        for worker in 0..workers {
            let cancelled = &cancelled;
            handles.push(scope.spawn(move || -> Result<bool> {
                let outcome = (|| -> Result<bool> {
                    let first_id =
                        i128::from(minimum_id) + i128::from(ids_per_worker) * worker as i128;
                    let last_id =
                        (first_id + i128::from(ids_per_worker) - 1).min(i128::from(maximum_id));
                    let first_id =
                        i64::try_from(first_id).context("catalog worker ID range overflow")?;
                    let last_id =
                        i64::try_from(last_id).context("catalog worker ID range overflow")?;
                    let connection = open_catalog_read_only(catalog_path)?;
                    let mut statement = connection.prepare(
                        "SELECT path, bytes, content_sha256
                         FROM files
                         WHERE id BETWEEN ?1 AND ?2
                         ORDER BY id ASC",
                    )?;
                    let mut rows = statement.query(params![first_id, last_id])?;
                    let mut archive = ZipArchive::new(File::open(source)?)?;
                    while let Some(row) = rows.next()? {
                        if cancelled.load(Ordering::Relaxed) {
                            return Ok(true);
                        }
                        let path: String = row.get(0)?;
                        let bytes = row.get::<_, i64>(1)?.max(0) as u64;
                        let Some(expected_digest) = row.get::<_, Option<String>>(2)? else {
                            cancelled.store(true, Ordering::Relaxed);
                            return Ok(false);
                        };
                        let mut entry = match archive.by_name(&path) {
                            Ok(entry) => entry,
                            Err(_) => {
                                cancelled.store(true, Ordering::Relaxed);
                                return Ok(false);
                            }
                        };
                        if entry.size() != bytes || hash_reader(&mut entry)? != expected_digest {
                            cancelled.store(true, Ordering::Relaxed);
                            return Ok(false);
                        }
                    }
                    Ok(true)
                })();
                if outcome.is_err() {
                    cancelled.store(true, Ordering::Relaxed);
                }
                outcome
            }));
        }
        for handle in handles {
            let worker_matches = handle
                .join()
                .map_err(|_| anyhow::anyhow!("archive validation worker panicked"))??;
            matches &= worker_matches;
        }
        Ok(())
    })?;
    Ok(matches)
}

fn open_catalog_read_only(path: &Path) -> Result<Connection> {
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let connection = Connection::open_with_flags(path, flags)?;
    connection.pragma_update(None, "query_only", true)?;
    connection.pragma_update(None, "trusted_schema", false)?;
    Ok(connection)
}

fn safe_source_join(source: &Path, relative: &str) -> Result<PathBuf> {
    if relative.is_empty()
        || relative.starts_with('/')
        || relative
            .split('/')
            .any(|component| component.is_empty() || component == "." || component == "..")
    {
        bail!("catalog contains an unsafe source path: {relative}");
    }
    Ok(source.join(relative))
}

fn file_record_fingerprint(path: &Path) -> Result<(u64, i64)> {
    let metadata = fs::metadata(path)?;
    Ok((metadata.len(), modified_ns(metadata.modified().ok())))
}

fn hash_directory_file(path: &Path, bytes: u64, modified_ns: i64) -> Result<String> {
    let before = file_record_fingerprint(path)?;
    if before != (bytes, modified_ns) {
        bail!("source file changed while scanning: {}", path.display());
    }
    let digest = hash_reader(BufReader::with_capacity(
        HASH_BUFFER_BYTES,
        File::open(path)?,
    ))?;
    if file_record_fingerprint(path)? != before {
        bail!("source file changed while scanning: {}", path.display());
    }
    Ok(digest)
}

fn source_metadata_fingerprint(path: &Path, kind: SourceKind) -> Result<String> {
    let mut hasher = Sha256::new();
    if kind == SourceKind::Directory {
        let mut entries = Vec::new();
        for entry in WalkDir::new(path).follow_links(false) {
            let entry = entry?;
            if !entry.file_type().is_file() {
                continue;
            }
            let relative = entry.path().strip_prefix(path).with_context(|| {
                format!(
                    "source entry is outside the source root: {}",
                    entry.path().display()
                )
            })?;
            let metadata = entry.metadata()?;
            entries.push((
                relative.to_string_lossy().replace('\\', "/"),
                metadata.len(),
                modified_ns(metadata.modified().ok()),
            ));
        }
        entries.sort_unstable_by(|left, right| left.0.cmp(&right.0));
        hasher.update((entries.len() as u64).to_le_bytes());
        for (relative, bytes, modified) in entries {
            hasher.update(relative.as_bytes());
            hasher.update([0]);
            hasher.update(bytes.to_le_bytes());
            hasher.update(modified.to_le_bytes());
        }
    } else {
        let metadata = fs::metadata(path)?;
        hasher.update(metadata.len().to_le_bytes());
        hasher.update(modified_ns(metadata.modified().ok()).to_le_bytes());
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn validate_sha256(value: &str) -> Result<()> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("sha256 must contain exactly 64 hexadecimal characters");
    }
    Ok(())
}

fn attachment_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AttachmentItem> {
    let raw_kind: String = row.get(4)?;
    let kind = match raw_kind.as_str() {
        "original" => AttachmentKind::Original,
        "thumbnail" => AttachmentKind::Thumbnail,
        _ => unreachable!("catalog only stores known attachment kinds"),
    };
    let removal_reason: String = row.get(8)?;
    let reference_status: String = row.get(9)?;
    let context = if reference_status == "referenced" {
        Some(AttachmentContext {
            source: row.get::<_, Option<String>>(12)?.unwrap_or_default(),
            message_pk: row.get(10)?,
            chat_pk: row.get(11)?,
            chat_id: row.get::<_, Option<String>>(13)?.unwrap_or_default(),
            chat_title: row.get::<_, Option<String>>(14)?.unwrap_or_default(),
            chat_kind: row.get::<_, Option<String>>(15)?.unwrap_or_default(),
            timestamp: row.get::<_, Option<i64>>(16)?.unwrap_or(0),
            sender_pk: row.get(17)?,
            sender_name: row.get::<_, Option<String>>(18)?.unwrap_or_default(),
            content_type: row.get(19)?,
            text: row.get::<_, Option<String>>(20)?.unwrap_or_default(),
        })
    } else {
        None
    };
    Ok(AttachmentItem {
        id: row.get(0)?,
        path: row.get(1)?,
        bytes: row.get::<_, i64>(2)?.max(0) as u64,
        modified_ns: row.get(3)?,
        kind,
        message_id: row.get(5)?,
        chat_hint: row.get(6)?,
        marked_for_removal: row.get(7)?,
        removal_reason,
        reference_status,
        context,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fs::File;
    use std::io::Write;
    use std::path::Path;

    use tempfile::TempDir;
    use zip::ZipWriter;
    use zip::write::SimpleFileOptions;

    use super::{
        Catalog, FileRecord, scan_archive_records_parallel, validate_archive_catalog_parallel,
    };
    use crate::source::SourceKind;

    fn write_archive(path: &Path, entries: usize, changed_entry: Option<usize>) {
        let mut writer = ZipWriter::new(File::create(path).unwrap());
        let options = SimpleFileOptions::default();
        for index in 0..entries {
            writer
                .start_file(format!("payload/{index:04}.bin"), options)
                .unwrap();
            let fill = if changed_entry == Some(index) {
                b'X'
            } else {
                b'A' + u8::try_from(index % 20).unwrap()
            };
            writer.write_all(&vec![fill; 32 * 1024]).unwrap();
        }
        writer.finish().unwrap();
    }

    fn record_map(records: Vec<FileRecord>) -> BTreeMap<String, (u64, String)> {
        records
            .into_iter()
            .map(|record| (record.path, (record.bytes, record.content_sha256)))
            .collect()
    }

    #[test]
    fn parallel_archive_hashing_matches_sequential_results_and_detects_changes() {
        let temporary = TempDir::new().unwrap();
        let archive_path = temporary.path().join("parallel.imazingapp");
        write_archive(&archive_path, 48, None);

        let mut sequential = Vec::new();
        scan_archive_records_parallel(&archive_path, 48, 1, |record| {
            sequential.push(record);
            Ok(())
        })
        .unwrap();
        let mut parallel = Vec::new();
        scan_archive_records_parallel(&archive_path, 48, 4, |record| {
            parallel.push(record);
            Ok(())
        })
        .unwrap();
        assert_eq!(record_map(parallel), record_map(sequential));

        let catalog_path = temporary.path().join("catalog.sqlite");
        let mut catalog = Catalog::open(&catalog_path).unwrap();
        catalog
            .scan_source(&archive_path, SourceKind::ImazingArchive, |_| {})
            .unwrap();
        assert!(validate_archive_catalog_parallel(&archive_path, &catalog_path, 4, 48).unwrap());

        write_archive(&archive_path, 48, Some(17));
        assert!(!validate_archive_catalog_parallel(&archive_path, &catalog_path, 4, 48).unwrap());
    }
}
