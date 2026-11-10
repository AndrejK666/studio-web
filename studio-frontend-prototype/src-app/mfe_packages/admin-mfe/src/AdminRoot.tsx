/**
 * The Admin level's sections, in one entry (ADR-0068 §1: people, rights and
 * settings are the shell's). The shell names the section; the organization is
 * the one the path bar has picked, as the prototype's admin header did.
 */

import React from 'react';
import { useSharedProperty, type ChildMfeBridge } from '@gears-frontx/react';
import {
  OrganizationProvider,
  STUDIO_SHARED_PROPERTY_CONTEXT_SECTION,
  useHostChrome,
} from '@constructor-studio/mfe-shared';
import { Skeleton } from '@gears-frontx/ui-kit';
import { useAdminTranslations } from './i18n';
import { AdminContext } from './screens/admin/common';
import { OrganizationsSection } from './screens/admin/OrganizationsSection';
import { PeopleSection } from './screens/admin/PeopleSection';
import { AccessSection } from './screens/admin/AccessSection';
import { IntegrationsSection } from './screens/admin/integrations/IntegrationsSection';
import { SecretsSection } from './screens/admin/SecretsSection';
import { DomainModelSection } from './screens/admin/domain-model/DomainModelSection';
import { ObjectsSection } from './screens/admin/ObjectsSection';
import { ViewsSection } from './screens/admin/views/ViewsSection';
import { IdentitiesSection } from './screens/admin/IdentitiesSection';
import { TenantsSection } from './screens/admin/TenantsSection';
import styles from './screens/admin/Admin.module.css';

export const ADMIN_SECTIONS = [
  'organizations',
  'people',
  'access',
  'integrations',
  'secrets',
  // The Studio domain model before Objects, where the prototype's Admin had it.
  'domain-model',
  'objects',
  // Saved views of the model's objects, after Objects, as the prototype's Admin had them.
  'views',
  'identities',
  'tenants',
] as const;

/**
 * What this entry answers on the organization level: Organization › Connections
 * is the same screen as Admin › Integrations, as the prototype rendered both
 * (`ConnectorsView` with the organization as its tenant).
 */
export const ORGANIZATION_SECTIONS = ['connections'] as const;

export type AdminSection = (typeof ADMIN_SECTIONS)[number] | (typeof ORGANIZATION_SECTIONS)[number];

const KNOWN_SECTIONS: readonly unknown[] = [...ADMIN_SECTIONS, ...ORGANIZATION_SECTIONS];

function sectionOf(value: unknown): AdminSection {
  return KNOWN_SECTIONS.includes(value) ? (value as AdminSection) : 'people';
}

export interface AdminRootProps {
  bridge: ChildMfeBridge;
}

export const AdminRoot: React.FC<AdminRootProps> = ({ bridge }) => {
  // People is where the prototype's Admin opened, and what an unknown section falls back to.
  const section = sectionOf(useSharedProperty(STUDIO_SHARED_PROPERTY_CONTEXT_SECTION));
  const { containerRef, dataTheme, language } = useHostChrome();
  const { t, loading } = useAdminTranslations();
  return (
    <div ref={containerRef} className={styles.screen} data-theme={dataTheme} data-admin-section={section}>
      {loading ? (
        <Skeleton className={styles.skeleton} />
      ) : (
        <AdminContext.Provider value={{ t, language, container: containerRef, bridge }}>
          <OrganizationProvider>
            <Section section={section} />
          </OrganizationProvider>
        </AdminContext.Provider>
      )}
    </div>
  );
};

AdminRoot.displayName = 'AdminRoot';

function Section({ section }: { section: AdminSection }) {
  switch (section) {
    case 'organizations':
      return <OrganizationsSection />;
    case 'access':
      return <AccessSection />;
    case 'integrations':
    case 'connections':
      return <IntegrationsSection />;
    case 'secrets':
      return <SecretsSection />;
    case 'domain-model':
      return <DomainModelSection />;
    case 'objects':
      return <ObjectsSection />;
    case 'views':
      return <ViewsSection />;
    case 'identities':
      return <IdentitiesSection />;
    case 'tenants':
      return <TenantsSection />;
    default:
      return <PeopleSection />;
  }
}
