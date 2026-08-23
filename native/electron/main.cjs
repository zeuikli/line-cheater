"use strict";

const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  session,
  shell
} = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  clearSessionCache,
  listSessionCaches,
  outputFallsInsideSession,
  prepareSessionCache,
  readSessionCache,
  sessionWorkDir
} = require("./session-cache.cjs");
const { SidecarClient } = require("./sidecar-client.cjs");
const { findAvailableUpdate } = require("./update-checker.cjs");

app.setName("LINE Cheater");

const APP_ORIGIN = "line-cheater://app";
const allowedMethods = new Set([
  "sessionInfo",
  "listChats",
  "listMessages",
  "searchMessages",
  "scanCatalog",
  "listAttachments",
  "exportAttachments",
  "exportAttachmentsFiltered",
  "exportConversation",
  "setAttachmentMarked",
  "clearManualAttachmentPlan",
  "clearAllRemovalPlans",
  "catalogStats",
  "cleanupOverview",
  "cleanupCategoryActionState",
  "cleanupPreflight",
  "cleanupPlanPreviews",
  "cleanupAudit",
  "listCleanupGroups",
  "listCleanupReviews",
  "applyCleanupGroupAction",
  "applyCleanupCategoryAction",
  "setCleanupCategoryChatsRemovalPlanned",
  "planSafeAttachmentCleanup",
  "advancedCleanupReport",
  "setChatRemovalPlanned",
  "planAutomaticCleanup",
  "clearAdvancedCleanupPlan",
  "hashDuplicateCandidates",
  "listDuplicateGroups",
  "listDuplicateMembers",
  "buildCandidate"
]);
const jobMethods = new Set([
  "scanCatalog",
  "searchMessages",
  "hashDuplicateCandidates",
  "buildCandidate",
  "setAttachmentMarked",
  "clearManualAttachmentPlan",
  "clearAllRemovalPlans",
  "applyCleanupGroupAction",
  "applyCleanupCategoryAction",
  "setCleanupCategoryChatsRemovalPlanned",
  "planSafeAttachmentCleanup",
  "setChatRemovalPlanned",
  "planAutomaticCleanup",
  "clearAdvancedCleanupPlan",
  "exportAttachments",
  "exportAttachmentsFiltered",
  "exportConversation"
]);
const assetFiles = new Map([
  ["/assets/icon.png", path.join("assets", "icon.png")],
  ["/renderer.html", "renderer.html"],
  ["/renderer.js", "renderer.js"],
  ["/styles.css", "styles.css"],
  ["/data-provider.js", path.join("..", "frontend", "data-provider.js")]
]);

protocol.registerSchemesAsPrivileged([{
  scheme: "line-cheater",
  privileges: { standard: true, secure: true, supportFetchAPI: true }
}]);

let mainWindow = null;
let sidecar = null;
let activeSource = null;
let activeOperation = null;
let pendingCandidateFinalization = null;
let updateCheckStarted = false;
let closeConfirmationOpen = false;
let closeConfirmed = false;
const outputTokens = new Map();
const exportOutputTokens = new Map();
const conversationOutputTokens = new Map();
const previewTokens = new Map();
const MAX_PREVIEW_TOKENS = 128;
const MAX_PREVIEW_BYTES = 16 * 1024 * 1024;
const SESSION_CACHE_COMPATIBLE_VERSIONS = ["0.1.23", "0.1.24", "0.1.25", "0.1.26"];

async function checkForUpdates() {
  if (updateCheckStarted || !app.isPackaged) return;
  updateCheckStarted = true;
  try {
    const update = await findAvailableUpdate(
      app.getVersion(),
      (url, options) => net.fetch(url, options)
    );
    if (!update || !mainWindow || mainWindow.isDestroyed()) return;
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "有新版本可用",
      message: `LINE Cheater ${update.latestVersion} 已經發布`,
      detail: `目前版本：${update.currentVersion}\n是否前往 GitHub Releases 下載更新？`,
      buttons: ["前往下載", "稍後再說"],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (response === 0) {
      await shell.openExternal(update.releaseUrl, { activate: true });
    }
  } catch (error) {
    console.warn(`Unable to check for LINE Cheater updates: ${error.message}`);
  }
}

function assertTrustedSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error("Rejected IPC from an unknown renderer.");
  }
  const url = event.senderFrame && event.senderFrame.url || "";
  if (!url.startsWith(`${APP_ORIGIN}/`)) {
    throw new Error("Rejected IPC from an untrusted origin.");
  }
}

function rustBinaryPath() {
  const executable = process.platform === "win32"
    ? "line-cheater.exe"
    : "line-cheater";
  const candidates = [];
  if (process.env.LINE_BACKUP_NATIVE_BIN) {
    candidates.push(path.resolve(process.env.LINE_BACKUP_NATIVE_BIN));
  }
  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, "bin", executable));
    candidates.push(path.resolve(__dirname, "..", "..", "target", "release", executable));
    candidates.push(path.resolve(__dirname, "..", "..", "target", "debug", executable));
  } else {
    candidates.push(path.resolve(__dirname, "..", "..", "target", "debug", executable));
    candidates.push(path.resolve(__dirname, "..", "..", "target", "release", executable));
  }
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(
      "找不到 Rust sidecar。請先執行 cargo build -p line-cheater，" +
      "或設定 LINE_BACKUP_NATIVE_BIN。"
    );
  }
  return found;
}

function sourceDialogOptions(kind) {
  if (kind === "directory") {
    return { title: "選擇解開的 LINE 備份資料夾", properties: ["openDirectory"] };
  }
  if (kind === "sqlite") {
    return {
      title: "選擇 Line.sqlite",
      properties: ["openFile"],
      filters: [{ name: "SQLite", extensions: ["sqlite", "db"] }]
    };
  }
  return {
    title: "選擇 LINE .imazingapp",
    properties: ["openFile"],
    filters: [{ name: "iMazing App Data", extensions: ["imazingapp"] }]
  };
}

async function replaceSidecar(source, reuseSession = false) {
  if (sidecar) {
    const previous = sidecar;
    sidecar = null;
    await previous.dispose();
  }
  outputTokens.clear();
  exportOutputTokens.clear();
  conversationOutputTokens.clear();
  previewTokens.clear();
  pendingCandidateFinalization = null;
  activeSource = path.resolve(source);
  const userDataPath = app.getPath("userData");
  const { workDir } = prepareSessionCache(
    userDataPath,
    activeSource,
    app.getVersion(),
    SESSION_CACHE_COMPATIBLE_VERSIONS
  );
  const sidecarArguments = [
    "--work-dir", workDir,
    "serve", "--source", activeSource
  ];
  if (reuseSession) sidecarArguments.push("--reuse-session");
  const client = new SidecarClient(rustBinaryPath(), sidecarArguments);
  client.on("sidecarEvent", (event) => {
    if (event.event !== "ready" && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("line-native:event", event);
    }
  });
  client.on("sidecarFailure", (error) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("line-native:event", {
        event: "sidecarFailure",
        message: error.message
      });
    }
  });
  try {
    await client.ready;
  } catch (error) {
    await client.dispose();
    throw sourceOpenError(error);
  }
  sidecar = client;
  try {
    await client.request("recoverInterruptedOperations", {});
  } catch (error) {
    if (sidecar === client) sidecar = null;
    await client.dispose();
    throw error;
  }
  return client.ready;
}

async function closeCompletedSession(client, workDir, retainSession = false) {
  if (sidecar === client) sidecar = null;
  activeSource = null;
  outputTokens.clear();
  exportOutputTokens.clear();
  conversationOutputTokens.clear();
  previewTokens.clear();
  pendingCandidateFinalization = null;
  const warnings = [];
  try {
    await client.dispose();
  } catch (error) {
    warnings.push(`無法完全關閉背景核心：${error.message}`);
  }
  let cacheCleared = false;
  if (!retainSession) {
    try {
      clearSessionCache(app.getPath("userData"), workDir);
      cacheCleared = true;
    } catch (error) {
      warnings.push(`無法刪除本機快取：${error.message}`);
    }
  }
  return {
    cacheCleared,
    cacheRetained: retainSession || !cacheCleared,
    sessionPath: retainSession ? workDir : null,
    cacheCleanupWarning: warnings.join(" ")
  };
}

