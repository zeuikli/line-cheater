"use strict";

const bridge = window.lineNativeBridge;
const NativeDataProvider = window.LineNativeDataProvider;
let provider = null;
let chatCursor = null;
let chatBeforeCursor = null;
let chatPageNumber = 1;
let chatLoading = false;
let chatRequestGeneration = 0;
let chatRetryDirection = "initial";
let chatSearchQuery = "";
let allChatsCache = null;
let allChatsCacheGeneration = -1;
let allChatsLoading = false;
let chatSearchGeneration = 0;
let chatSearchDebounce = null;
let attachmentsLoaded = false;
let attachmentsLoading = false;
let allAttachments = [];
let attachmentsGeneration = -1;
let attachmentFiltered = [];
let attachmentPage = 1;
let attachmentSearchDebounce = null;
const ATTACHMENT_PAGE_SIZE = 200;
const attachmentFilter = {
  search: "",
  chatMode: "include",
  chats: new Set(),
  typeMode: "include",
  types: new Set(),
  includeThumbnails: false,
  sort: "size-desc"
};
const ATTACHMENT_CATEGORY_LABELS = {
  image: "照片",
  video: "影片",
  voice: "語音",
  file: "檔案",
  sticker: "貼圖",
  location: "位置",
  link: "連結",
  other: "其他"
};
const ATTACHMENT_CATEGORY_ORDER = [
  "image", "video", "voice", "file", "sticker", "location", "link", "other"
];
let messageCursor = null;
let messageBeforeCursor = null;
let messagePageNumber = 1;
let messageLoading = false;
let messageRequestGeneration = 0;
let messageRetryDirection = "initial";
let selectedChatPk = null;
let selectedChat = null;
let selectedChatGeneration = 0;
let activeSearch = null;
let activeSourceBytes = 0;
let activeWorkspaceView = "browse";
let selectedSourceKind = null;
let sourceGeneration = 0;
let savedSessionLoading = false;
let sessionDeletionInProgress = false;
let messageRenderGeneration = 0;
let packageInProgress = false;
let cleanupMutationInProgress = false;
let exportInProgress = false;
let cancelInProgress = false;
let restoreChecklistResolve = null;
let duplicateLoading = false;
let duplicateScanComplete = false;
let duplicatePage = null;
let duplicatePageNumber = 1;
let duplicatePageCursors = [null];
let duplicateExpandedSha = null;
let duplicateHashResult = null;
let duplicatePreviewGeneration = 0;
let duplicateAutoMergeEnabled = false;
const duplicateMembers = new Map();
let imageModalTrigger = null;
let confirmationModalTrigger = null;
let confirmationModalResolver = null;
let operationModalTrigger = null;
let cleanupPage = null;
let cleanupOverview = null;
let cleanupCategoryActionState = null;
let cleanupPlanNotice = "";
let cleanupPreflight = null;
let cleanupPlanPreviews = null;
let cleanupPreflightLoading = false;
let cleanupPageMode = "plan";
let cleanupLoading = false;
let cleanupReloadPending = false;
let cleanupSearchTimer = null;
let cleanupResizeTimer = null;
let cleanupRenderGeneration = 0;
let cleanupAlbumSession = null;
let advancedMode = false;
let advancedReport = null;
let advancedLoading = false;
const CLEANUP_ALBUM_PAGE_SIZE = 24;
const CLEANUP_ALBUM_MAX_PAGES = 3;
const cleanupState = {
  page: 1,
  search: "",
  kind: "all",
  category: "all",
  sort: "size",
  groupKey: null,
  planProfile: null,
  manualMode: false
};

const elements = {
  appShell: document.querySelector("#app-shell"),
  welcomeScreen: document.querySelector("#welcome-screen"),
  workspaceScreen: document.querySelector("#workspace-screen"),
  enterWorkspace: document.querySelector("#enter-workspace"),
  changeSource: document.querySelector("#change-source"),
  refreshSessions: document.querySelector("#refresh-sessions"),
  savedSessionList: document.querySelector("#saved-session-list"),
  sourceReadyCard: document.querySelector("#source-ready-card"),
  selectedSourceName: document.querySelector("#selected-source-name"),
  selectedSourceDetail: document.querySelector("#selected-source-detail"),
  sidebarSourceName: document.querySelector("#sidebar-source-name"),
  sidebarSourceDetail: document.querySelector("#sidebar-source-detail"),
  workspaceTitle: document.querySelector("#workspace-title"),
  workspaceSubtitle: document.querySelector("#workspace-subtitle"),
  workspaceStatus: document.querySelector("#workspace-status"),
  browseView: document.querySelector("#browse-view"),
  cleanupView: document.querySelector("#cleanup-view"),
  cleanupPlanPage: document.querySelector("#cleanup-plan-page"),
  cleanupDetailPage: document.querySelector("#cleanup-detail-page"),
  duplicatesView: document.querySelector("#duplicates-view"),
  advancedView: document.querySelector("#advanced-view"),
  attachmentsView: document.querySelector("#attachments-view"),
  attachmentSort: document.querySelector("#attachment-sort"),
  attachmentChat: document.querySelector("#attachment-chat"),
  attachmentChatClear: document.querySelector("#attachment-chat-clear"),
  attachmentChatMode: document.querySelector("#attachment-chat-mode"),
  attachmentTypeMode: document.querySelector("#attachment-type-mode"),
  attachmentIncludeThumbnails: document.querySelector("#attachment-include-thumbnails"),
  attachmentSearch: document.querySelector("#attachment-search"),
  attachmentTypeChips: document.querySelector("#attachment-type-chips"),
  attachmentSummary: document.querySelector("#attachment-summary"),
  exportFilteredAttachments: document.querySelector("#export-filtered-attachments"),
  attachmentList: document.querySelector("#attachment-list"),
  attachmentPageInfo: document.querySelector("#attachment-page-info"),
  attachmentPrevious: document.querySelector("#attachment-previous"),
  attachmentNext: document.querySelector("#attachment-next"),
  advancedMode: document.querySelector("#advanced-mode"),
  advancedModeState: document.querySelector("#advanced-mode-state"),
  advancedLocked: document.querySelector("#advanced-locked"),
  advancedContent: document.querySelector("#advanced-content"),
  advancedLineEmpty: document.querySelector("#advanced-line-empty"),
  advancedLineSystem: document.querySelector("#advanced-line-system"),
  advancedSquareEmpty: document.querySelector("#advanced-square-empty"),
  advancedSquareSystem: document.querySelector("#advanced-square-system"),
  advancedOrphanMessages: document.querySelector("#advanced-orphan-messages"),
  advancedPlannedChats: document.querySelector("#advanced-planned-chats"),
  advancedPlannedMessages: document.querySelector("#advanced-planned-messages"),
  advancedPlannedFiles: document.querySelector("#advanced-planned-files"),
  advancedPlannedBytes: document.querySelector("#advanced-planned-bytes"),
  refreshAdvancedReport: document.querySelector("#refresh-advanced-report"),
  planAutomaticCleanup: document.querySelector("#plan-automatic-cleanup"),
  status: document.querySelector("#status"),
  sessionSummary: document.querySelector("#session-summary"),
  chats: document.querySelector("#chats"),
  chatSearch: document.querySelector("#chat-search"),
  chatPagination: document.querySelector(".chat-pagination"),
  chatListStatus: document.querySelector("#chat-list-status"),
  retryChats: document.querySelector("#retry-chats"),
  messages: document.querySelector("#messages"),
  selectedChatTitle: document.querySelector("#selected-chat-title"),
  selectedChatMeta: document.querySelector("#selected-chat-meta"),
  exportChatConversation: document.querySelector("#export-chat-conversation"),
  exportChatImages: document.querySelector("#export-chat-images"),
  exportChatAttachments: document.querySelector("#export-chat-attachments"),
  messageStatus: document.querySelector("#message-status"),
  chatPageInfo: document.querySelector("#chat-page-info"),
  previousChats: document.querySelector("#previous-chats"),
  nextChats: document.querySelector("#next-chats"),
  previousMessages: document.querySelector("#previous-messages"),
  nextMessages: document.querySelector("#next-messages"),
  scanCatalog: document.querySelector("#scan-catalog"),
  buildCandidate: document.querySelector("#build-candidate"),
  advancedBuildCandidate: document.querySelector("#advanced-build-candidate"),
  searchForm: document.querySelector("#search-form"),
  searchQuery: document.querySelector("#search-query"),
  searchButton: document.querySelector("#search-form button"),
  clearSearch: document.querySelector("#clear-search"),
  retryMessages: document.querySelector("#retry-messages"),
  progress: document.querySelector("#progress"),
  catalogSummary: document.querySelector("#catalog-summary"),
  cleanupSearch: document.querySelector("#cleanup-search"),
  cleanupKind: document.querySelector("#cleanup-kind"),
  cleanupCategory: document.querySelector("#cleanup-category"),
  cleanupNoAttachments: document.querySelector("#cleanup-no-attachments"),
  cleanupSort: document.querySelector("#cleanup-sort"),
  markedCount: document.querySelector("#marked-count"),
  markedSize: document.querySelector("#marked-size"),
  cleanupAutomationSummary: document.querySelector("#cleanup-automation-summary"),
  cleanupPreflight: document.querySelector("#cleanup-preflight"),
  cleanupPreflightTitle: document.querySelector("#cleanup-preflight-title"),
  cleanupPreflightSummary: document.querySelector("#cleanup-preflight-summary"),
  cleanupPreflightRisks: document.querySelector("#cleanup-preflight-risks"),
  refreshCleanupPreflight: document.querySelector("#refresh-cleanup-preflight"),
  cleanupPlanPreviews: document.querySelector("#cleanup-plan-previews"),
  cleanupPlanPreviewsSummary: document.querySelector("#cleanup-plan-previews-summary"),
  cleanupPlanCards: document.querySelector("#cleanup-plan-cards"),
  enterManualCleanup: document.querySelector("#enter-manual-cleanup"),
  cleanupCurrentPlan: document.querySelector("#cleanup-current-plan"),
  changeCleanupPlan: document.querySelector("#change-cleanup-plan"),
  planSafeAttachmentCleanup: document.querySelector("#plan-safe-attachment-cleanup"),
  clearManualAttachmentPlan: document.querySelector("#clear-manual-attachment-plan"),
  categorySummary: document.querySelector("#category-summary"),
  categoryBulkActions: document.querySelector("#category-bulk-actions"),
  categoryBulkTitle: document.querySelector("#category-bulk-title"),
  categoryBulkDescription: document.querySelector("#category-bulk-description"),
  categoryKeepThumbnails: document.querySelector("#category-keep-thumbnails"),
  categoryDeleteAttachments: document.querySelector("#category-delete-attachments"),
  categoryDeleteChats: document.querySelector("#category-delete-chats"),
  cleanupResultInfo: document.querySelector("#cleanup-result-info"),
  cleanupList: document.querySelector("#cleanup-list"),
  cleanupPrev: document.querySelector("#cleanup-prev"),
  cleanupNext: document.querySelector("#cleanup-next"),
  cleanupPageInput: document.querySelector("#cleanup-page-input"),
  cleanupPageTotal: document.querySelector("#cleanup-page-total"),
  cleanupPageInfo: document.querySelector("#cleanup-page-info"),
  hashDuplicates: document.querySelector("#hash-duplicates"),
  cancelDuplicateScan: document.querySelector("#cancel-duplicate-scan"),
  duplicateProgressLabel: document.querySelector("#duplicate-progress-label"),
  duplicateSummary: document.querySelector("#duplicate-summary"),
  duplicateGroups: document.querySelector("#duplicate-groups"),
  duplicatePrev: document.querySelector("#duplicate-prev"),
  duplicateNext: document.querySelector("#duplicate-next"),
  duplicatePageInfo: document.querySelector("#duplicate-page-info"),
  duplicateAutoMerge: document.querySelector("#duplicate-auto-merge"),
  loadModal: document.querySelector("#load-modal"),
  loadModalCard: document.querySelector("#load-modal .package-modal-card"),
  loadModalMessage: document.querySelector("#load-modal-message"),
  loadModalProgress: document.querySelector("#load-modal-progress"),
  loadModalProgressLabel: document.querySelector("#load-modal-progress-label"),
  loadModalCancel: document.querySelector("#load-modal-cancel"),
  packageModal: document.querySelector("#package-modal"),
  packageModalCard: document.querySelector("#package-modal .package-modal-card"),
  packageModalTitle: document.querySelector("#package-modal-title"),
  packageModalMessage: document.querySelector("#package-modal-message"),
  packageModalReport: document.querySelector("#package-modal-report"),
  packageModalProgress: document.querySelector("#package-modal-progress"),
  packageModalProgressLabel: document.querySelector("#package-modal-progress-label"),
  packageModalCancel: document.querySelector("#package-modal-cancel"),
  packageModalDonatePrompt: document.querySelector("#package-modal-donate-prompt"),
  packageModalActions: document.querySelector("#package-modal-actions"),
  packageModalDonate: document.querySelector("#package-modal-donate"),
  packageModalClose: document.querySelector("#package-modal-close"),
  operationModal: document.querySelector("#operation-modal"),
  operationModalCard: document.querySelector("#operation-modal .package-modal-card"),
  operationModalTitle: document.querySelector("#operation-modal-title"),
  operationModalMessage: document.querySelector("#operation-modal-message"),
  operationModalProgress: document.querySelector("#operation-modal-progress"),
  operationModalProgressLabel: document.querySelector("#operation-modal-progress-label"),
  operationModalCancel: document.querySelector("#operation-modal-cancel"),
  operationModalClose: document.querySelector("#operation-modal-close"),
  restoreChecklistModal: document.querySelector("#restore-checklist-modal"),
  restoreChecklistCard: document.querySelector("#restore-checklist-modal .restore-checklist-card"),
  restoreCheckOriginal: document.querySelector("#restore-check-original"),
  restoreCheckTest: document.querySelector("#restore-check-test"),
  restoreCheckVerify: document.querySelector("#restore-check-verify"),
  restoreCheckCancel: document.querySelector("#restore-check-cancel"),
  restoreCheckConfirm: document.querySelector("#restore-check-confirm"),
  imageModal: document.querySelector("#image-modal"),
  imageModalCard: document.querySelector("#image-modal .image-modal-card"),
  imageModalImage: document.querySelector("#image-modal-image"),
  imageModalCaption: document.querySelector("#image-modal-caption"),
  imageModalClose: document.querySelector("#image-modal-close"),
  confirmationModal: document.querySelector("#confirmation-modal"),
  confirmationModalTitle: document.querySelector("#confirmation-modal-title"),
  confirmationModalMessage: document.querySelector("#confirmation-modal-message"),
  confirmationModalCancel: document.querySelector("#confirmation-modal-cancel"),
  confirmationModalConfirm: document.querySelector("#confirmation-modal-confirm")
};

const categoryLabels = {
  all: "全部檔案",
  individual: "個人聊天室",
  group: "群組聊天室",
  community: "社群",
  unreferenced: "SQLite 未引用",
  unconfirmed: "無法確認",
  no_attachments: "沒有附件的對話"
};

function categoryActionLabel(category) {
  return category === "all" ? "全部分類" : categoryLabels[category] || category;
}

const cleanupPlanProfiles = {
  conservative: {
    label: "保守方案",
    category: "all",
    selectionSummary: "顯示全部分類；下方按鈕可套用已確認的安全自動標記。"
  },
  balanced: {
    label: "平衡方案",
    category: "all",
    selectionSummary: "顯示全部分類；可從分類卡聚焦 SQLite 未引用附件，請逐一人工確認。"
  },
  aggressive: {
    label: "積極方案",
    category: "all",
    selectionSummary: "顯示全部分類；可依序聚焦 SQLite 未引用與無法確認附件，請先檢查來源內容。"
  }
};

function setStatus(message, error) {
  const text = String(message == null ? "" : message)
    .replace(/Error invoking remote method '[^']*':\s*(?:Error:\s*)?/g, "");
  for (const status of [elements.status, elements.workspaceStatus].filter(Boolean)) {
    status.textContent = text;
    status.classList.toggle("error", Boolean(error));
  }
  if (!elements.loadModal.classList.contains("hidden")) {
    elements.loadModalMessage.textContent = text;
  }
}

function sourceKindLabel(kind) {
  return {
    directory: "備份資料夾",
    imazing_archive: ".imazingapp",
    sqlite: "Line.sqlite"
  }[kind] || "LINE 備份";
}

function sourceDisplayName(path, kind) {
  const parts = String(path || "").split(/[\\/]/).filter(Boolean);
  return parts.pop() || sourceKindLabel(kind);
}

function sourceSelectionKind(kind) {
  return {
    directory: "directory",
    imazing_archive: "archive",
    sqlite: "sqlite"
  }[kind] || kind;
}

function sessionDate(seconds) {
  const value = Number(seconds) * 1000;
  if (!Number.isFinite(value) || value <= 0) return "時間未知";
  return new Intl.DateTimeFormat("zh-TW", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function renderSavedSessions(sessions) {
  elements.savedSessionList.replaceChildren();
  if (!sessions.length) {
    const empty = document.createElement("p");
    empty.className = "saved-session-empty";
    empty.textContent = "找不到可辨識的分析工作階段。選擇備份並完成掃描後會顯示在這裡。";
    elements.savedSessionList.append(empty);
    return;
  }
  for (const session of sessions) {
    const item = document.createElement("article");
    item.className = `saved-session-item${session.reusable ? "" : " is-unavailable"}`;
    const main = document.createElement("div");
    main.className = "saved-session-main";
    const heading = document.createElement("div");
    heading.className = "saved-session-heading";
    const name = document.createElement("strong");
    name.textContent = session.sourceName || sourceDisplayName(session.sourcePath, session.sourceKind);
    const state = document.createElement("span");
    state.className = "saved-session-state";
    state.textContent = session.reusable ? "可直接載入" : "無法直接載入";
    heading.append(name, state);
    const sourcePath = document.createElement("span");
    sourcePath.className = "saved-session-path";
    sourcePath.textContent = `備份：${session.sourcePath}`;
    sourcePath.title = session.sourcePath;
    const sessionPath = document.createElement("span");
    sessionPath.className = "saved-session-path saved-session-cache-path";
    sessionPath.textContent = `工作階段：${session.sessionPath}`;
    sessionPath.title = session.sessionPath;
    const meta = document.createElement("span");
    meta.className = "saved-session-meta";
    meta.textContent = session.reusable
      ? `${sourceKindLabel(session.sourceKind === "archive" ? "imazing_archive" : session.sourceKind)} · ` +
        `${Number(session.attachmentCount).toLocaleString()} 個附件 · ` +
        `${sessionDate(session.scanCompletedAt)} · 工作階段 ${session.cacheVersion}`
      : `${session.unavailableReason || "工作階段不完整"} · 工作階段 ${session.cacheVersion || "版本未知"}`;
    main.append(heading, sourcePath, sessionPath, meta);
    const actions = document.createElement("div");
    actions.className = "saved-session-actions";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "secondary-button compact-button saved-session-open";
    open.dataset.sessionOpen = session.id;
    open.dataset.sessionKind = session.sourceKind;
    open.disabled = !session.reusable;
    open.title = session.reusable
      ? `載入 ${session.sourcePath}`
      : session.unavailableReason || "工作階段無法直接載入";
    open.textContent = "載入工作階段";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger-button compact-button saved-session-delete";
    remove.dataset.sessionDelete = session.id;
    remove.dataset.sessionName = session.sourceName || sourceDisplayName(
      session.sourcePath,
      session.sourceKind
    );
    remove.dataset.sessionPath = session.sessionPath;
    remove.title = "只刪除 LINE Cheater 的分析工作階段，不會刪除 .imazingapp";
    remove.textContent = "刪除工作階段";
    actions.append(open, remove);
    item.append(main, actions);
    elements.savedSessionList.append(item);
  }
}

async function loadSavedSessions() {
  if (savedSessionLoading || sessionDeletionInProgress) return;
  savedSessionLoading = true;
  elements.refreshSessions.disabled = true;
  try {
    const sessions = await bridge.listSessions();
    renderSavedSessions(Array.isArray(sessions) ? sessions : []);
  } catch (error) {
    const message = document.createElement("p");
    message.className = "saved-session-empty error";
    message.textContent = `無法讀取工作階段：${error.message}`;
    elements.savedSessionList.replaceChildren(message);
  } finally {
    savedSessionLoading = false;
    elements.refreshSessions.disabled = false;
  }
}

async function deleteSavedSession(button) {
  if (sessionDeletionInProgress || savedSessionLoading || button.disabled) return;
  const sessionName = button.dataset.sessionName || "這個備份";
  const sessionPath = button.dataset.sessionPath || "指定的工作階段";
  if (!await requestConfirmation({
    title: `刪除「${sessionName}」的分析工作階段？`,
    message:
      `即將刪除 LINE Cheater 的分析快取：\n${sessionPath}\n\n` +
      "原始 LINE.imazingapp、已生成的瘦身 .imazingapp 及其中的聊天資料都不會被刪除。" +
      "未來若再次開啟原始備份，將需要重新掃描及分析。",
    cancelLabel: "保留工作階段",
    confirmLabel: "刪除工作階段",
    danger: true
  })) return;

  sessionDeletionInProgress = true;
  elements.savedSessionList.setAttribute("aria-busy", "true");
  for (const action of elements.savedSessionList.querySelectorAll("button")) {
    action.disabled = true;
  }
  showOperationModal("正在刪除工作階段", `正在清理 ${sessionPath}，請勿重複操作。`);
  elements.operationModalCancel.classList.add("hidden");
  await waitForUiPaint();
  try {
    const result = await bridge.deleteSession(button.dataset.sessionDelete);
    if (result?.activeSessionClosed) resetAfterCandidateBuild();
    if (!result?.deleted) {
      throw new Error(result?.warning || "工作階段未能完全刪除，請重新啟動後再試。");
    }
    updateOperationModalProgress(1, 1, "完成");
    completeOperationModal(false, "分析工作階段已刪除；原始與瘦身 .imazingapp 均未修改。");
    await new Promise((resolve) => window.setTimeout(resolve, 180));
    sessionDeletionInProgress = false;
    closeOperationModal();
    setStatus(`已刪除「${sessionName}」的分析工作階段；備份 APP 未修改。`);
    await loadSavedSessions();
  } catch (error) {
    sessionDeletionInProgress = false;
    completeOperationModal(true, error.message);
    setStatus(`刪除工作階段失敗：${error.message}`, true);
    await loadSavedSessions();
  } finally {
    sessionDeletionInProgress = false;
    elements.savedSessionList.removeAttribute("aria-busy");
  }
}

function renderSessionSummary(info) {
  elements.sessionSummary.replaceChildren();
  const performance = info.performance || {};
  const performanceSummary = Number(performance.logicalCpus) > 0
    ? `${Number(performance.logicalCpus).toLocaleString()} 核心 · ` +
      `${formatBytes(performance.physicalMemoryBytes)} RAM · ` +
      `${Number(performance.archiveWorkers || 1).toLocaleString()} 個封存／` +
      `${Number(performance.sqliteWorkers || 1).toLocaleString()} 個 SQLite worker`
    : "自動";
  for (const [label, value] of [
    ["類型", sourceKindLabel(info.source.kind)],
    ["來源路徑", info.source.sourcePath],
    ["SQLite 檢查", info.quickCheck],
    ["來源唯讀", info.readOnly ? "是" : "否"],
    ["群組名稱資料", info.unifiedGroupLoaded ? "已載入" : "未提供"],
    ["社群名稱資料", info.lineSquareLoaded ? "已載入" : "未提供"],
    ["效能設定", performanceSummary],
    ["附件索引來源", info.catalogSourceCurrent ? "metadata 未變更" : "需要重新掃描"],
    ["附件索引", info.catalog.scanStatus === "complete" ? "已完成" : info.catalog.scanStatus]
  ]) {
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = String(value);
    elements.sessionSummary.append(term, description);
  }
  elements.sessionSummary.classList.remove("hidden");
}

function setWorkspaceView(view) {
  if (!["browse", "attachments", "cleanup", "duplicates", "advanced"].includes(view)) return;
  if (view === "duplicates" && !advancedMode) return;
  activeWorkspaceView = view;
  const labels = {
    browse: ["瀏覽", "查看聊天室與訊息內容"],
    attachments: ["附件", "依大小、類型與聊天室篩選並匯出"],
    cleanup: ["清理", "審核附件並建立瘦身備份"],
    duplicates: ["重複附件", "找出完全相同、可安全審核的副本"],
    advanced: ["進階", "清理 SQLite 與隱藏聊天室"]
  };
  elements.browseView.classList.toggle("hidden", view !== "browse");
  elements.attachmentsView.classList.toggle("hidden", view !== "attachments");
  elements.cleanupView.classList.toggle("hidden", view !== "cleanup");
  elements.duplicatesView.classList.toggle("hidden", view !== "duplicates");
  elements.advancedView.classList.toggle("hidden", view !== "advanced");
  elements.workspaceTitle.textContent = labels[view][0];
  elements.workspaceSubtitle.textContent = labels[view][1];
  for (const button of document.querySelectorAll("[data-view]")) {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);
    button.toggleAttribute("aria-current", active);
  }
  if (view === "attachments" && provider && !attachmentsLoaded && !attachmentsLoading) {
    void loadAttachments();
  }
  if (view === "cleanup" && provider && !cleanupPage) void loadCleanupPage();
  if (view === "duplicates" && provider && duplicateScanComplete && !duplicatePage) {
    void loadDuplicateGroups();
  }
  if (view === "advanced" && provider && advancedMode) void loadAdvancedReport();
}

async function requestWorkspaceView(view) {
  if (view === "duplicates" && !advancedMode) {
    if (!await requestConfirmation({
      title: "開啟進階模式？",
      message: "重複附件掃描與自動合併需要進階模式。",
      confirmLabel: "開啟進階模式",
      danger: true
    })) {
      return;
    }
    setAdvancedMode(true);
  }
  setWorkspaceView(view);
}

function enterWorkspace() {
  if (!provider) return;
  elements.welcomeScreen.classList.add("hidden");
  elements.workspaceScreen.classList.remove("hidden");
  setWorkspaceView(activeWorkspaceView);
  document.querySelector(`[data-view="${activeWorkspaceView}"]`).focus();
}

function returnToWelcome() {
  elements.workspaceScreen.classList.add("hidden");
  elements.welcomeScreen.classList.remove("hidden");
  void loadSavedSessions();
  elements.enterWorkspace.focus();
}

function invalidateCleanupInsights() {
  cleanupPreflight = null;
  cleanupPlanPreviews = null;
  cleanupCategoryActionState = null;
}

function setCleanupPageMode(mode, options = {}) {
  if (!["plan", "detail"].includes(mode)) return;
  cleanupPageMode = mode;
  const showingPlan = mode === "plan";
  elements.cleanupPlanPage.classList.toggle("hidden", !showingPlan);
  elements.cleanupDetailPage.classList.toggle("hidden", showingPlan);
  if (options.focus === false) return;
  if (showingPlan) {
    elements.cleanupPlanPage.querySelector("button[data-plan-profile]")?.focus();
  } else {
    elements.changeCleanupPlan.focus();
  }
}

function cleanupPlanDescription(overview) {
  const automatic = Number(overview.automaticMarkedCount) || 0;
  const manual = Number(overview.manualMarkedCount) || 0;
  const other = Math.max(0, (Number(overview.markedCount) || 0) - automatic - manual);
  const parts = [];
  if (automatic) parts.push(`自動 ${automatic.toLocaleString()} 個`);
  if (manual) parts.push(`手動 ${manual.toLocaleString()} 個`);
  if (other) parts.push(`其他 ${other.toLocaleString()} 個`);
  return parts.join("、") || "已有清理計畫";
}

async function resolveRestoredCleanupPlan(overview) {
  if (!overview || !Number(overview.markedCount)) {
    return { overview, message: "" };
  }
  const description = cleanupPlanDescription(overview);
  const clearPlan = await requestConfirmation({
    title: "發現先前的清理計畫",
    message:
      `此來源已有 ${Number(overview.markedCount).toLocaleString()} 個標記（${description}）。` +
      "這些是前次工作保留的計畫，並非這次載入自動標記。",
    cancelLabel: "繼續使用舊計畫",
    confirmLabel: "清除後重新開始",
    danger: true
  });
  if (!clearPlan) {
    return {
      overview,
      message: `將繼續使用先前的清理計畫：${description}。`,
      cleared: false
    };
  }
  const clearedOverview = await provider.clearAllRemovalPlans();
  invalidateCleanupInsights();
  return {
    overview: clearedOverview,
    message: "已清除先前的清理計畫，現在可以重新開始。",
    cleared: true
  };
}

function resetAfterCandidateBuild() {
  sourceGeneration += 1;
  chatRequestGeneration += 1;
  messageRequestGeneration += 1;
  selectedChatGeneration += 1;
  messageRenderGeneration += 1;
  provider = null;
  resetChatSearch();
  resetAttachments();
  activeSourceBytes = 0;
  selectedSourceKind = null;
  selectedChatPk = null;
  selectedChat = null;
  activeSearch = null;
  advancedReport = null;
  duplicateLoading = false;
  duplicateScanComplete = false;
  duplicatePage = null;
  duplicateExpandedSha = null;
  duplicateHashResult = null;
  duplicateMembers.clear();
  cleanupPage = null;
  cleanupOverview = null;
  cleanupCategoryActionState = null;
  invalidateCleanupInsights();
  cleanupReloadPending = false;
  disposeCleanupAlbum();
  setAdvancedMode(false);
  activeWorkspaceView = "browse";
  setWorkspaceView("browse");
  elements.sourceReadyCard.classList.add("hidden");
  elements.sessionSummary.classList.add("hidden");
  elements.enterWorkspace.disabled = true;
  elements.hashDuplicates.disabled = true;
  setCandidateBuildDisabled(true);
  for (const button of document.querySelectorAll("[data-source]")) {
    button.classList.remove("is-selected");
    button.setAttribute("aria-pressed", "false");
  }
  elements.workspaceScreen.classList.add("hidden");
  elements.welcomeScreen.classList.remove("hidden");
}

function waitForUiPaint() {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => window.setTimeout(resolve, 0));
  });
}

