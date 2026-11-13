# Live runtime discovery — 13 November 2026

This update supersedes the earlier "no authenticated Dokploy session" blocker. The owner signed into the existing panel and opened the correct Postiz production project. No production deployment, restart, database write, new SSH authorization, secret rotation or publishing action was performed during this inspection.

## Verified deployment identity

- Panel: `https://rektrs.cloud` (Dokploy v0.30.8).
- Existing compose project: `rektrs-private-limited-postiz-gekzbw`.
- Existing app container: `rektrs-private-limited-postiz-gekzbw-postiz-app-1`.
- Runtime reference: `ghcr.io/gitroomhq/postiz-app:latest`.
- Docker image ID: `sha256:7eb4a553507ce3f200deff2ec0211ab3cf834ba19eb44dd68e83ccc236509feb`.
- Registry digest reported by Dokploy's image inspection: `ghcr.io/gitroomhq/postiz-app@sha256:7eb4a553507ce3f200deff2ec0211ab3cf834ba19eb44dd68e83ccc236509feb`.
- Image created: `2026-10-02T11:25:28.321164336Z`; app container created 6 October.
- App: Node `v22.20.0`, Next `16.3.1`, `@temporalio/client` `^1.14.0`, pnpm `10.6.1`.
- The image has **no OCI source/revision labels**. `/app/version.txt` says `v1.47.0`, but the historical upstream tag v1.47.0 uses Next 14 and no Temporal client. Do not select source from that version file.
- App volumes: `rektrs-private-limited-postiz-gekzbw_postiz-config` at `/config`, and `rektrs-private-limited-postiz-gekzbw_postiz-uploads` at `/uploads`.

## Source matching evidence

Upstream commit `8e42f09cb45c3b6be16656c2d23a372d5eb21053` was committed on 2 October at 11:17:50 UTC, shortly before image creation. A separate local worktree was checked out at this candidate. The following SHA-256 values match the actual files inside the running app exactly:

| File | Live and candidate SHA-256 |
| --- | --- |
| `package.json` | `503b706c6997d481125eff684af95e489ea40f71faf2ef578707de5c0ada093c` |
| `pnpm-lock.yaml` | `a80b52413e65fc53791524120ef4fa300a2815020885961801ebed02cf9f1fee` |
| `libraries/nestjs-libraries/src/database/prisma/schema.prisma` | `ed42d458e0ea3aef767b589220153474bd3eea3b1fd353291ab97caf1d1954f0` |

This establishes a matching dependency/schema baseline, **not provenance for every source file or a successful feature port**. Before release, compare source files being changed, capture full source/image provenance, read the frontend's `AGENTS.md` and its installed Next 16 documentation, and run the current pnpm build. The old PR #5 Nx/Next 14 build cannot validate this runtime. The current composer lives under `components/new-launch`, and auth routes live under `app/(app)/auth`; copying the old patch verbatim would target obsolete paths.

## Temporal health finding

Temporal is running `temporalio/auto-setup:1.28.1` (image ID `sha256:607d68caa111338d754771efb876c92dfcdae06d056e4530bb31cd0f37406e6a`). Docker reports `unhealthy`.

Actual configured probe:

```yaml
test: ["CMD", "tctl", "--address", "127.0.0.1:7233", "workflow", "list"]
interval: 15s
timeout: 10s
start_period: 120s
retries: 30
```

Two read-only checks were run inside this container:

| Command | Result |
| --- | --- |
| `temporal operator cluster health --address 127.0.0.1:7233` | Connection refused |
| `temporal operator cluster health --address temporal:7233` | `SERVING` |

The latest Docker health logs show the same loopback refusal and a tctl deprecation notice. The network service is responding; the warning is not proof that the Temporal service is down.

The verified replacement probe is:

```yaml
test: ["CMD", "temporal", "operator", "cluster", "health", "--address", "temporal:7233"]
```

**Not yet applied.** Back up the current compose and preserve immutable images before recreating only the Temporal service. Do not click a full deploy against mutable `latest` images as a shortcut. After applying the targeted change, wait through health intervals and confirm both Docker `healthy` and CLI `SERVING`, then confirm app/worker connectivity. No schema migration is needed for this healthcheck repair.

## API reachability

An unauthenticated public GET to `https://social.rektrs.com/api/mcp` returned HTTP 401 with Express and the app's CORS headers. This shows that this request reached an application auth boundary. It does not prove that Postiz Cloud's authenticated request is allowed. The previously observed connector 403 still needs a timestamp-correlated, credential-preserving diagnosis; blanket WAF disabling is not justified.

## Backup and host-execution findings

- The project's **Backups** tab says **No backups configured**.
- Its **Volume Backups** tab says **No volume backups**.
- These UI findings do not rule out unrelated manual snapshots elsewhere; no manual backup or restore was verified.
- App and Temporal container terminals work through Dokploy.
- The **Web Server → Server → Terminal** host shell fails SSH authentication. It instructs the owner to authorize the already-generated local Dokploy public key, `/etc/dokploy/ssh/auto_generated-dokploy-local.pub`, for the configured host user. **No key was added by the agent.** Authorizing that key grants host SSH access and requires an owner action; do not obtain it through a privileged container or another workaround.

Next dependency: an existing authorized host SSH connection or owner authorization of Dokploy's local SSH key, followed by private backups and a restore rehearsal. Keep database dumps, media backups and config copies out of `/uploads` and other public routes. Use the existing host, project, volumes and domain throughout.

## Build evidence clarification

GitHub Actions run `43309821000` for PR #5 completed successfully: both `regression` and `application-build`, including its React component tests and full Nx build. That confirms the **old fork candidate**, not production compatibility. An inherited upstream PR-target policy job failed separately; the draft PR remains unmerged and production was not changed.
