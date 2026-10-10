import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compactJob, expandJob } from '../src/compact.js';
import { words, parseTerm, termMatches, anyPhraseIn, hasPhrase } from '../src/match.js';
import { normalizeLever, normalizeAshby, SourceError } from '../src/providers.js';
import { parseCsv, companyName, companyLine, crawlProvider, metaLine, readDirectory, Pacer, buildIndex, publishProblem, NOT_REACHED } from '../indexer/build-index.js';
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
    const summary = await search(input, { openIndex: openIndex(extra.index, extra.builtAt), pushJobs: out.pushJobs, log: quiet, now: () => NOW, retryWaitMs: 1, ...extra.deps });
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

test('a download that breaks halfway is read again without counting anything twice', async () => {
    let opened = 0;
    const flaky = async function* open(provider) {
        if (provider !== 'greenhouse') { yield* openIndex()(provider); return; }
        opened += 1;
        yield { meta: { provider, builtAt: daysAgo(0) } };
        yield INDEX.greenhouse[0];
        if (opened === 1) throw new Error('aborted');
        yield INDEX.greenhouse[1];
    };
    const r = await runSearch({ keywords: ['data engineer'], maxResults: 0 }, { deps: { openIndex: flaky } });
    assert.equal(opened, 2);
    assert.deepEqual(r.ids, ['g1', 'l1', 'x1', 'g3']);
    assert.equal(r.summary.jobsInIndex, 9);
    assert.equal(r.summary.jobsMatched, 4);
    assert.deepEqual(r.summary.systemsFailed, []);
});

