import { createHmac, timingSafeEqual } from 'crypto';

/**
 * REKTRS W7 — Blog → Social Chain, pure domain (AUTOMATION-WORKFLOWS.md
 * W7). No I/O here: webhook signature verification, HTML cleaning, UTM
 * building, variant shaping and the deterministic fallback drafts are
 * pure functions the service and the tests share — one implementation.
 *
 * Honesty rules baked into this module:
 *  - Drafts are shaped to the platform limits HERE (LinkedIn ≤1300, X
 *    thread ≤5 posts × ≤280, Instagram caption ≤2200) whether they came
 *    from the AI provider or from the fallback — the shapers never trust
 *    their input.
 *  - The Instagram caption NEVER carries the raw blog URL (the link
 *    lives in the profile bio; the UTM-tagged link is stored on the run
 *    and in the first comment). Any URL an AI puts in the caption is
 *    stripped by the shaper.
 *  - HTML from WordPress is cleaned to plain text with script/style
 *    content REMOVED (not just tag-stripped), so nothing executable or
 *    invisible leaks into a draft.
 */

export const REKTRS_BLOG_LINKEDIN_LIMIT = 1300;
export const REKTRS_BLOG_X_POST_LIMIT = 280;
export const REKTRS_BLOG_X_THREAD_MAX = 5;
export const REKTRS_BLOG_INSTAGRAM_LIMIT = 2200;

export type RektrsBlogPlatformKind = 'LINKEDIN' | 'X' | 'INSTAGRAM';

export const REKTRS_BLOG_PLATFORM_KINDS: readonly RektrsBlogPlatformKind[] = [
  'LINKEDIN',
  'X',
  'INSTAGRAM',
];

/** Provider identifier (Integration.providerIdentifier) → W7 platform kind. */
export function blogPlatformKindForProvider(
  providerIdentifier: string
): RektrsBlogPlatformKind | null {
  switch (providerIdentifier) {
    case 'linkedin':
    case 'linkedin-page':
      return 'LINKEDIN';
    case 'x':
      return 'X';
    case 'instagram':
    case 'instagram-standalone':
      return 'INSTAGRAM';
    default:
      return null;
  }
}

// ── Webhook authentication ──────────────────────────────────────────────────

/**
 * HMAC-SHA256 over the RAW body, header form `sha256=<hex>` — the same
 * mechanics as the W1 Meta receiver (X-Hub-Signature-256), keyed with the
 * per-brand secret instead of an app secret. Timing-safe; any malformed
 * header simply fails.
 */
