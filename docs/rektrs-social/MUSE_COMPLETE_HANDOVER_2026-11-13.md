# REKTRS Social / Postiz — Complete Muse Handover
Date: 2026-11-13. Owner: REKTRS (Private) Limited. Status: source implementation and CI verified; **NOT custom-deployed to production**.

> Read this before changing source or infrastructure. Actual evidence outranks plans. Never treat an unimplemented feature or a passing build as production-ready. Keep AMAC resources completely separate from REKTRS.

## 1. Project goal, scope, final outcome

Convert the already-installed self-hosted Postiz at https://social.rektrs.com (existing Dokploy https://rektrs.cloud) into REKTRS Social, an enterprise-quality multi-organization, multi-brand social operations system. Preserve all users, channels, OAuth credentials, media, drafts, scheduled items, delivery receipts and settings. Preserve the actual Postiz provider/worker lifecycle until a safely tested alternative exists.

Target product workspaces: platform owner console; organization/brand workspace; AI content studio; agency workspace; client preview/approval portal; developer/API/automation console; public website/compliance pages. Target flows: brand and campaign setup; research and brief; platform-specific draft/media; editorial checks; version-bound human approval; permission-checked scheduling; Temporal-backed delivery/receipt; analytics; client reports; signed automations; agency subscriptions and referrals. Most future modules are **PLANNED ONLY**.

Exit gate: complete role/tenant/auth flows, required P0–P9 slices or documented owner descope, fully tested backup/restore/rollback, real staging E2E and browser/a11y checks, source-labelled metrics, compliant OAuth and a verified production release through the existing service.

## 2. Delivered work with proof

- GitHub repository is https://github.com/asadchoudharry/postiz-app, ID 960591620, public, default main (OLD Next14 fork); wrong address git-on-my-level/postiz-app returns 404.
- PR #1 planning https://github.com/asadchoudharry/postiz-app/pull/1 (enterprise blueprint, seven portals, P0–P9, Phase-0 runbook).
- PR #2 diagnostics https://github.com/asadchoudharry/postiz-app/pull/2 (read-only public homepage/privacy/login checks, six passing tests).
- PR #3 identity https://github.com/asadchoudharry/postiz-app/pull/3 (default-off login/navigation identity on OLD codebase).
- PR #4 editor https://github.com/asadchoudharry/postiz-app/pull/4 (default-off advisory review, Unicode/Arabic hashtags, duplicates, placeholders, links, score, copy report; 11 tests).
- PR #5 old combined candidate https://github.com/asadchoudharry/postiz-app/pull/5 (branch release/rektrs-social-2026-11-13; 33 local tests and old Nx Build https://github.com/asadchoudharry/postiz-app/actions/runs/43309821000). **Do not deploy**: older Next14/BullMQ architecture is incompatible with observed Next16/Temporal runtime.
- Authenticated Dokploy runtime discovery: Node 22.20.0, Next 16.3.1, pnpm 10.6.1, @temporalio/client ^1.14.0. Deployed package.json, pnpm-lock.yaml, Prisma schema fingerprints exactly matched upstream October 2 commit 8e42f09cb45c3b6be16656c2d23a372d5eb21053. NOT proof that every source file matches.
- PR #6 matched-source implementation https://github.com/asadchoudharry/postiz-app/pull/6 (draft, base baseline/postiz-next16-2026-10-02, head release/rektrs-social-next16-2026-11-13). Commits: 33f1c99 (Next16 branding/editorial), 1b9cc5a (HTML parser fix), 10b62de (real React/jsdom tests), 6e0beb6 (migration-free runtime candidate), 661192c (safety assertion fix), b6f86c43 (inventory utility/operator runbook). Before this handover the PR head was b6f86c43041116accdb56abf75a878bfa1a73e6f.
- Successful exact-head CI: Next16 editorial/safe-entrypoint/React/frontend https://github.com/asadchoudharry/postiz-app/actions/runs/43369907404 (10 Node tests, eight Python inventory tests, React/jsdom step, frontend build); complete Build https://github.com/asadchoudharry/postiz-app/actions/runs/43369907201 and https://github.com/asadchoudharry/postiz-app/actions/runs/43369901273. A later documentation commit needs its own fresh check before being described as passed.
- Alias release/rektrs-nextjs16 created for Muse and aligned to PR #6 code at b6f86c43. PR #6 itself follows the longer branch; Muse must not accidentally push only to the alias when continuing the PR.
- Corporate site code exists in private https://github.com/asadchoudharry/rektrswebsite at app/social/page.tsx and app/privacy-policy/page.tsx. **Live deployment not proven**. Historical automated public check: /social 404, privacy 200 with old company-only content, Postiz /auth 200.
- Public campaign assets repo https://github.com/asadchoudharry/Rektrs-Social is NOT the app repo. README defines YYYY-MM-DD/campaign-name/ folders and seven-day cleanup, with no confidential media. Earlier REKTRS Week 1 posting attempts are not independently verified as published.
- Read-only runtime issue diagnosis: temporal:7233 CLI SERVING, loopback 127.0.0.1:7233 refused, Docker healthcheck incorrect; still not fixed. Postiz Cloud connector group/integration read-only requests returned HTTP 403; origin unknown. Unauthenticated GET /api/mcp returned application 401; this does NOT prove authenticated relay works.
- No production source replacement, image publication, schema mutation, backups/restore, extra server, new SSH authorization, automatic posting, OAuth review approval or payments completed.

