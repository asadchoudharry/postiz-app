import { Injectable, Logger } from '@nestjs/common';
import { EvergreenSettings, Post, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { RektrsRepository } from './rektrs.repository';
import { RektrsAuditService } from './rektrs.audit.service';
import { RektrsRolesService } from './rektrs.roles.service';
import { RektrsAlertsService } from './rektrs.alerts.service';
import { RektrsActor, systemActor } from './rektrs.actor';
import { rektrsError } from './rektrs.errors';
import { UpdateEvergreenSettingsDto } from '@gitroom/nestjs-libraries/dtos/rektrs/rektrs.dto';
import {
  applyEvergreenStyle,
  extractPostMetrics,
  normalizeHookLines,
  pickEvergreenStyle,
  rankEvergreenCandidates,
  RektrsEvergreenStyleMode,
  RektrsPostMetrics,
  REKTRS_EVERGREEN_DEFAULTS,
} from './rektrs.evergreen';
import { RektrsEngagementGateway } from './rektrs.evergreen-providers';

/**
 * REKTRS W3 — Evergreen Recycler (AUTOMATION-WORKFLOWS.md W3).
 *
 * Weekly per-brand scan: the brand's top-performing PUBLISHED posts older
 * than the configured age are re-issued as refreshed DRAFT copies for a
 * human to edit and schedule. The recycler NEVER schedules and NEVER
 * publishes: a copy is an ordinary DRAFT post (new group + batch), so the
 * P3 approval gates apply when a human schedules it, exactly like any
 * other draft.
 *
 * Metrics truth: there is no stored metrics layer yet (P6). Engagement is
 * measured AT SCAN TIME through the providers' postAnalytics surface —
 * the same one the statistics page uses — via RektrsEngagementGateway,
 * and snapshotted onto the lineage row. A post whose provider exposes
 * none of likes/comments/shares has NO measurable engagement and is
 * skipped (NO_METRICS); numbers are never invented or estimated.
 *
 * Lineage rules (one honest draft per winner):
 *  - at most one copy of a source per run (the cycle) — enforced by the
 *    service check AND the unique (brandId, sourcePostId, runId) index;
 *  - a source whose earlier copy is still an unconsumed DRAFT is skipped
 *    (PENDING_COPY_EXISTS) — the weekly scan must not pile up duplicate
 *    drafts of the same winner while a human hasn't used the first one.
 *    Once that copy is published (used) or deleted, the source is
 *    eligible again in a later cycle;
 *  - a post that is itself a copy may be recycled at most once
 *    (ALREADY_RECYCLED_COPY after that) — copy-of-copy-of-copy chains
 *    are not a content strategy.
 *
 * W5 coherence: a paused brand is skipped entirely — the manual run
 * refuses with BRAND_PAUSED, the scheduled sweep counts it and moves on.
 */

export interface RektrsEvergreenSettingsView {
  brandId: string;
  enabled: boolean;
  minAgeDays: number;
  topN: number;
  styleMode: RektrsEvergreenStyleMode;
  hookLines: string[];
  version: number | null;
}

export interface RektrsEvergreenCopySummary {
  sourcePostId: string;
  copyPostId: string;
  style: string;
  hookLine: string | null;
  metrics: RektrsPostMetrics;
}

export interface RektrsEvergreenRunSummary {
  runId: string | null;
  brandId: string;
  trigger: 'SCHEDULED' | 'MANUAL';
  /** Set when the scan did not run at all (paused / not enabled). */
  skipped?: string;
  scannedCount: number;
  copiedCount: number;
  skippedReasons: {
    counts: Record<string, number>;
    entries: Array<{ postId?: string; reason: string }>;
  };
  copies: RektrsEvergreenCopySummary[];
}

const SKIP_ENTRIES_CAP = 50;
/** A brand runs at most once per ~week even if the schedule window is
 *  hit twice (workflow restarts re-sweep immediately). */
const MIN_RUN_GAP_MS = 6 * 24 * 60 * 60 * 1000;

function isUniqueViolation(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
  );
}

