import {
  Body,
  Controller,
  Delete,
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
import { RektrsBrandControlService } from '@gitroom/nestjs-libraries/rektrs/rektrs.brand-control.service';
import { RektrsLeadsService } from '@gitroom/nestjs-libraries/rektrs/rektrs.leads.service';
import { RektrsEvergreenService } from '@gitroom/nestjs-libraries/rektrs/rektrs.evergreen.service';
import { RektrsMilestoneCtaService } from '@gitroom/nestjs-libraries/rektrs/rektrs.milestone-cta.service';
import { RektrsInboxService } from '@gitroom/nestjs-libraries/rektrs/rektrs.inbox.service';
import { RektrsBlogChainService } from '@gitroom/nestjs-libraries/rektrs/rektrs.blog-chain.service';
import {
  AssignChannelDto,
  CreateBrandDto,
  ListInboxItemsQueryDto,
  PauseBrandDto,
  SendInboxReplyDto,
  UpdateBlogChainSettingsDto,
  UpdateBrandDto,
  UpdateEvergreenSettingsDto,
  UpdateInboxSettingsDto,
  UpdateLeadRuleDto,
  UpdateMilestoneCtaSettingsDto,
} from '@gitroom/nestjs-libraries/dtos/rektrs/rektrs.dto';
import {
  RektrsFunctionsGuard,
  RequireRektrsFunctions,
} from '@gitroom/backend/rektrs/rektrs.functions.guard';
import {
  parseIfMatch,
  requireIfMatch,
  sessionActor,
} from '@gitroom/backend/rektrs/rektrs.http';
import { RealIP } from 'nestjs-real-ip';

@ApiTags('Rektrs Brands')
@Controller('/rektrs/v1/brands')
@UseGuards(RektrsFunctionsGuard)
export class RektrsBrandsController {
  constructor(
    private _catalog: RektrsCatalogService,
    private _brandControl: RektrsBrandControlService,
    private _leads: RektrsLeadsService,
    private _evergreen: RektrsEvergreenService,
    private _milestoneCta: RektrsMilestoneCtaService,
    private _inbox: RektrsInboxService,
    private _blogChain: RektrsBlogChainService
  ) {}

  @Post('/')
  @RequireRektrsFunctions('MANAGER')
  async createBrand(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: CreateBrandDto,
    @RealIP() ip: string
  ) {
    return this._catalog.createBrand(org.id, sessionActor(user, ip), body);
  }

  @Get('/')
  async listBrands(@GetOrgFromRequest() org: Organization) {
    return this._catalog.listBrands(org.id);
  }

  @Get('/:id')
  async getBrand(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._catalog.getBrand(org.id, id);
  }

  @Patch('/:id')
  @RequireRektrsFunctions('MANAGER')
  async updateBrand(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: UpdateBrandDto,
    @Headers('if-match') ifMatch: string,
    @RealIP() ip: string
  ) {
    return this._catalog.updateBrand(
      org.id,
      sessionActor(user, ip),
      id,
      body,
      requireIfMatch(ifMatch)
    );
  }

  @Post('/:id/channels')
  @RequireRektrsFunctions('MANAGER')
  async assignChannel(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: AssignChannelDto,
    @RealIP() ip: string
  ) {
    return this._catalog.assignChannel(
      org.id,
      sessionActor(user, ip),
      id,
      body.integrationId
    );
  }

  // W5 crisis kill-switch (AUTOMATION-WORKFLOWS.md W5), MANAGER only.
  @Post('/:id/pause')
  @RequireRektrsFunctions('MANAGER')
  async pauseBrand(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: PauseBrandDto,
    @RealIP() ip: string
  ) {
    return this._brandControl.pauseBrand(
      org.id,
      sessionActor(user, ip),
      id,
      body?.reason
    );
  }

  @Post('/:id/resume')
  @RequireRektrsFunctions('MANAGER')
  async resumeBrand(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @RealIP() ip: string
  ) {
    return this._brandControl.resumeBrand(org.id, sessionActor(user, ip), id);
  }

  // ── W1 lead machine: the brand's comment-to-DM rule ───────────────────────
  @Get('/:id/lead-rule')
  async getLeadRule(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._leads.getLeadRule(org.id, id);
  }

  @Put('/:id/lead-rule')
  @RequireRektrsFunctions('MANAGER')
  async updateLeadRule(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: UpdateLeadRuleDto,
    @Headers('if-match') ifMatch: string,
    @RealIP() ip: string
  ) {
    return this._leads.updateLeadRule(
      org.id,
      sessionActor(user, ip),
      id,
      body,
      parseIfMatch(ifMatch)
    );
  }

  // ── W3 evergreen recycler: per-brand configuration, lineage, runs ────────
  @Get('/:id/evergreen')
  async getEvergreenSettings(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._evergreen.getEvergreenSettings(org.id, id);
  }

  @Put('/:id/evergreen')
  @RequireRektrsFunctions('MANAGER')
  async updateEvergreenSettings(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: UpdateEvergreenSettingsDto,
    @Headers('if-match') ifMatch: string,
    @RealIP() ip: string
  ) {
    return this._evergreen.updateEvergreenSettings(
      org.id,
      sessionActor(user, ip),
      id,
      body,
      parseIfMatch(ifMatch)
    );
  }

  @Get('/:id/evergreen/copies')
  @RequireRektrsFunctions('MANAGER', 'CREATOR', 'ANALYST')
  async listEvergreenActivity(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._evergreen.listEvergreenActivity(org.id, id);
  }

  @Post('/:id/evergreen/run')
  @RequireRektrsFunctions('MANAGER')
  async runEvergreen(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @RealIP() ip: string
  ) {
    return this._evergreen.runBrandNow(org.id, sessionActor(user, ip), id);
  }

  // ── W4 milestone auto-CTA: per-brand configuration, actions, runs ───────
  @Get('/:id/milestone-cta')
  async getMilestoneCtaSettings(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._milestoneCta.getCtaSettings(org.id, id);
  }

  @Put('/:id/milestone-cta')
  @RequireRektrsFunctions('MANAGER')
  async updateMilestoneCtaSettings(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: UpdateMilestoneCtaSettingsDto,
    @Headers('if-match') ifMatch: string,
    @RealIP() ip: string
  ) {
    return this._milestoneCta.updateCtaSettings(
      org.id,
      sessionActor(user, ip),
      id,
      body,
      parseIfMatch(ifMatch)
    );
  }

  @Get('/:id/milestone-cta/activity')
  @RequireRektrsFunctions('MANAGER', 'CREATOR', 'ANALYST')
  async listMilestoneCtaActivity(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._milestoneCta.listCtaActivity(org.id, id);
  }

  @Post('/:id/milestone-cta/run')
  @RequireRektrsFunctions('MANAGER')
  async runMilestoneCta(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @RealIP() ip: string
  ) {
    return this._milestoneCta.runBrandNow(org.id, sessionActor(user, ip), id);
  }

  // ── W6 inbox triage: per-brand configuration, items, human actions ──────
  @Get('/:id/inbox-triage')
  async getInboxSettings(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._inbox.getInboxSettings(org.id, id);
  }

  @Put('/:id/inbox-triage')
  @RequireRektrsFunctions('MANAGER')
  async updateInboxSettings(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: UpdateInboxSettingsDto,
    @Headers('if-match') ifMatch: string,
    @RealIP() ip: string
  ) {
    return this._inbox.updateInboxSettings(
      org.id,
      sessionActor(user, ip),
      id,
      body,
      parseIfMatch(ifMatch)
    );
  }

  @Get('/:id/inbox')
  @RequireRektrsFunctions('MANAGER', 'CREATOR', 'ANALYST')
  async listBrandInboxItems(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Query() query: ListInboxItemsQueryDto
  ) {
    return this._inbox.listBrandItems(org.id, id, query);
  }

  @Post('/:id/inbox/:itemId/send')
  @RequireRektrsFunctions('MANAGER', 'CREATOR', 'ANALYST')
  async sendInboxReply(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() body: SendInboxReplyDto,
    @RealIP() ip: string
  ) {
    return this._inbox.sendReply(
      org.id,
      sessionActor(user, ip),
      id,
      itemId,
      body
    );
  }

  @Post('/:id/inbox/:itemId/dismiss')
  @RequireRektrsFunctions('MANAGER', 'CREATOR', 'ANALYST')
  async dismissInboxItem(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @RealIP() ip: string
  ) {
    return this._inbox.dismissItem(org.id, sessionActor(user, ip), id, itemId);
  }

  // ── W7 blog → social chain: per-brand configuration, secret, runs ───────
  @Get('/:id/blog-chain')
  async getBlogChainSettings(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._blogChain.getBlogChainSettings(org.id, id);
  }

  @Put('/:id/blog-chain')
  @RequireRektrsFunctions('MANAGER')
  async updateBlogChainSettings(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: UpdateBlogChainSettingsDto,
    @Headers('if-match') ifMatch: string,
    @RealIP() ip: string
  ) {
    return this._blogChain.updateBlogChainSettings(
      org.id,
      sessionActor(user, ip),
      id,
      body,
      parseIfMatch(ifMatch)
    );
  }

  @Post('/:id/blog-chain/rotate-secret')
  @RequireRektrsFunctions('MANAGER')
  async rotateBlogChainSecret(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @RealIP() ip: string
  ) {
    // The one response in which the webhook secret ever leaves the server.
    return this._blogChain.rotateBlogChainSecret(
      org.id,
      sessionActor(user, ip),
      id
    );
  }

  @Get('/:id/blog-chain/runs')
  @RequireRektrsFunctions('MANAGER', 'CREATOR', 'ANALYST')
  async listBlogChainRuns(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._blogChain.listBlogChainRuns(org.id, id);
  }

  @Delete('/:id/channels/:integrationId')
  @RequireRektrsFunctions('MANAGER')
  async removeChannel(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Param('integrationId') integrationId: string,
    @RealIP() ip: string
  ) {
    return this._catalog.removeChannel(
      org.id,
      sessionActor(user, ip),
      id,
      integrationId
    );
  }
}