function syncModalBusy() {
  const modalStates = [
    [elements.loadModal, "load-modal-open"],
    [elements.packageModal, "package-modal-open"],
    [elements.operationModal, "operation-modal-open"],
    [elements.restoreChecklistModal, "restore-checklist-open"],
    [elements.imageModal, "image-modal-open"],
    [elements.confirmationModal, "confirmation-modal-open"]
  ];
  const isBusy = modalStates.some(([modal]) => !modal.classList.contains("hidden"));
  elements.appShell.inert = isBusy;
  elements.appShell.toggleAttribute("aria-busy", isBusy);
  for (const [modal, bodyClass] of modalStates) {
    document.body.classList.toggle(bodyClass, !modal.classList.contains("hidden"));
  }
}

function setModalBusy() {
  syncModalBusy();
}

function showLoadModal(message) {
  elements.loadModal.classList.remove("hidden");
  elements.loadModal.setAttribute("aria-hidden", "false");
  elements.loadModalCancel.classList.remove("hidden");
  elements.loadModalCancel.disabled = false;
  elements.loadModalCancel.textContent = "取消";
  elements.loadModalMessage.textContent = message;
  updateLoadModalProgress(0, message);
  setModalBusy(true, "load-modal-open");
  window.requestAnimationFrame(() => elements.loadModalCard.focus());
}

function updateLoadModalProgress(percent, message) {
  const progress = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  elements.loadModalProgress.style.width = `${progress}%`;
  elements.loadModalProgress.setAttribute("aria-valuenow", String(progress));
  elements.loadModalProgressLabel.textContent = `${progress}%`;
  if (message) elements.loadModalMessage.textContent = message;
}

function closeLoadModal() {
  elements.loadModal.classList.add("hidden");
  elements.loadModal.setAttribute("aria-hidden", "true");
  elements.loadModalCancel.classList.add("hidden");
  setModalBusy(false, "load-modal-open");
}

function showPackageModal(message) {
  elements.packageModal.classList.remove("hidden", "is-success", "is-error");
  elements.packageModal.classList.add("is-processing");
  elements.packageModal.setAttribute("aria-hidden", "false");
  elements.packageModalTitle.textContent = "正在建立 .imazingapp";
  elements.packageModalMessage.textContent = message;
  elements.packageModalCancel.classList.remove("hidden");
  elements.packageModalCancel.disabled = false;
  elements.packageModalCancel.textContent = "取消建立";
  elements.packageModalDonatePrompt.classList.add("hidden");
  elements.packageModalActions.classList.add("hidden");
  renderCandidateReport(null);
  updatePackageModalProgress(0, message);
  setModalBusy(true, "package-modal-open");
  window.requestAnimationFrame(() => elements.packageModalCard.focus());
}

function updatePackageModalProgress(percent, message) {
  const progress = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  elements.packageModalProgress.style.width = `${progress}%`;
  elements.packageModalProgress.setAttribute("aria-valuenow", String(progress));
  elements.packageModalProgressLabel.textContent = `${progress}%`;
  if (message) elements.packageModalMessage.textContent = message;
}

function renderCandidateReport(report) {
  if (!report) {
    elements.packageModalReport.classList.add("hidden");
    elements.packageModalReport.replaceChildren();
    return;
  }
  const checks = [
    ["完整 CRC", report.fullCrcVerified ? "通過" : "未執行", report.fullCrcVerified],
    ["保留檔驗證", `${(report.protectedEntriesVerified || []).length.toLocaleString()} 筆`, true],
    ["SQLite 重寫", `${(report.rewrittenDatabases || []).length.toLocaleString()} 個`, true],
    ["警告", `${(report.warnings || []).length.toLocaleString()} 則`, !(report.warnings || []).length]
  ];
  const fragment = document.createDocumentFragment();
  const heading = document.createElement("strong");
  heading.textContent = "候選檔驗證報告";
  const metrics = document.createElement("div");
  metrics.className = "package-report-metrics";
  for (const [label, value, passed] of checks) {
    const item = document.createElement("span");
    item.className = passed ? "passed" : "attention";
    item.textContent = `${label}：${value}`;
    metrics.append(item);
  }
  const counts = document.createElement("p");
  counts.className = "package-report-counts";
  counts.textContent =
    `輸出 ${Number(report.outputEntries || 0).toLocaleString()} 筆 · ` +
    `移除 ${Number(report.removedEntries || 0).toLocaleString()} 個檔案 · ` +
    `釋出 ${formatBytes(report.outputBytes || 0)} · ` +
    `移除 ${Number(report.removedChats || 0).toLocaleString()} 個聊天室、` +
    `${Number(report.removedMessages || 0).toLocaleString()} 則訊息`;
  fragment.append(heading, metrics, counts);
  if ((report.warnings || []).length) {
    const warnings = document.createElement("ul");
    warnings.className = "package-report-warnings";
    for (const warning of report.warnings) {
      const item = document.createElement("li");
      item.textContent = warning;
      warnings.append(item);
    }
    fragment.append(warnings);
  }
  elements.packageModalReport.replaceChildren(fragment);
  elements.packageModalReport.classList.remove("hidden");
}

function completePackageModal(error, title, message) {
  elements.packageModal.classList.remove("is-processing", "is-success", "is-error");
  elements.packageModal.classList.add(error ? "is-error" : "is-success");
  elements.packageModalTitle.textContent = title;
  elements.packageModalMessage.textContent = message;
  elements.packageModalCancel.classList.add("hidden");
  if (!error) updatePackageModalProgress(100);
  elements.packageModalClose.textContent = error ? "關閉" : "完成";
  elements.packageModalDonatePrompt.classList.toggle("hidden", error);
  elements.packageModalActions.classList.remove("hidden");
  elements.packageModalClose.focus();
}

function closePackageModal() {
  if (packageInProgress) return;
  elements.packageModal.classList.add("hidden");
  elements.packageModal.setAttribute("aria-hidden", "true");
  setModalBusy(false, "package-modal-open");
}

function showOperationModal(title, message) {
  operationModalTrigger = document.activeElement;
  elements.operationModal.classList.remove("hidden", "is-success", "is-error");
  elements.operationModal.classList.add("is-processing", "is-indeterminate");
  elements.operationModal.setAttribute("aria-hidden", "false");
  elements.operationModalTitle.textContent = title;
  elements.operationModalMessage.textContent = message;
  elements.operationModalCancel.classList.remove("hidden");
  elements.operationModalCancel.disabled = false;
  elements.operationModalCancel.textContent = "取消操作";
  elements.operationModalClose.classList.add("hidden");
  updateOperationModalProgress(0, 0, "準備中");
  syncModalBusy();
  window.requestAnimationFrame(() => elements.operationModalCard.focus());
}

function updateOperationModalProgress(processed, total, phase, unit = "筆資料") {
  const safeTotal = Math.max(0, Number(total) || 0);
  const safeProcessed = Math.max(0, Math.min(Number(processed) || 0, safeTotal || Infinity));
  const progress = safeTotal ? Math.round((safeProcessed / safeTotal) * 100) : 0;
  elements.operationModal.classList.toggle("is-indeterminate", safeTotal === 0);
  elements.operationModalProgress.style.width = safeTotal ? `${progress}%` : "34%";
  elements.operationModalProgress.setAttribute("aria-valuenow", String(progress));
  const processedLabel = unit === "bytes" ? formatBytes(safeProcessed) : safeProcessed.toLocaleString();
  const totalLabel = unit === "bytes" ? formatBytes(safeTotal) : total.toLocaleString();
  elements.operationModalProgressLabel.textContent = safeTotal
    ? `${phase || "寫入中"} ${processedLabel} / ${totalLabel} ${unit === "bytes" ? "" : unit} · ${progress}%`
    : `${phase || "準備中"}…`;
}

function completeOperationModal(error, message) {
  elements.operationModal.classList.remove("is-processing", "is-indeterminate", "is-success", "is-error");
  elements.operationModal.classList.add(error ? "is-error" : "is-success");
  elements.operationModalTitle.textContent = error ? "操作失敗" : "操作完成";
  elements.operationModalMessage.textContent = message;
  elements.operationModalCancel.classList.add("hidden");
  if (error) {
    elements.operationModalClose.classList.remove("hidden");
    elements.operationModalClose.focus();
  }
}

function closeOperationModal() {
  if (cleanupMutationInProgress || exportInProgress || sessionDeletionInProgress) return;
  elements.operationModal.classList.add("hidden");
  elements.operationModal.setAttribute("aria-hidden", "true");
  syncModalBusy();
  if (operationModalTrigger instanceof HTMLElement && operationModalTrigger.isConnected) {
    operationModalTrigger.focus();
  }
  operationModalTrigger = null;
}

async function runCleanupMutation(options, task) {
  if (cleanupMutationInProgress) {
    throw new Error("已有資料庫操作正在進行，請等待目前操作完成。");
  }
  cleanupMutationInProgress = true;
  renderCategoryBulkActions();
  showOperationModal(options.title, options.message);
  await waitForUiPaint();
  try {
    const result = await task();
    updateOperationModalProgress(1, 1, "完成");
    completeOperationModal(false, options.successMessage || "資料庫更新已完成。");
    await new Promise((resolve) => window.setTimeout(resolve, 180));
    cleanupMutationInProgress = false;
    closeOperationModal();
    return result;
  } catch (error) {
    cleanupMutationInProgress = false;
    if (isOperationCancelled(error)) {
      completeOperationModal(false, "操作已取消；尚未提交的資料庫變更已回滾。");
      elements.operationModalClose.classList.remove("hidden");
      elements.operationModalClose.focus();
      throw error;
    }
    completeOperationModal(true, error.message);
    throw error;
  }
}

async function runExportJob(options, task) {
  if (cleanupMutationInProgress || exportInProgress) {
    throw new Error("已有操作正在進行，請等待目前操作完成。");
  }
  exportInProgress = true;
  showOperationModal(options.title, options.message);
  await waitForUiPaint();
  try {
    const result = await task();
    updateOperationModalProgress(1, 1, "完成");
    completeOperationModal(false, options.successMessage || "附件匯出完成。");
    await new Promise((resolve) => window.setTimeout(resolve, 180));
    exportInProgress = false;
    closeOperationModal();
    return result;
  } catch (error) {
    exportInProgress = false;
    if (isOperationCancelled(error)) {
      completeOperationModal(false, "匯出已取消；未完成的暫存輸出已清理。");
      elements.operationModalClose.classList.remove("hidden");
      elements.operationModalClose.focus();
      throw error;
    }
    completeOperationModal(true, error.message);
    throw error;
  }
}

async function exportAttachmentSelection(paths, options = {}) {
  if (!provider) {
    setStatus("請先開啟備份。", true);
    return;
  }
  if (selectedSourceKind === "sqlite") {
    setStatus("直接 Line.sqlite 來源沒有可匯出的附件檔案。", true);
    return;
  }
  const output = await bridge.chooseExportOutput();
  if (!output) return;
  try {
    const result = await runExportJob({
      title: options.imagesOnly ? "正在匯出圖檔" : "正在匯出附件",
      message: "正在將附件串流複製到新的匯出資料夾，請勿重複操作。",
      successMessage: options.imagesOnly ? "圖檔匯出完成。" : "附件匯出完成。"
    }, () => provider.exportAttachments({
      output: output.token,
      paths,
      source: options.source,
      chatPk: options.chatPk,
      imagesOnly: Boolean(options.imagesOnly),
      includeThumbnails: Boolean(options.includeThumbnails)
    }));
    const skipped = Number(result.skippedFiles) || 0;
    const detail = skipped
      ? `已匯出 ${Number(result.exportedFiles || 0).toLocaleString()} 個檔案，略過 ${skipped.toLocaleString()} 個非圖檔。`
      : `已匯出 ${Number(result.exportedFiles || 0).toLocaleString()} 個檔案。`;
    setStatus(`${detail} 位置：${result.outputName || "新資料夾"}`, false);
  } catch (error) {
    reportCleanupMutationError(error);
  }
}

function exportCurrentChat(imagesOnly) {
  if (!selectedChat || selectedChatPk === null) return;
  return exportAttachmentSelection([], {
    imagesOnly,
    includeThumbnails: !imagesOnly,
    source: selectedChat.source || "line",
    chatPk: selectedChatPk
  });
}

async function exportCurrentConversation() {
  if (!provider || !selectedChat || selectedChatPk === null) return;
  try {
    const output = await bridge.chooseConversationOutput();
    if (!output) return;
    const result = await runExportJob({
      title: "正在輸出完整討論串",
      message: "正在從最早一則開始讀取全部訊息，並將 HTML 與附件寫入 ZIP。",
      successMessage: "完整討論串輸出完成。"
    }, () => provider.exportConversation({
      output: output.token,
      source: selectedChat.source || "line",
      chatPk: selectedChatPk
    }));
    setStatus(
      `已輸出 ${Number(result.messages || 0).toLocaleString()} 則訊息與 ` +
      `${Number(result.attachments || 0).toLocaleString()} 個附件。` +
      `檔案：${result.outputName || output.displayName}`,
      false
    );
  } catch (error) {
    reportCleanupMutationError(error);
  }
}

function closeRestoreChecklist(confirmed) {
  if (!restoreChecklistResolve) return;
  const resolve = restoreChecklistResolve;
  restoreChecklistResolve = null;
  elements.restoreChecklistModal.classList.add("hidden");
  elements.restoreChecklistModal.setAttribute("aria-hidden", "true");
  setModalBusy(false, "restore-checklist-open");
  resolve(Boolean(confirmed));
}

function requestRestoreChecklist() {
  if (restoreChecklistResolve) return Promise.resolve(false);
  elements.restoreCheckOriginal.checked = false;
  elements.restoreCheckTest.checked = false;
  elements.restoreCheckVerify.checked = false;
  elements.restoreCheckConfirm.disabled = true;
  elements.restoreChecklistModal.classList.remove("hidden");
  elements.restoreChecklistModal.setAttribute("aria-hidden", "false");
  setModalBusy(true, "restore-checklist-open");
  window.requestAnimationFrame(() => elements.restoreChecklistCard.focus());
  return new Promise((resolve) => {
    restoreChecklistResolve = resolve;
  });
}

function updateRestoreChecklistState() {
  elements.restoreCheckConfirm.disabled = !(
    elements.restoreCheckOriginal.checked &&
    elements.restoreCheckTest.checked &&
    elements.restoreCheckVerify.checked
  );
}

function isOperationCancelled(error) {
  return error && error.code === "operation_cancelled";
}

function reportCleanupMutationError(error) {
  if (isOperationCancelled(error)) {
    setStatus("操作已取消；尚未提交的資料庫變更已回滾。", false);
    return;
  }
  setStatus(error.message, true);
}

async function cancelCurrentOperation(kind) {
  if (cancelInProgress) return;
  const cancellation = {
    load: {
      title: "確定取消載入與掃描？",
      message: "取消後會停止目前的附件索引工作；未完成的索引不會當成有效結果。",
      confirmLabel: "確認取消掃描"
    },
    package: {
      title: "確定取消建立瘦身檔？",
      message: "取消後會停止建立候選檔，並清理尚未完成的輸出與暫存資料。",
      confirmLabel: "確認取消建立"
    },
    duplicate: {
      title: "確定取消重複附件掃描？",
      message: "取消後會清除未完成的雜湊結果，之後需要重新掃描。",
      confirmLabel: "確認取消掃描"
    },
    cleanup: {
      title: "確定取消資料庫操作？",
      message: "取消後會停止目前的批次工作；尚未提交的聊天室與附件清理計畫將全部回滾。",
      confirmLabel: "確認取消操作"
    },
    export: {
      title: "確定取消附件匯出？",
      message: "取消後會停止目前的串流匯出，尚未完成的暫存輸出會被清理。",
      confirmLabel: "確認取消匯出"
    }
  }[kind];
  if (!cancellation || !await requestConfirmation({
    ...cancellation,
    cancelLabel: "繼續目前工作",
    danger: true
  })) return;
  cancelInProgress = true;
  const button = kind === "load"
      ? elements.loadModalCancel
      : kind === "package"
        ? elements.packageModalCancel
        : ["cleanup", "export"].includes(kind)
          ? elements.operationModalCancel
          : elements.cancelDuplicateScan;
  button.disabled = true;
  button.textContent = "取消中…";
  try {
    await bridge.cancelOperation();
    if (kind === "load") {
      sourceGeneration += 1;
      setStatus("已取消目前工作；原始備份仍保持唯讀，請重新掃描後再繼續。", false);
      closeLoadModal();
    } else if (kind === "duplicate") {
      duplicateLoading = false;
      duplicateScanComplete = false;
      setDuplicateAutoMerge(false);
      elements.duplicateProgressLabel.textContent = "掃描已取消，部分雜湊已清除";
      elements.duplicateGroups.replaceChildren(emptyState("掃描已取消；請重新掃描以取得完整結果。"));
      elements.hashDuplicates.disabled = selectedSourceKind === "sqlite";
      elements.cancelDuplicateScan.classList.add("hidden");
      setStatus("已取消重複附件掃描。", false);
    }
  } catch (error) {
    button.disabled = false;
    button.textContent = kind === "load"
      ? "取消"
      : kind === "package"
        ? "取消建立"
        : ["cleanup", "export"].includes(kind)
          ? "取消操作"
          : "取消掃描";
    setStatus(`取消工作失敗：${error.message}`, true);
  } finally {
    cancelInProgress = false;
  }
}

function showImageModal(url, caption, trigger) {
  imageModalTrigger = trigger || null;
  elements.imageModalImage.src = url;
  elements.imageModalImage.alt = caption || "LINE 圖片";
  elements.imageModalCaption.textContent = caption || "LINE 圖片";
  elements.imageModal.classList.remove("hidden");
  elements.imageModal.setAttribute("aria-hidden", "false");
  setModalBusy(true, "image-modal-open");
  window.requestAnimationFrame(() => elements.imageModalCard.focus());
}

function closeImageModal() {
  if (elements.imageModal.classList.contains("hidden")) return;
  elements.imageModal.classList.add("hidden");
  elements.imageModal.setAttribute("aria-hidden", "true");
  elements.imageModalImage.removeAttribute("src");
  setModalBusy(false, "image-modal-open");
  if (imageModalTrigger) imageModalTrigger.focus();
  imageModalTrigger = null;
}

async function requestModalClose(kind) {
  const closeRequest = {
    package: {
      title: "確定關閉建立結果？",
      message: "關閉後仍可從主畫面的狀態訊息確認結果。",
      confirmLabel: "確認關閉",
      close: closePackageModal
    },
    operation: {
      title: "確定關閉操作結果？",
      message: "關閉後會返回附件瘦身畫面，已完成或已回滾的結果不會改變。",
      confirmLabel: "確認關閉",
      close: closeOperationModal
    },
    image: {
      title: "確定關閉圖片預覽？",
      message: "關閉後會返回原本的附件或聊天室位置。",
      confirmLabel: "確認關閉",
      close: closeImageModal
    }
  }[kind];
  if (!closeRequest || !await requestConfirmation({
    title: closeRequest.title,
    message: closeRequest.message,
    cancelLabel: "繼續查看",
    confirmLabel: closeRequest.confirmLabel
  })) return;
  closeRequest.close();
}

function requestConfirmation(options) {
  const config = options || {};
  if (confirmationModalResolver) closeConfirmationModal(false);
  elements.confirmationModalTitle.textContent = config.title || "確認操作";
  elements.confirmationModalMessage.textContent = config.message || "";
  elements.confirmationModalCancel.textContent = config.cancelLabel || "取消";
  elements.confirmationModalConfirm.textContent = config.confirmLabel || "確認";
  elements.confirmationModalConfirm.classList.toggle("danger-button", Boolean(config.danger));
  elements.confirmationModal.classList.remove("hidden");
  elements.confirmationModal.setAttribute("aria-hidden", "false");
  confirmationModalTrigger = document.activeElement;
  setModalBusy();
  window.requestAnimationFrame(() => elements.confirmationModalConfirm.focus());
  return new Promise((resolve) => {
    confirmationModalResolver = resolve;
  });
}

function closeConfirmationModal(confirmed) {
  if (elements.confirmationModal.classList.contains("hidden")) return;
  const resolve = confirmationModalResolver;
  confirmationModalResolver = null;
  elements.confirmationModal.classList.add("hidden");
  elements.confirmationModal.setAttribute("aria-hidden", "true");
  elements.confirmationModalCancel.textContent = "取消";
  elements.confirmationModalConfirm.classList.remove("danger-button");
  setModalBusy();
  if (confirmationModalTrigger && confirmationModalTrigger.isConnected) {
    confirmationModalTrigger.focus();
  }
  confirmationModalTrigger = null;
  if (resolve) resolve(Boolean(confirmed));
}

