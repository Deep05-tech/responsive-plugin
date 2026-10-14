import OpenAI from 'openai';
import { ElementorElement } from '../patch/tree.js';
import { EraConfig, loadConfig } from '../config/index.js';
import { EraBridgeClient } from '../bridge/client.js';
import { generateScopedSectionCss } from '../patch/scoped-styler.js';
import { ContentPatch, EditableSnippet, SectionCandidate, SectionMatcher } from './section-matcher.js';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface PageContext {
  viewport?: { width: number; height: number };
  activePageId?: number | string;
  activeScopedCss?: string[];
  semanticClasses?: string[];
  recentBackups?: Array<{ key: string; timestamp?: number; date_gmt?: string }>;
  lastAppliedAction?: any;
}

export interface ChatAgentRequest {
  pageId: number | string;
  message: string;
  history?: ChatMessage[];
  imageBase64?: string;
  elementorData?: ElementorElement[];
  pageContext?: PageContext;
}

export interface ProposedAction {
  targetSectionId?: string;
  sectionTitle?: string;
  actionType: 'content' | 'style' | 'both' | 'restore';
  targetBackupKey?: string;
  actionSummary: string;
  detectedIssues?: string[];
  contentPatches?: ContentPatch[];
  scopedCss?: string;
  diffPreview?: {
    textDiffs?: Array<{ search: string; replace: string }>;
    cssHighlights?: string[];
  };
}

export interface ChatAgentResponse {
  reply: string;
  hasAction: boolean;
  action?: ProposedAction;
  targetBackupKey?: string;
  // Backward compatibility fields for bridge:
  matchedElementId?: string;
  sectionTitle?: string;
  actionType?: 'content' | 'style' | 'both' | 'restore';
  detectedIssues?: string[];
  explanation?: string;
  scopedCss?: string;
  contentPatches?: ContentPatch[];
  confidence?: number;
}

export class ChatAgent {
  private client: OpenAI | null = null;
  private config: EraConfig;
  private sectionMatcher: SectionMatcher;

  constructor(config?: EraConfig) {
    this.config = config || loadConfig();
    this.sectionMatcher = new SectionMatcher(this.config);
    if (this.config.openaiApiKey && !this.config.offline) {
      this.client = new OpenAI({ apiKey: this.config.openaiApiKey });
    }
  }

