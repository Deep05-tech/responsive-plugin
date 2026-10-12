import { describe, it, expect } from 'vitest';
import { LayoutAnalyst } from '../src/llm/analyst.js';
import { validatePatches } from '../src/patch/validator.js';
import { loadConfig } from '../src/config/index.js';
import { ElementorElement } from '../src/patch/tree.js';
import { AuditReport } from '../src/audit/types.js';

const config = loadConfig();
const isLive = process.env.RUN_LIVE === '1' && Boolean(config.openaiApiKey);

describe.skipIf(!isLive)('Phase 2 - Live Analyst Test (RUN_LIVE=1)', () => {
  const analyst = new LayoutAnalyst(config);

  const sampleTree: ElementorElement[] = [
    {
      id: 'vispan_hero_section',
      elType: 'section',
      elements: [
        {
          id: 'vispan_hero_column',
          elType: 'column',
          elements: [
            {
              id: 'vispan_hero_heading',
              elType: 'widget',
              widgetType: 'heading',
              settings: { title: 'Dental Clinic Marketing' },
            },
          ],
        },
      ],
    },
  ];

  const mockAuditReport: AuditReport = {
    url: 'http://seo.local',
    timestamp: new Date().toISOString(),
    totalIssues: 1,
    viewports: {
      mobile: {
        viewport: 'mobile',
        width: 375,
        height: 812,
        issues: [
          {
            type: 'overflowing_element',
            elementId: 'vispan_hero_heading',
            severity: 'P0',
            viewport: 'mobile',
            message: 'Element overflows mobile viewport by 40px',
            patchable: true,
          },
        ],
        hasHorizontalOverflow: true,
        scrollWidth: 415,
        clientWidth: 375,
        diffPixelsFromStable: 0,
        diffPercentageFromStable: 0,
      },
      tablet: { viewport: 'tablet', width: 768, height: 1024, issues: [], hasHorizontalOverflow: false, scrollWidth: 768, clientWidth: 768, diffPixelsFromStable: 0, diffPercentageFromStable: 0 },
      desktop: { viewport: 'desktop', width: 1280, height: 800, issues: [], hasHorizontalOverflow: false, scrollWidth: 1280, clientWidth: 1280, diffPixelsFromStable: 0, diffPercentageFromStable: 0 },
    },
    issuesByElementId: {
      vispan_hero_heading: {
        elementId: 'vispan_hero_heading',
        scope: 'elementor',
        issues: [
          {
            type: 'overflowing_element',
            elementId: 'vispan_hero_heading',
            severity: 'P0',
            viewport: 'mobile',
            message: 'Element overflows mobile viewport by 40px',
            patchable: true,
          },
        ],
      },
    },
    summary: {
      total: 1,
      by_severity: { P0: 1, P1: 0, P2: 0 },
      by_element: { vispan_hero_heading: 1 },
      patchable_count: 1,
      unpatchable_count: 0,
    },
    integrity: {
      total_matches_severity_sum: true,
      total_matches_element_sum: true,
      total_matches_patchability_sum: true,
    },
  };

  it('Calls real OpenAI model and proposes valid responsive patches', async () => {
    const proposal = await analyst.analyze({
      elementorData: sampleTree,
      auditReport: mockAuditReport,
    });

    expect(proposal.stats.llmCalls).toBeGreaterThanOrEqual(1);
    expect(proposal.stats.isFallback).toBe(false);

    // Verify all proposed patches pass validation
    const validation = validatePatches(proposal.patches, sampleTree);
    expect(validation.valid).toBe(true);

    for (const patch of proposal.patches) {
      expect(patch.source).toBe('llm');
    }
  }, 30000);
});
