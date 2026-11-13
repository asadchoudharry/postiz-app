/**
 * RektrsAlertsService — W2 approval alert chain (fan-out recipient
 * selection, channel gating + failure isolation, the reminder/escalation
 * sweep's idempotency + state guards, the WhatsApp stub).
 * Ephemeral jest (same harness as rektrs.approvals.service.spec.ts).
 * @jest-environment node
 */
import { RektrsAlertsService } from '@gitroom/nestjs-libraries/rektrs/rektrs.alerts.service';

const ORG = 'org-1';
const NOW = new Date('2026-01-20T12:00:00.000Z');

const members = [
  { userId: 'maker-1', user: { email: 'maker@example.com', name: 'Maker' } },
  { userId: 'rev-1', user: { email: 'rev1@example.com', name: 'Reviewer One' } },
  { userId: 'rev-2', user: { email: 'rev2@example.com', name: 'Reviewer Two' } },
  { userId: 'mgr-1', user: { email: 'mgr@example.com', name: 'Manager' } },
];

const functionsByUser: Record<string, string[]> = {
  'maker-1': ['CREATOR'],
  'rev-1': ['REVIEWER'],
  'rev-2': ['REVIEWER'],
  'mgr-1': ['CREATOR', 'REVIEWER', 'MANAGER'],
};

function makeApproval(overrides: Record<string, any> = {}) {
  return {
    id: 'ap-1',
    organizationId: ORG,
    brandId: 'brand-1',
    batchId: 'batch-1',
    state: 'IN_REVIEW',
    submittedById: 'maker-1',
    submittedAt: new Date('2026-01-20T00:00:00.000Z'), // 12h before NOW
    reminderSentAt: null,
    escalatedAt: null,
    ...overrides,
  };
}

function buildService(opts: {
  settings?: Record<string, any>;
  stale?: any[];
  claimCount?: number;
  notifications?: any;
} = {}) {
  const events: any[] = [];
  const updateManyCalls: any[] = [];
  const settings = {
    alertReminderHours: 4,
    alertEscalationHours: 12,
    alertInAppEnabled: true,
    alertEmailEnabled: true,
    ...(opts.settings ?? {}),
  };
  const repository: any = {
    orgMembers: jest.fn(async () => members),
    userById: jest.fn(
      async (id: string) => members.find((m) => m.userId === id)?.user
        ? { id, ...members.find((m) => m.userId === id)!.user }
        : null
    ),
    brandById: jest.fn(async () => ({ id: 'brand-1', name: 'Brand One' })),
    staleInReviewApprovals: jest.fn(async () => opts.stale ?? []),
    db: jest.fn(() => ({
      approval: {
        updateMany: jest.fn(async (args: any) => {
          updateManyCalls.push(args);
          return { count: opts.claimCount ?? 1 };
        }),
      },
      approvalEvent: {
        create: jest.fn(async (args: any) => {
          events.push(args.data);
          return args.data;
        }),
      },
    })),
  };
  const roles: any = {
    getFunctions: jest.fn(
      async (_orgId: string, userId: string) => functionsByUser[userId] ?? []
    ),
    getOrgSettings: jest.fn(async () => settings),
  };
  const audit: any = { write: jest.fn(async () => ({})) };
  const notifications: any = opts.notifications ?? {
    inAppNotification: jest.fn(async () => ({})),
    sendEmail: jest.fn(async () => ''),
  };
  const service = new RektrsAlertsService(
    repository,
    roles,
    audit,
    notifications
  );
  return { service, repository, roles, audit, notifications, events, updateManyCalls };
}

const emailRecipients = (notifications: any) =>
  notifications.sendEmail.mock.calls.map((c: any[]) => c[0]);

describe('W2 fan-out — submission enters IN_REVIEW', () => {
  it('emails every reviewer EXCEPT the maker, posts one in-app alert, deep-links to /review/<id>', async () => {
    const { service, notifications } = buildService();
    await service.alertSubmissionInReview(ORG, makeApproval() as any);

    expect(emailRecipients(notifications).sort()).toEqual([
      'mgr@example.com', // holds REVIEWER too
      'rev1@example.com',
      'rev2@example.com',
    ]);
    expect(notifications.inAppNotification).toHaveBeenCalledTimes(1);
    const [orgId, subject, body] = notifications.inAppNotification.mock.calls[0];
    expect(orgId).toEqual(ORG);
    expect(subject).toContain('Brand One');
    expect(body).toContain('/review/ap-1');
  });

  it('email channel off in org settings → no emails, in-app still fires', async () => {
    const { service, notifications } = buildService({
      settings: { alertEmailEnabled: false },
    });
    await service.alertSubmissionInReview(ORG, makeApproval() as any);
    expect(notifications.sendEmail).not.toHaveBeenCalled();
    expect(notifications.inAppNotification).toHaveBeenCalledTimes(1);
  });

  it('in-app channel off in org settings → emails still fire', async () => {
    const { service, notifications } = buildService({
      settings: { alertInAppEnabled: false },
    });
    await service.alertSubmissionInReview(ORG, makeApproval() as any);
    expect(notifications.inAppNotification).not.toHaveBeenCalled();
    expect(notifications.sendEmail).toHaveBeenCalledTimes(3);
  });
});

