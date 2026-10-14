import { useState } from 'react';
import { ArrowLeft, ArrowRight, Check, RotateCcw, X } from 'lucide-react';
import { Cite, FactCheck, Removed } from './Reading.jsx';
import { Errata } from './Errata.jsx';
import { Notices } from './Proof.jsx';
import { eta } from '../lib/format.js';

const LETTERS = ['A', 'B', 'C', 'D'];

function QuizWorking({ step }) {
  const stage = step?.stages.at(-1);
  const left = eta(step?.etaSeconds);
  return (
    <div className="quiz-wait" role="status" aria-live="polite">
      <p className="quiz-wait__title">{stage?.label ?? 'Writing quiz questions'}…</p>
      <div className="rule rule--estimated">
        <div className="rule__fill" style={{ transform: `scaleX(${(step?.percent ?? 5) / 100})` }} />
      </div>
      <p className="quiz-wait__meta">
        {stage?.message ?? 'Every answer is checked against a quote from the episode before it reaches you.'}
        {left ? ` · estimated, ${left}` : ''}
      </p>
      <Notices notices={step?.notices} />
    </div>
  );
}

function Question({ q, index, total, answer, onAnswer, onCheck }) {
  const checked = answer?.checked;
  const correct = checked && answer.selected === q.answerIndex;
  return (
    <fieldset className="question" data-checked={checked ? (correct ? 'right' : 'wrong') : undefined}>
      <legend className="question__legend">
        <span className="question__count">
          Question {index + 1} of {total} · {q.difficulty}
        </span>
        <span className="question__text">{q.question}</span>
      </legend>
      <ol className="options">
        {q.options.map((opt, i) => {
          const state = !checked ? null : i === q.answerIndex ? 'right' : i === answer.selected ? 'wrong' : null;
          return (
            <li key={i}>
              <label className="option" data-state={state ?? undefined}>
                <input
                  type="radio"
                  name={`q-${q.id}`}
                  checked={answer?.selected === i}
                  disabled={checked}
                  onChange={() => onAnswer(i)}
                />
                <span className="option__letter" aria-hidden="true">
                  {LETTERS[i]}
                </span>
                <span className="option__text">{opt}</span>
                {state === 'right' && <Check size={18} strokeWidth={2.5} className="option__icon" aria-label="Correct answer" />}
                {state === 'wrong' && <X size={18} strokeWidth={2.5} className="option__icon" aria-label="Your answer" />}
              </label>
            </li>
          );
        })}
      </ol>
      {!checked ? (
        <button type="button" className="btn btn--ink" disabled={answer?.selected == null} onClick={onCheck}>
          Check answer
        </button>
      ) : (
        <div className="verdict" role="status">
          <p className="verdict__head">{correct ? 'Correct.' : `Not quite. The answer is ${LETTERS[q.answerIndex]}.`}</p>
          <p className="verdict__why">{q.explanation}</p>
          <blockquote className="footnote">
            <p>“{q.quote}”</p>
            <footer>
              {q.segmentIds.map((id) => (
                <Cite key={id} id={id} />
              ))}
            </footer>
          </blockquote>
        </div>
      )}
    </fieldset>
  );
}

function QuizBody({ quiz }) {
  const [answers, setAnswers] = useState({});
  const [index, setIndex] = useState(0);
  const total = quiz.questions.length;
  const done = quiz.questions.every((q) => answers[q.id]?.checked);
  const score = quiz.questions.filter((q) => answers[q.id]?.checked && answers[q.id].selected === q.answerIndex).length;
  const q = quiz.questions[index];

  return (
    <>
      <Question
        key={q.id}
        q={q}
        index={index}
        total={total}
        answer={answers[q.id]}
        onAnswer={(i) => setAnswers((a) => ({ ...a, [q.id]: { selected: i, checked: false } }))}
        onCheck={() => setAnswers((a) => ({ ...a, [q.id]: { ...a[q.id], checked: true } }))}
      />
      <div className="quiz__nav">
        <button type="button" className="btn btn--line" disabled={index === 0} onClick={() => setIndex(index - 1)}>
          <ArrowLeft size={16} strokeWidth={2} aria-hidden="true" /> Previous
        </button>
        <ol className="quiz__dots" aria-label="Questions">
          {quiz.questions.map((qq, i) => {
            const a = answers[qq.id];
            const state = a?.checked ? (a.selected === qq.answerIndex ? 'right' : 'wrong') : 'open';
            return (
              <li key={qq.id}>
                <button
                  type="button"
                  className="quiz__dot"
                  data-state={state}
                  aria-current={i === index ? 'step' : undefined}
                  aria-label={`Question ${i + 1}${state === 'right' ? ', correct' : state === 'wrong' ? ', incorrect' : ''}`}
                  onClick={() => setIndex(i)}
                >
                  {i + 1}
                </button>
              </li>
            );
          })}
        </ol>
        <button type="button" className="btn btn--line" disabled={index === total - 1} onClick={() => setIndex(index + 1)}>
          Next <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
      {done && (
        <div className="score" role="status">
          <p className="score__line">
            You answered {score} of {total} correctly.
          </p>
          <button
            type="button"
            className="btn btn--text"
            onClick={() => {
              setAnswers({});
              setIndex(0);
            }}
          >
            <RotateCcw size={14} strokeWidth={2} aria-hidden="true" /> Take it again
          </button>
        </div>
      )}
    </>
  );
}

export function Quiz({ edition, step, onRetry }) {
  const { quiz, quizStatus, quizError, revised } = edition;
  return (
    <section className="section" aria-labelledby="h-quiz" id="sec-quiz" data-spy="quiz">
      <div className="section__head">
        <h2 id="h-quiz" className="section__title" tabIndex={-1}>
          Quiz
        </h2>
        {revised.quiz && <span className="revised">Revised</span>}
        {quiz && <FactCheck verification={quiz.verification} detail="An independent model answered every question from its cited passage without seeing the answer key; only questions where it reached the same answer are kept." />}
      </div>
      {quizStatus === 'working' && !quiz && <QuizWorking step={step} />}
      {quizStatus === 'failed' && !quiz && <Errata error={quizError} onRetry={onRetry} retryLabel="Set the quiz again" />}
      {quiz && quiz.questions.length === 0 && (
        <p className="aside-note">No question passed the checks against the transcript, so none are shown. Try setting the quiz again.</p>
      )}
      {quiz && quiz.questions.length > 0 && (
        <>
          <QuizBody key={revised.quiz ?? 'first'} quiz={quiz} />
          <Removed items={quiz.dropped} noun="question" />
        </>
      )}
    </section>
  );
}
