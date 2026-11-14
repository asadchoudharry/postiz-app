'use client';

import { useId, useMemo, useState } from 'react';
import {
  analyzeContent,
  formatReviewReport,
} from './quality-rules';

export function RektrsContentReview({
  contents,
  channelCount,
}: {
  contents: string[];
  channelCount: number;
}) {
  const detailsId = useId();
  const [expanded, setExpanded] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const report = useMemo(() => analyzeContent(contents), [contents]);
  const status =
    report.attentionCount > 0
      ? 'Needs attention'
      : report.suggestionCount > 0
      ? 'Suggestions available'
      : 'No editorial flags';

  const copyReport = async () => {
    setCopyState('idle');
    try {
      if (!navigator.clipboard?.writeText) {
        setCopyState('error');
        return;
      }
      await navigator.clipboard.writeText(formatReviewReport(report));
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
  };

  return (
    <section
      aria-label="REKTRS Social draft quality review"
      className="w-full min-w-0 whitespace-normal rounded-lg border border-white/10 bg-newBgColorInner p-4 text-white"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-widest text-[#B19BFF]">
            REKTRS Social / Content checks
          </div>
          <h3 className="mt-1 text-base font-semibold">Pre-publish review</h3>
          <p className="mt-1 text-xs leading-5 text-[#B6BAC7]">
            Advisory checks only. Platform validation, human approval and factual review still apply.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setExpanded((open) => !open)}
            aria-expanded={expanded}
            aria-controls={detailsId}
            className="rounded-md border border-white/10 px-3 py-2 text-xs font-medium hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {expanded ? 'Hide details' : 'View details'}
          </button>
          <button
            type="button"
            onClick={copyReport}
            className="rounded-md border border-white/10 px-3 py-2 text-xs font-medium hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            Copy review
          </button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-white/10 pt-3 text-xs">
        <span className="font-semibold" role="status">{status}</span>
        <span>{report.posts.length} {report.posts.length === 1 ? 'post' : 'posts'}</span>
        <span>{channelCount} {channelCount === 1 ? 'channel' : 'channels'} selected</span>
        <span>{report.attentionCount} attention flags</span>
        <span>{report.suggestionCount} suggestions</span>
      </div>

      <div id={detailsId} hidden={!expanded} className="mt-4 border-t border-white/10 pt-4">
        <ol className="space-y-3">
          {report.posts.map((post) => (
            <li key={post.index} className="rounded-lg border border-white/10 bg-white/5 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-semibold">Post {post.index + 1}</div>
                <div className="text-xs font-medium">
                  Editorial score: {post.score}/100
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#B6BAC7]">
                <span>{post.characters} characters</span>
                <span>{post.words} words</span>
                <span>{post.hashtags} hashtags</span>
                <span>{post.links} links</span>
              </div>
              {post.findings.length ? (
                <ul className="mt-3 space-y-2 text-xs leading-5">
                  {post.findings.map((finding) => (
                    <li key={finding.code} className="flex items-start gap-2">
                      <span aria-hidden="true" className="mt-[3px]">
                        {finding.severity === 'attention' ? '●' : '○'}
                      </span>
                      <span>
                        <strong className="font-semibold">
                          {finding.severity === 'attention' ? 'Attention: ' : 'Suggestion: '}
                        </strong>
                        {finding.message}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-xs text-[#B6BAC7]">
                  No editorial checks flagged. Confirm channel limits, links, claims and media before publishing.
                </p>
              )}
            </li>
          ))}
        </ol>
      </div>

      <p aria-live="polite" className="mt-2 text-xs text-[#B6BAC7]">
        {copyState === 'copied'
          ? 'Review copied to clipboard.'
          : copyState === 'error'
          ? 'Clipboard permission is unavailable. Review remains visible above.'
          : ''}
      </p>
    </section>
  );
}
