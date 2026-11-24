import React from 'react';
import { Blocks } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@gears-frontx/react';
import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@gears-frontx/ui-kit';
import { useEverLoaded, useThemedRoot } from '@constructor-studio/mfe-shared';
import { useGearsSectionTranslations, useGearsText } from '../../../../i18n';
import { startGearsMatch } from '../../../../actions/gearsMatchActions';
import { GEARS_MATCH_SLICE_KEY, matchRunning } from '../../../../slices/gearsMatchSlice';

interface GearsActionsProps {
  projectId: string;
  projectName: string;
}

/** Match to Gears, in the project header. */
export const GearsActions: React.FC<GearsActionsProps> = ({ projectId, projectName }) => {
  const { isLoaded } = useGearsSectionTranslations();
  const everLoaded = useEverLoaded(isLoaded);
  const t = useGearsText();
  const dispatch = useAppDispatch();
  const running = useAppSelector((state) => matchRunning(state[GEARS_MATCH_SLICE_KEY], projectId));
  const spec = useAppSelector((state) => state[GEARS_MATCH_SLICE_KEY].spec);
  const choice = useAppSelector((state) => state[GEARS_MATCH_SLICE_KEY].choice);
  const [container, findThemedRoot] = useThemedRoot();

  if (!everLoaded) return null;
  const icon = <Blocks />;
  const blocked = running ? 'match_running' : spec ? null : 'match_no_spec';
  const label = running ? t('match_running_label') : t('match');

  return (
    <span ref={findThemedRoot}>
      {blocked ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button size="sm" icon={icon} disabled focusableWhenDisabled>
                {label}
              </Button>
            }
          />
          <TooltipContent container={container ?? undefined}>{t(blocked)}</TooltipContent>
        </Tooltip>
      ) : (
        <Button
          size="sm"
          icon={icon}
          onClick={() => {
            if (spec)
              void startGearsMatch(dispatch, {
                projectId,
                projectName,
                spec,
                choice,
              });
          }}
        >
          {label}
        </Button>
      )}
    </span>
  );
};

GearsActions.displayName = 'GearsActions';
