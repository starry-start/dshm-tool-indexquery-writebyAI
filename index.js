/**
 * dshm-tool-indexquery — 本地教材页级索引检索（DSH 宿主插件，只读、离线）。
 *
 * 背景：DeepSeek Harness（DSH）在 DSHM 端侧。本插件的用途是把「索引/页」目录里
 * 已经建好的页级索引（SQLite FTS5 缓存或 JSONL）暴露成两个模型可见工具：
 *   - index_query(keyword, book_id?, limit?, context_chars?)：检索命中页并只回命中段落；
 *   - index_page(book_id, pages)：按 PDF 页范围回读整页（有单页字数上限）。
 * 目的：替代「python 脚本 + 整页打印」的检索路径，减少工具调用次数与 token 消耗。
 *
 * 数据边界（重要）：
 *   - 只读用户本机已存在的 `索 引/页` 目录与 `页索引.db`；插件本身不携带任何教材/指南正文；
 *   - 不联网、无遥测、不上传任何内容；
 *   - 输出只用于检索定位，正式引用前必须回原文核对（AI 生成代码，见 LICENSE 与 README 免责声明）。
 *
 * 兼容性：宿主 Node v24（内置 node:sqlite，无需原生 .node 模块）。
 *   node:sqlite 不可用或缓存缺失时自动退回 JSONL 扫描；两路输出字段一致。
 *
 * 插件形态：cordis 宿主插件。导出 name / inject / apply。
 * 依赖注入：ctx.tools（注册工具）。不 import 任何 @deepseek-ai/* 包 ——
 *   profile 目录安装的插件解析不到核心树包，因此直接构造 registry-ready 的原始工具定义。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 插件名（与 package.json 一致，profile patch 行按它解析包名）。 */
export const name = 'dshm-tool-indexquery';

/** 只依赖 tools 服务：apply 内第一句就是 ctx.tools.register。 */
export const inject = ['tools'];

const JSONL_SUFFIX = '.jsonl';
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const DEFAULT_CONTEXT = 100;
const MAX_CONTEXT = 400;
const MAX_SEGMENTS = 3;
const DB_FETCH_CAP = 400;
const MAX_PAGE_CHARS = 4000;
const MAX_RANGE_PAGES = 10;

/** 归一化 patch 行里的 config；空值保持空串，交给工具执行期报可行动错误。 */
function normalizeConfig(config) {
  const raw = config && typeof config === 'object' ? config : {};
  return {
    indexDir: typeof raw.indexDir === 'string' ? raw.indexDir.trim() : '',
    dbPath: typeof raw.dbPath === 'string' ? raw.dbPath.trim() : '',
  };
}

function requireIndexDir(cfg) {
  if (!cfg.indexDir) {
    throw new Error(
      'index_query 未配置：请在 profile patch 的 config.indexDir 填入 索引/页 目录（例如 /storage/Users/currentUser/deepseekstation/doctorplace/索引/页）',
    );
  }
  return cfg.indexDir;
}

function resolveDbPath(cfg) {
  return cfg.dbPath || join(dirname(requireIndexDir(cfg)), '页索引.db');
}

/** 书目.json → book_id→edition 映射（带 mtime 缓存，缺失时返回空表）。 */
let editionCache = null;
function loadEditionMap(cfg) {
  let file;
  try {
    file = join(dirname(requireIndexDir(cfg)), '书目.json');
    const st = statSync(file);
    if (editionCache && editionCache.file === file && editionCache.mtimeMs === st.mtimeMs) {
      return editionCache.map;
    }
    const list = JSON.parse(readFileSync(file, 'utf8'));
    const map = new Map();
    for (const book of Array.isArray(list) ? list : []) {
      if (book && typeof book.book_id === 'string') {
        map.set(book.book_id, typeof book.edition === 'string' ? book.edition : '');
      }
    }
    editionCache = { file, mtimeMs: st.mtimeMs, map };
    return map;
  } catch {
    return new Map();
  }
}

