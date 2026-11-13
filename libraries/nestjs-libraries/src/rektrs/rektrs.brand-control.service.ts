import { Injectable, Logger } from '@nestjs/common';
import { Post } from '@prisma/client';
import { RektrsRepository } from './rektrs.repository';
import { RektrsAuditService } from './rektrs.audit.service';
import { RektrsCatalogService } from './rektrs.catalog.service';
import { RektrsAlertsService } from './rektrs.alerts.service';
import { RektrsActor } from './rektrs.actor';
import { RektrsException } from './rektrs.errors';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';

export interface RektrsResumeSkip {
  postId: string;
  reason: string;
  message?: string;
}

/**
 * REKTRS W5 — Crisis Kill-Switch (AUTOMATION-WORKFLOWS.md W5).
 *
 * PAUSE (MANAGER): the brand row is marked first, so Gate A refuses any
 * schedule attempt from that instant and Gate B refuses any publish that
 * was already in flight. Then every QUEUE post on the brand's channels is
 * pulled back to DRAFT (workflows terminated, SCHEDULED submissions return
 * to APPROVED) via PostsService — post manipulation stays in PostsService
 * (design §4). The pulled group roots + their publish dates are snapshotted
 * in rektrs_brand_paused_posts for the resume. Re-pausing an already-paused
 * brand is a no-op for the brand row but still completes the pull-back for
 * anything queued since (idempotent AND completing).
 *
 * RESUME (MANAGER): the pause is lifted first, the snapshot consumed, and
 * each snapshotted root is restored individually — publish date restored
 * (date-only changeDate, ungated), then re-queued through the NORMAL gate
 * path (changePostStatus 'schedule' → Gate A). A post whose approval no
 * longer stands (invalidated while paused), whose content drifted, or
 * which is no longer a draft is left as a draft and reported in `skipped`;
 * the brand stays resumed either way.
 *
 * Both actions are audit-logged (brand.pause / brand.resume /
 * brand.resume_posts) and the team is notified via the alerts fan-out.
 */
@Injectable()
export class RektrsBrandControlService {
  private readonly _logger = new Logger(RektrsBrandControlService.name);

  constructor(
    private _repository: RektrsRepository,
    private _audit: RektrsAuditService,
    private _catalog: RektrsCatalogService,
    private _posts: PostsService,
    private _alerts: RektrsAlertsService
  ) {}

  async pauseBrand(
    orgId: string,
    actor: RektrsActor,
    brandId: string,
    reason?: string
  ) {
    const brand = await this._catalog.getBrand(orgId, brandId);
    let alreadyPaused = !!brand.pausedAt;
    const integrationIds = (brand.channels || []).map((c) => c.integrationId);

    if (!alreadyPaused) {
      // Claim the pause atomically: a racing second pause sees count 0 and
      // falls into the completion path below instead of double-marking.
      const claimed = await this._repository.db().brand.updateMany({
        where: { id: brandId, organizationId: orgId, pausedAt: null },
        data: {
          pausedAt: new Date(),
          pausedById: actor.userId,
          pauseReason: reason?.trim() ? reason.trim().slice(0, 500) : null,
          version: { increment: 1 },
        },
      });
      if (!claimed.count) {
        alreadyPaused = true;
      }
    }

    // Pull-back set: everything QUEUE on the brand's channels right now.
    const queued = await this._repository.queuedPostsOfChannels(
      orgId,
      integrationIds
    );
    const roots = snapshotRoots(queued);
    const existingSnapshots = alreadyPaused
      ? await this._repository.brandPausedPosts(brandId)
      : [];
    const knownPostIds = new Set(existingSnapshots.map((s) => s.postId));
    const newRoots = roots.filter((r) => !knownPostIds.has(r.id));

    if (newRoots.length) {
      await this._repository.transaction(async (tx) => {
        await this._repository.db(tx).brandPausedPost.createMany({
          data: newRoots.map((root) => ({
            brandId,
            postId: root.id,
            group: root.group,
            batchId: root.batchId,
            publishDate: root.publishDate,
          })),
          skipDuplicates: true,
        });
        await this._audit.write(
          orgId,
          actor,
          {
            action: 'brand.pause',
            entityType: 'Brand',
            entityId: brandId,
            metadata: {
              alreadyPaused,
              reason: reason?.trim() || undefined,
              pulledPostIds: newRoots.map((r) => r.id),
              pulledCount: newRoots.length,
            },
          },
          tx
        );
      });
    } else if (!alreadyPaused) {
      await this._audit.write(orgId, actor, {
        action: 'brand.pause',
        entityType: 'Brand',
        entityId: brandId,
        metadata: {
          alreadyPaused: false,
          reason: reason?.trim() || undefined,
          pulledPostIds: [],
          pulledCount: 0,
        },
      });
    }

    // Post manipulation (state changes + workflow termination) lives in
    // PostsService; it runs after the brand row is marked, so Gate A/B
    // already refuse anything new for this brand.
    if (queued.length) {
      await this._posts.rektrsDequeueBrandPosts(orgId, queued as Post[]);
    }

    const fresh = await this._catalog.getBrand(orgId, brandId);
    if (!alreadyPaused || newRoots.length) {
      await this._alerts
        .alertBrandPaused(
          orgId,
          fresh,
          newRoots.length,
          reason?.trim() || undefined
        )
        .catch((e) =>
          this._logger.warn(`REKTRS pause notice failed: ${String(e)}`)
        );
    }
    return {
      brand: fresh,
      alreadyPaused,
      pulledPostIds: newRoots.map((r) => r.id),
      pulledCount: newRoots.length,
    };
  }

