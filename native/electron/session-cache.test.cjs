"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  CACHE_VERSION_FILE,
  clearSessionCache,
  listSessionCaches,
  outputFallsInsideSession,
  prepareSessionCache,
  sessionWorkDir
} = require("./session-cache.cjs");

function fileFingerprint(filePath) {
  const metadata = fs.statSync(filePath, { bigint: true });
  const bytes = Buffer.alloc(8);
  const modified = Buffer.alloc(8);
  bytes.writeBigUInt64LE(metadata.size);
  modified.writeBigInt64LE(metadata.mtimeNs);
  return crypto.createHash("sha256").update(bytes).update(modified).digest("hex");
}

function temporaryUserData(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "line-cheater-cache-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("keeps same-version and compatible caches but rebuilds incompatible versions", (t) => {
  const userData = temporaryUserData(t);
  const source = path.join(userData, "source.imazingapp");
  const first = prepareSessionCache(userData, source, "1.2.3");
  assert.equal(first.recreated, true);
  assert.equal(
    fs.readFileSync(path.join(first.workDir, CACHE_VERSION_FILE), "utf8").trim(),
    "1.2.3"
  );
  const retained = path.join(first.workDir, "catalog.sqlite");
  fs.writeFileSync(retained, "derived cache");

  const same = prepareSessionCache(userData, source, "1.2.3");
  assert.equal(same.recreated, false);
  assert.equal(same.migrated, false);
  assert.equal(fs.readFileSync(retained, "utf8"), "derived cache");

  const compatible = prepareSessionCache(userData, source, "1.2.4", ["1.2.3"]);
  assert.equal(compatible.recreated, false);
  assert.equal(compatible.migrated, true);
  assert.equal(fs.readFileSync(retained, "utf8"), "derived cache");
  assert.equal(
    fs.readFileSync(path.join(compatible.workDir, CACHE_VERSION_FILE), "utf8").trim(),
    "1.2.4"
  );

  const upgraded = prepareSessionCache(userData, source, "1.2.5");
  assert.equal(upgraded.recreated, true);
  assert.equal(upgraded.migrated, false);
  assert.equal(fs.existsSync(retained), false);
  assert.equal(
    fs.readFileSync(path.join(upgraded.workDir, CACHE_VERSION_FILE), "utf8").trim(),
    "1.2.5"
  );
});

test("only clears hashed session directories and detects unsafe candidate outputs", (t) => {
  const userData = temporaryUserData(t);
  const source = path.join(userData, "source.imazingapp");
  const workDir = sessionWorkDir(userData, source);
  prepareSessionCache(userData, source, "1.0.0");
  assert.equal(
    outputFallsInsideSession(workDir, path.join(workDir, "candidate.imazingapp")),
    true
  );
  assert.equal(
    outputFallsInsideSession(workDir, path.join(userData, "candidate.imazingapp")),
    false
  );
  assert.throws(
    () => clearSessionCache(userData, path.join(userData, "sessions")),
    /outside the managed session cache/
  );
  clearSessionCache(userData, workDir);
  assert.equal(fs.existsSync(workDir), false);
});

test("discovers reusable analyzed sessions and validates their original source", (t) => {
  const { DatabaseSync } = require("node:sqlite");
  const userData = temporaryUserData(t);
  const source = path.join(userData, "LINE.imazingapp");
  fs.writeFileSync(source, "archive source");
  const { workDir } = prepareSessionCache(userData, source, "1.2.5");
  const database = new DatabaseSync(path.join(workDir, "catalog.sqlite"));
  database.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE files (attachment_kind TEXT);
  `);
  const insert = database.prepare("INSERT INTO meta(key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries({
    source_path: path.resolve(source),
    source_kind: "ImazingArchive",
    source_fingerprint: fileFingerprint(source),
    scan_status: "complete",
    context_status: "complete",
    context_index_version: "5",
    scan_completed_at: "1234"
  })) {
    insert.run(key, value);
  }
  database.exec("INSERT INTO files VALUES ('original'), ('thumbnail'), (NULL)");
  database.close();

  let sessions = listSessionCaches(userData, "1.2.6", ["1.2.5"]);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionPath, workDir);
  assert.equal(sessions[0].sourcePath, path.resolve(source));
  assert.equal(sessions[0].sourceKind, "archive");
  assert.equal(sessions[0].attachmentCount, 2);
  assert.equal(sessions[0].versionCompatible, true);
  assert.equal(sessions[0].sourceCurrent, true);
  assert.equal(sessions[0].reusable, true);

  const staleCatalog = new DatabaseSync(path.join(workDir, "catalog.sqlite"));
  staleCatalog.prepare(
    "UPDATE meta SET value = '4' WHERE key = 'context_index_version'"
  ).run();
  staleCatalog.close();
  sessions = listSessionCaches(userData, "1.2.6", ["1.2.5"]);
  assert.equal(sessions[0].reusable, false);
  assert.match(sessions[0].unavailableReason, /格式需要更新/);

  const currentCatalog = new DatabaseSync(path.join(workDir, "catalog.sqlite"));
  currentCatalog.prepare(
    "UPDATE meta SET value = '5' WHERE key = 'context_index_version'"
  ).run();
  currentCatalog.close();

  fs.appendFileSync(source, " changed");
  sessions = listSessionCaches(userData, "1.2.6", ["1.2.5"]);
  assert.equal(sessions[0].sourceCurrent, false);
  assert.equal(sessions[0].reusable, false);
  assert.match(sessions[0].unavailableReason, /已變更/);

  fs.rmSync(source);
  sessions = listSessionCaches(userData, "1.2.6", ["1.2.5"]);
  assert.equal(sessions[0].sourceExists, false);
  assert.match(sessions[0].unavailableReason, /不存在/);
});
