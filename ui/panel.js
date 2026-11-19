const TABS = [
  ['status', '状态'],
  ['settings', '设置'],
  ['api', '模型连接'],
  ['library', '事件库'],
];

export function createPanel({ actions, getSnapshot }) {
  let activeTab = 'status';
  let availableModels = [];
  let progressTimer = null;
  const element = document.createElement('section');
  element.id = 'world-event-director-panel';
  element.className = 'wed-panel';
  element.innerHTML = shellTemplate();

  const drawerHeader = element.querySelector('.wed-drawer-header');
  const drawer = element.querySelector('.inline-drawer');
  const toggleDrawer = () => {
    const expanded = drawerHeader.getAttribute('aria-expanded') === 'true';
    window.toggleDrawer?.(drawer, !expanded);
    drawerHeader.setAttribute('aria-expanded', String(!expanded));
    if (!window.toggleDrawer) {
      const content = element.querySelector('.inline-drawer-content');
      const icon = drawerHeader.querySelector('.inline-drawer-icon');
      content.style.display = expanded ? 'none' : 'block';
      icon.classList.toggle('down', expanded);
      icon.classList.toggle('up', !expanded);
      icon.classList.toggle('fa-circle-chevron-down', expanded);
      icon.classList.toggle('fa-circle-chevron-up', !expanded);
    }
  };
  drawerHeader.addEventListener('click', (event) => {
    // The host also delegates clicks on inline-drawer-toggle; handle this drawer once.
    event.stopPropagation();
    toggleDrawer();
  });
  drawerHeader.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleDrawer();
    }
  });
  element.addEventListener('keydown', (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = TABS.findIndex(([id]) => id === activeTab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
    activeTab = TABS[next][0];
    render(getSnapshot());
    element.querySelector(`[data-tab="${activeTab}"]`).focus();
  });

  // 创建弹窗元素
  const toast = document.createElement('div');
  toast.className = 'wed-toast';
  toast.style.display = 'none';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  toast.setAttribute('aria-atomic', 'true');
  document.body.appendChild(toast);

  async function complete(operation, message) {
    try {
      const result = await operation();
      render(getSnapshot());
      showToast(toast, result?.ok === false ? `未完成：${result.error}` : (result?.message ?? message), result?.ok === false ? 5000 : 2800);
      return result;
    } catch (error) {
      showToast(toast, `未完成：${error.message}`, 5000);
      return { ok: false, error: error.message };
    }
  }

  element.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-action], [data-tab], [data-toggle-event], [data-edit-event], [data-delete-event]');
    if (!target) return;
    if (target.dataset.tab) {
      activeTab = target.dataset.tab;
      render(getSnapshot());
      return;
    }
    if (target.dataset.toggleEvent) {
      toggleEventDetail(target.dataset.toggleEvent);
      return;
    }
    if (target.dataset.editEvent) {
      editEvent(target.dataset.editEvent, element, getSnapshot);
      return;
    }
    if (target.dataset.deleteEvent) {
      const confirmed = confirm('确定要删除这个事件吗？删除后将从事件库中移除。');
      if (confirmed) {
        await complete(() => actions.removeTemplate(target.dataset.deleteEvent), '事件已删除');
      }
      return;
    }
    if (target.disabled) return;
    target.disabled = true;
    const result = await complete(() => runAction(target.dataset.action, target, actions, element, toast), '操作已完成');
    if (Array.isArray(result?.models)) availableModels = result.models;
    render(getSnapshot());
    target.disabled = false;
  });

  element.addEventListener('change', async (event) => {
    const target = event.target;
    if (target.matches('[data-autosave-setting]')) {
      await complete(() => actions.saveSettings(readSettingsPatch(element)), '设置已保存');
    }
    if (target.matches('#wed-template-editor-select')) {
      const selected = getTemplateById(getSnapshot().templates, target.value);
      const editor = element.querySelector('#wed-template-editor');
      if (editor && selected) editor.value = JSON.stringify(selected, null, 2);
    }
    if (target.matches('#wed-model-select')) {
      const input = element.querySelector('#wed-model-input');
      if (input && target.value) {
        input.value = target.value;
      }
    }
  });

  element.addEventListener('input', (event) => {
    if (event.target.matches('[data-setting-live]')) {
      updateRangeLabel(event.target);
    }
  });

  function render(snapshot) {
    const apiDrafts = [...element.querySelectorAll('[data-setting^="api."]')]
      .map((input) => ({ path: input.dataset.setting, value: input.value, masked: input.dataset.secretMasked }));
    const drafts = [...element.querySelectorAll('#wed-template-editor, #wed-import-export, #wed-template-editor-select')]
      .map((input) => ({ id: input.id, value: input.value }));
    if (!availableModels.length && Array.isArray(snapshot.models)) availableModels = snapshot.models;
    element.querySelector('.wed-tabs').innerHTML = TABS.map(([id, label]) => (
      `<button type="button" role="tab" id="wed-tab-${id}" aria-controls="wed-tab-content" aria-selected="${activeTab === id}" tabindex="${activeTab === id ? '0' : '-1'}" class="wed-tab${activeTab === id ? ' is-active' : ''}" data-tab="${id}">${label}</button>`
    )).join('');
    element.querySelector('.wed-body').innerHTML = renderTab(activeTab, { ...snapshot, availableModels });
    element.querySelector('.wed-body').setAttribute('aria-labelledby', `wed-tab-${activeTab}`);
    for (const draft of apiDrafts) {
      const input = element.querySelector(`[data-setting="${draft.path}"]`);
      if (input) {
        input.value = draft.value;
        if (draft.masked) input.dataset.secretMasked = draft.masked;
      }
    }
    for (const draft of drafts) {
      const input = element.querySelector(`#${draft.id}`);
      if (input) input.value = draft.value;
    }
    const progress = element.querySelector('.wed-progress');
    progress.innerHTML = generationProgress(snapshot);
    clearInterval(progressTimer);
    if (snapshot.catalogBusy) {
      progressTimer = setInterval(() => { progress.innerHTML = generationProgress(getSnapshot()); }, 1000);
    }
  }

  function toggleEventDetail(eventId) {
    const detailElement = element.querySelector(`[data-event-detail="${eventId}"]`);
    if (detailElement) {
      const isExpanded = detailElement.style.display !== 'none';
      detailElement.style.display = isExpanded ? 'none' : 'block';
      const toggle = element.querySelector(`[data-toggle-event="${eventId}"]`);
      if (toggle) {
        toggle.textContent = isExpanded ? '▶' : '▼';
        toggle.setAttribute('aria-expanded', String(!isExpanded));
      }
    }
  }

  function editEvent(eventId, root, getSnapshot) {
    const snapshot = getSnapshot();
    const event = snapshot.templates.find(t => t.id === eventId);
    if (!event) return;

    // 切换到事件库标签页
    activeTab = 'library';
    render(snapshot);

    // 填充编辑器
    const select = root.querySelector('#wed-template-editor-select');
    const editor = root.querySelector('#wed-template-editor');
    if (select && editor) {
      select.value = eventId;
      editor.value = JSON.stringify(event, null, 2);
      // 滚动到编辑器位置
      editor.scrollIntoView({ behavior: 'smooth', block: 'center' });
      editor.focus();
    }
  }

  render(getSnapshot());
  return { element, render, showToast: (message, duration = 2000) => showToast(toast, message, duration) };
}

