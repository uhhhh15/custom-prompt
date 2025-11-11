// index.js (Custom Prompt Injector Plugin)
// Based on the 'star' (Favorites) plugin framework.
// This version is refactored to manage and inject per-chat custom prompts.

// --- SillyTavern Core Imports ---
// index.js (Custom Prompt Injector Plugin)
// ... (lines 1-5)
import {
    eventSource,
    event_types,
    chat,
    getRequestHeaders,
    saveSettingsDebounced,
    extension_prompt_types, // <-- 新增
    extension_prompt_roles, // <-- 新增
    doNewChat,
    renameChat,
    openCharacterChat,
    reloadCurrentChat,
    saveChatConditional, // <-- 新增
} from '../../../../script.js';
// ...
import {
    getContext,
    renderExtensionTemplateAsync,
    extension_settings,
    saveMetadataDebounced,
} from '../../../extensions.js';
import {
    POPUP_TYPE,
    callGenericPopup,
} from '../../../popup.js';

// =================================================================
//                      PLUGIN CONSTANTS & CONFIG
// =================================================================
const pluginName = 'custom-prompt';
const METADATA_KEY = 'custom_prompt_injector_data'; // Unique key for storing data in chat metadata

// --- UI Constants ---
const MODAL_ID = 'promptInjectorModal';
const MODAL_CLASS_NAME = 'prompt-injector-modal-dialog';
const MODAL_HEADER_CLASS = 'prompt-injector-modal-header';
const MODAL_TITLE_CLASS = 'prompt-injector-modal-title';
const MODAL_CLOSE_X_CLASS = 'prompt-injector-modal-close-x';
const MODAL_BODY_CLASS = 'prompt-injector-modal-body';
const SIDEBAR_TOGGLE_CLASS = 'prompt-injector-sidebar-toggle';
const SIDEBAR_TOGGLE_ID = 'prompt-injector-avatar-toggle';

// =================================================================
//                      PLUGIN STATE & REFERENCES
// =================================================================
let modalElement = null;
let modalDialogElement = null;
let modalTitleElement = null;
let modalBodyElement = null;

let currentViewingChatFile = null;      // Tracks which chat's prompt is being viewed/edited
let allChatsPromptData = [];            // Cache for all chats and their prompt data
let chatListScrollTop = 0;
let isLoadingOtherChats = false;
let dirtyChats = new Set();             // NEW: Tracks chat file names that have been modified

// =================================================================
//                      THEME MANAGEMENT
// =================================================================
/**
 * Applies the saved theme from localStorage when the modal opens.
 */
function applySavedTheme() {
    // This plugin will respect the theme set by the main 'star' plugin if present.
    // MODIFICATION: Force light theme by always removing the dark-theme class.
    if (modalDialogElement) {
        modalDialogElement.classList.remove('dark-theme');
    }
}

// =================================================================
//                      CORE ENGINE: PROMPT INJECTION
// =================================================================

/**
 * The core engine of the plugin. It reads the current chat's metadata
 * and injects the custom prompt, or clears it if none is found.
 * This MUST be called on every chat change.
 */
function applyOrClearCustomPrompt() {
    try {
        const context = getContext();
        if (!context || !context.chatMetadata) return;

        // Get per-chat content for the macro
        const promptData = context.chatMetadata[METADATA_KEY];
        const perChatContent = promptData?.prompt || '';

        // Get the global preset template
        const presetTemplate = extension_settings[pluginName]?.preset || '';

        let finalPrompt = '';

        if (presetTemplate.trim() !== '') {
            // If template exists, replace the macro
            finalPrompt = presetTemplate.replace(/\{\{总结\}\}/g, perChatContent);
        } else {
            // Otherwise, just use the per-chat content directly
            finalPrompt = perChatContent;
        }

        const injectionKey = 'custom_prompt_injector_main';

        if (finalPrompt.trim() !== '') {
            context.setExtensionPrompt(
                injectionKey,
                finalPrompt,
                extension_prompt_types.IN_CHAT,
                5000,
                false,
                extension_prompt_roles.SYSTEM
            );
            console.log(`[${pluginName}] Injected prompt for chat: ${context.chatId}`);
        } else {
            // Clear any existing injection if the final prompt is empty
            context.setExtensionPrompt(
                injectionKey,
                '',
                extension_prompt_types.IN_CHAT,
                5000,
                false,
                extension_prompt_roles.SYSTEM
            );
        }
    } catch (error) {
        console.error(`[${pluginName}] Error applying custom prompt:`, error);
    }
}


// =================================================================
//                      UI MODAL FUNCTIONS
// =================================================================

