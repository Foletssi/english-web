# beta6.50.3: upload after a cancelled local intake

The matching 325,770,693-byte original belongs to an older job cancelled at
2026-09-18 14:54 Asia/Shanghai (ADMIN_CANCELLED). The browser's durable receipt
reused that job's request ID for a new upload. The server correctly rejected it
with LOCAL_INPUT_CANCELLED. The reservation bridge throws cloud errors, bypassing
the intake client's translation that previously handled returned errors only.

Normalize both thrown and returned reservation errors. When a new upload reuses
a saved receipt and the initial reservation explicitly reports cancellation,
replace the receipt once with a new request ID and current video metadata.
Persist that ID before requesting the new reservation so a lost response remains
idempotent. Do not replace receipts for transport failures, other server errors,
explicit recovery, or mid-transfer ticket renewal. Never reactivate the old job.

## Verification and rollout

- Targeted tests pass for thrown/returned cancellation, healthy receipt reuse,
  current metadata, lost responses, bounded replacement, explicit recovery,
  ticket renewal cancellation, and intake-ticket privacy.
- Existing local input recovery tests pass.
- Full release gate and processing module checks passed; release log is retained
  locally in tmp/release6503-checks.log (not included in the commit).
- No database migration, Edge Function change, Worker restart, or AI call needed.
- Chrome connector failed with nodeRepl.fetch request failed. Use the existing
  authorized Git/Pages and HTTPS verification fallback.
- Production deployment verification: pending.

Restore by reverting this release's client and cache version. Keep original
media, local receipts, encrypted AI settings, and unrelated work intact.
