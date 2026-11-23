import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { canonicalizeUrl, parseNotionPage } from '../scripts/import-notion.mjs';

const page = JSON.parse(await readFile(new URL('../.cinema-source/notion-page.json', import.meta.url), 'utf8'));
const { data, audit } = parseNotionPage(page, { generatedAt: '2026-11-22T00:00:00.000Z' });

test('the published catalogue preserves all imported identities and source placements', async () => {
  const catalogue = JSON.parse(await readFile(new URL('../data/cinema.json', import.meta.url), 'utf8'));
  const provenance = record => ({
    id: record.id, kind: record.kind, imdbId: record.imdbId,
    sourceUrl: record.sourceUrl, sourceUrls: record.sourceUrls, placements: record.placements,
  });
  assert.deepEqual(catalogue.source, data.source);
  assert.deepEqual(catalogue.sections, data.sections);
  assert.deepEqual(catalogue.records.map(provenance), data.records.map(provenance));
  assert.ok(catalogue.records.every(record => !('genres' in record)));
});

test('every source bookmark is represented, with its exact URL and original order', () => {
  const sourceUrls = [...page.contentMarkdown.matchAll(/<bookmark\s+source="([^"]*)"\s*\/>/g)].map(match => match[1]);
  assert.equal(sourceUrls.length, 491, 'The saved source snapshot has 491 bookmark occurrences');
  const placements = data.records.flatMap(record => record.placements.map((placement, index) => ({ ...placement, url: record.sourceUrls[index] })));
  placements.sort((a, b) => a.sourceOrder - b.sourceOrder);
  assert.deepEqual(placements.map(placement => placement.url), sourceUrls);
  assert.deepEqual(placements.map(placement => placement.sourceOrder), Array.from({ length: 491 }, (_, index) => index + 1));
  assert.equal(audit.counts.representedBookmarks, sourceUrls.length);
  assert.deepEqual(audit.unparsedContent, []);
});

test('all source leaf sections survive, including empty types and unusual placements', () => {
  assert.deepEqual(data.sections, [
    { status: 'Reference', region: null, type: 'Filmmakers', count: 32 },
    { status: 'Watchlist', region: 'Indian', type: 'Cinema', count: 34 },
    { status: 'Watchlist', region: 'Indian', type: 'TV series', count: 1 },
    { status: 'Watchlist', region: 'Indian', type: 'Short Films', count: 4 },
    { status: 'Watchlist', region: 'Indian', type: 'Documentaries', count: 3 },
    { status: 'Watchlist', region: 'Indian', type: 'Theatre Acts-Musicals', count: 0 },
    { status: 'Watchlist', region: 'International', type: 'Cinema', count: 88 },
    { status: 'Watchlist', region: 'International', type: 'TV series', count: 11 },
    { status: 'Watchlist', region: 'International', type: 'Short Films', count: 0 },
    { status: 'Watchlist', region: 'International', type: 'Documentaries', count: 18 },
    { status: 'Watchlist', region: 'International', type: 'Animated documentaries', count: 3 },
    { status: 'Watchlist', region: 'International', type: 'Theatre Acts-Musicals', count: 2 },
    { status: 'Watchlist', region: 'International', type: 'Some IMDb lists', count: 14 },
    { status: 'Watchlist', region: 'International', type: 'Anime', count: 3 },
    { status: 'Watched', region: 'Indian', type: 'Cinema', count: 133 },
    { status: 'Watched', region: 'Indian', type: 'TV series', count: 43 },
    { status: 'Watched', region: 'Indian', type: 'Short Films', count: 4 },
    { status: 'Watched', region: 'Indian', type: 'Documentaries', count: 1 },
    { status: 'Watched', region: 'Indian', type: 'Theatre Acts-Musicals', count: 1 },
    { status: 'Watched', region: 'International', type: 'Cinema', count: 72 },
    { status: 'Watched', region: 'International', type: 'TV series', count: 20 },
    { status: 'Watched', region: 'International', type: 'Short Films', count: 0 },
    { status: 'Watched', region: 'International', type: 'Documentaries', count: 1 },
    { status: 'Watched', region: 'International', type: 'Theatre Acts-Musicals', count: 1 },
    { status: 'Watched', region: 'International', type: 'Anime', count: 2 },
  ]);
  const lists = data.records.filter(record => record.kind === 'list');
  assert.equal(lists.length, 14);
  assert.ok(lists.every(record => record.placements.every(placement => placement.status === 'Watchlist' && placement.region === 'International' && placement.type === 'Some IMDb lists')));
  // A title in Filmmakers remains a title, and Hamilton retains the Indian source placement.
  assert.ok(data.records.find(record => record.id === 'tt18277182').placements.some(placement => placement.type === 'Filmmakers'));
  assert.ok(data.records.find(record => record.id === 'tt8503618').placements.some(placement => placement.status === 'Watched' && placement.region === 'Indian' && placement.type === 'Theatre Acts-Musicals'));
});

