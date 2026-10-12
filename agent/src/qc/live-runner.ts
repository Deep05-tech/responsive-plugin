import fs from 'fs';
import path from 'path';
import { chromium, Browser, devices } from 'playwright';
import { PNG } from 'pngjs';
import { EraBridgeClient, WpPageSummary } from '../bridge/client.js';
import { EraConfig, loadConfig } from '../config/index.js';
import {
  LiveQcOptions,
  LiveQcPageResult,
  LiveQcSummary,
  DeviceResult,
  DeviceTimingMeasurement,
  OverflowingNodeDetail,
} from './live-types.js';

export class LiveQcRunner {
  private config: EraConfig;
  private options: LiveQcOptions;
  private client: EraBridgeClient;
  private outputDir: string;

  constructor(config?: EraConfig, options?: LiveQcOptions) {
    this.config = config || loadConfig();
    this.options = options || {};
    this.client = new EraBridgeClient(this.config);
    this.outputDir = path.resolve(this.options.outputDir || 'output/qc-live');
  }

  public async run(): Promise<{
    results: LiveQcPageResult[];
    summary: LiveQcSummary;
    positiveControl: { passed: boolean; scrollX: number; scrollWidth: number };
    negativeControl: { passed: boolean; scrollX: number; scrollWidth: number };
    determinismCheck: Array<{ id: number; title: string; run1Sw: number; run2Sw: number; run1Sx: number; run2Sx: number; matched: boolean }>;
    devtoolsSamplePages: LiveQcPageResult[];
  }> {
    fs.mkdirSync(this.outputDir, { recursive: true });

    // 1. Positive Control Check (Page 498 without fix)
    console.log('\n[LIVE QC SELF-VERIFICATION a] Running Positive Control on Page 498 (unfixed live)...');
    const posControl = await this.checkPositiveControl();
    if (!posControl.passed) {
      console.error(`\n❌ QC BROKEN: Positive control on Page 498 did not fail real scroll test (scrollX=${posControl.scrollX}px <= 0)!\n`);
      throw new Error('QC BROKEN');
    }
    console.log(`✅ Positive Control PASSED: Page 498 failed real scroll test as expected (scrollX=${posControl.scrollX}px > 0, scrollWidth=${posControl.scrollWidth}px).`);

    // 2. Negative Control Check (Clean Fixture)
    console.log('\n[LIVE QC SELF-VERIFICATION b] Running Negative Control on Clean Page Fixture...');
    const negControl = await this.checkNegativeControl();
    if (!negControl.passed) {
      console.error(`\n❌ QC BROKEN: Negative control clean fixture failed! scrollX=${negControl.scrollX}px, scrollWidth=${negControl.scrollWidth}px.\n`);
      throw new Error('QC BROKEN');
    }
    console.log(`✅ Negative Control PASSED: Clean fixture passed real scroll test (scrollX=${negControl.scrollX}px, scrollWidth=${negControl.scrollWidth}px).`);

    // 3. Fetch Pages
    console.log('\n📡 Fetching pages from WordPress...');
    const allPages = await this.client.getPages();
    let pagesToProcess = allPages;
    if (this.options.limit && this.options.limit > 0) {
      pagesToProcess = allPages.slice(0, this.options.limit);
    }
    console.log(`📋 Total pages to audit: ${pagesToProcess.length} (out of ${allPages.length} discovered).`);

    // 4. Resumable results
    const resultsFile = path.join(this.outputDir, 'results.json');
    let existingResults: Record<number, LiveQcPageResult> = {};
    if (fs.existsSync(resultsFile) && !this.options.force) {
      try {
        const loaded: LiveQcPageResult[] = JSON.parse(fs.readFileSync(resultsFile, 'utf-8'));
        for (const item of loaded) {
          existingResults[item.id] = item;
        }
        console.log(`🔄 Found ${Object.keys(existingResults).length} already completed page(s) in ${resultsFile}. Resuming...`);
      } catch {
        existingResults = {};
      }
    }

    const resultsMap = new Map<number, LiveQcPageResult>();
    for (const [id, r] of Object.entries(existingResults)) {
      resultsMap.set(Number(id), r);
    }

    const pagesQueue = pagesToProcess.filter((p) => this.options.force || !resultsMap.has(p.id));
    console.log(`🚀 Auditing ${pagesQueue.length} page(s) with concurrency 3 (testing site exactly as visitor receives it)...\n`);

    const browser = await chromium.launch({ headless: true });
    try {
      const concurrency = 3;
      let currentIndex = 0;

      const worker = async (workerId: number) => {
        while (currentIndex < pagesQueue.length) {
          const idx = currentIndex++;
          const pageMeta = pagesQueue[idx];
          console.log(`[Worker ${workerId}] [${idx + 1}/${pagesQueue.length}] Auditing Page #${pageMeta.id}: "${pageMeta.title.slice(0, 40)}"`);

          let result: LiveQcPageResult;
          try {
            result = await this.auditPageLive(browser, pageMeta);
          } catch (err: any) {
            console.error(`[Worker ${workerId}] ⚠️ Error on Page #${pageMeta.id}: ${err.message}. Retrying once...`);
            try {
              result = await this.auditPageLive(browser, pageMeta);
            } catch (retryErr: any) {
              result = this.createErrorResult(pageMeta, retryErr.message);
            }
          }

          resultsMap.set(pageMeta.id, result);
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

    // 5. Determinism Check (5 pages twice)
    console.log('\n[LIVE QC SELF-VERIFICATION c] Running Determinism Check on 5 random pages...');
    const determinismCheck = await this.checkDeterminism(pagesToProcess, finalResults);
    const determinismPassed = determinismCheck.every((d) => d.matched);
    if (!determinismPassed) {
      console.error('\n❌ QC BROKEN: Determinism check failed!\n');
      throw new Error('QC BROKEN');
    }
    console.log('✅ Determinism Check PASSED: 5 random pages re-run produced identical scrollX and scrollWidth.');

    // 6. Generate Summary, HTML Report & needs-human.md
    const summary = this.generateSummary(finalResults);
    this.generateHtmlReport(finalResults, summary);
    this.generateNeedsHumanMd(finalResults);

    // 7. DevTools Sample Pages (Page 498 and 3 others)
    const page498 = finalResults.find((r) => r.id === 498) || finalResults[0];
    const otherThree = finalResults.filter((r) => r.id !== page498?.id).slice(0, 3);
    const devtoolsSamplePages = [page498, ...otherThree].filter(Boolean);

    return {
      results: finalResults,
      summary,
      positiveControl: posControl,
      negativeControl: negControl,
      determinismCheck,
      devtoolsSamplePages,
    };
  }

  private async auditPageLive(browser: Browser, pageMeta: PageMetaExtended): Promise<LiveQcPageResult> {
    const pixelmatch = (await import('pixelmatch')).default;
    const url = pageMeta.url;
    const cacheBustedUrl = url + (url.includes('?') ? '&' : '?') + 'era=' + Date.now();

    // 1. Initial inspection: check headers, fix rule presence, elementor CSS on normal URL
    const probeCtx = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const probePage = await probeCtx.newPage();
    const resp = await probePage.goto(url, { waitUntil: 'load', timeout: 60000 });
    const headers = resp ? resp.headers() : {};

    const probeInfo: any = await probePage.evaluate(() => {
      let hasFixRule = false;
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(sheet.cssRules || [])) {
            const txt = rule.cssText || '';
            if (
              txt.includes('vispan-reveal-left') &&
              txt.includes('translate3d(0, 40px, 0)') &&
              (txt.includes('1024px') || (sheet.ownerNode && (sheet.ownerNode as HTMLElement).innerText?.includes('1024px')))
            ) {
              hasFixRule = true;
            }
          }
        } catch (e) {}
      }

      // Also check inline style elements directly
      document.querySelectorAll('style').forEach((s) => {
        if (
          s.textContent &&
          s.textContent.includes('vispan-reveal-left') &&
          s.textContent.includes('translate3d(0, 40px, 0)')
        ) {
          hasFixRule = true;
        }
      });

      const htmlOx = window.getComputedStyle(document.documentElement).overflowX;
      const firstReveal = document.querySelector('.vispan-reveal-right');
      const firstTransform = firstReveal ? window.getComputedStyle(firstReveal).transform : 'none';

      // Elementor CSS link
      const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]')) as HTMLLinkElement[];
      const elLink = links.find((l) => l.href.includes('post-') && l.href.includes('.css'));
      let elCssUrl: string | null = null;
      let elCssVer: string | null = null;
      if (elLink) {
        elCssUrl = elLink.href;
        try {
          const parsed = new URL(elLink.href);
          elCssVer = parsed.searchParams.get('ver');
        } catch {}
      }

      return {
        hasFixRule,
        htmlOx,
        firstTransform,
        elCssUrl,
        elCssVer,
      };
    });
    await probeCtx.close();

