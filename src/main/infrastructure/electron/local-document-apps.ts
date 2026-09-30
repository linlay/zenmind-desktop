import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";

export type LocalDocumentExtension = ".ppt" | ".pptx" | ".doc" | ".docx" | ".xls" | ".xlsx" | ".pdf";
/** @deprecated Use LocalDocumentExtension, which also includes PDF. */

/** Main-only descriptor. Never send the application path to a guest or renderer. */
export interface LocalDocumentApplication {
  id: string;
  name: string;
  path: string;
  isDefault: boolean;
  iconDataUrl?: string;
}

export class LocalDocumentApplicationError extends Error {
  constructor(
    readonly code: "unsupported-platform" | "unsupported-type" | "query-failed" | "application-unavailable" | "launch-failed",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "LocalDocumentApplicationError";
  }
}

const supportedExtensions = new Set<string>([".ppt", ".pptx", ".doc", ".docx", ".xls", ".xlsx", ".pdf"]);

function documentExtension(value: string): LocalDocumentExtension {
  if (!supportedExtensions.has(value)) {
    throw new LocalDocumentApplicationError("unsupported-type", "Local opening is only available for supported documents");
  }
  return value as LocalDocumentExtension;
}

function applicationId(platform: "darwin" | "win32", extension: LocalDocumentExtension, identity: string): string {
  return `local-app-${createHash("sha256").update(`${platform}\0${extension}\0${identity}`).digest("hex")}`;
}

async function installedApplication(application: LocalDocumentApplication, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const info = await stat(application.path);
    if (platform === "darwin") return info.isDirectory() && path.extname(application.path).toLowerCase() === ".app";
    if (platform === "win32") return info.isFile() && path.win32.extname(application.path).toLowerCase() === ".exe";
    return false;
  } catch {
    // Launch Services and the Windows registry can retain entries after uninstall.
    return false;
  }
}

async function readApplications(extension: LocalDocumentExtension): Promise<LocalDocumentApplication[]> {
  let candidates: LocalDocumentApplication[];
  try {
    if (process.platform === "darwin") candidates = getMacAssociations().list(extension);
    else if (process.platform === "win32") candidates = getWindowsAssociations().list(extension);
    else throw new LocalDocumentApplicationError("unsupported-platform", "Local document applications require macOS or Windows");
  } catch (error) {
    if (error instanceof LocalDocumentApplicationError) throw error;
    throw new LocalDocumentApplicationError("query-failed", "Could not query the system's document applications", { cause: error });
  }
  const availability = await Promise.all(candidates.map(candidate => installedApplication(candidate, process.platform)));
  const unique = new Map<string, LocalDocumentApplication>();
  candidates.forEach((candidate, index) => {
    if (availability[index] && !unique.has(candidate.id)) unique.set(candidate.id, candidate);
  });
  return [...unique.values()].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
}

/** Queries actual file associations. It does not download documents or launch an app. */
export async function listLocalDocumentApplications(extension: LocalDocumentExtension): Promise<LocalDocumentApplication[]> {
  const applications = await readApplications(documentExtension(extension));
  return Promise.all(applications.map(async application => {
    if (process.platform === "darwin") {
      try {
        const iconDataUrl = getMacApplicationIcon()(application.path);
        if (iconDataUrl) return { ...application, iconDataUrl };
      } catch {
        // A native icon failure still permits Electron's generic file-icon fallback.
      }
    }
    try {
      // Keep Electron and the native libraries lazy so this module is safe in Node tools.
      const { app } = require("electron") as typeof import("electron");
      const icon = await app.getFileIcon(application.path, { size: process.platform === "darwin" ? "normal" : "small" });
      if (!icon.isEmpty()) return { ...application, iconDataUrl: icon.toDataURL() };
    } catch {
      // An unavailable icon must not hide a valid installed application.
    }
    return application;
  }));
}

