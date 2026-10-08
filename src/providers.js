// One fetcher per hiring system. Each uses the system's own public job feed
// (the same data the public career page shows) and returns jobs in one shared shape.

import { clean, decodeEntities, htmlToText, toIso, unique } from './text.js';

const USER_AGENT = 'career-page-jobs/0.1 (Apify Actor; public job feeds only)';

export class SourceError extends Error {
    constructor(message, { notFound = false } = {}) {
        super(message);
        this.name = 'SourceError';
        this.notFound = notFound;
    }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Be a polite guest: at most about one request a second to any one site.
const DEFAULT_GAP_MS = 1000;
const nextSlot = new Map();
async function waitForTurn(url, gapMs) {
    if (!(gapMs > 0)) return;
    let host;
    try { host = new URL(url).host; } catch { return; }
    const now = Date.now();
    const at = Math.max(now, nextSlot.get(host) || 0);
    nextSlot.set(host, at + gapMs);
    if (at > now) await sleep(at - now);
}

/**
 * GET a JSON document with a timeout and a few polite retries.
 * @param {string} url
 * @param {{fetchImpl?: typeof fetch, retries?: number, timeoutMs?: number, backoffMs?: number, minGapMs?: number, userAgent?: string}} [opts]
 */
export async function getJson(url, opts = {}) {
    const { fetchImpl = fetch, retries = 3, timeoutMs = 30000, backoffMs = 1500, minGapMs = DEFAULT_GAP_MS, userAgent = USER_AGENT } = opts;
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await waitForTurn(url, minGapMs);
            const res = await fetchImpl(url, {
                headers: { accept: 'application/json', 'user-agent': userAgent },
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (res.status === 404 || res.status === 410) {
                throw new SourceError(`Not found (HTTP ${res.status})`, { notFound: true });
            }
            if (res.status === 429 || res.status >= 500) {
                lastError = new SourceError(`The career site answered HTTP ${res.status}`);
            } else if (!res.ok) {
                throw new SourceError(`The career site answered HTTP ${res.status}`);
            } else {
                try {
                    return await res.json();
                } catch {
                    throw new SourceError('The career site did not return job data');
                }
            }
        } catch (err) {
            if (err instanceof SourceError && (err.notFound || !/HTTP (429|5\d\d)/.test(err.message))) throw err;
            lastError = err instanceof SourceError ? err : new SourceError(`Could not reach the career site (${err?.name || 'error'})`);
        }
        if (attempt < retries) await sleep(backoffMs * attempt);
    }
    throw lastError;
}

function workplace(value, remoteFlag) {
    const v = String(value ?? '').toLowerCase().replace(/[^a-z]/g, '');
    if (v === 'remote') return 'remote';
    if (v === 'hybrid') return 'hybrid';
    if (v === 'onsite' || v === 'inoffice' || v === 'office') return 'onsite';
    return remoteFlag === true ? 'remote' : null;
}

function looksRemote(...texts) {
    return texts.some((t) => typeof t === 'string' && /\bremote\b/i.test(t));
}

/** Lever and Ashby feeds carry no company name, so make a readable one from the board name: "hugging-face" -> "Hugging Face". */
export function displayName(token) {
    const t = String(token ?? '').trim();
    if (!t || /[A-Z]/.test(t)) return t;
    return t.split(/[-_.]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

function baseJob(source) {
    return {
        company: null,
        source: source.provider,
        companyId: source.token,
        id: null,
        title: null,
        department: null,
        team: null,
        location: null,
        allLocations: [],
        country: null,
        remote: null,
        workplaceType: null,
        employmentType: null,
        postedAt: null,
        updatedAt: null,
        url: null,
        applyUrl: null,
        salaryMin: null,
        salaryMax: null,
        salaryCurrency: null,
        salaryInterval: null,
        salaryText: null,
    };
}

function withDescription(job, html, plain, want) {
    if (!want.text && !want.html) return job;
    const out = { ...job };
    if (want.text) out.descriptionText = clean(plain) ? String(plain).trim() : htmlToText(html);
    if (want.html) out.descriptionHtml = html ? String(html) : null;
    return out;
}

/* ---------------- Greenhouse ---------------- */

export function normalizeGreenhouse(raw, source, want = {}) {
    const job = baseJob(source);
    job.company = clean(raw.company_name) || source.token;
    job.id = raw.id != null ? String(raw.id) : null;
    job.title = clean(raw.title);
    const departments = unique((raw.departments || []).map((d) => d && d.name));
    job.department = departments[0] || null;
    job.location = clean(raw.location && raw.location.name);
    job.allLocations = unique([job.location, ...(raw.offices || []).map((o) => o && o.name)]);
    job.remote = looksRemote(job.location, ...job.allLocations) ? true : null;
    job.workplaceType = job.remote ? 'remote' : null;
    job.postedAt = toIso(raw.first_published) || toIso(raw.updated_at);
    job.updatedAt = toIso(raw.updated_at);
    job.url = clean(raw.absolute_url);
    job.applyUrl = job.url;
    // Greenhouse sends the description as HTML with its tags entity-escaped.
    const html = raw.content ? decodeEntities(raw.content) : '';
    return withDescription(job, html, null, want);
}

async function fetchGreenhouse(source, want, opts) {
    const content = want.text || want.html ? '?content=true' : '';
    const data = await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(source.token)}/jobs${content}`, opts);
    const jobs = Array.isArray(data && data.jobs) ? data.jobs : [];
    return jobs.map((raw) => normalizeGreenhouse(raw, source, want));
}

/* ---------------- Lever ---------------- */

export function normalizeLever(raw, source, want = {}) {
    const job = baseJob(source);
    const cat = raw.categories || {};
    job.company = displayName(source.token);
    job.id = raw.id != null ? String(raw.id) : null;
    job.title = clean(raw.text);
    job.department = clean(cat.department) || clean(cat.team);
    job.team = clean(cat.team);
    job.location = clean(cat.location);
    job.allLocations = unique([job.location, ...(Array.isArray(cat.allLocations) ? cat.allLocations : [])]);
    job.country = clean(raw.country);
    job.workplaceType = workplace(raw.workplaceType);
    job.remote = job.workplaceType === 'remote' ? true : (looksRemote(job.location) ? true : (job.workplaceType ? false : null));
    job.employmentType = clean(cat.commitment);
    job.postedAt = toIso(raw.createdAt);
    job.url = clean(raw.hostedUrl);
    job.applyUrl = clean(raw.applyUrl) || job.url;
    const sal = raw.salaryRange;
    if (sal && typeof sal === 'object') {
        job.salaryMin = Number.isFinite(sal.min) ? sal.min : null;
        job.salaryMax = Number.isFinite(sal.max) ? sal.max : null;
        job.salaryCurrency = clean(sal.currency);
        job.salaryInterval = clean(sal.interval);
        if (job.salaryMin != null || job.salaryMax != null) {
            job.salaryText = [job.salaryMin, job.salaryMax].filter((v) => v != null).join(' - ')
                + (job.salaryCurrency ? ` ${job.salaryCurrency}` : '')
                + (job.salaryInterval ? ` ${job.salaryInterval}` : '');
        }
    }
    if (!want.text && !want.html) return job;
    const lists = Array.isArray(raw.lists) ? raw.lists : [];
    const html = [raw.description, ...lists.map((l) => `<h3>${l.text || ''}</h3><ul>${l.content || ''}</ul>`), raw.additional]
        .filter(Boolean).join('\n');
    const plain = [raw.descriptionPlain, ...lists.map((l) => `${l.text || ''}\n${htmlToText(l.content || '')}`), raw.additionalPlain]
        .map((s) => (s == null ? '' : String(s).trim())).filter(Boolean).join('\n\n');
    return withDescription(job, html, plain, want);
}

async function fetchLever(source, want, opts) {
    const hosts = source.region === 'eu' ? ['api.eu.lever.co', 'api.lever.co'] : ['api.lever.co', 'api.eu.lever.co'];
    let lastError;
    for (const host of hosts) {
        try {
            const data = await getJson(`https://${host}/v0/postings/${encodeURIComponent(source.token)}?mode=json`, opts);
            if (!Array.isArray(data)) throw new SourceError('The career site did not return job data');
            return data.map((raw) => normalizeLever(raw, source, want));
        } catch (err) {
            lastError = err;
            if (!(err instanceof SourceError && err.notFound)) throw err;
        }
    }
    throw lastError;
}

