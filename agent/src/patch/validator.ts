import fs from 'fs';
import path from 'path';
import { ElementorElement, findElementById } from './tree.js';

export type ReasonCode =
  | 'unknown_element'
  | 'disallowed_key'
  | 'unknown_key'
  | 'invalid_shape'
  | 'invalid_eltype_key'
  | 'hiding_disabled'
  | 'unpatchable_scope'
  | 'conflicting_duplicate'
  | 'needs_typography_exception';

export interface ValidationErrorItem {
  code: ReasonCode;
  element_id: string;
  key?: string;
  message: string;
}

export interface PatchItem {
  element_id: string;
  elType?: string;
  settings: Record<string, any>;
  reason?: string;
  source?: 'llm' | 'fallback';
  targetedIssues?: any[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  errorDetails: ValidationErrorItem[];
  elType?: string;
}

const RESPONSIVE_KEY_SUFFIXES = [
  '_mobile',
  '_tablet',
  '_mobile_extra',
  '_tablet_extra',
];

const HIDE_KEYS = new Set([
  'hide_mobile',
  'hide_tablet',
  'hide_mobile_extra',
  'hide_tablet_extra',
]);

// Keys specific to widgets vs section/column
const WIDGET_SPECIFIC_PREFIXES = ['_padding_', '_margin_', '_element_width_', '_element_custom_width_'];
const CONTAINER_SECTION_COLUMN_PREFIXES = ['padding_', 'margin_', '_inline_size_', 'space_between_widgets_'];

// Load key reference definition
let keyReference: any = null;
try {
  const possiblePaths = [
    path.resolve(process.cwd(), 'config/key-reference.json'),
    path.resolve(process.cwd(), 'agent/config/key-reference.json'),
  ];
  for (const refPath of possiblePaths) {
    if (fs.existsSync(refPath)) {
      keyReference = JSON.parse(fs.readFileSync(refPath, 'utf-8'));
      break;
    }
  }
} catch {
  // If not found at runtime, fallback to built-in rules
}

/**
 * Validates the value format of an Elementor setting against key-reference.json shapes.
 */
export function validateSettingShape(
  key: string,
  value: any,
  elType: string
): { valid: boolean; code?: ReasonCode; message?: string } {
  // Check dimension_box shape (padding, margin, etc.)
  if (
    key.startsWith('padding_') ||
    key.startsWith('_padding_') ||
    key.startsWith('margin_') ||
    key.startsWith('_margin_') ||
    key.startsWith('button_padding_')
  ) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return {
        valid: false,
        code: 'invalid_shape',
        message: `Key "${key}" must be a dimension_box object with { unit, top, right, bottom, left }. Received: ${JSON.stringify(value)}`,
      };
    }
    const { unit, top, right, bottom, left } = value;
    if (!unit || top === undefined || right === undefined || bottom === undefined || left === undefined) {
      return {
        valid: false,
        code: 'invalid_shape',
        message: `Key "${key}" dimension_box is missing required fields (unit, top, right, bottom, left).`,
      };
    }
    return { valid: true };
  }

  // Check size_slider shape (font size, line height, custom width, gap)
  if (
    key.startsWith('typography_font_size_') ||
    key.startsWith('typography_line_height_') ||
    key.startsWith('_element_custom_width_') ||
    key.startsWith('space_between_widgets_') ||
    key.startsWith('gap_') ||
    key.startsWith('flex_gap_')
  ) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return {
        valid: false,
        code: 'invalid_shape',
        message: `Key "${key}" must be a size_slider object with { unit, size }. Received: ${JSON.stringify(value)}`,
      };
    }
    if (!value.unit || typeof value.size !== 'number' || isNaN(value.size)) {
      return {
        valid: false,
        code: 'invalid_shape',
        message: `Key "${key}" size_slider is missing a valid "unit" or numeric "size".`,
      };
    }
    return { valid: true };
  }

  // Check column inline size
  if (key.startsWith('_inline_size_')) {
    if (typeof value !== 'number' || isNaN(value) || value <= 0 || value > 100) {
      return {
        valid: false,
        code: 'invalid_shape',
        message: `Key "${key}" must be a number between 1 and 100 representing column percentage width. Received: ${JSON.stringify(value)}`,
      };
    }
    return { valid: true };
  }

  // Check widget width preset
  if (key.startsWith('_element_width_')) {
    if (value === 'auto') {
      return {
        valid: false,
        code: 'disallowed_key',
        message: `Key "${key}" cannot be set to "auto" (Inline) to fix overflow. Use "inherit" (Full Width) or custom width instead.`,
      };
    }
    if (typeof value !== 'string' || !['inherit', 'initial'].includes(value)) {
      return {
        valid: false,
        code: 'invalid_shape',
        message: `Key "${key}" must be one of "inherit", "initial". Received: ${JSON.stringify(value)}`,
      };
    }
    return { valid: true };
  }

  // Check alignment
  if (key.startsWith('align_') || key.startsWith('text_align_')) {
    if (typeof value !== 'string' || !['left', 'center', 'right', 'justify'].includes(value)) {
      return {
        valid: false,
        code: 'invalid_shape',
        message: `Key "${key}" must be one of "left", "center", "right", "justify". Received: ${JSON.stringify(value)}`,
      };
    }
    return { valid: true };
  }

  return { valid: true };
}

