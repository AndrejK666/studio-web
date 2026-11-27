/**
 * The deployment's FrontX starting points (the prototype's
 * `loadFrontxDefaults` / `useFrontxDefaults`, frontend-constructor-view.tsx):
 * `frontx` of `GET /studio-product/v1/gearbox` (`STUDIO_FRONTX_*`), asked once
 * per organization and page load; the built-in templates until it answers or when it fails.
 */

import { useEffect, useState } from 'react';

import { frontxDefaultsOf, type FrontxDefaults } from '../../../model/frontend-constructor';
import { productApiFor, type Org } from '../../../api/client';
import { useScope } from '../../common';

/** What each organization's deployment answered (its corpus and settings are its own). */
const asked = new Map<string, Promise<FrontxDefaults>>();
const known = new Map<string, FrontxDefaults>();

export function loadFrontxDefaults(org: Org): Promise<FrontxDefaults> {
  const key = org ?? '';
  let ask = asked.get(key);
  if (!ask) {
    ask = productApiFor(org)
      .gearboxStatus()
      .then(
        (st) => {
          const d = frontxDefaultsOf(st);
          known.set(key, d);
          return d;
        },
        () => {
          // Asked again next time; the built-in templates meanwhile.
          asked.delete(key);
          return frontxDefaultsOf(null);
        }
      );
    asked.set(key, ask);
  }
  return ask;
}

/** For tests: forget what was asked. */
export function forgetFrontxDefaults(): void {
  asked.clear();
  known.clear();
}

/** [`loadFrontxDefaults`] for a view: the built-in templates until it answers. */
export function useFrontxDefaults(): FrontxDefaults {
  const { orgId } = useScope();
  const [d, setD] = useState<FrontxDefaults>(() => known.get(orgId ?? '') ?? frontxDefaultsOf(null));
  useEffect(() => {
    let alive = true;
    void loadFrontxDefaults(orgId).then((x) => alive && setD(x));
    return () => {
      alive = false;
    };
  }, [orgId]);
  return d;
}
