/**
 * REKTRS W1 — Comment-to-DM Lead Machine (AUTOMATION-WORKFLOWS.md W1).
 * Pure matching/signing units + the lead engine against in-memory fakes.
 * The provider boundary (RektrsCommentGateway) and global fetch are mocked:
 * no real DM is ever sent and no real webhook is ever called from tests.
 * @jest-environment node
 */
import { Prisma } from '@prisma/client';
import {
  matchLeadComment,
  normalizePhraseList,
  renderLeadDmTemplate,
  signLeadWebhookPayload,
  verifyLeadWebhookSignature,
  verifyMetaWebhookSignature,
  REKTRS_DEFAULT_GUARD_WORDS,
} from '@gitroom/nestjs-libraries/rektrs/rektrs.leads';
import { RektrsLeadsService } from '@gitroom/nestjs-libraries/rektrs/rektrs.leads.service';
import { RektrsRolesService } from '@gitroom/nestjs-libraries/rektrs/rektrs.roles.service';
import { rektrsError } from '@gitroom/nestjs-libraries/rektrs/rektrs.errors';
import { createHmac } from 'crypto';

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
jest.mock('@gitroom/nestjs-libraries/rektrs/rektrs.lead-providers', () => ({
  RektrsCommentGateway: class {},
}));
// W6: the triage hook is optional in this harness (never constructed
// here); its real behaviour is covered by rektrs.inbox.service.spec.ts.
jest.mock('@gitroom/nestjs-libraries/rektrs/rektrs.inbox.service', () => ({
  RektrsInboxService: class {},
}));

const ORG = 'org-1';
const SECRET = 'test-signing-secret-0123456789';
const CRM_URL = 'https://8.8.8.8/crm-hook'; // public literal IP: SSRF check needs no DNS
const manager: any = { kind: 'USER', userId: 'mgr-1' };

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

function buildWorld(opts: { crm?: any; functions?: string[] } = {}) {
  const state: any = {
    leads: [],
    seen: new Set<string>(),
    brand: {
      id: 'brand-1',
      organizationId: ORG,
      name: 'Brand One',
      pausedAt: null,
      deletedAt: null,
    },
    rule: {
      id: 'rule-1',
      organizationId: ORG,
      brandId: 'brand-1',
      enabled: true,
      keywords: ['price', 'order'],
      dmTemplate: 'Hi {{name}}! Thanks for asking about {{keyword}}. Order here: {{link}}',
      guardWords: [],
      useDefaultGuardWords: true,
      version: 1,
    },
    integration: {
      id: 'int-1',
      organizationId: ORG,
      providerIdentifier: 'facebook',
      internalId: 'page-1',
      token: '<redacted>',
      disabled: false,
      deletedAt: null,
    },
    internalPost: {
      id: 'post-int-1',
      integrationId: 'int-1',
      releaseId: 'post-9',
      releaseURL: 'https://facebook.com/post-9',
      parentPostId: null,
    },
    publishedPosts: [],
    fetchedComments: [],
    crm:
      opts.crm !== undefined
        ? opts.crm
        : { url: CRM_URL, secret: SECRET, enabled: true },
    functions: opts.functions ?? ['MANAGER', 'CREATOR', 'ANALYST', 'REVIEWER', 'PUBLISHER'],
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
          (l: any) => l.integrationId === data.integrationId && l.commentId === data.commentId
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
      count: jest.fn(
        async ({ where }: any) =>
          state.leads.filter(
            (l: any) => l.organizationId === where.organizationId && l.status === where.status
          ).length
      ),
    },
    leadRule: {
      create: jest.fn(async ({ data }: any) => {
        state.rule = { id: 'rule-1', version: 1, ...data };
        return state.rule;
      }),
      update: jest.fn(async ({ data }: any) => applyData(state.rule, data)),
    },
    post: { findFirst: jest.fn(async () => state.internalPost) },
    integration: { findFirst: jest.fn(async () => state.integration) },
  };

  const repo: any = {
    db: () => db,
    transaction: async (cb: any) => cb({}),
    brandById: jest.fn(async () => state.brand),
    brandIntegrationByIntegration: jest.fn(async () => state.link),
    leadRuleByBrand: jest.fn(async () => state.rule),
    leadById: jest.fn(
      async (_org: string, id: string) =>
        state.leads.find((l: any) => l.id === id) ?? null
    ),
    leadForCommenterPost: jest.fn(
      async (ruleId: string, providerPostId: string, commenterId: string) =>
        state.leads.find(
          (l: any) =>
            l.ruleId === ruleId &&
            l.providerPostId === providerPostId &&
            l.commenterId === commenterId
        ) ?? null
    ),
    leadsOfOrg: jest.fn(async () => state.leads),
    leadsAwaitingWebhook: jest.fn(async (max: number) =>
      state.leads.filter(
        (l: any) =>
          ['DM_SENT', 'WEBHOOK_PENDING'].includes(l.status) && l.webhookAttempts < max
      )
    ),
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
    publishedPostsForChannels: jest.fn(async () => state.publishedPosts),
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
    getFunctions: jest.fn(async () => state.functions),
    getCrmWebhookConfig: jest.fn(async () => state.crm),
    getOrgSettings: jest.fn(async () => ({})),
  };
  const alerts: any = { alertNewLead: jest.fn(async () => {}) };
  const gateway: any = {
    supports: jest.fn(() => true),
    fetchPostComments: jest.fn(async () => state.fetchedComments),
    sendPrivateReply: jest.fn(async () => ({ messageId: 'dm-1' })),
  };

  const service = new RektrsLeadsService(
    repo,
    audit,
    roles,
    alerts,
    gateway
  );
  return { state, repo, db, audit, roles, alerts, gateway, service };
}

