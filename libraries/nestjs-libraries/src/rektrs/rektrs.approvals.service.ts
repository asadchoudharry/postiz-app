import { Injectable, Logger } from '@nestjs/common';
import { Approval, ContentVersion, Post, Prisma } from '@prisma/client';
import { RektrsDb, RektrsRepository } from './rektrs.repository';
import { RektrsAuditService } from './rektrs.audit.service';
import { RektrsRolesService } from './rektrs.roles.service';
import { RektrsActor, systemActor } from './rektrs.actor';
import { rektrsError } from './rektrs.errors';
import {
  buildVariantPayload,
  computeBatchHash,
  computeVariantHash,
} from './rektrs.hash';
import {
  actorKindCanDecide,
  assertTransition,
  checkMakerChecker,
  decisionToEvent,
  eventTypeForTransition,
  isExpired,
  RektrsApprovalStateName,
  RektrsDecisionName,
  RektrsStateError,
  RektrsTransitionEvent,
} from './rektrs.state';
import { NotificationService } from '@gitroom/nestjs-libraries/database/prisma/notifications/notification.service';

export interface RektrsScopeVerdict {
  scoped: boolean;
  brandId: string | null;
  approvalRequired: boolean;
  source: 'brand' | 'org' | 'none';
}

export interface RektrsGateVerdict {
  scoped: boolean;
  pass: boolean;
  reason?:
    | 'APPROVAL_REQUIRED'
    | 'APPROVAL_NOT_FOUND'
    | 'APPROVAL_EXPIRED'
    | 'HASH_MISMATCH'
    | 'POST_NOT_FOUND';
  approvalId?: string;
  state?: string;
  approvedHash?: string | null;
  liveHash?: string;
  invalidated?: boolean;
}

interface VariantSnapshot {
  integrationId: string;
  group: string;
  payload: ReturnType<typeof buildVariantPayload>;
  contentHash: string;
  creationMethod: Post['creationMethod'];
}

/**
 * REKTRS P3 — submissions, decisions, and the gate verification API
 * (design P3-1 §2, §3.2, §4). The gates themselves (PostsService Gate A,
 * orchestrator Gate B) are wired in a later slice; everything they need is
 * exposed here: resolveScopeForIntegration, verifyBatchForGate,
 * verifyVariantForPublish, invalidateApproval.
 */
@Injectable()
export class RektrsApprovalsService {
  private readonly _logger = new Logger(RektrsApprovalsService.name);

  constructor(
    private _repository: RektrsRepository,
    private _audit: RektrsAuditService,
    private _roles: RektrsRolesService,
    private _notifications: NotificationService
  ) {}

  // ── Snapshot building ─────────────────────────────────────────────────────
  /**
   * Group a batch's live Post rows into one canonical payload per channel
   * variant. If an integration's rows span several groups (possible after a
   * partial re-save), the group with the newest activity is the live variant.
   */
  buildVariantSnapshots(
    posts: Post[],
    providerByIntegration: Map<string, string>
  ): VariantSnapshot[] {
    const byIntegration = new Map<string, Post[]>();
    for (const post of posts) {
      const rows = byIntegration.get(post.integrationId) || [];
      rows.push(post);
      byIntegration.set(post.integrationId, rows);
    }
    const snapshots: VariantSnapshot[] = [];
    for (const [integrationId, rows] of byIntegration) {
      const byGroup = new Map<string, Post[]>();
      for (const row of rows) {
        const groupRows = byGroup.get(row.group) || [];
        groupRows.push(row);
        byGroup.set(row.group, groupRows);
      }
      let liveRows = rows;
      if (byGroup.size > 1) {
        let newest = -1;
        for (const groupRows of byGroup.values()) {
          const max = Math.max(
            ...groupRows.map((r) => new Date(r.updatedAt).getTime())
          );
          if (max > newest) {
            newest = max;
            liveRows = groupRows;
          }
        }
      }
      const payload = buildVariantPayload(
        integrationId,
        providerByIntegration.get(integrationId) || '',
        liveRows
      );
      snapshots.push({
        integrationId,
        group: liveRows[0]?.group || '',
        payload,
        contentHash: computeVariantHash(payload),
        creationMethod: liveRows[0]?.creationMethod || 'WEB',
      });
    }
    return snapshots.sort((a, b) =>
      a.integrationId < b.integrationId ? -1 : 1
    );
  }

