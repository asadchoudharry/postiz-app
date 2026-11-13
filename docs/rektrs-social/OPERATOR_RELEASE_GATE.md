# REKTRS Social — P0 operational handoff (13 November 2026)

## Fixed target

Dokploy: `https://rektrs.cloud`; project: `rektrs-private-limited-postiz-gekzbw`; public app: `https://social.rektrs.com`. The live image is an October 2026 Node 22 / Next 16 / Temporal build, *not* the older GitHub default branch. The actual current host must be confirmed before any terminal command. Hostinger's currently accessible `srv2107420` is **not** the previously identified Postiz host.

## Scope and authorization

The P0 inventory tool reads selected Docker metadata only. It makes no changes and has no permissions bypass. The host shell from Dokploy currently fails SSH authentication. Owner authorization of Dokploy's existing generated key or an authorized SSH account is required. Never disclose passwords, private keys, OAuth tokens, environment values, full Compose configuration or database dumps into tickets/chat/Git.

## Read-only checks once host access is legitimate

1. Confirm actual hostname, user, Dokploy project, domain, app container and image ID. Do not infer the correct host from DNS or another Hostinger account.
2. Under an already authorized Docker-capable user, run `python3 scripts/rektrs-dokploy-inventory.py` from the pinned GitHub checkout. Record only its allowlisted JSON summary to a private evidence store.
3. A current `BLOCKED` result is expected while OCI revision labels are absent or Temporal's loopback healthcheck is inaccurate; do not circumvent either gate by editing the result.
4. Distinguish provider-side 403 from application auth 401 using timestamp-correlated HTTP status, route/ingress logs and auth audit metadata **without** recording the authorization token or request content. Do not disable the entire WAF.

## Full backup / restore gates

**No backups or restore verification are confirmed.** Capture *private, encrypted, off-host* recovery bundles that include all **actual** deployed persistent dependencies. Do not assume the Postiz Postgres instance is the only database. Verify and include:

- Postiz application's PostgreSQL database, roles and schema; identify actual database name and matching PostgreSQL major version from the running service
- Temporal persistence database and execution state, plus its visibility/search storage where relevant
- Postiz configuration, media/uploads and other persistent mounted volumes; Redis data if durable in this deployment
- Relevant app, orchestrator and Temporal image references, schema versions, runtime configuration backup in the existing secrets manager, and compose/service metadata without exposing secrets

Check encryption, separation of decryption keys, checksums and retention. Put no recovery archive or key under a publicly reachable route, app uploads, GitHub, CI artifacts or the same volume as the only copy.

An **isolated restore** must preserve users, organizations, integrations, scheduled/draft posts, media references, Temporal workflow state and service identity. The restored environment must have production social tokens unavailable, outbound publishing disabled, provider callbacks pointed away from production and email/notifications disabled. Verify record counts and image/media integrity, and rehearse code rollback without sending posts.

## Safe staging → release sequence

1. Archive current immutable image ID/digest and persistence snapshot references in the private release evidence.
2. Inspect each changed source file against the running image when possible; dependencies/schema checks alone do not prove full provenance.
3. Use `Dockerfile.rektrs` for a future **staging** image only. Build with an explicit source revision and review both public compile-time feature flags. Do not use `Dockerfile.dev`'s implicit root startup schema sync for the new runtime.
4. Run application frontend/backend/orchestrator/Temporal process liveness, login/session, channel ownership, draft save/edit, review, mocked scheduling and webhook/queue tests under isolated credentials.
5. Only after restore proof and staged acceptance: publish to the **REKTRS-owned** registry with immutable digest, record the previous digest, then deploy to the existing Dokploy service, preserving all volumes, routes and ports.
6. Recheck health, tenant/integration/scheduled counts, published receipts and provider errors. Roll back to a *compatible* image digest if necessary; schema changes need a separately tested rollback.

**Not executed:** host access, backups, restore, image build/publish, staging deployment, production deploy, automatic publishing.
