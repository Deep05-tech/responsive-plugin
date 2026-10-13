import OpenAI from 'openai';
import { ElementorElement } from '../patch/tree.js';
import { EraConfig, loadConfig } from '../config/index.js';
import { EraBridgeClient } from '../bridge/client.js';
import { generateScopedSectionCss } from '../patch/scoped-styler.js';

export interface EditableSnippet {
  elementId: string;
  widgetType: string;
  settingKey: string;
  content: string;
}

export interface SectionCandidate {
  id: string;
  heading: string;
  subHeadings?: string[];
  innerClasses?: string[];
  widgetTypes: string[];
  sampleText: string;
  editableSnippets?: EditableSnippet[];
}

export interface ContentPatch {
  elementId?: string;
  settingKey?: string;
  search: string;
  replace: string;
}

export interface SectionMatchRequest {
  pageId: number | string;
  message?: string;
  imageBase64?: string;
  elementorData?: ElementorElement[];
}

export interface SectionMatchResult {
  matchedElementId: string;
  sectionTitle: string;
  actionType?: 'content' | 'style' | 'both';
  detectedIssues: string[];
  explanation: string;
  scopedCss: string;
  contentPatches?: ContentPatch[];
  confidence: number;
}

export class SectionMatcher {
  private client: OpenAI | null = null;
  private config: EraConfig;

  constructor(config?: EraConfig) {
    this.config = config || loadConfig();
    if (this.config.openaiApiKey && !this.config.offline) {
      this.client = new OpenAI({ apiKey: this.config.openaiApiKey });
    }
  }

