import { describe, it, expect } from 'vitest';
import { classifyCACDRS } from './cacScoring';

describe('classifyCACDRS', () => {
  it('classifies a zero score as "zero"', () => {
    expect(classifyCACDRS(0)).toBe('zero');
  });

  it('treats negative scores as "zero" (defensive)', () => {
    expect(classifyCACDRS(-5)).toBe('zero');
  });

  it('classifies 1–99 as "mild"', () => {
    expect(classifyCACDRS(1)).toBe('mild');
    expect(classifyCACDRS(99)).toBe('mild');
  });

  it('classifies 100–399 as "moderate"', () => {
    expect(classifyCACDRS(100)).toBe('moderate');
    expect(classifyCACDRS(399)).toBe('moderate');
  });

  it('classifies ≥400 as "severe"', () => {
    expect(classifyCACDRS(400)).toBe('severe');
    expect(classifyCACDRS(2500)).toBe('severe');
  });

  it('places category boundaries exactly at 100 and 400', () => {
    // 99 → mild, 100 → moderate (lower bound inclusive of moderate)
    expect(classifyCACDRS(99)).toBe('mild');
    expect(classifyCACDRS(100)).toBe('moderate');
    // 399 → moderate, 400 → severe
    expect(classifyCACDRS(399)).toBe('moderate');
    expect(classifyCACDRS(400)).toBe('severe');
  });
});
