/** Every Studio document a project lists, its own and its workspace's, newest first. */

import { useMemo } from 'react';
import { apiRegistry, useApiQuery, type EndpointDescriptor } from '@gears-frontx/react';
import { fetchAllPages } from '@constructor-studio/mfe-shared';
import { DocumentsApiService } from '../api/DocumentsApiService';
import type { DocumentDto } from '../api/documentTypes';

/** The backend's clamp on `limit`. */
const PAGE = 200;

export interface ProjectDocuments {
  documents: DocumentDto[];
  own: DocumentDto[];
  loading: boolean;
  failed: boolean;
}

export function projectDocumentsQuery(
  workspaceId: string,
  projectId: string
): EndpointDescriptor<DocumentDto[]> {
  return {
    key: ['projects-mfe', 'project-documents', workspaceId, projectId],
    fetch: async ({ signal } = {}) => {
      const documents = apiRegistry.getService(DocumentsApiService);
      // The query cache keeps the whole list (this descriptor's key); each page is read fresh.
      const read = await fetchAllPages<DocumentDto>(
        (offset, limit) => documents.projectDocuments({ workspaceId, projectId, limit, offset }).fetch({ signal, staleTime: 0 }),
        { pageSize: PAGE, advance: 'rows', signal }
      );
      return read.items;
    },
  };
}

const UNASKED: EndpointDescriptor<DocumentDto[]> = {
  key: ['projects-mfe', 'unasked', 'project-documents'],
  fetch: () => Promise.resolve([]),
};

export function useProjectDocuments(
  workspaceId: string | null,
  projectId: string
): ProjectDocuments {
  const { data, isLoading, isError } = useApiQuery(
    workspaceId ? projectDocumentsQuery(workspaceId, projectId) : UNASKED
  );
  return useMemo(() => {
    const documents = data ?? [];
    return {
      documents,
      own: documents.filter((document) => !document.inherited),
      loading: isLoading,
      failed: isError,
    };
  }, [data, isLoading, isError]);
}