  async resumeBrand(orgId: string, actor: RektrsActor, brandId: string) {
    const brand = await this._catalog.getBrand(orgId, brandId);
    if (!brand.pausedAt) {
      return {
        brand,
        alreadyLive: true,
        restored: [] as string[],
        skipped: [] as RektrsResumeSkip[],
      };
    }
    const snapshots = await this._repository.brandPausedPosts(brandId);

    // Lift the pause + consume the snapshot atomically, BEFORE re-queueing:
    // Gate A must see a live brand for the restores to pass through it.
    await this._repository.transaction(async (tx) => {
      await this._repository.db(tx).brand.updateMany({
        where: { id: brandId, organizationId: orgId },
        data: {
          pausedAt: null,
          pausedById: null,
          pauseReason: null,
          version: { increment: 1 },
        },
      });
      await this._repository.db(tx).brandPausedPost.deleteMany({
        where: { brandId },
      });
      await this._audit.write(
        orgId,
        actor,
        {
          action: 'brand.resume',
          entityType: 'Brand',
          entityId: brandId,
          metadata: { snapshotCount: snapshots.length },
        },
        tx
      );
    });

    const restored: string[] = [];
    const skipped: RektrsResumeSkip[] = [];
    for (const snapshot of snapshots) {
      const post = await this._repository.postById(orgId, snapshot.postId);
      if (!post) {
        skipped.push({ postId: snapshot.postId, reason: 'POST_NOT_FOUND' });
        continue;
      }
      if (post.state !== 'DRAFT') {
        skipped.push({
          postId: snapshot.postId,
          reason: 'NOT_DRAFT',
          message: `Post is ${post.state}, not DRAFT — left untouched`,
        });
        continue;
      }
      try {
        // Restore the original publish date (date-only change: ungated),
        // then re-queue through the normal Gate A funnel. If the approval
        // no longer stands, Gate A throws and the post stays a draft.
        await this._posts.changeDate(
          orgId,
          post.id,
          new Date(snapshot.publishDate).toISOString(),
          'update'
        );
        await this._posts.changePostStatus(orgId, post.id, 'schedule');
        await this._posts.rektrsRestoreGroupMembers(orgId, snapshot.group);
        restored.push(post.id);
      } catch (e) {
        skipped.push({
          postId: snapshot.postId,
          reason:
            e instanceof RektrsException ? e.code : 'RESTORE_FAILED',
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }

    await this._audit.write(orgId, actor, {
      action: 'brand.resume_posts',
      entityType: 'Brand',
      entityId: brandId,
      metadata: { restored, skipped },
    });

    const fresh = await this._catalog.getBrand(orgId, brandId);
    await this._alerts
      .alertBrandResumed(orgId, fresh, restored.length, skipped.length)
      .catch((e) =>
        this._logger.warn(`REKTRS resume notice failed: ${String(e)}`)
      );
    return { brand: fresh, alreadyLive: false, restored, skipped };
  }
}

/**
 * One snapshot root per post group: the row without a parent in the pulled
 * set (falling back to the group's earliest row for orphaned children).
 */
export function snapshotRoots(posts: Post[]): Post[] {
  const byGroup = new Map<string, Post[]>();
  for (const post of posts) {
    const rows = byGroup.get(post.group) || [];
    rows.push(post);
    byGroup.set(post.group, rows);
  }
  const roots: Post[] = [];
  for (const rows of byGroup.values()) {
    const ids = new Set(rows.map((r) => r.id));
    const root =
      rows.find((r) => !r.parentPostId || !ids.has(r.parentPostId)) || rows[0];
    roots.push(root);
  }
  return roots;
}
