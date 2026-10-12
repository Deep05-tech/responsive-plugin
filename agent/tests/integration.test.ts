import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { chromium, Browser } from 'playwright';
import { PageAuditor } from '../src/audit/auditor.js';
import { LoopRunner } from '../src/runner/loop.js';
import { applyPatchesLocally } from '../src/patch/apply.js';
import { checkDesktopRegression } from '../src/runner/regression.js';
import { ElementorElement } from '../src/patch/tree.js';

describe('Phase 3 - Integration Test: Audit -> Patch -> Re-Audit Loop & Regression Guard', () => {
  let server: http.Server;
  let serverPort: number;
  let serverUrl: string;
  let browser: Browser;
  let auditor: PageAuditor;

  const fixturesDir = path.resolve(process.cwd(), '../fixtures');
  let currentHtmlContent: string = '';

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    auditor = new PageAuditor();

    server = http.createServer((req, res) => {
      const parsedPath = (req.url || '').split('?')[0];

      if (parsedPath === '/dynamic-fixture.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(currentHtmlContent);
        return;
      }

      const filePath = path.join(fixturesDir, parsedPath);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        const contentType = ext === '.html' ? 'text/html' : ext === '.json' ? 'application/json' : 'text/plain';
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(fs.readFileSync(filePath));
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const address = server.address() as any;
        serverPort = address.port;
        serverUrl = `http://localhost:${serverPort}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('Integration: Audit -> Patch -> Re-Audit drops issue count and preserves desktop layout', async () => {
    const fixtureHtml = fs.readFileSync(
      path.join(fixturesDir, '01-fixed-width-containers/index.html'),
      'utf-8'
    );
    const fixtureJson: ElementorElement[] = JSON.parse(
      fs.readFileSync(path.join(fixturesDir, '01-fixed-width-containers/data.json'), 'utf-8')
    );

    currentHtmlContent = fixtureHtml;
    const fixtureUrl = `${serverUrl}/dynamic-fixture.html`;
    const outputDir = path.resolve(process.cwd(), 'output/test-integration-01');

    // 1. Initial audit
    const initialReport = await auditor.auditPage({
      pageId: 'test-integration-01',
      url: fixtureUrl,
      outputDir,
      browser,
    });

    expect(initialReport.totalIssues).toBeGreaterThan(0);
    expect(initialReport.viewports.mobile.hasHorizontalOverflow).toBe(true);

    const baselineDesktopScreenshot = path.join(outputDir, 'desktop_baseline.png');
    fs.copyFileSync(path.join(outputDir, 'desktop.png'), baselineDesktopScreenshot);

    // 2. Apply responsive patches: change mobile container widths and flex wraps
    const patches = [
      {
        element_id: 'w-fixed-box-container',
        settings: {
          width_mobile: { unit: '%', size: 100 },
          _element_width_mobile: 'inherit',
          flex_direction_mobile: 'column',
        },
      },
      {
        element_id: 'sec-fixed-promo',
        settings: {
          width_mobile: { unit: '%', size: 100 },
          _element_width_mobile: 'inherit',
        },
      },
    ];

    const patchResult = applyPatchesLocally(fixtureJson, patches);
    expect(patchResult.diff.length).toBe(2);

    // Update HTML with responsive CSS rules corresponding to the responsive patches applied
    currentHtmlContent = fixtureHtml.replace(
      '</style>',
      `
      @media (max-width: 767px) {
        #w-fixed-box-container { width: 100% !important; max-width: 100% !important; }
        #w-fixed-box-container div { width: 100% !important; max-width: 100% !important; }
        #sec-fixed-promo { width: 100% !important; max-width: 100% !important; }
      }
      </style>`
    );

    // 3. Re-audit
    const postPatchReport = await auditor.auditPage({
      pageId: 'test-integration-01',
      url: fixtureUrl,
      outputDir,
      browser,
    });

    // Verify issue count dropped significantly
    expect(postPatchReport.totalIssues).toBeLessThan(initialReport.totalIssues);
    expect(postPatchReport.viewports.mobile.hasHorizontalOverflow).toBe(false);

    // Verify Desktop layout is completely unchanged (diff ratio = 0)
    const regressionCheck = checkDesktopRegression(
      baselineDesktopScreenshot,
      path.join(outputDir, 'desktop.png'),
      0.005
    );

    expect(regressionCheck.passed).toBe(true);
    expect(regressionCheck.mismatchRatio).toBeLessThanOrEqual(0.005);
  });

  it('Desktop Regression Guard: Catches desktop changes exceeding threshold and triggers alarm', async () => {
    const fixtureHtml = fs.readFileSync(
      path.join(fixturesDir, '01-fixed-width-containers/index.html'),
      'utf-8'
    );

    currentHtmlContent = fixtureHtml;
    const fixtureUrl = `${serverUrl}/dynamic-fixture.html`;
    const outputDir = path.resolve(process.cwd(), 'output/test-regression-guard');

    await auditor.auditPage({
      pageId: 'test-regression-guard',
      url: fixtureUrl,
      outputDir,
      browser,
    });

    const baselineScreenshot = path.join(outputDir, 'desktop_baseline.png');
    fs.copyFileSync(path.join(outputDir, 'desktop.png'), baselineScreenshot);

    // Introduce an intentional desktop regression (e.g. huge red banner across desktop)
    currentHtmlContent = fixtureHtml.replace(
      '<body>',
      '<body><div style="background:red; height:300px; width:100%; color:white; font-size:40px;">BREAKING DESKTOP REGRESSION</div>'
    );

    await auditor.auditPage({
      pageId: 'test-regression-guard',
      url: fixtureUrl,
      outputDir,
      browser,
    });

    const regression = checkDesktopRegression(
      baselineScreenshot,
      path.join(outputDir, 'desktop.png'),
      0.005,
      path.join(outputDir, 'desktop_diff.png')
    );

    expect(regression.passed).toBe(false);
    expect(regression.mismatchRatio).toBeGreaterThan(0.005);
    expect(regression.diffPixels).toBeGreaterThan(1000);
    expect(fs.existsSync(path.join(outputDir, 'desktop_diff.png'))).toBe(true);
  });
});
