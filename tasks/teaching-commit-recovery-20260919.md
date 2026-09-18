# Teaching commit recovery (worker 2.5.5)

## Root cause and scope

The final cloud commit rejected coherent v2 coverage/review metadata because
learning_details_valid_v1 only accepted v1. Voice registration reported this
teaching rejection as VOICE_SOURCE_STALE. The source and completed audio matched.

Accept coherent v1/v2 pairs while rejecting missing, mixed, or unknown versions.
Keep quality, ownership, receipt, source, and revision checks. Validate teaching
once per sentence and return TEACHING_DETAILS_INVALID for teaching failures.

Persist a checksummed final-output checkpoint before commit. Retry validates job,
input, source, cover, asset paths, sizes, hashes, and voice items; rebinds voice
identity to the new run; uploads with current-run receipts; then commits REVIEW.
Invalid checkpoints stop without paid regeneration. Cancellation fences remain.
No publication, original-media deletion, or teaching-content simplification.

## Recovery follow-up

Voice registration now indexes sentences once and aggregates its manifest once,
instead of repeatedly copying growing JSON. Teaching and asset validation stay
enabled. Transient HTTP 520-524 failures use bounded retries; business errors do
not. Final-output checkpoints still avoid paid regeneration when valid.

Admin job covers can preview uploaded screenshots before publication, using
current-run receipts and owner/admin authorization. Student access is unchanged.
Retry retains progress below 100 and explicitly distinguishes validating a
checkpoint from reusing verified output. Prior percent does not prove stages done.

## Verification

- Migration 20260918230000_teaching_contract_versions applied through linked
  official Supabase CLI; installed transactional contract checks passed.
- Actual failed result passed cloud SQL checks in six rollback-only batches.
- Local recovery: 119 sentences, 1824 voice positions, 793 selected files, REVIEW,
  zero model calls. This is not evidence of a completed production retry.
- Full scripts/test-release.ps1 passed, including 98 worker tests, local-studio
  tests, web contracts, static audit, and Edge Function type checking.
- Tests cover failed commit/new lease, compact voice manifests, corrupt or
  mismatched checkpoints, asset containment, and cancellation during recovery.
- Migrations 20260919020000, 20260919021000 and 20260919022000 were applied
  through the official linked CLI and confirmed in the remote migration list.
- Installed SQL regression passed after migration. A synthetic job using the
  saved 119-sentence, 1824-voice-position checkpoint completed the actual commit
  function and idempotent replay. Cover access, lease invalidation, durable
  receipt, voice counts and teaching checks passed. All fixtures rolled back;
  the real failed task was not changed by this test.

## Rollout and remaining acceptance

Chrome connector remains unavailable (nodeRepl.fetch request failed). Use the
previously authorized Supabase CLI, Git/Pages, and HTTPS fallback. SQL gate is
complete. Commit dc65ab85522412467cdd5269e6891058d79f8d52 was pushed to main.
GitHub check "Cloudflare Pages" completed successfully for that exact commit;
deployment ID 7daf195a-7ec9-49e9-b80e-812c55a50e47. Production student and admin
URLs both returned HTTP 200 with their expected HTML titles. This HTTPS check
does not prove authenticated browser interactions. A separate "Workers Builds:
english-web" check failed; it is not the successful Pages deployment above.

Restarted only the verified idle worker/launcher processes using the existing
hidden launcher and inherited credentials. Startup reports worker 2.5.4 with
AI-settings and source-intake loopback listeners ready and no stderr output.
Cloud processing_workers confirms version 2.5.4 with a recent heartbeat.
No running or queued jobs existed at that restart. The last read-only check of
the original task found ERROR at LOCAL_UPLOAD / 97%, EDGE_HTTP_520.
It has not yet been retried through an admin session.

The 2.5.5 database rollout is verified. Pages rollout and the idle-worker restart
for this follow-up remain pending at the time of this entry.

The real task still requires an authenticated administrator retry. Do not forge
admin claims, change production status directly, or synthesize a worker lease.
After retry, verify cloud REVIEW and recovered content with no paid regeneration.
No precise currency-cost claim is possible without the provider billing record.
The user has been asked to select retry-failed-stage on the existing video, not
upload another copy. Browser connector was rechecked and remains unavailable.

## Restore

Revert only the scoped follow-up worker change to return to 2.5.4; retain checkpoints,
cached teaching, source media, and encrypted local settings. Do not roll back the
SQL compatibility fix while v2 output exists. No backup or media was deleted.
