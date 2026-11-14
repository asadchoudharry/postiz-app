import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { Organization, RektrsApprovalState, User } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { RektrsApprovalsService } from '@gitroom/nestjs-libraries/rektrs/rektrs.approvals.service';
import { RektrsIdempotencyService } from '@gitroom/nestjs-libraries/rektrs/rektrs.idempotency.service';
import {
  CreateSubmissionDto,
  DecideSubmissionDto,
} from '@gitroom/nestjs-libraries/dtos/rektrs/rektrs.dto';
import {
  RektrsFunctionsGuard,
  RequireRektrsFunctions,
} from '@gitroom/backend/rektrs/rektrs.functions.guard';
import { parseIfMatch, sessionActor } from '@gitroom/backend/rektrs/rektrs.http';
import { RealIP } from 'nestjs-real-ip';

@ApiTags('Rektrs Submissions')
@Controller('/rektrs/v1/submissions')
@UseGuards(RektrsFunctionsGuard)
export class RektrsSubmissionsController {
  constructor(
    private _approvals: RektrsApprovalsService,
    private _idempotency: RektrsIdempotencyService
  ) {}

  @Post('/')
  @RequireRektrsFunctions('CREATOR')
  async createSubmission(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: CreateSubmissionDto,
    @Headers('idempotency-key') idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
    @RealIP() ip: string
  ) {
    const result = await this._idempotency.execute(org.id, idempotencyKey, body, async () => ({
      status: 201,
      body: await this._approvals.createSubmission(
        org.id,
        sessionActor(user, ip),
        body
      ),
    }));
    res.status(result.status);
    return result.body;
  }

  @Get('/')
  async listSubmissions(
    @GetOrgFromRequest() org: Organization,
    @Query('state') state?: string,
    @Query('brand') brandId?: string,
    @Query('campaign') campaignId?: string,
    @Query('maker') submittedById?: string
  ) {
    return this._approvals.listSubmissions(org.id, {
      state: state as RektrsApprovalState | undefined,
      brandId,
      campaignId,
      submittedById,
    });
  }

  @Get('/:id')
  async getSubmission(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._approvals.getSubmission(org.id, id);
  }

  @Get('/:id/audit')
  async getSubmissionTimeline(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._approvals.getSubmissionTimeline(org.id, id);
  }

  @Post('/:id/submit')
  @RequireRektrsFunctions('CREATOR')
  async submit(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Headers('idempotency-key') idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
    @RealIP() ip: string
  ) {
    const result = await this._idempotency.execute(
      org.id,
      idempotencyKey,
      { submissionId: id, ...(body || {}) },
      async () => ({
        status: 200,
        body: await this._approvals.submit(org.id, sessionActor(user, ip), id),
      })
    );
    res.status(result.status);
    return result.body;
  }

  @Post('/:id/decisions')
  @RequireRektrsFunctions('REVIEWER')
  async decide(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: DecideSubmissionDto,
    @Headers('idempotency-key') idempotencyKey: string,
    @Headers('if-match') ifMatch: string,
    @Res({ passthrough: true }) res: Response,
    @RealIP() ip: string
  ) {
    const result = await this._idempotency.execute(
      org.id,
      idempotencyKey,
      { submissionId: id, ...body },
      async () => ({
        status: 200,
        body: await this._approvals.decide(org.id, sessionActor(user, ip), id, {
          decision: body.decision,
          comment: body.comment,
          expectedVersion: body.expectedVersion ?? parseIfMatch(ifMatch),
        }),
      })
    );
    res.status(result.status);
    return result.body;
  }

  @Post('/:id/cancel')
  async cancel(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @RealIP() ip: string
  ) {
    // Maker-or-MANAGER is enforced in the service (design §3.2).
    return this._approvals.cancel(org.id, sessionActor(user, ip), id);
  }
}

@ApiTags('Rektrs Review')
@Controller('/rektrs/v1/review')
@UseGuards(RektrsFunctionsGuard)
export class RektrsReviewController {
  constructor(private _approvals: RektrsApprovalsService) {}

  @Get('/inbox')
  @RequireRektrsFunctions('REVIEWER')
  async inbox(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @RealIP() ip: string,
    @Query('brand') brandId?: string,
    @Query('campaign') campaignId?: string,
    @Query('maker') submittedById?: string
  ) {
    return this._approvals.getReviewInbox(org.id, sessionActor(user, ip), {
      brandId,
      campaignId,
      submittedById,
    });
  }
}