let fetchMock: jest.Mock;
beforeEach(() => {
  fetchMock = jest.fn(async () => ({ status: 200 }));
  (global as any).fetch = fetchMock;
});
afterEach(() => {
  delete (global as any).fetch;
});

// ── Pure domain ──────────────────────────────────────────────────────────────

describe('W1 matching (pure)', () => {
  const rule = { keywords: ['price', 'best price'], guardWords: [] as string[], useDefaultGuardWords: true };

  it('matches a keyword on word boundaries, case-insensitively', () => {
    expect(matchLeadComment('What is the PRICE?', rule)).toEqual({
      kind: 'keyword',
      phrase: 'price',
    });
    expect(matchLeadComment('the best price today', rule).kind).toBe('keyword');
  });

  it('does not match inside a larger word', () => {
    expect(matchLeadComment('priceless stuff', rule).kind).toBe('none');
  });

  it('guard words beat keywords', () => {
    const m = matchLeadComment('I want a refund, what was the price?', rule);
    expect(m.kind).toBe('guard');
    expect(m.phrase).toBe('refund');
  });

  it('default guard list covers Urdu + Arabic complaint words', () => {
    expect(REKTRS_DEFAULT_GUARD_WORDS).toContain('شکایت');
    expect(REKTRS_DEFAULT_GUARD_WORDS).toContain('احتيال');
    expect(matchLeadComment('یہ فراڈ ہے', rule).kind).toBe('guard');
    expect(matchLeadComment('هذا احتيال واضح', rule).kind).toBe('guard');
  });

  it('brand guard words extend the defaults; disabling defaults keeps brand words', () => {
    const custom = { keywords: [] as string[], guardWords: ['angry'], useDefaultGuardWords: true };
    expect(matchLeadComment('I am angry', custom).kind).toBe('guard');
    const noDefaults = { keywords: [] as string[], guardWords: [] as string[], useDefaultGuardWords: false };
    expect(matchLeadComment('refund please', noDefaults).kind).toBe('none');
  });

  it('renders the DM template with name/keyword/link and a name fallback', () => {
    expect(
      renderLeadDmTemplate('Hi {{name}}, re {{keyword}}: {{link}} {{unknown}}', {
        name: 'Ali',
        keyword: 'price',
        link: 'https://x',
      })
    ).toBe('Hi Ali, re price: https://x {{unknown}}');
    expect(renderLeadDmTemplate('Hi {{name}}', {})).toBe('Hi there');
  });

  it('normalises phrase lists (case, whitespace, dupes)', () => {
    expect(normalizePhraseList([' Price ', 'price', 'ORDER  now', ''])).toEqual([
      'price',
      'order now',
    ]);
  });
});

