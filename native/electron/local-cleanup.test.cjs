"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  LocalCleanupManager,
  discoverLineProfile,
  ensureLineClosed,
  isRecognizedLineProcess,
  localCleanupCapabilities,
  requestLineQuit
} = require("./local-cleanup.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "line-cheater-local-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, relativePath, contents = "fixture") {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}

test("recognizes only the real LINE desktop process", () => {
  assert.equal(isRecognizedLineProcess("darwin", { name: "LINE", executable: "/Applications/LINE.app/Contents/MacOS/LINE" }), true);
  assert.equal(isRecognizedLineProcess("darwin", { name: "LINE Helper", executable: "/Applications/LINE.app/Contents/Frameworks/LINE Helper" }), true);
  assert.equal(isRecognizedLineProcess("darwin", { name: "deadline", executable: "/tmp/deadline" }), false);
  assert.equal(isRecognizedLineProcess("win32", { name: "LINE.exe", executable: "C:\\Users\\me\\AppData\\Local\\LINE\\bin\\LINE.exe" }), true);
  assert.equal(isRecognizedLineProcess("win32", { name: "commandline.exe", executable: "C:\\tools\\commandline.exe" }), false);
});

test("discovers the fixed macOS sandbox profile and no broader fallback", (t) => {
  const home = fixture(t);
  const expected = path.join(home, "Library", "Containers", "jp.naver.line.mac", "Data", "Library", "Containers", "jp.naver.line", "Data");
  fs.mkdirSync(expected, { recursive: true });
  assert.equal(
    discoverLineProfile({ platform: "darwin", home, env: {} }).profileRoot,
    fs.realpathSync(expected)
  );

  fs.rmSync(expected, { recursive: true });
  assert.equal(discoverLineProfile({ platform: "darwin", home, env: {} }), null);
});

test("discovers Windows LocalAppData before RoamingAppData", (t) => {
  const root = fixture(t);
  const local = path.join(root, "Local");
  const roaming = path.join(root, "Roaming");
  const expected = path.join(local, "LINE", "Data");
  fs.mkdirSync(expected, { recursive: true });
  fs.mkdirSync(path.join(roaming, "LINE", "Data"), { recursive: true });
  assert.equal(discoverLineProfile({
    platform: "win32",
    home: root,
    env: { LOCALAPPDATA: local, APPDATA: roaming }
  }).profileRoot, fs.realpathSync(expected));
});

test("scan returns opaque IDs for allowlisted cache files and excludes databases", async (t) => {
  const root = fixture(t);
  write(root, path.join("Sticker", "100", "1", "preview.png"), "sticker");
  write(root, path.join("Sticon", "pack", "item.bin"), "sticon");
  write(root, path.join("db", "account.edb"), "do-not-touch");
  write(root, "setting.ini", "do-not-touch");

  const manager = new LocalCleanupManager({
    platform: "darwin",
    profile: { profileRoot: root },
    listProcesses: async () => [],
    trashItem: async () => {}
  });
  const inventory = await manager.scan();
  assert.equal(inventory.items.length, 2);
  assert.equal(inventory.items.every((item) => /^[0-9a-f]{64}$/.test(item.id)), true);
  assert.equal(inventory.items.some((item) => Object.hasOwn(item, "absolutePath")), false);
  assert.deepEqual(new Set(inventory.items.map((item) => item.category)), new Set(["stickers", "sticons"]));
  assert.equal(inventory.cloud.supported, false);
  assert.match(inventory.cloud.reason, /LINE/i);
});

test("scan and delete refuse to run while LINE is open", async (t) => {
  const root = fixture(t);
  write(root, path.join("Sticker", "item.png"));
  const process = { name: "LINE", executable: "/Applications/LINE.app/Contents/MacOS/LINE" };
  const manager = new LocalCleanupManager({
    platform: "darwin",
    profile: { profileRoot: root },
    listProcesses: async () => [process],
    trashItem: async () => assert.fail("must not trash while LINE is open")
  });
  await assert.rejects(manager.scan(), (error) => error.code === "line_running");
});

test("startup gate requests a graceful LINE quit and verifies the process exited", async () => {
  let running = true;
  let quitRequests = 0;
  const result = await ensureLineClosed({
    platform: "win32",
    listProcesses: async () => running
      ? [{ name: "LINE.exe", executable: "C:\\Users\\me\\AppData\\Local\\LINE\\bin\\LINE.exe" }]
      : [],
    confirmQuit: async () => true,
    requestQuit: async () => { quitRequests += 1; running = false; },
    wait: async () => {},
    attempts: 2
  });
  assert.equal(result, true);
  assert.equal(quitRequests, 1);
});

test("startup gate exits without touching LINE when the user refuses", async () => {
  let quitRequests = 0;
  const result = await ensureLineClosed({
    platform: "darwin",
    listProcesses: async () => [{ name: "LINE", executable: "/Applications/LINE.app/Contents/MacOS/LINE" }],
    confirmQuit: async () => false,
    requestQuit: async () => { quitRequests += 1; }
  });
  assert.equal(result, false);
  assert.equal(quitRequests, 0);
});