test('Watchlist and Watched follow the source boundary, including mixed Markdown and HTML headings', () => {
  const watchlistStart = page.contentMarkdown.indexOf('# <u>Watchlist');
  const watchedStart = page.contentMarkdown.indexOf('<h1>');
  const allBookmarks = [...page.contentMarkdown.matchAll(/<bookmark\s+source="([^"]*)"\s*\/>/g)];
  const placements = new Map(data.records.flatMap(record => record.placements.map(placement => [placement.sourceOrder, placement])));
  allBookmarks.forEach((bookmark, index) => {
    const expected = bookmark.index < watchlistStart ? 'Reference' : bookmark.index < watchedStart ? 'Watchlist' : 'Watched';
    assert.equal(placements.get(index + 1).status, expected, `Source bookmark ${index + 1} has its own status`);
  });
  assert.deepEqual(audit.counts.bookmarksByStatus, { Reference: 32, Watchlist: 181, Watched: 278 });
});

test('deduplication preserves repeated URLs and cross-category placements', () => {
  assert.equal(new Set(data.records.map(record => record.id)).size, data.records.length);
  const filmmaker = data.records.find(record => record.id === 'nm0000040');
  assert.equal(filmmaker.placements.length, 2);
  assert.equal(filmmaker.sourceUrls.length, 2);
  const crossCategory = data.records.find(record => record.id === 'tt18347622');
  assert.deepEqual(crossCategory.placements.map(placement => placement.type), ['Cinema', 'TV series']);
  assert.ok(crossCategory.placements.every(placement => placement.status === 'Watchlist'));
  const repeated = parseNotionPage({ contentMarkdown: '# Watchlist\n## Indian origin\n### Cinema\n<bookmark source="https://m.imdb.com/title/tt1234567/?ref_=x" />\n<bookmark source="https://m.imdb.com/title/tt1234567/?ref_=x" />\n# Watched\n## International\n### TV series\n<bookmark source="https://www.imdb.com/title/tt1234567/" />' }).data;
  assert.equal(repeated.records.length, 1);
  assert.equal(repeated.records[0].sourceUrls.length, 3);
  assert.deepEqual(repeated.records[0].placements.map(placement => placement.status), ['Watchlist', 'Watchlist', 'Watched']);
});

test('IMDb mobile URLs, tracking parameters, and Google redirects identify canonical entities', () => {
  const expected = { id: 'tt30840798', kind: 'title', imdbId: 'tt30840798', sourceUrl: 'https://www.imdb.com/title/tt30840798/' };
  assert.deepEqual(canonicalizeUrl('https://m.imdb.com/title/tt30840798/?ref_=tracking#test'), expected);
  assert.deepEqual(canonicalizeUrl('https://www.google.com/url?sa=t&amp;url=https://www.imdb.com/title/tt30840798/&amp;ved=tracking'), expected);
  assert.equal(canonicalizeUrl('https://www.imdb.com/name/nm0001486/?ref_=x').kind, 'person');
  assert.equal(canonicalizeUrl('https://www.imdb.com/list/ls005758479/?sort=list_order,asc').kind, 'list');
  assert.equal(canonicalizeUrl('https://www.imdb.com/video/vi2373564953/').kind, 'link');
  assert.equal(canonicalizeUrl('https://www.imdb.com/news/ni63938441').kind, 'link');
  assert.equal(canonicalizeUrl('https://example.com/movie?utm_source=test&edition=2#top').sourceUrl, 'https://example.com/movie?edition=2');
  for (const record of data.records.filter(record => record.imdbId)) {
    assert.match(record.id, /^(tt|nm|ls)\d+$/);
    assert.equal(record.id, record.imdbId);
    assert.ok(!record.sourceUrl.includes('?'));
    assert.ok(record.sourceUrl.startsWith('https://www.imdb.com/'));
  }
});

test('the import invents no metadata or genres and reports unexpected source material', () => {
  assert.ok(data.records.every(record => record.title === null && record.year === null && record.originalTitle === null && record.poster === null));
  assert.ok(data.records.every(record => record.directors.length === 0 && record.countries.length === 0 && record.languages.length === 0 && record.notesHtml === '' && !('genres' in record)));
  const result = parseNotionPage({ contentMarkdown: '# Watchlist\n## Indian origin\n### Cinema\nAn unparsed note\n### Unknown type\n<bookmark source="https://www.imdb.com/title/tt1234567/" />' });
  assert.equal(result.audit.unparsedContent.length, 3);
  assert.equal(result.audit.counts.sourceBookmarks, 1);
  assert.equal(result.audit.counts.representedBookmarks, 0);
});
