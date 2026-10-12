import { z } from 'zod';

export const PatchSettingValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.record(z.any()),
]);

export const PatchItemSchema = z
  .object({
    element_id: z.string().min(1, 'element_id is required'),
    elType: z.string().optional(),
    settings: z
      .union([z.record(PatchSettingValueSchema), z.string()])
      .optional(),
    settings_json: z.string().optional(),
    reason: z.string().min(1, 'reason is required'),
    source: z.enum(['llm', 'fallback']).optional(),
  })
  .transform((item) => {
    let settings: Record<string, any> = {};
    if (typeof item.settings === 'object' && item.settings !== null) {
      settings = item.settings;
    } else if (typeof item.settings === 'string') {
      try {
        settings = JSON.parse(item.settings);
      } catch {
        settings = {};
      }
    } else if (item.settings_json) {
      try {
        settings = JSON.parse(item.settings_json);
      } catch {
        settings = {};
      }
    }
    return {
      element_id: item.element_id,
      elType: item.elType,
      settings,
      reason: item.reason,
      source: item.source,
    };
  });

export const CssProposalSchema = z.object({
  element_id: z.string().min(1, 'element_id is required'),
  css: z.string().min(1, 'css rule is required'),
  reason: z.string().min(1, 'reason is required'),
  source: z.enum(['llm', 'fallback']).optional(),
});

export const UnresolvedItemSchema = z.object({
  element_id: z.string().min(1, 'element_id is required'),
  reason: z.string().min(1, 'reason is required'),
});

export const AnalystOutputSchema = z.object({
  patches: z.array(PatchItemSchema),
  cssProposals: z.array(CssProposalSchema),
  unresolved: z.array(UnresolvedItemSchema),
});

export type AnalystPatchItem = z.infer<typeof PatchItemSchema>;
export type CssProposal = z.infer<typeof CssProposalSchema>;
export type UnresolvedItem = z.infer<typeof UnresolvedItemSchema>;
export type AnalystOutput = z.infer<typeof AnalystOutputSchema>;

/**
 * OpenAI Strict JSON Schema for Structured Outputs.
 */
export const OPENAI_PROPOSAL_JSON_SCHEMA = {
  name: 'propose_responsive_patches',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      patches: {
        type: 'array',
        description: 'List of responsive settings patches for Elementor elements',
        items: {
          type: 'object',
          properties: {
            element_id: {
              type: 'string',
              description: 'Exact ID of the Elementor element',
            },
            elType: {
              type: 'string',
              description: 'Element type: section, column, or widget',
            },
            settings_json: {
              type: 'string',
              description:
                'JSON serialized dictionary of responsive settings ending in _mobile or _tablet, e.g. {"_padding_mobile":{"unit":"px","top":"10","right":"10","bottom":"10","left":"10"}}',
            },
            reason: {
              type: 'string',
              description: 'Technical explanation of how this patch resolves the layout defect',
            },
          },
          required: ['element_id', 'elType', 'settings_json', 'reason'],
          additionalProperties: false,
        },
      },
      cssProposals: {
        type: 'array',
        description: 'List of scoped responsive CSS rules for unpatchable inline styles',
        items: {
          type: 'object',
          properties: {
            element_id: {
              type: 'string',
              description: 'Exact ID of the target element',
            },
            css: {
              type: 'string',
              description: 'Scoped responsive CSS rule wrapped in media query and targeting specific tags',
            },
            reason: {
              type: 'string',
              description: 'Explanation of why CSS override is needed',
            },
          },
          required: ['element_id', 'css', 'reason'],
          additionalProperties: false,
        },
      },
      unresolved: {
        type: 'array',
        description: 'Issues that cannot be resolved automatically or require manual design changes',
        items: {
          type: 'object',
          properties: {
            element_id: {
              type: 'string',
              description: 'Element ID or document identifier',
            },
            reason: {
              type: 'string',
              description: 'Detailed explanation of why the issue is unresolved',
            },
          },
          required: ['element_id', 'reason'],
          additionalProperties: false,
        },
      },
    },
    required: ['patches', 'cssProposals', 'unresolved'],
    additionalProperties: false,
  },
} as const;
