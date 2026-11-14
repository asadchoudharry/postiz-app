import { Injectable } from '@nestjs/common';
import { Integration, Post } from '@prisma/client';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { AnalyticsData } from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';

/**
 * REKTRS W3 — the provider boundary for evergreen engagement metrics.
 *
 * There is NO stored metrics layer in Postiz (P6 builds one later), so
 * the recycler measures engagement at scan time through the SAME surface
 * the statistics page uses: PostsService.checkPostAnalytics, which wraps
 * the provider's optional `postAnalytics` with token refresh, release-id
 * resolution and a 1h redis cache. This gateway is the only door between
 * the evergreen engine and that surface, so tests mock here and the
 * engine never sees a raw provider (the W1 gateway pattern).
 *
 * Three honest outcomes per post:
 *  - 'ok'          — the provider returned a labelled series (possibly
 *                    with no engagement labels in it; extraction decides)
 *  - 'unsupported' — the provider implements no postAnalytics at all
 *  - 'missing'     — the provider reports the post itself as missing
 * A thrown error propagates: the engine records METRICS_FETCH_FAILED for
 * that post and moves on (one bad channel never fails a brand's run).
 */
export type RektrsEngagementFetch =
  | { kind: 'ok'; series: AnalyticsData[] }
  | { kind: 'unsupported' }
  | { kind: 'missing' };

export type RektrsPostIntegration = Pick<
  Integration,
  'id' | 'organizationId' | 'providerIdentifier'
>;

@Injectable()
export class RektrsEngagementGateway {
  constructor(
    private _integrationManager: IntegrationManager,
    private _posts: PostsService
  ) {}

  /** True when the channel's provider implements per-post analytics. */
  supports(integration: RektrsPostIntegration): boolean {
    const provider = this._integrationManager.getSocialIntegration(
      integration.providerIdentifier
    ) as { postAnalytics?: unknown } | undefined;
    return !!provider && typeof provider.postAnalytics === 'function';
  }

  async fetchPostMetrics(
    orgId: string,
    post: Pick<Post, 'id' | 'publishDate'>
  ): Promise<RektrsEngagementFetch> {
    const result = await this._posts.checkPostAnalytics(
      orgId,
      post.id,
      post.publishDate.getTime()
    );
    if (Array.isArray(result)) {
      return { kind: 'ok', series: result };
    }
    if (result) {
      return { kind: 'missing' };
    }
    return { kind: 'ok', series: [] };
  }
}
