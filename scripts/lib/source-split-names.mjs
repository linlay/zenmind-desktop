// Check source basenames, not directory names or protocol versions (v1, v2).
export function hasNumberedSourceSplitName(file) {
  const basename = file.replaceAll("\\", "/").split("/").at(-1);
  if (!/\.(?:ts|tsx)$/u.test(basename) || basename.endsWith(".d.ts")) return false;
  const stem = basename.replace(/\.(?:ts|tsx)$/u, "");
  return /(?:^|[._-])(?:part|methods|operations)[._-]?\d+(?=[._-]|$)/iu.test(stem) ||
    /(?:^|[._-])\d+(?=[._-]|$)/u.test(stem);
}
