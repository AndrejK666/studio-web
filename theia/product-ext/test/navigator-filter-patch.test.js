// node test/navigator-filter-patch.test.js
//
// Files shown is applied once. With the studio extension's Explorer, whose
// filter applies it in the documents presentation only, the product must not
// patch it into every presentation: a code mode's `src/` was listed and empty.
const assert = require('assert');
const Module = require('module');

const FileNavigatorFilter = Symbol('FileNavigatorFilter');
const stubs = {
    '@theia/navigator/lib/browser/navigator-filter': { FileNavigatorFilter },
    '@theia/filesystem/lib/browser': { FileStatNode: { is: item => !!(item && item.fileStat) } },
};
const load = Module._load;
Module._load = function (request, ...rest) {
    return Object.prototype.hasOwnProperty.call(stubs, request) ? stubs[request] : load.call(this, request, ...rest);
};
// Kept for the whole test: file-type-settings requires these lazily.
const { patchNavigatorFilter, fileTypeSettings } = require('../src/browser/file-type-settings.js');

function container(filter) {
    return { get: id => { assert.strictEqual(id, FileNavigatorFilter); return filter; } };
}
const sourceFile = {
    fileStat: { isDirectory: false },
    uri: { toString: () => 'file:///ws/src/main.ts', path: { ext: '.ts' } },
};
// Files shown for the root: the defaults, which do not include ts.
fileTypeSettings.byRoot.set('file:///ws', new Set(['md']));

// Without the studio extension: the product's filter hides what Files shown leaves out.
const plain = { filterItem: () => true, fireFilterChanged: () => {} };
patchNavigatorFilter(container(plain));
assert.strictEqual(plain.filterItem(sourceFile), false, 'a plain navigator filter gets Files shown');

// With it: the studio filter is left as it is.
const own = () => true;
const studio = { appliesFilesShown: true, filterItem: own, fireFilterChanged: () => {} };
patchNavigatorFilter(container(studio));
assert.strictEqual(studio.filterItem, own, 'the studio Explorer filter is not patched');
assert.strictEqual(studio.filterItem(sourceFile), true);

console.log('navigator-filter-patch: ok');
