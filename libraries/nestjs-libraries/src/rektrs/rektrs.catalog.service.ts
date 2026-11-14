import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RektrsRepository } from './rektrs.repository';
import { RektrsAuditService } from './rektrs.audit.service';
import { RektrsRolesService } from './rektrs.roles.service';
import { RektrsActor } from './rektrs.actor';
import { rektrsError } from './rektrs.errors';

export interface CreateBrandInput {
  name: string;
  slug?: string;
  description?: string;
  logoMediaId?: string;
  colorPrimary?: string;
  colorSecondary?: string;
  approvalRequired?: boolean;
}

export interface UpdateBrandInput {
  name?: string;
  description?: string | null;
  logoMediaId?: string | null;
  colorPrimary?: string | null;
  colorSecondary?: string | null;
  approvalRequired?: boolean;
}

export interface CreateCampaignInput {
  brandId: string;
  name: string;
  objective?: string;
  startsAt?: string;
  endsAt?: string;
  ownerId?: string;
}

export interface UpdateCampaignInput {
  name?: string;
  objective?: string | null;
  status?: string;
  startsAt?: string | null;
  endsAt?: string | null;
  ownerId?: string;
}

export interface UpsertBriefInput {
  objective: string;
  audience?: string;
  keyMessages?: string;
  mandatoryIncludes?: string;
  prohibitedTerms?: string;
  tone?: string;
  references?: string;
  assigneeId?: string;
  dueAt?: string;
}

const CAMPAIGN_STATUSES = ['ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED'];

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isUniqueViolation(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
  );
}

/**
 * REKTRS P3 — brands, channel membership, campaigns, briefs (design §3.2).
 * Brands govern enforcement; campaigns organise work (design §1.5).
 */
@Injectable()
export class RektrsCatalogService {
  constructor(
    private _repository: RektrsRepository,
    private _audit: RektrsAuditService,
    private _roles: RektrsRolesService
  ) {}

  // ── Brands ────────────────────────────────────────────────────────────────
  async createBrand(orgId: string, actor: RektrsActor, input: CreateBrandInput) {
    const slug = input.slug ? slugify(input.slug) : slugify(input.name);
    if (!slug) {
      throw rektrsError.badRequest('INVALID_SLUG', 'Brand name produces an empty slug');
    }
    if (input.logoMediaId) {
      await this.assertOrgMedia(orgId, input.logoMediaId);
    }
    try {
      return await this._repository.transaction(async (tx) => {
        const brand = await this._repository.db(tx).brand.create({
          data: {
            organizationId: orgId,
            name: input.name,
            slug,
            description: input.description,
            logoMediaId: input.logoMediaId,
            colorPrimary: input.colorPrimary,
            colorSecondary: input.colorSecondary,
            approvalRequired: input.approvalRequired ?? false,
            createdById: actor.userId as string,
          },
          include: { channels: true },
        });
        await this._audit.write(
          orgId,
          actor,
          { action: 'brand.create', entityType: 'Brand', entityId: brand.id },
          tx
        );
        return brand;
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw rektrsError.conflict(
          'BRAND_SLUG_TAKEN',
          `A brand with slug "${slug}" already exists in this organization`
        );
      }
      throw e;
    }
  }

  listBrands(orgId: string) {
    return this._repository.brandsOfOrg(orgId);
  }

  async getBrand(orgId: string, id: string) {
    const brand = await this._repository.brandById(orgId, id);
    if (!brand) {
      throw rektrsError.notFound('BRAND_NOT_FOUND', 'Brand not found');
    }
    return brand;
  }

  async updateBrand(
    orgId: string,
    actor: RektrsActor,
    id: string,
    input: UpdateBrandInput,
    ifMatch: number
  ) {
    const brand = await this.getBrand(orgId, id);
    if (input.logoMediaId) {
      await this.assertOrgMedia(orgId, input.logoMediaId);
    }
    const policyFlip =
      input.approvalRequired !== undefined &&
      input.approvalRequired !== brand.approvalRequired;
    return this._repository.transaction(async (tx) => {
      const result = await this._repository.db(tx).brand.updateMany({
        where: { id, organizationId: orgId, version: ifMatch, deletedAt: null },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          ...(input.logoMediaId !== undefined
            ? { logoMediaId: input.logoMediaId }
            : {}),
          ...(input.colorPrimary !== undefined
            ? { colorPrimary: input.colorPrimary }
            : {}),
          ...(input.colorSecondary !== undefined
            ? { colorSecondary: input.colorSecondary }
            : {}),
          ...(input.approvalRequired !== undefined
            ? { approvalRequired: input.approvalRequired }
            : {}),
          version: { increment: 1 },
        },
      });
      if (!result.count) {
        throw rektrsError.conflict(
          'VERSION_CONFLICT',
          'The brand was modified concurrently; re-read and retry with the current version'
        );
      }
      await this._audit.write(
        orgId,
        actor,
        {
          action: policyFlip ? 'brand.policy_change' : 'brand.update',
          entityType: 'Brand',
          entityId: id,
          metadata: policyFlip
            ? { approvalRequired: input.approvalRequired }
            : undefined,
        },
        tx
      );
      return this._repository.brandById(orgId, id, tx);
    });
  }

