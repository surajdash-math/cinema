#!/usr/bin/env node
/**
 * Resolve imported references against IMDb's public, official suggestion API.
 * No API keys, third-party title guesses, classification changes or cast-as-director data.
 *
 * node scripts/enrich-imdb.mjs --max 10
 * node scripts/enrich-imdb.mjs --concurrency 4 --delay-ms 200
 * node scripts/enrich-imdb.mjs --offline
 * node --test scripts/enrich-imdb.test.mjs
 *
 * --page-details additionally tries official IMDb JSON-LD (often unavailable).
 * --reference-pages permits JSON-LD / Open Graph enrichment of source pages
 * outside the title/person suggestion API (including IMDb list references).
 * Both are opt-in; failures are recorded and do not erase successful metadata.
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIELDS = ['title', 'year', 'directors', 'originalTitle', 'countries', 'languages', 'poster'];
const ARRAY_FIELDS = new Set(['directors', 'countries', 'languages']);
const IMDB_ID = /^(?:tt|nm)\d+$/;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export function safeWebUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function cleanText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function yearOf(value) {
  const match = /^(\d{4})(?:-|$)/.exec(String(value ?? ''));
  const year = match ? Number(match[1]) : null;
  return year && year >= 1800 && year <= 2200 ? year : null;
}

export function suggestionUrl(imdbId) {
  if (!IMDB_ID.test(imdbId)) throw new Error(`Invalid IMDb ID: ${imdbId}`);
  return `https://v3.sg.media-imdb.com/suggestion/${imdbId[0]}/${imdbId}.json`;
}

export function parseSuggestion(payload, imdbId) {
  if (!IMDB_ID.test(imdbId)) return null;
  const match = Array.isArray(payload?.d) ? payload.d.find(item => item?.id === imdbId) : null;
  if (!match || !cleanText(match.l)) return null;
  // IMDb's s field is a credit summary, usually cast; it is deliberately ignored.
  return {
    title: cleanText(match.l),
    year: imdbId.startsWith('tt') ? yearOf(match.y) : null,
    poster: safeWebUrl(match.i?.imageUrl),
    directors: [], originalTitle: null, countries: [], languages: [],
  };
}

function arrayOf(value) { return Array.isArray(value) ? value : value == null ? [] : [value]; }
function entityNames(value) {
  return [...new Set(arrayOf(value).map(item => cleanText(typeof item === 'string' ? item : item?.name)).filter(Boolean))];
}
function imageOf(value) {
  const first = arrayOf(value)[0];
  return safeWebUrl(typeof first === 'string' ? first : first?.url || first?.contentUrl);
}

function normalizedPageUrl(value) {
  const safe = safeWebUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  url.hash = ''; url.search = '';
  return url.href.replace(/\/$/, '');
}

function decodeEntities(value) {
  return value.replace(/&#(x[0-9a-f]+|\d+);|&(amp|quot|apos|lt|gt|nbsp);/gi, (match, code, name) => {
    if (code) {
      const n = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
      try { return String.fromCodePoint(n); } catch { return match; }
    }
    return { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' }[name.toLowerCase()];
  });
}

export function parseOpenGraph(html, sourceUrl, finalUrl = sourceUrl) {
  // A redirect to a homepage, login or different reference is not evidence of
  // this source's title. Keep the original reference unresolved in that case.
  const expected = normalizedPageUrl(sourceUrl);
  if (!expected || normalizedPageUrl(finalUrl) !== expected) return null;
  const meta = {};
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = {};
    for (const attr of tag[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attributes[attr[1].toLowerCase()] = decodeEntities(attr[2] ?? attr[3] ?? attr[4] ?? '');
    }
    const key = attributes.property || attributes.name;
    if (key && attributes.content) meta[key.toLowerCase()] = attributes.content;
  }
  if (meta['og:url'] && normalizedPageUrl(meta['og:url']) !== expected) return null;
  const title = cleanText(meta['og:title']);
  if (!title || /^(?:just a moment|access denied|forbidden|robot check|verify (?:you|your)|attention required|sign in|log in)(?:\b|\.\.\.)/i.test(title)) return null;
  return { title, poster: safeWebUrl(meta['og:image']), year: null, directors: [], originalTitle: null, countries: [], languages: [] };
}

export function parseJsonLd(html, identity, sourceUrl) {
  const nodes = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(visit);
    nodes.push(value);
    if (value['@graph']) visit(value['@graph']);
  };
  for (const match of html.matchAll(/<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    try { visit(JSON.parse(match[1])); } catch { /* Ignore malformed structured data. */ }
  }
  const isImdb = IMDB_ID.test(identity);
  const expectedUrl = normalizedPageUrl(sourceUrl);
  const node = nodes.find(item => {
    const type = arrayOf(item['@type']);
    if (!type.some(t => ['Movie', 'TVSeries', 'TVEpisode', 'TVMiniSeries', 'Person', 'CreativeWork', 'ItemList', 'CollectionPage'].includes(t))) return false;
    const urls = [item.url, item['@id'], item.mainEntityOfPage?.['@id'], item.mainEntityOfPage].filter(v => typeof v === 'string');
    if (isImdb) {
      return urls.some(value => {
        try {
          const url = new URL(value, sourceUrl);
          return /(^|\.)imdb\.com$/.test(url.hostname)
            && url.pathname === `/${identity.startsWith('tt') ? 'title' : 'name'}/${identity}/`;
        } catch { return false; }
      });
    }
    return urls.some(value => normalizedPageUrl(value) === expectedUrl);
  });
  if (!node || !cleanText(node.name)) return null;
  const isPerson = arrayOf(node['@type']).includes('Person') || identity.startsWith('nm');
  return {
    title: cleanText(node.name),
    year: isPerson ? null : yearOf(node.datePublished),
    directors: isPerson ? [] : entityNames(node.director),
    // alternateName does not establish an original title, so it is not copied.
    originalTitle: null,
    countries: isPerson ? [] : entityNames(node.countryOfOrigin),
    languages: isPerson ? [] : entityNames(node.inLanguage),
    poster: imageOf(node.image),
  };
}

