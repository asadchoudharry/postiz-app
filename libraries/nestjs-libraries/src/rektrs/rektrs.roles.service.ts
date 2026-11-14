import { Injectable } from '@nestjs/common';
import {
  isRektrsFunction,
  RektrsFunction,
  resolveFunctions,
} from './rektrs.roles';
import { RektrsRepository } from './rektrs.repository';
import { RektrsAuditService } from './rektrs.audit.service';
import { RektrsActor } from './rektrs.actor';
import { rektrsError } from './rektrs.errors';
import { isSafePublicHttpsUrl } from '@gitroom/nestjs-libraries/dtos/webhooks/webhook.url.validator';

export interface RektrsOrgSettingsView {
  approvalRequiredDefault: boolean;
  allowSelfApproval: boolean;
  approvalTtlHours: number | null;
  clientApprovalEnabled: boolean;
  // W2 alert chain (AUTOMATION-WORKFLOWS.md W2)
  alertReminderHours: number;
  alertEscalationHours: number;
  alertInAppEnabled: boolean;
  alertEmailEnabled: boolean;
  // W1 lead machine (AUTOMATION-WORKFLOWS.md W1): the CRM webhook the org's
  // leads are pushed to. The signing secret is WRITE-ONLY: reads expose
  // only whether one is set (crmWebhookSecretSet).
  crmWebhookUrl: string | null;
  crmWebhookEnabled: boolean;
  crmWebhookSecretSet: boolean;
  // W3 evergreen recycler schedule (AUTOMATION-WORKFLOWS.md W3): UTC
  // weekday (0 = Sunday … 6 = Saturday) + hour of the weekly scan.
  evergreenWeekday: number;
  evergreenHour: number;
}

export const REKTRS_SETTINGS_DEFAULTS: RektrsOrgSettingsView = {
  approvalRequiredDefault: false,
  allowSelfApproval: false,
  approvalTtlHours: null,
  clientApprovalEnabled: false,
  alertReminderHours: 4,
  alertEscalationHours: 12,
  alertInAppEnabled: true,
  alertEmailEnabled: true,
  crmWebhookUrl: null,
  crmWebhookEnabled: false,
  crmWebhookSecretSet: false,
  evergreenWeekday: 1,
  evergreenHour: 6,
};

/** Settings patch as accepted from the API: the view fields plus the
 *  write-only CRM secret (a string sets it, null clears it). */
export interface RektrsOrgSettingsPatch extends Partial<RektrsOrgSettingsView> {
  crmWebhookSecret?: string | null;
}

/**
 * REKTRS P3 — functional-role resolution + org policy settings (design §5).
 * One implementation, used by the API module and (in later slices) the
 * gates — mirroring the shared-hash rule (design §5).
 */
@Injectable()
export class RektrsRolesService {
  constructor(
    private _repository: RektrsRepository,
    private _audit: RektrsAuditService
  ) {}

  /** Effective functions of a member. Non-members have none. */
  async getFunctions(orgId: string, userId: string): Promise<RektrsFunction[]> {
    const membership = await this._repository.userOrganization(orgId, userId);
    if (!membership || membership.disabled) {
      return [];
    }
    return resolveFunctions(membership.role, membership.functions);
  }

  async assertFunction(
    orgId: string,
    actor: RektrsActor,
    required: RektrsFunction
  ): Promise<RektrsFunction[]> {
    if (!actor.userId) {
      throw rektrsError.forbidden(
        'REKTRS_FUNCTION_REQUIRED',
        `The ${required} function is required for this action`
      );
    }
    const functions = await this.getFunctions(orgId, actor.userId);
    if (!functions.includes(required)) {
      throw rektrsError.forbidden(
        'REKTRS_FUNCTION_REQUIRED',
        `The ${required} function is required for this action`
      );
    }
    return functions;
  }

  /** MANAGER-gated by the controller; audited here (design §5). */
  async updateMemberFunctions(
    orgId: string,
    actor: RektrsActor,
    targetUserId: string,
    functions: string[]
  ) {
    const invalid = functions.filter((f) => !isRektrsFunction(f));
    if (invalid.length) {
      throw rektrsError.badRequest(
        'INVALID_FUNCTION',
        `Unknown REKTRS functions: ${invalid.join(', ')}`
      );
    }
    const membership = await this._repository.userOrganization(orgId, targetUserId);
    if (!membership) {
      throw rektrsError.notFound('MEMBER_NOT_FOUND', 'Org member not found');
    }
    const deduped = [...new Set(functions)];
    return this._repository.transaction(async (tx) => {
      const updated = await this._repository.db(tx).userOrganization.update({
        where: { id: membership.id },
        data: { functions: deduped },
      });
      await this._audit.write(
        orgId,
        actor,
        {
          action: 'org.member_functions',
          entityType: 'Policy',
          entityId: targetUserId,
          metadata: { before: membership.functions, after: deduped },
        },
        tx
      );
      return {
        userId: targetUserId,
        functions: resolveFunctions(updated.role, updated.functions),
        storedFunctions: updated.functions,
      };
    });
  }

