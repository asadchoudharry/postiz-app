import { Injectable, Logger } from '@nestjs/common';
import { Approval, Brand, Prisma } from '@prisma/client';
import { NotificationService } from '@gitroom/nestjs-libraries/database/prisma/notifications/notification.service';
import { RektrsRepository } from './rektrs.repository';
import { RektrsAuditService } from './rektrs.audit.service';
import { RektrsRolesService } from './rektrs.roles.service';
import { RektrsFunction } from './rektrs.roles';
import { systemActor } from './rektrs.actor';

/**
 * REKTRS W2 — Approval Alert Chain (AUTOMATION-WORKFLOWS.md W2) + the team
 * notices of the W5 kill-switch.
 *
 * Delivery model: one fan-out, small channel interface.
 *  - in-app: upstream notifications are ORG-WIDE rows (NotificationsRepository
 *    has no per-user targeting), so this channel notifies the whole org —
 *    exactly what P3's submit/decide notices already did.
 *  - email: targeted per recipient via NotificationService.sendEmail.
 *  - whatsapp: STUB. No provider is connected yet (Zender / phone gateway is
 *    a later drop-in); the stub resolves recipients and logs the intent at
 *    debug level, then no-ops. User rows carry no phone numbers today, so
 *    there is nothing to address a real send to anyway.
 *
 * Every channel send is isolated: a throwing channel is logged and the rest
 * still run; the fan-out itself never throws, so an alert can never fail the
 * submit/decide/pause call that triggered it (fire-and-forget contract).
 *
 * The org's channel toggles (RektrsOrgSettings.alertInAppEnabled /
 * alertEmailEnabled) gate the W2 alert-chain messages only; W5 kill-switch
 * notices always send (a crisis notice must not be silencable by an
 * alert-preference toggle).
 */

export interface RektrsAlertRecipient {
  userId: string;
  email: string | null;
  name: string | null;
}

export interface RektrsAlertMessage {
  orgId: string;
  kind:
    | 'SUBMITTED'
    | 'DECIDED'
    | 'REMINDER'
    | 'ESCALATION'
    | 'BRAND_PAUSED'
    | 'BRAND_RESUMED'
    // W1 lead machine — fired through this same channel interface; the
    // WhatsApp leg remains the documented no-op stub until a provider is
    // connected (AUTOMATION-WORKFLOWS.md W1/W2).
    | 'LEAD_CREATED'
    | 'LEAD_HUMAN_REVIEW';
  subject: string;
  /** Plain-text body; always ends with the deep link. */
  body: string;
  link: string;
  recipients: RektrsAlertRecipient[];
  /** W2 messages honour the org channel toggles; W5 notices pass false. */
  respectChannelSettings: boolean;
}

export interface RektrsAlertChannel {
  readonly name: 'in-app' | 'email' | 'whatsapp';
  send(alert: RektrsAlertMessage): Promise<void>;
}

class InAppRektrsAlertChannel implements RektrsAlertChannel {
  readonly name = 'in-app' as const;
  constructor(private _notifications: NotificationService) {}

  async send(alert: RektrsAlertMessage): Promise<void> {
    await this._notifications.inAppNotification(
      alert.orgId,
      alert.subject,
      alert.body,
      false,
      false,
      'info'
    );
  }
}

class EmailRektrsAlertChannel implements RektrsAlertChannel {
  readonly name = 'email' as const;
  constructor(
    private _notifications: NotificationService,
    private _logger: Logger
  ) {}

  async send(alert: RektrsAlertMessage): Promise<void> {
    const html =
      `<p>${escapeHtml(alert.body).replace(/\n/g, '<br/>')}</p>` +
      `<p><a href="${escapeHtml(alert.link)}">Open in REKTRS Social</a></p>`;
    for (const recipient of alert.recipients) {
      if (!recipient.email) {
        continue;
      }
      try {
        await this._notifications.sendEmail(
          recipient.email,
          alert.subject,
          html
        );
      } catch (e) {
        // One bad address must not starve the remaining recipients.
        this._logger.warn(
          `REKTRS alert email to ${recipient.email} failed: ${String(e)}`
        );
      }
    }
  }
}

class WhatsAppRektrsAlertChannelStub implements RektrsAlertChannel {
  readonly name = 'whatsapp' as const;
  constructor(private _logger: Logger) {}