  /**
   * Build a rich structured overview of the entire Elementor page including sections,
   * widgets, content snippets, and CSS classes for LLM prompt context.
   */
  public buildFullPageContext(elements: ElementorElement[]): {
    summary: string;
    sections: Array<{
      id: string;
      title: string;
      classes: string[];
      widgets: Array<{ id: string; type: string; title?: string; textSnippet?: string; classes?: string }>;
    }>;
    candidates: SectionCandidate[];
  } {
    const candidates = this.sectionMatcher.extractSectionCandidates(elements);
    const sections: Array<{
      id: string;
      title: string;
      classes: string[];
      widgets: Array<{ id: string; type: string; title?: string; textSnippet?: string; classes?: string }>;
    }> = [];

    const traverse = (items: ElementorElement[]) => {
      if (!Array.isArray(items)) return;
      for (const item of items) {
        if (!item || !item.id) continue;
        const sid = String(item.id);
        if (sid.startsWith('era_scoped_css_') || sid.startsWith('era_responsive_css_')) continue;

        if (item.elType === 'section' || item.elType === 'container') {
          const widgetsList: Array<{ id: string; type: string; title?: string; textSnippet?: string; classes?: string }> = [];
          const sectionClasses: string[] = [];

          if (item.settings && typeof item.settings._css_classes === 'string') {
            sectionClasses.push(...item.settings._css_classes.split(/\s+/).filter(Boolean));
          }

          const inspectWidgets = (child: ElementorElement) => {
            if (!child) return;
            if (child.widgetType || child.elType === 'widget') {
              const wid = String(child.id);
              const wtype = String(child.widgetType || child.elType || 'widget');
              const s = child.settings || {};
              let title = s.title || s.heading_title || '';
              let textSnippet = '';

              if (typeof s.editor === 'string') {
                textSnippet = s.editor.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
              } else if (typeof s.html === 'string') {
                textSnippet = s.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
              } else if (typeof s.text === 'string') {
                textSnippet = s.text.trim().slice(0, 100);
              }

              let classes = '';
              if (typeof s._css_classes === 'string') classes = s._css_classes;

              widgetsList.push({
                id: wid,
                type: wtype,
                title: typeof title === 'string' ? title.slice(0, 80) : undefined,
                textSnippet: textSnippet || undefined,
                classes: classes || undefined,
              });
            }
            if (Array.isArray(child.elements)) {
              for (const grand of child.elements) inspectWidgets(grand);
            }
          };

          if (Array.isArray(item.elements)) {
            for (const col of item.elements) inspectWidgets(col);
          }

          const matchedCand = candidates.find((c) => c.id === sid);
          sections.push({
            id: sid,
            title: matchedCand ? matchedCand.heading : `Section ${sid}`,
            classes: Array.from(new Set([...sectionClasses, ...(matchedCand?.innerClasses || [])])),
            widgets: widgetsList,
          });
        }
      }
    };

    traverse(elements);

    let summary = `PAGE STRUCTURE OVERVIEW (${sections.length} Sections):\n`;
    for (const sec of sections) {
      summary += `\n▶ Section ID: "${sec.id}" | Title: "${sec.title}"\n`;
      if (sec.classes.length) summary += `  Classes: ${sec.classes.join(', ')}\n`;
      summary += `  Widgets (${sec.widgets.length}):\n`;
      for (const w of sec.widgets.slice(0, 8)) {
        summary += `    - [${w.type}] (ID: ${w.id}) ${w.title ? `Title: "${w.title}"` : ''} ${w.textSnippet ? `Snippet: "${w.textSnippet}"` : ''} ${w.classes ? `Classes: .${w.classes}` : ''}\n`;
      }
    }

    return { summary, sections, candidates };
  }

  /**
   * Main conversational interface. Handles multi-turn memory, deep page comprehension,
   * CSS styling, content patching, and layout fixes.
   */
  public async handleConversation(request: ChatAgentRequest): Promise<ChatAgentResponse> {
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

    const { summary: pageStructureSummary, sections, candidates } = this.buildFullPageContext(elementorData);

    // If OpenAI client is available, run conversational LLM
    if (this.client && !this.config.offline) {
      try {
        return await this.runLlmConversation(request, pageStructureSummary, candidates);
      } catch (err: any) {
        console.warn(`[ChatAgent] LLM conversational generation failed: ${err.message}. Falling back to deterministic matcher.`);
      }
    }

    // Deterministic fallback
    return this.runDeterministicFallback(request, candidates);
  }