function trapModalFocus(event, modal) {
  const focusables = Array.from(modal.querySelectorAll(
    "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
  )).filter((element) => !element.hidden);
  if (!focusables.length) {
    event.preventDefault();
    modal.focus();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function replaceChildren(container, items, render) {
  const fragment = document.createDocumentFragment();
  for (const item of items) fragment.append(render(item));
  container.replaceChildren(fragment);
}

function record(primary, secondary) {
  const item = document.createElement("li");
  const title = document.createElement("strong");
  title.textContent = primary;
  const detail = document.createElement("span");
  detail.textContent = secondary;
  item.append(title, detail);
  return item;
}

function normalizedTimestamp(value) {
  if (!Number.isFinite(Number(value))) return null;
  let numeric = Number(value);
  if (numeric === 0) return null;
  if (Math.abs(numeric) < 100_000_000_000) {
    if (numeric > -978_307_200 && numeric < 1_200_000_000) numeric += 978_307_200;
    numeric *= 1000;
  }
  const date = new Date(numeric);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function formatTimestamp(value) {
  const date = normalizedTimestamp(value);
  return date ? date.toLocaleString() : "時間不明";
}

function formatBytes(value) {
  let bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes.toLocaleString()} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let unit = -1;
  do {
    bytes /= 1024;
    unit += 1;
  } while (bytes >= 1024 && unit < units.length - 1);
  return `${bytes.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[unit]}`;
}

function fileName(path) {
  return String(path || "").split("/").pop() || "未命名附件";
}

function cleanupStatusLabel(status) {
  return {
    referenced: "聊天室附件",
    unreferenced: "SQLite 未引用",
    unconfirmed: "無法確認",
    no_attachments: "沒有附件"
  }[status] || "附件";
}

function cleanupStatusSummary(status) {
  if (status === "unreferenced") {
    return "附件未被路徑所屬聊天室的 SQLite 訊息引用，請人工確認後再刪除。";
  }
  if (status === "unconfirmed") {
    return "路徑或訊息 ID 無法可靠比對，未列為孤兒檔案。";
  }
  if (status === "no_attachments") {
    return "沒有已索引附件，可加入清理計畫以完整刪除聊天室。";
  }
  return {
    direct: "個人聊天室",
    group: "群組聊天室",
    community: "社群"
  }[status] || "";
}

function chatIcon(kind) {
  return {
    direct: "人",
    group: "群",
    community: "社",
    unreferenced: "鬼",
    unknown: "?"
  }[kind] || "聊";
}

function emptyState(message) {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = message;
  return empty;
}

function setRetryVisible(button, visible) {
  button.classList.toggle("hidden", !visible);
}

function setChatPanelBusy(isBusy) {
  elements.chats.setAttribute("aria-busy", String(isBusy));
  elements.previousChats.disabled = isBusy || !chatBeforeCursor;
  elements.nextChats.disabled = isBusy || !chatCursor;
}

function setMessagePanelBusy(isBusy) {
  elements.messages.setAttribute("aria-busy", String(isBusy));
  elements.previousMessages.disabled = isBusy || !messageBeforeCursor;
  elements.nextMessages.disabled = isBusy || !messageCursor;
  elements.searchButton.disabled = isBusy || !selectedChat;
  elements.clearSearch.disabled = isBusy || !activeSearch;
  const exportDisabled = isBusy || !selectedChat || selectedSourceKind === "sqlite" || exportInProgress;
  elements.exportChatImages.disabled = exportDisabled;
  elements.exportChatAttachments.disabled = exportDisabled;
  elements.exportChatConversation.disabled = isBusy || !selectedChat || exportInProgress;
}

function renderChatLoadError() {
  elements.chatListStatus.textContent = "聊天室載入失敗，請重試。";
  elements.chatListStatus.classList.add("error");
  elements.chats.replaceChildren(emptyState("暫時無法載入聊天室。請確認備份仍可讀取，或按「重試」。"));
  setRetryVisible(elements.retryChats, true);
}

function renderMessageLoadError() {
  elements.messageStatus.textContent = "訊息載入失敗，請重試。";
  elements.messageStatus.classList.add("error");
  elements.messages.replaceChildren(emptyState("暫時無法載入訊息。請確認備份仍可讀取，或按「重試」。"));
  setRetryVisible(elements.retryMessages, true);
}

async function openSource(kind, sessionId = null) {
  const requestSourceGeneration = ++sourceGeneration;
  const hadProvider = Boolean(provider);
  showLoadModal(sessionId
    ? "正在讀取既有分析工作階段…"
    : "請在系統視窗選擇 LINE 備份來源。");
  updateLoadModalProgress(2);
  await waitForUiPaint();
  try {
    setStatus("正在開啟備份…");
    const ready = sessionId
      ? await bridge.openSession(sessionId)
      : await bridge.selectSource(kind);
    if (!ready) {
      setStatus(hadProvider ? "已取消，保留目前備份。" : "已取消選擇備份。");
      closeLoadModal();
      return;
    }
    if (requestSourceGeneration !== sourceGeneration) return;
    elements.enterWorkspace.disabled = true;
    elements.sourceReadyCard.classList.add("hidden");
    elements.sessionSummary.classList.add("hidden");
    updateLoadModalProgress(12, "正在以唯讀模式開啟 SQLite…");
    provider = new NativeDataProvider(bridge);
    chatRequestGeneration += 1;
    messageRequestGeneration += 1;
    selectedChatGeneration += 1;
    chatCursor = chatBeforeCursor = messageCursor = messageBeforeCursor = null;
    chatPageNumber = messagePageNumber = 1;
    chatRetryDirection = messageRetryDirection = "initial";
    chatLoading = messageLoading = false;
    resetChatSearch();
    resetAttachments();
    selectedChatPk = activeSearch = selectedChat = null;
    advancedReport = null;
    duplicateLoading = false;
    duplicateScanComplete = false;
    duplicatePage = null;
    duplicatePageNumber = 1;
    duplicatePageCursors = [null];
    duplicateExpandedSha = null;
    duplicateHashResult = null;
    duplicateMembers.clear();
    messageRenderGeneration += 1;
    disposeCleanupAlbum();
    cleanupReloadPending = false;
    cleanupPage = cleanupOverview = null;
    cleanupCategoryActionState = null;
    cleanupPlanNotice = "";
    invalidateCleanupInsights();
    Object.assign(cleanupState, {
      page: 1,
      search: "",
      kind: "all",
      category: "all",
      sort: "size",
      groupKey: null,
      planProfile: null,
      manualMode: false
    });
    setCleanupPageMode("plan", { focus: false });
    setAdvancedMode(false);
    elements.cleanupSearch.value = "";
    elements.cleanupKind.value = "all";
    elements.cleanupCategory.value = "all";
    elements.cleanupSort.value = "size";
    elements.cleanupList.replaceChildren(emptyState("請先掃描附件。"));
    elements.cleanupAutomationSummary.textContent =
      "安全自動清理只會標記已確認的圖片原檔，並保留非空縮圖。";
    elements.cleanupPreflight.classList.remove("has-blockers");
    elements.cleanupPreflight.classList.add("hidden");
    elements.cleanupPreflightTitle.textContent = "清理前盲點掃描";
    elements.cleanupPreflightSummary.textContent = "正在檢查來源、索引與不確定檔案…";
    elements.cleanupPreflightRisks.replaceChildren();
    elements.cleanupPlanCards.replaceChildren();
    elements.cleanupPlanPreviewsSummary.textContent = "請先選擇方案，確認後才會進入詳細清理。";
    elements.cleanupCurrentPlan.textContent = "目前方案";
    elements.planSafeAttachmentCleanup.disabled = true;
    elements.clearManualAttachmentPlan.disabled = true;
    elements.duplicateGroups.replaceChildren(emptyState("先掃描附件，找出完全相同的檔案。"));
    elements.duplicateSummary.classList.add("hidden");
    setDuplicateAutoMerge(false);
    elements.duplicateProgressLabel.textContent = "";
    elements.cancelDuplicateScan.classList.add("hidden");
    elements.duplicatePageInfo.textContent = "第 1 頁";
    elements.duplicatePrev.disabled = true;
    elements.duplicateNext.disabled = true;
    elements.hashDuplicates.disabled = true;
    elements.chats.replaceChildren(emptyState("正在載入聊天室…"));
    elements.chatListStatus.textContent = "正在整理聊天室…";
    setRetryVisible(elements.retryChats, false);
    elements.messages.replaceChildren(emptyState("尚未選取聊天室。"));
    elements.selectedChatTitle.textContent = "選取聊天室";
    elements.selectedChatMeta.textContent = "請從左側選取聊天室開始。";
    elements.messageStatus.textContent = "";
    setRetryVisible(elements.retryMessages, false);
    elements.clearSearch.disabled = true;
    elements.previousMessages.disabled = true;
    elements.nextMessages.disabled = true;
    elements.exportChatImages.disabled = true;
    elements.exportChatAttachments.disabled = true;
    elements.exportChatConversation.disabled = true;
    const info = await provider.sessionInfo();
    activeSourceBytes = Number(info.source.sourceBytes) || 0;
    const sourceName = sourceDisplayName(info.source.sourcePath, info.source.kind);
    const sourceType = sourceKindLabel(info.source.kind);
    const sourceSize = Number(info.source.sourceBytes) || Number(info.source.databaseBytes) || 0;
    updateLoadModalProgress(20, "正在整理聊天室名稱與附件索引…");
    elements.scanCatalog.disabled = false;
    elements.planSafeAttachmentCleanup.disabled = true;
    elements.clearManualAttachmentPlan.disabled = true;
    elements.hashDuplicates.disabled = info.source.kind === "sqlite" ||
      info.catalog.scanStatus !== "complete";
    elements.searchButton.disabled = true;
    setCandidateBuildDisabled(true);
    if (info.source.kind !== "sqlite" &&
        (!info.catalogSourceCurrent ||
          info.catalog.scanStatus !== "complete")) {
      await scanCatalog({ keepLoadModal: true });
      if (requestSourceGeneration !== sourceGeneration) return;
    } else if (info.catalog.scanStatus === "complete") {
      const overview = await provider.cleanupOverview();
      if (overview.contextStatus === "complete") {
        await loadCleanupPage();
        setCandidateBuildDisabled(false);
      } else {
        await scanCatalog({ keepLoadModal: true });
        if (requestSourceGeneration !== sourceGeneration) return;
      }
    }
    if (info.source.kind === "imazing_archive" &&
        cleanupOverview?.contextStatus === "complete" &&
        cleanupOverview.markedCount > 0) {
      const resolution = await resolveRestoredCleanupPlan(cleanupOverview);
      cleanupOverview = resolution.overview;
      cleanupPlanNotice = resolution.message;
      if (resolution.cleared) {
        cleanupPage = null;
        await loadCleanupPage({ verifySource: false });
      }
    }
    const finalInfo = await provider.sessionInfo();
    renderSessionSummary(finalInfo);
    elements.hashDuplicates.disabled = finalInfo.source.kind === "sqlite" ||
      finalInfo.catalog.scanStatus !== "complete";
    updateLoadModalProgress(93, "正在顯示聊天室…");
    await loadChats("initial");
    updateLoadModalProgress(100, "完整備份解析完成。");
    setStatus(cleanupPlanNotice || (sessionId
      ? "既有工作階段已載入，不需要重新分析備份。"
      : "備份已以唯讀模式開啟，可以進入工作區。"));
    selectedSourceKind = sourceSelectionKind(info.source.kind);
    elements.selectedSourceName.textContent = sourceName;
    elements.selectedSourceDetail.textContent =
      `${sourceType} · ${formatBytes(sourceSize)} · SQLite ${finalInfo.quickCheck}`;
    elements.sidebarSourceName.textContent = sourceName;
    elements.sidebarSourceDetail.textContent = `${sourceType} · 唯讀`;
    elements.sourceReadyCard.classList.remove("hidden");
    elements.enterWorkspace.disabled = false;
    for (const button of document.querySelectorAll("[data-source]")) {
      const selected = button.dataset.source === selectedSourceKind;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
    await waitForUiPaint();
    closeLoadModal();
    elements.enterWorkspace.focus();
  } catch (error) {
    provider = null;
    advancedReport = null;
    setAdvancedMode(false);
    elements.enterWorkspace.disabled = true;
    elements.sourceReadyCard.classList.add("hidden");
    elements.sessionSummary.classList.add("hidden");
    setStatus(error.message, true);
    closeLoadModal();
    if (sessionId) void loadSavedSessions();
  }
}

function chatCursorFor(chat) {
  if (!chat) return null;
  return {
    lastUpdated: Number(chat.lastUpdated) || 0,
    source: chat.source || "line",
    pk: Number(chat.pk) || 0
  };
}

function messageCursorFor(message) {
  if (!message) return null;
  return {
    timestamp: Number(message.timestamp) || 0,
    pk: Number(message.pk) || 0
  };
}

function renderChatItem(chat) {
  const button = document.createElement("button");
  button.type = "button";
  const selected = selectedChatPk === chat.pk &&
    (selectedChat ? selectedChat.source : "line") === (chat.source || "line");
  button.className = `chat-item${selected ? " selected" : ""}`;
  button.classList.toggle("planned-removal", Boolean(chat.plannedForRemoval));
  button.dataset.chatPk = String(chat.pk);
  button.dataset.chatSource = chat.source || "line";
  button.setAttribute("role", "option");
  button.setAttribute("aria-selected", String(selected));
  const title = document.createElement("span");
  title.className = "chat-item-title";
  title.textContent = chat.title;
  if (chat.plannedForRemoval) {
    const badge = document.createElement("small");
    badge.className = "chat-removal-badge";
    badge.textContent = "將刪除";
    title.append(" ", badge);
  }
  const meta = document.createElement("span");
  meta.className = "chat-item-meta";
  const count = document.createElement("span");
  count.textContent = `${chat.humanMessageCount.toLocaleString()} 則`;
  const date = document.createElement("span");
  date.textContent = formatTimestamp(chat.lastUpdated);
  meta.append(count, date);
  button.append(title, meta);
  button.addEventListener("click", () => void selectChat(chat));
  return button;
}

function chatListStatusText(totalChats, page) {
  return `${totalChats.toLocaleString()} 個聊天室 · ` +
    `${page.hasPrevious ? "可往前翻頁" : "已是最前頁"} · ` +
    `${page.nextCursor ? "可往後翻頁" : "已是最後頁"}`;
}

function updateChatListTotal(page, currentProvider, currentSourceGeneration, requestGeneration) {
  void loadAllChats().then((all) => {
    if (!all || requestGeneration !== chatRequestGeneration ||
        currentSourceGeneration !== sourceGeneration ||
        currentProvider !== provider || chatSearchQuery) return;
    elements.chatListStatus.textContent = chatListStatusText(all.length, page);
  }).catch(() => {
    // Pagination remains usable if the optional total-count lookup fails.
  });
}

async function loadChats(direction = "initial") {
  if (!provider || (chatLoading && direction !== "initial")) return;
  if (chatSearchQuery && direction !== "initial") {
    allChatsCache = null;
    await applyChatSearch();
    return;
  }
  const currentProvider = provider;
  const currentSourceGeneration = sourceGeneration;
  const requestGeneration = ++chatRequestGeneration;
  chatLoading = true;
  chatRetryDirection = direction;
  const cursor = direction === "next" ? chatCursor : null;
  const beforeCursor = direction === "previous" ? chatBeforeCursor : null;
  let succeeded = false;
  setChatPanelBusy(true);
  elements.chatListStatus.textContent = "正在載入聊天室…";
  setRetryVisible(elements.retryChats, false);
  try {
    const page = await currentProvider.listChats({ limit: 100, cursor, beforeCursor });
    if (requestGeneration !== chatRequestGeneration ||
        currentSourceGeneration !== sourceGeneration ||
        currentProvider !== provider) return;
    replaceChildren(elements.chats, page.items, renderChatItem);
    elements.chatListStatus.classList.remove("error");
    chatBeforeCursor = page.items.length ? chatCursorFor(page.items[0]) : null;
    chatCursor = page.nextCursor;
    if (direction === "previous") chatPageNumber = Math.max(1, chatPageNumber - 1);
    else if (direction === "next") chatPageNumber += 1;
    else chatPageNumber = 1;
    elements.previousChats.disabled = !page.hasPrevious;
    elements.nextChats.disabled = !chatCursor;
    elements.chatPageInfo.textContent = page.items.length
      ? `第 ${chatPageNumber} 頁 · ${page.items.length.toLocaleString()} 個聊天室`
      : "沒有聊天室";
    elements.chatListStatus.textContent = page.items.length
      ? "正在計算所有聊天室數量…"
      : "沒有可顯示的聊天室。";
    if (page.items.length) {
      updateChatListTotal(
        { hasPrevious: page.hasPrevious, nextCursor: chatCursor },
        currentProvider,
        currentSourceGeneration,
        requestGeneration
      );
    }
    setRetryVisible(elements.retryChats, false);
    elements.chatSearch.disabled = false;
    succeeded = true;
  } catch (error) {
    if (requestGeneration !== chatRequestGeneration ||
        currentSourceGeneration !== sourceGeneration ||
        currentProvider !== provider) return;
    setStatus(`聊天室載入失敗：${error.message}`, true);
    renderChatLoadError();
  } finally {
    if (requestGeneration === chatRequestGeneration) {
      chatLoading = false;
      elements.chats.removeAttribute("aria-busy");
      if (!succeeded) {
        elements.previousChats.disabled = true;
        elements.nextChats.disabled = true;
      }
    }
  }
}

async function loadAllChats() {
  const currentProvider = provider;
  const gen = sourceGeneration;
  if (allChatsCache && allChatsCacheGeneration === gen) return allChatsCache;
  const items = [];
  let cursor = null;
  for (let guard = 0; guard < 1000; guard += 1) {
    const page = await currentProvider.listChats({ limit: 100, cursor });
    if (currentProvider !== provider || gen !== sourceGeneration) return null;
    items.push(...page.items);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  allChatsCache = items;
  allChatsCacheGeneration = gen;
  return items;
}

async function applyChatSearch() {
  if (!provider) return;
  const query = chatSearchQuery;
  const requestGeneration = ++chatSearchGeneration;
  if (!query) {
    elements.chatPagination.classList.remove("hidden");
    await loadChats(null);
    return;
  }
  elements.chatPagination.classList.add("hidden");
  elements.chatListStatus.classList.remove("error");
  elements.chatListStatus.textContent = "正在搜尋聊天室…";
  elements.chats.setAttribute("aria-busy", "true");
  allChatsLoading = true;
  try {
    const all = await loadAllChats();
    if (requestGeneration !== chatSearchGeneration) return;
    if (!all) return;
    const needle = query.toLowerCase();
    const matches = all.filter(
      (chat) => String(chat.title || "").toLowerCase().includes(needle)
    );
    if (matches.length) {
      replaceChildren(elements.chats, matches, renderChatItem);
    } else {
      elements.chats.replaceChildren(emptyState(`沒有名稱包含「${query}」的聊天室。`));
    }
    elements.chatListStatus.textContent =
      `${matches.length.toLocaleString()} 個符合「${query}」的聊天室` +
      ` · 共 ${all.length.toLocaleString()} 個`;
  } catch (error) {
    if (requestGeneration !== chatSearchGeneration) return;
    elements.chatListStatus.classList.add("error");
    elements.chatListStatus.textContent = `搜尋聊天室失敗：${error.message}`;
  } finally {
    if (requestGeneration === chatSearchGeneration) {
      allChatsLoading = false;
      elements.chats.removeAttribute("aria-busy");
    }
  }
}

function handleChatSearchInput() {
  chatSearchQuery = elements.chatSearch.value.trim();
  if (chatSearchDebounce) clearTimeout(chatSearchDebounce);
  chatSearchDebounce = setTimeout(() => {
    chatSearchDebounce = null;
    void applyChatSearch();
  }, 200);
}

function resetChatSearch() {
  if (chatSearchDebounce) {
    clearTimeout(chatSearchDebounce);
    chatSearchDebounce = null;
  }
  chatSearchQuery = "";
  chatSearchGeneration += 1;
  allChatsCache = null;
  allChatsCacheGeneration = -1;
  allChatsLoading = false;
  if (elements.chatSearch) {
    elements.chatSearch.value = "";
    elements.chatSearch.disabled = true;
  }
  if (elements.chatPagination) elements.chatPagination.classList.remove("hidden");
}

function attachmentCategory(contentType) {
  switch (Number(contentType)) {
    case 1: case 16: case 112: return "image";
    case 2: case 17: return "video";
    case 3: return "voice";
    case 4: case 14: return "file";
    case 5: case 101: return "sticker";
    case 100: return "location";
    case 107: return "link";
    default: return "other";
  }
}

function attachmentBasename(path) {
  const parts = String(path || "").split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(path || "");
}

function attachmentTime(attachment) {
  if (attachment.context && attachment.context.timestamp) {
    return Number(attachment.context.timestamp) || 0;
  }
  return Math.floor((Number(attachment.modifiedNs) || 0) / 1e6);
}

function attachmentChatKey(attachment) {
  return attachment.context
    ? `${attachment.context.source}:${attachment.context.chatPk}`
    : "";
}

function resetAttachments() {
  attachmentsLoaded = false;
  attachmentsLoading = false;
  allAttachments = [];
  attachmentsGeneration = -1;
  attachmentFiltered = [];
  attachmentPage = 1;
  attachmentFilter.search = "";
  attachmentFilter.chatMode = "include";
  attachmentFilter.chats = new Set();
  attachmentFilter.typeMode = "include";
  attachmentFilter.types = new Set();
  attachmentFilter.includeThumbnails = false;
  attachmentFilter.sort = "size-desc";
  if (attachmentSearchDebounce) {
    clearTimeout(attachmentSearchDebounce);
    attachmentSearchDebounce = null;
  }
  if (elements.attachmentSearch) elements.attachmentSearch.value = "";
  if (elements.attachmentSort) elements.attachmentSort.value = "size-desc";
  if (elements.attachmentChatMode) elements.attachmentChatMode.value = "include";
  if (elements.attachmentTypeMode) elements.attachmentTypeMode.value = "include";
  if (elements.attachmentIncludeThumbnails) elements.attachmentIncludeThumbnails.checked = false;
  if (elements.attachmentChat) elements.attachmentChat.replaceChildren();
  if (elements.attachmentTypeChips) elements.attachmentTypeChips.replaceChildren();
  if (elements.attachmentList) {
    elements.attachmentList.replaceChildren(emptyState("載入備份後顯示附件。"));
  }
  if (elements.attachmentSummary) {
    elements.attachmentSummary.classList.remove("error");
    elements.attachmentSummary.textContent = "載入備份後顯示附件。";
  }
  if (elements.exportFilteredAttachments) elements.exportFilteredAttachments.disabled = true;
  if (elements.attachmentPrevious) elements.attachmentPrevious.disabled = true;
  if (elements.attachmentNext) elements.attachmentNext.disabled = true;
  if (elements.attachmentPageInfo) elements.attachmentPageInfo.textContent = "第 1 頁";
}

async function loadAttachments() {
  if (!provider || attachmentsLoading) return;
  if (selectedSourceKind === "sqlite") {
    elements.attachmentList.replaceChildren(
      emptyState("直接 Line.sqlite 來源沒有可瀏覽的附件檔案。")
    );
    elements.attachmentSummary.textContent = "此來源沒有附件檔案。";
    return;
  }
  attachmentsLoading = true;
  const gen = sourceGeneration;
  const currentProvider = provider;
  elements.attachmentSummary.classList.remove("error");
  elements.attachmentSummary.textContent = "正在載入附件…";
  elements.attachmentList.setAttribute("aria-busy", "true");
  try {
    const items = [];
    let cursor = null;
    for (let guard = 0; guard < 100000; guard += 1) {
      const page = await currentProvider.listAttachments({ limit: 500, cursor });
      if (gen !== sourceGeneration || currentProvider !== provider) return;
      items.push(...page.items);
      cursor = page.nextCursor;
      elements.attachmentSummary.textContent =
        `正在載入附件… 已讀取 ${items.length.toLocaleString()} 個`;
      if (!cursor) break;
    }
    allAttachments = items;
    attachmentsGeneration = gen;
    attachmentsLoaded = true;
    buildAttachmentChatOptions();
    applyAttachmentFilters();
  } catch (error) {
    if (gen !== sourceGeneration || currentProvider !== provider) return;
    elements.attachmentSummary.classList.add("error");
    elements.attachmentSummary.textContent = `載入附件失敗：${error.message}`;
  } finally {
    if (gen === sourceGeneration && currentProvider === provider) {
      attachmentsLoading = false;
      elements.attachmentList.removeAttribute("aria-busy");
    }
  }
}

function buildAttachmentChatOptions() {
  const map = new Map();
  for (const attachment of allAttachments) {
    if (!attachment.context) continue;
    const key = attachmentChatKey(attachment);
    const label = attachment.context.chatTitle || attachment.chatHint || key;
    const entry = map.get(key) || { label, count: 0 };
    entry.count += 1;
    map.set(key, entry);
  }
  const entries = [...map.entries()].sort((a, b) => b[1].count - a[1].count);
  const container = elements.attachmentChat;
  const available = new Set(entries.map(([key]) => key));
  // Drop selections that no longer exist (e.g. after toggling thumbnails).
  for (const key of [...attachmentFilter.chats]) {
    if (!available.has(key)) attachmentFilter.chats.delete(key);
  }
  container.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "attachment-chat-empty";
    empty.textContent = "沒有可篩選的聊天室。";
    container.append(empty);
    return;
  }
  for (const [key, entry] of entries) {
    const option = document.createElement("label");
    option.className = "attachment-chat-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = key;
    checkbox.checked = attachmentFilter.chats.has(key);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) attachmentFilter.chats.add(key);
      else attachmentFilter.chats.delete(key);
      applyAttachmentFilters();
    });
    const text = document.createElement("span");
    text.textContent = `${entry.label}（${entry.count.toLocaleString()}）`;
    text.title = entry.label;
    option.append(checkbox, text);
    container.append(option);
  }
}

function attachmentPassesNonType(attachment, filter) {
  if (!filter.includeThumbnails && attachment.kind === "thumbnail") return false;
  if (filter.chats.size) {
    const inSet = filter.chats.has(attachmentChatKey(attachment));
    if (filter.chatMode === "include" ? !inSet : inSet) return false;
  }
  if (filter.search) {
    if (!attachment.path.toLowerCase().includes(filter.search)) return false;
  }
  return true;
}

function attachmentComparator(sort) {
  switch (sort) {
    case "size-asc":
      return (a, b) => a.bytes - b.bytes || a.id - b.id;
    case "date-desc":
      return (a, b) => attachmentTime(b) - attachmentTime(a) || b.bytes - a.bytes;
    case "date-asc":
      return (a, b) => attachmentTime(a) - attachmentTime(b) || a.bytes - b.bytes;
    case "size-desc":
    default:
      return (a, b) => b.bytes - a.bytes || a.id - b.id;
  }
}

function applyAttachmentFilters() {
  const filter = attachmentFilter;
  const base = allAttachments.filter((attachment) =>
    attachmentPassesNonType(attachment, filter)
  );
  const counts = new Map();
  for (const attachment of base) {
    const category = attachmentCategory(
      attachment.context ? attachment.context.contentType : null
    );
    counts.set(category, (counts.get(category) || 0) + 1);
  }
  const filtered = filter.types.size
    ? base.filter((attachment) => {
        const category = attachmentCategory(
          attachment.context ? attachment.context.contentType : null
        );
        const inSet = filter.types.has(category);
        return filter.typeMode === "include" ? inSet : !inSet;
      })
    : base;
  filtered.sort(attachmentComparator(filter.sort));
  attachmentFiltered = filtered;
  attachmentPage = 1;
  renderAttachmentTypeChips(counts);
  renderAttachmentPage();
  updateAttachmentExportButton();
}

function renderAttachmentTypeChips(counts) {
  const container = elements.attachmentTypeChips;
  container.replaceChildren();
  for (const category of ATTACHMENT_CATEGORY_ORDER) {
    const count = counts.get(category) || 0;
    if (!count) continue;
    const chip = document.createElement("button");
    chip.type = "button";
    const active = attachmentFilter.types.has(category);
    chip.className = `attachment-chip${active ? " active" : ""}`;
    chip.setAttribute("aria-pressed", String(active));
    chip.textContent = `${ATTACHMENT_CATEGORY_LABELS[category]}（${count.toLocaleString()}）`;
    chip.addEventListener("click", () => {
      if (attachmentFilter.types.has(category)) attachmentFilter.types.delete(category);
      else attachmentFilter.types.add(category);
      applyAttachmentFilters();
    });
    container.append(chip);
  }
}

async function previewAttachment(attachment, trigger) {
  if (!provider) return;
  try {
    const url = await bridge.attachmentPreviewUrl(attachment.path);
    if (!url) {
      setStatus("無法預覽這個附件。", true);
      return;
    }
    showImageModal(url, attachmentBasename(attachment.path), trigger || null);
  } catch (error) {
    setStatus(`預覽失敗：${error.message}`, true);
  }
}

function renderAttachmentRow(attachment) {
  const row = document.createElement("div");
  row.className = "attachment-row";
  row.setAttribute("role", "listitem");
  const category = attachmentCategory(
    attachment.context ? attachment.context.contentType : null
  );
  const type = document.createElement("span");
  type.className = `attachment-type type-${category}`;
  type.textContent = ATTACHMENT_CATEGORY_LABELS[category];
  const main = document.createElement("span");
  main.className = "attachment-main";
  const name = document.createElement("span");
  name.className = "attachment-name";
  name.textContent = attachmentBasename(attachment.path);
  name.title = attachment.path;
  const sub = document.createElement("span");
  sub.className = "attachment-sub";
  const chat = attachment.context
    ? attachment.context.chatTitle || attachment.chatHint || "（未命名聊天室）"
    : "（未引用）";
  sub.textContent = attachment.kind === "thumbnail" ? `${chat} · 縮圖` : chat;
  main.append(name, sub);
  const size = document.createElement("span");
  size.className = "attachment-size";
  size.textContent = formatBytes(attachment.bytes);
  const date = document.createElement("span");
  date.className = "attachment-date";
  date.textContent = formatTimestamp(attachmentTime(attachment));
  row.append(type, main, size, date);
  if (category === "image" && selectedSourceKind !== "sqlite") {
    row.classList.add("previewable");
    row.tabIndex = 0;
    row.title = "點擊預覽圖片";
    row.addEventListener("click", () => void previewAttachment(attachment, row));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        void previewAttachment(attachment, row);
      }
    });
  }
  return row;
}

