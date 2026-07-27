use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::candidate::build_candidate;
use crate::catalog::Catalog;
use crate::database::{
    Fts5MessageIndex, LineDatabase, LineSquareDatabase, OrphanMessage, UnifiedGroupDatabase,
};
use crate::model::{
    AdvancedCleanupReport, AttachmentCursor, AttachmentKind, Chat, ChatCursor, ChatPage,
    CleanupGroupPage, CleanupPreflightReport, CleanupRisk, DEFAULT_PAGE_SIZE, DuplicateGroupCursor,
    MessageCursor, MessagePage,
};
use crate::performance::system_performance_profile;
use crate::source::{PreparedSource, SourceKind, prepare_source_reporting};

pub const SIDECAR_PROTOCOL_VERSION: u32 = 1;
const MAX_REQUEST_BYTES: usize = 1024 * 1024;

pub struct NativeSession {
    prepared: PreparedSource,
    database: LineDatabase,
    square_database: Option<LineSquareDatabase>,
    unified_group_database: Option<UnifiedGroupDatabase>,
    catalog: Catalog,
    fts5_index: Option<Fts5MessageIndex>,
    quick_check: Option<String>,
    catalog_source_verified: bool,
}

impl NativeSession {
    pub fn open(source: &Path, work_dir: &Path) -> Result<Self> {
        Self::open_reporting(source, work_dir, &mut std::io::sink())
    }

    /// Preparation can copy multi-gigabyte databases out of an archive, so the caller receives
    /// `sourcePrepareProgress` lines and the ready handshake never waits on unbounded work such as
    /// interrupted-operation recovery.
    pub fn open_reporting<W: Write>(
        source: &Path,
        work_dir: &Path,
        output: &mut W,
    ) -> Result<Self> {
        let prepared = prepare_source_reporting(source, work_dir, |progress| {
            let _ = write_json_line(
                output,
                &json!({
                    "event": "sourcePrepareProgress",
                    "phase": progress.phase,
                    "entry": progress.entry,
                    "stagedBytes": progress.staged_bytes,
                    "totalBytes": progress.total_bytes,
                }),
            );
        })?;
        let database = LineDatabase::open(&prepared.database_path)?;
        let square_database = prepared
            .square_database_path
            .as_deref()
            .map(LineSquareDatabase::open)
            .transpose()?;
        let unified_group_database = prepared
            .unified_group_database_path
            .as_deref()
            .map(UnifiedGroupDatabase::open)
            .transpose()?;
        let catalog = Catalog::open(&work_dir.join("catalog.sqlite"))?;
        let fts5_index = Fts5MessageIndex::open(&work_dir.join("search.sqlite")).ok();
        Ok(Self {
            prepared,
            database,
            square_database,
            unified_group_database,
            catalog,
            fts5_index,
            quick_check: None,
            catalog_source_verified: false,
        })
    }

    fn quick_check(&mut self) -> Result<String> {
        if let Some(value) = self.quick_check.as_ref() {
            return Ok(value.clone());
        }
        let value = self.database.quick_check()?;
        self.quick_check = Some(value.clone());
        Ok(value)
    }

    fn rebuild_chat_index(&mut self) -> Result<()> {
        let mut chats = self.database.chats_for_index()?;
        self.database.enrich_chat_titles(
            &mut chats,
            self.unified_group_database.as_ref(),
            self.square_database.as_ref(),
        )?;
        if let Some(square_database) = self.square_database.as_ref() {
            chats.extend(square_database.chats_for_index()?);
        }
        self.catalog.replace_chat_index(&chats)
    }

