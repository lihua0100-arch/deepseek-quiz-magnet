// ==UserScript==
// @name         DeepSeek 智能题库解析与磁吸自瞄助手 Pro (3.6 通用网页/静默听力版)
// @namespace    https://tampermonkey.net/
// @version      3.6.0
// @updateURL    https://raw.githubusercontent.com/lihua0100-arch/deepseek-quiz-magnet/main/deepseek-quiz-magnet.user.js
// @downloadURL  https://raw.githubusercontent.com/lihua0100-arch/deepseek-quiz-magnet/main/deepseek-quiz-magnet.user.js
// @description  通用网页题目解析助手：整页通读、鼠标指题、静默抓取网页音频并转写听力（需另配语音转写接口），支持跨框架转发与顶层状态栏。
// @author       Gemini
// @match        *://*/*
// @allFrames    true
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      api.deepseek.com
// @connect      api.siliconflow.cn
// @connect      *
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // 过滤面积极小的隐藏统计/广告 iframe
    if (window.self !== window.top && (window.innerWidth < 120 || window.innerHeight < 80)) {
        return;
    }

    const IS_TOP = window.self === window.top;
    const IS_MAC = /Mac|iPod|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
    const MOD_KEY_LABEL = IS_MAC ? '⌃Ctrl(或⌥Opt)' : 'Alt';

    /********************************************************************
     * 1. 配置参数、选择器常量与跨页面持久状态管理
     ********************************************************************/
    const CONFIG = {
        apiUrl: 'https://api.deepseek.com/chat/completions',
        showVisualHint: true,
        panelVisible: false,      // 初始加载时默认隐藏右下角面板，触发解析或按 Alt+H 时显示
        enableStealthTyping: true,
        autoListen: true,         // 解析题目时，若已配置转写服务，自动静默抓取并转写相关音频
        maxAudioBytes: 25 * 1024 * 1024,
        pageTextLimit: 16000
    };

    // DeepSeek 官方接口只有文本模型，没有语音识别；听力转写需另配一个 OpenAI 兼容的 /audio/transcriptions 接口
    const ASR_DEFAULTS = {
        url: 'https://api.siliconflow.cn/v1/audio/transcriptions',
        model: 'FunAudioLLM/SenseVoiceSmall'
    };

    const STATE = {
        apiKey: GM_getValue('DEEPSEEK_API_KEY', ''),
        model: GM_getValue('DEEPSEEK_MODEL', 'deepseek-chat'),
        savedPassage: GM_getValue('DEEPSEEK_SAVED_PASSAGE', ''),
        listeningTranscript: '',
        isListeningASR: false,
        asrInstance: null,
        isTranscribing: false,
        activeCapture: null,         // 实时静默录制句柄 { stop() }
        pageChoiceEls: [],           // 整页模式下高亮的全部正确选项
        lastBadgeAt: 0,

        enabled: true,
        typingUnlocked: false,
        pickerMode: false,
        hoveredScopeEl: null,
        autoTypingTimer: null,
        isAnalyzing: false,
        rawMouse: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
        lastMouseMoveAt: 0,

        questionType: 'choice',      // 'choice' | 'input' | 'translate' | 'essay'
        targetQueue: [],             // [{ el, text, altFormats: [], completed: false }]
        currentQueueIdx: 0,
        altFormatIdx: 0,
        typingCursorIndex: 0
    };

    // U校园 AI版 5.0 (uai.unipus.cn / ucontent.unipus.cn) 与学习通全题型选择器（前置声明，供跨框架检测安全调用）
    const COMMON_CONTAINER_SELECTORS = [
        // U校园 AI版 5.0 专属题块容器
        '.question-common-abs-reply', '.question-inputbox',
        '[class*="question-wrapper"]', '[class*="question-container"]', '[class*="exercise-item"]',
        '[class*="task-item"]', '[class*="stem"]', '[class*="quiz-item"]', '.unipus-question',
        // 学习通 / 超星尔雅专属类名
        '.TiMu', '.singleQuesId', '.questionLi', '.padBom50', '.font-cxsecret',
        // 通用在线题库
        '.question-item', '.question-box', '.question-card', '.exam-item',
        '.subject-item', '.q-item', '.ti-item', '.problem-item',
        '[class*="question"]', '[class*="subject"]', '[class*="topic"]',
        'fieldset', 'article', 'li', 'p', 'div'
    ];

    const COMMON_OPTION_SELECTORS = [
        // U校园 AI版 / AntDesign / React 常见选项类名
        '.ant-radio-wrapper', '.ant-checkbox-wrapper', '[class*="radio-item"]', '[class*="checkbox-item"]',
        '[class*="option-wrap"]', '[class*="option-item"]', '[class*="optionItem"]', '[class*="choice-item"]',
        '[class*="select-option"]', '.ant-select-item-option',
        // 学习通专属选择器
        '.single_choice li', '.multi_choice li', '.true_false li',
        '.answerList li', '.answerBg', '.ans-checkbox', '.ans-radio',
        '.marBom6', '.ul-list li', '.clearfix li',
        // 通用题库
        '.option', '.options li', '.question-option', '.answer-item',
        '.el-radio', '.el-checkbox', 'label', 'li[role="option"]', 'div[role="radio"]', 'div[role="checkbox"]'
    ];

    const COMMON_INPUT_SELECTORS = [
        'textarea',
        '[contenteditable="true"]',
        '[role="textbox"]',
        '.ql-editor', '.w-e-text', '.ProseMirror', '.edui-body-container',
        'input[type="text"]', 'input:not([type])', 'input[type="search"]', 'input[type="number"]', 'input[type="tel"]'
    ];

    const UNIPUS_PSEUDO_BLANK_SELECTORS = [
        '[class*="cloze-blank"]', '[class*="blank-item"]', '[class*="blank-box"]',
        '[class*="drop-target"]', '[class*="droppable"]', '[data-blank]', '[data-index][class*="blank"]',
        '.ant-select-selector', '[class*="select-blank"]'
    ];

    // 专门用于判断当前 frame 是否真的含有题库元素（排除普通导航栏里的单个 input/label 误判）
    const STRICT_QUIZ_DETECTION_SELECTORS = [
        '.question-common-abs-reply', '.question-inputbox',
        '[class*="question"]', '[class*="exercise"]', '[class*="quiz"]',
        '.TiMu', '.singleQuesId', '.questionLi', '.answerList',
        '.ant-radio-wrapper', '.ant-checkbox-wrapper',
        '[class*="option-item"]', '[class*="optionItem"]', '[class*="choice-item"]',
        ...UNIPUS_PSEUDO_BLANK_SELECTORS,
        'textarea', '[contenteditable="true"]'
    ];

    /********************************************************************
     * 2. 跨框架安全通信与智能转发总线
     ********************************************************************/
    function trustedFrameOrigin(origin) {
        if (origin === location.origin) return true;
        try {
            const host = new URL(origin).hostname;
            const family = h => ['unipus.cn', 'chaoxing.com', 'edu.cn'].find(d => h === d || h.endsWith('.' + d));
            const localFamily = family(location.hostname);
            return Boolean(localFamily && localFamily !== 'edu.cn' && family(host) === localFamily);
        } catch (_) { return false; }
    }

    function isDescendantFrame(source, root = window, depth = 0) {
        if (depth > 6) return false;
        try {
            for (let i = 0; i < root.frames.length; i++) {
                const child = root.frames[i];
                if (child === source || isDescendantFrame(source, child, depth + 1)) return true;
            }
        } catch (_) {}
        return false;
    }

    // 判断当前鼠标是否正指在某个子 iframe 上，或者当前文档本身不含任何题目结构
    function shouldForwardToChildIframe() {
        const visibleIframes = Array.from(document.querySelectorAll('iframe')).filter(frame => {
            const r = frame.getBoundingClientRect();
            return r.width >= 120 && r.height >= 80 && r.bottom > 0 && r.top < innerHeight;
        });
        if (visibleIframes.length === 0) return false;

        // 1. 如果鼠标在当前文档的落点直接就是一个 <iframe>，说明用户正在指着子框架里的题目！
        const hitEl = document.elementFromPoint(STATE.rawMouse.x, STATE.rawMouse.y);
        if (hitEl && hitEl.tagName === 'IFRAME') {
            return true;
        }

        // 2. 检查当前文档是否有严格意义上的题目节点（或者 >=2 个可见输入框/选项）
        const hasStrictQuiz = Array.from(document.querySelectorAll(STRICT_QUIZ_DETECTION_SELECTORS.join(','))).some(el => {
            const r = el.getBoundingClientRect();
            return r.width >= 16 && r.height >= 12 && r.bottom > 0 && r.top < innerHeight;
        });
        if (hasStrictQuiz) return false;

        const visibleInputs = Array.from(document.querySelectorAll(COMMON_INPUT_SELECTORS.join(','))).filter(el => {
            const r = el.getBoundingClientRect();
            return r.width >= 16 && r.height >= 12 && r.bottom > 0 && r.top < innerHeight;
        });
        return visibleInputs.length < 2;
    }

    // 跨域 iframe 之间用“脚本私有密钥签名”互认：网页自身读不到 GM 存储，无法伪造指令。
    function busSecret() {
        let s = GM_getValue('DS_BUS_SECRET', '');
        if (!s) {
            const buf = new Uint32Array(4);
            crypto.getRandomValues(buf);
            s = Array.from(buf, n => n.toString(36)).join('');
            GM_setValue('DS_BUS_SECRET', s);
            s = GM_getValue('DS_BUS_SECRET', s);
        }
        return s;
    }

    function cyrb53(str) {
        let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
        for (let i = 0; i < str.length; i++) {
            const ch = str.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
    }

    function signBusMessage(payload) {
        const ts = Date.now();
        return Object.assign({}, payload, {
            __ds_source: 'DEEPSEEK_QUIZ_HELPER',
            __ds_ts: ts,
            __ds_sig: cyrb53(`${busSecret()}|${ts}|${payload.type}|${payload.cmd || ''}`)
        });
    }

    function isSignedBusMessage(data) {
        if (!data.__ds_sig || Math.abs(Date.now() - Number(data.__ds_ts)) > 10000) return false;
        return data.__ds_sig === cyrb53(`${busSecret()}|${data.__ds_ts}|${data.type}|${data.cmd || ''}`);
    }

    function postToTop(payload) {
        try { window.top.postMessage(signBusMessage(payload), '*'); } catch (_) {}
    }

    function broadcastToAllFrames(payload) {
        const msg = signBusMessage(payload);
        document.querySelectorAll('iframe').forEach(frame => {
            const r = frame.getBoundingClientRect();
            if (r.width < 120 || r.height < 80 || r.bottom <= 0 || r.top >= innerHeight) return;
            try { frame.contentWindow?.postMessage(msg, '*'); } catch (_) {}
        });
    }

    window.addEventListener('message', e => {
        const data = e.data;
        if (!data || data.__ds_source !== 'DEEPSEEK_QUIZ_HELPER') return;
        if (!trustedFrameOrigin(e.origin) && !isSignedBusMessage(data)) return;

        if (IS_TOP && data.type === 'TOGGLE_PANEL' && isDescendantFrame(e.source)) {
            toggleVisualUI(!CONFIG.panelVisible);
        }
        if (IS_TOP && data.type === 'UPDATE_BADGE' && isDescendantFrame(e.source)) {
            STATE.savedPassage = GM_getValue('DEEPSEEK_SAVED_PASSAGE', '');
            STATE.model = GM_getValue('DEEPSEEK_MODEL', STATE.model);
            // 当子框架发来解析状态或答案时，若未强制关闭视觉提示，自动唤起顶层面板以展示答案
            if (CONFIG.showVisualHint && !CONFIG.panelVisible) {
                CONFIG.panelVisible = true;
                if (badgeEl) badgeEl.style.display = 'block';
            }
            renderBadgeDOM(safeBadgeHTML(data.html), !!data.isASR);
        }
        if (!IS_TOP && data.type === 'REMOTE_CMD' && (e.source === window.parent || e.source === window.top)) {
            if (data.cmd === 'SYNC_VISUAL_HINT') {
                CONFIG.showVisualHint = !!data.visible;
                refreshTargetHighlights();
                broadcastToAllFrames(data);
                return;
            }
            if (data.cmd === 'LISTEN') {
                // 听力指令：哪个框架里有音频，就由哪个框架负责转写
                if (STATE.activeCapture || collectMediaSources(true).length > 0) executeCommandLocally('LISTEN');
                else broadcastToAllFrames(data);
                return;
            }
            if (!shouldForwardToChildIframe()) {
                executeCommandLocally(data.cmd);
            } else {
                broadcastToAllFrames(data);
            }
        }
    });

    function safeBadgeHTML(html) {
        const template = document.createElement('template');
        template.innerHTML = String(html || '').slice(0, 12000);
        const clean = document.createElement('div');
        function append(nodes, parent) {
            for (const node of nodes) {
                if (node.nodeType === 3) { parent.appendChild(document.createTextNode(node.textContent)); continue; }
                if (node.nodeType !== 1) continue;
                if (['B', 'I', 'BR', 'SPAN'].includes(node.tagName)) {
                    const el = document.createElement(node.tagName);
                    if (node.tagName === 'SPAN' && node.getAttribute('style') === 'color:#94a3b8') {
                        el.setAttribute('style', 'color:#94a3b8');
                    }
                    parent.appendChild(el);
                    append(node.childNodes, el);
                } else if (!['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT'].includes(node.tagName)) {
                    append(node.childNodes, parent);
                }
            }
        }
        append(template.content.childNodes, clean);
        return clean.innerHTML;
    }

    function executeCommandLocally(cmd) {
        if (cmd === 'ANALYZE') analyzeCurrentPageQuestion();
        else if (cmd === 'SAVE_PASSAGE') captureReadingPassageToMemory();
        else if (cmd === 'CLEAR_PASSAGE') clearSavedReadingPassage();
        else if (cmd === 'ANALYZE_PAGE') analyzeWholePage();
        else if (cmd === 'LISTEN') listenCommand();
        else if (cmd === 'TOGGLE_ASR') toggleListeningSpeechRecognition();
        else if (cmd === 'TOGGLE_PICKER') toggleScopePickerMode();
        else if (cmd === 'TOGGLE_AUTOTYPE') toggleAutoHumanTyping();
        else if (cmd === 'FILL_INSTANT') fillTargetInputInstantly();
        else if (cmd === 'CYCLE_ALT') cycleAlternativeAnswerFormat();
        else if (cmd === 'TOGGLE_MODEL') toggleModelMode();
        else if (cmd === 'TOGGLE_UI') {
            if (IS_TOP) {
                toggleVisualUI(!CONFIG.panelVisible);
            } else {
                postToTop({ type: 'TOGGLE_PANEL' });
            }
        }
    }

    // 支持将所有做题类指令（含解析、瞄准器、一键填充、切换备选、自动打字）智能转发给实际承载题目的子 iframe
    const FRAME_FORWARDABLE_CMDS = new Set([
        'ANALYZE', 'ANALYZE_PAGE', 'SAVE_PASSAGE', 'TOGGLE_PICKER', 'TOGGLE_AUTOTYPE', 'FILL_INSTANT', 'CYCLE_ALT'
    ]);

    function dispatchSmartCommand(cmd) {
        if (cmd === 'LISTEN') {
            const busyHere = STATE.activeCapture || STATE.isListeningASR;
            const hasFrames = document.querySelector('iframe');
            if (busyHere || !asrReady() || !hasFrames || collectMediaSources(true).length > 0) {
                executeCommandLocally('LISTEN');
                return;
            }
            const sentAt = Date.now();
            broadcastToAllFrames({ type: 'REMOTE_CMD', cmd: 'LISTEN' });
            setTimeout(() => {
                if (STATE.lastBadgeAt < sentAt) updateStatusBadge(NO_AUDIO_HINT);
            }, 2500);
            return;
        }
        if (FRAME_FORWARDABLE_CMDS.has(cmd) && shouldForwardToChildIframe()) {
            broadcastToAllFrames({ type: 'REMOTE_CMD', cmd });
            return;
        }
        executeCommandLocally(cmd);
    }

    /********************************************************************
     * 3. 油猴扩展菜单注册 (仅在顶层窗口注册，避免菜单重复)
     ********************************************************************/
    if (IS_TOP) {
        GM_registerMenuCommand('🔑 设置 DeepSeek API Key', () => {
            const key = prompt('请输入您的 DeepSeek API Key (sk-...):', STATE.apiKey);
            if (key !== null && key.trim()) {
                STATE.apiKey = key.trim();
                GM_setValue('DEEPSEEK_API_KEY', STATE.apiKey);
                updateStatusBadge(STATE.apiKey ? `✅ API Key 已保存 (${MOD_KEY_LABEL}+Q 或 ${MOD_KEY_LABEL}+左键点题)` : '⚠️ 未配置 API Key');
            }
        });

        GM_registerMenuCommand(`🎯 智能分析当前题目 (${MOD_KEY_LABEL}+Q / ${MOD_KEY_LABEL}+左键点击)`, () => {
            dispatchSmartCommand('ANALYZE');
        });

        GM_registerMenuCommand(`📚 跨页记忆当前阅读文章/词库 (${MOD_KEY_LABEL}+C)`, () => {
            dispatchSmartCommand('SAVE_PASSAGE');
        });

        GM_registerMenuCommand(`🗑️ 清空已记忆的跨页阅读文章 (${MOD_KEY_LABEL}+X)`, () => {
            dispatchSmartCommand('CLEAR_PASSAGE');
        });

        GM_registerMenuCommand(`👀 通读整页并作答所有题目 (${MOD_KEY_LABEL}+G)`, () => {
            dispatchSmartCommand('ANALYZE_PAGE');
        });

        GM_registerMenuCommand(`🎧 静默“听”网页音频并转写 (${MOD_KEY_LABEL}+L)`, () => {
            dispatchSmartCommand('LISTEN');
        });

        GM_registerMenuCommand('🛠️ 设置听力转写服务 (ASR 接口 / Key / 模型)', configureAsrService);

        GM_registerMenuCommand('🎙️ 备用：麦克风外放实时识别 开/关', () => {
            dispatchSmartCommand('TOGGLE_ASR');
        });

        GM_registerMenuCommand(`🔍 开启“指哪打哪”选题瞄准器 (${MOD_KEY_LABEL}+S)`, () => {
            dispatchSmartCommand('TOGGLE_PICKER');
        });

        GM_registerMenuCommand(`🤖 启动/暂停拟真自动打字机 (${MOD_KEY_LABEL}+A)`, () => {
            dispatchSmartCommand('TOGGLE_AUTOTYPE');
        });

        GM_registerMenuCommand(`🧠 切换模型: V3极速 / R1深度推理 (${MOD_KEY_LABEL}+M)`, () => {
            dispatchSmartCommand('TOGGLE_MODEL');
        });

        GM_registerMenuCommand(`👁️ 切换状态栏与高亮显示 (${MOD_KEY_LABEL}+H)`, () => {
            dispatchSmartCommand('TOGGLE_UI');
        });
    }

    function toggleModelMode() {
        STATE.model = STATE.model === 'deepseek-chat' ? 'deepseek-reasoner' : 'deepseek-chat';
        GM_setValue('DEEPSEEK_MODEL', STATE.model);
        const label = STATE.model === 'deepseek-reasoner'
            ? '🧠 已切换至 <b>R1 深度推理</b>：适合复杂选词填空、阅读与听力推理'
            : '⚡ 已切换至 <b>V3 极速模式</b>：适合常规题库秒回';
        updateStatusBadge(label);
    }

    /********************************************************************
     * 4. 样式注入、解除网页禁选限制与唯一顶层状态栏构建
     ********************************************************************/
    const styleEl = document.createElement('style');
    styleEl.textContent = `
        html, body, body * {
            -webkit-user-select: text !important;
            -moz-user-select: text !important;
            user-select: text !important;
            -webkit-touch-callout: default !important;
        }
        #ds-status-badge {
            position: fixed;
            bottom: 16px;
            right: 16px;
            z-index: 2147483646;
            background: rgba(15, 23, 42, 0.94);
            color: #f8fafc;
            font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", system-ui, sans-serif;
            font-size: 12px;
            line-height: 1.5;
            padding: 9px 13px;
            border-radius: 10px;
            border: 1px solid rgba(148, 163, 184, 0.28);
            box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
            user-select: none !important;
            max-width: 410px;
            max-height: 60vh;
            overflow-y: auto;
        }
        .ds-page-choice-hint {
            outline: 2px dashed rgba(16, 185, 129, 0.9) !important;
            outline-offset: 2px !important;
            background-color: rgba(16, 185, 129, 0.12) !important;
            border-radius: 4px !important;
        }
        .ds-correct-option-hint {
            outline: 2px dashed rgba(16, 185, 129, 0.9) !important;
            outline-offset: 2px !important;
            background-color: rgba(16, 185, 129, 0.12) !important;
            box-shadow: 0 0 8px rgba(16, 185, 129, 0.35) !important;
            border-radius: 4px !important;
        }
        .ds-secondary-option-hint {
            outline: 1.5px dotted rgba(56, 189, 248, 0.65) !important;
            outline-offset: 2px !important;
        }
        .ds-scope-picker-highlight {
            outline: 2px solid rgba(56, 189, 248, 0.9) !important;
            background-color: rgba(56, 189, 248, 0.06) !important;
            outline-offset: 3px !important;
            border-radius: 4px !important;
        }
        .ds-scope-locked-flash {
            outline: 2px dashed rgba(16, 185, 129, 0.85) !important;
            outline-offset: 3px !important;
            transition: outline 0.3s ease !important;
        }
    `;
    (document.head || document.documentElement).appendChild(styleEl);

    window.addEventListener('selectstart', (e) => e.stopPropagation(), true);
    window.addEventListener('copy', (e) => e.stopPropagation(), true);

    let badgeEl = null;
    if (IS_TOP) {
        badgeEl = document.createElement('div');
        badgeEl.id = 'ds-status-badge';
        badgeEl.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;gap:6px;">
                <span style="font-weight:600;color:#38bdf8;">🎯 DeepSeek 题库助手 Pro 3.6.0</span>
                <div style="display:flex;gap:4px;">
                    <span id="ds-mem-tag" style="font-size:10px;background:#065f46;padding:1px 5px;border-radius:4px;color:#a7f3d0;display:${STATE.savedPassage ? 'inline-block' : 'none'};">📚已存阅读(${STATE.savedPassage.length}字)</span>
                    <span id="ds-asr-tag" style="font-size:10px;background:#991b1b;padding:1px 5px;border-radius:4px;color:#fecaca;display:none;">🎙️听力收音中</span>
                    <span id="ds-model-tag" style="font-size:10px;background:#1e293b;padding:1px 6px;border-radius:4px;color:#94a3b8;">${STATE.model === 'deepseek-reasoner' ? 'R1推理' : 'V3极速'}</span>
                </div>
            </div>
            <div id="ds-status-text">指题 <b>${MOD_KEY_LABEL}+Q</b> | 整页 <b>${MOD_KEY_LABEL}+G</b> | 听力 <b>${MOD_KEY_LABEL}+L</b> | 存阅读 <b>${MOD_KEY_LABEL}+C</b></div>
        `;
        badgeEl.style.display = CONFIG.panelVisible ? 'block' : 'none';
        document.body.appendChild(badgeEl);
    }

    function renderBadgeDOM(msg, isASR = STATE.isListeningASR) {
        STATE.lastBadgeAt = Date.now();
        if (!badgeEl) return;
        const textNode = document.getElementById('ds-status-text');
        const modelTag = document.getElementById('ds-model-tag');
        const memTag = document.getElementById('ds-mem-tag');
        const asrTag = document.getElementById('ds-asr-tag');
        if (textNode) textNode.innerHTML = msg;
        if (modelTag) modelTag.textContent = STATE.model === 'deepseek-reasoner' ? 'R1推理' : 'V3极速';
        if (memTag) {
            memTag.style.display = STATE.savedPassage ? 'inline-block' : 'none';
            memTag.textContent = `📚已存阅读(${STATE.savedPassage.length}字)`;
        }
        if (asrTag) {
            asrTag.style.display = isASR ? 'inline-block' : 'none';
        }
    }

    function updateStatusBadge(msg) {
        if (IS_TOP) {
            // 当主动更新状态（如触发解析、切换版本）且未手动关闭提示时，自动显示状态栏
            if (CONFIG.showVisualHint && !CONFIG.panelVisible) {
                CONFIG.panelVisible = true;
                if (badgeEl) badgeEl.style.display = 'block';
            }
            renderBadgeDOM(msg, STATE.isListeningASR || !!STATE.activeCapture || STATE.isTranscribing);
        } else {
            postToTop({
                type: 'UPDATE_BADGE',
                html: msg,
                isASR: STATE.isListeningASR || !!STATE.activeCapture || STATE.isTranscribing
            });
        }
    }

    /********************************************************************
     * 6. 跨页面长阅读 / 词库记忆库 (Ctrl/Alt + C 存入，Ctrl/Alt + X 清空)
     ********************************************************************/
    function captureReadingPassageToMemory() {
        let text = window.getSelection()?.toString().trim() || '';

        if (!text) {
            const hitEl = document.elementFromPoint(STATE.rawMouse.x, STATE.rawMouse.y);
            const passageContainer = hitEl?.closest(
                'article, .passage, .reading-content, .article-content, .material, [class*="passage"], [class*="article"], [class*="reading"], [class*="word"], [class*="material"]'
            );
            if (passageContainer) {
                text = extractRichTextWithBlanks(passageContainer);
            } else {
                const blocks = querySelectorAllDeep('article, section, div, p').filter(el => {
                    const r = el.getBoundingClientRect();
                    return r.width > 180 && r.height > 50 && el.children.length < 35;
                });
                let longest = '';
                for (const b of blocks) {
                    const t = extractRichTextWithBlanks(b);
                    if (t.length > longest.length && t.length < 8000) {
                        longest = t;
                    }
                }
                text = longest;
            }
        }

        if (!text || text.length < 10) {
            if (document.querySelector('iframe')) { broadcastToAllFrames({ type: 'REMOTE_CMD', cmd: 'SAVE_PASSAGE' }); return; }
            updateStatusBadge('⚠️ 未能抓取到有效文章或词库，请先用鼠标选中文字再按快捷键');
            return;
        }

        STATE.savedPassage = GM_getValue('DEEPSEEK_SAVED_PASSAGE', '');
        if (STATE.savedPassage && !STATE.savedPassage.includes(text.slice(0, 40))) {
            STATE.savedPassage = (STATE.savedPassage + '\n\n' + text).slice(-6000);
        } else {
            STATE.savedPassage = text.slice(0, 6000);
        }

        GM_setValue('DEEPSEEK_SAVED_PASSAGE', STATE.savedPassage);
        updateStatusBadge(
            `📚 <b>已记忆背景材料/词库 (${STATE.savedPassage.length}字)</b>！做题按 <b>${MOD_KEY_LABEL}+Q</b> 将自动关联 (${MOD_KEY_LABEL}+X 清空)`
        );
    }

    function clearSavedReadingPassage() {
        STATE.savedPassage = '';
        STATE.listeningTranscript = '';
        GM_setValue('DEEPSEEK_SAVED_PASSAGE', '');
        GM_setValue('DEEPSEEK_ASR_STORE', '[]');
        updateStatusBadge('🗑️ 已清空跨页阅读记忆与听力缓存');
    }

    /********************************************************************
     * 7. 听力引擎：静默抓取网页音频 → 语音转写(ASR) → 跨框架共享转写稿
     *    A. 首选：直接下载音频文件（不播放、不出声、不消耗播放次数）
     *    B. 兜底：流媒体/MSE 无法下载时，把播放器声音改道进录音器（扬声器静音，需实时播完）
     *    C. 备用：麦克风 + 外放（浏览器 Web Speech，仅在未配置转写服务时使用）
     ********************************************************************/
    const AUDIO_EXT_RE = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|weba|amr)(\?|#|$)/i;
    const VIDEO_EXT_RE = /\.(mp4|webm|m4v|mov)(\?|#|$)/i;
    const TRACKED_MEDIA = new Set();          // 包含未挂到 DOM 上的 new Audio()
    const MEDIA_PLAYED_AT = new WeakMap();
    const MEDIA_AUDIO_GRAPH = new WeakMap();  // el -> { ctx, node }
    const NO_AUDIO_HINT = '⚠️ 没有在页面里找到音频。请先点一下网页上的播放按钮让音频加载（可立刻暂停），再按 <b>' + MOD_KEY_LABEL + '+L</b>';

    function isMediaElement(el) {
        return !!el && (el.tagName === 'AUDIO' || el.tagName === 'VIDEO');
    }

    function noteMediaElement(el) {
        if (!isMediaElement(el)) return;
        TRACKED_MEDIA.add(el);
        MEDIA_PLAYED_AT.set(el, Date.now());
    }

    // 媒体事件不冒泡，但捕获阶段能在 window 上收到
    window.addEventListener('play', e => noteMediaElement(e.target), true);

    // 很多站点用 new Audio(url).play() 而不把元素放进 DOM，这里挂钩 play() 才能发现它们
    try {
        const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        const proto = pageWin.HTMLMediaElement.prototype;
        const nativePlay = proto.play;
        if (!nativePlay.__dsHooked) {
            const hooked = function () {
                try { noteMediaElement(this); } catch (_) {}
                return nativePlay.apply(this, arguments);
            };
            const exported = typeof exportFunction === 'function' ? exportFunction(hooked, pageWin) : hooked;
            try { exported.__dsHooked = true; } catch (_) {}
            proto.play = exported;
        }
    } catch (_) {}

    function gmRequest(opts) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest(Object.assign({ timeout: 120000 }, opts, {
                onload: resolve,
                onerror: () => reject(new Error('网络请求失败')),
                ontimeout: () => reject(new Error('请求超时')),
                onabort: () => reject(new Error('请求被中断'))
            }));
        });
    }

    /* ---------- 转写服务配置 ---------- */
    function asrConfig() {
        return {
            url: GM_getValue('DEEPSEEK_ASR_URL', ASR_DEFAULTS.url),
            key: GM_getValue('DEEPSEEK_ASR_KEY', ''),
            model: GM_getValue('DEEPSEEK_ASR_MODEL', ASR_DEFAULTS.model)
        };
    }

    function asrReady() {
        return !!asrConfig().key;
    }

    function configureAsrService() {
        const cur = asrConfig();
        alert(
            'DeepSeek 的 API 只有文本模型，不能识别语音。\n' +
            '听力需要另配一个“OpenAI 兼容”的语音转写接口（/audio/transcriptions），例如：\n' +
            '· 硅基流动 SiliconFlow：模型 FunAudioLLM/SenseVoiceSmall\n' +
            '· Groq：https://api.groq.com/openai/v1/audio/transcriptions，模型 whisper-large-v3-turbo\n' +
            '· OpenAI：https://api.openai.com/v1/audio/transcriptions，模型 whisper-1\n\n' +
            '接下来依次填写：接口地址 → API Key → 模型名。音频会被上传到你填写的这个服务。'
        );
        const url = prompt('① 语音转写接口地址：', cur.url);
        if (url === null) return;
        const key = prompt('② 该转写服务的 API Key：', cur.key);
        if (key === null) return;
        const model = prompt('③ 转写模型名：', cur.model);
        if (model === null) return;
        GM_setValue('DEEPSEEK_ASR_URL', url.trim() || ASR_DEFAULTS.url);
        GM_setValue('DEEPSEEK_ASR_KEY', key.trim());
        GM_setValue('DEEPSEEK_ASR_MODEL', model.trim() || ASR_DEFAULTS.model);
        updateStatusBadge(key.trim()
            ? `✅ 听力转写服务已保存。按 <b>${MOD_KEY_LABEL}+L</b> 静默“听”音频，或直接 <b>${MOD_KEY_LABEL}+Q / G</b> 自动听+答`
            : '⚠️ 未填写转写 Key，听力将退回麦克风外放模式');
    }

    /* ---------- 转写稿共享存储（所有框架/标签页共用） ---------- */
    function readAsrStore() {
        try {
            const list = JSON.parse(GM_getValue('DEEPSEEK_ASR_STORE', '[]'));
            return Array.isArray(list) ? list : [];
        } catch (_) { return []; }
    }

    function writeAsrEntry(url, text) {
        const list = readAsrStore().filter(e => e.url !== url);
        list.push({ url, text: String(text).slice(0, 8000), at: Date.now() });
        GM_setValue('DEEPSEEK_ASR_STORE', JSON.stringify(list.slice(-8)));
    }

    function cachedTranscript(url) {
        const hit = readAsrStore().find(e => e.url === url);
        return hit ? hit.text : '';
    }

    /* ---------- 发现页面上的音频 ---------- */
    function collectMediaSources(includeVideo) {
        const found = new Map();
        const add = (rawUrl, el, isVideo) => {
            if (!rawUrl || /^(javascript|about):/i.test(rawUrl)) return;
            let url = rawUrl;
            try { url = new URL(rawUrl, location.href).href; } catch (_) {}
            if (isVideo && !includeVideo) return;
            const prev = found.get(url);
            if (prev) {
                if (el && !prev.el) prev.el = el;
                return;
            }
            found.set(url, { url, el: el || null, isVideo: !!isVideo });
        };

        const elements = new Set(querySelectorAllDeep('audio, video'));
        TRACKED_MEDIA.forEach(el => elements.add(el));
        elements.forEach(el => {
            const url = el.currentSrc || el.src || el.querySelector?.('source[src]')?.src || '';
            const isVideo = el.tagName === 'VIDEO' && !AUDIO_EXT_RE.test(url);
            add(url, el, isVideo);
        });

        try {
            performance.getEntriesByType('resource').forEach(entry => {
                if (AUDIO_EXT_RE.test(entry.name)) add(entry.name, null, false);
                else if (entry.initiatorType === 'audio') add(entry.name, null, false);
                else if (VIDEO_EXT_RE.test(entry.name) || entry.initiatorType === 'video') add(entry.name, null, true);
            });
        } catch (_) {}

        // 懒加载播放器常把地址放在 data-* 属性里
        try {
            querySelectorAllDeep('[data-src], [data-url], [data-audio], [data-audio-src], [data-mp3], a[href]').forEach(node => {
                for (const attr of ['data-src', 'data-url', 'data-audio', 'data-audio-src', 'data-mp3', 'href']) {
                    const v = node.getAttribute(attr);
                    if (v && AUDIO_EXT_RE.test(v)) add(v, null, false);
                }
            });
        } catch (_) {}

        return Array.from(found.values());
    }

    // 按“与当前题目的相关度”排序：题块附近的播放器 > 正在/刚刚播放的 > 其他
    function pickMediaSources(scopeEl, { includeVideo = false, limit = 3 } = {}) {
        const sources = collectMediaSources(includeVideo);
        if (sources.length <= 1) return sources;

        const near = [];
        if (scopeEl && scopeEl !== document.body) {
            let curr = scopeEl;
            for (let depth = 0; curr && curr !== document.body && depth < 5; depth++, curr = curr.parentElement) {
                const inside = sources.filter(s => s.el && curr.contains(s.el));
                if (inside.length > 0) {
                    if (inside.length <= 2) near.push(...inside);
                    break;
                }
            }
        }
        if (near.length > 0) return near;

        const playing = sources.filter(s => s.el && !s.el.paused && !s.el.ended);
        if (playing.length > 0) return playing.slice(0, 1);

        const played = sources
            .filter(s => s.el && MEDIA_PLAYED_AT.has(s.el))
            .sort((a, b) => MEDIA_PLAYED_AT.get(b.el) - MEDIA_PLAYED_AT.get(a.el));
        if (played.length > 0) return played.slice(0, 1);

        return sources.slice(0, limit);
    }

    /* ---------- A. 静默下载音频 ---------- */
    async function fetchMediaBlob(url) {
        if (/\.m3u8(\?|#|$)/i.test(url)) throw new Error('流媒体(m3u8)无法直接下载');
        let blob;
        if (/^(blob|data):/i.test(url)) {
            const res = await fetch(url);
            blob = await res.blob();
        } else {
            const res = await gmRequest({
                method: 'GET',
                url,
                responseType: 'blob',
                headers: { Referer: location.href },
                timeout: 90000
            });
            if (res.status < 200 || res.status >= 300) throw new Error(`音频下载失败 (HTTP ${res.status})`);
            blob = res.response;
        }
        if (!blob || blob.size < 2048) throw new Error('音频内容为空');
        if (/text\/|json|mpegurl/i.test(blob.type || '')) throw new Error('拿到的不是音频文件');
        if (blob.size > CONFIG.maxAudioBytes) throw new Error(`音频过大 (${(blob.size / 1048576).toFixed(0)}MB)`);
        return blob;
    }

    function mediaFileName(url, mime) {
        const m = /\.([a-z0-9]{2,5})(?:\?|#|$)/i.exec(String(url).split('?')[0]);
        let ext = m ? m[1].toLowerCase() : '';
        if (!/^(mp3|m4a|aac|wav|ogg|oga|opus|flac|weba|webm|mp4|amr)$/.test(ext)) {
            ext = /webm/.test(mime) ? 'webm' : /ogg/.test(mime) ? 'ogg' : /wav/.test(mime) ? 'wav'
                : /mp4|m4a|aac/.test(mime) ? 'm4a' : 'mp3';
        }
        return `listening.${ext}`;
    }

    async function transcribeBlob(blob, fileName) {
        const cfg = asrConfig();
        const form = new FormData();
        form.append('file', new File([blob], fileName, { type: blob.type || 'audio/mpeg' }));
        form.append('model', cfg.model);
        const res = await gmRequest({
            method: 'POST',
            url: cfg.url,
            headers: { Authorization: `Bearer ${cfg.key}` },
            data: form,
            timeout: 240000
        });
        if (res.status === 401 || res.status === 403) throw new Error('转写服务 Key 无效或无权限');
        if (res.status !== 200) throw new Error(`转写服务返回 HTTP ${res.status}`);
        let text = '';
        try {
            const data = JSON.parse(res.responseText);
            text = data.text || (Array.isArray(data.segments) ? data.segments.map(seg => seg.text).join(' ') : '');
        } catch (_) {
            text = res.responseText || '';
        }
        // SenseVoice 会输出 <|en|><|NEUTRAL|> 之类的标签
        return String(text).replace(/<\|[^|>]*\|>/g, ' ').replace(/\s+/g, ' ').trim();
    }

    /* ---------- B. 兜底：把播放器声音改道进录音器（扬声器无声） ---------- */
    async function captureElementAudio(el) {
        if (typeof MediaRecorder === 'undefined') throw new Error('当前浏览器不支持录制');
        const srcUrl = el.currentSrc || el.src || '';
        // 跨域且未开 CORS 的媒体一旦接入 WebAudio 会永久变成静音，这种情况绝不能走改道
        let safeForWebAudio = /^(blob|data):/i.test(srcUrl) || !!el.crossOrigin;
        if (!safeForWebAudio) {
            try { safeForWebAudio = new URL(srcUrl, location.href).origin === location.origin; } catch (_) {}
        }

        const AC = window.AudioContext || window.webkitAudioContext;
        let graph = MEDIA_AUDIO_GRAPH.get(el) || null;
        let stream = null;
        let silent = false;
        if (safeForWebAudio && AC) {
            try {
                if (!graph) {
                    const ctx = new AC();
                    graph = { ctx, node: ctx.createMediaElementSource(el) };
                    MEDIA_AUDIO_GRAPH.set(el, graph);
                }
                try { graph.node.disconnect(); } catch (_) {}
                const dest = graph.ctx.createMediaStreamDestination();
                graph.node.connect(dest);
                if (graph.ctx.state === 'suspended') await graph.ctx.resume().catch(() => {});
                stream = dest.stream;
                silent = true;
            } catch (_) {
                graph = MEDIA_AUDIO_GRAPH.get(el) || null;   // 网页自己已占用该元素的音频图
            }
        }

        const before = { muted: el.muted, volume: el.volume };
        const restore = () => {
            if (graph) {
                try { graph.node.disconnect(); } catch (_) {}
                try { graph.node.connect(graph.ctx.destination); } catch (_) {}
            }
            try { el.muted = before.muted; el.volume = before.volume; } catch (_) {}
        };

        try {
            if (silent) { el.muted = false; el.volume = 1; }
            try { el.currentTime = 0; } catch (_) {}
            await el.play();

            if (!stream) {
                const raw = el.captureStream ? el.captureStream() : (el.mozCaptureStream ? el.mozCaptureStream() : null);
                if (!raw) throw new Error('该音频受保护，无法静默抓取');
                for (let i = 0; i < 20 && raw.getAudioTracks().length === 0; i++) {
                    await new Promise(r => setTimeout(r, 100));
                }
                if (raw.getAudioTracks().length === 0) throw new Error('该音频受保护，无法静默抓取');
                stream = new MediaStream(raw.getAudioTracks());
            }
        } catch (err) {
            restore();
            throw err;
        }

        return await new Promise((resolve, reject) => {
            const recorder = new MediaRecorder(stream);
            const chunks = [];
            const startedAt = Date.now();
            let finished = false;

            const finish = () => {
                if (finished) return;
                finished = true;
                clearInterval(ticker);
                el.removeEventListener('ended', finish);
                el.removeEventListener('pause', finish);
                STATE.activeCapture = null;
                try { if (recorder.state !== 'inactive') recorder.stop(); } catch (_) {}
            };
            const ticker = setInterval(() => {
                const sec = Math.round((Date.now() - startedAt) / 1000);
                const total = Number.isFinite(el.duration) ? ` / ${Math.round(el.duration)}s` : '';
                updateStatusBadge(
                    `🎧 该音频是流媒体，正在${silent ? '<b>静音</b>' : ''}实时收听 ${sec}s${total}…` +
                    ` <span style="color:#94a3b8">(${MOD_KEY_LABEL}+L 提前结束并转写)</span>`
                );
                if (sec > 15 * 60) finish();
            }, 1000);

            recorder.ondataavailable = e => { if (e.data && e.data.size > 0) chunks.push(e.data); };
            recorder.onerror = () => { finish(); restore(); reject(new Error('录制失败')); };
            recorder.onstop = () => {
                restore();
                const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
                if (blob.size > 2000) resolve(blob);
                else reject(new Error('没有录到声音'));
            };
            el.addEventListener('ended', finish);
            el.addEventListener('pause', finish);
            STATE.activeCapture = { stop: () => { try { el.pause(); } catch (_) {} finish(); } };
            recorder.start(1000);
        });
    }

    async function transcribeSource(src, allowRealtime, tag = '') {
        let blob;
        let fileName;
        try {
            updateStatusBadge(`⬇️ 正在静默获取音频${tag}（不播放、不出声）…`);
            blob = await fetchMediaBlob(src.url);
            fileName = mediaFileName(src.url, blob.type);
        } catch (err) {
            if (!allowRealtime || !src.el) throw err;
            blob = await captureElementAudio(src.el);
            fileName = mediaFileName('capture.webm', blob.type);
        }
        updateStatusBadge(`🧠 正在转写听力${tag} (${(blob.size / 1048576).toFixed(1)}MB)…`);
        const text = await transcribeBlob(blob, fileName);
        if (!text) throw new Error('转写结果为空');
        writeAsrEntry(src.url, text);
        return text;
    }

    /* ---------- Ctrl/Alt + L：主动“听”一遍 ---------- */
    async function listenCommand() {
        if (STATE.activeCapture) { STATE.activeCapture.stop(); return; }
        if (STATE.isListeningASR) { toggleListeningSpeechRecognition(); return; }
        if (!asrReady()) {
            if (IS_TOP) toggleListeningSpeechRecognition(true);
            else updateStatusBadge('⚠️ 尚未配置听力转写服务：请在油猴菜单选择「🛠️ 设置听力转写服务」');
            return;
        }
        if (STATE.isTranscribing) {
            updateStatusBadge('⏳ 上一段音频还在转写中，请稍候…');
            return;
        }

        const hoverEl = document.elementFromPoint(STATE.rawMouse.x, STATE.rawMouse.y);
        const sources = pickMediaSources(hoverEl, { includeVideo: true, limit: 4 });
        if (sources.length === 0) {
            updateStatusBadge(NO_AUDIO_HINT);
            return;
        }

        STATE.isTranscribing = true;
        const texts = [];
        let lastError = null;
        try {
            for (let i = 0; i < sources.length; i++) {
                const tag = sources.length > 1 ? ` ${i + 1}/${sources.length}` : '';
                try {
                    texts.push(cachedTranscript(sources[i].url) || await transcribeSource(sources[i], true, tag));
                } catch (err) {
                    lastError = err;
                    console.warn('[DeepSeek Pro 3.6.0] 听力转写失败:', sources[i].url, err);
                }
            }
        } finally {
            STATE.isTranscribing = false;
        }

        if (texts.length === 0) {
            updateStatusBadge(`❌ 听力获取失败：${escapeHtml(lastError?.message || '未知错误')}`);
            return;
        }
        const total = texts.reduce((n, t) => n + t.length, 0);
        updateStatusBadge(
            `✅ 已“听”完 ${texts.length} 段音频 (${total} 字)：<i>"${escapeHtml(texts[0].slice(0, 60))}…"</i><br>` +
            `<span style="color:#94a3b8">指题按 <b>${MOD_KEY_LABEL}+Q</b>，或 <b>${MOD_KEY_LABEL}+G</b> 通读整页作答</span>`
        );
    }

    /* ---------- C. 备用：麦克风外放实时识别 ---------- */
    function toggleListeningSpeechRecognition(asFallback = false) {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        const fallbackNote = asFallback === true
            ? '尚未配置转写服务（油猴菜单「🛠️ 设置听力转写服务」可实现静默听力），暂用麦克风模式。<br>'
            : '';
        if (!SpeechRecognition) {
            updateStatusBadge(fallbackNote + '⚠️ 当前浏览器不支持原生语音识别，请在油猴菜单配置听力转写服务');
            return;
        }

        if (STATE.isListeningASR && STATE.asrInstance) {
            STATE.isListeningASR = false;
            STATE.asrInstance.stop();
            updateStatusBadge(`🛑 听力收音已停止 (已记录 ${STATE.listeningTranscript.length} 字符，按 ${MOD_KEY_LABEL}+Q 结合题目解析)`);
            return;
        }

        const recognition = new SpeechRecognition();
        recognition.lang = 'en-US';
        recognition.continuous = true;
        recognition.interimResults = true;

        recognition.onstart = () => {
            STATE.isListeningASR = true;
            updateStatusBadge(fallbackNote + '🎙️ <b>正在用麦克风收听...</b> (请外放音频，随时按 <b>' + MOD_KEY_LABEL + '+Q</b> 解题)');
        };

        recognition.onresult = (event) => {
            let finalChunk = '';
            let interimChunk = '';
            for (let i = event.resultIndex; i < event.results.length; i++) {
                const tr = event.results[i][0].transcript;
                if (event.results[i].isFinal) {
                    finalChunk += tr + '. ';
                } else {
                    interimChunk += tr;
                }
            }
            if (finalChunk) {
                STATE.listeningTranscript = (STATE.listeningTranscript + ' ' + finalChunk).slice(-4000).trim();
                // 修复：写入共享存储，子 iframe 里的题目也能用到顶层页面听到的内容
                writeAsrEntry('mic://live', STATE.listeningTranscript);
            }
            const preview = (STATE.listeningTranscript + ' ' + interimChunk).slice(-42);
            updateStatusBadge(`🎙️ 实时听写中：<i>"...${escapeHtml(preview)}"</i> (指题按 <b>${MOD_KEY_LABEL}+Q</b> 秒解)`);
        };

        recognition.onerror = (e) => {
            if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'network') {
                STATE.isListeningASR = false;
                updateStatusBadge(fallbackNote + '⚠️ 麦克风识别不可用（权限被拒或识别服务连不上）。请在油猴菜单选择「🛠️ 设置听力转写服务」');
            }
        };

        recognition.onend = () => {
            if (STATE.isListeningASR) {
                try { recognition.start(); } catch (_) {}
            }
        };

        STATE.asrInstance = recognition;
        try {
            recognition.start();
        } catch (err) {
            console.error(err);
        }
    }

    /* ---------- 汇总“听到的内容”，供解题提示词使用 ---------- */
    function extractHiddenTranscriptText() {
        const clues = [];
        // 修复：原先的 [class*="script"] 会把 class 含 "description" 的普通元素也当成听力原文
        const clueRe = /transcript|listening-?text|lyric|audio-?text|(^|[\s_-])scripts?([\s_-]|$)/i;
        querySelectorAllDeep('[class*="script"], [class*="lyric"], [class*="listening-text"], [class*="audio-text"]').forEach(el => {
            if (el.tagName === 'SCRIPT' || el.tagName === 'NOSCRIPT') return;
            if (!clueRe.test(String(el.className?.baseVal ?? el.className ?? ''))) return;
            const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (t.length > 20 && t.length < 3000 && !clues.includes(t)) clues.push(t);
        });
        return clues.slice(0, 3).join('\n');
    }

    async function gatherListeningContext(scopeEl, limit = 3) {
        const parts = [];
        const hidden = extractHiddenTranscriptText();
        if (hidden) parts.push(`【页面内隐藏的听力文本】：${hidden}`);

        const heard = [];
        if (asrReady() && CONFIG.autoListen) {
            const sources = pickMediaSources(scopeEl, { includeVideo: false, limit });
            for (let i = 0; i < sources.length && i < limit; i++) {
                let text = cachedTranscript(sources[i].url);
                if (!text && !STATE.isTranscribing) {
                    STATE.isTranscribing = true;
                    try {
                        // 自动模式只走静默下载，不会擅自替用户播放音频
                        text = await transcribeSource(sources[i], false, sources.length > 1 ? ` ${i + 1}/${sources.length}` : '');
                    } catch (err) {
                        console.warn('[DeepSeek Pro 3.6.0] 自动听力转写失败:', sources[i].url, err);
                    } finally {
                        STATE.isTranscribing = false;
                    }
                }
                if (text) heard.push(text);
            }
        }

        // 本框架没有对应音频时（播放器在别的 iframe 里），取最近 20 分钟内其他框架听到的内容
        if (heard.length === 0) {
            readAsrStore()
                .filter(e => Date.now() - e.at < 20 * 60 * 1000)
                .slice(-2)
                .forEach(e => heard.push(e.text));
        }

        heard.forEach((text, idx) => {
            parts.push(`【听力音频转写原文${heard.length > 1 ? ' #' + (idx + 1) : ''}（机器转写，可能有个别错词）】：${text}`);
        });
        return parts.join('\n');
    }

    /********************************************************************
     * 8. 富文本与空格原位占位标记提取器 (兼容 U校园 真实输入框与拖拽伪空格)
     ********************************************************************/
    function extractRichTextWithBlanks(node, targetBlankEl = null) {
        if (!node) return '';

        const combinedBlankSelector = [...COMMON_INPUT_SELECTORS, ...UNIPUS_PSEUDO_BLANK_SELECTORS].join(',');
        const liveInputs = Array.from(node.querySelectorAll ? node.querySelectorAll(combinedBlankSelector) : []);
        const cleanupList = [];

        liveInputs.forEach((inp, idx) => {
            if (inp.type === 'hidden' || inp.type === 'radio' || inp.type === 'checkbox' || inp.type === 'button' || inp.type === 'submit') {
                return;
            }
            const curVal = (inp.tagName === 'INPUT' || inp.tagName === 'TEXTAREA'
                ? inp.value
                : inp.innerText || '').trim();
            let marker = '';
            if (targetBlankEl && (inp === targetBlankEl || inp.contains(targetBlankEl) || targetBlankEl.contains(inp))) {
                marker = curVal
                    ? ` [[👉当前目标空格_${idx}(当前框内文字:"${curVal}")👈]] `
                    : ` [[👉当前需要作答的目标空格_${idx}👈]] `;
            } else {
                marker = curVal
                    ? ` [[空格_${idx}(已填:"${curVal}")]] `
                    : ` [[空格_${idx}(待填)]] `;
            }
            inp.setAttribute('data-ds-blank-marker', marker);
            cleanupList.push(inp);
        });

        if (liveInputs.length === 0 && isEditableElement(node)) {
            const curVal = (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' ? node.value : node.innerText || '').trim();
            return curVal ? `[[👉当前目标空格(已填:"${curVal}")👈]]` : `[[👉当前需要作答的目标空格👈]]`;
        }

        const clone = node.cloneNode(true);
        cleanupList.forEach(inp => inp.removeAttribute('data-ds-blank-marker'));

        // 过滤干扰图标与隐藏样式
        clone.querySelectorAll('style, script, .ans-icon, .font-cxsecret-ignore').forEach(el => el.remove());

        clone.querySelectorAll('[data-ds-blank-marker]').forEach(el => {
            const markerText = el.getAttribute('data-ds-blank-marker') || ' [[空格]] ';
            el.replaceWith(markerText);
        });

        clone.querySelectorAll('annotation[encoding="application/x-tex"]').forEach(ann => {
            ann.replaceWith(` $${ann.textContent.trim()}$ `);
        });
        clone.querySelectorAll('.katex-html, .MathJax_Preview').forEach(el => el.remove());

        clone.querySelectorAll('script[type^="math/tex"], [data-latex], [data-math], [data-tex]').forEach(el => {
            const tex = el.getAttribute('data-latex') || el.getAttribute('data-math') || el.getAttribute('data-tex') || el.textContent;
            if (tex) el.replaceWith(` $${tex.trim()}$ `);
        });

        clone.querySelectorAll('img').forEach(img => {
            const alt = img.getAttribute('alt') || img.getAttribute('title') || img.getAttribute('data-latex') || '';
            if (alt && alt.trim().length > 0) {
                img.replaceWith(` [图片:${alt.trim()}] `);
            }
        });

        return (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function extractScrollContainerFullContext(scopeRoot, primaryInputEl) {
        let curr = scopeRoot || primaryInputEl;
        let scrollContainer = null;

        while (curr && curr !== document.body) {
            const style = window.getComputedStyle(curr);
            const isScrollable = /(auto|scroll)/i.test(style.overflowY + style.overflow) || curr.scrollHeight > curr.clientHeight + 40;
            const textLen = (curr.innerText || '').length;
            if (isScrollable && textLen >= 80 && textLen <= 8500) {
                scrollContainer = curr;
                break;
            }
            if (textLen >= 200 && textLen <= 5500) {
                scrollContainer = curr;
            }
            curr = curr.parentElement;
        }

        if (!scrollContainer) {
            scrollContainer = document.querySelector('.ant-tabs-tabpane-active, .el-tab-pane, main, article, .padBom50, .TiMu') || document.body;
        }

        return extractRichTextWithBlanks(scrollContainer, primaryInputEl).slice(0, 3800);
    }

    function extractSectionHeaderAndDirections(scopeRoot) {
        const headers = [];
        let curr = scopeRoot;
        while (curr && curr !== document.body) {
            let prev = curr.previousElementSibling;
            let steps = 0;
            while (prev && steps < 8) {
                const txt = extractRichTextWithBlanks(prev);
                if (txt.length >= 2 && txt.length <= 500 &&
                    /翻译|译成|译文|Translate|Translation|阅读|Reading|听力|Listening|选词填空|完形|Cloze|简答|写作|Writing|Part|Section|Directions|words in the box|bank|单选题|多选题|判断题|填空题/i.test(txt)) {
                    headers.unshift(txt);
                }
                prev = prev.previousElementSibling;
                steps++;
            }
            curr = curr.parentElement;
        }

        document.querySelectorAll('h1, h2, h3, h4, [class*="section-title"], [class*="part-title"], [class*="directions"], [class*="word-box"], [class*="word-bank"], [class*="word-list"], .font14').forEach(el => {
            const t = extractRichTextWithBlanks(el);
            if (t.length >= 2 && t.length <= 600 && !headers.includes(t)) {
                headers.push(t);
            }
        });

        return headers.slice(0, 5).join(' | ');
    }

    function findSamePageReadingPassage(scopeRoot) {
        const candidates = querySelectorAllDeep(
            'article, .passage, .reading-passage, .article-body, [class*="passage"], [class*="reading"], [class*="material"], [class*="word-box"], [class*="word-bank"], [class*="word-list"]'
        );
        const snippets = [];
        for (const el of candidates) {
            if (scopeRoot && scopeRoot.contains(el)) continue;
            const t = extractRichTextWithBlanks(el);
            if (t.length >= 20 && t.length <= 6500 && !snippets.includes(t)) {
                snippets.push(t);
            }
        }
        return snippets.slice(0, 2).join('\n\n');
    }

    /********************************************************************
     * 9. 精准定位鼠标指向的题目/空格
     ********************************************************************/
    function clearTargetHighlights() {
        querySelectorAllDeep('.ds-correct-option-hint, .ds-secondary-option-hint, .ds-page-choice-hint').forEach(el => {
            el.classList.remove('ds-correct-option-hint', 'ds-secondary-option-hint', 'ds-page-choice-hint');
        });
    }

    function refreshTargetHighlights() {
        clearTargetHighlights();
        if (!CONFIG.showVisualHint) return;
        STATE.pageChoiceEls.forEach(el => el.classList.add('ds-page-choice-hint'));
        STATE.targetQueue.forEach((item, idx) => {
            if (!item.el || item.completed) return;
            if (idx === STATE.currentQueueIdx) {
                item.el.classList.add('ds-correct-option-hint');
                try { item.el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (_) {}
            } else {
                item.el.classList.add('ds-secondary-option-hint');
            }
        });
    }

    function flashLockedQuestionScope(scopeEl) {
        if (!CONFIG.showVisualHint || !scopeEl || scopeEl === document.body) return;
        scopeEl.classList.add('ds-scope-locked-flash');
        setTimeout(() => {
            scopeEl.classList.remove('ds-scope-locked-flash');
        }, 850);
    }

    function toggleVisualUI(visible) {
        CONFIG.panelVisible = visible;
        CONFIG.showVisualHint = visible;
        if (badgeEl) badgeEl.style.display = visible ? 'block' : 'none';
        refreshTargetHighlights();
        broadcastToAllFrames({ type: 'REMOTE_CMD', cmd: 'SYNC_VISUAL_HINT', visible });
    }

    function getCurrentTargetItem() {
        return STATE.targetQueue[STATE.currentQueueIdx] || null;
    }

    function findNearestInputToMouse(inputsList) {
        if (!inputsList || inputsList.length === 0) return null;

        const activeEl = document.activeElement;
        const focusedItem = inputsList.find(item => item.el === activeEl || item.el.contains(activeEl));
        if (focusedItem) {
            const r = focusedItem.el.getBoundingClientRect();
            const distToMouse = Math.hypot(
                (r.left + r.width / 2) - STATE.rawMouse.x,
                (r.top + r.height / 2) - STATE.rawMouse.y
            );
            if (distToMouse < 240) return focusedItem;
        }

        let closest = inputsList[0];
        let minDist = Infinity;
        for (const item of inputsList) {
            const r = item.el.getBoundingClientRect();
            const dx = Math.max(r.left - STATE.rawMouse.x, 0, STATE.rawMouse.x - r.right);
            const dy = Math.max(r.top - STATE.rawMouse.y, 0, STATE.rawMouse.y - r.bottom);
            const dist = Math.hypot(dx, dy);
            if (dist < minDist) {
                minDist = dist;
                closest = item;
            }
        }
        return closest;
    }

    function scoreQuestionContainer(node) {
        if (!node || node === document.body || node === document.documentElement) return { valid: false };
        const rect = node.getBoundingClientRect();
        if (rect.width < 80 || rect.height < 16) return { valid: false };
        if (rect.height > window.innerHeight * 0.92 && node.children.length > 4) return { valid: false };

        const options = extractOptionsInsideScope(node, true);
        const inputs = extractInputsInsideScope(node, false);
        const fullText = extractRichTextWithBlanks(node);

        const hasInteractiveItems = options.length >= 2 || inputs.length >= 1;
        const hasStemOrPureListening = fullText.length >= 4 || options.length >= 2;

        return {
            valid: hasInteractiveItems && hasStemOrPureListening,
            optionsCount: options.length,
            inputsCount: inputs.length,
            area: rect.width * rect.height
        };
    }

    function findSmartScopeFromMousePoint(x, y) {
        const hitEl = document.elementFromPoint(x, y);
        if (!hitEl || hitEl === document.body || hitEl === document.documentElement) {
            return null;
        }

        // U校园的简答题题干与 textarea 同处此题块，避免只选中不含题干的输入框容器。
        const unipusReply = hitEl.closest('.question-common-abs-reply, .question-inputbox');
        if (unipusReply && unipusReply.querySelector('textarea, input, [contenteditable="true"]')) {
            return unipusReply;
        }

        // 如果鼠标直接指在某个深层 iframe 标签上，尝试进入该同源 iframe 查找
        if (hitEl.tagName === 'IFRAME') {
            try {
                if (hitEl.contentDocument?.body) {
                    return hitEl.contentDocument.body;
                }
            } catch (_) {}
        }

        let curr = hitEl;
        let depth = 0;
        let fallbackCandidate = null;

        while (curr && curr !== document.body && depth < 14) {
            const evalRes = scoreQuestionContainer(curr);
            if (evalRes.valid) {
                if (evalRes.optionsCount === 0 && evalRes.inputsCount === 1) {
                    return curr;
                }
                if (evalRes.optionsCount >= 2 && evalRes.optionsCount <= 8 && evalRes.inputsCount <= 2) {
                    return curr;
                }
                if (!fallbackCandidate) fallbackCandidate = curr;
            }
            curr = curr.parentElement;
            depth++;
        }

        if (fallbackCandidate) return fallbackCandidate;

        const candidates = querySelectorAllDeep(COMMON_CONTAINER_SELECTORS.join(',')).filter(el => {
            const r = el.getBoundingClientRect();
            return r.width > 120 && r.height >= 16 && r.height < window.innerHeight * 0.88 &&
                   r.bottom > 0 && r.top < window.innerHeight;
        });

        let bestNode = null;
        let minScore = Infinity;

        for (const c of candidates) {
            const evalRes = scoreQuestionContainer(c);
            if (!evalRes.valid || evalRes.optionsCount > 10) continue;
            const r = c.getBoundingClientRect();
            const dx = Math.max(r.left - x, 0, x - r.right);
            const dy = Math.max(r.top - y, 0, y - r.bottom);
            const dist = Math.hypot(dx, dy);
            const singleInputBonus = evalRes.inputsCount === 1 ? 0 : 180;
            const score = dist * 1000 + Math.sqrt(evalRes.area) + singleInputBonus;
            if (score < minScore) {
                minScore = score;
                bestNode = c;
            }
        }

        return bestNode;
    }

    function toggleScopePickerMode(forceState) {
        STATE.pickerMode = typeof forceState === 'boolean' ? forceState : !STATE.pickerMode;
        if (!STATE.pickerMode) {
            if (STATE.hoveredScopeEl) {
                STATE.hoveredScopeEl.classList.remove('ds-scope-picker-highlight');
                STATE.hoveredScopeEl = null;
            }
            updateStatusBadge(`🎯 已退出选题瞄准器 | 悬停按 <b>${MOD_KEY_LABEL}+Q</b> 快速解析`);
        } else {
            updatePickerHighlightAt(STATE.rawMouse.x, STATE.rawMouse.y);
            updateStatusBadge(
                `🔍 <b>选题瞄准器已开启</b>：移至题目上，<b>滚轮上下</b>缩放范围，<b>左键点击</b>锁定解析 (Esc 退出)`
            );
        }
    }

    function updatePickerHighlightAt(x, y) {
        if (!STATE.pickerMode) return;
        const smartScope = findSmartScopeFromMousePoint(x, y) || document.elementFromPoint(x, y);
        if (smartScope && smartScope !== STATE.hoveredScopeEl && smartScope !== badgeEl && (!badgeEl || !badgeEl.contains(smartScope))) {
            if (STATE.hoveredScopeEl) {
                STATE.hoveredScopeEl.classList.remove('ds-scope-picker-highlight');
            }
            STATE.hoveredScopeEl = smartScope;
            STATE.hoveredScopeEl.classList.add('ds-scope-picker-highlight');
        }
    }

    window.addEventListener('wheel', (e) => {
        if (!STATE.pickerMode || !STATE.hoveredScopeEl) return;
        e.preventDefault();
        e.stopPropagation();

        let nextScope = STATE.hoveredScopeEl;
        if (e.deltaY < 0) {
            if (nextScope.parentElement && nextScope.parentElement !== document.body) {
                nextScope = nextScope.parentElement;
            }
        } else if (e.deltaY > 0) {
            const childCandidates = Array.from(nextScope.children);
            const hitChild = childCandidates.find(ch => {
                const r = ch.getBoundingClientRect();
                return STATE.rawMouse.x >= r.left && STATE.rawMouse.x <= r.right &&
                       STATE.rawMouse.y >= r.top && STATE.rawMouse.y <= r.bottom;
            });
            if (hitChild) nextScope = hitChild;
        }

        if (nextScope !== STATE.hoveredScopeEl) {
            STATE.hoveredScopeEl.classList.remove('ds-scope-picker-highlight');
            STATE.hoveredScopeEl = nextScope;
            STATE.hoveredScopeEl.classList.add('ds-scope-picker-highlight');
            const previewTxt = extractRichTextWithBlanks(nextScope).slice(0, 26);
            updateStatusBadge(`🔍 当前框定：<b>${escapeHtml(previewTxt)}...</b> (点击确认解析 | 滚轮缩放)`);
        }
    }, { passive: false, capture: true });

    /********************************************************************
     * 10. 输入框赋值器、拟真自动打字机与多版本切换
     ********************************************************************/
    function isEditableElement(el) {
        if (!el) return false;
        const tag = el.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable ||
               el.getAttribute?.('role') === 'textbox' || el.classList?.contains('edui-body-container');
    }

    function setNativeInputValue(el, newText) {
        if (!el) return;
        const lastChar = newText.slice(-1) || '';

        el.dispatchEvent(new KeyboardEvent('keydown', { key: lastChar, bubbles: true }));
        el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: lastChar, bubbles: true }));

        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            const proto = el.tagName === 'TEXTAREA'
                ? window.HTMLTextAreaElement.prototype
                : window.HTMLInputElement.prototype;
            const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (nativeSetter) {
                nativeSetter.call(el, newText);
            } else {
                el.value = newText;
            }
        } else if (el.isContentEditable || el.classList?.contains('edui-body-container')) {
            el.innerText = newText;
        }

        el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: lastChar, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: lastChar, bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function isQueueTargetElement(activeEl, item) {
        if (!activeEl || !item?.el) return false;
        return item.el === activeEl || item.el.contains(activeEl) || activeEl.contains(item.el);
    }

    function stopAutoHumanTyping() {
        if (STATE.autoTypingTimer) {
            clearTimeout(STATE.autoTypingTimer);
            STATE.autoTypingTimer = null;
        }
    }

    function toggleAutoHumanTyping() {
        if (STATE.autoTypingTimer) {
            stopAutoHumanTyping();
            updateStatusBadge('⏸️ <b>拟真自动打字已暂停</b> (再按快捷键继续，或敲任意键手动盲打)');
            return;
        }

        const curItem = getCurrentTargetItem();
        if (!curItem || STATE.questionType === 'choice') return;

        const inputEl = curItem.el || document.activeElement;
        if (!isEditableElement(inputEl)) {
            updateStatusBadge('⚠️ 请先点击输入框，再启动拟真自动打字');
            return;
        }

        inputEl.focus();

        function typeNextChunk() {
            if (STATE.typingUnlocked || !curItem) {
                stopAutoHumanTyping();
                return;
            }
            if (STATE.typingCursorIndex >= curItem.text.length) {
                stopAutoHumanTyping();
                curItem.completed = true;
                advanceQueueIfNeeded();
                return;
            }

            const chunkLen = curItem.text.length > 35 ? Math.floor(Math.random() * 2) + 1 : 1;
            STATE.typingCursorIndex = Math.min(curItem.text.length, STATE.typingCursorIndex + chunkLen);
            const nextSlice = curItem.text.slice(0, STATE.typingCursorIndex);
            setNativeInputValue(inputEl, nextSlice);

            const progress = `${STATE.typingCursorIndex}/${curItem.text.length}`;
            updateStatusBadge(
                `🤖 拟真打字中 (${progress})：<b>${escapeHtml(nextSlice.slice(-22))}</b> <span style="color:#94a3b8">(${MOD_KEY_LABEL}+A 暂停)</span>`
            );

            const lastCh = nextSlice.slice(-1);
            const isPunct = /[，。；！？、,.;!?\n]/.test(lastCh);
            const delay = isPunct
                ? 170 + Math.floor(Math.random() * 130)
                : 50 + Math.floor(Math.random() * 55);

            STATE.autoTypingTimer = setTimeout(typeNextChunk, delay);
        }

        typeNextChunk();
    }

    window.addEventListener('focusin', (e) => {
        if (STATE.questionType !== 'choice' && STATE.targetQueue.length > 0) {
            const matchedIdx = STATE.targetQueue.findIndex(item => item.el === e.target || item.el?.contains(e.target));
            if (matchedIdx !== -1 && matchedIdx !== STATE.currentQueueIdx) {
                stopAutoHumanTyping();
                STATE.currentQueueIdx = matchedIdx;
                STATE.typingCursorIndex = 0;
                STATE.altFormatIdx = 0;
                refreshTargetHighlights();
                renderQueueStatus();
            }
        }
    });

    function fillTargetInputInstantly() {
        stopAutoHumanTyping();
        const curItem = getCurrentTargetItem();
        if (!curItem) return;

        const inputEl = (STATE.questionType !== 'choice' && curItem.el)
            ? curItem.el
            : document.activeElement;

        if (isEditableElement(inputEl)) {
            inputEl.focus();
            setNativeInputValue(inputEl, curItem.text);
            STATE.typingCursorIndex = curItem.text.length;
            curItem.completed = true;
            advanceQueueIfNeeded();
        }
    }

    function cycleAlternativeAnswerFormat() {
        stopAutoHumanTyping();
        const curItem = getCurrentTargetItem();
        if (!curItem || !curItem.altFormats || curItem.altFormats.length <= 1) {
            updateStatusBadge('ℹ️ 当前题目无其他备选版本');
            return;
        }
        STATE.altFormatIdx = (STATE.altFormatIdx + 1) % curItem.altFormats.length;
        curItem.text = curItem.altFormats[STATE.altFormatIdx];
        STATE.typingCursorIndex = 0;

        const styleLabels = STATE.questionType === 'translate'
            ? ['四六级标准高分译文', '地道自然英文表达', '基础词汇稳妥译文']
            : STATE.questionType === 'essay'
                ? ['标准得分点版', '自然口语防查重版', '详细展开论述版']
                : ['首选词形', '备选词形2', '备选词形3'];
        const versionTag = styleLabels[STATE.altFormatIdx] || `版本${STATE.altFormatIdx + 1}`;

        const activeEl = document.activeElement;
        const curBoxText = activeEl
            ? (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' ? activeEl.value : activeEl.innerText)
            : '';
        if (isEditableElement(activeEl) && curBoxText && curBoxText.length > 0) {
            setNativeInputValue(activeEl, curItem.text);
            STATE.typingCursorIndex = curItem.text.length;
        }

        updateStatusBadge(
            `🔄 已切至【<b>${versionTag}</b>】：<b>${escapeHtml(curItem.text.slice(0, 32))}</b>`
        );
    }

    function advanceQueueIfNeeded() {
        const nextIdx = STATE.targetQueue.findIndex((item, idx) => idx > STATE.currentQueueIdx && !item.completed);
        if (nextIdx !== -1) {
            STATE.currentQueueIdx = nextIdx;
            STATE.typingCursorIndex = 0;
            STATE.altFormatIdx = 0;
            refreshTargetHighlights();
            renderQueueStatus();
        } else {
            refreshTargetHighlights();
            const cur = getCurrentTargetItem();
            updateStatusBadge(`✅ 已完成作答：<b>${escapeHtml(cur ? cur.text.slice(0, 32) : '')}</b>`);
        }
    }

    /********************************************************************
     * 11. 全局快捷键、按住 Ctrl/Option+左键直接点题 与盲打推进
     ********************************************************************/
    window.addEventListener('mousemove', (e) => {
        STATE.rawMouse.x = e.clientX;
        STATE.rawMouse.y = e.clientY;
        STATE.lastMouseMoveAt = Date.now();

        if (STATE.pickerMode) {
            updatePickerHighlightAt(e.clientX, e.clientY);
        }
    }, { passive: true });

    function stepStealthChar(activeEl, curItem) {
        stopAutoHumanTyping();
        const isLongText = STATE.questionType === 'essay' || STATE.questionType === 'translate' || curItem.text.length > 28;
        const stepSize = isLongText ? Math.min(4, Math.max(2, Math.ceil(curItem.text.length / 40))) : 1;

        if (STATE.typingCursorIndex < curItem.text.length) {
            STATE.typingCursorIndex = Math.min(curItem.text.length, STATE.typingCursorIndex + stepSize);
        }
        const nextSlice = curItem.text.slice(0, STATE.typingCursorIndex);
        setNativeInputValue(activeEl, nextSlice);

        if (STATE.typingCursorIndex >= curItem.text.length) {
            curItem.completed = true;
            advanceQueueIfNeeded();
        } else {
            const progress = `${STATE.typingCursorIndex}/${curItem.text.length}`;
            updateStatusBadge(
                `⌨️ 伪装输入 (${progress})：<b>${escapeHtml(nextSlice.slice(-22))}</b> <span style="color:#94a3b8">(${MOD_KEY_LABEL}+A 自动打字 | Esc 解锁)</span>`
            );
        }
    }

    window.addEventListener('compositionend', (e) => {
        if (!e.isTrusted) return;
        const activeEl = document.activeElement;
        const curItem = getCurrentTargetItem();
        if (
            activeEl &&
            curItem &&
            STATE.questionType !== 'choice' &&
            !STATE.typingUnlocked &&
            CONFIG.enableStealthTyping &&
            isQueueTargetElement(activeEl, curItem)
        ) {
            stepStealthChar(activeEl, curItem);
        }
    }, true);

    window.addEventListener('keydown', (e) => {
        if (!e.isTrusted) return;   // 修复：忽略脚本自己派发的合成按键，否则会无限递归
        const activeEl = document.activeElement;
        const isInputFocused = isEditableElement(activeEl);
        const isShortcutMod = e.altKey || (IS_MAC && e.ctrlKey && !e.metaKey);

        if (STATE.pickerMode && e.code === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            toggleScopePickerMode(false);
            return;
        }

        if (isShortcutMod && e.code === 'KeyQ') {
            e.preventDefault();
            e.stopPropagation();
            dispatchSmartCommand('ANALYZE');
            return;
        }
        if (isShortcutMod && e.code === 'KeyC') {
            e.preventDefault();
            e.stopPropagation();
            dispatchSmartCommand('SAVE_PASSAGE');
            return;
        }
        if (isShortcutMod && e.code === 'KeyX') {
            e.preventDefault();
            e.stopPropagation();
            dispatchSmartCommand('CLEAR_PASSAGE');
            return;
        }
        if (isShortcutMod && e.code === 'KeyG') {
            e.preventDefault();
            e.stopPropagation();
            dispatchSmartCommand('ANALYZE_PAGE');
            return;
        }
        if (isShortcutMod && e.code === 'KeyL') {
            e.preventDefault();
            e.stopPropagation();
            dispatchSmartCommand('LISTEN');
            return;
        }
        if (isShortcutMod && e.code === 'KeyS') {
            e.preventDefault();
            e.stopPropagation();
            dispatchSmartCommand('TOGGLE_PICKER');
            return;
        }
        if (isShortcutMod && e.code === 'KeyA') {
            e.preventDefault();
            e.stopPropagation();
            dispatchSmartCommand('TOGGLE_AUTOTYPE');
            return;
        }
        if (isShortcutMod && e.code === 'KeyW') {
            e.preventDefault();
            e.stopPropagation();
            dispatchSmartCommand('FILL_INSTANT');
            return;
        }
        if (isShortcutMod && e.code === 'KeyE') {
            e.preventDefault();
            e.stopPropagation();
            dispatchSmartCommand('CYCLE_ALT');
            return;
        }
        if (isShortcutMod && e.code === 'KeyM') {
            e.preventDefault();
            e.stopPropagation();
            dispatchSmartCommand('TOGGLE_MODEL');
            return;
        }
        if (isShortcutMod && e.code === 'KeyH') {
            e.preventDefault();
            e.stopPropagation();
            dispatchSmartCommand('TOGGLE_UI');
            return;
        }

        const curItem = getCurrentTargetItem();

        // 修复：只在“当前目标输入框”里接管键盘，避免在搜索框等无关输入框里误写答案
        if (isInputFocused && curItem && STATE.questionType !== 'choice' && isQueueTargetElement(activeEl, curItem)) {
            if (e.code === 'Escape') {
                e.preventDefault();
                stopAutoHumanTyping();
                STATE.typingUnlocked = !STATE.typingUnlocked;
                updateStatusBadge(STATE.typingUnlocked
                    ? '🔓 <b>键盘已解锁</b>：可自由编辑修改 (再按 Esc 恢复键盘自瞄)'
                    : `⌨️ <b>键盘自瞄已开启</b>：敲任意键输入 | ${MOD_KEY_LABEL}+A 拟真打字 | Tab 秒填`);
                return;
            }

            if (!STATE.typingUnlocked && CONFIG.enableStealthTyping) {
                if (e.code === 'Tab') {
                    e.preventDefault();
                    stopAutoHumanTyping();
                    setNativeInputValue(activeEl, curItem.text);
                    STATE.typingCursorIndex = curItem.text.length;
                    curItem.completed = true;
                    advanceQueueIfNeeded();
                    return;
                }

                if (e.code === 'Backspace') {
                    stopAutoHumanTyping();
                    STATE.typingCursorIndex = Math.max(0, STATE.typingCursorIndex - 2);
                    return;
                }

                if (e.isComposing || e.keyCode === 229) {
                    return;
                }

                if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
                    e.preventDefault();
                    e.stopPropagation();
                    stepStealthChar(activeEl, curItem);
                    return;
                }
            }
        }
    }, { capture: true });

    window.addEventListener('click', (e) => {
        STATE.rawMouse.x = e.clientX;
        STATE.rawMouse.y = e.clientY;
        STATE.lastMouseMoveAt = Date.now();

        if (STATE.pickerMode) {
            e.stopPropagation();
            e.preventDefault();
            const chosenScope = STATE.hoveredScopeEl;
            toggleScopePickerMode(false);
            if (chosenScope) analyzeCurrentPageQuestion(chosenScope);
            return;
        }

        if (e.altKey) {
            e.stopPropagation();
            e.preventDefault();
            const smartScope = findSmartScopeFromMousePoint(e.clientX, e.clientY);
            analyzeCurrentPageQuestion(smartScope);
            return;
        }

        const curItem = getCurrentTargetItem();
        if (curItem && curItem.el && STATE.questionType === 'choice' &&
            (curItem.el.contains(e.target) || (e.target instanceof Element && e.target.contains(curItem.el)))) {
            setTimeout(() => { curItem.completed = true; advanceQueueIfNeeded(); }, 60);
        }
    }, true);

    /********************************************************************
     * 12. DOM 提取器与 U校园 / 学习通全能解析引擎
     ********************************************************************/
    function querySelectorAllDeep(selector, root = document) {
        const results = Array.from(root.querySelectorAll(selector));
        const allNodes = root.querySelectorAll('*');
        for (const node of allNodes) {
            if (node.shadowRoot) {
                results.push(...querySelectorAllDeep(selector, node.shadowRoot));
            }
        }
        const iframes = root.querySelectorAll('iframe');
        for (const ifr of iframes) {
            try {
                if (ifr.contentDocument) {
                    results.push(...querySelectorAllDeep(selector, ifr.contentDocument));
                }
            } catch (_) {}
        }
        return results;
    }

    function extractInputsInsideScope(scopeRoot, allowGlobalFallback = true) {
        const allBlankSelectors = [...COMMON_INPUT_SELECTORS, ...UNIPUS_PSEUDO_BLANK_SELECTORS].join(',');
        let rawInputs = querySelectorAllDeep(allBlankSelectors, scopeRoot);
        if (rawInputs.length === 0 && allowGlobalFallback && scopeRoot !== document.body) {
            rawInputs = querySelectorAllDeep(allBlankSelectors, document);
        }

        const validInputs = [];
        const seenInputEls = new Set();
        for (const el of rawInputs) {
            if (seenInputEls.has(el) || el.disabled || el.readOnly) continue;
            if (el.type === 'hidden' || el.type === 'radio' || el.type === 'checkbox') continue;
            const rect = el.getBoundingClientRect();
            if (rect.width < 16 || rect.height < 12) continue;
            if (rect.bottom < 0 || rect.top > window.innerHeight) continue;

            const isParentOfAnother = rawInputs.some(other => other !== el && el.contains(other));
            if (isParentOfAnother) continue;

            seenInputEls.add(el);

            const isRealInput = isEditableElement(el);
            const isLargeBox = el.tagName === 'TEXTAREA' || el.isContentEditable || rect.height >= 55 || rect.width >= 320;
            const placeholder = el.getAttribute('placeholder') || el.getAttribute('aria-label') || '';
            const currentValue = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'
                ? el.value
                : el.innerText || '').trim();
            validInputs.push({ el, placeholder, isLargeBox, currentValue, isRealInput });
            if (validInputs.length >= 15) break;
        }
        return validInputs;
    }

    function extractOptionsInsideScope(scopeRoot, allowHeuristic = true) {
        let rawCandidates = querySelectorAllDeep(COMMON_OPTION_SELECTORS.join(','), scopeRoot);

        if (rawCandidates.length === 0 && allowHeuristic) {
            const optionPrefixRegex = /^\s*([A-H]([.、．:：\s)]|$)|[（(][A-H][)）]|[①②③④⑤⑥])/i;
            const allBlocks = querySelectorAllDeep('li, div, p, span, label', scopeRoot);
            for (const node of allBlocks) {
                if (node.children.length > 8) continue;
                const txt = extractRichTextWithBlanks(node);
                if (txt.length >= 1 && txt.length <= 260 && optionPrefixRegex.test(txt)) {
                    rawCandidates.push(node);
                }
            }
        }

        const validOptions = [];
        const seenTexts = new Set();

        for (const el of rawCandidates) {
            const rect = el.getBoundingClientRect();
            if (rect.width < 18 || rect.height < 14 || rect.height > 260) continue;
            if (rect.bottom < 0 || rect.top > window.innerHeight) continue;

            const text = extractRichTextWithBlanks(el);
            if (!text || text.length < 1 || text.length > 350) continue;
            if (seenTexts.has(text)) continue;

            const isParentOfAnother = rawCandidates.some(other => other !== el && el.contains(other));
            if (isParentOfAnother) continue;

            seenTexts.add(text);
            validOptions.push({ el, text });
            if (validOptions.length >= 10) break;
        }
        return validOptions;
    }

    function extractQuizFromDOM(explicitScopeEl = null) {
        const selection = window.getSelection();
        const selectionText = selection?.toString().trim() || '';

        let scopeRoot = explicitScopeEl;
        if (!scopeRoot && selectionText && selection.anchorNode) {
            const anchorEl = selection.anchorNode.nodeType === 1
                ? selection.anchorNode
                : selection.anchorNode.parentElement;
            if (anchorEl) {
                const r = anchorEl.getBoundingClientRect();
                scopeRoot = findSmartScopeFromMousePoint(r.left + r.width / 2, r.top + r.height / 2) || anchorEl.parentElement;
            }
        }

        if (!scopeRoot) {
            scopeRoot = findSmartScopeFromMousePoint(STATE.rawMouse.x, STATE.rawMouse.y) || document.body;
        }

        flashLockedQuestionScope(scopeRoot);

        const validOptions = extractOptionsInsideScope(scopeRoot, true);
        // 修复：题块内已有选项时，不再去全页面乱抓输入框（否则会把站内搜索框当成“目标空格”）
        const allScopeInputs = extractInputsInsideScope(scopeRoot, validOptions.length === 0);

        const primaryInputObj = findNearestInputToMouse(allScopeInputs);
        const primaryInputEl = primaryInputObj ? primaryInputObj.el : null;
        const targetInputs = primaryInputObj ? [primaryInputObj] : allScopeInputs;

        const sectionHeader = extractSectionHeaderAndDirections(scopeRoot);
        const samePagePassage = findSamePageReadingPassage(scopeRoot);
        const markedScopeText = extractRichTextWithBlanks(scopeRoot, primaryInputEl).slice(0, 1800);
        const fullScrollContext = extractScrollContainerFullContext(scopeRoot, primaryInputEl);

        const questionText = selectionText
            ? `${selectionText}\n\n【所在题组带空格位置标记】：\n${markedScopeText}`
            : markedScopeText;

        return {
            questionText,
            fullScrollContext,
            sectionHeader,
            samePagePassage,
            options: validOptions,
            inputs: targetInputs,
            scopeRoot
        };
    }

    function parseModelJsonSafely(rawText) {
        if (!rawText) return null;
        const cleaned = rawText.replace(/```json|```/gi, '').trim();
        try {
            return JSON.parse(cleaned);
        } catch (_) {
            const firstBrace = cleaned.indexOf('{');
            const lastBrace = cleaned.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace > firstBrace) {
                return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
            }
            throw new Error('未找到合法的 JSON 结构');
        }
    }

    function ensureApiKey() {
        STATE.apiKey = GM_getValue('DEEPSEEK_API_KEY', '') || STATE.apiKey;
        if (STATE.apiKey) return true;
        let inputKey = null;
        // 跨域 iframe 里浏览器会禁用 prompt，这里失败就提示去菜单配置
        try { inputKey = prompt('尚未配置 DeepSeek API Key，请先输入 (sk-...):', ''); } catch (_) {}
        if (!inputKey || !inputKey.trim()) {
            updateStatusBadge('⚠️ 尚未配置 DeepSeek API Key：请在油猴菜单选择「🔑 设置 DeepSeek API Key」');
            return false;
        }
        STATE.apiKey = inputKey.trim();
        GM_setValue('DEEPSEEK_API_KEY', STATE.apiKey);
        return true;
    }

    async function callDeepSeek(systemPrompt, userPrompt) {
        STATE.model = GM_getValue('DEEPSEEK_MODEL', STATE.model);
        const payload = {
            model: STATE.model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ]
        };
        if (STATE.model === 'deepseek-chat') {
            payload.temperature = 0.1;
            payload.response_format = { type: 'json_object' };
        }
        const res = await gmRequest({
            method: 'POST',
            url: CONFIG.apiUrl,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${STATE.apiKey}`
            },
            data: JSON.stringify(payload),
            timeout: STATE.model === 'deepseek-reasoner' ? 300000 : 120000
        });
        if (res.status !== 200) {
            const reason = res.status === 401 ? 'API Key 无效'
                : res.status === 402 ? '账户余额不足'
                : res.status === 429 ? '请求过于频繁，请稍后再试'
                : '请检查 API Key 或余额';
            throw new Error(`API 请求失败 (HTTP ${res.status})：${reason}`);
        }
        let parsed;
        try {
            const data = JSON.parse(res.responseText);
            parsed = parseModelJsonSafely(data.choices?.[0]?.message?.content || '{}');
        } catch (err) {
            console.error('[DeepSeek Pro 3.6.0] 解析响应出错:', err);
            throw new Error('解析返回数据失败，可重试一次');
        }
        return parsed;
    }

    async function analyzeCurrentPageQuestion(explicitScopeEl = null) {
        stopAutoHumanTyping();
        if (STATE.isAnalyzing) return;
        if (!ensureApiKey()) return;

        const {
            questionText,
            fullScrollContext,
            sectionHeader,
            samePagePassage,
            options,
            inputs,
            scopeRoot
        } = extractQuizFromDOM(explicitScopeEl);

        if (options.length === 0 && inputs.length === 0 && (!questionText || questionText.length < 6)) {
            if (document.querySelector('iframe')) { broadcastToAllFrames({ type: 'REMOTE_CMD', cmd: 'ANALYZE' }); return; }
            updateStatusBadge(`⚠️ 未在鼠标指向处检测到题目，请将鼠标停在题目文字上或框选题干再按 <b>${MOD_KEY_LABEL}+Q</b>（或按 <b>${MOD_KEY_LABEL}+G</b> 通读整页）`);
            return;
        }

        STATE.pageChoiceEls = [];
        if (inputs.length > 0 && options.length === 0) {
            clearTargetHighlights();
            if (CONFIG.showVisualHint) {
                inputs[0].el.classList.add('ds-correct-option-hint');
            }
        }

        STATE.isAnalyzing = true;
        try {
            // 先“听”：有相关音频且已配置转写服务时自动静默转写（已听过的直接用缓存）
            const listeningClues = await gatherListeningContext(scopeRoot);

            const stemPreview = escapeHtml(questionText.replace(/\[\[.*?\]\]/g, '___').slice(0, 22));
            updateStatusBadge(`⏳ 已锁定「<b>${stemPreview}...</b>」${listeningClues ? '（含听力原文）' : ''}，正在请求 ${STATE.model === 'deepseek-reasoner' ? 'R1' : 'V3'}...`);

            const numberedOptions = options.length > 0
                ? options.map((opt, idx) => `[${idx}] ${opt.text}`).join('\n')
                : '（无选择题选项）';
            const numberedInputs = inputs.length > 0
                ? inputs.map((inp, idx) => `[目标空格 ${idx}] 类型=${inp.isLargeBox ? '多行文本框' : '填空/选词格'} placeholder="${inp.placeholder}" 当前值="${inp.currentValue}"`).join('\n')
                : '（无标准输入框，请直接根据题干给出答案）';

            STATE.savedPassage = GM_getValue('DEEPSEEK_SAVED_PASSAGE', '');
            const combinedPassage = [
                STATE.savedPassage ? `【跨页记忆阅读/词库材料】：\n${STATE.savedPassage}` : '',
                fullScrollContext && fullScrollContext.length > questionText.length + 30
                    ? `【同页完整题组与上方词库上下文（注意区分“已填”与“👉当前需要作答的目标空格👈”）】：\n${fullScrollContext}`
                    : '',
                samePagePassage && !fullScrollContext.includes(samePagePassage.slice(0, 50))
                    ? `【同页关联阅读/词库材料】：\n${samePagePassage}`
                    : '',
                listeningClues ? `【听力线索/语音转写】：\n${listeningClues}` : ''
            ].filter(Boolean).join('\n\n');

            const systemPrompt = [
                '你是一个通用的网页题目解析引擎，适用于任意在线练习/题库页面（含 U校园AI版、学习通及大学英语四六级题型）。',
                '请重点遵守以下四大核心判别规则：',
                '1.【选词填空/单空精准定位】：若标记有 `[[👉当前需要作答的目标空格_X👈]]`，请只针对该空所在句子给出最准确的单词或选项字母，并参考标记为 `[[空格_Y(已填:"...")]]` 的已用词做排除法，绝不要张冠李戴。',
                '2.【单选/多选/判断题】：依据题干精准选出正确项编号数组 bestIndices。',
                '3.【翻译题精准识别】：若大题标题含“翻译/译成英语/Translation”或 placeholder 含“输入你的英文译文”，questionType 设为 "translate"，answers[0] 只输出纯英文译文。',
                '4.【长阅读与听力题】：若提供了背景材料或语音转写，严格依据原文细节推导（转写可能有个别错词，按发音相近合理还原）；无原文听力题按听力同义替换与命题规律反推。',
                '必须严格返回如下 JSON 格式（不要输出任何多余解释或代码块标记）：',
                '{',
                '  "questionType": "choice" 或 "input" 或 "translate" 或 "essay",',
                '  "bestIndices": [数字编号数组，如 [0] 或 [0, 2]],',
                '  "answers": ["针对当前目标题/空格的唯一准确答案"],',
                '  "altFormats": ["首选最佳答案", "备选答案2", "备选答案3"]',
                '}'
            ].join('\n');

            const userPrompt = [
                sectionHeader ? `【所属大题标题与答题要求】：\n${sectionHeader}` : '',
                combinedPassage,
                `【当前锁定题目内容】：\n${questionText}`,
                `【候选选项列表】：\n${numberedOptions}`,
                `【当前锁定的目标空格】：\n${numberedInputs}`
            ].filter(Boolean).join('\n\n');

            const parsed = await callDeepSeek(systemPrompt, userPrompt);
            bindParsedTargets(parsed, options, inputs);
        } catch (err) {
            console.error('[DeepSeek Pro 3.6.0] 解析失败:', err);
            updateStatusBadge(`❌ ${escapeHtml(err?.message || '请求失败')}（${MOD_KEY_LABEL}+Q 重试）`);
        } finally {
            STATE.isAnalyzing = false;
        }
    }

    /********************************************************************
     * 13. 整页通读模式 (Ctrl/Alt + G)：不依赖任何站点专属类名，
     *     把“人眼能看到的内容”按阅读顺序线性化，交给模型自己找题、答题
     ********************************************************************/
    const PAGE_OPTION_SELECTOR = COMMON_OPTION_SELECTORS
        .filter(sel => !['label', '.marBom6', '.ul-list li', '.clearfix li'].includes(sel))
        .join(',');
    const PAGE_PSEUDO_BLANK_SELECTOR = UNIPUS_PSEUDO_BLANK_SELECTORS.join(',');
    const OPTION_PREFIX_RE = /^\s*(?:[（(]?[A-Ha-h][)）.、．:：]\s*\S|[①②③④⑤⑥⑦⑧])/;
    const BLOCK_TAG_RE = /^(P|DIV|LI|UL|OL|TR|TABLE|SECTION|ARTICLE|H[1-6]|FIELDSET|FORM|DL|DT|DD|BLOCKQUOTE|PRE|HEADER|FOOTER|MAIN|ASIDE|NAV|LEGEND|FIGCAPTION)$/;
    const SKIP_TAG_RE = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|CANVAS|HEAD|OBJECT|EMBED|AUDIO|VIDEO)$/i;

    function isNodeVisible(el) {
        if (typeof el.checkVisibility === 'function') {
            try { return el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true }); } catch (_) {}
        }
        const st = (el.ownerDocument.defaultView || window).getComputedStyle(el);
        return st.display !== 'none' && st.visibility !== 'hidden';
    }

    function looksLikeOptionNode(el) {
        const tag = el.tagName;
        if (tag === 'LABEL') {
            if (el.querySelector('input[type="radio"], input[type="checkbox"]')) return true;
            const linked = el.htmlFor ? el.ownerDocument.getElementById(el.htmlFor) : null;
            return !!linked && /^(radio|checkbox)$/.test(linked.type || '');
        }
        try { if (el.matches(PAGE_OPTION_SELECTOR)) return true; } catch (_) {}
        if (/^(LI|P|DIV|SPAN|TD)$/.test(tag) && el.children.length <= 6) {
            const text = el.textContent || '';
            if (text.length > 260 || !OPTION_PREFIX_RE.test(text)) return false;
            const trimmed = text.trim();
            // 排除“把 A/B/C/D 整组包起来”的外层容器
            return !Array.from(el.children).some(ch => {
                const ct = (ch.textContent || '').trim();
                return ct !== trimmed && OPTION_PREFIX_RE.test(ct);
            });
        }
        return false;
    }

    function buildPageSnapshot() {
        const options = [];
        const blanks = [];
        const out = [];
        let size = 0;
        const limit = CONFIG.pageTextLimit;
        const push = (str) => { if (size < limit) { out.push(str); size += str.length; } };

        const walk = (node, insideOption) => {
            if (size >= limit) return;
            if (node.nodeType === 3) {
                const t = node.nodeValue.replace(/\s+/g, ' ');
                if (t.trim()) push(t);
                return;
            }
            if (node.nodeType !== 1) return;
            const tag = node.tagName;
            if (SKIP_TAG_RE.test(tag) || node.id === 'ds-status-badge') return;
            if (tag === 'BR' || tag === 'HR') { push('\n'); return; }
            if (!isNodeVisible(node)) return;

            if (tag === 'IFRAME') {
                try { if (node.contentDocument?.body) walk(node.contentDocument.body, false); } catch (_) {}
                return;
            }
            if (tag === 'IMG') {
                const alt = (node.getAttribute('alt') || node.getAttribute('title') || node.getAttribute('data-latex') || '').trim();
                if (alt) push(` [图片:${alt}] `);
                return;
            }
            if (node.classList.contains('katex') || node.classList.contains('MathJax')) {
                const tex = node.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
                if (tex) { push(` $${tex.trim()}$ `); return; }
            }
            if (node.classList.contains('katex-html') || node.classList.contains('MathJax_Preview')) return;

            if (tag === 'SELECT') {
                if (node.disabled || blanks.length >= 60) return;
                const choices = Array.from(node.options).map(o => o.text.trim()).filter(Boolean).slice(0, 12).join(' | ');
                const chosen = node.selectedIndex > 0 ? ` 已选:"${node.options[node.selectedIndex].text.trim()}"` : '';
                push(` ⟦B#${blanks.length} 下拉可选: ${choices}${chosen}⟧ `);
                blanks.push({ el: node });
                return;
            }
            if (tag === 'INPUT') {
                const type = (node.type || 'text').toLowerCase();
                if (type === 'radio' || type === 'checkbox') {
                    if (!insideOption && options.length < 120) {
                        const host = node.parentElement && node.parentElement.children.length <= 3 ? node.parentElement : node;
                        push(`\n⟦O#${options.length}${node.checked ? ' 已选' : ''}⟧ `);
                        options.push({ el: host });
                    }
                    return;
                }
                if (!/^(text|search|number|tel|email|url)$/.test(type)) return;
            }
            const isPseudoBlank = (() => { try { return node.matches(PAGE_PSEUDO_BLANK_SELECTOR); } catch (_) { return false; } })();
            if (tag === 'INPUT' || tag === 'TEXTAREA' || node.isContentEditable ||
                node.getAttribute('role') === 'textbox' || isPseudoBlank) {
                if (node.disabled || node.readOnly || blanks.length >= 60) return;
                const val = (tag === 'INPUT' || tag === 'TEXTAREA' ? node.value : node.innerText || '').trim().slice(0, 80);
                const hint = (node.getAttribute('placeholder') || node.getAttribute('aria-label') || '').trim().slice(0, 40);
                push(` ⟦B#${blanks.length}${tag === 'TEXTAREA' || node.isContentEditable ? ' 长文本框' : ''}${hint ? ` 提示:"${hint}"` : ''}${val ? ` 已填:"${val}"` : ''}⟧ `);
                blanks.push({ el: node });
                return;
            }

            let nowInsideOption = insideOption;
            if (!insideOption && options.length < 120 && looksLikeOptionNode(node)) {
                const checked = node.querySelector('input:checked') ||
                    /(^|[\s_-])(checked|selected|active)([\s_-]|$)/i.test(String(node.className || ''));
                push(`\n⟦O#${options.length}${checked ? ' 已选' : ''}⟧ `);
                options.push({ el: node });
                nowInsideOption = true;
            }

            const kids = node.shadowRoot ? node.shadowRoot.childNodes : node.childNodes;
            for (const kid of kids) walk(kid, nowInsideOption);

            if (tag === 'TD' || tag === 'TH') push(' | ');
            else if (BLOCK_TAG_RE.test(tag) || nowInsideOption !== insideOption) push('\n');
        };

        if (document.body) walk(document.body, false);
        const text = out.join('')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n[ \t]+/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .replace(/[ \t]{2,}/g, ' ')
            .trim();
        return { text, options, blanks, truncated: size >= limit };
    }

    async function analyzeWholePage() {
        stopAutoHumanTyping();
        if (STATE.isAnalyzing) return;
        if (!ensureApiKey()) return;

        const snap = buildPageSnapshot();
        if (snap.options.length === 0 && snap.blanks.length === 0 && snap.text.length < 40) {
            if (document.querySelector('iframe')) { broadcastToAllFrames({ type: 'REMOTE_CMD', cmd: 'ANALYZE_PAGE' }); return; }
            updateStatusBadge('⚠️ 这个页面上没有读到可识别的文字内容（文字可能是图片或画布，脚本无法读取）');
            return;
        }

        STATE.isAnalyzing = true;
        try {
            STATE.pageChoiceEls = [];
            STATE.targetQueue = [];
            clearTargetHighlights();

            const listening = await gatherListeningContext(null, 6);
            updateStatusBadge(
                `👀 正在通读整页 (${snap.text.length} 字 · ${snap.options.length} 个选项 · ${snap.blanks.length} 个空` +
                `${listening ? ' · 含听力原文' : ''})，请求 ${STATE.model === 'deepseek-reasoner' ? 'R1' : 'V3'}...`
            );

            STATE.savedPassage = GM_getValue('DEEPSEEK_SAVED_PASSAGE', '');
            const systemPrompt = [
                '你会像一位认真的学习者那样阅读一张网页，并回答页面上出现的所有题目。',
                '用户给你的是该网页按阅读顺序线性化后的可见文字快照，其中：',
                '· `⟦O#n⟧` 表示它后面紧跟的那段文字是一个可点击的选项（单选/多选/判断），n 是选项编号；带“已选”表示用户已经选了它。',
                '· `⟦B#n ...⟧` 表示一个可填写的空（输入框、下拉框或文本框），n 是空格编号；可能附带 提示/已填/下拉可选 信息。',
                '页面里会混有导航、菜单、页脚、广告等无关内容，请自行忽略；题目可能是任何学科、任何语言。',
                '如果提供了【听力】转写原文，说明这些题目是听力题，请严格依据转写内容作答（机器转写可能有个别错词，按发音相近合理还原）。',
                '如果提供了阅读材料，依据材料作答。逐题思考，但只输出最终 JSON（不要输出任何多余解释或代码块标记）：',
                '{',
                '  "items": [',
                '    {',
                '      "label": "题号或 12 字以内的题干摘要",',
                '      "choose": [应当选择的选项编号 n，可为空数组],',
                '      "fills": [{ "blank": 空格编号 n, "text": "应填入的内容" }],',
                '      "answer": "给人看的简短答案，如 B、True、went to",',
                '      "why": "不超过 25 字的依据"',
                '    }',
                '  ],',
                '  "note": "若页面上没有题目，在此用一句话说明页面内容；否则留空"',
                '}',
                '注意：choose 与 fills 里只能使用快照中真实出现的编号；每个下拉空的 text 必须是其“下拉可选”中的原文。'
            ].join('\n');

            const userPrompt = [
                `【网页标题】：${document.title || '(无)'}`,
                STATE.savedPassage ? `【用户此前保存的阅读/词库材料】：\n${STATE.savedPassage}` : '',
                listening ? `【听力】\n${listening}` : '',
                `【网页可见内容快照${snap.truncated ? '（页面过长，已截断）' : ''}】：\n${snap.text}`
            ].filter(Boolean).join('\n\n');

            const parsed = await callDeepSeek(systemPrompt, userPrompt);
            applyPageAnswers(parsed, snap);
        } catch (err) {
            console.error('[DeepSeek Pro 3.6.0] 整页解析失败:', err);
            updateStatusBadge(`❌ ${escapeHtml(err?.message || '请求失败')}（${MOD_KEY_LABEL}+G 重试）`);
        } finally {
            STATE.isAnalyzing = false;
        }
    }

    function applyPageAnswers(parsed, snap) {
        const items = Array.isArray(parsed?.items) ? parsed.items : [];
        const choiceEls = [];
        const queue = [];
        const lines = [];

        for (const item of items) {
            if (!item || typeof item !== 'object') continue;
            const chosenTexts = [];
            (Array.isArray(item.choose) ? item.choose : []).forEach(n => {
                const opt = snap.options[Number(n)];
                if (opt && !choiceEls.includes(opt.el)) {
                    choiceEls.push(opt.el);
                    chosenTexts.push((opt.el.innerText || opt.el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40));
                }
            });
            (Array.isArray(item.fills) ? item.fills : []).forEach(fill => {
                const blank = snap.blanks[Number(fill?.blank)];
                const text = String(fill?.text ?? '').trim();
                if (blank && text) queue.push({ el: blank.el, text, altFormats: [text], completed: false });
            });
            const answer = String(item.answer || chosenTexts.join(' / ') ||
                (Array.isArray(item.fills) ? item.fills.map(f => f?.text).filter(Boolean).join(' / ') : '')).slice(0, 90);
            if (answer) {
                const why = item.why ? ` <span style="color:#94a3b8">${escapeHtml(String(item.why).slice(0, 40))}</span>` : '';
                lines.push(`<b>${escapeHtml(String(item.label || lines.length + 1).slice(0, 18))}</b> → <b>${escapeHtml(answer)}</b>${why}`);
            }
        }

        if (lines.length === 0) {
            updateStatusBadge(`ℹ️ 没有在这个页面上找到题目。${parsed?.note ? escapeHtml(String(parsed.note).slice(0, 120)) : ''}`);
            return;
        }

        STATE.pageChoiceEls = choiceEls;
        STATE.targetQueue = queue;
        STATE.questionType = queue.length > 0 ? 'input' : 'choice';
        STATE.currentQueueIdx = 0;
        STATE.typingCursorIndex = 0;
        STATE.altFormatIdx = 0;
        STATE.typingUnlocked = false;
        refreshTargetHighlights();

        const shown = lines.slice(0, 30);
        const footer = queue.length > 0
            ? `绿色虚线=应选项；填空：点进对应空后按 <b>Tab</b> 填入`
            : '绿色虚线标出的就是应选项';
        updateStatusBadge(
            `✅ 整页共 ${lines.length} 题：<br>${shown.join('<br>')}` +
            `${lines.length > shown.length ? '<br>…' : ''}<br><span style="color:#94a3b8">${footer}</span>`
        );
    }

    function bindParsedTargets(parsed, options, inputs) {
        if (!parsed) return;

        const hasChoices = options.length > 0 && parsed.questionType === 'choice';
        const isTextMode = !hasChoices && inputs.length > 0;

        const indices = Array.isArray(parsed.bestIndices)
            ? parsed.bestIndices.map(Number).filter(n => !Number.isNaN(n))
            : (parsed.bestIndex !== undefined ? [Number(parsed.bestIndex)] : [0]);
        const answers = Array.isArray(parsed.answers) && parsed.answers.length > 0
            ? parsed.answers.map(String)
            : (parsed.answerText ? [String(parsed.answerText)] : []);
        const altFormats = Array.isArray(parsed.altFormats) && parsed.altFormats.length > 0
            ? parsed.altFormats.map(String).filter(Boolean)
            : answers;

        const queue = [];

        if (isTextMode) {
            const firstAns = (answers[0] || altFormats[0] || '').trim();
            const isTranslate = parsed.questionType === 'translate' ||
                /译文|翻译|english/i.test(inputs[0]?.placeholder || '');
            const isEssay = !isTranslate && (parsed.questionType === 'essay' || inputs[0]?.isLargeBox || firstAns.length > 35);

            STATE.questionType = isTranslate ? 'translate' : (isEssay ? 'essay' : 'input');

            inputs.forEach((inp, idx) => {
                const ansText = (answers[idx] || answers[0] || altFormats[0] || '').trim();
                if (ansText) {
                    queue.push({
                        el: inp.el,
                        text: ansText,
                        altFormats: idx === 0 && altFormats.length > 0 ? altFormats : [ansText],
                        completed: false
                    });
                }
            });
        } else {
            STATE.questionType = 'choice';
            for (const idx of indices) {
                if (options[idx]) {
                    queue.push({
                        el: options[idx].el,
                        text: options[idx].text,
                        altFormats: [],
                        completed: false
                    });
                }
            }
            if (queue.length === 0 && answers.length > 0) {
                for (const ans of answers) {
                    const matched = options.find(o => o.text.includes(ans) || ans.includes(o.text));
                    if (matched) {
                        queue.push({
                            el: matched.el,
                            text: matched.text,
                            altFormats: [],
                            completed: false
                        });
                    }
                }
            }
        }

        if (queue.length === 0) {
            updateStatusBadge(
                `💡 解析答案：<b>${escapeHtml(answers.join(' / ') || '未知')}</b><br>` +
                `<span style="color:#94a3b8">直接参考此答案作答 | 按 <b>${MOD_KEY_LABEL}+Q</b> 继续分析下一题</span>`
            );
            return;
        }

        STATE.pageChoiceEls = [];
        STATE.targetQueue = queue;
        STATE.currentQueueIdx = 0;
        STATE.typingCursorIndex = 0;
        STATE.altFormatIdx = 0;
        STATE.typingUnlocked = false;

        refreshTargetHighlights();
        renderQueueStatus();
    }

    function renderQueueStatus() {
        const cur = getCurrentTargetItem();
        if (!cur) return;

        const total = STATE.targetQueue.length;
        const stepTag = total > 1 ? `[${STATE.currentQueueIdx + 1}/${total}] ` : '';

        if (STATE.questionType === 'translate') {
            updateStatusBadge(
                `🌐 ${stepTag}英文译文已就绪：<b>${escapeHtml(cur.text.slice(0, 38))}...</b><br>` +
                `<span style="color:#94a3b8">聚焦敲任意键盲打 | <b>${MOD_KEY_LABEL}+A</b> 自动打字 | <b>${MOD_KEY_LABEL}+E</b> 换译文 | <b>Tab</b> 秒填</span>`
            );
        } else if (STATE.questionType === 'essay') {
            updateStatusBadge(
                `📝 ${stepTag}简答已就绪 (${cur.text.length}字)：<b>${escapeHtml(cur.text.slice(0, 26))}...</b><br>` +
                `<span style="color:#94a3b8">聚焦敲任意键按词盲打 | <b>${MOD_KEY_LABEL}+A</b> 自动打字 | <b>${MOD_KEY_LABEL}+E</b> 换版本 | <b>Tab</b> 秒填</span>`
            );
        } else if (STATE.questionType === 'input') {
            const altCount = cur.altFormats?.length || 1;
            const altHint = altCount > 1 ? ` | <b>${MOD_KEY_LABEL}+E</b> 备选词(${altCount})` : '';
            updateStatusBadge(
                `⌨️ ${stepTag}填空答案：<b>${escapeHtml(cur.text.slice(0, 30))}</b><br>` +
                `<span style="color:#94a3b8">点击该空敲任意键输入 | <b>Tab</b> 秒填${altHint} | <b>Esc</b> 解锁</span>`
            );
        } else {
            const multiHint = total > 1 ? ' (多选：点击当前项后提示下一项)' : '';
            updateStatusBadge(
                `✅ ${stepTag}锁定选项：<b>${escapeHtml(cur.text.slice(0, 28))}</b>${multiHint}<br>` +
                `<span style="color:#94a3b8">请查看页面绿色高亮提示选项</span>`
            );
        }
    }

    function escapeHtml(str) {
        return String(str).replace(/[&<>"']/g, (m) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[m]));
    }
})();