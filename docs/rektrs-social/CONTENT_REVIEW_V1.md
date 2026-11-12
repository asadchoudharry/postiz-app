# REKTRS Social - Content Review v1

**Slice:** Phase 2/3. **Feature flag:** NEXT_PUBLIC_REKTRS_CONTENT_REVIEW=true (build-time opt-in; disabled by default).

## Purpose and source boundary

The original Postiz calendar and post editor remain the authoritative scheduling and draft workflows. This addition runs deterministic editorial checks on the existing **global post composer**. It does not replace provider validators, implement approvals or send text to AI/cloud providers.

## Actual user journey

1. Open the Postiz calendar, select channels and enter a post in the global editor.
2. A summary updates as the post changes: number of drafts, selected channels, attention items and suggestions.
3. Choose **View details** to see per-post readability statistics and the specific editorial findings; Hide details reverses this state.
4. Choose **Copy review** to copy the checklist. Clipboard denial displays an error instead of fake success.
5. Existing Postiz **Save as draft** and **Add to calendar** controls continue unchanged.

## Rule states

- Attention: caption shorter than six characters or unresolved TODO / [link] / {{variable}} placeholder.
- Suggestions: repeated hashtags, more than eight hashtags, repeated drafts, more than three links, non-HTTPS link, repeated punctuation or lines longer than 320 characters.
- Per-post characters, word count, link count, hashtag count and heuristic score 0-100.
- Empty content is flagged; saving a draft remains available.
- No issues does **not** mean factual accuracy, accessibility, brand/legal approval or provider acceptance.
- Report and caption are not persisted by this feature, and no publishing or API requests are performed.

## Requirements to evidence

| Requirement | Source | Verification |
| --- | --- | --- |
| QA-001 live review | rektrs-content-review.tsx, rektrs-quality-rules.ts | offline engine tests |
| QA-002 multilingual/multi-post | unicode hashtag and duplicate checks | regression tests |
| QA-003 visible/accessible states | expandable panel and screen-reader statuses | browser QA pending |
| QA-004 copy review | formatReviewReport + clipboard handling | formatting test; browser pending |
| QA-005 default-off flag | AddEditModal integration and .env.example | source contract test |

## Execution and release states

- SPECIFIED: yes.
- CODE_IMPLEMENTED: yes, on draft PR only.
- INTEGRATED: global editor wired in source; not verified against live backend.
- TESTED: Node 22 GitHub Actions ran 11 offline regression tests successfully.
- FULL FRONTEND BUILD / BROWSER QA: pending.
- DEPLOYED: no.
- PRODUCTION GATE: Phase 0 Postiz host/revision identification, 403 diagnosis, isolated restore rehearsal, Google OAuth checks and smoke tests.

## Security and compatibility

No database schema, channel tokens, OAuth scopes, analytics, RBAC, schedules, publishing endpoints or user-post mutations are modified. Module is advisory only and must not be confused with permission-enforced approval.

## Next expansion

Brand-specific editorial rule profiles after actual organization schema and authorization review; provider-limit-aware validation; server-side publication approval enforcement; provenance-aware AI suggestions with explicit consent and cost controls.