/* ---------------- Ashby ---------------- */

export function normalizeAshby(raw, source, want = {}) {
    const job = baseJob(source);
    job.company = displayName(source.token);
    job.id = raw.id != null ? String(raw.id) : null;
    job.title = clean(raw.title);
    job.department = clean(raw.department);
    job.team = clean(raw.team);
    job.location = clean(raw.location);
    job.allLocations = unique([job.location, ...(raw.secondaryLocations || []).map((l) => l && l.location)]);
    job.country = clean(raw.address && raw.address.postalAddress && raw.address.postalAddress.addressCountry);
    job.workplaceType = workplace(raw.workplaceType, raw.isRemote);
    job.remote = typeof raw.isRemote === 'boolean' ? raw.isRemote : (job.workplaceType === 'remote' ? true : null);
    job.employmentType = clean(raw.employmentType);
    job.postedAt = toIso(raw.publishedAt);
    job.url = clean(raw.jobUrl);
    job.applyUrl = clean(raw.applyUrl) || job.url;
    const comp = raw.compensation;
    if (comp && typeof comp === 'object') {
        job.salaryText = clean(comp.scrapeableCompensationSalarySummary) || clean(comp.compensationTierSummary);
        const parts = Array.isArray(comp.summaryComponents) ? comp.summaryComponents : [];
        const salary = parts.find((c) => c && c.compensationType === 'Salary') || null;
        if (salary) {
            job.salaryMin = Number.isFinite(salary.minValue) ? salary.minValue : null;
            job.salaryMax = Number.isFinite(salary.maxValue) ? salary.maxValue : null;
            job.salaryCurrency = clean(salary.currencyCode);
            job.salaryInterval = clean(salary.interval);
        }
    }
    return withDescription(job, raw.descriptionHtml, raw.descriptionPlain, want);
}