@Injectable()
export class RektrsEvergreenService {
  private readonly _logger = new Logger(RektrsEvergreenService.name);

  constructor(
    private _repository: RektrsRepository,
    private _audit: RektrsAuditService,
    private _roles: RektrsRolesService,
    private _alerts: RektrsAlertsService,
    private _gateway: RektrsEngagementGateway
  ) {}

  // ── Settings (brand-level; MANAGER configures) ────────────────────────────
  async getEvergreenSettings(
    orgId: string,
    brandId: string
  ): Promise<RektrsEvergreenSettingsView> {
    const brand = await this._requireBrand(orgId, brandId);
    const row = await this._repository.evergreenSettingsByBrand(
      orgId,
      brand.id
    );
    if (!row) {
      return {
        brandId: brand.id,
        enabled: false,
        minAgeDays: REKTRS_EVERGREEN_DEFAULTS.minAgeDays,
        topN: REKTRS_EVERGREEN_DEFAULTS.topN,
        styleMode: REKTRS_EVERGREEN_DEFAULTS.styleMode,
        hookLines: [],
        version: null,
      };
    }
    return this.settingsView(row);
  }

  async updateEvergreenSettings(
    orgId: string,
    actor: RektrsActor,
    brandId: string,
    dto: UpdateEvergreenSettingsDto,
    ifMatch?: number
  ): Promise<RektrsEvergreenSettingsView> {
    await this._roles.assertFunction(orgId, actor, 'MANAGER');
    const brand = await this._requireBrand(orgId, brandId);
    const existing = await this._repository.evergreenSettingsByBrand(
      orgId,
      brand.id
    );
    if (existing && ifMatch !== undefined && ifMatch !== existing.version) {
      throw rektrsError.conflict(
        'VERSION_CONFLICT',
        'The evergreen settings changed since they were loaded; reload and retry'
      );
    }
    const data = {
      enabled: dto.enabled ?? existing?.enabled ?? false,
      minAgeDays:
        dto.minAgeDays ??
        existing?.minAgeDays ??
        REKTRS_EVERGREEN_DEFAULTS.minAgeDays,
      topN: dto.topN ?? existing?.topN ?? REKTRS_EVERGREEN_DEFAULTS.topN,
      styleMode: (dto.styleMode ??
        existing?.styleMode ??
        REKTRS_EVERGREEN_DEFAULTS.styleMode) as RektrsEvergreenStyleMode,
      hookLines: normalizeHookLines(
        dto.hookLines ?? existing?.hookLines ?? []
      ),
    };
    if (data.enabled && data.styleMode === 'HOOK' && !data.hookLines.length) {
      throw rektrsError.unprocessable(
        'EVERGREEN_HOOK_REQUIRED',
        'Add at least one hook line before enabling the HOOK style'
      );
    }
    const saved = await this._repository.transaction(async (tx) => {
      const row = existing
        ? await this._repository.db(tx).evergreenSettings.update({
            where: { id: existing.id },
            data: { ...data, version: { increment: 1 } },
          })
        : await this._repository.db(tx).evergreenSettings.create({
            data: {
              organizationId: orgId,
              brandId: brand.id,
              createdById: actor.userId || 'system',
              ...data,
            },
          });
      await this._audit.write(
        orgId,
        actor,
        {
          action: 'evergreen_settings.update',
          entityType: 'EvergreenSettings',
          entityId: row.id,
          metadata: {
            brandName: brand.name,
            before: existing ? this.settingsView(existing) : null,
            after: this.settingsView(row),
          },
        },
        tx
      );
      return row;
    });
    return this.settingsView(saved);
  }

  // ── Lineage + run history (brand screen) ──────────────────────────────────
  async listEvergreenActivity(orgId: string, brandId: string) {
    const brand = await this._requireBrand(orgId, brandId);
    const [copies, runs] = await Promise.all([
      this._repository.evergreenCopiesOfBrand(orgId, brand.id),
      this._repository.evergreenRunsOfBrand(orgId, brand.id),
    ]);
    return { copies, runs };
  }