function ensureModalStructure() {
    if (modalElement) return;

    modalElement = document.createElement('div');
    modalElement.id = MODAL_ID;
    modalElement.innerHTML = `
        <div class="${MODAL_CLASS_NAME}">
            <div class="${MODAL_HEADER_CLASS}">
                <img id="${SIDEBAR_TOGGLE_ID}" class="${SIDEBAR_TOGGLE_CLASS}" src="img/ai4.png" title="切换侧边栏">
                <h3 class="${MODAL_TITLE_CLASS}">自定义提示词</h3>
                <div id="prompt-injector-migrate-btn" class="${MODAL_CLOSE_X_CLASS}" title="总结迁移"><i class="fa-solid fa-right-left"></i></div>
                <div class="${MODAL_CLOSE_X_CLASS}"><i class="fa-solid fa-xmark"></i></div>
            </div>
            <div class="${MODAL_BODY_CLASS}"></div>
        </div>
    `;
    document.body.appendChild(modalElement);

    modalDialogElement = modalElement.querySelector(`.${MODAL_CLASS_NAME}`);
    modalTitleElement = modalElement.querySelector(`.${MODAL_TITLE_CLASS}`);
    modalBodyElement = modalElement.querySelector(`.${MODAL_BODY_CLASS}`);

    // --- Event Listeners ---
    // N.B. querySelector grabs the first one, which is now the migrate button. That's not what we want for the close button.
    modalElement.querySelectorAll(`.${MODAL_CLOSE_X_CLASS}`)[1].addEventListener('click', closePromptModal);
    modalElement.querySelector('#prompt-injector-migrate-btn').addEventListener('click', handleOpenMigrationModal);
    modalElement.querySelector(`.${SIDEBAR_TOGGLE_CLASS}`).addEventListener('click', () => {
        modalDialogElement.classList.toggle('sidebar-closed');
    });
    modalElement.addEventListener('click', (e) => {
        if (e.target === modalElement) {
            closePromptModal();
        }
    });

    modalBodyElement.addEventListener('click', handleModalClick);
}

function centerModal() {
    if (!modalDialogElement) return;
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;
    const dialogWidth = modalDialogElement.offsetWidth;
    const dialogHeight = modalDialogElement.offsetHeight;
    modalDialogElement.style.left = `${Math.max(0, (windowWidth - dialogWidth) / 2)}px`;
    modalDialogElement.style.top = `${Math.max(0, (windowHeight - dialogHeight) / 2)}px`;
}

/**
 * NEW: Wrapper to handle opening the migration modal and processing the result.
 */
async function handleOpenMigrationModal() {
    try {
        const context = getContext();
        const defaultNewChatName = `${context.name2} (续)`;
        const newChatName = await openMigrationModal(defaultNewChatName);

        // If user confirmed and provided a name
        if (newChatName) {
            await handleMigration(newChatName);
        }
    } catch (error) {
        // User cancelled the modal
        console.log(`[${pluginName}] Chat migration cancelled. Reason:`, error);
    }
}

/**
 * NEW: Opens a modal to get the new chat name for migration.
 * Returns a promise that resolves with the new name, or rejects on cancel.
 * @param {string} defaultValue The default value for the input field.
 * @returns {Promise<string>}
 */
function openMigrationModal(defaultValue) {
    return new Promise((resolve, reject) => {
        // 1. Create Modal Elements
        const modalContainer = document.createElement('div');
        modalContainer.id = 'migrationModal';

        // MODIFICATION: Removed the logic that checks for and adds 'dark-theme'.

        modalContainer.innerHTML = `
            <div class="migration-dialog">
                <div class="migration-header">
                    <h4 class="migration-title">总结与历史记录迁移</h4>
                    <div class="migration-close-x" title="关闭">&times;</div>
                </div>
                <div class="migration-body">
                    <p>是否复制该聊天当前{{总结}}和最新未隐藏的楼层（并删除新聊天第0楼）至新聊天？</p>
                    <input type="text" class="migration-input" placeholder="输入新聊天的名称...">
                </div>
                <div class="migration-footer">
                    <button class="migration-button confirm">确认</button>
                </div>
            </div>
        `;
        document.body.appendChild(modalContainer);

        const input = modalContainer.querySelector('.migration-input');
        input.value = defaultValue;

        // 2. Cleanup and Close Logic
        const cleanupAndClose = (reason) => {
            document.removeEventListener('keydown', handleEsc);
            modalContainer.remove();
            if (reason) {
                reject(reason);
            }
        };

        // 3. Event Listeners
        modalContainer.querySelector('.confirm').addEventListener('click', () => {
            const newName = input.value.trim();
            if (newName) {
                resolve(newName);
                cleanupAndClose();
            } else {
                toastr.warning('新聊天名称不能为空！');
                input.focus();
            }
        });

        modalContainer.querySelector('.migration-close-x').addEventListener('click', () => cleanupAndClose('closed'));
        modalContainer.addEventListener('click', (e) => {
            if (e.target === modalContainer) {
                cleanupAndClose('clicked_outside');
            }
        });

        const handleEsc = (event) => {
            if (event.key === 'Escape') {
                cleanupAndClose('esc_pressed');
            }
        };
        document.addEventListener('keydown', handleEsc);

        // 4. Show modal
        requestAnimationFrame(() => {
            modalContainer.classList.add('visible');
            // 仅在非触摸设备上自动聚焦，以避免在手机上自动弹出键盘
            if (!('ontouchstart' in window)) {
                input.focus();
            }
        });
    });
}

