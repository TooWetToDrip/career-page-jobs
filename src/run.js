// The whole job, with the platform pieces (saving results, remembering seen jobs) passed in.
// That keeps this file testable without the Apify platform.

import { parseSources } from './sources.js';
import { fetchJobs } from './providers.js';

const MAX_SEEN_IDS = 20000;
const PUSH_BATCH = 200;
const CONCURRENCY = 4;

// Used when no companies are given, so the tool works on the first click.
// Each of these public boards was read successfully on October 8, 2026.
export const STARTER_COMPANIES = ['greenhouse:stripe', 'lever:palantir', 'ashby:ramp', 'workable:huggingface'];

function wordList(value) {
    return (Array.isArray(value) ? value : [])
        .map((w) => String(w ?? '').trim().toLowerCase())
        .filter(Boolean);
}

function wholeNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Read the input once and turn it into the filters used below. */
export function readOptions(input = {}) {
    const includeDescription = input.includeDescription !== false;
    return {
        titleIncludes: wordList(input.titleIncludes),
        titleExcludes: wordList(input.titleExcludes),
        locationIncludes: wordList(input.locationIncludes),
        remoteOnly: input.remoteOnly === true,
        postedWithinDays: wholeNumber(input.postedWithinDays),
        onlyNew: input.onlyNewSinceLastRun === true,
        maxJobsPerCompany: wholeNumber(input.maxJobsPerCompany),
        want: { text: includeDescription, html: includeDescription && input.includeDescriptionHtml === true },
    };
}

/** True when the job passes every filter the user set. */
export function matches(job, options, nowMs = Date.now()) {
    const title = (job.title || '').toLowerCase();
    if (options.titleIncludes.length && !options.titleIncludes.some((w) => title.includes(w))) return false;
    if (options.titleExcludes.some((w) => title.includes(w))) return false;
    if (options.locationIncludes.length) {
        const places = [job.location, ...(job.allLocations || []), job.country].filter(Boolean).join(' | ').toLowerCase();
        if (!options.locationIncludes.some((w) => places.includes(w))) return false;
    }
    if (options.remoteOnly && job.remote !== true) return false;
    if (options.postedWithinDays > 0 && job.postedAt) {
        const posted = Date.parse(job.postedAt);
        if (Number.isFinite(posted) && nowMs - posted > options.postedWithinDays * 86400000) return false;
    }
    return true;
}

const seenKey = (source) => `seen-${source.provider}-${source.token.toLowerCase()}`;

/**
 * @param {object} input the Actor input
 * @param {object} deps
 * @param {(items: object[]) => Promise<{stop?: boolean}>} deps.pushJobs saves results; stop:true means the user's spending limit is reached
 * @param {{get: (key: string) => Promise<any>, set: (key: string, value: any) => Promise<void>} | null} [deps.seenStore]
 * @param {{info: Function, warning: Function}} [deps.log]
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {() => number} [deps.now]
 * @param {object} [deps.fetchOptions] retries, timeoutMs, backoffMs
 */
