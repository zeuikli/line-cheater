# Native Core Architecture and Handoff

Last updated: 2026-08-10

This document is the durable handoff record for the bounded-memory desktop version
of LINE Cheater. Keep it updated whenever the native implementation,
data contract, safety rules, or next steps change.

## Recent change summary

The following summarizes the major native, desktop, and release changes from
2026-07-24 through 2026-08-02. Release-only version bumps (`0.1.10` through
`0.1.14`) only synchronized Cargo/Electron metadata and lockfiles; they are
grouped below rather than treated as separate feature changes.

- `2d8a930 Build native app` introduced the Rust workspace, bounded native
  catalog/database/candidate layers, the JSONL sidecar, the Electron shell, the
  renderer provider, and the initial macOS packager.
- `9efeacd Protect originals without thumbnails` tightened cleanup evidence so
  “keep thumbnail” only acts on non-empty image thumbnails with a matching
  original; PDFs, videos, and originals without thumbnails remain protected.
- `3929eaa Fix native pagination and package DMG` corrected forward/backward
  lookahead pagination and cursors, added the self-checking DMG workflow, and
  completed the bounded desktop pagination/layout path.
- `bf2fa93 Cleanup chat and db` added source-aware database cleanup planning and
  rewrites for selected chats/orphan `LineSquare` messages inside the candidate,
  with progress/reporting and read-only source preservation.
- `e7d1586 feat(native): add resumable jobs and FTS5 search` added resumable
  catalog/FTS/duplicate/candidate jobs, job IDs and checkpoints, bounded FTS5
  search with safe SQLite fallback, expanded desktop controls, and a peak-RSS
  measurement script.
- `52bec56 Fix large size issue` hardened large-backup source staging, sidecar
  startup and cancellation behavior, bounded IPC responses, and the generated
  large-fixture regression coverage.
- `0398dcf ci: add manual macOS signing test` added a manual Developer ID
  signing verification workflow. `8cd4c45 ci: notarize macOS DMG releases`
  added passwordless P12 import, `notarytool` submission, ticket stapling,
  validation, and release checksum refresh.
- `ddb3412 ci: merge desktop build and release workflows` (merged by
  `99738d6`) consolidated the per-platform workflows, preserved PR checks, and
  kept Windows release attachment behind successful macOS publication.
- `bc49ddb feat(macOS): add Intel release artifacts` extended the macOS packager
  guard and release flow to native arm64 and x64 runners, signed/notarized
  artifacts, per-arch checksums, and one combined GitHub Release publication.
- `e0f08ff fix(ci): stabilize Pages and Intel checks` upgraded the Pages actions
  to their Node 24-compatible major versions and made sidecar readiness tests
  less timing-sensitive.
- `52fc5a1 fix(release): pass repository to macOS publish` made the no-checkout
  publish job pass the repository explicitly to every `gh release` command.
- `fbec01b` and `8c50949` synchronized the Cargo/Electron version metadata and
  lockfiles for the published `v0.1.13` and `v0.1.14` releases.
- The macOS workflow now runs architecture-independent Rust/Electron checks
  once on arm64, resolves its matrix from the event so push events never start
  an Intel runner, and keeps native arm64/x64 release builds, package
  verification, signing, notarization, and stapling on both architecture
  runners. Packaging can reuse those checks without running the full test suite
  a second time.
- The Windows workflow keeps Electron tests for pull requests and manual runs,
  while the post-macOS `workflow_run` reuses the already-passed cross-platform
  checks and performs only the native Windows build, ZIP assembly, extraction
  verification, checksum validation, and bundled sidecar version check. A
  single Windows job covers every trigger and only the release attachment runs
  separately with write permission.
- Shared CI work lives in `.github/actions/setup-build` (Node, Rust, Electron
  dependencies) plus `native/electron/scripts/verify-macos-package.sh` and
  `native/electron/scripts/import-signing-keychain.sh`, so package
  verification and Developer ID import exist once instead of per workflow. The
  version bump and release publication jobs run on Linux runners because they
  never touch macOS tooling.
- The homepage now exposes separate direct macOS DMG buttons for Apple Silicon
  (`arm64`) and Intel (`x64`), resolves both assets from the latest formal
  GitHub Release, highlights a detected architecture when available, and keeps
  the Windows x64 download alongside them.
- The cleanup chat list now supports direct page-number jumps and preserves the
  overview page when entering a chat detail and returning to the list.
- `0192de2` (`v0.1.19`) was the baseline before the subsequent PR38 and PR39
  native changes.
- PR38 (`d507813`, `c196740`) added explicit authorization for rebuilding a
  corrupt `LineSquare.sqlite` as an empty community database. The fallback is
  limited to confirmed SQLite corruption, preserves the readable schema when
  possible, requires `quick_check=ok`, reports discarded community data, and
  never applies to the primary `Line.sqlite` or modifies the source backup.
- PR39 (`ad14556`, `b76620a`, `bc57e84`, `97c7aaf`) repaired unique
  original/thumbnail context counterparts across Container paths, added
  reversible category-wide attachment and chat actions, and changed large chat
  deletion to one indexed selection plus a single transaction and bounded
  progress updates. Cleanup mutations now expose cancellable progress with
  rollback messaging, lock duplicate submissions, and require confirmation
  before cancelling work or closing operation/app windows.
- `ebd0a80` (`v0.1.25`) is the current release baseline after PR39.
- The current attachment-export flow adds a bounded `exportAttachments`
  sidecar method. It exports selected catalog-authorized paths or one chat's
  referenced attachments from a directory or `.imazingapp`, streams through a
  fixed 1 MiB buffer, verifies cataloged size/mtime and available SHA-256
  content digests, and commits a new output directory only after all files are
  complete. Image-only mode detects common image signatures and reports skipped
  files; originals and thumbnails can be selected independently.
- Export destinations are selected through a one-use Electron token. The main
  process resolves the token to a user-chosen directory, creates a unique
  `LINE-Cheater-Export-*` child, rejects the private session directory, and
  removes the Rust-owned `.partial` output when cancellation or failure
  restarts the sidecar. Direct `Line.sqlite` sources remain export-disabled
  because they contain message metadata but no attachment files.
- `exportConversation` writes the selected chat from its first message through
  its final message into a portable ZIP containing `index.html` and an
  `attachments/` directory. Messages are read with 1,000-row keyset pages and
  the HTML/attachment bytes are streamed directly into the ZIP. Attachment
  size/mtime and available SHA-256 evidence are revalidated; HTML escapes chat,
  sender, and message content. Direct `Line.sqlite` sources produce the same
  complete HTML without attachment files.
- PR45's filtered attachment export keeps the 1,000-path limit for explicit
  selections while allowing browser-filtered exports to exceed it. The limit is
  carried by `ExportOptions`, keeping the public and internal export entry
  points within the CI-enforced Clippy argument limit.
- Attachment cleanup plans now record `manual`, `automatic`, or `chat` evidence.
  Safe automatic attachment cleanup only marks referenced image originals with
  a matching non-empty thumbnail; it never marks PDFs, videos, missing-thumbnail
  originals, or unconfirmed files. Manual marks and safe automatic marks can be
  cleared independently before building the candidate.