describe('W2 fan-out — decisions reach the maker', () => {
  it('APPROVE → maker emailed + in-app (no duplicate DECIDED event — decide() owns it)', async () => {
    const { service, notifications, events } = buildService();
    await service.alertDecision(
      ORG,
      makeApproval() as any,
      'APPROVE',
      undefined,
      'rev-1'
    );
    expect(emailRecipients(notifications)).toEqual(['maker@example.com']);
    expect(notifications.inAppNotification).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(0);
  });

  it('self-approval (maker == decider) → no self-notification', async () => {
    const { service, notifications } = buildService();
    await service.alertDecision(
      ORG,
      makeApproval() as any,
      'APPROVE',
      undefined,
      'maker-1'
    );
    expect(notifications.sendEmail).not.toHaveBeenCalled();
    expect(notifications.inAppNotification).not.toHaveBeenCalled();
  });

  it('REQUEST_CHANGES → the reviewer comment rides along in the body', async () => {
    const { service, notifications } = buildService();
    await service.alertDecision(
      ORG,
      makeApproval() as any,
      'REQUEST_CHANGES',
      'Fix the headline',
      'rev-1'
    );
    const body = notifications.inAppNotification.mock.calls[0][2];
    expect(body).toContain('Fix the headline');
    // the maker is pointed at their own submission page to fix + resubmit
    expect(body).toContain('/submissions/ap-1');
  });
});

describe('W2 failure isolation', () => {
  it('a throwing in-app channel never blocks the email channel or the caller', async () => {
    const notifications = {
      inAppNotification: jest.fn(async () => {
        throw new Error('feed down');
      }),
      sendEmail: jest.fn(async () => ''),
    };
    const { service } = buildService({ notifications });
    await expect(
      service.alertSubmissionInReview(ORG, makeApproval() as any)
    ).resolves.toBeUndefined();
    expect(notifications.sendEmail).toHaveBeenCalledTimes(3);
  });

  it('one bad email address does not starve the other recipients', async () => {
    const notifications = {
      inAppNotification: jest.fn(async () => ({})),
      sendEmail: jest.fn(async (to: string) => {
        if (to === 'rev1@example.com') {
          throw new Error('bounce');
        }
        return '';
      }),
    };
    const { service } = buildService({ notifications });
    await expect(
      service.alertSubmissionInReview(ORG, makeApproval() as any)
    ).resolves.toBeUndefined();
    expect(notifications.sendEmail).toHaveBeenCalledTimes(3);
  });

  it('the WhatsApp channel is a no-op stub (no provider connected)', async () => {
    const { service } = buildService();
    const whatsapp = service.channels.find((c) => c.name === 'whatsapp')!;
    await expect(
      whatsapp.send({
        orgId: ORG,
        kind: 'SUBMITTED',
        subject: 'x',
        body: 'y',
        link: '/review/ap-1',
        recipients: [{ userId: 'rev-1', email: null, name: null }],
        respectChannelSettings: false,
      })
    ).resolves.toBeUndefined();
  });
});

describe('W2 sweep — reminders + escalation', () => {
  it('past the reminder threshold (not escalation): reviewers re-notified once, marker claimed, event recorded', async () => {
    // submitted 5h before NOW: past 4h reminder, below 12h escalation
    const stale = makeApproval({
      submittedAt: new Date('2026-01-20T07:00:00.000Z'),
    });
    const { service, notifications, events, updateManyCalls } = buildService({
      stale: [stale],
    });
    const result = await service.sweepApprovalReminders(NOW);
    expect(result).toEqual({ reminded: 1, escalated: 0 });
    expect(updateManyCalls[0].where).toMatchObject({
      id: 'ap-1',
      state: 'IN_REVIEW',
      reminderSentAt: null,
    });
    expect(emailRecipients(notifications).sort()).toEqual([
      'mgr@example.com',
      'rev1@example.com',
      'rev2@example.com',
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'REVIEW_REMINDER', actorKind: 'SYSTEM' })
    );
  });

  it('past the escalation threshold: managers notified, escalation event recorded, no plain reminder', async () => {
    const stale = makeApproval({
      submittedAt: new Date('2026-01-19T20:00:00.000Z'), // 16h before NOW
      reminderSentAt: new Date('2026-01-20T00:00:00.000Z'),
    });
    const { service, notifications, events } = buildService({ stale: [stale] });
    const result = await service.sweepApprovalReminders(NOW);
    expect(result).toEqual({ reminded: 0, escalated: 1 });
    expect(emailRecipients(notifications)).toEqual(['mgr@example.com']);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'REVIEW_ESCALATED' })
    );
  });

  it('claim lost (marker already set / no longer IN_REVIEW) → nothing is sent', async () => {
    const stale = makeApproval({
      submittedAt: new Date('2026-01-20T07:00:00.000Z'),
    });
    const { service, notifications, events } = buildService({
      stale: [stale],
      claimCount: 0,
    });
    const result = await service.sweepApprovalReminders(NOW);
    expect(result).toEqual({ reminded: 0, escalated: 0 });
    expect(notifications.sendEmail).not.toHaveBeenCalled();
    expect(notifications.inAppNotification).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it('below the reminder threshold → untouched (no claim attempted)', async () => {
    const stale = makeApproval({
      submittedAt: new Date('2026-01-20T10:00:00.000Z'), // 2h before NOW
    });
    const { service, notifications, updateManyCalls } = buildService({
      stale: [stale],
    });
    const result = await service.sweepApprovalReminders(NOW);
    expect(result).toEqual({ reminded: 0, escalated: 0 });
    expect(updateManyCalls).toHaveLength(0);
    expect(notifications.sendEmail).not.toHaveBeenCalled();
  });

  it('org settings drive the thresholds (custom 24h reminder → 5h-old submission untouched)', async () => {
    const stale = makeApproval({
      submittedAt: new Date('2026-01-20T07:00:00.000Z'),
    });
    const { service, notifications } = buildService({
      stale: [stale],
      settings: { alertReminderHours: 24, alertEscalationHours: 48 },
    });
    const result = await service.sweepApprovalReminders(NOW);
    expect(result).toEqual({ reminded: 0, escalated: 0 });
    expect(notifications.sendEmail).not.toHaveBeenCalled();
  });
});
