import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../src/main/infrastructure/electron/local-document-apps.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const extensions = ['.ppt', '.pptx', '.doc', '.docx', '.xls', '.xlsx', '.pdf'];

function fixture(platform) {
  const state = {
    apps: new Map(), defaults: new Map(), missing: new Set(), loaded: [], queried: [], launched: [],
    icons: [], released: [], freed: [], comBalance: 0, live: new Set(),
    enumError: 0, queryError: 0, launchError: undefined, invokeError: 0, iconError: false,
    nativeIcons: false, nativeIconFailure: false, nativeIconRequests: [], nativeIconRects: [], iconSizes: []
  };
  const string = value => ({ kind: 'string', value });
  const current = extension => state.apps.get(extension) || [];
  const defaultApp = extension => current(extension).find(app => app.path === state.defaults.get(extension));
  const allocate = value => { state.live.add(value); return value; };
  const functions = platform === 'darwin' ? {
    CFStringCreateWithCString: (_allocator, value) => string(value),
    CFStringGetLength: value => value.value.length,
    CFStringGetCString: (value, buffer) => { buffer.write(value.value, 'utf8'); return true; },
    CFGetTypeID: value => value.kind === 'string' ? 1 : 2,
    CFStringGetTypeID: () => 1,
    CFArrayGetCount: values => values.length,
    CFArrayGetValueAtIndex: (values, index) => values[index],
    CFURLCopyFileSystemPath: url => string(url.path),
    CFRelease: value => state.released.push(value),
    CFBundleCreate: (_allocator, url) => url,
    CFBundleGetValueForInfoDictionaryKey: (bundle, key) => string(key.value === 'CFBundleDisplayName' ? bundle.name : 'Fallback'),
    UTTypeCreatePreferredIdentifierForTag: (tagClass, tag) => {
      assert.equal(tagClass.value, 'public.filename-extension');
      state.queried.push(`.${tag.value}`);
      return string(`.${tag.value}`);
    },
    LSCopyDefaultRoleHandlerForContentType: type => {
      const app = defaultApp(type.value); return app ? string(app.bundleId) : null;
    },
    LSCopyDefaultApplicationURLForContentType: (type, _roles, error) => {
      assert.equal(error, null); return defaultApp(type.value) || null;
    },
    LSCopyAllRoleHandlersForContentType: type => current(type.value).map(app => string(app.bundleId)),
    LSCopyApplicationURLsForBundleIdentifier: (id, error) => {
      assert.equal(error, null);
      return [...new Map([...state.apps.values()].flat().filter(app => app.bundleId === id.value).map(app => [app.path, app])).values()];
    }
  } : {
    CoInitializeEx: (_reserved, model) => { assert.equal(model, 2); state.comBalance++; return 0; },
    CoUninitialize: () => state.comBalance--,
    CoTaskMemFree: value => state.freed.push(value),
    AssocQueryStringW: (_flags, key, extension, verb, output, length) => {
      assert.equal(verb, 'open');
      if (state.queryError) return state.queryError;
      const app = defaultApp(extension);
      if (!app) return 0x80070483 | 0;
      const value = key === 2 ? app.path : app.name;
      length[0] = value.length + 1;
      if (!output) return 1;
      output.write(`${value}\0`, 'utf16le'); return 0;
    },
    SHAssocEnumHandlers: (extension, filter, output) => {
      assert.equal(filter, 0);
      state.queried.push(extension);
      if (state.enumError) return state.enumError;
      output[0] = allocate({ kind: 'enumerator', apps: current(extension), offset: 0 }); return 0;
    },
    SHCreateItemFromParsingName: (file, context, iid, output) => {
      assert.equal(context, null);
      assert.equal(iid.toString('hex'), '1e6d824318e7ee42bc55a1e261c37bfe');
      output[0] = allocate({ kind: 'item', file }); return 0;
    }
  };
  const koffi = {
    load(library) {
      state.loaded.push(library);
      return { func(signature) {
        if (library === '/usr/lib/libobjc.A.dylib' && state.nativeIcons) {
          if (signature.includes('objc_getClass')) return name => ({ nativeClass: name });
          if (signature.includes('sel_registerName')) return name => name;
          assert.equal(signature, 'objc_msgSend');
          return (receiver, selector, ...args) => {
            if (selector === 'new' || selector === 'alloc') return allocate({ nativeClass: receiver.nativeClass });
            if (selector === 'release' || selector === 'drain') { state.live.delete(receiver); return; }
            if (selector === 'stringWithUTF8String:') return string(args[0]);
            if (selector === 'sharedWorkspace' || selector === 'dictionary') return receiver;
            if (selector === 'iconForFile:') {
              state.nativeIconRequests.push(args[0].value);
              return { applicationPath: args[0].value };
            }
            if (selector === 'CGImageForProposedRect:context:hints:') {
              state.nativeIconRects.push({ ...args[0] });
              assert.equal(args[1], null); assert.equal(args[2], null);
              return receiver;
            }
            if (selector === 'initWithCGImage:') { receiver.image = args[0]; return receiver; }
            if (selector === 'representationUsingType:properties:') {
              assert.equal(args[0], 4, 'NSBitmapImageFileTypePNG');
              if (state.nativeIconFailure) return null;
              const bytes = Buffer.concat([Buffer.alloc(24), Buffer.from(receiver.image.applicationPath)]);
              Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
              bytes.writeUInt32BE(128, 16); bytes.writeUInt32BE(128, 20);
              return { bytes };
            }
            if (selector === 'length') return receiver.bytes.length;
            if (selector === 'bytes') return receiver.bytes;
            throw new Error(`Unexpected Objective-C selector ${selector}`);
          };
        }
        const name = signature.match(/(\w+)\(/)?.[1];
        assert.equal(typeof functions[name], 'function', `unexpected FFI function ${name}`);
        return functions[name];
      } };
    },
    sizeof: () => 8,
    proto: (...args) => { assert.equal(args[0], '__stdcall'); return args; },
    struct: members => members,
    pointer: type => type,
    inout: type => type,
    out: value => value,
    decode(object, offset) {
      if (Buffer.isBuffer(object) && offset === 'uint8_t') return [...object];
      if (offset === 'void *') return { object };
      return { object: object.object, index: offset / 8 };
    },
    call(method, _prototype, object, ...args) {
      assert.equal(method.object, object);
      if (method.index === 2) { state.live.delete(object); state.released.push(object); return 0; }
      if (object.kind === 'enumerator') {
        assert.equal(method.index, 3);
        const [count, output, fetched] = args;
        assert.equal(count, 1);
        const app = object.apps[object.offset++];
        fetched[0] = app ? 1 : 0;
        output[0] = app ? allocate({ kind: 'handler', ...app }) : null;
        return app ? 0 : 1;
      }
      if (object.kind === 'handler') {
        if (method.index === 3 || method.index === 4) {
          args[0][0] = string(method.index === 3 ? object.path : object.name); return 0;
        }
        assert.equal(method.index, 8, 'only Invoke is allowed; never MakeDefault or shell command parsing');
        assert.equal(args[0].kind, 'data');
        state.launched.push({ application: object.path, file: args[0].file }); return state.invokeError;
      }
      if (object.kind === 'item') {
        assert.equal(method.index, 3);
        const [context, bhid, iid, output] = args;
        assert.equal(context, null);
        assert.equal(bhid.toString('hex'), '9fbdc0b824ed5c4583e6d5390c4fe8c4');
        assert.equal(iid.toString('hex'), '0e01000000000000c000000000000046');
        output[0] = allocate({ kind: 'data', file: object.file }); return 0;
      }
      throw new Error(`unexpected COM object ${object.kind}`);
    }
  };
  koffi.decode.string16 = value => value.value;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, Buffer, process: { platform },
    require(name) {
      if (name === 'koffi') return koffi;
      if (name === 'electron') return { app: { getFileIcon: async (application, options) => {
        state.icons.push(application);
        state.iconSizes.push(options.size);
        if (state.iconError) throw new Error('Icon unavailable');
        return { isEmpty: () => false, toDataURL: () => 'data:image/png;base64,aWNvbg==' };
      } } };
      if (name === 'node:fs/promises') return { stat: async file => {
        if (state.missing.has(file)) throw new Error('ENOENT');
        return { isDirectory: () => file.endsWith('.app'), isFile: () => !file.endsWith('.app') };
      } };
      if (name === 'node:child_process') return { execFile: (executable, args, options, callback) => {
        state.launched.push({ executable, args: [...args], options }); callback(state.launchError);
      } };
      return require(name);
    }
  });
  return { api: exports, state };
}

