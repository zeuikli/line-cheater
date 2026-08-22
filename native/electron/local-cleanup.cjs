"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const DEFAULT_INVENTORY_TTL_MS = 15 * 60 * 1000;
const CACHE_ROOTS = Object.freeze([
  ["Sticker", "stickers"],
  ["Sticon", "sticons"],
  ["ChatEffect", "chat-effects"],
  ["bgChat", "chat-backgrounds"],
  ["advertisement", "advertisements"],
  ["resource", "resources"],
  ["sound", "sounds"],
  ["pizza", "media-cache"]
]);

function localError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isDirectoryWithoutLink(target) {
  try {
    const metadata = fs.lstatSync(target);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

function discoverLineProfile(options = {}) {
  const platform = options.platform || process.platform;
  const home = path.resolve(options.home || os.homedir());
  const env = options.env || process.env;
  let candidates = [];
  if (platform === "darwin") {
    candidates = [path.join(
      home,
      "Library", "Containers", "jp.naver.line.mac", "Data",
      "Library", "Containers", "jp.naver.line", "Data"
    )];
  } else if (platform === "win32") {
    const roots = [env.LOCALAPPDATA, env.APPDATA]
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => path.resolve(value));
    for (const root of roots) {
      candidates.push(path.join(root, "LINE", "Data"));
      candidates.push(path.join(root, "LINE"));
    }
  } else {
    return null;
  }
  const found = candidates.find(isDirectoryWithoutLink);
  if (!found) return null;
  return {
    platform,
    profileRoot: fs.realpathSync(found),
    displayPath: found
  };
}

function isRecognizedLineProcess(platform, processInfo) {
  const name = String(processInfo && processInfo.name || "");
  const executable = String(processInfo && processInfo.executable || "");
  if (platform === "darwin") {
    if (name !== "LINE" && !/^LINE Helper(?: \([^)]+\))?$/.test(name)) return false;
    return /\/LINE\.app\/Contents\/(?:MacOS|Frameworks)\//.test(executable);
  }
  if (platform === "win32") {
    if (name.toLowerCase() !== "line.exe") return false;
    return !executable || /[\\/]LINE[\\/]/i.test(executable);
  }
  return false;
}

async function listLineProcesses(platform = process.platform) {
  if (platform === "darwin") {
    const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,comm="]);
    return stdout.split(/\r?\n/).flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!match) return [];
      const executable = match[2];
      const name = path.basename(executable);
      return [{ pid: Number(match[1]), name, executable }];
    }).filter((entry) => isRecognizedLineProcess(platform, entry));
  }
  if (platform === "win32") {
    const { stdout } = await execFileAsync("tasklist.exe", [
      "/FI", "IMAGENAME eq LINE.exe", "/FO", "CSV", "/NH"
    ], { windowsHide: true });
    return stdout.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^"([^"]+)","(\d+)"/);
      if (!match) return [];
      return [{ pid: Number(match[2]), name: match[1], executable: "" }];
    }).filter((entry) => isRecognizedLineProcess(platform, entry));
  }
  return [];
}

async function requestLineQuit(platform = process.platform, options = {}) {
  if (platform === "darwin") {
    const running = await (options.listProcesses || (() => listLineProcesses(platform)))();
    const killProcess = options.killProcess || ((pid) => process.kill(pid, "SIGTERM"));
    for (const entry of running.filter((item) => isRecognizedLineProcess(platform, item))) {
      if (Number.isSafeInteger(entry.pid) && entry.pid > 1) killProcess(entry.pid);
    }
    return;
  }
  if (platform === "win32") {
    const run = options.execFile || execFileAsync;
    await run("taskkill.exe", ["/IM", "LINE.exe"], { windowsHide: true });
  }
}

async function ensureLineClosed(options = {}) {
  const platform = options.platform || process.platform;
  const listProcesses = options.listProcesses || (() => listLineProcesses(platform));
  const confirmQuit = options.confirmQuit;
  const quit = options.requestQuit || (() => requestLineQuit(platform));
  const wait = options.wait || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const attempts = Number.isSafeInteger(options.attempts) ? options.attempts : 10;
  if (typeof confirmQuit !== "function") throw new TypeError("A LINE quit confirmation callback is required.");
  const running = (await listProcesses()).filter((entry) => isRecognizedLineProcess(platform, entry));
  if (!running.length) return true;
  if (!await confirmQuit(running)) return false;
  await quit();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!(await listProcesses()).some((entry) => isRecognizedLineProcess(platform, entry))) return true;
    await wait(500);
  }
  throw localError("line_did_not_quit", "LINE 尚未完全關閉，LINE Cheater 不會讀取或刪除其資料。");
}

function localCleanupCapabilities() {
  return {
    localDeletion: { supported: ["darwin", "win32"].includes(process.platform) },
    cloudDeletion: {
      supported: false,
      canClaimRemoteDeletion: false,
      reason: "LINE 沒有提供消費者桌面聊天記錄的官方 authenticated deletion API；本機快取刪除不代表雲端刪除。"
    }
  };
}

function pathFallsInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function fingerprint(metadata) {
  return `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}`;
}

function publicItem(record) {
  return {
    id: record.id,
    name: path.basename(record.relativePath),
    relativePath: record.relativePath,
    category: record.category,
    bytes: record.bytes,
    modifiedAt: record.modifiedAt
  };
}

