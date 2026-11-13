'use client';

import { FC, useCallback, useEffect, useMemo, useState } from 'react';
import { FormProvider, useForm, useFormContext } from 'react-hook-form';
import { useSWRConfig } from 'swr';
import { Button } from '@gitroom/react/form/button';
import { Input } from '@gitroom/react/form/input';
import { Checkbox } from '@gitroom/react/form/checkbox';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import {
  readableRektrsError,
  RektrsBrand,
  slugifyClient,
  useRektrsCall,
} from '@gitroom/frontend/components/rektrs/rektrs.api';
import {
  BrandDot,
  ChannelChip,
  EmptyState,
  useBrands,
  useHasRektrsFunction,
  useIntegrations,
  useOrgSettings,
} from '@gitroom/frontend/components/rektrs/rektrs.shared';
import clsx from 'clsx';

const ColourField: FC<{ name: string; label: string }> = ({ name, label }) => {
  const { watch, setValue } = useFormContext();
  const value = (watch(name) as string) || '';
  const pickerValue = /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#64748b';
  return (
    <div className="flex flex-col gap-[6px]">
      <div className="text-[14px]">{label}</div>
      <div className="flex items-center gap-[8px]">
        <input
          type="color"
          value={pickerValue}
          onChange={(e) =>
            setValue(name, e.target.value, { shouldDirty: true })
          }
          className="w-[44px] h-[42px] bg-transparent cursor-pointer border border-newTableBorder rounded-[8px] p-[4px]"
        />
        <div className="bg-newBgColorInner h-[42px] border-newTableBorder border rounded-[8px] flex items-center flex-1">
          <input
            value={value}
            onChange={(e) =>
              setValue(name, e.target.value, { shouldDirty: true })
            }
            placeholder="#RRGGBB"
            className="h-full bg-transparent outline-none flex-1 text-[14px] px-[16px]"
          />
        </div>
        {value ? (
          <button
            type="button"
            className="text-[12px] opacity-60 hover:opacity-100"
            onClick={() => setValue(name, '', { shouldDirty: true })}
          >
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );
};

const BrandChannels: FC<{ brand: RektrsBrand }> = ({ brand }) => {
  const t = useT();
  const call = useRektrsCall();
  const toaster = useToaster();
  const { mutate } = useSWRConfig();
  const { data: integrations } = useIntegrations();
  const { data: brands } = useBrands();
  const [busyId, setBusyId] = useState<string | null>(null);

  const ownerByIntegration = useMemo(() => {
    const map = new Map<string, RektrsBrand>();
    for (const b of brands || []) {
      for (const c of b.channels || []) {
        map.set(c.integrationId, b);
      }
    }
    return map;
  }, [brands]);

  const toggle = useCallback(
    async (integrationId: string, assign: boolean) => {
      setBusyId(integrationId);
      try {
        if (assign) {
          await call(`/rektrs/v1/brands/${brand.id}/channels`, {
            method: 'POST',
            body: { integrationId },
          });
        } else {
          await call(
            `/rektrs/v1/brands/${brand.id}/channels/${integrationId}`,
            { method: 'DELETE' }
          );
        }
        await mutate('/rektrs/v1/brands');
      } catch (e) {
        toaster.show(
          readableRektrsError(e, t('rektrs_channel_update_failed', 'Could not update the channel assignment')),
          'warning'
        );
      } finally {
        setBusyId(null);
      }
    },
    [brand.id, call, mutate, t, toaster]
  );

  return (
    <div className="flex flex-col gap-[8px]">
      <div className="text-[14px] font-[600]">
        {t('channels', 'Channels')}
      </div>
      <div className="text-[12px] opacity-60">
        {t(
          'rektrs_brand_channels_hint',
          'A channel can belong to only one brand. Changes apply immediately and are audit-logged.'
        )}
      </div>
      <div className="flex flex-col max-h-[260px] overflow-y-auto border border-newTableBorder rounded-[8px] divide-y divide-newTableBorder">
        {(integrations || []).map((integration) => {
          const owner = ownerByIntegration.get(integration.id);
          const mine = owner?.id === brand.id;
          const taken = !!owner && !mine;
          return (
            <label
              key={integration.id}
              className={clsx(
                'flex items-center gap-[10px] px-[12px] py-[8px] text-[13px]',
                taken ? 'opacity-50' : 'cursor-pointer hover:bg-boxFocused'
              )}
            >
              <input
                type="checkbox"
                checked={mine}
                disabled={taken || busyId === integration.id}
                onChange={(e) => toggle(integration.id, e.target.checked)}
                className="accent-[#612bd3] w-[16px] h-[16px]"
              />
              <ChannelChip
                providerIdentifier={integration.identifier}
                name={integration.name}
                picture={integration.picture}
              />
              {taken ? (
                <span className="ms-auto text-[11px] opacity-70">
                  {owner?.name}
                </span>
              ) : null}
            </label>
          );
        })}
        {integrations && integrations.length === 0 ? (
          <div className="px-[12px] py-[10px] text-[13px] opacity-60">
            {t('rektrs_no_channels', 'No channels are connected yet.')}
          </div>
        ) : null}
      </div>
    </div>
  );
};

interface BrandFormValues {
  name: string;
  slug: string;
  description: string;
  colorPrimary: string;
  colorSecondary: string;
  approvalRequired: boolean;
}

const BrandFormModal: FC<{
  brand: RektrsBrand | null;
  onSaved: () => void;
}> = ({ brand: initialBrand, onSaved }) => {
  const t = useT();
  const modal = useModals();
  const toaster = useToaster();
  const call = useRektrsCall();
  const { mutate } = useSWRConfig();
  const [current, setCurrent] = useState<RektrsBrand | null>(initialBrand);
  const [slugTouched, setSlugTouched] = useState(!!initialBrand);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const form = useForm<BrandFormValues>({
    defaultValues: {
      name: initialBrand?.name || '',
      slug: initialBrand?.slug || '',
      description: initialBrand?.description || '',
      colorPrimary: initialBrand?.colorPrimary || '',
      colorSecondary: initialBrand?.colorSecondary || '',
      approvalRequired: initialBrand?.approvalRequired || false,
    },
  });

  const nameValue = form.watch('name');
  useEffect(() => {
    if (!slugTouched) {
      form.setValue('slug', slugifyClient(nameValue || ''));
    }
  }, [nameValue, slugTouched, form]);

  const freshBrand = (brands: RektrsBrand[] | undefined) =>
    brands?.find((b) => b.id === current?.id);

  const { data: brandsList } = useBrands();
  const liveBrand = freshBrand(brandsList) || current;

  const onSubmit = useCallback(
    async (values: BrandFormValues) => {
      if (!values.name.trim()) {
        setError(t('rektrs_brand_name_required', 'Brand name is required'));
        return;
      }
      setSaving(true);
      setError('');
      try {
        if (current) {
          const updated = await call<RektrsBrand>(
            `/rektrs/v1/brands/${current.id}`,
            {
              method: 'PATCH',
              ifMatch: current.version,
              body: {
                name: values.name.trim(),
                description: values.description.trim() || null,
                colorPrimary: values.colorPrimary.trim() || null,
                colorSecondary: values.colorSecondary.trim() || null,
                approvalRequired: !!values.approvalRequired,
              },
            }
          );
          setCurrent(updated);
          toaster.show(t('rektrs_brand_saved', 'Brand saved'), 'success');
        } else {
          const created = await call<RektrsBrand>('/rektrs/v1/brands', {
            method: 'POST',
            body: {
              name: values.name.trim(),
              slug: values.slug.trim() || undefined,
              description: values.description.trim() || undefined,
              colorPrimary: values.colorPrimary.trim() || undefined,
              colorSecondary: values.colorSecondary.trim() || undefined,
              approvalRequired: !!values.approvalRequired,
            },
          });
          setCurrent(created);
          setSlugTouched(true);
          toaster.show(
            t(
              'rektrs_brand_created_assign_channels',
              'Brand created — now assign its channels below'
            ),
            'success'
          );
        }
        await mutate('/rektrs/v1/brands');
        onSaved();
      } catch (e) {
        setError(
          readableRektrsError(e, t('rektrs_brand_save_failed', 'Could not save the brand'))
        );
      } finally {
        setSaving(false);
      }
    },
    [call, current, mutate, onSaved, t, toaster]
  );

  return (
    <div className="flex flex-col gap-[16px] p-[4px]">
      <FormProvider {...form}>
        <form
          onSubmit={form.handleSubmit(onSubmit)}
          className="flex flex-col gap-[12px]"
        >
          <Input label={t('name', 'Name')} name="name" placeholder="Acme" />
          <div
            onFocus={() => setSlugTouched(true)}
          >
            <Input
              label={t('rektrs_slug', 'Slug')}
              name="slug"
              placeholder="acme"
              disabled={!!current}
            />
          </div>
          <Input
            label={t('description', 'Description')}
            name="description"
            placeholder=""
          />
          <div className="grid grid-cols-2 gap-[12px]">
            <ColourField
              name="colorPrimary"
              label={t('rektrs_primary_colour', 'Primary colour')}
            />
            <ColourField
              name="colorSecondary"
              label={t('rektrs_secondary_colour', 'Secondary colour')}
            />
          </div>
          <div className="flex items-center gap-[10px]">
            <Checkbox
              name="approvalRequired"
              label={t(
                'rektrs_approval_required',
                'Approval required before scheduling'
              )}
            />
          </div>
          <div className="text-[12px] opacity-60 -mt-[6px]">
            {t(
              'rektrs_approval_required_hint',
              'When on, posts on this brand’s channels can only be scheduled after a submission is approved, and any later content change voids the approval.'
            )}
          </div>
          {error ? (
            <div className="text-red-400 text-[13px]">{error}</div>
          ) : null}
          <div className="flex gap-[10px] justify-end">
            <Button
              type="button"
              secondary
              onClick={() => modal.closeCurrent()}
            >
              {t('close', 'Close')}
            </Button>
            <Button type="submit" loading={saving}>
              {current
                ? t('save', 'Save')
                : t('rektrs_create_brand', 'Create brand')}
            </Button>
          </div>
        </form>
      </FormProvider>
      {liveBrand ? (
        <div className="border-t border-newTableBorder pt-[14px]">
          <BrandChannels brand={liveBrand} />
        </div>
      ) : null}
    </div>
  );
};

const OrgPolicyCard: FC = () => {
  const t = useT();
  const call = useRektrsCall();
  const toaster = useToaster();
  const canManage = useHasRektrsFunction('MANAGER');
  const { data: settings, mutate } = useOrgSettings();
  const [busy, setBusy] = useState(false);

  const patch = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      try {
        await call('/rektrs/v1/org/settings', { method: 'PATCH', body });
        await mutate();
        toaster.show(t('settings_updated', 'Settings updated'), 'success');
      } catch (e) {
        toaster.show(
          readableRektrsError(e, t('rektrs_settings_failed', 'Could not update the settings')),
          'warning'
        );
      } finally {
        setBusy(false);
      }
    },
    [call, mutate, t, toaster]
  );

  if (!settings) {
    return null;
  }

  const Toggle: FC<{
    label: string;
    hint: string;
    value: boolean;
    onChange: (v: boolean) => void;
  }> = ({ label, hint, value, onChange }) => (
    <div className="flex items-start justify-between gap-[16px] py-[8px]">
      <div className="flex flex-col gap-[2px]">
        <div className="text-[14px] font-[500]">{label}</div>
        <div className="text-[12px] opacity-60 max-w-[520px]">{hint}</div>
      </div>
      <button
        type="button"
        disabled={!canManage || busy}
        onClick={() => onChange(!value)}
        className={clsx(
          'relative w-[42px] h-[24px] rounded-full shrink-0 transition-colors',
          value ? 'bg-[#612bd3]' : 'bg-gray-400/40',
          !canManage && 'opacity-50 cursor-not-allowed'
        )}
        aria-pressed={value}
      >
        <span
          className={clsx(
            'absolute top-[3px] w-[18px] h-[18px] rounded-full bg-white transition-all',
            value ? 'start-[21px]' : 'start-[3px]'
          )}
        />
      </button>
    </div>
  );

  return (
    <div className="bg-newBgColorInner border border-newTableBorder rounded-[8px] p-[16px]">
      <div className="text-[15px] font-[600] mb-[4px]">
        {t('rektrs_org_approval_policy', 'Organization approval policy')}
      </div>
      <Toggle
        label={t(
          'rektrs_approval_required_default',
          'Require approval for all brands by default'
        )}
        hint={t(
          'rektrs_approval_required_default_hint',
          'Org-wide floor: every channel needs an approved submission before scheduling, even if its brand does not require approval itself.'
        )}
        value={settings.approvalRequiredDefault}
        onChange={(v) => patch({ approvalRequiredDefault: v })}
      />
      <Toggle
        label={t('rektrs_allow_self_approval', 'Allow self-approval')}
        hint={t(
          'rektrs_allow_self_approval_hint',
          'Maker-checker exception: when on, the person who submitted content may also approve it. Every self-approval is flagged in the audit trail.'
        )}
        value={settings.allowSelfApproval}
        onChange={(v) => patch({ allowSelfApproval: v })}
      />
      {!canManage ? (
        <div className="text-[12px] opacity-60 mt-[4px]">
          {t(
            'rektrs_policy_manager_only',
            'Only members with the MANAGER function can change these settings.'
          )}
        </div>
      ) : null}
    </div>
  );
};

