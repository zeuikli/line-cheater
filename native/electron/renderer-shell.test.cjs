"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = __dirname;
const html = fs.readFileSync(path.join(root, "renderer.html"), "utf8");
const renderer = fs.readFileSync(path.join(root, "renderer.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const main = fs.readFileSync(path.join(root, "main.cjs"), "utf8");
const sessionCache = fs.readFileSync(path.join(root, "session-cache.cjs"), "utf8");
const updateChecker = fs.readFileSync(path.join(root, "update-checker.cjs"), "utf8");
const preload = fs.readFileSync(path.join(root, "preload.cjs"), "utf8");
const macPackager = fs.readFileSync(
  path.join(root, "scripts", "package-macos.cjs"),
  "utf8"
);
const dmgPackager = fs.readFileSync(
  path.join(root, "scripts", "package-dmg.sh"),
  "utf8"
);
const dmgNotarizer = fs.readFileSync(
  path.join(root, "scripts", "notarize-dmg.sh"),
  "utf8"
);
const signingImporter = fs.readFileSync(
  path.join(root, "scripts", "import-signing-keychain.sh"),
  "utf8"
);
const packageVerifier = fs.readFileSync(
  path.join(root, "scripts", "verify-macos-package.sh"),
  "utf8"
);
const macWorkflow = fs.readFileSync(
  path.join(root, "../../.github/workflows/release-macos.yml"),
  "utf8"
);
const windowsPackager = fs.readFileSync(
  path.join(root, "scripts", "package-windows.cjs"),
  "utf8"
);
const macEntitlements = fs.readFileSync(
  path.join(root, "entitlements.mac.plist"),
  "utf8"
);
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const landingHtml = fs.readFileSync(path.join(root, "../../index.html"), "utf8");
const landingScript = fs.readFileSync(path.join(root, "../../app.js"), "utf8");
const landingStyles = fs.readFileSync(path.join(root, "../../styles.css"), "utf8");

test("uses LINE Cheater consistently as the desktop product name", () => {
  assert.match(html, /<title>LINE Cheater<\/title>/);
  assert.doesNotMatch(html, /LINE Backup Reader Native/);
  assert.doesNotMatch(html, /LINE BACKUP TOOL/);
  assert.match(html, /你的 LINE 清得乾乾淨淨/);
  assert.match(main, /app\.setName\("LINE Cheater"\)/);
  assert.match(main, /line-cheater:\/\/app/);
  assert.doesNotMatch(main, /line-reader:\/\//);
  assert.equal(packageJson.name, "line-cheater-desktop");
  assert.equal(packageJson.productName, "LINE Cheater");
});

test("offers one macOS and one Windows download on the homepage", () => {
  assert.match(landingHtml, /id="macDownload"/);
  assert.match(landingHtml, /下載 macOS 版/);
  assert.match(landingHtml, /id="windowsDownload"/);
  assert.match(landingScript, /macOS-arm64\\\.dmg/);
  assert.match(landingScript, /macOS-x64\\\.dmg/);
  assert.match(landingScript, /configurePlatformDownload\(el\.macDownload/);
  assert.match(landingScript, /macArchitecture === "x64"/);
  assert.match(landingStyles, /\.desktop-download-options/);
  assert.doesNotMatch(landingHtml, /id="macArm64Download"|id="macX64Download"/);
});

test("defaults cleanup to chat attachment size", () => {
  assert.match(
    html,
    /<option value="size" selected>聊天室附件大小<\/option>/
  );
  assert.match(renderer, /const cleanupState = \{[\s\S]*?sort: "size"/);
  assert.match(renderer, /elements\.cleanupSort\.value = "size"/);
});

test("reuses the macOS app icon for in-app branding", () => {
  assert.equal(
    (html.match(/class="brand-mark(?: small-mark)?" src="\/assets\/icon\.png"/g) || []).length,
    2
  );
  assert.match(main, /\["\/assets\/icon\.png", path\.join\("assets", "icon\.png"\)\]/);
  assert.match(
    macPackager,
    /path\.join\(packagedSourceRoot, "native", "electron", "assets", "icon\.png"\)/
  );
  assert.match(styles, /\.brand-mark\s*\{[^}]*object-fit: cover/);
});

test("selects the platform-native desktop icon and packages Windows assets", () => {
  assert.match(main, /process\.platform === "win32"/);
  assert.match(main, /path\.join\(__dirname, "assets", "icon\.ico"\)/);
  assert.match(main, /path\.join\(__dirname, "assets", "icon\.png"\)/);
  assert.match(windowsPackager, /assets", "icon\.ico/);
  assert.match(windowsPackager, /rcedit-x64\.exe/);
  assert.match(windowsPackager, /node_modules",\s+"electron",\s+"install\.js/);
});

test("verifies the complete Windows package payload", () => {
  assert.match(windowsPackager, /const requiredPackageFiles = \[/);
  assert.match(windowsPackager, /required file: \$\{relativePath\}/);
  assert.match(windowsPackager, /verifiedMetadata\.productName !== productName/);
  assert.match(windowsPackager, /verifiedMetadata\.version !== version/);
  assert.match(windowsPackager, /verifiedMetadata\.main !== "native\/electron\/main\.cjs"/);
  for (const packagedFile of [
    "renderer.html",
    "renderer.js",
    "session-cache.cjs",
    "sidecar-client.cjs",
    "update-checker.cjs",
    "styles.css",
    "icon.ico",
    "icon.png",
    "data-provider.js",
    "line-cheater.exe"
  ]) {
    assert.match(windowsPackager, new RegExp(`"${packagedFile.replace('.', "\\.")}"`));
  }
});

test("separates source selection from the sidebar workspace", () => {
  assert.match(html, /id="welcome-screen"/);
  assert.match(html, /id="enter-workspace"[^>]*disabled/);
  assert.match(html, /id="workspace-screen"[^>]*hidden/);
  assert.match(html, /class="workspace-sidebar"/);
  assert.match(html, /data-view="browse"/);
  assert.match(html, /data-view="cleanup"/);
  assert.match(renderer, /function enterWorkspace\(\)/);
  assert.match(renderer, /function setWorkspaceView\(view\)/);
});

test("leads source selection with the recommended imazing archive", () => {
  const sourceKinds = Array.from(
    html.matchAll(/data-source="([^"]+)"/g),
    (match) => match[1]
  );
  assert.deepEqual(sourceKinds, ["archive", "directory"]);
  assert.match(
    html,
    /data-source="archive"[\s\S]*?<strong>\.imazingapp<\/strong>[\s\S]*?source-recommend-badge">推薦</
  );
  assert.doesNotMatch(html, /data-source="sqlite"/);
});

test("keeps browse, cleanup, and advanced as mutually exclusive native views", () => {
  assert.match(html, /id="browse-view" class="workspace-view"/);
  assert.match(html, /id="cleanup-view" class="workspace-view hidden"/);
  assert.match(html, /id="advanced-view" class="workspace-view hidden"/);
  assert.match(renderer, /elements\.browseView\.classList\.toggle\("hidden", view !== "browse"\)/);
  assert.match(renderer, /elements\.cleanupView\.classList\.toggle\("hidden", view !== "cleanup"\)/);
  assert.match(renderer, /elements\.advancedView\.classList\.toggle\("hidden", view !== "advanced"\)/);
  assert.match(styles, /\.workspace-screen\s*\{/);
  assert.match(styles, /\.workspace-sidebar\s*\{/);
});

test("surfaces the existing exact-duplicate engine as a reviewable native view", () => {
  assert.match(html, /id="duplicates-nav" class="sidebar-item" data-view="duplicates"/);
  assert.match(html, /id="duplicates-view" class="workspace-view hidden"/);
  assert.match(html, /id="hash-duplicates"/);
  assert.match(html, /id="duplicate-auto-merge"[\s\S]*?aria-pressed="false" disabled/);
  assert.doesNotMatch(html, /id="duplicate-link-cleanup"/);
  assert.match(renderer, /provider\.hashDuplicateCandidates\(\)/);
  assert.match(renderer, /provider\.listDuplicateGroups\(/);
  assert.match(renderer, /provider\.listDuplicateMembers\(/);
  assert.match(renderer, /function requestWorkspaceView\(view\)/);
  assert.match(renderer, /重複附件掃描與自動合併需要進階模式/);
  assert.match(renderer, /setAdvancedMode\(true\)/);
  assert.match(renderer, /function toggleDuplicateAutoMerge\(\)/);
  assert.match(renderer, /"取消全部自動合併"/);
  assert.match(renderer, /advancedMode && duplicateScanComplete && duplicateAutoMergeEnabled/);
  assert.doesNotMatch(renderer, /至少要保留一份/);
  assert.match(preload, /"duplicateHashProgress"/);
  assert.match(html, /id="cancel-duplicate-scan"/);
  assert.match(renderer, /cancelCurrentOperation\("duplicate"\)/);
  assert.match(renderer, /function hydrateDuplicatePreviews\(/);
  assert.match(renderer, /bridge\.attachmentPreviewUrl\(path\)/);
  assert.match(renderer, /showImageModal\(url, caption, preview\)/);
  assert.match(styles, /\.duplicate-group-card\s*\{/);
  assert.match(styles, /\.duplicate-preview img\s*\{[^}]*object-fit: contain/);
  assert.match(styles, /#duplicate-auto-merge\[aria-pressed="true"\]/);
});

test("can cancel long-running native work and recover its sidecar", () => {
  assert.match(html, /id="load-modal-cancel"/);
  assert.match(html, /id="package-modal-cancel"/);
  assert.match(preload, /cancelOperation\(\)/);
  assert.match(renderer, /isOperationCancelled\(error\)/);
  assert.match(main, /await current\.cancel\(\)/);
  assert.match(main, /recoverInterruptedOperations/);
  assert.match(main, /\.partial/);
});

test("versions session cache and clears it after a successful candidate build", () => {
  assert.match(main, /prepareSessionCache\(/);
  assert.match(main, /app\.getVersion\(\)/);
  assert.match(sessionCache, /CACHE_VERSION_FILE = "\.line-cheater-cache-version"/);
  assert.match(sessionCache, /cachedVersion\(workDir\) === version/);
  assert.match(sessionCache, /clearSessionCache\(userDataPath, workDir\)/);
  assert.match(main, /outputFallsInsideSession\(workDir, output\)/);
  assert.match(main, /const cacheResult = await closeCompletedSession\(client, workDir\)/);
  assert.match(main, /return \{ \.\.\.result, \.\.\.cacheResult \}/);
  assert.match(renderer, /function resetAfterCandidateBuild\(\)/);
  assert.match(renderer, /本機快取已清除；下次請重新選擇來源/);
  assert.match(renderer, /setCandidateBuildDisabled\(!provider\)/);
  assert.match(macPackager, /"session-cache\.cjs"/);
  assert.match(windowsPackager, /"session-cache\.cjs"/);
});

test("checks packaged apps for newer stable GitHub releases at startup", () => {
  assert.match(main, /const \{ findAvailableUpdate \} = require\("\.\/update-checker\.cjs"\)/);
  assert.match(main, /updateCheckStarted \|\| !app\.isPackaged/);
  assert.match(main, /void checkForUpdates\(\)/);
  assert.match(main, /有新版本可用/);
  assert.match(main, /shell\.openExternal\(update\.releaseUrl/);
  assert.match(
    updateChecker,
    /https:\/\/api\.github\.com\/repos\/zeuikli\/line-cheater\/releases\/latest/
  );
  assert.match(updateChecker, /release\.draft === true/);
  assert.match(updateChecker, /release\.prerelease === true/);
  assert.match(macPackager, /"update-checker\.cjs"/);
  assert.match(windowsPackager, /"update-checker\.cjs"/);
});

test("does not reuse an attachment catalog after the source metadata changes", () => {
  assert.match(renderer, /catalogSourceCurrent/);
  assert.match(renderer, /!info\.catalogSourceCurrent/);
  assert.match(renderer, /需要重新掃描/);
});

test("keeps community chats source-aware and trusts native sender ownership", () => {
  assert.match(renderer, /button\.dataset\.chatSource = chat\.source \|\| "line"/);
  assert.match(renderer, /currentProvider\.listMessages\(currentChatPk, \{\s+source: currentChat\.source \|\| "line",\s+limit: 180,\s+cursor,\s+beforeCursor\s+\}\)/);
  assert.match(renderer, /typeof message\.isSelf === "boolean"/);
  assert.match(renderer, /return !hasSender &&/);
  assert.doesNotMatch(
    renderer,
    /return Number\(message\.sendStatus\) === 1 \|\|/
  );
});

test("keeps chat and message browsing bidirectionally paginated", () => {
  assert.match(html, /id="previous-chats"/);
  assert.match(html, /id="next-chats"/);
  assert.match(html, /id="previous-messages"/);
  assert.match(html, /id="next-messages"/);
  assert.match(renderer, /beforeCursor/);
  assert.match(renderer, /loadChats\("previous"\)/);
  assert.match(renderer, /loadMessages\("previous"\)/);
  assert.match(renderer, /elements\.previousChats\.disabled = !page\.hasPrevious/);
  assert.match(renderer, /elements\.previousMessages\.disabled = !page\.hasPrevious/);
  assert.match(renderer, /currentProvider !== provider/);
  assert.match(renderer, /requestedSelectionGeneration !== selectedChatGeneration/);
  assert.match(renderer, /setRetryVisible\(elements\.retryMessages, true\)/);
  assert.match(renderer, /setRetryVisible\(elements\.retryChats, true\)/);
  assert.match(html, /id="retry-chats"/);
  assert.match(html, /id="retry-messages"/);
  assert.match(html, /id="clear-search"/);
  assert.match(styles, /\.message-pagination\s*\{/);
  assert.match(styles, /\.panel-status-row, \.message-status-row/);
});

test("renders HTTP links as previews and opens only safe external URLs", () => {
  assert.match(renderer, /function appendLinkedText\(container, text\)/);
  assert.match(renderer, /function appendLinkPreviews\(card, text\)/);
  assert.match(renderer, /bridge\.openExternal\(href\)/);
  assert.match(styles, /\.link-preview\s*\{/);
  assert.match(preload, /openExternal\(value\)/);
  assert.match(main, /ipcMain\.handle\("line-native:open-external"/);
  assert.match(main, /shell\.openExternal\(url\.href/);
  assert.match(main, /\["http:", "https:"\]\.includes\(url\.protocol\)/);
  assert.match(main, /url\.username \|\| url\.password/);
  assert.doesNotMatch(renderer, /window\.open\(/);
});

test("keeps cleanup bounded while presenting a continuous month-sectioned album", () => {
  assert.doesNotMatch(html, /class="cleanup-guide"/);
  assert.match(html, /class="cleanup-controls"/);
  assert.match(html, /class="cleanup-results"/);
  assert.match(renderer, /const CLEANUP_ALBUM_PAGE_SIZE = 24/);
  assert.match(renderer, /const CLEANUP_ALBUM_MAX_PAGES = 3/);
  assert.match(renderer, /function loadCleanupAlbumPage\(/);
  assert.match(renderer, /elements\.cleanupList\.addEventListener\("scroll", handleCleanupAlbumScroll/);
  assert.match(renderer, /while \(session\.pages\.size > CLEANUP_ALBUM_MAX_PAGES\)/);
  assert.match(renderer, /new Intl\.DateTimeFormat\("zh-TW"/);
  assert.match(renderer, /className = "cleanup-month-section"/);
  assert.match(renderer, /classList\.add\("is-detail"\)/);
  assert.match(renderer, /choice\.setAttribute\("aria-description", impactText\)/);
  assert.match(styles, /\.workspace-content\s*\{[^}]*overflow: hidden/);
  assert.match(styles, /\.cleanup-panel\s*\{[^}]*height: 100%[^}]*overflow: hidden/);
  assert.match(
    styles,
    /\.cleanup-group-list\s*\{[^}]*grid-template-rows: repeat\(var\(--cleanup-group-rows, 5\),/
  );
  assert.match(styles, /\.cleanup-review-grid\s*\{[^}]*repeat\(auto-fill, minmax\(min\(180px,/);
  assert.match(styles, /\.cleanup-month-header\s*\{[^}]*position: sticky/);
  assert.match(styles, /\.cleanup-preview img\s*\{[^}]*object-fit: contain/);
  assert.match(styles, /#cleanup-view\.is-detail \.cleanup-list\s*\{[^}]*overflow-y: auto/);
  assert.match(styles, /#cleanup-view\.is-detail \.cleanup-pagination\s*\{\s*display: none/);
  assert.match(styles, /\.cleanup-impact\s*\{\s*display: none/);
  assert.match(styles, /#cleanup-view\.is-detail \.category-summary\s*\{\s*display: none/);
  assert.match(styles, /#cleanup-view\.is-detail \.cleanup-warning\s*\{\s*display: none/);
});

test("sizes cleanup pages from the visible list height without losing position", () => {
  assert.match(renderer, /let cleanupPageSize = 5/);
  assert.match(renderer, /function calculateCleanupPageSize\(\)/);
  assert.match(renderer, /Math\.min\(10, Math\.max\(5, Math\.floor\(\(listHeight - 14\) \/ 52\)\)\)/);
  assert.match(renderer, /function syncCleanupPageSize\(\)/);
  assert.match(renderer, /const firstItemIndex = \(currentPage - 1\) \* cleanupPageSize/);
  assert.match(renderer, /cleanupState\.page = Math\.floor\(firstItemIndex \/ cleanupPageSize\) \+ 1/);
  assert.match(renderer, /pageSize: overrides\.pageSize \|\| cleanupPageSize/);
  assert.match(renderer, /activeWorkspaceView === "cleanup" && cleanupPage && syncCleanupPageSize\(\)/);
});

test("uses an accessible shared modal for every confirmation", () => {
  assert.match(html, /id="confirmation-modal" class="confirmation-modal hidden" role="dialog" aria-modal="true"/);
  assert.match(html, /id="confirmation-modal-cancel"/);
  assert.match(html, /id="confirmation-modal-confirm"/);
  assert.match(renderer, /function requestConfirmation\(options\)/);
  assert.match(renderer, /function closeConfirmationModal\(confirmed\)/);
  assert.match(renderer, /function trapModalFocus\(event, modal\)/);
  assert.match(renderer, /confirmationModalConfirm\.addEventListener\("click", \(\) => closeConfirmationModal\(true\)\)/);
  assert.doesNotMatch(renderer, /window\.confirm/);
  assert.match(styles, /\.confirmation-modal-card\s*\{/);
  assert.match(styles, /body\.confirmation-modal-open/);
});

test("asks how to handle a restored cleanup plan and synchronizes modal locking", () => {
  assert.match(renderer, /function resolveRestoredCleanupPlan\(overview\)/);
  assert.match(renderer, /發現先前的清理計畫/);
  assert.match(renderer, /cancelLabel: "復原前次計畫"/);
  assert.match(renderer, /provider\.clearAllRemovalPlans\(\)/);
  assert.match(renderer, /function syncModalBusy\(\)/);
  assert.match(renderer, /modalStates\.some/);
  assert.match(main, /"clearAllRemovalPlans"/);
});

test("reuses cleanup overview while paging groups", () => {
  assert.match(
    renderer,
    /if \(cleanupOverview\) \{\s+page = await provider\.listCleanupGroups\(cleanupOptions\(\)\);/
  );
  assert.match(renderer, /cleanupOverview = await provider\.applyCleanupGroupAction\(/);
  assert.match(renderer, /cleanupPage = cleanupOverview = null;/);
});

test("reuses the mark response instead of fetching cleanup overview twice", () => {
  const markHandler = renderer.match(
    /async function changeAttachmentMark\(checkbox\) \{([\s\S]*?)\n\}\n\nasync function toggleAllChatAttachments/
  )[1];
  assert.match(markHandler, /cleanupOverview = await provider\.setAttachmentMarked\(path, checkbox\.checked\)/);
  assert.doesNotMatch(markHandler, /provider\.cleanupOverview\(\)/);
  assert.match(markHandler, /if \(advancedMode\) await refreshAdvancedPlanSummary\(\)/);
});

test("exposes separate safe-automatic and manual cleanup controls", () => {
  assert.match(html, /id="plan-safe-attachment-cleanup"/);
  assert.match(html, /id="clear-manual-attachment-plan"/);
  assert.match(html, /id="cleanup-operation-modal"/);
  assert.match(renderer, /provider\.planSafeAttachmentCleanup\(\)/);
  assert.match(renderer, /function showCleanupOperationModal\(clearing\)/);
  assert.match(renderer, /await waitForUiPaint\(\);\s+cleanupOverview = await provider\.planSafeAttachmentCleanup\(\)/);
  assert.match(renderer, /closeCleanupOperationModal\(\)/);
  assert.match(renderer, /provider\.clearManualAttachmentPlan\(\)/);
  assert.match(renderer, /removalReason === "automatic"/);
  assert.match(main, /"planSafeAttachmentCleanup"/);
  assert.match(main, /"clearManualAttachmentPlan"/);
  assert.match(styles, /\.cleanup-operation-progress\s*\{/);
});

test("keeps cleanup safety details available without crowding the main flow", () => {
  assert.match(html, /id="cleanup-safety-details" class="cleanup-safety-details"/);
  assert.match(html, /id="cleanup-safety-summary"/);
  assert.match(renderer, /cleanupSafetyDetails\.open = blockers > 0/);
  assert.match(styles, /\.cleanup-safety-details\s*\{/);
  assert.doesNotMatch(html, /class="category-card"/);
});

test("surfaces cleanup blindspot scans, plan previews, and candidate verification", () => {
  assert.match(html, /id="cleanup-preflight"/);
  assert.match(html, /id="refresh-cleanup-preflight"/);
  assert.match(html, /id="cleanup-plan-cards"/);
  assert.match(html, /清理方案比較/);
  assert.match(html, /id="package-modal-report"/);
  assert.match(renderer, /provider\.cleanupPreflight\(\)/);
  assert.match(renderer, /provider\.cleanupPlanPreviews\(\)/);
  assert.match(renderer, /function renderCleanupPreflight\(\)/);
  assert.match(renderer, /function renderCleanupPlanPreviews\(\)/);
  assert.match(renderer, /建議方案，可直接套用/);
  assert.match(renderer, /僅供比較，不會套用/);
  assert.match(renderer, /function renderCandidateReport\(report\)/);
  assert.match(renderer, /Number\(cleanupPreflight\.blockerCount\)/);
  assert.match(main, /"cleanupPreflight"/);
  assert.match(main, /"cleanupPlanPreviews"/);
  assert.match(styles, /\.cleanup-plan-status\.recommended\s*\{/);
});

test("surfaces cleanup audit history and restore checklist", () => {
  assert.match(html, /id="cleanup-audit"/);
  assert.match(html, /id="copy-cleanup-plan"/);
  assert.match(html, /id="restore-checklist-modal"/);
  assert.match(html, /id="restore-check-original"/);
  assert.match(html, /id="restore-check-confirm"/);
  assert.match(renderer, /provider\.cleanupAudit\(20\)/);
  assert.match(renderer, /function renderCleanupAudit\(\)/);
  assert.match(renderer, /function copyCleanupPlanSummary\(\)/);
  assert.match(renderer, /function requestRestoreChecklist\(\)/);
  assert.match(renderer, /if \(!await requestRestoreChecklist\(\)\) return;/);
  assert.match(main, /"cleanupAudit"/);
  assert.match(styles, /\.restore-checklist-modal\s*\{/);
});

test("offers a reversible checkbox for selecting every chat attachment", () => {
  assert.match(html, /id="cleanup-all-chat-attachments" type="checkbox" disabled/);
  assert.match(html, /所有聊天室附件/);
  assert.match(main, /"setAllChatAttachmentsPlanned"/);
  assert.match(renderer, /function toggleAllChatAttachments\(\)/);
  assert.match(renderer, /provider\.setAllChatAttachmentsPlanned\(planned\)/);
  assert.match(renderer, /取消勾選可撤回這次全選/);
  assert.match(renderer, /allChatAttachmentsPlanned/);
  assert.match(renderer, /function syncAllChatAttachmentsCheckbox\(\)/);
  assert.match(
    renderer,
    /cleanupLoading = false;\s+syncCleanupPageInput\(\);\s+syncAllChatAttachmentsCheckbox\(\)/
  );
  assert.match(styles, /\.cleanup-global-check\s*\{/);
});

test("supports cleanup page jumps and restores the overview page after chat detail", () => {
  assert.match(html, /id="cleanup-page-input"/);
  assert.match(html, /id="cleanup-page-total"/);
  assert.match(renderer, /function commitCleanupPageInput\(\)/);
  assert.match(renderer, /cleanupPageInput\.addEventListener\("blur", commitCleanupPageInput\)/);
  assert.match(renderer, /cleanupPageInput\.addEventListener\("keydown", \(event\) =>/);
  assert.match(
    renderer,
    /cleanupState\.groupKey = open\.dataset\.openGroup;\s+syncCleanupPageInput\(\);\s+void loadCleanupPage\(\);/
  );
  assert.match(renderer, /cleanupState\.groupKey = null;\s+void loadCleanupPage\(\);/);
  assert.doesNotMatch(
    renderer,
    /cleanupState\.groupKey = open\.dataset\.openGroup;\s+cleanupState\.page = 1/
  );
  assert.doesNotMatch(renderer, /cleanupPage = firstPage;\s+cleanupState\.page = 1/);
  assert.match(styles, /\.cleanup-page-jump input\s*\{/);
});

test("opens cleanup thumbnails in the shared image modal", () => {
  assert.match(renderer, /preview\.type = "button"/);
  assert.match(renderer, /preview\.setAttribute\("aria-label", `放大預覽：\$\{caption\}`\)/);
  assert.match(renderer, /showImageModal\(url, caption, preview\)/);
  assert.match(styles, /\.cleanup-preview:not\(:disabled\)\s*\{\s*cursor: zoom-in/);
  assert.match(styles, /\.cleanup-preview-open\s*\{/);
});

test("offers keep-thumbnail only for thumbnail-backed image originals", () => {
  assert.match(renderer, /group\.thumbnailBackedImageCount > 0/);
  assert.match(
    renderer,
    /PDF、影片與無縮圖附件會保留/
  );
  assert.doesNotMatch(renderer, /group\.hasOriginal && group\.hasThumbnail/);
});

test("lists no-attachment chats only in advanced cleanup mode", () => {
  assert.match(
    html,
    /id="cleanup-no-attachments" value="no_attachments" hidden disabled/
  );
  assert.match(renderer, /elements\.cleanupNoAttachments\.hidden = !advancedMode/);
  assert.match(renderer, /elements\.cleanupNoAttachments\.disabled = !advancedMode/);
  assert.match(renderer, /group\.referenceStatus !== "no_attachments"/);
  assert.match(renderer, /\["referenced", "no_attachments"\]\.includes\(group\.referenceStatus\)/);
  assert.match(renderer, /"刪除所有附件"/);
  assert.doesNotMatch(renderer, /"刪除全部"/);
});

test("gates SQLite mutation planning behind desktop advanced mode", () => {
  assert.match(html, /id="advanced-mode"[^>]*role="switch"/);
  assert.match(html, /data-view="advanced"/);
  assert.match(html, /id="plan-automatic-cleanup"/);
  assert.match(html, /id="plan-community-cleanup" type="checkbox"/);
  assert.match(html, /id="plan-old-account-cleanup" type="checkbox"/);
  assert.match(html, /id="advanced-community-bytes"/);
  assert.match(html, /估計可移除/);
  assert.match(html, /刪除所有社群/);
  assert.match(html, /只保留目前帳號/);
  assert.match(html, /id="advanced-build-candidate"/);
  assert.match(html, /建立瘦身 \.imazingapp/);
  assert.doesNotMatch(html, /advanced-cleanup-marked/);
  assert.match(html, /掃描殘留的空白聊天室/);
  assert.match(html, /<h3 id="advanced-plan-heading">清理計畫<\/h3>/);
  assert.doesNotMatch(html, /id="clear-advanced-plan"/);
  assert.match(renderer, /provider\.setChatRemovalPlanned\(/);
  assert.match(renderer, /provider\.planAutomaticCleanup\(\)/);
  assert.match(renderer, /provider\.setCommunityCleanupPlanned\(!planned\)/);
  assert.match(renderer, /provider\.setOldAccountCleanupPlanned\(!planned\)/);
  assert.match(renderer, /report\.currentAccountDetected/);
  assert.match(renderer, /elements\.advancedBuildCandidate\.addEventListener\("click", \(\) => void buildCandidate\(\)\)/);
  assert.doesNotMatch(renderer, /cleanupMarkedFiles|cleanupMarkedBytes/);
  assert.match(renderer, /report\.automaticCleanupPlanned/);
  assert.match(renderer, /取消清理所有偵測項目/);
  assert.match(renderer, /原始備份不會被修改/);
  assert.doesNotMatch(renderer, /已將「\$\{title\}」的聊天室/);
  assert.match(main, /"advancedCleanupReport"/);
  assert.match(main, /"setChatRemovalPlanned"/);
  assert.match(main, /"planAutomaticCleanup"/);
  assert.match(main, /"setCommunityCleanupPlanned"/);
  assert.match(main, /"setOldAccountCleanupPlanned"/);
});

test("does not duplicate DOM ids in the app shell", () => {
  const ids = Array.from(html.matchAll(/\sid="([^"]+)"/g), (match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
});

test("supports ad-hoc and Developer ID macOS signatures", () => {
  assert.match(packageJson.scripts["package:mac"], /build:native:mac/);
  assert.match(main, /path\.join\(process\.resourcesPath, "bin", executable\)/);
  assert.match(macPackager, /"target",\s*"release",\s*"line-cheater"/);
  assert.match(macPackager, /MACOS_SIGN_IDENTITY \|\| "-"/);
  assert.match(macPackager, /process\.arch === "arm64"/);
  assert.match(macPackager, /process\.arch === "x64"/);
  assert.match(macPackager, /MACOS_SIGN_IDENTITY to a Developer ID Application/);
  assert.match(macPackager, /usesDeveloperId/);
  assert.match(macPackager, /function signElectronRuntime\(\)/);
  assert.match(macPackager, /"--options", "runtime"/);
  assert.match(macPackager, /"--timestamp"/);
  assert.match(macPackager, /sign\(sidecarPath\)/);
  assert.match(macPackager, /verifySignature\(sidecarPath, "Rust sidecar"\)/);
  assert.match(macPackager, /entitlements\.mac\.plist/);
  assert.match(macPackager, /codesign",\s*\["--verify", "--deep", "--strict"/);
  assert.match(macPackager, /hdiutil",\s*\[/);
  assert.match(macPackager, /SHA256SUMS\.txt/);
  assert.match(macPackager, /line-cheater\.icns/);
  assert.match(macPackager, /"assets", "icon\.png"/);
  assert.match(macPackager, /pixelWidth:\\s\*1024/);
  assert.match(macPackager, /hasAlpha:\\s\*\(\?:yes\|true\)/);
  assert.match(macPackager, /Signature: ad hoc \(not notarized\)/);
});

test("uses only the Electron JIT entitlements needed for hardened runtime", () => {
  assert.match(macEntitlements, /com\.apple\.security\.cs\.allow-jit/);
  assert.match(macEntitlements, /com\.apple\.security\.cs\.allow-unsigned-executable-memory/);
  assert.doesNotMatch(macEntitlements, /com\.apple\.security\.app-sandbox/);
});

test("provides a self-checking DMG packaging script", () => {
  assert.equal(packageJson.scripts["package:dmg"], "./scripts/package-dmg.sh");
  assert.match(dmgPackager, /npm --prefix \"\$electron_root\" ci/);
  assert.match(dmgPackager, /SKIP_NPM_CI/);
  assert.match(dmgPackager, /SKIP_NPM_TEST/);
  assert.match(dmgPackager, /build:native:mac/);
  assert.match(dmgPackager, /MACOS_PACKAGE_ARCH/);
  assert.match(dmgPackager, /x86_64\) artifact_arch="x64"/);
  assert.match(dmgPackager, /electron_installer/);
  assert.match(dmgPackager, /hdiutil verify/);
  assert.match(dmgPackager, /hdiutil attach/);
  assert.match(dmgPackager, /mounted_sidecar/);
  assert.match(dmgPackager, /Resources\/bin\/line-cheater/);
  assert.match(dmgPackager, /--version/);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(root, "scripts", "package-dmg.sh")).mode & 0o111, 0o111);
  }
});

test("requires signing material for the dual-architecture macOS release", () => {
  assert.match(macWorkflow, /MACOS_CERTIFICATE_BASE64/);
  assert.match(macWorkflow, /MACOS_SIGN_IDENTITY:/);
  assert.match(macWorkflow, /import-signing-keychain\.sh/);
  assert.match(macWorkflow, /delete-keychain/);
  assert.match(signingImporter, /Missing required signing variable/);
  assert.match(signingImporter, /base64 -D/);
  assert.match(signingImporter, /security import .* -P \"\"/s);
  assert.match(signingImporter, /Developer ID Application:/);
  assert.match(signingImporter, /find-identity -v -p codesigning/);
  if (process.platform !== "win32") {
    assert.equal(
      fs.statSync(path.join(root, "scripts", "import-signing-keychain.sh")).mode & 0o111,
      0o111
    );
  }
});

test("notarizes and staples the macOS DMG with GitHub Secrets", () => {
  assert.match(macWorkflow, /macos-15-intel/);
  assert.match(macWorkflow, /arch: x64/);
  assert.match(macWorkflow, /LINE-Cheater-\$\{VERSION\}-macOS-\$\{MACOS_ARCH\}\.dmg/);
  assert.match(macWorkflow, /SHA256SUMS-\$\{MACOS_ARCH\}\.txt/);
  assert.match(macWorkflow, /actions\/download-artifact@v6/);
  assert.match(macWorkflow, /MACOS_NOTARY_APPLE_ID/);
  assert.match(macWorkflow, /MACOS_NOTARY_TEAM_ID/);
  assert.match(macWorkflow, /MACOS_NOTARY_APP_SPECIFIC_PASSWORD/);
  assert.match(macWorkflow, /notarize-dmg\.sh/);
  assert.match(macWorkflow, /Refresh checksums after DMG stapling/);
  assert.match(macWorkflow, /uses: \.\/\.github\/actions\/setup-build/);
  assert.match(macWorkflow, /verify-macos-package\.sh/);
  assert.match(packageVerifier, /MACOS_CHECKSUM_FILE/);
  assert.match(packageVerifier, /codesign --verify --deep --strict/);
  assert.match(packageVerifier, /Resources\/bin\/line-cheater/);
  assert.match(packageVerifier, /shasum -a 256 -c/);
  assert.match(packageVerifier, /hdiutil verify/);
  assert.match(dmgNotarizer, /notarytool store-credentials/);
  assert.match(dmgNotarizer, /notarytool submit/);
  assert.match(dmgNotarizer, /stapler staple/);
  assert.match(dmgNotarizer, /stapler validate/);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(root, "scripts", "notarize-dmg.sh")).mode & 0o111, 0o111);
    assert.equal(
      fs.statSync(path.join(root, "scripts", "verify-macos-package.sh")).mode & 0o111,
      0o111
    );
  }
});

test("provides a GitHub Actions Windows packaging workflow", () => {
  const workflow = fs.readFileSync(
    path.join(root, "../../.github/workflows/release-windows.yml"),
    "utf8"
  );
  assert.match(workflow, /windows-2022/);
  assert.match(workflow, /npm run build:native:win/);
  assert.match(workflow, /node scripts\/package-windows\.cjs/);
  assert.match(workflow, /github\.event_name != 'workflow_run'/);
  assert.match(workflow, /actions\/upload-artifact@v6/);
  assert.match(workflow, /Windows-x64\.zip/);
  assert.match(workflow, /uses: \.\/\.github\/actions\/setup-build/);
  assert.match(workflow, /gh release upload/);
});

test("prefers the current debug sidecar during development", () => {
  assert.match(
    main,
    /} else \{\s+candidates\.push\(path\.resolve\(__dirname, "\.\.", "\.\.", "target", "debug", executable\)\);\s+candidates\.push\(path\.resolve\(__dirname, "\.\.", "\.\.", "target", "release", executable\)\);/
  );
});
