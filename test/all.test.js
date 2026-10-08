import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, htmlToText, toIso, unique, clean } from '../src/text.js';
import { parseSource, parseSources } from '../src/sources.js';
import { fetchJobs, getJson, normalizeGreenhouse, displayName, SourceError } from '../src/providers.js';
import { run, readOptions, matches, describe } from '../src/run.js';
import { makePusher, RESULT_EVENT, DATASET_EVENT } from '../src/charging.js';
import * as fx from './fixtures.js';

const fast = { retries: 3, backoffMs: 1, timeoutMs: 2000, minGapMs: 0 };
const quiet = { info() {}, warning() {} };
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

test('text helpers', () => {
    assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#39;x&#x27; &nbsp;&unknown;'), "a & b <c> 'x'  &unknown;");
    assert.equal(htmlToText('<h2>Who</h2><p>Stripe &amp; friends.</p><ul><li>One</li><li>Two</li></ul><script>x()</script>'), 'Who\nStripe & friends.\n\n- One\n- Two');
    assert.equal(toIso(1786469891368), new Date(1786469891368).toISOString());
    assert.equal(toIso('2026-05-29'), '2026-05-29T00:00:00.000Z');
    assert.equal(toIso('nonsense'), null);
    assert.deepEqual(unique(['A', ' a ', null, 'B', '']), ['A', 'B']);
    assert.equal(clean('  x \n y '), 'x y');
    assert.equal(clean('   '), null);
});

test('reads career page addresses and short forms', () => {
    const ok = (input, provider, token) => {
        const r = parseSource(input);
        assert.equal(r.error, undefined, `${input}: ${r.error}`);
        assert.equal(r.provider, provider, input);
        assert.equal(r.token, token, input);
    };
    ok('greenhouse:stripe', 'greenhouse', 'stripe');
    ok(' Lever : palantir ', 'lever', 'palantir');
    ok('https://boards.greenhouse.io/stripe', 'greenhouse', 'stripe');
    ok('https://job-boards.greenhouse.io/stripe/jobs/123', 'greenhouse', 'stripe');
    ok('https://job-boards.eu.greenhouse.io/acme', 'greenhouse', 'acme');
    ok('https://boards.greenhouse.io/embed/job_board?for=stripe', 'greenhouse', 'stripe');
    ok('https://boards-api.greenhouse.io/v1/boards/stripe/jobs', 'greenhouse', 'stripe');
    ok('jobs.lever.co/palantir', 'lever', 'palantir');
    ok('https://jobs.eu.lever.co/acme/abc-123', 'lever', 'acme');
    assert.equal(parseSource('https://jobs.eu.lever.co/acme').region, 'eu');
    ok('https://jobs.ashbyhq.com/ramp/34413f8d', 'ashby', 'ramp');
    ok('https://apply.workable.com/huggingface/', 'workable', 'huggingface');
    ok('https://huggingface.workable.com', 'workable', 'huggingface');
    for (const bad of ['', 'https://example.com/jobs', 'indeed:acme', 'https://apply.workable.com/j/81B46579FE', 'greenhouse:bad name', 'https://www.workable.com']) {
        assert.ok(parseSource(bad).error, `should reject: ${bad}`);
    }
    const { sources, problems } = parseSources(['greenhouse:stripe', 'https://boards.greenhouse.io/Stripe', { url: 'ashby:ramp' }, 'https://example.com', '']);
    assert.equal(sources.length, 2);
    assert.equal(problems.length, 1);
    assert.deepEqual(parseSources(undefined), { sources: [], problems: [] });
});

