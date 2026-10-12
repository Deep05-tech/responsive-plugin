import { chromium, Browser, Page } from 'playwright';

export interface AncestorInfo {
  tagClass: string;
  dataId: string | null;
  left: number;
  width: number;
  right: number;
  marginLeft: string;
  marginRight: string;
  paddingLeft: string;
  paddingRight: string;
  boxSizing: string;
  position: string;
  display: string;
  minWidth: string;
  maxWidth: string;
  inlineWidthTransform: string;
}

export interface OverflowGroupDiag {
  rightEdgeBucket: number;
  widestRight: number;
  outerHtmlSnippet: string;
  ancestorChain: AncestorInfo[];
  widener: {
    tagClass: string;
    dataId: string | null;
    childRight: number;
    parentContentBoxRight: number;
    diff: number;
  } | null;
}

export interface ViewportDiagResult {
  viewport: 'mobile' | 'tablet';
  width: number;
  scrollWidth: number;
  overflowGroups: OverflowGroupDiag[];
}

export async function runDiagnosis(url: string): Promise<ViewportDiagResult[]> {
  const browser: Browser = await chromium.launch({ headless: true });
  const results: ViewportDiagResult[] = [];

  const viewports: Array<{ name: 'mobile' | 'tablet'; width: number; height: number }> = [
    { name: 'mobile', width: 375, height: 812 },
    { name: 'tablet', width: 768, height: 1024 },
  ];

  try {
    for (const vp of viewports) {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
      });
      const page: Page = await context.newPage();

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(1000);

      const diagData: { scrollWidth: number; groups: OverflowGroupDiag[] } = await page.evaluate(`
        (function(vpWidth) {
          var scrollWidth = document.documentElement.scrollWidth;

          function isVisible(el) {
            if (!el || el === document.body || el === document.documentElement) return false;
            var cs = window.getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
            if (cs.position === 'fixed') return false;
            if (el.closest('.offcanvas, [aria-hidden="true"]')) return false;
            var rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          }

          var allElements = Array.from(document.querySelectorAll('*'));
          var overflowingElements = allElements.filter(function(el) {
            if (!isVisible(el)) return false;
            var rect = el.getBoundingClientRect();
            return rect.right > vpWidth + 0.5;
          });

          // Group by right edge (within 2px)
          var groupsMap = new Map();
          for (var i = 0; i < overflowingElements.length; i++) {
            var el = overflowingElements[i];
            var rect = el.getBoundingClientRect();
            var bucket = Math.round(rect.right / 2) * 2;
            if (!groupsMap.has(bucket)) {
              groupsMap.set(bucket, []);
            }
            groupsMap.get(bucket).push(el);
          }

          var groups = [];

          groupsMap.forEach(function(els, bucket) {
            els.sort(function(a, b) {
              return b.getBoundingClientRect().right - a.getBoundingClientRect().right;
            });
            var widestEl = els[0];
            var widestRect = widestEl.getBoundingClientRect();

            var outerHtmlSnippet = widestEl.outerHTML.slice(0, 300);

            var chainElements = [];
            var curr = widestEl;
            while (curr && curr !== document.documentElement) {
              chainElements.push(curr);
              if (curr === document.body) break;
              curr = curr.parentElement;
            }

            var ancestorChain = chainElements.map(function(item) {
              var r = item.getBoundingClientRect();
              var cs = window.getComputedStyle(item);
              var classes = item.className && typeof item.className === 'string'
                ? '.' + item.className.trim().split(/\\s+/).filter(Boolean).join('.')
                : '';
              var tagClass = item.tagName.toLowerCase() + classes;
              var dataId = item.getAttribute('data-id') || item.getAttribute('data-elementor-id') || null;

              var inlineParts = [];
              if (item.style.width) inlineParts.push('width: ' + item.style.width);
              if (item.style.transform) inlineParts.push('transform: ' + item.style.transform);
              if (item.style.maxWidth) inlineParts.push('max-width: ' + item.style.maxWidth);

              return {
                tagClass: tagClass,
                dataId: dataId,
                left: Math.round(r.left * 10) / 10,
                width: Math.round(r.width * 10) / 10,
                right: Math.round(r.right * 10) / 10,
                marginLeft: cs.marginLeft,
                marginRight: cs.marginRight,
                paddingLeft: cs.paddingLeft,
                paddingRight: cs.paddingRight,
                boxSizing: cs.boxSizing,
                position: cs.position,
                display: cs.display,
                minWidth: cs.minWidth,
                maxWidth: cs.maxWidth,
                inlineWidthTransform: inlineParts.length > 0 ? inlineParts.join('; ') : 'none',
              };
            });

            // The widener: first ancestor whose right edge exceeds parent content-box right by > 1px
            var widener = null;
            for (var k = chainElements.length - 1; k > 0; k--) {
              var parent = chainElements[k];
              var child = chainElements[k - 1];

              var pRect = parent.getBoundingClientRect();
              var pStyle = window.getComputedStyle(parent);
              var pPaddingRight = parseFloat(pStyle.paddingRight) || 0;
              var pBorderRight = parseFloat(pStyle.borderRightWidth) || 0;
              var parentContentBoxRight = pRect.right - pPaddingRight - pBorderRight;

              var cRect = child.getBoundingClientRect();
              var diff = cRect.right - parentContentBoxRight;

              if (diff > 1.0) {
                var cClasses = child.className && typeof child.className === 'string'
                  ? '.' + child.className.trim().split(/\\s+/).filter(Boolean).join('.')
                  : '';
                widener = {
                  tagClass: child.tagName.toLowerCase() + cClasses,
                  dataId: child.getAttribute('data-id') || child.getAttribute('data-elementor-id') || null,
                  childRight: Math.round(cRect.right * 10) / 10,
                  parentContentBoxRight: Math.round(parentContentBoxRight * 10) / 10,
                  diff: Math.round(diff * 10) / 10,
                };
                break;
              }
            }

            groups.push({
              rightEdgeBucket: bucket,
              widestRight: Math.round(widestRect.right * 10) / 10,
              outerHtmlSnippet: outerHtmlSnippet,
              ancestorChain: ancestorChain,
              widener: widener,
            });
          });

          groups.sort(function(a, b) {
            return b.widestRight - a.widestRight;
          });

          return {
            scrollWidth: scrollWidth,
            groups: groups,
          };
        })(${vp.width})
      `);

      results.push({
        viewport: vp.name,
        width: vp.width,
        scrollWidth: diagData.scrollWidth,
        overflowGroups: diagData.groups,
      });

      await context.close();
    }
  } finally {
    await browser.close();
  }

  return results;
}

