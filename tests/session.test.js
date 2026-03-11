/**
 * Tests for buildSession — the flashcard session builder.
 *
 * Requirements:
 *  - Sessions contain at most SESSION_SIZE (20) cards
 *  - Only es→en direction is included for words not yet comfortable
 *  - en→es direction is included only once a word's es→en is comfortable
 *  - Untried words (weight 4) appear more often than comfortable words (weight 1)
 *  - No card appears back-to-back with the same word (different direction of same word is fine)
 *  - All cards in the session belong to the provided list
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createAppContext } from './helpers/create-context.js';

const SESSION_SIZE = 20;

function makeList(wordCount = 25, id = 'test-list') {
  return {
    id,
    pairs: Array.from({ length: wordCount }, (_, i) => ({
      es: `word${i}`,
      en: `translation${i}`,
    })),
  };
}

let ctx;

beforeEach(() => {
  ctx = createAppContext();
  ctx.state.progress = {};
});

describe('buildSession', () => {
  it('returns at most SESSION_SIZE (20) cards', () => {
    const list    = makeList(30);
    const session = ctx.buildSession(list);
    expect(session.length).toBeLessThanOrEqual(SESSION_SIZE);
  });

  it('returns an empty session for an empty list', () => {
    expect(ctx.buildSession({ id: 'empty', pairs: [] })).toHaveLength(0);
  });

  it('only includes es_en direction when no words are comfortable', () => {
    const list    = makeList(5);
    const session = ctx.buildSession(list);
    expect(session.every(c => c.direction === 'es_en')).toBe(true);
  });

  it('does NOT include en_es direction for a word that is not es_en comfortable', () => {
    const list = makeList(2);
    // Answer word0 once (not comfortable yet)
    ctx.recordAnswer('test-list', 'word0', 'es_en', true);

    // Run many sessions — en_es for word0 should never appear
    for (let i = 0; i < 50; i++) {
      const session = ctx.buildSession(list);
      const hasEnEs = session.some(c => c.direction === 'en_es' && c.pair.es === 'word0');
      expect(hasEnEs).toBe(false);
    }
  });

  it('eventually includes en_es once es_en is comfortable', () => {
    const list = makeList(5);
    ctx.recordAnswer('test-list', 'word0', 'es_en', true);
    ctx.recordAnswer('test-list', 'word0', 'es_en', true);
    ctx.recordAnswer('test-list', 'word0', 'es_en', true); // comfortable

    let foundEnEs = false;
    for (let i = 0; i < 100 && !foundEnEs; i++) {
      const session = ctx.buildSession(list);
      foundEnEs = session.some(c => c.direction === 'en_es' && c.pair.es === 'word0');
    }
    expect(foundEnEs).toBe(true);
  });

  it('never places the same word back-to-back', () => {
    const list = makeList(5);
    for (let trial = 0; trial < 30; trial++) {
      const session = ctx.buildSession(list);
      for (let i = 1; i < session.length; i++) {
        expect(session[i].pair.es).not.toBe(session[i - 1].pair.es);
      }
    }
  });

  it('all cards in the session belong to the provided list', () => {
    const list     = makeList(5);
    const validIds = new Set(list.pairs.map(p => p.es));
    const session  = ctx.buildSession(list);
    session.forEach(c => expect(validIds.has(c.pair.es)).toBe(true));
  });

  it('a fully-mastered word appears less often than untried words', () => {
    // Use 30 words — larger than SESSION_SIZE (20) so sessions are selective.
    // word0 is made comfortable in BOTH directions (es_en weight 1 + en_es weight 1 = 2 pool entries).
    // word1-29 are new (es_en weight 4 = 4 pool entries each).
    // When es_en is comfortable, buildSession also adds en_es cards for that word.
    // We must make en_es comfortable too so its weight drops to 1 (otherwise en_es weight 4
    // would add MORE en_es cards than any untried word has es_en cards).
    const list = makeList(30, 'weight-test');

    // Make word0 comfortable in es_en
    for (let i = 0; i < 3; i++) ctx.recordAnswer('weight-test', 'word0', 'es_en', true);
    // Make word0 comfortable in en_es too
    for (let i = 0; i < 3; i++) ctx.recordAnswer('weight-test', 'word0', 'en_es', true);
    // Pool for word0: 1 es_en + 1 en_es = 2 entries (both weight 1)
    // Pool for word1-29: 4 es_en entries each (weight 4, new)

    const counts = {};
    for (let i = 0; i < 30; i++) counts[`word${i}`] = 0;

    for (let trial = 0; trial < 500; trial++) {
      ctx.buildSession(list).forEach(c => counts[c.pair.es]++);
    }

    // word0 (2 pool entries) should appear less often than each untried word (4 entries)
    const avgUntried = Object.entries(counts)
      .filter(([k]) => k !== 'word0')
      .reduce((sum, [, v]) => sum + v, 0) / 29;

    expect(counts.word0).toBeLessThan(avgUntried);
  });
});