test('greenhouse jobs come out in the shared shape', async () => {
    const f = fx.fakeFetch();
    const jobs = await fetchJobs({ provider: 'greenhouse', token: 'stripe' }, { text: true, html: true }, { ...fast, fetchImpl: f });
    assert.equal(jobs.length, 2, 'the job with a blank title is dropped');
    assert.match(f.calls[0], /content=true$/);
    const j = jobs[0];
    assert.equal(j.company, 'Stripe'); assert.equal(j.source, 'greenhouse'); assert.equal(j.id, '8172508');
    assert.equal(j.title, 'Abuse Investigator'); assert.equal(j.department, '8611 Security Analytics');
    assert.equal(j.location, 'Dublin'); assert.deepEqual(j.allLocations, ['Dublin', 'Ireland Locations']);
    assert.equal(j.postedAt, '2026-09-03T17:32:53.000Z'); assert.equal(j.updatedAt, '2026-09-25T20:45:00.000Z');
    assert.equal(j.url, 'https://stripe.com/jobs/search?gh_jid=8172508'); assert.equal(j.remote, null);
    assert.equal(j.descriptionText, 'Who we are\nStripe & friends.\n\n- Do things\n- More things');
    assert.ok(j.descriptionHtml.startsWith('<h2><strong>Who we are'));
    assert.equal(jobs[1].remote, true); assert.equal(jobs[1].workplaceType, 'remote');
    const light = fx.fakeFetch();
    const noDesc = await fetchJobs({ provider: 'greenhouse', token: 'stripe' }, {}, { ...fast, fetchImpl: light });
    assert.ok(!light.calls[0].includes('content=true')); assert.equal('descriptionText' in noDesc[0], false);
    assert.equal(normalizeGreenhouse({ id: 1, title: 'x' }, { provider: 'greenhouse', token: 'acme' }).company, 'acme');
});

test('lever jobs', async () => {
    const jobs = await fetchJobs({ provider: 'lever', token: 'palantir' }, { text: true }, { ...fast, fetchImpl: fx.fakeFetch() });
    assert.equal(jobs.length, 2);
    const [a, b] = jobs;
    assert.equal(a.title, 'Administrative Business Partner'); assert.equal(a.employmentType, 'Full-time');
    assert.equal(a.location, 'Singapore, Singapore'); assert.equal(a.country, 'SG'); assert.equal(a.workplaceType, 'hybrid'); assert.equal(a.remote, false);
    assert.equal(a.postedAt, new Date(1786469891368).toISOString());
    assert.equal(a.applyUrl, 'https://jobs.lever.co/palantir/6ed76ce8/apply');
    assert.match(a.descriptionText, /^A World-Changing Company\n\nWhat you will do\n- Plan\n- Organise\n\nPalantir is particularly/);
    assert.equal(b.remote, true); assert.equal(b.salaryMin, 100000); assert.equal(b.salaryMax, 150000);
    assert.equal(b.salaryText, '100000 - 150000 USD per-year-salary'); assert.equal(b.applyUrl, 'https://jobs.lever.co/palantir/abc');
});

test('lever falls back to the EU host when the main one has no such board', async () => {
    const f = fx.fakeFetch({
        'api.eu.lever.co/v0/postings/euco': async () => ({ ok: true, status: 200, json: async () => [{ id: 'e1', text: 'Analyst', categories: {}, hostedUrl: 'https://jobs.eu.lever.co/euco/e1' }] }),
    });
    const jobs = await fetchJobs({ provider: 'lever', token: 'euco' }, {}, { ...fast, fetchImpl: f });
    assert.equal(jobs.length, 1);
    assert.deepEqual(f.calls.map((c) => new URL(c).host), ['api.lever.co', 'api.eu.lever.co']);
});

test('ashby jobs: unlisted roles are dropped and pay is read', async () => {
    const jobs = await fetchJobs({ provider: 'ashby', token: 'ramp' }, { text: true }, { ...fast, fetchImpl: fx.fakeFetch() });
    assert.equal(jobs.length, 1);
    const j = jobs[0];
    assert.equal(j.title, 'Security Engineer, Cloud'); assert.equal(j.team, 'Backend'); assert.equal(j.remote, true); assert.equal(j.workplaceType, 'hybrid');
    assert.deepEqual(j.allLocations, ['New York, NY (HQ)', 'Remote (Canada)', 'Miami']); assert.equal(j.country, 'USA');
    assert.equal(j.salaryText, '$211.4K - $290.6K'); assert.equal(j.salaryMin, 211400); assert.equal(j.salaryMax, 290600); assert.equal(j.salaryCurrency, 'USD');
    assert.equal(j.postedAt, '2026-04-07T17:12:35.753Z'); assert.equal(j.descriptionText, 'ABOUT RAMP\n\nRamp is building');
});

test('workable jobs', async () => {
    const f = fx.fakeFetch();
    const jobs = await fetchJobs({ provider: 'workable', token: 'huggingface' }, { text: true }, { ...fast, fetchImpl: f });
    assert.match(f.calls[0], /details=true$/);
    const j = jobs[0];
    assert.equal(j.company, 'Hugging Face'); assert.equal(j.id, '81B46579FE'); assert.equal(j.remote, true);
    assert.equal(j.location, 'Paris, Île-de-France, France'); assert.deepEqual(j.allLocations, ['Paris, Île-de-France, France', 'Berlin, Germany']);
    assert.equal(j.postedAt, '2026-05-29T00:00:00.000Z'); assert.equal(j.applyUrl, 'https://apply.workable.com/j/81B46579FE/apply');
    assert.equal(j.descriptionText, "At Hugging Face, we're on a journey.");
});

