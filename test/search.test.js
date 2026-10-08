import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compactJob, expandJob } from '../src/compact.js';
import { words, parseTerm, termMatches, anyPhraseIn, hasPhrase } from '../src/match.js';
import { normalizeLever, normalizeAshby, SourceError } from '../src/providers.js';
import { parseCsv, companyName, companyLine, crawlProvider, metaLine, readDirectory } from '../indexer/build-index.js';
import { search, readQuery, querySignature, jobMatches, companyMatches, describe } from '../actors/job-search/src/search.js';
import { readLines, openRemote } from '../actors/job-search/src/index-reader.js';
import * as fx from './fixtures.js';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const quiet = { info() {}, warning() {} };
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

function collector(limit = Infinity) {
    const items = [];
    const pushJobs = async (batch) => {
        const room = Math.max(0, limit - items.length);
        const take = batch.slice(0, room);
        items.push(...take);
        return take.length < batch.length ? { stop: true, pushed: take.length } : { stop: false };
    };
    return { items, pushJobs };
}
function memoryStore(initial = {}) {
    const data = { ...initial };
    return { data, get: async (k) => data[k], set: async (k, v) => { data[k] = v; } };
}

const job = (id, title, extra = {}) => ({ i: id, ti: title, url: `https://example.test/${id}`, ...extra });
const INDEX = {
    greenhouse: [
        { p: 'greenhouse', t: 'acme', n: 'Acme Corp', at: daysAgo(0), j: [
            job('g1', 'Senior Data Engineer', { l: 'New York, NY', p: daysAgo(1) }),
            job('g2', 'JavaScript Developer', { l: 'Sydney, Australia', p: daysAgo(2) }),
            job('g3', 'Engineer, Data Platform', { l: 'Remote - US', r: 1, w: 'remote', p: daysAgo(40) }),
            job('g4', 'Account Executive', { l: 'London, United Kingdom', p: daysAgo(3) }),
        ] },
        { p: 'greenhouse', t: 'globex', n: 'Globex', at: daysAgo(0), j: [
            job('x1', 'Data Engineer II', { l: 'Berlin, Germany', p: daysAgo(5) }),
            job('x2', 'Machine Learning Engineer', { l: 'Remote', r: 1, p: daysAgo(0) }),
            job('x3', 'Engineer (Machine Tools), Learning Systems', { l: 'Austin', p: daysAgo(6) }),
        ] },
    ],
    lever: [
        { p: 'lever', t: 'Initech', n: 'Initech', at: daysAgo(1), j: [
            job('l1', 'Staff Data Engineer', { l: 'Zürich', c: 'CH', r: 0, p: daysAgo(4), s: [150000, 180000, 'CHF', 'per-year-salary', '150000 - 180000 CHF per-year-salary'] }),
            job('l2', 'Java Developer', { l: 'Remote', r: 1, w: 'remote' }),
        ] },
    ],
    ashby: [],
    workable: [],
};
function openIndex(index = INDEX, builtAt = daysAgo(0)) {
    return async function* open(provider) {
        const list = index[provider];
        if (list === undefined) throw new Error('The job index answered HTTP 404');
        yield { meta: { version: 1, provider, builtAt, companies: list.length, jobs: list.reduce((n, c) => n + c.j.length, 0) } };
        yield* list;
    };
}
async function runSearch(input, extra = {}) {
    const out = collector(extra.limit);
    const summary = await search(input, { openIndex: openIndex(extra.index, extra.builtAt), pushJobs: out.pushJobs, log: quiet, now: () => NOW, ...extra.deps });
    return { summary, items: out.items, ids: out.items.map((r) => r.id) };
}

test('words keeps what matters in job titles and drops accents and punctuation', () => {
    assert.deepEqual(words('Sr. Software Engineer, C++/C# (.NET, Node.js) – Zürich'), ['sr', 'software', 'engineer', 'c++', 'c#', '.net', 'node.js', 'zurich']);
    assert.deepEqual(words(null), []);
    assert.deepEqual(words(' — / '), []);
});

