/**
 * RektrsBrandControlService — W5 crisis kill-switch (pause pull-back,
 * resume restore through Gate A, idempotency, skip reporting).
 * Ephemeral jest (same harness style as the other rektrs suites).
 * @jest-environment node
 */
import {
  RektrsBrandControlService,
  snapshotRoots,
} from '@gitroom/nestjs-libraries/rektrs/rektrs.brand-control.service';
import { RektrsException } from '@gitroom/nestjs-libraries/rektrs/rektrs.errors';

// Same ESM-chain stubs as posts.service.rektrs.spec.ts: the brand-control
// service references PostsService (constructor injection), whose module
// graph pulls isomorphic-dompurify / jsdom / provider packages jest cannot
// transform here. PostsService itself is mocked in every test below.
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
jest.mock(
  '@gitroom/nestjs-libraries/integrations/integration.manager',
  () => ({ IntegrationManager: class {} })
);
jest.mock('file-type', () => ({ fileTypeFromBuffer: async () => undefined }));

const ORG = 'org-1';
const manager: any = { kind: 'USER', userId: 'mgr-1' };
const D1 = new Date('2026-02-01T10:00:00.000Z');
const D2 = new Date('2026-02-02T11:00:00.000Z');

function post(id: string, group: string, over: Record<string, any> = {}) {
  return {
    id,
    group,
    parentPostId: null,
    integrationId: 'int-1',
    state: 'QUEUE',
    publishDate: D1,
    batchId: 'batch-1',
    ...over,
  };
}

function buildWorld(opts: {
  paused?: boolean;
  queued?: any[];
  gateRefusals?: Record<string, string>;
} = {}) {
  const brand: any = {
    id: 'brand-1',
    organizationId: ORG,
    name: 'Brand One',
    approvalRequired: true,
    pausedAt: opts.paused ? new Date('2026-01-19T09:00:00.000Z') : null,
    pausedById: opts.paused ? 'mgr-1' : null,
    pauseReason: opts.paused ? 'earlier pause' : null,
    channels: [{ integrationId: 'int-1' }],
    version: 1,
  };
  const postsById = new Map<string, any>();
  let queued: any[] = opts.queued ?? [];
  for (const p of queued) {
    postsById.set(p.id, p);
  }
  const snapshots: any[] = [];
  const auditEntries: any[] = [];

  const fakeDb = {
    brand: {
      updateMany: jest.fn(async (args: any) => {
        if (args.where.pausedAt === null && brand.pausedAt) {
          return { count: 0 }; // lost the claim race
        }
        if ('pausedAt' in args.data) brand.pausedAt = args.data.pausedAt;
        if ('pausedById' in args.data) brand.pausedById = args.data.pausedById;
        if ('pauseReason' in args.data)
          brand.pauseReason = args.data.pauseReason;
        return { count: 1 };
      }),
    },
    brandPausedPost: {
      createMany: jest.fn(async (args: any) => {
        for (const row of args.data) {
          if (!snapshots.some((s) => s.postId === row.postId)) {
            snapshots.push({ ...row });
          }
        }
        return { count: args.data.length };
      }),
      deleteMany: jest.fn(async () => {
        const count = snapshots.length;
        snapshots.length = 0;
        return { count };
      }),
    },
  };

  const repository: any = {
    db: jest.fn((_tx?: any) => fakeDb),
    transaction: jest.fn(async (fn: any) => fn(undefined)),
    queuedPostsOfChannels: jest.fn(async () => queued),
    brandPausedPosts: jest.fn(async () => [...snapshots]),
    postById: jest.fn(async (_org: string, id: string) => postsById.get(id) ?? null),
  };
  const catalog: any = {
    getBrand: jest.fn(async () => brand),
  };
  const audit: any = {
    write: jest.fn(async (_org: string, _actor: any, input: any) => {
      auditEntries.push(input);
      return {};
    }),
  };
  const posts: any = {
    rektrsDequeueBrandPosts: jest.fn(async (_org: string, rows: any[]) => {
      for (const row of rows) {
        const stored = postsById.get(row.id);
        if (stored) stored.state = 'DRAFT';
      }
      queued = [];
    }),
    changeDate: jest.fn(async () => ({})),
    changePostStatus: jest.fn(async (_org: string, id: string) => {
      const refusal = opts.gateRefusals?.[id];
      if (refusal) {
        throw new RektrsException(403, refusal, `gate refused: ${refusal}`);
      }
      const stored = postsById.get(id);
      if (stored) stored.state = 'QUEUE';
      return { id, state: 'QUEUE' };
    }),
    rektrsRestoreGroupMembers: jest.fn(async () => ({})),
  };
  const alerts: any = {
    alertBrandPaused: jest.fn(async () => ({})),
    alertBrandResumed: jest.fn(async () => ({})),
  };

  const service = new RektrsBrandControlService(
    repository,
    audit,
    catalog,
    posts,
    alerts
  );
  return {
    service,
    brand,
    postsById,
    snapshots,
    auditEntries,
    repository,
    catalog,
    posts,
    alerts,
    fakeDb,
    getQueued: () => queued,
    addPost: (p: any) => postsById.set(p.id, p),
  };
}

