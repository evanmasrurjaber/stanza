import { useId, useRef, useState } from 'react';
import { FileAudio, FileText, Upload, X } from 'lucide-react';
import { clock, extensionOf, megabytes } from '../lib/format.js';
import { SAMPLE_TITLE, SAMPLE_TRANSCRIPT } from '../lib/sample.js';

/** Read an audio file's duration in the browser so over-long files are caught before uploading. */
function readDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const done = (v) => {
      URL.revokeObjectURL(url);
      resolve(v);
    };
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) ? audio.duration : null);
    audio.onerror = () => done(null);
    setTimeout(() => done(null), 5000);
    audio.src = url;
  });
}

export const emptyDraft = { text: '', title: null, file: null, fileKind: null, duration: null, problem: null };

export function Intake({ draft, setDraft, limits, providers, serverStatus, onSubmit }) {
  const fileInput = useRef(null);
  const [dragging, setDragging] = useState(false);
  const textId = useId();
  const audioOff = providers && providers.transcription === false;
  const audioExts = limits.audio.extensions;
  const textExts = limits.transcript.fileExtensions;
  const maxChars = limits.transcript.maxChars;

  async function takeFile(file) {
    if (!file) return;
    const ext = extensionOf(file.name);
    const kind = audioExts.includes(ext) ? 'audio' : textExts.includes(ext) ? 'transcript' : null;
    if (!kind) {
      return setDraft({ ...draft, problem: `“.${ext || '?'}” files aren't supported. Use audio (${audioExts.join(', ')}) or a transcript (${textExts.join(', ')}).` });
    }
    if (kind === 'audio' && audioOff) {
      return setDraft({ ...draft, problem: 'Audio transcription is not configured on this server. Paste or upload a transcript instead.' });
    }
    const maxBytes = kind === 'audio' ? limits.audio.maxMegabytes * 1024 * 1024 : maxChars * 4;
    if (file.size > maxBytes) {
      return setDraft({ ...draft, problem: `${file.name} is ${megabytes(file.size)}; the limit for ${kind} files is ${megabytes(maxBytes)}.` });
    }
    let duration = null;
    if (kind === 'audio') {
      duration = await readDuration(file);
      if (duration && duration > limits.audio.maxSeconds) {
        return setDraft({ ...draft, problem: `${file.name} is ${clock(duration)} long; the limit is ${clock(limits.audio.maxSeconds)}. Trim it or paste its transcript.` });
      }
    }
    setDraft({ ...draft, file, fileKind: kind, duration, problem: null });
  }

  const textTooLong = draft.text.length > maxChars;
  const hasInput = Boolean(draft.file) || draft.text.trim().length > 0;
  const ready = serverStatus === 'ready';
  const canSubmit = hasInput && ready && !textTooLong;

  function submit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    if (draft.file) {
      const title = draft.file.name.replace(/\.[^.]+$/, '');
      if (draft.fileKind === 'audio') onSubmit({ kind: 'audio', file: draft.file, title, audioUrl: URL.createObjectURL(draft.file) });
      else onSubmit({ kind: 'file', file: draft.file, title });
    } else {
      onSubmit({ kind: 'text', text: draft.text, title: draft.title ?? 'Pasted transcript' });
    }
  }

  return (
    <form className="sheet intake" onSubmit={submit} aria-labelledby="intake-heading">
      <h1 id="intake-heading" className="sheet__heading">
        Make a study edition of any episode.
      </h1>
      <p className="sheet__lede">
        Bring a recording or its transcript. Stanza writes the overview, divides it into chapters and sets a quiz. Every answer is footnoted to a numbered line of the episode.
      </p>

      <div className="intake__grid">
        {draft.file ? (
          <div className="plate" aria-live="polite">
            {draft.fileKind === 'audio' ? <FileAudio size={28} strokeWidth={1.5} aria-hidden="true" /> : <FileText size={28} strokeWidth={1.5} aria-hidden="true" />}
            <div className="plate__body">
              <p className="plate__name">{draft.file.name}</p>
              <p className="plate__meta">
                {draft.fileKind === 'audio' ? 'Audio' : 'Transcript file'} · {megabytes(draft.file.size)}
                {draft.duration ? ` · ${clock(draft.duration)}` : ''}
              </p>
              {draft.fileKind === 'audio' && <p className="plate__note">Chapters will carry real times from the recording, and you can play it alongside the edition.</p>}
            </div>
            <button type="button" className="icon-btn" onClick={() => setDraft({ ...draft, file: null, fileKind: null, duration: null })} aria-label={`Remove ${draft.file.name}`}>
              <X size={18} strokeWidth={2} />
            </button>
          </div>
        ) : (
          <div
            className={`drop${dragging ? ' drop--over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              takeFile(e.dataTransfer.files?.[0]);
            }}
          >
            <Upload size={28} strokeWidth={1.5} aria-hidden="true" />
            <p className="drop__title">Drop audio or a transcript file</p>
            <p className="drop__hint">
              {audioOff ? 'Audio is unavailable on this server · ' : `${audioExts.join(', ')} up to ${limits.audio.maxMegabytes} MB and ${clock(limits.audio.maxSeconds)} · `}
              {textExts.join(', ')}
            </p>
            <button type="button" className="btn btn--line" onClick={() => fileInput.current?.click()}>
              Choose a file
            </button>
            <input
              ref={fileInput}
              type="file"
              className="visually-hidden"
              tabIndex={-1}
              accept={[...(audioOff ? [] : audioExts), ...textExts].map((x) => `.${x}`).join(',')}
              onChange={(e) => {
                takeFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </div>
        )}

        <div className="paste">
          <label htmlFor={textId} className="paste__label">
            Or paste a transcript
          </label>
          {draft.file ? (
            <p className="paste__off">Using {draft.file.name}. Remove it to paste text instead.</p>
          ) : (
            <>
              <textarea
                id={textId}
                className="paste__area"
                value={draft.text}
                onChange={(e) => setDraft({ ...draft, text: e.target.value, title: null, problem: null })}
                placeholder="[00:00] Host: Welcome to the show…"
                spellCheck={false}
                aria-describedby={`${textId}-count`}
              />
              <p id={`${textId}-count`} className={`paste__count${textTooLong ? ' paste__count--over' : ''}`}>
                {draft.text.length.toLocaleString()} / {maxChars.toLocaleString()} characters
                {textTooLong ? ' · too long' : ''}
                {draft.title === SAMPLE_TITLE ? ' · synthetic sample episode' : ''}
              </p>
            </>
          )}
        </div>
      </div>

      {draft.problem && (
        <p className="intake__problem" role="alert">
          {draft.problem}
        </p>
      )}

      <div className="intake__foot">
        <button
          type="button"
          className="btn btn--text"
          onClick={() => setDraft({ ...emptyDraft, text: SAMPLE_TRANSCRIPT, title: SAMPLE_TITLE })}
        >
          Set the sample episode
        </button>
        <button type="submit" className="btn btn--ink btn--large" disabled={!canSubmit}>
          {!ready && hasInput ? 'Waiting for the server…' : 'Make the edition'}
        </button>
      </div>

      <p className="colophon">
        Timecodes such as [12:34], or SRT/VTT files, give chapters real times; plain text gets chapters without times. Upload only content you have the rights to. Text is processed by
        Google Gemini and Groq, and Gemini’s free tier may use it to improve Google products. Nothing is stored on our server.
      </p>
    </form>
  );
}

/** What the finished edition will contain: the mechanism, shown before the first run. */
export function ContentsPreview() {
  const rows = [
    ['Summary and themes', 'i'],
    ['Key takeaways, each footnoted', '¶ 12'],
    ['Chapters, timed from the source', '14:05'],
    ['Quiz, every answer quoted', '¶ 31'],
    ['The numbered transcript', '¶ 1–'],
  ];
  return (
    <aside className="preview" aria-label="What the edition contains">
      <p className="preview__title">Contents</p>
      <ol className="toc toc--preview">
        {rows.map(([label, page]) => (
          <li key={label} className="toc__row">
            <span className="toc__label">{label}</span>
            <span className="toc__leader" aria-hidden="true" />
            <span className="toc__page">{page}</span>
          </li>
        ))}
      </ol>
      <p className="preview__note">Times come only from the recording, subtitles or timecodes, never guessed. Quiz answers whose quote can’t be found in the episode are removed.</p>
    </aside>
  );
}
