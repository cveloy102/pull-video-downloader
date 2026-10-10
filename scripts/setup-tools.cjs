'use strict';
// Cross-platform network transport; the shipped application itself is Windows x64.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const toolsDir = path.resolve(__dirname, '..', 'tools');
const force = process.argv.includes('--force');
const stage = path.join(toolsDir, `.setup-${crypto.randomUUID()}`);
const headers = { 'User-Agent': 'PULL-video-downloader-setup', Accept: 'application/vnd.github+json' };
const releases = {};

async function request(url) {
  if (!url.startsWith('https://')) throw new Error('Only HTTPS tool downloads are supported.');
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(300000) });
  if (!response.ok) throw new Error(`${response.status}: ${new URL(url).pathname}`);
  return response;
}

async function download(url, filename) {
  const response = await request(url);
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(filename));
}

async function verify(file, expected) {
  if (!/^[a-f0-9]{64}$/i.test(expected || '')) throw new Error(`Missing SHA256 for ${path.basename(file)}`);
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  if (hash.digest('hex').toLowerCase() !== expected.toLowerCase()) throw new Error(`SHA256 mismatch: ${path.basename(file)}`);
}

function manifestHash(text, filename) {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line);
    if (match && match[2].trim() === filename) return match[1];
  }
  throw new Error(`No SHA256 checksum for ${filename}`);
}

async function extract(zip, destination) {
  await fsp.mkdir(destination, { recursive: true });
  const script = path.join(stage, 'expand.ps1');
  await fsp.writeFile(script, "param([string]$Archive,[string]$Destination)\n$ErrorActionPreference = 'Stop'\nExpand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force\n");
  await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Archive', zip, '-Destination', destination], { windowsHide: true, timeout: 300000 });
}

async function files(directory) {
  const result = [];
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(filename));
    else if (entry.isFile()) result.push(filename);
  }
  return result;
}

async function setupYtDlp() {
  if (!force && fs.existsSync(path.join(toolsDir, 'yt-dlp.exe'))) return;
  console.log('Downloading official yt-dlp with SHA256 verification...');
  const release = await (await request('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest')).json();
  const executable = release.assets.find((asset) => asset.name === 'yt-dlp.exe');
  const checksums = release.assets.find((asset) => asset.name === 'SHA2-256SUMS');
  if (!executable || !checksums) throw new Error('Official yt-dlp release assets are missing.');
  const output = path.join(stage, 'yt-dlp.exe');
  await download(executable.browser_download_url, output);
  const manifest = await (await request(checksums.browser_download_url)).text();
  await verify(output, manifestHash(manifest, 'yt-dlp.exe'));
  await fsp.copyFile(output, path.join(toolsDir, 'yt-dlp.exe'));
  await fsp.writeFile(path.join(toolsDir, 'yt-dlp.version'), `${release.tag_name}\n`);
  releases.ytDlp = release.tag_name;
  await download(`https://raw.githubusercontent.com/yt-dlp/yt-dlp/${release.tag_name}/THIRD_PARTY_LICENSES.txt`, path.join(toolsDir, 'yt-dlp-THIRD_PARTY_LICENSES.txt'));
  console.log(`yt-dlp ${release.tag_name} ready.`);
}

async function setupFfmpeg() {
  if (!force && ['ffmpeg.exe', 'ffprobe.exe'].every((name) => fs.existsSync(path.join(toolsDir, name)))) return;
  console.log('Downloading verified Windows x64 FFmpeg build...');
  const release = await (await request('https://api.github.com/repos/yt-dlp/FFmpeg-Builds/releases/latest')).json();
  const asset = release.assets.find((item) => /^ffmpeg-.*win64-gpl\.zip$/.test(item.name));
  if (!asset) throw new Error('Official Windows x64 FFmpeg ZIP is missing.');
  const archive = path.join(stage, asset.name);
  await download(asset.browser_download_url, archive);
  let checksum = asset.digest?.replace(/^sha256:/, '');
  if (!/^[a-f0-9]{64}$/i.test(checksum || '')) {
    const hashAsset = release.assets.find((item) => item.name === `${asset.name}.sha256`);
    if (!hashAsset) throw new Error('The FFmpeg release has no verifiable SHA256 digest.');
    const text = await (await request(hashAsset.browser_download_url)).text();
    checksum = /[a-f0-9]{64}/i.exec(text)?.[0];
  }
  await verify(archive, checksum);
  const destination = path.join(stage, 'ffmpeg'); await extract(archive, destination);
  const extracted = await files(destination);
  for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
    const source = extracted.find((filename) => path.basename(filename).toLowerCase() === name);
    if (!source) throw new Error(`${name} missing from verified archive.`);
    await fsp.copyFile(source, path.join(toolsDir, name));
  }
  const licenses = path.join(toolsDir, 'ffmpeg-licenses'); await fsp.mkdir(licenses, { recursive: true });
  for (const filename of extracted.filter((item) => /LICENSE|COPYING|README/i.test(path.basename(item)))) {
    await fsp.copyFile(filename, path.join(licenses, path.basename(filename)));
  }
  await fsp.writeFile(path.join(toolsDir, 'ffmpeg.version'), `${release.tag_name}\n`);
  releases.ffmpeg = release.tag_name;
  console.log(`FFmpeg ${release.tag_name} ready.`);
}

