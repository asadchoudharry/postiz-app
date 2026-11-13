'use client';

import { FC, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import useSWR, { useSWRConfig } from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { expandPostsList } from '@gitroom/helpers/utils/posts.list.minify';
import { Button } from '@gitroom/react/form/button';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useUser } from '@gitroom/frontend/components/layout/user.context';
import {
  formatDateTime,
  newIdempotencyKey,
  readableRektrsError,
  RektrsSubmission,
  RektrsSubmissionDetail,
  shortId,
  useRektrsCall,
  useRektrsLoader,
} from '@gitroom/frontend/components/rektrs/rektrs.api';
import {
  BrandDot,
  ChannelChip,
  EmptyState,
  StateBadge,
  useBrands,
  useCampaigns,
  useHasRektrsFunction,
} from '@gitroom/frontend/components/rektrs/rektrs.shared';
import clsx from 'clsx';

const SWR_OPTS = {
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
  refreshWhenHidden: false,
  refreshWhenOffline: false,
} as const;

const TERMINAL_STATES = ['PUBLISHED', 'CANCELLED'];

interface RecentPost {
  id: string;
  content: string;
  publishDate: string;
  state: string;
  group: string;
  integration?: {
    id: string;
    providerIdentifier: string;
    name: string;
    picture: string;
  };
}

interface BatchCandidate {
  batchId: string;
  posts: RecentPost[];
  latest: string;
}

/**
 * Recent batches, derived from the posts the launches list already loads:
 * /posts/list carries each post's `group` (one group per channel variant of a
 * save), and the group endpoint returns the full rows including `batchId` —
 * posts saved together share one batchId, so resolving each recent group and
 * grouping by batchId reconstructs the batches.
 */
