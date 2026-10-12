import { createGeminiProvider } from './gemini.js';
import { createGroqChatProvider, createGroqWhisperProvider } from './groq.js';

// Groq's free tier allows ~8K tokens/min for gpt-oss-120b; leave room for the output.
export const GROQ_FALLBACK_MAX_INPUT_TOKENS = 5000;

/**
 * Build the provider set from config. Missing keys simply leave a slot empty;
 * routes report a clear error if the provider they need is unavailable.
 *   primary  – main generation (Gemini Flash)
 *   fallback – used when primary fails (Groq gpt-oss-120b, small inputs only)
 *   router   – revision router (Groq gpt-oss-20b)
 *   whisper  – speech-to-text (Groq Whisper)
 */
export function createProviders(config) {
  const { gemini, groq, llmTimeoutMs } = config;
  return {
    primary: gemini.apiKey ? createGeminiProvider(gemini) : null,
    fallback: groq.apiKey
      ? createGroqChatProvider({
          apiKey: groq.apiKey,
          model: groq.mainModel,
          timeoutMs: llmTimeoutMs,
          maxInputTokens: GROQ_FALLBACK_MAX_INPUT_TOKENS,
          reasoningEffort: 'medium',
        })
      : null,
    router: groq.apiKey
      ? createGroqChatProvider({ apiKey: groq.apiKey, model: groq.smallModel, timeoutMs: llmTimeoutMs, reasoningEffort: 'low' })
      : null,
    whisper: groq.apiKey
      ? createGroqWhisperProvider({ apiKey: groq.apiKey, model: groq.whisperModel, timeoutMs: 10 * 60_000 })
      : null,
  };
}
