import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { RektrsInboxService } from '@gitroom/nestjs-libraries/rektrs/rektrs.inbox.service';
import { ListInboxItemsQueryDto } from '@gitroom/nestjs-libraries/dtos/rektrs/rektrs.dto';
import {
  RektrsFunctionsGuard,
  RequireRektrsFunctions,
} from '@gitroom/backend/rektrs/rektrs.functions.guard';

/**
 * REKTRS W6 inbox surface (AUTOMATION-WORKFLOWS.md W6): the org-wide,
 * cross-brand item list behind the Inbox screen, plus the queued-
 * complaint count the nav badge reads. Per-brand settings and the
 * send/dismiss actions live on the brands controller (they are brand
 * resources). Function mapping mirrors W1's leads surface: MANAGER /
 * CREATOR / ANALYST view and work the queue.
 */
@ApiTags('Rektrs Inbox')
@Controller('/rektrs/v1/inbox')
@UseGuards(RektrsFunctionsGuard)
export class RektrsInboxController {
  constructor(private _inbox: RektrsInboxService) {}

  @Get('/')
  @RequireRektrsFunctions('MANAGER', 'CREATOR', 'ANALYST')
  async listItems(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ListInboxItemsQueryDto
  ) {
    return this._inbox.listOrgItems(org.id, query);
  }

  @Get('/queue-count')
  @RequireRektrsFunctions('MANAGER', 'CREATOR', 'ANALYST')
  async queueCount(@GetOrgFromRequest() org: Organization) {
    return { count: await this._inbox.countQueued(org.id) };
  }
}