function renderAttachmentPage() {
  const total = attachmentFiltered.length;
  const totalBytes = attachmentFiltered.reduce((sum, item) => sum + item.bytes, 0);
  const pages = Math.max(1, Math.ceil(total / ATTACHMENT_PAGE_SIZE));
  if (attachmentPage > pages) attachmentPage = pages;
  const start = (attachmentPage - 1) * ATTACHMENT_PAGE_SIZE;
  const slice = attachmentFiltered.slice(start, start + ATTACHMENT_PAGE_SIZE);
  if (!slice.length) {
    elements.attachmentList.replaceChildren(emptyState("沒有符合篩選條件的附件。"));
  } else {
    replaceChildren(elements.attachmentList, slice, renderAttachmentRow);
  }
  elements.attachmentPageInfo.textContent = `第 ${attachmentPage} / ${pages} 頁`;
  elements.attachmentPrevious.disabled = attachmentPage <= 1;
  elements.attachmentNext.disabled = attachmentPage >= pages;
  elements.attachmentSummary.classList.remove("error");
  elements.attachmentSummary.textContent =
    `${total.toLocaleString()} 個附件 · 合計 ${formatBytes(totalBytes)}`;
}

function updateAttachmentExportButton() {
  elements.exportFilteredAttachments.disabled =
    !provider ||
    selectedSourceKind === "sqlite" ||
    exportInProgress ||
    attachmentFiltered.length === 0;
}

function changeAttachmentPage(delta) {
  const pages = Math.max(1, Math.ceil(attachmentFiltered.length / ATTACHMENT_PAGE_SIZE));
  const next = Math.min(pages, Math.max(1, attachmentPage + delta));
  if (next === attachmentPage) return;
  attachmentPage = next;
  renderAttachmentPage();
}

async function exportFilteredAttachmentsAction() {
  if (!provider) {
    setStatus("請先開啟備份。", true);
    return;
  }
  if (selectedSourceKind === "sqlite") {
    setStatus("直接 Line.sqlite 來源沒有可匯出的附件檔案。", true);
    return;
  }
  if (!attachmentFiltered.length) return;
  const filter = attachmentFilter;
  const selectedTypes = [...filter.types];
  const includeCategories = filter.typeMode === "include" ? selectedTypes : [];
  const excludeCategories = filter.typeMode === "exclude" ? selectedTypes : [];
  const selectedChats = [...filter.chats];
  const includeChats = filter.chatMode === "include" ? selectedChats : [];
  const excludeChats = filter.chatMode === "exclude" ? selectedChats : [];
  const output = await bridge.chooseExportOutput();
  if (!output) return;
  try {
    const result = await runExportJob({
      title: "正在匯出附件",
      message: "正在依照目前的排序與篩選，將附件串流複製到新的匯出資料夾。",
      successMessage: "附件匯出完成。"
    }, () => provider.exportAttachmentsFiltered({
      output: output.token,
      kind: filter.includeThumbnails ? null : "original",
      search: filter.search || null,
      includeChats,
      excludeChats,
      includeCategories,
      excludeCategories,
      includeThumbnails: filter.includeThumbnails
    }));
    const skipped = Number(result.skippedFiles) || 0;
    const detail = skipped
      ? `已匯出 ${Number(result.exportedFiles || 0).toLocaleString()} 個檔案，略過 ${skipped.toLocaleString()} 個。`
      : `已匯出 ${Number(result.exportedFiles || 0).toLocaleString()} 個檔案。`;
    setStatus(`${detail} 位置：${result.outputName || output.displayName}`, false);
  } catch (error) {
    reportCleanupMutationError(error);
  } finally {
    updateAttachmentExportButton();
  }
}

function handleAttachmentSearchInput() {
  if (attachmentSearchDebounce) clearTimeout(attachmentSearchDebounce);
  attachmentSearchDebounce = setTimeout(() => {
    attachmentSearchDebounce = null;
    attachmentFilter.search = elements.attachmentSearch.value.trim().toLowerCase();
    applyAttachmentFilters();
  }, 200);
}

async function selectChat(chat) {
  const selectionGeneration = ++selectedChatGeneration;
  selectedChat = chat;
  selectedChatPk = chat.pk;
  activeSearch = null;
  elements.searchQuery.value = "";
  messageCursor = messageBeforeCursor = null;
  messagePageNumber = 1;
  elements.selectedChatTitle.textContent = chat.title;
  elements.selectedChatMeta.textContent =
    `${chatKindLabel(chat.kind)} · ${chat.humanMessageCount.toLocaleString()} 則人類訊息 · 名稱來源：${titleSourceLabel(chat.titleSource)}`;
  for (const item of elements.chats.querySelectorAll(".chat-item")) {
    const selected = item.dataset.chatPk === String(chat.pk) &&
      item.dataset.chatSource === (chat.source || "line");
    item.classList.toggle("selected", selected);
    item.setAttribute("aria-selected", String(selected));
  }
  elements.messages.replaceChildren(emptyState("正在讀取訊息…"));
  elements.messageStatus.textContent = "正在讀取訊息…";
  setRetryVisible(elements.retryMessages, false);
  elements.clearSearch.disabled = true;
  elements.previousMessages.disabled = true;
  elements.nextMessages.disabled = true;
  elements.exportChatImages.disabled = !selectedChat || selectedSourceKind === "sqlite";
  elements.exportChatAttachments.disabled = !selectedChat || selectedSourceKind === "sqlite";
  elements.exportChatConversation.disabled = !selectedChat;
  await loadMessages("initial", selectionGeneration);
}

async function loadMessages(direction = "initial", requestedSelectionGeneration = selectedChatGeneration) {
  if (!provider || (messageLoading && direction !== "initial")) return;
  if (selectedChatPk === null || !selectedChat) return;
  const currentProvider = provider;
  const currentSourceGeneration = sourceGeneration;
  const currentChat = selectedChat;
  const currentChatPk = selectedChatPk;
  const currentSearch = activeSearch;
  const requestGeneration = ++messageRequestGeneration;
  messageLoading = true;
  messageRetryDirection = direction;
  const cursor = direction === "next" ? messageCursor : null;
  const beforeCursor = direction === "previous" ? messageBeforeCursor : null;
  let succeeded = false;
  setMessagePanelBusy(true);
  elements.messageStatus.textContent = currentSearch
    ? `正在搜尋「${currentSearch}」…`
    : "正在讀取訊息…";
  setRetryVisible(elements.retryMessages, false);
  try {
    const page = currentSearch
      ? await currentProvider.searchMessages(currentSearch, {
        chatPk: currentChatPk,
        source: currentChat.source || "line",
        limit: 180,
        cursor,
        beforeCursor
      })
      : await currentProvider.listMessages(currentChatPk, {
        source: currentChat.source || "line",
        limit: 180,
        cursor,
        beforeCursor
      });
    if (requestGeneration !== messageRequestGeneration ||
        requestedSelectionGeneration !== selectedChatGeneration ||
        currentSourceGeneration !== sourceGeneration ||
        currentProvider !== provider ||
        currentChat !== selectedChat ||
        currentChatPk !== selectedChatPk ||
        currentSearch !== activeSearch) return;
    renderMessagePage(page, direction);
    elements.messageStatus.classList.remove("error");
    setRetryVisible(elements.retryMessages, false);
    succeeded = true;
  } catch (error) {
    if (requestGeneration !== messageRequestGeneration ||
        requestedSelectionGeneration !== selectedChatGeneration ||
        currentSourceGeneration !== sourceGeneration ||
        currentProvider !== provider ||
        currentChat !== selectedChat ||
        currentChatPk !== selectedChatPk ||
        currentSearch !== activeSearch) return;
    setStatus(`訊息載入失敗：${error.message}`, true);
    renderMessageLoadError();
  } finally {
    if (requestGeneration === messageRequestGeneration) {
      messageLoading = false;
      elements.messages.removeAttribute("aria-busy");
      if (succeeded) {
        setMessagePanelBusy(false);
      } else {
        elements.previousMessages.disabled = true;
        elements.nextMessages.disabled = true;
        elements.searchButton.disabled = !selectedChat;
      }
    }
  }
}

function renderMessagePage(page, direction = "initial") {
  const renderGeneration = ++messageRenderGeneration;
  replaceChildren(elements.messages, page.items, renderMessage);
  if (!page.items.length) {
    if (direction === "initial") elements.messages.append(emptyState("這個聊天室沒有可顯示的訊息。"));
  } else {
    void hydrateMessagePreviews(elements.messages, renderGeneration);
  }
  messageBeforeCursor = page.items.length ? messageCursorFor(page.items[0]) : null;
  messageCursor = page.nextCursor;
  if (direction === "previous") messagePageNumber = Math.max(1, messagePageNumber - 1);
  else if (direction === "next") messagePageNumber += 1;
  else messagePageNumber = 1;
  elements.messageStatus.textContent = page.items.length
    ? `${activeSearch ? `搜尋「${activeSearch}」 · ` : ""}` +
      `第 ${messagePageNumber} 頁 · 本頁顯示 ${page.items.length.toLocaleString()} 則訊息`
    : "";
  elements.previousMessages.disabled = !page.hasPrevious;
  elements.nextMessages.disabled = !messageCursor;
  elements.searchButton.disabled = false;
  elements.clearSearch.disabled = !activeSearch;
  setRetryVisible(elements.retryMessages, false);
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
    return url.href;
  } catch (_error) {
    return "";
  }
}

function trimUrlMatch(value) {
  let trimmed = String(value || "");
  while (/[.,!?;:，。！？；：、》】」』]$/.test(trimmed)) trimmed = trimmed.slice(0, -1);
  for (const [opening, closing] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
    while (trimmed.endsWith(closing) &&
           trimmed.split(opening).length < trimmed.split(closing).length) {
      trimmed = trimmed.slice(0, -1);
    }
  }
  return trimmed;
}

function findHttpUrls(text) {
  const source = String(text || "");
  const pattern = /https?:\/\/[^\s<>"']+/gi;
  const matches = [];
  const seen = new Set();
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const raw = trimUrlMatch(match[0]);
    const href = safeHttpUrl(raw);
    if (!href) continue;
    const key = href.replace(/#.*$/, "");
    matches.push({
      href,
      start: match.index,
      end: match.index + raw.length,
      duplicate: seen.has(key)
    });
    seen.add(key);
  }
  return matches;
}

function bindExternalLink(link, href) {
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.referrerPolicy = "no-referrer";
  link.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void bridge.openExternal(href).catch((error) => setStatus(error.message, true));
  });
}

function appendLinkedText(container, text) {
  const source = String(text || "");
  const matches = findHttpUrls(source);
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) {
      container.append(document.createTextNode(source.slice(cursor, match.start)));
    }
    const link = document.createElement("a");
    link.textContent = source.slice(match.start, match.end);
    bindExternalLink(link, match.href);
    container.append(link);
    cursor = match.end;
  }
  if (cursor < source.length) container.append(document.createTextNode(source.slice(cursor)));
}

function linkPreviewFor(href) {
  const url = new URL(href);
  const domain = url.hostname.replace(/^www\./i, "") || "連結";
  const youtube = /^(?:www\.|m\.)?youtube\.com$/i.test(url.hostname) ||
    /^youtu\.be$/i.test(url.hostname);
  return {
    url: href,
    domain,
    title: youtube ? "YouTube 影片" : domain,
    summary: href
  };
}

function appendLinkPreviews(card, text) {
  const matches = findHttpUrls(text).filter((match) => !match.duplicate).slice(0, 4);
  if (!matches.length) return;
  const list = document.createElement("div");
  list.className = "link-previews";
  for (const match of matches) {
    const data = linkPreviewFor(match.href);
    const preview = document.createElement("a");
    preview.className = "link-preview";
    preview.setAttribute("aria-label", `在瀏覽器開啟：${data.title}`);
    bindExternalLink(preview, data.url);
    const content = document.createElement("span");
    content.className = "link-preview-content";
    const domain = document.createElement("span");
    domain.className = "link-preview-domain";
    domain.textContent = data.domain;
    const title = document.createElement("strong");
    title.className = "link-preview-title";
    title.textContent = data.title;
    const summary = document.createElement("span");
    summary.className = "link-preview-summary";
    summary.textContent = data.summary;
    const icon = document.createElement("span");
    icon.className = "link-preview-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "↗";
    content.append(domain, title, summary);
    preview.append(content, icon);
    list.append(preview);
  }
  card.append(list);
}

function renderMessage(message) {
  const stickerId = legacyStickerId(message);
  const system = isSystemMessage(message);
  const self = !system && isSelfMessage(message);
  const row = document.createElement("article");
  row.className = `message-row${system ? " system" : (self ? " self" : "")}`;
  if (!self && !system) row.append(messageAvatar(message));
  const card = document.createElement("div");
  card.className = "message-card";
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const sender = document.createElement("span");
  sender.className = "message-sender";
  sender.textContent = self ? "我" : (system ? "系統" : (message.senderName || "未知使用者"));
  const time = document.createElement("time");
  time.textContent = formatTimestamp(message.timestamp);
  meta.append(sender, time);
  card.append(meta);

  if (message.text) {
    const body = document.createElement("p");
    body.className = "message-text";
    appendLinkedText(body, message.text);
    card.append(body);
    appendLinkPreviews(card, message.text);
  } else if (!stickerId) {
    const kind = document.createElement("p");
    kind.className = "message-kind";
    kind.textContent = `[${messageContentLabel(message)}]`;
    card.append(kind);
  }
  if (stickerId) {
    const sticker = document.createElement("figure");
    sticker.className = "message-sticker";
    const image = document.createElement("img");
    image.src = lineStickerUrl(stickerId);
    image.alt = `LINE 貼圖 ${stickerId}`;
    image.loading = "lazy";
    image.decoding = "async";
    image.addEventListener("error", () => sticker.remove(), { once: true });
    sticker.append(image);
    card.append(sticker);
  }
  if (!stickerId && Number.isFinite(message.latitude) && Number.isFinite(message.longitude) &&
      (message.latitude !== 0 || message.longitude !== 0)) {
    const coordinates = document.createElement("p");
    coordinates.className = "message-coordinates";
    coordinates.textContent = `位置：${message.latitude}, ${message.longitude}`;
    card.append(coordinates);
  }

  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const originals = attachments.filter((attachment) => attachment.kind === "original");
  const thumbnails = attachments.filter((attachment) => attachment.kind === "thumbnail");
  const previewPaths = originals.concat(thumbnails).map((attachment) => attachment.path);
  if (previewPaths.length && isImageContent(message.contentType, previewPaths)) {
    const media = document.createElement("div");
    media.className = "message-media";
    media.previewPaths = previewPaths.slice(0, 8);
    media.previewCaption = fileName(previewPaths[0]);
    const placeholder = document.createElement("span");
    placeholder.className = "muted small";
    placeholder.textContent = "載入圖片…";
    media.append(placeholder);
    card.append(media);
  }
  if (attachments.length) {
    const attachmentActions = document.createElement("div");
    attachmentActions.className = "message-attachment-actions";
    const imagePaths = attachments.map((attachment) => attachment.path);
    const exportImages = document.createElement("button");
    exportImages.type = "button";
    exportImages.className = "secondary-button compact-button";
    exportImages.textContent = "匯出圖檔";
    exportImages.addEventListener("click", () => {
      void exportAttachmentSelection(imagePaths, {
        imagesOnly: true,
        includeThumbnails: true
      });
    });
    const exportAttachments = document.createElement("button");
    exportAttachments.type = "button";
    exportAttachments.className = "secondary-button compact-button";
    exportAttachments.textContent = "匯出本則附件";
    exportAttachments.addEventListener("click", () => {
      void exportAttachmentSelection(attachments.map((attachment) => attachment.path), {
        imagesOnly: false,
        includeThumbnails: true
      });
    });
    attachmentActions.append(exportImages, exportAttachments);
    card.append(attachmentActions);
    const list = document.createElement("ul");
    list.className = "message-attachments";
    for (const attachment of attachments) {
      const item = document.createElement("li");
      item.textContent = fileName(attachment.path);
      const detail = document.createElement("span");
      detail.textContent =
        ` · ${attachment.kind === "thumbnail" ? "縮圖" : "原始附件"} · ${formatBytes(attachment.bytes)}`;
      item.append(detail);
      list.append(item);
    }
    card.append(list);
  }
  row.append(card);
  return row;
}

function messageAvatar(message) {
  const name = String(message.senderName || "未知使用者").trim();
  const avatar = document.createElement("span");
  avatar.className = "message-avatar";
  avatar.setAttribute("aria-hidden", "true");
  const fallback = document.createElement("span");
  fallback.className = "message-avatar-fallback";
  fallback.textContent = Array.from(name)[0] || "?";
  avatar.append(fallback);
  const url = lineAvatarUrl(message.avatarUrl);
  if (!url) return avatar;
  const image = document.createElement("img");
  image.className = "message-avatar-image";
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";
  image.referrerPolicy = "no-referrer";
  image.addEventListener("error", () => image.remove(), { once: true });
  image.src = url;
  avatar.append(image);
  return avatar;
}

function lineAvatarUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "https:" || url.username || url.password) return "";
    if (!["profile.line-scdn.net", "obs.line-scdn.net"].includes(url.hostname)) return "";
    return url.href;
  } catch (_error) {
    return "";
  }
}

function hydrateMessagePreview(media, renderGeneration) {
  if (!Array.isArray(media.previewPaths) || !media.previewPaths.length ||
      media.dataset.previewState) return Promise.resolve();
  media.dataset.previewState = "loading";
  return (async () => {
    let url = null;
    let caption = media.previewCaption;
    for (const path of media.previewPaths) {
      try {
        url = await bridge.attachmentPreviewUrl(path);
        caption = fileName(path);
        if (url) break;
      } catch (_error) {
        // Unsupported originals fall back to the matching thumbnail.
      }
    }
    if (!url || renderGeneration !== messageRenderGeneration || !media.isConnected) {
      media.dataset.previewState = "failed";
      return;
    }
    const figure = document.createElement("figure");
    figure.className = "message-image";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "message-image-button";
    button.setAttribute("aria-label", `放大預覽：${caption}`);
    const image = document.createElement("img");
    image.alt = caption;
    image.loading = "lazy";
    image.decoding = "async";
    image.addEventListener("error", () => {
      figure.classList.add("preview-error");
      media.dataset.previewState = "failed";
    }, { once: true });
    button.addEventListener("click", () => showImageModal(url, caption, button));
    button.append(image);
    const note = document.createElement("figcaption");
    note.textContent = "開啟圖片預覽";
    figure.append(button, note);
    media.dataset.previewState = "loaded";
    media.replaceChildren(figure);
    image.src = url;
  })();
}

function hydrateMessagePreviews(container, renderGeneration) {
  if (container.messagePreviewObserver) container.messagePreviewObserver.disconnect();
  const mediaItems = Array.from(container.querySelectorAll(".message-media"))
    .filter((media) => Array.isArray(media.previewPaths) && media.previewPaths.length);
  const queue = [];
  let active = 0;
  const pump = () => {
    while (active < 4 && queue.length) {
      const media = queue.shift();
      active += 1;
      void hydrateMessagePreview(media, renderGeneration).finally(() => {
        active -= 1;
        pump();
      });
    }
  };
  const enqueue = (media) => {
    if (!media || media.dataset.previewState) return;
    queue.push(media);
    pump();
  };
  if (typeof IntersectionObserver !== "function") {
    for (const media of mediaItems) enqueue(media);
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      enqueue(entry.target);
    }
  }, { root: elements.messages, rootMargin: "480px 0px" });
  container.messagePreviewObserver = observer;
  for (const media of mediaItems) observer.observe(media);
}

function isSystemMessage(message) {
  const contentType = Number(message.contentType);
  return !legacyStickerId(message) && (
    [7, 18, 96, 111].includes(contentType) ||
    (message.senderPk == null && Number(message.sendStatus) === 0 && !message.id)
  );
}

function legacyStickerId(message) {
  if (Number(message.contentType) !== 7 || Number(message.latitude) !== 0) return null;
  const stickerId = Number(message.longitude);
  return Number.isSafeInteger(stickerId) && stickerId > 0 ? stickerId : null;
}

function lineStickerUrl(stickerId) {
  return `https://stickershop.line-scdn.net/stickershop/v1/sticker/${stickerId}/iPhone/sticker_animation@2x.png`;
}

function isSelfMessage(message) {
  if (typeof message.isSelf === "boolean") return message.isSelf;
  const hasSender = message.senderPk !== null && message.senderPk !== undefined;
  return !hasSender && (
    Number(message.sendStatus) === 1 ||
    String(message.messageType || "").toUpperCase() === "S"
  );
}

function isImageContent(contentType, paths) {
  return [1, 16, 112].includes(Number(contentType)) ||
    paths.some((path) => /\.(?:jpe?g|png|gif|webp|bmp|avif|heic|thumb)$/i.test(path));
}

function messageContentLabel(message) {
  const contentType = Number(message.contentType);
  return {
    1: "照片",
    2: "影片",
    3: "語音",
    4: "檔案",
    5: "貼圖",
    7: legacyStickerId(message) ? "貼圖" : "系統訊息",
    14: "檔案",
    16: "照片",
    17: "影片",
    18: "系統訊息",
    100: "位置",
    101: "貼圖",
    107: "連結",
    111: "系統訊息",
    112: "照片"
  }[contentType] || "附件";
}

function chatKindLabel(kind) {
  return {
    direct: "個人聊天室",
    group: "群組聊天室",
    community: "社群"
  }[kind] || "聊天室";
}

function titleSourceLabel(source) {
  return {
    user: "聯絡人",
    group: "群組資料",
    chat: "聊天室資料",
    rename: "群組改名訊息",
    "unified-group": "UnifiedGroup.sqlite",
    "line-square": "LineSquare.sqlite",
    id: "原始 ID",
    unresolved: "尚未解析"
  }[source] || source || "尚未解析";
}

function duplicateHashLabel(value) {
  const hash = String(value || "");
  return hash.length > 18 ? `${hash.slice(0, 10)}…${hash.slice(-8)}` : hash;
}

function renderDuplicateMembers(container, sha256, members) {
  const list = document.createElement("div");
  list.className = "duplicate-member-list";
  for (const member of members) {
    const choice = document.createElement("label");
    choice.className = "duplicate-member";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = member.markedForRemoval;
    checkbox.dataset.duplicateSha = sha256;
    checkbox.dataset.attachmentPath = member.path;
    checkbox.setAttribute("aria-label", `標記刪除：${fileName(member.path)}`);
    const text = document.createElement("span");
    text.className = "duplicate-member-text";
    const name = document.createElement("strong");
    name.textContent = fileName(member.path);
    const detail = document.createElement("small");
    detail.textContent = `${member.kind === "thumbnail" ? "縮圖" : "原始附件"} · ${formatBytes(member.bytes)} · ${member.referenceStatus}`;
    const context = document.createElement("small");
    context.textContent = member.context
      ? `${member.context.chatTitle || "未命名聊天室"} · ${member.context.senderName || "未知傳送者"} · ${formatTimestamp(member.context.timestamp)}`
      : member.referenceStatus === "unreferenced"
        ? "目前 SQLite 沒有引用這個路徑"
        : "無法確認對應聊天室與訊息";
    text.append(name, detail, context);
    const path = document.createElement("code");
    path.textContent = member.path;
    choice.append(checkbox, text, path);
    list.append(choice);
  }
  container.replaceChildren(list);
}

async function loadDuplicateMembers(sha256, container) {
  if (!provider || !advancedMode || !container) return;
  container.replaceChildren(emptyState("正在載入重複檔案…"));
  try {
    const page = await provider.listDuplicateMembers(sha256, { limit: 1000 });
    const members = page.items;
    duplicateMembers.set(sha256, members);
    renderDuplicateMembers(container, sha256, members);
    if (page.nextCursor) {
      const note = document.createElement("p");
      note.className = "muted small";
      note.textContent = "這一組檔案超過單次顯示上限，請先確認目前列出的副本。";
      container.append(note);
    }
  } catch (error) {
    container.replaceChildren(emptyState(`無法載入重複檔案：${error.message}`));
    setStatus(error.message, true);
  }
}

function renderDuplicateGroup(group) {
  const card = document.createElement("article");
  card.className = "duplicate-group-card";
  const body = document.createElement("div");
  body.className = "duplicate-group-body";
  const preview = document.createElement("button");
  preview.type = "button";
  preview.className = "duplicate-preview";
  preview.disabled = true;
  preview.previewPath = group.previewPath || "";
  const previewFallback = document.createElement("span");
  previewFallback.className = "duplicate-preview-fallback";
  previewFallback.textContent = group.previewPath ? "載入預覽…" : "沒有預覽";
  preview.append(previewFallback);
  const content = document.createElement("div");
  content.className = "duplicate-group-content";
  const header = document.createElement("div");
  header.className = "duplicate-group-header";
  const title = document.createElement("div");
  title.className = "duplicate-group-title";
  const heading = document.createElement("strong");
  heading.textContent = group.previewPath ? fileName(group.previewPath) : "相同附件";
  heading.title = group.previewPath || group.sha256;
  const summary = document.createElement("span");
  summary.textContent = `${group.fileCount.toLocaleString()} 份 · 每份 ${formatBytes(group.bytes)} · 理論可合併 ${formatBytes(group.reclaimableBytes)}`;
  title.append(heading, summary);
  const expand = document.createElement("button");
  expand.type = "button";
  expand.className = "duplicate-expand";
  expand.dataset.duplicateExpand = group.sha256;
  expand.textContent = duplicateExpandedSha === group.sha256 ? "收合檔案" : "查看檔案";
  expand.setAttribute("aria-expanded", String(duplicateExpandedSha === group.sha256));
  header.append(title, expand);
  content.append(header);
  const impact = document.createElement("p");
  impact.className = "duplicate-group-impact";
  impact.textContent = Boolean(group.hasOriginal) && Boolean(group.hasThumbnail)
    ? "這組同時包含原始附件與縮圖；已標記刪除的檔案會先排除，其餘副本才會建立連結。"
    : "可直接標記不需要的附件；其餘副本會保留原路徑並連到同組的一個實體檔案。";
  content.append(impact);
  if (duplicateExpandedSha === group.sha256) {
    const members = document.createElement("div");
    members.className = "duplicate-members";
    content.append(members);
    if (duplicateMembers.has(group.sha256)) {
      renderDuplicateMembers(members, group.sha256, duplicateMembers.get(group.sha256));
    } else {
      void loadDuplicateMembers(group.sha256, members);
    }
  }
  body.append(preview, content);
  card.append(body);
  return card;
}

