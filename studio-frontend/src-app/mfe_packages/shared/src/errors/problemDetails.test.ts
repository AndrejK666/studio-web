import { describe, expect, it } from 'vitest';
import { refusalReason, refusalText } from './problemDetails';

describe('refusalReason', () => {
  it('reads the reason a permission_denied carries', () => {
    const error = { response: { data: { detail: 'denied', context: { reason: 'PLATFORM_ADMIN_REQUIRED' } } } };
    expect(refusalReason(error)).toBe('PLATFORM_ADMIN_REQUIRED');
  });

  it('is null when the gear gave none', () => {
    expect(refusalReason({ response: { data: { detail: 'x' } } })).toBeNull();
    expect(refusalReason({ response: { data: 'text' } })).toBeNull();
    expect(refusalReason(new Error('offline'))).toBeNull();
  });
});

describe('refusalText', () => {
  it("says a failed precondition's violation, not the category's generic detail", () => {
    const error = {
      response: {
        data: {
          detail: 'Operation precondition not met',
          context: {
            violations: [
              { type: 'ENVIRONMENT_RESEARCH_UNREACHABLE', subject: 'environment', description: 'Research cannot be reached.' },
            ],
          },
        },
      },
    };
    expect(refusalText(error)).toBe('Research cannot be reached.');
  });

  it('keeps the detail when no violation says more', () => {
    const error = { response: { data: { detail: 'you are its only owner', context: { violations: [{}] } } } };
    expect(refusalText(error)).toBe('you are its only owner');
    expect(refusalText({ response: { data: 'plain text' } })).toBe('plain text');
    expect(refusalText(new Error('offline'))).toBe('offline');
  });
});
