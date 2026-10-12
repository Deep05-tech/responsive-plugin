import { chromium, Browser, Page } from 'playwright';
import fs from 'fs';
import path from 'path';

export interface VpMetrics {
  scrollWidth: number;
  p0Count: number;
  p1Count: number;
  issues: Array<{ elementId?: string | null; selector: string; right: number }>;
}

export async function measureRawMetrics(url: string, vp: { width: number; height: number; name: string }): Promise<{
  onLoad: VpMetrics;
  afterScroll: VpMetrics;
  after5s: VpMetrics;
}> {
  const browser: Browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  const page: Page = await context.newPage();

  // 1. Immediately after load (no animation reset, no forced end state)
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(200);

  const getMetrics = async (): Promise<VpMetrics> => {
    return page.evaluate(`
      (function(winWidth) {
        var scrollWidth = Math.max(
          document.documentElement.scrollWidth,
          document.body ? document.body.scrollWidth : 0
        );

        var isVisible = function(el) {
          if (!el) return false;
          var r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return false;
          var style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;
          return true;
        };

        var isIgnored = function(el) {
          if (!isVisible(el)) return true;
          var style = window.getComputedStyle(el);
          if (style.position === 'fixed') return true;
          if (el.closest('.offcanvas:not(.show), [aria-hidden="true"], .offcanvas__area:not(.show)')) return true;
          return false;
        };

        var allElements = Array.from(document.querySelectorAll('*'));
        var p0Nodes = [];
        for (var i = 0; i < allElements.length; i++) {
          var el = allElements[i];
          if (el === document.documentElement || el === document.body) continue;
          if (isIgnored(el)) continue;
          var r = el.getBoundingClientRect();
          if (r.right > winWidth + 0.5 && r.width > 0) {
            var elCol = el.closest('.elementor-element[data-id]');
            var dataId = el.getAttribute('data-id') || (elCol ? elCol.getAttribute('data-id') : null);
            var classes = el.className && typeof el.className === 'string'
              ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.')
              : '';
            p0Nodes.push({
              elementId: dataId,
              selector: el.tagName.toLowerCase() + classes,
              right: Math.round(r.right)
            });
          }
        }

        return {
          scrollWidth: scrollWidth,
          p0Count: p0Nodes.length,
          p1Count: 0,
          issues: p0Nodes
        };
      })(${vp.width})
    `);
  };

  const onLoad = await getMetrics();

  // 2. After slow scroll
  await page.evaluate(`
    new Promise(function(resolve) {
      var totalHeight = document.body.scrollHeight || 5000;
      var current = 0;
      var interval = setInterval(function() {
        current += 300;
        window.scrollTo(0, current);
        if (current >= totalHeight) {
          clearInterval(interval);
          window.scrollTo(0, 0);
          setTimeout(resolve, 200);
        }
      }, 50);
    })
  `);
  await page.waitForTimeout(300);
  const afterScroll = await getMetrics();

  // 3. After 5 seconds wait
  await page.waitForTimeout(5000);
  const after5s = await getMetrics();

  await browser.close();
  return { onLoad, afterScroll, after5s };
}