function register(f, extension, office = 'PowerPoint') {
  // Platform is explicit in callers; names intentionally differ from executable filenames.
  const apps = office === 'windows' ? [
    { path: 'C:\\Office\\POWERPNT.EXE', name: 'Microsoft PowerPoint' },
    { path: 'C:\\中文 软件\\WPS Office\\wpp.exe', name: 'WPS 演示' }
  ] : [
    { bundleId: 'com.microsoft.office', path: `/Applications/Microsoft ${office}.app`, name: `Microsoft ${office}` },
    { bundleId: 'cn.wps.office', path: '/Applications/WPS Office.app', name: 'WPS Office' }
  ];
  f.state.apps.set(extension, apps);
  f.state.defaults.set(extension, apps[1].path);
  return apps;
}

test('import is lazy and unsupported document types or platforms never probe native libraries', async () => {
  const f = fixture('linux');
  assert.deepEqual(f.state.loaded, []);
  await assert.rejects(f.api.listLocalDocumentApplications('.pptx'), { code: 'unsupported-platform' });
  await assert.rejects(f.api.listLocalDocumentApplications('.exe'), { code: 'unsupported-type' });
  assert.deepEqual(f.state.loaded, []);
});

test('macOS and Windows query all seven document extensions and retain the real system default/name/icon', async () => {
  for (const platform of ['darwin', 'win32']) {
    const f = fixture(platform);
    for (const extension of extensions) {
      register(f, extension, platform === 'win32' ? 'windows' : 'PowerPoint');
      const options = await f.api.listLocalDocumentApplications(extension);
      assert.equal(options.length, 2);
      assert.equal(options[0].name, platform === 'win32' ? 'WPS 演示' : 'WPS Office');
      assert.equal(options[0].isDefault, true);
      assert.match(options[0].id, /^local-app-[a-f0-9]{64}$/);
      assert.equal(options[0].iconDataUrl, 'data:image/png;base64,aWNvbg==');
      assert.equal((await f.api.listLocalDocumentApplications(extension))[0].id, options[0].id);
    }
    assert.deepEqual([...new Set(f.state.queried)], extensions);
    assert.equal(f.state.launched.length, 0);
    assert.equal(f.state.comBalance, 0);
    assert.equal(f.state.live.size, 0);
  }
});