/** Opens only the exact, still-registered application selected from a previous query. */
export async function openWithLocalApplication(
  application: LocalDocumentApplication,
  filePath: string,
  stillOwned?: () => boolean
): Promise<void> {
  const platformPath = process.platform === "win32" ? path.win32 : path.posix;
  if (typeof filePath !== "string" || !platformPath.isAbsolute(filePath) || filePath.includes("\0")) {
    throw new LocalDocumentApplicationError("launch-failed", "A saved local document is required");
  }
  const extension = documentExtension(platformPath.extname(filePath).toLowerCase());
  const candidates = await readApplications(extension);
  const selected = candidates.find(candidate => candidate.id === application.id && candidate.path === application.path);
  if (!selected) {
    throw new LocalDocumentApplicationError("application-unavailable", "The selected application is no longer available for this document");
  }
  try {
    if (!(await stat(filePath)).isFile()) throw new Error("The saved document is not a file");
    // Recheck the host's ownership after the asynchronous filesystem boundaries.
    if (stillOwned && !stillOwned()) {
      throw new LocalDocumentApplicationError("application-unavailable", "The document surface is no longer available");
    }
    if (process.platform === "darwin") {
      // -a accepts the exact bundle path. Do not resolve by display name or current default.
      await new Promise<void>((resolve, reject) => {
        execFile("/usr/bin/open", ["-a", selected.path, filePath], { shell: false, timeout: 15_000, maxBuffer: 64 * 1024 }, error => {
          if (error) reject(error);
          else resolve();
        });
      });
    } else if (process.platform === "win32") {
      // Let the selected Shell handler perform its registered launch (including DDE).
      // Never parse a registry command or silently fall back to the current default.
      getWindowsAssociations().open(extension, selected, filePath);
    } else {
      throw new LocalDocumentApplicationError("unsupported-platform", "Local document applications require macOS or Windows");
    }
  } catch (error) {
    if (error instanceof LocalDocumentApplicationError) throw error;
    throw new LocalDocumentApplicationError("launch-failed", "The system could not launch the selected application", { cause: error });
  }
}

type NativePointer = bigint | null;
type AssociationReader = { list(extension: LocalDocumentExtension): LocalDocumentApplication[] };
let macAssociations: AssociationReader | undefined;
let macApplicationIcon: ((applicationPath: string) => string | undefined) | undefined;

function getMacApplicationIcon(): (applicationPath: string) => string | undefined {
  if (macApplicationIcon) return macApplicationIcon;
  const koffi = require("koffi") as typeof import("koffi");
  // Electron's macOS getFileIcon treats .app bundles as one generic file type.
  // NSWorkspace resolves the actual Finder icon, including bundle/custom icons.
  koffi.load("/System/Library/Frameworks/AppKit.framework/AppKit");
  const objc = koffi.load("/usr/lib/libobjc.A.dylib");
  const nativeClass = objc.func("void *objc_getClass(const char *name)");
  const selector = objc.func("void *sel_registerName(const char *name)");
  const object = objc.func("objc_msgSend", "void *", ["void *", "void *"]);
  const objectArgument = objc.func("objc_msgSend", "void *", ["void *", "void *", "void *"]);
  const stringArgument = objc.func("objc_msgSend", "void *", ["void *", "void *", "const char *"]);
  const integer = objc.func("objc_msgSend", "ulong", ["void *", "void *"]);
  const perform = objc.func("objc_msgSend", "void", ["void *", "void *"]);
  const representation = objc.func("objc_msgSend", "void *", ["void *", "void *", "ulong", "void *"]);
  // NSRect contains four consecutive CGFloat (double) values on 64-bit macOS.
  const rect = koffi.struct({ x: "double", y: "double", width: "double", height: "double" });
  const imageForRect = objc.func("objc_msgSend", "void *", ["void *", "void *", koffi.inout(koffi.pointer(rect)), "void *", "void *"]);
  const classes = {
    pool: nativeClass("NSAutoreleasePool"), workspace: nativeClass("NSWorkspace"),
    string: nativeClass("NSString"), bitmap: nativeClass("NSBitmapImageRep"), dictionary: nativeClass("NSDictionary"),
  };
  if (Object.values(classes).some(value => !value)) throw new Error("macOS application icons are unavailable");
  macApplicationIcon = (applicationPath) => {
    const pool = object(classes.pool, selector("new"));
    if (!pool) return undefined;
    let bitmap: NativePointer = null;
    try {
      const nativePath = stringArgument(classes.string, selector("stringWithUTF8String:"), applicationPath);
      const workspace = object(classes.workspace, selector("sharedWorkspace"));
      const icon = objectArgument(workspace, selector("iconForFile:"), nativePath);
      if (!icon) return undefined;
      // Request a fresh 64-point representation (128px on Retina), without
      // resizing or mutating the NSImage cached and shared by NSWorkspace.
      const image = imageForRect(icon, selector("CGImageForProposedRect:context:hints:"),
        { x: 0, y: 0, width: 64, height: 64 }, null, null);
      if (!image) return undefined;
      bitmap = objectArgument(object(classes.bitmap, selector("alloc")), selector("initWithCGImage:"), image);
      if (!bitmap) return undefined;
      const properties = object(classes.dictionary, selector("dictionary"));
      const data = representation(bitmap, selector("representationUsingType:properties:"), 4, properties); // NSBitmapImageFileTypePNG
      if (!data) return undefined;
      const length = Number(integer(data, selector("length")));
      const bytes = object(data, selector("bytes"));
      if (!bytes || !Number.isSafeInteger(length) || length < 24 || length > 1024 * 1024) return undefined;
      // Copy out before draining the autorelease pool; external memory views
      // are not supported by Electron's V8 memory cage.
      const png = Buffer.from(koffi.decode(bytes, "uint8_t", length));
      if (!png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
        png.readUInt32BE(16) < 48 || png.readUInt32BE(20) < 48) return undefined;
      return `data:image/png;base64,${png.toString("base64")}`;
    } finally {
      if (bitmap) perform(bitmap, selector("release"));
      perform(pool, selector("drain"));
    }
  };
  return macApplicationIcon;
}