/**
 * NEW: Core logic for migrating chat summary and history. (Rewritten for robustness)
 * @param {string} newChatName The name for the new chat.
 */
async function handleMigration(newChatName) {
    toastr.info('正在开始聊天迁移...');
    // 【步骤 1】获取并锁定源聊天的数据
    const oldContext = getContext();
    oldContext.showLoader();

    try {
        const sourceChatData = allChatsPromptData.find(c => String(c.fileName).replace('.jsonl', '') === currentViewingChatFile);
        if (!sourceChatData) {
            throw new Error('找不到源聊天数据。');
        }

        const sourceChatName = sourceChatData.fileName;
        const sourceChatNameNoExt = String(sourceChatName).replace('.jsonl', '');
        const currentContextChatIdNoExt = String(oldContext.chatId).replace('.jsonl', '');

        // 【步骤 2】确定最终要迁移的消息源，并执行过滤
        let messagesToFilter;
        // 优先使用内存中的实时数据，以确保 hide.js 等插件的修改被捕获
        if (sourceChatNameNoExt === currentContextChatIdNoExt) {
            messagesToFilter = oldContext.chat;
            console.log(`[${pluginName}] Migrating from LIVE chat context. Message count: ${messagesToFilter.length}`);
        } else {
            messagesToFilter = sourceChatData.messages;
            console.log(`[${pluginName}] Migrating from CACHED chat data. Message count: ${messagesToFilter.length}`);
        }

        // 执行过滤，只保留 is_system 不为 true 的消息
        const filteredHistory = messagesToFilter.filter(msg => msg.is_system !== true);
        console.log(`[${pluginName}] Messages after filtering: ${filteredHistory.length}`);
        toastr.info(`将迁移 ${filteredHistory.length} 条未隐藏的消息。`);


        // 【步骤 3】标记源聊天（此操作现在使用已加载的数据，避免副作用）
        const migrationId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const sourceMetadataCopy = JSON.parse(JSON.stringify(sourceChatData.metadata)); // 创建深拷贝
        sourceMetadataCopy[METADATA_KEY] = sourceMetadataCopy[METADATA_KEY] || {};
        sourceMetadataCopy[METADATA_KEY].migration = {
            type: 'source',
            migrated_to: newChatName,
            id: migrationId,
            timestamp: new Date().toISOString(),
        };
        await saveSpecificChatMetadata(sourceChatName, sourceMetadataCopy, sourceChatData.messages);
        toastr.info(`源聊天 "${sourceChatName}" 已标记。`);


        // 【步骤 4】创建并切换到新聊天
        await doNewChat({ deleteCurrentChat: false });
        const tempChatName = String(getContext().chatId).replace('.jsonl', '');
        await renameChat(tempChatName, newChatName);
        await openCharacterChat(newChatName);


        // 【步骤 5】在新聊天中执行迁移操作
        // 此时全局的 'chat' 变量已指向新聊天
        if (chat.length > 0) {
            // await deleteMessage(0); // 删除新聊天的初始问候语
            chat.splice(0, 1); // 直接操作数组，移除第一个元素，以兼容旧版环境
        }
        
        // 使用我们之前安全过滤好的 'filteredHistory'
        chat.push(...filteredHistory.map(msg => ({ ...msg })));

        // 【步骤 6】为新聊天更新元数据
        // 关键：重新获取上下文，确保操作对象是新聊天
        const newContext = getContext(); 
        const newChatMetadata = { ...(sourceChatData.metadata[METADATA_KEY] || {}) }; // 复制总结
        newChatMetadata.migration = {
            type: 'destination',
            migrated_from: sourceChatName,
            id: migrationId,
            timestamp: new Date().toISOString(),
        };
        newContext.updateChatMetadata({
            [METADATA_KEY]: newChatMetadata
        });


        // 【步骤 7】收尾工作
        await saveChatConditional();
        await closePromptModal();
        await reloadCurrentChat();

        toastr.success(`聊天已成功迁移至 "${newChatName}"！`);

    } catch (error) {
        console.error(`[${pluginName}] Migration failed:`, error);
        toastr.error(`聊天迁移失败: ${error.message}`);
    } finally {
        oldContext.hideLoader(); // 确保加载动画被关闭
    }
}