- `cleanupPreflight` now performs a bounded, read-only blindspot scan before
  cleanup or candidate creation: SQLite `quick_check`, source/catalog freshness,
  scan/context completion, WAL/SHM presence, unreferenced files, unconfirmed
  files, active jobs, and the current marked/safe-candidate totals are surfaced
  with blocker, warning, or informational severity. `cleanupPlanPreviews` adds
  conservative, balanced, and aggressive previews; only the conservative safe
  image rule is directly auto-applicable, while the other scopes remain
  review-only.
- The desktop cleanup preview now has an explicit plan selector: choosing a
  profile resets the bounded view to all attachment groups on page one and
  collapses the comparison cards until the user asks to change the plan. The
  category cards remain separate focus controls for SQLite-unreferenced and
  unconfirmed review. Non-blocking preflight warnings stay out of the primary
  workspace; only blockers expand the safety panel. Cleanup and chat image
  previews hydrate only near the visible viewport, with at most four concurrent
  native preview requests; the renderer shows FTS5 build progress and the
  verified sidecar session avoids repeating full source-content verification on
  every subsequent search.
- Cleanup actions retain a bounded recent activity history and produce a
  reproducible plan fingerprint from the source fingerprint, removal reasons,
  selected paths, chat-removal plan, and orphan-message plan. This audit data
  remains a native-core compatibility/provenance surface, while the primary
  desktop cleanup workspace keeps the audit panel out of the main flow.
- Candidate creation now opens a restore checklist asking the user to retain
  the original backup, test in a safe environment, and verify chats/images/
  SQLite after restore before the candidate writer starts.
- Category actions expose their current state so the desktop can toggle
  “keep thumbnails”, “delete all attachments”, and Advanced-mode “delete all
  chats” into matching batch-cancel actions. Chat-backed categories support
  thumbnail preservation; unreferenced and unconfirmed categories support only
  attachment deletion.
- The desktop welcome screen discovers at most 100 hash-named session caches.
  It reads `catalog.sqlite` metadata in query-only mode, normalizes Windows
  extended-length source paths, verifies the session/path hash, cache version,
  scan/context completion, source existence, and `.imazingapp` metadata
  fingerprint, then allows complete sessions to reopen without rescanning.
  Invalid, stale, missing-source, and incomplete sessions remain non-selectable.
  The saved-session sidecar starts with `serve --reuse-session`, independently
  rechecks that metadata fingerprint, and skips the otherwise unbounded catalog
  content verification during browsing. Export/search reuse the verified
  process state; candidate creation still performs the full source-content
  validation before output.
- Each welcome-screen Session row has a guarded delete action. It accepts only
  a validated hash-named managed Session directory, shows an indeterminate
  progress dialog, and never removes the original or a generated
  `.imazingapp`. After a candidate passes validation, the desktop asks whether
  to retain that analyzed Session for direct reuse or delete it to reclaim
  space; dismissing the prompt keeps the Session.

## Goal

Browse, search, inspect attachments, and build a slimmed `.imazingapp` from LINE
backups that may be 30–200 GB on a machine with 16 GB RAM.

Input size must affect processing time and required disk space, but must not
determine resident memory usage.

## Architecture decision

The native core owns all large state and filesystem access. HTML/CSS/JavaScript
is a presentation layer that receives small pages of serializable records.

```text
HTML/CSS/JS UI
    │ small IPC requests, pages, and progress events
    ▼
Rust core / CLI
    ├── native read-only SQLite connection
    ├── catalog.sqlite working index
    ├── directory and .imazingapp source adapters
    └── streaming candidate writer
```

The core is a Rust library plus CLI so it is not tied to a desktop shell:

- Implemented preview shell: Electron with the Rust CLI as a long-running
  sidecar. This follows the requested Chromium frontend path and keeps the
  renderer isolated from native files.
- Future lower-baseline alternative: Tauri can implement the same provider and
  protocol if Electron's fixed overhead proves material after measurement.
- The existing GitHub Pages build remains the small-backup/demo provider.

Electron or Tauri alone does not solve the scale problem. The important boundary
is that the renderer never owns a complete SQLite database, complete attachment
list, complete chat, or complete output archive.

## Repository layout

```text
Cargo.toml                 Rust workspace
native/core/               Native library and line-cheater CLI
native/core/src/source.rs  Directory, SQLite, and .imazingapp discovery/staging
native/core/src/database.rs
                           Read-only LINE SQLite queries and cursor pagination
native/core/src/catalog.rs Disk-backed file/attachment catalog and removal plan
native/core/src/model.rs   Serializable IPC/CLI data contract
native/core/tests/core.rs  Generated fixtures; never uses personal chat content
native/frontend/           Renderer data provider, contract tests, and handoff notes
native/electron/           Sandboxed Electron preview and sidecar client
```

Runtime work goes under `.line-reader-work/` by default and is ignored by Git.
Real LINE backups, `.imazingapp` files, SQLite databases, indexes containing
chat content, and generated candidates must never be committed.

## Current implementation status

Verified implementation:

- [x] Rust workspace and native CLI skeleton.
- [x] Detect an unpacked backup directory, direct `Line.sqlite`, or
  `.imazingapp`.
- [x] Prefer the account-specific
  `PrivateStore/P_*/Messages/Line.sqlite` over unrelated LINE databases.
- [x] For `.imazingapp`, extract only `Line.sqlite`, `LineSquare.sqlite`,
  `UnifiedGroup.sqlite`, and their available `-wal`/`-shm` companions to a
  source-fingerprinted staging directory.
- [x] Open source SQLite with `SQLITE_OPEN_READ_ONLY` and `PRAGMA query_only`.
- [x] Bound SQLite page cache and temp behavior independently of database size.
- [x] List main and `LineSquare.sqlite` community chats through one
  `(last_updated, source, pk)` keyset cursor in both directions. Each chat
  carries its source so message pages are routed back to the correct database.
- [x] List messages with a `(timestamp, pk)` keyset cursor in both directions.
- [x] Reject pages larger than 1,000 records.
- [x] Store file metadata, attachment classification, and removal selections in
  a separate `catalog.sqlite`.
- [x] Scan directory entries or ZIP central-directory entries in batches of
  1,000 records.
- [x] Paginate attachment results by catalog row ID.
- [x] Generated unit/integration fixtures for read-only access, cursor behavior,
  catalog persistence, and selective archive staging.
- [x] `cargo fmt --all --check` and `cargo test --workspace`.
- [x] Smoke-test against the ignored local LINE fixture without logging chat
  titles, message text, account IDs, or attachment names.
- [x] Add long-running JSONL sidecar protocol for desktop IPC.
- [x] Add bounded native message search and enrich each attachment page with
  exact `ZMESSAGE.ZID` context when available.
- [x] Add a resumable disk-backed FTS5 index in the private work directory;
  desktop searches use it after a current catalog is verified and retain the
  bounded bidirectional message cursor. Unsupported/invalid index cases fall
  back to the read-only SQLite `LIKE` scan.
- [x] Add streaming SHA-256, size pre-grouping, on-disk checkpoints, and
  duplicate-group/member pages.
