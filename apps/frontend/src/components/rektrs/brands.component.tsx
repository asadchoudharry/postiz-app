'use client';

import { FC, useCallback, useEffect, useMemo, useState } from 'react';
import { FormProvider, useForm, useFormContext } from 'react-hook-form';
import useSWR, { useSWRConfig } from 'swr';
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
  RektrsCrmWebhookTestResult,
  RektrsEvergreenActivity,
  RektrsEvergreenRunResult,
  RektrsEvergreenSettings,
  RektrsEvergreenStyleMode,
  RektrsInboxSettings,
  RektrsLeadRule,
  RektrsMilestoneCtaAction,
  RektrsMilestoneCtaActivity,
  RektrsMilestoneCtaRunResult,
  RektrsMilestoneCtaSettings,
  shortId,
  slugifyClient,
  useRektrsCall,
  useRektrsLoader,
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

/**
 * W1 — the brand's Comment-to-DM lead machine settings
 * (AUTOMATION-WORKFLOWS.md W1). Lives inside the brand edit modal next to
 * channels + kill-switch; the org-wide CRM endpoint it delivers to is set
 * in the OrgPolicyCard below. MANAGER configures; everyone else reads.
 */
const splitLeadList = (value: string) =>
  value
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

const BrandLeadAutomation: FC<{ brand: RektrsBrand }> = ({ brand }) => {
  const t = useT();
  const call = useRektrsCall();
  const load = useRektrsLoader();
  const toaster = useToaster();
  const canManage = useHasRektrsFunction('MANAGER');
  const { data: rule, mutate } = useSWR<RektrsLeadRule>(
    `/rektrs/v1/brands/${brand.id}/lead-rule`,
    load,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      refreshWhenHidden: false,
      refreshWhenOffline: false,
    }
  );
  const [enabled, setEnabled] = useState(false);
  const [keywords, setKeywords] = useState('');
  const [template, setTemplate] = useState('');
  const [guardWords, setGuardWords] = useState('');
  const [useDefaults, setUseDefaults] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (rule) {
      setEnabled(rule.enabled);
      setKeywords(rule.keywords.join(', '));
      setTemplate(rule.dmTemplate);
      setGuardWords(rule.guardWords.join(', '));
      setUseDefaults(rule.useDefaultGuardWords);
    }
  }, [rule]);

  const save = useCallback(async () => {
    setSaving(true);
    setError('');
    try {
      await call(`/rektrs/v1/brands/${brand.id}/lead-rule`, {
        method: 'PUT',
        ifMatch: rule?.version ?? undefined,
        body: {
          enabled,
          keywords: splitLeadList(keywords),
          dmTemplate: template,
          guardWords: splitLeadList(guardWords),
          useDefaultGuardWords: useDefaults,
        },
      });
      await mutate();
      toaster.show(
        t('rektrs_lead_rule_saved', 'Lead automation saved'),
        'success'
      );
    } catch (e) {
      setError(
        readableRektrsError(
          e,
          t('rektrs_lead_rule_save_failed', 'Could not save the lead automation')
        )
      );
    } finally {
      setSaving(false);
    }
  }, [brand.id, call, enabled, guardWords, keywords, mutate, rule?.version, t, template, toaster, useDefaults]);

  if (!rule) {
    return null;
  }

  const fieldLabel = 'text-[14px] font-[500]';
  const fieldHint = 'text-[12px] opacity-60';
  const inputCls =
    'bg-newBgColorInner border border-newTableBorder rounded-[8px] px-[16px] py-[10px] text-[14px] outline-none w-full disabled:opacity-50';

  return (
    <div className="flex flex-col gap-[10px]">
      <div className="flex items-start justify-between gap-[16px]">
        <div className="flex flex-col gap-[2px]">
          <div className="text-[14px] font-[600]">
            {t('rektrs_lead_automation', 'Lead automation (comment → DM)')}
          </div>
          <div className="text-[12px] opacity-60 max-w-[520px]">
            {t(
              'rektrs_lead_automation_hint',
              'When a comment on this brand’s Facebook or Instagram posts contains a keyword, the commenter gets a private DM and the lead is pushed to your CRM webhook (set under Organization approval policy). At most one DM per person per post.'
            )}
          </div>
        </div>
        <button
          type="button"
          disabled={!canManage}
          onClick={() => setEnabled(!enabled)}
          className={clsx(
            'relative w-[42px] h-[24px] rounded-full shrink-0 transition-colors',
            enabled ? 'bg-[#612bd3]' : 'bg-gray-400/40',
            !canManage && 'opacity-50 cursor-not-allowed'
          )}
          aria-pressed={enabled}
        >
          <span
            className={clsx(
              'absolute top-[3px] w-[18px] h-[18px] rounded-full bg-white transition-all',
              enabled ? 'start-[21px]' : 'start-[3px]'
            )}
          />
        </button>
      </div>
      <div className="flex flex-col gap-[6px]">
        <div className={fieldLabel}>
          {t('rektrs_lead_keywords', 'Keywords (comma separated)')}
        </div>
        <input
          className={inputCls}
          disabled={!canManage}
          value={keywords}
          onChange={(e) => setKeywords(e.target.value)}
          placeholder="price, order, booking"
        />
      </div>
      <div className="flex flex-col gap-[6px]">
        <div className={fieldLabel}>
          {t('rektrs_lead_dm_template', 'DM template')}
        </div>
        <textarea
          className={inputCls}
          disabled={!canManage}
          rows={3}
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          placeholder="Hi {{name}}! Thanks for asking about {{keyword}} — details here: {{link}}"
        />
        <div className={fieldHint}>
          {t(
            'rektrs_lead_dm_template_hint',
            'Placeholders: {{name}} the commenter, {{keyword}} what matched, {{link}} the post link.'
          )}
        </div>
      </div>
      <div className="flex flex-col gap-[6px]">
        <div className={fieldLabel}>
          {t('rektrs_lead_guard_words', 'Extra guard words (comma separated)')}
        </div>
        <input
          className={inputCls}
          disabled={!canManage}
          value={guardWords}
          onChange={(e) => setGuardWords(e.target.value)}
          placeholder=""
        />
        <div className={fieldHint}>
          {t(
            'rektrs_lead_guard_words_hint',
            'A comment matching a guard word is never auto-DMed — it goes to the human-review queue in Leads instead. Built-in defaults (refund, complaint, scam, fraud, lawyer, police + Urdu/Arabic equivalents) always apply unless you turn them off below.'
          )}
        </div>
        <label className="flex items-center gap-[8px] text-[13px] cursor-pointer w-fit">
          <input
            type="checkbox"
            disabled={!canManage}
            checked={useDefaults}
            onChange={(e) => setUseDefaults(e.target.checked)}
          />
          {t('rektrs_lead_use_default_guards', 'Use the built-in guard words')}
        </label>
      </div>
      {error ? <div className="text-red-400 text-[13px]">{error}</div> : null}
      {canManage ? (
        <div className="flex justify-end">
          <Button type="button" secondary loading={saving} onClick={save}>
            {t('rektrs_lead_rule_save', 'Save lead automation')}
          </Button>
        </div>
      ) : null}
    </div>
  );
};

