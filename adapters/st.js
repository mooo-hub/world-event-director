import { shortHash, stableHash } from '../core/hash.js';

export function createSillyTavernAdapter({ windowObject = globalThis, documentObject = globalThis.document, logger = console,
  loadWorldInfoModule = () => import('/scripts/world-info.js') } = {}) {
  const win = windowObject;
  const doc = documentObject;
  let chatSaveQueue = Promise.resolve();

  return {
    hasSelectedCharacter() {
      const context = getContext(win);
      const selectedId = context.characterId ?? context.this_chid;
      if (context.character && typeof context.character === 'object') return true;
      if (selectedId === undefined || selectedId === null || selectedId === '' || selectedId === -1) return false;
      return Boolean(context.characters?.[selectedId]);
    },

    getIdentity() {
      const context = getContext(win);
      const character = context.characters?.[context.characterId ?? context.this_chid] ?? context.character;
      const data = getCharacterData(character);
      return {
        chatId: String(context.chatId ?? context.chat?.id ?? context.chat?.name ?? getCurrentChatName(win) ?? 'unknown-chat'),
        branchId: String(context.branchId ?? context.chat?.branchId ?? 'main'),
        characterId: String(context.characterId ?? context.this_chid ?? data.avatar ?? data.name ?? 'unknown-character'),
      };
    },

    async readCharacter() {
      const context = getContext(win);
      const character = context.characters?.[context.characterId ?? context.this_chid] ?? context.character ?? {};
      const data = getCharacterData(character);
      const text = [
        data.name,
        data.description,
        data.personality,
        data.scenario,
        data.mes_example,
        data.creator_notes,
        data.system_prompt,
        data.post_history_instructions,
        data.extensions ? JSON.stringify(data.extensions) : '',
      ]
        .filter(Boolean)
        .join('\n');
      return {
        id: String(context.characterId ?? context.this_chid ?? data.avatar ?? data.name ?? 'unknown-character'),
        name: data.name || '未知角色',
        summary: summarizeText(text, 1200),
        text,
        tags: collectTags(data),
        source: { type: 'character-card', id: String(context.characterId ?? context.this_chid ?? data.avatar ?? data.name ?? 'unknown-character') },
        hash: await stableHash({ id: context.characterId ?? context.this_chid, text: normalizeSourceText(text),
          world: data.extensions?.world ?? data.world ?? '', characterBook: data.character_book ?? null }),
        updatedAt: Date.now(),
      };
    },

    async readWorldbooks() {
      const context = getContext(win);
      const books = collectWorldbookCandidates(context, win);
      if (context.loadWorldInfo) {
        // ST 1.18 exposes names and a loader, not worldbook bodies in getContext().
        const module = await loadWorldInfoModule();
        const character = context.characters?.[context.characterId ?? context.this_chid] ?? context.character;
        const data = getCharacterData(character);
        const avatar = String(character?.avatar ?? '').replace(/\.[^.]+$/, '');
        const names = new Set([
          ...(module.selected_world_info ?? []),
          ...(module.world_info?.charLore?.find((item) => item.name === avatar)?.extraBooks ?? []),
          data.extensions?.world,
          (context.chatMetadata ?? context.chat_metadata)?.world_info,
          (context.powerUserSettings ?? context.power_user)?.persona_description_lorebook,
        ].filter(Boolean));
        for (const name of names) {
          const book = await context.loadWorldInfo(name);
          if (!book?.entries) throw new Error('无法读取已启用世界书，请重新同步上下文');
          books.push({ ...book, id: name, name, source: 'external' });
        }
      }
      const results = [];
      for (const book of books) {
        const entries = normalizeWorldbookEntries(book);
        const text = entries
          .map((entry) => [entry.keys.join(','), entry.comment, entry.content]
            .filter(Boolean)
            .join('\n'))
          .filter(Boolean)
          .join('\n\n');
        results.push({
          id: String(book.id ?? book.name ?? shortHash(text)),
          name: book.name ?? book.file ?? '启用世界书',
          summary: summarizeText(text, 1600),
          text,
          entries,
          tags: collectTags(book),
          hash: await stableHash({ id: book.id ?? book.name, name: book.name, source: book.source ?? 'worldbook',
            entries: [...entries].sort((a, b) => a.id.localeCompare(b.id)).map(({ content, ...entry }) =>
              ({ ...entry, content: normalizeSourceText(content) })) }),
          updatedAt: Date.now(),
        });
      }
      return [...new Map(results.map((book) => [book.id, book])).values()].sort((a, b) => a.id.localeCompare(b.id));
    },

    async readUserPersona() {
      const context = getContext(win);
      const powerUser = context.power_user ?? context.powerUserSettings ?? win.power_user ?? {};
      const name = context.name1 ?? context.userName ?? powerUser.persona_name ?? 'User';
      const text = context.persona_description ?? context.personaDescription ?? powerUser.persona_description ?? '';
      const id = String(context.user_avatar ?? powerUser.persona_avatar ?? name);
      return {
        id: `user:${id}`,
        name: String(name),
        text: String(text),
        summary: summarizeText(text, 1200),
        hash: await stableHash(`${name}\n${text}`),
        source: { type: 'user-card', id },
      };
    },

    async readPreset() {
      const context = getContext(win);
      const preset = context.openai_settings ?? context.oai_settings ?? context.chatCompletionSettings
        ?? win.openai_settings ?? win.oai_settings ?? {};
      const prompts = Array.isArray(preset.prompts) ? preset.prompts : [];
      const promptById = new Map(prompts.map((prompt) => [prompt.identifier, prompt]));
      const orders = Array.isArray(preset.prompt_order) ? preset.prompt_order : [];
      const requestedOrderId = context.prompt_order_character_id ?? context.promptManager?.activeCharacterId;
      const activeOrder = orders.find((row) => String(row.character_id) === String(requestedOrderId))
        ?? [...orders].sort((left, right) => countEnabled(right) - countEnabled(left))[0];
      const ordered = (activeOrder?.order ?? prompts.map((prompt) => ({ identifier: prompt.identifier, enabled: prompt.enabled !== false })))
        .filter((item) => item.enabled !== false)
        .flatMap((item, index) => {
          const prompt = promptById.get(item.identifier);
          if (!prompt?.content || prompt.marker) return [];
          return [{ id: prompt.identifier, name: prompt.name ?? prompt.identifier, role: prompt.role ?? 'system', content: String(prompt.content), order: index }];
        });
      return {
        name: preset.name ?? context.presetName ?? 'active-preset',
        squashSystemMessages: Boolean(preset.squash_system_messages),
        prompts: ordered,
        hash: await stableHash(ordered.map((prompt) => [prompt.id, prompt.role, prompt.content])),
      };
    },

    async readRecentMessages(limit = 30) {
      const context = getContext(win);
      const chat = Array.isArray(context.chat) ? context.chat : Array.isArray(win.chat) ? win.chat : [];
      const rows = chat.slice(-limit).map((message, offset) => normalizeMessage(message, Math.max(0, chat.length - limit) + offset));
      if (rows.length > 0) return rows;
      return readMessagesFromDom(doc, limit);
    },

    async readAllMessages() {
      const context = getContext(win);
      const chat = Array.isArray(context.chat) ? context.chat : Array.isArray(win.chat) ? win.chat : [];
      if (chat.length) return chat.map((message, index) => normalizeMessage(message, index));
      return readMessagesFromDom(doc, Number.MAX_SAFE_INTEGER);
    },

    async readMessagesAfter(messageId, limit = 30) {
      const context = getContext(win);
      const chat = Array.isArray(context.chat) ? context.chat : Array.isArray(win.chat) ? win.chat : null;
      const messages = chat
        ? chat.slice(-limit).map((message, offset) => normalizeMessage(message, Math.max(0, chat.length - limit) + offset))
        : await this.readRecentMessages(limit);
      if (!messageId) return messages.slice(-limit);
      const index = messages.findIndex((message) => message.id === messageId);
      return index >= 0 ? messages.slice(index + 1) : messages.slice(-limit);
    },

    getExtensionSettings(name) {
      const context = getContext(win);
      const settings = context.extensionSettings ?? context.extension_settings ?? win.extension_settings ?? {};
      return settings[name] ?? {};
    },

    setExtensionSettings(name, value) {
      const context = getContext(win);
      // SillyTavern serializes the extension_settings object exposed by getContext().
      // A window-level object may be a stale compatibility copy and must not win.
      const root = context.extensionSettings ?? context.extension_settings ?? win.extension_settings ?? (win.extension_settings = {});
      root[name] = value;
      if (win.extension_settings && win.extension_settings !== root) win.extension_settings[name] = value;
      context.saveSettingsDebounced?.();
      win.saveSettingsDebounced?.();
    },

    getChatMetadata(key) {
      const metadata = getChatMetadataRoot(win);
      return metadata[key] ?? null;
    },

    setChatMetadata(key, value) {
      const metadata = getChatMetadataRoot(win);
      metadata[key] = value;
      const context = getContext(win);
      const saveChat = context.saveChat ?? context.saveMetadata ?? context.saveChatConditional
        ?? win.saveChat ?? win.saveMetadata ?? win.saveChatConditional;
      if (typeof saveChat !== 'function') return undefined;
      chatSaveQueue = chatSaveQueue.catch(() => {}).then(() => saveChat.call(context));
      return chatSaveQueue;
    },

    injectTemporarySystemPrompt(prompt, options = {}) {
      const context = getContext(win);
      const args = [options.id ?? 'world-event-director', prompt, options.position ?? 1, options.depth ?? 0, Boolean(options.scan), options.role ?? 'system'];
      if (typeof context.setExtensionPrompt === 'function') {
        context.setExtensionPrompt(...args);
        return true;
      }
      if (typeof win.setExtensionPrompt === 'function') {
        win.setExtensionPrompt(...args);
        return true;
      }
      return false;
    },

    setExtensionPrompt(prompt, options = {}) {
      const context = getContext(win);
      const args = [options.id ?? 'world-event-director', prompt, options.position ?? 1, options.depth ?? 0, Boolean(options.scan), options.role ?? 'system'];
      if (typeof context.setExtensionPrompt === 'function') {
        context.setExtensionPrompt(...args);
        return true;
      }
      if (typeof win.setExtensionPrompt === 'function') {
        win.setExtensionPrompt(...args);
        return true;
      }
      return false;
    },

    clearTemporarySystemPrompt(id = 'world-event-director') {
      const context = getContext(win);
      context.setExtensionPrompt?.(id, '', 1, 0, false, 'system');
      win.setExtensionPrompt?.(id, '', 1, 0, false, 'system');
    },

    onMessage(callback) {
      const listener = (messageId, type) => {
        const context = getContext(win);
        const message = context.chat?.[messageId];
        const stream = context.streamingProcessor;
        const successful = Boolean(message?.gen_finished && !message?.is_user
          && (!stream || (stream.isFinished && !stream.abortController?.signal?.aborted)));
        return callback(messageId, type, { successful });
      };
      return registerEvent(win, ['message_received', 'MESSAGE_RECEIVED'], listener, logger) ?? observeMessages(doc, callback);
    },

    getGenerationOutcome() {
      const stream = getContext(win).streamingProcessor;
      return stream?.isFinished === true && stream.abortController?.signal?.aborted === false ? 'completed' : 'unknown';
    },

    onChatChanged(callback) {
      return registerEvent(win, ['chat_changed', 'CHAT_CHANGED'], callback, logger);
    },

    onSourcesChanged(callback) {
      return registerEvent(win, ['worldinfo_updated', 'WORLDINFO_UPDATED', 'worldinfo_settings_updated',
        'WORLDINFO_SETTINGS_UPDATED', 'character_edited', 'CHARACTER_EDITED'], callback, logger);
    },

    onGenerationStarted(callback) {
      return registerEvent(win, ['generation_started', 'GENERATION_STARTED', 'generation_started_before'], callback, logger);
    },

    onGenerationEnded(callback) {
      return registerEvent(win, ['generation_ended', 'GENERATION_ENDED', 'generation_ended_after'], callback, logger);
    },

    onGenerationStopped(callback) {
      return registerEvent(win, ['generation_stopped', 'GENERATION_STOPPED'], callback, logger);
    },

    onGenerationData(callback) {
      return registerEvent(win, ['generate_after_data', 'GENERATE_AFTER_DATA'], callback, logger);
    },

    mountPanel(element) {
      const target = doc?.querySelector?.('#extensions_settings') ?? doc?.querySelector?.('#extensions_settings2');
      target?.appendChild?.(element);
      doc?.getElementById?.('world-event-director-chat-entry')?.remove();
    },
  };
}

