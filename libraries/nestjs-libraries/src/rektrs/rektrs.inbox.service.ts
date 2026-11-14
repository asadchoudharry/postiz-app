import { Injectable, Logger } from '@nestjs/common';
import { Brand, InboxItem, InboxSettings, Integration, Prisma } from '@prisma/client';
import { RektrsRepository } from './rektrs.repository';
import { RektrsAuditService } from './rektrs.audit.service';
import { RektrsRolesService } from './rektrs.roles.service';
import { RektrsAlertsService } from './rektrs.alerts.service';
import { RektrsActor, systemActor } from './rektrs.actor';
import { rektrsError } from './rektrs.errors';
import {
  ListInboxItemsQueryDto,
  SendInboxReplyDto,
  UpdateInboxSettingsDto,
} from '@gitroom/nestjs-libraries/dtos/rektrs/rektrs.dto';
import { normalizePhraseList } from './rektrs.leads';
import { RektrsInboundComment } from './rektrs.lead-providers';
import {
  classifyInboxText,
  detectInboxLanguage,
  faqTemplateField,
  renderInboxFaqTemplate,
  RektrsInboxStatus,
} from './rektrs.inbox';
import { RektrsTranslationService } from './rektrs.inbox-translation';
import { RektrsInboxReplyGateway } from './rektrs.inbox-providers';

/**
 * REKTRS W6 — Inbox Triage (Multilingual) (AUTOMATION-WORKFLOWS.md W6).
 *
 * Every inbound comment on a triage-enabled brand's channels is
 * classified, translated and queued for a human:
 *   COMPLAINT → status QUEUED + a MANAGER alert (nothing auto-replied);
 *   FAQ topic → a suggested reply drafted from the brand's template,
 *               status DRAFTED — a HUMAN sends it with one tap;
 *   GENERAL   → status NEW, listed only.
 * NOTHING is ever auto-sent in v1: the only provider write in this
 * service is sendReply, which runs on an explicit human action.
 *
 * Ingestion rides the W1 stream (no second poller): the lead engine
 * calls triageInboundComment for every claimed comment (poll sync AND
 * Meta webhook take the identical path), and the W1 poller additionally
 * fetches comments for triage-enabled brands that have no lead rule, so
 * a triage-only brand is fully covered. Triage dedupes on
 * (brandId, providerCommentId) — the item unique index — behind the W1
 * seen-claim that precedes it.
 *
 * DM truth: NO provider in this codebase exposes a DM/message READ path
 * (the integrations interface has none; W1 added comment reads + private
 * replies only), so v1 triages comments only. There is no DM pipeline
 * here to fake — when a provider grows a message-read primitive, DMs
 * enter through the same triageInboundComment shape.
 *
 * Translation truth: routed through RektrsTranslationService (the
 * codebase's env-keyed OpenAI surface). Unconfigured → the item records
 * UNAVAILABLE and keeps its original text; translations are never
 * invented, and classification never depends on translation (the W6
 * lexicons cover EN / Urdu / Arabic / Roman Urdu directly).
 *
 * W5 coherence: a paused brand is skipped by triage, and a manual send
 * on a paused brand is refused 409 BRAND_PAUSED (dismiss stays allowed —
 * it is bookkeeping, not a provider write).
 */

export interface RektrsInboxSettingsView {
  brandId: string;
  enabled: boolean;
  workingLanguage: string;
  faqPrice: string;
  faqTiming: string;
  faqLocation: string;
  faqDelivery: string;
  extraComplaintKeywords: string[];
  version: number | null;
}

export type RektrsTriageOutcome =
  | 'triaged'
  | 'duplicate'
  | 'disabled'
  | 'paused'
  | 'skipped';

const ERROR_CAP = 500;
const QUEUE_WORKER_FUNCTIONS = ['MANAGER', 'CREATOR', 'ANALYST'] as const;

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
export class RektrsInboxService {
  private readonly _logger = new Logger(RektrsInboxService.name);

