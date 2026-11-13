import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization, User } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { RektrsCatalogService } from '@gitroom/nestjs-libraries/rektrs/rektrs.catalog.service';
import {
  CreateCampaignDto,
  UpdateCampaignDto,
  UpsertBriefDto,
} from '@gitroom/nestjs-libraries/dtos/rektrs/rektrs.dto';
import {
  RektrsFunctionsGuard,
  RequireRektrsFunctions,
} from '@gitroom/backend/rektrs/rektrs.functions.guard';
import { requireIfMatch, sessionActor } from '@gitroom/backend/rektrs/rektrs.http';
import { RealIP } from 'nestjs-real-ip';

@ApiTags('Rektrs Campaigns')
@Controller('/rektrs/v1/campaigns')
@UseGuards(RektrsFunctionsGuard)
export class RektrsCampaignsController {
  constructor(private _catalog: RektrsCatalogService) {}

  @Post('/')
  @RequireRektrsFunctions('MANAGER')
  async createCampaign(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: CreateCampaignDto,
    @RealIP() ip: string
  ) {
    return this._catalog.createCampaign(org.id, sessionActor(user, ip), body);
  }

  @Get('/')
  async listCampaigns(
    @GetOrgFromRequest() org: Organization,
    @Query('brand') brandId?: string,
    @Query('status') status?: string,
    @Query('owner') ownerId?: string
  ) {
    return this._catalog.listCampaigns(org.id, { brandId, status, ownerId });
  }

  @Get('/:id')
  async getCampaign(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._catalog.getCampaign(org.id, id);
  }

  @Patch('/:id')
  async updateCampaign(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: UpdateCampaignDto,
    @Headers('if-match') ifMatch: string,
    @RealIP() ip: string
  ) {
    // MANAGER-or-owner is enforced in the service (design §3.2).
    return this._catalog.updateCampaign(
      org.id,
      sessionActor(user, ip),
      id,
      body,
      requireIfMatch(ifMatch)
    );
  }

  @Put('/:id/brief')
  async upsertBrief(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: UpsertBriefDto,
    @RealIP() ip: string
  ) {
    // MANAGER / campaign owner / assigned creator enforced in the service.
    return this._catalog.upsertBrief(org.id, sessionActor(user, ip), id, body);
  }

  @Get('/:id/brief')
  async getBrief(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._catalog.getBrief(org.id, id);
  }
}
