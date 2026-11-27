import { describe, expect, it } from 'vitest';
import { completeExposeCss, cssOfChunk, type MfManifest, type ViteManifest } from '../../scripts/lib/expose-css';

// reports-mfe as Vite built it: two exposes importing one chunk that carries the ui-kit's CSS.
const vite: ViteManifest = {
  '_i18n.js': { file: 'assets/i18n-1.js', css: ['assets/i18n-1.css'], imports: ['_preload.js'] },
  '_preload.js': { file: 'assets/preload.js' },
  'src/lifecycle.tsx': {
    file: 'assets/lifecycle-1.js',
    isEntry: true,
    css: ['assets/lifecycle-1.css'],
    imports: ['_i18n.js', '_preload.js'],
  },
  'src/metrics.tsx': { file: 'assets/metrics-1.js', isEntry: true, imports: ['_i18n.js', '_preload.js'] },
};

const expose = (name: string, js: string, css: string[]) => ({
  name,
  path: `./${name}`,
  assets: { js: { sync: [js], async: [] }, css: { sync: css, async: [] } },
});

const mf: MfManifest = {
  exposes: [
    expose('lifecycle', 'assets/lifecycle-1.js', ['assets/lifecycle-1.css']),
    expose('metrics', 'assets/metrics-1.js', []),
  ],
};

describe('the CSS an expose needs', () => {
  it('is its own chunk’s and every imported chunk’s, transitively', () => {
    expect(cssOfChunk(vite, 'assets/metrics-1.js')).toEqual(['assets/i18n-1.css']);
    expect(cssOfChunk(vite, 'assets/lifecycle-1.js')).toEqual(['assets/lifecycle-1.css', 'assets/i18n-1.css']);
    expect(cssOfChunk(vite, 'assets/unknown.js')).toEqual([]);
  });

  it('is added to every expose of the federation manifest, keeping what was listed', () => {
    const { manifest, changed } = completeExposeCss(mf, vite);
    expect(changed).toBe(true);
    expect(manifest.exposes.map((e) => e.assets.css.sync)).toEqual([
      ['assets/lifecycle-1.css', 'assets/i18n-1.css'],
      ['assets/i18n-1.css'],
    ]);
    // A second pass finds nothing to add.
    expect(completeExposeCss(manifest, vite).changed).toBe(false);
  });

  it('survives an import cycle', () => {
    const cyclic: ViteManifest = {
      a: { file: 'a.js', css: ['a.css'], imports: ['b'] },
      b: { file: 'b.js', css: ['b.css'], imports: ['a'] },
    };
    expect(cssOfChunk(cyclic, 'a.js')).toEqual(['a.css', 'b.css']);
  });
});
