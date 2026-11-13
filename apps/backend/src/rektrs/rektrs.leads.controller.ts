import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization, User } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { RektrsLeadsService } from '@gitroom/nestjs-libraries/rektrs/rektrs.leads.service';
import { ListLeadsQueryDto } from '@gitroom/nestjs-libraries/dtos/rektrs/rektrs.dto';
import {
  RektrsFunctionsGuard,
  RequireRektrsFunctions,
} from '@gitroom/backend/rektrs/rektrs.functions.guard';
import { sessionActor } from '@gitroom/backend/rektrs/rektrs.http';
import { RealIP } from 'nestjs-real-ip';

/**
 * REKTRS W1 leads surface (AUTOMATION-WORKFLOWS.md W1). Function mapping:
 * MANAGER configures rules + retries; MANAGER / CREATOR / ANALYST view the
 * leads list and work the human-review queue (admins hold all functions by
 * role resolution, as everywhere in the REKTRS surface).
 */
@ApiTags('Rektrs Leads')
@Controller('/rektrs/v1/leads')
@UseGuards(RektrsFunctionsGuard)
export class RektrsLeadsController {
  constructor(private _leads: RektrsLeadsService) {}

  @Get('/')
  @RequireRektrsFunctions('MANAGER', 'CREATOR', 'ANALYST')
  async listLeads(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ListLeadsQueryDto
  ) {
    return this._leads.listLeads(org.id, {
      status: query.status as never,
      brandId: query.brandId,
      take: query.take,
    });
  }

  @Get('/human-review-count')
  @RequireRektrsFunctions('MANAGER', 'CREATOR', 'ANALYST')
  async humanReviewCount(@GetOrgFromRequest() org: Organization) {
    return { count: await this._leads.countLeads(org.id, 'HUMAN_REVIEW') };
  }

  @Post('/:id/handled')
  @RequireRektrsFunctions('MANAGER', 'CREATOR', 'ANALYST')
  async markHandled(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @RealIP() ip: string
  ) {
    return this._leads.markHandled(org.id, sessionActor(user, ip), id);
  }

  @Post('/:id/retry')
  @RequireRektrsFunctions('MANAGER')
  async retryLead(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @RealIP() ip: string
  ) {
    return this._leads.retryLead(org.id, sessionActor(user, ip), id);
  }
}