test('getJson retries busy servers, gives up on missing boards at once', async () => {
    let n = 0;
    const flaky = async () => { n += 1; return n < 3 ? { ok: false, status: 503, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ fine: true }) }; };
    assert.deepEqual(await getJson('https://x.test', { ...fast, fetchImpl: flaky }), { fine: true });
    assert.equal(n, 3);
    let m = 0;
    const missing = async () => { m += 1; return { ok: false, status: 404, json: async () => ({}) }; };
    await assert.rejects(getJson('https://x.test', { ...fast, fetchImpl: missing }), (e) => e instanceof SourceError && e.notFound === true);
    assert.equal(m, 1);
    let k = 0;
    const down = async () => { k += 1; throw new TypeError('fetch failed'); };
    await assert.rejects(getJson('https://x.test', { ...fast, fetchImpl: down }), /Could not reach/);
    assert.equal(k, 3);
    let b = 0;
    const blocked = async () => { b += 1; return { ok: false, status: 403, json: async () => ({}) }; };
    await assert.rejects(getJson('https://x.test', { ...fast, fetchImpl: blocked }), /HTTP 403/);
    assert.equal(b, 1);
    const notJson = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } });
    await assert.rejects(getJson('https://x.test', { ...fast, fetchImpl: notJson }), /did not return job data/);
});

test('filters', () => {
    const now = Date.parse('2026-10-08T00:00:00Z');
    const job = { title: 'Senior Backend Engineer', location: 'Berlin', allLocations: ['Berlin', 'Remote (EU)'], country: 'DE', remote: true, postedAt: '2026-10-01T00:00:00Z' };
    const o = (input) => readOptions(input);
    assert.ok(matches(job, o({}), now));
    assert.ok(matches(job, o({ titleIncludes: ['ENGINEER', 'designer'] }), now));
    assert.ok(!matches(job, o({ titleIncludes: ['designer'] }), now));
    assert.ok(!matches(job, o({ titleExcludes: ['senior'] }), now));
    assert.ok(matches(job, o({ locationIncludes: ['remote'] }), now));
    assert.ok(!matches(job, o({ locationIncludes: ['london'] }), now));
    assert.ok(matches(job, o({ remoteOnly: true }), now));
    assert.ok(!matches({ ...job, remote: null }, o({ remoteOnly: true }), now));
    assert.ok(matches(job, o({ postedWithinDays: 7 }), now));
    assert.ok(!matches(job, o({ postedWithinDays: 3 }), now));
    assert.ok(matches({ ...job, postedAt: null }, o({ postedWithinDays: 3 }), now), 'jobs without a date are kept');
    assert.deepEqual(o({ includeDescription: false, includeDescriptionHtml: true }).want, { text: false, html: false });
    assert.deepEqual(o({}).want, { text: true, html: false });
    assert.equal(o({ maxJobsPerCompany: '5.9' }).maxJobsPerCompany, 5);
    assert.equal(o({ maxJobsPerCompany: -2 }).maxJobsPerCompany, 0);
});

test('a full run with the default companies returns jobs from all four systems', async () => {
    const out = collector();
    const summary = await run({ companies: ['greenhouse:stripe', 'lever:palantir', 'ashby:ramp', 'workable:huggingface'] },
        { pushJobs: out.pushJobs, log: quiet, fetchImpl: fx.fakeFetch(), fetchOptions: fast });
    assert.equal(summary.companiesOk, 4); assert.equal(summary.companiesFailed.length, 0);
    assert.equal(summary.jobsFound, 6); assert.equal(summary.jobsReturned, 6); assert.equal(out.items.length, 6);
    assert.deepEqual([...new Set(out.items.map((i) => i.source))].sort(), ['ashby', 'greenhouse', 'lever', 'workable']);
    for (const item of out.items) {
        assert.ok(item.id && item.title && item.url && item.company && item.scrapedAt, JSON.stringify(item).slice(0, 120));
        assert.equal('isNew' in item, false);
        assert.equal(typeof item.descriptionText, 'string');
    }
    assert.equal(describe(summary), 'Returned 6 jobs from 4 of 4 companies.');
});

