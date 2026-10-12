import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { chromium, Browser } from 'playwright';
import { PageAuditor } from '../src/audit/auditor.js';
import { checkDesktopRegression } from '../src/runner/regression.js';

describe('Phase 1 - Stable Capture Procedure Verification', () => {
  let server: http.Server;
  let serverPort: number;
  let serverUrl: string;
  let browser: Browser;
  let auditor: PageAuditor;

  const fixturesDir = path.resolve(process.cwd(), '../fixtures');

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    auditor = new PageAuditor();

    server = http.createServer((req, res) => {
      const parsedPath = (req.url || '').split('?')[0];
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

  it('Stable Capture: Two consecutive captures of the same unmodified page differ by less than 0.5% (proves regression guard will not false-alarm)', async () => {
    const fixtureUrl = `${serverUrl}/01-fixed-width-containers/index.html`;
    const outDir1 = path.resolve(process.cwd(), 'output/stable-capture-run1');
    const outDir2 = path.resolve(process.cwd(), 'output/stable-capture-run2');

    // First stable capture
    await auditor.auditPage({
      pageId: 'stable-capture-run1',
      url: fixtureUrl,
      outputDir: outDir1,
      browser,
    });

    // Second stable capture
    await auditor.auditPage({
      pageId: 'stable-capture-run2',
      url: fixtureUrl,
      outputDir: outDir2,
      browser,
    });

    const screenshot1 = path.join(outDir1, 'desktop.png');
    const screenshot2 = path.join(outDir2, 'desktop.png');

    expect(fs.existsSync(screenshot1)).toBe(true);
    expect(fs.existsSync(screenshot2)).toBe(true);

    const diffResult = checkDesktopRegression(screenshot1, screenshot2, 0.005);

    expect(diffResult.passed).toBe(true);
    expect(diffResult.mismatchRatio).toBeLessThanOrEqual(0.005);
    expect(diffResult.diffPixels).toBeLessThanOrEqual(50);
  });
});
