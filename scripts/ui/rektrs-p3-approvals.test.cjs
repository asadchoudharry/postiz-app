// REKTRS P3-3 component tests in the style of rektrs-next16-review.test.cjs:
// the real P3 components are transpiled and rendered in jsdom, with the
// app seams (SWR, fetch, user context, toaster, translation, Next) stubbed
// at the module loader. Covers design P3-1 §6.2's core assertions:
//   - the review inbox renders IN_REVIEW items and flags the maker's own
//     items as non-decidable (maker-checker preview);
//   - a 403 from the inbox surfaces the REVIEWER-function explanation;
//   - the decision panel hides on the maker's own submission (with the
//     maker-checker note) and shows for another reviewer's submission;
//   - requesting changes without a comment is refused client-side and
//     sends nothing; with a comment it POSTs the decision carrying an
//     Idempotency-Key header and expectedVersion (If-Match semantics);
//   - API error codes map to readable messages (maker-checker first).
// Does not imply browser/visual fidelity, server approval, or production
// readiness.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
});
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(global, 'navigator', {
  configurable: true,
  value: dom.window.navigator,
});

const { render, fireEvent, cleanup, waitFor } = require('@testing-library/react');
const root = path.resolve(__dirname, '../..');
const fixture = fs.mkdtempSync(path.join(root, 'node_modules', '.rektrs-p3-ui-'));

function compile(source, filename) {
  const input = path.join(root, 'apps/frontend/src/components/rektrs', source);
  const output = ts.transpileModule(fs.readFileSync(input, 'utf8'), {
    fileName: input,
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  });
  const out = path.join(fixture, filename);
  fs.writeFileSync(out, output.outputText);
  return out;
}

const apiFile = compile('rektrs.api.ts', 'rektrs.api.js');
const sharedFile = compile('rektrs.shared.tsx', 'rektrs.shared.js');
const inboxFile = compile('review.inbox.component.tsx', 'review.inbox.component.js');
const detailFile = compile('submission.detail.component.tsx', 'submission.detail.component.js');

// ── Mutable stub state, set per test before rendering ─────────────────────
const stub = {
  user: { id: 'user-reviewer', role: 'ADMIN', email: 'reviewer@example.com' },
  swr: new Map(),
  fetchCalls: [],
};

const useSWRStub = (key) => {
  if (!key) {
    return { data: undefined, error: undefined, isLoading: false, mutate: async () => {} };
  }
  const entry = stub.swr.get(key);
  if (!entry) {
    return { data: undefined, error: undefined, isLoading: true, mutate: async () => {} };
  }
  return {
    data: entry.data,
    error: entry.error,
    isLoading: false,
    mutate: async () => {},
  };
};

const fetchStub = async (url, options = {}) => {
  stub.fetchCalls.push({ url, options });
  return {
    ok: true,
    status: 200,
    json: async () => ({}),
  };
};

const ButtonStub = ({ children, loading, secondary, innerClassName, ...props }) =>
  React.createElement('button', { ...props, disabled: loading || props.disabled }, children);

const moduleStubs = new Map([
  ['swr', { __esModule: true, default: useSWRStub, useSWRConfig: () => ({ mutate: async () => {} }) }],
  ['@gitroom/helpers/utils/custom.fetch', { useFetch: () => fetchStub }],
  ['@gitroom/frontend/components/layout/user.context', { useUser: () => stub.user }],
  ['@gitroom/frontend/components/layout/loading', { LoadingComponent: () => null }],
  ['@gitroom/react/toaster/toaster', { useToaster: () => ({ show: () => {} }) }],
  [
    '@gitroom/react/translation/get.transation.service.client',
    { useT: () => (key, fallback) => fallback ?? key },
  ],
  [
    '@gitroom/react/form/button',
    { Button: ButtonStub },
  ],
  [
    '@gitroom/react/helpers/use.media.directory',
    { useMediaDirectory: () => ({ set: (p) => `/media/${p}` }) },
  ],
  [
    'next/link',
    {
      __esModule: true,
      default: ({ href, children, ...props }) =>
        React.createElement('a', { href, ...props }, children),
    },
  ],
]);

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  // The two real REKTRS modules route to their compiled fixture files (the
  // require cache makes the components and this test share one instance).
  if (request === '@gitroom/frontend/components/rektrs/rektrs.api') {
    return require(apiFile);
  }
  if (request === '@gitroom/frontend/components/rektrs/rektrs.shared') {
    return require(sharedFile);
  }
  if (moduleStubs.has(request)) {
    return moduleStubs.get(request);
  }
  return originalLoad.call(this, request, parent, isMain);
};