export function verifyBlogWebhookSignature(
  secret: string,
  header: string | undefined,
  rawBody: Buffer | string
): boolean {
  if (!secret || !header?.startsWith('sha256=')) {
    return false;
  }
  const expected =
    'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(header, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Shared-secret header fallback (`X-Rektrs-Secret: <secret>`), timing-safe. */
export function verifyBlogSharedSecret(
  secret: string,
  header: string | undefined
): boolean {
  if (!secret || !header) {
    return false;
  }
  const a = Buffer.from(secret, 'utf8');
  const b = Buffer.from(header, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── WordPress payload cleaning ──────────────────────────────────────────────

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#039;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&hellip;': '…',
  '&mdash;': '—',
  '&ndash;': '–',
  '&lsquo;': '‘',
  '&rsquo;': '’',
  '&ldquo;': '“',
  '&rdquo;': '”',
};

export function decodeHtmlEntities(value: string): string {
  return (value || '')
    .replace(/&#(\d+);/g, (_, code: string) => {
      const n = Number.parseInt(code, 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000
        ? String.fromCodePoint(n)
        : '';
    })
    .replace(/&[a-z#0-9]+;/gi, (entity) => HTML_ENTITIES[entity] ?? entity);
}

/**
 * HTML → plain text for drafting. Script/style/iframe/noscript blocks are
 * removed WITH their content first (a tag-strip alone would leak their
 * text into the draft), block-level tags become paragraph breaks, every
 * remaining tag is dropped, entities are decoded and whitespace is
 * normalised. The result is safe to put in a social draft verbatim.
 */
export function stripHtmlToText(html: string | null | undefined): string {
  if (!html) {
    return '';
  }
  const withoutBlocks = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(
      /<(script|style|iframe|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      ' '
    )
    .replace(/<(script|style|iframe|noscript|template)\b[^>]*\/?>/gi, ' ');
  const withBreaks = withoutBlocks
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr|section|article)\s*>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '• ');
  const text = decodeHtmlEntities(withBreaks.replace(/<[^>]+>/g, ' '));
  return text
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── UTM ─────────────────────────────────────────────────────────────────────

/** The WordPress post slug from its link (last path segment), '' when none. */
export function wpSlugFromLink(link: string): string {
  try {
    const url = new URL(link);
    const segments = url.pathname.split('/').filter(Boolean);
    return segments.length ? decodeURIComponent(segments[segments.length - 1]) : '';
  } catch {
    return '';
  }
}

/**
 * Append utm_source / utm_medium / utm_campaign to a link. Existing query
 * params are preserved and an existing utm_* value is NEVER overwritten
 * (so reprocessing or an author-tagged link cannot double-append). A link
 * that does not parse as a URL is returned unchanged.
 */
export function buildUtmUrl(
  link: string,
  utm: { source: string; medium: string; campaign: string }
): string {
  try {
    const url = new URL(link);
    if (!url.searchParams.has('utm_source') && utm.source) {
      url.searchParams.set('utm_source', utm.source);
    }
    if (!url.searchParams.has('utm_medium') && utm.medium) {
      url.searchParams.set('utm_medium', utm.medium);
    }
    if (!url.searchParams.has('utm_campaign') && utm.campaign) {
      url.searchParams.set('utm_campaign', utm.campaign);
    }
    return url.toString();
  } catch {
    return link;
  }
}

// ── Text shaping helpers ────────────────────────────────────────────────────

/** Truncate at a word boundary so the result + suffix fits `limit`. */
export function truncateToLimit(text: string, limit: number, suffix = ''): string {
  const clean = (text || '').trim();
  const budget = limit - suffix.length;
  if (clean.length <= budget) {
    return clean + (clean ? suffix : '');
  }
  if (budget <= 0) {
    return suffix.slice(0, limit);
  }
  const cut = clean.slice(0, budget);
  const lastSpace = cut.lastIndexOf(' ');
  const body = (lastSpace > budget * 0.5 ? cut.slice(0, lastSpace) : cut).trim();
  return body + suffix;
}

/** Split text into ≤limit chunks on word boundaries (sentence-aware-ish). */
export function splitIntoChunks(text: string, limit: number): string[] {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean) {
    return [];
  }
  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > limit) {
    const cut = rest.slice(0, limit);
    const lastSpace = cut.lastIndexOf(' ');
    const at = lastSpace > limit * 0.5 ? lastSpace : limit;
    chunks.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) {
    chunks.push(rest);
  }
  return chunks;
}

// ── Variant shaping (applied to AI output AND fallback alike) ───────────────

export interface RektrsBlogVariants {
  linkedin: string;
  xThread: string[];
  instagram: string;
}

/** LinkedIn post: ≤1300 chars and ENDS with the UTM link. */
export function shapeLinkedinDraft(raw: string, utmLink: string): string {
  const linkLine = utmLink.trim();
  let body = (raw || '').trim();
  if (linkLine && body.includes(linkLine)) {
    // Keep the link only as the closing line.
    body = body.split(linkLine).join('').trim();
  }
  const shaped = truncateToLimit(
    body,
    REKTRS_BLOG_LINKEDIN_LIMIT,
    linkLine ? `\n\n${linkLine}` : ''
  );
  return shaped;
}

/**
 * X thread: ≤5 posts, each ≤280 chars; the UTM link rides in the LAST
 * post (appended, or the last post becomes the link post when full).
 */
export function shapeXThread(raw: string[], utmLink: string): string[] {
  const link = utmLink.trim();
  const posts: string[] = [];
  for (const part of raw || []) {
    for (const chunk of splitIntoChunks(part, REKTRS_BLOG_X_POST_LIMIT)) {
      posts.push(chunk);
    }
  }
  const capped = posts.slice(0, REKTRS_BLOG_X_THREAD_MAX);
  if (!link) {
    return capped;
  }
  if (!capped.length) {
    return [truncateToLimit(link, REKTRS_BLOG_X_POST_LIMIT)];
  }
  const last = capped[capped.length - 1];
  if (last.includes(link)) {
    return capped;
  }
  const withLink = `${last}\n${link}`;
  if (withLink.length <= REKTRS_BLOG_X_POST_LIMIT) {
    capped[capped.length - 1] = withLink;
    return capped;
  }
  if (capped.length < REKTRS_BLOG_X_THREAD_MAX) {
    capped.push(truncateToLimit(link, REKTRS_BLOG_X_POST_LIMIT));
    return capped;
  }
  capped[capped.length - 1] = truncateToLimit(
    last,
    REKTRS_BLOG_X_POST_LIMIT,
    `\n${link}`
  );
  return capped;
}

const URL_PATTERN = /https?:\/\/[^\s]+/gi;

/** Instagram caption: ≤2200 chars, NO raw URL, points at the bio link. */
export function shapeInstagramCaption(raw: string): string {
  let caption = (raw || '').replace(URL_PATTERN, '').trim();
  caption = caption.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n');
  if (!/link in bio/i.test(caption)) {
    caption = caption ? `${caption}\n\nLink in bio` : 'Link in bio';
  }
  return truncateToLimit(caption, REKTRS_BLOG_INSTAGRAM_LIMIT);
}

// ── Deterministic fallback drafts (AI off / unconfigured / failed) ──────────

export interface RektrsBlogSourceMaterial {
  title: string;
  excerpt: string;
  contentText: string;
}

/**
 * Template drafts built from the post itself — title, excerpt (or the
 * opening of the cleaned content) and the UTM link, shaped per platform.
 * Used whenever the AI path cannot run; the run records AI_FALLBACK so
 * nobody mistakes these for AI writing.
 */
export function buildFallbackVariants(
  source: RektrsBlogSourceMaterial,
  utmLink: string
): RektrsBlogVariants {
  const title = (source.title || '').trim();
  const summary =
    (source.excerpt || '').trim() ||
    truncateToLimit((source.contentText || '').trim(), 400);
  const linkedinRaw = [title, summary].filter(Boolean).join('\n\n');
  const xSource = [title, summary].filter(Boolean).join(' — ');
  const instagramRaw = [title, summary].filter(Boolean).join('\n\n');
  return {
    linkedin: shapeLinkedinDraft(linkedinRaw, utmLink),
    xThread: shapeXThread([xSource], utmLink),
    instagram: shapeInstagramCaption(instagramRaw),
  };
}

/** Shape raw AI output into the same guaranteed forms as the fallback. */
export function shapeAiVariants(
  raw: { linkedin?: string; xThread?: string[]; instagram?: string },
  utmLink: string
): RektrsBlogVariants {
  return {
    linkedin: shapeLinkedinDraft(raw.linkedin || '', utmLink),
    xThread: shapeXThread(raw.xThread || [], utmLink),
    instagram: shapeInstagramCaption(raw.instagram || ''),
  };
}

/** A shaped variant set is usable only if every variant has real content. */
export function variantsAreUsable(variants: RektrsBlogVariants): boolean {
  return (
    variants.linkedin.trim().length > 0 &&
    variants.xThread.some((p) => p.trim().length > 0) &&
    variants.instagram.trim().length > 0
  );
}

// ── AI output parsing ───────────────────────────────────────────────────────

export interface RektrsBlogGenerationOutput {
  linkedin: string;
  xThread: string[];
  instagram: string;
}

/** Defensive JSON extraction for AI replies: tolerates code fences and
 *  stray prose around the object; anything unparseable is null (the
 *  caller falls back to deterministic drafts — AI output is never
 *  trusted raw). */
export function parseGenerationJson(
  raw: string
): RektrsBlogGenerationOutput | null {
  if (!raw) {
    return null;
  }
  const fenced = raw.replace(/```(?:json)?/gi, '');
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return null;
  }
  try {
    const parsed = JSON.parse(fenced.slice(start, end + 1)) as {
      linkedin?: unknown;
      xThread?: unknown;
      instagram?: unknown;
    };
    const linkedin =
      typeof parsed.linkedin === 'string' ? parsed.linkedin : '';
    const instagram =
      typeof parsed.instagram === 'string' ? parsed.instagram : '';
    const xThread = Array.isArray(parsed.xThread)
      ? parsed.xThread.filter((p): p is string => typeof p === 'string')
      : typeof parsed.xThread === 'string'
        ? [parsed.xThread]
        : [];
    if (!linkedin && !instagram && !xThread.length) {
      return null;
    }
    return { linkedin, xThread, instagram };
  } catch {
    return null;
  }
}

// ── First comment ───────────────────────────────────────────────────────────

export const REKTRS_BLOG_DEFAULT_FIRST_COMMENT = 'Read the full post: {link}';

/** Render the first-comment template: {link} = UTM link, {title} = title. */
export function renderFirstComment(
  template: string,
  values: { link: string; title: string }
): string {
  const tpl = (template || '').trim() || REKTRS_BLOG_DEFAULT_FIRST_COMMENT;
  return tpl
    .split('{link}')
    .join(values.link)
    .split('{title}')
    .join(values.title)
    .trim();
}