const useRecentBatches = () => {
  const fetch = useFetch();
  const [batches, setBatches] = useState<BatchCandidate[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/posts/list?page=0&limit=50&state=all');
        const expanded = expandPostsList(await res.json());
        const posts = (expanded?.posts || []) as RecentPost[];
        const byGroup = new Map<string, RecentPost>();
        for (const post of posts) {
          if (post.group && !byGroup.has(post.group)) {
            byGroup.set(post.group, post);
          }
        }
        const groups = [...byGroup.values()].slice(0, 12);
        const resolved = await Promise.all(
          groups.map(async (post) => {
            try {
              const groupPosts = await (
                await fetch(`/posts/group/${post.group}`)
              ).json();
              const batchId = Array.isArray(groupPosts)
                ? groupPosts[0]?.batchId
                : null;
              return batchId ? { post, batchId: batchId as string } : null;
            } catch {
              return null;
            }
          })
        );
        if (cancelled) return;
        const byBatch = new Map<string, BatchCandidate>();
        for (const item of resolved) {
          if (!item) continue;
          const existing = byBatch.get(item.batchId);
          if (existing) {
            existing.posts.push(item.post);
            if (item.post.publishDate > existing.latest) {
              existing.latest = item.post.publishDate;
            }
          } else {
            byBatch.set(item.batchId, {
              batchId: item.batchId,
              posts: [item.post],
              latest: item.post.publishDate,
            });
          }
        }
        setBatches(
          [...byBatch.values()].sort((a, b) =>
            b.latest.localeCompare(a.latest)
          )
        );
      } catch {
        if (!cancelled) setBatches([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { batches, loading };
};

const CreateSubmissionModal: FC<{ onCreated: () => void }> = ({ onCreated }) => {
  const t = useT();
  const modal = useModals();
  const toaster = useToaster();
  const router = useRouter();
  const call = useRektrsCall();
  const load = useRektrsLoader();
  const { batches, loading } = useRecentBatches();
  const { data: campaigns } = useCampaigns();
  const { data: brands } = useBrands();
  const { data: submissions } = useSWR<RektrsSubmission[]>(
    '/rektrs/v1/submissions',
    load,
    SWR_OPTS
  );
  const [selectedBatch, setSelectedBatch] = useState<string | null>(null);
  const [campaignId, setCampaignId] = useState('');
  const [busy, setBusy] = useState<'draft' | 'submit' | null>(null);
  const [error, setError] = useState('');

  const openBatchIds = useMemo(() => {
    const set = new Set<string>();
    for (const s of submissions || []) {
      if (!TERMINAL_STATES.includes(s.state)) {
        set.add(s.batchId);
      }
    }
    return set;
  }, [submissions]);

  const brandName = useCallback(
    (brandId: string) =>
      (brands || []).find((b) => b.id === brandId)?.name || '',
    [brands]
  );

  const create = useCallback(
    async (andSubmit: boolean) => {
      if (!selectedBatch) {
        setError(t('rektrs_pick_batch', 'Pick one of your recent batches first'));
        return;
      }
      setBusy(andSubmit ? 'submit' : 'draft');
      setError('');
      try {
        const created = await call<RektrsSubmission>('/rektrs/v1/submissions', {
          method: 'POST',
          idempotencyKey: newIdempotencyKey(),
          body: {
            batchId: selectedBatch,
            campaignId: campaignId || undefined,
          },
        });
        if (andSubmit) {
          await call(`/rektrs/v1/submissions/${created.id}/submit`, {
            method: 'POST',
            idempotencyKey: newIdempotencyKey(),
            body: {},
          });
        }
        toaster.show(
          andSubmit
            ? t('rektrs_submission_sent', 'Submission sent for review')
            : t('rektrs_submission_draft_created', 'Submission draft created'),
          'success'
        );
        onCreated();
        modal.closeCurrent();
        router.push(`/submissions/${created.id}`);
      } catch (e) {
        setError(
          readableRektrsError(e, t('rektrs_submission_create_failed', 'The submission could not be created'))
        );
      } finally {
        setBusy(null);
      }
    },
    [call, campaignId, modal, onCreated, router, selectedBatch, t, toaster]
  );

  return (
    <div className="flex flex-col gap-[14px] p-[4px]">
      <div className="flex flex-col gap-[6px]">
        <div className="text-[14px]">
          {t('rektrs_campaign_optional', 'Campaign (optional)')}
        </div>
        <select
          value={campaignId}
          onChange={(e) => setCampaignId(e.target.value)}
          className="h-[42px] bg-newBgColorInner px-[12px] outline-none border-newTableBorder border rounded-[8px] text-[14px]"
        >
          <option value="">{t('rektrs_no_campaign', 'No campaign')}</option>
          {(campaigns || [])
            .filter((c) => c.status !== 'ARCHIVED')
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {brandName(c.brandId) ? ` · ${brandName(c.brandId)}` : ''}
              </option>
            ))}
        </select>
      </div>

      <div className="flex flex-col gap-[6px]">
        <div className="text-[14px]">{t('rektrs_batch', 'Batch')}</div>
        <div className="text-[12px] opacity-60">
          {t(
            'rektrs_batch_picker_hint',
            'A batch is everything saved together in one go — all channels included. Pick any of your recent batches.'
          )}
        </div>
        {loading ? (
          <LoadingComponent />
        ) : batches.length === 0 ? (
          <div className="text-[13px] opacity-60 py-[10px]">
            {t(
              'rektrs_no_recent_batches',
              'No recent batches found. Create or schedule a post first — it will show up here.'
            )}
          </div>
        ) : (
          <div className="flex flex-col max-h-[320px] overflow-y-auto border border-newTableBorder rounded-[8px] divide-y divide-newTableBorder">
            {batches.map((batch) => {
              const alreadyOpen = openBatchIds.has(batch.batchId);
              const selected = selectedBatch === batch.batchId;
              const first = batch.posts[0];
              return (
                <button
                  key={batch.batchId}
                  type="button"
                  disabled={alreadyOpen}
                  onClick={() => setSelectedBatch(batch.batchId)}
                  className={clsx(
                    'flex flex-col gap-[4px] px-[12px] py-[10px] text-start',
                    selected
                      ? 'bg-[#612bd3]/10'
                      : 'hover:bg-boxFocused',
                    alreadyOpen && 'opacity-50 cursor-not-allowed'
                  )}
                >
                  <span className="flex items-center gap-[8px] text-[13px]">
                    <span className="font-[600]">
                      {t('rektrs_batch', 'Batch')} {shortId(batch.batchId)}
                    </span>
                    <span className="opacity-60">
                      {batch.posts.length} {t('rektrs_channels_count', 'channel(s)')} ·{' '}
                      {formatDateTime(batch.latest)}
                    </span>
                    {alreadyOpen ? (
                      <span className="ms-auto text-[11px] font-[600]">
                        {t('rektrs_already_submitted', 'Already submitted')}
                      </span>
                    ) : selected ? (
                      <span className="ms-auto text-[11px] font-[600] text-[#612bd3]">
                        {t('rektrs_selected', 'Selected')}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex flex-wrap items-center gap-x-[12px] gap-y-[2px] text-[12px] opacity-80">
                    {batch.posts.map((p) => (
                      <ChannelChip
                        key={p.id}
                        providerIdentifier={p.integration?.providerIdentifier}
                        name={p.integration?.name}
                        picture={p.integration?.picture}
                      />
                    ))}
                  </span>
                  {first?.content ? (
                    <span className="text-[12px] opacity-60 line-clamp-1">
                      {first.content}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {error ? <div className="text-red-400 text-[13px]">{error}</div> : null}
      <div className="flex gap-[10px] justify-end">
        <Button type="button" secondary onClick={() => modal.closeCurrent()}>
          {t('close', 'Close')}
        </Button>
        <Button
          type="button"
          secondary
          loading={busy === 'draft'}
          disabled={!!busy}
          onClick={() => create(false)}
        >
          {t('rektrs_create_draft', 'Create draft')}
        </Button>
        <Button
          type="button"
          loading={busy === 'submit'}
          disabled={!!busy}
          onClick={() => create(true)}
        >
          {t('rektrs_create_and_submit', 'Create & submit for review')}
        </Button>
      </div>
    </div>
  );
};

const ReviewerComment: FC<{ submission: RektrsSubmission }> = ({ submission }) => {
  const load = useRektrsLoader();
  const { data } = useSWR<RektrsSubmissionDetail>(
    submission.state === 'CHANGES_REQUESTED' || submission.state === 'REJECTED'
      ? `/rektrs/v1/submissions/${submission.id}`
      : null,
    load,
    SWR_OPTS
  );
  const comment = useMemo(() => {
    const events = [...(data?.events || [])].reverse();
    return events.find((e) => e.metadata?.comment)?.metadata?.comment as
      | string
      | undefined;
  }, [data]);
  if (!comment) {
    return null;
  }
  return (
    <div className="text-[12px] bg-orange-500/10 border border-orange-500/20 rounded-[6px] px-[10px] py-[6px] mb-[12px] whitespace-pre-wrap">
      {comment}
    </div>
  );
};

export const MySubmissionsComponent: FC = () => {
  const t = useT();
  const modal = useModals();
  const user = useUser();
  const canCreate = useHasRektrsFunction('CREATOR');
  const load = useRektrsLoader();
  const { data: brands } = useBrands();
  const { data: campaigns } = useCampaigns();
  const { mutate: globalMutate } = useSWRConfig();
  const [stateFilter, setStateFilter] = useState<string>('ALL');
  const {
    data: submissions,
    isLoading,
    mutate,
  } = useSWR<RektrsSubmission[]>('/rektrs/v1/submissions', load, SWR_OPTS);

  const mine = useMemo(
    () =>
      (submissions || []).filter(
        (s) => s.createdById === user?.id || s.submittedById === user?.id
      ),
    [submissions, user?.id]
  );

  const states = useMemo(
    () => [...new Set(mine.map((s) => s.state))],
    [mine]
  );

  const visible = useMemo(
    () =>
      stateFilter === 'ALL'
        ? mine
        : mine.filter((s) => s.state === stateFilter),
    [mine, stateFilter]
  );

  const openCreate = useCallback(() => {
    modal.openModal({
      title: t('rektrs_new_submission', 'New submission'),
      withCloseButton: true,
      classNames: { modal: 'w-[100%] max-w-[680px] text-textColor' },
      children: (
        <CreateSubmissionModal
          onCreated={() => {
            mutate();
            globalMutate('/rektrs/v1/review/inbox');
          }}
        />
      ),
    });
  }, [globalMutate, modal, mutate, t]);

  return (
    <div className="flex flex-col gap-[16px] text-textColor w-full">
      <div className="flex items-center justify-between">
        <div className="text-[20px] font-[600]">{t('my_submissions', 'My submissions')}</div>
        {canCreate ? (
          <Button onClick={openCreate}>
            {t('rektrs_new_submission', 'New submission')}
          </Button>
        ) : null}
      </div>

      {states.length > 1 ? (
        <div className="flex flex-wrap gap-[8px]">
          {['ALL', ...states].map((state) => (
            <button
              key={state}
              onClick={() => setStateFilter(state)}
              className={clsx(
                'rounded-full px-[12px] py-[4px] text-[12px] font-[600] border',
                stateFilter === state
                  ? 'bg-[#612bd3] text-white border-transparent'
                  : 'border-newTableBorder opacity-70 hover:opacity-100'
              )}
            >
              {state === 'ALL' ? t('rektrs_all', 'All') : state.replace(/_/g, ' ')}
            </button>
          ))}
        </div>
      ) : null}

      {isLoading ? (
        <LoadingComponent />
      ) : visible.length === 0 ? (
        <EmptyState
          title={t('rektrs_no_submissions_yet', 'No submissions yet')}
          hint={t(
            'rektrs_no_submissions_hint',
            'Submit a batch of posts for review and track its approval here — including the reviewer’s comments when changes are requested.'
          )}
        />
      ) : (
        <div className="bg-newBgColorInner border border-newTableBorder rounded-[8px] overflow-hidden flex flex-col">
          {visible.map((submission) => {
            const brand = (brands || []).find((b) => b.id === submission.brandId);
            const campaign = (campaigns || []).find(
              (c) => c.id === submission.campaignId
            );
            return (
              <div
                key={submission.id}
                className="border-b border-newTableBorder last:border-0 hover:bg-boxFocused"
              >
                <Link
                  href={`/submissions/${submission.id}`}
                  className="flex items-center gap-[14px] px-[16px] py-[12px]"
                >
                  <StateBadge state={submission.state} />
                  <span className="inline-flex items-center gap-[6px] min-w-[120px]">
                    <BrandDot color={brand?.colorPrimary} />
                    <span className="font-[600] truncate">
                      {brand?.name || '—'}
                    </span>
                  </span>
                  <span className="min-w-[110px] truncate opacity-80">
                    {campaign?.name || '—'}
                  </span>
                  <span className="flex-1 text-[12px] opacity-60">
                    {t('rektrs_round', 'Round')} {submission.round} ·{' '}
                    {t('rektrs_batch', 'Batch')} {shortId(submission.batchId)}
                    {submission.submittedAt
                      ? ` · ${formatDateTime(submission.submittedAt)}`
                      : ` · ${formatDateTime(submission.createdAt)}`}
                  </span>
                </Link>
                <div className="px-[16px] empty:hidden">
                  <ReviewerComment submission={submission} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