class LocalCleanupManager {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.profile = options.profile || discoverLineProfile({ platform: this.platform });
    this.listProcesses = options.listProcesses || (() => listLineProcesses(this.platform));
    this.trashItem = options.trashItem;
    this.now = options.now || (() => Date.now());
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.inventoryTtlMs = options.inventoryTtlMs || DEFAULT_INVENTORY_TTL_MS;
    this.inventories = new Map();
    if (typeof this.trashItem !== "function") {
      throw new TypeError("LocalCleanupManager requires a trashItem implementation.");
    }
  }

  async assertLineClosed() {
    const running = (await this.listProcesses())
      .filter((entry) => isRecognizedLineProcess(this.platform, entry));
    if (running.length) {
      throw localError("line_running", "請先完全關閉 LINE，才能掃描或刪除本機資料。");
    }
  }

  profileRoot() {
    if (!this.profile || !isDirectoryWithoutLink(this.profile.profileRoot)) {
      throw localError("profile_not_found", "找不到可安全讀取的 LINE 桌面版資料夾。");
    }
    return fs.realpathSync(this.profile.profileRoot);
  }

  async scan() {
    await this.assertLineClosed();
    const profileRoot = this.profileRoot();
    const records = [];
    for (const [directoryName, category] of CACHE_ROOTS) {
      const categoryRoot = path.join(profileRoot, directoryName);
      if (!isDirectoryWithoutLink(categoryRoot)) continue;
      const realCategoryRoot = fs.realpathSync(categoryRoot);
      if (!pathFallsInside(profileRoot, realCategoryRoot)) continue;
      await this.walkCategory(profileRoot, realCategoryRoot, category, records);
    }
    await this.assertLineClosed();
    records.sort((left, right) => right.bytes - left.bytes || left.relativePath.localeCompare(right.relativePath));
    const token = this.randomUUID();
    this.inventories.clear();
    this.inventories.set(token, {
      createdAt: this.now(),
      profileRoot,
      records: new Map(records.map((record) => [record.id, record]))
    });
    const cloud = localCleanupCapabilities().cloudDeletion;
    return {
      token,
      platform: this.platform,
      profilePath: this.profile.displayPath || profileRoot,
      items: records.map(publicItem),
      totals: {
        files: records.length,
        bytes: records.reduce((total, record) => total + record.bytes, 0)
      },
      cloud
    };
  }

  async walkCategory(profileRoot, categoryRoot, category, records) {
    const pending = [categoryRoot];
    let visited = 0;
    while (pending.length) {
      const directory = pending.pop();
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          pending.push(target);
          continue;
        }
        if (!entry.isFile()) continue;
        const realPath = fs.realpathSync(target);
        if (!pathFallsInside(categoryRoot, realPath)) continue;
        const metadata = fs.lstatSync(realPath);
        if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
        const relativePath = path.relative(profileRoot, realPath);
        const signature = fingerprint(metadata);
        const id = crypto.createHash("sha256")
          .update(`${category}\0${relativePath}\0${signature}`)
          .digest("hex");
        records.push({
          id,
          absolutePath: realPath,
          categoryRoot,
          relativePath,
          category,
          bytes: metadata.size,
          modifiedAt: metadata.mtime.toISOString(),
          fingerprint: signature
        });
        visited += 1;
        if (visited % 256 === 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
    }
  }

  inventory(token) {
    const inventory = this.inventories.get(String(token || ""));
    if (!inventory || this.now() - inventory.createdAt > this.inventoryTtlMs) {
      if (inventory) this.inventories.delete(token);
      throw localError("inventory_expired", "本機掃描結果已失效，請重新掃描後再刪除。");
    }
    return inventory;
  }

  async deleteSelection(token, itemIds) {
    if (!Array.isArray(itemIds) || itemIds.length === 0 || itemIds.length > 100000) {
      throw new TypeError("A bounded, non-empty item selection is required.");
    }
    const inventory = this.inventory(token);
    const uniqueIds = new Set(itemIds.map(String));
    if (uniqueIds.size !== itemIds.length) throw new TypeError("Duplicate item IDs are not allowed.");
    const records = itemIds.map((id) => {
      if (!/^[0-9a-f]{64}$/.test(String(id))) throw new TypeError("Invalid local-cleanup item ID.");
      const record = inventory.records.get(String(id));
      if (!record) throw localError("unknown_item", "選取的本機檔案不在目前掃描結果中。");
      return record;
    });
    await this.assertLineClosed();
    for (const record of records) this.validateUnchanged(inventory, record);

    const failures = [];
    let deleted = 0;
    let bytes = 0;
    for (const record of records) {
      try {
        await this.trashItem(record.absolutePath);
        deleted += 1;
        bytes += record.bytes;
      } catch (error) {
        failures.push({ id: record.id, message: error.message });
      }
    }
    this.inventories.delete(token);
    return {
      local: { deleted, bytes, failures },
      cloud: {
        status: "unsupported",
        deleted: 0,
        reason: localCleanupCapabilities().cloudDeletion.reason
      }
    };
  }

  validateUnchanged(inventory, record) {
    const metadata = fs.lstatSync(record.absolutePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw localError("file_changed", "檔案類型在掃描後已變更，請重新掃描。");
    }
    const realPath = fs.realpathSync(record.absolutePath);
    if (!pathFallsInside(inventory.profileRoot, realPath) ||
        !pathFallsInside(record.categoryRoot, realPath) ||
        fingerprint(metadata) !== record.fingerprint) {
      throw localError("file_changed", "檔案在掃描後已變更，請重新掃描。");
    }
  }
}

module.exports = {
  CACHE_ROOTS,
  LocalCleanupManager,
  discoverLineProfile,
  ensureLineClosed,
  isRecognizedLineProcess,
  listLineProcesses,
  localCleanupCapabilities,
  requestLineQuit
};
