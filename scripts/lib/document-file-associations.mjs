import fs from "node:fs";

export const DESKTOP_DOCUMENT_FILE_TYPES = JSON.parse(
  fs.readFileSync(new URL("../../src/shared/desktop-document-file-types.json", import.meta.url), "utf8")
);

export function macDocumentFileAssociations() {
  return DESKTOP_DOCUMENT_FILE_TYPES.map(({ name, extensions }) => ({
    ext: [...extensions],
    name,
    role: "Viewer",
    rank: "Alternate"
  }));
}

export function macDocumentTypes(iconFile) {
  return macDocumentFileAssociations().map(({ ext, name, role, rank }) => ({
    CFBundleTypeExtensions: ext,
    CFBundleTypeName: name,
    CFBundleTypeRole: role,
    LSHandlerRank: rank,
    ...(iconFile ? { CFBundleTypeIconFile: iconFile } : {})
  }));
}