  async send(alert: RektrsAlertMessage): Promise<void> {
    // No WhatsApp provider is connected yet — see the service docstring.
    this._logger.debug(
      `REKTRS whatsapp (stub, no provider): would send "${alert.subject}" ` +
        `to ${alert.recipients.length} recipient(s) in org ${alert.orgId}`
    );
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const REKTRS_REMINDER_DEFAULT_HOURS = 4;
export const REKTRS_ESCALATION_DEFAULT_HOURS = 12;

@Injectable()
export class RektrsAlertsService {
  private readonly _logger = new Logger(RektrsAlertsService.name);
  readonly channels: RektrsAlertChannel[];

  constructor(
    private _repository: RektrsRepository,
    private _roles: RektrsRolesService,
    private _audit: RektrsAuditService,
    notifications: NotificationService
  ) {
    this.channels = [
      new InAppRektrsAlertChannel(notifications),
      new EmailRektrsAlertChannel(notifications, this._logger),
      new WhatsAppRektrsAlertChannelStub(this._logger),
    ];
  }

  // ── Recipient resolution ──────────────────────────────────────────────────
  /** Enabled org members holding `fn`, minus the excluded user ids. */
  async membersWithFunction(
    orgId: string,
    fn: RektrsFunction,
    excludeUserIds: string[] = []
  ): Promise<RektrsAlertRecipient[]> {
    const members = await this._repository.orgMembers(orgId);
    const recipients: RektrsAlertRecipient[] = [];
    for (const member of members) {
      if (excludeUserIds.includes(member.userId)) {
        continue;
      }
      const functions = await this._roles.getFunctions(orgId, member.userId);
      if (!functions.includes(fn)) {
        continue;
      }
      recipients.push({
        userId: member.userId,
        email: member.user?.email ?? null,
        name: member.user?.name ?? null,
      });
    }
    return recipients;
  }

  private async allMembers(orgId: string): Promise<RektrsAlertRecipient[]> {
    const members = await this._repository.orgMembers(orgId);
    return members.map((m) => ({
      userId: m.userId,
      email: m.user?.email ?? null,
      name: m.user?.name ?? null,
    }));
  }

  private async recipientById(
    userId: string | null
  ): Promise<RektrsAlertRecipient[]> {
    if (!userId) {
      return [];
    }
    const user = await this._repository.userById(userId);
    if (!user) {
      return [];
    }
    return [{ userId: user.id, email: user.email, name: user.name }];
  }

  private link(path: string): string {
    const base = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
    return `${base}${path}`;
  }

  // ── Fan-out ───────────────────────────────────────────────────────────────
  async fanOut(alert: RektrsAlertMessage): Promise<void> {
    let channels = this.channels;
    if (alert.respectChannelSettings) {
      try {
        const settings = await this._roles.getOrgSettings(alert.orgId);
        channels = channels.filter((channel) => {
          if (channel.name === 'in-app') {
            return settings.alertInAppEnabled;
          }
          if (channel.name === 'email') {
            return settings.alertEmailEnabled;
          }
          return true;
        });
      } catch (e) {
        this._logger.warn(
          `REKTRS alert settings lookup failed for org ${alert.orgId}: ${String(e)}`
        );
      }
    }
    for (const channel of channels) {
      try {
        await channel.send(alert);
      } catch (e) {
        this._logger.warn(
          `REKTRS alert channel ${channel.name} failed (${alert.kind}, org ${alert.orgId}): ${String(e)}`
        );
      }
    }
  }

  private async brandName(orgId: string, brandId: string): Promise<string> {
    try {
      const brand = await this._repository.brandById(orgId, brandId);
      return brand?.name || 'a brand';
    } catch {
      return 'a brand';
    }
  }

  // ── W2 trigger points ─────────────────────────────────────────────────────
  /** (a) A submission entered IN_REVIEW → alert the brand's reviewers. */
  async alertSubmissionInReview(orgId: string, approval: Approval) {
    const makerId = approval.submittedById;
    const recipients = await this.membersWithFunction(
      orgId,
      'REVIEWER',
      makerId ? [makerId] : []
    );
    const brand = await this.brandName(orgId, approval.brandId);
    const link = this.link(`/review/${approval.id}`);
    await this.fanOut({
      orgId,
      kind: 'SUBMITTED',
      subject: `Review requested: ${brand} submission awaiting a decision`,
      body:
        `A submission for ${brand} is awaiting review in REKTRS Social.\n` +
        `Submission: ${approval.id}\n${link}`,
      link,
      recipients,
      respectChannelSettings: true,
    });
  }

  /** (b) A decision landed → tell the maker (comment + resubmit link). */
  async alertDecision(
    orgId: string,
    approval: Approval,
    decision: 'APPROVE' | 'REQUEST_CHANGES' | 'REJECT',
    comment?: string,
    deciderId?: string | null
  ) {
    const makerId = approval.submittedById || approval.createdById;
    // Under the audited self-approval switch the maker decided their own
    // submission — alerting them about their own act is noise.
    if (makerId && deciderId && makerId === deciderId) {
      return;
    }
    const recipients = await this.recipientById(makerId);
    if (!recipients.length) {
      return;
    }
    const brand = await this.brandName(orgId, approval.brandId);
    const link = this.link(`/submissions/${approval.id}`);
    const decisionText =
      decision === 'APPROVE'
        ? 'approved'
        : decision === 'REQUEST_CHANGES'
          ? 'sent back with changes requested'
          : 'rejected';
    await this.fanOut({
      orgId,
      kind: 'DECIDED',
      subject: `Your ${brand} submission was ${decisionText}`,
      body:
        `Your submission for ${brand} was ${decisionText} in REKTRS Social.\n` +
        (comment ? `Reviewer comment: ${comment}\n` : '') +
        (decision === 'APPROVE'
          ? `It can now be scheduled.\n`
          : `Open it to address the feedback and resubmit.\n`) +
        `Submission: ${approval.id}\n${link}`,
      link,
      recipients,
      respectChannelSettings: true,
    });
  }

  // ── W5 team notices (always send; see the docstring) ──────────────────────
  async alertBrandPaused(
    orgId: string,
    brand: Brand,
    pulledCount: number,
    reason?: string
  ) {
    const recipients = await this.allMembers(orgId);
    const link = this.link(`/brands`);
    await this.fanOut({
      orgId,
      kind: 'BRAND_PAUSED',
      subject: `Brand paused (kill-switch): ${brand.name}`,
      body:
        `${brand.name} was paused in REKTRS Social. ${pulledCount} queued ` +
        `post(s) were pulled back to drafts and nothing on this brand's ` +
        `channels can be scheduled or published until a manager resumes it.\n` +
        (reason ? `Reason: ${reason}\n` : '') +
        `${link}`,
      link,
      recipients,
      respectChannelSettings: false,
    });
  }

  // ── W1 lead notices ───────────────────────────────────────────────────────
  /**
   * A new lead landed (or a guard-routed comment needs a human). Recipients:
   * the org's MANAGERs. Honours the org channel toggles like the W2 chain —
   * a lead alert is operational, not a crisis notice.
   */
  async alertNewLead(
    orgId: string,
    lead: {
      id: string;
      brandId: string;
      commenterName?: string | null;
      matchedKeyword?: string | null;
      matchedGuardWord?: string | null;
      humanReview: boolean;
    }
  ) {
    const recipients = await this.membersWithFunction(orgId, 'MANAGER');
    if (!recipients.length) {
      return;
    }
    const brand = await this.brandName(orgId, lead.brandId);
    const link = this.link('/leads');
    const who = lead.commenterName || 'A commenter';
    await this.fanOut({
      orgId,
      kind: lead.humanReview ? 'LEAD_HUMAN_REVIEW' : 'LEAD_CREATED',
      subject: lead.humanReview
        ? `Comment needs a human: ${brand}`
        : `New lead: ${brand}`,
      body: lead.humanReview
        ? `${who}'s comment on ${brand} matched the guard word "${lead.matchedGuardWord}" and was routed to the human-review queue — no DM was sent. Open the queue: ${link}`
        : `${who}'s comment on ${brand} matched "${lead.matchedKeyword}". A DM was sent and the lead is on its way to your CRM. Open leads: ${link}`,
      link,
      recipients,
      respectChannelSettings: true,
    });
  }

  async alertBrandResumed(
    orgId: string,
    brand: Brand,
    restoredCount: number,
    skippedCount: number
  ) {
    const recipients = await this.allMembers(orgId);
    const link = this.link(`/brands`);
    await this.fanOut({
      orgId,
      kind: 'BRAND_RESUMED',
      subject: `Brand resumed: ${brand.name}`,
      body:
        `${brand.name} was resumed in REKTRS Social. ${restoredCount} post(s) ` +
        `were restored to the queue with their original publish dates` +
        (skippedCount
          ? `; ${skippedCount} post(s) stayed drafts (their approval no longer stands or they changed while paused) and need a manual look`
          : '') +
        `.\n${link}`,
      link,
      recipients,
      respectChannelSettings: false,
    });
  }

  // ── W2 reminder / escalation sweep ────────────────────────────────────────
  /**
   * One sweep pass (driven hourly by the Temporal reminders workflow in the
   * orchestrator; thresholds and channel toggles are read per org from
   * RektrsOrgSettings — never hardcoded). A threshold is claimed with an
   * updateMany on (state = IN_REVIEW, marker IS NULL) before any send, so
   * it fires at most once per IN_REVIEW round even if sweeps overlap; the
   * candidate query only returns rows still IN_REVIEW, and a row decided
   * between listing and claiming fails the claim's state check.
   */
  async sweepApprovalReminders(now: Date = new Date()): Promise<{
    reminded: number;
    escalated: number;
  }> {
    // Floor window: the DTO bounds reminder hours to >= 1, so nothing can
    // be due before it has been in review for an hour.
    const floor = new Date(now.getTime() - 1 * 3600_000);
    const candidates = await this._repository.staleInReviewApprovals(floor);
    let reminded = 0;
    let escalated = 0;
    const settingsByOrg = new Map<
      string,
      Awaited<ReturnType<RektrsRolesService['getOrgSettings']>>
    >();
    for (const approval of candidates) {
      try {
        const orgId = approval.organizationId;
        if (!approval.submittedAt) {
          continue;
        }
        let settings = settingsByOrg.get(orgId);
        if (!settings) {
          settings = await this._roles.getOrgSettings(orgId);
          settingsByOrg.set(orgId, settings);
        }
        const ageMs = now.getTime() - new Date(approval.submittedAt).getTime();
        // Escalation is checked first: past the escalation threshold the
        // reminder is moot if it somehow never fired.
        if (
          !approval.escalatedAt &&
          ageMs >= settings.alertEscalationHours * 3600_000
        ) {
          const claimed = await this.claimMarker(
            approval,
            'escalatedAt',
            now
          );
          if (claimed) {
            escalated++;
            await this.sendEscalation(approval);
          }
          continue;
        }
        if (
          !approval.reminderSentAt &&
          ageMs >= settings.alertReminderHours * 3600_000
        ) {
          const claimed = await this.claimMarker(
            approval,
            'reminderSentAt',
            now
          );
          if (claimed) {
            reminded++;
            await this.sendReminder(approval);
          }
        }
      } catch (e) {
        this._logger.warn(
          `REKTRS reminder sweep failed for approval ${approval.id}: ${String(e)}`
        );
      }
    }
    return { reminded, escalated };
  }

  private claimMarker(
    approval: Approval,
    marker: 'reminderSentAt' | 'escalatedAt',
    now: Date
  ) {
    return this._repository
      .db()
      .approval.updateMany({
        where: { id: approval.id, state: 'IN_REVIEW', [marker]: null },
        data: { [marker]: now },
      })
      .then((r) => r.count > 0)
      .catch(() => false);
  }

  private async sendReminder(approval: Approval) {
    const orgId = approval.organizationId;
    const makerId = approval.submittedById;
    const recipients = await this.membersWithFunction(
      orgId,
      'REVIEWER',
      makerId ? [makerId] : []
    );
    const brand = await this.brandName(orgId, approval.brandId);
    const link = this.link(`/review/${approval.id}`);
    await this.fanOut({
      orgId,
      kind: 'REMINDER',
      subject: `Still awaiting review: ${brand} submission`,
      body:
        `A submission for ${brand} has been awaiting a decision since ` +
        `${new Date(approval.submittedAt as Date).toISOString()}.\n` +
        `Submission: ${approval.id}\n${link}`,
      link,
      recipients,
      respectChannelSettings: true,
    });
    await this.recordSweepEvent(approval, 'REVIEW_REMINDER', {
      recipients: recipients.length,
    });
  }

  private async sendEscalation(approval: Approval) {
    const orgId = approval.organizationId;
    const recipients = await this.membersWithFunction(orgId, 'MANAGER');
    const brand = await this.brandName(orgId, approval.brandId);
    const link = this.link(`/review/${approval.id}`);
    await this.fanOut({
      orgId,
      kind: 'ESCALATION',
      subject: `Escalation: ${brand} submission undecided`,
      body:
        `A submission for ${brand} is still undecided since ` +
        `${new Date(approval.submittedAt as Date).toISOString()} and has ` +
        `been escalated to managers.\nSubmission: ${approval.id}\n${link}`,
      link,
      recipients,
      respectChannelSettings: true,
    });
    await this.recordSweepEvent(approval, 'REVIEW_ESCALATED', {
      recipients: recipients.length,
    });
  }

  /** Timeline evidence (design §1.3 event spine) + audit for a sweep send. */
  private async recordSweepEvent(
    approval: Approval,
    type: 'REVIEW_REMINDER' | 'REVIEW_ESCALATED',
    metadata: Record<string, unknown>
  ) {
    const orgId = approval.organizationId;
    try {
      await this._repository.db().approvalEvent.create({
        data: {
          approvalId: approval.id,
          type,
          actorId: null,
          actorKind: 'SYSTEM',
          metadata: metadata as Prisma.InputJsonValue,
        },
      });
      await this._audit.write(orgId, systemActor, {
        action:
          type === 'REVIEW_REMINDER'
            ? 'approval.reminder'
            : 'approval.escalation',
        entityType: 'Approval',
        entityId: approval.id,
        metadata,
      });
    } catch (e) {
      this._logger.warn(
        `REKTRS sweep event write failed for approval ${approval.id}: ${String(e)}`
      );
    }
  }
}
