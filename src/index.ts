import OAuthProvider, { type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildServer } from "./server";

type Env = {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  BREWFATHER_USER_ID: string;
  BREWFATHER_API_KEY: string;
  ACCESS_PASSPHRASE: string;
  PUBLIC_URL?: string; // optional override, e.g. a custom domain
  // Optional comma-separated list of hosts clients may redirect back to,
  // e.g. "claude.ai,claude.com,localhost,127.0.0.1". Unset = any https host.
  ALLOWED_REDIRECT_HOSTS?: string;
  // Rate limiters (wrangler.jsonc "ratelimits"). Per Cloudflare location, approximate.
  AUTH_LIMITER?: RateLimit; // anonymous OAuth endpoints, per IP
  LOGIN_LIMITER?: RateLimit; // passphrase attempts, per IP and global
};

const MAX_MCP_BODY = 1_000_000; // 1 MB

// Headers for every HTML page: no framing, no caching, no sniffing.
const PAGE_HEADERS = {
  "content-security-policy": "frame-ancestors 'none'; default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

const ip = (r: Request) => r.headers.get("cf-connecting-ip") ?? "local";

async function allowed(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limiter) return true;
  try {
    return (await limiter.limit({ key })).success;
  } catch {
    return true; // fail open: never lock the owner out because the limiter is down
  }
}

const tooMany = () =>
  new Response("Too many requests. Wait a minute and try again.", {
    status: 429,
    headers: { "retry-after": "60", "content-type": "text/plain; charset=utf-8" },
  });

