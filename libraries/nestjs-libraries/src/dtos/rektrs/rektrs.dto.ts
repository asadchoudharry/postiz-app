import {
  IsArray,
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Min,
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
}
