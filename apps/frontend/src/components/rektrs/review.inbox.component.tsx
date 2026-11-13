'use client';

import { FC, useMemo } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import {
  formatDateTime,
  RektrsApiError,
  RektrsInboxItem,
  RektrsSubmissionDetail,
  useRektrsLoader,
} from '@gitroom/frontend/components/rektrs/rektrs.api';
import {
  BrandDot,
  EmptyState,
  useBrands,
  useCampaigns,
  useTeamMembers,
} from '@gitroom/frontend/components/rektrs/rektrs.shared';

const SWR_OPTS = {
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
  refreshWhenHidden: false,
  refreshWhenOffline: false,
} as const;

const InboxRow: FC<{ item: RektrsInboxItem }> = ({ item }) => {
  const t = useT();
  const load = useRektrsLoader();
  const { data: brands } = useBrands();
  const { data: campaigns } = useCampaigns();
  const { nameOf } = useTeamMembers();
  // The inbox row itself carries no post count; the submission detail (the
  // same SWR key the detail page uses) provides the version snapshot counts.
  const { data: detail } = useSWR<RektrsSubmissionDetail>(
    `/rektrs/v1/submissions/${item.id}`,
    load,
    SWR_OPTS
  );

  const brand = (brands || []).find((b) => b.id === item.brandId);
  const campaign = (campaigns || []).find((c) => c.id === item.campaignId);
  const currentVersions = (detail?.versions || []).filter(
    (v) => v.versionNo === item.round
  );
  const postCount = currentVersions.reduce(
    (sum, v) => sum + (v.payload?.parts?.length || 0),
    0
  );

  return (
    <Link
      href={`/review/${item.id}`}
      className="flex items-center gap-[14px] px-[16px] py-[12px] border-b border-newTableBorder last:border-0 hover:bg-boxFocused"
    >
      <span className="inline-flex items-center gap-[6px] min-w-[130px]">
        <BrandDot color={brand?.colorPrimary} />
        <span className="font-[600] truncate">{brand?.name || '—'}</span>
      </span>
      <span className="min-w-[120px] truncate opacity-80">
        {campaign?.name || '—'}
      </span>
      <span className="flex-1 min-w-0 text-[12px] opacity-70 truncate">
        {t('submitted_by', 'Submitted by')} {nameOf(item.submittedById)}
        {item.submittedAt ? ` · ${formatDateTime(item.submittedAt)}` : ''}
      </span>
      <span className="text-[12px] opacity-70 whitespace-nowrap">
        {detail
          ? `${currentVersions.length} ${t('rektrs_channels_count', 'channel(s)')} · ${postCount} ${t('rektrs_posts_count', 'post(s)')}`
          : '…'}
      </span>
      {!item.decidable ? (
        <span className="inline-flex rounded-full bg-gray-500/15 text-gray-500 px-[8px] py-[2px] text-[11px] font-[600] whitespace-nowrap">
          {t('rektrs_yours_to_check', 'Yours — needs another reviewer')}
        </span>
      ) : (
        <span className="inline-flex rounded-full bg-amber-500/15 text-amber-600 px-[8px] py-[2px] text-[11px] font-[600] whitespace-nowrap">
          {t('rektrs_awaiting_decision', 'Awaiting decision')}
        </span>
      )}
    </Link>
  );
};

export const ReviewInboxComponent: FC = () => {
  const t = useT();
  const load = useRektrsLoader();
  const { data, isLoading, error } = useSWR<RektrsInboxItem[]>(
    '/rektrs/v1/review/inbox',
    load,
    SWR_OPTS
  );

  const sorted = useMemo(
    () =>
      [...(data || [])].sort((a, b) =>
        String(a.submittedAt || '').localeCompare(String(b.submittedAt || ''))
      ),
    [data]
  );

  if (isLoading) {
    return <LoadingComponent />;
  }

  if (error) {
    const forbidden =
      error instanceof RektrsApiError && error.status === 403;
    return (
      <div className="flex flex-col gap-[8px] text-textColor">
        <div className="text-[20px] font-[600]">{t('review_inbox', 'Review inbox')}</div>
        <div className="bg-newBgColorInner border border-newTableBorder rounded-[8px] p-[20px] text-[14px] opacity-80 max-w-[560px]">
          {forbidden
            ? t(
                'rektrs_inbox_reviewer_only',
                'The review inbox needs the REVIEWER function. Ask an organization manager to grant it — submissions waiting for review will appear here.'
              )
            : t('rektrs_inbox_load_failed', 'The review inbox could not be loaded.')}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[16px] text-textColor w-full">
      <div className="flex items-center justify-between">
        <div className="text-[20px] font-[600]">{t('review_inbox', 'Review inbox')}</div>
        <div className="text-[13px] opacity-60">
          {sorted.length} {t('rektrs_waiting', 'waiting')}
        </div>
      </div>
      {sorted.length === 0 ? (
        <EmptyState
          title={t('rektrs_inbox_empty', 'Nothing to review')}
          hint={t(
            'rektrs_inbox_empty_hint',
            'When creators submit content for a brand that requires approval, it lands here for a decision.'
          )}
        />
      ) : (
        <div className="bg-newBgColorInner border border-newTableBorder rounded-[8px] overflow-hidden flex flex-col">
          {sorted.map((item) => (
            <InboxRow key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
};
