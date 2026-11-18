# Security

Last pen test: 2026-11-18. Local attack suite plus read-only checks on the live Worker.

## Fixed in this round
| Severity | Issue | Fix |
|---|---|---|
| High | Passphrase guessing: 30 parallel guesses in 1 s, no lockout (about 2.4M guesses/day) | `LOGIN_LIMITER`: 10 tries/min per IP and 10/min across all IPs |
| High | Anonymous KV writes: every `/register` and sign-in page load writes to KV. About 500 requests could use up the account's 1,000 free writes/day and break every KV-backed Worker on the account | `AUTH_LIMITER`: 10/min per IP on `/register` and `GET /authorize` |
| Medium | Phishing: anyone could register a client with any https redirect and a fake name like "Claude" | Sign-in page shows the return site. Optional `ALLOWED_REDIRECT_HOSTS` allowlist |
| Low | Bad `/authorize` links crashed the Worker (500, stack trace locally) | Clean 400 page |
| Low | Wrong-passphrase page could be framed (clickjacking) | Anti-frame and no-store headers on every HTML page |
| Low | No request size limit on `/mcp` (8 MB accepted) | 1 MB cap, also for chunked bodies |
| Low | Dependency advisories (zod, MCP SDK, transitive) | Updated, `npm audit` clean |

## Passed
- `/mcp` rejects missing, forged, tampered, Basic and query-string tokens
- PKCE required, S256 only; no implicit, password or client-credentials grants
- Codes single use and bound to client and verifier; refresh tokens bound to client
- Consent cookie: `__Host-`, Secure, HttpOnly, SameSite; handle without cookie rejected; handles single use
- Client names and handles escaped (no XSS); unsafe redirect schemes rejected
- No secrets in errors; no file or config exposure; no delete tools

## Known limits
- Rate limits are per Cloudflare location and approximate. A large botnet could still spend KV writes. Full fix: Workers Paid plan or moving OAuth state off KV.
- The global sign-in cap means an attacker can block new sign-ins for a minute at a time. Existing sessions keep working.
- Security rests on passphrase strength. Use 5+ random words or 20+ random characters.