test('search terms: any order by default, exact phrase in quotes, whole words only', () => {
    const t = (text, term) => termMatches(words(text), parseTerm(term));
    assert.equal(t('Engineer, Data Platform', 'data engineer'), true);
    assert.equal(t('Engineer, Data Platform', '"data engineer"'), false);
    assert.equal(t('Senior Data Engineer', '"data engineer"'), true);
    assert.equal(t('JavaScript Developer', 'java'), false);
    assert.equal(t('Java Developer', 'JAVA'), true);
    assert.equal(t('C++ Engineer', 'c++'), true);
    assert.equal(parseTerm('   '), null);
    assert.equal(parseTerm('"engineer"').exact, false);
    assert.equal(hasPhrase(['a', 'b', 'c'], ['b', 'c']), true);
    assert.equal(hasPhrase(['a', 'b', 'c'], ['a', 'c']), false);
    assert.equal(anyPhraseIn(['Sydney, Australia'], [parseTerm('US')]), false);
    assert.equal(anyPhraseIn(['Remote - US'], [parseTerm('us')]), true);
    assert.equal(anyPhraseIn(['New York, NY'], [parseTerm('york new')]), false);
});

test('a job survives the trip into the index and back', () => {
    const source = { provider: 'lever', token: 'palantir' };
    const full = normalizeLever(fx.lever[1], source, {});
    assert.deepEqual(expandJob(compactJob(full), { p: 'lever', t: 'palantir', n: full.company }), full);
    const ashby = normalizeAshby(fx.ashby.jobs[0], { provider: 'ashby', token: 'ramp' }, {});
    assert.deepEqual(expandJob(compactJob(ashby), { p: 'ashby', t: 'ramp', n: ashby.company }), ashby);
    const withText = normalizeLever(fx.lever[1], source, { text: true });
    assert.equal('descriptionText' in compactJob(withText), false, 'descriptions are never stored in the index');
});

test('keyword search returns newest first and respects the limit', async () => {
    const all = await runSearch({ keywords: ['data engineer'], maxResults: 0 });
    assert.deepEqual(all.ids, ['g1', 'l1', 'x1', 'g3']);
    assert.equal(all.summary.jobsMatched, 4);
    assert.equal(all.summary.jobsInIndex, 9);
    assert.equal(all.summary.companiesInIndex, 3);
    assert.deepEqual(all.summary.systemsRead, ['ashby', 'greenhouse', 'lever', 'workable']);
    const row = all.items[0];
    assert.equal(row.company, 'Acme Corp');
    assert.equal(row.source, 'greenhouse');
    assert.equal(row.companyId, 'acme');
    assert.equal(row.liveChecked, false);
    assert.equal(row.scrapedAt, daysAgo(0));
    assert.equal(all.items[1].salaryMin, 150000);
    assert.equal(all.items[1].remote, false);

    const two = await runSearch({ keywords: ['data engineer'], maxResults: 2 });
    assert.deepEqual(two.ids, ['g1', 'l1']);
    assert.equal(two.summary.jobsReturned, 2);
    assert.equal(two.summary.jobsMatched, 4);

    const byDefault = await runSearch({});
    assert.equal(byDefault.items.length, 9, 'no filters returns everything up to the default limit of 100');
    assert.equal(byDefault.ids.at(-1), 'l2', 'a job without a date comes last');
});

test('filters: several keywords, exclusions, places, remote, dates, companies and systems', async () => {
    assert.deepEqual((await runSearch({ keywords: ['"machine learning"', 'java'] })).ids, ['x2', 'l2']);
    assert.deepEqual((await runSearch({ keywords: ['engineer'], excludeKeywords: ['senior', 'staff', 'machine'] })).ids, ['x1', 'g3']);
    assert.deepEqual((await runSearch({ locations: ['germany', 'zurich'] })).ids, ['l1', 'x1']);
    assert.deepEqual((await runSearch({ locations: ['US'] })).ids, ['g3']);
    assert.deepEqual((await runSearch({ remoteOnly: true })).ids, ['x2', 'g3', 'l2']);
    assert.deepEqual((await runSearch({ keywords: ['engineer'], postedWithinDays: 3 })).ids, ['x2', 'g1']);
    assert.deepEqual((await runSearch({ companies: ['acme'], keywords: ['engineer'] })).ids, ['g1', 'g3']);
    assert.deepEqual((await runSearch({ companies: ['Acme Corp', 'INITECH'], keywords: ['developer'] })).ids, ['g2', 'l2']);
    assert.deepEqual((await runSearch({ systems: ['lever'] })).ids, ['l1', 'l2']);
    assert.deepEqual((await runSearch({ systems: ['Lever', 'nonsense'] })).summary.systemsRead, ['lever']);
    assert.deepEqual((await runSearch({ keywords: ['engineer'], maxPerCompany: 1 })).ids, ['x2', 'g1', 'l1']);
    assert.deepEqual((await runSearch({ keywords: ['no such job anywhere'] })).ids, []);
});