describe('W1 webhook signing (pure)', () => {
  it('signs and verifies a roundtrip; tampering and staleness fail', () => {
    const body = JSON.stringify({ event: 'lead.created', leadId: 'l1' });
    const ts = 1_770_000_000;
    const header = signLeadWebhookPayload(SECRET, ts, body);
    expect(header).toMatch(/^t=1770000000,v1=[0-9a-f]{64}$/);
    expect(verifyLeadWebhookSignature(SECRET, header, body, 300, ts + 60)).toBe(true);
    expect(verifyLeadWebhookSignature(SECRET, header, body + 'x', 300, ts + 60)).toBe(false);
    expect(verifyLeadWebhookSignature(SECRET, header, body, 300, ts + 10_000)).toBe(false);
    expect(verifyLeadWebhookSignature('wrong-secret', header, body, 300, ts)).toBe(false);
  });

  it('verifies Meta webhook signatures over the raw body', () => {
    const raw = Buffer.from('{"object":"page","entry":[]}');
    const good =
      'sha256=' + createHmac('sha256', 'app-secret').update(raw).digest('hex');
    expect(verifyMetaWebhookSignature('app-secret', good, raw)).toBe(true);
    expect(verifyMetaWebhookSignature('app-secret', 'sha256=deadbeef', raw)).toBe(false);
    expect(verifyMetaWebhookSignature('', good, raw)).toBe(false);
  });
});

// ── Engine ───────────────────────────────────────────────────────────────────

