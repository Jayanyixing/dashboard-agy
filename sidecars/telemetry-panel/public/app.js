const searchParams = new URLSearchParams(window.location.search);
const urlToken = searchParams.get('token') || '';
const initialConversationId =
  (window.sidecar && window.sidecar.conversationId) ||
  searchParams.get('conversationId') ||
  '';

const supportsScrollTimeline =
  typeof CSS !== 'undefined' &&
  typeof CSS.supports === 'function' &&
  CSS.supports('animation-timeline', 'scroll()');

const prefersReducedMotion =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)');

const state = {
  homeConversationId: initialConversationId,
  selectedConversationId: initialConversationId,
  windowSizeOverride: '',
  sortDesc: true,
  expandedTurns: new Set(),
  highlightedTurn: null,
  connectionState: 'connecting',
  connectionErrorText: '',
  lastSnapshot: null,
  lastConversationsKey: '',
  lastTrajectoryKey: '',
  lastTurnsKey: '',
  eventSource: null,
  reconnectTimer: null,
};

const els = {
  syncStatus: document.getElementById('sync-status'),
  syncStatusText: document.getElementById('sync-status-text'),
  modelNameText: document.getElementById('model-name-text'),
  windowCapText: document.getElementById('window-cap-text'),
  convTrigger: document.getElementById('conversation-trigger'),
  convCurrentLabel: document.getElementById('conversation-current-label'),
  convPopover: document.getElementById('conversation-popover'),
  convPopoverCount: document.getElementById('conv-popover-count'),
  convList: document.getElementById('conversation-list'),
  windowSelect: document.getElementById('window-select'),
  dshTurnsSpeed: document.getElementById('dsh-turns-speed'),
  dshSpeedVal: document.getElementById('dsh-speed-val'),
  dshTokensCache: document.getElementById('dsh-tokens-cache'),
  dshCacheVal: document.getElementById('dsh-cache-val'),
  dshContextPct: document.getElementById('dsh-context-pct'),
  miniRingFill: document.getElementById('mini-ring-fill'),
  bigRingFill: document.getElementById('big-ring-fill'),
  contextStateBadge: document.getElementById('context-state-badge'),
  contextPctValue: document.getElementById('context-pct-value'),
  contextUsedValue: document.getElementById('context-used-value'),
  contextCapValue: document.getElementById('context-cap-value'),
  contextRemaining: document.getElementById('context-remaining'),
  contextPeak: document.getElementById('context-peak'),
  tokenCallsNote: document.getElementById('token-calls-note'),
  totalTokensValue: document.getElementById('total-tokens-value'),
  mixCacheSeg: document.getElementById('mix-cache-seg'),
  mixUncachedSeg: document.getElementById('mix-uncached-seg'),
  mixOutputSeg: document.getElementById('mix-output-seg'),
  cacheReadValue: document.getElementById('cache-read-value'),
  uncachedInputValue: document.getElementById('uncached-input-value'),
  outputTokensValue: document.getElementById('output-tokens-value'),
  cacheStateBadge: document.getElementById('cache-state-badge'),
  cacheHitValue: document.getElementById('cache-hit-value'),
  latestCacheValue: document.getElementById('latest-cache-value'),
  throughputModeNote: document.getElementById('throughput-mode-note'),
  turnsStepsValue: document.getElementById('turns-steps-value'),
  avgSpeedValue: document.getElementById('avg-speed-value'),
  latestSpeedValue: document.getElementById('latest-speed-value'),
  stepsSplitValue: document.getElementById('steps-split-value'),
  durationValue: document.getElementById('duration-value'),
  trajPanel: document.getElementById('trajectory-panel'),
  trajReadout: document.getElementById('traj-readout'),
  trajArea: document.getElementById('traj-area'),
  trajPolyline: document.getElementById('traj-polyline'),
  trajHits: document.getElementById('traj-hits'),
  trajAxisStart: document.getElementById('traj-axis-start'),
  trajAxisMid: document.getElementById('traj-axis-mid'),
  trajAxisEnd: document.getElementById('traj-axis-end'),
  turnsCountNote: document.getElementById('turns-count-note'),
  sortToggleBtn: document.getElementById('sort-toggle-btn'),
  turnsTbody: document.getElementById('turns-tbody'),
  turnsTable: document.getElementById('turns-table'),
  emptyState: document.getElementById('empty-state'),
};

