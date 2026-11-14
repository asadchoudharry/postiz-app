import { Injectable } from '@nestjs/common';
import { Integration, Post } from '@prisma/client';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import {
  ISocialMediaIntegration,
  PostResponse,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';

/**
 * REKTRS W4 — the provider boundary for posting a first comment.
 *
 * Provider truth (verified in this codebase, 2026-11-14): upstream Postiz
 * already carries ONE comment-posting primitive — the optional
 * `ISocialMediaIntegration.comment(id, postId, lastCommentId, token,
 * postDetails, integration)` the post workflow uses to publish thread
 * continuations (the orchestrator's `isCommentable` activity feature-
 * detects exactly this method). What `comment()` does per provider:
 *
 *   facebook             POST /{postId}/comments (Graph) — a comment ON
 *                        the post ✓
 *   instagram            POST /{mediaId}/comments (Graph) ✓
 *   instagram-standalone delegates to instagram (graph.instagram.com) ✓
 *   x                    POST /2/tweets with reply.in_reply_to_tweet_id —
 *                        a reply ON the post ✓
 *   threads              reply thread created + published on the post ✓
 *   linkedin             POST /rest/socialActions/{postId}/comments ✓
 *   linkedin-page        delegates to linkedin with the company actor ✓
 *   youtube              NO comment() — cannot post comments ✗
 *   tiktok / -business   NO comment() — cannot post comments ✗
 *   (discord, slack, telegram, reddit, bluesky, mastodon, … implement
 *    comment() for thread messages, but none of them exposes a like
 *    counter through postAnalytics, so the W4 engine's metrics gate
 *    skips them NO_METRICS / CHANNEL_UNSUPPORTED before a comment is
 *    ever attempted — the comment path is only ever reached for a
 *    provider whose likes were actually measured.)
 *
 * The effective W4 set is therefore the intersection — measurable likes
 * AND a comment path: facebook, instagram, instagram-standalone, x,
 * linkedin-page, threads. YouTube and TikTok measure likes but cannot
 * comment → the engine records PROVIDER_COMMENT_UNSUPPORTED and NEVER
 * fakes a posted comment.
 *
 * This gateway is the only door to the primitive (the W1/W3 gateway
 * pattern): the engine never sees a raw provider, tests mock here. The
 * provider post id is resolved through PostsService.resolveRelease — the
 * same resolution checkPostAnalytics uses — and a comment counts as
 * posted ONLY when the provider returns its comment id; anything else
 * throws and the engine records CTA_FAILED with the error.
 */

export type RektrsCommentPostIntegration = Pick<
  Integration,
  'id' | 'organizationId' | 'providerIdentifier' | 'token' | 'internalId'
>;

export interface RektrsPostedComment {
  commentId: string;
  releaseURL?: string;
}

@Injectable()
export class RektrsCtaCommentGateway {
  constructor(
    private _integrationManager: IntegrationManager,
    private _posts: PostsService
  ) {}

  private providerFor(
    integration: RektrsCommentPostIntegration
  ): ISocialMediaIntegration | null {
    const provider = this._integrationManager.getSocialIntegration(
      integration.providerIdentifier
    ) as ISocialMediaIntegration | undefined;
    if (!provider || typeof provider.comment !== 'function') {
      return null;
    }
    return provider;
  }

  /** True when the channel's provider can post a comment on a post. */
  supports(integration: RektrsCommentPostIntegration): boolean {
    return !!this.providerFor(integration);
  }

  /**
   * Post `message` as a comment on the given published post. Throws on
   * any failure — an unresolved release, a provider error, or a provider
   * response without a comment id — so the caller can record an honest
   * CTA_FAILED; it NEVER returns a fabricated success.
   */
  async postComment(
    orgId: string,
    integration: RektrsCommentPostIntegration,
    post: Pick<Post, 'id' | 'releaseId' | 'releaseURL' | 'settings'>,
    message: string
  ): Promise<RektrsPostedComment> {
    const provider = this.providerFor(integration);
    if (!provider) {
      throw new Error(
        `Provider ${integration.providerIdentifier} cannot post comments`
      );
    }
    if (!post.releaseId || post.releaseId === 'missing') {
      throw new Error('Post has no provider release id to comment on');
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
      throw new Error('Post release is not available for commenting yet');
    }
    const responses: PostResponse[] = await provider.comment!(
      integration.internalId,
      resolved.releaseId,
      undefined,
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
