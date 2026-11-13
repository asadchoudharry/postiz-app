# REKTRS Social — Enterprise Product & Delivery Blueprint
**Version:** 1.0 | **Date:** 2026-11-12 | **Status:** Planning baseline; NOT production deployed
**Target:** https://social.rektrs.com | **App repo:** `asadchoudharry/postiz-app` | **Corporate website repo:** `asadchoudharry/rektrswebsite`

> Current execution plan and measured status: [DELIVERY_PLAN.md](DELIVERY_PLAN.md) and [RELEASE_EVIDENCE_2026-11-13.md](RELEASE_EVIDENCE_2026-11-13.md). This document retains the original planning baseline.

## Executive outcome
Evolve the existing self-hosted Postiz application into **REKTRS Social**, a secure, multi-brand, AI-assisted social media operations platform. Preserve existing customers, connected channels, scheduled/draft posts, OAuth tokens, settings and content. Do not claim development, integrations or deployment completed without recorded evidence.

## Verified discovery / uncertainties
- GitHub `asadchoudharry/postiz-app` is available; the last visible commit on `main` was 2025-04-04, and the repo is an Nx monorepo using Next.js frontend, NestJS backend, Prisma/PostgreSQL, Redis/BullMQ.
- The upstream-derived repo contains route areas for agencies, analytics, authentication, autopost, billing, copilot, integrations, media, messages, posts, settings, users and webhooks. **Presence of a route is not proof that the deployed service exposes a working feature.**
- Corporate website `asadchoudharry/rektrswebsite` contains `app/social/page.tsx` and expanded `app/privacy-policy/page.tsx`, committed 2026-11-12. Their deployment to the public domain has NOT been verified.
- Connected Postiz API list groups and integrations both failed with HTTP 403 from `social.rektrs.com`. Treat as a production connectivity blocker; do not bypass authentication or WAF restrictions. Inspect reverse proxy, rules, API key, trusted clients and server logs.
- `asadchoudharry/Rektrs-Social` is a temporary **public media-assets** repository; not an application source repo. Never commit private media, tokens, client data, or credentials there.
- Hostinger VPS list showed one running VM, but VPS Docker Manager was unsupported for its OS, and there is NO verified link between that VM and social.rektrs.com. Do not guess the host or restart anything.
- Production revision, hosting/Dokploy project, active compose configuration, tenant count, Postiz API entitlements, OAuth scope grants, DB schema and uptime metrics remain unverified.

## Product principles and non-negotiable safeguards
1. Protect live scheduled posts and tokens; capture encrypted DB + media + configuration backups, perform restore rehearsal and document rollback before schema changes.
2. No unreviewed auto-publishing, payments or external API actions. Default author -> reviewer -> publisher; explicit publish approval.
3. Enforce tenant boundary and RBAC in backend, never only UI. Use organization scoping, audit records, least-privilege API scopes and per-tenant usage quotas.
4. Minimize fork divergence: adapters/services first; bounded upstream code modifications second. Document upstream version, license obligations (AGPL-3.0), patch set and update strategy.
5. Security/privacy: consent text must match actual data usage; Google/YouTube scopes, revocation, deletion, retention, AI provider transfers and subprocessors must be documented. No secrets in GitHub.
6. Every delivery must mark status separately: SPECIFIED / CODE_IMPLEMENTED / INTEGRATED / TESTED / DEPLOYED.

## Personas and access model
- **Platform Owner:** global settings, plans, billing, infrastructure; no default visibility into customer sensitive content.
- **Organization Owner:** memberships, brands, connected accounts, subscriptions, approvals.
- **Marketing Manager:** campaigns, scheduling oversight, analytics, publishing authorizations.
- **Editor/Creator:** content, images and drafts; cannot publish without required approval.
- **Reviewer/Legal:** approve/reject/request revision with comments; no implicit administrator.
- **Publisher:** allowed to publish approved items to assigned channels.
- **Analyst:** read-only reporting and exports.
- **Agency Manager / Client Approver:** cross-client dashboard (scoped) and client review.
- **Support/Developer:** time-bound scoped access, auditable elevation; no plain token display.
Security constraints for every API: authenticated actor, organization ID, brand/channel authorization, object ownership, plan entitlement, rate limits, idempotency and audit event.

## Information architecture / portals
1. **Owner Console:** platform health, organizations, plans, providers, usage, incidents, audit/security.
2. **Organization Workspace:** overview, brand kits, channels, calendar, media, campaigns, posts, approvals, content library, analytics and automations.
3. **AI Studio:** brand-memory sources, agent instructions, topic research, copy, design, video, review, provider costs and approvals.
4. **Agency Workspace:** clients, team, white-label reporting, intake, asset approvals, assignments and invoices.
5. **Client Portal:** campaign brief, preview, comment/revision, approval and read-only performance.
6. **Developer / Integration Console:** API keys, events, webhooks, scoped integrations, retries and logs.
7. **Public Website & Compliance:** product description, privacy, terms, consent explanation, support, deletion and security contact.

## End-to-end lifecycle
Brief -> brand/source selection -> research with source links -> content draft -> per-platform adaptations -> media generation -> accessibility/brand/legal QA -> reviewer decision -> approval audit -> schedule -> worker queue -> provider publish -> provider receipt/status -> analytics ingestion -> attribution -> learning/reporting.
Alternative states: draft / needs-review / changes-requested / approved / scheduled / publishing / published / partially-published / failed / canceled / expired. All mutations require optimistic concurrency, idempotency and detailed event history. Rejected content cannot auto-publish. Schedule edits after approval re-open review where policy requires.

