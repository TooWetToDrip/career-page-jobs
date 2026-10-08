// Word matching for the job search. Everything is compared as whole words, ignoring case
// and accents, so "java" does not match "JavaScript" and "US" does not match "Australia".

/** Split text into lower-case words. Keeps the characters that matter in job titles: c++, c#, .net, node.js */
export function words(text) {
    if (text == null) return [];
    return String(text)
        .normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9+#.]+/g, ' ')
        .split(' ')
        .map((w) => w.replace(/\.+$/, ''))
        .filter((w) => w && /[a-z0-9]/.test(w));
}

/**
 * Turn one search entry into a matcher.
 *   data engineer     -> every word must be present, in any order
 *   "data engineer"   -> the exact phrase
 * @returns {{words: string[], exact: boolean} | null}
 */
export function parseTerm(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return null;
    const quoted = /^["“”'‘’](.*)["“”'‘’]$/.exec(s);
    const list = words(quoted ? quoted[1] : s);
    if (!list.length) return null;
    return { words: list, exact: Boolean(quoted) && list.length > 1 };
}

export function parseTerms(value) {
    return (Array.isArray(value) ? value : []).map(parseTerm).filter(Boolean);
}

/** True when the words appear next to each other, in order. */
export function hasPhrase(haystack, needle) {
    if (!needle.length || needle.length > haystack.length) return false;
    outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) {
            if (haystack[i + j] !== needle[j]) continue outer;
        }
        return true;
    }
    return false;
}

/** @param {string[]} textWords @param {{words: string[], exact: boolean}} term */
export function termMatches(textWords, term) {
    if (term.exact) return hasPhrase(textWords, term.words);
    return term.words.every((w) => textWords.includes(w));
}

export function anyTermMatches(textWords, terms) {
    return terms.some((term) => termMatches(textWords, term));
}

/** For places and company names: the words must appear together, in order. */
export function anyPhraseIn(texts, terms) {
    const lists = texts.filter(Boolean).map(words);
    return terms.some((term) => lists.some((list) => hasPhrase(list, term.words)));
}