const api = require(apiFile);
const { ReviewInboxComponent } = require(inboxFile);
const { SubmissionDetailComponent } = require(detailFile);

test.afterEach(() => {
  cleanup();
  stub.swr = new Map();
  stub.fetchCalls = [];
  stub.user = { id: 'user-reviewer', role: 'ADMIN', email: 'reviewer@example.com' };
});
test.after(() => {
  Module._load = originalLoad;
  dom.window.close();
  fs.rmSync(fixture, { force: true, recursive: true });
});

// ── Fixtures ──────────────────────────────────────────────────────────────
const BRAND = {
  id: 'brand-1',
  name: 'Acme',
  slug: 'acme',
  colorPrimary: '#123456',
  colorSecondary: null,
  approvalRequired: true,
  channels: [],
  version: 1,
};
const CAMPAIGN = { id: 'camp-1', brandId: 'brand-1', name: 'Launch week', status: 'ACTIVE' };
const TEAM = [
  { membershipId: 'm1', role: 'ADMIN', userId: 'user-maker', email: 'maker@example.com' },
  { membershipId: 'm2', role: 'ADMIN', userId: 'user-reviewer', email: 'reviewer@example.com' },
];
const INTEGRATIONS = [
  { id: 'int-1', name: 'Acme LinkedIn', identifier: 'linkedin', picture: null },
];

const makeDetail = (overrides = {}) => ({
  id: 'sub-1',
  organizationId: 'org-1',
  batchId: 'batch-1234567890abcdef',
  brandId: 'brand-1',
  campaignId: 'camp-1',
  state: 'IN_REVIEW',
  round: 1,
  submittedById: 'user-maker',
  submittedAt: '2026-11-13T10:00:00.000Z',
  decidedById: null,
  decidedAt: null,
  decision: null,
  approvedHash: null,
  expiresAt: null,
  createdById: 'user-maker',
  createdAt: '2026-11-13T09:00:00.000Z',
  updatedAt: '2026-11-13T10:00:00.000Z',
  version: 3,
  versions: [
    {
      id: 'v1',
      organizationId: 'org-1',
      approvalId: 'sub-1',
      integrationId: 'int-1',
      group: 'g1',
      versionNo: 1,
      payload: {
        integrationId: 'int-1',
        providerIdentifier: 'linkedin',
        parts: [{ content: 'Hello launch day', delay: 0, image: [] }],
        settings: null,
        title: null,
        description: null,
      },
      contentHash: 'abcdef1234567890',
      createdById: 'user-maker',
      createdAt: '2026-11-13T10:00:00.000Z',
    },
  ],
  events: [],
  ...overrides,
});

const seedCommon = (detail) => {
  stub.swr.set('/rektrs/v1/brands', { data: [BRAND] });
  stub.swr.set('/rektrs/v1/campaigns', { data: [CAMPAIGN] });
  stub.swr.set('/rektrs/team-members', { data: TEAM });
  stub.swr.set('/integrations/list', { data: INTEGRATIONS });
  stub.swr.set('/rektrs/v1/org/settings', {
    data: {
      approvalRequiredDefault: false,
      allowSelfApproval: false,
      approvalTtlHours: null,
      clientApprovalEnabled: false,
    },
  });
  if (detail) {
    stub.swr.set(`/rektrs/v1/submissions/${detail.id}`, { data: detail });
    stub.swr.set(`/rektrs/v1/submissions/${detail.id}/audit`, {
      data: { timeline: [] },
    });
  }
};

// ── Pure API-module behaviour ─────────────────────────────────────────────
test('error codes map to readable messages, maker-checker first', () => {
  const mc = new api.RektrsApiError(403, 'MAKER_CHECKER_VIOLATION', 'server text');
  assert.equal(
    api.readableRektrsError(mc, 'fallback'),
    "You created this submission, so you can't approve it — another reviewer has to decide."
  );
  const unknown = new api.RektrsApiError(500, 'SOMETHING_ELSE', 'server text wins');
  assert.equal(api.readableRektrsError(unknown, 'fallback'), 'server text wins');
  assert.equal(api.readableRektrsError(new Error('boom'), 'fallback'), 'boom');
  assert.equal(api.readableRektrsError(null, 'fallback'), 'fallback');
});

test('parseRektrsResponse throws a coded error on !ok and returns the body on ok', async () => {
  await assert.rejects(
    () =>
      api.parseRektrsResponse({
        ok: false,
        status: 422,
        json: async () => ({ code: 'BATCH_SPANS_BRANDS', message: 'spans' }),
      }),
    (err) => err instanceof api.RektrsApiError && err.code === 'BATCH_SPANS_BRANDS' && err.status === 422
  );
  const body = await api.parseRektrsResponse({
    ok: true,
    status: 200,
    json: async () => ({ fine: true }),
  });
  assert.deepEqual(body, { fine: true });
});