async function hydrateDuplicatePreviews(container, renderGeneration) {
  const previews = Array.from(container.querySelectorAll(".duplicate-preview"))
    .filter((preview) => preview.previewPath);
  let next = 0;
  async function worker() {
    while (next < previews.length) {
      const preview = previews[next++];
      const path = preview.previewPath;
      let url = null;
      try {
        url = await bridge.attachmentPreviewUrl(path);
      } catch (_error) {
        // Non-image duplicates keep a clear fallback instead of failing the group.
      }
      if (renderGeneration !== duplicatePreviewGeneration || !preview.isConnected) continue;
      if (!url) {
        preview.replaceChildren(Object.assign(document.createElement("span"), {
          className: "duplicate-preview-fallback",
          textContent: "無影像預覽"
        }));
        continue;
      }
      const caption = fileName(path);
      const image = document.createElement("img");
      image.alt = caption;
      image.loading = "lazy";
      image.decoding = "async";
      image.addEventListener("error", () => {
        preview.disabled = true;
        preview.replaceChildren(Object.assign(document.createElement("span"), {
          className: "duplicate-preview-fallback",
          textContent: "預覽失敗"
        }));
      }, { once: true });
      preview.disabled = false;
      preview.setAttribute("aria-label", `放大預覽：${caption}`);
      preview.addEventListener("click", () => showImageModal(url, caption, preview));
      preview.replaceChildren(image);
      image.src = url;
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, previews.length) }, () => worker()));
}

function renderDuplicateAutoMergeControl() {
  elements.duplicateAutoMerge.disabled =
    !advancedMode || !duplicateScanComplete || duplicateLoading;
  elements.duplicateAutoMerge.textContent = duplicateAutoMergeEnabled
    ? "取消全部自動合併"
    : "全部自動合併";
  elements.duplicateAutoMerge.setAttribute(
    "aria-pressed",
    String(duplicateAutoMergeEnabled)
  );
}

function setDuplicateAutoMerge(enabled) {
  duplicateAutoMergeEnabled = Boolean(enabled) && advancedMode && duplicateScanComplete;
  renderDuplicateAutoMergeControl();
}

function toggleDuplicateAutoMerge() {
  if (elements.duplicateAutoMerge.disabled) return;
  setDuplicateAutoMerge(!duplicateAutoMergeEnabled);
  setStatus(
    duplicateAutoMergeEnabled
      ? "已選擇全部自動合併；建立候選檔時會先排除已標記刪除的附件。"
      : "已取消全部自動合併；建立候選檔時不會寫入重複附件連結。",
    false
  );
}

function renderDuplicatePage(page) {
  duplicatePage = page;
  const previewGeneration = ++duplicatePreviewGeneration;
  elements.duplicateGroups.replaceChildren();
  if (!page.items.length) {
    elements.duplicateGroups.append(emptyState("沒有找到完全相同的附件。"));
  } else {
    const list = document.createElement("div");
    list.className = "duplicate-group-list";
    for (const group of page.items) list.append(renderDuplicateGroup(group));
    elements.duplicateGroups.append(list);
    void hydrateDuplicatePreviews(elements.duplicateGroups, previewGeneration);
  }
  elements.duplicateSummary.classList.remove("hidden");
  const hashed = duplicateHashResult
    ? `本次檢查 ${duplicateHashResult.processedFiles.toLocaleString()} / ${duplicateHashResult.candidateFiles.toLocaleString()} 個候選檔案`
    : "已完成雜湊掃描";
  elements.duplicateSummary.textContent =
    `${hashed} · 本頁 ${page.items.length.toLocaleString()} 組 · 理論容量以每組保留一個實體檔案估算`;
  elements.duplicatePageInfo.textContent = `第 ${duplicatePageNumber} 頁`;
  elements.duplicatePrev.disabled = duplicateLoading || duplicatePageNumber <= 1;
  elements.duplicateNext.disabled = duplicateLoading || !page.nextCursor;
}

async function loadDuplicateGroups(pageNumber = duplicatePageNumber) {
  if (!provider || !advancedMode || duplicateLoading || !duplicateScanComplete) return;
  const cursor = duplicatePageCursors[pageNumber - 1] || null;
  duplicateLoading = true;
  elements.hashDuplicates.disabled = true;
  elements.duplicatePrev.disabled = true;
  elements.duplicateNext.disabled = true;
  try {
    const page = await provider.listDuplicateGroups({ limit: 12, cursor });
    duplicatePageNumber = pageNumber;
    if (page.nextCursor) duplicatePageCursors[pageNumber] = page.nextCursor;
    else duplicatePageCursors.length = pageNumber + 1;
    renderDuplicatePage(page);
  } catch (error) {
    setStatus(error.message, true);
    elements.duplicateGroups.replaceChildren(emptyState(`無法載入重複附件：${error.message}`));
  } finally {
    duplicateLoading = false;
    elements.hashDuplicates.disabled = selectedSourceKind === "sqlite";
    renderDuplicateAutoMergeControl();
    if (duplicatePage) {
      elements.duplicatePrev.disabled = duplicatePageNumber <= 1;
      elements.duplicateNext.disabled = !duplicatePage.nextCursor;
    }
  }
}

async function hashDuplicates() {
  if (!provider || !advancedMode || duplicateLoading || selectedSourceKind === "sqlite") return;
  duplicateLoading = true;
  duplicateScanComplete = false;
  duplicateHashResult = null;
  duplicateMembers.clear();
  duplicatePage = null;
  duplicatePageNumber = 1;
  duplicatePageCursors = [null];
  duplicateExpandedSha = null;
  setDuplicateAutoMerge(false);
  elements.hashDuplicates.disabled = true;
  elements.cancelDuplicateScan.classList.remove("hidden");
  elements.cancelDuplicateScan.disabled = false;
  elements.cancelDuplicateScan.textContent = "取消掃描";
  elements.duplicatePrev.disabled = true;
  elements.duplicateNext.disabled = true;
  elements.duplicateProgressLabel.textContent = "正在計算 SHA-256…";
  elements.duplicateGroups.replaceChildren(emptyState("正在比對檔案內容…"));
  try {
    duplicateHashResult = await provider.hashDuplicateCandidates();
    duplicateScanComplete = true;
    elements.duplicateProgressLabel.textContent = "雜湊完成";
    duplicateLoading = false;
    await loadDuplicateGroups();
    setStatus("完全相同附件掃描完成，請逐組審核。", false);
  } catch (error) {
    if (isOperationCancelled(error)) {
      elements.duplicateProgressLabel.textContent = "掃描已取消，部分雜湊已清除";
      elements.duplicateGroups.replaceChildren(emptyState("掃描已取消；請重新掃描以取得完整結果。"));
      setDuplicateAutoMerge(false);
      setStatus("已取消重複附件掃描。", false);
      return;
    }
    elements.duplicateProgressLabel.textContent = "掃描失敗";
    elements.duplicateGroups.replaceChildren(emptyState(`掃描失敗：${error.message}`));
    setDuplicateAutoMerge(false);
    setStatus(error.message, true);
  } finally {
    duplicateLoading = false;
    elements.hashDuplicates.disabled = selectedSourceKind === "sqlite";
    elements.cancelDuplicateScan.classList.add("hidden");
  }
}

async function changeDuplicateMark(checkbox) {
  const sha256 = checkbox.dataset.duplicateSha;
  const path = checkbox.dataset.attachmentPath;
  const members = duplicateMembers.get(sha256) || [];
  checkbox.disabled = true;
  try {
    await runCleanupMutation({
      title: checkbox.checked ? "正在標記重複副本" : "正在取消重複副本標記",
      message: "正在寫入附件清理狀態，請勿重複操作。",
      successMessage: checkbox.checked ? "重複副本已加入清理計畫。" : "重複副本已從清理計畫移除。"
    }, async () => {
      await provider.setAttachmentMarked(path, checkbox.checked);
      const member = members.find((item) => item.path === path);
      if (member) member.markedForRemoval = checkbox.checked;
      cleanupOverview = null;
      invalidateCleanupInsights();
      await loadDuplicateGroups(duplicatePageNumber);
    });
    setStatus(checkbox.checked ? "已標記重複副本。" : "已取消標記重複副本。", false);
  } catch (error) {
    checkbox.checked = !checkbox.checked;
    reportCleanupMutationError(error);
  } finally {
    checkbox.disabled = false;
  }
}

async function scanCatalog(options) {
  options = options || {};
  const ownsModal = elements.loadModal.classList.contains("hidden");
  if (ownsModal) {
    showLoadModal("正在建立磁碟附件索引…");
    updateLoadModalProgress(18);
    await waitForUiPaint();
  }
  try {
    setStatus("正在建立磁碟附件索引…");
    elements.scanCatalog.disabled = true;
    elements.planSafeAttachmentCleanup.disabled = true;
    elements.clearManualAttachmentPlan.disabled = true;
    setCandidateBuildDisabled(true);
    const stats = await provider.scanCatalog();
    elements.progress.max = 1;
    elements.progress.value = 1;
    elements.catalogSummary.textContent =
      `${stats.attachmentCount.toLocaleString()} 個附件，${formatBytes(stats.attachmentBytes)}`;
    duplicateLoading = false;
    duplicateScanComplete = false;
    duplicateHashResult = null;
    duplicatePage = null;
    duplicatePageNumber = 1;
    duplicatePageCursors = [null];
    duplicateExpandedSha = null;
    duplicateMembers.clear();
    elements.cancelDuplicateScan.classList.add("hidden");
    elements.duplicateSummary.classList.add("hidden");
    setDuplicateAutoMerge(false);
    elements.duplicateGroups.replaceChildren(emptyState("先掃描附件，找出完全相同的檔案。"));
    elements.duplicatePageInfo.textContent = "第 1 頁";
    elements.duplicatePrev.disabled = true;
    elements.duplicateNext.disabled = true;
    elements.hashDuplicates.disabled = false;
    cleanupState.page = 1;
    cleanupState.groupKey = null;
    cleanupPage = cleanupOverview = null;
    cleanupCategoryActionState = null;
    invalidateCleanupInsights();
    await loadCleanupPage();
    setCandidateBuildDisabled(false);
    setStatus("附件索引與聊天室關聯完成。");
    if (ownsModal) {
      updateLoadModalProgress(100, "附件索引與聊天室關聯完成。");
      await waitForUiPaint();
    }
    return stats;
  } catch (error) {
    if (isOperationCancelled(error)) {
      setStatus("已取消附件索引；請重新掃描後再繼續。", false);
      return null;
    }
    setStatus(error.message, true);
    if (!ownsModal) throw error;
    return null;
  } finally {
    elements.scanCatalog.disabled = !provider;
    if (cleanupOverview) renderCleanupOverview();
    if (ownsModal && !options.keepLoadModal) closeLoadModal();
  }
}

function cleanupOptions(overrides) {
  overrides = overrides || {};
  return {
    page: overrides.page || cleanupState.page,
    pageSize: overrides.pageSize || 6,
    search: cleanupState.search,
    kind: cleanupState.kind,
    category: cleanupState.category,
    sort: cleanupState.sort
  };
}

async function loadCleanupPage(options) {
  options = options || {};
  if (!provider) return;
  if (cleanupLoading) {
    cleanupReloadPending = true;
    return;
  }
  if (cleanupState.groupKey) {
    await loadCleanupAlbum();
    return;
  }
  disposeCleanupAlbum();
  cleanupLoading = true;
  syncCleanupPageInput();
  elements.cleanupList.setAttribute("aria-busy", "true");
  try {
    const requestedCategory = cleanupState.category;
    const supportsCategoryActions = [
      "all",
      "individual",
      "group",
      "community",
      "unreferenced",
      "unconfirmed"
    ].includes(requestedCategory);
    const actionStateRequest = supportsCategoryActions &&
      cleanupCategoryActionState?.category !== requestedCategory
      ? provider.cleanupCategoryActionState(requestedCategory)
      : supportsCategoryActions
        ? Promise.resolve(cleanupCategoryActionState)
      : Promise.resolve(null);
    let page;
    if (cleanupOverview) {
      [page, cleanupCategoryActionState] = await Promise.all([
        provider.listCleanupGroups(cleanupOptions()),
        actionStateRequest
      ]);
    } else {
      const [overview, loadedPage, actionState] = await Promise.all([
        provider.cleanupOverview(),
        provider.listCleanupGroups(cleanupOptions()),
        actionStateRequest
      ]);
      cleanupOverview = overview;
      page = loadedPage;
      cleanupCategoryActionState = actionState;
    }
    const [preflight, previews] = await Promise.all([
      cleanupPreflight || provider.cleanupPreflight({
        verifySource: options.verifySource !== false
      }),
      cleanupPlanPreviews || provider.cleanupPlanPreviews()
    ]);
    cleanupPreflight = preflight;
    cleanupPlanPreviews = previews;
    cleanupPage = page;
    renderCleanupOverview();
    renderCleanupPreflight();
    renderCleanupPlanPreviews();
    renderCleanupPage();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    cleanupLoading = false;
    syncCleanupPageInput();
    elements.cleanupList.removeAttribute("aria-busy");
    if (cleanupReloadPending && provider) {
      cleanupReloadPending = false;
      void loadCleanupPage();
    }
  }
}

function renderCleanupPreflight() {
  if (!cleanupPreflight) return;
  const blockers = Number(cleanupPreflight.blockerCount) || 0;
  const safeCandidates = Number(cleanupPreflight.safeCandidateCount) || 0;
  const visible = blockers > 0;
  elements.cleanupPreflight.classList.toggle("hidden", !visible);
  elements.cleanupPreflight.classList.toggle("has-blockers", blockers > 0);
  if (!visible) return;
  elements.cleanupPreflightTitle.textContent = blockers
    ? `清理前盲點掃描：暫停（${blockers} 個阻擋項）`
    : "清理前盲點掃描";
  elements.cleanupPreflightSummary.textContent =
    `SQLite ${cleanupPreflight.sqliteQuickCheck} · ` +
    `索引 ${cleanupPreflight.scanStatus} · ` +
    `安全候選 ${safeCandidates.toLocaleString()} 個 · ` +
    `已標記 ${Number(cleanupPreflight.markedCount || 0).toLocaleString()} 個`;
  const fragment = document.createDocumentFragment();
  for (const risk of cleanupPreflight.risks || []) {
    const item = document.createElement("div");
    item.className = `cleanup-preflight-risk ${risk.severity || "info"}`;
    const heading = document.createElement("strong");
    heading.textContent = risk.title;
    const detail = document.createElement("span");
    detail.textContent = risk.detail;
    item.append(heading, detail);
    if (Number(risk.fileCount) > 0) {
      const amount = document.createElement("small");
      amount.textContent = `${Number(risk.fileCount).toLocaleString()} 個 · ${formatBytes(risk.bytes)}`;
      item.append(amount);
    }
    fragment.append(item);
  }
  elements.cleanupPreflightRisks.replaceChildren(fragment);
  elements.refreshCleanupPreflight.disabled = !provider;
}

function renderCleanupPlanPreviews() {
  if (!cleanupPlanPreviews) return;
  const fragment = document.createDocumentFragment();
  for (const preview of cleanupPlanPreviews) {
    const card = document.createElement("article");
    const selected = cleanupState.planProfile === preview.profile;
    card.className = `cleanup-plan-card ${preview.profile || ""}`;
    card.classList.toggle("selected", selected);
    card.setAttribute("role", "radio");
    card.setAttribute("aria-checked", String(selected));
    card.dataset.planProfile = preview.profile || "";
    const heading = document.createElement("div");
    heading.className = "cleanup-plan-card-heading";
    const title = document.createElement("strong");
    title.textContent = preview.title;
    const select = document.createElement("button");
    select.type = "button";
    select.className = "cleanup-plan-select";
    select.dataset.planProfile = preview.profile || "";
    select.setAttribute("aria-pressed", String(selected));
    select.textContent = selected ? "目前方案" : "選擇方案";
    heading.append(title, select);
    const description = document.createElement("p");
    description.textContent = preview.description;
    const metrics = document.createElement("div");
    metrics.className = "cleanup-plan-metrics";
    const automatic = document.createElement("span");
    automatic.textContent = `可自動 ${Number(preview.automaticFileCount || 0).toLocaleString()} 個 · ${formatBytes(preview.automaticBytes)}`;
    const review = document.createElement("span");
    review.textContent = `待複核 ${Number(preview.reviewFileCount || 0).toLocaleString()} 個 · ${formatBytes(preview.reviewBytes)}`;
    const database = document.createElement("span");
    database.textContent = `聊天室計畫 ${Number(preview.plannedChatCount || 0).toLocaleString()} 個 · ${Number(preview.plannedMessageCount || 0).toLocaleString()} 則訊息`;
    metrics.append(automatic, review, database);
    const warnings = document.createElement("div");
    warnings.className = "cleanup-plan-preview-warnings";
    for (const warning of preview.warnings || []) {
      const note = document.createElement("span");
      note.textContent = warning;
      warnings.append(note);
    }
    card.append(heading, description, metrics, warnings);
    fragment.append(card);
  }
  elements.cleanupPlanCards.replaceChildren(fragment);
  const selectedProfile = cleanupPlanProfiles[cleanupState.planProfile];
  elements.cleanupPlanPreviewsSummary.textContent = selectedProfile
    ? `目前選擇：${selectedProfile.label}。${selectedProfile.selectionSummary}`
    : "請選擇方案；確認後只會套用安全標記，待複核項目不會自動刪除。";
}

async function selectCleanupPlan(profile) {
  const selectedProfile = cleanupPlanProfiles[profile];
  if (!selectedProfile) return;
  const preview = (cleanupPlanPreviews || []).find((item) => item.profile === profile);
  const automaticCandidates = Number(
    preview?.automaticFileCount ?? cleanupOverview?.automaticCandidateCount
  ) || 0;
  const automaticMarked = Number(cleanupOverview?.automaticMarkedCount) || 0;
  const reviewFiles = Number(preview?.reviewFileCount) || 0;
  const planDetails = automaticCandidates
    ? automaticMarked
      ? "安全標記已套用，按鈕狀態會保留。"
      : `會標記 ${automaticCandidates.toLocaleString()} 個可安全處理的圖片原檔，並保留非空縮圖。`
    : "目前沒有可安全自動標記的圖片原檔。";
  const reviewDetails = reviewFiles
    ? `另有 ${reviewFiles.toLocaleString()} 個待複核附件，仍需人工決定，不會自動刪除。`
    : "";
  if (!await requestConfirmation({
    title: `套用${selectedProfile.label}？`,
    message: `${planDetails}${reviewDetails}`,
    confirmLabel: "套用方案",
    danger: automaticCandidates > 0 && !automaticMarked
  })) return;
  cleanupState.planProfile = profile;
  cleanupState.manualMode = false;
  cleanupState.category = selectedProfile.category;
  cleanupState.kind = "all";
  cleanupState.page = 1;
  cleanupState.groupKey = null;
  elements.cleanupCategory.value = selectedProfile.category;
  elements.cleanupKind.value = "all";
  elements.cleanupKind.disabled = false;
  renderCleanupPlanPreviews();
  if (cleanupOverview) renderCleanupOverview();
  setCleanupPageMode("detail");
  if (provider && automaticCandidates > 0 && !automaticMarked) {
    await applySafeAttachmentCleanup(`已套用${selectedProfile.label}的安全標記。`);
    return;
  }
  if (provider) void loadCleanupPage({ verifySource: false });
  const searchNote = cleanupState.search ? "；已保留目前搜尋條件" : "";
  setStatus(`已套用${selectedProfile.label}${searchNote}；待複核項目不會自動刪除。`, false);
}

function enterManualCleanup() {
  cleanupState.planProfile = null;
  cleanupState.manualMode = true;
  cleanupState.kind = "all";
  cleanupState.category = "all";
  cleanupState.page = 1;
  cleanupState.groupKey = null;
  elements.cleanupKind.value = "all";
  elements.cleanupCategory.value = "all";
  elements.cleanupKind.disabled = false;
  if (cleanupOverview) renderCleanupOverview();
  setCleanupPageMode("detail");
  if (provider) void loadCleanupPage({ verifySource: false });
  setStatus("已進入手動清理，不會自動標記檔案。", false);
}

async function changeCleanupPlan() {
  if (!provider) return;
  if (!await requestConfirmation({
    title: "變更清理方案？",
    message:
      "變更方案會清除附件、聊天室與進階清理的全部計畫，無法復原。\\n\\n" +
      "搜尋文字與排序設定會保留。",
    confirmLabel: "清除並變更方案",
    danger: true
  })) return;
  elements.changeCleanupPlan.disabled = true;
  try {
    await runCleanupMutation({
      title: "正在清除清理計畫",
      message: "正在移除附件、聊天室與進階清理的所有計畫。",
      successMessage: "已清除全部清理計畫，請選擇新的方案。"
    }, async () => {
      cleanupOverview = await provider.clearAllRemovalPlans();
      cleanupPage = null;
      cleanupState.page = 1;
      cleanupState.kind = "all";
      cleanupState.category = "all";
      cleanupState.groupKey = null;
      cleanupState.planProfile = null;
      cleanupState.manualMode = false;
      elements.cleanupKind.value = "all";
      elements.cleanupCategory.value = "all";
      invalidateCleanupInsights();
      await loadCleanupPage({ verifySource: false });
      void refreshAdvancedPlanSummary();
    });
    setCleanupPageMode("plan");
    setStatus("已清除全部清理計畫，請選擇新的方案。", false);
  } catch (error) {
    reportCleanupMutationError(error);
  } finally {
    elements.changeCleanupPlan.disabled = !provider;
  }
}

async function refreshCleanupPreflight() {
  if (!provider || cleanupPreflightLoading) return;
  cleanupPreflightLoading = true;
  elements.refreshCleanupPreflight.disabled = true;
  try {
    const [preflight, previews] = await Promise.all([
      provider.cleanupPreflight(),
      provider.cleanupPlanPreviews()
    ]);
    cleanupPreflight = preflight;
    cleanupPlanPreviews = previews;
    renderCleanupPreflight();
    renderCleanupPlanPreviews();
    setCandidateBuildDisabled(false);
    setStatus("已完成清理前盲點掃描。", false);
  } catch (error) {
    setStatus(`清理前檢查失敗：${error.message}`, true);
  } finally {
    cleanupPreflightLoading = false;
    elements.refreshCleanupPreflight.disabled = !provider;
  }
}

function renderCleanupOverview() {
  if (!cleanupOverview) return;
  const selectedProfile = cleanupPlanProfiles[cleanupState.planProfile];
  elements.cleanupCurrentPlan.textContent = selectedProfile
    ? `目前方案：${selectedProfile.label}`
    : cleanupState.manualMode
      ? "手動清理"
      : "目前方案";
  elements.markedCount.textContent = cleanupOverview.markedCount.toLocaleString();
  elements.markedSize.textContent = formatBytes(cleanupOverview.markedBytes);
  const automaticCandidates = Number(cleanupOverview.automaticCandidateCount) || 0;
  const automaticCandidateBytes = Number(cleanupOverview.automaticCandidateBytes) || 0;
  const automaticMarked = Number(cleanupOverview.automaticMarkedCount) || 0;
  const automaticMarkedBytes = Number(cleanupOverview.automaticMarkedBytes) || 0;
  const manualMarked = Number(cleanupOverview.manualMarkedCount) || 0;
  elements.cleanupAutomationSummary.textContent = automaticCandidates
    ? `安全候選 ${automaticCandidates.toLocaleString()} 個 · ${formatBytes(automaticCandidateBytes)}；` +
      `自動已標記 ${automaticMarked.toLocaleString()} 個 · ${formatBytes(automaticMarkedBytes)}；` +
      "不會碰觸 PDF、影片、無縮圖或無法確認的附件。"
    : "目前沒有符合安全規則的圖片原檔；PDF、影片、無縮圖或無法確認的附件會保留。";
  elements.planSafeAttachmentCleanup.disabled = !provider || !automaticCandidates;
  elements.planSafeAttachmentCleanup.textContent = automaticMarked
    ? cleanupState.planProfile === "conservative" ? "取消保守方案標記" : "取消安全自動標記"
    : cleanupState.planProfile === "conservative" ? "套用保守方案" : "套用安全自動標記";
  elements.clearManualAttachmentPlan.disabled = !provider || !manualMarked;
  const fragment = document.createDocumentFragment();
  for (const total of cleanupOverview.categories) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "category-card";
    button.classList.toggle("active", cleanupState.category === total.category);
    button.setAttribute("aria-pressed", String(cleanupState.category === total.category));
    button.dataset.category = total.category;
    const title = document.createElement("strong");
    title.textContent = categoryLabels[total.category] || total.category;
    const summary = document.createElement("span");
    summary.textContent = `${total.fileCount.toLocaleString()} 個 · ${formatBytes(total.bytes)}`;
    button.append(title, summary);
    fragment.append(button);
  }
  elements.categorySummary.replaceChildren(fragment);
  renderCategoryBulkActions();
}

async function requestRestoreChecklistCancellation() {
  if (!restoreChecklistResolve) return;
  if (!await requestConfirmation({
    title: "確定取消還原前檢查？",
    message: "取消後會返回目前的清理畫面，不會建立瘦身候選檔。",
    cancelLabel: "繼續檢查",
    confirmLabel: "確認取消",
    danger: true
  })) return;
  closeRestoreChecklist(false);
}