  /**
   * Recursively extract top-level sections/containers with their headings, CSS classes, and widgets.
   */
  public extractSectionCandidates(elements: ElementorElement[]): SectionCandidate[] {
    const candidates: SectionCandidate[] = [];

    const cleanHtmlForInspection = (html: string) => {
      return html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    };

    const traverse = (items: ElementorElement[], depth = 0) => {
      if (!Array.isArray(items)) return;

      for (const item of items) {
        if (!item || !item.id) continue;

        const isSection =
          item.elType === 'section' ||
          item.elType === 'container' ||
          (depth === 0 && Array.isArray(item.elements));

        if (isSection) {
          const sid = String(item.id || '');
          if (sid.startsWith('era_scoped_css_') || sid.startsWith('era_responsive_css_')) {
            continue;
          }

          const foundHeadings: string[] = [];
          const widgetTypes: string[] = [];
          const textSamples: string[] = [];
          const innerClasses = new Set<string>();
          const editableSnippets: EditableSnippet[] = [];

          const inspectChildren = (child: ElementorElement) => {
            if (!child) return;
            if (child.widgetType) {
              widgetTypes.push(child.widgetType);
            }
            if (child.settings) {
              const s = child.settings;
              const childId = String(child.id || '');
              const wType = String(child.widgetType || child.elType || '');

              if (typeof s.title === 'string' && s.title.trim()) {
                foundHeadings.push(s.title.trim());
                editableSnippets.push({
                  elementId: childId,
                  widgetType: wType || 'heading',
                  settingKey: 'title',
                  content: s.title.trim(),
                });
              }
              if (typeof s.heading_title === 'string' && s.heading_title.trim()) {
                foundHeadings.push(s.heading_title.trim());
                editableSnippets.push({
                  elementId: childId,
                  widgetType: wType || 'heading',
                  settingKey: 'heading_title',
                  content: s.heading_title.trim(),
                });
              }
              if (typeof s.text === 'string' && s.text.trim()) {
                editableSnippets.push({
                  elementId: childId,
                  widgetType: wType || 'button',
                  settingKey: 'text',
                  content: s.text.trim(),
                });
              }
              if (typeof s._css_classes === 'string' && s._css_classes.trim()) {
                s._css_classes.split(/\s+/).filter(Boolean).forEach((c) => innerClasses.add(c));
              }

              // Extract text and headings from editor
              if (typeof s.editor === 'string' && s.editor.trim()) {
                const clean = cleanHtmlForInspection(s.editor);
                const hMatches = clean.match(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi) || [];
                for (const hm of hMatches) {
                  const ht = hm.replace(/<[^>]+>/g, '').trim();
                  if (ht) foundHeadings.push(ht);
                }
                const textClean = clean.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                if (textClean) textSamples.push(textClean.slice(0, 120));
                editableSnippets.push({
                  elementId: childId,
                  widgetType: wType || 'text-editor',
                  settingKey: 'editor',
                  content: s.editor.trim().slice(0, 3000),
                });
              }

              // Extract text, classes, headings, and form/button identifiers from HTML widgets
              if (typeof s.html === 'string' && s.html.trim()) {
                const clean = cleanHtmlForInspection(s.html);

                // Headings
                const hMatches = clean.match(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi) || [];
                for (const hm of hMatches) {
                  const ht = hm.replace(/<[^>]+>/g, '').trim();
                  if (ht) foundHeadings.push(ht);
                }

                // CSS Classes
                const cMatches = clean.match(/class=["']([^"']+)["']/gi) || [];
                for (const cm of cMatches) {
                  const clsList = cm.replace(/^class=["']/, '').replace(/["']$/, '').split(/\s+/);
                  for (const c of clsList) {
                    if (c && !c.startsWith('elementor-') && c.length > 2) {
                      innerClasses.add(c);
                    }
                  }
                }

                // Form placeholders
                const phMatches = clean.match(/placeholder=["']([^"']+)["']/gi) || [];
                for (const ph of phMatches) {
                  const phText = ph.replace(/^placeholder=["']/, '').replace(/["']$/, '').trim();
                  if (phText) textSamples.push(phText);
                }

                const textClean = clean.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                if (textClean) textSamples.push(textClean.slice(0, 160));
                editableSnippets.push({
                  elementId: childId,
                  widgetType: wType || 'html',
                  settingKey: 'html',
                  content: s.html.trim().slice(0, 4000),
                });
              }

              // Also inspect any additional text-like settings
              for (const [key, val] of Object.entries(s)) {
                if (
                  typeof val === 'string' &&
                  val.trim().length > 0 &&
                  !['title', 'heading_title', 'text', 'editor', 'html', '_css_classes', '_element_id'].includes(key) &&
                  (key.includes('title') || key.includes('text') || key.includes('desc') || key.includes('label') || key.includes('content') || key.includes('caption'))
                ) {
                  editableSnippets.push({
                    elementId: childId,
                    widgetType: wType || 'widget',
                    settingKey: key,
                    content: val.trim().slice(0, 4000),
                  });
                }
              }
            }
            if (Array.isArray(child.elements)) {
              for (const grandChild of child.elements) {
                inspectChildren(grandChild);
              }
            }
          };

          inspectChildren(item);

          const uniqueHeadings = Array.from(new Set(foundHeadings));
          const primaryHeading = uniqueHeadings[0] || `Section ${item.id}`;
          const subHeadings = uniqueHeadings.slice(1, 6);

          candidates.push({
            id: String(item.id),
            heading: primaryHeading,
            subHeadings,
            innerClasses: Array.from(innerClasses).slice(0, 15),
            widgetTypes: Array.from(new Set(widgetTypes)).slice(0, 8),
            sampleText: textSamples.slice(0, 4).join(' | ').slice(0, 300),
            editableSnippets: editableSnippets.slice(0, 50),
          });
        }

        if (Array.isArray(item.elements)) {
          traverse(item.elements, depth + 1);
        }
      }
    };

    traverse(elements);
    return candidates;
  }

  /**
   * Match a screenshot and/or user message to a specific Elementor section and generate a scoped fix.
   */
  public async matchAndProposeFix(request: SectionMatchRequest): Promise<SectionMatchResult> {
    let elementorData = request.elementorData;

    // Fetch from bridge if not provided
    if (!elementorData && !isNaN(Number(request.pageId))) {
      try {
        const bridge = new EraBridgeClient(this.config);
        const wpPage = await bridge.getPage(Number(request.pageId));
        if (wpPage && wpPage._elementor_data) {
          elementorData = wpPage._elementor_data;
        }
      } catch (e) {
        // bridge fallback
      }
    }

    if (!elementorData || !Array.isArray(elementorData) || elementorData.length === 0) {
      throw new Error(`Could not load Elementor structure for Page ID ${request.pageId}`);
    }

    const candidates = this.extractSectionCandidates(elementorData);
    if (candidates.length === 0) {
      throw new Error(`No sections found in Elementor data for Page ID ${request.pageId}`);
    }

    // If client is available and image or message exists, use Vision LLM
    if (this.client && !this.config.offline && (request.imageBase64 || request.message)) {
      try {
        return await this.llmMatch(request, candidates);
      } catch (err: any) {
        console.warn(`[SectionMatcher] LLM matching failed, falling back to heuristics: ${err.message}`);
      }
    }

    // Deterministic Heuristic Fallback
    return this.heuristicMatch(request, candidates);
  }

  private async llmMatch(request: SectionMatchRequest, candidates: SectionCandidate[]): Promise<SectionMatchResult> {
    if (!this.client) throw new Error('OpenAI client not initialized');

    const cleanBase64 = request.imageBase64
      ? request.imageBase64.replace(/^data:image\/[a-z]+;base64,/, '')
      : null;

    const userParts: any[] = [];

    if (cleanBase64) {
      userParts.push({
        type: 'image_url',
        image_url: {
          url: `data:image/png;base64,${cleanBase64}`,
          detail: 'high',
        },
      });
      userParts.push({
        type: 'text',
        text: 'Above is the screenshot of the broken section that needs responsive fixing or layout customization.',
      });
    }

    const userPrompt = `
User Instruction: "${request.message || 'Make this section responsive and fix all visual defects.'}"

Candidate Elementor Sections in this Page:
${JSON.stringify(candidates, null, 2)}

Instructions:
1. Identify which candidate section matches the screenshot and/or user instruction (by its exact "id").
2. Determine what type of change is requested:
   - "content": User wants to change, replace, or update text, headings, button text, paragraphs, or copy (e.g., "change this text from X to Y", "change title to Z").
   - "style": User wants responsive fixes, layout changes, flex alignment, positioning (left/right/center), colors, spacing.
   - "both": User wants BOTH text/content changes AND layout/style changes.
3. FOR CONTENT CHANGES ("contentPatches"):
   - Inspect the matched candidate's "editableSnippets" to locate the exact text the user wants to change.
   - Output exact search and replace in "contentPatches":
     [
       {
         "elementId": "exact_widget_id_from_editableSnippets",
         "settingKey": "html" (or "title", "editor", "text"),
         "search": "Exact text substring currently in the element",
         "replace": "Exact new replacement text"
       }
     ]
   - CRITICAL CONTENT RULES:
     - "search" MUST match the text currently in the element verbatim.
     - NEVER use CSS pseudo-elements (e.g. ::before { content: "..." }) or display: none to replace or hide text!
     - Content changes MUST strictly be executed via "contentPatches".
     - All other text, paragraphs, lists, forms, and markup in the element must remain 100% intact.
4. FOR STYLING CHANGES ("extraCssRules"):
   - Scope every selector with:
     .elementor-element-[matchedId] [childSelector], [data-id="[matchedId]"] [childSelector]
   - NEVER use HTML ID selectors like #[matchedId] (Elementor renders class .elementor-element-[id] and data-id="[id]").
   - ALWAYS target the actual semantic class names present in the matched candidate's "innerClasses" (e.g. use .fixed-header, .header-nav, .header-logo, .hero-section, .hero-content, .hero-inquiry-card; do NOT only target the outermost wrapper).
   - For Headers & Navigation:
     - Enforce fluid full-width containment:
       .elementor-element-[matchedId] [headerClass], [data-id="[matchedId]"] [headerClass] {
         width: 100% !important;
         max-width: 100% !important;
         box-sizing: border-box !important;
       }
     - For Desktop viewports (min-width: 900px):
       @media (min-width: 900px) {
         .elementor-element-[matchedId] [headerClass], [data-id="[matchedId]"] [headerClass] {
           display: flex !important;
           flex-direction: row !important;
           justify-content: space-between !important;
           align-items: center !important;
         }
         .elementor-element-[matchedId] [navClass], [data-id="[matchedId]"] [navClass] {
           display: flex !important;
           gap: 24px !important;
           align-items: center !important;
           width: auto !important;
         }
       }
     - For mobile/tablet (@media (max-width: 767px)), wrap nav links and stack header elements vertically:
       @media (max-width: 767px) {
         .elementor-element-[matchedId] [navClass], [data-id="[matchedId]"] [navClass] {
           display: flex !important;
           flex-wrap: wrap !important;
           gap: 8px !important;
           justify-content: center !important;
           width: 100% !important;
         }
       }
   - If the user instruction is to move, position, or align an element (e.g., "move to right side", "move to left", "center", "reorder columns"):
     - Wrap Desktop/Row styling inside a media query:
       @media (min-width: 900px) {
         .elementor-element-[matchedId] [containerClass],
         [data-id="[matchedId]"] [containerClass] {
           display: flex !important;
           flex-direction: row !important;
           justify-content: space-between !important;
           align-items: flex-start !important;
         }
         .elementor-element-[matchedId] [targetElementClass],
         [data-id="[matchedId]"] [targetElementClass] {
           margin-left: auto !important;
           margin-right: 0 !important;
           align-self: flex-start !important;
         }
       }
     - For Mobile/Tablet viewports (@media (max-width: 899px)):
       Stack the container vertically so elements don't get squashed:
       @media (max-width: 899px) {
         .elementor-element-[matchedId] [containerClass],
         [data-id="[matchedId]"] [containerClass] {
           display: flex !important;
           flex-direction: column !important;
           gap: 24px !important;
         }
         .elementor-element-[matchedId] [targetElementClass],
         [data-id="[matchedId]"] [targetElementClass] {
           width: 100% !important;
           max-width: 100% !important;
           margin-left: 0 !important;
           margin-right: 0 !important;
           align-self: center !important;
         }
       }
   - Use !important on all property declarations to ensure they override Elementor defaults, universal containment, or inline styles.
   - If the user ONLY asked for text/content changes (no layout/style changes requested), leave "extraCssRules" empty ("").
   - Output pure CSS without markdown code fences in "extraCssRules".

Respond strictly with valid JSON:
{
  "matchedElementId": "exact_id_from_candidates",
  "sectionTitle": "Section Headline",
  "actionType": "content" | "style" | "both",
  "detectedIssues": ["issue or request description"],
  "contentPatches": [
    {
      "elementId": "widget_id",
      "settingKey": "html",
      "search": "Existing text",
      "replace": "New text"
    }
  ],
  "explanation": "Friendly explanation of what was updated.",
  "confidence": 0.95,
  "extraCssRules": ""
}
`;

    userParts.push({ type: 'text', text: userPrompt });

    const completion = await this.client.chat.completions.create({
      model: this.config.openaiModel || 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'You are an Elementor Responsive Layout and Content Architect. You match user requests and screenshots to exact Elementor sections, surgically edit content copy via contentPatches without removing other text, and produce clean isolated scoped responsive fixes. Output strictly valid JSON.',
        },
        {
          role: 'user',
          content: userParts,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    });

    const raw = completion.choices[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);

    const matchedId = parsed.matchedElementId || candidates[0].id;
    const matchedCandidate = candidates.find((c) => c.id === matchedId) || candidates[0];
    const sectionTitle = parsed.sectionTitle || matchedCandidate.heading;
    const contentPatches: ContentPatch[] = Array.isArray(parsed.contentPatches)
      ? parsed.contentPatches.filter((p: any) => p && typeof p.search === 'string' && typeof p.replace === 'string')
      : [];
    const actionType: 'content' | 'style' | 'both' = parsed.actionType || (contentPatches.length ? 'content' : 'style');
    const detectedIssues = Array.isArray(parsed.detectedIssues) && parsed.detectedIssues.length > 0
      ? parsed.detectedIssues
      : [contentPatches.length ? 'Content copy update' : 'Layout containment breach'];
    const explanation = parsed.explanation || (contentPatches.length
      ? `Updated content in ${sectionTitle}.`
      : `Optimized ${sectionTitle} with fluid container containment and normalized mobile spacing.`);

    const isFormOrCard =
      matchedCandidate.widgetTypes.some((w) => w.includes('form') || w.includes('inquiry') || w.includes('button')) ||
      (matchedCandidate.innerClasses || []).some((c) => c.includes('card') || c.includes('inquiry') || c.includes('form'));

    let scopedCss = '';
    const hasExtraCss = typeof parsed.extraCssRules === 'string' && parsed.extraCssRules.trim().length > 0;
    if (hasExtraCss) {
      scopedCss = generateScopedSectionCss({
        elementId: matchedCandidate.id,
        sectionTitle,
        extraRules: parsed.extraCssRules,
        isFormOrCard,
      });
    } else if (actionType === 'style' || contentPatches.length === 0) {
      scopedCss = generateScopedSectionCss({
        elementId: matchedCandidate.id,
        sectionTitle,
        extraRules: '',
        isFormOrCard,
      });
    }

    return {
      matchedElementId: matchedCandidate.id,
      sectionTitle,
      actionType,
      detectedIssues,
      explanation,
      scopedCss,
      contentPatches,
      confidence: parsed.confidence || 0.95,
    };
  }

  private heuristicMatch(request: SectionMatchRequest, candidates: SectionCandidate[]): SectionMatchResult {
    const rawMsg = (request.message || '').trim();
    const query = rawMsg.toLowerCase();

    // 1. Detect user intention to change or replace text
    let detectedSearchText = '';
    let detectedReplaceText = '';

    // Regex 1: "change [this] text/title/heading from X to Y" or "update text from X to Y"
    const fromToMatch = rawMsg.match(
      /(?:change|update|replace|swap|modify)(?:\s+this)?(?:\s+(?:text|title|heading|header|subheading|copy|paragraph|button|label))?\s+from\s+["'“‘]?([^"'“”\n]+?)["'”’]?\s+to\s+["'“‘]?([^"'“”\n]+?)["'”’]?(?:\s*[\.\?!]?\s*$)/i
    );

    // Regex 2: "replace X with Y"
    const replaceWithMatch = !fromToMatch
      ? rawMsg.match(/(?:replace|swap)\s+["'“‘]?([^"'“”\n]+?)["'”’]?\s+with\s+["'“‘]?([^"'“”\n]+?)["'”’]?(?:\s*[\.\?!]?\s*$)/i)
      : null;

    // Regex 3: "change X to Y" (where X is not a styling keyword)
    const changeToMatch = !fromToMatch && !replaceWithMatch
      ? rawMsg.match(/(?:change|update|modify)\s+["'“‘]?([^"'“”\n]+?)["'”’]?\s+to\s+["'“‘]?([^"'“”\n]+?)["'”’]?(?:\s*[\.\?!]?\s*$)/i)
      : null;

    if (fromToMatch) {
      detectedSearchText = fromToMatch[1].trim().replace(/^["'“‘]+|["'”’]+$/g, '').trim();
      detectedReplaceText = fromToMatch[2].trim().replace(/^["'“‘]+|["'”’]+$/g, '').trim();
    } else if (replaceWithMatch) {
      detectedSearchText = replaceWithMatch[1].trim().replace(/^["'“‘]+|["'”’]+$/g, '').trim();
      detectedReplaceText = replaceWithMatch[2].trim().replace(/^["'“‘]+|["'”’]+$/g, '').trim();
    } else if (changeToMatch) {
      const candidateSearch = changeToMatch[1].trim().replace(/^["'“‘]+|["'”’]+$/g, '').trim();
      if (!['layout', 'view', 'section', 'mode', 'color', 'background', 'style'].includes(candidateSearch.toLowerCase())) {
        detectedSearchText = candidateSearch;
        detectedReplaceText = changeToMatch[2].trim().replace(/^["'“‘]+|["'”’]+$/g, '').trim();
      }
    }

    let matchedSnippetForContent: EditableSnippet | null = null;
    let matchedCandForContent: SectionCandidate | null = null;
    let exactSearchString = detectedSearchText;

    if (detectedSearchText) {
      // Step A: Search for exact case-sensitive match in candidate snippets
      for (const cand of candidates) {
        if (!cand.editableSnippets) continue;
        for (const snip of cand.editableSnippets) {
          if (snip.content.includes(detectedSearchText)) {
            matchedCandForContent = cand;
            matchedSnippetForContent = snip;
            exactSearchString = detectedSearchText;
            break;
          }
        }
        if (matchedCandForContent) break;
      }

      // Step B: Search case-insensitively across candidate snippets
      if (!matchedCandForContent) {
        const searchLower = detectedSearchText.toLowerCase();
        for (const cand of candidates) {
          if (!cand.editableSnippets) continue;
          for (const snip of cand.editableSnippets) {
            const idx = snip.content.toLowerCase().indexOf(searchLower);
            if (idx !== -1) {
              matchedCandForContent = cand;
              matchedSnippetForContent = snip;
              exactSearchString = snip.content.slice(idx, idx + detectedSearchText.length);
              break;
            }
          }
          if (matchedCandForContent) break;
        }
      }

      // Step C: Fallback punctuation-normalized search
      if (!matchedCandForContent) {
        const searchClean = detectedSearchText.replace(/[^\w\s]/g, '').trim().toLowerCase();
        for (const cand of candidates) {
          if (!cand.editableSnippets) continue;
          for (const snip of cand.editableSnippets) {
            const snipClean = snip.content.replace(/[^\w\s]/g, ' ').toLowerCase();
            if (snipClean.includes(searchClean)) {
              matchedCandForContent = cand;
              matchedSnippetForContent = snip;
              break;
            }
          }
          if (matchedCandForContent) break;
        }
      }
    }

    // 2. Score candidate sections for layout/keyword match
    let bestMatch = matchedCandForContent || candidates[0];
    let highestScore = matchedCandForContent ? 100 : 0;

    for (const cand of candidates) {
      if (cand === matchedCandForContent) continue;
      let score = 0;
      const headingLower = cand.heading.toLowerCase();
      const textLower = cand.sampleText.toLowerCase();
      const subHeadingsText = (cand.subHeadings || []).join(' ').toLowerCase();
      const classesText = (cand.innerClasses || []).join(' ').toLowerCase();

      // Form & inquiry queries
      if (query.includes('form') || query.includes('proposal') || query.includes('inquiry') || query.includes('contact') || query.includes('briefing') || query.includes('rfq')) {
        if (cand.widgetTypes.some((w) => w.includes('form') || w.includes('inquiry'))) score += 10;
        if (classesText.includes('inquiry') || classesText.includes('form') || classesText.includes('card')) score += 12;
        if (subHeadingsText.includes('briefing') || subHeadingsText.includes('inquiry') || subHeadingsText.includes('rfq')) score += 10;
        if (headingLower.includes('proposal') || headingLower.includes('practice') || headingLower.includes('contact')) score += 8;
      }
      if (query.includes('faq') || query.includes('question')) {
        if (headingLower.includes('faq') || headingLower.includes('question') || cand.widgetTypes.includes('accordion')) score += 15;
      }
      if (query.includes('header') || query.includes('nav') || query.includes('menu') || query.includes('logo')) {
        if (classesText.includes('header') || cand.id.includes('header')) score += 20;
        if (classesText.includes('nav') || classesText.includes('menu')) score += 15;
      }
      if (query.includes('hero') || query.includes('intro')) {
        if (classesText.includes('hero') || cand.id.includes('hero') || cand === candidates[1]) score += 18;
      }
      if (query.includes('service')) {
        if (headingLower.includes('service') || cand.id.includes('service')) score += 12;
      }

      // Partial word match across all extracted strings
      const words = query.split(/\s+/).filter((w) => w.length > 3);
      for (const w of words) {
        if (headingLower.includes(w)) score += 6;
        if (subHeadingsText.includes(w)) score += 6;
        if (classesText.includes(w)) score += 5;
        if (textLower.includes(w)) score += 3;
      }

      if (score > highestScore) {
        highestScore = score;
        bestMatch = cand;
      }
    }

    const sectionTitle = bestMatch.heading;
    const isForm =
      bestMatch.widgetTypes.some((w) => w.includes('form') || w.includes('inquiry') || w.includes('button')) ||
      (bestMatch.innerClasses || []).some((c) => c.includes('card') || c.includes('inquiry') || c.includes('form'));

    // Check if layout or styling changes were requested
    const isLayoutRequested =
      query.includes('right') ||
      query.includes('left') ||
      query.includes('center') ||
      query.includes('responsive') ||
      query.includes('mobile') ||
      query.includes('tablet') ||
      query.includes('align') ||
      query.includes('overflow') ||
      query.includes('stack') ||
      query.includes('padding') ||
      query.includes('margin') ||
      query.includes('size');

    const contentPatches: ContentPatch[] = [];
    if (detectedSearchText && detectedReplaceText) {
      contentPatches.push({
        elementId: matchedSnippetForContent ? matchedSnippetForContent.elementId : undefined,
        settingKey: matchedSnippetForContent ? matchedSnippetForContent.settingKey : undefined,
        search: exactSearchString,
        replace: detectedReplaceText,
      });
    }

    const actionType: 'content' | 'style' | 'both' =
      contentPatches.length > 0 && isLayoutRequested
        ? 'both'
        : contentPatches.length > 0
        ? 'content'
        : 'style';

    let extraRules = '';

    if (isLayoutRequested || actionType !== 'content') {
      if (bestMatch.id.includes('header') || (bestMatch.innerClasses || []).some((c) => c.includes('header'))) {
        const headerClass = (bestMatch.innerClasses || []).find((c) => c.includes('header')) || 'fixed-header';
        const navClass = (bestMatch.innerClasses || []).find((c) => c.includes('nav')) || 'header-nav';
        extraRules += `
.elementor-element-${bestMatch.id} .${headerClass},
[data-id="${bestMatch.id}"] .${headerClass} {
  max-width: 100% !important;
  width: 100% !important;
  box-sizing: border-box !important;
  display: flex !important;
  justify-content: space-between !important;
  align-items: center !important;
}
@media (max-width: 767px) {
  .elementor-element-${bestMatch.id} .${headerClass},
  [data-id="${bestMatch.id}"] .${headerClass} {
    flex-direction: column !important;
    gap: 12px !important;
    height: auto !important;
    padding: 16px 20px !important;
  }
  .elementor-element-${bestMatch.id} .${navClass},
  [data-id="${bestMatch.id}"] .${navClass} {
    display: flex !important;
    flex-wrap: wrap !important;
    gap: 8px !important;
    justify-content: center !important;
  }
}
`;
      }

      if (query.includes('right')) {
        const targetCardClass = (bestMatch.innerClasses || []).find((c) => c.includes('card') || c.includes('inquiry') || c.includes('form'));
        if (targetCardClass) {
          extraRules += `
@media (min-width: 900px) {
  .elementor-element-${bestMatch.id} [class*="section"],
  [data-id="${bestMatch.id}"] [class*="section"],
  .elementor-element-${bestMatch.id} > .elementor-container,
  [data-id="${bestMatch.id}"] > .elementor-container {
    display: flex !important;
    flex-direction: row !important;
    justify-content: space-between !important;
    align-items: flex-start !important;
  }
  .elementor-element-${bestMatch.id} .${targetCardClass},
  [data-id="${bestMatch.id}"] .${targetCardClass} {
    margin-left: auto !important;
    margin-right: 0 !important;
    align-self: flex-start !important;
  }
}
@media (max-width: 899px) {
  .elementor-element-${bestMatch.id} .${targetCardClass},
  [data-id="${bestMatch.id}"] .${targetCardClass} {
    margin-left: auto !important;
    margin-right: 0 !important;
    align-self: flex-end !important;
  }
}
`;
        }
      }
    }

    let scopedCss = '';
    if (actionType !== 'content' && (isLayoutRequested || contentPatches.length === 0)) {
      scopedCss = generateScopedSectionCss({
        elementId: bestMatch.id,
        sectionTitle,
        extraRules,
        isFormOrCard: isForm,
      });
    }

    const detectedIssues: string[] = [];
    if (contentPatches.length > 0) {
      detectedIssues.push(`Text copy update: "${exactSearchString}" ➔ "${detectedReplaceText}"`);
    }
    if (actionType !== 'content') {
      detectedIssues.push('Container content overflow & bleed beyond styled boundaries');
      detectedIssues.push('Responsive viewport stacking misalignment on tablet/mobile');
    }

    let explanation = '';
    if (actionType === 'content') {
      explanation = `Targeted section "${sectionTitle}" (ID: ${bestMatch.id}). Surgically updating text copy from "${exactSearchString}" to "${detectedReplaceText}". All other text, paragraphs, contact info, forms, and layout remain 100% intact.`;
    } else if (actionType === 'both') {
      explanation = `Targeted section "${sectionTitle}" (ID: ${bestMatch.id}). Updating text copy to "${detectedReplaceText}" and applying responsive layout alignment.`;
    } else {
      explanation = `Targeted section "${sectionTitle}" (ID: ${bestMatch.id}). Enforced fluid containment, normalized box-sizing, and applied scoped layout styling.`;
    }

    return {
      matchedElementId: bestMatch.id,
      sectionTitle,
      actionType,
      detectedIssues,
      explanation,
      scopedCss,
      contentPatches,
      confidence: matchedCandForContent ? 0.98 : highestScore > 0 ? 0.85 : 0.6,
    };
  }
}
