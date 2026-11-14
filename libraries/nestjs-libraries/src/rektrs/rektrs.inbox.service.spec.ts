/**
 * REKTRS W6 — Inbox Triage (Multilingual) (AUTOMATION-WORKFLOWS.md W6).
 * Pure domain units (language detection, classification lexicons,
 * template rendering) + the triage engine and human actions against
 * in-memory fakes. Both provider boundaries are mocked
 * (RektrsTranslationService for translation, RektrsInboxReplyGateway
 * for the reply write): no real translation call and no real provider
 * comment is ever made. The final block runs the REAL W1 lead engine
 * with the REAL inbox service over one shared fake world to prove the
 * ingestion hook (poll + webhook share processInboundComment).
 * @jest-environment node
 */
import { Prisma } from '@prisma/client';
import {
  classifyInboxText,
  detectInboxLanguage,
  faqTemplateField,
  renderInboxFaqTemplate,
} from '@gitroom/nestjs-libraries/rektrs/rektrs.inbox';
import { RektrsInboxService } from '@gitroom/nestjs-libraries/rektrs/rektrs.inbox.service';
import { RektrsLeadsService } from '@gitroom/nestjs-libraries/rektrs/rektrs.leads.service';
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
jest.mock('@gitroom/nestjs-libraries/rektrs/rektrs.alerts.service', () => ({
  RektrsAlertsService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/rektrs/rektrs.inbox-translation', () => ({
  RektrsTranslationService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/rektrs/rektrs.inbox-providers', () => ({
  RektrsInboxReplyGateway: class {},
}));
jest.mock('@gitroom/nestjs-libraries/rektrs/rektrs.lead-providers', () => ({
  RektrsCommentGateway: class {},
}));

const ORG = 'org-1';
const manager: any = { kind: 'USER', userId: 'mgr-1' };
const creator: any = { kind: 'USER', userId: 'creator-1' };

function p2002() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '6.5.0',
  });
}

function comment(over: Record<string, any> = {}) {
  return {
    integrationId: 'int-1',
    providerPostId: 'post-9',
    commentId: 'c-1',
    text: 'what is the price?',
    commenterId: 'user-7',
    commenterName: 'Ali Raza',
    commentAt: new Date('2026-02-01T10:00:00.000Z'),
    ...over,
  };
}

