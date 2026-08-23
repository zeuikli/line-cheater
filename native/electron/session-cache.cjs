"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const CACHE_VERSION_FILE = ".line-cheater-cache-version";
const SESSION_KEY_PATTERN = /^[0-9a-f]{64}$/;
const CATALOG_FILE = "catalog.sqlite";
// Keep this aligned with native/core/src/catalog.rs.
const CONTEXT_INDEX_VERSION = "5";
const MAX_DISCOVERED_SESSIONS = 100;

function sessionRoot(userDataPath) {
  return path.resolve(userDataPath, "sessions");
}

function sessionWorkDir(userDataPath, sourcePath) {
  const source = path.resolve(sourcePath);
  const key = crypto.createHash("sha256").update(source).digest("hex");
  return path.join(sessionRoot(userDataPath), key);
}

function normalizeStoredSourcePath(sourcePath) {
  let normalized = String(sourcePath || "").trim();
  if (process.platform === "win32") {
    if (/^\\\\\?\\UNC\\/i.test(normalized)) {
      normalized = `\\\\${normalized.slice(8)}`;
    } else if (/^\\\\\?\\/.test(normalized)) {
      normalized = normalized.slice(4);
    }
  }
  return normalized ? path.resolve(normalized) : "";
}

function sourceKindFromCatalog(value) {
  return {
    Directory: "directory",
    ImazingArchive: "archive",
    Sqlite: "sqlite"
  }[String(value || "")] || null;
}

function fileSourceFingerprint(sourcePath) {
  const metadata = fs.statSync(sourcePath, { bigint: true });
  const bytes = Buffer.alloc(8);
  const modified = Buffer.alloc(8);
  bytes.writeBigUInt64LE(metadata.size);
  modified.writeBigInt64LE(metadata.mtimeNs);
  return crypto.createHash("sha256").update(bytes).update(modified).digest("hex");
}

function sessionUnavailableReason(session) {
  if (!session.versionCompatible) return `工作階段版本 ${session.cacheVersion || "未知"} 不相容`;
  if (!session.sourceExists) return "原始備份已移動或不存在";
  if (session.sourceCurrent === false) return "原始備份在分析後已變更";
  if (session.scanStatus !== "complete") return "附件掃描尚未完成";
  if (session.contextStatus !== "complete") return "SQLite 關聯分析尚未完成";
  if (session.contextIndexVersion !== CONTEXT_INDEX_VERSION) {
    return "工作階段分析格式需要更新";
  }
  return "";
}

function readSessionCache(userDataPath, sessionKey, appVersion, compatibleVersions = []) {
  if (!SESSION_KEY_PATTERN.test(sessionKey)) return null;
  const workDir = assertManagedSessionPath(
    userDataPath,
    path.join(sessionRoot(userDataPath), sessionKey)
  );
  const directory = fs.lstatSync(workDir);
  if (!directory.isDirectory() || directory.isSymbolicLink()) return null;
  const catalogPath = path.join(workDir, CATALOG_FILE);
  const catalogMetadata = fs.lstatSync(catalogPath);
  if (!catalogMetadata.isFile() || catalogMetadata.isSymbolicLink()) return null;

  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(catalogPath, { readOnly: true });
  let metadata;
  let attachmentCount;
  try {
    database.exec("PRAGMA query_only = ON");
    const rows = database.prepare(
      "SELECT key, value FROM meta WHERE key IN (" +
      "'source_path', 'source_kind', 'source_fingerprint', " +
      "'scan_status', 'context_status', 'context_index_version', 'scan_completed_at')"
    ).all();
    metadata = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    attachmentCount = Number(database.prepare(
      "SELECT COUNT(*) AS count FROM files WHERE attachment_kind IS NOT NULL"
    ).get().count) || 0;
  } finally {
    database.close();
  }

  const sourcePath = normalizeStoredSourcePath(metadata.source_path);
  const sourceKind = sourceKindFromCatalog(metadata.source_kind);
  if (!sourcePath || !sourceKind) return null;
  if (path.resolve(sessionWorkDir(userDataPath, sourcePath)) !== path.resolve(workDir)) return null;

  const cacheVersion = cachedVersion(workDir) || "";
  const versionCompatible = cacheVersion === appVersion ||
    compatibleVersions.includes(cacheVersion);
  let sourceExists = false;
  let sourceCurrent = null;
  let sourceBytes = 0;
  try {
    const sourceMetadata = fs.statSync(sourcePath, { bigint: true });
    sourceExists = sourceKind === "directory"
      ? sourceMetadata.isDirectory()
      : sourceMetadata.isFile();
    sourceBytes = sourceMetadata.isFile() ? Number(sourceMetadata.size) : 0;
    if (sourceExists && sourceKind !== "directory" && metadata.source_fingerprint) {
      sourceCurrent = fileSourceFingerprint(sourcePath) === metadata.source_fingerprint;
    }
  } catch {
    sourceExists = false;
  }

  const session = {
    id: sessionKey,
    sessionPath: workDir,
    sourcePath,
    sourceKind,
    sourceName: path.basename(sourcePath) || sourcePath,
    sourceBytes,
    sourceExists,
    sourceCurrent,
    cacheVersion,
    versionCompatible,
    scanStatus: metadata.scan_status || "not_started",
    contextStatus: metadata.context_status || "not_started",
    contextIndexVersion: metadata.context_index_version || "",
    scanCompletedAt: Number(metadata.scan_completed_at) || 0,
    attachmentCount,
    updatedAt: Math.floor(catalogMetadata.mtimeMs / 1000)
  };
  session.unavailableReason = sessionUnavailableReason(session);
  session.reusable = !session.unavailableReason;
  return session;
}

