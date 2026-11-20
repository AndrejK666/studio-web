import { useRef } from 'react';
import { act, render } from '@testing-library/react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { KitContentSlot } from '@constructor-studio/mfe-shared';
import { MfeContentSlots } from './MfeContentSlots';

vi.mock('@/app/layout/KitSlot', () => ({
  KitSlot: ({ slot }: { slot: { name: string } }) => <span>{slot.name} contribution</span>,
}));

it('mounts and releases kit contributions inside a screen shadow root', async () => {
  function Host() {
    const screens = useRef<HTMLDivElement>(null);
    return <div ref={screens} data-testid="screens"><MfeContentSlots screens={screens} /></div>;
  }

  const { getByTestId } = render(<Host />);
  const element = document.createElement('div');
  getByTestId('screens').append(element);
  const shadow = element.attachShadow({ mode: 'open' });
  const screenRoot = createRoot(shadow);

  await act(() => screenRoot.render(<KitContentSlot name="organization.inbox.content" />));
  const anchor = shadow.querySelector('[data-kit-content-anchor]');
  expect(anchor?.textContent).toBe('organization.inbox.content contribution');

  await act(() => screenRoot.unmount());
  expect(anchor?.textContent).toBe('');
  expect(shadow.textContent).toBe('');
});