export interface RemainingNodeDetails {
  elementId: string | null;
  selector: string;
  viewport: string;
  computedWidth: string;
  minWidth: string;
  flexBasis: string;
  parentGridTemplateColumns: string;
  outerHtmlSnippet: string;
}

export async function checkTabletAnimations(
  url: string,
  customCss?: string
): Promise<{ withoutAnimationFix: number; withAnimationFix: number }> {
  const browser: Browser = await chromium.launch({ headless: true });
  try {
    // 1. Without animation fix
    const ctx1 = await browser.newContext({ viewport: { width: 768, height: 1024 } });
    const page1 = await ctx1.newPage();
    await page1.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page1.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page1.waitForTimeout(1000);
    if (customCss) {
      await page1.addStyleTag({ content: customCss });
      await page1.waitForTimeout(100);
    }
    const countWithout = Number(await page1.evaluate(`
      (function() {
        var els = Array.from(document.querySelectorAll('*'));
        return els.filter(function(el) {
          if (!el || el === document.body || el === document.documentElement) return false;
          var cs = window.getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') return false;
          if (el.closest('.offcanvas, [aria-hidden="true"]')) return false;
          var r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.right > 768.5;
        }).length;
      })()
    `));
    await ctx1.close();

    // 2. With animation fix
    const ctx2 = await browser.newContext({ viewport: { width: 768, height: 1024 } });
    const page2 = await ctx2.newPage();
    await page2.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page2.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page2.addStyleTag({
      content: `
        *, *::before, *::after {
          animation: none !important;
          transition: none !important;
          scroll-behavior: auto !important;
        }
        .swiper-wrapper, .slick-track, .owl-stage {
          transform: none !important;
        }
        .vispan-reveal-right, .vispan-reveal-left, .vispan-reveal-up {
          transform: none !important;
          opacity: 1 !important;
          transition: none !important;
        }
      `,
    });
    if (customCss) {
      await page2.addStyleTag({ content: customCss });
      await page2.waitForTimeout(100);
    }
    await page2.waitForTimeout(500);
    const countWith = Number(await page2.evaluate(`
      (function() {
        var els = Array.from(document.querySelectorAll('*'));
        return els.filter(function(el) {
          if (!el || el === document.body || el === document.documentElement) return false;
          var cs = window.getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') return false;
          if (el.closest('.offcanvas, [aria-hidden="true"]')) return false;
          var r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.right > 768.5;
        }).length;
      })()
    `));
    await ctx2.close();

    return { withoutAnimationFix: countWithout, withAnimationFix: countWith };
  } finally {
    await browser.close();
  }
}