test('slugifyClient and idempotency keys behave', () => {
  assert.equal(api.slugifyClient('  Acme Corp! 2026 '), 'acme-corp-2026');
  assert.equal(api.slugifyClient('---'), '');
  assert.notEqual(api.newIdempotencyKey(), api.newIdempotencyKey());
});

// ── Review inbox ──────────────────────────────────────────────────────────
test('inbox renders IN_REVIEW items and flags the maker’s own as non-decidable', async () => {
  const mine = makeDetail({ id: 'sub-mine', submittedById: 'user-reviewer' });
  const theirs = makeDetail({ id: 'sub-theirs', submittedById: 'user-maker' });
  stub.swr.set('/rektrs/v1/review/inbox', {
    data: [
      { ...theirs, decidable: true },
      { ...mine, decidable: false },
    ],
  });
  seedCommon(null);
  stub.swr.set('/rektrs/v1/submissions/sub-theirs', { data: theirs });
  stub.swr.set('/rektrs/v1/submissions/sub-mine', { data: mine });

  const view = render(React.createElement(ReviewInboxComponent));
  assert.equal(view.getAllByText('Acme').length, 2);
  assert.equal(view.getAllByText('Launch week').length, 2);
  assert.ok(view.getByText(/maker@example\.com/));
  assert.ok(view.getByText('Awaiting decision'));
  assert.ok(view.getByText('Yours — needs another reviewer'));
  await waitFor(() =>
    assert.equal(view.getAllByText(/1 channel\(s\) · 1 post\(s\)/).length, 2)
  );
});

test('inbox explains the REVIEWER function on a 403', () => {
  stub.swr.set('/rektrs/v1/review/inbox', {
    error: new api.RektrsApiError(403, 'REKTRS_FUNCTION_REQUIRED', 'Requires REVIEWER'),
  });
  seedCommon(null);
  const view = render(React.createElement(ReviewInboxComponent));
  assert.ok(view.getByText(/needs the REVIEWER function/));
});

// ── Submission detail: decision gating ────────────────────────────────────
test('another reviewer sees the decision panel and the snapshot content', () => {
  seedCommon(makeDetail());
  const view = render(
    React.createElement(SubmissionDetailComponent, { submissionId: 'sub-1', mode: 'review' })
  );
  assert.ok(view.getByText('Hello launch day'));
  assert.ok(view.getByRole('button', { name: 'Approve' }));
  assert.ok(view.getByRole('button', { name: 'Request changes' }));
  assert.ok(view.getByRole('button', { name: 'Reject' }));
});

test('the maker sees the maker-checker note and no decision buttons on their own submission', () => {
  stub.user = { id: 'user-maker', role: 'ADMIN', email: 'maker@example.com' };
  seedCommon(makeDetail());
  const view = render(
    React.createElement(SubmissionDetailComponent, { submissionId: 'sub-1', mode: 'review' })
  );
  assert.ok(view.getByText(/You created this submission, so you can’t approve it/));
  assert.equal(view.queryByRole('button', { name: 'Approve' }), null);
});

test('requesting changes without a comment sends nothing; with one it posts decision + idempotency + version', async () => {
  seedCommon(makeDetail());
  const view = render(
    React.createElement(SubmissionDetailComponent, { submissionId: 'sub-1', mode: 'review' })
  );
  fireEvent.click(view.getByRole('button', { name: 'Request changes' }));
  assert.ok(view.getByText(/A comment is required when you request changes or reject/));
  assert.equal(stub.fetchCalls.length, 0);

  const textarea = view.container.querySelector('textarea');
  fireEvent.change(textarea, { target: { value: 'Please fix the headline' } });
  fireEvent.click(view.getByRole('button', { name: 'Request changes' }));
  await waitFor(() => assert.equal(stub.fetchCalls.length, 1));
  const call = stub.fetchCalls[0];
  assert.equal(call.url, '/rektrs/v1/submissions/sub-1/decisions');
  assert.equal(call.options.method, 'POST');
  assert.ok(call.options.headers['Idempotency-Key'], 'idempotency key header present');
  const body = JSON.parse(call.options.body);
  assert.equal(body.decision, 'REQUEST_CHANGES');
  assert.equal(body.comment, 'Please fix the headline');
  assert.equal(body.expectedVersion, 3);
});
