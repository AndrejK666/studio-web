import { fireEvent, render, screen } from '@testing-library/react';
import { FRONTX_SHARED_PROPERTY_LANGUAGE } from '@gears-frontx/react';
import { expect, it } from 'vitest';
import { createMfeBridgeFixture } from '@frontx-test-utils/createMfeBridgeFixture';
import { HelloPanel } from '../../../examples/kits/hello-kit/src/HelloPanel';

it('runs the standalone kit estimate with no backend or gear', () => {
  const { bridge } = createMfeBridgeFixture({
    domainId: 'overview',
    instanceId: 'hello-kit',
    initialProperties: { [FRONTX_SHARED_PROPERTY_LANGUAGE]: 'en' },
  });
  render(<HelloPanel bridge={bridge} />);

  const remaining = screen.getByRole('spinbutton', { name: 'Items remaining' });
  const throughput = screen.getByRole('spinbutton', { name: 'Items completed per workday' });
  fireEvent.change(remaining, { target: { value: '13' } });
  expect(screen.getByRole('status').textContent).toBe('Estimated workdays: 5');

  fireEvent.change(remaining, { target: { value: '0' } });
  expect(screen.getByRole('status').textContent).toBe('Estimated workdays: 0');

  fireEvent.change(throughput, { target: { value: '0' } });
  expect(screen.getByRole('status').textContent).toMatch(/positive daily throughput/);
});
