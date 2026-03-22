import { execFileSync } from "node:child_process";
import path from "node:path";

import type { TerminalShellKind, TerminalShellOption } from "@t3tools/contracts";

import { isCommandAvailable } from "../open";

function defaultShellCommand(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | null {
  if (platform === "win32") {
    return env.ComSpec?.trim() || "cmd.exe";
  }
  return env.SHELL?.trim() || "bash";
}

function detectShellKind(command: string): TerminalShellKind {
  const basename = path.basename(command).toLowerCase();
  if (basename === "pwsh" || basename === "pwsh.exe") return "pwsh";
  if (basename === "powershell" || basename === "powershell.exe") return "powershell";
  if (basename === "cmd" || basename === "cmd.exe") return "cmd";
  if (basename === "bash" || basename === "bash.exe") return "bash";
  if (basename === "zsh") return "zsh";
  if (basename === "sh") return "sh";
  if (basename === "fish") return "fish";
  if (basename === "nu" || basename === "nu.exe") return "nushell";
  return "unknown";
}

function shellLabel(kind: TerminalShellKind, command: string): string {
  switch (kind) {
    case "pwsh":
      return "PowerShell";
    case "powershell":
      return "Windows PowerShell";
    case "cmd":
      return "Command Prompt";
    case "bash":
      return "bash";
    case "zsh":
      return "zsh";
    case "sh":
      return "sh";
    case "fish":
      return "fish";
    case "nushell":
      return "nushell";
    case "unknown":
      return path.basename(command) || command;
  }
}

function normalizeShellCommand(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.includes("\\") || trimmed.includes(".exe")) {
    return trimmed;
  }
  if (trimmed.includes("/")) {
    return trimmed;
  }
  if (trimmed.endsWith(".cmd") || trimmed.endsWith(".bat")) {
    return trimmed;
  }
  const firstToken = trimmed.split(/\s+/g)[0]?.trim();
  return firstToken ? firstToken.replace(/^['"]|['"]$/g, "") : null;
}

function stripWrappingQuotes(value: string): string {
  return value.replace(/^"+|"+$/g, "");
}

function resolveWindowsPathEnvironmentVariable(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? "";
}

function resolveWindowsPathExtensions(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const rawValue = env.PATHEXT;
  const fallback = [".COM", ".EXE", ".BAT", ".CMD"];
  if (!rawValue) return fallback;

  const parsed = rawValue
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.startsWith(".") ? entry.toUpperCase() : `.${entry.toUpperCase()}`));
  return parsed.length > 0 ? Array.from(new Set(parsed)) : fallback;
}

function resolveWindowsCommandPathsFromEnv(
  command: string,
  env: NodeJS.ProcessEnv,
): ReadonlyArray<string> {
  const normalizedCommand = command.trim();
  if (normalizedCommand.length === 0) return [];
  if (normalizedCommand.includes("\\") || normalizedCommand.includes("/")) {
    return [normalizedCommand];
  }

  const pathValue = resolveWindowsPathEnvironmentVariable(env);
  if (pathValue.length === 0) return [];

  const hasKnownExtension = [".exe", ".cmd", ".bat", ".com"].some((extension) =>
    normalizedCommand.toLowerCase().endsWith(extension),
  );
  const candidateNames = hasKnownExtension
    ? [normalizedCommand]
    : resolveWindowsPathExtensions(env).map((extension) => `${normalizedCommand}${extension}`);

  const resolved: string[] = [];
  for (const entry of pathValue.split(";")) {
    const baseDir = stripWrappingQuotes(entry.trim());
    if (baseDir.length === 0) continue;
    for (const candidateName of candidateNames) {
      const candidatePath = path.join(baseDir, candidateName);
      if (isCommandAvailable(candidatePath, { platform: "win32", env })) {
        resolved.push(candidatePath);
      }
    }
  }

  return resolved;
}

