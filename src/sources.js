// Turns what the user typed (a career page address or "system:name") into {provider, token}.

export const PROVIDERS = ['greenhouse', 'lever', 'ashby', 'workable'];

const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function okToken(token) {
    return typeof token === 'string' && TOKEN_RE.test(token);
}

/**
 * @param {string} raw
 * @returns {{provider: string, token: string, region?: string, input: string} | {error: string, input: string}}
 */
export function parseSource(raw) {
    const input = String(raw ?? '').trim();
    if (!input) return { error: 'Empty line', input };

    // Short form: greenhouse:stripe
    const short = /^([a-z]+)\s*:\s*([^/\s:]+)$/i.exec(input);
    if (short && !/^https?$/i.test(short[1])) {
        const provider = short[1].toLowerCase();
        if (!PROVIDERS.includes(provider)) {
            return { error: `Unknown system "${short[1]}". Use one of: ${PROVIDERS.join(', ')}.`, input };
        }
        if (!okToken(short[2])) return { error: `"${short[2]}" is not a valid company name for ${provider}.`, input };
        return { provider, token: short[2], input };
    }

    let url;
    try {
        url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    } catch {
        return { error: 'Not a web address or a system:name pair', input };
    }
    const host = url.hostname.toLowerCase();
    const parts = url.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));

    // Greenhouse
    if (host === 'boards-api.greenhouse.io') {
        const i = parts.indexOf('boards');
        const token = i >= 0 ? parts[i + 1] : undefined;
        if (okToken(token)) return { provider: 'greenhouse', token, input };
    }
    if (/^(boards|job-boards)(\.eu)?\.greenhouse\.io$/.test(host)) {
        const forParam = url.searchParams.get('for');
        const token = parts[0] === 'embed' ? forParam : parts[0];
        if (okToken(token)) return { provider: 'greenhouse', token, input };
    }

    // Lever
    if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') {
        if (okToken(parts[0])) return { provider: 'lever', token: parts[0], region: host.includes('.eu.') ? 'eu' : 'global', input };
    }
    if (host === 'api.lever.co' || host === 'api.eu.lever.co') {
        const i = parts.indexOf('postings');
        const token = i >= 0 ? parts[i + 1] : undefined;
        if (okToken(token)) return { provider: 'lever', token, region: host.includes('.eu.') ? 'eu' : 'global', input };
    }

    // Ashby
    if (host === 'jobs.ashbyhq.com') {
        if (okToken(parts[0])) return { provider: 'ashby', token: parts[0], input };
    }
    if (host === 'api.ashbyhq.com') {
        const i = parts.indexOf('job-board');
        const token = i >= 0 ? parts[i + 1] : undefined;
        if (okToken(token)) return { provider: 'ashby', token, input };
    }

    // Workable
    if (host === 'apply.workable.com') {
        const i = parts.indexOf('accounts');
        const token = i >= 0 ? parts[i + 1] : parts[0];
        if (okToken(token) && token !== 'j' && token !== 'api') return { provider: 'workable', token, input };
    }
    const sub = /^([a-z0-9-]+)\.workable\.com$/.exec(host);
    if (sub && !['www', 'apply', 'help', 'jobs', 'resources'].includes(sub[1])) {
        return { provider: 'workable', token: sub[1], input };
    }

    return {
        error: 'This address is not a Greenhouse, Lever, Ashby or Workable career page. Open the company\'s jobs page and copy the address from there.',
        input,
    };
}

/** Parse a list, dropping duplicates. Returns {sources, problems}. */
export function parseSources(list) {
    const sources = [];
    const problems = [];
    const seen = new Set();
    for (const raw of Array.isArray(list) ? list : []) {
        const value = raw && typeof raw === 'object' ? (raw.url ?? raw.value ?? '') : raw;
        const parsed = parseSource(value);
        if (parsed.error) {
            if (parsed.input) problems.push(parsed);
            continue;
        }
        const key = `${parsed.provider}:${parsed.token.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        sources.push(parsed);
    }
    return { sources, problems };
}