  // ── Brand ↔ channel membership ────────────────────────────────────────────
  async assignChannel(
    orgId: string,
    actor: RektrsActor,
    brandId: string,
    integrationId: string
  ) {
    const brand = await this.getBrand(orgId, brandId);
    const integration = await this._repository.integrationById(orgId, integrationId);
    if (!integration) {
      throw rektrsError.notFound('CHANNEL_NOT_FOUND', 'Channel not found in this organization');
    }
    const existing =
      await this._repository.brandIntegrationByIntegration(integrationId);
    if (existing) {
      if (existing.brandId === brand.id) {
        return existing;
      }
      throw rektrsError.conflict(
        'CHANNEL_IN_OTHER_BRAND',
        'Channel already belongs to another brand; remove it there first (both actions are audited)'
      );
    }
    return this._repository.transaction(async (tx) => {
      const membership = await this._repository.db(tx).brandIntegration.create({
        data: { brandId: brand.id, integrationId },
      });
      await this._audit.write(
        orgId,
        actor,
        {
          action: 'brand.channel_assign',
          entityType: 'Brand',
          entityId: brand.id,
          metadata: { integrationId },
        },
        tx
      );
      return membership;
    });
  }

  async removeChannel(
    orgId: string,
    actor: RektrsActor,
    brandId: string,
    integrationId: string
  ) {
    const brand = await this.getBrand(orgId, brandId);
    const existing =
      await this._repository.brandIntegrationByIntegration(integrationId);
    if (!existing || existing.brandId !== brand.id) {
      throw rektrsError.notFound(
        'CHANNEL_NOT_IN_BRAND',
        'Channel is not a member of this brand'
      );
    }
    return this._repository.transaction(async (tx) => {
      await this._repository.db(tx).brandIntegration.delete({
        where: { id: existing.id },
      });
      await this._audit.write(
        orgId,
        actor,
        {
          action: 'brand.channel_remove',
          entityType: 'Brand',
          entityId: brand.id,
          metadata: { integrationId },
        },
        tx
      );
      return { removed: true, integrationId };
    });
  }

  // ── Campaigns ─────────────────────────────────────────────────────────────
  async createCampaign(orgId: string, actor: RektrsActor, input: CreateCampaignInput) {
    await this.getBrand(orgId, input.brandId);
    return this._repository.transaction(async (tx) => {
      const campaign = await this._repository.db(tx).campaign.create({
        data: {
          organizationId: orgId,
          brandId: input.brandId,
          name: input.name,
          objective: input.objective,
          startsAt: input.startsAt ? new Date(input.startsAt) : undefined,
          endsAt: input.endsAt ? new Date(input.endsAt) : undefined,
          ownerId: input.ownerId || (actor.userId as string),
          createdById: actor.userId as string,
        },
        include: { brief: true },
      });
      await this._audit.write(
        orgId,
        actor,
        { action: 'campaign.create', entityType: 'Campaign', entityId: campaign.id },
        tx
      );
      return campaign;
    });
  }

  listCampaigns(
    orgId: string,
    filters: { brandId?: string; status?: string; ownerId?: string }
  ) {
    return this._repository.campaignsOfOrg(orgId, filters);
  }

  async getCampaign(orgId: string, id: string) {
    const campaign = await this._repository.campaignById(orgId, id);
    if (!campaign) {
      throw rektrsError.notFound('CAMPAIGN_NOT_FOUND', 'Campaign not found');
    }
    return campaign;
  }

