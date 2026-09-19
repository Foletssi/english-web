# Upload-chain reliability, beta.6.50.8 / worker 2.5.6

## Scope and acceptance

Finish production, upload, receipt registration, final commit and retry/recovery.
Do not reprocess or mutate old videos/jobs/checkpoints, consume paid AI, change AI
prompts/batch sizes/caches, or physically delete R2 objects. Retry failed portions
only. Synthetic isolated fixtures and reading old output are authorized.

## Changes

Bounded upload batches (4 files, 1 MiB each, 2 MiB total), complete envelope and
hash validation, two upload slots, multipart fencing, existing-object recovery,
mandatory receipt registration before atomic checkpointing. Cancellation-aware
shared resource slots and bounded coverage concurrency preserve AI requests.
Teaching version compatibility and pre-voice SQL validation reject invalid or
capacity-exceeding output before paid synthesis. Snapshot cap is 32 MiB with a
conservative capacity estimate. Trigger optimization avoids repeated large row
conversion. Durable leased commits return compact acknowledgements. Dedicated
commit timeout is 60 s, worker request 75 s; lock timeout 2 s. SQLSTATE timeout,
lock, serialization and deadlock errors are classified for bounded retries.

## Verification before rollout

13 targeted npm gates passed, including cloud/studio, contracts, authorization,
learning, deletion, module boundaries, M01/M08/M10 and browser UI mapping. Three
UI gates initially lacked a local HTTP server and passed after starting one.
Rollback-only SQL benchmark: 419 sentences, 3162 voice entries, 1123 receipts;
REVIEW in 10831 ms, response 37 bytes (previously 8553928). Preflight accepts
valid data in 690 ms; invalid, duplicate/stale voice source and over-capacity
cases reject. All database benchmark changes roll back. No old task was retried.

## Rollout acceptance still pending

Two-axis committed-diff review; migration verification; Edge deployment; Pages
exact-SHA deployment; student/admin HTTPS checks; real isolated upload, receipt,
commit/replay/conflict verification; idle-only worker restart; exact fixture cleanup.
Source review baseline: 5cc96e0853f05141029c883e1fe77b9410a65894.
Chrome unavailable; previously authorized CLI/Git/Pages/HTTPS fallback applies.
