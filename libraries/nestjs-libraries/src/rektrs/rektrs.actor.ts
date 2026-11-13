import { RektrsActorKindName } from './rektrs.state';

/**
 * The authenticated principal a REKTRS service call acts as. `kind` records
 * HOW the principal authenticated (design §3.1): session users are USER;
 * API-key and MCP principals exist in the wider system and are modelled here
 * so the decision path can reject them explicitly (a decision is a human
 * act). The org always comes from the authenticated request context, never
 * from a request parameter (design §0.7).
 */
export interface RektrsActor {
  /** Session user id; null for non-user principals (API key / system). */
  userId: string | null;
  kind: RektrsActorKindName;
  ip?: string;
}

export const systemActor: RektrsActor = { userId: null, kind: 'SYSTEM' };
