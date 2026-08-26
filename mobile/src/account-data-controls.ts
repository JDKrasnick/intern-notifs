export function accountDataActionState(exportingData: boolean, deletingAccount: boolean) {
  return {
    exportDisabled: exportingData || deletingAccount,
    exportRetryEnabled: !exportingData && !deletingAccount,
    signOutDisabled: deletingAccount,
    deleteDisabled: deletingAccount || exportingData,
  };
}
