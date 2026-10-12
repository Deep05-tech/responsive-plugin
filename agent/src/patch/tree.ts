export interface ElementorElement {
  id: string;
  elType: string;
  widgetType?: string;
  isInner?: boolean;
  settings?: Record<string, any>;
  elements?: ElementorElement[];
  [key: string]: any;
}

/**
 * Recursively search for an element by ID in an Elementor elements tree.
 */
export function findElementById(
  elements: ElementorElement[],
  id: string
): ElementorElement | null {
  if (!elements || !Array.isArray(elements) || !id) return null;

  for (const el of elements) {
    if (el && el.id === id) {
      return el;
    }
    if (el && Array.isArray(el.elements) && el.elements.length > 0) {
      const found = findElementById(el.elements, id);
      if (found) return found;
    }
  }

  return null;
}

/**
 * Get elType of an element by ID.
 */
export function getElementType(
  elements: ElementorElement[],
  id: string
): string | null {
  const el = findElementById(elements, id);
  return el ? el.elType : null;
}

/**
 * Find the ancestor path (array of elements from root down to the target node) for a given ID.
 */
export function findAncestorsPath(
  elements: ElementorElement[],
  id: string
): ElementorElement[] | null {
  if (!elements || !Array.isArray(elements) || !id) return null;

  for (const el of elements) {
    if (el && el.id === id) {
      return [el];
    }
    if (el && Array.isArray(el.elements) && el.elements.length > 0) {
      const subPath = findAncestorsPath(el.elements, id);
      if (subPath) {
        return [el, ...subPath];
      }
    }
  }

  return null;
}

/**
 * Find the nearest common ancestor for a list of element IDs.
 */
export function findNearestCommonAncestor(
  elements: ElementorElement[],
  elementIds: string[]
): ElementorElement | null {
  const cleanIds = elementIds.filter((id) => id && id !== 'unknown_element');
  if (cleanIds.length === 0) return null;
  if (cleanIds.length === 1) return findElementById(elements, cleanIds[0]);

  const paths: ElementorElement[][] = [];
  for (const id of cleanIds) {
    const path = findAncestorsPath(elements, id);
    if (path) {
      paths.push(path);
    }
  }

  if (paths.length === 0) return null;
  if (paths.length === 1) return paths[0][paths[0].length - 1];

  let lca: ElementorElement | null = null;
  const minLen = Math.min(...paths.map((p) => p.length));

  for (let i = 0; i < minLen; i++) {
    const candidate = paths[0][i];
    const allMatch = paths.every((p) => p[i] && p[i].id === candidate.id);
    if (allMatch) {
      lca = candidate;
    } else {
      break;
    }
  }

  return lca;
}

/**
 * Collect all element IDs present in an Elementor tree.
 */
export function getAllElementIds(elements: ElementorElement[]): Set<string> {
  const ids = new Set<string>();

  function traverse(list: ElementorElement[]) {
    if (!list || !Array.isArray(list)) return;
    for (const el of list) {
      if (el && el.id) {
        ids.add(el.id);
      }
      if (el && Array.isArray(el.elements)) {
        traverse(el.elements);
      }
    }
  }

  traverse(elements);
  return ids;
}

/**
 * Trims the Elementor data tree to only include elements relevant to the detected issues (plus ancestor path).
 */
export function trimElementorData(
  elements: ElementorElement[],
  relevantIds: string[]
): ElementorElement[] {
  const relevantSet = new Set(relevantIds);
  if (relevantSet.size === 0) return elements;

  function filterTree(list: ElementorElement[]): ElementorElement[] {
    const result: ElementorElement[] = [];
    for (const el of list) {
      const filteredChildren = el.elements ? filterTree(el.elements) : [];
      const isDirectlyRelevant = relevantSet.has(el.id);
      const hasRelevantChildren = filteredChildren.length > 0;

      if (isDirectlyRelevant || hasRelevantChildren) {
        result.push({
          id: el.id,
          elType: el.elType,
          widgetType: el.widgetType,
          settings: el.settings || {},
          elements: filteredChildren,
        });
      }
    }
    return result;
  }

  const trimmed = filterTree(elements);
  return trimmed.length > 0 ? trimmed : elements;
}