test('by default no single company can fill the list', async () => {
    const many = Array.from({ length: 25 }, (_, i) => job(`s${i}`, 'Personal Trainer', { p: daysAgo(i) }));
    const index = { greenhouse: [{ p: 'greenhouse', t: 'gym', n: 'Gym', at: daysAgo(0), j: many }, INDEX.greenhouse[0]], lever: [], ashby: [], workable: [] };
    const r = await runSearch({ maxResults: 0 }, { index });
    assert.equal(r.items.filter((x) => x.companyId === 'gym').length, 5);
    assert.deepEqual(r.items.filter((x) => x.companyId === 'gym').map((x) => x.id), many.slice(0, 5).map((j) => j.i), 'the newest five are kept');
    assert.equal(r.items.length, 9);
    assert.equal(r.summary.jobsMatched, 29);
    assert.equal(r.summary.leftOutByCompanyCap, 20);
    assert.match(describe(r.summary, NOW), /At most 5 per company were kept/);
    const all = await runSearch({ maxResults: 0, maxPerCompany: 0 }, { index });
    assert.equal(all.items.length, 29);
    assert.doesNotMatch(describe(all.summary, NOW), /per company/);
    assert.equal(readQuery({}).maxPerCompany, 5);
    assert.equal(readQuery({ maxPerCompany: 0 }).maxPerCompany, 0);
    assert.equal(readQuery({ maxPerCompany: 3 }).maxPerCompany, 3);
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

/* ---------------- the daily build: pacing, time budget, second try ---------------- */

const ghBoard = (n = 1) => ({ jobs: Array.from({ length: n }, (_, i) => ({ id: i + 1, title: `Engineer ${i + 1}`, absolute_url: `https://example.test/${i + 1}`, location: { name: 'Remote' } })) });
const ghToken = (url) => /boards\/([^/]+)\/jobs/.exec(url)[1];
const jsonResponse = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
const oldLine = (token, days, jobs = 2, provider = 'greenhouse') => JSON.stringify({ p: provider, t: token, n: token, at: daysAgo(days), j: Array.from({ length: jobs }, (_, i) => job(String(i + 1), 'Old job')) });
const fast = { retries: 1, backoffMs: 1, minGapMs: 0 };

test('pacing: a burst of "too many requests" is one slowdown, and the gap has a ceiling', () => {
    const T = NOW;
    const p = new Pacer({ startGapMs: 600 });
    assert.equal(p.gapMs, 600);
    // What happened on October 10: three refusals within seconds. One event, 900 ms, not 2025 ms.
    assert.equal(p.slowDown(T), true);
    assert.equal(p.slowDown(T + 800), false);
    assert.equal(p.slowDown(T + 2500), false);
    assert.equal(p.slowDown(T + 59999), false);
    assert.equal(p.gapMs, 900);
    assert.equal(p.slowdowns, 1);
    // A refusal a minute later is a new event.
    assert.equal(p.slowDown(T + 60000), true);
    assert.equal(p.gapMs, 1350);
    assert.equal(p.slowDown(T + 120000), true);
    assert.equal(p.gapMs, 2000, 'capped at 2000 ms (1.5 x 1350 would be 2025)');
    assert.equal(p.slowDown(T + 180000), false, 'already at the ceiling');
    assert.equal(p.slowDown(T + 900000), false);
    assert.equal(p.gapMs, 2000);
    assert.equal(p.peakGapMs, 2000);
    assert.equal(p.slowdowns, 3);
    for (const start of [250, 350, 600]) {
        const q = new Pacer({ startGapMs: start });
        for (let i = 0; i < 50; i++) q.slowDown(T + i * 60000);
        assert.equal(q.gapMs, 2000, `a site starting at ${start} ms never waits longer than 2000 ms`);
    }
});

test('pacing: the gap comes back down after 100 clean reads in a row, never below where it started', () => {
    const cleans = (p, n) => { let changed = 0; for (let i = 0; i < n; i++) if (p.clean()) changed += 1; return changed; };
    const p = new Pacer({ startGapMs: 600 });
    assert.equal(cleans(p, 500), 0, 'nothing to recover while at the starting gap');
    assert.equal(p.gapMs, 600);
    p.slowDown(NOW);
    assert.equal(p.gapMs, 900);
    assert.equal(cleans(p, 99), 0);
    assert.equal(p.gapMs, 900, '99 clean reads are not enough');
    assert.equal(p.clean(), true);
    assert.equal(p.gapMs, 810);
    assert.equal(cleans(p, 100), 1);
    assert.equal(p.gapMs, 729);
    assert.equal(cleans(p, 100), 1);
    assert.equal(p.gapMs, 656);
    assert.equal(cleans(p, 100), 1);
    assert.equal(p.gapMs, 600, 'stops at the starting gap (0.9 x 656 would be 590)');
    assert.equal(cleans(p, 5000), 0);
    assert.equal(p.gapMs, 600);
    assert.equal(p.speedups, 4);
    assert.equal(p.peakGapMs, 900);

    // A refusal in the middle starts the count again, even when it is part of the same burst.
    const q = new Pacer({ startGapMs: 600 });
    q.slowDown(NOW);
    cleans(q, 99);
    assert.equal(q.slowDown(NOW + 1000), false);
    assert.equal(cleans(q, 99), 0);
    assert.equal(q.gapMs, 900);
    assert.equal(q.clean(), true);
    assert.equal(q.gapMs, 810);

    // From the ceiling all the way back, for every site: never below the start, never above the ceiling.
    for (const start of [1, 250, 350, 600]) {
        const r = new Pacer({ startGapMs: start });
        for (let i = 0; i < 20; i++) r.slowDown(NOW + i * 60000);
        const top = r.gapMs;
        let last = top;
        for (let i = 0; i < 100 * 60; i++) {
            r.clean();
            assert.ok(r.gapMs >= start && r.gapMs <= last);
            last = r.gapMs;
        }
        assert.equal(r.gapMs, start, `back to ${start} ms from ${top} ms`);
    }
});

test('the crawler counts a burst once, speeds up again, and reports refusals that a second try got past', async () => {
    const seen = {};
    const fetchImpl = async (url) => {
        const token = ghToken(url);
        seen[token] = (seen[token] || 0) + 1;
        if (token.startsWith('busy')) return new Response('slow down', { status: 429 });
        if (token === 'hiccup' && seen[token] === 1) return new Response('slow down', { status: 429 });
        return jsonResponse(ghBoard(1));
    };
    const names = (prefix, n) => Array.from({ length: n }, (_, i) => ({ name: `${prefix} ${i}`, token: `${prefix}${i}` }));
    const logs = [];
    const opts = { fetchImpl, concurrency: 1, gapMs: 100, log: (m) => logs.push(m), fetchOptions: { retries: 2, backoffMs: 1, minGapMs: 0 }, now: () => NOW };

    // Three refusals in a row, then 99 good reads: one slowdown, no speed-up yet.
    let r = await crawlProvider('greenhouse', [...names('busy', 3), ...names('ok', 99)], opts);
    assert.equal(r.stats.failed, 3);
    assert.equal(r.stats.slowdowns, 1, 'three refusals close together are one slowdown');
    assert.equal(r.stats.tooManyRequests, 3);
    assert.equal(r.stats.finalGapMs, 150);
    assert.equal(r.stats.speedups, 0);
    assert.equal(logs.filter((m) => /slowing/.test(m)).length, 1);

    // One more good read makes 100 in a row: the gap shrinks by a tenth.
    r = await crawlProvider('greenhouse', [...names('busy', 3), ...names('ok', 100)], opts);
    assert.equal(r.stats.slowdowns, 1);
    assert.equal(r.stats.peakGapMs, 150);
    assert.equal(r.stats.finalGapMs, 135);
    assert.equal(r.stats.speedups, 1);
    assert.equal(r.stats.withJobs, 100);

    // Enough good reads bring it all the way back to the start, and no further.
    r = await crawlProvider('greenhouse', [...names('busy', 1), ...names('ok', 700)], opts);
    assert.equal(r.stats.finalGapMs, 100);
    assert.equal(r.stats.peakGapMs, 150);

    // A refusal on the first try that the second try got past: the company is read and the pace is left alone
    // (as before), but it is counted, so the daily numbers show how often a site pushes back.
    seen.hiccup = 0;
    r = await crawlProvider('greenhouse', [{ name: 'Hiccup', token: 'hiccup' }, ...names('ok', 20)], opts);
    assert.equal(seen.hiccup, 2);
    assert.equal(r.stats.failed, 0);
    assert.equal(r.stats.withJobs, 21);
    assert.equal(r.stats.slowdowns, 0);
    assert.equal(r.stats.finalGapMs, 100);
    assert.equal(r.stats.tooManyRequests, 1);
});

test('time budget: companies not reached are recorded as failed and filled from the previous index', async () => {
    let clock = NOW;
    const hits = [];
    const fetchImpl = async (url) => {
        hits.push(ghToken(url));
        clock += 1000; // every read takes one second
        return jsonResponse(ghBoard(1));
    };
    const companies = Array.from({ length: 10 }, (_, i) => ({ name: `Co ${i}`, token: `c${i}` }));
    const dir = mkdtempSync(path.join(tmpdir(), 'idx-'));
    const previousFile = path.join(dir, 'greenhouse.ndjson.gz');
    // c4..c7 were read yesterday (3 jobs each), c8 five days ago (too old), c9 had no jobs. c0 is in there too but is read today.
    writeFileSync(previousFile, gzipSync(Buffer.from([oldLine('c0', 1, 9), oldLine('c4', 1, 3), oldLine('c5', 1, 3), oldLine('c6', 1, 3), oldLine('c7', 1, 3), oldLine('c8', 5, 3)].join('\n'))));
    const waits = [];
    const logs = [];
    const r = await crawlProvider('greenhouse', companies, {
        fetchImpl, concurrency: 1, gapMs: 1, log: (m) => logs.push(m), fetchOptions: fast, now: () => clock, previousFile,
        deadline: NOW + 4000, retry: {}, sleep: async (ms) => { waits.push(ms); },
    });
    assert.deepEqual(hits, ['c0', 'c1', 'c2', 'c3'], 'no company is started once the time is up');
    assert.equal(r.stats.budgetHit, true);
    assert.equal(r.stats.notReached, 6);
    assert.equal(r.stats.failed, 6);
    assert.equal(r.stats.withJobs, 4);
    assert.equal(r.failed.length, 6);
    assert.deepEqual(r.failed.map((f) => f.token), ['c4', 'c5', 'c6', 'c7', 'c8', 'c9']);
    assert.ok(r.failed.every((f) => f.reason === NOT_REACHED));
    assert.equal(NOT_REACHED, 'not reached (time budget)');
    assert.equal(r.stats.carriedForward, 4, 'yesterday fills the ones not reached; five-day-old data does not');
    assert.deepEqual(r.lines.map((l) => JSON.parse(l).t), ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']);
    assert.equal(JSON.parse(r.lines[0]).j.length, 1, 'a company read today uses today\'s jobs, not yesterday\'s');
    assert.equal(r.stats.jobs, 4 + 4 * 3);
    assert.equal(r.stats.retried, 0);
    assert.deepEqual(waits, [], 'nothing is retried once the time is up');
    assert.match(logs.join('\n'), /time budget reached: 6 of 10/);
    assert.equal(JSON.parse(metaLine('greenhouse', r.stats, 'now')).meta.companies, 8);

    // With time to spare nothing changes: every company is read and nothing is marked.
    hits.length = 0;
    clock = NOW;
    const all = await crawlProvider('greenhouse', companies, { fetchImpl, concurrency: 3, gapMs: 1, log() {}, fetchOptions: fast, now: () => clock, previousFile, deadline: NOW + 3600000, retry: {} });
    assert.equal(hits.length, 10);
    assert.equal(all.stats.budgetHit, false);
    assert.equal(all.stats.notReached, 0);
    assert.equal(all.stats.failed, 0);
    assert.equal(all.stats.carriedForward, 0);
    assert.equal(all.failed.length, 0);
    rmSync(dir, { recursive: true, force: true });
});

test('second try: a company that timed out is read again after a pause, with a longer timeout', async () => {
    // "big" needs 150 ms to answer. The first pass allows 30 ms, the second try 2000 ms.
    const calls = [];
    const fetchImpl = (url, init) => {
        const token = ghToken(url);
        calls.push(token);
        if (token !== 'big') return Promise.resolve(jsonResponse(ghBoard(1)));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve(jsonResponse(ghBoard(40))), 150);
            init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal.reason); });
        });
    };
    const companies = [{ name: 'Big Co', token: 'big' }, { name: 'Small Co', token: 'small' }];
    const waits = [];
    const sleep = async (ms) => { waits.push(ms); };
    const base = { fetchImpl, concurrency: 2, gapMs: 1, log() {}, fetchOptions: { ...fast, timeoutMs: 30 }, sleep };

    const without = await crawlProvider('greenhouse', companies, base);
    assert.equal(without.stats.failed, 1);
    assert.match(without.failed[0].reason, /TimeoutError/);
    assert.equal(without.stats.retried, 0, 'no second try unless asked for');
    assert.deepEqual(waits, []);

    calls.length = 0;
    const r = await crawlProvider('greenhouse', companies, { ...base, retry: { timeoutMs: 2000 } });
    assert.deepEqual(waits, [60000], 'waits a minute before trying again');
    assert.deepEqual(calls, ['big', 'small', 'big'], 'only the failed company is tried again, once');
    assert.equal(r.stats.failed, 0);
    assert.equal(r.failed.length, 0);
    assert.equal(r.stats.retried, 1);
    assert.equal(r.stats.retryRecovered, 1);
    assert.equal(r.stats.withJobs, 2);
    assert.equal(r.stats.jobs, 41);
    assert.equal(r.stats.budgetHit, false);
    assert.deepEqual(r.lines.map((l) => JSON.parse(l).t), ['big', 'small']);

    // Still too slow on the second try: it stays failed, and the reason for the second failure is kept too.
    calls.length = 0;
    const still = await crawlProvider('greenhouse', companies, { ...base, retry: { timeoutMs: 40 } });
    assert.equal(still.stats.failed, 1);
    assert.equal(still.stats.retried, 1);
    assert.equal(still.stats.retryRecovered, 0);
    assert.equal(still.failed[0].token, 'big');
    assert.match(still.failed[0].retry, /TimeoutError/);
    assert.equal(calls.filter((t) => t === 'big').length, 2);
});

