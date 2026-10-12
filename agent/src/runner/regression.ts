import fs from 'fs';
import path from 'path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

export interface RegressionCheckResult {
  passed: boolean;
  mismatchRatio: number;
  diffPixels: number;
  totalPixels: number;
  threshold: number;
  diffImagePath?: string;
  errorMessage?: string;
}

/**
 * Compares two desktop viewport screenshots to detect unintended layout regressions.
 */
export function checkDesktopRegression(
  baselinePath: string,
  currentPath: string,
  threshold: number = 0.005,
  outputDiffPath?: string
): RegressionCheckResult {
  if (!fs.existsSync(baselinePath)) {
    throw new Error(`Baseline desktop screenshot does not exist at "${baselinePath}".`);
  }
  if (!fs.existsSync(currentPath)) {
    throw new Error(`Current desktop screenshot does not exist at "${currentPath}".`);
  }

  const baselineImg = PNG.sync.read(fs.readFileSync(baselinePath));
  const currentImg = PNG.sync.read(fs.readFileSync(currentPath));

  const width = Math.min(baselineImg.width, currentImg.width);
  const height = Math.min(baselineImg.height, currentImg.height);
  const totalPixels = width * height;

  const croppedBase = new PNG({ width, height });
  PNG.bitblt(baselineImg, croppedBase, 0, 0, width, height, 0, 0);

  const croppedCurr = new PNG({ width, height });
  PNG.bitblt(currentImg, croppedCurr, 0, 0, width, height, 0, 0);

  const diffPng = new PNG({ width, height });

  const diffPixels = pixelmatch(
    croppedBase.data,
    croppedCurr.data,
    diffPng.data,
    width,
    height,
    { threshold: 0.1 }
  );

  const mismatchRatio = totalPixels > 0 ? diffPixels / totalPixels : 0;
  const passed = mismatchRatio <= threshold;

  let savedDiffPath: string | undefined;
  if (!passed && outputDiffPath) {
    const diffDir = path.dirname(outputDiffPath);
    if (!fs.existsSync(diffDir)) {
      fs.mkdirSync(diffDir, { recursive: true });
    }
    fs.writeFileSync(outputDiffPath, PNG.sync.write(diffPng));
    savedDiffPath = outputDiffPath;
  }

  return {
    passed,
    mismatchRatio,
    diffPixels,
    totalPixels,
    threshold,
    diffImagePath: savedDiffPath,
    errorMessage: passed
      ? undefined
      : `Desktop layout regression detected! Mismatch ${(mismatchRatio * 100).toFixed(3)}% exceeds threshold ${(threshold * 100).toFixed(3)}% (${diffPixels} differing pixels).`,
  };
}