- [x] Add initial ZIP64/raw-copy candidate construction and validation.
- [x] Require explicit authorization before replacing confirmed-corrupt
  `LineSquare.sqlite` with an empty, schema-preserving (or minimal) database;
  validate the rebuilt database with `quick_check`, report discarded community
  data, and leave `Line.sqlite` and the source backup untouched.
- [x] Add dependency-free renderer `NativeDataProvider` and tests.
- [x] Add a runnable Electron 43.2.0 preview with a sandboxed preload,
  allowlisted IPC, native source/output dialogs, bounded sidecar parser, chat,
  message, search, attachment, marking, and candidate UI.
- [x] Port the web cleanup workflow: six category summaries, chat/special
  grouping, bounded group/review queries, kind/category/sort/search filters,
  exact/unreferenced/unconfirmed evidence, individual original/thumbnail
  selection, delete-all, and reversible keep-thumbnail actions. The provider
  default remains 24 rows; the fixed desktop viewport requests four group rows
  while detail mode streams 24-review virtual batches.
- [x] Add catalog context repair from a unique, referenced original/thumbnail
  counterpart, including cross-Container group/community paths, and surface
  bounded repair progress during context indexing.
- [x] Add reversible category-wide cleanup actions for all, individual, group,
  community, unreferenced, and unconfirmed categories. Keep-thumbnail actions
  only affect safe image originals; batch attachment cancellation clears manual
  marks while preserving automatic and chat plans.
- [x] Add category-wide Advanced chat deletion/cancellation using the current
  chat index, one SQLite transaction, one attachment scan, 500-record batches,
  and progress events.
- [x] Correlate cleanup paths against both `Line.sqlite` and the same-store
  `LineSquare.sqlite`, including community titles and senders.
- [x] Add a desktop-only advanced mode that plans full-chat deletion, attaches
  source-aware files to that plan, detects empty/system-only chats, and removes
  `LineSquare.ZMESSAGE` rows whose `ZCHAT` no longer exists. SQLite mutation is
  applied only to snapshots inside the new candidate.
- [x] Add bounded local image previews. A preview is catalog-authorized, capped
  at 16 MiB, delivered through a tokenized local protocol, and never serialized
  into JSON. Archive previews are streamed on demand into a 32-file LRU cache.
- [x] Add bounded attachment export for directory and `.imazingapp` sources.
  Explicit catalog paths and source-aware chat scopes stream originals or
  original/thumbnail pairs into a new destination directory; image-only export
  skips non-image files, basename collisions receive deterministic suffixes,
  and progress reports processed files/bytes without sending file contents over
  JSON. Direct `Line.sqlite` export is rejected.
- [x] Match the web chat-name evidence order with `ZUSER`, `LineSquare.sqlite`,
  `UnifiedGroup.sqlite`, `ZGROUP`, and inferred rename-message fallbacks. Chats
  with at least one stored message are shown like the web implementation;
  `humanMessageCount` remains a separate display statistic.
- [x] Resolve message ownership in Rust. A populated sender is “我” only when
  its `ZMID` matches the account ID from `PrivateStore/P_*`; `ZSENDSTATUS=1`
  and `ZMESSAGETYPE=S` are fallback evidence only when the sender is absent and
  the row is not a system event. The renderer consumes this explicit `isSelf`
  field instead of guessing.
- [x] Attach catalog-authorized original/thumbnail paths to bounded message
  pages and render chat images on demand. At most four previews are hydrated
  concurrently; image bytes never enter JSON or a complete-chat array.
- [x] Linkify credential-free HTTP(S) URLs in Electron chat messages, render up
  to four local domain/title preview cards per message, and open them through a
  main-process `shell.openExternal` bridge. Renderer navigation and non-HTTP(S)
  schemes stay blocked.
- [x] Render cleanup detail as a bounded iOS Photos-style album: continuous
  scrolling, sticky month sections, 24-review native batches, at most three
  adjacent batches/72 cards in the DOM, virtual spacers for discarded pages,
  aspect-ratio-preserving thumbnails, and message/file information below each
  image. Loaded thumbnails are keyboard-focusable zoom buttons that open the
  existing full-size image modal.
- [x] Port the web-style blocking load/package progress dialogs and chat/message
  panel layout, including incoming/outgoing/system bubbles and full-size image
  preview.
- [x] Present the desktop product as LINE Cheater with a two-screen native app
  shell: source selection and preparation first, an explicit Next action, then
  a persistent sidebar that switches between mutually exclusive Browse,
  Cleanup, and exact Duplicate Review workspaces.
- [x] Lead the welcome screen with `.imazingapp` and label it `推薦`; keep the
  unpacked backup directory as the secondary choice and hide the diagnostic
  direct-`Line.sqlite` picker from the end-user UI.
- [x] Reuse the packaged folder/chat/shield app icon in the welcome header and
  workspace sidebar so in-app branding matches the macOS application icon.
- [x] Replace the document-scrolling cleanup screen with a fixed-height native
  workspace. Header, filters, category strip, pagination, and candidate action
  stay in place while four group rows replace the center window. Detail mode
  removes the category/warning strips and pagination, then uses a contained
  virtual album scroller that preserves image proportions and puts the default
  original/thumbnail controls below the image.
- [x] Add a repeatable macOS arm64/x64 packager that bundles the optimized Rust
  sidecar, custom icon, signature, ZIP, DMG, and SHA-256 checksums.
- [x] Add Windows x64 GitHub Actions packaging and release workflows that bundle
  the Windows Rust sidecar, native icon, ZIP, and SHA-256 checksums.
- [x] Add user-visible cancellation for catalog, duplicate hashing, and
  candidate creation. Cancellation terminates and recreates the sidecar,
  resumes committed directory-scan batches and duplicate-hash checkpoints,
  and removes partial candidate output.
- [x] Add a locked cleanup-mutation modal with phase/count progress, explicit
  rollback messaging on cancellation, and confirmation before cancelling
  cleanup/database work or closing the main window and result dialogs.
- [x] Add protocol-level `jobId` values and persisted active-job metadata for
  catalog, FTS index, duplicate hashing, and candidate jobs. Candidate output
  remains restart-from-zero because ZIP central-directory writes cannot be
  safely resumed in place.
- [x] Replace the generated SVG icon with the supplied folder/chat/shield
  artwork normalized to a full-bleed 1024 × 1024 macOS PNG master. The source
  has no black corner matte or pre-applied system mask; packaging validates its
  dimensions and derives all ten legacy `.iconset` sizes before building the
  `.icns`.
- [x] Add Developer ID signing and Apple notarization for macOS release DMGs.
- [x] Add separate Intel x64 and Apple Silicon arm64 package jobs, with
  per-architecture verification and a single combined release publication.
- [ ] Complete a verified universal macOS bundle, Linux packages, and Windows
  signing. Separate macOS architectures are intentionally published first so
  each Rust sidecar and Electron runtime is built natively.
- [x] Port exact duplicate review into the desktop UI; cleanup-plan exports and
  the remaining analysis UX are still pending.
- [x] Add separate manual and safe-automatic attachment cleanup controls,
  persisted removal reasons, independent manual-plan clearing, and bounded
  cleanup evidence in the renderer.
- [x] Add cleanup-before-action blindspot scanning, conservative/balanced/
  aggressive plan previews, blocker-gated candidate creation, and a candidate
  verification report showing CRC, protected-file, SQLite-rewrite, output, and
  warning results.
