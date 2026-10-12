import { describe, it, expect } from 'vitest';
import { validatePatchItem, validatePatches } from '../src/patch/validator.js';
import { findElementById, getAllElementIds, trimElementorData, ElementorElement } from '../src/patch/tree.js';

describe('Phase 2 - Key Validator & Tree Utilities (Hard Rules 2 & 7)', () => {
  const sampleElementorTree: ElementorElement[] = [
    {
      id: 'section-hero',
      elType: 'section',
      settings: { layout: 'boxed' },
      elements: [
        {
          id: 'col-main',
          elType: 'column',
          settings: {},
          elements: [
            {
              id: 'w-heading',
              elType: 'widget',
              widgetType: 'heading',
              settings: { title: 'Heading text' },
            },
            {
              id: 'w-button',
              elType: 'widget',
              widgetType: 'button',
              settings: { text: 'Click me' },
            },
          ],
        },
      ],
    },
  ];

  describe('Tree Traversal and Lookup', () => {
    it('Finds an element by its ID recursively', () => {
      const el = findElementById(sampleElementorTree, 'w-button');
      expect(el).not.toBeNull();
      expect(el?.id).toBe('w-button');
      expect(el?.widgetType).toBe('button');
    });

    it('Returns null when element ID does not exist', () => {
      const el = findElementById(sampleElementorTree, 'non-existent-id');
      expect(el).toBeNull();
    });

    it('Collects all element IDs correctly', () => {
      const ids = getAllElementIds(sampleElementorTree);
      expect(ids.has('section-hero')).toBe(true);
      expect(ids.has('col-main')).toBe(true);
      expect(ids.has('w-heading')).toBe(true);
      expect(ids.has('w-button')).toBe(true);
      expect(ids.size).toBe(4);
    });

    it('Trims tree to only elements on the path to relevant IDs', () => {
      const trimmed = trimElementorData(sampleElementorTree, ['w-button']);
      expect(trimmed.length).toBe(1);
      expect(trimmed[0].id).toBe('section-hero');
      expect(trimmed[0].elements?.[0].id).toBe('col-main');
      expect(trimmed[0].elements?.[0].elements?.length).toBe(1);
      expect(trimmed[0].elements?.[0].elements?.[0].id).toBe('w-button');
    });
  });

  describe('Hard Rule 2: Responsive Key Validation & Shape Validation', () => {
    it('Accepts valid responsive keys and shapes ending in _mobile, _tablet, _mobile_extra, _tablet_extra', () => {
      const result = validatePatchItem(
        {
          element_id: 'w-button',
          settings: {
            _padding_mobile: { unit: 'px', top: '12', right: '20', bottom: '12', left: '20' },
            typography_font_size_tablet: { unit: 'px', size: 16 },
            align_mobile: 'center',
            _element_width_mobile: 'inherit',
          },
        },
        sampleElementorTree
      );

      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    it('Rejects desktop/base keys without a responsive suffix', () => {
      const result = validatePatchItem(
        {
          element_id: 'w-button',
          settings: {
            padding: { unit: 'px', top: '20', right: '20', bottom: '20', left: '20' }, // VIOLATION
            width: { unit: 'px', size: 500 },  // VIOLATION
            typography_font_size_mobile: { unit: 'px', size: 14 }, // OK
          },
        },
        sampleElementorTree
      );

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Hard Rule 2 Violation') && e.includes('padding'))).toBe(true);
      expect(result.errors.some((e) => e.includes('Hard Rule 2 Violation') && e.includes('width'))).toBe(true);
      expect(result.errorDetails.some((d) => d.code === 'disallowed_key')).toBe(true);
    });

    it('Rejects invalid shape for dimension_box and size_slider with invalid_shape reason code', () => {
      const invalidPadding = validatePatchItem(
        {
          element_id: 'w-button',
          settings: {
            _padding_mobile: '10px', // Should be object
          },
        },
        sampleElementorTree
      );
      expect(invalidPadding.valid).toBe(false);
      expect(invalidPadding.errorDetails[0].code).toBe('invalid_shape');

      const invalidFontSize = validatePatchItem(
        {
          element_id: 'w-button',
          settings: {
            typography_font_size_mobile: { unit: 'px' }, // Missing size
          },
        },
        sampleElementorTree
      );
      expect(invalidFontSize.valid).toBe(false);
      expect(invalidFontSize.errorDetails[0].code).toBe('invalid_shape');
    });

    it('Rejects typography_typography as needing typography exception', () => {
      const result = validatePatchItem(
        {
          element_id: 'w-button',
          settings: {
            typography_typography: 'custom',
          },
        },
        sampleElementorTree
      );
      expect(result.valid).toBe(false);
      expect(result.errorDetails.some((d) => d.code === 'needs_typography_exception')).toBe(true);
    });
  });

  describe('Hard Rule 7: Hiding Keys Validation', () => {
    it('Rejects hide_mobile and hide_tablet when ALLOW_HIDING is false', () => {
      const result = validatePatchItem(
        {
          element_id: 'w-heading',
          settings: {
            hide_mobile: 'yes',
          },
        },
        sampleElementorTree,
        false // allowHiding = false
      );

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Hard Rule 7 Violation') && e.includes('hide_mobile'))).toBe(true);
      expect(result.errorDetails[0].code).toBe('hiding_disabled');
    });

    it('Allows hide_mobile and hide_tablet when ALLOW_HIDING is true', () => {
      const result = validatePatchItem(
        {
          element_id: 'w-heading',
          settings: {
            hide_mobile: 'yes',
          },
        },
        sampleElementorTree,
        true // allowHiding = true
      );

      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });
  });

  describe('Tree Integrity & Unknown Element ID Protection', () => {
    it('Rejects patches targeting non-existent element IDs', () => {
      const result = validatePatchItem(
        {
          element_id: 'hallucinated-element-999',
          settings: {
            padding_mobile: { unit: 'px', top: '10', right: '10', bottom: '10', left: '10' },
          },
        },
        sampleElementorTree
      );

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Unknown Element ID'))).toBe(true);
      expect(result.errorDetails[0].code).toBe('unknown_element');
    });

    it('Validates a full list of patches, separating valid from invalid', () => {
      const patches = [
        {
          element_id: 'w-button',
          settings: { _padding_mobile: { unit: 'px', top: '12', right: '12', bottom: '12', left: '12' } },
        },
        {
          element_id: 'non-existent',
          settings: { _padding_mobile: { unit: 'px', top: '12', right: '12', bottom: '12', left: '12' } },
        },
        {
          element_id: 'w-heading',
          settings: { color: '#ff0000' }, // Desktop key
        },
      ];

      const res = validatePatches(patches, sampleElementorTree);
      expect(res.valid).toBe(false);
      expect(res.errors.length).toBe(2);
      expect(res.validatedPatches.length).toBe(1);
      expect(res.validatedPatches[0].element_id).toBe('w-button');
      expect(res.rejectedPatches.length).toBe(2);
    });

    it('Detects and flags conflicting duplicate patches', () => {
      const patches = [
        {
          element_id: 'w-button',
          settings: { typography_font_size_mobile: { unit: 'px', size: 14 } },
        },
        {
          element_id: 'w-button',
          settings: { typography_font_size_mobile: { unit: 'px', size: 18 } },
        },
      ];

      const res = validatePatches(patches, sampleElementorTree);
      expect(res.valid).toBe(false);
      expect(res.errorDetails.some((d) => d.code === 'conflicting_duplicate')).toBe(true);
    });
  });
});
