# Supabase read I/O correction — beta.6.50.9

## Requested outcome and diagnosis

Investigate and correct the English site's excessive Supabase disk I/O. Video,
voice and cover bytes stay in Cloudflare R2. This correction does not migrate
content, change authentication, increase the compute tier or reprocess media.

Read-only live statistics identified the processing video-group list (about
110.08 GB temporary writes, 14,384 calls) and administrator cover authorization
(30.54 GB, 10,688 calls) since pg_stat_statements reset at 2026-09-05 17:24 UTC.
These are cumulative database temporary-block writes, not stored video bytes or
an exact measurement of the email's unknown alert window.

## Changes

- Strip voiceManifest from read-only video headers before set-returning-function
  materialization. Preserve array order, duplicate IDs and every other field.
- Apply the projection to list/history/detail, private cover preview, and the
  existing non-voice playback resolver. Leave all role, entitlement, run,
  publication, deletion, path and receipt predicates unchanged. Voice delivery
  retains its registered-voice validation path.
- Sort job IDs before loading the five selected processing records.
- Pause automatic admin polling when hidden, offline, signed out or outside the
  dashboard/processing/video-detail pages. Resume when eligible. Idle polling is
  60 seconds; active polling is 5 seconds using global activity, not page rows.
- Reuse loaded cover DOM nodes during same-account redraws. New run/account
  requires a new image request. Server authorization/cache behavior is unchanged.

## Verification

Rollback-only database test ran at the existing 2184 kB work_mem, preserving
all persistent content and task records. An eight-video synthetic payload lives
only in temporary tables; cloned list functions read the temporary fixture.

| Isolated query | Time (ms) | Temp blocks read | Temp blocks written |
| --- | ---: | ---: | ---: |
| Raw eight-video expansion | 17.499 | 1025 | 1025 |
| Projected expansion | 20.681 | 0 | 0 |
| Original full processing list | 728.912 | 11075 | 18458 |
| Revised full processing list | 111.067 | 0 | 0 |

A block is 8192 bytes; the old full-list write was approximately 151.2 MB.
These are controlled samples, not a claim of zero production I/O. The projected
expansion alone is slightly slower in this sample; its purpose is to avoid disk
materialization. Snapshot storage and other queries remain on Supabase.

Three real-data pagination cases returned equivalent results after ignoring
serverNow and deliberately omitted voiceManifest fields. Admin denial,
projection order/duplicates/null/empty and private helper permissions passed.
The five installed function definitions matched the forward migration's guards.

Browser test: five same-cover redraws issued one request; a new run and a new
account each issued a fresh request. Poll lifecycle, in-flight wake, offline,
hidden, route, logout, global activity and retry backoff tests passed.
M08 processing contracts, authentication/playback contracts, studio recovery,
group response contracts and static audit (71/71) passed.

Existing admin_intake_ui_test.cjs fails at line 64: it expects an enabled submit
button while the current service is unavailable. The exact same assertion also
fails with pre-change HEAD source. This fixture was not changed or counted as a
passing test. Its earlier admin table/layout checks completed in both runs.

## Publication status and rollback

Prepared on fix/supabase-disk-io-20260920, baseline b68c340; correction commit 4c15bd6.
On 2026-09-20 the user explicitly authorized this rollout and selected official
Supabase CLI / Git / Cloudflare Pages / HTTPS as the default for future releases.
AGENTS.md now records that standing channel preference; Chrome is optional.
Production rollout is in progress. Earlier database tests ended in ROLLBACK.

Local evidence: tmp/disk-io-baseline-functions.json and
 tmp/disk-io-rollback-test.sql. The exact pre-change database function restore is
 tmp/disk-io-restore-functions.sql, excluded from Git. Restore it only if this
 migration was deployed and its five functions have not subsequently changed.
Frontend rollback is a revert of this correction's commit, respecting the
project's database-first rollout order. Unrelated dirty files are preserved.
