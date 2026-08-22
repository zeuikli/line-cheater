# Mobile release status

## Implemented

- One Tauri 2 frontend and Rust core are shared by macOS, Windows, iOS, and Android targets.
- Mobile exposes only the system document picker. It does not discover or request access to LINE's
  private application container.
- A selected iOS security-scoped URL or Android content URI is streamed into the app's private
  import directory before the Rust core opens it. The original remains read-only.
- Desktop cleanup controls are replaced on mobile by a sandbox explanation.
- The iOS Xcode project, icons, safe-area layout, and minimum 44 CSS pixel touch targets are present.
- Candidate backup, attachment export, conversation export, image preview, and saved Session
  discovery/open/delete now use native Tauri commands rather than Electron IPC.
- Mobile output goes through the system save picker; attachment folders are staged as ZIP files in
  app-private storage before streaming to the user-selected destination.
- The browser edition is installable from Safari/Chrome as a PWA. Its local SQL.js runtime and app
  shell are cached for offline reuse after the first successful load; mobile users can import a
  previously transferred `Line.sqlite` or CLI index. It intentionally cannot enter LINE's private
  app sandbox or perform desktop cache deletion.
- Long-running scanning, indexing, hashing, export, candidate generation, and source staging use a
  shared cooperative cancellation token. Cancellation unwinds transactions and removes partial
  export/staging output; focused integration tests cover both cases.
- An unsigned arm64 iOS Simulator app builds, installs, and launches successfully at version
  0.1.31 on an iPhone 17 / iOS 26.5 simulator. A five-second screenshot smoke test verified the
  responsive single-column layout and that the unsupported directory picker is hidden.
- An unsigned arm64 iPhoneOS Release IPA also builds without Distribution credentials. Its clean
  Payload archive is 5,626,050 bytes, targets iOS 14.0+, and can be signed by Xcode Personal Team or
  a personal-Apple-ID sideload tool. A separate command installs directly once Xcode has an account
  capable of creating the development provisioning profile.
- Current regression count: 54 Rust tests, 93 Electron fallback tests, 10 Tauri architecture tests,
  and 3 web/PWA contract tests pass; Clippy passes with warnings denied.

## Release gates still requiring external setup

- App Store/TestFlight publishing requires an Apple Developer team, registered bundle ID,
  distribution certificate, provisioning profile, App Store Connect record, privacy metadata, and
  the user's authorization to upload.
- Google Play publishing requires a Play Console app, signing keystore, service account, store
  listing/privacy forms, and the user's authorization to upload.
- An isolated local JDK and Android command-line toolchain are present. Android packages have not
  been installed because the Android SDK License has not been accepted by the user; no APK can be
  built locally until that explicit acceptance. The repository workflow also builds an unsigned
  test APK, but it must run successfully before Android is called ready.
- This Mac has an Apple Development identity but no verified App Store distribution identity or
  provisioning/profile setup. Xcode also has no signed-in account, so direct Development install
  cannot create its profile until the user signs in. The unsigned IPA is not a TestFlight/App Store
  build and must be signed with the installing user's Apple ID.
- External HTTP(S) links now use Tauri's native opener after rejecting credentials and non-web
  schemes. Cooperative cancellation is complete. Electron stays available as the migration
  fallback until the Windows and Android CI jobs pass.

Local cache deletion and backup rewriting never mean LINE cloud deletion. LINE does not expose an
official authenticated consumer API for deleting the corresponding server-side message or file.
