// The job index stores one line per company, with each job squeezed into short keys.
// compactJob() makes the short form; expandJob() turns it back into the full result row.
// Descriptions are never stored in the index: only facts such as title, place, dates and links.

export const INDEX_VERSION = 1;

/** @param {object} job a full job row as produced by providers.js */
export function compactJob(job) {
    const c = { i: job.id, ti: job.title };
    if (job.department) c.d = job.department;
    if (job.team) c.tm = job.team;
    if (job.location) c.l = job.location;
    const extra = (job.allLocations || []).filter((x) => x && x !== job.location);
    if (extra.length) c.al = extra;
    if (job.country) c.c = job.country;
    if (job.remote === true) c.r = 1;
    else if (job.remote === false) c.r = 0;
    if (job.workplaceType) c.w = job.workplaceType;
    if (job.employmentType) c.e = job.employmentType;
    if (job.postedAt) c.p = job.postedAt;
    if (job.updatedAt) c.u = job.updatedAt;
    if (job.url) c.url = job.url;
    if (job.applyUrl && job.applyUrl !== job.url) c.a = job.applyUrl;
    if (job.salaryMin != null || job.salaryMax != null || job.salaryText) {
        c.s = [job.salaryMin ?? null, job.salaryMax ?? null, job.salaryCurrency ?? null, job.salaryInterval ?? null, job.salaryText ?? null];
    }
    return c;
}

/**
 * @param {object} c a compact job
 * @param {{p: string, t: string, n: string}} company the company line it came from
 */
export function expandJob(c, company) {
    const s = Array.isArray(c.s) ? c.s : [];
    return {
        company: company.n || company.t,
        source: company.p,
        companyId: company.t,
        id: c.i,
        title: c.ti,
        department: c.d ?? null,
        team: c.tm ?? null,
        location: c.l ?? null,
        allLocations: [...(c.l ? [c.l] : []), ...(Array.isArray(c.al) ? c.al : [])],
        country: c.c ?? null,
        remote: c.r === 1 ? true : (c.r === 0 ? false : null),
        workplaceType: c.w ?? null,
        employmentType: c.e ?? null,
        postedAt: c.p ?? null,
        updatedAt: c.u ?? null,
        url: c.url ?? null,
        applyUrl: c.a ?? c.url ?? null,
        salaryMin: s[0] ?? null,
        salaryMax: s[1] ?? null,
        salaryCurrency: s[2] ?? null,
        salaryInterval: s[3] ?? null,
        salaryText: s[4] ?? null,
    };
}