function clamp(value, lo, hi, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

function countOccurrences(lowText, lowTerm) {
  if (!lowTerm) return 0;
  let count = 0;
  let at = 0;
  while (true) {
    const i = lowText.indexOf(lowTerm, at);
    if (i < 0) return count;
    count += 1;
    at = i + lowTerm.length;
  }
}

/** 命中词前后各 width 字，相邻区间合并、单段封顶、最多 MAX_SEGMENTS 段。 */
function contextSegments(text, term, width) {
  const t = String(text || '').replace(/\n/g, ' ');
  const low = t.toLowerCase();
  const needle = String(term || '').toLowerCase();
  const spans = [];
  if (needle) {
    let at = 0;
    while (true) {
      const i = low.indexOf(needle, at);
      if (i < 0) break;
      spans.push([Math.max(0, i - width), Math.min(t.length, i + needle.length + width)]);
      at = i + 1;
    }
  }
  if (spans.length === 0) return [t.slice(0, width * 2)];
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const maxLen = 2 * width + needle.length;
  const merged = [];
  for (const [lo0, hi0] of spans) {
    let lo = lo0;
    let hi = hi0;
    if (merged.length > 0 && lo < merged[merged.length - 1][1]) {
      lo = merged[merged.length - 1][1];
      if (lo >= hi) continue;
    }
    if (merged.length > 0 && lo <= merged[merged.length - 1][1] + width && hi - merged[merged.length - 1][0] <= maxLen) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], hi);
    } else {
      merged.push([lo, hi]);
    }
  }
  return merged.slice(0, MAX_SEGMENTS).map(
    ([lo, hi]) => (lo > 0 ? '…' : '') + t.slice(lo, hi) + (hi < t.length ? '…' : ''),
  );
}

function sortHits(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const byBook = String(a.book_id).localeCompare(String(b.book_id));
  if (byBook !== 0) return byBook;
  return a.pdf_page - b.pdf_page;
}

function buildHit(score, row, editionMap, width) {
  const bookPage = Number.isFinite(row.book_page) ? row.book_page : 0;
  return {
    book_id: String(row.book_id || ''),
    title: String(row.title || ''),
    edition: String(editionMap.get(row.book_id) || ''),
    pdf_page: Number(row.pdf_page) || 0,
    book_page: Number.isFinite(bookPage) ? bookPage : 0,
    score,
    segments: contextSegments(row.text, row.keyword, width),
  };
}

async function openDb(cfg) {
  const dbPath = resolveDbPath(cfg);
  if (!existsSync(dbPath)) return null;
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return null;
  }
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA query_only = ON');
    return db;
  } catch {
    try {
      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA query_only = ON');
      return db;
    } catch {
      return null;
    }
  }
}

