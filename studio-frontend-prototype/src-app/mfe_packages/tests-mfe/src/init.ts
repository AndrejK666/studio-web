/**
 * The Tests kit's app: its API service, the framework's i18n and the shared
 * query cache. No slices — the screen reads and draws, it keeps no state of
 * its own worth a store.
 */

import { createFrontX, apiRegistry, i18n, queryCacheShared } from '@gears-frontx/react';
import { TestsApiService } from './api/TestsApiService';

apiRegistry.register(TestsApiService);
apiRegistry.initialize();

const mfeApp = createFrontX().use(i18n()).use(queryCacheShared()).build();

export { mfeApp };