function getContext(win) {
  return win.SillyTavern?.getContext?.() ?? win.SillyTavernContext ?? win;
}

function getCurrentChatName(win) {
  return win.selected_chat || win.chat_metadata?.chat_id || win.chat?.name;
}

function getChatMetadataRoot(win) {
  const context = getContext(win);
  return context.chatMetadata ?? context.chat_metadata ?? win.chat_metadata ?? (win.chat_metadata = {});
}

function normalizeMessage(message = {}, index = 0) {
  const role = message.is_user || message.role === 'user' ? 'user' : message.is_system || message.role === 'system' ? 'system' : 'assistant';
  const text = message.mes ?? message.text ?? message.content ?? '';
  const createdAt = message.send_date ?? message.createdAt ?? message.created_at ?? index;
  return {
    id: String(message.id ?? `${index}:${shortHash(`${role}:${text}:${createdAt}`)}`),
    role,
    text: String(text),
    turn: index,
    createdAt,
  };
}

function readMessagesFromDom(doc, limit) {
  const nodes = [...(doc?.querySelectorAll?.('.mes') ?? [])].slice(-limit);
  return nodes.map((node, index) => {
    const text = node.querySelector?.('.mes_text')?.textContent ?? node.textContent ?? '';
    const role = node.classList?.contains('user_mes') ? 'user' : 'assistant';
    return {
      id: node.getAttribute?.('mesid') ?? `${index}:${shortHash(text)}`,
      role,
      text: text.trim(),
      turn: index,
      createdAt: node.getAttribute?.('send_date') ?? Date.now(),
    };
  });
}

