# Tauri desktop and mobile refactor test goals

These acceptance targets are recorded before the Tauri/mobile implementation. They extend the
existing local-cleanup targets and define when Electron can be retired as the default shell.

## 1. Architecture and lightweight runtime

- The shipping desktop shell uses Tauri 2 and the operating-system WebView; it must not bundle
  Electron, Chromium, or a Node.js runtime.
- The existing `line_backup_native` Rust core is linked directly into the Tauri process or a
  narrowly scoped Rust worker. The production Tauri app must not launch the JSON sidecar merely to
  call the same Rust crate.
- Frontend code is shared by macOS, Windows, iOS, and Android. Platform-specific capabilities are
  surfaced through one typed capability response rather than user-agent checks.
- On the same macOS reference machine and release build, the signed Tauri `.app` must be at least
  50% smaller than the Electron `.app`, and idle resident memory must be at least 30% lower. The
  benchmark records both raw measurements and tool versions.
- Scanning remains bounded-memory and yields progress. A 100,000-file fixture must not require the
  frontend to render or retain 100,000 DOM rows.

## 2. Desktop local LINE cleanup parity

- macOS and Windows require the real LINE desktop process to exit before the main window becomes
  usable. Refusal or a failed graceful exit terminates LINE Cheater without touching the profile.
- Process matching remains exact. A process merely containing `line` in its name is never
  signalled or terminated.
- Profile discovery is implemented in Rust and accepts no renderer-provided absolute deletion
  path. Only fixed, documented LINE profile candidates and cache roots are eligible.
- Scans return opaque IDs and metadata only. Delete commands resolve IDs server-side, recheck the
  LINE process, revalidate path containment and fingerprints, and use Trash/Recycle Bin.
- Encrypted `.edb`, account state, credentials, settings, unknown roots, links, and directories are
  excluded. Partial trash failures are reported without overstating deleted bytes.

## 3. Mobile product boundary

- iOS and Android builds install and launch on a simulator/emulator and a physical-device release
  build can be produced with externally supplied signing material.
- The mobile app never claims it can read another app's private LINE container. Its capability
  screen explains the iOS/Android sandbox restriction.
- Mobile accepts only a backup/archive or directory explicitly granted through the system document
  picker/share sheet. Permission is scoped to that user-selected item and is not broadened to the
  device filesystem.
- Import, validation, chat browsing, search, cleanup planning, and export operate on a copied or
  staged candidate. The selected source remains read-only.
- Desktop-only controls (quit LINE, discover desktop profile, Trash local desktop cache) are absent
  or disabled on mobile with a structured reason; they never fail through an unhandled command.
- Backgrounding, rotation, low-memory interruption, and reopening an import cannot silently commit
  a partially written candidate.

## 4. Mobile usability and privacy

- The primary mobile layout is usable at 320 CSS px without horizontal scrolling, uses touch
  targets of at least 44 CSS px, respects safe areas, and supports light/dark appearance.
- Lists are paginated or virtualized. Image previews are bounded and cancellable.
- No backup contents, message text, filenames, account identifiers, or absolute paths leave the
  device unless the user explicitly exports them.
- There is no analytics or remote telemetry dependency in the production bundle by default.
- Local session metadata can be cleared from inside the app and is removed through the platform's
  recoverable or documented storage API.

## 5. Cloud deletion semantics

- Local cache deletion and offline-backup rewriting are never reported as LINE server deletion.
- A remote delete/unsend capability remains disabled unless LINE provides a documented,
  authenticated consumer API that can identify the same message or attachment and return a
  verifiable result.
- Mobile and desktop present the same independent local/cloud result model. A local success cannot
  hide an unsupported or failed cloud result.
- UI automation, private protocol replay, extracted consumer credentials, and encrypted database
  modification are not accepted substitutes for an official remote operation.

## 6. Packaging and release gates

- Pull requests run shared Rust tests, Tauri command tests, frontend contract tests, formatting,
  Clippy, and platform configuration validation.
- macOS and Windows jobs build installable Tauri desktop artifacts and run a smoke test that proves
  the packaged Rust core and local-cleanup module are present.
- iOS and Android jobs at minimum compile simulator/emulator debug artifacts without signing
  secrets; release workflows fail clearly when required signing material is absent.
- Every artifact includes architecture/version metadata and checksums. Mismatched architectures or
  incomplete payloads fail packaging.
- Electron remains available only as a temporary migration fallback. It is removed from the
  default download path only after desktop parity, mobile launch, performance gates, and rollback
  documentation are verified.