test('macOS uses each application Finder icon at Retina resolution and releases native image storage', async () => {
  const f = fixture('darwin');
  const apps = register(f, '.pptx');
  f.state.nativeIcons = true;
  f.state.iconError = true; // The native path must not depend on Electron's generic icon.
  const options = await f.api.listLocalDocumentApplications('.pptx');
  assert.equal(options.length, 2);
  assert.notEqual(options[0].iconDataUrl, options[1].iconDataUrl);
  for (const application of options) {
    const png = Buffer.from(application.iconDataUrl.split(',')[1], 'base64');
    assert.equal(png.readUInt32BE(16), 128);
    assert.equal(png.readUInt32BE(20), 128);
    assert.equal(png.subarray(24).toString(), application.path);
  }
  assert.deepEqual(new Set(f.state.nativeIconRequests), new Set(apps.map(app => app.path)));
  assert.ok(f.state.nativeIconRects.every(rect => rect.width === 64 && rect.height === 64));
  assert.deepEqual(f.state.icons, []);
  assert.equal(f.state.live.size, 0, 'bitmap and autorelease pool must both be released');
  assert.equal(f.state.launched.length, 0);
});

test('macOS icon conversion failure falls back without hiding apps or leaking native objects', async () => {
  const f = fixture('darwin');
  register(f, '.docx', 'Word');
  f.state.nativeIcons = true;
  f.state.nativeIconFailure = true;
  const options = await f.api.listLocalDocumentApplications('.docx');
  assert.equal(options.length, 2);
  assert.ok(options.every(application => application.iconDataUrl === 'data:image/png;base64,aWNvbg=='));
  assert.deepEqual(f.state.iconSizes, ['normal', 'normal']);
  assert.equal(f.state.live.size, 0);
});