const truncationObserver =
  !supportsScrollTimeline && typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver((entries) => {
        for (const { target } of entries) {
          target.classList.toggle('truncated', target.scrollWidth > target.clientWidth);
        }
      })
    : null;

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

function updateUnifiedStatusBadge() {
  const isActive = Boolean(state.lastSnapshot?.telemetry?.summary?.isInvocationActive);
  els.syncStatus.classList.remove('is-ok', 'is-busy', 'is-bad');

  if (state.connectionState === 'bad') {
    els.syncStatus.classList.add('is-bad');
    els.syncStatusText.textContent = state.connectionErrorText || '连接断开，重连中…';
  } else if (state.connectionState === 'ok') {
    if (isActive) {
      els.syncStatus.classList.add('is-busy');
      els.syncStatusText.textContent = '生成中';
    } else {
      els.syncStatus.classList.add('is-ok');
      els.syncStatusText.textContent = '实时同步';
    }
  } else {
    els.syncStatusText.textContent = '连接中…';
  }
}

function selectConversation(conversationId) {
  if (!conversationId || conversationId === state.selectedConversationId) {
    els.convPopover?.hidePopover?.();
    return;
  }
  state.selectedConversationId = conversationId;
  state.expandedTurns.clear();
  state.highlightedTurn = null;
  state.lastTurnsKey = '';
  state.lastTrajectoryKey = '';
  state.lastConversationsKey = '';
  els.convPopover?.hidePopover?.();
  connectEvents();
  fetchSnapshotOnce();
}

function renderConversationOptions(conversations, activeId) {
  const list = Array.isArray(conversations) ? conversations : [];
  if (!state.homeConversationId && activeId) {
    state.homeConversationId = activeId;
  }
  if (!state.selectedConversationId && activeId) {
    state.selectedConversationId = activeId;
  }
  const targetSelected = state.selectedConversationId || activeId || '';
  const homeId = state.homeConversationId || activeId || '';
  const convKey = JSON.stringify({
    activeId,
    homeId,
    targetSelected,
    items: list.map((c) => [c.conversationId, c.title, c.isActiveHook]),
  });
  if (convKey === state.lastConversationsKey) return;
  state.lastConversationsKey = convKey;

  const selectedItem = list.find((c) => c.conversationId === targetSelected);

  if (list.length === 0) {
    els.convCurrentLabel.textContent = '暂无会话';
  } else if (!selectedItem || selectedItem.conversationId === homeId || selectedItem.isActiveHook) {
    els.convCurrentLabel.textContent = '当前窗口';
  } else {
    els.convCurrentLabel.textContent = `历史 (${selectedItem.conversationId.slice(0, 6)})`;
  }

  els.convTrigger.title = selectedItem
    ? `${selectedItem.title} (${selectedItem.conversationId})`
    : '切换会话';
  els.convPopoverCount.textContent = `${list.length} 个会话`;

  const fragment = document.createDocumentFragment();
  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'conv-empty';
    empty.textContent = '暂无可用会话记录';
    fragment.appendChild(empty);
  } else {
    for (const item of list) {
      const isSelected = item.conversationId === targetSelected;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'conv-option';
      btn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
      btn.addEventListener('click', () => selectConversation(item.conversationId));

      const main = document.createElement('div');
      main.className = 'conv-option-main';

      const dot = document.createElement('span');
      dot.className = item.isActiveHook ? 'conv-option-dot is-active' : 'conv-option-dot';
      dot.setAttribute('aria-hidden', 'true');
      main.appendChild(dot);

      const textCol = document.createElement('div');
      textCol.className = 'conv-option-text';

      const titleEl = document.createElement('span');
      titleEl.className = 'conv-option-title';
      titleEl.textContent = item.title;
      textCol.appendChild(titleEl);

      const metaEl = document.createElement('span');
      metaEl.className = 'conv-option-meta';
      metaEl.textContent = item.conversationId.slice(0, 8);
      if (item.conversationId === homeId || item.isActiveHook) {
        const tag = document.createElement('span');
        tag.className = 'conv-active-tag';
        tag.textContent = item.conversationId === homeId ? '当前窗口' : '活跃';
        metaEl.appendChild(tag);
      }
      textCol.appendChild(metaEl);

      main.appendChild(textCol);
      btn.appendChild(main);

      if (isSelected) {
        const check = document.createElement('span');
        check.className = 'conv-option-check';
        check.textContent = '✓';
        check.setAttribute('aria-hidden', 'true');
        btn.appendChild(check);
      }

      fragment.appendChild(btn);
    }
  }
  els.convList.replaceChildren(fragment);
}

