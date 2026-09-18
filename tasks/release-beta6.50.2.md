# beta6.50.2: provider generation endpoint compatibility

The supplied provider accepts model discovery at its root, but POST
/chat/completions returns HTTP 200 HTML. Its generation API is under /v1.
The previous shared client classified JSON decoding failures as network errors.

Normalize the verified api.x5m5x.com HTTPS root alias to /v1 for model discovery,
sample generation, independent review, saving and subsequent video processing.
Other provider paths remain unchanged. Return the normalized address to the UI.
Saved-key reuse accepts these same-provider aliases, never a different provider.

HTML and other invalid JSON responses now have distinct, credential-free error
codes and actionable UI messages; they do not trigger automatic paid retries.
Network interruptions remain retryable. Full translation and contextual-meaning
review and administrator sample confirmation are still required before saving.

## Validation

- Reproduced the path mismatch without a key: root generation returned HTML,
  while /v1/chat/completions returned the expected JSON authentication error.
- Live SettingsStore.test with the supplied key, root address,
  deepseek-v4-flash-0731 and thinkingMode=auto passed generation and independent
  review. Both calls used the normalized URL. Nothing was saved.
- Reviewed the three samples: see meant meeting, hardware meant bag fittings,
  and spill the beans meant revealing a secret; negation remained intact.
- Live test used 4,274 tokens in total, including 3,371 reasoning tokens with
  provider-default thinking. This is not a currency estimate or per-video price.
- Focused transport/settings tests and the complete release gate passed.
- Browser tests passed address normalization, test/confirm/save, distinct error
  messages and existing discovery flows across three widths and both themes.

## Rollout

No database migration or Edge Function deployment is needed. Worker is 2.5.3.
Chrome bridge again failed with nodeRepl.fetch request failed; use the existing
authorized Git/Pages lane and HTTPS verification. Restart only an idle Worker.
Do not change the user's saved provider or restart canceled jobs.

Restore by reverting this release and restarting an idle Worker. Preserve the
encrypted settings file, processing caches, and unrelated working-tree changes.
