# Tauri migration benchmark — 2026-08-22

Reference machine: Apple Silicon macOS 26.6.1. Both applications were release bundles at version
0.1.31, opened to the initial screen with no backup selected. RSS is the sum of all processes owned
by that application after five seconds.

| Metric | Electron | Tauri 2 | Reduction |
| --- | ---: | ---: | ---: |
| `.app` disk usage | 290,768 KiB | 19,072 KiB | 93.4% |
| Idle RSS | 323,168 KiB | 106,176 KiB | 67.1% |
| DMG bytes | 138,716,580 | 6,555,343 | 95.3% |

Toolchain: Tauri 2.11.5, Tauri CLI 2.11.4, Rust 1.98.0, Electron 37.2.6, Node 26.0.0.

The Tauri result passes the pre-recorded gates of at least 50% smaller application size and 30%
lower idle RSS. These measurements do not by themselves authorize removing the Electron fallback;
Windows packaging, Android packaging, signed-device builds, and remaining shell commands must also
pass their release gates.

The final macOS DMG uses an explicit ad-hoc bundle signature and passed `hdiutil verify` plus strict,
deep `codesign` verification. It is not notarized; a Developer ID identity and Apple notarization
credentials are still required for public distribution without Gatekeeper warnings.

Final Tauri DMG SHA-256:
`6f365fdc5a0db779b80e83a52bfe293c31454182f2e07b7661a45af171f05632`.
