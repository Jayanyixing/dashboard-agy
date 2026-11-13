import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SAFE_ID_RE = /^[a-zA-Z0-9._-]+$/;

function resolveDataDir() {
  const pluginData = process.env.PLUGIN_DATA?.trim();
  if (pluginData) return pluginData;
  const appData =
    process.env.ANTIGRAVITY_APP_DATA_DIR?.trim() ||
    path.join(os.homedir(), '.gemini', 'antigravity');
  return path.join(appData, 'sidecar_data', 'dashboard-agy');
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function main() {
  const eventName = process.argv[2] || 'Unknown';
  let payload = {};
  try {
    const stdinText = fs.readFileSync(0, 'utf-8').trim();
    if (stdinText) payload = JSON.parse(stdinText);
  } catch {
    // Never break the agent loop on malformed stdin.
  }

  const conversationId =
    typeof payload.conversationId === 'string'
      ? payload.conversationId.trim()
      : '';
  if (!conversationId || !SAFE_ID_RE.test(conversationId)) {
    process.stdout.write('{}');
    return;
  }

  const nowMs = Date.now();
  const dataDir = resolveDataDir();
  const sessionsDir = path.join(dataDir, 'sessions');
  const sessionFile = path.join(sessionsDir, `${conversationId}.json`);
  const existing = readJsonSafe(sessionFile);

  const timings = Array.isArray(existing.timings)
    ? existing.timings.slice(-200)
    : [];

  let activeInvocation = existing.activeInvocation || null;

  if (eventName === 'PreInvocation') {
    activeInvocation = {
      invocationNum: payload.invocationNum ?? null,
      initialNumSteps: payload.initialNumSteps ?? null,
      startedAtMs: nowMs,
    };
  } else if (eventName === 'PostInvocation' || eventName === 'Stop') {
    if (activeInvocation && typeof activeInvocation.startedAtMs === 'number') {
      const durationMs = Math.max(0, nowMs - activeInvocation.startedAtMs);
      timings.push({
        event: eventName,
        invocationNum: activeInvocation.invocationNum,
        initialNumSteps: activeInvocation.initialNumSteps,
        startedAtMs: activeInvocation.startedAtMs,
        endedAtMs: nowMs,
        durationMs,
      });
      activeInvocation = null;
    }
  }

  const nextState = {
    conversationId,
    transcriptPath: payload.transcriptPath || existing.transcriptPath || null,
    modelName: payload.modelName || existing.modelName || null,
    workspacePaths: Array.isArray(payload.workspacePaths)
      ? payload.workspacePaths
      : existing.workspacePaths || [],
    lastEvent: eventName,
    lastEventAtMs: nowMs,
    terminationReason:
      payload.terminationReason || existing.terminationReason || null,
    activeInvocation,
    timings,
  };

  writeJsonAtomic(sessionFile, nextState);
  writeJsonAtomic(path.join(dataDir, 'active_conversation.json'), {
    conversationId,
    transcriptPath: nextState.transcriptPath,
    modelName: nextState.modelName,
    lastEvent: eventName,
    updatedAtMs: nowMs,
  });

  process.stdout.write('{}');
}

try {
  main();
} catch {
  process.stdout.write('{}');
}
