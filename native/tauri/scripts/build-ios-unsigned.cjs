"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const config = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "src-tauri", "tauri.conf.json"), "utf8")
);
const buildRoot = path.join(projectRoot, "src-tauri", "gen", "apple", "build");
const archivePath = path.join(buildRoot, "line-cheater-app_iOS.xcarchive");
const appBundle = path.join(
  archivePath,
  "Products",
  "Applications",
  `${config.productName}.app`
);
const outputDirectory = path.join(buildRoot, "unsigned");
const outputName = `${config.productName.replaceAll(" ", "-")}-${config.version}-unsigned.ipa`;
const outputPath = path.join(outputDirectory, outputName);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || projectRoot,
    env: options.env || process.env,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

function removeGeneratedPath(target) {
  const relative = path.relative(buildRoot, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`拒絕清除非 iOS build 產物：${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

removeGeneratedPath(archivePath);
fs.mkdirSync(outputDirectory, { recursive: true });
removeGeneratedPath(outputPath);

const tauriCli = path.join(projectRoot, "node_modules", "@tauri-apps", "cli", "tauri.js");
run(process.execPath, [
  tauriCli,
  "ios",
  "build",
  "--target",
  "aarch64",
  "--no-sign",
  "--archive-only"
]);

if (!fs.existsSync(appBundle)) {
  throw new Error("未簽署 iOS archive 已完成，但找不到 .app bundle。");
}

const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "line-cheater-ios-"));
try {
  const payload = path.join(stagingRoot, "Payload");
  fs.mkdirSync(payload);
  fs.cpSync(appBundle, path.join(payload, `${config.productName}.app`), {
    recursive: true,
    dereference: false
  });
  run("/usr/bin/zip", ["-qry", outputPath, "Payload"], { cwd: stagingRoot });
} finally {
  fs.rmSync(stagingRoot, { recursive: true, force: true });
}

run("/usr/bin/unzip", ["-t", outputPath]);
const digest = crypto.createHash("sha256").update(fs.readFileSync(outputPath)).digest("hex");
fs.writeFileSync(`${outputPath}.sha256`, `${digest}  ${outputName}\n`, "utf8");
console.log(`未簽署 IPA：${outputPath}`);
console.log(`SHA-256：${digest}`);
console.log("此 IPA 必須由個人 Apple ID 的 sideload 工具簽署後才能安裝；請勿直接放入 App Store。");