## 3. Complete planned customizations

P0 — identify exact Dokploy host/image/queue, diagnose 403, public OAuth compliance, private encrypted DB/Temporal/media/config backup, non-publishing restore drill. Gate: host verified, counts reconcile, API reachability, correct public pages, OAuth test.

P1 — source/OCI provenance, code/update discipline, secure build pipelines, observability, role and tenant tests, queue/worker health, immutable image, rollback evidence.

P2 — polished REKTRS UI, semantic tokens, responsive layouts (320/360/768/1440), keyboard/WCAG target, supported English/Arabic RTL and light/dark, brand profiles, multi-brand switcher, media library, calendar, complete UI states.

P3 — campaigns and enforceable approvals: brief, assignment, content versions, reviewer inbox, comments, approve/reject/request revision, maker-checker, approved immutable hash, schedule invalidated by protected edits; all server/public API/automation/retry/autopost routes must obey policy.

P4 — AI content research/writing/localization and brand-memory library, source citation, text variants, review, manual/free-first work; external providers optional with permissioned credentials, privacy and usage budgets, never auto-publish AI text.

P5 — images/carousels/videos, branded editable templates, alt text, media-size/duration validation, asset licensing, provider job status, spending controls.

P6 — provider analytics with timestamps/timezones/source, campaign attribution and safe UTM links, brand/client comparisons, CSV/PDF exports, missing metrics marked not-available not fabricated zeros.

P7 — signed webhooks, WordPress/CMS/n8n draft triggers, retries/deduplication/dead-letter, allowed inbox and leads/CRM, consent; existing Temporal queue remains delivery authority.

P8 — agency/client portal with separate client permissions, invites, scoped reports, entitlements/usage, sandbox billing, referral and affiliate system; no production charges without owner approval.

P9 — load/security/observability/SLA, maintenance/upgrade procedures, scheduled off-host restore drills, staging and production acceptance, complete runbooks and user training.

Seven personas/role families: platform owner; organization owner; marketing manager; creator; reviewer; publisher; analyst; agency manager/client approver; support with time-bound audited access. Tenancy must be enforced at DB/API/jobs/export level, never merely frontend.

Target workflow: brief -> brand -> sources -> draft -> channel variants -> media/alt -> editorial check -> immutable submission -> human review -> approved version -> permissioned schedule -> Temporal job -> provider receipt -> sourced metrics. Errors include rejected/changes-requested/expired/canceled/partial publish/retry/revoked-token. Optimistic concurrency and idempotency are mandatory.

Proposed, NOT implemented, data families: brands, clients, campaigns, briefs, content versions, approvals and events, schedule/publication attempt, media, AI runs/usage, analytics snapshots, attribution, automation runs, audits, subscriptions/referrals/usage. Proposed URL namespace /api/rektrs/v1 for brand, campaign, submit, decision, schedule, metrics, automation and audit endpoints: these do NOT exist yet merely because documented.

### Branding

Flag NEXT_PUBLIC_REKTRS_SOCIAL_BRAND is default false. PR #6 edits actual Next16 shared logo, auth layout/login/register, page titles, privacy/product links. Flag NEXT_PUBLIC_REKTRS_CONTENT_REVIEW default false; its visible advisory panel is in actual apps/frontend/src/components/new-launch/editor.tsx and uses apps/frontend/src/components/rektrs-social/*. Both are Next build-time public flags; rebuilding is necessary. Full Next16 navigation rebrand/white-label and design-system parity still require design + verification. Earlier PR #3 code paths are incompatible and cannot be copied verbatim.

### Google OAuth

