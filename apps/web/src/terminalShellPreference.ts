import type { AppSettings } from "./appSettings";
import type {
  TerminalOpenInput,
  TerminalRestartInput,
  TerminalShellOption,
} from "@t3tools/contracts";

type TerminalShellPreference = Partial<{
  shellType: "detected" | "custom";
  shellId: string;
  shellPath: string;
}>;

export function buildTerminalShellPreference(
  settings: Pick<AppSettings, "terminalShellMode" | "terminalShellId" | "terminalCustomShellPath">,
  availableShells: ReadonlyArray<TerminalShellOption>,
): TerminalShellPreference {
  if (settings.terminalShellMode === "detected") {
    const shellId = settings.terminalShellId.trim();
    if (shellId.length === 0 || !availableShells.some((shell) => shell.id === shellId)) {
      return {};
    }
    return {
      shellType: "detected",
      shellId,
    };
  }

  if (settings.terminalShellMode === "custom") {
    const shellPath = settings.terminalCustomShellPath.trim();
    if (shellPath.length === 0) {
      return {};
    }
    return {
      shellType: "custom",
      shellPath,
    };
  }

  return {};
}

export function applyTerminalShellPreference<T extends TerminalOpenInput | TerminalRestartInput>(
  input: T,
  settings: Pick<AppSettings, "terminalShellMode" | "terminalShellId" | "terminalCustomShellPath">,
  availableShells: ReadonlyArray<TerminalShellOption>,
): T {
  return {
    ...input,
    ...buildTerminalShellPreference(settings, availableShells),
  };
}
