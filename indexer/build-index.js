#!/usr/bin/env node
// Builds the job index used by the Career Site Job Search Actor.
//
// For every company in directory/*.csv it reads that company's public job feed once
// (the same feed its public career page shows) and writes one compressed file per hiring
// system. Each line is one company with its open jobs in short form (see src/compact.js).
// No job descriptions and no personal data are stored.
//
// Usage: node indexer/build-index.js --out dist-index [--limit 50] [--providers greenhouse,lever]
//                                    [--previous prev-index] [--concurrency 6] [--max-minutes 100]
//
// The build keeps to a time budget (--max-minutes). When the budget runs out it stops starting new
// companies, fills the ones it did not reach from the previous index, and still publishes.

import { createGunzip, gzipSync } from 'node:zlib';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJobs, displayName } from '../src/providers.js';
import { compactJob, INDEX_VERSION } from '../src/compact.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROVIDERS = ['greenhouse', 'lever', 'ashby', 'workable'];
const USER_AGENT = 'career-page-jobs-indexer/1.0 (+https://github.com/TooWetToDrip/career-page-jobs)';

// How long to wait between two requests to the same site. Slows down by itself when a site says "too many requests",
// and speeds up again once the site has been quiet for a while (see Pacer).
const START_GAP_MS = { greenhouse: 250, lever: 350, ashby: 350, workable: 600 };
const MAX_GAP_MS = 2000;
// Several "too many requests" answers close together are one event: at most one slowdown per site in this time.
const SLOWDOWN_QUIET_MS = 60000;
// After this many companies in a row are read without a "too many requests", the gap shrinks by a tenth.
const RECOVER_AFTER = 100;
const RECOVER_FACTOR = 0.9;
// The whole build stops starting new companies after this many minutes (--max-minutes).
const DEFAULT_MAX_MINUTES = 100;
export const NOT_REACHED = 'not reached (time budget)';
// Companies that failed are tried once more at the end: after a pause, with a longer timeout, the largest first.
const RETRY_WAIT_MS = 60000;
const RETRY_TIMEOUT_MS = 60000;
const RETRY_MAX = 200;
// A company whose feed could not be read today keeps yesterday's jobs for this long.
const CARRY_FORWARD_MS = 3 * 86400000;

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Decides how long to wait between two requests to one site. No clock and no network of its own:
 * the caller reports what happened and reads gapMs.
 */
export class Pacer {
    constructor({ startGapMs = 500, maxGapMs = MAX_GAP_MS, quietMs = SLOWDOWN_QUIET_MS, recoverAfter = RECOVER_AFTER, slowBy = 1.5, recoverBy = RECOVER_FACTOR } = {}) {
        this.startGapMs = startGapMs;
        this.maxGapMs = Math.max(maxGapMs, startGapMs);
        this.quietMs = quietMs;
        this.recoverAfter = recoverAfter;
        this.slowBy = slowBy;
        this.recoverBy = recoverBy;
        this.gapMs = startGapMs;
        this.peakGapMs = startGapMs;
        this.slowdowns = 0;
        this.speedups = 0;
        this.cleanInARow = 0;
        this.lastSlowdownAt = -Infinity;
    }

    /** A company could not be read because the site said "too many requests". True when this slowed the pace. */
    slowDown(nowMs) {
        this.cleanInARow = 0;
        if (nowMs - this.lastSlowdownAt < this.quietMs) return false; // part of the same burst
        if (this.gapMs >= this.maxGapMs) return false;
        this.lastSlowdownAt = nowMs;
        this.gapMs = Math.min(this.maxGapMs, Math.round(this.gapMs * this.slowBy));
        this.peakGapMs = Math.max(this.peakGapMs, this.gapMs);
        this.slowdowns += 1;
        return true;
    }