Historical Google reviewer issues: insufficient content at https://rektrs.com/privacy-policy/; homepage apparently behind login; name Rektrs Social did not match homepage brand. Fix via public unauthenticated https://rektrs.com/social/ with matching product/operator and privacy/terms/support links, and actual live privacy text with Google/YouTube scopes, data purpose, token storage, transfer, Limited Use, retention, revocation and deletion. In Google Cloud: consent app name Rektrs Social, verified rektrs.com domain, correct public URLs, minimum scopes, appropriate Testing testers/Production status, working authorized redirects. Historical YouTube callback https://social.rektrs.com/integrations/social/youtube ; candidate Google Business Profile callback /integrations/social/gmb only if supported by actual provider. Confirm in live code and configuration. Map YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in the existing compose/secret setup. Do not guess other GMB variable names. Confirm channel connect, permission grant, revoke, reconnect, token expiry and independent Google approval status before claiming done.

### Deployment

Existing Dokploy service is fixed; no parallel live Postiz installation. Use source-matched REKTRS-owned immutable image, not ghcr.io/gitroomhq/postiz-app:latest. New Dockerfile.rektrs + scripts/rektrs-social-start.sh are **staging-only candidate code**: unlike upstream root pm2-run, no automatic Prisma db push --accept-data-loss, but real process supervision/boot has not been proven. Any schema migration is a separately reviewed operation on a restored/staged database. AGPL-3.0 licensing/source availability must be respected.

## 4. Technical execution for Muse

1. GitHub account: asadchoudharry. Clone repo, fetch branches, checkout PR #6 actual head. DO NOT start from default main.
2. Read old PR #5 docs ENTERPRISE_BLUEPRINT, DELIVERY_PLAN, PHASE_0_RUNBOOK, LIVE_RUNTIME and current PR #6 NEXT16_PORT/OPERATOR_RELEASE_GATE. Review apps/frontend/AGENTS.md and installed Next16 docs before frontend changes.
3. Reproduce on Node 22.20.0 / pnpm 10.6.1: frozen install, prisma-generate (not db push), pure Node tests, Python inventory tests, jsdom component test, full pnpm run build. Check GitHub Actions actual SHA.
4. Authenticate to existing https://rektrs.cloud Dokploy project rektrs-private-limited-postiz-gekzbw. Confirm hostname, container, digest, services, routing, versions and mounts. Historical target srv1322702, while linked Hostinger VPS srv2107420 is different and must not be treated as the Postiz host.
5. Host shell currently failed SSH authorization. Owner authorizes existing Dokploy public key /etc/dokploy/ssh/auto_generated-dokploy-local.pub for the intended user, or supplies another legitimate host access route, outside chat. No container-escape workaround.
6. On identified host run read-only python3 scripts/rektrs-dokploy-inventory.py; protect output. A BLOCKED result is expected for missing OCI revision label or old Temporal health; never falsify PASS.
7. For Postiz Cloud 403 inspect timestamp-matched proxy/WAF and app authorization data, auth route/version and request provenance. Avoid blanket WAF/CSRF/rate-limit disabling and never print tokens.
8. Map and back up **all** persistent state: Postiz Postgres roles/schema/data; Temporal Postgres/workflow persistence and visibility where needed; uploads/config; durable Redis if present; worker state and image/compose references. Encrypt off-host and store keys separately; never put archives under /uploads or in public CI/Git.
9. Restore a fully isolated replica with provider publishing, outbound callbacks, emails and production credentials disabled. Compare users, tenants, channels, scheduled/draft posts, media and workflows, and demonstrate rollback. No release without this.
10. Inspect actual website release and CMS override pipeline from private rektrswebsite repo. Publish source app/social/page.tsx and updated app/privacy-policy/page.tsx to the existing public website, confirm HTTP 200/no login and rendered Google data language, then fix Google OAuth consent.
11. Only after backups and immutable snapshots, correct Temporal health with version-verified command temporal operator cluster health --address temporal:7233, using a targeted service change rather than redeploying every mutable image. Confirm Docker healthy and worker connectivity.
12. Validate complete source-to-image provenance; build Dockerfile.rektrs image with exact REKTRS_SOURCE_REVISION and explicit public build flags in isolated staging. Publish to REKTRS registry only after tests.
13. Staging acceptance: auth/logout, RBAC and tenant negatives, channel ownership, drafts/media, editor/review, browser responsive/RTL/keyboard, fake/mocked provider delivery, Temporal idempotency, timezone and restore. No live social posts.
14. Record previous compatible digest and migration/rollback evidence. Deploy only into same existing Dokploy app service preserving network, volumes, route and port; no docker compose down -v, no latest tag, no new production project. Post-deploy reconcile counts, queues, receipts, connection errors.
15. Continue P2-P9 in small reviewed vertical slices. Require actual schema/API tests, UI states and stage evidence before marking each complete. P8 payments remain sandbox until separate owner approval.

