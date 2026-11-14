import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { BlogChainRun, BlogSettings, Prisma } from '@prisma/client';
import { randomBytes, randomUUID } from 'crypto';
import { RektrsRepository } from './rektrs.repository';
import { RektrsAuditService } from './rektrs.audit.service';
import { RektrsRolesService } from './rektrs.roles.service';
import { RektrsActor, systemActor } from './rektrs.actor';
import { RektrsException, rektrsError } from './rektrs.errors';
import { UpdateBlogChainSettingsDto } from '@gitroom/nestjs-libraries/dtos/rektrs/rektrs.dto';
import {
  blogPlatformKindForProvider,
  buildFallbackVariants,
  buildUtmUrl,
  renderFirstComment,
  shapeAiVariants,
  stripHtmlToText,
  variantsAreUsable,
  verifyBlogSharedSecret,
  verifyBlogWebhookSignature,
  wpSlugFromLink,
  RektrsBlogPlatformKind,
  RektrsBlogVariants,
  REKTRS_BLOG_DEFAULT_FIRST_COMMENT,
  REKTRS_BLOG_PLATFORM_KINDS,
} from './rektrs.blog-chain';
import { RektrsBlogGenerationService } from './rektrs.blog-generation';

/**
 * REKTRS W7 — Blog → Social Chain (AUTOMATION-WORKFLOWS.md W7).
 *
 * A WordPress "post published" webhook arrives at the public receiver
 * (RektrsWordpressWebhookController) and lands here. The chain drafts —
 * it NEVER publishes and never schedules: it creates ordinary DRAFT
 * posts (W3 evergreen's direct-row construction, same group/batch
 * conventions) for the brand's LinkedIn / X / Instagram channels, in the
 * brand's voice when the AI provider is configured, from deterministic
 * templates when it is not (run marked AI_FALLBACK). A human then edits,
 * schedules and publishes through the normal Postiz flow, so the P3
 * approval gates (Gate A / Gate B) apply unchanged when the brand's
 * policy requires them.
 *
 * Authentication is the per-brand HMAC secret (X-Rektrs-Signature:
 * sha256=<hex> over the raw body; X-Rektrs-Secret shared-secret header
 * as fallback). The receiver FAILS CLOSED: unknown brand 404, chain
 * disabled 404, enabled-but-no-secret 503, bad signature 401. The secret
 * is stored server-side only (the W1 crmWebhookSecret convention),
 * never appears in any settings view or audit row, and leaves the
 * server exactly once — in the rotate response.
 *
 * First-comment truth: Post has NO first-comment field anywhere in this
 * codebase (providers read only settings.__type etc.). The intended
 * first comment is therefore rendered onto the RUN record (and shown in
 * the brand's run history) for a human to paste after publishing — no
 * publish-time hook was invented.
 */

export interface RektrsBlogChainSettingsView {
  brandId: string;
  enabled: boolean;
  /** Whether a webhook secret is set. The value itself is never read back. */
  secretSet: boolean;
  aiEnabled: boolean;
  voiceTone: string;
  voiceNotes: string;
  examplePost: string;
  utmSource: string;
  utmMedium: string;
  firstCommentTemplate: string;
  version: number | null;
}

export interface RektrsBlogVariantOutcome {
  outcome: 'DRAFTED' | 'SKIPPED_NO_CHANNEL' | 'FAILED';
  integrationIds: string[];
  /** Every created Post row id, in order (for X: root first, then parts). */
  postIds: string[];
  error?: string;
}

export type RektrsBlogVariantsRecord = Record<
  RektrsBlogPlatformKind,
  RektrsBlogVariantOutcome
>;

export interface RektrsBlogWebhookResult {
  received: true;
  duplicate?: boolean;
  ignored?: string;
  skipped?: string;
  runId?: string;
  status?: string;
  draftedCount?: number;
}

interface WordpressPayload {
  id?: unknown;
  link?: unknown;
  title?: unknown;
  excerpt?: unknown;
  content?: unknown;
  status?: unknown;
}

const ERROR_CAP = 500;

function isUniqueViolation(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
  );
}

/** WP REST-ish fields arrive as a string or as { rendered: string }. */
function wpFieldText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { rendered?: unknown }).rendered === 'string'
  ) {
    return (value as { rendered: string }).rendered;
  }
  return '';
}

@Injectable()
export class RektrsBlogChainService {
  private readonly _logger = new Logger(RektrsBlogChainService.name);

  constructor(
    private _repository: RektrsRepository,
    private _audit: RektrsAuditService,
    private _roles: RektrsRolesService,
    private _generation: RektrsBlogGenerationService
  ) {}