function sourceOpenError(error) {
  if (error && error.code === "sidecar_not_ready") {
    return new Error(
      "Rust 核心長時間沒有回應，備份可能位於很慢的磁碟或已無法讀取。" +
      "請確認來源檔案仍可存取，再重新選擇備份。"
    );
  }
  return error;
}

function cleanCancelledOperation(operation) {
  if (!operation) return true;
  try {
    if (operation.method === "buildCandidate" && operation.output) {
      fs.rmSync(`${operation.output}.partial`, {
        force: true,
        maxRetries: 10,
        retryDelay: 100
      });
    }
    if ((operation.method === "exportAttachments" ||
         operation.method === "exportAttachmentsFiltered") && operation.output) {
      fs.rmSync(`${operation.output}.partial`, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100
      });
    }
    if (operation.method === "exportConversation" && operation.output) {
      fs.rmSync(`${operation.output}.partial`, {
        force: true,
        maxRetries: 10,
        retryDelay: 100
      });
    }
    if (operation.workDir) {
      fs.rmSync(path.join(operation.workDir, "candidate-databases"), {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100
      });
    }
    return true;
  } catch {
    return false;
  }
}

async function registerIpc() {
  ipcMain.handle("line-native:list-sessions", (event) => {
    assertTrustedSender(event);
    return listSessionCaches(
      app.getPath("userData"),
      app.getVersion(),
      SESSION_CACHE_COMPATIBLE_VERSIONS
    );
  });

  ipcMain.handle("line-native:open-session", async (event, sessionId) => {
    assertTrustedSender(event);
    if (typeof sessionId !== "string" || !/^[0-9a-f]{64}$/.test(sessionId)) {
      throw new TypeError("Invalid session ID.");
    }
    let savedSession;
    try {
      savedSession = readSessionCache(
        app.getPath("userData"),
        sessionId,
        app.getVersion(),
        SESSION_CACHE_COMPATIBLE_VERSIONS
      );
    } catch {
      throw new Error("無法讀取這個工作階段；catalog.sqlite 可能已損壞或不完整。");
    }
    if (!savedSession) throw new Error("找不到指定的工作階段。");
    if (!savedSession.reusable) {
      throw new Error(`無法直接載入這個工作階段：${savedSession.unavailableReason}。`);
    }
    return replaceSidecar(savedSession.sourcePath, true);
  });

  ipcMain.handle("line-native:delete-session", async (event, sessionId) => {
    assertTrustedSender(event);
    if (typeof sessionId !== "string" || !/^[0-9a-f]{64}$/.test(sessionId)) {
      throw new TypeError("Invalid session ID.");
    }
    let savedSession;
    try {
      savedSession = readSessionCache(
        app.getPath("userData"),
        sessionId,
        app.getVersion(),
        SESSION_CACHE_COMPATIBLE_VERSIONS
      );
    } catch {
      throw new Error("無法讀取這個工作階段；catalog.sqlite 可能已損壞或不完整。");
    }
    if (!savedSession) throw new Error("找不到指定的工作階段。");
    const workDir = savedSession.sessionPath;
    const activeWorkDir = activeSource
      ? sessionWorkDir(app.getPath("userData"), activeSource)
      : null;
    const deletingActiveSession = activeWorkDir &&
      path.resolve(activeWorkDir) === path.resolve(workDir);
    if (deletingActiveSession) {
      if (activeOperation) {
        throw new Error("此工作階段目前仍有操作正在執行，請等待完成後再刪除。");
      }
      const result = await closeCompletedSession(sidecar, workDir, false);
      return {
        deleted: result.cacheCleared,
        activeSessionClosed: true,
        sourcePath: savedSession.sourcePath,
        sessionPath: workDir,
        warning: result.cacheCleanupWarning
      };
    }
    clearSessionCache(app.getPath("userData"), workDir);
    return {
      deleted: true,
      activeSessionClosed: false,
      sourcePath: savedSession.sourcePath,
      sessionPath: workDir,
      warning: ""
    };
  });

  ipcMain.handle("line-native:select-source", async (event, kind) => {
    assertTrustedSender(event);
    if (!["directory", "archive", "sqlite"].includes(kind)) {
      throw new TypeError("Invalid source kind.");
    }
    const result = await dialog.showOpenDialog(mainWindow, sourceDialogOptions(kind));
    if (result.canceled || result.filePaths.length !== 1) return null;
    return replaceSidecar(result.filePaths[0]);
  });

  ipcMain.handle("line-native:choose-candidate-output", async (event) => {
    assertTrustedSender(event);
    if (!sidecar) throw new Error("請先開啟並掃描備份。");
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "儲存瘦身候選備份",
      defaultPath: "LINE-slim.imazingapp",
      filters: [{ name: "iMazing App Data", extensions: ["imazingapp"] }]
    });
    if (result.canceled || !result.filePath) return null;
    const token = crypto.randomUUID();
    outputTokens.set(token, result.filePath);
    return { token, displayName: path.basename(result.filePath) };
  });

  ipcMain.handle("line-native:choose-export-output", async (event) => {
    assertTrustedSender(event);
    if (!sidecar || !activeSource) throw new Error("請先開啟並掃描備份。");
    const workDir = sessionWorkDir(app.getPath("userData"), activeSource);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "選擇附件匯出目的地資料夾",
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || result.filePaths.length !== 1) return null;
    const directory = path.resolve(result.filePaths[0]);
    if (outputFallsInsideSession(workDir, directory)) {
      throw new Error("匯出目的地不能位於 LINE Cheater 的本機快取內。");
    }
    const token = crypto.randomUUID();
    exportOutputTokens.set(token, directory);
    return { token, displayName: path.basename(directory) || directory };
  });

  ipcMain.handle("line-native:choose-conversation-output", async (event) => {
    assertTrustedSender(event);
    if (!sidecar || !activeSource) throw new Error("請先開啟並掃描備份。");
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "輸出完整討論串",
      defaultPath: "LINE-conversation.zip",
      filters: [{ name: "ZIP 封存檔", extensions: ["zip"] }]
    });
    if (result.canceled || !result.filePath) return null;
    const output = path.resolve(result.filePath);
    const workDir = sessionWorkDir(app.getPath("userData"), activeSource);
    if (outputFallsInsideSession(workDir, output)) {
      throw new Error("討論串輸出不能位於 LINE Cheater 的本機快取內。");
    }
    const token = crypto.randomUUID();
    conversationOutputTokens.set(token, output);
    return { token, displayName: path.basename(output) };
  });

  ipcMain.handle("line-native:discard-candidate-output", async (event, token) => {
    assertTrustedSender(event);
    token = String(token || "");
    const output = outputTokens.get(token);
    if (!output) return false;
    outputTokens.delete(token);
    const workDir = sessionWorkDir(app.getPath("userData"), activeSource);
    return cleanCancelledOperation({
      method: "buildCandidate",
      output,
      workDir
    });
  });

  ipcMain.handle("line-native:finalize-candidate-session", async (event, retainSession) => {
    assertTrustedSender(event);
    if (typeof retainSession !== "boolean") {
      throw new TypeError("A Session retention choice is required.");
    }
    if (!sidecar || !activeSource || !pendingCandidateFinalization) {
      throw new Error("目前沒有等待處理的分析工作階段。");
    }
    if (activeOperation) {
      throw new Error("候選檔仍在建立中，尚不能處理分析工作階段。");
    }
    const { client, workDir } = pendingCandidateFinalization;
    if (sidecar !== client ||
        path.resolve(workDir) !== path.resolve(
          sessionWorkDir(app.getPath("userData"), activeSource)
        )) {
      throw new Error("等待處理的分析工作階段已變更，將保留目前的快取。");
    }
    return closeCompletedSession(client, workDir, retainSession);
  });

  ipcMain.handle("line-native:cancel-operation", async (event) => {
    assertTrustedSender(event);
    if (!sidecar || !activeSource) return false;
    const current = sidecar;
    const source = activeSource;
    const operation = activeOperation;
    sidecar = null;
    activeOperation = null;
    await current.cancel();
    const cleanupComplete = cleanCancelledOperation(operation);
    await replaceSidecar(source);
    return { restarted: true, cleanupComplete };
  });

  ipcMain.handle("line-native:attachment-preview", async (event, attachmentPath) => {
    assertTrustedSender(event);
    if (!sidecar) throw new Error("尚未開啟備份。");
    if (typeof attachmentPath !== "string" ||
        !attachmentPath ||
        Buffer.byteLength(attachmentPath, "utf8") > 4096) {
      throw new TypeError("Invalid attachment preview path.");
    }
    const preview = await sidecar.request("stageAttachmentPreview", {
      path: attachmentPath
    });
    if (!preview ||
        typeof preview.stagedPath !== "string" ||
        !String(preview.mediaType || "").startsWith("image/") ||
        !Number.isSafeInteger(preview.bytes) ||
        preview.bytes < 1 ||
        preview.bytes > MAX_PREVIEW_BYTES) {
      throw new Error("Rust sidecar returned an invalid attachment preview.");
    }
    const filePath = fs.realpathSync(preview.stagedPath);
    const metadata = fs.statSync(filePath);
    if (!metadata.isFile() || metadata.size !== preview.bytes) {
      throw new Error("Attachment preview changed after validation.");
    }
    while (previewTokens.size >= MAX_PREVIEW_TOKENS) {
      previewTokens.delete(previewTokens.keys().next().value);
    }
    const token = crypto.randomUUID();
    previewTokens.set(token, {
      filePath,
      mediaType: preview.mediaType,
      bytes: preview.bytes
    });
    return `${APP_ORIGIN}/preview/${token}`;
  });

  ipcMain.handle("line-native:open-external", async (event, value) => {
    assertTrustedSender(event);
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 4096) {
      throw new TypeError("Invalid external URL.");
    }
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new TypeError("Invalid external URL.");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new TypeError("Only credential-free HTTP(S) URLs can be opened.");
    }
    await shell.openExternal(url.href, { activate: true });
    return true;
  });

  ipcMain.handle("line-native:request", async (event, method, params) => {
    assertTrustedSender(event);
    if (!sidecar) throw new Error("尚未開啟備份。");
    if (!allowedMethods.has(method)) throw new Error("Renderer requested a disallowed method.");
    const safeParams = params && typeof params === "object" && !Array.isArray(params)
      ? structuredClone(params)
      : {};
    const userDataPath = app.getPath("userData");
    const workDir = sessionWorkDir(userDataPath, activeSource);
    let candidateOutputToken = null;
    let exportOutputToken = null;
    let conversationOutputToken = null;
    if (method === "buildCandidate") {
      const token = String(safeParams.output || "");
      const output = outputTokens.get(token);
      if (!output) throw new Error("候選輸出授權已失效，請重新選擇位置。");
      if (outputFallsInsideSession(workDir, output)) {
        outputTokens.delete(token);
        throw new Error("候選輸出不能儲存在 LINE Cheater 的本機快取內。");
      }
      candidateOutputToken = token;
      safeParams.output = output;
    }
    if (method === "exportAttachments" || method === "exportAttachmentsFiltered") {
      const token = String(safeParams.output || "");
      const baseDirectory = exportOutputTokens.get(token);
      if (!baseDirectory) throw new Error("附件匯出目的地授權已失效，請重新選擇資料夾。");
      if (outputFallsInsideSession(workDir, baseDirectory)) {
        exportOutputTokens.delete(token);
        throw new Error("匯出目的地不能位於 LINE Cheater 的本機快取內。");
      }
      exportOutputToken = token;
      safeParams.output = path.join(
        baseDirectory,
        `LINE-Cheater-Export-${crypto.randomUUID()}`
      );
    }
    if (method === "exportConversation") {
      const token = String(safeParams.output || "");
      const output = conversationOutputTokens.get(token);
      if (!output) throw new Error("討論串輸出授權已失效，請重新選擇位置。");
      if (outputFallsInsideSession(workDir, output)) {
        conversationOutputTokens.delete(token);
        throw new Error("討論串輸出不能位於 LINE Cheater 的本機快取內。");
      }
      conversationOutputToken = token;
      safeParams.output = output;
    }
    const client = sidecar;
    const jobId = jobMethods.has(method) ? crypto.randomUUID() : null;
    const operation = { method, jobId, output: safeParams.output, workDir };
    activeOperation = operation;
    if (jobId && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("line-native:event", {
        event: "operationStarted",
        method,
        jobId
      });
    }
    try {
      const result = await client.request(method, safeParams, { jobId });
      if (method === "exportAttachments" || method === "exportAttachmentsFiltered") {
        exportOutputTokens.delete(exportOutputToken);
        return result;
      }
      if (method === "exportConversation") {
        conversationOutputTokens.delete(conversationOutputToken);
        return result;
      }
      if (method !== "buildCandidate") return result;
      if (result && result.lineSquareRebuildRequired === true) return result;
      outputTokens.delete(candidateOutputToken);
      pendingCandidateFinalization = { client, workDir };
      return { ...result, sessionFinalizationRequired: true };
    } catch (error) {
      if (candidateOutputToken) outputTokens.delete(candidateOutputToken);
      if (exportOutputToken) exportOutputTokens.delete(exportOutputToken);
      if (conversationOutputToken) conversationOutputTokens.delete(conversationOutputToken);
      throw error;
    } finally {
      if (activeOperation === operation) activeOperation = null;
    }
  });
}