describe('W1 lead engine', () => {
  it('keyword match → DM with rendered template → signed webhook → COMPLETE', async () => {
    const w = buildWorld();
    const { outcome } = await w.service.processInboundComment(ORG, w.state.integration, comment());
    expect(outcome).toBe('lead');

    expect(w.gateway.sendPrivateReply).toHaveBeenCalledTimes(1);
    const dmText = w.gateway.sendPrivateReply.mock.calls[0][2];
    expect(dmText).toBe(
      'Hi Ali Raza! Thanks for asking about price. Order here: https://facebook.com/post-9'
    );

    const lead = w.state.leads[0];
    expect(lead.status).toBe('COMPLETE');
    expect(lead.dmMessageId).toBe('dm-1');
    expect(lead.matchedKeyword).toBe('price');
    expect(lead.postId).toBe('post-int-1');
    expect(lead.enrichment.source).toBe('provider_comment');

    // Webhook: one signed attempt, payload shape per spec.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(CRM_URL);
    const payload = JSON.parse(init.body);
    expect(payload).toMatchObject({
      event: 'lead.created',
      brand: { id: 'brand-1', name: 'Brand One' },
      platform: 'facebook',
      postId: 'post-int-1',
      providerPostId: 'post-9',
      commenter: { id: 'user-7', name: 'Ali Raza' },
      comment: { id: 'c-1', text: 'what is the price?' },
      keywordMatched: 'price',
    });
    const signature = init.headers['X-Rektrs-Signature'];
    expect(
      verifyLeadWebhookSignature(SECRET, signature, init.body, 300)
    ).toBe(true);

    const actions = w.audit.write.mock.calls.map((c: any[]) => c[2].action);
    expect(actions).toContain('lead.created');
    expect(actions).toContain('lead.webhook_delivered');
    expect(w.alerts.alertNewLead).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ humanReview: false })
    );
  });

  it('ingestion dedupe: the same comment arriving twice is processed once', async () => {
    const w = buildWorld();
    await w.service.processInboundComment(ORG, w.state.integration, comment());
    const second = await w.service.processInboundComment(ORG, w.state.integration, comment());
    expect(second.outcome).toBe('seen');
    expect(w.gateway.sendPrivateReply).toHaveBeenCalledTimes(1);
    expect(w.state.leads).toHaveLength(1);
  });

  it('per-commenter-per-post dedupe: a second keyword comment on the same post does not re-DM', async () => {
    const w = buildWorld();
    await w.service.processInboundComment(ORG, w.state.integration, comment());
    const dup = await w.service.processInboundComment(
      ORG,
      w.state.integration,
      comment({ commentId: 'c-2', text: 'and the order link?' })
    );
    expect(dup.outcome).toBe('duplicate');
    expect(w.gateway.sendPrivateReply).toHaveBeenCalledTimes(1);

    const otherPost = await w.service.processInboundComment(
      ORG,
      w.state.integration,
      comment({ commentId: 'c-3', providerPostId: 'post-10' })
    );
    expect(otherPost.outcome).toBe('lead');
    expect(w.gateway.sendPrivateReply).toHaveBeenCalledTimes(2);
  });

  it('guard word short-circuits: human-review lead, no DM, no webhook', async () => {
    const w = buildWorld();
    const { outcome } = await w.service.processInboundComment(
      ORG,
      w.state.integration,
      comment({ text: 'this is a scam, refund me' })
    );
    expect(outcome).toBe('guard');
    const lead = w.state.leads[0];
    expect(lead.status).toBe('HUMAN_REVIEW');
    expect(lead.matchedGuardWord).toBe('refund');
    expect(w.gateway.sendPrivateReply).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(w.alerts.alertNewLead).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ humanReview: true })
    );
  });

  it('DM failure is honest: lead is DM_FAILED with the error, webhook never fires, ingestion does not throw', async () => {
    const w = buildWorld();
    w.gateway.sendPrivateReply.mockRejectedValue(new Error('(#100) private reply window closed'));
    const { outcome } = await w.service.processInboundComment(ORG, w.state.integration, comment());
    expect(outcome).toBe('dm_failed');
    const lead = w.state.leads[0];
    expect(lead.status).toBe('DM_FAILED');
    expect(lead.dmError).toContain('private reply window closed');
    expect(lead.dmMessageId ?? null).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    const actions = w.audit.write.mock.calls.map((c: any[]) => c[2].action);
    expect(actions).toContain('lead.dm_failed');
    expect(actions).not.toContain('lead.created');
  });

  it('webhook failure parks the lead in WEBHOOK_PENDING and the sweep exhausts it to WEBHOOK_FAILED', async () => {
    const w = buildWorld();
    fetchMock.mockResolvedValue({ status: 500 });
    await w.service.processInboundComment(ORG, w.state.integration, comment());
    const lead = w.state.leads[0];
    expect(lead.status).toBe('WEBHOOK_PENDING');
    expect(lead.webhookAttempts).toBe(1);
    expect(lead.webhookError).toContain('HTTP 500');

    lead.webhookAttempts = 4; // one attempt left in the budget
    const tallies = await w.service.sweepLeadWebhooks();
    expect(tallies.attempted).toBe(1);
    expect(lead.status).toBe('WEBHOOK_FAILED');
    expect(lead.webhookAttempts).toBe(5);
  });

  it('with the CRM webhook disabled the lead honestly ends at DM_SENT', async () => {
    const w = buildWorld({ crm: { url: null, secret: null, enabled: false } });
    const { outcome } = await w.service.processInboundComment(ORG, w.state.integration, comment());
    expect(outcome).toBe('lead');
    expect(w.state.leads[0].status).toBe('DM_SENT');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no-ops quietly: disabled rule, paused brand, own-channel comment, plain comment', async () => {
    const w = buildWorld();
    w.state.rule = { ...w.state.rule, enabled: false };
    expect(
      (await w.service.processInboundComment(ORG, w.state.integration, comment())).outcome
    ).toBe('no_rule');

    const w2 = buildWorld();
    w2.state.brand = { ...w2.state.brand, pausedAt: new Date() };
    w2.state.link = { ...w2.state.link, brand: w2.state.brand };
    expect(
      (await w2.service.processInboundComment(ORG, w2.state.integration, comment())).outcome
    ).toBe('no_rule');

    const w3 = buildWorld();
    expect(
      (
        await w3.service.processInboundComment(
          ORG,
          w3.state.integration,
          comment({ commenterId: 'page-1' })
        )
      ).outcome
    ).toBe('no_match');
    expect(
      (
        await w3.service.processInboundComment(
          ORG,
          w3.state.integration,
          comment({ commentId: 'c-9', text: 'nice photo!' })
        )
      ).outcome
    ).toBe('no_match');
  });

  it('poll sync feeds the engine and isolates a post fetch failure', async () => {
    const w = buildWorld();
    w.state.publishedPosts = [
      { id: 'post-int-1', integrationId: 'int-1', releaseId: 'post-9' },
      { id: 'post-int-2', integrationId: 'int-1', releaseId: 'post-bad' },
    ];
    w.gateway.fetchPostComments
      .mockResolvedValueOnce([
        comment(),
        comment({ commentId: 'c-2', text: 'refund!! this is a scam' }),
      ])
      .mockRejectedValueOnce(new Error('graph down'));
    const tallies = await w.service.syncLeadComments();
    expect(tallies.leads).toBe(1);
    expect(tallies.guards).toBe(1);
    expect(tallies.errors).toBe(1);
    expect(w.state.leads).toHaveLength(2);
  });
});

