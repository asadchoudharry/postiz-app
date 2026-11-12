# Phase P0 — Discovery, Restore Safety and OAuth/API Recovery
**Status:** In progress / source inspected, live hosting not verified. No production mutation authorized.

## P0.1 Discovery checklist
- [x] Identify `postiz-app` application source and core technology.
- [x] Identify `rektrswebsite` public OAuth/Privacy routes in source.
- [x] Identify `Rektrs-Social` repository as public media assets only.
- [x] Confirm connected Postiz group/integration calls return HTTP 403.
- [ ] Verify DNS, TLS and hosting mapping for `social.rektrs.com`; find deployed image digest and Git SHA.
- [ ] Inventory deployed containers, database, Redis, media storage, scheduler/worker/cron and mail transport.
- [ ] Record valid OAuth redirect URLs, scopes, application name, authorized domains and Google verification status.
- [ ] Verify public `/social/` and `/privacy-policy/` responses by authenticated-independent HTTP test and browser.
- [ ] Inventory existing integrations and scheduled/draft counts using authorized access.

## P0.2 Non-destructive diagnostics for authorized VPS shell
Run in the **verified** Postiz host (not a guessed VM). Commands are read-only:
```bash
date -u
hostname
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
docker compose ls
curl -sSI --max-time 12 https://social.rektrs.com/
curl -sSI --max-time 12 https://rektrs.com/social/
curl -sSI --max-time 12 https://rektrs.com/privacy-policy/
```
For 403: compare proxy logs (Nginx/Traefik/Caddy/WAF) with app auth logs at a single timestamp; inspect request path and denied rule safely. Do **not** disable WAF wholesale or publish API keys. Check Postiz connector origin/network restrictions, service access headers, credentials and whether the expected API path is supported. If connector traffic is blocked by an upstream proxy, implement an allowlist narrowly for authenticated API routes after verifying the request source and security impact; preserve CSRF and rate limits.

## P0.3 Backup / restore gate
Capture timestamped encrypted PostgreSQL backup, media archive, configuration manifest **without secrets**, sanitized environment variable key inventory, deployment compose reference, Redis persistence/queue snapshot where applicable, worker scheduler state, image digest and Git SHA. Save credentials only in secret manager. Restore into isolated staging, verify user/post/integration counts, database integrity and scheduling disabled in staging. Record RPO/RTO and a tested rollback command. Do not run schema migration or image update before this gate.

## P0.4 Google OAuth consent gate
- Public application homepage must be publicly accessible, clearly show app name `Rektrs Social`, function, operator and links.
- Privacy must explain exactly used data types/scopes, processing purposes, token storage, third parties, retention, revocation, deletion, contact and Limited Use practices where applicable.
- Inspect actual Postiz scope grants and configuration to verify accuracy; do not claim that every documented optional feature is enabled.
- Authorized domain and OAuth screen name match `rektrs.com` public pages.
- Verify Google redirect URI/HTTPS and successful account connection; test revoked/expired token behavior; no credential screenshots or secret commits.
- Re-submit Google verification **after** public deploy and full policy verification.

## P0.5 Safety and sign-off
Never delete an integration or post, trigger publishing, rotate credentials, restart services, or redeploy production without owner-reviewed change record and backup/restore evidence. Exit requires: public pages HTTP 200 with correct content; authenticated API connector can list permitted integrations; successful OAuth test; queues healthy; backup restore verified and P1 prioritized tickets created.

## Evidence register
| Item | Evidence | Finding |
|---|---|---|
| Connected Postiz list APIs | 2026-11-12 tool attempts | HTTP 403, source/location of denial unconfirmed |
| REKTRS website public route | `rektrswebsite/app/social/page.tsx` | Code present, production state unknown |
| Expanded privacy policy | `rektrswebsite/app/privacy-policy/page.tsx` | Code present, production state unknown |
| Fork source | `postiz-app` `main` | Nx/Postiz fork, main last seen commit Apr 2025 |
| Hostinger connector | VPS list + Docker Manager call | VM present; Docker Manager unsupported; Postiz host not established |

## Execution evidence update — 12 November 2026

| Work item | Source / artifact | Status |
| --- | --- | --- |
| P0 read-only public preflight | [PR #2](https://github.com/asadchoudharry/postiz-app/pull/2), scripts/rektrs-social-preflight.mjs | CODE_IMPLEMENTED on draft branch; local 6/6 tests PASS; GitHub CI PASS |
| P0 live endpoint probing | Manual-only workflow, PR #2 | NOT RUN against production; not a production health verdict |
| P2 guarded brand identity | [PR #3](https://github.com/asadchoudharry/postiz-app/pull/3) | CODE_IMPLEMENTED on draft branch; static CI PASS; not rendered, merged or deployed |
| Postiz Cloud connector | groupList and integrationList from 2026-11-12 | HTTP 403, underlying auth/WAF/proxy cause UNKNOWN |
| Public corporate routes | rektrswebsite source, app/social/page.tsx and app/privacy-policy/page.tsx | SOURCE VERIFIED; production HTTP status not verified |
| Hostinger domain access | Hostinger DNS API on connected account | DNS:4002, account does not own rektrs.com; not evidence of actual DNS misconfiguration |
| Hostinger VPS inventory | Hostinger VM and Docker Manager API | One running VM in connected account; Docker Manager unsupported for its OS; **no proof** VM serves REKTRS |
| Production backups, OAuth and version | No authorized shell or deployment metadata yet | BLOCKED / NOT VERIFIED |

### Safe follow-up execution order

1. Obtain a verified map of the actual Postiz hosting/Dokploy deployment from authorized infrastructure access. Confirm the live image digest and corresponding Git SHA before modifying code.
2. Inspect proxy/Cloudflare/WAF and Postiz backend access logs to identify where the 403 arises. Preserve authorization checks and do not globally disable WAF.
3. Confirm independent public HTTPS responses for /social/ and /privacy-policy/, including Google scope wording and support contact. Deploy website source only after release review.
4. Produce encrypted PostgreSQL/media/config backups and successfully restore into isolated staging; confirm scheduling/publishing disabled on staging.
5. Merge release-reviewed PRs and enable NEXT_PUBLIC_REKTRS_SOCIAL_BRAND only in the verified REKTRS frontend build after login/redirect/role and visual QA.
6. Complete Google OAuth scope, redirect and revocation checks; resubmit verification after the public website and app are verifiably aligned.

**No production services, accounts, subscriptions, databases, scheduled posts, provider permissions, or DNS records were modified by these PRs.**

### Product advancement status — 12 November 2026

- [PR #4](https://github.com/asadchoudharry/postiz-app/pull/4) implements an opt-in, nonblocking REKTRS Content Review panel in the global post composer with Unicode-compatible editorial heuristics, inline states and copyable review. GitHub Actions regression workflow succeeded (11 tests). This is a P2/P3 **code implementation**, not a deployment or a server-enforced approval process.
- The release gate remains: actual Postiz runtime mapping and revision, backup/restore rehearsal, 403 API diagnosis, staging frontend compilation and browser review. Do not enable the feature flag in production until completed.
