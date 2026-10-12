import fs from 'fs';
import path from 'path';
import { PageAuditor } from '../audit/auditor.js';
import { AuditReport } from '../audit/types.js';
import { LayoutAnalyst } from '../llm/analyst.js';
import { validatePatches, PatchItem } from '../patch/validator.js';
import { applyPatchesLocally } from '../patch/apply.js';
import { checkDesktopRegression } from './regression.js';
import { EraBridgeClient, PatchResponse } from '../bridge/client.js';
import { ReportGenerator } from '../report/generator.js';
import { EraConfig, loadConfig } from '../config/index.js';
import { ElementorElement } from '../patch/tree.js';

export interface RunOptions {
  pageId: string | number;
  url: string;
  elementorData: ElementorElement[];
  isLiveWp?: boolean;
  dryRun?: boolean;
  outputDir?: string;
  onPageUpdate?: (updatedTree: ElementorElement[]) => Promise<void>;
}

export interface RunIterationResult {
  iteration: number;
  report: AuditReport;
  patchesProposed: PatchItem[];
  appliedDiff?: any[];
  unresolved: any[];
}

export interface RunResult {
  pageId: string | number;
  url: string;
  status: 'passed' | 'needs_human' | 'restored';
  iterations: RunIterationResult[];
  initialReport: AuditReport;
  finalReport: AuditReport;
  allAppliedDiffs: any[];
  allUnresolved: any[];
  backupKey?: string;
  errorMessage?: string;
}

export class LoopRunner {
  private config: EraConfig;
  private auditor: PageAuditor;
  private analyst: LayoutAnalyst;
  private bridgeClient: EraBridgeClient;

  constructor(config?: EraConfig) {
    this.config = config || loadConfig();
    this.auditor = new PageAuditor();
    this.analyst = new LayoutAnalyst(this.config);
    this.bridgeClient = new EraBridgeClient(this.config);
  }

