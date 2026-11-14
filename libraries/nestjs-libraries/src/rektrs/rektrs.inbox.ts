import {
  findPhrase,
  normalizeLeadText,
  REKTRS_DEFAULT_GUARD_WORDS,
} from './rektrs.leads';

/**
 * REKTRS W6 — Inbox Triage (Multilingual), pure domain
 * (AUTOMATION-WORKFLOWS.md W6). No I/O here: language detection,
 * classification and FAQ-template rendering are deterministic functions
 * the service and the tests share.
 *
 * Classification discipline (the W1 honesty rules, extended):
 *  - COMPLAINT always wins: the complaint lexicon is checked BEFORE any
 *    FAQ topic, exactly like W1 guard words beat lead keywords. A comment
 *    asking "price?? this is a scam" is a human's, never a draft's.
 *  - Matching reuses the W1 phrase matcher (Unicode NFC, case-folded,
 *    word-boundary — `price` does not match `priceless`), so EN, Urdu,
 *    Arabic and Roman-Urdu phrases all behave exactly as written.
 *  - Classification NEVER depends on translation: the lexicons cover the
 *    brands' actual languages, so an item classifies identically whether
 *    or not a translation provider is configured.
 */

export type RektrsInboxLanguage = 'en' | 'ur' | 'ar' | 'ur-Latn' | 'other';

export type RektrsInboxCategory =
  | 'COMPLAINT'
  | 'FAQ_PRICE'
  | 'FAQ_TIMING'
  | 'FAQ_LOCATION'
  | 'FAQ_DELIVERY'
  | 'GENERAL';

export type RektrsInboxStatus =
  | 'NEW'
  | 'QUEUED'
  | 'DRAFTED'
  | 'SENT'
  | 'DISMISSED';

export type RektrsTranslationStatus =
  | 'NOT_NEEDED'
  | 'TRANSLATED'
  | 'UNAVAILABLE'
  | 'FAILED';

/** Working languages a brand can pick (the settings DTO validates these). */
export const REKTRS_INBOX_WORKING_LANGUAGES: readonly RektrsInboxLanguage[] = [
  'en',
  'ur',
  'ar',
  'ur-Latn',
];

export const REKTRS_INBOX_LANGUAGE_NAMES: Record<RektrsInboxLanguage, string> =
  {
    en: 'English',
    ur: 'Urdu (اردو script)',
    ar: 'Arabic',
    'ur-Latn': 'Roman Urdu (Urdu written in Latin letters)',
    other: 'the detected language',
  };

// ── Language detection ──────────────────────────────────────────────────────
// Script first: the Arabic block (U+0600–U+06FF) carries both Urdu and
// Arabic. Urdu is told apart by its own letters (ٹ ڈ ڑ ے ھ ـے etc.) and a
// small set of high-frequency Urdu-only words; the rest of the block is
// Arabic. Latin text is then screened for Roman-Urdu marker words; text
// with no signal at all is 'en' when it is plain Latin and 'other' when
// it carries a script we do not classify (Cyrillic, CJK, …).

const ARABIC_BLOCK = /[\u0600-\u06FF]/;
// (ؤ is deliberately absent: Arabic uses it too, e.g. مسؤول.)
const URDU_SPECIFIC_LETTER = /[ٹڈڑےھںۓ]/;
const URDU_SCRIPT_WORDS = [
  'ہے',
  'ہیں',
  'کا',
  'کی',
  'کے',
  'میں',
  'نے',
  'اور',
  'نہیں',
  'کیا',
  'سے',
  'پر',
  'یہ',
  'وہ',
  'بھی',
  'کو',
];
const NON_LATIN_OTHER = /[\u0400-\u04FF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF\u0590-\u05FF\u0900-\u097F]/;

