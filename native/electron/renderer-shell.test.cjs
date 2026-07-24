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
const preload = fs.readFileSync(path.join(root, "preload.cjs"), "utf8");
const macPackager = fs.readFileSync(
  path.join(root, "scripts", "package-macos.cjs"),
  "utf8"
);
const dmgPackager = fs.readFileSync(
  path.join(root, "scripts", "package-dmg.sh"),
  "utf8"
);
const windowsPackager = fs.readFileSync(
  path.join(root, "scripts", "package-windows.cjs"),
  "utf8"
);
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

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

test("reuses the macOS app icon for in-app branding", () => {
  assert.equal(
    (html.match(/class="brand-mark(?: small-mark)?" src="\/assets\/icon\.png"/g) || []).length,
    2
  );
  assert.match(main, /\["\/assets\/icon\.png", path\.join\("assets", "icon\.png"\)\]/);
  assert.match(main, /icon: path\.join\(__dirname, "assets", "icon\.png"\)/);
  assert.match(
    macPackager,
    /path\.join\(packagedSourceRoot, "native", "electron", "assets", "icon\.png"\)/
  );
  assert.match(styles, /\.brand-mark\s*\{[^}]*object-fit: cover/);
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
  assert.match(styles, /\.cleanup-group-list\s*\{[^}]*grid-template-rows: repeat\(4,/);
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
    /if \(cleanupOverview\) \{\s+page = await provider\.listCleanupGroups\(cleanupOptions\(\)\);/
  );
  assert.match(renderer, /cleanupOverview = await provider\.applyCleanupGroupAction\(/);
  assert.match(renderer, /cleanupPage = cleanupOverview = null;/);
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

test("packages the release sidecar inside a verified macOS bundle", () => {
  assert.match(packageJson.scripts["package:mac"], /build:native:mac/);
  assert.match(main, /path\.join\(process\.resourcesPath, "bin", executable\)/);
  assert.match(macPackager, /"target",\s*"release",\s*"line-cheater"/);
  assert.match(macPackager, /codesign",\s*\["--verify", "--deep", "--strict"/);
  assert.match(macPackager, /hdiutil",\s*\[/);
  assert.match(macPackager, /SHA256SUMS\.txt/);
  assert.match(macPackager, /line-cheater\.icns/);
  assert.match(macPackager, /"assets", "icon\.png"/);
  assert.match(macPackager, /pixelWidth:\\s\*1024/);
});

test("provides a self-checking DMG packaging script", () => {
  assert.equal(packageJson.scripts["package:dmg"], "./scripts/package-dmg.sh");
  assert.match(dmgPackager, /npm --prefix \"\$electron_root\" ci/);
  assert.match(dmgPackager, /SKIP_NPM_CI/);
  assert.match(dmgPackager, /electron_installer/);
  assert.match(dmgPackager, /hdiutil verify/);
  assert.match(dmgPackager, /hdiutil attach/);
  assert.match(dmgPackager, /mounted_sidecar/);
  assert.match(dmgPackager, /Resources\/bin\/line-cheater/);
  assert.match(dmgPackager, /--version/);
  assert.equal(fs.statSync(path.join(root, "scripts", "package-dmg.sh")).mode & 0o111, 0o111);
});

test("prefers the current debug sidecar during development", () => {
  assert.match(
    main,
    /} else \{\s+candidates\.push\(path\.resolve\(__dirname, "\.\.", "\.\.", "target", "debug", executable\)\);\s+candidates\.push\(path\.resolve\(__dirname, "\.\.", "\.\.", "target", "release", executable\)\);/
  );
});

test("packages and verifies a Windows x64 ZIP with the release sidecar", () => {
  assert.match(packageJson.scripts["package:win"], /build:native:win/);
  assert.match(packageJson.scripts["package:win"], /package-windows\.cjs/);
  assert.match(windowsPackager, /process\.platform !== "win32"/);
  assert.match(windowsPackager, /process\.arch !== "x64"/);
  assert.match(windowsPackager, /"line-cheater\.exe"/);
  assert.match(windowsPackager, /"electron\.exe"/);
  assert.match(windowsPackager, /"default_app\.asar"/);
  assert.match(windowsPackager, /"assets", "icon\.ico"/);
  assert.match(windowsPackager, /"rcedit-x64\.exe"/);
  assert.match(windowsPackager, /"--set-icon"/);
  assert.match(windowsPackager, /"Compress-Archive"/);
  assert.match(windowsPackager, /"Expand-Archive"/);
  assert.match(windowsPackager, /SHA256SUMS-Windows-x64\.txt/);
  assert.match(windowsPackager, /verifiedSidecar, \["--version"\]/);
  assert.match(main, /"line-cheater\.exe"/);
  assert.match(main, /"line-cheater"/);
  assert.doesNotMatch(main, /"line-backup-native\.exe"/);
});
