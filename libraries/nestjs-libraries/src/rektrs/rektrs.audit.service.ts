import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RektrsDb, RektrsRepository } from './rektrs.repository';
import { RektrsActor } from './rektrs.actor';

export interface RektrsAuditWrite {
  action: string;
  entityType: 'Brand' | 'Campaign' | 'Brief' | 'Approval' | 'Post' | 'Policy';
  entityId: string;
  beforeHash?: string;
  afterHash?: string;
  metadata?: Record<string, unknown>;
}

/**
 * REKTRS P3 — append-only audit (design §1.3 AuditEntry). Writers pass the
 * transaction client when the audit row must commit with the state change
 * it describes (design §2.1 invariant).
 */
@Injectable()
export class RektrsAuditService {
  constructor(private _repository: RektrsRepository) {}

  write(orgId: string, actor: RektrsActor, entry: RektrsAuditWrite, tx?: RektrsDb) {
    return this._repository.db(tx).auditEntry.create({
      data: {
        organizationId: orgId,
        actorId: actor.userId,
        actorKind: actor.kind,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        beforeHash: entry.beforeHash,
        afterHash: entry.afterHash,
        ip: actor.ip,
        metadata: entry.metadata as Prisma.InputJsonValue | undefined,
      },
    });
  }

  search(
    orgId: string,
    filters: {
      entityType?: string;
      entityId?: string;
      action?: string;
      from?: string;
      to?: string;
      cursor?: string;
      take?: number;
    }
  ) {
    return this._repository.auditSearch(orgId, {
      entityType: filters.entityType,
      entityId: filters.entityId,
      action: filters.action,
      from: filters.from ? new Date(filters.from) : undefined,
      to: filters.to ? new Date(filters.to) : undefined,
      cursor: filters.cursor,
      take: Math.min(Math.max(filters.take || 50, 1), 200),
    });
  }

  forEntity(orgId: string, entityType: string, entityId: string) {
    return this._repository.auditForEntity(orgId, entityType, entityId);
  }
}
