'use client';

import { useCallback } from 'react';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

/**
 * REKTRS Social P3-3 — client for the /api/rektrs/v1 surface built in
 * P3-2a (see P3-1-DESIGN.md, "P3-2A IMPLEMENTATION").
 *
 * Everything in this folder renders only when the REKTRS brand flag is on —
 * the same flag that gates the REKTRS logo (components/new-layout/logo.tsx).
 */
export const REKTRS_BRAND_ENABLED =
  process.env.NEXT_PUBLIC_REKTRS_SOCIAL_BRAND === 'true';

export type RektrsFunction =
  | 'CREATOR'
  | 'REVIEWER'
  | 'PUBLISHER'
  | 'MANAGER'
  | 'ANALYST';

export const ALL_REKTRS_FUNCTIONS: RektrsFunction[] = [
  'CREATOR',
  'REVIEWER',
  'PUBLISHER',
  'MANAGER',
  'ANALYST',
];

export interface RektrsBrandChannel {
  id: string;
  brandId: string;
  integrationId: string;
  createdAt: string;
}

export interface RektrsBrand {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  description: string | null;
  logoMediaId: string | null;
  colorPrimary: string | null;
  colorSecondary: string | null;
  approvalRequired: boolean;
  /** W5 kill-switch state (AUTOMATION-WORKFLOWS.md W5). */
  pausedAt: string | null;
  pausedById: string | null;
  pauseReason: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  channels: RektrsBrandChannel[];
}

export type RektrsCampaignStatus =
  | 'ACTIVE'
  | 'PAUSED'
  | 'COMPLETED'
  | 'ARCHIVED';

export interface RektrsCampaign {
  id: string;
  organizationId: string;
  brandId: string;
  name: string;
  objective: string | null;
  status: RektrsCampaignStatus;
  startsAt: string | null;
  endsAt: string | null;
  ownerId: string;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  brief?: unknown;
}

export type RektrsApprovalState =
  | 'DRAFT'
  | 'IN_REVIEW'
  | 'APPROVED'
  | 'CHANGES_REQUESTED'
  | 'REJECTED'
  | 'SCHEDULED'
  | 'PUBLISHED'
  | 'INVALIDATED'
  | 'EXPIRED'
  | 'CANCELLED';

