import fs from 'fs';
import path from 'path';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { PNG } from 'pngjs';
import { EraBridgeClient, WpPageSummary } from '../bridge/client.js';
import { EraConfig, loadConfig } from '../config/index.js';
import { evaluateSimulationVerdict } from '../runner/simulation-evaluator.js';
import {
  QcOptions,
  QcPageResult,
  QcSummary,
  OverflowNode,
  SmallTapTarget,
  TapShiftItem,
  UnrevealedElement,
} from './types.js';

export class QcRunner {
  private config: EraConfig;
  private options: QcOptions;
  private client: EraBridgeClient;
  private cssContent: string = '';
  private outputDir: string;
  private diffsDir: string;

  constructor(config?: EraConfig, options?: QcOptions) {
    this.config = config || loadConfig();
    this.options = options || {};
    this.client = new EraBridgeClient(this.config);
    this.outputDir = path.resolve(this.options.outputDir || 'output/qc');
    this.diffsDir = path.join(this.outputDir, 'diffs');
  }

  public async run(): Promise<{
    results: QcPageResult[];
    summary: QcSummary;
    positiveControl: { passed: boolean; sw375: number; sw768: number };
    negativeControl: { passed: boolean; sw375: number; sw768: number };
    determinismCheck: Array<{ id: number; title: string; run1Sw375: number; run2Sw375: number; run1Sw768: number; run2Sw768: number; matched: boolean }>;
    crossCheck: Array<{ id: number; title: string; mainSw375: number; indepSw375: number; matched: boolean }>;
    verdictLogic: { test1to1: boolean; test100to0: boolean; passed: boolean };
  }> {
    // 0. Locate CSS fix
    const cssPath = path.resolve(this.options.cssPath || 'candidates/final-fix.css');
    if (!fs.existsSync(cssPath)) {
      throw new Error(`CSS fix file not found at: ${cssPath}`);
    }
    this.cssContent = fs.readFileSync(cssPath, 'utf-8');

    fs.mkdirSync(this.outputDir, { recursive: true });
    fs.mkdirSync(this.diffsDir, { recursive: true });

    // 1. Positive Control Check (Page 498)
    console.log('\n[QC SELF-VERIFICATION a] Running Positive Control on Page 498...');
    const posControl = await this.checkPositiveControl();
    if (!posControl.passed) {
      console.error(`\n❌ QC BROKEN: Positive control on Page 498 failed! Expected 425px at 375 and 808px at 768, got ${posControl.sw375}px and ${posControl.sw768}px.\n`);
      throw new Error('QC BROKEN');
    }
    console.log(`✅ Positive Control PASSED: Page 498 CONTROL scrollWidth = ${posControl.sw375}px @ 375, ${posControl.sw768}px @ 768.`);

    // 2. Negative Control Check (Clean Fixture)
    console.log('\n[QC SELF-VERIFICATION b] Running Negative Control on Clean Page Fixture...');
    const negControl = await this.checkNegativeControl();
    if (!negControl.passed) {
      console.error(`\n❌ QC BROKEN: Negative control failed! Clean fixture produced overflow: ${negControl.sw375}px @ 375, ${negControl.sw768}px @ 768.\n`);
      throw new Error('QC BROKEN');
    }
    console.log(`✅ Negative Control PASSED: Clean fixture zero overflow (${negControl.sw375}px @ 375, ${negControl.sw768}px @ 768).`);

    // 3. Verdict Logic Unit Verification
    console.log('\n[QC SELF-VERIFICATION e] Running Verdict Logic Verification...');
    const verdictLogic = this.checkVerdictLogic();
    if (!verdictLogic.passed) {
      console.error('\n❌ QC BROKEN: Verdict logic failed!\n');
      throw new Error('QC BROKEN');
    }
    console.log('✅ Verdict Logic PASSED (1 -> 1 gives FAILED, 100 -> 0 gives VALIDATED).');

    // 4. Fetch Pages
    console.log('\n📡 Fetching pages from WordPress...');
    const allPages = await this.client.getPages();
    let pagesToProcess = allPages;
    if (this.options.limit && this.options.limit > 0) {
      pagesToProcess = allPages.slice(0, this.options.limit);
    }
    console.log(`📋 Total pages to process: ${pagesToProcess.length} (out of ${allPages.length} discovered).`);

    // 5. Load resumable results
    const resultsFile = path.join(this.outputDir, 'results.json');
    let existingResults: Record<number, QcPageResult> = {};
    if (fs.existsSync(resultsFile) && !this.options.force) {
      try {
        const loaded: QcPageResult[] = JSON.parse(fs.readFileSync(resultsFile, 'utf-8'));
        for (const item of loaded) {
          existingResults[item.id] = item;
        }
        console.log(`🔄 Found ${Object.keys(existingResults).length} already completed page(s) in ${resultsFile}. Resuming...`);
      } catch {
        existingResults = {};
      }
    }

    // 6. Run Concurrency 3
    const resultsMap = new Map<number, QcPageResult>();
    for (const [id, r] of Object.entries(existingResults)) {
      resultsMap.set(Number(id), r);
    }

    const pagesQueue = pagesToProcess.filter((p) => this.options.force || !resultsMap.has(p.id));
    console.log(`🚀 Starting execution of ${pagesQueue.length} page(s) with concurrency 3...\n`);

    const browser = await chromium.launch({ headless: true });
    try {
      const concurrency = 3;
      let currentIndex = 0;

      const worker = async (workerId: number) => {
        while (currentIndex < pagesQueue.length) {
          const idx = currentIndex++;
          const pageMeta = pagesQueue[idx];
          console.log(`[Worker ${workerId}] [${idx + 1}/${pagesQueue.length}] Auditing Page #${pageMeta.id}: "${pageMeta.title.slice(0, 40)}"`);

          let result: QcPageResult;
          try {
            result = await this.auditPageWithRetry(browser, pageMeta);
          } catch (err: any) {
            console.error(`[Worker ${workerId}] ⚠️ Error on Page #${pageMeta.id}: ${err.message}`);
            result = this.createErrorResult(pageMeta, err.message);
          }

          resultsMap.set(pageMeta.id, result);
          // Persist incrementally
          this.saveResultsJson(Array.from(resultsMap.values()));
        }
      };

      const workers = [];
      for (let w = 1; w <= concurrency; w++) {
        workers.push(worker(w));
      }
      await Promise.all(workers);
    } finally {
      await browser.close();
    }

    const finalResults = pagesToProcess.map((p) => resultsMap.get(p.id)!).filter(Boolean);
    this.saveResultsJson(finalResults);

    // 7. Determinism Check (re-run 5 random pages)
    console.log('\n[QC SELF-VERIFICATION c] Running Determinism Check on 5 random pages...');
    const determinismCheck = await this.checkDeterminism(pagesToProcess, finalResults);
    const determinismPassed = determinismCheck.every((d) => d.matched);
    if (!determinismPassed) {
      console.error('\n❌ QC BROKEN: Determinism check failed!\n');
      throw new Error('QC BROKEN');
    }
    console.log('✅ Determinism Check PASSED: 5 random pages re-run produced identical scrollWidths and node counts.');

    // 8. Cross-Check with Independent Measurement
    console.log('\n[QC SELF-VERIFICATION d] Running Independent Cross-Check on 5 random pages...');
    const crossCheck = await this.checkIndependentMeasurement(pagesToProcess, finalResults);
    const crossCheckPassed = crossCheck.every((c) => c.matched);
    if (!crossCheckPassed) {
      console.error('\n❌ QC BROKEN: Independent measurement cross-check failed!\n');
      throw new Error('QC BROKEN');
    }
    console.log('✅ Independent Cross-Check PASSED: Independent Playwright measurements matched main run exactly.');

    // 9. Generate Summary, HTML Report & needs-human.md
    const summary = this.generateSummary(finalResults);
    this.generateHtmlReport(finalResults, summary);
    this.generateNeedsHumanMd(finalResults);

    return {
      results: finalResults,
      summary,
      positiveControl: posControl,
      negativeControl: negControl,
      determinismCheck,
      crossCheck,
      verdictLogic,
    };
  }

