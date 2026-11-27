'use strict';
// A portal document's address in the IDE, the same one Theia uses
// (`studio-doc:/{workspaceId}/{documentId}/{slug}.md`). The file name carries
// no identity; it keeps the tab readable and `.md` routing working.

function slug(title) {
    const words = String(title || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return words.slice(0, 60) || 'document';
}

function documentUri(workspaceId, documentId, title) {
    const part = (value) => encodeURIComponent(String(value));
    return `studio-doc:/${part(workspaceId)}/${part(documentId)}/${slug(title)}.md`;
}

module.exports = { documentUri, slug };