test('jobMatches and companyMatches work on single items', () => {
    const q = readQuery({ keywords: ['engineer'], locations: ['new york'], postedWithinDays: 7 });
    assert.equal(jobMatches(job('a', 'Data Engineer', { l: 'New York, NY', p: daysAgo(1) }), q, NOW), true);
    assert.equal(jobMatches(job('a', 'Data Engineer', { l: 'York, UK', p: daysAgo(1) }), q, NOW), false);
    assert.equal(jobMatches(job('a', 'Data Engineer', { l: 'Boston', al: ['New York'], p: daysAgo(1) }), q, NOW), true);
    assert.equal(jobMatches(job('a', 'Data Engineer', { l: 'New York', p: daysAgo(9) }), q, NOW), false);
    assert.equal(jobMatches(job('a', 'Data Engineer', { l: 'New York' }), q, NOW), true, 'a job without a date is kept');
    assert.equal(companyMatches({ t: 'hugging-face', n: 'Hugging Face' }, readQuery({ companies: ['hugging face'] })), true);
    assert.equal(companyMatches({ t: 'huggingface', n: 'HF' }, readQuery({ companies: ['Hugging Face'] })), true);
    assert.equal(companyMatches({ t: 'face', n: 'Face Inc' }, readQuery({ companies: ['hugging face'] })), false);
});

test('only-new remembers what it returned, separately for each set of filters', async () => {
    const store = memoryStore();
    const deps = { seenStore: store };
    const input = { keywords: ['data engineer'], maxResults: 2, onlyNewSinceLastRun: true };
    const first = await runSearch(input, { deps });
    assert.deepEqual(first.ids, ['g1', 'l1']);
    assert.equal(first.items[0].isNew, true);
    const second = await runSearch(input, { deps });
    assert.deepEqual(second.ids, ['x1', 'g3'], 'the next run moves on to jobs not returned before');
    const third = await runSearch(input, { deps });
    assert.deepEqual(third.ids, []);
    const other = await runSearch({ keywords: ['developer'], onlyNewSinceLastRun: true }, { deps });
    assert.deepEqual(other.ids, ['g2', 'l2'], 'a different search has its own memory');
    assert.equal(Object.keys(store.data).length, 2);
    assert.notEqual(querySignature(readQuery({ keywords: ['a'] })), querySignature(readQuery({ keywords: ['b'] })));
    assert.equal(querySignature(readQuery({ keywords: ['a', 'b'], maxResults: 5 })), querySignature(readQuery({ keywords: ['b', 'a'], maxResults: 9 })));

    const broken = { get: async () => { throw new Error('down'); }, set: async () => {} };
    assert.deepEqual((await runSearch(input, { deps: { seenStore: broken } })).ids, ['g1', 'l1']);
    assert.deepEqual((await runSearch(input)).ids, ['g1', 'l1'], 'without a store every match is returned');
});

test('live check adds descriptions, drops closed jobs and survives a failing company', async () => {
    const calls = [];
    const fetchLive = async (source, want) => {
        calls.push(`${source.provider}:${source.token}`);
        assert.equal(want.text, true);
        if (source.token === 'acme') {
            return [{ id: 'g1', title: 'Senior Data Engineer (updated)', company: 'acme', source: 'greenhouse', companyId: 'acme', descriptionText: 'Build pipelines.' }];
        }
        if (source.token === 'globex') throw new SourceError('The career site answered HTTP 503');
        if (source.token === 'Initech') throw new SourceError('Not found (HTTP 404)', { notFound: true });
        return [];
    };
    const r = await runSearch({ keywords: ['data engineer'], maxResults: 0, includeDescription: true }, { deps: { fetchLive } });
    assert.deepEqual(calls.sort(), ['greenhouse:acme', 'greenhouse:globex', 'lever:Initech']);
    assert.deepEqual(r.ids, ['g1', 'x1']);
    assert.equal(r.items[0].descriptionText, 'Build pipelines.');
    assert.equal(r.items[0].title, 'Senior Data Engineer (updated)');
    assert.equal(r.items[0].company, 'Acme Corp', 'the index name is kept');
    assert.equal(r.items[0].liveChecked, true);
    assert.equal(r.items[1].liveChecked, false);
    assert.equal(r.items[1].descriptionText, null);
    assert.equal(r.summary.closedSinceIndex, 2, 'g3 is gone from the live feed and the Initech board no longer exists');
    assert.equal(r.summary.liveChecksFailed, 1);

    const limited = await runSearch({ keywords: ['engineer'], maxResults: 2, includeDescription: true }, { deps: { fetchLive: async (s) => (s.token === 'globex' ? [{ id: 'x2', title: 'ML', descriptionText: 'd' }, { id: 'x1', title: 'DE', descriptionText: 'd' }] : []) } });
    assert.deepEqual(limited.ids, ['x2', 'x1'], 'closed jobs are replaced by the next matches so the limit is still filled');
});

