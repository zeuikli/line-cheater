"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const deviceIdentifier = process.argv[2];
const identifierPattern = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env: options.env || process.env,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

function deviceIsAvailable(identifier) {
  const result = spawnSync("xcrun", [
    "devicectl",
    "device",
    "info",
    "details",
    "--device",
    identifier
  ], { cwd: projectRoot, stdio: "ignore", timeout: 15_000 });
  return !result.error && result.status === 0;
}

if (!identifierPattern.test(deviceIdentifier || "")) {
  console.error("請指定 devicectl 顯示的 iPhone Identifier，避免把 App 安裝到錯誤裝置。");
  run("xcrun", ["devicectl", "list", "devices"]);
  console.error("用法：npm run mobile:ios:device -- <DEVICE_IDENTIFIER>");
  process.exit(2);
}
if (!deviceIsAvailable(deviceIdentifier)) {
  console.error("找不到可用且已配對的指定 iPhone；請解鎖裝置、保持連線後再試一次。");
  run("xcrun", ["devicectl", "list", "devices"]);
  process.exit(3);
}

const config = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "src-tauri", "tauri.conf.json"), "utf8")
);
const developmentTeam = config.bundle && config.bundle.iOS && config.bundle.iOS.developmentTeam;
if (!/^[A-Z0-9]{10}$/.test(developmentTeam || "")) {
  throw new Error("tauri.conf.json 缺少有效的 bundle.iOS.developmentTeam。 ");
}

const tauriCli = path.join(projectRoot, "node_modules", "@tauri-apps", "cli", "tauri.js");
run(process.execPath, [
  tauriCli,
  "ios",
  "build",
  "--debug",
  "--target",
  "aarch64",
  "--export-method",
  "debugging"
], {
  env: { ...process.env, APPLE_DEVELOPMENT_TEAM: developmentTeam }
});

const buildRoot = path.join(projectRoot, "src-tauri", "gen", "apple", "build");
const appCandidates = [
  path.join(buildRoot, "arm64", `${config.productName}.app`),
  path.join(
    buildRoot,
    "line-cheater-app_iOS.xcarchive",
    "Products",
    "Applications",
    `${config.productName}.app`
  )
].filter((candidate) => fs.existsSync(candidate));

if (appCandidates.length === 0) {
  throw new Error("實機版編譯成功，但找不到可安裝的 .app bundle。");
}
appCandidates.sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
const appBundle = appCandidates[0];

run("xcrun", [
  "devicectl",
  "device",
  "install",
  "app",
  "--device",
  deviceIdentifier,
  appBundle
]);
run("xcrun", [
  "devicectl",
  "device",
  "process",
  "launch",
  "--terminate-existing",
  "--device",
  deviceIdentifier,
  config.identifier
]);

console.log(`已使用 Apple Development 簽署、安裝並啟動 ${config.productName}。`);
