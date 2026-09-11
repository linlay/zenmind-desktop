import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeDocumentWorkspaceRequestPath, resolveWorkPanelDocumentFromWorkspace } from "../dist-electron/main/modules/work-panel/document-workspace-path.js";
import { resolveWorkPanelLocalFileFromWorkspace } from "../dist-electron/main/modules/work-panel/local-files.js";

test("document links normalize macOS, Windows drive and UNC paths within the workspace", () => {
  for (const [platform, root, target, expected] of [
    ["darwin", "/Users/linlay/Project/cligrep/cli-excelx", "/Users/linlay/Project/cligrep/cli-excelx/README.md", "README.md"],
    ["darwin", "/project", "/project/docs with spaces/README.md", "docs with spaces/README.md"],
    ["darwin", "/project", "/project-other/README.md", ""],
    ["darwin", "/project", "/project/../secret.md", ""],
    ["win32", "C:\\Project", "c:\\project\\README.md", "README.md"],
    ["win32", "C:\\Project", "C:/Project/docs with spaces/README.md", "docs with spaces/README.md"],
    ["win32", "C:\\Project", "D:\\Project\\README.md", ""],
    ["win32", "C:\\Project", "/Project/README.md", ""],
    ["win32", "\\\\server\\share\\project", "//server/share/project/README.md", "README.md"],
    ["win32", "\\\\server\\share\\project", "//server/other/project/README.md", ""],
  ]) assert.equal(normalizeDocumentWorkspaceRequestPath(root, target, platform), expected, target);
  for (const invalid of ["../secret.md", "file:///project/README.md", "README.md\u0000", ""]) {
    assert.equal(normalizeDocumentWorkspaceRequestPath("/project", invalid, "darwin"), "");
  }
});

test("absolute README document links resolve while local-file actions remain relative-only", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "workpanel-document-"));
  const workspace = path.join(temp, "project");
  fs.mkdirSync(workspace);
  const readme = path.join(workspace, "README.md");
  fs.writeFileSync(readme, "# README");
  fs.writeFileSync(path.join(temp, "outside.md"), "outside");
  try {
    const result = resolveWorkPanelDocumentFromWorkspace(workspace, readme);
    assert.equal(result.ok, true);
    assert.equal(result.relativePath, "README.md");
    assert.equal(result.filePath, fs.realpathSync.native(readme));
    assert.equal(resolveWorkPanelDocumentFromWorkspace(workspace, "README.md").ok, true);
    assert.equal(resolveWorkPanelLocalFileFromWorkspace(workspace, readme).code, "invalid_path");
    assert.equal(resolveWorkPanelDocumentFromWorkspace(workspace, path.join(temp, "outside.md")).ok, false);
    assert.equal(resolveWorkPanelDocumentFromWorkspace(workspace, path.join(workspace, "missing.md")).code, "file_unavailable");
    if (process.platform !== "win32") {
      const linked = path.join(workspace, "linked.md");
      fs.symlinkSync(path.join(temp, "outside.md"), linked);
      assert.equal(resolveWorkPanelDocumentFromWorkspace(workspace, linked).code, "path_outside_workspace");
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
