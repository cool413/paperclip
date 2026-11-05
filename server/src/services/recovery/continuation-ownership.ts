type RecoveryRun = {
  id: string;
  agentId: string;
  status: string;
  errorCode: string | null;
  createdAt: Date;
};

export function isReassignmentCancellation(run: RecoveryRun | null | undefined) {
  return run?.status === "cancelled" && run.errorCode === "issue_reassigned";
}

export function isRecoveryFailure(run: RecoveryRun | null | undefined) {
  return Boolean(run && !isReassignmentCancellation(run) &&
    ["failed", "timed_out", "interrupted", "cancelled"].includes(run.status));
}

export function selectAssignedRecoverySource<T extends RecoveryRun>(
  run: T | null,
  agentId: string,
  assignedAt: Date | null,
  held = false,
): { kind: "held" } | { kind: "assignment"; sourceRunId: string | null } | { kind: "current"; run: T | null } {
  if (held) return { kind: "held" };
  if ((!run && assignedAt) || (run && (
    run.agentId !== agentId || isReassignmentCancellation(run) ||
    (assignedAt && run.createdAt < assignedAt)
  ))) {
    return { kind: "assignment", sourceRunId: run?.id ?? null };
  }
  return { kind: "current", run };
}

export function summarizeOwnedContinuationFailures(
  rows: Array<RecoveryRun & { contextSnapshot: unknown; finishedAt: Date | null }>,
  agentId: string,
  errorCode: string | null,
  assignedAt: Date | null,
) {
  let consecutive = 0;
  let latestFinishedAt: Date | null = null;
  for (const row of rows) {
    const context = row.contextSnapshot && typeof row.contextSnapshot === "object"
      ? row.contextSnapshot as Record<string, unknown> : {};
    if (row.agentId !== agentId || (assignedAt && row.createdAt < assignedAt) ||
      context.retryReason !== "issue_continuation_needed" || !isRecoveryFailure(row) ||
      row.errorCode !== errorCode) break;
    consecutive += 1;
    if (latestFinishedAt === null) latestFinishedAt = row.finishedAt;
  }
  return { consecutive, latestFinishedAt };
}
