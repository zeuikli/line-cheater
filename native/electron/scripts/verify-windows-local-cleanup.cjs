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
const fixtureSource = path.join(fixtureRoot, "GracefulLineFixture.cs");
fs.mkdirSync(fixtureBin, { recursive: true });
fs.writeFileSync(fixtureSource, [
  "using System;",
  "using System.Windows.Forms;",
  "static class GracefulLineFixture {",
  "  [STAThread]",
  "  static void Main() {",
  "    Application.EnableVisualStyles();",
  "    using (var window = new Form()) {",
  "      window.Text = \"LINE graceful quit fixture\";",
  "      window.ShowInTaskbar = false;",
  "      window.Left = -32000;",
  "      window.Top = -32000;",
  "      window.Width = 1;",
  "      window.Height = 1;",
  "      Application.Run(window);",
  "    }",
  "  }",
  "}"
].join("\n"));

const csc = path.join(
  process.env.WINDIR || "C:\\Windows",
  "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"
);
assert.equal(fs.existsSync(csc), true, `C# compiler not found at ${csc}`);
const compilation = spawnSync(csc, [
  "/nologo",
  "/target:winexe",
  `/out:${fixtureExecutable}`,
  "/reference:System.Windows.Forms.dll",
  fixtureSource
], {
  encoding: "utf8",
  windowsHide: true
});
if (compilation.status !== 0) {
  throw new Error(`Could not compile the graceful LINE fixture:\n${compilation.stdout}\n${compilation.stderr}`);
}

const helper = spawn(fixtureExecutable, [], {
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
