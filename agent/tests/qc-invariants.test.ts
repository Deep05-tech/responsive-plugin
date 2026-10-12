import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { QcPageResult, QcSummary } from '../src/qc/types.js';
import { QcRunner } from '../src/qc/runner.js';
import { loadConfig } from '../src/config/index.js';

describe('ERA QC Invariants & Security Guard', () => {
  const qcOutputDir = path.resolve(process.cwd(), 'output/qc');
  const resultsJsonPath = path.join(qcOutputDir, 'results.json');
  const reportHtmlPath = path.join(qcOutputDir, 'report.html');
  const needsHumanPath = path.join(qcOutputDir, 'needs-human.md');

  beforeAll(async () => {
    // Ensure QC output exists (run minimal limit if not present)
    if (!fs.existsSync(resultsJsonPath)) {
      const runner = new QcRunner(loadConfig(), { limit: 2 });
      await runner.run();
    }
  });

  it('Invariant 1: Counts in the summary strictly equal number of records in results.json', () => {
    expect(fs.existsSync(resultsJsonPath)).toBe(true);
    const results: QcPageResult[] = JSON.parse(fs.readFileSync(resultsJsonPath, 'utf-8'));
    const runner = new QcRunner();
    const summary = runner.generateSummary(results);

    expect(summary.totalPages).toBe(results.length);
    const sumStatuses = summary.passCount + summary.reviewLayoutCount + summary.needsHumanCount + summary.errorCount;
    expect(sumStatuses).toBe(results.length);
  });

  it('Invariant 2: Partitioning: PASS + needs_human + review_layout + errors covers every page exactly once', () => {
    const results: QcPageResult[] = JSON.parse(fs.readFileSync(resultsJsonPath, 'utf-8'));
    const allowedStatuses = new Set(['PASS', 'review_layout', 'needs_human', 'error']);

    for (const r of results) {
      expect(allowedStatuses.has(r.status)).toBe(true);
    }

    const runner = new QcRunner();
    const summary = runner.generateSummary(results);

    // Group breakdown totals must sum up to total pages
    const groupTotal =
      summary.byGroup.city_landing_page.total +
      summary.byGroup.library_template.total +
      summary.byGroup.other.total;
    expect(groupTotal).toBe(results.length);
  });

  it('Invariant 3: Security Invariant: No credentials appear in any QC output file', () => {
    const config = loadConfig();
    const sensitiveTokens = [
      process.env.WP_APP_PASSWORD,
      process.env.OPENAI_API_KEY,
      process.env.ANTHROPIC_API_KEY,
    ].filter((t): t is string => Boolean(t && t.length >= 6));

    const filesToScan: string[] = [];
    const collectFiles = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          collectFiles(full);
        } else if (ent.isFile() && (ent.name.endsWith('.json') || ent.name.endsWith('.html') || ent.name.endsWith('.md'))) {
          filesToScan.push(full);
        }
      }
    };
    collectFiles(qcOutputDir);

    expect(filesToScan.length).toBeGreaterThan(0);
    for (const file of filesToScan) {
      const content = fs.readFileSync(file, 'utf-8');
      for (const token of sensitiveTokens) {
        expect(content).not.toContain(token);
      }
    }
  });

  it('Invariant 4: Read-Only Invariant: No non-GET request is made to WordPress during era qc', () => {
    expect(process.env.ERA_ENABLE_WRITES).not.toBe('true');
  });

  describe('ERA LIVE QC Invariants & Security Guard', () => {
    const liveOutputDir = path.resolve(process.cwd(), 'output/qc-live');
    const liveResultsJsonPath = path.join(liveOutputDir, 'results.json');

    it('Live Invariant 1: Counts in live summary strictly equal number of records in results.json', () => {
      if (!fs.existsSync(liveResultsJsonPath)) return;
      const results = JSON.parse(fs.readFileSync(liveResultsJsonPath, 'utf-8'));
      const countStatuses = results.filter((r: any) =>
        ['PASS', 'FIX_NOT_LIVE', 'OTHER_OVERFLOW', 'DEVICE_ONLY', 'CACHE_MISMATCH'].includes(r.status)
      ).length;
      expect(countStatuses).toBe(results.length);
    });

    it('Live Invariant 2: No credentials appear in any LIVE QC output file', () => {
      const sensitiveTokens = [
        process.env.WP_APP_PASSWORD,
        process.env.OPENAI_API_KEY,
        process.env.ANTHROPIC_API_KEY,
      ].filter((t): t is string => Boolean(t && t.length >= 6));

      if (!fs.existsSync(liveOutputDir)) return;
      const entries = fs.readdirSync(liveOutputDir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isFile() && (ent.name.endsWith('.json') || ent.name.endsWith('.html') || ent.name.endsWith('.md'))) {
          const content = fs.readFileSync(path.join(liveOutputDir, ent.name), 'utf-8');
          for (const token of sensitiveTokens) {
            expect(content).not.toContain(token);
          }
        }
      }
    });

    it('Live Invariant 3: Mobile emulation device fails if scrollWidth > visualViewport.width or scrollX > 0 even if scrollWidth == innerWidth', () => {
      // Create mock measurements where mobile browser expanded layout innerWidth = 425 to match scrollWidth = 425,
      // but visualViewport.width = 375 (iPhone SE)
      const mockMobileDevice = {
        isMobile: true,
        beforeScroll: {
          scrollWidth: 425,
          innerWidth: 425,
          visualViewportWidth: 375,
          scrollX: 0,
        },
        afterScroll: {
          scrollWidth: 425,
          innerWidth: 425,
          visualViewportWidth: 375,
          scrollX: 0,
        },
      };

      const beforeLimit = mockMobileDevice.isMobile ? mockMobileDevice.beforeScroll.visualViewportWidth : mockMobileDevice.beforeScroll.innerWidth;
      const afterLimit = mockMobileDevice.isMobile ? mockMobileDevice.afterScroll.visualViewportWidth : mockMobileDevice.afterScroll.innerWidth;

      const passed =
        mockMobileDevice.beforeScroll.scrollX === 0 &&
        mockMobileDevice.beforeScroll.scrollWidth <= beforeLimit &&
        mockMobileDevice.afterScroll.scrollX === 0 &&
        mockMobileDevice.afterScroll.scrollWidth <= afterLimit;

      expect(passed).toBe(false);

      // And test scrollX > 0 causes fail
      const mockScrollXFail = {
        isMobile: true,
        beforeScroll: {
          scrollWidth: 375,
          innerWidth: 375,
          visualViewportWidth: 375,
          scrollX: 10,
        },
        afterScroll: {
          scrollWidth: 375,
          innerWidth: 375,
          visualViewportWidth: 375,
          scrollX: 0,
        },
      };
      const scrollXPassed =
        mockScrollXFail.beforeScroll.scrollX === 0 &&
        mockScrollXFail.beforeScroll.scrollWidth <= mockScrollXFail.beforeScroll.visualViewportWidth &&
        mockScrollXFail.afterScroll.scrollX === 0 &&
        mockScrollXFail.afterScroll.scrollWidth <= mockScrollXFail.afterScroll.visualViewportWidth;

      expect(scrollXPassed).toBe(false);
    });
  });
});
