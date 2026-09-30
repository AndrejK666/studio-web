import * as React from '@theia/core/shared/react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { Message } from '@theia/core/lib/browser/widgets/widget';
import { MessageService } from '@theia/core/lib/common/message-service';
import { BinaryBuffer } from '@theia/core/lib/common/buffer';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog/file-dialog-service';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { demandText, gradeTone } from './components-reference-model';
import { ComponentsReferenceContribution } from './components-reference-contribution';
import { RoadmapReport, groupAxes, loadRoadmapReport, reportSheets, workbookName } from './roadmap-report-model';
import { makeXlsx } from './xlsx';

/*
 * The roadmap report in the IDE: every component the roadmap board plans,
 * whether its plan holds, and who is waiting for it -- the platform team's
 * spreadsheet, answered by the catalogue. "Save as workbook" writes the same
 * report as an .xlsx (Roadmap and Summary sheets) wherever the person picks,
 * through Theia's save dialog, so it works the same in the portal's session
 * and on the desktop. A component's name opens it in the components reference.
 */

type State =
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; report: RoadmapReport };

@injectable()
export class RoadmapReportWidget extends ReactWidget {
    static readonly ID = 'studio:roadmap-report';
    static readonly LABEL = 'Roadmap';

    @inject(FileDialogService)
    protected readonly fileDialogs: FileDialogService;

    @inject(FileService)
    protected readonly files: FileService;

    @inject(WorkspaceService)
    protected readonly workspace: WorkspaceService;

    @inject(MessageService)
    protected readonly messages: MessageService;

    @inject(ComponentsReferenceContribution)
    protected readonly components: ComponentsReferenceContribution;

    protected state: State = { kind: 'loading' };
    protected saving = false;

    @postConstruct()
    protected init(): void {
        this.id = RoadmapReportWidget.ID;
        this.title.label = RoadmapReportWidget.LABEL;
        this.title.caption = 'Roadmap report';
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-milestone';
        this.addClass('studio-components-reference');
        this.addClass('studio-roadmap-report');
        this.node.tabIndex = 0;
        void this.reload();
    }

