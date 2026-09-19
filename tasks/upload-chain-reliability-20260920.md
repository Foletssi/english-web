# Upload-chain reliability, beta.6.50.8 / worker 2.5.7

## Scope

Complete production, upload, receipt registration, final commit and recovery.
Old videos, jobs and checkpoints must not be reprocessed or changed. Do not call
paid AI, change prompts/batch sizes/caches, or physically delete R2 objects.
Use isolated synthetic fixtures and read existing output only.

## Implemented

- Validate bounded upload envelopes and every hash before allocating storage:
  at most four voice files, 1 MiB each and 2 MiB total, with a 3 MiB body cap.
- Use two upload slots, current-run object reconciliation, multipart write fences,
  partial retries and mandatory receipt registration before atomic checkpoints.
- Preserve AI request contents with cancellation-aware shared resource slots,
  bounded coverage concurrency and at most two active jobs with immediate heartbeats.
- Validate teaching versions, shape, uniqueness and conservative snapshot capacity
  before voice synthesis. Accept the supported translation/coverage version pairs.
- Keep the snapshot cap at 32 MiB, commit statement timeout at 60 seconds and lock
  timeout at 2 seconds. Retry timeout, lock, serialization and deadlock failures
  with the same payload; reject business errors without inheriting HTTP retries.
- Return durable compact commit receipts without first constructing and copying
  a full snapshot through the worker call stack. The legacy/admin response retains
  its full snapshot through the same underlying validated implementation.
- Project only cover-selection metadata for collection scans and only ownership
  pointers for ownership checks. Extract array replacement IDs once; preserve
  duplicate removal, null handling and array order. Build changed snapshot fields
  together, retaining the legacy path for non-object sentence containers.
- Reject absent/null/empty sentences and explicitly malformed video objects.
  Bounded retries now also cover empty, truncated or malformed successful HTTP
  responses on idempotent operations; claiming work remains non-retryable.

## Verification

- Earlier 13 targeted npm gates passed, covering cloud/studio, contracts,
  authorization, learning, deletion, module boundaries, M01/M08/M10 and mapping.
  Three UI gates passed after starting their required local HTTP server.
- Final worker suite: 109 tests passed. Edge SQLSTATE classification, real handler
  batch limits, validate-before-write, partial failure, conflict, abort fencing,
  lost-response recovery and replay checks passed. Static audit: 71/71.
- SQL regression checks passed on the deployed database: cover selection,
  fallback order, preservation of unrelated content, equivalent snapshot updates,
  null/duplicate array semantics and private helper privileges.
- Preflight accepted valid data and rejected invalid versions, null/empty data,
  duplicate/stale voice sources and excessive capacity before paid synthesis.
- A rollback-only small commit on an 8.5 MB snapshot completed in 9.08 seconds.
  The earlier whole-catalog cover scan took about 45 seconds in one profile;
  the projected cover scan took about 69 milliseconds in the successful profile.
- Real synthetic media: local FFmpeg generated HLS segments, master/index playlists,
  WebP and two MP3s. HTTPS tests passed for whole-batch bad-hash rejection,
  absence after rejection, upload, exact replay with unchanged ETags, GET recovery,
  same-key conflict rejection, receipt registration and REVIEW commit/replay.
- That real-media commit encountered one database timeout, then completed through
  the actual Worker retry path in 108.34 seconds total. Replay returned the same
  revision in 0.58 seconds. Four malformed result variants were rejected.
- Large payload: 419 sentences, 3162 voice entries and 1123 database receipts.
  Actual Worker -> Edge -> PostgREST commit succeeded in 189.03 seconds including
  two client timeouts and bounded retries. Exact replay returned the same revision;
  changing the payload was rejected as COMMIT_RECEIPT_CONFLICT.
  These large-fixture receipts simulate storage; actual media transport was tested
  separately above. No ASR or paid AI generation was invoked by these tests.

## Rollout and cleanup

Migrations 20260920010000 through 20260920040000 are applied; video-processing
Edge is deployed. Chrome rejected the active connector authentication, so the
previously authorized Supabase CLI / Git / connected Pages / HTTPS lane is used.
The previously published source bdb79f862e4ea12f3ee661cd3f7a9139af425e8b passed
45/45 student/admin asset comparisons. Every final source push is gated on its
exact-SHA Pages check and another student/admin HTTPS comparison. The unrelated
Workers Builds check is separate from the Pages application deployment.

Worker 2.5.7 is running with a fresh database heartbeat. FFmpeg, Whisper, configured
AI, teaching voice and local input readiness are true. Before replacing the old
worker, no live user jobs were queued/running/waiting. Existing launcher supervision
restarted the updated worker after the verified idle stop.

Both isolated fixture jobs, their private database records and draft references
were removed in an exact-ID transaction. The transaction asserted preservation
of all unrelated draft content and the entire published snapshot. No R2 object
was deleted. Three protected old-job row hashes remain unchanged; no old output
or checkpoint was rewritten. Temporary evidence and test media remain local and
are excluded from Git, as are supabase/.temp and unrelated dirty user files.

Specification and standards review is complete against baseline
5cc96e0853f05141029c883e1fe77b9410a65894, including the final shared SQL changes.

## Operational limits

This is tested recovery, not a claim that the database never times out. Large
commits still showed variable latency and can need retries. Retries are bounded;
if exhausted, durable output/checkpoints permit recovery without repeating paid
production. The tests establish transport, validation and commit correctness;
they do not claim a new paid ASR/AI run or semantic verification of synthesized
speech. Synthetic fixtures briefly reclaimed after lease expiry stopped at their
nonexistent source (404); they did not execute AI, and all their database runs
were included in cleanup.