/** High-frequency Roman-Urdu markers (whole words, normalised text). */
const ROMAN_URDU_MARKERS = [
  'hai',
  'hain',
  'kya',
  'nahi',
  'nahin',
  'mein',
  'mujhe',
  'aap',
  'apka',
  'apki',
  'mera',
  'meri',
  'chahiye',
  'qeemat',
  'kitne',
  'kitna',
  'kahan',
  'kab',
  'kaise',
  'bohat',
  'bahut',
  'acha',
  'accha',
  'theek',
  'bhai',
  'milta',
  'milti',
  'wala',
  'wali',
  'karna',
  'kardo',
  'batao',
  'bataen',
  'chaye',
  'paisa',
  'paise',
  'lagta',
  'hoga',
  'hogi',
  'raha',
  'rahi',
  'tha',
  'thi',
];

export function detectInboxLanguage(text: string): RektrsInboxLanguage {
  const raw = text || '';
  if (ARABIC_BLOCK.test(raw)) {
    if (URDU_SPECIFIC_LETTER.test(raw)) {
      return 'ur';
    }
    const normalised = normalizeLeadText(raw);
    const words = normalised.split(' ');
    if (words.some((w) => URDU_SCRIPT_WORDS.includes(w))) {
      return 'ur';
    }
    return 'ar';
  }
  if (/[A-Za-z]/.test(raw)) {
    const normalised = normalizeLeadText(raw);
    const words = new Set(normalised.split(/[^a-z']+/).filter(Boolean));
    let markers = 0;
    for (const marker of ROMAN_URDU_MARKERS) {
      if (words.has(marker)) {
        markers++;
      }
    }
    // One marker can be an English false friend ("kab", "tha"); two or
    // more independent markers is Roman Urdu with room to spare.
    return markers >= 2 ? 'ur-Latn' : 'en';
  }
  if (NON_LATIN_OTHER.test(raw)) {
    return 'other';
  }
  return 'en';
}

// ── Lexicons ────────────────────────────────────────────────────────────────
// The complaint set starts from the owner-approved W1 guard list (refund,
// fraud, scam, lawyer, police, … EN + Urdu + Arabic) and adds the W6
// anger/dissatisfaction terms from the brief. Brand extras
// (InboxSettings.extraComplaintKeywords) are ADDED to this set — the
// defaults always apply, there is no toggle to silence them.

export const REKTRS_INBOX_EXTRA_COMPLAINT_WORDS: readonly string[] = [
  // English anger / dissatisfaction
  'angry',
  'disappointed',
  'disappointing',
  'worst',
  'terrible',
  'pathetic',
  'useless',
  'rubbish',
  'horrible',
  'awful',
  'fed up',
  // Urdu (script)
  'غصہ', // anger
  'ناراض', // upset / angry
  'مایوس', // disappointed
  'بیکار', // useless
  'برا تجربہ', // bad experience
  // Arabic
  'غاضب', // angry
  'سيء', // bad
  'أسوأ', // worst
  'مخيب', // disappointing
  'فظيع', // terrible
  // Roman Urdu
  'gussa',
  'naraz',
  'mayoos',
  'bekar',
  'bekaar',
  'bakwas',
  'ghatiya',
  'paise wapas',
  'paisay wapas',
];

export const REKTRS_INBOX_COMPLAINT_WORDS: readonly string[] = [
  ...REKTRS_DEFAULT_GUARD_WORDS,
  ...REKTRS_INBOX_EXTRA_COMPLAINT_WORDS,
];

export type RektrsFaqTopic = 'PRICE' | 'TIMING' | 'LOCATION' | 'DELIVERY';

export const REKTRS_INBOX_FAQ_WORDS: Record<RektrsFaqTopic, string[]> = {
  PRICE: [
    // English
    'price',
    'prices',
    'cost',
    'rate',
    'rates',
    'charges',
    'fee',
    'fees',
    'discount',
    // NOT the bare verb 'offer' — "do you offer delivery?" is a delivery
    // question; the noun uses are 'offers' / 'any offer'.
    'offers',
    'any offer',
    'how much',
    // Urdu (script)
    'قیمت',
    'دام',
    'فیس',
    'رعایت',
    // Arabic
    'سعر',
    'أسعار',
    'الثمن',
    'رسوم',
    'خصم',
    // Roman Urdu
    'qeemat',
    'daam',
    'kitne ka',
    'kitnay ka',
  ],
  TIMING: [
    // English
    'timing',
    'timings',
    'hours',
    'open',
    'opening',
    'close',
    'closing',
    'when open',
    'what time',
    // Urdu (script)
    'اوقات',
    'وقت',
    'کھلا',
    // Arabic
    'مواعيد',
    'ساعات',
    'مفتوح',
    'توقيت',
    // Roman Urdu
    'kab khulta',
    'khula hai',
    'band kab',
  ],
  LOCATION: [
    // English
    'location',
    'address',
    'directions',
    'where are you',
    'where is your',
    // Urdu (script)
    'پتہ',
    'پتا',
    'ایڈریس',
    // Arabic
    'عنوان',
    'موقع',
    'العنوان',
    // Roman Urdu
    'kahan hai',
    'kidhar hai',
    'address kya',
  ],
  DELIVERY: [
    // English
    'delivery',
    'deliver',
    'shipping',
    'ship',
    'home delivery',
    'cash on delivery',
    // Urdu (script)
    'ڈیلیوری',
    'ترسیل',
    'بھجوا',
    // Arabic
    'توصيل',
    'شحن',
    'التوصيل',
    // Roman Urdu
    'bhijwa',
    'bhej dein',
    'deliver kar',
  ],
};

const FAQ_TOPIC_ORDER: RektrsFaqTopic[] = [
  'PRICE',
  'TIMING',
  'LOCATION',
  'DELIVERY',
];

export interface RektrsInboxClassification {
  category: RektrsInboxCategory;
  /** The exact phrase that fired (as configured), or null for GENERAL. */
  phrase: string | null;
  faqTopic: RektrsFaqTopic | null;
}

/**
 * Complaint first (it always wins), then FAQ topics in the fixed order
 * PRICE → TIMING → LOCATION → DELIVERY, else GENERAL.
 */
export function classifyInboxText(
  text: string,
  extraComplaintKeywords: string[] = []
): RektrsInboxClassification {
  const complaint = findPhrase(text, [
    ...REKTRS_INBOX_COMPLAINT_WORDS,
    ...extraComplaintKeywords,
  ]);
  if (complaint) {
    return { category: 'COMPLAINT', phrase: complaint, faqTopic: null };
  }
  for (const topic of FAQ_TOPIC_ORDER) {
    const phrase = findPhrase(text, REKTRS_INBOX_FAQ_WORDS[topic]);
    if (phrase) {
      return {
        category: `FAQ_${topic}` as RektrsInboxCategory,
        phrase,
        faqTopic: topic,
      };
    }
  }
  return { category: 'GENERAL', phrase: null, faqTopic: null };
}

/**
 * FAQ reply-template rendering. Placeholders: {brandName} (the brand's
 * name) and {name} (the commenter's name, falls back to a neutral
 * "there"). Unknown placeholders are left untouched so a template typo
 * is visible, not silent (the W1 template rule).
 */
export function renderInboxFaqTemplate(
  template: string,
  vars: { brandName?: string | null; name?: string | null }
): string {
  return (template || '').replace(
    /\{\s*(brandName|name)\s*\}/gi,
    (_whole, key: string) => {
      switch (key.toLowerCase()) {
        case 'brandname':
          return vars.brandName?.trim() || '';
        case 'name':
          return vars.name?.trim() || 'there';
        default:
          return '';
      }
    }
  );
}

/** The settings field that carries a topic's FAQ template. */
export function faqTemplateField(
  topic: RektrsFaqTopic
): 'faqPrice' | 'faqTiming' | 'faqLocation' | 'faqDelivery' {
  switch (topic) {
    case 'PRICE':
      return 'faqPrice';
    case 'TIMING':
      return 'faqTiming';
    case 'LOCATION':
      return 'faqLocation';
    case 'DELIVERY':
      return 'faqDelivery';
  }
}
