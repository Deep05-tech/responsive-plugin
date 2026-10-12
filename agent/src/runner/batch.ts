import fs from 'fs';
import path from 'path';
import { LoopRunner, RunResult } from './loop.js';
import { EraBridgeClient } from '../bridge/client.js';
import { EraConfig, loadConfig } from '../config/index.js';

export interface BatchRunSummary {
  startedAt: string;
  completedAt: string;
  totalPages: number;
  passed: number;
  needsHuman: number;
  restored: number;
  results: Record<string, RunResult>;
}

export class BatchRunner {
  private config: EraConfig;
  private bridgeClient: EraBridgeClient;
  private loopRunner: LoopRunner;

  constructor(config?: EraConfig) {
    this.config = config || loadConfig();
    this.bridgeClient = new EraBridgeClient(this.config);
    this.loopRunner = new LoopRunner(this.config);
  }

  /**
   * Run the fix loop across all pages with rate limiting and resumable state.
   */
  public async runAll(options: { dryRun?: boolean; delayMs?: number }): Promise<BatchRunSummary> {
    const delayMs = options.delayMs || 1000;
    const progressFile = path.join(this.config.outputDir, 'batch_progress.json');

    console.log(`\n📚 [BATCH RUNNER] Fetching all Elementor pages from WordPress bridge...`);
    const pages = await this.bridgeClient.getPages();
    console.log(`📋 Found ${pages.length} Elementor page(s) to optimize.`);

    let completedResults: Record<string, RunResult> = {};
    if (fs.existsSync(progressFile)) {
      try {
        const saved = JSON.parse(fs.readFileSync(progressFile, 'utf-8'));
        completedResults = saved.results || {};
        console.log(`💾 Resuming from previous session: ${Object.keys(completedResults).length} pages already processed.`);
      } catch {
        // Start fresh
      }
    }

    const summary: BatchRunSummary = {
      startedAt: new Date().toISOString(),
      completedAt: '',
      totalPages: pages.length,
      passed: 0,
      needsHuman: 0,
      restored: 0,
      results: completedResults,
    };

    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const pageKey = String(p.id);

      if (summary.results[pageKey]) {
        console.log(`⏩ [${i + 1}/${pages.length}] Skipping already processed Page #${p.id} ("${p.title}")`);
        continue;
      }

      console.log(`\n======================================================`);
      console.log(`🚀 [${i + 1}/${pages.length}] Processing Page #${p.id}: "${p.title}"`);
      console.log(`======================================================`);

      try {
        const detail = await this.bridgeClient.getPage(p.id);
        const res = await this.loopRunner.run({
          pageId: p.id,
          url: p.url,
          elementorData: detail._elementor_data || [],
          isLiveWp: true,
          dryRun: options.dryRun,
        });

        summary.results[pageKey] = res;

        // Save progress incrementally
        fs.writeFileSync(progressFile, JSON.stringify(summary, null, 2), 'utf-8');

        // Rate limit pause between pages
        if (i < pages.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      } catch (err: any) {
        console.error(`❌ Failed processing page #${p.id}: ${err.message}`);
      }
    }

    summary.completedAt = new Date().toISOString();
    for (const res of Object.values(summary.results)) {
      if (res.status === 'passed') summary.passed++;
      else if (res.status === 'restored') summary.restored++;
      else summary.needsHuman++;
    }

    // Save final batch report
    fs.writeFileSync(
      path.join(this.config.outputDir, 'batch_report.json'),
      JSON.stringify(summary, null, 2),
      'utf-8'
    );

    return summary;
  }
}