function resolveWindowsCommandPaths(
  command: string,
  env: NodeJS.ProcessEnv,
): ReadonlyArray<string> {
  const normalizedCommand = normalizeShellCommand(command);
  if (!normalizedCommand) return [];
  if (normalizedCommand.includes("\\") || normalizedCommand.includes("/")) {
    return [normalizedCommand];
  }

  const resolvedFromEnv = resolveWindowsCommandPathsFromEnv(normalizedCommand, env);

  try {
    const output = execFileSync("where.exe", [normalizedCommand], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return Array.from(
      new Set([
        ...output
          .split(/\r?\n/g)
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
        ...resolvedFromEnv,
      ]),
    );
  } catch {
    return resolvedFromEnv;
  }
}

function isWindowsBashShim(candidate: string): boolean {
  const normalized = candidate.replaceAll("/", "\\").toLowerCase();
  return (
    normalized.endsWith("\\windows\\system32\\bash.exe") ||
    normalized.endsWith("\\appdata\\local\\microsoft\\windowsapps\\bash.exe")
  );
}

function resolveWindowsShellCandidates(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const resolveCommandOrPath = (command: string | null | undefined): ReadonlyArray<string> => {
    const normalized = normalizeShellCommand(command);
    if (!normalized) return [];
    return resolveWindowsCommandPaths(normalized, env);
  };

  const knownGitBashLocations = [
    env["ProgramFiles"] ? path.join(env["ProgramFiles"], "Git", "bin", "bash.exe") : null,
    env["ProgramFiles"] ? path.join(env["ProgramFiles"], "Git", "usr", "bin", "bash.exe") : null,
    env["ProgramFiles(x86)"] ? path.join(env["ProgramFiles(x86)"], "Git", "bin", "bash.exe") : null,
    env["ProgramFiles(x86)"]
      ? path.join(env["ProgramFiles(x86)"], "Git", "usr", "bin", "bash.exe")
      : null,
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe") : null,
  ].filter((candidate): candidate is string => candidate !== null);

  const resolvedPwsh = resolveWindowsCommandPaths("pwsh.exe", env);
  const resolvedPowerShell = resolveWindowsCommandPaths("powershell.exe", env);
  const resolvedCmd = resolveWindowsCommandPaths("cmd.exe", env);
  const resolvedNu = resolveWindowsCommandPaths("nu.exe", env);
  const resolvedBash = resolveWindowsCommandPaths("bash.exe", env).filter(
    (candidate) => !isWindowsBashShim(candidate),
  );

  return [
    ...resolveCommandOrPath(defaultShellCommand("win32", env)),
    ...resolveCommandOrPath(env.ComSpec),
    ...resolvedPwsh,
    ...resolvedPowerShell,
    ...resolvedCmd,
    ...knownGitBashLocations,
    ...resolvedBash,
    ...resolvedNu,
  ].filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );
}

export function resolveAvailableTerminalShells(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): TerminalShellOption[] {
  const candidates =
    platform === "win32"
      ? resolveWindowsShellCandidates(env)
      : [
          normalizeShellCommand(defaultShellCommand(platform, env)),
          normalizeShellCommand(env.SHELL),
          "/bin/zsh",
          "/bin/bash",
          "/bin/sh",
          "zsh",
          "bash",
          "sh",
          "fish",
          "nu",
        ];

  const defaultCommand =
    platform === "win32"
      ? (resolveWindowsCommandPaths(defaultShellCommand(platform, env) ?? "", env)[0] ??
        normalizeShellCommand(defaultShellCommand(platform, env)))
      : normalizeShellCommand(defaultShellCommand(platform, env));
  const seen = new Set<string>();
  const shells: TerminalShellOption[] = [];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalizedKey = platform === "win32" ? candidate.toLowerCase() : candidate;
    if (seen.has(normalizedKey)) continue;
    if (!isCommandAvailable(candidate, { platform, env })) continue;
    seen.add(normalizedKey);
    const kind = detectShellKind(candidate);
    shells.push({
      id: normalizedKey,
      label: shellLabel(kind, candidate),
      path: candidate,
      kind,
      isDefault:
        defaultCommand !== null &&
        (platform === "win32"
          ? normalizedKey === defaultCommand.toLowerCase()
          : normalizedKey === defaultCommand),
    });
  }

  if (shells.length > 0 && !shells.some((shell) => shell.isDefault)) {
    const firstShell = shells[0];
    if (firstShell) {
      shells[0] = {
        ...firstShell,
        isDefault: true,
      };
    }
  }

  return shells;
}