  private async snapshotLiveBatch(orgId: string, batchId: string, tx?: RektrsDb) {
    const posts = await this._repository.postsOfBatch(orgId, batchId, tx);
    const integrations = await this._repository.integrationsByIds(
      orgId,
      [...new Set(posts.map((p) => p.integrationId))],
      tx
    );
    const providers = new Map(
      integrations.map((i) => [i.id, i.providerIdentifier])
    );
    const snapshots = this.buildVariantSnapshots(posts, providers);
    return { posts, snapshots };
  }

  private async persistSnapshotSet(
    tx: RektrsDb,
    orgId: string,
    approval: Approval,
    actor: RektrsActor,
    snapshots: VariantSnapshot[]
  ) {
    for (const snapshot of snapshots) {
      await this._repository.db(tx).contentVersion.create({
        data: {
          organizationId: orgId,
          approvalId: approval.id,
          integrationId: snapshot.integrationId,
          group: snapshot.group,
          versionNo: approval.round,
          payload: snapshot.payload as unknown as Prisma.InputJsonValue,
          contentHash: snapshot.contentHash,
          createdById: actor.userId as string,
          creationMethod: snapshot.creationMethod,
        },
      });
    }
  }

  private batchHashOfSet(batchId: string, versions: ContentVersion[]): string {
    return computeBatchHash(
      batchId,
      versions.map((v) => ({
        integrationId: v.integrationId,
        contentHash: v.contentHash,
      }))
    );
  }

  private async currentVersionSet(approval: Approval, tx?: RektrsDb) {
    const versions = await this._repository.versionsOfApproval(approval.id, tx);
    return versions.filter((v) => v.versionNo === approval.round);
  }

  // ── Submission lifecycle ──────────────────────────────────────────────────
  async createSubmission(
    orgId: string,
    actor: RektrsActor,
    input: { batchId: string; campaignId?: string }
  ) {
    const { posts, snapshots } = await this.snapshotLiveBatch(
      orgId,
      input.batchId
    );
    if (!posts.length) {
      throw rektrsError.notFound(
        'BATCH_NOT_FOUND',
        'No posts with this batchId exist in this organization'
      );
    }
    const integrationIds = [...new Set(posts.map((p) => p.integrationId))];
    const memberships =
      await this._repository.brandIntegrationsByIntegrationIds(integrationIds);
    const brandIds = [
      ...new Set(
        memberships
          .filter((m) => m.brand && !m.brand.deletedAt)
          .map((m) => m.brandId)
      ),
    ];
    if (!brandIds.length) {
      throw rektrsError.unprocessable(
        'BATCH_HAS_NO_BRAND',
        'The channels of this batch belong to no brand; assign them to a brand before submitting for approval'
      );
    }
    if (brandIds.length > 1) {
      throw rektrsError.unprocessable(
        'BATCH_SPANS_BRANDS',
        'A submission has exactly one governing brand, but this batch spans several'
      );
    }
    const brandId = brandIds[0];
    if (input.campaignId) {
      const campaign = await this._repository.campaignById(
        orgId,
        input.campaignId
      );
      if (!campaign) {
        throw rektrsError.notFound('CAMPAIGN_NOT_FOUND', 'Campaign not found');
      }
      if (campaign.brandId !== brandId) {
        throw rektrsError.unprocessable(
          'CAMPAIGN_BRAND_MISMATCH',
          'The campaign belongs to a different brand than this batch'
        );
      }
    }
    const open = await this._repository.openApprovalForBatch(orgId, input.batchId);
    if (open) {
      throw rektrsError.conflict(
        'APPROVAL_ALREADY_OPEN',
        'This batch already has a non-terminal submission'
      );
    }
    const approval = await this._repository.transaction(async (tx) => {
      const created = await this._repository.db(tx).approval.create({
        data: {
          organizationId: orgId,
          batchId: input.batchId,
          brandId,
          campaignId: input.campaignId,
          createdById: actor.userId as string,
        },
      });
      await this.persistSnapshotSet(tx, orgId, created, actor, snapshots);
      await this._audit.write(
        orgId,
        actor,
        {
          action: 'approval.create',
          entityType: 'Approval',
          entityId: created.id,
          afterHash: this.batchHashOfSet(
            input.batchId,
            snapshots.map((s) => ({
              integrationId: s.integrationId,
              contentHash: s.contentHash,
            })) as unknown as ContentVersion[]
          ),
          metadata: { batchId: input.batchId, brandId },
        },
        tx
      );
      return created;
    });
    return this.getSubmission(orgId, approval.id);
  }

