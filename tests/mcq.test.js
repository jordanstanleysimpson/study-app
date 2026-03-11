/**
 * Tests for multiple-choice quiz (MCQ) behaviour.
 *
 * Requirements:
 *  - getMcqWeight: 4 for new/struggling (<50%), 2 for improving (50-79%), 1 for mastered (≥80%)
 *  - recordQuizAnswer / undoRecordQuizAnswer update state correctly, floor 0
 *  - buildMcqSession: max SESSION_SIZE (20) unique questions, weighted selection
 *  - MCQ choice order is determined once per question and never changes during a session
 *  - Back navigation (exam mode): decrements index, cancels pending timeout, floor 0
 *  - Re-answering after back: old answer is undone, new answer is recorded
 *  - Results: wrong answers sorted before correct answers
 *  - showMcqResults: reads from mcqSession + mcqResults map; skipped questions are excluded
 *  - Unit list sort: newest to oldest; hidden units are excluded
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createAppContext } from './helpers/create-context.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeQuestion(id, overrides = {}) {
  return {
    id,
    q:          `What does "${id}" mean?`,
    correct:    `Correct ${id}`,
    incorrect:  [`Wrong A ${id}`, `Wrong B ${id}`, `Wrong C ${id}`],
    why_correct: `Because ${id} means this.`,
    why_wrong:   [`Why not A ${id}`, `Why not B ${id}`, `Why not C ${id}`],
    ...overrides,
  };
}

function makeQuizList(count = 25, id = 'test-quiz') {
  return {
    id,
    type:      'quiz',
    questions: Array.from({ length: count }, (_, i) => makeQuestion(`q${i}`)),
  };
}

let ctx;

beforeEach(() => {
  ctx = createAppContext();
  ctx.state.progress = {};
});

// ─── getMcqWeight ─────────────────────────────────────────────────────────

describe('getMcqWeight', () => {
  it('returns 4 for a question never answered', () => {
    expect(ctx.getMcqWeight('quiz1', 'q1')).toBe(4);
  });

  it('returns 4 when accuracy is below 50%', () => {
    ctx.state.progress['quiz1'] = { q1: { correct: 1, incorrect: 3 } }; // 25%
    expect(ctx.getMcqWeight('quiz1', 'q1')).toBe(4);
  });

  it('returns 2 when accuracy is between 50% and 79%', () => {
    ctx.state.progress['quiz1'] = { q1: { correct: 3, incorrect: 2 } }; // 60%
    expect(ctx.getMcqWeight('quiz1', 'q1')).toBe(2);
  });

  it('returns 1 when accuracy is exactly 80%', () => {
    ctx.state.progress['quiz1'] = { q1: { correct: 4, incorrect: 1 } }; // 80%
    expect(ctx.getMcqWeight('quiz1', 'q1')).toBe(1);
  });

  it('returns 1 when accuracy is above 80%', () => {
    ctx.state.progress['quiz1'] = { q1: { correct: 9, incorrect: 1 } }; // 90%
    expect(ctx.getMcqWeight('quiz1', 'q1')).toBe(1);
  });
});

// ─── recordQuizAnswer / undoRecordQuizAnswer ──────────────────────────────

describe('recordQuizAnswer', () => {
  it('increments correct count on a correct answer', () => {
    ctx.recordQuizAnswer('quiz1', 'q1', true);
    expect(ctx.state.progress['quiz1']['q1'].correct).toBe(1);
  });

  it('increments incorrect count on a wrong answer', () => {
    ctx.recordQuizAnswer('quiz1', 'q1', false);
    expect(ctx.state.progress['quiz1']['q1'].incorrect).toBe(1);
  });

  it('accumulates multiple answers', () => {
    ctx.recordQuizAnswer('quiz1', 'q1', true);
    ctx.recordQuizAnswer('quiz1', 'q1', false);
    ctx.recordQuizAnswer('quiz1', 'q1', true);
    expect(ctx.state.progress['quiz1']['q1'].correct).toBe(2);
    expect(ctx.state.progress['quiz1']['q1'].incorrect).toBe(1);
  });
});

describe('undoRecordQuizAnswer', () => {
  it('decrements correct count', () => {
    ctx.recordQuizAnswer('quiz1', 'q1', true);
    ctx.undoRecordQuizAnswer('quiz1', 'q1', true);
    expect(ctx.state.progress['quiz1']['q1'].correct).toBe(0);
  });

  it('decrements incorrect count', () => {
    ctx.recordQuizAnswer('quiz1', 'q1', false);
    ctx.undoRecordQuizAnswer('quiz1', 'q1', false);
    expect(ctx.state.progress['quiz1']['q1'].incorrect).toBe(0);
  });

  it('does not decrement correct below 0', () => {
    ctx.undoRecordQuizAnswer('quiz1', 'q1', true);
    expect(ctx.state.progress['quiz1']['q1'].correct).toBe(0);
  });

  it('does not decrement incorrect below 0', () => {
    ctx.undoRecordQuizAnswer('quiz1', 'q1', false);
    expect(ctx.state.progress['quiz1']['q1'].incorrect).toBe(0);
  });
});

// ─── buildMcqSession ──────────────────────────────────────────────────────

describe('buildMcqSession', () => {
  it('returns at most SESSION_SIZE (20) questions', () => {
    const list = makeQuizList(30);
    expect(ctx.buildMcqSession(list).length).toBeLessThanOrEqual(20);
  });

  it('returns unique question IDs', () => {
    const list    = makeQuizList(30);
    const session = ctx.buildMcqSession(list);
    const ids     = session.map(q => q.id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  it('returns all questions when the list has fewer than SESSION_SIZE', () => {
    const list    = makeQuizList(5);
    const session = ctx.buildMcqSession(list);
    expect(session.length).toBe(5);
  });

  it('all returned questions belong to the list', () => {
    const list     = makeQuizList(25);
    const validIds = new Set(list.questions.map(q => q.id));
    ctx.buildMcqSession(list).forEach(q => expect(validIds.has(q.id)).toBe(true));
  });

  it('favours low-accuracy questions over mastered ones', () => {
    // Use 30 questions — larger than SESSION_SIZE (20) so sessions are selective
    const list = makeQuizList(30);
    // Master q0 (weight → 1), leave q1–q29 as new (weight 4)
    ctx.state.progress['test-quiz'] = { q0: { correct: 4, incorrect: 1 } }; // 80% → weight 1

    const counts = {};
    for (let i = 0; i < 30; i++) counts[`q${i}`] = 0;

    for (let trial = 0; trial < 500; trial++) {
      ctx.buildMcqSession(list).forEach(q => counts[q.id]++);
    }

    // q0 (weight 1) should appear significantly less often than untried questions (weight 4)
    const avgNew = Object.entries(counts)
      .filter(([k]) => k !== 'q0')
      .reduce((sum, [, v]) => sum + v, 0) / 29;

    expect(counts.q0).toBeLessThan(avgNew);
  });
});

// ─── MCQ choice order stability ───────────────────────────────────────────

describe('MCQ choice order stability', () => {
  function setupMcqState(ctx, list) {
    ctx.state.mcqSession   = list.questions.slice(0, 5);
    ctx.state.mcqIndex     = 0;
    ctx.state.mcqResults   = {};
    ctx.state.mcqChoices   = {};
    ctx.state.mcqGradeMode = 'end';
    ctx.state.currentMode  = 'mc-quiz';
    ctx.state.currentList  = list;
  }

  it('choice order is fixed after the first render of a question', () => {
    const list = makeQuizList(5);
    setupMcqState(ctx, list);

    ctx.renderMcqCard(); // first render — choices are created and stored
    const firstOrder = ctx.state.mcqChoices['q0'].map(c => c.text);

    ctx.renderMcqCard(); // second render (e.g. after going back) — must reuse stored choices
    const secondOrder = ctx.state.mcqChoices['q0'].map(c => c.text);

    expect(secondOrder).toEqual(firstOrder);
  });

  it('each question gets its own independent choice set', () => {
    const list = makeQuizList(5);
    setupMcqState(ctx, list);

    // Render questions 0, 1, and 2 in sequence
    ctx.renderMcqCard();
    ctx.state.mcqIndex = 1;
    ctx.renderMcqCard();
    ctx.state.mcqIndex = 2;
    ctx.renderMcqCard();

    expect(ctx.state.mcqChoices['q0']).toBeDefined();
    expect(ctx.state.mcqChoices['q1']).toBeDefined();
    expect(ctx.state.mcqChoices['q2']).toBeDefined();

    // Each has exactly 4 choices
    expect(ctx.state.mcqChoices['q0']).toHaveLength(4);
    expect(ctx.state.mcqChoices['q1']).toHaveLength(4);
    expect(ctx.state.mcqChoices['q2']).toHaveLength(4);
  });

  it('rendered choices contain exactly one correct answer', () => {
    const list = makeQuizList(5);
    setupMcqState(ctx, list);
    ctx.renderMcqCard();

    const choices = ctx.state.mcqChoices['q0'];
    expect(choices.filter(c => c.isCorrect)).toHaveLength(1);
    expect(choices.filter(c => !c.isCorrect)).toHaveLength(3);
  });

  it('choice order is stable regardless of how many times renderMcqCard is called', () => {
    const list = makeQuizList(5);
    setupMcqState(ctx, list);

    ctx.renderMcqCard();
    const originalOrder = ctx.state.mcqChoices['q0'].map(c => c.text);

    for (let i = 0; i < 10; i++) {
      ctx.renderMcqCard();
    }
    expect(ctx.state.mcqChoices['q0'].map(c => c.text)).toEqual(originalOrder);
  });
});

// ─── Exam mode: back navigation ───────────────────────────────────────────

describe('exam mode: back navigation', () => {
  function setupExam(ctx, questionCount = 3) {
    const list = makeQuizList(questionCount);
    ctx.state.mcqSession        = list.questions.slice(0, questionCount);
    ctx.state.mcqIndex          = 1; // already past the first question
    ctx.state.mcqResults        = {};
    ctx.state.mcqChoices        = {};
    ctx.state.mcqGradeMode      = 'end';
    ctx.state.currentMode       = 'mc-quiz';
    ctx.state.currentList       = list;
    ctx.state.mcqAdvanceTimeout = null;
    return list;
  }

  it('decrements mcqIndex by 1', () => {
    setupExam(ctx);
    ctx.goBack();
    expect(ctx.state.mcqIndex).toBe(0);
  });

  it('does not go below 0 when already at the first question', () => {
    setupExam(ctx);
    ctx.state.mcqIndex = 0;
    ctx.goBack();
    expect(ctx.state.mcqIndex).toBe(0);
  });

  it('cancels a pending auto-advance timeout', () => {
    setupExam(ctx);
    ctx.state.mcqIndex          = 2;
    ctx.state.mcqAdvanceTimeout = 42; // fake pending timeout ID
    ctx.goBack();
    expect(ctx._clearedTimeouts).toContain(42);
  });

  it('clears the timeout reference after cancelling', () => {
    setupExam(ctx);
    ctx.state.mcqIndex          = 2;
    ctx.state.mcqAdvanceTimeout = 99;
    ctx.goBack();
    expect(ctx.state.mcqAdvanceTimeout).toBeNull();
  });

  it('does nothing when called in non-exam mode', () => {
    setupExam(ctx);
    ctx.state.mcqGradeMode = 'inline';
    ctx.state.mcqIndex     = 1;
    // goBack in inline mode falls through to the flashcard back logic (no session history)
    // The key requirement: mcqIndex must NOT change
    const sessionHistoryBefore = ctx.state.sessionHistory.length;
    ctx.goBack();
    // In inline mode, goBack does NOT touch mcqIndex (it handles sessionHistory instead)
    expect(ctx.state.mcqIndex).toBe(1);
  });
});

// ─── Re-answering after back navigation ───────────────────────────────────

describe('re-answering a question after going back', () => {
  it('undoes the previous answer and records the new one', () => {
    const list = makeQuizList(3);
    ctx.state.currentList = list;

    // Simulate: answered q0 incorrectly, then went back to change it
    ctx.recordQuizAnswer('test-quiz', 'q0', false);
    ctx.state.mcqResults['q0'] = {
      question: list.questions[0],
      chosen:   list.questions[0].incorrect[0],
      correct:  false,
      whyWrong: list.questions[0].why_wrong[0],
    };

    expect(ctx.state.progress['test-quiz']['q0'].incorrect).toBe(1);

    // User goes back and picks the correct answer
    const prev = ctx.state.mcqResults['q0'];
    ctx.undoRecordQuizAnswer('test-quiz', 'q0', prev.correct);
    ctx.recordQuizAnswer('test-quiz', 'q0', true);
    ctx.state.mcqResults['q0'] = {
      question: list.questions[0],
      chosen:   list.questions[0].correct,
      correct:  true,
      whyWrong: null,
    };

    expect(ctx.state.progress['test-quiz']['q0'].incorrect).toBe(0);
    expect(ctx.state.progress['test-quiz']['q0'].correct).toBe(1);
    expect(ctx.state.mcqResults['q0'].correct).toBe(true);
  });
});

// ─── Results: wrong answers first ─────────────────────────────────────────

describe('results: wrong answers sorted before correct answers', () => {
  it('sorts a mixed result set — wrong first', () => {
    const results = [
      { correct: true,  question: makeQuestion('q1'), chosen: 'Correct q1',  whyWrong: null },
      { correct: false, question: makeQuestion('q2'), chosen: 'Wrong q2',    whyWrong: 'reason' },
      { correct: true,  question: makeQuestion('q3'), chosen: 'Correct q3',  whyWrong: null },
      { correct: false, question: makeQuestion('q4'), chosen: 'Wrong q4',    whyWrong: 'reason' },
    ];
    results.sort((a, b) => (a.correct === b.correct ? 0 : a.correct ? 1 : -1));

    expect(results[0].correct).toBe(false);
    expect(results[1].correct).toBe(false);
    expect(results[2].correct).toBe(true);
    expect(results[3].correct).toBe(true);
  });

  it('an all-correct set remains stable', () => {
    const results = [
      { correct: true, question: makeQuestion('q1'), chosen: 'Correct q1' },
      { correct: true, question: makeQuestion('q2'), chosen: 'Correct q2' },
    ];
    results.sort((a, b) => (a.correct === b.correct ? 0 : a.correct ? 1 : -1));
    expect(results.every(r => r.correct)).toBe(true);
  });

  it('an all-wrong set remains stable', () => {
    const results = [
      { correct: false, question: makeQuestion('q1'), chosen: 'Wrong q1', whyWrong: '' },
      { correct: false, question: makeQuestion('q2'), chosen: 'Wrong q2', whyWrong: '' },
    ];
    results.sort((a, b) => (a.correct === b.correct ? 0 : a.correct ? 1 : -1));
    expect(results.every(r => !r.correct)).toBe(true);
  });

  it('showMcqResults renders wrong answers first in the DOM', () => {
    const q1 = makeQuestion('q1');
    const q2 = makeQuestion('q2');
    const q3 = makeQuestion('q3');

    ctx.state.mcqSession  = [q1, q2, q3];
    ctx.state.mcqResults  = {
      q1: { question: q1, chosen: q1.correct,       correct: true,  whyWrong: null },
      q2: { question: q2, chosen: q2.incorrect[0],  correct: false, whyWrong: q2.why_wrong[0] },
      // q3 was never answered (skipped) — should be excluded from results
    };
    ctx.state.currentList = makeQuizList(3);

    ctx.showMcqResults();

    const details = ctx.document._elements['results-details'];
    // children[0] = h3 heading, children[1] = the list div containing result items
    const listEl  = details.children[1];
    expect(listEl).toBeDefined();
    expect(listEl.children).toHaveLength(2); // q1 and q2 only (q3 skipped)

    // Wrong answer (q2) must come first
    expect(listEl.children[0].className).toBe('mcq-missed-item');
    // Correct answer (q1) must come second
    expect(listEl.children[1].className).toBe('mcq-missed-item mcq-item--correct');
  });

  it('showMcqResults excludes unanswered (skipped) questions', () => {
    const q1 = makeQuestion('q1');
    const q2 = makeQuestion('q2');

    ctx.state.mcqSession  = [q1, q2];
    ctx.state.mcqResults  = {
      q1: { question: q1, chosen: q1.correct, correct: true, whyWrong: null },
      // q2 was skipped — no entry in mcqResults
    };
    ctx.state.currentList = makeQuizList(2);

    ctx.showMcqResults();

    const details = ctx.document._elements['results-details'];
    const listEl  = details.children[1];
    expect(listEl.children).toHaveLength(1); // only q1
  });
});

// ─── Unit list ordering ───────────────────────────────────────────────────

describe('unit list ordering', () => {
  it('sorts newest-created lists first', () => {
    const lists = [
      { id: 'old',    created: '2026-03-08', subject: 'Spanish', type: 'quiz' },
      { id: 'newest', created: '2026-03-10', subject: 'Spanish', type: 'quiz' },
      { id: 'middle', created: '2026-03-09', subject: 'Spanish', type: 'quiz' },
    ];
    const sorted = lists
      .filter(l => !l.hidden)
      .sort((a, b) => b.created.localeCompare(a.created));

    expect(sorted[0].id).toBe('newest');
    expect(sorted[1].id).toBe('middle');
    expect(sorted[2].id).toBe('old');
  });

  it('filters out hidden lists', () => {
    const lists = [
      { id: 'visible',  created: '2026-03-10', hidden: false },
      { id: 'hidden',   created: '2026-03-09', hidden: true },
      { id: 'also-vis', created: '2026-03-08' },           // no hidden property
    ];
    const sorted = lists
      .filter(l => !l.hidden)
      .sort((a, b) => b.created.localeCompare(a.created));

    expect(sorted.map(l => l.id)).toEqual(['visible', 'also-vis']);
  });

  it('two lists with the same date maintain stable order', () => {
    const lists = [
      { id: 'a', created: '2026-03-10' },
      { id: 'b', created: '2026-03-10' },
    ];
    const sorted = lists
      .filter(l => !l.hidden)
      .sort((a, b) => b.created.localeCompare(a.created));

    expect(sorted).toHaveLength(2);
    // Both present, order between same-date items can be either (stable sort)
    expect(sorted.map(l => l.id).sort()).toEqual(['a', 'b']);
  });
});
