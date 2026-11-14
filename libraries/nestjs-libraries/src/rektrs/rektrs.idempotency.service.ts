import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RektrsRepository } from './rektrs.repository';
import { hashRequestBody } from './rektrs.hash';
import { rektrsError } from './rektrs.errors';

export interface RektrsIdempotentResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

/**
 * REKTRS P3 — Idempotency-Key handling (design §3.3). Mutating submission
 * calls require a key; the first execution's (status, body) is stored and
 * replayed for the same key + same body; the same key with a different body
 * is a 422 IDEMPOTENCY_KEY_REUSED. This is what makes n8n/API retries safe.
 */
@Injectable()
export class RektrsIdempotencyService {
  constructor(private _repository: RektrsRepository) {}

  async execute<T>(
    orgId: string,
    key: string | undefined,
    requestBody: unknown,
    handler: () => Promise<{ status: number; body: T }>
  ): Promise<RektrsIdempotentResult<T>> {
    if (!key) {
      throw rektrsError.badRequest(
        'IDEMPOTENCY_KEY_REQUIRED',
        'An Idempotency-Key header is required for this call'
      );
    }
    const requestHash = hashRequestBody(requestBody);
    const existing = await this._repository.idempotencyKey(orgId, key);
    if (existing) {
      return this.replay<T>(existing.requestHash, requestHash, existing);
    }
    const result = await handler();
    try {
      await this._repository.db().rektrsIdempotencyKey.create({
        data: {
          organizationId: orgId,
          key,
          requestHash,
          responseStatus: result.status,
          responseBody: result.body as Prisma.InputJsonValue,
        },
      });
    } catch (e) {
      // Lost a race with a concurrent identical call: replay the winner.
      const winner = await this._repository.idempotencyKey(orgId, key);
      if (winner) {
        return this.replay<T>(winner.requestHash, requestHash, winner);
      }
      throw e;
    }
    return { ...result, replayed: false };
  }

  private replay<T>(
    storedHash: string,
    requestHash: string,
    row: { responseStatus: number; responseBody: unknown }
  ): RektrsIdempotentResult<T> {
    if (storedHash !== requestHash) {
      throw rektrsError.unprocessable(
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used with a different request body'
      );
    }
    return {
      status: row.responseStatus,
      body: row.responseBody as T,
      replayed: true,
    };
  }
}
