const fs = require('fs');

const code = `import { chromium, Browser, BrowserContextOptions } from 'playwright';
import path from 'path';
import fs from 'fs';
import {
  AuditReport,
  AuditSummary,
  Issue,
  ViewportAuditResult,
  ElementIssuesGroup,
  SeverityTier,
  IssueScope,
} from './types.js';
import { VIEWPORTS, ViewportConfig, checkProductionBlocklist, loadConfig } from '../config/index.js';
import { EraBridgeClient } from '../bridge/client.js';

export interface AuditOptions {
  pageId?: string | number;
  url: string;
  outputDir?: string;
  browser?: Browser;
  elementorData?: any[];
}

export class PageAuditor {
  private config = loadConfig();

  /**
   * Recursively collect all element IDs from _elementor_data JSON structure.
   */
  public collectElementIds(elements: any[]): Set<string> {
    const ids = new Set<string>();
    const traverse = (items: any[]) => {
      if (!Array.isArray(items)) return;
      for (const item of items) {
        if (item && item.id) {
          ids.add(String(item.id));
        }
        if (item && Array.isArray(item.elements)) {
          traverse(item.elements);
        }
      }
    };
    traverse(elements);
    return ids;
  }

  /**
   * Audit a single URL across mobile, tablet, and desktop viewports using the STABLE CAPTURE PROCEDURE.
   */
  public async auditPage(options: AuditOptions): Promise<AuditReport> {
    const { url } = options;
    const pageId = options.pageId || this.extractPageId(url);
    const outputDir = options.outputDir || path.join(this.config.outputDir, String(pageId));

    // Hard Rule 3: Enforce production blocklist
    checkProductionBlocklist(url, this.config.productionBlocklist);

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Try to load _elementor_data for patchability validation
    let elementorData = options.elementorData;
    if (!elementorData) {
      if (url.includes('/fixtures/')) {
        try {
          const match = url.match(/\\/fixtures\\/([^/]+)/);
          if (match) {
            const fixtureDataPath = path.resolve(process.cwd(), '../fixtures', match[1], 'data.json');
            if (fs.existsSync(fixtureDataPath)) {
              elementorData = JSON.parse(fs.readFileSync(fixtureDataPath, 'utf-8'));
            }
          }
        } catch {
          // ignore fixture read failure
        }
      } else if (!isNaN(Number(pageId))) {
        try {
          const client = new EraBridgeClient(this.config);
          const wpPage = await client.getPage(Number(pageId));
          if (wpPage && wpPage.elementor_data) {
            elementorData = wpPage.elementor_data;
          }
        } catch {
          // bridge not reachable or read-only failure - handled gracefully
        }
      }
    }

    const elementorIdsSet = elementorData ? this.collectElementIds(elementorData) : new Set<string>();

    const browserProvided = Boolean(options.browser);
    const browser = options.browser || (await chromium.launch({ headless: true }));

    try {
      const viewportsResult: Partial<AuditReport['viewports']> = {};
      const allIssues: Issue[] = [];
      const severityCounts: Record<SeverityTier, number> = { P0: 0, P1: 0, P2: 0 };
      const scopeCounts: Record<IssueScope, number> = { elementor: 0, theme: 0, wpadminbar: 0, unmapped: 0 };
      let patchableCount = 0;
      let unpatchableCount = 0;

      for (const vp of VIEWPORTS) {
        const result = await this.auditViewport(browser, url, vp, outputDir);
        viewportsResult[vp.name] = result;

        for (const iss of result.issues) {
          // Tag patchability based on elementor data and scope
          const scope = iss.scope || (iss.elementId ? 'elementor' : 'unmapped');
          iss.scope = scope;

          if (scope === 'theme' || scope === 'wpadminbar') {
            iss.patchable = false;
            iss.unpatchableReason = 'theme_scope';
          } else if (iss.fontSource === 'inline') {
            iss.patchable = false;
            iss.unpatchableReason = 'inline_html_style';
          } else if (!iss.elementId || (elementorIdsSet.size > 0 && !elementorIdsSet.has(iss.elementId))) {
            iss.patchable = false;
            iss.unpatchableReason = 'not_in_elementor_data';
          } else {
            iss.patchable = true;
          }

          if (iss.patchable) {
            patchableCount++;
          } else {
            unpatchableCount++;
          }

          if (scopeCounts[scope] !== undefined) {
            scopeCounts[scope]++;
          }

          if (severityCounts[iss.severity] !== undefined) {
            severityCounts[iss.severity]++;
          }

          allIssues.push(iss);
        }
      }

      // Group issues by Elementor element data-id (or unmapped scope) and root cause
      const issuesByElementId: Record<string, ElementIssuesGroup> = {};
      const issuesByRootCause: Record<string, Issue[]> = {};

      for (const issue of allIssues) {
        const groupKey = issue.elementId ? issue.elementId : ('unmapped_' + (issue.scope || 'unmapped'));
        if (!issuesByElementId[groupKey]) {
          issuesByElementId[groupKey] = {
            elementId: issue.elementId,
            scope: issue.scope,
            total: 0,
            rootCauses: {},
            issues: [],
          };
        }
        issuesByElementId[groupKey].total++;
        issuesByElementId[groupKey].issues.push(issue);

        if (!issuesByElementId[groupKey].rootCauses[issue.type]) {
          issuesByElementId[groupKey].rootCauses[issue.type] = [];
        }
        issuesByElementId[groupKey].rootCauses[issue.type].push(issue);

        if (!issuesByRootCause[issue.type]) {
          issuesByRootCause[issue.type] = [];
        }
        issuesByRootCause[issue.type].push(issue);
      }

      const summary: AuditSummary = {
        totalIssues: allIssues.length,
        bySeverity: severityCounts,
        byScope: scopeCounts,
        patchableCount,
        unpatchableCount,
        distinctElements: Object.keys(issuesByElementId).length,
      };

      const report: AuditReport = {
        pageId,
        pageUrl: url,
        timestamp: new Date().toISOString(),
        viewports: viewportsResult as AuditReport['viewports'],
        totalIssues: allIssues.length,
        summary,
        severityCounts,
        issuesByElementId,
        issuesByRootCause,
      };

      // Save report.json in output dir
      fs.writeFileSync(
        path.join(outputDir, 'report.json'),
        JSON.stringify(report, null, 2),
        'utf-8'
      );

      return report;
    } finally {
      if (!browserProvided) {
        await browser.close();
      }
    }
  }

  private extractPageId(url: string): string {
    try {
      const parsed = new URL(url);
      const searchId = parsed.searchParams.get('p') || parsed.searchParams.get('page_id');
      if (searchId) return searchId;
      const pathSegments = parsed.pathname.split('/').filter(Boolean);
      if (pathSegments.length > 0) return pathSegments[pathSegments.length - 1];
    } catch {
      // Fallback
    }
    return 'page_' + Date.now();
  }

  private async auditViewport(
    browser: Browser,
    url: string,
    vp: ViewportConfig,
    outputDir: string
  ): Promise<ViewportAuditResult> {
    const contextOptions: BrowserContextOptions = {
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
    };

    if (this.config.stagingBasicAuthUser && this.config.stagingBasicAuthPass) {
      contextOptions.httpCredentials = {
        username: this.config.stagingBasicAuthUser,
        password: this.config.stagingBasicAuthPass,
      };
    }

    // Always create a clean context without cookies
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    try {
      const response = await page.goto(url, { waitUntil: 'load', timeout: 30000 });

      if (response && response.status() === 401) {
        throw new Error(
          '[LOGIN WALL ERROR] HTTP 401 Unauthorized encountered at "' + url + '". Please provide valid STAGING_BASIC_AUTH_USER and STAGING_BASIC_AUTH_PASS in .env.'
        );
      }

      const finalUrl = page.url();
      if (finalUrl.includes('wp-login.php') || finalUrl.includes('/login')) {
        throw new Error(
          '[LOGIN WALL ERROR] Redirected to WordPress login page (' + finalUrl + '). Please ensure the target staging page is publicly accessible or authenticated.'
        );
      }

      // Check for login forms or active admin presence
      const hasLoginForm = await page.evaluate(
        'Boolean(document.querySelector("#user_login, #loginform, form.login-form, input[type=\\"password\\"]#pwd"))'
      );
      if (hasLoginForm && !url.includes('fixtures')) {
        throw new Error(
          '[LOGIN WALL ERROR] Page "' + url + '" contains a password login form. Aborting audit to prevent measuring the login screen.'
        );
      }

      // Check for logged-in admin bar or body.logged-in (Fix 4)
      const hasAdminPresence = await page.evaluate(
        'Boolean(document.querySelector("#wpadminbar") || (document.body && document.body.classList.contains("logged-in")))'
      );
      if (hasAdminPresence && !url.includes('fixtures')) {
        throw new Error(
          '[LOGGED-IN AUDIT ERROR] Page "' + url + '" was loaded with active admin presence (#wpadminbar or body.logged-in). Audits must strictly run logged out.'
        );
      }

      // Disable animations & transitions
      await page.addStyleTag({
        content: \`
          *, *::before, *::after {
            animation: none !important;
            transition: none !important;
            scroll-behavior: auto !important;
          }
          .swiper-wrapper, .slick-track, .owl-stage {
            transform: none !important;
          }
        \`,
      });

      // Pause carousel autoplay
      await page.evaluate(\`
        (function() {
          try {
            if (window.jQuery) {
              window.jQuery('.swiper-container, .slick-slider, .owl-carousel').each(function() {
                if (this.swiper && this.swiper.autoplay) this.swiper.autoplay.stop();
                if (window.jQuery(this).slick) window.jQuery(this).slick('slickPause');
              });
            }
          } catch(e) {}
        })()
      \`);

      await page.evaluate(\`(document.fonts ? document.fonts.ready : Promise.resolve())\`);

      // Scroll full page for lazy load
      await page.evaluate(\`
        new Promise(function(resolve) {
          window.scrollTo(0, document.body.scrollHeight || document.documentElement.scrollHeight);
          setTimeout(function() {
            window.scrollTo(0, 0);
            resolve();
          }, 50);
        })
      \`);

      await page.waitForTimeout(100);

      const screenshotPath = path.join(outputDir, vp.name + '.png');
      await page.screenshot({ path: screenshotPath, fullPage: true });

      // In-page layout evaluation with removal-based culprit detection and scope mapping
      const evaluationScript = \`
        (function(viewportName) {
          var issues = [];
          var winWidth = window.innerWidth;
          var scrollWidth = Math.max(
            document.documentElement.scrollWidth,
            document.body ? document.body.scrollWidth : 0
          );
          var hasHorizontalOverflow = scrollWidth > winWidth + 1;

          var getElementorId = function(el) {
            if (!el) return null;
            var current = el;
            while (current && current !== document.body && current !== document.documentElement) {
              var dataId = current.getAttribute('data-id');
              if (dataId) return dataId;
              var elClass = current.getAttribute('class') || '';
              if (typeof elClass === 'string' && elClass.indexOf('elementor-element-') !== -1) {
                var match = elClass.match(/elementor-element-([a-zA-Z0-9_-]+)/);
                if (match && match[1]) return match[1];
              }
              current = current.parentElement;
            }
            return null;
          };

          var getScope = function(el) {
            if (!el) return 'unmapped';
            if (el.closest('#wpadminbar')) return 'wpadminbar';
            if (el.closest('.elementor-element[data-id]')) return 'elementor';
            if (el.closest('header, footer, .offcanvas, .offcanvas__area, .header__area, .footer__area, [class*="header"], [class*="footer"]') || !el.closest('.elementor')) {
              return 'theme';
            }
            return 'unmapped';
          };

          var getElementSelector = function(el) {
            if (!el) return 'html';
            if (el.id) return '#' + el.id;
            var dataId = el.getAttribute('data-id');
            if (dataId) return '[data-id="' + dataId + '"]';
            var path = el.tagName.toLowerCase();
            if (el.className && typeof el.className === 'string') {
              var classes = el.className.trim().split(/\\s+/).slice(0, 2).join('.');
              if (classes) path += '.' + classes;
            }
            return path;
          };

          var isVisible = function(el) {
            if (!el) return false;
            var rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return false;
            var style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
              return false;
            }
            return true;
          };

          var isIgnoredForOverflow = function(el) {
            if (!isVisible(el)) return true;
            var style = window.getComputedStyle(el);
            if (style.position === 'fixed') return true;

            // Check if inside a closed offcanvas or aria-hidden drawer
            var closedDrawer = el.closest('.offcanvas:not(.show), [aria-hidden="true"], .offcanvas__area:not(.show)');
            if (closedDrawer) return true;

            // Check if clipped by an ancestor with overflow hidden/auto/clip
            var curr = el.parentElement;
            while (curr && curr !== document.body && curr !== document.documentElement) {
              var pStyle = window.getComputedStyle(curr);
              var pPos = pStyle.position;
              if (pPos === 'fixed') return true;
              if (pStyle.overflow === 'hidden' || pStyle.overflowX === 'hidden' || pStyle.overflow === 'clip' || pStyle.overflowX === 'clip') {
                var pRect = curr.getBoundingClientRect();
                if (pRect.right <= winWidth + 1) {
                  return true;
                }
              }
              curr = curr.parentElement;
            }
            return false;
          };

          var allElements = Array.prototype.slice.call(document.querySelectorAll('*'));

          // 1. Horizontal page overflow culprit detection by REMOVAL MEASUREMENT (P0 - Critical)
          if (hasHorizontalOverflow) {
            var initialScrollWidth = Math.max(
              document.documentElement.scrollWidth,
              document.body ? document.body.scrollWidth : 0
            );

            // Collect candidate elements exceeding innerWidth + 1
            var candidateElements = [];
            for (var i = 0; i < allElements.length; i++) {
              var el = allElements[i];
              if (el === document.documentElement || el === document.body) continue;
              if (isIgnoredForOverflow(el)) continue;

              var rect = el.getBoundingClientRect();
              if (rect.right > winWidth + 1 && rect.width > 0) {
                candidateElements.push({
                  el: el,
                  rect: rect,
                  right: rect.right,
                  elementId: getElementorId(el),
                  scope: getScope(el),
                  selector: getElementSelector(el)
                });
              }
            }

            // Sort descending by rect.right (largest overflow first), take up to 15 candidates
            candidateElements.sort(function(a, b) { return b.right - a.right; });
            var testCandidates = candidateElements.slice(0, 15);

            var confirmedCulprits = [];
            var maxReduction = 0;
            var bestCandidate = null;

            for (var c = 0; c < testCandidates.length; c++) {
              var cand = testCandidates[c];
              var originalDisplay = cand.el.style.display;

              // Hide candidate to measure scrollWidth change
              cand.el.style.display = 'none';
              var newScrollWidth = Math.max(
                document.documentElement.scrollWidth,
                document.body ? document.body.scrollWidth : 0
              );
              cand.el.style.display = originalDisplay;

              var reduction = initialScrollWidth - newScrollWidth;
              if (newScrollWidth <= winWidth + 1) {
                // Complete fix culprit
                confirmedCulprits.push({
                  candidate: cand,
                  reduction: reduction,
                  newScrollWidth: newScrollWidth,
                  overflowAmount: initialScrollWidth - winWidth
                });
              } else if (reduction > maxReduction) {
                maxReduction = reduction;
                bestCandidate = {
                  candidate: cand,
                  reduction: reduction,
                  newScrollWidth: newScrollWidth,
                  overflowAmount: initialScrollWidth - winWidth
                };
              }
            }

            if (confirmedCulprits.length > 0) {
              // Deduplicate confirmed culprits by elementId/selector
              var seenCulprits = {};
              for (var k = 0; k < confirmedCulprits.length; k++) {
                var item = confirmedCulprits[k];
                var key = item.candidate.elementId || item.candidate.selector;
                if (!seenCulprits[key]) {
                  seenCulprits[key] = true;
                  issues.push({
                    type: 'horizontal_overflow',
                    severity: 'P0',
                    elementId: item.candidate.elementId,
                    scope: item.candidate.scope,
                    selector: item.candidate.selector,
                    outerHtmlSnippet: item.candidate.el.outerHTML ? item.candidate.el.outerHTML.slice(0, 200) : '',
                    viewport: viewportName,
                    confirmedByRemoval: true,
                    message: 'Page content width (' + initialScrollWidth + 'px) overflows viewport (' + winWidth + 'px) by ' + item.overflowAmount + 'px. Confirmed culprit by removal measurement.',
                    details: {
                      scrollWidth: initialScrollWidth,
                      viewportWidth: winWidth,
                      overflowAmount: item.overflowAmount,
                      confirmedByRemoval: true,
                      reduction: item.reduction
                    }
                  });
                }
              }
            } else if (bestCandidate && maxReduction > 0) {
              // Best candidate that reduces overflow the most
              issues.push({
                type: 'horizontal_overflow',
                severity: 'P0',
                elementId: bestCandidate.candidate.elementId,
                scope: bestCandidate.candidate.scope,
                selector: bestCandidate.candidate.selector,
                outerHtmlSnippet: bestCandidate.candidate.el.outerHTML ? bestCandidate.candidate.el.outerHTML.slice(0, 200) : '',
                viewport: viewportName,
                confirmedByRemoval: true,
                message: 'Page content width (' + initialScrollWidth + 'px) overflows viewport (' + winWidth + 'px) by ' + bestCandidate.overflowAmount + 'px. Removing element reduced overflow by ' + maxReduction + 'px.',
                details: {
                  scrollWidth: initialScrollWidth,
                  viewportWidth: winWidth,
                  overflowAmount: bestCandidate.overflowAmount,
                  confirmedByRemoval: true,
                  reduction: maxReduction
                }
              });
            } else {
              // Multi-cause overflow when no single element resolves it
              issues.push({
                type: 'multi_cause_overflow',
                severity: 'P0',
                elementId: candidateElements.length > 0 ? candidateElements[0].elementId : null,
                scope: candidateElements.length > 0 ? candidateElements[0].scope : 'unmapped',
                selector: candidateElements.length > 0 ? candidateElements[0].selector : 'html',
                outerHtmlSnippet: candidateElements.length > 0 && candidateElements[0].el ? candidateElements[0].el.outerHTML.slice(0, 200) : '',
                viewport: viewportName,
                confirmedByRemoval: false,
                message: 'Page content width (' + initialScrollWidth + 'px) overflows viewport (' + winWidth + 'px) with multiple contributing candidates.',
                details: {
                  scrollWidth: initialScrollWidth,
                  viewportWidth: winWidth,
                  overflowAmount: initialScrollWidth - winWidth,
                  candidateCount: candidateElements.length,
                  candidateSelectors: candidateElements.map(function(c) { return c.selector; })
                }
              });
            }
          }

          // 2. Elements overflowing viewport horizontally (P0 - Critical)
          var seenOverflowElements = {};
          for (var i = 0; i < allElements.length; i++) {
            var el = allElements[i];
            if (el === document.documentElement || el === document.body) continue;
            if (isIgnoredForOverflow(el)) continue;

            var rect = el.getBoundingClientRect();
            if (rect.right > winWidth + 1 && rect.width > 0) {
              var elementId = getElementorId(el);
              var scope = getScope(el);
              var selector = getElementSelector(el);
              var key = (elementId || selector) + '-' + Math.round(rect.right);

              if (!seenOverflowElements[key]) {
                seenOverflowElements[key] = true;
                issues.push({
                  type: 'overflowing_element',
                  severity: 'P0',
                  elementId: elementId,
                  scope: scope,
                  selector: selector,
                  outerHtmlSnippet: el.outerHTML ? el.outerHTML.slice(0, 200) : '',
                  viewport: viewportName,
                  message: 'Element overflows viewport right edge by ' + Math.round(rect.right - winWidth) + 'px (rect.right: ' + Math.round(rect.right) + 'px, innerWidth: ' + winWidth + 'px)',
                  details: {
                    right: rect.right,
                    width: rect.width,
                    viewportWidth: winWidth,
                    overflowPixels: Math.round(rect.right - winWidth)
                  }
                });
              }
            }
          }

          // 3. Small font sizes on mobile (< 12px threshold, P2 - Minor)
          // Aggregated per Elementor element (or per scope)
          if (viewportName === 'mobile') {
            var smallTextByGroup = {};

            for (var i = 0; i < allElements.length; i++) {
              var el = allElements[i];
              if (!isVisible(el)) continue;
              var directText = '';
              for (var c = 0; c < el.childNodes.length; c++) {
                if (el.childNodes[c].nodeType === 3) {
                  directText += el.childNodes[c].textContent || '';
                }
              }
              if (directText.trim().length > 0) {
                var style = window.getComputedStyle(el);
                var fontSize = parseFloat(style.fontSize);
                if (fontSize > 0 && fontSize < 12) {
                  var elementId = getElementorId(el);
                  var scope = getScope(el);
                  var selector = getElementSelector(el);
                  var groupKey = elementId ? elementId : (scope + '_' + selector);

                  // Detect fontSource
                  var fontSource = 'elementor_setting';
                  var inlineStyle = el.getAttribute('style') || '';
                  if (/font-size\\s*:/i.test(inlineStyle)) {
                    fontSource = 'inline';
                  } else {
                    var widget = el.closest('.elementor-widget');
                    if (widget && widget.querySelector('style')) {
                      fontSource = 'stylesheet';
                    }
                  }

                  if (!smallTextByGroup[groupKey]) {
                    smallTextByGroup[groupKey] = {
                      elementId: elementId,
                      scope: scope,
                      selector: selector,
                      outerHtmlSnippet: el.outerHTML ? el.outerHTML.slice(0, 200) : '',
                      count: 0,
                      minFontSize: fontSize,
                      fontSource: fontSource,
                      sampleTexts: []
                    };
                  }
                  smallTextByGroup[groupKey].count++;
                  if (fontSize < smallTextByGroup[groupKey].minFontSize) {
                    smallTextByGroup[groupKey].minFontSize = fontSize;
                  }
                  if (fontSource === 'inline') {
                    smallTextByGroup[groupKey].fontSource = 'inline';
                  }
                  if (smallTextByGroup[groupKey].sampleTexts.length < 3) {
                    smallTextByGroup[groupKey].sampleTexts.push(directText.trim().slice(0, 40));
                  }
                }
              }
            }

            for (var gKey in smallTextByGroup) {
              var group = smallTextByGroup[gKey];
              issues.push({
                type: 'small_font_size',
                severity: 'P2',
                elementId: group.elementId,
                scope: group.scope,
                selector: group.selector,
                outerHtmlSnippet: group.outerHtmlSnippet,
                fontSource: group.fontSource,
                viewport: viewportName,
                message: 'Found ' + group.count + ' text node(s) below 12px threshold (minimum detected: ' + group.minFontSize + 'px)',
                details: {
                  count: group.count,
                  minFontSize: group.minFontSize,
                  threshold: 12,
                  fontSource: group.fontSource,
                  samples: group.sampleTexts
                }
              });
            }
          }

          // 4. Tap targets smaller than 44x44px on mobile (P1 - Major)
          if (viewportName === 'mobile') {
            var interactiveSelectors = 'a, button, input:not([type="hidden"]), select, textarea, [role="button"], [onclick], .elementor-button';
            var interactives = Array.prototype.slice.call(document.querySelectorAll(interactiveSelectors));
            for (var i = 0; i < interactives.length; i++) {
              var el = interactives[i];
              if (!isVisible(el)) continue;
              var rect = el.getBoundingClientRect();
              if ((rect.width < 44 || rect.height < 44) && rect.width > 0 && rect.height > 0) {
                var elementId = getElementorId(el);
                var scope = getScope(el);
                issues.push({
                  type: 'small_tap_target',
                  severity: 'P1',
                  elementId: elementId,
                  scope: scope,
                  selector: getElementSelector(el),
                  outerHtmlSnippet: el.outerHTML ? el.outerHTML.slice(0, 200) : '',
                  viewport: viewportName,
                  message: 'Tap target is too small (' + Math.round(rect.width) + 'x' + Math.round(rect.height) + 'px). Minimum required on mobile is 44x44px',
                  details: {
                    width: Math.round(rect.width),
                    height: Math.round(rect.height),
                    tag: el.tagName.toLowerCase(),
                    text: (el.innerText || el.getAttribute('aria-label') || '').slice(0, 30)
                  }
                });
              }
            }
          }

          // 5. Overlapping sibling elements (P1 - Major)
          var parentContainers = Array.prototype.slice.call(document.querySelectorAll('.elementor-widget-wrap, .elementor-container, [data-id]'));
          var seenOverlapPairs = {};

          for (var p = 0; p < parentContainers.length; p++) {
            var parent = parentContainers[p];
            var children = Array.prototype.slice.call(parent.children).filter(isVisible);
            if (children.length < 2) continue;

            for (var i = 0; i < children.length; i++) {
              for (var j = i + 1; j < children.length; j++) {
                var elA = children[i];
                var elB = children[j];
                var rectA = elA.getBoundingClientRect();
                var rectB = elB.getBoundingClientRect();

                var overlapW = Math.max(0, Math.min(rectA.right, rectB.right) - Math.max(rectA.left, rectB.left));
                var overlapH = Math.max(0, Math.min(rectA.bottom, rectB.bottom) - Math.max(rectA.top, rectB.top));
                var overlapArea = overlapW * overlapH;
                var areaA = rectA.width * rectA.height;
                var areaB = rectB.width * rectB.height;
                var minArea = Math.min(areaA, areaB);

                if (minArea > 50 && (overlapArea / minArea) > 0.1) {
                  var idA = getElementorId(elA) || getElementSelector(elA);
                  var idB = getElementorId(elB) || getElementSelector(elB);
                  var pairKey = [idA, idB].sort().join(':::');

                  if (!seenOverlapPairs[pairKey]) {
                    seenOverlapPairs[pairKey] = true;
                    var overlapPercent = Math.round((overlapArea / minArea) * 100);
                    var elTarget = elB;
                    var elementId = getElementorId(elTarget) || getElementorId(elA);
                    var scope = getScope(elTarget);

                    issues.push({
                      type: 'overlapping_elements',
                      severity: 'P1',
                      elementId: elementId,
                      scope: scope,
                      selector: getElementSelector(elA) + ' & ' + getElementSelector(elB),
                      outerHtmlSnippet: elTarget.outerHTML ? elTarget.outerHTML.slice(0, 200) : '',
                      viewport: viewportName,
                      message: 'Sibling elements overlap by ' + overlapPercent + '% of bounding area (' + Math.round(overlapArea) + 'px²)',
                      details: {
                        elementA: idA,
                        elementB: idB,
                        overlapPercentage: overlapPercent,
                        overlapArea: overlapArea
                      }
                    });
                  }
                }
              }
            }
          }

          // 6. Images / iframes wider than their container (P0 - Critical)
          var mediaElements = Array.prototype.slice.call(document.querySelectorAll('img, iframe, svg, video'));
          for (var i = 0; i < mediaElements.length; i++) {
            var media = mediaElements[i];
            if (!isVisible(media)) continue;
            var container = media.parentElement;
            if (container && isVisible(container)) {
              var mediaRect = media.getBoundingClientRect();
              var contRect = container.getBoundingClientRect();
              if (mediaRect.width > contRect.width + 2 && contRect.width > 0) {
                var elementId = getElementorId(media);
                var scope = getScope(media);
                issues.push({
                  type: 'image_wider_than_container',
                  severity: 'P0',
                  elementId: elementId,
                  scope: scope,
                  selector: getElementSelector(media),
                  outerHtmlSnippet: media.outerHTML ? media.outerHTML.slice(0, 200) : '',
                  viewport: viewportName,
                  message: 'Media element (' + Math.round(mediaRect.width) + 'px) is wider than parent container (' + Math.round(contRect.width) + 'px)',
                  details: {
                    mediaWidth: Math.round(mediaRect.width),
                    containerWidth: Math.round(contRect.width),
                    tag: media.tagName.toLowerCase()
                  }
                });
              }
            }
          }

          // 7. Elements with fixed pixel widths greater than viewport width (P0 - Critical)
          for (var i = 0; i < allElements.length; i++) {
            var el = allElements[i];
            if (el === document.documentElement || el === document.body) continue;
            if (!isVisible(el)) continue;
            var style = window.getComputedStyle(el);
            var rect = el.getBoundingClientRect();
            var inlineWidth = el.style.width;

            if (inlineWidth && inlineWidth.indexOf('px') !== -1) {
              var pixelWidth = parseFloat(inlineWidth);
              if (pixelWidth > winWidth) {
                var elementId = getElementorId(el);
                var scope = getScope(el);
                issues.push({
                  type: 'fixed_pixel_width_overflow',
                  severity: 'P0',
                  elementId: elementId,
                  scope: scope,
                  selector: getElementSelector(el),
                  outerHtmlSnippet: el.outerHTML ? el.outerHTML.slice(0, 200) : '',
                  viewport: viewportName,
                  message: 'Element has inline fixed width of ' + pixelWidth + 'px exceeding viewport width (' + winWidth + 'px)',
                  details: {
                    fixedWidth: pixelWidth,
                    viewportWidth: winWidth
                  }
                });
              }
            }
          }

          return issues;
        })('\${vp.name}')
      \`;

      const issues: Issue[] = await page.evaluate(evaluationScript);

      return {
        viewport: vp.name,
        width: vp.width,
        height: vp.height,
        screenshotPath,
        hasHorizontalOverflow: issues.some((i) => i.type === 'horizontal_overflow' || i.type === 'multi_cause_overflow'),
        scrollWidth: await page.evaluate('Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0)'),
        innerWidth: vp.width,
        issues,
      };
    } finally {
      await context.close();
    }
  }
}
\`;

fs.writeFileSync('/home/uday/Agents/Responsive Plugin/agent/src/audit/auditor.ts', code, 'utf-8');
console.log('auditor.ts written successfully');
