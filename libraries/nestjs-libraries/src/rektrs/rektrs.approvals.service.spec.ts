import { RektrsApprovalsService } from '@gitroom/nestjs-libraries/rektrs/rektrs.approvals.service';
import {
  buildVariantPayload,
  computeBatchHash,
  computeVariantHash,
} from '@gitroom/nestjs-libraries/rektrs/rektrs.hash';
import { RektrsActor } from '@gitroom/nestjs-libraries/rektrs/rektrs.actor';

const ORG = 'org-1';
const BATCH = 'batch-1';

const makePost = (overrides: Record<string, unknown> = {}): any => ({
  id: 'post-1',
  organizationId: ORG,
  batchId: BATCH,
  integrationId: 'int-1',
  group: 'group-1',
  parentPostId: null,
  content: 'Hello world',
  delay: 0,
  image: JSON.stringify([{ id: 'm1', path: '/uploads/a.png' }]),
  settings: JSON.stringify({
    __type: 'linkedin',
    options: { visibility: 'PUBLIC' },
  }),
  title: 'Launch',
  description: null,
  publishDate: new Date('2026-02-01T10:00:00.000Z'),
  state: 'QUEUE',
  creationMethod: 'WEB',
  createdAt: new Date('2026-01-01T10:00:00.000Z'),
  updatedAt: new Date('2026-01-01T10:00:00.000Z'),
  ...overrides,
});

const variantHashOf = (post: any) =>
  computeVariantHash(buildVariantPayload('int-1', 'linkedin', [post]));

const basePost = makePost();
const variantHash = variantHashOf(basePost);
const batchHash = computeBatchHash(BATCH, [
  { integrationId: 'int-1', contentHash: variantHash },
]);

const makeApproval = (overrides: Record<string, unknown> = {}): any => ({
  id: 'ap-1',
  organizationId: ORG,
  batchId: BATCH,
  brandId: 'brand-1',
  campaignId: null,
  state: 'IN_REVIEW',
  round: 1,
  submittedById: 'maker-1',
  submittedAt: new Date('2026-01-15T09:00:00.000Z'),
  decidedById: null,
  decidedAt: null,
  decision: null,
  approvedHash: null,
  expiresAt: null,
  createdById: 'maker-1',
  createdAt: new Date('2026-01-15T09:00:00.000Z'),
  updatedAt: new Date('2026-01-15T09:00:00.000Z'),
  version: 3,
  ...overrides,
});

function buildService(opts: {
  approval?: any;
  posts?: any[];
  post?: any;
  membership?: any;
  allowSelfApproval?: boolean;
  approvalRequiredDefault?: boolean;
  actorFunctions?: string[];
}) {
  const approval = opts.approval ?? makeApproval();
  const posts = opts.posts ?? [makePost()];
  const post = opts.post ?? posts[0];
  const membership =
    opts.membership === undefined
      ? {
          brandId: 'brand-1',
          brand: { id: 'brand-1', approvalRequired: true, deletedAt: null },
        }
      : opts.membership;

  const fakeDb: any = {
    approval: {
      updateMany: jest.fn(async (args: any) => {
        Object.assign(approval, args.data);
        return { count: 1 };
      }),
      create: jest.fn(async () => approval),
    },
    approvalEvent: { create: jest.fn(async () => ({})) },
    contentVersion: { create: jest.fn(async () => ({})) },
  };

  const versions = [
    {
      id: 'cv-1',
      approvalId: approval.id,
      integrationId: 'int-1',
      group: 'group-1',
      versionNo: 1,
      payload: {},
      contentHash: variantHash,
      createdById: 'maker-1',
      creationMethod: 'WEB',
      createdAt: new Date(),
    },
  ];

  const repository: any = {
    transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn({})),
    db: jest.fn(() => fakeDb),
    approvalById: jest.fn(async () => approval),
    approvalByBatch: jest.fn(async () => approval),
    versionsOfApproval: jest.fn(async () => versions),
    eventsOfApproval: jest.fn(async () => []),
    postsOfBatch: jest.fn(async () => posts),
    postsOfGroup: jest.fn(async () => posts),
    postById: jest.fn(async () => post),
    integrationsByIds: jest.fn(async () => [
      { id: 'int-1', providerIdentifier: 'linkedin' },
    ]),
    integrationById: jest.fn(async () => ({
      id: 'int-1',
      providerIdentifier: 'linkedin',
    })),
    brandIntegrationByIntegration: jest.fn(async () => membership),
  };

  const roles: any = {
    getFunctions: jest.fn(async () => opts.actorFunctions ?? ['REVIEWER']),
    getOrgSettings: jest.fn(async () => ({
      approvalRequiredDefault: opts.approvalRequiredDefault ?? false,
      allowSelfApproval: opts.allowSelfApproval ?? false,
      approvalTtlHours: null,
      clientApprovalEnabled: false,
    })),
  };
  const audit: any = { write: jest.fn(async () => ({})), forEntity: jest.fn(async () => []) };
  const notifications: any = { inAppNotification: jest.fn(async () => ({})) };

  const service = new RektrsApprovalsService(
    repository,
    audit,
    roles,
    notifications
  );
  return { service, repository, fakeDb, audit, roles, notifications };
}

