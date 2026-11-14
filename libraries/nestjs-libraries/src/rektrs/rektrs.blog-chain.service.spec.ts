/**
 * REKTRS W7 — Blog → Social Chain (AUTOMATION-WORKFLOWS.md W7).
 * Pure domain units (HMAC verification, HTML cleaning, UTM building,
 * variant shaping, fallback drafts, AI-output parsing) + the settings /
 * secret surface and the webhook chain against in-memory fakes. The AI
 * boundary (RektrsBlogGenerationService) is a fake: no real AI call is
 * ever made, and no draft leaves the fake world.
 * @jest-environment node
 */
import { createHmac } from 'crypto';
import { Prisma } from '@prisma/client';
import {
  blogPlatformKindForProvider,
  buildFallbackVariants,
  buildUtmUrl,
  parseGenerationJson,
  renderFirstComment,
  shapeInstagramCaption,
  shapeLinkedinDraft,
  shapeXThread,
  stripHtmlToText,
  verifyBlogSharedSecret,
  verifyBlogWebhookSignature,
  wpSlugFromLink,
} from '@gitroom/nestjs-libraries/rektrs/rektrs.blog-chain';
import { RektrsBlogChainService } from '@gitroom/nestjs-libraries/rektrs/rektrs.blog-chain.service';
import { rektrsError } from '@gitroom/nestjs-libraries/rektrs/rektrs.errors';
import { systemActor } from '@gitroom/nestjs-libraries/rektrs/rektrs.actor';

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
jest.mock('@gitroom/nestjs-libraries/rektrs/rektrs.blog-generation', () => ({
  RektrsBlogGenerationService: class {},
}));

const ORG = 'org-1';
const ORG2 = 'org-2';
const SECRET = 'test-secret-123';
const SECRET2 = 'other-secret-456';
const manager: any = { kind: 'USER', userId: 'mgr-1' };
const creator: any = { kind: 'USER', userId: 'creator-1' };

function p2002() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '6.5.0',
  });
}

function sign(secret: string, rawBody: Buffer | string): string {
  return 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
}

function wpPayload(over: Record<string, any> = {}) {
  return {
    id: 42,
    link: 'https://blog.example.com/2026/11/my-post/',
    title: 'My Post Title',
    excerpt: '<p>Short excerpt here</p>',
    content: '<p>Hello <b>world</b>, this is the full story.</p>',
    status: 'publish',
    ...over,
  };
}

const AI_VARIANTS = {
  linkedin: 'AI LinkedIn take on the post.',
  xThread: ['AI hook tweet', 'AI detail tweet'],
  instagram: 'AI caption for the gram',
};

function mkIntegration(id: string, providerIdentifier: string, over: any = {}) {
  return {
    id,
    organizationId: ORG,
    providerIdentifier,
    disabled: false,
    deletedAt: null,
    ...over,
  };
}

