'use client';

import { FC, useCallback, useMemo, useState } from 'react';
import { FormProvider, useForm } from 'react-hook-form';
import { useSWRConfig } from 'swr';
import useSWR from 'swr';
import { Button } from '@gitroom/react/form/button';
import { Input } from '@gitroom/react/form/input';
import { Select } from '@gitroom/react/form/select';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useUser } from '@gitroom/frontend/components/layout/user.context';
import {
  formatDate,
  fromLocalInputValue,
  readableRektrsError,
  RektrsCampaign,
  RektrsCampaignStatus,
  RektrsSubmission,
  toLocalInputValue,
  useRektrsCall,
  useRektrsLoader,
} from '@gitroom/frontend/components/rektrs/rektrs.api';
import {
  BrandDot,
  EmptyState,
  useBrands,
  useCampaigns,
  useHasRektrsFunction,
} from '@gitroom/frontend/components/rektrs/rektrs.shared';

const STATUS_OPTIONS: RektrsCampaignStatus[] = [
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'ARCHIVED',
];

interface CampaignFormValues {
  name: string;
  brandId: string;
  objective: string;
  status: string;
  startsAt: string;
  endsAt: string;
}

const CampaignFormModal: FC<{
  campaign: RektrsCampaign | null;
  onSaved: () => void;
}> = ({ campaign, onSaved }) => {
  const t = useT();
  const modal = useModals();
  const toaster = useToaster();
  const call = useRektrsCall();
  const { mutate } = useSWRConfig();
  const { data: brands } = useBrands();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const form = useForm<CampaignFormValues>({
    defaultValues: {
      name: campaign?.name || '',
      brandId: campaign?.brandId || '',
      objective: campaign?.objective || '',
      status: campaign?.status || 'ACTIVE',
      startsAt: toLocalInputValue(campaign?.startsAt),
      endsAt: toLocalInputValue(campaign?.endsAt),
    },
  });

  const onSubmit = useCallback(
    async (values: CampaignFormValues) => {
      if (!values.name.trim()) {
        setError(t('rektrs_campaign_name_required', 'Campaign name is required'));
        return;
      }
      if (!campaign && !values.brandId) {
        setError(t('rektrs_campaign_brand_required', 'Choose a brand for this campaign'));
        return;
      }
      setSaving(true);
      setError('');
      try {
        if (campaign) {
          await call(`/rektrs/v1/campaigns/${campaign.id}`, {
            method: 'PATCH',
            ifMatch: campaign.version,
            body: {
              name: values.name.trim(),
              objective: values.objective.trim() || null,
              status: values.status,
              startsAt: fromLocalInputValue(values.startsAt) ?? null,
              endsAt: fromLocalInputValue(values.endsAt) ?? null,
            },
          });
          toaster.show(t('rektrs_campaign_saved', 'Campaign saved'), 'success');
        } else {
          await call('/rektrs/v1/campaigns', {
            method: 'POST',
            body: {
              brandId: values.brandId,
              name: values.name.trim(),
              objective: values.objective.trim() || undefined,
              startsAt: fromLocalInputValue(values.startsAt),
              endsAt: fromLocalInputValue(values.endsAt),
            },
          });
          toaster.show(t('rektrs_campaign_created', 'Campaign created'), 'success');
        }
        await mutate('/rektrs/v1/campaigns');
        onSaved();
        modal.closeCurrent();
      } catch (e) {
        setError(
          readableRektrsError(e, t('rektrs_campaign_save_failed', 'Could not save the campaign'))
        );
      } finally {
        setSaving(false);
      }
    },
    [call, campaign, modal, mutate, onSaved, t, toaster]
  );

  return (
    <FormProvider {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="flex flex-col gap-[12px] p-[4px]"
      >
        <Input label={t('name', 'Name')} name="name" placeholder="" />
        {!campaign ? (
          <Select label={t('rektrs_brand', 'Brand')} name="brandId">
            <option value="">
              {t('rektrs_select_brand', 'Select a brand…')}
            </option>
            {(brands || []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        ) : null}
        <Input
          label={t('objective', 'Objective')}
          name="objective"
          placeholder=""
        />
        {campaign ? (
          <Select label={t('rektrs_status', 'Status')} name="status">
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        ) : null}
        <div className="grid grid-cols-2 gap-[12px]">
          <Input
            label={t('start_date', 'Start date')}
            name="startsAt"
            type="datetime-local"
          />
          <Input
            label={t('end_date', 'End date')}
            name="endsAt"
            type="datetime-local"
          />
        </div>
        {error ? <div className="text-red-400 text-[13px]">{error}</div> : null}
        <div className="flex gap-[10px] justify-end">
          <Button type="button" secondary onClick={() => modal.closeCurrent()}>
            {t('close', 'Close')}
          </Button>
          <Button type="submit" loading={saving}>
            {campaign
              ? t('save', 'Save')
              : t('rektrs_create_campaign', 'Create campaign')}
          </Button>
        </div>
      </form>
    </FormProvider>
  );
};

export const CampaignsComponent: FC = () => {
  const t = useT();
  const modal = useModals();
  const user = useUser();
  const canManage = useHasRektrsFunction('MANAGER');
  const { data: campaigns, isLoading, mutate } = useCampaigns();
  const { data: brands } = useBrands();
  const load = useRektrsLoader();
  const { data: submissions } = useSWR<RektrsSubmission[]>(
    '/rektrs/v1/submissions',
    load,
    { revalidateOnFocus: false }
  );

  const brandById = useMemo(() => {
    const map = new Map<string, (typeof brands)[number]>();
    for (const b of brands || []) {
      map.set(b.id, b);
    }
    return map;
  }, [brands]);

  const countByCampaign = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of submissions || []) {
      if (s.campaignId) {
        map.set(s.campaignId, (map.get(s.campaignId) || 0) + 1);
      }
    }
    return map;
  }, [submissions]);

  const openCampaign = useCallback(
    (campaign: RektrsCampaign | null) => {
      modal.openModal({
        title: campaign
          ? t('rektrs_edit_campaign', 'Edit campaign')
          : t('rektrs_new_campaign', 'New campaign'),
        withCloseButton: true,
        classNames: { modal: 'w-[100%] max-w-[560px] text-textColor' },
        children: <CampaignFormModal campaign={campaign} onSaved={() => mutate()} />,
      });
    },
    [modal, mutate, t]
  );

  const canEdit = useCallback(
    (campaign: RektrsCampaign) =>
      canManage || campaign.ownerId === user?.id,
    [canManage, user?.id]
  );

  return (
    <div className="flex flex-col gap-[16px] text-textColor w-full">
      <div className="flex items-center justify-between">
        <div className="text-[20px] font-[600]">{t('campaigns', 'Campaigns')}</div>
        {canManage ? (
          <Button onClick={() => openCampaign(null)}>
            {t('rektrs_new_campaign', 'New campaign')}
          </Button>
        ) : null}
      </div>

      {isLoading ? (
        <LoadingComponent />
      ) : !campaigns || campaigns.length === 0 ? (
        <EmptyState
          title={t('rektrs_no_campaigns_yet', 'No campaigns yet')}
          hint={t(
            'rektrs_no_campaigns_hint',
            'Campaigns group submissions under a brand so a launch can be reviewed and tracked as one effort.'
          )}
        />
      ) : (
        <div className="bg-newBgColorInner border border-newTableBorder rounded-[8px] overflow-hidden">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left border-b border-newTableBorder opacity-70">
                <th className="px-[16px] py-[10px] font-[500]">{t('name', 'Name')}</th>
                <th className="px-[16px] py-[10px] font-[500]">{t('rektrs_brand', 'Brand')}</th>
                <th className="px-[16px] py-[10px] font-[500]">{t('rektrs_status', 'Status')}</th>
                <th className="px-[16px] py-[10px] font-[500]">{t('rektrs_dates', 'Dates')}</th>
                <th className="px-[16px] py-[10px] font-[500]">{t('submissions', 'Submissions')}</th>
                <th className="px-[16px] py-[10px]" />
              </tr>
            </thead>
            <tbody>
              {campaigns.map((campaign) => {
                const brand = brandById.get(campaign.brandId);
                return (
                  <tr
                    key={campaign.id}
                    className="border-b border-newTableBorder last:border-0 hover:bg-boxFocused"
                  >
                    <td className="px-[16px] py-[10px]">
                      <div className="font-[600]">{campaign.name}</div>
                      {campaign.objective ? (
                        <div className="opacity-60 text-[12px] line-clamp-1">
                          {campaign.objective}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-[16px] py-[10px]">
                      <span className="inline-flex items-center gap-[6px]">
                        <BrandDot color={brand?.colorPrimary} />
                        {brand?.name || '—'}
                      </span>
                    </td>
                    <td className="px-[16px] py-[10px]">{campaign.status}</td>
                    <td className="px-[16px] py-[10px] whitespace-nowrap">
                      {campaign.startsAt || campaign.endsAt
                        ? `${formatDate(campaign.startsAt)} → ${formatDate(campaign.endsAt)}`
                        : '—'}
                    </td>
                    <td className="px-[16px] py-[10px]">
                      {countByCampaign.get(campaign.id) || 0}
                    </td>
                    <td className="px-[16px] py-[10px] text-right">
                      {canEdit(campaign) ? (
                        <Button secondary onClick={() => openCampaign(campaign)}>
                          {t('edit', 'Edit')}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