function shellTemplate() {
  return `
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header wed-drawer-header" role="button" tabindex="0" aria-expanded="false">
        <div class="flex-container alignitemscenter margin0">
          <strong>世界事件导演</strong>
        </div>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content" style="display: none;">
        <div class="wed-content-layout">
          <nav class="wed-tabs" role="tablist" aria-label="世界事件导演导航"></nav>
          <div class="wed-progress" role="status" aria-live="polite"></div>
          <main class="wed-body" id="wed-tab-content" role="tabpanel"></main>
        </div>
      </div>
    </div>
  `;
}

function renderTab(tab, snapshot) {
  switch (tab) {
    case 'settings': return renderSettings(snapshot);
    case 'api': return renderApi(snapshot);
    case 'library': return renderLibrary(snapshot);
    default: return renderStatus(snapshot);
  }
}

function renderStatus({ identity, context, state, settings, templates }) {
  const pending = state.pendingEvent;
  const inserted = state.lastInsertedEvent;
  const background = context.backgroundContext;
  const scene = context.sceneContext ?? context.scene ?? {};
  const catalogDiagnostic = state.flags?.catalogDiagnostic;
  return `
    <div class="wed-grid two">
      <article class="wed-block">
        <h3>同步状态</h3>
        ${metric('当前聊天', identity.chatId)}
        ${metric('当前角色', context.character?.name ?? identity.characterId)}
        ${metric('已同步世界书', `${context.worldbooks?.length ?? 0} 个`)}
        ${metric('背景缓存', context.cacheStatus ?? (background ? 'fresh' : 'missing'))}
        ${metric('背景角色', `${background?.entities?.actors?.length ?? 0} 个`)}
        ${metric('世界书条目', `${background?.worldbookEntries?.length ?? 0} 条`)}
        ${metric('当前轮次', `第 ${state.turn ?? 0} 轮`)}
        ${metric('候选事件', `${templates.length} 个`)}
        ${metric('事件抽取间隔', `每 ${settings.eventCheckInterval ?? 5} 轮对话`)}
        ${catalogDiagnostic?.status === 'failed' ? `<p class="wed-note wed-error">上次事件清单失败：${escapeHtml(formatCatalogDiagnostic(catalogDiagnostic))}</p>` : ''}
      </article>
      <article class="wed-block">
        <h3>场景快照</h3>
        ${metric('地点', scene.locationId ?? scene.location ?? '未识别')}
        ${metric('时间', scene.time ?? '未识别')}
        ${metric('计划', scene.currentPlan ?? scene.plan ?? '未识别')}
        ${metric('可用 NPC', compactList(context.availableNpcs, 8) || '未识别')}
        ${metric('注入状态', state.injection?.status ?? 'idle')}
        ${pending ? `
          <div class="wed-current-event">
            <h4>等待插入</h4>
            <div class="wed-event-card ${pending.severity}">
              <div class="wed-event-heading">
                <strong>${escapeHtml(pending.title ?? pending.id)}</strong>
                <span class="wed-pill ${pending.severity}">${escapeHtml(pending.severity)}</span>
              </div>
            </div>
          </div>
        ` : ''}
        ${inserted ? metric('最近插入', `${inserted.title} · ${inserted.severity}`) : ''}
        ${state.flags?.pendingManualPrompt ? `
          <div class="wed-current-event">
            <h4>等待手动插入</h4>
            <p class="wed-note">复制以下内容作为临时 system prompt，并在发送下一次模型请求前确认。</p>
            <textarea class="wed-textarea" readonly>${escapeHtml(state.flags.pendingManualPrompt)}</textarea>
            <div class="wed-actions-row">
              <button type="button" class="wed-button ghost" data-action="copyPendingPrompt">复制 Prompt</button>
              <button type="button" class="wed-button" data-action="confirmManualInjection">标记将随下次请求插入</button>
            </div>
          </div>
        ` : ''}
      </article>
    </div>
    <div class="wed-actions-row">
      <button type="button" class="wed-button" data-action="resync">重新同步上下文</button>
      <button type="button" class="wed-button danger" data-action="clearChatState">清除本聊天状态</button>
      <button type="button" class="wed-button ghost" data-action="clearContextCache">清除背景缓存</button>
    </div>
    <p class="wed-note">插件会自动在后台调度事件，无需手动干预。Critical 事件可能要求角色立即响应。</p>
  `;
}