    protected override onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        this.node.focus();
    }

    async reload(): Promise<void> {
        this.state = { kind: 'loading' };
        this.update();
        const load = await loadRoadmapReport();
        this.state = load.kind === 'ok' ? { kind: 'ready', report: load.report } : { kind: 'error', message: load.message };
        this.update();
    }

    protected async save(report: RoadmapReport): Promise<void> {
        const asOf = new Date().toISOString().slice(0, 10);
        const uri = await this.fileDialogs.showSaveDialog(
            { title: 'Save the roadmap report', inputValue: workbookName(asOf), filters: { 'Excel workbook': ['xlsx'] } },
            this.workspace.tryGetRoots()[0],
        );
        if (!uri) {
            return;
        }
        this.saving = true;
        this.update();
        try {
            await this.files.writeFile(uri, BinaryBuffer.wrap(makeXlsx(reportSheets(report, asOf))));
            this.messages.info(`Saved the roadmap report to ${uri.path.base}.`);
        } catch (e) {
            this.messages.error(`Could not save the roadmap report: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            this.saving = false;
            this.update();
        }
    }

    protected async openComponent(name: string): Promise<void> {
        const widget = await this.components.openView();
        widget.select(name);
    }

    protected render(): React.ReactNode {
        if (this.state.kind === 'loading') {
            return <div className='scr-state'>Reading the roadmap from Studio…</div>;
        }
        if (this.state.kind === 'error') {
            return (
                <div className='scr-state scr-error'>
                    <p>{this.state.message}</p>
                    <button className='theia-button' onClick={() => void this.reload()}>Reload</button>
                </div>
            );
        }
        const report = this.state.report;
        const s = report.summary;
        return (
            <div className='srr-root'>
                <div className='srr-head'>
                    <span className='srr-lead'>
                        {report.total} gears on the roadmap board
                        {report.not_in_code > 0 && <span className='scr-muted'> · {report.not_in_code} not in code yet</span>}
                        {report.not_on_board > 0 &&
                            <span className='scr-muted'> · {report.not_on_board} catalogued components are not on it — unplanned, or pin one through its Roadmap item field</span>}
                    </span>
                    <button
                        className='theia-button'
                        disabled={report.total === 0 || this.saving}
                        title='Write the Roadmap and Summary sheets as an Excel workbook'
                        onClick={() => void this.save(report)}
                    >
                        {this.saving ? 'Saving…' : 'Save as workbook'}
                    </button>
                    <button className='theia-button secondary scr-reload' title='Read the report again' onClick={() => void this.reload()}>
                        <span className='codicon codicon-refresh' />
                    </button>
                </div>
                {report.total === 0
                    ? <div className='scr-state'>Nothing on the board matched a catalogued component. Turn on the Roadmap source on the portal&apos;s Components page and sync.</div>
                    : (
                        <>
                            {s.by_group.length > 0 && (
                                <section className='srr-groups'>
                                    <h3>By group</h3>
                                    <table className='srr-table'>
                                        <thead>
                                            <tr>
                                                <th /><th className='num'>Gears</th><th className='num'>Done</th><th className='num'>In code</th>
                                                {groupAxes(s.by_group).map(l => <th key={l} className='num'>{l}</th>)}
                                                <th className='num'>Estimated</th>
                                                <th className='num' title='person-days'>Effort</th>
                                                <th className='num' title='person-days'>Remaining</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {s.by_group.map(g => (
                                                <tr key={g.group}>
                                                    <td>{g.group}</td>
                                                    <td className='num'>{g.total}</td>
                                                    <td className='num'>{g.done || ''}</td>
                                                    <td className='num'>{g.in_code}</td>
                                                    {groupAxes(s.by_group).map(l => {
                                                        const avg = g.axes.find(a => a.label === l)?.average;
                                                        return <td key={l} className='num'>{avg === null || avg === undefined ? '' : `${avg}%`}</td>;
                                                    })}
                                                    <td className='num'>{g.estimated} of {g.total}</td>
                                                    <td className='num'>{g.effort_md ? `${g.effort_md} d` : ''}</td>
                                                    <td className='num'>{g.remaining_md ? `${Math.round(g.remaining_md)} d` : ''}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </section>
                            )}
                            <div className='srr-summary'>
                                <section>
                                    <h3>Stage</h3>
                                    <table className='srr-table'>
                                        <tbody>{s.by_stage.map(c => <tr key={c.label}><td>{c.label}</td><td className='num'>{c.count}</td></tr>)}</tbody>
                                    </table>
                                </section>
                                <section>
                                    <h3>Plan</h3>
                                    <table className='srr-table'>
                                        <tbody>{s.by_plan.map(c => <tr key={c.label}><td>{c.label}</td><td className='num'>{c.count}</td></tr>)}</tbody>
                                    </table>
                                </section>
                                <section>
                                    <h3>Milestone</h3>
                                    <table className='srr-table'>
                                        <thead><tr><th /><th>Due</th><th className='num'>All</th><th className='num'>Committed</th><th className='num'>At risk</th></tr></thead>
                                        <tbody>
                                            {s.by_milestone.map(m => (
                                                <tr key={m.milestone}>
                                                    <td>{m.milestone}</td>
                                                    <td className='nowrap'>{m.due ?? ''}</td>
                                                    <td className='num'>{m.total}</td>
                                                    <td className='num'>{m.committed || ''}</td>
                                                    <td className={`num${m.at_risk ? ' bad' : ''}`}>{m.at_risk || ''}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </section>
                                {s.by_consumer.length > 0 && (
                                    <section>
                                        <h3>Consumers</h3>
                                        <table className='srr-table'>
                                            <thead>
                                                <tr>
                                                    <th /><th className='num'>P1</th><th className='num'>P2</th><th className='num'>P3</th>
                                                    <th className='num' title='P1 demand whose plan is at risk or needs a check'>P1 off track</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {s.by_consumer.map(c => (
                                                    <tr key={c.consumer}>
                                                        <td>{c.consumer}</td>
                                                        <td className='num'>{c.p1 || ''}</td>
                                                        <td className='num'>{c.p2 || ''}</td>
                                                        <td className='num'>{c.p3 || ''}</td>
                                                        <td className={`num${c.p1_not_on_track ? ' watch' : ''}`}>{c.p1_not_on_track || ''}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </section>
                                )}
                            </div>
                            {s.overdue.length > 0 && <div className='scr-warning bad srr-overdue'>⚠ Overdue: {s.overdue.join(', ')}</div>}
                            <table className='srr-table srr-rows'>
                                <thead>
                                    <tr><th>Gear</th><th>Stage</th><th>Milestone</th><th>Plan</th><th>Needed by</th><th>Assignees</th><th className='num'>Effort</th><th>Grade</th></tr>
                                </thead>
                                <tbody>
                                    {report.items.map(row => {
                                        const r = row.readiness;
                                        return (
                                            <tr key={`${row.number ?? ''}:${row.title}`}>
                                                <td>
                                                    <a href='#' title={`Open ${row.name} in Components`} onClick={ev => { ev.preventDefault(); void this.openComponent(row.name); }}>
                                                        {row.title}
                                                    </a>
                                                    <div className='scr-muted'>{row.components.length ? row.components.join(', ') : 'not in code yet'}</div>
                                                    {r.roadmap_item && (
                                                        <a className='srr-issue' href={r.roadmap_item} target='_blank' rel='noreferrer' title={row.roadmap_title ?? r.roadmap_item}>
                                                            <span className='codicon codicon-link-external' />
                                                        </a>
                                                    )}
                                                </td>
                                                <td className='nowrap'>{r.stage ?? ''}</td>
                                                <td className='nowrap'>
                                                    {r.milestone ?? ''}
                                                    {r.due && <span className='scr-muted'> · {r.due}</span>}
                                                    {r.committed && <span className='scr-muted'> · committed</span>}
                                                </td>
                                                <td>
                                                    {r.plan && <span className={`scr-sched ${r.plan_lamp ?? ''}`}><span className='scr-dot' />{r.plan}</span>}
                                                    {r.plan_reasons.length > 0 && <div className='scr-muted'>{r.plan_reasons.join('; ')}</div>}
                                                </td>
                                                <td>{demandText(r) ?? ''}</td>
                                                <td>{row.assignees ?? ''}</td>
                                                <td className='num nowrap'>
                                                    {row.effort_md === null ? '' : `${row.effort_md} d`}
                                                    {row.remaining_md !== null && row.remaining_md !== row.effort_md &&
                                                        <div className='scr-muted'>{Math.round(row.remaining_md)} d left</div>}
                                                </td>
                                                <td>{r.grade && <span className={`scr-grade ${gradeTone(r.grade) ?? ''}`}>{r.grade}</span>}</td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </>
                    )}
            </div>
        );
    }
}