  // ── Manual trigger (MANAGER; the controller also gates it) ────────────────
  async runBrandNow(orgId: string, actor: RektrsActor, brandId: string) {
    await this._roles.assertFunction(orgId, actor, 'MANAGER');
    return this.scanBrand(orgId, brandId, 'MANUAL', actor, new Date());
  }

  // ── The scan ──────────────────────────────────────────────────────────────
  async scanBrand(
    orgId: string,
    brandId: string,
    trigger: 'SCHEDULED' | 'MANUAL',
    actor: RektrsActor,
    now: Date
  ): Promise<RektrsEvergreenRunSummary> {
    const brand = await this._requireBrand(orgId, brandId);
    const empty = {
      runId: null,
      brandId: brand.id,
      trigger,
      scannedCount: 0,
      copiedCount: 0,
      skippedReasons: { counts: {}, entries: [] },
      copies: [],
    } as RektrsEvergreenRunSummary;

    if (brand.pausedAt) {
      if (trigger === 'MANUAL') {
        throw rektrsError.conflict(
          'BRAND_PAUSED',
          'This brand is paused (crisis kill-switch). Resume it before running the evergreen recycler'
        );
      }
      return { ...empty, skipped: 'BRAND_PAUSED' };
    }
    const settingsRow = await this._repository.evergreenSettingsByBrand(
      orgId,
      brand.id
    );
    const settings = settingsRow
      ? this.settingsView(settingsRow)
      : null;
    if (!settings?.enabled) {
      if (trigger === 'MANUAL') {
        throw rektrsError.unprocessable(
          'EVERGREEN_NOT_ENABLED',
          'Enable the evergreen recycler for this brand before running it'
        );
      }
      return { ...empty, skipped: 'NOT_ENABLED' };
    }

    const run = await this._repository.db().evergreenRun.create({
      data: { organizationId: orgId, brandId: brand.id, trigger },
    });
    const skips: Array<{ postId?: string; reason: string }> = [];
    const skip = (reason: string, postId?: string) =>
      skips.push({ reason, ...(postId ? { postId } : {}) });

    const channelIds = (brand.channels || []).map((c) => c.integrationId);
    const integrations = channelIds.length
      ? await this._repository.integrationsByIds(orgId, channelIds)
      : [];
    const activeChannels = integrations.filter((i) => !i.disabled);
    if (!activeChannels.length) {
      skip('NO_CHANNELS');
      return this.finishRun(orgId, actor, run.id, brand.id, trigger, 0, skips, []);
    }

    const cutoff = new Date(
      now.getTime() - settings.minAgeDays * 24 * 60 * 60 * 1000
    );
    const candidates = await this._repository.evergreenCandidates(
      orgId,
      activeChannels.map((c) => c.id),
      cutoff
    );

    const integrationById = new Map(
      activeChannels.map((i) => [i.id, i] as const)
    );
    const pool: Array<{
      item: Post;
      metrics: RektrsPostMetrics;
      publishDate: Date;
      id: string;
    }> = [];

    for (const candidate of candidates) {
      const integration = integrationById.get(candidate.integrationId);
      if (!integration || !this._gateway.supports(integration)) {
        skip('CHANNEL_UNSUPPORTED', candidate.id);
        continue;
      }
      // Lineage gates (cheap reads before any provider call).
      const lineageSkip = await this.lineageSkipReason(
        brand.id,
        run.id,
        candidate
      );
      if (lineageSkip) {
        skip(lineageSkip, candidate.id);
        continue;
      }
      let series;
      try {
        const fetched = await this._gateway.fetchPostMetrics(
          orgId,
          candidate
        );
        if (fetched.kind === 'unsupported') {
          skip('CHANNEL_UNSUPPORTED', candidate.id);
          continue;
        }
        if (fetched.kind === 'missing') {
          skip('POST_MISSING', candidate.id);
          continue;
        }
        series = fetched.series;
      } catch (e) {
        this._logger.warn(
          `REKTRS W3 metrics fetch failed (post ${candidate.id}): ${String(e)}`
        );
        skip('METRICS_FETCH_FAILED', candidate.id);
        continue;
      }
      const metrics = extractPostMetrics(series, now);
      if (!metrics) {
        // The honesty rule: no measurable engagement = not "top".
        skip('NO_METRICS', candidate.id);
        continue;
      }
      pool.push({
        item: candidate,
        metrics,
        publishDate: candidate.publishDate,
        id: candidate.id,
      });
    }

    const winners = rankEvergreenCandidates(pool).slice(0, settings.topN);
    let copiesBefore = await this._repository.evergreenCopiesCountForBrand(
      brand.id
    );
    const copies: RektrsEvergreenCopySummary[] = [];
    for (const winner of winners) {
      try {
        const created = await this.createCopy(
          orgId,
          actor,
          brand.id,
          run.id,
          winner.item,
          winner.metrics,
          settings,
          copiesBefore,
          now
        );
        copies.push(created);
        copiesBefore++;
      } catch (e) {
        if (isUniqueViolation(e)) {
          skip('ALREADY_COPIED_THIS_RUN', winner.item.id);
          continue;
        }
        throw e;
      }
    }

    return this.finishRun(
      orgId,
      actor,
      run.id,
      brand.id,
      trigger,
      candidates.length,
      skips,
      copies
    );
  }

