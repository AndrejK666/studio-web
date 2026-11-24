import * as crypto from 'crypto';
import type { AST } from 'toml-eslint-parser';
import type {
    RenameWorkspaceSourceRequest,
    WorkspaceConflictCode,
    WorkspaceSourceRenameImpactPreview
} from '../common/workspace-protocol';
import { plural } from '../common/plural';

type SourceField = 'path' | 'adapter' | 'role' | 'url' | 'branch';
type SourceRole = 'artifacts' | 'codebase' | 'kits' | 'full';

export interface WorkspaceTomlSourceEntry {
    readonly path?: string;
    readonly adapter?: string;
    readonly role?: SourceRole;
    readonly url?: string;
    readonly branch?: string;
}

export interface UpdateWorkspaceSourcePatch {
    readonly path?: string | null;
    readonly adapter?: string | null;
    readonly role?: SourceRole | null;
    readonly url?: string | null;
    readonly branch?: string | null;
}

export interface WorkspaceTomlRangeEdit {
    readonly start: number;
    readonly end: number;
    readonly text: string;
}

export interface WorkspaceTomlEditApplied {
    readonly status: 'applied';
    readonly rawToml: string;
    readonly edits: readonly WorkspaceTomlRangeEdit[];
    readonly impacts?: readonly WorkspaceSourceRenameImpactPreview[];
}

export interface WorkspaceTomlEditConflict {
    readonly status: 'conflict';
    readonly code: WorkspaceConflictCode;
    readonly message: string;
    readonly impacts?: readonly WorkspaceSourceRenameImpactPreview[];
}

export type WorkspaceTomlEditResult = WorkspaceTomlEditApplied | WorkspaceTomlEditConflict;

const SOURCE_FIELD_ORDER: readonly SourceField[] = ['path', 'adapter', 'role', 'url', 'branch'];
const SOURCE_ROLE_VALUES = new Set<SourceRole>(['artifacts', 'codebase', 'kits', 'full']);

export class WorkspaceTomlEditor {
    addSource(rawToml: string, ast: AST.TOMLProgram, sourceId: string, source: WorkspaceTomlSourceEntry): WorkspaceTomlEditResult {
        const validation = validateSourceEntry(source);
        if (validation) {
            return conflict('invalid-request', validation);
        }
        if (getSourceTable(ast, sourceId)) {
            return conflict('source-conflict', `Source "${sourceId}" already exists.`);
        }

        const nextRawToml = appendSourceTable(rawToml, sourceId, source);
        const edit: WorkspaceTomlRangeEdit = {
            start: rawToml.length,
            end: rawToml.length,
            text: nextRawToml.slice(rawToml.length)
        };
        return {
            status: 'applied',
            rawToml: nextRawToml,
            edits: edit.text ? [edit] : []
        };
    }

    updateSource(rawToml: string, ast: AST.TOMLProgram, sourceId: string, patch: UpdateWorkspaceSourcePatch): WorkspaceTomlEditResult {
        const table = getSourceTable(ast, sourceId);
        if (!table) {
            return conflict('invalid-request', `Source "${sourceId}" was not found.`);
        }

        const existing = readSourceEntry(table);
        const nextSource = buildUpdatedSourceEntry(existing, patch);
        const validation = validateSourceEntry(nextSource);
        if (validation) {
            return conflict('invalid-request', validation);
        }

        const edits: WorkspaceTomlRangeEdit[] = [];
        for (const field of SOURCE_FIELD_ORDER) {
            if (!hasOwn(patch, field)) {
                continue;
            }
            const keyValue = getTableKeyValue(table, field);
            const nextValue = nextSource[field];
            if (patch[field] === null) {
                if (keyValue) {
                    edits.push(removeLineRange(rawToml, keyValue.range[0]));
                }
                continue;
            }
            if (nextValue === undefined) {
                continue;
            }
            if (keyValue) {
                edits.push({
                    start: keyValue.value.range[0],
                    end: keyValue.value.range[1],
                    text: formatTomlString(String(nextValue), keyValue.value)
                });
            } else {
                edits.push(insertFieldIntoTable(rawToml, table, field, String(nextValue)));
            }
        }

        const nextRawToml = applyReplacements(rawToml, edits);
        return {
            status: 'applied',
            rawToml: nextRawToml,
            edits: sortEdits(edits)
        };
    }

    removeSource(rawToml: string, ast: AST.TOMLProgram, sourceId: string): WorkspaceTomlEditResult {
        const table = getSourceTable(ast, sourceId);
        if (!table) {
            return conflict('invalid-request', `Source "${sourceId}" was not found.`);
        }

        const edit = removeSourceTable(rawToml, ast, table);
        return {
            status: 'applied',
            rawToml: applyReplacements(rawToml, [edit]),
            edits: [edit]
        };
    }

