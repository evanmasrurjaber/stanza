import { Check, CircleDashed, AlertTriangle, X, Info } from 'lucide-react';
import { clock, eta } from '../lib/format.js';
import { Errata } from './Errata.jsx';

function Mark({ status }) {
  const props = { size: 18, strokeWidth: 2, 'aria-hidden': true };
  if (status === 'done') return <Check {...props} />;
  if (status === 'failed') return <X {...props} />;
  if (status === 'active') return <CircleDashed {...props} className="spin" />;
  return <span className="proof__dot" aria-hidden="true" />;
}

function Rule({ percent, estimated }) {
  if (percent == null) return <div className="rule rule--indeterminate" aria-hidden="true" />;
  return (
    <div
      className={`rule${estimated ? ' rule--estimated' : ''}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={`${estimated ? 'about ' : ''}${percent}%`}
    >
      <div className="rule__fill" style={{ transform: `scaleX(${percent / 100})` }} />
    </div>
  );
}

export function Notices({ notices }) {
  if (!notices?.length) return null;
  return (
    <ul className="notes">
      {notices.map((n, i) => (
        <li key={i} className={`note note--${n.level}`}>
          {n.level === 'warn' ? <AlertTriangle size={14} strokeWidth={2} aria-hidden="true" /> : <Info size={14} strokeWidth={2} aria-hidden="true" />}
          <span>{n.message}</span>
        </li>
      ))}
    </ul>
  );
}

function ActiveDetail({ step }) {
  const current = step.stages.at(-1);
  const earlier = step.stages.slice(0, -1);
  const left = eta(step.etaSeconds);
  return (
    <div className="proof__detail">
      {earlier.length > 0 && (
        <ul className="proof__done-stages">
          {earlier.map((s, i) => (
            <li key={i}>
              <Check size={14} strokeWidth={2} aria-hidden="true" /> {s.label}
              {s.message ? <span className="proof__msg"> · {s.message}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {current && (
        <>
          <p className="proof__stage">
            {current.label}
            {step.upload != null && current.stage === 'uploading' ? ` · ${Math.round(step.upload * 100)}%` : ''}
          </p>
          <Rule percent={step.percent} estimated={step.estimated} />
          <p className="proof__meta">
            {step.message ?? current.message ?? ''}
            {(step.message ?? current.message) && left ? ' · ' : ''}
            {left ? (step.estimated ? `estimated, ${left}` : left) : ''}
          </p>
        </>
      )}
      <Notices notices={step.notices} />
    </div>
  );
}

/** The galley proof: each step of the pipeline, what it's doing now, and anything that went wrong. */
export function Proof({ title, steps, onCancel, onRetry, onBack }) {
  const failed = steps.find((s) => s.status === 'failed');
  const current = steps.find((s) => s.status === 'active');
  return (
    <section className="sheet proof" aria-labelledby="proof-heading">
      <div className="proof__head">
        <h1 id="proof-heading" className="sheet__heading sheet__heading--small">
          {failed ? 'The edition stopped' : 'Setting your edition'}
        </h1>
        <p className="proof__source">{title}</p>
      </div>

      <p className="visually-hidden" aria-live="polite">
        {current ? `${current.label}: ${current.stages.at(-1)?.label ?? ''}` : ''}
      </p>

      <ol className="proof__steps">
        {steps.map((step, i) => (
          <li key={step.id} className="proof__step" data-status={step.status}>
            <div className="proof__row">
              <span className="proof__mark">
                <Mark status={step.status} />
              </span>
              <span className="proof__label">
                <span className="proof__count">
                  Step {i + 1} of {steps.length}
                </span>
                {step.label}
              </span>
              <span className="proof__time">{step.status === 'active' || step.status === 'done' ? clock(step.elapsedMs / 1000) : ''}</span>
            </div>
            {step.status === 'active' && <ActiveDetail step={step} />}
            {step.id === 'quiz' && step.status === 'waiting' && <p className="proof__later">Continues in the background while you start reading.</p>}
            {step.status === 'failed' && (
              <div className="proof__detail">
                <Errata error={step.error} onRetry={onRetry}>
                  <button type="button" className="btn btn--line" onClick={onBack}>
                    Change the input
                  </button>
                </Errata>
              </div>
            )}
          </li>
        ))}
      </ol>

      {!failed && (
        <div className="proof__foot">
          <p className="proof__hint">Long recordings take a few minutes. Keep this tab open; cancelling stops the work on the server.</p>
          <button type="button" className="btn btn--line" onClick={onCancel}>
            Cancel
          </button>
        </div>
      )}
    </section>
  );
}
