import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { digest, json, save, verify } from './deployment/files.mjs';
import { run } from './deployment/commands.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const config = () => json(join(root, 'release.config.json'));
const pkg = () => json(join(root, 'package.json'));
const git = (...args) => run('git', args, { cwd: root }).stdout;
const gh = (...args) => run('gh', args, { cwd: root }).stdout;
const registryArgs = () => ['--registry', config().registry];
const directory = () => join(root, 'artifacts', 'releases', pkg().version);
const receiptPath = () => join(directory(), 'release.json');
const versionFiles = ['package.json', 'package-lock.json', 'pnpm-lock.yaml'];

export function requiresSigning(cfg) {
  const policy = cfg.signing ?? 'signed';
  if (!['signed', 'unsigned'].includes(policy)) throw new Error('signing must be signed or unsigned.');
  return policy === 'signed';
}
export function assertSigning(cfg, receipt) {
  if (receipt.signed !== requiresSigning(cfg)) throw new Error('Artifact signing status does not match release.config.json.');
}

export function nextVersion(version, kind) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !['patch', 'minor', 'major'].includes(kind)) throw new Error('Expected a stable version and patch/minor/major.');
  const [major, minor, patch] = version.split('.').map(Number);
  return kind === 'major' ? `${major + 1}.0.0` : kind === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}
