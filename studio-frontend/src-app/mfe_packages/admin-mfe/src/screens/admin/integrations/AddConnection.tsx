/**
 * Add a connection — the prototype's `AddConnector` (`App.tsx` at 00828880):
 * the provider picker by kind, then the credential form ("Test connection"
 * probes without saving, "Test & save" does both in one server-side step), or,
 * for a provider made by signing in (Constructor Research, ADR-0049), the
 * sign-in. Research also takes a pasted `rk-` access key, and offers only that
 * on a Studio with no sign-in client. On the organization's page the choice is the organization (the
 * default) or yourself; a cluster or a registry starts organization-wide, a
 * signed-in account is the person's own.
 *
 * The credential form is the driver's (`GET /providers`: `fields`, `holder`, `holder_fixed`): which fields, in which
 * order, required or not, and who may hold the connection. Nothing here is per provider but Research's tile while
 * this Studio cannot offer it, which no driver is there to describe.
 */

import React, { useState } from 'react';
import { apiRegistry } from '@gears-frontx/react';
import {
  Button,
  Card,
  CardContent,
  Input,
  NativeSelect,
  NativeSelectOption,
} from '@gears-frontx/ui-kit';
import { rememberSignInReturn, SIGN_IN_CALLBACK_PATH, type OrganizationRef } from '@constructor-studio/mfe-shared';
import { AdminApiService } from '../../../api/AdminApiService';
import type { ConnectorIdentity, ConnectorProvider, ProviderField } from '../../../api/types';
import {
  BASE_URL_FIELD,
  CATEGORY_KEYS,
  TOKEN_FIELD,
  connectWays,
  fieldText,
  fieldValid,
  formFields,
  optionFields,
  personalProviders,
  reachFor,
  type ConnectWay,
  type Reach,
} from '../../../model/connections';
import { kubeconfigServer } from '../../../model/kubeconfig';
import { ErrorLine, errText, useAdmin } from '../common';
import { ConnectorLogo, LogoSlot } from './ConnectorLogo';
import { KubeconfigField } from './KubeconfigField';
import styles from '../Admin.module.css';
import own from './Integrations.module.css';

