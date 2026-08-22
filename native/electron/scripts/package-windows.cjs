"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");

const electronRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(electronRoot, "..", "..");
const packageMetadata = JSON.parse(
  fs.readFileSync(path.join(electronRoot, "package.json"), "utf8")
);
const productName = packageMetadata.productName;
const version = packageMetadata.version;

if (process.platform !== "win32") {
  throw new Error("The Windows package must be assembled on Windows.");
}
if (process.arch !== "x64") {
  throw new Error(`Unsupported Windows architecture: ${process.arch}`);
}

const electronRuntime = path.join(electronRoot, "node_modules", "electron", "dist");
const electronInstaller = path.join(
  electronRoot,
  "node_modules",
  "electron",
  "install.js"
);
const electronBinary = path.join(electronRuntime, "electron.exe");
const releaseBinary = path.join(
  repositoryRoot,
  "target",
  "release",
  "line-cheater.exe"
);
const distRoot = process.env.LINE_CHEATER_DIST_ROOT
  ? path.resolve(process.env.LINE_CHEATER_DIST_ROOT)
  : path.join(electronRoot, "dist");
const platformRoot = path.join(distRoot, "win-x64");
const appPath = path.join(platformRoot, productName);
const resourcesPath = path.join(appPath, "resources");
const packagedSourceRoot = path.join(resourcesPath, "app");
const artifactBase = `LINE-Cheater-${version}-Windows-x64`;
const zipPath = path.join(distRoot, `${artifactBase}.zip`);
const checksumPath = path.join(distRoot, `SHA256SUMS-Windows-x64.txt`);
const windowsIcon = path.join(electronRoot, "assets", "icon.ico");
const resourceEditor = path.join(
  electronRoot,
  "node_modules",
  "rcedit",
  "bin",
  "rcedit-x64.exe"
);
const requiredPackageFiles = [
  `${productName}.exe`,
  path.join("resources", "app", "package.json"),
  path.join("resources", "app", "native", "electron", "main.cjs"),
  path.join("resources", "app", "native", "electron", "preload.cjs"),
  path.join("resources", "app", "native", "electron", "renderer.html"),
  path.join("resources", "app", "native", "electron", "renderer.js"),
  path.join("resources", "app", "native", "electron", "local-cleanup.cjs"),
  path.join("resources", "app", "native", "electron", "session-cache.cjs"),
  path.join("resources", "app", "native", "electron", "sidecar-client.cjs"),
  path.join("resources", "app", "native", "electron", "styles.css"),
  path.join("resources", "app", "native", "electron", "update-checker.cjs"),
  path.join("resources", "app", "native", "electron", "assets", "icon.ico"),
  path.join("resources", "app", "native", "electron", "assets", "icon.png"),
  path.join("resources", "app", "native", "frontend", "data-provider.js"),
  path.join("resources", "bin", "line-cheater.exe")
];

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

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function copyDirectory(source, destination) {
  fs.cpSync(source, destination, { recursive: true });
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function packageZip() {
  const script = [
    "$ErrorActionPreference = 'Stop';",
    "Compress-Archive",
    `-LiteralPath '${appPath.replace(/'/g, "''")}'`,
    `-DestinationPath '${zipPath.replace(/'/g, "''")}'`,
    "-CompressionLevel Optimal",
    "-Force"
  ].join(" ");
  run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
}

function verifyZip() {
  const verificationRoot = path.join(distRoot, ".windows-verify");
  fs.rmSync(verificationRoot, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 250
  });
  fs.mkdirSync(verificationRoot, { recursive: true });

  try {
    const script = [
      "$ErrorActionPreference = 'Stop';",
      "Expand-Archive",
      `-LiteralPath '${zipPath.replace(/'/g, "''")}'`,
      `-DestinationPath '${verificationRoot.replace(/'/g, "''")}'`,
      "-Force"
    ].join(" ");
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);

    const verifiedApp = path.join(verificationRoot, productName);
    for (const relativePath of requiredPackageFiles) {
      const filePath = path.join(verifiedApp, relativePath);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        throw new Error(`ZIP does not contain required file: ${relativePath}`);
      }
    }

    const verifiedMetadata = JSON.parse(
      fs.readFileSync(path.join(verifiedApp, "resources", "app", "package.json"), "utf8")
    );
    if (
      verifiedMetadata.productName !== productName ||
      verifiedMetadata.version !== version ||
      verifiedMetadata.main !== "native/electron/main.cjs"
    ) {
      throw new Error("ZIP contains invalid packaged Electron metadata.");
    }

    const verifiedSidecar = path.join(verifiedApp, "resources", "bin", "line-cheater.exe");
    run(verifiedSidecar, ["--version"]);
  } finally {
    fs.rmSync(verificationRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 250
    });
  }
}

if (!fs.existsSync(electronBinary)) {
  if (!fs.existsSync(electronInstaller)) {
    throw new Error("Electron installer is missing. Run npm ci in native/electron first.");
  }
  run(process.execPath, [electronInstaller]);
}
if (!fs.existsSync(electronBinary)) {
  throw new Error("Electron runtime is missing after running the Electron installer.");
}
if (!fs.existsSync(releaseBinary)) {
  throw new Error("Release sidecar is missing. Run the package:win npm script.");
}
if (!fs.existsSync(windowsIcon)) {
  throw new Error("Windows icon is missing: assets/icon.ico.");
}
if (!fs.existsSync(resourceEditor)) {
  throw new Error("rcedit is missing. Run npm ci in native/electron first.");
}

fs.mkdirSync(distRoot, { recursive: true });
fs.rmSync(platformRoot, {
  recursive: true,
  force: true,
  maxRetries: 10,
  retryDelay: 250
});
fs.rmSync(zipPath, { force: true });
copyDirectory(electronRuntime, appPath);

const oldExecutable = path.join(appPath, "electron.exe");
const newExecutable = path.join(appPath, `${productName}.exe`);
if (!fs.existsSync(oldExecutable)) {
  throw new Error("Electron runtime does not contain electron.exe.");
}
fs.renameSync(oldExecutable, newExecutable);
run(resourceEditor, [newExecutable, "--set-icon", windowsIcon]);
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
  windowsIcon,
  path.join(packagedSourceRoot, "native", "electron", "assets", "icon.ico")
);
copyFile(
  path.join(electronRoot, "..", "frontend", "data-provider.js"),
  path.join(packagedSourceRoot, "native", "frontend", "data-provider.js")
);
copyFile(
  releaseBinary,
  path.join(resourcesPath, "bin", "line-cheater.exe")
);

packageZip();
verifyZip();
fs.writeFileSync(
  checksumPath,
  `${sha256(zipPath)}  ${path.basename(zipPath)}\n`
);

console.log(`Packaged ${appPath}`);
console.log(`Created ${zipPath}`);
console.log(`Created ${checksumPath}`);
console.log("Signature: unsigned (Windows signing is not configured)");