// ── Settings + queue actions ─────────────────────────────────────────────────

describe('W1 settings + queue actions', () => {
  it('rule update requires MANAGER and a keyword + template to enable', async () => {
    const w = buildWorld({ functions: ['CREATOR'] });
    await expect(
      w.service.updateLeadRule(ORG, manager, 'brand-1', { enabled: true })
    ).rejects.toMatchObject({ code: 'REKTRS_FUNCTION_REQUIRED' });

    const w2 = buildWorld();
    await expect(
      w2.service.updateLeadRule(ORG, manager, 'brand-1', {
        enabled: true,
        keywords: [],
        dmTemplate: 'hi',
      })
    ).rejects.toMatchObject({ code: 'LEAD_RULE_KEYWORDS_REQUIRED' });

    const saved = await w2.service.updateLeadRule(ORG, manager, 'brand-1', {
      enabled: true,
      keywords: [' Price ', 'price'],
      dmTemplate: 'Hello {{name}}',
    });
    expect(saved.keywords).toEqual(['price']);
    expect(saved.enabled).toBe(true);
  });

  it('mark handled closes a human-review lead and refuses others', async () => {
    const w = buildWorld();
    await w.service.processInboundComment(
      ORG,
      w.state.integration,
      comment({ text: 'fraud! refund now' })
    );
    const lead = w.state.leads[0];
    const handled = await w.service.markHandled(ORG, manager, lead.id);
    expect(handled.status).toBe('HANDLED');
    expect(handled.handledById).toBe('mgr-1');
    await expect(w.service.markHandled(ORG, manager, lead.id)).rejects.toMatchObject({
      code: 'LEAD_NOT_ACTIONABLE',
    });
  });

  it('manual retry re-sends a failed DM and completes the lead', async () => {
    const w = buildWorld();
    w.gateway.sendPrivateReply.mockRejectedValueOnce(new Error('window closed'));
    await w.service.processInboundComment(ORG, w.state.integration, comment());
    expect(w.state.leads[0].status).toBe('DM_FAILED');
    const retried = await w.service.retryLead(ORG, manager, w.state.leads[0].id);
    expect(retried.status).toBe('COMPLETE');
    const actions = w.audit.write.mock.calls.map((c: any[]) => c[2].action);
    expect(actions).toContain('lead.retry');
  });

  it('test ping is signed and reports the CRM answer; unconfigured → 422', async () => {
    const w = buildWorld();
    const result = await w.service.testCrmWebhook(ORG, manager);
    expect(result).toEqual({ ok: true, status: 200 });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body).event).toBe('lead.test');
    expect(
      verifyLeadWebhookSignature(SECRET, init.headers['X-Rektrs-Signature'], init.body, 300)
    ).toBe(true);

    const w2 = buildWorld({ crm: { url: null, secret: null, enabled: false } });
    await expect(w2.service.testCrmWebhook(ORG, manager)).rejects.toMatchObject({
      code: 'CRM_WEBHOOK_NOT_CONFIGURED',
    });
  });
});