test('one bad company does not sink the run; bad lines are reported', async () => {
    const out = collector();
    const summary = await run({ companies: ['greenhouse:stripe', 'greenhouse:doesnotexist', 'https://example.com/careers'], titleIncludes: ['engineer'], maxJobsPerCompany: 1 },
        { pushJobs: out.pushJobs, log: quiet, fetchImpl: fx.fakeFetch(), fetchOptions: fast });
    assert.equal(summary.companiesRequested, 3); assert.equal(summary.companiesOk, 1); assert.equal(summary.companiesFailed.length, 2);
    assert.match(summary.companiesFailed.find((f) => f.input === 'greenhouse:doesnotexist').reason, /No public job board/);
    assert.equal(out.items.length, 1); assert.equal(out.items[0].title, 'Backend Engineer, Payments');
    assert.match(describe(summary), /Returned 1 job from 1 of 3 companies \(2 open in total\)\. 2 could not be read/);
});

test('no companies falls back to the starter list; nothing readable returns nothing', async () => {
    const out = collector();
    const none = await run({ companies: ['', '  '] }, { pushJobs: out.pushJobs, log: quiet, fetchImpl: fx.fakeFetch(), fetchOptions: fast });
    assert.equal(none.usedStarterList, true); assert.equal(none.companiesOk, 4); assert.equal(out.items.length, 6, 'empty input falls back to the starter list');
    out.items.length = 0;
    const allBad = await run({ companies: ['lever:nope'] }, { pushJobs: out.pushJobs, log: quiet, fetchImpl: fx.fakeFetch(), fetchOptions: fast });
    assert.equal(allBad.companiesOk, 0); assert.equal(allBad.companiesFailed.length, 1); assert.equal(out.items.length, 0);
});

test('only-new mode: first run returns all, second none, a new posting comes through alone, a closed one is forgotten', async () => {
    const store = memoryStore();
    const input = { companies: ['lever:palantir'], onlyNewSinceLastRun: true, includeDescription: false };
    const feed = structuredClone(fx.lever);
    const f = fx.fakeFetch({ 'api.lever.co/v0/postings/palantir': async () => ({ ok: true, status: 200, json: async () => structuredClone(feed) }) });
    const first = collector();
    await run(input, { pushJobs: first.pushJobs, seenStore: store, log: quiet, fetchImpl: f, fetchOptions: fast });
    assert.equal(first.items.length, 2); assert.ok(first.items.every((i) => i.isNew === true));
    assert.deepEqual(store.data['seen-lever-palantir'].ids.sort(), ['6ed76ce8-4156-4b60-b120-403538bd66cd', 'abc']);
    const second = collector();
    const s2 = await run(input, { pushJobs: second.pushJobs, seenStore: store, log: quiet, fetchImpl: f, fetchOptions: fast });
    assert.equal(second.items.length, 0); assert.equal(s2.jobsFound, 2); assert.equal(s2.jobsReturned, 0);
    feed.push({ id: 'new1', text: 'Data Analyst', categories: {}, hostedUrl: 'https://jobs.lever.co/palantir/new1' });
    feed.shift();
    const third = collector();
    await run(input, { pushJobs: third.pushJobs, seenStore: store, log: quiet, fetchImpl: f, fetchOptions: fast });
    assert.deepEqual(third.items.map((i) => i.id), ['new1']);
    assert.deepEqual(store.data['seen-lever-palantir'].ids.sort(), ['abc', 'new1']);
});

test('only-new mode without a working memory still returns jobs', async () => {
    const a = collector();
    await run({ companies: ['ashby:ramp'], onlyNewSinceLastRun: true }, { pushJobs: a.pushJobs, seenStore: null, log: quiet, fetchImpl: fx.fakeFetch(), fetchOptions: fast });
    assert.equal(a.items.length, 1);
    const b = collector();
    const broken = { get: async () => { throw new Error('denied'); }, set: async () => { throw new Error('denied'); } };
    await run({ companies: ['ashby:ramp'], onlyNewSinceLastRun: true }, { pushJobs: b.pushJobs, seenStore: broken, log: quiet, fetchImpl: fx.fakeFetch(), fetchOptions: fast });
    assert.equal(b.items.length, 1);
});

