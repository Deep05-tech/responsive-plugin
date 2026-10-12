import { ElementorElement, findElementById } from './tree.js';

export interface CssProposal {
  element_id: string;
  css: string;
  reason: string;
  source?: 'llm' | 'fallback';
}

export interface CssValidationResult {
  valid: boolean;
  errors: string[];
  validatedProposals: CssProposal[];
}

const FORBIDDEN_PATTERNS = [
  /@import/i,
  /url\s*\(/i,
  /expression\s*\(/i,
  /<script/i,
  /javascript\s*:/i,
  /behavior\s*:/i,
  /-moz-binding/i,
];

const ALLOWED_MEDIA_QUERIES = [
  /@media\s*\(\s*max-width\s*:\s*(767px|768px|1024px)\s*\)/i,
  /@media\s+screen\s+and\s*\(\s*max-width\s*:\s*(767px|768px|1024px)\s*\)/i,
];

const ALLOWED_IMPORTANT_PROPERTIES = new Set([
  'font-size',
  'line-height',
  'width',
  'max-width',
  'min-width',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'display',
  'flex-direction',
  'flex-wrap',
  'text-align',
  'box-sizing',
]);

export function validateCssProposalItem(
  proposal: CssProposal,
  elementorData?: ElementorElement[],
  includeTypography: boolean = false
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!proposal || typeof proposal !== 'object') {
    return { valid: false, errors: ['CSS proposal must be an object.'] };
  }

  if (!proposal.element_id || typeof proposal.element_id !== 'string') {
    errors.push('CSS proposal missing valid element_id.');
  } else if (elementorData && elementorData.length > 0) {
    const found = findElementById(elementorData, proposal.element_id);
    if (!found) {
      errors.push(
        `[Scope Error] Element with ID "${proposal.element_id}" does not exist in the Elementor document tree.`
      );
    }
  }

  if (!proposal.css || typeof proposal.css !== 'string' || proposal.css.trim().length === 0) {
    errors.push(`CSS proposal for element "${proposal.element_id}" has empty css.`);
    return { valid: false, errors };
  }

  const css = proposal.css.trim();

  // Security check: forbidden directives
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(css)) {
      errors.push(
        `[Security Violation] CSS proposal for "${proposal.element_id}" contains forbidden pattern: ${pattern}`
      );
    }
  }

  // Media query check
  const hasMediaQuery = ALLOWED_MEDIA_QUERIES.some((q) => q.test(css));
  if (!hasMediaQuery) {
    errors.push(
      `[Responsive Scoping Error] CSS proposal for "${proposal.element_id}" must be wrapped in a responsive media query (e.g., @media (max-width: 767px) or @media (max-width: 1024px)).`
    );
  }

  // Scoping check: must reference element selector
  const expectedClass = `.elementor-element-${proposal.element_id}`;
  const expectedId = `#${proposal.element_id}`;
  if (!css.includes(expectedClass) && !css.includes(expectedId) && !css.includes(proposal.element_id)) {
    errors.push(
      `[Scoping Error] CSS proposal must be scoped to the element selector (${expectedClass} or ${expectedId}).`
    );
  }

  // Rule 2e: Universal selector check - reject universal selector '*'
  // Find all selector parts inside the media query before the '{'
  const innerRules = css.replace(/@media[^{]+\{/, '').replace(/\}$/, '').trim();
  const selectorMatches = innerRules.match(/([^{}]+)\{/g) || [];
  for (const selMatch of selectorMatches) {
    const selector = selMatch.replace(/\{/, '').trim();
    // Check if selector contains standalone '*' or ends with '*'
    if (/\*\s*$/.test(selector) || /\s+\*\s+/.test(selector) || selector === '*') {
      errors.push(
        `[Selector Error] Universal selector "*" is not allowed in CSS proposals. Target specific tags or classes instead. Found: "${selector}"`
      );
    }

    // Check if selector ends in a specific tag or class (e.g. p, h1, a, img, .class)
    const lastToken = selector.split(/\s+/).pop()?.trim() || '';
    const isValidEnding = /^[a-zA-Z0-9_\-\.\:\#\[\]\=\*\"\']+$/.test(lastToken) && !lastToken.endsWith('*');
    if (!isValidEnding) {
      errors.push(
        `[Selector Error] Selector must end in a specific tag or class. Found invalid ending: "${lastToken}"`
      );
    }
  }

  // Rule 2e: Reject font-size !important unless includeTypography is enabled
  if (css.includes('!important')) {
    const declMatches = css.match(/([a-zA-Z\-]+)\s*:[^;{}]+!important/gi) || [];
    for (const decl of declMatches) {
      const propMatch = decl.match(/([a-zA-Z\-]+)\s*:/);
      const prop = propMatch ? propMatch[1].trim().toLowerCase() : '';
      if (prop === 'font-size' && !includeTypography) {
        errors.push(
          `[Typography Restriction] "font-size !important" is not allowed unless --include-typography is enabled.`
        );
      } else if (prop && !ALLOWED_IMPORTANT_PROPERTIES.has(prop)) {
        errors.push(
          `[!important Restriction] Property "${prop}" is not allowed to use !important in responsive CSS proposals.`
        );
      }
    }
  }

  // Basic brace matching check
  const openBraces = (css.match(/\{/g) || []).length;
  const closeBraces = (css.match(/\}/g) || []).length;
  if (openBraces === 0 || openBraces !== closeBraces) {
    errors.push(
      `[Syntax Error] CSS proposal for "${proposal.element_id}" has mismatched or missing braces.`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function validateCssProposals(
  proposals: CssProposal[],
  elementorData?: ElementorElement[],
  includeTypography: boolean = false
): CssValidationResult {
  const allErrors: string[] = [];
  const validatedProposals: CssProposal[] = [];

  if (!Array.isArray(proposals)) {
    return {
      valid: false,
      errors: ['CSS proposals payload must be an array.'],
      validatedProposals: [],
    };
  }

  for (const p of proposals) {
    const res = validateCssProposalItem(p, elementorData, includeTypography);
    if (!res.valid) {
      allErrors.push(...res.errors);
    } else {
      validatedProposals.push(p);
    }
  }

  return {
    valid: allErrors.length === 0,
    errors: allErrors,
    validatedProposals,
  };
}
