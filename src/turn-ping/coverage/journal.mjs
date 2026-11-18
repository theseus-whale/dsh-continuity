import fs from 'node:fs';
import path from 'node:path';
import { turnPingRoot } from '../storage.mjs';

const readJson = async (file, fallback) => { try { return JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch { return fallback; } };
const writeJson = async (file, value) => {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.promises.rename(temp, file);
};
const appendJsonl = async (file, value) => {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.appendFile(file, `${JSON.stringify(value)}\n`, 'utf8');
};
const readJsonl = async (file) => {
  try { return (await fs.promises.readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
  catch { return []; }
};

export function coveragePaths({ home, sessionId }) {
  const root = path.join(turnPingRoot({ home, sessionId }), 'coverage');
  return {
    root,
    manifestFile: path.join(root, 'manifest.json'),
    journalFile: path.join(root, 'fold-journal.jsonl'),
    jobsFile: path.join(root, 'jobs.jsonl'),
    planFile: path.join(root, 'plan.json'),
    ledgerFile: path.join(root, 'ledger.jsonl'),
  };
}

export function foldIdentity(fold) {
  return fold?.foldId ?? fold?.compactionId ?? JSON.stringify(fold ?? {});
}

export function createCoverageJournal({ home, sessionId }) {
  const paths = coveragePaths({ home, sessionId });
  const stage = {
    paths,
    async manifest() { return readJson(paths.manifestFile, null); },
    async writeManifest(manifest) { await writeJson(paths.manifestFile, manifest); },
    async journal() { return readJsonl(paths.journalFile); },
    async appendFold(fold) {
      const rows = await stage.journal();
      const key = foldIdentity(fold);
      if (rows.some((row) => row.foldKey === key)) return false;
      await appendJsonl(paths.journalFile, { at: new Date().toISOString(), foldKey: key, ...fold });
      return true;
    },
    async jobs() { return readJsonl(paths.jobsFile); },
    async appendJob(job) {
      const rows = await stage.jobs();
      const key = job.foldId ?? job.jobId ?? job.foldKey ?? JSON.stringify(job);
      if (rows.some((row) => (row.foldId ?? row.jobId ?? row.foldKey ?? JSON.stringify(row)) === key)) return false;
      await appendJsonl(paths.jobsFile, { ...job, jobKey: key });
      return true;
    },
    async writePlan(plan) { await writeJson(paths.planFile, plan); },
    async plan() { return readJson(paths.planFile, null); },
    async ledger(entry) { await appendJsonl(paths.ledgerFile, entry); },
  };
  return stage;
}
