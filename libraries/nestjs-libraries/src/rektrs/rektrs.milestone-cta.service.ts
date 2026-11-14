import { Injectable, Logger } from '@nestjs/common';
import {
  Integration,
  MilestoneCtaSettings,
  Post,
  Prisma,
} from '@prisma/client';
import { RektrsRepository } from './rektrs.repository';
import { RektrsAuditService } from './rektrs.audit.service';
import { RektrsRolesService } from './rektrs.roles.service';
import { RektrsActor, systemActor } from './rektrs.actor';
import { rektrsError } from './rektrs.errors';
import { UpdateMilestoneCtaSettingsDto } from '@gitroom/nestjs-libraries/dtos/rektrs/rektrs.dto';
import { extractPostMetrics } from './rektrs.evergreen';
import {
  buildCtaCommentText,
  crossesLikeThreshold,
  normalizeCtaText,
  normalizeCtaUrl,
  RektrsMilestoneCtaStatus,
  REKTRS_MILESTONE_CTA_DEFAULTS,
} from './rektrs.milestone-cta';
import { RektrsEngagementGateway } from './rektrs.evergreen-providers';
import { RektrsCtaCommentGateway } from './rektrs.milestone-cta-providers';

/**
 * REKTRS W4 — Milestone Auto-CTA (AUTOMATION-WORKFLOWS.md W4).
 *
 * Hourly per-brand scan: a PUBLISHED post from the last 30 days whose
 * measured like count crosses the brand's threshold (default 20) gets
 * the brand's configured CTA posted as a first comment — ONCE per post,
 * fully audited. This is the one REKTRS automation that writes to a
 * provider on a schedule; it does so only through the dedupe discipline
 * below, and it never touches the post itself or any approval gate.
 *
 * Metrics truth: identical to W3 — there is no stored metrics layer yet
 * (P6). Likes are measured AT SCAN TIME through the providers'
 * postAnalytics surface via RektrsEngagementGateway, and the measured
 * count is snapshotted onto the action row (likesAtCheck). A post whose
 * provider exposes no like counter is skipped NO_METRICS; numbers are
 * never invented or estimated.
 *
 * Comment truth: posting goes through RektrsCtaCommentGateway (the
 * upstream `comment()` primitive). Providers that measure likes but
 * cannot post comments (YouTube, TikTok) are skipped
 * PROVIDER_COMMENT_UNSUPPORTED — a CTA is NEVER recorded as posted
 * unless the provider returned a comment id.
 *
 * Once-only discipline:
 *  - at most one MilestoneCtaAction row per (brand, post) — enforced by
 *    the service check AND the unique index (a racing scan that loses
 *    the create race is recorded as ALREADY_POSTED);
 *  - a CTA_POSTED row is terminal: the post is never evaluated again;
 *  - a failed attempt is recorded CTA_FAILED with the provider error
 *    and retried on later cycles; at the attempt cap (3) the row turns
 *    CTA_EXHAUSTED and the engine stops trying (RETRY_EXHAUSTED);
 *  - retries live inside the 30-day scan window: a failed post that
 *    ages out of the window is no longer scanned (documented limit).
 *
 * The CTA link is posted VERBATIM — the first-comment shortener is a
 * P5 item; the single seam for it is `shortenCtaUrl` in
 * rektrs.milestone-cta.ts (marked W4→P5 HOOK).
 *
 * W5 coherence: a paused brand is skipped entirely — the manual run
 * refuses with BRAND_PAUSED, the scheduled sweep counts it and moves on.
 */

export interface RektrsMilestoneCtaSettingsView {
  brandId: string;
  enabled: boolean;
  likeThreshold: number;
  ctaText: string;
  ctaUrl: string;
  version: number | null;
}

export interface RektrsMilestoneCtaActionSummary {
  postId: string;
  status: RektrsMilestoneCtaStatus;
  commentId: string | null;
  likes: number | null;
  attempts: number;
}

