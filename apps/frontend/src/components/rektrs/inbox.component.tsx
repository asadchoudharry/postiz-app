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
  RektrsTriageItem,
  useRektrsCall,
  useRektrsLoader,
} from '@gitroom/frontend/components/rektrs/rektrs.api';
import {
  BrandDot,
  EmptyState,
  InboxCategoryBadge,
  InboxStatusBadge,
  useBrands,
} from '@gitroom/frontend/components/rektrs/rektrs.shared';
import clsx from 'clsx';

const SWR_OPTS = {
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
  refreshWhenHidden: false,
  refreshWhenOffline: false,
} as const;

const STATUS_FILTERS: Array<{ value: string; key: string; label: string }> = [
  { value: 'ALL', key: 'rektrs_inbox_filter_all', label: 'All items' },
  { value: 'QUEUED', key: 'rektrs_inbox_filter_queued', label: 'Needs a human' },
  { value: 'DRAFTED', key: 'rektrs_inbox_filter_drafted', label: 'Draft ready' },
  { value: 'NEW', key: 'rektrs_inbox_filter_new', label: 'New' },
  { value: 'SENT', key: 'rektrs_inbox_filter_sent', label: 'Reply sent' },
  { value: 'DISMISSED', key: 'rektrs_inbox_filter_dismissed', label: 'Dismissed' },
];

const LANGUAGE_LABELS: Record<string, string> = {
  en: 'English',
  ur: 'Urdu',
  ar: 'Arabic',
  'ur-Latn': 'Roman Urdu',
  other: 'Other',
};

const TriageRow: FC<{ item: RektrsTriageItem; onChanged: () => void }> = ({
  item,
  onChanged,
}) => {
  const t = useT();
  const call = useRektrsCall();
  const toaster = useToaster();
  const { data: brands } = useBrands();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.suggestedReply || '');

  const brand = (brands || []).find((b) => b.id === item.brandId);

  const send = useCallback(async () => {
    setBusy(true);
    try {
      const body =
        editing && draft.trim() !== (item.suggestedReply || '').trim()
          ? { text: draft.trim() }
          : {};
      await call(`/rektrs/v1/brands/${item.brandId}/inbox/${item.id}/send`, {
        method: 'POST',
        body,
      });
      toaster.show(t('rektrs_inbox_sent_ok', 'Reply sent'), 'success');
      onChanged();
    } catch (e) {
      toaster.show(
        readableRektrsError(
          e,
          t('rektrs_inbox_send_failed', 'The reply could not be sent')
        ),
        'warning'
      );
    } finally {
      setBusy(false);
    }
  }, [call, draft, editing, item, onChanged, t, toaster]);

  const dismiss = useCallback(async () => {
    setBusy(true);
    try {
      await call(`/rektrs/v1/brands/${item.brandId}/inbox/${item.id}/dismiss`, {
        method: 'POST',
      });
      toaster.show(t('rektrs_inbox_dismissed_ok', 'Dismissed'), 'success');
      onChanged();
    } catch (e) {
      toaster.show(
        readableRektrsError(
          e,
          t('rektrs_inbox_action_failed', 'That action could not be completed')
        ),
        'warning'
      );
    } finally {
      setBusy(false);
    }
  }, [call, item, onChanged, t, toaster]);

  const actionable =
    item.status === 'NEW' || item.status === 'QUEUED' || item.status === 'DRAFTED';

  return (
    <div className="flex items-start gap-[14px] px-[16px] py-[12px] border-b border-newTableBorder last:border-0">
      <span className="inline-flex items-center gap-[6px] min-w-[130px] pt-[2px]">
        <BrandDot color={brand?.colorPrimary} />
        <span className="font-[600] truncate">{brand?.name || '—'}</span>
      </span>
      <span className="inline-flex items-center gap-[6px] min-w-[110px] pt-[2px]">
        <img
          src={`/icons/platforms/${item.providerIdentifier}.png`}
          alt=""
          className="w-[16px] h-[16px] shrink-0"
        />
        <span className="truncate text-[13px]">
          {item.authorName || item.authorId}
        </span>
      </span>
      <span className="flex-1 min-w-0 flex flex-col gap-[3px]">
        <span className="text-[13px]" title={item.originalText}>
          “{item.originalText}”
        </span>
        {item.translationStatus === 'TRANSLATED' && item.translatedText ? (
          <span className="text-[13px] opacity-80">
            <span className="opacity-60">
              {t('rektrs_inbox_translation', 'Translation')}:{' '}
            </span>
            “{item.translatedText}”
          </span>
        ) : null}
        <span className="text-[12px] opacity-60">
          {LANGUAGE_LABELS[item.detectedLanguage] || item.detectedLanguage}
          {item.matchedPhrase
            ? ` · ${t('rektrs_inbox_matched', 'Matched')}: “${item.matchedPhrase}”`
            : ''}
          {item.translationStatus === 'UNAVAILABLE'
            ? ` · ${t('rektrs_inbox_translation_unavailable', 'Translation not configured on this server')}`
            : item.translationStatus === 'FAILED'
              ? ` · ${t('rektrs_inbox_translation_failed', 'Translation failed')}`
              : ''}
        </span>
        {item.note ? (
          <span className="text-[12px] opacity-60">{item.note}</span>
        ) : null}
        {item.status === 'DRAFTED' && item.suggestedReply ? (
          <span className="flex flex-col gap-[6px] mt-[4px]">
            {editing ? (
              <textarea
                className="bg-newBgColorInner border border-newTableBorder rounded-[8px] px-[10px] py-[8px] text-[13px] outline-none w-full"
                rows={3}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
            ) : (
              <span className="text-[13px] bg-black/5 dark:bg-white/5 rounded-[8px] px-[10px] py-[8px]">
                <span className="opacity-60">
                  {t('rektrs_inbox_suggested_reply', 'Suggested reply')}:{' '}
                </span>
                {item.suggestedReply}
              </span>
            )}
          </span>
        ) : null}
        {item.status === 'SENT' && item.sentText ? (
          <span className="text-[12px] opacity-70">
            {t('rektrs_inbox_sent_text', 'Sent')}: “{item.sentText}”
          </span>
        ) : null}
        {item.sendError ? (
          <span className="text-[12px] text-red-500">{item.sendError}</span>
        ) : null}
      </span>
      <span className="text-[12px] opacity-70 whitespace-nowrap pt-[2px]">
        {formatDateTime(item.commentAt || item.createdAt)}
      </span>
      <span className="flex flex-col items-end gap-[4px]">
        <InboxCategoryBadge category={item.category} />
        <InboxStatusBadge status={item.status} />
      </span>
      {actionable ? (
        <span className="flex flex-col gap-[6px]">
          {item.status === 'DRAFTED' ? (
            <>
              <Button type="button" secondary loading={busy} onClick={send}>
                {t('rektrs_inbox_send', 'Send reply')}
              </Button>
              <Button
                type="button"
                secondary
                onClick={() => setEditing(!editing)}
              >
                {editing
                  ? t('rektrs_inbox_edit_cancel', 'Cancel edit')
                  : t('rektrs_inbox_edit', 'Edit')}
              </Button>
            </>
          ) : null}
          <Button type="button" secondary loading={busy} onClick={dismiss}>
            {t('rektrs_inbox_dismiss', 'Dismiss')}
          </Button>
        </span>
      ) : null}
    </div>
  );
};

