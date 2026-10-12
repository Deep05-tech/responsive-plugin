import { describe, it, expect } from 'vitest';
import { evaluateSimulationVerdict } from '../src/runner/simulation-evaluator.js';

describe('Strict Simulation Verdict Evaluator', () => {
  it('Returns FAILED when baseline P0 is 12 and simulated P0 is 12 (no drop)', () => {
    const result = evaluateSimulationVerdict({
      baseMobileP0: 12,
      simMobileP0: 12,
      baseTabletP0: 8,
      simTabletP0: 8,
      baseDesktopP0: 0,
      simDesktopP0: 0,
      baseMobileScrollWidth: 425,
      simMobileScrollWidth: 425,
      baseTabletScrollWidth: 808,
      simTabletScrollWidth: 808,
      baseIssues: [{ elementId: 'vispan_card', type: 'overflowing_element' }],
      simIssues: [{ elementId: 'vispan_card', type: 'overflowing_element' }],
      desktopDiffPassed: true,
      desktopMismatchRatio: 0.0,
      desktopThreshold: 0.005,
    });

    expect(result.verdict).toBe('FAILED');
    expect(result.passed).toBe(false);
  });

  it('Returns FAILED when baseline P0 is 1 and simulated P0 is 1 (1 -> 1 no drop)', () => {
    const result = evaluateSimulationVerdict({
      baseMobileP0: 1,
      simMobileP0: 1,
      baseTabletP0: 1,
      simTabletP0: 1,
      baseDesktopP0: 0,
      simDesktopP0: 0,
      baseMobileScrollWidth: 375,
      simMobileScrollWidth: 375,
      baseTabletScrollWidth: 768,
      simTabletScrollWidth: 768,
      baseIssues: [{ elementId: 'hdr-nav-menu-widget', type: 'overflowing_element' }],
      simIssues: [{ elementId: 'hdr-nav-menu-widget', type: 'overflowing_element' }],
      desktopDiffPassed: true,
      desktopMismatchRatio: 0.0,
      desktopThreshold: 0.005,
    });

    expect(result.verdict).toBe('FAILED');
    expect(result.passed).toBe(false);
  });

  it('Returns PARTIAL when some P0 drop occurs but does not meet 80% threshold or scrollWidth fails', () => {
    const result = evaluateSimulationVerdict({
      baseMobileP0: 12,
      simMobileP0: 6, // 50% drop (not >= 80%)
      baseTabletP0: 8,
      simTabletP0: 4,
      baseDesktopP0: 0,
      simDesktopP0: 0,
      baseMobileScrollWidth: 425,
      simMobileScrollWidth: 390, // Still > 375
      baseTabletScrollWidth: 808,
      simTabletScrollWidth: 768,
      baseIssues: [{ elementId: 'vispan_card', type: 'overflowing_element' }],
      simIssues: [{ elementId: 'vispan_card', type: 'overflowing_element' }],
      desktopDiffPassed: true,
      desktopMismatchRatio: 0.0,
      desktopThreshold: 0.005,
    });

    expect(result.verdict).toBe('PARTIAL');
    expect(result.passed).toBe(false);
  });

  it('Returns VALIDATED when P0 count drops >= 80% (or 0), scrollWidth <= innerWidth, no new issues, and desktop passes', () => {
    const result = evaluateSimulationVerdict({
      baseMobileP0: 12,
      simMobileP0: 0,
      baseTabletP0: 8,
      simTabletP0: 0,
      baseDesktopP0: 0,
      simDesktopP0: 0,
      baseMobileScrollWidth: 425,
      simMobileScrollWidth: 375,
      baseTabletScrollWidth: 808,
      simTabletScrollWidth: 768,
      baseIssues: [{ elementId: 'vispan_card', type: 'overflowing_element' }],
      simIssues: [],
      desktopDiffPassed: true,
      desktopMismatchRatio: 0.0001,
      desktopThreshold: 0.005,
    });

    expect(result.verdict).toBe('VALIDATED');
    expect(result.passed).toBe(true);
  });
});
