import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { BundledIcon } from './BundledIcon';

describe('BundledIcon', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('draws a bundled glyph, or a neutral one for a name it does not have, and fetches nothing', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { container } = render(
      <>
        <BundledIcon declared="lucide:search" className="glyph" />
        <BundledIcon declared="material-symbols:inbox" />
        <BundledIcon declared={undefined} />
      </>
    );
    const svgs = container.querySelectorAll('svg');
    expect(svgs).toHaveLength(3);
    expect(svgs[0].getAttribute('class')).toContain('lucide-search');
    expect(svgs[0].getAttribute('class')).toContain('glyph');
    expect(svgs[1].getAttribute('class')).toContain('lucide-circle-dashed');
    expect(svgs[2].getAttribute('class')).toContain('lucide-circle-dashed');
    expect(fetch).not.toHaveBeenCalled();
  });
});
