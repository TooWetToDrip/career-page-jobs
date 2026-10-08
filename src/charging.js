// Decides how results are saved and paid for, whatever pricing the Actor has in the Apify Console.
//
// Apify can charge for results in two ways:
//   1. Its built-in event "apify-default-dataset-item": the platform charges for every saved result
//      by itself. No charging code is needed.
//   2. A custom event (here "job-result") that the code charges when it saves results.
// Charging both would bill a user twice for one job, so this file never does that:
// if the built-in event is priced, the custom one is not used.

export const RESULT_EVENT = 'job-result';
export const DATASET_EVENT = 'apify-default-dataset-item';

function readPrices(chargingManager) {
    try {
        const info = chargingManager && chargingManager.getPricingInfo ? chargingManager.getPricingInfo() : null;
        const prices = info && info.perEventPrices;
        return prices && typeof prices === 'object' ? prices : {};
    } catch {
        return {};
    }
}

/**
 * @param {object} deps
 * @param {(items: object[], eventName?: string) => Promise<any>} deps.pushData the platform's save call
 * @param {object | null} [deps.chargingManager] the platform's charging manager, when there is one
 * @returns {{mode: 'custom' | 'builtin' | 'free', pushJobs: (items: object[]) => Promise<{stop: boolean, pushed?: number}>}}
 */
export function makePusher({ pushData, chargingManager = null }) {
    const prices = readPrices(chargingManager);
    const has = (name) => Object.prototype.hasOwnProperty.call(prices, name);

    if (has(RESULT_EVENT) && !has(DATASET_EVENT)) {
        return {
            mode: 'custom',
            pushJobs: async (items) => {
                // Saves the jobs and charges one event per job. The platform never saves more
                // than the user's spending limit allows and says so in the result.
                const result = await pushData(items, RESULT_EVENT);
                const limitReached = Boolean(result && result.eventChargeLimitReached);
                const out = { stop: limitReached };
                if (limitReached && Number.isInteger(result.chargedCount)) out.pushed = result.chargedCount;
                return out;
            },
        };
    }

    if (has(DATASET_EVENT)) {
        // The platform charges per saved result by itself. Work out once how many results the
        // user's spending limit covers, and stop there instead of being cut off mid-run.
        let room = Infinity;
        try {
            const max = chargingManager.calculateMaxEventChargeCountWithinLimit(DATASET_EVENT);
            if (Number.isFinite(max)) room = Math.max(0, Math.floor(max));
        } catch {
            room = Infinity;
        }
        return {
            mode: 'builtin',
            pushJobs: async (items) => {
                const take = room === Infinity ? items.length : Math.min(items.length, room);
                if (take > 0) await pushData(take === items.length ? items : items.slice(0, take));
                if (room !== Infinity) room -= take;
                return take < items.length ? { stop: true, pushed: take } : { stop: false };
            },
        };
    }

    return {
        mode: 'free',
        pushJobs: async (items) => {
            await pushData(items);
            return { stop: false };
        },
    };
}
