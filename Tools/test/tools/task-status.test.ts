import { describe, it, expect } from "vitest";
import { ueGet, uePost } from "../helpers.js";

// Background-task system: ?async=1 on any queued endpoint returns a taskId immediately;
// /api/task-status (answered on the HTTP thread) reports pending/running/done and embeds the
// operation's result once done. See docs/ROADMAP-server-hardening.md item 2.
describe("background tasks (/api/task-status + ?async=1)", () => {
  describe("task-status validation", () => {
    it("returns error when id is missing", async () => {
      const data = await ueGet("/api/task-status");
      expect(data.error).toBeDefined();
      expect(data.error).toContain("id");
    });

    it("returns error for an unknown task id", async () => {
      const data = await ueGet("/api/task-status", { id: "task_999999" });
      expect(data.error).toBeDefined();
      expect(data.error).toContain("task_999999");
    });
  });

  describe("async dispatch", () => {
    it("save-all with async=1 returns a pending taskId immediately and completes", async () => {
      const started = await uePost("/api/save-all?async=1", {});
      expect(started.error).toBeUndefined();
      expect(started.success).toBe(true);
      expect(started.taskId).toMatch(/^task_\d+$/);
      expect(started.state).toBe("pending");
      expect(started.endpoint).toBe("saveAll");

      // Poll until done (commandlet save-all with no dirty packages is fast).
      let status: any;
      for (let i = 0; i < 60; i++) {
        status = await ueGet("/api/task-status", { id: started.taskId });
        expect(status.error).toBeUndefined();
        expect(["pending", "running", "done"]).toContain(status.state);
        if (status.state === "done") break;
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(status.state).toBe("done");
      expect(status.taskId).toBe(started.taskId);
      expect(status.endpoint).toBe("saveAll");
      expect(typeof status.elapsedSeconds).toBe("number");
      // The embedded result is the handler's own JSON.
      expect(status.result ?? status.resultText).toBeDefined();
    });

    it("accepts the word form async=true as well as async=1", async () => {
      const resp = await uePost("/api/save-all?async=true", {});
      expect(resp.taskId).toMatch(/^task_\d+$/);
      expect(resp.state).toBe("pending");
    });

    it("a completed task remains queryable (result retention)", async () => {
      const started = await uePost("/api/save-all?async=1", {});
      expect(started.taskId).toBeDefined();
      let status: any;
      for (let i = 0; i < 60; i++) {
        status = await ueGet("/api/task-status", { id: started.taskId });
        if (status.state === "done") break;
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(status.state).toBe("done");
      // Query again — still there.
      const again = await ueGet("/api/task-status", { id: started.taskId });
      expect(again.state).toBe("done");
      expect(again.taskId).toBe(started.taskId);
    });

    it("synchronous behavior is unchanged when async is absent", async () => {
      const data = await uePost("/api/save-all", {});
      // No taskId on the synchronous path — the full result comes back directly.
      expect(data.taskId).toBeUndefined();
      expect(data.error ?? data.success).toBeDefined();
    });
  });
});
