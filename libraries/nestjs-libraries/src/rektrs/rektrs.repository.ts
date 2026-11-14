import { Injectable } from '@nestjs/common';
import { Prisma, RektrsApprovalState, RektrsLeadStatus } from '@prisma/client';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

export type RektrsDb = PrismaService | Prisma.TransactionClient;

/**
 * REKTRS P3 — data access for the rektrs_* tables plus the read models the
 * approval services need (Post rows for snapshots, integrations, memberships).
 * Every query is org-scoped at this layer; services never build raw where
 * clauses against another org's rows (design §0.7).
 */
@Injectable()
export class RektrsRepository {
  constructor(private _prisma: PrismaService) {}

  db(tx?: RektrsDb): RektrsDb {
    return tx || this._prisma;
  }

  transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this._prisma.$transaction(fn);
  }

  // ── Brands ────────────────────────────────────────────────────────────────
  brandById(orgId: string, id: string, tx?: RektrsDb) {
    return this.db(tx).brand.findFirst({
      where: { id, organizationId: orgId, deletedAt: null },
      include: { channels: true },
    });
  }

  brandBySlug(orgId: string, slug: string, tx?: RektrsDb) {
    return this.db(tx).brand.findFirst({
      where: { organizationId: orgId, slug, deletedAt: null },
    });
  }

  brandsOfOrg(orgId: string, tx?: RektrsDb) {
    return this.db(tx).brand.findMany({
      where: { organizationId: orgId, deletedAt: null },
      include: { channels: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ── Brand ↔ channel membership ────────────────────────────────────────────
  brandIntegrationByIntegration(integrationId: string, tx?: RektrsDb) {
    return this.db(tx).brandIntegration.findUnique({
      where: { integrationId },
      include: { brand: true },
    });
  }

  brandIntegrationsByIntegrationIds(integrationIds: string[], tx?: RektrsDb) {
    return this.db(tx).brandIntegration.findMany({
      where: { integrationId: { in: integrationIds } },
      include: { brand: true },
    });
  }

  // ── Campaigns & briefs ────────────────────────────────────────────────────
  campaignById(orgId: string, id: string, tx?: RektrsDb) {
    return this.db(tx).campaign.findFirst({
      where: { id, organizationId: orgId, deletedAt: null },
      include: { brief: true },
    });
  }

  campaignsOfOrg(
    orgId: string,
    filters: { brandId?: string; status?: string; ownerId?: string },
    tx?: RektrsDb
  ) {
    return this.db(tx).campaign.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        ...(filters.brandId ? { brandId: filters.brandId } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.ownerId ? { ownerId: filters.ownerId } : {}),
      },
      include: { brief: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  briefByCampaign(orgId: string, campaignId: string, tx?: RektrsDb) {
    return this.db(tx).brief.findFirst({
      where: { campaignId, organizationId: orgId },
    });
  }

  // ── Approvals ─────────────────────────────────────────────────────────────
  approvalById(orgId: string, id: string, tx?: RektrsDb) {
    return this.db(tx).approval.findFirst({
      where: { id, organizationId: orgId },
    });
  }

  openApprovalForBatch(orgId: string, batchId: string, tx?: RektrsDb) {
    return this.db(tx).approval.findFirst({
      where: {
        organizationId: orgId,
        batchId,
        state: { notIn: ['PUBLISHED', 'CANCELLED'] },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  approvalByBatch(orgId: string, batchId: string, tx?: RektrsDb) {
    return this.db(tx).approval.findFirst({
      where: { organizationId: orgId, batchId },
      orderBy: { createdAt: 'desc' },
    });
  }

  approvalsOfOrg(
    orgId: string,
    filters: {
      state?: RektrsApprovalState;
      brandId?: string;
      campaignId?: string;
      submittedById?: string;
    },
    tx?: RektrsDb
  ) {
    return this.db(tx).approval.findMany({
      where: {
        organizationId: orgId,
        ...(filters.state ? { state: filters.state } : {}),
        ...(filters.brandId ? { brandId: filters.brandId } : {}),
        ...(filters.campaignId ? { campaignId: filters.campaignId } : {}),
        ...(filters.submittedById
          ? { submittedById: filters.submittedById }
          : {}),
      },
      orderBy: { submittedAt: 'asc' },
    });
  }

  versionsOfApproval(approvalId: string, tx?: RektrsDb) {
    return this.db(tx).contentVersion.findMany({
      where: { approvalId },
      orderBy: [{ versionNo: 'asc' }, { integrationId: 'asc' }],
    });
  }

  eventsOfApproval(approvalId: string, tx?: RektrsDb) {
    return this.db(tx).approvalEvent.findMany({
      where: { approvalId },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ── Audit ─────────────────────────────────────────────────────────────────
  auditForEntity(orgId: string, entityType: string, entityId: string, tx?: RektrsDb) {
    return this.db(tx).auditEntry.findMany({
      where: { organizationId: orgId, entityType, entityId },
      orderBy: { createdAt: 'asc' },
    });
  }

  auditSearch(
    orgId: string,
    filters: {
      entityType?: string;
      entityId?: string;
      action?: string;
      from?: Date;
      to?: Date;
      cursor?: string;
      take: number;
    },
    tx?: RektrsDb
  ) {
    return this.db(tx).auditEntry.findMany({
      where: {
        organizationId: orgId,
        ...(filters.entityType ? { entityType: filters.entityType } : {}),
        ...(filters.entityId ? { entityId: filters.entityId } : {}),
        ...(filters.action ? { action: filters.action } : {}),
        ...(filters.from || filters.to
          ? {
              createdAt: {
                ...(filters.from ? { gte: filters.from } : {}),
                ...(filters.to ? { lte: filters.to } : {}),
              },
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: filters.take,
      ...(filters.cursor
        ? { cursor: { id: filters.cursor }, skip: 1 }
        : {}),
    });
  }

  // ── Org settings / membership / idempotency ───────────────────────────────
  orgSettings(orgId: string, tx?: RektrsDb) {
    return this.db(tx).rektrsOrgSettings.findUnique({
      where: { organizationId: orgId },
    });
  }

  userOrganization(orgId: string, userId: string, tx?: RektrsDb) {
    return this.db(tx).userOrganization.findFirst({
      where: { organizationId: orgId, userId },
    });
  }

  /** All enabled memberships of an org, with the user identity the alert
   *  chain (W2) and kill-switch notices (W5) address. */
  orgMembers(orgId: string, tx?: RektrsDb) {
    return this.db(tx).userOrganization.findMany({
      where: { organizationId: orgId, disabled: false },
      include: {
        user: { select: { id: true, email: true, name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  userById(userId: string, tx?: RektrsDb) {
    return this.db(tx).user.findFirst({
      where: { id: userId },
      select: { id: true, email: true, name: true },
    });
  }

  idempotencyKey(orgId: string, key: string, tx?: RektrsDb) {
    return this.db(tx).rektrsIdempotencyKey.findUnique({
      where: { organizationId_key: { organizationId: orgId, key } },
    });
  }

  // ── Upstream read models (snapshots, scope) ───────────────────────────────
  postsOfBatch(orgId: string, batchId: string, tx?: RektrsDb) {
    return this.db(tx).post.findMany({
      where: { organizationId: orgId, batchId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  }

  postsOfGroup(orgId: string, group: string, tx?: RektrsDb) {
    return this.db(tx).post.findMany({
      where: { organizationId: orgId, group, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  }

  postById(orgId: string, id: string, tx?: RektrsDb) {
    return this.db(tx).post.findFirst({
      where: { id, organizationId: orgId, deletedAt: null },
    });
  }

  integrationsByIds(orgId: string, ids: string[], tx?: RektrsDb) {
    return this.db(tx).integration.findMany({
      where: { id: { in: ids }, organizationId: orgId, deletedAt: null },
    });
  }

  integrationById(orgId: string, id: string, tx?: RektrsDb) {
    return this.db(tx).integration.findFirst({
      where: { id, organizationId: orgId, deletedAt: null },
    });
  }

  mediaById(orgId: string, id: string, tx?: RektrsDb) {
    return this.db(tx).media.findFirst({
      where: { id, organizationId: orgId, deletedAt: null },
    });
  }

  // ── W5 kill-switch reads ──────────────────────────────────────────────────
  /** Every QUEUE post on the given channels — the pull-back set of a pause. */
  queuedPostsOfChannels(
    orgId: string,
    integrationIds: string[],
    tx?: RektrsDb
  ) {
    if (!integrationIds.length) {
      return Promise.resolve([]);
    }
    return this.db(tx).post.findMany({
      where: {
        organizationId: orgId,
        integrationId: { in: integrationIds },
        state: 'QUEUE',
        deletedAt: null,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  brandPausedPosts(brandId: string, tx?: RektrsDb) {
    return this.db(tx).brandPausedPost.findMany({
      where: { brandId },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ── W1 lead machine ───────────────────────────────────────────────────────
  leadRuleByBrand(orgId: string, brandId: string, tx?: RektrsDb) {
    return this.db(tx).leadRule.findFirst({
      where: { brandId, organizationId: orgId },
    });
  }

  /** All enabled rules with their brand channels — the poller's work list. */
  enabledLeadRules(tx?: RektrsDb) {
    return this.db(tx).leadRule.findMany({
      where: { enabled: true },
      include: {
        brand: {
          include: { channels: { include: { integration: true } } },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  leadById(orgId: string, id: string, tx?: RektrsDb) {
    return this.db(tx).lead.findFirst({
      where: { id, organizationId: orgId },
    });
  }

  leadsOfOrg(
    orgId: string,
    filters: { status?: RektrsLeadStatus; brandId?: string; take?: number },
    tx?: RektrsDb
  ) {
    return this.db(tx).lead.findMany({
      where: {
        organizationId: orgId,
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.brandId ? { brandId: filters.brandId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(filters.take || 100, 1), 200),
    });
  }

  /** Any lead (automated or human-routed) for the per-post dedupe check. */
  leadForCommenterPost(
    ruleId: string,
    providerPostId: string,
    commenterId: string,
    tx?: RektrsDb
  ) {
    return this.db(tx).lead.findFirst({
      where: { ruleId, providerPostId, commenterId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Leads whose CRM webhook still owes a delivery: DM_SENT means the DM
   * landed but the webhook was never attempted (crash window), WEBHOOK_
   * PENDING means attempts remain. Cross-org BY DESIGN (system sweep);
   * delivery re-reads each row's own org settings.
   */
  leadsAwaitingWebhook(maxAttempts: number, tx?: RektrsDb) {
    return this.db(tx).lead.findMany({
      where: {
        status: { in: ['DM_SENT', 'WEBHOOK_PENDING'] },
        webhookAttempts: { lt: maxAttempts },
      },
      orderBy: { updatedAt: 'asc' },
      take: 100,
    });
  }

  /** Recently published, provider-mapped root posts of the given channels. */
  publishedPostsForChannels(
    orgId: string,
    integrationIds: string[],
    since: Date,
    tx?: RektrsDb
  ) {
    if (!integrationIds.length) {
      return Promise.resolve([]);
    }
    return this.db(tx).post.findMany({
      where: {
        organizationId: orgId,
        integrationId: { in: integrationIds },
        state: 'PUBLISHED',
        parentPostId: null,
        releaseId: { not: null },
        publishDate: { gte: since },
        deletedAt: null,
      },
      orderBy: { publishDate: 'desc' },
      take: 100,
    });
  }

  /**
   * Webhook-receiver resolution: a Meta payload names the page / IG user
   * id, which is Integration.internalId. The unique key is (org, internalId),
   * so the same account can exist in several orgs — every match is returned
   * and the lead engine no-ops for orgs without an enabled rule.
   */
  integrationsByInternalId(internalId: string, tx?: RektrsDb) {
    return this.db(tx).integration.findMany({
      where: { internalId, deletedAt: null },
    });
  }

  // ── W3 evergreen recycler ─────────────────────────────────────────────────
  evergreenSettingsByBrand(orgId: string, brandId: string, tx?: RektrsDb) {
    return this.db(tx).evergreenSettings.findFirst({
      where: { brandId, organizationId: orgId },
    });
  }

  /** All enabled recycler configurations with their brand channels — the
   *  scheduled sweep's work list (mirrors enabledLeadRules). */
  enabledEvergreenSettings(tx?: RektrsDb) {
    return this.db(tx).evergreenSettings.findMany({
      where: { enabled: true },
      include: {
        brand: {
          include: { channels: { include: { integration: true } } },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Candidate pool for one brand scan: PUBLISHED root posts on the brand's
   * channels whose publish moment is at or before `before` (the age
   * cutoff) and that carry a provider release id (no release id = the
   * provider never confirmed the post; it cannot be measured). Capped at
   * 100, most recent first — the cap is a documented W3 residual.
   */
  evergreenCandidates(
    orgId: string,
    integrationIds: string[],
    before: Date,
    tx?: RektrsDb
  ) {
    if (!integrationIds.length) {
      return Promise.resolve([]);
    }
    return this.db(tx).post.findMany({
      where: {
        organizationId: orgId,
        integrationId: { in: integrationIds },
        state: 'PUBLISHED',
        parentPostId: null,
        releaseId: { not: null },
        publishDate: { lte: before },
        deletedAt: null,
      },
      orderBy: { publishDate: 'desc' },
      take: 100,
    });
  }

  evergreenCopiesOfBrand(
    orgId: string,
    brandId: string,
    take = 50,
    tx?: RektrsDb
  ) {
    return this.db(tx).evergreenCopy.findMany({
      where: { organizationId: orgId, brandId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(take, 1), 200),
    });
  }

  evergreenRunsOfBrand(orgId: string, brandId: string, take = 20, tx?: RektrsDb) {
    return this.db(tx).evergreenRun.findMany({
      where: { organizationId: orgId, brandId },
      orderBy: { startedAt: 'desc' },
      take: Math.min(Math.max(take, 1), 100),
    });
  }

  /** The lineage row that made `postId` a copy, if it is one. */
  evergreenCopyByCopyPostId(copyPostId: string, tx?: RektrsDb) {
    return this.db(tx).evergreenCopy.findFirst({
      where: { copyPostId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Every copy ever made of a source post (oldest first). */
  evergreenCopiesForSource(brandId: string, sourcePostId: string, tx?: RektrsDb) {
    return this.db(tx).evergreenCopy.findMany({
      where: { brandId, sourcePostId },
      orderBy: { createdAt: 'asc' },
    });
  }

  evergreenCopyInRun(
    brandId: string,
    sourcePostId: string,
    runId: string,
    tx?: RektrsDb
  ) {
    return this.db(tx).evergreenCopy.findFirst({
      where: { brandId, sourcePostId, runId },
    });
  }

  evergreenCopiesCountForBrand(brandId: string, tx?: RektrsDb) {
    return this.db(tx).evergreenCopy.count({ where: { brandId } });
  }

  /** Most recent run of a brand — the sweep's once-a-week guard reads it. */
  lastEvergreenRun(brandId: string, tx?: RektrsDb) {
    return this.db(tx).evergreenRun.findFirst({
      where: { brandId },
      orderBy: { startedAt: 'desc' },
    });
  }

  /** Tag links of a post (the root's tags are copied onto a copy's root). */
  tagsOfPost(postId: string, tx?: RektrsDb) {
    return this.db(tx).tagsPosts.findMany({ where: { postId } });
  }

  // ── W4 milestone auto-CTA ─────────────────────────────────────────────────
  milestoneCtaSettingsByBrand(orgId: string, brandId: string, tx?: RektrsDb) {
    return this.db(tx).milestoneCtaSettings.findFirst({
      where: { brandId, organizationId: orgId },
    });
  }

  /** All enabled milestone-CTA configurations with their brand channels —
   *  the hourly sweep's work list (mirrors enabledEvergreenSettings). */
  enabledMilestoneCtaSettings(tx?: RektrsDb) {
    return this.db(tx).milestoneCtaSettings.findMany({
      where: { enabled: true },
      include: {
        brand: {
          include: { channels: { include: { integration: true } } },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Candidate pool for one brand scan: PUBLISHED root posts on the brand's
   * channels published AT OR AFTER `since` (the 30-day scan window) that
   * carry a provider release id (no release id = the provider never
   * confirmed the post; it cannot be measured or commented on). Capped at
   * 100, most recent first — the cap mirrors the W3 residual.
   */
  milestoneCtaCandidates(
    orgId: string,
    integrationIds: string[],
    since: Date,
    tx?: RektrsDb
  ) {
    if (!integrationIds.length) {
      return Promise.resolve([]);
    }
    return this.db(tx).post.findMany({
      where: {
        organizationId: orgId,
        integrationId: { in: integrationIds },
        state: 'PUBLISHED',
        parentPostId: null,
        releaseId: { not: null },
        publishDate: { gte: since },
        deletedAt: null,
      },
      orderBy: { publishDate: 'desc' },
      take: 100,
    });
  }

  /** The dedupe row of one post (at most one per brand+post, ever). */
  milestoneCtaActionForPost(brandId: string, postId: string, tx?: RektrsDb) {
    return this.db(tx).milestoneCtaAction.findFirst({
      where: { brandId, postId },
    });
  }

  milestoneCtaActionsOfBrand(
    orgId: string,
    brandId: string,
    take = 50,
    tx?: RektrsDb
  ) {
    return this.db(tx).milestoneCtaAction.findMany({
      where: { organizationId: orgId, brandId },
      orderBy: { updatedAt: 'desc' },
      take: Math.min(Math.max(take, 1), 200),
    });
  }

  milestoneCtaRunsOfBrand(
    orgId: string,
    brandId: string,
    take = 20,
    tx?: RektrsDb
  ) {
    return this.db(tx).milestoneCtaRun.findMany({
      where: { organizationId: orgId, brandId },
      orderBy: { startedAt: 'desc' },
      take: Math.min(Math.max(take, 1), 100),
    });
  }

  // ── W6 inbox triage ───────────────────────────────────────────────────────
  inboxSettingsByBrand(orgId: string, brandId: string, tx?: RektrsDb) {
    return this.db(tx).inboxSettings.findFirst({
      where: { brandId, organizationId: orgId },
    });
  }

  /** All enabled triage configurations with their brand channels — the
   *  poll-coverage list the W1 sync uses so triage-only brands (no lead
   *  rule) still get their comments fetched (mirrors enabledLeadRules). */
  enabledInboxSettings(tx?: RektrsDb) {
    return this.db(tx).inboxSettings.findMany({
      where: { enabled: true },
      include: {
        brand: {
          include: { channels: { include: { integration: true } } },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  inboxItemById(orgId: string, brandId: string, id: string, tx?: RektrsDb) {
    return this.db(tx).inboxItem.findFirst({
      where: { id, organizationId: orgId, brandId },
    });
  }

  inboxItemsOfBrand(
    orgId: string,
    brandId: string,
    filters: { status?: string; category?: string; take?: number },
    tx?: RektrsDb
  ) {
    return this.db(tx).inboxItem.findMany({
      where: {
        organizationId: orgId,
        brandId,
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.category ? { category: filters.category } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(filters.take || 100, 1), 200),
    });
  }

  inboxItemsOfOrg(
    orgId: string,
    filters: {
      status?: string;
      category?: string;
      brandId?: string;
      take?: number;
    },
    tx?: RektrsDb
  ) {
    return this.db(tx).inboxItem.findMany({
      where: {
        organizationId: orgId,
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.category ? { category: filters.category } : {}),
        ...(filters.brandId ? { brandId: filters.brandId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(filters.take || 100, 1), 200),
    });
  }

  // ── W7 blog → social chain ────────────────────────────────────────────────
  blogSettingsByBrand(orgId: string, brandId: string, tx?: RektrsDb) {
    return this.db(tx).blogSettings.findFirst({
      where: { brandId, organizationId: orgId },
    });
  }

  /**
   * Webhook brand resolution (W7 receiver): the URL key is a brand id or
   * a brand slug, and there is NO session org — the per-brand HMAC secret
   * is the authentication. Ids are globally unique; slugs are unique per
   * org only, so a slug can match several brands (the receiver then tries
   * each candidate's secret — only the right org's can verify). Cross-org
   * BY DESIGN at this one boundary, mirroring integrationsByInternalId
   * for the W1 Meta receiver.
   */
  brandsByWebhookKey(key: string, tx?: RektrsDb) {
    return this.db(tx).brand.findMany({
      where: { deletedAt: null, OR: [{ id: key }, { slug: key }] },
      include: { channels: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  blogRunByWpPost(brandId: string, wpPostId: string, tx?: RektrsDb) {
    return this.db(tx).blogChainRun.findFirst({
      where: { brandId, wpPostId },
    });
  }

  blogRunsOfBrand(orgId: string, brandId: string, take = 20, tx?: RektrsDb) {
    return this.db(tx).blogChainRun.findMany({
      where: { organizationId: orgId, brandId },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  // ── W2 reminder sweep reads ───────────────────────────────────────────────
  /**
   * IN_REVIEW submissions whose current round entered review at or before
   * `cutoff`. Cross-org BY DESIGN: this feeds the SYSTEM reminder sweep,
   * which re-scopes every notification to the row's own organizationId.
   * The marker claim (updateMany on marker IS NULL) happens in the alerts
   * service, so concurrent sweeps cannot double-send.
   */
  staleInReviewApprovals(cutoff: Date, tx?: RektrsDb) {
    return this.db(tx).approval.findMany({
      where: {
        state: 'IN_REVIEW',
        // an lte comparison never matches a NULL submittedAt
        submittedAt: { lte: cutoff },
      },
      orderBy: { submittedAt: 'asc' },
      take: 200,
    });
  }
}
