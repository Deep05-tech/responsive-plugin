import http from 'http';
import fs from 'fs';
import path from 'path';
import { applyPatchesLocally } from './patch/apply.js';
import { validatePatches, PatchItem } from './patch/validator.js';
import { ElementorElement } from './patch/tree.js';
import { SectionMatcher } from './llm/section-matcher.js';
import { ChatAgent } from './llm/chat-agent.js';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8000;
const FIXTURES_DIR = path.resolve(process.cwd(), '../fixtures');
const OUTPUT_DIR = path.resolve(process.cwd(), 'output');

// Gated behind ERA_ENABLE_WRITES (defaults to false in Phase 1)
const ERA_ENABLE_WRITES = process.env.ERA_ENABLE_WRITES === 'true';

interface MockPage {
  id: number;
  title: string;
  url: string;
  modified: string;
  status: string;
  data: ElementorElement[];
  backups: Record<string, ElementorElement[]>;
  backupsList: Array<{
    key: string;
    title?: string;
    section_title?: string;
    action_type?: string;
    timestamp: number;
    date_gmt: string;
  }>;
}

const mockPages: Record<number, MockPage> = {
  101: {
    id: 101,
    title: 'Fixture 01: Fixed Width Containers',
    url: `http://localhost:${PORT}/fixtures/01-fixed-width-containers/index.html`,
    modified: new Date().toISOString(),
    status: 'publish',
    data: JSON.parse(
      fs.readFileSync(path.join(FIXTURES_DIR, '01-fixed-width-containers/data.json'), 'utf-8')
    ),
    backups: {},
    backupsList: [],
  },
  102: {
    id: 102,
    title: 'Fixture 02: Overflowing Image Row',
    url: `http://localhost:${PORT}/fixtures/02-overflowing-image-row/index.html`,
    modified: new Date().toISOString(),
    status: 'publish',
    data: JSON.parse(
      fs.readFileSync(path.join(FIXTURES_DIR, '02-overflowing-image-row/data.json'), 'utf-8')
    ),
    backups: {},
    backupsList: [],
  },
  103: {
    id: 103,
    title: 'Fixture 03: Tiny Tap Targets & Text',
    url: `http://localhost:${PORT}/fixtures/03-tiny-tap-targets-and-text/index.html`,
    modified: new Date().toISOString(),
    status: 'publish',
    data: JSON.parse(
      fs.readFileSync(path.join(FIXTURES_DIR, '03-tiny-tap-targets-and-text/data.json'), 'utf-8')
    ),
    backups: {},
    backupsList: [],
  },
  104: {
    id: 104,
    title: 'Fixture 04: Header Template',
    url: `http://localhost:${PORT}/fixtures/04-header-template/index.html`,
    modified: new Date().toISOString(),
    status: 'publish',
    data: JSON.parse(
      fs.readFileSync(path.join(FIXTURES_DIR, '04-header-template/data.json'), 'utf-8')
    ),
    backups: {},
    backupsList: [],
  },
};

function parseJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url || '/', `http://localhost:${PORT}`);
  const pathname = urlObj.pathname;
  const method = req.method || 'GET';

  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- 1. REST API: /wp-json/era/v1/pages (Read-Only) ---
  if (pathname === '/wp-json/era/v1/pages' && method === 'GET') {
    const pagesList = Object.values(mockPages).map((p) => ({
      id: p.id,
      title: p.title,
      url: p.url,
      modified: p.modified,
      status: p.status,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(pagesList, null, 2));
    return;
  }

  // --- 2. REST API: /wp-json/era/v1/page/:id (Read-Only) ---
  const pageMatch = pathname.match(/^\/wp-json\/era\/v1\/page\/(\d+)$/);
  if (pageMatch && method === 'GET') {
    const pageId = parseInt(pageMatch[1], 10);
    const page = mockPages[pageId];
    if (!page) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'era_post_not_found', message: 'Post not found.' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify(
        {
          id: page.id,
          title: page.title,
          url: page.url,
          modified: page.modified,
          _elementor_data: page.data,
        },
        null,
        2
      )
    );
    return;
  }

  // --- 3. REST API: /wp-json/era/v1/page/:id/patch (Gated behind ERA_ENABLE_WRITES) ---
  const patchMatch = pathname.match(/^\/wp-json\/era\/v1\/page\/(\d+)\/patch$/);
  if (patchMatch && method === 'POST') {
    if (!ERA_ENABLE_WRITES) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          code: 'rest_no_route',
          message: 'No route was found matching the URL and request method.',
          data: { status: 404 },
        })
      );
      return;
    }

    const pageId = parseInt(patchMatch[1], 10);
    const page = mockPages[pageId];
    if (!page) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'era_post_not_found', message: 'Post not found.' }));
      return;
    }

    try {
      const body = await parseJsonBody(req);
      const patches: PatchItem[] = Array.isArray(body.patches) ? body.patches : body;
      const allowHiding = Boolean(body.allow_hiding);

      const validation = validatePatches(patches, page.data, allowHiding);
      if (!validation.valid) {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            code: 'era_rule_violation',
            message: 'Validation failed on patch payload.',
            errors: validation.errors,
          })
        );
        return;
      }

      const timestamp = Date.now();
      const backupKey = `_era_backup_${timestamp}`;
      const changeTitle = body.title || body.action_summary || (body.section_title ? `Change for ${body.section_title}` : 'Responsive adjustment');
      page.backups[backupKey] = JSON.parse(JSON.stringify(page.data));
      page.backupsList.push({
        key: backupKey,
        title: changeTitle,
        section_title: body.section_title || '',
        action_type: body.action_type || 'content',
        timestamp,
        date_gmt: new Date(timestamp).toUTCString(),
      });

      const patchResult = applyPatchesLocally(page.data, patches);
      page.data = patchResult.updatedTree;
      page.modified = new Date().toISOString();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          page_id: pageId,
          backup_key: backupKey,
          applied_diff: patchResult.diff,
          patched_at: new Date(timestamp).toUTCString(),
        })
      );
    } catch (err: any) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'era_invalid_request', message: err.message }));
    }
    return;
  }

  // --- 4. REST API: /wp-json/era/v1/page/:id/restore (Gated behind ERA_ENABLE_WRITES) ---
  const restoreMatch = pathname.match(/^\/wp-json\/era\/v1\/page\/(\d+)\/restore$/);
  if (restoreMatch && method === 'POST') {
    if (!ERA_ENABLE_WRITES) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          code: 'rest_no_route',
          message: 'No route was found matching the URL and request method.',
          data: { status: 404 },
        })
      );
      return;
    }

    const pageId = parseInt(restoreMatch[1], 10);
    const page = mockPages[pageId];
    if (!page) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'era_post_not_found', message: 'Post not found.' }));
      return;
    }

    try {
      const body = await parseJsonBody(req);
      let backupKey = body.backup_key;
      if (!backupKey && page.backupsList.length > 0) {
        backupKey = page.backupsList[page.backupsList.length - 1].key;
      }

      if (!backupKey || !page.backups[backupKey]) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            code: 'era_backup_not_found',
            message: `Backup ${backupKey || ''} not found.`,
          })
        );
        return;
      }

      // Record pre-restore safety snapshot
      const safetyTime = Date.now();
      const safetyKey = `_era_backup_${safetyTime}`;
      page.backups[safetyKey] = JSON.parse(JSON.stringify(page.data));
      page.backupsList.push({
        key: safetyKey,
        title: `Safety Snapshot (before restoring ${backupKey})`,
        section_title: '',
        action_type: 'restore_point',
        timestamp: safetyTime,
        date_gmt: new Date(safetyTime).toUTCString(),
      });

      page.data = JSON.parse(JSON.stringify(page.backups[backupKey]));
      page.modified = new Date().toISOString();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          page_id: pageId,
          restored_key: backupKey,
          restored_at: new Date().toUTCString(),
        })
      );
    } catch (err: any) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'era_invalid_request', message: err.message }));
    }
    return;
  }

  // --- 5. Serve Fixtures ---
  if (pathname.startsWith('/fixtures/')) {
    const relativePath = pathname.replace('/fixtures/', '');
    const filePath = path.join(FIXTURES_DIR, relativePath);

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const contentType =
        ext === '.html' ? 'text/html' : ext === '.json' ? 'application/json' : 'text/plain';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(fs.readFileSync(filePath));
      return;
    }
  }

  // --- 6. Serve Output / Reports ---
  if (pathname.startsWith('/output/')) {
    const relativePath = pathname.replace('/output/', '');
    const filePath = path.join(OUTPUT_DIR, relativePath);

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const contentType =
        ext === '.html'
          ? 'text/html'
          : ext === '.json'
          ? 'application/json'
          : ext === '.png'
          ? 'image/png'
          : 'text/plain';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(fs.readFileSync(filePath));
      return;
    }
  }

  // --- 7. Server Dashboard ---
  if (pathname === '/' || pathname === '/index.html') {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Elementor Responsive Agent - Dev Server</title>
  <style>
    body { font-family: sans-serif; background: #0f172a; color: #fff; padding: 32px; }
  </style>
</head>
<body>
  <h1>ERA Bridge Server (Phase 1 Read-Only Mode: ERA_ENABLE_WRITES = ${ERA_ENABLE_WRITES})</h1>
</body>
</html>`;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  // --- 8. API: /api/health ---
  if (pathname === '/api/health' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: '1.0.0', mode: 'hybrid-local' }));
    return;
  }

  // --- 9. API: /api/chat ---
  if (pathname === '/api/chat' && method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const chatAgent = new ChatAgent();
      const result = await chatAgent.handleConversation({
        pageId: body.pageId,
        message: body.message,
        history: body.history,
        imageBase64: body.imageBase64,
        elementorData: body.elementorData,
        pageContext: body.pageContext,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ...result }));
      return;
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

export function startServer(port = PORT) {
  return server.listen(port, () => {
    console.log(`🌐 ERA Hybrid Agent Server running on http://localhost:${port} (ERA_ENABLE_WRITES=${ERA_ENABLE_WRITES})`);
  });
}

if (process.argv[1] && (process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('server.js'))) {
  startServer(PORT);
}
