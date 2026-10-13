/**
 * Turn an ApiError into what the errata slip says: who is at fault, what happened,
 * and what the user can do about it.
 */
export const STAGE_LABELS = {
  preparing: 'Compressing audio on your device',
  uploading: 'Uploading audio',
  validating: 'Checking your file',
  probing: 'Reading audio details',
  compressing: 'Compressing audio',
  splitting: 'Splitting audio into parts',
  transcribing: 'Producing transcript',
  segmenting: 'Splitting the transcript into sections',
  summarizing: 'Summarizing the episode',
  writing_quiz: 'Writing quiz questions',
  checking_quotes: 'Checking quiz answers against the transcript',
  verifying: 'Fact-checking against the transcript',
  routing: 'Understanding your request',
  revising: 'Applying your revision',
};

const CATEGORY = {
  input: { label: 'Your input', title: 'Something about the input needs fixing' },
  limit: { label: 'Rate limit', title: 'Too many requests for a moment' },
  provider: { label: 'AI service', title: 'The AI service had a problem' },
  server: { label: 'Server', title: 'The Stanza server had a problem' },
  network: { label: 'Connection', title: "Can't reach the server" },
};

const ADVICE = {
  INVALID_INPUT: 'Check the text or file and try again.',
  FILE_TOO_LARGE: 'Try a smaller file or a shorter recording.',
  UNSUPPORTED_FORMAT: 'Use one of the supported formats listed under the drop zone.',
  AUDIO_TOO_LONG: 'Trim the recording, or paste its transcript instead.',
  AUDIO_UNREADABLE: 'Re-export the audio (MP3 or M4A work best) and upload it again.',
  NO_SPEECH: 'Make sure the file contains speech, or paste a transcript instead.',
  TOO_MANY_REQUESTS: 'This limit protects the shared free AI quota. Wait for the timer, then try again.',
  PROVIDER_RATE_LIMITED: 'The service is busy. Waiting a little and retrying usually works.',
  PROVIDER_QUOTA_EXHAUSTED: 'The free daily allowance is used up. Try again later (quotas reset daily).',
  PROVIDER_TIMEOUT: 'The service is slow right now. Retrying usually works.',
  PROVIDER_UNAVAILABLE: 'The service seems to be down or unreachable. Try again in a few minutes.',
  PROVIDER_REJECTED: 'The service refused this content. Different content may work.',
  MODEL_OUTPUT_INVALID: 'The AI gave answers that failed our accuracy checks twice. Retrying usually works.',
  ALL_PROVIDERS_FAILED: 'Every AI service we tried failed. Details for each are listed below.',
  PROVIDER_AUTH: 'This needs fixing by whoever runs the server; your input is fine.',
  NO_PROVIDER_CONFIGURED: 'This needs fixing by whoever runs the server; your input is fine.',
  AUDIO_PROCESSING_FAILED: 'Try again; if it keeps failing, paste a transcript instead.',
  INTERNAL: 'Try again; if it keeps happening, the problem is on our side.',
  NETWORK: 'Check your connection. If the server was asleep, it will answer within about a minute.',
  CONNECTION_LOST: 'Try again. Long audio can take a few minutes, so keep this tab open.',
  GATEWAY: 'Wait a moment and try again.',
};

export function describeError(err) {
  const category = CATEGORY[err.category] ? err.category : 'server';
  const meta = CATEGORY[category];
  const label = category === 'provider' && err.provider ? err.provider : meta.label;
  return {
    category,
    label,
    title: category === 'provider' && err.provider ? `${err.provider} had a problem` : meta.title,
    message: err.message,
    advice: ADVICE[err.code] ?? (err.retryable ? 'Try again.' : null),
    stage: err.stage ? (STAGE_LABELS[err.stage] ?? err.stage) : null,
    retryable: err.retryable !== false,
    retryAfterSeconds: err.retryAfterSeconds ?? null,
    attempts: err.attempts ?? null,
    code: err.code,
  };
}