  async submit(orgId: string, actor: RektrsActor, approvalId: string) {
    const approval = await this.mustGetApproval(orgId, approvalId);
    const fromState = approval.state;
    const isResubmit = fromState !== 'DRAFT';
    const event: RektrsTransitionEvent = isResubmit ? 'RESUBMIT' : 'SUBMIT';
    let target: RektrsApprovalStateName;
    try {
      target = assertTransition(fromState, event);
    } catch (e) {
      if (e instanceof RektrsStateError) {
        throw rektrsError.conflict(
          'APPROVAL_NOT_SUBMITTABLE',
          `A submission in state ${fromState} cannot be submitted`
        );
      }
      throw e;
    }
    const updated = await this._repository.transaction(async (tx) => {
      let round = approval.round;
      if (isResubmit) {
        // Re-snapshot the live posts as the new version set — except for an
        // EXPIRED approval whose content is unchanged (design §2.1: revival
        // re-verifies the same set, no new version needed).
        const { snapshots } = await this.snapshotLiveBatch(
          orgId,
          approval.batchId,
          tx
        );
        const liveHash = computeBatchHash(
          approval.batchId,
          snapshots.map((s) => ({
            integrationId: s.integrationId,
            contentHash: s.contentHash,
          }))
        );
        const currentSet = await this.currentVersionSet(approval, tx);
        const currentHash = this.batchHashOfSet(approval.batchId, currentSet);
        const unchanged = fromState === 'EXPIRED' && liveHash === currentHash;
        if (!unchanged) {
          round = approval.round + 1;
          await this.persistSnapshotSet(
            tx,
            orgId,
            { ...approval, round },
            actor,
            snapshots
          );
        }
      }
      const result = await this._repository.db(tx).approval.updateMany({
        where: { id: approvalId, organizationId: orgId, state: fromState, version: approval.version },
        data: {
          state: target,
          round,
          submittedById: actor.userId,
          submittedAt: new Date(),
          ...(isResubmit
            ? {
                decidedById: null,
                decidedAt: null,
                decision: null,
                approvedHash: null,
                expiresAt: null,
              }
            : {}),
          version: { increment: 1 },
        },
      });
      if (!result.count) {
        throw rektrsError.conflict(
          'APPROVAL_VERSION_CONFLICT',
          'The submission changed concurrently; re-read and retry'
        );
      }
      await this._repository.db(tx).approvalEvent.create({
        data: {
          approvalId,
          type: eventTypeForTransition(event),
          actorId: actor.userId,
          actorKind: actor.kind,
          metadata: { round },
        },
      });
      await this._audit.write(
        orgId,
        actor,
        {
          action: isResubmit ? 'approval.resubmit' : 'approval.submit',
          entityType: 'Approval',
          entityId: approvalId,
          metadata: { round },
        },
        tx
      );
      return this._repository.approvalById(orgId, approvalId, tx);
    });
    await this.notifyOrg(
      orgId,
      'A submission is awaiting review in REKTRS Social'
    );
    return this.getSubmission(orgId, (updated as Approval).id);
  }

