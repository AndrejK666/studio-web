/*
 * What a link is, read from the link (requirement 21).
 *
 * "Studio shall let authorised plugins render recognised links, resource
 * identifiers, or embedded blocks — such as Jira issues, dashboards, repository
 * cards, or build status panels — inline in Rich view."
 *
 * A URL on its own line is the least readable thing a document can contain. It
 * is also, very often, the most important: the ticket the paragraph is about,
 * the pull request that implements it, the dashboard the number came from. This
 * turns the ones it recognises into a line somebody can read.
 *
 * # Nothing is fetched, and that is the design rather than a shortcut
 *
 * Everything here is derived from the URL's own text. No network call, no
 * token, no third-party code. Three things follow, and each of them is a
 * property worth more than the extra detail a request would buy:
 *
 *   - IT WORKS OFFLINE AND IN A BRANCH. A document read on a plane renders the
 *     same as one read at a desk, and a reviewer reading a pull request sees
 *     what the author saw.
 *   - IT LEAKS NOTHING. Rendering a document does not tell a Jira instance that
 *     somebody opened it, and does not need a credential that would then have
 *     to be scoped, stored and rotated.
 *   - IT CANNOT HANG. A card is a pure function of a string, so a slow or dead
 *     service cannot block the editor — requirement 21's "do not block editing"
 *     is not a timeout here, it is an absence of anything to time out.
 *
 * The cost is honest: the card says an issue's KEY and not its title, because
 * the key is in the URL and the title is not. A card that promised the title
 * would have to fetch it, and would then have to decide what to show while it
 * was fetching and what to show when it failed.
 *
 * # What "authorised plugins" means here
 *
 * This is the registry and the fallback, with the recognisers built in. Running
 * somebody else's code inside the editor needs a plugin host with an origin, a
 * permission model and a review path, and this product has none — so the honest
 * shape today is a table a project turns entries on and off in, and a stated
 * gap rather than a half-built sandbox.
 *
 * # The fallback is that there is nothing to fall back from
 *
 * A link this does not recognise, or one whose recogniser throws, is left
 * exactly as it was written. Nothing is replaced and nothing is hidden, so
 * "preserve the original resource with a clear fallback" is a property of the
 * shape rather than a code path that has to be right.
 */

/** A kind a project can turn off. Order is the order they are tried. */
const KINDS = ['change', 'issue', 'tracker', 'repository'];

function host(url) {
    const match = /^https?:\/\/([^/?#]+)/i.exec(String(url || ''));
    return match ? match[1].toLowerCase() : '';
}

/** The path, without the query, the fragment or a trailing slash. */
function segments(url) {
    const match = /^https?:\/\/[^/?#]+(\/[^?#]*)?/i.exec(String(url || ''));
    const path = match && match[1] ? match[1] : '';
    return path.split('/').filter(Boolean).map(decodeSafe);
}

function decodeSafe(part) {
    try {
        return decodeURIComponent(part);
    } catch (error) {
        return part;                    // a stray percent is not worth a throw
    }
}

/*
 * The recognisers, in order. Each takes the parsed URL and answers a card or
 * nothing; the first answer wins.
 *
 * A TABLE rather than a chain of ifs, because "which links does this product
 * recognise" is a question somebody will ask of the code, and a list answers it
 * at a glance. Adding a recogniser is a row.
 */
const RECOGNISERS = [
    /* A change under review: GitHub's pull request, GitLab's merge request.
     * First, because its URL also matches the repository rule below and the
     * more specific answer is the useful one. */
    {
        kind: 'change',
        match(parts, at) {
            if (parts.length < 4) { return undefined; }
            const [owner, repo, kindSegment, number] = parts.slice(-4);
            const change = kindSegment === 'pull' || kindSegment === 'pulls' ||
                kindSegment === 'merge_requests';
            if (!change || !/^\d+$/.test(number)) { return undefined; }
            return {
                title: '#' + number,
                subtitle: owner + '/' + repo,
                badge: kindSegment === 'merge_requests' ? 'merge request' : 'pull request',
                host: at
            };
        }
    },
    /* An issue in a forge. */
    {
        kind: 'issue',
        match(parts, at) {
            if (parts.length < 4) { return undefined; }
            const [owner, repo, kindSegment, number] = parts.slice(-4);
            if (kindSegment !== 'issues' || !/^\d+$/.test(number)) { return undefined; }
            return { title: '#' + number, subtitle: owner + '/' + repo, badge: 'issue', host: at };
        }
    },
    /* A tracker's own issue key: Jira's `/browse/ABC-123`, and the same shape
     * under `/jira/software/.../ABC-123`. The key is what people say out loud,
     * so the key is the title. */
    {
        kind: 'tracker',
        match(parts, at) {
            const key = parts.find(part => /^[A-Z][A-Z0-9_]+-\d+$/.test(part));
            if (!key) { return undefined; }
            const browse = parts.includes('browse') || parts.includes('jira');
            if (!browse) { return undefined; }
            return { title: key, subtitle: at, badge: 'issue', host: at };
        }
    },
    /* A repository, which is what is left of a forge URL once the specific
     * things above have had their turn. */
    {
        kind: 'repository',
        match(parts, at) {
            if (!/(^|\.)(github\.com|gitlab\.com)$/.test(at)) { return undefined; }
            if (parts.length !== 2) { return undefined; }
            const [owner, repo] = parts;
            if (!owner || !repo || repo.endsWith('.git')) { return undefined; }
            return { title: owner + '/' + repo, subtitle: at, badge: 'repository', host: at };
        }
    }
];

/**
 * What this link is, or nothing.
 *
 * @param url      the href as written in the document
 * @param enabled  the kinds this project allows; every kind when omitted
 */
function recognise(url, enabled) {
    const at = host(url);
    if (!at) { return undefined; }                   // relative links are not resources
    const parts = segments(url);
    if (!parts.length) { return undefined; }
    const allowed = Array.isArray(enabled) ? enabled : KINDS;

    for (const recogniser of RECOGNISERS) {
        if (!allowed.includes(recogniser.kind)) { continue; }
        let card;
        try {
            card = recogniser.match(parts, at);
        } catch (error) {
            /* A recogniser that throws is a recogniser that does not recognise.
             * Requirement 21: a failing one preserves the original resource and
             * does not block editing, and the cheapest way to keep that promise
             * is for a failure to be indistinguishable from a miss. */
            console.warn('[studio] link recogniser failed', recogniser.kind, error);
            card = undefined;
        }
        if (card) { return { kind: recogniser.kind, url: String(url), ...card }; }
    }
    return undefined;
}

/**
 * Is this paragraph just a link?
 *
 * The card treatment is for a URL standing on its own line, which is where an
 * unreadable link actually hurts. A link inside a sentence is already carrying
 * its own words and replacing it would rewrite the sentence.
 */
function isBareLink(text, href) {
    const trimmed = String(text == null ? '' : text).trim();
    return !!trimmed && (trimmed === String(href || '').trim() || /^<[^>]+>$/.test(trimmed));
}

module.exports = { recognise, isBareLink, host, segments, KINDS, RECOGNISERS };