// ── CRM secret handling in org settings ──────────────────────────────────────

describe('W1 CRM settings (roles service)', () => {
  function buildSettingsWorld() {
    const row: any = {
      organizationId: ORG,
      approvalRequiredDefault: false,
      allowSelfApproval: false,
      approvalTtlHours: null,
      clientApprovalEnabled: false,
      alertReminderHours: 4,
      alertEscalationHours: 12,
      alertInAppEnabled: true,
      alertEmailEnabled: true,
      crmWebhookUrl: null,
      crmWebhookSecret: null,
      crmWebhookEnabled: false,
    };
    const repo: any = {
      orgSettings: jest.fn(async () => row),
      transaction: async (cb: any) => cb({}),
      db: () => ({
        rektrsOrgSettings: {
          upsert: jest.fn(async ({ create, update }: any) => {
            Object.assign(row, update && Object.keys(update).length ? update : create);
            return row;
          }),
        },
      }),
    };
    const audit: any = { write: jest.fn(async () => {}) };
    const roles = new RektrsRolesService(repo, audit);
    return { row, repo, audit, roles };
  }

  it('the settings view never exposes the secret, only that one is set', async () => {
    const w = buildSettingsWorld();
    await w.roles.updateOrgSettings(ORG, manager, {
      crmWebhookUrl: CRM_URL,
      crmWebhookEnabled: true,
      crmWebhookSecret: SECRET,
    });
    const view = await w.roles.getOrgSettings(ORG);
    expect(view.crmWebhookSecretSet).toBe(true);
    expect(view.crmWebhookUrl).toBe(CRM_URL);
    expect(JSON.stringify(view)).not.toContain(SECRET);
    // …and the audit trail records the change without the value.
    const auditJson = JSON.stringify(w.audit.write.mock.calls);
    expect(auditJson).toContain('crmWebhookSecretChanged');
    expect(auditJson).not.toContain(SECRET);
    // Server-side read (delivery path) still gets the secret.
    expect((await w.roles.getCrmWebhookConfig(ORG)).secret).toBe(SECRET);
  });

  it('rejects unsafe URLs and short secrets', async () => {
    const w = buildSettingsWorld();
    await expect(
      w.roles.updateOrgSettings(ORG, manager, {
        crmWebhookUrl: 'https://127.0.0.1/hook',
      })
    ).rejects.toMatchObject({ code: 'CRM_WEBHOOK_URL_UNSAFE' });
    await expect(
      w.roles.updateOrgSettings(ORG, manager, { crmWebhookSecret: 'short' })
    ).rejects.toMatchObject({ code: 'CRM_WEBHOOK_SECRET_TOO_SHORT' });
  });
});
