import { Injectable, Logger } from '@nestjs/common';
import { Integration, Lead, LeadRule, Prisma } from '@prisma/client';
import { RektrsRepository } from './rektrs.repository';
import { RektrsAuditService } from './rektrs.audit.service';
import { RektrsRolesService } from './rektrs.roles.service';
import { RektrsAlertsService } from './rektrs.alerts.service';
import { RektrsActor, systemActor } from './rektrs.actor';
import { rektrsError } from './rektrs.errors';
import { UpdateLeadRuleDto } from '@gitroom/nestjs-libraries/dtos/rektrs/rektrs.dto';
import {
  matchLeadComment,
  normalizePhraseList,
  renderLeadDmTemplate,
  signLeadWebhookPayload,
  REKTRS_LEAD_WEBHOOK_MAX_ATTEMPTS,
} from './rektrs.leads';
import {
  RektrsCommentGateway,
  RektrsInboundComment,
} from './rektrs.lead-providers';
import { getSsrfSafeDispatcher } from '@gitroom/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher';
import { isSafePublicHttpsUrl } from '@gitroom/nestjs-libraries/dtos/webhooks/webhook.url.validator';

/**
 * REKTRS W1 — Comment-to-DM Lead Machine (AUTOMATION-WORKFLOWS.md W1).
 *
 * Trigger truth: upstream Postiz has NO inbound provider-comment ingestion
 * (its Comments model is internal review comments) and NO DM send path.
 * W1 adds both Meta primitives (SocialProviderComments on the Facebook /
 * Instagram providers) and two ingestion sources that feed ONE engine
 * (processInboundComment), so behaviour is identical either way:
 *   1. the Meta webhook receiver (backend) — real-time when the Meta app
 *      is subscribed; signature-verified, fail-closed when unconfigured;
 *   2. the hourly poller (syncLeadComments, via the orchestrator) — reads
 *      comments on recently published posts of W1-enabled brand channels.
 * `instagram-standalone` (Instagram Login API) intentionally does NOT
 * implement the primitives in this drop: its messaging surface differs and
 * W1 ships on the two Business-login providers. Documented, not silent.
 *
 * Invariants (the brief's honesty rules):
 *  - a failed DM NEVER breaks ingestion and NEVER produces a lead that
 *    claims a DM was sent (status DM_FAILED + the provider error);
 *  - guard words beat keywords, always — the comment goes to the
 *    human-review queue, no DM, no CRM push;
 *  - at most one DM+lead per commenter per post (service check + the
 *    partial unique index rektrs_leads_dm_dedupe_key);
 *  - the CRM endpoint is an ORG SETTING (URL + signing secret), never
 *    hardcoded; the secret is write-only in the API and never audited;
 *  - every state change is audited.
 *
 * Status semantics: DM_PENDING (created, DM in flight) → DM_SENT (DM
 * delivered; no CRM webhook enabled for the org — nothing owed) |
 * DM_FAILED (provider refused; retryable from the UI) | WEBHOOK_PENDING
 * (DM delivered; CRM delivery outstanding, the sweep retries) →
 * COMPLETE (DM + CRM delivered) | WEBHOOK_FAILED (attempts exhausted).
 * HUMAN_REVIEW → HANDLED (a person closed it).
 */

export type RektrsLeadOutcome =
  | 'seen'
  | 'no_rule'
  | 'no_match'
  | 'guard'
  | 'duplicate'
  | 'dm_failed'
  | 'lead'
  | 'error';

export interface RektrsLeadRuleView {
  brandId: string;
  enabled: boolean;
  keywords: string[];
  dmTemplate: string;
  guardWords: string[];
  useDefaultGuardWords: boolean;
  version: number | null;
}

const POLL_WINDOW_DAYS = 7;
const WEBHOOK_TIMEOUT_MS = 10_000;

function isUniqueViolation(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
  );
}

function shortError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  return message.slice(0, 500);
}

@Injectable()
export class RektrsLeadsService {
  private readonly _logger = new Logger(RektrsLeadsService.name);

  constructor(
    private _repository: RektrsRepository,
    private _audit: RektrsAuditService,
    private _roles: RektrsRolesService,
    private _alerts: RektrsAlertsService,
    private _gateway: RektrsCommentGateway
  ) {}

