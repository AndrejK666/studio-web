// node test/status-line-theme.test.js
//
// The theme field of the bottom line (#1073). A standalone session keeps its
// light/dark toggle; inside the portal's frame the portal decides the mode, so
// the toggle is not offered there at all.
const assert = require('assert');
const { statusLine } = require('../src/browser/status-line.js');

function render(embedded) {
    const elements = new Map();
    statusLine.init({
        statusBar: {
            setElement: (id, entry) => { elements.set(id, entry); return Promise.resolve(); },
            removeElement: id => { elements.delete(id); return Promise.resolve(); }
        },
        shell: { widgets: [], currentWidget: undefined, activateWidget() { /* unused */ } },
        workspaceService: undefined,
        fileService: undefined,
        currentTheme: () => 'dark',
        toggleTheme: () => { /* unused */ },
        embedded: () => embedded
    });
    statusLine.context = async () => ({ location: 'project', autosave: true, root: undefined });
    statusLine.terminalVisible = () => false;
    return statusLine.render().then(() => elements);
}

(async () => {
    const standalone = await render(false);
    assert.ok(standalone.has('studio.theme'), 'a standalone session has the toggle');
    assert.ok(standalone.get('studio.theme').text.includes('Dark'));

    const embedded = await render(true);
    assert.ok(!embedded.has('studio.theme'), 'inside the portal the portal decides the mode');
    assert.ok(embedded.has('studio.location'), 'the rest of the line is unchanged');

    console.log('status-line-theme: ok');
})().catch(error => { console.error(error); process.exit(1); });