function renderCategoryBulkActions() {
  const category = cleanupState.category;
  const supported = [
    "all",
    "individual",
    "group",
    "community",
    "unreferenced",
    "unconfirmed"
  ].includes(category);
  const chatBacked = ["all", "individual", "group", "community"].includes(category);
  elements.categoryBulkActions.classList.toggle("hidden", !supported);
  if (!supported) return;
  const label = categoryActionLabel(category);
  const actionState = cleanupCategoryActionState?.category === category
    ? cleanupCategoryActionState
    : null;
  const keepingAllThumbnails = Boolean(actionState?.keepingAllThumbnails);
  const deletingAllAttachments = Boolean(actionState?.deletingAllAttachments);
  const deletingAllChats = Boolean(actionState?.deletingAllChats);
  const thumbnailCandidateCount = Number(actionState?.thumbnailCandidateCount) || 0;
  const protectedThumbnailCount = Number(actionState?.protectedThumbnailCount) || 0;
  const attachmentCount = Number(actionState?.attachmentCount) || 0;
  const markedAttachmentCount = Number(actionState?.markedAttachmentCount) || 0;
  const hasProtectedThumbnails = protectedThumbnailCount > 0;
  elements.categoryBulkTitle.textContent = `${label}快速設定`;
  elements.categoryBulkDescription.textContent = !actionState
    ? "正在確認目前的批次設定…"
    : deletingAllAttachments && hasProtectedThumbnails
      ? `分類批次刪除仍啟用：已保留 ${protectedThumbnailCount.toLocaleString()} 個縮圖，目前標記 ${markedAttachmentCount.toLocaleString()} / ${attachmentCount.toLocaleString()} 個附件。`
      : deletingAllAttachments
        ? `分類批次刪除仍啟用：目前標記 ${markedAttachmentCount.toLocaleString()} / ${attachmentCount.toLocaleString()} 個附件；聊天室可個別取消。`
        : hasProtectedThumbnails
          ? `已保留 ${protectedThumbnailCount.toLocaleString()} / ${thumbnailCandidateCount.toLocaleString()} 個非空縮圖。`
          : deletingAllChats
            ? "已將這個分類的所有聊天室加入清理計畫；按相同按鈕即可批量取消。"
      : chatBacked
        ? `可一次處理整個${label}；刪除聊天室需先開啟進階模式。`
        : `${label}沒有可靠的聊天室歸屬，但可一次標記刪除這個分類的所有附件。`;
  elements.categoryKeepThumbnails.classList.toggle("hidden", !chatBacked);
  elements.categoryDeleteChats.classList.toggle("hidden", !chatBacked);
  elements.categoryKeepThumbnails.textContent = keepingAllThumbnails
    ? `取消保留 ${protectedThumbnailCount.toLocaleString()} 個縮圖`
    : `全部只保留縮圖（${thumbnailCandidateCount.toLocaleString()}）`;
  elements.categoryDeleteAttachments.textContent = deletingAllAttachments
    ? hasProtectedThumbnails ? "取消刪除其他附件" : "取消刪除分類所有附件"
    : hasProtectedThumbnails ? "刪除縮圖以外附件" : "刪除分類所有附件";
  elements.categoryDeleteChats.textContent = deletingAllChats
    ? "取消刪除分類所有聊天室"
    : "刪除分類所有聊天室";
  elements.categoryKeepThumbnails.setAttribute("aria-pressed", String(keepingAllThumbnails));
  elements.categoryDeleteAttachments.setAttribute("aria-pressed", String(deletingAllAttachments));
  elements.categoryDeleteChats.setAttribute("aria-pressed", String(deletingAllChats));
  elements.categoryDeleteAttachments.classList.toggle("danger-button", !deletingAllAttachments);
  elements.categoryDeleteAttachments.classList.toggle("secondary-button", deletingAllAttachments);
  elements.categoryDeleteChats.classList.toggle("danger-button", !deletingAllChats);
  elements.categoryDeleteChats.classList.toggle("secondary-button", deletingAllChats);
  elements.categoryKeepThumbnails.disabled = !provider ||
    !actionState ||
    cleanupMutationInProgress ||
    (!keepingAllThumbnails && !Number(actionState.thumbnailCandidateCount));
  elements.categoryDeleteAttachments.disabled = !provider ||
    !actionState ||
    cleanupMutationInProgress ||
    (!deletingAllAttachments && !Number(actionState.attachmentCount));
  elements.categoryDeleteChats.disabled = !provider ||
    !actionState ||
    cleanupMutationInProgress ||
    !advancedMode ||
    (!deletingAllChats && !Number(actionState.chatCount));
  elements.categoryKeepThumbnails.title = keepingAllThumbnails
    ? `取消${label}目前的只保留縮圖手動標記`
    : `將${label}全部設定為只保留縮圖`;
  elements.categoryDeleteAttachments.title = deletingAllAttachments
    ? `取消${label}目前的所有手動附件刪除標記`
    : `將${label}的所有附件加入清理計畫`;
  elements.categoryDeleteChats.title = advancedMode
    ? deletingAllChats
      ? `取消${label}所有聊天室的刪除計畫`
      : `將${label}的所有聊天室加入清理計畫`
    : "請先開啟進階模式，才能刪除整個聊天室";
}

function renderCleanupPage() {
  if (!cleanupPage) return;
  elements.cleanupView.classList.remove("is-detail");
  renderCleanupGroups(cleanupPage);
  const page = Math.max(1, Number(cleanupPage.page) || cleanupState.page || 1);
  const totalPages = Math.max(1, Number(cleanupPage.totalPages) || 1);
  cleanupState.page = page;
  elements.cleanupPageInput.value = String(page);
  elements.cleanupPageInput.max = String(totalPages);
  elements.cleanupPageTotal.textContent = String(totalPages);
  elements.cleanupPageInfo.textContent = cleanupPage.totalItems
    ? `· ${cleanupPage.totalItems.toLocaleString()} 個分類`
    : "";
  elements.cleanupPrev.disabled = page <= 1;
  elements.cleanupNext.disabled = page >= totalPages;
  syncCleanupPageInput();
}

function syncCleanupPageInput() {
  if (!elements.cleanupPageInput) return;
  const totalPages = Math.max(1, Number(cleanupPage?.totalPages) || 1);
  elements.cleanupPageInput.max = String(totalPages);
  elements.cleanupPageTotal.textContent = String(totalPages);
  elements.cleanupPageInput.disabled = cleanupLoading || Boolean(cleanupState.groupKey) || totalPages <= 1;
}

function commitCleanupPageInput() {
  if (cleanupState.groupKey || !cleanupPage || cleanupLoading) return;
  const totalPages = Math.max(1, Number(cleanupPage.totalPages) || 1);
  const requested = Number.parseInt(elements.cleanupPageInput.value, 10);
  const page = Number.isFinite(requested)
    ? Math.min(totalPages, Math.max(1, requested))
    : cleanupPage.page;
  elements.cleanupPageInput.value = String(page);
  if (page === cleanupPage.page) return;
  cleanupState.page = page;
  void loadCleanupPage();
}

function renderCleanupGroups(page) {
  cleanupRenderGeneration += 1;
  elements.cleanupResultInfo.textContent = page.totalItems
    ? `找到 ${page.totalItems.toLocaleString()} 個聊天室或特殊分類；點入後才會顯示附件內容。`
    : "";
  if (!page.items.length) {
    elements.cleanupList.replaceChildren(emptyState(
      "找不到符合條件的聊天室。可以清除搜尋文字或切換「顯示」篩選。"
    ));
    return;
  }
  const list = document.createElement("div");
  list.className = "cleanup-group-list";
  for (const group of page.items) list.append(renderCleanupGroup(group));
  elements.cleanupList.replaceChildren(list);
}

function renderCleanupGroup(group) {
  const card = document.createElement("article");
  card.className = "cleanup-group-card";
  if (group.referenceStatus !== "referenced") {
    card.classList.add("special", group.referenceStatus);
  }
  const row = document.createElement("div");
  row.className = "cleanup-group-row";
  const canOpen = group.referenceStatus !== "no_attachments";
  const open = document.createElement(canOpen ? "button" : "div");
  if (canOpen) open.type = "button";
  open.className = "cleanup-group-open-button";
  if (canOpen) open.dataset.openGroup = group.key;
  const avatar = document.createElement("span");
  avatar.className = "cleanup-chat-avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = chatIcon(group.chatKind);
  const main = document.createElement("span");
  main.className = "cleanup-group-main";
  const heading = document.createElement("span");
  heading.className = "cleanup-group-heading";
  const title = document.createElement("strong");
  title.textContent = group.chatTitle;
  const badge = document.createElement("span");
  badge.className = "cleanup-chat-type";
  badge.textContent = cleanupStatusLabel(group.referenceStatus);
  heading.append(title, badge);
  const summary = document.createElement("small");
  summary.textContent = group.referenceStatus === "no_attachments"
    ? cleanupStatusSummary(group.referenceStatus)
    : group.referenceStatus === "referenced"
    ? cleanupStatusSummary(group.chatKind)
    : cleanupStatusSummary(group.referenceStatus);
  const counts = document.createElement("span");
  counts.textContent = group.referenceStatus === "no_attachments"
    ? "沒有已索引附件"
    : `${group.fileCount.toLocaleString()} 個檔案 · ${formatBytes(group.totalBytes)}`;
  if (group.markedCount) {
    const marked = document.createElement("b");
    marked.textContent = ` · 已標記 ${group.markedCount.toLocaleString()} 個`;
    counts.append(marked);
  }
  if (group.keepingThumbnails && !group.plannedForChatRemoval) {
    const kept = document.createElement("b");
    kept.className = "cleanup-kept-count";
    kept.textContent = ` · 已保留 ${group.nonemptyThumbnailCount.toLocaleString()} 個縮圖`;
    counts.append(kept);
  }
  main.append(heading, summary, counts);
  open.append(avatar, main);

  const actions = document.createElement("div");
  actions.className = "cleanup-group-actions";
  if (advancedMode &&
      ["referenced", "no_attachments"].includes(group.referenceStatus) &&
      group.chatSource &&
      Number.isInteger(Number(group.chatPk))) {
    const removeChat = document.createElement("button");
    removeChat.type = "button";
    removeChat.className =
      `cleanup-group-action ${group.plannedForChatRemoval ? "is-cancel" : "is-delete"}`;
    removeChat.dataset.chatRemoval = "true";
    removeChat.dataset.chatSource = group.chatSource;
    removeChat.dataset.chatPk = String(group.chatPk);
    removeChat.dataset.chatTitle = group.chatTitle;
    removeChat.dataset.planned = String(Boolean(group.plannedForChatRemoval));
    removeChat.textContent = group.plannedForChatRemoval ? "保留聊天室" : "刪除聊天室";
    actions.append(removeChat);
  }
  if (canOpen) {
    const toggleAll = document.createElement("button");
    const deletingAllAttachments = Boolean(group.deletingAllAttachments);
    const keepingThumbnails = Boolean(group.keepingThumbnails);
    toggleAll.type = "button";
    toggleAll.className =
      `cleanup-group-action ${deletingAllAttachments ? "is-cancel" : "is-delete"}`;
    toggleAll.dataset.groupAction = "toggle_all";
    toggleAll.dataset.groupKey = group.key;
    toggleAll.dataset.deletingAllAttachments = String(deletingAllAttachments);
    toggleAll.dataset.keepingThumbnails = String(keepingThumbnails);
    toggleAll.dataset.chatTitle = group.chatTitle;
    toggleAll.disabled = Boolean(group.plannedForChatRemoval);
    toggleAll.title = group.plannedForChatRemoval
      ? "附件會隨聊天室一起刪除；請先取消聊天室清理計畫"
      : "";
    toggleAll.textContent = group.plannedForChatRemoval
      ? "隨聊天室刪除"
      : deletingAllAttachments
        ? keepingThumbnails ? "取消刪除其他附件" : "取消刪除所有附件"
        : keepingThumbnails ? "刪除縮圖以外附件" : "刪除所有附件";
    actions.append(toggleAll);
  }
  if (canOpen && group.nonemptyThumbnailCount > 0) {
    const keepThumbnail = document.createElement("button");
    keepThumbnail.type = "button";
    keepThumbnail.className =
      `cleanup-group-action ${group.keepingThumbnails ? "is-cancel" : "is-delete"}`;
    keepThumbnail.dataset.groupAction = "keep_thumbnail";
    keepThumbnail.dataset.groupKey = group.key;
    keepThumbnail.dataset.keepingThumbnails = String(Boolean(group.keepingThumbnails));
    keepThumbnail.dataset.thumbnailCount = String(Number(group.nonemptyThumbnailCount) || 0);
    keepThumbnail.disabled = Boolean(group.plannedForChatRemoval);
    keepThumbnail.title = group.keepingThumbnails
      ? "取消保護所有非空縮圖，並還原可安全配對的圖片原檔"
      : "保留所有非空縮圖；只有能安全配對的圖片原檔會加入清理計畫";
    keepThumbnail.textContent = group.keepingThumbnails ? "取消保留縮圖" : "只保留縮圖";
    actions.append(keepThumbnail);
  } else if (canOpen && group.chatKind === "community") {
    const unavailableThumbnail = document.createElement("button");
    unavailableThumbnail.type = "button";
    unavailableThumbnail.className = "cleanup-group-action";
    unavailableThumbnail.disabled = true;
    unavailableThumbnail.textContent = "沒有非空縮圖";
    unavailableThumbnail.title = "這個社群沒有非空縮圖可保留";
    actions.append(unavailableThumbnail);
  }
  if (canOpen) {
    const view = document.createElement("button");
    view.type = "button";
    view.className = "cleanup-group-action";
    view.dataset.openGroup = group.key;
    view.textContent = "查看";
    actions.append(view);
  }
  row.append(open, actions);
  card.append(row);
  return card;
}

function disposeCleanupAlbum() {
  if (!cleanupAlbumSession) return;
  cleanupAlbumSession.disposed = true;
  if (cleanupAlbumSession.resizeObserver) cleanupAlbumSession.resizeObserver.disconnect();
  for (const { node } of cleanupAlbumSession.pages.values()) {
    if (node.cleanupPreviewObserver) node.cleanupPreviewObserver.disconnect();
  }
  cleanupAlbumSession = null;
}

async function loadCleanupAlbum() {
  if (!provider || !cleanupState.groupKey) return;
  if (cleanupLoading) {
    cleanupReloadPending = true;
    return;
  }
  cleanupLoading = true;
  disposeCleanupAlbum();
  syncCleanupPageInput();
  const groupKey = cleanupState.groupKey;
  const renderGeneration = ++cleanupRenderGeneration;
  elements.cleanupList.setAttribute("aria-busy", "true");
  try {
    const options = cleanupOptions({ page: 1, pageSize: CLEANUP_ALBUM_PAGE_SIZE });
    const [overview, firstPage] = await Promise.all([
      provider.cleanupOverview(),
      provider.listCleanupReviews(groupKey, options)
    ]);
    if (cleanupState.groupKey !== groupKey) return;
    cleanupOverview = overview;
    cleanupPage = firstPage;
    renderCleanupOverview();
    renderCleanupAlbum(firstPage, renderGeneration);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    cleanupLoading = false;
    syncCleanupPageInput();
    elements.cleanupList.removeAttribute("aria-busy");
    if (cleanupReloadPending && provider) {
      cleanupReloadPending = false;
      void loadCleanupPage();
    }
  }
}

function cleanupAlbumSectionLabel(review) {
  if (cleanupState.sort === "size") return "依檔案大小排序";
  if (cleanupState.sort === "path") return "依來源路徑排序";
  const date = normalizedTimestamp(review.context && review.context.timestamp);
  if (!date) return "日期不明";
  return new Intl.DateTimeFormat("zh-TW", {
    year: "numeric",
    month: "long"
  }).format(date);
}

function cleanupAlbumSections(items) {
  const sections = [];
  for (const review of items) {
    const label = cleanupAlbumSectionLabel(review);
    const current = sections[sections.length - 1];
    if (current && current.label === label) current.items.push(review);
    else sections.push({ label, items: [review] });
  }
  return sections;
}

function renderCleanupAlbumPage(page) {
  const wrapper = document.createElement("div");
  wrapper.className = "cleanup-album-page";
  wrapper.dataset.cleanupAlbumPage = String(page.page);
  const entries = cleanupAlbumSections(page.items);
  wrapper.cleanupFirstSection = entries.length ? entries[0].label : "";
  wrapper.cleanupLastSection = entries.length ? entries[entries.length - 1].label : "";
  for (const entry of entries) {
    const section = document.createElement("section");
    section.className = "cleanup-month-section";
    const heading = document.createElement("header");
    heading.className = "cleanup-month-header";
    const title = document.createElement("h4");
    title.textContent = entry.label;
    const count = document.createElement("span");
    count.textContent = `${entry.items.length.toLocaleString()} 組`;
    heading.append(title, count);
    const grid = document.createElement("div");
    grid.className = "cleanup-review-grid cleanup-album-grid";
    for (const review of entry.items) grid.append(renderCleanupReview(review));
    section.append(heading, grid);
    wrapper.append(section);
  }
  return wrapper;
}

function updateCleanupAlbumContinuations(session) {
  const pages = Array.from(session.pages.entries())
    .sort(([left], [right]) => left - right);
  let previous = null;
  for (const [pageNumber, entry] of pages) {
    const firstSection = entry.node.querySelector(".cleanup-month-section");
    const continues = Boolean(
      previous &&
      previous.pageNumber + 1 === pageNumber &&
      previous.node.cleanupLastSection &&
      previous.node.cleanupLastSection === entry.node.cleanupFirstSection
    );
    if (firstSection) firstSection.classList.toggle("is-continuation", continues);
    previous = { pageNumber, node: entry.node };
  }
}

function cleanupAlbumEstimatedPageHeight(session) {
  const width = Math.max(360, elements.cleanupList.clientWidth - 20);
  const columns = Math.max(2, Math.floor((width + 8) / 200));
  return Math.ceil(session.pageSize / columns) * 330 + 72;
}

function cleanupAlbumSpacerHeight(session, firstPage, lastPage) {
  if (lastPage < firstPage) return 0;
  const estimate = cleanupAlbumEstimatedPageHeight(session);
  let height = (lastPage - firstPage + 1) * estimate;
  for (const [page, measured] of session.pageHeights) {
    if (page >= firstPage && page <= lastPage) height += measured - estimate;
  }
  return Math.max(0, height);
}

function cleanupAlbumPageRange(session) {
  const pages = Array.from(session.pages.keys()).sort((left, right) => left - right);
  return {
    min: pages.length ? pages[0] : 1,
    max: pages.length ? pages[pages.length - 1] : 0
  };
}

function updateCleanupAlbumSpacers(session) {
  if (session.disposed || cleanupAlbumSession !== session) return;
  const range = cleanupAlbumPageRange(session);
  const topHeight = cleanupAlbumSpacerHeight(session, 1, range.min - 1);
  const bottomHeight = cleanupAlbumSpacerHeight(session, range.max + 1, session.totalPages);
  session.topSpacer.style.height = `${topHeight}px`;
  session.bottomSpacer.style.height = `${bottomHeight}px`;
  session.topSpacer.dataset.height = String(topHeight);
  session.bottomSpacer.dataset.height = String(bottomHeight);
}

function updateCleanupAlbumStatus(session) {
  if (session.disposed || cleanupAlbumSession !== session) return;
  const range = cleanupAlbumPageRange(session);
  const first = session.totalItems ? (range.min - 1) * session.pageSize + 1 : 0;
  const last = Math.min(session.totalItems, range.max * session.pageSize);
  const loaded = first ? `${first.toLocaleString()}–${last.toLocaleString()}` : "0";
  session.status.textContent = range.max < session.totalPages
    ? `已載入 ${loaded} / ${session.totalItems.toLocaleString()} 組；繼續捲動會自動載入`
    : `已載入 ${loaded} / ${session.totalItems.toLocaleString()} 組；已到最早的附件`;
  elements.cleanupPageInfo.textContent =
    `連續捲動 · ${session.totalItems.toLocaleString()} 組附件`;
}

function measureCleanupAlbumPage(session, pageNumber, node) {
  if (!node.isConnected || session.disposed) return 0;
  const height = Math.ceil(node.getBoundingClientRect().height);
  if (height > 0) session.pageHeights.set(pageNumber, height);
  return height;
}

function mountCleanupAlbumPage(session, page, direction) {
  if (session.pages.has(page.page)) return null;
  const node = renderCleanupAlbumPage(page);
  if (direction === "previous") session.pagesHost.prepend(node);
  else session.pagesHost.append(node);
  session.pages.set(page.page, { node });
  if (session.resizeObserver) session.resizeObserver.observe(node);
  updateCleanupAlbumContinuations(session);
  void hydrateCleanupPreviews(node, session.renderGeneration);
  return node;
}

function trimCleanupAlbumPages(session, direction) {
  while (session.pages.size > CLEANUP_ALBUM_MAX_PAGES) {
    const range = cleanupAlbumPageRange(session);
    const pageNumber = direction === "previous" ? range.max : range.min;
    const entry = session.pages.get(pageNumber);
    if (!entry) break;
    measureCleanupAlbumPage(session, pageNumber, entry.node);
    if (entry.node.cleanupPreviewObserver) entry.node.cleanupPreviewObserver.disconnect();
    if (session.resizeObserver) session.resizeObserver.unobserve(entry.node);
    entry.node.remove();
    session.pages.delete(pageNumber);
  }
  updateCleanupAlbumContinuations(session);
}

async function loadCleanupAlbumPage(session, pageNumber, direction) {
  if (!provider || session.disposed || cleanupAlbumSession !== session ||
      session.loading || pageNumber < 1 || pageNumber > session.totalPages ||
      session.pages.has(pageNumber)) return;
  session.loading = true;
  session.status.textContent = "正在載入相鄰月份的附件…";
  const oldScrollTop = elements.cleanupList.scrollTop;
  const oldTopHeight = Number(session.topSpacer.dataset.height) || 0;
  let loaded = false;
  try {
    const page = await provider.listCleanupReviews(
      session.groupKey,
      cleanupOptions({ page: pageNumber, pageSize: session.pageSize })
    );
    if (session.disposed || cleanupAlbumSession !== session ||
        cleanupState.groupKey !== session.groupKey) return;
    const node = mountCleanupAlbumPage(session, page, direction);
    if (!node) return;
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    const insertedHeight = measureCleanupAlbumPage(session, pageNumber, node);
    trimCleanupAlbumPages(session, direction);
    updateCleanupAlbumSpacers(session);
    if (direction === "previous") {
      const newTopHeight = Number(session.topSpacer.dataset.height) || 0;
      elements.cleanupList.scrollTop =
        oldScrollTop + newTopHeight + insertedHeight - oldTopHeight;
    }
    updateCleanupAlbumStatus(session);
    loaded = true;
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    session.loading = false;
    if (loaded) window.requestAnimationFrame(handleCleanupAlbumScroll);
  }
}

function handleCleanupAlbumScroll() {
  const session = cleanupAlbumSession;
  if (!session || session.disposed || session.loading) return;
  const range = cleanupAlbumPageRange(session);
  const viewport = elements.cleanupList;
  const threshold = Math.max(320, viewport.clientHeight * 0.75);
  const topHeight = Number(session.topSpacer.dataset.height) || 0;
  const bottomHeight = Number(session.bottomSpacer.dataset.height) || 0;
  if (range.min > 1 && viewport.scrollTop <= topHeight + threshold) {
    void loadCleanupAlbumPage(session, range.min - 1, "previous");
    return;
  }
  if (range.max < session.totalPages &&
      viewport.scrollTop + viewport.clientHeight >=
        viewport.scrollHeight - bottomHeight - threshold) {
    void loadCleanupAlbumPage(session, range.max + 1, "next");
  }
}

function renderCleanupAlbum(page, renderGeneration) {
  elements.cleanupView.classList.add("is-detail");
  const group = page.group;
  elements.cleanupResultInfo.textContent = page.totalItems
    ? `正在檢視「${group.chatTitle}」的 ${page.totalItems.toLocaleString()} 組附件；依月份分段並按需載入。`
    : "";
  const section = document.createElement("section");
  section.className = "cleanup-chat-group";
  const header = document.createElement("header");
  header.className = "cleanup-chat-header";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "cleanup-back";
  back.dataset.cleanupBack = "";
  back.textContent = "返回聊天室列表";
  const avatar = document.createElement("span");
  avatar.className = "cleanup-chat-avatar";
  avatar.textContent = chatIcon(group.chatKind);
  const title = document.createElement("div");
  title.className = "cleanup-chat-title";
  const titleRow = document.createElement("div");
  const heading = document.createElement("h3");
  heading.textContent = group.chatTitle;
  const badge = document.createElement("span");
  badge.className = "cleanup-chat-type";
  badge.textContent = cleanupStatusLabel(group.referenceStatus);
  titleRow.append(heading, badge);
  const summary = document.createElement("p");
  summary.textContent =
    `${group.referenceStatus === "referenced" ? cleanupStatusSummary(group.chatKind) : cleanupStatusSummary(group.referenceStatus)} · ` +
    `${page.totalItems.toLocaleString()} 組附件 · 連續捲動`;
  title.append(titleRow, summary);
  header.append(back, avatar, title);
  section.append(header);

  if (!page.items.length) {
    section.append(emptyState("找不到符合條件的附件。可以清除搜尋文字或切換「顯示」篩選。"));
    elements.cleanupList.replaceChildren(section);
    elements.cleanupPageInfo.textContent = "連續捲動 · 0 組附件";
    elements.cleanupPrev.disabled = true;
    elements.cleanupNext.disabled = true;
    return;
  }

  const album = document.createElement("div");
  album.className = "cleanup-album";
  album.setAttribute("role", "feed");
  album.setAttribute("aria-label", `${group.chatTitle} 的附件相簿`);
  const topSpacer = document.createElement("div");
  topSpacer.className = "cleanup-album-spacer";
  topSpacer.setAttribute("aria-hidden", "true");
  const pagesHost = document.createElement("div");
  pagesHost.className = "cleanup-album-pages";
  const bottomSpacer = document.createElement("div");
  bottomSpacer.className = "cleanup-album-spacer";
  bottomSpacer.setAttribute("aria-hidden", "true");
  const status = document.createElement("p");
  status.className = "cleanup-album-status";
  status.setAttribute("role", "status");
  album.append(topSpacer, pagesHost, status, bottomSpacer);
  section.append(album);
  elements.cleanupList.replaceChildren(section);
  elements.cleanupList.scrollTop = 0;

  const session = {
    disposed: false,
    loading: false,
    groupKey: cleanupState.groupKey,
    pageSize: page.pageSize,
    totalItems: page.totalItems,
    totalPages: page.totalPages,
    renderGeneration,
    pages: new Map(),
    pageHeights: new Map(),
    topSpacer,
    pagesHost,
    bottomSpacer,
    status,
    resizeObserver: null
  };
  if (typeof ResizeObserver === "function") {
    session.resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const pageNumber = Number(entry.target.dataset.cleanupAlbumPage);
        if (Number.isInteger(pageNumber)) {
          session.pageHeights.set(pageNumber, Math.ceil(entry.contentRect.height));
        }
      }
      updateCleanupAlbumSpacers(session);
    });
  }
  cleanupAlbumSession = session;
  mountCleanupAlbumPage(session, page, "next");
  updateCleanupAlbumSpacers(session);
  updateCleanupAlbumStatus(session);
  elements.cleanupPrev.disabled = true;
  elements.cleanupNext.disabled = true;
  window.requestAnimationFrame(() => {
    const entry = session.pages.get(page.page);
    if (entry) measureCleanupAlbumPage(session, page.page, entry.node);
    updateCleanupAlbumSpacers(session);
    handleCleanupAlbumScroll();
  });
}

