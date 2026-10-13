import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Band } from './components/Band.jsx';
import { ContentsPreview, Intake, emptyDraft } from './components/Intake.jsx';
import { Proof } from './components/Proof.jsx';
import { Contents } from './components/Contents.jsx';
import { Chapters, EditionCtx, Overview, Takeaways, Transcript } from './components/Reading.jsx';
import { Quiz } from './components/Quiz.jsx';
import { RevisionDock } from './components/RevisionDock.jsx';
import { useKeepAwake, useServer } from './hooks/useServer.js';
import { useEdition } from './hooks/useEdition.js';

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Which section/chapter the reader is in: the last [data-spy] element whose top has passed the reading line. */
function useScrollSpy(enabled, deps) {
  const [active, setActive] = useState('summary');
  useEffect(() => {
    if (!enabled) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const line = window.innerHeight * 0.3;
      let current = 'summary';
      for (const el of document.querySelectorAll('[data-spy]')) {
        if (el.getBoundingClientRect().top <= line) current = el.dataset.spy;
      }
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      cancelAnimationFrame(frame);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);
  return active;
}

function useAudio(src) {
  const ref = useRef(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    const onTime = () => setTime(a.currentTime);
    const onMeta = () => setDuration(Number.isFinite(a.duration) ? a.duration : 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('loadedmetadata', onMeta);
    a.addEventListener('play', onPlay);
    a.addEventListener('pause', onPause);
    return () => {
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('loadedmetadata', onMeta);
      a.removeEventListener('play', onPlay);
      a.removeEventListener('pause', onPause);
    };
  }, [src]);
  return { audioRef: ref, src, time, duration, playing };
}

export default function App() {
  const server = useServer();
  const ed = useEdition({ onNetworkError: server.recheck });
  const [draft, setDraft] = useState(emptyDraft);
  const [highlight, setHighlight] = useState(null);
  const [returnY, setReturnY] = useState(null);
  const [railOpen, setRailOpen] = useState(false);
  const edition = ed.edition;
  const ready = ed.phase === 'ready' && edition?.overview;
  useKeepAwake(ed.phase === 'working' || edition?.quizStatus === 'working' || ed.revision.status === 'working');

  const audio = useAudio(ready ? edition.audioUrl : null);
  const segById = useMemo(() => new Map((edition?.segments ?? []).map((s) => [s.id, s])), [edition?.segments]);
  const spy = useScrollSpy(Boolean(ready), [edition?.overview, edition?.quizStatus]);

  // With audio playing, the chapter under the playhead is the active one.
  const audioChapter = useMemo(() => {
    if (!ready || !edition.audioUrl || !audio.time) return null;
    const c = [...edition.overview.chapters].reverse().find((ch) => ch.start != null && ch.start <= audio.time);
    return c ? `chap-${c.id}` : null;
  }, [ready, edition, audio.time]);
  const active = audio.playing && audioChapter ? audioChapter : spy;

  // Move focus to the edition when it opens so keyboard and screen-reader users land on it.
  const wasReady = useRef(false);
  useEffect(() => {
    if (ready && !wasReady.current) {
      window.scrollTo({ top: 0 });
      document.getElementById('h-summary')?.focus?.();
    }
    wasReady.current = Boolean(ready);
  }, [ready]);

  const scrollToId = useCallback((id, block = 'start') => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block });
  }, []);

  const seek = useCallback(
    (seconds, play = false) => {
      const a = audio.audioRef.current;
      if (!a || seconds == null) return;
      a.currentTime = seconds;
      if (play) a.play().catch(() => {});
    },
    [audio.audioRef],
  );

  const cite = useCallback(
    (id) => {
      setReturnY(window.scrollY);
      setHighlight((h) => ({ id, n: (h?.n ?? 0) + 1 }));
      requestAnimationFrame(() => {
        scrollToId(`para-${id}`, 'center');
        document.getElementById(`para-${id}`)?.focus({ preventScroll: true });
      });
    },
    [scrollToId],
  );

  const returnTo = useCallback(() => {
    if (returnY == null) return;
    window.scrollTo({ top: returnY, behavior: reducedMotion() ? 'auto' : 'smooth' });
    setReturnY(null);
  }, [returnY]);

  const ctx = useMemo(
    () => ({ segById, cite, highlight, returnTo: returnY != null ? returnTo : null, seek: edition?.audioUrl ? seek : null }),
    [segById, cite, highlight, returnTo, returnY, seek, edition?.audioUrl],
  );

  const newEdition = () => {
    ed.reset();
    setDraft(emptyDraft);
    setHighlight(null);
    setReturnY(null);
  };

  if (!ready) {
    return (
      <div className="app app--cover">
        <Band server={server}>
          <div className="cover">
            {ed.phase === 'working' ? (
              <Proof title={ed.steps.length ? (edition?.title ?? draftTitle(draft)) : ''} steps={ed.steps} onCancel={ed.cancel} onRetry={ed.retry} onBack={ed.cancel} />
            ) : (
              <Intake draft={draft} setDraft={setDraft} limits={server.limits} providers={server.providers} serverStatus={server.status} onSubmit={ed.start} />
            )}
            <ContentsPreview />
          </div>
        </Band>
      </div>
    );
  }

  const quizStep = ed.steps.find((s) => s.id === 'quiz');

  return (
    <EditionCtx.Provider value={ctx}>
      <div className="app app--edition">
        <a className="skip" href="#reading">
          Skip to the edition
        </a>
        <Band server={server} compact title={edition.title} onNew={newEdition} />
        <div className="spread">
          <Contents
            edition={edition}
            active={active}
            open={railOpen}
            onToggle={() => setRailOpen((o) => !o)}
            onJump={(target, seconds) => {
              setRailOpen(false);
              scrollToId(target);
              if (seconds != null && edition.audioUrl) seek(seconds);
            }}
            audio={edition.audioUrl ? audio : null}
          />
          <main className="reading" id="reading">
            <Overview overview={edition.overview} revised={edition.revised} />
            <Takeaways takeaways={edition.overview.takeaways} revised={edition.revised} verification={edition.overview.verification} />
            <Chapters
              chapters={edition.overview.chapters}
              revised={edition.revised}
              timestampNote={edition.timestampNote}
              activeChapterId={active.startsWith('chap-') ? active.slice(5) : null}
            />
            <Quiz edition={edition} step={quizStep} onRetry={ed.retryQuiz} />
            <Transcript segments={edition.segments} />
            <RevisionDock
              revision={ed.revision}
              quizReady={edition.quizStatus === 'done'}
              canUndo={ed.history.length > 0}
              onRevise={ed.revise}
              onUndo={ed.undo}
              onDismiss={ed.dismissRevision}
              onCancel={ed.cancelRevision}
            />
          </main>
        </div>
      </div>
    </EditionCtx.Provider>
  );
}

function draftTitle(draft) {
  if (draft.file) return draft.file.name;
  return draft.title ?? 'Pasted transcript';
}
