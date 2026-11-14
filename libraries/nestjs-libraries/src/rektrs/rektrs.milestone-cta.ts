/**
 * REKTRS W4 — Milestone Auto-CTA, pure domain (AUTOMATION-WORKFLOWS.md W4).
 * No I/O here: threshold judgement, CTA comment composition and settings
 * normalisation are pure functions the service and the tests share — one
 * implementation (design §2.3 rule).
 *
 * The LIKE threshold is judged on the W3 metrics extraction
 * (rektrs.evergreen.ts `extractPostMetrics`): likes ← the provider's
 * "Likes" / "Reactions" labels, measured live at scan time through
 * PostsService.checkPostAnalytics. A post whose fetched series yields NO
 * like counter has NO measurable likes: extraction still returns a
 * snapshot when other counters exist, but `likes` is null and the engine
 * skips the post NO_METRICS — a like threshold can never be judged on a
 * counter the provider did not supply. Numbers are never invented.
 */

export const REKTRS_MILESTONE_CTA_DEFAULTS = {
  /** Spec default: a post fires its CTA at 20 likes. */
  likeThreshold: 20,
  /** A failing CTA is retried on later cycles up to this many attempts. */
  maxAttempts: 3,
  /** Only posts published inside this window are scanned (spec). */
  windowDays: 30,
  /** Candidate pool cap per brand per run (mirrors the W3 residual). */
  candidateCap: 100,
} as const;

/** Terminal + retryable states of one post's CTA (the dedupe row). */
export type RektrsMilestoneCtaStatus =
  | 'CTA_POSTED'
  | 'CTA_FAILED'
  | 'CTA_EXHAUSTED';

/**
 * The threshold judgement: a measured like count at or above the brand's
 * threshold fires. `null` (not measurable) NEVER fires — absence of a
 * measurement is not zero, and zero is below every legal threshold
 * (thresholds are ≥ 1).
 */
export function crossesLikeThreshold(
  likes: number | null,
  likeThreshold: number
): boolean {
  return likes !== null && likes >= likeThreshold;
}

/** CTA text is display text: collapse whitespace, trim, keep spelling. */
export function normalizeCtaText(value: string | null | undefined): string {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * CTA URL: only http(s) URLs are postable. Returns the normalised URL, or
 * null when a non-empty value is not an http(s) URL (the service refuses
 * the save with CTA_URL_INVALID instead of posting a broken link).
 */
export function normalizeCtaUrl(value: string | null | undefined): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return '';
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  return parsed.toString();
}

/**
 * ── W4→P5 HOOK — first-comment link shortening lands with P5 ────────────
 * The blueprint's first-comment shortener is a P5 build item and does NOT
 * exist yet. (Upstream Postiz carries a ShortLinkService, but it is an
 * env-keyed THIRD-PARTY post-content link converter — Dub / Short.io /
 * Kutt / LinkDrip selected by server environment keys, `Empty` no-op when
 * unconfigured — not a first-comment shortener and not configurable per
 * brand, so W4 deliberately does not ride it.)
 *
 * Until P5 lands, the CTA URL is posted VERBATIM. When the shortener
 * exists, this function is the single seam that changes: shorten `url`
 * here (with the brand's P5 configuration) and every CTA comment follows.
 */
export function shortenCtaUrl(url: string): string {
  // P5: replace with the first-comment shortener call.
  return url;
}

/**
 * The exact comment the engine posts: the brand's CTA text and its
 * (verbatim, see the P5 hook above) URL, text first, URL on its own line.
 * Either part may stand alone; both empty is refused at settings-save
 * time (CTA_CONTENT_REQUIRED), so a scan never composes an empty comment.
 */
export function buildCtaCommentText(ctaText: string, ctaUrl: string): string {
  const text = normalizeCtaText(ctaText);
  const url = ctaUrl ? shortenCtaUrl(ctaUrl) : '';
  if (text && url) {
    return `${text}\n${url}`;
  }
  return text || url;
}