  // ── Rule settings (brand-level; MANAGER configures) ───────────────────────
  async getLeadRule(orgId: string, brandId: string): Promise<RektrsLeadRuleView> {
    const brand = await this._requireBrand(orgId, brandId);
    const rule = await this._repository.leadRuleByBrand(orgId, brand.id);
    if (!rule) {
      return {
        brandId: brand.id,
        enabled: false,
        keywords: [],
        dmTemplate: '',
        guardWords: [],
        useDefaultGuardWords: true,
        version: null,
      };
    }
    return this.ruleView(rule);
  }

  async updateLeadRule(
    orgId: string,
    actor: RektrsActor,
    brandId: string,
    dto: UpdateLeadRuleDto,
    ifMatch?: number
  ): Promise<RektrsLeadRuleView> {
    await this._roles.assertFunction(orgId, actor, 'MANAGER');
    const brand = await this._requireBrand(orgId, brandId);
    const existing = await this._repository.leadRuleByBrand(orgId, brand.id);
    if (
      existing &&
      ifMatch !== undefined &&
      ifMatch !== existing.version
    ) {
      throw rektrsError.conflict(
        'VERSION_CONFLICT',
        'The lead rule changed since it was loaded; reload and retry'
      );
    }
    const data = {
      enabled: dto.enabled ?? existing?.enabled ?? false,
      keywords: normalizePhraseList(dto.keywords ?? existing?.keywords ?? []),
      dmTemplate: dto.dmTemplate ?? existing?.dmTemplate ?? '',
      guardWords: normalizePhraseList(
        dto.guardWords ?? existing?.guardWords ?? []
      ),
      useDefaultGuardWords:
        dto.useDefaultGuardWords ?? existing?.useDefaultGuardWords ?? true,
    };
    if (data.enabled && !data.keywords.length) {
      throw rektrsError.unprocessable(
        'LEAD_RULE_KEYWORDS_REQUIRED',
        'Add at least one keyword before enabling the lead machine'
      );
    }
    if (data.enabled && !data.dmTemplate.trim()) {
      throw rektrsError.unprocessable(
        'LEAD_RULE_TEMPLATE_REQUIRED',
        'Write the DM template before enabling the lead machine'
      );
    }
    const saved = await this._repository.transaction(async (tx) => {
      const row = existing
        ? await this._repository.db(tx).leadRule.update({
            where: { id: existing.id },
            data: { ...data, version: { increment: 1 } },
          })
        : await this._repository.db(tx).leadRule.create({
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
          action: 'lead_rule.update',
          entityType: 'LeadRule',
          entityId: row.id,
          metadata: { brandName: brand.name, before: existing ? this.ruleView(existing) : null, after: this.ruleView(row) },
        },
        tx
      );
      return row;
    });
    return this.ruleView(saved);
  }

  // ── Lead queries + human queue actions ────────────────────────────────────
  listLeads(
    orgId: string,
    filters: { status?: Lead['status']; brandId?: string; take?: number }
  ) {
    return this._repository.leadsOfOrg(orgId, filters);
  }

  countLeads(orgId: string, status: Lead['status']) {
    return this._repository.db().lead.count({
      where: { organizationId: orgId, status },
    });
  }

  /** Human-review queue close-out: MANAGER / CREATOR / ANALYST. */
  async markHandled(orgId: string, actor: RektrsActor, leadId: string) {
    const functions = actor.userId
      ? await this._roles.getFunctions(orgId, actor.userId)
      : [];
    if (
      !functions.some((f) => ['MANAGER', 'CREATOR', 'ANALYST'].includes(f))
    ) {
      throw rektrsError.forbidden(
        'REKTRS_FUNCTION_REQUIRED',
        'A MANAGER, CREATOR or ANALYST function is required for this action'
      );
    }
    const lead = await this._requireLead(orgId, leadId);
    if (lead.status !== 'HUMAN_REVIEW') {
      throw rektrsError.conflict(
        'LEAD_NOT_ACTIONABLE',
        'Only human-review leads can be marked handled'
      );
    }
    return this._repository.transaction(async (tx) => {
      const updated = await this._repository.db(tx).lead.update({
        where: { id: lead.id },
        data: {
          status: 'HANDLED',
          handledById: actor.userId,
          handledAt: new Date(),
          version: { increment: 1 },
        },
      });
      await this._audit.write(
        orgId,
        actor,
        {
          action: 'lead.handled',
          entityType: 'Lead',
          entityId: lead.id,
          metadata: { guardWord: lead.matchedGuardWord },
        },
        tx
      );
      return updated;
    });
  }

