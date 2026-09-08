# Eastudy deployment rules

## Mandatory production rollout lane

- All browser operations must use the Codex `mcp__cua_repl.js` tool with the connected Google Chrome extension browser.
- Use `cua.getState()` or `cua.createBrowserTab("chrome", ...)`, keep the returned tab handle, and operate it through `tab.playwright.*` or `tab.getAXState()`.
- Never substitute Windows desktop control, `@oai/sky`, CDP scripts, `browser-client.mjs`, or the Codex in-app browser for deployment work.
- The fixed production order is: run and verify the Supabase migration; fast-forward `main`; push GitHub; wait for Cloudflare Pages; verify student and administrator URLs in Chrome.
- Do not merge or push `main` when the required Supabase migration has not succeeded.
- Preserve untracked `tmp/` and `supabase/.temp/` content. Never add them to a deployment commit.
- Content deletion is logical only. Never physically delete Cloudflare R2 media objects during rollout or verification.

## Production references

- Supabase project: `ehxqtgakjgqgmghhdmjg`
- GitHub repository: `https://github.com/Foletssi/english-web.git`
- Cloudflare Pages site: `https://english-web-lce.pages.dev/`