## 5. Artifacts, sources, links

Core: https://github.com/asadchoudharry/postiz-app ; PR #1 /pull/1, #2 /pull/2, #3 /pull/3, #4 /pull/4, #5 /pull/5, #6 /pull/6.
Next16 base: https://github.com/asadchoudharry/postiz-app/tree/baseline/postiz-next16-2026-10-02
PR #6 head: https://github.com/asadchoudharry/postiz-app/tree/release/rektrs-social-next16-2026-11-13
Muse alias: https://github.com/asadchoudharry/postiz-app/tree/release/rektrs-nextjs16
Old PR #5 branch: https://github.com/asadchoudharry/postiz-app/tree/release/rektrs-social-2026-11-13
Old blueprint/planning branch: planning/rektrs-social-enterprise-2026-11.

Old PR #5 documents: docs/rektrs-social/ENTERPRISE_BLUEPRINT.md; DELIVERY_PLAN.md; PHASE_0_RUNBOOK.md; LIVE_RUNTIME_2026-11-13.md; RELEASE_EVIDENCE_2026-11-13.md; CONTENT_REVIEW_V1.md; evidence/2026-11-13-public-preflight.json. Scripts: rektrs-social-preflight.mjs + tests; rektrs-volume-recovery.cjs + tests (local config/uploads backup helper, NOT a complete Postgres/Temporal restore).

New PR #6 files: docs/rektrs-social/NEXT16_PORT_2026-11-13.md; OPERATOR_RELEASE_GATE.md; Dockerfile.rektrs; scripts/rektrs-social-start.sh; scripts/rektrs-social-safe-start.test.mjs; scripts/rektrs-dokploy-inventory.py; scripts/test_rektrs_dokploy_inventory.py; scripts/rektrs-next16-port.test.mjs; scripts/ui/rektrs-next16-review.test.cjs; .github/workflows/rektrs-next16-port.yml; apps/frontend/src/components/rektrs-social/quality-rules.ts and content-review.tsx; apps/frontend/src/components/new-launch/editor.tsx; apps/frontend/src/components/ui/logo-text.component.tsx; apps/frontend/src/components/auth/login.tsx; apps/frontend/src/app/(app)/auth/layout.tsx, login/page.tsx and page.tsx; .env.example flags.

Company site private: https://github.com/asadchoudharry/rektrswebsite ; files app/social/page.tsx, app/privacy-policy/page.tsx and app/terms-conditions/page.tsx. Public media repo: https://github.com/asadchoudharry/Rektrs-Social.

## 6. Known infrastructure and configuration

Dokploy https://rektrs.cloud, historically v0.30.8. Project rektrs-private-limited-postiz-gekzbw; app container rektrs-private-limited-postiz-gekzbw-postiz-app-1; live domain https://social.rektrs.com with internal port 5000. Historical hostname srv1322702; Hostinger connected account only showed srv2107420, NOT verified as target.

Running app registry ghcr.io/gitroomhq/postiz-app:latest; October 2 image ID/digest sha256:7eb4a553507ce3f200deff2ec0211ab3cf834ba19eb44dd68e83ccc236509feb; container created October 6. Image has no OCI source/revision labels; /app/version.txt said v1.47.0, but that historical tag does not correspond to running Next16/Temporal code. Postiz config volume rektrs-private-limited-postiz-gekzbw_postiz-config at /config and uploads volume rektrs-private-limited-postiz-gekzbw_postiz-uploads at /uploads. Other DB and Temporal state mounts MUST be inventoried, not guessed.

Postiz runs PostgreSQL/Redis and Temporal; Temporal image temporalio/auto-setup:1.28.1. Upstream illustrative docker-compose also includes Postgres 17, Redis 7.2, Temporal PostgreSQL, Elasticsearch, UI/admin tools — NOT confirmation every service is actually deployed. Relevant env NAME inventory only (do not reveal values): MAIN_URL, FRONTEND_URL, NEXT_PUBLIC_BACKEND_URL, BACKEND_INTERNAL_URL, DATABASE_URL, REDIS_URL, TEMPORAL_ADDRESS, JWT_SECRET, STORAGE_PROVIDER, upload paths, IS_GENERAL, DISABLE_REGISTRATION, YOUTUBE_CLIENT_ID/SECRET and other enabled provider keys, both NEXT_PUBLIC_REKTRS_* flags.

Dokploy project Backups and Volume Backups tabs showed no configured backups; other off-host backups not ruled out but none verified. Host terminal SSH auth failed; container terminals allowed limited inspection. Postiz Cloud connected relay returned 403 on groups/integrations.

