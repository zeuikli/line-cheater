# LINE Cheater desktop preview

This is the runnable desktop shell for the bounded-memory Rust core. The macOS
release workflow produces separate arm64 and x64 packages for Apple Silicon and
Intel Macs.

Read [`../../NATIVE.md`](../../NATIVE.md) first. That file is the authoritative
architecture, safety, verification, and handoff record.

## Run

Prerequisites: Rust 1.96 or compatible, Node.js/npm, and enough free disk space
for the SQLite staging directory and candidate output.

```bash
# From the repository root.
cargo build -p line-cheater
npm --prefix native/electron ci
npm --prefix native/electron test
npm --prefix native/electron run dev
```

The development shell finds `target/release/line-cheater` first and then
`target/debug/line-cheater`. A packaged build must put the platform binary
at `resources/bin/line-cheater` (with `.exe` on Windows). For local
diagnostics only, `LINE_BACKUP_NATIVE_BIN` can point at another build.

Electron is pinned in `package-lock.json`. Keep it current because the runtime
ships Chromium and Node.js security updates.

## Process boundary

```text
sandboxed renderer
  renderer.js + NativeDataProvider
        │ allowlisted invoke/event bridge
        ▼
Electron main process
  native dialogs + output tokens + SidecarClient
        │ bounded JSON Lines over stdin/stdout
        ▼
line-cheater serve
  read-only source + catalog.sqlite + candidate writer
```

The renderer never receives Node.js, Electron IPC primitives, a child-process
handle, or arbitrary filesystem methods. The main process:

- serves only four allowlisted local assets from the `line-cheater://app` custom
  protocol;
- enables context isolation, process sandboxing, and web security;
- disables renderer Node integration, navigation, new windows, and permissions;
- validates the IPC sender and method allowlist;
- limits sidecar requests to 1 MiB and response lines to 16 MiB;
- keeps source selection in native dialogs;
- converts catalog-authorized image files into opaque local preview URLs;
- opens only credential-free `http:`/`https:` links through the system browser;
  renderer navigation, `file:` URLs, and other schemes remain blocked;
- converts a one-use output token into the candidate path so the renderer cannot
  choose arbitrary paths directly;
- binds every source-specific session cache to `app.getVersion()`, deleting and
  rebuilding catalogs and staging data when that version is missing or changes;
- closes the background core and deletes the complete source session after a
  candidate passes full validation. Candidate output inside the internal cache
  is rejected before construction.

Do not replace this bridge with a general `ipcRenderer.send`, filesystem, shell,
or child-process API.

## macOS package

Build the current machine architecture with:

```bash
npm --prefix native/electron run package:mac
```

To install dependencies, package the current macOS architecture, and verify
the generated DMG by mounting it read-only:

```bash
native/electron/scripts/package-dmg.sh
```

Set `SKIP_NPM_CI=1` when dependencies are already installed. The script runs
the Electron tests, builds the release Rust sidecar, verifies the app
signature and DMG checksum structure, mounts the DMG, and checks the packaged
sidecar with `--version`.

The command runs the Electron contract tests, compiles an optimized Rust
sidecar, copies the Electron runtime, installs the sidecar under
`Contents/Resources/bin`, validates the 1024 × 1024
`assets/icon.png` with transparent macOS-style rounded corners, derives all
ten required `.iconset` bitmap slots and the
LINE Cheater `.icns`, applies an ad-hoc code signature for local packaging,
verifies the bundle, and produces:

```text
native/electron/dist/mac-<arch>/LINE Cheater.app
native/electron/dist/LINE-Cheater-<version>-macOS-<arch>.zip
native/electron/dist/LINE-Cheater-<version>-macOS-<arch>.dmg
native/electron/dist/SHA256SUMS.txt
```

