import { describe, expect, it } from 'vitest';
import { accountDataActionState } from '../src/account-data-controls';

describe('account data action state', () => {
  it('keeps all competing account actions unavailable throughout deletion', () => {
    expect(accountDataActionState(false, true)).toEqual({
      exportDisabled: true,
      exportRetryEnabled: false,
      signOutDisabled: true,
      deleteDisabled: true,
    });
  });

  it('prevents deletion and export retry while an export is active', () => {
    expect(accountDataActionState(true, false)).toEqual({
      exportDisabled: true,
      exportRetryEnabled: false,
      signOutDisabled: false,
      deleteDisabled: true,
    });
  });
});
