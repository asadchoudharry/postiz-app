import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { parseGenerationJson } from './rektrs.blog-chain';

/**
 * REKTRS W7 — the AI drafting boundary (AUTOMATION-WORKFLOWS.md W7).
 *
 * Provider truth (same surface W6 found, verified again for W7): the
 * only AI text plumbing in this codebase is the upstream OpenAI surface,
 * built from the DEPLOYMENT env OPENAI_API_KEY (with a literal
 * 'sk-proj-' placeholder fallback when unset — i.e. unconfigured). There
 * is no per-org AI key until P4's brand memory / BYOK lands; this service
 * is the boundary where that will plug in, exactly like W6's
 * RektrsTranslationService.
 *
 * Honesty contract: generateVariants returns null when the provider is
 * unconfigured, throws, or answers with nothing parseable — the caller
 * then writes DETERMINISTIC template drafts and marks the run
 * AI_FALLBACK. AI text is never fabricated, and raw AI output is never
 * trusted: the pure shapers in rektrs.blog-chain.ts enforce the platform
 * limits and the link rules on whatever comes back.
 */

export interface RektrsBlogGenerationInput {
  brandName: string;
  title: string;
  excerpt: string;
  contentText: string;
  utmLink: string;
  voiceTone: string;
  voiceNotes: string;
  examplePost: string;
}

export interface RektrsBlogGenerationResult {
  linkedin: string;
  xThread: string[];
  instagram: string;
}

@Injectable()
export class RektrsBlogGenerationService {
  private readonly _logger = new Logger(RektrsBlogGenerationService.name);
  private _client: OpenAI | null = null;

  /** True when the deployment carries a real (non-placeholder) key. */
  isConfigured(): boolean {
    const key = process.env.OPENAI_API_KEY || '';
    // OpenaiService's fallback placeholder is the literal 'sk-proj-';
    // anything that is just that placeholder means "not configured".
    return key.length > 12 && key !== 'sk-proj-';
  }

  private client(): OpenAI {
    if (!this._client) {
      this._client = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });
    }
    return this._client;
  }

  /**
   * Draft the three variants in the brand's voice. Never throws: null
   * means "no AI drafts" (unconfigured / failed / unparseable) and the
   * caller falls back to deterministic templates.
   */
  async generateVariants(
    input: RektrsBlogGenerationInput
  ): Promise<RektrsBlogGenerationResult | null> {
    if (!this.isConfigured()) {
      return null;
    }
    const voice = [
      input.voiceTone ? `Tone: ${input.voiceTone}` : '',
      input.voiceNotes ? `Voice notes: ${input.voiceNotes}` : '',
      input.examplePost
        ? `An example of this brand's voice (match its style, do not copy it):\n${input.examplePost}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
    try {
      const completion = await this.client().chat.completions.create(
        {
          model: 'gpt-4.1',
          messages: [
            {
              role: 'system',
              content:
                `You write social media drafts for the brand "${input.brandName}". ` +
                'You are given a freshly published blog post and return EXACTLY three drafts as strict JSON ' +
                '(no markdown fences, no commentary): ' +
                '{"linkedin": string, "xThread": string[], "instagram": string}. ' +
                'Rules: linkedin — a professional post of at most 1200 characters, ending with the blog link on its own line. ' +
                'xThread — a thread of at most 5 posts, each at most 270 characters, the blog link in the last post only. ' +
                'instagram — a caption of at most 2100 characters with NO web address in it; send readers to the link in the bio instead. ' +
                'Stay faithful to the post: no invented facts, prices, dates or claims. ' +
                (voice ? `\nBrand voice:\n${voice}` : ''),
            },
            {
              role: 'user',
              content:
                `Blog link: ${input.utmLink}\n` +
                `Title: ${input.title}\n` +
                (input.excerpt ? `Excerpt: ${input.excerpt}\n` : '') +
                `\nPost content:\n${input.contentText.slice(0, 6000)}`,
            },
          ],
        },
        { timeout: 30_000, maxRetries: 0 }
      );
      const raw = completion.choices[0]?.message?.content?.trim();
      if (!raw) {
        return null;
      }
      return parseGenerationJson(raw);
    } catch (e) {
      this._logger.warn(`REKTRS W7 variant generation failed: ${String(e)}`);
      return null;
    }
  }
}