  /**
   * Runs the audit -> analyze -> patch -> re-audit loop with safety guards.
   */
  public async run(options: RunOptions): Promise<RunResult> {
    const { pageId, url, dryRun, isLiveWp } = options;
    const outDir = options.outputDir || path.join(this.config.outputDir, String(pageId));

    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    console.log(`\n🚀 [LOOP RUNNER] Starting responsive optimization loop for Page ${pageId}...`);
    console.log(`   Target URL: ${url}`);
    console.log(`   Mode: ${dryRun ? 'DRY-RUN (simulation)' : isLiveWp ? 'LIVE WP BRIDGE' : 'LOCAL'}`);

    let currentElementorData = [...options.elementorData];
    const iterations: RunIterationResult[] = [];
    const allAppliedDiffs: any[] = [];
    const allUnresolved: any[] = [];
    let initialBackupKey: string | undefined;

    // --- Step 1: Initial Baseline Audit ---
    console.log(`\n[Initial Audit] Auditing baseline layout across 3 viewports...`);
    const initialReport = await this.auditor.auditPage({
      pageId,
      url,
      outputDir: outDir,
    });

    // Save baseline desktop screenshot for regression check
    const baselineDesktopScreenshot = path.join(outDir, 'desktop_baseline.png');
    const currentDesktopScreenshot = path.join(outDir, 'desktop.png');
    if (fs.existsSync(currentDesktopScreenshot)) {
      fs.copyFileSync(currentDesktopScreenshot, baselineDesktopScreenshot);
    }

    // Save initial before screenshots
    const beforeMobileScreenshot = path.join(outDir, 'mobile_before.png');
    const beforeTabletScreenshot = path.join(outDir, 'tablet_before.png');
    if (fs.existsSync(path.join(outDir, 'mobile.png'))) {
      fs.copyFileSync(path.join(outDir, 'mobile.png'), beforeMobileScreenshot);
    }
    if (fs.existsSync(path.join(outDir, 'tablet.png'))) {
      fs.copyFileSync(path.join(outDir, 'tablet.png'), beforeTabletScreenshot);
    }

    let currentReport = initialReport;

    if (currentReport.totalIssues === 0) {
      console.log(`\n✨ Page already satisfies all responsive checks (0 issues).`);
      ReportGenerator.generateHtmlReport(currentReport, outDir, { status: 'passed' });
      return {
        pageId,
        url,
        status: 'passed',
        iterations: [],
        initialReport,
        finalReport: currentReport,
        allAppliedDiffs: [],
        allUnresolved: [],
      };
    }

    const issueHistory = [currentReport.totalIssues];
    let finalStatus: 'passed' | 'needs_human' | 'restored' = 'needs_human';
    let errorMessage: string | undefined;

    // --- Step 2: Fix Iterations Loop (Max 3) ---
    for (let iter = 1; iter <= this.config.maxIterations; iter++) {
      console.log(`\n------------------------------------------------------`);
      console.log(`🔄 Iteration ${iter} of ${this.config.maxIterations} (Current Issues: ${currentReport.totalIssues})`);
      console.log(`------------------------------------------------------`);

      // 1. Analyze
      console.log(`🤖 Invoking Layout Analyst...`);
      const analysis = await this.analyst.analyze({
        elementorData: currentElementorData,
        auditReport: currentReport,
        mobileScreenshotPath: path.join(outDir, 'mobile.png'),
        tabletScreenshotPath: path.join(outDir, 'tablet.png'),
      });

      if (analysis.unresolved.length > 0) {
        allUnresolved.push(...analysis.unresolved);
      }

      if (analysis.patches.length === 0) {
        console.log(`⚠️  Analyst could not propose any further automated patches.`);
        break;
      }

      // 2. Validate Patches (Hard Rule 2 & 7)
      const validation = validatePatches(analysis.patches, currentElementorData, this.config.allowHiding);
      if (!validation.valid) {
        console.error(`❌ Validation failed on proposed patches:`, validation.errors);
        errorMessage = `Patch validation rejected: ${validation.errors.join('; ')}`;
        break;
      }

      const validPatches = validation.validatedPatches;
      console.log(`✅ Validated ${validPatches.length} responsive patch(es).`);

      // 3. Apply Patches
      let appliedDiff: any[] = [];
      if (!dryRun) {
        if (isLiveWp) {
          console.log(`📡 Applying patches to WordPress site via Bridge API...`);
          const patchRes: PatchResponse = await this.bridgeClient.patchPage(
            pageId,
            validPatches,
            this.config.allowHiding
          );
          if (!initialBackupKey) {
            initialBackupKey = patchRes.backup_key;
          }
          appliedDiff = patchRes.applied_diff || [];
        } else {
          // Local in-memory patch
          const localRes = applyPatchesLocally(currentElementorData, validPatches);
          currentElementorData = localRes.updatedTree;
          appliedDiff = localRes.diff;
          if (options.onPageUpdate) {
            await options.onPageUpdate(currentElementorData);
          }
        }
      } else {
        console.log(`[DRY-RUN] Simulating patch application...`);
      }

      allAppliedDiffs.push(...appliedDiff);

      // 4. Re-Audit Page
      console.log(`🔍 Re-auditing page after patches...`);
      const postPatchReport = await this.auditor.auditPage({
        pageId,
        url,
        outputDir: outDir,
      });

      // 5. Hard Rule 4 & Desktop Regression Guard Check
      console.log(`🛡️  Checking desktop regression against baseline...`);
      const regressionCheck = checkDesktopRegression(
        baselineDesktopScreenshot,
        path.join(outDir, 'desktop.png'),
        this.config.desktopDiffThreshold,
        path.join(outDir, `desktop_diff_iter_${iter}.png`)
      );

      if (!regressionCheck.passed) {
        console.error(`\n🚨 CRITICAL DESKTOP REGRESSION DETECTED!`);
        console.error(`   ${regressionCheck.errorMessage}`);
        console.error(`   Initiating automatic restore to pre-run backup...`);

        if (isLiveWp && initialBackupKey && !dryRun) {
          try {
            await this.bridgeClient.restorePage(pageId, initialBackupKey);
            console.log(`♻️  Successfully restored page ${pageId} from backup ${initialBackupKey}.`);
          } catch (restoreErr: any) {
            console.error(`❌ Auto-restore failed: ${restoreErr.message}`);
          }
        }

        finalStatus = 'restored';
        errorMessage = regressionCheck.errorMessage;
        break;
      }

      iterations.push({
        iteration: iter,
        report: postPatchReport,
        patchesProposed: validPatches,
        appliedDiff,
        unresolved: analysis.unresolved,
      });

      currentReport = postPatchReport;
      issueHistory.push(currentReport.totalIssues);

      console.log(`📊 Issue count: ${issueHistory[issueHistory.length - 2]} -> ${currentReport.totalIssues}`);

      // Check if page passed all checks
      if (currentReport.totalIssues === 0) {
        console.log(`\n🎉 SUCCESS: All measurable layout checks passed!`);
        finalStatus = 'passed';
        break;
      }

      // Check if issue count stopped decreasing for 2 iterations
      if (issueHistory.length >= 3) {
        const last = issueHistory[issueHistory.length - 1];
        const prev1 = issueHistory[issueHistory.length - 2];
        const prev2 = issueHistory[issueHistory.length - 3];

        if (last >= prev1 && prev1 >= prev2) {
          console.log(`\n⚠️  Issue count stopped decreasing across 2 consecutive iterations (${prev2} -> ${prev1} -> ${last}).`);
          console.log(`   Marking page as "needs human" and stopping.`);
          finalStatus = 'needs_human';
          break;
        }
      }
    }

    // Generate final HTML and JSON reports
    ReportGenerator.generateHtmlReport(currentReport, outDir, {
      status: finalStatus,
      diff: allAppliedDiffs,
      unresolved: allUnresolved,
    });

    console.log(`\n======================================================`);
    console.log(`🏁 RUN COMPLETE for Page ${pageId}: Status = [${finalStatus.toUpperCase()}]`);
    console.log(`   Initial Issues : ${initialReport.totalIssues}`);
    console.log(`   Final Issues   : ${currentReport.totalIssues}`);
    console.log(`   Total Patches  : ${allAppliedDiffs.length}`);
    console.log(`   Report         : ${path.join(outDir, 'report.html')}`);
    console.log(`======================================================\n`);

    return {
      pageId,
      url,
      status: finalStatus,
      iterations,
      initialReport,
      finalReport: currentReport,
      allAppliedDiffs,
      allUnresolved,
      backupKey: initialBackupKey,
      errorMessage,
    };
  }
}
