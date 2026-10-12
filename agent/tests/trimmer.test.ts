import { describe, it, expect } from 'vitest';
import { trimElementorPayload, estimateTokens } from '../src/patch/trimmer.js';
import { AuditReport } from '../src/audit/types.js';
import { ElementorElement } from '../src/patch/tree.js';

describe('Phase 2 - Payload Trimmer & Token Budgeting', () => {
  const sampleTree: ElementorElement[] = [
    {
      id: 'sec_1',
      elType: 'section',
      elements: [
        {
          id: 'col_1',
          elType: 'column',
          elements: [
            {
              id: 'widget_hero_heading',
              elType: 'widget',
              widgetType: 'heading',
              settings: {
                title: 'This is a heading',
                long_html: 'A'.repeat(500),
              },
            },
            {
              id: 'widget_unrelated',
              elType: 'widget',
              widgetType: 'image',
              settings: {},
            },
          ],
        },
      ],
    },
    {
      id: 'sec_2',
      elType: 'section',
      elements: [
        {
          id: 'col_2',
          elType: 'column',
          elements: [
            {
              id: 'widget_other_clean',
              elType: 'widget',
              widgetType: 'text-editor',
              settings: {},
            },
          ],
        },
      ],
    },
  ];

  const mockAuditReport: AuditReport = {
    url: 'http://test.local',
    timestamp: '2026-10-09T00:00:00.000Z',
    totalIssues: 1,
    viewports: {
      mobile: { viewport: 'mobile', width: 375, height: 667, issues: [], hasHorizontalOverflow: false, scrollWidth: 375, clientWidth: 375, diffPixelsFromStable: 0, diffPercentageFromStable: 0 },
      tablet: { viewport: 'tablet', width: 768, height: 1024, issues: [], hasHorizontalOverflow: false, scrollWidth: 768, clientWidth: 768, diffPixelsFromStable: 0, diffPercentageFromStable: 0 },
      desktop: { viewport: 'desktop', width: 1280, height: 800, issues: [], hasHorizontalOverflow: false, scrollWidth: 1280, clientWidth: 1280, diffPixelsFromStable: 0, diffPercentageFromStable: 0 },
    },
    issuesByElementId: {
      widget_hero_heading: {
        elementId: 'widget_hero_heading',
        scope: 'elementor',
        issues: [
          {
            type: 'small_font_size',
            severity: 'P2',
            viewport: 'mobile',
            elementId: 'widget_hero_heading',
            message: 'Font size 10px is below 12px',
            patchable: true,
          },
        ],
      },
    },
    summary: {
      total: 1,
      by_severity: { P0: 0, P1: 0, P2: 1 },
      by_element: { widget_hero_heading: 1 },
      patchable_count: 1,
      unpatchable_count: 0,
    },
    integrity: {
      total_matches_severity_sum: true,
      total_matches_element_sum: true,
      total_matches_patchability_sum: true,
    },
  };

  it('Trims tree to include only the affected element and its ancestor chain', () => {
    const result = trimElementorPayload(sampleTree, mockAuditReport);

    expect(result.elements.length).toBe(1);
    expect(result.elements[0].id).toBe('sec_1');
    expect(result.elements[0].elements?.[0].id).toBe('col_1');
    expect(result.elements[0].elements?.[0].elements?.length).toBe(1);
    expect(result.elements[0].elements?.[0].elements?.[0].id).toBe('widget_hero_heading');

    // widget_unrelated and sec_2 should be excluded
    const jsonStr = JSON.stringify(result.elements);
    expect(jsonStr.includes('widget_unrelated')).toBe(false);
    expect(jsonStr.includes('sec_2')).toBe(false);
  });

  it('Truncates long setting strings to at most 300 chars plus truncated tag', () => {
    const result = trimElementorPayload(sampleTree, mockAuditReport);
    const target = result.elements[0].elements?.[0].elements?.[0];
    expect(target?.settings?.long_html.length).toBeLessThan(350);
    expect(target?.settings?.long_html.includes('[truncated]')).toBe(true);
  });

  it('Estimates token counts accurately', () => {
    const tokens = estimateTokens({ hello: 'world' });
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(100);
  });
});
