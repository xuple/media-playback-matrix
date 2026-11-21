// Recovery is visible evidence; these budgets apply to the whole column.
export function recoveryCounts(result) {
    const rows = result.rows instanceof Map ? [...result.rows.values()] : (result.rows || []);
    return {
        retries: rows.filter(row => row.attempts?.length > 1).length,
        requiredRetries: rows.filter(row => row.required && row.attempts?.length > 1).length,
        restarts: result.session_restarts ?? (rows.some(row => row.session_restarted) ? 1 : 0),
    };
}
export function recoveryFailures(result) {
    const counts = recoveryCounts(result);
    const simulator = /\(sim\)/i.test(result.device || '') || /^(?:spike-)?ios-/.test(result.runner || '');
    const android = /android/i.test(result.os?.name || '') || /android-chrome/.test(result.runner || '');
    return [
        ...(simulator && counts.requiredRetries > 1 ? [`${result.runner}: ${counts.requiredRetries} required retries exceeds budget 1`] : []),
        ...(android && counts.restarts > 1 ? [`${result.runner}: ${counts.restarts} session restarts exceeds budget 1`] : []),
    ];
}