function listSessionCaches(userDataPath, appVersion, compatibleVersions = []) {
  const version = String(appVersion || "").trim();
  if (!version || /[\r\n]/.test(version)) {
    throw new TypeError("A valid LINE Cheater version is required for session discovery.");
  }
  if (!Array.isArray(compatibleVersions)) {
    throw new TypeError("Compatible cache versions must be an array.");
  }
  const root = sessionRoot(userDataPath);
  let entries;
  try {
    const metadata = fs.lstatSync(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return [];
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const sessions = [];
  for (const entry of entries
    .filter((item) => item.isDirectory() && SESSION_KEY_PATTERN.test(item.name))
    .slice(0, MAX_DISCOVERED_SESSIONS)) {
    try {
      const session = readSessionCache(
        userDataPath,
        entry.name,
        version,
        compatibleVersions
      );
      if (session) sessions.push(session);
    } catch {
      // A corrupt or partially-created cache must not hide other reusable sessions.
    }
  }
  sessions.sort((left, right) =>
    Number(right.reusable) - Number(left.reusable) ||
    right.scanCompletedAt - left.scanCompletedAt ||
    right.updatedAt - left.updatedAt ||
    left.sourcePath.localeCompare(right.sourcePath)
  );
  return sessions;
}

function assertManagedSessionPath(userDataPath, workDir) {
  const root = sessionRoot(userDataPath);
  const candidate = path.resolve(workDir);
  if (path.dirname(candidate) !== root ||
      !SESSION_KEY_PATTERN.test(path.basename(candidate))) {
    throw new Error("Refusing to modify a path outside the managed session cache.");
  }
  return candidate;
}

function clearSessionCache(userDataPath, workDir) {
  const candidate = assertManagedSessionPath(userDataPath, workDir);
  fs.rmSync(candidate, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100
  });
}

function cachedVersion(workDir) {
  try {
    if (fs.lstatSync(workDir).isSymbolicLink()) return null;
    const marker = path.join(workDir, CACHE_VERSION_FILE);
    if (!fs.lstatSync(marker).isFile()) return null;
    return fs.readFileSync(marker, "utf8").trim();
  } catch {
    return null;
  }
}

function writeVersionMarker(workDir, version) {
  const marker = path.join(workDir, CACHE_VERSION_FILE);
  const temporary = path.join(
    workDir,
    `${CACHE_VERSION_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  try {
    fs.writeFileSync(temporary, `${version}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    fs.rmSync(marker, { force: true });
    fs.renameSync(temporary, marker);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function prepareSessionCache(userDataPath, sourcePath, appVersion, compatibleVersions = []) {
  const version = String(appVersion || "").trim();
  if (!version || /[\r\n]/.test(version)) {
    throw new TypeError("A valid LINE Cheater version is required for session caching.");
  }
  if (!Array.isArray(compatibleVersions) ||
      compatibleVersions.some((item) => typeof item !== "string" || !item || /[\r\n]/.test(item))) {
    throw new TypeError("Compatible cache versions must be valid version strings.");
  }
  const workDir = sessionWorkDir(userDataPath, sourcePath);
  const previousVersion = cachedVersion(workDir);
  if (previousVersion === version) {
    return { workDir, recreated: false, migrated: false };
  }
  if (previousVersion && compatibleVersions.includes(previousVersion)) {
    writeVersionMarker(workDir, version);
    return { workDir, recreated: false, migrated: true };
  }
  clearSessionCache(userDataPath, workDir);
  fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
  writeVersionMarker(workDir, version);
  return { workDir, recreated: true, migrated: false };
}

function isWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`));
}

function outputFallsInsideSession(workDir, outputPath) {
  if (isWithin(workDir, outputPath)) return true;
  try {
    const realWorkDir = fs.realpathSync(workDir);
    const realOutputParent = fs.realpathSync(path.dirname(path.resolve(outputPath)));
    return isWithin(realWorkDir, path.join(realOutputParent, path.basename(outputPath)));
  } catch {
    return false;
  }
}

module.exports = {
  CACHE_VERSION_FILE,
  clearSessionCache,
  listSessionCaches,
  normalizeStoredSourcePath,
  outputFallsInsideSession,
  prepareSessionCache,
  readSessionCache,
  sessionWorkDir
};
