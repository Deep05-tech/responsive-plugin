import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { chromium, Browser } from 'playwright';
import { PageAuditor } from '../src/audit/auditor.js';
import { checkProductionBlocklist } from '../src/config/index.js';

describe('Phase 1 - Responsive Layout Auditor, Clean Page & 5 Broken Fixtures', () => {
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

  it('Clean Page Fixture: Asserts zero responsive issues detected across all 3 viewports', async () => {
    const fixtureUrl = `${serverUrl}/00-clean-page/index.html`;
    const report = await auditor.auditPage({
      pageId: 'clean-page',
      url: fixtureUrl,
      browser,
    });

    expect(report.totalIssues).toBe(0);
    expect(report.viewports.mobile.issues.length).toBe(0);
    expect(report.viewports.mobile.hasHorizontalOverflow).toBe(false);
    expect(report.viewports.tablet.issues.length).toBe(0);
    expect(report.viewports.tablet.hasHorizontalOverflow).toBe(false);
    expect(report.viewports.desktop.issues.length).toBe(0);
    expect(report.viewports.desktop.hasHorizontalOverflow).toBe(false);
    expect(Object.keys(report.issuesByElementId).length).toBe(0);
    expect(report.summary.totalIssues).toBe(0);
  });

  it('Fixture 01: Accurately detects fixed-width container overflows mapped to element IDs', async () => {
    const fixtureUrl = `${serverUrl}/01-fixed-width-containers/index.html`;
    const report = await auditor.auditPage({
      pageId: 'fixture-01',
      url: fixtureUrl,
      browser,
    });

    // Mobile (375px) must detect horizontal overflow attributed to element
    expect(report.viewports.mobile.hasHorizontalOverflow).toBe(true);
    expect(report.viewports.mobile.scrollWidth).toBeGreaterThan(375);

    // Verify element ID mapping for planted bugs
    const elementIds = Object.keys(report.issuesByElementId);
    expect(elementIds).toContain('sec-fixed-promo');
    expect(elementIds).toContain('w-fixed-box-container');

    // Verify issue types
    const mobileIssues = report.viewports.mobile.issues;
    const issueTypes = mobileIssues.map((i) => i.type);
    expect(issueTypes).toContain('horizontal_overflow');
    expect(issueTypes).toContain('overflowing_element');
    expect(issueTypes).toContain('fixed_pixel_width_overflow');

    // Desktop (1280px) should have no horizontal overflow
    expect(report.viewports.desktop.hasHorizontalOverflow).toBe(false);
  });

  it('Fixture 02: Accurately detects overflowing image row and container overflow mapped to element IDs', async () => {
    const fixtureUrl = `${serverUrl}/02-overflowing-image-row/index.html`;
    const report = await auditor.auditPage({
      pageId: 'fixture-02',
      url: fixtureUrl,
      browser,
    });

    expect(report.viewports.mobile.hasHorizontalOverflow).toBe(true);

    const elementIds = Object.keys(report.issuesByElementId);
    expect(elementIds.some((id) => id.includes('sec-img-gallery-row') || id.includes('img-card'))).toBe(true);

    const mobileIssues = report.viewports.mobile.issues;
    expect(mobileIssues.some((i) => i.type === 'overflowing_element')).toBe(true);
  });

  it('Fixture 03: Accurately detects tiny tap targets, small font sizes, and overlapping elements', async () => {
    const fixtureUrl = `${serverUrl}/03-tiny-tap-targets-and-text/index.html`;
    const report = await auditor.auditPage({
      pageId: 'fixture-03',
      url: fixtureUrl,
      browser,
    });

    const mobileIssues = report.viewports.mobile.issues;

    const smallTextIssues = mobileIssues.filter((i) => i.type === 'small_font_size');
    expect(smallTextIssues.length).toBeGreaterThanOrEqual(1);
    expect(smallTextIssues.some((i) => i.elementId === 'w-legal-disclaimer')).toBe(true);

    const tapTargetIssues = mobileIssues.filter((i) => i.type === 'small_tap_target');
    expect(tapTargetIssues.length).toBeGreaterThanOrEqual(1);
    expect(tapTargetIssues.some((i) => i.elementId === 'w-tiny-cta-btn')).toBe(true);

    const overlapIssues = mobileIssues.filter((i) => i.type === 'overlapping_elements');
    expect(overlapIssues.length).toBeGreaterThanOrEqual(1);
    expect(
      overlapIssues.some((i) => i.elementId === 'w-badge-tag-overlap-1' || i.elementId === 'w-badge-tag-overlap-2')
    ).toBe(true);
  });

  it('Fixture 04 Regression: Accurately detects P0 overflow on hdr-nav-menu-widget at mobile/tablet and small_tap_target on mobile', async () => {
    const fixtureUrl = `${serverUrl}/04-header-template/index.html`;
    const report = await auditor.auditPage({
      pageId: 'fixture-04',
      url: fixtureUrl,
      browser,
    });

    // 1. Mobile & Tablet horizontal overflow on hdr-nav-menu-widget
    expect(report.viewports.mobile.hasHorizontalOverflow).toBe(true);
    expect(report.viewports.tablet.hasHorizontalOverflow).toBe(true);

    const mobileP0 = report.viewports.mobile.issues.filter(
      (i) => i.severity === 'P0' && i.elementId === 'hdr-nav-menu-widget'
    );
    expect(mobileP0.length).toBeGreaterThanOrEqual(1);
    expect(mobileP0.some((i) => i.confirmedByRemoval === true)).toBe(true);

    const tabletP0 = report.viewports.tablet.issues.filter(
      (i) => i.severity === 'P0' && i.elementId === 'hdr-nav-menu-widget'
    );
    expect(tabletP0.length).toBeGreaterThanOrEqual(1);

    // 2. Mobile tap targets check
    const mobileTap = report.viewports.mobile.issues.filter((i) => i.type === 'small_tap_target');
    expect(mobileTap.length).toBeGreaterThanOrEqual(1);
  });

  it('Fixture 05 Offcanvas: Closed drawer parked offscreen is ignored, real overflowing box confirmed by removal', async () => {
    const fixtureUrl = `${serverUrl}/05-offcanvas-drawer/index.html`;
    const report = await auditor.auditPage({
      pageId: 'fixture-05',
      url: fixtureUrl,
      browser,
    });

    expect(report.viewports.mobile.hasHorizontalOverflow).toBe(true);

    // Confirmed culprit must be real-overflow-box, NOT offcanvasOne
    const mobileP0 = report.viewports.mobile.issues.filter((i) => i.severity === 'P0' && i.type === 'horizontal_overflow');
    expect(mobileP0.length).toBeGreaterThanOrEqual(1);
    expect(mobileP0[0].elementId).toBe('real-overflow-box');
    expect(mobileP0[0].confirmedByRemoval).toBe(true);

    // Ensure offcanvas drawer is NOT blamed
    const offcanvasIssues = report.viewports.mobile.issues.filter((i) => i.selector.includes('offcanvas'));
    expect(offcanvasIssues.length).toBe(0);
  });

  it('Fix 5 Report Integrity Invariants: Verifies total sums across elements, severity, and patchability', async () => {
    const fixtureUrl = `${serverUrl}/03-tiny-tap-targets-and-text/index.html`;
    const report = await auditor.auditPage({
      pageId: 'fixture-03',
      url: fixtureUrl,
      browser,
    });

    const total = report.totalIssues;

    // 1. Sum of per-element counts == totalIssues
    const elementSum = Object.values(report.issuesByElementId).reduce((acc, g) => acc + g.total, 0);
    expect(elementSum).toBe(total);

    // 2. Sum of per-severity counts == totalIssues
    const severitySum = report.summary.bySeverity.P0 + report.summary.bySeverity.P1 + report.summary.bySeverity.P2;
    expect(severitySum).toBe(total);

    // 3. Patchable + unpatchable == totalIssues
    expect(report.summary.patchableCount + report.summary.unpatchableCount).toBe(total);

    // 4. Summary totalIssues == report.totalIssues
    expect(report.summary.totalIssues).toBe(total);
  });

  it('Security Invariant: Ensures credentials (WP_APP_PASSWORD / OPENAI_API_KEY) are never in report files', async () => {
    const fixtureUrl = `${serverUrl}/01-fixed-width-containers/index.html`;
    const outDir = path.join(process.cwd(), 'output', 'security_test');

    const report = await auditor.auditPage({
      pageId: 'security_test',
      url: fixtureUrl,
      outputDir: outDir,
      browser,
    });

    const reportJsonContent = fs.readFileSync(path.join(outDir, 'report.json'), 'utf-8');
    const secretValues = [
      process.env.WP_APP_PASSWORD,
      process.env.OPENAI_API_KEY,
    ].filter((s): s is string => Boolean(s) && s.length > 5);

    for (const secret of secretValues) {
      expect(reportJsonContent).not.toContain(secret);
    }
  });

  it('Enforces Hard Rule 3: Blocks execution on production URLs', () => {
    const blocklist = ['myproduction.com', 'live-site.org', 'client.com'];

    expect(() => {
      checkProductionBlocklist('https://client.com/about', blocklist);
    }).toThrow(/\[CRITICAL SAFETY BLOCK\]/);

    expect(() => {
      checkProductionBlocklist('https://subdomain.myproduction.com/page-1', blocklist);
    }).toThrow(/\[CRITICAL SAFETY BLOCK\]/);

    expect(() => {
      checkProductionBlocklist('https://staging.client.com/page-1', ['client.com']);
    }).toThrow(/\[CRITICAL SAFETY BLOCK\]/);

    expect(() => {
      checkProductionBlocklist('https://staging-client.test/page-1', blocklist);
    }).not.toThrow();
  });
});