test('second try: largest companies first, a ceiling on how many, and never past the time budget', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'idx-'));
    const previousFile = path.join(dir, 'greenhouse.ndjson.gz');
    // Sizes known from the previous index: d has 9 jobs, b has 5 (four days old: too old to reuse, fine for ordering), a has 2.
    writeFileSync(previousFile, gzipSync(Buffer.from([oldLine('a', 1, 2), oldLine('b', 4, 5), oldLine('d', 1, 9)].join('\n'))));
    const companies = ['a', 'b', 'c', 'd', 'e', 'gone'].map((t) => ({ name: t.toUpperCase(), token: t }));
    let clock = NOW;
    let phase = 'first';
    const second = [];
    const fetchImpl = async (url) => {
        const token = ghToken(url);
        if (phase === 'second') {
            second.push(token);
            clock += 40000; // a second try takes 40 seconds
            if (token === 'gone') return new Response('no', { status: 404 });
            if (token === 'd') return jsonResponse(ghBoard(10));
        }
        return new Response('broken', { status: 500 });
    };
    const sleep = async (ms) => { clock += ms; phase = 'second'; };
    const base = { fetchImpl, concurrency: 1, gapMs: 1, log() {}, fetchOptions: fast, now: () => clock, previousFile, sleep };
    const reset = () => { clock = NOW; phase = 'first'; second.length = 0; };

    // No limits: all six are tried again, the ones with a known size first (largest first), the rest in their order.
    let r = await crawlProvider('greenhouse', companies, { ...base, retry: {} });
    assert.deepEqual(second, ['d', 'b', 'a', 'c', 'e', 'gone']);
    assert.equal(r.stats.retried, 6);
    assert.equal(r.stats.retryRecovered, 2, 'one answered with jobs, one answered "not found"');
    assert.equal(r.stats.failed, 4);
    assert.equal(r.stats.notFound, 1);
    assert.deepEqual(r.notFound, ['gone']);
    assert.deepEqual(r.failed.map((f) => f.token), ['a', 'b', 'c', 'e']);
    assert.ok(r.failed.every((f) => /HTTP 500/.test(f.reason) && /HTTP 500/.test(f.retry)));
    assert.equal(r.stats.carriedForward, 1, 'only "a" is filled from the previous index: "d" was read today, "b" is too old');
    assert.deepEqual(r.lines.map((l) => JSON.parse(l).t), ['a', 'd']);
    assert.equal(JSON.parse(r.lines[1]).j.length, 10, 'today\'s read replaces yesterday\'s line');
    assert.equal(r.stats.jobs, 12);
    assert.equal(r.stats.budgetHit, false);

    // A ceiling of two: only the two largest are tried again.
    reset();
    r = await crawlProvider('greenhouse', companies, { ...base, retry: { max: 2 } });
    assert.deepEqual(second, ['d', 'b']);
    assert.equal(r.stats.retried, 2);
    assert.equal(r.stats.failed, 5);
    assert.equal(r.failed.filter((f) => f.retry).length, 1);
    assert.equal(r.stats.budgetHit, false, 'the ceiling is not the time budget');

    // The budget ends 90 seconds after the pause: two second tries start (at 0 s and 40 s), the third (80 s) too, the fourth not.
    reset();
    r = await crawlProvider('greenhouse', companies, { ...base, retry: {}, deadline: NOW + 60000 + 90000 });
    assert.deepEqual(second, ['d', 'b', 'a']);
    assert.equal(r.stats.retried, 3);
    assert.equal(r.stats.budgetHit, true);
    assert.equal(r.stats.notReached, 0, 'every company was tried once; only second tries were cut');
    assert.equal(r.stats.failed, 5);

    // Less than the pause left: no pause and no second try at all.
    reset();
    r = await crawlProvider('greenhouse', companies, { ...base, retry: {}, deadline: NOW + 59000 });
    assert.deepEqual(second, []);
    assert.equal(phase, 'first', 'did not even wait');
    assert.equal(r.stats.retried, 0);
    assert.equal(r.stats.budgetHit, true);
    assert.equal(r.stats.failed, 6);
    assert.equal(r.stats.carriedForward, 2, '"a" and "d" are filled from the previous index');
    rmSync(dir, { recursive: true, force: true });
});

