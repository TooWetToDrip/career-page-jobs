// The whole search, with the platform pieces (reading the index, saving results, remembering
// seen jobs, live checks) passed in. That keeps this file testable without the Apify platform.

import { createHash } from 'node:crypto';
import { expandJob } from '../../../src/compact.js';
import { anyPhraseIn, anyTermMatches, parseTerms, words } from '../../../src/match.js';

export const PROVIDERS = ['greenhouse', 'lever', 'ashby', 'workable'];
const PUSH_BATCH = 200;
const MAX_SEEN = 50000;
const LIVE_CONCURRENCY = 4;
const STALE_AFTER_MS = 3 * 86400000;
// Without a cap, a handful of staffing firms and chains with thousands of near-identical ads fill every list.
export const DEFAULT_MAX_PER_COMPANY = 5;

function wholeNumber(value, fallback = 0) {
    if (value === undefined || value === null || value === '') return fallback;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Read the input once and turn it into the filters used below. */
export function readQuery(input = {}) {
    const systems = (Array.isArray(input.systems) ? input.systems : [])
        .map((s) => String(s ?? '').trim().toLowerCase()).filter((s) => PROVIDERS.includes(s));
    const includeDescription = input.includeDescription === true;
    return {
        keywords: parseTerms(input.keywords),
        excludeKeywords: parseTerms(input.excludeKeywords),
        locations: parseTerms(input.locations),
        companies: parseTerms(input.companies),
        systems: systems.length ? [...new Set(systems)] : PROVIDERS.slice(),
        remoteOnly: input.remoteOnly === true,
        postedWithinDays: wholeNumber(input.postedWithinDays),
        maxResults: wholeNumber(input.maxResults, 100),
        maxPerCompany: wholeNumber(input.maxPerCompany, DEFAULT_MAX_PER_COMPANY),
        onlyNew: input.onlyNewSinceLastRun === true,
        want: { text: includeDescription, html: includeDescription && input.includeDescriptionHtml === true },
    };
}

/** A short name for this set of filters, so "only new" remembers each search separately. */
export function querySignature(query) {
    const plain = (terms) => terms.map((t) => (t.exact ? `"${t.words.join(' ')}"` : t.words.join(' '))).sort();
    const body = JSON.stringify([plain(query.keywords), plain(query.excludeKeywords), plain(query.locations), plain(query.companies), query.systems.slice().sort(), query.remoteOnly]);
    return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

export function companyMatches(company, query) {
    if (!query.companies.length) return true;
    const token = String(company.t || '').toLowerCase();
    if (query.companies.some((term) => term.words.join('') === token || term.words.join('-') === token)) return true;
    return anyPhraseIn([company.n, company.t], query.companies);
}

/** True when the compact job passes every filter. */
export function jobMatches(job, query, nowMs) {
    if (query.remoteOnly && job.r !== 1) return false;
    if (query.postedWithinDays > 0 && job.p) {
        const posted = Date.parse(job.p);
        if (Number.isFinite(posted) && nowMs - posted > query.postedWithinDays * 86400000) return false;
    }
    if (query.keywords.length || query.excludeKeywords.length) {
        const title = words(job.ti);
        if (query.keywords.length && !anyTermMatches(title, query.keywords)) return false;
        if (query.excludeKeywords.length && anyTermMatches(title, query.excludeKeywords)) return false;
    }
    if (query.locations.length && !anyPhraseIn([job.l, ...(job.al || []), job.c], query.locations)) return false;
    return true;
}

const postedMs = (job) => {
    const t = job.p ? Date.parse(job.p) : NaN;
    return Number.isFinite(t) ? t : -Infinity;
};
// Newest first; jobs without a date last; then by company and title so the order is stable.
function byNewest(a, b) {
    const d = postedMs(b.job) - postedMs(a.job);
    if (d) return d;
    return (a.company.n || '').localeCompare(b.company.n || '') || (a.job.ti || '').localeCompare(b.job.ti || '') || String(a.job.i).localeCompare(String(b.job.i));
}

const jobKey = (company, id) => `${company.p}:${company.t}:${id}`;

/**
 * @param {object} input the Actor input
 * @param {object} deps
 * @param {(provider: string) => AsyncIterable<object>} deps.openIndex yields {meta} then company lines
 * @param {(items: object[]) => Promise<{stop?: boolean, pushed?: number}>} deps.pushJobs
 * @param {{get: (key: string) => Promise<any>, set: (key: string, value: any) => Promise<void>} | null} [deps.seenStore]
 * @param {(source: object, want: object) => Promise<object[]>} [deps.fetchLive] reads one company's live feed
 * @param {{info: Function, warning: Function}} [deps.log]
 * @param {() => number} [deps.now]
 */
export async function search(input, deps) {
    const log = deps.log || { info() {}, warning() {} };
    const now = deps.now || Date.now;
    const nowMs = now();
    const query = readQuery(input || {});

    const summary = {
        indexBuiltAt: null,
        systemsRead: [],
        systemsFailed: [],
        companiesInIndex: 0,
        jobsInIndex: 0,
        jobsMatched: 0,
        jobsReturned: 0,
        maxPerCompany: query.maxPerCompany,
        leftOutByCompanyCap: 0,
        closedSinceIndex: 0,
        liveChecksFailed: 0,
        stoppedAtSpendingLimit: false,
    };

    // Remember-what-I-returned, kept separately for each set of filters.
    let seenStore = query.onlyNew ? (deps.seenStore || null) : null;
    const seenKey = `seen-${querySignature(query)}`;
    let seen = null;
    if (query.onlyNew) {
        if (!seenStore) log.warning('Could not open the memory of earlier runs, so every matching job is returned this time.');
        else {
            try {
                const saved = await seenStore.get(seenKey);
                seen = new Set(Array.isArray(saved && saved.keys) ? saved.keys.map(String) : []);
            } catch {
                log.warning('Could not read the memory of earlier runs, so every matching job is returned this time.');
                seenStore = null;
            }
        }
    }

    // With a limit, keep a little extra when live checks may drop jobs that have closed.
    const limit = query.maxResults;
    const keep = limit > 0 ? (query.want.text ? Math.ceil(limit * 1.15) + 5 : limit) : 0;
    let picked = [];
    const trim = () => {
        picked.sort(byNewest);
        if (keep > 0 && picked.length > keep) picked.length = keep;
    };

    // Each hiring system has its own index file. A file is read to the end before its jobs count,
    // so a download that breaks halfway (the file is swapped once a day) can simply be read again.
    const readOnce = async (provider) => {
        const part = { builtAt: null, companies: 0, jobs: 0, matched: 0, capped: 0, hits: [] };
        for await (const line of deps.openIndex(provider)) {
            if (line.meta) {
                part.builtAt = line.meta.builtAt || null;
                continue;
            }
            if (!Array.isArray(line.j)) continue;
            part.companies += 1;
            part.jobs += line.j.length;
            if (!companyMatches(line, query)) continue;
            const company = { p: line.p, t: line.t, n: line.n, at: line.at };
            let hits = line.j.filter((job) => job && job.i != null && job.ti && jobMatches(job, query, nowMs));
            if (seen) hits = hits.filter((job) => !seen.has(jobKey(company, job.i)));
            if (!hits.length) continue;
            part.matched += hits.length;
            if (query.maxPerCompany > 0 && hits.length > query.maxPerCompany) {
                hits.sort((a, b) => postedMs(b) - postedMs(a));
                part.capped += hits.length - query.maxPerCompany;
                hits = hits.slice(0, query.maxPerCompany);
            }
            for (const job of hits) part.hits.push({ company, job });
            if (keep > 0 && part.hits.length > keep * 3 + 2000) {
                part.hits.sort(byNewest);
                part.hits.length = keep;
            }
        }
        return part;
    };
    await Promise.all(query.systems.map(async (provider) => {
        const attempts = deps.readAttempts ?? 2;
        let lastError;
        for (let attempt = 1; attempt <= attempts; attempt++) {
            try {
                const part = await readOnce(provider);
                if (part.builtAt && (!summary.indexBuiltAt || part.builtAt < summary.indexBuiltAt)) summary.indexBuiltAt = part.builtAt;
                summary.companiesInIndex += part.companies;
                summary.jobsInIndex += part.jobs;
                summary.jobsMatched += part.matched;
                summary.leftOutByCompanyCap += part.capped;
                for (const hit of part.hits) picked.push(hit);
                summary.systemsRead.push(provider);
                return;
            } catch (err) {
                lastError = err;
                if (attempt < attempts) await new Promise((resolve) => { setTimeout(resolve, deps.retryWaitMs ?? 5000); });
            }
        }
        summary.systemsFailed.push({ system: provider, reason: (lastError && lastError.message) || 'Unknown error' });
        log.warning(`The ${provider} part of the job index could not be read: ${(lastError && lastError.message) || lastError}`);
    }));
    trim();
    summary.systemsRead.sort();

    if (!summary.systemsRead.length) return { ...summary, failed: true };
    if (summary.indexBuiltAt && nowMs - Date.parse(summary.indexBuiltAt) > STALE_AFTER_MS) {
        log.warning(`The job index was last rebuilt on ${summary.indexBuiltAt.slice(0, 10)}, so some results may be out of date.`);
    }

    // Optional live check: read each matched company's feed now, to add the description and drop jobs that have closed.
    let rows;
    if (query.want.text && deps.fetchLive) {
        const byCompany = new Map();
        for (const hit of picked) {
            const key = `${hit.company.p}:${hit.company.t}`;
            if (!byCompany.has(key)) byCompany.set(key, { company: hit.company, live: null, failed: false });
        }
        const queue = [...byCompany.values()];
        log.info(`Checking ${queue.length} compan${queue.length === 1 ? 'y' : 'ies'} live for descriptions.`);
        await Promise.all(Array.from({ length: Math.min(LIVE_CONCURRENCY, queue.length) }, async () => {
            while (queue.length) {
                const entry = queue.shift();
                try {
                    const jobs = await deps.fetchLive({ provider: entry.company.p, token: entry.company.t }, query.want);
                    entry.live = new Map(jobs.map((job) => [String(job.id), job]));
                } catch (err) {
                    if (err && err.notFound) entry.live = new Map();
                    else {
                        entry.failed = true;
                        summary.liveChecksFailed += 1;
                    }
                }
            }
        }));
        rows = [];
        const checkedAt = new Date(now()).toISOString();
        for (const hit of picked) {
            const entry = byCompany.get(`${hit.company.p}:${hit.company.t}`);
            if (entry.failed || !entry.live) {
                rows.push({ ...expandJob(hit.job, hit.company), descriptionText: null, liveChecked: false, scrapedAt: hit.company.at || null });
                continue;
            }
            const live = entry.live.get(String(hit.job.i));
            if (!live) { summary.closedSinceIndex += 1; continue; }
            rows.push({ ...live, company: hit.company.n || live.company, liveChecked: true, scrapedAt: checkedAt });
        }
    } else {
        rows = picked.map((hit) => ({ ...expandJob(hit.job, hit.company), liveChecked: false, scrapedAt: hit.company.at || null }));
    }
    if (limit > 0 && rows.length > limit) rows.length = limit;
    if (query.onlyNew) rows = rows.map((row) => ({ ...row, isNew: true }));

    const pushedKeys = [];
    for (let i = 0; i < rows.length; i += PUSH_BATCH) {
        const batch = rows.slice(i, i + PUSH_BATCH);
        const result = await deps.pushJobs(batch);
        const saved = result && Number.isInteger(result.pushed) ? Math.min(result.pushed, batch.length) : batch.length;
        for (const row of batch.slice(0, saved)) pushedKeys.push(`${row.source}:${row.companyId}:${row.id}`);
        summary.jobsReturned += saved;
        if (result && result.stop) {
            summary.stoppedAtSpendingLimit = true;
            break;
        }
    }

    if (seenStore && seen) {
        const keys = [...seen, ...pushedKeys].slice(-MAX_SEEN);
        try {
            await seenStore.set(seenKey, { keys, updatedAt: new Date(now()).toISOString() });
        } catch {
            log.warning('Could not save the memory for the next run.');
        }
    }
    return summary;
}

const count = (n) => Number(n).toLocaleString('en-US');

/** One plain sentence for the run's status line. */
export function describe(summary, nowMs = Date.now()) {
    if (summary.failed) return 'The job index could not be read. Nothing was returned and nothing was charged for results. Please try again in a few minutes.';
    let text = `Returned ${count(summary.jobsReturned)} job${summary.jobsReturned === 1 ? '' : 's'}`;
    if (summary.jobsMatched !== summary.jobsReturned) text += ` of ${count(summary.jobsMatched)} that matched`;
    text += `, from an index of ${count(summary.jobsInIndex)} open jobs at ${count(summary.companiesInIndex)} companies`;
    if (summary.indexBuiltAt) {
        const hours = Math.max(0, Math.round((nowMs - Date.parse(summary.indexBuiltAt)) / 3600000));
        text += hours < 1 ? ' (rebuilt within the last hour)' : ` (rebuilt ${hours} hour${hours === 1 ? '' : 's'} ago)`;
    }
    text += '.';
    if (summary.leftOutByCompanyCap) text += ` At most ${count(summary.maxPerCompany)} per company were kept; set "Maximum jobs per company" to 0 for all of them.`;
    if (summary.closedSinceIndex) text += ` ${count(summary.closedSinceIndex)} had closed since the index was built and were left out.`;
    if (summary.systemsFailed.length) text += ` Part of the index could not be read (${summary.systemsFailed.map((f) => f.system).join(', ')}).`;
    if (summary.stoppedAtSpendingLimit) text += ' Stopped early because your spending limit for this run was reached.';
    return text;
}