  async decide(
    orgId: string,
    actor: RektrsActor,
    approvalId: string,
    input: {
      decision: RektrsDecisionName;
      comment?: string;
      expectedVersion?: number;
    }
  ) {
    if (!actorKindCanDecide(actor.kind)) {
      throw rektrsError.forbidden(
        'DECISIONS_REQUIRE_HUMAN',
        'Approval decisions are a human act: API-key and agent credentials cannot decide'
      );
    }
    if (
      (input.decision === 'REQUEST_CHANGES' || input.decision === 'REJECT') &&
      !input.comment?.trim()
    ) {
      throw rektrsError.badRequest(
        'DECISION_COMMENT_REQUIRED',
        'A comment is required when requesting changes or rejecting'
      );
    }
    const approval = await this.mustGetApproval(orgId, approvalId);
    const settings = await this._roles.getOrgSettings(orgId);
    const makerCheck = checkMakerChecker({
      submittedById: approval.submittedById,
      actorId: actor.userId as string,
      allowSelfApproval: settings.allowSelfApproval,
    });
    if (!makerCheck.allowed) {
      // The attempt itself is audit-worthy (design §2.2) — written outside
      // the decision transaction because no decision takes place.
      await this._audit.write(orgId, actor, {
        action: 'approval.decide_blocked_maker_checker',
        entityType: 'Approval',
        entityId: approvalId,
        metadata: { decision: input.decision },
      });
      throw rektrsError.forbidden(
        'MAKER_CHECKER_VIOLATION',
        'The maker of a submission cannot decide on it'
      );
    }
    const event = decisionToEvent(input.decision);
    let target: RektrsApprovalStateName;
    try {
      target = assertTransition(approval.state, event);
    } catch (e) {
      if (e instanceof RektrsStateError) {
        throw rektrsError.conflict(
          'APPROVAL_NOT_IN_REVIEW',
          `A submission in state ${approval.state} cannot be decided`
        );
      }
      throw e;
    }
    await this._repository.transaction(async (tx) => {
      const currentSet = await this.currentVersionSet(approval, tx);
      const approvedHash =
        input.decision === 'APPROVE'
          ? this.batchHashOfSet(approval.batchId, currentSet)
          : undefined;
      const expiresAt =
        input.decision === 'APPROVE' && settings.approvalTtlHours
          ? new Date(Date.now() + settings.approvalTtlHours * 3600_000)
          : null;
      const result = await this._repository.db(tx).approval.updateMany({
        where: {
          id: approvalId,
          organizationId: orgId,
          state: 'IN_REVIEW',
          ...(input.expectedVersion
            ? { version: input.expectedVersion }
            : { version: approval.version }),
        },
        data: {
          state: target,
          decidedById: actor.userId,
          decidedAt: new Date(),
          decision: input.decision,
          ...(approvedHash !== undefined ? { approvedHash } : {}),
          ...(input.decision === 'APPROVE' ? { expiresAt } : {}),
          version: { increment: 1 },
        },
      });
      if (!result.count) {
        throw rektrsError.conflict(
          'APPROVAL_VERSION_CONFLICT',
          'Another decision landed first; re-read the submission and retry'
        );
      }
      await this._repository.db(tx).approvalEvent.create({
        data: {
          approvalId,
          type: eventTypeForTransition(event),
          actorId: actor.userId,
          actorKind: actor.kind,
          metadata: {
            decision: input.decision,
            ...(makerCheck.selfApproval ? { selfApproval: true } : {}),
            ...(input.comment ? { comment: input.comment } : {}),
          },
        },
      });
      await this._audit.write(
        orgId,
        actor,
        {
          action: 'approval.decide',
          entityType: 'Approval',
          entityId: approvalId,
          afterHash: approvedHash,
          metadata: {
            decision: input.decision,
            ...(makerCheck.selfApproval ? { selfApproval: true } : {}),
          },
        },
        tx
      );
    });
    await this.notifyOrg(
      orgId,
      `A REKTRS Social submission was decided: ${input.decision}`
    );
    return this.getSubmission(orgId, approvalId);
  }

  async cancel(orgId: string, actor: RektrsActor, approvalId: string) {
    const approval = await this.mustGetApproval(orgId, approvalId);
    const functions = actor.userId
      ? await this._roles.getFunctions(orgId, actor.userId)
      : [];
    const isMaker =
      approval.submittedById === actor.userId ||
      approval.createdById === actor.userId;
    if (!isMaker && !functions.includes('MANAGER')) {
      throw rektrsError.forbidden(
        'REKTRS_FUNCTION_REQUIRED',
        'Only the maker or a MANAGER may cancel a submission'
      );
    }
    let target: RektrsApprovalStateName;
    try {
      target = assertTransition(approval.state, 'CANCEL');
    } catch (e) {
      if (e instanceof RektrsStateError) {
        throw rektrsError.conflict(
          'APPROVAL_NOT_CANCELLABLE',
          `A submission in state ${approval.state} cannot be cancelled`
        );
      }
      throw e;
    }
    await this._repository.transaction(async (tx) => {
      const result = await this._repository.db(tx).approval.updateMany({
        where: {
          id: approvalId,
          organizationId: orgId,
          state: approval.state,
          version: approval.version,
        },
        data: { state: target, version: { increment: 1 } },
      });
      if (!result.count) {
        throw rektrsError.conflict(
          'APPROVAL_VERSION_CONFLICT',
          'The submission changed concurrently; re-read and retry'
        );
      }
      await this._repository.db(tx).approvalEvent.create({
        data: {
          approvalId,
          type: 'CANCELLED',
          actorId: actor.userId,
          actorKind: actor.kind,
        },
      });
      await this._audit.write(
        orgId,
        actor,
        { action: 'approval.cancel', entityType: 'Approval', entityId: approvalId },
        tx
      );
    });
    return this.getSubmission(orgId, approvalId);
  }