function buildWorld(opts: { functions?: string[] } = {}) {
  const state: any = {
    brands: [
      {
        id: 'brand-1',
        organizationId: ORG,
        name: 'Brand One',
        slug: 'brand-one',
        pausedAt: null,
        deletedAt: null,
        channels: [
          { id: 'bi-1', brandId: 'brand-1', integrationId: 'int-li' },
          { id: 'bi-2', brandId: 'brand-1', integrationId: 'int-x' },
          { id: 'bi-3', brandId: 'brand-1', integrationId: 'int-ig' },
        ],
      },
    ],
    integrations: new Map([
      ['int-li', mkIntegration('int-li', 'linkedin-page')],
      ['int-x', mkIntegration('int-x', 'x')],
      ['int-ig', mkIntegration('int-ig', 'instagram')],
    ]),
    settingsByBrand: new Map<string, any>(),
    runs: [] as any[],
    posts: [] as any[],
    audits: [] as any[],
    functions: opts.functions ?? ['MANAGER', 'CREATOR', 'ANALYST'],
    aiConfigured: true,
    aiMode: 'ok' as 'ok' | 'null' | 'unusable',
    aiCalls: [] as any[],
    postSeq: 0,
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
    blogSettings: {
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `bset-${data.brandId}`,
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          webhookSecret: null,
          ...data,
        };
        state.settingsByBrand.set(data.brandId, row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = [...state.settingsByBrand.values()].find(
          (s: any) => s.id === where.id
        );
        return applyData(row, data);
      }),
    },
    blogChainRun: {
      create: jest.fn(async ({ data }: any) => {
        const dupe = state.runs.find(
          (r: any) => r.brandId === data.brandId && r.wpPostId === data.wpPostId
        );
        if (dupe) {
          throw p2002();
        }
        const row = {
          id: `run-${state.runs.length + 1}`,
          aiMode: null,
          aiError: null,
          firstComment: null,
          variants: null,
          draftedCount: 0,
          error: null,
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
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
    post: {
      create: jest.fn(async ({ data }: any) => {
        state.postSeq++;
        const row = { id: `post-${state.postSeq}`, ...data };
        state.posts.push(row);
        return row;
      }),
    },
  };

  const repo: any = {
    db: () => db,
    transaction: async (cb: any) => cb({}),
    brandById: jest.fn(
      async (orgId: string, id: string) =>
        state.brands.find(
          (b: any) => b.id === id && b.organizationId === orgId
        ) ?? null
    ),
    brandsByWebhookKey: jest.fn(async (key: string) =>
      state.brands.filter((b: any) => b.id === key || b.slug === key)
    ),
    blogSettingsByBrand: jest.fn(
      async (_org: string, brandId: string) =>
        state.settingsByBrand.get(brandId) ?? null
    ),
    blogRunByWpPost: jest.fn(
      async (brandId: string, wpPostId: string) =>
        state.runs.find(
          (r: any) => r.brandId === brandId && r.wpPostId === wpPostId
        ) ?? null
    ),
    blogRunsOfBrand: jest.fn(async (_org: string, brandId: string) =>
      state.runs.filter((r: any) => r.brandId === brandId)
    ),
    integrationsByIds: jest.fn(async (_org: string, ids: string[]) =>
      ids
        .map((id) => state.integrations.get(id))
        .filter((i: any) => i && !i.deletedAt)
    ),
  };

  const audit: any = {
    write: jest.fn(async (_org: string, _actor: any, entry: any) => {
      state.audits.push(entry);
    }),
  };
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
  const generation: any = {
    isConfigured: jest.fn(() => state.aiConfigured),
    generateVariants: jest.fn(async (input: any) => {
      state.aiCalls.push(input);
      if (state.aiMode === 'null') {
        return null;
      }
      if (state.aiMode === 'unusable') {
        return { linkedin: '', xThread: [], instagram: '' };
      }
      return AI_VARIANTS;
    }),
  };

  const service = new RektrsBlogChainService(repo, audit, roles, generation);
  return { state, repo, db, audit, roles, generation, service };
}

function seedSettings(
  w: ReturnType<typeof buildWorld>,
  over: Record<string, any> = {}
) {
  const row = {
    id: 'bset-brand-1',
    organizationId: ORG,
    brandId: 'brand-1',
    enabled: true,
    webhookSecret: SECRET,
    aiEnabled: true,
    voiceTone: '',
    voiceNotes: '',
    examplePost: '',
    utmSource: '',
    utmMedium: 'social',
    firstCommentTemplate: 'Read the full post: {link}',
    createdById: 'mgr-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
    ...over,
  };
  w.state.settingsByBrand.set('brand-1', row);
  return row;
}

/** Deliver a webhook the way the controller does: sign the exact body. */
async function deliver(
  w: ReturnType<typeof buildWorld>,
  opts: {
    brandKey?: string;
    payload?: any;
    secret?: string | null;
    sharedSecret?: string;
    signature?: string;
  } = {}
) {
  const payload = opts.payload ?? wpPayload();
  const rawBody = Buffer.from(JSON.stringify(payload));
  const signature =
    opts.signature ??
    (opts.secret === null ? undefined : sign(opts.secret ?? SECRET, rawBody));
  return w.service.handleWordpressWebhook(
    opts.brandKey ?? 'brand-1',
    { signature, sharedSecret: opts.sharedSecret, rawBody },
    payload
  );
}

// ── Pure domain ──────────────────────────────────────────────────────────────

describe('W7 webhook signatures (pure)', () => {
  const body = Buffer.from('{"id":42}');

  it('accepts a correct HMAC and rejects wrong secret / tampered body / junk', () => {
    const good = sign(SECRET, body);
    expect(verifyBlogWebhookSignature(SECRET, good, body)).toBe(true);
    expect(verifyBlogWebhookSignature('nope', good, body)).toBe(false);
    expect(
      verifyBlogWebhookSignature(SECRET, good, Buffer.from('{"id":43}'))
    ).toBe(false);
    expect(verifyBlogWebhookSignature(SECRET, undefined, body)).toBe(false);
    expect(verifyBlogWebhookSignature(SECRET, 'sha256=zz', body)).toBe(false);
    expect(verifyBlogWebhookSignature(SECRET, 'plain', body)).toBe(false);
    expect(verifyBlogWebhookSignature('', good, body)).toBe(false);
  });

  it('shared-secret header compares in full', () => {
    expect(verifyBlogSharedSecret(SECRET, SECRET)).toBe(true);
    expect(verifyBlogSharedSecret(SECRET, 'test-secret-124')).toBe(false);
    expect(verifyBlogSharedSecret(SECRET, undefined)).toBe(false);
    expect(verifyBlogSharedSecret('', SECRET)).toBe(false);
  });
});

describe('W7 HTML cleaning (pure)', () => {
  it('removes script/style content entirely, strips tags, decodes entities', () => {
    const html =
      '<style>.a{color:red}</style><p>Fish &amp; Chips &#8212; great</p>' +
      '<script>alert("xss")</script><p>Second&nbsp;para</p>';
    const text = stripHtmlToText(html);
    expect(text).toContain('Fish & Chips — great');
    expect(text).toContain('Second para');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color');
    expect(text).not.toContain('<');
  });

  it('keeps paragraph structure and handles empty input', () => {
    expect(stripHtmlToText('<p>One</p><p>Two</p>')).toBe('One\n\nTwo');
    expect(stripHtmlToText('')).toBe('');
    expect(stripHtmlToText(null)).toBe('');
    expect(stripHtmlToText(undefined)).toBe('');
  });
});

describe('W7 UTM building (pure)', () => {
  it('appends source/medium/campaign and preserves existing params', () => {
    const out = buildUtmUrl('https://blog.example.com/post/?ref=home', {
      source: 'brand-one',
      medium: 'social',
      campaign: 'my-post',
    });
    const url = new URL(out);
    expect(url.searchParams.get('ref')).toBe('home');
    expect(url.searchParams.get('utm_source')).toBe('brand-one');
    expect(url.searchParams.get('utm_medium')).toBe('social');
    expect(url.searchParams.get('utm_campaign')).toBe('my-post');
  });

  it('never overwrites an existing utm value and survives a bad URL', () => {
    const out = buildUtmUrl('https://blog.example.com/p?utm_source=keep', {
      source: 'brand-one',
      medium: 'social',
      campaign: 'c',
    });
    expect(new URL(out).searchParams.get('utm_source')).toBe('keep');
    expect(buildUtmUrl('not a url', { source: 'a', medium: 'b', campaign: 'c' })).toBe(
      'not a url'
    );
  });

  it('extracts the slug from the link', () => {
    expect(wpSlugFromLink('https://blog.example.com/2026/11/my-post/')).toBe(
      'my-post'
    );
    expect(wpSlugFromLink('https://blog.example.com/')).toBe('');
    expect(wpSlugFromLink('junk')).toBe('');
  });
});

describe('W7 variant shaping (pure)', () => {
  const LINK = 'https://blog.example.com/p?utm_source=brand-one';

  it('LinkedIn ends with the link, dedupes it in the body, caps at 1300', () => {
    const shaped = shapeLinkedinDraft(`Intro ${LINK} more text`, LINK);
    expect(shaped.endsWith(LINK)).toBe(true);
    expect(shaped.match(/utm_source/g)).toHaveLength(1);
    const long = shapeLinkedinDraft('word '.repeat(600), LINK);
    expect(long.length).toBeLessThanOrEqual(1300);
    expect(long.endsWith(LINK)).toBe(true);
  });

  it('X thread: ≤5 posts, each ≤280, link in the last post', () => {
    const thread = shapeXThread(['lorem ipsum '.repeat(200)], LINK);
    expect(thread.length).toBeLessThanOrEqual(5);
    expect(thread.length).toBeGreaterThan(1);
    for (const post of thread) {
      expect(post.length).toBeLessThanOrEqual(280);
    }
    expect(thread[thread.length - 1]).toContain(LINK);
    const short = shapeXThread(['One', 'Two'], LINK);
    expect(short[short.length - 1]).toContain(LINK);
    expect(short.length).toBeLessThanOrEqual(5);
  });

  it('Instagram strips raw URLs, points at the bio, caps at 2200', () => {
    const caption = shapeInstagramCaption(
      `Check this https://spam.example.com/x and ${LINK} now`
    );
    expect(caption).not.toContain('http');
    expect(caption).toMatch(/link in bio/i);
    const long = shapeInstagramCaption('word '.repeat(800));
    expect(long.length).toBeLessThanOrEqual(2200);
  });

  it('fallback drafts are deterministic and platform-shaped', () => {
    const variants = buildFallbackVariants(
      { title: 'T', excerpt: 'E', contentText: 'C' },
      LINK
    );
    expect(variants.linkedin).toContain('T');
    expect(variants.linkedin.endsWith(LINK)).toBe(true);
    expect(variants.xThread[variants.xThread.length - 1]).toContain(LINK);
    expect(variants.instagram).not.toContain('http');
    const again = buildFallbackVariants(
      { title: 'T', excerpt: 'E', contentText: 'C' },
      LINK
    );
    expect(again).toEqual(variants);
  });

  it('first comment renders {link} and {title}; empty template defaults', () => {
    expect(
      renderFirstComment('Read: {link} — {title}', { link: 'L', title: 'T' })
    ).toBe('Read: L — T');
    expect(renderFirstComment('', { link: 'L', title: 'T' })).toBe(
      'Read the full post: L'
    );
  });

  it('parses AI JSON, tolerates fences, rejects garbage', () => {
    expect(
      parseGenerationJson('{"linkedin":"a","xThread":["b"],"instagram":"c"}')
    ).toEqual({ linkedin: 'a', xThread: ['b'], instagram: 'c' });
    expect(
      parseGenerationJson('```json\n{"linkedin":"a","xThread":"solo","instagram":"c"}\n```')
    ).toEqual({ linkedin: 'a', xThread: ['solo'], instagram: 'c' });
    expect(parseGenerationJson('no json here')).toBeNull();
    expect(parseGenerationJson('{"linkedin":"","xThread":[],"instagram":""}')).toBeNull();
  });

  it('maps providers to platform kinds', () => {
    expect(blogPlatformKindForProvider('linkedin')).toBe('LINKEDIN');
    expect(blogPlatformKindForProvider('linkedin-page')).toBe('LINKEDIN');
    expect(blogPlatformKindForProvider('x')).toBe('X');
    expect(blogPlatformKindForProvider('instagram')).toBe('INSTAGRAM');
    expect(blogPlatformKindForProvider('instagram-standalone')).toBe('INSTAGRAM');
    expect(blogPlatformKindForProvider('facebook')).toBeNull();
    expect(blogPlatformKindForProvider('wordpress')).toBeNull();
  });
});

// ── Settings + secret surface ────────────────────────────────────────────────

describe('W7 blog chain settings', () => {
  it('returns the defaults view when nothing is configured', async () => {
    const w = buildWorld();
    const view = await w.service.getBlogChainSettings(ORG, 'brand-1');
    expect(view).toMatchObject({
      brandId: 'brand-1',
      enabled: false,
      secretSet: false,
      aiEnabled: true,
      utmMedium: 'social',
      firstCommentTemplate: 'Read the full post: {link}',
      version: null,
    });
  });

  it('creates on first update, audits the views, and never leaks a secret', async () => {
    const w = buildWorld();
    const view = await w.service.updateBlogChainSettings(
      ORG,
      manager,
      'brand-1',
      { enabled: true, voiceTone: 'Warm', utmSource: 'newsletter' } as any,
      undefined
    );
    expect(view.enabled).toBe(true);
    expect(view.voiceTone).toBe('Warm');
    expect(view.utmSource).toBe('newsletter');
    expect(view.secretSet).toBe(false);
    const audit = w.state.audits.find(
      (a: any) => a.action === 'blog_chain_settings.update'
    );
    expect(audit).toBeTruthy();
    expect(audit.metadata.after.voiceTone).toBe('Warm');
  });

  it('refuses a stale If-Match with VERSION_CONFLICT', async () => {
    const w = buildWorld();
    seedSettings(w);
    await expect(
      w.service.updateBlogChainSettings(
        ORG,
        manager,
        'brand-1',
        { voiceTone: 'New' } as any,
        99
      )
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('gates settings writes and rotation behind MANAGER', async () => {
    // A principal whose granted functions lack MANAGER (the roles fake
    // reads the world's granted set, exactly like the W3/W6 specs).
    const w = buildWorld({ functions: ['CREATOR', 'ANALYST'] });
    await expect(
      w.service.updateBlogChainSettings(ORG, creator, 'brand-1', {} as any, undefined)
    ).rejects.toMatchObject({ code: 'REKTRS_FUNCTION_REQUIRED' });
    await expect(
      w.service.rotateBlogChainSecret(ORG, creator, 'brand-1')
    ).rejects.toMatchObject({ code: 'REKTRS_FUNCTION_REQUIRED' });
  });

  it('rotate returns the secret ONCE; the view only ever shows secretSet', async () => {
    const w = buildWorld();
    const rotated = await w.service.rotateBlogChainSecret(ORG, manager, 'brand-1');
    expect(rotated.secret).toMatch(/^rkwp_[0-9a-f]{48}$/);
    expect(rotated.secretSet).toBe(true);

    const view = await w.service.getBlogChainSettings(ORG, 'brand-1');
    expect(view.secretSet).toBe(true);
    expect(JSON.stringify(view)).not.toContain(rotated.secret);
    expect(JSON.stringify(w.state.audits)).not.toContain(rotated.secret);
    const rotateAudit = w.state.audits.find(
      (a: any) => a.action === 'blog_chain_settings.secret_rotate'
    );
    expect(rotateAudit.metadata).toEqual({
      brandName: 'Brand One',
      secretSet: true,
    });

    const again = await w.service.rotateBlogChainSecret(ORG, manager, 'brand-1');
    expect(again.secret).not.toBe(rotated.secret);
    // The stored secret is the new one: a signature made with the OLD
    // secret no longer verifies.
    w.state.settingsByBrand.get('brand-1').enabled = true;
    await expect(
      deliver(w, { secret: rotated.secret })
    ).rejects.toMatchObject({ code: 'BLOG_WEBHOOK_SIGNATURE_INVALID' });
    const ok = await deliver(w, { secret: again.secret });
    expect(ok.status).toBe('DRAFTED');
  });
});

// ── The webhook chain ────────────────────────────────────────────────────────

describe('W7 WordPress webhook chain', () => {
  it('404s an unknown brand key', async () => {
    const w = buildWorld();
    seedSettings(w);
    await expect(deliver(w, { brandKey: 'nope' })).rejects.toMatchObject({
      code: 'BLOG_BRAND_NOT_FOUND',
      status: 404,
    });
  });

  it('404s when the chain is disabled (no settings, or enabled=false)', async () => {
    const w = buildWorld();
    await expect(deliver(w)).rejects.toMatchObject({
      code: 'BLOG_CHAIN_DISABLED',
      status: 404,
    });
    seedSettings(w, { enabled: false });
    await expect(deliver(w)).rejects.toMatchObject({
      code: 'BLOG_CHAIN_DISABLED',
    });
  });

  it('503s when enabled but no secret has been rotated', async () => {
    const w = buildWorld();
    seedSettings(w, { webhookSecret: null });
    await expect(deliver(w)).rejects.toMatchObject({
      code: 'BLOG_WEBHOOK_NOT_CONFIGURED',
      status: 503,
    });
  });

  it('401s a bad signature; the shared-secret header also authenticates', async () => {
    const w = buildWorld();
    seedSettings(w);
    await expect(deliver(w, { secret: 'wrong-secret' })).rejects.toMatchObject({
      code: 'BLOG_WEBHOOK_SIGNATURE_INVALID',
      status: 401,
    });
    const viaHeader = await deliver(w, {
      secret: null,
      sharedSecret: SECRET,
      payload: wpPayload({ id: 77 }),
    });
    expect(viaHeader.received).toBe(true);
    expect(viaHeader.status).toBe('DRAFTED');
  });

  it('ignores non-publish deliveries and malformed payloads fail 400', async () => {
    const w = buildWorld();
    seedSettings(w);
    const ignored = await deliver(w, {
      payload: wpPayload({ status: 'draft' }),
    });
    expect(ignored).toEqual({ received: true, ignored: 'STATUS_NOT_PUBLISH' });
    expect(w.state.runs).toHaveLength(0);
    await expect(
      deliver(w, { payload: { status: 'publish', link: 'https://x' } })
    ).rejects.toMatchObject({ code: 'BLOG_WEBHOOK_PAYLOAD_INVALID' });
  });

  it('paused brand: run recorded SKIPPED_BRAND_PAUSED, nothing created, 200', async () => {
    const w = buildWorld();
    seedSettings(w);
    w.state.brands[0].pausedAt = new Date();
    const res = await deliver(w);
    expect(res.received).toBe(true);
    expect(res.skipped).toBe('BRAND_PAUSED');
    expect(w.state.runs).toHaveLength(1);
    expect(w.state.runs[0].status).toBe('SKIPPED_BRAND_PAUSED');
    expect(w.state.posts).toHaveLength(0);
  });

  it('happy path (AI): drafts on all three channels, UTM + threading + audits', async () => {
    const w = buildWorld();
    seedSettings(w);
    const res = await deliver(w);
    expect(res).toMatchObject({ received: true, status: 'DRAFTED', draftedCount: 3 });
    const run = w.state.runs[0];
    expect(run.aiMode).toBe('AI');
    expect(run.aiError).toBeNull();
    expect(run.draftedCount).toBe(3);

    const utm =
      'https://blog.example.com/2026/11/my-post/?utm_source=brand-one&utm_medium=social&utm_campaign=my-post';
    expect(run.firstComment).toBe(`Read the full post: ${utm}`);

    const byIntegration = (id: string) =>
      w.state.posts.filter((p: any) => p.integrationId === id);
    const linkedin = byIntegration('int-li');
    expect(linkedin).toHaveLength(1);
    expect(linkedin[0].state).toBe('DRAFT');
    expect(linkedin[0].content).toContain(AI_VARIANTS.linkedin);
    expect(linkedin[0].content.endsWith(utm)).toBe(true);
    expect(JSON.parse(linkedin[0].settings).__type).toBe('linkedin-page');

    const thread = byIntegration('int-x');
    expect(thread).toHaveLength(2);
    expect(thread[0].parentPostId).toBeNull();
    expect(thread[1].parentPostId).toBe(thread[0].id);
    expect(thread[0].group).toBe(thread[1].group);
    expect(thread[1].content).toContain(utm);
    // One batch for the whole chain.
    expect(new Set(w.state.posts.map((p: any) => p.batchId)).size).toBe(1);

    const instagram = byIntegration('int-ig');
    expect(instagram).toHaveLength(1);
    expect(instagram[0].content).not.toContain('http');
    expect(instagram[0].content).toMatch(/link in bio/i);

    const runAudit = w.state.audits.find(
      (a: any) => a.action === 'blog_chain.run'
    );
    expect(runAudit).toBeTruthy();
    expect(
      w.state.audits.filter((a: any) => a.action === 'blog_chain.draft_created')
    ).toHaveLength(3);
    expect(w.state.aiCalls).toHaveLength(1);
    expect(w.state.aiCalls[0].voiceTone).toBe('');
  });

  it('passes the brand voice block to the AI when configured', async () => {
    const w = buildWorld();
    seedSettings(w, {
      voiceTone: 'Punchy',
      voiceNotes: 'Short sentences',
      examplePost: 'Example!',
    });
    await deliver(w);
    expect(w.state.aiCalls[0]).toMatchObject({
      voiceTone: 'Punchy',
      voiceNotes: 'Short sentences',
      examplePost: 'Example!',
    });
  });

  it('dedupes a re-delivery: one run, one set of drafts', async () => {
    const w = buildWorld();
    seedSettings(w);
    const first = await deliver(w);
    const second = await deliver(w);
    expect(first.status).toBe('DRAFTED');
    expect(second).toMatchObject({ received: true, duplicate: true, status: 'DRAFTED' });
    expect(w.state.runs).toHaveLength(1);
    expect(w.state.posts).toHaveLength(4); // 1 linkedin + 2 thread + 1 instagram
  });

  it('AI unconfigured → deterministic AI_FALLBACK drafts, still DRAFTED', async () => {
    const w = buildWorld();
    seedSettings(w);
    w.state.aiConfigured = false;
    const res = await deliver(w);
    expect(res.status).toBe('DRAFTED');
    const run = w.state.runs[0];
    expect(run.aiMode).toBe('AI_FALLBACK');
    expect(w.state.aiCalls).toHaveLength(0);
    const linkedin = w.state.posts.find((p: any) => p.integrationId === 'int-li');
    expect(linkedin.content).toContain('My Post Title');
    expect(linkedin.content).toContain('utm_source=brand-one');
  });

  it('AI failure / unusable output → AI_FALLBACK with the reason recorded', async () => {
    const w = buildWorld();
    seedSettings(w);
    w.state.aiMode = 'null';
    await deliver(w);
    expect(w.state.runs[0].aiMode).toBe('AI_FALLBACK');
    expect(w.state.runs[0].aiError).toMatch(/AI generation failed/);

    const w2 = buildWorld();
    seedSettings(w2);
    w2.state.aiMode = 'unusable';
    await deliver(w2);
    expect(w2.state.runs[0].aiMode).toBe('AI_FALLBACK');
    expect(w2.state.runs[0].aiError).toMatch(/unusable/);
  });

  it('aiEnabled=false skips the provider entirely', async () => {
    const w = buildWorld();
    seedSettings(w, { aiEnabled: false });
    await deliver(w);
    expect(w.state.aiCalls).toHaveLength(0);
    expect(w.state.runs[0].aiMode).toBe('AI_FALLBACK');
  });

  it('a variant without a channel is SKIPPED_NO_CHANNEL and the run is PARTIAL', async () => {
    const w = buildWorld();
    seedSettings(w);
    w.state.brands[0].channels = w.state.brands[0].channels.filter(
      (c: any) => c.integrationId !== 'int-x'
    );
    const res = await deliver(w);
    expect(res.status).toBe('PARTIAL');
    const run = w.state.runs[0];
    expect(run.variants.X.outcome).toBe('SKIPPED_NO_CHANNEL');
    expect(run.variants.LINKEDIN.outcome).toBe('DRAFTED');
    expect(run.draftedCount).toBe(2);
  });

  it('disabled channels never receive drafts', async () => {
    const w = buildWorld();
    seedSettings(w);
    w.state.integrations.get('int-ig').disabled = true;
    const res = await deliver(w);
    expect(res.status).toBe('PARTIAL');
    expect(w.state.runs[0].variants.INSTAGRAM.outcome).toBe('SKIPPED_NO_CHANNEL');
    expect(
      w.state.posts.filter((p: any) => p.integrationId === 'int-ig')
    ).toHaveLength(0);
  });

  it('no target channels at all → FAILED run, nothing created', async () => {
    const w = buildWorld();
    seedSettings(w);
    w.state.brands[0].channels = [];
    const res = await deliver(w);
    expect(res.status).toBe('FAILED');
    expect(w.state.runs[0].draftedCount).toBe(0);
    expect(w.state.runs[0].error).toBeTruthy();
    expect(w.state.posts).toHaveLength(0);
  });

  it('script content from the post body never reaches a draft', async () => {
    const w = buildWorld();
    seedSettings(w);
    w.state.aiConfigured = false;
    await deliver(w, {
      payload: wpPayload({
        excerpt: '',
        content:
          '<p>Real opening text</p><script>stealCookies()</script><style>.x{}</style>',
      }),
    });
    const allContent = w.state.posts.map((p: any) => p.content).join('\n');
    expect(allContent).toContain('Real opening text');
    expect(allContent).not.toContain('stealCookies');
    expect(allContent).not.toContain('<');
  });

  it('resolves a brand by slug, and a shared slug by the verifying secret', async () => {
    const w = buildWorld();
    seedSettings(w);
    const bySlug = await deliver(w, { brandKey: 'brand-one' });
    expect(bySlug.status).toBe('DRAFTED');

    // Second org, same slug, own secret + own LinkedIn channel.
    w.state.brands.push({
      id: 'brand-2',
      organizationId: ORG2,
      name: 'Brand Two',
      slug: 'brand-one',
      pausedAt: null,
      deletedAt: null,
      channels: [{ id: 'bi-9', brandId: 'brand-2', integrationId: 'int-li2' }],
    });
    w.state.integrations.set(
      'int-li2',
      mkIntegration('int-li2', 'linkedin', { organizationId: ORG2 })
    );
    w.state.settingsByBrand.set('brand-2', {
      id: 'bset-brand-2',
      organizationId: ORG2,
      brandId: 'brand-2',
      enabled: true,
      webhookSecret: SECRET2,
      aiEnabled: false,
      voiceTone: '',
      voiceNotes: '',
      examplePost: '',
      utmSource: '',
      utmMedium: 'social',
      firstCommentTemplate: 'Read the full post: {link}',
      createdById: 'mgr-2',
      createdAt: new Date(),
      updatedAt: new Date(),
      version: 1,
    });
    const res = await deliver(w, {
      brandKey: 'brand-one',
      secret: SECRET2,
      payload: wpPayload({ id: 99 }),
    });
    // Brand Two has only a LinkedIn channel: LINKEDIN drafts, the other
    // two variants skip — a PARTIAL run on the RIGHT brand and org.
    expect(res.status).toBe('PARTIAL');
    const run2 = w.state.runs.find((r: any) => r.brandId === 'brand-2');
    expect(run2).toBeTruthy();
    expect(run2.organizationId).toBe(ORG2);
    expect(run2.variants.LINKEDIN.outcome).toBe('DRAFTED');
    expect(run2.variants.X.outcome).toBe('SKIPPED_NO_CHANNEL');
    expect(
      w.state.posts.filter((p: any) => p.integrationId === 'int-li2')
    ).toHaveLength(1);
  });

  it('honours a custom utmSource and never overrides one already on the link', async () => {
    const w = buildWorld();
    seedSettings(w, { utmSource: 'newsletter' });
    w.state.aiConfigured = false;
    await deliver(w);
    const linkedin = w.state.posts.find((p: any) => p.integrationId === 'int-li');
    expect(linkedin.content).toContain('utm_source=newsletter');

    const w2 = buildWorld();
    seedSettings(w2);
    w2.state.aiConfigured = false;
    await deliver(w2, {
      payload: wpPayload({
        link: 'https://blog.example.com/p/?utm_source=authors-own',
      }),
    });
    const li2 = w2.state.posts.find((p: any) => p.integrationId === 'int-li');
    expect(li2.content).toContain('utm_source=authors-own');
    expect(li2.content).not.toContain('utm_source=brand-one');
  });

  it('accepts WP REST-shaped fields (title/excerpt/content as {rendered})', async () => {
    const w = buildWorld();
    seedSettings(w);
    w.state.aiConfigured = false;
    const res = await deliver(w, {
      payload: {
        id: '511',
        link: 'https://blog.example.com/rest-post/',
        title: { rendered: 'REST Title' },
        excerpt: { rendered: '<p>REST excerpt</p>' },
        content: { rendered: '<p>REST body</p>' },
        status: 'publish',
      },
    });
    expect(res.status).toBe('DRAFTED');
    expect(w.state.runs[0].wpPostId).toBe('511');
    expect(w.state.runs[0].title).toBe('REST Title');
    const linkedin = w.state.posts.find((p: any) => p.integrationId === 'int-li');
    expect(linkedin.content).toContain('REST Title');
  });

  it('lists runs for the brand screen', async () => {
    const w = buildWorld();
    seedSettings(w);
    await deliver(w);
    const { runs } = await w.service.listBlogChainRuns(ORG, 'brand-1');
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('DRAFTED');
  });
});