- [x] Add bounded cleanup activity history, reproducible plan fingerprints,
  copyable plan summaries, and a three-step restore checklist before candidate
  creation.
- [x] Gate exact-duplicate scanning and cleanup behind desktop Advanced mode,
  add catalog-authorized group previews, and let the candidate writer replace
  retained duplicate members with verified relative ZIP symbolic links.
  Removal plans are applied first: a canonical target is selected only from
  surviving members, and groups with fewer than two survivors produce no link.
- [x] Validate a native candidate through an actual iMazing restore; repeat this
  across more backup variants before calling the ZIP64 writer production-safe.
- [x] Add a >65,535-entry ZIP64 candidate stress fixture and a process-tree
  peak-RSS measurement script. A >4 GiB single-entry test still requires a
  dedicated sparse-file runner.

### Latest verification record

2026-08-03:

- The attachment export fixture passed for both an unpacked directory and a
  `.imazingapp` archive. It exported image content without changing the
  read-only source, omitted thumbnails when requested, and left no `.partial`
  directory after success.
- Native tests: 41 passed (2 unit, 39 integration); Electron/provider/shell
  tests: 71 passed. `cargo fmt --all --check`, `cargo check --workspace`, and
  JavaScript syntax checks passed. The test suite covers bounded export input
  validation, destination-token wiring, progress/cancellation UI wiring, and
  directory/archive export behavior. No personal backup contents were logged.

2026-07-27:

- Rust: 1.96.0.
- Native tests: 33 passed; the combined Electron/provider test command: 63
  passed. The sidecar fixture covers the new preflight and three plan-preview
  responses plus cleanup audit history; the renderer shell checks the new
  blindspot, audit, candidate-report, restore-checklist, plan-selection, and
  lazy-preview controls.
- Electron: 43.2.0 pinned; `npm audit` reported 0 vulnerabilities.
- Ignored real fixture: 1.1 GB, 13,512 files, 11,239 classified attachments.
- Catalog scan: approximately 0.36 seconds on the current machine.
- Native SQLite: opened an 88 MiB account database read-only.
- Chat page: 25 bounded records with a continuation cursor.
- Message page: 180 bounded records with a continuation cursor; duplicate
  timestamps remained correctly ordered by primary key.
- JSONL sidecar: protocol v1 opened the real fixture read-only, returned
  `quick_check=ok`, observed the existing 13,512-row catalog, and shut down
  cleanly.
- Ignored real `.imazingapp`: 13,506 entries and 11,239 classified attachments
  were scanned from its central directory. Browsing stages only the main,
  community, and unified-group SQLite companions instead of copying the 1.0 GB
  archive.
- Duplicate pre-grouping selected 4,089 same-size attachment files totaling
  49,074,066 bytes. Streaming SHA-256 completed in approximately 3.1 seconds;
  an immediate second run selected 0 files, confirming the on-disk checkpoint.
  The first duplicate page contained 20 groups and a continuation cursor.
- Generated directory and `.imazingapp` candidates preserved one canonical
  regular attachment, replaced remaining exact survivors with relative ZIP
  symlinks, excluded already-marked members before choosing the target, and
  emitted no links when every member was removed. These are structural fixture
  checks, not a claim that iMazing has restored the symlink candidates.
- A no-match native message search over the 88 MiB SQLite completed in
  approximately 0.5 seconds. In the first 100 real attachment rows, 85 received
  an exact message context without exposing any private field in the test log.
- Electron directory GUI smoke: `quick_check=ok`; 100 chat rows, 180 message
  rows, and 100 attachment rows stayed within their page windows; the first
  attachment page had 85 linked and 15 unlinked contexts. Apple-reference
  `ZCHAT` timestamps were normalized for display instead of appearing 31 years
  early.
- Production web comparison on the same directory fixture: 221 chats, 925,868
  messages, 11,239 attachments, and 59 cleanup groups across 3 pages.
- Source-aware desktop browsing returned the same 221 nonempty chats: 202 from
  the main database and 19 from `LineSquare.sqlite`, with 20 chats presented as
  communities after title enrichment. Fifteen system-only chats account for
  the earlier desktop undercount. There were zero duplicate cross-source chat
  IDs in this fixture.
- Across the first bounded message page of every real chat, main-database
  messages included both self and other senders (4,857 / 11,501); community
  pages contained 3,342 other-sender rows and were no longer mislabeled as
  “我”. Only aggregate counts were recorded.
- Electron + Rust cleanup comparison on that directory: 11,239 attachments,
  59 groups, and the same six-category totals after `LineSquare.sqlite`
  support was added. The current fixed desktop UI presents 15 four-row group
  pages. A real group detail page kept original/thumbnail checkboxes separate;
  the current renderer requests 24-review batches and virtualizes the continuous
  month-sectioned album instead of exposing those pages to the user.
- After title-evidence parity was added, the first 100 real main-database chats
  had zero raw-ID fallbacks; 18 titles came from `UnifiedGroup.sqlite`. Across
  58 referenced attachment chats, zero cleanup group titles fell back to the raw
  chat ID. Only aggregate counts were logged.
- A targeted real message-page check returned one referenced image message with
  two catalog-authorized variants (original and thumbnail), confirming the
  message/image route without logging private paths or content.
- The real `.imazingapp` sidecar produced the same aggregate cleanup result:
  11,239 attachments and 59 groups. A provider-default query still returns
  three 24-row pages, while the current fixed desktop UI returned 15 pages and
  four groups on page one. Community and unreferenced totals also matched the
  directory run. Its session reported both `lineSquareLoaded` and
  `unifiedGroupLoaded`. A second read-only browse check returned the same 221
  chats and 20 community labels, and successfully routed a 180-row community
  message page through the archive-staged `LineSquare.sqlite`.
- The Electron directory picker, two-screen welcome/Next flow, persistent
  sidebar, mutually exclusive Browse/Cleanup views, cleanup group list, category
  summaries, pagination, review cards, and real image pixels were GUI-tested.
- Safe automatic cleanup fixture coverage confirmed that only the referenced
  image original with a matching non-empty thumbnail is selected, that manual
  clearing leaves automatic plans independently controllable, and that the
  source remains untouched.
  No removal checkbox or candidate build was triggered during this read-only
  visual pass. Manually regress native pickers and image rendering on every
  release target.
- The fixed cleanup viewport was GUI-tested again with the real `.imazingapp`:
  the default view kept four group rows, pagination, and the candidate action
  visible without a document scrollbar. That pass used the earlier two-card
  detail layout; it established data and image parity before the continuous
  virtual album presentation replaced it. No removal checkbox or candidate build was
  triggered.
- The current packaged app was GUI-tested with a generated, non-private
  directory fixture. A plain HTTP(S) message produced both a focusable link and
  a bounded preview card; the external URL was deliberately not opened. The
  cleanup detail rendered its uncropped image above the sender/time/file
  controls, and clicking it opened and closed the shared full-size image modal.
  That test predated continuous scrolling; it remains the zoom/link fixture,
  while the month-sectioned virtual-window behavior is covered separately.
