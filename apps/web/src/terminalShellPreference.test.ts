import { describe, expect, it } from "vitest";

import { buildTerminalShellPreference } from "./terminalShellPreference";

const availableShells = [
  {
    id: "pwsh.exe",
    label: "PowerShell",
    path: "pwsh.exe",
    kind: "pwsh" as const,
    isDefault: true,
  },
];

describe("buildTerminalShellPreference", () => {
  it("omits shell fields for default mode", () => {
    expect(
      buildTerminalShellPreference(
        {
          terminalShellMode: "default",
          terminalShellId: "",
          terminalCustomShellPath: "",
        },
        availableShells,
      ),
    ).toEqual({});
  });

  it("builds detected shell payloads when the shell is still available", () => {
    expect(
      buildTerminalShellPreference(
        {
          terminalShellMode: "detected",
          terminalShellId: "pwsh.exe",
          terminalCustomShellPath: "",
        },
        availableShells,
      ),
    ).toEqual({
      shellType: "detected",
      shellId: "pwsh.exe",
    });
  });

  it("degrades stale detected shell selections to default", () => {
    expect(
      buildTerminalShellPreference(
        {
          terminalShellMode: "detected",
          terminalShellId: "missing-shell",
          terminalCustomShellPath: "",
        },
        availableShells,
      ),
    ).toEqual({});
  });

  it("builds custom shell payloads when a path is configured", () => {
    expect(
      buildTerminalShellPreference(
        {
          terminalShellMode: "custom",
          terminalShellId: "",
          terminalCustomShellPath: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        },
        availableShells,
      ),
    ).toEqual({
      shellType: "custom",
      shellPath: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    });
  });
});
