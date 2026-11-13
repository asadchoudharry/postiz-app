/**
 * REKTRS P3-2b — Gate A wiring tests (design P3-1 §4 / §6).
 *
 * PostsService is exercised with a mocked repository, a mocked
 * RektrsApprovalsService and a stubbed startWorkflow, covering the §6
 * bypass matrix for every scheduling funnel:
 *   policy-on + unapproved        → 403, nothing queued, states restored
 *   policy-on + approved + hash ✓ → queued, approval marked SCHEDULED
 *   policy-off / unscoped         → upstream behaviour, unchanged
 * plus the invalidation hook on content edits, the unschedule bookkeeping
 * and the delete-member hook (§4 row 10).
 */
import { PostsService } from './posts.service';
import { RektrsException } from '@gitroom/nestjs-libraries/rektrs/rektrs.errors';

// The HTML-sanitising helpers pull ESM-only DOM chains (isomorphic-dompurify
// / parse5 / jsdom) that jest cannot transform in this repo setup. They are
// irrelevant to the gate wiring, so they are stubbed with pass-throughs.
jest.mock('@gitroom/helpers/utils/sanitize.post.content', () => ({
  sanitizePostContent: (v: unknown) => String(v ?? ''),
  postContentPlainText: (v: unknown) => String(v ?? ''),
}));
jest.mock('@gitroom/helpers/utils/strip.html.validation', () => ({
  stripHtmlValidation: (v: string) => v,
  convertImages: (v: string) => v,
  convertMention: (v: string) => v,
  convertToAscii: (v: string) => v,
}));
jest.mock('jsdom', () => ({ JSDOM: class {} }));
// IntegrationManager imports every social provider (several are ESM-only
// under jest, e.g. nostr-tools). The gate tests stub it via the constructor
// anyway, so the real module is never loaded.
jest.mock(
  '@gitroom/nestjs-libraries/integrations/integration.manager',
  () => ({ IntegrationManager: class {} })
);
// file-type is ESM-only; the storage layer requires it at module load.
jest.mock('file-type', () => ({ fileTypeFromBuffer: async () => undefined }));

const ORG = 'org-1';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  state: 'QUEUE',
  batchId: 'batch-1',
  group: 'g1',
  parentPostId: null,
  integrationId: 'int-1',
  content: 'hello',
  integration: { id: 'int-1', providerIdentifier: 'linkedin' },
  ...over,
});

function makeService() {
  const repository = {
    getPostById: jest.fn(async () => null),
    createOrUpdatePost: jest.fn(async () => ({ posts: [row()] })),
    changeState: jest.fn(async () => ({})),
    changeDate: jest.fn(async () => ({ id: 'p1' })),
    getPostsByBatch: jest.fn(async () => [] as any[]),
    getPostsByGroup: jest.fn(async () => [] as any[]),
    getAnchoredCommentsForPost: jest.fn(async () => [] as any[]),
    deletePost: jest.fn(async () => ({ id: 'p1' })),
  };
  const approvals = {
    verifyBatchForGate: jest.fn(async () => ({
      scoped: false,
      pass: true,
    })),
    resolveScopeForIntegration: jest.fn(async () => ({ scoped: false })),
    markScheduled: jest.fn(async () => ({})),
    markUnscheduled: jest.fn(async () => ({})),
  };
  const service = new PostsService(
    repository as any,
    { getSocialIntegration: () => undefined } as any,
    {} as any,
    {} as any,
    { convertTextToShortLinks: jest.fn(async (_o: any, m: any) => m) } as any,
    {} as any,
    { client: { getRawClient: () => undefined } } as any,
    {} as any,
    approvals as any
  );
  const startWorkflow = jest
    .spyOn(service as any, 'startWorkflow')
    .mockResolvedValue(undefined);
  return { service, repository, approvals, startWorkflow };
}

const channelPost = (id?: string) => ({
  integration: { id: 'int-1' },
  settings: { __type: 'linkedin' },
  date: '2030-01-01T10:00:00',
  value: [{ id, content: 'hello', image: [] }],
});

const body = (type: string, posts: any[]) =>
  ({
    type,
    posts,
    tags: [],
    shortLink: false,
    date: '2030-01-01T10:00:00',
    republish: false,
  }) as any;

const gateCode = (err: unknown) =>
  err instanceof RektrsException ? err.code : undefined;