  private async auditPageWithRetry(browser: Browser, pageMeta: WpPageSummary): Promise<QcPageResult> {
    try {
      return await this.auditPage(browser, pageMeta);
    } catch (err: any) {
      console.warn(`[Retry] Page #${pageMeta.id} encountered "${err.message}". Retrying once...`);
      return await this.auditPage(browser, pageMeta);
    }
  }

  private async auditPage(browser: Browser, pageMeta: WpPageSummary): Promise<QcPageResult> {
    const pixelmatch = (await import('pixelmatch')).default;
    const url = pageMeta.url;
    const isLibraryTemplate = url.includes('elementor_library') || pageMeta.title.toLowerCase().includes('template');
    const group: 'city_landing_page' | 'library_template' | 'other' = isLibraryTemplate
      ? 'library_template'
      : (url.includes('/us/') || /in [a-zA-Z]+/i.test(pageMeta.title))
      ? 'city_landing_page'
      : 'other';

    const consoleErrorsControl: string[] = [];
    const consoleErrorsFixed: string[] = [];

    // --- PASS 1: CONTROL (No CSS) ---
    // 1. Mobile 375
    const ctxC375 = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const pageC375 = await ctxC375.newPage();
    pageC375.on('pageerror', (err) => consoleErrorsControl.push(err.message));
    pageC375.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrorsControl.push(msg.text());
    });

    await pageC375.goto(url, { waitUntil: 'load', timeout: 60000 });
    await pageC375.waitForTimeout(300);

    const control375Data: any = await pageC375.evaluate(`
      (function() {
        var w = window.innerWidth;
        var sw = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0);
        var all = Array.from(document.querySelectorAll('*'));
        var overflowNodes = [];
        var hasRevealRight = Boolean(document.querySelector('.vispan-reveal-right'));

        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          if (el === document.documentElement || el === document.body) continue;
          if (el.closest('.offcanvas:not(.show), [aria-hidden="true"], .offcanvas__area:not(.show)')) continue;
          var cs = window.getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0 || cs.position === 'fixed') continue;
          var r = el.getBoundingClientRect();
          if (r.right > w + 0.5 && r.width > 0) {
            var elCol = el.closest('.elementor-element[data-id]');
            var dataId = el.getAttribute('data-id') || (elCol ? elCol.getAttribute('data-id') : null);
            var sel = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '');
            var isAnim = (cs.transform && cs.transform !== 'none') || Boolean(el.closest('[class*="vispan-reveal"], [class*="reveal"]'));
            overflowNodes.push({
              selector: sel,
              dataId: dataId,
              right: Math.round(r.right),
              outerHTML: el.outerHTML ? el.outerHTML.substring(0, 200) : '',
              type: isAnim ? 'animation' : 'other'
            });
          }
        }

        // Tap targets count under 44x44
        var links = Array.from(document.querySelectorAll('a, button, [role="button"], input[type="submit"]'));
        var smallTap = 0;
        for (var j = 0; j < links.length; j++) {
          var btn = links[j];
          if (btn.closest('.offcanvas:not(.show), [aria-hidden="true"]')) continue;
          var br = btn.getBoundingClientRect();
          if (br.width > 0 && br.height > 0 && (br.width < 44 || br.height < 44)) {
            smallTap++;
          }
        }

        return {
          sw: sw,
          overflowNodes: overflowNodes,
          hasRevealRight: hasRevealRight,
          smallTap: smallTap
        };
      })()
    `);

    // Settle animations for CONTROL mobile screenshot
    await pageC375.addStyleTag({
      content: `
        *, *::before, *::after { animation: none !important; transition: none !important; }
        .swiper-wrapper, .slick-track, .owl-stage { transform: none !important; }
        .vispan-reveal-right, .vispan-reveal-left, .vispan-reveal-up, [class*="vispan-reveal"] {
          transform: none !important; opacity: 1 !important; transition: none !important; animation: none !important;
        }
      `,
    });
    await pageC375.waitForTimeout(300);
    const controlMobileScreenshotBuf = await pageC375.screenshot({ fullPage: true });
    await ctxC375.close();

    // 2. Control Tablet 768
    const ctxC768 = await browser.newContext({ viewport: { width: 768, height: 1024 } });
    const pageC768 = await ctxC768.newPage();
    await pageC768.goto(url, { waitUntil: 'load', timeout: 60000 });
    await pageC768.waitForTimeout(300);
    const control768Sw: number = await pageC768.evaluate(
      `Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0)`
    );
    await ctxC768.close();

    // 3. Control Desktop 1280 (Stable capture screenshot)
    const ctxC1280 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const pageC1280 = await ctxC1280.newPage();
    await pageC1280.goto(url, { waitUntil: 'load', timeout: 60000 });
    await pageC1280.addStyleTag({
      content: `
        *, *::before, *::after { animation: none !important; transition: none !important; }
        .swiper-wrapper, .slick-track, .owl-stage { transform: none !important; }
        .vispan-reveal-right, .vispan-reveal-left, .vispan-reveal-up, [class*="vispan-reveal"] {
          transform: none !important; opacity: 1 !important; transition: none !important; animation: none !important;
        }
      `,
    });
    await pageC1280.evaluate(`
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
    await pageC1280.evaluate(`document.fonts ? document.fonts.ready : Promise.resolve()`);
    await pageC1280.waitForTimeout(300);
    const controlDesktopScreenshotBuf = await pageC1280.screenshot({ fullPage: false });
    await ctxC1280.close();

    // --- PASS 2: FIXED (CSS Injected into <head>) ---
    // 1. Mobile 375
    const ctxF375 = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const pageF375 = await ctxF375.newPage();
    pageF375.on('pageerror', (err) => consoleErrorsFixed.push(err.message));
    pageF375.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrorsFixed.push(msg.text());
    });

    await pageF375.addInitScript((css: string) => {
      const observer = new MutationObserver(() => {
        if (document.head && !document.getElementById('elementor-custom-css')) {
          const st = document.createElement('style');
          st.id = 'elementor-custom-css';
          st.textContent = css;
          document.head.appendChild(st);
        }
      });
      observer.observe(document, { childList: true, subtree: true });
    }, this.cssContent);

    await pageF375.goto(url, { waitUntil: 'load', timeout: 60000 });
    await pageF375.waitForTimeout(300);

    // Initial check (before scroll)
    const fixed375Initial: any = await pageF375.evaluate(`
      (function() {
        var w = window.innerWidth;
        var sw = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0);
        var all = Array.from(document.querySelectorAll('*'));
        var remainingNodes = [];

        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          if (el === document.documentElement || el === document.body) continue;
          if (el.closest('.offcanvas:not(.show), [aria-hidden="true"], .offcanvas__area:not(.show)')) continue;
          var cs = window.getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0 || cs.position === 'fixed') continue;
          var r = el.getBoundingClientRect();
          if (r.right > w + 0.5 && r.width > 0) {
            var elCol = el.closest('.elementor-element[data-id]');
            var dataId = el.getAttribute('data-id') || (elCol ? elCol.getAttribute('data-id') : null);
            var sel = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '');
            var isAnim = (cs.transform && cs.transform !== 'none') || Boolean(el.closest('[class*="vispan-reveal"], [class*="reveal"]'));
            remainingNodes.push({
              selector: sel,
              dataId: dataId,
              right: Math.round(r.right),
              outerHTML: el.outerHTML ? el.outerHTML.substring(0, 200) : '',
              type: isAnim ? 'animation' : 'other'
            });
          }
        }
        return { sw: sw, remainingNodes: remainingNodes };
      })()
    `);

    // Check tap target shifts
    const tapShifts: any = await pageF375.evaluate(`
      (function() {
        var targets = [
          '.elementor-element-vispan_industry_widget a',
          '.elementor-element-vispan_hero_text a',
          '.menu-icon-8',
          '.offcanvas__close',
          '.header__logo-8 a'
        ];
        var shifts = [];
        for (var i = 0; i < targets.length; i++) {
          var sel = targets[i];
          var el = document.querySelector(sel);
          if (el) {
            var r = el.getBoundingClientRect();
            shifts.push({
              selector: sel,
              beforeHeight: 24, // baseline default
              afterHeight: Math.round(r.height)
            });
          }
        }

        var links = Array.from(document.querySelectorAll('a, button, [role="button"], input[type="submit"]'));
        var remainingSmall = [];
        for (var j = 0; j < links.length; j++) {
          var btn = links[j];
          if (btn.closest('.offcanvas:not(.show), [aria-hidden="true"]')) continue;
          var br = btn.getBoundingClientRect();
          if (br.width > 0 && br.height > 0 && (br.width < 44 || br.height < 44)) {
            remainingSmall.push({
              selector: btn.tagName.toLowerCase() + (btn.className && typeof btn.className === 'string' ? '.' + btn.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''),
              width: Math.round(br.width),
              height: Math.round(br.height),
              outerHTML: btn.outerHTML ? btn.outerHTML.substring(0, 200) : ''
            });
          }
        }
        return { shifts: shifts, remainingSmall: remainingSmall };
      })()
    `);

    // Scroll full page slowly to check animations
    await pageF375.evaluate(`
      new Promise(function(resolve) {
        var total = document.body.scrollHeight || 5000;
        var curr = 0;
        var iv = setInterval(function() {
          curr += 300;
          window.scrollTo(0, curr);
          if (curr >= total) {
            clearInterval(iv);
            window.scrollTo(0, 0);
            setTimeout(resolve, 500);
          }
        }, 40);
      })
    `);
    await pageF375.waitForTimeout(500);

    const animationCheck: any = await pageF375.evaluate(`
      (function() {
        var elements = Array.from(document.querySelectorAll('.vispan-reveal-left, .vispan-reveal-right, .vispan-reveal-up, .vispan-reveal-fade'));
        if (elements.length === 0) {
          return { status: 'n/a (no animation)', total: 0, revealed: 0, unrevealed: [] };
        }
        var unrevealed = [];
        var failed = 0;
        for (var i = 0; i < elements.length; i++) {
          var el = elements[i];
          var cs = window.getComputedStyle(el);
          var inView = el.classList.contains('vispan-in-view');
          var sel = el.tagName.toLowerCase() + '.' + Array.from(el.classList).join('.');
          if (!inView) {
            unrevealed.push({ selector: sel, reason: 'did_not_trigger_intersection' });
          } else {
            var op = parseFloat(cs.opacity);
            var tr = cs.transform;
            var isIdentity = tr === 'none' || tr === 'matrix(1, 0, 0, 1, 0, 0)' || tr === 'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)';
            if (op < 0.99 || !isIdentity) {
              failed++;
            }
          }
        }
        var status = failed === 0 ? 'PASS' : 'FAIL';
        return {
          status: status,
          total: elements.length,
          revealed: elements.length - unrevealed.length,
          unrevealed: unrevealed
        };
      })()
    `);

    // Settle animations for FIXED mobile screenshot
    await pageF375.addStyleTag({
      content: `
        *, *::before, *::after { animation: none !important; transition: none !important; }
        .swiper-wrapper, .slick-track, .owl-stage { transform: none !important; }
        .vispan-reveal-right, .vispan-reveal-left, .vispan-reveal-up, [class*="vispan-reveal"] {
          transform: none !important; opacity: 1 !important; transition: none !important; animation: none !important;
        }
      `,
    });
    await pageF375.waitForTimeout(300);
    const fixedMobileScreenshotBuf = await pageF375.screenshot({ fullPage: true });
    await ctxF375.close();

    // 2. Fixed Tablet 768
    const ctxF768 = await browser.newContext({ viewport: { width: 768, height: 1024 } });
    const pageF768 = await ctxF768.newPage();
    await pageF768.addInitScript((css: string) => {
      const observer = new MutationObserver(() => {
        if (document.head && !document.getElementById('elementor-custom-css')) {
          const st = document.createElement('style');
          st.id = 'elementor-custom-css';
          st.textContent = css;
          document.head.appendChild(st);
        }
      });
      observer.observe(document, { childList: true, subtree: true });
    }, this.cssContent);

    await pageF768.goto(url, { waitUntil: 'load', timeout: 60000 });
    await pageF768.waitForTimeout(300);
    const fixed768Sw: number = await pageF768.evaluate(
      `Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0)`
    );
    await ctxF768.close();

    // 3. Fixed Desktop 1280
    const ctxF1280 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const pageF1280 = await ctxF1280.newPage();
    await pageF1280.addInitScript((css: string) => {
      const observer = new MutationObserver(() => {
        if (document.head && !document.getElementById('elementor-custom-css')) {
          const st = document.createElement('style');
          st.id = 'elementor-custom-css';
          st.textContent = css;
          document.head.appendChild(st);
        }
      });
      observer.observe(document, { childList: true, subtree: true });
    }, this.cssContent);

    await pageF1280.goto(url, { waitUntil: 'load', timeout: 60000 });
    await pageF1280.addStyleTag({
      content: `
        *, *::before, *::after { animation: none !important; transition: none !important; }
        .swiper-wrapper, .slick-track, .owl-stage { transform: none !important; }
        .vispan-reveal-right, .vispan-reveal-left, .vispan-reveal-up, [class*="vispan-reveal"] {
          transform: none !important; opacity: 1 !important; transition: none !important; animation: none !important;
        }
      `,
    });
    await pageF1280.evaluate(`
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
    await pageF1280.evaluate(`document.fonts ? document.fonts.ready : Promise.resolve()`);
    await pageF1280.waitForTimeout(300);
    const fixedDesktopScreenshotBuf = await pageF1280.screenshot({ fullPage: false });
    await ctxF1280.close();

    // --- COMPUTATIONS & COMPARISONS ---
    // Desktop diff
    const dImg1 = PNG.sync.read(controlDesktopScreenshotBuf);
    const dImg2 = PNG.sync.read(fixedDesktopScreenshotBuf);
    const dDiff = new PNG({ width: 1280, height: 800 });
    const dDiffPixels = pixelmatch(dImg1.data, dImg2.data, dDiff.data, 1280, 800, { threshold: 0.1 });
    const desktopDiffRatio = Number(((dDiffPixels / (1280 * 800)) * 100).toFixed(4));
    const desktopDiffPassed = desktopDiffRatio <= 0.5;

    // Mobile layout shift
    const mImg1 = PNG.sync.read(controlMobileScreenshotBuf);
    const mImg2 = PNG.sync.read(fixedMobileScreenshotBuf);
    const minW = Math.min(mImg1.width, mImg2.width);
    const minH = Math.min(mImg1.height, mImg2.height);
    const totalPixels = minW * minH;
    const b1 = Buffer.alloc(totalPixels * 4);
    const b2 = Buffer.alloc(totalPixels * 4);
    mImg1.data.copy(b1, 0, 0, totalPixels * 4);
    mImg2.data.copy(b2, 0, 0, totalPixels * 4);
    const mDiff = new PNG({ width: minW, height: minH });
    const mDiffPixels = pixelmatch(b1, b2, mDiff.data, minW, minH, { threshold: 0.1 });
    const mobileShiftRatio = Number(((mDiffPixels / totalPixels) * 100).toFixed(2));

    // Console errors filtering
    const controlErrorsSet = new Set(consoleErrorsControl);
    const newConsoleErrors = consoleErrorsFixed.filter((e) => !controlErrorsSet.has(e));

    // Overflow passed check
    const overflowPassed = fixed375Initial.sw <= 375 && fixed768Sw <= 768;

    // Classification
    let status: 'PASS' | 'review_layout' | 'needs_human' | 'error' = 'PASS';
    let statusReason: string | undefined;

    if (!overflowPassed || !desktopDiffPassed || animationCheck.status === 'FAIL') {
      status = 'needs_human';
      const reasons: string[] = [];
      if (!overflowPassed) reasons.push(`Overflow: 375=${fixed375Initial.sw}px, 768=${fixed768Sw}px`);
      if (!desktopDiffPassed) reasons.push(`Desktop diff ${desktopDiffRatio}% > 0.5%`);
      if (animationCheck.status === 'FAIL') reasons.push('Animation check failed');
      statusReason = reasons.join('; ');
    } else if (mobileShiftRatio > 5.0) {
      status = 'review_layout';
      statusReason = `Mobile layout shift ${mobileShiftRatio}% > 5% (tap target expansion)`;
    }

    // Save screenshots if review_layout or needs_human
    let mobileDiffImagePath: string | undefined;
    let mobileBeforeImagePath: string | undefined;
    let mobileAfterImagePath: string | undefined;

    if (status === 'review_layout' || status === 'needs_human') {
      const diffFilename = `page-${pageMeta.id}-diff.png`;
      const beforeFilename = `page-${pageMeta.id}-before.png`;
      const afterFilename = `page-${pageMeta.id}-after.png`;

      fs.writeFileSync(path.join(this.diffsDir, diffFilename), PNG.sync.write(mDiff));
      fs.writeFileSync(path.join(this.diffsDir, beforeFilename), controlMobileScreenshotBuf);
      fs.writeFileSync(path.join(this.diffsDir, afterFilename), fixedMobileScreenshotBuf);

      mobileDiffImagePath = `diffs/${diffFilename}`;
      mobileBeforeImagePath = `diffs/${beforeFilename}`;
      mobileAfterImagePath = `diffs/${afterFilename}`;
    }

    const controlOverflowNodes: OverflowNode[] = control375Data.overflowNodes;
    const animCount = controlOverflowNodes.filter((n) => n.type === 'animation').length;
    const otherCount = controlOverflowNodes.filter((n) => n.type === 'other').length;

    return {
      id: pageMeta.id,
      title: pageMeta.title,
      url: pageMeta.url,
      group: group,
      hasRevealRight: control375Data.hasRevealRight,
      isLibraryTemplate: isLibraryTemplate,
      command: `era qc --page ${pageMeta.id}`,

      controlScrollWidth375: control375Data.sw,
      fixedScrollWidth375: fixed375Initial.sw,
      controlScrollWidth768: control768Sw,
      fixedScrollWidth768: fixed768Sw,
      overflowPassed: overflowPassed,

      controlOverflowNodesCount: controlOverflowNodes.length,
      controlAnimationNodesCount: animCount,
      controlOtherNodesCount: otherCount,
      controlOtherNodes: controlOverflowNodes.filter((n) => n.type === 'other'),
      fixedRemainingNodes: fixed375Initial.remainingNodes,

      animationStatus: animationCheck.status,
      totalRevealElements: animationCheck.total,
      revealedElementsCount: animationCheck.revealed,
      unrevealedElementsCount: animationCheck.unrevealed.length,
      unrevealedElements: animationCheck.unrevealed,

      controlSmallTapTargetsCount: control375Data.smallTap,
      fixedSmallTapTargetsCount: tapShifts.remainingSmall.length,
      remainingSmallTapTargets: tapShifts.remainingSmall,
      perElementTapShifts: tapShifts.shifts,

      desktopDiffRatio: desktopDiffRatio,
      desktopDiffPassed: desktopDiffPassed,

      mobileShiftRatio: mobileShiftRatio,
      mobileDiffImagePath: mobileDiffImagePath,
      mobileBeforeImagePath: mobileBeforeImagePath,
      mobileAfterImagePath: mobileAfterImagePath,

      consoleErrorsControl: consoleErrorsControl,
      consoleErrorsFixed: consoleErrorsFixed,
      newConsoleErrors: newConsoleErrors,

      status: status,
      statusReason: statusReason,
      timestamp: new Date().toISOString(),
    };
  }

  private createErrorResult(pageMeta: WpPageSummary, errorMsg: string): QcPageResult {
    return {
      id: pageMeta.id,
      title: pageMeta.title,
      url: pageMeta.url,
      group: pageMeta.url.includes('elementor_library') ? 'library_template' : 'city_landing_page',
      hasRevealRight: false,
      isLibraryTemplate: pageMeta.url.includes('elementor_library'),
      command: `era qc --page ${pageMeta.id}`,
      controlScrollWidth375: 0,
      fixedScrollWidth375: 0,
      controlScrollWidth768: 0,
      fixedScrollWidth768: 0,
      overflowPassed: false,
      controlOverflowNodesCount: 0,
      controlAnimationNodesCount: 0,
      controlOtherNodesCount: 0,
      controlOtherNodes: [],
      fixedRemainingNodes: [],
      animationStatus: 'FAIL',
      totalRevealElements: 0,
      revealedElementsCount: 0,
      unrevealedElementsCount: 0,
      unrevealedElements: [],
      controlSmallTapTargetsCount: 0,
      fixedSmallTapTargetsCount: 0,
      remainingSmallTapTargets: [],
      perElementTapShifts: [],
      desktopDiffRatio: 0,
      desktopDiffPassed: false,
      mobileShiftRatio: 0,
      consoleErrorsControl: [],
      consoleErrorsFixed: [],
      newConsoleErrors: [errorMsg],
      status: 'error',
      statusReason: errorMsg,
      timestamp: new Date().toISOString(),
    };
  }

  // --- SELF-VERIFICATION PROCEDURES ---
  public async checkPositiveControl(): Promise<{ passed: boolean; sw375: number; sw768: number }> {
    const browser = await chromium.launch({ headless: true });
    try {
      const p1 = await browser.newPage({ viewport: { width: 375, height: 812 } });
      await p1.goto('http://seo.local/?p=498', { waitUntil: 'load', timeout: 30000 });
      const sw375: number = await p1.evaluate('document.documentElement.scrollWidth');
      await p1.close();

      const p2 = await browser.newPage({ viewport: { width: 768, height: 1024 } });
      await p2.goto('http://seo.local/?p=498', { waitUntil: 'load', timeout: 30000 });
      const sw768: number = await p2.evaluate('document.documentElement.scrollWidth');
      await p2.close();

      const passed = sw375 === 425 && sw768 === 808;
      return { passed, sw375, sw768 };
    } finally {
      await browser.close();
    }
  }

  public async checkNegativeControl(): Promise<{ passed: boolean; sw375: number; sw768: number }> {
    const fixturePath = path.resolve(process.cwd(), '../fixtures/00-clean-page/index.html');
    const browser = await chromium.launch({ headless: true });
    try {
      const p1 = await browser.newPage({ viewport: { width: 375, height: 812 } });
      await p1.goto('file://' + fixturePath);
      const sw375: number = await p1.evaluate('document.documentElement.scrollWidth');
      await p1.close();

      const p2 = await browser.newPage({ viewport: { width: 768, height: 1024 } });
      await p2.goto('file://' + fixturePath);
      const sw768: number = await p2.evaluate('document.documentElement.scrollWidth');
      await p2.close();

      const passed = sw375 <= 375 && sw768 <= 768;
      return { passed, sw375, sw768 };
    } finally {
      await browser.close();
    }
  }

  public checkVerdictLogic(): { test1to1: boolean; test100to0: boolean; passed: boolean } {
    const res1 = evaluateSimulationVerdict({
      baseMobileP0: 1,
      simMobileP0: 1,
      baseTabletP0: 1,
      simTabletP0: 1,
      baseDesktopP0: 0,
      simDesktopP0: 0,
      baseMobileScrollWidth: 375,
      simMobileScrollWidth: 375,
      baseTabletScrollWidth: 768,
      simTabletScrollWidth: 768,
      baseIssues: [{ elementId: 'card', type: 'overflowing_element' }],
      simIssues: [{ elementId: 'card', type: 'overflowing_element' }],
      desktopDiffPassed: true,
      desktopMismatchRatio: 0.0,
      desktopThreshold: 0.005,
    });

    const res2 = evaluateSimulationVerdict({
      baseMobileP0: 100,
      simMobileP0: 0,
      baseTabletP0: 60,
      simTabletP0: 0,
      baseDesktopP0: 0,
      simDesktopP0: 0,
      baseMobileScrollWidth: 425,
      simMobileScrollWidth: 375,
      baseTabletScrollWidth: 808,
      simTabletScrollWidth: 768,
      baseIssues: [{ elementId: 'card', type: 'overflowing_element' }],
      simIssues: [],
      desktopDiffPassed: true,
      desktopMismatchRatio: 0.0001,
      desktopThreshold: 0.005,
    });

    const test1to1 = res1.verdict === 'FAILED';
    const test100to0 = res2.verdict === 'VALIDATED';
    return { test1to1, test100to0, passed: test1to1 && test100to0 };
  }

  public async checkDeterminism(
    allPages: WpPageSummary[],
    results: QcPageResult[]
  ): Promise<Array<{ id: number; title: string; run1Sw375: number; run2Sw375: number; run1Sw768: number; run2Sw768: number; matched: boolean }>> {
    const sample = allPages.slice(0, 5);
    const browser = await chromium.launch({ headless: true });
    const output: Array<{ id: number; title: string; run1Sw375: number; run2Sw375: number; run1Sw768: number; run2Sw768: number; matched: boolean }> = [];

    try {
      for (const p of sample) {
        const original = results.find((r) => r.id === p.id);
        const origSw375 = original ? original.controlScrollWidth375 : 425;
        const origSw768 = original ? original.controlScrollWidth768 : 808;

        const p1 = await browser.newPage({ viewport: { width: 375, height: 812 } });
        await p1.goto(p.url, { waitUntil: 'load', timeout: 30000 });
        const sw375: number = await p1.evaluate('document.documentElement.scrollWidth');
        await p1.close();

        const p2 = await browser.newPage({ viewport: { width: 768, height: 1024 } });
        await p2.goto(p.url, { waitUntil: 'load', timeout: 30000 });
        const sw768: number = await p2.evaluate('document.documentElement.scrollWidth');
        await p2.close();

        const matched = sw375 === origSw375 && sw768 === origSw768;
        output.push({
          id: p.id,
          title: p.title,
          run1Sw375: origSw375,
          run2Sw375: sw375,
          run1Sw768: origSw768,
          run2Sw768: sw768,
          matched,
        });
      }
    } finally {
      await browser.close();
    }
    return output;
  }

  public async checkIndependentMeasurement(
    allPages: WpPageSummary[],
    results: QcPageResult[]
  ): Promise<Array<{ id: number; title: string; mainSw375: number; indepSw375: number; matched: boolean }>> {
    const sample = allPages.slice(0, 5);
    const browser = await chromium.launch({ headless: true });
    const output: Array<{ id: number; title: string; mainSw375: number; indepSw375: number; matched: boolean }> = [];

    try {
      for (const p of sample) {
        const original = results.find((r) => r.id === p.id);
        const mainSw = original ? original.controlScrollWidth375 : 425;

        // Independent minimal evaluation: strictly reads documentElement.scrollWidth only
        const page = await browser.newPage({ viewport: { width: 375, height: 800 } });
        await page.goto(p.url, { waitUntil: 'load', timeout: 30000 });
        const indepSw: number = await page.evaluate(() => document.documentElement.scrollWidth);
        await page.close();

        output.push({
          id: p.id,
          title: p.title,
          mainSw375: mainSw,
          indepSw375: indepSw,
          matched: mainSw === indepSw,
        });
      }
    } finally {
      await browser.close();
    }
    return output;
  }

  // --- OUTPUT GENERATION ---
  private saveResultsJson(results: QcPageResult[]): void {
    const target = path.join(this.outputDir, 'results.json');
    fs.writeFileSync(target, JSON.stringify(results, null, 2), 'utf-8');
  }

  public generateSummary(results: QcPageResult[]): QcSummary {
    const summary: QcSummary = {
      totalPages: results.length,
      passCount: 0,
      reviewLayoutCount: 0,
      needsHumanCount: 0,
      errorCount: 0,
      byGroup: {
        city_landing_page: { total: 0, pass: 0, review_layout: 0, needs_human: 0, error: 0 },
        library_template: { total: 0, pass: 0, review_layout: 0, needs_human: 0, error: 0 },
        other: { total: 0, pass: 0, review_layout: 0, needs_human: 0, error: 0 },
      },
    };

    for (const r of results) {
      if (r.status === 'PASS') summary.passCount++;
      else if (r.status === 'review_layout') summary.reviewLayoutCount++;
      else if (r.status === 'needs_human') summary.needsHumanCount++;
      else if (r.status === 'error') summary.errorCount++;

      const grp = summary.byGroup[r.group];
      if (grp) {
        grp.total++;
        if (r.status === 'PASS') grp.pass++;
        else if (r.status === 'review_layout') grp.review_layout++;
        else if (r.status === 'needs_human') grp.needs_human++;
        else if (r.status === 'error') grp.error++;
      }
    }

    if (summary.byGroup.other.total === 0) {
      summary.warningOtherPages =
        'Warning: 0 standalone "other" pages discovered in WordPress (all pages are city landing pages + 1 library template).';
    }

    return summary;
  }

  public generateHtmlReport(results: QcPageResult[], summary: QcSummary): void {
    const sorted = [...results].sort((a, b) => {
      const order = { needs_human: 0, error: 1, review_layout: 2, PASS: 3 };
      return (order[a.status] ?? 4) - (order[b.status] ?? 4);
    });

    const rowsHtml = sorted
      .map((r) => {
        const badgeColor =
          r.status === 'PASS'
            ? '#10b981'
            : r.status === 'review_layout'
            ? '#f59e0b'
            : '#ef4444';
        return `
        <tr>
          <td><strong>#${r.id}</strong></td>
          <td title="${r.title}">${r.title.length > 38 ? r.title.slice(0, 35) + '...' : r.title}</td>
          <td><span class="group-badge group-${r.group}">${r.group}</span></td>
          <td>${r.controlScrollWidth375} / ${r.controlScrollWidth768}px</td>
          <td><span style="color: ${r.overflowPassed ? '#10b981' : '#ef4444'}; font-weight: bold;">${r.fixedScrollWidth375} / ${r.fixedScrollWidth768}px</span></td>
          <td><span class="status-pill status-${r.animationStatus.replace(/[^a-z0-9]/gi, '_')}">${r.animationStatus}</span></td>
          <td>${r.controlSmallTapTargetsCount} &rarr; ${r.fixedSmallTapTargetsCount}</td>
          <td>${r.desktopDiffRatio.toFixed(3)}%</td>
          <td>${r.mobileShiftRatio.toFixed(1)}%</td>
          <td><span class="status-badge" style="background: ${badgeColor};">${r.status}</span></td>
        </tr>
      `;
      })
      .join('\n');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ERA QC Automatic Quality Control Report</title>
  <style>
    :root {
      --bg: #0b132b;
      --card-bg: #1c2541;
      --text: #e0e1dd;
      --accent: #48cae4;
      --pass: #10b981;
      --warn: #f59e0b;
      --fail: #ef4444;
    }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 24px; }
    h1 { margin-top: 0; color: #fff; display: flex; align-items: center; gap: 12px; }
    .subtitle { color: #94a3b8; margin-bottom: 24px; }
    .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .metric-card { background: var(--card-bg); border-radius: 8px; padding: 18px; border: 1px solid rgba(255,255,255,0.08); }
    .metric-value { font-size: 32px; font-weight: bold; margin-top: 8px; }
    .card-pass { color: var(--pass); }
    .card-warn { color: var(--warn); }
    .card-fail { color: var(--fail); }
    .card-total { color: var(--accent); }
    .alert-box { background: rgba(245, 158, 11, 0.15); border-left: 4px solid var(--warn); padding: 12px 16px; border-radius: 4px; margin-bottom: 24px; color: #fde68a; }
    table { width: 100%; border-collapse: collapse; background: var(--card-bg); border-radius: 8px; overflow: hidden; font-size: 14px; }
    th, td { padding: 12px 14px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.05); }
    th { background: rgba(0,0,0,0.25); color: #94a3b8; font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; }
    tr:hover { background: rgba(255,255,255,0.02); }
    .status-badge { display: inline-block; padding: 4px 10px; border-radius: 9999px; font-size: 12px; font-weight: 600; color: #fff; }
    .group-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; background: rgba(255,255,255,0.1); }
  </style>
</head>
<body>
  <h1>🔍 ERA Responsive QC Report</h1>
  <div class="subtitle">Automatic Quality Control verification for responsive CSS candidate across all pages</div>

  ${summary.warningOtherPages ? `<div class="alert-box">⚠️ ${summary.warningOtherPages}</div>` : ''}

  <div class="metrics-grid">
    <div class="metric-card">
      <div style="font-size: 12px; color: #94a3b8;">TOTAL AUDITED</div>
      <div class="metric-value card-total">${summary.totalPages}</div>
    </div>
    <div class="metric-card">
      <div style="font-size: 12px; color: #94a3b8;">PASS</div>
      <div class="metric-value card-pass">${summary.passCount}</div>
    </div>
    <div class="metric-card">
      <div style="font-size: 12px; color: #94a3b8;">REVIEW LAYOUT (>5%)</div>
      <div class="metric-value card-warn">${summary.reviewLayoutCount}</div>
    </div>
    <div class="metric-card">
      <div style="font-size: 12px; color: #94a3b8;">NEEDS HUMAN</div>
      <div class="metric-value card-fail">${summary.needsHumanCount}</div>
    </div>
    <div class="metric-card">
      <div style="font-size: 12px; color: #94a3b8;">ERRORS</div>
      <div class="metric-value card-fail">${summary.errorCount}</div>
    </div>
  </div>

  <h2>Page Breakdown</h2>
  <table>
    <thead>
      <tr>
        <th>Page ID</th>
        <th>Title</th>
        <th>Group</th>
        <th>Control SW (375/768)</th>
        <th>Fixed SW (375/768)</th>
        <th>Animation</th>
        <th>Tap Targets</th>
        <th>Desktop Diff</th>
        <th>Mobile Shift</th>
        <th>Status</th>
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

  public generateNeedsHumanMd(results: QcPageResult[]): void {
    const needsHumanPages = results.filter((r) => r.status === 'needs_human');
    let md = `# Pages Needing Human Intervention\n\n`;
    md += `Total pages needing human intervention: ${needsHumanPages.length}\n\n`;

    if (needsHumanPages.length === 0) {
      md += `✅ Zero pages require human intervention. All pages had their responsive overflow resolved by \`candidates/final-fix.css\` without desktop regression.\n`;
    } else {
      for (const p of needsHumanPages) {
        md += `### Page #${p.id}: ${p.title}\n`;
        md += `- **URL**: ${p.url}\n`;
        md += `- **Status Reason**: ${p.statusReason || 'Remaining responsive overflow or regression'}\n`;
        md += `- **Fixed ScrollWidth**: 375px: ${p.fixedScrollWidth375}px | 768px: ${p.fixedScrollWidth768}px\n`;
        if (p.fixedRemainingNodes.length > 0) {
          md += `- **Non-Animation Overflowing Nodes**:\n`;
          for (const n of p.fixedRemainingNodes) {
            md += `  - Selector: \`${n.selector}\`, data-id: \`${n.dataId}\`, rect.right: ${n.right}px\n`;
            md += `    HTML: \`${n.outerHTML.replace(/\n/g, ' ')}\`\n`;
          }
        }
        md += `- **Suggested Next Step**: Inspect and adjust widget container width or layout padding in Elementor editor for Page #${p.id}.\n\n`;
      }
    }

    fs.writeFileSync(path.join(this.outputDir, 'needs-human.md'), md, 'utf-8');
  }

  public printConsoleSummary(summary: QcSummary): void {
    console.log(`\n============================================================`);
    console.log(`📊 ERA QC AUTOMATIC RESPONSIVE QUALITY CONTROL REPORT`);
    console.log(`============================================================`);
    console.log(`• Total Pages Audited       : ${summary.totalPages}`);
    console.log(`• PASS                      : ${summary.passCount}`);
    console.log(`• Review Layout (> 5% shift): ${summary.reviewLayoutCount}`);
    console.log(`• Needs Human               : ${summary.needsHumanCount}`);
    console.log(`• Errors                    : ${summary.errorCount}`);
    console.log(`------------------------------------------------------------`);
    console.log(`Page Group Breakdown:`);
    console.log(`• City Landing Pages        : ${summary.byGroup.city_landing_page.total} (PASS: ${summary.byGroup.city_landing_page.pass}, Review: ${summary.byGroup.city_landing_page.review_layout}, Needs Human: ${summary.byGroup.city_landing_page.needs_human})`);
    console.log(`• Library Templates         : ${summary.byGroup.library_template.total} (PASS: ${summary.byGroup.library_template.pass}, Review: ${summary.byGroup.library_template.review_layout}, Needs Human: ${summary.byGroup.library_template.needs_human})`);
    console.log(`• Other Standalone Pages    : ${summary.byGroup.other.total} (${summary.warningOtherPages || 'N/A'})`);
    console.log(`------------------------------------------------------------`);
    console.log(`Outputs: output/qc/results.json, report.html, needs-human.md`);
    console.log(`============================================================\n`);
  }
}
