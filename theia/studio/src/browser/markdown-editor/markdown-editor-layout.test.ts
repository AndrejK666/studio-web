import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Markdown editor layout contract', () => {
    it('keeps scroll restoration out of focus transitions and in explicit lifecycle hooks', () => {
        const widget = fs.readFileSync(path.resolve(__dirname, 'markdown-editor-widget.tsx'), 'utf8');

        expect(widget).not.toContain("addEventListener('focusin'");
        expect(widget).not.toContain("removeEventListener('focusin'");
        expect(widget).not.toMatch(/handleFocusIn\s*=\s*\(\)\s*=>/u);

        expect(widget).toMatch(/onScrollCapture=\{this\.handleEditorRootScrollCapture\}/u);
        expect(widget).toMatch(/handleEditorRootScrollCapture\s*=\s*\(event:\s*React\.UIEvent<HTMLDivElement>\):\s*void\s*=>\s*\{[\s\S]*event\.target === editorScroller[\s\S]*this\.scrollTopRef\.current = editorScroller\.scrollTop;/u);
        expect(widget).toMatch(/onPointerDownCapture=\{this\.handleEditorRootPointerDownCapture\}/u);
        expect(widget).toMatch(/handleEditorRootPointerDownCapture\s*=\s*\(event:\s*React\.PointerEvent<HTMLDivElement>\):\s*void\s*=>\s*\{[\s\S]*isTableCellPointerDownTarget\(event\.target\)[\s\S]*requestAnimationFrame\(\(\)\s*=>\s*\{[\s\S]*restoreTableCellScrollTop\(scrollTop\);[\s\S]*this\.pendingTableCellRestoreFrame = requestAnimationFrame\(\(\)\s*=>\s*\{[\s\S]*this\.pendingTableCellRestoreFrame = undefined;[\s\S]*restoreTableCellScrollTop\(scrollTop\);/u);
        expect(widget).toMatch(/isTableCellPointerDownTarget\(target:\s*EventTarget \| null\):\s*boolean\s*\{[\s\S]*target\.closest\('td, th'\)[\s\S]*cell\.closest\('tbody'\)[\s\S]*cell\.hasAttribute\('data-tool-cell'\)[\s\S]*cell\.querySelector\('\[contenteditable="true"\]'\)/u);
        expect(widget).toMatch(/restoreTableCellScrollTop\(scrollTop:\s*number\):\s*void\s*\{[\s\S]*editorScroller\.scrollTop = scrollTop;[\s\S]*this\.scrollTopRef\.current = scrollTop;/u);
        expect(widget).toMatch(/cancelPendingTableCellRestore\(\):\s*void\s*\{[\s\S]*cancelAnimationFrame\(this\.pendingTableCellRestoreFrame\);[\s\S]*this\.pendingTableCellRestoreFrame = undefined;/u);
        expect(widget).toMatch(/restoreState\(oldState:\s*MarkdownEditorWidgetState\):\s*void\s*\{[\s\S]*requestAnimationFrame\(\(\)\s*=>\s*this\.restoreScrollTop\(\)\);/u);
        expect(widget).toMatch(/handleModelContentChanged\(\):\s*void\s*\{[\s\S]*syncEditorMarkdown\(this\.editorRef\.current,\s*this\.saveable\.editorMarkdown\);[\s\S]*this\.restoreScrollTop\(\);/u);
        expect(widget).toMatch(/captureScrollTop\(\):\s*number\s*\{[\s\S]*this\.scrollTopRef\.current = editorScroller\.scrollTop;/u);
        expect(widget).toMatch(/focusEditor\(\):\s*void\s*\{[\s\S]*contentEditable\?\.focus\(\{\s*preventScroll:\s*true\s*\}\);/u);
        expect(widget).toMatch(/this\.toDispose\.push\(this\.saveable\.onSavingChanged\(\(\)\s*=>\s*this\.update\(\)\)\);/u);
        expect(widget).toMatch(/const conflictActionsDisabled = this\.saveable\.saving;/u);
        expect(widget).toMatch(/<button type='button' disabled=\{conflictActionsDisabled\} onClick=\{\(\)\s*=>\s*void this\.compareExternalChange\(\)\}>Compare<\/button>/u);
        expect(widget).toMatch(/<button type='button' disabled=\{conflictActionsDisabled\} onClick=\{\(\)\s*=>\s*void this\.reloadFromDisk\(\)\}>Reload from Disk<\/button>/u);
        expect(widget).toMatch(/<button type='button' disabled=\{conflictActionsDisabled\} onClick=\{\(\)\s*=>\s*void this\.keepLocal\(\)\}>Keep Local<\/button>/u);
        expect(widget).toMatch(/dispose\(\):\s*void\s*\{[\s\S]*this\.cancelPendingTableCellRestore\(\);[\s\S]*this\.toDispose\.dispose\(\);/u);
    });

    it('pins the flex toolbar and scrolling ownership CSS contract', () => {
        const css = fs.readFileSync(path.resolve(__dirname, 'markdown-editor.css'), 'utf8');

        // Not `.studio-markdown-editor` bare: MDXEditor gives its popup
        // container the editor's class too, and a full-height flex column on
        // that container is a layer over the whole IDE that eats every click.
        const editorRule = getRuleBlock(css, '.studio-markdown-editor:not(.mdxeditor-popup-container)');
        expectDeclaration(editorRule, 'display', 'flex');
        expectDeclaration(editorRule, 'flex-direction', 'column');
        expectDeclaration(editorRule, 'min-height', '0');

        expect(css).not.toMatch(/(^|\})\s*\.studio-markdown-editor\s*\{/u);
        const popupRule = getRuleBlock(css, '.mdxeditor-popup-container');
        expectDeclaration(popupRule, 'pointer-events', 'none');
        const popupChildRule = getRuleBlock(css, '.mdxeditor-popup-container > *');
        expectDeclaration(popupChildRule, 'pointer-events', 'auto');

        const toolbarRule = getRuleBlock(css, '.studio-markdown-editor .mdxeditor-toolbar');
        expectDeclaration(toolbarRule, 'flex-shrink', '0');

        const scrollerRule = getRuleBlock(css, '.studio-markdown-editor .mdxeditor-root-contenteditable');
        expectDeclaration(scrollerRule, 'flex', '1');
        expectDeclaration(scrollerRule, 'min-height', '0');
        expectDeclaration(scrollerRule, 'overflow', 'auto');

        const contentRule = getRuleBlock(css, '.studio-markdown-editor-content');
        expect(contentRule).not.toMatch(/\bheight\s*:\s*100%\s*;/u);
        expect(contentRule).not.toMatch(/\boverflow\s*:\s*auto\s*;/u);
    });
});

function getRuleBlock(css: string, selector: string): string {
    const escapedSelector = escapeRegExp(selector);
    const match = new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`, 'u').exec(css);
    expect(match).toBeTruthy();
    return match?.[1] ?? '';
}

function expectDeclaration(ruleBlock: string, property: string, value: string): void {
    expect(ruleBlock).toMatch(new RegExp(`${escapeRegExp(property)}\\s*:\\s*${escapeRegExp(value)}\\s*;`, 'u'));
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