export interface RektrsMilestoneCtaRunSummary {
  runId: string | null;
  brandId: string;
  trigger: 'SCHEDULED' | 'MANUAL';
  /** Set when the scan did not run at all (paused / not enabled). */
  skipped?: string;
  scannedCount: number;
  postedCount: number;
  failedCount: number;
  skippedReasons: {
    counts: Record<string, number>;
    entries: Array<{ postId?: string; reason: string }>;
  };
  actions: RektrsMilestoneCtaActionSummary[];
}

const SKIP_ENTRIES_CAP = 50;
const ERROR_CAP = 500;

function isUniqueViolation(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
  );
}

function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.slice(0, ERROR_CAP);
}

@Injectable()
export class RektrsMilestoneCtaService {
  private readonly _logger = new Logger(RektrsMilestoneCtaService.name);

  constructor(
    private _repository: RektrsRepository,
    private _audit: RektrsAuditService,
    private _roles: RektrsRolesService,
    private _engagement: RektrsEngagementGateway,
    private _comments: RektrsCtaCommentGateway
  ) {}

  // ── Settings (brand-level; MANAGER configures) ────────────────────────────
  async getCtaSettings(
    orgId: string,
    brandId: string
  ): Promise<RektrsMilestoneCtaSettingsView> {
    const brand = await this._requireBrand(orgId, brandId);
    const row = await this._repository.milestoneCtaSettingsByBrand(
      orgId,
      brand.id
    );
    if (!row) {
      return {
        brandId: brand.id,
        enabled: false,
        likeThreshold: REKTRS_MILESTONE_CTA_DEFAULTS.likeThreshold,
        ctaText: '',
        ctaUrl: '',
        version: null,
      };
    }
    return this.settingsView(row);
  }

