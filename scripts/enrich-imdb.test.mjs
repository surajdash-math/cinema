import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseSuggestion, parseJsonLd, parseOpenGraph, applyMetadata, applyReferenceOverride, suggestionUrl, main } from './enrich-imdb.mjs';

test('IMDb suggestions require the exact requested identity, ignore credit strings, and use real image URLs', () => {
  const data = { d: [
    { id: 'tt9999999', l: 'Wrong result', y: 2020 },
    { id: 'tt0111161', l: 'The Shawshank Redemption', y: 1994, s: 'Tim Robbins, Morgan Freeman', i: { imageUrl: 'https://m.media-amazon.com/images/real.jpg' } },
  ] };
  assert.deepEqual(parseSuggestion(data, 'tt0111161'), {
    title: 'The Shawshank Redemption', year: 1994, poster: 'https://m.media-amazon.com/images/real.jpg',
    directors: [], originalTitle: null, countries: [], languages: [],
  });
  assert.equal(parseSuggestion(data, 'tt1234567'), null);
  assert.equal(suggestionUrl('nm0000019'), 'https://v3.sg.media-imdb.com/suggestion/n/nm0000019.json');
});

test('person metadata never assigns a birth/credit year as a film year', () => {
  const person = parseSuggestion({ d: [{ id: 'nm0000019', l: 'Federico Fellini', y: 1920, s: 'Writer, La Dolce Vita (1960)' }] }, 'nm0000019');
  assert.equal(person.title, 'Federico Fellini');
  assert.equal(person.year, null);
  assert.deepEqual(person.directors, []);
});

test('official structured data must identify the exact IMDb record', () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'Movie', url: 'https://www.imdb.com/title/tt0111161/',
    name: 'The Shawshank Redemption', alternateName: 'Not necessarily an original title',
    datePublished: '1994-09-23', director: [{ '@type': 'Person', name: 'Frank Darabont' }],
    countryOfOrigin: { name: 'United States' }, inLanguage: ['English'], image: 'https://m.media-amazon.com/images/real.jpg',
  })}</script>`;
  const metadata = parseJsonLd(html, 'tt0111161', 'https://www.imdb.com/title/tt0111161/');
  assert.equal(metadata.title, 'The Shawshank Redemption');
  assert.deepEqual(metadata.directors, ['Frank Darabont']);
  assert.equal(metadata.originalTitle, null);
  assert.equal(parseJsonLd(html, 'tt9999999', 'https://www.imdb.com/title/tt9999999/'), null);
});

test('enrichment preserves imported classification, every placement/source, existing names, and HTML notes', () => {
  const record = { id: 'a', kind: 'director', title: 'User title', imdbId: 'nm0000019', sourceUrl: 'https://www.imdb.com/name/nm0000019/', sourceUrls: ['one', 'two'], placements: [{ category: 'Favourites', order: 3 }], notesHtml: '<p>Keep exactly.</p>', directors: [] };
  const metadata = { title: 'Fetched title', kind: 'film', sourceUrl: 'bad', placements: [], directors: ['Verified Director'], poster: 'javascript:alert(1)' };
  const result = applyMetadata(record, metadata);
  assert.deepEqual(result, { ...record, directors: ['Verified Director'] });
  assert.deepEqual(record.directors, []);
});

test('reference Open Graph labels are published text and reject unrelated redirects or challenge pages', () => {
  const url = 'https://mubi.com/en/us/films/four-slippers';
  const html = '<meta content="Four Slippers &amp; Other Stories" property="og:title"><meta property="og:url" content="https://mubi.com/en/us/films/four-slippers"><meta property="og:image" content="https://mubi.com/real.jpg">';
  assert.equal(parseOpenGraph(html, url).title, 'Four Slippers & Other Stories');
  assert.equal(parseOpenGraph(html, url).poster, 'https://mubi.com/real.jpg');
  assert.equal(parseOpenGraph(html, url, 'https://mubi.com/'), null);
  assert.equal(parseOpenGraph('<meta property="og:title" content="Just a moment...">', url), null);
});

test('verified reference overrides require matching ID and exact source URL and only fill safe title/image fields', () => {
  const record = { id: 'ref-a', kind: 'link', title: null, poster: null, sourceUrl: 'https://example.org/film', sourceUrls: ['original'], placements: [{ sourceOrder: 7 }], notesHtml: '<p>Exact notes.</p>' };
  const override = { id: 'ref-a', sourceUrl: record.sourceUrl, evidenceUrl: 'https://example.org/film', title: 'Verified title', poster: 'https://example.org/real.jpg', kind: 'person', placements: [] };
  assert.deepEqual(applyReferenceOverride(record, override), { ...record, title: 'Verified title', poster: 'https://example.org/real.jpg' });
  assert.deepEqual(applyReferenceOverride(record, { ...override, id: 'different-id' }), record);
  assert.deepEqual(applyReferenceOverride(record, { ...override, sourceUrl: 'https://example.org/film?different' }), record);
  assert.deepEqual(applyReferenceOverride(record, { ...override, evidenceUrl: 'javascript:alert(1)' }), record);
  assert.deepEqual(applyReferenceOverride(record, { ...override, title: '<script>bad</script>', poster: 'javascript:alert(1)' }), record);
});

test('offline mode rejects mismatched cache identities and preserves imported structure', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'cinema-metadata-test-'));
  try {
    const input = path.join(temp, 'cinema.json');
    const cache = path.join(temp, 'cache.json');
    const overrides = path.join(temp, 'overrides.json');
    const records = [
      { id: 'film-a', kind: 'film', imdbId: 'tt0111161', title: null, year: null, sourceUrl: 'https://www.imdb.com/title/tt0111161/', sourceUrls: ['first', 'second'], placements: [{ id: 1 }, { id: 2 }], notesHtml: '<p>Exact notes</p>' },
      { id: 'film-b', kind: 'film', imdbId: 'tt9999999', title: null, sourceUrl: 'https://www.imdb.com/title/tt9999999/', sourceUrls: ['third'], placements: [{ id: 3 }] },
      { id: 'ref-c', kind: 'link', title: null, sourceUrl: 'https://example.org/reference', sourceUrls: ['fourth'], placements: [{ id: 4 }] },
    ];
    await writeFile(input, JSON.stringify({ version: 1, records }));
    await writeFile(cache, JSON.stringify({ version: 1, entries: {
      tt0111161: { identity: 'tt0111161', status: 'ok', data: { title: 'The Shawshank Redemption', year: 1994 } },
      tt9999999: { identity: 'tt0000001', status: 'ok', data: { title: 'A different film' } },
    } }));
    await writeFile(overrides, JSON.stringify({ version: 1, entries: [{ id: 'ref-c', sourceUrl: 'https://example.org/reference', evidenceUrl: 'https://example.org/reference', title: 'A verified reference' }] }));
    await main(['--input', input, '--cache', cache, '--overrides', overrides, '--offline']);
    const result = JSON.parse(await readFile(input, 'utf8'));
    assert.equal(result.records[0].title, 'The Shawshank Redemption');
    assert.equal(result.records[0].year, 1994);
    assert.deepEqual(result.records[0].placements, records[0].placements);
    assert.deepEqual(result.records[0].sourceUrls, records[0].sourceUrls);
    assert.equal(result.records[0].notesHtml, records[0].notesHtml);
    assert.equal(result.records[1].title, null);
    assert.deepEqual(result.records[2], { ...records[2], title: 'A verified reference' });
    assert.equal(result.version, 1);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
