import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";

import {
  ApprovalRequestId,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type ChatAttachment,
  type OrchestrationMessage,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderTurnStartResult,
} from "@t3tools/contracts";
import { Effect, Layer, Queue, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { runProcess } from "../../processRunner.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { OpenRouterAdapter, type OpenRouterAdapterShape } from "../Services/OpenRouterAdapter.ts";

const PROVIDER = "openrouter" as const;
const OPENROUTER_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_TOOL_ITERATIONS = 8;
const MAX_FILE_READ_CHARS = 40_000;
const MAX_LIST_FILE_ENTRIES = 400;
const MAX_SEARCH_RESULTS = 200;
const MAX_TOOL_RESULT_CHARS = 40_000;
const PROPOSED_PLAN_BLOCK_REGEX = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i;

type OpenRouterResponse = {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      role?: string;
      content?: unknown;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
  usage?: Record<string, unknown>;
};

type OpenRouterMessage =
  | { role: "system" | "assistant"; content: string }
  | {
      role: "user";
      content:
        | string
        | Array<
            | { type: "text"; text: string }
            | { type: "image_url"; image_url: { url: string } }
          >;
    }
  | {
      role: "assistant";
      content: string;
      tool_calls: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

type SessionApproval = {
  readonly requestId: ApprovalRequestId;
  readonly toolName: "apply_patch" | "shell_command";
  readonly detail: string;
  readonly resolve: (decision: ProviderApprovalDecision) => void;
};

type SessionState = {
  readonly threadId: ThreadId;
  readonly createdAt: string;
  runtimeMode: ProviderSession["runtimeMode"];
  cwd?: string;
  model?: string;
  status: ProviderSession["status"];
  updatedAt: string;
  activeTurnId?: TurnId;
  lastError?: string;
  abortController: AbortController | null;
  activeCommandChild: ChildProcessWithoutNullStreams | null;
  pendingApproval: SessionApproval | null;
};

type ToolExecutionContext = {
  readonly session: SessionState;
  readonly turnId: TurnId;
  readonly workspaceRoot: string;
};

type ToolExecutionResult = {
  readonly output: string;
  readonly itemType: "command_execution" | "file_change" | "dynamic_tool_call";
  readonly title: string;
  readonly detail?: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function makeEventId(kind: string): string {
  return `${PROVIDER}:${kind}:${crypto.randomUUID()}`;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function truncateText(value: string, max = MAX_TOOL_RESULT_CHARS): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Expected a JSON object.");
    }
    return parsed as Record<string, unknown>;
  } catch (cause) {
    throw new Error(`Invalid JSON tool arguments: ${String(cause)}`);
  }
}

function buildSessionRecord(session: SessionState): ProviderSession {
  return {
    provider: PROVIDER,
    status: session.status,
    runtimeMode: session.runtimeMode,
    ...(session.cwd ? { cwd: session.cwd } : {}),
    ...(session.model ? { model: session.model } : {}),
    threadId: session.threadId,
    ...(session.activeTurnId ? { activeTurnId: session.activeTurnId } : {}),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(session.lastError ? { lastError: session.lastError } : {}),
  };
}

function baseRuntimeEvent(
  session: SessionState,
  type: ProviderRuntimeEvent["type"],
  payload: ProviderRuntimeEvent["payload"],
  extra?: Partial<
    Pick<ProviderRuntimeEvent, "turnId" | "itemId" | "requestId" | "providerRefs">
  >,
): ProviderRuntimeEvent {
  return {
    type,
    eventId: makeEventId(type),
    provider: PROVIDER,
    threadId: session.threadId,
    createdAt: nowIso(),
    ...(extra?.turnId ? { turnId: extra.turnId } : {}),
    ...(extra?.itemId ? { itemId: extra.itemId } : {}),
    ...(extra?.requestId ? { requestId: extra.requestId } : {}),
    ...(extra?.providerRefs ? { providerRefs: extra.providerRefs } : {}),
    payload,
  } as ProviderRuntimeEvent;
}

function extractProposedPlanMarkdown(text: string | undefined): string | undefined {
  const match = text ? PROPOSED_PLAN_BLOCK_REGEX.exec(text) : null;
  const planMarkdown = match?.[1]?.trim();
  return planMarkdown && planMarkdown.length > 0 ? planMarkdown : undefined;
}

function normalizeAssistantContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((entry) => {
      if (typeof entry === "string") {
        return [entry];
      }
      if (!entry || typeof entry !== "object") {
        return [];
      }
      const record = entry as Record<string, unknown>;
      if (typeof record.text === "string") {
        return [record.text];
      }
      if (record.type === "text" && typeof record.content === "string") {
        return [record.content];
      }
      return [];
    })
    .join("");
}

