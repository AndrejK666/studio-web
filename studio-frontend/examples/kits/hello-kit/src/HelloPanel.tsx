/**
 * The demo kit's contributions into other screens' slots (`mfe/slots.ts` in
 * the shell): a panel inside Project › Overview and a chip
 * beside the open project in the path bar (`project.header.status`). Each is
 * its own entry, mounted into its own shadow root; the shell orders them and
 * keeps a failure of one from touching the others.
 */

import type { ChildMfeBridge } from '@gears-frontx/react';
import { useSharedProperty, FRONTX_SHARED_PROPERTY_LANGUAGE } from '@gears-frontx/react';
import { Badge, Card, CardContent } from '@gears-frontx/ui-kit';
import { useState } from 'react';

const TEXT = {
  en: {
    panel: 'Delivery estimate',
    remaining: 'Items remaining',
    throughput: 'Items completed per workday',
    estimate: (days: number) => `Estimated workdays: ${days}`,
    invalid: 'Enter a whole number of items and a positive daily throughput.',
    chip: 'hello-kit',
  },
  ru: {
    panel: 'Оценка срока поставки',
    remaining: 'Осталось задач',
    throughput: 'Задач за рабочий день',
    estimate: (days: number) => `Рабочих дней по оценке: ${days}`,
    invalid: 'Укажите целое число задач и положительную скорость работы.',
    chip: 'hello-kit',
  },
} as const;

function useText(bridge: ChildMfeBridge) {
  const language = useSharedProperty(FRONTX_SHARED_PROPERTY_LANGUAGE, { bridge });
  return language === 'ru' ? TEXT.ru : TEXT.en;
}

export function HelloPanel({ bridge }: { bridge: ChildMfeBridge }) {
  const t = useText(bridge);
  const [remaining, setRemaining] = useState('12');
  const [throughput, setThroughput] = useState('3');
  const count = Number(remaining);
  const rate = Number(throughput);
  const days = Math.ceil(count / rate);
  const valid = remaining !== '' && Number.isSafeInteger(count) && count >= 0 &&
    Number.isFinite(rate) && rate > 0 && Number.isSafeInteger(days);

  return (
    <Card data-hello-kit-panel>
      <CardContent style={{ display: 'grid', gap: '12px', padding: 'var(--space-4, 16px)' }}>
        <h3 style={{ margin: 0 }}>{t.panel}</h3>
        <label>
          {t.remaining}{' '}
          <input type="number" min="0" step="1" value={remaining}
            onChange={(event) => setRemaining(event.target.value)} />
        </label>
        <label>
          {t.throughput}{' '}
          <input type="number" min="0" step="any" value={throughput}
            onChange={(event) => setThroughput(event.target.value)} />
        </label>
        <output aria-live="polite">{valid ? t.estimate(days) : t.invalid}</output>
      </CardContent>
    </Card>
  );
}

export function HelloStatus({ bridge }: { bridge: ChildMfeBridge }) {
  const t = useText(bridge);
  return (
    <Badge variant="secondary" data-hello-kit-status>
      {t.chip}
    </Badge>
  );
}