    /** A company was dealt with without a "too many requests" failure. True when this shortened the gap. */
    clean() {
        if (this.gapMs <= this.startGapMs) return false;
        this.cleanInARow += 1;
        if (this.cleanInARow < this.recoverAfter) return false;
        this.cleanInARow = 0;
        this.gapMs = Math.max(this.startGapMs, Math.floor(this.gapMs * this.recoverBy));
        this.speedups += 1;
        return true;
    }
}

/** Minimal CSV reader: handles quoted fields with commas and doubled quotes. */
export function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
            } else field += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ',') { row.push(field); field = ''; }
        else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && text[i + 1] === '\n') i++;
            row.push(field); field = '';
            if (row.length > 1 || row[0] !== '') rows.push(row);
            row = [];
        } else field += ch;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
}

export function readDirectory(provider, dir = path.join(ROOT, 'directory')) {
    const rows = parseCsv(readFileSync(path.join(dir, `${provider}.csv`), 'utf8'));
    const header = rows.shift() || [];
    const nameAt = header.indexOf('name');
    const tokenAt = header.indexOf('token');
    return rows
        .map((r) => ({ name: (r[nameAt] || '').trim(), token: (r[tokenAt] || '').trim() }))
        .filter((c) => c.token);
}

/** The company name to show: the feed's own name when it has one, else the directory's. */
export function companyName(provider, token, jobs, directoryName) {
    const fromFeed = jobs.length ? jobs[0].company : null;
    const generic = !fromFeed || fromFeed === token || fromFeed === displayName(token);
    if ((provider === 'greenhouse' || provider === 'workable') && !generic) return fromFeed;
    return directoryName || fromFeed || token;
}

export function companyLine(provider, token, name, jobs, at) {
    return JSON.stringify({ p: provider, t: token, n: name, at, j: jobs.map(compactJob) });
}

async function readPreviousLines(file, wantedTokens, sinceMs) {
    const found = new Map();
    if (!wantedTokens.size || !existsSync(file)) return found;
    const lines = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
    try {
        for await (const line of lines) {
            if (!line || line.startsWith('{"meta"')) continue;
            let obj;
            try { obj = JSON.parse(line); } catch { continue; }
            if (!obj || !wantedTokens.has(obj.t)) continue;
            const at = Date.parse(obj.at);
            if (Number.isFinite(at) && at >= sinceMs) found.set(obj.t, line);
        }
    } catch {
        // An unreadable previous index only means nothing is carried forward.
    }
    return found;
}

/**
 * Crawl one hiring system.
 *
 * Options beyond the obvious ones:
 *   deadline  a clock time (ms). Once it is reached no new company is started; the companies not reached are
 *             recorded as failed with the reason NOT_REACHED, so they are filled from the previous index.
 *   retry     {waitMs, timeoutMs, max}: when given, companies that failed are tried once more at the end.
 * @returns {Promise<{lines: string[], stats: object, notFound: string[], failed: object[]}>}
 */