function buildWorld(opts: { functions?: string[] } = {}) {
  const state: any = {
    brand: {
      id: 'brand-1',
      organizationId: ORG,
      name: 'Brand One',
      pausedAt: null,
      deletedAt: null,
      channels: [{ id: 'bi-1', brandId: 'brand-1', integrationId: 'int-1' }],
    },
    integration: {
      id: 'int-1',
      organizationId: ORG,
      providerIdentifier: 'facebook',
      internalId: 'page-1',
      token: 'token-1',
      disabled: false,
      deletedAt: null,
    },
    internalPost: {
      id: 'post-int-1',
      organizationId: ORG,
      integrationId: 'int-1',
      releaseId: 'post-9',
      releaseURL: 'https://facebook.com/post-9',
      parentPostId: null,
      settings: '{"__type":"facebook"}',
    },
    settings: null as any,
    items: [] as any[],
    leads: [] as any[],
    seen: new Set<string>(),
    audits: [] as any[],
    complaintAlerts: [] as any[],
    leadAlerts: [] as any[],
    replyCalls: [] as any[],
    replyBehaviour: { mode: 'ok' as 'ok' | 'throw' | 'unsupported' },
    capabilityNote: null as string | null,
    translationMode: 'auto' as 'auto' | 'ok' | 'fail',
    functions: opts.functions ?? ['MANAGER', 'CREATOR', 'ANALYST'],
    rule: null as any,
    publishedPosts: [] as any[],
    fetchedComments: [] as any[],
  };
  state.link = { brandId: 'brand-1', integrationId: 'int-1', brand: state.brand };

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
    inboxSettings: {
      create: jest.fn(async ({ data }: any) => {
        state.settings = {
          id: 'iset-1',
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        return state.settings;
      }),
      update: jest.fn(async ({ data }: any) => applyData(state.settings, data)),
    },
    inboxItem: {
      create: jest.fn(async ({ data }: any) => {
        const dupe = state.items.find(
          (i: any) =>
            i.brandId === data.brandId &&
            i.providerCommentId === data.providerCommentId
        );
        if (dupe) {
          throw p2002();
        }
        const row = {
          id: `item-${state.items.length + 1}`,
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        state.items.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = state.items.find((i: any) => i.id === where.id);
        return applyData(row, data);
      }),
      count: jest.fn(
        async ({ where }: any) =>
          state.items.filter(
            (i: any) =>
              i.organizationId === where.organizationId &&
              i.status === where.status
          ).length
      ),
    },
    leadCommentSeen: {
      create: jest.fn(async ({ data }: any) => {
        const key = `${data.integrationId}:${data.commentId}`;
        if (state.seen.has(key)) {
          throw p2002();
        }
        state.seen.add(key);
        return { id: `seen-${state.seen.size}`, ...data };
      }),
    },
    lead: {
      create: jest.fn(async ({ data }: any) => {
        const dupe = state.leads.find(
          (l: any) =>
            l.integrationId === data.integrationId &&
            l.commentId === data.commentId
        );
        if (dupe) {
          throw p2002();
        }
        const row = {
          id: `lead-${state.leads.length + 1}`,
          version: 1,
          webhookAttempts: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        state.leads.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = state.leads.find((l: any) => l.id === where.id);
        return applyData(row, data);
      }),
    },
    post: { findFirst: jest.fn(async () => state.internalPost) },
  };

  const repo: any = {
    db: () => db,
    transaction: async (cb: any) => cb({}),
    brandById: jest.fn(async () => state.brand),
    inboxSettingsByBrand: jest.fn(async () => state.settings),
    inboxItemById: jest.fn(
      async (_org: string, _brand: string, id: string) =>
        state.items.find((i: any) => i.id === id) ?? null
    ),
    inboxItemsOfBrand: jest.fn(
      async (_org: string, _brand: string, filters: any = {}) =>
        state.items.filter(
          (i: any) =>
            (!filters.status || i.status === filters.status) &&
            (!filters.category || i.category === filters.category)
        )
    ),
    inboxItemsOfOrg: jest.fn(async (_org: string, filters: any = {}) =>
      state.items.filter(
        (i: any) =>
          (!filters.status || i.status === filters.status) &&
          (!filters.category || i.category === filters.category) &&
          (!filters.brandId || i.brandId === filters.brandId)
      )
    ),
    enabledInboxSettings: jest.fn(async () =>
      state.settings?.enabled
        ? [
            {
              ...state.settings,
              brand: {
                ...state.brand,
                channels: [
                  { integrationId: 'int-1', integration: state.integration },
                ],
              },
            },
          ]
        : []
    ),
    integrationById: jest.fn(async () => state.integration),
    postById: jest.fn(async () => state.internalPost),
    brandIntegrationByIntegration: jest.fn(async () => state.link),
    leadRuleByBrand: jest.fn(async () => state.rule),
    enabledLeadRules: jest.fn(async () =>
      state.rule?.enabled
        ? [
            {
              ...state.rule,
              brand: {
                ...state.brand,
                channels: [
                  { integrationId: 'int-1', integration: state.integration },
                ],
              },
            },
          ]
        : []
    ),
    leadById: jest.fn(
      async (_org: string, id: string) =>
        state.leads.find((l: any) => l.id === id) ?? null
    ),
    leadForCommenterPost: jest.fn(async () => null),
    publishedPostsForChannels: jest.fn(async () => state.publishedPosts),
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
    getFunctions: jest.fn(async () => state.functions),
    getCrmWebhookConfig: jest.fn(async () => ({
      enabled: false,
      url: null,
      secret: null,
    })),
  };
  const alerts: any = {
    alertInboxComplaint: jest.fn(async (_org: string, input: any) => {
      state.complaintAlerts.push(input);
    }),
    alertNewLead: jest.fn(async (_org: string, input: any) => {
      state.leadAlerts.push(input);
    }),
  };
  const translation: any = {
    isConfigured: jest.fn(() => state.translationMode !== 'auto' || false),
    translateIfNeeded: jest.fn(
      async (text: string, detected: string, working: string) => {
        if (detected === working) {
          return { status: 'NOT_NEEDED', text: null };
        }
        if (state.translationMode === 'ok') {
          return { status: 'TRANSLATED', text: `[${working}] ${text}` };
        }
        if (state.translationMode === 'fail') {
          return { status: 'FAILED', text: null };
        }
        return { status: 'UNAVAILABLE', text: null };
      }
    ),
  };
  const replies: any = {
    supportsReply: jest.fn(() => state.replyBehaviour.mode !== 'unsupported'),
    capabilityNote: jest.fn(() => state.capabilityNote),
    postReply: jest.fn(
      async (
        _org: string,
        integration: any,
        post: any,
        replyToCommentId: string,
        message: string
      ) => {
        state.replyCalls.push({
          integrationId: integration.id,
          postId: post.id,
          replyToCommentId,
          message,
        });
        if (state.replyBehaviour.mode === 'throw') {
          throw new Error('Graph API: (#100) invalid comment id');
        }
        return { commentId: 'reply-1', releaseURL: 'https://facebook.com/r1' };
      }
    ),
  };

  const service = new RektrsInboxService(
    repo,
    audit,
    roles,
    alerts,
    translation,
    replies
  );
  return {
    state,
    repo,
    db,
    audit,
    roles,
    alerts,
    translation,
    replies,
    service,
  };
}

function seedSettings(
  w: ReturnType<typeof buildWorld>,
  over: Record<string, any> = {}
) {
  w.state.settings = {
    id: 'iset-1',
    organizationId: ORG,
    brandId: 'brand-1',
    enabled: true,
    workingLanguage: 'en',
    faqPrice: 'Hi {name}, our prices start at Rs 500. — {brandName}',
    faqTiming: '',
    faqLocation: '',
    faqDelivery: '',
    extraComplaintKeywords: [],
    createdById: 'mgr-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
    ...over,
  };
  return w.state.settings;
}

// ── Pure domain ──────────────────────────────────────────────────────────────

describe('W6 language detection (pure)', () => {
  it('plain English is en', () => {
    expect(detectInboxLanguage('What is the price of this?')).toBe('en');
    expect(detectInboxLanguage('Great post, love it!')).toBe('en');
  });

  it('Urdu script with Urdu-specific letters is ur', () => {
    expect(detectInboxLanguage('یہ کتنے کا ہے؟')).toBe('ur');
    expect(detectInboxLanguage('مجھے یہ چیز چاہیے')).toBe('ur');
  });

  it('Urdu script without specific letters but with Urdu function words is ur', () => {
    expect(detectInboxLanguage('اس کی قیمت کیا ہے')).toBe('ur');
  });

  it('Arabic script without Urdu markers is ar', () => {
    expect(detectInboxLanguage('ما هو سعر هذا المنتج')).toBe('ar');
    expect(detectInboxLanguage('أريد الاستفسار عن التوصيل')).toBe('ar');
  });

  it('Roman Urdu needs two markers', () => {
    expect(detectInboxLanguage('ye qeemat kya hai')).toBe('ur-Latn');
    expect(detectInboxLanguage('mujhe ye chahiye, kitne ka hai')).toBe(
      'ur-Latn'
    );
    expect(detectInboxLanguage('the kab was great')).toBe('en');
  });

  it('an unclassified script is other', () => {
    expect(detectInboxLanguage('Привет, какая цена?')).toBe('other');
  });
});

describe('W6 classification (pure)', () => {
  it('complaint beats FAQ — a refund demand that mentions price is a human’s', () => {
    const c = classifyInboxText('I want a refund, what was the price anyway');
    expect(c.category).toBe('COMPLAINT');
    expect(c.phrase).toBe('refund');
  });

  it('EN anger terms classify as complaints', () => {
    expect(classifyInboxText('worst service ever, totally useless').category).toBe('COMPLAINT');
    expect(classifyInboxText('I am very disappointed and angry').category).toBe('COMPLAINT');
  });

  it('Urdu + Arabic complaint words classify without any translation', () => {
    expect(classifyInboxText('یہ سراسر فراڈ ہے، شکایت درج کریں').category).toBe('COMPLAINT');
    expect(classifyInboxText('هذا احتيال، أريد استرداد أموالي').category).toBe('COMPLAINT');
    expect(classifyInboxText('mujhe paise wapas chahiye').category).toBe('COMPLAINT');
  });

  it('brand extra complaint keywords extend the lexicon', () => {
    const c = classifyInboxText('this is a zaleel experience', ['zaleel']);
    expect(c.category).toBe('COMPLAINT');
    expect(c.phrase).toBe('zaleel');
  });

  it('FAQ topics classify across languages with the fixed topic order', () => {
    expect(classifyInboxText('what is the price?')).toEqual({
      category: 'FAQ_PRICE',
      phrase: 'price',
      faqTopic: 'PRICE',
    });
    expect(classifyInboxText('اس کی قیمت کتنی ہے؟').category).toBe('FAQ_PRICE');
    expect(classifyInboxText('ye qeemat kya hai').category).toBe('FAQ_PRICE');
    expect(classifyInboxText('what time do you open?').category).toBe('FAQ_TIMING');
    expect(classifyInboxText('where are you located, need the address').category).toBe('FAQ_LOCATION');
    expect(classifyInboxText('do you offer home delivery?').category).toBe('FAQ_DELIVERY');
    // PRICE precedes DELIVERY in the fixed order.
    expect(classifyInboxText('price and delivery charges?').category).toBe('FAQ_PRICE');
  });

  it('word boundaries hold — priceless is not a price question', () => {
    expect(classifyInboxText('this moment is priceless').category).toBe('GENERAL');
    expect(classifyInboxText('beautiful work, keep it up!')).toEqual({
      category: 'GENERAL',
      phrase: null,
      faqTopic: null,
    });
  });

  it('template rendering substitutes and leaves unknown placeholders visible', () => {
    expect(
      renderInboxFaqTemplate('Hi {name}, welcome to {brandName}!', {
        brandName: 'Brand One',
        name: 'Ali',
      })
    ).toBe('Hi Ali, welcome to Brand One!');
    expect(
      renderInboxFaqTemplate('Hi {name} — {shop}', { name: null })
    ).toBe('Hi there — {shop}');
    expect(faqTemplateField('DELIVERY')).toBe('faqDelivery');
  });
});

// ── Settings ─────────────────────────────────────────────────────────────────

describe('W6 inbox settings', () => {
  it('returns defaults when never configured', async () => {
    const w = buildWorld();
    const view = await w.service.getInboxSettings(ORG, 'brand-1');
    expect(view).toEqual({
      brandId: 'brand-1',
      enabled: false,
      workingLanguage: 'en',
      faqPrice: '',
      faqTiming: '',
      faqLocation: '',
      faqDelivery: '',
      extraComplaintKeywords: [],
      version: null,
    });
  });

  it('creates settings with normalised extra keywords and audits the change', async () => {
    const w = buildWorld();
    const view = await w.service.updateInboxSettings(ORG, manager, 'brand-1', {
      enabled: true,
      workingLanguage: 'ur',
      faqPrice: 'Prices start at Rs 500',
      extraComplaintKeywords: [' Zaleel ', 'zaleel', 'Bakwas'],
    } as any);
    expect(view.enabled).toBe(true);
    expect(view.workingLanguage).toBe('ur');
    expect(view.extraComplaintKeywords).toEqual(['zaleel', 'bakwas']);
    expect(w.state.audits.map((a: any) => a.action)).toContain(
      'inbox_settings.update'
    );
  });

  it('rejects a stale If-Match and a non-MANAGER', async () => {
    const w = buildWorld();
    seedSettings(w);
    await expect(
      w.service.updateInboxSettings(ORG, manager, 'brand-1', { enabled: false } as any, 99)
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    w.state.functions = ['CREATOR'];
    await expect(
      w.service.updateInboxSettings(ORG, creator, 'brand-1', { enabled: false } as any)
    ).rejects.toMatchObject({ code: 'REKTRS_FUNCTION_REQUIRED' });
  });
});

// ── Triage ───────────────────────────────────────────────────────────────────

describe('W6 triage (via triageInboundComment)', () => {
  it('is a quiet no-op when triage is disabled', async () => {
    const w = buildWorld();
    const { outcome } = await w.service.triageInboundComment(
      ORG,
      w.state.brand,
      w.state.integration,
      comment()
    );
    expect(outcome).toBe('disabled');
    expect(w.state.items).toHaveLength(0);
  });

  it('drafts the FAQ price reply from the brand template', async () => {
    const w = buildWorld();
    seedSettings(w);
    const { outcome } = await w.service.triageInboundComment(
      ORG,
      w.state.brand,
      w.state.integration,
      comment()
    );
    expect(outcome).toBe('triaged');
    const item = w.state.items[0];
    expect(item.category).toBe('FAQ_PRICE');
    expect(item.status).toBe('DRAFTED');
    expect(item.suggestedReply).toBe(
      'Hi Ali Raza, our prices start at Rs 500. — Brand One'
    );
    expect(item.detectedLanguage).toBe('en');
    expect(item.translationStatus).toBe('NOT_NEEDED');
    expect(item.postId).toBe('post-int-1');
    expect(item.matchedPhrase).toBe('price');
    expect(w.state.audits.map((a: any) => a.action)).toContain(
      'inbox.item_triaged'
    );
  });

  it('queues complaints for a human and alerts the MANAGERs', async () => {
    const w = buildWorld();
    seedSettings(w);
    const { outcome } = await w.service.triageInboundComment(
      ORG,
      w.state.brand,
      w.state.integration,
      comment({ commentId: 'c-9', text: 'یہ سراسر فراڈ ہے، پیسے واپس کرو' })
    );
    expect(outcome).toBe('triaged');
    const item = w.state.items[0];
    expect(item.category).toBe('COMPLAINT');
    expect(item.status).toBe('QUEUED');
    expect(item.suggestedReply).toBeNull();
    expect(w.state.complaintAlerts).toHaveLength(1);
    expect(w.state.complaintAlerts[0].brandId).toBe('brand-1');
    expect(w.state.audits.map((a: any) => a.action)).toEqual(
      expect.arrayContaining(['inbox.item_triaged', 'inbox.complaint_alert'])
    );
  });

  it('uses brand extra complaint keywords', async () => {
    const w = buildWorld();
    seedSettings(w, { extraComplaintKeywords: ['zaleel'] });
    await w.service.triageInboundComment(
      ORG,
      w.state.brand,
      w.state.integration,
      comment({ commentId: 'c-10', text: 'totally zaleel experience' })
    );
    expect(w.state.items[0].category).toBe('COMPLAINT');
    expect(w.state.items[0].status).toBe('QUEUED');
  });

  it('records translation UNAVAILABLE honestly — original kept, nothing invented', async () => {
    const w = buildWorld();
    seedSettings(w);
    await w.service.triageInboundComment(
      ORG,
      w.state.brand,
      w.state.integration,
      comment({ commentId: 'c-11', text: 'اس کی قیمت کتنی ہے؟' })
    );
    const item = w.state.items[0];
    expect(item.detectedLanguage).toBe('ur');
    expect(item.translationStatus).toBe('UNAVAILABLE');
    expect(item.translatedText).toBeNull();
    expect(item.note).toContain('not configured');
    // Classification did not depend on the missing translation.
    expect(item.category).toBe('FAQ_PRICE');
    expect(item.status).toBe('DRAFTED');
  });

  it('stores a real translation when the provider answers', async () => {
    const w = buildWorld();
    w.state.translationMode = 'ok';
    seedSettings(w);
    await w.service.triageInboundComment(
      ORG,
      w.state.brand,
      w.state.integration,
      comment({ commentId: 'c-12', text: 'اس کی قیمت کتنی ہے؟' })
    );
    const item = w.state.items[0];
    expect(item.translationStatus).toBe('TRANSLATED');
    expect(item.translatedText).toBe('[en] اس کی قیمت کتنی ہے؟');
  });

  it('records translation FAILED with the original preserved', async () => {
    const w = buildWorld();
    w.state.translationMode = 'fail';
    seedSettings(w);
    await w.service.triageInboundComment(
      ORG,
      w.state.brand,
      w.state.integration,
      comment({ commentId: 'c-13', text: 'ما هو سعر هذا؟' })
    );
    const item = w.state.items[0];
    expect(item.detectedLanguage).toBe('ar');
    expect(item.translationStatus).toBe('FAILED');
    expect(item.translatedText).toBeNull();
    expect(item.note).toContain('Translation failed');
  });

  it('dedupes on (brand, comment): the second delivery is a duplicate', async () => {
    const w = buildWorld();
    seedSettings(w);
    const first = await w.service.triageInboundComment(
      ORG,
      w.state.brand,
      w.state.integration,
      comment()
    );
    const second = await w.service.triageInboundComment(
      ORG,
      w.state.brand,
      w.state.integration,
      comment()
    );
    expect(first.outcome).toBe('triaged');
    expect(second.outcome).toBe('duplicate');
    expect(w.state.items).toHaveLength(1);
  });

  it('skips paused brands entirely', async () => {
    const w = buildWorld();
    seedSettings(w);
    w.state.brand.pausedAt = new Date();
    const { outcome } = await w.service.triageInboundComment(
      ORG,
      w.state.brand,
      w.state.integration,
      comment()
    );
    expect(outcome).toBe('paused');
    expect(w.state.items).toHaveLength(0);
  });

  it('an FAQ topic without a template lands NEW with no draft', async () => {
    const w = buildWorld();
    seedSettings(w);
    await w.service.triageInboundComment(
      ORG,
      w.state.brand,
      w.state.integration,
      comment({ commentId: 'c-14', text: 'what time do you open?' })
    );
    const item = w.state.items[0];
    expect(item.category).toBe('FAQ_TIMING');
    expect(item.status).toBe('NEW');
    expect(item.suggestedReply).toBeNull();
  });

  it('general comments are listed as NEW; the capability note rides along', async () => {
    const w = buildWorld();
    seedSettings(w);
    w.state.capabilityNote =
      'This channel cannot post replies from REKTRS Social — answer on the platform itself.';
    await w.service.triageInboundComment(
      ORG,
      w.state.brand,
      w.state.integration,
      comment({ commentId: 'c-15', text: 'beautiful work, keep it up!' })
    );
    const item = w.state.items[0];
    expect(item.category).toBe('GENERAL');
    expect(item.status).toBe('NEW');
    expect(item.note).toContain('cannot post replies');
  });

  it('queue count reflects QUEUED complaints only', async () => {
    const w = buildWorld();
    seedSettings(w);
    await w.service.triageInboundComment(
      ORG,
      w.state.brand,
      w.state.integration,
      comment({ commentId: 'c-16', text: 'this is a scam' })
    );
    await w.service.triageInboundComment(
      ORG,
      w.state.brand,
      w.state.integration,
      comment({ commentId: 'c-17', text: 'price please' })
    );
    expect(await w.service.countQueued(ORG)).toBe(1);
  });
});

// ── Human actions: send + dismiss ────────────────────────────────────────────

function seedItem(w: ReturnType<typeof buildWorld>, over: Record<string, any> = {}) {
  const item = {
    id: `item-${w.state.items.length + 1}`,
    organizationId: ORG,
    brandId: 'brand-1',
    integrationId: 'int-1',
    providerIdentifier: 'facebook',
    postId: 'post-int-1',
    providerPostId: 'post-9',
    providerCommentId: 'c-1',
    authorId: 'user-7',
    authorName: 'Ali Raza',
    originalText: 'what is the price?',
    detectedLanguage: 'en',
    translatedText: null,
    translationStatus: 'NOT_NEEDED',
    category: 'FAQ_PRICE',
    matchedPhrase: 'price',
    status: 'DRAFTED',
    suggestedReply: 'Hi Ali Raza, our prices start at Rs 500. — Brand One',
    sentText: null,
    replyCommentId: null,
    sendError: null,
    sentAt: null,
    sentById: null,
    note: null,
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
  w.state.items.push(item);
  return item;
}

describe('W6 send (the one-tap human send)', () => {
  it('posts the draft through the gateway and records SENT', async () => {
    const w = buildWorld();
    const item = seedItem(w);
    const sent = await w.service.sendReply(ORG, creator, 'brand-1', item.id);
    expect(w.state.replyCalls).toEqual([
      {
        integrationId: 'int-1',
        postId: 'post-int-1',
        replyToCommentId: 'c-1',
        message: 'Hi Ali Raza, our prices start at Rs 500. — Brand One',
      },
    ]);
    expect(sent.status).toBe('SENT');
    expect(sent.replyCommentId).toBe('reply-1');
    expect(sent.sentById).toBe('creator-1');
    expect(sent.sentText).toBe(sent.suggestedReply);
    expect(w.state.audits.map((a: any) => a.action)).toContain('inbox.item_sent');
  });

  it('sends the human’s edited text and records it as the sent text', async () => {
    const w = buildWorld();
    const item = seedItem(w);
    const sent = await w.service.sendReply(ORG, manager, 'brand-1', item.id, {
      text: 'Edited reply: Rs 450 today only',
    });
    expect(w.state.replyCalls[0].message).toBe('Edited reply: Rs 450 today only');
    expect(sent.sentText).toBe('Edited reply: Rs 450 today only');
    const audit = w.state.audits.find((a: any) => a.action === 'inbox.item_sent');
    expect(audit.metadata.edited).toBe(true);
  });

  it('refuses on a paused brand with BRAND_PAUSED and never calls the provider', async () => {
    const w = buildWorld();
    const item = seedItem(w);
    w.state.brand.pausedAt = new Date();
    await expect(
      w.service.sendReply(ORG, manager, 'brand-1', item.id)
    ).rejects.toMatchObject({ code: 'BRAND_PAUSED' });
    expect(w.state.replyCalls).toHaveLength(0);
    expect(item.status).toBe('DRAFTED');
  });

  it('refuses non-drafted items: complaints are not sendable in v1', async () => {
    const w = buildWorld();
    const item = seedItem(w, { status: 'QUEUED', category: 'COMPLAINT', suggestedReply: null });
    await expect(
      w.service.sendReply(ORG, manager, 'brand-1', item.id)
    ).rejects.toMatchObject({ code: 'INBOX_ITEM_NOT_SENDABLE' });
    const sentItem = seedItem(w, { status: 'SENT', providerCommentId: 'c-2' });
    await expect(
      w.service.sendReply(ORG, manager, 'brand-1', sentItem.id)
    ).rejects.toMatchObject({ code: 'INBOX_ITEM_ALREADY_SENT' });
  });

  it('records a provider failure honestly and keeps the item DRAFTED', async () => {
    const w = buildWorld();
    const item = seedItem(w);
    w.state.replyBehaviour.mode = 'throw';
    await expect(
      w.service.sendReply(ORG, manager, 'brand-1', item.id)
    ).rejects.toMatchObject({ code: 'INBOX_REPLY_FAILED' });
    expect(item.status).toBe('DRAFTED');
    expect(item.sendError).toContain('invalid comment id');
    expect(w.state.audits.map((a: any) => a.action)).toContain(
      'inbox.item_send_failed'
    );
  });

  it('refuses when the provider cannot post replies, recording the error', async () => {
    const w = buildWorld();
    const item = seedItem(w);
    w.state.replyBehaviour.mode = 'unsupported';
    await expect(
      w.service.sendReply(ORG, manager, 'brand-1', item.id)
    ).rejects.toMatchObject({ code: 'INBOX_REPLY_UNSUPPORTED' });
    expect(item.sendError).toContain('cannot post replies');
    expect(w.state.replyCalls).toHaveLength(0);
  });

  it('refuses when the original post is not mapped locally', async () => {
    const w = buildWorld();
    const item = seedItem(w, { postId: null });
    await expect(
      w.service.sendReply(ORG, manager, 'brand-1', item.id)
    ).rejects.toMatchObject({ code: 'INBOX_POST_NOT_RESOLVED' });
    expect(item.sendError).toContain('not mapped');
  });

  it('gates send + dismiss on a queue-worker function', async () => {
    const w = buildWorld({ functions: ['REVIEWER'] });
    const item = seedItem(w);
    await expect(
      w.service.sendReply(ORG, manager, 'brand-1', item.id)
    ).rejects.toMatchObject({ code: 'REKTRS_FUNCTION_REQUIRED' });
    await expect(
      w.service.dismissItem(ORG, manager, 'brand-1', item.id)
    ).rejects.toMatchObject({ code: 'REKTRS_FUNCTION_REQUIRED' });
  });
});

describe('W6 dismiss', () => {
  it('dismisses a drafted item with an audit entry', async () => {
    const w = buildWorld();
    const item = seedItem(w);
    const dismissed = await w.service.dismissItem(ORG, manager, 'brand-1', item.id);
    expect(dismissed.status).toBe('DISMISSED');
    expect(dismissed.dismissedById).toBe('mgr-1');
    expect(w.state.audits.map((a: any) => a.action)).toContain(
      'inbox.item_dismissed'
    );
  });

  it('is idempotent on dismissed items and refuses sent ones', async () => {
    const w = buildWorld();
    const item = seedItem(w, { status: 'DISMISSED' });
    const again = await w.service.dismissItem(ORG, manager, 'brand-1', item.id);
    expect(again.status).toBe('DISMISSED');
    const sentItem = seedItem(w, { status: 'SENT', providerCommentId: 'c-3' });
    await expect(
      w.service.dismissItem(ORG, manager, 'brand-1', sentItem.id)
    ).rejects.toMatchObject({ code: 'INBOX_ITEM_ALREADY_SENT' });
  });
});

// ── The W1 ingestion hook (real lead engine + real inbox service) ────────────

describe('W6 hook inside the W1 lead engine', () => {
  function buildEngineWorld() {
    const w = buildWorld();
    const gateway: any = {
      supports: jest.fn(() => true),
      fetchPostComments: jest.fn(async () => w.state.fetchedComments),
      sendPrivateReply: jest.fn(async () => ({ messageId: 'dm-1' })),
    };
    const leads = new RektrsLeadsService(
      w.repo,
      w.audit,
      w.roles,
      w.alerts,
      gateway,
      w.service
    );
    return { w, gateway, leads };
  }

  function seedRule(w: ReturnType<typeof buildWorld>) {
    w.state.rule = {
      id: 'rule-1',
      organizationId: ORG,
      brandId: 'brand-1',
      enabled: true,
      keywords: ['price'],
      dmTemplate: 'Hi {{name}}! Ask us about {{keyword}}.',
      guardWords: [],
      useDefaultGuardWords: true,
      version: 1,
    };
  }

  it('one inbound comment feeds BOTH the lead machine and triage', async () => {
    const { w, leads } = buildEngineWorld();
    seedSettings(w);
    seedRule(w);
    const { outcome } = await leads.processInboundComment(
      ORG,
      w.state.integration,
      comment()
    );
    expect(outcome).toBe('lead');
    expect(w.state.leads).toHaveLength(1);
    expect(w.state.leads[0].status).toBe('DM_SENT');
    expect(w.state.items).toHaveLength(1);
    expect(w.state.items[0].category).toBe('FAQ_PRICE');
    expect(w.state.items[0].status).toBe('DRAFTED');
  });

  it('a guard comment lands in BOTH human queues', async () => {
    const { w, leads } = buildEngineWorld();
    seedSettings(w);
    seedRule(w);
    const { outcome } = await leads.processInboundComment(
      ORG,
      w.state.integration,
      comment({ commentId: 'c-20', text: 'I need a refund right now' })
    );
    expect(outcome).toBe('guard');
    expect(w.state.leads[0].status).toBe('HUMAN_REVIEW');
    expect(w.state.items[0].category).toBe('COMPLAINT');
    expect(w.state.items[0].status).toBe('QUEUED');
    expect(w.state.complaintAlerts).toHaveLength(1);
  });

  it('the seen-claim dedupes triage too: a redelivery creates nothing twice', async () => {
    const { w, leads } = buildEngineWorld();
    seedSettings(w);
    seedRule(w);
    await leads.processInboundComment(ORG, w.state.integration, comment());
    const second = await leads.processInboundComment(
      ORG,
      w.state.integration,
      comment()
    );
    expect(second.outcome).toBe('seen');
    expect(w.state.leads).toHaveLength(1);
    expect(w.state.items).toHaveLength(1);
  });

  it('the poller covers triage-only brands (no lead rule) — inboxBrands tally', async () => {
    const { w, leads } = buildEngineWorld();
    seedSettings(w);
    w.state.publishedPosts = [
      { id: 'post-int-1', integrationId: 'int-1', releaseId: 'post-9' },
    ];
    w.state.fetchedComments = [comment()];
    const tallies = await leads.syncLeadComments(new Date());
    expect(tallies.inboxBrands).toBe(1);
    expect(tallies.comments).toBe(1);
    expect(w.state.leads).toHaveLength(0);
    expect(w.state.items).toHaveLength(1);
    expect(w.state.items[0].status).toBe('DRAFTED');
  });

  it('without the hook wired, ingestion is W1-only (the pre-W6 behaviour)', async () => {
    const w = buildWorld();
    seedSettings(w);
    seedRule(w);
    const gateway: any = {
      supports: jest.fn(() => true),
      fetchPostComments: jest.fn(async () => []),
      sendPrivateReply: jest.fn(async () => ({ messageId: 'dm-1' })),
    };
    const leadsOnly = new RektrsLeadsService(
      w.repo,
      w.audit,
      w.roles,
      w.alerts,
      gateway
    );
    const { outcome } = await leadsOnly.processInboundComment(
      ORG,
      w.state.integration,
      comment()
    );
    expect(outcome).toBe('lead');
    expect(w.state.items).toHaveLength(0);
  });
});