The release workflow produces separate `arm64` and `x64` artifacts for Apple
Silicon and Intel Macs running macOS 12 or later. The local `package:mac`
command packages the current host architecture; `package-dmg.sh` rejects a
requested architecture that does not match the runner. Local packaging uses
an ad-hoc signature unless a Developer ID identity is supplied. The release
jobs import the configured passwordless `MACOS_CERTIFICATE_BASE64` P12 and use
`MACOS_SIGN_IDENTITY` for Developer ID signatures. The configured
`MACOS_NOTARY_APPLE_ID`, `MACOS_NOTARY_TEAM_ID`, and
`MACOS_NOTARY_APP_SPECIFIC_PASSWORD` credentials are used to submit each
architecture's DMG with `xcrun notarytool`; each submission is waited on,
stapled, and validated.

### Automated release

Every push to `main` (including a merged pull request) runs
`.github/workflows/release-macos.yml` on an arm64 `macos-14` runner and an
Intel `macos-15-intel` runner. A single prepare job increments the patch version
in `native/core/Cargo.toml`, synchronizes `Cargo.lock` and the Electron package
metadata, and commits the version bump. The two package jobs then build and
verify their native sidecar, Electron runtime, signed DMG, notarization, and
checksums; one publish job combines both architectures into the tag-matched
GitHub Release. The generated version-bump commit is detected so it does not
increment twice.

Windows x64 packaging runs from `.github/workflows/release-windows.yml` on pull
requests and after the macOS release workflow succeeds. It publishes an
unsigned ZIP and checksum file; a Windows environment is not required on the
developer machine.

## Implemented UI flow

1. Start on a dedicated LINE Cheater welcome screen. `.imazingapp` is the first
   and recommended source; an unpacked backup directory remains available as
   the secondary choice. Direct `Line.sqlite` loading remains supported by the
   native core for diagnostics but is intentionally hidden from the end-user
   welcome screen.
2. Show the same blocking spinner/progress treatment as the web app while the
   read-only session, companion databases, attachment catalog, and chat page are
   prepared.
3. Keep the user on the source screen after preparation and enable an explicit
   Next action.
4. Enter a native app shell with a persistent source summary and sidebar. The
   sidebar switches between Browse, Cleanup, Exact Duplicates, and Advanced;
   only one workspace is visible at a time. Exact Duplicates remains visible
   but prompts the user to enable the guarded Advanced mode before it opens.
   The welcome header and sidebar reuse the packaged macOS app icon rather than
   a separate lettermark.
5. Resolve chat names from the main, `LineSquare.sqlite`, and
   `UnifiedGroup.sqlite` databases plus rename system messages. Main and
   community chats share a source-aware cursor and keep the source needed to
   route later message requests.
6. Page chats at 100 rows and messages at 180 rows in both directions using
   the web-style chat/message panel and incoming/outgoing/system bubble
   layout. Rust supplies `isSelf`; send status is never allowed to turn
   another identified member into “我”.
7. Hydrate referenced chat images from catalog-authorized original/thumbnail
   paths with at most four concurrent preview requests. HTTP(S) text is
   linkified, receives a bounded domain/title preview card, and opens in the
   system browser through a protocol-validated main-process bridge.
8. Search message text with bounded native result pages.
9. Export the selected conversation from its first message through its last as
   a portable ZIP. The archive contains one offline `index.html` plus referenced
   originals and thumbnails under `attachments/`; direct SQLite sources export
   the complete text-only HTML.
10. Review six cleanup categories inside a fixed-height workspace. The list
   replaces four chat/special groups at a time, so the page header, filters,
   pagination, and candidate action never leave the window.
11. Search/filter/sort and enter a group. Detail mode becomes an iOS
    Photos-style continuous album grouped by month. It fetches 24 review bundles
    per native request and keeps at most three adjacent batches (72 cards) in
    the DOM; measured virtual spacers preserve scroll position when an older
    batch is discarded. Thumbnails keep their aspect ratio without cropping,
    with message/file controls below. A loaded thumbnail is a keyboard-focusable
    zoom button and opens the same full-size image modal used by chat messages.
12. Mark original attachments and thumbnails independently, or use the reversible
   delete-all / keep-thumbnail group actions.
13. Choose an output through a native save dialog and build a full-CRC candidate
    with the web-style progress/success/error dialog. After successful output
    validation, close the source session, clear its private local cache, and
    return the underlying UI to source selection while keeping the result dialog
    visible.
