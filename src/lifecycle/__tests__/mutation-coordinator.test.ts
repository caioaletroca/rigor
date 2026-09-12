import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { withProjectMutationLock } from "../index.js";

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "rigor-mutation-coordinator-"));
  roots.push(value);
  return value;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("withProjectMutationLock", () => {
  it("runs same-root operations in FIFO order", async () => {
    const projectRoot = root();
    const firstRelease = deferred();
    const events: string[] = [];
    const first = withProjectMutationLock(projectRoot, async () => {
      events.push("first:start");
      await firstRelease.promise;
      events.push("first:end");
    });
    const second = withProjectMutationLock(projectRoot, async () => {
      events.push("second");
    });
    const third = withProjectMutationLock(projectRoot, async () => {
      events.push("third");
    });
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    firstRelease.resolve();
    await Promise.all([first, second, third]);
    expect(events).toEqual(["first:start", "first:end", "second", "third"]);
  });

  it("canonicalizes equivalent root paths", async () => {
    const projectRoot = root();
    const nested = join(projectRoot, "nested");
    mkdirSync(nested);
    const release = deferred();
    const events: string[] = [];
    const first = withProjectMutationLock(projectRoot, async () => {
      events.push("first");
      await release.promise;
    });
    const second = withProjectMutationLock(join(nested, ".."), async () => {
      events.push("second");
    });
    await Promise.resolve();
    expect(events).toEqual(["first"]);
    release.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["first", "second"]);
  });

  it.runIf(process.platform === "win32")("treats Windows root casing as equivalent", async () => {
    const projectRoot = realpathSync(root());
    const alternateCase = projectRoot.replace(/[a-z]/, (value) => value.toUpperCase());
    const release = deferred();
    let overlap = false;
    let running = false;
    const first = withProjectMutationLock(projectRoot, async () => {
      running = true;
      await release.promise;
      running = false;
    });
    const second = withProjectMutationLock(alternateCase, async () => {
      overlap = running;
    });
    await Promise.resolve();
    release.resolve();
    await Promise.all([first, second]);
    expect(overlap).toBe(false);
  });

  it("allows different roots to overlap", async () => {
    const firstRoot = root();
    const secondRoot = root();
    const release = deferred();
    let secondStarted = false;
    const first = withProjectMutationLock(firstRoot, async () => {
      await release.promise;
    });
    const second = withProjectMutationLock(secondRoot, async () => {
      secondStarted = true;
    });
    await second;
    expect(secondStarted).toBe(true);
    release.resolve();
    await first;
  });

  it("releases queued operations after an error", async () => {
    const projectRoot = root();
    const release = deferred();
    let secondStarted = false;
    const first = withProjectMutationLock(projectRoot, async () => {
      await release.promise;
      throw new Error("failure");
    });
    const second = withProjectMutationLock(projectRoot, async () => {
      secondStarted = true;
    });
    release.resolve();
    await expect(first).rejects.toThrow("failure");
    await second;
    expect(secondStarted).toBe(true);
  });

  it("removes idle entries so later operations start immediately", async () => {
    const projectRoot = root();
    await withProjectMutationLock(projectRoot, async () => undefined);
    let started = false;
    await withProjectMutationLock(projectRoot, async () => {
      started = true;
    });
    expect(started).toBe(true);
  });
});
