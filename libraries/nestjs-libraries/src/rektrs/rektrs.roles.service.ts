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

export interface RektrsOrgSettingsView {
  approvalRequiredDefault: boolean;
  allowSelfApproval: boolean;
  approvalTtlHours: number | null;
  clientApprovalEnabled: boolean;
}

export const REKTRS_SETTINGS_DEFAULTS: RektrsOrgSettingsView = {
  approvalRequiredDefault: false,
  allowSelfApproval: false,
  approvalTtlHours: null,
  clientApprovalEnabled: false,
};

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
    };
  }

  /** MANAGER-gated by the controller; policy changes are audited (design §5). */
  async updateOrgSettings(
    orgId: string,
    actor: RektrsActor,
    patch: Partial<RektrsOrgSettingsView>
  ) {
    const before = await this.getOrgSettings(orgId);
    const after = { ...before, ...patch };
    return this._repository.transaction(async (tx) => {
      await this._repository.db(tx).rektrsOrgSettings.upsert({
        where: { organizationId: orgId },
        create: { organizationId: orgId, ...after },
        update: { ...patch },
      });
      await this._audit.write(
        orgId,
        actor,
        {
          action: 'org.settings',
          entityType: 'Policy',
          entityId: orgId,
          metadata: { before, after },
        },
        tx
      );
      return after;
    });
  }
}