function formatTrajectorySummary(turns, maxTurnTokens, latestCtxPct) {
  if (!turns.length) return '--';
  const rangeText = turns.length === 1 ? '第 1 轮' : `第 1–${turns.length} 轮`;
  return `${rangeText} · 单轮峰值 ${fmtTokens(maxTurnTokens)} · 上下文 ${fmtPct(latestCtxPct, 1)}`;
}

function formatTurnHoverReadout(turn) {
  const cacheStr = turn.cacheHitRate !== null ? fmtPct(turn.cacheHitRate, 1) : '--';
  const ctxStr = turn.endContextTokens > 0 ? fmtPct(turn.endContextPercent, 1) : '--';
  return `#${turn.turnNumber} · ${fmtTokens(turn.totalTokens)} tok · 命中 ${cacheStr} · 上下文 ${ctxStr}`;
}

function focusTurnFromTrajectory(turnNumber) {
  const wasHighlighted = state.highlightedTurn === turnNumber;
  if (wasHighlighted && state.expandedTurns.has(turnNumber)) {
    state.expandedTurns.delete(turnNumber);
    state.highlightedTurn = null;
  } else {
    state.highlightedTurn = turnNumber;
    state.expandedTurns.add(turnNumber);
  }
  if (state.lastSnapshot) {
    renderTrajectory(state.lastSnapshot.telemetry.turns, state.lastSnapshot.telemetry.summary, true);
    renderTurnsTable(state.lastSnapshot.telemetry.turns, true);
    if (state.highlightedTurn !== null) {
      const targetRow = els.turnsTbody.querySelector(`tr[data-turn="${turnNumber}"]`);
      targetRow?.scrollIntoView({
        block: 'nearest',
        behavior: prefersReducedMotion?.matches ? 'auto' : 'smooth',
      });
    }
  }
}