export async function getRemainingP0NodeDetails(
  url: string,
  viewport: { width: number; height: number; name: string },
  customCss?: string
): Promise<RemainingNodeDetails[]> {
  const browser: Browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.addStyleTag({
      content: `
        *, *::before, *::after {
          animation: none !important;
          transition: none !important;
        }
        .vispan-reveal-right, .vispan-reveal-left, .vispan-reveal-up {
          transform: none !important;
          opacity: 1 !important;
        }
      `,
    });
    if (customCss) {
      await page.addStyleTag({ content: customCss });
      await page.waitForTimeout(200);
    }

    const details: RemainingNodeDetails[] = await page.evaluate(`
      (function(vpWidth, vpName) {
        function isVisible(el) {
          if (!el || el === document.body || el === document.documentElement) return false;
          var cs = window.getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
          if (cs.position === 'fixed') return false;
          if (el.closest('.offcanvas, [aria-hidden="true"]')) return false;
          var rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }

        var allElements = Array.from(document.querySelectorAll('*'));
        var overflowingElements = allElements.filter(function(el) {
          if (!isVisible(el)) return false;
          var rect = el.getBoundingClientRect();
          return rect.right > vpWidth + 0.5;
        });

        return overflowingElements.map(function(el) {
          var cs = window.getComputedStyle(el);
          var parentCs = el.parentElement ? window.getComputedStyle(el.parentElement) : null;
          var elId = el.getAttribute('data-id') || (el.closest('.elementor-element[data-id]') ? el.closest('.elementor-element[data-id]').getAttribute('data-id') : null);
          var classes = el.className && typeof el.className === 'string'
            ? '.' + el.className.trim().split(/\\s+/).filter(Boolean).join('.')
            : '';
          var selector = el.tagName.toLowerCase() + classes;

          return {
            elementId: elId,
            selector: selector,
            viewport: vpName,
            computedWidth: cs.width,
            minWidth: cs.minWidth,
            flexBasis: cs.flexBasis,
            parentGridTemplateColumns: parentCs ? parentCs.gridTemplateColumns : 'none',
            outerHtmlSnippet: el.outerHTML.slice(0, 200),
          };
        });
      })(${viewport.width}, "${viewport.name}")
    `);

    await context.close();
    return details;
  } finally {
    await browser.close();
  }
}

export interface InnerDescendantInfo {
  tagClass: string;
  scrollWidth: number;
  clientWidth: number;
  whiteSpace: string;
  display: string;
  flexShrink: string;
  flexBasis: string;
  minWidth: string;
  width: string;
  overflowWrap: string;
  outerHtmlSnippet: string;
}

export interface InnerCardDiag {
  cardTagClass: string;
  cardDataId: string | null;
  cardWidth: number;
  cardClientWidth: number;
  cardScrollWidth: number;
  cardComputedWidth: string;
  cardComputedMinWidth: string;
  nearestFlexGridAncestor: {
    tagClass: string;
    display: string;
    flexDirection: string;
    flexWrap: string;
    gridTemplateColumns: string;
  } | null;
  descendants: InnerDescendantInfo[];
  innerWidener: InnerDescendantInfo | null;
}