export async function run(input, deps) {
    const log = deps.log || { info() {}, warning() {} };
    const now = deps.now || Date.now;
    const options = readOptions(input || {});
    const given = Array.isArray(input && input.companies) ? input.companies.filter((c) => String((c && c.url) ?? c ?? '').trim()) : [];
    const usedStarterList = given.length === 0;
    if (usedStarterList) log.info('No companies were given, so the built-in starter list is used.');
    const { sources, problems } = parseSources(usedStarterList ? STARTER_COMPANIES : given);

    const summary = {
        companiesRequested: sources.length + problems.length,
        companiesOk: 0,
        companiesFailed: problems.map((p) => ({ input: p.input, reason: p.error })),
        jobsFound: 0,
        jobsReturned: 0,
        stoppedAtSpendingLimit: false,
        usedStarterList,
    };
    for (const p of problems) log.warning(`Skipped "${p.input}": ${p.error}`);
    if (!sources.length) return summary;

    let seenStore = options.onlyNew ? (deps.seenStore || null) : null;
    if (options.onlyNew && !seenStore) {
        log.warning('Could not open the memory of earlier runs, so every matching job is returned this time.');
    }

    const fetchOptions = { ...(deps.fetchOptions || {}) };
    if (deps.fetchImpl) fetchOptions.fetchImpl = deps.fetchImpl;

    let stop = false;
    let pushChain = Promise.resolve();
    const pushInOrder = (fn) => {
        const next = pushChain.then(fn, fn);
        pushChain = next.catch(() => {});
        return next;
    };

    async function handle(source) {
        let jobs;
        try {
            jobs = await fetchJobs(source, options.want, fetchOptions);
        } catch (err) {
            const reason = err && err.notFound
                ? 'No public job board was found under this name. Check the spelling against the career page address.'
                : (err && err.message) || 'Unknown error';
            summary.companiesFailed.push({ input: source.input, reason });
            log.warning(`${source.provider}:${source.token} failed: ${reason}`);
            return;
        }
        summary.companiesOk += 1;
        summary.jobsFound += jobs.length;

        let previous = null;
        if (seenStore) {
            try {
                const saved = await seenStore.get(seenKey(source));
                previous = new Set(Array.isArray(saved && saved.ids) ? saved.ids.map(String) : []);
            } catch {
                log.warning('Could not read the memory of earlier runs, so every matching job is returned this time.');
                seenStore = null;
            }
        }

        const nowMs = now();
        const scrapedAt = new Date(nowMs).toISOString();
        let selected = jobs.filter((job) => matches(job, options, nowMs));
        if (previous) selected = selected.filter((job) => !previous.has(job.id));
        if (options.maxJobsPerCompany > 0) selected = selected.slice(0, options.maxJobsPerCompany);
        const items = selected.map((job) => (options.onlyNew ? { ...job, isNew: true, scrapedAt } : { ...job, scrapedAt }));

        const pushedIds = [];
        await pushInOrder(async () => {
            for (let i = 0; i < items.length && !stop; i += PUSH_BATCH) {
                const batch = items.slice(i, i + PUSH_BATCH);
                const result = await deps.pushJobs(batch);
                const saved = result && Number.isInteger(result.pushed) ? Math.min(result.pushed, batch.length) : batch.length;
                for (const item of batch.slice(0, saved)) pushedIds.push(item.id);
                summary.jobsReturned += saved;
                if (result && result.stop) {
                    stop = true;
                    summary.stoppedAtSpendingLimit = true;
                }
            }
        });

        if (seenStore && previous) {
            // Remember what was returned. Jobs that have closed are forgotten, so a reopened job counts as new.
            const open = new Set(jobs.map((job) => job.id));
            const ids = [...new Set([...[...previous].filter((id) => open.has(id)), ...pushedIds])].slice(-MAX_SEEN_IDS);
            try {
                await seenStore.set(seenKey(source), { ids, updatedAt: scrapedAt });
            } catch {
                log.warning('Could not save the memory for the next run.');
            }
        }
        log.info(`${source.provider}:${source.token}: ${jobs.length} open jobs, ${pushedIds.length} returned.`);
    }

    const queue = sources.slice();
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        while (queue.length && !stop) {
            const source = queue.shift();
            await handle(source);
        }
    });
    await Promise.all(workers);
    await pushChain;
    return summary;
}

/** One plain sentence for the run's status line. */
export function describe(summary) {
    const failed = summary.companiesFailed.length;
    let text = `Returned ${summary.jobsReturned} job${summary.jobsReturned === 1 ? '' : 's'} from ${summary.companiesOk} of ${summary.companiesRequested} compan${summary.companiesRequested === 1 ? 'y' : 'ies'}`;
    if (summary.jobsFound !== summary.jobsReturned) text += ` (${summary.jobsFound} open in total)`;
    text += '.';
    if (failed) text += ` ${failed} could not be read; see the log for which and why.`;
    if (summary.stoppedAtSpendingLimit) text += ' Stopped early because your spending limit for this run was reached.';
    return text;
}