  // ── Reads ─────────────────────────────────────────────────────────────────
  async mustGetApproval(orgId: string, approvalId: string) {
    const approval = await this._repository.approvalById(orgId, approvalId);
    if (!approval) {
      throw rektrsError.notFound('APPROVAL_NOT_FOUND', 'Submission not found');
    }
    return approval;
  }

  async getSubmission(orgId: string, approvalId: string) {
    const approval = await this.mustGetApproval(orgId, approvalId);
    const versions = await this._repository.versionsOfApproval(approvalId);
    const events = await this._repository.eventsOfApproval(approvalId);
    return { ...approval, versions, events };
  }

  listSubmissions(
    orgId: string,
    filters: {
      state?: Approval['state'];
      brandId?: string;
      campaignId?: string;
      submittedById?: string;
    }
  ) {
    return this._repository.approvalsOfOrg(orgId, filters);
  }

  async getReviewInbox(
    orgId: string,
    actor: RektrsActor,
    filters: { brandId?: string; campaignId?: string; submittedById?: string }
  ) {
    const rows = await this._repository.approvalsOfOrg(orgId, {
      state: 'IN_REVIEW',
      brandId: filters.brandId,
      campaignId: filters.campaignId,
      submittedById: filters.submittedById,
    });
    // Maker-checker preview (design §3.2): the maker's own items stay
    // visible but are flagged non-decidable.
    return rows.map((row) => ({
      ...row,
      decidable: row.submittedById !== actor.userId,
    }));
  }

  async getSubmissionTimeline(orgId: string, approvalId: string) {
    await this.mustGetApproval(orgId, approvalId);
    const events = await this._repository.eventsOfApproval(approvalId);
    const audit = await this._audit.forEntity(orgId, 'Approval', approvalId);
    return {
      events,
      audit,
      timeline: [
        ...events.map((e) => ({ kind: 'event' as const, at: e.createdAt, entry: e })),
        ...audit.map((a) => ({ kind: 'audit' as const, at: a.createdAt, entry: a })),
      ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()),
    };
  }

  // ── Policy scope + gate verification API (used by Gate A / Gate B slices) ──
  async resolveScopeForIntegration(
    orgId: string,
    integrationId: string
  ): Promise<RektrsScopeVerdict> {
    const settings = await this._roles.getOrgSettings(orgId);
    const membership =
      await this._repository.brandIntegrationByIntegration(integrationId);
    const brand =
      membership && !membership.brand.deletedAt ? membership.brand : null;
    if (brand?.approvalRequired) {
      return {
        scoped: true,
        brandId: brand.id,
        approvalRequired: true,
        source: 'brand',
      };
    }
    if (settings.approvalRequiredDefault) {
      return {
        scoped: true,
        brandId: brand?.id ?? null,
        approvalRequired: true,
        source: 'org',
      };
    }
    return {
      scoped: false,
      brandId: brand?.id ?? null,
      approvalRequired: false,
      source: 'none',
    };
  }

  /** True when any channel variant of the batch is policy-scoped (design §1.5). */
  private async batchScope(
    orgId: string,
    posts: Post[]
  ): Promise<{ scoped: boolean }> {
    const integrationIds = [...new Set(posts.map((p) => p.integrationId))];
    for (const integrationId of integrationIds) {
      const scope = await this.resolveScopeForIntegration(orgId, integrationId);
      if (scope.scoped) {
        return { scoped: true };
      }
    }
    return { scoped: false };
  }

