/**
 * The Spec graph kit's app: its API service, the framework's i18n and the
 * shared query cache. No slices: the screen reads, decides and redraws.
 */

import { createFrontX, apiRegistry, i18n, queryCacheShared } from '@gears-frontx/react';
import { authShared } from '@constructor-studio/mfe-shared';
import { SpecGraphApiService } from './api/SpecGraphApiService';

apiRegistry.register(SpecGraphApiService);
apiRegistry.initialize();

// authShared(): the host's auth plugin lives in the host's realm, so without it
// every read goes out with no bearer and answers 401.
const mfeApp = createFrontX().use(i18n()).use(queryCacheShared()).use(authShared()).build();

export { mfeApp };
