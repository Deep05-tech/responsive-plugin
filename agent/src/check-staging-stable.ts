import { PageAuditor } from './audit/auditor.js';
import { checkDesktopRegression } from './runner/regression.js';
import path from 'path';

async function run() {
  const auditor = new PageAuditor();
  const url = 'http://seo.local/us/best-digital-marketing-agency-for-dental-clinic-in-los-angles/';

  console.log('Taking Capture 1 on real staging page...');
  await auditor.auditPage({ pageId: 'staging-stable-1', url, outputDir: './output/staging-stable-1' });

  console.log('Taking Capture 2 on real staging page...');
  await auditor.auditPage({ pageId: 'staging-stable-2', url, outputDir: './output/staging-stable-2' });

  const shot1 = path.resolve('./output/staging-stable-1/desktop.png');
  const shot2 = path.resolve('./output/staging-stable-2/desktop.png');

  const diff = checkDesktopRegression(shot1, shot2, 0.005);
  console.log('\n================ STABLE CAPTURE ON REAL STAGING ================');
  console.log('Target Staging URL :', url);
  console.log('Passed             :', diff.passed);
  console.log('Mismatch Ratio     :', diff.mismatchRatio);
  console.log('Diff Percentage    :', (diff.mismatchRatio * 100).toFixed(4) + '%');
  console.log('Diff Pixels        :', diff.diffPixels, '/', diff.totalPixels);
  console.log('Threshold          :', (diff.threshold * 100).toFixed(2) + '%');
  console.log('================================================================\n');
}

run().catch(console.error);