- The continuous album was then GUI-tested read-only against the ignored real
  `.imazingapp`, recording only aggregates. A 612-review group opened with
  `1–24 / 612`, no detail Previous/Next controls, and a sticky month heading.
  Scrolling loaded `1–48`, then crossed a month boundary and reported
  `25–96 / 612`: this demonstrates forward batch loading and eviction of the
  first 24-card page while the three-page/72-card window remained bounded. No
  removal checkbox or candidate build was triggered.
- Generated candidate fixtures verify directory streaming, archive raw-copy,
  explicit attachment removal, complete CRC reads, and protected core hashes.
- The initial macOS arm64 preview package embedded an arm64 optimized Rust
  sidecar and Electron runtime. The 281 MiB app, 118 MiB ZIP, and 132 MiB DMG
  passed deep ad-hoc signature verification, ZIP entry validation, DMG CRC
  verification, bundled-sidecar execution, and SHA-256 generation. The
  packaged app was launched through macOS and reached the LINE Cheater
  welcome/source screen without loading a personal backup.
- The published `v0.1.12` release completed the Developer ID signing and Apple
  notarization flow for the arm64 DMG. The Intel x64 package path is now
  automated in the release workflow and will be validated as a separate native
  runner build rather than by cross-compiling the arm64 artifact.
- That initial preview artifact was not Developer ID signed or notarized; the
  published `v0.1.12` arm64 release is the signed and notarized public build.
- The process-tree RSS script measured the complete 30-test native suite,
  including the >65,535-entry ZIP64 fixture, at a peak of 132,752 KiB. This is
  a synthetic test-suite figure, not a 200 GB backup acceptance result; the
  production fixture matrix still needs separate directory/archive runs.

Do not assume checked items are production-ready. The project must pass the
verification gates below before a release.

## CLI contract

All successful command results are JSON on stdout. Progress and warnings go to
stderr so a desktop wrapper can parse stdout safely.

```bash
# Inspect structure without reading chat content.
cargo run -p line-cheater -- \
  inspect --source /path/to/LINE

# List the first page from the main database. The desktop uses `serve` below to
# merge source-aware main/community pages.
cargo run -p line-cheater -- \
  --work-dir /path/to/work \
  chats --source /path/to/LINE --limit 100

# Resume the main-database CLI page using both CLI cursor components.
cargo run -p line-cheater -- \
  --work-dir /path/to/work \
  chats --source /path/to/LINE --limit 100 \
  --after-updated 1700000000000 --after-pk 42

# Read one bounded message page.
cargo run -p line-cheater -- \
  --work-dir /path/to/work \
  messages --source /path/to/LINE --chat-pk 42 --limit 180

# Search message text with a bounded result page. This initial implementation
# CLI search remains a bounded read-only LIKE query; desktop serve builds the
# disposable FTS5 index after catalog verification.
cargo run -p line-cheater -- \
  --work-dir /path/to/work \
  search --source /path/to/LINE --query "keyword" --limit 180

# Build/update the on-disk file catalog.
cargo run -p line-cheater -- \
  --work-dir /path/to/work \
  catalog --source /path/to/LINE

# Page attachment metadata without loading attachment contents.
cargo run -p line-cheater -- \
  attachments --catalog /path/to/work/catalog.sqlite --limit 100

# Hash only same-size duplicate candidates with fixed-size buffered reads.
cargo run -p line-cheater -- \
  hash-duplicates \
  --source /path/to/LINE.imazingapp \
  --catalog /path/to/work/catalog.sqlite

# Page exact-content duplicate groups, then page one group's members.
cargo run -p line-cheater -- \
  duplicates --catalog /path/to/work/catalog.sqlite --limit 100
cargo run -p line-cheater -- \
  duplicate-members \
  --catalog /path/to/work/catalog.sqlite \
  --sha256 <digest-from-duplicates> \
  --limit 100

# Start the long-running desktop sidecar.
cargo run -p line-cheater -- \
  --work-dir /path/to/work \
  serve --source /path/to/LINE

# Build a new candidate from an already-scanned source.
cargo run -p line-cheater -- \
  slim \
  --source /path/to/LINE.imazingapp \
  --catalog /path/to/work/catalog.sqlite \
  --output /path/to/LINE-slim.imazingapp \
  --link-duplicates \
  --full-crc
```

`--link-duplicates` is the experimental CLI equivalent of the desktop
Advanced-mode option and requires a completed exact-duplicate hash scan.
The CLI never silently replaces corrupt community data; after reviewing the
failure, rerun with `--allow-corrupt-line-square-rebuild` to grant the same
authorization that the desktop confirmation dialog requests.

CLI cursor components are an atomic pair. Supplying only one component is an
error. The sidecar's chat cursor additionally includes `source`; renderer code
must round-trip the complete opaque cursor. The desktop sidecar accepts either
`cursor` (next page) or `beforeCursor` (previous page), returns `hasPrevious`,
and the UI replaces old bounded windows instead of accumulating every returned
page. Queries fetch one extra row so an exact multiple of the page size does
not expose a phantom next page.

## Sidecar protocol v1

`serve` reads one JSON request per line from stdin and writes responses/events
as JSON Lines to stdout. Each line is flushed immediately.

Ready event:

```json
{"event":"ready","protocolVersion":1,"source":{},"readOnly":true}
```

Preparation events precede `ready` whenever a `.imazingapp` must be staged. The
staging fingerprint is metadata-only, entry lookups use the in-memory central
directory, and interrupted-operation recovery is left to the explicit
`recoverInterruptedOperations` request, so readiness never waits on work that
scales with the archive size:

```json
{"event":"sourcePrepareProgress","phase":"reading_archive_index","entry":null,"stagedBytes":0,"totalBytes":0}
{"event":"sourcePrepareProgress","phase":"staging_databases","entry":"Line.sqlite","stagedBytes":16777216,"totalBytes":2147483648}
```

Request and success response:

```json
{"id":"42","method":"listMessages","params":{"source":"square","chatPk":7,"limit":180}}
{"id":"42","ok":true,"result":{"items":[],"nextCursor":null,"hasPrevious":false}}
```

Structured error:

```json
{"id":"42","ok":false,"error":{"code":"operation_failed","message":"..."}}
```

Supported methods:

- `sessionInfo`
- `listChats`
- `listMessages`
- `searchMessages`
- `scanCatalog`
- `listAttachments`
- `exportAttachments`
- `exportConversation`
- `setAttachmentMarked`
- `stageAttachmentPreview`
- `catalogStats`
- `cleanupOverview`
- `cleanupCategoryActionState`
- `cleanupPreflight`
- `cleanupPlanPreviews`
- `cleanupAudit`
- `clearManualAttachmentPlan`
- `clearAllRemovalPlans`
- `listCleanupGroups`
- `listCleanupReviews`
- `applyCleanupGroupAction`
- `applyCleanupCategoryAction`
- `setCleanupCategoryChatsRemovalPlanned`
- `planSafeAttachmentCleanup`
- `advancedCleanupReport`
- `setChatRemovalPlanned`
- `planAutomaticCleanup`
- `clearAdvancedCleanupPlan`
- `hashDuplicateCandidates`
- `listDuplicateGroups`
- `listDuplicateMembers`
- `buildCandidate`
- `shutdown`

