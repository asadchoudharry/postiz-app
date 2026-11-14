/**
 * REKTRS W3 — Evergreen Recycler (AUTOMATION-WORKFLOWS.md W3).
 * Pure metrics/style units + the scan engine against in-memory fakes.
 * The provider boundary (RektrsEngagementGateway) is mocked: engagement
 * series are fixtures shaped exactly like the real providers' labelled
 * AnalyticsData[] output, and no real provider is ever called.
 * @jest-environment node
 */
import { Prisma } from '@prisma/client';
import {
  applyEvergreenStyle,
  extractPostMetrics,
  normalizeHookLines,
  pickEvergreenStyle,
  rankEvergreenCandidates,
} from '@gitroom/nestjs-libraries/rektrs/rektrs.evergreen';
import {
  orderThreadRows,
  RektrsEvergreenService,
} from '@gitroom/nestjs-libraries/rektrs/rektrs.evergreen.service';
import { rektrsError } from '@gitroom/nestjs-libraries/rektrs/rektrs.errors';
import { systemActor } from '@gitroom/nestjs-libraries/rektrs/rektrs.actor';

// Keep the suite hermetic: sibling services are constructor-injected fakes.
jest.mock('@gitroom/nestjs-libraries/rektrs/rektrs.alerts.service', () => ({
  RektrsAlertsService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/rektrs/rektrs.repository', () => ({
  RektrsRepository: class {},
}));
jest.mock('@gitroom/nestjs-libraries/rektrs/rektrs.audit.service', () => ({
  RektrsAuditService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/rektrs/rektrs.roles.service', () => ({
  RektrsRolesService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/rektrs/rektrs.evergreen-providers', () => ({
  RektrsEngagementGateway: class {},
}));

const ORG = 'org-1';
/** Monday 2026-11-16 06:00 UTC — the default org schedule window. */
const NOW = new Date(Date.UTC(2026, 10, 16, 6, 0, 0));
const manager: any = { kind: 'USER', userId: 'mgr-1' };

function p2002() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '6.5.0',
  });
}

function series(totals: Record<string, string | number>) {
  return Object.entries(totals).map(([label, total]) => ({
    label,
    percentageChange: 0,
    data: [{ total: String(total), date: '2026-11-16' }],
  }));
}

let postSeq = 0;
function mkPost(over: Record<string, any> = {}) {
  postSeq++;
  return {
    id: `post-${postSeq}`,
    organizationId: ORG,
    integrationId: 'int-1',
    state: 'PUBLISHED',
    publishDate: new Date(NOW.getTime() - 60 * 24 * 3600 * 1000),
    content: `content ${postSeq}`,
    delay: 0,
    group: `group-${postSeq}`,
    batchId: `batch-${postSeq}`,
    title: null,
    description: null,
    parentPostId: null,
    releaseId: `rel-${postSeq}`,
    releaseURL: 'https://example.com/p',
    settings: '{"__type":"facebook"}',
    image: '[{"id":"m1","path":"/uploads/m1.png"}]',
    creationMethod: 'WEB',
    deletedAt: null,
    createdAt: new Date(NOW.getTime() - 60 * 24 * 3600 * 1000),
    updatedAt: new Date(),
    ...over,
  };
}