export function applyMetadata(record, metadata) {
  const result = { ...record };
  if (!metadata || typeof metadata !== 'object') return result;
  for (const field of FIELDS) {
    const value = metadata[field];
    const empty = result[field] == null || result[field] === '' || (Array.isArray(result[field]) && result[field].length === 0);
    if (!empty) continue;
    if (ARRAY_FIELDS.has(field)) {
      const values = entityNames(value);
      if (values.length) result[field] = values;
    } else if (field === 'year') {
      const year = yearOf(value);
      if (year) result.year = year;
    } else if (field === 'poster') {
      const url = safeWebUrl(value);
      if (url) result.poster = url;
    } else {
      const text = cleanText(value);
      if (text) result[field] = text;
    }
  }
  return result;
}

export function applyReferenceOverride(record, override) {
  if (!override || override.id !== record.id || override.sourceUrl !== record.sourceUrl || !safeWebUrl(override.evidenceUrl)) return record;
  // Overrides carry independently checked source labels, never classification,
  // placements, IMDb identity, notes, or arbitrary additional record fields.
  const title = cleanText(override.title);
  const safeTitle = title && !/[\u0000-\u001f]/.test(title) && !/<\/?[a-z][^>]*>/i.test(title) ? title : null;
  return applyMetadata(record, { title: safeTitle, poster: safeWebUrl(override.poster) });
}

