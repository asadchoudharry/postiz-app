/**
 * Deterministic, client-side editorial hints for an in-progress Postiz draft.
 *
 * Advisory only: these checks never replace platform validators, approvals,
 * factual review, or server-side publishing permissions.
 */
export type FindingSeverity = 'attention' | 'suggestion';
export type ReviewStatus = 'needs-attention' | 'review' | 'clear';

export interface ContentFinding {
  code: string;
  severity: FindingSeverity;
  message: string;
}

export interface PostQuality {
  index: number;
  characters: number;
  words: number;
  hashtags: number;
  links: number;
  score: number;
  status: ReviewStatus;
  findings: ContentFinding[];
}

export interface QualityReport {
  posts: PostQuality[];
  attentionCount: number;
  suggestionCount: number;
}

function countWords(value: string): number {
  const trimmed = value.trim();
  return trimmed ? trimmed.split(/\s+/u).length : 0;
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

export function analyzeContent(contents: readonly string[]): QualityReport {
  const seen = new Set<string>();
  const posts: PostQuality[] = contents.map((raw, index) => {
    const value = typeof raw === 'string' ? raw : '';
    const text = value.trim();
    const findings: ContentFinding[] = [];
    const add = (code: string, severity: FindingSeverity, message: string) =>
      findings.push({ code, severity, message });

    const hashtags = Array.from(
      text.matchAll(/(?:^|[^\p{L}\p{N}_])#([\p{L}\p{N}_]+)/gu),
      (match) => match[1].toLocaleLowerCase()
    );
    const links = Array.from(
      text.matchAll(/https?:\/\/[^\s<>"']+/giu),
      (match) => match[0]
    );

    if (text.length < 6) {
      add('too-short', 'attention', 'Write at least six characters before scheduling.');
    }

    if (
      /\blorem ipsum\b|\b(?:TODO|TBD)\b|\[(?:your[^\]]*|insert[^\]]*|link|date|name)\]|\{\{[^{}]+\}\}/iu.test(text)
    ) {
      add('placeholder', 'attention', 'Replace unfinished placeholders before publishing.');
    }

    const unique = new Set(hashtags);
    if (unique.size < hashtags.length) {
      add('repeated-hashtag', 'suggestion', 'Remove repeated hashtags to keep the caption concise.');
    }
    if (hashtags.length > 8) {
      add('many-hashtags', 'suggestion', 'Consider reducing hashtags to the most relevant ones.');
    }
    if (links.length > 3) {
      add('many-links', 'suggestion', 'Consider one clear destination instead of many links.');
    }
    if (links.some((link) => link.toLowerCase().startsWith('http:'))) {
      add('http-link', 'suggestion', 'Review non-HTTPS links before sharing.');
    }
    if (/[!?]{4,}/u.test(text)) {
      add('repeated-punctuation', 'suggestion', 'Reduce repeated punctuation for a more professional tone.');
    }
    if (text.split(/\n/u).some((line) => line.length > 320)) {
      add('long-line', 'suggestion', 'Break long paragraphs into shorter lines for easier reading.');
    }

    const normalized = normalize(text);
    if (normalized.length >= 6) {
      if (seen.has(normalized)) {
        add('duplicate-variant', 'suggestion', 'This text duplicates an earlier post in the same draft.');
      }
      seen.add(normalized);
    }

    const attention = findings.filter((f) => f.severity === 'attention').length;
    const suggestions = findings.length - attention;
    const score = Math.max(0, 100 - attention * 30 - suggestions * 8);

    return {
      index,
      characters: value.length,
      words: countWords(text),
      hashtags: hashtags.length,
      links: links.length,
      score,
      status: attention > 0 ? 'needs-attention' : suggestions > 0 ? 'review' : 'clear',
      findings,
    };
  });

  return {
    posts,
    attentionCount: posts.reduce(
      (sum, post) => sum + post.findings.filter((finding) => finding.severity === 'attention').length,
      0
    ),
    suggestionCount: posts.reduce(
      (sum, post) => sum + post.findings.filter((finding) => finding.severity === 'suggestion').length,
      0
    ),
  };
}

export function formatReviewReport(report: QualityReport): string {
  return [
    'REKTRS Social — Draft content review (advisory only)',
    ...report.posts.flatMap((post) => [
      '',
      'Post ' + (post.index + 1) + ': ' + post.score + '/100; ' +
        post.characters + ' characters; ' + post.words + ' words; ' +
        post.hashtags + ' hashtags; ' + post.links + ' links',
      ...(post.findings.length
        ? post.findings.map((finding) => '- ' + finding.severity + ': ' + finding.message)
        : ['- No editorial checks flagged. Platform and factual review still required.']),
    ]),
  ].join('\n');
}
