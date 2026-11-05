import { onTestFinished, type Mock } from "vitest";

export function createHeartbeatTestCleanup() {
  const releases = new Set<() => void>();
  return {
    track(release: () => void) {
      let released = false;
      const once = () => {
        if (released) return;
        released = true;
        releases.delete(once);
        release();
      };
      releases.add(once);
      onTestFinished(once);
    },
    release() {
      const failures: unknown[] = [];
      for (const release of releases) {
        try { release(); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, "Test resource release failed");
    },
  };
}

export function resetHeartbeatTestMock<T extends (...args: never[]) => unknown>(mock: Mock<T>, implementation: T) {
  mock.mockReset().mockImplementation(implementation);
}

export async function withinHeartbeatCleanupDeadline<T>(operation: () => Promise<T>, label: string, timeoutMs = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function cleanupHeartbeatFixture(drain: () => Promise<unknown>, remove: () => Promise<unknown>) {
  let failure: unknown;
  let failed = false;
  try {
    await drain();
  } catch (error) {
    failure = error;
    failed = true;
  } finally {
    try {
      await remove();
    } catch (error) {
      if (failed) throw new AggregateError([failure, error], "Heartbeat drain and fixture deletion failed");
      throw error;
    }
  }
  if (failed) throw failure;
}
