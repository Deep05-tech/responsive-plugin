import fs from 'fs';
import path from 'path';
import { chromium, Browser, devices } from 'playwright';
import { EraBridgeClient, WpPageSummary } from '../bridge/client.js';
import { EraConfig, loadConfig } from '../config/index.js';
import {
  FormQcPageResult,
  FormQcSummary,
  FormDeviceResult,
  FormElementDetail,
  FormAncestorDetail,
} from './form-qc-types.js';

export interface FormQcOptions {
  limit?: number;
  all?: boolean;
  outputDir?: string;
  force?: boolean;
}

export class FormQcRunner {
  private config: EraConfig;
  private options: FormQcOptions;
  private client: EraBridgeClient;
  private outputDir: string;

  constructor(config?: EraConfig, options?: FormQcOptions) {
    this.config = config || loadConfig();
    this.options = options || {};
    this.client = new EraBridgeClient(this.config);
    this.outputDir = path.resolve(this.options.outputDir || 'output/qc-forms');
  }

  public async run(): Promise<{
    results: FormQcPageResult[];
    summary: FormQcSummary;
  }> {
    fs.mkdirSync(this.outputDir, { recursive: true });
    const screenshotsDir = path.join(this.outputDir, 'screenshots');
    fs.mkdirSync(screenshotsDir, { recursive: true });

    console.log('\n📡 Fetching pages from WordPress...');
    const allPages = await this.client.getPages();
    let pagesToProcess = allPages;

    if (this.options.limit && this.options.limit > 0) {
      pagesToProcess = allPages.slice(0, this.options.limit);
    }

    console.log(`📋 Total pages to audit: ${pagesToProcess.length} (out of ${allPages.length} discovered).`);

    const resultsJsonPath = path.join(this.outputDir, 'results.json');
    let existingResults: Record<number, FormQcPageResult> = {};
    if (fs.existsSync(resultsJsonPath) && !this.options.force) {
      try {
        const loaded: FormQcPageResult[] = JSON.parse(fs.readFileSync(resultsJsonPath, 'utf-8'));
        for (const item of loaded) {
          existingResults[item.id] = item;
        }
        console.log(`🔄 Found ${loaded.length} cached results in ${resultsJsonPath}.`);
      } catch (e) {
        // start fresh if unreadable
      }
    }

    const pagesQueue = pagesToProcess.filter((p) => this.options.force || !existingResults[p.id]);
    console.log(`🚀 Auditing ${pagesQueue.length} page(s) (testing forms and visibility)...`);

    const browser = await chromium.launch({ headless: true });
    const concurrency = 3;
    const workerResults: FormQcPageResult[] = [];

    const chunks: WpPageSummary[][] = [];
    for (let i = 0; i < pagesQueue.length; i += concurrency) {
      chunks.push(pagesQueue.slice(i, i + concurrency));
    }

    let completedCount = pagesToProcess.length - pagesQueue.length;

    for (const chunk of chunks) {
      const promises = chunk.map(async (pageSummary, idx) => {
        const workerId = idx + 1;
        completedCount++;
        console.log(`[Worker ${workerId}] [${completedCount}/${pagesToProcess.length}] Auditing Page #${pageSummary.id}: "${pageSummary.title.slice(0, 40)}"`);
        const pageRes = await this.auditPageForms(browser, pageSummary, screenshotsDir);
        return pageRes;
      });

      const resList = await Promise.all(promises);
      for (const r of resList) {
        existingResults[r.id] = r;
        workerResults.push(r);
      }

      const currentSorted = pagesToProcess.map((p) => existingResults[p.id]).filter(Boolean);
      fs.writeFileSync(resultsJsonPath, JSON.stringify(currentSorted, null, 2), 'utf-8');
    }

    await browser.close();

    const finalResults = pagesToProcess.map((p) => existingResults[p.id]).filter(Boolean);
    const summary = this.generateSummary(finalResults);

    this.generateHtmlReport(finalResults, summary);

    return { results: finalResults, summary };
  }

