# rektrs social — complete delivery and operating plan

Date: 13 November 2026 (Asia/Karachi). Delivery lead: Codex, with owner decisions only for credentials, commercial commitments and policy choices that cannot be inferred.

## Product and deployment contract

Deliver an operated social publishing product for a company or agency: manage brands and clients, plan campaigns, create and review content, schedule approved work, monitor delivery, measure results and retain an audit trail. Existing Postiz publishing remains the system of record until an explicitly tested replacement exists.

**Production destination is the existing Dokploy installation at `https://social.rektrs.com`.** The user confirmed this on 13 November. Historical target: host `srv1322702`, compose project `rektrs-private-limited-postiz-gekzbw`, service `postiz-app`, HTTPS routing to container port 5000. Historical configuration is evidence for discovery, not proof of today's runtime. Do not create a second production installation or change DNS as a shortcut.

Application repository: `asadchoudharry/postiz-app`. Corporate product/privacy pages: `asadchoudharry/rektrswebsite`. `Rektrs-Social` is a public assets repository and must not hold customer content or configuration.

## Current, measured state

| Area | Actual state | Consequence |
| --- | --- | --- |
| Earlier work | Draft PRs #1–#4, consolidated locally into `release/rektrs-social-2026-11-13` | One integration branch and one release candidate; no production merge yet |
| Application baseline | Fork `main` at `9b59dbd7460d6c760876c83b486173dc4cd12e0b`, Next 14, Node 20, BullMQ | Must match to deployed revision before feature port or deploy |
| Live frontend | Public root redirects to `/auth`; auth HTML has a Postiz title and Turbopack asset names | Reachable; exact installed version remains unknown |
| Historical runtime | Temporal, PostgreSQL 17 and Redis were recorded on the target host in October | Possible major architecture/version mismatch; old fork must not replace it blindly |
| Postiz plugin | Read-only group listing returns 403 | Authenticated API operations are blocked; cause unproven |
| Public product page | Live preflight returned HTTP 404 for `/social` | Already-committed website changes still need deployment verification |
| Public privacy page | HTTP 200; preflight found no Google/YouTube/revocation wording | Inspect scope-specific policy text and deploy accurate existing changes |
| Hostinger connections | Both show `srv2107420`, not the historical target; Docker Manager reports unsupported OS | These connections do not provide target-server execution |
| Administrative session | No target SSH credentials or authenticated Dokploy browser session available here | Runtime inspection, backup, staging restore and production deploy blocked |

Nothing in this document claims a complete production product. Feature status must be one of `planned`, `implemented`, `integrated`, `tested`, `deployed` or `blocked`, with evidence. An advisory content score is not an approval workflow.

## Architecture decisions

1. **Match runtime before porting.** Capture image ID, immutable digest, OCI revision, package/runtime version, schema and queue architecture. If the live release is newer, port the REKTRS patches onto that exact upstream base. Do not downgrade production or introduce a second scheduler.
2. **Bound the fork.** Keep branding, editorial checks and new workspace modules isolated. Preserve AGPL notices/source availability. Maintain a patch ledger and test upstream upgrades in isolation.
3. **Retain tenancy.** Existing organizations remain the primary tenant boundary. Brands and clients belong to an organization; channel access is explicit. Each query, job, export and webhook carries a server-derived organization ID. A client cannot select another tenant by altering an input ID.
4. **Use the existing queue.** Identify whether production uses Temporal or BullMQ. Attach to that supported lifecycle with idempotency, retry limits and provider receipts. Do not implement parallel publish jobs in a companion service.
5. **Additive persistence.** New domain tables have tenant indexes, version counters, creation/modification actors and retention metadata. Capture and test migrations on restored production data; avoid automatic `db push` on an unverified schema.
6. **Feature flags.** Branding and editorial review are independent build flags. New approval/automation rules also require server-side enablement; a hidden button never establishes authorization.
7. **Credentials.** Provider secrets stay in existing secret storage. Tokens, post bodies, client attachments and environment dumps never enter logs or Git. Paid providers are optional and disabled until configured and authorized.

## Roles and workspaces

| Role | Capabilities | Explicit restrictions |
| --- | --- | --- |
| Platform owner | Health, plans, provider availability, quotas and auditable support access | No default access to private customer content |
| Organization owner | Team, brand/channel assignment, policy, exports and retention | Cannot cross organization boundary |
| Manager | Briefs, campaigns, assignments, review routing and calendar | Cannot silently override required review |
| Creator | Drafts, variants, media and review submission | Cannot self-approve where separation is required |
| Reviewer | View exact submitted version, comment, approve/reject/request changes | No publishing permission by implication |
| Publisher | Schedule an approved version to permitted channels | Approval invalidates after protected changes |
| Analyst | Source-labelled metrics and permitted exports | No token or publishing access |
| Client approver | Assigned client/brand campaign previews and decisions | No other client data or platform administration |