function renderTrajectory(turns, summary, forceRender = false) {
  const list = Array.isArray(turns) ? turns : [];
  if (list.length === 0) {
    els.trajPanel.hidden = true;
    state.lastTrajectoryKey = '';
    return;
  }
  els.trajPanel.hidden = false;

  const trajKey = JSON.stringify({
    highlighted: state.highlightedTurn,
    rows: list.map((t) => [t.turnNumber, t.totalTokens, t.endContextPercent, t.cacheHitRate]),
  });
  if (!forceRender && trajKey === state.lastTrajectoryKey) return;
  state.lastTrajectoryKey = trajKey;

  const n = list.length;
  const maxTurnTokens = Math.max(1, ...list.map((t) => t.totalTokens || 0));
  const peakCtxPct = Math.max(0, ...list.map((t) => t.endContextPercent || 0));
  const ctxScaleMax = Math.max(20, Math.min(100, peakCtxPct * 1.15));
  const defaultReadout = formatTrajectorySummary(
    list,
    maxTurnTokens,
    summary?.contextUsagePercent ?? peakCtxPct
  );

  const highlightedObj =
    state.highlightedTurn !== null
      ? list.find((t) => t.turnNumber === state.highlightedTurn)
      : null;
  els.trajReadout.textContent = highlightedObj
    ? formatTurnHoverReadout(highlightedObj)
    : defaultReadout;

  els.trajAxisStart.textContent = `#${list[0].turnNumber}`;
  els.trajAxisMid.textContent = n >= 5 ? `#${list[Math.floor((n - 1) / 2)].turnNumber}` : '';
  els.trajAxisEnd.textContent = n > 1 ? `#${list[n - 1].turnNumber}` : '';

  const polyPoints = [];
  const fragment = document.createDocumentFragment();

  for (let i = 0; i < n; i++) {
    const turn = list[i];
    const normCtx = Math.max(0, Math.min(1, (turn.endContextPercent || 0) / ctxScaleMax));
    const xSvg = ((i + 0.5) / n) * 1000;
    const ySvg = 88 - normCtx * 73;
    polyPoints.push(`${xSvg.toFixed(1)},${ySvg.toFixed(1)}`);

    const barPct =
      turn.totalTokens > 0 ? Math.max(6, Math.round((turn.totalTokens / maxTurnTokens) * 100)) : 0;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'traj-hit';
    btn.setAttribute('aria-pressed', state.highlightedTurn === turn.turnNumber ? 'true' : 'false');
    btn.setAttribute(
      'aria-label',
      `第 ${turn.turnNumber} 轮：${fmtTokens(turn.totalTokens)} Token，缓存命中 ${turn.cacheHitRate !== null ? fmtPct(turn.cacheHitRate, 1) : '未知'}，上下文 ${turn.endContextTokens > 0 ? fmtPct(turn.endContextPercent, 1) : '未知'}`
    );

    const bar = document.createElement('span');
    bar.className = 'traj-bar';
    bar.style.blockSize = `${barPct}%`;
    btn.appendChild(bar);

    const dot = document.createElement('span');
    dot.className = 'traj-dot';
    dot.style.insetBlockEnd = `${(normCtx * 100).toFixed(1)}%`;
    btn.appendChild(dot);

    const showHover = () => {
      els.trajReadout.textContent = formatTurnHoverReadout(turn);
    };
    const restoreDefault = () => {
      const active =
        state.highlightedTurn !== null
          ? list.find((t) => t.turnNumber === state.highlightedTurn)
          : null;
      els.trajReadout.textContent = active ? formatTurnHoverReadout(active) : defaultReadout;
    };

    btn.addEventListener('mouseenter', showHover);
    btn.addEventListener('focus', showHover);
    btn.addEventListener('mouseleave', restoreDefault);
    btn.addEventListener('blur', restoreDefault);
    btn.addEventListener('click', () => focusTurnFromTrajectory(turn.turnNumber));

    fragment.appendChild(btn);
  }

  if (n >= 2) {
    const firstX = ((0.5 / n) * 1000).toFixed(1);
    const lastX = (((n - 0.5) / n) * 1000).toFixed(1);
    els.trajPolyline.setAttribute('points', polyPoints.join(' '));
    els.trajArea.setAttribute('points', `${firstX},88 ${polyPoints.join(' ')} ${lastX},88`);
  } else {
    els.trajPolyline.setAttribute('points', '');
    els.trajArea.setAttribute('points', '');
  }

  els.trajHits.replaceChildren(fragment);
}

function createTextCell(text, className = '') {
  const td = document.createElement('td');
  if (className) td.className = className;
  td.textContent = text;
  return td;
}

function createChevronSvg() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M4.2 2.5L7.8 6L4.2 9.5');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

function createDetailMetric(label, value) {
  const span = document.createElement('span');
  span.append(`${label} `);
  const strong = document.createElement('strong');
  strong.textContent = value;
  span.appendChild(strong);
  return span;
}

function createTurnDetailRow(turn) {
  const tr = document.createElement('tr');
  tr.className = 'turn-detail-row';

  const td = document.createElement('td');
  td.colSpan = 7;

  const box = document.createElement('div');
  box.className = 'turn-detail-box';

  const promptP = document.createElement('p');
  promptP.className = 'detail-prompt-full';
  promptP.textContent = turn.promptFull || turn.prompt || `第 ${turn.turnNumber} 轮`;
  box.appendChild(promptP);

  const metrics = document.createElement('div');
  metrics.className = 'detail-metrics';
  metrics.appendChild(createDetailMetric('缓存读取', fmtTokens(turn.cacheReadTokens)));
  metrics.appendChild(createDetailMetric('非缓存输入', fmtTokens(turn.uncachedInputTokens)));
  metrics.appendChild(createDetailMetric('模型输出', fmtTokens(turn.outputTokens)));
  metrics.appendChild(
    createDetailMetric('调用 / 工具', `${turn.modelCallCount} / ${turn.toolStepCount}`)
  );
  if (turn.endContextTokens > 0) {
    metrics.appendChild(createDetailMetric('结束上下文', fmtTokens(turn.endContextTokens)));
  }
  if (turn.durationMs !== null) {
    metrics.appendChild(createDetailMetric('轮次耗时', fmtDuration(turn.durationMs)));
  }

  box.appendChild(metrics);
  td.appendChild(box);
  tr.appendChild(td);
  return tr;
}

