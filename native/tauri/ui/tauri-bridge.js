(function (root) {
  "use strict";

  if (!root.__TAURI__ || !root.__TAURI__.core) {
    throw new Error("The Tauri runtime is unavailable.");
  }

  var invoke = root.__TAURI__.core.invoke;
  var listen = root.__TAURI__.event.listen;
  var eventNames = new Set([
    "operationStarted",
    "sourcePrepareProgress",
    "searchIndexProgress",
    "catalogProgress",
    "catalogContextProgress",
    "cleanupMutationProgress",
    "exportProgress",
    "conversationExportProgress",
    "duplicateHashProgress",
    "candidateProgress"
  ]);

  function unsupported(name) {
    return invoke("unsupported_shell_action", { name: name });
  }

  function nativeInvoke(command, args) {
    return invoke(command, args).catch(function (reason) {
      var message = typeof reason === "string"
        ? reason
        : reason && reason.message
          ? String(reason.message)
          : String(reason || "Native operation failed.");
      var error = reason instanceof Error ? reason : new Error(message);
      if (message.includes("operation_cancelled")) {
        error.code = "operation_cancelled";
        error.message = "操作已取消。";
      }
      throw error;
    });
  }

  root.lineNativeBridge = Object.freeze({
    platformCapabilities: function () {
      return invoke("platform_capabilities");
    },
    localCleanupStatus: function () {
      return invoke("local_cleanup_status");
    },
    scanLocalCleanup: function () {
      return invoke("scan_local_cleanup");
    },
    deleteLocalSelection: function (token, itemIds) {
      return invoke("delete_local_selection", { token: token, itemIds: itemIds });
    },
    listSessions: function () {
      return invoke("list_sessions");
    },
    openSession: function (sessionId) {
      return nativeInvoke("open_saved_session", { sessionId: sessionId });
    },
    deleteSession: function (sessionId) {
      return invoke("delete_saved_session", { sessionId: sessionId });
    },
    selectSource: function (kind) {
      return nativeInvoke("select_source", { kind: kind });
    },
    chooseCandidateOutput: function () { return invoke("choose_candidate_output"); },
    chooseExportOutput: function () { return invoke("choose_export_output"); },
    chooseConversationOutput: function () { return invoke("choose_conversation_output"); },
    discardCandidateOutput: function (token) {
      return invoke("discard_candidate_output", { token: token });
    },
    finalizeCandidateSession: function (retainSession) {
      return invoke("finalize_candidate_session", { retainSession: retainSession });
    },
    cancelOperation: function () { return nativeInvoke("cancel_operation"); },
    attachmentPreviewUrl: function (path) {
      return invoke("attachment_preview", { path: path }).then(function (stagedPath) {
        return root.__TAURI__.core.convertFileSrc(stagedPath);
      });
    },
    openExternal: function (value) {
      return invoke("open_external", { value: value });
    },
    request: function (method, params) {
      return nativeInvoke("native_request", { method: method, params: params || {} });
    },
    on: function (eventName, handler) {
      if (!eventNames.has(eventName) || typeof handler !== "function") {
        throw new TypeError("Invalid native event subscription.");
      }
      var active = true;
      var unlisten = null;
      listen("line-native:event", function (event) {
        if (active && event.payload && event.payload.event === eventName) {
          handler(event.payload);
        }
      }).then(function (dispose) {
        if (active) unlisten = dispose;
        else dispose();
      });
      return function () {
        active = false;
        if (unlisten) unlisten();
      };
    }
  });

  document.addEventListener("DOMContentLoaded", function () {
    invoke("platform_capabilities").then(function (capabilities) {
      root.document.documentElement.dataset.platform = capabilities.platform;
      if (!capabilities.mobileImport || !capabilities.mobileImport.supported) return;
      var directory = root.document.querySelector('[data-source="directory"]');
      var localCleanup = root.document.querySelector(".local-cleanup-entry");
      if (directory) directory.hidden = true;
      if (localCleanup) {
        localCleanup.innerHTML = "";
        var heading = root.document.createElement("h3");
        heading.textContent = "手機版使用備份匯入";
        var explanation = root.document.createElement("p");
        explanation.textContent = "iOS／Android 不允許讀取 LINE 的私有資料夾；請用上方按鈕從系統檔案選擇器匯入你明確授權的備份。";
        localCleanup.append(heading, explanation);
      }
    }).catch(function () {
      // The normal source picker remains available if capability detection fails.
    });
  });
})(globalThis);