  constructor(
    private _repository: RektrsRepository,
    private _audit: RektrsAuditService,
    private _roles: RektrsRolesService,
    private _alerts: RektrsAlertsService,
    private _translation: RektrsTranslationService,
    private _replies: RektrsInboxReplyGateway
  ) {}

  // ── Settings (brand-level; MANAGER configures) ────────────────────────────
  async getInboxSettings(
    orgId: string,
    brandId: string
  ): Promise<RektrsInboxSettingsView> {
    const brand = await this._requireBrand(orgId, brandId);
    const row = await this._repository.inboxSettingsByBrand(orgId, brand.id);
    if (!row) {
      return {
        brandId: brand.id,
        enabled: false,
        workingLanguage: 'en',
        faqPrice: '',
        faqTiming: '',
        faqLocation: '',
        faqDelivery: '',
        extraComplaintKeywords: [],
        version: null,
      };
    }
    return this.settingsView(row);
  }

  async updateInboxSettings(
    orgId: string,
    actor: RektrsActor,
    brandId: string,
    dto: UpdateInboxSettingsDto,
    ifMatch?: number
  ): Promise<RektrsInboxSettingsView> {
    await this._roles.assertFunction(orgId, actor, 'MANAGER');
    const brand = await this._requireBrand(orgId, brandId);
    const existing = await this._repository.inboxSettingsByBrand(
      orgId,
      brand.id
    );
    if (existing && ifMatch !== undefined && ifMatch !== existing.version) {
      throw rektrsError.conflict(
        'VERSION_CONFLICT',
        'The inbox triage settings changed since they were loaded; reload and retry'
      );
    }
    const data = {
      enabled: dto.enabled ?? existing?.enabled ?? false,
      workingLanguage:
        dto.workingLanguage ?? existing?.workingLanguage ?? 'en',
      faqPrice: dto.faqPrice ?? existing?.faqPrice ?? '',
      faqTiming: dto.faqTiming ?? existing?.faqTiming ?? '',
      faqLocation: dto.faqLocation ?? existing?.faqLocation ?? '',
      faqDelivery: dto.faqDelivery ?? existing?.faqDelivery ?? '',
      extraComplaintKeywords: normalizePhraseList(
        dto.extraComplaintKeywords ?? existing?.extraComplaintKeywords ?? []
      ),
    };
    const saved = await this._repository.transaction(async (tx) => {
      const row = existing
        ? await this._repository.db(tx).inboxSettings.update({
            where: { id: existing.id },
            data: { ...data, version: { increment: 1 } },
          })
        : await this._repository.db(tx).inboxSettings.create({
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
          action: 'inbox_settings.update',
          entityType: 'InboxSettings',
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

  // ── Triage (the W1 ingestion hook; NEVER throws) ──────────────────────────
  /**
   * One inbound comment → at most one inbox item. Called by the W1 lead
   * engine for every claimed comment on a brand channel (both ingestion
   * sources), so triage behaviour is identical for poll and webhook.
   * Failures are logged, never propagated — ingestion must survive them.
   */
  async triageInboundComment(
    orgId: string,
    brand: Brand,
    integration: Integration,
    input: RektrsInboundComment
  ): Promise<{ outcome: RektrsTriageOutcome }> {
    try {
      return await this.triageInner(orgId, brand, integration, input);
    } catch (e) {
      this._logger.warn(
        `REKTRS W6 triage failed (brand ${brand.id}, comment ${input.commentId}): ${String(e)}`
      );
      return { outcome: 'skipped' };
    }
  }

  private async triageInner(
    orgId: string,
    brand: Brand,
    integration: Integration,
    input: RektrsInboundComment
  ): Promise<{ outcome: RektrsTriageOutcome }> {
    if (brand.pausedAt || brand.deletedAt) {
      return { outcome: 'paused' };
    }
    const settings = await this._repository.inboxSettingsByBrand(
      orgId,
      brand.id
    );
    if (!settings || !settings.enabled) {
      return { outcome: 'disabled' };
    }

    const detectedLanguage = detectInboxLanguage(input.text);
    const translation = await this._translation.translateIfNeeded(
      input.text,
      detectedLanguage,
      settings.workingLanguage
    );
    const classification = classifyInboxText(
      input.text,
      settings.extraComplaintKeywords
    );

    let status: RektrsInboxStatus = 'NEW';
    let suggestedReply: string | null = null;
    if (classification.category === 'COMPLAINT') {
      status = 'QUEUED';
    } else if (classification.faqTopic) {
      const template = settings[faqTemplateField(classification.faqTopic)];
      if (template && template.trim()) {
        suggestedReply = renderInboxFaqTemplate(template, {
          brandName: brand.name,
          name: input.commenterName,
        });
        status = 'DRAFTED';
      }
    }

    const internalPost = await this._repository.db().post.findFirst({
      where: {
        integrationId: integration.id,
        releaseId: input.providerPostId,
        parentPostId: null,
      },
      orderBy: { publishDate: 'desc' },
    });

    const notes: string[] = [];
    const capability = this._replies.capabilityNote(integration);
    if (capability) {
      notes.push(capability);
    }
    if (translation.status === 'UNAVAILABLE') {
      notes.push(
        'Translation is not configured on this server — showing the original text.'
      );
    } else if (translation.status === 'FAILED') {
      notes.push('Translation failed — showing the original text.');
    }

    let item: InboxItem;
    try {
      item = await this._repository.db().inboxItem.create({
        data: {
          organizationId: orgId,
          brandId: brand.id,
          integrationId: integration.id,
          providerIdentifier: integration.providerIdentifier,
          postId: internalPost?.id ?? null,
          providerPostId: input.providerPostId,
          providerCommentId: input.commentId,
          authorId: input.commenterId,
          authorName: input.commenterName ?? null,
          originalText: input.text,
          detectedLanguage,
          translatedText: translation.text,
          translationStatus: translation.status,
          category: classification.category,
          matchedPhrase: classification.phrase,
          status,
          suggestedReply,
          note: notes.length ? notes.join(' ') : null,
          commentAt: input.commentAt ?? null,
        },
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        return { outcome: 'duplicate' };
      }
      throw e;
    }

    await this._audit.write(orgId, systemActor, {
      action: 'inbox.item_triaged',
      entityType: 'InboxItem',
      entityId: item.id,
      metadata: {
        brandName: brand.name,
        category: item.category,
        status: item.status,
        detectedLanguage,
        translationStatus: translation.status,
        matchedPhrase: classification.phrase,
      },
    });

    if (classification.category === 'COMPLAINT') {
      await this.safeComplaintAlert(orgId, item, brand.name);
    }
    return { outcome: 'triaged' };
  }

  private async safeComplaintAlert(
    orgId: string,
    item: InboxItem,
    brandName: string
  ): Promise<void> {
    try {
      await this._alerts.alertInboxComplaint(orgId, {
        itemId: item.id,
        brandId: item.brandId,
        authorName: item.authorName,
        matchedPhrase: item.matchedPhrase,
        excerpt: item.originalText,
      });
      await this._audit.write(orgId, systemActor, {
        action: 'inbox.complaint_alert',
        entityType: 'InboxItem',
        entityId: item.id,
        metadata: { brandName, matchedPhrase: item.matchedPhrase },
      });
    } catch (e) {
      this._logger.warn(
        `REKTRS W6 complaint alert failed for inbox item ${item.id}: ${String(e)}`
      );
    }
  }

  // ── Queries ───────────────────────────────────────────────────────────────
  async listBrandItems(
    orgId: string,
    brandId: string,
    query: ListInboxItemsQueryDto
  ) {
    const brand = await this._requireBrand(orgId, brandId);
    return this._repository.inboxItemsOfBrand(orgId, brand.id, {
      status: query.status,
      category: query.category,
      take: query.take,
    });
  }

  listOrgItems(orgId: string, query: ListInboxItemsQueryDto) {
    return this._repository.inboxItemsOfOrg(orgId, {
      status: query.status,
      category: query.category,
      brandId: query.brandId,
      take: query.take,
    });
  }

  countQueued(orgId: string) {
    return this._repository.db().inboxItem.count({
      where: { organizationId: orgId, status: 'QUEUED' },
    });
  }

  // ── Human actions ─────────────────────────────────────────────────────────
  /**
   * The one-tap send: a human posts the item's drafted FAQ reply (or
   * their edit of it) through the provider. The ONLY provider write in
   * W6, and it is never automatic. Failures are recorded on the item
   * (sendError) and surfaced — the item stays DRAFTED so the human can
   * retry or answer on the platform.
   */
  async sendReply(
    orgId: string,
    actor: RektrsActor,
    brandId: string,
    itemId: string,
    dto?: SendInboxReplyDto
  ): Promise<InboxItem> {
    await this.assertQueueWorker(orgId, actor);
    const brand = await this._requireBrand(orgId, brandId);
    if (brand.pausedAt) {
      throw rektrsError.conflict(
        'BRAND_PAUSED',
        'This brand is paused (crisis kill-switch). Resume it before sending replies'
      );
    }
    const item = await this._requireItem(orgId, brand.id, itemId);
    if (item.status === 'SENT') {
      throw rektrsError.conflict(
        'INBOX_ITEM_ALREADY_SENT',
        'This reply was already sent'
      );
    }
    if (item.status === 'DISMISSED') {
      throw rektrsError.conflict(
        'INBOX_ITEM_DISMISSED',
        'This item was dismissed; it cannot be sent'
      );
    }
    if (item.status !== 'DRAFTED') {
      throw rektrsError.conflict(
        'INBOX_ITEM_NOT_SENDABLE',
        'Only a drafted FAQ reply can be sent from here — complaints and general comments are answered on the platform in v1'
      );
    }
    const text = (dto?.text ?? item.suggestedReply ?? '').trim();
    if (!text) {
      throw rektrsError.unprocessable(
        'INBOX_REPLY_EMPTY',
        'The reply text is empty'
      );
    }
    const integration = await this._repository.integrationById(
      orgId,
      item.integrationId
    );
    if (!integration) {
      throw rektrsError.notFound(
        'CHANNEL_NOT_FOUND',
        'The channel this comment came from no longer exists'
      );
    }
    if (!this._replies.supportsReply(integration)) {
      const error = `Provider ${integration.providerIdentifier} cannot post replies`;
      await this.recordSendError(orgId, actor, item, error);
      throw rektrsError.unprocessable('INBOX_REPLY_UNSUPPORTED', error);
    }
    const post = item.postId
      ? await this._repository.postById(orgId, item.postId)
      : null;
    if (!post) {
      const error =
        'The original post is not mapped to a local post, so the reply cannot be posted from here';
      await this.recordSendError(orgId, actor, item, error);
      throw rektrsError.unprocessable('INBOX_POST_NOT_RESOLVED', error);
    }

    let posted: { commentId: string; releaseURL?: string };
    try {
      posted = await this._replies.postReply(
        orgId,
        integration,
        post,
        item.providerCommentId,
        text
      );
    } catch (e) {
      const error = errorText(e);
      await this.recordSendError(orgId, actor, item, error);
      throw rektrsError.unprocessable(
        'INBOX_REPLY_FAILED',
        `The provider refused the reply: ${error}`
      );
    }

    return this._repository.transaction(async (tx) => {
      const updated = await this._repository.db(tx).inboxItem.update({
        where: { id: item.id },
        data: {
          status: 'SENT',
          sentText: text,
          replyCommentId: posted.commentId,
          sendError: null,
          sentAt: new Date(),
          sentById: actor.userId,
          version: { increment: 1 },
        },
      });
      await this._audit.write(
        orgId,
        actor,
        {
          action: 'inbox.item_sent',
          entityType: 'InboxItem',
          entityId: item.id,
          metadata: {
            brandName: brand.name,
            replyCommentId: posted.commentId,
            edited: text !== (item.suggestedReply ?? '').trim(),
          },
        },
        tx
      );
      return updated;
    });
  }

  /** Dismiss closes an item without any provider write. SENT items are
   *  final; dismissing an already-dismissed item is a no-op success. */
  async dismissItem(
    orgId: string,
    actor: RektrsActor,
    brandId: string,
    itemId: string
  ): Promise<InboxItem> {
    await this.assertQueueWorker(orgId, actor);
    const brand = await this._requireBrand(orgId, brandId);
    const item = await this._requireItem(orgId, brand.id, itemId);
    if (item.status === 'SENT') {
      throw rektrsError.conflict(
        'INBOX_ITEM_ALREADY_SENT',
        'A sent reply cannot be dismissed'
      );
    }
    if (item.status === 'DISMISSED') {
      return item;
    }
    return this._repository.transaction(async (tx) => {
      const updated = await this._repository.db(tx).inboxItem.update({
        where: { id: item.id },
        data: {
          status: 'DISMISSED',
          dismissedById: actor.userId,
          dismissedAt: new Date(),
          version: { increment: 1 },
        },
      });
      await this._audit.write(
        orgId,
        actor,
        {
          action: 'inbox.item_dismissed',
          entityType: 'InboxItem',
          entityId: item.id,
          metadata: { brandName: brand.name, fromStatus: item.status },
        },
        tx
      );
      return updated;
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  private async recordSendError(
    orgId: string,
    actor: RektrsActor,
    item: InboxItem,
    error: string
  ): Promise<void> {
    await this._repository.db().inboxItem.update({
      where: { id: item.id },
      data: { sendError: error, version: { increment: 1 } },
    });
    await this._audit.write(orgId, actor, {
      action: 'inbox.item_send_failed',
      entityType: 'InboxItem',
      entityId: item.id,
      metadata: { error },
    });
  }

  private async assertQueueWorker(orgId: string, actor: RektrsActor) {
    const functions = actor.userId
      ? await this._roles.getFunctions(orgId, actor.userId)
      : [];
    if (
      !functions.some((f) =>
        (QUEUE_WORKER_FUNCTIONS as readonly string[]).includes(f)
      )
    ) {
      throw rektrsError.forbidden(
        'REKTRS_FUNCTION_REQUIRED',
        'A MANAGER, CREATOR or ANALYST function is required for this action'
      );
    }
  }

  private async _requireBrand(orgId: string, brandId: string) {
    const brand = await this._repository.brandById(orgId, brandId);
    if (!brand) {
      throw rektrsError.notFound('BRAND_NOT_FOUND', 'Brand not found');
    }
    return brand;
  }

  private async _requireItem(orgId: string, brandId: string, itemId: string) {
    const item = await this._repository.inboxItemById(orgId, brandId, itemId);
    if (!item) {
      throw rektrsError.notFound('INBOX_ITEM_NOT_FOUND', 'Inbox item not found');
    }
    return item;
  }

  private settingsView(row: InboxSettings): RektrsInboxSettingsView {
    return {
      brandId: row.brandId,
      enabled: row.enabled,
      workingLanguage: row.workingLanguage,
      faqPrice: row.faqPrice,
      faqTiming: row.faqTiming,
      faqLocation: row.faqLocation,
      faqDelivery: row.faqDelivery,
      extraComplaintKeywords: row.extraComplaintKeywords,
      version: row.version,
    };
  }
}
