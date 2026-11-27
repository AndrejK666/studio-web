import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { useSearchShortcut } from './SidebarLayout';

const Probe: React.FC<{ open: () => void; enabled?: boolean }> = ({ open, enabled = true }) => {
  useSearchShortcut(open, enabled);
  return <input aria-label="typing here" />;
};

describe('Ctrl K', () => {
  afterEach(cleanup);

  it('opens Search, with Ctrl or ⌘', () => {
    const open = vi.fn();
    render(<Probe open={open} />);
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: 'K', metaKey: true });
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('leaves the key to whoever is typing, and to a screen that took it', () => {
    const open = vi.fn();
    const view = render(<Probe open={open} />);
    fireEvent.keyDown(view.getByLabelText('typing here'), { key: 'k', ctrlKey: true });
    const taken = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true });
    taken.preventDefault();
    document.body.dispatchEvent(taken);
    fireEvent.keyDown(document.body, { key: 'k' });
    expect(open).not.toHaveBeenCalled();
  });

  it('does nothing while Search is not registered', () => {
    const open = vi.fn();
    render(<Probe open={open} enabled={false} />);
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    expect(open).not.toHaveBeenCalled();
  });
});
