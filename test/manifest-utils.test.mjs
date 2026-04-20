import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { normalizeManifest } = require("../dist-electron/main/manifest-utils.js");

test("normalizeManifest preserves extended desktop, web, and frontend fields", () => {
  const definition = normalizeManifest({
    id: "extended-service",
    name: "Extended Service",
    kind: "builtin",
    version: "v1.0.0",
    description: "fixture",
    frontend: {
      mode: "standalone",
      hideFromNav: true,
      embedPath: "/embedded",
      embedParams: {
        desktopApp: "1"
      }
    },
    scripts: {
      start: "start.sh",
      stop: "stop.sh"
    },
    runtime: {
      requiredPaths: ["manifest.json"]
    },
    web: {
      routePath: "/",
      portEnvKey: "BIND_ADDR",
      defaultPort: 9000,
      portFormat: "host:port"
    },
    desktop: {
      autoStart: "optional",
      displayOrder: 4,
      envBindings: [
        {
          key: "BASE_URL",
          fromService: "agent-platform",
          template: "http://127.0.0.1:{{port}}",
          onlyIfDefault: true,
          defaults: ["http://localhost:11949"]
        }
      ],
      systemRequirements: ["docker|podman"]
    }
  });

  assert.equal(definition.frontend.hideFromNav, true);
  assert.equal(definition.frontend.embedPath, "/embedded");
  assert.deepEqual(definition.frontend.embedParams, { desktopApp: "1" });
  assert.equal(definition.web.portFormat, "host:port");
  assert.equal(definition.desktop.autoStart, "optional");
  assert.equal(definition.desktop.displayOrder, 4);
  assert.deepEqual(definition.desktop.systemRequirements, ["docker|podman"]);
  assert.deepEqual(definition.desktop.envBindings, [
    {
      key: "BASE_URL",
      fromService: "agent-platform",
      template: "http://127.0.0.1:{{port}}",
      value: undefined,
      onlyIfDefault: true,
      defaults: ["http://localhost:11949"]
    }
  ]);
});

test("normalizeManifest keeps boolean autoStart values and defaults web.portFormat to number", () => {
  const definition = normalizeManifest({
    id: "defaulted-service",
    name: "Defaulted Service",
    kind: "plugin",
    version: "v1.0.0",
    description: "fixture",
    frontend: {
      mode: "none"
    },
    scripts: {
      start: "start.sh",
      stop: "stop.sh"
    },
    runtime: {
      requiredPaths: ["manifest.json"]
    },
    web: {
      routePath: "",
      portEnvKey: "PORT",
      defaultPort: 9300
    },
    desktop: {
      autoStart: true
    }
  });

  assert.equal(definition.desktop.autoStart, true);
  assert.equal(definition.web.portFormat, "number");
});
