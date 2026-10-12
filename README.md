# Elementor Responsive Agent (ERA)

> Automated responsive layout auditor and patcher for Elementor-built WordPress pages. Audits layouts with measurable browser-level checks across mobile (375px), tablet (768px), and desktop (1280px), mapping every defect to native Elementor element IDs, proposing strictly responsive patches, and executing automated fix loops with timestamped backups, regression guards, and one-command restores.

---

## Complete Architecture Overview

```
Responsive Plugin/
├── wordpress-plugin/
│   └── elementor-responsive-agent-bridge/  # WordPress REST API bridge (era/v1) & Admin Backups UI
│       ├── elementor-responsive-agent-bridge.php
│       └── includes/
│           ├── class-era-rest-api.php      # Read/Write/Restore REST routes + Cache clearing
│           └── class-era-admin.php         # Admin Backups UI + One-Click Restore
├── agent/                                  # Node.js + TypeScript CLI service
│   ├── src/
│   │   ├── audit/                          # Playwright auditor & 7 measurable checks
│   │   ├── llm/                            # Claude API Analyst, structured output & prompts
│   │   ├── patch/                          # Tree traversal, element lookup, validator & local patcher
│   │   ├── runner/                         # Iterative loop runner, regression guard & batch runner
│   │   ├── bridge/                         # WordPress REST client
│   │   ├── report/                         # HTML & JSON report generator
│   │   ├── config/                         # Configuration & blocklist safety guard
│   │   └── cli.ts                          # CLI entry point (era audit, propose, fix, restore, run-all)
│   └── tests/                              # Unit & integration test suites (18 passing tests)
├── fixtures/                               # 3 intentionally broken Elementor page fixtures
│   ├── 01-fixed-width-containers/
│   ├── 02-overflowing-image-row/
│   └── 03-tiny-tap-targets-and-text/
├── .env.example
├── README.md
└── LIMITATIONS.md
```

---

## Hard Rules (Enforced in Code)

1. **Direct Post Meta**: Reads/writes page `_elementor_data` post meta directly without automating the Elementor editor UI.
2. **Strict Responsive Key Validator**: Rejects ANY patch modifying keys that do not end in `_mobile`, `_tablet`, `_mobile_extra`, or `_tablet_extra`. Desktop/base keys are rejected before any write occurs.
3. **Staging / Production Blocklist Guard**: Refuses execution against any target matching `PRODUCTION_URL_BLOCKLIST`.
4. **Timestamped Backups & One-Command Restore**: Creates timestamped backup in file + post meta (`_era_backup_<timestamp>`) before every write. Provides instant one-command and one-click restore.
5. **Measurable Verification**: Success is determined exclusively by measurable DOM layout checks passing.
6. **Iteration Limit**: Maximum 3 iterations before marking a page as `needs_human`. Stops early if issue count does not decrease across 2 iterations.
7. **Hiding Prohibition**: Content hiding (`hide_mobile` / `hide_tablet`) is rejected unless `ALLOW_HIDING=true`.
8. **Desktop Regression Guard**: Re-audits desktop viewport (1280px) and auto-restores if pixel mismatch exceeds `DESKTOP_DIFF_THRESHOLD` (0.5%).

---

## 7 Measurable Responsive Checks (Auditor)

1. **Horizontal Page Overflow**: `document.documentElement.scrollWidth > window.innerWidth`
2. **Overflowing Elements**: Elements whose bounding box `rect.right > window.innerWidth + 1`
3. **Small Font Sizes on Mobile**: Text computed font size `< 14px` on mobile (375px)
4. **Small Tap Targets on Mobile**: Interactive targets (`a, button, input, [role=button]`) `< 44x44px`
5. **Overlapping Siblings**: Sibling elements whose bounding box intersection exceeds `> 10%` area
6. **Images / Media Wider than Container**: Media elements exceeding parent width
7. **Fixed Pixel Width Overflows**: Elements with fixed `width` in pixels exceeding viewport width

---

## WordPress Bridge Plugin Setup

### 1. Install & Activate Plugin
1. Copy `wordpress-plugin/elementor-responsive-agent-bridge` into your staging WordPress site's `wp-content/plugins/` directory.
2. In WP Admin, go to **Plugins** -> **Installed Plugins** and activate **Elementor Responsive Agent Bridge**.

### 2. Generate WordPress Application Password
1. Navigate to **Users** -> **Profile** (or edit an Administrator/Editor user with `edit_pages` capability).
2. Scroll to the **Application Passwords** section.
3. Enter a name (e.g. `ERA_Agent`) and click **Add New Application Password**.
4. Copy the generated 24-character password.

### 3. Staging Clone Guidelines
> [!CAUTION]
> Never target a production WordPress site. Always clone your production site to a dedicated staging environment (e.g., `staging.example.com` or local environment `http://localhost:8000`).

---

## Agent Setup & Configuration

### 1. Install Dependencies
```bash
cd agent
npm install
npx playwright install chromium
```

### 2. Environment Configuration
Copy `.env.example` to `.env` and fill in your staging details:
```bash
cp ../.env.example .env
```

```ini
WP_BASE_URL=https://staging.example.com
WP_USER=era_agent
WP_APP_PASSWORD=xxxx xxxx xxxx xxxx
ANTHROPIC_API_KEY=sk-ant-api03-...
ANTHROPIC_MODEL=claude-3-5-sonnet-20241022
PRODUCTION_URL_BLOCKLIST=example.com,production.org
ALLOW_HIDING=false
MAX_ITERATIONS=3
DESKTOP_DIFF_THRESHOLD=0.005
```

---

## Complete CLI Reference

### 1. Audit (Read-Only)
```bash
# Audit a WordPress page by ID
npx tsx src/cli.ts audit --page 42

# Audit a fixture or direct URL
npx tsx src/cli.ts audit --page "file:///path/to/fixtures/01-fixed-width-containers/index.html" --output ./output/fixture-01
```

### 2. Propose Patches (Read-Only)
```bash
# Analyze layout defects and print proposed responsive patches without writing
npx tsx src/cli.ts propose --page 42
npx tsx src/cli.ts propose --page "file:///path/to/fixtures/01-fixed-width-containers/index.html"
```

### 3. Fix (Iterative Audit -> Patch -> Verify Loop)
```bash
# Dry-run simulation (no writes)
npx tsx src/cli.ts fix --page 42 --dry-run

# Live fix execution (requires --confirm)
npx tsx src/cli.ts fix --page 42 --confirm
```

### 4. Restore
```bash
# Restore page to latest backup (or specify backup key)
npx tsx src/cli.ts restore --page 42
npx tsx src/cli.ts restore --page 42 --backup _era_backup_1728472800
```

### 5. Run Across All Pages (Rate-Limited & Resumable)
```bash
# Run batch optimization across all site pages
npx tsx src/cli.ts run-all --delay 1500
```

---

## Running the Automated Test Suite

```bash
cd agent
npm test
```
