import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, openSync, closeSync, cpSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomic, digest, json, removeOwned, removePayload, save, verify, within } from './files.mjs';

export const ADDIN_ID = '696A5722-BBBD-40F7-8D33-AFD7807298A6';
export function compareBuild(a, b) {
  const parse = value => {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(value)) throw new Error(`Unknown Revit build: ${value}`);
    return value.split('.').map(Number);
  };
  const left = parse(a), right = parse(b);
  for (let i = 0; i < 4; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}
export function compatible(target, install) {
  return target.year === install.year && target.runtimeMajor === install.runtimeMajor &&
    compareBuild(install.build, target.minimumBuild) >= 0 && compareBuild(install.build, target.maximumBuildExclusive) < 0;
}
const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
export const manifest = assembly => `<?xml version="1.0" encoding="utf-8"?>\n<RevitAddIns><AddIn Type="Application"><Name>Revcode</Name><Assembly>${xml(assembly)}</Assembly><AddInId>${ADDIN_ID}</AddInId><FullClassName>Revcode.Revit.App</FullClassName><VendorId>REVC</VendorId><VendorDescription>Revcode local coding assistant</VendorDescription></AddIn></RevitAddIns>\n`;

export class Installer {
  constructor({ base, appData, programData, probe, manifestDetails, extract, checkpoint = () => {}, withLock }) {
    this.base = resolve(base);
    this.packages = within(this.base, join(this.base, 'packages'));
    this.appData = resolve(appData);
    this.programData = resolve(programData);
    Object.assign(this, { probe, manifestDetails, extract, checkpoint, withLock });
    this.statePath = within(this.base, join(this.base, 'installation.json'));
    this.journalPath = within(this.base, join(this.base, 'transaction.json'));
  }
  destination(year) {
    if (!['2025', '2026', '2027'].includes(year)) throw new Error(`Unsupported year: ${year}`);
    return within(this.appData, join(this.appData, 'Autodesk', 'Revit', 'Addins', year, 'Revcode.addin'));
  }
  payload(version) {
    if (!/^\d+\.\d+\.\d+(?:-local-[a-f0-9]{64})?$/.test(version)) throw new Error('Invalid installed version.');
    return within(this.packages, join(this.packages, version));
  }
  state() { return existsSync(this.statePath) ? json(this.statePath) : { schema: 1, years: {}, pending: null, dataSchema: null }; }
  locked(action) {
    if (this.withLock) return this.withLock(action);
    mkdirSync(this.base, { recursive: true });
    const lock = within(this.base, join(this.base, 'installer.lock'));
    if (existsSync(lock)) {
      const pid = Number(readFileSync(lock, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid installer lock; inspect ${lock} before removing it.`);
      try { process.kill(pid, 0); throw new Error(`Installer is already running (PID ${pid}).`); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      unlinkSync(lock);
    }
    const fd = openSync(lock, 'wx');
    try {
      writeFileSync(fd, String(process.pid));
      return action();
    } finally { closeSync(fd); unlinkSync(lock); }
  }
  recover() {
    if (!existsSync(this.journalPath)) return;
    if (this.probe().running) throw new Error('An interrupted transaction needs recovery. Close Revit and run revcode install.');
    const journal = json(this.journalPath);
    for (const change of journal.changes) {
      const path = this.destination(change.year);
      const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
      if (current !== change.before && current !== change.after) throw new Error(`Manifest changed outside the interrupted transaction: ${path}`);
    }
    for (const change of journal.changes) {
      const path = this.destination(change.year);
      if (change.before === null) { if (existsSync(path)) unlinkSync(path); }
      else atomic(path, change.before);
    }
    save(this.statePath, journal.before);
    unlinkSync(this.journalPath);
  }
  transaction(before, after, changes) {
    for (const change of changes) {
      const path = this.destination(change.year);
      mkdirSync(dirname(path), { recursive: true });
      const test = within(this.appData, `${path}.${randomUUID()}.probe`);
      writeFileSync(test, '', { flag: 'wx' }); unlinkSync(test);
    }
    if (this.probe().running) throw new Error('Revit started during preparation. Close it and retry activation.');
    save(this.journalPath, { before, after, changes });
    try {
      for (const change of changes) {
        const path = this.destination(change.year);
        const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
        if (current !== change.before) throw new Error(`Manifest changed during installation: ${path}`);
        if (change.after === null) { if (existsSync(path)) unlinkSync(path); }
        else atomic(path, change.after);
        this.checkpoint(change.year);
      }
      save(this.statePath, after);
      unlinkSync(this.journalPath);
    } catch (error) { this.recover(); throw error; }
  }
  checkOwnership(year, state) {
    const path = this.destination(year);
    if (!existsSync(path)) return null;
    const content = readFileSync(path, 'utf8');
    const tracked = state.years[year];
    if (tracked) {
      if (content !== tracked.manifest) throw new Error(`Registration was changed externally: ${path}`);
    } else {
      const details = this.manifestDetails(path);
      if (details.length !== 1 || details[0].id.toUpperCase() !== ADDIN_ID) throw new Error(`Another add-in owns ${path}`);
      // Adopt only legacy Revcode registrations pointing inside our package directory.
      within(this.packages, details[0].assembly);
    }
    return content;
  }
  conflicts(year) {
    for (const root of [this.programData, this.appData]) {
      const dir = within(root, join(root, 'Autodesk', 'Revit', 'Addins', year));
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir).filter(name => name.toLowerCase().endsWith('.addin'))) {
        const path = within(root, join(dir, name));
        if (path.toLowerCase() === this.destination(year).toLowerCase()) continue;
        const entries = this.manifestDetails(path);
        if (name.toLowerCase() === 'revcode.addin' || entries.some(item => item.id.toUpperCase() === ADDIN_ID)) {
          throw new Error(`Conflicting registration: ${path}. Ask its owner to remove or relocate it, then retry.`);
        }
      }
    }
  }
  stage(source, replaceSameVersion = false) {
    mkdirSync(this.packages, { recursive: true });
    const temp = within(this.packages, join(this.packages, `.stage-${randomUUID()}`));
    try {
      if (existsSync(join(source, 'payload.zip'))) {
        const index = json(join(source, 'payload-index.json'));
        if (digest(readFileSync(join(source, 'payload.zip'))) !== index.sha256) throw new Error('Distribution archive integrity mismatch.');
        this.extract(join(source, 'payload.zip'), temp);
      } else {
        verify(source);
        cpSync(source, temp, { recursive: true, dereference: false });
      }
      const info = verify(temp);
      const hash = digest(readFileSync(join(temp, 'integrity.json')));
      const localVersion = `${info.version}-local-${hash}`;
      const localTarget = this.payload(localVersion);
      const installedLocalSource = resolve(source).toLowerCase() === localTarget.toLowerCase();
      // Retrying a verified installed/pending build must keep its identity even
      // after cleanup has removed the original canonical version directory.
      let payloadVersion = installedLocalSource || (replaceSameVersion && existsSync(localTarget)) ? localVersion : info.version;
      let target = this.payload(payloadVersion);
      if (existsSync(target)) {
        verify(target);
        if (digest(readFileSync(join(target, 'integrity.json'))) !== hash) {
          if (payloadVersion === localVersion) throw new Error('Installed local build does not match its content identity.');
          if (!replaceSameVersion) throw new Error(`Version ${info.version} already exists with different contents.`);
          // Activate a separate verified build through the existing manifest transaction.
          // Keep the old payload intact for rollback and other Revit registrations.
          payloadVersion = localVersion;
          target = localTarget;
          renameSync(temp, target);
        }
      } else renameSync(temp, target);
      return { ...info, payloadVersion };
    } finally { if (existsSync(temp)) removeOwned(this.packages, temp); }
  }
  install(source, years, { replaceSameVersion = false } = {}) {
    return this.locked(() => {
      this.recover();
      const info = this.stage(source, replaceSameVersion), before = this.state(), after = structuredClone(before);
      if (before.dataSchema !== null && before.dataSchema !== info.dataSchema) throw new Error('This release needs an explicit user-data migration; automatic activation is disabled.');
      const requested = years ?? [...new Set(info.targets.map(target => target.year))];
      const system = this.probe(), pending = [], registered = [], changes = [];
      for (const year of requested) {
        this.destination(year);
        const installs = system.installs.filter(install => install.year === year);
        const choices = info.targets.filter(target => installs.length > 0 && installs.every(install => compatible(target, install)));
        if (choices.length !== 1) { pending.push({ year, reason: 'No unambiguous compatible Revit installation detected.' }); continue; }
        this.conflicts(year);
        const old = this.checkOwnership(year, before);
        if (system.running) { pending.push({ year, reason: 'Close Revit and run revcode install to activate.' }); continue; }
        const active = { version: info.version, target: choices[0].id, ...(info.payloadVersion !== info.version ? { payloadVersion: info.payloadVersion } : {}) };
        const nextManifest = manifest(join(this.payload(info.payloadVersion), 'addin', choices[0].id, 'Revcode.Revit.dll'));
        const previous = before.years[year]?.active;
        after.years[year] = { active, previous: previous && JSON.stringify(previous) !== JSON.stringify(active) ? previous : before.years[year]?.previous ?? null, manifest: nextManifest };
        changes.push({ year, before: old, after: nextManifest });
        registered.push(year);
      }
      after.pending = pending.length ? { version: info.version, ...(info.payloadVersion !== info.version ? { payloadVersion: info.payloadVersion } : {}), years: pending.map(item => item.year) } : null;
      if (registered.length) after.dataSchema = info.dataSchema;
      if (changes.length) this.transaction(before, after, changes);
      else save(this.statePath, after);
      return { version: info.version, registered, pending, ...this.cleanup(after) };
    });
  }
  rollback(years) {
    return this.locked(() => {
      this.recover();
      const system = this.probe();
      if (system.running) throw new Error('Close Revit before rollback.');
      const before = this.state(), after = structuredClone(before), changes = [];
      for (const year of years ?? Object.keys(before.years)) {
        const entry = before.years[year];
        if (!entry?.previous) throw new Error(`No retained previous release for Revit ${year}.`);
        const info = verify(this.payload(entry.previous.payloadVersion ?? entry.previous.version));
        const target = info.targets.find(target => target.id === entry.previous.target);
        const installs = system.installs.filter(install => install.year === year);
        if (!target || !installs.length || !installs.every(install => compatible(target, install)) || info.dataSchema !== before.dataSchema) throw new Error(`Previous release is incompatible with Revit ${year} or current user data.`);
        this.conflicts(year);
        const old = this.checkOwnership(year, before);
        const nextManifest = manifest(join(this.payload(entry.previous.payloadVersion ?? entry.previous.version), 'addin', entry.previous.target, 'Revcode.Revit.dll'));
        after.years[year] = { active: entry.previous, previous: entry.active, manifest: nextManifest };
        changes.push({ year, before: old, after: nextManifest });
      }
      after.pending = null;
      this.transaction(before, after, changes);
      return { rolledBack: changes.map(change => change.year) };
    });
  }
  uninstall(years) {
    return this.locked(() => {
      this.recover();
      if (this.probe().running) throw new Error('Close Revit before removal.');
      const before = this.state(), after = structuredClone(before), changes = [];
      for (const year of years ?? ['2025', '2026', '2027']) {
        const old = this.checkOwnership(year, before);
        if (old !== null) changes.push({ year, before: old, after: null });
        delete after.years[year];
      }
      after.pending = null;
      this.transaction(before, after, changes);
      return { unregistered: changes.map(change => change.year), ...this.cleanup(after) };
    });
  }
  cleanup(state = this.state()) {
    const retained = new Set(Object.values(state.years).flatMap(entry => [entry.active?.payloadVersion ?? entry.active?.version, entry.previous?.payloadVersion ?? entry.previous?.version]));
    if (state.pending) retained.add(state.pending.payloadVersion ?? state.pending.version);
    const removed = [], deferred = [];
    if (this.probe().running || !existsSync(this.packages)) return { removed, deferred };
    // Registration is the source of truth even if another installer edited it.
    // Preserve payloads referenced by manifests outside our state file.
    try {
      for (const root of [this.appData, this.programData]) for (const year of ['2025', '2026', '2027']) {
        const directory = within(root, join(root, 'Autodesk', 'Revit', 'Addins', year));
        if (!existsSync(directory)) continue;
        for (const name of readdirSync(directory).filter(name => name.toLowerCase().endsWith('.addin'))) {
          const entries = this.manifestDetails(within(root, join(directory, name)));
          for (const entry of entries) {
            const prefix = this.packages.toLowerCase() + '\\';
            const assembly = resolve(entry.assembly).toLowerCase();
            if (assembly.startsWith(prefix)) retained.add(assembly.slice(prefix.length).split('\\')[0]);
          }
        }
      }
    } catch (error) { return { removed, deferred: [{ reason: `Cleanup deferred: ${error.message}` }] }; }
    for (const version of readdirSync(this.packages).filter(version => /^\d+\.\d+\.\d+(?:-local-[a-f0-9]{64})?$/.test(version) && !retained.has(version))) {
      const path = this.payload(version);
      if (resolve(process.execPath).toLowerCase().startsWith(`${path.toLowerCase()}\\`)) {
        deferred.push({ version, reason: 'Run scripts/deployment/uninstall.ps1 from this payload to remove its running Node runtime.' });
        continue;
      }
      // Only verified managed payloads can be removed. Legacy directories remain untouched.
      try { removePayload(this.packages, path); removed.push(version); }
      catch (error) { deferred.push({ version, reason: error.message }); }
    }
    return { removed, deferred };
  }
  doctor() {
    const system = this.probe(), state = this.state(), problems = [], payloads = {};
    if (existsSync(this.journalPath)) problems.push('Interrupted transaction: close Revit and run revcode install.');
    for (const year of ['2025', '2026', '2027']) {
      if (state.years[year]) continue;
      try {
        this.conflicts(year);
        if (existsSync(this.destination(year))) problems.push(`Untracked registration for Revit ${year}; run install to adopt an owned legacy registration.`);
      } catch (error) { problems.push(error.message); }
    }
    for (const [year, entry] of Object.entries(state.years)) {
      try {
        this.conflicts(year);
        if (this.checkOwnership(year, state) === null) throw new Error(`Missing registration for Revit ${year}.`);
        const info = verify(this.payload(entry.active.payloadVersion ?? entry.active.version));
        payloads[entry.active.version] = { nodeVersion: info.nodeVersion, dataSchema: info.dataSchema };
        const target = info.targets.find(target => target.id === entry.active.target);
        const installs = system.installs.filter(install => install.year === year);
        if (!target || !installs.length || !installs.every(install => compatible(target, install))) throw new Error(`Active payload is incompatible with Revit ${year}.`);
      } catch (error) { problems.push(error.message); }
    }
    return { ...system, state, payloads, problems };
  }
}
