export const DESKTOP_DOCUMENT_FILE_TYPES = [
  { id: "Markdown", name: "Markdown Document", extensions: ["md", "markdown"] },
  { id: "HTML", name: "HTML Document", extensions: ["html", "htm"] }
];

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
