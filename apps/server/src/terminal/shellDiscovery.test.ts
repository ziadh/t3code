import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveAvailableTerminalShells } from "./shellDiscovery";

describe("resolveAvailableTerminalShells", () => {
  it("detects distinct shells on Windows and marks a default", () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-shells-win-"));
    const cmdPath = path.join(binDir, "cmd.exe");
    const pwshPath = path.join(binDir, "pwsh.exe");
    fs.writeFileSync(cmdPath, "", "utf8");
    fs.writeFileSync(pwshPath, "", "utf8");

    const shells = resolveAvailableTerminalShells("win32", {
      PATH: binDir,
      ComSpec: "cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    });

    expect(shells.some((shell) => shell.path === cmdPath && shell.isDefault)).toBe(true);
    expect(shells.some((shell) => shell.path === pwshPath)).toBe(true);
    expect(new Set(shells.map((shell) => shell.id)).size).toBe(shells.length);

    fs.rmSync(binDir, { recursive: true, force: true });
  });

  it("filters Windows bash shim paths from detected shells", () => {
    const shells = resolveAvailableTerminalShells("win32", {
      PATH: "C:\\Windows\\System32;C:\\Users\\test\\AppData\\Local\\Microsoft\\WindowsApps",
      ComSpec: "cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    });

    expect(
      shells.some(
        (shell) =>
          shell.path.toLowerCase().endsWith("\\windows\\system32\\bash.exe") ||
          shell.path.toLowerCase().endsWith("\\appdata\\local\\microsoft\\windowsapps\\bash.exe"),
      ),
    ).toBe(false);
  });

  it("includes the posix default shell and collapses duplicates", () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-shells-posix-"));
    const bashPath = path.join(binDir, "bash");
    fs.writeFileSync(bashPath, "#!/bin/sh\n", "utf8");
    fs.chmodSync(bashPath, 0o755);

    const shells = resolveAvailableTerminalShells("linux", {
      PATH: `${binDir}:/bin:/usr/bin`,
      SHELL: bashPath,
    });

    expect(shells.some((shell) => shell.path === bashPath && shell.isDefault)).toBe(true);
    expect(shells.filter((shell) => shell.path === bashPath)).toHaveLength(1);

    fs.rmSync(binDir, { recursive: true, force: true });
  });
});
