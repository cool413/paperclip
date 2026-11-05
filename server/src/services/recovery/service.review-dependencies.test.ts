import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, agents, approvals, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issueApprovals, issueRelations, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { recoveryService } from "./service.js";

const past = new Date("2026-11-01T00:00:00Z");

describe("review continuation dependency recovery", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("fen181-review-dependencies");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
  });
  beforeEach(async () => {
    await db.execute(sql`truncate table companies restart identity cascade`);
  });

  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Review dependency fixture", issuePrefix: `T${randomUUID().slice(0, 7)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Returned engineer", status: "active", adapterType: "codex_local" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Continue after review", status: "in_progress", assigneeAgentId: agent.id, createdAt: past }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company.id, agentId: agent.id, scopeKind: "issue", issueId: issue.id,
      status: "cancelled", errorCode: "issue_continuation_waiting_on_review",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      createdAt: past, finishedAt: past, contextSnapshot: { issueId: issue.id, wakeReason: "issue_continuation_needed" },
    }).returning();
    const [child] = await db.insert(issues).values({ companyId: company.id, title: "Independent child", parentId: issue.id, status: "todo" }).returning();
    const enqueueWakeup = vi.fn(async () => null);
    const recover = () => recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();
    const readIssue = () => db.select().from(issues).where(eq(issues.id, issue.id)).then(rows => rows[0]!);
    const edges = () => db.select().from(issueRelations).where(and(eq(issueRelations.companyId, company.id), eq(issueRelations.relatedIssueId, issue.id)));
    return { company, agent, issue, run, child, enqueueWakeup, recover, readIssue, edges };
  }

  it("does not turn an open child into a dependency after a cancelled review continuation", async () => {
    const f = await fixture();
    const outcome = await f.recover();
    expect(outcome.waitingOnReviewResolved).toBe(0);
    expect((await f.readIssue()).status).toBe("in_progress");
    expect(await f.edges()).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, f.issue.id))).not.toContainEqual(
      expect.objectContaining({ details: expect.objectContaining({ source: "recovery.reconcile_continuation_waiting_on_review" }) }),
    );
  });

  it("blocks only on an explicit unresolved relation and preserves unrelated child hierarchy", async () => {
    const f = await fixture();
    const [blocker] = await db.insert(issues).values({ companyId: f.company.id, title: "Explicit prerequisite", status: "todo" }).returning();
    await db.insert(issueRelations).values({ companyId: f.company.id, issueId: blocker.id, relatedIssueId: f.issue.id, type: "blocks" });
    await f.recover();
    expect((await f.readIssue()).status).toBe("blocked");
    expect((await f.edges()).map(edge => edge.issueId)).toEqual([blocker.id]);
    expect(f.enqueueWakeup).not.toHaveBeenCalled();
    expect((await db.select().from(issues).where(eq(issues.id, f.child.id)))[0]).toEqual(f.child);
    await f.recover();
    expect((await f.edges()).map(edge => edge.issueId)).toEqual([blocker.id]);
    expect(f.enqueueWakeup).not.toHaveBeenCalled();
  });

  it.each(["done", "cancelled"])("does not reactivate a %s prerequisite because another child is open", async status => {
    const f = await fixture();
    const [blocker] = await db.insert(issues).values({ companyId: f.company.id, title: "Settled prerequisite", status }).returning();
    await db.insert(issueRelations).values({ companyId: f.company.id, issueId: blocker.id, relatedIssueId: f.issue.id, type: "blocks" });
    await f.recover();
    expect((await f.readIssue()).status).toBe("in_progress");
    expect((await f.edges()).map(edge => edge.issueId)).toEqual([blocker.id]);
  });

  it("does not import an invalid foreign-company dependency", async () => {
    const f = await fixture();
    const [foreign] = await db.insert(companies).values({ name: "Foreign company", issuePrefix: `T${randomUUID().slice(0, 7)}` }).returning();
    const [blocker] = await db.insert(issues).values({ companyId: foreign.id, title: "Foreign prerequisite", status: "todo" }).returning();
    await db.insert(issueRelations).values({ companyId: f.company.id, issueId: blocker.id, relatedIssueId: f.issue.id, type: "blocks" });
    await f.recover();
    expect((await f.readIssue()).status).toBe("in_progress");
    expect((await f.edges()).map(edge => edge.issueId)).toEqual([blocker.id]);
  });

  it("preserves an explicit pending approval without converting children into blockers", async () => {
    const f = await fixture();
    const [approval] = await db.insert(approvals).values({ companyId: f.company.id, type: "hire_agent", status: "pending", payload: {} }).returning();
    await db.insert(issueApprovals).values({ companyId: f.company.id, issueId: f.issue.id, approvalId: approval.id });
    await f.recover();
    expect(f.enqueueWakeup).not.toHaveBeenCalled();
    expect(await f.edges()).toHaveLength(0);
    expect((await db.select().from(approvals).where(eq(approvals.id, approval.id)))[0].status).toBe("pending");
  });
});