function renderCleanupReview(review) {
  const card = document.createElement("article");
  card.className = "cleanup-review-card";
  const preview = document.createElement("button");
  preview.type = "button";
  preview.className = "cleanup-preview";
  preview.disabled = true;
  const previewIcon = document.createElement("span");
  previewIcon.className = "cleanup-preview-fallback";
  previewIcon.textContent = review.files.some((file) => file.kind === "thumbnail") ? "縮圖" : "附件";
  const previewNote = document.createElement("small");
  const originalImage = review.files.find((file) =>
    file.kind === "original" && /\.(?:jpe?g|png|gif|webp|bmp|avif)$/i.test(file.path)
  );
  const thumbnail = review.files.find((file) => file.kind === "thumbnail");
  const previewPaths = [originalImage, thumbnail]
    .filter(Boolean)
    .map((file) => file.path)
    .filter((path, index, paths) => paths.indexOf(path) === index);
  previewNote.textContent = previewPaths.length ? "載入預覽…" : "沒有影像預覽";
  preview.previewPaths = previewPaths;
  preview.append(previewIcon, previewNote);

  const content = document.createElement("div");
  content.className = "cleanup-review-context";
  if (review.context) {
    const meta = document.createElement("div");
    meta.className = "cleanup-message-meta";
    const sender = document.createElement("span");
    sender.textContent = review.context.senderName || "未知傳送者";
    const time = document.createElement("time");
    time.textContent = formatTimestamp(review.context.timestamp);
    meta.append(sender, time);
    const summary = document.createElement("p");
    summary.className = "cleanup-message-summary";
    summary.textContent = review.context.text || `沒有文字內容（類型 ${review.context.contentType ?? "?"}）`;
    content.append(meta, summary);
  } else {
    const meta = document.createElement("div");
    meta.className = "cleanup-message-meta uncertain";
    const heading = document.createElement("span");
    heading.textContent = review.referenceStatus === "unreferenced"
      ? "SQLite 未引用這個附件"
      : "無法確認對應訊息";
    const detail = document.createElement("span");
    detail.textContent = review.messageId ? `訊息 ID ${review.messageId}` : "無法取得訊息 ID";
    meta.append(heading, detail);
    const summary = document.createElement("p");
    summary.className = "cleanup-message-summary";
    summary.textContent = review.referenceStatus === "unreferenced"
      ? "此檔案暫未被目前資料庫引用，仍請檢視檔名後再決定是否刪除。"
      : "資料庫關聯不足，請保守處理。";
    content.append(meta, summary);
  }
  content.append(renderEvidence(review));
  const choices = document.createElement("div");
  choices.className = "cleanup-file-choices";
  for (const file of review.files) choices.append(renderFileChoice(file));
  content.append(choices);
  card.append(preview, content);
  return card;
}

function hydrateCleanupPreview(preview, renderGeneration) {
  if (!Array.isArray(preview.previewPaths) || !preview.previewPaths.length ||
      preview.dataset.previewState) return Promise.resolve();
  preview.dataset.previewState = "loading";
  return (async () => {
    let url = null;
    let caption = "附件預覽";
    for (const path of preview.previewPaths) {
      try {
        url = await bridge.attachmentPreviewUrl(path);
        caption = fileName(path);
        if (url) break;
      } catch (_error) {
        // Try the thumbnail fallback before leaving the bounded placeholder.
      }
    }
    if (!url || renderGeneration !== cleanupRenderGeneration || !preview.isConnected) {
      preview.dataset.previewState = "failed";
      return;
    }
    const image = document.createElement("img");
    image.alt = caption;
    image.loading = "lazy";
    image.decoding = "async";
    const open = document.createElement("span");
    open.className = "cleanup-preview-open";
    open.textContent = "點擊放大";
    image.addEventListener("error", () => {
      image.remove();
      open.remove();
      preview.disabled = true;
      preview.dataset.previewState = "failed";
    }, { once: true });
    preview.disabled = false;
    preview.dataset.previewState = "loaded";
    preview.setAttribute("aria-label", `放大預覽：${caption}`);
    preview.addEventListener("click", () => showImageModal(url, caption, preview), { once: true });
    preview.prepend(image);
    preview.append(open);
    image.src = url;
    const note = preview.querySelector("small");
    if (note) note.remove();
  })();
}

function hydrateCleanupPreviews(section, renderGeneration) {
  const previews = Array.from(section.querySelectorAll(".cleanup-preview"))
    .filter((preview) => Array.isArray(preview.previewPaths) && preview.previewPaths.length);
  const queue = [];
  let active = 0;
  const pump = () => {
    while (active < 4 && queue.length) {
      const preview = queue.shift();
      active += 1;
      void hydrateCleanupPreview(preview, renderGeneration).finally(() => {
        active -= 1;
        pump();
      });
    }
  };
  const enqueue = (preview) => {
    if (!preview || preview.dataset.previewState) return;
    queue.push(preview);
    pump();
  };
  if (typeof IntersectionObserver !== "function") {
    for (const preview of previews) enqueue(preview);
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      enqueue(entry.target);
    }
  }, { root: elements.cleanupList, rootMargin: "480px 0px" });
  section.cleanupPreviewObserver = observer;
  for (const preview of previews) observer.observe(preview);
}

function renderEvidence(review) {
  const details = document.createElement("details");
  details.className = "cleanup-evidence";
  const summary = document.createElement("summary");
  summary.textContent = "查看 SQLite 證據";
  const evidence = document.createElement("small");
  evidence.textContent = [
    `messageId=${review.messageId || "無"}`,
    `messagePk=${review.context ? review.context.messagePk : "無"}`,
    `chatPk=${review.context ? review.context.chatPk : "無"}`,
    `referenceStatus=${review.referenceStatus}`,
    `confidence=${review.referenceStatus === "referenced" ? "exact" : "unconfirmed"}`
  ].join("；");
  details.append(summary, evidence);
  return details;
}

function renderFileChoice(file) {
  const choice = document.createElement("label");
  choice.className = "cleanup-file-choice";
  const plannedByChat = Boolean(cleanupPage &&
    cleanupPage.group &&
    cleanupPage.group.plannedForChatRemoval);
  const impactText = plannedByChat
    ? "這個檔案已由聊天室清理計畫鎖定；取消聊天室刪除後才能單獨調整。"
    : file.kind === "thumbnail"
      ? "刪除縮圖可能讓聊天紀錄失去預覽，即使原始附件仍存在。"
      : "刪除後 LINE 可能無法顯示原始畫質；保留縮圖時仍可能看到低畫質預覽。";
  choice.title = impactText;
  choice.setAttribute("aria-description", impactText);
  choice.classList.toggle("planned-by-chat", plannedByChat);
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = file.markedForRemoval;
  checkbox.disabled = plannedByChat;
  checkbox.dataset.attachmentPath = file.path;
  const main = document.createElement("span");
  main.className = "cleanup-file-choice-main";
  const title = document.createElement("span");
  title.className = "cleanup-file-title";
  const name = document.createElement("strong");
  name.textContent = fileName(file.path);
  const kind = document.createElement("span");
  kind.className = `cleanup-kind-badge ${file.kind}`;
  kind.textContent = file.kind === "thumbnail" ? "縮圖" : "原始附件";
  title.append(name, kind);
  if (file.removalReason === "automatic") {
    const automatic = document.createElement("span");
    automatic.className = "cleanup-plan-badge automatic";
    automatic.textContent = "自動";
    automatic.title = "由安全自動清理規則標記；取消勾選後會改為保留。";
    title.append(automatic);
  } else if (file.removalReason === "manual") {
    const manual = document.createElement("span");
    manual.className = "cleanup-plan-badge manual";
    manual.textContent = "手動";
    title.append(manual);
  } else if (file.removalReason === "chat") {
    const chat = document.createElement("span");
    chat.className = "cleanup-plan-badge chat";
    chat.textContent = "聊天室";
    title.append(chat);
  }
  const size = document.createElement("small");
  size.textContent = `${file.kind === "thumbnail" ? "縮圖" : "原始附件"} · ${formatBytes(file.bytes)}`;
  const impact = document.createElement("span");
  impact.className = "cleanup-impact";
  impact.textContent = impactText;
  const path = document.createElement("details");
  path.className = "cleanup-path";
  const pathSummary = document.createElement("summary");
  pathSummary.textContent = "查看實際檔名與路徑";
  const code = document.createElement("code");
  code.textContent = file.path;
  path.append(pathSummary, code);
  main.append(title, size, impact, path);
  const deleteLabel = document.createElement("span");
  deleteLabel.className = "cleanup-delete-label";
  deleteLabel.textContent = plannedByChat ? "隨聊天室刪除" : "刪除此檔";
  choice.append(checkbox, main, deleteLabel);
  return choice;
}

async function changeAttachmentMark(checkbox) {
  const path = checkbox.dataset.attachmentPath;
  checkbox.disabled = true;
  try {
    await runCleanupMutation({
      title: checkbox.checked ? "正在標記附件" : "正在取消附件標記",
      message: "正在寫入附件清理狀態，請勿重複操作。",
      successMessage: checkbox.checked ? "附件已加入清理計畫。" : "附件已從清理計畫移除。"
    }, async () => {
      await provider.setAttachmentMarked(path, checkbox.checked);
      invalidateCleanupInsights();
      if (cleanupState.kind === "marked") {
        cleanupOverview = null;
        await loadCleanupPage();
      } else {
        cleanupOverview = await provider.cleanupOverview();
        renderCleanupOverview();
      }
      await refreshAdvancedPlanSummary();
    });
  } catch (error) {
    checkbox.checked = !checkbox.checked;
    reportCleanupMutationError(error);
  } finally {
    checkbox.disabled = false;
  }
}

