import OpenAI from 'openai';
import fs from 'fs';
import { AuditReport, Issue } from '../audit/types.js';
import {
  ElementorElement,
  getAllElementIds,
  findElementById,
  findNearestCommonAncestor,
  getElementType,
} from '../patch/tree.js';
import { trimElementorPayload } from '../patch/trimmer.js';
import { AnalystOutput, AnalystOutputSchema, OPENAI_PROPOSAL_JSON_SCHEMA } from './schema.js';
import { ANALYST_SYSTEM_PROMPT } from './prompts.js';
import { EraConfig, loadConfig } from '../config/index.js';

export interface AnalystInput {
  elementorData: ElementorElement[];
  auditReport: AuditReport;
  mobileScreenshotPath?: string;
  tabletScreenshotPath?: string;
}

export interface AnalystResult extends AnalystOutput {
  stats: {
    promptTokens: number;
    completionTokens: number;
    llmCalls: number;
    isFallback: boolean;
  };
}

export class LayoutAnalyst {
  private client: OpenAI | null = null;
  private config: EraConfig;

  constructor(config?: EraConfig) {
    this.config = config || loadConfig();
    if (this.config.openaiApiKey && !this.config.offline) {
      this.client = new OpenAI({ apiKey: this.config.openaiApiKey });
    }
  }

  /**
   * Deduplicate issues by (element, type, viewport) and optionally filter typography issues.
   */
  private prepareDeduplicatedIssues(auditReport: AuditReport, includeTypography: boolean): Map<string, Issue[]> {
    const issuesByElement = new Map<string, Issue[]>();

    for (const [elId, group] of Object.entries(auditReport.issuesByElementId)) {
      const rawIssues = Array.isArray(group) ? group : group.issues || [];
      const seen = new Set<string>();
      const deduped: Issue[] = [];

      for (const iss of rawIssues) {
        // Filter P2 font issues unless includeTypography is enabled
        if (iss.type === 'small_font_size' && !includeTypography) {
          continue;
        }

        const key = `${iss.elementId || elId}::${iss.type}::${iss.viewport}`;
        if (!seen.has(key)) {
          seen.add(key);
          deduped.push(iss);
        }
      }

      if (deduped.length > 0) {
        issuesByElement.set(elId, deduped);
      }
    }

    return issuesByElement;
  }

