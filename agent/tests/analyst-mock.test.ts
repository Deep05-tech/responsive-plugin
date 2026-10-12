import { describe, it, expect, vi } from 'vitest';
import { LayoutAnalyst } from '../src/llm/analyst.js';
import { validatePatches } from '../src/patch/validator.js';
import { AuditReport } from '../src/audit/types.js';
import { ElementorElement } from '../src/patch/tree.js';
import OpenAI from 'openai';

vi.mock('openai');

describe('Phase 2 - Mocked OpenAI Error Handling & Strict Validation', () => {
  const sampleTree: ElementorElement[] = [
    {
      id: 'valid_section_1',
      elType: 'section',
      elements: [
        {
          id: 'valid_widget_1',
          elType: 'widget',
          widgetType: 'heading',
          settings: {},
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
            elementId: 'valid_widget_1',
            severity: 'P0',
            viewport: 'mobile',
            message: 'Overflowing element',
            patchable: true,
          },
        ],
        hasHorizontalOverflow: true,
        scrollWidth: 450,
        clientWidth: 375,
        diffPixelsFromStable: 0,
        diffPercentageFromStable: 0,
      },
      tablet: { viewport: 'tablet', width: 768, height: 1024, issues: [], hasHorizontalOverflow: false, scrollWidth: 768, clientWidth: 768, diffPixelsFromStable: 0, diffPercentageFromStable: 0 },
      desktop: { viewport: 'desktop', width: 1280, height: 800, issues: [], hasHorizontalOverflow: false, scrollWidth: 1280, clientWidth: 1280, diffPixelsFromStable: 0, diffPercentageFromStable: 0 },
    },
    issuesByElementId: {
      valid_widget_1: {
        elementId: 'valid_widget_1',
        scope: 'elementor',
        issues: [
          {
            type: 'overflowing_element',
            elementId: 'valid_widget_1',
            severity: 'P0',
            viewport: 'mobile',
            message: 'Overflowing element',
            patchable: true,
          },
        ],
      },
    },
    summary: {
      total: 1,
      by_severity: { P0: 1, P1: 0, P2: 0 },
      by_element: { valid_widget_1: 1 },
      patchable_count: 1,
      unpatchable_count: 0,
    },
    integrity: {
      total_matches_severity_sum: true,
      total_matches_element_sum: true,
      total_matches_patchability_sum: true,
    },
  };

  it('Case (a): OpenAI returns a nonexistent element_id -> rejected and does not reach accepted', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              patches: [
                {
                  element_id: 'nonexistent_hallucinated_id',
                  elType: 'widget',
                  settings: { _padding_mobile: { unit: 'px', top: '10', right: '10', bottom: '10', left: '10' } },
                  reason: 'Fix overflow on fake element',
                },
              ],
              cssProposals: [],
              unresolved: [],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });

    (OpenAI as any).mockImplementation(() => ({
      chat: { completions: { create: mockCreate } },
    }));

    const analyst = new LayoutAnalyst({
      openaiApiKey: 'fake-key',
      openaiModel: 'gpt-4o',
      offline: false,
    } as any);

    const proposal = await analyst.analyze({
      elementorData: sampleTree,
      auditReport: mockAuditReport,
    });

    const validation = validatePatches(proposal.patches, sampleTree);

    expect(validation.validatedPatches.length).toBe(0);
    expect(validation.rejectedPatches.length).toBe(1);
    expect(validation.rejectedPatches[0].reasons.some((r) => r.code === 'unknown_element')).toBe(true);
  });

  it('Case (b): OpenAI returns a desktop key (Hard Rule 2 violation) -> rejected and does not reach accepted', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              patches: [
                {
                  element_id: 'valid_widget_1',
                  elType: 'widget',
                  settings: {
                    width: { unit: 'px', size: 300 }, // Desktop key without responsive suffix
                  },
                  reason: 'Direct desktop width change',
                },
              ],
              cssProposals: [],
              unresolved: [],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });

    (OpenAI as any).mockImplementation(() => ({
      chat: { completions: { create: mockCreate } },
    }));

    const analyst = new LayoutAnalyst({
      openaiApiKey: 'fake-key',
      openaiModel: 'gpt-4o',
      offline: false,
    } as any);

    const proposal = await analyst.analyze({
      elementorData: sampleTree,
      auditReport: mockAuditReport,
    });

    const validation = validatePatches(proposal.patches, sampleTree);

    expect(validation.validatedPatches.length).toBe(0);
    expect(validation.rejectedPatches.length).toBe(1);
    expect(validation.rejectedPatches[0].reasons.some((r) => r.code === 'disallowed_key')).toBe(true);
  });

  it('Case (c): OpenAI returns malformed JSON -> ends in unresolved and does not throw', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: 'MALFORMED_NON_JSON_RESPONSE',
          },
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 20 },
    });

    (OpenAI as any).mockImplementation(() => ({
      chat: { completions: { create: mockCreate } },
    }));

    const analyst = new LayoutAnalyst({
      openaiApiKey: 'fake-key',
      openaiModel: 'gpt-4o',
      offline: false,
    } as any);

    const proposal = await analyst.analyze({
      elementorData: sampleTree,
      auditReport: mockAuditReport,
    });

    expect(proposal).toBeDefined();
    expect(proposal.patches.length).toBe(0);
    expect(proposal.unresolved.length).toBeGreaterThan(0);
    expect(proposal.unresolved[0].reason).toContain('malformed');

    const validation = validatePatches(proposal.patches, sampleTree);
    expect(validation.validatedPatches.length).toBe(0);
  });
});
