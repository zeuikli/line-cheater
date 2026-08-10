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
  assert.match(windowsPackager, /process\.env\.LINE_CHEATER_DIST_ROOT/);
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
  assert.match(sessionCache, /previousVersion === version/);
  assert.match(main, /SESSION_CACHE_COMPATIBLE_VERSIONS = \["0\.1\.23"\]/);
  assert.match(sessionCache, /compatibleVersions\.includes\(previousVersion\)/);
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
  assert.match(styles, /\.cleanup-panel\s*\{[^}]*height: 100%[^}]*overflow-x: hidden[^}]*overflow-y: auto/);
  assert.match(styles, /\.cleanup-panel\s*\{[^}]*overflow-x: hidden[^}]*overflow-y: auto/);
  assert.match(styles, /\.cleanup-results\s*\{[^}]*min-height: 320px[^}]*flex: 0 0 320px/);
  assert.match(styles, /\.cleanup-list\s*\{[^}]*overflow-x: hidden[^}]*overflow-y: auto/);
  assert.match(styles, /\.cleanup-group-list\s*\{[^}]*grid-template-rows: repeat\(4,/);
  assert.match(styles, /\.cleanup-group-list\s*\{[^}]*min-height: 306px/);
  assert.match(styles, /\.cleanup-review-grid\s*\{[^}]*repeat\(auto-fill, minmax\(min\(180px,/);
  assert.match(styles, /\.cleanup-month-header\s*\{[^}]*position: sticky/);
  assert.match(styles, /\.cleanup-preview img\s*\{[^}]*object-fit: contain/);
  assert.match(styles, /#cleanup-view\.is-detail \.cleanup-list\s*\{[^}]*overflow-y: auto/);
  assert.match(styles, /#cleanup-view\.is-detail \.cleanup-pagination\s*\{\s*display: none/);
  assert.match(styles, /\.cleanup-impact\s*\{\s*display: none/);
  assert.match(styles, /#cleanup-view\.is-detail \.category-summary\s*\{\s*display: none/);
  assert.match(styles, /#cleanup-view\.is-detail \.cleanup-warning\s*\{\s*display: none/);
});

test("reuses cleanup overview while paging groups", () => {
  assert.match(
    renderer,
    /if \(cleanupOverview\) \{\s+\[page, cleanupCategoryActionState\] = await Promise\.all/
  );
  assert.match(renderer, /provider\.listCleanupGroups\(cleanupOptions\(\)\)/);
  assert.match(renderer, /cleanupOverview = await provider\.applyCleanupGroupAction\(/);
  assert.match(renderer, /cleanupPage = cleanupOverview = null;/);
});

test("exposes separate safe-automatic and manual cleanup controls", () => {
  assert.match(html, /id="plan-safe-attachment-cleanup"/);
  assert.match(html, /id="clear-manual-attachment-plan"/);
  assert.match(renderer, /provider\.planSafeAttachmentCleanup\(\)/);
  assert.match(renderer, /provider\.clearManualAttachmentPlan\(\)/);
  assert.match(renderer, /removalReason === "automatic"/);
  assert.match(main, /"planSafeAttachmentCleanup"/);
  assert.match(main, /"clearManualAttachmentPlan"/);
});

test("requires confirmation before cancelling work or closing the app", () => {
  assert.match(renderer, /確定取消載入與掃描？/);
  assert.match(renderer, /確定取消建立瘦身檔？/);
  assert.match(renderer, /確定取消重複附件掃描？/);
  assert.match(renderer, /確定取消資料庫操作？/);
  assert.match(html, /id="operation-modal-cancel"/);
  assert.match(renderer, /requestRestoreChecklistCancellation/);
  assert.match(renderer, /確定關閉建立結果？/);
  assert.match(renderer, /確定關閉操作結果？/);
  assert.match(renderer, /確定關閉圖片預覽？/);
  assert.match(renderer, /requestModalClose\("package"\)/);
  assert.match(renderer, /requestModalClose\("operation"\)/);
  assert.match(renderer, /requestModalClose\("image"\)/);
  assert.match(main, /mainWindow\.on\("close"/);
  assert.match(main, /確認關閉 LINE Cheater/);
  assert.match(main, /buttons: \["繼續使用", "確認關閉"\]/);
});

test("supports reversible category-wide actions with locked mutation progress", () => {
  assert.match(html, /id="category-bulk-actions"/);
  assert.match(html, /id="category-keep-thumbnails"/);
  assert.match(html, /id="category-delete-attachments"/);
  assert.match(html, /id="category-delete-chats"/);
  assert.match(html, /id="operation-modal"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(renderer, /provider\.cleanupCategoryActionState\(requestedCategory\)/);
  assert.match(renderer, /cancelling \? "clear_keep_thumbnail" : "keep_thumbnail"/);
  assert.match(renderer, /cancelling \? "clear_delete_all" : "delete_all"/);
  assert.match(renderer, /provider\.setCleanupCategoryChatsRemovalPlanned\(category, !cancelling\)/);
  assert.match(renderer, /取消全部只保留縮圖/);
  assert.match(renderer, /取消刪除分類所有附件/);
  assert.match(renderer, /取消刪除分類所有聊天室/);
  assert.match(renderer, /\["all", "individual", "group", "community"\]\.includes\(category\)/);
  assert.match(renderer, /runCleanupMutation\(/);
  assert.match(renderer, /bridge\.on\("cleanupMutationProgress"/);
  assert.match(renderer, /processedRecords/);
  assert.match(styles, /\.category-bulk-actions/);
  assert.match(styles, /body\.operation-modal-open/);
  assert.match(main, /"applyCleanupCategoryAction"/);
  assert.match(main, /"cleanupCategoryActionState"/);
  assert.match(main, /"setCleanupCategoryChatsRemovalPlanned"/);
  assert.match(preload, /"cleanupMutationProgress"/);
});

test("supports bounded image and attachment exports", () => {
  assert.match(html, /id="export-chat-conversation"/);
  assert.match(html, /id="export-chat-images"/);
  assert.match(html, /id="export-chat-attachments"/);
  assert.match(renderer, /function exportAttachmentSelection\(paths, options = \{\}\)/);
  assert.match(renderer, /if \(succeeded\) \{\s+setMessagePanelBusy\(false\);/);
  assert.match(renderer, /provider\.exportAttachments\(/);
  assert.match(renderer, /匯出圖檔/);
  assert.match(renderer, /匯出本則附件/);
  assert.match(renderer, /bridge\.on\("exportProgress"/);
  assert.match(renderer, /cancelCurrentOperation\(exportInProgress \? "export" : "cleanup"\)/);
  assert.match(styles, /\.message-attachment-actions/);
  assert.match(main, /"exportAttachments"/);
  assert.match(main, /choose-export-output/);
  assert.match(main, /exportOutputTokens/);
  assert.match(main, /LINE-Cheater-Export-/);
  assert.match(preload, /"exportProgress"/);
  assert.match(preload, /chooseExportOutput()/);
  assert.match(renderer, /function exportCurrentConversation\(\)/);
  assert.match(renderer, /provider\.exportConversation\(/);
  assert.match(renderer, /從最早一則開始讀取全部訊息/);
  assert.match(renderer, /bridge\.on\("conversationExportProgress"/);
  assert.match(main, /"exportConversation"/);
  assert.match(main, /choose-conversation-output/);
  assert.match(main, /conversationOutputTokens/);
  assert.match(preload, /"conversationExportProgress"/);
  assert.match(preload, /chooseConversationOutput()/);
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

test("asks how to handle a restored iMazing cleanup plan", () => {
  assert.match(renderer, /function resolveRestoredCleanupPlan\(overview\)/);
  assert.match(renderer, /info\.source\.kind === "imazing_archive"/);
  assert.match(renderer, /發現先前的清理計畫/);
  assert.match(renderer, /cancelLabel: "繼續使用舊計畫"/);
  assert.match(renderer, /provider\.clearAllRemovalPlans\(\)/);
  assert.match(renderer, /function syncModalBusy\(\)/);
  assert.match(main, /"clearAllRemovalPlans"/);
});

test("restarts the cleanup overview after global attachment-plan changes", () => {
  assert.match(
    renderer,
    /await provider\.planSafeAttachmentCleanup\(\);\s+cleanupPage = null;\s+cleanupOverview = null;\s+cleanupState\.page = 1;\s+cleanupState\.groupKey = null;/
  );
  assert.match(
    renderer,
    /await provider\.clearManualAttachmentPlan\(\);\s+cleanupPage = null;\s+cleanupOverview = null;\s+cleanupState\.page = 1;\s+cleanupState\.groupKey = null;/
  );
  assert.match(renderer, /await loadCleanupPage\(\{ verifySource: false \}\)/);
  assert.match(renderer, /void refreshAdvancedPlanSummary\(\)/);
});

test("surfaces cleanup blindspot scans, plan previews, and candidate verification", () => {
  assert.match(html, /id="cleanup-preflight"/);
  assert.match(html, /id="refresh-cleanup-preflight"/);
  assert.match(html, /id="cleanup-plan-cards"/);
  assert.match(html, /請選擇方案；選取只會切換檢視範圍/);
  assert.match(html, /id="package-modal-report"/);
  assert.match(renderer, /provider\.cleanupPreflight\(\)/);
  assert.match(renderer, /provider\.cleanupPlanPreviews\(\)/);
  assert.match(renderer, /function renderCleanupPreflight\(\)/);
  assert.match(renderer, /function renderCleanupPlanPreviews\(\)/);
  assert.match(renderer, /async function selectCleanupPlan\(profile\)/);
  assert.match(renderer, /cleanupPlanPreviewsCollapsed = true/);
  assert.match(renderer, /function toggleCleanupPlanPreviews\(\)/);
  assert.match(renderer, /title: `套用\$\{selectedProfile\.label\}？`/);
  assert.match(renderer, /confirmLabel: "套用方案"/);
  assert.match(renderer, /await applySafeAttachmentCleanup\(/);
  assert.match(renderer, /待複核附件，仍需人工決定，不會自動刪除/);
  assert.match(renderer, /async function applySafeAttachmentCleanup\(message\)/);
  assert.match(renderer, /const visible = blockers > 0/);
  assert.match(renderer, /classList\.toggle\("hidden", !visible\)/);
  assert.match(renderer, /conservative: \{\s+label: "保守方案",\s+category: "all",/);
  assert.match(renderer, /balanced: \{\s+label: "平衡方案",\s+category: "all",/);
  assert.match(renderer, /aggressive: \{\s+label: "積極方案",\s+category: "all",/);
  assert.match(renderer, /cleanupState\.category = selectedProfile\.category/);
  assert.match(renderer, /已套用\$\{selectedProfile\.label\}/);
  assert.match(html, /role="radiogroup" aria-label="清理方案"/);
  assert.match(html, /id="toggle-cleanup-plan-previews"/);
  assert.match(styles, /\.cleanup-plan-previews\.is-collapsed \.cleanup-plan-cards/);
  assert.match(renderer, /function renderCandidateReport\(report\)/);
  assert.match(renderer, /Number\(cleanupPreflight\.blockerCount\)/);
  assert.match(main, /"cleanupPreflight"/);
  assert.match(main, /"cleanupPlanPreviews"/);
});

test("keeps long-running searches and image loading responsive", () => {
  assert.match(renderer, /bridge\.on\("searchIndexProgress"/);
  assert.match(renderer, /首次搜尋正在建立 FTS5 索引/);
  assert.match(renderer, /new IntersectionObserver/);
  assert.match(renderer, /rootMargin: "480px 0px"/);
  assert.match(renderer, /preview\.dataset\.previewState = "loading"/);
  assert.match(renderer, /active < 4/);
  assert.match(renderer, /cleanupPreviewObserver\.disconnect\(\)/);
});

test("keeps audit details out of the primary cleanup workflow", () => {
  assert.doesNotMatch(html, /id="cleanup-audit"/);
  assert.doesNotMatch(renderer, /provider\.cleanupAudit\(20\)/);
  assert.doesNotMatch(renderer, /function renderCleanupAudit\(\)/);
  assert.doesNotMatch(renderer, /function copyCleanupPlanSummary\(\)/);
  assert.match(main, /"cleanupAudit"/);
});

test("surfaces the restore checklist before candidate creation", () => {
  assert.match(html, /id="restore-checklist-modal"/);
  assert.match(html, /id="restore-check-original"/);
  assert.match(html, /id="restore-check-confirm"/);
  assert.match(renderer, /function requestRestoreChecklist\(\)/);
  assert.match(renderer, /if \(!await requestRestoreChecklist\(\)\) return;/);
  assert.match(main, /"cleanupAudit"/);
  assert.match(styles, /\.restore-checklist-modal\s*\{/);
});

test("requires explicit confirmation before rebuilding corrupt LineSquare data", () => {
  assert.match(renderer, /report\.lineSquareRebuildRequired === true/);
  assert.match(renderer, /title: "LineSquare\.sqlite 已損壞"/);
  assert.match(renderer, /confirmLabel: "重建並繼續"/);
  assert.match(renderer, /cancelLabel: "取消建立"/);
  assert.match(renderer, /allowLineSquareRebuild: false/);
  assert.match(renderer, /allowLineSquareRebuild: true/);
  assert.match(renderer, /bridge\.discardCandidateOutput\(output\.token\)/);
  assert.match(preload, /discardCandidateOutput\(token\)/);
  assert.match(main, /result\.lineSquareRebuildRequired === true/);
  assert.match(main, /"line-native:discard-candidate-output"/);
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
  assert.match(renderer, /group\.chatKind === "community"/);
  assert.match(renderer, /沒有可配對原圖/);
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
  assert.match(html, /id="advanced-build-candidate"/);
  assert.match(html, /建立瘦身 \.imazingapp/);
  assert.doesNotMatch(html, /advanced-cleanup-marked/);
  assert.match(html, /掃描殘留的空白聊天室/);
  assert.match(html, /<h3 id="advanced-plan-heading">清理計畫<\/h3>/);
  assert.doesNotMatch(html, /id="clear-advanced-plan"/);
  assert.match(renderer, /provider\.setChatRemovalPlanned\(/);
  assert.match(renderer, /provider\.planAutomaticCleanup\(\)/);
  assert.match(renderer, /elements\.advancedBuildCandidate\.addEventListener\("click", \(\) => void buildCandidate\(\)\)/);
  assert.doesNotMatch(renderer, /cleanupMarkedFiles|cleanupMarkedBytes/);
  assert.match(renderer, /report\.automaticCleanupPlanned/);
  assert.match(renderer, /取消清理所有偵測項目/);
  assert.match(renderer, /原始備份不會被修改/);
  assert.doesNotMatch(renderer, /已將「\$\{title\}」的聊天室/);
  assert.match(main, /"advancedCleanupReport"/);
  assert.match(main, /"setChatRemovalPlanned"/);
  assert.match(main, /"planAutomaticCleanup"/);
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