  /**
   * Gate A verification (design §4): may this batch be scheduled now?
   * Read-only unless `invalidateOnMismatch` is set — then a hash mismatch on
   * an APPROVED/SCHEDULED submission performs the INVALIDATED transition
   * (event + audit, actor SYSTEM) exactly as the design prescribes.
   */
  async verifyBatchForGate(
    orgId: string,
    batchId: string,
    opts?: { invalidateOnMismatch?: boolean }
  ): Promise<RektrsGateVerdict> {
    const { posts, snapshots } = await this.snapshotLiveBatch(orgId, batchId);
    if (!posts.length) {
      return { scoped: false, pass: true };
    }
    const { scoped } = await this.batchScope(orgId, posts);
    if (!scoped) {
      return { scoped: false, pass: true };
    }
    const liveHash = computeBatchHash(
      batchId,
      snapshots.map((s) => ({
        integrationId: s.integrationId,
        contentHash: s.contentHash,
      }))
    );
    const approval = await this._repository.approvalByBatch(orgId, batchId);
    if (!approval) {
      return {
        scoped: true,
        pass: false,
        reason: 'APPROVAL_REQUIRED',
        liveHash,
      };
    }
    const base: RektrsGateVerdict = {
      scoped: true,
      pass: false,
      approvalId: approval.id,
      state: approval.state,
      approvedHash: approval.approvedHash,
      liveHash,
    };
    if (
      approval.state === 'EXPIRED' ||
      ((approval.state === 'APPROVED' || approval.state === 'SCHEDULED') &&
        isExpired(approval.expiresAt))
    ) {
      return { ...base, reason: 'APPROVAL_EXPIRED' };
    }
    if (approval.state !== 'APPROVED' && approval.state !== 'SCHEDULED') {
      return { ...base, reason: 'APPROVAL_REQUIRED' };
    }
    if (liveHash !== approval.approvedHash) {
      if (opts?.invalidateOnMismatch) {
        await this.invalidateApproval(
          orgId,
          approval.id,
          systemActor,
          approval.approvedHash,
          liveHash
        );
        return { ...base, reason: 'HASH_MISMATCH', invalidated: true };
      }
      return { ...base, reason: 'HASH_MISMATCH' };
    }
    return { ...base, pass: true };
  }

  /**
   * Gate B verification (design §4): may this post publish now? Fail-closed
   * for policy-scoped posts — any doubt returns pass:false. Non-scoped posts
   * pass untouched (no behaviour change for today's traffic).
   */
  async verifyVariantForPublish(
    orgId: string,
    postId: string
  ): Promise<RektrsGateVerdict> {
    const post = await this._repository.postById(orgId, postId);
    if (!post) {
      return { scoped: false, pass: false, reason: 'POST_NOT_FOUND' };
    }
    if (!post.batchId) {
      return { scoped: false, pass: true };
    }
    const scope = await this.resolveScopeForIntegration(orgId, post.integrationId);
    if (!scope.scoped) {
      return { scoped: false, pass: true };
    }
    const approval = await this._repository.approvalByBatch(orgId, post.batchId);
    if (!approval) {
      return {
        scoped: true,
        pass: false,
        reason: 'APPROVAL_NOT_FOUND',
        state: undefined,
      };
    }
    const base: RektrsGateVerdict = {
      scoped: true,
      pass: false,
      approvalId: approval.id,
      state: approval.state,
      approvedHash: approval.approvedHash,
    };
    if (
      approval.state === 'EXPIRED' ||
      ((approval.state === 'APPROVED' || approval.state === 'SCHEDULED') &&
        isExpired(approval.expiresAt))
    ) {
      return { ...base, reason: 'APPROVAL_EXPIRED' };
    }
    if (approval.state !== 'APPROVED' && approval.state !== 'SCHEDULED') {
      return { ...base, reason: 'APPROVAL_REQUIRED' };
    }
    const groupPosts = await this._repository.postsOfGroup(orgId, post.group);
    const variantRows = groupPosts.filter(
      (p) => p.integrationId === post.integrationId && p.batchId === post.batchId
    );
    const integration = await this._repository.integrationById(
      orgId,
      post.integrationId
    );
    const payload = buildVariantPayload(
      post.integrationId,
      integration?.providerIdentifier || '',
      variantRows
    );
    const liveHash = computeVariantHash(payload);
    const currentSet = await this.currentVersionSet(approval);
    const approvedVersion = currentSet.find(
      (v) => v.integrationId === post.integrationId
    );
    if (!approvedVersion || approvedVersion.contentHash !== liveHash) {
      return { ...base, reason: 'HASH_MISMATCH', liveHash };
    }
    return { ...base, pass: true, liveHash };
  }

