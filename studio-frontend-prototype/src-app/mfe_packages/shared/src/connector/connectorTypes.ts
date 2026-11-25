/**
 * Wire shapes of the studio-connector gear. Kept apart from any MFE's own
 * vocabulary: these are connections and repositories, not tenants.
 */

export interface ProviderDto {
  provider: string;
  display_name: string;
  default_base_url: string;
  instance_id: string;
  /** `source_code` | `ai` | `notification`. */
  category: string;
  credential_label: string;
  credential_hint: string;
  /**
   * `notification` providers only: the credential already fixes the channel
   * (an incoming webhook), so there is no channel to list and none to pick.
   */
  fixed_target: boolean;
  /** A connection may be stored without a credential: a public gear repository. */
  token_optional?: boolean;
  /** Made by signing in to the provider's identity provider (ADR-0049). */
  sign_in?: boolean;
  /** A connection may be made with a pasted credential. */
  pasted_key?: boolean;
  /**
   * The form a connection is made with, in the order it is drawn: the address,
   * the credential and the provider's options, as its driver describes them.
   * Absent from an older backend: the address and the credential.
   */
  fields?: ProviderFieldDto[];
  /** Who may hold a connection: anyone, only the organization, or a person first. */
  holder?: 'any' | 'organization' | 'personal';
  /** `holder` is the only one: a form offers no choice. */
  holder_fixed?: boolean;
}

/** One field of a provider's form. */
export interface ProviderFieldDto {
  /** `base_url`, `token`, or else the name of one of the connection's options. */
  name: string;
  label: string;
  kind: 'text' | 'secret' | 'url' | 'select';
  required: boolean;
  /** A sentence beside the field; empty when there is none. */
  hint: string;
  placeholder: string;
  /** A shape the value comes in that a form may help with: `kubeconfig`. */
  format?: string | null;
  /** A regular expression the whole value matches. */
  pattern?: string | null;
  max_length?: number | null;
  choices?: { value: string; label: string }[];
}

export interface ProviderListDto {
  items: ProviderDto[];
}

/** A configured source host. `GET /connections`. */
export interface ConnectionDto {
  id: string;
  owner_tenant_id: string;
  provider: string;
  label: string;
  account: string;
  base_url: string;
  scope: string;
  secret_ref: string;
  created_at_epoch_secs: number;
  /** Held above the tenant the list was asked for (`owner_tenant_id` says where). */
  inherited?: boolean;
}

export interface ConnectionListDto {
  items: ConnectionDto[];
}

/** The answer to both `POST /connections` and `POST /connections/{id}/test`. */
export interface ConnectionTestDto {
  connection: ConnectionDto;
  account: string;
  display_name?: string | null;
}

export interface CreateConnectionBody {
  provider: string;
  label: string;
  base_url?: string;
  token: string;
  /** The provider's options, as its form names them. */
  options?: Record<string, string>;
  scope: string;
  owner_tenant_id: string;
}

export interface RemoteRepoDto {
  id: string;
  name: string;
  full_path: string;
  clone_url: string;
  default_branch?: string | null;
  description?: string | null;
  visibility?: string | null;
}

export interface RemoteRepoListDto {
  items: RemoteRepoDto[];
}

/** A channel a notification connection can post to. `GET …/targets`. */
export interface NotifyTargetDto {
  /** Send this back as `target`; its shape differs per platform. */
  id: string;
  name: string;
  /** The server the channel belongs to, where the platform nests them. */
  container?: string | null;
  private: boolean;
  /** True for Zulip: a message to this target must carry a `topic`. */
  topic_required: boolean;
}

export interface NotifyTargetListDto {
  items: NotifyTargetDto[];
}

/** `POST …/messages`. Omit `target` for a `fixed_target` provider. */
export interface SendMessageBody {
  target?: string;
  text: string;
  title?: string;
  link?: string;
  topic?: string;
}

export interface SentMessageDto {
  connection_id: string;
  provider: string;
  /** Where it landed — not necessarily what was asked for. */
  target: string;
  message_id?: string | null;
}