function getMacAssociations(): AssociationReader {
  if (macAssociations) return macAssociations;
  const koffi = require("koffi") as typeof import("koffi");
  const core = koffi.load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");
  const services = koffi.load("/System/Library/Frameworks/CoreServices.framework/CoreServices");
  const createString = core.func("void *CFStringCreateWithCString(void *allocator, const char *value, uint32 encoding)");
  const stringLength = core.func("long CFStringGetLength(void *value)");
  const stringBytes = core.func("bool CFStringGetCString(void *value, _Out_ char *buffer, long capacity, uint32 encoding)");
  const arrayCount = core.func("long CFArrayGetCount(void *array)");
  const arrayValue = core.func("void *CFArrayGetValueAtIndex(void *array, long index)");
  const filePath = core.func("void *CFURLCopyFileSystemPath(void *url, int style)");
  const release = core.func("void CFRelease(void *value)");
  const getTypeId = core.func("ulong CFGetTypeID(void *value)");
  const stringTypeId = core.func("ulong CFStringGetTypeID()");
  const createBundle = core.func("void *CFBundleCreate(void *allocator, void *url)");
  const bundleValue = core.func("void *CFBundleGetValueForInfoDictionaryKey(void *bundle, void *key)");
  const typeForExtension = services.func("void *UTTypeCreatePreferredIdentifierForTag(void *tagClass, void *tag, void *conformingTo)");
  const defaultHandler = services.func("void *LSCopyDefaultRoleHandlerForContentType(void *type, uint32 roles)");
  const defaultApplicationUrl = services.func("void *LSCopyDefaultApplicationURLForContentType(void *type, uint32 roles, void *error)");
  const allHandlers = services.func("void *LSCopyAllRoleHandlersForContentType(void *type, uint32 roles)");
  const applicationUrls = services.func("void *LSCopyApplicationURLsForBundleIdentifier(void *bundleId, void *error)");
  const utf8 = 0x08000100;
  const roles = 0xffffffff;
  const makeString = (value: string): NativePointer => createString(null, value, utf8);
  const toString = (value: NativePointer): string => {
    if (!value || getTypeId(value) !== stringTypeId()) return "";
    const capacity = Number(stringLength(value)) * 4 + 1;
    if (capacity < 1 || capacity > 128 * 1024) throw new Error("Invalid application metadata length");
    const buffer = Buffer.alloc(capacity);
    if (!stringBytes(value, buffer, capacity, utf8)) throw new Error("Could not decode application metadata");
    return buffer.toString("utf8", 0, buffer.indexOf(0));
  };
  macAssociations = {
    list(extension) {
      const owned: NativePointer[] = [];
      const own = (value: NativePointer): NativePointer => { if (value) owned.push(value); return value; };
      try {
        const tag = own(makeString(extension.slice(1)));
        const tagClass = own(makeString("public.filename-extension"));
        const type = own(typeForExtension(tagClass, tag, null));
        if (!type) throw new Error("The system could not resolve the document content type");
        const defaultBundle = own(defaultHandler(type, roles));
        const defaultUrl = own(defaultApplicationUrl(type, roles, null));
        const defaultPath = defaultUrl ? toString(own(filePath(defaultUrl, 0))) : "";
        const handlers = own(allHandlers(type, roles));
        const displayKey = own(makeString("CFBundleDisplayName"));
        const nameKey = own(makeString("CFBundleName"));
        const bundleIds: NativePointer[] = defaultBundle ? [defaultBundle] : [];
        if (handlers) for (let i = 0; i < Number(arrayCount(handlers)); i++) bundleIds.push(arrayValue(handlers, i));
        const seen = new Set<string>();
        const result: LocalDocumentApplication[] = [];
        for (const bundleId of bundleIds) {
          const identifier = toString(bundleId);
          if (!identifier || seen.has(identifier)) continue;
          seen.add(identifier);
          const urls = applicationUrls(bundleId, null);
          if (!urls) continue;
          try {
            // Include each installed bundle copy so a selection identifies an exact path.
            for (let i = 0; i < Number(arrayCount(urls)); i++) {
              const url = arrayValue(urls, i);
              const nativePath = filePath(url, 0); // kCFURLPOSIXPathStyle
              const bundle = createBundle(null, url);
              try {
                const applicationPath = toString(nativePath);
                if (!applicationPath || !bundle) continue;
                const name = toString(bundleValue(bundle, displayKey)) || toString(bundleValue(bundle, nameKey));
                if (!name) continue;
                result.push({
                  id: applicationId("darwin", extension, `${identifier}\0${applicationPath}`),
                  name, path: applicationPath, isDefault: applicationPath === defaultPath
                });
              } finally {
                if (bundle) release(bundle);
                if (nativePath) release(nativePath);
              }
            }
          } finally { release(urls); }
        }
        return result;
      } finally { owned.reverse().forEach(value => release(value)); }
    }
  };
  return macAssociations;
}

