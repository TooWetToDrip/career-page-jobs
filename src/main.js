// Entry point on the Apify platform. Everything interesting lives in run.js and charging.js.

import { Actor, log } from 'apify';
import { run, describe } from './run.js';
import { makePusher } from './charging.js';

const SEEN_STORE_NAME = 'career-page-jobs-seen';

await Actor.init();

try {
    const input = (await Actor.getInput()) ?? {};

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

    const summary = await run(input, { log, seenStore, pushJobs: pusher.pushJobs });

    const message = describe(summary);
    await Actor.setValue('SUMMARY', summary);

    if (summary.companiesOk === 0) {
        await Actor.fail(`None of the career pages could be read. ${summary.companiesFailed.map((f) => `${f.input}: ${f.reason}`).join(' | ').slice(0, 800)}`);
    } else {
        await Actor.exit(message);
    }
} catch (err) {
    log.exception(err, 'The run stopped because of an unexpected error.');
    await Actor.fail(`Unexpected error: ${err?.message || err}`);
}