/**
 * Check if setting key is valid for given elType.
 */
export function validateKeyForElType(
  key: string,
  elType: string
): { valid: boolean; code?: ReasonCode; message?: string } {
  if (elType === 'widget') {
    // Widgets cannot use unprefixed padding_ or margin_
    if (key.startsWith('padding_') || key.startsWith('margin_')) {
      return {
        valid: false,
        code: 'invalid_eltype_key',
        message: `Element type "widget" cannot use "${key}". Widgets must use "_${key}".`,
      };
    }
  } else if (elType === 'section' || elType === 'column') {
    // Sections and columns cannot use underscore-prefixed _padding_ or _margin_ or _element_width_
    if (key.startsWith('_padding_') || key.startsWith('_margin_') || key.startsWith('_element_width_') || key.startsWith('_element_custom_width_')) {
      return {
        valid: false,
        code: 'invalid_eltype_key',
        message: `Element type "${elType}" cannot use widget-prefixed key "${key}". Use "${key.replace(/^_/, '')}" instead.`,
      };
    }
  }

  return { valid: true };
}

/**
 * Validates a single patch item against Hard Rules 2 & 7, elType compatibility, and tree integrity.
 */
export function validatePatchItem(
  patch: PatchItem,
  elementorData: ElementorElement[],
  allowHiding: boolean = false
): ValidationResult {
  const errors: string[] = [];
  const errorDetails: ValidationErrorItem[] = [];

  if (!patch || typeof patch !== 'object') {
    return {
      valid: false,
      errors: ['Patch item must be an object.'],
      errorDetails: [{ code: 'invalid_shape', element_id: 'unknown', message: 'Patch item must be an object.' }],
    };
  }

  let targetElement: ElementorElement | null = null;

  if (!patch.element_id || typeof patch.element_id !== 'string') {
    errors.push('Patch item must have a valid string "element_id".');
    errorDetails.push({ code: 'unknown_element', element_id: '', message: 'Patch item missing string element_id.' });
  } else {
    // Tree integrity check: Element ID must exist in the Elementor document
    targetElement = findElementById(elementorData, patch.element_id);
    if (!targetElement) {
      const msg = `[Unknown Element ID] Element with ID "${patch.element_id}" does not exist in the Elementor document tree.`;
      errors.push(msg);
      errorDetails.push({ code: 'unknown_element', element_id: patch.element_id, message: msg });
    } else {
      patch.elType = targetElement.elType;
    }
  }

  if (!patch.settings || typeof patch.settings !== 'object' || Array.isArray(patch.settings)) {
    const msg = 'Patch item must have a "settings" object.';
    errors.push(msg);
    errorDetails.push({ code: 'invalid_shape', element_id: patch.element_id || 'unknown', message: msg });
    return { valid: errors.length === 0, errors, errorDetails, elType: targetElement?.elType };
  }

  const keys = Object.keys(patch.settings);
  if (keys.length === 0) {
    const msg = `Patch for element "${patch.element_id}" contains an empty settings object.`;
    errors.push(msg);
    errorDetails.push({ code: 'invalid_shape', element_id: patch.element_id, message: msg });
  }

  const elType = targetElement?.elType || patch.elType || 'widget';

  for (const key of keys) {
    const value = patch.settings[key];

    // Check desktop typography exception
    if (key === 'typography_typography') {
      const msg = `Key "typography_typography" requires typography exception validation.`;
      errors.push(msg);
      errorDetails.push({ code: 'needs_typography_exception', element_id: patch.element_id, key, message: msg });
      continue;
    }

    // Hard Rule 2: Must end with _tablet, _mobile, _tablet_extra, _mobile_extra
    const hasResponsiveSuffix = RESPONSIVE_KEY_SUFFIXES.some((suffix) => key.endsWith(suffix));
    if (!hasResponsiveSuffix) {
      const msg = `[Hard Rule 2 Violation] Key "${key}" is rejected. Only responsive keys ending in _mobile, _tablet, _mobile_extra, or _tablet_extra are allowed.`;
      errors.push(msg);
      errorDetails.push({ code: 'disallowed_key', element_id: patch.element_id, key, message: msg });
      continue;
    }

    // Hard Rule 7: Disallow hide_* unless allowHiding=true
    if (HIDE_KEYS.has(key) && !allowHiding) {
      const msg = `[Hard Rule 7 Violation] Key "${key}" is rejected. Hiding content on responsive breakpoints is disabled (ALLOW_HIDING=false).`;
      errors.push(msg);
      errorDetails.push({ code: 'hiding_disabled', element_id: patch.element_id, key, message: msg });
      continue;
    }

    // elType check
    const elTypeRes = validateKeyForElType(key, elType);
    if (!elTypeRes.valid) {
      errors.push(elTypeRes.message!);
      errorDetails.push({
        code: elTypeRes.code || 'invalid_eltype_key',
        element_id: patch.element_id,
        key,
        message: elTypeRes.message!,
      });
      continue;
    }

    // Shape validation
    const shapeRes = validateSettingShape(key, value, elType);
    if (!shapeRes.valid) {
      errors.push(shapeRes.message!);
      errorDetails.push({
        code: shapeRes.code || 'invalid_shape',
        element_id: patch.element_id,
        key,
        message: shapeRes.message!,
      });
    }
  }

  // Cross-key validation: _element_width_*: "initial" requires _element_custom_width_*
  for (const suffix of RESPONSIVE_KEY_SUFFIXES) {
    const widthKey = `_element_width${suffix}`;
    const customWidthKey = `_element_custom_width${suffix}`;
    if (patch.settings[widthKey] === 'initial' && !patch.settings[customWidthKey]) {
      const msg = `[Invalid Preset] Key "${widthKey}" is set to "initial" without corresponding "${customWidthKey}".`;
      errors.push(msg);
      errorDetails.push({
        code: 'invalid_shape',
        element_id: patch.element_id,
        key: widthKey,
        message: msg,
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    errorDetails,
    elType: targetElement?.elType,
  };
}

/**
 * Validates an entire list of patches and detects conflicting duplicates.
 */
export function validatePatches(
  patches: PatchItem[],
  elementorData: ElementorElement[],
  allowHiding: boolean = false
): {
  valid: boolean;
  errors: string[];
  errorDetails: ValidationErrorItem[];
  validatedPatches: PatchItem[];
  rejectedPatches: { patch: PatchItem; reasons: ValidationErrorItem[] }[];
} {
  const allErrors: string[] = [];
  const allErrorDetails: ValidationErrorItem[] = [];
  const validatedPatches: PatchItem[] = [];
  const rejectedPatches: { patch: PatchItem; reasons: ValidationErrorItem[] }[] = [];

  if (!Array.isArray(patches)) {
    return {
      valid: false,
      errors: ['Patches payload must be an array.'],
      errorDetails: [{ code: 'invalid_shape', element_id: 'unknown', message: 'Patches payload must be an array.' }],
      validatedPatches: [],
      rejectedPatches: [],
    };
  }

  // Map to detect conflicting duplicate keys on same element
  const seenElementKeys = new Map<string, any>();

  for (const patch of patches) {
    const res = validatePatchItem(patch, elementorData, allowHiding);
    const itemErrors = [...res.errorDetails];

    if (res.elType) {
      patch.elType = res.elType;
    }

    // Conflict detection
    if (patch.element_id && patch.settings) {
      for (const [key, val] of Object.entries(patch.settings)) {
        const compositeKey = `${patch.element_id}::${key}`;
        if (seenElementKeys.has(compositeKey)) {
          const prevVal = seenElementKeys.get(compositeKey);
          if (JSON.stringify(prevVal) !== JSON.stringify(val)) {
            const conflictMsg = `Conflicting duplicate setting for element "${patch.element_id}" key "${key}": previous "${JSON.stringify(prevVal)}" vs current "${JSON.stringify(val)}"`;
            allErrors.push(conflictMsg);
            itemErrors.push({
              code: 'conflicting_duplicate',
              element_id: patch.element_id,
              key,
              message: conflictMsg,
            });
          }
        } else {
          seenElementKeys.set(compositeKey, val);
        }
      }
    }

    if (itemErrors.length > 0) {
      allErrors.push(...res.errors);
      allErrorDetails.push(...itemErrors);
      rejectedPatches.push({ patch, reasons: itemErrors });
    } else {
      validatedPatches.push(patch);
    }
  }

  return {
    valid: allErrors.length === 0,
    errors: allErrors,
    errorDetails: allErrorDetails,
    validatedPatches,
    rejectedPatches,
  };
}