async function openPromptModal() {
    ensureModalStructure();
    applySavedTheme();

    const context = getContext();
    let avatarSrc = 'img/ai4.png';
    if (context.characterId !== undefined && context.characters && context.characters[context.characterId]) {
        const characterAvatar = context.characters[context.characterId].avatar;
        if (characterAvatar && characterAvatar !== 'multichar_dummy.png') {
            avatarSrc = `characters/${characterAvatar}`;
        }
    } else if (context.groupId) {
         const group = context.groups.find(g => g.id === context.groupId);
         if (group && group.avatar && group.avatar !== 'multichar_dummy.png') {
             avatarSrc = `groups/${group.avatar}`;
         }
    }
    const avatarToggle = modalElement.querySelector(`#${SIDEBAR_TOGGLE_ID}`);
    if (avatarToggle) avatarToggle.src = avatarSrc;

    modalElement.style.display = 'block';
    centerModal();

    // --- Performance Optimization & State Reset ---
    currentViewingChatFile = null;
    allChatsPromptData = [];
    isLoadingOtherChats = false;
    dirtyChats.clear(); // Reset dirty chats tracker
    modalBodyElement.innerHTML = '<div class="spinner"></div>';
    modalDialogElement.classList.add('sidebar-closed');

    // Ensure settings object exists
    if (!extension_settings[pluginName]) {
        extension_settings[pluginName] = { preset: '' };
    }
    
    // Immediately render the current chat's prompt editor
    await renderPromptView();

    // Silently load other chats in the background
    loadOtherChatsInBackground();
    
    requestAnimationFrame(() => {
        modalDialogElement.classList.add('visible');
    });

    window.addEventListener('resize', centerModal);
    document.addEventListener('keydown', handleEscKey);
}

/**
 * NEW: Opens a custom modal for editing the global preset template.
 * Returns a promise that resolves with the new text on save, or rejects on cancel.
 * @param {string} currentValue The initial value for the textarea.
 * @returns {Promise<string>}
 */
function openPresetEditor(currentValue) {
    return new Promise((resolve, reject) => {
        // 1. Create Modal Elements
        const modalContainer = document.createElement('div');
        modalContainer.id = 'presetEditorModal';

        // MODIFICATION: Removed the logic that checks for and adds 'dark-theme'.

        modalContainer.innerHTML = `
            <div class="preset-editor-dialog">
                <div class="preset-editor-header">
                    <h4 class="preset-editor-title">编辑全局预设模板</h4>
                    <div class="preset-editor-close-x" title="关闭">&times;</div>
                </div>
                <div class="preset-editor-body">
                    <textarea class="preset-editor-textarea" placeholder="当前预设内容为空。

在此输入总结预设模板，该预设会应用到所有聊天中，其中{{总结}}是总结内容的占位符。

预设为空不影响{{总结}}注入到上下文，两者是独立协同的。

关于预设，您可写成：

</总结>是我们历史对话的总结内容，请务必在每次回答之前，参考该总结作为聊天上下文回答：
<总结>
{{总结}}
</总结>
"></textarea>
                </div>
                <div class="preset-editor-footer">
                    <button class="preset-editor-button save">保存</button>
                </div>
            </div>
        `;
        document.body.appendChild(modalContainer);

        const textarea = modalContainer.querySelector('.preset-editor-textarea');
        textarea.value = currentValue;

        // 2. Cleanup and Close Logic
        const cleanupAndClose = (reason) => {
            document.removeEventListener('keydown', handleEsc);
            modalContainer.remove();
            if (reason) {
                reject(reason);
            }
        };

        // 3. Event Listeners
        modalContainer.querySelector('.save').addEventListener('click', () => {
            resolve(textarea.value);
            cleanupAndClose();
        });

        modalContainer.querySelector('.preset-editor-close-x').addEventListener('click', () => cleanupAndClose('closed'));
        modalContainer.addEventListener('click', (e) => {
            if (e.target === modalContainer) {
                cleanupAndClose('clicked_outside');
            }
        });

        const handleEsc = (event) => {
            if (event.key === 'Escape') {
                cleanupAndClose('esc_pressed');
            }
        };
        document.addEventListener('keydown', handleEsc);

        // 4. Show modal with animation
        // Using requestAnimationFrame to ensure the transition is applied after the element is in the DOM
        requestAnimationFrame(() => {
            modalContainer.classList.add('visible');
            // 仅在非触摸设备上自动聚焦，以避免在手机上自动弹出键盘
            if (!('ontouchstart' in window)) {
                textarea.focus();
            }
        });
    });
}

async function closePromptModal() {
    await saveAllDirtyChanges(); // Save everything before closing

    if (modalElement) {
        modalElement.style.display = 'none';
        if (modalDialogElement) {
            modalDialogElement.classList.remove('visible');
        }
    }
    window.removeEventListener('resize', centerModal);
    document.removeEventListener('keydown', handleEscKey);
}

function handleEscKey(event) {
    if (event.key === 'Escape') {
        closePromptModal();
    }
}

// =================================================================
//                      UI RENDERING
// =================================================================