function formatCatalogDiagnostic(diagnostic = {}) {
  if (diagnostic.error) return diagnostic.error;
  const kind = ({
    schema: '事件字段不符合要求',
    references: '角色或世界书来源不符合要求',
    schema_and_references: '事件字段和角色/世界书来源都不符合要求',
  })[diagnostic.failureKind] ?? '未通过事件清单检查';
  const counts = `字段拒绝 ${diagnostic.schemaRejected ?? 0} 条，来源拒绝 ${diagnostic.referenceRejected ?? 0} 条`;
  const sourceDetails = Object.entries(diagnostic.referenceErrorCounts ?? {})
    .map(([name, count]) => `${name} ${count} 条`).join('，');
  return `${kind}（${counts}${sourceDetails ? `；${sourceDetails}` : ''}）`;
}

function renderSettings({ settings }) {
  return `
    <article class="wed-block">
      <h3>基本设置</h3>
      ${toggle('enabled', '启用事件导演', settings.enabled)}
      ${toggle('autoCritical', '允许自动 Critical 事件', settings.autoCritical)}
      <p class="wed-note">插件只在下一次回复前插入一次事件，之后不跟踪剧情后续。</p>
    </article>
    <article class="wed-block">
      <h3>事件调度间隔</h3>
      ${numberField('eventCheckInterval', '每隔几轮对话抽取一次事件', settings.eventCheckInterval ?? 5, 1, 50)}
      <p class="wed-note">设置为 5 表示每 5 轮对话尝试抽取一次事件。间隔越小，事件越频繁。</p>
    </article>
  `;
}

