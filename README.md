# Brewfather MCP

Remote MCP server for [Brewfather](https://brewfather.app), running on your own Cloudflare Worker. Works with any MCP client that supports remote connectors, on web, desktop, and mobile.

Read, create, and update recipes. Read inventory, batches, and fermentation readings from a Tilt or iSpindel. Move batches between statuses.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/InnerSpark/brewfather-mcp)

## Tools

**Recipes**
- **list_recipes**: paged list (id, name, style, type)
- **get_recipe**: full recipe
- **create_recipe**: new recipe (metric units)
- **update_recipe**: shallow merge; arrays (hops, fermentables, etc.) replace whole

**Inventory**
- **get_inventory**: fermentables, hops, yeasts, or miscs

**Batches**
- **list_batches**: paged list, filter by status (Planning, Brewing, Fermenting, Conditioning, Completed, Archived)
- **get_batch**: full batch, including measured values
- **get_readings**: latest hydrometer reading, or recent history
- **get_brewtracker**: brew day stage and step
- **set_batch_status**: move a batch to a new status. Archived is how you retire one.

## Design rule: archive over delete
No delete tools, ever. Retiring a batch means setting its status to **Archived**, which can be undone. Recipe deletes stay manual in the Brewfather app.

## Security
- You deploy your own copy. Your Brewfather key stays in your Cloudflare account as a Worker secret.
- OAuth in front of `/mcp`. Sign-in is one passphrase you set (`ACCESS_PASSPHRASE`).
- Wrong passphrase: 1 second delay per attempt.

## Before you deploy: Brewfather API key
1. Brewfather → **Settings → Integration** → API section → **Generate API-Key**
2. Scopes: `recipes.read`, `recipes.write`, `inventory.read`, `batches.read`, `batches.write`. Leave the delete scopes off.
3. Copy the **User Id** and **API key** from the dialog.

Brewfather allows one API key per account.

## Deploy: one click
1. Click **Deploy to Cloudflare** above.
2. Sign in to Cloudflare and follow the prompts. It creates the Worker and the storage it needs.
3. When asked for secrets, paste your **User Id** and **API key**, and make up a long **passphrase**.
4. Note your Worker URL, like `https://brewfather-mcp.<you>.workers.dev`.

## Deploy: command line
Needs Node 20+ and a Cloudflare account.

1. `npm install`
2. `npx wrangler login`
3. `npx wrangler kv namespace create OAUTH_KV`, then put the printed `id` in `wrangler.jsonc`
4. Set the secrets (each one prompts for its value):
   ```
   npx wrangler secret put BREWFATHER_USER_ID
   npx wrangler secret put BREWFATHER_API_KEY
   npx wrangler secret put ACCESS_PASSPHRASE
   ```
5. `npm run deploy`

**Check:** open `<URL>/.well-known/oauth-protected-resource/mcp`. `resource` should be `<URL>/mcp`.

## Connect a client
1. In your MCP client, add a **remote / custom connector**
2. URL: `<URL>/mcp`
3. Sign-in page opens. Enter your passphrase, then **Allow**.

## Updating
After a deploy that adds or renames tools, **disconnect and reconnect** the connector in your client. Most clients keep the old tool list until you reconnect.

## Local dev
```
cp .dev.vars.example .dev.vars   # fill in values
npm run dev                      # http://localhost:8787
```

## Notes
- Brewfather API is **metric only**: L, kg, g, °C, SG.
- **Rate limit:** 500 calls/hour per key.
- Recipe updates overwrite the current working version. Lock a version in the app first if you want history.
- **Custom domain:** set the `PUBLIC_URL` var to it (no trailing slash). Otherwise the URL comes from the request.
- **Rotate the passphrase:** `npx wrangler secret put ACCESS_PASSPHRASE`. Existing tokens keep working until they expire. Clear the KV namespace to force everyone to sign in again.

## License
MIT © 2026 Inner Spark Media, LLC. See [LICENSE](LICENSE).