Workspaces: organization overview, brands, campaign board, calendar, composer, media, approvals, content/AI studio, analytics, automations, inbox/leads, clients and organization settings. Platform administration is a separate permission boundary. Routes with unavailable integrations display an actionable unavailable state rather than fabricated data.

## End-to-end workflows

### Content to delivery

Brief → brand → sources → draft → channel variants → media/alt text → editorial checks → submit exact version → reviewer decision → approved version → schedule → queue attempt → provider receipt → metrics.

Supported exception states: changes requested, rejected, canceled, approval expired, partially published, retry pending, token expired and provider rejected. Editing text, destination, media or publish time invalidates approval according to the organization's policy. Transitions use an expected version; a stale editor gets a conflict response.

Review records bind actor, role, timestamp and immutable content hash. Schedule and publish entry points validate this binding, including public API, autopost, automation, reschedule and retry routes. Rejected/pending versions cannot reach a provider through an alternate route. Legacy pending schedules must be inventoried and handled explicitly during policy activation; do not cancel or republish them automatically.

### Brand/client setup

Owner creates client and brand → sets voice, language, timezone, guidelines and allowed sources → assigns team and channels → reviewer approves the initial brand kit → creator can use only assigned assets. Switching brand cancels stale requests and clears unrelated drafts/selection state. Destructive actions require a recoverable archive path.

### Automation

Authenticated trigger → tenant/entitlement check → normalize → deduplicate → draft → review → approved schedule. Delivery retries have backoff and a dead-letter view; replays are auditable. Default action is draft creation. Nothing auto-publishes because an AI provider returned success.

### Analytics

Provider fetch → normalized metric snapshot with provenance/window/timezone → campaign attribution → report. Unsupported or missing metrics show `not available`, never invented zero. UTM generation validates URL protocol, preserves existing query parameters and attributes links to a campaign without collecting unnecessary personal data.

## Execution phases and acceptance gates

Phases are dependency driven, without an arbitrary completion date. Backend authorization and operational reliability precede cosmetic expansion. The lead executes buildable slices, verifies them and updates the evidence ledger before progressing.

| Phase | Implementation package | Acceptance required before completion |
| --- | --- | --- |
| P0 — runtime recovery | Exact Dokploy inventory, source/version mapping, 403 diagnosis, DB/media/config backups and isolated restore; public OAuth pages | Verified host/route/digest; restored counts; staging cannot publish; authenticated list API works; public pages checked |
| P1 — engineering foundation | Pin matched base; CI build/type/lint; error reporting; worker/queue health; tenant authorization tests; release/rollback provenance | Reproducible build; no secrets in logs; cross-tenant negative tests; rollback rehearsal |
| P2 — brand workspace and UX | Responsive brand identity, semantic tokens, accessible navigation, EN/AR layouts, multi-brand profiles, channel assignment, media search/filter/archive | 360/768/1440px review; keyboard flow; empty/loading/error states; brand isolation and persisted selection |
| P3 — campaigns and review | Briefs, campaign board/calendar, assignments, draft versions, reviewer inbox, comment/decision history, expiry, approval-bound scheduling | No self-approval when prohibited; stale versions rejected; approval invalidated after edit; all publishing entry points enforce policy |
| P4 — content/AI studio | Brand source library, editable prompt templates, multilingual variants, structured outputs, cited research, budget/usage ledger, manual/free-first workflows | All output editable draft; confidential-data controls; provider timeout/error states; no unapproved charge |
| P5 — creative production | Branded templates/carousels, reusable assets, alt text, image/video adapters, job status, rights metadata and platform previews | Real export files checked; media dimensions/duration validated; failed jobs recover; rights/consent captured |
| P6 — analytics and attribution | Channel snapshots, campaign/brand comparison, UTM builder, date/timezone filters, CSV/PDF reports and permitted client reports | Metric definitions/source/freshness shown; duplicates deduped; missing-data behaviour; timezone boundary tests |
| P7 — automation, inbox and leads | Signed webhooks, delivery log/replay, n8n/WordPress adapters, dedupe/retries, permissioned messages/comments, lead capture and consent | Invalid signature blocked; duplicate webhook has one effect; unsubscribe respected; unsupported inbox capabilities disclosed |
| P8 — agency/SaaS | Client approval portal, invitations, scoped reports, plan entitlements, quotas, usage, sandbox subscriptions/referrals | Cross-client isolation; invitation expiry; webhook idempotency; quota accuracy; no live payments without owner authorization |
| P9 — operating release | Load/resource testing, backups/restore schedule, monitoring/alerts, security/dependency fixes, docs, staged rollout, production smoke and owner handover | Main flows pass; restore/rollback demonstrated; production health and existing schedules preserved; evidence linked |

