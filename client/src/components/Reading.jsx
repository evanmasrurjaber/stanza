import { createContext, useContext, useEffect, useState } from 'react';
import { Check, Copy, Play, ShieldAlert, ShieldCheck } from 'lucide-react';
import { clock, paraNumber, plural } from '../lib/format.js';
import { chaptersText, copyText, summaryText, takeawaysText } from '../lib/plainText.js';

/** { segById, cite(id), highlight: { id, n }, seek(seconds) | null } */
export const EditionCtx = createContext(null);
const useEditionCtx = () => useContext(EditionCtx);

/** A footnote-style reference to a numbered paragraph: "¶12 · 4:30". */
export function Cite({ id, children }) {
  const { segById, cite } = useEditionCtx();
  const seg = segById.get(id);
  if (!seg) return null;
  const t = clock(seg.start);
  return (
    <button type="button" className="cite" onClick={() => cite(id)} aria-label={`Go to paragraph ${paraNumber(id)}${t ? ` at ${t}` : ''} in the transcript`}>
      {children ?? (
        <>
          ¶{paraNumber(id)}
          {t && <span className="cite__time"> · {t}</span>}
        </>
      )}
    </button>
  );
}

function Revised({ at }) {
  if (!at) return null;
  return <span className="revised">Revised</span>;
}

/** Fact-check status for a section: what an independent model confirmed against the cited paragraphs. */
export function FactCheck({ verification, what = 'Each sentence', detail }) {
  if (!verification) return null;
  const { status, checker } = verification;
  const by = checker ? ` by an independent model (${checker})` : '';
  if (status === 'unchecked') {
    return (
      <span className="factcheck factcheck--off" title={verification.note ?? 'The independent fact-checker was unavailable.'}>
        <ShieldAlert size={14} strokeWidth={2} aria-hidden="true" /> Not fact-checked
      </span>
    );
  }
  return (
    <span className={`factcheck${status === 'partial' ? ' factcheck--partial' : ''}`} title={detail ?? `${what} was checked against the transcript paragraphs it cites${by}.`}>
      <ShieldCheck size={14} strokeWidth={2} aria-hidden="true" /> {status === 'partial' ? 'Partly fact-checked' : 'Fact-checked'}
    </span>
  );
}

