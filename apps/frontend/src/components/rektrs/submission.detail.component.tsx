'use client';

import { FC, useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import useSWR, { useSWRConfig } from 'swr';
import { Button } from '@gitroom/react/form/button';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useUser } from '@gitroom/frontend/components/layout/user.context';
import { useMediaDirectory } from '@gitroom/react/helpers/use.media.directory';
import {
  formatDateTime,
  newIdempotencyKey,
  readableRektrsError,
  RektrsSubmissionDetail,
  RektrsTimelineEntry,
  shortId,
  useRektrsCall,
  useRektrsLoader,
} from '@gitroom/frontend/components/rektrs/rektrs.api';
import {
  BrandDot,
  ChannelChip,
  StateBadge,
  useBrands,
  useCampaigns,
  useHasRektrsFunction,
  useIntegrations,
  useOrgSettings,
  useTeamMembers,
} from '@gitroom/frontend/components/rektrs/rektrs.shared';

const SWR_OPTS = {
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
  refreshWhenHidden: false,
  refreshWhenOffline: false,
} as const;

const prettify = (value: string) =>
  value
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());

const VersionPreview: FC<{ detail: RektrsSubmissionDetail }> = ({ detail }) => {
  const t = useT();
  const mediaDir = useMediaDirectory();
  const { data: integrations } = useIntegrations();

  const integrationById = useMemo(() => {
    const map = new Map<string, (typeof integrations)[number]>();
    for (const i of integrations || []) {
      map.set(i.id, i);
    }
    return map;
  }, [integrations]);

  const currentVersions = useMemo(
    () => (detail.versions || []).filter((v) => v.versionNo === detail.round),
    [detail.versions, detail.round]
  );
  const totalParts = currentVersions.reduce(
    (sum, v) => sum + (v.payload?.parts?.length || 0),
    0
  );

  return (
    <div className="flex flex-col gap-[12px]">
      <div className="flex items-center gap-[10px]">
        <div className="text-[15px] font-[600]">
          {t('rektrs_submitted_content', 'Submitted content')}
        </div>
        <div className="text-[12px] opacity-60">
          {t('rektrs_round', 'Round')} {detail.round} · {currentVersions.length}{' '}
          {t('rektrs_channels_count', 'channel(s)')} · {totalParts}{' '}
          {t('rektrs_posts_count', 'post(s)')}
        </div>
      </div>
      {currentVersions.map((version) => {
        const integration = integrationById.get(version.integrationId);
        const payload = version.payload;
        return (
          <div
            key={version.id}
            className="bg-newBgColorInner border border-newTableBorder rounded-[8px] p-[16px] flex flex-col gap-[12px]"
          >
            <div className="flex items-center justify-between gap-[10px]">
              <ChannelChip
                providerIdentifier={
                  integration?.identifier || payload?.providerIdentifier
                }
                name={integration?.name}
                picture={integration?.picture}
              />
              <span className="text-[11px] opacity-50 font-mono">
                #{shortId(version.contentHash)}
              </span>
            </div>
            {payload?.title ? (
              <div className="text-[14px] font-[600]">{payload.title}</div>
            ) : null}
            {(payload?.parts || []).map((part, idx) => (
              <div
                key={idx}
                className="flex flex-col gap-[8px] border-s-2 border-newTableBorder ps-[12px]"
              >
                {(payload?.parts?.length || 0) > 1 ? (
                  <div className="text-[11px] opacity-60">
                    {t('rektrs_thread_part', 'Part')} {idx + 1}
                    {part.delay ? ` · +${part.delay}s` : ''}
                  </div>
                ) : null}
                <div className="text-[14px] whitespace-pre-wrap break-words">
                  {part.content}
                </div>
                {part.image?.length ? (
                  <div className="flex flex-wrap gap-[8px]">
                    {part.image.map((media) => (
                      <a
                        key={media.mediaId}
                        href={mediaDir.set(media.path)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <img
                          src={mediaDir.set(media.path)}
                          alt=""
                          className="w-[96px] h-[96px] object-cover rounded-[8px] border border-newTableBorder"
                        />
                      </a>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
            {payload?.settings ? (
              <details className="text-[12px] opacity-70">
                <summary className="cursor-pointer">
                  {t('rektrs_provider_settings', 'Provider settings')}
                </summary>
                <pre className="mt-[6px] whitespace-pre-wrap break-all bg-black/10 rounded-[6px] p-[8px]">
                  {JSON.stringify(payload.settings, null, 2)}
                </pre>
              </details>
            ) : null}
          </div>
        );
      })}
      {currentVersions.length === 0 ? (
        <div className="text-[13px] opacity-60">
          {t('rektrs_no_snapshot', 'No content snapshot is stored for this round.')}
        </div>
      ) : null}
    </div>
  );
};

const Timeline: FC<{ submissionId: string }> = ({ submissionId }) => {
  const t = useT();
  const load = useRektrsLoader();
  const { nameOf } = useTeamMembers();
  const { data } = useSWR<{ timeline: RektrsTimelineEntry[] }>(
    `/rektrs/v1/submissions/${submissionId}/audit`,
    load,
    SWR_OPTS
  );

  if (!data) {
    return null;
  }

  return (
    <div className="flex flex-col gap-[10px]">
      <div className="text-[15px] font-[600]">{t('rektrs_timeline', 'Timeline')}</div>
      <div className="flex flex-col">
        {data.timeline.map((item, idx) => {
          const entry: any = item.entry;
          const label =
            item.kind === 'event'
              ? prettify(String(entry.type || 'event'))
              : prettify(String(entry.action || 'audit'));
          const comment = entry?.metadata?.comment as string | undefined;
          return (
            <div key={idx} className="flex gap-[10px]">
              <div className="flex flex-col items-center">
                <span className="w-[8px] h-[8px] rounded-full bg-[#612bd3] mt-[5px] shrink-0" />
                {idx < data.timeline.length - 1 ? (
                  <span className="w-[1px] flex-1 bg-newTableBorder" />
                ) : null}
              </div>
              <div className="pb-[14px] min-w-0">
                <div className="text-[13px]">
                  <span className="font-[600]">{label}</span>
                  {entry.actorId ? (
                    <span className="opacity-60"> · {nameOf(entry.actorId)}</span>
                  ) : null}
                </div>
                <div className="text-[12px] opacity-50">
                  {formatDateTime(item.at)}
                </div>
                {comment ? (
                  <div className="mt-[4px] text-[13px] bg-orange-500/10 border border-orange-500/20 rounded-[6px] px-[10px] py-[6px] whitespace-pre-wrap">
                    {comment}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
        {data.timeline.length === 0 ? (
          <div className="text-[13px] opacity-60">
            {t('rektrs_no_events', 'No events yet.')}
          </div>
        ) : null}
      </div>
    </div>
  );
};

const DecisionPanel: FC<{
  detail: RektrsSubmissionDetail;
  onDone: () => void;
}> = ({ detail, onDone }) => {
  const t = useT();
  const call = useRektrsCall();
  const toaster = useToaster();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const decide = useCallback(
    async (decision: 'APPROVE' | 'REQUEST_CHANGES' | 'REJECT') => {
      if (decision !== 'APPROVE' && !comment.trim()) {
        setError(
          t(
            'rektrs_decision_comment_required',
            'A comment is required when you request changes or reject.'
          )
        );
        return;
      }
      setBusy(decision);
      setError('');
      try {
        await call(`/rektrs/v1/submissions/${detail.id}/decisions`, {
          method: 'POST',
          idempotencyKey: newIdempotencyKey(),
          body: {
            decision,
            comment: comment.trim() || undefined,
            expectedVersion: detail.version,
          },
        });
        toaster.show(
          decision === 'APPROVE'
            ? t('rektrs_submission_approved', 'Submission approved')
            : decision === 'REQUEST_CHANGES'
              ? t('rektrs_changes_requested', 'Changes requested')
              : t('rektrs_submission_rejected', 'Submission rejected'),
          'success'
        );
        onDone();
      } catch (e) {
        setError(
          readableRektrsError(e, t('rektrs_decision_failed', 'The decision could not be saved'))
        );
      } finally {
        setBusy(null);
      }
    },
    [call, comment, detail.id, detail.version, onDone, t, toaster]
  );

  return (
    <div className="bg-newBgColorInner border border-newTableBorder rounded-[8px] p-[16px] flex flex-col gap-[12px]">
      <div className="text-[15px] font-[600]">
        {t('rektrs_your_decision', 'Your decision')}
      </div>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        rows={3}
        placeholder={t(
          'rektrs_decision_comment_placeholder',
          'Comment (required for “Request changes” and “Reject”)'
        )}
        className="bg-newBgColorInner border border-newTableBorder rounded-[8px] px-[12px] py-[10px] text-[14px] outline-none resize-y"
      />
      {error ? <div className="text-red-400 text-[13px]">{error}</div> : null}
      <div className="flex flex-wrap gap-[10px]">
        <Button
          onClick={() => decide('APPROVE')}
          loading={busy === 'APPROVE'}
          disabled={!!busy && busy !== 'APPROVE'}
        >
          {t('approve', 'Approve')}
        </Button>
        <Button
          secondary
          onClick={() => decide('REQUEST_CHANGES')}
          loading={busy === 'REQUEST_CHANGES'}
          disabled={!!busy && busy !== 'REQUEST_CHANGES'}
        >
          {t('request_changes', 'Request changes')}
        </Button>
        <Button
          secondary
          onClick={() => decide('REJECT')}
          loading={busy === 'REJECT'}
          disabled={!!busy && busy !== 'REJECT'}
          className="!text-red-500"
        >
          {t('reject', 'Reject')}
        </Button>
      </div>
    </div>
  );
};

const MakerActions: FC<{
  detail: RektrsSubmissionDetail;
  onDone: () => void;
}> = ({ detail, onDone }) => {
  const t = useT();
  const call = useRektrsCall();
  const toaster = useToaster();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submittable = [
    'DRAFT',
    'CHANGES_REQUESTED',
    'REJECTED',
    'INVALIDATED',
    'EXPIRED',
  ].includes(detail.state);
  const cancellable = !['PUBLISHED', 'CANCELLED', 'EXPIRED'].includes(
    detail.state
  );

  const act = useCallback(
    async (kind: 'submit' | 'cancel') => {
      setBusy(true);
      setError('');
      try {
        if (kind === 'submit') {
          await call(`/rektrs/v1/submissions/${detail.id}/submit`, {
            method: 'POST',
            idempotencyKey: newIdempotencyKey(),
            body: {},
          });
          toaster.show(
            t('rektrs_submission_sent', 'Submission sent for review'),
            'success'
          );
        } else {
          await call(`/rektrs/v1/submissions/${detail.id}/cancel`, {
            method: 'POST',
          });
          toaster.show(
            t('rektrs_submission_cancelled', 'Submission cancelled'),
            'success'
          );
        }
        onDone();
      } catch (e) {
        setError(
          readableRektrsError(e, t('rektrs_action_failed', 'The action could not be completed'))
        );
      } finally {
        setBusy(false);
      }
    },
    [call, detail.id, onDone, t, toaster]
  );

  if (!submittable && !cancellable) {
    return null;
  }

  return (
    <div className="bg-newBgColorInner border border-newTableBorder rounded-[8px] p-[16px] flex flex-col gap-[10px]">
      <div className="text-[15px] font-[600]">
        {t('rektrs_your_actions', 'Your actions')}
      </div>
      {detail.state === 'CHANGES_REQUESTED' ? (
        <div className="text-[13px] opacity-70">
          {t(
            'rektrs_resubmit_hint',
            'Edit the posts in the calendar first — resubmitting snapshots the current content as a new round — then send it back for review.'
          )}
        </div>
      ) : null}
      {error ? <div className="text-red-400 text-[13px]">{error}</div> : null}
      <div className="flex flex-wrap gap-[10px]">
        {submittable ? (
          <Button onClick={() => act('submit')} loading={busy}>
            {detail.state === 'DRAFT'
              ? t('rektrs_submit_for_review', 'Submit for review')
              : t('rektrs_resubmit', 'Resubmit for review')}
          </Button>
        ) : null}
        {cancellable ? (
          <Button secondary onClick={() => act('cancel')} disabled={busy}>
            {t('rektrs_cancel_submission', 'Cancel submission')}
          </Button>
        ) : null}
      </div>
    </div>
  );
};

export const SubmissionDetailComponent: FC<{
  submissionId: string;
  mode: 'review' | 'mine';
}> = ({ submissionId, mode }) => {
  const t = useT();
  const user = useUser();
  const { mutate: globalMutate } = useSWRConfig();
  const load = useRektrsLoader();
  const isReviewer = useHasRektrsFunction('REVIEWER');
  const { data: settings } = useOrgSettings();
  const { data: brands } = useBrands();
  const { data: campaigns } = useCampaigns();
  const { nameOf } = useTeamMembers();

  const detailKey = `/rektrs/v1/submissions/${submissionId}`;
  const {
    data: detail,
    isLoading,
    error,
    mutate,
  } = useSWR<RektrsSubmissionDetail>(detailKey, load, SWR_OPTS);

  const refreshAll = useCallback(async () => {
    await mutate();
    await globalMutate(`/rektrs/v1/submissions/${submissionId}/audit`);
    await globalMutate('/rektrs/v1/review/inbox');
    await globalMutate('/rektrs/v1/submissions');
  }, [globalMutate, mutate, submissionId]);

  const brand = useMemo(
    () => (brands || []).find((b) => b.id === detail?.brandId),
    [brands, detail?.brandId]
  );
  const campaign = useMemo(
    () => (campaigns || []).find((c) => c.id === detail?.campaignId),
    [campaigns, detail?.campaignId]
  );

  const latestDecisionComment = useMemo(() => {
    const events = [...(detail?.events || [])].reverse();
    const withComment = events.find((e) => e.metadata?.comment);
    return withComment?.metadata?.comment as string | undefined;
  }, [detail?.events]);

  if (isLoading) {
    return <LoadingComponent />;
  }

  if (error || !detail) {
    return (
      <div className="flex flex-col gap-[10px] text-textColor">
        <div className="text-[16px] font-[600]">
          {t('rektrs_submission_not_available', 'Submission not available')}
        </div>
        <div className="text-[13px] opacity-60">
          {readableRektrsError(
            error,
            t('rektrs_submission_load_failed', 'It could not be loaded — it may not exist in this organization.')
          )}
        </div>
        <Link href={mode === 'review' ? '/review' : '/submissions'} className="text-[13px] underline">
          {t('rektrs_back_to_list', 'Back to the list')}
        </Link>
      </div>
    );
  }

  const isOwn = !!user?.id && detail.submittedById === user.id;
  const isMaker =
    !!user?.id &&
    (detail.createdById === user.id || detail.submittedById === user.id);
  const showDecisionPanel =
    mode === 'review' &&
    detail.state === 'IN_REVIEW' &&
    isReviewer &&
    (!isOwn || !!settings?.allowSelfApproval);
  const showMakerCheckerNote =
    mode === 'review' &&
    detail.state === 'IN_REVIEW' &&
    isReviewer &&
    isOwn &&
    !settings?.allowSelfApproval;

  return (
    <div className="flex flex-col gap-[18px] text-textColor w-full max-w-[880px]">
      <div className="flex flex-col gap-[8px]">
        <Link
          href={mode === 'review' ? '/review' : '/submissions'}
          className="text-[13px] opacity-60 hover:opacity-100"
        >
          ← {mode === 'review' ? t('review_inbox', 'Review inbox') : t('my_submissions', 'My submissions')}
        </Link>
        <div className="flex flex-wrap items-center gap-[10px]">
          <div className="text-[20px] font-[600]">
            {t('rektrs_submission', 'Submission')}
          </div>
          <StateBadge state={detail.state} />
          <span className="text-[12px] opacity-60">
            {t('rektrs_round', 'Round')} {detail.round}
          </span>
        </div>
        <div className="flex flex-wrap gap-x-[18px] gap-y-[4px] text-[13px] opacity-80">
          <span className="inline-flex items-center gap-[6px]">
            <BrandDot color={brand?.colorPrimary} />
            {brand?.name || shortId(detail.brandId)}
          </span>
          {campaign ? <span>{campaign.name}</span> : null}
          <span>
            {t('submitted_by', 'Submitted by')} {nameOf(detail.submittedById)}
            {detail.submittedAt ? ` · ${formatDateTime(detail.submittedAt)}` : ''}
          </span>
          {detail.decidedById ? (
            <span>
              {t('rektrs_decided_by', 'Decided by')} {nameOf(detail.decidedById)}
              {detail.decidedAt ? ` · ${formatDateTime(detail.decidedAt)}` : ''}
            </span>
          ) : null}
          <span className="opacity-60">
            {t('rektrs_batch', 'Batch')} {shortId(detail.batchId)}
          </span>
        </div>
      </div>

      {latestDecisionComment &&
      (detail.state === 'CHANGES_REQUESTED' || detail.state === 'REJECTED') ? (
        <div className="bg-orange-500/10 border border-orange-500/25 rounded-[8px] p-[14px]">
          <div className="text-[13px] font-[600] mb-[4px]">
            {t('rektrs_reviewer_comment', 'Reviewer’s comment')}
          </div>
          <div className="text-[14px] whitespace-pre-wrap">
            {latestDecisionComment}
          </div>
        </div>
      ) : null}

      {showMakerCheckerNote ? (
        <div className="bg-amber-500/10 border border-amber-500/25 rounded-[8px] p-[14px] text-[14px]">
          {t(
            'rektrs_maker_checker_note',
            'You created this submission, so you can’t approve it — another reviewer has to decide.'
          )}
        </div>
      ) : null}

      {mode === 'review' && detail.state === 'IN_REVIEW' && !isReviewer ? (
        <div className="bg-newBgColorInner border border-newTableBorder rounded-[8px] p-[14px] text-[14px] opacity-80">
          {t(
            'rektrs_reviewer_function_note',
            'You can view this submission, but deciding requires the REVIEWER function.'
          )}
        </div>
      ) : null}

      <VersionPreview detail={detail} />

      {showDecisionPanel ? (
        <DecisionPanel detail={detail} onDone={refreshAll} />
      ) : null}

      {mode === 'mine' && isMaker ? (
        <MakerActions detail={detail} onDone={refreshAll} />
      ) : null}

      <Timeline submissionId={submissionId} />
    </div>
  );
};