  /**
   * Why `candidate` must not be copied in this run, or null when it may.
   * See the class docstring for the lineage rules.
   */
  private async lineageSkipReason(
    brandId: string,
    runId: string,
    candidate: Post
  ): Promise<string | null> {
    const priorCopies = await this._repository.evergreenCopiesForSource(
      brandId,
      candidate.id
    );
    if (priorCopies.some((c) => c.runId === runId)) {
      return 'ALREADY_COPIED_THIS_RUN';
    }
    for (const prior of priorCopies) {
      const copyPost = await this._repository.postById(
        candidate.organizationId,
        prior.copyPostId
      );
      // A missing post row counts as consumed (deleted): it no longer
      // blocks the source. A still-DRAFT copy does.
      if (copyPost && copyPost.state === 'DRAFT') {
        return 'PENDING_COPY_EXISTS';
      }
    }
    const asCopy = await this._repository.evergreenCopyByCopyPostId(
      candidate.id
    );
    if (asCopy && priorCopies.length > 0) {
      return 'ALREADY_RECYCLED_COPY';
    }
    return null;
  }

  /**
   * Create the DRAFT copy of one winning post: the whole thread group is
   * re-issued under a fresh group + batch, media and provider settings
   * carried over verbatim (the Post.image / Post.settings JSON strings),
   * tags re-linked on the root, and ONLY the root's content refreshed.
   * Runs in one transaction with the lineage row + audit entry.
   */
  private async createCopy(
    orgId: string,
    actor: RektrsActor,
    brandId: string,
    runId: string,
    source: Post,
    metrics: RektrsPostMetrics,
    settings: RektrsEvergreenSettingsView,
    copiesBefore: number,
    now: Date
  ): Promise<RektrsEvergreenCopySummary> {
    const rows = await this._repository.postsOfGroup(orgId, source.group);
    const ordered = orderThreadRows(
      rows.length ? rows : [source],
      source.id
    );
    const { style, hookLine } = pickEvergreenStyle(
      settings.styleMode,
      copiesBefore,
      settings.hookLines
    );
    const group = randomUUID();
    const batchId = randomUUID();

    const copyRow = await this._repository.transaction(async (tx) => {
      const db = this._repository.db(tx);
      let parentId: string | null = null;
      let rootId: string | null = null;
      for (const [index, row] of ordered.entries()) {
        const created = await db.post.create({
          data: {
            state: 'DRAFT',
            publishDate: now,
            organizationId: orgId,
            integrationId: row.integrationId,
            content:
              index === 0
                ? applyEvergreenStyle(row.content, style, hookLine)
                : row.content,
            delay: row.delay,
            group,
            batchId,
            title: row.title,
            description: row.description,
            parentPostId: parentId,
            settings: row.settings,
            image: row.image,
            creationMethod: 'UNKNOWN',
          },
        });
        parentId = created.id;
        if (index === 0) {
          rootId = created.id;
        }
      }
      const tags = await this._repository.tagsOfPost(source.id, tx);
      if (tags.length && rootId) {
        await db.tagsPosts.createMany({
          data: tags.map((t) => ({ postId: rootId!, tagId: t.tagId })),
          skipDuplicates: true,
        });
      }
      const lineage = await db.evergreenCopy.create({
        data: {
          organizationId: orgId,
          brandId,
          runId,
          sourcePostId: source.id,
          copyPostId: rootId!,
          style,
          hookLine,
          metrics: metrics as unknown as Prisma.InputJsonValue,
        },
      });
      await this._audit.write(
        orgId,
        actor,
        {
          action: 'evergreen.copy_created',
          entityType: 'EvergreenCopy',
          entityId: lineage.id,
          metadata: {
            brandId,
            runId,
            sourcePostId: source.id,
            copyPostId: rootId!,
            style,
            hookLine,
            score: metrics.score,
            likes: metrics.likes,
            comments: metrics.comments,
            shares: metrics.shares,
          },
        },
        tx
      );
      return lineage;
    });

    return {
      sourcePostId: source.id,
      copyPostId: copyRow.copyPostId,
      style,
      hookLine,
      metrics,
    };
  }