test("macOS quit signals only PIDs belonging to the verified LINE bundle", async () => {
  const signaled = [];
  await require("./local-cleanup.cjs").requestLineQuit("darwin", {
    listProcesses: async () => [
      { pid: 10, name: "LINE", executable: "/Applications/LINE.app/Contents/MacOS/LINE" },
      { pid: 11, name: "deadline", executable: "/tmp/deadline" }
    ],
    killProcess: (pid) => signaled.push(pid)
  });
  assert.deepEqual(signaled, [10]);
});

test("Windows quit targets only the exact LINE executable without forced termination", async () => {
  const calls = [];
  await requestLineQuit("win32", {
    execFile: async (...arguments_) => calls.push(arguments_)
  });
  assert.deepEqual(calls, [[
    "taskkill.exe",
    ["/IM", "LINE.exe"],
    { windowsHide: true }
  ]]);
});

test("deletion resolves opaque IDs, rechecks LINE, and moves exact unchanged files to trash", async (t) => {
  const root = fixture(t);
  const selected = write(root, path.join("Sticker", "selected.png"), "selected");
  const retained = write(root, path.join("Sticker", "retained.png"), "retained");
  const trashed = [];
  const manager = new LocalCleanupManager({
    platform: "darwin",
    profile: { profileRoot: root },
    listProcesses: async () => [],
    trashItem: async (target) => trashed.push(target)
  });
  const inventory = await manager.scan();
  const selectedItem = inventory.items.find((item) => item.name === "selected.png");
  const result = await manager.deleteSelection(inventory.token, [selectedItem.id]);
  assert.deepEqual(trashed, [fs.realpathSync(selected)]);
  assert.equal(result.local.deleted, 1);
  assert.equal(result.local.bytes, Buffer.byteLength("selected"));
  assert.equal(result.cloud.status, "unsupported");
  assert.equal(fs.existsSync(retained), true);
});

test("deletion rejects traversal IDs and files changed after scan", async (t) => {
  const root = fixture(t);
  const selected = write(root, path.join("Sticker", "selected.png"), "before");
  const manager = new LocalCleanupManager({
    platform: "darwin",
    profile: { profileRoot: root },
    listProcesses: async () => [],
    trashItem: async () => assert.fail("invalid selections must not be trashed")
  });
  const inventory = await manager.scan();
  await assert.rejects(manager.deleteSelection(inventory.token, ["../../setting.ini"]));

  const fresh = await manager.scan();
  fs.appendFileSync(selected, "-changed");
  await assert.rejects(
    manager.deleteSelection(fresh.token, [fresh.items[0].id]),
    (error) => error.code === "file_changed"
  );
});

test("scan ignores symlinks even when they point back inside an allowlisted root", async (t) => {
  const root = fixture(t);
  const target = write(root, path.join("Sticker", "real.png"));
  fs.symlinkSync(target, path.join(root, "Sticker", "alias.png"));
  const manager = new LocalCleanupManager({
    platform: "darwin",
    profile: { profileRoot: root },
    listProcesses: async () => [],
    trashItem: async () => {}
  });
  const inventory = await manager.scan();
  assert.deepEqual(inventory.items.map((item) => item.name), ["real.png"]);
});

test("reports trash failures independently without overstating removed bytes", async (t) => {
  const root = fixture(t);
  write(root, path.join("Sticker", "one.png"), "one");
  write(root, path.join("Sticker", "two.png"), "two-two");
  let attempts = 0;
  const manager = new LocalCleanupManager({
    platform: "darwin",
    profile: { profileRoot: root },
    listProcesses: async () => [],
    trashItem: async () => {
      attempts += 1;
      if (attempts === 2) throw new Error("trash unavailable");
    }
  });
  const inventory = await manager.scan();
  const result = await manager.deleteSelection(inventory.token, inventory.items.map((item) => item.id));
  assert.equal(result.local.deleted, 1);
  assert.equal(result.local.bytes, inventory.items[0].bytes);
  assert.equal(result.local.failures.length, 1);
  assert.match(result.local.failures[0].message, /trash unavailable/);
});

test("expires inventory tokens before any filesystem mutation", async (t) => {
  const root = fixture(t);
  write(root, path.join("Sticker", "item.png"));
  let clock = 1000;
  const manager = new LocalCleanupManager({
    platform: "darwin",
    profile: { profileRoot: root },
    listProcesses: async () => [],
    trashItem: async () => assert.fail("expired inventory must not mutate files"),
    now: () => clock,
    inventoryTtlMs: 100
  });
  const inventory = await manager.scan();
  clock += 101;
  await assert.rejects(
    manager.deleteSelection(inventory.token, [inventory.items[0].id]),
    (error) => error.code === "inventory_expired"
  );
});

test("cloud deletion is disabled without an official authenticated provider", () => {
  const capabilities = localCleanupCapabilities();
  assert.equal(capabilities.cloudDeletion.supported, false);
  assert.match(capabilities.cloudDeletion.reason, /官方|official/i);
  assert.equal(capabilities.cloudDeletion.canClaimRemoteDeletion, false);
});

test("Windows integration uses a GUI fixture that accepts a graceful taskkill", () => {
  const verifier = fs.readFileSync(
    path.join(__dirname, "scripts", "verify-windows-local-cleanup.cjs"),
    "utf8"
  );
  assert.match(verifier, /\/target:winexe/i);
  assert.match(verifier, /Application\.Run/);
  assert.match(verifier, /window\.Shown/);
  assert.match(verifier, /fixtureReady/);
  assert.doesNotMatch(verifier, /copyFileSync\(process\.execPath/);
});