const reviewer: RektrsActor = { userId: 'reviewer-1', kind: 'USER' };
const maker: RektrsActor = { userId: 'maker-1', kind: 'USER' };

describe('RektrsApprovalsService.decide', () => {
  it('rejects API-key / MCP principals before touching state', async () => {
    const { service, fakeDb } = buildService({});
    await expect(
      service.decide(ORG, { userId: null, kind: 'API_KEY' }, 'ap-1', {
        decision: 'APPROVE',
      })
    ).rejects.toMatchObject({ code: 'DECISIONS_REQUIRE_HUMAN' });
    expect(fakeDb.approval.updateMany).not.toHaveBeenCalled();
  });

  it('rejects the maker under strict maker-checker (default) and audits the attempt', async () => {
    const { service, fakeDb, audit } = buildService({});
    await expect(
      service.decide(ORG, maker, 'ap-1', { decision: 'APPROVE' })
    ).rejects.toMatchObject({ code: 'MAKER_CHECKER_VIOLATION' });
    expect(fakeDb.approval.updateMany).not.toHaveBeenCalled();
    expect(audit.write).toHaveBeenCalledWith(
      ORG,
      maker,
      expect.objectContaining({ action: 'approval.decide_blocked_maker_checker' })
    );
  });

  it('allows the maker when the org self-approval switch is on, flagged in the event', async () => {
    const { service, fakeDb } = buildService({ allowSelfApproval: true });
    const result: any = await service.decide(ORG, maker, 'ap-1', {
      decision: 'APPROVE',
    });
    expect(result.state).toEqual('APPROVED');
    const eventCall = fakeDb.approvalEvent.create.mock.calls[0][0];
    expect(eventCall.data.metadata.selfApproval).toEqual(true);
  });

  it('approves as a different reviewer, stamps the approved hash and records the event', async () => {
    const { service, fakeDb, audit } = buildService({});
    const result: any = await service.decide(ORG, reviewer, 'ap-1', {
      decision: 'APPROVE',
      comment: 'Looks good',
    });
    expect(result.state).toEqual('APPROVED');
    expect(result.decidedById).toEqual('reviewer-1');
    expect(result.approvedHash).toEqual(batchHash);
    const eventCall = fakeDb.approvalEvent.create.mock.calls[0][0];
    expect(eventCall.data.type).toEqual('APPROVED');
    expect(eventCall.data.metadata.decision).toEqual('APPROVE');
    expect(audit.write).toHaveBeenCalledWith(
      ORG,
      reviewer,
      expect.objectContaining({ action: 'approval.decide' }),
      expect.anything()
    );
  });

  it('requires a comment for REQUEST_CHANGES / REJECT', async () => {
    const { service } = buildService({});
    await expect(
      service.decide(ORG, reviewer, 'ap-1', { decision: 'REQUEST_CHANGES' })
    ).rejects.toMatchObject({ code: 'DECISION_COMMENT_REQUIRED' });
  });

  it('rejects a decision from a stale state', async () => {
    const { service } = buildService({
      approval: makeApproval({ state: 'DRAFT' }),
    });
    await expect(
      service.decide(ORG, reviewer, 'ap-1', { decision: 'APPROVE' })
    ).rejects.toMatchObject({ code: 'APPROVAL_NOT_IN_REVIEW' });
  });
});

