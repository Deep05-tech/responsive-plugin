import { describe, it, expect } from 'vitest';
import { validateCssProposalItem, validateCssProposals } from '../src/patch/css-validator.js';
import { ElementorElement } from '../src/patch/tree.js';

describe('Phase 2 - CSS Proposal Validator', () => {
  const sampleTree: ElementorElement[] = [
    {
      id: 'vispan_hero_text',
      elType: 'widget',
      widgetType: 'text-editor',
      settings: {},
    },
    {
      id: 'el_1',
      elType: 'widget',
      widgetType: 'heading',
      settings: {},
    },
  ];

  it('Accepts valid responsive CSS scoped to an element ID with media query', () => {
    const validProposal = {
      element_id: 'vispan_hero_text',
      css: '@media (max-width: 767px) { .elementor-element-vispan_hero_text p { font-size: 14px !important; } }',
      reason: 'Override inline HTML font-size to 14px on mobile',
    };

    const res = validateCssProposalItem(validProposal, sampleTree, true);
    expect(res.valid).toBe(true);
    expect(res.errors.length).toBe(0);
  });

  it('Enforces media-query-only requirement (rejects CSS without responsive media query)', () => {
    const missingMedia = {
      element_id: 'vispan_hero_text',
      css: '.elementor-element-vispan_hero_text { font-size: 14px; }',
      reason: 'Missing media query',
    };

    const res = validateCssProposalItem(missingMedia, sampleTree);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('responsive media query'))).toBe(true);
  });

  it('Enforces scope-to-existing-ID (rejects CSS targeting non-existent elements)', () => {
    const nonExistentElement = {
      element_id: 'hallucinated_element_999',
      css: '@media (max-width: 767px) { .elementor-element-hallucinated_element_999 { font-size: 14px; } }',
      reason: 'Targeting missing element',
    };

    const res = validateCssProposalItem(nonExistentElement, sampleTree);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('does not exist in the Elementor document tree'))).toBe(true);
  });

  it('Rejects CSS not scoped to target element selector', () => {
    const unscoped = {
      element_id: 'vispan_hero_text',
      css: '@media (max-width: 767px) { body { background: red; } }',
      reason: 'Global body change',
    };

    const res = validateCssProposalItem(unscoped, sampleTree);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('scoped to the element selector'))).toBe(true);
  });

  it('Blocks javascript: and behavior: patterns', () => {
    const jsInjection = {
      element_id: 'vispan_hero_text',
      css: '@media (max-width: 767px) { .elementor-element-vispan_hero_text { background: javascript:alert(1); } }',
      reason: 'JS injection',
    };
    const resJs = validateCssProposalItem(jsInjection, sampleTree);
    expect(resJs.valid).toBe(false);
    expect(resJs.errors.some((e) => e.includes('Security Violation'))).toBe(true);

    const behaviorInjection = {
      element_id: 'vispan_hero_text',
      css: '@media (max-width: 767px) { .elementor-element-vispan_hero_text { behavior: url(script.htc); } }',
      reason: 'HTC behavior injection',
    };
    const resBehavior = validateCssProposalItem(behaviorInjection, sampleTree);
    expect(resBehavior.valid).toBe(false);
    expect(resBehavior.errors.some((e) => e.includes('Security Violation'))).toBe(true);
  });

  it('Blocks @import, url(), and <script> constructs', () => {
    const securityViolations = [
      {
        element_id: 'vispan_hero_text',
        css: '@media (max-width: 767px) { @import "http://evil.com/style.css"; .elementor-element-vispan_hero_text { font-size: 14px; } }',
        reason: 'Malicious import',
      },
      {
        element_id: 'vispan_hero_text',
        css: '@media (max-width: 767px) { .elementor-element-vispan_hero_text { background: url("http://evil.com/track.png"); } }',
        reason: 'Malicious URL fetch',
      },
      {
        element_id: 'vispan_hero_text',
        css: '@media (max-width: 767px) { <script>alert(1)</script> .elementor-element-vispan_hero_text { font-size: 14px; } }',
        reason: 'Script tag injection',
      },
    ];

    for (const item of securityViolations) {
      const res = validateCssProposalItem(item, sampleTree);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('Security Violation'))).toBe(true);
    }
  });

  it('Enforces !important allowlist (allows font-size/padding, rejects unauthorized properties)', () => {
    const allowedImportant = {
      element_id: 'vispan_hero_text',
      css: '@media (max-width: 767px) { .elementor-element-vispan_hero_text p { font-size: 14px !important; padding: 10px !important; } }',
      reason: 'Allowed !important properties',
    };
    const resAllowed = validateCssProposalItem(allowedImportant, sampleTree, true);
    expect(resAllowed.valid).toBe(true);

    const disallowedImportant = {
      element_id: 'vispan_hero_text',
      css: '@media (max-width: 767px) { .elementor-element-vispan_hero_text { cursor: pointer !important; } }',
      reason: 'Disallowed !important property',
    };
    const resDisallowed = validateCssProposalItem(disallowedImportant, sampleTree);
    expect(resDisallowed.valid).toBe(false);
    expect(resDisallowed.errors.some((e) => e.includes('!important Restriction'))).toBe(true);
  });

  it('Validates multiple CSS proposals list', () => {
    const proposals = [
      {
        element_id: 'el_1',
        css: '@media (max-width: 767px) { .elementor-element-el_1 { font-size: 14px; } }',
        reason: 'Fix small font',
      },
      {
        element_id: 'el_non_existent',
        css: 'bad css',
        reason: 'Bad proposal',
      },
    ];

    const result = validateCssProposals(proposals, sampleTree);
    expect(result.valid).toBe(false);
    expect(result.validatedProposals.length).toBe(1);
    expect(result.validatedProposals[0].element_id).toBe('el_1');
  });
});