describe('Gate A — createPost schedule/now funnel (§6 matrix)', () => {
  it('policy-on + no approval → 403 APPROVAL_REQUIRED, workflow never started, post reverted to DRAFT', async () => {
    const { service, repository, approvals, startWorkflow } = makeService();
    approvals.verifyBatchForGate.mockResolvedValue({
      scoped: true,
      pass: false,
      reason: 'APPROVAL_REQUIRED',
    });

    await expect(
      service.createPost(ORG, body('schedule', [channelPost()]), 'WEB' as any)
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });

    expect(startWorkflow).not.toHaveBeenCalled();
    expect(repository.changeState).toHaveBeenCalledWith('p1', 'DRAFT');
    expect(approvals.markScheduled).not.toHaveBeenCalled();
  });

  it('policy-on + APPROVED + hash ok → queued, workflow started, approval marked SCHEDULED', async () => {
    const { service, approvals, startWorkflow } = makeService();
    approvals.verifyBatchForGate.mockResolvedValue({
      scoped: true,
      pass: true,
      state: 'APPROVED',
      approvalId: 'a1',
    });

    const result = await service.createPost(
      ORG,
      body('schedule', [channelPost()]),
      'WEB' as any
    );

    expect(result).toHaveLength(1);
    expect(startWorkflow).toHaveBeenCalledWith(
      'linkedin',
      'p1',
      ORG,
      'QUEUE'
    );
    expect(approvals.markScheduled).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ kind: 'SYSTEM' }),
      'a1'
    );
  });

  it('policy-off (unscoped verdict) → upstream behaviour unchanged, no bookkeeping', async () => {
    const { service, approvals, startWorkflow } = makeService();
    approvals.verifyBatchForGate.mockResolvedValue({
      scoped: false,
      pass: true,
    });

    const result = await service.createPost(
      ORG,
      body('schedule', [channelPost()]),
      'WEB' as any
    );

    expect(result).toHaveLength(1);
    expect(startWorkflow).toHaveBeenCalledWith(
      'linkedin',
      'p1',
      ORG,
      'QUEUE'
    );
    expect(approvals.markScheduled).not.toHaveBeenCalled();
  });

  it("'now' is gated identically to 'schedule'", async () => {
    const { service, approvals, startWorkflow } = makeService();
    approvals.verifyBatchForGate.mockResolvedValue({
      scoped: true,
      pass: false,
      reason: 'APPROVAL_REQUIRED',
    });

    await expect(
      service.createPost(ORG, body('now', [channelPost()]), 'WEB' as any)
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it("fresh 'draft' save → gate never consulted, workflow termination flushed as upstream", async () => {
    const { service, repository, approvals, startWorkflow } = makeService();
    repository.createOrUpdatePost.mockResolvedValue({
      posts: [row({ state: 'DRAFT' })],
    });

    const result = await service.createPost(
      ORG,
      body('draft', [channelPost()]),
      'WEB' as any
    );

    expect(result).toHaveLength(1);
    expect(approvals.verifyBatchForGate).not.toHaveBeenCalled();
    expect(startWorkflow).toHaveBeenCalledWith(
      'linkedin',
      'p1',
      ORG,
      'DRAFT'
    );
  });
});

describe('Invalidation hook — createPost type update (§4 rows 8/9)', () => {
  it('content edit on a SCHEDULED submission → edit succeeds, submission invalidated, batch dequeued', async () => {
    const { service, repository, approvals, startWorkflow } = makeService();
    repository.getPostsByBatch.mockResolvedValue([row()]);
    approvals.verifyBatchForGate.mockResolvedValue({
      scoped: true,
      pass: false,
      reason: 'HASH_MISMATCH',
      invalidated: true,
      approvalId: 'a1',
      state: 'SCHEDULED',
    });

    const result = await service.createPost(
      ORG,
      body('update', [channelPost('p1')]),
      'WEB' as any
    );

    expect(result).toHaveLength(1);
    expect(approvals.verifyBatchForGate).toHaveBeenCalledWith(
      ORG,
      'batch-1',
      { invalidateOnMismatch: true }
    );
    expect(repository.changeState).toHaveBeenCalledWith('p1', 'DRAFT');
    expect(startWorkflow).toHaveBeenCalledWith('main', 'p1', ORG, 'DRAFT');
  });

  it('no-op settings save (hash still matches) → nothing dequeued', async () => {
    const { service, repository, approvals } = makeService();
    approvals.verifyBatchForGate.mockResolvedValue({
      scoped: true,
      pass: true,
      state: 'SCHEDULED',
      approvalId: 'a1',
    });

    await service.createPost(
      ORG,
      body('update', [channelPost('p1')]),
      'WEB' as any
    );

    expect(repository.changeState).not.toHaveBeenCalled();
  });
});

describe('Gate A2 — changeDate funnel (§4 row 2)', () => {
  it('schedule on a QUEUE post with a tampered hash → 403 HASH_MISMATCH, date untouched, batch dequeued', async () => {
    const { service, repository, approvals } = makeService();
    repository.getPostById.mockResolvedValue(row());
    approvals.verifyBatchForGate.mockResolvedValue({
      scoped: true,
      pass: false,
      reason: 'HASH_MISMATCH',
      invalidated: true,
      approvalId: 'a1',
      state: 'SCHEDULED',
    });

    await expect(
      service.changeDate(ORG, 'p1', '2030-02-01T10:00:00', 'schedule')
    ).rejects.toMatchObject({ code: 'HASH_MISMATCH' });

    expect(repository.changeDate).not.toHaveBeenCalled();
    expect(repository.changeState).toHaveBeenCalledWith('p1', 'DRAFT');
  });

  it('schedule on a QUEUE post, verdict SCHEDULED + hash ok → rescheduled, no duplicate SCHEDULED transition', async () => {
    const { service, repository, approvals } = makeService();
    repository.getPostById.mockResolvedValue(row());
    approvals.verifyBatchForGate.mockResolvedValue({
      scoped: true,
      pass: true,
      state: 'SCHEDULED',
      approvalId: 'a1',
    });

    await service.changeDate(ORG, 'p1', '2030-02-01T10:00:00', 'schedule');

    expect(repository.changeDate).toHaveBeenCalled();
    expect(approvals.markScheduled).not.toHaveBeenCalled();
  });

  it("action 'update' (date-only) → gate never consulted", async () => {
    const { service, repository, approvals } = makeService();
    repository.getPostById.mockResolvedValue(row());

    await service.changeDate(ORG, 'p1', '2030-02-01T10:00:00', 'update');

    expect(approvals.verifyBatchForGate).not.toHaveBeenCalled();
    expect(repository.changeDate).toHaveBeenCalled();
  });

  it('schedule on a DRAFT post only assigns a date in this codebase → not gated here', async () => {
    const { service, repository, approvals } = makeService();
    repository.getPostById.mockResolvedValue(row({ state: 'DRAFT' }));

    await service.changeDate(ORG, 'p1', '2030-02-01T10:00:00', 'schedule');

    expect(approvals.verifyBatchForGate).not.toHaveBeenCalled();
    expect(repository.changeDate).toHaveBeenCalled();
  });
});

describe('Gate A — changePostStatus funnel (public API)', () => {
  it("status 'schedule' on an unapproved scoped post → 403, state untouched", async () => {
    const { service, repository, approvals } = makeService();
    repository.getPostById.mockResolvedValue(row({ state: 'DRAFT' }));
    approvals.verifyBatchForGate.mockResolvedValue({
      scoped: true,
      pass: false,
      reason: 'APPROVAL_REQUIRED',
    });

    await expect(
      service.changePostStatus(ORG, 'p1', 'schedule')
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(repository.changeState).not.toHaveBeenCalled();
  });

  it("status 'schedule' on an APPROVED batch → queued + marked SCHEDULED", async () => {
    const { service, repository, approvals } = makeService();
    repository.getPostById.mockResolvedValue(row({ state: 'DRAFT' }));
    approvals.verifyBatchForGate.mockResolvedValue({
      scoped: true,
      pass: true,
      state: 'APPROVED',
      approvalId: 'a1',
    });

    const result = await service.changePostStatus(ORG, 'p1', 'schedule');

    expect(result).toEqual({ id: 'p1', state: 'QUEUE' });
    expect(repository.changeState).toHaveBeenCalledWith('p1', 'QUEUE');
    expect(approvals.markScheduled).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ kind: 'SYSTEM' }),
      'a1'
    );
  });

  it("status 'draft' on a SCHEDULED submission → approval returns to APPROVED (markUnscheduled)", async () => {
    const { service, repository, approvals } = makeService();
    repository.getPostById.mockResolvedValue(row());
    approvals.verifyBatchForGate.mockResolvedValue({
      scoped: true,
      pass: true,
      state: 'SCHEDULED',
      approvalId: 'a1',
    });

    const result = await service.changePostStatus(ORG, 'p1', 'draft');

    expect(result).toEqual({ id: 'p1', state: 'DRAFT' });
    expect(approvals.markUnscheduled).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ kind: 'SYSTEM' }),
      'a1'
    );
  });
});

