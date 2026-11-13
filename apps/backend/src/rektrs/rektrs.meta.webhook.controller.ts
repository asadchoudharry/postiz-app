import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { RektrsRepository } from '@gitroom/nestjs-libraries/rektrs/rektrs.repository';
import { RektrsLeadsService } from '@gitroom/nestjs-libraries/rektrs/rektrs.leads.service';
import { verifyMetaWebhookSignature } from '@gitroom/nestjs-libraries/rektrs/rektrs.leads';

/**
 * REKTRS W1 — Meta webhook receiver (real-time comment ingestion).
 *
 * This controller is deliberately NOT behind the session AuthMiddleware
 * (it is registered outside the rektrsControllers list in rektrs.module.ts):
 * Meta is the caller, and the request authenticates by HMAC —
 * X-Hub-Signature-256 over the RAW body with the Meta app secret
 * (REKTRS_META_APP_SECRET), the same pattern as the Stripe controller.
 *
 * Configuration contract (owner/ops step, documented in
 * AUTOMATION-WORKFLOWS.md): the Meta app must be subscribed to the
 * `comments` field (Instagram) / `feed` field (Pages) and pointed at
 * /api/rektrs/webhooks/meta with REKTRS_META_WEBHOOK_VERIFY_TOKEN as the
 * verify token. Until both env values are set the receiver fails CLOSED
 * (503) rather than accepting unauthenticated traffic — and W1 still works
 * without it via the hourly poll sync (RektrsLeadsService.syncLeadComments),
 * which dedupes against the same seen-claims, so enabling the webhook
 * later cannot double-process a comment.
 *
 * After a valid signature the endpoint always answers 200: the lead engine
 * never throws, and a 5xx would only make Meta retry a payload we have
 * already recorded.
 */
@ApiTags('Rektrs Webhooks')
@Controller('/rektrs/webhooks')
export class RektrsMetaWebhookController {
  constructor(
    private _repository: RektrsRepository,
    private _leads: RektrsLeadsService
  ) {}

  @Get('/meta')
  verify(
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') token?: string,
    @Query('hub.challenge') challenge?: string
  ) {
    const expected = process.env.REKTRS_META_WEBHOOK_VERIFY_TOKEN;
    if (!expected) {
      throw new ServiceUnavailableException({
        code: 'META_WEBHOOK_NOT_CONFIGURED',
        message: 'The Meta webhook receiver is not configured',
      });
    }
    if (mode === 'subscribe' && token === expected && challenge) {
      return challenge;
    }
    throw new ForbiddenException({
      code: 'META_WEBHOOK_VERIFY_FAILED',
      message: 'Webhook verification failed',
    });
  }

  @Post('/meta')
  @HttpCode(200)
  async receive(@Req() req: RawBodyRequest<Request>) {
    const appSecret = process.env.REKTRS_META_APP_SECRET;
    if (!appSecret) {
      throw new ServiceUnavailableException({
        code: 'META_WEBHOOK_NOT_CONFIGURED',
        message: 'The Meta webhook receiver is not configured',
      });
    }
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    if (!verifyMetaWebhookSignature(appSecret, signature, rawBody)) {
      throw new ForbiddenException({
        code: 'META_WEBHOOK_SIGNATURE_INVALID',
        message: 'Invalid webhook signature',
      });
    }

    const payload = (req.body || {}) as {
      object?: string;
      entry?: Array<{
        id?: string;
        changes?: Array<{ field?: string; value?: any }>;
      }>;
    };

    for (const entry of payload.entry || []) {
      if (!entry.id) {
        continue;
      }
      // The entry id is the Page id / IG user id == Integration.internalId.
      // The same account may be connected in several orgs; the engine
      // no-ops for any org without an enabled rule on that channel's brand.
      const integrations =
        await this._repository.integrationsByInternalId(entry.id);
      if (!integrations.length) {
        continue;
      }
      for (const change of entry.changes || []) {
        const comment = this.extractComment(payload.object, change);
        if (!comment) {
          continue;
        }
        for (const integration of integrations) {
          await this._leads.processInboundComment(
            integration.organizationId,
            integration,
            { integrationId: integration.id, ...comment }
          );
        }
      }
    }
    return { received: true };
  }

  /** Normalise the two Meta comment shapes into the engine's input. */
  private extractComment(
    object: string | undefined,
    change: { field?: string; value?: any }
  ) {
    const value = change.value || {};
    if (object === 'instagram' && change.field === 'comments') {
      // Instagram comments webhook: value = { id, text, from{id,username},
      // media{id} }.
      if (!value.id || !value.from?.id || !value.media?.id) {
        return null;
      }
      return {
        providerPostId: String(value.media.id),
        commentId: String(value.id),
        text: value.text || '',
        commenterId: String(value.from.id),
        commenterName: value.from.username || undefined,
        commentAt: undefined,
      };
    }
    if (object === 'page' && change.field === 'feed') {
      // Page feed webhook: only NEW comments (verb 'add', item 'comment').
      if (value.item !== 'comment' || value.verb !== 'add') {
        return null;
      }
      if (!value.comment_id || !value.post_id || !value.from?.id) {
        return null;
      }
      return {
        providerPostId: String(value.post_id),
        commentId: String(value.comment_id),
        text: value.message || '',
        commenterId: String(value.from.id),
        commenterName: value.from.name || undefined,
        commentAt: value.created_time
          ? new Date(value.created_time * 1000)
          : undefined,
      };
    }
    return null;
  }
}