function renderApi({ settings, availableModels = [] }) {
  const api = settings.api;
  const health = settings.apiHealth;
  return `
    <article class="wed-block">
      <h3>独立事件导演 API</h3>
      <p class="wed-note">API 只在首次配置和事件清单更新时调用，不参与每轮对话。</p>
      <div class="wed-form-grid">
        ${textField('api.baseUrl', 'API Base URL', api.baseUrl)}
        ${passwordField('api.apiKey', 'API Key', api.apiKey)}
        <div class="wed-field">
          <span>模型名称</span>
          <div style="display: flex; gap: 8px;">
            <select id="wed-model-select" style="flex: 1;">
              <option value="">手动输入模型名称</option>
              ${availableModels.map((model) => `<option value="${escapeAttr(model.id)}" ${model.id === api.model ? 'selected' : ''}>${escapeHtml(model.name ?? model.id)}</option>`).join('')}
            </select>
            <button type="button" class="wed-button ghost" data-action="fetchModels">拉取列表</button>
          </div>
          <input type="text" id="wed-model-input" data-setting="api.model" value="${escapeAttr(api.model)}" placeholder="或手动输入模型名称" style="margin-top: 8px;">
        </div>
        ${numberField('api.temperature', '温度', api.temperature, 0, 2, 0.1)}
        ${numberField('api.maxTokens', '输出预算（含模型思考）', api.maxTokens, 128, 32000, 1)}
        ${selectField('api.connectionMode', '连接方式', api.connectionMode, [['direct', '直连'], ['proxy', '本地代理']])}
      </div>
      <div class="wed-actions-row">
        <button type="button" class="wed-button" data-action="saveSettings">保存设置</button>
        <button type="button" class="wed-button ghost" data-action="testApi">测试连接</button>
      </div>
      <p class="wed-note">API Key 只保存在扩展设置；导出、日志和事件状态都会剥离密钥。</p>
      <p class="wed-note">思考模型可能等待较久。需要更快生成时，可选择响应更快的非思考模型；5 条事件的实际输出预算至少为 3,500 token。</p>
      ${health ? `<p class="wed-note">最近测试：models=${escapeHtml(health.models?.status ?? 'unknown')} · completion=${escapeHtml(health.completion?.status ?? 'unknown')} · schema=${escapeHtml(health.schema?.status ?? 'unknown')}</p>` : ''}
    </article>
  `;
}

