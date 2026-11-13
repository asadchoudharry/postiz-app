/**
 * REKTRS P3 — functional roles (design P3-1 §5).
 *
 * The existing permission substrate is subscription quotas (CASL) plus
 * UserOrganization.role ∈ {SUPERADMIN, ADMIN, USER}. P3 adds a functional
 * layer on top — it does not rebuild the substrate: `functions` on
 * UserOrganization (String[]). An empty stored set means "derive the defaults
 * from the org role" so pre-existing memberships behave per the design's
 * migration defaults without a data backfill:
 *   SUPERADMIN / ADMIN → all five functions
 *   USER               → { CREATOR }
 * A non-empty stored set is authoritative (invalid entries are ignored).
 */

export const REKTRS_FUNCTIONS = [
  'CREATOR',
  'REVIEWER',
  'PUBLISHER',
  'MANAGER',
  'ANALYST',
] as const;

export type RektrsFunction = (typeof REKTRS_FUNCTIONS)[number];

export function isRektrsFunction(value: string): value is RektrsFunction {
  return (REKTRS_FUNCTIONS as readonly string[]).includes(value);
}

export function defaultFunctionsForRole(role: string): RektrsFunction[] {
  switch (role) {
    case 'SUPERADMIN':
    case 'ADMIN':
      return [...REKTRS_FUNCTIONS];
    default:
      return ['CREATOR'];
  }
}

export function resolveFunctions(
  role: string,
  stored: string[] | null | undefined
): RektrsFunction[] {
  const valid = (stored || []).filter(isRektrsFunction);
  if (valid.length) {
    return [...new Set(valid)];
  }
  return defaultFunctionsForRole(role);
}

export function hasFunction(
  resolved: RektrsFunction[],
  required: RektrsFunction
): boolean {
  return resolved.includes(required);
}