function registryVersion(version) {
  const result = run('npm', ['view', `${pkg().name}@${version}`, 'dist', '--json', ...registryArgs()], { cwd: root, allowFailure: true });
  if (result.status === 0) {
    const value = JSON.parse(result.stdout);
    return Array.isArray(value) ? value[0] : value;
  }
  if (/E404/.test(result.stderr + result.stdout)) return null;
  throw new Error(`Cannot verify npm version availability: ${result.stderr || result.stdout}`);
}
function remoteTag(version) {
  return git('ls-remote', '--tags', config().remote, `refs/tags/v${version}`, `refs/tags/v${version}^{}`).split('\n').filter(Boolean);
}
function clean(allowVersionChanges = false) {
  const entries = git('status', '--porcelain').split('\n').filter(Boolean);
  if (entries.some(entry => !allowVersionChanges || !versionFiles.includes(entry.slice(3)))) throw new Error('Unexpected source changes. Commit reviewed changes before releasing.');
}
function tools() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Releases require Windows x64.');
  const cfg = config();
  if (process.versions.node !== cfg.nodeVersion) throw new Error(`Node ${cfg.nodeVersion} required.`);
  if (run('npm', ['--version']).stdout !== cfg.npmVersion) throw new Error(`npm ${cfg.npmVersion} required.`);
  if (run('pnpm', ['--version']).stdout !== cfg.pnpmVersion) throw new Error(`pnpm ${cfg.pnpmVersion} required for release testing.`);
  run('dotnet', ['--version'], { cwd: root });
  if (requiresSigning(cfg)) {
    for (const name of ['REVCODE_SIGNTOOL', 'REVCODE_CERT_SHA1', 'REVCODE_TIMESTAMP_URL']) if (!process.env[name]) throw new Error(`Set ${name} before a signed release.`);
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; if (-not (Test-Path -LiteralPath $env:REVCODE_SIGNTOOL)) { throw 'SignTool not found' }; $cert=Get-Item -LiteralPath ('Cert:\\CurrentUser\\My\\' + $env:REVCODE_CERT_SHA1); if (-not $cert.HasPrivateKey -or $cert.NotAfter -le (Get-Date)) { throw 'A valid signing certificate with private-key access is required' }"], { cwd: root });
  }
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '& $env:REVCODE_PACKAGE_SCRIPT -RevitYears 2025,2026,2027 -RequireAllTargets -CheckOnly; if (-not $?) { exit 1 }'], { cwd: root, env: { REVCODE_PACKAGE_SCRIPT: join(root, 'scripts', 'package.ps1') }, inherit: true });
}
function preflight(version = pkg().version, resume = false) {
  const cfg = config();
  clean(true);
  if (git('branch', '--show-current') !== cfg.branch) throw new Error(`Release from ${cfg.branch}.`);
  git('fetch', cfg.remote, cfg.branch);
  const head = git('rev-parse', 'HEAD'), remote = git('rev-parse', `${cfg.remote}/${cfg.branch}`);
  if (head !== remote) {
    const parents = git('rev-list', '--count', `${remote}..${head}`);
    const changes = git('diff', '--name-only', remote, head).split('\n').filter(Boolean);
    if (parents !== '1' || changes.some(path => !versionFiles.includes(path)) || run('git', ['merge-base', '--is-ancestor', remote, head], { cwd: root, allowFailure: true }).status !== 0) throw new Error('Release branch must match remote, apart from one version-only release commit.');
  }
  gh('auth', 'status');
  const user = run('npm', ['whoami', ...registryArgs()]).stdout;
  const owners = run('npm', ['owner', 'ls', pkg().name, ...registryArgs()], { allowFailure: true });
  const unclaimed = owners.status !== 0 && /E404/.test(owners.stderr + owners.stdout);
  if (!(owners.status === 0 && owners.stdout.split('\n').some(line => line.split(' ')[0] === user)) && !(unclaimed && cfg.firstReleaseNpmUser === user)) throw new Error(`Confirm ownership of npm name ${pkg().name}. For an unclaimed name, explicitly configure firstReleaseNpmUser to the authenticated publishing account.`);
  if (!resume && (registryVersion(version) || remoteTag(version).length)) throw new Error(`Version or tag v${version} already exists. Use release:resume only for a matching prepared artifact.`);
  tools();
  console.log(`Preflight passed for ${pkg().name}@${version}.`);
}
function bump(kind) {
  nextVersion(pkg().version, kind);
  run('npm', ['version', kind, '--no-git-tag-version', '--ignore-scripts'], { cwd: root, inherit: true });
  const lock = json(join(root, 'package-lock.json'));
  if (lock.version !== pkg().version || lock.packages[''].version !== pkg().version) throw new Error('npm lockfile version mismatch.');
  // pnpm lockfile v9 contains dependency specifiers, not the root package version.
  // A version-only bump must leave that lockfile byte-for-byte unchanged.
}
function commitVersion() {
  clean(true);
  if (git('status', '--porcelain')) { git('add', '--', ...versionFiles); git('commit', '-m', `Release v${pkg().version}`); }
}
function prepareVersionPR() {
  const cfg = config(), branch = `release/v${pkg().version}`;
  const existing = run('git', ['rev-parse', '--verify', `refs/heads/${branch}`], { cwd: root, allowFailure: true });
  if (existing.status === 0 && existing.stdout !== git('rev-parse', 'HEAD')) throw new Error(`Existing version branch ${branch} has different source.`);
  if (git('branch', '--show-current') !== branch) git('switch', ...(existing.status === 0 ? [branch] : ['-c', branch]));
  git('push', '-u', cfg.remote, branch);
  const body = join(root, 'artifacts', 'version-pr.md');
  mkdirSync(join(root, 'artifacts'), { recursive: true });
  writeFileSync(body, `Prepare version ${pkg().version} for release.\n\nAfter merge, build and test the tarball from the merged commit with pnpm run release:build, complete release notes, then run pnpm run release:publish.\n`);
  const prs = JSON.parse(gh('pr', 'list', '--repo', cfg.repository, '--base', cfg.branch, '--head', branch, '--json', 'url'));
  console.log(prs[0]?.url ?? gh('pr', 'create', '--repo', cfg.repository, '--base', cfg.branch, '--head', branch, '--title', `Release v${pkg().version}`, '--body-file', body));
}
function build(skipTests = false) {
  clean(); tools();
  const dir = directory();
  if (existsSync(dir)) {
    if (existsSync(receiptPath())) {
      const previous = json(receiptPath());
      if (previous.sourceCommit === git('rev-parse', 'HEAD') || previous.steps.tag || remoteTag(pkg().version).length || registryVersion(pkg().version)) throw new Error(`Prepared release exists: ${dir}. Use release:resume; a published artifact needs a new version.`);
      renameSync(dir, `${dir}-superseded-${Date.now()}`);
    } else renameSync(dir, `${dir}-failed-${Date.now()}`);
  }
  mkdirSync(dir, { recursive: true });
  run('npm', ['ci'], { cwd: root, inherit: true });
  if (!skipTests) {
    run('npm', ['run', 'check'], { cwd: root, inherit: true });
    run('npm', ['run', 'test:native'], { cwd: root, inherit: true });
    run('npm', ['run', 'test:transport'], { cwd: root, inherit: true });
    run('npm', ['run', 'test:deployment'], { cwd: root, inherit: true });
  }
  const payload = join(dir, 'payload');
  // Invoke in PowerShell with environment data rather than interpolated shell arguments.
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '& $env:REVCODE_PACKAGE_SCRIPT -RevitYears 2025,2026,2027 -RequireAllTargets -Sign:($env:REVCODE_RELEASE_SIGN -eq "true") -SkipTests:($env:REVCODE_RELEASE_SKIP_TESTS -eq "true") -OutputDirectory $env:REVCODE_PACKAGE_OUTPUT; if (-not $?) { exit 1 }'], {
    cwd: root, env: { REVCODE_PACKAGE_SCRIPT: join(root, 'scripts', 'package.ps1'), REVCODE_PACKAGE_OUTPUT: payload, REVCODE_RELEASE_SIGN: String(requiresSigning(config())), REVCODE_RELEASE_SKIP_TESTS: String(skipTests) }, inherit: true,
  });
  const info = verify(payload);
  assertSigning(config(), info);
  const packOutput = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', dir], { cwd: `${payload}-npm` }).stdout);
  const packed = Array.isArray(packOutput) ? packOutput[0] : packOutput[pkg().name];
  if (!packed?.filename) throw new Error('npm pack did not report a tarball.');
  const tarball = join(dir, packed.filename), bytes = readFileSync(tarball);
  const receipt = { version: info.version, sourceCommit: git('rev-parse', 'HEAD'), sourceTree: git('rev-parse', 'HEAD^{tree}'), tarball: basename(tarball), sha256: digest(bytes), integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, targets: info.targets, signed: info.signed, steps: {} };
  if (skipTests) receipt.testsSkipped = { reason: 'Maintainer requested --skip-tests during release preparation.' };
  save(receiptPath(), receipt);
  save(join(dir, 'artifact.json'), { ...receipt, steps: undefined });
  writeFileSync(join(dir, 'SHA256SUMS'), `${receipt.sha256}  ${receipt.tarball}\n`);
  const notesPath = join(root, 'docs', 'releases', `${receipt.version}.md`);
  const notes = existsSync(notesPath)
    ? readFileSync(notesPath, 'utf8').trimEnd()
    : `# Revcode ${receipt.version}\n\nDescribe changes and known limitations before publication.`;
  writeFileSync(join(dir, 'release-notes.md'), `${notes}\n\nSource: ${receipt.sourceCommit}\n\nRevcode binaries: ${receipt.signed ? 'signed' : 'unsigned'}.\n`);
  if (!skipTests) {
    run(process.execPath, ['scripts/deployment/test-tarball.mjs', tarball], { cwd: root, inherit: true });
    receipt.steps.tarballTest = true; save(receiptPath(), receipt);
  }
  console.log(`Prepared ${tarball}. Review release-notes.md, then run pnpm run release:publish.`);
}
function prepared() {
  const receipt = json(receiptPath()), dir = directory();
  if (receipt.version !== pkg().version || receipt.sourceCommit !== git('rev-parse', 'HEAD') || receipt.sourceTree !== git('rev-parse', 'HEAD^{tree}')) throw new Error('Prepared artifact source no longer matches HEAD.');
  const bytes = readFileSync(join(dir, receipt.tarball));
  if (digest(bytes) !== receipt.sha256 || `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== receipt.integrity) throw new Error('Prepared tarball changed.');
  assertSigning(config(), receipt);
  if (!receipt.steps.tarballTest && !receipt.testsSkipped?.reason) {
    run(process.execPath, ['scripts/deployment/test-tarball.mjs', join(dir, receipt.tarball)], { cwd: root, inherit: true });
    receipt.steps.tarballTest = true; save(receiptPath(), receipt);
  }
  const notes = readFileSync(join(dir, 'release-notes.md'), 'utf8');
  if (notes.includes('Describe changes and known limitations') || notes.trim().length < 30) throw new Error('Write release notes before publication.');
  return receipt;
}
function publish() {
  clean();
  const receipt = prepared(), cfg = config(), dir = directory(), tag = `v${receipt.version}`;
  const assets = [receipt.tarball, 'SHA256SUMS', 'artifact.json', 'release-notes.md'];
  const publication = Object.fromEntries(assets.map(file => [file, digest(readFileSync(join(dir, file)))]));
  const publicationPath = join(dir, 'publication.json');
  if (existsSync(publicationPath)) {
    if (JSON.stringify(json(publicationPath)) !== JSON.stringify(publication)) throw new Error('Release assets changed since publication started. Restore the recorded artifacts before resuming.');
  } else save(publicationPath, publication);
  // Recovery needs authentication and source checks, but never rebuilds or signs.
  gh('auth', 'status');
  const remote = git('ls-remote', cfg.remote, `refs/heads/${cfg.branch}`).split(/\s/)[0];
  if (remote !== receipt.sourceCommit) {
    const parent = git('rev-parse', `${receipt.sourceCommit}^`);
    if (remote !== parent || git('diff', '--name-only', parent, receipt.sourceCommit).split('\n').some(path => !versionFiles.includes(path))) throw new Error('Remote release branch changed. Merge the version PR and build/test from the final merged commit.');
    const pushed = run('git', ['push', cfg.remote, `HEAD:refs/heads/${cfg.branch}`], { cwd: root, allowFailure: true });
    if (pushed.status !== 0) {
      if (/GH006|GH013|protected branch|pull request/i.test(pushed.stderr + pushed.stdout)) { prepareVersionPR(); return; }
      throw new Error(`Release branch push failed: ${pushed.stderr}`);
    }
  }
  const tags = remoteTag(receipt.version);
  if (tags.length && !tags.some(line => line === `${receipt.sourceCommit}\trefs/tags/${tag}^{}`)) throw new Error('Remote tag conflicts with prepared source or is not annotated.');
  const local = run('git', ['rev-parse', '--verify', `refs/tags/${tag}`], { cwd: root, allowFailure: true });
  if (local.status === 0) {
    if (git('cat-file', '-t', `refs/tags/${tag}`) !== 'tag' || git('rev-parse', `${tag}^{commit}`) !== receipt.sourceCommit) throw new Error('Local release tag conflicts.');
  } else if (tags.length) git('fetch', cfg.remote, `refs/tags/${tag}:refs/tags/${tag}`);
  else git('tag', '-a', tag, receipt.sourceCommit, '-m', `Revcode ${receipt.version}`);
  if (!tags.length) git('push', cfg.remote, `refs/tags/${tag}`);
  receipt.steps.tag = true; save(receiptPath(), receipt);
  const releaseResult = run('gh', ['release', 'view', tag, '--repo', cfg.repository, '--json', 'isDraft,url'], { allowFailure: true });
  if (releaseResult.status !== 0) gh('release', 'create', tag, '--repo', cfg.repository, '--verify-tag', '--draft', '--title', `Revcode ${receipt.version}`, '--notes-file', join(dir, 'release-notes.md'));
  // GitHub's by-tag REST endpoint does not return draft releases.
  const releaseIdentity = JSON.parse(gh('release', 'view', tag, '--repo', cfg.repository, '--json', 'databaseId'));
  const remoteRelease = JSON.parse(gh('api', `repos/${cfg.repository}/releases/${releaseIdentity.databaseId}`));
  if (remoteRelease.tag_name !== tag) throw new Error('GitHub release tag conflicts.');
  if (remoteRelease.body.trim() !== readFileSync(join(dir, 'release-notes.md'), 'utf8').trim()) throw new Error('GitHub release notes conflict.');
  for (const file of assets) {
    const path = join(dir, file), asset = remoteRelease.assets.find(asset => asset.name === file);
    if (asset) {
      const sha = `sha256:${digest(readFileSync(path))}`;
      if (asset.digest !== sha) throw new Error(`GitHub asset integrity conflict: ${file}`);
    } else {
      if (!remoteRelease.draft) throw new Error(`Published GitHub release is missing ${file}.`);
      gh('release', 'upload', tag, path, '--repo', cfg.repository);
    }
  }
  receipt.steps.githubDraft = true; save(receiptPath(), receipt);
  const existing = registryVersion(receipt.version);
  if (existing && existing.integrity !== receipt.integrity) throw new Error('npm artifact conflicts with the prepared tarball.');
  if (!existing) run('npm', ['publish', join(dir, receipt.tarball), '--ignore-scripts', '--access', 'public', ...registryArgs()], { cwd: root, inherit: true });
  if (registryVersion(receipt.version)?.integrity !== receipt.integrity) throw new Error('npm publication integrity could not be verified. Retry release:resume.');
  receipt.steps.npm = true; save(receiptPath(), receipt);
  if (remoteRelease.draft) gh('release', 'edit', tag, '--repo', cfg.repository, '--draft=false');
  receipt.steps.github = true; save(receiptPath(), receipt);
  console.log(`https://www.npmjs.com/package/${pkg().name}/v/${receipt.version}\nhttps://github.com/${cfg.repository}/releases/tag/${tag}`);
}
async function main() {
  const [command, kind] = process.argv.slice(2);
  if (command === 'version') bump(kind);
  else if (command === 'check') preflight();
  else if (command === 'build') {
    if (kind && kind !== '--skip-tests') throw new Error('Usage: release.mjs build [--skip-tests]');
    build(kind === '--skip-tests');
  }
  else if (command === 'publish' || command === 'resume') publish();
  else if (command === 'release') {
    preflight(nextVersion(pkg().version, kind)); bump(kind); commitVersion();
    const cfg = config();
    // An explicit policy also works on private GitHub plans without the rules API.
    const versionPullRequest = cfg.versionPullRequest ?? JSON.parse(gh('api', `repos/${cfg.repository}/rules/branches/${cfg.branch}`)).some(rule => rule.type === 'pull_request');
    if (versionPullRequest) {
      prepareVersionPR();
      return;
    }
    build();
    // Publication follows once the maintainer completes the release notes.
  } else throw new Error('Usage: release.mjs version patch|minor|major | check | build | publish | resume | release patch|minor|major');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(`Release: ${error.message}`); process.exitCode = 1; });