### Build order inside each phase

1. Inspect real existing capability and reuse it where functional.
2. Write contract, permissions, validation and failure cases.
3. Implement persistence/API and meaningful regression tests.
4. Implement usable screens and every loading/error/empty/success state.
5. Integrate with the matched Postiz runtime; test with isolated accounts and provider mocks.
6. Review responsive/accessibility behaviour and role/tenant negatives.
7. Build an immutable candidate, deploy staging, then release to the same Dokploy service after operational gates pass.
8. Record actual version/digest, verification and rollback references. Close work only on evidence.

## Integration and cost policy

| Capability | Default | Activation condition |
| --- | --- | --- |
| Existing social channels | Retain configured Postiz connectors | Authorized provider scopes and working tokens |
| Copy/brand checks | Local deterministic checks and human drafts | Already implemented editorial slice, opt-in |
| External AI | Disabled/unconfigured state | Provider selected, secret securely configured, transfer policy and budget approved |
| Research | User-supplied URLs/sources with attribution | External search adapter only if available and permitted |
| Image/video generation | Existing assets and exportable templates | Optional provider configuration and budget; no assumed subscription |
| n8n/CMS | Signed, scoped draft triggers | Tenant-owned credentials, verified callback and retries |
| Payments | Off; sandbox first | Explicit commercial approval and tested reconciliation |
| Notifications | In-app first | Configured SMTP/provider; sender identity verified |

## Release procedure for the existing Dokploy service

1. Establish authorized access to the actual panel/server. Re-read the target project; compare runtime inventory against the historical target.
2. Capture encrypted DB, media and necessary configuration backups through the existing secret manager. Restore into an isolated, non-publishing environment and compare users, organizations, channels, draft/scheduled post counts and media references.
3. Pin the runtime's actual upstream source. Port isolated patches and build an immutable image under the user's registry namespace. Do not use the fork's existing upstream-targeting container workflow (`ghcr.io/gitroomhq/...`) for a REKTRS release.
4. In staging verify login/session/logout, organization selection, media, all enabled channel connection callbacks, draft save/edit, approval paths, mocked scheduling/delivery, timezone and retries. Do not use production social credentials in staging.
5. Preserve the same project, service, volumes, network, domain and port. Change the image only through the existing Dokploy configuration, referencing an immutable digest and recording the previous one. Do not run `compose down -v` or a guessed replacement compose file.
6. Follow the version-specific migration and queue draining plan. Pause only the intended worker where necessary; never replay already delivered work. Detect post-deploy failures before enabling optional features broadly.
7. Verify public/authenticated app routes, user/channel/post counts, worker health and provider error rate. Record baseline comparison and release evidence.
8. Roll back application code using the previous compatible digest. If a migration is not backward compatible, use its rehearsed rollback or isolated restore procedure; never assume changing an image reverses database changes.

The included `scripts/rektrs-dokploy-inventory.py` performs read-only inventory of this exact project and emits selected non-secret metadata. It does not back up, restore, deploy, restart, change compose, inspect environment values, publish or approve a release. Run it on the verified target as an existing authorized Docker user. `BLOCKED` exits with code 2 and requires investigation, not bypass.

## Definition of final product and handover

The product is complete only when every phase above is delivered or a specific feature is explicitly descoped by the owner; no placeholder modules or invented analytics qualify. Required handover:

- Working production URL on the existing Dokploy host, immutable image reference and source commit.
- Tested owner/creator/reviewer/publisher/client flows and role matrix, including tenant boundary negatives.
- Brand setup guide, campaign/approval guide, channel reconnect guide and automation retry guide.
- Provider configuration matrix, usage/cost visibility and disabled-state explanations.
- Accurate privacy/data retention/deletion implementation and matching public policy text.
- Backup/restore proof, rollback runbook, monitoring dashboard and incident procedure.
- Actual build/test/browser results and disclosed provider/platform limitations.

## Immediate next execution dependency

Target administrative access is missing in this session. The next action is **connect to the existing Dokploy panel/server**, collect runtime evidence and select the exact supported source base. No extra server purchase, DNS change, new production instance, manual social publishing or API-key disclosure is required. Request the panel URL/authenticated session or a securely configured SSH connection; never request a password/token in chat. After access is available, continue P0 through the gates above without restarting planning or requiring repeated "proceed" messages.
