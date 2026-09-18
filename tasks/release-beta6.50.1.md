# beta6.50.1: choose models from the configured provider

The admin AI settings page can read the provider's OpenAI-compatible model list
using the entered endpoint and key, without requiring an existing model name.
Choosing an entry fills the model field. Changing the address or key clears the
list; manual entry remains available when discovery is unsupported. Discovery
uses GET /models and does not generate text or authorize saving. Translation and
contextual-meaning generation, independent review and administrator confirmation
remain required before saving a new configuration.

Worker 2.5.2 exposes an administrator-authorized loopback models route, reusing
the encrypted saved key only for an unchanged endpoint. Requests have a bounded
timeout and response size, block redirects, and return only validated model IDs.
Provider error bodies and credentials are not returned to the browser.

No database migration or Edge Function change is required. This release does not
change the saved provider or model, restart canceled videos, or delete media.

## Verification

- All 15 focused AI settings tests passed, including encrypted storage, model
  discovery, URL handling, authentication, redirect blocking and response bounds.
- Browser tests passed for selection, empty initial model, manual fallback,
  address/key invalidation, saved-key reuse, text-only rendering, test/confirm/save,
  revision conflicts, reconnect, three viewport widths and both themes.
- Desktop and mobile screenshots were inspected for layout and long model IDs.
- Release checks passed: static and JavaScript contracts, 140 local-studio tests,
  75 Worker tests, Edge Function type checking and git diff whitespace checks.
  The initial Worker run caught an obsolete version assertion; after updating
  that assertion, the complete Worker suite passed.
- A live read with the user's supplied provider returned 40 model IDs, including
  the previously tested translation model. No completion calls were needed for
  this feature's live check. Model discovery does not establish quality or price.

## Rollout

The connected Chrome bridge still fails with nodeRepl.fetch request failed.
Use the previously authorized Git/Pages and HTTPS verification lane. Restart the
idle local Worker to expose the new route. The current saved configuration stays
unchanged. Restore code by reverting this release and restarting an idle Worker;
preserve encrypted settings and paid processing caches.
