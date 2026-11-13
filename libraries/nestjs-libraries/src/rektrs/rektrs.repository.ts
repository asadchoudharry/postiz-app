import { Injectable } from '@nestjs/common';
import { Prisma, RektrsApprovalState } from '@prisma/client';
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
}
