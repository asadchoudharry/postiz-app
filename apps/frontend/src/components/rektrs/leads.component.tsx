'use client';

import { FC, useCallback, useMemo, useState } from 'react';
import useSWR from 'swr';
import { Button } from '@gitroom/react/form/button';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import {
  formatDateTime,
  readableRektrsError,
  RektrsApiError,
  RektrsLead,
  RektrsLeadStatus,
  useRektrsCall,
  useRektrsLoader,
} from '@gitroom/frontend/components/rektrs/rektrs.api';
import {
  BrandDot,
  EmptyState,
  LeadStatusBadge,
  useBrands,
  useHasRektrsFunction,
} from '@gitroom/frontend/components/rektrs/rektrs.shared';
import clsx from 'clsx';

const SWR_OPTS = {
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
  refreshWhenHidden: false,
  refreshWhenOffline: false,
} as const;

const STATUS_FILTERS: Array<{ value: string; key: string; label: string }> = [
  { value: 'ALL', key: 'rektrs_leads_filter_all', label: 'All leads' },
  { value: 'HUMAN_REVIEW', key: 'rektrs_leads_filter_human', label: 'Needs a human' },
  { value: 'COMPLETE', key: 'rektrs_leads_filter_complete', label: 'Complete' },
  { value: 'DM_SENT', key: 'rektrs_leads_filter_dm_sent', label: 'DM sent' },
  { value: 'DM_FAILED', key: 'rektrs_leads_filter_dm_failed', label: 'DM failed' },
  { value: 'WEBHOOK_PENDING', key: 'rektrs_leads_filter_wh_pending', label: 'CRM pending' },
  { value: 'WEBHOOK_FAILED', key: 'rektrs_leads_filter_wh_failed', label: 'CRM failed' },
  { value: 'HANDLED', key: 'rektrs_leads_filter_handled', label: 'Handled' },
];

const RETRYABLE: RektrsLeadStatus[] = [
  'DM_FAILED',
  'WEBHOOK_PENDING',
  'WEBHOOK_FAILED',
  'DM_SENT',
];

const LeadRow: FC<{ lead: RektrsLead; onChanged: () => void }> = ({
  lead,
  onChanged,
}) => {
  const t = useT();
  const call = useRektrsCall();
  const toaster = useToaster();
  const canManage = useHasRektrsFunction('MANAGER');
  const { data: brands } = useBrands();
  const [busy, setBusy] = useState(false);

  const brand = (brands || []).find((b) => b.id === lead.brandId);

  const act = useCallback(
    async (path: string, okMessage: string) => {
      setBusy(true);
      try {
        await call(path, { method: 'POST' });
        toaster.show(okMessage, 'success');
        onChanged();
      } catch (e) {
        toaster.show(
          readableRektrsError(e, t('rektrs_lead_action_failed', 'That action could not be completed')),
          'warning'
        );
      } finally {
        setBusy(false);
      }
    },
    [call, onChanged, t, toaster]
  );

  return (
    <div className="flex items-start gap-[14px] px-[16px] py-[12px] border-b border-newTableBorder last:border-0">
      <span className="inline-flex items-center gap-[6px] min-w-[130px] pt-[2px]">
        <BrandDot color={brand?.colorPrimary} />
        <span className="font-[600] truncate">{brand?.name || '—'}</span>
      </span>
      <span className="inline-flex items-center gap-[6px] min-w-[110px] pt-[2px]">
        <img
          src={`/icons/platforms/${lead.providerIdentifier}.png`}
          alt=""
          className="w-[16px] h-[16px] shrink-0"
        />
        <span className="truncate text-[13px]">
          {lead.commenterName || lead.commenterId}
        </span>
      </span>
      <span className="flex-1 min-w-0 flex flex-col gap-[2px]">
        <span className="text-[13px] truncate" title={lead.commentText}>
          “{lead.commentText}”
        </span>
        <span className="text-[12px] opacity-60">
          {lead.matchedKeyword
            ? `${t('rektrs_lead_matched_keyword', 'Keyword')}: “${lead.matchedKeyword}”`
            : lead.matchedGuardWord
              ? `${t('rektrs_lead_matched_guard', 'Guard word')}: “${lead.matchedGuardWord}”`
              : ''}
          {lead.dmError ? ` · ${lead.dmError}` : ''}
          {lead.webhookError ? ` · ${lead.webhookError}` : ''}
        </span>
      </span>
      <span className="text-[12px] opacity-70 whitespace-nowrap pt-[2px]">
        {formatDateTime(lead.commentAt || lead.createdAt)}
      </span>
      <LeadStatusBadge status={lead.status} />
      {lead.status === 'HUMAN_REVIEW' ? (
        <Button
          type="button"
          secondary
          loading={busy}
          onClick={() =>
            act(
              `/rektrs/v1/leads/${lead.id}/handled`,
              t('rektrs_lead_handled_ok', 'Marked as handled')
            )
          }
        >
          {t('rektrs_lead_mark_handled', 'Mark handled')}
        </Button>
      ) : null}
      {canManage && RETRYABLE.includes(lead.status) ? (
        <Button
          type="button"
          secondary
          loading={busy}
          onClick={() =>
            act(
              `/rektrs/v1/leads/${lead.id}/retry`,
              t('rektrs_lead_retry_ok', 'Retry queued — check back in a moment')
            )
          }
        >
          {t('rektrs_lead_retry', 'Retry')}
        </Button>
      ) : null}
    </div>
  );
};