export async function crawlProvider(provider, companies, opts = {}) {
    const { concurrency = 6, log = console.log, fetchOptions = {}, now = Date.now, fetchImpl, sleep = pause } = opts;
    const deadline = Number.isFinite(opts.deadline) ? opts.deadline : Infinity;
    const pacer = new Pacer({ startGapMs: opts.gapMs ?? START_GAP_MS[provider] ?? 500 });
    const lines = [];
    const stats = { provider, companies: companies.length, withJobs: 0, empty: 0, notFound: 0, failed: 0, carriedForward: 0, jobs: 0, slowdowns: 0 };
    const notFound = [];
    let failed = [];
    const started = now();
    let done = 0;
    let tooManyRequests = 0;
    let outOfTime = false;
    const queue = companies.slice();

    /** Read one company's feed once. Answers {jobs}, {notFound: true} or {reason}; also keeps the pace up to date. */
    async function readBoard(company, extra = {}) {
        const baseFetch = fetchImpl || fetchOptions.fetchImpl || fetch;
        let sawTooMany = false;
        const call = { retries: 2, timeoutMs: 25000, backoffMs: 2000, userAgent: USER_AGENT, ...fetchOptions, ...extra, minGapMs: fetchOptions.minGapMs ?? pacer.gapMs };
        // Look at each answer on its way past, only to count them: a "too many requests" that the second try got
        // through changes nothing about the pace, but the daily numbers should show how often a site pushes back.
        call.fetchImpl = async (url, init) => {
            const res = await baseFetch(url, init);
            if (res && res.status === 429) sawTooMany = true;
            return res;
        };
        let outcome;
        try {
            outcome = { jobs: await fetchJobs({ provider, token: company.token }, {}, call) };
        } catch (err) {
            outcome = err && err.notFound ? { notFound: true } : { reason: (err && err.message) || 'error' };
        }
        const refused = Boolean(outcome.reason) && /HTTP 429/.test(outcome.reason);
        if (refused || sawTooMany) tooManyRequests += 1;
        if (refused) {
            if (pacer.slowDown(now())) {
                stats.slowdowns = pacer.slowdowns;
                log(`[${provider}] too many requests: slowing to one request every ${pacer.gapMs} ms`);
            }
        } else if (pacer.clean()) log(`[${provider}] quiet for ${pacer.recoverAfter} companies: back to one request every ${pacer.gapMs} ms`);
        return outcome;
    }

    /** Record a company that answered (with jobs, with none, or "not found"). */
    function keep(company, outcome) {
        if (outcome.notFound) {
            stats.notFound += 1;
            notFound.push(company.token);
            return;
        }
        const { jobs } = outcome;
        if (jobs.length) {
            stats.withJobs += 1;
            stats.jobs += jobs.length;
            lines.push(companyLine(provider, company.token, companyName(provider, company.token, jobs, company.name), jobs, new Date(now()).toISOString()));
        } else stats.empty += 1;
    }

    async function worker() {
        while (queue.length && now() < deadline) {
            const company = queue.shift();
            const outcome = await readBoard(company);
            if (outcome.reason) {
                stats.failed += 1;
                failed.push({ token: company.token, reason: outcome.reason });
            } else keep(company, outcome);
            done += 1;
            if (done % 500 === 0) log(`[${provider}] ${done}/${companies.length} read, ${stats.jobs} jobs, ${stats.failed} failed`);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, companies.length) }, worker));

    // Second chance for the companies that failed: a pause, then one try each with a longer timeout.
    const retry = opts.retry ? { waitMs: RETRY_WAIT_MS, timeoutMs: RETRY_TIMEOUT_MS, max: RETRY_MAX, ...opts.retry } : null;
    let retried = 0;
    let retryRecovered = 0;
    if (retry && failed.length) {
        if (now() + retry.waitMs >= deadline) {
            outOfTime = true;
            log(`[${provider}] no time left to retry the ${failed.length} that failed`);
        } else {
            let order = failed.slice();
            if (opts.previousFile && order.length > 1) {
                // Largest first, going by the previous index; a company not in it keeps its place after the known ones.
                const before = await readPreviousLines(opts.previousFile, new Set(order.map((f) => f.token)), -Infinity);
                const size = (f) => {
                    try { return JSON.parse(before.get(f.token)).j.length; } catch { return 0; }
                };
                order = order.map((f) => ({ f, n: size(f) })).sort((a, b) => b.n - a.n).map((x) => x.f);
            }
            const todo = order.slice(0, retry.max);
            const byToken = new Map(companies.map((c) => [c.token, c]));
            log(`[${provider}] ${failed.length} failed: waiting ${Math.round(retry.waitMs / 1000)}s, then trying ${todo.length} once more with a ${Math.round(retry.timeoutMs / 1000)}s timeout`);
            await sleep(retry.waitMs);
            const recovered = new Set();
            const retryWorker = async () => {
                while (todo.length) {
                    if (now() >= deadline) { outOfTime = true; return; }
                    const entry = todo.shift();
                    const company = byToken.get(entry.token);
                    retried += 1;
                    const outcome = await readBoard(company, { retries: 1, timeoutMs: retry.timeoutMs });
                    if (outcome.reason) entry.retry = outcome.reason;
                    else {
                        keep(company, outcome);
                        stats.failed -= 1;
                        retryRecovered += 1;
                        recovered.add(entry);
                    }
                }
            };
            await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, retryWorker));
            failed = failed.filter((f) => !recovered.has(f));
            log(`[${provider}] second try: ${retryRecovered} of ${retried} read`);
        }
    }

    // Out of time: whatever is still waiting counts as failed today, so the previous index can fill it below.
    const notReached = queue.length;
    if (notReached) {
        outOfTime = true;
        for (const company of queue.splice(0)) failed.push({ token: company.token, reason: NOT_REACHED });
        stats.failed += notReached;
        log(`[${provider}] time budget reached: ${notReached} of ${companies.length} companies not reached`);
    }

    if (opts.previousFile && failed.length) {
        const wanted = new Set(failed.map((f) => f.token));
        const previous = await readPreviousLines(opts.previousFile, wanted, now() - CARRY_FORWARD_MS);
        for (const line of previous.values()) {
            lines.push(line);
            stats.carriedForward += 1;
            try { stats.jobs += JSON.parse(line).j.length; } catch { /* ignore */ }
        }
    }

    lines.sort();
    stats.seconds = Math.round((now() - started) / 1000);
    stats.finalGapMs = pacer.gapMs;
    stats.peakGapMs = pacer.peakGapMs;
    stats.speedups = pacer.speedups;
    stats.tooManyRequests = tooManyRequests;
    stats.notReached = notReached;
    stats.budgetHit = outOfTime;
    stats.retried = retried;
    stats.retryRecovered = retryRecovered;
    return { lines, stats, notFound, failed };
}

