/**
 * Progress reporting. Pipelines receive a `progress` object and call:
 *   progress.stage('transcribing', { etaSeconds })   – entering a new user-visible step
 *   progress.update({ percent, etaSeconds, message }) – progress within the current step
 *   progress.notice('Gemini is busy…', { level })   – something the user should know (retry, fallback)
 *
 * In streaming mode these become NDJSON events (see lib/stream.js); otherwise they are no-ops.
 */
export const STAGES = Object.freeze({
  validating: 'Checking your file',
  probing: 'Reading audio details',
  compressing: 'Compressing audio',
  splitting: 'Splitting audio into parts',
  transcribing: 'Producing transcript',
  segmenting: 'Splitting the transcript into sections',
  summarizing: 'Summarizing the episode and building chapters',
  writing_quiz: 'Writing quiz questions',
  checking_quotes: 'Checking quiz answers against the transcript',
  verifying: 'Fact-checking against the transcript',
  routing: 'Understanding your request',
  revising: 'Applying your revision',
});

export function createProgress(emit = () => {}) {
  let current = null;
  return {
    get current() {
      return current;
    },
    stage(stage, { message = null, percent = null, etaSeconds = null } = {}) {
      current = stage;
      emit({ type: 'stage', stage, label: STAGES[stage] ?? stage, message, percent, etaSeconds });
    },
    /** `estimated: true` marks time-based guesses (no real progress signal), so the UI can show it differently. */
    update({ percent = null, etaSeconds = null, message = null, estimated = false } = {}) {
      const p = percent == null ? null : Math.max(0, Math.min(100, Math.round(percent)));
      emit({
        type: 'progress',
        stage: current,
        percent: p,
        etaSeconds: etaSeconds == null ? null : Math.max(0, Math.round(etaSeconds)),
        message,
        estimated,
      });
    },
    notice(message, { level = 'info', provider = null } = {}) {
      emit({ type: 'notice', stage: current, level, message, provider });
    },
  };
}

export const noopProgress = () => createProgress();

/**
 * For steps with no real progress signal (an LLM or Whisper call), emit a time-based estimate
 * every few seconds, capped at 95% until the step actually finishes. Returns a stop function.
 */
export function startEstimate(progress, expectedSeconds, { intervalMs = 3000 } = {}) {
  const started = Date.now();
  const tick = () => {
    const elapsed = (Date.now() - started) / 1000;
    const overdue = elapsed > expectedSeconds;
    progress.update({
      percent: Math.min(95, (elapsed / expectedSeconds) * 100),
      etaSeconds: overdue ? null : expectedSeconds - elapsed,
      message: overdue ? 'Taking longer than usual, still working…' : null,
      estimated: true,
    });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Rough LLM latency guess for ETA display: fixed overhead + input size. Only used for UX, never for logic. */
export const estimateLlmSeconds = (inputChars) => Math.round(10 + inputChars / 20_000);
