import { Injectable } from '@nestjs/common';
import { Integration } from '@prisma/client';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import {
  ProviderPostComment,
  SocialProviderComments,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';

/**
 * REKTRS W1 — the provider boundary for comment ingestion + comment-to-DM.
 *
 * Provider truth (verified in this codebase): upstream Postiz has NO
 * inbound provider-comment ingestion at all — the `Comments` model is the
 * internal review-comment system — and NO DM send path. The two Meta
 * providers gained the missing primitives for W1
 * (`SocialProviderComments`: Graph comments read + private reply), and
 * this gateway is the ONLY way the lead engine touches them, so tests mock
 * here and the engine never sees a raw provider.
 *
 * Two ingestion sources feed the engine the same normalised shape:
 *  - the Meta webhook receiver (backend, real-time when the Meta app is
 *    subscribed to the comments/feed fields);
 *  - the hourly poller (RektrsLeadsService.syncLeadComments), which reads
 *    comments through this gateway for every W1-enabled brand channel.
 */

export interface RektrsInboundComment {
  integrationId: string;
  providerPostId: string;
  commentId: string;
  text: string;
  commenterId: string;
  commenterName?: string;
  commentAt?: Date;
}

export type RektrsLeadIntegration = Pick<
  Integration,
  'id' | 'organizationId' | 'providerIdentifier' | 'token' | 'internalId'
>;

/** Providers whose channels W1 can run on today (DM-capable, per the spec). */
export const REKTRS_LEAD_PROVIDER_IDENTIFIERS = [
  'facebook',
  'instagram',
] as const;

@Injectable()
export class RektrsCommentGateway {
  constructor(private _integrationManager: IntegrationManager) {}

  private providerFor(
    integration: RektrsLeadIntegration
  ): SocialProviderComments | null {
    if (
      !(REKTRS_LEAD_PROVIDER_IDENTIFIERS as readonly string[]).includes(
        integration.providerIdentifier
      )
    ) {
      return null;
    }
    const provider = this._integrationManager.getSocialIntegration(
      integration.providerIdentifier
    ) as unknown as Partial<SocialProviderComments> | undefined;
    if (
      !provider ||
      typeof provider.getPostComments !== 'function' ||
      typeof provider.sendCommentPrivateReply !== 'function'
    ) {
      return null;
    }
    return provider as SocialProviderComments;
  }

  supports(integration: RektrsLeadIntegration): boolean {
    return !!this.providerFor(integration);
  }

  async fetchPostComments(
    integration: RektrsLeadIntegration,
    providerPostId: string
  ): Promise<RektrsInboundComment[]> {
    const provider = this.providerFor(integration);
    if (!provider) {
      return [];
    }
    const comments: ProviderPostComment[] = await provider.getPostComments(
      providerPostId,
      integration.token,
      integration as Integration
    );
    return comments
      .filter((c) => !!c.id && !!c.commenterId)
      .map((c) => ({
        integrationId: integration.id,
        providerPostId,
        commentId: c.id,
        text: c.text || '',
        commenterId: c.commenterId,
        commenterName: c.commenterName,
        commentAt: c.createdAt ? new Date(c.createdAt) : undefined,
      }));
  }

  async sendPrivateReply(
    integration: RektrsLeadIntegration,
    commentId: string,
    message: string
  ): Promise<{ messageId?: string }> {
    const provider = this.providerFor(integration);
    if (!provider) {
      throw new Error(
        `Provider ${integration.providerIdentifier} cannot send comment DMs`
      );
    }
    return provider.sendCommentPrivateReply(
      commentId,
      message,
      integration.token,
      integration as Integration
    );
  }
}
