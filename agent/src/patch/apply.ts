import { ElementorElement } from './tree.js';
import { PatchItem } from './validator.js';

export interface PatchDiffEntry {
  element_id: string;
  before: Record<string, any>;
  after: Record<string, any>;
}

/**
 * Apply a list of patches to an Elementor elements tree in memory.
 */
export function applyPatchesLocally(
  elements: ElementorElement[],
  patches: PatchItem[]
): { updatedTree: ElementorElement[]; diff: PatchDiffEntry[] } {
  const patchesById = new Map<string, Record<string, any>>();
  for (const p of patches) {
    patchesById.set(p.element_id, p.settings);
  }

  const diff: PatchDiffEntry[] = [];

  function traverseAndMerge(list: ElementorElement[]): ElementorElement[] {
    if (!list || !Array.isArray(list)) return [];

    return list.map((item) => {
      const cloned = { ...item };
      const patchSettings = patchesById.get(cloned.id);

      if (patchSettings) {
        const currentSettings = cloned.settings ? { ...cloned.settings } : {};
        const before: Record<string, any> = {};
        const after: Record<string, any> = {};

        for (const [k, v] of Object.entries(patchSettings)) {
          before[k] = currentSettings[k] ?? null;
          currentSettings[k] = v;
          after[k] = v;
        }

        cloned.settings = currentSettings;
        diff.push({
          element_id: cloned.id,
          before,
          after,
        });
      }

      if (Array.isArray(cloned.elements) && cloned.elements.length > 0) {
        cloned.elements = traverseAndMerge(cloned.elements);
      }

      return cloned;
    });
  }

  const updatedTree = traverseAndMerge(elements);
  return { updatedTree, diff };
}
