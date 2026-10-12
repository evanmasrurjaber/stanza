import { useCallback, useRef, useState } from 'react';
import { postJson, postStream, uploadAudio } from '../api/client.js';

const QUESTION_COUNT = 6;

const freshStep = (id, label) => ({
  id,
  label,
  status: 'waiting', // waiting | active | done | failed
  stages: [], // [{ stage, label, message }]; the last one is current while active
  percent: null,
  etaSeconds: null,
  estimated: false,
  message: null,
  notices: [],
  upload: null,
  elapsedMs: 0,
  error: null,
});

function stepsFor(input) {
  return [
    freshStep('source', input.kind === 'audio' ? 'Transcribe the audio' : 'Read the transcript'),
    freshStep('overview', 'Write the overview and chapters'),
    freshStep('quiz', 'Set the quiz'),
  ];
}

/** Apply one streamed event to a step. */
function applyEvent(step, evt) {
  const next = { ...step, elapsedMs: evt.elapsedMs ?? step.elapsedMs };
  if (evt.type === 'stage') {
    next.stages = [...step.stages, { stage: evt.stage, label: evt.label, message: evt.message }];
    next.percent = evt.percent;
    next.etaSeconds = evt.etaSeconds;
    next.estimated = false;
    next.message = evt.message;
  } else if (evt.type === 'progress') {
    next.percent = evt.percent;
    next.etaSeconds = evt.etaSeconds;
    next.estimated = Boolean(evt.estimated);
    if (evt.message) next.message = evt.message;
  } else if (evt.type === 'notice') {
    next.notices = [...step.notices, { level: evt.level, message: evt.message, provider: evt.provider }];
  }
  return next;
}

/**
 * The whole client workflow: source → overview → quiz, then revisions with undo.
 * The server is stateless, so this hook owns segments and results.
 */