  // ── Settings (brand-level; MANAGER configures) ────────────────────────────
  async getBlogChainSettings(
    orgId: string,
    brandId: string
  ): Promise<RektrsBlogChainSettingsView> {
    const brand = await this._requireBrand(orgId, brandId);
    const row = await this._repository.blogSettingsByBrand(orgId, brand.id);
    if (!row) {
      return {
        brandId: brand.id,
        enabled: false,
        secretSet: false,
        aiEnabled: true,
        voiceTone: '',
        voiceNotes: '',
        examplePost: '',
        utmSource: '',
        utmMedium: 'social',
        firstCommentTemplate: REKTRS_BLOG_DEFAULT_FIRST_COMMENT,
        version: null,
      };
    }
    return this.settingsView(row);
  }

  async updateBlogChainSettings(
    orgId: string,
    actor: RektrsActor,
    brandId: string,
    dto: UpdateBlogChainSettingsDto,
    ifMatch?: number
  ): Promise<RektrsBlogChainSettingsView> {
    await this._roles.assertFunction(orgId, actor, 'MANAGER');
    const brand = await this._requireBrand(orgId, brandId);
    const existing = await this._repository.blogSettingsByBrand(
      orgId,
      brand.id
    );
    if (existing && ifMatch !== undefined && ifMatch !== existing.version) {
      throw rektrsError.conflict(
        'VERSION_CONFLICT',
        'The blog chain settings changed since they were loaded; reload and retry'
      );
    }
    const data = {
      enabled: dto.enabled ?? existing?.enabled ?? false,
      aiEnabled: dto.aiEnabled ?? existing?.aiEnabled ?? true,
      voiceTone: (dto.voiceTone ?? existing?.voiceTone ?? '').trim(),
      voiceNotes: (dto.voiceNotes ?? existing?.voiceNotes ?? '').trim(),
      examplePost: (dto.examplePost ?? existing?.examplePost ?? '').trim(),
      utmSource: (dto.utmSource ?? existing?.utmSource ?? '').trim(),
      utmMedium: (
        dto.utmMedium ??
        existing?.utmMedium ??
        'social'
      ).trim(),
      firstCommentTemplate: (
        dto.firstCommentTemplate ??
        existing?.firstCommentTemplate ??
        REKTRS_BLOG_DEFAULT_FIRST_COMMENT
      ).trim(),
    };
    const saved = await this._repository.transaction(async (tx) => {
      const row = existing
        ? await this._repository.db(tx).blogSettings.update({
            where: { id: existing.id },
            data: { ...data, version: { increment: 1 } },
          })
        : await this._repository.db(tx).blogSettings.create({
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
          action: 'blog_chain_settings.update',
          entityType: 'BlogSettings',
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

  /**
   * Rotate the webhook secret. The NEW secret is returned in this one
   * response and never again — the settings view exposes only
   * `secretSet`, and the audit row records the rotation, not the value.
   */
  async rotateBlogChainSecret(
    orgId: string,
    actor: RektrsActor,
    brandId: string
  ): Promise<{ brandId: string; secret: string; secretSet: true }> {
    await this._roles.assertFunction(orgId, actor, 'MANAGER');
    const brand = await this._requireBrand(orgId, brandId);
    const existing = await this._repository.blogSettingsByBrand(
      orgId,
      brand.id
    );
    const secret = `rkwp_${randomBytes(24).toString('hex')}`;
    await this._repository.transaction(async (tx) => {
      const row = existing
        ? await this._repository.db(tx).blogSettings.update({
            where: { id: existing.id },
            data: { webhookSecret: secret, version: { increment: 1 } },
          })
        : await this._repository.db(tx).blogSettings.create({
            data: {
              organizationId: orgId,
              brandId: brand.id,
              createdById: actor.userId || 'system',
              webhookSecret: secret,
            },
          });
      await this._audit.write(
        orgId,
        actor,
        {
          action: 'blog_chain_settings.secret_rotate',
          entityType: 'BlogSettings',
          entityId: row.id,
          // The secret value is deliberately NOT in the metadata.
          metadata: { brandName: brand.name, secretSet: true },
        },
        tx
      );
      return row;
    });
    return { brandId: brand.id, secret, secretSet: true };
  }

  // ── Run history (brand screen) ────────────────────────────────────────────
  async listBlogChainRuns(orgId: string, brandId: string) {
    const brand = await this._requireBrand(orgId, brandId);
    const runs = await this._repository.blogRunsOfBrand(orgId, brand.id);
    return { runs };
  }

  // ── The webhook chain (public receiver lands here) ────────────────────────
  async handleWordpressWebhook(
    brandKey: string,
    auth: {
      signature?: string;
      sharedSecret?: string;
      rawBody: Buffer | string;
    },
    payload: WordpressPayload
  ): Promise<RektrsBlogWebhookResult> {
    const candidates = await this._repository.brandsByWebhookKey(brandKey);
    if (!candidates.length) {
      throw rektrsError.notFound(
        'BLOG_BRAND_NOT_FOUND',
        'No brand matches this webhook address'
      );
    }
    // Resolve the one brand this delivery belongs to. For unique keys
    // (an id, or a slug used by one org) this is a single pass; a slug
    // shared across orgs resolves to the candidate whose secret verifies.
    const resolved: Array<{
      brand: (typeof candidates)[number];
      settings: BlogSettings;
    }> = [];
    let sawEnabled = false;
    let sawSecret = false;
    for (const brand of candidates) {
      const settings = await this._repository.blogSettingsByBrand(
        brand.organizationId,
        brand.id
      );
      if (!settings?.enabled) {
        continue;
      }
      sawEnabled = true;
      if (!settings.webhookSecret) {
        continue;
      }
      sawSecret = true;
      if (
        verifyBlogWebhookSignature(
          settings.webhookSecret,
          auth.signature,
          auth.rawBody
        ) ||
        verifyBlogSharedSecret(settings.webhookSecret, auth.sharedSecret)
      ) {
        resolved.push({ brand, settings });
      }
    }
    if (!sawEnabled) {
      // The chain is off for this brand: the endpoint does not exist for
      // it (the W1 receiver's ignore posture, as a 404).
      throw rektrsError.notFound(
        'BLOG_CHAIN_DISABLED',
        'The blog chain is not enabled for this brand'
      );
    }
    if (!sawSecret) {
      throw new RektrsException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'BLOG_WEBHOOK_NOT_CONFIGURED',
        'No webhook secret is configured for this brand; rotate a secret in the brand settings first'
      );
    }
    if (!resolved.length) {
      throw new RektrsException(
        HttpStatus.UNAUTHORIZED,
        'BLOG_WEBHOOK_SIGNATURE_INVALID',
        'The webhook signature did not verify'
      );
    }
    const { brand, settings } = resolved[0];
    const orgId = brand.organizationId;

    const wpPostId =
      payload?.id === undefined || payload?.id === null
        ? ''
        : String(payload.id);
    const wpLink = typeof payload?.link === 'string' ? payload.link : '';
    if (!wpPostId || !wpLink) {
      throw rektrsError.badRequest(
        'BLOG_WEBHOOK_PAYLOAD_INVALID',
        'The delivery is missing the WordPress post id or link'
      );
    }
    if (payload?.status !== 'publish') {
      return { received: true, ignored: 'STATUS_NOT_PUBLISH' };
    }

    const existingRun = await this._repository.blogRunByWpPost(
      brand.id,
      wpPostId
    );
    if (existingRun) {
      return {
        received: true,
        duplicate: true,
        runId: existingRun.id,
        status: existingRun.status,
      };
    }

    const title = stripHtmlToText(wpFieldText(payload?.title)) || '(untitled)';

    // W5 kill-switch: record the delivery, create nothing, still answer
    // 200 so WordPress does not retry-storm a paused brand.
    if (brand.pausedAt) {
      const run = await this.createRunRow(orgId, brand.id, {
        wpPostId,
        wpLink,
        title,
        status: 'SKIPPED_BRAND_PAUSED',
      });
      if (!run) {
        const raced = await this._repository.blogRunByWpPost(
          brand.id,
          wpPostId
        );
        return {
          received: true,
          duplicate: true,
          runId: raced?.id,
          status: raced?.status,
        };
      }
      await this._audit.write(orgId, systemActor, {
        action: 'blog_chain.run',
        entityType: 'BlogChainRun',
        entityId: run.id,
        metadata: {
          brandId: brand.id,
          wpPostId,
          trigger: 'WEBHOOK',
          status: 'SKIPPED_BRAND_PAUSED',
        },
      });
      return { received: true, skipped: 'BRAND_PAUSED', runId: run.id, status: run.status };
    }

    const run = await this.createRunRow(orgId, brand.id, {
      wpPostId,
      wpLink,
      title,
      status: 'RECEIVED',
    });
    if (!run) {
      const raced = await this._repository.blogRunByWpPost(brand.id, wpPostId);
      return {
        received: true,
        duplicate: true,
        runId: raced?.id,
        status: raced?.status,
      };
    }
    await this._audit.write(orgId, systemActor, {
      action: 'blog_chain.run',
      entityType: 'BlogChainRun',
      entityId: run.id,
      metadata: {
        brandId: brand.id,
        wpPostId,
        trigger: 'WEBHOOK',
        status: 'RECEIVED',
      },
    });

    try {
      const outcome = await this.draftForRun(
        orgId,
        brand,
        settings,
        run,
        payload,
        title
      );
      return {
        received: true,
        runId: run.id,
        status: outcome.status,
        draftedCount: outcome.draftedCount,
      };
    } catch (e) {
      const error = String(e).slice(0, ERROR_CAP);
      this._logger.warn(
        `REKTRS W7 chain failed for brand ${brand.id} run ${run.id}: ${error}`
      );
      await this._repository
        .db()
        .blogChainRun.update({
          where: { id: run.id },
          data: { status: 'FAILED', error },
        })
        .catch(() => undefined);
      // After authentication the receiver always answers 200: the
      // failure is recorded on the run, and a retry would only dedupe.
      return { received: true, runId: run.id, status: 'FAILED' };
    }
  }

  // ── Drafting ──────────────────────────────────────────────────────────────
  private async draftForRun(
    orgId: string,
    brand: {
      id: string;
      name: string;
      slug: string;
      channels: Array<{ integrationId: string }>;
    },
    settings: BlogSettings,
    run: BlogChainRun,
    payload: WordpressPayload,
    title: string
  ): Promise<{ status: string; draftedCount: number }> {
    const excerpt = stripHtmlToText(wpFieldText(payload?.excerpt));
    const contentText = stripHtmlToText(wpFieldText(payload?.content));
    const utmLink = buildUtmUrl(run.wpLink, {
      source: settings.utmSource || brand.slug,
      medium: settings.utmMedium || 'social',
      campaign: wpSlugFromLink(run.wpLink) || run.wpPostId,
    });
    const firstComment = renderFirstComment(settings.firstCommentTemplate, {
      link: utmLink,
      title,
    });

    // AI first (when enabled AND configured), deterministic fallback
    // otherwise — the run records which one actually wrote the drafts.
    let aiMode: 'AI' | 'AI_FALLBACK' = 'AI_FALLBACK';
    let aiError: string | null = null;
    let variants: RektrsBlogVariants | null = null;
    if (settings.aiEnabled && this._generation.isConfigured()) {
      const generated = await this._generation.generateVariants({
        brandName: brand.name,
        title,
        excerpt,
        contentText,
        utmLink,
        voiceTone: settings.voiceTone,
        voiceNotes: settings.voiceNotes,
        examplePost: settings.examplePost,
      });
      if (generated) {
        const shaped = shapeAiVariants(generated, utmLink);
        if (variantsAreUsable(shaped)) {
          variants = shaped;
          aiMode = 'AI';
        } else {
          aiError =
            'AI output was unusable; deterministic template drafts were used';
        }
      } else {
        aiError =
          'AI generation failed; deterministic template drafts were used';
      }
    }
    if (!variants) {
      variants = buildFallbackVariants({ title, excerpt, contentText }, utmLink);
    }

    // Target channels: the brand's ACTIVE channels, grouped by platform
    // kind. Disabled channels never receive drafts.
    const channelIds = (brand.channels || []).map((c) => c.integrationId);
    const integrations = channelIds.length
      ? await this._repository.integrationsByIds(orgId, channelIds)
      : [];
    const byKind = new Map<RektrsBlogPlatformKind, typeof integrations>();
    for (const integration of integrations) {
      if (integration.disabled) {
        continue;
      }
      const kind = blogPlatformKindForProvider(integration.providerIdentifier);
      if (!kind) {
        continue;
      }
      byKind.set(kind, [...(byKind.get(kind) || []), integration]);
    }

    const batchId = randomUUID();
    const now = new Date();
    const record = {} as RektrsBlogVariantsRecord;
    let draftedCount = 0;
    let anyProblem = false;

    for (const kind of REKTRS_BLOG_PLATFORM_KINDS) {
      const channels = byKind.get(kind) || [];
      if (!channels.length) {
        record[kind] = {
          outcome: 'SKIPPED_NO_CHANNEL',
          integrationIds: [],
          postIds: [],
        };
        anyProblem = true;
        continue;
      }
      const outcome: RektrsBlogVariantOutcome = {
        outcome: 'DRAFTED',
        integrationIds: [],
        postIds: [],
      };
      for (const integration of channels) {
        try {
          const postIds = await this.createDraftsForChannel(
            orgId,
            brand.id,
            run.id,
            batchId,
            integration,
            kind,
            variants,
            title,
            now
          );
          outcome.integrationIds.push(integration.id);
          outcome.postIds.push(...postIds);
          draftedCount++;
        } catch (e) {
          outcome.outcome = 'FAILED';
          outcome.error = String(e).slice(0, ERROR_CAP);
          anyProblem = true;
          this._logger.warn(
            `REKTRS W7 draft creation failed (brand ${brand.id}, ${kind}, integration ${integration.id}): ${outcome.error}`
          );
        }
      }
      if (outcome.outcome === 'DRAFTED' && !outcome.postIds.length) {
        outcome.outcome = 'FAILED';
        outcome.error = 'No draft could be created';
        anyProblem = true;
      }
      record[kind] = outcome;
    }

    const status =
      draftedCount === 0 ? 'FAILED' : anyProblem ? 'PARTIAL' : 'DRAFTED';
    await this._repository.db().blogChainRun.update({
      where: { id: run.id },
      data: {
        status,
        aiMode,
        aiError,
        firstComment,
        variants: record as unknown as Prisma.InputJsonValue,
        draftedCount,
        error:
          status === 'FAILED'
            ? 'No drafts could be created — see the per-platform outcomes'
            : null,
      },
    });
    return { status, draftedCount };
  }

  /**
   * Create the DRAFT post rows for one channel (W3's direct-row
   * construction): a fresh group per channel draft set, the run's batchId
   * shared across the whole chain, thread parts chained by parentPostId.
   * The drafts are ordinary drafts — a human schedules/publishes them
   * through the normal flow and the P3 gates apply there.
   */
  private async createDraftsForChannel(
    orgId: string,
    brandId: string,
    runId: string,
    batchId: string,
    integration: { id: string; providerIdentifier: string },
    kind: RektrsBlogPlatformKind,
    variants: RektrsBlogVariants,
    title: string,
    now: Date
  ): Promise<string[]> {
    const parts =
      kind === 'X'
        ? variants.xThread
        : [kind === 'LINKEDIN' ? variants.linkedin : variants.instagram];
    const group = randomUUID();
    const postIds = await this._repository.transaction(async (tx) => {
      const db = this._repository.db(tx);
      const ids: string[] = [];
      let parentId: string | null = null;
      for (const content of parts) {
        const created = await db.post.create({
          data: {
            state: 'DRAFT',
            publishDate: now,
            organizationId: orgId,
            integrationId: integration.id,
            content,
            delay: 0,
            group,
            batchId,
            title,
            parentPostId: parentId,
            settings: JSON.stringify({
              __type: integration.providerIdentifier,
            }),
            creationMethod: 'UNKNOWN',
          },
        });
        ids.push(created.id);
        parentId = created.id;
      }
      await this._audit.write(
        orgId,
        systemActor,
        {
          action: 'blog_chain.draft_created',
          entityType: 'BlogChainRun',
          entityId: runId,
          metadata: {
            brandId,
            runId,
            platform: kind,
            providerIdentifier: integration.providerIdentifier,
            integrationId: integration.id,
            postIds: ids,
            batchId,
            group,
          },
        },
        tx
      );
      return ids;
    });
    return postIds;
  }

  /** Insert the run row; returns null when the dedupe unique index raced. */
  private async createRunRow(
    orgId: string,
    brandId: string,
    data: { wpPostId: string; wpLink: string; title: string; status: string }
  ): Promise<BlogChainRun | null> {
    try {
      return await this._repository.db().blogChainRun.create({
        data: { organizationId: orgId, brandId, ...data },
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        return null;
      }
      throw e;
    }
  }

  private async _requireBrand(orgId: string, brandId: string) {
    const brand = await this._repository.brandById(orgId, brandId);
    if (!brand) {
      throw rektrsError.notFound('BRAND_NOT_FOUND', 'Brand not found');
    }
    return brand;
  }

  private settingsView(row: BlogSettings): RektrsBlogChainSettingsView {
    return {
      brandId: row.brandId,
      enabled: row.enabled,
      secretSet: !!row.webhookSecret,
      aiEnabled: row.aiEnabled,
      voiceTone: row.voiceTone,
      voiceNotes: row.voiceNotes,
      examplePost: row.examplePost,
      utmSource: row.utmSource,
      utmMedium: row.utmMedium,
      firstCommentTemplate: row.firstCommentTemplate,
      version: row.version,
    };
  }
}
