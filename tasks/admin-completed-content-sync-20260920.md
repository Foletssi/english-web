# Completed videos missing from review lists — beta6.50.10

## Production evidence

On 2026-09-20, processing jobs eefd6e19-fafd-460a-ae8c-d1171a9026de
(video 178988077693664) and d596eb7e-fd7a-4248-ad8b-6a5edf5139ad
(video 178988083528308) both had durable REVIEW receipts, revisions 122 and 123.
The current production draft was revision 123 and contained both REVIEW/READY
videos, 419 and 119 sentences, complete titles, durations and processed-media URLs.
The user's screenshot instead showed only the first in subtitle review and a
DRAFT/WAITING placeholder with duration 0 for the second in the video library.

## Root cause and fix

The processing queue polls normalized task records while library/review screens
render the imported content snapshot. Terminal transitions removed the job from
an in-memory polling set before attempting a full reload. If the reload failed,
or the page first saw an already-terminal job, subsequent polling did not retry
the content import. Manual refresh only read task state. The two list routes were
also excluded from polling visibility.

Terminal content synchronization is now tracked separately by job/run/status/
update signature and acknowledged only after a successful content refresh.
Failures and imports deferred by local edits remain eligible for retry. Manual
refresh reads content as well as tasks, and the library/subtitle-list routes poll.
Unchanged terminal tasks do not trigger repeated full-snapshot reads.

A dedicated read-only refresh coalesces requests, waits for existing saves, refuses
to overwrite pending or concurrently changed local data, rejects stale revisions,
and checks the authenticated context again after the request. Content refresh
redraws the list views; it does not redraw the subtitle editor. Authentication
changes clear terminal synchronization markers.

The library and subtitle list now use the same run-bound, authenticated cover
preview markup as the processing queue. This fixes the broken unpublished-cover
URLs visible in the user's screenshots without relaxing access controls.

## Validation and release scope

- Regression: terminal jobs already complete at first observation; failed snapshot
  read followed by retry; manual refresh; deferred imports; idle read suppression.
- Import guards: pending edits, edits during fetch, older revision, logout during
  fetch, failed request cleanup and coalesced requests.
- Headless Chrome fixture using actual render/sync code: one subtitle row recovers
  to two rows with 419/119 sentences, the second title/duration becomes correct,
  and both authorized cover images load.
- M08, studio and static checks run before rollout; exact-SHA Pages and production
  student/admin asset verification follow the push.

Frontend-only changes: no database data patch, no video or AI rerun, no Worker
restart, no publication of learning content, and no R2 deletion. Existing generated
content stays in REVIEW for human approval. Local production evidence remains in
tmp/two-video-state-20260920.json and is excluded from the release commit.