async function fetchAshby(source, want, opts) {
    const data = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(source.token)}?includeCompensation=true`, opts);
    const jobs = Array.isArray(data && data.jobs) ? data.jobs : [];
    return jobs.filter((raw) => raw && raw.isListed !== false).map((raw) => normalizeAshby(raw, source, want));
}

/* ---------------- Workable ---------------- */

export function normalizeWorkable(raw, source, want = {}, companyName = null) {
    const job = baseJob(source);
    job.company = clean(companyName) || source.token;
    job.id = clean(raw.shortcode) || clean(raw.code);
    job.title = clean(raw.title);
    job.department = clean(raw.department);
    const place = (l) => unique([l && l.city, l && (l.region ?? l.state), l && l.country]).join(', ');
    const primary = place({ city: raw.city, state: raw.state, country: raw.country });
    const locations = Array.isArray(raw.locations) ? raw.locations.filter((l) => l && l.hidden !== true) : [];
    job.location = clean(primary) || clean(locations[0] && place(locations[0]));
    job.allLocations = unique([job.location, ...locations.map(place)]);
    job.country = clean(raw.country);
    job.remote = typeof raw.telecommuting === 'boolean' ? raw.telecommuting : null;
    job.workplaceType = job.remote ? 'remote' : null;
    job.employmentType = clean(raw.employment_type);
    job.postedAt = toIso(raw.published_on) || toIso(raw.created_at);
    job.url = clean(raw.url) || clean(raw.shortlink);
    job.applyUrl = clean(raw.application_url) || job.url;
    return withDescription(job, raw.description, null, want);
}

async function fetchWorkable(source, want, opts) {
    const details = want.text || want.html ? '?details=true' : '';
    const data = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(source.token)}${details}`, opts);
    const jobs = Array.isArray(data && data.jobs) ? data.jobs : [];
    return jobs.map((raw) => normalizeWorkable(raw, source, want, data && data.name));
}

const FETCHERS = { greenhouse: fetchGreenhouse, lever: fetchLever, ashby: fetchAshby, workable: fetchWorkable };

/**
 * Fetch every open job for one company.
 * @param {{provider: string, token: string, region?: string}} source
 * @param {{text?: boolean, html?: boolean}} want which description forms to include
 * @param {object} [opts] passed to getJson (fetchImpl, retries, timeoutMs, backoffMs)
 */
export async function fetchJobs(source, want = {}, opts = {}) {
    const fetcher = FETCHERS[source.provider];
    if (!fetcher) throw new SourceError(`Unknown system "${source.provider}"`);
    const jobs = await fetcher(source, want, opts);
    return jobs.filter((job) => job.id && job.title);
}
