"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = __dirname;

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("uses a Tauri 2 shell linked directly to the existing Rust core", () => {
  const manifest = read("src-tauri/Cargo.toml");
  const rust = read("src-tauri/src/lib.rs");
  assert.match(manifest, /tauri\s*=\s*\{[^}]*version\s*=\s*"2/);
  assert.match(manifest, /line-cheater\s*=\s*\{\s*path\s*=\s*"\.\.\/\.\.\/core"/);
  assert.match(rust, /line_backup_native::invoke/);
  assert.doesNotMatch(rust, /Command::new\([^)]*line-cheater/);
});

test("declares desktop and mobile capability boundaries", () => {
  const rust = read("src-tauri/src/lib.rs");
  const bridge = read("ui/tauri-bridge.js");
  assert.match(rust, /mobileImport/);
  assert.match(rust, /desktopLocalCleanup/);
  assert.match(rust, /cloudDeletion/);
  assert.match(bridge, /platform_capabilities/);
  assert.match(bridge, /native_request/);
  assert.match(bridge, /iOS／Android 不允許讀取 LINE 的私有資料夾/);
  assert.match(bridge, /directory\.hidden = true/);
});

test("builds one shared frontend without copying Electron or Node into the bundle", () => {
  const packageJson = JSON.parse(read("package.json"));
  const buildScript = read("scripts/build-ui.cjs");
  const config = read("src-tauri/tauri.conf.json");
  assert.equal(Object.hasOwn(packageJson.dependencies || {}, "electron"), false);
  assert.match(buildScript, /renderer\.html/);
  assert.match(buildScript, /tauri-bridge\.js/);
  assert.match(config, /"frontendDist"\s*:\s*"\.\.\/ui\/dist"/);
  assert.match(config, /"withGlobalTauri"\s*:\s*true/);
  assert.match(config, /"signingIdentity"\s*:\s*"-"/);
});

test("keeps mobile file access user-selected and desktop cleanup platform-gated", () => {
  const capabilities = read("src-tauri/capabilities/default.json");
  const mobileCss = read("ui/mobile.css");
  assert.doesNotMatch(capabilities, /fs:allow-home|fs:allow-appdata-recursive/);
  assert.match(mobileCss, /env\(safe-area-inset-top,/);
  assert.match(mobileCss, /min-height:\s*44px/);
  assert.match(mobileCss, /body\s*\{[^}]*min-width:\s*0/s);
  assert.match(mobileCss, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/s);
});

test("implements the candidate, export, preview, and session shell workflow natively", () => {
  const rust = read("src-tauri/src/lib.rs");
  const bridge = read("ui/tauri-bridge.js");
  for (const command of [
    "choose_candidate_output",
    "choose_export_output",
    "choose_conversation_output",
    "discard_candidate_output",
    "finalize_candidate_session",
    "attachment_preview"
  ]) {
    assert.match(rust, new RegExp(`fn ${command}\\b`));
  }
  for (const method of [
    "chooseCandidateOutput",
    "chooseExportOutput",
    "chooseConversationOutput",
    "discardCandidateOutput",
    "finalizeCandidateSession",
    "attachmentPreviewUrl"
  ]) {
    assert.doesNotMatch(bridge, new RegExp(`unsupported\\(\\"${method}\\"\\)`));
  }
  assert.match(read("../core/src/server.rs"), /pub fn invoke_streaming/);
});

test("discovers, reopens, and deletes only validated managed sessions", () => {
  const rust = read("src-tauri/src/lib.rs");
  const bridge = read("ui/tauri-bridge.js");
  assert.doesNotMatch(rust, /fn list_sessions\([^)]*\)[^{]*\{\s*Vec::new\(\)\s*\}/s);
  assert.match(rust, /fn open_saved_session\b/);
  assert.match(rust, /fn delete_saved_session\b/);
  assert.match(rust, /\.line-cheater-cache-version/);
  assert.doesNotMatch(bridge, /openSession:[\s\S]{0,100}unsupported/);
  assert.doesNotMatch(bridge, /deleteSession:[\s\S]{0,100}unsupported/);
});

test("opens only credential-free HTTP(S) links through the native opener", () => {
  const rust = read("src-tauri/src/lib.rs");
  assert.match(rust, /tauri_plugin_opener::OpenerExt/);
  assert.match(rust, /matches!\(url\.scheme\(\),\s*"http"\s*\|\s*"https"\)/s);
  assert.match(rust, /url\.username\(\)\.is_empty\(\)/);
  assert.doesNotMatch(rust, /Opening external links is disabled/);
});

test("cooperatively cancels native jobs and reports operation_cancelled", () => {
  const rust = read("src-tauri/src/lib.rs");
  const bridge = read("ui/tauri-bridge.js");
  const core = read("../core/src/server.rs");
  const cancellation = read("../core/src/cancel.rs");
  const coreExports = read("../core/src/lib.rs");
  assert.match(cancellation, /pub (?:struct|type) CancellationToken\b/);
  assert.match(coreExports, /pub use cancel::CancellationToken/);
  assert.match(core, /pub fn invoke_streaming_cancellable\b/);
  assert.match(rust, /fn cancel_operation\b/);
  assert.match(rust, /cleanup_failed_output/);
  assert.doesNotMatch(bridge, /cancelOperation:[\s\S]{0,100}unsupported/);
  assert.match(bridge, /operation_cancelled/);
});

test("supports an explicit Apple Development sideload without Distribution credentials", () => {
  const config = JSON.parse(read("src-tauri/tauri.conf.json"));
  const packageJson = JSON.parse(read("package.json"));
  const installer = read("scripts/install-ios-device.cjs");
  const unsignedBuilder = read("scripts/build-ios-unsigned.cjs");
  assert.match(config.bundle.iOS.developmentTeam, /^[A-Z0-9]{10}$/);
  assert.equal(packageJson.scripts["mobile:ios:device"], "node scripts/install-ios-device.cjs");
  assert.equal(packageJson.scripts["mobile:ios:unsigned"], "node scripts/build-ios-unsigned.cjs");
  assert.match(installer, /--export-method["',\s]+debugging/);
  assert.match(installer, /deviceIdentifier/);
  assert.match(installer, /devicectl/);
  assert.doesNotMatch(installer, /app-store-connect|release-testing/);
  assert.match(unsignedBuilder, /--no-sign/);
  assert.match(unsignedBuilder, /Payload/);
  assert.match(unsignedBuilder, /\.ipa/);
  assert.doesNotMatch(unsignedBuilder, /["']--debug["']/);
});

test("CI prepares the ignored Tauri frontend before workspace Rust compilation", () => {
  const desktopWorkflow = read("../../.github/workflows/tauri-desktop.yml");
  const macosWorkflow = read("../../.github/workflows/release-macos.yml");
  for (const workflow of [desktopWorkflow, macosWorkflow]) {
    const buildUi = workflow.indexOf("npm run build:ui");
    const cargoTest = workflow.indexOf("cargo test --workspace");
    assert.notEqual(buildUi, -1);
    assert.notEqual(cargoTest, -1);
    assert.ok(buildUi < cargoTest, "the shared frontend must exist before cargo test compiles Tauri");
  }
});

test("Android CI ships an optimized arm64 APK instead of a universal debug bundle", () => {
  const mobileWorkflow = read("../../.github/workflows/tauri-mobile.yml");
  assert.match(mobileWorkflow, /android build -- --apk --target aarch64 --split-per-abi/);
  assert.doesNotMatch(mobileWorkflow, /android build -- --debug/);
  assert.doesNotMatch(mobileWorkflow, /rustup target add[^\n]*armv7/);
  assert.match(mobileWorkflow, /keytool -genkeypair/);
  assert.match(mobileWorkflow, /apksigner" sign/);
  assert.match(mobileWorkflow, /apksigner" verify --verbose --print-certs/);
  assert.match(mobileWorkflow, /line-cheater-android-arm64-ci-signed/);
});

test("Windows local cleanup uses only stable metadata identity APIs", () => {
  const cleanup = read("src-tauri/src/local_cleanup.rs");
  assert.doesNotMatch(cleanup, /\.volume_serial_number\(\)|\.file_index\(\)/);
  assert.match(cleanup, /\.creation_time\(\)/);
  assert.match(cleanup, /\.last_write_time\(\)/);
  assert.match(cleanup, /\.file_attributes\(\)/);
});
