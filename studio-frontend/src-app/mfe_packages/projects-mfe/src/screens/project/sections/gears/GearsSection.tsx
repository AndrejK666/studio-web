import React, { useId, useRef, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@gears-frontx/react';
import {
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@gears-frontx/ui-kit';
import { useEverLoaded, useThemedRoot } from '@constructor-studio/mfe-shared';
import { useGearsSectionTranslations, useGearsText } from '../../../../i18n';
import { MATCH_PROVIDERS, providerFor, specTooLarge } from '../../../../model/gearsMatch';
import {
  GEARS_MATCH_SLICE_KEY,
  modelPicked,
  providerPicked,
  specCleared,
  specPicked,
} from '../../../../slices/gearsMatchSlice';
import { SectionSkeleton } from '../../../../components/SectionStates';
import { MatchResult } from './MatchResult';
import styles from './GearsSection.module.css';

/** The Gears section: what a match runs on and reads, and the project's latest match. */
export const GearsSection: React.FC<{ projectId: string }> = ({ projectId }) => {
  const { isLoaded, error } = useGearsSectionTranslations();
  const everLoaded = useEverLoaded(isLoaded);
  const t = useGearsText();
  const dispatch = useAppDispatch();
  const choice = useAppSelector((state) => state[GEARS_MATCH_SLICE_KEY].choice);
  const spec = useAppSelector((state) => state[GEARS_MATCH_SLICE_KEY].spec);
  const run = useAppSelector((state) => state[GEARS_MATCH_SLICE_KEY].runs[projectId]);
  const [container, findThemedRoot] = useThemedRoot();
  const [fileProblem, setFileProblem] = useState<'spec_too_large' | 'spec_unreadable' | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const ids = { provider: useId(), model: useId(), spec: useId() };

  if (!everLoaded && !error) return <SectionSkeleton />;

  const provider = providerFor(choice.provider);
  const providerName = (code: string): string => t(`provider_${code}`);
  const running = run?.phase === 'running';

  const readFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setFileProblem(null);
    try {
      const content = await file.text();
      if (specTooLarge(content)) setFileProblem('spec_too_large');
      else dispatch(specPicked({ name: file.name, content }));
    } catch {
      setFileProblem('spec_unreadable');
    }
    // The same file chosen again must still fire a change.
    if (fileInput.current) fileInput.current.value = '';
  };

  return (
    <div className={styles.section} ref={findThemedRoot}>
      <div className={styles.form}>
        <Field>
          <FieldLabel htmlFor={ids.provider}>{t('connection')}</FieldLabel>
          <Select
            value={choice.provider}
            modal={false}
            disabled={running}
            onValueChange={(next) => dispatch(providerPicked(next ?? ''))}
          >
            <SelectTrigger id={ids.provider} className={styles.trigger}>
              <SelectValue>{(selected) => providerName(String(selected))}</SelectValue>
            </SelectTrigger>
            <SelectContent container={container ?? undefined}>
              {MATCH_PROVIDERS.map((item) => (
                <SelectItem key={item.code} value={item.code}>
                  {providerName(item.code)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>{t('connection_hint')}</FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor={ids.model}>{t('model')}</FieldLabel>
          <Select
            value={choice.model}
            modal={false}
            disabled={running}
            onValueChange={(next) => dispatch(modelPicked(next ?? ''))}
          >
            <SelectTrigger id={ids.model} className={styles.trigger}>
              <SelectValue>{(selected) => String(selected)}</SelectValue>
            </SelectTrigger>
            <SelectContent container={container ?? undefined}>
              {(provider?.models ?? []).map((model) => (
                <SelectItem key={model} value={model}>
                  {model}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>{t('model_hint')}</FieldDescription>
        </Field>

        {provider && <p className={styles.muted}>{t('sent_to', { host: provider.host })}</p>}

        <Field data-invalid={fileProblem ? true : undefined}>
          <FieldLabel htmlFor={ids.spec}>{t('spec')}</FieldLabel>
          <div className={styles.fileRow}>
            <input
              ref={fileInput}
              id={ids.spec}
              className={styles.hiddenInput}
              type="file"
              accept=".md,text/markdown"
              onChange={(event) => void readFile(event.target.files?.[0])}
            />
            {spec && <span className={styles.fileName}>{spec.name}</span>}
            <Button
              variant="outline"
              size="sm"
              disabled={running}
              onClick={() => fileInput.current?.click()}
            >
              {spec ? t('spec_change') : t('spec_choose')}
            </Button>
            {spec && (
              <Button
                variant="ghost"
                size="sm"
                disabled={running}
                onClick={() => dispatch(specCleared())}
              >
                {t('spec_clear')}
              </Button>
            )}
          </div>
          <FieldDescription>{t('spec_hint')}</FieldDescription>
          {fileProblem && <FieldError>{t(fileProblem)}</FieldError>}
        </Field>
      </div>

      <div className={styles.panel}>
        <h2 className={styles.heading}>{t('latest')}</h2>
        {run ? (
          <MatchResult run={run} providerName={providerName(run.provider)} />
        ) : (
          <Empty className={styles.empty}>
            <EmptyHeader>
              <EmptyTitle>{t('none_title')}</EmptyTitle>
              <EmptyDescription>{t('none_note')}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </div>
  );
};

GearsSection.displayName = 'GearsSection';