export async function runInnerDiagnosis(url: string): Promise<InnerCardDiag[]> {
  const browser: Browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
    });
    const page: Page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.addStyleTag({
      content: `
        *, *::before, *::after {
          animation: none !important;
          transition: none !important;
        }
        .vispan-reveal-right, .vispan-reveal-left, .vispan-reveal-up, [class*="vispan-reveal"] {
          transform: none !important;
          opacity: 1 !important;
          transition: none !important;
          animation: none !important;
        }
      `,
    });
    await page.waitForTimeout(500);

    const cardsDiag: InnerCardDiag[] = await page.evaluate(`
      (function() {
        function getTagClass(el) {
          if (!el) return '';
          var classes = el.className && typeof el.className === 'string'
            ? '.' + el.className.trim().split(/\\s+/).filter(Boolean).join('.')
            : '';
          return el.tagName.toLowerCase() + classes;
        }

        // Target composite card selectors
        var cardSelectors = [
          '.vispan-inquiry-card',
          '.vispan-essay-article',
          '.vispan-hover-card',
          '.elementor-element-vispan_benefits_widget .elementor-widget-container > div',
          '.elementor-element-vispan_process_widget .elementor-widget-container > div',
          '.elementor-element-vispan_industry_widget .elementor-widget-container > div',
          '.elementor-element-vispan_faq_content .elementor-widget-container > div',
          '.elementor-element-vispan_accordion_content .elementor-widget-container > div',
          '.elementor-element-vispan_hero_inquiry_card .elementor-widget-container > div',
          '.elementor-element-vispan_essay_content .elementor-widget-container > div'
        ];

        var potentialCards = Array.from(document.querySelectorAll(cardSelectors.join(',')));
        var seenCards = new Set();
        var cards = [];

        for (var i = 0; i < potentialCards.length; i++) {
          var card = potentialCards[i];
          if (seenCards.has(card)) continue;
          if (['script', 'style', 'input', 'button', 'textarea', 'select', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a'].includes(card.tagName.toLowerCase())) continue;

          var cs = window.getComputedStyle(card);
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') continue;

          var rect = card.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;

          seenCards.add(card);
          cards.push(card);
        }

        return cards.map(function(card) {
          var cardCs = window.getComputedStyle(card);
          var cardRect = card.getBoundingClientRect();
          var cardDataId = card.getAttribute('data-id') || (card.closest('.elementor-element[data-id]') ? card.closest('.elementor-element[data-id]').getAttribute('data-id') : null);

          // Find nearest flex or grid ancestor
          var nearestFlexGrid = null;
          var curr = card.parentElement;
          while (curr && curr !== document.documentElement) {
            var currCs = window.getComputedStyle(curr);
            if (currCs.display === 'flex' || currCs.display === 'inline-flex' || currCs.display === 'grid' || currCs.display === 'inline-grid') {
              nearestFlexGrid = {
                tagClass: getTagClass(curr),
                display: currCs.display,
                flexDirection: currCs.flexDirection,
                flexWrap: currCs.flexWrap,
                gridTemplateColumns: currCs.gridTemplateColumns,
              };
              break;
            }
            curr = curr.parentElement;
          }

          // List all descendants with scrollWidth > card.clientWidth + 1
          var allDescendants = Array.from(card.querySelectorAll('*'));
          var overflowingDescendants = [];

          for (var j = 0; j < allDescendants.length; j++) {
            var d = allDescendants[j];
            var dCs = window.getComputedStyle(d);
            if (dCs.display === 'none' || dCs.visibility === 'hidden') continue;

            var dRect = d.getBoundingClientRect();
            if (d.scrollWidth > card.clientWidth + 1 || dRect.right > cardRect.right + 1) {
              overflowingDescendants.push({
                tagClass: getTagClass(d),
                scrollWidth: d.scrollWidth,
                clientWidth: d.clientWidth,
                whiteSpace: dCs.whiteSpace,
                display: dCs.display,
                flexShrink: dCs.flexShrink,
                flexBasis: dCs.flexBasis,
                minWidth: dCs.minWidth,
                width: dCs.width,
                overflowWrap: dCs.overflowWrap || dCs.wordBreak,
                outerHtmlSnippet: d.outerHTML.slice(0, 200),
              });
            }
          }

          // Sort descendants by scrollWidth descending
          overflowingDescendants.sort(function(a, b) {
            return b.scrollWidth - a.scrollWidth;
          });

          var innerWidener = overflowingDescendants.length > 0 ? overflowingDescendants[0] : null;

          return {
            cardTagClass: getTagClass(card),
            cardDataId: cardDataId,
            cardWidth: Math.round(cardRect.width * 10) / 10,
            cardClientWidth: card.clientWidth,
            cardScrollWidth: card.scrollWidth,
            cardComputedWidth: cardCs.width,
            cardComputedMinWidth: cardCs.minWidth,
            nearestFlexGridAncestor: nearestFlexGrid,
            descendants: overflowingDescendants,
            innerWidener: innerWidener,
          };
        });
      })()
    `);

    await context.close();
    return cardsDiag;
  } finally {
    await browser.close();
  }
}