function queryDb(db, cfg, keyword, bookId, limit, width) {
  const conditions = ['toc = 0'];
  const params = [];
  if (bookId) {
    conditions.push('book_id = ?');
    params.push(bookId);
  }
  const useFts = Array.from(keyword).length >= 3;
  const matchWhere = useFts
    ? 'id IN (SELECT rowid FROM pages_fts WHERE pages_fts MATCH ?)'
    : 'text LIKE ?';
  const matchParam = useFts ? '"' + keyword.replace(/"/g, '""') + '"' : '%' + keyword + '%';
  const where = [...conditions, matchWhere].join(' AND ');
  const total = db
    .prepare('SELECT COUNT(*) AS n FROM pages WHERE ' + where)
    .get(...params, matchParam).n;
  const rows = db
    .prepare(
      'SELECT book_id,title,pdf_page,book_page,text FROM pages WHERE ' + where + ' LIMIT ' + DB_FETCH_CAP,
    )
    .all(...params, matchParam);
  const editionMap = loadEditionMap(cfg);
  const lowKeyword = keyword.toLowerCase();
  const hits = rows.map((row) =>
    buildHit(countOccurrences(String(row.text || '').toLowerCase(), lowKeyword), { ...row, keyword }, editionMap, width),
  );
  hits.sort(sortHits);
  return {
    keyword,
    source: 'db',
    total_pages: Number(total) || 0,
    returned: Math.min(limit, hits.length),
    note: Number(total) > DB_FETCH_CAP ? '已截断：仅在前 ' + DB_FETCH_CAP + ' 个命中页内排序' : '',
    hits: hits.slice(0, limit),
  };
}

function queryJsonl(cfg, keyword, bookId, limit, width) {
  const dir = requireIndexDir(cfg);
  const editionMap = loadEditionMap(cfg);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(JSONL_SUFFIX))
    .filter((f) => !bookId || f.slice(0, -JSONL_SUFFIX.length) === bookId);
  const lowKeyword = keyword.toLowerCase();
  const top = [];
  let total = 0;
  const order = (a, b) =>
    b.score - a.score ||
    String(a.row.book_id).localeCompare(String(b.row.book_id)) ||
    (Number(a.row.pdf_page) || 0) - (Number(b.row.pdf_page) || 0);
  for (const file of files) {
    let content;
    try {
      content = readFileSync(join(dir, file), 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (line.trim().length === 0) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (!rec || rec.toc) continue;
      const text = typeof rec.text === 'string' ? rec.text : '';
      const score = countOccurrences(text.toLowerCase(), lowKeyword);
      if (score === 0) continue;
      total += 1;
      const candidate = { score, row: { ...rec, text, keyword } };
      if (top.length < limit) {
        top.push(candidate);
        top.sort(order);
      } else if (order(candidate, top[top.length - 1]) < 0) {
        top[top.length - 1] = candidate;
        top.sort(order);
      }
    }
  }
  const hits = top.map((c) => buildHit(c.score, c.row, editionMap, width));
  return {
    keyword,
    source: 'jsonl',
    total_pages: total,
    returned: Math.min(limit, hits.length),
    note: '',
    hits,
  };
}

function parsePageRanges(spec) {
  const ranges = [];
  for (const part of String(spec || '').split(/[,，;；]/)) {
    const text = part.trim();
    if (!text) continue;
    const m = /^(\d+)(?:\s*[-—~]\s*(\d+))?$/.exec(text);
    if (!m) throw new Error('pages 格式无效：写 57 或 57-58（逗号分隔多段）');
    const lo = Number(m[1]);
    const hi = Number(m[2] || m[1]);
    if (lo < 1 || hi < lo) throw new Error('pages 范围无效：' + text);
    ranges.push([lo, hi]);
  }
  if (ranges.length === 0) throw new Error('pages 不能为空');
  const count = ranges.reduce((sum, [lo, hi]) => sum + (hi - lo + 1), 0);
  if (count > MAX_RANGE_PAGES) throw new Error('单次最多回读 ' + MAX_RANGE_PAGES + ' 页，请缩小范围');
  return ranges;
}

function clipPageText(text) {
  const t = String(text || '').replace(/\n/g, ' ');
  if (t.length <= MAX_PAGE_CHARS) return { text: t, truncated: false };
  return { text: t.slice(0, MAX_PAGE_CHARS) + '……[已截断]', truncated: true };
}

async function pageRead(args, cfg) {
  const bookId = typeof args.book_id === 'string' ? args.book_id.trim() : '';
  if (!bookId) throw new Error('book_id 不能为空（见 索引/书目.md）');
  const ranges = parsePageRanges(args.pages);
  const eMap = loadEditionMap(cfg);
  const collected = [];
  let usedDb = false;
  const db = await openDb(cfg);
  if (db) {
    usedDb = true;
    try {
      const stmt = db.prepare(
        'SELECT book_id,title,pdf_page,book_page,text FROM pages WHERE book_id = ? AND pdf_page BETWEEN ? AND ? ORDER BY pdf_page',
      );
      for (const [lo, hi] of ranges) {
        for (const row of stmt.all(bookId, lo, hi)) collected.push(row);
      }
    } finally {
      try {
        db.close();
      } catch {
        /* 忽略关闭失败 */
      }
    }
  }
  const collectFromFile = (fp) => {
    let content;
    try {
      content = readFileSync(fp, 'utf8');
    } catch {
      return;
    }
    for (const line of content.split('\n')) {
      if (line.trim().length === 0) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (!rec || rec.book_id !== bookId) continue;
      if (!ranges.some(([lo, hi]) => rec.pdf_page >= lo && rec.pdf_page <= hi)) continue;
      collected.push(rec);
    }
  };
  if (!usedDb) {
    const dir = requireIndexDir(cfg);
    const exact = join(dir, bookId + JSONL_SUFFIX);
    const files = existsSync(exact) ? [exact] : readdirSync(dir).filter((f) => f.endsWith(JSONL_SUFFIX));
    for (const fp of files) collectFromFile(fp);
  } else if (collected.length === 0) {
    /* 缓存里没有这本书 / 这些页时，退一步读 JSONL 单文件 */
    const exact = join(requireIndexDir(cfg), bookId + JSONL_SUFFIX);
    if (existsSync(exact)) collectFromFile(exact);
  }
  collected.sort((a, b) => a.pdf_page - b.pdf_page);
  const pages = collected.map((row) => {
    const clip = clipPageText(row.text);
    return {
      pdf_page: Number(row.pdf_page) || 0,
      book_page: Number.isFinite(row.book_page) ? Number(row.book_page) : 0,
      truncated: clip.truncated,
      text: clip.text,
    };
  });
  return {
    book_id: bookId,
    edition: String(eMap.get(bookId) || ''),
    returned: pages.length,
    note: pages.length === 0 ? '该 book_id 在给定页码范围内无内容（检查 book_id 与 PDF 页码口径）' : '',
    pages,
  };
}

function renderQuery(value) {
  const head =
    '命中 ' +
    value.total_pages +
    ' 页，返回 ' +
    value.returned +
    ' 页（来源：' +
    value.source +
    (value.note ? '；' + value.note : '') +
    '）：';
  const lines = [head];
  for (const hit of value.hits) {
    const edition = hit.edition ? '（' + hit.edition + '）' : '';
    const bookPage = hit.book_page > 0 ? ' / 书 p.' + hit.book_page : '';
    lines.push('《' + hit.title + '》' + edition + ' PDF p.' + hit.pdf_page + bookPage + ' | 命中 ' + hit.score);
    for (const seg of hit.segments) lines.push('  ' + seg);
  }
  if (value.hits.length === 0) {
    lines.push('未命中：可换关键词（≥3 字走 FTS），或用 index_page 按页回读。');
  }
  return [{ type: 'text', text: lines.join('\n') }];
}

function renderPages(value) {
  const edition = value.edition ? '（' + value.edition + '）' : '';
  const lines = ['《' + value.book_id + '》' + edition + ' 回读 ' + value.returned + ' 页' + (value.note ? '；' + value.note : '')];
  for (const page of value.pages) {
    const bookPage = page.book_page > 0 ? ' / 书 p.' + page.book_page : '';
    lines.push('===== PDF p.' + page.pdf_page + bookPage + (page.truncated ? '（已截断）' : '') + ' =====');
    lines.push(page.text);
  }
  return [{ type: 'text', text: lines.join('\n') }];
}

const QUERY_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    keyword: { type: 'string', description: '检索词；英文不区分大小写，≥3 字走 FTS trigram，否则 LIKE' },
    book_id: { type: 'string', description: '可选：只查单本 / 单分卷（见 索引/书目.md）' },
    limit: { type: 'integer', description: '返回页数上限，默认 8，最大 20' },
    context_chars: { type: 'integer', description: '命中词前后各取多少字，默认 100，最大 400' },
  },
  required: ['keyword'],
};

