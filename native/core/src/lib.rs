pub mod candidate;
pub mod catalog;
mod conversation;
pub mod database;
pub mod model;
pub mod performance;
pub mod server;
pub mod source;

pub use candidate::{
    CandidateOptions, CandidateProgress, CandidateReport, build_candidate,
    build_candidate_with_options, line_square_rebuild_required,
};
pub use catalog::{
    BulkChatMutationProgress, Catalog, CatalogContextProgress, CatalogScanProgress,
    CleanupMutationProgress, ExportOptions, ExportScope,
};
pub use database::{LineDatabase, LineSquareDatabase, UnifiedGroupDatabase};
pub use model::{
    AdvancedCleanupReport, AttachmentContext, AttachmentCursor, AttachmentItem, AttachmentKind,
    AttachmentPage, AttachmentPreview, CatalogStats, Chat, ChatCursor, ChatPage, CleanupActivity,
    CleanupAuditReport, CleanupCategoryActionState, CleanupCategoryTotal, CleanupGroup,
    CleanupGroupPage, CleanupOverview, CleanupPlanPreview, CleanupPlanSnapshot,
    CleanupPreflightReport, CleanupReview, CleanupReviewPage, CleanupRisk,
    ConversationExportProgress, ConversationExportReport, DuplicateGroup, DuplicateGroupCursor,
    DuplicateGroupPage, DuplicateHashProgress, DuplicateMemberPage, ExportProgress, ExportReport,
    Message, MessageAttachment, MessageCursor, MessagePage,
};
pub use performance::{PerformanceProfile, system_performance_profile};
pub use server::{NativeSession, serve};
pub use source::{
    PreparePhase, PrepareProgress, PreparedSource, SourceKind, SourceReport, inspect_source,
    prepare_source, prepare_source_reporting,
};