test('stops at the spending limit and only remembers what was actually returned', async () => {
    const store = memoryStore();
    const out = collector(1);
    const summary = await run({ companies: ['lever:palantir', 'greenhouse:stripe', 'ashby:ramp'], onlyNewSinceLastRun: true },
        { pushJobs: out.pushJobs, seenStore: store, log: quiet, fetchImpl: fx.fakeFetch(), fetchOptions: fast });
    assert.equal(out.items.length, 1); assert.equal(summary.jobsReturned, 1); assert.equal(summary.stoppedAtSpendingLimit, true);
    const remembered = Object.values(store.data).flatMap((v) => v.ids);
    assert.deepEqual(remembered, [out.items[0].id]);
    assert.match(describe(summary), /Stopped early because your spending limit/);
});

test('large boards are saved in batches', async () => {
    const big = { jobs: Array.from({ length: 450 }, (_, i) => ({ id: i + 1, title: `Role ${i + 1}`, absolute_url: `https://x.test/${i + 1}`, location: { name: 'Anywhere' } })) };
    const f = fx.fakeFetch({ 'boards/bigco/jobs': async () => ({ ok: true, status: 200, json: async () => big }) });
    const sizes = [];
    const pushJobs = async (batch) => { sizes.push(batch.length); return { stop: false }; };
    const summary = await run({ companies: ['greenhouse:bigco'], includeDescription: false }, { pushJobs, log: quiet, fetchImpl: f, fetchOptions: fast });
    assert.deepEqual(sizes, [200, 200, 50]); assert.equal(summary.jobsReturned, 450);
});

test('requests to one site are spaced out, different sites are not held up', async () => {
    const stamps = [];
    const f = async (url) => { stamps.push([new URL(url).host, Date.now()]); return { ok: true, status: 200, json: async () => ({ jobs: [] }) }; };
    const t0 = Date.now();
    await Promise.all([
        getJson('https://one.test/a', { fetchImpl: f, minGapMs: 120 }),
        getJson('https://one.test/b', { fetchImpl: f, minGapMs: 120 }),
        getJson('https://one.test/c', { fetchImpl: f, minGapMs: 120 }),
        getJson('https://two.test/a', { fetchImpl: f, minGapMs: 120 }),
    ]);
    const one = stamps.filter((s) => s[0] === 'one.test').map((s) => s[1]).sort((a, b) => a - b);
    assert.ok(one[1] - one[0] >= 100 && one[2] - one[1] >= 100, `gaps ${one[1] - one[0]} and ${one[2] - one[1]}`);
    assert.ok(stamps.find((s) => s[0] === 'two.test')[1] - t0 < 80, 'the other site starts at once');
});

test('no personal contact fields are ever copied from a feed', async () => {
    const withPeople = structuredClone(fx.lever);
    withPeople[0].owner = { name: 'HARNESS Recruiter', email: 'harness@example.test' };
    withPeople[0].hiringManager = 'HARNESS Manager';
    const f = fx.fakeFetch({ 'api.lever.co/v0/postings/palantir': async () => ({ ok: true, status: 200, json: async () => withPeople }) });
    const out = collector();
    await run({ companies: ['lever:palantir'] }, { pushJobs: out.pushJobs, log: quiet, fetchImpl: f, fetchOptions: fast });
    assert.ok(!JSON.stringify(out.items).includes('HARNESS'));
    const allowed = new Set(['company', 'source', 'companyId', 'id', 'title', 'department', 'team', 'location', 'allLocations', 'country', 'remote', 'workplaceType',
        'employmentType', 'postedAt', 'updatedAt', 'url', 'applyUrl', 'salaryMin', 'salaryMax', 'salaryCurrency', 'salaryInterval', 'salaryText',
        'descriptionText', 'descriptionHtml', 'isNew', 'scrapedAt']);
    for (const item of out.items) for (const key of Object.keys(item)) assert.ok(allowed.has(key), `unexpected field ${key}`);
});

test('companies without a name in their feed get a readable one', async () => {
    assert.equal(displayName('ramp'), 'Ramp');
    assert.equal(displayName('hugging-face'), 'Hugging Face');
    assert.equal(displayName('acme_co.eu'), 'Acme Co Eu');
    assert.equal(displayName('OpenAI'), 'OpenAI');
    assert.equal(displayName(''), '');
    const out = collector();
    await run({ companies: ['ashby:ramp', 'lever:palantir', 'greenhouse:stripe'], includeDescription: false }, { pushJobs: out.pushJobs, log: quiet, fetchImpl: fx.fakeFetch(), fetchOptions: fast });
    assert.deepEqual([...new Set(out.items.map((i) => i.company))].sort(), ['Palantir', 'Ramp', 'Stripe']);
    assert.ok(out.items.every((i) => i.companyId === i.companyId.toLowerCase()), 'the raw board name stays in companyId');
});

