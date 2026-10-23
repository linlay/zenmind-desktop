// Exercise the production default factory. Only the OS/filesystem boundary is isolated.
// No extensionBrowser, executablePath, userDataDir, context or token is passed to create().
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture-production-discovery.json'), 'utf8'));
os.homedir = () => config.home;
if (process.platform === 'win32') process.env.LOCALAPPDATA = path.join(config.home, 'AppData', 'Local');
const chromeRoot = process.platform === 'darwin'
  ? path.join(config.home, 'Library', 'Application Support', 'Google', 'Chrome')
  : process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data')
    : path.join(config.home, '.config', 'google-chrome');
fs.mkdirSync(path.join(chromeRoot, 'Default'), { recursive: true });
const evidence = { defaultRootListed: false, defaultProfileProbed: false };
for (const method of ['readdir', 'readFile', 'access']) {
  const original = fs.promises[method].bind(fs.promises);
  fs.promises[method] = async (target, ...args) => {
    if (String(target) === chromeRoot && method === 'readdir') evidence.defaultRootListed = true;
    if (String(target).startsWith(path.join(chromeRoot, 'Default') + path.sep)) evidence.defaultProfileProbed = true;
    return original(target, ...args);
  };
}
const originalSpawn = childProcess.spawn;
childProcess.spawn = (executable, args, options) => {
  const connect = args.find(value => String(value).startsWith('chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/connect.html?'));
  if (!connect) throw new Error('Unexpected browser launch outside the isolated connect-page boundary');
  const url = new URL(connect);
  fs.writeFileSync(config.evidenceFile, JSON.stringify({ ...evidence,
    customUserDataDirArg: args.some(value => String(value).startsWith('--user-data-dir=')),
    profileDirectoryArg: args.some(value => String(value).startsWith('--profile-directory=')),
    tokenAbsent: !url.searchParams.has('token'),
  }));
  // Redirect the production Chrome open-URL process to our already running owned CfT profile.
  const injected = [`--user-data-dir=${config.profile}`];
  if (process.platform === 'darwin') injected.unshift('--use-mock-keychain');
  return originalSpawn(config.executable, [...injected, ...args], options);
};
const { ChromeWorkerEngine, startChromeWorker } = require('./chrome-worker.js');
startChromeWorker(new ChromeWorkerEngine());
