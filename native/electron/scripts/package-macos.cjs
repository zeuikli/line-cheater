"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const electronRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(electronRoot, "..", "..");
const packageMetadata = JSON.parse(
  fs.readFileSync(path.join(electronRoot, "package.json"), "utf8")
);
const productName = packageMetadata.productName;
const version = packageMetadata.version;
const architecture = process.arch === "arm64"
  ? "arm64"
  : (process.arch === "x64" ? "x64" : null);

if (process.platform !== "darwin") {
  throw new Error("The macOS package must be assembled on macOS.");
}
if (!architecture) {
  throw new Error(`Unsupported macOS architecture: ${process.arch}`);
}

const electronApp = path.join(
  electronRoot,
  "node_modules",
  "electron",
  "dist",
  "Electron.app"
);
const releaseBinary = path.join(
  repositoryRoot,
  "target",
  "release",
  "line-cheater"
);
const distRoot = path.join(electronRoot, "dist");
const platformRoot = path.join(distRoot, `mac-${architecture}`);
const appPath = path.join(platformRoot, `${productName}.app`);
const contentsPath = path.join(appPath, "Contents");
const resourcesPath = path.join(contentsPath, "Resources");
const packagedSourceRoot = path.join(resourcesPath, "app");
const artifactBase = `LINE-Cheater-${version}-macOS-${architecture}`;
const zipPath = path.join(distRoot, `${artifactBase}.zip`);
const dmgPath = path.join(distRoot, `${artifactBase}.dmg`);
const electronEntitlements = path.join(electronRoot, "entitlements.mac.plist");
const identity = process.env.MACOS_SIGN_IDENTITY || "-";
const usesDeveloperId = identity !== "-";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(
      `${path.basename(command)} failed with exit code ${result.status}` +
      (detail ? `:\n${detail}` : "")
    );
  }
  return result.stdout || "";
}

function runOptional(command, args) {
  return spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: "ignore"
  }).status === 0;
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(
      `${path.basename(command)} failed with exit code ${result.status}` +
      (detail ? `:\n${detail}` : "")
    );
  }
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function copyFile(source, destination, mode) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  if (mode !== undefined) fs.chmodSync(destination, mode);
}

function plist(command) {
  run("/usr/libexec/PlistBuddy", ["-c", command, path.join(contentsPath, "Info.plist")]);
}

function buildIcon() {
  const source = path.join(electronRoot, "assets", "icon.png");
  const iconset = path.join(distRoot, ".line-cheater.iconset");
  const output = path.join(resourcesPath, "line-cheater.icns");
  const variants = [
    ["icon_16x16.png", 16],
    ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32],
    ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128],
    ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256],
    ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512],
    ["icon_512x512@2x.png", 1024]
  ];
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset, { recursive: true });
  const metadata = run("/usr/bin/sips", [
    "-g", "pixelWidth", "-g", "pixelHeight", "-g", "hasAlpha", source
  ], { capture: true });
  if (!/pixelWidth:\s*1024\b/.test(metadata) ||
      !/pixelHeight:\s*1024\b/.test(metadata)) {
    throw new Error("The macOS icon master must be a square 1024 × 1024 PNG.");
  }
  if (!/hasAlpha:\s*(?:yes|true)\b/i.test(metadata)) {
    throw new Error("The macOS icon master must have transparent rounded corners.");
  }
  for (const [filename, size] of variants) {
    run("/usr/bin/sips", [
      "-s", "format", "png",
      "-z", String(size), String(size),
      source,
      "--out", path.join(iconset, filename)
    ]);
  }
  run("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", output]);
  fs.rmSync(iconset, { recursive: true, force: true });
}

function sha256(file) {
  return run("/usr/bin/shasum", ["-a", "256", file], { capture: true })
    .trim()
    .split(/\s+/)[0];
}

