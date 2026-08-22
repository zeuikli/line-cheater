"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const {
  ensureLineClosed,
  listLineProcesses,
  requestLineQuit
} = require("../local-cleanup.cjs");

if (process.platform !== "win32") {
  throw new Error("The Windows local-cleanup integration check must run on Windows.");
}
if (process.env.CI !== "true" || process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("This check intentionally runs only on an isolated GitHub Actions runner.");
}

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "line-cheater-win-process-"));
const fixtureBin = path.join(fixtureRoot, "LINE", "bin");
const fixtureExecutable = path.join(fixtureBin, "LINE.exe");
fs.mkdirSync(fixtureBin, { recursive: true });
fs.copyFileSync(process.execPath, fixtureExecutable);

const helper = spawn(fixtureExecutable, [
  "-e",
  "setInterval(() => {}, 1000)"
], {
  detached: false,
  stdio: "ignore",
  windowsHide: true
});

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await delay(100);
  }
  return false;
}

async function main() {
  try {
    assert.equal(
      await waitFor(async () => (await listLineProcesses("win32"))
        .some((entry) => entry.pid === helper.pid)),
      true,
      "tasklist did not discover the LINE.exe fixture"
    );

    let confirmations = 0;
    const closed = await ensureLineClosed({
      platform: "win32",
      listProcesses: () => listLineProcesses("win32"),
      confirmQuit: async () => {
        confirmations += 1;
        return true;
      },
      requestQuit: () => requestLineQuit("win32"),
      attempts: 30,
      wait: delay
    });

    assert.equal(closed, true);
    assert.equal(confirmations, 1);
    assert.equal(
      await waitFor(async () => !(await listLineProcesses("win32"))
        .some((entry) => entry.pid === helper.pid)),
      true,
      "LINE.exe fixture remained after the graceful taskkill request"
    );
    process.stdout.write("Windows LINE process gate integration passed.\n");
  } finally {
    if (helper.exitCode === null) {
      spawnSync("taskkill.exe", ["/PID", String(helper.pid), "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
    }
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