test('charging: never bills a job twice, whatever pricing is set in the Console', async () => {
    const calls = [];
    const pushData = async (items, eventName) => { calls.push([items.length, eventName]); return eventName ? { eventChargeLimitReached: false, chargedCount: items.length } : undefined; };
    const manager = (prices, max = Infinity) => ({ getPricingInfo: () => ({ isPayPerEvent: true, perEventPrices: prices }), calculateMaxEventChargeCountWithinLimit: () => max });
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }];

    // No pricing at all (the Actor is free, or the platform gives no charging manager).
    for (const cm of [null, undefined, {}, { getPricingInfo: () => { throw new Error('x'); } }, manager({})]) {
        calls.length = 0;
        const p = makePusher({ pushData, chargingManager: cm });
        assert.equal(p.mode, 'free');
        assert.deepEqual(await p.pushJobs(items), { stop: false });
        assert.deepEqual(calls, [[3, undefined]]);
    }

    // Built-in per-result event only: the platform charges, the code passes no event name.
    calls.length = 0;
    let p = makePusher({ pushData, chargingManager: manager({ 'apify-actor-start': 0.00005, [DATASET_EVENT]: 0.0015 }) });
    assert.equal(p.mode, 'builtin');
    assert.deepEqual(await p.pushJobs(items), { stop: false });
    assert.deepEqual(calls, [[3, undefined]]);

    // Both events priced by mistake: still only the built-in one is used.
    calls.length = 0;
    p = makePusher({ pushData, chargingManager: manager({ [DATASET_EVENT]: 0.0015, [RESULT_EVENT]: 0.0015 }) });
    assert.equal(p.mode, 'builtin');
    await p.pushJobs(items);
    assert.deepEqual(calls, [[3, undefined]]);

    // Custom event only: charged from code, by name.
    calls.length = 0;
    p = makePusher({ pushData, chargingManager: manager({ [RESULT_EVENT]: 0.0015 }) });
    assert.equal(p.mode, 'custom');
    assert.deepEqual(await p.pushJobs(items), { stop: false });
    assert.deepEqual(calls, [[3, RESULT_EVENT]]);
    const limited = makePusher({ pushData: async () => ({ eventChargeLimitReached: true, chargedCount: 2 }), chargingManager: manager({ [RESULT_EVENT]: 0.0015 }) });
    assert.deepEqual(await limited.pushJobs(items), { stop: true, pushed: 2 });
});

test('charging: with the built-in event it stops at the number of results the spending limit covers', async () => {
    const saved = [];
    const pushData = async (items) => { saved.push(...items); };
    const cm = { getPricingInfo: () => ({ perEventPrices: { [DATASET_EVENT]: 0.0015 } }), calculateMaxEventChargeCountWithinLimit: () => 5 };
    const p = makePusher({ pushData, chargingManager: cm });
    assert.deepEqual(await p.pushJobs([{ id: 1 }, { id: 2 }, { id: 3 }]), { stop: false });
    assert.deepEqual(await p.pushJobs([{ id: 4 }, { id: 5 }, { id: 6 }]), { stop: true, pushed: 2 });
    assert.deepEqual(await p.pushJobs([{ id: 7 }]), { stop: true, pushed: 0 });
    assert.deepEqual(saved.map((i) => i.id), [1, 2, 3, 4, 5]);
    const broken = { getPricingInfo: () => ({ perEventPrices: { [DATASET_EVENT]: 0.0015 } }), calculateMaxEventChargeCountWithinLimit: () => { throw new Error('x'); } };
    assert.deepEqual(await makePusher({ pushData, chargingManager: broken }).pushJobs([{ id: 8 }]), { stop: false });

    // End to end through run(): a limit of 4 results across companies.
    const out = [];
    const four = makePusher({ pushData: async (items) => { out.push(...items); }, chargingManager: { getPricingInfo: () => ({ perEventPrices: { [DATASET_EVENT]: 0.0015 } }), calculateMaxEventChargeCountWithinLimit: () => 4 } });
    const summary = await run({ companies: ['greenhouse:stripe', 'lever:palantir', 'ashby:ramp', 'workable:huggingface'] }, { pushJobs: four.pushJobs, log: quiet, fetchImpl: fx.fakeFetch(), fetchOptions: fast });
    assert.equal(out.length, 4); assert.equal(summary.jobsReturned, 4); assert.equal(summary.stoppedAtSpendingLimit, true);
});