/** What the fact-check removed from a section, and why. Collapsed by default. */
export function Removed({ items, noun }) {
  if (!items?.length) return null;
  return (
    <details className="removed">
      <summary>
        {plural(items.length, noun)} removed by the fact-check
      </summary>
      <ul>
        {items.map((r, i) => (
          <li key={i}>
            <span className="removed__text">“{r.text ?? r.question}”</span> <span className="removed__why">{r.reason}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Copies a section as clean text (no citations). */
function CopyButton({ getText, label }) {
  const [state, setState] = useState('idle'); // idle | copied | failed
  useEffect(() => {
    if (state === 'idle') return;
    const t = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <button
      type="button"
      className="copy-btn"
      onClick={async () => setState((await copyText(getText())) ? 'copied' : 'failed')}
      aria-label={state === 'copied' ? `${label} copied` : `Copy ${label} as plain text`}
    >
      {state === 'copied' ? <Check size={14} strokeWidth={2.25} aria-hidden="true" /> : <Copy size={14} strokeWidth={2} aria-hidden="true" />}
      <span aria-live="polite">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}</span>
    </button>
  );
}

function SectionHead({ id, children, revisedAt, aside }) {
  return (
    <div className="section__head">
      <h2 id={id} className="section__title" tabIndex={-1}>
        {children}
      </h2>
      <Revised at={revisedAt} />
      {aside}
    </div>
  );
}

export function Overview({ overview, revised }) {
  const v = overview.verification;
  return (
    <section className="section" aria-labelledby="h-summary" id="sec-summary" data-spy="summary">
      <SectionHead
        id="h-summary"
        revisedAt={revised.summary}
        aside={
          <>
            <FactCheck verification={v} />
            <CopyButton label="summary" getText={() => summaryText(overview)} />
          </>
        }
      >
        Summary
      </SectionHead>
      <div className="prose" key={revised.summary ?? 0}>
        <p>
          {overview.summarySentences.map((s, i) => (
            <span key={i} className="sentence">
              {s.text}
              {s.segmentIds[0] && (
                <>
                  {' '}
                  <Cite id={s.segmentIds[0]} />
                </>
              )}{' '}
            </span>
          ))}
        </p>
      </div>
      <Removed items={v?.removed?.filter((r) => r.section === 'summary')} noun="sentence" />
      {overview.themes.length > 0 && (
        <p className="themes">
          <span className="themes__label">Themes</span>
          {overview.themes.map((t, i) => (
            <span key={i} className="themes__item">
              {t}
            </span>
          ))}
        </p>
      )}
    </section>
  );
}

export function Takeaways({ takeaways, revised, verification }) {
  return (
    <section className="section" aria-labelledby="h-takeaways" id="sec-takeaways" data-spy="takeaways">
      <SectionHead
        id="h-takeaways"
        revisedAt={revised.takeaways}
        aside={
          <>
            <FactCheck verification={verification} what="Each takeaway" />
            <CopyButton label="key takeaways" getText={() => takeawaysText(takeaways)} />
          </>
        }
      >
        Key takeaways
      </SectionHead>
      <ol className="takeaways">
        {takeaways.map((t, i) => (
          <li key={i} className="takeaway">
            <span className="takeaway__n" aria-hidden="true">
              {i + 1}
            </span>
            <p className="takeaway__text">
              {t.text}{' '}
              <span className="refs">
                {t.segmentIds.map((id) => (
                  <Cite key={id} id={id} />
                ))}
              </span>
            </p>
          </li>
        ))}
      </ol>
      <Removed items={verification?.removed?.filter((r) => r.section === 'takeaways')} noun="takeaway" />
    </section>
  );
}

export function Chapters({ chapters, revised, timestampNote, activeChapterId }) {
  const { seek } = useEditionCtx();
  return (
    <section className="section" aria-labelledby="h-chapters" id="sec-chapters" data-spy="chapters">
      <SectionHead id="h-chapters" revisedAt={revised.chapters} aside={<CopyButton label="chapters" getText={() => chaptersText(chapters)} />}>
        Chapters
      </SectionHead>
      {timestampNote && <p className="aside-note">{timestampNote}</p>}
      <ol className="chapters">
        {chapters.map((c, i) => (
          <li key={c.id} id={`chap-${c.id}`} className="chapter" data-spy={`chap-${c.id}`} aria-current={activeChapterId === c.id ? 'true' : undefined}>
            <div className="chapter__head">
              <span className="chapter__n" aria-hidden="true">
                {i + 1}
              </span>
              <h3 className="chapter__title">{c.title}</h3>
              {c.start != null && (
                <span className="chapter__time">
                  {clock(c.start)}–{clock(c.end)}
                </span>
              )}
            </div>
            <p className="chapter__text">{c.explanation}</p>
            <p className="chapter__refs">
              <Cite id={c.startSegmentId}>
                Read ¶{paraNumber(c.startSegmentId)}–{paraNumber(c.endSegmentId)}
              </Cite>
              {seek && c.start != null && (
                <button type="button" className="cite cite--play" onClick={() => seek(c.start, true)}>
                  <Play size={12} strokeWidth={2.5} aria-hidden="true" /> Play from {clock(c.start)}
                </button>
              )}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function Transcript({ segments }) {
  const { highlight, returnTo } = useEditionCtx();
  return (
    <section className="section section--transcript" aria-labelledby="h-transcript" id="sec-transcript" data-spy="transcript">
      <SectionHead id="h-transcript" aside={<span className="section__aside">{plural(segments.length, 'paragraph')}</span>}>
        Transcript
      </SectionHead>
      <ol className="verse">
        {segments.map((s) => {
          const lit = highlight?.id === s.id;
          return (
            <li key={s.id} id={`para-${s.id}`} className="verse__line" tabIndex={-1}>
              <span className="verse__n" aria-label={`Paragraph ${paraNumber(s.id)}`}>
                {paraNumber(s.id)}
              </span>
              <p className="verse__text">
                {s.start != null && <span className="verse__time">{clock(s.start)}</span>}
                <span key={lit ? highlight.n : 'off'} className={lit ? 'hl' : undefined}>
                  {s.text}
                </span>
              </p>
              {lit && returnTo != null && (
                <button type="button" className="btn btn--text verse__back" onClick={returnTo}>
                  Back to where you were
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
