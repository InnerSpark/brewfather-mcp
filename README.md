# Brewfather MCP

Remote MCP server on a Cloudflare Worker. Lets any MCP client that supports remote connectors read, create, and update your Brewfather recipes and read inventory.

## Tools
- **list_recipes**: paged list (id, name, style, type)
- **get_recipe**: full recipe
- **create_recipe**: new recipe (metric units)
- **update_recipe**: shallow merge; arrays (hops, fermentables, etc.) replace whole
- **get_inventory**: fermentables, hops, yeasts, or miscs

No delete tool, on purpose.

## Security
- OAuth in front of `/mcp`. Login is one passphrase (`ACCESS_PASSPHRASE`).
- Brewfather credentials live only as Worker secrets.
- Wrong passphrase: 1 second delay per attempt.

## Deploy

Needs Node 20+ and a Cloudflare account.

1. **Install deps:** `npm install`
2. **Log in:** `npx wrangler login`
3. **KV namespace:** `npx wrangler kv namespace create OAUTH_KV`
   Paste the printed `id` into `wrangler.jsonc` (`REPLACE_WITH_KV_ID`).
4. **Secrets** (each prompts for the value):
   ```
   npx wrangler secret put BREWFATHER_USER_ID
   npx wrangler secret put BREWFATHER_API_KEY
   npx wrangler secret put ACCESS_PASSPHRASE
   ```
5. **First deploy:** `npm run deploy`
   Note the URL it prints, like `https://brewfather-mcp.<you>.workers.dev`.
6. **Set `PUBLIC_URL`** in `wrangler.jsonc` to that URL (no trailing slash), then `npm run deploy` again.
7. **Check:** open `<URL>/.well-known/oauth-protected-resource/mcp`. `resource` should be `<URL>/mcp`.

## Connect a client
1. In your MCP client, add a **remote / custom connector**
2. URL: `<URL>/mcp`
3. Sign-in page opens. Enter your passphrase, hit **Allow**.

## Brewfather API key scopes
`recipes.read`, `recipes.write`, `inventory.read`. Leave the delete scopes off.
Key is made in Brewfather → Settings → API. One key per account.

## Local dev
```
cp .dev.vars.example .dev.vars   # fill in values
npm run dev                      # http://localhost:8787
```

## Notes
- Brewfather API is **metric only**: L, kg, g, °C, SG.
- **Rate limit:** 500 calls/hour per key.
- Recipe updates overwrite the current working version. Lock a version in the app first if you want history.
- Rotate the passphrase: `npx wrangler secret put ACCESS_PASSPHRASE`. Existing tokens keep working until they expire; delete the KV namespace contents to force re-login.
