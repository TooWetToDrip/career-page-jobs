#!/usr/bin/env node
// Builds the job index used by the Career Site Job Search Actor.
//
// For every company in directory/*.csv it reads that company's public job feed once
// (the same feed its public career page shows) and writes one compressed file per hiring
// system. Each line is one company with its open jobs in short form (see src/compact.js).
// No job descriptions and no personal data are stored.
//
// Usage: node indexer/build-index.js --out dist-index [--limit 50] [--providers greenhouse,lever]
//                                    [--previous prev-index] [--concurrency 6]

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

// How long to wait between two requests to the same site. Slows down by itself when a site says "too many requests".
const START_GAP_MS = { greenhouse: 250, lever: 350, ashby: 350, workable: 600 };
const MAX_GAP_MS = 5000;
// A company whose feed could not be read today keeps yesterday's jobs for this long.
const CARRY_FORWARD_MS = 3 * 86400000;

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
 * @returns {Promise<{lines: string[], stats: object}>}
 */
export async function crawlProvider(provider, companies, opts = {}) {
    const { concurrency = 6, log = console.log, fetchOptions = {}, now = Date.now, fetchImpl } = opts;
    let gapMs = opts.gapMs ?? START_GAP_MS[provider] ?? 500;
    const lines = [];
    const stats = { provider, companies: companies.length, withJobs: 0, empty: 0, notFound: 0, failed: 0, carriedForward: 0, jobs: 0, slowdowns: 0 };
    const notFound = [];
    const failed = [];
    const started = now();
    let done = 0;
    const queue = companies.slice();

    async function worker() {
        while (queue.length) {
            const company = queue.shift();
            const source = { provider, token: company.token };
            try {
                const call = { retries: 2, timeoutMs: 25000, backoffMs: 2000, userAgent: USER_AGENT, ...fetchOptions, minGapMs: fetchOptions.minGapMs ?? gapMs };
                if (fetchImpl) call.fetchImpl = fetchImpl;
                const jobs = await fetchJobs(source, {}, call);
                if (jobs.length) {
                    stats.withJobs += 1;
                    stats.jobs += jobs.length;
                    lines.push(companyLine(provider, company.token, companyName(provider, company.token, jobs, company.name), jobs, new Date(now()).toISOString()));
                } else stats.empty += 1;
            } catch (err) {
                if (err && err.notFound) {
                    stats.notFound += 1;
                    notFound.push(company.token);
                } else {
                    stats.failed += 1;
                    const reason = (err && err.message) || 'error';
                    failed.push({ token: company.token, reason });
                    if (/HTTP 429/.test(reason) && gapMs < MAX_GAP_MS) {
                        gapMs = Math.min(MAX_GAP_MS, Math.round(gapMs * 1.5));
                        stats.slowdowns += 1;
                        log(`[${provider}] too many requests: slowing to one request every ${gapMs} ms`);
                    }
                }
            }
            done += 1;
            if (done % 500 === 0) log(`[${provider}] ${done}/${companies.length} read, ${stats.jobs} jobs, ${stats.failed} failed`);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, companies.length) }, worker));

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
    stats.finalGapMs = gapMs;
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

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const outDir = path.resolve(String(args.out || 'dist-index'));
    const limit = Number(args.limit) > 0 ? Math.floor(Number(args.limit)) : 0;
    const providers = args.providers ? String(args.providers).split(',').map((s) => s.trim()).filter((p) => PROVIDERS.includes(p)) : PROVIDERS;
    const concurrency = Number(args.concurrency) > 0 ? Math.floor(Number(args.concurrency)) : 6;
    const previousDir = args.previous ? path.resolve(String(args.previous)) : null;
    mkdirSync(outDir, { recursive: true });

    const builtAt = new Date().toISOString();
    const results = await Promise.all(providers.map(async (provider) => {
        let companies = readDirectory(provider);
        if (limit) {
            // A spread-out sample, not just the first names in the alphabet.
            const step = Math.max(1, Math.floor(companies.length / limit));
            companies = companies.filter((_, i) => i % step === 0).slice(0, limit);
        }
        const result = await crawlProvider(provider, companies, {
            concurrency,
            previousFile: previousDir ? path.join(previousDir, `${provider}.ndjson.gz`) : null,
        });
        console.log(`[${provider}] done in ${result.stats.seconds}s: ${JSON.stringify(result.stats)}`);
        return { provider, ...result };
    }));

    const summary = { version: INDEX_VERSION, builtAt, sample: Boolean(limit), providers: {}, totals: { companies: 0, withJobs: 0, jobs: 0, notFound: 0, failed: 0 } };
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
        sample.push(...r.lines.slice(0, 15).map((line) => (line.length > 6000 ? `${line.slice(0, 6000)}…` : line)));
        writeFileSync(path.join(outDir, `${r.provider}-not-found.txt`), r.notFound.sort().join('\n') + (r.notFound.length ? '\n' : ''));
        writeFileSync(path.join(outDir, `${r.provider}-failed.json`), JSON.stringify(r.failed.slice(0, 2000), null, 1));
    }
    writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(summary, null, 2));
    writeFileSync(path.join(outDir, 'sample.ndjson'), sample.join('\n') + '\n');
    console.log(`Totals: ${JSON.stringify(summary.totals)}`);

    // Refuse to publish an index that is mostly holes (for example when a site blocks the machine doing the reading).
    const reachable = summary.totals.withJobs + results.reduce((n, r) => n + r.stats.empty + r.stats.notFound, 0);
    if (summary.totals.companies > 0 && reachable / summary.totals.companies < 0.6) {
        console.error('Fewer than 60% of the companies could be read. Not publishing this index.');
        process.exit(2);
    }
    for (const r of results) {
        const answered = r.stats.withJobs + r.stats.empty + r.stats.notFound + r.stats.carriedForward;
        if (r.stats.companies > 20 && answered / r.stats.companies < 0.5) {
            console.error(`[${r.provider}] fewer than half of its companies could be read. Not publishing this index.`);
            process.exit(2);
        }
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