function sign(target, entitlements) {
  const arguments_ = ["--force", "--sign", identity];
  if (usesDeveloperId) {
    arguments_.push("--options", "runtime", "--timestamp");
    if (entitlements) arguments_.push("--entitlements", entitlements);
  }
  arguments_.push(target);
  run("/usr/bin/codesign", arguments_);
}

function findPaths(args) {
  return capture("/usr/bin/find", args)
    .split("\0")
    .filter(Boolean);
}

function pathDepth(target) {
  return target.split(path.sep).length;
}

function signElectronRuntime() {
  const codeFiles = findPaths([contentsPath, "-type", "f", "-print0"])
    .filter((target) => capture("/usr/bin/file", ["-b", target]).includes("Mach-O"))
    .sort((left, right) => pathDepth(right) - pathDepth(left));

  for (const target of codeFiles) sign(target);

  const codeBundles = findPaths([
    contentsPath,
    "-type", "d",
    "(",
    "-name", "*.framework",
    "-o",
    "-name", "*.app",
    "-o",
    "-name", "*.xpc",
    "-o",
    "-name", "*.appex",
    ")",
    "-print0"
  ]).sort((left, right) => pathDepth(right) - pathDepth(left));

  for (const target of codeBundles) {
    sign(target, target.endsWith(".app") ? electronEntitlements : undefined);
  }
}

function verifySignature(target, label) {
  if (!usesDeveloperId) return;
  run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", target]);
  const details = capture("/usr/bin/codesign", ["-dvvv", target]);
  const teamIdentifier = identity.match(/\(([A-Z0-9]{10})\)$/)?.[1];
  if (!details.includes(`Authority=${identity}`) ||
      (teamIdentifier && !details.includes(`TeamIdentifier=${teamIdentifier}`)) ||
      !details.includes("Runtime Version=") ||
      (!details.includes("Signed Time=") && !details.includes("Timestamp="))) {
    throw new Error(`${label} is not a timestamped Developer ID hardened-runtime signature.`);
  }
}

function assertSingleArchitecture(target, label) {
  const architectures = capture("/usr/bin/lipo", ["-archs", target])
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const normalizedArchitectures = architectures.map((value) =>
    value === "x86_64" ? "x64" : value
  );
  if (normalizedArchitectures.length !== 1 || normalizedArchitectures[0] !== architecture) {
    throw new Error(
      `${label} architecture is ${architectures.join(", ") || "unknown"}; ` +
      `expected exactly ${architecture}.`
    );
  }
}

if (!fs.existsSync(electronApp)) {
  throw new Error("Electron.app is missing. Run npm install in native/electron first.");
}
if (!fs.existsSync(releaseBinary)) {
  throw new Error("Release sidecar is missing. Run the package:mac npm script.");
}
assertSingleArchitecture(
  path.join(electronApp, "Contents", "MacOS", "Electron"),
  "Electron runtime"
);
assertSingleArchitecture(releaseBinary, "Rust sidecar");
if (!fs.existsSync(electronEntitlements)) {
  throw new Error("Electron entitlements are missing.");
}
if (usesDeveloperId && !identity.startsWith("Developer ID Application:")) {
  throw new Error(
    "Set MACOS_SIGN_IDENTITY to a Developer ID Application certificate before packaging."
  );
}
if (usesDeveloperId && !capture("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"])
  .includes(`"${identity}"`)) {
  throw new Error(`Developer ID certificate is unavailable in the keychain: ${identity}`);
}

fs.mkdirSync(distRoot, { recursive: true });
fs.rmSync(platformRoot, { recursive: true, force: true });
fs.rmSync(zipPath, { force: true });
fs.rmSync(dmgPath, { force: true });
fs.mkdirSync(platformRoot, { recursive: true });

run("/usr/bin/ditto", [electronApp, appPath]);

const oldExecutable = path.join(contentsPath, "MacOS", "Electron");
const newExecutable = path.join(contentsPath, "MacOS", productName);
fs.renameSync(oldExecutable, newExecutable);
fs.rmSync(path.join(resourcesPath, "default_app.asar"), { force: true });