export interface RektrsSubmission {
  id: string;
  organizationId: string;
  batchId: string;
  brandId: string;
  campaignId: string | null;
  state: RektrsApprovalState;
  round: number;
  submittedById: string | null;
  submittedAt: string | null;
  decidedById: string | null;
  decidedAt: string | null;
  decision: 'APPROVE' | 'REQUEST_CHANGES' | 'REJECT' | null;
  approvedHash: string | null;
  expiresAt: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface RektrsInboxItem extends RektrsSubmission {
  decidable: boolean;
}

export interface RektrsVariantPart {
  content: string;
  delay: number;
  image: { mediaId: string; path: string }[];
}

export interface RektrsVariantPayload {
  integrationId: string;
  providerIdentifier: string;
  parts: RektrsVariantPart[];
  settings: unknown;
  title: string | null;
  description: string | null;
}

export interface RektrsContentVersion {
  id: string;
  organizationId: string;
  approvalId: string;
  integrationId: string;
  group: string;
  versionNo: number;
  payload: RektrsVariantPayload;
  contentHash: string;
  createdById: string;
  createdAt: string;
}

export interface RektrsApprovalEvent {
  id: string;
  approvalId: string;
  type: string;
  actorId: string | null;
  actorKind: string;
  commentId: string | null;
  metadata: {
    decision?: string;
    comment?: string;
    selfApproval?: boolean;
    [key: string]: unknown;
  } | null;
  createdAt: string;
}

export interface RektrsSubmissionDetail extends RektrsSubmission {
  versions: RektrsContentVersion[];
  events: RektrsApprovalEvent[];
}

export interface RektrsTimelineEntry {
  kind: 'event' | 'audit';
  at: string;
  entry: RektrsApprovalEvent & {
    action?: string;
    actorId?: string | null;
    metadata?: Record<string, unknown> | null;
  };
}

export interface RektrsOrgSettings {
  approvalRequiredDefault: boolean;
  allowSelfApproval: boolean;
  approvalTtlHours: number | null;
  clientApprovalEnabled: boolean;
  /** W2 alert chain knobs (AUTOMATION-WORKFLOWS.md W2). */
  alertReminderHours: number;
  alertEscalationHours: number;
  alertInAppEnabled: boolean;
  alertEmailEnabled: boolean;
  /** W1 lead machine (AUTOMATION-WORKFLOWS.md W1): the org's CRM webhook.
   * The signing secret is write-only — reads expose only whether one is
   * set (crmWebhookSecretSet). */
  crmWebhookUrl: string | null;
  crmWebhookEnabled: boolean;
  crmWebhookSecretSet: boolean;
}

/** W1: the per-brand comment-to-DM automation rule. */
export interface RektrsLeadRule {
  brandId: string;
  enabled: boolean;
  keywords: string[];
  dmTemplate: string;
  guardWords: string[];
  useDefaultGuardWords: boolean;
  version: number | null;
}

export type RektrsLeadStatus =
  | 'HUMAN_REVIEW'
  | 'DM_PENDING'
  | 'DM_SENT'
  | 'DM_FAILED'
  | 'WEBHOOK_PENDING'
  | 'WEBHOOK_FAILED'
  | 'COMPLETE'
  | 'HANDLED';

export interface RektrsLead {
  id: string;
  organizationId: string;
  brandId: string;
  ruleId: string;
  integrationId: string;
  providerIdentifier: string;
  postId: string | null;
  providerPostId: string;
  commentId: string;
  commenterId: string;
  commenterName: string | null;
  commentText: string;
  commentAt: string | null;
  matchedKeyword: string | null;
  matchedGuardWord: string | null;
  status: RektrsLeadStatus;
  dmMessageId: string | null;
  dmError: string | null;
  dmSentAt: string | null;
  webhookAttempts: number;
  webhookError: string | null;
  webhookDeliveredAt: string | null;
  handledById: string | null;
  handledAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** Result of POST /rektrs/v1/org/crm-webhook/test (W1). */
export interface RektrsCrmWebhookTestResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/** Result of POST /rektrs/v1/brands/:id/pause (W5). */
export interface RektrsBrandPauseResult {
  brand: RektrsBrand;
  alreadyPaused: boolean;
  pulledPostIds: string[];
  pulledCount: number;
}

/** Result of POST /rektrs/v1/brands/:id/resume (W5). */
export interface RektrsBrandResumeResult {
  brand: RektrsBrand;
  alreadyLive: boolean;
  restored: string[];
  skipped: { postId: string; reason: string; message?: string }[];
}

export interface RektrsIntegration {
  id: string;
  name: string;
  identifier: string;
  picture: string | null;
  disabled?: boolean;
}

export class RektrsApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const READABLE_BY_CODE: Record<string, string> = {
  MAKER_CHECKER_VIOLATION:
    "You created this submission, so you can't approve it — another reviewer has to decide.",
  DECISION_COMMENT_REQUIRED:
    "A comment is required when you request changes or reject — please add one.",
  APPROVAL_VERSION_CONFLICT:
    'This submission changed while you were viewing it. It has been refreshed — please check it and decide again.',
  APPROVAL_NOT_IN_REVIEW:
    'This submission is no longer waiting for a review decision.',
  APPROVAL_NOT_SUBMITTABLE:
    'This submission cannot be (re)submitted in its current state.',
  APPROVAL_ALREADY_OPEN:
    'This batch already has an open submission — find it in your submissions list.',
  BATCH_NOT_FOUND: 'No posts were found for this batch.',
  BATCH_HAS_NO_BRAND:
    "The channels in this batch don't belong to a brand yet. Assign the channels to a brand first, then submit.",
  BATCH_SPANS_BRANDS:
    'This batch spans more than one brand. A submission can cover only one brand.',
  CAMPAIGN_BRAND_MISMATCH:
    'The selected campaign belongs to a different brand than this batch.',
  IDEMPOTENCY_KEY_REUSED:
    'This action was already sent with different details. Reload the page and try again.',
  IDEMPOTENCY_KEY_REQUIRED: 'This action needs an idempotency key. Reload and try again.',
  REKTRS_FUNCTION_REQUIRED:
    "Your role doesn't include the function needed for this action.",
  CHANNEL_IN_OTHER_BRAND:
    'This channel already belongs to another brand. Remove it there first.',
  BRAND_SLUG_TAKEN: 'A brand with this slug already exists.',
  HASH_MISMATCH:
    'The content changed after it was approved, so it cannot be published as-is.',
  APPROVAL_EXPIRED:
    'The approval for this content has expired and needs a fresh review.',
  BRAND_PAUSED:
    'This brand is paused (crisis kill-switch). Its posts cannot be scheduled or published until a manager resumes the brand.',
  CRM_WEBHOOK_URL_UNSAFE:
    'The CRM webhook URL must be a public HTTPS address — internal or non-HTTPS URLs are not allowed.',
  CRM_WEBHOOK_SECRET_TOO_SHORT:
    'The CRM webhook signing secret must be at least 16 characters.',
  CRM_WEBHOOK_NOT_CONFIGURED:
    'Save a CRM webhook URL first, then send a test ping.',
  LEAD_RULE_KEYWORDS_REQUIRED:
    'Add at least one keyword before enabling the lead machine.',
  LEAD_RULE_TEMPLATE_REQUIRED:
    'Write the DM template before enabling the lead machine.',
  LEAD_NOT_ACTIONABLE: 'This lead cannot be changed in its current state.',
};

export const readableRektrsError = (error: unknown, fallback: string) => {
  if (error instanceof RektrsApiError) {
    if (error.code && READABLE_BY_CODE[error.code]) {
      return READABLE_BY_CODE[error.code];
    }
    return error.message || fallback;
  }
  if (error instanceof Error) {
    return error.message || fallback;
  }
  return fallback;
};

export const parseRektrsResponse = async <T,>(res: Response): Promise<T> => {
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new RektrsApiError(
      res.status,
      body?.code,
      body?.message || `Request failed (${res.status})`
    );
  }
  return body as T;
};

/** SWR loader for REKTRS GET endpoints (key = the URL itself). */
export const useRektrsLoader = () => {
  const fetch = useFetch();
  return useCallback(
    async <T,>(url: string): Promise<T> => {
      return parseRektrsResponse<T>(await fetch(url));
    },
    [fetch]
  );
};

/** Imperative caller for REKTRS mutations (POST/PATCH/DELETE). */
export const useRektrsCall = () => {
  const fetch = useFetch();
  return useCallback(
    async <T,>(
      url: string,
      options: {
        method: string;
        body?: unknown;
        idempotencyKey?: string;
        ifMatch?: number;
      }
    ): Promise<T> => {
      const res = await fetch(url, {
        method: options.method,
        ...(options.body !== undefined
          ? { body: JSON.stringify(options.body) }
          : {}),
        headers: {
          ...(options.idempotencyKey
            ? { 'Idempotency-Key': options.idempotencyKey }
            : {}),
          ...(options.ifMatch ? { 'If-Match': String(options.ifMatch) } : {}),
        },
      });
      return parseRektrsResponse<T>(res);
    },
    [fetch]
  );
};

export const newIdempotencyKey = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `rektrs-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

export const slugifyClient = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export const shortId = (id: string) => (id ? id.slice(0, 8) : '');

export const formatDateTime = (iso?: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

export const formatDate = (iso?: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
};

/** ISO string -> value for <input type="datetime-local"> */
export const toLocalInputValue = (iso?: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
};

/** <input type="datetime-local"> value -> ISO string (or undefined when empty) */
export const fromLocalInputValue = (value?: string) => {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
};