function buildWorld(opts: { functions?: string[] } = {}) {
  postSeq = 0;
  const state: any = {
    brand: {
      id: 'brand-1',
      organizationId: ORG,
      name: 'Brand One',
      pausedAt: null,
      deletedAt: null,
      channels: [{ id: 'bi-1', brandId: 'brand-1', integrationId: 'int-1' }],
    },
    integrations: new Map([
      [
        'int-1',
        {
          id: 'int-1',
          organizationId: ORG,
          providerIdentifier: 'facebook',
          disabled: false,
          deletedAt: null,
        },
      ],
    ]),
    posts: [] as any[],
    settings: null as any,
    runs: [] as any[],
    copies: [] as any[],
    tagLinks: [] as Array<{ postId: string; tagId: string }>,
    metrics: new Map<string, any>(),
    supportedProviders: new Set(['facebook', 'instagram', 'x']),
    orgSettings: {
      evergreenWeekday: 1,
      evergreenHour: 6,
      alertInAppEnabled: true,
      alertEmailEnabled: true,
    },
    functions: opts.functions ?? ['MANAGER', 'CREATOR', 'ANALYST'],
  };

  const applyData = (row: any, data: any) => {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && 'increment' in (v as any)) {
        row[k] = (row[k] ?? 0) + (v as any).increment;
      } else {
        row[k] = v;
      }
    }
    return row;
  };

  const db: any = {
    evergreenSettings: {
      create: jest.fn(async ({ data }: any) => {
        state.settings = { id: 'egs-1', version: 1, createdAt: new Date(), updatedAt: new Date(), ...data };
        return state.settings;
      }),
      update: jest.fn(async ({ data }: any) => applyData(state.settings, data)),
    },
    evergreenRun: {
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `run-${state.runs.length + 1}`,
          startedAt: new Date(),
          finishedAt: null,
          scannedCount: 0,
          copiedCount: 0,
          skippedReasons: null,
          createdAt: new Date(),
          ...data,
        };
        state.runs.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = state.runs.find((r: any) => r.id === where.id);
        return applyData(row, data);
      }),
    },
    evergreenCopy: {
      create: jest.fn(async ({ data }: any) => {
        const dupe = state.copies.find(
          (c: any) =>
            c.brandId === data.brandId &&
            c.sourcePostId === data.sourcePostId &&
            c.runId === data.runId
        );
        if (dupe) {
          throw p2002();
        }
        const row = { id: `copy-${state.copies.length + 1}`, createdAt: new Date(), ...data };
        state.copies.push(row);
        return row;
      }),
    },
    post: {
      create: jest.fn(async ({ data }: any) => {
        postSeq++;
        const row = {
          id: `post-${postSeq}`,
          releaseId: null,
          releaseURL: null,
          batchId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        state.posts.push(row);
        return row;
      }),
    },
    tagsPosts: {
      createMany: jest.fn(async ({ data }: any) => {
        state.tagLinks.push(...data);
        return { count: data.length };
      }),
    },
  };

  const repo: any = {
    db: () => db,
    transaction: async (cb: any) => cb({}),
    brandById: jest.fn(async () => state.brand),
    evergreenSettingsByBrand: jest.fn(async () => state.settings),
    enabledEvergreenSettings: jest.fn(async () =>
      state.settings?.enabled
        ? [
            {
              ...state.settings,
              brand: {
                ...state.brand,
                channels: state.brand.channels.map((c: any) => ({
                  ...c,
                  integration: state.integrations.get(c.integrationId),
                })),
              },
            },
          ]
        : []
    ),
    integrationsByIds: jest.fn(async (_org: string, ids: string[]) =>
      ids
        .map((id) => state.integrations.get(id))
        .filter((i: any) => i && !i.deletedAt)
    ),
    evergreenCandidates: jest.fn(
      async (_org: string, ids: string[], before: Date) =>
        state.posts
          .filter(
            (p: any) =>
              ids.includes(p.integrationId) &&
              p.state === 'PUBLISHED' &&
              p.parentPostId === null &&
              p.releaseId !== null &&
              p.publishDate <= before &&
              !p.deletedAt
          )
          .sort((a: any, b: any) => b.publishDate - a.publishDate)
          .slice(0, 100)
    ),
    postsOfGroup: jest.fn(async (_org: string, group: string) =>
      state.posts
        .filter((p: any) => p.group === group && !p.deletedAt)
        .sort((a: any, b: any) => a.createdAt - b.createdAt)
    ),
    postById: jest.fn(
      async (_org: string, id: string) =>
        state.posts.find((p: any) => p.id === id && !p.deletedAt) ?? null
    ),
    evergreenCopiesForSource: jest.fn(async (brandId: string, sourcePostId: string) =>
      state.copies.filter(
        (c: any) => c.brandId === brandId && c.sourcePostId === sourcePostId
      )
    ),
    evergreenCopyByCopyPostId: jest.fn(
      async (copyPostId: string) =>
        state.copies.find((c: any) => c.copyPostId === copyPostId) ?? null
    ),
    evergreenCopiesCountForBrand: jest.fn(
      async (brandId: string) =>
        state.copies.filter((c: any) => c.brandId === brandId).length
    ),
    evergreenCopiesOfBrand: jest.fn(async () => state.copies),
    evergreenRunsOfBrand: jest.fn(async () => state.runs),
    lastEvergreenRun: jest.fn(
      async () => state.runs[state.runs.length - 1] ?? null
    ),
    tagsOfPost: jest.fn(async (postId: string) =>
      state.tagLinks.filter((t: any) => t.postId === postId)
    ),
  };

  const audit: any = { write: jest.fn(async () => {}) };
  const roles: any = {
    assertFunction: jest.fn(async (_org: string, actor: any, fn: string) => {
      if (!actor.userId || !state.functions.includes(fn)) {
        throw rektrsError.forbidden(
          'REKTRS_FUNCTION_REQUIRED',
          `The ${fn} function is required for this action`
        );
      }
      return state.functions;
    }),
    getOrgSettings: jest.fn(async () => state.orgSettings),
  };
  const alerts: any = { alertEvergreenCopies: jest.fn(async () => {}) };
  const gateway: any = {
    supports: jest.fn((integration: any) =>
      state.supportedProviders.has(integration.providerIdentifier)
    ),
    fetchPostMetrics: jest.fn(async (_org: string, post: any) => {
      const behaviour = state.metrics.get(post.id);
      if (behaviour instanceof Error) {
        throw behaviour;
      }
      if (behaviour === 'missing') {
        return { kind: 'missing' };
      }
      if (behaviour === 'unsupported') {
        return { kind: 'unsupported' };
      }
      return { kind: 'ok', series: behaviour ?? [] };
    }),
  };

  const service = new RektrsEvergreenService(repo, audit, roles, alerts, gateway);
  return { state, repo, db, audit, roles, alerts, gateway, service };
}