describe('W5 kill-switch — BRAND_PAUSED at Gate A', () => {
  it("status 'schedule' on a batch-less post of a PAUSED brand → 403 BRAND_PAUSED, state untouched", async () => {
    const { service, repository, approvals } = makeService();
    repository.getPostById.mockResolvedValue(
      row({ state: 'DRAFT', batchId: null })
    );
    approvals.resolveScopeForIntegration.mockResolvedValue({
      scoped: false,
      brandId: 'brand-1',
      brandPaused: true,
    });

    await expect(
      service.changePostStatus(ORG, 'p1', 'schedule')
    ).rejects.toMatchObject({ code: 'BRAND_PAUSED' });
    expect(repository.changeState).not.toHaveBeenCalled();
    expect(approvals.verifyBatchForGate).not.toHaveBeenCalled();
  });

  it("status 'schedule' on a batch-less post of a live brand → proceeds unscoped", async () => {
    const { service, repository, approvals } = makeService();
    repository.getPostById.mockResolvedValue(
      row({ state: 'DRAFT', batchId: null })
    );
    approvals.resolveScopeForIntegration.mockResolvedValue({
      scoped: false,
      brandId: 'brand-1',
      brandPaused: false,
    });

    const result = await service.changePostStatus(ORG, 'p1', 'schedule');

    expect(result).toEqual({ id: 'p1', state: 'QUEUE' });
    expect(repository.changeState).toHaveBeenCalledWith('p1', 'QUEUE');
  });

  it('createPost schedule with a batch-less post on a PAUSED brand → 403 BRAND_PAUSED, workflow never started, post reverted', async () => {
    const { service, repository, approvals, startWorkflow } = makeService();
    repository.createOrUpdatePost.mockResolvedValue({
      posts: [row({ batchId: null })],
    });
    approvals.resolveScopeForIntegration.mockResolvedValue({
      scoped: false,
      brandId: 'brand-1',
      brandPaused: true,
    });

    await expect(
      service.createPost(ORG, body('schedule', [channelPost('p1')]), 'WEB' as any)
    ).rejects.toMatchObject({ code: 'BRAND_PAUSED' });

    expect(startWorkflow).not.toHaveBeenCalled();
    expect(repository.changeState).toHaveBeenCalledWith('p1', 'DRAFT');
  });

  it('changeDate schedule with a BRAND_PAUSED verdict → 403, approval NOT invalidated, nothing dequeued', async () => {
    const { service, repository, approvals } = makeService();
    repository.getPostById.mockResolvedValue(row());
    approvals.verifyBatchForGate.mockResolvedValue({
      scoped: true,
      pass: false,
      reason: 'BRAND_PAUSED',
      approvalId: 'a1',
      state: 'APPROVED',
    });

    await expect(
      service.changeDate(ORG, 'p1', '2030-02-01T10:00:00', 'schedule')
    ).rejects.toMatchObject({ code: 'BRAND_PAUSED' });

    expect(approvals.markUnscheduled).not.toHaveBeenCalled();
    expect(repository.changeState).not.toHaveBeenCalled();
    expect(repository.changeDate).not.toHaveBeenCalled();
  });
});