function collectWorldbookCandidates(context, win) {
  const candidates = [];
  const roots = [context.world_info, context.worldInfo, context.world_names, win.world_info, win.worldInfo].filter(Boolean);
  for (const root of roots) {
    if (Array.isArray(root)) candidates.push(...root);
    else if (typeof root === 'object' && (root.entries || root.name || root.file)) candidates.push(root);
    else if (typeof root === 'object' && Object.values(root).some((value) => value?.content || value?.text)) {
      candidates.push({ name: '启用世界书', entries: root });
    } else if (typeof root === 'object') candidates.push(...Object.values(root));
  }
  const character = context.characters?.[context.characterId ?? context.this_chid] ?? context.character;
  const embedded = getCharacterData(character).character_book;
  if (embedded?.entries) candidates.push({ ...embedded, id: embedded.id ?? `character-book:${getCharacterData(character).name ?? 'unknown'}` });
  return candidates.filter((book) => book && book.disabled !== true && book.enabled !== false);
}

function getCharacterData(character = {}) {
  const data = character?.data && typeof character.data === 'object' ? character.data : {};
  return { ...character, ...data, extensions: { ...(character.extensions ?? {}), ...(data.extensions ?? {}) } };
}

function normalizeWorldbookEntries(book = {}) {
  const raw = book.entries ?? book.content ?? book.data ?? [];
  const rows = Array.isArray(raw) ? raw : Object.values(raw);
  return rows
    .filter(Boolean)
    .map((entry, index) => ({
      id: String(entry.id ?? entry.uid ?? index),
      keys: normalizeStringList(entry.keys ?? entry.key),
      secondaryKeys: normalizeStringList(entry.secondary_keys ?? entry.keysecondary),
      comment: String(entry.comment ?? ''),
      content: String(entry.content ?? entry.text ?? ''),
      enabled: entry.enabled !== false && entry.disable !== true,
      constant: Boolean(entry.constant),
      selective: Boolean(entry.selective),
      order: Number(entry.insertion_order ?? entry.order ?? 100),
      position: entry.position ?? entry.extensions?.position ?? null,
      depth: Number(entry.depth ?? entry.extensions?.depth ?? 4),
      automationId: entry.automationId ?? entry.extensions?.automation_id ?? null,
      source: entry.source ?? entry.extensions?.source ?? null,
      tags: collectTags(entry),
    }))
    .filter((entry) => entry.enabled && entry.content);
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (!value) return [];
  return String(value).split(/[,，|]/).map((item) => item.trim()).filter(Boolean);
}

