import { createContext, useContext } from 'react';
import { Play } from 'lucide-react';
import { clock, paraNumber, plural } from '../lib/format.js';

/** { segById, cite(id), highlight: { id, n }, seek(seconds) | null } */
export const EditionCtx = createContext(null);
export const useEditionCtx = () => useContext(EditionCtx);

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
  return (
    <section className="section" aria-labelledby="h-summary" id="sec-summary" data-spy="summary">
      <SectionHead id="h-summary" revisedAt={revised.summary}>
        Summary
      </SectionHead>
      <div className="prose" key={revised.summary ?? 0}>
        {overview.summary
          .split(/\n{2,}/)
          .filter(Boolean)
          .map((p, i) => (
            <p key={i}>{p}</p>
          ))}
      </div>
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

export function Takeaways({ takeaways, revised }) {
  return (
    <section className="section" aria-labelledby="h-takeaways" id="sec-takeaways" data-spy="takeaways">
      <SectionHead id="h-takeaways" revisedAt={revised.takeaways}>
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
    </section>
  );
}

export function Chapters({ chapters, revised, timestampNote, activeChapterId }) {
  const { seek } = useEditionCtx();
  return (
    <section className="section" aria-labelledby="h-chapters" id="sec-chapters" data-spy="chapters">
      <SectionHead id="h-chapters" revisedAt={revised.chapters}>
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
