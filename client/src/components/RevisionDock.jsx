import { useRef, useState } from 'react';
import { CircleDashed, Undo2, X } from 'lucide-react';
import { Errata } from './Errata.jsx';
import { Notices } from './Proof.jsx';

const PRESETS = [
  ['shorter_summary', 'Shorter summary', 'summary'],
  ['simpler_summary', 'Simpler summary', 'summary'],
  ['harder_quiz', 'Harder quiz', 'quiz'],
  ['easier_quiz', 'Easier quiz', 'quiz'],
  ['more_chapters', 'More chapters', 'chapters'],
  ['fewer_chapters', 'Fewer chapters', 'chapters'],
];
const PRESET_LABEL = Object.fromEntries(PRESETS.map(([id, label]) => [id, label]));

function describeChanged(changed) {
  const parts = changed.map((c) => {
    const [section, id] = c.split(':');
    if (id) return section === 'quiz' ? `question ${id.replace('Q', '')}` : `chapter ${id.replace('C', '')}`;
    return { summary: 'the summary', takeaways: 'the takeaways', chapters: 'the chapters', quiz: 'the quiz' }[section] ?? section;
  });
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
}

function Status({ revision, canUndo, onUndo, onDismiss, onCancel, onRetry }) {
  const { status } = revision;
  if (status === 'idle') return null;

  if (status === 'working') {
    const stage = revision.stages.at(-1);
    return (
      <div className="dock__status" role="status" aria-live="polite">
        <p className="dock__line">
          <CircleDashed size={16} strokeWidth={2} className="spin" aria-hidden="true" />
          <span>
            {stage?.label ?? 'Sending your request'}
            {stage?.message ? ` · ${stage.message}` : ''}
            {revision.message ? ` · ${revision.message}` : ''}
          </span>
          <button type="button" className="btn btn--text" onClick={onCancel}>
            Cancel
          </button>
        </p>
        <Notices notices={revision.notices} />
      </div>
    );
  }

  if (status === 'failed') {
    return (
      <div className="dock__status">
        <Errata error={revision.error} onRetry={onRetry} retryLabel="Retry the revision" compact>
          <button type="button" className="btn btn--text" onClick={onDismiss}>
            Dismiss
          </button>
        </Errata>
      </div>
    );
  }

  const asked = revision.preset ? PRESET_LABEL[revision.preset] : revision.request ? `“${revision.request}”` : null;
  let body;
  if (status === 'undone') body = <p className="dock__line">Undid the change to {describeChanged(revision.changed)}.</p>;
  else {
    const o = revision.outcome;
    if (o.action === 'revise') {
      body = (
        <>
          <p className="dock__line">
            <strong>Revised {describeChanged(o.changed)}.</strong> Everything else is unchanged.
          </p>
          {o.notes?.map((n, i) => (
            <p key={i} className="dock__fine">
              {n}
            </p>
          ))}
          {o.failed?.map((f, i) => (
            <p key={i} className="dock__fine dock__fine--warn">
              Could not revise {f.target}: {f.error.message}
            </p>
          ))}
        </>
      );
    } else if (o.action === 'clarify') {
      body = (
        <p className="dock__line">
          <strong>Which part do you mean?</strong> {o.clarifyQuestion}
        </p>
      );
    } else {
      body = (
        <p className="dock__line">
          <strong>Stanza can’t make that change.</strong> {o.rejectReason}
        </p>
      );
    }
  }

  return (
    <div className="dock__status" role="status" aria-live="polite" data-outcome={revision.outcome?.action ?? status}>
      {asked && <p className="dock__asked">You asked: {asked}</p>}
      {body}
      <div className="dock__actions">
        {canUndo && status === 'done' && revision.outcome?.action === 'revise' && (
          <button type="button" className="btn btn--line btn--small" onClick={onUndo}>
            <Undo2 size={14} strokeWidth={2} aria-hidden="true" /> Undo
          </button>
        )}
        <button type="button" className="icon-btn" onClick={onDismiss} aria-label="Dismiss">
          <X size={16} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

/** The editor's desk: free-text revision requests plus presets that skip the router. */
export function RevisionDock({ revision, quizReady, canUndo, onRevise, onUndo, onDismiss, onCancel }) {
  const [text, setText] = useState('');
  const inputRef = useRef(null);
  const busy = revision.status === 'working';

  return (
    <div className="dock" aria-label="Revise the edition" role="region">
      <Status
        revision={revision}
        canUndo={canUndo}
        onUndo={onUndo}
        onDismiss={onDismiss}
        onCancel={onCancel}
        onRetry={() => onRevise(revision.preset ? { preset: revision.preset } : { request: revision.request })}
      />
      <form
        className="dock__form"
        onSubmit={(e) => {
          e.preventDefault();
          const request = text.trim();
          if (!request || busy) return;
          onRevise({ request });
          setText('');
        }}
      >
        <label className="visually-hidden" htmlFor="revise-input">
          Ask for a change
        </label>
        <input
          ref={inputRef}
          id="revise-input"
          className="dock__input"
          value={text}
          maxLength={500}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask for a change, e.g. “make question 2 harder”"
          disabled={busy}
          autoComplete="off"
        />
        <button type="submit" className="btn btn--ink" disabled={busy || !text.trim()}>
          Revise
        </button>
      </form>
      <div className="dock__presets" role="group" aria-label="Quick revisions">
        {PRESETS.map(([id, label, section]) => {
          const blocked = section === 'quiz' && !quizReady;
          return (
            <button
              key={id}
              type="button"
              className="chip"
              disabled={busy || blocked}
              title={blocked ? 'Available once the quiz is ready' : undefined}
              onClick={() => onRevise({ preset: id })}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
