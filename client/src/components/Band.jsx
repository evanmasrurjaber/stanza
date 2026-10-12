import { useEffect, useState } from 'react';
import { clock } from '../lib/format.js';

function useTick(active) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** The server status, set like a press line on an edition cover. */
export function PressLine({ server }) {
  const now = useTick(server.status === 'waking' || server.status === 'offline');
  const waited = server.wakingSince ? clock((now - server.wakingSince) / 1000) : null;

  let text;
  let detail = null;
  if (server.status === 'checking') text = 'Checking the server…';
  else if (server.status === 'ready') text = 'Server ready';
  else if (server.status === 'waking') {
    text = `Waking the server · ${waited}`;
    detail = 'Free hosting sleeps when idle and takes about a minute to start. You can prepare your episode meanwhile.';
  } else {
    text = 'Server unreachable · still trying';
    detail = 'It has not answered for over two minutes. It may be down; your input is kept here.';
  }

  return (
    <div className="press" data-status={server.status} role="status" aria-live="polite">
      <span className="press__mark" aria-hidden="true" />
      <span className="press__text">{text}</span>
      {detail && <span className="press__detail">{detail}</span>}
    </div>
  );
}

export function Band({ server, compact = false, title, onNew, children }) {
  return (
    <header className={`band${compact ? ' band--compact' : ''}`}>
      <div className="band__top">
        <p className="wordmark">
          {compact ? (
            <button type="button" className="wordmark__link" onClick={onNew}>
              Stanza
            </button>
          ) : (
            'Stanza'
          )}
        </p>
        {compact && title && <p className="band__title">{title}</p>}
        <PressLine server={server} />
        {compact && (
          <button type="button" className="btn btn--ink btn--small band__new" onClick={onNew}>
            New edition
          </button>
        )}
      </div>
      {children}
    </header>
  );
}