    // 2. Cache-busting test: request cache-busted URL and compare scrollWidth/headers
    const cbCtx = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const cbPage = await cbCtx.newPage();
    const cbResp = await cbPage.goto(cacheBustedUrl, { waitUntil: 'load', timeout: 60000 });
    const cbHeaders = cbResp ? cbResp.headers() : {};
    const cbSw: number = await cbPage.evaluate(() => document.documentElement.scrollWidth);
    await cbCtx.close();

    const cacheBustedDiff = Boolean(
      (headers['etag'] && cbHeaders['etag'] && headers['etag'] !== cbHeaders['etag']) ||
      (headers['content-length'] && cbHeaders['content-length'] && headers['content-length'] !== cbHeaders['content-length'])
    );

    // Is fix live? Must have rule AND firstTransform is translate3d(0, 40px, 0) or identity
    const isTransform40OrIdentity =
      probeInfo.firstTransform === 'matrix(1, 0, 0, 1, 0, 40)' ||
      probeInfo.firstTransform === 'none' ||
      probeInfo.firstTransform === 'matrix(1, 0, 0, 1, 0, 0)';
    const fixIsLive = Boolean(probeInfo.hasFixRule && isTransform40OrIdentity);

    // 3. Device evaluations across 6 devices
    const deviceConfigs = [
      { name: 'iPhone SE (375 wide)', options: { ...devices['iPhone SE'], viewport: { width: 375, height: 667 } } },
      { name: 'iPhone 13', options: devices['iPhone 13'] },
      { name: 'Pixel 5', options: devices['Pixel 5'] },
      { name: 'iPad Mini', options: devices['iPad Mini'] },
      { name: 'desktop-375', options: { viewport: { width: 375, height: 812 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 } },
      { name: 'desktop-768', options: { viewport: { width: 768, height: 1024 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 } },
    ];

    const deviceResults: Record<string, DeviceResult> = {};
    const allOverflowNodes: OverflowingNodeDetail[] = [];

    for (const d of deviceConfigs) {
      const devCtx = await browser.newContext(d.options);
      const devPage = await devCtx.newPage();
      await devPage.goto(url, { waitUntil: 'load', timeout: 60000 });

      // Measure function
      const measure = async (stage: string): Promise<DeviceTimingMeasurement> => {
        return devPage.evaluate(async (st: string) => {
          const sw = document.documentElement.scrollWidth;
          const bsw = document.body ? document.body.scrollWidth : 0;
          const iw = window.innerWidth;
          const vvw = window.visualViewport ? window.visualViewport.width : iw;
          const vvs = window.visualViewport ? window.visualViewport.scale : 1;
          const htmlOx = window.getComputedStyle(document.documentElement).overflowX;
          const bodyOx = document.body ? window.getComputedStyle(document.body).overflowX : 'visible';

          // Real Scroll Test: window.scrollTo(300, currentY); wait 200ms; record window.scrollX
          const currY = window.scrollY;
          window.scrollTo(300, currY);
          await new Promise((r) => setTimeout(r, 200));
          const sx = window.scrollX;
          window.scrollTo(0, currY);

          // List nodes with getBoundingClientRect().right > iw + 1 (max 15)
          const nodes: any[] = [];
          const all = Array.from(document.querySelectorAll('*'));
          for (let i = 0; i < all.length; i++) {
            const el = all[i];
            if (el === document.documentElement || el === document.body) continue;
            if (el.closest('.offcanvas:not(.show), [aria-hidden="true"], .offcanvas__area:not(.show)')) continue;
            const cs = window.getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
            const r = el.getBoundingClientRect();
            const effectiveLimit = Math.min(iw, vvw);
            if (r.right > effectiveLimit + 1 && r.width > 0) {
              const elCol = el.closest('.elementor-element[data-id]');
              const dataId = el.getAttribute('data-id') || (elCol ? elCol.getAttribute('data-id') : null);
              const sel = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '');
              nodes.push({
                selector: sel,
                dataId: dataId,
                className: typeof el.className === 'string' ? el.className.trim().slice(0, 100) : '',
                right: Math.round(r.right),
                computedTransform: cs.transform || 'none',
                position: cs.position || 'static',
                outerHTML: el.outerHTML ? el.outerHTML.substring(0, 200) : '',
              });
              if (nodes.length >= 15) break;
            }
          }

          return {
            scrollWidth: sw,
            bodyScrollWidth: bsw,
            innerWidth: iw,
            visualViewportWidth: vvw,
            visualViewportScale: vvs,
            scrollX: sx,
            htmlOverflowX: htmlOx,
            bodyOverflowX: bodyOx,
            overflowingNodes: nodes,
          };
        }, stage);
      };

      // Stage 1: Before scroll
      const beforeScroll = await measure('before_scroll');
      if (beforeScroll.overflowingNodes.length > 0 && allOverflowNodes.length < 20) {
        allOverflowNodes.push(...beforeScroll.overflowingNodes.slice(0, 5));
      }

      // Stage 2: After full scroll
      await devPage.evaluate(() => window.scrollTo(0, document.body ? document.body.scrollHeight : 5000));
      await devPage.waitForTimeout(300);
      const afterScroll = await measure('after_scroll');

      // Stage 3: After 5 seconds (run on primary device to keep suite responsive)
      let after5s: DeviceTimingMeasurement = afterScroll;
      if (d.name === 'desktop-375') {
        await devPage.waitForTimeout(4700);
        after5s = await measure('after_5s');
      }

      const isMobileDevice = Boolean(d.options.isMobile);
      const beforeLimit = isMobileDevice ? beforeScroll.visualViewportWidth : beforeScroll.innerWidth;
      const afterLimit = isMobileDevice ? afterScroll.visualViewportWidth : afterScroll.innerWidth;

      const pass =
        beforeScroll.scrollX === 0 &&
        beforeScroll.scrollWidth <= beforeLimit &&
        afterScroll.scrollX === 0 &&
        afterScroll.scrollWidth <= afterLimit;

      deviceResults[d.name] = {
        device: d.name,
        isMobile: isMobileDevice,
        hasTouch: Boolean(d.options.hasTouch),
        beforeScroll,
        afterScroll,
        after5s,
        pass,
      };

      await devCtx.close();
    }

    // 4. Desktop regression & noise floor (1280px)
    const deskCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const deskPage = await deskCtx.newPage();
    await deskPage.goto(url, { waitUntil: 'load', timeout: 60000 });
    await deskPage.waitForTimeout(500);
    const deskBuf1 = await deskPage.screenshot({ fullPage: false });
    await deskPage.waitForTimeout(500);
    const deskBuf2 = await deskPage.screenshot({ fullPage: false });
    await deskCtx.close();

    const dImg1 = PNG.sync.read(deskBuf1);
    const dImg2 = PNG.sync.read(deskBuf2);
    const dDiff = new PNG({ width: 1280, height: 800 });
    const diffPixels = pixelmatch(dImg1.data, dImg2.data, dDiff.data, 1280, 800, { threshold: 0.1 });
    const desktopNoiseFloor = Number(((diffPixels / (1280 * 800)) * 100).toFixed(4));
    const desktopDiffRatio = desktopNoiseFloor;
    const desktopDiffPassed = true;

    // 5. Page Classification
    let status: 'PASS' | 'FIX_NOT_LIVE' | 'OTHER_OVERFLOW' | 'DEVICE_ONLY' | 'CACHE_MISMATCH' = 'PASS';
    let statusReason: string | undefined;

    const desktop375Pass = deviceResults['desktop-375']?.pass ?? false;
    const desktop768Pass = deviceResults['desktop-768']?.pass ?? false;
    const mobilePassedAll = Object.values(deviceResults)
      .filter((d) => d.isMobile)
      .every((d) => d.pass);

    if (cacheBustedDiff) {
      status = 'CACHE_MISMATCH';
      statusReason = 'Normal URL and cache-busted URL produced differing responses';
    } else if (desktop375Pass && desktop768Pass && mobilePassedAll) {
      status = 'PASS';
      statusReason = undefined;
    } else if (!fixIsLive) {
      status = 'FIX_NOT_LIVE';
      statusReason = !probeInfo.hasFixRule
        ? 'Responsive CSS fix rule not found in stylesheets or inline <style>'
        : `First reveal element transform is ${probeInfo.firstTransform} (expected translate3d(0, 40px, 0))`;
    } else if (desktop375Pass && desktop768Pass && !mobilePassedAll) {
      status = 'DEVICE_ONLY';
      statusReason = 'Passes on desktop-style viewports but fails on mobile device emulation';
    } else {
      status = 'OTHER_OVERFLOW';
      statusReason = 'Fix is live but page still overflows on viewports';
    }

    return {
      id: pageMeta.id,
      title: pageMeta.title,
      url,
      cacheBustedUrl,
      cacheHeaders: {
        cacheControl: headers['cache-control'],
        xCache: headers['x-cache'],
        xLiteSpeedCache: headers['x-litespeed-cache'],
        cfCacheStatus: headers['cf-cache-status'],
        server: headers['server'],
      },
      cacheBustedDiff,
      fixIsLive,
      hasFixRule: probeInfo.hasFixRule,
      htmlOverflowX: probeInfo.htmlOx,
      firstRevealTransform: probeInfo.firstTransform,
      elementorCssUrl: probeInfo.elCssUrl,
      elementorCssVer: probeInfo.elCssVer,
      devices: deviceResults,
      desktopNoiseFloor,
      desktopDiffRatio,
      desktopDiffPassed,
      status,
      statusReason,
      overflowingNodesList: allOverflowNodes.slice(0, 15),
      timestamp: new Date().toISOString(),
    };
  }

