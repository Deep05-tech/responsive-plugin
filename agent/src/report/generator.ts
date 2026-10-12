import fs from 'fs';
import path from 'path';
import { AuditReport, Issue, ElementIssuesGroup } from '../audit/types.js';

export interface ReportOptions {
  status?: 'passed' | 'needs_human' | 'restored' | 'audited';
  diff?: any;
  unresolved?: any[];
}

export class ReportGenerator {
  /**
   * Generate report.html for a given AuditReport.
   */
  public static generateHtmlReport(
    report: AuditReport,
    outputDir: string,
    options?: ReportOptions
  ): string {
    const status = options?.status || (report.totalIssues === 0 ? 'passed' : 'audited');

    const issuesHtml = Object.entries(report.issuesByElementId)
      .map(([elementKey, group]) => {
        const issuesList: Issue[] = Array.isArray(group) ? group : (group as ElementIssuesGroup).issues || [];
        const scope = (group as ElementIssuesGroup).scope || 'elementor';
        const elementId = (group as ElementIssuesGroup).elementId || 'null';

        const rows = issuesList
          .map(
            (iss) => `
          <tr class="issue-row issue-${iss.type}">
            <td><span class="badge badge-viewport badge-${iss.viewport}">${iss.viewport}</span></td>
            <td><span class="badge badge-severity badge-${iss.severity}">${iss.severity}</span></td>
            <td><span class="badge badge-type">${iss.type.replace(/_/g, ' ')}</span></td>
            <td><code>${iss.selector}</code></td>
            <td>
              <div>${iss.message}</div>
              ${iss.confirmedByRemoval ? '<span class="badge badge-confirmed">Confirmed by Removal</span>' : ''}
              ${iss.patchable ? '<span class="badge badge-patchable">Patchable</span>' : `<span class="badge badge-unpatchable">Unpatchable (${iss.unpatchableReason || 'theme'})</span>`}
              ${iss.fontSource ? `<span class="badge badge-font">Font Source: ${iss.fontSource}</span>` : ''}
              ${iss.outerHtmlSnippet ? `<pre class="html-snippet"><code>${escapeHtml(iss.outerHtmlSnippet)}</code></pre>` : ''}
            </td>
          </tr>`
          )
          .join('');

        return `
        <div class="element-card">
          <div class="element-card-header">
            <h3>Element ID: <span class="element-id">${elementId}</span> <span class="badge badge-scope">${scope}</span></h3>
            <span class="badge badge-count">${issuesList.length} issue${issuesList.length > 1 ? 's' : ''}</span>
          </div>
          <table class="issue-table">
            <thead>
              <tr>
                <th>Viewport</th>
                <th>Severity</th>
                <th>Issue Type</th>
                <th>Selector</th>
                <th>Details & Diagnostics</th>
              </tr>
            </thead>
            <tbody>
              ${rows}
            </tbody>
          </table>
        </div>`;
      })
      .join('');

    const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ERA Audit Report - ${report.pageId}</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #3b82f6;
      --danger: #ef4444;
      --warning: #f59e0b;
      --success: #10b981;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      padding: 24px;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    header {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 24px;
    }
    .header-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 16px;
    }
    h1 { font-size: 24px; font-weight: 700; color: #fff; }
    .page-url { color: var(--text-muted); font-size: 14px; word-break: break-all; }
    .status-badge {
      display: inline-block;
      padding: 6px 14px;
      border-radius: 20px;
      font-weight: 600;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .status-passed { background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid #10b981; }
    .status-audited { background: rgba(59, 130, 246, 0.2); color: #60a5fa; border: 1px solid #3b82f6; }
    .status-needs_human { background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid #ef4444; }

    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-top: 20px;
    }
    .summary-card {
      background: #0f172a;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
    }
    .summary-card h4 { color: var(--text-muted); font-size: 13px; text-transform: uppercase; margin-bottom: 8px; }
    .summary-card .value { font-size: 24px; font-weight: 700; }

    .element-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      margin-bottom: 20px;
      overflow: hidden;
    }
    .element-card-header {
      padding: 16px 20px;
      background: rgba(255, 255, 255, 0.02);
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .element-id { color: #38bdf8; font-family: monospace; font-size: 16px; }

    .issue-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    .issue-table th, .issue-table td {
      padding: 12px 20px;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }
    .issue-table th {
      background: rgba(0, 0, 0, 0.2);
      color: var(--text-muted);
      font-weight: 600;
      text-transform: uppercase;
      font-size: 12px;
      letter-spacing: 0.5px;
    }
    .badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      margin-right: 4px;
      margin-top: 4px;
    }
    .badge-viewport { background: #334155; color: #f8fafc; }
    .badge-severity.badge-P0 { background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid #ef4444; }
    .badge-severity.badge-P1 { background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid #f59e0b; }
    .badge-severity.badge-P2 { background: rgba(59, 130, 246, 0.2); color: #60a5fa; border: 1px solid #3b82f6; }
    .badge-scope { background: #1e1b4b; color: #a5b4fc; border: 1px solid #4338ca; }
    .badge-confirmed { background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid #10b981; }
    .badge-patchable { background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid #10b981; }
    .badge-unpatchable { background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid #ef4444; }
    .badge-font { background: #374151; color: #d1d5db; }
    .badge-count { background: #3b82f6; color: #fff; border-radius: 12px; }

    .html-snippet {
      background: #020617;
      padding: 6px 10px;
      border-radius: 4px;
      font-size: 11px;
      color: #94a3b8;
      margin-top: 6px;
      overflow-x: auto;
      max-width: 500px;
    }

    .screenshots-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 20px;
      margin-top: 24px;
    }
    .screenshot-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px;
    }
    .screenshot-card h3 {
      font-size: 16px;
      margin-bottom: 12px;
      color: #fff;
    }
    .screenshot-img {
      width: 100%;
      height: 380px;
      object-fit: cover;
      object-position: top;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: #000;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="header-top">
        <div>
          <h1>Elementor Responsive Layout Report</h1>
          <div class="page-url">${report.pageUrl} (Page ID: ${report.pageId})</div>
        </div>
        <span class="status-badge status-${status}">${status}</span>
      </div>

      <div class="summary-grid">
        <div class="summary-card">
          <h4>Total Issues</h4>
          <div class="value">${report.totalIssues}</div>
        </div>
        <div class="summary-card">
          <h4>P0 Critical</h4>
          <div class="value" style="color: #f87171;">${report.summary.bySeverity.P0}</div>
        </div>
        <div class="summary-card">
          <h4>P1 High</h4>
          <div class="value" style="color: #fbbf24;">${report.summary.bySeverity.P1}</div>
        </div>
        <div class="summary-card">
          <h4>P2 Moderate</h4>
          <div class="value" style="color: #60a5fa;">${report.summary.bySeverity.P2}</div>
        </div>
        <div class="summary-card">
          <h4>Patchable</h4>
          <div class="value" style="color: #34d399;">${report.summary.patchableCount} / ${report.totalIssues}</div>
        </div>
        <div class="summary-card">
          <h4>Distinct Elements</h4>
          <div class="value">${report.summary.distinctElements}</div>
        </div>
      </div>
    </header>

    <main>
      ${
        report.totalIssues === 0
          ? `<div style="text-align: center; padding: 60px; background: var(--card-bg); border-radius: 12px; border: 1px solid var(--border);">
               <h2 style="color: #34d399; margin-bottom: 8px;">🎉 Perfect Responsive Layout!</h2>
               <p style="color: var(--text-muted);">No measurable responsive layout regressions detected across Mobile, Tablet, and Desktop viewports.</p>
             </div>`
          : issuesHtml
      }

      <div class="screenshots-grid">
        <div class="screenshot-card">
          <h3>📱 Mobile (375px)</h3>
          <img class="screenshot-img" src="./mobile.png" alt="Mobile Viewport Screenshot">
        </div>
        <div class="screenshot-card">
          <h3>📱 Tablet (768px)</h3>
          <img class="screenshot-img" src="./tablet.png" alt="Tablet Viewport Screenshot">
        </div>
        <div class="screenshot-card">
          <h3>💻 Desktop (1280px)</h3>
          <img class="screenshot-img" src="./desktop.png" alt="Desktop Viewport Screenshot">
        </div>
      </div>
    </main>
  </div>
</body>
</html>`;

    const htmlPath = path.join(outputDir, 'report.html');
    fs.writeFileSync(htmlPath, htmlContent, 'utf-8');
    return htmlPath;
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