test('PDF uses its own system handlers and opens the selected Preview or Acrobat application', async () => {
  for (const platform of ['darwin', 'win32']) {
    const f = fixture(platform);
    const application = platform === 'darwin'
      ? { bundleId: 'com.apple.Preview', path: '/System/Applications/Preview.app', name: '预览' }
      : { path: 'C:\\Program Files\\Adobe\\Acrobat\\Acrobat.exe', name: 'Adobe Acrobat' };
    f.state.apps.set('.pdf', [application]);
    f.state.defaults.set('.pdf', application.path);
    const options = await f.api.listLocalDocumentApplications('.pdf');
    assert.equal(options[0].name, application.name);
    assert.equal(options[0].isDefault, true);
    const file = platform === 'darwin' ? '/tmp/中文 文档.pdf' : 'C:\\Temp\\中文 文档.pdf';
    await f.api.openWithLocalApplication(options[0], file);
    assert.equal(f.state.launched.length, 1);
    assert.ok(f.state.queried.every(extension => extension === '.pdf'));
    assert.equal(f.state.live.size, 0);
    assert.equal(f.state.comBalance, 0);
  }
});

test('macOS identifies the exact default when multiple copies have the same bundle identifier', async () => {
  const f = fixture('darwin');
  const apps = register(f, '.docx', 'Word');
  const copy = { ...apps[0], path: '/Users/test/Applications/Microsoft Word.app' };
  f.state.apps.get('.docx').push(copy);
  f.state.defaults.set('.docx', copy.path);
  const options = await f.api.listLocalDocumentApplications('.docx');
  assert.equal(options[0].path, copy.path);
  assert.equal(options.filter(option => option.isDefault).length, 1);
  assert.equal(new Set(options.map(option => option.id)).size, 3);
});

test('stale installed paths disappear and missing icons do not hide an available app', async () => {
  for (const platform of ['darwin', 'win32']) {
    const f = fixture(platform);
    const apps = register(f, '.xlsx', platform === 'win32' ? 'windows' : 'Excel');
    f.state.missing.add(apps[0].path);
    f.state.iconError = true;
    const options = await f.api.listLocalDocumentApplications('.xlsx');
    assert.equal(options.length, 1);
    assert.equal(options[0].path, apps[1].path);
    assert.equal(options[0].iconDataUrl, undefined);
  }
});

test('selection remains exact when the default changes and paths are passed without shell interpolation', async () => {
  for (const platform of ['darwin', 'win32']) {
    const f = fixture(platform);
    const apps = register(f, '.pptx', platform === 'win32' ? 'windows' : 'PowerPoint');
    const selected = (await f.api.listLocalDocumentApplications('.pptx'))[0];
    f.state.defaults.set('.pptx', apps[0].path);
    const file = platform === 'darwin' ? '/Users/test/Downloads/报告 $(noop); 空格.pptx' : 'C:\\用户\\Downloads\\报告 & 空格.pptx';
    await f.api.openWithLocalApplication(selected, file);
    assert.equal(f.state.launched.length, 1);
    if (platform === 'darwin') {
      assert.equal(f.state.launched[0].executable, '/usr/bin/open');
      assert.deepEqual(f.state.launched[0].args, ['-a', apps[1].path, file]);
      assert.equal(f.state.launched[0].options.shell, false);
    } else {
      assert.deepEqual(f.state.launched[0], { application: apps[1].path, file });
      assert.equal(f.state.live.size, 0);
      assert.equal(f.state.comBalance, 0);
      assert.ok(f.state.freed.length > 0);
    }
  }
});

