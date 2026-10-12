import { AuditReport } from '../audit/types.js';
import { ElementorElement } from './tree.js';

export interface TrimmedPayload {
  elements: ElementorElement[];
  estimatedTokens: number;
  isSectionSplit: boolean;
  sections?: ElementorElement[][];
}

/**
 * Helper to truncate long strings (like HTML in 'editor' or 'html' widgets) to 300 characters.
 */
function truncateSettings(settings: Record<string, any> = {}): Record<string, any> {
  const truncated: Record<string, any> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (typeof value === 'string' && value.length > 300) {
      truncated[key] = value.substring(0, 300) + '... [truncated]';
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      truncated[key] = truncateSettings(value);
    } else {
      truncated[key] = value;
    }
  }
  return truncated;
}

/**
 * Find ancestors chain and relevant nodes for targeted element IDs.
 */
function buildTrimmedNode(
  node: ElementorElement,
  targetIds: Set<string>
): { node: ElementorElement | null; isMatched: boolean } {
  const isDirectTarget = targetIds.has(node.id);
  const filteredChildren: ElementorElement[] = [];
  let childMatched = false;

  if (Array.isArray(node.elements)) {
    for (const child of node.elements) {
      const childRes = buildTrimmedNode(child, targetIds);
      if (childRes.node) {
        filteredChildren.push(childRes.node);
      }
      if (childRes.isMatched) {
        childMatched = true;
      }
    }
  }

  // If node itself is target, or any of its descendants matched
  if (isDirectTarget || childMatched) {
    return {
      isMatched: true,
      node: {
        id: node.id,
        elType: node.elType,
        widgetType: node.widgetType,
        isInner: node.isInner,
        settings: truncateSettings(node.settings || {}),
        elements: filteredChildren,
      },
    };
  }

  return { node: null, isMatched: false };
}

/**
 * Estimate token count from JSON string (approx 4 chars per token).
 */
export function estimateTokens(obj: any): number {
  const str = JSON.stringify(obj);
  return Math.ceil(str.length / 4);
}

/**
 * Trims the Elementor document tree to only include elements with issues, their ancestors,
 * and direct relevant context, compacting HTML fields to stay within token limits.
 */
export function trimElementorPayload(
  elements: ElementorElement[],
  auditReport: AuditReport,
  maxTokens: number = 12000
): TrimmedPayload {
  const patchableTargetIds = new Set<string>();

  for (const [elId, group] of Object.entries(auditReport.issuesByElementId)) {
    if (elId === 'unknown_element' || !elId) continue;
    const issues = Array.isArray(group) ? group : group.issues || [];
    // Include elements that have at least one patchable issue (or all issues if none explicitly marked)
    if (issues.some((iss) => iss.patchable !== false)) {
      patchableTargetIds.add(elId);
    }
  }

  // If no patchable IDs found, fallback to all non-unknown element IDs in report
  if (patchableTargetIds.size === 0) {
    for (const elId of Object.keys(auditReport.issuesByElementId)) {
      if (elId !== 'unknown_element' && elId) {
        patchableTargetIds.add(elId);
      }
    }
  }

  const trimmedList: ElementorElement[] = [];
  for (const rootEl of elements) {
    const res = buildTrimmedNode(rootEl, patchableTargetIds);
    if (res.node) {
      trimmedList.push(res.node);
    }
  }

  let finalElements = trimmedList.length > 0 ? trimmedList : elements.map((el) => ({
    id: el.id,
    elType: el.elType,
    widgetType: el.widgetType,
    settings: truncateSettings(el.settings || {}),
    elements: el.elements,
  }));

  const estimated = estimateTokens(finalElements);

  if (estimated > maxTokens) {
    // If oversized, split by top-level section
    const sections: ElementorElement[][] = finalElements.map((section) => [section]);
    return {
      elements: finalElements,
      estimatedTokens: estimated,
      isSectionSplit: true,
      sections,
    };
  }

  return {
    elements: finalElements,
    estimatedTokens: estimated,
    isSectionSplit: false,
  };
}
