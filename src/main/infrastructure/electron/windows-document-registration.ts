import path from "node:path";
import documentFileTypes from "../../../shared/desktop-document-file-types.json";

type RegistrationOptions = {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  appId: string;
  productName: string;
  executablePath: string;
};

export type WindowsDocumentRegistry = {
  readString(key: string, name: string): string | undefined;
  writeString(key: string, name: string, value: string): void;
  notifyAssociationsChanged(): void;
  dispose(): void;
};

export type WindowsDocumentRegistrationResult = {
  status: "skipped" | "unchanged" | "registered";
  registeredTypes: string[];
  preservedTypes: string[];
};

function checkRegistryStatus(status: number, operation: string) {
  if (status !== 0) throw new Error(`Windows document registration ${operation} failed (${status})`);
}

// Use the interactive process user's hive, including when the program files
// were provisioned by an administrator. No elevation or shell commands needed.
function openWindowsDocumentRegistry(): WindowsDocumentRegistry {
  const koffi = require("koffi") as typeof import("koffi");
  const registry = koffi.load("advapi32.dll");
  const shell = koffi.load("shell32.dll");
  const openCurrentUser = registry.func("int32 __stdcall RegOpenCurrentUser(uint32 access, _Out_ void **key)");
  const getValue = registry.func("int32 __stdcall RegGetValueW(void *key, str16 subKey, str16 name, uint32 flags, _Out_ uint32 *type, void *data, _Inout_ uint32 *size)");
  const createKey = registry.func("int32 __stdcall RegCreateKeyExW(void *key, str16 subKey, uint32 reserved, void *className, uint32 options, uint32 access, void *security, _Out_ void **result, void *disposition)");
  const setValue = registry.func("int32 __stdcall RegSetValueExW(void *key, str16 name, uint32 reserved, uint32 type, void *data, uint32 size)");
  const closeKey = registry.func("int32 __stdcall RegCloseKey(void *key)");
  const notify = shell.func("void __stdcall SHChangeNotify(int32 eventId, uint32 flags, void *item1, void *item2)");
  const currentUser: unknown[] = [null];
  checkRegistryStatus(openCurrentUser(0x20019, currentUser), "open current user"); // KEY_READ
  return {
    readString(key, name) {
      const data = Buffer.alloc(65_536);
      const size = [data.length];
      const type = [0];
      // OpenWithProgids permits both empty REG_NONE and REG_SZ values.
      const status = getValue(currentUser[0], key, name, 0x3, type, data, size);
      if (status === 2) return undefined; // ERROR_FILE_NOT_FOUND
      checkRegistryStatus(status, "read value");
      if (type[0] === 0 && size[0] === 0) return "";
      if (type[0] !== 1 || size[0] > data.length || size[0] % 2 !== 0) {
        throw new Error("Windows document registration encountered an invalid string value");
      }
      return data.toString("utf16le", 0, size[0]).replace(/\0+$/gu, "");
    },
    writeString(key, name, value) {
      const handle: unknown[] = [null];
      checkRegistryStatus(createKey(currentUser[0], key, 0, null, 0, 0x2, null, handle, null), "create key"); // KEY_SET_VALUE
      try {
        const data = Buffer.from(`${value}\0`, "utf16le");
        checkRegistryStatus(setValue(handle[0], name, 0, 1, data, data.length), "write value"); // REG_SZ
      } finally {
        closeKey(handle[0]);
      }
    },
    notifyAssociationsChanged() {
      notify(0x08000000, 0, null, null); // SHCNE_ASSOCCHANGED / SHCNF_IDLIST
    },
    dispose() {
      closeKey(currentUser[0]);
    }
  };
}

/** Restore the NSIS-owned Open With entries in the current user's profile. */
export async function refreshWindowsDocumentRegistration(
  options: RegistrationOptions,
  openRegistry: () => WindowsDocumentRegistry = openWindowsDocumentRegistry
): Promise<WindowsDocumentRegistrationResult> {
  const result: WindowsDocumentRegistrationResult = { status: "skipped", registeredTypes: [], preservedTypes: [] };
  if (options.platform === "darwin") return result;
  if (options.platform !== "win32" || !options.isPackaged || options.appId.endsWith(".dev")) return result;
  if (!/^[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*$/u.test(options.appId) ||
      !options.productName || /[\0\r\n]/u.test(options.productName) ||
      !path.win32.isAbsolute(options.executablePath) || !/\.exe$/iu.test(options.executablePath) ||
      /["\0\r\n]/u.test(options.executablePath)) {
    throw new Error("Invalid Windows document registration identity");
  }

  const registry = openRegistry();
  const command = `"${options.executablePath}" "%1"`;
  try {
    for (const { id, name, extensions } of documentFileTypes) {
      const progId = `${options.appId}.${id}`;
      const key = `Software\\Classes\\${progId}`;
      const commandKey = `${key}\\shell\\open\\command`;
      const existingCommand = registry.readString(commandKey, "");
      // Another installation may already own this brand's entry. Starting an
      // old image/copy must not redirect its file handler to the running copy.
      if (existingCommand && existingCommand.toLowerCase() !== command.toLowerCase()) {
        result.preservedTypes.push(id);
        continue;
      }
      const values: [string, string, string][] = [
        [key, "", `${options.productName} ${name}`],
        [`${key}\\Application`, "ApplicationName", options.productName],
        [`${key}\\DefaultIcon`, "", `"${options.executablePath}",0`],
        [commandKey, "", existingCommand || command],
        ...extensions.map((ext): [string, string, string] => [`Software\\Classes\\.${ext}\\OpenWithProgids`, progId, ""])
      ];
      let changed = false;
      for (const [valueKey, valueName, value] of values) {
        const existing = registry.readString(valueKey, valueName);
        if (existing === value || (valueKey === `${key}\\DefaultIcon` && existing?.toLowerCase() === value.toLowerCase())) continue;
        registry.writeString(valueKey, valueName, value);
        changed = true;
      }
      if (changed) result.registeredTypes.push(id);
    }
    result.status = result.registeredTypes.length > 0 ? "registered" : "unchanged";
    if (result.status === "registered") registry.notifyAssociationsChanged();
    return result;
  } finally {
    registry.dispose();
  }
}