export const InboxComponent: FC = () => {
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
    return `/rektrs/v1/inbox${qs ? `?${qs}` : ''}`;
  }, [status, brandId]);

  const { data, isLoading, error, mutate } = useSWR<RektrsTriageItem[]>(
    url,
    load,
    SWR_OPTS
  );

  if (error) {
    const forbidden = error instanceof RektrsApiError && error.status === 403;
    return (
      <div className="flex flex-col gap-[8px] text-textColor">
        <div className="text-[20px] font-[600]">
          {t('rektrs_inbox', 'Inbox')}
        </div>
        <div className="bg-newBgColorInner border border-newTableBorder rounded-[8px] p-[20px] text-[14px] opacity-80 max-w-[560px]">
          {forbidden
            ? t(
                'rektrs_inbox_forbidden',
                'The inbox needs the MANAGER, CREATOR or ANALYST function. Ask an organization manager to grant it.'
              )
            : t('rektrs_triage_load_failed', 'The inbox could not be loaded.')}
        </div>
      </div>
    );
  }

  const items = data || [];

  return (
    <div className="flex flex-col gap-[16px] text-textColor w-full">
      <div className="flex items-center justify-between">
        <div className="text-[20px] font-[600]">
          {t('rektrs_inbox', 'Inbox')}
        </div>
        <div className="text-[13px] opacity-60">
          {items.length} {t('rektrs_inbox_count', 'shown')}
        </div>
      </div>
      <div className="text-[13px] opacity-70 max-w-[720px]">
        {t(
          'rektrs_inbox_intro',
          'Comments on your brands’ channels, triaged automatically: complaints wait here for a human, FAQ questions get a suggested reply you can send with one tap, and everything is translated into the brand’s working language when a translation provider is configured. Nothing is ever auto-sent.'
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
          <option value="ALL">
            {t('rektrs_inbox_all_brands', 'All brands')}
          </option>
          {(brands || []).map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </div>
      {isLoading ? (
        <LoadingComponent />
      ) : items.length === 0 ? (
        <EmptyState
          title={t('rektrs_triage_empty', 'Nothing here yet')}
          hint={t(
            'rektrs_triage_empty_hint',
            'Turn on inbox triage for a brand (Brands → Edit → Inbox triage), and new comments on its channels will land here.'
          )}
        />
      ) : (
        <div className="bg-newBgColorInner border border-newTableBorder rounded-[8px] overflow-hidden flex flex-col">
          {items.map((item) => (
            <TriageRow key={item.id} item={item} onChanged={() => mutate()} />
          ))}
        </div>
      )}
    </div>
  );
};
