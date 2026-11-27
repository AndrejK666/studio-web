/** One ingested artifact node from `GET /studio-artifact-ingest/v1/nodes`.
 * `value` is the free-form GTS payload (issue/PR/repo fields). */
export interface ArtifactNode {
  type_id: string;
  instance_id: string;
  value: {
    repo?: string;
    external_id?: string;
    number?: number;
    title?: string;
    state?: string;
    author?: string | null;
    body?: string | null;
    url?: string | null;
    labels?: string[];
    source_branch?: string | null;
    target_branch?: string | null;
    merged?: boolean;
    provider?: string;
    full_path?: string;
    // File nodes:
    path?: string;
    sha?: string;
    is_dir?: boolean;
    size?: number | null;
    created_at?: string | null;
    updated_at?: string | null;
    // User nodes:
    login?: string;
    [key: string]: unknown;
  };
}