type WindowsAssociations = AssociationReader & {
  open(extension: LocalDocumentExtension, application: LocalDocumentApplication, filePath: string): void;
};
let windowsAssociations: WindowsAssociations | undefined;

function getWindowsAssociations(): WindowsAssociations {
  if (windowsAssociations) return windowsAssociations;
  const koffi = require("koffi") as typeof import("koffi");
  const shell = koffi.load("shell32.dll");
  const shlwapi = koffi.load("shlwapi.dll");
  const ole = koffi.load("ole32.dll");
  const initialize = ole.func("int32 __stdcall CoInitializeEx(void *reserved, uint32 model)");
  const uninitialize = ole.func("void __stdcall CoUninitialize()");
  const free = ole.func("void __stdcall CoTaskMemFree(void *memory)");
  const enumerate = shell.func("int32 __stdcall SHAssocEnumHandlers(str16 extension, uint32 filter, _Out_ void **enumerator)");
  const query = shlwapi.func("int32 __stdcall AssocQueryStringW(uint32 flags, uint32 key, str16 extension, str16 verb, _Out_ void *value, _Inout_ uint32 *length)");
  const createItem = shell.func("int32 __stdcall SHCreateItemFromParsingName(str16 path, void *context, void *iid, _Out_ void **item)");
  const pointerSize = koffi.sizeof("void *");
  const releasePrototype = koffi.proto("__stdcall", "uint32", ["void *"]);
  const nextPrototype = koffi.proto("__stdcall", "int32", ["void *", "uint32", koffi.out("void **"), koffi.out("uint32 *")]);
  const stringPrototype = koffi.proto("__stdcall", "int32", ["void *", koffi.out("void **")]);
  const invokePrototype = koffi.proto("__stdcall", "int32", ["void *", "void *"]);
  const bindPrototype = koffi.proto("__stdcall", "int32", ["void *", "void *", "void *", "void *", koffi.out("void **")]);
  const call = (object: NativePointer, index: number, prototype: import("koffi").TypeObject, ...args: unknown[]): number => {
    if (!object) throw new Error("Missing Shell interface");
    const vtable = koffi.decode(object, "void *");
    const method = koffi.decode(vtable, index * pointerSize, "void *");
    return Number(koffi.call(method, prototype, object, ...args));
  };
  const release = (object: NativePointer) => { if (object) call(object, 2, releasePrototype); };
  const check = (result: number, operation: string) => {
    if (result < 0) throw new Error(`${operation} failed (0x${(result >>> 0).toString(16)})`);
  };
  const inApartment = <T>(action: () => T): T => {
    // Shell association handlers expect the calling UI thread's STA apartment.
    const result = Number(initialize(null, 2)); // COINIT_APARTMENTTHREADED
    check(result, "COM initialization");
    try { return action(); } finally { uninitialize(); }
  };
  const handlerString = (handler: NativePointer, index: number): string => {
    const output: NativePointer[] = [null];
    try {
      check(call(handler, index, stringPrototype, output), "Application metadata query");
      return output[0] ? koffi.decode.string16(output[0]) : "";
    } finally { if (output[0]) free(output[0]); }
  };
  const associationString = (extension: LocalDocumentExtension, key: number): string => {
    const length = [0];
    const first = Number(query(0, key, extension, "open", null, length));
    // No association is a valid state, distinct from a failed enumeration below.
    if ([0x80070483, 0x80070002, 0x80070003].includes(first >>> 0)) return "";
    check(first, "Default application query");
    if (length[0] < 1) return "";
    if (length[0] > 32 * 1024) throw new Error("Invalid association metadata length");
    const buffer = Buffer.alloc(length[0] * 2);
    check(Number(query(0, key, extension, "open", buffer, length)), "Default application query");
    return buffer.toString("utf16le").replace(/\0.*$/s, "");
  };
  const normalizePath = (value: string): string => path.win32.normalize(value).toLowerCase();
  const withHandlers = <T>(extension: LocalDocumentExtension, visit: (handler: NativePointer, application: LocalDocumentApplication) => T | undefined): T | undefined => {
    const enumerator: NativePointer[] = [null];
    const defaultPath = associationString(extension, 2); // ASSOCSTR_EXECUTABLE
    const defaultName = associationString(extension, 4); // ASSOCSTR_FRIENDLYAPPNAME
    try {
      check(Number(enumerate(extension, 0, enumerator)), "Application enumeration"); // ASSOC_FILTER_NONE
      if (!enumerator[0]) throw new Error("The system did not return an application enumerator");
      for (let count = 0; count < 256; count++) {
        const handler: NativePointer[] = [null];
        const fetched = [0];
        try {
          const result = call(enumerator[0], 3, nextPrototype, 1, handler, fetched);
          check(result, "Application enumeration");
          if (!fetched[0]) return undefined;
          const applicationPath = handlerString(handler[0], 3); // IAssocHandler::GetName
          const name = handlerString(handler[0], 4); // IAssocHandler::GetUIName
          if (!path.win32.isAbsolute(applicationPath) || !name) continue;
          const application: LocalDocumentApplication = {
            id: applicationId("win32", extension, normalizePath(applicationPath)),
            name, path: applicationPath,
            isDefault: defaultPath ? normalizePath(defaultPath) === normalizePath(applicationPath) : Boolean(defaultName && name === defaultName)
          };
          const visited = visit(handler[0], application);
          if (visited !== undefined) return visited;
        } finally { release(handler[0]); }
      }
      throw new Error("The system returned too many document applications");
    } finally { release(enumerator[0]); }
  };
  // Windows GUID byte layout: the first three fields are little-endian.
  const shellItemIid = Buffer.from("1e6d824318e7ee42bc55a1e261c37bfe", "hex"); // IID_IShellItem
  const dataObjectHandler = Buffer.from("9fbdc0b824ed5c4583e6d5390c4fe8c4", "hex"); // BHID_DataObject
  const dataObjectIid = Buffer.from("0e01000000000000c000000000000046", "hex"); // IID_IDataObject
  windowsAssociations = {
    list(extension) {
      return inApartment(() => {
        const result: LocalDocumentApplication[] = [];
        withHandlers(extension, (_handler, application) => { result.push(application); return undefined; });
        return result;
      });
    },
    open(extension, application, filePath) {
      inApartment(() => {
        const invoked = withHandlers(extension, (handler, candidate) => {
          if (candidate.id !== application.id || candidate.path !== application.path) return undefined;
          const item: NativePointer[] = [null];
          const data: NativePointer[] = [null];
          try {
            check(Number(createItem(filePath, null, shellItemIid, item)), "Document Shell item creation");
            check(call(item[0], 3, bindPrototype, null, dataObjectHandler, dataObjectIid, data), "Document data object creation");
            check(call(handler, 8, invokePrototype, data[0]), "Selected application launch"); // IAssocHandler::Invoke
            return true;
          } finally { release(data[0]); release(item[0]); }
        });
        if (!invoked) throw new LocalDocumentApplicationError("application-unavailable", "The selected application is no longer registered");
      });
    }
  };
  return windowsAssociations;
}