    renameSource(rawToml: string, ast: AST.TOMLProgram, request: RenameWorkspaceSourceRequest): WorkspaceTomlEditResult {
        const table = getSourceTable(ast, request.sourceId);
        if (!table) {
            return conflict('invalid-request', `Source "${request.sourceId}" was not found.`);
        }
        if (getSourceTable(ast, request.nextSourceId)) {
            return conflict('source-conflict', `Source "${request.nextSourceId}" already exists.`);
        }

        const impacts = collectRenameImpacts(rawToml, ast, request.sourceId, request.nextSourceId, table, request.confirmedImpactIds);
        if (impacts.some(impact => !impact.confirmed)) {
            return conflict(
                'confirmation-required',
                `Renaming "${request.sourceId}" requires explicit confirmation for ${plural(impacts.filter(impact => !impact.confirmed).length, 'exact reference', 'exact references')}.`,
                impacts
            );
        }

        const headerRange = getHeaderSourceKeyRange(table);
        const edit: WorkspaceTomlRangeEdit = {
            start: headerRange.start,
            end: headerRange.end,
            text: formatTomlKeySegment(request.nextSourceId)
        };
        return {
            status: 'applied',
            rawToml: applyReplacements(rawToml, [edit]),
            edits: [edit],
            impacts
        };
    }
}

function conflict(
    code: WorkspaceConflictCode,
    message: string,
    impacts?: readonly WorkspaceSourceRenameImpactPreview[]
): WorkspaceTomlEditConflict {
    return { status: 'conflict', code, message, impacts };
}

function readSourceEntry(table: AST.TOMLTable): WorkspaceTomlSourceEntry {
    const source: Partial<WorkspaceTomlSourceEntry> = {};
    for (const field of SOURCE_FIELD_ORDER) {
        const keyValue = getTableKeyValue(table, field);
        if (!keyValue) {
            continue;
        }
        if (keyValue.value.type === 'TOMLValue' && keyValue.value.kind === 'string') {
            (source[field] as string | undefined) = keyValue.value.value;
        }
    }
    return source;
}

function buildUpdatedSourceEntry(existing: WorkspaceTomlSourceEntry, patch: UpdateWorkspaceSourcePatch): WorkspaceTomlSourceEntry {
    const nextSource: Partial<WorkspaceTomlSourceEntry> = { ...existing };
    for (const field of SOURCE_FIELD_ORDER) {
        if (!hasOwn(patch, field)) {
            continue;
        }
        const value = patch[field];
        if (value === null) {
            delete nextSource[field];
        } else if (value !== undefined) {
            (nextSource[field] as string | undefined) = value;
        }
    }
    return nextSource;
}

function appendSourceTable(rawToml: string, sourceId: string, source: WorkspaceTomlSourceEntry): string {
    const newline = detectNewline(rawToml);
    const hadFinalNewline = rawToml.length === 0 || endsWithNewline(rawToml);
    const separator = rawToml.length === 0
        ? ''
        : rawToml.endsWith(`${newline}${newline}`)
            ? ''
            : rawToml.endsWith(newline)
                ? newline
                : `${newline}${newline}`;
    return `${rawToml}${separator}${renderSourceTable(sourceId, source, newline, hadFinalNewline)}`;
}

function renderSourceTable(
    sourceId: string,
    source: WorkspaceTomlSourceEntry,
    newline: string,
    includeTrailingNewline: boolean
): string {
    const lines = [`[sources.${formatTomlKeySegment(sourceId)}]`];
    for (const field of SOURCE_FIELD_ORDER) {
        const value = source[field];
        if (value !== undefined) {
            lines.push(`${field} = ${formatTomlString(String(value))}`);
        }
    }
    const rendered = lines.join(newline);
    return includeTrailingNewline ? `${rendered}${newline}` : rendered;
}

function collectRenameImpacts(
    rawToml: string,
    ast: AST.TOMLProgram,
    sourceId: string,
    nextSourceId: string,
    table: AST.TOMLTable,
    confirmedImpactIds?: readonly string[]
): readonly WorkspaceSourceRenameImpactPreview[] {
    const confirmed = new Set(confirmedImpactIds ?? []);
    const headerRange = getHeaderSourceKeyRange(table);
    const directImpacts = collectAstStringImpacts(sourceId, nextSourceId, ast, headerRange, confirmed);
    const seen = new Set(directImpacts.map(impact => `${impact.range.start}:${impact.range.end}`));
    const tokenImpacts = ast.tokens
        .filter(token => token.range[0] >= 0 && token.range[1] > token.range[0])
        .filter(token => !rangesOverlap(headerRange, { start: token.range[0], end: token.range[1] }))
        .filter(token => getTokenLogicalValue(token) === sourceId)
        .filter(token => !seen.has(`${token.range[0]}:${token.range[1]}`))
        .map(token => buildImpact(
            sourceId,
            nextSourceId,
            '$token',
            rawToml.slice(token.range[0], token.range[1]),
            {
                start: token.range[0],
                end: token.range[1],
                line: token.loc.start.line,
                column: token.loc.start.column
            },
            confirmed
        ));

    return [...directImpacts, ...tokenImpacts].sort((left, right) => left.range.start - right.range.start);
}

