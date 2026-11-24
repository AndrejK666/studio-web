/**
 * A tenant's attributes as the Studio domain model defines them — the
 * prototype's `ObjectAttributes` (`object-attributes.tsx`), on every level.
 *
 * An organization, a workspace, a project is a tenant in account-management:
 * its id, name and place in the tree are the core and stay there. Everything
 * else an organization wants to say about one — a cost centre, a phase, a
 * customer — is a field of the level's model type, added in Admin › Studio
 * domain model. This card shows the fields the live model has for the type,
 * reads the one object that describes the tenant (keyed `self` in its scope,
 * carrying its id in `tenant_id`) and saves through `POST /mutate`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiRegistry, useQueryCache } from '@gears-frontx/react';
import { Badge, Button, Card, CardContent, Input, NativeSelect, NativeSelectOption } from '@gears-frontx/ui-kit';
import {
  AccountsApiService,
  attributesWrite,
  domainMutate,
  inputValue,
  invalidateDomainObjects,
  openScreen,
  orgPeople,
  readColleagues,
  readOrgMembers,
  readableFields,
  responseStatus,
  selfQuery,
  shownValue,
  useDomainQuery,
  type DomainModel,
  type ModelField,
  type TabLevel,
} from '@constructor-studio/mfe-shared';
import { AdminApiService } from '../../api/AdminApiService';
import { ErrorLine, Header, errText, useAdmin } from '../admin/common';
import styles from '../admin/Admin.module.css';
import own from './Model.module.css';

export function ObjectAttributes({
  orgId,
  model,
  level,
  tenant,
  onModelChanged,
}: {
  orgId: string;
  model: DomainModel;
  level: TabLevel;
  tenant: { id: string; name: string };
  /** Called after this card changed the model (made the level's type). */
  onModelChanged?: () => void;
}) {
  const { t, bridge } = useAdmin();
  const type = level;
  const known = model.byId.has(type);
  const fields = useMemo(() => readableFields(model, type), [model, type]);
  /** A write of this card that failed (the read's own failure comes from the read). */
  const [writeError, setWriteError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string | boolean>>({});
  const [busy, setBusy] = useState(false);
  const [showEmpty, setShowEmpty] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [name, setName] = useState(tenant.name);
  /** The organization's people by id: a field holding a person's id shows their name. */
  const [people, setPeople] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    let live = true;
    orgPeople(
      orgId,
      (id) => readOrgMembers(id),
      () => readColleagues()
    ).then(
      (members) => live && setPeople(new Map(members.map((m) => [m.id.toLowerCase(), m.name]))),
      () => undefined
    );
    return () => {
      live = false;
    };
  }, [orgId]);

  // A project's name is not in what the shell publishes: read the tenant.
  useEffect(() => {
    if (tenant.name) return undefined;
    let live = true;
    apiRegistry
      .getService(AccountsApiService)
      .getTenant({ tenantId: tenant.id })
      .fetch()
      .then(
        (found) => live && setName(found.name ?? ''),
        () => undefined
      );
    return () => {
      live = false;
    };
  }, [tenant.id, tenant.name]);

  // The object that describes the tenant, through the shared cache: read again
  // after a save here, or when someone else writes the type (the live channel).
  const cache = useQueryCache();
  const selfBody = useMemo(() => (known ? selfQuery(type, tenant.id) : null), [known, type, tenant.id]);
  const self = useDomainQuery(orgId, selfBody);
  const reload = useCallback(() => invalidateDomainObjects(cache, orgId, type), [cache, orgId, type]);
  const readError = self.isError ? self.error : null;
  const row = self.data?.items[0];
  const objectId = row?.id ?? null;
  const value: Record<string, unknown> | null = readError ? {} : self.data ? (row?.value ?? {}) : null;
  const forbidden = readError !== null && responseStatus(readError) === 403;
  const error = writeError ?? (readError !== null ? errText(readError) : null);
  const setError = setWriteError;

  /** What the tenant already says about itself: shown, and written with the first save. */
  const facts = useMemo<Record<string, unknown>>(() => (name ? { name, title: name } : {}), [name]);
  const factFields = fields.filter((f) => f.name in facts);
  const valueOf = (f: ModelField): unknown => value?.[f.name] ?? (f.name in facts ? facts[f.name] : undefined);
  const filledField = (f: ModelField) => {
    const v = valueOf(f);
    return v !== undefined && v !== null && v !== '';
  };
  // The type's own fields, and any field that holds something, come first;
  // what a base type declares for the model's machinery waits behind a toggle.
  const primary = fields.filter((f) => !['parent_tenant_id', 'hidden_tabs'].includes(f.name)
    && (f.declaredBy === type || filledField(f) || f.name in facts));
  const listed = showAll ? fields : primary;
  const filled = listed.filter(filledField);
  const empty = listed.filter((f) => !filled.includes(f));
  const behind = fields.length - primary.length;
  const scopeSettings = level === 'organization' ? '/organization/settings' : level === 'project' ? '/projects/settings' : null;
  const editable = (field: ModelField) => !field.heldBy
    && !['parent_tenant_id', 'hidden_tabs', 'name'].includes(field.name)
    && !(level === 'organization' && field.name === 'title');

  if (!known) {
    // Who may change the model can make the type here, as the prototype offered.
    const create = async () => {
      setBusy(true);
      setError(null);
      try {
        await apiRegistry
          .getService(AdminApiService)
          .createDomainType(orgId)
          .fetch({ id: type, name: type[0].toUpperCase() + type.slice(1), extends: 'managed-object' });
        onModelChanged?.();
      } catch (e) {
        setError(errText(e));
      } finally {
        setBusy(false);
      }
    };
    return (
      <>
        <Header
          title={t('model_attributes_title')}
          action={
            model.canEdit ? (
              <Button size="sm" disabled={busy} onClick={() => void create()} data-attributes-create-type>
                {t('model_create_type', { type })}
              </Button>
            ) : undefined
          }
        />
        <p className={styles.muted}>{t('model_attributes_no_type', { type })}</p>
        {error && <ErrorLine>{error}</ErrorLine>}
      </>
    );
  }

  const startEdit = () => {
    setDraft(
      Object.fromEntries(
        fields
          .filter((f) => editable(f) || (!f.heldBy && f.name in facts && value?.[f.name] === undefined))
          .map((f) => [f.name, f.kind.kind === 'boolean' ? valueOf(f) === true : inputValue(valueOf(f))])
      )
    );
    setEditing(true);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const op = attributesWrite({
        type,
        tenantId: tenant.id,
        objectId,
        fields,
        before: value ?? {},
        draft,
        facts: Object.fromEntries(factFields.map((f) => [f.name, facts[f.name]])),
      });
      if (op) await domainMutate(orgId).fetch({ operations: [op] });
      setEditing(false);
      reload();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Header
        title={t('model_attributes_title')}
        info={<>
          <p>{t('model_attributes_about', { level: t(`model_level_${level}`) })}</p>
          {(scopeSettings || model.canEdit) && (
            <div className={styles.inline}>
              {scopeSettings && (
                <Button size="sm" variant="outline" onClick={() => openScreen(bridge, scopeSettings)}>
                  {t('model_open_settings')}
                </Button>
              )}
              {model.canEdit && (
                <Button size="sm" variant="outline" onClick={() => openScreen(bridge, '/admin/domain-model', `${type}-fields`)}>
                  {t('model_manage_fields')}
                </Button>
              )}
            </div>
          )}
        </>}
        status={<Badge variant="outline">{t('model_attributes_fields', { count: String(fields.length), type })}</Badge>}
        action={
          !editing && !forbidden && fields.some(editable) ? (
            <Button size="sm" variant="outline" disabled={value === null} onClick={startEdit} data-attributes-edit>
              {t('model_edit')}
            </Button>
          ) : undefined
        }
      />
      {error && <ErrorLine>{forbidden ? t('model_forbidden') : error}</ErrorLine>}
      <Card>
        <CardContent className={own.card}>
          {value === null ? (
            <p className={styles.muted}>{t('reading')}</p>
          ) : editing ? (
            <form
              className={own.grid}
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              {listed
                .filter(editable)
                .map((f) => (
                  <FieldInput
                    key={f.name}
                    field={f}
                    value={draft[f.name] ?? ''}
                    onChange={(v) => setDraft((d) => ({ ...d, [f.name]: v }))}
                  />
                ))}
              <span />
              <div className={styles.inline}>
                {behind > 0 && (
                  <Button type="button" size="sm" variant="ghost" onClick={() => setShowAll((v) => !v)}>
                    {showAll ? t('model_only_own') : t('model_all_fields', { count: String(fields.length) })}
                  </Button>
                )}
                <Button type="submit" size="sm" disabled={busy} data-attributes-save>
                  {busy ? t('model_saving') : t('model_save')}
                </Button>
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
                  {t('cancel')}
                </Button>
              </div>
            </form>
          ) : (
            <>
              {filled.length === 0 ? (
                <p className={styles.muted} data-attributes-empty>
                  {t('model_nothing_recorded')}
                </p>
              ) : (
                <dl className={own.grid}>
                  {filled.map((f) => (
                    <FieldRow
                      key={f.name}
                      field={f}
                      value={valueOf(f)}
                      people={people}
                      from={value?.[f.name] === undefined && f.name in facts ? t('model_from_tenant') : undefined}
                    />
                  ))}
                </dl>
              )}
              {(empty.length > 0 || behind > 0) && (
                <div className={styles.inline}>
                  {empty.length > 0 && (
                    <Button size="sm" variant="ghost" onClick={() => setShowEmpty((v) => !v)}>
                      {showEmpty
                        ? t('model_hide_empty', { count: String(empty.length) })
                        : t('model_show_empty', { count: String(empty.length) })}
                    </Button>
                  )}
                  {behind > 0 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      title={t('model_base_fields_hint')}
                      onClick={() => {
                        setShowAll((v) => !v);
                        setShowEmpty(true);
                      }}
                    >
                      {showAll
                        ? t('model_hide_base_fields', { count: String(behind) })
                        : t('model_show_base_fields', { count: String(behind) })}
                    </Button>
                  )}
                </div>
              )}
              {showEmpty && empty.length > 0 && (
                <dl className={own.grid}>
                  {empty.map((f) => (
                    <FieldRow key={f.name} field={f} value={undefined} />
                  ))}
                </dl>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
}

export function FieldRow({
  field,
  value,
  from,
  people,
}: {
  field: ModelField;
  value: unknown;
  from?: string;
  /** People by lower-cased id: a value that is one of their ids shows as their name. */
  people?: ReadonlyMap<string, string>;
}) {
  const { t, language } = useAdmin();
  const person = typeof value === 'string' ? people?.get(value.toLowerCase()) : undefined;
  return (
    <>
      <dt className={styles.sub} title={field.description || field.type}>
        {field.name.replace(/_/g, ' ')}
        {field.required && ' *'}
      </dt>
      <dd className={own.value}>
        {person ? (
          <span title={String(value)}>{person}</span>
        ) : (
          shownValue(value, t('model_yes'), t('model_no'), language)
        )}
        {from && <span className={styles.sub}> · {from}</span>}
      </dd>
    </>
  );
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: ModelField;
  value: string | boolean;
  onChange: (v: string | boolean) => void;
}) {
  const id = `attr-${field.name}`;
  const k = field.kind;
  let input;
  if (k.kind === 'boolean') {
    input = <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
  } else if (k.kind === 'enum') {
    input = (
      <NativeSelect id={id} value={String(value)} onChange={(e) => onChange(e.target.value)}>
        <NativeSelectOption value="">—</NativeSelectOption>
        {k.values.map((v) => (
          <NativeSelectOption key={v} value={v}>
            {v}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    );
  } else {
    input = (
      <Input
        id={id}
        type={k.kind === 'number' ? 'number' : 'text'}
        value={String(value)}
        placeholder={k.kind === 'list' ? 'a, b, c' : field.type}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <>
      <label className={styles.sub} htmlFor={id} title={field.description || field.type}>
        {field.name.replace(/_/g, ' ')}
        {field.required && ' *'}
      </label>
      {input}
    </>
  );
}
