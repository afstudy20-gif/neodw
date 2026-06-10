import { describe, expect, it } from 'vitest';
import deepEqual from './fastDeepEqualShim';

describe('fastDeepEqualShim', () => {
  it('compares primitives and nested objects', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual(1, 2)).toBe(false);
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
  });

  it('compares arrays in order', () => {
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
  });
});