export function metaLine(provider, stats, builtAt) {
    return JSON.stringify({ meta: { version: INDEX_VERSION, provider, builtAt, companies: stats.withJobs + stats.carriedForward, jobs: stats.jobs } });
}

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const next = argv[i + 1];
            if (next === undefined || next.startsWith('--')) args[a.slice(2)] = true;
            else { args[a.slice(2)] = next; i++; }
        }
    }
    return args;
}

/**
 * Why this index must not be published, or null when it is fine. Companies filled from the previous index count
 * as answered; companies that could be neither read nor filled are holes.
 */
export function publishProblem(statsList) {
    const companies = statsList.reduce((n, s) => n + s.companies, 0);
    // Refuse to publish an index that is mostly holes (for example when a site blocks the machine doing the reading).
    const reachable = statsList.reduce((n, s) => n + s.withJobs + s.carriedForward + s.empty + s.notFound, 0);
    if (companies > 0 && reachable / companies < 0.6) return 'Fewer than 60% of the companies could be read. Not publishing this index.';
    for (const s of statsList) {
        const answered = s.withJobs + s.empty + s.notFound + s.carriedForward;
        if (s.companies > 20 && answered / s.companies < 0.5) return `[${s.provider}] fewer than half of its companies could be read. Not publishing this index.`;
    }
    return null;
}

/**
 * Build the whole index into outDir.
 * @returns {Promise<{summary: object, problem: string|null, exitCode: number}>} exitCode 0 means "publish this"
 */
