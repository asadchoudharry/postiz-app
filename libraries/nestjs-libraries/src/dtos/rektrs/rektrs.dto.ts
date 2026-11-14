import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export class CreateBrandDto {
  @IsString()
  @IsDefined()
  name: string;

  @IsOptional()
  @IsString()
  slug?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  logoMediaId?: string;

  @IsOptional()
  @IsString()
  colorPrimary?: string;

  @IsOptional()
  @IsString()
  colorSecondary?: string;

  @IsOptional()
  @IsBoolean()
  approvalRequired?: boolean;
}

export class UpdateBrandDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsString()
  logoMediaId?: string | null;

  @IsOptional()
  @IsString()
  colorPrimary?: string | null;

  @IsOptional()
  @IsString()
  colorSecondary?: string | null;

  @IsOptional()
  @IsBoolean()
  approvalRequired?: boolean;
}

export class AssignChannelDto {
  @IsString()
  @IsDefined()
  integrationId: string;
}

export class CreateCampaignDto {
  @IsString()
  @IsDefined()
  brandId: string;

  @IsString()
  @IsDefined()
  name: string;

  @IsOptional()
  @IsString()
  objective?: string;

  @IsOptional()
  @IsISO8601()
  startsAt?: string;

  @IsOptional()
  @IsISO8601()
  endsAt?: string;

  @IsOptional()
  @IsString()
  ownerId?: string;
}

export class UpdateCampaignDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  objective?: string | null;

  @IsOptional()
  @IsIn(['ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED'])
  status?: string;

  @IsOptional()
  @IsISO8601()
  startsAt?: string | null;

  @IsOptional()
  @IsISO8601()
  endsAt?: string | null;

  @IsOptional()
  @IsString()
  ownerId?: string;
}

export class UpsertBriefDto {
  @IsString()
  @IsDefined()
  objective: string;

  @IsOptional()
  @IsString()
  audience?: string;

  @IsOptional()
  @IsString()
  keyMessages?: string;

  @IsOptional()
  @IsString()
  mandatoryIncludes?: string;

  @IsOptional()
  @IsString()
  prohibitedTerms?: string;

  @IsOptional()
  @IsString()
  tone?: string;

  @IsOptional()
  @IsString()
  references?: string;

  @IsOptional()
  @IsString()
  assigneeId?: string;

  @IsOptional()
  @IsISO8601()
  dueAt?: string;
}

export class CreateSubmissionDto {
  @IsString()
  @IsDefined()
  batchId: string;

  @IsOptional()
  @IsString()
  campaignId?: string;
}

export class DecideSubmissionDto {
  @IsDefined()
  @IsIn(['APPROVE', 'REQUEST_CHANGES', 'REJECT'])
  decision: 'APPROVE' | 'REQUEST_CHANGES' | 'REJECT';

  @IsOptional()
  @IsString()
  comment?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}

export class UpdateMemberFunctionsDto {
  @IsArray()
  @IsString({ each: true })
  @IsDefined()
  functions: string[];
}

export class UpdateRektrsOrgSettingsDto {
  @IsOptional()
  @IsBoolean()
  approvalRequiredDefault?: boolean;

  @IsOptional()
  @IsBoolean()
  allowSelfApproval?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  approvalTtlHours?: number | null;

  @IsOptional()
  @IsBoolean()
  clientApprovalEnabled?: boolean;

  // W2 alert chain knobs (AUTOMATION-WORKFLOWS.md W2)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(168)
  alertReminderHours?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(720)
  alertEscalationHours?: number;

  @IsOptional()
  @IsBoolean()
  alertInAppEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  alertEmailEnabled?: boolean;

  // W1 — CRM webhook (Operqon-first; the endpoint is an org setting, never
  // hardcoded). URL safety (public HTTPS) is enforced in the service via
  // isSafePublicHttpsUrl; the secret is write-only (min length in service).
  @IsOptional()
  @ValidateIf((o) => o.crmWebhookUrl !== null)
  @IsString()
  @MaxLength(2048)
  crmWebhookUrl?: string | null;

  @IsOptional()
  @IsBoolean()
  crmWebhookEnabled?: boolean;

  @IsOptional()
  @ValidateIf((o) => o.crmWebhookSecret !== null)
  @IsString()
  @MaxLength(512)
  crmWebhookSecret?: string | null;

  /** Convenience for the settings UI: clear the stored secret. */
  @IsOptional()
  @IsBoolean()
  clearCrmWebhookSecret?: boolean;

  // W3 — evergreen recycler schedule: the weekly scan runs when the UTC
  // weekday (0 = Sunday … 6 = Saturday) and hour match.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(6)
  evergreenWeekday?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  evergreenHour?: number;
}

/**
 * W1 — the per-brand lead automation rule (AUTOMATION-WORKFLOWS.md W1).
 * keywords/guardWords are phrase lists (normalised server-side); the DM
 * template supports {{name}} / {{keyword}} / {{link}} placeholders.
 */
export class UpdateLeadRuleDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  keywords?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  dmTemplate?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  guardWords?: string[];

  @IsOptional()
  @IsBoolean()
  useDefaultGuardWords?: boolean;
}

export const REKTRS_LEAD_STATUSES = [
  'HUMAN_REVIEW',
  'DM_PENDING',
  'DM_SENT',
  'DM_FAILED',
  'WEBHOOK_PENDING',
  'WEBHOOK_FAILED',
  'COMPLETE',
  'HANDLED',
] as const;

export class ListLeadsQueryDto {
  @IsOptional()
  @IsIn(REKTRS_LEAD_STATUSES as unknown as string[])
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  brandId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  take?: number;
}

/**
 * W3 — the per-brand evergreen recycler configuration
 * (AUTOMATION-WORKFLOWS.md W3). styleMode: VERBATIM (exact copy) |
 * HOOK (prepend a rotating hook line) | ROTATE (alternate the two).
 * hookLines are display text — stored verbatim, prepended verbatim.
 */
export class UpdateEvergreenSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  minAgeDays?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  topN?: number;

  @IsOptional()
  @IsIn(['VERBATIM', 'HOOK', 'ROTATE'])
  styleMode?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  hookLines?: string[];
}

/**
 * W4 — the per-brand milestone auto-CTA configuration
 * (AUTOMATION-WORKFLOWS.md W4). ctaText / ctaUrl are display text —
 * stored trimmed, posted verbatim as the first comment (the URL is NOT
 * shortened until the P5 first-comment shortener lands). The service
 * additionally refuses enabling with neither text nor URL
 * (CTA_CONTENT_REQUIRED) and a non-http(s) URL (CTA_URL_INVALID).
 */
export class UpdateMilestoneCtaSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000000)
  likeThreshold?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  ctaText?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  ctaUrl?: string;
}

export class PauseBrandDto {
  @IsOptional()
  @IsString()
  reason?: string;
}
