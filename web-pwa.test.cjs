const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = __dirname;
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

test("web app declares an installable mobile manifest", () => {
  const html = read("index.html");
  const manifest = JSON.parse(read("manifest.webmanifest"));

  assert.match(html, /rel="manifest" href="manifest\.webmanifest"/);
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "./");
  assert.ok(manifest.icons.some((icon) => icon.sizes === "192x192"));
  assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512"));
});

test("web app keeps its SQLite engine local and caches the application shell", () => {
  const html = read("index.html");
  const app = read("app.js");
  const worker = read("service-worker.js");

  assert.match(html, /vendor\/sql\.js\/sql-wasm\.js/);
  assert.doesNotMatch(html, /cdn\.jsdelivr\.net\/npm\/sql\.js/);
  assert.match(app, /vendor\/sql\.js\//);
  assert.doesNotMatch(app, /cdn\.jsdelivr\.net\/npm\/sql\.js/);
  for (const asset of ["./", "./index.html", "./styles.css", "./app.js", "./vendor/sql.js/sql-wasm.js", "./vendor/sql.js/sql-wasm.wasm"]) {
    assert.ok(worker.includes(JSON.stringify(asset)), `service worker should cache ${asset}`);
  }
});

test("mobile UI states the sandbox limitation and registers offline support", () => {
  const html = read("index.html");
  const pwa = read("pwa.js");

  assert.match(html, /手機版無法直接讀取 LINE App 的私有資料/);
  assert.match(html, /pwa\.js/);
  assert.match(pwa, /serviceWorker\.register\("\.\/service-worker\.js"\)/);
});
