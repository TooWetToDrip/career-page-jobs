// Reads the daily job index: one compressed file per hiring system, one company per line.

import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';

export const DEFAULT_INDEX_URL = 'https://github.com/TooWetToDrip/career-page-jobs/releases/download/index';
const USER_AGENT = 'career-site-job-search/1.0 (Apify Actor)';
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Open one index file as a stream of compressed bytes. The file is replaced once a day,
 * and for a few seconds during that swap it can be missing, so this waits and tries again.
 */
export async function openRemote(provider, opts = {}) {
    const { baseUrl = DEFAULT_INDEX_URL, fetchImpl = fetch, retries = 5, waitMs = 4000, timeoutMs = 120000 } = opts;
    const url = `${baseUrl.replace(/\/+$/, '')}/${provider}.ndjson.gz`;
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
            if (res.ok && res.body) return Readable.fromWeb(res.body);
            lastError = new Error(`The job index answered HTTP ${res.status}`);
        } catch (err) {
            lastError = new Error(`Could not reach the job index (${err?.name || 'error'})`);
        }
        if (attempt < retries) await sleep(waitMs * attempt);
    }
    throw lastError;
}

/**
 * Yields {meta} once, then one {p, t, n, at, j} object per company.
 * @param {import('node:stream').Readable} gzStream
 */
export async function* readLines(gzStream) {
    const gunzip = createGunzip();
    // An error on either stream must end the loop below instead of crashing the process.
    gzStream.on('error', (err) => gunzip.destroy(err));
    const lines = createInterface({ input: gzStream.pipe(gunzip), crlfDelay: Infinity });
    for await (const line of lines) {
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj && typeof obj === 'object') yield obj;
    }
}
