import { Injectable } from '@nestjs/common';
import { Integration, Post } from '@prisma/client';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import {
  ISocialMediaIntegration,
  PostResponse,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';

/**
 * REKTRS W6 — the provider boundary for posting an inbox reply.
 *
 * This is the W4 gateway pattern (RektrsCtaCommentGateway) with ONE
 * deliberate difference: the reply is aimed at the inbound comment, so
 * the provider call receives the original comment's provider id as
 * `lastCommentId`. What that means per provider (verified in code):
 *
 *   facebook             comment() uses `lastCommentId || postId` as the
 *                        Graph target → the reply lands IN THE THREAD of
 *                        the original comment ✓ threaded
 *   instagram            comment() ignores lastCommentId and posts on
 *                        the media → the reply is a new comment ON the
 *                        post (Graph's reply endpoint is not what the
 *                        upstream primitive calls) — still a real,
 *                        visible reply, recorded as such
 *   instagram-standalone delegates to instagram — same behaviour
 *   x                    comment() creates a reply tweet on the post ✓
 *   linkedin/-page       comment() posts on the post's socialActions ✓
 *   youtube / tiktok     NO comment() exists → replies are impossible
 *                        from here; the item says so in its note and a
 *                        human answers on the platform itself
 *
 * The gateway is the only door to the primitive (tests mock here), the
 * provider post id is resolved through PostsService.resolveRelease (the
 * same resolution W3/W4 use), and a reply counts as sent ONLY when the
 * provider returns a comment id — anything else throws and the service
 * records the provider's error on the item.
 */

export type RektrsInboxReplyIntegration = Pick<
  Integration,
  'id' | 'organizationId' | 'providerIdentifier' | 'token' | 'internalId'
>;

export interface RektrsPostedReply {
  commentId: string;
  releaseURL?: string;
}

/** Providers whose comment() threads the reply onto the comment itself. */
const THREADED_REPLY_PROVIDERS = new Set(['facebook']);

@Injectable()
export class RektrsInboxReplyGateway {
  constructor(
    private _integrationManager: IntegrationManager,
    private _posts: PostsService
  ) {}

  private providerFor(
    integration: RektrsInboxReplyIntegration
  ): ISocialMediaIntegration | null {
    const provider = this._integrationManager.getSocialIntegration(
      integration.providerIdentifier
    ) as ISocialMediaIntegration | undefined;
    if (!provider || typeof provider.comment !== 'function') {
      return null;
    }
    return provider;
  }

  /** True when the channel's provider can post a reply at all. */
  supportsReply(integration: RektrsInboxReplyIntegration): boolean {
    return !!this.providerFor(integration);
  }

  /**
   * The honest capability note stored on every triaged item, so the
   * inbox screen can tell the human exactly what "Send reply" will do
   * on this channel before they press it. Null = plain comment-capable,
   * nothing worth noting.
   */
  capabilityNote(integration: RektrsInboxReplyIntegration): string | null {
    if (!this.supportsReply(integration)) {
      return 'This channel cannot post replies from REKTRS Social — answer on the platform itself.';
    }
    if (THREADED_REPLY_PROVIDERS.has(integration.providerIdentifier)) {
      return 'Replies are posted inside the original comment’s thread.';
    }
    if (
      integration.providerIdentifier === 'instagram' ||
      integration.providerIdentifier === 'instagram-standalone'
    ) {
      return 'Replies are posted as a new comment on the post.';
    }
    return null;
  }

  /**
   * Post `message` as the reply to the given inbound comment. Throws on
   * any failure — an unresolved release, a provider error, or a provider
   * response without a comment id — so the caller records an honest
   * failure; it NEVER returns a fabricated success.
   */
  async postReply(
    orgId: string,
    integration: RektrsInboxReplyIntegration,
    post: Pick<Post, 'id' | 'releaseId' | 'releaseURL' | 'settings'>,
    replyToCommentId: string,
    message: string
  ): Promise<RektrsPostedReply> {
    const provider = this.providerFor(integration);
    if (!provider) {
      throw new Error(
        `Provider ${integration.providerIdentifier} cannot post comments`
      );
    }
    if (!post.releaseId || post.releaseId === 'missing') {
      throw new Error('Post has no provider release id to reply on');
    }
    const fullIntegration = integration as Integration;
    const resolved = await this._posts.resolveRelease(orgId, {
      id: post.id,
      releaseId: post.releaseId,
      releaseURL: post.releaseURL,
      settings: post.settings,
      integration: fullIntegration,
    });
    if (resolved.pending || resolved.unavailable || !resolved.releaseId) {
      throw new Error('Post release is not available for replying yet');
    }
    const responses: PostResponse[] = await provider.comment!(
      integration.internalId,
      resolved.releaseId,
      replyToCommentId,
      integration.token,
      [{ id: post.id, message, settings: {}, media: [] }],
      fullIntegration
    );
    const [response] = responses || [];
    if (!response?.postId) {
      throw new Error('Provider returned no comment id');
    }
    return { commentId: response.postId, releaseURL: response.releaseURL };
  }
}