14. Turn on the guarded desktop-only Advanced mode to plan deletion of a selected
    chat and its attachments, or use the Advanced sidebar page to include empty
    chats, system-only chats, and orphan `LineSquare` messages. The source remains
    read-only; only the newly built candidate receives the SQLite rewrite.
15. In Advanced mode, scan exact duplicate attachments and preview each group
    through the catalog-authorized image bridge. “Merge All Automatically” is
    a reversible batch button: its second state cancels all automatic merging.
    When enabled, candidate construction applies every file/chat removal first,
    chooses a canonical file only from the surviving members, and replaces the
    other survivors with relative ZIP symlinks. An entirely removed group
    produces no links.

Every next-page action replaces the current DOM window instead of appending to
an unbounded array.

## 2026-07-24 browser comparison

The same ignored 1.1 GB directory fixture was loaded in the production web app
and in this desktop preview. Only aggregate results were recorded:

| Check | Web app | Electron + Rust |
|---|---:|---:|
| Source totals | 221 chats, 925,868 messages, 11,239 attachments | Same source tables/catalog |
| Nonempty chat list | 221 merged chats | 221 source-aware chats; 20 community labels |
| Visible chat window | 4 rows at the tested viewport | 100 rows |
| Visible message window | 180 rows | 180 rows |
| Raw-ID titles in first 100 main chats | Not shown by the reference UI | 0 |
| Referenced message image route | Local image preview | Original, then thumbnail fallback |
| Attachment presentation | 59 chat/special groups across 3 pages | Same 59 groups across 15 fixed-view pages |
| Cleanup page size | 24 groups or review bundles | 4 group rows; detail uses 24-card virtual batches |
| Cleanup categories | 6 categories | Same 6 categories and aggregate totals |
| Group actions | Delete all / keep thumbnails | Same actions and reversible states |
| No-match search | 0 results | 0 results |

The same real `.imazingapp` also returned 11,239 attachments and 59 cleanup
groups. The fixed desktop list showed four groups on page 1 of 15. The earlier
two-card detail comparison was later replaced by continuous month-sectioned
scrolling backed by bounded 24-card batches. Only aggregate results were
recorded.

The desktop now uses the same title evidence, nonempty-chat visibility, and
sender-ownership rules as the web app. The web app remains the reference for
cleanup-plan exports, duplicate presentation, cross-store coalescing when an ID
exists in both databases, and its broader analysis tools.
The desktop cleanup workflow and safety decisions match while large state stays
in the native catalog.

## Cleanup behavior

- `referenced` requires exactly one message whose database chat ID matches the
  chat ID embedded in the attachment path.
- A valid ID absent from both `Line.sqlite` and `LineSquare.sqlite` is
  `unreferenced`.
- Missing/ambiguous IDs and IDs found in another chat are `unconfirmed`.
- Original and thumbnail checkboxes are separate.
- “刪除全部” toggles the complete group.
- “只保留縮圖” only marks SQLite-confirmed image originals that have a
  non-empty thumbnail for the same message and chat. It leaves PDFs, videos,
  missing/empty-thumbnail attachments, and unconfirmed media untouched, clears
  marks from the matching thumbnails, and toggles back to restoring those image
  originals.
- Filters, category cards, sorting, search, category/group pagination, and
  safety/evidence copy mirror the web UI.
- Advanced chat plans are keyed by `(source, chat_pk)`, so main and community
  rows cannot collide. Exact referenced attachments and files whose path chat ID
  matches the selected chat join the same removal plan. Empty/system-only
  detection uses actual `ZMESSAGE` rows rather than a cached `ZMESSAGECOUNT`;
  community orphan detection requires no matching `ZCHAT.Z_PK`.
- Duplicate review is available only while Advanced mode is enabled. Group
  previews use the same bounded local protocol as cleanup images. Duplicate
  checkboxes may mark every member for deletion; the candidate writer excludes
  those paths before selecting any symlink target.
