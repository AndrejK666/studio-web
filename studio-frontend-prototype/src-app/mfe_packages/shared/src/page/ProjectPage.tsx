import React from 'react';
import { CircleHelpIcon } from 'lucide-react';
import {
  Button,
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderTitle,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Skeleton,
} from '@gears-frontx/ui-kit';
import { useThemedRoot } from '../lists/grid/useThemedRoot';
import styles from './ProjectPage.module.css';

export interface ProjectPageProps {
  /** The tab's title: the name it has in the tab bar. */
  title: React.ReactNode;
  /** Draws a placeholder in place of the title while the tab's words load. */
  busy?: boolean;
  /** Beside the title: counts and states as badges, a product's name. */
  chips?: React.ReactNode;
  /** One short line under the title. A paragraph about the tab is `help`. */
  description?: React.ReactNode;
  /** What the tab is for, a click away behind a "?" next to the title. */
  help?: React.ReactNode;
  /** The "?"'s accessible name; required with `help`. */
  helpLabel?: string;
  /** The tab's buttons, at the end of the header. */
  actions?: React.ReactNode;
  /** The tab's own class on the body, for a body laid out other than as a column. */
  bodyClassName?: string;
  /** `data-section` on the body, for a frame that holds several tabs. */
  section?: string;
  children?: React.ReactNode;
}

/**
 * The frame of a project tab: its header (title, chips, help, actions) over
 * the rule, and the body under it with the page's padding, scrolling on its
 * own while the header stays. Every project tab draws itself in one, so their
 * titles and bodies line up whichever MFE draws the tab.
 */
export const ProjectPage: React.FC<ProjectPageProps> = ({
  title,
  busy = false,
  chips,
  description,
  help,
  helpLabel,
  actions,
  bodyClassName,
  section,
  children,
}) => {
  const [themedRoot, attach] = useThemedRoot();
  return (
    <div ref={attach} className={styles.page} data-project-page>
      <PageHeader className={styles.header}>
        <PageHeaderContent>
          <PageHeaderTitle render={<h2 />} data-project-page-title>
            {busy ? <Skeleton className={styles.titleSkeleton} /> : title}
          </PageHeaderTitle>
          {(help || chips) && !busy && (
            <PageHeaderMeta className={styles.meta}>
              {help && (
                <Popover>
                  <PopoverTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<CircleHelpIcon />}
                        aria-label={helpLabel}
                        className={styles.helpTrigger}
                        data-project-page-help
                      />
                    }
                  />
                  <PopoverContent container={themedRoot ?? undefined} align="start" className={styles.help}>
                    {help}
                  </PopoverContent>
                </Popover>
              )}
              {chips}
            </PageHeaderMeta>
          )}
          {description && !busy && <PageHeaderDescription>{description}</PageHeaderDescription>}
        </PageHeaderContent>
        {actions && !busy && <PageHeaderActions>{actions}</PageHeaderActions>}
      </PageHeader>
      <div className={bodyClassName ? `${styles.body} ${bodyClassName}` : styles.body} data-section={section}>
        {children}
      </div>
    </div>
  );
};

ProjectPage.displayName = 'ProjectPage';