describe('W5 pause — pull-back', () => {
  it('marks the brand, snapshots one root per group with its date, dequeues EVERY queued row, audits + alerts', async () => {
    const world = buildWorld({
      queued: [
        post('p1', 'g1'),
        post('p2', 'g1', { parentPostId: 'p1' }),
        post('p3', 'g2', { publishDate: D2, batchId: 'batch-2' }),
      ],
    });
    const result = await world.service.pauseBrand(ORG, manager, 'brand-1', 'Bad creative');

    expect(result.alreadyPaused).toEqual(false);
    expect(result.pulledCount).toEqual(2); // roots only: p1 + p3
    expect(world.brand.pausedAt).toBeInstanceOf(Date);
    expect(world.brand.pausedById).toEqual('mgr-1');
    expect(world.brand.pauseReason).toEqual('Bad creative');
    expect(world.snapshots).toEqual([
      expect.objectContaining({ postId: 'p1', group: 'g1', publishDate: D1 }),
      expect.objectContaining({ postId: 'p3', group: 'g2', publishDate: D2 }),
    ]);
    // every queued row (incl. the child) went back through dequeue
    expect(world.posts.rektrsDequeueBrandPosts).toHaveBeenCalledTimes(1);
    expect(
      world.posts.rektrsDequeueBrandPosts.mock.calls[0][1].map((p: any) => p.id)
    ).toEqual(['p1', 'p2', 'p3']);
    expect(world.postsById.get('p2')!.state).toEqual('DRAFT');
    expect(world.auditEntries).toContainEqual(
      expect.objectContaining({
        action: 'brand.pause',
        metadata: expect.objectContaining({ pulledCount: 2 }),
      })
    );
    expect(world.alerts.alertBrandPaused).toHaveBeenCalledTimes(1);
  });

  it('pausing with nothing queued still marks + audits (pulledCount 0)', async () => {
    const world = buildWorld({ queued: [] });
    const result = await world.service.pauseBrand(ORG, manager, 'brand-1');
    expect(result.pulledCount).toEqual(0);
    expect(world.brand.pausedAt).toBeInstanceOf(Date);
    expect(world.posts.rektrsDequeueBrandPosts).not.toHaveBeenCalled();
    expect(world.auditEntries).toContainEqual(
      expect.objectContaining({ action: 'brand.pause' })
    );
  });

  it('idempotent: pausing an already-paused brand with nothing new queued is a silent no-op', async () => {
    const world = buildWorld({ paused: true, queued: [] });
    const result = await world.service.pauseBrand(ORG, manager, 'brand-1');
    expect(result.alreadyPaused).toEqual(true);
    expect(result.pulledCount).toEqual(0);
    expect(world.fakeDb.brandPausedPost.createMany).not.toHaveBeenCalled();
    expect(world.posts.rektrsDequeueBrandPosts).not.toHaveBeenCalled();
    expect(world.alerts.alertBrandPaused).not.toHaveBeenCalled();
  });

  it('completion: a post queued AFTER the pause is still pulled by a re-pause', async () => {
    const world = buildWorld({
      paused: true,
      queued: [post('p9', 'g9')],
    });
    const result = await world.service.pauseBrand(ORG, manager, 'brand-1');
    expect(result.alreadyPaused).toEqual(true);
    expect(result.pulledCount).toEqual(1);
    expect(world.snapshots.map((s) => s.postId)).toEqual(['p9']);
    expect(world.postsById.get('p9')!.state).toEqual('DRAFT');
  });
});