  async updateCampaign(
    orgId: string,
    actor: RektrsActor,
    id: string,
    input: UpdateCampaignInput,
    ifMatch: number
  ) {
    const campaign = await this.getCampaign(orgId, id);
    const functions = actor.userId
      ? await this._roles.getFunctions(orgId, actor.userId)
      : [];
    if (!functions.includes('MANAGER') && campaign.ownerId !== actor.userId) {
      throw rektrsError.forbidden(
        'REKTRS_FUNCTION_REQUIRED',
        'Only a MANAGER or the campaign owner may update this campaign'
      );
    }
    if (input.status && !CAMPAIGN_STATUSES.includes(input.status)) {
      throw rektrsError.badRequest(
        'INVALID_CAMPAIGN_STATUS',
        `Status must be one of ${CAMPAIGN_STATUSES.join(', ')}`
      );
    }
    return this._repository.transaction(async (tx) => {
      const result = await this._repository.db(tx).campaign.updateMany({
        where: { id, organizationId: orgId, version: ifMatch, deletedAt: null },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.objective !== undefined ? { objective: input.objective } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.startsAt !== undefined
            ? { startsAt: input.startsAt ? new Date(input.startsAt) : null }
            : {}),
          ...(input.endsAt !== undefined
            ? { endsAt: input.endsAt ? new Date(input.endsAt) : null }
            : {}),
          ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
          version: { increment: 1 },
        },
      });
      if (!result.count) {
        throw rektrsError.conflict(
          'VERSION_CONFLICT',
          'The campaign was modified concurrently; re-read and retry with the current version'
        );
      }
      await this._audit.write(
        orgId,
        actor,
        { action: 'campaign.update', entityType: 'Campaign', entityId: id },
        tx
      );
      return this._repository.campaignById(orgId, id, tx);
    });
  }

  // ── Briefs ────────────────────────────────────────────────────────────────
  async getBrief(orgId: string, campaignId: string) {
    await this.getCampaign(orgId, campaignId);
    return this._repository.briefByCampaign(orgId, campaignId);
  }

  async upsertBrief(
    orgId: string,
    actor: RektrsActor,
    campaignId: string,
    input: UpsertBriefInput
  ) {
    const campaign = await this.getCampaign(orgId, campaignId);
    const existing = await this._repository.briefByCampaign(orgId, campaignId);
    const functions = actor.userId
      ? await this._roles.getFunctions(orgId, actor.userId)
      : [];
    const allowed =
      functions.includes('MANAGER') ||
      campaign.ownerId === actor.userId ||
      (existing && existing.assigneeId === actor.userId);
    if (!allowed) {
      throw rektrsError.forbidden(
        'REKTRS_FUNCTION_REQUIRED',
        'Only a MANAGER, the campaign owner, or the assigned creator may write this brief'
      );
    }
    return this._repository.transaction(async (tx) => {
      const brief = await this._repository.db(tx).brief.upsert({
        where: { campaignId },
        create: {
          organizationId: orgId,
          campaignId,
          objective: input.objective,
          audience: input.audience,
          keyMessages: input.keyMessages,
          mandatoryIncludes: input.mandatoryIncludes,
          prohibitedTerms: input.prohibitedTerms,
          tone: input.tone,
          references: input.references,
          assigneeId: input.assigneeId,
          dueAt: input.dueAt ? new Date(input.dueAt) : undefined,
          createdById: actor.userId as string,
        },
        update: {
          objective: input.objective,
          ...(input.audience !== undefined ? { audience: input.audience } : {}),
          ...(input.keyMessages !== undefined
            ? { keyMessages: input.keyMessages }
            : {}),
          ...(input.mandatoryIncludes !== undefined
            ? { mandatoryIncludes: input.mandatoryIncludes }
            : {}),
          ...(input.prohibitedTerms !== undefined
            ? { prohibitedTerms: input.prohibitedTerms }
            : {}),
          ...(input.tone !== undefined ? { tone: input.tone } : {}),
          ...(input.references !== undefined
            ? { references: input.references }
            : {}),
          ...(input.assigneeId !== undefined
            ? { assigneeId: input.assigneeId }
            : {}),
          ...(input.dueAt !== undefined
            ? { dueAt: input.dueAt ? new Date(input.dueAt) : null }
            : {}),
          version: { increment: 1 },
        },
      });
      await this._audit.write(
        orgId,
        actor,
        {
          action: existing ? 'brief.update' : 'brief.create',
          entityType: 'Brief',
          entityId: brief.id,
          metadata: { campaignId },
        },
        tx
      );
      return brief;
    });
  }

  private async assertOrgMedia(orgId: string, mediaId: string) {
    const media = await this._repository.mediaById(orgId, mediaId);
    if (!media) {
      throw rektrsError.unprocessable(
        'MEDIA_NOT_IN_ORG',
        'logoMediaId does not reference media owned by this organization'
      );
    }
  }
}
