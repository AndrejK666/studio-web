import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogKit, KitContents, KitDetail } from '../../../api/KitsApiService';
import { keepsKit, type KitRow } from '../KitsGrid';
import { KindBadge, kindHint } from '../KindBadge';
import { KitContentsSection, type KitFileIo } from './KitContentsSection';

const t = ((key: string, params?: Record<string, unknown>) =>
  params ? `${key}(${Object.values(params).join('|')})` : key) as never;

const EMPTY: KitContents = {
  screens: [],
  types: [],
  rules: [],
  functions: [],
  services: [],
  inbox: [],
  mcp_tools: [],
  permissions: { reads: [], writes: [], listens: [] },
  material: [],
  kinds: [],
  docs: [],
};

const KIT: CatalogKit = {
  slug: 'project-lifecycle',
  name: 'Project lifecycle',
  description: '',
  publisher: 'Constructor Fabric',
  visibility: 'public',
  source: 'builtin',
  repository_url: '',
  default_version: '0.4.0',
  manifest_path: '',
  shelf: 'builtin',
  kind: 'gears',
  brings: ['gears', 'model'],
};

const DETAIL: KitDetail = {
  kit: KIT,
  manifest: 'built-in',
  gdl_rendered_from: "the built-in kit.json and Studio's screens",
  source_manifest: 'kit.json',
  contents: {
    ...EMPTY,
    types: [
      {
        gts: 'gts.cf.studio.kit.project_lifecycle.phase.v1~',
        name: 'Phase',
        description: null,
        id: 'project-lifecycle-phase',
        adopts: false,
        fields: [{ name: 'order', type: 'integer', description: null, required: true, origin: 'kit' }],
      },
      { gts: 'gts.cf.studio.milestone.v1~', name: 'Milestone', description: null, id: 'milestone', adopts: true, fields: [] },
    ],
    mcp_tools: [{ name: 'project_phase_set', description: 'Moves a project to a phase' }],
    inbox: [{ id: 'phase-waiting', label: 'Phases waiting on you' }],
    gears: [
      {
        gear: 'studio-kits',
        types: ['project-lifecycle-phase'],
        mcp_tools: ['project_phase_set'],
        routes: ['PUT /studio-kits/v1/project-phase'],
        sync_only_with_kit: false,
      },
    ],
    permissions: { reads: ['GET /studio-kits/v1/project-phase'], writes: ['PUT /studio-kits/v1/project-phase'], listens: [] },
  },
};

function io(): KitFileIo & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    text: vi.fn((url: string) => {
      calls.push(url);
      return Promise.resolve(url.includes('kit.gdl') ? 'gdl_version = "1.7"\n\nkit(\n)' : '{"slug": "x"}');
    }),
    blob: vi.fn((url: string) => {
      calls.push(url);
      return Promise.resolve(new Blob(['x']));
    }),
    save: vi.fn(),
  };
}

