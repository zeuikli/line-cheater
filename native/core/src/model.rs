use serde::{Deserialize, Serialize};

pub const DEFAULT_PAGE_SIZE: u32 = 180;
pub const MAX_PAGE_SIZE: u32 = 1_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatCursor {
    pub last_updated: i64,
    #[serde(default = "default_chat_source")]
    pub source: String,
    pub pk: i64,
}

fn default_chat_source() -> String {
    "line".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Chat {
    pub pk: i64,
    pub source: String,
    pub id: String,
    pub chat_type: i64,
    pub kind: String,
    pub title: String,
    pub title_source: String,
    pub message_count: i64,
    pub human_message_count: i64,
    pub last_updated: i64,
    pub last_message: String,
    pub planned_for_removal: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatPage {
    pub items: Vec<Chat>,
    pub next_cursor: Option<ChatCursor>,
    #[serde(default)]
    pub has_previous: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MessageCursor {
    pub timestamp: i64,
    pub pk: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub pk: i64,
    pub source: String,
    pub id: String,
    pub chat_pk: i64,
    pub timestamp: i64,
    pub sender_pk: Option<i64>,
    pub sender_name: String,
    pub is_self: bool,
    pub send_status: Option<i64>,
    pub content_type: Option<i64>,
    pub message_type: String,
    pub text: String,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub attachments: Vec<MessageAttachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MessageAttachment {
    pub path: String,
    pub bytes: u64,
    pub kind: AttachmentKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MessagePage {
    pub items: Vec<Message>,
    pub next_cursor: Option<MessageCursor>,
    #[serde(default)]
    pub has_previous: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentKind {
    Original,
    Thumbnail,
}

impl AttachmentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Original => "original",
            Self::Thumbnail => "thumbnail",
        }
    }
}

impl std::str::FromStr for AttachmentKind {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "original" => Ok(Self::Original),
            "thumbnail" => Ok(Self::Thumbnail),
            _ => anyhow::bail!("attachment kind must be `original` or `thumbnail`"),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentCursor {
    pub id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentContext {
    pub source: String,
    pub message_pk: i64,
    pub chat_pk: i64,
    pub chat_id: String,
    pub chat_title: String,
    pub chat_kind: String,
    pub timestamp: i64,
    pub sender_pk: Option<i64>,
    pub sender_name: String,
    pub content_type: Option<i64>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentItem {
    pub id: i64,
    pub path: String,
    pub bytes: u64,
    pub modified_ns: i64,
    pub kind: AttachmentKind,
    pub message_id: String,
    pub chat_hint: String,
    pub marked_for_removal: bool,
    pub removal_reason: String,
    pub reference_status: String,
    pub context: Option<AttachmentContext>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentPage {
    pub items: Vec<AttachmentItem>,
    pub next_cursor: Option<AttachmentCursor>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentPreview {
    pub staged_path: String,
    pub media_type: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub processed_files: u64,
    pub total_files: u64,
    pub processed_bytes: u64,
    pub total_bytes: u64,
    pub skipped_files: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub output_name: String,
    pub exported_files: u64,
    pub exported_bytes: u64,
    pub skipped_files: u64,
    pub skipped_bytes: u64,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationExportProgress {
    pub processed_messages: u64,
    pub total_messages: u64,
    pub processed_attachments: u64,
    pub total_attachments: u64,
    pub processed_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationExportReport {
    pub output_name: String,
    pub messages: u64,
    pub attachments: u64,
    pub attachment_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogStats {
    pub source_path: String,
    pub scan_status: String,
    pub file_count: u64,
    pub total_bytes: u64,
    pub attachment_count: u64,
    pub attachment_bytes: u64,
    pub marked_count: u64,
    pub marked_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroupCursor {
    pub reclaimable_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroup {
    pub sha256: String,
    pub bytes: u64,
    pub file_count: u64,
    pub reclaimable_bytes: u64,
    pub has_original: bool,
    pub has_thumbnail: bool,
    pub preview_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroupPage {
    pub items: Vec<DuplicateGroup>,
    pub next_cursor: Option<DuplicateGroupCursor>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateMemberPage {
    pub items: Vec<AttachmentItem>,
    pub next_cursor: Option<AttachmentCursor>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateHashProgress {
    pub candidate_files: u64,
    pub processed_files: u64,
    pub total_bytes: u64,
    pub processed_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CleanupCategoryTotal {
    pub category: String,
    pub file_count: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CleanupCategoryActionState {
    pub category: String,
    pub attachment_count: u64,
    pub marked_attachment_count: u64,
    pub thumbnail_candidate_count: u64,
    pub chat_count: u64,
    pub planned_chat_count: u64,
    pub keeping_all_thumbnails: bool,
    pub deleting_all_attachments: bool,
    pub deleting_all_chats: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CleanupOverview {
    pub categories: Vec<CleanupCategoryTotal>,
    pub marked_count: u64,
    pub marked_bytes: u64,
    pub manual_marked_count: u64,
    pub manual_marked_bytes: u64,
    pub automatic_candidate_count: u64,
    pub automatic_candidate_bytes: u64,
    pub automatic_marked_count: u64,
    pub automatic_marked_bytes: u64,
    pub context_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CleanupRisk {
    pub code: String,
    pub severity: String,
    pub title: String,
    pub detail: String,
    pub file_count: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CleanupPreflightReport {
    pub source_kind: String,
    pub source_read_only: bool,
    pub sqlite_quick_check: String,
    pub catalog_source_current: bool,
    pub scan_status: String,
    pub context_status: String,
    pub active_job: Option<String>,
    pub risk_count: u64,
    pub blocker_count: u64,
    pub warning_count: u64,
    pub safe_candidate_count: u64,
    pub safe_candidate_bytes: u64,
    pub marked_count: u64,
    pub marked_bytes: u64,
    pub risks: Vec<CleanupRisk>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CleanupPlanPreview {
    pub profile: String,
    pub title: String,
    pub description: String,
    pub automatic_file_count: u64,
    pub automatic_bytes: u64,
    pub review_file_count: u64,
    pub review_bytes: u64,
    pub planned_chat_count: u64,
    pub planned_message_count: u64,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CleanupActivity {
    pub id: u64,
    pub action: String,
    pub scope: String,
    pub detail: String,
    pub file_count: u64,
    pub bytes: u64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CleanupPlanSnapshot {
    pub source_path: String,
    pub source_fingerprint: Option<String>,
    pub plan_fingerprint: String,
    pub generated_at: i64,
    pub marked_count: u64,
    pub marked_bytes: u64,
    pub manual_marked_count: u64,
    pub manual_marked_bytes: u64,
    pub automatic_marked_count: u64,
    pub automatic_marked_bytes: u64,
    pub chat_marked_count: u64,
    pub chat_marked_bytes: u64,
    pub planned_chat_count: u64,
    pub planned_message_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CleanupAuditReport {
    pub plan: CleanupPlanSnapshot,
    pub events: Vec<CleanupActivity>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CleanupGroup {
    pub key: String,
    pub chat_source: String,
    pub chat_pk: Option<i64>,
    pub chat_id: String,
    pub chat_title: String,
    pub chat_kind: String,
    pub reference_status: String,
    pub file_count: u64,
    pub total_bytes: u64,
    pub marked_count: u64,
    pub has_original: bool,
    pub has_thumbnail: bool,
    pub thumbnail_backed_image_count: u64,
    pub keeping_thumbnails: bool,
    pub latest_timestamp: i64,
    pub planned_for_chat_removal: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CleanupGroupPage {
    pub items: Vec<CleanupGroup>,
    pub page: u32,
    pub page_size: u32,
    pub total_items: u64,
    pub total_pages: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CleanupReview {
    pub key: String,
    pub message_id: String,
    pub reference_status: String,
    pub context: Option<AttachmentContext>,
    pub files: Vec<AttachmentItem>,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CleanupReviewPage {
    pub group: CleanupGroup,
    pub items: Vec<CleanupReview>,
    pub page: u32,
    pub page_size: u32,
    pub total_items: u64,
    pub total_pages: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AdvancedCleanupReport {
    pub line_empty_chats: u64,
    pub line_system_only_chats: u64,
    pub square_available: bool,
    pub square_empty_chats: u64,
    pub square_system_only_chats: u64,
    pub orphan_community_messages: u64,
    pub automatic_cleanup_planned: bool,
    pub planned_chats: u64,
    pub planned_database_messages: u64,
    pub planned_files: u64,
    pub planned_bytes: u64,
}

pub fn checked_page_size(limit: u32) -> anyhow::Result<usize> {
    if limit == 0 || limit > MAX_PAGE_SIZE {
        anyhow::bail!("page size must be between 1 and {MAX_PAGE_SIZE}");
    }
    Ok(limit as usize)
}