  async updateCtaSettings(
    orgId: string,
    actor: RektrsActor,
    brandId: string,
    dto: UpdateMilestoneCtaSettingsDto,
    ifMatch?: number
  ): Promise<RektrsMilestoneCtaSettingsView> {
    await this._roles.assertFunction(orgId, actor, 'MANAGER');
    const brand = await this._requireBrand(orgId, brandId);
    const existing = await this._repository.milestoneCtaSettingsByBrand(
      orgId,
      brand.id
    );
    if (existing && ifMatch !== undefined && ifMatch !== existing.version) {
      throw rektrsError.conflict(
        'VERSION_CONFLICT',
        'The milestone CTA settings changed since they were loaded; reload and retry'
      );
    }
    const ctaUrl = normalizeCtaUrl(dto.ctaUrl ?? existing?.ctaUrl ?? '');
    if (ctaUrl === null) {
      throw rektrsError.unprocessable(
        'CTA_URL_INVALID',
        'The CTA link must be a valid http(s) URL'
      );
    }
    const data = {
      enabled: dto.enabled ?? existing?.enabled ?? false,
      likeThreshold:
        dto.likeThreshold ??
        existing?.likeThreshold ??
        REKTRS_MILESTONE_CTA_DEFAULTS.likeThreshold,
      ctaText: normalizeCtaText(dto.ctaText ?? existing?.ctaText ?? ''),
      ctaUrl,
    };
    if (data.enabled && !data.ctaText && !data.ctaUrl) {
      throw rektrsError.unprocessable(
        'CTA_CONTENT_REQUIRED',
        'Write the CTA text or add a CTA link before enabling the milestone auto-CTA'
      );
    }
    const saved = await this._repository.transaction(async (tx) => {
      const row = existing
        ? await this._repository.db(tx).milestoneCtaSettings.update({
            where: { id: existing.id },
            data: { ...data, version: { increment: 1 } },
          })
        : await this._repository.db(tx).milestoneCtaSettings.create({
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
          action: 'milestone_cta_settings.update',
          entityType: 'MilestoneCtaSettings',
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

  // ── Activity: posted/failed CTAs + run history (brand screen) ─────────────
  async listCtaActivity(orgId: string, brandId: string) {
    const brand = await this._requireBrand(orgId, brandId);
    const [actions, runs] = await Promise.all([
      this._repository.milestoneCtaActionsOfBrand(orgId, brand.id),
      this._repository.milestoneCtaRunsOfBrand(orgId, brand.id),
    ]);
    return { actions, runs };
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
  ): Promise<RektrsMilestoneCtaRunSummary> {
    const brand = await this._requireBrand(orgId, brandId);
    const empty = {
      runId: null,
      brandId: brand.id,
      trigger,
      scannedCount: 0,
      postedCount: 0,
      failedCount: 0,
      skippedReasons: { counts: {}, entries: [] },
      actions: [],
    } as RektrsMilestoneCtaRunSummary;

    if (brand.pausedAt) {
      if (trigger === 'MANUAL') {
        throw rektrsError.conflict(
          'BRAND_PAUSED',
          'This brand is paused (crisis kill-switch). Resume it before running the milestone auto-CTA'
        );
      }
      return { ...empty, skipped: 'BRAND_PAUSED' };
    }
    const settingsRow = await this._repository.milestoneCtaSettingsByBrand(
      orgId,
      brand.id
    );
    const settings = settingsRow ? this.settingsView(settingsRow) : null;
    if (!settings?.enabled) {
      if (trigger === 'MANUAL') {
        throw rektrsError.unprocessable(
          'MILESTONE_CTA_NOT_ENABLED',
          'Enable the milestone auto-CTA for this brand before running it'
        );
      }
      return { ...empty, skipped: 'NOT_ENABLED' };
    }

    const run = await this._repository.db().milestoneCtaRun.create({
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

    const since = new Date(
      now.getTime() -
        REKTRS_MILESTONE_CTA_DEFAULTS.windowDays * 24 * 60 * 60 * 1000
    );
    const candidates = await this._repository.milestoneCtaCandidates(
      orgId,
      activeChannels.map((c) => c.id),
      since
    );
    const integrationById = new Map(
      activeChannels.map((i) => [i.id, i] as const)
    );
    const commentText = buildCtaCommentText(settings.ctaText, settings.ctaUrl);
    const actions: RektrsMilestoneCtaActionSummary[] = [];

    for (const candidate of candidates) {
      const outcome = await this.evaluateCandidate(
        orgId,
        actor,
        brand.id,
        run.id,
        settings,
        candidate,
        integrationById.get(candidate.integrationId),
        commentText,
        now
      );
      if (outcome.kind === 'skip') {
        skip(outcome.reason, candidate.id);
      } else {
        actions.push(outcome.action);
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
      actions
    );
  }

  /**
   * One candidate's evaluation, in honesty order: the dedupe row first
   * (cheap, and a posted CTA is never re-measured), then measurability,
   * then the threshold, then comment capability, and only then the one
   * provider write of the whole feature.
   */
  private async evaluateCandidate(
    orgId: string,
    actor: RektrsActor,
    brandId: string,
    runId: string,
    settings: RektrsMilestoneCtaSettingsView,
    candidate: Post,
    integration: Integration | undefined,
    commentText: string,
    now: Date
  ): Promise<
    | { kind: 'skip'; reason: string }
    | { kind: 'action'; action: RektrsMilestoneCtaActionSummary }
  > {
    const existing = await this._repository.milestoneCtaActionForPost(
      brandId,
      candidate.id
    );
    if (existing?.status === 'CTA_POSTED') {
      return { kind: 'skip', reason: 'ALREADY_POSTED' };
    }
    if (
      existing?.status === 'CTA_EXHAUSTED' ||
      (existing && existing.attempts >= REKTRS_MILESTONE_CTA_DEFAULTS.maxAttempts)
    ) {
      return { kind: 'skip', reason: 'RETRY_EXHAUSTED' };
    }
    if (!integration || !this._engagement.supports(integration)) {
      return { kind: 'skip', reason: 'CHANNEL_UNSUPPORTED' };
    }
    if (!candidate.releaseId || candidate.releaseId === 'missing') {
      return { kind: 'skip', reason: 'POST_MISSING' };
    }
    let series;
    try {
      const fetched = await this._engagement.fetchPostMetrics(
        orgId,
        candidate
      );
      if (fetched.kind === 'unsupported') {
        return { kind: 'skip', reason: 'CHANNEL_UNSUPPORTED' };
      }
      if (fetched.kind === 'missing') {
        return { kind: 'skip', reason: 'POST_MISSING' };
      }
      series = fetched.series;
    } catch (e) {
      this._logger.warn(
        `REKTRS W4 metrics fetch failed (post ${candidate.id}): ${String(e)}`
      );
      return { kind: 'skip', reason: 'METRICS_FETCH_FAILED' };
    }
    const metrics = extractPostMetrics(series, now);
    if (!metrics || metrics.likes === null) {
      // The honesty rule: no measured like counter = the threshold
      // cannot be judged. Never treat absence as zero.
      return { kind: 'skip', reason: 'NO_METRICS' };
    }
    if (!crossesLikeThreshold(metrics.likes, settings.likeThreshold)) {
      return { kind: 'skip', reason: 'BELOW_THRESHOLD' };
    }
    if (!this._comments.supports(integration)) {
      // Measurable, crossed — but this provider cannot post comments
      // (YouTube, TikTok). Recorded honestly, never faked, and NOT
      // written as an action row: there was no attempt to dedupe.
      return { kind: 'skip', reason: 'PROVIDER_COMMENT_UNSUPPORTED' };
    }

    try {
      const posted = await this._comments.postComment(
        orgId,
        integration,
        candidate,
        commentText
      );
      const action = await this.recordAttempt(orgId, actor, {
        brandId,
        runId,
        existing,
        candidate,
        integration,
        status: 'CTA_POSTED',
        likes: metrics.likes,
        commentText,
        commentId: posted.commentId,
        error: null,
        postedAt: now,
      });
      return { kind: 'action', action };
    } catch (e) {
      if (isUniqueViolation(e)) {
        // A racing scan recorded the post first; its row is the truth.
        // (If the violation came from recordAttempt AFTER our comment
        // was accepted, the provider may hold a duplicate — scans of one
        // brand are sequential by design, so this is a safety net only.)
        this._logger.warn(
          `REKTRS W4 dedupe race on post ${candidate.id}: another scan recorded it first`
        );
        return { kind: 'skip', reason: 'ALREADY_POSTED' };
      }
      const attempts =
        (existing?.attempts ?? 0) + 1;
      const status: RektrsMilestoneCtaStatus =
        attempts >= REKTRS_MILESTONE_CTA_DEFAULTS.maxAttempts
          ? 'CTA_EXHAUSTED'
          : 'CTA_FAILED';
      this._logger.warn(
        `REKTRS W4 CTA post failed (post ${candidate.id}, attempt ${attempts}): ${String(e)}`
      );
      try {
        const action = await this.recordAttempt(orgId, actor, {
          brandId,
          runId,
          existing,
          candidate,
          integration,
          status,
          likes: metrics.likes,
          commentText,
          commentId: null,
          error: errorText(e),
          postedAt: null,
        });
        return { kind: 'action', action };
      } catch (recordError) {
        if (isUniqueViolation(recordError)) {
          return { kind: 'skip', reason: 'ALREADY_POSTED' };
        }
        throw recordError;
      }
    }
  }

  /**
   * Write the attempt's dedupe row + audit entry in one transaction.
   * The row is created by the FIRST run that attempts the post and
   * updated by later retries; runId therefore names the first run.
   */
  private async recordAttempt(
    orgId: string,
    actor: RektrsActor,
    input: {
      brandId: string;
      runId: string;
      existing: { id: string; attempts: number } | null;
      candidate: Post;
      integration: { id: string; providerIdentifier: string };
      status: RektrsMilestoneCtaStatus;
      likes: number;
      commentText: string;
      commentId: string | null;
      error: string | null;
      postedAt: Date | null;
    }
  ): Promise<RektrsMilestoneCtaActionSummary> {
    const attempts = (input.existing?.attempts ?? 0) + 1;
    const row = await this._repository.transaction(async (tx) => {
      const db = this._repository.db(tx);
      const saved = input.existing
        ? await db.milestoneCtaAction.update({
            where: { id: input.existing.id },
            data: {
              status: input.status,
              attempts,
              likesAtCheck: input.likes,
              commentText: input.commentText,
              commentId: input.commentId,
              error: input.error,
              postedAt: input.postedAt,
            },
          })
        : await db.milestoneCtaAction.create({
            data: {
              organizationId: orgId,
              brandId: input.brandId,
              runId: input.runId,
              postId: input.candidate.id,
              integrationId: input.integration.id,
              providerIdentifier: input.integration.providerIdentifier,
              status: input.status,
              attempts,
              likesAtCheck: input.likes,
              commentText: input.commentText,
              commentId: input.commentId,
              error: input.error,
              postedAt: input.postedAt,
            },
          });
      await this._audit.write(
        orgId,
        actor,
        {
          action:
            input.status === 'CTA_POSTED'
              ? 'milestone_cta.posted'
              : input.status === 'CTA_EXHAUSTED'
                ? 'milestone_cta.exhausted'
                : 'milestone_cta.failed',
          entityType: 'MilestoneCtaAction',
          entityId: saved.id,
          metadata: {
            brandId: input.brandId,
            postId: input.candidate.id,
            providerIdentifier: input.integration.providerIdentifier,
            status: input.status,
            attempts,
            likesAtCheck: input.likes,
            commentId: input.commentId,
            error: input.error,
          },
        },
        tx
      );
      return saved;
    });
    return {
      postId: row.postId,
      status: row.status as RektrsMilestoneCtaStatus,
      commentId: row.commentId,
      likes: row.likesAtCheck,
      attempts: row.attempts,
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
    actions: RektrsMilestoneCtaActionSummary[]
  ): Promise<RektrsMilestoneCtaRunSummary> {
    const counts: Record<string, number> = {};
    for (const s of skips) {
      counts[s.reason] = (counts[s.reason] ?? 0) + 1;
    }
    const skippedReasons = {
      counts,
      entries: skips.slice(0, SKIP_ENTRIES_CAP),
    };
    const postedCount = actions.filter((a) => a.status === 'CTA_POSTED').length;
    const failedCount = actions.length - postedCount;
    await this._repository.db().milestoneCtaRun.update({
      where: { id: runId },
      data: {
        finishedAt: new Date(),
        scannedCount,
        postedCount,
        skippedReasons: skippedReasons as Prisma.InputJsonValue,
      },
    });
    await this._audit.write(orgId, actor, {
      action: 'milestone_cta.run',
      entityType: 'MilestoneCtaRun',
      entityId: runId,
      metadata: {
        brandId,
        trigger,
        scannedCount,
        postedCount,
        failedCount,
        skipCounts: counts,
      },
    });
    return {
      runId,
      brandId,
      trigger,
      scannedCount,
      postedCount,
      failedCount,
      skippedReasons,
      actions,
    };
  }

  // ── Scheduled sweep (orchestrator, cross-org BY DESIGN like W1/W2) ────────
  /**
   * Hourly tick from the Temporal workflow. Unlike W3 there is no
   * weekly window: the milestone cadence IS hourly (a post should get
   * its CTA soon after it crosses), and the dedupe rows + attempt caps
   * make every tick idempotent — a post can never receive two CTAs and
   * a failing post is retried at most 3 times, however often the sweep
   * runs. Paused brands are skipped by scanBrand's own coherence.
   */
  async scanAllEnabled(now: Date = new Date()) {
    const tallies = {
      brands: 0,
      runs: 0,
      posted: 0,
      failed: 0,
      paused: 0,
      errors: 0,
    };
    const settingsList = await this._repository.enabledMilestoneCtaSettings();
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
        const summary = await this.scanBrand(
          row.organizationId,
          brand.id,
          'SCHEDULED',
          systemActor,
          now
        );
        if (summary.runId) {
          tallies.runs++;
          tallies.posted += summary.postedCount;
          tallies.failed += summary.failedCount;
        } else if (summary.skipped === 'BRAND_PAUSED') {
          tallies.paused++;
        }
      } catch (e) {
        tallies.errors++;
        this._logger.warn(
          `REKTRS W4 sweep failed for milestone CTA settings ${row.id}: ${String(e)}`
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

  private settingsView(
    row: MilestoneCtaSettings
  ): RektrsMilestoneCtaSettingsView {
    return {
      brandId: row.brandId,
      enabled: row.enabled,
      likeThreshold: row.likeThreshold,
      ctaText: row.ctaText,
      ctaUrl: row.ctaUrl,
      version: row.version,
    };
  }
}
