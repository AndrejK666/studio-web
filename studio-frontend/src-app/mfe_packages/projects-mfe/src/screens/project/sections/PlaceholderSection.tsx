import React from 'react';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@gears-frontx/ui-kit';
import styles from './PlaceholderSection.module.css';

export const PlaceholderSection: React.FC<{ title: string; note: string }> = ({ title, note }) => (
  <Empty className={styles.empty}>
    <EmptyHeader>
      <EmptyTitle>{title}</EmptyTitle>
      <EmptyDescription>{note}</EmptyDescription>
    </EmptyHeader>
  </Empty>
);

PlaceholderSection.displayName = 'PlaceholderSection';
