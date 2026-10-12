import { useEffect, useState } from 'react';
import { Check, Copy, Download, Pause, Play } from 'lucide-react';
import { clock } from '../lib/format.js';
import { download, slug, toMarkdown } from '../lib/markdown.js';

/** Small custom player for the uploaded file (object URL, never sent anywhere else). */
export function Player({ audioRef, src, time, duration, playing }) {
  return (
    <div className="player">
      <audio ref={audioRef} src={src} preload="metadata" />
      <button
        type="button"
        className="player__btn"
        onClick={() => (audioRef.current.paused ? audioRef.current.play() : audioRef.current.pause())}
        aria-label={playing ? 'Pause' : 'Play'}
      >
        {playing ? <Pause size={18} strokeWidth={2.25} /> : <Play size={18} strokeWidth={2.25} />}
      </button>
      <input
        className="player__scrub"
        type="range"
        min={0}
        max={duration || 0}
        step={1}
        value={Math.min(time, duration || 0)}
        onChange={(e) => {
          audioRef.current.currentTime = Number(e.target.value);
        }}
        aria-label="Position in episode"
        aria-valuetext={`${clock(time)} of ${clock(duration)}`}
      />
      <span className="player__time">
        {clock(time)} / {clock(duration) ?? '–'}
      </span>
    </div>
  );
}

function Export({ edition }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  const result = { overview: edition.overview, quiz: edition.quiz };
  const md = () => toMarkdown({ title: edition.title, result, segments: edition.segments });
  const name = slug(edition.title);

  return (
    <div className="export">
      <p className="rail__label">Take it with you</p>
      <button
        type="button"
        className="rail__action"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(md());
            setCopied(true);
          } catch {
            download(`${name}.md`, md(), 'text/markdown');
          }
        }}
      >
        {copied ? <Check size={16} strokeWidth={2} aria-hidden="true" /> : <Copy size={16} strokeWidth={2} aria-hidden="true" />}
        <span aria-live="polite">{copied ? 'Copied as Markdown' : 'Copy as Markdown'}</span>
      </button>
      <button type="button" className="rail__action" onClick={() => download(`${name}.md`, md(), 'text/markdown')}>
        <Download size={16} strokeWidth={2} aria-hidden="true" /> Download .md
      </button>
      <button
        type="button"
        className="rail__action"
        onClick={() =>
          download(
            `${name}.json`,
            JSON.stringify({ title: edition.title, generatedAt: new Date().toISOString(), hasTimestamps: edition.hasTimestamps, ...result, segments: edition.segments }, null, 2),
            'application/json',
          )
        }
      >
        <Download size={16} strokeWidth={2} aria-hidden="true" /> Download .json
      </button>
      {edition.quizStatus === 'working' && <p className="rail__fine">The quiz is still being set; export again once it's ready to include it.</p>}
    </div>
  );
}

/**
 * The contents page: sections and chapters with leaders ending in times. The active chapter
 * carries the reading position (or, with audio, a live marker of how far through it you are).
 */
export function Contents({ edition, active, onJump, audio, open, onToggle }) {
  const { chapters } = edition.overview;
  const sections = [
    ['summary', 'Summary', 'sec-summary'],
    ['takeaways', 'Key takeaways', 'sec-takeaways'],
  ];
  const tail = [
    ['quiz', 'Quiz', 'sec-quiz'],
    ['transcript', 'Transcript', 'sec-transcript'],
  ];
  const row = ([key, label, target]) => (
    <li key={key} className="toc__row" aria-current={active === key ? 'true' : undefined}>
      <a className="toc__link" href={`#${target}`} onClick={(e) => (e.preventDefault(), onJump(target))}>
        <span className="toc__label">{label}</span>
      </a>
    </li>
  );

  return (
    <nav className="rail" aria-label="Contents" data-open={open ? 'true' : 'false'}>
      <div className="rail__bar">
        {audio && <Player {...audio} />}
        <button type="button" className="rail__toggle" aria-expanded={open} aria-controls="rail-body" onClick={onToggle}>
          {open ? 'Hide contents' : 'Contents'}
        </button>
      </div>
      <div className="rail__body" id="rail-body">
      <p className="rail__label">Contents</p>
      <ol className="toc">
        {sections.map(row)}
        <li className="toc__row toc__row--group" aria-current={active === 'chapters' ? 'true' : undefined}>
          <a className="toc__link" href="#sec-chapters" onClick={(e) => (e.preventDefault(), onJump('sec-chapters'))}>
            <span className="toc__label">Chapters</span>
          </a>
          <ol className="toc toc--chapters">
            {chapters.map((c) => {
              const isActive = active === `chap-${c.id}`;
              const through =
                isActive && audio && c.start != null && c.end > c.start ? Math.max(0, Math.min(1, (audio.time - c.start) / (c.end - c.start))) : null;
              return (
                <li key={c.id} className="toc__row toc__row--chapter" aria-current={isActive ? 'true' : undefined}>
                  <a
                    className="toc__link"
                    href={`#chap-${c.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      onJump(`chap-${c.id}`, c.start);
                    }}
                  >
                    <span className="toc__label">{c.title}</span>
                    <span className="toc__leader" aria-hidden="true" />
                    <span className="toc__page">{c.start != null ? clock(c.start) : ''}</span>
                  </a>
                  {through != null && <span className="toc__marker" style={{ '--through': through }} aria-hidden="true" />}
                </li>
              );
            })}
          </ol>
        </li>
        {tail.map(row)}
      </ol>
      <Export edition={edition} />
      </div>
    </nav>
  );
}