test('uninstalled, forged, and cross-extension applications are rejected without launching', async () => {
  for (const platform of ['darwin', 'win32']) {
    const f = fixture(platform);
    const apps = register(f, '.pptx', platform === 'win32' ? 'windows' : 'PowerPoint');
    register(f, '.docx', platform === 'win32' ? 'windows' : 'Word');
    const selected = (await f.api.listLocalDocumentApplications('.pptx'))[0];
    const file = platform === 'darwin' ? '/tmp/报告.pptx' : 'C:\\Temp\\报告.pptx';
    await assert.rejects(f.api.openWithLocalApplication({ ...selected, path: apps[0].path }, file), { code: 'application-unavailable' });
    await assert.rejects(f.api.openWithLocalApplication(selected, file.replace('.pptx', '.docx')), { code: 'application-unavailable' });
    f.state.apps.set('.pptx', [apps[0]]);
    await assert.rejects(f.api.openWithLocalApplication(selected, file), { code: 'application-unavailable' });
    await assert.rejects(f.api.openWithLocalApplication(selected, 'relative.pptx'), { code: 'launch-failed' });
    assert.equal(f.state.launched.length, 0);
  }
});

test('Windows empty associations and native query failures are distinct and COM always releases', async () => {
  const f = fixture('win32');
  assert.equal((await f.api.listLocalDocumentApplications('.doc')).length, 0);
  f.state.queryError = 0x80070005 | 0;
  await assert.rejects(f.api.listLocalDocumentApplications('.doc'), { code: 'query-failed' });
  f.state.queryError = 0;
  f.state.enumError = 0x80004005 | 0;
  await assert.rejects(f.api.listLocalDocumentApplications('.doc'), { code: 'query-failed' });
  assert.equal(f.state.live.size, 0);
  assert.equal(f.state.comBalance, 0);
});

test('native launch errors propagate and never fall back to the default application', async () => {
  for (const platform of ['darwin', 'win32']) {
    const f = fixture(platform);
    register(f, '.xls', platform === 'win32' ? 'windows' : 'Excel');
    const selected = (await f.api.listLocalDocumentApplications('.xls'))[0];
    f.state.launchError = new Error('launch failed');
    f.state.invokeError = 0x80070005 | 0;
    const file = platform === 'darwin' ? '/tmp/报告.xls' : 'C:\\Temp\\报告.xls';
    await assert.rejects(f.api.openWithLocalApplication(selected, file), { code: 'launch-failed' });
    assert.equal(f.state.launched.length, 1);
    assert.equal(f.state.live.size, 0);
    assert.equal(f.state.comBalance, 0);
  }
});

test('host ownership is rechecked immediately before invoking either native launcher', async () => {
  for (const platform of ['darwin', 'win32']) {
    const f = fixture(platform);
    register(f, '.docx', platform === 'win32' ? 'windows' : 'Word');
    const selected = (await f.api.listLocalDocumentApplications('.docx'))[0];
    const file = platform === 'darwin' ? '/tmp/报告.docx' : 'C:\\Temp\\报告.docx';
    let owned = true;
    const opening = f.api.openWithLocalApplication(selected, file, () => owned);
    owned = false;
    await assert.rejects(opening, { code: 'application-unavailable' });
    assert.equal(f.state.launched.length, 0);
    assert.equal(f.state.live.size, 0);
  }
});