- Cleanup keeps the app workspace fixed instead of restoring a document-level
  scrollbar. The group list still replaces four rows at a time. Detail mode
  hides Previous/Next and uses one contained album scroller with sticky month
  headings; the source, filters, and build action remain stationary. The album
  grid auto-fills compact columns, keeps thumbnails uncropped with
  `object-fit: contain`, and puts metadata below each image.
- File-risk copy remains available to assistive technology and as a native
  hover tooltip, while each album card keeps original/thumbnail controls
  below its image without expanding the evidence disclosure.

Preview requests do not carry file bytes over JSON. Rust validates the current
catalog row and a 16 MiB ceiling. Directory images are streamed from the source;
archive images are extracted on demand into a 32-file cache. Electron exposes
at most 128 opaque preview tokens to the sandboxed renderer. Message pages carry
only matching paths, byte counts, and original/thumbnail kinds. The renderer
requests visible pixels afterward with four workers and falls back from an
unsupported original to its thumbnail.

## Known gaps before a desktop release

- Add an in-process cancellation token. Current protocol job IDs, restart-based
  directory/hash resumption, and safe candidate partial cleanup are implemented;
  candidate ZIP output intentionally restarts from zero.
- Port cleanup-plan exports and the remaining analysis UI.
- Coalesce the same normalized chat ID across the main and community databases
  if a future fixture contains one. The current real fixture had zero such
  overlaps; source-aware community listing and message routing are implemented.
- Extend the on-disk FTS5 index with richer tokenization and visible build
  counts. It is already isolated in `search.sqlite` and falls back to `LIKE`.
- Manually regress directory, SQLite, and `.imazingapp` selection plus preview
  rendering through native file pickers on macOS, Windows, and Linux.
- Add a verified universal macOS bundle, Windows signing, Linux packages, and
  update policy. Separate signed/notarized macOS arm64 and x64 packages are
  now built by the release workflow.
- Use `scripts/measure-peak-rss.sh` to record Rust process-tree peak RSS for a
  synthetic large fixture; separate Electron main/renderer measurement remains.
- Repeat iMazing restore checks across more backup variants; one real restore
  path has already been verified, but that does not cover every backup shape.

## Tests

```bash
npm --prefix native/electron test
npm --prefix native/electron audit --omit=dev
node --check native/electron/main.cjs
node --check native/electron/preload.cjs
node --check native/electron/renderer.js
```

`sidecar-client.test.cjs` verifies event/response routing and termination when a
sidecar exceeds the 16 MiB response-line limit.
`renderer-shell.test.cjs` locks the LINE Cheater product name, two-screen
source/Next flow, sidebar destinations, mutually exclusive workspaces, and
unique DOM IDs. It also locks source-aware community selection, native
`isSelf` use, safe HTTP(S)-only external links, bounded URL preview cards,
cleanup-thumbnail zoom, the fixed cleanup viewport, four-group/24-card virtual
batch sizes, a three-batch DOM ceiling, sticky month sections,
aspect-ratio-preserving thumbnails, compact risk descriptions, and absence of
the former three-step scrolling guide. It also checks that macOS
packaging uses the optimized Rust
sidecar, packaged resource path, custom icon, signature verification, DMG
output, and checksums.
`../frontend/data-provider.test.js` verifies page limits, cleanup filter
normalization, source forwarding, detail requests, and group-action validation.
Rust integration tests cover reference semantics, companion/rename title
resolution, sender ownership, source-aware community chat/message pages,
message attachment enrichment, reversible marking, and bounded
directory/archive preview staging.

Never put real backup paths, account IDs, chat titles, message text, attachment
names, work catalogs, or candidates into test snapshots or committed logs.

For a manual UX regression, run `npm --prefix native/electron run dev`, open a
backup read-only, press Next, and choose Cleanup. At the normal window size,
verify that exactly four group rows plus Previous/Next and “建立瘦身
.imazingapp” are visible together without a page scrollbar. Open View on one
group and verify that the grid auto-fills compact columns with uncropped
thumbnails above both file choices. Scroll through at least four
internal batches and confirm month headings remain sticky, Previous/Next stays
hidden, the build action stays in the same window, and the DOM does not grow
beyond 72 review cards. Do not mark files or build a candidate when using a
personal backup for this visual check.
