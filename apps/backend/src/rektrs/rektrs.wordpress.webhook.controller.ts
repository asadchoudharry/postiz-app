import { Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { RektrsBlogChainService } from '@gitroom/nestjs-libraries/rektrs/rektrs.blog-chain.service';

/**
 * REKTRS W7 — WordPress webhook receiver (blog → social chain).
 *
 * Deliberately NOT behind the session AuthMiddleware (registered outside
 * the rektrsControllers list in rektrs.module.ts, like the W1 Meta
 * receiver): WordPress is the caller, and the request authenticates by
 * the PER-BRAND secret — `X-Rektrs-Signature: sha256=<hex>` (HMAC-SHA256
 * over the RAW body) or the `X-Rektrs-Secret` shared-secret header.
 *
 * Public path: POST /api/rektrs/webhooks/wordpress/<brand id or slug>.
 * The frontend proxy matcher excludes /api/* from the login redirect, so
 * no allowlist change is needed (the same route the Meta receiver uses).
 *
 * Fail-closed contract (enforced in RektrsBlogChainService): unknown
 * brand → 404; chain disabled → 404; enabled but no secret rotated yet →
 * 503; signature mismatch → 401. After authentication the endpoint
 * always answers 200 — including for paused brands (recorded, nothing
 * created), non-publish statuses (ignored) and duplicates (dedupe) — so
 * WordPress never retry-storms a delivery we have already recorded.
 */
@ApiTags('Rektrs Webhooks')
@Controller('/rektrs/webhooks')
export class RektrsWordpressWebhookController {
  constructor(private _blogChain: RektrsBlogChainService) {}

  @Post('/wordpress/:brandKey')
  @HttpCode(200)
  async receive(
    @Param('brandKey') brandKey: string,
    @Req() req: RawBodyRequest<Request>
  ) {
    const rawBody =
      req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    return this._blogChain.handleWordpressWebhook(
      brandKey,
      {
        signature: req.headers['x-rektrs-signature'] as string | undefined,
        sharedSecret: req.headers['x-rektrs-secret'] as string | undefined,
        rawBody,
      },
      (req.body || {}) as Record<string, unknown>
    );
  }
}