export function AddConnection({
  org,
  providers,
  category,
  initialProvider,
  personal = false,
  onClose,
  onAdded,
}: {
  org: OrganizationRef;
  providers: ConnectorProvider[];
  /** Open on one kind, from the "Not connected yet" line. */
  category?: string;
  initialProvider?: ConnectorProvider;
  /** From the profile: the connection is the caller's own, never the organization's. */
  personal?: boolean;
  onClose: () => void;
  onAdded: (r: ConnectorIdentity) => void;
}) {
  const { t } = useAdmin();
  const [picked, setPicked] = useState<ConnectorProvider | null>(initialProvider ?? null);
  const [find, setFind] = useState('');
  const startReach: Reach = personal ? 'personal' : 'organization';
  const [reach, setReach] = useState<Reach>(startReach);
  // Which way a provider that offers both is being connected; the first it offers until picked.
  const [way, setWay] = useState<ConnectWay | null>(null);
  // A profile never offers what only the organization may hold (a cluster, a registry).
  const offered = personal ? personalProviders(providers) : providers;

  if (offered.length === 0) {
    return (
      <Card data-connection-picker>
        <CardContent className={styles.cardBody}>
          <h3 className={styles.subtitle}>{t('int_add_title')}</h3>
          <p className={styles.muted}>{t('int_no_drivers')}</p>
        </CardContent>
      </Card>
    );
  }

  if (picked) {
    const ways = connectWays(picked);
    const current = way && ways.includes(way) ? way : ways[0];
    const back = () => {
      setPicked(null);
      setWay(null);
      setReach(startReach);
    };
    return (
      <Card data-connection-form={picked.provider}>
        <CardContent className={styles.cardBody}>
          {ways.length > 1 && (
            <div className={own.actions} role="group" aria-label={t('int_way_label')} data-connection-ways>
              {ways.map((w) => (
                <Button
                  key={w}
                  type="button"
                  size="sm"
                  variant={w === current ? 'secondary' : 'ghost'}
                  aria-pressed={w === current}
                  onClick={() => setWay(w)}
                  data-connection-way={w}
                >
                  {w === 'sign_in' ? t('int_way_sign_in') : t('int_way_paste_key')}
                </Button>
              ))}
            </div>
          )}
          {current === 'sign_in' ? (
            <SignInForm org={org} provider={picked} onBack={back} onClose={onClose} />
          ) : (
            <CredentialForm
              org={org}
              provider={picked}
              reach={reach}
              onReach={setReach}
              fixedReach={personal}
              onBack={back}
              onClose={onClose}
              onAdded={onAdded}
            />
          )}
        </CardContent>
      </Card>
    );
  }

  const q = find.trim().toLowerCase();
  return (
    <Card data-connection-picker>
      <CardContent className={`${styles.cardBody} ${own.picker}`}>
        <div className={own.pickerHead}>
          <h3 className={styles.subtitle}>{t('int_add_to', { name: org.name })}</h3>
          <span className={own.spacer} />
          <Input
            className={styles.search}
            type="search"
            value={find}
            placeholder={t('int_find_provider')}
            aria-label={t('int_find_provider')}
            onChange={(e) => setFind(e.target.value)}
          />
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('close')}
          </Button>
        </div>
        {CATEGORY_KEYS.filter((key) => !category || key === category).map((key) => {
          const title = t(`int_cat_${key}`);
          const group = offered.filter(
            (p) => p.category === key && (!q || `${p.display_name} ${p.provider} ${title}`.toLowerCase().includes(q))
          );
          // Research's tile stays in sight while this Studio cannot offer it yet (ADR-0049 §1).
          const researchPending = key === 'compute' && !providers.some((p) => p.provider === 'research') && !q;
          if (group.length === 0 && !researchPending) return null;
          return (
            <section key={key} className={own.group} data-provider-group={key}>
              <h4>{title}</h4>
              <p className={own.hint}>{t(`int_blurb_${key}`)}</p>
              <div className={own.tiles}>
                {group.map((p) => (
                  <button
                    key={p.provider}
                    type="button"
                    className={own.tile}
                    title={p.default_base_url}
                    onClick={() => {
                      setPicked(p);
                      setReach((r) => (personal ? 'personal' : reachFor(p, r)));
                    }}
                    data-provider={p.provider}
                  >
                    <LogoSlot>
                      <ConnectorLogo provider={p.provider} label={p.display_name} />
                    </LogoSlot>
                    <span>{p.display_name}</span>
                  </button>
                ))}
                {researchPending && (
                  <button type="button" className={own.tile} disabled title={t('int_research_pending_title')} data-research-pending>
                    <LogoSlot>
                      <ConnectorLogo provider="research" label="Constructor Research" />
                    </LogoSlot>
                    <span className={own.stack}>
                      <span>Constructor Research</span>
                      <span className={styles.sub}>{t('int_research_pending')}</span>
                    </span>
                  </button>
                )}
              </div>
              {researchPending && <p className={own.hint}>{t('int_research_pending_why')}</p>}
            </section>
          );
        })}
      </CardContent>
    </Card>
  );
}

