/**
 * REKTRS W4 — Milestone Auto-CTA (AUTOMATION-WORKFLOWS.md W4).
 * Pure domain units + the scan engine against in-memory fakes. Both
 * provider boundaries are mocked (RektrsEngagementGateway for metrics,
 * RektrsCtaCommentGateway for the comment write): engagement series are
 * fixtures shaped like the real providers' labelled AnalyticsData[]
 * output, comment posts are recorded, and no real provider is called.
 * @jest-environment node
 */
import { Prisma } from '@prisma/client';
import {
  buildCtaCommentText,
  crossesLikeThreshold,
  normalizeCtaUrl,
} from '@gitroom/nestjs-libraries/rektrs/rektrs.milestone-cta';
import { RektrsMilestoneCtaService } from '@gitroom/nestjs-libraries/rektrs/rektrs.milestone-cta.service';
import { rektrsError } from '@gitroom/nestjs-libraries/rektrs/rektrs.errors';

// Keep the suite hermetic: sibling services are constructor-injected fakes.
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
jest.mock(
  '@gitroom/nestjs-libraries/rektrs/rektrs.milestone-cta-providers',
  () => ({
    RektrsCtaCommentGateway: class {},
  })
);

const ORG = 'org-1';
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
    publishDate: new Date(NOW.getTime() - 2 * 24 * 3600 * 1000),
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
    image: '[]',
    creationMethod: 'WEB',
    deletedAt: null,
    createdAt: new Date(NOW.getTime() - 2 * 24 * 3600 * 1000),
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
          token: 'token-1',
          internalId: 'page-1',
        },
      ],
    ]),
    posts: [] as any[],
    settings: null as any,
    runs: [] as any[],
    actions: [] as any[],
    metrics: new Map<string, any>(),
    supportedProviders: new Set(['facebook', 'instagram', 'x', 'youtube']),
    commentProviders: new Set(['facebook', 'instagram', 'x']),
    commentCalls: [] as any[],
    commentBehaviour: new Map<string, any>(),
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
    milestoneCtaSettings: {
      create: jest.fn(async ({ data }: any) => {
        state.settings = {
          id: 'mcs-1',
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        return state.settings;
      }),
      update: jest.fn(async ({ data }: any) => applyData(state.settings, data)),
    },
    milestoneCtaRun: {
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `run-${state.runs.length + 1}`,
          startedAt: new Date(),
          finishedAt: null,
          scannedCount: 0,
          postedCount: 0,
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
    milestoneCtaAction: {
      create: jest.fn(async ({ data }: any) => {
        const dupe = state.actions.find(
          (a: any) => a.brandId === data.brandId && a.postId === data.postId
        );
        if (dupe) {
          throw p2002();
        }
        const row = {
          id: `action-${state.actions.length + 1}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        state.actions.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = state.actions.find((a: any) => a.id === where.id);
        return applyData(row, { ...data, updatedAt: new Date() });
      }),
    },
  };

  const repo: any = {
    db: () => db,
    transaction: async (cb: any) => cb({}),
    brandById: jest.fn(async () => state.brand),
    milestoneCtaSettingsByBrand: jest.fn(async () => state.settings),
    enabledMilestoneCtaSettings: jest.fn(async () =>
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
    milestoneCtaCandidates: jest.fn(
      async (_org: string, ids: string[], since: Date) =>
        state.posts
          .filter(
            (p: any) =>
              ids.includes(p.integrationId) &&
              p.state === 'PUBLISHED' &&
              p.parentPostId === null &&
              p.releaseId !== null &&
              p.publishDate >= since &&
              !p.deletedAt
          )
          .sort((a: any, b: any) => b.publishDate - a.publishDate)
          .slice(0, 100)
    ),
    milestoneCtaActionForPost: jest.fn(
      async (brandId: string, postId: string) =>
        state.actions.find(
          (a: any) => a.brandId === brandId && a.postId === postId
        ) ?? null
    ),
    milestoneCtaActionsOfBrand: jest.fn(async () => state.actions),
    milestoneCtaRunsOfBrand: jest.fn(async () => state.runs),
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
  };
  const engagement: any = {
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
  const comments: any = {
    supports: jest.fn((integration: any) =>
      state.commentProviders.has(integration.providerIdentifier)
    ),
    postComment: jest.fn(
      async (_org: string, integration: any, post: any, message: string) => {
        state.commentCalls.push({ postId: post.id, message });
        const behaviour = state.commentBehaviour.get(post.id);
        if (behaviour instanceof Error) {
          throw behaviour;
        }
        return { commentId: `comment-for-${post.id}` };
      }
    ),
  };

  const service = new RektrsMilestoneCtaService(
    repo,
    audit,
    roles,
    engagement,
    comments
  );
  return { state, repo, db, audit, roles, engagement, comments, service };
}

function enableSettings(world: any, over: Record<string, any> = {}) {
  world.state.settings = {
    id: 'mcs-1',
    organizationId: ORG,
    brandId: 'brand-1',
    enabled: true,
    likeThreshold: 20,
    ctaText: 'Grab the full guide',
    ctaUrl: 'https://example.com/guide',
    createdById: 'mgr-1',
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

// ── Pure domain ─────────────────────────────────────────────────────────────
describe('W4 pure domain', () => {
  it('threshold: only a measured count at or above the threshold crosses', () => {
    expect(crossesLikeThreshold(20, 20)).toBe(true);
    expect(crossesLikeThreshold(21, 20)).toBe(true);
    expect(crossesLikeThreshold(19, 20)).toBe(false);
    expect(crossesLikeThreshold(0, 20)).toBe(false);
    expect(crossesLikeThreshold(null, 20)).toBe(false);
  });

  it('comment text: text + verbatim URL, either part may stand alone', () => {
    expect(buildCtaCommentText('Read more', 'https://example.com/a')).toBe(
      'Read more\nhttps://example.com/a'
    );
    expect(buildCtaCommentText('Read more', '')).toBe('Read more');
    expect(buildCtaCommentText('', 'https://example.com/a')).toBe(
      'https://example.com/a'
    );
    // whitespace is normalised; the URL is never rewritten (P5 hook)
    expect(buildCtaCommentText('  Read   more  ', 'https://example.com/a')).toBe(
      'Read more\nhttps://example.com/a'
    );
  });

  it('URL normalisation: http(s) only, empty stays empty, junk is null', () => {
    expect(normalizeCtaUrl('')).toBe('');
    expect(normalizeCtaUrl('  https://example.com/x ')).toBe(
      'https://example.com/x'
    );
    expect(normalizeCtaUrl('ftp://example.com/x')).toBeNull();
    expect(normalizeCtaUrl('not a url')).toBeNull();
    expect(normalizeCtaUrl('javascript:alert(1)')).toBeNull();
  });
});

// ── Settings ────────────────────────────────────────────────────────────────
describe('W4 settings', () => {
  it('defaults are returned when nothing was ever saved', async () => {
    const w = buildWorld();
    const view = await w.service.getCtaSettings(ORG, 'brand-1');
    expect(view).toEqual({
      brandId: 'brand-1',
      enabled: false,
      likeThreshold: 20,
      ctaText: '',
      ctaUrl: '',
      version: null,
    });
  });

  it('create + update round-trip with If-Match optimistic concurrency', async () => {
    const w = buildWorld();
    const created = await w.service.updateCtaSettings(ORG, manager, 'brand-1', {
      enabled: true,
      likeThreshold: 50,
      ctaText: 'Full guide here',
      ctaUrl: 'https://example.com/guide',
    });
    expect(created.likeThreshold).toBe(50);
    expect(created.version).toBe(1);
    const updated = await w.service.updateCtaSettings(
      ORG,
      manager,
      'brand-1',
      { likeThreshold: 75 },
      1
    );
    expect(updated.likeThreshold).toBe(75);
    expect(updated.ctaText).toBe('Full guide here');
    await expect(
      w.service.updateCtaSettings(ORG, manager, 'brand-1', { likeThreshold: 1 }, 1)
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(
      w.audit.write.mock.calls.some(
        (c: any[]) => c[2].action === 'milestone_cta_settings.update'
      )
    ).toBe(true);
  });

  it('enabling without any CTA content is refused (CTA_CONTENT_REQUIRED)', async () => {
    const w = buildWorld();
    await expect(
      w.service.updateCtaSettings(ORG, manager, 'brand-1', { enabled: true })
    ).rejects.toMatchObject({ code: 'CTA_CONTENT_REQUIRED' });
  });

  it('a non-http(s) CTA URL is refused (CTA_URL_INVALID)', async () => {
    const w = buildWorld();
    await expect(
      w.service.updateCtaSettings(ORG, manager, 'brand-1', {
        ctaUrl: 'javascript:alert(1)',
      })
    ).rejects.toMatchObject({ code: 'CTA_URL_INVALID' });
  });

  it('a creator without MANAGER cannot change settings', async () => {
    const w = buildWorld({ functions: ['CREATOR'] });
    await expect(
      w.service.updateCtaSettings(ORG, manager, 'brand-1', { enabled: false })
    ).rejects.toMatchObject({ code: 'REKTRS_FUNCTION_REQUIRED' });
  });
});

// ── The scan ────────────────────────────────────────────────────────────────
describe('W4 scan', () => {
  it('crossing post gets exactly one CTA comment, audited, with the measured likes', async () => {
    const w = buildWorld();
    enableSettings(w);
    const post = mkPost();
    w.state.posts.push(post);
    w.state.metrics.set(post.id, series({ Likes: 25, Comments: 3 }));

    const summary = await w.service.scanBrand(ORG, 'brand-1', 'SCHEDULED', manager, NOW);
    expect(summary.postedCount).toBe(1);
    expect(w.state.commentCalls).toHaveLength(1);
    expect(w.state.commentCalls[0].message).toBe(
      'Grab the full guide\nhttps://example.com/guide'
    );
    const row = w.state.actions[0];
    expect(row.status).toBe('CTA_POSTED');
    expect(row.commentId).toBe(`comment-for-${post.id}`);
    expect(row.likesAtCheck).toBe(25);
    expect(row.attempts).toBe(1);
    expect(row.postedAt).toEqual(NOW);
    expect(
      w.audit.write.mock.calls.some(
        (c: any[]) => c[2].action === 'milestone_cta.posted'
      )
    ).toBe(true);

    // Once-only: a second scan never comments again.
    const again = await w.service.scanBrand(ORG, 'brand-1', 'SCHEDULED', manager, NOW);
    expect(again.postedCount).toBe(0);
    expect(again.skippedReasons.counts.ALREADY_POSTED).toBe(1);
    expect(w.state.commentCalls).toHaveLength(1);
  });

  it('exactly at the threshold fires; one below does not', async () => {
    const w = buildWorld();
    enableSettings(w);
    const atPost = mkPost();
    const belowPost = mkPost();
    w.state.posts.push(atPost, belowPost);
    w.state.metrics.set(atPost.id, series({ Likes: 20 }));
    w.state.metrics.set(belowPost.id, series({ Likes: 19 }));

    const summary = await w.service.scanBrand(ORG, 'brand-1', 'SCHEDULED', manager, NOW);
    expect(summary.postedCount).toBe(1);
    expect(summary.skippedReasons.counts.BELOW_THRESHOLD).toBe(1);
    expect(w.state.actions).toHaveLength(1);
    expect(w.state.actions[0].postId).toBe(atPost.id);
  });

  it('Facebook Reactions count as the like counter', async () => {
    const w = buildWorld();
    enableSettings(w);
    const post = mkPost();
    w.state.posts.push(post);
    w.state.metrics.set(post.id, series({ Reactions: 42, Clicks: 9 }));
    const summary = await w.service.scanBrand(ORG, 'brand-1', 'SCHEDULED', manager, NOW);
    expect(summary.postedCount).toBe(1);
    expect(w.state.actions[0].likesAtCheck).toBe(42);
  });

  it('NO_METRICS: a series with no like counter is never judged (Pinterest shape)', async () => {
    const w = buildWorld();
    enableSettings(w);
    const pinterestLike = mkPost();
    const commentsOnly = mkPost();
    w.state.posts.push(pinterestLike, commentsOnly);
    // Pinterest-style: exposure + saves only — no like/comment/share counters.
    w.state.metrics.set(pinterestLike.id, series({ Impressions: 900, Saves: 40 }));
    // A counter exists (comments) but no LIKE counter: threshold unjudgeable.
    w.state.metrics.set(commentsOnly.id, series({ Comments: 500 }));

    const summary = await w.service.scanBrand(ORG, 'brand-1', 'SCHEDULED', manager, NOW);
    expect(summary.postedCount).toBe(0);
    expect(summary.skippedReasons.counts.NO_METRICS).toBe(2);
    expect(w.state.commentCalls).toHaveLength(0);
    expect(w.state.actions).toHaveLength(0);
  });

  it('PROVIDER_COMMENT_UNSUPPORTED: measurable + crossed, but the provider cannot comment (YouTube shape)', async () => {
    const w = buildWorld();
    enableSettings(w);
    w.state.integrations.set('int-2', {
      id: 'int-2',
      organizationId: ORG,
      providerIdentifier: 'youtube',
      disabled: false,
      deletedAt: null,
      token: 'token-2',
      internalId: 'chan-2',
    });
    w.state.brand.channels.push({
      id: 'bi-2',
      brandId: 'brand-1',
      integrationId: 'int-2',
    });
    const post = mkPost({ integrationId: 'int-2' });
    w.state.posts.push(post);
    w.state.metrics.set(post.id, series({ Likes: 1000, Views: 5000 }));

    const summary = await w.service.scanBrand(ORG, 'brand-1', 'SCHEDULED', manager, NOW);
    expect(summary.postedCount).toBe(0);
    expect(summary.skippedReasons.counts.PROVIDER_COMMENT_UNSUPPORTED).toBe(1);
    // No fake success: no action row, no comment call.
    expect(w.state.actions).toHaveLength(0);
    expect(w.state.commentCalls).toHaveLength(0);
  });

  it('CHANNEL_UNSUPPORTED + POST_MISSING + METRICS_FETCH_FAILED are tallied honestly', async () => {
    const w = buildWorld();
    enableSettings(w);
    // a provider with no postAnalytics at all
    w.state.integrations.set('int-3', {
      id: 'int-3',
      organizationId: ORG,
      providerIdentifier: 'mastodon',
      disabled: false,
      deletedAt: null,
      token: 'token-3',
      internalId: 'acct-3',
    });
    const unsupported = mkPost({ integrationId: 'int-3' });
    const missing = mkPost();
    const failing = mkPost();
    w.state.posts.push(unsupported, missing, failing);
    w.state.brand.channels[0].integrationId = 'int-1';
    w.state.brand.channels.push({
      id: 'bi-3',
      brandId: 'brand-1',
      integrationId: 'int-3',
    });
    w.state.metrics.set(missing.id, 'missing');
    w.state.metrics.set(failing.id, new Error('provider down'));

    const summary = await w.service.scanBrand(ORG, 'brand-1', 'SCHEDULED', manager, NOW);
    expect(summary.postedCount).toBe(0);
    expect(summary.skippedReasons.counts.CHANNEL_UNSUPPORTED).toBe(1);
    expect(summary.skippedReasons.counts.POST_MISSING).toBe(1);
    expect(summary.skippedReasons.counts.METRICS_FETCH_FAILED).toBe(1);
  });

  it('window: a post older than 30 days is never even fetched', async () => {
    const w = buildWorld();
    enableSettings(w);
    const old = mkPost({
      publishDate: new Date(NOW.getTime() - 31 * 24 * 3600 * 1000),
    });
    const fresh = mkPost();
    w.state.posts.push(old, fresh);
    w.state.metrics.set(old.id, series({ Likes: 999 }));
    w.state.metrics.set(fresh.id, series({ Likes: 1 }));

    const summary = await w.service.scanBrand(ORG, 'brand-1', 'SCHEDULED', manager, NOW);
    expect(summary.scannedCount).toBe(1);
    expect(summary.postedCount).toBe(0);
    expect(w.engagement.fetchPostMetrics).not.toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ id: old.id })
    );
  });

  it('NO_CHANNELS run when the brand has no active channel', async () => {
    const w = buildWorld();
    enableSettings(w);
    w.state.brand.channels = [];
    const summary = await w.service.scanBrand(ORG, 'brand-1', 'SCHEDULED', manager, NOW);
    expect(summary.runId).toBeTruthy();
    expect(summary.skippedReasons.counts.NO_CHANNELS).toBe(1);
    expect(summary.postedCount).toBe(0);
  });

  it('paused brand: scheduled sweep records no run; manual run refuses 409 BRAND_PAUSED', async () => {
    const w = buildWorld();
    enableSettings(w);
    w.state.brand.pausedAt = new Date();
    const summary = await w.service.scanBrand(ORG, 'brand-1', 'SCHEDULED', manager, NOW);
    expect(summary.skipped).toBe('BRAND_PAUSED');
    expect(summary.runId).toBeNull();
    expect(w.state.runs).toHaveLength(0);
    await expect(
      w.service.runBrandNow(ORG, manager, 'brand-1')
    ).rejects.toMatchObject({ code: 'BRAND_PAUSED' });
  });

  it('manual run while disabled refuses MILESTONE_CTA_NOT_ENABLED', async () => {
    const w = buildWorld();
    await expect(
      w.service.runBrandNow(ORG, manager, 'brand-1')
    ).rejects.toMatchObject({ code: 'MILESTONE_CTA_NOT_ENABLED' });
  });
});

// ── Failure retries ─────────────────────────────────────────────────────────
describe('W4 failure retry discipline', () => {
  it('CTA_FAILED carries the provider error, retries on later cycles, then succeeds', async () => {
    const w = buildWorld();
    enableSettings(w);
    const post = mkPost();
    w.state.posts.push(post);
    w.state.metrics.set(post.id, series({ Likes: 30 }));
    w.state.commentBehaviour.set(post.id, new Error('Graph API 403: token expired'));

    const first = await w.service.scanBrand(ORG, 'brand-1', 'SCHEDULED', manager, NOW);
    expect(first.failedCount).toBe(1);
    let row = w.state.actions[0];
    expect(row.status).toBe('CTA_FAILED');
    expect(row.attempts).toBe(1);
    expect(row.error).toContain('token expired');
    expect(row.commentId).toBeNull();
    expect(
      w.audit.write.mock.calls.some(
        (c: any[]) => c[2].action === 'milestone_cta.failed'
      )
    ).toBe(true);

    // provider recovers → the retry posts, on the SAME dedupe row
    w.state.commentBehaviour.delete(post.id);
    const second = await w.service.scanBrand(ORG, 'brand-1', 'SCHEDULED', manager, NOW);
    expect(second.postedCount).toBe(1);
    row = w.state.actions[0];
    expect(w.state.actions).toHaveLength(1);
    expect(row.status).toBe('CTA_POSTED');
    expect(row.attempts).toBe(2);
    expect(row.error).toBeNull();
    expect(row.commentId).toBe(`comment-for-${post.id}`);
  });

  it('attempt cap: 3 failures → CTA_EXHAUSTED, and the engine stops trying', async () => {
    const w = buildWorld();
    enableSettings(w);
    const post = mkPost();
    w.state.posts.push(post);
    w.state.metrics.set(post.id, series({ Likes: 30 }));
    w.state.commentBehaviour.set(post.id, new Error('still broken'));

    for (let i = 0; i < 3; i++) {
      await w.service.scanBrand(ORG, 'brand-1', 'SCHEDULED', manager, NOW);
    }
    const row = w.state.actions[0];
    expect(row.status).toBe('CTA_EXHAUSTED');
    expect(row.attempts).toBe(3);
    expect(w.state.commentCalls).toHaveLength(3);
    expect(
      w.audit.write.mock.calls.some(
        (c: any[]) => c[2].action === 'milestone_cta.exhausted'
      )
    ).toBe(true);

    const fourth = await w.service.scanBrand(ORG, 'brand-1', 'SCHEDULED', manager, NOW);
    expect(fourth.skippedReasons.counts.RETRY_EXHAUSTED).toBe(1);
    expect(w.state.commentCalls).toHaveLength(3);
  });
});

// ── Scheduled sweep ─────────────────────────────────────────────────────────
describe('W4 scheduled sweep', () => {
  it('scanAllEnabled runs enabled brands and tallies paused ones', async () => {
    const w = buildWorld();
    enableSettings(w);
    const post = mkPost();
    w.state.posts.push(post);
    w.state.metrics.set(post.id, series({ Likes: 25 }));

    const tallies = await w.service.scanAllEnabled(NOW);
    expect(tallies.brands).toBe(1);
    expect(tallies.runs).toBe(1);
    expect(tallies.posted).toBe(1);
    expect(tallies.paused).toBe(0);

    w.state.brand.pausedAt = new Date();
    const pausedTallies = await w.service.scanAllEnabled(NOW);
    expect(pausedTallies.paused).toBe(1);
    expect(pausedTallies.runs).toBe(0);
  });

  it('activity view returns actions + runs for the brand screen', async () => {
    const w = buildWorld();
    enableSettings(w);
    const post = mkPost();
    w.state.posts.push(post);
    w.state.metrics.set(post.id, series({ Likes: 25 }));
    await w.service.scanBrand(ORG, 'brand-1', 'MANUAL', manager, NOW);
    const activity = await w.service.listCtaActivity(ORG, 'brand-1');
    expect(activity.actions).toHaveLength(1);
    expect(activity.runs).toHaveLength(1);
    expect(activity.runs[0].trigger).toBe('MANUAL');
  });
});
