/**
 * The second entry of this MFE: the Gears matcher kit's screens (ADR-0072),
 * Project › Gear match and Organization › Gears matcher. Its own entry, not a
 * section of the Product kit's: the shell shows it only where that kit is
 * installed, and one lifecycle singleton holds one root.
 */

import React from 'react';
import type { ChildMfeBridge } from '@gears-frontx/react';
import { anchorKitThemeOnShadowHost, StudioMfeLifecycle } from '@constructor-studio/mfe-shared';
import kitTheme from '@gears-frontx/ui-kit/theme.css?inline';
import { mfeApp } from './init';
import { GearsMatcherRoot } from './GearsMatcherRoot';

const KIT_THEME_ON_HOST = anchorKitThemeOnShadowHost(kitTheme);

class GearsMatcherLifecycle extends StudioMfeLifecycle {
  constructor() {
    super(mfeApp, KIT_THEME_ON_HOST);
  }

  protected renderContent(bridge: ChildMfeBridge): React.ReactNode {
    return <GearsMatcherRoot bridge={bridge} />;
  }
}

export default new GearsMatcherLifecycle();
