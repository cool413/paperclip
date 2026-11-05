import { describe, expect, it } from "vitest";
import { isReassignmentCancellation, isRecoveryFailure, selectAssignedRecoverySource, summarizeOwnedContinuationFailures } from "./continuation-ownership.js";

const assignment = new Date("2026-11-04T19:52:10Z");
function run(overrides: Partial<ReturnType<typeof fixture>> = {}) {
  return { ...fixture(), ...overrides };
}
function fixture() {
  return {
    id: "current-run", agentId: "engineer", status: "failed", errorCode: "adapter_failed",
    createdAt: new Date("2026-11-04T19:53:00Z"), finishedAt: new Date("2026-11-04T19:54:00Z"),
    contextSnapshot: { retryReason: "issue_continuation_needed" },
  };
}

describe("continuation ownership and failure accounting", () => {
  it("treats the recorded PM handoff cancellation as assignment work without inheriting its failed continuation", () => {
    const source = run({ id: "eb93a569-6dda-421f-9fa4-ca7232c0fb8f", agentId: "PM01", status: "cancelled", errorCode: "issue_reassigned" });
    expect(isReassignmentCancellation(source)).toBe(true);
    expect(isRecoveryFailure(source)).toBe(false);
    expect(selectAssignedRecoverySource(source, "engineer", assignment)).toEqual({ kind: "assignment", sourceRunId: source.id });
    expect(summarizeOwnedContinuationFailures([source], "engineer", "issue_reassigned", assignment)).toEqual({ consecutive: 0, latestFinishedAt: null });
  });

  it.each(["failed", "timed_out", "interrupted", "cancelled"])("preserves a real current-owner %s failure", status => {
    const source = run({ status });
    expect(isRecoveryFailure(source)).toBe(true);
    expect(selectAssignedRecoverySource(source, "engineer", assignment)).toEqual({ kind: "current", run: source });
  });

  it.each(["queued", "running", "scheduled_retry", "succeeded"])("does not charge a %s run as a failure", status => {
    expect(isRecoveryFailure(run({ status }))).toBe(false);
  });

  it("does not hide an actual failure just because its error code mentions reassignment", () => {
    expect(isRecoveryFailure(run({ status: "failed", errorCode: "issue_reassigned" }))).toBe(true);
  });

  it("never selects another owner's productive run as the current owner's continuation", () => {
    const previous = run({ agentId: "reviewer", status: "succeeded" });
    expect(selectAssignedRecoverySource(previous, "engineer", assignment)).toEqual({ kind: "assignment", sourceRunId: previous.id });
  });

  it("does not reuse an earlier A incident after A to B to A even if B never ran", () => {
    const oldA = run({ createdAt: new Date("2026-11-04T19:50:00Z") });
    expect(selectAssignedRecoverySource(oldA, "engineer", assignment)).toEqual({ kind: "assignment", sourceRunId: oldA.id });
    expect(summarizeOwnedContinuationFailures([oldA], "engineer", "adapter_failed", assignment).consecutive).toBe(0);
  });

  it("does not inherit earlier A failures behind a B handoff when legacy assignment audit is absent", () => {
    const currentA = run();
    const previousB = run({ id: "B", agentId: "reviewer", status: "cancelled", errorCode: "issue_reassigned" });
    const oldA = run({ id: "old-A" });
    expect(summarizeOwnedContinuationFailures([currentA, previousB, oldA], "engineer", "adapter_failed", null).consecutive).toBe(1);
  });

  it("stops the incident at a same-owner handoff cancellation", () => {
    expect(summarizeOwnedContinuationFailures([
      run(), run({ id: "handoff", status: "cancelled", errorCode: "issue_reassigned" }), run({ id: "old" }),
    ], "engineer", "adapter_failed", null).consecutive).toBe(1);
  });

  it("retains all three current-incident failures for the existing bounded escalation decision", () => {
    const failures = [run(), run({ id: "retry-2" }), run({ id: "retry-1" })];
    expect(summarizeOwnedContinuationFailures(failures, "engineer", "adapter_failed", assignment)).toEqual({ consecutive: 3, latestFinishedAt: failures[0].finishedAt });
  });

  it.each([
    { contextSnapshot: { retryReason: "assignment_recovery" } },
    { errorCode: "other-failure" },
    { status: "succeeded" },
    { agentId: "other-owner" },
  ])("does not cross a different incident boundary: %j", boundary => {
    expect(summarizeOwnedContinuationFailures([run(), run(boundary), run({ id: "old" })], "engineer", "adapter_failed", null).consecutive).toBe(1);
  });

  it.each(["user Stop", "pause hold", "operator cancel"])("never requests assignment recovery during a %s", () => {
    const previous = run({ agentId: "PM01", status: "cancelled", errorCode: "issue_reassigned" });
    expect(selectAssignedRecoverySource(previous, "engineer", assignment, true)).toEqual({ kind: "held" });
  });

  it("does not miss either successor in A to B to A and produces stable plans on repeated reconciliation", () => {
    const A = run({ id: "A-source", agentId: "A", status: "cancelled", errorCode: "issue_reassigned" });
    const B = run({ id: "B-source", agentId: "B", status: "cancelled", errorCode: "issue_reassigned" });
    expect(selectAssignedRecoverySource(A, "B", assignment)).toEqual({ kind: "assignment", sourceRunId: A.id });
    const returning = selectAssignedRecoverySource(B, "A", assignment);
    expect(returning).toEqual({ kind: "assignment", sourceRunId: B.id });
    expect(selectAssignedRecoverySource(B, "A", assignment)).toEqual(returning);
    const successor = run({ agentId: "A", status: "queued" });
    expect(selectAssignedRecoverySource(successor, "A", assignment)).toEqual({ kind: "current", run: successor });
  });

  it("recovers a recorded assignment with no run while preserving the legacy no-history path", () => {
    expect(selectAssignedRecoverySource(null, "engineer", assignment)).toEqual({ kind: "assignment", sourceRunId: null });
    expect(selectAssignedRecoverySource(null, "engineer", null)).toEqual({ kind: "current", run: null });
  });
});
