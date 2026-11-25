import { describe, expect, it } from 'vitest';
import { kitAbsent } from './kitAbsent';

/** A transport error the way the API client throws one, with the gear's problem document. */
const refused = (status: number, data: unknown) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });

describe('kitAbsent', () => {
  it('reads KIT_NOT_INSTALLED from the precondition violation, with its kit and sentence', () => {
    const error = refused(400, {
      title: 'Failed precondition',
      detail: 'Operation precondition not met',
      context: {
        violations: [{ type: 'KIT_NOT_INSTALLED', subject: 'delivery', description: 'this comes with the Delivery kit' }],
      },
    });
    expect(kitAbsent(error)).toEqual({ kit: 'delivery', reason: 'not_installed', detail: 'this comes with the Delivery kit' });
  });

  it('reads the MCP text form', () => {
    expect(kitAbsent(new Error('KIT_NOT_INSTALLED (kit project-git): this comes with…'))).toEqual({
      kit: 'project-git',
      reason: 'not_installed',
      detail: null,
    });
  });

  it('counts a 404 or a 503 only for a call the caller names a kit for', () => {
    expect(kitAbsent(refused(404, ''))).toBeNull();
    expect(kitAbsent(refused(503, ''))).toBeNull();
    expect(kitAbsent(refused(404, ''), { kit: 'components' })).toEqual({ kit: 'components', reason: 'gear_absent', detail: null });
    expect(kitAbsent(refused(503, { detail: 'down' }), { kit: 'insight' })).toEqual({
      kit: 'insight',
      reason: 'gear_absent',
      detail: null,
    });
  });

  it('leaves every other failure an error', () => {
    expect(kitAbsent(refused(500, { detail: 'boom' }), { kit: 'components' })).toBeNull();
    expect(kitAbsent(refused(403, {}), { kit: 'components' })).toBeNull();
    expect(kitAbsent(new Error('Network Error'), { kit: 'components' })).toBeNull();
    expect(kitAbsent(null)).toBeNull();
  });
});