  /** Manual retry from the leads screen: re-runs the DM (if it failed) or
   *  the CRM delivery (if the webhook side is outstanding). MANAGER only. */
  async retryLead(orgId: string, actor: RektrsActor, leadId: string) {
    await this._roles.assertFunction(orgId, actor, 'MANAGER');
    const lead = await this._requireLead(orgId, leadId);
    if (
      !['DM_FAILED', 'WEBHOOK_PENDING', 'WEBHOOK_FAILED', 'DM_SENT'].includes(
        lead.status
      )
    ) {
      throw rektrsError.conflict(
        'LEAD_NOT_ACTIONABLE',
        `A lead in status ${lead.status} has nothing to retry`
      );
    }
    await this._audit.write(orgId, actor, {
      action: 'lead.retry',
      entityType: 'Lead',
      entityId: lead.id,
      metadata: { fromStatus: lead.status },
    });

    let current = lead;
    if (current.status === 'DM_FAILED') {
      const integration = await this._repository.db().integration.findFirst({
        where: { id: current.integrationId, organizationId: orgId },
      });
      if (!integration) {
        throw rektrsError.notFound(
          'CHANNEL_NOT_FOUND',
          'The channel this lead came from no longer exists'
        );
      }
      const rule = await this._repository.leadRuleByBrand(orgId, current.brandId);
      const resent = await this.trySendDm(orgId, integration, current, rule);
      if (!resent) {
        return this._requireLead(orgId, leadId);
      }
      current = await this._requireLead(orgId, leadId);
    }
    if (current.status === 'DM_SENT' || current.status.startsWith('WEBHOOK')) {
      // A manual retry restarts the delivery budget.
      if (current.status === 'WEBHOOK_FAILED') {
        current = await this._repository.db().lead.update({
          where: { id: current.id },
          data: { webhookAttempts: 0, status: 'WEBHOOK_PENDING' },
        });
      }
      await this.deliverLeadWebhook(orgId, current);
    }
    return this._requireLead(orgId, leadId);
  }

  // ── CRM webhook (org setting; signed; bounded retries) ────────────────────
  async buildLeadWebhookPayload(orgId: string, lead: Lead) {
    const brand = await this._repository.brandById(orgId, lead.brandId);
    return {
      event: 'lead.created',
      leadId: lead.id,
      brand: { id: lead.brandId, name: brand?.name || null },
      platform: lead.providerIdentifier,
      postId: lead.postId,
      providerPostId: lead.providerPostId,
      commenter: { id: lead.commenterId, name: lead.commenterName },
      comment: {
        id: lead.commentId,
        text: lead.commentText,
        at: (lead.commentAt || lead.createdAt).toISOString(),
      },
      keywordMatched: lead.matchedKeyword,
      occurredAt: new Date().toISOString(),
    };
  }