export function useEdition({ onNetworkError } = {}) {
  const [phase, setPhase] = useState('intake'); // intake | working | ready
  const [steps, setSteps] = useState([]);
  const [edition, setEdition] = useState(null);
  const [history, setHistory] = useState([]);
  const [revision, setRevision] = useState({ status: 'idle' });
  const controllerRef = useRef(null);
  const inputRef = useRef(null);
  const editionRef = useRef(null);
  const historyRef = useRef([]);
  const revisionControllerRef = useRef(null);
  editionRef.current = edition;
  historyRef.current = history;

  const patchStep = useCallback((id, fn) => setSteps((all) => all.map((s) => (s.id === id ? fn(s) : s))), []);

  const fail = useCallback(
    (id, err) => {
      if (err.category === 'aborted') return;
      if (err.category === 'network') onNetworkError?.();
      patchStep(id, (s) => ({ ...s, status: 'failed', error: err }));
    },
    [patchStep, onNetworkError],
  );

  // ---------- steps ----------
  const runSource = useCallback(
    async (input, signal) => {
      patchStep('source', (s) => ({ ...freshStep(s.id, s.label), status: 'active' }));
      const onEvent = (evt) => patchStep('source', (s) => applyEvent(s, evt));
      let data;
      if (input.kind === 'audio') {
        patchStep('source', (s) => applyEvent(s, { type: 'stage', stage: 'uploading', label: 'Uploading audio', percent: 0 }));
        data = await uploadAudio(input.file, {
          signal,
          onEvent,
          onUploadProgress: (f) => patchStep('source', (s) => (s.stages.at(-1)?.stage === 'uploading' ? { ...s, upload: f, percent: Math.round(f * 100) } : s)),
        });
      } else {
        onEvent({ type: 'stage', stage: 'segmenting', label: 'Numbering the transcript' });
        if (input.kind === 'file') {
          const form = new FormData();
          form.append('file', input.file);
          data = await postJson('/api/transcript', form, { signal });
        } else {
          data = await postJson('/api/transcript', { text: input.text }, { signal });
        }
      }
      patchStep('source', (s) => ({ ...s, status: 'done', percent: 100 }));
      return data;
    },
    [patchStep],
  );

  const runOverview = useCallback(
    async (source, signal) => {
      patchStep('overview', (s) => ({ ...freshStep(s.id, s.label), status: 'active' }));
      const data = await postStream(
        '/api/generate/overview',
        { segments: source.segments, hasTimestamps: source.hasTimestamps },
        { signal, onEvent: (evt) => patchStep('overview', (s) => applyEvent(s, evt)) },
      );
      patchStep('overview', (s) => ({ ...s, status: 'done', percent: 100 }));
      return data;
    },
    [patchStep],
  );

  const runQuiz = useCallback(
    async (ed, signal) => {
      patchStep('quiz', (s) => ({ ...freshStep(s.id, s.label), status: 'active' }));
      setEdition((e) => e && { ...e, quizStatus: 'working', quizError: null });
      try {
        const data = await postStream(
          '/api/generate/quiz',
          { segments: ed.segments, chapters: ed.overview.chapters, questionCount: QUESTION_COUNT },
          { signal, onEvent: (evt) => patchStep('quiz', (s) => applyEvent(s, evt)) },
        );
        patchStep('quiz', (s) => ({ ...s, status: 'done', percent: 100 }));
        setEdition((e) => e && { ...e, quiz: data.quiz, quizStatus: 'done' });
      } catch (err) {
        if (err.category === 'aborted') return;
        fail('quiz', err);
        setEdition((e) => e && { ...e, quizStatus: 'failed', quizError: err });
      }
    },
    [patchStep, fail],
  );

  /** Run (or resume) the pipeline. Completed steps are reused when retrying. */
  const run = useCallback(
    async (input, { resumeFrom } = {}) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const { signal } = controller;
      inputRef.current = input;

      let source = resumeFrom?.source ?? null;
      if (!resumeFrom) {
        setSteps(stepsFor(input));
        setEdition(null);
        setHistory([]);
        setRevision({ status: 'idle' });
      }
      setPhase('working');

      if (!source) {
        try {
          source = await runSource(input, signal);
        } catch (err) {
          return fail('source', err);
        }
      }

      let overview;
      try {
        overview = await runOverview(source, signal);
      } catch (err) {
        // Keep the transcript so "Try again" resumes at the overview.
        setEdition({ ...baseEdition(input, source), overview: null });
        return fail('overview', err);
      }

      const ed = {
        ...baseEdition(input, source),
        overview: overview.overview,
        timestampNote: overview.timestampNote,
        quiz: null,
        quizStatus: 'working',
        quizError: null,
        revised: {},
      };
      setEdition(ed);
      setPhase('ready');
      // The quiz is written while the user starts reading.
      runQuiz(ed, signal);
    },
    [runSource, runOverview, runQuiz, fail],
  );

  const start = useCallback((input) => run(input), [run]);

  const retry = useCallback(() => {
    const input = inputRef.current;
    const ed = editionRef.current;
    if (!input) return;
    if (ed?.segments) run(input, { resumeFrom: { source: ed } });
    else run(input);
  }, [run]);

  const retryQuiz = useCallback(() => {
    const ed = editionRef.current;
    if (!ed?.overview) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    runQuiz(ed, controller.signal);
  }, [runQuiz]);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    setPhase('intake');
    setSteps([]);
  }, []);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    if (editionRef.current?.audioUrl) URL.revokeObjectURL(editionRef.current.audioUrl);
    setPhase('intake');
    setSteps([]);
    setEdition(null);
    setHistory([]);
    setRevision({ status: 'idle' });
  }, []);

  // ---------- revisions ----------
  const revise = useCallback(
    async ({ request, preset }) => {
      const ed = editionRef.current;
      if (!ed?.overview) return;
      revisionControllerRef.current?.abort();
      const controller = new AbortController();
      revisionControllerRef.current = controller;
      setRevision({ status: 'working', request: request ?? null, preset: preset ?? null, stages: [], notices: [] });
      try {
        const data = await postStream(
          '/api/revise',
          {
            ...(preset ? { preset } : { request }),
            result: { overview: ed.overview, quiz: ed.quizStatus === 'done' ? ed.quiz : null, hasTimestamps: ed.hasTimestamps },
            segments: ed.segments,
          },
          {
            signal: controller.signal,
            onEvent: (evt) =>
              setRevision((r) => {
                if (r.status !== 'working') return r;
                if (evt.type === 'stage') return { ...r, stages: [...r.stages, { stage: evt.stage, label: evt.label, message: evt.message }] };
                if (evt.type === 'notice') return { ...r, notices: [...r.notices, evt] };
                if (evt.type === 'progress' && evt.message) return { ...r, message: evt.message };
                return r;
              }),
          },
        );
        if (data.action === 'revise') {
          setHistory((h) => [...h, { overview: ed.overview, quiz: ed.quiz, changed: data.changed }]);
          const stamp = Date.now();
          setEdition((e) => ({
            ...e,
            overview: data.result.overview,
            quiz: data.result.quiz ?? e.quiz,
            revised: Object.fromEntries(data.changed.map((c) => [c.split(':')[0], stamp])),
          }));
        }
        setRevision({ status: 'done', request: request ?? null, preset: preset ?? null, outcome: data });
      } catch (err) {
        if (err.category === 'aborted') return setRevision({ status: 'idle' });
        if (err.category === 'network') onNetworkError?.();
        setRevision({ status: 'failed', request: request ?? null, preset: preset ?? null, error: err });
      }
    },
    [onNetworkError],
  );

  const cancelRevision = useCallback(() => {
    revisionControllerRef.current?.abort();
    setRevision({ status: 'idle' });
  }, []);

  const undo = useCallback(() => {
    const h = historyRef.current;
    if (!h.length) return;
    const prev = h.at(-1);
    setHistory(h.slice(0, -1));
    // A quiz that finished after the revision started is kept rather than undone to "no quiz".
    setEdition((e) => ({ ...e, overview: prev.overview, quiz: prev.quiz ?? e.quiz, revised: {} }));
    setRevision({ status: 'undone', changed: prev.changed });
  }, []);

  const dismissRevision = useCallback(() => setRevision({ status: 'idle' }), []);

  return { phase, steps, edition, history, revision, start, retry, retryQuiz, cancel, reset, revise, cancelRevision, undo, dismissRevision };
}

function baseEdition(input, source) {
  return {
    title: input.title,
    sourceKind: input.kind,
    audioUrl: input.kind === 'audio' ? input.audioUrl : null,
    segments: source.segments,
    hasTimestamps: source.hasTimestamps,
    durationSec: source.durationSec ?? null,
  };
}
