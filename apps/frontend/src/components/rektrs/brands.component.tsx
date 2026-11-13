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
  formatDateTime,
  readableRektrsError,
  RektrsBrand,
  RektrsBrandPauseResult,
  RektrsBrandResumeResult,
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
  useTeamMembers,
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

/**
 * W5 crisis kill-switch (AUTOMATION-WORKFLOWS.md W5): the pause modal asks
 * for an optional reason; the banner + resume live in BrandKillSwitch.
 */
const BrandPauseModal: FC<{ brand: RektrsBrand }> = ({ brand }) => {
  const t = useT();
  const modal = useModals();
  const call = useRektrsCall();
  const toaster = useToaster();
  const { mutate } = useSWRConfig();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const pause = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const result = await call<RektrsBrandPauseResult>(
        `/rektrs/v1/brands/${brand.id}/pause`,
        {
          method: 'POST',
          body: { reason: reason.trim() || undefined },
        }
      );
      await mutate('/rektrs/v1/brands');
      toaster.show(
        t(
          'rektrs_brand_paused_toast',
          'Brand paused — {{pulled}} queued post(s) pulled back to drafts',
          { pulled: String(result.pulledCount) }
        ),
        'success'
      );
      modal.closeCurrent();
    } catch (e) {
      setError(
        readableRektrsError(e, t('rektrs_brand_pause_failed', 'Could not pause the brand'))
      );
    } finally {
      setBusy(false);
    }
  }, [brand.id, call, modal, mutate, reason, t, toaster]);

  return (
    <div className="flex flex-col gap-[14px] p-[4px]">
      <div className="text-[14px]">
        {t(
          'rektrs_pause_brand_explainer',
          'Pausing {{brand}} immediately pulls every queued post on its channels back to drafts and blocks scheduling and publishing until a manager resumes it. Approvals stay valid — resume restores the original publish dates.',
          { brand: brand.name }
        )}
      </div>
      <div className="flex flex-col gap-[6px]">
        <div className="text-[14px]">
          {t('rektrs_pause_reason', 'Reason (optional)')}
        </div>
        <div className="bg-newBgColorInner border-newTableBorder border rounded-[8px] flex items-center">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('rektrs_pause_reason_placeholder', 'e.g. Wrong creative went out')}
            className="h-[42px] bg-transparent outline-none flex-1 text-[14px] px-[16px]"
          />
        </div>
      </div>
      {error ? <div className="text-red-400 text-[13px]">{error}</div> : null}
      <div className="flex gap-[10px] justify-end">
        <Button type="button" secondary onClick={() => modal.closeCurrent()}>
          {t('cancel', 'Cancel')}
        </Button>
        <Button type="button" loading={busy} onClick={pause}>
          {t('rektrs_pause_brand', 'Pause brand')}
        </Button>
      </div>
    </div>
  );
};

/**
 * Kill-switch surface for one brand: a PAUSED banner (who / when / why)
 * with Resume for managers, or a Pause button opening the confirm modal.
 * Renders nothing for non-managers when the brand is live; the banner
 * itself stays visible to everyone so the state is never a surprise.
 */
