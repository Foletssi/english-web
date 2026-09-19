# General semantic boundary correction — 2026-09-19

## Scope

Correct future automatic segmentation and translation ownership, not individual stored subtitles. No production subtitle updates, media deletions, schema migrations, or retries of existing failed jobs.

## Change

- Protect complete verb/object/result and separable phrasal-verb structures from length-, pause-, capitalization-, or punctuation-only cuts.
- Independently review every candidate boundary in each window and each seam; validate immutable word coverage, timing, and reliable speaker boundaries.
- Keep unresolved boundary concerns visible. Context may disambiguate translations but must not import neighboring actions/results or duplicate them.
- Bump segmentation and teaching-detail/review cache versions.

## Evidence

- Segmentation regression suite: 9 passed; local-studio suite: 145 passed; cloud-worker suite: 98 passed.
- Actual configured-model smoke tests preserved complete constructions in three synthetic examples: got the laundry set up and fixed; had the broken window repaired; put the heavy box down. Words/timings were preserved. No queue or database writes were used for these tests.
- Worker restart performed only after a fresh database query confirmed zero QUEUED/RUNNING/WAITING jobs. Existing scheduled launcher started the replacement process at 21:54:47 China time; startup log was healthy, and database heartbeat advanced to 21:57:55.
- Worker imports pipeline and ai_tools from this checkout, which import the changed segmentation module. The unchanged worker version 2.5.5 alone is not proof of activation.

## Limits and release lane

- No newly uploaded end-to-end production video has been processed as part of verification. Model smoke tests are bounded evidence, not a guarantee against all semantic errors.
- Seam review sees the last left and first right segment, not a final whole-document pass. Independent review approximately doubles segmentation model calls.
- Use the previously authorized official CLI/Git/Pages/HTTPS fallback because the Chrome connector rejected the active authentication method. No migration is required. Frontend publication is separate from worker activation.
- Rollback: revert only this scoped change, then restart the worker after checking the queue is idle. Existing subtitle data needs no rollback. Prior worker logs were archived by the existing launcher.