async function renderPromptView(selectedChatFileName = null) {
    const context = getContext();
    const currentContextChatIdNoExt = String(context.chatId || '').replace('.jsonl', '');
    const selectedChatFileNameNoExt = selectedChatFileName ? String(selectedChatFileName).replace('.jsonl', '') : null;

    if (allChatsPromptData.length === 0) {
        const currentChatMetadata = context.chatMetadata || {};
        const initialData = {
            fileName: currentContextChatIdNoExt,
            fullFileName: `${currentContextChatIdNoExt}.jsonl`,
            displayName: currentContextChatIdNoExt,
            metadata: currentChatMetadata,
            messages: context.chat || [],
            isGroup: !!context.groupId,
            characterId: context.characterId,
            groupId: context.groupId,
        };
        allChatsPromptData.push(initialData);
        currentViewingChatFile = currentContextChatIdNoExt;
    } else if (selectedChatFileNameNoExt) {
        currentViewingChatFile = selectedChatFileNameNoExt;
    } else {
        currentViewingChatFile = currentContextChatIdNoExt;
    }

    let viewingChatData = allChatsPromptData.find(chatData => String(chatData.fileName).replace('.jsonl', '') === currentViewingChatFile);
    
    if (!viewingChatData && !isLoadingOtherChats) {
        modalBodyElement.innerHTML = '<div class="spinner"></div>';
        const fullChatData = await getFullChatData(context.characterId, context.groupId, currentViewingChatFile, !!context.groupId);
        if(fullChatData) {
            viewingChatData = {
                fileName: currentViewingChatFile,
                fullFileName: `${currentViewingChatFile}.jsonl`,
                displayName: currentViewingChatFile,
                ...fullChatData,
                isGroup: !!context.groupId,
                characterId: context.characterId,
                groupId: context.groupId,
            };
            allChatsPromptData.push(viewingChatData);
        }
    } else if (!viewingChatData) {
        modalBodyElement.innerHTML = `<div class="prompt-empty">聊天数据正在加载中...</div>`;
        return;
    }

    const roleName = viewingChatData.isGroup
        ? (context.groups?.find(g => g.id === viewingChatData.groupId)?.name || '未命名群聊')
        : (context.characters[viewingChatData.characterId]?.name || context.name2);
    modalTitleElement.textContent = roleName || '自定义提示词';

    renderChatListPanel();
    renderPromptEditor(viewingChatData);
}

function renderChatListPanel() {
    let panel = modalBodyElement.querySelector('.prompt-chat-list-panel');
    if (!panel) {
        panel = document.createElement('div');
        panel.className = 'prompt-chat-list-panel';
        modalBodyElement.prepend(panel);
    }
    
    const context = getContext();
    const currentContextChatIdNoExt = String(context.chatId || '').replace('.jsonl', '');

    const chatListItemsHtml = `
        <div class="prompt-chat-list-items">
            ${allChatsPromptData.map(chat => {
                const fileNameNoExt = String(chat.fileName).replace('.jsonl', '');
                const hasPrompt = chat.metadata[METADATA_KEY]?.prompt;

                // 【修复】移除了错误的过滤条件，现在会渲染所有聊天项

                const isSelected = fileNameNoExt === currentViewingChatFile;
                return `
                    <div class="prompt-chat-list-item ${isSelected ? 'active' : ''}" data-chat-file="${fileNameNoExt}" title="${chat.fullFileName || fileNameNoExt}">
                        <div class="chat-list-item-name">
                            ${chat.displayName || fileNameNoExt}
                        </div>
                        <div class="chat-list-item-indicator">${hasPrompt ? '✓' : ''}</div>
                    </div>
                `;
            }).join('')}
            ${isLoadingOtherChats ? '<div class="chat-list-loader">加载中...</div>' : ''}
        </div>
    `;
    panel.innerHTML = chatListItemsHtml;
    
    const chatListElement = panel.querySelector('.prompt-chat-list-items');
    if (chatListElement) chatListElement.scrollTop = chatListScrollTop;
}

