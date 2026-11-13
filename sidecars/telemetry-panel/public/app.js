const searchParams = new URLSearchParams(window.location.search);
const urlToken = searchParams.get('token') || '';
const initialConversationId =
  (window.sidecar && window.sidecar.conversationId) ||
  searchParams.get('conversationId') ||
  '';

const state = {
  selectedConversationId: initialConversationId,
  windowSizeOverride: '',
  sortDesc: true,
  lastSnapshot: null,
  eventSource: null,
  reconnectTimer: null,
};

const els = {
  liveDot: document.getElementById('live-dot'),
  syncStatus: document.getElementById('sync-status'),
  modelLine: document.getElementById('model-line'),
  convSelect: document.getElementById('conversation-select'),
  windowSelect: document.getElementById('window-select'),
  dshTurnsSpeed: document.getElementById('dsh-turns-speed'),
  dshTokensCache: document.getElementById('dsh-tokens-cache'),
  dshContextPct: document.getElementById('dsh-context-pct'),
  miniRingFill: document.getElementById('mini-ring-fill'),
  bigRingFill: document.getElementById('big-ring-fill'),
  contextStateBadge: document.getElementById('context-state-badge'),
  contextPctValue: document.getElementById('context-pct-value'),
  contextFraction: document.getElementById('context-fraction'),
  contextRemaining: document.getElementById('context-remaining'),
  contextPeak: document.getElementById('context-peak'),
  tokenCallsNote: document.getElementById('token-calls-note'),
  totalTokensValue: document.getElementById('total-tokens-value'),
  cacheReadValue: document.getElementById('cache-read-value'),
  uncachedInputValue: document.getElementById('uncached-input-value'),
  outputTokensValue: document.getElementById('output-tokens-value'),
  cacheStateBadge: document.getElementById('cache-state-badge'),
  cacheHitValue: document.getElementById('cache-hit-value'),
  cacheHitBar: document.getElementById('cache-hit-bar'),
  latestCacheValue: document.getElementById('latest-cache-value'),
  totalInputValue: document.getElementById('total-input-value'),
  throughputModeNote: document.getElementById('throughput-mode-note'),
  turnsStepsValue: document.getElementById('turns-steps-value'),
  avgSpeedValue: document.getElementById('avg-speed-value'),
  latestSpeedValue: document.getElementById('latest-speed-value'),
  durationToolsValue: document.getElementById('duration-tools-value'),
  turnsCountNote: document.getElementById('turns-count-note'),
  sortToggleBtn: document.getElementById('sort-toggle-btn'),
  turnsTbody: document.getElementById('turns-tbody'),
  turnsTable: document.getElementById('turns-table'),
  emptyState: document.getElementById('empty-state'),
};

function fmtTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.round(n));
}