`scanCatalog`, `searchMessages`, `hashDuplicateCandidates`, `buildCandidate`,
`exportAttachments`, and `exportConversation`
may receive a top-level UUID `jobId`. Progress events echo both `requestId` and
`jobId`; successful responses echo the job ID as well. `scanCatalog` may emit
`catalogProgress` and `catalogContextProgress`, search-index construction emits
`searchIndexProgress`, duplicate hashing emits `duplicateHashProgress`, and
`buildCandidate` emits `candidateProgress`; cleanup mutations emit
`cleanupMutationProgress` with a phase and processed/total record counts;
`exportAttachments` emits `exportProgress` with processed/total files and
bytes. `exportConversation` emits `conversationExportProgress` with separate
message, attachment, and byte totals. Input lines larger than 1 MiB are
rejected. Output pages remain subject to the 1,000-record core limit.

Protocol v1 still processes one request at a time. Desktop cancellation kills
the sidecar, then reopens the same source/work directory: committed directory
scan batches resume after their last ordered path, committed duplicate hashes
are retained, and candidate partial output is removed and rebuilt from zero.
The catalog persists active job IDs so a restart can distinguish resumable scan
and hash work from stale search/candidate jobs. A broken stdout pipe aborts
candidate construction and removes the core-owned `.partial` file.

## Electron desktop boundary

See [`native/electron/README.md`](native/electron/README.md) for run commands,
security details, the web/native comparison, packaging expectations, and GUI
handoff gaps.

The Electron renderer runs with context isolation, sandboxing, no Node
integration, no permissions, and no arbitrary navigation. A custom local
protocol serves an allowlist of bundled assets and catalog-authorized preview
tokens. The preload exposes only source selection, one-use candidate/export
destination tokens, bounded attachment-preview requests, allowlisted sidecar
requests, and allowlisted progress event types. The main process validates the
sender and caps request/response lines before parsing.

Development work directories are source-path-hashed subdirectories under the
Electron `userData/sessions` directory. They may contain staged SQLite and chat
metadata and therefore must be treated as private local application data. Each
session carries the current `LINE Cheater` application version. A missing,
invalid, or different version marker causes that source session to be deleted
and rebuilt before the sidecar opens it. After a candidate `.imazingapp`
finishes full validation, Electron closes the sidecar and deletes the complete
per-source session, including catalogs, search indexes, staged databases, and
preview files. Candidate output paths inside that internal session are rejected
so successful output cannot be removed with the cache.

## Bounded-memory invariants

These rules are part of the product contract:

1. Never call an equivalent of `read_to_end()` for a database, attachment, or
   archive.
2. Never return unbounded query results over CLI/IPC.
3. Never send attachment bytes through JSON. Use a bounded thumbnail endpoint or
   a native/custom protocol.
4. Never hold all backup paths in a Rust `Vec` or JavaScript array.
5. Batch catalog writes. The initial batch size is 1,000.
6. Hash files with a reusable fixed-size buffer and bounded concurrency.
7. Write output to a new `.partial` file and rename only after validation.
8. Attachment exports and candidate builds write to a new output path; the
   original source is read-only and is never the output destination.
9. If WAL/SHM are present, preserve and stage them with `Line.sqlite`. Do not use
   SQLite `immutable=1` unless the snapshot has been proven frozen.
10. Do not add indexes or FTS tables to the source database. Put derived indexes
    in the work directory.

## Catalog behavior

`catalog.sqlite` is disposable derived data, not a backup.

It contains:

- `meta`: source identity and scan state.
- `files`: path, size, timestamp, attachment classification, message ID hint,
  chat path hint, persisted SQLite evidence/reference status, scan generation,
  and an optional exact-content SHA-256.
- `removal_plan`: explicit user selections only.
- `cleanup_bulk_action`: persistent delete-all intent for category and group
  controls.
- `cleanup_keep_thumbnail_group`: persistent per-group thumbnail-protection
  intent, kept separate from the resulting file marks so delete-all and
  keep-thumbnail can remain independently reversible, including when a group
  has only unpaired thumbnails.
- `chat_removal_plan` and `chat_removal_files`: source-aware chat/database
  deletion selections and their derived attachment paths, including exact
  database references and files whose path identifies the selected chat.
- `orphan_message_removal_plan`: exact `LineSquare.ZMESSAGE.Z_PK` rows confirmed
  to have no matching `ZCHAT`.
- `cleanup_activity`: the most recent 500 cleanup actions, including operation
  scope, bounded counts/bytes, and timestamps. `cleanupAudit` returns this
  bounded history together with a SHA-256 plan fingerprint; the fingerprint is
  recomputed from the current source and plan rather than treated as an
  authorization token.

A catalog is bound to one canonical source path. Reusing it for another source
is rejected. Directory sources store a deterministic recursive metadata manifest
and a streaming SHA-256 for every cataloged file; archive and SQLite sources
store the same content digest for each entry. A later session first compares
metadata and then verifies the stored content digests before allowing cleanup,
search indexing, or candidate creation. This catches a file replaced with
identical size and mtime. It does make source verification proportional to the
backup size, so it is intentionally done only at operation boundaries and not
for every rendered row.

Scans commit every 1,000 records. An interrupted directory scan leaves valid
committed batches and resumes after its last ordered path when the already
cataloged content still matches. Duplicate hashes are committed every 100
files and resume from rows whose hash is still null. If a source change is
detected, cleanup plans and derived hashes are invalidated and a complete scan
is required. Cleanup-context schema version 5 includes companion-database
titles, the source database for every exact attachment context, and repairs
from a unique referenced original/thumbnail counterpart when one side is
missing context. This repairs group/community attachments even when the two
files use different Container roots. Older complete catalogs are reported as
stale and reindexed automatically.

Duplicate hashing first selects attachment rows whose positive byte size occurs
more than once, then reads each candidate with one reusable 1 MiB buffer. If a
hash job fails because the source changes or the callback reports an error, the
partial duplicate cache is cleared; a process cancellation is different because
the committed batches remain resumable. Directory rescans preserve a hash only
when the stored content digest is unchanged; a changed archive source
fingerprint clears cached hashes.
The duplicate-group query requires equal SHA-256 and byte size, reports
reclaimable bytes as `(file_count - 1) * bytes`, and is cursor-paginated.
The desktop presents that number as theoretical linkable capacity. Duplicate
groups carry one catalog-authorized preview path; image bytes remain outside
JSON and use the same bounded tokenized preview bridge as cleanup albums.

Duplicate linking is enabled by a reversible “merge all automatically” button
inside the Advanced-gated duplicate workspace. Candidate
planning first loads the complete union of individually marked and chat-plan
removals. For each exact-content group it then ignores every removed path,
prefers referenced members and then original attachments among the survivors
as the deterministic canonical file, and emits relative symbolic links for the
remaining survivors.
Zero or one survivor emits no link. Candidate validation requires every planned
link to remain a symlink, contain the exact relative target, and resolve to a
retained regular archive entry; the report separately records linked entry and
source-byte counts.

The content digest is deliberately separate from the optional duplicate-group
digest: it protects source identity even when a file is not an attachment
candidate. If an older catalog has no content digests, it is treated as stale
and must be scanned again rather than silently trusted. Candidate construction
still performs independent copy-time stability and protected-core checks.