describe('Delete-member hook (§4 row 10)', () => {
  it('deleting a group of an APPROVED/SCHEDULED batch → survivors dequeued after invalidation', async () => {
    const { service, repository, approvals, startWorkflow } = makeService();
    const survivor = row({ id: 'p2', group: 'g2' });
    repository.getPostsByGroup.mockResolvedValue([row()]);
    repository.getPostsByBatch.mockResolvedValue([survivor]);
    approvals.verifyBatchForGate.mockResolvedValue({
      scoped: true,
      pass: false,
      reason: 'HASH_MISMATCH',
      invalidated: true,
      approvalId: 'a1',
      state: 'SCHEDULED',
    });

    const result = await service.deletePost(ORG, 'g1');

    expect(result).toEqual({ id: 'p1' });
    expect(approvals.verifyBatchForGate).toHaveBeenCalledWith(
      ORG,
      'batch-1',
      { invalidateOnMismatch: true }
    );
    expect(repository.changeState).toHaveBeenCalledWith('p2', 'DRAFT');
    expect(startWorkflow).toHaveBeenCalledWith('main', 'p2', ORG, 'DRAFT');
  });
});

describe('error surface', () => {
  it('gate failures are RektrsException 403s carrying the stable code', async () => {
    const { service, approvals } = makeService();
    approvals.verifyBatchForGate.mockResolvedValue({
      scoped: true,
      pass: false,
      reason: 'APPROVAL_EXPIRED',
      approvalId: 'a1',
      state: 'APPROVED',
    });

    const err = await service
      .createPost(ORG, body('schedule', [channelPost()]), 'WEB' as any)
      .catch((e) => e);

    expect(err).toBeInstanceOf(RektrsException);
    expect(gateCode(err)).toBe('APPROVAL_EXPIRED');
    expect((err as RektrsException).getStatus()).toBe(403);
  });
});