describe('RektrsApprovalsService.verifyBatchForGate (Gate A API)', () => {
  it('passes when the live batch still hashes to the approved snapshot', async () => {
    const { service } = buildService({
      approval: makeApproval({ state: 'APPROVED', approvedHash: batchHash }),
    });
    const result = await service.verifyBatchForGate(ORG, BATCH);
    expect(result).toMatchObject({ scoped: true, pass: true, approvalId: 'ap-1' });
  });

  it('passes untouched when the batch channels are not policy-scoped', async () => {
    const { service } = buildService({ membership: null });
    const result = await service.verifyBatchForGate(ORG, BATCH);
    expect(result).toMatchObject({ scoped: false, pass: true });
  });

  it('fails with APPROVAL_REQUIRED while the submission is still in review', async () => {
    const { service } = buildService({
      approval: makeApproval({ state: 'IN_REVIEW', approvedHash: null }),
    });
    const result = await service.verifyBatchForGate(ORG, BATCH);
    expect(result).toMatchObject({ pass: false, reason: 'APPROVAL_REQUIRED' });
  });

  it('fails closed on tampered content; Gate B-style invalidation moves state', async () => {
    const { service, fakeDb } = buildService({
      approval: makeApproval({ state: 'APPROVED', approvedHash: batchHash }),
      posts: [makePost({ content: 'Hello world — silently edited' })],
    });
    const plain = await service.verifyBatchForGate(ORG, BATCH);
    expect(plain).toMatchObject({ pass: false, reason: 'HASH_MISMATCH' });

    const result = await service.verifyBatchForGate(ORG, BATCH, {
      invalidateOnMismatch: true,
    });
    expect(result).toMatchObject({
      pass: false,
      reason: 'HASH_MISMATCH',
      invalidated: true,
    });
    const eventTypes = fakeDb.approvalEvent.create.mock.calls.map(
      (c: any[]) => c[0].data.type
    );
    expect(eventTypes).toContain('INVALIDATED');
  });
});

describe('RektrsApprovalsService.verifyVariantForPublish (Gate B API)', () => {
  it('approved + unchanged variant passes', async () => {
    const { service } = buildService({
      approval: makeApproval({ state: 'SCHEDULED', approvedHash: batchHash }),
    });
    const result = await service.verifyVariantForPublish(ORG, 'post-1');
    expect(result).toMatchObject({ scoped: true, pass: true });
  });

  it('not-yet-approved batches are refused', async () => {
    const { service } = buildService({
      approval: makeApproval({ state: 'IN_REVIEW', approvedHash: null }),
    });
    const result = await service.verifyVariantForPublish(ORG, 'post-1');
    expect(result).toMatchObject({ pass: false, reason: 'APPROVAL_REQUIRED' });
  });

  it('approved but edited variant fails closed', async () => {
    const edited = makePost({ content: 'Edited after approval' });
    const { service } = buildService({
      approval: makeApproval({ state: 'APPROVED', approvedHash: batchHash }),
      posts: [edited],
      post: edited,
    });
    const result = await service.verifyVariantForPublish(ORG, 'post-1');
    expect(result).toMatchObject({ pass: false, reason: 'HASH_MISMATCH' });
  });

  it('unknown post fails closed with POST_NOT_FOUND', async () => {
    const { service, repository } = buildService({});
    repository.postById = jest.fn(async () => null);
    const result = await service.verifyVariantForPublish(ORG, 'missing');
    expect(result).toMatchObject({ pass: false, reason: 'POST_NOT_FOUND' });
  });
});

describe('RektrsApprovalsService.resolveScopeForIntegration', () => {
  it('brand policy scopes the channel', async () => {
    const { service } = buildService({});
    const scope = await service.resolveScopeForIntegration(ORG, 'int-1');
    expect(scope).toMatchObject({ scoped: true, source: 'brand', brandId: 'brand-1' });
  });

  it('org default scopes unassigned channels', async () => {
    const { service } = buildService({
      membership: null,
      approvalRequiredDefault: true,
    });
    const scope = await service.resolveScopeForIntegration(ORG, 'int-9');
    expect(scope).toMatchObject({ scoped: true, source: 'org', brandId: null });
  });

  it('no brand and no org default: not scoped', async () => {
    const { service } = buildService({ membership: null });
    const scope = await service.resolveScopeForIntegration(ORG, 'int-9');
    expect(scope).toMatchObject({ scoped: false, source: 'none' });
  });
});
