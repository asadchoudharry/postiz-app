'use client';

import { ReactNode } from 'react';
import useSWR from 'swr';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import {
  REKTRS_BRAND_ENABLED,
  RektrsInboxItem,
  useRektrsLoader,
} from '@gitroom/frontend/components/rektrs/rektrs.api';

export interface RektrsMenuItem {
  name: string;
  icon: ReactNode;
  path: string;
  badge?: number;
  // Structural compatibility with the layout menu's MenuItemInterface —
  // REKTRS entries never set these, they exist so the merged menu array
  // keeps one element type.
  role?: string[];
  hide?: boolean;
  requireBilling?: boolean;
  onClick?: () => void;
}

const iconProps = {
  xmlns: 'http://www.w3.org/2000/svg',
  width: 20,
  height: 21,
  viewBox: '0 0 20 21',
  fill: 'none',
} as const;

const BrandsIcon = (
  <svg {...iconProps}>
    <path
      d="M3 17.5V8.2L10 3l7 5.2v9.3M7.5 17.5v-5h5v5"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const CampaignsIcon = (
  <svg {...iconProps}>
    <path
      d="M3.5 18.5v-15M3.5 4.5h11l-2.5 3.5 2.5 3.5h-11"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const InboxIcon = (
  <svg {...iconProps}>
    <path
      d="M3 5.5A1.5 1.5 0 0 1 4.5 4h11A1.5 1.5 0 0 1 17 5.5v9a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5v-9ZM3.5 6l6.5 5 6.5-5"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const SubmissionsIcon = (
  <svg {...iconProps}>
    <path
      d="M5 3.5h8L16.5 7v10a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 17V5A1.5 1.5 0 0 1 5 3.5ZM13 3.5V7h3.5M6.5 11h7M6.5 14h7"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const LeadsIcon = (
  <svg {...iconProps}>
    <path
      d="M11 3.5 4.5 11.5h4L7.5 17.5l6.5-8h-4l1-6ZM13.5 4.5a5.5 5.5 0 1 1 2 10.6"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * REKTRS Social P3 navigation entries (Brands, Campaigns, Review Inbox,
 * My Submissions) for the main layout menu. Returns an empty list unless
 * the REKTRS brand flag is on — the same gate as the logo — so with the
 * flag off the menu renders exactly as upstream.
 *
 * The inbox badge count reuses the inbox endpoint as its source: without
 * the REVIEWER function the request fails and only the badge stays hidden;
 * the menu entry itself remains.
 */
export const useRektrsMenuItems = (): RektrsMenuItem[] => {
  const t = useT();
  const load = useRektrsLoader();
  const { data: inbox } = useSWR<RektrsInboxItem[]>(
    REKTRS_BRAND_ENABLED ? '/rektrs/v1/review/inbox' : null,
    load,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      refreshWhenHidden: false,
      refreshWhenOffline: false,
    }
  );
  // W1: the leads badge counts comments waiting for a human (guard-word
  // queue). Without a lead-viewing function the request fails and, exactly
  // like the inbox badge, only the badge stays hidden.
  const { data: humanReview } = useSWR<{ count: number }>(
    REKTRS_BRAND_ENABLED ? '/rektrs/v1/leads/human-review-count' : null,
    load,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      refreshWhenHidden: false,
      refreshWhenOffline: false,
    }
  );

  if (!REKTRS_BRAND_ENABLED) {
    return [];
  }

  const pending = (inbox || []).filter((i) => i.decidable).length;

  return [
    { name: t('brands', 'Brands'), icon: BrandsIcon, path: '/brands' },
    {
      name: t('campaigns', 'Campaigns'),
      icon: CampaignsIcon,
      path: '/campaigns',
    },
    {
      name: t('rektrs_leads', 'Leads'),
      icon: LeadsIcon,
      path: '/leads',
      badge: humanReview?.count || 0,
    },
    {
      name: t('review_inbox', 'Review inbox'),
      icon: InboxIcon,
      path: '/review',
      badge: pending,
    },
    {
      name: t('my_submissions', 'My submissions'),
      icon: SubmissionsIcon,
      path: '/submissions',
    },
  ];
};