function createWindow() {
  const windowIcon = process.platform === "win32"
    ? path.join(__dirname, "assets", "icon.ico")
    : path.join(__dirname, "assets", "icon.png");
  mainWindow = new BrowserWindow({
    title: "LINE Cheater",
    width: 1300,
    height: 960,
    minWidth: 1300,
    minHeight: 620,
    icon: windowIcon,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  closeConfirmed = false;
  closeConfirmationOpen = false;
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`${APP_ORIGIN}/`)) event.preventDefault();
  });
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    void checkForUpdates();
  });
  mainWindow.on("close", (event) => {
    if (closeConfirmed) return;
    event.preventDefault();
    if (closeConfirmationOpen || !mainWindow || mainWindow.isDestroyed()) return;
    closeConfirmationOpen = true;
    const windowToClose = mainWindow;
    void (async () => {
      try {
        const operationDetail = activeOperation
          ? `目前仍在執行「${activeOperation.method}」。關閉會取消工作，尚未提交的資料庫交易將回滾。`
          : "目前沒有執行中的工作，但關閉後需要重新開啟應用程式才能繼續。";
        const { response } = await dialog.showMessageBox(windowToClose, {
          type: activeOperation ? "warning" : "question",
          title: "確認關閉 LINE Cheater",
          message: "確定要關閉 LINE Cheater 嗎？",
          detail: operationDetail,
          buttons: ["繼續使用", "確認關閉"],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        });
        if (response !== 1 || windowToClose.isDestroyed()) return;
        closeConfirmed = true;
        windowToClose.close();
      } catch (error) {
        console.warn(`Unable to confirm main-window close: ${error.message}`);
      } finally {
        closeConfirmationOpen = false;
      }
    })();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    if (sidecar) void sidecar.dispose();
    sidecar = null;
    activeSource = null;
    activeOperation = null;
  });
  void mainWindow.loadURL(`${APP_ORIGIN}/renderer.html`);
}

app.whenReady().then(async () => {
  protocol.handle("line-cheater", async (request) => {
    const url = new URL(request.url);
    if (url.host !== "app") {
      return new Response("Not found", { status: 404 });
    }
    if (url.pathname.startsWith("/preview/")) {
      const token = url.pathname.slice("/preview/".length);
      const preview = previewTokens.get(token);
      if (!preview || !/^[0-9a-f-]{36}$/i.test(token)) {
        return new Response("Not found", { status: 404 });
      }
      const response = await net.fetch(pathToFileURL(preview.filePath).toString());
      return new Response(response.body, {
        status: response.status,
        headers: {
          "Content-Type": preview.mediaType,
          "Content-Length": String(preview.bytes),
          "Cache-Control": "private, no-store"
        }
      });
    }
    if (!assetFiles.has(url.pathname)) {
      return new Response("Not found", { status: 404 });
    }
    return net.fetch(pathToFileURL(path.join(__dirname, assetFiles.get(url.pathname))).toString());
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  await registerIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (sidecar) void sidecar.dispose();
});
