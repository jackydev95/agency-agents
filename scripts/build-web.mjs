#!/usr/bin/env node
/**
 * Static Web Catalog Builder for Agency Agents
 * Reads divisions.json, tools.json, strategy/runbooks.json, and all division .md files,
 * then emits a fast, zero-dependency searchable web catalog into public/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'public');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripQuotes(val) {
  const trimmed = val.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseFrontmatter(raw) {
  const normalized = raw.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { meta: {}, body: normalized };
  }
  const endIdx = normalized.indexOf('\n---\n', 4);
  if (endIdx === -1) {
    return { meta: {}, body: normalized };
  }
  const fmText = normalized.slice(4, endIdx);
  const body = normalized.slice(endIdx + 5);
  const meta = {};
  for (const line of fmText.split('\n')) {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (match) {
      meta[match[1]] = stripQuotes(match[2]);
    }
  }
  return { meta, body };
}

function formatInline(text) {
  // Tokenize inline code spans first so inner markdown characters aren't mutated
  const codeTokens = [];
  let safe = text.replace(/`([^`]+)`/g, (_, code) => {
    const idx = codeTokens.length;
    codeTokens.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000CODE_${idx}\u0000`;
  });

  safe = escapeHtml(safe);

  // Links [label](href)
  safe = safe.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const cleanHref = href.replace(/&amp;/g, '&');
    if (
      cleanHref.startsWith('http://') ||
      cleanHref.startsWith('https://') ||
      cleanHref.startsWith('mailto:') ||
      cleanHref.startsWith('#') ||
      cleanHref.startsWith('/')
    ) {
      const target = cleanHref.startsWith('http') ? ' target="_blank" rel="noopener noreferrer"' : '';
      return `<a href="${escapeHtml(cleanHref)}"${target}>${label}</a>`;
    }
    return label;
  });

  // Bold & italic
  safe = safe.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  safe = safe.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  // Restore inline code tokens
  safe = safe.replace(/\u0000CODE_(\d+)\u0000/g, (_, idx) => codeTokens[Number(idx)]);
  return safe;
}

function renderMarkdown(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code block
    const fenceMatch = line.match(/^(`{3,}|~{3,})\s*([^\s`]*)/);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const lang = fenceMatch[2] || '';
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith(fence)) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // consume closing fence
      const escapedCode = escapeHtml(codeLines.join('\n'));
      const langBadge = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '<span></span>';
      html.push(
        `<div class="code-block"><div class="code-header">${langBadge}<button type="button" class="copy-inline-btn" data-copy-code>Copy</button></div><pre><code>${escapedCode}</code></pre></div>`
      );
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      html.push('<hr />');
      i++;
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      html.push(`<h${level}>${formatInline(headingMatch[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    // Table
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(lines[i + 1])
    ) {
      const parseRow = (r) =>
        r
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => formatInline(c.trim()));

      const headers = parseRow(line);
      i += 2; // skip header + separator
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(parseRow(lines[i]));
        i++;
      }
      html.push(
        `<div class="table-wrap"><table><thead><tr>${headers
          .map((h) => `<th>${h}</th>`)
          .join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`
      );
      continue;
    }

    // Blockquote
    if (line.trim().startsWith('>')) {
      const quoteLines = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      html.push(`<blockquote>${renderMarkdown(quoteLines.join('\n'))}</blockquote>`);
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      html.push(`<ul>${items.map((it) => `<li>${formatInline(it)}</li>`).join('')}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      html.push(`<ol>${items.map((it) => `<li>${formatInline(it)}</li>`).join('')}</ol>`);
      continue;
    }

    // Paragraph
    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,6}\s+|`{3,}|~{3,}|(-{3,}|\*{3,}|_{3,})\s*$|>\s?|\s*[-*+]\s+|\s*\d+\.\s+)/.test(lines[i])
    ) {
      paraLines.push(lines[i].trim());
      i++;
    }
    if (paraLines.length > 0) {
      html.push(`<p>${formatInline(paraLines.join(' '))}</p>`);
    } else {
      i++;
    }
  }

  return html.join('\n');
}

function detectRepoUrl() {
  if (process.env.VERCEL_GIT_REPO_OWNER && process.env.VERCEL_GIT_REPO_SLUG) {
    return `https://github.com/${process.env.VERCEL_GIT_REPO_OWNER}/${process.env.VERCEL_GIT_REPO_SLUG}`;
  }
  try {
    const remote = execSync('git config --get remote.origin.url', {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (remote.startsWith('git@github.com:')) {
      return `https://github.com/${remote.slice('git@github.com:'.length).replace(/\.git$/, '')}`;
    }
    if (remote.startsWith('https://github.com/')) {
      return remote.replace(/\.git$/, '');
    }
  } catch {
    // fallback below
  }
  return 'https://github.com/msitarzewski/agency-agents';
}

function walkAgentFiles(dir, fileList = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkAgentFiles(fullPath, fileList);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

// Clean output directory
fs.rmSync(OUT, { recursive: true, force: true });
ensureDir(path.join(OUT, 'api', 'agents'));
ensureDir(path.join(OUT, 'api', 'runbooks'));
ensureDir(path.join(OUT, 'raw'));

const divisionsRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'divisions.json'), 'utf8')).divisions;
const toolsRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools.json'), 'utf8')).tools;
const runbooksRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'strategy', 'runbooks.json'), 'utf8')).runbooks;

const repoUrl = detectRepoUrl();
const agentsSummary = [];
const agentBySlug = new Map();
const divisionCounts = {};

for (const [divKey, divMeta] of Object.entries(divisionsRaw)) {
  const divDir = path.join(ROOT, divKey);
  divisionCounts[divKey] = 0;
  if (!fs.existsSync(divDir)) continue;

  const files = walkAgentFiles(divDir).sort();
  for (const fullPath of files) {
    const raw = fs.readFileSync(fullPath, 'utf8');
    const firstLine = raw.split(/\r?\n/)[0];
    if (firstLine !== '---') continue;

    const relPath = path.relative(ROOT, fullPath).split(path.sep).join('/');
    const slug = path.basename(fullPath, '.md');
    const subCategory = path.dirname(relPath).includes('/')
      ? path.dirname(relPath).split('/').slice(1).join(' / ')
      : null;

    const { meta, body } = parseFrontmatter(raw);
    const headings = [];
    for (const line of body.split('\n')) {
      const m = line.match(/^#{2,3}\s+(.+)$/);
      if (m) headings.push(m[1].replace(/[^\w\s&/-]/g, '').trim());
    }

    const name = meta.name || slug;
    const description = meta.description || '';
    const emoji = meta.emoji || '🤖';
    const vibe = meta.vibe || '';
    const color = meta.color || divMeta.color;

    divisionCounts[divKey]++;

    const summaryItem = {
      slug,
      name,
      division: divKey,
      divisionLabel: divMeta.label,
      divisionColor: divMeta.color,
      subCategory,
      emoji,
      vibe,
      description,
      color,
      path: relPath,
      headings: headings.slice(0, 8),
    };

    agentsSummary.push(summaryItem);
    agentBySlug.set(slug, summaryItem);

    // Copy raw file
    const rawDest = path.join(OUT, 'raw', relPath);
    ensureDir(path.dirname(rawDest));
    fs.writeFileSync(rawDest, raw, 'utf8');

    // Write detailed JSON payload
    const detailPayload = {
      ...summaryItem,
      rawMarkdown: raw,
      bodyMarkdown: body.trim(),
      html: renderMarkdown(body),
    };
    fs.writeFileSync(
      path.join(OUT, 'api', 'agents', `${slug}.json`),
      JSON.stringify(detailPayload),
      'utf8'
    );
  }
}

agentsSummary.sort((a, b) => a.name.localeCompare(b.name));

const divisionsList = Object.entries(divisionsRaw).map(([key, meta]) => ({
  key,
  label: meta.label,
  icon: meta.icon,
  color: meta.color,
  count: divisionCounts[key] || 0,
}));

const toolsList = Object.values(toolsRaw)
  .sort((a, b) => (a.order || 99) - (b.order || 99))
  .map((t) => ({
    kebab: t.kebab,
    label: t.label,
    short: t.short,
    accent: t.accent,
    format: t.format,
    installKind: t.installKind,
    scope: t.scope,
    dest: t.dest,
  }));

const runbooksSummary = runbooksRaw.map((rb) => {
  const uniqueSlugs = new Set();
  const enrichedRoster = rb.roster.map((group) => ({
    group: group.group,
    activation: group.activation,
    agents: group.agents.map((slug) => {
      uniqueSlugs.add(slug);
      const found = agentBySlug.get(slug);
      return found
        ? {
            slug: found.slug,
            name: found.name,
            emoji: found.emoji,
            division: found.division,
            divisionLabel: found.divisionLabel,
            divisionColor: found.divisionColor,
            vibe: found.vibe,
          }
        : { slug, name: slug, emoji: '🤖', division: '', divisionLabel: '', divisionColor: '#64748B', vibe: '' };
    }),
  }));

  const docPath = path.join(ROOT, rb.doc);
  const rawDoc = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8') : '';

  const detail = {
    slug: rb.slug,
    title: rb.title,
    mode: rb.mode,
    duration: rb.duration,
    summary: rb.summary,
    doc: rb.doc,
    agentCount: uniqueSlugs.size,
    allSlugs: Array.from(uniqueSlugs),
    roster: enrichedRoster,
    rawMarkdown: rawDoc,
    html: rawDoc ? renderMarkdown(rawDoc) : '',
  };

  fs.writeFileSync(
    path.join(OUT, 'api', 'runbooks', `${rb.slug}.json`),
    JSON.stringify(detail),
    'utf8'
  );

  return {
    slug: rb.slug,
    title: rb.title,
    mode: rb.mode,
    duration: rb.duration,
    summary: rb.summary,
    agentCount: uniqueSlugs.size,
    allSlugs: Array.from(uniqueSlugs),
    roster: enrichedRoster,
  };
});

const catalog = {
  repoUrl,
  stats: {
    totalAgents: agentsSummary.length,
    totalDivisions: divisionsList.length,
    totalRunbooks: runbooksSummary.length,
    totalTools: toolsList.length,
  },
  divisions: divisionsList,
  tools: toolsList,
  runbooks: runbooksSummary,
  agents: agentsSummary,
};

fs.writeFileSync(path.join(OUT, 'api', 'catalog.json'), JSON.stringify(catalog), 'utf8');

const indexHtml = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>The Agency — AI Specialists Catalog</title>
  <meta name="description" content="Browse, search, assemble teams, and install ${catalog.stats.totalAgents}+ specialized AI agent personas across ${catalog.stats.totalDivisions} divisions and ${catalog.stats.totalTools} AI coding tools." />
  <style>
    :root {
      --bg: #090b10;
      --bg-elev: #11151f;
      --bg-card: #151a27;
      --bg-card-hover: #1b2233;
      --border: rgba(255, 255, 255, 0.08);
      --border-strong: rgba(255, 255, 255, 0.16);
      --text: #f3f6fc;
      --text-muted: #94a3b8;
      --text-soft: #64748b;
      --accent: #6366f1;
      --accent-hover: #818cf8;
      --accent-soft: rgba(99, 102, 241, 0.14);
      --success: #10b981;
      --code-bg: #0b0e16;
      --shadow: 0 20px 50px rgba(0, 0, 0, 0.55);
      --radius: 14px;
      --radius-sm: 9px;
    }

    html[data-theme="light"] {
      --bg: #f8fafc;
      --bg-elev: #ffffff;
      --bg-card: #ffffff;
      --bg-card-hover: #f1f5f9;
      --border: rgba(15, 23, 42, 0.09);
      --border-strong: rgba(15, 23, 42, 0.18);
      --text: #0f172a;
      --text-muted: #475569;
      --text-soft: #64748b;
      --accent: #4f46e5;
      --accent-hover: #4338ca;
      --accent-soft: rgba(79, 70, 229, 0.1);
      --code-bg: #0f172a;
      --shadow: 0 20px 45px rgba(15, 23, 42, 0.12);
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
      background: radial-gradient(circle at 15% 0%, rgba(99, 102, 241, 0.12), transparent 38%),
                  radial-gradient(circle at 85% 5%, rgba(236, 72, 153, 0.08), transparent 35%),
                  var(--bg);
      color: var(--text);
      line-height: 1.55;
      min-height: 100vh;
    }

    a { color: var(--accent-hover); text-decoration: none; }
    a:hover { text-decoration: underline; }

    .container {
      max-width: 1320px;
      margin: 0 auto;
      padding: 0 24px;
    }

    /* Topbar */
    .topbar {
      position: sticky;
      top: 0;
      z-index: 30;
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      background: color-mix(in srgb, var(--bg) 82%, transparent);
      border-bottom: 1px solid var(--border);
    }
    .topbar-inner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      height: 66px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 11px;
      font-weight: 700;
      font-size: 1.08rem;
      letter-spacing: -0.02em;
      color: var(--text);
      cursor: pointer;
    }
    .brand-logo {
      width: 36px;
      height: 36px;
      border-radius: 10px;
      display: grid;
      place-items: center;
      background: linear-gradient(135deg, #6366f1, #ec4899);
      font-size: 1.15rem;
      box-shadow: 0 6px 18px rgba(99, 102, 241, 0.35);
    }
    .nav-tabs {
      display: flex;
      gap: 6px;
      background: var(--bg-elev);
      padding: 4px;
      border-radius: 11px;
      border: 1px solid var(--border);
    }
    .nav-tab {
      border: 0;
      background: transparent;
      color: var(--text-muted);
      padding: 7px 14px;
      border-radius: 8px;
      font-size: 0.88rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s ease;
      display: flex;
      align-items: center;
      gap: 7px;
    }
    .nav-tab:hover { color: var(--text); }
    .nav-tab.active {
      background: var(--accent);
      color: #fff;
    }
    .nav-badge {
      font-size: 0.73rem;
      padding: 1px 7px;
      border-radius: 999px;
      background: rgba(255,255,255,0.16);
    }
    .nav-tab:not(.active) .nav-badge {
      background: var(--border);
      color: var(--text-muted);
    }
    .topbar-actions {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      padding: 8px 14px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-strong);
      background: var(--bg-elev);
      color: var(--text);
      font-size: 0.86rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s ease;
      text-decoration: none !important;
    }
    .btn:hover {
      border-color: var(--accent);
      background: var(--bg-card-hover);
    }
    .btn-primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
    }
    .btn-primary:hover {
      background: var(--accent-hover);
      border-color: var(--accent-hover);
    }
    .btn-sm {
      padding: 5px 10px;
      font-size: 0.78rem;
    }

    /* Hero */
    .hero {
      padding: 44px 0 26px;
      text-align: center;
    }
    .hero-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 5px 14px;
      border-radius: 999px;
      background: var(--accent-soft);
      border: 1px solid rgba(99, 102, 241, 0.3);
      color: var(--accent-hover);
      font-size: 0.8rem;
      font-weight: 600;
      margin-bottom: 16px;
    }
    html[data-theme="light"] .hero-pill { color: var(--accent); }
    .hero h1 {
      margin: 0 auto 12px;
      font-size: clamp(2rem, 4vw, 3.1rem);
      line-height: 1.12;
      letter-spacing: -0.03em;
      max-width: 820px;
    }
    .hero p {
      margin: 0 auto 26px;
      max-width: 680px;
      color: var(--text-muted);
      font-size: 1.04rem;
    }

    /* Search & Tool Selector Bar */
    .controls-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
      margin-bottom: 18px;
    }
    .search-wrap {
      flex: 1 1 320px;
      position: relative;
    }
    .search-input {
      width: 100%;
      padding: 13px 72px 13px 42px;
      border-radius: 12px;
      border: 1px solid var(--border-strong);
      background: var(--bg-elev);
      color: var(--text);
      font-size: 0.95rem;
      outline: none;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    .search-input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-soft);
    }
    .search-icon {
      position: absolute;
      left: 14px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--text-soft);
      pointer-events: none;
    }
    .search-kbd {
      position: absolute;
      right: 12px;
      top: 50%;
      transform: translateY(-50%);
      font-size: 0.73rem;
      padding: 2px 7px;
      border-radius: 6px;
      border: 1px solid var(--border-strong);
      color: var(--text-soft);
      background: var(--bg-card);
    }
    .tool-picker-wrap {
      display: flex;
      align-items: center;
      gap: 8px;
      background: var(--bg-elev);
      border: 1px solid var(--border-strong);
      padding: 6px 12px;
      border-radius: 12px;
      font-size: 0.84rem;
      color: var(--text-muted);
    }
    .tool-select {
      background: transparent;
      color: var(--text);
      border: 0;
      font-weight: 600;
      font-size: 0.86rem;
      outline: none;
      cursor: pointer;
    }
    .tool-select option {
      background: var(--bg-card);
      color: var(--text);
    }

    /* Division Chips */
    .divisions-strip {
      display: flex;
      gap: 8px;
      overflow-x: auto;
      padding-bottom: 10px;
      margin-bottom: 20px;
      scrollbar-width: thin;
    }
    .div-chip {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 7px 13px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--bg-elev);
      color: var(--text-muted);
      font-size: 0.82rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .div-chip:hover {
      border-color: var(--border-strong);
      color: var(--text);
    }
    .div-chip.active {
      color: var(--text);
      border-color: var(--chip-color, var(--accent));
      background: color-mix(in srgb, var(--chip-color, var(--accent)) 18%, var(--bg-elev));
    }
    .div-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--chip-color, var(--accent));
    }
    .div-count {
      font-size: 0.73rem;
      opacity: 0.72;
    }

    /* Results meta */
    .results-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      font-size: 0.86rem;
      color: var(--text-muted);
    }

    /* Agent Grid */
    .agent-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(310px, 1fr));
      gap: 16px;
      padding-bottom: 90px;
    }
    .agent-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 18px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 14px;
      transition: transform 0.16s ease, border-color 0.16s ease, background 0.16s ease;
      cursor: pointer;
      position: relative;
    }
    .agent-card:hover {
      transform: translateY(-2px);
      border-color: var(--border-strong);
      background: var(--bg-card-hover);
    }
    .agent-card.selected {
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent);
    }
    .card-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
    }
    .agent-avatar {
      width: 42px;
      height: 42px;
      border-radius: 11px;
      display: grid;
      place-items: center;
      font-size: 1.35rem;
      background: color-mix(in srgb, var(--div-color, #6366f1) 15%, var(--bg-elev));
      border: 1px solid color-mix(in srgb, var(--div-color, #6366f1) 35%, transparent);
      flex-shrink: 0;
    }
    .card-badges {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .div-badge {
      font-size: 0.72rem;
      font-weight: 600;
      padding: 3px 9px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--div-color, #6366f1) 15%, transparent);
      color: var(--div-color, #818cf8);
      border: 1px solid color-mix(in srgb, var(--div-color, #6366f1) 32%, transparent);
    }
    .select-check {
      width: 26px;
      height: 26px;
      border-radius: 7px;
      border: 1px solid var(--border-strong);
      background: var(--bg-elev);
      color: var(--text-muted);
      display: grid;
      place-items: center;
      cursor: pointer;
      font-size: 0.82rem;
      transition: all 0.15s ease;
    }
    .select-check:hover { border-color: var(--accent); color: var(--text); }
    .agent-card.selected .select-check {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
    }
    .agent-title {
      margin: 10px 0 4px;
      font-size: 1.03rem;
      font-weight: 700;
      letter-spacing: -0.01em;
    }
    .agent-vibe {
      margin: 0 0 8px;
      font-size: 0.82rem;
      color: var(--accent-hover);
      font-style: italic;
    }
    html[data-theme="light"] .agent-vibe { color: var(--accent); }
    .agent-desc {
      margin: 0;
      font-size: 0.86rem;
      color: var(--text-muted);
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .card-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding-top: 11px;
      border-top: 1px solid var(--border);
      font-size: 0.76rem;
      color: var(--text-soft);
    }
    .slug-mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 175px;
    }

    /* Runbooks & Tools Views */
    .runbook-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
      gap: 18px;
      padding-bottom: 80px;
    }
    .runbook-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 22px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      cursor: pointer;
      transition: all 0.16s ease;
    }
    .runbook-card:hover {
      border-color: var(--accent);
      transform: translateY(-2px);
    }
    .rb-meta {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      font-size: 0.76rem;
      font-weight: 600;
    }
    .rb-pill {
      padding: 3px 10px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent-hover);
    }
    .rb-groups {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .rb-group {
      background: var(--bg-elev);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 12px;
    }
    .rb-group-header {
      display: flex;
      justify-content: space-between;
      font-size: 0.79rem;
      font-weight: 700;
      margin-bottom: 7px;
      color: var(--text-muted);
    }
    .rb-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .rb-agent-chip {
      font-size: 0.76rem;
      padding: 3px 8px;
      border-radius: 7px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      color: var(--text);
    }

    .tools-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 16px;
      padding-bottom: 80px;
    }
    .tool-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 11px;
    }
    .tool-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .tool-title {
      display: flex;
      align-items: center;
      gap: 9px;
      font-weight: 700;
      font-size: 1rem;
    }
    .tool-cmd {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.79rem;
      background: var(--code-bg);
      color: #e2e8f0;
      padding: 9px 11px;
      border-radius: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      overflow-x: auto;
    }

    /* Floating Team Basket */
    .team-bar {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 40;
      background: var(--bg-elev);
      border: 1px solid var(--accent);
      box-shadow: var(--shadow);
      border-radius: 16px;
      padding: 12px 18px;
      display: none;
      align-items: center;
      gap: 14px;
      max-width: min(92vw, 880px);
      width: max-content;
    }
    .team-bar.visible { display: flex; flex-wrap: wrap; }
    .team-cmd-preview {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.78rem;
      background: var(--code-bg);
      color: #e2e8f0;
      padding: 7px 11px;
      border-radius: 8px;
      max-width: 410px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Drawer / Modal */
    .drawer-backdrop {
      position: fixed;
      inset: 0;
      z-index: 50;
      background: rgba(3, 6, 14, 0.72);
      backdrop-filter: blur(5px);
      display: none;
      justify-content: flex-end;
    }
    .drawer-backdrop.open { display: flex; }
    .drawer {
      width: min(860px, 100vw);
      height: 100vh;
      background: var(--bg-elev);
      border-left: 1px solid var(--border-strong);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      box-shadow: var(--shadow);
    }
    .drawer-header {
      padding: 20px 26px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
    }
    .drawer-tabs {
      display: flex;
      gap: 8px;
      padding: 10px 26px;
      border-bottom: 1px solid var(--border);
      background: var(--bg);
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
    }
    .drawer-body {
      padding: 24px 28px 60px;
      overflow-y: auto;
      flex: 1;
    }

    /* Rendered Markdown Styles */
    .md-content h1, .md-content h2, .md-content h3, .md-content h4 {
      margin-top: 1.5em;
      margin-bottom: 0.55em;
      letter-spacing: -0.015em;
    }
    .md-content h1:first-child, .md-content h2:first-child { margin-top: 0; }
    .md-content h2 {
      padding-bottom: 7px;
      border-bottom: 1px solid var(--border);
      font-size: 1.22rem;
    }
    .md-content p, .md-content li {
      color: var(--text-muted);
      font-size: 0.94rem;
    }
    .md-content strong { color: var(--text); }
    .md-content code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.84em;
      padding: 2px 6px;
      border-radius: 5px;
      background: rgba(99, 102, 241, 0.14);
      color: var(--accent-hover);
    }
    html[data-theme="light"] .md-content code { color: var(--accent); }
    .code-block {
      margin: 14px 0;
      border-radius: 10px;
      overflow: hidden;
      border: 1px solid rgba(255,255,255,0.1);
      background: var(--code-bg);
    }
    .code-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 12px;
      background: rgba(255,255,255,0.05);
      font-size: 0.74rem;
      color: #94a3b8;
    }
    .copy-inline-btn {
      background: rgba(255,255,255,0.1);
      border: 0;
      color: #e2e8f0;
      border-radius: 5px;
      padding: 3px 8px;
      font-size: 0.72rem;
      cursor: pointer;
    }
    .copy-inline-btn:hover { background: rgba(255,255,255,0.2); }
    .code-block pre {
      margin: 0;
      padding: 14px;
      overflow-x: auto;
    }
    .code-block pre code {
      background: transparent !important;
      color: #e2e8f0 !important;
      padding: 0;
      font-size: 0.83rem;
    }
    .table-wrap { overflow-x: auto; margin: 14px 0; }
    .md-content table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.87rem;
    }
    .md-content th, .md-content td {
      border: 1px solid var(--border-strong);
      padding: 8px 11px;
      text-align: left;
    }
    .md-content th { background: var(--bg-card); color: var(--text); }
    .md-content blockquote {
      margin: 14px 0;
      padding: 10px 16px;
      border-left: 3px solid var(--accent);
      background: var(--accent-soft);
      border-radius: 0 8px 8px 0;
    }

    .raw-box {
      width: 100%;
      min-height: 460px;
      background: var(--code-bg);
      color: #e2e8f0;
      border: 1px solid var(--border-strong);
      border-radius: 10px;
      padding: 16px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.82rem;
      line-height: 1.5;
      white-space: pre-wrap;
    }

    .toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 80;
      background: var(--success);
      color: #fff;
      padding: 10px 16px;
      border-radius: 10px;
      font-size: 0.86rem;
      font-weight: 600;
      box-shadow: var(--shadow);
      opacity: 0;
      transform: translateY(10px);
      pointer-events: none;
      transition: all 0.2s ease;
    }
    .toast.show { opacity: 1; transform: translateY(0); }

    @media (max-width: 760px) {
      .topbar-inner { height: auto; padding: 12px 0; flex-wrap: wrap; }
      .runbook-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="container topbar-inner">
      <div class="brand" id="brandHome">
        <div class="brand-logo">🎭</div>
        <span>The Agency</span>
      </div>

      <nav class="nav-tabs" aria-label="Catalog views">
        <button type="button" class="nav-tab active" data-view="agents">
          Specialists <span class="nav-badge" id="navAgentsCount">${catalog.stats.totalAgents}</span>
        </button>
        <button type="button" class="nav-tab" data-view="runbooks">
          NEXUS Runbooks <span class="nav-badge">${catalog.stats.totalRunbooks}</span>
        </button>
        <button type="button" class="nav-tab" data-view="tools">
          Tool Integrations <span class="nav-badge">${catalog.stats.totalTools}</span>
        </button>
      </nav>

      <div class="topbar-actions">
        <button type="button" class="btn btn-sm" id="themeToggle" title="Toggle dark/light theme">☀️ / 🌙</button>
        <a class="btn btn-sm" id="repoLink" href="${escapeHtml(repoUrl)}" target="_blank" rel="noopener noreferrer">GitHub ↗</a>
      </div>
    </div>
  </header>

  <main class="container">
    <section class="hero">
      <div class="hero-pill">
        <span>✨ ${catalog.stats.totalAgents} AI Specialists</span> ·
        <span>${catalog.stats.totalDivisions} Divisions</span> ·
        <span>${catalog.stats.totalTools} Coding Tools</span>
      </div>
      <h1>Assemble Your Dream AI Specialist Team</h1>
      <p>Personality-driven, deliverable-focused AI agent definitions ready for Claude Code, Antigravity, Cursor, Codex, Gemini CLI, Copilot, Windsurf, and more.</p>
    </section>

    <!-- AGENTS VIEW -->
    <section id="view-agents">
      <div class="controls-bar">
        <div class="search-wrap">
          <span class="search-icon">🔍</span>
          <input
            type="search"
            id="searchInput"
            class="search-input"
            placeholder="Search ${catalog.stats.totalAgents} specialists by role, skill, stack, or division..."
            autocomplete="off"
          />
          <span class="search-kbd">/</span>
        </div>

        <div class="tool-picker-wrap">
          <span>Target CLI:</span>
          <select id="globalToolSelect" class="tool-select" aria-label="Target AI coding tool"></select>
        </div>
      </div>

      <div class="divisions-strip" id="divisionsStrip"></div>

      <div class="results-bar">
        <span id="resultsSummary">Loading specialists...</span>
        <span style="font-size:0.8rem;">Tip: click <strong>+</strong> on cards to build a multi-agent install command</span>
      </div>

      <div class="agent-grid" id="agentGrid"></div>
    </section>

    <!-- RUNBOOKS VIEW -->
    <section id="view-runbooks" style="display:none;">
      <div class="results-bar">
        <span>Pre-assembled multi-agent NEXUS scenario rosters with phased activation</span>
      </div>
      <div class="runbook-grid" id="runbookGrid"></div>
    </section>

    <!-- TOOLS VIEW -->
    <section id="view-tools" style="display:none;">
      <div class="results-bar">
        <span>Supported AI coding assistants &amp; agent harnesses (${catalog.stats.totalTools} native converters)</span>
      </div>
      <div class="tools-grid" id="toolsGrid"></div>
    </section>
  </main>

  <!-- Floating Team Builder Bar -->
  <div class="team-bar" id="teamBar">
    <div>
      <strong id="teamCountLabel">0 selected</strong>
    </div>
    <div class="team-cmd-preview" id="teamCmdPreview"></div>
    <button type="button" class="btn btn-primary btn-sm" id="copyTeamCmdBtn">Copy Install Command</button>
    <button type="button" class="btn btn-sm" id="clearTeamBtn">Clear</button>
  </div>

  <!-- Slide-over Inspector Drawer -->
  <div class="drawer-backdrop" id="drawerBackdrop">
    <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawerTitle">
      <div class="drawer-header">
        <div style="display:flex; gap:14px; align-items:flex-start;">
          <div class="agent-avatar" id="drawerEmoji" style="width:48px;height:48px;font-size:1.6rem;">🤖</div>
          <div>
            <div id="drawerBadges" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px;"></div>
            <h2 id="drawerTitle" style="margin:0;font-size:1.35rem;">Agent Name</h2>
            <p id="drawerSub" style="margin:4px 0 0;font-size:0.88rem;color:var(--text-muted);"></p>
          </div>
        </div>
        <button type="button" class="btn btn-sm" id="closeDrawerBtn">✕ Esc</button>
      </div>

      <div class="drawer-tabs">
        <div style="display:flex;gap:6px;" id="drawerModeTabs">
          <button type="button" class="btn btn-sm btn-primary" data-dtab="rendered">Rendered Spec</button>
          <button type="button" class="btn btn-sm" data-dtab="raw">Raw Markdown</button>
          <button type="button" class="btn btn-sm" data-dtab="install">Install CLI</button>
        </div>
        <div style="display:flex;gap:8px;" id="drawerQuickActions"></div>
      </div>

      <div class="drawer-body" id="drawerBody"></div>
    </aside>
  </div>

  <div class="toast" id="toast">Copied to clipboard!</div>

  <script>
    const state = {
      catalog: null,
      view: 'agents',
      division: 'all',
      query: '',
      tool: localStorage.getItem('aa_tool') || 'claude-code',
      selectedSlugs: new Set(),
      activeItem: null,
      drawerTab: 'rendered',
      cacheAgents: new Map(),
      cacheRunbooks: new Map(),
    };

    const el = (id) => document.getElementById(id);

    function showToast(msg) {
      const t = el('toast');
      t.textContent = msg;
      t.classList.add('show');
      clearTimeout(showToast._timer);
      showToast._timer = setTimeout(() => t.classList.remove('show'), 2100);
    }

    async function copyText(text, label = 'Copied to clipboard!') {
      try {
        await navigator.clipboard.writeText(text);
        showToast(label);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        showToast(label);
      }
    }

    function escapeHtmlClient(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function setView(view) {
      state.view = view;
      document.querySelectorAll('.nav-tab').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.view === view);
      });
      el('view-agents').style.display = view === 'agents' ? '' : 'none';
      el('view-runbooks').style.display = view === 'runbooks' ? '' : 'none';
      el('view-tools').style.display = view === 'tools' ? '' : 'none';
    }

    function buildInstallCmd(slugs, tool = state.tool) {
      return \`./scripts/install.sh --tool \${tool} --agent \${slugs.join(',')}\`;
    }

    function updateTeamBar() {
      const bar = el('teamBar');
      const slugs = Array.from(state.selectedSlugs);
      if (slugs.length === 0) {
        bar.classList.remove('visible');
        return;
      }
      bar.classList.add('visible');
      el('teamCountLabel').textContent = \`\${slugs.length} agent\${slugs.length > 1 ? 's' : ''} in team\`;
      el('teamCmdPreview').textContent = buildInstallCmd(slugs);
    }

    function renderDivisions() {
      const strip = el('divisionsStrip');
      const total = state.catalog.stats.totalAgents;
      const chips = [
        \`<button type="button" class="div-chip \${state.division === 'all' ? 'active' : ''}" data-div="all">
          <span class="div-dot" style="background:#6366f1"></span>
          All Divisions <span class="div-count">\${total}</span>
        </button>\`
      ];
      for (const d of state.catalog.divisions) {
        chips.push(\`
          <button type="button" class="div-chip \${state.division === d.key ? 'active' : ''}" data-div="\${d.key}" style="--chip-color:\${d.color}">
            <span class="div-dot" style="background:\${d.color}"></span>
            \${escapeHtmlClient(d.label)} <span class="div-count">\${d.count}</span>
          </button>
        \`);
      }
      strip.innerHTML = chips.join('');
      strip.querySelectorAll('.div-chip').forEach((btn) => {
        btn.addEventListener('click', () => {
          state.division = btn.dataset.div;
          renderDivisions();
          renderAgents();
        });
      });
    }

    function renderAgents() {
      const q = state.query.trim().toLowerCase();
      const filtered = state.catalog.agents.filter((a) => {
        if (state.division !== 'all' && a.division !== state.division) return false;
        if (!q) return true;
        const hay = \`\${a.name} \${a.slug} \${a.divisionLabel} \${a.subCategory || ''} \${a.vibe} \${a.description} \${(a.headings || []).join(' ')}\`.toLowerCase();
        return hay.includes(q);
      });

      el('resultsSummary').textContent = \`Showing \${filtered.length} of \${state.catalog.stats.totalAgents} specialists\`;

      const grid = el('agentGrid');
      if (filtered.length === 0) {
        grid.innerHTML = \`<div style="grid-column:1/-1;text-align:center;padding:48px;color:var(--text-muted);background:var(--bg-card);border-radius:14px;border:1px solid var(--border);">
          No specialists matched "<strong>\${escapeHtmlClient(state.query)}</strong>". Try clearing filters.
        </div>\`;
        return;
      }

      grid.innerHTML = filtered.map((a) => {
        const isSel = state.selectedSlugs.has(a.slug);
        return \`
          <article class="agent-card \${isSel ? 'selected' : ''}" data-slug="\${a.slug}" style="--div-color:\${a.divisionColor}">
            <div>
              <div class="card-top">
                <div class="agent-avatar">\${escapeHtmlClient(a.emoji)}</div>
                <div class="card-badges">
                  <span class="div-badge">\${escapeHtmlClient(a.divisionLabel)}\${a.subCategory ? ' · ' + escapeHtmlClient(a.subCategory) : ''}</span>
                  <button type="button" class="select-check" data-toggle-slug="\${a.slug}" title="Add/remove from team command">\${isSel ? '✓' : '+'}</button>
                </div>
              </div>
              <h3 class="agent-title">\${escapeHtmlClient(a.name)}</h3>
              \${a.vibe ? \`<p class="agent-vibe">"\${escapeHtmlClient(a.vibe)}"</p>\` : ''}
              <p class="agent-desc">\${escapeHtmlClient(a.description)}</p>
            </div>
            <div class="card-footer">
              <span class="slug-mono">\${escapeHtmlClient(a.slug)}</span>
              <span style="color:var(--accent-hover);font-weight:600;">Inspect →</span>
            </div>
          </article>
        \`;
      }).join('');

      grid.querySelectorAll('[data-toggle-slug]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const slug = btn.dataset.toggleSlug;
          if (state.selectedSlugs.has(slug)) state.selectedSlugs.delete(slug);
          else state.selectedSlugs.add(slug);
          updateTeamBar();
          renderAgents();
        });
      });

      grid.querySelectorAll('.agent-card').forEach((card) => {
        card.addEventListener('click', () => {
          location.hash = \`agent/\${card.dataset.slug}\`;
        });
      });
    }

    function renderRunbooks() {
      const grid = el('runbookGrid');
      grid.innerHTML = state.catalog.runbooks.map((rb) => \`
        <article class="runbook-card" data-rb="\${rb.slug}">
          <div>
            <div class="rb-meta">
              <span class="rb-pill">\${escapeHtmlClient(rb.mode)}</span>
              <span class="rb-pill">⏱ \${escapeHtmlClient(rb.duration)}</span>
              <span class="rb-pill">👥 \${rb.agentCount} Specialists</span>
            </div>
            <h3 style="margin:10px 0 6px;font-size:1.2rem;">\${escapeHtmlClient(rb.title)}</h3>
            <p style="margin:0;color:var(--text-muted);font-size:0.9rem;">\${escapeHtmlClient(rb.summary)}</p>
          </div>
          <div class="rb-groups">
            \${rb.roster.map((g) => \`
              <div class="rb-group">
                <div class="rb-group-header">
                  <span>\${escapeHtmlClient(g.group)}</span>
                  <span>\${escapeHtmlClient(g.activation)}</span>
                </div>
                <div class="rb-chips">
                  \${g.agents.slice(0, 6).map((ag) => \`<span class="rb-agent-chip">\${escapeHtmlClient(ag.emoji)} \${escapeHtmlClient(ag.name)}</span>\`).join('')}
                  \${g.agents.length > 6 ? \`<span class="rb-agent-chip">+\${g.agents.length - 6} more</span>\` : ''}
                </div>
              </div>
            \`).join('')}
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;padding-top:8px;border-top:1px solid var(--border);font-size:0.83rem;">
            <button type="button" class="btn btn-sm" data-rb-copy="\${rb.slug}">Copy Team Install CLI</button>
            <span style="color:var(--accent-hover);font-weight:600;">Open Playbook →</span>
          </div>
        </article>
      \`).join('');

      grid.querySelectorAll('[data-rb-copy]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const rb = state.catalog.runbooks.find((r) => r.slug === btn.dataset.rbCopy);
          if (rb) copyText(buildInstallCmd(rb.allSlugs), \`Copied \${rb.title} team install command!\`);
        });
      });

      grid.querySelectorAll('.runbook-card').forEach((card) => {
        card.addEventListener('click', () => {
          location.hash = \`runbook/\${card.dataset.rb}\`;
        });
      });
    }

    function renderTools() {
      const grid = el('toolsGrid');
      grid.innerHTML = state.catalog.tools.map((t) => {
        const cmd = \`./scripts/install.sh --tool \${t.kebab}\`;
        const paths = [...(t.dest.project || []), ...(t.dest.user || [])].slice(0, 2);
        return \`
          <div class="tool-card">
            <div class="tool-header">
              <div class="tool-title">
                <span class="div-dot" style="width:11px;height:11px;background:\${t.accent}"></span>
                <span>\${escapeHtmlClient(t.label)}</span>
              </div>
              <span class="div-badge" style="--div-color:\${t.accent}">\${escapeHtmlClient(t.installKind)}</span>
            </div>
            <div style="font-size:0.82rem;color:var(--text-muted);">
              Format: <code>\${escapeHtmlClient(t.format)}</code>
              \${paths.length ? \`<br/>Target: <code>\${escapeHtmlClient(paths[0])}</code>\` : ''}
            </div>
            <div class="tool-cmd">
              <span>\${escapeHtmlClient(cmd)}</span>
              <button type="button" class="copy-inline-btn" data-copy-cmd="\${escapeHtmlClient(cmd)}">Copy</button>
            </div>
          </div>
        \`;
      }).join('');

      grid.querySelectorAll('[data-copy-cmd]').forEach((btn) => {
        btn.addEventListener('click', () => copyText(btn.dataset.copyCmd, 'Install command copied!'));
      });
    }

    function bindCodeCopyButtons(container) {
      container.querySelectorAll('[data-copy-code]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const code = btn.closest('.code-block')?.querySelector('pre code')?.textContent || '';
          copyText(code, 'Code snippet copied!');
        });
      });
    }

    async function openAgentDrawer(slug) {
      let agent = state.cacheAgents.get(slug);
      if (!agent) {
        const res = await fetch(\`/api/agents/\${encodeURIComponent(slug)}.json\`);
        if (!res.ok) return;
        agent = await res.json();
        state.cacheAgents.set(slug, agent);
      }
      state.activeItem = { type: 'agent', data: agent };
      state.drawerTab = 'rendered';
      renderDrawer();
      el('drawerBackdrop').classList.add('open');
      document.body.style.overflow = 'hidden';
    }

    async function openRunbookDrawer(slug) {
      let rb = state.cacheRunbooks.get(slug);
      if (!rb) {
        const res = await fetch(\`/api/runbooks/\${encodeURIComponent(slug)}.json\`);
        if (!res.ok) return;
        rb = await res.json();
        state.cacheRunbooks.set(slug, rb);
      }
      state.activeItem = { type: 'runbook', data: rb };
      state.drawerTab = 'rendered';
      renderDrawer();
      el('drawerBackdrop').classList.add('open');
      document.body.style.overflow = 'hidden';
    }

    function renderDrawer() {
      if (!state.activeItem) return;
      const { type, data } = state.activeItem;
      const body = el('drawerBody');
      const actions = el('drawerQuickActions');

      document.querySelectorAll('#drawerModeTabs [data-dtab]').forEach((b) => {
        b.classList.toggle('btn-primary', b.dataset.dtab === state.drawerTab);
      });

      if (type === 'agent') {
        el('drawerEmoji').textContent = data.emoji || '🤖';
        el('drawerEmoji').style.setProperty('--div-color', data.divisionColor);
        el('drawerBadges').innerHTML = \`
          <span class="div-badge" style="--div-color:\${data.divisionColor}">\${escapeHtmlClient(data.divisionLabel)}</span>
          <span class="div-badge" style="--div-color:#64748b">\${escapeHtmlClient(data.path)}</span>
        \`;
        el('drawerTitle').textContent = data.name;
        el('drawerSub').textContent = data.vibe || data.description;

        actions.innerHTML = \`
          <button type="button" class="btn btn-sm btn-primary" id="copyPromptBtn">Copy System Prompt</button>
          <a class="btn btn-sm" href="/raw/\${encodeURI(data.path)}" download>Download .md</a>
        \`;
        el('copyPromptBtn').onclick = () => copyText(data.bodyMarkdown, 'System prompt copied!');

        if (state.drawerTab === 'rendered') {
          body.innerHTML = \`<div class="md-content">\${data.html}</div>\`;
          bindCodeCopyButtons(body);
        } else if (state.drawerTab === 'raw') {
          body.innerHTML = \`<div class="raw-box">\${escapeHtmlClient(data.rawMarkdown)}</div>\`;
        } else {
          body.innerHTML = \`
            <div style="display:flex;flex-direction:column;gap:12px;">
              <p style="margin:0;color:var(--text-muted);font-size:0.9rem;">Run from a cloned repository root to install <strong>\${escapeHtmlClient(data.name)}</strong> into any supported AI tool:</p>
              \${state.catalog.tools.map((t) => {
                const cmd = buildInstallCmd([data.slug], t.kebab);
                return \`
                  <div class="tool-cmd">
                    <span><strong style="color:\${t.accent}">[\${escapeHtmlClient(t.short)}]</strong> \${escapeHtmlClient(cmd)}</span>
                    <button type="button" class="copy-inline-btn" data-copy-cmd="\${escapeHtmlClient(cmd)}">Copy</button>
                  </div>
                \`;
              }).join('')}
            </div>
          \`;
          body.querySelectorAll('[data-copy-cmd]').forEach((b) => {
            b.addEventListener('click', () => copyText(b.dataset.copyCmd, 'Install command copied!'));
          });
        }
      } else {
        el('drawerEmoji').textContent = '📋';
        el('drawerBadges').innerHTML = \`
          <span class="rb-pill">\${escapeHtmlClient(data.mode)}</span>
          <span class="rb-pill">⏱ \${escapeHtmlClient(data.duration)}</span>
          <span class="rb-pill">👥 \${data.agentCount} Specialists</span>
        \`;
        el('drawerTitle').textContent = data.title;
        el('drawerSub').textContent = data.summary;

        actions.innerHTML = \`
          <button type="button" class="btn btn-sm btn-primary" id="copyRbAllBtn">Copy Team CLI (\${data.agentCount})</button>
        \`;
        el('copyRbAllBtn').onclick = () => copyText(buildInstallCmd(data.allSlugs), 'Runbook team CLI copied!');

        if (state.drawerTab === 'rendered') {
          const rosterHtml = data.roster.map((g) => \`
            <div class="rb-group" style="margin-bottom:12px;">
              <div class="rb-group-header">
                <span>\${escapeHtmlClient(g.group)}</span>
                <span>Activation: \${escapeHtmlClient(g.activation)}</span>
              </div>
              <div class="rb-chips">
                \${g.agents.map((ag) => \`
                  <a href="#agent/\${encodeURIComponent(ag.slug)}" class="rb-agent-chip" style="text-decoration:none;">
                    \${escapeHtmlClient(ag.emoji)} \${escapeHtmlClient(ag.name)}
                  </a>
                \`).join('')}
              </div>
            </div>
          \`).join('');
          body.innerHTML = \`
            <div style="margin-bottom:24px;">\${rosterHtml}</div>
            <div class="md-content">\${data.html}</div>
          \`;
          bindCodeCopyButtons(body);
        } else if (state.drawerTab === 'raw') {
          body.innerHTML = \`<div class="raw-box">\${escapeHtmlClient(data.rawMarkdown)}</div>\`;
        } else {
          body.innerHTML = \`
            <div style="display:flex;flex-direction:column;gap:12px;">
              \${state.catalog.tools.map((t) => {
                const cmd = buildInstallCmd(data.allSlugs, t.kebab);
                return \`
                  <div class="tool-cmd">
                    <span><strong style="color:\${t.accent}">[\${escapeHtmlClient(t.short)}]</strong> \${escapeHtmlClient(cmd)}</span>
                    <button type="button" class="copy-inline-btn" data-copy-cmd="\${escapeHtmlClient(cmd)}">Copy</button>
                  </div>
                \`;
              }).join('')}
            </div>
          \`;
          body.querySelectorAll('[data-copy-cmd]').forEach((b) => {
            b.addEventListener('click', () => copyText(b.dataset.copyCmd, 'Team install command copied!'));
          });
        }
      }
    }

    function closeDrawer() {
      el('drawerBackdrop').classList.remove('open');
      document.body.style.overflow = '';
      state.activeItem = null;
      if (location.hash.startsWith('#agent/') || location.hash.startsWith('#runbook/')) {
        history.replaceState(null, '', location.pathname + location.search);
      }
    }

    function handleHash() {
      const hash = decodeURIComponent(location.hash.replace(/^#/, ''));
      if (hash.startsWith('agent/')) {
        openAgentDrawer(hash.slice('agent/'.length));
      } else if (hash.startsWith('runbook/')) {
        openRunbookDrawer(hash.slice('runbook/'.length));
      } else if (hash === 'runbooks') {
        closeDrawer();
        setView('runbooks');
      } else if (hash === 'tools') {
        closeDrawer();
        setView('tools');
      } else {
        closeDrawer();
      }
    }

    async function init() {
      const savedTheme = localStorage.getItem('aa_theme');
      if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);

      const res = await fetch('/api/catalog.json');
      state.catalog = await res.json();

      // Populate tool selector
      const sel = el('globalToolSelect');
      sel.innerHTML = state.catalog.tools
        .map((t) => \`<option value="\${t.kebab}" \${t.kebab === state.tool ? 'selected' : ''}>\${escapeHtmlClient(t.label)}</option>\`)
        .join('');
      sel.addEventListener('change', () => {
        state.tool = sel.value;
        localStorage.setItem('aa_tool', state.tool);
        updateTeamBar();
      });

      renderDivisions();
      renderAgents();
      renderRunbooks();
      renderTools();

      // Events
      el('searchInput').addEventListener('input', (e) => {
        state.query = e.target.value;
        renderAgents();
      });

      document.addEventListener('keydown', (e) => {
        if (e.key === '/' && document.activeElement !== el('searchInput')) {
          e.preventDefault();
          setView('agents');
          el('searchInput').focus();
        } else if (e.key === 'Escape') {
          closeDrawer();
        }
      });

      document.querySelectorAll('.nav-tab').forEach((btn) => {
        btn.addEventListener('click', () => setView(btn.dataset.view));
      });

      el('brandHome').addEventListener('click', () => {
        state.division = 'all';
        state.query = '';
        el('searchInput').value = '';
        setView('agents');
        renderDivisions();
        renderAgents();
      });

      el('themeToggle').addEventListener('click', () => {
        const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', cur);
        localStorage.setItem('aa_theme', cur);
      });

      el('closeDrawerBtn').addEventListener('click', closeDrawer);
      el('drawerBackdrop').addEventListener('click', (e) => {
        if (e.target === el('drawerBackdrop')) closeDrawer();
      });

      document.querySelectorAll('#drawerModeTabs [data-dtab]').forEach((btn) => {
        btn.addEventListener('click', () => {
          state.drawerTab = btn.dataset.dtab;
          renderDrawer();
        });
      });

      el('copyTeamCmdBtn').addEventListener('click', () => {
        copyText(buildInstallCmd(Array.from(state.selectedSlugs)), 'Team install command copied!');
      });
      el('clearTeamBtn').addEventListener('click', () => {
        state.selectedSlugs.clear();
        updateTeamBar();
        renderAgents();
      });

      window.addEventListener('hashchange', handleHash);
      handleHash();
    }

    init();
  </script>
</body>
</html>
`;

fs.writeFileSync(path.join(OUT, 'index.html'), indexHtml, 'utf8');
console.log(
  `Built web catalog -> public/ (${catalog.stats.totalAgents} agents, ${catalog.stats.totalDivisions} divisions, ${catalog.stats.totalRunbooks} runbooks, ${catalog.stats.totalTools} tools)`
);
