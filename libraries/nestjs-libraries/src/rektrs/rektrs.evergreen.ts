/**
 * REKTRS W3 — Evergreen Recycler, pure domain (AUTOMATION-WORKFLOWS.md W3).
 * No I/O here: metrics extraction from the provider analytics surface,
 * ranking and the deterministic content refresh are pure functions the
 * service and the tests share — one implementation (design §2.3 rule).
 *
 * METRICS TRUTH (verified in this codebase, 2026-11-14): there is NO
 * stored metrics layer. The only per-post engagement surface upstream
 * Postiz has is the providers' optional `postAnalytics(integrationId,
 * accessToken, postId, fromDate): Promise<AnalyticsData[]>`, consumed by
 * PostsService.checkPostAnalytics (token refresh + release-id resolution
 * + 1h redis cache) for the statistics page. AnalyticsData is a LABELLED
 * series: { label, data: [{ total, date }], percentageChange } — labels
 * are provider-specific display strings, not a metric enum:
 *
 *   facebook             Reactions, Clicks, Clicks by Type, Impressions
 *                        (video ids: video_insights labels)
 *   instagram            Likes, Comments, Shares, Saves, Reach, Views,
 *                        Engagement
 *   instagram-standalone delegates to the instagram implementation
 *   x                    Likes, Replies, Retweets, Quotes, Bookmarks,
 *                        Impressions
 *   youtube              Likes, Comments, Views, Favorites
 *   linkedin-page        Likes, Comments, Shares, Clicks, Engagement,
 *                        Impressions, Unique Impressions
 *   threads              Likes, Replies, Reposts, Quotes, Views
 *   tiktok(-business)    Likes, Comments, Shares, Views
 *   pinterest            Impressions, Saves, Pin Clicks, Outbound Clicks
 *                        (NO like/comment/share labels at all)
 *   gmb, dribbble        implement postAnalytics but ALWAYS return []
 *   every other provider does not implement postAnalytics at all
 *
 * Extraction maps the labels onto the snapshot's three honest counters:
 *   likes    ← "Likes", "Reactions" (Facebook's reaction total is its
 *              like-equivalent; there is no separate like counter)
 *   comments ← "Comments", "Replies" (X / Threads call comments replies)
 *   shares   ← "Shares", "Retweets" (X), "Reposts" (Threads)
 * Quotes (X/Threads) are deliberately NOT folded into shares: a quote is
 * a new post, not a plain re-share; it stays visible in the raw series
 * the snapshot also stores. Reach/views/impressions/clicks/saves are
 * exposure, not engagement, and never enter the score.
 *
 * A post whose fetched series yields NONE of the three counters has NO
 * measurable engagement: extraction returns null and the scan skips it
 * with reason NO_METRICS. Numbers are never invented, estimated or
 * carried over from another post.
 */

export type RektrsEvergreenStyleMode = 'VERBATIM' | 'HOOK' | 'ROTATE';
export type RektrsEvergreenAppliedStyle = 'VERBATIM' | 'HOOK';

export const REKTRS_EVERGREEN_STYLE_MODES: readonly RektrsEvergreenStyleMode[] =
  ['VERBATIM', 'HOOK', 'ROTATE'];

export const REKTRS_EVERGREEN_DEFAULTS = {
  minAgeDays: 45,
  topN: 3,
  styleMode: 'ROTATE' as RektrsEvergreenStyleMode,
  /** Org schedule defaults: Monday (UTC weekday 1) at 06:00 UTC. */
  weekday: 1,
  hour: 6,
} as const;

/** One labelled total as fetched from the provider (latest point wins). */
export interface RektrsMetricPoint {
  label: string;
  total: number;
}

export interface RektrsPostMetrics {
  likes: number | null;
  comments: number | null;
  shares: number | null;
  /** likes + comments + shares over the counters that were fetched. */
  score: number;
  /** Every numeric label the provider returned, for the snapshot. */
  series: RektrsMetricPoint[];
  fetchedAt: string;
}

const LIKE_LABELS = ['Likes', 'Reactions'];
const COMMENT_LABELS = ['Comments', 'Replies'];
const SHARE_LABELS = ['Shares', 'Retweets', 'Reposts'];

