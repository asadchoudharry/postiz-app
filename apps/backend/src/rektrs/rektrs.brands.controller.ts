import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization, User } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { RektrsCatalogService } from '@gitroom/nestjs-libraries/rektrs/rektrs.catalog.service';
import {
  AssignChannelDto,
  CreateBrandDto,
  UpdateBrandDto,
} from '@gitroom/nestjs-libraries/dtos/rektrs/rektrs.dto';
import {
  RektrsFunctionsGuard,
  RequireRektrsFunctions,
} from '@gitroom/backend/rektrs/rektrs.functions.guard';
import { requireIfMatch, sessionActor } from '@gitroom/backend/rektrs/rektrs.http';
import { RealIP } from 'nestjs-real-ip';

@ApiTags('Rektrs Brands')
@Controller('/rektrs/v1/brands')
@UseGuards(RektrsFunctionsGuard)
export class RektrsBrandsController {
  constructor(private _catalog: RektrsCatalogService) {}

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