### Cleanup parity contract

These behaviors intentionally match the web implementation and are protected by
generated fixture tests:

- Nonempty main and community chats share a source-aware keyset page. A selected
  chat's `source` must be sent with every list/search message request.
- Sender ownership is native-derived from the backup account ID plus the sender
  record. A send-status flag cannot override a populated sender belonging to
  another participant.
- An attachment is `referenced` only when its path chat ID and message ID match
  exactly one message in `Line.sqlite` or `LineSquare.sqlite`.
- A valid chat/message path whose message ID does not exist in either database
  is `unreferenced`.
- A missing path component, missing message ID, duplicate exact match, or a
  message ID found in a different chat is `unconfirmed`.
- Referenced files group by chat. All unreferenced files share one special
  group; all unconfirmed files share another.
- Provider group and review pages default to 24 items and retain a 1,000-file
  safety ceiling. Electron requests four groups for the paged group list. Its
  detail album fetches 24 reviews at a time, retains at most three adjacent
  batches, and replaces discarded DOM with measured virtual spacers; source
  size therefore does not determine renderer DOM size.
- Original attachments sort before thumbnails within a bundle and retain
  independent removal checkboxes.
- `toggle_all` normally marks every file and requires a destructive-action
  confirmation. If `keep_thumbnail` is also active, every non-empty thumbnail
  stays unmarked while all other attachments are marked. Cancelling either
  action preserves the other action's result.
- `keep_thumbnail` protects every non-empty thumbnail in the selected scope
  without requiring an original or SQLite-message match. Pairing is used only
  to decide which SQLite-confirmed image originals are safe to mark. PDFs,
  videos, missing- or empty-thumbnail originals, and unconfirmed originals
  remain untouched unless another cleanup action marks them.
- Category-wide `keep_thumbnail` and `clear_keep_thumbnail` actions are limited
  to `all`, `individual`, `group`, and `community`; they skip chats already
  planned for deletion. Category-wide `delete_all` and `clear_delete_all` also
  support `unreferenced` and `unconfirmed`, clear only manual attachment marks
  when cancelled, and preserve automatic or chat-derived plans. Delete-all
  includes original images, thumbnails, videos, PDFs, audio, and other
  attachments, but every non-empty thumbnail is protected whenever
  keep-thumbnail is active in the same scope.
- Category-wide chat deletion is limited to `all`, `individual`, `group`, and
  `community`, uses the current catalog chat index when available, selects
  chats once, scans attachments once, and commits the resulting chat and file
  plan in one SQLite transaction with 500-record progress batches.
- Manual attachment marks persist with `reason = manual`; safe automatic marks
  persist with `reason = automatic`; chat-removal-derived marks remain
  `reason = chat`. The overview and renderer expose these sources separately,
  and clearing manual marks cannot remove automatic or chat plans.
- Before candidate creation, the preflight treats an unhealthy SQLite check,
  stale catalog, incomplete scan, incomplete context index, or writable source
  as a blocker. Unreferenced and unconfirmed attachments are warnings and are
  shown in balanced/aggressive previews as review-only items.
- Every cleanup mutation reports `cleanupMutationProgress`; the desktop locks
  related controls, asks for confirmation before cancellation or closing, and
  reports that uncommitted SQLite changes were rolled back when cancelled.

The UI filters `all/original/thumbnail/marked`, categories
`all/individual/group/community/unreferenced/unconfirmed`, sorting
`recent/oldest/size/path`, and search across chat title, sender, message text,
and attachment path. Filtered pages are queried from `catalog.sqlite`; the
renderer never materializes the complete attachment collection.

Image previews are separate from cleanup metadata. The sidecar validates the
path against the current catalog and rejects files over 16 MiB or unsupported
image signatures. Directory previews stay at their source path. Archive
previews are streamed to a source-private cache containing at most 32 files.
Electron maps the validated local file to an opaque preview token and retains at
most 128 live tokens. `listMessages` and `searchMessages` add only the matching
catalog path, byte count, and original/thumbnail kind to each bounded result;
the renderer hydrates image pixels afterward with at most four concurrent
requests.

## SQLite safety and performance

The source connection uses:

- `SQLITE_OPEN_READ_ONLY`
- `PRAGMA query_only=ON`
- a hardware-scaled, bounded suggested page cache
- file-backed temporary storage
- a bounded memory-mapping ceiling

The native core detects logical CPU availability and physical memory once per
process. A low-memory two-core machine stays near the original 64 MiB main
SQLite cache and one archive worker. Larger systems scale gradually, with hard
ceilings of 12 archive workers, a 4 GiB main SQLite cache, a 16 GiB mmap request,
eight SQLite auxiliary workers, and a 1 GiB catalog cache. SQLite allocates
page-cache memory on demand; these are ceilings rather than eager reservations.
`sessionInfo.performance` reports the detected resources and selected worker
counts.

`.imazingapp` catalog scans and persisted-catalog content verification process
independent ZIP entries through that bounded worker pool. Each worker has its
own archive reader and SHA-256 state, while one catalog connection remains the
only writer. The source metadata fingerprint is checked again after parallel
work so an archive changed during validation is rejected. A single large
deflated entry, such as `Line.sqlite`, is one ZIP stream and cannot itself be
split safely across cores; parallelism primarily accelerates archives with many
independent database, attachment, and metadata entries.

Message pagination is keyset-based:

```sql
WHERE ZCHAT = ?
  AND (
    timestamp > ?
    OR (timestamp = ? AND Z_PK > ?)
  )
ORDER BY timestamp, Z_PK
LIMIT ?
```

Previous-page requests invert the comparison and sort order, then reverse the
bounded result before returning it. Search pages use the same bidirectional
`(timestamp, pk)` cursor contract.

LINE schema differs by version, so query construction checks table columns
before referring to optional fields. New schema variants must be added with
fixtures and must preserve fallback behavior.

During the attachment scan, the core now aggregates chat statistics with a
bounded set of source-table scans and persists the derived rows in
`catalog.sqlite`. Chat paging then uses the disposable catalog index instead of
running per-chat counts against `ZMESSAGE`. This avoids repeated full scans on
LINE databases that do not have an index beginning with `ZMESSAGE.ZCHAT`.
Direct-SQLite diagnostic sessions and pre-scan requests retain the compatible
read-only query fallback. The source database is never modified to add an index
or cache table. A persisted chat index is served only after the current session
has completed the existing source/catalog content verification; a changed or
unverified source falls back to the read-only source query until the derived
index is rebuilt.

`searchMessages` uses a disposable `search.sqlite` FTS5 database in the work
directory after the catalog's source content has been verified. The index copies
message text and the bounded result fields in a transaction, binds its metadata
to the catalog source fingerprint, and can be rebuilt safely after interruption.
Search results keep the same `(timestamp, pk)` forward/backward cursor and
1,000-row limit. FTS queries use unicode61 token/prefix matching; if FTS5 is
unavailable, the source schema is unusual, or the index query fails, the core
falls back to the escaped read-only SQLite `LIKE` implementation. Neither path
creates tables or indexes in the original LINE databases.
After the session's initial source verification succeeds, later FTS searches
reuse that session boundary instead of hashing every catalog entry again. A
new catalog scan or source replacement still resets the verification state;
explicit cleanup preflight and candidate creation retain their own full source
verification gates. The Electron renderer surfaces `searchIndexProgress` during
the first index build so a large first search is observable rather than looking
like a frozen message panel.

