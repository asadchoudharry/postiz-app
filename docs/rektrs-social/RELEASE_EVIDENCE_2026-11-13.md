# Consolidated candidate evidence — 13 November 2026

> Subsequent update: GitHub run `43309821000` completed the old candidate's full build and regression jobs successfully. Production inspection has since established a different Next 16/Temporal runtime. See [LIVE_RUNTIME_2026-11-13.md](LIVE_RUNTIME_2026-11-13.md) for the current evidence and remaining host SSH/backup gate. Historical local test results below are retained as recorded.

Candidate branch: `release/rektrs-social-2026-11-13`. Baseline: `main` at `9b59dbd7460d6c760876c83b486173dc4cd12e0b`. Scope: combine PRs #1–#4, resolve their `.env.example` conflict, add the complete delivery plan, read-only target-specific Dokploy inventory, real component interaction tests and a consolidated CI build gate. **Not a deployed release or a completed enterprise product.**

## Verification actually run

| Verification | Result | Detail |
| --- | --- | --- |
| Dependency installation | PASS | `npm ci --ignore-scripts --legacy-peer-deps --no-audit --no-fund`: 3,714 packages; Node 24 install host; lifecycle scripts deliberately deferred |
| Supported application runtime | PASS | Node 20.17.0 installed from the official npm `node` package for build/generation |
| Prisma client generation | PASS | Node 20 + Prisma 6.5.0, existing schema; no database connection or migration |
| Existing editorial/branding/public-preflight regressions | PASS | `node --test scripts/rektrs-*.test.mjs`: 21 tests |
| Real review component interaction | PASS | `node --test scripts/ui/rektrs-review.test.cjs`: 4 tests; actual JSX bundled with esbuild, rendered using React/jsdom; expand/collapse, live input recomputation, actual clipboard content and clipboard rejection |
| Dokploy inventory safety/failure cases | PASS | `python -m unittest discover -s scripts -p 'test_rektrs*.py' -v`: 8 tests; secret/log/path exclusion, wrong host/project, missing revision, duplicate app, unhealthy dependency and read-only Docker command contracts |
| Added component/rules typecheck | PASS | `node node_modules/typescript/bin/tsc --noEmit --target ES2020 --moduleResolution node --jsx react-jsx --esModuleInterop --skipLibCheck --types node,react apps/frontend/src/components/launches/rektrs-quality-rules.ts apps/frontend/src/components/launches/rektrs-content-review.tsx` |
| Patch whitespace | PASS | `git diff --check` |
| Complete Nx application build | BLOCKED locally | Supported Node 20/Prisma setup completed. Nx enumerated frontend/backend/workers/cron but did not complete within the bounded local attempt. No successful full build is claimed; candidate CI runs it separately |
| Chromium visual/E2E QA | BLOCKED locally | Chromium launch failed with `socket() failed: Operation not permitted`; shared browser could not reach the local fixture (`ERR_CONNECTION_REFUSED`). jsdom passing is not browser or visual QA |
| Target Dokploy inventory execution | BLOCKED | Target admin connection unavailable; local invocation correctly returns `inventory_unavailable` with exit code 2. No live Docker inventory has been produced |
| Production deployment/backup/restore | NOT RUN | No target administrative access, exact runtime mapping or restore proof |

Total passing regression tests: **33** (25 Node/React tests + 8 Python tests). These do not prove approval enforcement, OAuth, database compatibility, provider delivery or production readiness.

## Public live observations

Preflight executed at `2026-11-12T21:17:03.807Z` (13 November in Pakistan):

| Endpoint | Actual result |
| --- | --- |
| `https://rektrs.com/social/` | Redirect to `/social`, HTTP 404 |
| `https://rektrs.com/privacy-policy/` | Redirect to `/privacy-policy`, HTTP 200; automated text check did not find Google, YouTube or revocation wording |
| `https://social.rektrs.com/` | Redirect to `/auth`, HTTP 200 |
| Authorized Postiz plugin group listing | HTTP 403; source of denial not established |

Public preflight is a content/reachability heuristic, not a legal or Google verification approval. The full response summary is stored alongside this file. No provider publishing request was made.

## Release hold and next action

The user's destination is fixed: the existing Dokploy server/service behind `social.rektrs.com`. Historical host `srv1322702` and project `rektrs-private-limited-postiz-gekzbw` must be revalidated through authorized access. Both current Hostinger connections list a different server, `srv2107420`, and do not expose Docker Manager for that OS. No SSH identity or authenticated Dokploy browser session for the target exists here.

**Do not deploy the old fork over an unidentified newer runtime.** Obtain the target panel URL plus authenticated access, or an authorized SSH connection configured outside chat. Collect the exact runtime, choose the matching upstream source, restore-test backups, port the isolated patches and continue the delivery plan. Paid tools, production secrets and a second production server are not prerequisites to resume discovery.
