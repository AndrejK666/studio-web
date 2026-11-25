import { describe, expect, it } from 'vitest';
import type { ProjectSource } from '@constructor-studio/mfe-shared';
import {
  repositoryKey,
  providerSiteUrl,
  repositoryWebUrl,
  sourceWebUrls,
  supportsPullRequests,
  branchNameProblem,
  withBranch,
  withShareMode,
  withSources,
  withoutSource,
  type SourceWebInput,
} from './projectSources';

const source = (connection: string, fullPath: string): ProjectSource => ({
  connection_id: connection,
  full_path: fullPath,
  clone_url: `https://github.com/${fullPath}.git`,
});

const API = source('c-1', 'acme/api');
const WEB = { ...source('c-1', 'acme/web'), branch: 'main', share_mode: 'pull_request' } as const;
const DOCS = source('c-2', 'acme/docs');

describe('repositoryKey', () => {
  it('names a repository however its URL is spelled', () => {
    expect(repositoryKey(' https://user:token@GitHub.com/Acme/API.git/ ')).toBe('github.com/acme/api');
    expect(repositoryKey('https://github.com/acme/api')).toBe('github.com/acme/api');
    expect(repositoryKey('https://github.com/acme/api/.git')).toBe('github.com/acme/api');
  });

  it('names nothing without a scheme, a host or a path', () => {
    expect(repositoryKey('git@github.com:acme/api.git')).toBeNull();
    expect(repositoryKey('https://github.com/')).toBeNull();
  });
});

describe('repositoryWebUrl', () => {
  it.each([
    ['https://github.com/acme/api.git', 'https://github.com/acme/api'],
    ['https://jdoe@bitbucket.org/acme/api.git', 'https://bitbucket.org/acme/api'],
    ['https://x-access-token:secret@github.com/acme/api.git', 'https://github.com/acme/api'],
    ['http://git.internal:8443/acme/api.git', 'http://git.internal:8443/acme/api'],
    ['https://gitlab.com/group/sub/api/', 'https://gitlab.com/group/sub/api'],
    ['https://github.com/acme/api.github.io.git', 'https://github.com/acme/api.github.io'],
  ])('%s opens %s', (cloneUrl, page) => {
    expect(repositoryWebUrl(cloneUrl)).toBe(page);
  });

  it.each([
    'git@github.com:acme/api.git',
    'ssh://git@github.com/acme/api.git',
    'git://github.com/acme/api.git',
    'https://github.com/',
    '',
  ])('%s gives none', (cloneUrl) => {
    expect(repositoryWebUrl(cloneUrl)).toBeNull();
  });
});

describe('providerSiteUrl', () => {
  it.each([
    ['https://api.github.com', 'https://github.com'],
    ['https://api.github.com/', 'https://github.com'],
    ['https://ghe.example.com/api/v3', 'https://ghe.example.com'],
    ['https://gitlab.constr.dev/api/v4/', 'https://gitlab.constr.dev'],
    ['https://gitlab.constr.dev', 'https://gitlab.constr.dev'],
    ['https://example.com/gitlab/api/v4', 'https://example.com/gitlab'],
    ['https://api.bitbucket.org/2.0', 'https://bitbucket.org'],
  ])('%s is the site %s', (base, site) => {
    expect(providerSiteUrl(base)).toBe(site);
  });

  it.each([null, '', 'not a url', 'ssh://git.example.com'])('%s names no site', (base) => {
    expect(providerSiteUrl(base)).toBeNull();
  });
});