## Delivery phases & exit gates
| Phase | Slice | Minimum working deliverables | Exit gate |
|---|---|---|---|
| P0 | Discovery and recovery | environment map, backups/restore drill, production revision, WAF 403 diagnosis, OAuth verification, privacy/public pages audit | verified log evidence, restored backup, production HTTPS/auth/API checks |
| P1 | Platform hygiene | health checks, worker/queue visibility, redacted logs, RBAC/tenant tests, secrets rotation plan, CI security checks | zero critical auth leaks, reproducible staging/release/rollback |
| P2 | REKTRS UI & multi-brand | semantic design tokens, responsive/RTL-ready light/dark navigation, brand switcher, brand profile, media library and improved calendar | screen/action/state QA, keyboard/accessibility, multi-brand isolation |
| P3 | Approval and campaigns | content pipeline, assignments, approvals, campaign planner, version history, notification and evidence | rejected content blocked, approvals auditable, no publish bypass |
| P4 | AI Content Studio | brand memory, editable prompts, captions, multilingual copy, variants, research citations, moderation and cost controls | verified human approval, no unsupported factual assertions, provider error handling |
| P5 | Creative & video | templates, graphics/carousels, alt text, video provider adapters, queue/cost/budget monitoring, media rights | render QA, consent/rights, cost cap, device previews |
| P6 | Analytics & attribution | data contracts, channel metrics, UTM links, campaign dashboard, exports, historical snapshots | metric provenance, timezone correctness, API limits respected |
| P7 | Automation, CRM, inbox | webhook engine, n8n connector, WordPress/CMS triggers, lead intake and permissible inbox APIs | retry/dead-letter, dedupe, token and permission tests |
| P8 | Agency, referrals & SaaS | client portal, subscriptions, usage entitlement, audit, payment integration (sandbox first), referral/affiliate | tenant isolation, billing reconciliation, refunds, entitlement tests |
| P9 | Production hardening and scale | load testing, backup restore, failover, upgrade playbook, monitoring, SLA/SLO dashboard | staged release, signed approval, successful smoke/regression checks |

**Sequencing:** P0/P1 block production feature releases. P2/P3 may proceed in a feature branch using mock data, not production accounts. P4/P5 are intentionally gated by privacy/provider approvals. P8 does not activate live payments until owner approval and reconciliation validation.

## Feature acceptance examples
- **Brand switch:** only assigned brands visible; route and API tenant-scoped; switch updates data and filters; stale request discarded; persists safely.
- **Review:** creator submits draft; reviewer sees original and diff; approve/reject/comment records user/time/version; post cannot publish if pending/rejected.
- **Schedule:** platform limits and timezone validated; duplicate callback does not double-publish; expired token triggers actionable error without leaking secrets.
- **AI:** retrieval sources shown; no external confidential attachments sent without configured consent; user sees token/credit estimate; all AI outputs remain drafts.
- **Analytics:** source, timestamp, channel and aggregation definition visible; missing API metric displays not-available rather than invented zero.
- **Billing:** sandbox checkout and webhook signature validation; retries idempotent; payment failure leads to controlled grace states, not data deletion.

## Data architecture (proposed; not existing schemas)
Entity families: organizations, memberships, brands, brand_assets, brand_rules, channel_connections, campaigns, briefs, content_items, content_versions, approval_requests, review_events, schedules, publication_attempts, media_assets, ai_runs, ai_usage, metric_snapshots, attribution_events, automations, workflow_runs, provider_tokens (encrypted), audit_events, subscriptions, plans, usage_ledger, clients, leads, referrals. Use composite uniqueness, soft-delete/retention policy, creation/modification actors and tenant-enforced query filters. Implement migrations only after actual Prisma schema inspection.

## API contract candidates (proposal)
`GET /api/rektrs/v1/brands`; `POST /api/rektrs/v1/brands`; `POST /api/rektrs/v1/campaigns`; `POST /api/rektrs/v1/content`; `POST /api/rektrs/v1/content/:id/submit`; `POST /api/rektrs/v1/reviews/:id/decision`; `POST /api/rektrs/v1/content/:id/schedule`; `GET /api/rektrs/v1/analytics/campaigns/:id`; `POST /api/rektrs/v1/automations`; `GET /api/rektrs/v1/audit`. These are proposed, not implemented. Specify OpenAPI schemas and auth/ownership before coding.

## Quality gates
- Static tests: lint, TS compile, unit tests, dependency/license/secrets scanning.
- Integration: Postgres migrations/rollback, Redis queue, provider mocked OAuth callbacks, webhook signatures and retries.
- E2E: owner/editor/reviewer/client role matrix, multi-tenant isolation, draft approval, scheduled publishing, failed/retry states, notifications.
- UI: desktop/mobile, 320px+, light/dark, English/Arabic RTL where supported, WCAG 2.2 AA target, keyboard-only, screen reader, empty/loading/error states.
- Operational: backup snapshot + tested restore, health/queue monitoring, deployment provenance, incident response, audit retention.
- Release artifacts: approved PR, CI results, staging URL/evidence, migration plan, rollback procedure and production post-deploy smoke log.

## Ownership / repo strategy
- Keep application changes in `asadchoudharry/postiz-app` on reviewable branches.
- Keep website/OAuth public page changes in `asadchoudharry/rektrswebsite`.
- Keep media-assets repo public-only and isolated.
- Open tickets with acceptance tests for each vertical slice; use an explicit release tag and upstream merge ledger.

## Current status (2026-11-12)
SPECIFIED: this blueprint. CODE_IMPLEMENTED: none by this blueprint. INTEGRATED: none. TESTED: repository/connector metadata and 403 response only. DEPLOYED: not performed.
