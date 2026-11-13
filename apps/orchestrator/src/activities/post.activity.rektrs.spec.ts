/**
 * REKTRS P3-2b — Gate B tests (design P3-1 §4 row 5).
 *
 * Tested at ACTIVITY-ISOLATION level: PostActivity.verifyApprovalForPublish
 * is exercised with a mocked RektrsApprovalsService / audit / repository.
 * There is no Temporal test environment in this repo, so postWorkflowV113
 * itself is NOT executed here; instead, structural assertions pin the
 * wiring the workflow depends on (V113 exists, calls the activity after
 * the group reload, is exported for the worker bundle, is the version new
 * schedules start, and V112 is untouched).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { PostActivity } from './post.activity';

// Same ESM-only leaf stubs as the PostsService gate spec: PostActivity
// imports PostsService, whose module graph pulls DOM/ESM chains jest
// cannot transform here. None of them participate in the gate activity.
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

function makeActivity() {
  const approvals = {
    verifyVariantForPublish: jest.fn(async () => ({
      scoped: false,
      pass: true,
    })),
    invalidateApproval: jest.fn(async () => ({})),
  };
  const audit = { write: jest.fn(async () => ({})) };
  const approvalEventCreate = jest.fn(async () => ({}));
  const repository = {
    db: () => ({ approvalEvent: { create: approvalEventCreate } }),
  };
  const activity = new PostActivity(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    approvals as any,
    audit as any,
    repository as any
  );
  return { activity, approvals, audit, approvalEventCreate };
}

describe('Gate B activity — verifyApprovalForPublish', () => {
  it('unscoped post passes through with no writes', async () => {
    const { activity, approvals, audit, approvalEventCreate } =
      makeActivity();

    const verdict = await activity.verifyApprovalForPublish(ORG, 'p1');

    expect(verdict).toEqual({ scoped: false, pass: true });
    expect(approvals.invalidateApproval).not.toHaveBeenCalled();
    expect(approvalEventCreate).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('tampered row (HASH_MISMATCH) → submission invalidated, PUBLISH_BLOCKED event + audit written, verdict blocks', async () => {
    const { activity, approvals, audit, approvalEventCreate } =
      makeActivity();
    approvals.verifyVariantForPublish.mockResolvedValue({
      scoped: true,
      pass: false,
      reason: 'HASH_MISMATCH',
      approvalId: 'a1',
      state: 'SCHEDULED',
      approvedHash: 'hash-approved',
      liveHash: 'hash-tampered',
    } as any);

    const verdict = await activity.verifyApprovalForPublish(ORG, 'p1');

    expect(verdict.pass).toBe(false);
    expect(approvals.invalidateApproval).toHaveBeenCalledWith(
      ORG,
      'a1',
      expect.objectContaining({ kind: 'SYSTEM' }),
      'hash-approved',
      'hash-tampered'
    );
    expect(approvalEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: ORG,
        approvalId: 'a1',
        type: 'PUBLISH_BLOCKED',
        metadata: expect.objectContaining({
          postId: 'p1',
          reason: 'HASH_MISMATCH',
        }),
      }),
    });
    expect(audit.write).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ kind: 'SYSTEM' }),
      expect.objectContaining({
        action: 'approval.publish_blocked',
        entityType: 'Approval',
        entityId: 'a1',
      })
    );
  });

  it('missing approval (APPROVAL_REQUIRED) → blocked + recorded, but nothing to invalidate', async () => {
    const { activity, approvals, audit, approvalEventCreate } =
      makeActivity();
    approvals.verifyVariantForPublish.mockResolvedValue({
      scoped: true,
      pass: false,
      reason: 'APPROVAL_REQUIRED',
      approvalId: 'a1',
      state: 'IN_REVIEW',
    } as any);

    const verdict = await activity.verifyApprovalForPublish(ORG, 'p1');

    expect(verdict.pass).toBe(false);
    expect(approvals.invalidateApproval).not.toHaveBeenCalled();
    expect(approvalEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'PUBLISH_BLOCKED' }),
    });
    expect(audit.write).toHaveBeenCalled();
  });

  it('approved + hash ok → passes, no writes', async () => {
    const { activity, approvals, audit, approvalEventCreate } =
      makeActivity();
    approvals.verifyVariantForPublish.mockResolvedValue({
      scoped: true,
      pass: true,
      state: 'SCHEDULED',
      approvalId: 'a1',
    } as any);

    const verdict = await activity.verifyApprovalForPublish(ORG, 'p1');

    expect(verdict.pass).toBe(true);
    expect(approvals.invalidateApproval).not.toHaveBeenCalled();
    expect(approvalEventCreate).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });
});

describe('Gate B wiring — structural assertions', () => {
  const read = (...parts: string[]) =>
    readFileSync(join(__dirname, ...parts), 'utf8');

  it('V113 exists, re-verifies after the group reload, and fails closed', () => {
    const v113 = read('..', 'workflows', 'post-workflows', 'post.workflow.v1.1.3.ts');
    expect(v113).toContain('export async function postWorkflowV113');
    const reloadAt = v113.indexOf('getPostsList(organizationId, postId)');
    const gateAt = v113.indexOf(
      'verifyApprovalForPublish(organizationId, post.id)'
    );
    const providerPhaseAt = v113.indexOf(
      'postSocialPending(post.integration as Integration'
    );
    expect(reloadAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(reloadAt);
    expect(providerPhaseAt).toBeGreaterThan(gateAt);
    // fail-closed paths: verification error and blocked verdict both end
    // the run in ERROR state before any provider call
    expect(v113).toContain('Approval verification unavailable');
    expect(v113).toContain("changeState(post.id, 'ERROR', blockedMessage");
    // repeat-post children stay behind the gate
    expect(v113).toContain('startChild(postWorkflowV113');
  });

  it('V112 is untouched (no gate code)', () => {
    const v112 = read('..', 'workflows', 'post-workflows', 'post.workflow.v1.1.2.ts');
    expect(v112).toContain('export async function postWorkflowV112');
    expect(v112).not.toContain('verifyApprovalForPublish');
  });

  it('the worker bundle exports V113', () => {
    const index = read('..', 'workflows', 'index.ts');
    expect(index).toContain("post-workflows/post.workflow.v1.1.3");
  });

  it('new schedules and the missing-post sweep start V113', () => {
    const libRoot = join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'libraries',
      'nestjs-libraries',
      'src'
    );
    const postsService = readFileSync(
      join(
        libRoot,
        'database',
        'prisma',
        'posts',
        'posts.service.ts'
      ),
      'utf8'
    );
    expect(postsService).toContain("workflow.start('postWorkflowV113'");
    const activity = read('post.activity.ts');
    expect(activity).toContain("signalWithStart('postWorkflowV113'");
  });
});