/**
 * W3 — the brand's Evergreen Recycler settings + copies/run history
 * (AUTOMATION-WORKFLOWS.md W3). Lives inside the brand edit modal next to
 * lead automation; the org-wide weekly schedule lives in the OrgPolicyCard
 * below. MANAGER configures and runs; creators see the copies it made.
 * Copies are ordinary DRAFT posts — nothing here schedules or publishes.
 */
const BrandEvergreen: FC<{ brand: RektrsBrand }> = ({ brand }) => {
  const t = useT();
  const call = useRektrsCall();
  const load = useRektrsLoader();
  const toaster = useToaster();
  const canManage = useHasRektrsFunction('MANAGER');
  const canCreator = useHasRektrsFunction('CREATOR');
  const canAnalyst = useHasRektrsFunction('ANALYST');
  const canViewActivity = canManage || canCreator || canAnalyst;
  const { data: settings, mutate } = useSWR<RektrsEvergreenSettings>(
    `/rektrs/v1/brands/${brand.id}/evergreen`,
    load,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      refreshWhenHidden: false,
      refreshWhenOffline: false,
    }
  );
  const { data: activity, mutate: mutateActivity } =
    useSWR<RektrsEvergreenActivity>(
      canViewActivity
        ? `/rektrs/v1/brands/${brand.id}/evergreen/copies`
        : null,
      load,
      {
        revalidateOnFocus: false,
        revalidateOnReconnect: false,
        refreshWhenHidden: false,
        refreshWhenOffline: false,
      }
    );
  const [enabled, setEnabled] = useState(false);
  const [minAgeDays, setMinAgeDays] = useState('45');
  const [topN, setTopN] = useState('3');
  const [styleMode, setStyleMode] =
    useState<RektrsEvergreenStyleMode>('ROTATE');
  const [hookLines, setHookLines] = useState('');
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (settings) {
      setEnabled(settings.enabled);
      setMinAgeDays(String(settings.minAgeDays));
      setTopN(String(settings.topN));
      setStyleMode(settings.styleMode);
      setHookLines(settings.hookLines.join('\n'));
    }
  }, [settings]);

  const save = useCallback(async () => {
    const age = Number.parseInt(minAgeDays, 10);
    const n = Number.parseInt(topN, 10);
    if (
      !Number.isFinite(age) ||
      age < 1 ||
      age > 3650 ||
      !Number.isFinite(n) ||
      n < 1 ||
      n > 10
    ) {
      setError(
        t(
          'rektrs_evergreen_numbers_invalid',
          'Minimum age must be 1–3650 days and copies per run 1–10.'
        )
      );
      return;
    }
    setSaving(true);
    setError('');
    try {
      await call(`/rektrs/v1/brands/${brand.id}/evergreen`, {
        method: 'PUT',
        ifMatch: settings?.version ?? undefined,
        body: {
          enabled,
          minAgeDays: age,
          topN: n,
          styleMode,
          hookLines: hookLines
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
        },
      });
      await mutate();
      toaster.show(
        t('rektrs_evergreen_saved', 'Evergreen recycler saved'),
        'success'
      );
    } catch (e) {
      setError(
        readableRektrsError(
          e,
          t('rektrs_evergreen_save_failed', 'Could not save the evergreen recycler')
        )
      );
    } finally {
      setSaving(false);
    }
  }, [brand.id, call, enabled, hookLines, minAgeDays, mutate, settings?.version, styleMode, t, topN, toaster]);

  const runNow = useCallback(async () => {
    setRunning(true);
    setError('');
    try {
      const result = await call<RektrsEvergreenRunResult>(
        `/rektrs/v1/brands/${brand.id}/evergreen/run`,
        { method: 'POST' }
      );
      await mutateActivity();
      toaster.show(
        result.copiedCount > 0
          ? t(
              'rektrs_evergreen_run_done',
              'Evergreen run finished: {{copies}} new draft(s) created',
              { copies: String(result.copiedCount) }
            )
          : t(
              'rektrs_evergreen_run_empty',
              'Evergreen run finished: no post qualified this time (see run history)'
            ),
        'success'
      );
    } catch (e) {
      setError(
        readableRektrsError(
          e,
          t('rektrs_evergreen_run_failed', 'The evergreen run could not be started')
        )
      );
    } finally {
      setRunning(false);
    }
  }, [brand.id, call, mutateActivity, t, toaster]);

  if (!settings) {
    return null;
  }

  const fieldLabel = 'text-[14px] font-[500]';
  const fieldHint = 'text-[12px] opacity-60';
  const inputCls =
    'bg-newBgColorInner border border-newTableBorder rounded-[8px] px-[16px] py-[10px] text-[14px] outline-none w-full disabled:opacity-50';
  const metric = (v: number | null) => (v === null ? '—' : String(v));

  return (
    <div className="flex flex-col gap-[10px]">
      <div className="flex items-start justify-between gap-[16px]">
        <div className="flex flex-col gap-[2px]">
          <div className="text-[14px] font-[600]">
            {t('rektrs_evergreen', 'Evergreen recycler')}
          </div>
          <div className="text-[12px] opacity-60 max-w-[520px]">
            {t(
              'rektrs_evergreen_hint',
              'Once a week (schedule under Organization approval policy), this brand’s best-performing older posts are re-issued as refreshed DRAFT copies for your creators to edit and schedule. Nothing is ever auto-published — the normal approval flow applies when a copy is scheduled.'
            )}
          </div>
        </div>
        <button
          type="button"
          disabled={!canManage}
          onClick={() => setEnabled(!enabled)}
          className={clsx(
            'relative w-[42px] h-[24px] rounded-full shrink-0 transition-colors',
            enabled ? 'bg-[#612bd3]' : 'bg-gray-400/40',
            !canManage && 'opacity-50 cursor-not-allowed'
          )}
          aria-pressed={enabled}
        >
          <span
            className={clsx(
              'absolute top-[3px] w-[18px] h-[18px] rounded-full bg-white transition-all',
              enabled ? 'start-[21px]' : 'start-[3px]'
            )}
          />
        </button>
      </div>
      <div className="flex flex-wrap gap-[12px]">
        <div className="flex flex-col gap-[6px] w-[160px]">
          <div className={fieldLabel}>
            {t('rektrs_evergreen_min_age', 'Minimum post age (days)')}
          </div>
          <input
            type="number"
            min={1}
            max={3650}
            className={inputCls}
            disabled={!canManage}
            value={minAgeDays}
            onChange={(e) => setMinAgeDays(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-[6px] w-[160px]">
          <div className={fieldLabel}>
            {t('rektrs_evergreen_top_n', 'Copies per run')}
          </div>
          <input
            type="number"
            min={1}
            max={10}
            className={inputCls}
            disabled={!canManage}
            value={topN}
            onChange={(e) => setTopN(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-[6px] w-[200px]">
          <div className={fieldLabel}>
            {t('rektrs_evergreen_style', 'Refresh style')}
          </div>
          <select
            className={inputCls}
            disabled={!canManage}
            value={styleMode}
            onChange={(e) =>
              setStyleMode(e.target.value as RektrsEvergreenStyleMode)
            }
          >
            <option value="ROTATE">
              {t('rektrs_evergreen_style_rotate', 'Rotate verbatim / hook')}
            </option>
            <option value="VERBATIM">
              {t('rektrs_evergreen_style_verbatim', 'Verbatim copy')}
            </option>
            <option value="HOOK">
              {t('rektrs_evergreen_style_hook', 'Always prepend a hook line')}
            </option>
          </select>
        </div>
      </div>
      <div className="flex flex-col gap-[6px]">
        <div className={fieldLabel}>
          {t('rektrs_evergreen_hook_lines', 'Hook lines (one per line)')}
        </div>
        <textarea
          className={inputCls}
          disabled={!canManage}
          rows={3}
          value={hookLines}
          onChange={(e) => setHookLines(e.target.value)}
          placeholder={'Throwback Thursday!\nThis one is still true today:'}
        />
        <div className={fieldHint}>
          {t(
            'rektrs_evergreen_hook_lines_hint',
            'A hook line is prepended to the copy as its own paragraph. Media is always carried over unchanged; only the post text is refreshed.'
          )}
        </div>
      </div>
      {error ? <div className="text-red-400 text-[13px]">{error}</div> : null}
      {canManage ? (
        <div className="flex justify-end gap-[10px]">
          <Button
            type="button"
            secondary
            loading={running}
            disabled={!settings.enabled}
            onClick={runNow}
          >
            {t('rektrs_evergreen_run_now', 'Run now')}
          </Button>
          <Button type="button" secondary loading={saving} onClick={save}>
            {t('rektrs_evergreen_save', 'Save evergreen recycler')}
          </Button>
        </div>
      ) : null}
      {canViewActivity && activity && activity.copies.length ? (
        <div className="flex flex-col gap-[6px]">
          <div className={fieldLabel}>
            {t('rektrs_evergreen_copies', 'Recycled drafts')}
          </div>
          <div className="flex flex-col divide-y divide-newTableBorder border border-newTableBorder rounded-[8px]">
            {activity.copies.slice(0, 10).map((copy) => (
              <div
                key={copy.id}
                className="flex flex-wrap items-center gap-x-[10px] gap-y-[2px] px-[12px] py-[8px] text-[12px]"
              >
                <span className="inline-flex rounded-full bg-[#612bd3]/15 text-[#8b5cf6] px-[8px] py-[2px] text-[11px] font-[600]">
                  {copy.style === 'HOOK'
                    ? t('rektrs_evergreen_style_hook_badge', 'Hook')
                    : t('rektrs_evergreen_style_verbatim_badge', 'Verbatim')}
                </span>
                <span className="opacity-70">
                  {shortId(copy.sourcePostId)} → {shortId(copy.copyPostId)}
                </span>
                <span className="opacity-70">
                  {t('rektrs_evergreen_metrics', '♥ {{likes}} · 💬 {{comments}} · ↗ {{shares}} · score {{score}}', {
                    likes: metric(copy.metrics.likes),
                    comments: metric(copy.metrics.comments),
                    shares: metric(copy.metrics.shares),
                    score: String(copy.metrics.score),
                  })}
                </span>
                <span className="ms-auto opacity-50">
                  {formatDateTime(copy.createdAt)}
                </span>
                {copy.hookLine ? (
                  <div className="w-full opacity-60 truncate">
                    “{copy.hookLine}”
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {canViewActivity && activity && activity.runs.length ? (
        <div className="flex flex-col gap-[6px]">
          <div className={fieldLabel}>
            {t('rektrs_evergreen_runs', 'Run history')}
          </div>
          <div className="flex flex-col gap-[4px] text-[12px] opacity-80">
            {activity.runs.slice(0, 5).map((run) => (
              <div key={run.id} className="flex flex-wrap gap-x-[10px]">
                <span>{formatDateTime(run.startedAt)}</span>
                <span>
                  {run.trigger === 'MANUAL'
                    ? t('rektrs_evergreen_trigger_manual', 'Manual')
                    : t('rektrs_evergreen_trigger_scheduled', 'Scheduled')}
                </span>
                <span>
                  {t('rektrs_evergreen_run_summary', 'scanned {{scanned}} · copied {{copied}}', {
                    scanned: String(run.scannedCount),
                    copied: String(run.copiedCount),
                  })}
                </span>
                {run.skippedReasons &&
                Object.keys(run.skippedReasons.counts).length ? (
                  <span className="opacity-60">
                    {Object.entries(run.skippedReasons.counts)
                      .map(([reason, n]) => `${reason} ×${n}`)
                      .join(' · ')}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
};

/**
 * W4 — the brand's Milestone Auto-CTA settings + activity
 * (AUTOMATION-WORKFLOWS.md W4). Lives inside the brand edit modal next to
 * the evergreen recycler. When a published post (last 30 days) crosses
 * the like threshold, the CTA below is posted as a first comment — once
 * per post. Channels that cannot post comments (e.g. YouTube, TikTok)
 * are skipped and the run history says so. MANAGER configures and runs.
 */
const BrandMilestoneCta: FC<{ brand: RektrsBrand }> = ({ brand }) => {
  const t = useT();
  const call = useRektrsCall();
  const load = useRektrsLoader();
  const toaster = useToaster();
  const canManage = useHasRektrsFunction('MANAGER');
  const canCreator = useHasRektrsFunction('CREATOR');
  const canAnalyst = useHasRektrsFunction('ANALYST');
  const canViewActivity = canManage || canCreator || canAnalyst;
  const { data: settings, mutate } = useSWR<RektrsMilestoneCtaSettings>(
    `/rektrs/v1/brands/${brand.id}/milestone-cta`,
    load,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      refreshWhenHidden: false,
      refreshWhenOffline: false,
    }
  );
  const { data: activity, mutate: mutateActivity } =
    useSWR<RektrsMilestoneCtaActivity>(
      canViewActivity
        ? `/rektrs/v1/brands/${brand.id}/milestone-cta/activity`
        : null,
      load,
      {
        revalidateOnFocus: false,
        revalidateOnReconnect: false,
        refreshWhenHidden: false,
        refreshWhenOffline: false,
      }
    );
  const [enabled, setEnabled] = useState(false);
  const [likeThreshold, setLikeThreshold] = useState('20');
  const [ctaText, setCtaText] = useState('');
  const [ctaUrl, setCtaUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (settings) {
      setEnabled(settings.enabled);
      setLikeThreshold(String(settings.likeThreshold));
      setCtaText(settings.ctaText);
      setCtaUrl(settings.ctaUrl);
    }
  }, [settings]);

  const save = useCallback(async () => {
    const threshold = Number.parseInt(likeThreshold, 10);
    if (!Number.isFinite(threshold) || threshold < 1 || threshold > 1000000) {
      setError(
        t(
          'rektrs_milestone_cta_threshold_invalid',
          'The like threshold must be between 1 and 1,000,000.'
        )
      );
      return;
    }
    const url = ctaUrl.trim();
    if (url && !/^https?:\/\//i.test(url)) {
      setError(
        t(
          'rektrs_milestone_cta_url_invalid',
          'The CTA link must start with http:// or https://.'
        )
      );
      return;
    }
    setSaving(true);
    setError('');
    try {
      await call(`/rektrs/v1/brands/${brand.id}/milestone-cta`, {
        method: 'PUT',
        ifMatch: settings?.version ?? undefined,
        body: {
          enabled,
          likeThreshold: threshold,
          ctaText: ctaText.trim(),
          ctaUrl: url,
        },
      });
      await mutate();
      toaster.show(
        t('rektrs_milestone_cta_saved', 'Milestone auto-CTA saved'),
        'success'
      );
    } catch (e) {
      setError(
        readableRektrsError(
          e,
          t('rektrs_milestone_cta_save_failed', 'Could not save the milestone auto-CTA')
        )
      );
    } finally {
      setSaving(false);
    }
  }, [brand.id, call, ctaText, ctaUrl, enabled, likeThreshold, mutate, settings?.version, t, toaster]);

  const runNow = useCallback(async () => {
    setRunning(true);
    setError('');
    try {
      const result = await call<RektrsMilestoneCtaRunResult>(
        `/rektrs/v1/brands/${brand.id}/milestone-cta/run`,
        { method: 'POST' }
      );
      await mutateActivity();
      toaster.show(
        result.postedCount > 0
          ? t(
              'rektrs_milestone_cta_run_done',
              'Milestone CTA run finished: {{posted}} CTA comment(s) posted',
              { posted: String(result.postedCount) }
            )
          : t(
              'rektrs_milestone_cta_run_empty',
              'Milestone CTA run finished: no post crossed the threshold this time (see run history)'
            ),
        'success'
      );
    } catch (e) {
      setError(
        readableRektrsError(
          e,
          t('rektrs_milestone_cta_run_failed', 'The milestone CTA run could not be started')
        )
      );
    } finally {
      setRunning(false);
    }
  }, [brand.id, call, mutateActivity, t, toaster]);

  if (!settings) {
    return null;
  }

  const fieldLabel = 'text-[14px] font-[500]';
  const fieldHint = 'text-[12px] opacity-60';
  const inputCls =
    'bg-newBgColorInner border border-newTableBorder rounded-[8px] px-[16px] py-[10px] text-[14px] outline-none w-full disabled:opacity-50';

  const statusBadge = (status: RektrsMilestoneCtaAction['status']) =>
    status === 'CTA_POSTED'
      ? 'bg-emerald-500/15 text-emerald-500'
      : status === 'CTA_FAILED'
        ? 'bg-amber-500/15 text-amber-500'
        : 'bg-red-500/15 text-red-400';
  const statusLabel = (status: RektrsMilestoneCtaAction['status']) =>
    status === 'CTA_POSTED'
      ? t('rektrs_milestone_cta_status_posted', 'Posted')
      : status === 'CTA_FAILED'
        ? t('rektrs_milestone_cta_status_failed', 'Failed — will retry')
        : t('rektrs_milestone_cta_status_exhausted', 'Failed — retries exhausted');

  return (
    <div className="flex flex-col gap-[10px]">
      <div className="flex items-start justify-between gap-[16px]">
        <div className="flex flex-col gap-[2px]">
          <div className="text-[14px] font-[600]">
            {t('rektrs_milestone_cta', 'Milestone auto-CTA')}
          </div>
          <div className="text-[12px] opacity-60 max-w-[520px]">
            {t(
              'rektrs_milestone_cta_hint',
              'Checked hourly: when one of this brand’s posts from the last 30 days reaches the like threshold, the CTA below is posted as a first comment — once per post, never twice. Channels that cannot post comments (YouTube, TikTok) are skipped and the run history says so.'
            )}
          </div>
        </div>
        <button
          type="button"
          disabled={!canManage}
          onClick={() => setEnabled(!enabled)}
          className={clsx(
            'relative w-[42px] h-[24px] rounded-full shrink-0 transition-colors',
            enabled ? 'bg-[#612bd3]' : 'bg-gray-400/40',
            !canManage && 'opacity-50 cursor-not-allowed'
          )}
          aria-pressed={enabled}
        >
          <span
            className={clsx(
              'absolute top-[3px] w-[18px] h-[18px] rounded-full bg-white transition-all',
              enabled ? 'start-[21px]' : 'start-[3px]'
            )}
          />
        </button>
      </div>
      <div className="flex flex-wrap gap-[12px]">
        <div className="flex flex-col gap-[6px] w-[160px]">
          <div className={fieldLabel}>
            {t('rektrs_milestone_cta_threshold', 'Like threshold')}
          </div>
          <input
            type="number"
            min={1}
            max={1000000}
            className={inputCls}
            disabled={!canManage}
            value={likeThreshold}
            onChange={(e) => setLikeThreshold(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-[6px] flex-1 min-w-[220px]">
          <div className={fieldLabel}>
            {t('rektrs_milestone_cta_url', 'CTA link')}
          </div>
          <input
            type="url"
            className={inputCls}
            disabled={!canManage}
            value={ctaUrl}
            onChange={(e) => setCtaUrl(e.target.value)}
            placeholder="https://example.com/guide"
          />
        </div>
      </div>
      <div className="flex flex-col gap-[6px]">
        <div className={fieldLabel}>
          {t('rektrs_milestone_cta_text', 'CTA text')}
        </div>
        <input
          type="text"
          className={inputCls}
          disabled={!canManage}
          value={ctaText}
          onChange={(e) => setCtaText(e.target.value)}
          placeholder={t(
            'rektrs_milestone_cta_text_placeholder',
            'Loved this? Get the full guide here:'
          )}
        />
        <div className={fieldHint}>
          {t(
            'rektrs_milestone_cta_text_hint',
            'The comment is the CTA text followed by the link, posted exactly as written (links are not shortened yet).'
          )}
        </div>
      </div>
      {error ? <div className="text-red-400 text-[13px]">{error}</div> : null}
      {canManage ? (
        <div className="flex justify-end gap-[10px]">
          <Button
            type="button"
            secondary
            loading={running}
            disabled={!settings.enabled}
            onClick={runNow}
          >
            {t('rektrs_milestone_cta_run_now', 'Run now')}
          </Button>
          <Button type="button" secondary loading={saving} onClick={save}>
            {t('rektrs_milestone_cta_save', 'Save milestone auto-CTA')}
          </Button>
        </div>
      ) : null}
      {canViewActivity && activity && activity.actions.length ? (
        <div className="flex flex-col gap-[6px]">
          <div className={fieldLabel}>
            {t('rektrs_milestone_cta_actions', 'CTA activity')}
          </div>
          <div className="flex flex-col divide-y divide-newTableBorder border border-newTableBorder rounded-[8px]">
            {activity.actions.slice(0, 10).map((action) => (
              <div
                key={action.id}
                className="flex flex-wrap items-center gap-x-[10px] gap-y-[2px] px-[12px] py-[8px] text-[12px]"
              >
                <span
                  className={clsx(
                    'inline-flex rounded-full px-[8px] py-[2px] text-[11px] font-[600]',
                    statusBadge(action.status)
                  )}
                >
                  {statusLabel(action.status)}
                </span>
                <span className="opacity-70">
                  {shortId(action.postId)} · {action.providerIdentifier}
                </span>
                <span className="opacity-70">
                  {t('rektrs_milestone_cta_action_meta', '♥ {{likes}} at check · attempt {{attempts}}', {
                    likes: action.likesAtCheck === null ? '—' : String(action.likesAtCheck),
                    attempts: String(action.attempts),
                  })}
                </span>
                <span className="ms-auto opacity-50">
                  {formatDateTime(action.postedAt || action.updatedAt)}
                </span>
                {action.error ? (
                  <div className="w-full text-red-400/80 truncate">
                    {action.error}
                  </div>
                ) : (
                  <div className="w-full opacity-60 truncate">
                    “{action.commentText}”
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {canViewActivity && activity && activity.runs.length ? (
        <div className="flex flex-col gap-[6px]">
          <div className={fieldLabel}>
            {t('rektrs_milestone_cta_runs', 'Run history')}
          </div>
          <div className="flex flex-col gap-[4px] text-[12px] opacity-80">
            {activity.runs.slice(0, 5).map((run) => (
              <div key={run.id} className="flex flex-wrap gap-x-[10px]">
                <span>{formatDateTime(run.startedAt)}</span>
                <span>
                  {run.trigger === 'MANUAL'
                    ? t('rektrs_milestone_cta_trigger_manual', 'Manual')
                    : t('rektrs_milestone_cta_trigger_scheduled', 'Scheduled')}
                </span>
                <span>
                  {t('rektrs_milestone_cta_run_summary', 'scanned {{scanned}} · posted {{posted}}', {
                    scanned: String(run.scannedCount),
                    posted: String(run.postedCount),
                  })}
                </span>
                {run.skippedReasons &&
                Object.keys(run.skippedReasons.counts).length ? (
                  <span className="opacity-60">
                    {Object.entries(run.skippedReasons.counts)
                      .map(([reason, n]) => `${reason} ×${n}`)
                      .join(' · ')}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
};

/**
 * W6 — the brand's Inbox Triage settings (AUTOMATION-WORKFLOWS.md W6).
 * Lives inside the brand edit modal under the milestone auto-CTA. When
 * enabled, new comments on this brand's channels are classified
 * (complaint → human queue + alert; FAQ → suggested-reply draft;
 * everything else listed), translated into the working language when a
 * translation provider is configured, and listed on the Inbox screen.
 * Nothing is ever auto-sent — a human sends drafts from the inbox.
 * MANAGER configures.
 */
const BrandInboxTriage: FC<{ brand: RektrsBrand }> = ({ brand }) => {
  const t = useT();
  const call = useRektrsCall();
  const load = useRektrsLoader();
  const toaster = useToaster();
  const canManage = useHasRektrsFunction('MANAGER');
  const { data: settings, mutate } = useSWR<RektrsInboxSettings>(
    `/rektrs/v1/brands/${brand.id}/inbox-triage`,
    load,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      refreshWhenHidden: false,
      refreshWhenOffline: false,
    }
  );
  const [enabled, setEnabled] = useState(false);
  const [workingLanguage, setWorkingLanguage] = useState('en');
  const [faqPrice, setFaqPrice] = useState('');
  const [faqTiming, setFaqTiming] = useState('');
  const [faqLocation, setFaqLocation] = useState('');
  const [faqDelivery, setFaqDelivery] = useState('');
  const [extraKeywords, setExtraKeywords] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (settings) {
      setEnabled(settings.enabled);
      setWorkingLanguage(settings.workingLanguage);
      setFaqPrice(settings.faqPrice);
      setFaqTiming(settings.faqTiming);
      setFaqLocation(settings.faqLocation);
      setFaqDelivery(settings.faqDelivery);
      setExtraKeywords((settings.extraComplaintKeywords || []).join('\n'));
    }
  }, [settings]);

  const save = useCallback(async () => {
    setSaving(true);
    setError('');
    try {
      await call(`/rektrs/v1/brands/${brand.id}/inbox-triage`, {
        method: 'PUT',
        ifMatch: settings?.version ?? undefined,
        body: {
          enabled,
          workingLanguage,
          faqPrice: faqPrice.trim(),
          faqTiming: faqTiming.trim(),
          faqLocation: faqLocation.trim(),
          faqDelivery: faqDelivery.trim(),
          extraComplaintKeywords: extraKeywords
            .split(/[\n,]+/)
            .map((k) => k.trim())
            .filter(Boolean),
        },
      });
      await mutate();
      toaster.show(
        t('rektrs_inbox_triage_saved', 'Inbox triage saved'),
        'success'
      );
    } catch (e) {
      setError(
        readableRektrsError(
          e,
          t('rektrs_inbox_triage_save_failed', 'Could not save the inbox triage settings')
        )
      );
    } finally {
      setSaving(false);
    }
  }, [brand.id, call, enabled, extraKeywords, faqDelivery, faqLocation, faqPrice, faqTiming, mutate, settings?.version, t, toaster, workingLanguage]);

  if (!settings) {
    return null;
  }

  const fieldLabel = 'text-[14px] font-[500]';
  const fieldHint = 'text-[12px] opacity-60';
  const inputCls =
    'bg-newBgColorInner border border-newTableBorder rounded-[8px] px-[16px] py-[10px] text-[14px] outline-none w-full disabled:opacity-50';

  const templateField = (
    label: string,
    value: string,
    setValue: (v: string) => void,
    placeholder: string
  ) => (
    <div className="flex flex-col gap-[6px]">
      <div className={fieldLabel}>{label}</div>
      <textarea
        className={inputCls}
        rows={2}
        disabled={!canManage}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );

  return (
    <div className="flex flex-col gap-[10px]">
      <div className="flex items-start justify-between gap-[16px]">
        <div className="flex flex-col gap-[2px]">
          <div className="text-[14px] font-[600]">
            {t('rektrs_inbox_triage', 'Inbox triage')}
          </div>
          <div className="text-[12px] opacity-60 max-w-[520px]">
            {t(
              'rektrs_inbox_triage_hint',
              'New comments on this brand’s channels are sorted automatically: complaints go to the inbox queue and alert managers, FAQ questions (price, timing, location, delivery) get a suggested reply drafted from your templates below, and everything is translated into the working language when a translation provider is configured. Nothing is ever auto-sent — a person sends each draft from the Inbox screen.'
            )}
          </div>
        </div>
        <button
          type="button"
          disabled={!canManage}
          onClick={() => setEnabled(!enabled)}
          className={clsx(
            'relative w-[42px] h-[24px] rounded-full shrink-0 transition-colors',
            enabled ? 'bg-[#612bd3]' : 'bg-gray-400/40',
            !canManage && 'opacity-50 cursor-not-allowed'
          )}
          aria-pressed={enabled}
        >
          <span
            className={clsx(
              'absolute top-[3px] w-[18px] h-[18px] rounded-full bg-white transition-all',
              enabled ? 'start-[21px]' : 'start-[3px]'
            )}
          />
        </button>
      </div>
      <div className="flex flex-col gap-[6px] w-[220px]">
        <div className={fieldLabel}>
          {t('rektrs_inbox_working_language', 'Working language')}
        </div>
        <select
          className={inputCls}
          disabled={!canManage}
          value={workingLanguage}
          onChange={(e) => setWorkingLanguage(e.target.value)}
        >
          <option value="en">English</option>
          <option value="ur">Urdu (اردو)</option>
          <option value="ar">Arabic (العربية)</option>
          <option value="ur-Latn">Roman Urdu</option>
        </select>
        <div className={fieldHint}>
          {t(
            'rektrs_inbox_working_language_hint',
            'Comments in other languages are translated into this one in the inbox.'
          )}
        </div>
      </div>
      {templateField(
        t('rektrs_inbox_faq_price', 'FAQ reply — Price'),
        faqPrice,
        setFaqPrice,
        t('rektrs_inbox_faq_price_placeholder', 'Hi {name}, our prices start at Rs 500. — {brandName}')
      )}
      {templateField(
        t('rektrs_inbox_faq_timing', 'FAQ reply — Timing'),
        faqTiming,
        setFaqTiming,
        t('rektrs_inbox_faq_timing_placeholder', 'Hi {name}, we are open 9am–9pm, Monday to Saturday.')
      )}
      {templateField(
        t('rektrs_inbox_faq_location', 'FAQ reply — Location'),
        faqLocation,
        setFaqLocation,
        t('rektrs_inbox_faq_location_placeholder', 'Hi {name}, find us at Main Bazaar Road — directions: …')
      )}
      {templateField(
        t('rektrs_inbox_faq_delivery', 'FAQ reply — Delivery'),
        faqDelivery,
        setFaqDelivery,
        t('rektrs_inbox_faq_delivery_placeholder', 'Hi {name}, yes — home delivery is available in 2–3 days.')
      )}
      <div className="flex flex-col gap-[6px]">
        <div className={fieldLabel}>
          {t('rektrs_inbox_extra_keywords', 'Extra complaint words')}
        </div>
        <textarea
          className={inputCls}
          rows={2}
          disabled={!canManage}
          value={extraKeywords}
          onChange={(e) => setExtraKeywords(e.target.value)}
          placeholder={t(
            'rektrs_inbox_extra_keywords_placeholder',
            'One per line — added to the built-in complaint words (refund, fraud, scam, …)'
          )}
        />
        <div className={fieldHint}>
          {t(
            'rektrs_inbox_template_hint',
            'Templates can use {name} (the commenter) and {brandName}. A topic with an empty template still classifies — the comment lands in the inbox without a draft.'
          )}
        </div>
      </div>
      {error ? <div className="text-red-400 text-[13px]">{error}</div> : null}
      {canManage ? (
        <div className="flex justify-end gap-[10px]">
          <Button type="button" secondary loading={saving} onClick={save}>
            {t('rektrs_inbox_triage_save', 'Save inbox triage')}
          </Button>
        </div>
      ) : null}
    </div>
  );
};

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
          <BrandLeadAutomation brand={liveBrand} />
          <BrandEvergreen brand={liveBrand} />
          <BrandMilestoneCta brand={liveBrand} />
          <BrandInboxTriage brand={liveBrand} />
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

  // W1 CRM webhook knobs (URL saved explicitly; secret is write-only — the
  // field starts empty and only sends when the manager types a new one).
  const [crmUrl, setCrmUrl] = useState('');
  const [crmSecret, setCrmSecret] = useState('');
  const [crmTest, setCrmTest] = useState<RektrsCrmWebhookTestResult | null>(
    null
  );
  const [crmTesting, setCrmTesting] = useState(false);
  useEffect(() => {
    if (settings) {
      setCrmUrl(settings.crmWebhookUrl || '');
    }
  }, [settings?.crmWebhookUrl]);

  const saveCrm = useCallback(async () => {
    await patch({
      crmWebhookUrl: crmUrl.trim() || null,
      ...(crmSecret ? { crmWebhookSecret: crmSecret } : {}),
    });
    setCrmSecret('');
  }, [crmUrl, crmSecret, patch]);

  // W3 evergreen weekly schedule (UTC — organizations have no timezone
  // setting yet; the labels say UTC so nobody guesses otherwise).
  const [egWeekday, setEgWeekday] = useState('1');
  const [egHour, setEgHour] = useState('6');
  useEffect(() => {
    if (settings) {
      setEgWeekday(String(settings.evergreenWeekday ?? 1));
      setEgHour(String(settings.evergreenHour ?? 6));
    }
  }, [settings?.evergreenWeekday, settings?.evergreenHour]);

  const saveEvergreenSchedule = useCallback(async () => {
    const weekday = Number.parseInt(egWeekday, 10);
    const hour = Number.parseInt(egHour, 10);
    if (
      !Number.isFinite(weekday) ||
      weekday < 0 ||
      weekday > 6 ||
      !Number.isFinite(hour) ||
      hour < 0 ||
      hour > 23
    ) {
      toaster.show(
        t(
          'rektrs_evergreen_schedule_invalid',
          'Pick a weekday and an hour between 0 and 23'
        ),
        'warning'
      );
      return;
    }
    await patch({ evergreenWeekday: weekday, evergreenHour: hour });
  }, [egWeekday, egHour, patch, t, toaster]);

  const testCrm = useCallback(async () => {
    setCrmTesting(true);
    setCrmTest(null);
    try {
      const result = await call<RektrsCrmWebhookTestResult>(
        '/rektrs/v1/org/crm-webhook/test',
        { method: 'POST' }
      );
      setCrmTest(result);
    } catch (e) {
      setCrmTest({
        ok: false,
        error: readableRektrsError(
          e,
          t('rektrs_crm_test_failed', 'The test ping could not be sent')
        ),
      });
    } finally {
      setCrmTesting(false);
    }
  }, [call, t]);

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
      <div className="border-t border-newTableBorder mt-[10px] pt-[12px]">
        <div className="text-[15px] font-[600] mb-[2px]">
          {t('rektrs_crm_webhook_title', 'Lead delivery (CRM webhook)')}
        </div>
        <div className="text-[12px] opacity-60 max-w-[520px]">
          {t(
            'rektrs_crm_webhook_hint',
            'New leads from the comment-to-DM automation are pushed to this endpoint (Operqon or any CRM) as signed webhooks. Delivery is retried automatically; failures stay visible in Leads.'
          )}
        </div>
        <Toggle
          label={t('rektrs_crm_webhook_enabled', 'Send leads to the CRM webhook')}
          hint={t(
            'rektrs_crm_webhook_enabled_hint',
            'When off, leads are still captured and DMs still sent — only the CRM push is paused.'
          )}
          value={settings.crmWebhookEnabled ?? false}
          onChange={(v) => patch({ crmWebhookEnabled: v })}
        />
        <div className="flex flex-col gap-[6px] py-[8px]">
          <div className="text-[14px]">
            {t('rektrs_crm_webhook_url', 'Webhook URL (HTTPS)')}
          </div>
          <div className="bg-newBgColorInner border-newTableBorder border rounded-[8px] flex items-center max-w-[520px]">
            <input
              type="url"
              disabled={!canManage || busy}
              value={crmUrl}
              onChange={(e) => setCrmUrl(e.target.value)}
              placeholder="https://crm.example.com/hooks/rektrs-leads"
              className="h-[42px] bg-transparent outline-none flex-1 text-[14px] px-[16px] w-full"
            />
          </div>
        </div>
        <div className="flex flex-col gap-[6px] py-[8px]">
          <div className="text-[14px]">
            {t('rektrs_crm_webhook_secret', 'Signing secret')}
          </div>
          <div className="flex items-center gap-[12px]">
            <div className="bg-newBgColorInner border-newTableBorder border rounded-[8px] flex items-center w-[320px]">
              <input
                type="password"
                autoComplete="new-password"
                disabled={!canManage || busy}
                value={crmSecret}
                onChange={(e) => setCrmSecret(e.target.value)}
                placeholder={
                  settings.crmWebhookSecretSet
                    ? t('rektrs_crm_secret_set_placeholder', 'A secret is set — type to replace it')
                    : t('rektrs_crm_secret_unset_placeholder', 'No secret set yet')
                }
                className="h-[42px] bg-transparent outline-none flex-1 text-[14px] px-[16px] w-full"
              />
            </div>
            {settings.crmWebhookSecretSet ? (
              <span className="inline-flex rounded-full bg-emerald-500/15 text-emerald-600 px-[8px] py-[2px] text-[11px] font-[600]">
                {t('rektrs_crm_secret_set', 'Secret set')}
              </span>
            ) : null}
            {canManage && settings.crmWebhookSecretSet ? (
              <button
                type="button"
                className="text-[12px] opacity-60 hover:opacity-100"
                disabled={busy}
                onClick={() => patch({ clearCrmWebhookSecret: true })}
              >
                {t('rektrs_crm_secret_clear', 'Clear secret')}
              </button>
            ) : null}
          </div>
          <div className="text-[12px] opacity-60 max-w-[520px]">
            {t(
              'rektrs_crm_secret_hint',
              'The secret never leaves the server — it signs each delivery (X-Rektrs-Signature) so your CRM can verify the lead really came from REKTRS Social.'
            )}
          </div>
        </div>
        {canManage ? (
          <div className="flex flex-wrap gap-[10px] py-[8px]">
            <Button type="button" secondary loading={busy} onClick={saveCrm}>
              {t('rektrs_crm_save', 'Save CRM webhook')}
            </Button>
            <Button type="button" secondary loading={crmTesting} onClick={testCrm}>
              {t('rektrs_crm_test', 'Send test ping')}
            </Button>
            {crmTest ? (
              <span
                className={clsx(
                  'inline-flex items-center rounded-full px-[10px] py-[3px] text-[12px] font-[600]',
                  crmTest.ok
                    ? 'bg-emerald-500/15 text-emerald-600'
                    : 'bg-red-500/15 text-red-500'
                )}
              >
                {crmTest.ok
                  ? `${t('rektrs_crm_test_ok', 'Delivered')} · HTTP ${crmTest.status}`
                  : `${t('rektrs_crm_test_not_ok', 'Not delivered')}${
                      crmTest.status ? ` · HTTP ${crmTest.status}` : ''
                    }${crmTest.error ? ` · ${crmTest.error}` : ''}`}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="border-t border-newTableBorder mt-[10px] pt-[12px]">
        <div className="text-[15px] font-[600] mb-[2px]">
          {t('rektrs_evergreen_schedule_title', 'Evergreen recycler schedule')}
        </div>
        <div className="text-[12px] opacity-60 max-w-[520px]">
          {t(
            'rektrs_evergreen_schedule_hint',
            'When the evergreen recycler runs each week for brands that enabled it (per-brand settings live in the brand editor). Times are UTC — organizations do not have a timezone setting yet.'
          )}
        </div>
        <div className="flex flex-wrap items-end gap-[12px] py-[8px]">
          <div className="flex flex-col gap-[6px]">
            <div className="text-[14px]">
              {t('rektrs_evergreen_weekday', 'Weekday (UTC)')}
            </div>
            <div className="bg-newBgColorInner border-newTableBorder border rounded-[8px] flex items-center w-[160px]">
              <select
                disabled={!canManage || busy}
                value={egWeekday}
                onChange={(e) => setEgWeekday(e.target.value)}
                className="h-[42px] bg-transparent outline-none flex-1 text-[14px] px-[12px] w-full"
              >
                {[
                  ['1', t('rektrs_weekday_monday', 'Monday')],
                  ['2', t('rektrs_weekday_tuesday', 'Tuesday')],
                  ['3', t('rektrs_weekday_wednesday', 'Wednesday')],
                  ['4', t('rektrs_weekday_thursday', 'Thursday')],
                  ['5', t('rektrs_weekday_friday', 'Friday')],
                  ['6', t('rektrs_weekday_saturday', 'Saturday')],
                  ['0', t('rektrs_weekday_sunday', 'Sunday')],
                ].map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex flex-col gap-[6px]">
            <div className="text-[14px]">
              {t('rektrs_evergreen_hour', 'Hour (UTC, 0–23)')}
            </div>
            <div className="bg-newBgColorInner border-newTableBorder border rounded-[8px] flex items-center w-[120px]">
              <input
                type="number"
                min={0}
                max={23}
                disabled={!canManage || busy}
                value={egHour}
                onChange={(e) => setEgHour(e.target.value)}
                className="h-[42px] bg-transparent outline-none flex-1 text-[14px] px-[16px] w-full"
              />
            </div>
          </div>
          {canManage ? (
            <Button
              type="button"
              secondary
              loading={busy}
              onClick={saveEvergreenSchedule}
            >
              {t('rektrs_evergreen_schedule_save', 'Save evergreen schedule')}
            </Button>
          ) : null}
        </div>
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