test('stops at the spending limit and reports a missing index', async () => {
    const r = await runSearch({ maxResults: 0 }, { limit: 3 });
    assert.equal(r.items.length, 3);
    assert.equal(r.summary.jobsReturned, 3);
    assert.equal(r.summary.stoppedAtSpendingLimit, true);
    assert.match(describe(r.summary, NOW), /spending limit/);

    const partial = await runSearch({}, { index: { greenhouse: INDEX.greenhouse } });
    assert.equal(partial.summary.systemsFailed.length, 3);
    assert.equal(partial.items.length, 7);
    assert.match(describe(partial.summary, NOW), /could not be read \(/);

    const none = await runSearch({}, { index: {} });
    assert.equal(none.summary.failed, true);
    assert.equal(none.items.length, 0);
    assert.match(describe(none.summary, NOW), /could not be read/);
});

test('the status line says how much was found and how fresh the index is', async () => {
    const r = await runSearch({ keywords: ['data engineer'], maxResults: 2 }, { builtAt: daysAgo(0.25) });
    assert.equal(describe(r.summary, NOW), 'Returned 2 jobs of 4 that matched, from an index of 9 open jobs at 3 companies (rebuilt 6 hours ago).');
    const warnings = [];
    await runSearch({}, { builtAt: daysAgo(5), deps: { log: { info() {}, warning: (m) => warnings.push(m) } } });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /out of date/);
});

test('reads compressed index files, skipping damaged lines', async () => {
    const body = [JSON.stringify({ meta: { provider: 'lever', builtAt: daysAgo(0) } }), JSON.stringify(INDEX.lever[0]), '{not json', '', JSON.stringify(INDEX.greenhouse[1])].join('\n');
    const lines = [];
    for await (const line of readLines(Readable.from([gzipSync(Buffer.from(body))]))) lines.push(line);
    assert.equal(lines.length, 3);
    assert.equal(lines[0].meta.provider, 'lever');
    assert.equal(lines[2].t, 'globex');

    await assert.rejects(async () => { for await (const _ of readLines(Readable.from([Buffer.from('not gzip at all')]))) { /* drain */ } });

    let attempts = 0;
    const fetchImpl = async (url) => {
        attempts += 1;
        assert.equal(url, 'https://index.test/base/lever.ndjson.gz');
        if (attempts < 3) return new Response('gone', { status: 404 });
        return new Response(gzipSync(Buffer.from(body)));
    };
    const stream = await openRemote('lever', { baseUrl: 'https://index.test/base/', fetchImpl, waitMs: 1 });
    let n = 0;
    for await (const _ of readLines(stream)) n += 1;
    assert.equal(n, 3);
    assert.equal(attempts, 3, 'waits and retries while the daily file is being swapped');
    await assert.rejects(openRemote('lever', { baseUrl: 'https://index.test/base', fetchImpl: async () => new Response('', { status: 500 }), retries: 2, waitMs: 1 }), /HTTP 500/);
});

test('directory files and the CSV reader', () => {
    assert.deepEqual(parseCsv('name,token\n"Smith, Jones & Co",smith\n"He said ""hi""",x\r\nPlain,p\n'), [['name', 'token'], ['Smith, Jones & Co', 'smith'], ['He said "hi"', 'x'], ['Plain', 'p']]);
    for (const provider of ['greenhouse', 'lever', 'ashby', 'workable']) {
        const list = readDirectory(provider);
        assert.ok(list.length > 2000, `${provider} has ${list.length} companies`);
        assert.ok(list.every((c) => c.token && c.name), `${provider}: every row has a name and a board name`);
        assert.equal(new Set(list.map((c) => c.token.toLowerCase())).size, list.length, `${provider}: no duplicates`);
    }
    assert.equal(companyName('greenhouse', 'stripe', [{ company: 'Stripe, Inc.' }], 'Stripe'), 'Stripe, Inc.');
    assert.equal(companyName('greenhouse', 'stripe', [{ company: 'stripe' }], 'Stripe'), 'Stripe');
    assert.equal(companyName('lever', 'hugging-face', [{ company: 'Hugging Face' }], 'Hugging Face 🤗'), 'Hugging Face 🤗');
    assert.equal(companyName('ashby', 'ramp', [{ company: 'Ramp' }], ''), 'Ramp');
});

