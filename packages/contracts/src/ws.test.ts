import { assert, it } from "@effect/vitest";
import { Schema } from "effect";

import { ORCHESTRATION_WS_CHANNELS, ORCHESTRATION_WS_METHODS } from "./orchestration";
import { WebSocketRequest, WsResponse, WS_CHANNELS, WS_METHODS } from "./ws";

function decodeSync<S extends Schema.Top>(schema: S, input: unknown): Schema.Schema.Type<S> {
  return Schema.decodeUnknownSync(schema as never)(input) as Schema.Schema.Type<S>;
}

it("accepts getTurnDiff requests when fromTurnCount <= toTurnCount", () => {
  const parsed = decodeSync(WebSocketRequest, {
    id: "req-1",
    body: {
      _tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
      threadId: "thread-1",
      fromTurnCount: 1,
      toTurnCount: 2,
    },
  });
  assert.strictEqual(parsed.body._tag, ORCHESTRATION_WS_METHODS.getTurnDiff);
});

it("rejects getTurnDiff requests when fromTurnCount > toTurnCount", () => {
  assert.throws(() =>
    decodeSync(WebSocketRequest, {
      id: "req-1",
      body: {
        _tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
        threadId: "thread-1",
        fromTurnCount: 3,
        toTurnCount: 2,
      },
    }),
  );
});

it("trims websocket request id and nested orchestration ids", () => {
  const parsed = decodeSync(WebSocketRequest, {
    id: " req-1 ",
    body: {
      _tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
      threadId: " thread-1 ",
      fromTurnCount: 0,
      toTurnCount: 0,
    },
  });
  assert.strictEqual(parsed.id, "req-1");
  assert.strictEqual(parsed.body._tag, ORCHESTRATION_WS_METHODS.getTurnDiff);
  if (parsed.body._tag === ORCHESTRATION_WS_METHODS.getTurnDiff) {
    assert.strictEqual(parsed.body.threadId, "thread-1");
  }
});

it("accepts git.preparePullRequestThread requests", () => {
  const parsed = decodeSync(WebSocketRequest, {
    id: "req-pr-1",
    body: {
      _tag: WS_METHODS.gitPreparePullRequestThread,
      cwd: "/repo",
      reference: "#42",
      mode: "worktree",
    },
  });
  assert.strictEqual(parsed.body._tag, WS_METHODS.gitPreparePullRequestThread);
});

it("preserves terminal shell selection fields in websocket terminal.open requests", () => {
  const parsed = decodeSync(WebSocketRequest, {
    id: "req-terminal-1",
    body: {
      _tag: WS_METHODS.terminalOpen,
      threadId: "thread-1",
      terminalId: "default",
      cwd: "C:\\repo",
      cols: 120,
      rows: 30,
      shellType: "custom",
      shellPath: "C:\\Program Files\\Git\\bin\\bash.exe",
    },
  });

  assert.strictEqual(parsed.body._tag, WS_METHODS.terminalOpen);
  if (parsed.body._tag === WS_METHODS.terminalOpen) {
    assert.strictEqual("shellType" in parsed.body && parsed.body.shellType, "custom");
    assert.strictEqual(
      "shellPath" in parsed.body && parsed.body.shellPath,
      "C:\\Program Files\\Git\\bin\\bash.exe",
    );
  }
});

it("accepts typed websocket push envelopes with sequence", () => {
  const parsed = decodeSync(WsResponse, {
    type: "push",
    sequence: 1,
    channel: WS_CHANNELS.serverWelcome,
    data: {
      cwd: "/tmp/workspace",
      projectName: "workspace",
    },
  });

  if (!("type" in parsed) || parsed.type !== "push") {
    assert.fail("expected websocket response to decode as a push envelope");
  }

  assert.strictEqual(parsed.type, "push");
  assert.strictEqual(parsed.sequence, 1);
  assert.strictEqual(parsed.channel, WS_CHANNELS.serverWelcome);
});

it("rejects push envelopes when channel payload does not match the channel schema", () => {
  assert.throws(() =>
    decodeSync(WsResponse, {
      type: "push",
      sequence: 2,
      channel: ORCHESTRATION_WS_CHANNELS.domainEvent,
      data: {
        cwd: "/tmp/workspace",
        projectName: "workspace",
      },
    }),
  );
});
