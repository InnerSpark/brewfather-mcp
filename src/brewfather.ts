// Thin client for the Brewfather API v2. All data is metric (L, kg, g, °C, SG).
const BASE = "https://api.brewfather.app/v2";

export type BfEnv = { BREWFATHER_USER_ID: string; BREWFATHER_API_KEY: string };

export async function bf(
  env: BfEnv,
  path: string,
  init: { method?: string; query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
): Promise<unknown> {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const auth = btoa(`${env.BREWFATHER_USER_ID}:${env.BREWFATHER_API_KEY}`);
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Basic ${auth}`,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    const hint =
      res.status === 401 ? " (check BREWFATHER_USER_ID / BREWFATHER_API_KEY)"
      : res.status === 403 ? " (API key is missing the scope for this call)"
      : res.status === 429 ? ` (rate limited, retry after ${res.headers.get("retry-after") ?? "?"}s)`
      : "";
    throw new Error(`Brewfather ${res.status}${hint}: ${text.slice(0, 2000)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text; // PATCH returns plain "Updated"
  }
}