test('the crawler indexes companies, slows down when told to, and carries yesterday forward', async () => {
    const boards = {
        stripe: fx.greenhouse,
        empty: { jobs: [] },
    };
    const hits = [];
    const fetchImpl = async (url) => {
        const token = /boards\/([^/]+)\/jobs/.exec(url)[1];
        hits.push(token);
        assert.ok(!url.includes('content=true'), 'the index never asks for descriptions');
        if (token === 'busy') return new Response('slow down', { status: 429 });
        if (token === 'gone') return new Response('no', { status: 404 });
        return new Response(JSON.stringify(boards[token]), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const companies = [{ name: 'Stripe', token: 'stripe' }, { name: 'Empty Co', token: 'empty' }, { name: 'Gone Co', token: 'gone' }, { name: 'Busy Co', token: 'busy' }];
    const logs = [];
    const r = await crawlProvider('greenhouse', companies, { fetchImpl, concurrency: 2, gapMs: 1, log: (m) => logs.push(m), fetchOptions: { retries: 2, backoffMs: 1, minGapMs: 0 }, now: () => NOW });
    assert.equal(r.stats.withJobs, 1);
    assert.equal(r.stats.empty, 1);
    assert.equal(r.stats.notFound, 1);
    assert.equal(r.stats.failed, 1);
    assert.deepEqual(r.notFound, ['gone']);
    assert.equal(r.failed[0].token, 'busy');
    assert.equal(r.stats.slowdowns, 1);
    assert.ok(r.stats.finalGapMs > 1);
    assert.match(logs.join('\n'), /slowing/);
    assert.equal(r.lines.length, 1);
    const line = JSON.parse(r.lines[0]);
    assert.equal(line.p, 'greenhouse');
    assert.equal(line.t, 'stripe');
    assert.equal(line.n, 'Stripe');
    assert.equal(line.j.length, 2, 'the entry with a blank title is left out');
    assert.equal(line.j[0].ti, 'Abuse Investigator');
    assert.equal(JSON.parse(metaLine('greenhouse', r.stats, 'now')).meta.jobs, r.stats.jobs);
    assert.equal(JSON.parse(companyLine('lever', 'a', 'A', [], 'x')).j.length, 0);

    // Yesterday's index: "busy" was read a day ago (kept), "gone" too (not kept: it answered "not found" today).
    const dir = mkdtempSync(path.join(tmpdir(), 'idx-'));
    const previousFile = path.join(dir, 'greenhouse.ndjson.gz');
    const old = (token, days) => JSON.stringify({ p: 'greenhouse', t: token, n: token, at: daysAgo(days), j: [job('1', 'Old job'), job('2', 'Older job')] });
    writeFileSync(previousFile, gzipSync(Buffer.from([metaLine('greenhouse', { withJobs: 2, carriedForward: 0, jobs: 4 }, daysAgo(1)), old('busy', 1), old('gone', 1)].join('\n'))));
    const again = await crawlProvider('greenhouse', companies, { fetchImpl, concurrency: 2, gapMs: 1, log() {}, fetchOptions: { retries: 1, backoffMs: 1, minGapMs: 0 }, now: () => NOW, previousFile });
    assert.equal(again.stats.carriedForward, 1);
    assert.deepEqual(again.lines.map((l) => JSON.parse(l).t), ['busy', 'stripe']);
    assert.equal(again.stats.jobs, 4);
    assert.equal(JSON.parse(metaLine('greenhouse', again.stats, 'now')).meta.companies, 2);

    writeFileSync(previousFile, gzipSync(Buffer.from(old('busy', 5))));
    const stale = await crawlProvider('greenhouse', companies, { fetchImpl, concurrency: 2, gapMs: 1, log() {}, fetchOptions: { retries: 1, backoffMs: 1, minGapMs: 0 }, now: () => NOW, previousFile });
    assert.equal(stale.stats.carriedForward, 0, 'data older than three days is not carried forward');
    rmSync(dir, { recursive: true, force: true });
});