function renderLibrary({ templates, catalogBusy, state, catalogUpdatedAt }) {
  return `
    <article class="wed-block">
      <header class="wed-section-header">
        <h3>事件库</h3>
        <div class="wed-actions-row">
        <button type="button" class="wed-button ghost" data-action="regenerateCatalog" ${catalogBusy ? 'disabled' : ''}>重新生成事件</button>
        <button type="button" class="wed-button ghost" data-action="fillCatalog" ${catalogBusy || templates.length >= 5 ? 'disabled' : ''}>补足事件</button>
        </div>
      </header>
      <p class="wed-note wed-catalog-updated">上次更新：<time ${catalogUpdatedAt ? `datetime="${new Date(catalogUpdatedAt).toISOString()}"` : ''}>${catalogUpdatedAt ? escapeHtml(new Date(catalogUpdatedAt).toLocaleString('zh-CN', { hour12: false })) : '尚未更新'}</time></p>
      <p class="wed-note">新事件通过校验后会替换当前事件库，并继续补足到 5 条；完全失败时保留原事件，部分成功时保留新事件。</p>
      ${templates.length < 5 ? `<p class="wed-note">还可补足 ${5 - templates.length} 条事件，已有事件会保留。</p>` : ''}
      ${state?.flags?.catalogDiagnostic?.status === 'failed' ? '<p class="wed-note wed-error">上次生成未补齐，已有事件保留。可以点击补足事件，或等待下次检查。</p>' : ''}
      <div class="wed-template-list">
        ${templates.map((event) => renderEventCard(event)).join('')}
      </div>
      <div class="wed-actions-row">
        <button type="button" class="wed-button ghost" data-action="exportState">导出状态与模板</button>
      </div>
    </article>
    <article class="wed-block">
      <h3>编辑或新增事件</h3>
      <label class="wed-field">
        <span>载入已有事件</span>
        <select id="wed-template-editor-select">
          <option value="">新建事件</option>
          ${templates.map((event) => `<option value="${escapeHtml(event.id)}">${escapeHtml(event.title)} · ${escapeHtml(event.id)}</option>`).join('')}
        </select>
      </label>
      <textarea id="wed-template-editor" class="wed-textarea" placeholder="粘贴或编写一个完整事件 JSON"></textarea>
      <div class="wed-actions-row">
        <button type="button" class="wed-button" data-action="upsertTemplate">保存事件</button>
        <button type="button" class="wed-button danger" data-action="removeTemplate">删除已选事件</button>
      </div>
      <p class="wed-note">事件必须符合模板结构；保存后立即写入当前聊天的事件清单。</p>
    </article>
    <article class="wed-block">
      <h3>导入导出</h3>
      <textarea id="wed-import-export" class="wed-textarea" placeholder="导出状态，或粘贴完整导出 JSON 后导入"></textarea>
      <div class="wed-actions-row"><button type="button" class="wed-button ghost" data-action="importState">导入 JSON</button></div>
    </article>
  `;
}

function renderEventCard(evt) {
  const shortDesc = evt.shortDescription || evt.description || evt.content?.description || '暂无简短描述';
  const detailedDesc = evt.detailedDescription || evt.description || evt.content?.description || '暂无详细描述';
  const effects = evt.effects || {};
  const presentation = evt.presentation || {};
  const actor = evt.trigger?.actor?.name ?? presentation.preferredActor ?? evt.conditions?.requiredNpcs?.[0];
  const signal = evt.trigger?.signal ?? presentation.signals?.[0];
  const sources = (evt.sourceRefs ?? []).map((ref) => ref.type === 'worldbook-entry' ? `${ref.bookId}:${ref.entryId}` : ref.type).join('、');
  const impactScope = ({ personal: '个人范围', organization: '组织范围', public: '公众范围', city: '城市范围' })[evt.impactScope];

  return `
    <div class="wed-event-card-wrapper">
      <div class="wed-template-row wed-event-row">
        <span class="wed-event-summary">
          <strong>${escapeHtml(evt.title)}</strong>
          <small>${evt.enabled ? '' : '已停用 · '}${escapeHtml(evt.category)}${impactScope ? ` · ${impactScope}` : ''} · ${escapeHtml(evt.severity)} · ${{ generated: '已生成', pending: '待插入', occurred: '已发生' }[evt.status] ?? (evt.occurred ? '已发生' : '已生成')} · 概率 ${Math.round(Number(evt.probability ?? 0) * 100)}% · 权重 ${evt.weight}</small>
          <p class="wed-event-short-desc">${escapeHtml(shortDesc)}</p>
        </span>
        <div class="wed-event-actions">
          <button type="button" class="wed-icon-btn" data-edit-event="${escapeHtml(evt.id)}" title="编辑">编辑</button>
          <button type="button" class="wed-icon-btn wed-icon-btn-danger" data-delete-event="${escapeHtml(evt.id)}" title="删除">删除</button>
          <button type="button" class="wed-toggle-btn" data-toggle-event="${escapeHtml(evt.id)}" aria-label="展开事件详情：${escapeAttr(evt.title)}" aria-expanded="false">▶</button>
        </div>
      </div>
      <div class="wed-event-detail" data-event-detail="${escapeHtml(evt.id)}" style="display: none;">
        ${actor ? `<div class="wed-detail-section"><h4>事件发起人</h4><p>${escapeHtml(actor)}</p></div>` : ''}
        ${signal ? `<div class="wed-detail-section"><h4>触发信号</h4><p>${escapeHtml(signal)}</p></div>` : ''}
        ${sources ? `<div class="wed-detail-section"><h4>背景来源</h4><p>${escapeHtml(sources)}</p></div>` : ''}
        <div class="wed-detail-section">
          <h4>详细描述</h4>
          <p>${escapeHtml(detailedDesc)}</p>
        </div>
        ${presentation.signals ? `
          <div class="wed-detail-section">
            <h4>触发信号</h4>
            <ul>
              ${presentation.signals.map(signal => `<li>${escapeHtml(signal)}</li>`).join('')}
            </ul>
          </div>
        ` : ''}
        ${effects.requiredAction ? `
          <div class="wed-detail-section">
            <h4>必须行动</h4>
            <p>${escapeHtml(effects.requiredAction)}</p>
          </div>
        ` : ''}
        ${effects.userImpact ? `
          <div class="wed-detail-section">
            <h4>用户影响</h4>
            <p>${escapeHtml(effects.userImpact)}</p>
          </div>
        ` : ''}
        <div class="wed-detail-section">
          <h4>事件特性</h4>
          <div class="wed-event-flags">
            ${effects.mustInterrupt ? '<span class="wed-flag critical">必须中断</span>' : ''}
            ${effects.cancelCurrentPlan ? '<span class="wed-flag high">取消计划</span>' : ''}
            ${effects.allowLocationChange ? '<span class="wed-flag normal">允许换场</span>' : ''}
          </div>
        </div>
      </div>
    </div>
  `;
}