const QUERY_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    keyword: { type: 'string' },
    source: { type: 'string' },
    total_pages: { type: 'integer' },
    returned: { type: 'integer' },
    note: { type: 'string' },
    hits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          book_id: { type: 'string' },
          title: { type: 'string' },
          edition: { type: 'string' },
          pdf_page: { type: 'integer' },
          book_page: { type: 'integer' },
          score: { type: 'integer' },
          segments: { type: 'array', items: { type: 'string' } },
        },
        required: ['book_id', 'title', 'pdf_page', 'score', 'segments'],
      },
    },
  },
  required: ['keyword', 'source', 'total_pages', 'returned', 'hits'],
};

const PAGE_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    book_id: { type: 'string', description: '目标书 / 分卷的 book_id（精确）' },
    pages: { type: 'string', description: 'PDF 页码：57 或 57-58，逗号分隔多段；单次最多 10 页' },
  },
  required: ['book_id', 'pages'],
};

const PAGE_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    book_id: { type: 'string' },
    edition: { type: 'string' },
    returned: { type: 'integer' },
    note: { type: 'string' },
    pages: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pdf_page: { type: 'integer' },
          book_page: { type: 'integer' },
          truncated: { type: 'boolean' },
          text: { type: 'string' },
        },
        required: ['pdf_page', 'text'],
      },
    },
  },
  required: ['book_id', 'returned', 'pages'],
};

/**
 * 注册两个工具到 ctx.tools（注册即随插件 ctx 回收，无需手工清理）。
 * @param {object} ctx - cordis 上下文（已 inject tools）
 * @param {object} config - patch 行 config：{ indexDir, dbPath? }
 */
export function apply(ctx, config) {
  const cfg = normalizeConfig(config);

  ctx.tools.register({
    name: 'index_query',
    description:
      '本地教材页级索引检索（只读、离线）。返回命中页的书名/版次/PDF 页/印刷页与命中段落，不整页打印。' +
      '适合先定位再回读；结果只用于定位，引用前须回原文核对。',
    parameters: QUERY_PARAMETERS,
    output: { schema: QUERY_OUTPUT, render: (_args, value) => renderQuery(value) },
    async execute(args) {
      const keyword = String(args.keyword ?? '').trim();
      if (!keyword) throw new Error('keyword 不能为空');
      const bookId = typeof args.book_id === 'string' ? args.book_id.trim() : '';
      const limit = clamp(args.limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
      const width = clamp(args.context_chars, 10, MAX_CONTEXT, DEFAULT_CONTEXT);
      const db = await openDb(cfg);
      if (db) {
        try {
          return queryDb(db, cfg, keyword, bookId, limit, width);
        } catch {
          /* FTS / SQLite 异常时退回 JSONL，不中断调用 */
        } finally {
          try {
            db.close();
          } catch {
            /* 忽略关闭失败 */
          }
        }
      }
      return queryJsonl(cfg, keyword, bookId, limit, width);
    },
  });

  ctx.tools.register({
    name: 'index_page',
    description:
      '按 PDF 页范围回读本地教材索引中的整页文本（只读、离线）。单页有字数上限，超出标「已截断」。' +
      '用于核对上下文或表格；引用前须回原书核对。',
    parameters: PAGE_PARAMETERS,
    output: { schema: PAGE_OUTPUT, render: (_args, value) => renderPages(value) },
    async execute(args) {
      return pageRead(args, cfg);
    },
  });
}
