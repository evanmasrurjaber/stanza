import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { describeError } from '../api/errors.js';

function useCountdown(seconds) {
  const [left, setLeft] = useState(seconds ?? 0);
  useEffect(() => {
    setLeft(seconds ?? 0);
    if (!seconds) return;
    const t = setInterval(() => setLeft((l) => (l <= 1 ? (clearInterval(t), 0) : l - 1)), 1000);
    return () => clearInterval(t);
  }, [seconds]);
  return left;
}

/**
 * An errata slip: who is at fault (input / rate limit / named AI service / server / connection),
 * what happened, during which step, and what to do next.
 */
export function Errata({ error, onRetry, retryLabel = 'Try again', children, compact = false }) {
  const d = describeError(error);
  const wait = useCountdown(d.retryAfterSeconds);

  return (
    <div className={`errata${compact ? ' errata--compact' : ''}`} data-category={d.category} role="alert">
      <p className="errata__head">
        <span className="errata__word">Errata</span>
        <span className="errata__tag">{d.label}</span>
        {d.stage && <span className="errata__stage">during “{d.stage}”</span>}
      </p>
      <p className="errata__title">{d.title}</p>
      <p className="errata__message">{d.message}</p>
      {d.attempts?.length > 0 && (
        <ul className="errata__attempts" aria-label="What each AI service reported">
          {d.attempts.map((a, i) => (
            <li key={i}>
              <span className="errata__provider">{a.provider}</span> {a.message}
            </li>
          ))}
        </ul>
      )}
      {d.advice && <p className="errata__advice">{d.advice}</p>}
      {(onRetry || children) && (
        <div className="errata__actions">
          {onRetry && d.retryable && (
            <button type="button" className="btn btn--ink" onClick={onRetry} disabled={wait > 0}>
              <RotateCcw size={16} strokeWidth={2} aria-hidden="true" />
              {wait > 0 ? `${retryLabel} in ${wait} s` : retryLabel}
            </button>
          )}
          {children}
        </div>
      )}
    </div>
  );
}