function renderPromptEditor(viewingChatData) {
    let mainPanel = modalBodyElement.querySelector('.prompt-main-panel');
    if (!mainPanel) {
        mainPanel = document.createElement('div');
        mainPanel.className = 'prompt-main-panel';
        modalBodyElement.appendChild(mainPanel);
    }

    const promptData = viewingChatData.metadata[METADATA_KEY];
    const currentPerChatContent = promptData?.prompt || '';
    const presetTemplate = extension_settings[pluginName]?.preset || '';

    const mainPanelHtml = `
        <div class="prompt-editor-container">
            <textarea id="preset-prompt-textarea" class="text_pole" placeholder="点击可编辑总结预设" readonly></textarea>
            <textarea id="custom-prompt-textarea" class="text_pole" placeholder="该区域文本是{{总结}}内容，它每次都会作为system @9999 注入到上下文中，相当于-1楼消息。每个聊天的{{总结}}都是独立的。">${currentPerChatContent}</textarea>

            <div class="quick-add-container">
                <textarea id="quick-add-textarea" placeholder="快速追加内容至上方..." rows="1"></textarea>
                <button id="quick-add-button" title="追加内容 (Enter 发送)">
                    <i class="fa-solid fa-arrow-up"></i>
                </button>
            </div>
        </div>
    `;

    mainPanel.innerHTML = mainPanelHtml;

    // --- Add event listeners ---

    // 1. Preset Template Textarea (now opens our custom editor)
    const presetTextarea = mainPanel.querySelector('#preset-prompt-textarea');
    presetTextarea.addEventListener('click', async () => {
        try {
            const newPreset = await openPresetEditor(extension_settings[pluginName].preset);

            // Update settings and UI if user confirmed (promise resolved)
            // The check 'typeof newPreset === "string"' is implicitly true if the promise resolves
            presetTextarea.value = newPreset;
            extension_settings[pluginName].preset = newPreset;
            saveSettingsDebounced();
            // We should also apply the changes immediately if the current chat has content
            applyOrClearCustomPrompt();

        } catch (error) {
            // User cancelled the popup (promise rejected), do nothing.
            console.log(`[${pluginName}] Preset edit cancelled. Reason:`, error);
        }
    });

    // 2. Custom Per-Chat Textarea (auto-saving on input)
    const customTextarea = mainPanel.querySelector('#custom-prompt-textarea');
    customTextarea.addEventListener('input', () => {
        const chatDataInCache = allChatsPromptData.find(c => String(c.fileName).replace('.jsonl', '') === currentViewingChatFile);
        if (chatDataInCache) {
            if (!chatDataInCache.metadata[METADATA_KEY]) {
                chatDataInCache.metadata[METADATA_KEY] = {};
            }
            chatDataInCache.metadata[METADATA_KEY].prompt = customTextarea.value;
            dirtyChats.add(currentViewingChatFile); // Mark this chat as modified

            // Update indicator in real-time
            const indicator = document.querySelector(`.prompt-chat-list-item[data-chat-file="${currentViewingChatFile}"] .chat-list-item-indicator`);
            if (indicator) {
                indicator.textContent = customTextarea.value.trim() ? '✓' : '';
            }
        }
    });

    // 3. Quick Add Section Logic
    const quickAddTextarea = mainPanel.querySelector('#quick-add-textarea');
    const quickAddButton = mainPanel.querySelector('#quick-add-button');

    const sendQuickAddContent = () => {
        const contentToAdd = quickAddTextarea.value.trim();
        if (!contentToAdd) return;

        const currentContent = customTextarea.value.trim();
        const newContent = currentContent ? `${currentContent}\n\n${contentToAdd}` : contentToAdd;

        customTextarea.value = newContent;
        quickAddTextarea.value = ''; // Clear the input
        quickAddTextarea.style.height = 'auto'; // Reset height after clearing
        quickAddTextarea.style.height = `${quickAddTextarea.scrollHeight}px`;


        // CRITICAL: Trigger the input event on the main textarea to activate its save logic
        customTextarea.dispatchEvent(new Event('input', { bubbles: true }));
        quickAddTextarea.focus(); // Keep focus for next input
    };

    quickAddButton.addEventListener('click', sendQuickAddContent);
    quickAddTextarea.addEventListener('keydown', (event) => {
        // Send on Enter, but allow Shift+Enter for new lines
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            sendQuickAddContent();
        }
    });

    // Auto-resize for the quick-add textarea
    quickAddTextarea.addEventListener('input', () => {
        quickAddTextarea.style.height = 'auto';
        quickAddTextarea.style.height = `${quickAddTextarea.scrollHeight}px`;
        quickAddButton.disabled = !quickAddTextarea.value.trim();
    });
    // Initial state check for the button
    quickAddButton.disabled = !quickAddTextarea.value.trim();
}

async function loadOtherChatsInBackground() {
    if (isLoadingOtherChats) return;
    isLoadingOtherChats = true;
    renderChatListPanel();

    const otherChatsData = await getAllChatDataForCurrentContext(true); // pass true to skip current chat
    
    const existingFileNames = new Set(allChatsPromptData.map(c => c.fileName));
    otherChatsData.forEach(chatData => {
        if (!existingFileNames.has(chatData.fileName)) {
            allChatsPromptData.push(chatData);
        }
    });

    const context = getContext();
    const currentContextChatIdNoExt = String(context.chatId || '').replace('.jsonl', '');
    allChatsPromptData.sort((a, b) => {
        // 规则1：当前聊天始终置顶
        if (a.fileName === currentContextChatIdNoExt) return -1;
        if (b.fileName === currentContextChatIdNoExt) return 1;

        // 规则2：检查双方是否有总结内容
        const aHasPrompt = a.metadata[METADATA_KEY]?.prompt?.trim();
        const bHasPrompt = b.metadata[METADATA_KEY]?.prompt?.trim();

        // 规则3：有总结的排在没有总结的前面
        if (aHasPrompt && !bHasPrompt) return -1;
        if (!aHasPrompt && bHasPrompt) return 1;

        // 规则4：如果双方都有或都没有总结，则按文件名默认排序
        return a.fileName.localeCompare(b.fileName);
    });

    isLoadingOtherChats = false;
    renderChatListPanel();
}

// =================================================================
//                   MODAL EVENT HANDLER & SAVE LOGIC
// =================================================================