function collectAstStringImpacts(
    sourceId: string,
    nextSourceId: string,
    ast: AST.TOMLProgram,
    excludedRange: { start: number; end: number },
    confirmed: ReadonlySet<string>
): readonly WorkspaceSourceRenameImpactPreview[] {
    const impacts: WorkspaceSourceRenameImpactPreview[] = [];
    const topLevel = ast.body[0];
    for (const entry of topLevel?.body ?? []) {
        if (entry.type === 'TOMLKeyValue') {
            appendKeyValueImpact(impacts, entry, sourceId, nextSourceId, excludedRange, confirmed, [keyPathFromKey(entry.key)]);
            continue;
        }
        if (entry.type === 'TOMLTable') {
            const tablePath = entry.resolvedKey.map(String);
            for (const fieldEntry of entry.body) {
                appendKeyValueImpact(
                    impacts,
                    fieldEntry,
                    sourceId,
                    nextSourceId,
                    excludedRange,
                    confirmed,
                    [...tablePath, keyPathFromKey(fieldEntry.key)]
                );
            }
        }
    }
    return impacts;
}

function appendKeyValueImpact(
    impacts: WorkspaceSourceRenameImpactPreview[],
    entry: AST.TOMLKeyValue,
    sourceId: string,
    nextSourceId: string,
    excludedRange: { start: number; end: number },
    confirmed: ReadonlySet<string>,
    pathSegments: readonly string[]
): void {
    if (entry.value.type !== 'TOMLValue' || entry.value.kind !== 'string' || entry.value.value !== sourceId) {
        return;
    }
    if (rangesOverlap(excludedRange, { start: entry.value.range[0], end: entry.value.range[1] })) {
        return;
    }
    impacts.push(buildImpact(
        sourceId,
        nextSourceId,
        pathSegments.join('.'),
        entry.value.style === 'literal' ? `'${entry.value.value}'` : JSON.stringify(entry.value.value),
        {
            start: entry.value.range[0],
            end: entry.value.range[1],
            line: entry.value.loc.start.line,
            column: entry.value.loc.start.column
        },
        confirmed
    ));
}

function buildImpact(
    sourceId: string,
    nextSourceId: string,
    path: string,
    evidence: string,
    range: WorkspaceSourceRenameImpactPreview['range'],
    confirmed: ReadonlySet<string>
): WorkspaceSourceRenameImpactPreview {
    const impactId = sha256(`${sourceId}:${nextSourceId}:${path}:${range.start}:${range.end}:${evidence}`);
    return {
        impactId,
        sourceId,
        nextSourceId,
        path,
        evidence,
        range,
        confirmed: confirmed.has(impactId),
        requiresExplicitEdit: true
    };
}

function removeSourceTable(rawToml: string, ast: AST.TOMLProgram, table: AST.TOMLTable): WorkspaceTomlRangeEdit {
    const start = lineBoundsAt(rawToml, table.range[0]).start;
    let end = lineBoundsAt(rawToml, table.range[1]).endWithNewline;
    const topLevel = ast.body[0];
    const siblings = topLevel?.body.filter((entry): entry is AST.TOMLTable => entry.type === 'TOMLTable') ?? [];
    const currentIndex = siblings.findIndex(candidate => candidate.range[0] === table.range[0] && candidate.range[1] === table.range[1]);
    const nextTable = currentIndex >= 0 ? siblings[currentIndex + 1] : undefined;
    const limit = nextTable ? lineBoundsAt(rawToml, nextTable.range[0]).start : rawToml.length;

    while (end < limit) {
        const nextLine = lineBoundsAt(rawToml, end);
        const text = rawToml.slice(nextLine.start, nextLine.end).trim();
        if (text.length !== 0) {
            break;
        }
        end = nextLine.endWithNewline;
    }

    return { start, end, text: '' };
}

function getSourceTable(ast: AST.TOMLProgram, sourceId: string): AST.TOMLTable | undefined {
    return ast.body[0]?.body.find((node): node is AST.TOMLTable =>
        node.type === 'TOMLTable'
        && node.kind === 'standard'
        && node.resolvedKey.length === 2
        && node.resolvedKey[0] === 'sources'
        && node.resolvedKey[1] === sourceId
    );
}

