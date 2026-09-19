# beta6.50.7 — recorded-pronunciation word cards

## Fixed

- Cards with recorded pronunciation no longer abort before becoming visible: dictionary authorization now uses the exported EastudyCloudContent API.
- Failed audio preauthorization cannot prevent reading a definition. Playback failures remain retryable.
- Student app script version advances to beta6.50.7.

## Evidence and scope

- The new recorded-voice browser fixture failed before the fix with a hidden card and an undefined syncMediaSession receiver; it passes after the fix.
- Browser regression covers subtitle clicks, complete touch gestures, key-expression text clicks, recorded audio selection, authorization failure and retry, and ten viewport layouts.
- Learning, runtime/content contracts, player contracts and student interaction tests passed locally.
- Audio is mocked in the browser fixture; this does not establish physical-device audible playback or validation of the user's exact uploaded video.
- Static audit: 70/71. The learner-insight literal-string assertion also fails against pre-fix HEAD; this release does not change that unrelated check or claim the full suite is green.

## Rollout

- User explicitly authorized GitHub main push -> connected Cloudflare Pages deployment -> HTTPS verification after the Chrome connector failed to connect.
- Frontend-only: no database migration is required. No media or user content is changed or deleted.
- Commit only the fix, regression test, version metadata and this note; preserve unrelated working-tree changes and temporary files.
- After push, verify the production index references beta6.50.7 and the served app script matches the committed source. Check both student and administrator HTTPS entrypoints.

## Rollback

- Revert this release commit and redeploy through the same authorized lane if it causes regressions. This restores beta6.50.6 without database or media changes.
- Rollback is not executed as part of this release.