export const BrandsComponent: FC = () => {
  const t = useT();
  const modal = useModals();
  const canManage = useHasRektrsFunction('MANAGER');
  const { data: brands, isLoading, mutate } = useBrands();
  const { data: integrations } = useIntegrations();

  const integrationById = useMemo(() => {
    const map = new Map<string, (typeof integrations)[number]>();
    for (const i of integrations || []) {
      map.set(i.id, i);
    }
    return map;
  }, [integrations]);

  const openBrand = useCallback(
    (brand: RektrsBrand | null) => {
      modal.openModal({
        title: brand
          ? t('rektrs_edit_brand', 'Edit brand')
          : t('rektrs_new_brand', 'New brand'),
        withCloseButton: true,
        classNames: { modal: 'w-[100%] max-w-[640px] text-textColor' },
        children: (
          <BrandFormModal brand={brand} onSaved={() => mutate()} />
        ),
      });
    },
    [modal, mutate, t]
  );

  return (
    <div className="flex flex-col gap-[16px] text-textColor w-full">
      <div className="flex items-center justify-between">
        <div className="text-[20px] font-[600]">{t('brands', 'Brands')}</div>
        {canManage ? (
          <Button onClick={() => openBrand(null)}>
            {t('rektrs_new_brand', 'New brand')}
          </Button>
        ) : null}
      </div>

      <OrgPolicyCard />

      {isLoading ? (
        <LoadingComponent />
      ) : !brands || brands.length === 0 ? (
        <EmptyState
          title={t('rektrs_no_brands_yet', 'No brands yet')}
          hint={t(
            'rektrs_no_brands_hint',
            'Brands group your channels so campaigns and approval rules can be applied per brand. Create your first brand to get started.'
          )}
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-[12px]">
          {brands.map((brand) => (
            <div
              key={brand.id}
              className="bg-newBgColorInner border border-newTableBorder rounded-[8px] p-[16px] flex flex-col gap-[10px]"
            >
              <div className="flex items-center gap-[8px]">
                <BrandDot color={brand.colorPrimary} size={16} />
                <div className="text-[16px] font-[600] truncate">
                  {brand.name}
                </div>
                {brand.approvalRequired ? (
                  <span className="ms-auto inline-flex rounded-full bg-amber-500/15 text-amber-600 px-[8px] py-[2px] text-[11px] font-[600] whitespace-nowrap">
                    {t('rektrs_approval_badge', 'Approval required')}
                  </span>
                ) : null}
              </div>
              <div className="text-[12px] opacity-60">/{brand.slug}</div>
              {brand.description ? (
                <div className="text-[13px] opacity-80 line-clamp-2">
                  {brand.description}
                </div>
              ) : null}
              <div className="flex flex-col gap-[4px]">
                <div className="text-[12px] opacity-60">
                  {t('channels', 'Channels')} ({brand.channels?.length || 0})
                </div>
                <div className="flex flex-wrap gap-x-[12px] gap-y-[4px] text-[12px]">
                  {(brand.channels || []).map((c) => {
                    const integration = integrationById.get(c.integrationId);
                    return (
                      <ChannelChip
                        key={c.id}
                        providerIdentifier={integration?.identifier}
                        name={integration?.name}
                        picture={integration?.picture}
                      />
                    );
                  })}
                  {!brand.channels?.length ? (
                    <span className="opacity-50">
                      {t('rektrs_no_channels_assigned', 'None assigned')}
                    </span>
                  ) : null}
                </div>
              </div>
              {canManage ? (
                <div className="mt-auto pt-[4px]">
                  <Button secondary onClick={() => openBrand(brand)}>
                    {t('edit', 'Edit')}
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