function latestTotal(
  points: Array<{ total: string; date: string }> | undefined
): number | null {
  if (!points?.length) {
    return null;
  }
  const sorted = [...points].sort((a, b) =>
    String(a.date).localeCompare(String(b.date))
  );
  for (let i = sorted.length - 1; i >= 0; i--) {
    const value = Number(sorted[i].total);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

/**
 * Reduce a provider AnalyticsData[] series to the snapshot metrics.
 * Returns null when none of likes/comments/shares could be measured —
 * the caller treats that as "no measurable engagement", never as zero.
 */
export function extractPostMetrics(
  series:
    | Array<{
        label: string;
        data: Array<{ total: string; date: string }>;
      }>
    | null
    | undefined,
  fetchedAt: Date = new Date()
): RektrsPostMetrics | null {
  if (!series?.length) {
    return null;
  }
  const byLabel = new Map<string, number>();
  for (const entry of series) {
    const total = latestTotal(entry.data);
    if (total === null) {
      continue;
    }
    byLabel.set(entry.label, (byLabel.get(entry.label) ?? 0) + total);
  }
  const pick = (labels: string[]): number | null => {
    let found: number | null = null;
    for (const label of labels) {
      const value = byLabel.get(label);
      if (value !== undefined) {
        found = (found ?? 0) + value;
      }
    }
    return found;
  };
  const likes = pick(LIKE_LABELS);
  const comments = pick(COMMENT_LABELS);
  const shares = pick(SHARE_LABELS);
  if (likes === null && comments === null && shares === null) {
    return null;
  }
  return {
    likes,
    comments,
    shares,
    score: (likes ?? 0) + (comments ?? 0) + (shares ?? 0),
    series: [...byLabel.entries()]
      .map(([label, total]) => ({ label, total }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    fetchedAt: fetchedAt.toISOString(),
  };
}

export interface RektrsRankedCandidate<T> {
  item: T;
  metrics: RektrsPostMetrics;
  publishDate: Date;
  id: string;
}

/**
 * Deterministic ranking: engagement score desc, then most recently
 * published first, then id asc (a total order — the same inputs always
 * produce the same top-N). Zero-score posts ARE ranked (zero is a real
 * measurement) but land below every positive score.
 */
export function rankEvergreenCandidates<T>(
  candidates: Array<RektrsRankedCandidate<T>>
): Array<RektrsRankedCandidate<T>> {
  return [...candidates].sort((a, b) => {
    if (b.metrics.score !== a.metrics.score) {
      return b.metrics.score - a.metrics.score;
    }
    const byDate = b.publishDate.getTime() - a.publishDate.getTime();
    if (byDate !== 0) {
      return byDate;
    }
    return a.id.localeCompare(b.id);
  });
}

/**
 * Which style the Nth copy of a run gets. `copiesBefore` counts the
 * brand's copies that already exist (history) plus the ones this run has
 * already made, so the rotation CONTINUES across cycles instead of
 * restarting every week: VERBATIM, HOOK, VERBATIM, HOOK, …
 * HOOK without a configured hook line degrades to VERBATIM — the copy
 * row records the style that was ACTUALLY applied.
 */
export function pickEvergreenStyle(
  styleMode: RektrsEvergreenStyleMode,
  copiesBefore: number,
  hookLines: string[]
): { style: RektrsEvergreenAppliedStyle; hookLine: string | null } {
  const hook =
    hookLines.length > 0
      ? hookLines[copiesBefore % hookLines.length]
      : null;
  if (styleMode === 'VERBATIM') {
    return { style: 'VERBATIM', hookLine: null };
  }
  if (styleMode === 'HOOK') {
    return hook
      ? { style: 'HOOK', hookLine: hook }
      : { style: 'VERBATIM', hookLine: null };
  }
  // ROTATE
  if (copiesBefore % 2 === 1 && hook) {
    return { style: 'HOOK', hookLine: hook };
  }
  return { style: 'VERBATIM', hookLine: null };
}

/**
 * The deterministic refresh itself. VERBATIM returns the content
 * untouched; HOOK prepends the brand's hook line as its own paragraph.
 * No AI, no randomness — the same inputs always produce the same copy.
 */
export function applyEvergreenStyle(
  content: string,
  style: RektrsEvergreenAppliedStyle,
  hookLine: string | null
): string {
  if (style === 'HOOK' && hookLine) {
    return `${hookLine}\n\n${content}`;
  }
  return content;
}

/**
 * Hook lines are display text (they are prepended verbatim), so unlike
 * W1 phrases they are NOT case-folded: trim, drop empties, dedupe
 * case-insensitively, keep the first spelling.
 */
export function normalizeHookLines(
  values: string[] | null | undefined
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values || []) {
    const line = String(raw).normalize('NFC').replace(/\s+/g, ' ').trim();
    if (!line) {
      continue;
    }
    const key = line.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(line);
  }
  return out;
}
