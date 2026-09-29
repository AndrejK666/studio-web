import { emptyMenus, type TopMenuNode } from './studio-mode-bar';

// Its own file: studio-mode-bar.test.tsx fails to load in the session image
// for a reason of its own, and these would not run inside it.

const menu = (id: string, label: string, empty: boolean): TopMenuNode & { asked: unknown[] } => {
    const asked: unknown[] = [];
    return {
        id, label, children: [{}], asked,
        isEmpty: (path, matcher) => {
            asked.push(path, matcher);
            return empty;
        },
    };
};

describe('the top-level menus with nothing to show', () => {
    it('are those whose every entry is hidden now, asked with the context keys', () => {
        const gearbox = menu('3_gearbox', 'Gearbox', true);
        const file = menu('1_file', 'File', false);
        const keys = { match: () => false };
        expect([...emptyMenus([file, gearbox], keys)]).toEqual(['Gearbox']);
        expect(gearbox.asked).toEqual([['menubar', '3_gearbox'], keys]);
    });

    it('leave out a node that is not a labelled menu', () => {
        expect(emptyMenus([{ id: 'x' }, { id: 'y', label: 'Y' }], {}).size).toBe(0);
    });
});
