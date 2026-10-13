import { chromium, Browser, BrowserContextOptions } from 'playwright';
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
  customCss?: string;
  viewports?: ViewportConfig[];
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
          const match = url.match(/\/fixtures\/([^/]+)/);
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
          if (wpPage && wpPage._elementor_data) {
            elementorData = wpPage._elementor_data;
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
      const viewportsResult: Record<string, ViewportAuditResult> = {};
      const allIssues: Issue[] = [];
      const severityCounts: Record<SeverityTier, number> = { P0: 0, P1: 0, P2: 0 };
      const scopeCounts: Record<IssueScope, number> = { elementor: 0, theme: 0, wpadminbar: 0, unmapped: 0 };
      let patchableCount = 0;
      let unpatchableCount = 0;

      const targetViewports = options.viewports || VIEWPORTS;
      for (const vp of targetViewports) {
        const result = await this.auditViewport(browser, url, vp, outputDir, options.customCss);
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
    return `page_${Date.now()}`;
  }

  private async auditViewport(
    browser: Browser,
    url: string,
    vp: ViewportConfig,
    outputDir: string,
    customCss?: string
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
          `[LOGIN WALL ERROR] HTTP 401 Unauthorized encountered at "${url}". Please provide valid STAGING_BASIC_AUTH_USER and STAGING_BASIC_AUTH_PASS in .env.`
        );
      }

      const finalUrl = page.url();
      if (finalUrl.includes('wp-login.php') || finalUrl.includes('/login')) {
        throw new Error(
          `[LOGIN WALL ERROR] Redirected to WordPress login page (${finalUrl}). Please ensure the target staging page is publicly accessible or authenticated.`
        );
      }

      // Check for login forms or active admin presence
      const hasLoginForm = await page.evaluate(
        'Boolean(document.querySelector("#user_login, #loginform, form.login-form, input[type=\\"password\\"]#pwd"))'
      );
      if (hasLoginForm && !url.includes('fixtures')) {
        throw new Error(
          `[LOGIN WALL ERROR] Page "${url}" contains a password login form. Aborting audit to prevent measuring the login screen.`
        );
      }

      // Check for logged-in admin bar or body.logged-in (Fix 4)
      const hasAdminPresence = await page.evaluate(
        'Boolean(document.querySelector("#wpadminbar") || (document.body && document.body.classList.contains("logged-in")))'
      );
      if (hasAdminPresence && !url.includes('fixtures')) {
        throw new Error(
          `[LOGGED-IN AUDIT ERROR] Page "${url}" was loaded with active admin presence (#wpadminbar or body.logged-in). Audits must strictly run logged out.`
        );
      }

      // Disable animations & transitions, including Vispan reveal animations
      await page.addStyleTag({
        content: `
          *, *::before, *::after {
            animation: none !important;
            transition: none !important;
            scroll-behavior: auto !important;
          }
          .swiper-wrapper, .slick-track, .owl-stage {
            transform: none !important;
          }
          .vispan-reveal-right, .vispan-reveal-left, .vispan-reveal-up, [class*="vispan-reveal"] {
            transform: none !important;
            opacity: 1 !important;
            transition: none !important;
            animation: none !important;
          }
        `,
      });

      if (customCss) {
        await page.addStyleTag({ content: customCss });
        await page.waitForTimeout(100);
      }

      // Pause carousel autoplay
      await page.evaluate(`
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
      `);

      await page.evaluate(`(document.fonts ? document.fonts.ready : Promise.resolve())`);

      // Measure early baseline before lazy scroll and fullpage screenshot alter layout
      const earlyLayout = (await page.evaluate(`
        (function() {
          var w = Math.max(
            document.documentElement.scrollWidth,
            document.body ? document.body.scrollWidth : 0
          );
          return {
            scrollWidth: w,
            hasHorizontalOverflow: w > window.innerWidth + 1
          };
        })()
      `)) as { scrollWidth: number; hasHorizontalOverflow: boolean };

      // Scroll full page for lazy load
      await page.evaluate(`
        new Promise(function(resolve) {
          window.scrollTo(0, document.body.scrollHeight || document.documentElement.scrollHeight);
          setTimeout(function() {
            window.scrollTo(0, 0);
            resolve();
          }, 100);
        })
      `);

      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(200);

      const screenshotPath = path.join(outputDir, `${vp.name}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });

      // In-page layout evaluation with removal-based culprit detection and scope mapping
      const evaluationScript = `
        (function(viewportName, earlyScrollWidth) {
          var issues = [];
          var winWidth = window.innerWidth;
          var currentScrollWidth = Math.max(
            document.documentElement.scrollWidth,
            document.body ? document.body.scrollWidth : 0
          );
          var scrollWidth = Math.max(currentScrollWidth, earlyScrollWidth || 0);
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
          var confirmedCulpritElementIds = {};

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

            // Test 1: One-at-a-time removal test
            for (var c = 0; c < testCandidates.length; c++) {
              var cand = testCandidates[c];
              var originalDisplay = cand.el.style.display;

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

            // Test 2: Group candidates by common Elementor ancestor and test each ancestor
            var seenAncestors = {};
            for (var c = 0; c < testCandidates.length; c++) {
              var elWidget = testCandidates[c].el.closest('.elementor-element[data-id], .elementor-container, .elementor-section');
              if (elWidget && !seenAncestors[elWidget]) {
                seenAncestors[elWidget] = true;
                var origAncDisplay = elWidget.style.display;
                elWidget.style.display = 'none';
                var ancScrollWidth = Math.max(
                  document.documentElement.scrollWidth,
                  document.body ? document.body.scrollWidth : 0
                );
                elWidget.style.display = origAncDisplay;

                if (ancScrollWidth <= winWidth + 1) {
                  confirmedCulprits.push({
                    candidate: {
                      el: elWidget,
                      rect: elWidget.getBoundingClientRect(),
                      right: elWidget.getBoundingClientRect().right,
                      elementId: getElementorId(elWidget),
                      scope: getScope(elWidget),
                      selector: getElementSelector(elWidget)
                    },
                    reduction: initialScrollWidth - ancScrollWidth,
                    newScrollWidth: ancScrollWidth,
                    overflowAmount: initialScrollWidth - winWidth
                  });
                }
              }
            }

            // Test 3: Test hiding ALL candidates together
            var origDisplays = [];
            for (var c = 0; c < testCandidates.length; c++) {
              origDisplays.push(testCandidates[c].el.style.display);
              testCandidates[c].el.style.display = 'none';
            }
            var allHiddenScrollWidth = Math.max(
              document.documentElement.scrollWidth,
              document.body ? document.body.scrollWidth : 0
            );
            for (var c = 0; c < testCandidates.length; c++) {
              testCandidates[c].el.style.display = origDisplays[c];
            }

            if (confirmedCulprits.length > 0) {
              var seenCulprits = {};
              for (var k = 0; k < confirmedCulprits.length; k++) {
                var item = confirmedCulprits[k];
                var key = item.candidate.elementId || item.candidate.selector;
                if (!seenCulprits[key]) {
                  seenCulprits[key] = true;
                  if (item.candidate.elementId) {
                    confirmedCulpritElementIds[item.candidate.elementId] = true;
                  }
                  issues.push({
                    type: 'horizontal_overflow',
                    severity: 'P0',
                    elementId: item.candidate.elementId,
                    scope: item.candidate.scope,
                    selector: item.candidate.selector,
                    outerHtmlSnippet: item.candidate.el.outerHTML ? Array.from(item.candidate.el.outerHTML).slice(0, 200).join('') : '',
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
              if (bestCandidate.candidate.elementId) {
                confirmedCulpritElementIds[bestCandidate.candidate.elementId] = true;
              }
              issues.push({
                type: 'horizontal_overflow',
                severity: 'P0',
                elementId: bestCandidate.candidate.elementId,
                scope: bestCandidate.candidate.scope,
                selector: bestCandidate.candidate.selector,
                outerHtmlSnippet: bestCandidate.candidate.el.outerHTML ? Array.from(bestCandidate.candidate.el.outerHTML).slice(0, 200).join('') : '',
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
              // Multi-cause overflow when all candidates contribute together
              issues.push({
                type: 'multi_cause_overflow',
                severity: 'P0',
                elementId: candidateElements.length > 0 ? candidateElements[0].elementId : null,
                scope: candidateElements.length > 0 ? candidateElements[0].scope : 'unmapped',
                selector: candidateElements.length > 0 ? candidateElements[0].selector : 'html',
                outerHtmlSnippet: candidateElements.length > 0 && candidateElements[0].el ? Array.from(candidateElements[0].el.outerHTML).slice(0, 200).join('') : '',
                viewport: viewportName,
                confirmedByRemoval: false,
                message: 'Page content width (' + initialScrollWidth + 'px) overflows viewport (' + winWidth + 'px) with multiple contributing candidates (all candidates together resolve overflow: ' + (allHiddenScrollWidth <= winWidth + 1) + ').',
                details: {
                  scrollWidth: initialScrollWidth,
                  viewportWidth: winWidth,
                  overflowAmount: initialScrollWidth - winWidth,
                  allHiddenResolves: allHiddenScrollWidth <= winWidth + 1,
                  candidateCount: candidateElements.length,
                  candidateSelectors: candidateElements.map(function(c) { return c.selector; })
                }
              });
            }
          }

          var checkAnimationOverflow = function(candEl) {
            var cs = window.getComputedStyle(candEl);
            var hasTransform = cs.transform && cs.transform !== 'none';
            var hasAnim = (cs.animationName && cs.animationName !== 'none') || Boolean(candEl.closest('[class*="vispan-reveal"], [class*="reveal"], [class*="animate"], [class*="slide"]'));
            if (!hasTransform && !hasAnim) return null;

            var origTransform = candEl.style.transform;
            candEl.style.transform = 'none';
            var anc = candEl.closest('[class*="vispan-reveal"], [class*="reveal"]');
            var origAncTransform = anc ? anc.style.transform : null;
            if (anc) anc.style.transform = 'none';

            var rectAfter = candEl.getBoundingClientRect();
            candEl.style.transform = origTransform;
            if (anc && origAncTransform !== null) anc.style.transform = origAncTransform;

            if (rectAfter.right <= winWidth + 1) {
              return {
                transform: cs.transform,
                animationName: cs.animationName,
                animationFillMode: cs.animationFillMode,
                className: candEl.className
              };
            }
            return null;
          };

          // 2. Elements overflowing viewport horizontally (P0 - Critical or P1 - Animation)
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
                var isConfirmed = Boolean(elementId && confirmedCulpritElementIds[elementId]);
                var animInfo = checkAnimationOverflow(el);

                if (animInfo) {
                  issues.push({
                    type: 'animation_overflow',
                    severity: 'P1',
                    elementId: elementId,
                    scope: scope,
                    selector: selector,
                    outerHtmlSnippet: el.outerHTML ? Array.from(el.outerHTML).slice(0, 200).join('') : '',
                    viewport: viewportName,
                    confirmedByRemoval: isConfirmed,
                    message: 'Element overflow is caused by active animation transform (' + animInfo.transform + ' on ' + (animInfo.className || selector) + ')',
                    details: {
                      right: rect.right,
                      width: rect.width,
                      viewportWidth: winWidth,
                      overflowPixels: Math.round(rect.right - winWidth),
                      transform: animInfo.transform,
                      animationName: animInfo.animationName,
                      animationFillMode: animInfo.animationFillMode,
                      className: animInfo.className
                    }
                  });
                } else {
                  issues.push({
                    type: 'overflowing_element',
                    severity: 'P0',
                    elementId: elementId,
                    scope: scope,
                    selector: selector,
                    outerHtmlSnippet: el.outerHTML ? Array.from(el.outerHTML).slice(0, 200).join('') : '',
                    viewport: viewportName,
                    confirmedByRemoval: isConfirmed,
                    message: (isConfirmed ? 'Confirmed culprit element' : 'Candidate element') + ' overflows viewport right edge by ' + Math.round(rect.right - winWidth) + 'px (rect.right: ' + Math.round(rect.right) + 'px, innerWidth: ' + winWidth + 'px)',
                    details: {
                      right: rect.right,
                      width: rect.width,
                      viewportWidth: winWidth,
                      overflowPixels: Math.round(rect.right - winWidth),
                      confirmedByRemoval: isConfirmed
                    }
                  });
                }
              }
            }
          }

          // 3. Small font sizes on mobile (< 12px threshold, P2 - Minor)
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
                      outerHtmlSnippet: el.outerHTML ? Array.from(el.outerHTML).slice(0, 200).join('') : '',
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
                  outerHtmlSnippet: el.outerHTML ? Array.from(el.outerHTML).slice(0, 200).join('') : '',
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

          // 5. Overlapping sibling elements & Smashed horizontal collisions (P1 - Major)
          var containerSelectors = 'header, nav, main, section, [data-id], .elementor-widget-wrap, .elementor-container, .elementor-widget-html, [class*="header"], [class*="nav"], [class*="menu"], [class*="row"]';
          var parentContainers = Array.prototype.slice.call(document.querySelectorAll(containerSelectors));

          for (var idx = 0; idx < allElements.length; idx++) {
            var elItem = allElements[idx];
            var disp = window.getComputedStyle(elItem).display;
            if ((disp === 'flex' || disp === 'inline-flex' || disp === 'grid') && parentContainers.indexOf(elItem) === -1) {
              parentContainers.push(elItem);
            }
          }

          var seenCollisionPairs = {};

          for (var p = 0; p < parentContainers.length; p++) {
            var parent = parentContainers[p];
            var children = Array.prototype.slice.call(parent.children).filter(isVisible);
            if (children.length < 2) continue;

            for (var i = 0; i < children.length; i++) {
              for (var j = i + 1; j < children.length; j++) {
                var elA = children[i];
                var elB = children[j];
                var sA = window.getComputedStyle(elA);
                var sB = window.getComputedStyle(elB);
                if (sA.position === 'fixed' || sB.position === 'fixed') continue;
                var isPositioned = sA.position === 'absolute' || sB.position === 'absolute';

                // Skip top-level column containers designed to touch side-by-side in a row
                var isColA = elA.classList && (elA.classList.contains('elementor-column') || elA.classList.contains('elementor-top-column') || (typeof elA.className === 'string' && elA.className.indexOf('elementor-col-') !== -1));
                var isColB = elB.classList && (elB.classList.contains('elementor-column') || elB.classList.contains('elementor-top-column') || (typeof elB.className === 'string' && elB.className.indexOf('elementor-col-') !== -1));
                if (isColA && isColB) continue;

                var rA = elA.getBoundingClientRect();
                var rB = elB.getBoundingClientRect();

                // Order left-to-right
                var isALeft = rA.left <= rB.left;
                var leftEl = isALeft ? elA : elB;
                var rightEl = isALeft ? elB : elA;
                var rLeft = isALeft ? rA : rB;
                var rRight = isALeft ? rB : rA;

                var vOverlap = Math.min(rLeft.bottom, rRight.bottom) - Math.max(rLeft.top, rRight.top);
                var minH = Math.min(rLeft.height, rRight.height);

                if (vOverlap >= Math.min(12, minH * 0.5)) {
                  var hOverlap = Math.max(0, Math.min(rLeft.right, rRight.right) - Math.max(rLeft.left, rRight.left));
                  var overlapArea = hOverlap * vOverlap;
                  var minArea = Math.min(rLeft.width * rLeft.height, rRight.width * rRight.height);
                  var hGap = rRight.left - rLeft.right;

                  var textA = (leftEl.innerText || '').trim();
                  var textB = (rightEl.innerText || '').trim();
                  var hasTextA = textA.length > 0;
                  var hasTextB = textB.length > 0;

                  var isOverlap = minArea > 50 && (overlapArea / minArea) > 0.05;
                  var isSmashed = !isPositioned && hasTextA && hasTextB && hGap <= 2 && hGap >= -5 && rLeft.width > 20 && rRight.width > 20;

                  if (isOverlap || isSmashed) {
                    var idA = getElementorId(leftEl) || getElementSelector(leftEl);
                    var idB = getElementorId(rightEl) || getElementSelector(rightEl);
                    var pairKey = [idA, idB].sort().join(':::');

                    if (!seenCollisionPairs[pairKey]) {
                      seenCollisionPairs[pairKey] = true;
                      var elementId = getElementorId(rightEl) || getElementorId(leftEl);
                      var scope = getScope(rightEl);

                      if (isOverlap) {
                        var overlapPercent = Math.round((overlapArea / minArea) * 100);
                        issues.push({
                          type: 'overlapping_elements',
                          severity: 'P1',
                          elementId: elementId,
                          scope: scope,
                          selector: getElementSelector(leftEl) + ' & ' + getElementSelector(rightEl),
                          outerHtmlSnippet: rightEl.outerHTML ? Array.from(rightEl.outerHTML).slice(0, 200).join('') : '',
                          viewport: viewportName,
                          message: 'Sibling elements overlap by ' + overlapPercent + '% of bounding area (' + Math.round(overlapArea) + 'px²)',
                          details: {
                            elementA: idA,
                            elementB: idB,
                            overlapPercentage: overlapPercent,
                            overlapArea: overlapArea
                          }
                        });
                      } else {
                        issues.push({
                          type: 'layout_collision',
                          severity: 'P1',
                          elementId: elementId,
                          scope: scope,
                          selector: getElementSelector(leftEl) + ' & ' + getElementSelector(rightEl),
                          outerHtmlSnippet: rightEl.outerHTML ? Array.from(rightEl.outerHTML).slice(0, 200).join('') : '',
                          viewport: viewportName,
                          message: 'Sibling elements collided with 0px gap (' + textA.slice(0, 15) + '... and ' + textB.slice(0, 15) + '... are squished together without spacing)',
                          details: {
                            elementA: idA,
                            elementB: idB,
                            horizontalGap: Math.round(hGap),
                            verticalOverlap: Math.round(vOverlap)
                          }
                        });
                      }
                    }
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
                  outerHtmlSnippet: media.outerHTML ? Array.from(media.outerHTML).slice(0, 200).join('') : '',
                  viewport: viewportName,
                  confirmedByRemoval: false,
                  message: 'Media element (' + Math.round(mediaRect.width) + 'px) is wider than parent container (' + Math.round(contRect.width) + 'px)',
                  details: {
                    mediaWidth: Math.round(mediaRect.width),
                    containerWidth: Math.round(contRect.width),
                    tag: media.tagName.toLowerCase(),
                    confirmedByRemoval: false
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
                  outerHtmlSnippet: el.outerHTML ? Array.from(el.outerHTML).slice(0, 200).join('') : '',
                  viewport: viewportName,
                  confirmedByRemoval: false,
                  message: 'Element has inline fixed width of ' + pixelWidth + 'px exceeding viewport width (' + winWidth + 'px)',
                  details: {
                    fixedWidth: pixelWidth,
                    viewportWidth: winWidth,
                    confirmedByRemoval: false
                  }
                });
              }
            }
          }

          // 8. Container content bleed: child elements bleeding past styled/colored container bottoms
          var styledContainers = Array.prototype.slice.call(document.querySelectorAll('section, .elementor-section, .elementor-top-section, [class*="section"], [class*="card"]'));
          var seenBleedContainers = {};
          for (var i = 0; i < styledContainers.length; i++) {
            var container = styledContainers[i];
            if (!isVisible(container)) continue;
            var cStyle = window.getComputedStyle(container);
            var hasBg = (cStyle.backgroundColor && cStyle.backgroundColor !== 'rgba(0, 0, 0, 0)' && cStyle.backgroundColor !== 'transparent') ||
                        (cStyle.backgroundImage && cStyle.backgroundImage !== 'none');
            if (!hasBg) continue;

            var cRect = container.getBoundingClientRect();
            if (cRect.height <= 0) continue;

            var children = Array.prototype.slice.call(container.querySelectorAll('*'));
            for (var ch = 0; ch < children.length; ch++) {
              var child = children[ch];
              if (!isVisible(child)) continue;
              var chStyle = window.getComputedStyle(child);
              if (chStyle.position === 'fixed') continue;

              var chRect = child.getBoundingClientRect();
              if (chRect.bottom > cRect.bottom + 8 && chRect.height > 10) {
                var cId = getElementorId(container) || getElementSelector(container);
                if (!seenBleedContainers[cId]) {
                  seenBleedContainers[cId] = true;
                  var elementId = getElementorId(child) || getElementorId(container);
                  var scope = getScope(child);
                  var bleedPx = Math.round(chRect.bottom - cRect.bottom);
                  issues.push({
                    type: 'container_bleed',
                    severity: 'P0',
                    elementId: elementId,
                    scope: scope,
                    selector: getElementSelector(child) + ' inside ' + getElementSelector(container),
                    outerHtmlSnippet: child.outerHTML ? Array.from(child.outerHTML).slice(0, 200).join('') : '',
                    viewport: viewportName,
                    confirmedByRemoval: false,
                    message: 'Child element overflows past styled container bottom by ' + bleedPx + 'px (causes visual cutoff / bleeding onto page background)',
                    details: {
                      container: cId,
                      childSelector: getElementSelector(child),
                      bleedPixels: bleedPx,
                      childBottom: Math.round(chRect.bottom),
                      containerBottom: Math.round(cRect.bottom)
                    }
                  });
                }
                break;
              }
            }
          }

          // 9. Vertical scroll truncation / cutoff: interactive elements or forms cut off
          var docScrollHeight = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
          var interactives = Array.prototype.slice.call(document.querySelectorAll('button[type="submit"], input[type="submit"], .elementor-button, [class*="submit"], [class*="inquiry-btn"]'));
          var seenTruncation = {};
          for (var i = 0; i < interactives.length; i++) {
            var btn = interactives[i];
            if (!isVisible(btn)) continue;
            var bRect = btn.getBoundingClientRect();
            var absoluteBottom = bRect.bottom + window.scrollY;

            // Check if absoluteBottom exceeds docScrollHeight
            if (absoluteBottom > docScrollHeight + 8) {
              var bId = getElementorId(btn) || getElementSelector(btn);
              if (!seenTruncation[bId]) {
                seenTruncation[bId] = true;
                issues.push({
                  type: 'scroll_truncation',
                  severity: 'P0',
                  elementId: getElementorId(btn),
                  scope: getScope(btn),
                  selector: getElementSelector(btn),
                  outerHtmlSnippet: btn.outerHTML ? Array.from(btn.outerHTML).slice(0, 200).join('') : '',
                  viewport: viewportName,
                  confirmedByRemoval: false,
                  message: 'Essential interactive element is positioned beyond reachable document scroll height (absoluteBottom: ' + Math.round(absoluteBottom) + 'px, scrollHeight: ' + Math.round(docScrollHeight) + 'px)',
                  details: {
                    absoluteBottom: Math.round(absoluteBottom),
                    docScrollHeight: Math.round(docScrollHeight)
                  }
                });
              }
            }
          }

          // 10. Margin collapse void: empty gap between last content section and footer
          var footerEl = document.querySelector('footer, .footer__area-8, [class*="footer"]');
          if (footerEl && isVisible(footerEl)) {
            var fRect = footerEl.getBoundingClientRect();
            var prevSec = footerEl.previousElementSibling;
            while (prevSec && (!isVisible(prevSec) || prevSec.tagName === 'SCRIPT' || prevSec.tagName === 'STYLE')) {
              prevSec = prevSec.previousElementSibling;
            }
            if (prevSec) {
              var pRect = prevSec.getBoundingClientRect();
              var gap = Math.round(fRect.top - pRect.bottom);
              if (gap > 25) {
                issues.push({
                  type: 'margin_collapse_void',
                  severity: 'P1',
                  elementId: getElementorId(footerEl),
                  scope: 'theme',
                  selector: getElementSelector(footerEl),
                  outerHtmlSnippet: footerEl.outerHTML ? Array.from(footerEl.outerHTML).slice(0, 200).join('') : '',
                  viewport: viewportName,
                  confirmedByRemoval: false,
                  message: 'Unstyled gap of ' + gap + 'px detected between content section and footer (caused by margin collapsing or missing containment)',
                  details: {
                    gapPixels: gap,
                    previousSection: getElementSelector(prevSec),
                    footerSelector: getElementSelector(footerEl)
                  }
                });
              }
            }
          }

          return issues;
        })('${vp.name}', ${earlyLayout.scrollWidth})
      `;

      const issues: Issue[] = await page.evaluate(evaluationScript);

      const currentScrollWidth = (await page.evaluate(
        'Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0)'
      )) as number;
      const reportedScrollWidth = Math.max(currentScrollWidth, earlyLayout.scrollWidth);

      // Vertical Scroll Reachability & Trap Evaluation (Invariant)
      const scrollMetrics = (await page.evaluate(`
        (function() {
          window.scrollTo(0, 999999);
          var docH = Math.max(
            document.documentElement.scrollHeight,
            document.body ? document.body.scrollHeight : 0
          );
          var winH = window.innerHeight;
          var maxScrollY = Math.max(0, docH - winH);
          var currentScrollY = window.scrollY;
          var bodyStyle = window.getComputedStyle(document.body);
          var htmlStyle = window.getComputedStyle(document.documentElement);

          var isSecondaryScrollTrap =
            (bodyStyle.overflowY === 'auto' || bodyStyle.overflowY === 'scroll') &&
            (htmlStyle.overflowY === 'auto' || htmlStyle.overflowY === 'scroll');

          var footer = document.querySelector('footer, .footer__area-8, [class*="footer"]');
          var fRect = footer ? footer.getBoundingClientRect() : null;
          var footerVisibleAtBottom = Boolean(
            fRect && fRect.top < winH && fRect.bottom > 0
          );

          window.scrollTo(0, 0);

          return {
            docScrollHeight: docH,
            maxScrollY: maxScrollY,
            finalScrollY: currentScrollY,
            canScrollToBottom: currentScrollY >= maxScrollY - 15,
            isSecondaryScrollTrap: isSecondaryScrollTrap,
            footerVisibleAtBottom: footerVisibleAtBottom,
            hasFooter: Boolean(footer),
            bodyOverflowY: bodyStyle.overflowY,
            bodyOverflowX: bodyStyle.overflowX
          };
        })()
      `)) as {
        docScrollHeight: number;
        maxScrollY: number;
        finalScrollY: number;
        canScrollToBottom: boolean;
        isSecondaryScrollTrap: boolean;
        footerVisibleAtBottom: boolean;
        hasFooter: boolean;
        bodyOverflowY: string;
        bodyOverflowX: string;
      };

      if (!scrollMetrics.canScrollToBottom && scrollMetrics.maxScrollY > 20) {
        issues.push({
          type: 'scroll_trap',
          severity: 'P0',
          elementId: null,
          scope: 'theme',
          selector: 'body',
          viewport: vp.name,
          confirmedByRemoval: false,
          message: `Vertical scroll trapped before end of page: stopped at ${Math.round(scrollMetrics.finalScrollY)}px (expected max ${Math.round(scrollMetrics.maxScrollY)}px). Interactive elements or footer are unreachable.`,
          details: scrollMetrics,
        });
      }

      if (scrollMetrics.isSecondaryScrollTrap) {
        issues.push({
          type: 'scroll_trap',
          severity: 'P1',
          elementId: null,
          scope: 'theme',
          selector: 'body',
          viewport: vp.name,
          confirmedByRemoval: false,
          message: `Secondary scroll container detected on <body> (computed overflow-y: ${scrollMetrics.bodyOverflowY}). Causes touch/wheel scrolling to get trapped in mobile/tablet views.`,
          details: scrollMetrics,
        });
      }

      if (scrollMetrics.hasFooter && !scrollMetrics.footerVisibleAtBottom && scrollMetrics.maxScrollY > 0) {
        issues.push({
          type: 'scroll_truncation',
          severity: 'P0',
          elementId: null,
          scope: 'theme',
          selector: 'footer',
          viewport: vp.name,
          confirmedByRemoval: false,
          message: `Footer or end-of-page content is not reachable or visible within viewport when scrolled to maximum document height.`,
          details: scrollMetrics,
        });
      }

      return {
        viewport: vp.name,
        width: vp.width,
        height: vp.height,
        screenshotPath,
        hasHorizontalOverflow:
          issues.some((i) => i.type === 'horizontal_overflow' || i.type === 'multi_cause_overflow') ||
          reportedScrollWidth > vp.width + 1,
        scrollWidth: reportedScrollWidth,
        innerWidth: vp.width,
        canScrollToBottom: scrollMetrics.canScrollToBottom,
        maxScrollY: scrollMetrics.maxScrollY,
        finalScrollY: scrollMetrics.finalScrollY,
        footerVisibleAtBottom: scrollMetrics.footerVisibleAtBottom,
        isScrollTrapped: scrollMetrics.isSecondaryScrollTrap || !scrollMetrics.canScrollToBottom,
        issues,
      };
    } finally {
      await context.close();
    }
  }
}
