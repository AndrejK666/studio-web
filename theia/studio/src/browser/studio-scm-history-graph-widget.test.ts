import { withHistorySubject } from './studio-scm-history-subject';
import type { HistoryGraphEntry } from '@theia/scm/lib/browser/scm-history-graph-model';

function entry(subject: string, message?: string): HistoryGraphEntry {
    return {
        item: {
            id: 'abc123',
            parentIds: [],
            subject,
            message
        },
        graphRow: {
            lane: 0,
            color: 0,
            // Theia 1.75 split the lane's colour in two: `color` paints the dot
            // and the segment below it, `topColor` the segment above, and they
            // differ when a ref's colour overrides the one inherited from the
            // chain above. This fixture is about subjects, not about lanes, so
            // one commit on one lane has the same colour on both sides of it.
            topColor: 0,
            edges: [],
            hasContinuation: false,
            hasTopLine: false
        },
        // Also new in 1.75: whether this is the commit HEAD points at. These
        // fixtures are a lone commit standing for "some entry the provider
        // returned", and nothing here reads it — false is the honest value for
        // an entry that is not claiming to be the current one.
        isCurrent: false
    };
}

describe('Studio SCM history graph compatibility', () => {
    it('uses the first commit-message line when the provider omits subject', () => {
        expect(withHistorySubject(entry('', 'chore(studio): save README.md\n\nSaved-At: now')).item.subject)
            .toBe('chore(studio): save README.md');
    });

    it('accepts the actual VS Code 1.95 payload with no subject property', () => {
        const original = entry('', 'fix: visible title');
        const { subject: _subject, ...itemWithoutSubject } = original.item;
        const actualProviderEntry = {
            ...original,
            item: itemWithoutSubject
        } as unknown as HistoryGraphEntry;

        expect(withHistorySubject(actualProviderEntry).item.subject)
            .toBe('fix: visible title');
    });

    it('preserves a provider-supplied subject', () => {
        const original = entry('Provider subject', 'Different message');
        expect(withHistorySubject(original)).toBe(original);
    });
});