export async function buildIndex(options = {}) {
    const { providers = PROVIDERS, limit = 0, concurrency = 6, previousDir = null, maxMinutes = DEFAULT_MAX_MINUTES, directoryDir, now = Date.now, log = console.log, crawl = {} } = options;
    const outDir = path.resolve(String(options.outDir || 'dist-index'));
    mkdirSync(outDir, { recursive: true });

    const startedAt = now();
    const deadline = startedAt + maxMinutes * 60000;
    const builtAt = new Date(startedAt).toISOString();
    const results = await Promise.all(providers.map(async (provider) => {
        let companies = readDirectory(provider, directoryDir);
        if (limit) {
            // A spread-out sample, not just the first names in the alphabet.
            const step = Math.max(1, Math.floor(companies.length / limit));
            companies = companies.filter((_, i) => i % step === 0).slice(0, limit);
        }
        const result = await crawlProvider(provider, companies, {
            concurrency,
            previousFile: previousDir ? path.join(previousDir, `${provider}.ndjson.gz`) : null,
            deadline,
            retry: {},
            now,
            log,
            ...crawl,
        });
        log(`[${provider}] done in ${result.stats.seconds}s: ${JSON.stringify(result.stats)}`);
        return { provider, ...result };
    }));

    const summary = { version: INDEX_VERSION, builtAt, sample: Boolean(limit), providers: {}, totals: { companies: 0, withJobs: 0, jobs: 0, notFound: 0, failed: 0, carriedForward: 0, notReached: 0, retryRecovered: 0 } };
    const sample = [];
    for (const r of results) {
        const body = [metaLine(r.provider, r.stats, builtAt), ...r.lines].join('\n') + '\n';
        const gz = gzipSync(Buffer.from(body, 'utf8'), { level: 9 });
        writeFileSync(path.join(outDir, `${r.provider}.ndjson.gz`), gz);
        summary.providers[r.provider] = { ...r.stats, bytes: gz.length, rawBytes: Buffer.byteLength(body) };
        summary.totals.companies += r.stats.companies;
        summary.totals.withJobs += r.stats.withJobs + r.stats.carriedForward;
        summary.totals.jobs += r.stats.jobs;
        summary.totals.notFound += r.stats.notFound;
        summary.totals.failed += r.stats.failed;
        summary.totals.carriedForward += r.stats.carriedForward;
        summary.totals.notReached += r.stats.notReached;
        summary.totals.retryRecovered += r.stats.retryRecovered;
        sample.push(...r.lines.slice(0, 15).map((line) => (line.length > 6000 ? `${line.slice(0, 6000)}…` : line)));
        writeFileSync(path.join(outDir, `${r.provider}-not-found.txt`), r.notFound.sort().join('\n') + (r.notFound.length ? '\n' : ''));
        writeFileSync(path.join(outDir, `${r.provider}-failed.json`), JSON.stringify(r.failed.slice(0, 2000), null, 1));
    }
    // Did the time budget cut anything short, and how much.
    summary.maxMinutes = maxMinutes;
    summary.seconds = Math.round((now() - startedAt) / 1000);
    summary.budgetHit = results.some((r) => r.stats.budgetHit);
    summary.notReached = summary.totals.notReached;
    writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(summary, null, 2));
    writeFileSync(path.join(outDir, 'sample.ndjson'), sample.join('\n') + '\n');
    log(`Totals: ${JSON.stringify(summary.totals)}`);
    if (summary.budgetHit) log(`The ${maxMinutes}-minute time budget was reached: ${summary.notReached} companies not reached today.`);

    // Running out of time is not a failure by itself: the index is published as long as it is not mostly holes.
    const problem = publishProblem(results.map((r) => r.stats));
    return { summary, problem, exitCode: problem ? 2 : 0 };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const { problem, exitCode } = await buildIndex({
        outDir: args.out || 'dist-index',
        limit: Number(args.limit) > 0 ? Math.floor(Number(args.limit)) : 0,
        providers: args.providers ? String(args.providers).split(',').map((s) => s.trim()).filter((p) => PROVIDERS.includes(p)) : PROVIDERS,
        concurrency: Number(args.concurrency) > 0 ? Math.floor(Number(args.concurrency)) : 6,
        previousDir: args.previous ? path.resolve(String(args.previous)) : null,
        maxMinutes: Number(args['max-minutes']) > 0 ? Number(args['max-minutes']) : DEFAULT_MAX_MINUTES,
    });
    if (problem) {
        console.error(problem);
        process.exit(exitCode);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
