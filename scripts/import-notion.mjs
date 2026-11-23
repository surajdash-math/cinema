import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const mediaTypes = new Set([
  'Cinema', 'TV series', 'Short Films', 'Documentaries',
  'Animated documentaries', 'Theatre Acts-Musicals', 'Anime',
]);
const allowedTypes = new Set([...mediaTypes, 'Filmmakers', 'Some IMDb lists']);

function decodeHtml(value) {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#39|#(?:x[0-9a-f]+|\d+));/gi, entity => {
    const named = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&#39;': "'" };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const code = entity.slice(2, -1);
    return String.fromCodePoint(code.toLowerCase().startsWith('x') ? Number.parseInt(code.slice(1), 16) : Number(code));
  });
}

/** Canonical URLs identify records; the source URL itself is stored unchanged. */
export function canonicalizeUrl(originalUrl) {
  let url = new URL(decodeHtml(originalUrl));
  const redirects = new Set();
  while (/^(?:www\.)?google\.[a-z.]+$/i.test(url.hostname) && url.pathname === '/url') {
    if (redirects.has(url.href)) throw new Error('Circular Google URL redirect');
    redirects.add(url.href);
    const target = url.searchParams.get('url') || url.searchParams.get('q');
    if (!target) break;
    url = new URL(target);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  url.hash = '';
  if (/^(?:(?:www|m)\.)?imdb\.com$/i.test(url.hostname)) {
    url.protocol = 'https:';
    url.hostname = 'www.imdb.com';
    const entity = url.pathname.match(/^\/(title|name|list)\/((?:tt|nm|ls)\d+)(?:\/|$)/i);
    if (entity) {
      const [, collection, imdbId] = entity;
      const prefix = { title: 'tt', name: 'nm', list: 'ls' }[collection.toLowerCase()];
      if (!imdbId.toLowerCase().startsWith(prefix)) throw new Error('IMDb URL collection does not match its ID');
      return {
        id: imdbId.toLowerCase(),
        kind: { title: 'title', name: 'person', list: 'list' }[collection.toLowerCase()],
        imdbId: imdbId.toLowerCase(),
        sourceUrl: `https://www.imdb.com/${collection.toLowerCase()}/${imdbId.toLowerCase()}/`,
      };
    }
    // News and video links remain links, rather than being inferred to be films.
    url.search = '';
  } else {
    for (const parameter of [...url.searchParams.keys()]) {
      if (/^(?:utm_.+|fbclid|gclid|msclkid)$/i.test(parameter)) url.searchParams.delete(parameter);
    }
    url.searchParams.sort();
  }
  const sourceUrl = url.href;
  return {
    id: `link-${createHash('sha256').update(sourceUrl).digest('hex').slice(0, 20)}`,
    kind: 'link',
    imdbId: null,
    sourceUrl,
  };
}

function headingText(value) {
  return decodeHtml(value.replace(/<[^>]+>/g, '')).trim();
}

function sectionKey(section) {
  return JSON.stringify([section.status, section.region, section.type]);
}

/** Parse a saved snapshot only. This importer never connects to Notion or IMDb. */
export function parseNotionPage(page, { generatedAt = new Date().toISOString() } = {}) {
  if (typeof page.contentMarkdown !== 'string') throw new Error('The snapshot must contain contentMarkdown');
  const records = new Map();
  const sections = new Map();
  const headings = [];
  const unparsedContent = [];
  const ignoredStructure = [];
  const sourceBookmarks = [];
  const lines = page.contentMarkdown.split(/\r?\n/);
  let current = { status: null, region: null, type: null };

  function addUnparsed(line, content, reason) {
    unparsedContent.push({ line, content, reason });
  }

  function addSection() {
    const key = sectionKey(current);
    if (!sections.has(key)) sections.set(key, { ...current, count: 0 });
  }

  function processHeading(level, text, line) {
    headings.push({ level, text, line });
    if (level === 1 && ['Watched', 'Watchlist'].includes(text)) {
      current = { status: text, region: null, type: null };
    } else if (level === 2 && text === 'Filmmakers') {
      current = { status: 'Reference', region: null, type: 'Filmmakers' };
      addSection();
    } else if (level === 2 && ['Indian origin', 'International'].includes(text) && ['Watched', 'Watchlist'].includes(current.status)) {
      current = { status: current.status, region: text === 'Indian origin' ? 'Indian' : 'International', type: null };
    } else if (level === 3 && allowedTypes.has(text) && current.region && ['Watched', 'Watchlist'].includes(current.status)) {
      // Some IMDb lists is a reference area in the UI, but retains its source status and region.
      current = { ...current, type: text };
      addSection();
    } else {
      current = { status: null, region: null, type: null };
      addUnparsed(line, text, `Unsupported heading level or hierarchy (${level})`);
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const value = raw.trim();
    const line = index + 1;
    if (!value) continue;
    const markdownHeading = value.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (markdownHeading) {
      processHeading(markdownHeading[1].length, headingText(markdownHeading[2]), line);
      continue;
    }
    const htmlHeading = value.match(/^<h([1-6])(?:\s[^>]*)?>/i);
    if (htmlHeading) {
      let content = value;
      const closing = new RegExp(`</h${htmlHeading[1]}>`, 'i');
      while (!closing.test(content) && index + 1 < lines.length) content += `\n${lines[++index]}`;
      if (!closing.test(content)) {
        addUnparsed(line, content, 'Unclosed HTML heading');
      } else {
        processHeading(Number(htmlHeading[1]), headingText(content), line);
      }
      continue;
    }
    const bookmark = value.match(/^<bookmark\s+source=(?:"([^"]*)"|'([^']*)')\s*\/?>$/i);
    if (bookmark) {
      const originalUrl = bookmark[1] ?? bookmark[2];
      const sourceOrder = sourceBookmarks.length + 1;
      const placement = { ...current, sourceOrder };
      sourceBookmarks.push({ sourceOrder, line, sourceUrl: originalUrl, ...current });
      if (!current.status || !current.type) {
        addUnparsed(line, raw, 'Bookmark has no recognized source section');
        continue;
      }
      let entity;
      try {
        entity = canonicalizeUrl(originalUrl);
      } catch (error) {
        addUnparsed(line, raw, error.message);
        continue;
      }
      if (!records.has(entity.id)) {
        records.set(entity.id, {
          ...entity,
          sourceUrls: [],
          placements: [],
          title: null,
          year: null,
          directors: [],
          originalTitle: null,
          countries: [],
          languages: [],
          poster: null,
          notesHtml: '',
        });
      }
      const record = records.get(entity.id);
      // One URL and placement per occurrence preserves even identical repeated bookmarks.
      record.sourceUrls.push(originalUrl);
      record.placements.push(placement);
      sections.get(sectionKey(current)).count += 1;
      continue;
    }
    if (/^(?:---|<table-of-contents\b[^>]*\/>|<p\s*\/>)$/.test(value)) {
      ignoredStructure.push({ line, content: raw });
      continue;
    }
    addUnparsed(line, raw, 'Unrecognized source content');
  }

  const recordList = [...records.values()];
  const sectionList = [...sections.values()];
  const placementCount = recordList.reduce((total, record) => total + record.placements.length, 0);
  const countBy = (items, key) => items.reduce((counts, item) => {
    const value = key(item);
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
  const duplicates = recordList.filter(record => record.placements.length > 1).map(record => ({
    id: record.id, occurrences: record.placements.length, placements: record.placements,
  }));
  const data = {
    source: { url: page.url ?? null, lastEdited: page.lastEdited ?? null },
    generatedAt,
    records: recordList,
    sections: sectionList,
  };
  const audit = {
    source: { ...data.source, title: page.title ?? null },
    generatedAt,
    counts: {
      sourceBookmarks: sourceBookmarks.length,
      representedBookmarks: placementCount,
      uniqueRecords: recordList.length,
      duplicateOccurrences: placementCount - recordList.length,
      recordsWithMultiplePlacements: duplicates.length,
      recordsByKind: countBy(recordList, record => record.kind),
      bookmarksByStatus: countBy(sourceBookmarks, bookmark => bookmark.status),
      bookmarksByRegion: countBy(sourceBookmarks, bookmark => bookmark.region ?? 'None'),
      sections: sectionList.length,
      unparsedContent: unparsedContent.length,
    },
    sections: sectionList,
    headings,
    duplicates,
    unparsedContent,
    ignoredStructure,
    // This occurrence ledger makes the original URL and hierarchy independently reviewable.
    sourceBookmarks,
  };
  return { data, audit };
}

export async function importSnapshot({
  sourcePath = resolve(projectRoot, '.cinema-source/notion-page.json'),
  outputPath = resolve(projectRoot, 'data/cinema.json'),
  auditPath = resolve(projectRoot, '.cinema-source/source-audit.json'),
} = {}) {
  const page = JSON.parse(await readFile(sourcePath, 'utf8'));
  const result = parseNotionPage(page);
  await mkdir(dirname(outputPath), { recursive: true });
  await mkdir(dirname(auditPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result.data, null, 2)}\n`);
  await writeFile(auditPath, `${JSON.stringify(result.audit, null, 2)}\n`);
  if (result.audit.unparsedContent.length) {
    throw new Error(`Source import has ${result.audit.unparsedContent.length} unparsed item(s); review ${auditPath}`);
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { audit } = await importSnapshot();
  console.log(`Imported ${audit.counts.sourceBookmarks} bookmarks into ${audit.counts.uniqueRecords} records across ${audit.counts.sections} source sections.`);
}