test('a build that runs out of time still publishes: files written, exit code 0, and meta.json says so', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'idx-'));
    const directoryDir = path.join(dir, 'directory');
    const previousDir = path.join(dir, 'prev');
    const outDir = path.join(dir, 'out');
    mkdirSync(directoryDir);
    mkdirSync(previousDir);
    const tokens = Array.from({ length: 30 }, (_, i) => `g${String(i + 1).padStart(2, '0')}`);
    writeFileSync(path.join(directoryDir, 'greenhouse.csv'), `name,token\n${tokens.map((t) => `Company ${t},${t}`).join('\n')}\n`);
    // Yesterday's index has 15 of the 20 companies that will not be reached (g11..g25), with 2 jobs each.
    writeFileSync(path.join(previousDir, 'greenhouse.ndjson.gz'), gzipSync(Buffer.from(tokens.slice(10, 25).map((t) => oldLine(t, 1, 2)).join('\n'))));

    let clock = NOW;
    const fetchImpl = async () => { clock += 60000; return jsonResponse(ghBoard(3)); }; // every read takes a minute
    const logs = [];
    const run = (extra) => buildIndex({ outDir, providers: ['greenhouse'], concurrency: 1, maxMinutes: 10, directoryDir, now: () => clock, log: (m) => logs.push(m), crawl: { fetchImpl, fetchOptions: fast, sleep: async () => {} }, ...extra });

    const built = await run({ previousDir });
    assert.equal(built.exitCode, 0, 'running out of time is not a failure');
    assert.equal(built.problem, null);
    const meta = JSON.parse(readFileSync(path.join(outDir, 'meta.json'), 'utf8'));
    assert.deepEqual(meta, built.summary);
    assert.equal(meta.budgetHit, true);
    assert.equal(meta.notReached, 20);
    assert.equal(meta.maxMinutes, 10);
    assert.equal(meta.seconds, 600);
    assert.equal(meta.builtAt, new Date(NOW).toISOString());
    assert.equal(meta.sample, false);
    assert.deepEqual(meta.totals, { companies: 30, withJobs: 25, jobs: 10 * 3 + 15 * 2, notFound: 0, failed: 20, carriedForward: 15, notReached: 20, retryRecovered: 0 });
    const g = meta.providers.greenhouse;
    assert.equal(g.withJobs, 10);
    assert.equal(g.carriedForward, 15);
    assert.equal(g.failed, 20);
    assert.equal(g.notReached, 20);
    assert.equal(g.budgetHit, true);
    for (const key of ['provider', 'companies', 'withJobs', 'empty', 'notFound', 'failed', 'carriedForward', 'jobs', 'slowdowns', 'seconds', 'finalGapMs', 'bytes', 'rawBytes']) {
        assert.ok(key in g, `meta.json keeps the field "${key}"`);
    }
    const failedList = JSON.parse(readFileSync(path.join(outDir, 'greenhouse-failed.json'), 'utf8'));
    assert.deepEqual(failedList.map((f) => f.token), tokens.slice(10));
    assert.ok(failedList.every((f) => f.reason === 'not reached (time budget)'));
    const indexLines = gunzipSync(readFileSync(path.join(outDir, 'greenhouse.ndjson.gz'))).toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(indexLines[0].meta, { version: 1, provider: 'greenhouse', builtAt: meta.builtAt, companies: 25, jobs: 60 });
    assert.deepEqual(indexLines.slice(1).map((l) => l.t), tokens.slice(0, 25));
    assert.equal(indexLines[1].at, new Date(NOW + 60000).toISOString(), 'read today');
    assert.equal(indexLines[11].at, daysAgo(1), 'filled from yesterday');
    assert.equal(readFileSync(path.join(outDir, 'greenhouse-not-found.txt'), 'utf8'), '');
    assert.match(logs.join('\n'), /time budget was reached: 20 companies/);

    // The same short run with no previous index to fill from would be mostly holes: that is still refused.
    clock = NOW;
    const hollow = await run({ previousDir: null });
    assert.equal(hollow.summary.budgetHit, true);
    assert.equal(hollow.exitCode, 2);
    assert.match(hollow.problem, /Not publishing/);

    // With enough time everything is read and nothing is marked.
    clock = NOW;
    const full = await run({ previousDir, maxMinutes: 100 });
    assert.equal(full.exitCode, 0);
    assert.equal(full.summary.budgetHit, false);
    assert.equal(full.summary.notReached, 0);
    assert.equal(full.summary.totals.failed, 0);
    assert.equal(full.summary.totals.withJobs, 30);
    assert.equal(full.summary.seconds, 1800);
    rmSync(dir, { recursive: true, force: true });
});

