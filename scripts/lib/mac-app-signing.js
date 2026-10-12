const { spawnSync } = require("node:child_process");

function parseMacAppSignature(details) {
  const read = (key) => details.match(new RegExp(`^${key}=(.+)$`, "mu"))?.[1]?.trim() || "";
  return {
    identifier: read("Identifier"),
    teamIdentifier: read("TeamIdentifier"),
    signature: read("Signature"),
    authorities: [...details.matchAll(/^Authority=(.+)$/gmu)].map((match) => match[1].trim()),
    designatedRequirement: details.match(/^(?:#\s*)?designated => (.+)$/mu)?.[1]?.trim() || ""
  };
}

function requirementTokens(requirement) {
  const input = requirement.replace(/\/\*[\s\S]*?\*\//gu, " ");
  const tokens = [];
  let atom = "";
  let quoted = false;
  let escaped = false;
  const flush = () => {
    if (atom.trim()) tokens.push({ atom: atom.trim() });
    atom = "";
  };
  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (quoted) {
      atom += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      atom += character;
      continue;
    }
    if (character === "(" || character === ")") {
      flush();
      tokens.push(character);
      continue;
    }
    const logical = (index === 0 || /\s|[()]/u.test(input[index - 1]))
      ? input.slice(index).match(/^(and|or|not)(?=\s|[()]|$)/u)
      : null;
    if (logical) {
      flush();
      tokens.push(logical[1]);
      index += logical[1].length - 1;
      continue;
    }
    atom += character;
  }
  if (quoted) throw new Error("Invalid macOS designated requirement");
  flush();
  return tokens;
}

function requirementIdentityTerms(requirement, bundleId, teamId) {
  const tokens = requirementTokens(requirement);
  let index = 0;
  const atomTerms = (atom) => {
    const identifier = atom.match(/^identifier\s+("(?:\\.|[^"\\])*")$/u);
    if (identifier && JSON.parse(identifier[1]) === bundleId) return 1;
    if (/^anchor\s+apple\s+generic$/u.test(atom)) return 2;
    const publisher = atom.match(/^certificate\s+leaf\[subject\.OU\]\s*=\s*("(?:\\.|[^"\\])*"|[A-Z0-9]+)$/u);
    if (publisher) {
      const value = publisher[1].startsWith('"') ? JSON.parse(publisher[1]) : publisher[1];
      if (value === teamId) return 4;
    }
    return 0;
  };
  const primary = () => {
    const token = tokens[index++];
    if (token === "(") {
      const terms = expression();
      if (tokens[index++] !== ")") throw new Error("Invalid macOS designated requirement");
      return terms;
    }
    if (token === "not") {
      primary();
      return 0;
    }
    if (!token || typeof token !== "object") throw new Error("Invalid macOS designated requirement");
    return atomTerms(token.atom);
  };
  const conjunction = () => {
    let terms = primary();
    while (tokens[index] === "and") {
      index++;
      terms |= primary();
    }
    return terms;
  };
  const expression = () => {
    let terms = conjunction();
    while (tokens[index] === "or") {
      index++;
      // Every alternative must retain the same Apple, publisher and app identity.
      terms &= conjunction();
    }
    return terms;
  };
  const terms = expression();
  if (index !== tokens.length) throw new Error("Invalid macOS designated requirement");
  return terms;
}

function assertMacReleaseSignature(signature, { expectedBundleId, expectedTeamId } = {}) {
  if (typeof expectedBundleId !== "string" || !expectedBundleId.trim()) {
    throw new Error("macOS release signature verification requires the brand bundle identifier");
  }
  if (signature.signature === "adhoc" || !signature.authorities.some((authority) => authority.startsWith("Developer ID Application:"))) {
    throw new Error("macOS releases require a Developer ID Application signature; ad-hoc and local development signatures are not allowed");
  }
  if (!/^[A-Z0-9]+$/u.test(signature.teamIdentifier)) {
    throw new Error("macOS release signature is missing its Apple TeamIdentifier");
  }
  if (signature.identifier !== expectedBundleId) {
    throw new Error("macOS release signature does not match the brand bundle identifier");
  }
  if (expectedTeamId && signature.teamIdentifier !== expectedTeamId) {
    throw new Error("macOS release signature does not match the expected Apple publisher");
  }
  const requirement = signature.designatedRequirement;
  if (!requirement || /\bcdhash\b/iu.test(requirement)) {
    throw new Error("macOS release designated requirement must retain publisher and bundle identity across versions, without a cdhash constraint");
  }
  if (requirementIdentityTerms(requirement, expectedBundleId, signature.teamIdentifier) !== 7) {
    throw new Error("macOS release designated requirement must require the Apple anchor, publisher and brand bundle identifier in every alternative");
  }
  return signature;
}

function runCodesign(args) {
  const result = spawnSync("/usr/bin/codesign", args, {
    encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error) throw result.error;
  const details = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status !== 0) throw new Error(`macOS release codesign verification failed\n${details.trim()}`);
  return details;
}

function verifyMacReleaseApp(appPath, { expectedBundleId, expectedTeamId, runCodesign: run = runCodesign } = {}) {
  if (typeof expectedBundleId !== "string" || !expectedBundleId.trim()) {
    throw new Error("macOS release signature verification requires the brand bundle identifier");
  }
  run(["--verify", "--deep", "--strict", appPath]);
  const signature = assertMacReleaseSignature(parseMacAppSignature(run([
    "--display", "--verbose=4", "-r-", appPath
  ])), { expectedBundleId, expectedTeamId });
  // Test the actual certificate chain as well as the reported metadata. This
  // verifies a requirement; it does not replace or weaken the app's own DR.
  const publisherRequirement = [
    `identifier ${JSON.stringify(expectedBundleId)}`,
    "anchor apple generic",
    "certificate 1[field.1.2.840.113635.100.6.2.6]",
    "certificate leaf[field.1.2.840.113635.100.6.1.13]",
    `certificate leaf[subject.OU] = ${JSON.stringify(signature.teamIdentifier)}`
  ].join(" and ");
  run(["--verify", "--strict", "-R", `=${publisherRequirement}`, appPath]);
  return signature;
}

exports.parseMacAppSignature = parseMacAppSignature;
exports.assertMacReleaseSignature = assertMacReleaseSignature;
exports.verifyMacReleaseApp = verifyMacReleaseApp;