async function handleModalClick(event) {
    const target = event.target;
    const chatListItem = target.closest('.prompt-chat-list-item');
    if (chatListItem) {
        const chatFile = String(chatListItem.dataset.chatFile).replace('.jsonl','');
        if (chatFile && chatFile !== currentViewingChatFile) {
            chatListScrollTop = chatListItem.parentElement.scrollTop;
            await renderPromptView(chatFile);
        }
        return;
    }
}


// =================================================================
//        DATA FETCHING & SAVING (ADAPTED FROM 'STAR' PLUGIN)
// =================================================================

async function getAllChatDataForCurrentContext(skipCurrentChat = false) {
    const context = getContext();
    if (!context) return [];
    
    const currentContextChatIdNoExt = String(context.chatId || '').replace('.jsonl','');
    let chatListResponse, requestBody, allData = [];

    const processChatList = async (list) => {
        for (const chatMeta of list) {
            const chatFileNameWithExt = chatMeta.file_name;
            const chatFileNameNoExt = String(chatFileNameWithExt || '').replace('.jsonl', '');
            if (!chatFileNameNoExt || (skipCurrentChat && chatFileNameNoExt === currentContextChatIdNoExt)) {
                continue;
            }
            const fullChatData = await getFullChatData(context.characterId, context.groupId, chatFileNameNoExt, !!context.groupId, chatMeta);
            // We load all chats that have *any* metadata, to show them in the list
            if (fullChatData) {
                allData.push({
                    fileName: chatFileNameNoExt,
                    fullFileName: chatFileNameWithExt, // <-- 新增，用于悬停提示
                    displayName: chatFileNameNoExt,
                    metadata: fullChatData.metadata,
                    messages: fullChatData.messages || [],
                    isGroup: !!context.groupId,
                    characterId: context.characterId,
                    groupId: context.groupId,
                });
            }
        }
    };

    if (context.groupId) {
        requestBody = { group_id: context.groupId, query: '' };
        try {
            chatListResponse = await fetch('/api/chats/search', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(requestBody) });
            if (chatListResponse.ok) await processChatList(await chatListResponse.json());
        } catch (error) { console.error(`[${pluginName}] Error fetching group chats:`, error); }
	} else if (context.characterId !== undefined && context.characters[context.characterId]) {
		const charObj = context.characters[context.characterId];
		requestBody = { avatar_url: charObj.avatar };
		try {
			chatListResponse = await fetch('/api/characters/chats', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(requestBody) });
            if (chatListResponse.ok) {
                // 【修复】直接使用 API 返回的数组，不再错误地调用 Object.values()
                const characterChatsArray = await chatListResponse.json();
                // 【增强】像 star 插件一样，增加一个健壮性检查，确保我们得到的是一个数组
                if (Array.isArray(characterChatsArray)) {
                    await processChatList(characterChatsArray);
                }
            }
		} catch (error) { console.error(`[${pluginName}] Error fetching character chats:`, error); }
    }
    
    return allData;
}

async function getFullChatData(characterId, groupId, chatFileNameNoExt, isGroup, providedMetadata = null) {
    // This function is complex but robust, adapted directly from the star plugin
    // to fetch full chat data including metadata and messages.
    const context = getContext();
    let endpoint, requestBody, finalMetadataObject = {}, messages = [];
    try {
        if (isGroup) {
            if (!groupId) return null;
            endpoint = '/api/chats/group/get';
            requestBody = { id: groupId, chat_id: chatFileNameNoExt };
            const response = await fetch(endpoint, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(requestBody) });
            if (response.ok) {
                const groupChatData = await response.json();
                if (Array.isArray(groupChatData) && groupChatData.length > 0 && typeof groupChatData[0] === 'object' && !Array.isArray(groupChatData[0])) {
                    finalMetadataObject = JSON.parse(JSON.stringify(groupChatData[0].chat_metadata || groupChatData[0]));
                    messages = groupChatData.slice(1);
                } else {
                    messages = groupChatData;
                }
            }
        } else {
            if (characterId === undefined || !context.characters[characterId]) return null;
            const charObj = context.characters[characterId];
            endpoint = '/api/chats/get';
            requestBody = { ch_name: charObj.name, file_name: chatFileNameNoExt, avatar_url: charObj.avatar };
            const response = await fetch(endpoint, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(requestBody) });
            if (!response.ok) return null;
            const chatDataResponse = await response.json();
            if (Array.isArray(chatDataResponse) && chatDataResponse.length > 0 && typeof chatDataResponse[0] === 'object' && !Array.isArray(chatDataResponse[0])) {
                finalMetadataObject = JSON.parse(JSON.stringify(chatDataResponse[0].chat_metadata || chatDataResponse[0]));
                messages = chatDataResponse.slice(1);
            } else {
                messages = Array.isArray(chatDataResponse) ? chatDataResponse : [];
            }
        }
        return { metadata: finalMetadataObject, messages };
    } catch (error) {
        console.error(`[${pluginName}] getFullChatData error for "${chatFileNameNoExt}":`, error);
        return { metadata: {}, messages: [] };
    }
}

