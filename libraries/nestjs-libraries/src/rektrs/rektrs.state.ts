/**
 * REKTRS P3 — approval state machine + maker-checker (design P3-1 §2).
 * Pure module: no framework imports, so the transition table is unit-testable
 * in isolation and identical for the API, the gates and the tests.
 */

export type RektrsApprovalStateName =
  | 'DRAFT'
  | 'IN_REVIEW'
  | 'APPROVED'
  | 'CHANGES_REQUESTED'
  | 'REJECTED'
  | 'INVALIDATED'
  | 'SCHEDULED'
  | 'PUBLISHED'
  | 'CANCELLED'
  | 'EXPIRED';

export type RektrsDecisionName = 'APPROVE' | 'REQUEST_CHANGES' | 'REJECT';

export type RektrsActorKindName =
  | 'USER'
  | 'API_KEY'
  | 'MCP'
  | 'CLIENT_TOKEN'
  | 'SYSTEM';

export type RektrsTransitionEvent =
  | 'SUBMIT'
  | 'RESUBMIT'
  | 'DECIDE_APPROVE'
  | 'DECIDE_REQUEST_CHANGES'
  | 'DECIDE_REJECT'
  | 'SCHEDULE'
  | 'UNSCHEDULE'
  | 'MARK_PUBLISHED'
  | 'INVALIDATE'
  | 'EXPIRE'
  | 'CANCEL';

export const REKTRS_TERMINAL_STATES: RektrsApprovalStateName[] = [
  'PUBLISHED',
  'CANCELLED',
];

const NON_TERMINAL: RektrsApprovalStateName[] = [
  'DRAFT',
  'IN_REVIEW',
  'APPROVED',
  'CHANGES_REQUESTED',
  'REJECTED',
  'INVALIDATED',
  'SCHEDULED',
  'EXPIRED',
];

const TRANSITIONS: Record<
  RektrsTransitionEvent,
  { from: RektrsApprovalStateName[]; to: RektrsApprovalStateName; eventType: string }
> = {
  SUBMIT: { from: ['DRAFT'], to: 'IN_REVIEW', eventType: 'SUBMITTED' },
  RESUBMIT: {
    from: ['CHANGES_REQUESTED', 'REJECTED', 'INVALIDATED', 'EXPIRED'],
    to: 'IN_REVIEW',
    eventType: 'RESUBMITTED',
  },
  DECIDE_APPROVE: { from: ['IN_REVIEW'], to: 'APPROVED', eventType: 'APPROVED' },
  DECIDE_REQUEST_CHANGES: {
    from: ['IN_REVIEW'],
    to: 'CHANGES_REQUESTED',
    eventType: 'CHANGES_REQUESTED',
  },
  DECIDE_REJECT: { from: ['IN_REVIEW'], to: 'REJECTED', eventType: 'REJECTED' },
  SCHEDULE: { from: ['APPROVED'], to: 'SCHEDULED', eventType: 'SCHEDULED' },
  UNSCHEDULE: { from: ['SCHEDULED'], to: 'APPROVED', eventType: 'RESCHEDULED' },
  MARK_PUBLISHED: { from: ['SCHEDULED'], to: 'PUBLISHED', eventType: 'PUBLISHED' },
  INVALIDATE: {
    from: ['APPROVED', 'SCHEDULED'],
    to: 'INVALIDATED',
    eventType: 'INVALIDATED',
  },
  EXPIRE: { from: ['APPROVED', 'SCHEDULED'], to: 'EXPIRED', eventType: 'EXPIRED' },
  CANCEL: { from: NON_TERMINAL, to: 'CANCELLED', eventType: 'CANCELLED' },
};

export class RektrsStateError extends Error {
  code = 'ILLEGAL_TRANSITION';
  constructor(
    public from: RektrsApprovalStateName,
    public event: RektrsTransitionEvent
  ) {
    super(`Illegal approval transition: ${event} from ${from}`);
    this.name = 'RektrsStateError';
  }
}

export function isTerminalState(state: RektrsApprovalStateName): boolean {
  return REKTRS_TERMINAL_STATES.includes(state);
}

export function transitionTarget(
  from: RektrsApprovalStateName,
  event: RektrsTransitionEvent
): RektrsApprovalStateName | null {
  const transition = TRANSITIONS[event];
  return transition.from.includes(from) ? transition.to : null;
}

export function canTransition(
  from: RektrsApprovalStateName,
  event: RektrsTransitionEvent
): boolean {
  return transitionTarget(from, event) !== null;
}

export function assertTransition(
  from: RektrsApprovalStateName,
  event: RektrsTransitionEvent
): RektrsApprovalStateName {
  const target = transitionTarget(from, event);
  if (!target) {
    throw new RektrsStateError(from, event);
  }
  return target;
}

/** ApprovalEvent.type written for a transition (design §1.3 event vocabulary). */
export function eventTypeForTransition(event: RektrsTransitionEvent): string {
  return TRANSITIONS[event].eventType;
}

export function decisionToEvent(decision: RektrsDecisionName): RektrsTransitionEvent {
  switch (decision) {
    case 'APPROVE':
      return 'DECIDE_APPROVE';
    case 'REQUEST_CHANGES':
      return 'DECIDE_REQUEST_CHANGES';
    case 'REJECT':
      return 'DECIDE_REJECT';
  }
}

/**
 * Maker-checker (design §2.2): the decider must differ from the maker of the
 * current round, unless the org has explicitly enabled the audited
 * self-approval switch. There is no implicit super-admin bypass.
 */
export function checkMakerChecker(input: {
  submittedById: string | null;
  actorId: string;
  allowSelfApproval: boolean;
}): { allowed: boolean; selfApproval: boolean } {
  const selfApproval =
    input.submittedById !== null && input.submittedById === input.actorId;
  return {
    selfApproval,
    allowed: !selfApproval || input.allowSelfApproval,
  };
}

/**
 * A decision is a human act (design §3.1/§4 path 4): session users and scoped
 * client-approver tokens may decide; API keys and MCP/agent credentials may
 * never decide, whatever functions they otherwise hold.
 */
export function actorKindCanDecide(kind: RektrsActorKindName): boolean {
  return kind === 'USER' || kind === 'CLIENT_TOKEN';
}

export function isExpired(
  expiresAt: Date | string | null | undefined,
  now: Date = new Date()
): boolean {
  if (!expiresAt) {
    return false;
  }
  return new Date(expiresAt).getTime() <= now.getTime();
}
