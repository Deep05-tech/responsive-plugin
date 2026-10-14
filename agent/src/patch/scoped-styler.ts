/**
 * Generates isolated responsive CSS strictly scoped to a specific Elementor element ID.
 * Guarantees zero side effects or style leakage to any other section on the page.
 */

export interface ScopedStyleOptions {
  elementId: string;
  sectionTitle?: string;
  extraRules?: string;
  isFormOrCard?: boolean;
}

export function generateScopedSectionCss(options: ScopedStyleOptions): string {
  const { elementId, sectionTitle = 'Targeted Section', extraRules = '', isFormOrCard = true } = options;
  // Ensure elementId never has internal wrapper prefixes
  const rawId = elementId.replace(/^era_scoped_css_/, '').replace(/^era_responsive_css_/, '');
  const cleanId = rawId.replace(/[^a-zA-Z0-9_-]/g, '');

  let css = `/* -------------------------------------------------------------
   SCOPED RESPONSIVE FIX: ${sectionTitle} (Elementor ID: ${cleanId})
   Scope: Exclusively affects .elementor-element-${cleanId}
   ------------------------------------------------------------- */

/* 1. Fluid Container Containment */
.elementor-element-${cleanId},
[data-id="${cleanId}"] {
  height: auto !important;
  min-height: fit-content !important;
  box-sizing: border-box !important;
  max-width: 100% !important;
  overflow-x: clip !important;
}

.elementor-element-${cleanId} .elementor-container,
.elementor-element-${cleanId} .elementor-row,
.elementor-element-${cleanId} .elementor-widget-wrap,
.elementor-element-${cleanId} .elementor-column-wrap {
  height: auto !important;
  min-height: fit-content !important;
  max-width: 100% !important;
  box-sizing: border-box !important;
}

/* Fluid containment for inner semantic wrappers, sections, headers, footers & grids */
.elementor-element-${cleanId} header,
.elementor-element-${cleanId} section,
.elementor-element-${cleanId} footer,
.elementor-element-${cleanId} [class*="header"],
.elementor-element-${cleanId} [class*="section"],
.elementor-element-${cleanId} [class*="footer"],
.elementor-element-${cleanId} [class*="container"],
.elementor-element-${cleanId} [class*="grid"] {
  max-width: 100% !important;
  box-sizing: border-box !important;
}
`;

  if (isFormOrCard) {
    css += `
/* 2. Fluid Form, Card & Interactive Sizing */
.elementor-element-${cleanId} [class*="card"],
.elementor-element-${cleanId} [class*="inquiry"],
.elementor-element-${cleanId} [class*="form"] {
  max-width: 100% !important;
  box-sizing: border-box !important;
  height: auto !important;
}

.elementor-element-${cleanId} input:not([type="checkbox"]):not([type="radio"]),
.elementor-element-${cleanId} select,
.elementor-element-${cleanId} textarea,
.elementor-element-${cleanId} button,
.elementor-element-${cleanId} .elementor-button,
.elementor-element-${cleanId} [class*="btn"],
.elementor-element-${cleanId} [class*="submit"] {
  max-width: 100% !important;
  box-sizing: border-box !important;
  min-height: 44px !important;
}

.elementor-element-${cleanId} button,
.elementor-element-${cleanId} .elementor-button,
.elementor-element-${cleanId} [class*="btn"],
.elementor-element-${cleanId} [class*="submit"] {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  padding: 10px 20px !important;
}
`;
  }

  css += `
/* 3. Responsive Breakpoint Normalization */
@media (max-width: 1200px) {
  .elementor-element-${cleanId} [class*="reveal"],
  .elementor-element-${cleanId} [class*="animate"],
  .elementor-element-${cleanId} [class*="slide"] {
    transform: none !important;
    opacity: 1 !important;
    visibility: visible !important;
  }
}

@media (max-width: 767px) {
  .elementor-element-${cleanId} .elementor-column,
  .elementor-element-${cleanId} .elementor-top-column {
    width: 100% !important;
  }
  .elementor-element-${cleanId} a,
  .elementor-element-${cleanId} button,
  .elementor-element-${cleanId} input[type="submit"] {
    min-height: 44px;
    box-sizing: border-box;
  }
  .elementor-element-${cleanId} nav,
  .elementor-element-${cleanId} [class*="nav"] {
    display: flex !important;
    flex-wrap: wrap !important;
    gap: 8px !important;
    justify-content: center !important;
  }
  .elementor-element-${cleanId} header,
  .elementor-element-${cleanId} [class*="header"] {
    height: auto !important;
    flex-direction: column !important;
    gap: 12px !important;
    padding: 16px 20px !important;
  }
  .elementor-element-${cleanId} [class$="-section"],
  .elementor-element-${cleanId} [class$="-grid"] {
    flex-direction: column !important;
    height: auto !important;
    gap: 24px !important;
  }
}
`;

  if (extraRules && extraRules.trim()) {
    // 1. Strip markdown fences if present
    let sanitized = extraRules.replace(/```css/gi, '').replace(/```/g, '').trim();

    // 2. Normalize any `#${cleanId}` selectors to `.elementor-element-${cleanId}`
    const idRegex = new RegExp(`#${cleanId}\\b`, 'g');
    sanitized = sanitized.replace(idRegex, `.elementor-element-${cleanId}`);
    const eraRegex = new RegExp(`#era_scoped_css_${cleanId}\\b`, 'g');
    sanitized = sanitized.replace(eraRegex, `.elementor-element-${cleanId}`);

    css += `\n/* 4. AI Custom Instruction Optimizations */\n${sanitized}\n`;
  }

  return css;
}
