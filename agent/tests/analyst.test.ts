import { describe, it, expect } from 'vitest';
import { LayoutAnalyst } from '../src/llm/analyst.js';
import { AuditReport } from '../src/audit/types.js';
import { ElementorElement } from '../src/patch/tree.js';
import { validatePatches } from '../src/patch/validator.js';

import { loadConfig } from '../src/config/index.js';

describe('Phase 2 - Layout Analyst & Structured Output Validation', () => {
  const analyst = new LayoutAnalyst({ ...loadConfig(), offline: true });

  const fixtureTree: ElementorElement[] = [
    {
      id: 'sec-fixed-promo',
      elType: 'container',
      settings: { width: { unit: 'px', size: 750 } },
      elements: [
        {
          id: 'w-fixed-promo-card',
          elType: 'widget',
          widgetType: 'text-editor',
          settings: {},
        },
      ],
    },
    {
      id: 'w-tiny-cta-btn',
      elType: 'widget',
      widgetType: 'button',
      settings: {},
    },
  ];

  const mockAuditReport: AuditReport = {
    pageId: 'test-page',
    pageUrl: 'http://localhost:8000/test',
    timestamp: new Date().toISOString(),
    viewports: {
      mobile: {
        viewport: 'mobile',
        width: 375,
        height: 812,
        screenshotPath: '',
        hasHorizontalOverflow: true,
        scrollWidth: 750,
        innerWidth: 375,
        issues: [
          {
            type: 'overflowing_element',
            elementId: 'sec-fixed-promo',
            selector: '#sec-fixed-promo',
            viewport: 'mobile',
            message: 'Element overflows right edge by 375px',
            details: {},
          },
          {
            type: 'small_tap_target',
            elementId: 'w-tiny-cta-btn',
            selector: 'button.tiny-btn',
            viewport: 'mobile',
            message: 'Tap target is too small (28x22px)',
            details: {},
          },
        ],
      },
      tablet: {
        viewport: 'tablet',
        width: 768,
        height: 1024,
        screenshotPath: '',
        hasHorizontalOverflow: false,
        scrollWidth: 768,
        innerWidth: 768,
        issues: [],
      },
      desktop: {
        viewport: 'desktop',
        width: 1280,
        height: 800,
        screenshotPath: '',
        hasHorizontalOverflow: false,
        scrollWidth: 1280,
        innerWidth: 1280,
        issues: [],
      },
    },
    totalIssues: 2,
    issuesByElementId: {
      'sec-fixed-promo': [
        {
          type: 'overflowing_element',
          elementId: 'sec-fixed-promo',
          selector: '#sec-fixed-promo',
          viewport: 'mobile',
          message: 'Element overflows right edge by 375px',
          details: {},
        },
      ],
      'w-tiny-cta-btn': [
        {
          type: 'small_tap_target',
          elementId: 'w-tiny-cta-btn',
          selector: 'button.tiny-btn',
          viewport: 'mobile',
          message: 'Tap target is too small (28x22px)',
          details: {},
        },
      ],
    },
  };

  it('Analyzes layout defects and proposes structured patches conforming to Hard Rule 2', async () => {
    const output = await analyst.analyze({
      elementorData: fixtureTree,
      auditReport: mockAuditReport,
    });

    expect(output).toHaveProperty('patches');
    expect(output).toHaveProperty('unresolved');
    expect(output.patches.length).toBeGreaterThanOrEqual(1);

    // Verify all proposed patches pass the strict key validator
    const validation = validatePatches(output.patches, fixtureTree);
    expect(validation.valid).toBe(true);
    expect(validation.errors.length).toBe(0);

    // Verify patch keys all end with _mobile or _tablet
    for (const patch of output.patches) {
      for (const key of Object.keys(patch.settings)) {
        expect(key.endsWith('_mobile') || key.endsWith('_tablet')).toBe(true);
      }
    }
  });
});
