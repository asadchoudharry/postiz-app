'use client';

import { FC, useCallback, useMemo } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useUser } from '@gitroom/frontend/components/layout/user.context';
import {
  ALL_REKTRS_FUNCTIONS,
  RektrsApprovalState,
  RektrsBrand,
  RektrsCampaign,
  RektrsFunction,
  RektrsIntegration,
  RektrsOrgSettings,
  useRektrsLoader,
} from '@gitroom/frontend/components/rektrs/rektrs.api';
import clsx from 'clsx';

/**
 * The caller's REKTRS functions.
 *
 * P3-2a exposes no "my functions" read endpoint — the only member-functions
 * endpoint is the MANAGER-gated PATCH — so the client mirrors the backend's
 * own default resolution (libraries/nestjs-libraries/src/rektrs/
 * rektrs.roles.ts `resolveFunctions`): org SUPERADMIN/ADMIN hold all five
 * functions, org USER holds {CREATOR}. That is exactly right whenever no
 * explicit function set has been stored for the member (the state until a
 * manager edits functions through the API). The API stays the authority:
 * every REKTRS endpoint re-checks functions server-side, and the inbox
 * additionally flags each row `decidable`, which the UI honours first.
 */
export const useRektrsFunctions = (): RektrsFunction[] => {
  const user = useUser();
  return useMemo(() => {
    if (user?.role === 'SUPERADMIN' || user?.role === 'ADMIN') {
      return ALL_REKTRS_FUNCTIONS;
    }
    return ['CREATOR'] as RektrsFunction[];
  }, [user?.role]);
};

export const useHasRektrsFunction = (fn: RektrsFunction) => {
  const functions = useRektrsFunctions();
  return functions.includes(fn);
};

const SWR_OPTS = {
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
  revalidateIfStale: false,
  refreshWhenHidden: false,
  refreshWhenOffline: false,
} as const;

export const useBrands = () => {
  const load = useRektrsLoader();
  return useSWR<RektrsBrand[]>('/rektrs/v1/brands', load, SWR_OPTS);
};

export const useCampaigns = () => {
  const load = useRektrsLoader();
  return useSWR<RektrsCampaign[]>('/rektrs/v1/campaigns', load, SWR_OPTS);
};

export const useOrgSettings = () => {
  const load = useRektrsLoader();
  return useSWR<RektrsOrgSettings>(
    '/rektrs/v1/org/settings',
    load,
    SWR_OPTS
  );
};

/** Connected channels (same endpoint + key the launches area already uses). */
export const useIntegrations = () => {
  const fetch = useFetch();
  const load = useCallback(async (path: string) => {
    const body = await (await fetch(path)).json();
    return (body?.integrations || []) as RektrsIntegration[];
  }, [fetch]);
  return useSWR<RektrsIntegration[]>('/integrations/list', load, {
    ...SWR_OPTS,
    fallbackData: [],
  });
};

export interface TeamMember {
  membershipId: string;
  role: 'SUPERADMIN' | 'ADMIN' | 'USER';
  userId: string;
  email: string;
}

/** Org members, via the endpoint the settings → team screen already uses. */
export const useTeamMembers = () => {
  const fetch = useFetch();
  const load = useCallback(async () => {
    const body = await (await fetch('/settings/team')).json();
    return ((body?.users || []) as any[]).map((u) => ({
      membershipId: u.id,
      role: u.role,
      userId: u.user?.id,
      email: u.user?.email || '',
    })) as TeamMember[];
  }, [fetch]);
  const swr = useSWR<TeamMember[]>('/rektrs/team-members', load, SWR_OPTS);
  const nameOf = useCallback(
    (userId?: string | null) => {
      if (!userId) return '—';
      const member = (swr.data || []).find((m) => m.userId === userId);
      return member?.email || userId.slice(0, 8);
    },
    [swr.data]
  );
  return { ...swr, nameOf };
};

export const STATE_STYLES: Record<RektrsApprovalState, string> = {
  DRAFT: 'bg-gray-500/15 text-gray-500',
  IN_REVIEW: 'bg-amber-500/15 text-amber-600',
  APPROVED: 'bg-green-500/15 text-green-600',
  CHANGES_REQUESTED: 'bg-orange-500/15 text-orange-600',
  REJECTED: 'bg-red-500/15 text-red-600',
  SCHEDULED: 'bg-blue-500/15 text-blue-600',
  PUBLISHED: 'bg-emerald-500/15 text-emerald-600',
  INVALIDATED: 'bg-red-500/15 text-red-500',
  EXPIRED: 'bg-gray-500/15 text-gray-500',
  CANCELLED: 'bg-gray-500/15 text-gray-500',
};

export const STATE_LABELS: Record<RektrsApprovalState, string> = {
  DRAFT: 'Draft',
  IN_REVIEW: 'In review',
  APPROVED: 'Approved',
  CHANGES_REQUESTED: 'Changes requested',
  REJECTED: 'Rejected',
  SCHEDULED: 'Scheduled',
  PUBLISHED: 'Published',
  INVALIDATED: 'Invalidated',
  EXPIRED: 'Expired',
  CANCELLED: 'Cancelled',
};

export const StateBadge: FC<{ state: RektrsApprovalState }> = ({ state }) => (
  <span
    className={clsx(
      'inline-flex items-center rounded-full px-[8px] py-[2px] text-[11px] font-[600] whitespace-nowrap',
      STATE_STYLES[state] || STATE_STYLES.DRAFT
    )}
  >
    {STATE_LABELS[state] || state}
  </span>
);

export const BrandDot: FC<{ color?: string | null; size?: number }> = ({
  color,
  size = 12,
}) => (
  <span
    className="inline-block rounded-full shrink-0 border border-black/10"
    style={{
      width: size,
      height: size,
      backgroundColor: color || '#94a3b8',
    }}
  />
);

/** Channel chip: platform icon + channel name (the launches-area pattern). */
export const ChannelChip: FC<{
  providerIdentifier?: string | null;
  name?: string | null;
  picture?: string | null;
}> = ({ providerIdentifier, name, picture }) => (
  <span className="inline-flex items-center gap-[6px] min-w-0">
    {picture ? (
      <img
        src={picture}
        alt=""
        className="w-[18px] h-[18px] rounded-full object-cover shrink-0"
      />
    ) : null}
    {providerIdentifier ? (
      <img
        src={`/icons/platforms/${providerIdentifier}.png`}
        alt=""
        className="w-[16px] h-[16px] shrink-0"
      />
    ) : null}
    <span className="truncate">{name || providerIdentifier || 'Channel'}</span>
  </span>
);

export const EmptyState: FC<{ title: string; hint?: string }> = ({
  title,
  hint,
}) => (
  <div className="flex flex-col items-center justify-center gap-[6px] py-[48px] text-center">
    <div className="text-[16px] font-[600]">{title}</div>
    {hint ? <div className="text-[13px] opacity-60 max-w-[420px]">{hint}</div> : null}
  </div>
);

export const SectionTitle: FC<{ children: string }> = ({ children }) => (
  <div className="text-[20px] font-[600]">{children}</div>
);
