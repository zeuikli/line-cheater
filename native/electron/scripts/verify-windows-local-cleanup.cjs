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

    try {
      await requestLineQuit("win32");
    } catch {
      // A console fixture may make taskkill return a non-zero status. That is
      // acceptable: production must not add /F just to turn this into success.
    }
    assert.equal(
      (await listLineProcesses("win32")).some((entry) => entry.pid === helper.pid),
      true,
      "the non-force quit unexpectedly terminated the uncooperative fixture"
    );

    let confirmations = 0;
    await assert.rejects(
      ensureLineClosed({
        platform: "win32",
        listProcesses: () => listLineProcesses("win32"),
        confirmQuit: async () => {
          confirmations += 1;
          return true;
        },
        requestQuit: async () => {},
        attempts: 2,
        wait: () => delay(50)
      }),
      (error) => error && error.code === "line_did_not_quit"
    );
    assert.equal(confirmations, 1);
    assert.equal(
      (await listLineProcesses("win32")).some((entry) => entry.pid === helper.pid),
      true,
      "the startup gate must leave an uncooperative LINE process untouched"
    );
    process.stdout.write("Windows LINE process gate fail-closed integration passed.\n");
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