async function setupNode() {
  if (!force && fs.existsSync(path.join(toolsDir, 'node.exe'))) return;
  if (process.platform === 'win32' && path.basename(process.execPath).toLowerCase() === 'node.exe' && Number(process.versions.node.split('.')[0]) >= 22) {
    await fsp.copyFile(process.execPath, path.join(toolsDir, 'node.exe'));
    console.log(`Copied Node.js ${process.version}.`);
    await download(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`, path.join(toolsDir, 'node-LICENSE.txt'));
    releases.node = process.version;
    return;
  }
  console.log('Downloading official Node.js LTS with SHA256 verification...');
  const versions = await (await request('https://nodejs.org/dist/index.json')).json();
  const version = versions.find((release) => release.lts && release.files.includes('win-x64-zip'))?.version;
  if (!version) throw new Error('A supported Node.js LTS runtime is unavailable.');
  const archiveName = `node-${version}-win-x64.zip`, base = `https://nodejs.org/dist/${version}`;
  const archive = path.join(stage, archiveName); await download(`${base}/${archiveName}`, archive);
  const manifest = await (await request(`${base}/SHASUMS256.txt`)).text();
  await verify(archive, manifestHash(manifest, archiveName));
  const destination = path.join(stage, 'node'); await extract(archive, destination);
  const extracted = await files(destination);
  const executable = extracted.find((filename) => path.basename(filename) === 'node.exe');
  if (!executable) throw new Error('Node.js executable missing from verified archive.');
  await fsp.copyFile(executable, path.join(toolsDir, 'node.exe'));
  const license = extracted.find((filename) => path.basename(filename) === 'LICENSE');
  if (license) await fsp.copyFile(license, path.join(toolsDir, 'node-LICENSE.txt'));
  releases.node = version;
}

(async () => {
  await fsp.mkdir(stage, { recursive: true });
  try {
    const results = await Promise.allSettled([setupYtDlp(), setupFfmpeg(), setupNode()]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    await fsp.writeFile(path.join(toolsDir, 'SOURCES.txt'), [
      'Official executable sources and licenses:',
      'yt-dlp: https://github.com/yt-dlp/yt-dlp (Windows binary includes GPLv3+ components).',
      'FFmpeg: https://github.com/yt-dlp/FFmpeg-Builds (GPL build; release and build sources).',
      'FFmpeg upstream sources: https://ffmpeg.org/download.html#get-sources',
      'Node.js: https://nodejs.org/ and https://github.com/nodejs/node/blob/main/LICENSE',
      'Preserve the bundled license files when redistributing.', '', JSON.stringify(releases, null, 2), '',
    ].join('\n'));
    for (const [name, args] of [['yt-dlp.exe', ['--version']], ['ffmpeg.exe', ['-version']], ['node.exe', ['--version']]]) {
      const output = await execute(path.join(toolsDir, name), args, { windowsHide: true, timeout: 30000 });
      console.log(output.stdout.split(/\r?\n/)[0]);
    }
    console.log(`Tools ready: ${toolsDir}`);
  } finally {
    const relative = path.relative(toolsDir, stage);
    if (relative.startsWith('.setup-') && !relative.includes(path.sep)) await fsp.rm(stage, { recursive: true, force: true });
  }
})().catch((error) => { console.error(`Tool setup failed: ${error.message}`); process.exitCode = 1; });