  /** The INVALIDATED transition (design §2.1), callable by gates and hooks. */
  async invalidateApproval(
    orgId: string,
    approvalId: string,
    actor: RektrsActor,
    fromHash?: string | null,
    toHash?: string | null
  ) {
    const approval = await this.mustGetApproval(orgId, approvalId);
    let target: RektrsApprovalStateName;
    try {
      target = assertTransition(approval.state, 'INVALIDATE');
    } catch {
      // Already invalidated / terminal / not yet approved: nothing to do.
      return approval;
    }
    await this._repository.transaction(async (tx) => {
      const result = await this._repository.db(tx).approval.updateMany({
        where: {
          id: approvalId,
          organizationId: orgId,
          state: approval.state,
          version: approval.version,
        },
        data: { state: target, version: { increment: 1 } },
      });
      if (!result.count) {
        return;
      }
      await this._repository.db(tx).approvalEvent.create({
        data: {
          approvalId,
          type: 'INVALIDATED',
          actorId: actor.userId,
          actorKind: actor.kind,
          metadata: { fromHash: fromHash ?? null, toHash: toHash ?? null },
        },
      });
      await this._audit.write(
        orgId,
        actor,
        {
          action: 'approval.invalidate',
          entityType: 'Approval',
          entityId: approvalId,
          beforeHash: fromHash ?? undefined,
          afterHash: toHash ?? undefined,
        },
        tx
      );
    });
    return this._repository.approvalById(orgId, approvalId);
  }

  /**
   * State-only SCHEDULED bookkeeping for the future Gate A wiring: the
   * approval-side transition after Gate A has passed and the posts have
   * been queued by PostsService. Exposed now so the gate slice is wiring,
   * not new logic. (Post manipulation stays in PostsService — design §4.)
   */
  async markScheduled(orgId: string, actor: RektrsActor, approvalId: string) {
    return this.simpleTransition(orgId, actor, approvalId, 'SCHEDULE', 'approval.schedule');
  }

  async markUnscheduled(orgId: string, actor: RektrsActor, approvalId: string) {
    return this.simpleTransition(orgId, actor, approvalId, 'UNSCHEDULE', 'approval.unschedule');
  }

  async markPublished(orgId: string, actor: RektrsActor, approvalId: string) {
    return this.simpleTransition(orgId, actor, approvalId, 'MARK_PUBLISHED', 'approval.publish');
  }

  private async simpleTransition(
    orgId: string,
    actor: RektrsActor,
    approvalId: string,
    event: RektrsTransitionEvent,
    auditAction: string
  ) {
    const approval = await this.mustGetApproval(orgId, approvalId);
    let target: RektrsApprovalStateName;
    try {
      target = assertTransition(approval.state, event);
    } catch (e) {
      if (e instanceof RektrsStateError) {
        throw rektrsError.conflict(
          'ILLEGAL_TRANSITION',
          `A submission in state ${approval.state} cannot perform ${event}`
        );
      }
      throw e;
    }
    await this._repository.transaction(async (tx) => {
      const result = await this._repository.db(tx).approval.updateMany({
        where: {
          id: approvalId,
          organizationId: orgId,
          state: approval.state,
          version: approval.version,
        },
        data: { state: target, version: { increment: 1 } },
      });
      if (!result.count) {
        throw rektrsError.conflict(
          'APPROVAL_VERSION_CONFLICT',
          'The submission changed concurrently; re-read and retry'
        );
      }
      await this._repository.db(tx).approvalEvent.create({
        data: {
          approvalId,
          type: eventTypeForTransition(event),
          actorId: actor.userId,
          actorKind: actor.kind,
        },
      });
      await this._audit.write(
        orgId,
        actor,
        { action: auditAction, entityType: 'Approval', entityId: approvalId },
        tx
      );
    });
    return this.getSubmission(orgId, approvalId);
  }

  private async notifyOrg(orgId: string, message: string) {
    try {
      await this._notifications.inAppNotification(
        orgId,
        'REKTRS Social approvals',
        message,
        false
      );
    } catch (e) {
      this._logger.warn(`REKTRS notification failed: ${String(e)}`);
    }
  }
}
