'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { version } = require('../package.json');

const root = path.join(__dirname, '..');
const installer = path.join(root, 'installer', 'windows');
const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const args = process.argv.slice(2);
const output = args.find(arg => arg.startsWith('--config.directories.output='))?.split('=').slice(1).join('=') || 'dist';
const unpacked = args.includes('--dir');
const uiOnly = args.includes('--ui-only');

function run(executable, argv) {
  const result = spawnSync(executable, argv, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

function buildWindow(destination, { layout, payload, versionFile } = {}) {
  const references = ['PresentationCore', 'PresentationFramework', 'WindowsBase'].map(name => path.join(framework, 'WPF', name + '.dll'));
  references.push('System.Xaml.dll', 'System.Windows.Forms.dll');
  run(path.join(framework, 'csc.exe'), [
    '/nologo', '/codepage:65001', '/target:winexe', '/platform:x64', '/optimize+',
    '/out:' + destination,
    '/win32icon:' + path.join(root, 'src', 'assets', 'pull.ico'),
    '/resource:' + path.join(root, 'src', 'assets', 'pull.png') + ',Pull.Logo',
    '/resource:' + path.join(installer, 'SetupTheme.xaml') + ',Pull.Theme',
    ...references.map(file => '/reference:' + file),
    ...(layout ? ['/define:' + layout] : []),
    ...(payload ? ['/resource:' + payload + ',Pull.Payload', '/resource:' + versionFile + ',Pull.Version'] : []),
    path.join(installer, 'SetupWindow.cs')
  ]);
}

buildWindow(path.join(installer, 'PULL-UpdateWindow.exe'));
if (!uiOnly) {
  run(process.execPath, [
    require.resolve('electron-builder/cli.js'),
    '--win', unpacked ? 'dir' : 'nsis', '--x64', '--publish', 'never',
    ...args.filter(arg => !['--variants', '--dir'].includes(arg))
  ]);
}

if (!uiOnly && !unpacked) {
  const dist = path.resolve(root, output);
  const name = 'PULL-Setup-' + version;
  const payload = path.join(dist, name + '.exe');
  const versionFile = path.join(dist, 'setup-version.txt');
  fs.writeFileSync(versionFile, version);
  try {
    const layouts = args.includes('--variants')
      ? [['A-Compact', 'COMPACT'], ['B-Sidebar', 'SIDEBAR'], ['C-Steps', 'STEPS']]
      : [['Sidebar', 'SIDEBAR']];
    for (const [label, layout] of layouts) {
      buildWindow(path.join(dist, name + '-' + label + '.exe'), { payload, versionFile, layout });
    }
  } finally {
    fs.unlinkSync(versionFile);
  }
}