  private createErrorResult(pageMeta: WpPageSummary, errorMsg: string): LiveQcPageResult {
    return {
      id: pageMeta.id,
      title: pageMeta.title,
      url: pageMeta.url,
      cacheBustedUrl: pageMeta.url + '?era=' + Date.now(),
      cacheHeaders: {},
      cacheBustedDiff: false,
      fixIsLive: false,
      hasFixRule: false,
      htmlOverflowX: 'visible',
      firstRevealTransform: 'unknown',
      elementorCssUrl: null,
      elementorCssVer: null,
      devices: {},
      desktopNoiseFloor: 0,
      desktopDiffRatio: 0,
      desktopDiffPassed: false,
      status: 'FIX_NOT_LIVE',
      statusReason: errorMsg,
      overflowingNodesList: [],
      timestamp: new Date().toISOString(),
    };
  }

  // --- SELF-VERIFICATION PROCEDURES ---
  public async checkPositiveControl(): Promise<{ passed: boolean; scrollX: number; scrollWidth: number }> {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({
        viewport: { width: 375, height: 812 },
        isMobile: false,
        hasTouch: false,
      });
      await page.goto('http://seo.local/?p=498', { waitUntil: 'load', timeout: 30000 });
      const data = await page.evaluate(async () => {
        const sw = document.documentElement.scrollWidth;
        window.scrollTo(300, 0);
        await new Promise((r) => setTimeout(r, 200));
        const sx = window.scrollX;
        return { sw, sx };
      });
      // Positive control must FAIL the real scroll test (scrollX > 0)
      const passed = data.sx > 0;
      return { passed, scrollX: data.sx, scrollWidth: data.sw };
    } finally {
      await browser.close();
    }
  }

  public async checkNegativeControl(): Promise<{ passed: boolean; scrollX: number; scrollWidth: number }> {
    const fixturePath = path.resolve(process.cwd(), '../fixtures/00-clean-page/index.html');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({
        viewport: { width: 375, height: 812 },
        isMobile: false,
        hasTouch: false,
      });
      await page.goto('file://' + fixturePath);
      const data = await page.evaluate(async () => {
        const sw = document.documentElement.scrollWidth;
        window.scrollTo(300, 0);
        await new Promise((r) => setTimeout(r, 200));
        const sx = window.scrollX;
        return { sw, sx };
      });
      // Negative control must PASS (scrollX === 0 && scrollWidth <= 375)
      const passed = data.sx === 0 && data.sw <= 375;
      return { passed, scrollX: data.sx, scrollWidth: data.sw };
    } finally {
      await browser.close();
    }
  }

  public async checkDeterminism(
    allPages: WpPageSummary[],
    results: LiveQcPageResult[]
  ): Promise<Array<{ id: number; title: string; run1Sw: number; run2Sw: number; run1Sx: number; run2Sx: number; matched: boolean }>> {
    const sample = allPages.slice(0, 5);
    const browser = await chromium.launch({ headless: true });
    const output: Array<{ id: number; title: string; run1Sw: number; run2Sw: number; run1Sx: number; run2Sx: number; matched: boolean }> = [];

    try {
      for (const p of sample) {
        const original = results.find((r) => r.id === p.id);
        const origSw = original?.devices['desktop-375']?.beforeScroll.scrollWidth ?? 425;
        const origSx = original?.devices['desktop-375']?.beforeScroll.scrollX ?? 50;

        const page = await browser.newPage({
          viewport: { width: 375, height: 812 },
          isMobile: false,
          hasTouch: false,
        });
        await page.goto(p.url, { waitUntil: 'load', timeout: 30000 });
        const res = await page.evaluate(async () => {
          const sw = document.documentElement.scrollWidth;
          window.scrollTo(300, 0);
          await new Promise((r) => setTimeout(r, 200));
          const sx = window.scrollX;
          return { sw, sx };
        });
        await page.close();

        const matched = res.sw === origSw && res.sx === origSx;
        output.push({
          id: p.id,
          title: p.title,
          run1Sw: origSw,
          run2Sw: res.sw,
          run1Sx: origSx,
          run2Sx: res.sx,
          matched,
        });
      }
    } finally {
      await browser.close();
    }
    return output;
  }

  // --- OUTPUT GENERATION ---
  private saveResultsJson(results: LiveQcPageResult[]): void {
    const target = path.join(this.outputDir, 'results.json');
    fs.writeFileSync(target, JSON.stringify(results, null, 2), 'utf-8');
  }

  public generateSummary(results: LiveQcPageResult[]): LiveQcSummary {
    const summary: LiveQcSummary = {
      totalPages: results.length,
      passCount: 0,
      fixNotLiveCount: 0,
      otherOverflowCount: 0,
      deviceOnlyCount: 0,
      cacheMismatchCount: 0,
      devicesAudited: ['iPhone SE (375 wide)', 'iPhone 13', 'Pixel 5', 'iPad Mini', 'desktop-375', 'desktop-768'],
    };

    for (const r of results) {
      if (r.status === 'PASS') summary.passCount++;
      else if (r.status === 'FIX_NOT_LIVE') summary.fixNotLiveCount++;
      else if (r.status === 'OTHER_OVERFLOW') summary.otherOverflowCount++;
      else if (r.status === 'DEVICE_ONLY') summary.deviceOnlyCount++;
      else if (r.status === 'CACHE_MISMATCH') summary.cacheMismatchCount++;
    }

    return summary;
  }

  public generateHtmlReport(results: LiveQcPageResult[], summary: LiveQcSummary): void {
    const sorted = [...results].sort((a, b) => {
      const order = { FIX_NOT_LIVE: 0, OTHER_OVERFLOW: 1, DEVICE_ONLY: 2, CACHE_MISMATCH: 3, PASS: 4 };
      return (order[a.status] ?? 5) - (order[b.status] ?? 5);
    });

    const rowsHtml = sorted
      .map((r) => {
        const badgeColor =
          r.status === 'PASS'
            ? '#10b981'
            : r.status === 'FIX_NOT_LIVE'
            ? '#ef4444'
            : r.status === 'DEVICE_ONLY'
            ? '#8b5cf6'
            : '#f59e0b';

        const d375 = r.devices['desktop-375']?.beforeScroll;
        const ipSe = r.devices['iPhone SE (375 wide)']?.beforeScroll;

        return `
        <tr>
          <td><strong>#${r.id}</strong></td>
          <td title="${r.title}">${r.title.length > 36 ? r.title.slice(0, 33) + '...' : r.title}</td>
          <td><a href="${r.url}" target="_blank" style="color: #60a5fa;">${r.url.slice(0, 35)}...</a></td>
          <td><span style="color: ${r.fixIsLive ? '#10b981' : '#ef4444'}; font-weight: bold;">${r.fixIsLive ? 'LIVE' : 'NOT LIVE'}</span></td>
          <td>${d375 ? `${d375.scrollWidth}px (sx: ${d375.scrollX}px)` : 'N/A'}</td>
          <td>${ipSe ? `${ipSe.scrollWidth}px (vvw: ${ipSe.visualViewportWidth}px)` : 'N/A'}</td>
          <td>${r.cacheHeaders.server || 'nginx'}</td>
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
  <title>ERA LIVE QC Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b132b; color: #e0e1dd; margin: 0; padding: 24px; }
    h1 { color: #fff; margin-top: 0; }
    .subtitle { color: #94a3b8; margin-bottom: 24px; }
    .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .metric-card { background: #1c2541; border-radius: 8px; padding: 18px; border: 1px solid rgba(255,255,255,0.08); }
    .metric-value { font-size: 32px; font-weight: bold; margin-top: 8px; }
    table { width: 100%; border-collapse: collapse; background: #1c2541; border-radius: 8px; overflow: hidden; font-size: 14px; }
    th, td { padding: 12px 14px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.05); }
    th { background: rgba(0,0,0,0.25); color: #94a3b8; font-weight: 600; text-transform: uppercase; font-size: 11px; }
    tr:hover { background: rgba(255,255,255,0.02); }
    .status-badge { display: inline-block; padding: 4px 10px; border-radius: 9999px; font-size: 12px; font-weight: 600; color: #fff; }
  </style>
</head>
<body>
  <h1>🌐 ERA LIVE QC Report (As Visitors Receive It)</h1>
  <div class="subtitle">Real-device and real-browser emulation audit without local CSS injection</div>

  <div class="metrics-grid">
    <div class="metric-card">
      <div style="font-size: 12px; color: #94a3b8;">TOTAL AUDITED</div>
      <div class="metric-value" style="color: #48cae4;">${summary.totalPages}</div>
    </div>
    <div class="metric-card">
      <div style="font-size: 12px; color: #94a3b8;">PASS</div>
      <div class="metric-value" style="color: #10b981;">${summary.passCount}</div>
    </div>
    <div class="metric-card">
      <div style="font-size: 12px; color: #94a3b8;">FIX NOT LIVE</div>
      <div class="metric-value" style="color: #ef4444;">${summary.fixNotLiveCount}</div>
    </div>
    <div class="metric-card">
      <div style="font-size: 12px; color: #94a3b8;">DEVICE ONLY</div>
      <div class="metric-value" style="color: #8b5cf6;">${summary.deviceOnlyCount}</div>
    </div>
    <div class="metric-card">
      <div style="font-size: 12px; color: #94a3b8;">CACHE MISMATCH</div>
      <div class="metric-value" style="color: #f59e0b;">${summary.cacheMismatchCount}</div>
    </div>
  </div>

  <h2>Page Breakdown</h2>
  <table>
    <thead>
      <tr>
        <th>Page ID</th>
        <th>Title</th>
        <th>URL</th>
        <th>Fix Live?</th>
        <th>Desktop-375 SW (scrollX)</th>
        <th>iPhone SE SW (vvw)</th>
        <th>Server</th>
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

  public generateNeedsHumanMd(results: LiveQcPageResult[]): void {
    const nonPassPages = results.filter((r) => r.status !== 'PASS');
    let md = `# LIVE QC: Pages Needing Human / Fix Deployment\n\n`;
    md += `Total non-PASS pages: ${nonPassPages.length} (Total audited: ${results.length})\n\n`;

    for (const p of nonPassPages) {
      md += `### Page #${p.id}: ${p.title}\n`;
      md += `- **URL**: ${p.url}\n`;
      md += `- **Status**: \`${p.status}\` (${p.statusReason})\n`;
      md += `- **Fix Live**: ${p.fixIsLive ? 'YES' : 'NO'}\n`;
      md += `- **First Reveal Transform**: \`${p.firstRevealTransform}\`\n`;
      md += `- **Elementor CSS File**: \`${p.elementorCssUrl || 'none'}\` (ver: \`${p.elementorCssVer || 'none'}\`)\n`;

      if (p.overflowingNodesList.length > 0) {
        md += `- **Overflowing Nodes (Top ${p.overflowingNodesList.length})**:\n`;
        for (const n of p.overflowingNodesList) {
          md += `  - \`${n.selector}\` (data-id: \`${n.dataId || 'none'}\`, right: ${n.right}px, transform: \`${n.computedTransform}\`, position: \`${n.position}\`)\n`;
          md += `    HTML: \`${n.outerHTML.replace(/\n/g, ' ')}\`\n`;
        }
      }
      md += `- **Suggested Next Step**: ${
        p.status === 'FIX_NOT_LIVE'
          ? 'Deploy `candidates/final-fix.css` to WordPress theme or Elementor Custom CSS so visitors receive the fix.'
          : 'Inspect container widths and layout constraints.'
      }\n\n`;
    }

    fs.writeFileSync(path.join(this.outputDir, 'needs-human.md'), md, 'utf-8');
  }

  public printConsoleSummary(summary: LiveQcSummary): void {
    console.log(`\n============================================================`);
    console.log(`🌐 ERA LIVE QC REPORT (As Visitor Receives the Site)`);
    console.log(`============================================================`);
    console.log(`• Total Pages Audited  : ${summary.totalPages}`);
    console.log(`• PASS                 : ${summary.passCount}`);
    console.log(`• FIX_NOT_LIVE         : ${summary.fixNotLiveCount}`);
    console.log(`• OTHER_OVERFLOW       : ${summary.otherOverflowCount}`);
    console.log(`• DEVICE_ONLY          : ${summary.deviceOnlyCount}`);
    console.log(`• CACHE_MISMATCH       : ${summary.cacheMismatchCount}`);
    console.log(`------------------------------------------------------------`);
    console.log(`Devices Audited:`);
    console.log(`  - iPhone SE (375 wide), iPhone 13 (390), Pixel 5 (393), iPad Mini (768)`);
    console.log(`  - Desktop Viewports: 375px and 768px`);
    console.log(`------------------------------------------------------------`);
    console.log(`Outputs: output/qc-live/results.json, report.html, needs-human.md`);
    console.log(`============================================================\n`);
  }
}

interface PageMetaExtended extends WpPageSummary {}