  private async finishRun(
    orgId: string,
    actor: RektrsActor,
    runId: string,
    brandId: string,
    trigger: 'SCHEDULED' | 'MANUAL',
    scannedCount: number,
    skips: Array<{ postId?: string; reason: string }>,
    copies: RektrsEvergreenCopySummary[]
  ): Promise<RektrsEvergreenRunSummary> {
    const counts: Record<string, number> = {};
    for (const s of skips) {
      counts[s.reason] = (counts[s.reason] ?? 0) + 1;
    }
    const skippedReasons = {
      counts,
      entries: skips.slice(0, SKIP_ENTRIES_CAP),
    };
    await this._repository.db().evergreenRun.update({
      where: { id: runId },
      data: {
        finishedAt: new Date(),
        scannedCount,
        copiedCount: copies.length,
        skippedReasons: skippedReasons as Prisma.InputJsonValue,
      },
    });
    await this._audit.write(orgId, actor, {
      action: 'evergreen.run',
      entityType: 'EvergreenRun',
      entityId: runId,
      metadata: {
        brandId,
        trigger,
        scannedCount,
        copiedCount: copies.length,
        skipCounts: counts,
      },
    });
    if (copies.length) {
      await this._alerts
        .alertEvergreenCopies(orgId, {
          brandId,
          runId,
          copies: copies.map((c) => ({
            copyPostId: c.copyPostId,
            sourcePostId: c.sourcePostId,
          })),
        })
        .catch((e) =>
          this._logger.warn(`REKTRS W3 creator alert failed: ${String(e)}`)
        );
    }
    return {
      runId,
      brandId,
      trigger,
      scannedCount,
      copiedCount: copies.length,
      skippedReasons,
      copies,
    };
  }