function parseArgs(argv) {
  const options = {
    input: path.join(ROOT, 'data/cinema.json'), cache: path.join(ROOT, '.cinema-source/metadata-cache.json'),
    overrides: path.join(ROOT, 'data/reference-overrides.json'),
    concurrency: 4, delayMs: 200, timeoutMs: 9000, retries: 1, max: Infinity,
    offline: false, refresh: false, pageDetails: false, referencePages: false,
  };
  const names = { '--input': 'input', '--cache': 'cache', '--overrides': 'overrides', '--concurrency': 'concurrency', '--delay-ms': 'delayMs', '--timeout-ms': 'timeoutMs', '--retries': 'retries', '--max': 'max' };
  const flags = { '--offline': 'offline', '--refresh': 'refresh', '--page-details': 'pageDetails', '--reference-pages': 'referencePages' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help') {
      console.log('Usage: node scripts/enrich-imdb.mjs [--input file] [--cache file] [--overrides file] [--max N] [--concurrency 1-8] [--delay-ms N] [--timeout-ms N] [--retries 0-3] [--offline] [--refresh] [--page-details] [--reference-pages]');
      return null;
    }
    if (flags[arg]) { options[flags[arg]] = true; continue; }
    if (!names[arg] || argv[i + 1] == null) throw new Error(`Unknown or incomplete argument: ${arg}`);
    const key = names[arg];
    const value = argv[++i];
    options[key] = ['input', 'cache', 'overrides'].includes(key) ? path.resolve(value) : Number(value);
  }
  for (const [key, min, max] of [['concurrency', 1, 8], ['delayMs', 0, 60000], ['timeoutMs', 1000, 60000], ['retries', 0, 3], ['max', 0, Infinity]]) {
    if (!Number.isInteger(options[key]) && !(key === 'max' && options[key] === Infinity)) throw new Error(`Invalid ${key}`);
    if (options[key] < min || options[key] > max) throw new Error(`Out of range: ${key}`);
  }
  return options;
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!options) return;
  const document = await readJson(options.input);
  const records = Array.isArray(document) ? document : document.records || document.items;
  if (!Array.isArray(records)) throw new Error('Input must be a record array, or contain a records/items array.');
  const cache = await readJson(options.cache, { version: 1, entries: {} });
  if (cache.version !== 1 || !cache.entries || typeof cache.entries !== 'object') throw new Error('Unsupported metadata cache format.');
  const overrideFile = await readJson(options.overrides, { version: 1, entries: [] });
  if (overrideFile.version !== 1 || !Array.isArray(overrideFile.entries)) throw new Error('Unsupported reference override format.');
  const overrides = new Map();
  for (const entry of overrideFile.entries) {
    if (!entry || typeof entry.id !== 'string' || overrides.has(entry.id)) throw new Error('Reference overrides require unique record IDs.');
    overrides.set(entry.id, entry);
  }
  const jobs = new Map();
  for (const record of records) {
    if (IMDB_ID.test(record.imdbId ?? '')) {
      jobs.set(record.imdbId, { key: record.imdbId, imdbId: record.imdbId, sourceUrl: `https://www.imdb.com/${record.imdbId.startsWith('tt') ? 'title' : 'name'}/${record.imdbId}/` });
    } else if (options.referencePages && safeWebUrl(record.sourceUrl)) {
      jobs.set(record.sourceUrl, { key: record.sourceUrl, imdbId: null, sourceUrl: record.sourceUrl });
    }
  }
  const pending = [...jobs.values()].filter(job => {
    const cached = cache.entries[job.key];
    return options.refresh || cached?.status !== 'ok' || (options.pageDetails && !cached?.pageAttempted);
  }).slice(0, options.max);
  const stats = { records: records.length, uniqueReferences: jobs.size, cached: jobs.size - [...jobs.values()].filter(j => cache.entries[j.key]?.status !== 'ok').length, requested: 0, resolved: 0, failed: 0, enriched: 0 };
  let cacheWrites = Promise.resolve();
  let nextStart = 0;
  const fetchPage = async url => {
    let error;
    for (let attempt = 0; attempt <= options.retries; attempt++) {
      const wait = Math.max(0, nextStart - Date.now());
      nextStart = Math.max(nextStart, Date.now()) + options.delayMs;
      if (wait) await sleep(wait);
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(options.timeoutMs), redirect: 'follow',
          headers: { 'User-Agent': 'CinemaReferenceMetadata/1.0 (personal catalogue; public metadata)', Accept: 'application/json,text/html;q=0.9' },
        });
        if (!response.ok) {
          const e = new Error(`HTTP ${response.status}`);
          e.retryable = response.status === 429 || response.status >= 500;
          throw e;
        }
        const text = await response.text();
        if (text.length > 5_000_000) throw new Error('Response exceeded 5 MB');
        if (!text.trim()) throw new Error('Empty response');
        return { text, finalUrl: response.url };
      } catch (caught) {
        error = caught;
        if (caught.retryable === false || attempt === options.retries) break;
        await sleep(400 * (attempt + 1));
      }
    }
    throw error;
  };

  if (!options.offline) {
    let cursor = 0;
    const worker = async () => {
      while (cursor < pending.length) {
        const job = pending[cursor++];
        const old = cache.entries[job.key];
        const entry = { ...old, identity: job.key, fetchedAt: new Date().toISOString(), sourceUrl: job.sourceUrl, provider: job.imdbId ? 'IMDb' : new URL(job.sourceUrl).hostname, status: 'failed', data: old?.data || {}, errors: [] };
        stats.requested++;
        if (job.imdbId) {
          const url = suggestionUrl(job.imdbId);
          try {
            const metadata = parseSuggestion(JSON.parse((await fetchPage(url)).text), job.imdbId);
            if (!metadata) throw new Error('Exact IMDb ID absent from suggestion results');
            entry.data = applyMetadata(entry.data, metadata);
            entry.suggestionUrl = url;
            entry.status = 'ok';
          } catch (error) { entry.errors.push(`suggestion: ${error.message}`); }
        }
        if ((job.imdbId && options.pageDetails) || !job.imdbId) {
          entry.pageAttempted = true;
          try {
            const page = await fetchPage(job.sourceUrl);
            const metadata = parseJsonLd(page.text, job.key, job.sourceUrl)
              || (!job.imdbId ? parseOpenGraph(page.text, job.sourceUrl, page.finalUrl) : null);
            if (!metadata) throw new Error('Matching structured-data identity absent');
            entry.data = applyMetadata(entry.data, metadata);
            entry.status = 'ok';
          } catch (error) { entry.errors.push(`page: ${error.message}`); }
        }
        if (entry.data.title) entry.status = 'ok';
        cache.entries[job.key] = entry;
        stats[entry.status === 'ok' ? 'resolved' : 'failed']++;
        cache.updatedAt = new Date().toISOString();
        cacheWrites = cacheWrites.then(() => writeJsonAtomic(options.cache, cache));
        await cacheWrites;
        if ((stats.resolved + stats.failed) % 25 === 0 || stats.resolved + stats.failed === pending.length) {
          console.log(`Metadata: ${stats.resolved + stats.failed}/${pending.length} checked; ${stats.resolved} resolved; ${stats.failed} unresolved.`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(options.concurrency, pending.length) }, worker));
    await cacheWrites;
  }

  const originalIdentity = records.map(record => JSON.stringify([record.id, record.kind, record.imdbId, record.sourceUrl, record.sourceUrls, record.placements]));
  const enriched = records.map(record => {
    const key = IMDB_ID.test(record.imdbId ?? '') ? record.imdbId : record.sourceUrl;
    const entry = cache.entries[key];
    // A cache record from a different identifier must never enrich this reference.
    const cached = entry && entry.identity === key && entry.status === 'ok' ? applyMetadata(record, entry.data) : record;
    const result = applyReferenceOverride(cached, overrides.get(record.id));
    if (JSON.stringify(result) !== JSON.stringify(record)) stats.enriched++;
    return result;
  });
  if (enriched.some((record, i) => JSON.stringify([record.id, record.kind, record.imdbId, record.sourceUrl, record.sourceUrls, record.placements]) !== originalIdentity[i])) {
    throw new Error('Enrichment changed imported identity or placements; refusing to write.');
  }
  const output = Array.isArray(document) ? enriched : { ...document, [document.records ? 'records' : 'items']: enriched };
  await writeJsonAtomic(options.input, output);
  const totals = { titles: enriched.filter(r => r.title).length, images: enriched.filter(r => r.poster).length, years: enriched.filter(r => r.year).length };
  console.log(JSON.stringify({ ...stats, ...totals, offline: options.offline, input: options.input, cache: options.cache }));
  return { ...stats, ...totals };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Metadata enrichment failed: ${error.message}`); process.exitCode = 1; });
}
