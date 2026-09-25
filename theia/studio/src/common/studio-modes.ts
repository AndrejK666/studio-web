// The session's workbench modes, named once.
//
// Ids only, and no imports beyond nothing: the perspective descriptors pull in
// every widget they place, and the markdown open handler must be able to ask
// "which mode is this?" without any of that coming with the answer.

/**
 * The normal mode — a repository, its SCM, the agents and the graphs.
 *
 * Deliberately Theia's OWN default id. `registerPerspective` is keyed by id, so
 * registering this one REPLACES the built-in "Default" rather than adding a
 * third entry beside it. A session that never switches therefore behaves
 * exactly as it did, and the picker offers two real choices instead of one real
 * one and a stub.
 */
export const WORKBENCH_PERSPECTIVE_ID = 'default';

/** Writing, rather than building. */
export const DOCUMENTS_PERSPECTIVE_ID = 'studio.documents';
/** Running and steering coding agents, laid out the way the Orca app is. */
export const ORCA_PERSPECTIVE_ID = 'studio.orca-mode';
/** Everything at once: every view placed, nothing collapsed, the whole menu. */
export const FULL_PERSPECTIVE_ID = 'studio.full';

/**
 * How the two markdown editors are arbitrated.
 *
 * Both claim `.md`, and an `OpenHandler` competes on the number `canHandle`
 * returns. The product editor (`studio-product-ext`) answers 500 flat; Theia's
 * own `EditorManager` answers 100. So this extension's editor can step between
 * them by mode instead of either winning everywhere:
 *
 *   Workbench mode → 600, this editor opens the file.
 *   Documents mode → 400, the product editor opens it, and this one is still
 *                    ahead of plain Monaco if the product surface is absent.
 *
 * `studio-doc:` is not part of that argument: a portal document is not a file,
 * and only this extension's resolver can read one. The product handler matches
 * on the `.md` at the end of the URI and would hand it to the file service,
 * which has no provider for the scheme — so it keeps the winning number in
 * every mode.
 */
export const MARKDOWN_PRIORITY = {
    /** Wins over the product editor and Monaco. */
    preferred: 600,
    /** Below the product editor (500), above Monaco (100). */
    deferred: 400,
} as const;
