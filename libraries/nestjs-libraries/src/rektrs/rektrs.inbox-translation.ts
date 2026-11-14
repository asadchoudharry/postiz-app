import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import {
  RektrsInboxLanguage,
  RektrsTranslationStatus,
  REKTRS_INBOX_LANGUAGE_NAMES,
} from './rektrs.inbox';

/**
 * REKTRS W6 — the translation boundary (AUTOMATION-WORKFLOWS.md W6).
 *
 * Provider truth (verified in this codebase, 2026-11-14): there is NO
 * translation API anywhere in the tree (no DeepL / Google Translate /
 * Azure Translator), and the only AI text plumbing is the upstream
 * OpenAI surface, whose client is built from the DEPLOYMENT env
 * OPENAI_API_KEY (OpenaiService carries a 'sk-proj-' placeholder
 * fallback, i.e. unconfigured unless the deployment sets a real key —
 * there is no per-org AI key in this codebase). W6 therefore routes
 * translation through that same env-keyed OpenAI surface, behind this
 * service, and is honest about the states:
 *
 *  - detected language == the brand's working language → NOT_NEEDED
 *    (no call is made; translatedText stays null);
 *  - no real OPENAI_API_KEY in the deployment env → UNAVAILABLE (no
 *    call is attempted; the item keeps its original text and says so);
 *  - a call that throws or returns nothing → FAILED (original kept).
 *
 * A translation is NEVER invented: when the status is not TRANSLATED,
 * translatedText is null and the UI shows the original with the status.
 * Classification does not depend on this service at all (the W6 lexicons
 * cover EN / Urdu / Arabic / Roman Urdu directly).
 */

export interface RektrsTranslationOutcome {
  status: RektrsTranslationStatus;
  text: string | null;
}

@Injectable()
export class RektrsTranslationService {
  private readonly _logger = new Logger(RektrsTranslationService.name);
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
        apiKey: process.env.OPENAI_API_KEY || 'sk-proj-',
      });
    }
    return this._client;
  }

  /**
   * Translate `text` into the brand's working language. Never throws and
   * never fabricates: every non-success path returns a null text with
   * the honest status.
   */
  async translateIfNeeded(
    text: string,
    detectedLanguage: RektrsInboxLanguage,
    workingLanguage: string
  ): Promise<RektrsTranslationOutcome> {
    if (!text?.trim()) {
      return { status: 'NOT_NEEDED', text: null };
    }
    if (detectedLanguage === workingLanguage) {
      return { status: 'NOT_NEEDED', text: null };
    }
    if (!this.isConfigured()) {
      return { status: 'UNAVAILABLE', text: null };
    }
    const target =
      REKTRS_INBOX_LANGUAGE_NAMES[workingLanguage as RektrsInboxLanguage] ||
      workingLanguage;
    try {
      const completion = await this.client().chat.completions.create(
        {
          model: 'gpt-4.1',
          messages: [
            {
              role: 'system',
              content:
                `You are a translation engine. Translate the user's message into ${target}. ` +
                'Output ONLY the translation — no quotes, no notes, no original text. ' +
                'Preserve tone, names, numbers, prices and URLs exactly. ' +
                'If the message is already in that language, return it unchanged.',
            },
            { role: 'user', content: text },
          ],
        },
        { timeout: 30_000, maxRetries: 0 }
      );
      const translated = completion.choices[0]?.message?.content?.trim();
      if (!translated) {
        return { status: 'FAILED', text: null };
      }
      return { status: 'TRANSLATED', text: translated };
    } catch (e) {
      this._logger.warn(
        `REKTRS W6 translation to ${workingLanguage} failed: ${String(e)}`
      );
      return { status: 'FAILED', text: null };
    }
  }
}