export async function measureSettledMetrics(url: string, vp: { width: number; height: number; name: string }): Promise<VpMetrics> {
  const browser: Browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  const page: Page = await context.newPage();

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
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
    `
  });
  await page.waitForTimeout(500);

  const metrics: VpMetrics = await page.evaluate(`
    (function(winWidth) {
      var scrollWidth = Math.max(
        document.documentElement.scrollWidth,
        document.body ? document.body.scrollWidth : 0
      );

      var isVisible = function(el) {
        if (!el) return false;
        var r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return false;
        var style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;
        return true;
      };

      var isIgnored = function(el) {
        if (!isVisible(el)) return true;
        var style = window.getComputedStyle(el);
        if (style.position === 'fixed') return true;
        if (el.closest('.offcanvas:not(.show), [aria-hidden="true"], .offcanvas__area:not(.show)')) return true;
        return false;
      };

      var allElements = Array.from(document.querySelectorAll('*'));
      var p0Nodes = [];
      for (var i = 0; i < allElements.length; i++) {
        var el = allElements[i];
        if (el === document.documentElement || el === document.body) continue;
        if (isIgnored(el)) continue;
        var r = el.getBoundingClientRect();
        if (r.right > winWidth + 0.5 && r.width > 0) {
          var elCol = el.closest('.elementor-element[data-id]');
          var dataId = el.getAttribute('data-id') || (elCol ? elCol.getAttribute('data-id') : null);
          var classes = el.className && typeof el.className === 'string'
            ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.')
            : '';
          p0Nodes.push({
            elementId: dataId,
            selector: el.tagName.toLowerCase() + classes,
            right: Math.round(r.right)
          });
        }
      }

      return {
        scrollWidth: scrollWidth,
        p0Count: p0Nodes.length,
        p1Count: 0,
        issues: p0Nodes
      };
    })(${vp.width})
  `);

  await browser.close();
  return metrics;
}

export async function runVerification(targetUrl: string) {
  console.log(`\n========================================================================================`);
  console.log(`📊 1. RAW VS SETTLED AUDIT TABLE (${targetUrl})`);
  console.log(`========================================================================================`);

  const mobileRaw = await measureRawMetrics(targetUrl, { width: 375, height: 812, name: 'mobile' });
  const tabletRaw = await measureRawMetrics(targetUrl, { width: 768, height: 1024, name: 'tablet' });

  const mobileSettled = await measureSettledMetrics(targetUrl, { width: 375, height: 812, name: 'mobile' });
  const tabletSettled = await measureSettledMetrics(targetUrl, { width: 768, height: 1024, name: 'tablet' });

  console.log(`Viewport | Mode    | Stage        | scrollWidth | P0 Count | Status`);
  console.log(`----------------------------------------------------------------------------------------`);
  console.log(`Mobile   | RAW     | On Load      | ${mobileRaw.onLoad.scrollWidth}px       | ${mobileRaw.onLoad.p0Count}       | ${mobileRaw.onLoad.p0Count > 0 ? 'OVERFLOW' : 'CLEAN'}`);
  console.log(`Mobile   | RAW     | After Scroll | ${mobileRaw.afterScroll.scrollWidth}px       | ${mobileRaw.afterScroll.p0Count}       | ${mobileRaw.afterScroll.p0Count > 0 ? 'OVERFLOW' : 'CLEAN'}`);
  console.log(`Mobile   | RAW     | After 5s     | ${mobileRaw.after5s.scrollWidth}px       | ${mobileRaw.after5s.p0Count}       | ${mobileRaw.after5s.p0Count > 0 ? 'OVERFLOW' : 'CLEAN'}`);
  console.log(`Mobile   | SETTLED | Steady State | ${mobileSettled.scrollWidth}px       | ${mobileSettled.p0Count}        | ${mobileSettled.p0Count === 0 ? 'CLEAN (0 OVERFLOW)' : 'OVERFLOW'}`);
  console.log(`----------------------------------------------------------------------------------------`);
  console.log(`Tablet   | RAW     | On Load      | ${tabletRaw.onLoad.scrollWidth}px       | ${tabletRaw.onLoad.p0Count}       | ${tabletRaw.onLoad.p0Count > 0 ? 'OVERFLOW' : 'CLEAN'}`);
  console.log(`Tablet   | RAW     | After Scroll | ${tabletRaw.afterScroll.scrollWidth}px       | ${tabletRaw.afterScroll.p0Count}       | ${tabletRaw.afterScroll.p0Count > 0 ? 'OVERFLOW' : 'CLEAN'}`);
  console.log(`Tablet   | RAW     | After 5s     | ${tabletRaw.after5s.scrollWidth}px       | ${tabletRaw.after5s.p0Count}       | ${tabletRaw.after5s.p0Count > 0 ? 'OVERFLOW' : 'CLEAN'}`);
  console.log(`Tablet   | SETTLED | Steady State | ${tabletSettled.scrollWidth}px       | ${tabletSettled.p0Count}        | ${tabletSettled.p0Count === 0 ? 'CLEAN (0 OVERFLOW)' : 'OVERFLOW'}`);
  console.log(`========================================================================================\n`);

  // 2. Per-element transform evidence at 375px in RAW mode
  console.log(`========================================================================================`);
  console.log(`🔬 2. PER-ELEMENT TRANSFORM EVIDENCE (Mobile 375px RAW Mode)`);
  console.log(`========================================================================================`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const page = await ctx.newPage();
  await page.goto(targetUrl, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(500);

  const evidence: any[] = await page.evaluate(`
    (function(winWidth) {
      var allElements = Array.from(document.querySelectorAll('*'));
      var results = [];

      for (var i = 0; i < allElements.length; i++) {
        var el = allElements[i];
        if (el === document.documentElement || el === document.body) continue;
        var rect = el.getBoundingClientRect();
        if (rect.right > winWidth + 0.5 && rect.width > 0) {
          var parent = el.parentElement;
          var pRect = parent ? parent.getBoundingClientRect() : rect;
          var xOffset = Math.round(rect.left - pRect.left);

          var cs = window.getComputedStyle(el);
          var elCol = el.closest('.elementor-element[data-id]');
          var dataId = el.getAttribute('data-id') || (elCol ? elCol.getAttribute('data-id') : null);

          var classes = el.className && typeof el.className === 'string'
            ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.')
            : '';

          // Test if transform is the cause
          var origT = el.style.transform;
          el.style.transform = 'none';
          var anc = el.closest('[class*="vispan-reveal"]');
          var origAncT = anc ? anc.style.transform : null;
          if (anc) anc.style.transform = 'none';

          var testRect = el.getBoundingClientRect();
          el.style.transform = origT;
          if (anc && origAncT !== null) anc.style.transform = origAncT;

          var causedByTransform = testRect.right <= winWidth + 0.5;

          results.push({
            selector: el.tagName.toLowerCase() + classes,
            elementId: dataId,
            rectRight: Math.round(rect.right),
            transform: cs.transform,
            animationName: cs.animationName,
            animationFillMode: cs.animationFillMode,
            xOffset: xOffset,
            causedByTransform: causedByTransform ? 'YES' : 'NO',
          });
        }
      }

      return results;
    })(375)
  `);

  await browser.close();

  for (let idx = 0; idx < evidence.length; idx++) {
    const ev = evidence[idx];
    console.log(`[#${idx + 1}] Element: <${ev.selector}> [data-id="${ev.elementId || 'unmapped'}"] (rect.right: ${ev.rectRight}px)`);
    console.log(`    - Computed Transform   : ${ev.transform}`);
    console.log(`    - Animation Name       : ${ev.animationName}`);
    console.log(`    - Animation Fill Mode  : ${ev.animationFillMode}`);
    console.log(`    - X-Offset from Parent : ${ev.xOffset}px`);
    console.log(`    - Caused by Transform? : 👉 ${ev.causedByTransform}`);
  }
  console.log(`========================================================================================\n`);

  // 3. Simulate Candidates against RAW Baseline (Control, c, d, e, f)
  console.log(`========================================================================================`);
  console.log(`🧪 3. SIMULATION TABLE AGAINST RAW BASELINE (Mobile 375px & Tablet 768px)`);
  console.log(`========================================================================================`);

  const candidates: Array<{ name: string; file?: string; css?: string }> = [
    { name: 'Control (No CSS)', css: '' },
    { name: 'Candidate c.css', file: 'candidates/c.css' },
    { name: 'Candidate d.css', file: 'candidates/d.css' },
    { name: 'Candidate e.css', file: 'candidates/e.css' },
    { name: 'Candidate f.css', file: 'candidates/f.css' },
  ];

  console.log(`Candidate           | Mobile Base P0 / Sw | Mobile Sim P0 / Sw | Tablet Base P0 / Sw | Tablet Sim P0 / Sw | Beats Control? | Verdict`);
  console.log(`---------------------------------------------------------------------------------------------------------------------------------`);

  for (const cand of candidates) {
    let cssContent = cand.css ?? '';
    if (cand.file) {
      const p = path.resolve(process.cwd(), cand.file);
      if (fs.existsSync(p)) {
        cssContent = fs.readFileSync(p, 'utf-8');
      } else {
        const p2 = path.resolve(process.cwd(), 'agent', cand.file);
        if (fs.existsSync(p2)) cssContent = fs.readFileSync(p2, 'utf-8');
      }
    }

    const simBrowser = await chromium.launch({ headless: true });

    // Mobile simulation
    const mCtx = await simBrowser.newContext({ viewport: { width: 375, height: 812 } });
    const mPage = await mCtx.newPage();
    await mPage.goto(targetUrl, { waitUntil: 'load', timeout: 30000 });
    if (cssContent) {
      await mPage.addStyleTag({ content: cssContent });
    }
    await mPage.waitForTimeout(300);
    const mMetrics: any = await mPage.evaluate(`
      (function() {
        var w = window.innerWidth;
        var sw = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0);
        var els = Array.from(document.querySelectorAll('*'));
        var p0 = els.filter(function(el) {
          if (el === document.documentElement || el === document.body) return false;
          var r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.right > w + 0.5 && !el.closest('.offcanvas:not(.show), [aria-hidden="true"]');
        }).length;
        return { sw: sw, p0: p0 };
      })()
    `);
    await mCtx.close();

    // Tablet simulation
    const tCtx = await simBrowser.newContext({ viewport: { width: 768, height: 1024 } });
    const tPage = await tCtx.newPage();
    await tPage.goto(targetUrl, { waitUntil: 'load', timeout: 30000 });
    if (cssContent) {
      await tPage.addStyleTag({ content: cssContent });
    }
    await tPage.waitForTimeout(300);
    const tMetrics: any = await tPage.evaluate(`
      (function() {
        var w = window.innerWidth;
        var sw = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0);
        var els = Array.from(document.querySelectorAll('*'));
        var p0 = els.filter(function(el) {
          if (el === document.documentElement || el === document.body) return false;
          var r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.right > w + 0.5 && !el.closest('.offcanvas:not(.show), [aria-hidden="true"]');
        }).length;
        return { sw: sw, p0: p0 };
      })()
    `);
    await tCtx.close();
    await simBrowser.close();

    const beatsControl = (mMetrics.p0 < mobileRaw.onLoad.p0Count || mMetrics.sw <= 375) && (tMetrics.p0 < tabletRaw.onLoad.p0Count || tMetrics.sw <= 768);
    const isValidated = mMetrics.p0 === 0 && tMetrics.p0 === 0 && mMetrics.sw <= 375 && tMetrics.sw <= 768;
    const verdict = isValidated ? '✅ VALIDATED' : beatsControl ? '⚠️ PARTIAL' : '❌ FAILED';

    const candName = cand.name.padEnd(19);
    const mBase = `${mobileRaw.onLoad.p0Count} / ${mobileRaw.onLoad.scrollWidth}px`.padEnd(19);
    const mSim = `${mMetrics.p0} / ${mMetrics.sw}px`.padEnd(18);
    const tBase = `${tabletRaw.onLoad.p0Count} / ${tabletRaw.onLoad.scrollWidth}px`.padEnd(19);
    const tSim = `${tMetrics.p0} / ${tMetrics.sw}px`.padEnd(18);
    const beatsStr = (beatsControl ? 'YES' : 'NO').padEnd(14);

    console.log(`${candName} | ${mBase} | ${mSim} | ${tBase} | ${tSim} | ${beatsStr} | ${verdict}`);
  }
  console.log(`=================================================================================================================================\n`);
}

if (process.argv[1]?.includes('verify-animations')) {
  runVerification('http://seo.local/us/best-digital-marketing-agency-for-dental-clinic-in-los-angles/').catch(console.error);
}