  /**
   * One signed delivery attempt. Updates the lead's webhook state and
   * returns the outcome; NEVER throws — a dead CRM must not break lead
   * capture. Attempts are counted only for real HTTP tries; a missing
   * secret/URL is a configuration state, retried by the sweep once the
   * org fixes its settings.
   */
  async deliverLeadWebhook(
    orgId: string,
    lead: Lead
  ): Promise<{ delivered: boolean; attempted: boolean; error?: string }> {
    try {
      const config = await this._roles.getCrmWebhookConfig(orgId);
      if (!config.enabled || !config.url) {
        return { delivered: false, attempted: false, error: 'CRM webhook not enabled for this org' };
      }
      if (!config.secret) {
        await this.markWebhookState(lead, 'WEBHOOK_PENDING', 'CRM webhook signing secret is not set');
        return { delivered: false, attempted: false, error: 'CRM webhook signing secret is not set' };
      }
      if (!(await isSafePublicHttpsUrl(config.url))) {
        await this.markWebhookState(lead, 'WEBHOOK_PENDING', 'CRM webhook URL is not a safe public HTTPS URL');
        return { delivered: false, attempted: false, error: 'CRM webhook URL unsafe' };
      }
      const payload = await this.buildLeadWebhookPayload(orgId, lead);
      const body = JSON.stringify(payload);
      const timestamp = Math.floor(Date.now() / 1000);
      const attempts = lead.webhookAttempts + 1;
      let delivered = false;
      let error: string | undefined;
      try {
        const response = await fetch(config.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Rektrs-Event': 'lead.created',
            'X-Rektrs-Signature': signLeadWebhookPayload(config.secret, timestamp, body),
          },
          body,
          // @ts-ignore - undici-only option, not in the lib.dom RequestInit type
          dispatcher: getSsrfSafeDispatcher(),
          signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        });
        delivered = response.status >= 200 && response.status < 300;
        if (!delivered) {
          error = `CRM webhook answered HTTP ${response.status}`;
        }
      } catch (e) {
        error = shortError(e);
      }
      const status = delivered
        ? 'COMPLETE'
        : attempts >= REKTRS_LEAD_WEBHOOK_MAX_ATTEMPTS
          ? 'WEBHOOK_FAILED'
          : 'WEBHOOK_PENDING';
      await this._repository.db().lead.update({
        where: { id: lead.id },
        data: {
          status,
          webhookAttempts: attempts,
          webhookError: delivered ? null : error,
          webhookDeliveredAt: delivered ? new Date() : lead.webhookDeliveredAt,
        },
      });
      await this._audit.write(orgId, systemActor, {
        action: delivered ? 'lead.webhook_delivered' : 'lead.webhook_failed',
        entityType: 'Lead',
        entityId: lead.id,
        metadata: { attempts, ...(error ? { error } : {}) },
      });
      return { delivered, attempted: true, ...(error ? { error } : {}) };
    } catch (e) {
      this._logger.warn(
        `REKTRS W1 webhook delivery for lead ${lead.id} failed unexpectedly: ${String(e)}`
      );
      return { delivered: false, attempted: false, error: shortError(e) };
    }
  }

  private async markWebhookState(
    lead: Lead,
    status: 'WEBHOOK_PENDING',
    error: string
  ): Promise<void> {
    await this._repository.db().lead.update({
      where: { id: lead.id },
      data: { status, webhookError: error },
    });
  }

  /** Settings-screen test button: one signed ping, result reported as-is. */
  async testCrmWebhook(orgId: string, actor: RektrsActor) {
    await this._roles.assertFunction(orgId, actor, 'MANAGER');
    const config = await this._roles.getCrmWebhookConfig(orgId);
    if (!config.url) {
      throw rektrsError.unprocessable(
        'CRM_WEBHOOK_NOT_CONFIGURED',
        'Save a CRM webhook URL before sending a test ping'
      );
    }
    if (!(await isSafePublicHttpsUrl(config.url))) {
      throw rektrsError.unprocessable(
        'CRM_WEBHOOK_URL_UNSAFE',
        'The CRM webhook URL must be a public HTTPS URL'
      );
    }
    const body = JSON.stringify({
      event: 'lead.test',
      test: true,
      occurredAt: new Date().toISOString(),
    });
    const timestamp = Math.floor(Date.now() / 1000);
    let result: { ok: boolean; status?: number; error?: string };
    try {
      const response = await fetch(config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Rektrs-Event': 'lead.test',
          ...(config.secret
            ? {
                'X-Rektrs-Signature': signLeadWebhookPayload(
                  config.secret,
                  timestamp,
                  body
                ),
              }
            : {}),
        },
        body,
        // @ts-ignore - undici-only option, not in the lib.dom RequestInit type
        dispatcher: getSsrfSafeDispatcher(),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      result = {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
      };
    } catch (e) {
      result = { ok: false, error: shortError(e) };
    }
    await this._audit.write(orgId, actor, {
      action: 'org.crm_webhook_test',
      entityType: 'Policy',
      entityId: orgId,
      metadata: { ok: result.ok, ...(result.status ? { status: result.status } : {}) },
    });
    return result;
  }

  // ── The engine ────────────────────────────────────────────────────────────
  /**
   * One inbound comment → at most one outcome. NEVER throws: ingestion
   * (webhook receiver or poller) must survive every failure this feature
   * can produce; failures are recorded on the lead / in the log instead.
   */
  async processInboundComment(
    orgId: string,
    integration: Integration,
    input: RektrsInboundComment
  ): Promise<{ outcome: RektrsLeadOutcome }> {
    try {
      return await this.processInboundCommentInner(orgId, integration, input);
    } catch (e) {
      this._logger.warn(
        `REKTRS W1 comment processing failed (integration ${integration.id}, comment ${input.commentId}): ${String(e)}`
      );
      return { outcome: 'error' };
    }
  }

  private async processInboundCommentInner(
    orgId: string,
    integration: Integration,
    input: RektrsInboundComment
  ): Promise<{ outcome: RektrsLeadOutcome }> {
    // 1) Ingestion dedupe — the same comment can arrive by webhook AND by
    //    the poller; the first claim wins.
    try {
      await this._repository.db().leadCommentSeen.create({
        data: { integrationId: integration.id, commentId: input.commentId },
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        return { outcome: 'seen' };
      }
      throw e;
    }

    // 1b) Never automate on the channel's OWN comments (the brand's first
    //     comment would otherwise DM itself and spam the CRM).
    if (
      input.commenterId &&
      integration.internalId &&
      input.commenterId === integration.internalId
    ) {
      return { outcome: 'no_match' };
    }

    // 2) Brand + rule resolution. Channels not claimed by a brand, paused
    //    brands (W5) and disabled/empty rules are all a quiet no-op.
    const link = await this._repository.brandIntegrationByIntegration(
      integration.id
    );
    if (!link || link.brand.organizationId !== orgId || link.brand.deletedAt) {
      return { outcome: 'no_rule' };
    }
    if (link.brand.pausedAt) {
      return { outcome: 'no_rule' };
    }
    const rule = await this._repository.leadRuleByBrand(orgId, link.brand.id);
    if (!rule || !rule.enabled || !rule.dmTemplate.trim()) {
      return { outcome: 'no_rule' };
    }

    // 3) Match — guard words first, they always win.
    const match = matchLeadComment(input.text, rule);
    if (match.kind === 'none') {
      return { outcome: 'no_match' };
    }

    const internalPost = await this._repository
      .db()
      .post.findFirst({
        where: {
          integrationId: integration.id,
          releaseId: input.providerPostId,
          parentPostId: null,
        },
        orderBy: { publishDate: 'desc' },
      });

    if (match.kind === 'guard') {
      const lead = await this._repository.db().lead.create({
        data: {
          organizationId: orgId,
          brandId: link.brand.id,
          ruleId: rule.id,
          integrationId: integration.id,
          providerIdentifier: integration.providerIdentifier,
          postId: internalPost?.id ?? null,
          providerPostId: input.providerPostId,
          commentId: input.commentId,
          commenterId: input.commenterId,
          commenterName: input.commenterName ?? null,
          commentText: input.text,
          commentAt: input.commentAt ?? null,
          matchedGuardWord: match.phrase,
          status: 'HUMAN_REVIEW',
          enrichment: this.enrichLead(input),
        },
      });
      await this._audit.write(orgId, systemActor, {
        action: 'lead.human_review',
        entityType: 'Lead',
        entityId: lead.id,
        metadata: { brandName: link.brand.name, guardWord: match.phrase },
      });
      await this.safeAlert(orgId, lead, link.brand.name, true);
      return { outcome: 'guard' };
    }

    // 4) Per-commenter-per-post dedupe (any prior lead for the tuple —
    //    including a human-review one — keeps the slot).
    const existing = await this._repository.leadForCommenterPost(
      rule.id,
      input.providerPostId,
      input.commenterId
    );
    if (existing) {
      return { outcome: 'duplicate' };
    }

    // 5) Create in DM_PENDING (honest: the DM has not been sent yet), then
    //    attempt the DM through the provider boundary.
    let lead: Lead;
    try {
      lead = await this._repository.db().lead.create({
        data: {
          organizationId: orgId,
          brandId: link.brand.id,
          ruleId: rule.id,
          integrationId: integration.id,
          providerIdentifier: integration.providerIdentifier,
          postId: internalPost?.id ?? null,
          providerPostId: input.providerPostId,
          commentId: input.commentId,
          commenterId: input.commenterId,
          commenterName: input.commenterName ?? null,
          commentText: input.text,
          commentAt: input.commentAt ?? null,
          matchedKeyword: match.phrase,
          status: 'DM_PENDING',
          enrichment: this.enrichLead(input),
        },
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        return { outcome: 'duplicate' };
      }
      throw e;
    }

    const sent = await this.trySendDm(orgId, integration, lead, rule, {
      keyword: match.phrase,
      link: internalPost?.releaseURL ?? null,
    });
    if (!sent) {
      return { outcome: 'dm_failed' };
    }
    lead = await this._requireLead(orgId, lead.id);
    await this.safeAlert(orgId, lead, link.brand.name, false);

    // 6) CRM push — only when the org enabled it; otherwise DM_SENT is the
    //    honest final state (nothing is owed).
    const config = await this._roles.getCrmWebhookConfig(orgId);
    if (config.enabled && config.url) {
      await this.deliverLeadWebhook(orgId, lead);
    }
    return { outcome: 'lead' };
  }

  /**
   * The DM attempt, shared by ingestion and manual retry. On success the
   * lead moves to DM_SENT with the provider message id; on failure it
   * moves to DM_FAILED with the provider's error. Returns success.
   */
  private async trySendDm(
    orgId: string,
    integration: Integration,
    lead: Lead,
    rule: LeadRule | null,
    vars?: { keyword?: string | null; link?: string | null }
  ): Promise<boolean> {
    const template = rule?.dmTemplate || '';
    const message = renderLeadDmTemplate(template, {
      name: lead.commenterName,
      keyword: vars?.keyword ?? lead.matchedKeyword,
      link: vars?.link ?? null,
    });
    try {
      const { messageId } = await this._gateway.sendPrivateReply(
        integration,
        lead.commentId,
        message
      );
      await this._repository.db().lead.update({
        where: { id: lead.id },
        data: {
          status: 'DM_SENT',
          dmMessageId: messageId ?? null,
          dmSentAt: new Date(),
          dmError: null,
        },
      });
      await this._audit.write(orgId, systemActor, {
        action: 'lead.created',
        entityType: 'Lead',
        entityId: lead.id,
        metadata: { keyword: lead.matchedKeyword, dmMessageId: messageId ?? null },
      });
      return true;
    } catch (e) {
      const error = shortError(e);
      await this._repository.db().lead.update({
        where: { id: lead.id },
        data: { status: 'DM_FAILED', dmError: error },
      });
      await this._audit.write(orgId, systemActor, {
        action: 'lead.dm_failed',
        entityType: 'Lead',
        entityId: lead.id,
        metadata: { error },
      });
      return false;
    }
  }

  /**
   * Enrichment seam (spec: "enrich the lead"): v1 stores exactly what the
   * comment payload already carries — no external lookups, no invented
   * data. A profile-enrichment provider can extend this object later
   * without touching the engine.
   */
  private enrichLead(input: RektrsInboundComment): Prisma.InputJsonValue {
    return {
      source: 'provider_comment',
      commenterId: input.commenterId,
      commenterName: input.commenterName ?? null,
      providerPostId: input.providerPostId,
      observedAt: new Date().toISOString(),
    };
  }

  private async safeAlert(
    orgId: string,
    lead: Lead,
    _brandName: string,
    humanReview: boolean
  ): Promise<void> {
    try {
      await this._alerts.alertNewLead(orgId, {
        id: lead.id,
        brandId: lead.brandId,
        commenterName: lead.commenterName,
        matchedKeyword: lead.matchedKeyword,
        matchedGuardWord: lead.matchedGuardWord,
        humanReview,
      });
    } catch (e) {
      this._logger.warn(
        `REKTRS W1 lead alert failed for lead ${lead.id}: ${String(e)}`
      );
    }
  }

  // ── Sweeps (orchestrator, cross-org BY DESIGN like the W2 sweep) ─────────
  /**
   * Poll sync: for every enabled rule, read comments on the brand
   * channels' recently published posts and feed the engine. Per-post
   * failures are isolated and counted, never fatal.
   */
  async syncLeadComments(now: Date = new Date()) {
    const since = new Date(
      now.getTime() - POLL_WINDOW_DAYS * 24 * 60 * 60 * 1000
    );
    const tallies = {
      rules: 0,
      posts: 0,
      comments: 0,
      leads: 0,
      guards: 0,
      dmFailed: 0,
      duplicates: 0,
      errors: 0,
    };
    const rules = await this._repository.enabledLeadRules();
    for (const rule of rules) {
      tallies.rules++;
      try {
        if (rule.brand.pausedAt || rule.brand.deletedAt) {
          continue;
        }
        const channels = rule.brand.channels.filter(
          (c) =>
            c.integration &&
            !c.integration.disabled &&
            !c.integration.deletedAt &&
            this._gateway.supports(c.integration)
        );
        if (!channels.length) {
          continue;
        }
        const posts = await this._repository.publishedPostsForChannels(
          rule.organizationId,
          channels.map((c) => c.integrationId),
          since
        );
        for (const post of posts) {
          tallies.posts++;
          const channel = channels.find(
            (c) => c.integrationId === post.integrationId
          );
          if (!channel || !post.releaseId) {
            continue;
          }
          let comments: RektrsInboundComment[];
          try {
            comments = await this._gateway.fetchPostComments(
              channel.integration,
              post.releaseId
            );
          } catch (e) {
            tallies.errors++;
            this._logger.warn(
              `REKTRS W1 comment fetch failed (integration ${channel.integrationId}, post ${post.releaseId}): ${String(e)}`
            );
            continue;
          }
          for (const comment of comments) {
            tallies.comments++;
            const { outcome } = await this.processInboundComment(
              rule.organizationId,
              channel.integration,
              comment
            );
            if (outcome === 'lead') tallies.leads++;
            else if (outcome === 'guard') tallies.guards++;
            else if (outcome === 'dm_failed') tallies.dmFailed++;
            else if (outcome === 'duplicate' || outcome === 'seen') tallies.duplicates++;
            else if (outcome === 'error') tallies.errors++;
          }
        }
      } catch (e) {
        tallies.errors++;
        this._logger.warn(
          `REKTRS W1 sync failed for rule ${rule.id}: ${String(e)}`
        );
      }
    }
    return tallies;
  }

  /** Bounded webhook retries: at most REKTRS_LEAD_WEBHOOK_MAX_ATTEMPTS
   *  real HTTP attempts per lead, one per sweep tick, then WEBHOOK_FAILED. */
  async sweepLeadWebhooks() {
    const tallies = { attempted: 0, delivered: 0, failed: 0, skipped: 0 };
    const leads = await this._repository.leadsAwaitingWebhook(
      REKTRS_LEAD_WEBHOOK_MAX_ATTEMPTS
    );
    for (const lead of leads) {
      const config = await this._roles.getCrmWebhookConfig(lead.organizationId);
      if (!config.enabled || !config.url) {
        tallies.skipped++;
        continue;
      }
      const result = await this.deliverLeadWebhook(lead.organizationId, lead);
      if (result.attempted) {
        tallies.attempted++;
        if (result.delivered) {
          tallies.delivered++;
        } else {
          tallies.failed++;
        }
      } else {
        tallies.skipped++;
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

  private async _requireLead(orgId: string, leadId: string) {
    const lead = await this._repository.leadById(orgId, leadId);
    if (!lead) {
      throw rektrsError.notFound('LEAD_NOT_FOUND', 'Lead not found');
    }
    return lead;
  }

  private ruleView(rule: LeadRule): RektrsLeadRuleView {
    return {
      brandId: rule.brandId,
      enabled: rule.enabled,
      keywords: rule.keywords,
      dmTemplate: rule.dmTemplate,
      guardWords: rule.guardWords,
      useDefaultGuardWords: rule.useDefaultGuardWords,
      version: rule.version,
    };
  }
}
