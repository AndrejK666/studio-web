/**
 * The People screen's app: its API services, the framework's i18n and the
 * shared query cache. No slices — the screen reads and draws.
 */

import { createFrontX, apiRegistry, i18n, queryCacheShared } from '@gears-frontx/react';
import { AccountsApiService, PeopleApiService, authShared } from '@constructor-studio/mfe-shared';
import { WorkSignalsApiService } from './api/WorkSignalsApiService';

apiRegistry.register(PeopleApiService);
// Other kits' gears, each optional: the open pull requests, the activity feed, Insight.
apiRegistry.register(WorkSignalsApiService);
apiRegistry.register(AccountsApiService);
apiRegistry.initialize();

// authShared(): the host's auth plugin lives in the host's realm, so without it
// every read goes out with no bearer and answers 401.
const mfeApp = createFrontX().use(i18n()).use(queryCacheShared()).use(authShared()).build();

export { mfeApp };
