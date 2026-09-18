# beta6.50.0: configurable AI and processing cost recovery

## Scope

Admin settings now edit the actual local Worker endpoint, model, API key and
provider-compatible thinking option. A small generation and independent review
test precedes saving, with the resulting Chinese translations and contextual
meanings shown for administrator confirmation. The Windows user-bound encrypted
key is never returned to the browser. Origin, Host and live administrator checks
protect the loopback service. Endpoint changes require a new key; API redirects
cannot forward credentials. Each job captures one configuration snapshot.

Worker 2.5.1 retains full independent teaching review. Official DeepSeek calls
default to thinking disabled, JSON is compact, and content-addressed checkpoints
preserve multiple passes and reuse legacy paid results. Output reconciliation now
uses the Worker user agent. Media upload must succeed before paid teaching starts;
transient transport errors retry and pipeline errors retain their actual codes.

No database migration or Edge Function change is required. No canceled video is
restarted, and no R2 media is deleted by this release.

## Verification

- 70 cloud-worker and 140 local-studio Python tests passed.
- All ten M08 contract scripts passed.
- Admin settings browser test passed using real admin assets and mocked service:
  test/confirm/save, invalidation, revision conflicts, reconnect, navigation,
  no key in browser storage, three widths and both themes.
- Worker integration verifies the new configuration reaches the pipeline,
  full review is enforced, and a subsequent configuration change does not alter
  the running job. All 33 worker tests passed after adding these assertions.
- Desktop and mobile screenshots were visually inspected. Earlier full-page
  capture artifacts were eliminated by resetting scroll before viewport capture.
- Full repository release gate passed, including Deno checks and diff validation.
- Restart exposed a missing default ASR cache. An existing same-model small
  snapshot was copied into the Worker's durable model directory, with each file's
  hash verified. No download or model downgrade was needed. The launcher now
  refreshes persisted ASR overrides as well as the work directory. Launcher syntax
  and an actual CUDA inference readiness check passed.

## Quality and Cost Limits

Previously recorded paid samples demonstrate corrections of contextual senses and
negation, but cannot establish semantic accuracy for every sentence or provider.
English transcription remains on faster-whisper. Full review and structural
validation remain enabled; provider sample success is not a guarantee of quality.
One yuan per video remains a target dependent on length, model and tariff, not a
measured fixed price. This release verification did not rerun a paid video.

## Rollout

The connected Chrome bridge remains unavailable (inventory and tab creation both
fail with nodeRepl.fetch request failed). The session's earlier rollout record
identified its authentication limitation. Use Git/Pages and HTTPS verification
within the user's requested production control-panel update. Browser local-network
permission and an authenticated production save remain separate live checks.

Restore configuration by stopping an idle Worker, renaming its settings/ai.json
to preserve it, and restarting to use the existing environment settings. To revert
code, revert this release commit and restart the idle Worker; preserve paid caches.