async function runAction(action, target, actions, root, toast) {
  if (action === 'saveSettings') return actions.saveSettings(readSettingsPatch(root));
  if (action === 'exportState') {
    root.querySelector('#wed-import-export').value = actions.exportState();
    return { ok: true, message: '已导出到下方文本框' };
  }
  if (action === 'importState') {
    const value = root.querySelector('#wed-import-export')?.value;
    if (value) return { ...await actions.importState(value), message: '事件已导入' };
    return { ok: false, error: '请先粘贴要导入的 JSON' };
  }
  if (action === 'upsertTemplate') {
    const value = root.querySelector('#wed-template-editor')?.value;
    if (value) return { ...await actions.upsertTemplate(value), message: '事件已保存' };
    return { ok: false, error: '请先填写事件内容' };
  }
  if (action === 'removeTemplate') {
    const id = root.querySelector('#wed-template-editor-select')?.value;
    if (!id) return { ok: false, error: '请先选择要删除的事件' };
    if (!confirm('确定删除所选事件吗？此操作无法撤销。')) return { ok: true, message: '已取消删除' };
    return { ...await actions.removeTemplate(id), message: '事件已删除' };
  }
  if (action === 'copyPendingPrompt') {
    const result = actions.getPendingPrompt();
    if (!result.ok) return { ok: false, error: '没有等待复制的内容' };
    await navigator.clipboard.writeText(result.prompt);
    return { ok: true, message: '待插入内容已复制' };
  }
  if (action === 'resync') {
    showToast(toast, '正在同步上下文...', 0);
    return actions.resync();
  }
  if (action === 'fetchModels') {
    showToast(toast, '正在获取模型列表...', 0);
    const result = await actions.fetchModels(readSettingsPatch(root));
    return { ...result, message: result.ok ? (result.stale ? `网络失败，已加载缓存的 ${result.models.length} 个模型` : `已加载 ${result.models.length} 个模型`) : undefined };
  }
  if (action === 'testApi') {
    showToast(toast, '正在测试 API 连接...', 0);
    const result = await actions.testApi(readSettingsPatch(root));
    return result;
  }
  if (typeof actions[action] === 'function') {
    if (['clearChatState', 'clearContextCache'].includes(action)
      && !confirm(action === 'clearChatState' ? '确定清除当前聊天的事件运行状态吗？' : '确定清除并重新读取当前聊天的背景缓存吗？')) {
      return { ok: true, message: '已取消清除' };
    }
    const result = await actions[action]();
    return { ...result, message: result?.message ?? ({ clearChatState: '当前聊天的运行状态已清除',
      regenerateCatalog: `事件已生成，共 ${result?.count ?? 0} 条`, fillCatalog: `事件已补足，共 ${result?.count ?? 0} 条` })[action] };
  }
}