  /**
   * Analyze the audit report, screenshots, and Elementor JSON to propose responsive patches.
   */
  public async analyze(input: AnalystInput): Promise<AnalystResult> {
    const { elementorData, auditReport, mobileScreenshotPath, tabletScreenshotPath } = input;
    const includeTypography = Boolean(this.config.includeTypography);

    // Deduplicate issues
    const dedupedIssuesMap = this.prepareDeduplicatedIssues(auditReport, includeTypography);

    // Trim tree to relevant nodes and context within token budget
    const trimmed = trimElementorPayload(elementorData, auditReport, 12000);
    const validElementIds = Array.from(getAllElementIds(elementorData));

    // Offline heuristic mode
    if (this.config.offline || !this.client) {
      if (!this.config.offline && !this.config.openaiApiKey) {
        throw new Error(
          'OPENAI_API_KEY is not configured and offline mode was not requested. Provide OPENAI_API_KEY in .env or pass --offline to use local heuristics.'
        );
      }
      const fallbackOutput = this.heuristicFallbackAnalysis(
        elementorData,
        auditReport,
        validElementIds,
        includeTypography
      );
      return {
        ...fallbackOutput,
        stats: {
          promptTokens: trimmed.estimatedTokens,
          completionTokens: 0,
          llmCalls: 0,
          isFallback: true,
        },
      };
    }

    // Build OpenAI vision messages
    const userContentParts: OpenAI.Chat.ChatCompletionContentPart[] = [];

    // Attach Mobile Screenshot (375px)
    if (mobileScreenshotPath && fs.existsSync(mobileScreenshotPath)) {
      const base64Mobile = fs.readFileSync(mobileScreenshotPath).toString('base64');
      userContentParts.push({
        type: 'image_url',
        image_url: {
          url: `data:image/png;base64,${base64Mobile}`,
          detail: 'high',
        },
      });
      userContentParts.push({
        type: 'text',
        text: 'Above: Mobile (375px) viewport capture showing responsive layout defects.',
      });
    }

    // Attach Tablet Screenshot (768px)
    if (tabletScreenshotPath && fs.existsSync(tabletScreenshotPath)) {
      const base64Tablet = fs.readFileSync(tabletScreenshotPath).toString('base64');
      userContentParts.push({
        type: 'image_url',
        image_url: {
          url: `data:image/png;base64,${base64Tablet}`,
          detail: 'high',
        },
      });
      userContentParts.push({
        type: 'text',
        text: 'Above: Tablet (768px) viewport capture.',
      });
    }

    const issuesJson: Record<string, Issue[]> = {};
    for (const [k, v] of dedupedIssuesMap.entries()) {
      issuesJson[k] = v;
    }

    const promptText = `
Here is the Audit Report containing deduplicated layout issues:
\`\`\`json
${JSON.stringify(issuesJson, null, 2)}
\`\`\`

Here is the current Elementor JSON data (trimmed to affected elements and ancestors):
\`\`\`json
${JSON.stringify(trimmed.elements, null, 2)}
\`\`\`

Valid Element IDs in the document are:
${JSON.stringify(validElementIds)}

Include Typography: ${includeTypography ? 'YES' : 'NO (Do not generate font-size patches or CSS)'}

Propose responsive setting patches for mobile and tablet. Remember:
- Only keys ending in _mobile, _tablet, _mobile_extra, _tablet_extra.
- Check element elType (widgets use _padding_mobile / _margin_mobile / _element_width_mobile; sections/columns use padding_mobile / margin_mobile).
- Propose at nearest common ancestor if multiple child elements share identical overflow width.
- Tap targets on wrapper widgets must be placed in 'unresolved' with reason 'needs_css_on_inner_links'.
- Output strictly conforming to the requested JSON schema.
`;

    userContentParts.push({ type: 'text', text: promptText });

    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let llmCalls = 0;

    const formatLlmOutput = (data: AnalystOutput): AnalystResult => {
      const initialPatches = (data.patches || []).map((p) => {
        const elType = p.elType || getElementType(elementorData, p.element_id) || 'widget';
        const cleanedSettings: Record<string, any> = {};

        for (const [k, v] of Object.entries(p.settings || {})) {
          // Rule 4e: _element_width_* "auto" (Inline) cannot fix overflow, use "inherit" (Full Width)
          if ((k.startsWith('_element_width_') || k.startsWith('width_')) && v === 'auto') {
            cleanedSettings[k.startsWith('_') ? k : `_${k}`] = 'inherit';
            continue;
          }

          // Rule 2e: Suffix & elType check (widget -> _padding_*, section/column -> padding_*)
          if (elType === 'widget') {
            if (k.startsWith('padding_')) {
              cleanedSettings[`_${k}`] = v;
            } else if (k.startsWith('margin_')) {
              cleanedSettings[`_${k}`] = v;
            } else {
              cleanedSettings[k] = v;
            }
          } else {
            if (k.startsWith('_padding_')) {
              cleanedSettings[k.replace(/^_/, '')] = v;
            } else if (k.startsWith('_margin_')) {
              cleanedSettings[k.replace(/^_/, '')] = v;
            } else {
              cleanedSettings[k] = v;
            }
          }
        }

        return {
          ...p,
          elType,
          settings: cleanedSettings,
          source: 'llm' as const,
        };
      });

      const cssProposals = (data.cssProposals || []).map((c) => ({
        ...c,
        source: 'llm' as const,
      }));

      const unresolved = [...(data.unresolved || [])];

      // Rule 4d: If overflowing node is an inner child inside the widget (not wrapper), send to cssProposals
      const finalPatches: typeof initialPatches = [];
      for (const patch of initialPatches) {
        const issuesForEl = auditReport.issuesByElementId[patch.element_id];
        const rawIssues = issuesForEl ? (Array.isArray(issuesForEl) ? issuesForEl : (issuesForEl as any).issues || []) : [];
        const hasInnerOverflowChild = rawIssues.some((iss: Issue) => {
          if (iss.type !== 'overflowing_element' && iss.type !== 'horizontal_overflow' && iss.type !== 'multi_cause_overflow') {
            return false;
          }
          const sel = iss.selector || '';
          return (
            sel.includes(' ') ||
            sel.includes('h3') ||
            sel.includes('h4') ||
            sel.includes('div.vispan') ||
            sel.includes('table') ||
            sel.includes('form')
          );
        });

        if (patch.elType === 'widget' && hasInnerOverflowChild) {
          // Inner child overflow in widget: cannot fix with widget wrapper padding/width
          const targetTag = rawIssues.find((i: Issue) => i.selector)?.selector?.split(/\s+/).pop() || 'div';
          const validEndingTag = targetTag.replace(/[^a-zA-Z0-9_\-\.]/g, '') || 'div';
          cssProposals.push({
            element_id: patch.element_id,
            css: `@media (max-width: 1024px) { .elementor-element-${patch.element_id} ${validEndingTag} { max-width: 100% !important; box-sizing: border-box !important; min-width: 0 !important; } }`,
            reason: `Constrain inner ${validEndingTag} element overflow inside widget via scoped responsive CSS.`,
            source: 'llm' as const,
          });
        } else if (patch.settings && Object.keys(patch.settings).length > 0) {
          finalPatches.push(patch);
        }
      }

      // Rule 4c: Identical patches on several elements: collapse to one patch at nearest common ancestor or unresolved
      const patchesBySettingsJson = new Map<string, typeof finalPatches>();
      for (const p of finalPatches) {
        const key = JSON.stringify(p.settings);
        if (!patchesBySettingsJson.has(key)) {
          patchesBySettingsJson.set(key, []);
        }
        patchesBySettingsJson.get(key)!.push(p);
      }

      const collapsedPatches: typeof finalPatches = [];
      for (const [settingsJson, group] of patchesBySettingsJson.entries()) {
        if (group.length > 1) {
          const elementIds = group.map((g) => g.element_id);
          const lcaNode = findNearestCommonAncestor(elementorData, elementIds);
          const lcaId = lcaNode?.id;
          if (lcaId && !elementIds.includes(lcaId)) {
            const lcaType = lcaNode.elType || getElementType(elementorData, lcaId) || 'section';
            const sampleSettings = group[0].settings;
            const ancestorSettings: Record<string, any> = {};
            for (const [k, v] of Object.entries(sampleSettings)) {
              if (lcaType === 'section' || lcaType === 'column') {
                ancestorSettings[k.replace(/^_/, '')] = v;
              } else {
                ancestorSettings[k] = v;
              }
            }
            collapsedPatches.push({
              element_id: lcaId,
              elType: lcaType,
              settings: ancestorSettings,
              reason: `Collapsed identical responsive fixes across children (${elementIds.join(', ')}) to nearest common ancestor ${lcaId}.`,
              source: 'llm' as const,
            });
          } else {
            collapsedPatches.push(...group);
          }
        } else {
          collapsedPatches.push(...group);
        }
      }

      return {
        patches: collapsedPatches,
        cssProposals,
        unresolved,
        stats: {
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          llmCalls,
          isFallback: false,
        },
      };
    };

    // First attempt with OpenAI Structured Outputs
    try {
      llmCalls++;
      const response = await this.client.chat.completions.create({
        model: this.config.openaiModel,
        messages: [
          { role: 'system', content: ANALYST_SYSTEM_PROMPT },
          { role: 'user', content: userContentParts },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: OPENAI_PROPOSAL_JSON_SCHEMA,
        },
        max_tokens: 4096,
      });

      if (response.usage) {
        totalPromptTokens += response.usage.prompt_tokens || 0;
        totalCompletionTokens += response.usage.completion_tokens || 0;
      }

      const content = response.choices[0]?.message?.content;
      if (content) {
        try {
          const parsedJson = JSON.parse(content);
          const parsed = AnalystOutputSchema.safeParse(parsedJson);
          if (parsed.success) {
            return formatLlmOutput(parsed.data);
          }
        } catch {
          // JSON parse failed, will retry
        }
      }
    } catch (err) {
      console.warn(`[Analyst] First OpenAI attempt failed, attempting retry: ${err}`);
    }

    // Retry once on failure
    try {
      llmCalls++;
      const retryResponse = await this.client.chat.completions.create({
        model: this.config.openaiModel,
        messages: [
          { role: 'system', content: ANALYST_SYSTEM_PROMPT },
          { role: 'user', content: userContentParts },
          {
            role: 'assistant',
            content: 'I will now output the structured responsive patch proposal strictly conforming to the JSON schema.',
          },
          {
            role: 'user',
            content: 'Submit the valid JSON proposal now.',
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: OPENAI_PROPOSAL_JSON_SCHEMA,
        },
        max_tokens: 4096,
      });

      if (retryResponse.usage) {
        totalPromptTokens += retryResponse.usage.prompt_tokens || 0;
        totalCompletionTokens += retryResponse.usage.completion_tokens || 0;
      }

      const content = retryResponse.choices[0]?.message?.content;
      if (content) {
        const parsedJson = JSON.parse(content);
        const parsed = AnalystOutputSchema.safeParse(parsedJson);
        if (parsed.success) {
          return formatLlmOutput(parsed.data);
        }
      }
    } catch (err: any) {
      console.warn(`[Analyst] OpenAI call failed on retry: ${err.message}`);
    }

    // Rule 2g: A malformed model response must end in unresolved, not throw
    return {
      patches: [],
      cssProposals: [],
      unresolved: [
        {
          element_id: 'document',
          reason: 'Model response was malformed or failed schema validation after retry.',
        },
      ],
      stats: {
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        llmCalls,
        isFallback: false,
      },
    };
  }

  /**
   * Deterministic heuristic fallback used for testing and offline environments.
   */
  public heuristicFallbackAnalysis(
    elementorData: ElementorElement[],
    auditReport: AuditReport,
    validElementIds: string[],
    includeTypography: boolean = false
  ): AnalystOutput {
    const patches: AnalystOutput['patches'] = [];
    const cssProposals: AnalystOutput['cssProposals'] = [];
    const unresolved: AnalystOutput['unresolved'] = [];
    const validSet = new Set(validElementIds);

    // Group overflow elements by overflow magnitude to find common ancestors (Rule 2f)
    const overflowElementsByWidth = new Map<number, string[]>();

    for (const [elementId, group] of Object.entries(auditReport.issuesByElementId)) {
      const issues = Array.isArray(group) ? group : group.issues || [];
      for (const iss of issues) {
        if (iss.type === 'overflowing_element' || iss.type === 'horizontal_overflow') {
          const width = iss.details?.right || iss.details?.scrollWidth || 375;
          if (!overflowElementsByWidth.has(width)) {
            overflowElementsByWidth.set(width, []);
          }
          if (elementId && elementId !== 'unknown_element') {
            overflowElementsByWidth.get(width)!.push(elementId);
          }
        }
      }
    }

    const processedCommonAncestors = new Set<string>();

    for (const [elementId, group] of Object.entries(auditReport.issuesByElementId)) {
      const issues = Array.isArray(group) ? group : group.issues || [];

      if (elementId === 'unknown_element' || !validSet.has(elementId)) {
        for (const iss of issues) {
          unresolved.push({
            element_id: elementId,
            reason: `Issue "${iss.type}" is at document level or belongs to an unmapped element (${iss.selector}).`,
          });
        }
        continue;
      }

      const elType = getElementType(elementorData, elementId) || 'widget';
      const settings: Record<string, any> = {};
      const reasons: string[] = [];

      // Dedupe issues on this element by type and viewport (Rule 2a)
      const seenIssueKeys = new Set<string>();

      for (const iss of issues) {
        const issueKey = `${iss.type}::${iss.viewport}`;
        if (seenIssueKeys.has(issueKey)) continue;
        seenIssueKeys.add(issueKey);

        // Rule 2d: P2 font issues never produce patches or CSS unless includeTypography is true
        if (iss.type === 'small_font_size') {
          if (includeTypography) {
            if (iss.patchable === false && iss.unpatchableReason === 'inline_html_style') {
              cssProposals.push({
                element_id: elementId,
                css: `@media (max-width: 767px) { .elementor-element-${elementId} p, .elementor-element-${elementId} span { font-size: 14px !important; } }`,
                reason: 'Override inline HTML font-size to 14px on mobile via scoped CSS',
                source: 'fallback',
              });
            } else if (elType === 'widget') {
              settings['typography_font_size_mobile'] = { unit: 'px', size: 14 };
              reasons.push('Increased mobile font size to 14px for readability');
            }
          }
          continue;
        }

        // Rule 2c: Tap-target patches are not allowed on wrapper widgets. Move to unresolved.
        if (iss.type === 'small_tap_target') {
          if (elType === 'section' || elType === 'column' || elType === 'container' || elType === 'widget') {
            unresolved.push({
              element_id: elementId,
              reason: 'needs_css_on_inner_links',
            });
          }
          continue;
        }

        if (iss.patchable === false) {
          unresolved.push({
            element_id: elementId,
            reason: `Unpatchable via Elementor settings: ${iss.unpatchableReason || 'external style'} (${iss.message})`,
          });
          continue;
        }

        if (
          iss.type === 'horizontal_overflow' ||
          iss.type === 'overflowing_element' ||
          iss.type === 'fixed_pixel_width_overflow'
        ) {
          if (elType === 'widget') {
            settings['_element_width_mobile'] = 'inherit';
            settings['_element_custom_width_mobile'] = { unit: '%', size: 100 };
            settings['_padding_mobile'] = { unit: 'px', top: '10', right: '15', bottom: '10', left: '15', isLinked: false };
            if (iss.viewport === 'tablet') {
              settings['_element_width_tablet'] = 'inherit';
              settings['_element_custom_width_tablet'] = { unit: '%', size: 100 };
              settings['_padding_tablet'] = { unit: 'px', top: '10', right: '15', bottom: '10', left: '15', isLinked: false };
            }
          } else if (elType === 'column') {
            settings['_inline_size_mobile'] = 100;
            settings['padding_mobile'] = { unit: 'px', top: '10', right: '15', bottom: '10', left: '15', isLinked: false };
            if (iss.viewport === 'tablet') {
              settings['_inline_size_tablet'] = 100;
              settings['padding_tablet'] = { unit: 'px', top: '10', right: '15', bottom: '10', left: '15', isLinked: false };
            }
          } else if (elType === 'section' || elType === 'container') {
            settings['padding_mobile'] = { unit: 'px', top: '10', right: '15', bottom: '10', left: '15', isLinked: false };
            if (iss.viewport === 'tablet') {
              settings['padding_tablet'] = { unit: 'px', top: '10', right: '15', bottom: '10', left: '15', isLinked: false };
            }
          }
          reasons.push('Set responsive width to 100% and bounded padding to eliminate overflow');
        } else if (iss.type === 'overlapping_elements') {
          if (elType === 'widget') {
            settings['_margin_mobile'] = { unit: 'px', top: '10', right: '0', bottom: '10', left: '0', isLinked: false };
          } else {
            settings['margin_mobile'] = { unit: 'px', top: '10', right: '0', bottom: '10', left: '0', isLinked: false };
          }
          reasons.push('Reset relative spacing to prevent overlapping siblings');
        }
      }

      if (Object.keys(settings).length > 0) {
        patches.push({
          element_id: elementId,
          elType,
          settings,
          reason: Array.from(new Set(reasons)).join('; '),
          source: 'fallback',
        });
      }
    }

    return { patches, cssProposals, unresolved };
  }
}