describe('W5 resume — restore through the gate', () => {
  function pausedWorld(opts: { gateRefusals?: Record<string, string> } = {}) {
    const world = buildWorld({ paused: true, gateRefusals: opts.gateRefusals });
    world.addPost(post('p1', 'g1', { state: 'DRAFT' }));
    world.addPost(post('p3', 'g2', { state: 'DRAFT', publishDate: D2, batchId: 'batch-2' }));
    world.snapshots.push(
      { brandId: 'brand-1', postId: 'p1', group: 'g1', batchId: 'batch-1', publishDate: D1 },
      { brandId: 'brand-1', postId: 'p3', group: 'g2', batchId: 'batch-2', publishDate: D2 }
    );
    return world;
  }

  it('lifts the pause, restores dates, re-queues via changePostStatus, restores group members, consumes the snapshot', async () => {
    const world = pausedWorld();
    const result = await world.service.resumeBrand(ORG, manager, 'brand-1');

    expect(result.alreadyLive).toEqual(false);
    expect(result.restored).toEqual(['p1', 'p3']);
    expect(result.skipped).toEqual([]);
    expect(world.brand.pausedAt).toEqual(null);
    expect(world.snapshots).toHaveLength(0);
    expect(world.posts.changeDate).toHaveBeenCalledWith(
      ORG,
      'p1',
      D1.toISOString(),
      'update'
    );
    expect(world.posts.changePostStatus).toHaveBeenCalledWith(ORG, 'p1', 'schedule');
    expect(world.posts.rektrsRestoreGroupMembers).toHaveBeenCalledWith(ORG, 'g1');
    expect(world.posts.rektrsRestoreGroupMembers).toHaveBeenCalledWith(ORG, 'g2');
    expect(world.auditEntries.map((a) => a.action)).toEqual([
      'brand.resume',
      'brand.resume_posts',
    ]);
    expect(world.alerts.alertBrandResumed).toHaveBeenCalledWith(
      ORG,
      expect.anything(),
      2,
      0
    );
  });

  it('a post whose approval lapsed while paused stays a draft and is reported; the brand still resumes', async () => {
    const world = pausedWorld({ gateRefusals: { p3: 'APPROVAL_REQUIRED' } });
    const result = await world.service.resumeBrand(ORG, manager, 'brand-1');

    expect(result.restored).toEqual(['p1']);
    expect(result.skipped).toEqual([
      expect.objectContaining({ postId: 'p3', reason: 'APPROVAL_REQUIRED' }),
    ]);
    expect(world.brand.pausedAt).toEqual(null);
    expect(world.postsById.get('p3')!.state).toEqual('DRAFT');
    expect(world.alerts.alertBrandResumed).toHaveBeenCalledWith(
      ORG,
      expect.anything(),
      1,
      1
    );
  });

  it('a snapshot whose post is no longer a draft is skipped untouched (NOT_DRAFT)', async () => {
    const world = pausedWorld();
    world.postsById.get('p3')!.state = 'QUEUE'; // re-queued by hand meanwhile
    const result = await world.service.resumeBrand(ORG, manager, 'brand-1');
    expect(result.restored).toEqual(['p1']);
    expect(result.skipped).toEqual([
      expect.objectContaining({ postId: 'p3', reason: 'NOT_DRAFT' }),
    ]);
    expect(world.posts.changePostStatus).not.toHaveBeenCalledWith(ORG, 'p3', 'schedule');
  });

  it('a snapshot whose post was deleted is skipped (POST_NOT_FOUND)', async () => {
    const world = buildWorld({ paused: true });
    world.snapshots.push({
      brandId: 'brand-1',
      postId: 'gone',
      group: 'gx',
      batchId: null,
      publishDate: D1,
    });
    const result = await world.service.resumeBrand(ORG, manager, 'brand-1');
    expect(result.skipped).toEqual([
      expect.objectContaining({ postId: 'gone', reason: 'POST_NOT_FOUND' }),
    ]);
    expect(world.brand.pausedAt).toEqual(null);
  });

  it('idempotent: resuming a live brand is a no-op success', async () => {
    const world = buildWorld({ paused: false });
    const result = await world.service.resumeBrand(ORG, manager, 'brand-1');
    expect(result.alreadyLive).toEqual(true);
    expect(result.restored).toEqual([]);
    expect(world.fakeDb.brand.updateMany).not.toHaveBeenCalled();
    expect(world.posts.changePostStatus).not.toHaveBeenCalled();
    expect(world.alerts.alertBrandResumed).not.toHaveBeenCalled();
  });
});

describe('snapshotRoots', () => {
  it('picks the parentless row per group', () => {
    const roots = snapshotRoots([
      post('c1', 'g', { parentPostId: 'r1' }),
      post('r1', 'g'),
      post('solo', 'h'),
    ] as any);
    expect(roots.map((r) => r.id).sort()).toEqual(['r1', 'solo']);
  });

  it('falls back to the first row when every parent is outside the set', () => {
    const roots = snapshotRoots([
      post('c1', 'g', { parentPostId: 'missing' }),
      post('c2', 'g', { parentPostId: 'c1' }),
    ] as any);
    expect(roots.map((r) => r.id)).toEqual(['c1']);
  });
});