async function saveSpecificChatMetadata(chatFileNameNoExt, metadataToSave, messagesArray = null) {
    // This function is also adapted from the star plugin to save changes to non-active chats.
    const context = getContext();
    try {
        if (messagesArray === null) {
            const fullChatData = await getFullChatData(context.characterId, context.groupId, chatFileNameNoExt, !!context.groupId);
            if (!fullChatData || !fullChatData.messages) { throw new Error('Could not load chat messages to save.'); }
            messagesArray = fullChatData.messages;
        }

        const finalMetadataObjectForSave = { ...metadataToSave, chat_metadata: metadataToSave };
        let chatContentToSave = [finalMetadataObjectForSave, ...messagesArray];

        let requestBody = { chat: chatContentToSave, file_name: chatFileNameNoExt, force: true };
        if (!!context.groupId) {
            if (!context.groupId) throw new Error("Group ID unknown.");
            requestBody.is_group = true;
            requestBody.id = context.groupId;
        } else {
            if (context.characterId === undefined) throw new Error("Character info unknown.");
            const charObj = context.characters[context.characterId];
            requestBody.ch_name = charObj.name;
            requestBody.avatar_url = charObj.avatar;
        }

        const response = await fetch('/api/chats/save', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(requestBody), cache: 'no-cache' });
        if (!response.ok) {
            throw new Error(`Server responded with ${response.status}: ${await response.text()}`);
        }
    } catch (error) {
        console.error(`[${pluginName}] Error in saveSpecificChatMetadata for ${chatFileNameNoExt}`, error);
        toastr.error(`保存聊天 "${chatFileNameNoExt}" 的提示词时发生错误: ${error.message}`);
    }
}

async function saveAllDirtyChanges() {
    if (dirtyChats.size === 0) return; // Nothing to save

    console.log(`[${pluginName}] Saving prompts for ${dirtyChats.size} modified chats.`);
    toastr.info('正在自动保存提示词...');

    const context = getContext();
    const currentContextChatIdNoExt = String(context.chatId || '').replace('.jsonl', '');

    // Create a copy of the set to iterate over, as items might be removed
    const chatsToSave = Array.from(dirtyChats);

    for (const chatFile of chatsToSave) {
        const chatData = allChatsPromptData.find(c => String(c.fileName).replace('.jsonl', '') === chatFile);
        if (!chatData) continue;

        try {
            if (chatFile === currentContextChatIdNoExt) {
                // It's the currently active chat, use the efficient context update
                context.updateChatMetadata({
                    [METADATA_KEY]: chatData.metadata[METADATA_KEY]
                });
                // This will be saved by SillyTavern's existing mechanism,
                // but we call it just in case.
                saveMetadataDebounced();

                // Apply change immediately if it's the active chat
                applyOrClearCustomPrompt();
            } else {
                // It's a different chat, save it to its specific file
                await saveSpecificChatMetadata(chatFile, chatData.metadata, chatData.messages);
            }
            dirtyChats.delete(chatFile); // Remove from set after successful save
        } catch (error) {
            console.error(`[${pluginName}] Failed to save prompt for ${chatFile}:`, error);
            toastr.error(`保存聊天 "${chatFile}" 的提示词失败。`);
        }
    }

    if (dirtyChats.size === 0) {
        toastr.success('所有提示词已成功保存！');
    }
}


// =================================================================
//                      PLUGIN INITIALIZATION
// =================================================================
jQuery(async () => {
    try {
        // 【最终修正】参考 AI指引助手 脚本，定义符合扩展菜单列表的按钮HTML
        // 1. 使用 'list-group-item flex-container flexGap5 interactable' 类，这是SillyTavern扩展菜单项的标准样式。
        // 2. 保持图标 <i> 和文字 <span> 的结构，使其与菜单中其他项保持一致。
        const buttonHtml = `
            <div id="custom_prompt_button" class="list-group-item flex-container flexGap5 interactable" title="管理所有聊天的自定义提示词">
                <i class="fa-solid fa-scroll"></i>
                <span>总结</span>
            </div>
        `;

        // 【最终修正】将按钮注入到 '#extensionsMenu' 内部。
        // '#extensionsMenu' 是点击顶部“扩展”按钮后弹出的那个菜单容器的ID。
        // 使用 .append() 会将按钮作为最后一个菜单项添加进去。
        $('#extensionsMenu').append(buttonHtml);

        // 为新创建的按钮绑定点击事件 (此部分逻辑无需更改)
        $('#custom_prompt_button').on('click', openPromptModal);
        
        // 监听聊天变化以应用正确的提示词 (此部分逻辑无需更改)
        eventSource.on(event_types.CHAT_CHANGED, () => {
            // 为新加载的聊天应用提示词
            applyOrClearCustomPrompt();
        });

        // 为当前打开的聊天进行首次提示词应用 (此部分逻辑无需更改)
        applyOrClearCustomPrompt();

        console.log(`[${pluginName}] Plugin loaded successfully.`);
    } catch (error) {
        console.error(`[${pluginName}] Initialization failed:`, error);
    }
});
