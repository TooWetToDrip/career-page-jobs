// Entry point on the Apify platform. Everything interesting lives in search.js.

import { Actor, log } from 'apify';
import { search, describe } from './search.js';
import { DEFAULT_INDEX_URL, openRemote, readLines } from './index-reader.js';
import { makePusher } from '../../../src/charging.js';
import { fetchJobs } from '../../../src/providers.js';

const SEEN_STORE_NAME = 'career-site-job-search-seen';

await Actor.init();

try {
    const input = (await Actor.getInput()) ?? {};
    const baseUrl = process.env.JOB_INDEX_URL || DEFAULT_INDEX_URL;

    let seenStore = null;
    if (input.onlyNewSinceLastRun === true) {
        try {
            const store = await Actor.openKeyValueStore(SEEN_STORE_NAME);
            seenStore = {
                get: (key) => store.getValue(key),
                set: (key, value) => store.setValue(key, value),
            };
        } catch (err) {
            log.warning(`Could not open the memory of earlier runs: ${err?.message || err}`);
        }
    }

    let chargingManager = null;
    try {
        chargingManager = Actor.getChargingManager();
    } catch {
        chargingManager = null;
    }
    const pusher = makePusher({
        pushData: (items, eventName) => (eventName ? Actor.pushData(items, eventName) : Actor.pushData(items)),
        chargingManager,
    });
    log.info(`Pricing mode: ${pusher.mode}.`);

    const summary = await search(input, {
        log,
        seenStore,
        pushJobs: pusher.pushJobs,
        openIndex: async function* open(provider) {
            yield* readLines(await openRemote(provider, { baseUrl }));
        },
        fetchLive: (source, want) => fetchJobs(source, want),
    });

    const message = describe(summary);
    await Actor.setValue('SUMMARY', summary);
    if (summary.failed) await Actor.fail(message);
    else await Actor.exit(message);
} catch (err) {
    log.exception(err, 'The run stopped because of an unexpected error.');
    await Actor.fail(`Unexpected error: ${err?.message || err}`);
}
