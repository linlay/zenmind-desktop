import fs from "node:fs";
import { BackgroundImageError } from "./appearance-images";

export function readBoundedFile(filePath: string, limit: number) {
  if (!fs.lstatSync(filePath).isFile()) throw new BackgroundImageError("invalidImage");
  const fd = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new BackgroundImageError("invalidImage");
    if (stat.size > limit) throw new BackgroundImageError("imageTooLarge");
    const buffer = Buffer.alloc(stat.size + 1);
    let read = 0;
    while (read < buffer.length) {
      const count = fs.readSync(fd, buffer, read, buffer.length - read, null);
      if (!count) break;
      read += count;
    }
    if (read > stat.size) throw new BackgroundImageError("imageTooLarge");
    return buffer.subarray(0, read);
  } finally { fs.closeSync(fd); }
}