export const LeadsComponent: FC = () => {
  const t = useT();
  const load = useRektrsLoader();
  const [status, setStatus] = useState('ALL');
  const [brandId, setBrandId] = useState('ALL');
  const { data: brands } = useBrands();

  const url = useMemo(() => {
    const params = new URLSearchParams();
    if (status !== 'ALL') {
      params.set('status', status);
    }
    if (brandId !== 'ALL') {
      params.set('brandId', brandId);
    }
    const qs = params.toString();
    return `/rektrs/v1/leads${qs ? `?${qs}` : ''}`;
  }, [status, brandId]);

  const { data, isLoading, error, mutate } = useSWR<RektrsLead[]>(
    url,
    load,
    SWR_OPTS
  );

  if (error) {
    const forbidden = error instanceof RektrsApiError && error.status === 403;
    return (
      <div className="flex flex-col gap-[8px] text-textColor">
        <div className="text-[20px] font-[600]">{t('rektrs_leads', 'Leads')}</div>
        <div className="bg-newBgColorInner border border-newTableBorder rounded-[8px] p-[20px] text-[14px] opacity-80 max-w-[560px]">
          {forbidden
            ? t(
                'rektrs_leads_forbidden',
                'Leads need the MANAGER, CREATOR or ANALYST function. Ask an organization manager to grant it.'
              )
            : t('rektrs_leads_load_failed', 'Leads could not be loaded.')}
        </div>
      </div>
    );
  }

  const leads = data || [];

  return (
    <div className="flex flex-col gap-[16px] text-textColor w-full">
      <div className="flex items-center justify-between">
        <div className="text-[20px] font-[600]">{t('rektrs_leads', 'Leads')}</div>
        <div className="text-[13px] opacity-60">
          {leads.length} {t('rektrs_leads_count', 'shown')}
        </div>
      </div>
      <div className="text-[13px] opacity-70 max-w-[720px]">
        {t(
          'rektrs_leads_intro',
          'Comments that matched a brand’s lead keywords: the commenter was sent a DM and the lead was pushed to your CRM webhook. Comments with complaint or guard words are never auto-DMed — they wait here for a human.'
        )}
      </div>
      <div className="flex flex-wrap items-center gap-[8px]">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setStatus(f.value)}
            className={clsx(
              'rounded-full px-[12px] py-[5px] text-[12px] font-[600] border transition-colors',
              status === f.value
                ? 'bg-[#612bd3] text-white border-transparent'
                : 'border-newTableBorder opacity-70 hover:opacity-100'
            )}
          >
            {t(f.key, f.label)}
          </button>
        ))}
        <select
          value={brandId}
          onChange={(e) => setBrandId(e.target.value)}
          className="bg-newBgColorInner border border-newTableBorder rounded-full px-[12px] py-[5px] text-[12px] font-[600] outline-none"
        >
          <option value="ALL">{t('rektrs_leads_all_brands', 'All brands')}</option>
          {(brands || []).map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </div>
      {isLoading ? (
        <LoadingComponent />
      ) : leads.length === 0 ? (
        <EmptyState
          title={t('rektrs_leads_empty', 'No leads here yet')}
          hint={t(
            'rektrs_leads_empty_hint',
            'Turn on lead automation for a brand (Brands → Edit → Lead automation), and matching comments will land here.'
          )}
        />
      ) : (
        <div className="bg-newBgColorInner border border-newTableBorder rounded-[8px] overflow-hidden flex flex-col">
          {leads.map((lead) => (
            <LeadRow key={lead.id} lead={lead} onChanged={() => mutate()} />
          ))}
        </div>
      )}
    </div>
  );
};