function enableSettings(world: any, over: Record<string, any> = {}) {
  world.state.settings = {
    id: 'egs-1',
    organizationId: ORG,
    brandId: 'brand-1',
    enabled: true,
    minAgeDays: 45,
    topN: 3,
    styleMode: 'VERBATIM',
    hookLines: [],
    createdById: 'mgr-1',
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

// ── Pure domain ──────────────────────────────────────────────────────────────

describe('W3 metrics extraction (pure)', () => {
  it('maps Facebook reactions to likes and ignores impressions/clicks', () => {
    const m = extractPostMetrics(
      series({ Reactions: 40, Clicks: 9, Impressions: 5000 }),
      NOW
    );
    expect(m).toMatchObject({ likes: 40, comments: null, shares: null, score: 40 });
  });

  it('maps X replies/retweets and Threads reposts', () => {
    const m = extractPostMetrics(
      series({ Likes: 3, Replies: 2, Retweets: 4, Quotes: 100 }),
      NOW
    );
    expect(m).toMatchObject({ likes: 3, comments: 2, shares: 4, score: 9 });
  });

  it('uses the latest dated point of a series and sums duplicate labels', () => {
    const m = extractPostMetrics(
      [
        { label: 'Likes', data: [{ total: '5', date: '2026-01-01' }, { total: '8', date: '2026-02-01' }] },
        { label: 'Likes', data: [{ total: '1', date: '2026-02-01' }] },
      ],
      NOW
    );
    expect(m?.likes).toBe(9);
  });

  it('returns null when no engagement counter is measurable (views-only, pinterest-style, empty)', () => {
    expect(extractPostMetrics(series({ Views: 900, Reach: 800 }), NOW)).toBeNull();
    expect(
      extractPostMetrics(series({ Impressions: 10, Saves: 4, 'Pin Clicks': 2 }), NOW)
    ).toBeNull();
    expect(extractPostMetrics([], NOW)).toBeNull();
    expect(extractPostMetrics(null, NOW)).toBeNull();
  });

  it('keeps an all-zero measurement measurable (score 0, not null)', () => {
    const m = extractPostMetrics(series({ Likes: 0, Comments: 0 }), NOW);
    expect(m).toMatchObject({ likes: 0, comments: 0, shares: null, score: 0 });
  });
});

describe('W3 ranking + style (pure)', () => {
  const cand = (id: string, score: number, daysAgo: number) => ({
    item: id,
    metrics: { likes: score, comments: 0, shares: 0, score, series: [], fetchedAt: NOW.toISOString() },
    publishDate: new Date(NOW.getTime() - daysAgo * 24 * 3600 * 1000),
    id,
  });

  it('ranks score desc, then most recent, then id', () => {
    const ranked = rankEvergreenCandidates([
      cand('b', 10, 90),
      cand('a', 10, 90),
      cand('c', 10, 50),
      cand('d', 99, 300),
    ]);
    expect(ranked.map((r) => r.id)).toEqual(['d', 'c', 'a', 'b']);
  });

  it('VERBATIM never hooks; HOOK needs a line; ROTATE alternates and continues across cycles', () => {
    expect(pickEvergreenStyle('VERBATIM', 3, ['H'])).toEqual({ style: 'VERBATIM', hookLine: null });
    expect(pickEvergreenStyle('HOOK', 0, ['H1', 'H2'])).toEqual({ style: 'HOOK', hookLine: 'H1' });
    expect(pickEvergreenStyle('HOOK', 0, [])).toEqual({ style: 'VERBATIM', hookLine: null });
    expect(pickEvergreenStyle('ROTATE', 0, ['H'])).toEqual({ style: 'VERBATIM', hookLine: null });
    expect(pickEvergreenStyle('ROTATE', 1, ['H'])).toEqual({ style: 'HOOK', hookLine: 'H' });
    expect(pickEvergreenStyle('ROTATE', 2, ['H'])).toEqual({ style: 'VERBATIM', hookLine: null });
    expect(pickEvergreenStyle('ROTATE', 3, ['H1', 'H2'])).toEqual({ style: 'HOOK', hookLine: 'H2' });
  });

  it('applies the hook as its own paragraph; verbatim is untouched', () => {
    expect(applyEvergreenStyle('body text', 'HOOK', 'Hook!')).toBe('Hook!\n\nbody text');
    expect(applyEvergreenStyle('body text', 'VERBATIM', 'Hook!')).toBe('body text');
    expect(applyEvergreenStyle('body text', 'HOOK', null)).toBe('body text');
  });

  it('normalises hook lines without case-folding the text', () => {
    expect(normalizeHookLines(['  Throwback! ', 'throwback!', 'New  line', ''])).toEqual([
      'Throwback!',
      'New line',
    ]);
  });

  it('orders a thread by walking the parent chain', () => {
    const root = { id: 'r', parentPostId: null, delay: 0, createdAt: new Date(3) } as any;
    const c2 = { id: 'c2', parentPostId: 'c1', delay: 20, createdAt: new Date(1) } as any;
    const c1 = { id: 'c1', parentPostId: 'r', delay: 10, createdAt: new Date(2) } as any;
    expect(orderThreadRows([c2, c1, root], 'r').map((p) => p.id)).toEqual(['r', 'c1', 'c2']);
  });
});

// ── Settings ─────────────────────────────────────────────────────────────────

describe('W3 settings', () => {
  it('returns documented defaults when no row exists', async () => {
    const w = buildWorld();
    const view = await w.service.getEvergreenSettings(ORG, 'brand-1');
    expect(view).toEqual({
      brandId: 'brand-1',
      enabled: false,
      minAgeDays: 45,
      topN: 3,
      styleMode: 'ROTATE',
      hookLines: [],
      version: null,
    });
  });

  it('creates + updates with version increments and an audit entry', async () => {
    const w = buildWorld();
    const created = await w.service.updateEvergreenSettings(ORG, manager, 'brand-1', {
      enabled: true,
      minAgeDays: 60,
      topN: 2,
      styleMode: 'HOOK',
      hookLines: ['  Throwback Thursday! '],
    });
    expect(created).toMatchObject({ enabled: true, minAgeDays: 60, hookLines: ['Throwback Thursday!'], version: 1 });
    const updated = await w.service.updateEvergreenSettings(ORG, manager, 'brand-1', { topN: 5 }, 1);
    expect(updated).toMatchObject({ topN: 5, version: 2 });
    expect(w.audit.write).toHaveBeenCalledWith(
      ORG,
      manager,
      expect.objectContaining({ action: 'evergreen_settings.update', entityType: 'EvergreenSettings' }),
      expect.anything()
    );
  });

  it('rejects a stale If-Match and a HOOK enable without hook lines', async () => {
    const w = buildWorld();
    enableSettings(w);
    await expect(
      w.service.updateEvergreenSettings(ORG, manager, 'brand-1', { topN: 2 }, 99)
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(
      w.service.updateEvergreenSettings(ORG, manager, 'brand-1', { styleMode: 'HOOK', hookLines: [] })
    ).rejects.toMatchObject({ code: 'EVERGREEN_HOOK_REQUIRED' });
  });

  it('requires the MANAGER function to configure or run', async () => {
    const w = buildWorld({ functions: ['CREATOR'] });
    enableSettings(w);
    await expect(
      w.service.updateEvergreenSettings(ORG, { kind: 'USER', userId: 'u-1' } as any, 'brand-1', { topN: 2 })
    ).rejects.toMatchObject({ code: 'REKTRS_FUNCTION_REQUIRED' });
    await expect(
      w.service.runBrandNow(ORG, { kind: 'USER', userId: 'u-1' } as any, 'brand-1')
    ).rejects.toMatchObject({ code: 'REKTRS_FUNCTION_REQUIRED' });
  });
});

// ── The scan ─────────────────────────────────────────────────────────────────

describe('W3 scan', () => {
  it('copies the top-N by fetched engagement as ordinary DRAFTs and alerts creators', async () => {
    const w = buildWorld();
    enableSettings(w, { topN: 2 });
    const low = mkPost({ content: 'low scorer' });
    const high = mkPost({ content: 'high scorer' });
    const mid = mkPost({ content: 'mid scorer' });
    w.state.posts.push(low, high, mid);
    w.state.metrics.set(low.id, series({ Likes: 5 }));
    w.state.metrics.set(high.id, series({ Likes: 200, Comments: 30, Shares: 12 }));
    w.state.metrics.set(mid.id, series({ Reactions: 50 }));

    const summary = await w.service.scanBrand(ORG, 'brand-1', 'SCHEDULED', systemActor, NOW);
    expect(summary.copiedCount).toBe(2);
    expect(summary.scannedCount).toBe(3);
    expect(summary.copies.map((c) => c.sourcePostId)).toEqual([high.id, mid.id]);

    const drafts = w.state.posts.filter((p: any) => p.state === 'DRAFT');
    expect(drafts).toHaveLength(2);
    expect(drafts.map((d: any) => d.content).sort()).toEqual(['high scorer', 'mid scorer']);
    for (const d of drafts) {
      expect(d.group).not.toBe(high.group);
      expect(d.batchId).toBeTruthy();
      expect(d.releaseId).toBeNull();
    }
    // metrics snapshot carries exactly what was fetched
    const snap = w.state.copies.find((c: any) => c.sourcePostId === high.id);
    expect(snap.metrics).toMatchObject({ likes: 200, comments: 30, shares: 12, score: 242 });
    expect(snap.style).toBe('VERBATIM');
    expect(w.alerts.alertEvergreenCopies).toHaveBeenCalledTimes(1);
    expect(
      w.audit.write.mock.calls.filter((c: any[]) => c[2].action === 'evergreen.copy_created')
    ).toHaveLength(2);
    const run = w.state.runs[0];
    expect(run).toMatchObject({ trigger: 'SCHEDULED', copiedCount: 2, scannedCount: 3 });
    expect(run.finishedAt).toBeTruthy();
  });

  it('respects the age cutoff: a young high scorer is not even a candidate', async () => {
    const w = buildWorld();
    enableSettings(w, { minAgeDays: 45 });
    const young = mkPost({
      publishDate: new Date(NOW.getTime() - 10 * 24 * 3600 * 1000),
    });
    const boundary = mkPost({
      publishDate: new Date(NOW.getTime() - 45 * 24 * 3600 * 1000),
    });
    w.state.posts.push(young, boundary);
    w.state.metrics.set(young.id, series({ Likes: 9999 }));
    w.state.metrics.set(boundary.id, series({ Likes: 1 }));

    const summary = await w.service.scanBrand(ORG, 'brand-1', 'MANUAL', manager, NOW);
    expect(summary.scannedCount).toBe(1);
    expect(summary.copies.map((c) => c.sourcePostId)).toEqual([boundary.id]);
  });

  it('records honest skip reasons and copies nothing when nothing is measurable', async () => {
    const w = buildWorld();
    enableSettings(w);
    const noData = mkPost();
    const viewsOnly = mkPost();
    const boom = mkPost();
    const gone = mkPost();
    const unsupported = mkPost({ integrationId: 'int-2' });
    w.state.integrations.set('int-2', {
      id: 'int-2',
      organizationId: ORG,
      providerIdentifier: 'mastodon',
      disabled: false,
      deletedAt: null,
    });
    w.state.brand.channels.push({ id: 'bi-2', brandId: 'brand-1', integrationId: 'int-2' });
    w.state.posts.push(noData, viewsOnly, boom, gone, unsupported);
    w.state.metrics.set(noData.id, []);
    w.state.metrics.set(viewsOnly.id, series({ Views: 1000, Reach: 900 }));
    w.state.metrics.set(boom.id, new Error('provider down'));
    w.state.metrics.set(gone.id, 'missing');
    w.state.metrics.set(unsupported.id, series({ Likes: 500 }));

    const summary = await w.service.scanBrand(ORG, 'brand-1', 'SCHEDULED', systemActor, NOW);
    expect(summary.copiedCount).toBe(0);
    expect(summary.skippedReasons.counts).toEqual({
      NO_METRICS: 2,
      METRICS_FETCH_FAILED: 1,
      POST_MISSING: 1,
      CHANNEL_UNSUPPORTED: 1,
    });
    expect(w.alerts.alertEvergreenCopies).not.toHaveBeenCalled();
  });

  it('skips a paused brand entirely (scheduled: no run row; manual: BRAND_PAUSED)', async () => {
    const w = buildWorld();
    enableSettings(w);
    w.state.brand.pausedAt = new Date();
    const scheduled = await w.service.scanBrand(ORG, 'brand-1', 'SCHEDULED', systemActor, NOW);
    expect(scheduled.skipped).toBe('BRAND_PAUSED');
    expect(w.state.runs).toHaveLength(0);
    await expect(w.service.runBrandNow(ORG, manager, 'brand-1')).rejects.toMatchObject({
      code: 'BRAND_PAUSED',
    });
  });

  it('refuses a manual run when the recycler is not enabled', async () => {
    const w = buildWorld();
    await expect(w.service.runBrandNow(ORG, manager, 'brand-1')).rejects.toMatchObject({
      code: 'EVERGREEN_NOT_ENABLED',
    });
  });

  it('records a NO_CHANNELS run for a brand without active channels', async () => {
    const w = buildWorld();
    enableSettings(w);
    w.state.brand.channels = [];
    const summary = await w.service.scanBrand(ORG, 'brand-1', 'MANUAL', manager, NOW);
    expect(summary.copiedCount).toBe(0);
    expect(summary.skippedReasons.counts).toEqual({ NO_CHANNELS: 1 });
    expect(w.state.runs).toHaveLength(1);
  });
});

// ── Lineage ──────────────────────────────────────────────────────────────────

describe('W3 lineage', () => {
  it('does not pile up a second pending draft of the same source', async () => {
    const w = buildWorld();
    enableSettings(w);
    const source = mkPost();
    w.state.posts.push(source);
    w.state.metrics.set(source.id, series({ Likes: 10 }));

    const first = await w.service.scanBrand(ORG, 'brand-1', 'MANUAL', manager, NOW);
    expect(first.copiedCount).toBe(1);

    const second = await w.service.scanBrand(ORG, 'brand-1', 'MANUAL', manager, NOW);
    expect(second.copiedCount).toBe(0);
    expect(second.skippedReasons.counts).toEqual({ PENDING_COPY_EXISTS: 1 });
  });

  it('a consumed (published) copy frees the source, and a copy may be recycled exactly once', async () => {
    const w = buildWorld();
    enableSettings(w, { topN: 3 });
    const source = mkPost({ content: 'original winner' });
    w.state.posts.push(source);
    w.state.metrics.set(source.id, series({ Likes: 10 }));

    const run1 = await w.service.scanBrand(ORG, 'brand-1', 'MANUAL', manager, NOW);
    const copy1 = w.state.posts.find((p: any) => p.id === run1.copies[0].copyPostId);
    // The human used the copy: it is now published, old, and measurable.
    copy1.state = 'PUBLISHED';
    copy1.publishDate = new Date(NOW.getTime() - 50 * 24 * 3600 * 1000);
    copy1.releaseId = 'rel-copy-1';
    w.state.metrics.set(copy1.id, series({ Likes: 77 }));

    const run2 = await w.service.scanBrand(ORG, 'brand-1', 'MANUAL', manager, NOW);
    // source is free again (its copy was consumed) AND copy1 gets its one recycle
    expect(run2.copies.map((c) => c.sourcePostId).sort()).toEqual([copy1.id, source.id].sort());

    // copy-of-copy1 is published too; copy1 must never be recycled again.
    const copyOfCopy = w.state.posts.find(
      (p: any) => p.id === run2.copies.find((c) => c.sourcePostId === copy1.id)!.copyPostId
    );
    copyOfCopy.state = 'PUBLISHED';
    copyOfCopy.publishDate = new Date(NOW.getTime() - 50 * 24 * 3600 * 1000);
    copyOfCopy.releaseId = 'rel-copy-2';
    w.state.metrics.set(copyOfCopy.id, series({ Likes: 1 }));
    // also consume run2's fresh copy of the source so it cannot block via PENDING
    const sourceCopy2 = w.state.posts.find(
      (p: any) => p.id === run2.copies.find((c) => c.sourcePostId === source.id)!.copyPostId
    );
    sourceCopy2.state = 'PUBLISHED';
    sourceCopy2.releaseId = 'rel-copy-3';
    w.state.metrics.set(sourceCopy2.id, series({ Likes: 1 }));

    const run3 = await w.service.scanBrand(ORG, 'brand-1', 'MANUAL', manager, NOW);
    expect(run3.skippedReasons.counts.ALREADY_RECYCLED_COPY).toBe(1);
    expect(run3.copies.map((c) => c.sourcePostId)).not.toContain(copy1.id);
  });
});

// ── Copy fidelity + styles ───────────────────────────────────────────────────

describe('W3 copy construction', () => {
  it('HOOK refreshes only the root, carries media/settings/thread verbatim, re-links tags', async () => {
    const w = buildWorld();
    enableSettings(w, { styleMode: 'HOOK', hookLines: ['Throwback!'] });
    const root = mkPost({ content: 'root text', group: 'thread-1' });
    const child = mkPost({
      content: 'reply text',
      group: 'thread-1',
      parentPostId: root.id,
      delay: 30,
      createdAt: new Date(root.createdAt.getTime() + 1000),
    });
    w.state.posts.push(root, child);
    w.state.tagLinks.push({ postId: root.id, tagId: 'tag-1' });
    w.state.metrics.set(root.id, series({ Likes: 12 }));

    const summary = await w.service.scanBrand(ORG, 'brand-1', 'MANUAL', manager, NOW);
    expect(summary.copiedCount).toBe(1);
    expect(summary.copies[0]).toMatchObject({ style: 'HOOK', hookLine: 'Throwback!' });

    const newRoot = w.state.posts.find((p: any) => p.id === summary.copies[0].copyPostId);
    expect(newRoot.content).toBe('Throwback!\n\nroot text');
    expect(newRoot.state).toBe('DRAFT');
    expect(newRoot.image).toBe(root.image);
    expect(newRoot.settings).toBe(root.settings);
    const newChild = w.state.posts.find(
      (p: any) => p.parentPostId === newRoot.id
    );
    expect(newChild.content).toBe('reply text');
    expect(newChild.delay).toBe(30);
    expect(newChild.group).toBe(newRoot.group);
    expect(w.state.tagLinks).toContainEqual({ postId: newRoot.id, tagId: 'tag-1' });
  });

  it('ROTATE continues across cycles: with one historical copy, the next copy is a HOOK', async () => {
    const w = buildWorld();
    enableSettings(w, { styleMode: 'ROTATE', hookLines: ['Again!'], topN: 1 });
    const old = mkPost();
    const fresh = mkPost();
    w.state.posts.push(old, fresh);
    // one historical (consumed) copy of `old`
    w.state.copies.push({
      id: 'copy-hist',
      brandId: 'brand-1',
      sourcePostId: old.id,
      copyPostId: 'gone-copy',
      runId: 'run-hist',
    });
    w.state.metrics.set(fresh.id, series({ Likes: 5 }));
    w.state.metrics.set(old.id, []);

    const summary = await w.service.scanBrand(ORG, 'brand-1', 'MANUAL', manager, NOW);
    expect(summary.copies).toHaveLength(1);
    expect(summary.copies[0]).toMatchObject({ sourcePostId: fresh.id, style: 'HOOK', hookLine: 'Again!' });
  });
});

// ── Scheduled sweep ──────────────────────────────────────────────────────────

describe('W3 scheduled sweep', () => {
  it('fires inside the org window, skips outside it, and honours the 6-day guard', async () => {
    const w = buildWorld();
    enableSettings(w);
    const post = mkPost();
    w.state.posts.push(post);
    w.state.metrics.set(post.id, series({ Likes: 3 }));

    const mondaySix = await w.service.scanAllEnabled(NOW);
    expect(mondaySix).toMatchObject({ brands: 1, due: 1, runs: 1, copies: 1 });

    const mondaySeven = await w.service.scanAllEnabled(
      new Date(Date.UTC(2026, 10, 16, 7, 0, 0))
    );
    expect(mondaySeven).toMatchObject({ runs: 0, notDue: 1 });

    // A manual run two days ago satisfies the week (recency guard).
    const w2 = buildWorld();
    enableSettings(w2);
    w2.state.runs.push({
      id: 'run-recent',
      brandId: 'brand-1',
      startedAt: new Date(NOW.getTime() - 2 * 24 * 3600 * 1000),
    });
    const guarded = await w2.service.scanAllEnabled(NOW);
    expect(guarded).toMatchObject({ runs: 0, recent: 1 });
  });

  it('counts paused brands without running them', async () => {
    const w = buildWorld();
    enableSettings(w);
    w.state.brand.pausedAt = new Date();
    const tallies = await w.service.scanAllEnabled(NOW);
    expect(tallies).toMatchObject({ brands: 1, paused: 1, runs: 0 });
    expect(w.state.runs).toHaveLength(0);
  });
});