const packagedMetadata = {
  name: packageMetadata.name,
  productName,
  version,
  private: true,
  main: "native/electron/main.cjs"
};
fs.mkdirSync(packagedSourceRoot, { recursive: true });
fs.writeFileSync(
  path.join(packagedSourceRoot, "package.json"),
  `${JSON.stringify(packagedMetadata, null, 2)}\n`
);

for (const filename of [
  "main.cjs",
  "preload.cjs",
  "renderer.html",
  "renderer.js",
  "local-cleanup.cjs",
  "session-cache.cjs",
  "sidecar-client.cjs",
  "styles.css",
  "update-checker.cjs"
]) {
  copyFile(
    path.join(electronRoot, filename),
    path.join(packagedSourceRoot, "native", "electron", filename)
  );
}
copyFile(
  path.join(electronRoot, "assets", "icon.png"),
  path.join(packagedSourceRoot, "native", "electron", "assets", "icon.png")
);
copyFile(
  path.join(electronRoot, "..", "frontend", "data-provider.js"),
  path.join(packagedSourceRoot, "native", "frontend", "data-provider.js")
);
copyFile(
  releaseBinary,
  path.join(resourcesPath, "bin", "line-cheater"),
  0o755
);

plist(`Set :CFBundleName ${productName}`);
plist(`Set :CFBundleDisplayName ${productName}`);
plist(`Set :CFBundleExecutable ${productName}`);
plist("Set :CFBundleIdentifier de.gginin.line-cheater");
plist(`Set :CFBundleShortVersionString ${version}`);
plist("Set :CFBundleVersion 1");
plist("Set :LSApplicationCategoryType public.app-category.utilities");
plist("Set :LSMinimumSystemVersion 12.0");
for (const key of [
  "ElectronAsarIntegrity",
  "NSAppTransportSecurity",
  "NSAudioCaptureUsageDescription",
  "NSBluetoothAlwaysUsageDescription",
  "NSBluetoothPeripheralUsageDescription",
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription"
]) {
  runOptional("/usr/libexec/PlistBuddy", [
    "-c", `Delete :${key}`, path.join(contentsPath, "Info.plist")
  ]);
}

buildIcon();
plist("Set :CFBundleIconFile line-cheater.icns");

signElectronRuntime();
const sidecarPath = path.join(resourcesPath, "bin", "line-cheater");
sign(sidecarPath);
sign(appPath, usesDeveloperId ? electronEntitlements : undefined);
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
verifySignature(newExecutable, "App executable");
verifySignature(sidecarPath, "Rust sidecar");

run("/usr/bin/ditto", [
  "-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zipPath
]);

const dmgStage = path.join(distRoot, ".dmg-stage");
fs.rmSync(dmgStage, { recursive: true, force: true });
fs.mkdirSync(dmgStage, { recursive: true });
run("/usr/bin/ditto", [appPath, path.join(dmgStage, `${productName}.app`)]);
fs.symlinkSync("/Applications", path.join(dmgStage, "Applications"), "dir");
run("/usr/bin/hdiutil", [
  "create",
  "-volname", productName,
  "-srcfolder", dmgStage,
  "-ov",
  "-format", "UDZO",
  dmgPath
]);
fs.rmSync(dmgStage, { recursive: true, force: true });

const checksums = [
  `${sha256(zipPath)}  ${path.basename(zipPath)}`,
  `${sha256(dmgPath)}  ${path.basename(dmgPath)}`
];
fs.writeFileSync(path.join(distRoot, "SHA256SUMS.txt"), `${checksums.join("\n")}\n`);

console.log(`Packaged ${appPath}`);
console.log(`Created ${zipPath}`);
console.log(`Created ${dmgPath}`);
console.log(usesDeveloperId
  ? `Signature: ${identity} (notarization still required)`
  : "Signature: ad hoc (not notarized)");