`scanCatalog` extracts numeric message ID hints from media filenames and
correlates attachment rows in 200-ID batches against both message databases.
The derived evidence is persisted in `catalog.sqlite`, so every later cleanup
page is a bounded catalog query rather than repeated source-database joins.
Missing or ambiguous context remains explicitly unconfirmed; it is never
evidence that a file is safe to delete.

## `.imazingapp` plan

Archive browsing and slimming must support ZIP64. The candidate builder should:

1. Read the central directory without extracting media.
2. Validate every requested removal path and protect `.lock`, payload metadata,
   iMazing root metadata, and SQLite unless an explicit advanced plan requests a
   database rewrite.
3. Raw-copy retained compressed entries where possible.
4. Write a new `<name>.imazingapp.partial`.
5. Emit cancellable progress based on bytes.
6. Finish ZIP64 central-directory records.
7. Verify structure/CRC, unchanged protected-core hashes, and exact hashes of
   rewritten SQLite snapshots.
8. Atomically rename to the requested candidate name.
9. Reconfirm that the source fingerprint did not change.

ZIP64 library support does not prove that iMazing accepts the exact metadata.
Keep a fixture matrix and perform iMazing restore tests before claiming
compatibility.

The initial implementation now performs these steps with the following explicit
limitations:

- `.imazingapp` inputs raw-copy compressed entries; directory inputs write
  uncompressed entries.
- Advanced plans use SQLite's online-backup API to create a consistent snapshot,
  delete exact planned chats/messages in a transaction, run `VACUUM` and
  `quick_check`, write the snapshot as the candidate database entry, and omit
  stale WAL/SHM sidecars. The selected source remains byte-for-byte untouched.
- If a `LineSquare.sqlite` rewrite fails due to confirmed SQLite corruption, the
  first desktop build attempt pauses for explicit confirmation. Once authorized,
  the builder recreates an empty database from the readable source schema (or a
  minimal `ZCHAT`/`ZMESSAGE` schema), requires `quick_check=ok`, and reports the
  discarded community data as a warning. This fallback is deliberately not
  applied to `Line.sqlite`.
- Advanced duplicate linking writes Unix symbolic-link entries into the ZIP.
  Generated directory and `.imazingapp` fixtures verify link type, relative
  target, removal-first planning, all-members-removed behavior, CRC, and
  canonical-target retention. This is still an experimental compatibility mode:
  successful iMazing import and physical-device restore must be verified on
  macOS and Windows before claiming that links survive every restore pipeline.
- Non-UTF-8 paths, entry names that cannot round-trip byte-for-byte, encrypted
  entries, duplicate entry names, and unsafe relative paths are rejected instead
  of silently rewritten.
- `--full-crc` reads the entire output after writing and therefore adds one full
  sequential pass.
- The current `zip` crate writer holds central-directory metadata in memory.
  Media bytes are streamed, but memory will still grow with the number and
  length of entry names. Add a disk-backed central-directory writer before
  claiming bounded memory for multi-million-entry inputs.
- Source archives are checked by size/mtime plus protected core hashes.
  Directory files are checked before and after each copy; additions/removals
  concurrent with traversal are not yet covered by a complete manifest lock.

## Verification gates

Run before every handoff:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm --prefix native/electron test
npm --prefix native/electron audit --omit=dev
python3 -m unittest cli.tests.test_line_migrator
git diff --check
```

Current-machine note: the Homebrew `clippy-driver --print sysroot` unexpectedly
resolves to an old Theos iPhone SDK. The 2026-07-24 Clippy gate passed only after
temporarily setting `RUSTFLAGS=--sysroot=/opt/homebrew/Cellar/rust/1.96.0`.
This is a local toolchain problem, not a repository setting; do not commit that
absolute path.

Real-data smoke tests must use ignored local inputs and a temporary work
directory. Record only aggregate counts, durations, peak RSS, and errors; never
paste chat titles, message text, account IDs, attachment names, or absolute
private paths into commits or issue reports.

The large-data acceptance test should eventually generate a sparse/synthetic
fixture rather than requiring a personal backup:

- 200 GB logical media size or a representative stress fixture.
- More than 65,535 archive entries.
- At least one file larger than 4 GB.
- Duplicate timestamps and message IDs across chats.
- WAL and SHM present.
- Cancellation and restart during catalog, hash, and candidate jobs.
- Peak RSS target under 1 GB for the native core.

The repository now includes `native/electron/scripts/measure-peak-rss.sh`. It
polls macOS `ps` every 100 ms and reports aggregate RSS for the command and its
descendants without requiring `/usr/bin/time -l` or `sysctl` access:

```sh
native/electron/scripts/measure-peak-rss.sh -- \
  target/release/line-cheater --work-dir /tmp/line-cheater-rss catalog \
  --source /path/to/synthetic-line-backup
```

The JSON output contains only `peakRssKiB`, exit code, sampling interval, and
scope. Use synthetic or ignored local fixtures; do not put source paths or
message data in logs.

## Next implementation steps

The next owner should proceed in this order:

1. Add an explicit cancellation token that the Rust sidecar can observe without
   process termination. Current job IDs and restart-based scan/hash resumption
   are safe, but candidate ZIP output still restarts from zero.
2. Port the web cleanup-plan JSON/text exports.
   Source-aware community browsing is implemented; add cross-store coalescing
   if a future fixture contains the same normalized chat ID in both databases,
   preserving a merged chronological message stream like the web app.
3. Move chat counts into the work catalog and extend the FTS5 sidecar with
   richer tokenization and an explicit indexed-message count in the UI.
4. Manually regress directory, SQLite, and `.imazingapp` native pickers on
   macOS/Windows/Linux. The macOS arm64 and Windows x64 bundle/sidecar paths
   are automated; complete universal macOS builds, Linux packaging, and
   Windows signing remain.
5. Replace in-memory ZIP central-directory bookkeeping for million-entry
   archives and add the sparse >4 GiB single-entry runner.
6. Add cancellation/restart coverage for the FTS build and measured peak RSS
   across directory and archive fixtures.
7. Repeat generated ZIP64 candidate validation across more iMazing backup
   variants; one real restore path has already been verified.
8. Measure the Electron and Rust processes separately; only evaluate a Tauri
   shell if Electron's measured baseline is unacceptable.

## Handoff checklist

When handing this work to another engineer or agent:

- Read this file completely.
- Run the verification gates and record which ones pass.
- Inspect `git status`; do not delete ignored personal fixtures.
- Preserve the browser implementation and Python CLI unless an explicit
  migration removes them.
- Do not relax read-only source behavior.
- Do not increase page sizes beyond 1,000 as a performance workaround.
- Keep the cleanup shell fixed-height. If new controls need space, use
  progressive disclosure or another bounded page instead of restoring a
  document-level scrollbar.
- Update “Current implementation status” and “Next implementation steps.”
- Document any measured peak RSS and the exact synthetic fixture parameters.
- Leave source and output paths out of committed logs.
