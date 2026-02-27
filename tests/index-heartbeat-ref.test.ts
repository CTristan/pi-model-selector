import { describe, expect, it, vi } from "vitest";

vi.mock("../src/selector.js", () => ({
  runSelector: vi.fn().mockResolvedValue(true),
}));

import modelSelectorExtension from "../index.js";
import { runSelector } from "../src/selector.js";

describe("Model selector heartbeat reference", () => {
  it("reuses the lock heartbeat reference across selector runs", async () => {
    const runSelectorMock = vi.mocked(runSelector);
    const heartbeat = {} as NodeJS.Timeout;

    runSelectorMock.mockImplementation(
      async (_ctx, _cooldown, _coordinator, lockHeartbeatTimer) => {
        if (!lockHeartbeatTimer.current) {
          lockHeartbeatTimer.current = heartbeat;
        }
        return true;
      },
    );

    const commands: Record<string, (args: unknown, ctx: unknown) => unknown> =
      {};
    const pi = {
      on: vi.fn(),
      registerCommand: vi.fn((name, opts) => {
        commands[name] = opts.handler;
      }),
      setModel: vi.fn(),
    };

    const ctx = {
      modelRegistry: { find: vi.fn() },
      ui: { notify: vi.fn(), setStatus: vi.fn() },
      hasUI: true,
    };

    modelSelectorExtension(pi as any);

    await commands["model-select"]({}, ctx);
    await commands["model-select"]({}, ctx);

    expect(runSelectorMock).toHaveBeenCalledTimes(2);
    const firstRef = runSelectorMock.mock.calls[0]?.[3];
    const secondRef = runSelectorMock.mock.calls[1]?.[3];
    expect(secondRef).toBe(firstRef);
    expect(secondRef?.current).toBe(heartbeat);
  });
});