function CredentialForm({
  org,
  provider,
  reach,
  onReach,
  fixedReach = false,
  onBack,
  onClose,
  onAdded,
}: {
  org: OrganizationRef;
  provider: ConnectorProvider;
  reach: Reach;
  onReach: (reach: Reach) => void;
  /** The profile's form: the reach is the caller's alone and not offered. */
  fixedReach?: boolean;
  onBack: () => void;
  onClose: () => void;
  onAdded: (r: ConnectorIdentity) => void;
}) {
  const { t } = useAdmin();
  const api = apiRegistry.getService(AdminApiService);
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [pat, setPat] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState<'probe' | 'save' | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The form is the driver's: the address, the credential and the options, in its order.
  const fields = formFields(provider);
  const address = fields.find((f) => f.name === BASE_URL_FIELD);
  const token = fields.find((f) => f.name === TOKEN_FIELD);
  const options = optionFields(fields);
  // A holder that is the only one is not offered: it is the scope.
  const holderFixed = !!provider.holder_fixed;
  const scope: Reach = holderFixed ? (provider.holder === 'personal' ? 'personal' : 'organization') : reach;
  const keyLabel = token ? fieldText(t, provider.provider, token, 'label') : '';
  const keyHint = token ? fieldText(t, provider.provider, token, 'hint') : '';
  const tokenOk = !token?.required || !!pat.trim();
  const addressOk = !address || fieldValid(address, baseUrl);
  const optionsOk = options.every((f) => fieldValid(f, values[f.name] ?? ''));

  const submit = async (mode: 'probe' | 'save') => {
    setBusy(mode);
    setError(null);
    setResult(null);
    const body = { provider: provider.provider, base_url: baseUrl.trim() || undefined, token: pat };
    const given = Object.fromEntries(
      options.map((f) => [f.name, (values[f.name] ?? '').trim()] as const).filter(([, v]) => v)
    );
    try {
      if (mode === 'probe') {
        const id = await api.probeConnection.fetch(body);
        setResult(
          id.display_name
            ? t('int_valid_named', { account: id.account, name: id.display_name })
            : t('int_valid', { account: id.account })
        );
      } else {
        // The organization row is inherited by every workspace under it; "personal"
        // also keeps the token to its owner. Both are stored on the organization here.
        const r = await api.createConnection.fetch({
          ...body,
          label,
          scope,
          owner_tenant_id: org.id,
          ...(Object.keys(given).length ? { options: given } : {}),
        });
        onAdded(r);
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const kind = (CATEGORY_KEYS as readonly string[]).includes(provider.category)
    ? t(`int_cat_${provider.category}`).toLowerCase()
    : provider.category;
  const defaultUrl = address?.placeholder || provider.default_base_url;
  const urlPlaceholder =
    address?.required || !defaultUrl
      ? t('int_url_required')
      : provider.category === 'ai'
        ? t('int_url_ai', { url: defaultUrl })
        : provider.category === 'notification'
          ? t('int_url_notification', { url: defaultUrl })
          : t('int_url_self_hosted', { url: defaultUrl });

  const field = (f: ProviderField) => {
    if (f.name === BASE_URL_FIELD) {
      return (
        <label key={f.name} className={styles.field}>
          {t('int_instance_url')}
          <Input placeholder={urlPlaceholder} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
      );
    }
    if (f.name === TOKEN_FIELD) {
      return (
        <React.Fragment key={f.name}>
          <span className={styles.field}>{keyLabel}</span>
          {keyHint && (
            <p className={own.hint} data-field-hint={f.name}>
              {keyHint}
            </p>
          )}
          {f.format === 'kubeconfig' ? (
            <KubeconfigField
              value={pat}
              reveal={reveal}
              onReveal={() => setReveal((v) => !v)}
              placeholder={f.placeholder}
              label={keyLabel}
              onChange={(text) => {
                setPat(text);
                // The connection's address is the API server the kubeconfig names, unless one is typed.
                const server = kubeconfigServer(text);
                if (address && server && !baseUrl.trim()) setBaseUrl(server);
              }}
            />
          ) : (
            <div className={own.actions}>
              <Input
                className={styles.grow}
                type={reveal ? 'text' : 'password'}
                aria-label={keyLabel}
                placeholder={f.placeholder}
                value={pat}
                onChange={(e) => setPat(e.target.value)}
              />
              <Button type="button" size="sm" variant="ghost" onClick={() => setReveal((v) => !v)}>
                {reveal ? t('int_hide') : t('int_show')}
              </Button>
            </div>
          )}
          <p className={own.hint}>{t('int_credstore_hint')}</p>
        </React.Fragment>
      );
    }
    const value = values[f.name] ?? '';
    const set = (v: string) => setValues((all) => ({ ...all, [f.name]: v }));
    const hint = fieldText(t, provider.provider, f, 'hint');
    return (
      <label key={f.name} className={styles.field} data-connection-option={f.name}>
        {fieldText(t, provider.provider, f, 'label')}
        {f.kind === 'select' ? (
          <NativeSelect value={value} onChange={(e) => set(e.target.value)}>
            <NativeSelectOption value="">—</NativeSelectOption>
            {(f.choices ?? []).map((c) => (
              <NativeSelectOption key={c.value} value={c.value}>
                {c.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        ) : (
          <Input
            type={f.kind === 'secret' ? 'password' : 'text'}
            placeholder={f.placeholder || undefined}
            value={value}
            onChange={(e) => set(e.target.value)}
            maxLength={f.max_length ?? undefined}
          />
        )}
        {hint && <span className={own.hint}>{hint}</span>}
      </label>
    );
  };

  return (
    <div className={own.form}>
      <h3 className={styles.subtitle}>{t('int_connect', { name: provider.display_name })}</h3>
      <div className={own.lead}>
        <LogoSlot>
          <ConnectorLogo provider={provider.provider} label={provider.display_name} />
        </LogoSlot>
        <span className={own.stack}>
          <span>{provider.display_name}</span>
          <span className={styles.sub}>{kind}</span>
        </span>
      </div>

      {!fixedReach && !holderFixed && (
        <label className={styles.field}>
          {t('int_available_to')}
          <NativeSelect value={reach} onChange={(e) => onReach(e.target.value as Reach)} data-connection-reach>
            <NativeSelectOption value="organization">{t('int_reach_org', { name: org.name })}</NativeSelectOption>
            <NativeSelectOption value="personal">{t('int_reach_personal')}</NativeSelectOption>
          </NativeSelect>
        </label>
      )}
      <p className={own.hint}>{scope === 'organization' ? t('int_reach_org_hint') : t('int_reach_personal_hint')}</p>

      <label className={styles.field}>
        {t('int_label')}
        <Input
          placeholder={t('int_label_placeholder', { name: provider.display_name })}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </label>

      {/* A webhook's URL is its whole address; asking for an instance URL too invites a contradiction. */}
      {!address && provider.fixed_target && <p className={own.hint}>{t('int_webhook_hint')}</p>}
      {fields.map(field)}

      {result && (
        <p className={own.hint} role="status" data-connection-probe>
          {result}
        </p>
      )}
      {error && <ErrorLine>{error}</ErrorLine>}

      <div className={own.actions}>
        <Button type="button" size="sm" variant="outline" onClick={onBack}>
          {t('int_back')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          {t('close')}
        </Button>
        <span className={own.spacer} />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!tokenOk || !addressOk || busy !== null}
          onClick={() => void submit('probe')}
          data-connection-probe-go
        >
          {busy === 'probe' ? t('int_testing') : t('int_test')}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!tokenOk || !label.trim() || !addressOk || !optionsOk || busy !== null}
          onClick={() => void submit('save')}
          data-connection-create
        >
          {busy === 'save' ? t('saving') : t('int_test_save')}
        </Button>
      </div>
    </div>
  );
}

/** Signed in to, not pasted: no address and no credential; the account is the person's own. */
function SignInForm({
  org,
  provider,
  onBack,
  onClose,
}: {
  org: OrganizationRef;
  provider: ConnectorProvider;
  onBack: () => void;
  onClose: () => void;
}) {
  const { t } = useAdmin();
  const api = apiRegistry.getService(AdminApiService);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      // Back to this portal's own callback page, which the shell answers; it
      // returns the person here once the backend has the connection.
      const { authorize_url } = await api.startSignIn.fetch({
        provider: provider.provider,
        label: label.trim(),
        scope: 'personal',
        owner_tenant_id: org.id,
        redirect_uri: window.location.origin + SIGN_IN_CALLBACK_PATH,
      });
      rememberSignInReturn();
      window.location.assign(authorize_url);
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };

  return (
    <div className={own.form}>
      <h3 className={styles.subtitle}>{t('int_connect', { name: provider.display_name })}</h3>
      <p className={own.hint}>{t('int_signin_hint')}</p>
      <label className={styles.field}>
        {t('int_label')}
        <Input
          placeholder={t('int_signin_label_placeholder', { name: provider.display_name })}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </label>
      <p className={own.hint}>{t('int_signin_only_you')}</p>
      {error && <ErrorLine>{error}</ErrorLine>}
      <div className={own.actions}>
        <Button type="button" size="sm" variant="outline" onClick={onBack}>
          {t('int_back')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          {t('close')}
        </Button>
        <span className={own.spacer} />
        <Button type="button" size="sm" disabled={!label.trim() || busy} onClick={() => void signIn()} data-connection-signin>
          {busy ? t('int_signin_opening') : t('int_signin_go')}
        </Button>
      </div>
    </div>
  );
}
