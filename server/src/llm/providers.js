import { createGeminiProvider } from './gemini.js';
import { createGroqChatProvider, createGroqWhisperProvider } from './groq.js';
import { createGeminiTranscribeProvider } from './geminiTranscribe.js';

// Groq's free tier allows ~8K tokens/min for gpt-oss-120b; leave room for the output.
export const GROQ_FALLBACK_MAX_INPUT_TOKENS = 5000;

/**
 * Build the provider set from config. Missing keys simply leave a slot empty;
 * routes report a clear error if the provider they need is unavailable.
 *   primary  – main generation (Gemini Flash)
 *   secondary – a second Gemini model tried when primary fails (overload often hits one model only)
 *   fallback – used when both Gemini models fail (Groq gpt-oss-120b; long inputs get a shortened transcript)
 *   router   – revision router (Groq gpt-oss-20b)
 *   whisper  – speech-to-text (Groq Whisper)
 *   transcribeFallback – speech-to-text when Whisper fails (Gemini 3.5 Transcribe)
 */
export function createProviders(config) {
  const { gemini, groq, llmTimeoutMs } = config;
  return {
    primary: gemini.apiKey ? createGeminiProvider({ apiKey: gemini.apiKey, model: gemini.model }) : null,
    secondary:
      gemini.apiKey && gemini.fallbackModel && gemini.fallbackModel !== gemini.model
        ? createGeminiProvider({ apiKey: gemini.apiKey, model: gemini.fallbackModel, label: `Gemini (${gemini.fallbackModel})` })
        : null,
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
    transcribeFallback: gemini.apiKey ? createGeminiTranscribeProvider({ apiKey: gemini.apiKey, model: gemini.transcribeModel }) : null,
  };
}
