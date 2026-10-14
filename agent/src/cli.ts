#!/usr/bin/env node
import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import { PageAuditor } from './audit/auditor.js';
import { Issue, ElementIssuesGroup } from './audit/types.js';
import { ReportGenerator } from './report/generator.js';
import { EraBridgeClient } from './bridge/client.js';
import { LayoutAnalyst } from './llm/analyst.js';
import { validatePatches } from './patch/validator.js';
import { LoopRunner } from './runner/loop.js';
import { BatchRunner } from './runner/batch.js';
import { loadConfig, EXTENDED_VIEWPORTS } from './config/index.js';
import { ElementorElement } from './patch/tree.js';
import { checkDesktopRegression } from './runner/regression.js';
import { runDiagnosis, runInnerDiagnosis, checkTabletAnimations, getRemainingP0NodeDetails } from './audit/diagnose.js';
import { evaluateSimulationVerdict } from './runner/simulation-evaluator.js';
import { QcRunner } from './qc/runner.js';
import { LiveQcRunner } from './qc/live-runner.js';
import { FormQcRunner } from './qc/form-runner.js';
import { chromium } from 'playwright';

const program = new Command();

program
  .name('era')
  .description('Elementor Responsive Agent CLI')
  .version('1.0.0');

// Command: era audit --page <id|url|all>
program
  .command('audit')
  .description('Audit Elementor pages/templates at mobile (375px), tablet (768px), and desktop (1280px) viewports (Read-Only)')
  .requiredOption('-p, --page <page>', 'Page ID, Target URL, or "all" to audit all pages')
  .option('-o, --output <dir>', 'Output directory for reports and screenshots')
  .option('-e, --extended', 'Audit extended viewports including iPad Pro 13 (1032x1376) and Surface Pro 10 (960x1440)')
  .option('--limit <limit>', 'Limit number of pages to audit in batch mode (default: 20)', '20')
  .option('--mode <mode>', 'Audit mode: "raw" or "settled" (default: "settled")', 'settled')
  .action(async (options) => {
    const pageArg = options.page;
    const config = loadConfig();
    const auditor = new PageAuditor();
    const client = new EraBridgeClient(config);

    if (pageArg.toLowerCase() === 'all') {
      console.log(`\n🔍 [ERA AUDIT ALL] Fetching Elementor pages and templates (mode: ${options.mode})...`);
      try {
        const allPages = await client.getPages();
        const limitCount = parseInt(options.limit || '20', 10);
        const pages = allPages.slice(0, limitCount);
        console.log(`📋 Found ${allPages.length} item(s). Running batch audit for first ${pages.length} page(s)...\n`);

        if (options.mode === 'raw') {
          console.log(`=============================================================================================================`);
          console.log(`📊 BATCH AUDIT RAW VS SETTLED COMPARISON (LIMIT: ${pages.length})`);
          console.log(`=============================================================================================================`);
          console.log(`Page ID | Title                                        | RAW P0 | SETTLED P0 | Anim Overflow (P1) | Status`);
          console.log(`-------------------------------------------------------------------------------------------------------------`);

          const browser = await chromium.launch({ headless: true });
          for (let i = 0; i < pages.length; i++) {
            const p = pages[i];
            const pageUrl = p.url;

            // 1. Raw check (375px)
            const rCtx = await browser.newContext({ viewport: { width: 375, height: 812 } });
            const rPage = await rCtx.newPage();
            await rPage.goto(pageUrl, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
            await rPage.waitForTimeout(300);

            const rawData: any = await rPage.evaluate(`
              (function() {
                var w = window.innerWidth;
                var all = Array.from(document.querySelectorAll('*'));
                var p0 = 0;
                var animOverflow = 0;
                var seenIds = new Set();
                for (var j = 0; j < all.length; j++) {
                  var el = all[j];
                  if (el === document.documentElement || el === document.body) continue;
                  var r = el.getBoundingClientRect();
                  if (r.right > w + 0.5 && r.width > 0 && !el.closest('.offcanvas:not(.show), [aria-hidden="true"]')) {
                    var cs = window.getComputedStyle(el);
                    var hasAnim = (cs.transform && cs.transform !== 'none') || Boolean(el.closest('[class*="vispan-reveal"], [class*="reveal"]'));
                    var id = el.getAttribute('data-id') || el.tagName;
                    if (!seenIds.has(id)) {
                      seenIds.add(id);
                      if (hasAnim) animOverflow++;
                      else p0++;
                    }
                  }
                }
                return { p0: p0, animOverflow: animOverflow, totalOverflow: seenIds.size };
              })()
            `);
            await rCtx.close();

            // 2. Settled check (375px)
            const sCtx = await browser.newContext({ viewport: { width: 375, height: 812 } });
            const sPage = await sCtx.newPage();
            await sPage.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await sPage.addStyleTag({
              content: `
                *, *::before, *::after { animation: none !important; transition: none !important; }
                .vispan-reveal-right, .vispan-reveal-left, .vispan-reveal-up, [class*="vispan-reveal"] { transform: none !important; opacity: 1 !important; }
              `
            });
            await sPage.waitForTimeout(300);

            const settledData: any = await sPage.evaluate(`
              (function() {
                var w = window.innerWidth;
                var all = Array.from(document.querySelectorAll('*'));
                var p0 = 0;
                var seenIds = new Set();
                for (var j = 0; j < all.length; j++) {
                  var el = all[j];
                  if (el === document.documentElement || el === document.body) continue;
                  var r = el.getBoundingClientRect();
                  if (r.right > w + 0.5 && r.width > 0 && !el.closest('.offcanvas:not(.show), [aria-hidden="true"]')) {
                    var id = el.getAttribute('data-id') || el.tagName;
                    if (!seenIds.has(id)) {
                      seenIds.add(id);
                      p0++;
                    }
                  }
                }
                return { p0: p0 };
              })()
            `);
            await sCtx.close();

            const pIdStr = `#${p.id}`.padEnd(7);
            const titleStr = (p.title.length > 44 ? p.title.slice(0, 41) + '...' : p.title).padEnd(44);
            const rawP0Str = String(rawData.totalOverflow).padEnd(6);
            const settledP0Str = String(settledData.p0).padEnd(10);
            const animCountStr = String(rawData.animOverflow).padEnd(18);
            const statusStr = settledData.p0 === 0 ? '✅ ANIMATION-ONLY OVERFLOW' : `⚠️ REAL P0: ${settledData.p0}`;

            console.log(`${pIdStr} | ${titleStr} | ${rawP0Str} | ${settledP0Str} | ${animCountStr} | ${statusStr}`);
          }
          await browser.close();

          console.log(`=============================================================================================================\n`);
          return;
        }

        let totalSiteIssues = 0;
        for (let i = 0; i < pages.length; i++) {
          const p = pages[i];
          console.log(`\n[${i + 1}/${pages.length}] Auditing #${p.id}: "${p.title}" (${p.post_type}${p.template_type ? ' / ' + p.template_type : ''})...`);
          const outDir = path.join(config.outputDir, `page_${p.id}`);
          const report = await auditor.auditPage({
            pageId: p.id,
            url: p.url,
            outputDir: outDir,
          });
          totalSiteIssues += report.totalIssues;
          console.log(`  -> Issues: ${report.totalIssues} (Mobile: ${report.viewports.mobile.issues.length}, Tablet: ${report.viewports.tablet.issues.length}, Desktop: ${report.viewports.desktop.issues.length})`);
        }

        console.log(`\n======================================================`);
        console.log(`🏁 AUDIT ALL COMPLETED: ${pages.length} pages/templates audited, ${totalSiteIssues} total issues found.`);
        console.log(`======================================================\n`);
        return;
      } catch (err: any) {
        console.error(`❌ Audit all failed: ${err.message}`);
        process.exit(1);
      }
    }

    let targetUrl = pageArg;
    let pageId = pageArg;

    const isUrl = /^https?:\/\//i.test(pageArg) || /^file:\/\//i.test(pageArg);

    console.log(`\n🔍 [ERA AUDIT] Initializing responsive layout audit...`);

    if (!isUrl && !isNaN(Number(pageArg))) {
      console.log(`📡 Fetching page metadata from WordPress bridge (${config.wpBaseUrl})...`);
      try {
        const wpPage = await client.getPage(pageArg);
        targetUrl = wpPage.url;
        pageId = String(wpPage.id);
        console.log(`📄 Page found: "${wpPage.title}" (${wpPage.post_type || 'page'}) -> ${targetUrl}`);
      } catch (err: any) {
        console.error(`❌ Failed to fetch page ${pageArg} from WordPress: ${err.message}`);
        process.exit(1);
      }
    }

    try {
      const targetVps = options.extended ? EXTENDED_VIEWPORTS : undefined;
      const vpCount = targetVps ? targetVps.length : 3;
      console.log(`🌐 Auditing target: ${targetUrl} across ${vpCount} viewports${options.extended ? ' (Extended Devices Mode: Mobile, iPad Mini, Desktop, iPad Pro 13, Surface Pro 10)' : ' (375px, 768px, 1280px)'}...`);
      const report = await auditor.auditPage({
        pageId,
        url: targetUrl,
        outputDir: options.output,
        viewports: targetVps,
      });

      const outDir = options.output || path.join(config.outputDir, String(pageId));
      const htmlReportPath = ReportGenerator.generateHtmlReport(report, outDir);

      console.log(`\n======================================================`);
      console.log(`📊 AUDIT COMPLETED for Page: ${pageId}`);
      console.log(`======================================================`);
      console.log(`• Summary Block:`);
      console.log(JSON.stringify(report.summary, null, 2));
      console.log(`\n• Viewport Breakdown:`);
      for (const [vpKey, vpData] of Object.entries(report.viewports)) {
        if (!vpData) continue;
        const ovTag = vpData.hasHorizontalOverflow ? '(⚠️ Horizontal Overflow)' : '(✅ 0 Overflow)';
        const scrollTag = vpData.canScrollToBottom !== false ? '(✅ Full Scroll Reachable)' : '(⚠️ Scroll Trapped)';
        console.log(`  - ${vpKey.padEnd(12)} (${vpData.width}x${vpData.height}): ${vpData.issues.length} issues ${ovTag} ${scrollTag}`);
      }
      console.log(`\n• Affected Element Groups: ${Object.keys(report.issuesByElementId).length}`);

      for (const [elKey, group] of Object.entries(report.issuesByElementId)) {
        const issuesList: Issue[] = Array.isArray(group) ? group : (group as ElementIssuesGroup).issues || [];
        const scope = (group as ElementIssuesGroup).scope || 'elementor';
        console.log(`  [${elKey}] (Scope: ${scope}) -> ${issuesList.length} issue(s)`);
        for (const iss of issuesList) {
          const patchTag = iss.patchable ? '[PATCHABLE]' : `[UNPATCHABLE: ${iss.unpatchableReason || 'theme'}]`;
          const confirmTag = iss.confirmedByRemoval ? '[CONFIRMED BY REMOVAL]' : '';
          console.log(`    - [${iss.severity}][${iss.viewport}] ${iss.type} ${patchTag} ${confirmTag}: ${iss.message}`);
        }
      }

      console.log(`\n📁 Artifacts saved:`);
      console.log(`  - JSON Report : ${path.join(outDir, 'report.json')}`);
      console.log(`  - HTML Report : ${htmlReportPath}`);
      console.log(`  - Screenshots : ${outDir}/[mobile|tablet|desktop].png\n`);
    } catch (err: any) {
      console.error(`\n❌ Audit failed: ${err.message}\n`);
      process.exit(1);
    }
  });

// Command: era propose --page <id|fixture> [--json] [--offline] [--include-typography]
program
  .command('propose')
  .description('Audit layout issues and propose responsive setting patches without writing (Read-Only)')
  .requiredOption('-p, --page <page>', 'Page ID or Fixture Path to analyze')
  .option('--json', 'Output proposal in machine-readable JSON format')
  .option('--offline', 'Use local deterministic heuristics instead of LLM API')
  .option('--include-typography', 'Include P2 font size fixes in patches and CSS proposals')
  .option('-o, --output <dir>', 'Output directory for reports and screenshots')
  .action(async (options) => {
    const pageArg = options.page;
    const config = loadConfig();
    if (options.offline) {
      config.offline = true;
    }
    if (options.includeTypography) {
      config.includeTypography = true;
    }
    const auditor = new PageAuditor();
    const analyst = new LayoutAnalyst(config);

    let targetUrl = pageArg;
    let pageId = pageArg;
    let elementorData: ElementorElement[] = [];

    const isUrl = /^https?:\/\//i.test(pageArg) || /^file:\/\//i.test(pageArg);

    if (!options.json) {
      console.log(`\n🧠 [ERA PROPOSE] Analyzing responsive layout & proposing patches...`);
    }

    if (!isUrl && !isNaN(Number(pageArg))) {
      if (!options.json) {
        console.log(`📡 Fetching page ${pageArg} from WordPress Bridge...`);
      }
      try {
        const client = new EraBridgeClient(config);
        const wpPage = await client.getPage(pageArg);
        targetUrl = wpPage.url;
        pageId = String(wpPage.id);
        elementorData = wpPage._elementor_data || [];
        if (!options.json) {
          console.log(`📄 Page found: "${wpPage.title}" (${elementorData.length} top-level elements)`);
        }
      } catch (err: any) {
        console.error(`❌ Failed to fetch page ${pageArg} from WordPress: ${err.message}`);
        process.exit(1);
      }
    } else {
      let localJsonPath = '';
      if (pageArg.includes('fixtures')) {
        const fixtureDir = path.dirname(pageArg.replace('file://', ''));
        localJsonPath = path.join(fixtureDir, 'data.json');
      }
      if (localJsonPath && fs.existsSync(localJsonPath)) {
        elementorData = JSON.parse(fs.readFileSync(localJsonPath, 'utf-8'));
        if (!options.json) {
          console.log(`📂 Loaded fixture Elementor data from ${localJsonPath}`);
        }
      }
    }

    try {
      const outDir = options.output || path.join(config.outputDir, String(pageId));

      const report = await auditor.auditPage({
        pageId,
        url: targetUrl,
        outputDir: outDir,
      });

      if (!options.json) {
        console.log(`• Issues detected: ${report.totalIssues}`);
      }

      if (report.totalIssues === 0) {
        if (options.json) {
          console.log(JSON.stringify({
            pageId,
            status: 'clean',
            totalIssues: 0,
            patches: [],
            cssProposals: [],
            unresolved: [],
            writeRequestsCount: 0,
          }, null, 2));
        } else {
          console.log(`\n✅ Page already passes all responsive checks. No patches needed!\n`);
        }
        return;
      }

      if (!options.json) {
        console.log(`\n🤖 Running Layout Analyst (${config.openaiApiKey && !config.offline ? config.openaiModel : 'Heuristic Mode'})...`);
      }
      const analysis = await analyst.analyze({
        elementorData,
        auditReport: report,
        mobileScreenshotPath: path.join(outDir, 'mobile.png'),
        tabletScreenshotPath: path.join(outDir, 'tablet.png'),
      });

      if (!options.json) {
        console.log(`🛡️  Validating proposed patches against Key Reference & Hard Rules...`);
      }
      const validation = validatePatches(analysis.patches, elementorData, config.allowHiding);
      const outputCssProposals = [...(analysis.cssProposals || [])];

      // Simulate each CSS proposal if any exist
      const simulatedCssProposals: Array<{ cssProposal: any; verdict: string; details: string }> = [];
      if (outputCssProposals.length > 0) {
        if (!options.json) {
          console.log(`🧪 Simulating ${outputCssProposals.length} CSS proposal(s)...`);
        }
        for (const prop of outputCssProposals) {
          try {
            const probeBrowser = await chromium.launch({ headless: true });
            const probePage = await probeBrowser.newPage({ viewport: { width: 375, height: 812 } });
            await probePage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await probePage.addStyleTag({ content: prop.css });
            await probePage.waitForTimeout(200);
            const simSw = Number(await probePage.evaluate(`document.documentElement.scrollWidth`));
            await probeBrowser.close();

            if (simSw <= 375) {
              simulatedCssProposals.push({
                cssProposal: prop,
                verdict: 'VALIDATED',
                details: `Mobile scrollWidth reduced to ${simSw}px (<= 375px)`,
              });
            } else {
              simulatedCssProposals.push({
                cssProposal: prop,
                verdict: 'PARTIAL',
                details: `Mobile scrollWidth is ${simSw}px (baseline: ${report.viewports.mobile.scrollWidth}px)`,
              });
            }
          } catch (e: any) {
            simulatedCssProposals.push({
              cssProposal: prop,
              verdict: 'UNKNOWN',
              details: `Simulation check error: ${e.message}`,
            });
          }
        }
      }

      const outputData = {
        pageId,
        url: targetUrl,
        auditSummary: report.summary,
        acceptedPatches: validation.validatedPatches.map((p) => {
          const rawIssues = (report.issuesByElementId[p.element_id] ? 
            (Array.isArray(report.issuesByElementId[p.element_id]) 
              ? report.issuesByElementId[p.element_id] 
              : (report.issuesByElementId[p.element_id] as any).issues) 
            : []);

          // Suffix alignment (Rule 2b): Filter targeted issues based on keys present in settings
          const hasMobileKeys = Object.keys(p.settings).some((k) => k.endsWith('_mobile') || k.endsWith('_mobile_extra'));
          const hasTabletKeys = Object.keys(p.settings).some((k) => k.endsWith('_tablet') || k.endsWith('_tablet_extra'));
          const settingKeys = Object.keys(p.settings || {});
          const isWidthOrPaddingPatch = settingKeys.some((k) =>
            k.includes('padding') || k.includes('margin') || k.includes('width') || k.includes('inline_size')
          );
          const hasTypographyKeys = settingKeys.some((k) => k.includes('font_size') || k.includes('typography'));

          const targetedIssues = rawIssues
            .filter((iss: any) => {
              if (iss.viewport === 'mobile' && !hasMobileKeys) return false;
              if (iss.viewport === 'tablet' && !hasTabletKeys) return false;
              // Rule 4b: "Targeted Issues" may only list overflow issues for width/padding patches. Never small_font_size or small_tap_target.
              if (isWidthOrPaddingPatch && (iss.type === 'small_font_size' || iss.type === 'small_tap_target')) {
                return false;
              }
              if (!hasTypographyKeys && iss.type === 'small_font_size') {
                return false;
              }
              return true;
            })
            .map((iss: any) => ({
              type: iss.type,
              viewport: iss.viewport,
              severity: iss.severity,
            }));

          return {
            element_id: p.element_id,
            elType: p.elType || 'widget',
            settings: p.settings,
            reason: p.reason,
            source: p.source || (analysis.stats.isFallback ? 'fallback' : 'llm'),
            targetedIssues,
          };
        }),
        rejectedPatches: validation.rejectedPatches,
        cssProposals: outputCssProposals,
        simulatedCssProposals,
        unresolved: analysis.unresolved || [],
        stats: {
          ...analysis.stats,
          writeRequestsCount: 0,
        },
      };

      if (options.json) {
        console.log(JSON.stringify(outputData, null, 2));
        return;
      }

      console.log(`\n======================================================`);
      console.log(`📋 PROPOSAL SUMMARY for Page: ${pageId}`);
      console.log(`======================================================`);
      console.log(`• Accepted Patches : ${outputData.acceptedPatches.length}`);
      console.log(`• Rejected Patches : ${outputData.rejectedPatches.length}`);
      console.log(`• CSS Proposals    : ${outputData.cssProposals.length}`);
      console.log(`• Unresolved Items : ${outputData.unresolved.length}`);
      console.log(`• LLM Calls        : ${outputData.stats.llmCalls} (${outputData.stats.isFallback ? 'Fallback Heuristic' : 'OpenAI API'})`);
      console.log(`• Token Usage      : ${outputData.stats.promptTokens} input / ${outputData.stats.completionTokens} output`);
      console.log(`• Write Requests   : 0 (Strictly Read-Only)`);

      if (outputData.acceptedPatches.length > 0) {
        console.log(`\n--- ACCEPTED PATCHES ---`);
        for (let i = 0; i < outputData.acceptedPatches.length; i++) {
          const patch = outputData.acceptedPatches[i];
          console.log(`\n[Patch #${i + 1}] Target Element ID: "${patch.element_id}" (elType: ${patch.elType}) (Source: ${patch.source})`);
          console.log(`  Reason: ${patch.reason || 'Responsive optimization'}`);
          console.log(`  Targeted Issues: ${patch.targetedIssues.map((t: any) => `[${t.severity}][${t.viewport}] ${t.type}`).join(', ') || 'General responsive fix'}`);
          console.log(`  Settings:`);
          console.log(`  ` + JSON.stringify(patch.settings, null, 4).replace(/\n/g, '\n  '));
        }
      }

      if (outputData.rejectedPatches.length > 0) {
        console.log(`\n--- REJECTED PATCHES ---`);
        for (const rej of outputData.rejectedPatches) {
          console.log(`\n[Rejected] Element ID: "${rej.patch.element_id}" (elType: ${rej.patch.elType || 'unknown'})`);
          for (const err of rej.reasons) {
            console.log(`  ❌ [${err.code}] ${err.message}`);
          }
        }
      }

      if (outputData.cssProposals.length > 0) {
        console.log(`\n--- CSS PROPOSALS (for inline styles/external elements) ---`);
        for (let idx = 0; idx < outputData.cssProposals.length; idx++) {
          const cssProp = outputData.cssProposals[idx];
          const sim = simulatedCssProposals[idx];
          const verdictTag = sim ? `[Simulation: ${sim.verdict === 'VALIDATED' ? '✅ VALIDATED' : sim.verdict === 'PARTIAL' ? '⚠️ PARTIAL' : '❌ ' + sim.verdict} - ${sim.details}]` : '';
          console.log(`\n[CSS Proposal #${idx + 1}] Element: "${cssProp.element_id}" (Source: ${cssProp.source || 'llm'}) ${verdictTag}`);
          console.log(`  Reason: ${cssProp.reason}`);
          console.log(`  Rule:\n  ${cssProp.css}`);
        }
      }

      if (outputData.unresolved.length > 0) {
        console.log(`\n--- UNRESOLVED ISSUES ---`);
        for (const unres of outputData.unresolved) {
          console.log(`  - [Element ${unres.element_id}]: ${unres.reason}`);
        }
      }

      console.log(`\nℹ️  NOTE: This command is READ-ONLY. No changes were written to the site.\n`);
    } catch (err: any) {
      console.error(`\n❌ Propose failed: ${err.message}\n`);
      process.exit(1);
    }
  });

// Command: era diagnose --page <id|url> [--inner]
program
  .command('diagnose')
  .description('Diagnose root cause of responsive layout overflow across mobile (375px) and tablet (768px) viewports (Read-Only)')
  .requiredOption('-p, --page <page>', 'Page ID or Target URL to diagnose')
  .option('-i, --inner', 'Diagnose inner card/widget descendants and identify inner wideners at 375px')
  .action(async (options) => {
    const pageArg = options.page;
    const config = loadConfig();
    let targetUrl = pageArg;
    let pageId = pageArg;

    const isUrl = /^https?:\/\//i.test(pageArg) || /^file:\/\//i.test(pageArg);
    if (!isUrl && !isNaN(Number(pageArg))) {
      const client = new EraBridgeClient(config);
      const wpPage = await client.getPage(pageArg);
      targetUrl = wpPage.url;
      pageId = String(wpPage.id);
    }

    if (options.inner) {
      console.log(`\n🔍 [ERA DIAGNOSE --INNER] Diagnosing inner card overflow & wideners at 375px for Page #${pageId} (${targetUrl})...\n`);
      const innerResults = await runInnerDiagnosis(targetUrl);

      console.log(`Found ${innerResults.length} card(s) with potential internal or viewport overflow at 375px:\n`);

      for (let cIdx = 0; cIdx < innerResults.length; cIdx++) {
        const card = innerResults[cIdx];
        const dataIdStr = card.cardDataId ? ` [data-id="${card.cardDataId}"]` : '';
        console.log(`===================================================================================================`);
        console.log(`📦 [Card #${cIdx + 1}] <${card.cardTagClass}>${dataIdStr}`);
        console.log(`===================================================================================================`);
        console.log(`• Card Dimensions: width=${card.cardWidth}px, clientWidth=${card.cardClientWidth}px, scrollWidth=${card.cardScrollWidth}px`);
        console.log(`• Card Computed Styles: min-width=${card.cardComputedMinWidth}, width=${card.cardComputedWidth}`);
        
        if (card.nearestFlexGridAncestor) {
          const anc = card.nearestFlexGridAncestor;
          console.log(`• Nearest Flex/Grid Ancestor: <${anc.tagClass}>`);
          console.log(`  display: ${anc.display} | flex-direction: ${anc.flexDirection} | flex-wrap: ${anc.flexWrap} | grid-template-columns: ${anc.gridTemplateColumns}`);
        } else {
          console.log(`• Nearest Flex/Grid Ancestor: (None)`);
        }

        console.log(`\n• Descendants with scrollWidth > card.clientWidth + 1 (${card.descendants.length}):`);
        if (card.descendants.length === 0) {
          console.log(`  (None - card itself is overflowing or wide due to ancestor layout)`);
        } else {
          for (let dIdx = 0; dIdx < card.descendants.length; dIdx++) {
            const d = card.descendants[dIdx];
            console.log(`  [${dIdx + 1}] <${d.tagClass}>`);
            console.log(`      scrollWidth: ${d.scrollWidth}px, clientWidth: ${d.clientWidth}px`);
            console.log(`      styles: white-space=${d.whiteSpace}, display=${d.display}, flex-shrink=${d.flexShrink}, flex-basis=${d.flexBasis}, min-width=${d.minWidth}, width=${d.width}, overflow-wrap=${d.overflowWrap}`);
            console.log(`      outerHTML (first 200 chars): ${d.outerHtmlSnippet}`);
          }
        }

        console.log(`\n• Inner Widener (single descendant that forces card wide):`);
        if (card.innerWidener) {
          console.log(`  👉 <${card.innerWidener.tagClass}> (scrollWidth=${card.innerWidener.scrollWidth}px > card.clientWidth=${card.cardClientWidth}px)`);
        } else {
          console.log(`  👉 (None detected among descendants; card's own styles/ancestor flex/grid is the widener)`);
        }
        console.log(`\n`);
      }
      return;
    }

    console.log(`\n🔍 [ERA DIAGNOSE] Diagnosing root cause for Page #${pageId} (${targetUrl})...\n`);
    const diagResults = await runDiagnosis(targetUrl);

    for (const res of diagResults) {
      console.log(`======================================================`);
      console.log(`📱 VIEWPORT: ${res.viewport.toUpperCase()} (${res.width}px) — scrollWidth: ${res.scrollWidth}px`);
      console.log(`======================================================`);
      console.log(`Found ${res.overflowGroups.length} overflow group(s):\n`);

      for (let gIdx = 0; gIdx < res.overflowGroups.length; gIdx++) {
        const group = res.overflowGroups[gIdx];
        console.log(`--- [Group #${gIdx + 1}] Right Edge ~${group.rightEdgeBucket}px (Widest: ${group.widestRight}px) ---`);
        console.log(`• OuterHTML (first 300 chars):`);
        console.log(`  ${group.outerHtmlSnippet}`);

        console.log(`\n• Ancestor Chain (from node up to body):`);
        for (let aIdx = 0; aIdx < group.ancestorChain.length; aIdx++) {
          const a = group.ancestorChain[aIdx];
          const idStr = a.dataId ? ` [data-id="${a.dataId}"]` : '';
          console.log(`  [${aIdx}] <${a.tagClass}>${idStr}`);
          console.log(`      rect: left=${a.left}px, width=${a.width}px, right=${a.right}px`);
          console.log(`      margin: left=${a.marginLeft}, right=${a.marginRight} | padding: left=${a.paddingLeft}, right=${a.paddingRight}`);
          console.log(`      styles: box-sizing=${a.boxSizing}, position=${a.position}, display=${a.display}, min-width=${a.minWidth}, max-width=${a.maxWidth}`);
          console.log(`      inline: ${a.inlineWidthTransform}`);
        }

        console.log(`\n• The "Widener":`);
        if (group.widener) {
          const idStr = group.widener.dataId ? ` [data-id="${group.widener.dataId}"]` : '';
          console.log(`  👉 Widener: <${group.widener.tagClass}>${idStr}`);
          console.log(`     (Child right edge ${group.widener.childRight}px exceeds parent content-box right ${group.widener.parentContentBoxRight}px by ${group.widener.diff}px)`);
        } else {
          console.log(`  👉 Widener: (None detected; element right edge matches parent content-box)`);
        }
        console.log(`\n`);
      }
    }
  });

// Command: era simulate --page <id|url> --css <files...> [--json]
program
  .command('simulate')
  .description('Simulate responsive CSS candidate injection on logged-out Playwright without persisting changes (Read-Only)')
  .requiredOption('-p, --page <page>', 'Page ID, Target URL, or Fixture Path to simulate')
  .option('-c, --css <files...>', 'Path to CSS candidate file(s) or CSS string to inject')
  .option('--json', 'Output simulation results in JSON format')
  .option('-o, --output <dir>', 'Output directory for reports and screenshots')
  .action(async (options) => {
    const pageArg = options.page;
    const cssArgs: string[] = options.css ? (Array.isArray(options.css) ? options.css : [options.css]) : [];
    const config = loadConfig();
    const auditor = new PageAuditor();

    let targetUrl = pageArg;
    let pageId = pageArg;

    const isUrl = /^https?:\/\//i.test(pageArg) || /^file:\/\//i.test(pageArg);

    if (!options.json) {
      console.log(`\n🧪 [ERA SIMULATE] Starting non-destructive responsive layout simulation...`);
    }

    if (!isUrl && !isNaN(Number(pageArg))) {
      if (!options.json) {
        console.log(`📡 Fetching page ${pageArg} metadata from WordPress Bridge...`);
      }
      try {
        const client = new EraBridgeClient(config);
        const wpPage = await client.getPage(pageArg);
        targetUrl = wpPage.url;
        pageId = String(wpPage.id);
        if (!options.json) {
          console.log(`📄 Target page: "${wpPage.title}" -> ${targetUrl}`);
        }
      } catch (err: any) {
        console.error(`❌ Failed to fetch page from WordPress: ${err.message}`);
        process.exit(1);
      }
    }

    // Read and merge CSS contents from all passed files
    const cssContents: string[] = [];
    const cssLabels: string[] = [];
    for (const cssArg of cssArgs) {
      if (fs.existsSync(cssArg)) {
        cssContents.push(fs.readFileSync(cssArg, 'utf-8'));
        cssLabels.push(cssArg);
        if (!options.json) {
          console.log(`🎨 Loaded CSS candidate from: ${cssArg}`);
        }
      } else if (fs.existsSync(path.resolve(process.cwd(), cssArg))) {
        const resolved = path.resolve(process.cwd(), cssArg);
        cssContents.push(fs.readFileSync(resolved, 'utf-8'));
        cssLabels.push(resolved);
        if (!options.json) {
          console.log(`🎨 Loaded CSS candidate from: ${resolved}`);
        }
      } else {
        cssContents.push(cssArg);
        cssLabels.push('(inline string)');
      }
    }

    const combinedCss = `html { --era-probe: 1; }\n\n` + cssContents.join('\n\n');

    try {
      // Step 3: Verify CSS injection with --era-probe and check matching elements
      const probeBrowser = await chromium.launch({ headless: true });
      const probePage = await probeBrowser.newPage({ viewport: { width: 375, height: 812 } });
      await probePage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await probePage.addStyleTag({ content: combinedCss });
      await probePage.waitForTimeout(200);

      const probeVal = await probePage.evaluate(() => {
        return window.getComputedStyle(document.documentElement).getPropertyValue('--era-probe').trim();
      });

      if (probeVal === '1') {
        if (!options.json) {
          console.log(`💉 CSS injection verified (html{--era-probe:1} active)`);
        }
      } else {
        await probeBrowser.close();
        throw new Error(`CSS injection verification failed: --era-probe returned "${probeVal}", expected "1".`);
      }

      // Extract and match CSS rule selectors
      const rawRules = cssContents.join('\n\n');
      const innerBlocks = rawRules.replace(/@media[^{]+\{/gi, '');
      const selectorMatches = innerBlocks.match(/([^{}]+)\{/g) || [];
      const distinctSelectors: string[] = [];
      for (const m of selectorMatches) {
        const sel = m.replace(/\{/, '').trim();
        if (sel && !sel.startsWith('@') && !distinctSelectors.includes(sel)) {
          distinctSelectors.push(sel);
        }
      }

      if (!options.json) {
        for (const sel of distinctSelectors) {
          const matchCount = await probePage.evaluate((s) => {
            try {
              return document.querySelectorAll(s).length;
            } catch {
              return 0;
            }
          }, sel);
          console.log(`• CSS Rule Selector: "${sel}" matches ${matchCount} element(s) in DOM`);
        }
      }

      await probeBrowser.close();

      // Check tablet animations
      const animCheck = await checkTabletAnimations(targetUrl, combinedCss);

      const baseOutDir = path.join(config.outputDir, `simulate_${pageId}_base`);
      const simOutDir = path.join(config.outputDir, `simulate_${pageId}_injected`);

      if (!options.json) {
        console.log(`🌐 1/2: Capturing baseline audit across viewports...`);
      }
      const baselineReport = await auditor.auditPage({
        pageId,
        url: targetUrl,
        outputDir: baseOutDir,
      });

      if (!options.json) {
        console.log(`🌐 2/2: Injecting candidate CSS & capturing simulated audit...`);
      }
      const simulatedReport = await auditor.auditPage({
        pageId,
        url: targetUrl,
        outputDir: simOutDir,
        customCss: combinedCss,
      });

      // Desktop regression diff
      const baselineDesktopPng = path.join(baseOutDir, 'desktop.png');
      const simulatedDesktopPng = path.join(simOutDir, 'desktop.png');
      const diffOutputPng = path.join(simOutDir, 'desktop_diff.png');

      const regressionResult = checkDesktopRegression(
        baselineDesktopPng,
        simulatedDesktopPng,
        config.desktopDiffThreshold,
        diffOutputPng
      );

      // Collect viewport comparison stats
      const vps = ['mobile', 'tablet', 'desktop'] as const;
      const comparison: Record<string, any> = {};

      for (const vp of vps) {
        const baseVp = baselineReport.viewports[vp];
        const simVp = simulatedReport.viewports[vp];

        const baseP0 = baseVp.issues.filter((i) => i.severity === 'P0').length;
        const baseP1 = baseVp.issues.filter((i) => i.severity === 'P1').length;
        const baseP2 = baseVp.issues.filter((i) => i.severity === 'P2').length;

        const simP0 = simVp.issues.filter((i) => i.severity === 'P0').length;
        const simP1 = simVp.issues.filter((i) => i.severity === 'P1').length;
        const simP2 = simVp.issues.filter((i) => i.severity === 'P2').length;

        const remainingP0Issues = simVp.issues.filter((i) => i.severity === 'P0').map((iss) => ({
          elementId: iss.elementId,
          selector: iss.selector,
          right: iss.details?.right,
          scrollWidth: iss.details?.scrollWidth || simVp.scrollWidth,
        }));

        comparison[vp] = {
          baseline: { P0: baseP0, P1: baseP1, P2: baseP2, scrollWidth: baseVp.scrollWidth, innerWidth: baseVp.width },
          simulated: { P0: simP0, P1: simP1, P2: simP2, scrollWidth: simVp.scrollWidth, innerWidth: simVp.width },
          p0Drop: baseP0 - simP0,
          remainingP0: remainingP0Issues,
        };
      }

      const allBaseIssues = [
        ...baselineReport.viewports.mobile.issues,
        ...baselineReport.viewports.tablet.issues,
        ...baselineReport.viewports.desktop.issues,
      ];
      const allSimIssues = [
        ...simulatedReport.viewports.mobile.issues,
        ...simulatedReport.viewports.tablet.issues,
        ...simulatedReport.viewports.desktop.issues,
      ];

      const simVerdict = evaluateSimulationVerdict({
        baseMobileP0: comparison.mobile.baseline.P0,
        simMobileP0: comparison.mobile.simulated.P0,
        baseTabletP0: comparison.tablet.baseline.P0,
        simTabletP0: comparison.tablet.simulated.P0,
        baseDesktopP0: comparison.desktop.baseline.P0,
        simDesktopP0: comparison.desktop.simulated.P0,
        baseMobileScrollWidth: comparison.mobile.baseline.scrollWidth,
        simMobileScrollWidth: comparison.mobile.simulated.scrollWidth,
        baseTabletScrollWidth: comparison.tablet.baseline.scrollWidth,
        simTabletScrollWidth: comparison.tablet.simulated.scrollWidth,
        baseIssues: allBaseIssues.map((i) => ({ elementId: i.elementId ?? undefined, type: i.type })),
        simIssues: allSimIssues.map((i) => ({ elementId: i.elementId ?? undefined, type: i.type })),
        desktopDiffPassed: regressionResult.passed,
        desktopMismatchRatio: regressionResult.mismatchRatio,
        desktopThreshold: config.desktopDiffThreshold,
      });

      const resultPayload = {
        pageId,
        url: targetUrl,
        cssSources: cssLabels,
        verdict: simVerdict.verdict,
        validated: simVerdict.passed,
        validationDetails: {
          verdict: simVerdict.verdict,
          reasons: simVerdict.reasons,
          p0DropMobilePercent: simVerdict.p0DropMobilePercent.toFixed(1) + '%',
          p0DropTabletPercent: simVerdict.p0DropTabletPercent.toFixed(1) + '%',
          scrollWidthMobilePassed: simVerdict.scrollWidthMobilePassed,
          scrollWidthTabletPassed: simVerdict.scrollWidthTabletPassed,
          noNewIssues: simVerdict.noNewIssues,
          desktopPassed: simVerdict.desktopPassed,
          desktopDiffPercent: (regressionResult.mismatchRatio * 100).toFixed(4) + '%',
          desktopThresholdPercent: (config.desktopDiffThreshold * 100).toFixed(4) + '%',
          tabletAnimations: {
            withoutAnimationFix: animCheck.withoutAnimationFix,
            withAnimationFix: animCheck.withAnimationFix,
          },
        },
        viewports: comparison,
        writeRequestsCount: 0,
      };

      if (options.json) {
        console.log(JSON.stringify(resultPayload, null, 2));
        return;
      }

      console.log(`\n======================================================================================================================`);
      console.log(`🧪 SIMULATION BEFORE / AFTER TABLE: Page #${pageId} with CSS: ${cssLabels.join(', ')}`);
      console.log(`======================================================================================================================`);
      console.log(`Viewport      | Baseline P0/P1/P2 | Simulated P0/P1/P2 | Base scrollWidth | Sim scrollWidth | Status`);
      console.log(`----------------------------------------------------------------------------------------------------------------------`);
      for (const vp of vps) {
        const c = comparison[vp];
        const vpLabel = vp === 'mobile' ? 'Mobile (375) ' : vp === 'tablet' ? 'Tablet (768) ' : 'Desktop (1280)';
        const baseCounts = `${c.baseline.P0} / ${c.baseline.P1} / ${c.baseline.P2}`.padEnd(17);
        const simCounts = `${c.simulated.P0} / ${c.simulated.P1} / ${c.simulated.P2}`.padEnd(18);
        const baseSw = `${c.baseline.scrollWidth}px`.padEnd(16);
        const simSw = `${c.simulated.scrollWidth}px`.padEnd(15);
        let status = 'CLEAN';
        if (vp === 'desktop') {
          status = regressionResult.passed ? `Diff: ${(regressionResult.mismatchRatio * 100).toFixed(4)}% (PASSED)` : `Diff: ${(regressionResult.mismatchRatio * 100).toFixed(4)}% (FAILED)`;
        } else {
          status = c.simulated.P0 === 0 ? 'OVERFLOW FIXED' : `REMAINING P0: ${c.simulated.P0}`;
        }
        console.log(`${vpLabel} | ${baseCounts} | ${simCounts} | ${baseSw} | ${simSw} | ${status}`);
      }
      console.log(`----------------------------------------------------------------------------------------------------------------------`);

      console.log(`\n• Tablet Animation Check:`);
      console.log(`  - Tablet P0 overflowing elements without animation disabling : ${animCheck.withoutAnimationFix}`);
      console.log(`  - Tablet P0 overflowing elements with animation disabling    : ${animCheck.withAnimationFix}`);

      const allRemainingP0: any[] = [];
      for (const vp of vps) {
        if (comparison[vp].remainingP0.length > 0) {
          for (const rem of comparison[vp].remainingP0) {
            allRemainingP0.push({ viewport: vp, ...rem });
          }
        }
      }

      if (allRemainingP0.length > 0) {
        console.log(`\n• Remaining P0 Elements (${allRemainingP0.length}):`);
        for (const rem of allRemainingP0) {
          console.log(`  - [${rem.viewport}] Element ID: "${rem.elementId || 'unknown'}" (right: ${rem.right || rem.scrollWidth}px, selector: ${rem.selector})`);
        }

        // Fetch detailed properties for remaining overflowing nodes (Step 4)
        console.log(`\n• Step 4 Details for Remaining Overflowing Nodes (${allRemainingP0.length}):`);
        const inspectBrowser = await chromium.launch({ headless: true });
        for (let nIdx = 0; nIdx < allRemainingP0.length; nIdx++) {
          const rem = allRemainingP0[nIdx];
          const vpWidth = rem.viewport === 'tablet' ? 768 : 375;
          const vpHeight = rem.viewport === 'tablet' ? 1024 : 812;
          const ctx = await inspectBrowser.newContext({ viewport: { width: vpWidth, height: vpHeight } });
          const p = await ctx.newPage();
          await p.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await p.addStyleTag({
            content: `
              *, *::before, *::after { animation: none !important; transition: none !important; }
              .vispan-reveal-right, .vispan-reveal-left, .vispan-reveal-up, [class*="vispan-reveal"] { transform: none !important; opacity: 1 !important; transition: none !important; animation: none !important; }
            `,
          });
          if (combinedCss) {
            await p.addStyleTag({ content: combinedCss });
          }
          await p.waitForTimeout(200);

          const nodeData: any = await p.evaluate(`
            (function(sel) {
              var el = null;
              try { el = document.querySelector(sel); } catch(e) {}
              if (!el) {
                var allEls = Array.from(document.querySelectorAll('*'));
                for (var k = 0; k < allEls.length; k++) {
                  var item = allEls[k];
                  var classes = item.className && typeof item.className === 'string'
                    ? '.' + item.className.trim().split(/\\s+/).filter(Boolean).join('.')
                    : '';
                  if (item.tagName.toLowerCase() + classes === sel) {
                    el = item;
                    break;
                  }
                }
              }
              if (!el) return null;
              var cs = window.getComputedStyle(el);
              var parentCs = el.parentElement ? window.getComputedStyle(el.parentElement) : null;
              return {
                computedWidth: cs.width,
                minWidth: cs.minWidth,
                flexBasis: cs.flexBasis,
                parentGridTemplateColumns: parentCs ? parentCs.gridTemplateColumns : 'none',
                outerHtmlSnippet: el.outerHTML.slice(0, 200),
              };
            })("${rem.selector.replace(/"/g, '\\"')}")
          `);

          await ctx.close();

          console.log(`\n  [Node #${nIdx + 1}] [${rem.viewport}] <${rem.selector}> (Element ID: ${rem.elementId || 'unmapped'})`);
          console.log(`    - Computed Width  : ${nodeData ? nodeData.computedWidth : 'auto'}`);
          console.log(`    - Min-Width       : ${nodeData ? nodeData.minWidth : '0px'}`);
          console.log(`    - Flex-Basis      : ${nodeData ? nodeData.flexBasis : 'auto'}`);
          console.log(`    - Parent Grid Cols: ${nodeData ? nodeData.parentGridTemplateColumns : 'none'}`);
          console.log(`    - OuterHTML       : ${nodeData ? nodeData.outerHtmlSnippet : rem.selector}`);
        }
        await inspectBrowser.close();
      } else {
        console.log(`\n• Remaining P0 Elements: 0 (All horizontal overflow eliminated!)`);
      }

      console.log(`\n• Desktop Regression Diff : ${(regressionResult.mismatchRatio * 100).toFixed(4)}% (Threshold: ${(config.desktopDiffThreshold * 100).toFixed(4)}%)`);
      const verdictEmoji = simVerdict.verdict === 'VALIDATED' ? '✅' : simVerdict.verdict === 'PARTIAL' ? '⚠️' : '❌';
      console.log(`• Simulation Verdict      : ${verdictEmoji} [${simVerdict.verdict}]`);
      if (simVerdict.reasons.length > 0) {
        for (const r of simVerdict.reasons) {
          console.log(`  - ${r}`);
        }
      }
      console.log(`• Write Requests          : 0 (Strictly Non-Destructive Simulation)\n`);
    } catch (err: any) {
      console.error(`\n❌ Simulation failed: ${err.message}\n`);
      process.exit(1);
    }
  });

// Command: era fix --page <id> [--dry-run] [--confirm]
program
  .command('fix')
  .description('Run iterative audit -> analyze -> patch -> re-audit loop with safety backups')
  .requiredOption('-p, --page <page>', 'Page ID or Fixture Path to fix')
  .option('--dry-run', 'Simulate patches without writing changes')
  .option('--confirm', 'Confirm write execution to live WordPress site')
  .option('-o, --output <dir>', 'Output directory for reports and screenshots')
  .action(async (options) => {
    const pageArg = options.page;
    const config = loadConfig();
    const loopRunner = new LoopRunner(config);

    let targetUrl = pageArg;
    let pageId = pageArg;
    let elementorData: ElementorElement[] = [];
    let isLiveWp = false;

    const isUrl = /^https?:\/\//i.test(pageArg) || /^file:\/\//i.test(pageArg);

    if (!isUrl && !isNaN(Number(pageArg))) {
      isLiveWp = true;
      if (!options.dryRun && !options.confirm) {
        console.error(`\n⚠️  SAFETY GUARD: Modifying a live WordPress page requires explicit confirmation.`);
        console.error(`   Please rerun with the --confirm flag: era fix --page ${pageArg} --confirm`);
        console.error(`   Or run simulation mode: era fix --page ${pageArg} --dry-run\n`);
        process.exit(1);
      }

      console.log(`📡 Fetching page ${pageArg} from WordPress Bridge...`);
      try {
        const client = new EraBridgeClient(config);
        const wpPage = await client.getPage(pageArg);
        targetUrl = wpPage.url;
        pageId = String(wpPage.id);
        elementorData = wpPage._elementor_data || [];
        console.log(`📄 Page found: "${wpPage.title}" -> ${targetUrl}`);
      } catch (err: any) {
        console.error(`❌ Failed to fetch page from WordPress: ${err.message}`);
        process.exit(1);
      }
    } else {
      let localJsonPath = '';
      if (pageArg.includes('fixtures')) {
        const fixtureDir = path.dirname(pageArg.replace('file://', ''));
        localJsonPath = path.join(fixtureDir, 'data.json');
      }
      if (localJsonPath && fs.existsSync(localJsonPath)) {
        elementorData = JSON.parse(fs.readFileSync(localJsonPath, 'utf-8'));
      }
    }

    try {
      const result = await loopRunner.run({
        pageId,
        url: targetUrl,
        elementorData,
        isLiveWp,
        dryRun: options.dryRun,
        outputDir: options.output,
      });

      if (result.status === 'passed') {
        console.log(`✅ Fixed page ${pageId} successfully! All responsive layout checks passing.`);
      } else if (result.status === 'restored') {
        console.log(`♻️  Page ${pageId} was restored due to desktop layout regression.`);
      } else {
        console.log(`⚠️  Page ${pageId} marked as [NEEDS HUMAN]. Reached maximum 3 iterations without full resolution.`);
      }
    } catch (err: any) {
      console.error(`\n❌ Fix loop failed: ${err.message}\n`);
      process.exit(1);
    }
  });

// Command: era restore --page <id> --backup <key>
program
  .command('restore')
  .description('Restore a page from a timestamped backup')
  .requiredOption('-p, --page <id>', 'Page ID')
  .option('-b, --backup <key>', 'Backup key (optional, defaults to latest)')
  .action(async (options) => {
    const config = loadConfig();
    const client = new EraBridgeClient(config);

    console.log(`\n♻️  [ERA RESTORE] Restoring page ${options.page}...`);
    try {
      const res = await client.restorePage(options.page, options.backup);
      console.log(`\n======================================================`);
      console.log(`✅ RESTORE COMPLETED for Page #${res.page_id}`);
      console.log(`======================================================`);
      console.log(`• Restored Backup Key : ${res.restored_key}`);
      console.log(`• Restored Timestamp  : ${res.restored_at}`);
      console.log(`• Elementor Cache     : Cleared\n`);
    } catch (err: any) {
      console.error(`\n❌ Restore failed: ${err.message}\n`);
      process.exit(1);
    }
  });

// Command: era run-all
program
  .command('run-all')
  .description('Iterate and optimize all Elementor pages across site (rate-limited, resumable, library templates first)')
  .option('--dry-run', 'Simulate patches across all pages')
  .option('--delay <ms>', 'Delay between pages in milliseconds (default: 1000)', '1000')
  .action(async (options) => {
    const config = loadConfig();
    const batchRunner = new BatchRunner(config);

    console.log(`\n🚀 [ERA RUN-ALL] Starting batch optimization...`);
    try {
      const summary = await batchRunner.runAll({
        dryRun: options.dryRun,
        delayMs: parseInt(options.delay, 10),
      });

      console.log(`\n======================================================`);
      console.log(`🏁 BATCH OPTIMIZATION FINISHED`);
      console.log(`======================================================`);
      console.log(`• Total Pages Processed : ${summary.totalPages}`);
      console.log(`• Passed (0 issues)     : ${summary.passed}`);
      console.log(`• Needs Human           : ${summary.needsHuman}`);
      console.log(`• Restored Regressions  : ${summary.restored}\n`);
    } catch (err: any) {
      console.error(`\n❌ Batch run failed: ${err.message}\n`);
      process.exit(1);
    }
  });

// Command: era qc
program
  .command('qc')
  .description('Run automatic QC for the responsive CSS fix (Read-only, writes NOTHING to WordPress)')
  .option('--limit <n>', 'Limit number of pages to audit')
  .option('--all', 'Audit all pages (default: true)')
  .option('--css <path>', 'Path to CSS fix file', 'candidates/final-fix.css')
  .option('--output <dir>', 'Output directory for QC reports', 'output/qc')
  .option('--force', 'Force re-auditing of already completed pages')
  .option('--live', 'Run LIVE QC auditing pages exactly as served to visitors (no CSS injection)')
  .option('--forms', 'Run FORM VISIBILITY QC auditing forms, reveal scripts, and visibility')
  .action(async (options) => {
    const config = loadConfig();

    if (options.forms) {
      const outDir = options.output && options.output !== 'output/qc' ? options.output : 'output/qc-forms';
      const formRunner = new FormQcRunner(config, {
        limit: options.limit ? parseInt(options.limit, 10) : undefined,
        all: Boolean(options.all || !options.limit),
        outputDir: outDir,
        force: options.force,
      });

      console.log(`\n📋 [ERA FORM QC] Starting form visibility & responsive quality control...`);
      try {
        const { summary } = await formRunner.run();
        formRunner.printConsoleSummary(summary);
      } catch (err: any) {
        console.error(`\n❌ ERA FORM QC failed: ${err.message}\n`);
        process.exit(1);
      }
      return;
    }

    if (options.live) {
      const outDir = options.output && options.output !== 'output/qc' ? options.output : 'output/qc-live';
      const liveRunner = new LiveQcRunner(config, {
        limit: options.limit ? parseInt(options.limit, 10) : undefined,
        all: Boolean(options.all || !options.limit),
        outputDir: outDir,
        force: options.force,
      });

      console.log(`\n🌐 [ERA LIVE QC] Starting live quality control (testing site exactly as visitor receives it)...`);
      try {
        const { summary } = await liveRunner.run();
        liveRunner.printConsoleSummary(summary);
      } catch (err: any) {
        console.error(`\n❌ ERA LIVE QC failed: ${err.message}\n`);
        process.exit(1);
      }
      return;
    }

    const runner = new QcRunner(config, {
      limit: options.limit ? parseInt(options.limit, 10) : undefined,
      all: Boolean(options.all || !options.limit),
      cssPath: options.css,
      outputDir: options.output,
      force: options.force,
    });

    console.log(`\n🧪 [ERA QC] Starting automatic responsive quality control...`);
    try {
      const { summary } = await runner.run();
      runner.printConsoleSummary(summary);
    } catch (err: any) {
      console.error(`\n❌ ERA QC failed: ${err.message}\n`);
      process.exit(1);
    }
  });

// Command: era serve [-p, --port <port>]
program
  .command('serve')
  .description('Start the local ERA Hybrid Agent server daemon for the floating chatbot')
  .option('-p, --port <port>', 'Port number to listen on', '8000')
  .action(async (options) => {
    const port = parseInt(options.port || '8000', 10);
    const { startServer } = await import('./server.js');
    startServer(port);
  });

// Command: era chat -p <pageId> [-m <message>] [-i <imagePath>] [--json]
program
  .command('chat')
  .description('Targeted section-level responsive fix via text prompt or screenshot')
  .requiredOption('-p, --page <page>', 'Page ID to target')
  .option('-m, --message <message>', 'User request or description of broken section')
  .option('-i, --image <path>', 'Path to screenshot of the broken section')
  .option('--history <jsonOrPath>', 'JSON string or path to history JSON file')
  .option('--context <jsonOrPath>', 'JSON string or path to context JSON file')
  .option('--json', 'Output result strictly as JSON')
  .action(async (options) => {
    const { ChatAgent } = await import('./llm/chat-agent.js');
    let imageBase64: string | undefined;
    if (options.image && fs.existsSync(options.image)) {
      imageBase64 = fs.readFileSync(options.image).toString('base64');
    }
    let history: any[] | undefined;
    if (options.history) {
      try {
        if (fs.existsSync(options.history)) {
          history = JSON.parse(fs.readFileSync(options.history, 'utf8'));
        } else {
          history = JSON.parse(options.history);
        }
      } catch (e) {}
    }
    let pageContext: any | undefined;
    if (options.context) {
      try {
        if (fs.existsSync(options.context)) {
          pageContext = JSON.parse(fs.readFileSync(options.context, 'utf8'));
        } else {
          pageContext = JSON.parse(options.context);
        }
      } catch (e) {}
    }
    const chatAgent = new ChatAgent();
    if (!options.json) {
      console.log(`🔍 Analyzing Page #${options.page} with ERA Page Architect...`);
    }
    const result = await chatAgent.handleConversation({
      pageId: options.page,
      message: options.message,
      history,
      pageContext,
      imageBase64,
    });
    if (options.json) {
      console.log(JSON.stringify({ success: true, ...result }));
      return;
    }
    console.log('\n======================================================');
    console.log(`🎯 RESPONSE: ${result.sectionTitle || 'Page Assessment'} (ID: ${result.matchedElementId || 'page'})`);
    console.log('======================================================');
    if (result.detectedIssues && result.detectedIssues.length) {
      console.log(`• Detected Issues / Actions:`);
      for (const iss of result.detectedIssues) {
        console.log(`  - ⚠️ ${iss}`);
      }
    }
    console.log(`\n• Solution Explanation:\n  ${result.reply || result.explanation}`);
    if (result.scopedCss) {
      console.log(`\n• Scoped CSS Generated: (${result.scopedCss.length} characters)`);
      console.log(result.scopedCss.slice(0, 300) + '...\n');
    }
  });

program.parse(process.argv);
