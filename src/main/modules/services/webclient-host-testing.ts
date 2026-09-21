import { createRuntimeConfigScript } from "./webclient-host-config";
import { hasWebSocketAccessToken } from "./webclient-proxy-auth";
import { isSseQueryRequest } from "./webclient-proxy-policy";
import { parseRequestPath } from "./webclient-http-utils";
import { resolveFrontendRequest } from "./webclient-static-files";

export const __testInternals = {
  createRuntimeConfigScript,
  hasWebSocketAccessToken,
  isSseQueryRequest,
  parseRequestPath,
  resolveFrontendRequest
};
