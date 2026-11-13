import {
  buildVariantPayload,
  canonicalize,
  canonicalJson,
  computeBatchHash,
  computeVariantHash,
  RektrsPostRowLike,
} from '@gitroom/nestjs-libraries/rektrs/rektrs.hash';
import {
  actorKindCanDecide,
  assertTransition,
  canTransition,
  checkMakerChecker,
  RektrsStateError,
} from '@gitroom/nestjs-libraries/rektrs/rektrs.state';
import {
  defaultFunctionsForRole,
  resolveFunctions,
} from '@gitroom/nestjs-libraries/rektrs/rektrs.roles';

const row = (overrides: Partial<RektrsPostRowLike> = {}): RektrsPostRowLike => ({
  id: 'p1',
  integrationId: 'int-1',
  group: 'g1',
  parentPostId: null,
  content: 'Hello world',
  delay: 0,
  image: JSON.stringify([{ id: 'm1', path: '/uploads/a.png' }]),
  settings: JSON.stringify({
    __type: 'linkedin',
    options: { visibility: 'PUBLIC', carousel: true },
  }),
  title: 'Launch',
  description: null,
  createdAt: new Date('2026-01-01T10:00:00.000Z'),
  ...overrides,
});

const childRow = (): RektrsPostRowLike =>
  row({
    id: 'p2',
    parentPostId: 'p1',
    content: 'Second part',
    delay: 5,
    image: null,
    createdAt: new Date('2026-01-01T10:01:00.000Z'),
  });

const hashOf = (rows: RektrsPostRowLike[]) =>
  computeVariantHash(buildVariantPayload('int-1', 'linkedin', rows));

describe('rektrs canonical hash', () => {
  it('canonicalise sorts keys recursively and drops undefined', () => {
    expect(canonicalize({ b: 1, a: { d: [1, 2], c: 'x' } })).toEqual({
      a: { c: 'x', d: [1, 2] },
      b: 1,
    });
    expect(canonicalJson({ a: undefined, b: 1 })).toEqual('{"b":1}');
    expect(canonicalJson({ b: 1, a: 2 })).toEqual(canonicalJson({ a: 2, b: 1 }));
  });

  it('variant hash is deterministic for identical rows', () => {
    expect(hashOf([row(), childRow()])).toEqual(hashOf([row(), childRow()]));
  });

  it('thread order comes from the parent chain, not row order', () => {
    const payload = buildVariantPayload('int-1', 'linkedin', [childRow(), row()]);
    expect(payload.parts.map((p) => p.content)).toEqual([
      'Hello world',
      'Second part',
    ]);
    expect(payload.parts[1].delay).toEqual(5);
  });

  it('provider settings key order inside the JSON string does not change the hash', () => {
    const shuffled = row({
      settings: JSON.stringify({
        options: { carousel: true, visibility: 'PUBLIC' },
        __type: 'linkedin',
      }),
    });
    expect(hashOf([shuffled])).toEqual(hashOf([row()]));
  });

  it('publish timing is not part of the payload (rescheduling keeps approval)', () => {
    const payload = buildVariantPayload('int-1', 'linkedin', [row()]);
    expect(Object.keys(payload)).not.toContain('publishDate');
    expect(JSON.stringify(payload)).not.toContain('publishDate');
  });

  it('detects tampering: content, delay, media, title, settings all flip the hash', () => {
    const base = hashOf([row(), childRow()]);
    expect(hashOf([row({ content: 'Hello world!' }), childRow()])).not.toEqual(base);
    expect(
      hashOf([row(), row({ id: 'p2', parentPostId: 'p1', content: 'Second part', delay: 6, image: null })])
    ).not.toEqual(base);
    expect(
      hashOf([row({ image: JSON.stringify([{ id: 'm1', path: '/uploads/b.png' }]) }), childRow()])
    ).not.toEqual(base);
    expect(hashOf([row({ title: 'Other title' }), childRow()])).not.toEqual(base);
    expect(
      hashOf([
        row({
          settings: JSON.stringify({ __type: 'linkedin', options: { visibility: 'CONNECTIONS' } }),
        }),
        childRow(),
      ])
    ).not.toEqual(base);
  });

  it('batch hash is order-independent over variants but content-sensitive', () => {
    const set = [
      { integrationId: 'int-2', contentHash: hashOf([row({ integrationId: 'int-2' })]) },
      { integrationId: 'int-1', contentHash: hashOf([row()]) },
    ];
    expect(computeBatchHash('batch-1', set)).toEqual(
      computeBatchHash('batch-1', [...set].reverse())
    );
    expect(computeBatchHash('batch-1', set)).not.toEqual(computeBatchHash('batch-2', set));
    const changed = [
      set[0],
      { integrationId: 'int-1', contentHash: hashOf([row({ content: 'changed' })]) },
    ];
    expect(computeBatchHash('batch-1', changed)).not.toEqual(computeBatchHash('batch-1', set));
  });
});