function renderTurnsTable(turns, forceRender = false) {
  const rawList = Array.isArray(turns) ? [...turns] : [];
  const list = state.sortDesc ? rawList.reverse() : rawList;

  els.turnsCountNote.textContent = `共 ${list.length} 轮对话`;
  els.sortToggleBtn.textContent = state.sortDesc ? '倒序（最新在前）' : '正序（第 1 轮在前）';

  const turnsKey = JSON.stringify({
    sortDesc: state.sortDesc,
    highlighted: state.highlightedTurn,
    expanded: [...state.expandedTurns].sort((a, b) => a - b),
    rows: list.map((t) => [
      t.turnNumber,
      t.stepCount,
      t.totalTokens,
      t.cacheHitRate,
      t.endContextTokens,
      t.estimatedTokPerSec,
      t.promptFull || t.prompt,
    ]),
  });

  if (!forceRender && turnsKey === state.lastTurnsKey) return;
  state.lastTurnsKey = turnsKey;

  if (truncationObserver) {
    truncationObserver.disconnect();
  }

  if (list.length === 0) {
    els.turnsTable.hidden = true;
    els.emptyState.hidden = false;
    els.turnsTbody.replaceChildren();
    return;
  }

  els.turnsTable.hidden = false;
  els.emptyState.hidden = true;

  const maxTurnTokens = Math.max(1, ...list.map((t) => t.totalTokens || 0));
  const fragment = document.createDocumentFragment();
  const labelsToObserve = [];

  for (const turn of list) {
    const isExpanded = state.expandedTurns.has(turn.turnNumber);
    const isHighlighted = state.highlightedTurn === turn.turnNumber;
    const rowClasses = ['turn-row'];
    if (isExpanded) rowClasses.push('is-expanded');
    if (isHighlighted) rowClasses.push('is-highlighted');

    const tr = document.createElement('tr');
    tr.className = rowClasses.join(' ');
    tr.dataset.turn = String(turn.turnNumber);

    tr.appendChild(createTextCell(`#${turn.turnNumber}`, 'cell-mono cell-turn-id'));

    const promptTd = document.createElement('td');
    const promptBtn = document.createElement('button');
    promptBtn.type = 'button';
    promptBtn.className = 'prompt-btn';
    promptBtn.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
    promptBtn.setAttribute('aria-label', `第 ${turn.turnNumber} 轮详情：${turn.promptFull || turn.prompt || ''}`);
    promptBtn.addEventListener('click', () => {
      if (state.expandedTurns.has(turn.turnNumber)) {
        state.expandedTurns.delete(turn.turnNumber);
        if (state.highlightedTurn === turn.turnNumber) state.highlightedTurn = null;
      } else {
        state.expandedTurns.add(turn.turnNumber);
        state.highlightedTurn = turn.turnNumber;
      }
      if (state.lastSnapshot) {
        renderTrajectory(state.lastSnapshot.telemetry.turns, state.lastSnapshot.telemetry.summary, true);
        renderTurnsTable(state.lastSnapshot.telemetry.turns, true);
      }
    });

    const chev = document.createElement('span');
    chev.className = 'prompt-chevron';
    chev.appendChild(createChevronSvg());
    promptBtn.appendChild(chev);

    const promptLabel = document.createElement('span');
    promptLabel.className = 'prompt-label';
    const promptInner = document.createElement('span');
    promptInner.textContent = turn.promptFull || turn.prompt || `第 ${turn.turnNumber} 轮`;
    promptLabel.appendChild(promptInner);
    promptBtn.appendChild(promptLabel);

    promptTd.appendChild(promptBtn);
    tr.appendChild(promptTd);
    labelsToObserve.push(promptLabel);

    tr.appendChild(createTextCell(`${turn.stepCount} 步`, 'cell-mono num-col'));

    const tokTd = document.createElement('td');
    tokTd.className = 'cell-mono num-col';
    const tokInner = document.createElement('div');
    tokInner.className = 'token-cell-inner';
    const tokText = document.createElement('span');
    tokText.textContent = fmtTokens(turn.totalTokens);
    const meter = document.createElement('span');
    meter.className = 'token-meter';
    meter.setAttribute('aria-hidden', 'true');
    const meterFill = document.createElement('span');
    meterFill.className = 'token-meter-fill';
    const sharePct = Math.max(2, Math.round(((turn.totalTokens || 0) / maxTurnTokens) * 100));
    meterFill.style.setProperty('--turn-share', `${turn.totalTokens > 0 ? sharePct : 0}%`);
    meter.appendChild(meterFill);
    tokInner.appendChild(tokText);
    tokInner.appendChild(meter);
    tokTd.appendChild(tokInner);
    tr.appendChild(tokTd);

    const cacheTone =
      turn.cacheHitRate === null
        ? ''
        : turn.cacheHitRate >= 75
          ? ' tone-ok'
          : turn.cacheHitRate < 40
            ? ' tone-warn'
            : '';
    tr.appendChild(
      createTextCell(
        turn.cacheHitRate !== null ? fmtPct(turn.cacheHitRate) : '--',
        `cell-mono num-col${cacheTone}`
      )
    );

    const ctxTone =
      turn.endContextPercent >= 85
        ? ' tone-bad'
        : turn.endContextPercent >= 60
          ? ' tone-warn'
          : '';
    tr.appendChild(
      createTextCell(
        turn.endContextTokens > 0 ? fmtPct(turn.endContextPercent) : '--',
        `cell-mono num-col${ctxTone}`
      )
    );

    tr.appendChild(
      createTextCell(
        turn.estimatedTokPerSec !== null ? `~${Math.round(turn.estimatedTokPerSec)}/s` : '--',
        'cell-mono num-col'
      )
    );

    fragment.appendChild(tr);

    if (isExpanded) {
      fragment.appendChild(createTurnDetailRow(turn));
    }
  }

  els.turnsTbody.replaceChildren(fragment);

  if (truncationObserver) {
    for (const label of labelsToObserve) {
      label.classList.toggle('truncated', label.scrollWidth > label.clientWidth);
      truncationObserver.observe(label);
    }
  }
}