test('the publish check counts companies filled from the previous index as answered', () => {
    const stats = (provider, companies, withJobs, empty, notFound, carriedForward) => ({ provider, companies, withJobs, empty, notFound, carriedForward });
    // The real October 10 build.
    assert.equal(publishProblem([stats('greenhouse', 6031, 4852, 695, 482, 2), stats('lever', 2402, 1940, 386, 76, 0), stats('ashby', 3448, 2876, 338, 234, 0), stats('workable', 4752, 2584, 2123, 42, 0)]), null);
    // Workable cut off after 3,000 companies, the rest filled from the day before where they had jobs.
    assert.equal(publishProblem([stats('greenhouse', 6031, 4852, 695, 482, 2), stats('workable', 4752, 1630, 1340, 30, 950)]), null);
    // A site that blocks the machine: nothing read, nothing to fill from.
    assert.match(publishProblem([stats('greenhouse', 6031, 4852, 695, 482, 2), stats('lever', 2402, 1940, 386, 76, 0), stats('ashby', 3448, 2876, 338, 234, 0), stats('workable', 4752, 0, 0, 0, 0)]), /\[workable\] fewer than half/);
    assert.match(publishProblem([stats('greenhouse', 100, 20, 10, 5, 0), stats('lever', 100, 60, 10, 5, 0)]), /Fewer than 60%/);
    assert.equal(publishProblem([]), null);
});
