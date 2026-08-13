import test from "node:test";
import assert from "node:assert/strict";

const { revealPathInFileManager } = await import(
  "../dist-electron/main/reveal-path.js"
);

for (const [platform, targetPath] of [
  ["darwin", "/workspace/project"],
  ["win32", "C:\\workspace\\project"]
]) {
  test(`directory reveal selects the workspace on ${platform}`, async () => {
    const revealed = [];
    const opened = [];
    const result = await revealPathInFileManager(targetPath, {
      targetType: "directory",
      directoryAction: "reveal"
    }, {
      platform,
      existsSync: () => true,
      statSync: () => ({ isDirectory: () => true }),
      showItemInFolder: (value) => revealed.push(value),
      openPath: async (value) => {
        opened.push(value);
        return "";
      }
    });

    assert.equal(result.ok, true);
    assert.deepEqual(revealed, [targetPath]);
    assert.deepEqual(opened, []);
  });
}

test("the existing directory open behavior remains unchanged", async () => {
  const revealed = [];
  const opened = [];
  const targetPath = "/workspace/project";
  const result = await revealPathInFileManager(targetPath, {
    targetType: "directory"
  }, {
    platform: "darwin",
    existsSync: () => true,
    statSync: () => ({ isDirectory: () => true }),
    showItemInFolder: (value) => revealed.push(value),
    openPath: async (value) => {
      opened.push(value);
      return "";
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(revealed, []);
  assert.deepEqual(opened, [targetPath]);
});