function resolveWorkspacePath(workspaceRoot: string, requestedPath?: string): string {
  if (!requestedPath) {
    return workspaceRoot;
  }
  const candidate = requestedPath.trim();
  if (!candidate) {
    return workspaceRoot;
  }
  const resolved = path.resolve(workspaceRoot, candidate);
  const relativeToRoot = path.relative(workspaceRoot, resolved);
  if (
    relativeToRoot.startsWith("..") ||
    relativeToRoot === ".." ||
    path.isAbsolute(relativeToRoot)
  ) {
    throw new Error("Requested path must stay within the workspace root.");
  }
  return resolved;
}

async function readAttachmentDataUrl(
  stateDir: string,
  attachment: ChatAttachment,
): Promise<string | null> {
  const attachmentPath = resolveAttachmentPath({ stateDir, attachment });
  if (!attachmentPath) {
    return null;
  }
  const bytes = await fs.readFile(attachmentPath);
  return `data:${attachment.mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

async function toOpenRouterMessage(
  stateDir: string,
  message: OrchestrationMessage,
): Promise<OpenRouterMessage> {
  if (message.role !== "user") {
    return {
      role: message.role,
      content: message.text,
    };
  }

  if (!message.attachments || message.attachments.length === 0) {
    return { role: "user", content: message.text };
  }

  const content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [];
  if (message.text.trim().length > 0) {
    content.push({ type: "text", text: message.text });
  }

  for (const attachment of message.attachments) {
    if (attachment.type !== "image") {
      continue;
    }
    const dataUrl = await readAttachmentDataUrl(stateDir, attachment);
    if (!dataUrl) {
      continue;
    }
    content.push({
      type: "image_url",
      image_url: {
        url: dataUrl,
      },
    });
  }

  return {
    role: "user",
    content: content.length > 0 ? content : message.text,
  };
}

function buildSystemPrompt(input: {
  readonly workspaceRoot: string;
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly interactionMode?: ProviderSendTurnInput["interactionMode"];
}): string {
  const lines = [
    "You are T3 Code's coding agent running through the OpenRouter provider.",
    `Workspace root: ${input.workspaceRoot}`,
    "Use tools when they materially improve correctness.",
    "All file paths must stay within the workspace root.",
    "When using apply_patch, send the patch in T3 apply_patch format.",
    "Use update_plan for checklist/progress state.",
  ];

  if (input.runtimeMode === "approval-required") {
    lines.push("Mutable actions may require approval. Continue safely if they are declined.");
  }

  if (input.interactionMode === "plan") {
    lines.push("This turn is in plan mode.");
    lines.push("Avoid making changes unless absolutely necessary.");
    lines.push("Return the proposed implementation plan inside <proposed_plan>...</proposed_plan>.");
  }

  return lines.join("\n");
}

function toolDefinitions() {
  return [
    {
      type: "function",
      function: {
        name: "list_files",
        description: "List files inside the workspace root or a relative subdirectory.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            recursive: { type: "boolean" },
            limit: { type: "integer", minimum: 1, maximum: MAX_LIST_FILE_ENTRIES },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_text",
        description: "Search for text inside files in the workspace using ripgrep.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string" },
            path: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: MAX_SEARCH_RESULTS },
          },
          required: ["pattern"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file from the workspace. Paths must stay inside the workspace root.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            startLine: { type: "integer", minimum: 1 },
            endLine: { type: "integer", minimum: 1 },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "apply_patch",
        description:
          "Apply a patch in T3 apply_patch format. The patch must begin with *** Begin Patch and end with *** End Patch.",
        parameters: {
          type: "object",
          properties: {
            patch: { type: "string" },
          },
          required: ["patch"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "shell_command",
        description:
          "Run a shell command in the workspace root or a workspace subdirectory and return combined output.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
            cwd: { type: "string" },
          },
          required: ["command"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "update_plan",
        description: "Update the in-turn plan/checklist shown in the T3 plan sidebar.",
        parameters: {
          type: "object",
          properties: {
            explanation: { type: ["string", "null"] },
            plan: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  step: { type: "string" },
                  status: { type: "string", enum: ["pending", "inProgress", "completed"] },
                },
                required: ["step", "status"],
              },
            },
          },
          required: ["plan"],
        },
      },
    },
  ] as const;
}

async function callOpenRouter(input: {
  readonly apiKey: string;
  readonly model: string;
  readonly messages: ReadonlyArray<OpenRouterMessage>;
  readonly abortSignal: AbortSignal;
}): Promise<OpenRouterResponse> {
  const response = await fetch(OPENROUTER_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/pingdotgg/t3code",
      "X-Title": "T3 Code",
    },
    body: JSON.stringify({
      model: input.model,
      messages: input.messages,
      tools: toolDefinitions(),
      tool_choice: "auto",
    }),
    signal: input.abortSignal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `OpenRouter request failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`,
    );
  }

  return (await response.json()) as OpenRouterResponse;
}

async function listFilesTool(workspaceRoot: string, args: Record<string, unknown>): Promise<string> {
  const targetPath = resolveWorkspacePath(workspaceRoot, normalizeString(args.path));
  const recursive = args.recursive === true;
  const maxEntries = Math.min(
    MAX_LIST_FILE_ENTRIES,
    Math.max(1, normalizeInteger(args.limit) ?? 200),
  );
  const results: string[] = [];

  const walk = async (directory: string) => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= maxEntries) {
        return;
      }
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(workspaceRoot, absolutePath).replaceAll("\\", "/");
      results.push(entry.isDirectory() ? `${relativePath}/` : relativePath);
      if (recursive && entry.isDirectory()) {
        await walk(absolutePath);
      }
    }
  };

  await walk(targetPath);
  return truncateText(results.join("\n"));
}

async function searchTextTool(workspaceRoot: string, args: Record<string, unknown>): Promise<string> {
  const pattern = normalizeString(args.pattern);
  if (!pattern) {
    throw new Error("search_text requires a non-empty pattern.");
  }
  const targetPath = resolveWorkspacePath(workspaceRoot, normalizeString(args.path));
  const maxResults = Math.min(
    MAX_SEARCH_RESULTS,
    Math.max(1, normalizeInteger(args.limit) ?? 80),
  );

  try {
    const result = await runProcess(
      "rg",
      [
        "--line-number",
        "--no-heading",
        "--color",
        "never",
        "--max-count",
        String(maxResults),
        pattern,
        targetPath,
      ],
      {
        cwd: workspaceRoot,
        allowNonZeroExit: true,
        outputMode: "truncate",
      },
    );
    const output = `${result.stdout}${result.stderr}`.trim();
    return output.length > 0 ? truncateText(output) : "No matches found.";
  } catch (cause) {
    return `search_text failed: ${String(cause)}`;
  }
}

async function readFileTool(workspaceRoot: string, args: Record<string, unknown>): Promise<string> {
  const requestedPath = normalizeString(args.path);
  if (!requestedPath) {
    throw new Error("read_file requires a path.");
  }
  const absolutePath = resolveWorkspacePath(workspaceRoot, requestedPath);
  const content = await fs.readFile(absolutePath, "utf8");
  const lines = content.split(/\r?\n/);
  const startLine = Math.max(1, normalizeInteger(args.startLine) ?? 1);
  const endLine = Math.max(startLine, normalizeInteger(args.endLine) ?? lines.length);
  const sliced = lines
    .slice(startLine - 1, endLine)
    .map((line, index) => `${startLine + index}: ${line}`)
    .join("\n");
  return truncateText(sliced, MAX_FILE_READ_CHARS);
}

type ParsedPatch =
  | { kind: "add"; filePath: string; lines: string[] }
  | { kind: "delete"; filePath: string }
  | { kind: "update"; filePath: string; moveTo?: string; lines: string[] };

function parsePatch(patch: string): ParsedPatch[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "*** Begin Patch") {
    throw new Error("Patch must start with *** Begin Patch.");
  }

  const parsed: ParsedPatch[] = [];
  let index = 1;
  while (index < lines.length) {
    const line = lines[index];
    if (line === "*** End Patch") {
      return parsed;
    }
    if (!line) {
      index += 1;
      continue;
    }
    if (line.startsWith("*** Add File: ")) {
      const filePath = line.slice("*** Add File: ".length).trim();
      index += 1;
      const addLines: string[] = [];
      while (index < lines.length) {
        const current = lines[index];
        if (
          current === "*** End Patch" ||
          current.startsWith("*** Add File: ") ||
          current.startsWith("*** Delete File: ") ||
          current.startsWith("*** Update File: ")
        ) {
          break;
        }
        if (!current.startsWith("+")) {
          throw new Error(`Invalid add-file line: ${current}`);
        }
        addLines.push(current.slice(1));
        index += 1;
      }
      parsed.push({ kind: "add", filePath, lines: addLines });
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      parsed.push({
        kind: "delete",
        filePath: line.slice("*** Delete File: ".length).trim(),
      });
      index += 1;
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      const filePath = line.slice("*** Update File: ".length).trim();
      index += 1;
      let moveTo: string | undefined;
      if (lines[index]?.startsWith("*** Move to: ")) {
        moveTo = lines[index]!.slice("*** Move to: ".length).trim();
        index += 1;
      }
      const updateLines: string[] = [];
      while (index < lines.length) {
        const current = lines[index];
        if (
          current === "*** End Patch" ||
          current.startsWith("*** Add File: ") ||
          current.startsWith("*** Delete File: ") ||
          current.startsWith("*** Update File: ")
        ) {
          break;
        }
        updateLines.push(current);
        index += 1;
      }
      parsed.push({ kind: "update", filePath, moveTo, lines: updateLines });
      continue;
    }
    throw new Error(`Unknown patch hunk header: ${line}`);
  }

  throw new Error("Patch must end with *** End Patch.");
}

function applyUpdateLines(original: string, patchLines: string[]): string {
  const originalLines = original.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];
  let cursor = 0;
  let block: string[] = [];

  const flushBlock = () => {
    if (block.length === 0) {
      return;
    }
    const oldChunk = block
      .filter((line) => line.startsWith(" ") || line.startsWith("-"))
      .map((line) => line.slice(1));
    const newChunk = block
      .filter((line) => line.startsWith(" ") || line.startsWith("+"))
      .map((line) => line.slice(1));

    if (oldChunk.length === 0) {
      output.push(...newChunk);
      block = [];
      return;
    }

    let matchIndex = -1;
    for (let index = cursor; index <= originalLines.length - oldChunk.length; index += 1) {
      let matched = true;
      for (let offset = 0; offset < oldChunk.length; offset += 1) {
        if (originalLines[index + offset] !== oldChunk[offset]) {
          matched = false;
          break;
        }
      }
      if (matched) {
        matchIndex = index;
        break;
      }
    }

    if (matchIndex < 0) {
      throw new Error("Patch context did not match file contents.");
    }

    output.push(...originalLines.slice(cursor, matchIndex), ...newChunk);
    cursor = matchIndex + oldChunk.length;
    block = [];
  };

  for (const line of patchLines) {
    if (line === "@@" || line.startsWith("@@ ")) {
      flushBlock();
      continue;
    }
    if (line === "*** End of File") {
      continue;
    }
    if (
      !line.startsWith(" ") &&
      !line.startsWith("+") &&
      !line.startsWith("-")
    ) {
      throw new Error(`Invalid patch line: ${line}`);
    }
    block.push(line);
  }

  flushBlock();
  output.push(...originalLines.slice(cursor));
  return output.join("\n");
}

async function applyPatchTool(workspaceRoot: string, patch: string): Promise<string> {
  const hunks = parsePatch(patch);
  for (const hunk of hunks) {
    if (hunk.kind === "add") {
      const filePath = resolveWorkspacePath(workspaceRoot, hunk.filePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, hunk.lines.join("\n"), "utf8");
      continue;
    }
    if (hunk.kind === "delete") {
      const filePath = resolveWorkspacePath(workspaceRoot, hunk.filePath);
      await fs.rm(filePath, { force: true });
      continue;
    }

    const filePath = resolveWorkspacePath(workspaceRoot, hunk.filePath);
    const current = await fs.readFile(filePath, "utf8");
    const next = applyUpdateLines(current, hunk.lines);
    const targetPath = hunk.moveTo
      ? resolveWorkspacePath(workspaceRoot, hunk.moveTo)
      : filePath;
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, next, "utf8");
    if (hunk.moveTo && targetPath !== filePath) {
      await fs.rm(filePath, { force: true });
    }
  }

  return `Applied ${hunks.length} patch hunk(s).`;
}

async function runShellCommandTool(
  workspaceRoot: string,
  args: Record<string, unknown>,
  session: SessionState,
): Promise<string> {
  const command = normalizeString(args.command);
  if (!command) {
    throw new Error("shell_command requires a command.");
  }
  const commandCwd = resolveWorkspacePath(workspaceRoot, normalizeString(args.cwd));

  return new Promise<string>((resolve, reject) => {
    const child =
      process.platform === "win32"
        ? spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", command], {
            cwd: commandCwd,
            env: process.env,
            stdio: "pipe",
          })
        : spawn("bash", ["-lc", command], {
            cwd: commandCwd,
            env: process.env,
            stdio: "pipe",
          });

    session.activeCommandChild = child;
    let stdout = "";
    let stderr = "";
    let settled = false;

    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      cleanup();
      reject(new Error("Command aborted."));
    };

    const cleanup = () => {
      session.activeCommandChild = null;
      session.abortController?.signal.removeEventListener("abort", onAbort);
    };

    session.abortController?.signal.addEventListener("abort", onAbort);

    child.stdout.on("data", (chunk) => {
      stdout = truncateText(`${stdout}${chunk.toString()}`);
    });
    child.stderr.on("data", (chunk) => {
      stderr = truncateText(`${stderr}${chunk.toString()}`);
    });
    child.once("error", (cause) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(cause);
    });
    child.once("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(
        truncateText(
          [
            `$ ${command}`,
            stdout.trim(),
            stderr.trim(),
            `exit=${code ?? "null"} signal=${signal ?? "null"}`,
          ]
            .filter((entry) => entry.length > 0)
            .join("\n"),
        ),
      );
    });
  });
}

async function waitForApproval(
  session: SessionState,
  emit: (event: ProviderRuntimeEvent) => Effect.Effect<void>,
  input: {
    readonly turnId: TurnId;
    readonly toolName: "apply_patch" | "shell_command";
    readonly detail: string;
  },
): Promise<ProviderApprovalDecision> {
  const requestId = ApprovalRequestId.makeUnsafe(`approval:${crypto.randomUUID()}`);
  const requestType =
    input.toolName === "apply_patch" ? "apply_patch_approval" : "exec_command_approval";

  await Effect.runPromise(
    emit(
      baseRuntimeEvent(
        session,
        "request.opened",
        {
          requestType,
          detail: input.detail,
          args: {
            toolName: input.toolName,
          },
        },
        {
          turnId: input.turnId,
          requestId: RuntimeRequestId.makeUnsafe(requestId),
        },
      ),
    ),
  );

  const decision = await new Promise<ProviderApprovalDecision>((resolve) => {
    session.pendingApproval = {
      requestId,
      toolName: input.toolName,
      detail: input.detail,
      resolve,
    };
  });

  session.pendingApproval = null;

  await Effect.runPromise(
    emit(
      baseRuntimeEvent(
        session,
        "request.resolved",
        {
          requestType,
          decision,
          resolution: {
            toolName: input.toolName,
          },
        },
        {
          turnId: input.turnId,
          requestId: RuntimeRequestId.makeUnsafe(requestId),
        },
      ),
    ),
  );

  return decision;
}

async function executeTool(
  context: ToolExecutionContext,
  emit: (event: ProviderRuntimeEvent) => Effect.Effect<void>,
  toolCall: { id: string; function: { name: string; arguments: string } },
): Promise<ToolExecutionResult> {
  const args = parseJsonObject(toolCall.function.arguments);

  if (toolCall.function.name === "list_files") {
    return {
      output: await listFilesTool(context.workspaceRoot, args),
      itemType: "dynamic_tool_call",
      title: "List files",
    };
  }
  if (toolCall.function.name === "search_text") {
    return {
      output: await searchTextTool(context.workspaceRoot, args),
      itemType: "dynamic_tool_call",
      title: "Search text",
    };
  }
  if (toolCall.function.name === "read_file") {
    return {
      output: await readFileTool(context.workspaceRoot, args),
      itemType: "dynamic_tool_call",
      title: "Read file",
    };
  }
  if (toolCall.function.name === "update_plan") {
    const rawPlan = Array.isArray(args.plan) ? args.plan : [];
    const plan = rawPlan
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        const record = entry as Record<string, unknown>;
        const step = normalizeString(record.step);
        const status =
          record.status === "pending" ||
          record.status === "inProgress" ||
          record.status === "completed"
            ? record.status
            : null;
        if (!step || !status) {
          return null;
        }
        return { step, status };
      })
      .filter(
        (entry): entry is { step: string; status: "pending" | "inProgress" | "completed" } =>
          entry !== null,
      );

    await Effect.runPromise(
      emit(
        baseRuntimeEvent(
          context.session,
          "turn.plan.updated",
          {
            explanation: normalizeString(args.explanation) ?? null,
            plan,
          },
          {
            turnId: context.turnId,
          },
        ),
      ),
    );

    return {
      output: "Plan updated.",
      itemType: "dynamic_tool_call",
      title: "Update plan",
    };
  }
  if (toolCall.function.name === "apply_patch") {
    const patch = normalizeString(args.patch);
    if (!patch) {
      throw new Error("apply_patch requires a patch.");
    }
    if (context.session.runtimeMode === "approval-required") {
      const decision = await waitForApproval(context.session, emit, {
        turnId: context.turnId,
        toolName: "apply_patch",
        detail: "Apply patch to workspace files",
      });
      if (decision !== "accept" && decision !== "acceptForSession") {
        return {
          output: `Patch request ${decision}.`,
          itemType: "file_change",
          title: "Apply patch",
          detail: "Patch request was not approved.",
        };
      }
    }
    return {
      output: await applyPatchTool(context.workspaceRoot, patch),
      itemType: "file_change",
      title: "Apply patch",
    };
  }
  if (toolCall.function.name === "shell_command") {
    if (context.session.runtimeMode === "approval-required") {
      const decision = await waitForApproval(context.session, emit, {
        turnId: context.turnId,
        toolName: "shell_command",
        detail: normalizeString(args.command) ?? "Run shell command",
      });
      if (decision !== "accept" && decision !== "acceptForSession") {
        return {
          output: `Command request ${decision}.`,
          itemType: "command_execution",
          title: "Run command",
          detail: "Command request was not approved.",
        };
      }
    }
    return {
      output: await runShellCommandTool(context.workspaceRoot, args, context.session),
      itemType: "command_execution",
      title: "Run command",
    };
  }

  throw new Error(`Unknown tool '${toolCall.function.name}'.`);
}

const makeOpenRouterAdapter = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  const sessions = new Map<ThreadId, SessionState>();
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

  const emit = (event: ProviderRuntimeEvent) =>
    Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

  const requireSession = (threadId: ThreadId): SessionState => {
    const session = sessions.get(threadId);
    if (!session) {
      throw new ProviderAdapterSessionNotFoundError({
        provider: PROVIDER,
        threadId,
      });
    }
    return session;
  };

  const readThreadSnapshot = Effect.fn(function* (threadId: ThreadId) {
    const snapshot = yield* projectionSnapshotQuery.getSnapshot();
    const thread = snapshot.threads.find((entry) => entry.id === threadId);
    if (!thread) {
      return { threadId, turns: [] };
    }
    const turnsById = new Map<string, Array<unknown>>();
    for (const message of thread.messages) {
      if (!message.turnId) {
        continue;
      }
      const items = turnsById.get(message.turnId) ?? [];
      items.push({
        role: message.role,
        text: message.text,
        createdAt: message.createdAt,
      });
      turnsById.set(message.turnId, items);
    }
    return {
      threadId,
      turns: Array.from(turnsById.entries()).map(([turnId, items]) => ({
        id: TurnId.makeUnsafe(turnId),
        items,
      })),
    };
  });

  const startSession: OpenRouterAdapterShape["startSession"] = (input) =>
    Effect.gen(function* () {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          }),
        );
      }
      if (!apiKey) {
        return yield* Effect.fail(
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/start",
            detail: "OpenRouter is unavailable. Set `OPENROUTER_API_KEY` and restart.",
          }),
        );
      }

      const existing = sessions.get(input.threadId);
      const session: SessionState = {
        threadId: input.threadId,
        createdAt: existing?.createdAt ?? nowIso(),
        runtimeMode: input.runtimeMode,
        cwd: input.cwd,
        model: input.model,
        status: "ready",
        updatedAt: nowIso(),
        abortController: null,
        activeCommandChild: null,
        pendingApproval: null,
      };
      sessions.set(input.threadId, session);

      yield* emit(baseRuntimeEvent(session, "session.started", { message: "OpenRouter session started" }));
      yield* emit(
        baseRuntimeEvent(session, "thread.started", {
          providerThreadId: input.threadId,
        }),
      );
      yield* emit(
        baseRuntimeEvent(session, "session.state.changed", {
          state: "ready",
          reason: "OpenRouter session ready",
        }),
      );

      return buildSessionRecord(session);
    });

  const sendTurn: OpenRouterAdapterShape["sendTurn"] = (input) =>
    Effect.tryPromise({
      try: async () => {
        if (!apiKey) {
          throw new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/start",
            detail: "OpenRouter is unavailable. Set `OPENROUTER_API_KEY` and restart.",
          });
        }

        const session = requireSession(input.threadId);
        if (!session.cwd) {
          throw new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/start",
            detail: `Thread '${input.threadId}' has no workspace cwd.`,
          });
        }

        const snapshot = await Effect.runPromise(projectionSnapshotQuery.getSnapshot());
        const thread = snapshot.threads.find((entry) => entry.id === input.threadId);
        if (!thread) {
          throw new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/start",
            detail: `Thread '${input.threadId}' was not found.`,
          });
        }

        const turnId = TurnId.makeUnsafe(crypto.randomUUID());
        const model = normalizeString(input.model) ?? session.model ?? thread.model;
        session.model = model;
        session.updatedAt = nowIso();
        session.activeTurnId = turnId;
        session.status = "running";
        session.lastError = undefined;
        session.abortController = new AbortController();

        await Effect.runPromise(
          emit(
            baseRuntimeEvent(
              session,
              "turn.started",
              { model },
              { turnId },
            ),
          ),
        );

        const messages: OpenRouterMessage[] = [
          {
            role: "system",
            content: buildSystemPrompt({
              workspaceRoot: session.cwd,
              runtimeMode: session.runtimeMode,
              interactionMode: input.interactionMode,
            }),
          },
        ];

        for (const message of thread.messages) {
          messages.push(await toOpenRouterMessage(serverConfig.stateDir, message));
        }

        let finalUsage: Record<string, unknown> | undefined;

        for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
          const response = await callOpenRouter({
            apiKey,
            model,
            messages,
            abortSignal: session.abortController.signal,
          });
          finalUsage = response.usage;

          const choice = response.choices?.[0];
          const assistantMessage = choice?.message;
          const assistantText = truncateText(normalizeAssistantContent(assistantMessage?.content), 60_000);
          const toolCalls = (assistantMessage?.tool_calls ?? [])
            .flatMap((toolCall) => {
              const id = normalizeString(toolCall.id);
              const name = normalizeString(toolCall.function?.name);
              const argumentsJson =
                typeof toolCall.function?.arguments === "string"
                  ? toolCall.function.arguments
                  : "{}";
              if (!id || !name) {
                return [];
              }
              return [{ id, function: { name, arguments: argumentsJson } }];
            });

          if (assistantText.length > 0) {
            await Effect.runPromise(
              emit(
                baseRuntimeEvent(
                  session,
                  "content.delta",
                  {
                    streamKind: "assistant_text",
                    delta: assistantText,
                  },
                  { turnId },
                ),
              ),
            );
          }

          if (toolCalls.length === 0) {
            if (assistantText.length > 0) {
              await Effect.runPromise(
                emit(
                  baseRuntimeEvent(
                    session,
                    "item.completed",
                    {
                      itemType: "assistant_message",
                      status: "completed",
                      title: "Assistant message",
                      detail: assistantText,
                    },
                    { turnId },
                  ),
                ),
              );
            }

            const proposedPlan = extractProposedPlanMarkdown(assistantText);
            if (proposedPlan) {
              await Effect.runPromise(
                emit(
                  baseRuntimeEvent(
                    session,
                    "turn.proposed.completed",
                    {
                      planMarkdown: proposedPlan,
                    },
                    { turnId },
                  ),
                ),
              );
            }

            session.status = "ready";
            session.updatedAt = nowIso();
            session.activeTurnId = undefined;
            session.abortController = null;

            await Effect.runPromise(
              emit(
                baseRuntimeEvent(
                  session,
                  "turn.completed",
                  {
                    state: "completed",
                    ...(finalUsage ? { usage: finalUsage } : {}),
                  },
                  { turnId },
                ),
              ),
            );

            return {
              threadId: input.threadId,
              turnId,
            } satisfies ProviderTurnStartResult;
          }

          messages.push({
            role: "assistant",
            content: assistantText,
            tool_calls: toolCalls.map((toolCall) => ({
              id: toolCall.id,
              type: "function",
              function: {
                name: toolCall.function.name,
                arguments: toolCall.function.arguments,
              },
            })),
          });

          for (const toolCall of toolCalls) {
            const itemId = RuntimeItemId.makeUnsafe(toolCall.id);
            await Effect.runPromise(
              emit(
                baseRuntimeEvent(
                  session,
                  "item.started",
                  {
                    itemType:
                      toolCall.function.name === "shell_command"
                        ? "command_execution"
                        : toolCall.function.name === "apply_patch"
                          ? "file_change"
                          : "dynamic_tool_call",
                    status: "inProgress",
                    title: toolCall.function.name,
                    detail: truncateText(toolCall.function.arguments, 300),
                  },
                  { turnId, itemId },
                ),
              ),
            );

            let result: ToolExecutionResult;
            try {
              result = await executeTool(
                {
                  session,
                  turnId,
                  workspaceRoot: session.cwd,
                },
                emit,
                toolCall,
              );
            } catch (cause) {
              const detail =
                cause instanceof Error && cause.message.length > 0 ? cause.message : String(cause);
              await Effect.runPromise(
                emit(
                  baseRuntimeEvent(
                    session,
                    "item.completed",
                    {
                      itemType:
                        toolCall.function.name === "shell_command"
                          ? "command_execution"
                          : toolCall.function.name === "apply_patch"
                            ? "file_change"
                            : "dynamic_tool_call",
                      status: "failed",
                      title: toolCall.function.name,
                      detail,
                    },
                    { turnId, itemId },
                  ),
                ),
              );
              messages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: truncateText(`Tool ${toolCall.function.name} failed: ${detail}`),
              });
              continue;
            }

            await Effect.runPromise(
              emit(
                baseRuntimeEvent(
                  session,
                  "item.completed",
                  {
                    itemType: result.itemType,
                    status: "completed",
                    title: result.title,
                    ...(result.detail ? { detail: result.detail } : {}),
                  },
                  { turnId, itemId },
                ),
              ),
            );

            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: truncateText(result.output),
            });
          }
        }

        throw new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/start",
          detail: "OpenRouter tool loop exceeded the maximum iteration limit.",
        });
      },
      catch: async (cause) => {
        const session = sessions.get(input.threadId);
        if (session) {
          const isAbort = cause instanceof DOMException && cause.name === "AbortError";
          session.activeTurnId = undefined;
          session.abortController = null;
          session.updatedAt = nowIso();

          if (isAbort) {
            session.status = "ready";
            await Effect.runPromise(
              emit(
                baseRuntimeEvent(session, "turn.aborted", {
                  reason: "Turn interrupted",
                }),
              ),
            ).catch(() => undefined);
          } else {
            const detail =
              cause instanceof Error && cause.message.length > 0 ? cause.message : String(cause);
            session.status = "error";
            session.lastError = detail;
            await Effect.runPromise(
              emit(
                baseRuntimeEvent(session, "runtime.error", {
                  message: detail,
                  class: "provider_error",
                }),
              ),
            ).catch(() => undefined);
          }
        }

        if (
          cause instanceof ProviderAdapterRequestError ||
          cause instanceof ProviderAdapterSessionNotFoundError
        ) {
          return cause;
        }
        return new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/start",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        });
      },
    });

  const interruptTurn: OpenRouterAdapterShape["interruptTurn"] = (threadId) =>
    Effect.sync(() => {
      const session = requireSession(threadId);
      session.abortController?.abort();
      session.activeCommandChild?.kill("SIGTERM");
      session.activeCommandChild = null;
      if (session.pendingApproval) {
        session.pendingApproval.resolve("cancel");
        session.pendingApproval = null;
      }
    });

  const respondToRequest: OpenRouterAdapterShape["respondToRequest"] = (
    threadId,
    requestId,
    decision,
  ) =>
    Effect.sync(() => {
      const session = requireSession(threadId);
      if (!session.pendingApproval || session.pendingApproval.requestId !== requestId) {
        throw new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "request/respond",
          detail: `Unknown pending approval request '${requestId}'.`,
        });
      }
      session.pendingApproval.resolve(decision);
    });

  const respondToUserInput: OpenRouterAdapterShape["respondToUserInput"] = (
    _threadId,
    requestId,
    _answers,
  ) =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "user-input/respond",
        detail: `OpenRouter does not support structured user input requests in v1 (request '${requestId}').`,
      }),
    );

  const stopSession: OpenRouterAdapterShape["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      const session = requireSession(threadId);
      session.abortController?.abort();
      session.activeCommandChild?.kill("SIGTERM");
      if (session.pendingApproval) {
        session.pendingApproval.resolve("cancel");
        session.pendingApproval = null;
      }
      sessions.delete(threadId);
      yield* emit(
        baseRuntimeEvent(session, "session.exited", {
          reason: "Session stopped",
          recoverable: true,
          exitKind: "graceful",
        }),
      );
    });

  const listSessions: OpenRouterAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values()).map(buildSessionRecord));

  const hasSession: OpenRouterAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => sessions.has(threadId));

  const readThread: OpenRouterAdapterShape["readThread"] = (threadId) => readThreadSnapshot(threadId);

  const rollbackThread: OpenRouterAdapterShape["rollbackThread"] = (threadId, numTurns) =>
    Effect.gen(function* () {
      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return yield* Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          }),
        );
      }
      return yield* readThreadSnapshot(threadId);
    });

  const stopAll: OpenRouterAdapterShape["stopAll"] = () =>
    Effect.gen(function* () {
      const threadIds = Array.from(sessions.keys());
      yield* Effect.forEach(threadIds, (threadId) => stopSession(threadId)).pipe(Effect.asVoid);
    });

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
      sessionRecovery: "stateless",
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    streamEvents: Stream.fromQueue(runtimeEventQueue),
  } satisfies OpenRouterAdapterShape;
});

export const OpenRouterAdapterLive = Layer.effect(OpenRouterAdapter, makeOpenRouterAdapter);