    fn search_messages_with_fts<W: Write>(
        &mut self,
        params: &MessageSearchParams,
        request: &Request,
        output: &mut W,
    ) -> Result<Option<MessagePage>> {
        let Some(source_key) = self.catalog.source_fingerprint()? else {
            return Ok(None);
        };
        if !self
            .catalog
            .source_matches_current(&self.prepared.original_path, self.prepared.report.kind)?
        {
            return Ok(None);
        }
        let Some(index) = self.fts5_index.as_mut() else {
            return Ok(None);
        };
        self.catalog
            .set_active_job("search", request.job_id.as_deref())?;
        let build_result = index.ensure_built(
            &source_key,
            &self.database,
            self.square_database.as_ref(),
            |processed| {
                if processed % 256 == 0 {
                    let _ = write_json_line(
                        output,
                        &json!({
                            "event": "searchIndexProgress",
                            "requestId": request.id,
                            "jobId": request.job_id,
                            "processedMessages": processed,
                        }),
                    );
                }
            },
        );
        if let Err(error) = build_result {
            let _ = self.catalog.clear_active_job("search");
            return Err(error);
        }
        let result = index.search(
            &params.query,
            &params.source,
            params.chat_pk,
            params.cursor,
            params.before_cursor,
            params.limit,
            self.prepared.account_id.as_deref(),
        );
        self.catalog.clear_active_job("search")?;
        Ok(Some(result?))
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    id: String,
    #[serde(default)]
    job_id: Option<String>,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Response<'a> {
    id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    job_id: Option<&'a str>,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorBody>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorBody {
    code: &'static str,
    message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatPageParams {
    #[serde(default = "default_chat_limit")]
    limit: u32,
    #[serde(default)]
    cursor: Option<ChatCursor>,
    #[serde(default)]
    before_cursor: Option<ChatCursor>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessagePageParams {
    chat_pk: i64,
    #[serde(default = "default_message_source")]
    source: String,
    #[serde(default = "default_message_limit")]
    limit: u32,
    #[serde(default)]
    cursor: Option<MessageCursor>,
    #[serde(default)]
    before_cursor: Option<MessageCursor>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessageSearchParams {
    query: String,
    #[serde(default = "default_message_source")]
    source: String,
    #[serde(default)]
    chat_pk: Option<i64>,
    #[serde(default = "default_message_limit")]
    limit: u32,
    #[serde(default)]
    cursor: Option<MessageCursor>,
    #[serde(default)]
    before_cursor: Option<MessageCursor>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentPageParams {
    #[serde(default = "default_attachment_limit")]
    limit: u32,
    #[serde(default)]
    cursor: Option<AttachmentCursor>,
    #[serde(default)]
    kind: Option<AttachmentKind>,
    #[serde(default)]
    search: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarkParams {
    path: String,
    marked: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CleanupAuditParams {
    #[serde(default = "default_cleanup_audit_limit")]
    limit: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewParams {
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuildCandidateParams {
    output: PathBuf,
    #[serde(default)]
    full_crc: bool,
    #[serde(default)]
    link_duplicates: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DuplicateGroupParams {
    #[serde(default = "default_attachment_limit")]
    limit: u32,
    #[serde(default)]
    cursor: Option<DuplicateGroupCursor>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DuplicateMemberParams {
    sha256: String,
    #[serde(default = "default_attachment_limit")]
    limit: u32,
    #[serde(default)]
    cursor: Option<AttachmentCursor>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CleanupPageParams {
    #[serde(default = "default_cleanup_page")]
    page: u32,
    #[serde(default = "default_cleanup_page_size")]
    page_size: u32,
    #[serde(default)]
    search: Option<String>,
    #[serde(default = "default_cleanup_kind")]
    kind: String,
    #[serde(default = "default_cleanup_category")]
    category: String,
    #[serde(default = "default_cleanup_sort")]
    sort: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CleanupReviewParams {
    group_key: String,
    #[serde(flatten)]
    page: CleanupPageParams,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CleanupGroupActionParams {
    group_key: String,
    action: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatRemovalParams {
    source: String,
    chat_pk: i64,
    planned: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BulkRemovalParams {
    planned: bool,
}

struct AdvancedCleanupAnalysis {
    chats: Vec<Chat>,
    community_chats: Vec<Chat>,
    orphan_messages: Vec<OrphanMessage>,
    line_empty_chats: u64,
    line_system_only_chats: u64,
    square_available: bool,
    square_empty_chats: u64,
    square_system_only_chats: u64,
}

enum ReadLine {
    Eof,
    Line,
    TooLarge,
}

pub fn serve<R: BufRead, W: Write>(
    session: &mut NativeSession,
    input: &mut R,
    output: &mut W,
) -> Result<()> {
    write_json_line(
        output,
        &json!({
            "event": "ready",
            "protocolVersion": SIDECAR_PROTOCOL_VERSION,
            "source": session.prepared.report,
            "readOnly": session.database.is_read_only()?,
        }),
    )?;

    let mut line = Vec::new();
    loop {
        match read_bounded_line(input, &mut line, MAX_REQUEST_BYTES)? {
            ReadLine::Eof => break,
            ReadLine::TooLarge => {
                write_error(
                    output,
                    "",
                    None,
                    "request_too_large",
                    "request exceeds 1 MiB",
                )?;
                continue;
            }
            ReadLine::Line => {}
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let request: Request = match serde_json::from_slice(&line) {
            Ok(request) => request,
            Err(error) => {
                write_error(
                    output,
                    "",
                    None,
                    "invalid_request",
                    &format!("invalid JSON request: {error}"),
                )?;
                continue;
            }
        };
        let should_shutdown = request.method == "shutdown";
        match handle_request(session, &request, output) {
            Ok(result) => write_json_line(
                output,
                &Response {
                    id: &request.id,
                    job_id: request.job_id.as_deref(),
                    ok: true,
                    result: Some(result),
                    error: None,
                },
            )?,
            Err(error) => write_error(
                output,
                &request.id,
                request.job_id.as_deref(),
                "operation_failed",
                &format!("{error:#}"),
            )?,
        }
        if should_shutdown {
            break;
        }
    }
    Ok(())
}

fn handle_request<W: Write>(
    session: &mut NativeSession,
    request: &Request,
    output: &mut W,
) -> Result<Value> {
    match request.method.as_str() {
        "recoverInterruptedOperations" => {
            session.catalog.recover_interrupted_operations(
                &session.prepared.original_path,
                session.prepared.report.kind,
            )?;
            Ok(json!({ "recovered": true }))
        }
        "sessionInfo" => {
            let quick_check = session.quick_check()?;
            let performance = system_performance_profile();
            let active_job = session
                .catalog
                .active_job()?
                .map(|(kind, job_id)| json!({ "kind": kind, "jobId": job_id }));
            let catalog_source_current = session.catalog.source_matches_current(
                &session.prepared.original_path,
                session.prepared.report.kind,
            )?;
            session.catalog_source_verified = catalog_source_current;
            Ok(json!({
                "protocolVersion": SIDECAR_PROTOCOL_VERSION,
                "source": session.prepared.report,
                "readOnly": session.database.is_read_only()?,
                "quickCheck": quick_check,
                "lineSquareLoaded": session.square_database.is_some(),
                "unifiedGroupLoaded": session.unified_group_database.is_some(),
                "catalogSourceCurrent": catalog_source_current,
                "activeJob": active_job,
                "fts5Available": session.fts5_index.is_some(),
                "performance": {
                    "logicalCpus": performance.logical_cpus,
                    "physicalMemoryBytes": performance.physical_memory_bytes,
                    "archiveWorkers": performance.archive_workers,
                    "sqliteWorkers": performance.sqlite_workers,
                    "lineCacheKiB": performance.line_cache_kib.unsigned_abs(),
                    "lineMmapBytes": performance.line_mmap_bytes,
                    "catalogCacheKiB": performance.catalog_cache_kib.unsigned_abs(),
                },
                "catalog": session.catalog.stats()?,
            }))
        }
        "listChats" => {
            let params: ChatPageParams = parse_params(request)?;
            if params.cursor.is_some() && params.before_cursor.is_some() {
                anyhow::bail!("chat pagination cannot use both cursor and beforeCursor");
            }
            if session.catalog_source_verified && !session.catalog.chat_index_is_current()? {
                session.rebuild_chat_index()?;
            }
            if session.catalog_source_verified && session.catalog.chat_index_is_current()? {
                return Ok(serde_json::to_value(session.catalog.list_indexed_chats(
                    params.cursor,
                    params.before_cursor,
                    params.limit,
                )?)?);
            }
            let line_page = if let Some(cursor) = params.before_cursor.clone() {
                session.database.list_chats_before(cursor, params.limit)?
            } else {
                session
                    .database
                    .list_chats(params.cursor.clone(), params.limit)?
            };
            let mut items = line_page.items;
            let line_has_next = line_page.next_cursor.is_some();
            let line_has_previous = line_page.has_previous;
            let mut square_has_next = false;
            let mut square_has_previous = false;
            if let Some(square_database) = session.square_database.as_ref() {
                let square_page = if let Some(cursor) = params.before_cursor.clone() {
                    square_database.list_chats_before(cursor, params.limit)?
                } else {
                    square_database.list_chats(params.cursor.clone(), params.limit)?
                };
                square_has_next = square_page.next_cursor.is_some();
                square_has_previous = square_page.has_previous;
                items.extend(square_page.items);
            }
            session.database.enrich_chat_titles(
                &mut items,
                session.unified_group_database.as_ref(),
                session.square_database.as_ref(),
            )?;
            session.catalog.enrich_planned_chats(&mut items)?;
            items.sort_by(|left, right| {
                right
                    .last_updated
                    .cmp(&left.last_updated)
                    .then_with(|| left.source.cmp(&right.source))
                    .then_with(|| left.pk.cmp(&right.pk))
            });
            let combined_len = items.len();
            let has_next = if params.before_cursor.is_some() {
                !items.is_empty()
            } else {
                combined_len > params.limit as usize || line_has_next || square_has_next
            };
            let has_previous = if params.before_cursor.is_some() {
                combined_len > params.limit as usize || line_has_previous || square_has_previous
            } else {
                params.cursor.is_some()
            };
            items.truncate(params.limit as usize);
            let next_cursor = if has_next {
                items.last().map(|chat| ChatCursor {
                    last_updated: chat.last_updated,
                    source: chat.source.clone(),
                    pk: chat.pk,
                })
            } else {
                None
            };
            let page = ChatPage {
                items,
                next_cursor,
                has_previous,
            };
            Ok(serde_json::to_value(page)?)
        }
        "listMessages" => {
            let params: MessagePageParams = parse_params(request)?;
            if params.cursor.is_some() && params.before_cursor.is_some() {
                anyhow::bail!("message pagination cannot use both cursor and beforeCursor");
            }
            let mut page = match params.source.as_str() {
                "line" => match params.before_cursor {
                    Some(cursor) => session.database.list_messages_for_account_before(
                        params.chat_pk,
                        cursor,
                        params.limit,
                        session.prepared.account_id.as_deref(),
                    )?,
                    None => session.database.list_messages_for_account(
                        params.chat_pk,
                        params.cursor,
                        params.limit,
                        session.prepared.account_id.as_deref(),
                    )?,
                },
                "square" => match params.before_cursor {
                    Some(cursor) => session
                        .square_database
                        .as_ref()
                        .context("LineSquare.sqlite is not available")?
                        .list_messages_before(
                            params.chat_pk,
                            cursor,
                            params.limit,
                            session.prepared.account_id.as_deref(),
                        )?,
                    None => session
                        .square_database
                        .as_ref()
                        .context("LineSquare.sqlite is not available")?
                        .list_messages(
                            params.chat_pk,
                            params.cursor,
                            params.limit,
                            session.prepared.account_id.as_deref(),
                        )?,
                },
                _ => anyhow::bail!("message source must be `line` or `square`"),
            };
            session
                .catalog
                .enrich_messages_with_attachments(&mut page.items)?;
            Ok(serde_json::to_value(page)?)
        }
        "searchMessages" => {
            let params: MessageSearchParams = parse_params(request)?;
            if params.cursor.is_some() && params.before_cursor.is_some() {
                anyhow::bail!("message search pagination cannot use both cursor and beforeCursor");
            }
            let mut page = if let Ok(Some(page)) =
                session.search_messages_with_fts(&params, request, output)
            {
                page
            } else {
                match params.source.as_str() {
                    "line" => match params.before_cursor {
                        Some(cursor) => session.database.search_messages_for_account_before(
                            &params.query,
                            params.chat_pk,
                            cursor,
                            params.limit,
                            session.prepared.account_id.as_deref(),
                        )?,
                        None => session.database.search_messages_for_account(
                            &params.query,
                            params.chat_pk,
                            params.cursor,
                            params.limit,
                            session.prepared.account_id.as_deref(),
                        )?,
                    },
                    "square" => match params.before_cursor {
                        Some(cursor) => session
                            .square_database
                            .as_ref()
                            .context("LineSquare.sqlite is not available")?
                            .search_messages_before(
                                &params.query,
                                params.chat_pk,
                                cursor,
                                params.limit,
                                session.prepared.account_id.as_deref(),
                            )?,
                        None => session
                            .square_database
                            .as_ref()
                            .context("LineSquare.sqlite is not available")?
                            .search_messages(
                                &params.query,
                                params.chat_pk,
                                params.cursor,
                                params.limit,
                                session.prepared.account_id.as_deref(),
                            )?,
                    },
                    _ => anyhow::bail!("message source must be `line` or `square`"),
                }
            };
            session
                .catalog
                .enrich_messages_with_attachments(&mut page.items)?;
            Ok(serde_json::to_value(page)?)
        }
        "scanCatalog" => {
            let request_id = request.id.clone();
            session
                .catalog
                .set_active_job("scan", request.job_id.as_deref())?;
            session.catalog.scan_source(
                &session.prepared.original_path,
                session.prepared.report.kind,
                |progress| {
                    let _ = write_json_line(
                        output,
                        &json!({
                            "event": "catalogProgress",
                            "requestId": request_id,
                            "jobId": request.job_id,
                            "files": progress.files,
                            "bytes": progress.bytes,
                            "attachments": progress.attachments,
                        }),
                    );
                },
            )?;
            let context_request_id = request.id.clone();
            session.catalog.index_attachment_contexts(
                &session.database,
                session.square_database.as_ref(),
                session.unified_group_database.as_ref(),
                |progress| {
                    let _ = write_json_line(
                        output,
                        &json!({
                            "event": "catalogContextProgress",
                            "requestId": context_request_id,
                            "jobId": request.job_id,
                            "processedFiles": progress.processed_files,
                            "totalFiles": progress.total_files,
                            "referencedFiles": progress.referenced_files,
                            "unreferencedFiles": progress.unreferenced_files,
                            "unconfirmedFiles": progress.unconfirmed_files,
                        }),
                    );
                },
            )?;
            session.rebuild_chat_index()?;
            session.catalog_source_verified = true;
            let stats = session.catalog.stats()?;
            session.catalog.clear_active_job("scan")?;
            Ok(serde_json::to_value(stats)?)
        }
        "listAttachments" => {
            let params: AttachmentPageParams = parse_params(request)?;
            let page = session.catalog.list_attachments(
                params.cursor,
                params.limit,
                params.kind,
                params.search.as_deref(),
            )?;
            Ok(serde_json::to_value(page)?)
        }
        "setAttachmentMarked" => {
            let params: MarkParams = parse_params(request)?;
            session.catalog.set_marked(&params.path, params.marked)?;
            Ok(serde_json::to_value(session.catalog.cleanup_overview()?)?)
        }
        "clearManualAttachmentPlan" => Ok(serde_json::to_value(
            session.catalog.clear_manual_attachment_plan()?,
        )?),
        "clearAllRemovalPlans" => Ok(serde_json::to_value(
            session.catalog.clear_all_user_removal_plans()?,
        )?),
        "stageAttachmentPreview" => {
            let params: PreviewParams = parse_params(request)?;
            Ok(serde_json::to_value(
                session.catalog.stage_attachment_preview(
                    &session.prepared.original_path,
                    session.prepared.report.kind,
                    &params.path,
                )?,
            )?)
        }
        "catalogStats" => Ok(serde_json::to_value(session.catalog.stats()?)?),
        "cleanupOverview" => Ok(serde_json::to_value(session.catalog.cleanup_overview()?)?),
        "cleanupPreflight" => Ok(serde_json::to_value(cleanup_preflight(session)?)?),
        "cleanupPlanPreviews" => Ok(serde_json::to_value(
            session.catalog.cleanup_plan_previews()?,
        )?),
        "cleanupAudit" => {
            let params: CleanupAuditParams = parse_params(request)?;
            Ok(serde_json::to_value(
                session.catalog.cleanup_audit(params.limit)?,
            )?)
        }
        "setAllChatAttachmentsPlanned" => {
            let params: BulkRemovalParams = parse_params(request)?;
            Ok(serde_json::to_value(
                session
                    .catalog
                    .set_all_chat_attachments_planned(params.planned)?,
            )?)
        }
        "listCleanupGroups" => {
            let params: CleanupPageParams = parse_params(request)?;
            let page = if params.category == "no_attachments" {
                list_empty_attachment_chats(session, &params)?
            } else {
                session.catalog.list_cleanup_groups(
                    params.page,
                    params.page_size,
                    params.search.as_deref(),
                    &params.kind,
                    &params.category,
                    &params.sort,
                )?
            };
            Ok(serde_json::to_value(page)?)
        }
        "listCleanupReviews" => {
            let params: CleanupReviewParams = parse_params(request)?;
            Ok(serde_json::to_value(
                session.catalog.list_cleanup_reviews(
                    &params.group_key,
                    params.page.page,
                    params.page.page_size,
                    params.page.search.as_deref(),
                    &params.page.kind,
                    &params.page.category,
                    &params.page.sort,
                )?,
            )?)
        }
        "applyCleanupGroupAction" => {
            let params: CleanupGroupActionParams = parse_params(request)?;
            Ok(serde_json::to_value(
                session
                    .catalog
                    .apply_cleanup_group_action(&params.group_key, &params.action)?,
            )?)
        }
        "planSafeAttachmentCleanup" => Ok(serde_json::to_value(
            session.catalog.plan_safe_attachment_cleanup()?,
        )?),
        "advancedCleanupReport" => Ok(serde_json::to_value(advanced_cleanup_report(session)?)?),
        "setChatRemovalPlanned" => {
            let params: ChatRemovalParams = parse_params(request)?;
            let chat = match params.source.as_str() {
                "line" => session.database.chat_for_cleanup(params.chat_pk)?,
                "square" => session
                    .square_database
                    .as_ref()
                    .context("LineSquare.sqlite is not available")?
                    .chat_for_cleanup(params.chat_pk)?,
                _ => anyhow::bail!("chat cleanup source must be `line` or `square`"),
            };
            session
                .catalog
                .set_chat_removal_planned(&chat, params.planned, "selected")?;
            Ok(serde_json::to_value(advanced_cleanup_report(session)?)?)
        }
        "planAutomaticCleanup" => {
            let analysis = analyze_advanced_cleanup(session)?;
            session
                .catalog
                .plan_automatic_cleanup(&analysis.chats, &analysis.orphan_messages)?;
            Ok(serde_json::to_value(report_from_analysis(
                session, &analysis,
            )?)?)
        }
        "setCommunityCleanupPlanned" => {
            let params: BulkRemovalParams = parse_params(request)?;
            let analysis = analyze_advanced_cleanup(session)?;
            if !analysis.square_available {
                anyhow::bail!("LineSquare.sqlite is not available");
            }
            let database_entry =
                sibling_entry_name(&session.prepared.report.database_path, "LineSquare.sqlite");
            let community_messages = analysis
                .community_chats
                .iter()
                .map(|chat| chat.message_count.max(0) as u64)
                .sum::<u64>()
                .saturating_add(analysis.orphan_messages.len() as u64);
            session.catalog.set_community_cleanup_planned(
                &analysis.community_chats,
                community_messages,
                &database_entry,
                params.planned,
            )?;
            Ok(serde_json::to_value(report_from_analysis(
                session, &analysis,
            )?)?)
        }
        "setOldAccountCleanupPlanned" => {
            let params: BulkRemovalParams = parse_params(request)?;
            let current_account_id = session
                .prepared
                .current_account_verified
                .then_some(session.prepared.account_id.as_deref())
                .flatten();
            session
                .catalog
                .set_old_account_cleanup_planned(current_account_id, params.planned)?;
            Ok(serde_json::to_value(advanced_cleanup_report(session)?)?)
        }
        "clearAdvancedCleanupPlan" => {
            session.catalog.clear_advanced_cleanup_plan()?;
            Ok(serde_json::to_value(advanced_cleanup_report(session)?)?)
        }
        "hashDuplicateCandidates" => {
            let request_id = request.id.clone();
            session
                .catalog
                .set_active_job("hash", request.job_id.as_deref())?;
            let result = session.catalog.hash_duplicate_candidates(
                &session.prepared.original_path,
                session.prepared.report.kind,
                |progress| {
                    if progress.processed_files % 64 == 0
                        || progress.processed_files == progress.candidate_files
                    {
                        write_json_line(
                            output,
                            &json!({
                                "event": "duplicateHashProgress",
                                "requestId": request_id,
                                "jobId": request.job_id,
                                "candidateFiles": progress.candidate_files,
                                "processedFiles": progress.processed_files,
                                "totalBytes": progress.total_bytes,
                                "processedBytes": progress.processed_bytes,
                            }),
                        )
                    } else {
                        Ok(())
                    }
                },
            )?;
            session.catalog.clear_active_job("hash")?;
            Ok(serde_json::to_value(result)?)
        }
        "listDuplicateGroups" => {
            let params: DuplicateGroupParams = parse_params(request)?;
            Ok(serde_json::to_value(
                session
                    .catalog
                    .list_duplicate_groups(params.cursor, params.limit)?,
            )?)
        }
        "listDuplicateMembers" => {
            let params: DuplicateMemberParams = parse_params(request)?;
            let page = session.catalog.list_duplicate_members(
                &params.sha256,
                params.cursor,
                params.limit,
            )?;
            Ok(serde_json::to_value(page)?)
        }
        "buildCandidate" => {
            let params: BuildCandidateParams = parse_params(request)?;
            let request_id = request.id.clone();
            session
                .catalog
                .set_active_job("candidate", request.job_id.as_deref())?;
            let report = build_candidate(
                &session.prepared.original_path,
                &params.output,
                &session.catalog,
                params.full_crc,
                params.link_duplicates,
                |progress| {
                    if progress.processed_entries % 64 == 0
                        || progress.processed_entries == progress.total_entries
                    {
                        write_json_line(
                            output,
                            &json!({
                                "event": "candidateProgress",
                                "requestId": request_id,
                                "jobId": request.job_id,
                                "processedBytes": progress.processed_bytes,
                                "totalBytes": progress.total_bytes,
                                "processedEntries": progress.processed_entries,
                                "totalEntries": progress.total_entries,
                            }),
                        )
                    } else {
                        Ok(())
                    }
                },
            )?;
            session.catalog.clear_active_job("candidate")?;
            Ok(serde_json::to_value(report)?)
        }
        "shutdown" => Ok(json!({ "shuttingDown": true })),
        _ => anyhow::bail!("unknown method: {}", request.method),
    }
}

fn analyze_advanced_cleanup(session: &NativeSession) -> Result<AdvancedCleanupAnalysis> {
    let line_chats = session.database.advanced_cleanup_chats()?;
    let line_empty_chats = line_chats
        .iter()
        .filter(|chat| chat.message_count == 0)
        .count() as u64;
    let line_system_only_chats = line_chats
        .iter()
        .filter(|chat| chat.message_count > 0 && chat.human_message_count == 0)
        .count() as u64;
    let mut chats = line_chats;
    let (
        square_available,
        community_chats,
        square_empty_chats,
        square_system_only_chats,
        orphan_messages,
    ) = if let Some(database) = session.square_database.as_ref() {
        let all_square_chats = database.all_chats_for_cleanup()?;
        let filtered_square_chats = all_square_chats
            .iter()
            .filter(|chat| chat.message_count == 0)
            .cloned()
            .chain(
                all_square_chats
                    .iter()
                    .filter(|chat| chat.message_count > 0 && chat.human_message_count == 0)
                    .cloned(),
            )
            .collect::<Vec<_>>();
        let empty = filtered_square_chats
            .iter()
            .filter(|chat| chat.message_count == 0)
            .count() as u64;
        let system_only = filtered_square_chats
            .iter()
            .filter(|chat| chat.message_count > 0 && chat.human_message_count == 0)
            .count() as u64;
        chats.extend(filtered_square_chats);
        (
            true,
            all_square_chats,
            empty,
            system_only,
            database.orphan_messages()?,
        )
    } else {
        (false, Vec::new(), 0, 0, Vec::new())
    };
    Ok(AdvancedCleanupAnalysis {
        chats,
        community_chats,
        orphan_messages,
        line_empty_chats,
        line_system_only_chats,
        square_available,
        square_empty_chats,
        square_system_only_chats,
    })
}

fn report_from_analysis(
    session: &NativeSession,
    analysis: &AdvancedCleanupAnalysis,
) -> Result<AdvancedCleanupReport> {
    let current_account_id = session
        .prepared
        .current_account_verified
        .then_some(session.prepared.account_id.as_deref())
        .flatten();
    let old_accounts = session.catalog.old_account_summary(current_account_id)?;
    let community_messages = analysis
        .community_chats
        .iter()
        .map(|chat| chat.message_count.max(0) as u64)
        .sum::<u64>()
        .saturating_add(analysis.orphan_messages.len() as u64);
    let community_database_entry =
        sibling_entry_name(&session.prepared.report.database_path, "LineSquare.sqlite");
    let community_cleanup = if analysis.square_available {
        session
            .catalog
            .community_cleanup_summary(&analysis.community_chats, &community_database_entry)?
    } else {
        Default::default()
    };
    session.catalog.advanced_cleanup_report(
        analysis.line_empty_chats,
        analysis.line_system_only_chats,
        analysis.square_available,
        analysis.community_chats.len() as u64,
        community_messages,
        community_cleanup,
        analysis.square_empty_chats,
        analysis.square_system_only_chats,
        analysis.orphan_messages.len() as u64,
        session.prepared.current_account_verified && old_accounts.current_account_found,
        old_accounts,
    )
}

fn advanced_cleanup_report(session: &NativeSession) -> Result<AdvancedCleanupReport> {
    let analysis = analyze_advanced_cleanup(session)?;
    report_from_analysis(session, &analysis)
}

fn cleanup_preflight(session: &mut NativeSession) -> Result<CleanupPreflightReport> {
    let quick_check = session.quick_check()?;
    let source_read_only = session.database.is_read_only()?;
    let catalog_source_current = session.catalog.source_matches_current(
        &session.prepared.original_path,
        session.prepared.report.kind,
    )?;
    session.catalog_source_verified = catalog_source_current;
    let stats = session.catalog.stats()?;
    let overview = session.catalog.cleanup_overview()?;
    let active_job = session
        .catalog
        .active_job()?
        .map(|(kind, job_id)| format!("{kind}:{job_id}"));
    let source_kind = match session.prepared.report.kind {
        SourceKind::Directory => "directory",
        SourceKind::Sqlite => "sqlite",
        SourceKind::ImazingArchive => "imazing_archive",
    };
    let unreferenced = overview
        .categories
        .iter()
        .find(|total| total.category == "unreferenced")
        .cloned()
        .unwrap_or_else(|| crate::model::CleanupCategoryTotal {
            category: "unreferenced".to_string(),
            file_count: 0,
            bytes: 0,
        });
    let unconfirmed = overview
        .categories
        .iter()
        .find(|total| total.category == "unconfirmed")
        .cloned()
        .unwrap_or_else(|| crate::model::CleanupCategoryTotal {
            category: "unconfirmed".to_string(),
            file_count: 0,
            bytes: 0,
        });
    let mut risks = Vec::new();
    let mut add_risk =
        |code: &str, severity: &str, title: &str, detail: String, file_count: u64, bytes: u64| {
            risks.push(CleanupRisk {
                code: code.to_string(),
                severity: severity.to_string(),
                title: title.to_string(),
                detail,
                file_count,
                bytes,
            });
        };

    if !source_read_only {
        add_risk(
            "source-writable",
            "blocker",
            "來源資料庫不是唯讀",
            "為避免清理流程改寫原始備份，請先關閉可能正在使用來源資料庫的程式。".to_string(),
            0,
            0,
        );
    }
    if !quick_check.eq_ignore_ascii_case("ok") {
        add_risk(
            "sqlite-check",
            "blocker",
            "SQLite 完整性檢查未通過",
            format!("quick_check 回報：{quick_check}。建立候選檔前請先保留來源並修復資料庫。"),
            0,
            0,
        );
    }
    if !catalog_source_current {
        add_risk(
            "catalog-stale",
            "blocker",
            "附件索引與目前來源不一致",
            "來源檔案可能在掃描後變更；請重新掃描附件，完成後再建立候選檔。".to_string(),
            0,
            0,
        );
    }
    if stats.scan_status != "complete" {
        add_risk(
            "scan-incomplete",
            "blocker",
            "附件掃描尚未完成",
            format!(
                "目前掃描狀態為 {}，尚未取得完整檔案清單。",
                stats.scan_status
            ),
            0,
            0,
        );
    }
    if overview.context_status != "complete" {
        add_risk(
            "context-incomplete",
            "blocker",
            "訊息與附件的交叉確認尚未完成",
            format!(
                "目前脈絡索引狀態為 {}；未完成前不會把不明檔案視為安全候選。",
                overview.context_status
            ),
            0,
            0,
        );
    }
    if session.prepared.report.wal_present || session.prepared.report.shm_present {
        add_risk(
            "sqlite-companion",
            "warning",
            "來源旁仍有 SQLite 暫存檔",
            "來源旁存在 -wal 或 -shm；請確認 LINE 與備份工具已停止寫入，再依目前快照清理。"
                .to_string(),
            0,
            0,
        );
    }
    if unreferenced.file_count > 0 {
        add_risk(
            "unreferenced-files",
            "warning",
            "有 SQLite 未引用附件",
            "這些檔案可能是索引遺漏，也可能是可清理殘留；只能列入人工複核，不會由安全自動規則處理。".to_string(),
            unreferenced.file_count,
            unreferenced.bytes,
        );
    }
    if unconfirmed.file_count > 0 {
        add_risk(
            "unconfirmed-files",
            "warning",
            "有無法確認來源的附件",
            "無法把這些檔案安全對應到訊息；建立候選檔前請逐項查看路徑與內容。".to_string(),
            unconfirmed.file_count,
            unconfirmed.bytes,
        );
    }
    if let Some(active_job) = active_job.as_deref() {
        add_risk(
            "active-job",
            "warning",
            "仍有原生工作正在執行",
            format!("目前工作：{active_job}。請等待完成後再建立候選檔。"),
            0,
            0,
        );
    }
    if overview.marked_count == 0 {
        add_risk(
            "nothing-marked",
            "info",
            "目前沒有已標記的清理項目",
            "可以先查看清理方案預演，或從聊天室逐項選取附件。".to_string(),
            0,
            0,
        );
    }

    let blocker_count = risks
        .iter()
        .filter(|risk| risk.severity == "blocker")
        .count() as u64;
    let warning_count = risks
        .iter()
        .filter(|risk| risk.severity == "warning")
        .count() as u64;
    Ok(CleanupPreflightReport {
        source_kind: source_kind.to_string(),
        source_read_only,
        sqlite_quick_check: quick_check,
        catalog_source_current,
        scan_status: stats.scan_status,
        context_status: overview.context_status,
        active_job,
        risk_count: risks.len() as u64,
        blocker_count,
        warning_count,
        safe_candidate_count: overview.automatic_candidate_count,
        safe_candidate_bytes: overview.automatic_candidate_bytes,
        marked_count: overview.marked_count,
        marked_bytes: overview.marked_bytes,
        risks,
    })
}

fn sibling_entry_name(database_name: &str, filename: &str) -> String {
    database_name
        .rsplit_once('/')
        .map(|(parent, _)| format!("{parent}/{filename}"))
        .unwrap_or_else(|| filename.to_string())
}

fn list_empty_attachment_chats(
    session: &NativeSession,
    params: &CleanupPageParams,
) -> Result<CleanupGroupPage> {
    let mut chats = session.database.all_chats_for_cleanup()?;
    session.database.enrich_chat_titles(
        &mut chats,
        session.unified_group_database.as_ref(),
        session.square_database.as_ref(),
    )?;
    if let Some(square_database) = session.square_database.as_ref() {
        chats.extend(square_database.all_chats_for_cleanup()?);
    }
    session.catalog.list_empty_attachment_chats(
        chats,
        params.page,
        params.page_size,
        params.search.as_deref(),
        &params.kind,
        &params.sort,
    )
}

fn parse_params<T: for<'de> Deserialize<'de>>(request: &Request) -> Result<T> {
    serde_json::from_value(request.params.clone())
        .with_context(|| format!("invalid params for {}", request.method))
}

fn default_chat_limit() -> u32 {
    100
}

fn default_message_source() -> String {
    "line".to_string()
}

fn default_message_limit() -> u32 {
    DEFAULT_PAGE_SIZE
}

fn default_cleanup_audit_limit() -> u32 {
    20
}

fn default_attachment_limit() -> u32 {
    100
}

fn default_cleanup_page() -> u32 {
    1
}

fn default_cleanup_page_size() -> u32 {
    24
}

fn default_cleanup_kind() -> String {
    "all".to_string()
}

fn default_cleanup_category() -> String {
    "all".to_string()
}

fn default_cleanup_sort() -> String {
    "size".to_string()
}

fn write_error<W: Write>(
    output: &mut W,
    id: &str,
    job_id: Option<&str>,
    code: &'static str,
    message: &str,
) -> Result<()> {
    write_json_line(
        output,
        &Response {
            id,
            job_id,
            ok: false,
            result: None,
            error: Some(ErrorBody {
                code,
                message: message.to_string(),
            }),
        },
    )
}

fn write_json_line<W: Write>(output: &mut W, value: &impl Serialize) -> Result<()> {
    serde_json::to_writer(&mut *output, value)?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}

fn read_bounded_line<R: BufRead>(
    input: &mut R,
    line: &mut Vec<u8>,
    maximum: usize,
) -> std::io::Result<ReadLine> {
    line.clear();
    let mut too_large = false;
    loop {
        let available = input.fill_buf()?;
        if available.is_empty() {
            return if line.is_empty() && !too_large {
                Ok(ReadLine::Eof)
            } else if too_large {
                Ok(ReadLine::TooLarge)
            } else {
                Ok(ReadLine::Line)
            };
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(available.len(), |index| index + 1);
        if !too_large {
            if line.len().saturating_add(take) > maximum {
                too_large = true;
                line.clear();
            } else {
                line.extend_from_slice(&available[..take]);
            }
        }
        input.consume(take);
        if newline.is_some() {
            if line.last() == Some(&b'\n') {
                line.pop();
            }
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return if too_large {
                Ok(ReadLine::TooLarge)
            } else {
                Ok(ReadLine::Line)
            };
        }
    }
}
