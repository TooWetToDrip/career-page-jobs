// Small text helpers. No dependencies on purpose: fewer things to break.

const NAMED = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
    hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', middot: '·',
    copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', yen: '¥', deg: '°', times: '×',
};

/** Decode HTML entities such as &amp; &#39; &#x27; */
export function decodeEntities(input) {
    if (input == null) return '';
    return String(input).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body) => {
        if (body[0] === '#') {
            const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
            try { return String.fromCodePoint(code); } catch { return match; }
        }
        const named = NAMED[body.toLowerCase()];
        return named === undefined ? match : named;
    });
}

/** Turn HTML into readable plain text: paragraphs and list items become lines. */
export function htmlToText(html) {
    if (html == null) return '';
    let s = String(html);
    s = s.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ');
    s = s.replace(/<li\b[^>]*>/gi, '\n- ');
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<\/(p|div|h[1-6]|ul|ol|tr|table|section|article)>/gi, '\n');
    s = s.replace(/<[^>]+>/g, '');
    s = decodeEntities(s);
    s = s.replace(/ /g, ' ');
    s = s.replace(/[ \t\f\v]+/g, ' ');
    s = s.replace(/ *\n */g, '\n');
    s = s.replace(/\n{3,}/g, '\n\n');
    return s.trim();
}

/** Trimmed string, or null when empty. */
export function clean(value) {
    if (value == null) return null;
    const s = String(value).replace(/\s+/g, ' ').trim();
    return s === '' ? null : s;
}

/** ISO timestamp from a date string, a millisecond number, or null when it cannot be read. */
export function toIso(value) {
    if (value == null || value === '') return null;
    const d = typeof value === 'number' ? new Date(value) : new Date(String(value));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Unique non-empty strings, order kept. */
export function unique(list) {
    const out = [];
    const seen = new Set();
    for (const item of list || []) {
        const s = clean(item);
        if (!s) continue;
        const key = s.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(s);
    }
    return out;
}
