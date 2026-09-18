/*
 * The product's button, wherever it appears.
 *
 * It used to live at the foot of REPOS_CSS, in the Projects panel's stylesheet,
 * for no better reason than that the first button the product ever drew was in
 * that panel. Nine other modules then took a dependency on it that nothing
 * declared — search, quality, the welcome page, the project page, the flow
 * rail, both editors, the assistant sign-in — so deleting the panel would have
 * unstyled half the product. Here it is a shared control with a shared home,
 * which is what it always was.
 */
const CONTROLS_CSS = `
.studio-btn { border:1px solid var(--studio-line); border-radius:6px; background:var(--studio-surface-raised); color:var(--studio-text); cursor:pointer; font:600 11.5px/1 inherit; padding:7px 9px; }
.studio-btn:hover { border-color:var(--studio-accent); }
.studio-btn.primary { background:var(--studio-accent); border-color:var(--studio-accent); color:var(--studio-on-accent); }
.studio-btn.ghost { background:transparent; color:var(--studio-muted); }
`;

module.exports = { CONTROLS_CSS };