async function applyGroupAction(groupKey, action, button) {
  const thumbnailCount = Number(button.dataset.thumbnailCount) || 0;
  const cancellingThumbnailKeep = action === "keep_thumbnail" &&
    button.dataset.keepingThumbnails === "true";
  const thumbnailResult = cancellingThumbnailKeep
    ? `已取消保留 ${thumbnailCount.toLocaleString()} 個縮圖。`
    : `已保留 ${thumbnailCount.toLocaleString()} 個縮圖。`;
  if (action === "toggle_all") {
    const cancelling = button.dataset.deletingAllAttachments === "true";
    const keepingThumbnails = button.dataset.keepingThumbnails === "true";
    const chatTitle = button.dataset.chatTitle || "這個聊天室";
    const attachmentScope = keepingThumbnails ? "縮圖以外附件" : "所有附件";
    if (!await requestConfirmation({
      title: cancelling
        ? `取消刪除「${chatTitle}」的${attachmentScope}？`
        : `刪除「${chatTitle}」的${attachmentScope}？`,
      message: cancelling
        ? "要取消這個聊天室目前的附件刪除設定嗎？\n\n若同時啟用只保留縮圖，圖片原檔的刪除設定仍會保留。"
        : keepingThumbnails
          ? "這會刪除圖片原圖、影片、PDF、語音及其他附件；因為已啟用「只保留縮圖」，所有非空縮圖都會優先保留。原始備份不會被修改。"
          : "警告：這會刪除所有圖片原圖及縮圖，也包含影片、PDF、語音與其他附件。刪除縮圖後，聊天紀錄可能不再顯示圖片預覽；原始備份不會被修改。",
      confirmLabel: cancelling
        ? keepingThumbnails ? "取消刪除其他附件" : "取消刪除所有附件"
        : keepingThumbnails ? "確認刪除其他附件" : "確認刪除所有附件",
      danger: !cancelling
    })) return;
  }
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "套用中…";
  setStatus(action === "keep_thumbnail"
    ? cancellingThumbnailKeep ? "正在取消保留縮圖…" : "正在套用保留縮圖…"
    : "正在更新聊天室附件標記…", false);
  try {
    await runCleanupMutation({
      title: action === "keep_thumbnail"
        ? cancellingThumbnailKeep ? "正在取消保留縮圖" : "正在設定只保留縮圖"
        : "正在更新聊天室附件",
      message: "正在分批寫入清理計畫，請勿重複操作或關閉此視窗。",
      successMessage: action === "keep_thumbnail" ? thumbnailResult : "聊天室附件標記已更新。"
    }, async () => {
      cleanupOverview = await provider.applyCleanupGroupAction(groupKey, action);
      invalidateCleanupInsights();
      await loadCleanupPage({ verifySource: false });
      void refreshAdvancedPlanSummary();
    });
    setStatus(action === "keep_thumbnail" ? thumbnailResult : "已更新聊天室附件標記。", false);
  } catch (error) {
    reportCleanupMutationError(error);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function applyCategoryKeepThumbnails() {
  const category = cleanupState.category;
  if (!provider || !["all", "individual", "group", "community"].includes(category)) return;
  const label = categoryActionLabel(category);
  const cancelling = Boolean(
    cleanupCategoryActionState?.category === category &&
    cleanupCategoryActionState.keepingAllThumbnails
  );
  const thumbnailCount = Number(cancelling
    ? cleanupCategoryActionState?.protectedThumbnailCount
    : cleanupCategoryActionState?.thumbnailCandidateCount) || 0;
  const thumbnailResult = cancelling
    ? `已取消保留 ${thumbnailCount.toLocaleString()} 個縮圖。`
    : `已保留 ${thumbnailCount.toLocaleString()} 個縮圖。`;
  if (!await requestConfirmation({
    title: cancelling ? `取消${label}只保留縮圖？` : `將${label}只保留縮圖？`,
    message: cancelling
      ? `要批量取消${label}目前的只保留縮圖設定嗎？\n\n` +
        "將取消保護所有非空縮圖，並清除可安全配對之圖片原檔的手動標記；若仍啟用刪除所有附件，縮圖會重新加入清理計畫。安全自動標記及聊天室刪除計畫會保留。"
      : `要一次將${label}設定為只保留縮圖嗎？\n\n` +
        (cleanupCategoryActionState?.deletingAllAttachments
          ? "目前已啟用刪除所有附件；套用後會優先保留所有非空縮圖，其餘原圖、空縮圖、影片、PDF、語音與其他附件仍會刪除。"
          : "所有非空縮圖都會保留，不需要能與原圖配對；只有能安全配對的圖片原檔會加入清理計畫，PDF、影片、無縮圖及無法確認的附件不會額外標記。已整個排入清理的聊天室不會變更。"),
    confirmLabel: cancelling ? "取消全部只保留縮圖" : "全部只保留縮圖",
    danger: !cancelling
  })) return;
  try {
    cleanupOverview = await runCleanupMutation({
      title: cancelling ? `正在取消${label}只保留縮圖` : `正在設定${label}`,
      message: "正在分批寫入清理計畫，請勿重複操作或關閉此視窗。",
      successMessage: `${label}：${thumbnailResult}`
    }, async () => {
      const overview = await provider.applyCleanupCategoryAction(
        category,
        cancelling ? "clear_keep_thumbnail" : "keep_thumbnail"
      );
      cleanupPage = null;
      cleanupState.page = 1;
      cleanupState.groupKey = null;
      invalidateCleanupInsights();
      cleanupOverview = overview;
      await loadCleanupPage({ verifySource: false });
      void refreshAdvancedPlanSummary();
      return cleanupOverview;
    });
    setStatus(
      `${label}：${thumbnailResult}`,
      false
    );
  } catch (error) {
    reportCleanupMutationError(error);
  } finally {
    renderCategoryBulkActions();
  }
}

async function deleteCategoryAttachments() {
  const category = cleanupState.category;
  if (!provider || ![
    "all",
    "individual",
    "group",
    "community",
    "unreferenced",
    "unconfirmed"
  ].includes(category)) return;
  const label = categoryActionLabel(category);
  const cancelling = Boolean(
    cleanupCategoryActionState?.category === category &&
    cleanupCategoryActionState.deletingAllAttachments
  );
  const protectedThumbnailCount = Number(
    cleanupCategoryActionState?.protectedThumbnailCount
  ) || 0;
  const preservingThumbnails = protectedThumbnailCount > 0;
  const attachmentScope = preservingThumbnails ? "縮圖以外附件" : "所有附件";
  if (!await requestConfirmation({
    title: cancelling
      ? `取消刪除${label}的${attachmentScope}？`
      : `刪除${label}的${attachmentScope}？`,
    message: cancelling
      ? `要批量取消${label}目前的所有手動附件刪除標記嗎？\n\n` +
        (preservingThumbnails
          ? `目前受保護的 ${protectedThumbnailCount.toLocaleString()} 個縮圖仍會保留，而能安全配對的圖片原檔仍會刪除；安全自動標記及聊天室刪除計畫也會保留。`
          : "安全自動標記及聊天室刪除計畫會保留。")
      : `要將${label}內的所有附件加入清理計畫嗎？\n\n` +
        (preservingThumbnails
          ? `這會刪除圖片原圖、空縮圖、影片、PDF、語音及其他附件；目前受保護的 ${protectedThumbnailCount.toLocaleString()} 個非空縮圖會優先保留。此操作不受上方附件類型篩選影響，原始備份不會被修改。`
          : "警告：這會刪除所有圖片原圖及縮圖，也包含影片、PDF、語音與其他附件，且不受上方附件類型篩選影響。刪除縮圖後，聊天紀錄可能不再顯示圖片預覽；原始備份不會被修改。"),
    confirmLabel: cancelling
      ? preservingThumbnails ? "取消刪除其他附件" : "取消刪除所有附件"
      : preservingThumbnails ? "確認刪除其他附件" : "確認刪除所有附件",
    danger: !cancelling
  })) return;
  try {
    cleanupOverview = await runCleanupMutation({
      title: cancelling ? `正在取消${label}附件刪除` : `正在標記${label}附件`,
      message: "正在分批寫入整個分類的附件清理計畫，請勿重複操作或關閉此視窗。",
      successMessage: cancelling
        ? `${label}的${preservingThumbnails ? "其他附件" : "所有附件"}手動刪除標記已取消。`
        : `${label}的${attachmentScope}已加入清理計畫。`
    }, async () => {
      const overview = await provider.applyCleanupCategoryAction(
        category,
        cancelling ? "clear_delete_all" : "delete_all"
      );
      cleanupPage = null;
      cleanupState.page = 1;
      cleanupState.groupKey = null;
      invalidateCleanupInsights();
      cleanupOverview = overview;
      await loadCleanupPage({ verifySource: false });
      void refreshAdvancedPlanSummary();
      return cleanupOverview;
    });
    setStatus(
      cancelling
        ? `已批量取消${label}的${preservingThumbnails ? "其他附件" : "所有附件"}手動刪除標記。`
        : `已將${label}的${attachmentScope}加入清理計畫。`,
      false
    );
  } catch (error) {
    reportCleanupMutationError(error);
  } finally {
    renderCategoryBulkActions();
  }
}

async function deleteCategoryChats() {
  const category = cleanupState.category;
  if (!provider || !advancedMode || !["all", "individual", "group", "community"].includes(category)) {
    return;
  }
  const label = categoryActionLabel(category);
  const cancelling = Boolean(
    cleanupCategoryActionState?.category === category &&
    cleanupCategoryActionState.deletingAllChats
  );
  if (!await requestConfirmation({
    title: cancelling ? `取消刪除${label}的所有聊天室？` : `刪除${label}的所有聊天室？`,
    message: cancelling
      ? `要批量取消${label}目前的所有聊天室刪除計畫嗎？\n\n` +
        "聊天室、訊息與其附件會重新保留在建立出的瘦身檔。"
      : `要將${label}的所有聊天室、全部訊息與其附件加入清理計畫嗎？\n\n` +
        "這是整個聊天室層級的操作；原始備份不會被修改，但建立出的瘦身檔將不包含這些聊天室。",
    confirmLabel: cancelling ? "取消刪除所有聊天室" : "刪除所有聊天室",
    danger: !cancelling
  })) return;
  try {
    await runCleanupMutation({
      title: cancelling ? `正在取消${label}聊天室刪除` : `正在標記${label}聊天室`,
      message: "正在分批更新聊天室、訊息與附件清理狀態，請勿重複操作或關閉此視窗。",
      successMessage: cancelling
        ? `${label}的所有聊天室刪除計畫已取消。`
        : `${label}的所有聊天室已加入清理計畫。`
    }, async () => {
      const report = await provider.setCleanupCategoryChatsRemovalPlanned(category, !cancelling);
      renderAdvancedReport(report);
      cleanupPage = cleanupOverview = null;
      cleanupState.page = 1;
      cleanupState.groupKey = null;
      invalidateCleanupInsights();
      await Promise.all([loadChats(null), loadCleanupPage()]);
    });
    setStatus(
      cancelling
        ? `已批量取消${label}的所有聊天室刪除計畫。`
        : `已將${label}的所有聊天室加入清理計畫。`,
      false
    );
  } catch (error) {
    reportCleanupMutationError(error);
  } finally {
    renderCategoryBulkActions();
  }
}

async function applySafeAttachmentCleanup(message) {
  if (!provider) return;
  elements.planSafeAttachmentCleanup.disabled = true;
  try {
    await runCleanupMutation({
      title: "正在更新安全清理標記",
      message: "正在分批寫入圖片原檔清理計畫，請勿重複操作。",
      successMessage: message
    }, async () => {
      await provider.planSafeAttachmentCleanup();
      cleanupPage = null;
      cleanupOverview = null;
      cleanupState.page = 1;
      cleanupState.groupKey = null;
      invalidateCleanupInsights();
      await loadCleanupPage({ verifySource: false });
      void refreshAdvancedPlanSummary();
    });
    setStatus(message, false);
  } catch (error) {
    reportCleanupMutationError(error);
  } finally {
    if (cleanupOverview) renderCleanupOverview();
  }
}

async function toggleSafeAttachmentCleanup() {
  if (!provider || !cleanupOverview) return;
  const automaticMarked = Number(cleanupOverview.automaticMarkedCount) || 0;
  const automaticCandidates = Number(cleanupOverview.automaticCandidateCount) || 0;
  const prompt = automaticMarked
    ? "要取消安全自動清理的標記嗎？手動標記與聊天室清理計畫會保留。"
    : `要標記 ${automaticCandidates.toLocaleString()} 個安全候選附件嗎？\n\n` +
      "只會移除已確認的圖片原檔，並保留同一訊息的非空縮圖；原始備份不會被修改。";
  if (!await requestConfirmation({
    title: automaticMarked ? "取消安全自動清理？" : "套用安全自動清理？",
    message: prompt,
    confirmLabel: automaticMarked ? "取消自動標記" : "套用安全標記",
    danger: !automaticMarked
  })) return;
  await applySafeAttachmentCleanup(
    automaticMarked ? "已取消安全自動清理標記。" : "已套用安全自動清理標記。"
  );
}

async function clearManualAttachmentPlan() {
  if (!provider || !cleanupOverview || !cleanupOverview.manualMarkedCount) return;
  if (!await requestConfirmation({
    title: "清除手動標記？",
    message:
      `要清除 ${Number(cleanupOverview.manualMarkedCount).toLocaleString()} 個手動標記嗎？\n\n` +
      "安全自動清理與聊天室清理計畫會保留。",
    confirmLabel: "清除手動標記",
    danger: true
  })) return;
  elements.clearManualAttachmentPlan.disabled = true;
  try {
    await runCleanupMutation({
      title: "正在清除手動標記",
      message: "正在分批移除手動附件標記，請勿重複操作。",
      successMessage: "手動附件標記已清除。"
    }, async () => {
      await provider.clearManualAttachmentPlan();
      cleanupPage = null;
      cleanupOverview = null;
      cleanupState.page = 1;
      cleanupState.groupKey = null;
      invalidateCleanupInsights();
      await loadCleanupPage({ verifySource: false });
    });
    setStatus("已清除手動附件標記；自動與聊天室計畫仍保留。", false);
  } catch (error) {
    reportCleanupMutationError(error);
  } finally {
    if (cleanupOverview) renderCleanupOverview();
  }
}

function setAdvancedMode(enabled) {
  advancedMode = Boolean(enabled);
  elements.advancedMode.checked = advancedMode;
  if (!advancedMode && duplicateLoading) void cancelCurrentOperation("duplicate");
  if (!advancedMode) setDuplicateAutoMerge(false);
  else renderDuplicateAutoMergeControl();
  if (!advancedMode && activeWorkspaceView === "duplicates") {
    setWorkspaceView("advanced");
  }
  elements.cleanupNoAttachments.hidden = !advancedMode;
  elements.cleanupNoAttachments.disabled = !advancedMode;
  if (!advancedMode && cleanupState.category === "no_attachments") {
    cleanupState.category = "all";
    cleanupState.page = 1;
    cleanupOverview = null;
    invalidateCleanupInsights();
    elements.cleanupCategory.value = "all";
  }
  elements.cleanupKind.disabled = cleanupState.category === "no_attachments";
  elements.advancedModeState.textContent = advancedMode ? "進階模式已開啟" : "進階模式未開啟";
  elements.advancedModeState.classList.toggle("enabled", advancedMode);
  elements.advancedLocked.classList.toggle("hidden", advancedMode);
  elements.advancedContent.classList.toggle("hidden", !advancedMode);
  renderCategoryBulkActions();
  if (cleanupPage) {
    if (cleanupState.groupKey) {
      void loadCleanupPage();
    } else {
      renderCleanupPage();
    }
  }
  if (advancedMode && provider) void loadAdvancedReport();
}

function renderAdvancedReport(report) {
  advancedReport = report;
  elements.advancedLineEmpty.textContent = report.lineEmptyChats.toLocaleString();
  elements.advancedLineSystem.textContent = report.lineSystemOnlyChats.toLocaleString();
  elements.advancedSquareEmpty.textContent = report.squareAvailable
    ? report.squareEmptyChats.toLocaleString()
    : "未提供";
  elements.advancedSquareSystem.textContent = report.squareAvailable
    ? report.squareSystemOnlyChats.toLocaleString()
    : "未提供";
  elements.advancedOrphanMessages.textContent = report.squareAvailable
    ? report.orphanCommunityMessages.toLocaleString()
    : "未提供";
  elements.advancedPlannedChats.textContent = report.plannedChats.toLocaleString();
  elements.advancedPlannedMessages.textContent =
    report.plannedDatabaseMessages.toLocaleString();
  elements.advancedPlannedFiles.textContent = report.plannedFiles.toLocaleString();
  elements.advancedPlannedBytes.textContent = formatBytes(report.plannedBytes);
  elements.planAutomaticCleanup.textContent = report.automaticCleanupPlanned
    ? "取消清理所有偵測項目"
    : "清理所有偵測項目";
  elements.planAutomaticCleanup.classList.toggle(
    "danger-button",
    !report.automaticCleanupPlanned
  );
}

async function refreshAdvancedPlanSummary() {
  if (!provider || !advancedMode) return;
  try {
    renderAdvancedReport(await provider.advancedCleanupReport());
  } catch (error) {
    reportCleanupMutationError(error);
  }
}

async function loadAdvancedReport() {
  if (!provider || !advancedMode || advancedLoading) return;
  advancedLoading = true;
  elements.refreshAdvancedReport.disabled = true;
  elements.planAutomaticCleanup.disabled = true;
  try {
    renderAdvancedReport(await provider.advancedCleanupReport());
  } catch (error) {
    reportCleanupMutationError(error);
  } finally {
    advancedLoading = false;
    elements.refreshAdvancedReport.disabled = false;
    elements.planAutomaticCleanup.disabled = !advancedReport;
  }
}

async function setChatRemoval(source, chatPk, title, planned) {
  if (!provider || !advancedMode) return;
  const action = planned ? "保留" : "刪除";
  if (!planned && !await requestConfirmation({
    title: `刪除「${title}」？`,
    message:
      `要把「${title}」整個聊天室、全部訊息與其附件加入候選檔清理計畫嗎？\n\n原始備份不會被修改。`,
    confirmLabel: "加入刪除計畫",
    danger: true
  })) {
    return;
  }
  try {
    await runCleanupMutation({
      title: planned ? "正在保留聊天室" : "正在加入聊天室清理計畫",
      message: "正在更新聊天室、訊息與附件清理狀態，請勿重複操作。",
      successMessage: planned ? "聊天室已從清理計畫移除。" : "聊天室已加入清理計畫。"
    }, async () => {
      const report = await provider.setChatRemovalPlanned(source, chatPk, !planned);
      if (selectedChat &&
          selectedChat.pk === Number(chatPk) &&
          (selectedChat.source || "line") === source) {
        selectedChat.plannedForRemoval = !planned;
      }
      renderAdvancedReport(report);
      cleanupPage = cleanupOverview = null;
      invalidateCleanupInsights();
      await Promise.all([
        loadChats(null),
        loadCleanupPage()
      ]);
    });
  } catch (error) {
    if (isOperationCancelled(error)) {
      reportCleanupMutationError(error);
    } else {
      setStatus(`${action}聊天室失敗：${error.message}`, true);
    }
  }
}

async function toggleAutomaticCleanup() {
  if (!provider || !advancedMode) return;
  if (!advancedReport) {
    await loadAdvancedReport();
    if (!advancedReport) return;
  }
  const issueCount = advancedReport
    .lineEmptyChats +
    advancedReport.lineSystemOnlyChats +
    advancedReport.squareEmptyChats +
    advancedReport.squareSystemOnlyChats +
    advancedReport.orphanCommunityMessages;
  const planned = advancedReport.automaticCleanupPlanned;
  const prompt = planned
    ? "要從清理計畫取消所有自動偵測項目嗎？手動加入的聊天室與附件會保留。"
    : `要將偵測到的 ${issueCount.toLocaleString()} 個項目加入清理計畫嗎？\n\n` +
      "包含空聊天室、只有系統事件的聊天室，以及社群資料庫中找不到聊天室的孤兒訊息。";
  if (!await requestConfirmation({
    title: planned ? "取消自動清理？" : "加入自動清理？",
    message: prompt,
    confirmLabel: planned ? "取消清理計畫" : "加入清理計畫",
    danger: !planned
  })) {
    return;
  }
  elements.planAutomaticCleanup.disabled = true;
  try {
    await runCleanupMutation({
      title: planned ? "正在取消自動清理" : "正在套用自動清理",
      message: "正在更新偵測項目的資料庫清理計畫，請勿重複操作。",
      successMessage: planned ? "自動偵測項目已取消。" : "自動偵測項目已加入清理計畫。"
    }, async () => {
      renderAdvancedReport(await provider.planAutomaticCleanup());
      cleanupPage = cleanupOverview = null;
      invalidateCleanupInsights();
      await Promise.all([loadChats(null), loadCleanupPage()]);
    });
    setStatus(planned ? "已取消所有自動偵測項目。" : "已將所有偵測項目加入清理計畫。");
  } catch (error) {
    reportCleanupMutationError(error);
  } finally {
    elements.planAutomaticCleanup.disabled = false;
  }
}

function setCandidateBuildDisabled(disabled) {
  const blockedByPreflight = Boolean(
    cleanupPreflight && Number(cleanupPreflight.blockerCount) > 0
  );
  elements.buildCandidate.disabled = disabled || blockedByPreflight;
  elements.advancedBuildCandidate.disabled = disabled || blockedByPreflight;
}

async function buildCandidate() {
  let modalShown = false;
  try {
    if (!await requestRestoreChecklist()) return;
    const output = await bridge.chooseCandidateOutput();
    if (!output) return;
    const initialMessage = `正在建立 ${output.displayName}，請勿關閉此視窗。`;
    setStatus(initialMessage);
    showPackageModal(initialMessage);
    modalShown = true;
    packageInProgress = true;
    setCandidateBuildDisabled(true);
    const linkDuplicates =
      advancedMode && duplicateScanComplete && duplicateAutoMergeEnabled;
    let report = await provider.buildCandidate(output.token, {
      fullCrc: true,
      linkDuplicates,
      allowLineSquareRebuild: false
    });
    if (report && report.lineSquareRebuildRequired === true) {
      updatePackageModalProgress(
        0,
        "偵測到 LineSquare.sqlite 損壞，正在等待是否重建的確認。"
      );
      const rebuild = await requestConfirmation({
        title: "LineSquare.sqlite 已損壞",
        message:
          "若繼續，候選檔會重建空白的 LineSquare.sqlite，所有社群聊天室與社群訊息都不會保留。\n\n" +
          "一般 LINE 聊天資料不受影響，原始備份也不會被修改。是否重建並繼續建立瘦身檔？",
        cancelLabel: "取消建立",
        confirmLabel: "重建並繼續",
        danger: true
      });
      if (!rebuild) {
        try {
          await bridge.discardCandidateOutput(output.token);
        } catch (error) {
          console.warn(`Unable to discard candidate output authorization: ${error.message}`);
        }
        const message = "已取消建立；LineSquare.sqlite 與原始備份均未修改。";
        setStatus(message, false);
        packageInProgress = false;
        completePackageModal(false, "已取消建立", message);
        return;
      }
      const rebuildMessage =
        `已授權重建空白 LineSquare.sqlite，正在繼續建立 ${output.displayName}。`;
      setStatus(rebuildMessage);
      updatePackageModalProgress(0, rebuildMessage);
      report = await provider.buildCandidate(output.token, {
        fullCrc: true,
        linkDuplicates,
        allowLineSquareRebuild: true
      });
    }
    renderCandidateReport(report);
    updatePackageModalProgress(100, "瘦身檔已建立，正在等待工作階段保留選擇。");
    const deleteSession = await requestConfirmation({
      title: "要刪除已分析的工作階段嗎？",
      message:
        "瘦身 .imazingapp 已成功建立。保留工作階段可讓你未來直接載入目前的分析結果，不必重新掃描大型備份。\n\n" +
        "選擇刪除只會清理 LINE Cheater 的本機分析快取；原始備份與剛建立的瘦身 .imazingapp 都不會被刪除。",
      cancelLabel: "保留工作階段",
      confirmLabel: "刪除工作階段",
      danger: true
    });
    try {
      const cacheResult = await bridge.finalizeCandidateSession(!deleteSession);
      report = { ...report, ...cacheResult };
    } catch (error) {
      report = {
        ...report,
        cacheCleared: false,
        cacheRetained: true,
        cacheCleanupWarning: `無法完成工作階段關閉程序：${error.message}`
      };
    }
    renderCandidateReport(report);
    let successMessage =
      `候選檔完成：保留 ${report.outputEntries.toLocaleString()} 筆、` +
      `移除 ${report.removedEntries.toLocaleString()} 個檔案項目、` +
      `以連結合併 ${report.linkedDuplicateEntries.toLocaleString()} 個重複附件、` +
      `${report.removedChats.toLocaleString()} 個聊天室與 ` +
      `${report.removedMessages.toLocaleString()} 則 SQLite 訊息，完整 CRC 驗證完成。`;
    if (report.linkedDuplicateEntries > 0) {
      successMessage += " 此候選檔使用實驗性 symbolic link，請先以 iMazing 測試還原。";
    }
    if (report.cacheRetained) {
      successMessage += report.sessionPath
        ? ` 已保留分析工作階段：${report.sessionPath}。`
        : " 分析工作階段已保留；未來可從歡迎頁直接載入。";
      if (report.cacheCleanupWarning) {
        successMessage += ` 注意：${report.cacheCleanupWarning}。`;
      }
    } else if (report.cacheCleared) {
      successMessage += " LINE Cheater 的本機快取已清除；下次請重新選擇來源。";
    } else {
      successMessage +=
        ` 候選檔已成功，但本機快取未能完全清除：` +
        `${report.cacheCleanupWarning || "請重新啟動 LINE Cheater 後再試。"}。`;
    }
    if (!report.cacheRetained && report.cacheCleared && report.cacheCleanupWarning) {
      successMessage += ` 注意：${report.cacheCleanupWarning}。`;
    }
    setStatus(successMessage);
    packageInProgress = false;
    completePackageModal(false, "瘦身 .imazingapp 已建立", successMessage);
    resetAfterCandidateBuild();
  } catch (error) {
    if (isOperationCancelled(error)) {
      const message = "已取消建立候選檔；部分輸出與暫存資料已清除。";
      setStatus(message, false);
      packageInProgress = false;
      if (modalShown) completePackageModal(false, "已取消建立", message);
      return;
    }
    setStatus(error.message, true);
    packageInProgress = false;
    if (modalShown) {
      completePackageModal(true, "建立失敗", `瘦身 .imazingapp 建立失敗：${error.message}`);
    }
  } finally {
    packageInProgress = false;
    setCandidateBuildDisabled(!provider);
  }
}

function updateCleanupFilter() {
  cleanupState.kind = elements.cleanupKind.value;
  cleanupState.category = elements.cleanupCategory.value;
  cleanupCategoryActionState = null;
  if (cleanupState.category === "no_attachments") {
    cleanupState.kind = "all";
    elements.cleanupKind.value = "all";
  }
  elements.cleanupKind.disabled = cleanupState.category === "no_attachments";
  cleanupState.sort = elements.cleanupSort.value;
  cleanupState.page = 1;
  renderCategoryBulkActions();
  void loadCleanupPage();
}

for (const button of document.querySelectorAll("[data-source]")) {
  button.addEventListener("click", () => void openSource(button.dataset.source));
}
elements.refreshSessions.addEventListener("click", () => void loadSavedSessions());
elements.savedSessionList.addEventListener("click", (event) => {
  const deleteButton = event.target.closest("button[data-session-delete]");
  if (deleteButton) {
    void deleteSavedSession(deleteButton);
    return;
  }
  const button = event.target.closest("button[data-session-open]");
  if (!button || button.disabled) return;
  void openSource(button.dataset.sessionKind, button.dataset.sessionOpen);
});
elements.enterWorkspace.addEventListener("click", enterWorkspace);
elements.changeSource.addEventListener("click", returnToWelcome);
const sidebarItems = Array.from(document.querySelectorAll("[data-view]"));
for (const button of sidebarItems) {
  button.addEventListener("click", () => void requestWorkspaceView(button.dataset.view));
  button.addEventListener("keydown", (event) => {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const visibleItems = sidebarItems.filter((item) => !item.classList.contains("hidden"));
    const current = visibleItems.indexOf(button);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? visibleItems.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + visibleItems.length) %
          visibleItems.length;
    visibleItems[next].focus();
  });
}
elements.chatSearch.addEventListener("input", handleChatSearchInput);
elements.chatSearch.addEventListener("search", handleChatSearchInput);
elements.attachmentSort.addEventListener("change", () => {
  attachmentFilter.sort = elements.attachmentSort.value;
  applyAttachmentFilters();
});
elements.attachmentChatClear.addEventListener("click", () => {
  if (!attachmentFilter.chats.size) return;
  attachmentFilter.chats.clear();
  for (const box of elements.attachmentChat.querySelectorAll("input[type=\"checkbox\"]")) {
    box.checked = false;
  }
  applyAttachmentFilters();
});
elements.attachmentChatMode.addEventListener("change", () => {
  attachmentFilter.chatMode = elements.attachmentChatMode.value === "exclude"
    ? "exclude"
    : "include";
  applyAttachmentFilters();
});
elements.attachmentTypeMode.addEventListener("change", () => {
  attachmentFilter.typeMode = elements.attachmentTypeMode.value === "exclude"
    ? "exclude"
    : "include";
  applyAttachmentFilters();
});
elements.attachmentIncludeThumbnails.addEventListener("change", () => {
  attachmentFilter.includeThumbnails = elements.attachmentIncludeThumbnails.checked;
  buildAttachmentChatOptions();
  applyAttachmentFilters();
});
elements.attachmentSearch.addEventListener("input", handleAttachmentSearchInput);
elements.attachmentSearch.addEventListener("search", handleAttachmentSearchInput);
elements.attachmentPrevious.addEventListener("click", () => changeAttachmentPage(-1));
elements.attachmentNext.addEventListener("click", () => changeAttachmentPage(1));
elements.exportFilteredAttachments.addEventListener("click", () => void exportFilteredAttachmentsAction());
elements.previousChats.addEventListener("click", () => void loadChats("previous"));
elements.nextChats.addEventListener("click", () => void loadChats("next"));
elements.previousMessages.addEventListener("click", () => void loadMessages("previous"));
elements.nextMessages.addEventListener("click", () => void loadMessages("next"));
elements.retryChats.addEventListener("click", () => void loadChats(chatRetryDirection));
elements.retryMessages.addEventListener("click", () => void loadMessages(messageRetryDirection));
elements.advancedMode.addEventListener("change", async () => {
  if (elements.advancedMode.checked &&
      !await requestConfirmation({
        title: "開啟進階模式？",
        message:
          "進階模式可以建立會刪除聊天室、重寫 SQLite，並以 symbolic link 合併重複附件的清理計畫。要繼續開啟嗎？",
        confirmLabel: "開啟進階模式",
        danger: true
      })) {
    elements.advancedMode.checked = false;
    return;
  }
  setAdvancedMode(elements.advancedMode.checked);
});
elements.refreshAdvancedReport.addEventListener("click", () => void loadAdvancedReport());
elements.planAutomaticCleanup.addEventListener("click", () => void toggleAutomaticCleanup());
elements.scanCatalog.addEventListener("click", () => void scanCatalog());
elements.refreshCleanupPreflight.addEventListener("click", () => void refreshCleanupPreflight());
elements.hashDuplicates.addEventListener("click", () => void hashDuplicates());
elements.duplicateAutoMerge.addEventListener("click", toggleDuplicateAutoMerge);
elements.cancelDuplicateScan.addEventListener("click", () => void cancelCurrentOperation("duplicate"));
elements.buildCandidate.addEventListener("click", () => void buildCandidate());
elements.advancedBuildCandidate.addEventListener("click", () => void buildCandidate());
elements.loadModalCancel.addEventListener("click", () => void cancelCurrentOperation("load"));
elements.packageModalCancel.addEventListener("click", () => void cancelCurrentOperation("package"));
elements.packageModalDonate.addEventListener("click", () => {
  void bridge.openExternal("https://zeuik.gumroad.com/l/line-cheater").catch((error) => setStatus(error.message, true));
});
elements.operationModalCancel.addEventListener("click", () => {
  void cancelCurrentOperation(exportInProgress ? "export" : "cleanup");
});
elements.packageModalClose.addEventListener("click", () => void requestModalClose("package"));
elements.operationModalClose.addEventListener("click", () => void requestModalClose("operation"));
elements.restoreCheckOriginal.addEventListener("change", updateRestoreChecklistState);
elements.restoreCheckTest.addEventListener("change", updateRestoreChecklistState);
elements.restoreCheckVerify.addEventListener("change", updateRestoreChecklistState);
elements.restoreCheckCancel.addEventListener("click", () => void requestRestoreChecklistCancellation());
elements.restoreCheckConfirm.addEventListener("click", () => closeRestoreChecklist(true));
elements.imageModalClose.addEventListener("click", () => void requestModalClose("image"));
elements.imageModal.addEventListener("click", (event) => {
  if (event.target === elements.imageModal ||
      event.target.classList.contains("image-modal-backdrop")) {
    void requestModalClose("image");
  }
});
elements.confirmationModalCancel.addEventListener("click", () => closeConfirmationModal(false));
elements.confirmationModalConfirm.addEventListener("click", () => closeConfirmationModal(true));
elements.confirmationModal.addEventListener("click", (event) => {
  if (event.target === elements.confirmationModal ||
      event.target.classList.contains("confirmation-modal-backdrop")) {
    closeConfirmationModal(false);
  }
});
document.addEventListener("keydown", (event) => {
  const openModal = [
    elements.confirmationModal,
    elements.imageModal,
    elements.operationModal,
    elements.packageModal,
    elements.loadModal,
    elements.restoreChecklistModal
  ].find((modal) => !modal.classList.contains("hidden"));
  if (!openModal) return;
  if (event.key === "Tab") {
    trapModalFocus(event, openModal);
    return;
  }
  if (event.key !== "Escape") return;
  if (openModal === elements.confirmationModal) closeConfirmationModal(false);
  else if (openModal === elements.imageModal) void requestModalClose("image");
  else if (openModal === elements.restoreChecklistModal) void requestRestoreChecklistCancellation();
  else if (openModal === elements.operationModal &&
           !cleanupMutationInProgress && !exportInProgress && !sessionDeletionInProgress) {
    void requestModalClose("operation");
  } else if (openModal === elements.packageModal && !packageInProgress) {
    void requestModalClose("package");
  }
});
elements.searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  activeSearch = elements.searchQuery.value.trim();
  messageCursor = messageBeforeCursor = null;
  messagePageNumber = 1;
  messageRetryDirection = "initial";
  try {
    await loadMessages("initial");
  } catch (error) {
    setStatus(error.message, true);
  }
});
elements.clearSearch.addEventListener("click", () => {
  if (!activeSearch || !selectedChat) return;
  activeSearch = null;
  elements.searchQuery.value = "";
  messageCursor = messageBeforeCursor = null;
  messagePageNumber = 1;
  void loadMessages("initial");
});
elements.exportChatImages.addEventListener("click", () => void exportCurrentChat(true));
elements.exportChatAttachments.addEventListener("click", () => void exportCurrentChat(false));
elements.exportChatConversation.addEventListener("click", () => void exportCurrentConversation());
elements.cleanupKind.addEventListener("change", updateCleanupFilter);
elements.cleanupCategory.addEventListener("change", updateCleanupFilter);
elements.cleanupSort.addEventListener("change", updateCleanupFilter);
elements.changeCleanupPlan.addEventListener("click", () => void changeCleanupPlan());
elements.enterManualCleanup.addEventListener("click", enterManualCleanup);
elements.cleanupPlanCards.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-plan-profile]");
  if (button) void selectCleanupPlan(button.dataset.planProfile);
});
elements.planSafeAttachmentCleanup.addEventListener("click", () => void toggleSafeAttachmentCleanup());
elements.clearManualAttachmentPlan.addEventListener("click", () => void clearManualAttachmentPlan());
elements.categoryKeepThumbnails.addEventListener("click", () => void applyCategoryKeepThumbnails());
elements.categoryDeleteAttachments.addEventListener("click", () => void deleteCategoryAttachments());
elements.categoryDeleteChats.addEventListener("click", () => void deleteCategoryChats());
elements.cleanupSearch.addEventListener("input", () => {
  clearTimeout(cleanupSearchTimer);
  cleanupSearchTimer = setTimeout(() => {
    cleanupState.search = elements.cleanupSearch.value.trim();
    cleanupState.page = 1;
    void loadCleanupPage();
  }, 250);
});
window.addEventListener("resize", () => {
  clearTimeout(cleanupResizeTimer);
  cleanupResizeTimer = setTimeout(() => {
    if (cleanupAlbumSession) updateCleanupAlbumSpacers(cleanupAlbumSession);
  }, 180);
});
elements.categorySummary.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-category]");
  if (!button) return;
  cleanupState.category = button.dataset.category || "all";
  cleanupCategoryActionState = null;
  cleanupState.groupKey = null;
  cleanupState.page = 1;
  elements.cleanupCategory.value = cleanupState.category;
  renderCategoryBulkActions();
  void loadCleanupPage();
});
elements.cleanupPageInput.addEventListener("blur", commitCleanupPageInput);
elements.cleanupPageInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  commitCleanupPageInput();
  elements.cleanupPageInput.blur();
});
elements.cleanupPrev.addEventListener("click", () => {
  if (cleanupState.groupKey || !cleanupPage || cleanupState.page <= 1) return;
  cleanupState.page -= 1;
  void loadCleanupPage();
});
elements.cleanupNext.addEventListener("click", () => {
  if (cleanupState.groupKey || !cleanupPage || cleanupState.page >= cleanupPage.totalPages) return;
  cleanupState.page += 1;
  void loadCleanupPage();
});
elements.cleanupList.addEventListener("scroll", handleCleanupAlbumScroll, { passive: true });
elements.cleanupList.addEventListener("click", (event) => {
  const chatRemoval = event.target.closest("button[data-chat-removal]");
  if (chatRemoval) {
    void setChatRemoval(
      chatRemoval.dataset.chatSource,
      Number(chatRemoval.dataset.chatPk),
      chatRemoval.dataset.chatTitle,
      chatRemoval.dataset.planned === "true"
    );
    return;
  }
  const open = event.target.closest("button[data-open-group]");
  if (open) {
    cleanupState.groupKey = open.dataset.openGroup;
    syncCleanupPageInput();
    void loadCleanupPage();
    return;
  }
  const back = event.target.closest("button[data-cleanup-back]");
  if (back) {
    cleanupState.groupKey = null;
    void loadCleanupPage();
    return;
  }
  const action = event.target.closest("button[data-group-action]");
  if (action) {
    void applyGroupAction(action.dataset.groupKey, action.dataset.groupAction, action);
  }
});
elements.cleanupList.addEventListener("change", (event) => {
  const checkbox = event.target.closest("input[data-attachment-path]");
  if (checkbox) void changeAttachmentMark(checkbox);
});
elements.duplicateGroups.addEventListener("click", (event) => {
  const expand = event.target.closest("button[data-duplicate-expand]");
  if (!expand || duplicateLoading) return;
  duplicateExpandedSha = duplicateExpandedSha === expand.dataset.duplicateExpand
    ? null
    : expand.dataset.duplicateExpand;
  if (duplicatePage) renderDuplicatePage(duplicatePage);
});
elements.duplicateGroups.addEventListener("change", (event) => {
  const checkbox = event.target.closest("input[data-duplicate-sha][data-attachment-path]");
  if (checkbox) void changeDuplicateMark(checkbox);
});
elements.duplicatePrev.addEventListener("click", () => {
  if (duplicatePageNumber > 1) void loadDuplicateGroups(duplicatePageNumber - 1);
});
elements.duplicateNext.addEventListener("click", () => {
  if (duplicatePage && duplicatePage.nextCursor) void loadDuplicateGroups(duplicatePageNumber + 1);
});

bridge.on("sourcePrepareProgress", (event) => {
  if (elements.loadModal.classList.contains("hidden")) return;
  if (event.phase === "reading_archive_index") {
    updateLoadModalProgress(4, "正在讀取備份索引…");
    return;
  }
  const total = Number(event.totalBytes) || 0;
  const staged = Math.min(Number(event.stagedBytes) || 0, total);
  const ratio = total ? staged / total : 0;
  updateLoadModalProgress(
    5 + ratio * 6,
    total
      ? `正在取出備份中的 SQLite…（${formatBytes(staged)} / ${formatBytes(total)}）`
      : "正在取出備份中的 SQLite…"
  );
});
bridge.on("catalogProgress", (event) => {
  elements.progress.removeAttribute("value");
  elements.catalogSummary.textContent =
    `已掃描 ${event.files.toLocaleString()} 個檔案，找到 ${event.attachments.toLocaleString()} 個附件`;
  if (!elements.loadModal.classList.contains("hidden")) {
    const percent = activeSourceBytes > 0
      ? 20 + Math.min(38, (Number(event.bytes) / activeSourceBytes) * 38)
      : Math.min(58, 20 + Math.log10(Math.max(1, Number(event.files))) * 9);
    updateLoadModalProgress(
      percent,
      `正在建立檔案索引…（${event.files.toLocaleString()} 個檔案）`
    );
  }
});
bridge.on("catalogContextProgress", (event) => {
  const repairTotal = Number(event.repairTotalFiles) || 0;
  if (repairTotal > 0) {
    const repaired = Math.min(Number(event.repairedFiles) || 0, repairTotal);
    elements.catalogSummary.textContent =
      `正在修復原圖關聯：${repaired.toLocaleString()} / ${repairTotal.toLocaleString()} 個附件`;
    if (!elements.loadModal.classList.contains("hidden")) {
      updateLoadModalProgress(
        90 + (repaired / repairTotal) * 3,
        `正在修復原圖與縮圖關聯…（${repaired.toLocaleString()} / ${repairTotal.toLocaleString()}）`
      );
    }
    return;
  }
  elements.progress.max = Math.max(event.totalFiles, 1);
  elements.progress.value = event.processedFiles;
  elements.catalogSummary.textContent =
    `正在比對 SQLite：${event.processedFiles.toLocaleString()} / ${event.totalFiles.toLocaleString()} 個附件`;
  if (!elements.loadModal.classList.contains("hidden")) {
    const ratio = event.totalFiles
      ? Number(event.processedFiles) / Number(event.totalFiles)
      : 1;
    updateLoadModalProgress(
      60 + ratio * 30,
      `正在比對 SQLite…（${event.processedFiles.toLocaleString()} / ${event.totalFiles.toLocaleString()}）`
    );
  }
});
bridge.on("cleanupMutationProgress", (event) => {
  if (elements.operationModal.classList.contains("hidden")) return;
  updateOperationModalProgress(
    Number(event.processedRecords) || 0,
    Number(event.totalRecords) || 0,
    event.phase || "寫入中"
  );
});
bridge.on("exportProgress", (event) => {
  if (elements.operationModal.classList.contains("hidden")) return;
  updateOperationModalProgress(
    Number(event.processedBytes) || 0,
    Number(event.totalBytes) || 0,
    event.phase || "匯出中",
    "bytes"
  );
});
bridge.on("conversationExportProgress", (event) => {
  if (elements.operationModal.classList.contains("hidden")) return;
  const attachmentsPending = Number(event.totalAttachments) > 0 &&
    Number(event.processedAttachments) < Number(event.totalAttachments);
  updateOperationModalProgress(
    attachmentsPending ? Number(event.processedBytes) || 0 : Number(event.processedMessages) || 0,
    attachmentsPending ? Number(event.totalBytes) || 0 : Number(event.totalMessages) || 0,
    event.phase || "輸出完整討論串",
    attachmentsPending ? "bytes" : "則訊息"
  );
});
bridge.on("searchIndexProgress", (event) => {
  if (!messageLoading || !activeSearch) return;
  const processed = Number(event.processedMessages) || 0;
  elements.messageStatus.textContent = processed
    ? `首次搜尋正在建立 FTS5 索引…已整理 ${processed.toLocaleString()} 則訊息`
    : "首次搜尋正在建立 FTS5 索引…";
});
bridge.on("candidateProgress", (event) => {
  elements.progress.max = Math.max(event.totalBytes, 1);
  elements.progress.value = event.processedBytes;
  if (!elements.packageModal.classList.contains("hidden")) {
    const ratio = event.totalBytes
      ? Number(event.processedBytes) / Number(event.totalBytes)
      : 1;
    updatePackageModalProgress(
      ratio * 100,
      `正在寫入檔案…（${event.processedEntries.toLocaleString()} / ${event.totalEntries.toLocaleString()}）`
    );
  }
});
bridge.on("duplicateHashProgress", (event) => {
  const processed = Number(event.processedFiles) || 0;
  const total = Number(event.candidateFiles) || 0;
  elements.duplicateProgressLabel.textContent = total
    ? `正在計算 SHA-256… ${processed.toLocaleString()} / ${total.toLocaleString()}`
    : "正在計算 SHA-256…";
});

void loadSavedSessions();