describe('KitContentsSection', () => {
  it('lists each part with its count, empty ones said as empty', () => {
    render(<KitContentsSection detail={DETAIL} t={t} io={io()} />);
    const count = (id: string) =>
      document.querySelector(`[data-kit-list="${id}"] [data-kit-count]`)?.textContent;
    expect(count('types')).toBe('2');
    expect(count('tools')).toBe('1');
    expect(count('writes')).toBe('1');
    expect(count('reads')).toBe('1');
    expect(count('gears')).toBe('1');
    expect(count('inbox')).toBe('1');
    expect(count('rules')).toBe('0');
    expect(count('functions')).toBe('0');
    const rules = document.querySelector('[data-kit-list="rules"]') as HTMLElement;
    expect(within(rules).getByText('contents_none')).toBeTruthy();

    // A type with its GTS id, new or existing, and its fields.
    const phase = document.querySelector('[data-kit-type="project-lifecycle-phase"]') as HTMLElement;
    expect(within(phase).getByText('gts.cf.studio.kit.project_lifecycle.phase.v1~')).toBeTruthy();
    expect(within(phase).getByText('contents_type_new')).toBeTruthy();
    expect(within(phase).getByText('order*: integer')).toBeTruthy();
    const milestone = document.querySelector('[data-kit-type="milestone"]') as HTMLElement;
    expect(within(milestone).getByText('contents_type_existing')).toBeTruthy();
    // The tool's description, the claimed route by method and path, the gear it claims and calls.
    expect(screen.getByText('Moves a project to a phase')).toBeTruthy();
    const writes = document.querySelector('[data-kit-list="writes"]') as HTMLElement;
    expect(within(writes).getByText('PUT')).toBeTruthy();
    const gear = document.querySelector('[data-kit-gear-use="studio-kits"]') as HTMLElement;
    expect(within(gear).getByText('contents_gear_claims')).toBeTruthy();
    expect(within(gear).getByText('contents_gear_calls')).toBeTruthy();
    // The kit.gdl is marked rendered, and from what.
    expect(screen.getByText("contents_gdl_rendered(the built-in kit.json and Studio's screens)")).toBeTruthy();
  });

  it('opens kit.gdl and the source manifest as text, and downloads the archive', async () => {
    const files = io();
    render(<KitContentsSection detail={DETAIL} t={t} io={files} />);
    fireEvent.click(screen.getByRole('button', { name: 'kit.gdl' }));
    const text = await waitFor(() => {
      const pre = document.querySelector('[data-kit-file-text="kit.gdl"] pre');
      expect(pre).toBeTruthy();
      return pre as HTMLElement;
    });
    expect(text.textContent).toContain('gdl_version = "1.7"');
    expect(files.calls[0]).toBe('/cf/studio-kits/v1/catalog/project-lifecycle/kit.gdl');

    fireEvent.click(screen.getByRole('button', { name: 'kit.json' }));
    await waitFor(() => expect(document.querySelector('[data-kit-file-text="manifest"] pre')?.textContent).toBe('{"slug": "x"}'));

    fireEvent.click(screen.getByRole('button', { name: 'contents_archive' }));
    await waitFor(() => expect(files.save).toHaveBeenCalledWith(expect.any(Blob), 'project-lifecycle-0.4.0.tar.gz'));
    expect(files.calls).toContain('/cf/studio-kits/v1/catalog/project-lifecycle/archive');
  });

  it("reads an organization's own kit in its organization, and says why a download failed", async () => {
    const files = io();
    files.blob = vi.fn(() => Promise.reject(new Error('503 the repository did not answer')));
    render(
      <KitContentsSection
        detail={{ ...DETAIL, kit: { ...KIT, slug: 'ops', shelf: 'organization' }, gdl_rendered_from: null }}
        organizationId="org-1"
        t={t}
        io={files}
      />
    );
    expect(screen.getByText('contents_gdl_authored')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'kit.gdl' }));
    await waitFor(() => expect(files.calls[0]).toBe('/cf/studio-kits/v1/catalog/ops/kit.gdl?organization_id=org-1'));
    fireEvent.click(screen.getByRole('button', { name: 'contents_archive' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('503 the repository did not answer');
  });
});

describe('the kit type', () => {
  it('is a short label whose tooltip says the tier and the other tiers it brings', () => {
    render(<KindBadge kit={KIT} t={t} />);
    const badge = document.querySelector('[data-kit-kind="gears"]') as HTMLElement;
    expect(within(badge).getByText('kind_gears')).toBeTruthy();
    expect(badge.getAttribute('title')).toBe('kind_gears_hint kind_also(kind_model)');
    expect(kindHint({ kind: 'material', brings: ['material'] }, t)).toBe('kind_material_hint');
  });

  it('filters the rows by kind', () => {
    const row = (kind: KitRow['kind']): KitRow => ({ ...KIT, kind, id: String(kind), status: 'unknown' });
    const filters = { kind: { value: ['runtime', 'material'] } };
    expect(keepsKit(row('runtime'), filters)).toBe(true);
    expect(keepsKit(row('material'), filters)).toBe(true);
    expect(keepsKit(row('gears'), filters)).toBe(false);
    expect(keepsKit(row(undefined), filters)).toBe(false);
    expect(keepsKit(row('gears'), {})).toBe(true);
  });
});
