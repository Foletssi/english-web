# Eastudy deployment rules

## Mandatory production rollout lane

- Prefer the Codex `mcp__cua_repl.js` tool with the connected Google Chrome extension browser for browser-assisted production operations.
- If the Chrome connector is unavailable because it rejects the active Codex authentication method, an explicitly user-authorized rollout may use the official Supabase CLI for migrations, Git for the `main` push, and Cloudflare Pages' connected-Git deployment. Record the fallback and verify production over HTTPS.
- Use `cua.getState()` or `cua.createBrowserTab("chrome", ...)`, keep the returned tab handle, and operate it through `tab.playwright.*` or `tab.getAXState()`.
- Never substitute Windows desktop control, `@oai/sky`, CDP scripts, `browser-client.mjs`, or the Codex in-app browser for deployment work.
- The fixed production order is: run and verify the Supabase migration; fast-forward `main`; push GitHub; wait for Cloudflare Pages; verify student and administrator URLs in Chrome when available, otherwise use the explicitly authorized HTTPS fallback.
- Do not merge or push `main` when the required Supabase migration has not succeeded through either approved channel.
- Preserve untracked `tmp/` and `supabase/.temp/` content. Never add them to a deployment commit.
- Rollout and verification must never physically delete Cloudflare R2 media objects. Physical deletion is allowed only after an administrator explicitly confirms one already-trashed video through the durable permanent-deletion workflow; the cleanup worker must use server-derived exact keys and preserve shared objects.

## Production references

- Supabase project: `ehxqtgakjgqgmghhdmjg`
- GitHub repository: `https://github.com/Foletssi/english-web.git`
- Cloudflare Pages site: `https://english-web-lce.pages.dev/`

