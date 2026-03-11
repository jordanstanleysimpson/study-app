/**
 * Tests for flashcard word-level progress tracking.
 *
 * Requirements:
 *  - Correct answers increment the correct count and streak
 *  - Wrong answers increment the incorrect count and reset the streak to 0
 *  - After COMFORT_STREAK (3) consecutive correct answers the word is "comfortable"
 *  - Comfort is sticky — a wrong answer doesn't remove it
 *  - Undo decrements the count that was incremented, floor 0
 *  - Weight 4 = new, 3 = seen but not comfortable, 1 = comfortable
 *  - en→es direction is unlocked only once es→en is comfortable
 *  - computeListProgress for quiz type counts questions ≥80% accuracy as mastered
 *  - computeListProgress for non-quiz type counts comfortable words
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createAppContext } from './helpers/create-context.js';

const LIST = 'my-list';
const WORD = 'hablar';

let ctx;

beforeEach(() => {
  ctx = createAppContext();
  ctx.state.progress = {};
});

// ─── recordAnswer ─────────────────────────────────────────────────────────

describe('recordAnswer', () => {
  it('increments correct count on a correct answer', () => {
    ctx.recordAnswer(LIST, WORD, 'es_en', true);
    expect(ctx.state.progress[LIST][WORD].es_en.correct).toBe(1);
  });

  it('increments incorrect count on a wrong answer', () => {
    ctx.recordAnswer(LIST, WORD, 'es_en', false);
    expect(ctx.state.progress[LIST][WORD].es_en.incorrect).toBe(1);
  });

  it('increments streak on consecutive correct answers', () => {
    ctx.recordAnswer(LIST, WORD, 'es_en', true);
    ctx.recordAnswer(LIST, WORD, 'es_en', true);
    expect(ctx.state.progress[LIST][WORD].es_en.streak).toBe(2);
  });

  it('resets streak to 0 on a wrong answer', () => {
    ctx.recordAnswer(LIST, WORD, 'es_en', true);
    ctx.recordAnswer(LIST, WORD, 'es_en', true);
    ctx.recordAnswer(LIST, WORD, 'es_en', false);
    expect(ctx.state.progress[LIST][WORD].es_en.streak).toBe(0);
  });

  it('does not set comfortable before COMFORT_STREAK (3) consecutive correct', () => {
    ctx.recordAnswer(LIST, WORD, 'es_en', true);
    ctx.recordAnswer(LIST, WORD, 'es_en', true);
    expect(ctx.state.progress[LIST][WORD].es_en.comfortable).toBe(false);
  });

  it('marks word as comfortable after exactly COMFORT_STREAK consecutive correct', () => {
    ctx.recordAnswer(LIST, WORD, 'es_en', true);
    ctx.recordAnswer(LIST, WORD, 'es_en', true);
    ctx.recordAnswer(LIST, WORD, 'es_en', true);
    expect(ctx.state.progress[LIST][WORD].es_en.comfortable).toBe(true);
  });

  it('comfort is sticky — remains true even after a wrong answer', () => {
    ctx.recordAnswer(LIST, WORD, 'es_en', true);
    ctx.recordAnswer(LIST, WORD, 'es_en', true);
    ctx.recordAnswer(LIST, WORD, 'es_en', true); // comfortable = true
    ctx.recordAnswer(LIST, WORD, 'es_en', false); // wrong — streak resets, comfortable stays
    expect(ctx.state.progress[LIST][WORD].es_en.comfortable).toBe(true);
  });

  it('initialises both es_en and en_es directions on first access', () => {
    ctx.recordAnswer(LIST, WORD, 'es_en', true);
    const rec = ctx.state.progress[LIST][WORD];
    expect(rec.es_en).toBeDefined();
    expect(rec.en_es).toBeDefined();
    expect(rec.en_es.correct).toBe(0);
    expect(rec.en_es.comfortable).toBe(false);
  });

  it('tracks different words independently', () => {
    ctx.recordAnswer(LIST, 'hablar', 'es_en', true);
    ctx.recordAnswer(LIST, 'comer',  'es_en', false);
    expect(ctx.state.progress[LIST]['hablar'].es_en.correct).toBe(1);
    expect(ctx.state.progress[LIST]['comer'].es_en.incorrect).toBe(1);
  });
});

// ─── undoRecordAnswer ─────────────────────────────────────────────────────

describe('undoRecordAnswer', () => {
  it('decrements correct count', () => {
    ctx.recordAnswer(LIST, WORD, 'es_en', true);
    ctx.undoRecordAnswer(LIST, WORD, 'es_en', true);
    expect(ctx.state.progress[LIST][WORD].es_en.correct).toBe(0);
  });

  it('decrements incorrect count', () => {
    ctx.recordAnswer(LIST, WORD, 'es_en', false);
    ctx.undoRecordAnswer(LIST, WORD, 'es_en', false);
    expect(ctx.state.progress[LIST][WORD].es_en.incorrect).toBe(0);
  });

  it('does not decrement correct below 0', () => {
    ctx.undoRecordAnswer(LIST, WORD, 'es_en', true);
    expect(ctx.state.progress[LIST][WORD].es_en.correct).toBe(0);
  });

  it('does not decrement incorrect below 0', () => {
    ctx.undoRecordAnswer(LIST, WORD, 'es_en', false);
    expect(ctx.state.progress[LIST][WORD].es_en.incorrect).toBe(0);
  });

  it('decrements streak on undo of a correct answer', () => {
    ctx.recordAnswer(LIST, WORD, 'es_en', true);
    ctx.recordAnswer(LIST, WORD, 'es_en', true);
    ctx.undoRecordAnswer(LIST, WORD, 'es_en', true);
    expect(ctx.state.progress[LIST][WORD].es_en.streak).toBe(1);
  });

  it('does not decrement streak below 0', () => {
    ctx.undoRecordAnswer(LIST, WORD, 'es_en', true); // nothing recorded yet
    expect(ctx.state.progress[LIST][WORD].es_en.streak).toBe(0);
  });
});

// ─── getWeight (flashcard word weight) ────────────────────────────────────

describe('getWeight', () => {
  it('returns 4 for a word never answered (new)', () => {
    expect(ctx.getWeight(LIST, WORD, 'es_en')).toBe(4);
  });

  it('returns 3 for a word seen but not yet comfortable', () => {
    ctx.recordAnswer(LIST, WORD, 'es_en', true); // seen once, not comfortable yet
    expect(ctx.getWeight(LIST, WORD, 'es_en')).toBe(3);
  });

  it('returns 1 for a comfortable word', () => {
    ctx.recordAnswer(LIST, WORD, 'es_en', true);
    ctx.recordAnswer(LIST, WORD, 'es_en', true);
    ctx.recordAnswer(LIST, WORD, 'es_en', true);
    expect(ctx.getWeight(LIST, WORD, 'es_en')).toBe(1);
  });

  it('returns 3 even after a wrong answer disrupts the streak (not comfortable)', () => {
    ctx.recordAnswer(LIST, WORD, 'es_en', true);
    ctx.recordAnswer(LIST, WORD, 'es_en', false); // streak reset, still seen
    expect(ctx.getWeight(LIST, WORD, 'es_en')).toBe(3);
  });
});

// ─── isEsEnComfortable ────────────────────────────────────────────────────

describe('isEsEnComfortable', () => {
  it('returns false for a new word', () => {
    expect(ctx.isEsEnComfortable(LIST, WORD)).toBe(false);
  });

  it('returns false after fewer than COMFORT_STREAK correct answers', () => {
    ctx.recordAnswer(LIST, WORD, 'es_en', true);
    ctx.recordAnswer(LIST, WORD, 'es_en', true);
    expect(ctx.isEsEnComfortable(LIST, WORD)).toBe(false);
  });

  it('returns true after COMFORT_STREAK (3) consecutive correct answers', () => {
    ctx.recordAnswer(LIST, WORD, 'es_en', true);
    ctx.recordAnswer(LIST, WORD, 'es_en', true);
    ctx.recordAnswer(LIST, WORD, 'es_en', true);
    expect(ctx.isEsEnComfortable(LIST, WORD)).toBe(true);
  });

  it('only tracks es_en comfort (en_es has its own)', () => {
    ctx.recordAnswer(LIST, WORD, 'en_es', true);
    ctx.recordAnswer(LIST, WORD, 'en_es', true);
    ctx.recordAnswer(LIST, WORD, 'en_es', true);
    // isEsEnComfortable checks es_en, not en_es
    expect(ctx.isEsEnComfortable(LIST, WORD)).toBe(false);
  });
});

// ─── computeListProgress ─────────────────────────────────────────────────

describe('computeListProgress', () => {
  it('returns 0 when wordCount is 0', () => {
    expect(ctx.computeListProgress(LIST, 0, 'quiz')).toBe(0);
  });

  it('returns 0 when no progress has been recorded', () => {
    expect(ctx.computeListProgress(LIST, 10, 'quiz')).toBe(0);
    expect(ctx.computeListProgress(LIST, 10, 'pairs')).toBe(0);
  });

  describe('quiz type — mastered = ≥80% accuracy', () => {
    it('counts questions with ≥80% accuracy as mastered', () => {
      ctx.state.progress[LIST] = {
        q1: { correct: 4, incorrect: 1 },  // 80% → mastered
        q2: { correct: 3, incorrect: 2 },  // 60% → not mastered
        q3: { correct: 0, incorrect: 0 },  // 0 answers → not mastered
        q4: { correct: 9, incorrect: 1 },  // 90% → mastered
      };
      // 2 mastered out of wordCount=4 → 50%
      expect(ctx.computeListProgress(LIST, 4, 'quiz')).toBe(50);
    });

    it('returns 100 when every question is mastered', () => {
      ctx.state.progress[LIST] = {
        q1: { correct: 5, incorrect: 0 },
        q2: { correct: 5, incorrect: 0 },
      };
      expect(ctx.computeListProgress(LIST, 2, 'quiz')).toBe(100);
    });

    it('does not count questions with 0 answers as mastered', () => {
      ctx.state.progress[LIST] = {
        q1: { correct: 0, incorrect: 0 }, // never attempted
        q2: { correct: 4, incorrect: 0 }, // mastered
      };
      expect(ctx.computeListProgress(LIST, 2, 'quiz')).toBe(50);
    });

    it('correctly handles exactly the 80% boundary', () => {
      ctx.state.progress[LIST] = {
        q1: { correct: 8, incorrect: 2 }, // exactly 80% → mastered
        q2: { correct: 7, incorrect: 3 }, // 70% → not mastered
      };
      expect(ctx.computeListProgress(LIST, 2, 'quiz')).toBe(50);
    });
  });

  describe('non-quiz type — comfort-based', () => {
    it('counts comfortable words toward progress', () => {
      // Make 'hablar' comfortable, leave 'comer' as not comfortable
      ctx.recordAnswer(LIST, 'hablar', 'es_en', true);
      ctx.recordAnswer(LIST, 'hablar', 'es_en', true);
      ctx.recordAnswer(LIST, 'hablar', 'es_en', true);
      ctx.recordAnswer(LIST, 'comer',  'es_en', true);
      expect(ctx.computeListProgress(LIST, 2, 'pairs')).toBe(50);
    });

    it('returns 100 when all words are comfortable', () => {
      const words = ['hablar', 'comer', 'vivir'];
      words.forEach(w => {
        ctx.recordAnswer(LIST, w, 'es_en', true);
        ctx.recordAnswer(LIST, w, 'es_en', true);
        ctx.recordAnswer(LIST, w, 'es_en', true);
      });
      expect(ctx.computeListProgress(LIST, 3, 'pairs')).toBe(100);
    });
  });
});
