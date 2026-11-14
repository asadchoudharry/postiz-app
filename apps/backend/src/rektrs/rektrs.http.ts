import { Organization, User } from '@prisma/client';
import { RektrsActor } from '@gitroom/nestjs-libraries/rektrs/rektrs.actor';
import { rektrsError } from '@gitroom/nestjs-libraries/rektrs/rektrs.errors';

/** The internal API only ever produces session principals (design §3.1). */
export function sessionActor(user: User, ip?: string): RektrsActor {
  return { userId: user.id, kind: 'USER', ip };
}

export function parseIfMatch(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const cleaned = raw.replace(/^W\//, '').replace(/"/g, '').trim();
  const value = Number.parseInt(cleaned, 10);
  return Number.isFinite(value) ? value : undefined;
}

/** Design §3.3: mutating calls on an existing aggregate take If-Match. */
export function requireIfMatch(raw: string | undefined): number {
  const value = parseIfMatch(raw);
  if (value === undefined) {
    throw rektrsError.badRequest(
      'IF_MATCH_REQUIRED',
      'An If-Match header with the current resource version is required'
    );
  }
  return value;
}

export function orgIdOf(org: Organization): string {
  return org.id;
}
