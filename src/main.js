// Entry point on the Apify platform. Everything interesting lives in run.js.

import { Actor, log } from 'apify';
import { run, describe } from './run.js';

// The pay-per-event name. It must match the event set up under Monetization in the Apify Console.
const RESULT_EVENT = 'job-result';
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

    const summary = await run(input, {
        log,
        seenStore,
        pushJobs: async (items) => {
            // On a pay-per-event Actor this charges one event per saved job and never saves
            // more than the user's spending limit allows. On a free Actor it just saves.
            const result = await Actor.pushData(items, RESULT_EVENT);
            const limitReached = Boolean(result && result.eventChargeLimitReached);
            const out = { stop: limitReached };
            if (limitReached && Number.isInteger(result.chargedCount)) out.pushed = result.chargedCount;
            return out;
        },
    });

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