  async getOrgSettings(orgId: string): Promise<RektrsOrgSettingsView> {
    const row = await this._repository.orgSettings(orgId);
    if (!row) {
      return { ...REKTRS_SETTINGS_DEFAULTS };
    }
    return {
      approvalRequiredDefault: row.approvalRequiredDefault,
      allowSelfApproval: row.allowSelfApproval,
      approvalTtlHours: row.approvalTtlHours,
      clientApprovalEnabled: row.clientApprovalEnabled,
      // `?? default` keeps pre-W2 rows (columns added by schema-step-w5.sql
      // with DB defaults, so this is belt-and-braces) reading sanely.
      alertReminderHours:
        row.alertReminderHours ?? REKTRS_SETTINGS_DEFAULTS.alertReminderHours,
      alertEscalationHours:
        row.alertEscalationHours ??
        REKTRS_SETTINGS_DEFAULTS.alertEscalationHours,
      alertInAppEnabled:
        row.alertInAppEnabled ?? REKTRS_SETTINGS_DEFAULTS.alertInAppEnabled,
      alertEmailEnabled:
        row.alertEmailEnabled ?? REKTRS_SETTINGS_DEFAULTS.alertEmailEnabled,
      // W1 columns (schema-step-w1.sql) — same belt-and-braces treatment.
      crmWebhookUrl: row.crmWebhookUrl ?? null,
      crmWebhookEnabled:
        row.crmWebhookEnabled ?? REKTRS_SETTINGS_DEFAULTS.crmWebhookEnabled,
      crmWebhookSecretSet: !!row.crmWebhookSecret,
      // W3 columns (schema-step-w3.sql) — same belt-and-braces treatment.
      evergreenWeekday:
        row.evergreenWeekday ?? REKTRS_SETTINGS_DEFAULTS.evergreenWeekday,
      evergreenHour:
        row.evergreenHour ?? REKTRS_SETTINGS_DEFAULTS.evergreenHour,
    };
  }

  /**
   * W1 server-side read of the CRM webhook config INCLUDING the signing
   * secret. Internal only — this shape must never reach an API response
   * (the public view above carries crmWebhookSecretSet instead).
   */
  async getCrmWebhookConfig(orgId: string) {
    const row = await this._repository.orgSettings(orgId);
    return {
      url: row?.crmWebhookUrl ?? null,
      secret: row?.crmWebhookSecret ?? null,
      enabled: row?.crmWebhookEnabled ?? false,
    };
  }

  /** MANAGER-gated by the controller; policy changes are audited (design §5). */
  async updateOrgSettings(
    orgId: string,
    actor: RektrsActor,
    patch: RektrsOrgSettingsPatch
  ) {
    // W1: the CRM secret is write-only — split it out so it can never land
    // in the settings view or in audit metadata.
    const { crmWebhookSecret, ...viewPatch } = patch;
    const secretTouched = crmWebhookSecret !== undefined;
    if (secretTouched && crmWebhookSecret) {
      if (crmWebhookSecret.length < 16) {
        throw rektrsError.unprocessable(
          'CRM_WEBHOOK_SECRET_TOO_SHORT',
          'The CRM webhook signing secret must be at least 16 characters'
        );
      }
    }
    if (viewPatch.crmWebhookUrl) {
      // Reuse the platform's SSRF guard: leads carry commenter PII, so the
      // endpoint must be a public HTTPS URL, never an internal address.
      if (!(await isSafePublicHttpsUrl(viewPatch.crmWebhookUrl))) {
        throw rektrsError.unprocessable(
          'CRM_WEBHOOK_URL_UNSAFE',
          'The CRM webhook URL must be a public HTTPS URL'
        );
      }
    }
    const before = await this.getOrgSettings(orgId);
    const after: RektrsOrgSettingsView = { ...before, ...viewPatch };
    if (secretTouched) {
      after.crmWebhookSecretSet = !!crmWebhookSecret;
    }
    // Only real columns may reach Prisma: the view's crmWebhookSecretSet is
    // derived, and the secret itself is set explicitly when touched.
    const { crmWebhookSecretSet: _derived, ...columnView } = after;
    const columnPatch: Record<string, unknown> = { ...viewPatch };
    delete columnPatch.crmWebhookSecretSet;
    if (secretTouched) {
      columnPatch.crmWebhookSecret = crmWebhookSecret;
    }
    return this._repository.transaction(async (tx) => {
      await this._repository.db(tx).rektrsOrgSettings.upsert({
        where: { organizationId: orgId },
        create: {
          organizationId: orgId,
          ...columnView,
          crmWebhookSecret: secretTouched ? crmWebhookSecret : null,
        },
        update: { ...columnPatch },
      });
      await this._audit.write(
        orgId,
        actor,
        {
          action: 'org.settings',
          entityType: 'Policy',
          entityId: orgId,
          metadata: {
            before,
            after,
            ...(secretTouched ? { crmWebhookSecretChanged: true } : {}),
          },
        },
        tx
      );
      return after;
    });
  }
}