export function readSettingsPatch(root) {
  const patch = {};
  for (const input of root.querySelectorAll('[data-setting]')) {
    // 对于模型输入框，优先使用手动输入的值
    if (input.id === 'wed-model-input') {
      const value = readInput(input);
      if (value) {
        setDeep(patch, input.dataset.setting, value);
      }
    } else if (input.id === 'wed-model-select') {
      // 跳过 select，只使用 input 的值
      continue;
    } else {
      setDeep(patch, input.dataset.setting, readInput(input));
    }
  }
  return patch;
}

function readInput(input) {
  if (input.type === 'checkbox') return input.checked;
  if (input.type === 'number' || input.type === 'range') return Number(input.value);
  if (input.dataset.secretMasked === 'true' && /^•+$/.test(input.value)) return undefined;
  return input.value;
}

function setDeep(object, path, value) {
  if (value === undefined) return;
  const keys = path.split('.');
  let current = object;
  for (const key of keys.slice(0, -1)) current = current[key] ?? (current[key] = {});
  current[keys.at(-1)] = value;
}

function updateRangeLabel(input) {
  const label = input.closest('.wed-field')?.querySelector('em');
  if (label) label.textContent = input.value;
}

function metric(label, value) {
  return `<div class="wed-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function compactList(items = [], count = 6) {
  return items.slice(0, count).join('、');
}

function getTemplateById(templates, id) {
  return templates.find((template) => template.id === id);
}

function toggle(path, label, checked) {
  return `<label class="wed-toggle"><input type="checkbox" data-autosave-setting="${path}" data-setting="${path}" ${checked ? 'checked' : ''}><span>${label}</span></label>`;
}

function textField(path, label, value) {
  return `<label class="wed-field"><span>${label}</span><input type="text" data-setting="${path}" value="${escapeAttr(value)}"></label>`;
}

function passwordField(path, label, value) {
  const masked = value === '••••••••';
  return `<label class="wed-field"><span>${label}</span><input type="password" data-setting="${path}" ${masked ? 'data-secret-masked="true"' : ''} value="${escapeAttr(value)}"></label>`;
}

function numberField(path, label, value, min, max, step = 1) {
  const autoSave = path.startsWith('api.') ? '' : 'data-autosave-setting';
  return `<label class="wed-field"><span>${label}</span><input type="number" ${autoSave} data-setting="${path}" min="${min}" max="${max}" step="${step}" value="${escapeAttr(value)}"></label>`;
}

function selectField(path, label, value, options) {
  return `<label class="wed-field"><span>${label}</span><select data-setting="${path}">${options.map(([optionValue, text]) => `<option value="${escapeAttr(optionValue)}" ${value === optionValue ? 'selected' : ''}>${escapeHtml(text)}</option>`).join('')}</select></label>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function showToast(toast, message, duration = 2000) {
  clearTimeout(toast.dismissTimer);
  toast.textContent = message;
  toast.style.display = 'block';
  toast.classList.add('wed-toast-show');

  if (duration > 0) {
    toast.dismissTimer = setTimeout(() => {
      toast.classList.remove('wed-toast-show');
      toast.style.display = 'none';
    }, duration);
  }
}

function generationProgress({ catalogBusy, state }) {
  const diagnostic = state.flags?.catalogDiagnostic;
  if (!catalogBusy) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - (diagnostic?.startedAt ?? Date.now())) / 1000));
  const timing = diagnostic?.timing;
  const stage = ({ waiting_headers: '等待服务响应', reading_body: '正在接收完整结果', body_complete: '正在解析结果', parsed: '正在校验并保存', timeout: '本次超时', failed: '本次请求失败' })[timing?.stage] ?? '正在准备请求';
  const attemptSeconds = timing?.startedAt ? ` · 本次 ${Math.max(0, Math.floor((Date.now() - timing.startedAt) / 1000))} 秒` : '';
  return `<div class="wed-generation-status"><span class="wed-spinner" aria-hidden="true"></span>正在生成事件 · 第 ${diagnostic?.attempts ?? 0}/4 次请求 · 累计等待 ${seconds} 秒<br><small>${stage}${attemptSeconds}。每次最多等待 90 秒，最多 4 次。</small><div class="wed-actions-row"><button type="button" class="wed-button danger" data-action="stopGeneration">终止生成</button></div></div>`;
}
