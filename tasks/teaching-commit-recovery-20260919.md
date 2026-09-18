# Teaching commit recovery (worker 2.5.4)

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

## Verification

- Migration 20260918230000_teaching_contract_versions applied through linked
  official Supabase CLI; installed transactional contract checks passed.
- Actual failed result passed cloud SQL checks in six rollback-only batches.
- Local recovery: 119 sentences, 1824 voice positions, 793 selected files, REVIEW,
  zero model calls. This is not evidence of a completed production retry.
- Full scripts/test-release.ps1 passed, including 90 worker tests, local-studio
  tests, web contracts, static audit, and Edge Function type checking.
- Tests cover failed commit/new lease, compact voice manifests, corrupt or
  mismatched checkpoints, asset containment, and cancellation during recovery.

## Rollout and remaining acceptance

Chrome connector remains unavailable (nodeRepl.fetch request failed). Use the
previously authorized Supabase CLI, Git/Pages, and HTTPS fallback. SQL gate is
complete. Git deployment, worker restart, and public HTTPS verification follow.

The real task still requires an authenticated administrator retry. Do not forge
admin claims, change production status directly, or synthesize a worker lease.
After retry, verify cloud REVIEW and recovered content with no paid regeneration.
No precise currency-cost claim is possible without the provider billing record.

## Restore

Revert only this scoped worker change to return to 2.5.3; retain checkpoints,
cached teaching, source media, and encrypted local settings. Do not roll back the
SQL compatibility fix while v2 output exists. No backup or media was deleted.