describe('rektrs approval state machine', () => {
  it('walks the happy path', () => {
    expect(assertTransition('DRAFT', 'SUBMIT')).toEqual('IN_REVIEW');
    expect(assertTransition('IN_REVIEW', 'DECIDE_APPROVE')).toEqual('APPROVED');
    expect(assertTransition('APPROVED', 'SCHEDULE')).toEqual('SCHEDULED');
    expect(assertTransition('SCHEDULED', 'MARK_PUBLISHED')).toEqual('PUBLISHED');
  });

  it('supports resubmission, the unschedule loop, invalidation and expiry', () => {
    expect(assertTransition('IN_REVIEW', 'DECIDE_REQUEST_CHANGES')).toEqual('CHANGES_REQUESTED');
    expect(assertTransition('CHANGES_REQUESTED', 'RESUBMIT')).toEqual('IN_REVIEW');
    expect(assertTransition('REJECTED', 'RESUBMIT')).toEqual('IN_REVIEW');
    expect(assertTransition('INVALIDATED', 'RESUBMIT')).toEqual('IN_REVIEW');
    expect(assertTransition('SCHEDULED', 'UNSCHEDULE')).toEqual('APPROVED');
    expect(assertTransition('APPROVED', 'INVALIDATE')).toEqual('INVALIDATED');
    expect(assertTransition('SCHEDULED', 'EXPIRE')).toEqual('EXPIRED');
    expect(assertTransition('EXPIRED', 'RESUBMIT')).toEqual('IN_REVIEW');
  });

  it('rejects illegal jumps and any move out of terminal states', () => {
    expect(() => assertTransition('DRAFT', 'DECIDE_APPROVE')).toThrow(RektrsStateError);
    expect(() => assertTransition('APPROVED', 'MARK_PUBLISHED')).toThrow(RektrsStateError);
    expect(() => assertTransition('PUBLISHED', 'CANCEL')).toThrow(RektrsStateError);
    expect(canTransition('PUBLISHED', 'CANCEL')).toEqual(false);
    expect(canTransition('CANCELLED', 'SUBMIT')).toEqual(false);
    try {
      assertTransition('DRAFT', 'DECIDE_APPROVE');
      fail('expected a RektrsStateError');
    } catch (e) {
      expect((e as RektrsStateError).code).toEqual('ILLEGAL_TRANSITION');
    }
  });
});

describe('rektrs maker-checker', () => {
  it('allows a different decider', () => {
    expect(
      checkMakerChecker({ submittedById: 'maker-1', actorId: 'reviewer-1', allowSelfApproval: false })
    ).toEqual({ allowed: true, selfApproval: false });
  });

  it('rejects the maker by default (strict maker-checker)', () => {
    expect(
      checkMakerChecker({ submittedById: 'maker-1', actorId: 'maker-1', allowSelfApproval: false })
    ).toEqual({ allowed: false, selfApproval: true });
  });

  it('allows the maker only when the org self-approval switch is on', () => {
    expect(
      checkMakerChecker({ submittedById: 'maker-1', actorId: 'maker-1', allowSelfApproval: true })
    ).toEqual({ allowed: true, selfApproval: true });
  });

  it('treats an unset maker as no self-approval', () => {
    expect(
      checkMakerChecker({ submittedById: null, actorId: 'maker-1', allowSelfApproval: false })
    ).toEqual({ allowed: true, selfApproval: false });
  });

  it('decisions are a human act: API keys and agents can never decide', () => {
    expect(actorKindCanDecide('USER')).toEqual(true);
    expect(actorKindCanDecide('CLIENT_TOKEN')).toEqual(true);
    expect(actorKindCanDecide('API_KEY')).toEqual(false);
    expect(actorKindCanDecide('MCP')).toEqual(false);
    expect(actorKindCanDecide('SYSTEM')).toEqual(false);
  });
});

describe('rektrs functional roles resolution', () => {
  it('derives defaults from the org role when nothing is stored', () => {
    expect(defaultFunctionsForRole('SUPERADMIN')).toEqual([
      'CREATOR',
      'REVIEWER',
      'PUBLISHER',
      'MANAGER',
      'ANALYST',
    ]);
    expect(resolveFunctions('ADMIN', [])).toHaveLength(5);
    expect(resolveFunctions('USER', [])).toEqual(['CREATOR']);
    expect(resolveFunctions('USER', null)).toEqual(['CREATOR']);
  });

  it('a stored set is authoritative and invalid entries are ignored', () => {
    expect(resolveFunctions('USER', ['REVIEWER', 'ANALYST'])).toEqual([
      'REVIEWER',
      'ANALYST',
    ]);
    expect(resolveFunctions('SUPERADMIN', ['CREATOR'])).toEqual(['CREATOR']);
    expect(resolveFunctions('USER', ['NOT_A_FUNCTION'])).toEqual(['CREATOR']);
  });
});
