import test from "node:test";
import assert from "node:assert/strict";

const {
  hideWindowsForShutdown,
  runWithShutdownDeadline,
  prepareQuitUi
} = await import("../dist-electron/main/shutdown-cleanup.js");

test("shutdown cleanup deadline lets app quit continue when cleanup hangs", async () => {
  const startedAt = Date.now();
  const result = await runWithShutdownDeadline(
    () => new Promise(() => {}),
    {
      timeoutMs: 30,
      now: Date.now,
      consoleWarn: () => {}
    }
  );

  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - startedAt < 500);
});

test("shutdown hides visible app windows before cleanup continues", () => {
  const hidden = [];
  const mainWindow = {
    isDestroyed: () => false,
    isVisible: () => true,
    hide: () => hidden.push("main")
  };
  const desktopPetWindow = {
    isDestroyed: () => false,
    isVisible: () => true,
    hide: () => hidden.push("pet")
  };

  hideWindowsForShutdown({ mainWindow, desktopPetWindow });

  assert.deepEqual(hidden, ["main", "pet"]);
});

test("prepareQuitUi hides all visible windows and destroys the tray", () => {
  const hidden = [];
  let trayDestroyed = false;
  const mockWindows = [
    {
      isDestroyed: () => false,
      isVisible: () => true,
      hide: () => hidden.push("win1")
    },
    {
      isDestroyed: () => true,
      isVisible: () => true,
      hide: () => hidden.push("win2")
    },
    {
      isDestroyed: () => false,
      isVisible: () => false,
      hide: () => hidden.push("win3")
    },
    {
      isDestroyed: () => false,
      isVisible: () => true,
      hide: () => hidden.push("win4")
    }
  ];

  prepareQuitUi({
    getAllWindows: () => mockWindows,
    destroyTray: () => {
      trayDestroyed = true;
    }
  });

  assert.deepEqual(hidden, ["win1", "win4"]);
  assert.equal(trayDestroyed, true);
});

