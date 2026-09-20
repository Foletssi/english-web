# Eastudy deployment rules

## Mandatory production rollout lane

- The user authorized the official Supabase CLI -> Git -> Cloudflare Pages connected-Git -> HTTPS verification lane as this project's default on 2026-09-20, including subsequent releases. For authorized fixes and releases, use this lane without asking again about the channel or requiring Chrome availability.
- Run and verify required Supabase migrations first; fast-forward `main`; push GitHub; wait for the Cloudflare Pages check for that exact commit; then verify student/admin URLs and changed assets over HTTPS. Do not merge or push `main` before required migrations succeed.
- Use Chrome only for additional UI checks when helpful and available. Its absence does not block a release. Keep credentials out of logs and retain database rollback evidence for schema changes.
- This standing choice of release channel does not authorize unrelated features, destructive data operations, billing changes or changes to access permissions.
- Preserve untracked `tmp/` and `supabase/.temp/` content. Never add them to a deployment commit.
- Rollout and verification must never physically delete Cloudflare R2 media objects. Physical deletion is allowed only after an administrator explicitly confirms one already-trashed video through the durable permanent-deletion workflow; the cleanup worker must use server-derived exact keys and preserve shared objects.

## Production references

- Supabase project: `ehxqtgakjgqgmghhdmjg`
- GitHub repository: `https://github.com/Foletssi/english-web.git`
- Cloudflare Pages site: `https://english-web-lce.pages.dev/`

