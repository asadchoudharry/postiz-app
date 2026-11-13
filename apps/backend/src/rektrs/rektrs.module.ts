import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AuthMiddleware } from '@gitroom/backend/services/auth/auth.middleware';
import { RektrsBrandsController } from '@gitroom/backend/rektrs/rektrs.brands.controller';
import { RektrsCampaignsController } from '@gitroom/backend/rektrs/rektrs.campaigns.controller';
import {
  RektrsReviewController,
  RektrsSubmissionsController,
} from '@gitroom/backend/rektrs/rektrs.submissions.controller';
import {
  RektrsAuditController,
  RektrsOrgController,
} from '@gitroom/backend/rektrs/rektrs.org.controller';
import { RektrsLeadsController } from '@gitroom/backend/rektrs/rektrs.leads.controller';
import { RektrsMetaWebhookController } from '@gitroom/backend/rektrs/rektrs.meta.webhook.controller';
import { RektrsFunctionsGuard } from '@gitroom/backend/rektrs/rektrs.functions.guard';

const rektrsControllers = [
  RektrsBrandsController,
  RektrsCampaignsController,
  RektrsSubmissionsController,
  RektrsReviewController,
  RektrsOrgController,
  RektrsAuditController,
  RektrsLeadsController,
];

/**
 * REKTRS P3 HTTP surface (design P3-1 §3.1): mounts beside ApiModule under
 * the same /api prefix (the frontend proxy maps /api/rektrs/v1/* here),
 * reuses the session AuthMiddleware and @GetOrgFromRequest /
 * @GetUserFromRequest resolution — the org is never a request parameter.
 * Domain services live in @gitroom/nestjs-libraries (global DatabaseModule).
 */
@Module({
  imports: [],
  // The Meta webhook receiver is registered as a controller but kept OUT
  // of rektrsControllers on purpose: AuthMiddleware applies only to that
  // list, and Meta authenticates by HMAC signature, not by session.
  controllers: [...rektrsControllers, RektrsMetaWebhookController],
  providers: [AuthMiddleware, RektrsFunctionsGuard],
})
export class RektrsModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AuthMiddleware).forRoutes(...rektrsControllers);
  }
}