function fmtPct(pct, decimals = 1) {
  if (!Number.isFinite(pct)) return '--%';
  return `${pct.toFixed(decimals).replace(/\.0+$/, '')}%`;
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${sec}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

function setRingProgress(circleEl, radius, pct) {
  if (!circleEl) return;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  circleEl.style.strokeDasharray = `${circumference}`;
  circleEl.style.strokeDashoffset = `${circumference * (1 - clamped / 100)}`;

  circleEl.classList.remove('is-warn', 'is-bad');
  if (clamped >= 85) {
    circleEl.classList.add('is-bad');
  } else if (clamped >= 60) {
    circleEl.classList.add('is-warn');
  }
}

function setConnectionStatus(kind, text) {
  els.syncStatus.classList.remove('is-ok', 'is-bad');
  els.liveDot.classList.remove('is-offline', 'is-busy');
  if (kind === 'ok') {
    els.syncStatus.classList.add('is-ok');
  } else if (kind === 'bad') {
    els.syncStatus.classList.add('is-bad');
    els.liveDot.classList.add('is-offline');
  }
  els.syncStatus.textContent = text;
}

function renderConversationOptions(conversations, activeId) {
  const prevValue = state.selectedConversationId || activeId || '';
  const fragment = document.createDocumentFragment();
  if (!conversations || conversations.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '暂无会话';
    fragment.appendChild(opt);
  } else {
    for (const item of conversations) {
      const opt = document.createElement('option');
      opt.value = item.conversationId;
      const prefix = item.isActiveHook ? '● ' : '';
      opt.textContent = `${prefix}${item.title} (${item.conversationId.slice(0, 6)})`;
      if (item.conversationId === (prevValue || activeId)) {
        opt.selected = true;
      }
      fragment.appendChild(opt);
    }
  }
  els.convSelect.replaceChildren(fragment);
  if (!state.selectedConversationId && activeId) {
    state.selectedConversationId = activeId;
    els.convSelect.value = activeId;
  }
}

function createTextCell(text, className = '') {
  const td = document.createElement('td');
  if (className) td.className = className;
  td.textContent = text;
  return td;
}

function renderTurnsTable(turns) {
  const list = Array.isArray(turns) ? [...turns] : [];
  if (state.sortDesc) list.reverse();

  els.turnsCountNote.textContent = `共 ${list.length} 轮对话`;
  els.sortToggleBtn.textContent = state.sortDesc ? '倒序（最新在前）' : '正序（第 1 轮在前）';

  if (list.length === 0) {
    els.turnsTable.hidden = true;
    els.emptyState.hidden = false;
    els.turnsTbody.replaceChildren();
    return;
  }

  els.turnsTable.hidden = false;
  els.emptyState.hidden = true;

  const fragment = document.createDocumentFragment();
  for (const turn of list) {
    const tr = document.createElement('tr');
    tr.appendChild(createTextCell(`#${turn.turnNumber}`, 'cell-mono'));

    const promptTd = createTextCell(turn.prompt || `第 ${turn.turnNumber} 轮`, 'cell-prompt');
    promptTd.title = turn.prompt || '';
    tr.appendChild(promptTd);

    tr.appendChild(createTextCell(`${turn.stepCount} 步`, 'cell-mono'));
    tr.appendChild(createTextCell(fmtTokens(turn.totalTokens), 'cell-mono'));
    tr.appendChild(
      createTextCell(
        turn.cacheHitRate !== null ? fmtPct(turn.cacheHitRate) : '--',
        'cell-mono'
      )
    );
    tr.appendChild(
      createTextCell(
        turn.endContextTokens > 0 ? fmtPct(turn.endContextPercent) : '--',
        'cell-mono'
      )
    );
    tr.appendChild(
      createTextCell(
        turn.estimatedTokPerSec !== null ? `~${Math.round(turn.estimatedTokPerSec)}/s` : '--',
        'cell-mono'
      )
    );
    fragment.appendChild(tr);
  }
  els.turnsTbody.replaceChildren(fragment);
}

function renderSnapshot(snapshot) {
  state.lastSnapshot = snapshot;
  renderConversationOptions(snapshot.conversations, snapshot.activeConversationId);

  const t = snapshot.telemetry;
  const s = t.summary;

  const activeLabel = s.isInvocationActive ? ' · 生成中' : '';
  els.modelLine.textContent = `模型：${t.modelName} · 窗口 ${t.windowLabel}${activeLabel}`;
  if (s.isInvocationActive) {
    els.liveDot.classList.add('is-busy');
  } else {
    els.liveDot.classList.remove('is-busy');
  }

  const speedText =
    s.avgTokPerSec !== null ? `~${Math.round(s.avgTokPerSec)} tok/s` : '-- tok/s';
  const cacheText =
    s.cacheHitRate !== null ? `缓存命中 ${fmtPct(s.cacheHitRate, 0)}` : '缓存命中 --%';
  const ctxPctInt = fmtPct(s.contextUsagePercent, 1);

  els.dshTurnsSpeed.textContent = `${s.totalTurns} 轮 ${s.totalSteps} 步 · ${speedText}`;
  els.dshTokensCache.textContent = `${fmtTokens(s.grandTotalTokens)} tok · ${cacheText}`;
  els.dshContextPct.textContent = ctxPctInt;

  setRingProgress(els.miniRingFill, 7, s.contextUsagePercent);
  setRingProgress(els.bigRingFill, 36, s.contextUsagePercent);

  els.contextPctValue.textContent = fmtPct(s.contextUsagePercent, 1);
  els.contextFraction.textContent = `${fmtTokens(s.currentContextTokens)} / ${fmtTokens(t.windowSize)}`;
  const remaining = Math.max(0, t.windowSize - s.currentContextTokens);
  const remPct = Math.max(0, 100 - s.contextUsagePercent);
  els.contextRemaining.textContent = `剩余 ${fmtTokens(remaining)} (${fmtPct(remPct, 1)})`;
  els.contextPeak.textContent = `峰值：${fmtTokens(s.peakContextTokens)} tok`;

  els.contextStateBadge.classList.remove('is-ok', 'is-warn', 'is-bad');
  if (s.contextUsagePercent >= 85) {
    els.contextStateBadge.classList.add('is-bad');
    els.contextStateBadge.textContent = '◆ 接近上限';
  } else if (s.contextUsagePercent >= 60) {
    els.contextStateBadge.classList.add('is-warn');
    els.contextStateBadge.textContent = '▲ 关注';
  } else {
    els.contextStateBadge.classList.add('is-ok');
    els.contextStateBadge.textContent = '● 正常';
  }

  els.tokenCallsNote.textContent = `${s.modelCallCount} 次模型调用`;
  els.totalTokensValue.textContent = `${fmtTokens(s.grandTotalTokens)} tok`;
  els.cacheReadValue.textContent = fmtTokens(s.cacheReadTokens);
  els.uncachedInputValue.textContent = fmtTokens(s.uncachedInputTokens);
  els.outputTokensValue.textContent = fmtTokens(s.outputTokens);

  const cachePct = s.cacheHitRate;
  els.cacheHitValue.textContent = cachePct !== null ? fmtPct(cachePct, 1) : '--%';
  els.cacheHitBar.style.inlineSize = `${cachePct !== null ? Math.min(100, cachePct) : 0}%`;
  els.latestCacheValue.textContent =
    s.latestStepCacheHitRate !== null ? fmtPct(s.latestStepCacheHitRate, 1) : '--%';
  els.totalInputValue.textContent = fmtTokens(s.totalInputTokens);

  els.cacheStateBadge.classList.remove('is-ok', 'is-warn', 'is-bad');
  if (cachePct === null) {
    els.cacheStateBadge.textContent = '● 待记录';
  } else if (cachePct >= 75) {
    els.cacheStateBadge.classList.add('is-ok');
    els.cacheStateBadge.textContent = '● 高命中';
  } else if (cachePct >= 40) {
    els.cacheStateBadge.classList.add('is-warn');
    els.cacheStateBadge.textContent = '▲ 中等';
  } else {
    els.cacheStateBadge.classList.add('is-bad');
    els.cacheStateBadge.textContent = '◆ 较低';
  }

  els.throughputModeNote.textContent =
    s.throughputSource === 'hook_ms' ? 'Hook 毫秒级估算' : '端到端估算';
  els.turnsStepsValue.textContent = `${s.totalTurns} 轮 / ${s.totalSteps} 步`;
  els.avgSpeedValue.textContent =
    s.avgTokPerSec !== null ? `~${Math.round(s.avgTokPerSec)} tok/s` : '-- tok/s';
  els.latestSpeedValue.textContent =
    s.latestStepTokPerSec !== null ? `~${Math.round(s.latestStepTokPerSec)} tok/s` : '-- tok/s';
  els.durationToolsValue.textContent = `${fmtDuration(s.sessionDurationMs)} · ${s.toolStepCount} 工具步`;

  renderTurnsTable(t.turns);
}

function buildApiUrl(endpoint) {
  const url = new URL(endpoint, window.location.href);
  if (urlToken) url.searchParams.set('token', urlToken);
  if (state.selectedConversationId) {
    url.searchParams.set('conversationId', state.selectedConversationId);
  }
  if (state.windowSizeOverride) {
    url.searchParams.set('windowSize', state.windowSizeOverride);
  }
  return url.toString();
}

async function fetchSnapshotOnce() {
  try {
    const fetcher =
      window.sidecar && typeof window.sidecar.fetch === 'function'
        ? window.sidecar.fetch.bind(window.sidecar)
        : fetch;
    const res = await fetcher(buildApiUrl('/api/telemetry'));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderSnapshot(data);
  } catch (err) {
    setConnectionStatus('bad', `拉取失败 (${err.message})`);
  }
}

function connectEvents() {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }

  const es = new EventSource(buildApiUrl('/api/events'));
  state.eventSource = es;

  es.onopen = () => {
    setConnectionStatus('ok', '实时同步中');
  };

  es.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      renderSnapshot(payload);
    } catch {
      // Ignore malformed SSE event.
    }
  };

  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      setConnectionStatus('bad', '连接断开，重连中…');
      state.reconnectTimer = setTimeout(connectEvents, 1500);
    }
  };
}

els.convSelect.addEventListener('change', () => {
  state.selectedConversationId = els.convSelect.value;
  connectEvents();
  fetchSnapshotOnce();
});

els.windowSelect.addEventListener('change', () => {
  state.windowSizeOverride = els.windowSelect.value;
  connectEvents();
  fetchSnapshotOnce();
});

els.sortToggleBtn.addEventListener('click', () => {
  state.sortDesc = !state.sortDesc;
  if (state.lastSnapshot) {
    renderTurnsTable(state.lastSnapshot.telemetry.turns);
  }
});

fetchSnapshotOnce();
connectEvents();