function redirectHostAllowed(env: Env, uri: string): boolean {
  const list = (env.ALLOWED_REDIRECT_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return true;
  try {
    return list.includes(new URL(uri).hostname.toLowerCase());
  } catch {
    return false;
  }
}

// MCP endpoint. Only reached with a valid OAuth token (OAuthProvider checks it).
// Stateless: a fresh server + transport per request.
const mcpHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Bound the body even when no content-length was sent (chunked uploads).
    if (request.method === "POST") {
      const buf = await request.arrayBuffer();
      if (buf.byteLength > MAX_MCP_BODY) return new Response("Request too large", { status: 413 });
      request = new Request(request, { body: buf });
    }
    const server = buildServer(env);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function loginPage(handle: string, client: string, error?: string, redirectHost?: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Brewfather MCP sign in</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--muted:#555;--line:#767676;--err:#b00020;--btn:#1a1a1a;--btnfg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#eee;--muted:#bbb;--line:#8a8a8a;--err:#ff8a80;--btn:#eee;--btnfg:#121212}}
body{font:16px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:16px}
main{max-width:360px;margin:10vh auto}
label{display:block;font-weight:600;margin:16px 0 4px}
input{width:100%;box-sizing:border-box;font:inherit;padding:10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
input[aria-invalid=true]{border-color:var(--err);border-width:2px}
button{margin-top:16px;width:100%;font:inherit;font-weight:600;padding:10px;border:0;border-radius:6px;background:var(--btn);color:var(--btnfg);cursor:pointer}
:focus-visible{outline:3px solid #2563eb;outline-offset:2px}
p{color:var(--muted)} .err{color:var(--err);font-weight:600}
</style></head><body><main>
<h1>Brewfather MCP</h1>
<p><strong>${esc(client)}</strong> wants access to your Brewfather recipes.</p>
${redirectHost ? `<p>After you allow, you go back to <strong>${esc(redirectHost)}</strong>. If that is not the app you are connecting, do not continue.</p>` : ""}
<form method="post">
<input type="hidden" name="handle" value="${esc(handle)}">
<label for="pass">Passphrase</label>
<input id="pass" name="passphrase" type="password" autocomplete="current-password" required
 ${error ? 'aria-invalid="true" aria-describedby="err" autofocus' : "autofocus"}>
${error ? `<p id="err" class="err" role="alert">${esc(error)}</p>` : ""}
<button type="submit">Allow</button>
</form></main></body></html>`;
}

async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

const html = (body: string, status = 200, headers?: Headers) => {
  const h = new Headers(headers);
  for (const [k, v] of Object.entries(PAGE_HEADERS)) h.set(k, v);
  h.set("content-type", "text/html; charset=utf-8");
  return new Response(body, { status, headers: h });
};

// Everything that isn't /mcp or an OAuth protocol endpoint: the login page.
const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/authorize") return new Response("Not found", { status: 404 });
    const oauth = env.OAUTH_PROVIDER;

    if (request.method === "GET") {
      // Each consent page writes to KV, so cap it per IP.
      if (!(await allowed(env.AUTH_LIMITER, `authorize:${ip(request)}`))) return tooMany();
      let authReq;
      try {
        authReq = await oauth.parseAuthRequest(request);
      } catch {
        return errorPage("This sign-in link is not valid. Go back to your app and connect again.", 400);
      }
      if (!redirectHostAllowed(env, authReq.redirectUri)) {
        return errorPage("This app is not allowed to connect to this server.", 400);
      }
      const client = await oauth.lookupClient(authReq.clientId);
      const { handle, headers } = await oauth.beginConsent(authReq);
      const host = new URL(authReq.redirectUri).host;
      return html(loginPage(handle, client?.clientName ?? "An MCP client", undefined, host), 200, headers);
    }

    if (request.method === "POST") {
      const form = await request.formData();
      const handle = String(form.get("handle") ?? "");
      const pass = String(form.get("passphrase") ?? "");
      // Cap guesses per IP and across all IPs, so parallel or distributed guessing stays slow.
      if (!(await allowed(env.LOGIN_LIMITER, `login:${ip(request)}`)) || !(await allowed(env.LOGIN_LIMITER, "login:all"))) {
        return tooMany();
      }
      if (!env.ACCESS_PASSPHRASE || !(await sameSecret(pass, env.ACCESS_PASSPHRASE))) {
        await new Promise((r) => setTimeout(r, 1000)); // slow down guessing
        return html(loginPage(handle, "An MCP client", "Wrong passphrase. Try again."), 401);
      }
      let approved;
      try {
        approved = await oauth.approveConsent(request, handle);
      } catch {
        return html("<!doctype html><title>Sign in expired</title><p>This sign-in expired. Go back to your app and connect again.</p>", 400);
      }
      const { request: authReq, headers } = approved;
      const { redirectTo } = await oauth.completeAuthorization({
        request: authReq,
        userId: "owner",
        metadata: {},
        scope: authReq.scope,
        props: {},
      });
      headers.set("location", redirectTo);
      return new Response(null, { status: 302, headers });
    }

    return new Response("Method not allowed", { status: 405 });
  },
};

function errorPage(message: string, status: number): Response {
  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Brewfather MCP</title></head><body><p>${esc(message)}</p></body></html>`, status);
}

// Checks that run before the OAuth library: rate limits, redirect rules, body size.
async function guard(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/register" && request.method === "POST") {
    // Each registration writes to KV, so cap it per IP.
    if (!(await allowed(env.AUTH_LIMITER, `register:${ip(request)}`))) return tooMany();
    if (env.ALLOWED_REDIRECT_HOSTS) {
      let body: { redirect_uris?: unknown };
      try {
        body = await request.clone().json();
      } catch {
        return null; // let the library return its own error
      }
      const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
      if (!uris.every((u) => typeof u === "string" && redirectHostAllowed(env, u))) {
        return Response.json(
          { error: "invalid_redirect_uri", error_description: "Redirect host is not allowed on this server" },
          { status: 400 },
        );
      }
    }
  }
  if (url.pathname === "/mcp" && request.method === "POST") {
    const len = Number(request.headers.get("content-length") ?? "0");
    if (len > MAX_MCP_BODY) return new Response("Request too large", { status: 413 });
  }
  return null;
}

// One provider per public origin. The origin comes from PUBLIC_URL if set,
// otherwise from the request, so a fresh deploy works without config.
const providers = new Map<string, OAuthProvider<Env>>();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const blocked = await guard(request, env);
    if (blocked) return blocked;
    const origin = (env.PUBLIC_URL || new URL(request.url).origin).replace(/\/$/, "");
    let provider = providers.get(origin);
    if (!provider) {
      provider = new OAuthProvider<Env>({
        apiRoute: "/mcp",
        apiHandler: mcpHandler as any,
        defaultHandler: defaultHandler as any,
        authorizeEndpoint: "/authorize",
        tokenEndpoint: "/token",
        clientRegistrationEndpoint: "/register",
        resourceMetadata: { resource: `${origin}/mcp`, resource_name: "Brewfather" },
      });
      providers.set(origin, provider);
    }
    return provider.fetch(request, env, ctx);
  },
};
