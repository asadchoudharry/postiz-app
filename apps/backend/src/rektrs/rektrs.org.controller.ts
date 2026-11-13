import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization, User } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { RektrsRolesService } from '@gitroom/nestjs-libraries/rektrs/rektrs.roles.service';
import { RektrsAuditService } from '@gitroom/nestjs-libraries/rektrs/rektrs.audit.service';
import { RektrsLeadsService } from '@gitroom/nestjs-libraries/rektrs/rektrs.leads.service';
import {
  UpdateMemberFunctionsDto,
  UpdateRektrsOrgSettingsDto,
} from '@gitroom/nestjs-libraries/dtos/rektrs/rektrs.dto';
import {
  RektrsFunctionsGuard,
  RequireRektrsFunctions,
} from '@gitroom/backend/rektrs/rektrs.functions.guard';
import { sessionActor } from '@gitroom/backend/rektrs/rektrs.http';
import { RealIP } from 'nestjs-real-ip';

@ApiTags('Rektrs Org')
@Controller('/rektrs/v1/org')
@UseGuards(RektrsFunctionsGuard)
export class RektrsOrgController {
  constructor(
    private _roles: RektrsRolesService,
    private _leads: RektrsLeadsService
  ) {}

  @Patch('/members/:userId/functions')
  @RequireRektrsFunctions('MANAGER')
  async updateMemberFunctions(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('userId') targetUserId: string,
    @Body() body: UpdateMemberFunctionsDto,
    @RealIP() ip: string
  ) {
    return this._roles.updateMemberFunctions(
      org.id,
      sessionActor(user, ip),
      targetUserId,
      body.functions
    );
  }

  @Get('/settings')
  async getSettings(@GetOrgFromRequest() org: Organization) {
    return this._roles.getOrgSettings(org.id);
  }

  @Patch('/settings')
  @RequireRektrsFunctions('MANAGER')
  async updateSettings(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: UpdateRektrsOrgSettingsDto,
    @RealIP() ip: string
  ) {
    // W1: the settings UI clears the CRM secret via a flag; translate it to
    // the service's write-only secret patch (null = clear).
    const { clearCrmWebhookSecret, ...patch } = body;
    return this._roles.updateOrgSettings(org.id, sessionActor(user, ip), {
      ...patch,
      ...(clearCrmWebhookSecret ? { crmWebhookSecret: null } : {}),
    });
  }

  /** W1: fire one signed test ping at the org's configured CRM webhook. */
  @Post('/crm-webhook/test')
  @RequireRektrsFunctions('MANAGER')
  async testCrmWebhook(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @RealIP() ip: string
  ) {
    return this._leads.testCrmWebhook(org.id, sessionActor(user, ip));
  }
}

@ApiTags('Rektrs Audit')
@Controller('/rektrs/v1/audit')
@UseGuards(RektrsFunctionsGuard)
export class RektrsAuditController {
  constructor(private _audit: RektrsAuditService) {}

  @Get('/')
  @RequireRektrsFunctions('MANAGER')
  async search(
    @GetOrgFromRequest() org: Organization,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('action') action?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cursor') cursor?: string,
    @Query('take') take?: string
  ) {
    return this._audit.search(org.id, {
      entityType,
      entityId,
      action,
      from,
      to,
      cursor,
      take: take ? Number.parseInt(take, 10) : undefined,
    });
  }
}
