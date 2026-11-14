import { createHmac, timingSafeEqual } from 'crypto';

/**
 * REKTRS W1 — Comment-to-DM Lead Machine, pure domain (AUTOMATION-WORKFLOWS.md
 * W1). No I/O here: text matching, template rendering and webhook signing are
 * deterministic functions the service and the tests share — one
 * implementation, mirroring the shared-hash rule (design §2.3).
 *
 * Matching semantics (deliberate, and pinned by tests):
 *  - Text and phrases are normalised: Unicode NFC, lowercased, runs of
 *    whitespace collapsed. Arabic presentation forms are NOT folded (the
 *    default guard list carries both the Arabic-script spellings in common
 *    use; brands can add their own variants as rule guard words).
 *  - A phrase matches when it appears in the text delimited by word
 *    boundaries, where a "word character" is any Unicode letter, number or
 *    underscore. So keyword `price` matches "PRICE?" and "price, please" but
 *    not "priceless"; Urdu/Arabic phrases (no case, space-separated) match
 *    the same way. Multi-word phrases match across single spaces.
 *  - Guard words are evaluated BEFORE keywords and always win: a comment
 *    asking for a "refund" that also says "price" is a human's, never a
 *    lead's.
 */

export const REKTRS_LEAD_WEBHOOK_MAX_ATTEMPTS = 5;

/**
 * Org-wide default guard/complaint words. EN terms are the owner-approved
 * set from the W1 brief; Urdu (Nastaliq) and Arabic equivalents cover the
 * brands' actual audiences (PK / Gulf). Brands extend or replace these per
 * rule (LeadRule.guardWords + useDefaultGuardWords).
 */
export const REKTRS_DEFAULT_GUARD_WORDS: readonly string[] = [
  // English
  'refund',
  'complaint',
  'complain',
  'scam',
  'fraud',
  'lawyer',
  'police',
  'court',
  'lawsuit',
  'cheated',
  'fake product',
  // Urdu
  'شکایت', // complaint
  'فراڈ', // fraud
  'دھوکہ', // deception / scam
  'دھوکا', // deception (alternate spelling)
  'رقم واپسی', // money back / refund
  'پیسے واپس', // money back
  'پولیس', // police
  'وکیل', // lawyer
  'عدالت', // court
  // Arabic
  'احتيال', // fraud / scam
  'نصب', // fraud (Gulf usage)
  'شكوى', // complaint
  'شكاوى', // complaints
  'استرداد', // refund / chargeback
  'استرجاع', // return / refund
  'شرطة', // police
  'محامي', // lawyer
  'محكمة', // court
];

export function normalizeLeadText(value: string): string {
  return (value || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalise + dedupe a configured phrase list (keywords / guard words). */
export function normalizePhraseList(values: string[] | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values || []) {
    const phrase = normalizeLeadText(String(raw));
    if (!phrase || seen.has(phrase)) {
      continue;
    }
    seen.add(phrase);
    out.push(phrase);
  }
  return out;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

function isWordChar(ch: string | undefined): boolean {
  return !!ch && WORD_CHAR.test(ch);
}

/**
 * Word-boundary phrase search over normalised text. Manual scan (no regex)
 * so phrases containing regex metacharacters or RTL script behave exactly
 * as written. Returns the matched phrase or null.
 */
export function findPhrase(text: string, phrases: string[]): string | null {
  const haystack = normalizeLeadText(text);
  if (!haystack) {
    return null;
  }
  for (const phrase of phrases) {
    const needle = normalizeLeadText(phrase);
    if (!needle) {
      continue;
    }
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) {
        break;
      }
      const before = at > 0 ? haystack[at - 1] : undefined;
      const after =
        at + needle.length < haystack.length
          ? haystack[at + needle.length]
          : undefined;
      if (!isWordChar(before) && !isWordChar(after)) {
        return phrase;
      }
      from = at + 1;
    }
  }
  return null;
}

export interface RektrsLeadMatch {
  kind: 'guard' | 'keyword' | 'none';
  /** The phrase as configured on the rule / default list (original casing). */
  phrase: string | null;
}

/** Guard words first (they always win), then keywords. */
export function matchLeadComment(
  text: string,
  rule: { keywords: string[]; guardWords: string[]; useDefaultGuardWords: boolean }
): RektrsLeadMatch {
  const guards = rule.useDefaultGuardWords
    ? [...REKTRS_DEFAULT_GUARD_WORDS, ...rule.guardWords]
    : rule.guardWords;
  const guard = findPhrase(text, guards);
  if (guard) {
    return { kind: 'guard', phrase: guard };
  }
  const keyword = findPhrase(text, rule.keywords);
  if (keyword) {
    return { kind: 'keyword', phrase: keyword };
  }
  return { kind: 'none', phrase: null };
}

/**
 * DM template rendering. Placeholders: {{name}} (commenter handle, falls
 * back to a neutral "there"), {{keyword}} (the matched keyword as
 * configured), {{link}} (the post's public URL). Unknown placeholders are
 * left untouched so a template typo is visible, not silent.
 */
export function renderLeadDmTemplate(
  template: string,
  vars: { name?: string | null; keyword?: string | null; link?: string | null }
): string {
  return (template || '').replace(
    /\{\{\s*(name|keyword|link)\s*\}\}/gi,
    (_whole, key: string) => {
      switch (key.toLowerCase()) {
        case 'name':
          return vars.name?.trim() || 'there';
        case 'keyword':
          return vars.keyword || '';
        case 'link':
          return vars.link || '';
        default:
          return '';
      }
    }
  );
}

/**
 * CRM webhook signing (Stripe-style): the signature covers `${timestamp}.${
 * body}` with HMAC-SHA256 under the org's secret, sent as
 * `t=<unix seconds>,v1=<hex>` in the X-Rektrs-Signature header, so the
 * receiver can reject replays outside its tolerance window.
 */
export function signLeadWebhookPayload(
  secret: string,
  timestampSeconds: number,
  rawBody: string
): string {
  const signature = createHmac('sha256', secret)
    .update(`${timestampSeconds}.${rawBody}`)
    .digest('hex');
  return `t=${timestampSeconds},v1=${signature}`;
}

export function verifyLeadWebhookSignature(
  secret: string,
  header: string,
  rawBody: string,
  toleranceSeconds = 300,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): boolean {
  const parts = Object.fromEntries(
    (header || '').split(',').map((kv) => {
      const [k, ...rest] = kv.split('=');
      return [k?.trim(), rest.join('=').trim()];
    })
  );
  const t = Number.parseInt(parts.t || '', 10);
  const v1 = parts.v1 || '';
  if (!Number.isFinite(t) || !v1) {
    return false;
  }
  if (Math.abs(nowSeconds - t) > toleranceSeconds) {
    return false;
  }
  const expected = createHmac('sha256', secret)
    .update(`${t}.${rawBody}`)
    .digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(v1, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Meta webhook (X-Hub-Signature-256) verification over the raw body. */
export function verifyMetaWebhookSignature(
  appSecret: string,
  header: string | undefined,
  rawBody: Buffer | string
): boolean {
  if (!appSecret || !header?.startsWith('sha256=')) {
    return false;
  }
  const expected =
    'sha256=' +
    createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(header, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