function getTableKeyValue(table: AST.TOMLTable, key: SourceField): AST.TOMLKeyValue | undefined {
    return table.body.find(entry => entry.key.keys.length === 1 && getKeySegment(entry.key.keys[0]) === key);
}

function insertFieldIntoTable(rawToml: string, table: AST.TOMLTable, field: SourceField, value: string): WorkspaceTomlRangeEdit {
    const anchorNode = table.body.length > 0 ? table.body[table.body.length - 1] : table;
    const line = lineBoundsAt(rawToml, anchorNode.range[1]);
    const anchor = line.endWithNewline;
    const newline = detectNewline(rawToml);
    const needsLeadingNewline = anchor > 0 && rawToml[anchor - 1] !== '\n';
    const trailingNewline = anchor < rawToml.length || endsWithNewline(rawToml) ? newline : '';
    return {
        start: anchor,
        end: anchor,
        text: `${needsLeadingNewline ? newline : ''}${field} = ${formatTomlString(value)}${trailingNewline}`
    };
}

function getHeaderSourceKeyRange(table: AST.TOMLTable): { start: number; end: number } {
    const keyNode = table.key.keys[1];
    return {
        start: keyNode.range[0],
        end: keyNode.range[1]
    };
}

function validateSourceEntry(source: WorkspaceTomlSourceEntry): string | undefined {
    const hasPath = typeof source.path === 'string' && source.path.length > 0;
    const hasUrl = typeof source.url === 'string' && source.url.length > 0;
    if (hasPath === hasUrl) {
        return 'Workspace source entries must define exactly one of "path" or "url".';
    }
    if (source.branch !== undefined && !hasUrl) {
        return 'Workspace source entries may set "branch" only when "url" is present.';
    }
    if (source.role !== undefined && !SOURCE_ROLE_VALUES.has(source.role)) {
        return `Unsupported workspace source role "${String(source.role)}".`;
    }
    return undefined;
}

function formatTomlKeySegment(value: string): string {
    return /^[A-Za-z0-9_-]+$/u.test(value) ? value : formatTomlString(value);
}

function formatTomlString(value: string, existingValue?: AST.TOMLContentNode): string {
    if (existingValue?.type === 'TOMLValue' && existingValue.kind === 'string' && existingValue.style === 'literal' && !value.includes("'") && !value.includes('\n')) {
        return `'${value}'`;
    }
    return JSON.stringify(value);
}

function keyPathFromKey(key: AST.TOMLKey): string {
    return key.keys.map(getKeySegment).join('.');
}

function getKeySegment(node: AST.TOMLBare | AST.TOMLQuoted): string {
    return node.type === 'TOMLBare' ? node.name : node.value;
}

function getTokenLogicalValue(token: AST.Token): string | undefined {
    if (token.type === 'Bare') {
        return token.value;
    }
    if ('string' in token) {
        return token.string;
    }
    return undefined;
}

function removeLineRange(rawToml: string, index: number): WorkspaceTomlRangeEdit {
    const bounds = lineBoundsAt(rawToml, index);
    return { start: bounds.start, end: bounds.endWithNewline, text: '' };
}

function lineBoundsAt(rawToml: string, index: number): { start: number; end: number; endWithNewline: number } {
    const boundedIndex = Math.max(0, Math.min(index, rawToml.length));
    let start = boundedIndex;
    while (start > 0 && rawToml[start - 1] !== '\n' && rawToml[start - 1] !== '\r') {
        start -= 1;
    }
    let end = boundedIndex;
    while (end < rawToml.length && rawToml[end] !== '\n' && rawToml[end] !== '\r') {
        end += 1;
    }
    let endWithNewline = end;
    if (rawToml[endWithNewline] === '\r') {
        endWithNewline += 1;
    }
    if (rawToml[endWithNewline] === '\n') {
        endWithNewline += 1;
    }
    return { start, end, endWithNewline };
}

function applyReplacements(rawToml: string, edits: readonly WorkspaceTomlRangeEdit[]): string {
    return [...edits]
        .sort((left, right) => right.start - left.start)
        .reduce((result, edit) => `${result.slice(0, edit.start)}${edit.text}${result.slice(edit.end)}`, rawToml);
}

function sortEdits(edits: readonly WorkspaceTomlRangeEdit[]): readonly WorkspaceTomlRangeEdit[] {
    return [...edits].sort((left, right) => left.start - right.start);
}

function detectNewline(rawToml: string): string {
    return rawToml.includes('\r\n') ? '\r\n' : '\n';
}

function endsWithNewline(rawToml: string): boolean {
    return rawToml.endsWith('\n');
}

function rangesOverlap(left: { start: number; end: number }, right: { start: number; end: number }): boolean {
    return left.start < right.end && right.start < left.end;
}

function sha256(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function hasOwn<T extends object, K extends keyof T>(value: T, key: K): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
}
