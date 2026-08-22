# Local LINE cleanup test goals

These acceptance targets must be written before implementation and must remain true for every
supported desktop release. Tests use temporary fixture directories only; they must never point at
a developer's real LINE profile.

## 1. Startup and process safety

- On macOS and Windows, local cleanup is unavailable while any recognized LINE desktop process is
  running.
- The app explains why LINE must be closed and offers an explicit `Quit LINE and retry` action.
- A failed or refused quit leaves the profile untouched. The app never kills an unrelated process
  whose name merely contains `line`.
- LINE is checked again immediately before deletion to close the scan/delete race.

## 2. Profile discovery

- macOS discovers the sandboxed `jp.naver.line.mac` profile beneath the current user's Library.
- Windows discovers LINE profiles beneath the current user's LocalAppData/RoamingAppData roots.
- Environment-dependent roots are injected into tests; production code does not trust renderer-
  supplied absolute paths.
- Missing, ambiguous, symlinked, reparse-point, or unsupported profiles produce a read-only error
  and never fall back to scanning a broader home directory.

## 3. Inventory and correspondence

- Scanning is read-only and reports file count, byte size, category, modification time, and a
  stable opaque item ID.
- Only allowlisted cache/attachment roots are inventoried. Account databases, credentials,
  settings, executable files, and unknown files are excluded.
- Every selected item is resolved again from its opaque ID. A renderer cannot submit an arbitrary
  filesystem path for deletion.
- If a supported database/index can prove that several files correspond to one attachment, the
  preview groups them and deletion is all-or-nothing. Unproven correspondence is labeled as cache,
  not as a chat attachment.

## 4. Local deletion

- Deletion requires an inventory token plus the exact selected opaque IDs and a final destructive
  confirmation in the main process.
- The main process rejects expired tokens, changed files, files outside allowlisted roots,
  symlinks/reparse points, directories, database files, and requests made while LINE is running.
- Files are moved to the operating system Trash/Recycle Bin when supported so the operation is
  recoverable. A permanent-delete fallback is never automatic.
- Partial failures are reported per item and successful removals are measured from the filesystem;
  the UI never claims bytes that were not actually removed.

## 5. Cloud semantics

- Local cache deletion is never described as cloud deletion and never claims to remove another
  participant's copy.
- A cloud deletion can run only through a separately authenticated, officially supported LINE
  operation that identifies the same message/attachment and returns a verifiable success result.
- If no such operation exists for the consumer desktop client, the cloud option is disabled with a
  clear explanation and the local operation may proceed only after the user acknowledges that the
  item can be downloaded again.
- Cloud failure must not be hidden by local success. Results report local and cloud outcomes
  independently.

## 6. Cross-platform and regression coverage

- Unit fixtures cover macOS paths, Windows paths, malicious traversal, symlinks/reparse points,
  process-name false positives, file mutation between scan and deletion, and partial failures.
- Electron IPC tests prove that the renderer receives metadata/opaque IDs only and cannot invoke
  raw filesystem deletion.
- Existing iOS backup, `.imazingapp`, export, and candidate-building tests continue to pass.
- macOS and Windows packaging checks include every new local-cleanup module.