const BrandKillSwitch: FC<{ brand: RektrsBrand }> = ({ brand }) => {
  const t = useT();
  const modal = useModals();
  const call = useRektrsCall();
  const toaster = useToaster();
  const { mutate } = useSWRConfig();
  const canManage = useHasRektrsFunction('MANAGER');
  const { nameOf } = useTeamMembers();
  const [busy, setBusy] = useState(false);

  const resume = useCallback(async () => {
    setBusy(true);
    try {
      const result = await call<RektrsBrandResumeResult>(
        `/rektrs/v1/brands/${brand.id}/resume`,
        { method: 'POST', body: {} }
      );
      await mutate('/rektrs/v1/brands');
      toaster.show(
        result.skipped.length
          ? t(
              'rektrs_brand_resumed_partial_toast',
              'Brand resumed — {{restored}} post(s) restored, {{skipped}} stayed drafts and need a look',
              {
                restored: String(result.restored.length),
                skipped: String(result.skipped.length),
              }
            )
          : t(
              'rektrs_brand_resumed_toast',
              'Brand resumed — {{restored}} post(s) restored to the queue',
              { restored: String(result.restored.length) }
            ),
        result.skipped.length ? 'warning' : 'success'
      );
    } catch (e) {
      toaster.show(
        readableRektrsError(e, t('rektrs_brand_resume_failed', 'Could not resume the brand')),
        'warning'
      );
    } finally {
      setBusy(false);
    }
  }, [brand.id, call, mutate, t, toaster]);

  const openPause = useCallback(() => {
    modal.openModal({
      title: t('rektrs_pause_brand', 'Pause brand'),
      withCloseButton: true,
      classNames: { modal: 'w-[100%] max-w-[520px] text-textColor' },
      children: <BrandPauseModal brand={brand} />,
    });
  }, [brand, modal, t]);

  if (brand.pausedAt) {
    return (
      <div className="border border-red-500/40 bg-red-500/10 rounded-[8px] p-[12px] flex flex-col gap-[6px]">
        <div className="text-[13px] font-[600] text-red-500">
          {t('rektrs_brand_paused_banner', 'PAUSED — nothing on this brand can be scheduled or published')}
        </div>
        <div className="text-[12px] opacity-80">
          {t('rektrs_brand_paused_since', 'Paused {{when}} by {{who}}', {
            when: formatDateTime(brand.pausedAt),
            who: nameOf(brand.pausedById),
          })}
          {brand.pauseReason ? ` — ${brand.pauseReason}` : ''}
        </div>
        {canManage ? (
          <div>
            <Button type="button" loading={busy} onClick={resume}>
              {t('rektrs_resume_brand', 'Resume brand')}
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  if (!canManage) {
    return null;
  }
  return (
    <div>
      <Button type="button" secondary onClick={openPause}>
        {t('rektrs_pause_brand', 'Pause brand')}
      </Button>
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
        <div className="border-t border-newTableBorder pt-[14px] flex flex-col gap-[14px]">
          <div className="flex flex-col gap-[6px]">
            <div className="text-[14px] font-[600]">
              {t('rektrs_brand_status', 'Brand status')}
            </div>
            <div className="text-[12px] opacity-60">
              {liveBrand.approvalRequired
                ? t(
                    'rektrs_brand_status_policy_on',
                    'Approval policy: ON — posts on this brand’s channels need an approved submission before scheduling.'
                  )
                : t(
                    'rektrs_brand_status_policy_off',
                    'Approval policy: OFF — posts on this brand’s channels can be scheduled without approval (unless the org-wide default applies).'
                  )}
            </div>
            <BrandKillSwitch brand={liveBrand} />
          </div>
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

  // W2 alert-chain knobs (local edit state; saved explicitly, not per keystroke)
  const [reminderHours, setReminderHours] = useState('');
  const [escalationHours, setEscalationHours] = useState('');
  useEffect(() => {
    if (settings) {
      setReminderHours(String(settings.alertReminderHours ?? 4));
      setEscalationHours(String(settings.alertEscalationHours ?? 12));
    }
  }, [settings?.alertReminderHours, settings?.alertEscalationHours]);

  const saveAlertHours = useCallback(async () => {
    const reminder = Number.parseInt(reminderHours, 10);
    const escalation = Number.parseInt(escalationHours, 10);
    if (
      !Number.isFinite(reminder) ||
      reminder < 1 ||
      reminder > 168 ||
      !Number.isFinite(escalation) ||
      escalation < 1 ||
      escalation > 720
    ) {
      toaster.show(
        t(
          'rektrs_alert_hours_invalid',
          'Reminder must be 1–168 hours and escalation 1–720 hours.'
        ),
        'warning'
      );
      return;
    }
    await patch({
      alertReminderHours: reminder,
      alertEscalationHours: escalation,
    });
  }, [reminderHours, escalationHours, patch, t, toaster]);

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
      <div className="border-t border-newTableBorder mt-[10px] pt-[12px]">
        <div className="text-[15px] font-[600] mb-[2px]">
          {t('rektrs_alert_settings_title', 'Approval alerts')}
        </div>
        <div className="text-[12px] opacity-60 max-w-[520px]">
          {t(
            'rektrs_alert_settings_hint',
            'Reviewers are alerted when a submission arrives and the maker is told the decision. A submission left undecided gets one reminder, then escalates to managers.'
          )}
        </div>
        <div className="flex flex-wrap items-end gap-[12px] py-[8px]">
          <div className="flex flex-col gap-[6px]">
            <div className="text-[14px]">
              {t('rektrs_alert_reminder_hours', 'Remind reviewers after (hours)')}
            </div>
            <div className="bg-newBgColorInner border-newTableBorder border rounded-[8px] flex items-center w-[120px]">
              <input
                type="number"
                min={1}
                max={168}
                disabled={!canManage || busy}
                value={reminderHours}
                onChange={(e) => setReminderHours(e.target.value)}
                className="h-[42px] bg-transparent outline-none flex-1 text-[14px] px-[16px] w-full"
              />
            </div>
          </div>
          <div className="flex flex-col gap-[6px]">
            <div className="text-[14px]">
              {t('rektrs_alert_escalation_hours', 'Escalate to managers after (hours)')}
            </div>
            <div className="bg-newBgColorInner border-newTableBorder border rounded-[8px] flex items-center w-[120px]">
              <input
                type="number"
                min={1}
                max={720}
                disabled={!canManage || busy}
                value={escalationHours}
                onChange={(e) => setEscalationHours(e.target.value)}
                className="h-[42px] bg-transparent outline-none flex-1 text-[14px] px-[16px] w-full"
              />
            </div>
          </div>
          {canManage ? (
            <Button
              type="button"
              secondary
              loading={busy}
              onClick={saveAlertHours}
            >
              {t('rektrs_alert_hours_save', 'Save alert timing')}
            </Button>
          ) : null}
        </div>
        <Toggle
          label={t('rektrs_alert_in_app', 'In-app alerts')}
          hint={t(
            'rektrs_alert_in_app_hint',
            'Show approval alerts in the app notification feed.'
          )}
          value={settings.alertInAppEnabled ?? true}
          onChange={(v) => patch({ alertInAppEnabled: v })}
        />
        <Toggle
          label={t('rektrs_alert_email', 'Email alerts')}
          hint={t(
            'rektrs_alert_email_hint',
            'Email reviewers, makers and managers about submissions awaiting them.'
          )}
          value={settings.alertEmailEnabled ?? true}
          onChange={(v) => patch({ alertEmailEnabled: v })}
        />
      </div>
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
                {brand.pausedAt ? (
                  <span className="ms-auto inline-flex rounded-full bg-red-500/15 text-red-500 px-[8px] py-[2px] text-[11px] font-[600] whitespace-nowrap">
                    {t('rektrs_paused_badge', 'Paused')}
                  </span>
                ) : brand.approvalRequired ? (
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
              <BrandKillSwitch brand={brand} />
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
