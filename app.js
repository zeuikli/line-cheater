/* global initSqlJs */

(function () {
  "use strict";

  var SQL_WASM_CDN = "https://cdn.jsdelivr.net/npm/sql.js@1.12.0/dist/";
  var MESSAGE_PAGE_SIZE = 180;
  var CHAT_ITEM_FALLBACK_HEIGHT = 65;
  var ATTACHMENT_CLEANUP_PAGE_SIZE = 24;
  var MAX_BLOB_CANDIDATE_BYTES = 256 * 1024 * 1024;
  var MAX_IN_MEMORY_SQLITE_BYTES = 1024 * 1024 * 1024;
  var ZIP_READ_CHUNK_BYTES = 512 * 1024;
  var ZIP_EVENT_LOOP_YIELD_INTERVAL = 16;
  var ZIP_CLASSIC_MAX_U16 = 0xfffe;
  var ZIP_CLASSIC_MAX_U32 = 0xfffffffe;
  var ZIP_CRC_TABLE = createZipCrcTable();
  var GITHUB_RELEASES_URL = "https://github.com/zeuikli/line-cheater/releases";
  var GITHUB_RELEASES_API_URL = "https://api.github.com/repos/zeuikli/line-cheater/releases?per_page=20";
  var chatResizeTimer = null;
  var packageInProgress = false;
  var imageModalTrigger = null;

  var state = {
    files: [],
    fileByPath: new Map(),
    sourceMode: "folder",
    sourceRoot: "",
    sourceSize: 0,
    indexFiles: [],
    indexManifest: null,
    indexConversations: [],
    indexParticipants: [],
    indexMode: false,
    database: null,
    squareDatabase: null,
    lineDatabasePath: "",
    sqlReady: false,
    capabilities: null,
    health: null,
    chats: [],
    chatPage: 1,
    users: new Map(),
    squareUsers: new Map(),
    groupsById: new Map(),
    groupsByPk: new Map(),
    unifiedGroupsById: new Map(),
    squareGroupsById: new Map(),
    groupNamesByChatPk: new Map(),
    chatsByKey: new Map(),
    chatsBySourcePk: new Map(),
    currentChat: null,
    currentMessages: [],
    currentOffset: 0,
    currentAfterTimestamp: 0,
    currentAfterPk: 0,
    currentCursors: { line: { timestamp: 0, pk: 0 }, square: { timestamp: 0, pk: 0 } },
    attachmentFiles: [],
    attachmentByBasename: new Map(),
    attachmentByMessageId: new Map(),
    attachmentByToken: new Map(),
    attachmentContextByPath: new Map(),
    attachmentReviewItems: [],
    attachmentReviewByPath: new Map(),
    attachmentCleanupGroups: [],
    selectedAttachmentCleanupGroup: "",
    attachmentCleanupPage: 1,
    attachmentCleanupSearch: "",
    attachmentKindFilter: "all",
    attachmentCategoryFilter: "all",
    attachmentSort: "recent",
    attachmentsMarkedForRemoval: new Set(),
    attachmentDuplicateGroups: [],
    objectUrls: new Set(),
    cleanupPreviewUrls: new Set(),
    selfId: ""
  };

  var el = {};

  document.addEventListener("DOMContentLoaded", function () {
    el.productLanding = document.getElementById("productLanding");
    el.openWebApp = document.getElementById("openWebApp");
    el.returnToLanding = document.getElementById("returnToLanding");
    el.macDownload = document.getElementById("macDownload");
    el.macDownloadMeta = document.getElementById("macDownloadMeta");
    el.windowsDownload = document.getElementById("windowsDownload");
    el.windowsDownloadMeta = document.getElementById("windowsDownloadMeta");
    el.releaseStatus = document.getElementById("releaseStatus");
    el.appFooter = document.getElementById("appFooter");
    el.folderInput = document.getElementById("folderInput");
    el.databaseInput = document.getElementById("databaseInput");
    el.indexInput = document.getElementById("indexInput");
    el.sourceModeInputs = Array.from(document.querySelectorAll('input[name="sourceMode"]'));
    el.folderSourcePicker = document.getElementById("folderSourcePicker");
    el.databaseSourcePicker = document.getElementById("databaseSourcePicker");
    el.indexSourcePicker = document.getElementById("indexSourcePicker");
    el.runtimeBadge = document.getElementById("runtimeBadge");
    el.loadStatus = document.getElementById("loadStatus");
    el.progressBar = document.getElementById("progressBar");
    el.appShell = document.querySelector("main.app-shell");
    el.workspace = document.getElementById("workspace");
    el.diffPanel = document.getElementById("diffPanel");
    el.chatCount = document.getElementById("chatCount");
    el.messageCount = document.getElementById("messageCount");
    el.attachmentCount = document.getElementById("attachmentCount");
    el.sourceSize = document.getElementById("sourceSize");
    el.chatSearch = document.getElementById("chatSearch");
    el.chatList = document.getElementById("chatList");
    el.chatPrevButton = document.getElementById("chatPrevButton");
    el.chatNextButton = document.getElementById("chatNextButton");
    el.chatPageInfo = document.getElementById("chatPageInfo");
    el.clearButton = document.getElementById("clearButton");
    el.selectedChatTitle = document.getElementById("selectedChatTitle");
    el.selectedChatMeta = document.getElementById("selectedChatMeta");
    el.selectedChatEvidence = document.getElementById("selectedChatEvidence");
    el.messageStatus = document.getElementById("messageStatus");
    el.messageList = document.getElementById("messageList");
    el.loadMoreButton = document.getElementById("loadMoreButton");
    el.exportHtmlButton = document.getElementById("exportHtmlButton");
    el.exportJsonButton = document.getElementById("exportJsonButton");
    el.attachmentSearch = document.getElementById("attachmentSearch");
    el.attachmentKindFilter = document.getElementById("attachmentKindFilter");
    el.attachmentCategoryFilter = document.getElementById("attachmentCategoryFilter");
    el.attachmentSort = document.getElementById("attachmentSort");
    el.attachmentCategorySummary = document.getElementById("attachmentCategorySummary");
    el.markedAttachmentCount = document.getElementById("markedAttachmentCount");
    el.markedAttachmentSize = document.getElementById("markedAttachmentSize");
    el.cleanupResultInfo = document.getElementById("cleanupResultInfo");
    el.attachmentCleanupList = document.getElementById("attachmentCleanupList");
    el.attachmentPrevButton = document.getElementById("attachmentPrevButton");
    el.attachmentNextButton = document.getElementById("attachmentNextButton");
    el.attachmentPageInfo = document.getElementById("attachmentPageInfo");
    el.exportCleanupPlanButton = document.getElementById("exportCleanupPlanButton");
    el.exportCleanupTextButton = document.getElementById("exportCleanupTextButton");
    el.buildImazingCandidateButton = document.getElementById("buildImazingCandidateButton");
    el.cleanupPackageStatus = document.getElementById("cleanupPackageStatus");
    el.capabilitySummary = document.getElementById("capabilitySummary");
    el.runHealthButton = document.getElementById("runHealthButton");
    el.healthSummary = document.getElementById("healthSummary");
    el.globalSearchInput = document.getElementById("globalSearchInput");
    el.globalSearchButton = document.getElementById("globalSearchButton");
    el.globalSearchChatSelect = document.getElementById("globalSearchChatSelect");
    el.globalSearchSenderSelect = document.getElementById("globalSearchSenderSelect");
    el.globalSearchContentType = document.getElementById("globalSearchContentType");
    el.globalSearchFrom = document.getElementById("globalSearchFrom");
    el.globalSearchTo = document.getElementById("globalSearchTo");
    el.searchEngineBadge = document.getElementById("searchEngineBadge");
    el.globalSearchResults = document.getElementById("globalSearchResults");
    el.runTimelineButton = document.getElementById("runTimelineButton");
    el.timelineSummary = document.getElementById("timelineSummary");
    el.schemaTableSelect = document.getElementById("schemaTableSelect");
    el.schemaStatus = document.getElementById("schemaStatus");
    el.schemaExplorer = document.getElementById("schemaExplorer");
    el.scanAttachmentDuplicatesButton = document.getElementById("scanAttachmentDuplicatesButton");
    el.duplicateStatus = document.getElementById("duplicateStatus");
    el.duplicateResults = document.getElementById("duplicateResults");
    el.diffLeftInput = document.getElementById("diffLeftInput");
    el.diffRightInput = document.getElementById("diffRightInput");
    el.runDiffButton = document.getElementById("runDiffButton");
    el.diffStatus = document.getElementById("diffStatus");
    el.diffResults = document.getElementById("diffResults");
    el.loadModal = document.getElementById("loadModal");
    el.loadModalCard = el.loadModal && el.loadModal.querySelector(".package-modal-card");
    el.loadModalMessage = document.getElementById("loadModalMessage");
    el.loadModalProgress = document.getElementById("loadModalProgress");
    el.loadModalProgressLabel = document.getElementById("loadModalProgressLabel");
    el.packageModal = document.getElementById("packageModal");
    el.packageModalCard = el.packageModal && el.packageModal.querySelector(".package-modal-card");
    el.packageModalTitle = document.getElementById("packageModalTitle");
    el.packageModalMessage = document.getElementById("packageModalMessage");
    el.packageModalProgress = document.getElementById("packageModalProgress");
    el.packageModalProgressLabel = document.getElementById("packageModalProgressLabel");
    el.packageModalClose = document.getElementById("packageModalClose");
    el.imageModal = document.getElementById("imageModal");
    el.imageModalCard = el.imageModal && el.imageModal.querySelector(".image-modal-card");
    el.imageModalImage = document.getElementById("imageModalImage");
    el.imageModalCaption = document.getElementById("imageModalCaption");
    el.imageModalClose = document.getElementById("imageModalClose");

    el.openWebApp.addEventListener("click", function () {
      showWebApp(true);
    });
    el.returnToLanding.addEventListener("click", function () {
      showProductLanding(true);
    });
    el.folderInput.addEventListener("change", function (event) {
      loadSource(event.target.files, "folder");
    });
    el.databaseInput.addEventListener("change", function (event) {
      loadSource(event.target.files, "database");
    });
    el.indexInput.addEventListener("change", function (event) {
      loadSource(event.target.files, "index");
    });
    el.sourceModeInputs.forEach(function (input) {
      input.addEventListener("change", function (event) {
        switchSourceMode(event.target.value);
      });
    });
    el.chatSearch.addEventListener("input", function () {
      state.chatPage = 1;
      renderChatList();
    });
    el.chatPrevButton.addEventListener("click", function () {
      if (state.chatPage > 1) {
        state.chatPage -= 1;
        renderChatList();
      }
    });
    el.chatNextButton.addEventListener("click", function () {
      var totalPages = getChatTotalPages();
      if (state.chatPage < totalPages) {
        state.chatPage += 1;
        renderChatList();
      }
    });
    el.clearButton.addEventListener("click", clearWorkspace);
    el.loadMoreButton.addEventListener("click", loadMoreMessages);
    el.exportHtmlButton.addEventListener("click", exportCurrentHtml);
    el.exportJsonButton.addEventListener("click", exportCurrentJson);
    el.attachmentSearch.addEventListener("input", function (event) {
      state.attachmentCleanupSearch = event.target.value.trim().toLowerCase();
      state.attachmentCleanupPage = 1;
      renderAttachmentCleanup();
    });
    el.attachmentKindFilter.addEventListener("change", function (event) {
      state.attachmentKindFilter = event.target.value || "all";
      state.attachmentCleanupPage = 1;
      renderAttachmentCleanup();
    });
    el.attachmentCategoryFilter.addEventListener("change", function (event) {
      state.attachmentCategoryFilter = event.target.value || "all";
      state.selectedAttachmentCleanupGroup = "";
      state.attachmentCleanupPage = 1;
      renderAttachmentCleanup();
    });
    el.attachmentSort.addEventListener("change", function (event) {
      state.attachmentSort = event.target.value || "recent";
      state.attachmentCleanupPage = 1;
      renderAttachmentCleanup();
    });
    el.attachmentCategorySummary.addEventListener("click", function (event) {
      var button = event.target.closest("button[data-attachment-category]");
      if (!button) return;
      state.attachmentCategoryFilter = button.getAttribute("data-attachment-category") || "all";
      state.selectedAttachmentCleanupGroup = "";
      state.attachmentCleanupPage = 1;
      el.attachmentCategoryFilter.value = state.attachmentCategoryFilter;
      renderAttachmentCleanup();
    });
    el.attachmentPrevButton.addEventListener("click", function () {
      if (state.attachmentCleanupPage > 1) {
        state.attachmentCleanupPage -= 1;
        renderAttachmentCleanup();
      }
    });
    el.attachmentNextButton.addEventListener("click", function () {
      var totalPages = getAttachmentCleanupTotalPages();
      if (state.attachmentCleanupPage < totalPages) {
        state.attachmentCleanupPage += 1;
        renderAttachmentCleanup();
      }
    });
    el.attachmentCleanupList.addEventListener("change", function (event) {
      var checkbox = event.target.closest("input[data-attachment-path]");
      if (!checkbox) return;
      var path = checkbox.getAttribute("data-attachment-path");
      if (checkbox.checked) state.attachmentsMarkedForRemoval.add(path);
      else state.attachmentsMarkedForRemoval.delete(path);
      if (state.attachmentKindFilter === "marked") renderAttachmentCleanup();
      else updateCleanupSummary();
    });
    el.attachmentCleanupList.addEventListener("click", function (event) {
      var openGroupButton = event.target.closest("button[data-cleanup-open-group]");
      if (openGroupButton) {
        state.selectedAttachmentCleanupGroup = decodeURIComponent(openGroupButton.getAttribute("data-cleanup-open-group") || "");
        state.attachmentCleanupPage = 1;
        renderAttachmentCleanup();
        return;
      }
      var backButton = event.target.closest("button[data-cleanup-back]");
      if (backButton) {
        state.selectedAttachmentCleanupGroup = "";
        state.attachmentCleanupPage = 1;
        renderAttachmentCleanup();
        return;
      }
      var actionButton = event.target.closest("button[data-cleanup-group-action]");
      if (!actionButton) return;
      var groupKey = decodeURIComponent(actionButton.getAttribute("data-cleanup-group") || "");
      var group = state.attachmentCleanupGroups.find(function (item) {
        return item.key === groupKey;
      });
      if (!group) return;
      var action = actionButton.getAttribute("data-cleanup-group-action");
      var shouldMarkAll = action === "remove" && !isCleanupGroupFullyMarked(group);
      var shouldRestoreOriginals = action === "keep-thumbnail" && isCleanupGroupKeepingThumbnails(group);
      group.reviews.forEach(function (review) {
        var thumbnailBackedImage = cleanupReviewHasThumbnailBackedImage(review);
        review.files.forEach(function (descriptor) {
          if (action === "keep-thumbnail") {
            if (!thumbnailBackedImage) return;
            if (descriptor.kind === "original") {
              if (shouldRestoreOriginals) state.attachmentsMarkedForRemoval.delete(descriptor.path);
              else state.attachmentsMarkedForRemoval.add(descriptor.path);
            } else if (!shouldRestoreOriginals) {
              state.attachmentsMarkedForRemoval.delete(descriptor.path);
            }
            return;
          }
          if (shouldMarkAll) state.attachmentsMarkedForRemoval.add(descriptor.path);
          else state.attachmentsMarkedForRemoval.delete(descriptor.path);
        });
      });
      renderAttachmentCleanup();
    });
    el.exportCleanupPlanButton.addEventListener("click", exportAttachmentCleanupPlan);
    el.exportCleanupTextButton.addEventListener("click", exportAttachmentCleanupInstructions);
    el.buildImazingCandidateButton.addEventListener("click", buildImazingCandidatePackage);
    el.runHealthButton.addEventListener("click", runBrowserHealth);
    el.globalSearchButton.addEventListener("click", runGlobalSearch);
    el.globalSearchInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter") runGlobalSearch();
    });
    el.runTimelineButton.addEventListener("click", runTimelineAnalysis);
    el.schemaTableSelect.addEventListener("change", function (event) {
      renderSchemaTable(event.target.value);
    });
    el.scanAttachmentDuplicatesButton.addEventListener("click", scanAttachmentDuplicates);
    el.duplicateResults.addEventListener("click", function (event) {
      var button = event.target.closest("button[data-duplicate-group]");
      if (!button) return;
      markDuplicateAlternatives(Number(button.getAttribute("data-duplicate-group")));
    });
    el.runDiffButton.addEventListener("click", runBrowserDiff);
    el.packageModalClose.addEventListener("click", closePackageModal);
    el.imageModalClose.addEventListener("click", closeImageModal);
    el.imageModal.addEventListener("click", function (event) {
      if (event.target === el.imageModal || event.target.classList.contains("image-modal-backdrop")) closeImageModal();
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") closeImageModal();
    });
    window.addEventListener("resize", scheduleChatLayoutRefresh);
    window.addEventListener("hashchange", function () {
      if (window.location.hash === "#web-app") showWebApp(false);
      else showProductLanding(false);
    });
    updateSourceModeUi();
    loadDesktopReleaseLinks();
    if (window.location.hash === "#web-app") showWebApp(false);

    if (typeof window.initSqlJs !== "function") {
      setRuntime("SQL.js 載入失敗", true);
      setStatus("無法載入資料解析引擎。請確認網路連線正常，或重新整理頁面再試。", true);
    }
  });

  function showWebApp(updateHistory) {
    if (!el.productLanding || !el.appShell) return;
    el.productLanding.classList.add("hidden");
    el.appShell.classList.remove("hidden");
    if (el.appFooter) el.appFooter.classList.remove("hidden");
    document.body.classList.add("web-app-active");
    if (updateHistory && window.location.hash !== "#web-app") {
      window.history.pushState(null, "", "#web-app");
    }
    window.requestAnimationFrame(function () {
      var title = document.getElementById("webAppTitle");
      if (title) title.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    });
  }

  function showProductLanding(updateHistory) {
    if (!el.productLanding || !el.appShell) return;
    el.productLanding.classList.remove("hidden");
    el.appShell.classList.add("hidden");
    if (el.appFooter) el.appFooter.classList.add("hidden");
    document.body.classList.remove("web-app-active");
    if (updateHistory && window.location.hash) {
      window.history.pushState(null, "", window.location.pathname + window.location.search);
    }
    window.requestAnimationFrame(function () {
      var title = document.getElementById("productTitle");
      if (title) title.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    });
  }

  function loadDesktopReleaseLinks() {
    setDesktopReleaseFallback(false);
    if (typeof window.fetch !== "function") {
      setDesktopReleaseFallback(true);
      return;
    }
    window.fetch(GITHUB_RELEASES_API_URL, {
      cache: "no-store",
      headers: { Accept: "application/vnd.github+json" }
    }).then(function (response) {
      if (!response.ok) throw new Error("GitHub 回應失敗：" + response.status);
      return response.json();
    }).then(function (releases) {
      var published = Array.isArray(releases) ? releases.filter(function (release) {
        return release && !release.draft && !release.prerelease;
      }) : [];
      var macAsset = findDesktopReleaseAsset(published, /macOS-arm64\.dmg$/i);
      var windowsAsset = findDesktopReleaseAsset(published, /Windows-x64\.zip$/i);
      configurePlatformDownload(el.macDownload, el.macDownloadMeta, macAsset, "macOS 12+ · Apple Silicon");
      configurePlatformDownload(el.windowsDownload, el.windowsDownloadMeta, windowsAsset, "Windows 10/11 · x64");
      if (el.releaseStatus) {
        el.releaseStatus.textContent = macAsset && windowsAsset
          ? "下載連結由 GitHub 最新正式 Release 提供。"
          : "部分平台尚未找到對應資產，可前往 GitHub Releases 查看所有版本。";
      }
      highlightCurrentPlatform();
    }).catch(function () {
      setDesktopReleaseFallback(true);
    });
  }

  function findDesktopReleaseAsset(releases, filenamePattern) {
    for (var releaseIndex = 0; releaseIndex < releases.length; releaseIndex += 1) {
      var release = releases[releaseIndex];
      var assets = Array.isArray(release.assets) ? release.assets : [];
      for (var assetIndex = 0; assetIndex < assets.length; assetIndex += 1) {
        var asset = assets[assetIndex];
        if (asset && filenamePattern.test(String(asset.name || "")) && asset.browser_download_url) {
          return { url: asset.browser_download_url, version: release.tag_name || release.name || "最新版本" };
        }
      }
    }
    return null;
  }

  function configurePlatformDownload(link, meta, asset, platformLabel) {
    if (!link || !meta) return;
    link.href = asset ? asset.url : GITHUB_RELEASES_URL;
    link.classList.toggle("is-unavailable", !asset);
    link.removeAttribute("aria-disabled");
    if (asset) {
      meta.textContent = asset.version + " · " + platformLabel;
      link.removeAttribute("title");
    } else {
      meta.textContent = "尚未提供，前往 Releases 查看";
      link.title = "尚未找到此平台的正式 Release，將開啟 GitHub Releases。";
    }
  }

  function setDesktopReleaseFallback(hasError) {
    configurePlatformDownload(el.macDownload, el.macDownloadMeta, null, "");
    configurePlatformDownload(el.windowsDownload, el.windowsDownloadMeta, null, "");
    if (el.releaseStatus) {
      el.releaseStatus.textContent = hasError
        ? "目前無法取得最新版本，請從 GitHub Releases 選擇下載檔。"
        : "正在讀取最新桌面版資訊。";
    }
    highlightCurrentPlatform();
  }

  function highlightCurrentPlatform() {
    var userAgent = String(navigator.userAgent || "");
    var preferred = /Windows/i.test(userAgent) ? el.windowsDownload : (/Macintosh|Mac OS X/i.test(userAgent) ? el.macDownload : null);
    [el.macDownload, el.windowsDownload].forEach(function (link) {
      if (!link) return;
      link.classList.toggle("is-platform-match", link === preferred);
      if (link === preferred) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    });
  }

  function setRuntime(text, isError) {
    el.runtimeBadge.textContent = text;
    el.runtimeBadge.classList.toggle("error", Boolean(isError));
  }

  function setStatus(text, isError) {
    el.loadStatus.textContent = text;
    el.loadStatus.classList.toggle("error", Boolean(isError));
    if (el.loadModal && !el.loadModal.classList.contains("hidden")) {
      el.loadModalMessage.textContent = text;
    }
  }

  function setProgress(value) {
    var progress = Math.max(0, Math.min(100, value));
    el.progressBar.style.width = progress + "%";
    if (el.loadModal && !el.loadModal.classList.contains("hidden")) {
      el.loadModalProgress.style.width = progress + "%";
      el.loadModalProgress.setAttribute("aria-valuenow", String(progress));
      el.loadModalProgressLabel.textContent = Math.round(progress) + "%";
    }
  }

  function waitForUiPaint() {
    return new Promise(function (resolve) {
      window.requestAnimationFrame(function () {
        window.setTimeout(resolve, 0);
      });
    });
  }

  function showLoadModal() {
    if (!el.loadModal) return;
    el.loadModal.classList.remove("hidden");
    el.loadModal.setAttribute("aria-hidden", "false");
    el.loadModalMessage.textContent = "正在準備選取的檔案，請勿關閉此頁面。";
    el.loadModalProgress.style.width = "0%";
    el.loadModalProgress.setAttribute("aria-valuenow", "0");
    el.loadModalProgressLabel.textContent = "0%";
    document.body.classList.add("load-modal-open");
    if (el.appShell) {
      el.appShell.inert = true;
      el.appShell.setAttribute("aria-busy", "true");
    }
    if (el.diffPanel) el.diffPanel.inert = true;
    window.requestAnimationFrame(function () {
      if (el.loadModalCard) el.loadModalCard.focus();
    });
  }

  function closeLoadModal() {
    if (!el.loadModal) return;
    el.loadModal.classList.add("hidden");
    el.loadModal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("load-modal-open");
    if (el.appShell) {
      el.appShell.inert = false;
      el.appShell.removeAttribute("aria-busy");
    }
    if (el.diffPanel) el.diffPanel.inert = false;
  }

  function switchSourceMode(mode) {
    var nextMode = mode === "database" || mode === "index" ? mode : "folder";
    clearWorkspace(true);
    state.sourceMode = nextMode;
    updateSourceModeUi();
    setStatus(nextMode === "database" ? "請選取 Messages/Line.sqlite。" : (nextMode === "index" ? "請選取 CLI 產生的 line-reader-index 資料夾。" : "請選取完整 LINE 備份資料夾。"), false);
  }

  function updateSourceModeUi() {
    var databaseOnly = state.sourceMode === "database";
    var indexOnly = state.sourceMode === "index";
    el.sourceModeInputs.forEach(function (input) {
      input.checked = input.value === state.sourceMode;
    });
    if (el.folderSourcePicker) el.folderSourcePicker.classList.toggle("hidden", databaseOnly);
    if (el.databaseSourcePicker) el.databaseSourcePicker.classList.toggle("hidden", !databaseOnly);
    if (el.indexSourcePicker) el.indexSourcePicker.classList.toggle("hidden", !indexOnly);
    if (el.folderSourcePicker) el.folderSourcePicker.classList.toggle("hidden", databaseOnly || indexOnly);
  }

  async function loadSource(fileList, mode) {
    var sourceMode = mode === "database" || mode === "index" ? mode : "folder";
    clearWorkspace(false);
    state.sourceMode = sourceMode;
    updateSourceModeUi();
    if (!fileList || !fileList.length) {
      setStatus(sourceMode === "database" ? "尚未選取 Line.sqlite。" : (sourceMode === "index" ? "尚未選取大型備份索引。" : "尚未選取備份資料夾。"), false);
      return;
    }

    showLoadModal();
    try {
      setRuntime("準備讀取…", false);
      setStatus("正在準備選取的檔案…", false);
      setProgress(1);
      await waitForUiPaint();
      setRuntime("讀取中…", false);
      setStatus("正在建立檔案索引…", false);
      setProgress(5);
      state.files = Array.from(fileList);
      state.sourceSize = state.files.reduce(function (sum, file) { return sum + file.size; }, 0);
      state.fileByPath = new Map(state.files.map(function (file) { return [relativePath(file), file]; }));
      state.sourceRoot = sourceMode === "database" ? relativePath(state.files[0]) : inferRoot(state.files);
      setStatus("正在確認來源結構…", false);
      setProgress(10);
      await waitForUiPaint();
      if (sourceMode === "index") {
        await loadReaderIndex();
        closeLoadModal();
        return;
      }
      state.attachmentCleanupPage = 1;
      state.attachmentCleanupSearch = "";
      state.attachmentKindFilter = "all";
      state.attachmentCategoryFilter = "all";
      state.attachmentSort = "recent";
      state.selectedAttachmentCleanupGroup = "";
      state.attachmentsMarkedForRemoval = new Set();
      if (el.attachmentSearch) el.attachmentSearch.value = "";
      if (el.attachmentKindFilter) el.attachmentKindFilter.value = "all";
      if (el.attachmentCategoryFilter) el.attachmentCategoryFilter.value = "all";
      if (el.attachmentSort) el.attachmentSort.value = "recent";
      state.attachmentFiles = sourceMode === "folder" ? state.files.filter(function (file) {
        var path = relativePath(file);
        return ( /\/Message Attachments\//.test(path) || /\/Message Thumbnails\//.test(path) ) && !fileNameOf(path).startsWith(".");
      }) : [];
      buildAttachmentIndex();

      var lineFile = sourceMode === "database" ? state.files[0] : findLineDatabaseFile();
      if (!lineFile) {
        throw new Error("找不到 Messages/Line.sqlite。請選取包含 Container 的完整 LINE 資料夾。");
      }
      if (sourceMode === "database" && !/Line\.sqlite$/i.test(lineFile.name)) {
        throw new Error("只讀訊息模式需要選取 Messages/Line.sqlite。");
      }

      if (lineFile.size > MAX_IN_MEMORY_SQLITE_BYTES) {
        throw new Error(
          "這個 Line.sqlite 為 " + formatBytes(lineFile.size) + "，超過瀏覽器目前的安全記憶體載入上限（" +
          formatBytes(MAX_IN_MEMORY_SQLITE_BYTES) + "）。請改用 CLI／本機 helper；瀏覽器 20 GB+ 分頁讀取仍需 SQLite WASM VFS 實驗。"
        );
      }

      setStatus("正在載入 SQLite 資料庫…", false);
      var buffer = await lineFile.arrayBuffer();
      setProgress(35);
      var SQL = await initSqlJs({ locateFile: function (file) { return SQL_WASM_CDN + file; } });
      state.database = new SQL.Database(new Uint8Array(buffer));
      state.lineDatabasePath = relativePath(lineFile);
      state.sqlReady = true;
      setProgress(60);

      loadReferenceData();
      await loadUnifiedGroupReference(SQL);
      await loadLineSquareReference(SQL);
      setProgress(78);
      loadChats();
      populateSearchFilters();
      buildAttachmentContextIndex();
      buildAttachmentReviewIndex();
      setProgress(92);
      renderAttachmentCleanup();
      updateStats();
      initializeBrowserInsights();
      el.workspace.classList.remove("hidden");
      if (el.diffPanel) el.diffPanel.classList.remove("hidden");
      setRuntime("已載入", false);
      setStatus(
        sourceMode === "database"
          ? "訊息資料庫載入完成；只讀訊息模式不包含附件檔案。"
          : "完整備份解析完成。",
        false
      );
      setProgress(100);
      renderChatList();
      closeLoadModal();
    } catch (error) {
      setRuntime("載入失敗", true);
      setStatus(error && error.message ? error.message : String(error), true);
      setProgress(0);
      console.error(error);
      closeLoadModal();
    }
  }

  async function loadReaderIndex() {
    var manifestFile = state.files.find(function (file) { return /(?:^|\/)manifest\.json$/i.test(relativePath(file)); });
    var conversationsFile = state.files.find(function (file) { return /(?:^|\/)conversations\.jsonl$/i.test(relativePath(file)); });
    if (!manifestFile || !conversationsFile) {
      throw new Error("大型索引缺少 manifest.json 或 conversations.jsonl；請先用 CLI index 產生完整索引。");
    }
    var manifest = JSON.parse(await manifestFile.text());
    var conversationRows = parseJsonLines(await conversationsFile.text());
    var participantsFile = findIndexFile("participants.jsonl");
    state.indexParticipants = participantsFile ? parseJsonLines(await participantsFile.text()) : [];
    state.indexMode = true;
    state.indexManifest = manifest;
    state.indexConversations = conversationRows;
    state.chats = conversationRows.map(function (row) {
      var legacyMemberTitle = stringOrEmpty(row.titleSource) === "members";
      return {
        key: sourcePkKey("index", numberOrNull(row.chatPk)),
        pk: numberOrNull(row.chatPk),
        id: stringOrEmpty(row.id),
        type: stringOrEmpty(row.type) || "unknown",
        title: legacyMemberTitle ? firstNonEmpty(row.id, "未命名聊天室") : firstNonEmpty(row.title, row.id, "未命名聊天室"),
        titleSource: legacyMemberTitle ? "unresolved" : (stringOrEmpty(row.titleSource) || "unresolved"),
        titleEvidence: Array.isArray(row.titleEvidence) ? row.titleEvidence : [],
        messageCount: Number(row.messageCount || 0),
        humanMessageCount: Number(row.humanMessageCount !== undefined ? row.humanMessageCount : row.messageCount || 0),
        lastMessage: stringOrEmpty(row.lastMessage),
        lastTimestamp: normalizeTimestamp(row.lastTimestamp)
      };
    });
    state.chatsByKey = new Map(state.chats.map(function (chat) { return [chat.key, chat]; }));
    state.chatsBySourcePk = new Map();
    populateSearchFilters();
    state.attachmentFiles = [];
    state.capabilities = manifest.capabilities || {
      source: "CLI 大型索引",
      sqlite_version: "由 CLI 產生",
      json_functions: "not_needed",
      fts5: manifest.search_sidecar ? "available" : "not_built",
      window_functions: "not_needed",
      dbstat: "not_needed",
      read_only: true,
      warnings: ["目前使用分片 JSONL；未在瀏覽器開啟原始 Line.sqlite。"]
    };
    state.health = manifest.health || {
      status: "not_checked",
      checks: { message_rows: manifest.message_rows, conversation_count: manifest.conversation_count, source_sha256: manifest.database_sha256 },
      warnings: ["大型索引只驗證 manifest 與分片格式；SQLite integrity_check 請使用 CLI health。"]
    };
    updateStats();
    renderCapabilitySummary();
    renderHealthSummary();
    renderSchemaExplorerEmpty("大型索引模式不直接開啟 SQLite Schema；請用 CLI schema 查詢原始資料庫。");
    renderAttachmentCleanup();
    if (el.globalSearchButton) el.globalSearchButton.disabled = false;
    if (el.searchEngineBadge) el.searchEngineBadge.textContent = "JSONL 分片掃描";
    if (el.globalSearchResults) el.globalSearchResults.innerHTML = '<span class="empty-state">輸入關鍵字後搜尋所有聊天室。</span>';
    el.workspace.classList.remove("hidden");
    if (el.diffPanel) el.diffPanel.classList.remove("hidden");
    setRuntime("大型索引已載入", false);
    setStatus("大型索引載入完成；瀏覽器只讀取 manifest、聊天室清單與目前聊天室分片。", false);
    setProgress(100);
    renderChatList();
  }

  function parseJsonLines(text) {
    return String(text || "").split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean).map(function (line) {
      return JSON.parse(line);
    });
  }

  async function loadUnifiedGroupReference(SQL) {
    state.unifiedGroupsById.clear();
    if (state.sourceMode !== "folder") return;
    var file = findUnifiedGroupReferenceFile();
    if (!file || file.size > MAX_IN_MEMORY_SQLITE_BYTES) return;
    var companion = null;
    try {
      companion = new SQL.Database(new Uint8Array(await file.arrayBuffer()));
      var statement = companion.prepare("SELECT ZID AS groupId, ZNAME AS name, ZTYPE AS groupType FROM ZUNIFIEDGROUP WHERE ZID IS NOT NULL AND ZNAME IS NOT NULL");
      try {
        while (statement.step()) {
          var row = statement.getAsObject();
          var groupId = stringOrEmpty(row.groupId);
          var name = stringOrEmpty(row.name).trim();
          if (groupId && name) state.unifiedGroupsById.set(lookupId(groupId), { id: groupId, name: name, type: numberOrNull(row.groupType), source: "unified-group", sourceDatabase: "Messages/UnifiedGroup.sqlite", sourceTable: "ZUNIFIEDGROUP", sourceColumn: "ZNAME", confidence: "exact" });
        }
      } finally {
        statement.free();
      }
    } catch (error) {
      console.warn("UnifiedGroup.sqlite 讀取失敗", error);
    } finally {
      if (companion) companion.close();
    }
  }

  async function loadLineSquareReference(SQL) {
    state.squareGroupsById.clear();
    state.squareUsers.clear();
    if (state.sourceMode !== "folder") return;
    var file = findLineSquareReferenceFile();
    if (!file || file.size > MAX_IN_MEMORY_SQLITE_BYTES) return;
    try {
      state.squareDatabase = new SQL.Database(new Uint8Array(await file.arrayBuffer()));
      var chatColumns = new Set(querySource("square", "PRAGMA table_info(ZCHAT)", {}).map(function (row) { return String(row.name || "").toUpperCase(); }));
      var squareColumns = new Set(querySource("square", "PRAGMA table_info(ZSQUARE)", {}).map(function (row) { return String(row.name || "").toUpperCase(); }));
      var canJoinSquare = chatColumns.has("ZSQUARE") && squareColumns.has("Z_PK");
      var nameExpressions = [];
      if (canJoinSquare && squareColumns.has("ZNAME")) nameExpressions.push("NULLIF(s.ZNAME, '')");
      if (chatColumns.has("ZNAME")) nameExpressions.push("NULLIF(c.ZNAME, '')");
      var nameExpression = nameExpressions.length > 1 ? "COALESCE(" + nameExpressions.join(", ") + ")" : (nameExpressions[0] || "NULL");
      var statement = state.squareDatabase.prepare(
        "SELECT c.Z_PK AS chatPk, c.ZMID AS chatId, " +
        nameExpression + " AS name " +
        "FROM ZCHAT c " + (canJoinSquare ? "LEFT JOIN ZSQUARE s ON s.Z_PK = c.ZSQUARE " : "") +
        "WHERE c.ZMID IS NOT NULL"
      );
      try {
        while (statement.step()) {
          var row = statement.getAsObject();
          var chatId = stringOrEmpty(row.chatId);
          var name = stringOrEmpty(row.name).trim();
          if (chatId && name) state.squareGroupsById.set(lookupId(chatId), { id: chatId, name: name, chatPk: numberOrNull(row.chatPk), source: "line-square", sourceDatabase: "Messages/LineSquare.sqlite", sourceTable: "ZCHAT/ZSQUARE", sourceColumn: "ZNAME", confidence: "exact" });
        }
      } finally {
        statement.free();
      }
      safeQuerySource("square", "SELECT Z_PK AS memberPk, ZCHAT AS chatPk, ZDISPLAYNAME AS displayName, ZMID AS memberId FROM ZSQUAREMEMBER", {}).forEach(function (row) {
        var member = {
          pk: numberOrNull(row.memberPk),
          chatPk: numberOrNull(row.chatPk),
          id: stringOrEmpty(row.memberId),
          name: firstNonEmpty(row.displayName, row.memberId, "未知使用者")
        };
        if (member.pk !== null) state.squareUsers.set(sourcePkKey("square", member.pk), member);
      });
    } catch (error) {
      console.warn("LineSquare.sqlite 讀取失敗", error);
      if (state.squareDatabase) {
        try { state.squareDatabase.close(); } catch (closeError) { console.warn(closeError); }
      }
      state.squareDatabase = null;
    }
  }

  function findIndexFile(path) {
    var normalized = String(path || "").replace(/^\.?\//, "");
    return state.files.find(function (file) {
      var candidate = relativePath(file).replace(/^\.?\//, "");
      return candidate === normalized || candidate.endsWith("/" + normalized);
    }) || null;
  }

  function indexShardFiles(chatPk) {
    var configured = state.indexManifest && Array.isArray(state.indexManifest.chat_shards) ? state.indexManifest.chat_shards.filter(function (shard) {
      return numberOrNull(shard.chat_pk) === numberOrNull(chatPk);
    }) : [];
    if (configured.length) {
      return configured.map(function (shard) { return findIndexFile(shard.path); }).filter(Boolean);
    }
    var prefix = "messages/chat-" + (chatPk === null || chatPk === undefined ? "unknown" : chatPk) + "-";
    return state.files.filter(function (file) {
      var path = relativePath(file).replace(/^.*?\//, "");
      return path.indexOf(prefix) === 0 && path.endsWith(".jsonl");
    }).sort(function (left, right) { return relativePath(left).localeCompare(relativePath(right)); });
  }

  function inferRoot(files) {
    var first = relativePath(files[0]);
    return first.split("/")[0] || "";
  }

  function relativePath(file) {
    return file.webkitRelativePath || file.name;
  }

  function lookupId(value) {
    return String(value || "").trim().normalize("NFKC").toLowerCase();
  }

  function findFileEnding(suffix) {
    return state.files.find(function (file) {
      return relativePath(file).endsWith(suffix);
    }) || null;
  }

  function findLineDatabaseFile() {
    var candidates = state.files.filter(function (file) {
      return relativePath(file).endsWith("/Messages/Line.sqlite");
    });
    candidates.sort(function (left, right) {
      var leftPreferred = /\/PrivateStore\/P_[^/]+\/Messages\/Line\.sqlite$/.test(relativePath(left)) ? 1 : 0;
      var rightPreferred = /\/PrivateStore\/P_[^/]+\/Messages\/Line\.sqlite$/.test(relativePath(right)) ? 1 : 0;
      if (leftPreferred !== rightPreferred) return rightPreferred - leftPreferred;
      return (Number(right.size) || 0) - (Number(left.size) || 0);
    });
    return candidates[0] || null;
  }

  function findUnifiedGroupReferenceFile() {
    var candidates = state.files.filter(function (file) {
      return relativePath(file).endsWith("/Messages/UnifiedGroup.sqlite");
    });
    candidates.sort(function (left, right) {
      var leftPrivate = /\/PrivateStore\/P_[^/]+\/Messages\/UnifiedGroup\.sqlite$/.test(relativePath(left)) ? 1 : 0;
      var rightPrivate = /\/PrivateStore\/P_[^/]+\/Messages\/UnifiedGroup\.sqlite$/.test(relativePath(right)) ? 1 : 0;
      if (leftPrivate !== rightPrivate) return rightPrivate - leftPrivate;
      return (Number(right.size) || 0) - (Number(left.size) || 0);
    });
    return candidates[0] || null;
  }

  function findLineSquareReferenceFile() {
    var candidates = state.files.filter(function (file) {
      return relativePath(file).endsWith("/Messages/LineSquare.sqlite");
    });
    candidates.sort(function (left, right) {
      var lineStore = privateStoreKey(state.lineDatabasePath);
      var leftSameStore = lineStore && privateStoreKey(relativePath(left)) === lineStore ? 1 : 0;
      var rightSameStore = lineStore && privateStoreKey(relativePath(right)) === lineStore ? 1 : 0;
      if (leftSameStore !== rightSameStore) return rightSameStore - leftSameStore;
      var leftPrivate = /\/PrivateStore\/P_[^/]+\/Messages\/LineSquare\.sqlite$/.test(relativePath(left)) ? 1 : 0;
      var rightPrivate = /\/PrivateStore\/P_[^/]+\/Messages\/LineSquare\.sqlite$/.test(relativePath(right)) ? 1 : 0;
      if (leftPrivate !== rightPrivate) return rightPrivate - leftPrivate;
      return (Number(right.size) || 0) - (Number(left.size) || 0);
    });
    return candidates[0] || null;
  }

  function privateStoreKey(path) {
    var match = String(path || "").match(/\/PrivateStore\/(P_[^/]+)\/Messages\//);
    return match ? match[1] : "";
  }

  function databaseForSource(source) {
    return source === "square" ? state.squareDatabase : state.database;
  }

  function sourceDatabaseLabel(source) {
    return source === "square" ? "Messages/LineSquare.sqlite" : "Messages/Line.sqlite";
  }

  function sourcePkKey(source, pk) {
    return source + ":" + String(pk);
  }

  function chatKeyForId(chatId, source, chatPk) {
    var id = lookupId(chatId);
    return id ? "zmid:" + id : sourcePkKey(source, chatPk);
  }

  function querySource(source, sql, params) {
    var database = databaseForSource(source);
    if (!database) throw new Error(sourceDatabaseLabel(source) + " 尚未載入。");
    var statement = database.prepare(sql);
    var rows = [];
    try {
      statement.bind(params || {});
      while (statement.step()) rows.push(statement.getAsObject());
    } finally {
      statement.free();
    }
    return rows;
  }

  function safeQuerySource(source, sql, params) {
    try {
      return querySource(source, sql, params);
    } catch (error) {
      console.warn("SQLite 查詢失敗", sourceDatabaseLabel(source), error);
      return [];
    }
  }

  function query(sql, params) {
    return querySource("line", sql, params);
  }

  function loadReferenceData() {
    state.users.clear();
    state.groupsById.clear();
    state.groupsByPk.clear();
    state.unifiedGroupsById.clear();
    state.squareGroupsById.clear();
    state.groupNamesByChatPk.clear();

    safeQuery("SELECT Z_PK, ZMID, ZNAME, ZADDRESSBOOKNAME, ZCUSTOMNAME, ZSTATUSMESSAGE FROM ZUSER", {}).forEach(function (row) {
      var user = {
        pk: numberOrNull(row.Z_PK),
        id: stringOrEmpty(row.ZMID),
        name: firstNonEmpty(row.ZCUSTOMNAME, row.ZADDRESSBOOKNAME, row.ZNAME, row.ZMID, "未知使用者"),
        status: stringOrEmpty(row.ZSTATUSMESSAGE)
      };
      if (user.id) {
        state.users.set(user.id, user);
        state.users.set(lookupId(user.id), user);
      }
      state.users.set("pk:" + user.pk, user);
    });

    safeQuery("SELECT Z_PK, ZID, ZNAME, ZCREATEDTIME FROM ZGROUP", {}).forEach(function (row) {
      var group = {
        pk: numberOrNull(row.Z_PK),
        id: stringOrEmpty(row.ZID),
        name: firstNonEmpty(row.ZNAME, row.ZID, "未命名群組"),
        createdAt: normalizeTimestamp(row.ZCREATEDTIME)
      };
      if (group.id) state.groupsById.set(lookupId(group.id), group);
      state.groupsByPk.set("pk:" + group.pk, group);
    });

    loadGroupTitleData();

    var accountMatch = state.files.map(relativePath).join("\n").match(/P_([^/]+)/);
    state.selfId = accountMatch ? accountMatch[1] : "";
  }

  function loadGroupTitleData() {
    safeQuery(
      "SELECT m.ZCHAT AS chatPk, m.Z_PK AS messagePk, m.ZTIMESTAMP AS timestamp, m.ZTEXT AS text " +
      "FROM ZMESSAGE m JOIN ZCHAT c ON c.Z_PK = m.ZCHAT " +
      "WHERE c.ZTYPE IN (1, 2, 4, 100) AND m.ZCONTENTTYPE = 18 AND m.ZTEXT IS NOT NULL " +
      "ORDER BY m.ZCHAT ASC, COALESCE(m.ZTIMESTAMP, 0) ASC, m.Z_PK ASC",
      {}
    ).forEach(function (row) {
      var name = extractGroupNameFromSystemText(row.text);
      if (name) state.groupNamesByChatPk.set(Number(row.chatPk), { name: name, source: "rename", messagePk: numberOrNull(row.messagePk), sourceDatabase: "Messages/Line.sqlite", sourceTable: "ZMESSAGE", sourceColumn: "ZTEXT", confidence: "inferred" });
    });
  }

  function extractGroupNameFromSystemText(value) {
    var text = stringOrEmpty(value).replace(/[\u2068\u2069\u200b\ufeff]/g, "").trim();
    var patterns = [
      /群組名稱\s*改為\s*[「『"“](.*?)[」』"”]/,
      /(?:change|changed)\s+the\s+group\s+name\s+to\s*[「『"“](.*?)[」』"”]/i,
      /(?:群組名稱|group\s+name)[^「『"“]{0,24}[「『"“](.*?)[」』"”]/i
    ];
    for (var i = 0; i < patterns.length; i += 1) {
      var match = text.match(patterns[i]);
      if (match && match[1] && match[1].trim()) return match[1].trim();
    }
    return "";
  }

  function loadChats() {
    var lineChats = loadSourceChatRows("line");
    var squareChats = state.squareDatabase ? loadSourceChatRows("square") : [];
    var merged = new Map();
    lineChats.concat(squareChats).forEach(function (sourceChat) {
      var key = chatKeyForId(sourceChat.id, sourceChat.source, sourceChat.pk);
      var chat = merged.get(key);
      if (!chat) {
        chat = {
          key: key,
          pk: sourceChat.source === "line" ? sourceChat.pk : null,
          id: sourceChat.id,
          type: sourceChat.type,
          title: sourceChat.title,
          titleSource: sourceChat.titleSource,
          titleEvidence: sourceChat.titleEvidence,
          messageCount: 0,
          humanMessageCount: 0,
          lastMessage: "",
          lastTimestamp: null,
          sourceChats: { line: null, square: null }
        };
        merged.set(key, chat);
      }
      chat.sourceChats[sourceChat.source] = { pk: sourceChat.pk, type: sourceChat.rawType, messageCount: sourceChat.messageCount, humanMessageCount: sourceChat.humanMessageCount };
      if (sourceChat.source === "line" || chat.pk === null) chat.pk = sourceChat.pk;
      chat.messageCount += sourceChat.messageCount;
      chat.humanMessageCount += sourceChat.humanMessageCount;
      if (!chat.lastTimestamp || (sourceChat.lastTimestamp && sourceChat.lastTimestamp > chat.lastTimestamp)) {
        chat.lastTimestamp = sourceChat.lastTimestamp;
        chat.lastMessage = sourceChat.lastMessage;
      }
      if (sourceChat.source === "square" && sourceChat.titleSource === "line-square") {
        chat.title = sourceChat.title;
        chat.type = "community";
        chat.titleSource = sourceChat.titleSource;
        chat.titleEvidence = sourceChat.titleEvidence;
      }
    });
    state.chats = Array.from(merged.values()).sort(function (left, right) {
      return (right.lastTimestamp ? right.lastTimestamp.getTime() : 0) - (left.lastTimestamp ? left.lastTimestamp.getTime() : 0);
    });
    state.chatsByKey = new Map(state.chats.map(function (chat) { return [chat.key, chat]; }));
    state.chatsBySourcePk = new Map();
    state.chats.forEach(function (chat) {
      ["line", "square"].forEach(function (source) {
        var reference = chat.sourceChats[source];
        if (reference && reference.pk !== null) state.chatsBySourcePk.set(sourcePkKey(source, reference.pk), chat);
      });
    });
  }

  function loadSourceChatRows(source) {
    var rows = safeQuerySource(
      source,
      "SELECT c.Z_PK AS chatPk, c.ZMID AS chatId, c.ZTYPE AS chatType, " +
      "c.ZLASTUPDATED AS lastUpdated, c.ZLASTMESSAGE AS lastMessage, " +
      "COUNT(m.Z_PK) AS messageCount, " +
      "SUM(CASE WHEN m.Z_PK IS NOT NULL " +
        "AND (m.ZCONTENTTYPE IS NULL OR m.ZCONTENTTYPE NOT IN (7, 18, 96, 111)) " +
        "AND NOT ((m.ZSENDER IS NULL OR m.ZSENDER = '') AND m.ZSENDSTATUS = 0 AND (m.ZID IS NULL OR m.ZID = '')) " +
        "THEN 1 ELSE 0 END) AS humanMessageCount, " +
      "MAX(m.ZTIMESTAMP) AS lastMessageTimestamp " +
      "FROM ZCHAT c LEFT JOIN ZMESSAGE m ON m.ZCHAT = c.Z_PK " +
      "GROUP BY c.Z_PK",
      {}
    );
    return rows.map(function (row) {
      var titleInfo = resolveChatTitle(row.chatId, row.chatType, row.chatPk, source);
      return {
        source: source,
        pk: numberOrNull(row.chatPk),
        id: stringOrEmpty(row.chatId),
        rawType: numberOrNull(row.chatType),
        type: titleInfo.type,
        title: titleInfo.title,
        titleSource: titleInfo.source,
        titleEvidence: titleInfo.evidence || [],
        messageCount: Number(row.messageCount || 0),
        humanMessageCount: Number(row.humanMessageCount || 0),
        lastMessage: stringOrEmpty(row.lastMessage),
        lastTimestamp: normalizeTimestamp(row.lastMessageTimestamp || row.lastUpdated)
      };
    });
  }

  function populateSearchFilters() {
    if (el.globalSearchChatSelect) {
      el.globalSearchChatSelect.innerHTML = '<option value="">全部聊天室</option>' + state.chats.slice().sort(function (left, right) { return left.title.localeCompare(right.title); }).map(function (chat) {
        return '<option value="' + escapeHtml(chat.key) + '">' + escapeHtml(chat.title) + '</option>';
      }).join("");
    }
    if (el.globalSearchSenderSelect) {
      var usersByPk = new Map();
      Array.from(state.users.values()).forEach(function (user) { if (user && user.pk !== null && user.pk !== undefined) usersByPk.set(String(user.pk), user); });
      (state.indexParticipants || []).forEach(function (user) { if (user && user.pk !== null && user.pk !== undefined) usersByPk.set(String(user.pk), user); });
      var users = Array.from(usersByPk.values()).sort(function (left, right) { return String(left.name || "").localeCompare(String(right.name || "")); });
      el.globalSearchSenderSelect.innerHTML = '<option value="">全部傳送者</option>' + users.map(function (user) {
        return '<option value="' + escapeHtml(String(user.pk)) + '">' + escapeHtml(user.name || user.id || "未知使用者") + '</option>';
      }).join("");
    }
    if (el.globalSearchContentType) {
      var types = state.indexMode ? [{ value: 0, label: "一般文字／訊息" }, { value: 7, label: "貼圖／媒體" }, { value: 18, label: "系統訊息" }, { value: 96, label: "通話" }] : safeQuery("SELECT DISTINCT ZCONTENTTYPE AS value FROM ZMESSAGE WHERE ZCONTENTTYPE IS NOT NULL ORDER BY ZCONTENTTYPE", {}).map(function (row) { return { value: Number(row.value), label: "contentType " + row.value }; });
      el.globalSearchContentType.innerHTML = '<option value="">全部種類</option>' + types.map(function (type) { return '<option value="' + escapeHtml(String(type.value)) + '">' + escapeHtml(type.label) + '</option>'; }).join("");
    }
  }

  function buildAttachmentContextIndex() {
    state.attachmentContextByPath = new Map();
    if (state.sourceMode === "database" || !state.attachmentFiles.length || !state.database) return;

    var messageIds = Array.from(new Set(state.attachmentFiles.map(attachmentMessageId).filter(Boolean)));
    var messageRowsResult = loadMessageRowsByIds(messageIds);
    var messagesById = new Map();
    messageRowsResult.rows.forEach(function (row) {
      var id = stringOrEmpty(row.messageId);
      if (!messagesById.has(id)) messagesById.set(id, []);
      messagesById.get(id).push(row);
    });
    state.attachmentFiles.forEach(function (file) {
      var path = relativePath(file);
      var messageId = attachmentMessageId(file);
      var pathContext = attachmentPathContext(path);
      var chat = state.chatsByKey.get(chatKeyForId(pathContext.chatId));
      var candidates = messageId ? (messagesById.get(messageId) || []).filter(function (row) {
        return chat && chat.sourceChats[row.source] && Number(chat.sourceChats[row.source].pk) === Number(row.chatPk);
      }) : [];
      var row = candidates.length === 1 ? candidates[0] : null;
      var sender = row ? sourceSender(row.source, row.senderPk) : null;
      var text = row ? stringOrEmpty(row.text).trim() : "";
      var kind = row ? messageKind(row.contentType, row.messageType, text) : "";
      var isSelf = Boolean(
        sender && state.selfId && sender.id === state.selfId ||
        row && Number(row.sendStatus) === 1
      );
      var scope = chat ? chat.type : "orphan";
      if (scope === "direct") scope = "individual";
      var context = {
        messageId: messageId,
        messagePk: row ? numberOrNull(row.messagePk) : null,
        chatPk: chat ? chat.pk : null,
        chatId: chat ? chat.id : "",
        chatTitle: chat ? chat.title : "SQLite 未找到對應聊天室",
        scope: scope,
        relation: row ? "SQLite 訊息 ID 對應" : (candidates.length > 1 ? "多個 SQLite 訊息候選，未自動關聯" : "SQLite 未引用／孤兒檔案"),
        sender: sender ? sender.name : (row ? "未知使用者" : "—"),
        direction: row ? (isSelf ? "傳送" : "接收／其他") : "—",
        timestamp: row ? normalizeTimestamp(row.timestamp) : null,
        context: text || (kind ? "[" + kind + "]" : "沒有可用訊息文字"),
        kind: kind,
        status: row ? "exact" : (candidates.length > 1 ? "ambiguous" : "unlinked"),
        source: row ? row.source : "",
        sourceDatabase: row ? sourceDatabaseLabel(row.source) : ""
      };
      state.attachmentContextByPath.set(path, context);
    });
  }

  function attachmentMessageId(file) {
    var archivePath = archiveRelativePath(file);
    var basename = fileNameOf(archivePath);
    var match = basename.match(/^(\d{8,})(?:[_.-]|$)/);
    if (match) return match[1];
    match = archivePath.match(/(?:^|\/)(\d{8,})(?:[_.-]|\/|$)/);
    return match ? match[1] : "";
  }

  function sourceSender(source, senderPk) {
    if (senderPk === null || senderPk === undefined || senderPk === "") return null;
    return source === "square"
      ? state.squareUsers.get(sourcePkKey("square", numberOrNull(senderPk)))
      : state.users.get("pk:" + numberOrNull(senderPk));
  }

  function loadMessageRowsByIds(messageIds) {
    var rows = [];
    var ids = Array.from(messageIds);
    try {
      ["line", "square"].forEach(function (source) {
        if (!databaseForSource(source)) return;
        for (var start = 0; start < ids.length; start += 300) {
          var chunk = ids.slice(start, start + 300);
          var params = {};
          var placeholders = chunk.map(function (id, index) {
            var key = "$messageId" + index;
            params[key] = id;
            return key;
          });
          querySource(
            source,
            "SELECT m.ZID AS messageId, m.Z_PK AS messagePk, m.ZTIMESTAMP AS timestamp, m.ZCHAT AS chatPk, " +
              "m.ZSENDER AS senderPk, m.ZSENDSTATUS AS sendStatus, m.ZCONTENTTYPE AS contentType, m.ZTEXT AS text " +
              "FROM ZMESSAGE m WHERE m.ZID IN (" + placeholders.join(",") + ")",
            params
          ).forEach(function (row) {
            row.source = source;
            rows.push(row);
          });
        }
      });
      return { success: true, rows: rows };
    } catch (error) {
      console.warn("Cleanup attachment reference scan failed", error);
      return { success: false, rows: [] };
    }
  }

  function attachmentContext(file) {
    return state.attachmentContextByPath.get(relativePath(file)) || {
      messageId: attachmentMessageId(file),
      messagePk: null,
      chatPk: null,
      chatId: "",
      chatTitle: "SQLite 未找到對應聊天室",
      scope: "orphan",
      relation: "SQLite 未引用／孤兒檔案",
      sender: "—",
      direction: "—",
      timestamp: null,
      context: "沒有可用訊息脈絡",
      kind: "",
      status: "unlinked"
    };
  }

  function resolveChatTitle(chatId, chatType, chatPk) {
    var id = stringOrEmpty(chatId);
    var idKey = lookupId(id);
    var normalizedType = Number(chatType);
    var group = state.groupsById.get(idKey);
    var unifiedGroup = state.unifiedGroupsById.get(idKey);
    var squareGroup = state.squareGroupsById.get(idKey);
    var user = state.users.get(idKey);
    if (user && normalizedType === 0) return { title: user.name, type: "direct", source: "user", evidence: [{ sourceDatabase: "Messages/Line.sqlite", sourceTable: "ZUSER", sourceColumn: "ZCUSTOMNAME/ZADDRESSBOOKNAME/ZNAME", sourcePk: user.pk, confidence: "exact" }] };

    if (squareGroup && normalizedType !== 0) return { title: squareGroup.name, type: "community", source: squareGroup.source, evidence: [{ sourceDatabase: squareGroup.sourceDatabase, sourceTable: squareGroup.sourceTable, sourceColumn: squareGroup.sourceColumn, sourcePk: squareGroup.chatPk, confidence: squareGroup.confidence }] };

    if (unifiedGroup && normalizedType !== 0) return { title: unifiedGroup.name, type: chatTypeLabel(normalizedType), source: "unified-group", evidence: [{ sourceDatabase: unifiedGroup.sourceDatabase, sourceTable: unifiedGroup.sourceTable, sourceColumn: unifiedGroup.sourceColumn, confidence: unifiedGroup.confidence }] };

    if (group) return { title: group.name, type: "group", source: "group", evidence: [{ sourceDatabase: "Messages/Line.sqlite", sourceTable: "ZGROUP", sourceColumn: "ZNAME", sourcePk: group.pk, confidence: "exact" }] };

    var groupName = state.groupNamesByChatPk.get(Number(chatPk));
    if (groupName) return { title: groupName.name, type: chatTypeLabel(normalizedType), source: groupName.source, evidence: [{ sourceDatabase: groupName.sourceDatabase, sourceTable: groupName.sourceTable, sourceColumn: groupName.sourceColumn, sourcePk: groupName.messagePk, confidence: groupName.confidence }] };

    if (user) return { title: user.name, type: "direct", source: "user", evidence: [{ sourceDatabase: "Messages/Line.sqlite", sourceTable: "ZUSER", sourceColumn: "ZCUSTOMNAME/ZADDRESSBOOKNAME/ZNAME", sourcePk: user.pk, confidence: "exact" }] };
    return { title: id || (normalizedType === 0 ? "未命名聊天室" : "未命名群組"), type: chatTypeLabel(normalizedType), source: "unresolved", evidence: [{ sourceDatabase: "Messages/Line.sqlite", sourceTable: "ZCHAT", sourceColumn: "ZMID", sourcePk: numberOrNull(chatPk), confidence: "unresolved" }] };
  }

  function chatHasMessages(chat) {
    return Number(chat.messageCount) > 0;
  }

  function getVisibleChats(term) {
    return state.chats.filter(function (chat) {
      return chatHasMessages(chat) && (!term || (chat.title + " " + chat.id).toLowerCase().indexOf(term) !== -1);
    });
  }

  function renderChatList() {
    if (!el.chatList) return;
    var term = (el.chatSearch.value || "").trim().toLowerCase();
    var visible = getVisibleChats(term);
    var pageSize = getChatPageSize();
    var totalPages = Math.max(1, Math.ceil(visible.length / pageSize));
    state.chatPage = Math.min(Math.max(1, state.chatPage), totalPages);
    var pageStart = (state.chatPage - 1) * pageSize;
    var pageItems = visible.slice(pageStart, pageStart + pageSize);
    el.chatList.innerHTML = "";
    if (!visible.length) {
      el.chatList.innerHTML = '<div class="empty-state">找不到符合的聊天室。</div>';
      updateChatPagination(0, 1);
      return;
    }
    pageItems.forEach(function (chat) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "chat-item" + (state.currentChat && state.currentChat.key === chat.key ? " selected" : "");
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", state.currentChat && state.currentChat.key === chat.key ? "true" : "false");
      button.innerHTML = '<span class="chat-item-title"></span><span class="chat-item-meta"><span></span><span></span></span>';
      button.querySelector(".chat-item-title").textContent = chat.title;
      button.querySelector(".chat-item-meta span:first-child").textContent = formatNumber(chat.humanMessageCount) + " 則";
      button.querySelector(".chat-item-meta span:last-child").textContent = formatDate(chat.lastTimestamp);
      button.addEventListener("click", function () { selectChat(chat); });
      el.chatList.appendChild(button);
    });
    updateChatPagination(visible.length, totalPages);
  }

  function getChatTotalPages() {
    var term = (el.chatSearch && el.chatSearch.value || "").trim().toLowerCase();
    var visibleCount = getVisibleChats(term).length;
    return Math.max(1, Math.ceil(visibleCount / getChatPageSize()));
  }

  function getChatPageSize() {
    if (!el.chatList) return 1;
    var listHeight = el.chatList.clientHeight;
    var sample = el.chatList.querySelector(".chat-item");
    var itemHeight = sample ? sample.getBoundingClientRect().height : CHAT_ITEM_FALLBACK_HEIGHT;
    var computedStyle = window.getComputedStyle(el.chatList);
    var gap = parseFloat(computedStyle.rowGap || computedStyle.gap) || 4;
    if (!listHeight || !itemHeight) return 1;
    return Math.max(1, Math.floor((listHeight + gap) / (itemHeight + gap)));
  }

  function scheduleChatLayoutRefresh() {
    if (chatResizeTimer) window.clearTimeout(chatResizeTimer);
    chatResizeTimer = window.setTimeout(function () {
      chatResizeTimer = null;
      if (getVisibleChats("").length) renderChatList();
    }, 120);
  }

  function updateChatPagination(visibleCount, totalPages) {
    if (!el.chatPageInfo) return;
    el.chatPageInfo.textContent = visibleCount ? "第 " + state.chatPage + " / " + totalPages + " 頁 · " + formatNumber(visibleCount) + " 個聊天室" : "沒有聊天室";
    el.chatPrevButton.disabled = !visibleCount || state.chatPage <= 1;
    el.chatNextButton.disabled = !visibleCount || state.chatPage >= totalPages;
  }

  function selectChat(chat) {
    state.currentChat = chat;
    state.currentMessages = [];
    state.currentOffset = 0;
    state.currentAfterTimestamp = 0;
    state.currentAfterPk = 0;
    state.currentCursors = { line: { timestamp: 0, pk: 0 }, square: { timestamp: 0, pk: 0 } };
    el.selectedChatTitle.textContent = chat.title;
    el.selectedChatMeta.textContent = typeLabel(chat.type) + " · " + formatNumber(chat.humanMessageCount) + " 則人類訊息 · 名稱來源：" + titleSourceLabel(chat.titleSource) + " · " + (chat.id || "無 ID");
    renderChatEvidence(chat);
    el.exportHtmlButton.disabled = false;
    el.exportJsonButton.disabled = false;
    el.runTimelineButton.disabled = false;
    renderChatList();
    if (state.indexMode) loadIndexChatMessages(chat);
    else loadMoreMessages();
  }

  function renderChatEvidence(chat) {
    if (!el.selectedChatEvidence) return;
    var evidence = Array.isArray(chat && chat.titleEvidence) ? chat.titleEvidence : [];
    if (!evidence.length) {
      el.selectedChatEvidence.innerHTML = '<details><summary>為什麼是這個聊天室名稱？</summary><p class="muted">目前沒有可追溯的 SQLite 名稱證據；已保留原始 ID，未使用成員資料猜測。</p></details>';
      return;
    }
    el.selectedChatEvidence.innerHTML = '<details><summary>查看名稱來源證據</summary><ul>' + evidence.map(function (item) {
      return '<li>' + escapeHtml([item.sourceDatabase, item.sourceTable, item.sourceColumn].filter(Boolean).join(" · ") || "SQLite 證據") + (item.sourcePk !== undefined && item.sourcePk !== null ? ' · PK ' + escapeHtml(String(item.sourcePk)) : '') + ' · ' + escapeHtml(item.confidence || "unknown") + '</li>';
    }).join("") + '</ul></details>';
  }

  async function loadIndexChatMessages(chat) {
    var files = indexShardFiles(chat.pk);
    state.currentMessages = [];
    state.currentOffset = 0;
    if (!files.length) {
      renderMessages();
      el.loadMoreButton.classList.add("hidden");
      return;
    }
    el.messageStatus.textContent = "正在讀取大型索引分片…";
    try {
      for (var index = 0; index < files.length; index += 1) {
        var rows = parseJsonLines(await files[index].text());
        state.currentMessages = state.currentMessages.concat(rows.map(mapIndexMessage));
        await new Promise(function (resolve) { window.setTimeout(resolve, 0); });
      }
      state.currentOffset = state.currentMessages.length;
      renderMessages();
      el.loadMoreButton.classList.add("hidden");
    } catch (error) {
      el.messageStatus.textContent = "索引分片讀取失敗：" + (error && error.message ? error.message : String(error));
      el.messageStatus.classList.add("error");
    }
  }

  function mapIndexMessage(row) {
    var text = stringOrEmpty(row.text);
    var timestamp = normalizeTimestamp(row.timestamp_raw);
    return {
      pk: numberOrNull(row.pk),
      id: stringOrEmpty(row.id),
      timestampRaw: row.timestamp_raw,
      timestamp: timestamp,
      senderId: stringOrEmpty(row.sender_pk),
      sender: firstNonEmpty(row.sender_name, "未知使用者"),
      isSelf: Boolean(row.is_self),
      isSystem: false,
      sendStatus: numberOrNull(row.send_status),
      contentType: row.content_type,
      messageType: stringOrEmpty(row.message_type),
      kind: text ? "text" : messageKind(row.content_type, row.message_type, text),
      call: null,
      text: text,
      latitude: numberOrNull(row.latitude),
      longitude: numberOrNull(row.longitude),
      thumbnail: null,
      linkPreviews: [],
      attachmentHints: [],
      attachments: [],
      provenance: {
        sourceMode: "index",
        sourceShard: row.source_shard || "",
        sourceTable: "ZMESSAGE",
        sourcePk: numberOrNull(row.pk),
        confidence: "exact"
      }
    };
  }

  function loadMoreMessages() {
    if (!state.currentChat) return;
    if (state.indexMode) {
      loadIndexChatMessages(state.currentChat);
      return;
    }
    var batches = [];
    ["line", "square"].forEach(function (source) {
      var reference = state.currentChat.sourceChats && state.currentChat.sourceChats[source];
      if (!reference || !databaseForSource(source)) return;
      var cursor = state.currentCursors[source];
      var rows = loadMessagePageForSource(source, reference.pk, cursor, MESSAGE_PAGE_SIZE);
      if (rows.length) {
        var last = rows[rows.length - 1];
        cursor.timestamp = Number(last.timestamp) || 0;
        cursor.pk = Number(last.messagePk) || cursor.pk;
      }
      batches = batches.concat(rows.map(function (row) { return mapMessage(row, source); }));
    });
    batches.sort(compareMessages);
    state.currentMessages = state.currentMessages.concat(batches);
    state.currentOffset += batches.length;
    renderMessages();
    el.loadMoreButton.classList.toggle("hidden", state.currentOffset >= state.currentChat.messageCount || batches.length === 0);
  }

  function loadMessagePageForSource(source, chatPk, cursor, limit) {
    return safeQuerySource(
      source,
      "SELECT m.Z_PK AS messagePk, m.ZID AS messageId, m.ZTIMESTAMP AS timestamp, " +
      "m.ZSENDER AS senderPk, m.ZSENDSTATUS AS sendStatus, m.ZCONTENTTYPE AS contentType, m.ZTEXT AS text, " +
      "m.ZMESSAGETYPE AS messageType, m.ZLATITUDE AS latitude, m.ZLONGITUDE AS longitude, " +
      "m.ZCONTENTMETADATA AS contentMetadata, m.ZTHUMBNAIL AS thumbnail, m.ZCHAT AS chatPk " +
      "FROM ZMESSAGE m WHERE m.ZCHAT = $chatPk " +
      "AND (COALESCE(m.ZTIMESTAMP, 0) > $afterTimestamp OR " +
      "(COALESCE(m.ZTIMESTAMP, 0) = $afterTimestamp AND m.Z_PK > $afterPk)) " +
      "ORDER BY COALESCE(m.ZTIMESTAMP, 0) ASC, m.Z_PK ASC LIMIT $limit",
      {
        $chatPk: chatPk,
        $limit: limit,
        $afterTimestamp: cursor.timestamp,
        $afterPk: cursor.pk
      }
    );
  }

  function compareMessages(left, right) {
    var timestamp = (Number(left.timestampRaw) || 0) - (Number(right.timestampRaw) || 0);
    if (timestamp) return timestamp;
    var source = String(left.provenance && left.provenance.source || "").localeCompare(String(right.provenance && right.provenance.source || ""));
    if (source) return source;
    return Number(left.pk || 0) - Number(right.pk || 0);
  }

  function mapMessage(row, source) {
    source = source || "line";
    var hasSender = row.senderPk !== null && row.senderPk !== undefined && row.senderPk !== "";
    var sender = hasSender
      ? (source === "square" ? state.squareUsers.get(sourcePkKey("square", numberOrNull(row.senderPk))) : state.users.get("pk:" + numberOrNull(row.senderPk)))
      : null;
    var text = stringOrEmpty(row.text);
    var call = extractCallInfo(row.contentType, row.contentMetadata, text, row.latitude, row.longitude);
    var kind = call ? "call" : messageKind(row.contentType, row.messageType, text);
    var messageId = stringOrEmpty(row.messageId);
    var sendStatus = numberOrNull(row.sendStatus);
    var isSystem = isSystemMessage(row.contentType, messageId, hasSender, sendStatus, call);
    var isSelf = Boolean(
      (sender && state.selfId && sender.id === state.selfId) ||
      (!hasSender && !isSystem && (sendStatus === 1 || stringOrEmpty(row.messageType).toUpperCase() === "S"))
    );
    var attachmentHints = extractAttachmentHints(row.contentMetadata, messageId);
    var linkPreviews = extractLinkPreviews(row.contentMetadata, text, row.contentType);
    return {
      pk: numberOrNull(row.messagePk),
      id: messageId,
      timestampRaw: row.timestamp,
      timestamp: normalizeTimestamp(row.timestamp),
      senderId: sender ? sender.id : "",
      sender: isSelf ? "我" : (isSystem ? "系統" : (sender ? sender.name : "未知使用者")),
      isSelf: isSelf,
      isSystem: isSystem,
      sendStatus: sendStatus,
      contentType: row.contentType,
      messageType: stringOrEmpty(row.messageType),
      kind: kind,
      call: call,
      text: text,
      latitude: numberOrNull(row.latitude),
      longitude: numberOrNull(row.longitude),
      thumbnail: toUint8Array(row.thumbnail),
      linkPreviews: linkPreviews,
      attachmentHints: attachmentHints,
      attachments: resolveAttachments(row.contentMetadata, messageId, attachmentHints),
      provenance: {
        sourceMode: state.sourceMode,
        source: source,
        sourceDatabase: sourceDatabaseLabel(source),
        sourceTable: "ZMESSAGE",
        sourcePk: numberOrNull(row.messagePk),
        sourceId: messageId,
        chatPk: numberOrNull(row.chatPk),
        messageKey: sourcePkKey(source, numberOrNull(row.messagePk)),
        confidence: "exact"
      }
    };
  }

  function isSystemMessage(contentType, messageId, hasSender, sendStatus, call) {
    var code = Number(contentType);
    if (call && call.isGroup) return true;
    if (code === 7 || code === 18 || code === 96 || code === 111) return true;
    return !hasSender && sendStatus === 0 && !messageId;
  }

  function renderMessages() {
    revokeObjectUrls();
    el.messageList.innerHTML = "";
    if (!state.currentMessages.length) {
      el.messageList.innerHTML = '<div class="empty-state">這個聊天室沒有可顯示的訊息。</div>';
      el.messageStatus.textContent = "";
      return;
    }
    var fragment = document.createDocumentFragment();
    state.currentMessages.forEach(function (message) {
      var row = document.createElement("article");
      row.className = "message-row" + (message.isSystem ? " system" : (message.isSelf ? " self" : ""));
      var card = document.createElement("div");
      card.className = "message-card";
      var meta = document.createElement("div");
      meta.className = "message-meta";
      var sender = document.createElement("span");
      sender.className = "message-sender";
      sender.textContent = message.sender;
      var date = document.createElement("time");
      date.dateTime = message.timestamp ? message.timestamp.toISOString() : "";
      date.textContent = formatDate(message.timestamp, true);
      meta.appendChild(sender);
      meta.appendChild(date);
      card.appendChild(meta);
      if (message.call) {
        var call = document.createElement("p");
        call.className = "message-call" + (isUnansweredCall(message.call) ? " unanswered" : "");
        call.textContent = "☎︎ " + formatCallLabel(message.call, message.isSelf);
        card.appendChild(call);
      } else if (message.text) {
        var body = document.createElement("p");
        body.className = "message-text";
        appendLinkedText(body, message.text);
        card.appendChild(body);
      } else {
        var kind = document.createElement("p");
        kind.className = "message-kind";
        kind.textContent = "[" + message.kind + "]";
        card.appendChild(kind);
      }
      if (hasValidLocation(message)) {
        var coordinates = document.createElement("p");
        coordinates.className = "message-coordinates";
        coordinates.textContent = "位置：" + message.latitude + ", " + message.longitude;
        card.appendChild(coordinates);
      }
      appendLinkPreviews(card, message.linkPreviews);
      appendImagePreviews(card, message);
      appendAttachmentLinks(card, message.attachments);
      row.appendChild(card);
      fragment.appendChild(row);
    });
    el.messageList.appendChild(fragment);
    el.messageStatus.textContent = "已顯示 " + formatNumber(state.currentMessages.length) + " / " + formatNumber(state.currentChat.messageCount) + " 則訊息";
  }

  function attachmentPathContext(path) {
    var match = String(path || "").match(/\/Message (?:Attachments|Thumbnails)\/([^/]+)\/([^/]+)$/);
    var filename = match ? match[2] : fileNameOf(path);
    var messageIdMatch = filename.match(/^(\d{8,})(?:[_.-]|$)/);
    return {
      chatId: match ? match[1] : "",
      messageId: messageIdMatch ? messageIdMatch[1] : "",
      filename: filename
    };
  }

  function loadCleanupMessageRows(messageIds) {
    return loadMessageRowsByIds(messageIds);
  }

  function cleanupContentLabel(contentType) {
    return {
      1: "照片", 2: "影片", 3: "語音", 4: "檔案", 14: "檔案",
      16: "照片", 17: "影片", 100: "位置", 112: "照片"
    }[Number(contentType)] || "附件";
  }

  function cleanupMessageContext(row) {
    if (!row) return null;
    var sender = sourceSender(row.source || "line", row.senderPk);
    var isSelf = Boolean(
      (sender && state.selfId && sender.id === state.selfId) ||
      (!sender && numberOrNull(row.sendStatus) === 1)
    );
    var text = stringOrEmpty(row.text).replace(/\s+/g, " ").trim();
    if (text.length > 150) text = text.slice(0, 147) + "…";
    return {
      id: stringOrEmpty(row.messageId),
      pk: numberOrNull(row.messagePk),
      chatPk: numberOrNull(row.chatPk),
      timestamp: normalizeTimestamp(row.timestamp),
      sender: isSelf ? "我" : (sender ? sender.name : "未知傳送者"),
      contentType: numberOrNull(row.contentType),
      contentLabel: cleanupContentLabel(row.contentType),
      summary: text || "沒有文字內容（" + cleanupContentLabel(row.contentType) + "）",
      source: row.source || "line",
      sourceDatabase: sourceDatabaseLabel(row.source || "line")
    };
  }

  function fallbackCleanupChat(chatId) {
    var idKey = lookupId(chatId);
    var user = state.users.get(idKey);
    var squareGroup = state.squareGroupsById.get(idKey);
    var unifiedGroup = state.unifiedGroupsById.get(idKey);
    var group = state.groupsById.get(idKey);
    if (user) return { id: chatId, title: user.name, type: "direct", pk: null };
    if (squareGroup) return { id: chatId, title: squareGroup.name, type: "community", pk: squareGroup.chatPk };
    if (unifiedGroup) return { id: chatId, title: unifiedGroup.name, type: unifiedGroup.type === null ? "group" : chatTypeLabel(unifiedGroup.type), pk: null };
    if (group) return { id: chatId, title: group.name, type: "group", pk: group.pk };
    return { id: chatId, title: "無法辨識的聊天室", type: "unknown", pk: null };
  }

  function specialCleanupChat(status) {
    if (status === "unreferenced") {
      return { id: "", title: "孤兒檔案（SQLite 未引用）", type: "unreferenced", pk: null };
    }
    return { id: "", title: "無法確認引用的附件", type: "unknown", pk: null };
  }

  function cleanupGroupKey(chat, chatId, referenceStatus) {
    if (chat && chat.key) return chat.key + "|" + referenceStatus;
    if (referenceStatus === "unreferenced") return "__unreferenced__";
    if (referenceStatus === "unconfirmed") return "__unconfirmed__";
    return lookupId(chatId) || "unknown";
  }

  function buildAttachmentReviewIndex() {
    state.attachmentReviewItems = [];
    state.attachmentReviewByPath = new Map();
    state.attachmentCleanupGroups = [];
    if (!state.attachmentFiles.length) return;

    var chatsById = new Map();
    state.chats.forEach(function (chat) {
      chatsById.set(lookupId(chat.id), chat);
    });

    var messageIds = new Set();
    var pendingFiles = state.attachmentFiles.map(function (file) {
      var path = relativePath(file);
      var context = attachmentPathContext(path);
      if (context.messageId) messageIds.add(context.messageId);
      return { file: file, path: path, context: context };
    });

    var messageByChatAndId = new Map();
    var messageById = new Map();
    var messageRowsResult = loadCleanupMessageRows(messageIds);
    messageRowsResult.rows.forEach(function (row) {
      var chat = state.chatsBySourcePk.get(sourcePkKey(row.source || "line", Number(row.chatPk)));
      var id = stringOrEmpty(row.messageId);
      if (chat) {
        var messageKey = chat.key + "|" + (row.source || "line") + "|" + id;
        if (!messageByChatAndId.has(messageKey)) messageByChatAndId.set(messageKey, []);
        messageByChatAndId.get(messageKey).push(row);
      }
      if (!messageById.has(id)) messageById.set(id, []);
      messageById.get(id).push(row);
    });

    var reviewByKey = new Map();
    pendingFiles.forEach(function (pending, index) {
      var chatId = pending.context.chatId;
      var messageId = pending.context.messageId;
      var chatKey = lookupId(chatId);
      var resolvedChat = chatsById.get(chatKey) || fallbackCleanupChat(chatId);
      var exactMessages = resolvedChat && resolvedChat.sourceChats
        ? ["line", "square"].reduce(function (matches, source) {
          return matches.concat(messageByChatAndId.get(resolvedChat.key + "|" + source + "|" + messageId) || []);
        }, [])
        : [];
      var exactMessage = exactMessages.length === 1 ? exactMessages[0] : null;
      var idMatches = messageById.get(messageId) || [];
      var referenceStatus = !messageRowsResult.success || !messageId || !chatId
        ? "unconfirmed"
        : (exactMessage ? "referenced" : ((exactMessages.length > 1 || idMatches.length) ? "unconfirmed" : "unreferenced"));
      var chat = resolvedChat && resolvedChat.type !== "unknown" ? resolvedChat : specialCleanupChat(referenceStatus);
      var groupKey = cleanupGroupKey(chat, chatId, referenceStatus);
      var bundleKey = groupKey + "|" + (messageId || pending.context.filename || index);
      if (!reviewByKey.has(bundleKey)) {
        reviewByKey.set(bundleKey, {
          key: bundleKey,
          groupKey: groupKey,
          chat: chat,
          messageId: messageId,
          message: referenceStatus === "referenced" ? cleanupMessageContext(exactMessage) : null,
          referenceStatus: referenceStatus,
          files: [],
          previewFile: null,
          previewFallbackFile: null,
          searchText: ""
        });
      }
      var review = reviewByKey.get(bundleKey);
      var archivePath = archiveRelativePath(pending.file);
      var descriptor = {
        file: pending.file,
        path: pending.path,
        archivePath: archivePath,
        category: attachmentCategory(archivePath),
        kind: /\/Message Thumbnails\//.test(archivePath) ? "thumbnail" : "original",
        referenceStatus: review.referenceStatus
      };
      review.files.push(descriptor);
    });

    state.attachmentReviewItems = Array.from(reviewByKey.values()).map(function (review) {
      review.files.sort(function (left, right) {
        if (left.kind !== right.kind) return left.kind === "original" ? -1 : 1;
        return right.file.size - left.file.size;
      });
      var originalPreview = review.files.find(function (descriptor) {
        return descriptor.kind === "original" && isCleanupPreviewImage(descriptor.file, descriptor.archivePath);
      });
      var thumbnailPreview = review.files.find(function (descriptor) { return descriptor.kind === "thumbnail"; });
      review.previewFile = originalPreview || thumbnailPreview ||
        review.files.find(function (descriptor) { return isCleanupPreviewImage(descriptor.file, descriptor.archivePath); }) || null;
      review.previewFallbackFile = originalPreview && thumbnailPreview ? thumbnailPreview : null;
      review.totalBytes = review.files.reduce(function (sum, descriptor) { return sum + (Number(descriptor.file.size) || 0); }, 0);
      var fallbackTime = review.files.reduce(function (latest, descriptor) {
        return Math.max(latest, Number(descriptor.file.lastModified) || 0);
      }, 0);
      review.fallbackTimestamp = fallbackTime ? new Date(fallbackTime) : null;
      review.searchText = [
        review.chat.title, review.chat.id, typeLabel(review.chat.type), review.messageId,
        review.message && review.message.sender, review.message && review.message.summary,
        review.message && review.message.timestamp ? review.message.timestamp.toISOString() : "",
        review.fallbackTimestamp ? review.fallbackTimestamp.toISOString() : ""
      ].concat(review.files.map(function (descriptor) {
        return descriptor.archivePath + " " + descriptor.file.name + " " + descriptor.category;
      })).join(" ").toLowerCase();
      review.files.forEach(function (descriptor) {
        state.attachmentReviewByPath.set(descriptor.path, { review: review, descriptor: descriptor });
      });
      return review;
    }).sort(function (left, right) {
      var leftUnknown = left.chat.type === "unknown" ? 1 : 0;
      var rightUnknown = right.chat.type === "unknown" ? 1 : 0;
      if (leftUnknown !== rightUnknown) return leftUnknown - rightUnknown;
      var chatCompare = left.chat.title.localeCompare(right.chat.title, "zh-Hant");
      if (chatCompare) return chatCompare;
      var leftTime = left.message && left.message.timestamp ? left.message.timestamp.getTime() : 0;
      var rightTime = right.message && right.message.timestamp ? right.message.timestamp.getTime() : 0;
      return rightTime - leftTime;
    });
    buildAttachmentCleanupGroups();
  }

  function buildAttachmentCleanupGroups() {
    var groupsByKey = new Map();
    state.attachmentReviewItems.forEach(function (review) {
      if (!groupsByKey.has(review.groupKey)) {
        groupsByKey.set(review.groupKey, {
          key: review.groupKey,
          chat: review.chat,
          referenceStatus: review.referenceStatus,
          reviews: [],
          totalBytes: 0,
          fileCount: 0,
          searchText: ""
        });
      }
      var group = groupsByKey.get(review.groupKey);
      group.reviews.push(review);
      group.totalBytes += review.totalBytes;
      group.fileCount += review.files.length;
    });
    state.attachmentCleanupGroups = Array.from(groupsByKey.values()).map(function (group) {
      group.searchText = [group.chat.title, group.chat.id, typeLabel(group.chat.type)]
        .concat(group.reviews.map(function (review) { return review.searchText; }))
        .join(" ").toLowerCase();
      return group;
    }).sort(function (left, right) {
      var priority = { unreferenced: 0, unconfirmed: 1 };
      var leftPriority = priority[left.referenceStatus] === undefined ? 2 : priority[left.referenceStatus];
      var rightPriority = priority[right.referenceStatus] === undefined ? 2 : priority[right.referenceStatus];
      if (leftPriority !== rightPriority) return leftPriority - rightPriority;
      if (left.totalBytes !== right.totalBytes) return right.totalBytes - left.totalBytes;
      return left.chat.title.localeCompare(right.chat.title, "zh-Hant");
    });
  }

  function getFilteredAttachmentReviewRows() {
    var search = state.attachmentCleanupSearch;
    var filter = state.attachmentKindFilter;
    return state.attachmentReviewItems.map(function (review) {
      if (state.selectedAttachmentCleanupGroup && review.groupKey !== state.selectedAttachmentCleanupGroup) return null;
      if (state.attachmentCategoryFilter !== "all" && cleanupCategoryKey(review) !== state.attachmentCategoryFilter) return null;
      if (search && review.searchText.indexOf(search) === -1) return null;
      var visibleFiles = review.files.filter(function (descriptor) {
        if (filter === "original") return descriptor.kind === "original";
        if (filter === "thumbnail") return descriptor.kind === "thumbnail";
        if (filter === "marked") return state.attachmentsMarkedForRemoval.has(descriptor.path);
        return true;
      });
      return visibleFiles.length ? { review: review, files: visibleFiles } : null;
    }).filter(Boolean).sort(compareCleanupReviewRows);
  }

  function getFilteredAttachmentCleanupGroups() {
    var search = state.attachmentCleanupSearch;
    var filter = state.attachmentKindFilter;
    return state.attachmentCleanupGroups.filter(function (group) {
      if (state.attachmentCategoryFilter !== "all" && cleanupCategoryKey(group) !== state.attachmentCategoryFilter) return false;
      if (search && group.searchText.indexOf(search) === -1) return false;
      return group.reviews.some(function (review) {
        return review.files.some(function (descriptor) {
          if (filter === "original") return descriptor.kind === "original";
          if (filter === "thumbnail") return descriptor.kind === "thumbnail";
          if (filter === "marked") return state.attachmentsMarkedForRemoval.has(descriptor.path);
          return true;
        });
      });
    }).sort(compareCleanupGroups);
  }

  function cleanupTimestamp(review) {
    var timestamp = review.message && review.message.timestamp ? review.message.timestamp : review.fallbackTimestamp;
    return timestamp ? timestamp.getTime() : -Infinity;
  }

  function compareCleanupReviewRows(left, right) {
    if (state.attachmentSort === "size") {
      var sizeDifference = right.files.reduce(function (sum, descriptor) { return sum + descriptor.file.size; }, 0) -
        left.files.reduce(function (sum, descriptor) { return sum + descriptor.file.size; }, 0);
      if (sizeDifference) return sizeDifference;
    } else if (state.attachmentSort === "path") {
      return left.files[0].archivePath.localeCompare(right.files[0].archivePath);
    } else {
      var timeDifference = cleanupTimestamp(right.review) - cleanupTimestamp(left.review);
      if (timeDifference) return state.attachmentSort === "oldest" ? -timeDifference : timeDifference;
    }
    return left.files[0].archivePath.localeCompare(right.files[0].archivePath);
  }

  function compareCleanupGroups(left, right) {
    if (state.attachmentSort === "size") {
      if (left.totalBytes !== right.totalBytes) return right.totalBytes - left.totalBytes;
    } else if (state.attachmentSort === "path") {
      return left.chat.title.localeCompare(right.chat.title, "zh-Hant");
    } else {
      var leftTime = left.reviews.reduce(function (latest, review) { return Math.max(latest, cleanupTimestamp(review)); }, -Infinity);
      var rightTime = right.reviews.reduce(function (latest, review) { return Math.max(latest, cleanupTimestamp(review)); }, -Infinity);
      if (leftTime !== rightTime) return state.attachmentSort === "oldest" ? leftTime - rightTime : rightTime - leftTime;
    }
    return left.chat.title.localeCompare(right.chat.title, "zh-Hant");
  }

  function getAttachmentCleanupTotalPages() {
    var items = state.selectedAttachmentCleanupGroup
      ? getFilteredAttachmentReviewRows()
      : getFilteredAttachmentCleanupGroups();
    return Math.max(1, Math.ceil(items.length / ATTACHMENT_CLEANUP_PAGE_SIZE));
  }

  function archiveRelativePath(file) {
    var path = relativePath(file);
    var root = state.sourceMode === "folder" ? state.sourceRoot : "";
    if (root && path.indexOf(root + "/") === 0) return path.slice(root.length + 1);
    return path;
  }

  function attachmentCategory(path) {
    return /\/Message Thumbnails\//.test(path) ? "縮圖" : "原始附件";
  }

  function isCleanupPreviewImage(file, path) {
    return /\/Message Thumbnails\//.test(path) || /^image\//i.test(file.type || "") || /\.(?:jpe?g|png|gif|webp|bmp|avif)$/i.test(file.name || "");
  }

  function cleanupFileLabel(descriptor, review) {
    var filename = descriptor.file.name;
    var meaningful = filename.replace(new RegExp("^" + (review.messageId || "") + "[_-]?"), "");
    if (!meaningful || /^\.[a-z0-9]{1,8}$/i.test(meaningful) || /^thumb$/i.test(meaningful)) {
      var content = review.message ? review.message.contentLabel : "附件";
      return content + (descriptor.kind === "thumbnail" ? "縮圖" : "原檔");
    }
    return meaningful;
  }

  function cleanupFileTypeLabel(descriptor) {
    var extension = (descriptor.file.name.match(/\.([a-z0-9]{1,8})$/i) || [])[1];
    if (descriptor.kind === "thumbnail") return "圖片預覽";
    return extension ? extension.toUpperCase() + " 檔案" : (descriptor.file.type || "未知格式");
  }

  function cleanupFileImpact(descriptor) {
    return descriptor.kind === "thumbnail"
      ? "刪除後：聊天中的預覽圖可能消失，原檔仍可保留"
      : "刪除後：聊天中的這份媒體或檔案將無法開啟";
  }

  function cleanupChatIcon(type) {
    return { direct: "人", group: "群", community: "社", unreferenced: "鬼", unknown: "?" }[type] || "聊";
  }

  function cleanupFileIcon(descriptor) {
    if (descriptor.kind === "thumbnail" || /^image\//i.test(descriptor.file.type || "") || /\.(?:jpe?g|png|gif|webp|heic)$/i.test(descriptor.file.name)) return "IMG";
    var extension = (descriptor.file.name.match(/\.([a-z0-9]{1,5})$/i) || [])[1];
    return extension ? extension.toUpperCase() : "FILE";
  }

  function createCleanupPreviewUrl(file) {
    var url = URL.createObjectURL(file);
    state.cleanupPreviewUrls.add(url);
    return url;
  }

  function revokeCleanupPreviewUrls() {
    state.cleanupPreviewUrls.forEach(function (url) { URL.revokeObjectURL(url); });
    state.cleanupPreviewUrls.clear();
  }

  function setCleanupPackageStatus(text, isError) {
    if (!el.cleanupPackageStatus) return;
    el.cleanupPackageStatus.textContent = text;
    el.cleanupPackageStatus.classList.toggle("error", Boolean(isError));
  }

  function showPackageModal(message) {
    if (!el.packageModal) return;
    el.packageModal.classList.remove("hidden", "is-success", "is-error");
    el.packageModal.classList.add("is-processing");
    el.packageModal.setAttribute("aria-hidden", "false");
    el.packageModalTitle.textContent = "正在建立 .imazingapp";
    el.packageModalMessage.textContent = message;
    el.packageModalProgress.style.width = "0%";
    el.packageModalProgress.setAttribute("aria-valuenow", "0");
    el.packageModalProgressLabel.textContent = "0%";
    el.packageModalClose.classList.add("hidden");
    document.body.classList.add("package-modal-open");
    if (el.appShell) {
      el.appShell.inert = true;
      el.appShell.setAttribute("aria-busy", "true");
    }
    if (el.diffPanel) el.diffPanel.inert = true;
    window.requestAnimationFrame(function () {
      if (el.packageModalCard) el.packageModalCard.focus();
    });
  }

  function updatePackageModalProgress(percent, message) {
    if (!el.packageModal || el.packageModal.classList.contains("hidden")) return;
    var progress = Math.max(0, Math.min(100, Math.round(percent)));
    el.packageModalProgress.style.width = progress + "%";
    el.packageModalProgress.setAttribute("aria-valuenow", String(progress));
    el.packageModalProgressLabel.textContent = progress + "%";
    if (message) el.packageModalMessage.textContent = message;
  }

  function completePackageModal(isError, title, message) {
    if (!el.packageModal) return;
    el.packageModal.classList.remove("is-processing", "is-success", "is-error");
    el.packageModal.classList.add(isError ? "is-error" : "is-success");
    el.packageModalTitle.textContent = title;
    el.packageModalMessage.textContent = message;
    if (!isError) updatePackageModalProgress(100);
    el.packageModalClose.textContent = isError ? "關閉" : "完成";
    el.packageModalClose.classList.remove("hidden");
    el.packageModalClose.focus();
  }

  function closePackageModal() {
    if (packageInProgress || !el.packageModal) return;
    el.packageModal.classList.add("hidden");
    el.packageModal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("package-modal-open");
    if (el.appShell) {
      el.appShell.inert = false;
      el.appShell.removeAttribute("aria-busy");
    }
    if (el.diffPanel) el.diffPanel.inert = false;
  }

  function showImageModal(url, alt, caption, trigger) {
    if (!el.imageModal || !el.imageModalImage) return;
    imageModalTrigger = trigger || null;
    el.imageModalImage.src = url;
    el.imageModalImage.alt = alt || "LINE 圖片";
    el.imageModalCaption.textContent = caption || alt || "LINE 圖片";
    el.imageModal.classList.remove("hidden");
    el.imageModal.setAttribute("aria-hidden", "false");
    document.body.classList.add("image-modal-open");
    if (el.appShell) el.appShell.inert = true;
    if (el.diffPanel) el.diffPanel.inert = true;
    window.requestAnimationFrame(function () {
      if (el.imageModalCard) el.imageModalCard.focus();
    });
  }

  function closeImageModal() {
    if (!el.imageModal || el.imageModal.classList.contains("hidden")) return;
    el.imageModal.classList.add("hidden");
    el.imageModal.setAttribute("aria-hidden", "true");
    el.imageModalImage.removeAttribute("src");
    document.body.classList.remove("image-modal-open");
    if (el.appShell) el.appShell.inert = false;
    if (el.diffPanel) el.diffPanel.inert = false;
    if (imageModalTrigger) imageModalTrigger.focus();
    imageModalTrigger = null;
  }

  function cleanupCategoryKey(item) {
    if (item.referenceStatus === "unreferenced" || item.referenceStatus === "unconfirmed") return item.referenceStatus;
    return item.chat.type === "direct" ? "individual" : item.chat.type;
  }

  function renderAttachmentCategorySummary() {
    if (!el.attachmentCategorySummary) return;
    var categories = [
      { key: "all", label: "全部檔案" },
      { key: "individual", label: "個人聊天室" },
      { key: "group", label: "群組聊天室" },
      { key: "community", label: "社群" },
      { key: "unreferenced", label: "SQLite 未引用" },
      { key: "unconfirmed", label: "無法確認" }
    ];
    var totals = new Map(categories.map(function (category) {
      return [category.key, { count: 0, bytes: 0 }];
    }));
    state.attachmentReviewItems.forEach(function (review) {
      var category = cleanupCategoryKey(review);
      var total = totals.get(category) || totals.get("unconfirmed");
      total.count += review.files.length;
      total.bytes += review.totalBytes;
      totals.get("all").count += review.files.length;
      totals.get("all").bytes += review.totalBytes;
    });
    el.attachmentCategorySummary.innerHTML = categories.map(function (category) {
      var total = totals.get(category.key);
      var active = state.attachmentCategoryFilter === category.key ? " active" : "";
      return '<button type="button" class="attachment-category-card' + active + '" data-attachment-category="' + category.key + '" aria-pressed="' + (active ? "true" : "false") + '"><strong>' + escapeHtml(category.label) + '</strong><span>' + formatNumber(total.count) + ' 個 · ' + formatBytes(total.bytes) + '</span></button>';
    }).join("");
  }

  function cleanupReferenceStatusLabel(status) {
    return {
      referenced: "聊天室附件",
      unreferenced: "SQLite 未引用",
      unconfirmed: "無法確認"
    }[status] || "附件";
  }

  function cleanupReferenceSummary(status) {
    if (status === "unreferenced") return "附件未被路徑所屬聊天室的 SQLite 訊息引用，請人工確認後再刪除。";
    if (status === "unconfirmed") return "路徑或訊息 ID 無法可靠比對，未列為孤兒檔案。";
    return "";
  }

  function isCleanupGroupFullyMarked(group) {
    return group.reviews.every(function (review) {
      return review.files.every(function (descriptor) {
        return state.attachmentsMarkedForRemoval.has(descriptor.path);
      });
    });
  }

  function cleanupReviewHasThumbnailBackedImage(review) {
    if (review.referenceStatus !== "referenced" ||
        !review.message ||
        !review.messageId ||
        !isImageContentType(review.message.contentType)) {
      return false;
    }
    var hasOriginal = review.files.some(function (descriptor) {
      return descriptor.kind === "original";
    });
    var hasNonemptyThumbnail = review.files.some(function (descriptor) {
      return descriptor.kind === "thumbnail" && Number(descriptor.file.size) > 0;
    });
    return hasOriginal && hasNonemptyThumbnail;
  }

  function cleanupGroupHasThumbnailBackedImage(group) {
    return group.reviews.some(cleanupReviewHasThumbnailBackedImage);
  }

  function isCleanupGroupKeepingThumbnails(group) {
    if (!cleanupGroupHasThumbnailBackedImage(group)) return false;
    return group.reviews.every(function (review) {
      if (!cleanupReviewHasThumbnailBackedImage(review)) return true;
      return review.files.every(function (descriptor) {
        return descriptor.kind === "original"
          ? state.attachmentsMarkedForRemoval.has(descriptor.path)
          : !state.attachmentsMarkedForRemoval.has(descriptor.path);
      });
    });
  }

  function renderAttachmentCleanupGroups(groups) {
    return '<div class="cleanup-group-list">' + groups.map(function (group) {
      var markedCount = group.reviews.reduce(function (count, review) {
        return count + review.files.filter(function (descriptor) {
          return state.attachmentsMarkedForRemoval.has(descriptor.path);
        }).length;
      }, 0);
      var specialClass = group.referenceStatus === "referenced" ? "" : " special " + group.referenceStatus;
      var encodedGroupKey = escapeHtml(encodeURIComponent(group.key));
      var fullyMarked = isCleanupGroupFullyMarked(group);
      var actionLabel = fullyMarked ? "取消刪除全部" : "刪除全部";
      var actionState = fullyMarked ? " is-cancel" : " is-delete";
      var keepingThumbnails = isCleanupGroupKeepingThumbnails(group);
      var keepThumbnailAction = cleanupGroupHasThumbnailBackedImage(group)
        ? '<button class="cleanup-group-open cleanup-group-action-button' + (keepingThumbnails ? " is-cancel" : " is-delete") + '" type="button" data-cleanup-group-action="keep-thumbnail" data-cleanup-group="' + encodedGroupKey + '" title="' + (keepingThumbnails ? "還原具有對應縮圖的圖片原檔" : "只標記已有非空縮圖的圖片原檔；PDF、影片與無縮圖附件會保留") + '">' + (keepingThumbnails ? "還原原始圖片" : "只保留縮圖") + '</button>'
        : "";
      return '<article class="cleanup-group-card' + specialClass + '"><div class="cleanup-group-row"><button class="cleanup-group-open-button" type="button" data-cleanup-open-group="' + encodedGroupKey + '"><span class="cleanup-chat-avatar" aria-hidden="true">' + escapeHtml(cleanupChatIcon(group.chat.type)) + '</span><span class="cleanup-group-main"><span class="cleanup-group-heading"><strong>' + escapeHtml(group.chat.title) + '</strong><span class="cleanup-chat-type">' + escapeHtml(cleanupReferenceStatusLabel(group.referenceStatus)) + '</span></span><small>' + escapeHtml(group.referenceStatus === "referenced" ? typeLabel(group.chat.type) : cleanupReferenceSummary(group.referenceStatus)) + '</small><span>' + formatNumber(group.fileCount) + ' 個檔案 · ' + escapeHtml(formatBytes(group.totalBytes)) + (markedCount ? ' · <b>已標記 ' + formatNumber(markedCount) + ' 個</b>' : '') + '</span></span></button><div class="cleanup-group-actions"><button class="cleanup-group-open cleanup-group-action-button' + actionState + '" type="button" data-cleanup-group-action="remove" data-cleanup-group="' + encodedGroupKey + '">' + actionLabel + '</button>' + keepThumbnailAction + '<button class="cleanup-group-open cleanup-group-view-button" type="button" data-cleanup-open-group="' + encodedGroupKey + '">查看</button></div></div></article>';
    }).join("") + '</div>';
  }

  function renderCleanupReferenceContext(review) {
    if (review.message) {
      return '<div class="cleanup-message-meta"><span>' + escapeHtml(review.message.sender) + '</span><time>' + escapeHtml(formatDate(review.message.timestamp, true)) + '</time></div><p class="cleanup-message-summary">' + escapeHtml(review.message.summary) + '</p>';
    }
    var heading = review.referenceStatus === "unreferenced"
      ? "SQLite 未引用這個附件"
      : "無法確認對應訊息";
    var detail = review.referenceStatus === "unreferenced"
      ? (review.messageId ? "路徑所屬聊天室未找到訊息 ID " + review.messageId : "路徑所屬聊天室沒有可對應的訊息 ID")
      : (review.fallbackTimestamp ? "檔案修改於 " + formatDate(review.fallbackTimestamp, true) : (review.messageId ? "訊息 ID " + review.messageId : "無法取得訊息 ID"));
    var summary = review.referenceStatus === "unreferenced"
      ? "此檔案暫未被目前資料庫引用，仍請檢視預覽與檔名後再決定是否刪除。"
      : "仍可依預覽與檔名判斷，但資料庫關聯不足，請保守處理。";
    return '<div class="cleanup-message-meta uncertain"><span>' + escapeHtml(heading) + '</span><span>' + escapeHtml(detail) + '</span></div><p class="cleanup-message-summary">' + escapeHtml(summary) + '</p>';
  }

  function renderCleanupEvidence(review) {
    var messagePk = review.message && review.message.pk !== null ? review.message.pk : "無";
    var sourceDatabase = review.message && review.message.sourceDatabase ? review.message.sourceDatabase : "未確認";
    var chatPk = review.message && review.message.chatPk !== null
      ? review.message.chatPk
      : (review.chat && review.chat.pk !== null ? review.chat.pk : "無");
    return '<details class="cleanup-evidence"><summary>查看 SQLite 證據</summary><small>messageId=' +
      escapeHtml(review.messageId || "無") + "；messagePk=" + escapeHtml(String(messagePk)) +
      "；chatPk=" + escapeHtml(String(chatPk)) + "；source=" + escapeHtml(sourceDatabase) + "；referenceStatus=" +
      escapeHtml(review.referenceStatus) + "；confidence=" +
      escapeHtml(review.referenceStatus === "referenced" ? "exact" : "unconfirmed") + "</small></details>";
  }

  function renderAttachmentCleanupDetails(rows) {
    var selectedGroup = state.attachmentCleanupGroups.find(function (group) {
      return group.key === state.selectedAttachmentCleanupGroup;
    });
    if (!selectedGroup) return '<div class="empty-state">找不到此附件分類，請返回聊天室列表後再試。</div>';
    var previewUrls = new Map();
    var cleanupChoiceCounter = 0;
    var visibleDescriptors = rows.reduce(function (all, row) { return all.concat(row.files); }, []);
    var markedInGroup = visibleDescriptors.filter(function (descriptor) {
      return state.attachmentsMarkedForRemoval.has(descriptor.path);
    }).length;
    var cards = rows.map(function (row) {
      var review = row.review;
      var previewHtml = '<span class="cleanup-preview-fallback">' + escapeHtml(cleanupFileIcon(row.files[0])) + '</span>';
      if (review.previewFile) {
        var previewPath = review.previewFile.path;
        if (!previewUrls.has(previewPath)) previewUrls.set(previewPath, createCleanupPreviewUrl(review.previewFile.file));
        var fallbackAttribute = "";
        if (review.previewFallbackFile && review.previewFallbackFile.path !== previewPath) {
          var fallbackPath = review.previewFallbackFile.path;
          if (!previewUrls.has(fallbackPath)) previewUrls.set(fallbackPath, createCleanupPreviewUrl(review.previewFallbackFile.file));
          fallbackAttribute = ' data-preview-fallback-url="' + escapeHtml(previewUrls.get(fallbackPath)) + '"';
        }
        previewHtml = '<img src="' + escapeHtml(previewUrls.get(previewPath)) + '" alt="附件預覽" loading="lazy" decoding="async"' + fallbackAttribute + '><span class="cleanup-preview-fallback">' + escapeHtml(cleanupFileIcon(review.previewFile)) + '</span>';
      }
      var fileChoices = row.files.map(function (descriptor) {
        var checked = state.attachmentsMarkedForRemoval.has(descriptor.path) ? " checked" : "";
        cleanupChoiceCounter += 1;
        var choiceId = "cleanup-file-choice-" + state.attachmentCleanupPage + "-" + cleanupChoiceCounter;
        return '<div class="cleanup-file-choice"><input id="' + choiceId + '" type="checkbox" data-attachment-path="' + escapeHtml(descriptor.path) + '"' + checked + '><div class="cleanup-file-choice-main"><span class="cleanup-file-title"><strong>' + escapeHtml(cleanupFileLabel(descriptor, review)) + '</strong><span class="cleanup-kind-badge ' + escapeHtml(descriptor.kind) + '">' + escapeHtml(descriptor.category) + '</span></span><small>' + escapeHtml(cleanupFileTypeLabel(descriptor) + " · " + formatBytes(descriptor.file.size)) + '</small><span class="cleanup-impact">' + escapeHtml(cleanupFileImpact(descriptor)) + '</span><details class="cleanup-path"><summary>查看實際檔名與路徑</summary><code>' + escapeHtml(descriptor.archivePath) + '</code></details></div><label class="cleanup-delete-label" for="' + choiceId + '">刪除此檔</label></div>';
      }).join("");
      return '<article class="cleanup-review-card"><div class="cleanup-preview">' + previewHtml + '</div><div class="cleanup-review-context">' + renderCleanupReferenceContext(review) + renderCleanupEvidence(review) + '<div class="cleanup-file-choices">' + fileChoices + '</div></div></article>';
    }).join("");
    return '<section class="cleanup-chat-group"><header class="cleanup-chat-header"><button class="button button-secondary cleanup-back-button" type="button" data-cleanup-back>返回聊天室列表</button><span class="cleanup-chat-avatar" aria-hidden="true">' + escapeHtml(cleanupChatIcon(selectedGroup.chat.type)) + '</span><div class="cleanup-chat-title"><div><h3>' + escapeHtml(selectedGroup.chat.title) + '</h3><span class="cleanup-chat-type">' + escapeHtml(cleanupReferenceStatusLabel(selectedGroup.referenceStatus)) + '</span></div><p>' + escapeHtml(selectedGroup.referenceStatus === "referenced" ? typeLabel(selectedGroup.chat.type) : cleanupReferenceSummary(selectedGroup.referenceStatus)) + ' · 本頁 ' + formatNumber(visibleDescriptors.length) + ' 個檔案 · ' + escapeHtml(formatBytes(visibleDescriptors.reduce(function (sum, descriptor) { return sum + (Number(descriptor.file.size) || 0); }, 0))) + (markedInGroup ? ' · <strong>已標記 ' + formatNumber(markedInGroup) + ' 個</strong>' : '') + '</p></div></header><div class="cleanup-review-grid">' + cards + '</div></section>';
  }

  function renderAttachmentCleanup() {
    var databaseOnly = state.sourceMode === "database";
    var indexOnly = state.sourceMode === "index";
    var hasFiles = !databaseOnly && state.attachmentFiles.length > 0;
    var detailMode = Boolean(state.selectedAttachmentCleanupGroup);
    var filteredRows = getFilteredAttachmentReviewRows();
    var filteredGroups = getFilteredAttachmentCleanupGroups();
    var filteredFiles = filteredRows.reduce(function (files, row) { return files.concat(row.files); }, []);
    var totalPages = getAttachmentCleanupTotalPages();
    state.attachmentCleanupPage = Math.min(state.attachmentCleanupPage, totalPages);
    var start = (state.attachmentCleanupPage - 1) * ATTACHMENT_CLEANUP_PAGE_SIZE;
    var pageItems = (detailMode ? filteredRows : filteredGroups).slice(start, start + ATTACHMENT_CLEANUP_PAGE_SIZE);
    revokeCleanupPreviewUrls();

    renderAttachmentCategorySummary();
    if (databaseOnly) {
      el.attachmentCleanupList.innerHTML = '<div class="empty-state">只讀訊息模式沒有載入附件檔案；請切換為完整 LINE 備份後使用附件瘦身。</div>';
    } else if (indexOnly) {
      el.attachmentCleanupList.innerHTML = '<div class="empty-state">大型索引不複製附件檔案；請載入完整 LINE 備份資料夾後使用附件瘦身。</div>';
    } else if (!hasFiles) {
      el.attachmentCleanupList.innerHTML = '<div class="empty-state">沒有可供瘦身的附件或縮圖。</div>';
    } else if (!pageItems.length) {
      el.attachmentCleanupList.innerHTML = '<div class="empty-state">找不到符合條件的' + (detailMode ? "附件" : "聊天室") + '。可以清除搜尋文字或切換「顯示」篩選。</div>';
    } else if (detailMode) {
      el.attachmentCleanupList.innerHTML = renderAttachmentCleanupDetails(pageItems);
      Array.from(el.attachmentCleanupList.querySelectorAll(".cleanup-preview img")).forEach(function (image) {
        image.addEventListener("error", function () {
          var fallbackUrl = image.getAttribute("data-preview-fallback-url");
          if (fallbackUrl) {
            image.removeAttribute("data-preview-fallback-url");
            image.setAttribute("data-preview-fallback-used", "true");
            image.src = fallbackUrl;
            image.alt = "附件縮圖預覽";
            return;
          }
          image.closest(".cleanup-preview").classList.add("preview-error");
        });
      });
    } else {
      el.attachmentCleanupList.innerHTML = renderAttachmentCleanupGroups(pageItems);
    }

    updateCleanupSummary();
    if (el.cleanupResultInfo) {
      el.cleanupResultInfo.textContent = detailMode
        ? (filteredRows.length ? "正在檢視「" + (state.attachmentCleanupGroups.find(function (group) { return group.key === state.selectedAttachmentCleanupGroup; }) || { chat: { title: "附件" } }).chat.title + "」的 " + formatNumber(filteredRows.length) + " 組附件脈絡，共 " + formatNumber(filteredFiles.length) + " 個檔案。" : "")
        : (filteredGroups.length ? "找到 " + formatNumber(filteredGroups.length) + " 個聊天室或特殊分類；點入後才會顯示附件內容。" : "");
    }
    var itemCount = detailMode ? filteredRows.length : filteredGroups.length;
    el.attachmentPageInfo.textContent = hasFiles && itemCount ? "第 " + state.attachmentCleanupPage + " / " + totalPages + " 頁 · " + formatNumber(itemCount) + (detailMode ? " 組附件" : " 個分類") : "第 1 頁";
    el.attachmentPrevButton.disabled = !hasFiles || state.attachmentCleanupPage <= 1;
    el.attachmentNextButton.disabled = !hasFiles || state.attachmentCleanupPage >= totalPages;
    el.exportCleanupPlanButton.disabled = !hasFiles;
    el.exportCleanupTextButton.disabled = !hasFiles;
    el.buildImazingCandidateButton.disabled = !hasFiles || packageInProgress;
  }

  function updateCleanupSummary() {
    var markedFiles = getMarkedAttachmentFiles();
    var markedSize = markedFiles.reduce(function (sum, file) { return sum + (Number(file.size) || 0); }, 0);
    el.markedAttachmentCount.textContent = formatNumber(markedFiles.length);
    el.markedAttachmentSize.textContent = formatBytes(markedSize);
  }

  function getMarkedAttachmentFiles() {
    return state.attachmentFiles.filter(function (file) {
      return state.attachmentsMarkedForRemoval.has(relativePath(file));
    });
  }

  function buildAttachmentCleanupPlan() {
    var markedFiles = getMarkedAttachmentFiles();
    var markedSize = markedFiles.reduce(function (sum, file) { return sum + (Number(file.size) || 0); }, 0);
    var lineFile = state.sourceMode === "folder" ? findLineDatabaseFile() : state.files[0];
    return {
      schemaVersion: "0.3",
      planType: "line-attachment-cleanup",
      generatedAt: new Date().toISOString(),
      source: {
        mode: state.sourceMode,
        selectedRoot: state.sourceRoot,
        totalFiles: state.files.length,
        totalBytes: state.sourceSize,
        lineSqlitePath: lineFile ? archiveRelativePath(lineFile) : "",
        lineSqliteLastModified: lineFile && lineFile.lastModified ? new Date(lineFile.lastModified).toISOString() : null
      },
      policy: {
        originalFilesAreUntouched: true,
        keepAllFilesNotListed: true,
        estimatedReleaseBytes: markedSize,
        estimatedRemainingBytes: Math.max(0, state.sourceSize - markedSize),
        hashStatus: "未計算；此階段只輸出操作計畫"
      },
      markedForRemoval: markedFiles.map(function (file) {
        var path = relativePath(file);
        var context = state.attachmentReviewByPath.get(path);
        var review = context && context.review;
        var entry = {
          path: archiveRelativePath(file),
          category: attachmentCategory(archiveRelativePath(file)),
          size: Number(file.size) || 0,
          mime: file.type || "",
          lastModified: file.lastModified ? new Date(file.lastModified).toISOString() : null,
          referenceStatus: review ? review.referenceStatus : "unconfirmed"
        };
        if (review && review.referenceStatus === "referenced") {
          entry.conversation = {
            id: review.chat.id || "",
            title: review.chat.title,
            type: review.chat.type
          };
          entry.message = {
            id: review.messageId || "",
            timestamp: review.message && review.message.timestamp ? review.message.timestamp.toISOString() : null,
            sender: review.message ? review.message.sender : "",
            summary: review.message ? review.message.summary : ""
          };
          entry.relatedFiles = review.files.filter(function (descriptor) {
            return descriptor.path !== path;
          }).map(function (descriptor) {
            return { path: descriptor.archivePath, category: descriptor.category };
          });
        } else if (review) {
          entry.referenceContext = {
            classification: cleanupReferenceStatusLabel(review.referenceStatus),
            pathChatId: attachmentPathContext(path).chatId || "",
            messageId: review.messageId || ""
          };
        }
        return entry;
      }),
      warnings: [
        "這不是已驗證可直接還原的 .imazingapp；請在副本上執行。",
        "請保留 Container、Messages/Line.sqlite 與所有未列出的檔案。",
        "刪除原始附件可能使 LINE 聊天中的媒體無法開啟；刪除縮圖通常只會移除預覽圖。",
        "「SQLite 未引用」表示附件未被路徑所屬聊天室的目前 Line.sqlite 訊息引用，仍應人工確認後再刪除。",
        "瀏覽器無法保證保留或設定 macOS 檔案的 creation time；SQLite 內的訊息時間不會由本計畫改寫。"
      ]
    };
  }

  function exportAttachmentCleanupPlan() {
    if (!state.attachmentFiles.length) return;
    var plan = buildAttachmentCleanupPlan();
    downloadText("line-attachment-cleanup-plan.json", JSON.stringify(plan, null, 2), "application/json;charset=utf-8");
  }

  function exportAttachmentCleanupInstructions() {
    if (!state.attachmentFiles.length) return;
    var plan = buildAttachmentCleanupPlan();
    var lines = [
      "LINE 附件瘦身操作說明",
      "====================",
      "產生時間：" + plan.generatedAt,
      "來源根目錄：" + (plan.source.selectedRoot || "（單檔模式）"),
      "標記移除：" + formatNumber(plan.markedForRemoval.length) + " 個檔案",
      "預估釋放：" + formatBytes(plan.policy.estimatedReleaseBytes),
      "",
      "安全操作順序：",
      "1. 保留原始 LINE.imazingapp，不要直接覆寫。",
      "2. 複製一份工作副本，再將副本副檔名改成 .zip。",
      "3. 使用支援原地編輯壓縮檔的工具，依下方路徑移除檔案。不要把整個封存檔解壓後重新壓縮。",
      "4. 確認 Container、Messages/Line.sqlite 與未列出的檔案都保留。",
      "5. 將工作副本改回 .imazingapp；在 iMazing 的 Manage Apps > Restore App Data 中先做 dry-run。",
      "6. 只有在確認 iMazing 接受檔案後，才考慮於測試裝置還原；原始檔仍須保留。",
      "",
      "標記移除的檔案："
    ];
    if (!plan.markedForRemoval.length) lines.push("（目前沒有標記，所有檔案都應保留）");
    var entriesByConversation = new Map();
    plan.markedForRemoval.forEach(function (entry) {
      var conversationTitle = entry.conversation
        ? entry.conversation.title
        : (entry.referenceStatus === "unreferenced" ? "孤兒檔案（SQLite 未引用）" : "無法確認引用的附件");
      if (!entriesByConversation.has(conversationTitle)) entriesByConversation.set(conversationTitle, []);
      entriesByConversation.get(conversationTitle).push(entry);
    });
    entriesByConversation.forEach(function (entries, conversationTitle) {
      var firstEntry = entries[0];
      lines.push("", "【" + conversationTitle + "】" + (firstEntry.conversation ? " " + typeLabel(firstEntry.conversation.type) : ""));
      if (!firstEntry.conversation) {
        lines.push("  分類：" + cleanupReferenceStatusLabel(firstEntry.referenceStatus) + "，請人工確認後再刪除。");
      }
      entries.forEach(function (entry) {
        if (entry.message && (entry.message.sender || entry.message.timestamp || entry.message.summary)) {
          var messageDate = entry.message.timestamp ? formatDate(new Date(entry.message.timestamp), true) : "未知時間";
          lines.push("  對話：" + (entry.message.sender || "未知傳送者") + " · " + messageDate + " · " + (entry.message.summary || "沒有文字摘要"));
        }
        lines.push("  - " + entry.path + " · " + entry.category + " · " + formatBytes(entry.size));
      });
    });
    lines.push("", "注意：這份清單不會改寫 SQLite，也不能承諾保留 macOS creation time；LINE 訊息時間來自 SQLite。");
    downloadText("line-attachment-cleanup-instructions.txt", lines.join("\n"), "text/plain;charset=utf-8");
  }

  function getCandidateBackupFiles() {
    return state.files.filter(function (file) {
      var path = archiveRelativePath(file);
      var filename = fileNameOf(path);
      return !filename.startsWith("._") && filename !== ".DS_Store" && (path === ".lock" || path === "iTunesArtwork" || path === "iTunesMetadata.plist" || path.indexOf("Container/") === 0 || path.indexOf("Payload/") === 0);
    });
  }

  function safeArchivePath(path) {
    return String(path || "").replace(/\\/g, "/").split("/").filter(function (part) {
      return part && part !== "." && part !== "..";
    }).join("/");
  }

  function candidateFilename() {
    return "LINE-slimmed-" + new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z") + ".imazingapp";
  }

  async function openCandidateOutput(filename) {
    if (typeof window.showSaveFilePicker === "function") {
      var handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: "iMazing App Data 封裝", accept: { "application/octet-stream": [".imazingapp"] } }]
      });
      return { writable: await handle.createWritable(), chunks: [], bytes: 0, pending: Promise.resolve(), error: null, closed: false };
    }
    return { writable: null, chunks: [], bytes: 0, pending: Promise.resolve(), error: null, closed: false };
  }

  function createZipCrcTable() {
    var table = new Uint32Array(256);
    for (var index = 0; index < table.length; index += 1) {
      var value = index;
      for (var bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
      }
      table[index] = value >>> 0;
    }
    return table;
  }

  function updateZipCrc32(crc, bytes) {
    for (var index = 0; index < bytes.length; index += 1) {
      crc = (ZIP_CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)) >>> 0;
    }
    return crc;
  }

  function zipDosDateTime(value) {
    var date = new Date(value || 0);
    if (!Number.isFinite(date.getTime()) || date.getFullYear() < 1980) {
      return { time: 0, date: 0x0021 };
    }
    if (date.getFullYear() > 2107) return { time: 0xbf7d, date: 0xff9f };
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
      date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
  }

  function zipEntryBytes(path) {
    return new TextEncoder().encode(path);
  }

  function setZipUint16(bytes, offset, value) {
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(offset, value, true);
  }

  function setZipUint32(bytes, offset, value) {
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, true);
  }

  function makeZipLocalHeader(entry) {
    var bytes = new Uint8Array(30 + entry.nameBytes.length);
    setZipUint32(bytes, 0, 0x04034b50);
    setZipUint16(bytes, 4, entry.isDirectory ? 10 : 20);
    setZipUint16(bytes, 6, 0x0800);
    setZipUint16(bytes, 8, 0);
    setZipUint16(bytes, 10, entry.dos.time);
    setZipUint16(bytes, 12, entry.dos.date);
    setZipUint32(bytes, 14, entry.crc32);
    setZipUint32(bytes, 18, entry.size);
    setZipUint32(bytes, 22, entry.size);
    setZipUint16(bytes, 26, entry.nameBytes.length);
    setZipUint16(bytes, 28, 0);
    bytes.set(entry.nameBytes, 30);
    return bytes;
  }

  function makeZipCentralHeader(entry) {
    var bytes = new Uint8Array(46 + entry.nameBytes.length);
    setZipUint32(bytes, 0, 0x02014b50);
    setZipUint16(bytes, 4, entry.isDirectory ? 10 : 20);
    setZipUint16(bytes, 6, entry.isDirectory ? 10 : 20);
    setZipUint16(bytes, 8, 0x0800);
    setZipUint16(bytes, 10, 0);
    setZipUint16(bytes, 12, entry.dos.time);
    setZipUint16(bytes, 14, entry.dos.date);
    setZipUint32(bytes, 16, entry.crc32);
    setZipUint32(bytes, 20, entry.size);
    setZipUint32(bytes, 24, entry.size);
    setZipUint16(bytes, 28, entry.nameBytes.length);
    setZipUint16(bytes, 30, 0);
    setZipUint16(bytes, 32, 0);
    setZipUint16(bytes, 34, 0);
    setZipUint16(bytes, 36, entry.internalAttributes || 0);
    setZipUint32(bytes, 38, entry.isDirectory ? 0x10 : 0);
    setZipUint32(bytes, 42, entry.localOffset);
    bytes.set(entry.nameBytes, 46);
    return bytes;
  }

  function makeZipEndOfCentralDirectory(entryCount, centralSize, centralOffset) {
    var bytes = new Uint8Array(22);
    setZipUint32(bytes, 0, 0x06054b50);
    setZipUint16(bytes, 4, 0);
    setZipUint16(bytes, 6, 0);
    setZipUint16(bytes, 8, entryCount);
    setZipUint16(bytes, 10, entryCount);
    setZipUint32(bytes, 12, centralSize);
    setZipUint32(bytes, 16, centralOffset);
    setZipUint16(bytes, 20, 0);
    return bytes;
  }

  function compareImazingZipEntries(left, right) {
    function rank(entry) {
      if (entry.path === "iTunesMetadata.plist") return 0;
      if (entry.path.indexOf("Payload/") === 0) return 1;
      if (entry.path.indexOf("Container/") === 0) return 2;
      if (entry.path === ".lock") return 9;
      return 3;
    }
    var rankDifference = rank(left) - rank(right);
    if (rankDifference) return rankDifference;
    return left.path.localeCompare(right.path);
  }

  function buildImazingZipEntries(files) {
    var directoryTimes = new Map();
    var fileEntries = [];
    files.forEach(function (file) {
      var path = safeArchivePath(archiveRelativePath(file));
      if (!path) return;
      var parts = path.split("/");
      for (var index = 1; index < parts.length; index += 1) {
        var directory = parts.slice(0, index).join("/") + "/";
        var existing = directoryTimes.get(directory) || 0;
        directoryTimes.set(directory, Math.max(existing, Number(file.lastModified) || 0));
      }
      fileEntries.push({
        path: path,
        file: file,
        isDirectory: false,
        size: Number(file.size) || 0,
        dos: zipDosDateTime(file.lastModified),
        nameBytes: zipEntryBytes(path),
        internalAttributes: /\.txt$/i.test(path) ? 1 : 0
      });
    });
    var uniquePaths = new Set();
    fileEntries.forEach(function (entry) {
      if (uniquePaths.has(entry.path)) throw new Error("來源包含重複 ZIP 路徑：" + entry.path);
      uniquePaths.add(entry.path);
    });
    var directoryEntries = Array.from(directoryTimes.entries()).map(function (entry) {
      var path = entry[0];
      return {
        path: path,
        file: null,
        isDirectory: true,
        size: 0,
        dos: zipDosDateTime(entry[1]),
        nameBytes: zipEntryBytes(path),
        internalAttributes: 0,
        crc32: 0
      };
    });
    return directoryEntries.concat(fileEntries).sort(compareImazingZipEntries);
  }

  function assertClassicZipLimits(entries) {
    if (entries.length > ZIP_CLASSIC_MAX_U16) {
      throw new Error("檔案數超過非 ZIP64 .imazingapp 可處理上限。");
    }
    var estimatedSize = 22n;
    entries.forEach(function (entry) {
      if (entry.nameBytes.length > ZIP_CLASSIC_MAX_U16 || entry.size > ZIP_CLASSIC_MAX_U32) {
        throw new Error("有檔案超過非 ZIP64 .imazingapp 可處理上限：" + entry.path);
      }
      estimatedSize += BigInt(30 + entry.nameBytes.length + entry.size + 46 + entry.nameBytes.length);
    });
    if (estimatedSize > 0xffffffffn) {
      throw new Error("瘦身後封裝超過 4 GB，為保持 .imazingapp 相容性不建立 ZIP64 封裝。");
    }
  }

  async function writeCandidateChunk(output, chunk) {
    if (!chunk || !chunk.length) return;
    if (output.error) throw output.error;
    output.bytes += chunk.length;
    if (output.writable) {
      try {
        await output.writable.write(chunk);
      } catch (error) {
        output.error = error;
        throw error;
      }
    } else {
      output.chunks.push(chunk);
    }
  }

  function yieldZipExport() {
    return new Promise(function (resolve) { window.setTimeout(resolve, 0); });
  }

  async function calculateFileCrc32(file, onProgress) {
    var crc = 0xffffffff;
    var chunkCount = 0;
    for (var offset = 0; offset < file.size; offset += ZIP_READ_CHUNK_BYTES) {
      var end = Math.min(file.size, offset + ZIP_READ_CHUNK_BYTES);
      var bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
      crc = updateZipCrc32(crc, bytes);
      if (onProgress) onProgress(bytes.length);
      chunkCount += 1;
      if (chunkCount % ZIP_EVENT_LOOP_YIELD_INTERVAL === 0) await yieldZipExport();
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  async function writeFileToCandidateZip(file, output, onProgress) {
    var chunkCount = 0;
    for (var offset = 0; offset < file.size; offset += ZIP_READ_CHUNK_BYTES) {
      var end = Math.min(file.size, offset + ZIP_READ_CHUNK_BYTES);
      var bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
      await writeCandidateChunk(output, bytes);
      if (onProgress) onProgress(bytes.length);
      chunkCount += 1;
      if (chunkCount % ZIP_EVENT_LOOP_YIELD_INTERVAL === 0) await yieldZipExport();
    }
  }

  function updateCandidateProgress(processedBytes, totalBytes, detail) {
    var percent = totalBytes ? Math.round(processedBytes / totalBytes * 100) : 100;
    var progressText = detail + " " + percent + "%";
    setCleanupPackageStatus(progressText, false);
    updatePackageModalProgress(percent, progressText);
  }

  async function writeCandidateZip(files, output) {
    var entries = buildImazingZipEntries(files);
    assertClassicZipLimits(entries);
    var totalBytes = entries.reduce(function (sum, entry) { return sum + entry.size; }, 0);
    var totalWorkBytes = totalBytes * 2;
    var processedCrcBytes = 0;
    var processedWriteBytes = 0;
    var fileEntries = entries.filter(function (entry) { return !entry.isDirectory; });
    var processedCrcFiles = 0;
    var processedWriteFiles = 0;
    var localOffset = 0n;
    var centralEntries = [];

    for (var index = 0; index < entries.length; index += 1) {
      var entry = entries[index];
      entry.crc32 = entry.isDirectory ? 0 : await calculateFileCrc32(entry.file, function (bytes) {
        processedCrcBytes += bytes;
        updateCandidateProgress(
          processedCrcBytes + processedWriteBytes,
          totalWorkBytes,
          "正在驗證檔案…（" + formatNumber(processedCrcFiles + 1) + " / " + formatNumber(fileEntries.length) + "）"
        );
      });
      if (!entry.isDirectory) processedCrcFiles += 1;
      if (localOffset > 0xfffffffen) throw new Error("瘦身後封裝超過非 ZIP64 offset 上限。");
      entry.localOffset = Number(localOffset);
      var localHeader = makeZipLocalHeader(entry);
      await writeCandidateChunk(output, localHeader);
      localOffset += BigInt(localHeader.length);
      if (!entry.isDirectory) {
        await writeFileToCandidateZip(entry.file, output, function (bytes) {
          processedWriteBytes += bytes;
          updateCandidateProgress(
            processedCrcBytes + processedWriteBytes,
            totalWorkBytes,
            "正在寫入檔案…（" + formatNumber(processedWriteFiles + 1) + " / " + formatNumber(fileEntries.length) + "）"
          );
        });
        localOffset += BigInt(entry.size);
        processedWriteFiles += 1;
      }
      centralEntries.push(entry);
    }

    var centralOffset = localOffset;
    for (var centralIndex = 0; centralIndex < centralEntries.length; centralIndex += 1) {
      var centralHeader = makeZipCentralHeader(centralEntries[centralIndex]);
      await writeCandidateChunk(output, centralHeader);
      localOffset += BigInt(centralHeader.length);
    }
    var centralSize = localOffset - centralOffset;
    if (centralOffset > 0xfffffffen || centralSize > 0xfffffffen) {
      throw new Error("瘦身後封裝超過非 ZIP64 central directory 上限。");
    }
    await writeCandidateChunk(output, makeZipEndOfCentralDirectory(
      centralEntries.length,
      Number(centralSize),
      Number(centralOffset)
    ));
    if (output.writable && !output.closed) {
      await output.writable.close();
      output.closed = true;
    }
    return output;
  }

  async function buildImazingCandidatePackage() {
    if (packageInProgress || state.sourceMode !== "folder" || !state.attachmentFiles.length) return;
    var allCandidateFiles = getCandidateBackupFiles();
    var markedPaths = new Set(getMarkedAttachmentFiles().map(function (file) { return relativePath(file); }));
    var packageFiles = allCandidateFiles.filter(function (file) { return !markedPaths.has(relativePath(file)); });
    var packageInputBytes = packageFiles.reduce(function (sum, file) { return sum + (Number(file.size) || 0); }, 0);
    var canStreamToFile = typeof window.showSaveFilePicker === "function";
    var hasContainer = packageFiles.some(function (file) { return archiveRelativePath(file).indexOf("Container/") === 0; });
    var lineFile = findLineDatabaseFile();
    var hasLineSqlite = Boolean(lineFile && packageFiles.indexOf(lineFile) !== -1);
    var hasLock = packageFiles.some(function (file) { return archiveRelativePath(file) === ".lock"; });
    var hasLineWal = state.files.some(function (file) {
      return /\/Messages\/Line\.sqlite-wal$/i.test(relativePath(file));
    });
    if (!hasContainer) {
      setCleanupPackageStatus("無法建立瘦身 .imazingapp：選取的資料夾沒有 Container/；請選取包含 Container 與 Payload 的完整 iMazing 備份資料夾。", true);
      return;
    }
    if (!hasLineSqlite) {
      setCleanupPackageStatus("無法建立瘦身 .imazingapp：Messages/Line.sqlite 不在保留檔案中。", true);
      return;
    }
    if (!canStreamToFile && packageInputBytes > MAX_BLOB_CANDIDATE_BYTES) {
      setCleanupPackageStatus("目前瀏覽器不支援直接寫入大型檔案；瘦身 .imazingapp 預估超過 256 MB，請改用支援 File System Access API 的 Chrome／Edge 桌面版，以避免 Blob 下載造成記憶體峰值。", true);
      return;
    }

    packageInProgress = true;
    var initialPackageMessage = hasLineWal
      ? "正在準備封裝，會保留 Line.sqlite-wal。"
      : "正在整理保留的檔案，請勿關閉此頁面。";
    showPackageModal(initialPackageMessage);
    renderAttachmentCleanup();
    setCleanupPackageStatus(initialPackageMessage, false);
    var output = null;
    try {
      var filename = candidateFilename();
      if (!canStreamToFile) await waitForUiPaint();
      output = await openCandidateOutput(filename);
      await writeCandidateZip(packageFiles, output);
      if (!output.writable) {
        downloadBlob(filename, new Blob(output.chunks, { type: "application/octet-stream" }));
      }
      var warnings = [];
      if (!hasLock) warnings.push("來源沒有 .lock，請勿視為可驗證的 iMazing 封裝");
      if (!packageFiles.some(function (file) { return archiveRelativePath(file).indexOf("Payload/") === 0; })) warnings.push("來源沒有 Payload/，請以 iMazing dry-run 驗證");
      if (hasLineWal) warnings.push("已保留 Line.sqlite-wal，但附件引用判定未套用 WAL");
      warnings.push("此 .imazingapp 由瀏覽器重新建立，尚未通過 iMazing 實機還原");
      var successMessage = "已建立 " + formatBytes(output.bytes) + " 的 .imazingapp，保留 " + formatNumber(packageFiles.length) + " 個檔案。" + (warnings.length ? " 注意：" + warnings.join("；") + "。" : "");
      setCleanupPackageStatus(successMessage, false);
      completePackageModal(false, "瘦身 .imazingapp 已建立", successMessage);
    } catch (error) {
      if (output && output.writable && !output.closed) {
        try { await output.writable.abort(); } catch (abortError) { console.warn(abortError); }
      }
      var errorMessage = error && error.name === "AbortError"
        ? "已取消建立瘦身 .imazingapp。"
        : "瘦身 .imazingapp 建立失敗：" + (error && error.message ? error.message : String(error));
      setCleanupPackageStatus(errorMessage, error && error.name !== "AbortError");
      completePackageModal(true, error && error.name === "AbortError" ? "已取消建立" : "建立失敗", errorMessage);
      console.error(error);
    } finally {
      packageInProgress = false;
      renderAttachmentCleanup();
    }
  }

  function initializeBrowserInsights() {
    state.capabilities = probeBrowserCapabilities();
    renderCapabilitySummary();
    populateSchemaTables();
    runBrowserHealth();
    if (el.runHealthButton) el.runHealthButton.disabled = false;
    if (el.globalSearchButton) el.globalSearchButton.disabled = false;
    if (el.searchEngineBadge) el.searchEngineBadge.textContent = state.capabilities.fts5 === "available" ? "SQLite FTS5 capability" : "LIKE fallback";
    if (el.scanAttachmentDuplicatesButton) el.scanAttachmentDuplicatesButton.disabled = state.sourceMode !== "folder" || !state.attachmentFiles.length;
  }

  function probeBrowserCapabilities() {
    var version = safeQuery("SELECT sqlite_version() AS value", {})[0];
    var json = safeQuery("SELECT json_valid($value) AS value", { $value: "{}" })[0];
    var fts = safeQuery("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS value", {})[0];
    var windowResult = safeQuery("SELECT row_number() OVER (ORDER BY 1) AS value", {})[0];
    var dbstat = safeQuery("SELECT name FROM dbstat LIMIT 1", {})[0];
    return {
      sqlite_version: version ? stringOrEmpty(version.value) : "unknown",
      json_functions: json && Number(json.value) === 1 ? "available" : "unavailable",
      fts5: fts && Number(fts.value) === 1 ? "available" : "unavailable",
      window_functions: windowResult && Number(windowResult.value) === 1 ? "available" : "unavailable",
      dbstat: dbstat ? "available" : "unavailable",
      read_only: true,
      warnings: []
    };
  }

  function renderCapabilitySummary() {
    if (!el.capabilitySummary || !state.capabilities) return;
    if (state.indexMode) {
      el.capabilitySummary.textContent = "大型索引 · 不開啟原始 SQLite";
      return;
    }
    var capability = state.capabilities;
    el.capabilitySummary.textContent = "SQLite " + capability.sqlite_version + " · JSON " + capability.json_functions + " · FTS5 " + capability.fts5;
  }

  function runBrowserHealth() {
    if (state.indexMode) {
      renderHealthSummary();
      return;
    }
    if (!state.database) return;
    var quick = [];
    var quickError = "";
    try {
      quick = query("PRAGMA quick_check", {}).map(function (row) { return firstNonEmpty(row.quick_check, row["quick_check"], Object.values(row)[0]); });
    } catch (error) {
      quickError = error && error.message ? error.message : String(error);
    }
    var warnings = [];
    var lineFile = state.sourceMode === "database" ? state.files[0] : findFileEnding("/Messages/Line.sqlite");
    var walFile = state.sourceMode === "folder" ? findFileEnding("/Messages/Line.sqlite-wal") : null;
    var shmFile = state.sourceMode === "folder" ? findFileEnding("/Messages/Line.sqlite-shm") : null;
    if (state.sourceMode === "folder" && Boolean(walFile) !== Boolean(shmFile)) warnings.push("WAL／SHM 只找到其中一個檔案，請確認 staging 是否完整。");
    if (quickError) warnings.push("quick_check 無法完成：" + quickError);
    if (quick.length && quick.some(function (value) { return value !== "ok"; })) warnings.push("SQLite quick_check 回報非 ok 結果。");
    var messageCount = safeQuery("SELECT count(*) AS value FROM ZMESSAGE", {})[0];
    var chatCount = safeQuery("SELECT count(*) AS value FROM ZCHAT", {})[0];
    var tableCount = safeQuery("SELECT count(*) AS value FROM sqlite_master WHERE type='table'", {})[0];
    var pageCount = safeQuery("PRAGMA page_count", {})[0];
    var pageSize = safeQuery("PRAGMA page_size", {})[0];
    var timestampRange = safeQuery("SELECT min(ZTIMESTAMP) AS minimum, max(ZTIMESTAMP) AS maximum FROM ZMESSAGE WHERE ZTIMESTAMP IS NOT NULL", {})[0];
    var status = warnings.length ? "warning" : "pass";
    state.health = {
      status: status,
      read_only: true,
      checks: {
        quick_check: quick.length ? quick : "not_checked",
        line_sqlite: lineFile ? { name: lineFile.name, bytes: lineFile.size } : "missing",
        wal: walFile ? { name: walFile.name, bytes: walFile.size } : "not_present",
        shm: shmFile ? { name: shmFile.name, bytes: shmFile.size } : "not_present",
        chat_count: chatCount ? Number(Object.values(chatCount)[0]) : state.chats.length,
        message_count: messageCount ? Number(Object.values(messageCount)[0]) : 0,
        table_count: tableCount ? Number(Object.values(tableCount)[0]) : 0,
        page_count: pageCount ? Number(Object.values(pageCount)[0]) : null,
        page_size: pageSize ? Number(Object.values(pageSize)[0]) : null,
        timestamp_unit: detectBrowserTimestampUnit(),
        timestamp_range: timestampRange ? { min: timestampRange.minimum, max: timestampRange.maximum } : null,
        attachment_count: state.attachmentFiles.length,
        unlinked_attachment_count: state.attachmentFiles.filter(function (file) { return attachmentContext(file).status === "unlinked"; }).length
      },
      warnings: warnings
    };
    renderHealthSummary();
  }

  function renderHealthSummary() {
    if (!el.healthSummary || !state.health) return;
    var health = state.health;
    var checks = health.checks || {};
    var statusLabel = { pass: "通過", warning: "需要注意", error: "錯誤", not_checked: "未檢查" }[health.status] || "未檢查";
    var quick = Array.isArray(checks.quick_check) ? checks.quick_check.join(", ") : stringOrEmpty(checks.quick_check || "not_checked");
    var sourceHash = checks.source_sha256 ? stringOrEmpty(checks.source_sha256).slice(0, 16) + "…" : "—";
    var items = [
      ["狀態", statusLabel],
      ["quick_check", quick],
      ["聊天室／訊息", formatNumber(checks.chat_count || checks.conversation_count || 0) + " / " + formatNumber(checks.message_count || checks.message_rows || 0)],
      ["附件／未關聯", formatNumber(checks.attachment_count || 0) + " / " + formatNumber(checks.unlinked_attachment_count || 0)],
      ["訊息時間", checks.timestamp_range ? formatDate(normalizeTimestamp(checks.timestamp_range.min), false) + " ～ " + formatDate(normalizeTimestamp(checks.timestamp_range.max), false) : "—"],
      ["來源 hash", sourceHash]
    ];
    el.healthSummary.innerHTML = '<dl class="health-list">' + items.map(function (item) { return '<div><dt>' + escapeHtml(item[0]) + '</dt><dd>' + escapeHtml(item[1]) + '</dd></div>'; }).join("") + '</dl>' + ((health.warnings || []).length ? '<p class="health-warning">' + escapeHtml(health.warnings.join("；")) + '</p>' : "");
  }

  async function runGlobalSearch() {
    var term = (el.globalSearchInput.value || "").trim();
    if (!term) {
      el.globalSearchResults.innerHTML = '<span class="empty-state">請先輸入搜尋文字。</span>';
      return;
    }
    el.globalSearchResults.innerHTML = '<span class="empty-state">搜尋中…</span>';
    try {
      var results = state.indexMode ? await searchReaderIndex(term, getSearchFilters()) : searchDatabase(term, getSearchFilters());
      renderGlobalSearchResults(results, term);
    } catch (error) {
      el.globalSearchResults.innerHTML = '<span class="empty-state">搜尋失敗：' + escapeHtml(error && error.message ? error.message : String(error)) + '</span>';
    }
  }

  function getSearchFilters() {
    var chatKey = el.globalSearchChatSelect && el.globalSearchChatSelect.value ? el.globalSearchChatSelect.value : "";
    var selectedChat = chatKey ? state.chatsByKey.get(chatKey) : null;
    var filters = {
      chatKey: chatKey,
      chatPk: state.indexMode && selectedChat ? selectedChat.pk : null,
      senderPk: el.globalSearchSenderSelect && el.globalSearchSenderSelect.value ? Number(el.globalSearchSenderSelect.value) : null,
      contentType: el.globalSearchContentType && el.globalSearchContentType.value !== "" ? Number(el.globalSearchContentType.value) : null,
      fromTimestamp: null,
      toTimestamp: null
    };
    var unit = state.indexMode ? stringOrEmpty(state.indexManifest && state.indexManifest.timestamp_unit) : detectBrowserTimestampUnit();
    if (el.globalSearchFrom && el.globalSearchFrom.value) filters.fromTimestamp = dateInputToRaw(el.globalSearchFrom.value, unit, false);
    if (el.globalSearchTo && el.globalSearchTo.value) filters.toTimestamp = dateInputToRaw(el.globalSearchTo.value, unit, true);
    return filters;
  }

  function detectBrowserTimestampUnit() {
    var row = safeQuery("SELECT max(abs(ZTIMESTAMP)) AS value FROM ZMESSAGE", {})[0];
    var value = row ? Number(row.value) : 0;
    if (value >= 1e14) return "microseconds";
    if (value >= 1e11) return "milliseconds";
    if (value >= 1e8) return "seconds";
    return "seconds";
  }

  function dateInputToRaw(value, unit, endOfDay) {
    var millis = Date.parse(String(value) + (endOfDay ? "T23:59:59.999" : "T00:00:00.000"));
    if (!Number.isFinite(millis)) return null;
    if (unit === "microseconds") return millis * 1000;
    if (unit === "milliseconds") return millis;
    return Math.floor(millis / 1000);
  }

  function searchDatabase(term, filters) {
    var results = ["line", "square"].filter(function (source) { return Boolean(databaseForSource(source)); }).reduce(function (all, source) {
      return all.concat(searchDatabaseSource(source, term, filters));
    }, []);
    return results.sort(function (left, right) {
      var timestamp = (Number(right.timestampRaw) || 0) - (Number(left.timestampRaw) || 0);
      if (timestamp) return timestamp;
      var source = String(left.source || "").localeCompare(String(right.source || ""));
      if (source) return source;
      return Number(right.pk || 0) - Number(left.pk || 0);
    }).slice(0, 100);
  }

  function searchDatabaseSource(source, term, filters) {
    filters = filters || {};
    var conditions = ["COALESCE(ZTEXT, '') LIKE $pattern ESCAPE '\\'"];
    var params = { $pattern: "%" + term.replace(/[\\%_]/g, "\\$&") + "%" };
    var chat = filters.chatKey ? state.chatsByKey.get(filters.chatKey) : null;
    var reference = chat && chat.sourceChats ? chat.sourceChats[source] : null;
    if (filters.chatKey && !reference) return [];
    if (reference) { conditions.push("ZCHAT = $chatPk"); params.$chatPk = reference.pk; }
    if (source === "line" && filters.senderPk !== null && filters.senderPk !== undefined) { conditions.push("ZSENDER = $senderPk"); params.$senderPk = filters.senderPk; }
    if (filters.contentType !== null && filters.contentType !== undefined) { conditions.push("ZCONTENTTYPE = $contentType"); params.$contentType = filters.contentType; }
    if (filters.fromTimestamp !== null && filters.fromTimestamp !== undefined) { conditions.push("COALESCE(ZTIMESTAMP, 0) >= $fromTimestamp"); params.$fromTimestamp = filters.fromTimestamp; }
    if (filters.toTimestamp !== null && filters.toTimestamp !== undefined) { conditions.push("COALESCE(ZTIMESTAMP, 0) <= $toTimestamp"); params.$toTimestamp = filters.toTimestamp; }
    var rows = safeQuerySource(
      source,
      "SELECT Z_PK AS messagePk, ZID AS messageId, ZCHAT AS chatPk, ZSENDER AS senderPk, ZCONTENTTYPE AS contentType, ZTIMESTAMP AS timestamp, ZTEXT AS text " +
      "FROM ZMESSAGE WHERE " + conditions.join(" AND ") + " ORDER BY COALESCE(ZTIMESTAMP, 0) DESC, Z_PK DESC LIMIT 100",
      params
    );
    return rows.map(function (row) { return makeSearchResult(row, term, "exact", source); });
  }

  async function searchReaderIndex(term, filters) {
    filters = filters || {};
    var results = [];
    var files = state.files.filter(function (file) { return /(?:^|\/)messages\/.*\.jsonl$/i.test(relativePath(file)); }).sort(function (left, right) { return relativePath(left).localeCompare(relativePath(right)); });
    for (var index = 0; index < files.length && results.length < 100; index += 1) {
      var rows = parseJsonLines(await files[index].text());
      rows.forEach(function (row) {
        var rawTimestamp = row.timestamp !== undefined ? row.timestamp : row.timestamp_raw;
        if (results.length >= 100 || stringOrEmpty(row.text).toLocaleLowerCase().indexOf(term.toLocaleLowerCase()) === -1) return;
        if (filters.chatPk !== null && filters.chatPk !== undefined && Number(row.chatPk !== undefined ? row.chatPk : row.chat_pk) !== filters.chatPk) return;
        if (filters.senderPk !== null && filters.senderPk !== undefined && Number(row.sender_pk) !== filters.senderPk) return;
        if (filters.contentType !== null && filters.contentType !== undefined && Number(row.content_type) !== filters.contentType) return;
        if (filters.fromTimestamp !== null && filters.fromTimestamp !== undefined && Number(rawTimestamp || 0) < filters.fromTimestamp) return;
        if (filters.toTimestamp !== null && filters.toTimestamp !== undefined && Number(rawTimestamp || 0) > filters.toTimestamp) return;
        row.source_shard = relativePath(files[index]);
        results.push(makeSearchResult({
          pk: row.pk,
          id: row.id,
          chatPk: row.chatPk !== undefined ? row.chatPk : row.chat_pk,
          timestamp: rawTimestamp,
          senderPk: row.sender_pk,
          sender: row.sender_name,
          contentType: row.content_type,
          text: row.text,
          source_shard: row.source_shard
        }, term, "exact"));
      });
      if (index % 8 === 0) await new Promise(function (resolve) { window.setTimeout(resolve, 0); });
    }
    return results.sort(function (left, right) { return (right.timestampRaw || 0) - (left.timestampRaw || 0); });
  }

  function makeSearchResult(row, term, confidence, source) {
    source = source || "line";
    var chatPk = row.chatPk !== undefined ? row.chatPk : row.chat_pk;
    var timestampRaw = row.timestamp !== undefined ? row.timestamp : row.timestamp_raw;
    var chat = state.indexMode
      ? state.chats.find(function (item) { return Number(item.pk) === Number(chatPk); })
      : state.chatsBySourcePk.get(sourcePkKey(source, chatPk));
    var text = stringOrEmpty(row.text);
    var lowerText = text.toLocaleLowerCase();
    var index = lowerText.indexOf(term.toLocaleLowerCase());
    var start = index < 0 ? 0 : Math.max(0, index - 48);
    var snippet = (start ? "…" : "") + text.slice(start, start + 140) + (text.length > start + 140 ? "…" : "");
    return {
      pk: numberOrNull(row.messagePk || row.pk),
      id: stringOrEmpty(row.messageId || row.id),
      chatPk: numberOrNull(chatPk),
      chatKey: chat ? (chat.key || "") : "",
      chatTitle: chat ? chat.title : "未知聊天室",
      text: text,
      snippet: snippet,
      timestampRaw: timestampRaw,
      timestamp: normalizeTimestamp(timestampRaw),
      sender: firstNonEmpty(row.sender, row.sender_name, (sourceSender(source, row.senderPk !== undefined ? row.senderPk : row.sender_pk) || {}).name),
      confidence: confidence,
      source: row.source_shard || sourceDatabaseLabel(source)
    };
  }

  function renderGlobalSearchResults(results, term) {
    if (!results.length) {
      el.globalSearchResults.innerHTML = '<span class="empty-state">找不到「' + escapeHtml(term) + '」的訊息。</span>';
      return;
    }
    el.globalSearchResults.innerHTML = results.map(function (result) {
      return '<button type="button" class="search-result" data-search-chat-key="' + escapeHtml(result.chatKey) + '" data-search-chat-pk="' + escapeHtml(String(result.chatPk)) + '"><strong>' + escapeHtml(result.chatTitle) + '</strong><span>' + escapeHtml(result.snippet) + '</span><small>' + escapeHtml((result.sender ? result.sender + " · " : "") + formatDate(result.timestamp, true) + " · " + result.confidence + " · " + result.source) + '</small></button>';
    }).join("");
    el.globalSearchResults.querySelectorAll("button[data-search-chat-key]").forEach(function (button) {
      button.addEventListener("click", function () {
        var chat = state.indexMode
          ? state.chats.find(function (item) { return Number(item.pk) === Number(button.getAttribute("data-search-chat-pk")); })
          : state.chatsByKey.get(button.getAttribute("data-search-chat-key") || "");
        if (chat) selectChat(chat);
      });
    });
  }

  function runTimelineAnalysis() {
    if (!state.currentChat) return;
    var rows;
    if (state.indexMode) {
      rows = state.currentMessages.map(function (message) { return { timestamp: message.timestampRaw, pk: message.pk }; });
    } else {
      rows = loadAllMessagesForChat(state.currentChat).map(function (message) { return { timestamp: message.timestampRaw, pk: message.pk, source: message.provenance.source }; });
    }
    var events = [];
    var previous = null;
    rows.forEach(function (row) {
      var currentRaw = Number(row.timestamp) || 0;
      var current = timestampToSeconds(currentRaw);
      if (!Number.isFinite(current)) return;
      if (previous) {
        var gap = Math.max(0, current - previous.seconds);
        if (gap >= 7200 || gap <= 300) events.push({ type: gap >= 7200 ? "gap" : "burst", gap: gap, from: previous.raw, to: currentRaw, fromSeconds: previous.seconds, toSeconds: current });
      }
      previous = { raw: currentRaw, seconds: current, pk: row.pk };
    });
    renderTimelineSummary(events, rows.length);
  }

  function timestampToSeconds(value) {
    var number = Number(value);
    if (!Number.isFinite(number)) return null;
    var magnitude = Math.abs(number);
    if (magnitude >= 1e14) return number / 1000000;
    if (magnitude >= 1e11) return number / 1000;
    if (magnitude >= 1e8) return number;
    return number || null;
  }

  function renderTimelineSummary(events, rowCount) {
    if (!events.length) {
      el.timelineSummary.innerHTML = '<span class="empty-state">目前沒有超過門檻的長間隔或訊息高峰（推測規則：間隔 ≥ 2 小時／≤ 5 分鐘）。</span>';
      return;
    }
    el.timelineSummary.innerHTML = '<p class="timeline-note">共 ' + formatNumber(rowCount) + ' 則訊息；以下是啟發式事件，不是 LINE 原始章節。</p>' + events.slice(0, 40).map(function (event, index) {
      var label = event.type === "gap" ? "長間隔 · 推測新章節" : "短間隔 · 訊息高峰";
      return '<div class="timeline-event"><span class="timeline-dot ' + event.type + '"></span><div><strong>' + escapeHtml(label) + '</strong><small>' + escapeHtml(formatDate(normalizeTimestamp(event.from), true) + " → " + formatDate(normalizeTimestamp(event.to), true) + " · 間隔 " + formatDurationSeconds(event.gap)) + '</small><em>confidence: heuristic</em></div></div>';
    }).join("");
  }

  function formatDurationSeconds(seconds) {
    var value = Math.max(0, Number(seconds) || 0);
    if (value < 60) return Math.round(value) + " 秒";
    if (value < 3600) return Math.round(value / 60) + " 分鐘";
    return (value / 3600).toFixed(value >= 86400 ? 0 : 1) + " 小時";
  }

  function populateSchemaTables() {
    if (!el.schemaTableSelect) return;
    if (state.indexMode || !state.database) {
      el.schemaTableSelect.innerHTML = '<option value="">CLI schema 可查看原始資料庫</option>';
      return;
    }
    var tables = safeQuery("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name", {});
    el.schemaTableSelect.innerHTML = '<option value="">選取資料表</option>' + tables.map(function (row) { return '<option value="' + escapeHtml(row.name) + '">' + escapeHtml(row.name) + '</option>'; }).join("");
  }

  function renderSchemaTable(tableName) {
    if (!tableName) {
      renderSchemaExplorerEmpty("選取資料表後顯示欄位與限量範例。");
      return;
    }
    if (state.indexMode || !state.database || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) return;
    var quoted = '"' + tableName.replace(/"/g, '""') + '"';
    var columns = safeQuery("PRAGMA table_info(" + quoted + ")", {});
    var indexes = safeQuery("PRAGMA index_list(" + quoted + ")", {});
    var foreignKeys = safeQuery("PRAGMA foreign_key_list(" + quoted + ")", {});
    var rows = safeQuery("SELECT * FROM " + quoted + " LIMIT 5", {});
    var headers = columns.map(function (column) { return '<th>' + escapeHtml(column.name) + '</th>'; }).join("");
    var body = rows.map(function (row) {
      return '<tr>' + columns.map(function (column) { return '<td>' + escapeHtml(maskSchemaValue(row[column.name], column.name)) + '</td>'; }).join("") + '</tr>';
    }).join("");
    var foreignKeyText = foreignKeys.length
      ? foreignKeys.map(function (key) { return key.from + " → " + key.table + "." + (key.to || "（rowid）"); }).join("、")
      : "無（以下候選關聯僅依欄名推測）";
    var candidateRelations = columns.filter(function (column) { return /_PK$/.test(column.name) || ["ZCHAT", "ZSENDER", "ZMID", "ZID"].indexOf(column.name) !== -1; }).map(function (column) { return column.name; });
    el.schemaExplorer.innerHTML = '<div class="schema-meta">欄位 ' + formatNumber(columns.length) + ' · 索引 ' + formatNumber(indexes.length) + ' · 範例最多 5 筆</div><div class="schema-scroll"><table class="schema-table"><thead><tr>' + headers + '</tr></thead><tbody>' + (body || '<tr><td colspan="' + Math.max(1, columns.length) + '">沒有資料列</td></tr>') + '</tbody></table></div><p class="schema-indexes">索引：' + escapeHtml(indexes.map(function (index) { return index.name; }).join("、") || "無") + '</p><p class="schema-indexes">Declared foreign key：' + escapeHtml(foreignKeyText) + '</p><p class="schema-indexes">Inferred candidate relation：' + escapeHtml(candidateRelations.join("、") || "無") + '</p>';
  }

  function renderSchemaExplorerEmpty(text) {
    if (el.schemaExplorer) el.schemaExplorer.innerHTML = '<span class="empty-state">' + escapeHtml(text) + '</span>';
  }

  function maskSchemaValue(value, columnName) {
    if (value === null || value === undefined) return "NULL";
    if (value instanceof Uint8Array || Array.isArray(value)) return "[BLOB " + formatNumber(value.length) + " bytes]";
    var name = String(columnName || "").toUpperCase();
    if (/TEXT|NAME|ADDRESS|STATUS|MID|ZID|SENDER/.test(name)) return "[已遮罩 " + String(value).length + " 字元]";
    return String(value).slice(0, 120);
  }

  async function scanAttachmentDuplicates() {
    if (state.sourceMode !== "folder" || !state.attachmentFiles.length) return;
    if (!window.crypto || !window.crypto.subtle) {
      el.duplicateStatus.textContent = "目前瀏覽器沒有 Web Crypto SHA-256；請改用 CLI duplicates。";
      return;
    }
    el.scanAttachmentDuplicatesButton.disabled = true;
    el.duplicateStatus.textContent = "正在依檔案大小分組並計算 SHA-256…";
    try {
      var bySize = new Map();
      state.attachmentFiles.forEach(function (file) {
        var size = Number(file.size) || 0;
        if (!bySize.has(size)) bySize.set(size, []);
        bySize.get(size).push(file);
      });
      var byDigest = new Map();
      for (var entries of bySize.values()) {
        if (entries.length < 2) continue;
        for (var index = 0; index < entries.length; index += 1) {
          var digest = await digestFile(entries[index]);
          var key = entries[index].size + ":" + digest;
          if (!byDigest.has(key)) byDigest.set(key, { sha256: digest, size: entries[index].size, files: [] });
          byDigest.get(key).files.push(entries[index]);
        }
      }
      state.attachmentDuplicateGroups = Array.from(byDigest.values()).filter(function (group) { return group.files.length > 1; }).map(function (group) {
        var hasThumbnail = group.files.some(function (file) { return /\/Message Thumbnails\//.test(archiveRelativePath(file)); });
        var hasOriginal = group.files.some(function (file) { return !/\/Message Thumbnails\//.test(archiveRelativePath(file)); });
        return { sha256: group.sha256, size: group.size, files: group.files, classification: hasThumbnail && hasOriginal ? "thumbnail_of_attachment" : "exact_duplicate" };
      });
      renderDuplicateResults();
      el.duplicateStatus.textContent = "完成：掃描 " + formatNumber(state.attachmentFiles.length) + " 個候選檔案，找到 " + formatNumber(state.attachmentDuplicateGroups.length) + " 組 exact duplicate。";
    } catch (error) {
      el.duplicateStatus.textContent = "重複掃描失敗：" + (error && error.message ? error.message : String(error));
    } finally {
      el.scanAttachmentDuplicatesButton.disabled = false;
    }
  }

  async function digestFile(file) {
    var digest = await window.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return Array.from(new Uint8Array(digest)).map(function (value) { return value.toString(16).padStart(2, "0"); }).join("");
  }

  function renderDuplicateResults() {
    if (!el.duplicateResults) return;
    if (!state.attachmentDuplicateGroups.length) {
      el.duplicateResults.innerHTML = '<span class="empty-state">尚未找到 exact duplicate；相似檔案不會被自動視為重複。</span>';
      return;
    }
    el.duplicateResults.innerHTML = state.attachmentDuplicateGroups.map(function (group, index) {
      var files = group.files.map(function (file) { return '<li>' + escapeHtml(archiveRelativePath(file)) + ' · ' + escapeHtml(formatBytes(file.size)) + '</li>'; }).join("");
      return '<article class="duplicate-group"><div><strong>群組 ' + (index + 1) + ' · ' + escapeHtml(group.sha256.slice(0, 16)) + '…</strong><button type="button" class="button button-quiet" data-duplicate-group="' + index + '">標記除第一個外</button></div><ul>' + files + '</ul><small>' + escapeHtml(group.classification) + ' · 預設保留第一個，仍需人工確認路徑與附件脈絡。</small></article>';
    }).join("");
  }

  function markDuplicateAlternatives(index) {
    var group = state.attachmentDuplicateGroups[index];
    if (!group) return;
    group.files.slice(1).forEach(function (file) { state.attachmentsMarkedForRemoval.add(relativePath(file)); });
    renderAttachmentCleanup();
    renderDuplicateResults();
  }

  async function runBrowserDiff() {
    var leftFile = el.diffLeftInput.files && el.diffLeftInput.files[0];
    var rightFile = el.diffRightInput.files && el.diffRightInput.files[0];
    if (!leftFile || !rightFile) {
      el.diffStatus.textContent = "請先選取左側與右側兩份 Line.sqlite。";
      return;
    }
    if (leftFile.size > 256 * 1024 * 1024 || rightFile.size > 256 * 1024 * 1024) {
      el.diffStatus.textContent = "其中一份資料庫超過瀏覽器差異比較安全門檻，請改用 CLI diff。";
      return;
    }
    el.runDiffButton.disabled = true;
    el.diffStatus.textContent = "正在唯讀載入兩份 SQLite…";
    try {
      var SQL = await initSqlJs({ locateFile: function (file) { return SQL_WASM_CDN + file; } });
      var leftDatabase = new SQL.Database(new Uint8Array(await leftFile.arrayBuffer()));
      var rightDatabase = new SQL.Database(new Uint8Array(await rightFile.arrayBuffer()));
      try {
        var leftRows = externalDatabaseRows(leftDatabase);
        var rightRows = externalDatabaseRows(rightDatabase);
        var changes = compareBrowserRows(leftRows, rightRows);
        renderBrowserDiff(changes, leftRows.length, rightRows.length);
        el.diffStatus.textContent = "比較完成：左側 " + formatNumber(leftRows.length) + " 則、右側 " + formatNumber(rightRows.length) + " 則；原始檔案未修改。";
      } finally {
        leftDatabase.close();
        rightDatabase.close();
      }
    } catch (error) {
      el.diffStatus.textContent = "差異比較失敗：" + (error && error.message ? error.message : String(error));
      el.diffResults.innerHTML = "";
    } finally {
      el.runDiffButton.disabled = false;
    }
  }

  function externalDatabaseRows(database) {
    var statement = database.prepare("SELECT Z_PK AS messagePk, ZID AS messageId, ZCHAT AS chatPk, ZSENDER AS senderPk, ZTIMESTAMP AS timestamp, ZCONTENTTYPE AS contentType, ZTEXT AS text FROM ZMESSAGE ORDER BY COALESCE(ZTIMESTAMP, 0), Z_PK");
    var rows = [];
    try {
      while (statement.step()) rows.push(statement.getAsObject());
    } finally {
      statement.free();
    }
    return rows;
  }

  function browserDiffKey(row, includeText) {
    var id = stringOrEmpty(row.messageId).trim();
    if (id) return "id:" + id;
    var key = [row.chatPk, row.senderPk, row.timestamp, row.contentType].map(stringOrEmpty).join("|");
    if (includeText) key += "|" + stringOrEmpty(row.text).trim();
    return "inferred:" + key;
  }

  function compareBrowserRows(leftRows, rightRows) {
    var changes = [];
    var leftUsed = new Set();
    var rightUsed = new Set();
    var leftById = new Map();
    var rightById = new Map();
    leftRows.forEach(function (row, index) { var id = stringOrEmpty(row.messageId).trim(); if (id) leftById.set(id, { row: row, index: index }); });
    rightRows.forEach(function (row, index) { var id = stringOrEmpty(row.messageId).trim(); if (id) rightById.set(id, { row: row, index: index }); });
    leftById.forEach(function (entry, id) {
      var other = rightById.get(id);
      if (!other) return;
      leftUsed.add(entry.index);
      rightUsed.add(other.index);
      if (JSON.stringify([entry.row.chatPk, entry.row.senderPk, entry.row.timestamp, entry.row.contentType, stringOrEmpty(entry.row.text)]) !== JSON.stringify([other.row.chatPk, other.row.senderPk, other.row.timestamp, other.row.contentType, stringOrEmpty(other.row.text)])) {
        changes.push({ status: "changed", confidence: "exact", key: "id:" + id, left: entry.row, right: other.row });
      }
    });

    function pairByKey(includeText, confidence) {
      var leftMap = new Map();
      var rightMap = new Map();
      leftRows.forEach(function (row, index) { if (!leftUsed.has(index)) { var key = browserDiffKey(row, includeText); if (!leftMap.has(key)) leftMap.set(key, []); leftMap.get(key).push({ row: row, index: index }); } });
      rightRows.forEach(function (row, index) { if (!rightUsed.has(index)) { var key = browserDiffKey(row, includeText); if (!rightMap.has(key)) rightMap.set(key, []); rightMap.get(key).push({ row: row, index: index }); } });
      leftMap.forEach(function (leftEntries, key) {
        var rightEntries = rightMap.get(key) || [];
        if (!rightEntries.length) return;
        if (leftEntries.length !== 1 || rightEntries.length !== 1) {
          changes.push({ status: "ambiguous", confidence: "ambiguous", key: key, left: leftEntries[0].row, right: rightEntries[0].row });
          return;
        }
        leftUsed.add(leftEntries[0].index);
        rightUsed.add(rightEntries[0].index);
        if (!includeText && stringOrEmpty(leftEntries[0].row.text) !== stringOrEmpty(rightEntries[0].row.text)) {
          changes.push({ status: "changed", confidence: confidence, key: key, left: leftEntries[0].row, right: rightEntries[0].row });
        }
      });
    }

    // A regenerated message ID can still be aligned when the stable fields and
    // text agree; only the identity confidence changes from exact to inferred.
    pairByKey(true, "inferred");
    pairByKey(false, "inferred");
    leftRows.forEach(function (row, index) { if (!leftUsed.has(index)) changes.push({ status: "present_only_in_left", confidence: "unresolved", key: browserDiffKey(row, true), left: row }); });
    rightRows.forEach(function (row, index) { if (!rightUsed.has(index)) changes.push({ status: "added", confidence: "unresolved", key: browserDiffKey(row, true), right: row }); });
    return changes.slice(0, 100);
  }

  function renderBrowserDiff(changes, leftCount, rightCount) {
    if (!changes.length) {
      el.diffResults.innerHTML = '<span class="empty-state">兩份資料庫目前沒有可辨識的差異。</span>';
      return;
    }
    el.diffResults.innerHTML = '<div class="diff-summary">顯示前 ' + formatNumber(changes.length) + ' 項差異 · left ' + formatNumber(leftCount) + ' · right ' + formatNumber(rightCount) + '</div>' + changes.map(function (change) {
      var row = change.right || change.left;
      var text = stringOrEmpty(row && row.text).slice(0, 120);
      return '<article class="diff-item"><strong>' + escapeHtml({ added: "右側新增", present_only_in_left: "左側存在", changed: "內容變更" }[change.status] || change.status) + '</strong><span>' + escapeHtml(text || "（沒有文字內容）") + '</span><small>' + escapeHtml(change.confidence + " · " + formatDate(normalizeTimestamp(row && row.timestamp), true)) + '</small></article>';
    }).join("");
  }

  function updateStats() {
    el.chatCount.textContent = formatNumber(state.chats.filter(chatHasMessages).length);
    el.messageCount.textContent = formatNumber(state.chats.reduce(function (sum, chat) { return sum + chat.humanMessageCount; }, 0));
    el.attachmentCount.textContent = formatNumber(state.attachmentFiles.length);
    el.sourceSize.textContent = formatBytes(state.sourceSize);
  }

  function exportCurrentHtml() {
    if (!state.currentChat) return;
    var messages = loadAllMessagesForExport();
    var html = buildChatHtml(state.currentChat, messages);
    downloadText(slugify(state.currentChat.title) + ".html", html, "text/html;charset=utf-8");
  }

  function exportCurrentJson() {
    if (!state.currentChat) return;
    var messages = loadAllMessagesForExport();
    var payload = {
      schemaVersion: "0.1",
      exportedAt: new Date().toISOString(),
      source: state.sourceMode === "database" ? "LINE Messages/Line.sqlite" : (state.indexMode ? "LINE CLI reader index" : (state.squareDatabase ? "LINE Messages/Line.sqlite + Messages/LineSquare.sqlite" : "LINE iOS App Container")),
      sourceMode: state.sourceMode,
      conversation: state.currentChat,
      messages: messages.map(sanitizeMessageForExport)
    };
    downloadText(slugify(state.currentChat.title) + ".json", JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
  }

  function loadAllMessagesForExport() {
    if (state.indexMode) return state.currentMessages.slice();
    return loadAllMessagesForChat(state.currentChat);
  }

  function loadAllMessagesForChat(chat) {
    if (!chat) return [];
    var messages = [];
    ["line", "square"].forEach(function (source) {
      var reference = chat.sourceChats && chat.sourceChats[source];
      if (!reference || !databaseForSource(source)) return;
      var rows = safeQuerySource(
        source,
      "SELECT m.Z_PK AS messagePk, m.ZID AS messageId, m.ZTIMESTAMP AS timestamp, " +
      "m.ZSENDER AS senderPk, m.ZSENDSTATUS AS sendStatus, m.ZCONTENTTYPE AS contentType, m.ZTEXT AS text, " +
      "m.ZMESSAGETYPE AS messageType, m.ZLATITUDE AS latitude, m.ZLONGITUDE AS longitude, " +
      "m.ZCONTENTMETADATA AS contentMetadata, m.ZCHAT AS chatPk " +
      "FROM ZMESSAGE m WHERE m.ZCHAT = $chatPk ORDER BY COALESCE(m.ZTIMESTAMP, 0) ASC, m.Z_PK ASC",
        { $chatPk: reference.pk }
      );
      messages = messages.concat(rows.map(function (row) { return mapMessage(row, source); }));
    });
    return messages.sort(compareMessages);
  }

  function buildChatHtml(chat, messages) {
    var body = messages.map(function (message) {
      var content = message.call
        ? '<p class="message-call' + (isUnansweredCall(message.call) ? " unanswered" : "") + '">☎︎ ' + escapeHtml(formatCallLabel(message.call, message.isSelf)) + '</p>'
        : (message.text ? '<p class="message-text">' + linkifyMessageHtml(message.text) + '</p>' : '<p class="message-kind">[' + escapeHtml(message.kind) + ']</p>');
      if (hasValidLocation(message)) {
        content += '<p class="coordinates">位置：' + escapeHtml(message.latitude + ", " + message.longitude) + '</p>';
      }
      content += buildLinkPreviewHtml(message.linkPreviews);
      if (message.attachments && message.attachments.length) {
        content += '<ul class="attachments">' + message.attachments.map(function (attachment) {
          return '<li>' + escapeHtml(attachment.name) + ' <span>(' + escapeHtml(formatBytes(attachment.size)) + ')</span></li>';
        }).join("") + '</ul>';
      }
      return '<article class="message ' + (message.isSystem ? "system" : (message.isSelf ? "self" : "")) + '"><header><strong>' + escapeHtml(message.sender) + '</strong><time>' + escapeHtml(formatDate(message.timestamp, true)) + '</time></header>' + content + '</article>';
    }).join("\n");
    var note = state.sourceMode === "database"
      ? "這份封存來自 Line.sqlite 只讀訊息模式；未載入附件檔案。"
      : (state.indexMode ? "這份封存來自 CLI 分片索引；瀏覽器沒有開啟原始大型 Line.sqlite。" : "附件在目前閱讀器中提供本機下載連結；匯出的單一 HTML 會保留附件名稱與大小。");
    return '<!doctype html><html lang="zh-Hant-TW"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escapeHtml(chat.title) + '</title><style>' + exportCss() + '</style><main><h1>' + escapeHtml(chat.title) + '</h1><p class="meta">' + escapeHtml(typeLabel(chat.type) + " · " + formatNumber(messages.length) + " 則訊息") + '</p><p class="note">' + escapeHtml(note) + '</p><section>' + body + '</section></main></html>';
  }

  function exportCss() {
    return "body{margin:0;padding:24px;background:#f3f5f7;color:#1f2937;font:16px/1.55 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}main{max-width:860px;margin:auto}h1{letter-spacing:-.03em}.meta,.note{color:#6b7280}.note{padding:10px 12px;border-radius:10px;background:#fff}.message{max-width:78%;margin:12px 0;padding:10px 12px;border:1px solid #e5e7eb;border-radius:12px;background:#fff}.message.self{margin-left:auto;border-color:#99f6e4;background:#f0fdfa}.message.system{margin-left:auto;margin-right:auto;border-style:dashed;color:#6b7280;background:#f8fafc}.message header{display:flex;gap:12px;justify-content:space-between;color:#6b7280;font-size:.78rem}.message-text{white-space:pre-wrap;overflow-wrap:anywhere}.message-text a{color:#0f766e;text-decoration:underline}.message-call{margin:0;font-weight:700;color:#0f766e}.message-call.unanswered{color:#b45309}.message-kind{color:#92400e}.coordinates{color:#6b7280;font-size:.8rem}.link-previews{display:grid;gap:8px;margin-top:9px}.link-preview{display:grid;grid-template-columns:minmax(0,1fr) 132px;overflow:hidden;border:1px solid #dbe4ea;border-radius:10px;color:inherit;text-decoration:none;background:#f8fafc}.link-preview.no-image{grid-template-columns:minmax(0,1fr)}.link-preview-content{min-width:0;padding:9px 10px}.link-preview-domain{display:block;color:#64748b;font-size:.72rem;text-transform:uppercase}.link-preview-title{display:block;margin-top:2px;font-weight:750}.link-preview-summary{display:-webkit-box;overflow:hidden;margin-top:3px;color:#64748b;font-size:.78rem;-webkit-box-orient:vertical;-webkit-line-clamp:2}.link-preview img{width:132px;height:100%;min-height:96px;object-fit:cover;background:#e2e8f0}.attachments{margin:8px 0 0;padding-left:20px;color:#0f766e}.attachments span{color:#6b7280}";
  }

  function clearWorkspace(resetInput) {
    if (state.database) {
      try { state.database.close(); } catch (error) { console.warn(error); }
    }
    if (state.squareDatabase) {
      try { state.squareDatabase.close(); } catch (error) { console.warn(error); }
    }
    state.database = null;
    state.squareDatabase = null;
    state.lineDatabasePath = "";
    state.sqlReady = false;
    state.files = [];
    state.fileByPath = new Map();
    state.indexFiles = [];
    state.indexManifest = null;
    state.indexConversations = [];
    state.indexParticipants = [];
    state.indexMode = false;
    state.capabilities = null;
    state.health = null;
    state.chats = [];
    state.chatPage = 1;
    state.users.clear();
    state.squareUsers.clear();
    state.groupsById.clear();
    state.groupsByPk.clear();
    state.unifiedGroupsById.clear();
    state.squareGroupsById.clear();
    state.groupNamesByChatPk.clear();
    state.chatsByKey.clear();
    state.chatsBySourcePk.clear();
    state.currentChat = null;
    state.currentMessages = [];
    state.currentOffset = 0;
    state.currentAfterTimestamp = 0;
    state.currentAfterPk = 0;
    state.currentCursors = { line: { timestamp: 0, pk: 0 }, square: { timestamp: 0, pk: 0 } };
    state.attachmentFiles = [];
    state.attachmentByBasename = new Map();
    state.attachmentByMessageId = new Map();
    state.attachmentByToken = new Map();
    state.attachmentContextByPath = new Map();
    state.attachmentReviewItems = [];
    state.attachmentReviewByPath = new Map();
    state.attachmentCleanupGroups = [];
    state.selectedAttachmentCleanupGroup = "";
    state.attachmentCleanupPage = 1;
    state.attachmentCleanupSearch = "";
    state.attachmentKindFilter = "all";
    state.attachmentCategoryFilter = "all";
    state.attachmentSort = "recent";
    state.attachmentsMarkedForRemoval = new Set();
    state.attachmentDuplicateGroups = [];
    revokeObjectUrls();
    revokeCleanupPreviewUrls();
    state.selfId = "";
    state.sourceSize = 0;
    if (resetInput !== false && el.folderInput) el.folderInput.value = "";
    if (resetInput !== false && el.databaseInput) el.databaseInput.value = "";
    if (resetInput !== false && el.indexInput) el.indexInput.value = "";
    if (el.workspace) el.workspace.classList.add("hidden");
    if (el.diffPanel) el.diffPanel.classList.add("hidden");
    if (el.chatList) el.chatList.innerHTML = "";
    if (el.chatSearch) el.chatSearch.value = "";
    if (el.chatPageInfo) el.chatPageInfo.textContent = "第 1 頁";
    if (el.chatPrevButton) el.chatPrevButton.disabled = true;
    if (el.chatNextButton) el.chatNextButton.disabled = true;
    if (el.messageList) el.messageList.innerHTML = '<div class="empty-state">尚未選取聊天室。</div>';
    if (el.attachmentSearch) el.attachmentSearch.value = "";
    if (el.attachmentKindFilter) el.attachmentKindFilter.value = "all";
    if (el.attachmentCategoryFilter) el.attachmentCategoryFilter.value = "all";
    if (el.attachmentSort) el.attachmentSort.value = "recent";
    if (el.attachmentCategorySummary) el.attachmentCategorySummary.innerHTML = "";
    if (el.cleanupResultInfo) el.cleanupResultInfo.textContent = "";
    if (el.attachmentCleanupList) el.attachmentCleanupList.innerHTML = "";
    if (el.attachmentPageInfo) el.attachmentPageInfo.textContent = "第 1 頁";
    if (el.attachmentPrevButton) el.attachmentPrevButton.disabled = true;
    if (el.attachmentNextButton) el.attachmentNextButton.disabled = true;
    if (el.exportCleanupPlanButton) el.exportCleanupPlanButton.disabled = true;
    if (el.exportCleanupTextButton) el.exportCleanupTextButton.disabled = true;
    if (el.buildImazingCandidateButton) el.buildImazingCandidateButton.disabled = true;
    packageInProgress = false;
    setCleanupPackageStatus("瘦身 .imazingapp 會保留未標記的 Container／Payload 檔案，尚未經 iMazing 實機驗證。", false);
    if (el.markedAttachmentCount) el.markedAttachmentCount.textContent = "0";
    if (el.markedAttachmentSize) el.markedAttachmentSize.textContent = "0 B";
    if (el.exportHtmlButton) el.exportHtmlButton.disabled = true;
    if (el.exportJsonButton) el.exportJsonButton.disabled = true;
    if (el.runHealthButton) el.runHealthButton.disabled = true;
    if (el.globalSearchButton) el.globalSearchButton.disabled = true;
    if (el.globalSearchInput) el.globalSearchInput.value = "";
    if (el.searchEngineBadge) el.searchEngineBadge.textContent = "未啟用";
    if (el.globalSearchResults) el.globalSearchResults.innerHTML = '<span class="empty-state">輸入關鍵字後搜尋所有聊天室。</span>';
    if (el.runTimelineButton) el.runTimelineButton.disabled = true;
    if (el.timelineSummary) el.timelineSummary.innerHTML = '<span class="empty-state">選取聊天室後分析長間隔與訊息高峰。</span>';
    if (el.schemaTableSelect) el.schemaTableSelect.innerHTML = '<option value="">載入後選取</option>';
    if (el.schemaExplorer) el.schemaExplorer.innerHTML = '<span class="empty-state">顯示欄位、索引與遮罩後的範例資料。</span>';
    if (el.capabilitySummary) el.capabilitySummary.textContent = "尚未探測 SQLite 功能";
    if (el.healthSummary) el.healthSummary.innerHTML = '<span class="empty-state">載入資料後顯示健檢結果。</span>';
    if (el.scanAttachmentDuplicatesButton) el.scanAttachmentDuplicatesButton.disabled = true;
    if (el.duplicateStatus) el.duplicateStatus.textContent = "只會對相同大小的候選檔案計算 SHA-256；不會自動刪除。";
    if (el.duplicateResults) el.duplicateResults.innerHTML = "";
    if (el.selectedChatTitle) el.selectedChatTitle.textContent = "選取聊天室";
    if (el.selectedChatMeta) el.selectedChatMeta.textContent = "請從左側選取聊天室開始。";
    if (el.selectedChatEvidence) el.selectedChatEvidence.innerHTML = "";
    if (el.messageStatus) el.messageStatus.textContent = "";
    if (el.chatCount) el.chatCount.textContent = "—";
    if (el.messageCount) el.messageCount.textContent = "—";
    if (el.attachmentCount) el.attachmentCount.textContent = "—";
    if (el.sourceSize) el.sourceSize.textContent = "—";
    if (el.progressBar) setProgress(0);
    if (el.runtimeBadge) setRuntime("等待選取", false);
  }

  function safeQuery(sql, params) {
    try {
      return query(sql, params);
    } catch (error) {
      console.warn("SQL query failed", sql, error);
      return [];
    }
  }

  function buildAttachmentIndex() {
    state.attachmentByBasename = new Map();
    state.attachmentByMessageId = new Map();
    state.attachmentByToken = new Map();
    state.attachmentFiles.forEach(function (file) {
      var path = relativePath(file);
      var basename = normalizeFileName(fileNameOf(path));
      if (basename) addToIndex(state.attachmentByBasename, basename, file);
      var messageIdMatch = basename.match(/^(\d{8,})(?:[_.-]|$)/);
      if (messageIdMatch) addToIndex(state.attachmentByMessageId, messageIdMatch[1], file);
      // Directory names contain the chat MID. Indexing the whole path would
      // make every message in that chat look related to every attachment.
      // Token matching is only useful when the token is part of the file name.
      extractInternalTokens(basename).forEach(function (token) {
        addToIndex(state.attachmentByToken, token, file);
      });
    });
  }

  function addToIndex(index, key, file) {
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(file);
  }

  function extractAttachmentHints(blob, messageId) {
    var strings = extractBinaryPlistStrings(blob);
    var hints = [];
    strings.forEach(function (value) {
      var cleaned = value.replace(/[\u0000\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008\u000b\u000c\u000e\u000f]/g, "").trim();
      var extensionPattern = "jpg|jpeg|png|gif|webp|heic|mp4|mov|m4a|mp3|aac|caf|amr|pdf|zip|xlsx|xls|doc|docx|txt|csv|webm";
      var extensionOnly = cleaned.match(new RegExp("^(" + extensionPattern + ")$", "i"));
      var filenameMatch = cleaned.match(new RegExp("([A-Za-z0-9_\\-\\u0080-\\uFFFF .()]{3,180}\\.((?:" + extensionPattern + ")))(?:[^A-Za-z0-9]|$)", "i"));
      var detectedExtension = extensionOnly ? extensionOnly[1] : (filenameMatch ? filenameMatch[2] : "");
      if (messageId && detectedExtension) {
        var generatedName = messageId + "." + detectedExtension.toLowerCase();
        if (hints.indexOf(generatedName) === -1) hints.push(generatedName);
      }
      var uriMatch = cleaned.match(/(?:file|https?):\/\/[^\s"']+/i);
      var candidate = uriMatch ? uriMatch[0].split(/[?#]/)[0] : (filenameMatch ? filenameMatch[1] : cleaned);
      var basename = fileNameOf(candidate).replace(/[._-]+$/g, "");
      if (!basename || !/\.[A-Za-z0-9]{1,8}$/.test(basename)) return;
      if (!/\.(?:jpg|jpeg|png|gif|webp|heic|mp4|mov|m4a|mp3|aac|caf|amr|pdf|zip|xlsx|xls|doc|docx|txt|csv|webm)$/i.test(basename)) return;
      if (hints.indexOf(basename) === -1) hints.push(basename);
    });
    return hints;
  }

  function extractBinaryPlistStrings(blob) {
    if (!blob) return [];
    var bytes = blob instanceof Uint8Array ? blob : (blob.buffer ? new Uint8Array(blob.buffer, blob.byteOffset || 0, blob.byteLength) : null);
    if (!bytes || !bytes.length) return [];
    var decoded = [];
    ["utf-8", "utf-16be", "utf-16le"].forEach(function (encoding) {
      try { decoded.push(new TextDecoder(encoding).decode(bytes)); } catch (error) { /* optional decoder */ }
    });
    var values = [];
    var ascii = "";
    function flushAscii() {
      var value = ascii.trim();
      if (value.length >= 3 && value.length <= 512) values.push(value);
      ascii = "";
    }
    for (var i = 0; i < bytes.length; i += 1) {
      if (bytes[i] >= 32 && bytes[i] <= 126) ascii += String.fromCharCode(bytes[i]);
      else flushAscii();
    }
    flushAscii();
    decoded.forEach(function (text) {
      text.split(/[\u0000-\u001f\u007f]+/).forEach(function (part) {
        var value = part.trim();
        if (value.length >= 3 && value.length <= 512) values.push(value);
      });
    });
    return Array.from(new Set(values));
  }

  function extractBinaryPlistObjectStrings(blob) {
    var bytes = toUint8Array(blob);
    if (!bytes || bytes.length < 40) return [];
    var header = "";
    for (var headerIndex = 0; headerIndex < 8; headerIndex += 1) header += String.fromCharCode(bytes[headerIndex]);
    if (header !== "bplist00") return [];

    var trailerOffset = bytes.length - 32;
    var offsetSize = bytes[trailerOffset + 6];
    var objectCount = readBigEndianNumber(bytes, trailerOffset + 8, 8);
    var offsetTableOffset = readBigEndianNumber(bytes, trailerOffset + 24, 8);
    if (!offsetSize || !objectCount || objectCount > 100000 || offsetTableOffset >= bytes.length) return [];

    var strings = [];
    for (var objectIndex = 0; objectIndex < objectCount; objectIndex += 1) {
      var tableEntry = offsetTableOffset + objectIndex * offsetSize;
      if (tableEntry + offsetSize > trailerOffset) break;
      var objectOffset = readBigEndianNumber(bytes, tableEntry, offsetSize);
      if (objectOffset < 8 || objectOffset >= offsetTableOffset) continue;
      var marker = bytes[objectOffset];
      var objectType = marker >> 4;
      if (objectType !== 5 && objectType !== 6 && objectType !== 7) continue;
      var lengthInfo = binaryPlistLength(bytes, objectOffset, marker & 15);
      if (!lengthInfo || lengthInfo.length < 1 || lengthInfo.length > 4096) continue;
      try {
        var byteLength = objectType === 6 ? lengthInfo.length * 2 : lengthInfo.length;
        if (lengthInfo.dataOffset + byteLength > bytes.length) continue;
        var encoding = objectType === 6 ? "utf-16be" : "utf-8";
        strings.push(new TextDecoder(encoding).decode(bytes.slice(lengthInfo.dataOffset, lengthInfo.dataOffset + byteLength)));
      } catch (error) { /* Ignore malformed optional metadata strings. */ }
    }
    return strings;
  }

  function binaryPlistLength(bytes, objectOffset, compactLength) {
    if (compactLength < 15) return { length: compactLength, dataOffset: objectOffset + 1 };
    var lengthMarkerOffset = objectOffset + 1;
    if (lengthMarkerOffset >= bytes.length || bytes[lengthMarkerOffset] >> 4 !== 1) return null;
    var integerSize = Math.pow(2, bytes[lengthMarkerOffset] & 15);
    if (integerSize > 8 || lengthMarkerOffset + 1 + integerSize > bytes.length) return null;
    return {
      length: readBigEndianNumber(bytes, lengthMarkerOffset + 1, integerSize),
      dataOffset: lengthMarkerOffset + 1 + integerSize
    };
  }

  function readBigEndianNumber(bytes, offset, length) {
    var value = 0;
    for (var index = 0; index < length; index += 1) value = value * 256 + bytes[offset + index];
    return value;
  }

  function parseBinaryPropertyList(blob) {
    var bytes = toUint8Array(blob);
    if (!bytes || bytes.length < 40) return null;
    var header = "";
    for (var headerIndex = 0; headerIndex < 8; headerIndex += 1) header += String.fromCharCode(bytes[headerIndex]);
    if (header !== "bplist00") return null;

    var trailerOffset = bytes.length - 32;
    var offsetSize = bytes[trailerOffset + 6];
    var objectRefSize = bytes[trailerOffset + 7];
    var objectCount = readBigEndianNumber(bytes, trailerOffset + 8, 8);
    var topObject = readBigEndianNumber(bytes, trailerOffset + 16, 8);
    var offsetTableOffset = readBigEndianNumber(bytes, trailerOffset + 24, 8);
    if (!offsetSize || !objectRefSize || !objectCount || objectCount > 100000 || topObject >= objectCount || offsetTableOffset >= trailerOffset) return null;

    var offsets = [];
    for (var offsetIndex = 0; offsetIndex < objectCount; offsetIndex += 1) {
      var tableEntry = offsetTableOffset + offsetIndex * offsetSize;
      if (tableEntry + offsetSize > trailerOffset) return null;
      offsets.push(readBigEndianNumber(bytes, tableEntry, offsetSize));
    }

    var cache = new Array(objectCount);
    var parsed = new Array(objectCount).fill(false);

    function parseObject(objectIndex) {
      if (objectIndex < 0 || objectIndex >= objectCount) return null;
      if (parsed[objectIndex]) return cache[objectIndex];
      var objectOffset = offsets[objectIndex];
      if (objectOffset < 8 || objectOffset >= offsetTableOffset) return null;
      var marker = bytes[objectOffset];
      var objectType = marker >> 4;
      var compactLength = marker & 15;
      var lengthInfo;
      var byteLength;
      var value;
      var cursor;
      var itemIndex;

      if (objectType === 0) {
        value = compactLength === 9 ? true : (compactLength === 8 ? false : null);
      } else if (objectType === 1) {
        byteLength = Math.pow(2, compactLength);
        value = byteLength <= 8 && objectOffset + 1 + byteLength <= bytes.length
          ? readBigEndianNumber(bytes, objectOffset + 1, byteLength)
          : null;
      } else if (objectType === 2) {
        byteLength = Math.pow(2, compactLength);
        try {
          var dataView = new DataView(bytes.buffer, bytes.byteOffset + objectOffset + 1, byteLength);
          value = byteLength === 4 ? dataView.getFloat32(0, false) : (byteLength === 8 ? dataView.getFloat64(0, false) : null);
        } catch (error) { value = null; }
      } else if (objectType === 3 && compactLength === 3) {
        try {
          value = new Date((new DataView(bytes.buffer, bytes.byteOffset + objectOffset + 1, 8).getFloat64(0, false) + 978307200) * 1000);
        } catch (error) { value = null; }
      } else if (objectType === 4 || objectType === 5 || objectType === 6 || objectType === 7) {
        lengthInfo = binaryPlistLength(bytes, objectOffset, compactLength);
        if (!lengthInfo) return null;
        byteLength = objectType === 6 ? lengthInfo.length * 2 : lengthInfo.length;
        if (lengthInfo.dataOffset + byteLength > bytes.length) return null;
        if (objectType === 4) {
          value = bytes.slice(lengthInfo.dataOffset, lengthInfo.dataOffset + byteLength);
        } else {
          try {
            value = new TextDecoder(objectType === 6 ? "utf-16be" : "utf-8").decode(bytes.slice(lengthInfo.dataOffset, lengthInfo.dataOffset + byteLength));
          } catch (error) { value = ""; }
        }
      } else if (objectType === 8) {
        byteLength = compactLength + 1;
        value = objectOffset + 1 + byteLength <= bytes.length
          ? { __plistUid: readBigEndianNumber(bytes, objectOffset + 1, byteLength) }
          : null;
      } else if (objectType === 10 || objectType === 11 || objectType === 12) {
        lengthInfo = binaryPlistLength(bytes, objectOffset, compactLength);
        if (!lengthInfo || lengthInfo.dataOffset + lengthInfo.length * objectRefSize > bytes.length) return null;
        value = [];
        parsed[objectIndex] = true;
        cache[objectIndex] = value;
        cursor = lengthInfo.dataOffset;
        for (itemIndex = 0; itemIndex < lengthInfo.length; itemIndex += 1) {
          value.push(parseObject(readBigEndianNumber(bytes, cursor + itemIndex * objectRefSize, objectRefSize)));
        }
        return value;
      } else if (objectType === 13) {
        lengthInfo = binaryPlistLength(bytes, objectOffset, compactLength);
        if (!lengthInfo || lengthInfo.dataOffset + lengthInfo.length * objectRefSize * 2 > bytes.length) return null;
        value = {};
        parsed[objectIndex] = true;
        cache[objectIndex] = value;
        cursor = lengthInfo.dataOffset;
        for (itemIndex = 0; itemIndex < lengthInfo.length; itemIndex += 1) {
          var keyRef = readBigEndianNumber(bytes, cursor + itemIndex * objectRefSize, objectRefSize);
          var valueRef = readBigEndianNumber(bytes, cursor + (lengthInfo.length + itemIndex) * objectRefSize, objectRefSize);
          var key = parseObject(keyRef);
          if (typeof key === "string") value[key] = parseObject(valueRef);
        }
        return value;
      } else {
        value = null;
      }

      parsed[objectIndex] = true;
      cache[objectIndex] = value;
      return value;
    }

    return parseObject(topObject);
  }

  function decodeKeyedArchive(blob) {
    var archive = parseBinaryPropertyList(blob);
    if (!archive || !Array.isArray(archive.$objects) || !archive.$top) return null;
    var objects = archive.$objects;
    var resolvedCache = new Map();

    function resolve(value, depth) {
      if (depth > 60 || value === null || value === undefined || value === "$null") return null;
      if (value && typeof value === "object" && Number.isInteger(value.__plistUid)) {
        var objectIndex = value.__plistUid;
        if (objectIndex < 0 || objectIndex >= objects.length) return null;
        if (resolvedCache.has(objectIndex)) return resolvedCache.get(objectIndex);
        var resolvedObject = resolve(objects[objectIndex], depth + 1);
        resolvedCache.set(objectIndex, resolvedObject);
        return resolvedObject;
      }
      if (Array.isArray(value)) return value.map(function (item) { return resolve(item, depth + 1); });
      if (value instanceof Uint8Array || value instanceof Date || typeof value !== "object") return value;

      if (Array.isArray(value["NS.keys"]) && Array.isArray(value["NS.objects"])) {
        var dictionary = {};
        var keys = resolve(value["NS.keys"], depth + 1) || [];
        var values = resolve(value["NS.objects"], depth + 1) || [];
        keys.forEach(function (key, index) {
          if (typeof key === "string") dictionary[key] = values[index];
        });
        return dictionary;
      }
      if (Array.isArray(value["NS.objects"])) return resolve(value["NS.objects"], depth + 1);

      var object = {};
      Object.keys(value).forEach(function (key) {
        if (key !== "$class") object[key] = resolve(value[key], depth + 1);
      });
      return object;
    }

    return resolve(archive.$top.root, 0);
  }

  function extractCallInfo(contentType, blob, text, latitude, longitude) {
    if (Number(contentType) !== 6) return null;
    var strings = extractBinaryPlistObjectStrings(blob);
    var knownResults = ["NO_RESPONSE", "CANCELED", "REJECTED", "NORMAL", "BUSY"];
    var result = "UNKNOWN";
    for (var resultIndex = 0; resultIndex < knownResults.length; resultIndex += 1) {
      if (strings.indexOf(knownResults[resultIndex]) !== -1) {
        result = knownResults[resultIndex];
        break;
      }
    }

    var isGroup = strings.some(function (value) {
      return value.indexOf("GroupCall") !== -1 || value === "GC_CHAT_MID" || value === "GC_EVT_TYPE";
    });
    var media = strings.indexOf("V") !== -1 || strings.indexOf("VIDEO") !== -1 ? "video" : "audio";
    var durations = strings.filter(function (value) { return /^\d{1,10}$/.test(value); }).map(Number).filter(function (value) {
      return value >= 1000 && value <= 86400000;
    });
    var durationMs = durations.length ? Math.max.apply(Math, durations) : 0;
    var legacyText = stringOrEmpty(text).match(/Call History\s*:\s*(\d+)\s*millisecs,\s*Result:\s*(\d+)/i);
    if (legacyText) {
      durationMs = Number(legacyText[1]) || 0;
      if (result === "UNKNOWN") result = durationMs > 0 ? "NORMAL" : "NO_RESPONSE";
    } else if (!durationMs) {
      var legacyDuration = numberOrNull(latitude);
      if (legacyDuration !== null && legacyDuration >= 1000) durationMs = legacyDuration;
    }
    if (result === "UNKNOWN" && durationMs > 0) result = "NORMAL";

    return {
      media: media,
      result: result,
      durationMs: durationMs,
      isGroup: isGroup,
      legacyCode: legacyText ? Number(legacyText[2]) : numberOrNull(longitude)
    };
  }

  function formatCallLabel(call, isSelf) {
    var medium = call.media === "video" ? "視訊" : "語音";
    if (call.isGroup) {
      return "群組" + medium + "通話" + (call.durationMs ? " · " + formatCallDuration(call.durationMs) : "");
    }
    if (call.result === "NORMAL") {
      return medium + "通話" + (call.durationMs ? " · " + formatCallDuration(call.durationMs) : "");
    }
    if (call.result === "NO_RESPONSE") return isSelf ? "對方未接" + medium + "通話" : "未接" + (medium === "視訊" ? "視訊來電" : "來電");
    if (call.result === "CANCELED") return isSelf ? "已取消" + medium + "通話" : "未接" + (medium === "視訊" ? "視訊來電" : "來電");
    if (call.result === "BUSY") return isSelf ? "對方忙線中" : "忙線中";
    if (call.result === "REJECTED") return isSelf ? "對方拒絕" + medium + "通話" : "已拒絕" + (medium === "視訊" ? "視訊來電" : "來電");
    return medium + "通話";
  }

  function formatCallDuration(milliseconds) {
    var seconds = Math.max(0, Math.round(Number(milliseconds) / 1000));
    var minutes = Math.floor(seconds / 60);
    var remainder = seconds % 60;
    if (!minutes) return remainder + " 秒";
    return minutes + " 分 " + remainder + " 秒";
  }

  function isUnansweredCall(call) {
    return call && call.result !== "NORMAL" && call.result !== "UNKNOWN";
  }

  function safeHttpUrl(value) {
    try {
      var parsed = new URL(String(value || "").trim());
      return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "";
    } catch (error) {
      return "";
    }
  }

  function trimUrlMatch(value) {
    var trimmed = String(value || "");
    while (/[.,!?;:，。！？；：、》】」』]$/.test(trimmed)) trimmed = trimmed.slice(0, -1);
    [["(", ")"], ["[", "]"], ["{", "}"]].forEach(function (pair) {
      while (trimmed.endsWith(pair[1]) && trimmed.split(pair[0]).length < trimmed.split(pair[1]).length) {
        trimmed = trimmed.slice(0, -1);
      }
    });
    return trimmed;
  }

  function findHttpUrls(text) {
    var source = stringOrEmpty(text);
    var pattern = /https?:\/\/[^\s<>"']+/gi;
    var matches = [];
    var seen = new Set();
    var match;
    while ((match = pattern.exec(source)) !== null) {
      var raw = trimUrlMatch(match[0]);
      var href = safeHttpUrl(raw);
      if (!href) continue;
      var key = href.replace(/#.*$/, "");
      matches.push({ href: href, text: raw, start: match.index, end: match.index + raw.length, duplicate: seen.has(key) });
      seen.add(key);
    }
    return matches;
  }

  function previewDomain(url, fallback) {
    try { return new URL(url).hostname.replace(/^www\./i, "") || stringOrEmpty(fallback); }
    catch (error) { return stringOrEmpty(fallback); }
  }

  function youtubeVideoId(url) {
    try {
      var parsed = new URL(url);
      var host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
      var id = "";
      if (host === "youtu.be") id = parsed.pathname.split("/").filter(Boolean)[0] || "";
      else if (host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com") {
        if (parsed.pathname === "/watch") id = parsed.searchParams.get("v") || "";
        else if (/^\/(?:shorts|live|embed)\//.test(parsed.pathname)) id = parsed.pathname.split("/")[2] || "";
      }
      return /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : "";
    } catch (error) {
      return "";
    }
  }

  function normalizeLinkPreviewImage(value, url) {
    var candidate = stringOrEmpty(value).trim();
    if (candidate.indexOf("//") === 0) candidate = "https:" + candidate;
    else if (candidate.charAt(0) === "/") candidate = "https://obs.line-scdn.net" + candidate;
    var safeCandidate = safeHttpUrl(candidate);
    if (safeCandidate) return safeCandidate;
    var videoId = youtubeVideoId(url);
    return videoId ? "https://i.ytimg.com/vi/" + videoId + "/hqdefault.jpg" : "";
  }

  function createLinkPreview(url, model) {
    var href = safeHttpUrl(url);
    if (!href) return null;
    var data = model && typeof model === "object" ? model : {};
    var domain = firstNonEmpty(data.domain, previewDomain(href), "連結");
    var videoId = youtubeVideoId(href);
    return {
      url: href,
      domain: domain,
      title: firstNonEmpty(data.Title, videoId ? "YouTube 影片" : domain),
      summary: firstNonEmpty(data.Summary, href),
      image: normalizeLinkPreviewImage(data.ThumbnailURLString, href),
      isVideo: Boolean(data.isVideo || videoId)
    };
  }

  function extractLinkPreviews(blob, text, contentType) {
    var urlMatches = findHttpUrls(text);
    if (!urlMatches.length && Number(contentType) !== 107) return [];
    var previews = [];
    var seen = new Set();
    var archive = decodeKeyedArchive(blob);
    var models = archive && archive.NLURLScrapModelsKey;
    if (models && !Array.isArray(models)) models = [models];
    (models || []).forEach(function (model) {
      var url = model && firstNonEmpty(model.URLString, model.redirectedURLString);
      var preview = createLinkPreview(url, model);
      if (!preview) return;
      var key = preview.url.replace(/#.*$/, "");
      if (!seen.has(key)) previews.push(preview);
      seen.add(key);
    });
    urlMatches.forEach(function (match) {
      var key = match.href.replace(/#.*$/, "");
      if (seen.has(key) || match.duplicate) return;
      var preview = createLinkPreview(match.href, null);
      if (preview) previews.push(preview);
      seen.add(key);
    });
    return previews.slice(0, 4);
  }

  function appendLinkedText(container, text) {
    var source = stringOrEmpty(text);
    var matches = findHttpUrls(source);
    var cursor = 0;
    matches.forEach(function (match) {
      if (match.start > cursor) container.appendChild(document.createTextNode(source.slice(cursor, match.start)));
      var link = document.createElement("a");
      link.href = match.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.referrerPolicy = "no-referrer";
      link.textContent = source.slice(match.start, match.end);
      container.appendChild(link);
      cursor = match.end;
    });
    if (cursor < source.length) container.appendChild(document.createTextNode(source.slice(cursor)));
  }

  function appendLinkPreviews(card, previews) {
    if (!previews || !previews.length) return;
    var list = document.createElement("div");
    list.className = "link-previews";
    previews.forEach(function (previewData) {
      var preview = document.createElement("a");
      preview.className = "link-preview" + (previewData.image ? "" : " no-image");
      preview.href = previewData.url;
      preview.target = "_blank";
      preview.rel = "noopener noreferrer";
      preview.referrerPolicy = "no-referrer";

      var content = document.createElement("span");
      content.className = "link-preview-content";
      var domain = document.createElement("span");
      domain.className = "link-preview-domain";
      domain.textContent = previewData.domain;
      var title = document.createElement("strong");
      title.className = "link-preview-title";
      title.textContent = previewData.title;
      var summary = document.createElement("span");
      summary.className = "link-preview-summary";
      summary.textContent = previewData.summary;
      content.appendChild(domain);
      content.appendChild(title);
      content.appendChild(summary);
      preview.appendChild(content);

      if (previewData.image) {
        var image = document.createElement("img");
        image.src = previewData.image;
        image.alt = "";
        image.loading = "lazy";
        image.decoding = "async";
        image.referrerPolicy = "no-referrer";
        image.addEventListener("error", function () {
          preview.classList.add("no-image");
          image.remove();
        });
        preview.appendChild(image);
      }
      list.appendChild(preview);
    });
    card.appendChild(list);
  }

  function linkifyMessageHtml(text) {
    var source = stringOrEmpty(text);
    var matches = findHttpUrls(source);
    var parts = [];
    var cursor = 0;
    matches.forEach(function (match) {
      if (match.start > cursor) parts.push(escapeHtml(source.slice(cursor, match.start)));
      parts.push('<a href="' + escapeHtml(match.href) + '" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">' + escapeHtml(source.slice(match.start, match.end)) + '</a>');
      cursor = match.end;
    });
    if (cursor < source.length) parts.push(escapeHtml(source.slice(cursor)));
    return parts.join("");
  }

  function buildLinkPreviewHtml(previews) {
    if (!previews || !previews.length) return "";
    return '<div class="link-previews">' + previews.map(function (preview) {
      var image = preview.image
        ? '<img src="' + escapeHtml(preview.image) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">'
        : "";
      return '<a class="link-preview' + (preview.image ? "" : " no-image") + '" href="' + escapeHtml(preview.url) + '" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"><span class="link-preview-content"><span class="link-preview-domain">' + escapeHtml(preview.domain) + '</span><strong class="link-preview-title">' + escapeHtml(preview.title) + '</strong><span class="link-preview-summary">' + escapeHtml(preview.summary) + '</span></span>' + image + '</a>';
    }).join("") + '</div>';
  }

  function resolveAttachments(blob, messageId, extractedHints) {
    var hints = extractedHints || extractAttachmentHints(blob, messageId);
    var candidates = [];
    var messageIdFiles = state.attachmentByMessageId.get(messageId) || [];
    var chatScopedFiles = messageIdFiles.filter(function (file) {
      return state.currentChat && relativePath(file).indexOf("/" + state.currentChat.id + "/") !== -1;
    });
    var directFiles = chatScopedFiles.length ? chatScopedFiles : messageIdFiles;
    var directStatus = chatScopedFiles.length || directFiles.length === 1 ? "exact" : "ambiguous";
    directFiles.forEach(function (file) {
      // A LINE image commonly has both a Message Thumbnails file and a full
      // Message Attachments file with the same message ID. Multiple variants
      // inside the selected chat are still an exact match, not an ambiguity.
      candidates.push({file: file, status: directStatus, hint: messageId});
    });
    hints.forEach(function (hint) {
      var files = state.attachmentByBasename.get(normalizeFileName(hint)) || [];
      files.forEach(function (file) {
        candidates.push({file: file, status: files.length === 1 ? "exact" : "ambiguous", hint: hint});
      });
    });
    var tokens = extractInternalTokens(extractBinaryPlistStrings(blob).join(" "));
    tokens.forEach(function (token) {
      (state.attachmentByToken.get(token) || []).forEach(function (file) {
        candidates.push({file: file, status: "token", hint: token});
      });
    });
    var unique = new Map();
    candidates.forEach(function (candidate) {
      var path = relativePath(candidate.file);
      if (!unique.has(path) || unique.get(path).status === "token") unique.set(path, candidate);
    });
    return Array.from(unique.values()).slice(0, 8).map(function (candidate) {
      return {
        name: candidate.file.name,
        path: relativePath(candidate.file),
        size: candidate.file.size,
        mime: candidate.file.type || "",
        linkStatus: candidate.status,
        hint: candidate.hint
      };
    });
  }

  function appendAttachmentLinks(card, attachments) {
    if (!attachments || !attachments.length) return;
    var list = document.createElement("ul");
    list.className = "message-attachments";
    attachments.forEach(function (attachment) {
      var file = state.fileByPath.get(attachment.path);
      var item = document.createElement("li");
      if (file) {
        var link = document.createElement("a");
        link.href = createObjectUrl(file);
        link.download = file.name;
        link.textContent = file.name + " (" + formatBytes(file.size) + ")";
        link.title = attachment.linkStatus === "ambiguous" ? "檔名重複，這是可能的附件" : "下載原始附件";
        item.appendChild(link);
      } else {
        item.textContent = attachment.name;
      }
      if (attachment.linkStatus !== "exact") {
        var status = document.createElement("small");
        status.textContent = " · " + (attachment.linkStatus === "ambiguous" ? "可能附件" : "候選附件");
        item.appendChild(status);
      }
      list.appendChild(item);
    });
    card.appendChild(list);
  }

  function appendImagePreviews(card, message) {
    var exactAttachments = (message.attachments || []).filter(function (attachment) {
      return attachment.linkStatus === "exact";
    });
    var originalImages = exactAttachments.filter(function (attachment) {
      return !isThumbnailAttachment(attachment) && isImageAttachment(attachment);
    });
    var thumbnailImages = exactAttachments.filter(function (attachment) {
      return isThumbnailAttachment(attachment) && isImageAttachment(attachment);
    });
    var images = (originalImages.length ? originalImages : thumbnailImages).slice(0, 4);
    var media = null;

    images.forEach(function (attachment) {
      var file = state.fileByPath.get(attachment.path);
      if (!file) return;
      if (!media) {
        media = document.createElement("div");
        media.className = "message-media";
      }
      media.appendChild(createImagePreview(
        createObjectUrl(file),
        attachment.name,
        isThumbnailAttachment(attachment) ? "備份中的縮圖" : "開啟原始圖片"
      ));
    });

    if ((!media || !media.childNodes.length) && isImageContentType(message.contentType) && message.thumbnail && message.thumbnail.length) {
      var mime = detectImageMime(message.thumbnail);
      if (mime) {
        media = document.createElement("div");
        media.className = "message-media";
        media.appendChild(createImagePreview(
          createObjectUrl(new Blob([message.thumbnail], { type: mime })),
          "訊息圖片縮圖",
          "備份資料庫內的縮圖"
        ));
      }
    }

    if (media && media.childNodes.length) card.appendChild(media);
  }

  function createImagePreview(url, alt, captionText) {
    var figure = document.createElement("figure");
    figure.className = "message-image";
    var button = document.createElement("button");
    button.type = "button";
    button.className = "message-image-button";
    button.title = "放大預覽圖片";
    button.setAttribute("aria-label", "放大預覽：" + (alt || "LINE 圖片"));
    var image = document.createElement("img");
    image.src = url;
    image.alt = alt || "LINE 圖片";
    // The message panel is its own scroll container. Some browsers never
    // activate native lazy loading for images deeper in that container.
    image.loading = "eager";
    image.decoding = "async";
    image.addEventListener("error", function () {
      figure.classList.add("preview-error");
      image.alt = "這個圖片格式無法由瀏覽器直接顯示";
    });
    button.addEventListener("click", function () {
      showImageModal(url, alt, captionText, button);
    });
    button.appendChild(image);
    figure.appendChild(button);
    var caption = document.createElement("figcaption");
    caption.textContent = captionText;
    figure.appendChild(caption);
    return figure;
  }

  function isImageAttachment(attachment) {
    return /^image\/(?:jpe?g|png|gif|webp|bmp|avif)$/i.test(attachment.mime || "") || /\.(?:jpe?g|png|gif|webp|bmp|avif|thumb)$/i.test(attachment.name || "");
  }

  function isThumbnailAttachment(attachment) {
    return /\.thumb$/i.test(attachment.name || "") || /\/Message Thumbnails\//.test(attachment.path || "");
  }

  function isImageContentType(contentType) {
    var code = Number(contentType);
    return code === 1 || code === 16 || code === 112;
  }

  function isLocationContentType(contentType) {
    return Number(contentType) === 100;
  }

  function hasValidLocation(message) {
    if (!message || message.call || !isLocationContentType(message.contentType)) return false;
    var latitude = Number(message.latitude);
    var longitude = Number(message.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
    if (Math.abs(latitude) < 0.000001 && Math.abs(longitude) < 0.000001) return false;
    return latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
  }

  function detectImageMime(bytes) {
    if (!bytes || bytes.length < 4) return "";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
    if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
    return "";
  }

  function createObjectUrl(blob) {
    var url = URL.createObjectURL(blob);
    state.objectUrls.add(url);
    return url;
  }

  function revokeObjectUrls() {
    state.objectUrls.forEach(function (url) { URL.revokeObjectURL(url); });
    state.objectUrls.clear();
  }

  function sanitizeMessageForExport(message) {
    return {
      pk: message.pk,
      id: message.id,
      timestampRaw: message.timestampRaw,
      timestamp: message.timestamp ? message.timestamp.toISOString() : null,
      senderId: message.senderId,
      sender: message.sender,
      isSelf: message.isSelf,
      isSystem: message.isSystem,
      sendStatus: message.sendStatus,
      contentType: message.contentType,
      messageType: message.messageType,
      kind: message.kind,
      call: message.call,
      text: message.text,
      latitude: message.latitude,
      longitude: message.longitude,
      linkPreviews: message.linkPreviews,
      attachmentHints: message.attachmentHints,
      attachments: message.attachments,
      provenance: message.provenance || null
    };
  }

  function fileNameOf(path) {
    var normalized = String(path || "").replace(/\\/g, "/").split(/[?#]/)[0];
    var pieces = normalized.split("/");
    return pieces[pieces.length - 1] || "";
  }

  function normalizeFileName(name) {
    return String(name || "").trim().normalize("NFKC").toLowerCase();
  }

  function extractInternalTokens(value) {
    var matches = String(value || "").match(/(?:u[a-f0-9]{32}|c[a-f0-9]{32})/gi) || [];
    return Array.from(new Set(matches.map(function (match) { return match.toLowerCase(); })));
  }

  function messageKind(contentType, messageType, text) {
    if (text) return "text";
    var code = Number(contentType);
    var known = { 1: "image", 2: "video", 3: "audio", 4: "file", 5: "sticker", 6: "call", 7: "system", 9: "contact", 12: "poll", 13: "call", 14: "file", 16: "image", 17: "video", 18: "system", 96: "system", 100: "location", 101: "sticker", 107: "link", 111: "system", 112: "image" };
    return known[code] || (messageType || "unknown");
  }

  function typeLabel(type) {
    return { direct: "單人聊天室", group: "群組聊天室", community: "社群", unknown: "未知類型" }[type] || "聊天室";
  }

  function chatTypeLabel(chatType) {
    if (Number(chatType) === 0) return "direct";
    if (Number(chatType) === 4 || Number(chatType) === 100) return "community";
    if (Number(chatType) === 1 || Number(chatType) === 2) return "group";
    return "unknown";
  }

  function titleSourceLabel(source) {
    return {
      user: "LINE 使用者資料",
      "line-square": "LineSquare.sqlite 社群名稱",
      "unified-group": "UnifiedGroup.sqlite 目前名稱",
      rename: "群組改名系統訊息",
      group: "LINE 群組資料",
      unresolved: "尚未找到可靠名稱"
    }[source] || "未知來源";
  }


  function toUint8Array(value) {
    if (value instanceof Uint8Array) return value;
    if (value && value.buffer && Number.isFinite(value.byteLength)) {
      return new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength);
    }
    if (Array.isArray(value)) return new Uint8Array(value);
    return null;
  }

  function normalizeTimestamp(value) {
    var number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return null;
    if (number < 100000000000) number *= 1000;
    var date = new Date(number);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatDate(date, includeTime) {
    if (!date) return "未知時間";
    return new Intl.DateTimeFormat("zh-TW", includeTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "short" }).format(date);
  }

  function formatNumber(value) {
    return new Intl.NumberFormat("zh-TW").format(Number(value) || 0);
  }

  function formatBytes(bytes) {
    var value = Number(bytes) || 0;
    if (value < 1024) return value + " B";
    var units = ["KB", "MB", "GB", "TB"];
    var index = -1;
    do { value /= 1024; index += 1; } while (value >= 1024 && index < units.length - 1);
    return value.toFixed(value >= 10 ? 1 : 2) + " " + units[index];
  }

  function stringOrEmpty(value) { return value === null || value === undefined ? "" : String(value); }
  function numberOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    var number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  function firstNonEmpty() {
    for (var i = 0; i < arguments.length; i += 1) if (arguments[i] !== null && arguments[i] !== undefined && String(arguments[i]).trim()) return String(arguments[i]);
    return "";
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? "" : value).replace(/[&<>\"']/g, function (character) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[character];
    });
  }

  function slugify(value) {
    return String(value || "chat").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 80) || "chat";
  }

  function downloadText(filename, content, type) {
    var blob = new Blob([content], { type: type });
    downloadBlob(filename, blob);
  }

  function downloadBlob(filename, blob) {
    var url = URL.createObjectURL(blob);
    var anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
}());