## 7. Decisions and reasons

- Preserve existing live Dokploy server/domain/service and current user accounts instead of installing a new production instance (continuity and avoiding duplicate posts).
- Match current Next16/Temporal source, not old Next14 default main or PR #5 (compatibility).
- Keep old draft PRs for history; PR #6 current implementation authority (traceability).
- Default both brand and review flags OFF (safe gradual rollout).
- Editorial checks only advisory; approvals must be a separate server-side, version-bound role policy (no false permission guarantees).
- Tenant-scoped authorization everywhere; no cross-client access or hidden-only UI enforcement (security).
- Keep original Temporal publish lifecycle; no second background publisher (idempotency).
- Manual, reviewed database migration after complete restore; don't allow startup db push --accept-data-loss (data safety).
- Build/release own immutable image with OCI provenance, don't overwrite upstream ghcr.io or rely on latest (rollback).
- Human approval before publishing; external AI/paid services optional and explicitly authorized (governance and cost).
- Respect AGPL-3.0, source and Google/YouTube privacy/limited-use obligations.
- Separate app repo, private corporate site repo and public assets repo; never mix REKTRS resources with AMAC resources.

## 8. Blockers, risks and resolutions

BLOCKER target-host SSH missing: owner authorizes correct access, then safe Docker inventory.
BLOCKER no verified encrypted DB+Temporal+media backup/restored environment: complete off-host recovery with separated key and isolated non-publishing restore.
BLOCKER Postiz Cloud 403: timestamped WAF/proxy/app auth diagnosis; narrow fix; do not globally disable protections.
BLOCKER public /social 404 and old privacy: release correct site code and verify live rendered Google data disclosure, then OAuth retest/resubmit.
BLOCKER Temporal Docker unhealthy: wrong loopback probe, network-serving; targeted probe fix after backup, then worker check.
RISK source-image identity incomplete: file-level validation and OCI labels.
RISK mutable upstream latest and unsafe Prisma bootstrap: no unscripted production restart; use safe Dockerfile in staging, approved migrations.
RISK no image build/real staging browser/queue E2E: must pass before release.
RISK provider token/privacy/legal: preserve secret handling, actual scopes, approved test accounts and deletion policy.
RISK extra VPS wrong host: srv2107420 is not known target; never deploy there by assumption.
RISK costs/AGPL: owner approval and licence review before paid/proprietary features.

## 9. Next ordered execution queue

A. Clone PR #6 and verify source/CI; read existing plan/runbooks.
B. Authorize and identify real Dokploy host/project; read-only inventory and 403 root-cause.
C. Take full encrypted off-host Postiz + Temporal + media/config backups; restore, reconcile and rehearse rollback.
D. Make public /social and privacy live, verify terms, Google name/scopes/redirect/revocation.
E. Repair targeted Temporal healthcheck, check workers and queue delivery safely.
F. Verify full source provenance, test safe Dockerfile entrypoint and image startup in isolated staging.
G. Run role, auth, provider mock, media, real browser, accessibility, RTL, timezone and reliability acceptance.
H. Build/push REKTRS-owned immutable image; record previous digest and rollout/rollback plan; owner signs off.
I. Deploy to the SAME Dokploy service with no volume loss or auto-publishing; verify post-deploy baseline.
J. Deliver P2–P9 modules by independent feature slices with proofs, no fabricated features.

## 10. Muse non-negotiables and takeover

Start from https://github.com/asadchoudharry/postiz-app/pull/6 and original head release/rektrs-social-next16-2026-11-13, not main. Read old PR #5 DELIVERY_PLAN.md and ENTERPRISE_BLUEPRINT.md for full P0–P9 detail. Review apps/frontend/AGENTS.md and Next16's installed local docs. Use statuses PLANNED / IMPLEMENTED / INTEGRATED / TESTED / STAGING_VERIFIED / DEPLOYED / BLOCKED per feature and keep an evidence ledger. Avoid guessing live infrastructure, exposing secrets, publishing social posts, modifying payments, disabling WAF, Docker privileged breakout, destructive Compose flags or unreviewed Prisma db pushes. Never claim compliance/approval without independent verification. Owner authorizes final production release.

~~~bash
git clone https://github.com/asadchoudharry/postiz-app.git
cd postiz-app
git fetch origin --prune
git switch --track origin/release/rektrs-social-next16-2026-11-13
git rev-parse HEAD
gh pr view 6 --repo asadchoudharry/postiz-app
~~~

If Muse only needs the short name, release/rektrs-nextjs16 is the convenience alias; PR #6's real head remains the longer branch. The handover itself is not proof of production success.