  private async auditPageForms(
    browser: Browser,
    pageMeta: WpPageSummary,
    screenshotsDir: string
  ): Promise<FormQcPageResult> {
    const url = pageMeta.url;
    const deviceConfigs = [
      { name: 'iPhone SE', options: devices['iPhone SE'] },
      { name: 'Pixel 5', options: devices['Pixel 5'] },
      { name: 'iPad Mini', options: devices['iPad Mini'] },
      { name: 'desktop-768', options: { viewport: { width: 768, height: 1024 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 } },
    ];

    const deviceResults: Record<string, FormDeviceResult> = {};
    let responseHeaders: Record<string, string> = {};
    const optimizationMarkersSet = new Set<string>();

    for (const d of deviceConfigs) {
      const context = await browser.newContext(d.options);
      const page = await context.newPage();

      const jsErrors: string[] = [];
      const failedRequests: Array<{ url: string; status?: number; error?: string }> = [];

      page.on('pageerror', (err) => jsErrors.push(err.message));
      page.on('requestfailed', (req) => failedRequests.push({ url: req.url(), error: req.failure()?.errorText || 'failed' }));
      page.on('response', (res) => {
        if (res.status() >= 400) {
          failedRequests.push({ url: res.url(), status: res.status() });
        }
      });

      let navRes;
      try {
        navRes = await page.goto(url, { waitUntil: 'load', timeout: 60000 });
      } catch (err: any) {
        await context.close();
        continue;
      }

      if (navRes && Object.keys(responseHeaders).length === 0) {
        responseHeaders = navRes.headers();
      }

      // Check optimization markers from HTML
      const htmlContent = await page.content();
      if (htmlContent.includes('rocket') || htmlContent.includes('wpr-')) optimizationMarkersSet.add('wp-rocket');
      if (htmlContent.includes('litespeed') || htmlContent.includes('data-litespeed')) optimizationMarkersSet.add('litespeed');
      if (htmlContent.includes('autoptimize')) optimizationMarkersSet.add('autoptimize');

      // 1. Initial State Check (before scroll)
      const initialMetrics = await page.evaluate(() => {
        const sw = document.documentElement.scrollWidth;
        const iw = window.innerWidth;
        const vvw = window.visualViewport ? window.visualViewport.width : iw;
        const htmlOx = window.getComputedStyle(document.documentElement).overflowX;

        const firstRev = document.querySelector('.vispan-reveal-right');
        const firstTransform = firstRev ? window.getComputedStyle(firstRev).transform : 'none';

        const hasFix = Array.from(document.styleSheets).some((s) => {
          try {
            return Array.from(s.cssRules || []).some(
              (r) =>
                r.cssText.includes('overflow-x: clip') ||
                r.cssText.includes('overflow-x:clip') ||
                r.cssText.includes('translate3d(0, 40px, 0)')
            );
          } catch {
            return false;
          }
        });

        return {
          sw,
          iw,
          vvw,
          htmlOx,
          firstTransform,
          hasFix,
        };
      });

      // 2. Real Scroll Test: window.scrollTo(300, 0) -> wait 200ms -> record scrollX
      await page.evaluate(() => window.scrollTo(300, 0));
      await page.waitForTimeout(200);
      const measuredScrollX = await page.evaluate(() => window.scrollX);
      await page.evaluate(() => window.scrollTo(0, 0));

      // 3. Scroll slowly to very bottom (until scrollY + innerHeight >= scrollHeight, wait 1s)
      await page.evaluate(async () => {
        await new Promise<void>((resolve) => {
          let totalScrolled = 0;
          const step = 300;
          const timer = setInterval(() => {
            const sh = document.body ? document.body.scrollHeight : document.documentElement.scrollHeight;
            window.scrollBy(0, step);
            totalScrolled += step;
            if (window.scrollY + window.innerHeight >= sh - 50 || totalScrolled >= 30000) {
              clearInterval(timer);
              window.scrollTo(0, sh);
              resolve();
            }
          }, 60);
        });
      });

      await page.waitForTimeout(1000);

      // 4. Measure scroll state and forms
      const bottomState = await page.evaluate(() => {
        const sh = document.body ? document.body.scrollHeight : document.documentElement.scrollHeight;
        const sy = window.scrollY;
        const winH = window.innerHeight;
        const inViewCount = document.querySelectorAll('.vispan-in-view').length;

        function getAncestors(el: HTMLElement) {
          const chain: any[] = [];
          let curr = el.parentElement;
          while (curr && curr !== document.documentElement) {
            const cs = window.getComputedStyle(curr);
            const classes = typeof curr.className === 'string' ? curr.className : '';
            const hasRev = classes.split(/\s+/).some((c) => c.startsWith('vispan-reveal'));
            const hasInV = curr.classList ? curr.classList.contains('vispan-in-view') : false;

            let hides = false;
            let hideReason: string | undefined;
            if (cs.display === 'none') {
              hides = true;
              hideReason = 'display: none';
            } else if (cs.visibility === 'hidden') {
              hides = true;
              hideReason = 'visibility: hidden';
            } else if (parseFloat(cs.opacity) < 0.1) {
              hides = true;
              hideReason = `opacity: ${cs.opacity}`;
            }

            chain.push({
              tag: curr.tagName.toLowerCase(),
              className: classes,
              opacity: cs.opacity,
              display: cs.display,
              visibility: cs.visibility,
              transform: cs.transform,
              height: cs.height,
              overflow: cs.overflow,
              hasReveal: hasRev,
              hasInView: hasInV,
              hidesElement: hides,
              hideReason,
            });
            curr = curr.parentElement;
          }
          return chain;
        }

        const candidateElements = Array.from(document.querySelectorAll('.vispan-inquiry-card, form'));
        const formsData: any[] = [];

        candidateElements.forEach((elNode, idx) => {
          const el = elNode as HTMLElement;
          const cs = window.getComputedStyle(el);
          const r = el.getBoundingClientRect();
          const classes = typeof el.className === 'string' ? el.className : '';

          const isCard = classes.includes('vispan-inquiry-card');
          const isHero = classes.includes('vispan-inquiry-layout-hero') || Boolean(el.closest('.vispan-inquiry-layout-hero, .vispan_hero_right'));
          const isBottom = classes.includes('vispan-inquiry-layout-bottom') || Boolean(el.closest('.vispan-inquiry-layout-bottom, .vispan_cta_col'));

          let role: string = 'other_form';
          if (isCard) {
            role = isHero ? 'hero_card' : isBottom ? 'bottom_cta_card' : 'other_form';
          } else {
            role = isHero ? 'hero_form' : isBottom ? 'bottom_cta_form' : 'other_form';
          }

          const insideViewport = r.top < winH && r.bottom > 0;
          const ancestors = getAncestors(el);
          const firstHiding = ancestors.find((a) => a.hidesElement);

          const hasRev = classes.split(/\s+/).some((c) => c.startsWith('vispan-reveal')) || ancestors.some((a) => a.hasReveal);
          const hasInV = el.classList.contains('vispan-in-view') || ancestors.some((a) => a.hasInView);

          formsData.push({
            index: idx,
            selector: el.tagName.toLowerCase() + (el.id ? '#' + el.id : classes ? '.' + classes.trim().split(/\s+/).slice(0, 2).join('.') : ''),
            role,
            boundingRect: {
              top: Math.round(r.top),
              bottom: Math.round(r.bottom),
              left: Math.round(r.left),
              right: Math.round(r.right),
              width: Math.round(r.width),
              height: Math.round(r.height),
            },
            insideViewportAtBottom: insideViewport,
            computedOpacity: cs.opacity,
            computedDisplay: cs.display,
            computedVisibility: cs.visibility,
            computedTransform: cs.transform,
            computedHeight: cs.height,
            computedOverflow: cs.overflow,
            hasRevealClass: hasRev,
            hasInViewClass: hasInV,
            firstHidingAncestor: firstHiding ? `${firstHiding.tag}.${firstHiding.className} (${firstHiding.hideReason})` : null,
            ancestorChain: ancestors,
          });
        });

        return {
          scrollHeight: sh,
          finalScrollY: sy,
          inViewCount,
          formsData,
        };
      });

      // Classify each form element
      const formDetails: FormElementDetail[] = [];
      for (const fd of bottomState.formsData) {
        let status: 'FORM_VISIBLE' | 'FORM_STUCK_HIDDEN' | 'FORM_NOT_RENDERED' | 'FORM_CLIPPED' | 'SCRIPT_ERROR' = 'FORM_VISIBLE';
        let statusReason = 'Form is visible';

        if (jsErrors.some((e) => e.includes('vispan') || e.includes('IntersectionObserver'))) {
          status = 'SCRIPT_ERROR';
          statusReason = 'Console error occurred in reveal script';
        } else if (fd.boundingRect.height <= 0 || fd.computedDisplay === 'none') {
          status = 'FORM_NOT_RENDERED';
          statusReason = `Height is ${fd.boundingRect.height}px, display is ${fd.computedDisplay}`;
        } else if (fd.firstHidingAncestor) {
          status = 'FORM_STUCK_HIDDEN';
          statusReason = `Hidden by ancestor: ${fd.firstHidingAncestor}`;
        } else if (fd.hasRevealClass && !fd.hasInViewClass && parseFloat(fd.computedOpacity) < 0.9) {
          status = 'FORM_STUCK_HIDDEN';
          statusReason = `Element has reveal class but vispan-in-view was not added (opacity=${fd.computedOpacity})`;
        } else if (fd.computedVisibility === 'hidden') {
          status = 'FORM_STUCK_HIDDEN';
          statusReason = 'Element has visibility: hidden';
        } else if (fd.boundingRect.width <= 0) {
          status = 'FORM_CLIPPED';
          statusReason = 'Element width is 0';
        } else {
          status = 'FORM_VISIBLE';
          statusReason = 'Form is fully visible and rendered';
        }

        // Capture form element screenshot
        let formScrBase64: string | undefined;
        try {
          const domHandle = (await page.$$('.vispan-inquiry-card, form'))[fd.index];
          if (domHandle) {
            const buf = await domHandle.screenshot({ timeout: 2000 });
            formScrBase64 = buf.toString('base64');
          }
        } catch {
          // ignore element screenshot timeout
        }

        formDetails.push({
          ...fd,
          status,
          statusReason,
          screenshotBase64: formScrBase64,
        });
      }

      // Check bottom viewport screenshot
      let vpScrBase64: string | undefined;
      try {
        const vpBuf = await page.screenshot({ fullPage: false });
        vpScrBase64 = vpBuf.toString('base64');
      } catch {
        // ignore
      }

      // Overall device form status:
      // Focus on bottom CTA form/card since page is scrolled to bottom
      const bottomCtaForms = formDetails.filter((f) => f.role === 'bottom_cta_card' || f.role === 'bottom_cta_form');
      const targetFormsToCheck = bottomCtaForms.length > 0 ? bottomCtaForms : formDetails;

      let devFormStatus: 'FORM_VISIBLE' | 'FORM_STUCK_HIDDEN' | 'FORM_NOT_RENDERED' | 'FORM_CLIPPED' | 'SCRIPT_ERROR' = 'FORM_VISIBLE';
      let hiddenByEl: string | null = null;

      for (const tf of targetFormsToCheck) {
        if (tf.status !== 'FORM_VISIBLE') {
          devFormStatus = tf.status;
          hiddenByEl = tf.firstHidingAncestor || tf.selector;
          break;
        }
      }

      // Horizontal scroll status for this device
      const isMobileDev = Boolean(d.options.isMobile);
      const limitW = isMobileDev ? initialMetrics.vvw : initialMetrics.iw;
      const hPass =
        measuredScrollX === 0 &&
        initialMetrics.sw <= limitW;

      let hScrollStatus: 'PASS' | 'FIX_NOT_LIVE' | 'OTHER_OVERFLOW' = 'PASS';
      if (!hPass) {
        hScrollStatus = initialMetrics.hasFix ? 'OTHER_OVERFLOW' : 'FIX_NOT_LIVE';
      }

      deviceResults[d.name] = {
        device: d.name,
        isMobile: isMobileDev,
        hasTouch: Boolean(d.options.hasTouch),
        scrollHeight: bottomState.scrollHeight,
        finalScrollY: bottomState.finalScrollY,
        forms: formDetails,
        formStatus: devFormStatus,
        hiddenByElement: hiddenByEl,
        viewportScreenshotBase64: vpScrBase64,
        revealScriptRan: bottomState.inViewCount > 0,
        revealInViewCount: bottomState.inViewCount,
        jsErrors,
        failedRequests,
        scrollWidth: initialMetrics.sw,
        innerWidth: initialMetrics.iw,
        visualViewportWidth: initialMetrics.vvw,
        scrollX: measuredScrollX,
        firstRevealTransformBeforeScroll: initialMetrics.firstTransform,
        htmlOverflowX: initialMetrics.htmlOx,
        hasFixRule: initialMetrics.hasFix,
        hScrollStatus,
      };

      await context.close();
    }

    // Page overall statuses
    const devList = Object.values(deviceResults);
    let overallFormStatus: 'FORM_VISIBLE' | 'FORM_STUCK_HIDDEN' | 'FORM_NOT_RENDERED' | 'FORM_CLIPPED' | 'SCRIPT_ERROR' = 'FORM_VISIBLE';
    for (const dRes of devList) {
      if (dRes.formStatus !== 'FORM_VISIBLE') {
        overallFormStatus = dRes.formStatus;
        break;
      }
    }

    let overallHScrollStatus: 'PASS' | 'FIX_NOT_LIVE' | 'OTHER_OVERFLOW' = 'PASS';
    for (const dRes of devList) {
      if (dRes.hScrollStatus === 'FIX_NOT_LIVE') {
        overallHScrollStatus = 'FIX_NOT_LIVE';
        break;
      } else if (dRes.hScrollStatus === 'OTHER_OVERFLOW') {
        overallHScrollStatus = 'OTHER_OVERFLOW';
      }
    }

    return {
      id: pageMeta.id,
      title: pageMeta.title,
      url,
      responseHeaders,
      optimizationMarkers: Array.from(optimizationMarkersSet),
      devices: deviceResults,
      overallFormStatus,
      overallHScrollStatus,
      timestamp: new Date().toISOString(),
    };
  }

  public generateSummary(results: FormQcPageResult[]): FormQcSummary {
    const summary: FormQcSummary = {
      totalPages: results.length,
      formStatusCounts: {
        FORM_VISIBLE: 0,
        FORM_STUCK_HIDDEN: 0,
        FORM_NOT_RENDERED: 0,
        FORM_CLIPPED: 0,
        SCRIPT_ERROR: 0,
      },
      hScrollStatusCounts: {
        PASS: 0,
        FIX_NOT_LIVE: 0,
        OTHER_OVERFLOW: 0,
      },
      devicesAudited: ['iPhone SE', 'Pixel 5', 'iPad Mini', 'desktop-768'],
    };

    for (const r of results) {
      summary.formStatusCounts[r.overallFormStatus]++;
      summary.hScrollStatusCounts[r.overallHScrollStatus]++;
    }

    return summary;
  }

  public generateHtmlReport(results: FormQcPageResult[], summary: FormQcSummary): void {
    let rowsHtml = '';
    for (const r of results) {
      for (const dName of summary.devicesAudited) {
        const d = r.devices[dName];
        if (!d) continue;

        let screenshotImg = '';
        if (d.formStatus !== 'FORM_VISIBLE' && d.viewportScreenshotBase64) {
          screenshotImg = `<img src="data:image/png;base64,${d.viewportScreenshotBase64}" style="max-width:200px; display:block; margin-top:5px; border:1px solid #ccc;"/>`;
        }

        const formBadge = d.formStatus === 'FORM_VISIBLE' ? '<span style="color:green; font-weight:bold;">VISIBLE</span>' : `<span style="color:red; font-weight:bold;">${d.formStatus}</span>`;
        const hBadge = d.hScrollStatus === 'PASS' ? '<span style="color:green; font-weight:bold;">PASS</span>' : `<span style="color:orange; font-weight:bold;">${d.hScrollStatus}</span>`;

        rowsHtml += `
          <tr>
            <td>${r.id}</td>
            <td><a href="${r.url}" target="_blank">${r.title.slice(0, 35)}</a></td>
            <td>${d.device}</td>
            <td>${formBadge} ${d.hiddenByElement ? `<br><small>Hidden by: ${d.hiddenByElement}</small>` : ''} ${screenshotImg}</td>
            <td>${d.hasFixRule ? 'YES' : 'NO'}</td>
            <td>sw=${d.scrollWidth}px / iw=${d.innerWidth}px / vvw=${d.visualViewportWidth}px</td>
            <td>${d.scrollX}px</td>
            <td>${hBadge}</td>
          </tr>
        `;
      }
    }

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>ERA Form Visibility & Responsive QC Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 20px; background: #f8fafc; color: #1e293b; }
    h1 { margin-bottom: 5px; }
    .summary-card { background: white; padding: 15px 20px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid #e2e8f0; font-size: 13px; }
    th { background: #f1f5f9; font-weight: 600; }
  </style>
</head>
<body>
  <h1>ERA Form Visibility & Responsive QC Report</h1>
  <div class="summary-card">
    <p><strong>Total Pages:</strong> ${summary.totalPages}</p>
    <p><strong>Form Status:</strong> Visible: ${summary.formStatusCounts.FORM_VISIBLE} | Stuck Hidden: ${summary.formStatusCounts.FORM_STUCK_HIDDEN} | Not Rendered: ${summary.formStatusCounts.FORM_NOT_RENDERED} | Clipped: ${summary.formStatusCounts.FORM_CLIPPED} | Script Error: ${summary.formStatusCounts.SCRIPT_ERROR}</p>
    <p><strong>Horizontal Scroll Status:</strong> Pass: ${summary.hScrollStatusCounts.PASS} | Fix Not Live: ${summary.hScrollStatusCounts.FIX_NOT_LIVE} | Other Overflow: ${summary.hScrollStatusCounts.OTHER_OVERFLOW}</p>
  </div>
  <table>
    <thead>
      <tr>
        <th>ID</th>
        <th>Title</th>
        <th>Device</th>
        <th>Form Status</th>
        <th>Fix Live</th>
        <th>Dimensions</th>
        <th>ScrollX</th>
        <th>Scroll Status</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml}
    </tbody>
  </table>
</body>
</html>`;

    fs.writeFileSync(path.join(this.outputDir, 'report.html'), html, 'utf-8');
  }

  public printConsoleSummary(summary: FormQcSummary): void {
    console.log(`\n============================================================`);
    console.log(`📋 ERA FORM VISIBILITY & RESPONSIVE QC REPORT`);
    console.log(`============================================================`);
    console.log(`• Total Pages Audited       : ${summary.totalPages}`);
    console.log(`• FORM_VISIBLE              : ${summary.formStatusCounts.FORM_VISIBLE}`);
    console.log(`• FORM_STUCK_HIDDEN         : ${summary.formStatusCounts.FORM_STUCK_HIDDEN}`);
    console.log(`• FORM_NOT_RENDERED         : ${summary.formStatusCounts.FORM_NOT_RENDERED}`);
    console.log(`• FORM_CLIPPED              : ${summary.formStatusCounts.FORM_CLIPPED}`);
    console.log(`• SCRIPT_ERROR              : ${summary.formStatusCounts.SCRIPT_ERROR}`);
    console.log(`------------------------------------------------------------`);
    console.log(`Horizontal Scroll Status:`);
    console.log(`• PASS                      : ${summary.hScrollStatusCounts.PASS}`);
    console.log(`• FIX_NOT_LIVE              : ${summary.hScrollStatusCounts.FIX_NOT_LIVE}`);
    console.log(`• OTHER_OVERFLOW            : ${summary.hScrollStatusCounts.OTHER_OVERFLOW}`);
    console.log(`------------------------------------------------------------`);
    console.log(`Devices Audited: iPhone SE, Pixel 5, iPad Mini, desktop-768`);
    console.log(`Outputs: output/qc-forms/results.json, report.html`);
    console.log(`============================================================\n`);
  }
}