function collectTags(value = {}) {
  const raw = [value.tags, value.tag_map, value.extensions?.tags].flat().filter(Boolean);
  return [...new Set(raw.flatMap((item) => (typeof item === 'string' ? item.split(/[,，|]/) : [])).map((tag) => tag.trim()).filter(Boolean))];
}

function summarizeText(text, maxLength) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function countEnabled(order = {}) {
  return (order.order ?? []).filter((item) => item.enabled !== false).length;
}

function registerEvent(win, names, callback, logger) {
  const eventSource = getContext(win).eventSource ?? win.eventSource;
  const eventTypes = getContext(win).event_types ?? win.event_types ?? {};
  if (!eventSource?.on) return null;
  const registered = [];
  for (const eventName of new Set(names.map((name) => eventTypes[name] ?? name))) {
    try {
      eventSource.on(eventName, callback);
      registered.push(eventName);
    } catch (error) {
      logger.warn?.(`注册事件失败：${name}`, error.message);
    }
  }
  return registered.length ? () => registered.forEach((eventName) => {
    eventSource.removeListener?.(eventName, callback);
    eventSource.off?.(eventName, callback);
  }) : null;
}

function normalizeSourceText(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').trim();
}

function observeMessages(doc, callback) {
  const target = doc?.querySelector?.('#chat');
  if (!target || typeof MutationObserver === 'undefined') return null;
  const observer = new MutationObserver(() => callback());
  observer.observe(target, { childList: true, subtree: true });
  return () => observer.disconnect();
}
