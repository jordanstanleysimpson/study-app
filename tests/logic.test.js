import { describe, it, expect, beforeEach } from 'vitest';
import { createAppContext } from './helpers/create-context.js';

let ctx;

beforeEach(() => {
  ctx = createAppContext();
});

// ─── normalize ────────────────────────────────────────────────────────────

describe('normalize', () => {
  it('lowercases input', () => {
    expect(ctx.normalize('HELLO')).toBe('hello');
  });

  it('strips diacritics: é → e', () => {
    expect(ctx.normalize('café')).toBe('cafe');
  });

  it('strips common Spanish accents: á é í ó ú → a e i o u', () => {
    expect(ctx.normalize('Á')).toBe('a');
    expect(ctx.normalize('É')).toBe('e');
    expect(ctx.normalize('Í')).toBe('i');
    expect(ctx.normalize('Ó')).toBe('o');
    expect(ctx.normalize('Ú')).toBe('u');
  });

  it('strips ñ → n', () => {
    expect(ctx.normalize('Año')).toBe('ano');
    expect(ctx.normalize('mañana')).toBe('manana');
  });

  it('strips ü → u', () => {
    expect(ctx.normalize('güero')).toBe('guero');
  });

  it('trims leading and trailing whitespace', () => {
    expect(ctx.normalize('  hello  ')).toBe('hello');
  });

  it('handles empty string', () => {
    expect(ctx.normalize('')).toBe('');
  });

  it('is idempotent — normalizing twice gives the same result', () => {
    const once  = ctx.normalize('Está');
    const twice = ctx.normalize(once);
    expect(once).toBe(twice);
  });
});

// ─── shuffle ──────────────────────────────────────────────────────────────

describe('shuffle', () => {
  it('returns an array of the same length', () => {
    const arr = [1, 2, 3, 4, 5];
    expect(ctx.shuffle(arr)).toHaveLength(arr.length);
  });

  it('contains exactly the original elements (no loss or duplication)', () => {
    const arr = [1, 2, 3, 4, 5];
    expect([...ctx.shuffle(arr)].sort((a, b) => a - b)).toEqual([...arr].sort((a, b) => a - b));
  });

  it('does not mutate the original array', () => {
    const arr = [1, 2, 3, 4, 5];
    ctx.shuffle(arr);
    expect(arr).toEqual([1, 2, 3, 4, 5]);
  });

  it('produces different orderings across multiple calls (statistical)', () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const results = new Set();
    for (let i = 0; i < 30; i++) {
      results.add(JSON.stringify(ctx.shuffle(arr)));
    }
    // Getting the same 10-element order 30 times in a row is astronomically unlikely
    expect(results.size).toBeGreaterThan(1);
  });

  it('handles an empty array', () => {
    expect(ctx.shuffle([])).toEqual([]);
  });

  it('handles a single-element array', () => {
    expect(ctx.shuffle(['only'])).toEqual(['only']);
  });
});