function renderTokenMix(s) {
  const total = s.grandTotalTokens;
  if (!total || total <= 0) {
    els.mixCacheSeg.style.inlineSize = '0%';
    els.mixUncachedSeg.style.inlineSize = '0%';
    els.mixOutputSeg.style.inlineSize = '0%';
    return;
  }
  const cachePct = (s.cacheReadTokens / total) * 100;
  const uncachedPct = (s.uncachedInputTokens / total) * 100;
  const outputPct = Math.max(0, 100 - cachePct - uncachedPct);
  els.mixCacheSeg.style.inlineSize = `${cachePct.toFixed(2)}%`;
  els.mixUncachedSeg.style.inlineSize = `${uncachedPct.toFixed(2)}%`;
  els.mixOutputSeg.style.inlineSize = `${outputPct.toFixed(2)}%`;
}

function renderSnapshot(snapshot) {
  state.lastSnapshot = snapshot;
  renderConversationOptions(snapshot.conversations, snapshot.activeConversationId);
  updateUnifiedStatusBadge();

  const t = snapshot.telemetry;
  const s = t.summary;

  els.modelNameText.textContent = t.modelName;
  els.windowCapText.textContent = `窗口 ${t.windowLabel}`;

  const speedText =
    s.avgTokPerSec !== null ? `~${Math.round(s.avgTokPerSec)} tok/s` : '-- tok/s';
  const cacheText =
    s.cacheHitRate !== null ? `命中 ${fmtPct(s.cacheHitRate, 0)}` : '命中 --%';
  const ctxPctText = fmtPct(s.contextUsagePercent, 1);

  els.dshTurnsSpeed.textContent = `${s.totalTurns} 轮 ${s.totalSteps} 步`;
  els.dshSpeedVal.textContent = speedText;
  els.dshTokensCache.textContent = `${fmtTokens(s.grandTotalTokens)} tok`;
  els.dshCacheVal.textContent = cacheText;
  els.dshContextPct.textContent = ctxPctText;

  setRingProgress(els.miniRingFill, 7, s.contextUsagePercent);
  setRingProgress(els.bigRingFill, 37, s.contextUsagePercent);

  els.contextPctValue.textContent = ctxPctText;
  els.contextUsedValue.textContent = fmtTokens(s.currentContextTokens);
  els.contextCapValue.textContent = `/ ${fmtTokens(t.windowSize)}`;
  const remaining = Math.max(0, t.windowSize - s.currentContextTokens);
  const remPct = Math.max(0, 100 - s.contextUsagePercent);
  els.contextRemaining.textContent = `剩余 ${fmtTokens(remaining)} (${fmtPct(remPct, 1)})`;
  els.contextPeak.textContent = `峰值 ${fmtTokens(s.peakContextTokens)} tok`;

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

  els.totalTokensValue.textContent = fmtTokens(s.grandTotalTokens);
  const cachePct = s.cacheHitRate;
  els.cacheHitValue.textContent = cachePct !== null ? fmtPct(cachePct, 1) : '--%';
  els.cacheHitValue.classList.remove('tone-ok', 'tone-warn', 'tone-bad');

  renderTokenMix(s);
  els.cacheReadValue.textContent = fmtTokens(s.cacheReadTokens);
  els.uncachedInputValue.textContent = fmtTokens(s.uncachedInputTokens);
  els.outputTokensValue.textContent = fmtTokens(s.outputTokens);
  els.latestCacheValue.textContent =
    s.latestStepCacheHitRate !== null ? fmtPct(s.latestStepCacheHitRate, 1) : '--%';

  els.cacheStateBadge.classList.remove('is-ok', 'is-warn', 'is-bad');
  if (cachePct === null) {
    els.cacheStateBadge.textContent = '● 待记录';
  } else if (cachePct >= 75) {
    els.cacheStateBadge.classList.add('is-ok');
    els.cacheHitValue.classList.add('tone-ok');
    els.cacheStateBadge.textContent = '● 高命中';
  } else if (cachePct >= 40) {
    els.cacheStateBadge.classList.add('is-warn');
    els.cacheHitValue.classList.add('tone-warn');
    els.cacheStateBadge.textContent = '▲ 中等';
  } else {
    els.cacheStateBadge.classList.add('is-bad');
    els.cacheHitValue.classList.add('tone-bad');
    els.cacheStateBadge.textContent = '◆ 较低';
  }

  els.throughputModeNote.textContent =
    s.throughputSource === 'hook_ms' ? '精确计时' : '估算速率';
  els.turnsStepsValue.textContent = `${s.totalTurns} 轮 / ${s.totalSteps} 步`;
  els.tokenCallsNote.textContent = `${s.modelCallCount} 次调用`;
  els.avgSpeedValue.textContent =
    s.avgTokPerSec !== null ? `~${Math.round(s.avgTokPerSec)} tok/s` : '-- tok/s';
  els.latestSpeedValue.textContent =
    s.latestStepTokPerSec !== null ? `~${Math.round(s.latestStepTokPerSec)} tok/s` : '-- tok/s';
  els.stepsSplitValue.textContent = `${s.modelCallCount} / ${s.toolStepCount} 步`;
  els.durationValue.textContent = fmtDuration(s.sessionDurationMs);

  renderTrajectory(t.turns, s);
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
    if (state.connectionState === 'connecting') {
      state.connectionState = 'ok';
    }
    renderSnapshot(data);
  } catch (err) {
    state.connectionState = 'bad';
    state.connectionErrorText = `拉取失败 (${err.message})`;
    updateUnifiedStatusBadge();
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
    state.connectionState = 'ok';
    state.connectionErrorText = '';
    updateUnifiedStatusBadge();
  };

  es.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      state.connectionState = 'ok';
      renderSnapshot(payload);
    } catch {
      // Ignore malformed SSE event.
    }
  };

  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      state.connectionState = 'bad';
      state.connectionErrorText = '连接断开，重连中…';
      updateUnifiedStatusBadge();
      state.reconnectTimer = setTimeout(connectEvents, 1500);
    }
  };
}

els.windowSelect.addEventListener('change', () => {
  state.windowSizeOverride = els.windowSelect.value;
  connectEvents();
  fetchSnapshotOnce();
});

els.sortToggleBtn.addEventListener('click', () => {
  state.sortDesc = !state.sortDesc;
  if (state.lastSnapshot) {
    renderTurnsTable(state.lastSnapshot.telemetry.turns, true);
  }
});

fetchSnapshotOnce();
connectEvents();
