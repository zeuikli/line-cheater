"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const sourceKinds = new Set(["directory", "archive", "sqlite"]);
const eventNames = new Set([
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

contextBridge.exposeInMainWorld("lineNativeBridge", Object.freeze({
  selectSource(kind) {
    if (!sourceKinds.has(kind)) return Promise.reject(new TypeError("Invalid source kind."));
    return ipcRenderer.invoke("line-native:select-source", kind);
  },
  chooseCandidateOutput() {
    return ipcRenderer.invoke("line-native:choose-candidate-output");
  },
  chooseExportOutput() {
    return ipcRenderer.invoke("line-native:choose-export-output");
  },
  chooseConversationOutput() {
    return ipcRenderer.invoke("line-native:choose-conversation-output");
  },
  discardCandidateOutput(token) {
    if (typeof token !== "string" || !token) {
      return Promise.reject(new TypeError("Invalid candidate output token."));
    }
    return ipcRenderer.invoke("line-native:discard-candidate-output", token);
  },
  cancelOperation() {
    return ipcRenderer.invoke("line-native:cancel-operation");
  },
  attachmentPreviewUrl(path) {
    if (typeof path !== "string" || !path || new TextEncoder().encode(path).length > 4096) {
      return Promise.reject(new TypeError("Invalid attachment preview path."));
    }
    return ipcRenderer.invoke("line-native:attachment-preview", path);
  },
  openExternal(value) {
    if (typeof value !== "string" || new TextEncoder().encode(value).length > 4096) {
      return Promise.reject(new TypeError("Invalid external URL."));
    }
    let url;
    try {
      url = new URL(value);
    } catch {
      return Promise.reject(new TypeError("Invalid external URL."));
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      return Promise.reject(new TypeError("Only credential-free HTTP(S) URLs can be opened."));
    }
    return ipcRenderer.invoke("line-native:open-external", url.href);
  },
  request(method, params) {
    if (typeof method !== "string" || !method) {
      return Promise.reject(new TypeError("A sidecar method is required."));
    }
    return ipcRenderer.invoke("line-native:request", method, params || {});
  },
  on(eventName, handler) {
    if (!eventNames.has(eventName) || typeof handler !== "function") {
      throw new TypeError("Invalid native event subscription.");
    }
    const listener = (_event, value) => {
      if (value && value.event === eventName) handler(value);
    };
    ipcRenderer.on("line-native:event", listener);
    return () => ipcRenderer.removeListener("line-native:event", listener);
  }
}));
