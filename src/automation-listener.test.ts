import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import process from "node:process";

// Mock pg so we never connect to a real Postgres.
const mockClient = {
  connect: vi.fn(async () => {}),
  query: vi.fn(async () => {}),
  on: vi.fn(),
  end: vi.fn(async () => {}),
};
function MockClient() {
  return mockClient;
}
vi.mock("pg", () => ({
  default: { Client: MockClient },
}));

// Mock automations so evaluateAutomations is a spy.
vi.mock("./automations.js", () => ({
  evaluateAutomations: vi.fn(async () => []),
}));

import {
  startAutomationListener,
  stopAutomationListener,
} from "./automation-listener.js";
import { evaluateAutomations } from "./automations.js";

// Reset module-level state between tests by re-importing is not trivial,
// so we use stop/start to reset.
describe("automation-listener", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
  });

  afterEach(async () => {
    await stopAutomationListener();
  });

  it("LISTENs on both object_changed and action_status_changed channels", async () => {
    await startAutomationListener();

    // query is called for LISTEN commands
    const listenCalls = (mockClient.query.mock.calls as unknown[][]).map((c) =>
      String(c[0]),
    );
    expect(listenCalls).toContain("LISTEN ontology_object_changed");
    expect(listenCalls).toContain("LISTEN action_status_changed");
  });

  it("dispatches object_changed notifications to evaluateAutomations with object_changed trigger", async () => {
    await startAutomationListener();

    // Find the notification handler registered on the mock client
    const notificationHandler = mockClient.on.mock.calls.find(
      (c) => c[0] === "notification",
    )?.[1] as ((msg: unknown) => void) | undefined;
    expect(notificationHandler).toBeDefined();

    // Simulate an object_changed notification
    notificationHandler!({
      channel: "ontology_object_changed",
      payload: JSON.stringify({
        workspace_id: "ws-1",
        object_id: "obj-1",
        object_type: "person",
        change_type: "insert",
      }),
    });

    // Wait for the async handler
    await new Promise((r) => setTimeout(r, 10));

    expect(evaluateAutomations).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: "ws-1",
        trigger: "object_changed",
        object_id: "obj-1",
        object_type: "person",
      }),
    );
  });

  it("maps action status 'proposed' to action_proposed trigger", async () => {
    await startAutomationListener();

    const notificationHandler = mockClient.on.mock.calls.find(
      (c) => c[0] === "notification",
    )?.[1] as ((msg: unknown) => void) | undefined;

    notificationHandler!({
      channel: "action_status_changed",
      payload: JSON.stringify({
        workspace_id: "ws-1",
        action_id: "act-1",
        action_type: "update_object",
        status: "proposed",
        old_status: null,
      }),
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(evaluateAutomations).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: "ws-1",
        trigger: "action_proposed",
        action_type: "update_object",
      }),
    );
  });

  it("maps action status 'approved' to action_approved trigger", async () => {
    await startAutomationListener();

    const notificationHandler = mockClient.on.mock.calls.find(
      (c) => c[0] === "notification",
    )?.[1] as ((msg: unknown) => void) | undefined;

    notificationHandler!({
      channel: "action_status_changed",
      payload: JSON.stringify({
        workspace_id: "ws-1",
        action_id: "act-1",
        action_type: "create_object",
        status: "approved",
        old_status: "proposed",
      }),
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(evaluateAutomations).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: "ws-1",
        trigger: "action_approved",
        action_type: "create_object",
      }),
    );
  });

  it("maps action status 'rejected' to action_rejected trigger", async () => {
    await startAutomationListener();

    const notificationHandler = mockClient.on.mock.calls.find(
      (c) => c[0] === "notification",
    )?.[1] as ((msg: unknown) => void) | undefined;

    notificationHandler!({
      channel: "action_status_changed",
      payload: JSON.stringify({
        workspace_id: "ws-1",
        action_id: "act-1",
        action_type: "webhook",
        status: "rejected",
        old_status: "proposed",
      }),
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(evaluateAutomations).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: "ws-1",
        trigger: "action_rejected",
        action_type: "webhook",
      }),
    );
  });

  it("maps action status 'executed' to action_executed trigger", async () => {
    await startAutomationListener();

    const notificationHandler = mockClient.on.mock.calls.find(
      (c) => c[0] === "notification",
    )?.[1] as ((msg: unknown) => void) | undefined;

    notificationHandler!({
      channel: "action_status_changed",
      payload: JSON.stringify({
        workspace_id: "ws-1",
        action_id: "act-1",
        action_type: "update_object",
        status: "executed",
        old_status: "approved",
      }),
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(evaluateAutomations).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: "ws-1",
        trigger: "action_executed",
        action_type: "update_object",
      }),
    );
  });

  it("ignores action statuses that don't map to automation triggers", async () => {
    await startAutomationListener();

    const notificationHandler = mockClient.on.mock.calls.find(
      (c) => c[0] === "notification",
    )?.[1] as ((msg: unknown) => void) | undefined;

    // 'running' and 'completed' are ingest statuses, not action lifecycle triggers
    notificationHandler!({
      channel: "action_status_changed",
      payload: JSON.stringify({
        workspace_id: "ws-1",
        action_id: "act-1",
        action_type: "ingest",
        status: "running",
        old_status: null,
      }),
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(evaluateAutomations).not.toHaveBeenCalled();
  });

  it("does not create duplicate connections when started twice without stopping", async () => {
    await startAutomationListener();
    const firstConnectCalls = mockClient.connect.mock.calls.length;

    await startAutomationListener();
    const secondConnectCalls = mockClient.connect.mock.calls.length;

    // Second start should not have created a new connection
    expect(secondConnectCalls).toBe(firstConnectCalls);
  });

  it("ignores notifications with empty payload", async () => {
    await startAutomationListener();

    const notificationHandler = mockClient.on.mock.calls.find(
      (c) => c[0] === "notification",
    )?.[1] as ((msg: unknown) => void) | undefined;

    notificationHandler!({ channel: "ontology_object_changed", payload: null });

    await new Promise((r) => setTimeout(r, 10));

    expect(evaluateAutomations).not.toHaveBeenCalled();
  });
});
