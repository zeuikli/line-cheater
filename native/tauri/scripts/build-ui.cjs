"use strict";

const fs = require("node:fs");
const path = require("node:path");

const tauriRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(tauriRoot, "..", "..");
const electronUiRoot = path.join(repositoryRoot, "native", "electron");
const sharedFrontendRoot = path.join(repositoryRoot, "native", "frontend");
const sourceUiRoot = path.join(tauriRoot, "ui");
const outputRoot = path.join(sourceUiRoot, "dist");

fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(path.join(outputRoot, "assets"), { recursive: true });

const html = fs.readFileSync(path.join(electronUiRoot, "renderer.html"), "utf8")
  .replace(
    "</head>",
    '  <link rel="stylesheet" href="/mobile.css">\n</head>'
  )
  .replace(
    '  <script src="/data-provider.js"></script>',
    '  <script src="/tauri-bridge.js"></script>\n' +
      '  <script src="/data-provider.js"></script>'
  );

fs.writeFileSync(path.join(outputRoot, "index.html"), html);
for (const [source, destination] of [
  [path.join(electronUiRoot, "renderer.js"), "renderer.js"],
  [path.join(electronUiRoot, "styles.css"), "styles.css"],
  [path.join(sharedFrontendRoot, "data-provider.js"), "data-provider.js"],
  [path.join(sourceUiRoot, "tauri-bridge.js"), "tauri-bridge.js"],
  [path.join(sourceUiRoot, "mobile.css"), "mobile.css"],
  [path.join(electronUiRoot, "assets", "icon.png"), path.join("assets", "icon.png")]
]) {
  fs.copyFileSync(source, path.join(outputRoot, destination));
}

process.stdout.write(`Built shared Tauri UI at ${outputRoot}\n`);