describe('sourceWebUrls', () => {
  const source = (overrides: Partial<SourceWebInput> = {}): SourceWebInput => ({
    provider: 'github',
    cloneUrl: 'https://github.com/acme/api.git',
    baseUrl: null,
    fullPath: 'acme/api',
    branch: 'main',
    ...overrides,
  });

  it('opens a GitHub repository and its branch', () => {
    expect(sourceWebUrls(source())).toEqual({
      repository: 'https://github.com/acme/api',
      branch: 'https://github.com/acme/api/tree/main',
    });
  });

  it('opens a GitLab repository and its branch under /-/tree', () => {
    expect(
      sourceWebUrls(
        source({
          provider: 'gitlab',
          cloneUrl: 'https://gitlab.constr.dev/platform/aps/platform-api.git',
          fullPath: 'platform/aps/platform-api',
        })
      )
    ).toEqual({
      repository: 'https://gitlab.constr.dev/platform/aps/platform-api',
      branch: 'https://gitlab.constr.dev/platform/aps/platform-api/-/tree/main',
    });
  });

  it('builds a self-hosted repository from the connection base when the clone URL is SSH', () => {
    expect(
      sourceWebUrls(
        source({
          provider: 'gitlab',
          cloneUrl: 'git@gitlab.constr.dev:platform/aps/platform-api.git',
          baseUrl: 'https://gitlab.constr.dev',
          fullPath: 'platform/aps/platform-api',
        })
      )?.repository
    ).toBe('https://gitlab.constr.dev/platform/aps/platform-api');
  });

  it('strips an API path from the connection base', () => {
    expect(
      sourceWebUrls(
        source({ cloneUrl: 'git@ghe.example.com:acme/api.git', baseUrl: 'https://ghe.example.com/api/v3' })
      )
    ).toEqual({
      repository: 'https://ghe.example.com/acme/api',
      branch: 'https://ghe.example.com/acme/api/tree/main',
    });
    expect(
      sourceWebUrls(
        source({ provider: 'gitlab', cloneUrl: 'ssh://git@gl/acme/api.git', baseUrl: 'https://gl.example/api/v4' })
      )?.branch
    ).toBe('https://gl.example/acme/api/-/tree/main');
  });

  it('keeps the slashes of a branch and escapes the rest', () => {
    expect(sourceWebUrls(source({ branch: 'feature/a#b' }))?.branch).toBe(
      'https://github.com/acme/api/tree/feature/a%23b'
    );
  });

  it('has no branch page without a branch or for an unknown provider', () => {
    expect(sourceWebUrls(source({ branch: null }))?.branch).toBeNull();
    expect(sourceWebUrls(source({ provider: 'azure' }))).toEqual({
      repository: 'https://github.com/acme/api',
      branch: null,
    });
  });

  it('is none when neither the clone URL nor a base says where', () => {
    expect(sourceWebUrls(source({ cloneUrl: 'git@github.com:acme/api.git' }))).toBeNull();
  });
});

describe('withSources', () => {
  it('appends after the sources there are, and says what it appended', () => {
    const { sources, added } = withSources([API, WEB], [DOCS]);
    expect(sources).toEqual([API, WEB, DOCS]);
    expect(added).toEqual([DOCS]);
  });

  it('skips a repository already attached, through any connection', () => {
    const again = { ...source('c-2', 'Acme/API'), clone_url: 'https://github.com/Acme/API' };
    const { sources, added } = withSources([API], [again, DOCS, DOCS]);
    expect(sources).toEqual([API, DOCS]);
    expect(added).toEqual([DOCS]);
  });
});

describe('withoutSource', () => {
  it('removes the one entry and keeps the others as they were', () => {
    expect(withoutSource([API, WEB, DOCS], { connection_id: 'c-1', full_path: 'acme/web' })).toEqual([
      API,
      DOCS,
    ]);
  });

  it('matches the connection as well as the path', () => {
    expect(withoutSource([API], { connection_id: 'c-2', full_path: 'acme/api' })).toEqual([API]);
  });
});

describe('withShareMode', () => {
  it('changes the one entry and nothing else of it', () => {
    expect(
      withShareMode([API, WEB, DOCS], { connection_id: 'c-1', full_path: 'acme/api' }, 'pull_request')
    ).toEqual([{ ...API, share_mode: 'pull_request' }, WEB, DOCS]);
    expect(withShareMode([WEB], { connection_id: 'c-1', full_path: 'acme/web' }, 'branch')).toEqual([
      { ...WEB, share_mode: 'branch' },
    ]);
  });

  it('leaves the sources as they were when the entry is gone', () => {
    expect(
      withShareMode([API], { connection_id: 'c-2', full_path: 'acme/api' }, 'pull_request')
    ).toEqual([API]);
  });
});

describe('supportsPullRequests', () => {
  it('is GitHub only', () => {
    expect(supportsPullRequests('github')).toBe(true);
    expect(supportsPullRequests('gitlab')).toBe(false);
    expect(supportsPullRequests(null)).toBe(false);
  });
});

describe('withBranch', () => {
  it("changes the one entry's branch, trimmed, and nothing else", () => {
    expect(withBranch([API, WEB], { connection_id: 'c-1', full_path: 'acme/api' }, ' main ')).toEqual([
      { ...API, branch: 'main' },
      WEB,
    ]);
    expect(withBranch([API], { connection_id: 'c-2', full_path: 'acme/api' }, 'main')).toEqual([API]);
  });
});

describe('branchNameProblem', () => {
  it('takes what git takes as a branch name', () => {
    for (const ok of ['main', 'AndrejK666/studioweb-research-build', 'release/2026.11', 'v1']) {
      expect(branchNameProblem(ok)).toBeNull();
    }
    expect(branchNameProblem('  ')).toBe('empty');
    const bad = ['a b', 'a..b', '-x', '/x', 'x/', 'x.', 'x.lock', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[b'];
    for (const name of [...bad, 'a\\b', 'a@{1}', 'a//b', '@']) {
      expect(branchNameProblem(name)).toBe('invalid');
    }
  });
});