  // ── Scheduled sweep (orchestrator, cross-org BY DESIGN like W1/W2) ────────
  /**
   * Hourly tick from the Temporal workflow. A brand's scan fires only
   * when (a) its org's configured weekly window matches `now` (UTC
   * weekday + hour from RektrsOrgSettings), and (b) the brand has no run
   * in the last 6 days — manual runs count, so a manager's run satisfies
   * the week. Paused brands are skipped by scanBrand's own coherence.
   */
  async scanAllEnabled(now: Date = new Date()) {
    const tallies = {
      brands: 0,
      due: 0,
      runs: 0,
      copies: 0,
      paused: 0,
      notDue: 0,
      recent: 0,
      errors: 0,
    };
    const settingsList = await this._repository.enabledEvergreenSettings();
    const orgSettingsCache = new Map<
      string,
      { evergreenWeekday: number; evergreenHour: number }
    >();
    for (const row of settingsList) {
      tallies.brands++;
      try {
        const brand = row.brand;
        if (!brand || brand.deletedAt) {
          continue;
        }
        if (brand.pausedAt) {
          tallies.paused++;
          continue;
        }
        let schedule = orgSettingsCache.get(row.organizationId);
        if (!schedule) {
          const view = await this._roles.getOrgSettings(row.organizationId);
          schedule = {
            evergreenWeekday: view.evergreenWeekday,
            evergreenHour: view.evergreenHour,
          };
          orgSettingsCache.set(row.organizationId, schedule);
        }
        if (
          now.getUTCDay() !== schedule.evergreenWeekday ||
          now.getUTCHours() !== schedule.evergreenHour
        ) {
          tallies.notDue++;
          continue;
        }
        const lastRun = await this._repository.lastEvergreenRun(brand.id);
        if (
          lastRun &&
          now.getTime() - lastRun.startedAt.getTime() < MIN_RUN_GAP_MS
        ) {
          tallies.recent++;
          continue;
        }
        tallies.due++;
        const summary = await this.scanBrand(
          row.organizationId,
          brand.id,
          'SCHEDULED',
          systemActor,
          now
        );
        if (summary.runId) {
          tallies.runs++;
          tallies.copies += summary.copiedCount;
        } else if (summary.skipped === 'BRAND_PAUSED') {
          tallies.paused++;
        }
      } catch (e) {
        tallies.errors++;
        this._logger.warn(
          `REKTRS W3 sweep failed for evergreen settings ${row.id}: ${String(e)}`
        );
      }
    }
    return tallies;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  private async _requireBrand(orgId: string, brandId: string) {
    const brand = await this._repository.brandById(orgId, brandId);
    if (!brand) {
      throw rektrsError.notFound('BRAND_NOT_FOUND', 'Brand not found');
    }
    return brand;
  }

  private settingsView(row: EvergreenSettings): RektrsEvergreenSettingsView {
    return {
      brandId: row.brandId,
      enabled: row.enabled,
      minAgeDays: row.minAgeDays,
      topN: row.topN,
      styleMode: row.styleMode as RektrsEvergreenStyleMode,
      hookLines: row.hookLines,
      version: row.version,
    };
  }
}

/**
 * Order a post thread for copying: Postiz threads are a CHAIN (each
 * row's parent is the previous row), so walk from the root following
 * parentPostId links; any row the walk cannot reach (data drift) is
 * appended in (delay, createdAt) order rather than dropped.
 */
export function orderThreadRows(rows: Post[], rootId: string): Post[] {
  const root =
    rows.find((r) => r.id === rootId) ||
    rows.find((r) => !r.parentPostId) ||
    rows[0];
  if (!root) {
    return [];
  }
  const byParent = new Map<string, Post>();
  for (const row of rows) {
    if (row.parentPostId) {
      byParent.set(row.parentPostId, row);
    }
  }
  const ordered: Post[] = [root];
  const seen = new Set<string>([root.id]);
  let current = root;
  while (byParent.has(current.id)) {
    const next = byParent.get(current.id)!;
    if (seen.has(next.id)) {
      break;
    }
    ordered.push(next);
    seen.add(next.id);
    current = next;
  }
  const rest = rows
    .filter((r) => !seen.has(r.id))
    .sort(
      (a, b) =>
        a.delay - b.delay || a.createdAt.getTime() - b.createdAt.getTime()
    );
  return [...ordered, ...rest];
}