  private async runLlmConversation(
    request: ChatAgentRequest,
    pageStructureSummary: string,
    candidates: SectionCandidate[]
  ): Promise<ChatAgentResponse> {
    if (!this.client) throw new Error('OpenAI client not initialized');

    const backups = request.pageContext?.recentBackups || [];
    let backupsSummary = 'AVAILABLE PAGE BACKUPS / RESTORE POINTS:\n';
    if (backups.length > 0) {
      for (const b of backups) {
        backupsSummary += `- Snapshot Key: "${b.key}" (Date/Time: ${b.date_gmt || (b.timestamp ? new Date(b.timestamp * 1000).toISOString() : 'Unknown')})\n`;
      }
      backupsSummary += `Note: If user asks to undo, revert, or restore previous changes, select the latest snapshot key or the one requested.`;
    } else {
      backupsSummary += 'None currently recorded.';
    }

    const systemPrompt = `You are ERA (Elementor Responsive & Design Architect), a world-class AI frontend engineering pair-programmer embedded directly in the user's WordPress page.
You are talking directly to the user who is editing/reviewing this page.

YOUR CAPABILITIES & ROLE:
1. Deep Comprehension: You have full access to the page structure (Elementor data JSON, section IDs, widgets, classes, and settings). You understand CSS, flexbox, grid, mobile breakpoints, typography, and Elementor data formats.
2. Natural, Smart Communication: Talk just like an expert human coding assistant. Be direct, clear, helpful, and concise. Explain what you're doing, acknowledge feedback, accept corrections, and ask clarifying questions if something is genuinely ambiguous.
3. Universal Execution:
   - When the user asks a question, greets you, or discusses design, converse naturally without forcing an action card (set hasAction: false).
   - When the user requests a change (content/text, CSS styling, colors, alignment, layout, or mobile responsive fix), propose the exact change (set hasAction: true).
   - When the user asks to undo, revert, or restore a previous change:
     - Check the AVAILABLE PAGE BACKUPS provided below.
     - If recent backups exist, set hasAction: true, actionType: "restore", targetBackupKey: [the most relevant/recent backup key], and explain which backup snapshot you are proposing to restore.
     - If no backups are found, explain politely that no automated snapshots were recorded yet on this page.

CRITICAL TECHNICAL RULES FOR ACTIONS (hasAction: true):
1. CONTENT CHANGES ("contentPatches"):
   - When user wants to change, replace, or update text, headings, buttons, or copy:
   - Identify the exact elementId from candidate snippets and widget tree.
   - Output exact search and replace in contentPatches:
     [
       {
         "elementId": "exact_widget_id",
         "settingKey": "html" (or "title", "heading_title", "editor", "text"),
         "search": "verbatim current text substring",
         "replace": "new text substring"
       }
     ]
   - NEVER use CSS pseudo-elements (e.g. ::before { content: "..." }) or display: none to replace or hide text! Sibling paragraphs, forms, and contact points must remain 100% untouched.
2. STYLING CHANGES ("scopedCss"):
   - When user asks for styling (colors, padding, margins, borders, font size, background, alignment, flexbox, responsive stacking):
   - Scope every selector to:
     .elementor-element-[targetSectionId] [childSelector], [data-id="[targetSectionId]"] [childSelector]
   - Target actual semantic classes present in the section (e.g. .bottom-info, .bottom-form-card, .contact-points, .fixed-header, .hero-content).
   - Use media queries:
     - Wrap desktop-only row/flex styles in @media (min-width: 900px) { ... }
     - Wrap mobile/tablet vertical stacking in @media (max-width: 899px) { ... }
   - Use !important on CSS declarations to guarantee override over Elementor defaults.
   - If user ONLY requested content changes, leave scopedCss empty ("").
3. ACTION TYPES:
   - "content": Text/copy updates only.
   - "style": CSS styling or layout updates only.
   - "both": Both text changes AND CSS styling.
   - "restore": Revert/restore page back to a safety backup snapshot.

PAGE CONTEXT:
${pageStructureSummary}

${backupsSummary}

OUTPUT FORMAT:
Respond strictly with valid JSON conforming to this schema:
{
  "reply": "Your conversational response in GitHub-flavored markdown. Explain what you found or what changes you prepared.",
  "hasAction": true | false,
  "action": {
    "targetSectionId": "section_id (optional if restore)",
    "sectionTitle": "Section Title (optional if restore)",
    "actionType": "content" | "style" | "both" | "restore",
    "targetBackupKey": "snapshot_key (required if actionType is restore)",
    "actionSummary": "1-line summary of what will be done",
    "detectedIssues": ["issue or request item"],
    "contentPatches": [
      {
        "elementId": "widget_id",
        "settingKey": "html",
        "search": "Current verbatim text",
        "replace": "New replacement text"
      }
    ],
    "scopedCss": "Clean scoped CSS rules here (or empty string if content-only or restore)"
  }
}
`;

    const messages: any[] = [{ role: 'system', content: systemPrompt }];

    // Append conversation history
    if (Array.isArray(request.history) && request.history.length > 0) {
      const recentHistory = request.history.slice(-12);
      for (const h of recentHistory) {
        if (!h.content) continue;
        const role = h.role === 'assistant' ? 'assistant' : 'user';
        messages.push({ role, content: h.content });
      }
    }

    // Append latest user message with image if attached
    const cleanBase64 = request.imageBase64
      ? request.imageBase64.replace(/^data:image\/[a-z]+;base64,/, '')
      : null;

    if (cleanBase64) {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${cleanBase64}`, detail: 'high' },
          },
          { type: 'text', text: request.message || 'Please review this screenshot and assist.' },
        ],
      });
    } else {
      messages.push({ role: 'user', content: request.message });
    }

    const completion = await this.client.chat.completions.create({
      model: this.config.openaiModel || 'gpt-5.4-mini',
      messages,
      response_format: { type: 'json_object' },
      temperature: 0.15,
    });

    const raw = completion.choices[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);

    const hasAction = Boolean(parsed.hasAction && parsed.action);
    let action: ProposedAction | undefined = undefined;

    if (hasAction && parsed.action) {
      const act = parsed.action;
      const isRestore = act.actionType === 'restore' || Boolean(act.targetBackupKey);

      if (isRestore) {
        const latestKey = (request.pageContext?.recentBackups && request.pageContext.recentBackups[request.pageContext.recentBackups.length - 1]?.key) || '';
        const targetBackupKey = act.targetBackupKey || latestKey;
        action = {
          actionType: 'restore',
          targetBackupKey,
          actionSummary: act.actionSummary || `Restore snapshot ${targetBackupKey}`,
          detectedIssues: ['Revert to previous page state requested'],
          contentPatches: [],
          scopedCss: '',
        };
      } else {
        const targetId = act.targetSectionId || candidates[0].id;
        const matchedCand = candidates.find((c) => c.id === targetId) || candidates[0];
        const sectionTitle = act.sectionTitle || matchedCand.heading;

        const contentPatches: ContentPatch[] = Array.isArray(act.contentPatches)
          ? act.contentPatches.filter((p: any) => p && typeof p.search === 'string' && typeof p.replace === 'string')
          : [];

        const actionType: 'content' | 'style' | 'both' =
          act.actionType || (contentPatches.length && act.scopedCss?.trim() ? 'both' : contentPatches.length ? 'content' : 'style');

        let scopedCss = '';
        if (typeof act.scopedCss === 'string' && act.scopedCss.trim()) {
          const isFormOrCard =
            matchedCand.widgetTypes.some((w) => w.includes('form') || w.includes('inquiry') || w.includes('button')) ||
            (matchedCand.innerClasses || []).some((c) => c.includes('card') || c.includes('inquiry') || c.includes('form'));

          scopedCss = generateScopedSectionCss({
            elementId: matchedCand.id,
            sectionTitle,
            extraRules: act.scopedCss,
            isFormOrCard,
          });
        }

        action = {
          targetSectionId: matchedCand.id,
          sectionTitle,
          actionType,
          actionSummary: act.actionSummary || (actionType === 'content' ? `Update text in ${sectionTitle}` : `Optimize layout in ${sectionTitle}`),
          detectedIssues: Array.isArray(act.detectedIssues) ? act.detectedIssues : [act.actionSummary || 'User requested adjustment'],
          contentPatches,
          scopedCss,
          diffPreview: {
            textDiffs: contentPatches.map((p) => ({ search: p.search, replace: p.replace })),
            cssHighlights: scopedCss ? [scopedCss.slice(0, 150) + '...'] : [],
          },
        };
      }
    }

    const reply = parsed.reply || (hasAction ? action?.actionSummary || 'Changes prepared.' : 'How can I assist you with this page?');

    return {
      reply,
      hasAction,
      action,
      targetBackupKey: action?.targetBackupKey,
      // Backward compatibility fields for bridge
      matchedElementId: action?.targetSectionId,
      sectionTitle: action?.sectionTitle,
      actionType: action?.actionType,
      detectedIssues: action?.detectedIssues || [],
      explanation: reply,
      scopedCss: action?.scopedCss || '',
      contentPatches: action?.contentPatches || [],
      confidence: 0.98,
    };
  }

  private runDeterministicFallback(
    request: ChatAgentRequest,
    candidates: SectionCandidate[]
  ): ChatAgentResponse {
    const rawMsg = (request.message || '').trim().toLowerCase();
    const isGreetingOrQuestion =
      rawMsg === 'hi' ||
      rawMsg === 'hello' ||
      rawMsg === 'hey' ||
      rawMsg.startsWith('how are you') ||
      rawMsg.startsWith('what can you do') ||
      rawMsg.startsWith('help');

    if (isGreetingOrQuestion) {
      return {
        reply: `👋 Hello! I am your **ERA Page Architect**. I have full visibility into all ${candidates.length} sections on this page.\n\nYou can ask me to:\n- 📝 **Change or replace text** in any section\n- 🎨 **Adjust colors, fonts, margins, or CSS styling**\n- 📱 **Fix mobile/tablet responsive stacking & overflow**\n- 🖼️ **Review a section screenshot**\n\nWhat would you like to adjust on this page?`,
        hasAction: false,
      };
    }

    const isUndo = rawMsg.includes('undo') || rawMsg.includes('revert') || rawMsg.includes('restore') || rawMsg.includes('rollback');
    if (isUndo) {
      const backups = request.pageContext?.recentBackups || [];
      if (backups.length > 0) {
        const latest = backups[backups.length - 1];
        const dateStr = latest.date_gmt || (latest.timestamp ? new Date(latest.timestamp * 1000).toLocaleString() : '');
        return {
          reply: `I found a previous backup snapshot for this page from **${dateStr || 'recent save'}** (\`${latest.key}\`).\n\nClick the button below to revert the page back to this snapshot.`,
          hasAction: true,
          actionType: 'restore',
          targetBackupKey: latest.key,
          action: {
            actionType: 'restore',
            targetBackupKey: latest.key,
            actionSummary: `Restore snapshot ${latest.key}`,
            detectedIssues: ['Revert to previous page state requested'],
            contentPatches: [],
            scopedCss: '',
          },
          explanation: `Revert page to snapshot ${latest.key}`,
          detectedIssues: ['Revert to previous page state requested'],
          contentPatches: [],
          scopedCss: '',
          confidence: 1.0,
        };
      } else {
        return {
          reply: `I checked the page history, but there are no automated backups recorded yet for this page to revert to.`,
          hasAction: false,
        };
      }
    }

    const matchResult = this.sectionMatcher['heuristicMatch'](request, candidates);

    return {
      reply: matchResult.explanation,
      hasAction: true,
      action: {
        targetSectionId: matchResult.matchedElementId,
        sectionTitle: matchResult.sectionTitle,
        actionType: matchResult.actionType || 'style',
        actionSummary: matchResult.explanation,
        detectedIssues: matchResult.detectedIssues,
        contentPatches: matchResult.contentPatches,
        scopedCss: matchResult.scopedCss,
        diffPreview: {
          textDiffs: (matchResult.contentPatches || []).map((p) => ({ search: p.search, replace: p.replace })),
        },
      },
      matchedElementId: matchResult.matchedElementId,
      sectionTitle: matchResult.sectionTitle,
      actionType: matchResult.actionType,
      detectedIssues: matchResult.detectedIssues,
      explanation: matchResult.explanation,
      scopedCss: matchResult.scopedCss,
      contentPatches: matchResult.contentPatches,
      confidence: matchResult.confidence,
    };
  }
}
