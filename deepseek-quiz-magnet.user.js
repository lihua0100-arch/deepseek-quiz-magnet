// ==UserScript==
// @name         DeepSeek 智能题库解析与磁吸自瞄助手 Pro (3.1 U校园/选词填空精准定位版)
// @namespace    https://tampermonkey.net/
// @version      3.5.0
// @updateURL    https://raw.githubusercontent.com/lihua0100-arch/deepseek-quiz-magnet/main/deepseek-quiz-magnet.user.js
// @downloadURL  https://raw.githubusercontent.com/lihua0100-arch/deepseek-quiz-magnet/main/deepseek-quiz-magnet.user.js
// @description  U校园与学习通题目解析助手，支持鼠标指题、选题和快捷键；嵌入页面请在题目所在区域操作。
// @author       Gemini
// @match        *://*/*
// @allFrames    true
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      api.deepseek.com
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
     * 1. 配置参数与跨页面持久状态管理
     ********************************************************************/
    const CONFIG = {
        apiUrl: 'https://api.deepseek.com/chat/completions',
        showVisualHint: true,
        enableStealthTyping: true
    };

    const STATE = {
        apiKey: GM_getValue('DEEPSEEK_API_KEY', ''),
        model: GM_getValue('DEEPSEEK_MODEL', 'deepseek-chat'),
        savedPassage: GM_getValue('DEEPSEEK_SAVED_PASSAGE', ''),
        listeningTranscript: '',
        isListeningASR: false,
        asrInstance: null,

        enabled: true,
        typingUnlocked: false,
        pickerMode: false,
        hoveredScopeEl: null,
        autoTypingTimer: null,
        isAnalyzing: false,
        rawMouse: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
        lastMouseMoveAt: Date.now(), // 记录鼠标最后一次在当前 frame 活动的时间戳

        questionType: 'choice',      // 'choice' | 'input' | 'translate' | 'essay'
        targetQueue: [],             // [{ el, text, altFormats: [], completed: false }]
        currentQueueIdx: 0,
        altFormatIdx: 0,
        typingCursorIndex: 0
    };

    // 命令在题目所在框架中执行。
    function executeCommandLocally(cmd) {
        if (cmd === 'ANALYZE') analyzeCurrentPageQuestion();
        else if (cmd === 'SAVE_PASSAGE') captureReadingPassageToMemory();
        else if (cmd === 'CLEAR_PASSAGE') clearSavedReadingPassage();
        else if (cmd === 'TOGGLE_ASR') toggleListeningSpeechRecognition();
        else if (cmd === 'TOGGLE_PICKER') toggleScopePickerMode();
        else if (cmd === 'TOGGLE_AUTOTYPE') toggleAutoHumanTyping();
        else if (cmd === 'FILL_INSTANT') fillTargetInputInstantly();
        else if (cmd === 'CYCLE_ALT') cycleAlternativeAnswerFormat();
        else if (cmd === 'TOGGLE_MODEL') toggleModelMode();
        else if (cmd === 'TOGGLE_UI') {
            CONFIG.showVisualHint = !CONFIG.showVisualHint;
            toggleVisualUI(CONFIG.showVisualHint);
        }
    }

    function dispatchSmartCommand(cmd) {
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

        GM_registerMenuCommand(`🎧 开启/停止听力实时语音识别 (${MOD_KEY_LABEL}+L)`, () => {
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

        GM_registerMenuCommand(`👁️ 切换状态栏显示 (${MOD_KEY_LABEL}+H)`, () => {
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
    document.head.appendChild(styleEl);

    window.addEventListener('selectstart', (e) => e.stopPropagation(), true);
    window.addEventListener('copy', (e) => e.stopPropagation(), true);

    let badgeEl = null;
    {
        badgeEl = document.createElement('div');
        badgeEl.id = 'ds-status-badge';
        badgeEl.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;gap:6px;">
                <span style="font-weight:600;color:#38bdf8;">🎯 DeepSeek 题库助手 Pro 3.5</span>
                <div style="display:flex;gap:4px;">
                    <span id="ds-mem-tag" style="font-size:10px;background:#065f46;padding:1px 5px;border-radius:4px;color:#a7f3d0;display:${STATE.savedPassage ? 'inline-block' : 'none'};">📚已存阅读(${STATE.savedPassage.length}字)</span>
                    <span id="ds-asr-tag" style="font-size:10px;background:#991b1b;padding:1px 5px;border-radius:4px;color:#fecaca;display:none;">🎙️听力收音中</span>
                    <span id="ds-model-tag" style="font-size:10px;background:#1e293b;padding:1px 6px;border-radius:4px;color:#94a3b8;">${STATE.model === 'deepseek-reasoner' ? 'R1推理' : 'V3极速'}</span>
                </div>
            </div>
            <div id="ds-status-text">指题按 <b>${MOD_KEY_LABEL}+Q</b> 或 <b>按住${MOD_KEY_LABEL}+左键点题</b> | 存阅读 <b>${MOD_KEY_LABEL}+C</b></div>
        `;
        document.body.appendChild(badgeEl);
    }

    function renderBadgeDOM(msg, isASR = STATE.isListeningASR) {
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
        renderBadgeDOM(msg, STATE.isListeningASR);
    }

    /********************************************************************
     * 5. U校园 AI版 5.0 (uai.unipus.cn / ucontent.unipus.cn) 与学习通全题型选择器
     ********************************************************************/
    const COMMON_CONTAINER_SELECTORS = [
        // U校园 AI版 5.0 专属题块容器
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

    // U校园特有的“非 input 伪空格”（如选词填空拖拽格、点选填空横线、段落信息匹配下拉框）
    const UNIPUS_PSEUDO_BLANK_SELECTORS = [
        '[class*="cloze-blank"]', '[class*="blank-item"]', '[class*="blank-box"]',
        '[class*="drop-target"]', '[class*="droppable"]', '[data-blank]', '[data-index][class*="blank"]',
        '.ant-select-selector', '[class*="select-blank"]'
    ];

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
        updateStatusBadge('🗑️ 已清空跨页阅读记忆与听力缓存');
    }

    /********************************************************************
     * 7. 听力题双引擎解决方案 (Ctrl/Alt + L)
     ********************************************************************/
    function toggleListeningSpeechRecognition() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            updateStatusBadge('⚠️ 当前浏览器不支持原生语音识别(建议 Chrome/Edge)，将自动使用【听力选项逻辑反推模式】');
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
            updateStatusBadge('🎙️ <b>正在收听英语听力音频...</b> (请外放音频，随时按 <b>' + MOD_KEY_LABEL + '+Q</b> 解题)');
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
            }
            const preview = (STATE.listeningTranscript + ' ' + interimChunk).slice(-42);
            updateStatusBadge(`🎙️ 实时听写中：<i>"...${escapeHtml(preview)}"</i> (指题按 <b>${MOD_KEY_LABEL}+Q</b> 秒解)`);
        };

        recognition.onerror = (e) => {
            if (e.error === 'not-allowed') {
                STATE.isListeningASR = false;
                updateStatusBadge('⚠️ 请允许网页麦克风权限，或直接按 ' + MOD_KEY_LABEL + '+Q 使用无原文选项反推');
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

    function extractHiddenListeningClues() {
        const clues = [];
        document.querySelectorAll('[class*="script"], [class*="transcript"], [class*="listening-text"], [class*="lyric"], [class*="audio-text"]').forEach(el => {
            const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (t.length > 20 && t.length < 3000) clues.push(t);
        });
        if (STATE.listeningTranscript) {
            clues.push(`【实时语音转写听力原文】：${STATE.listeningTranscript}`);
        }
        return clues.join('\n');
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
        document.querySelectorAll('.ds-correct-option-hint, .ds-secondary-option-hint').forEach(el => {
            el.classList.remove('ds-correct-option-hint', 'ds-secondary-option-hint');
        });
    }

    function refreshTargetHighlights() {
        clearTargetHighlights();
        if (!CONFIG.showVisualHint) return;
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
        if (badgeEl) badgeEl.style.display = visible ? 'block' : 'none';
        refreshTargetHighlights();
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

        const options = extractOptionsInsideScope(node, false);
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
        if (isEditableElement(activeEl) && activeEl.value?.length > 0) {
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

    window.addEventListener('compositionend', () => {
        const activeEl = document.activeElement;
        const curItem = getCurrentTargetItem();
        if (
            activeEl &&
            curItem &&
            STATE.questionType !== 'choice' &&
            !STATE.typingUnlocked &&
            CONFIG.enableStealthTyping
        ) {
            stepStealthChar(activeEl, curItem);
        }
    }, true);

    window.addEventListener('keydown', (e) => {
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
        if (isShortcutMod && e.code === 'KeyL') {
            e.preventDefault();
            e.stopPropagation();
            dispatchSmartCommand('TOGGLE_ASR');
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

        if (isInputFocused && curItem && STATE.questionType !== 'choice') {
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

    // 点击事件：
    // 1. 若处于瞄准器模式，点击即锁定题块；
    // 2. 新增 Mac/Win 极速选法：按住 Option/Alt (或 Mac 下按住 Control) + 鼠标左键点一下题目，直接锁定该题并解析！
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

        // 按住 Option/Alt (或 Mac 下 Ctrl+左键，注意排除 Mac 下 Ctrl+左键触发右键菜单的默认行为) 直接点题秒解
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

            // 防止父子伪空格重复计入
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

        // 启发式兜底 1：扫描带 A./B./C./D. 或 (A) 或 A 开头且同级并列的选项节点（兼容 U校园 图标+文字 flex 布局）
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

        const allScopeInputs = extractInputsInsideScope(scopeRoot, true);
        const validOptions = extractOptionsInsideScope(scopeRoot, true);

        const primaryInputObj = findNearestInputToMouse(allScopeInputs);
        const primaryInputEl = primaryInputObj ? primaryInputObj.el : null;
        const targetInputs = primaryInputObj ? [primaryInputObj] : allScopeInputs;

        const sectionHeader = extractSectionHeaderAndDirections(scopeRoot);
        const samePagePassage = findSamePageReadingPassage(scopeRoot);
        const listeningClues = extractHiddenListeningClues();

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
            listeningClues,
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

    function analyzeCurrentPageQuestion(explicitScopeEl = null) {
        stopAutoHumanTyping();
        STATE.apiKey = GM_getValue('DEEPSEEK_API_KEY', '') || STATE.apiKey;
        if (!STATE.apiKey) {
            const inputKey = prompt('尚未配置 DeepSeek API Key，请先输入 (sk-...):', '');
            if (!inputKey) return;
            STATE.apiKey = inputKey.trim();
            GM_setValue('DEEPSEEK_API_KEY', STATE.apiKey);
        }

        if (STATE.isAnalyzing) return;

        const {
            questionText,
            fullScrollContext,
            sectionHeader,
            samePagePassage,
            listeningClues,
            options,
            inputs
        } = extractQuizFromDOM(explicitScopeEl);

        // 兜底机制：即使页面上的题目是纯文本/自定义组件（既没检测到标准选项也没检测到 input），
        // 只要用户用鼠标框选了文字或者当前题块有超过 10 个字符的文本，依然发送给 DeepSeek 解析并在右下角直接显示答案！
        if (options.length === 0 && inputs.length === 0 && (!questionText || questionText.length < 6)) {
            updateStatusBadge(`⚠️ 未在鼠标指向处检测到题目，请将鼠标停在题目文字上或框选题干再按 <b>${MOD_KEY_LABEL}+Q</b>`);
            return;
        }

        if (inputs.length > 0 && options.length === 0) {
            clearTargetHighlights();
            if (CONFIG.showVisualHint) {
                inputs[0].el.classList.add('ds-correct-option-hint');
            }
        }

        STATE.isAnalyzing = true;
        const stemPreview = escapeHtml(questionText.replace(/\[\[.*?\]\]/g, '___').slice(0, 22));
        updateStatusBadge(`⏳ 已锁定「<b>${stemPreview}...</b>」，正在请求 ${STATE.model === 'deepseek-reasoner' ? 'R1' : 'V3'}...`);

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
            listeningClues ? `【听力线索/实时语音转写】：\n${listeningClues}` : ''
        ].filter(Boolean).join('\n\n');

        const systemPrompt = [
            '你是一个专为 U校园AI版(uai.unipus.cn / ucontent.unipus.cn)、学习通及大学英语四六级设计的全能题库解析引擎。',
            '请重点遵守以下四大核心判别规则：',
            '1.【U校园选词填空/单空精准定位】：若标记有 `[[👉当前需要作答的目标空格_X👈]]`，请只针对该空所在句子给出最准确的单词或选项字母，并参考标记为 `[[空格_Y(已填:"...")]]` 的已用词做排除法，绝不要张冠李戴。',
            '2.【单选/多选/判断题】：依据题干精准选出正确项编号数组 bestIndices。',
            '3.【翻译题精准识别】：若大题标题含“翻译/译成英语/Translation”或 placeholder 含“输入你的英文译文”，questionType 设为 "translate"，answers[0] 只输出纯英文译文。',
            '4.【长阅读与听力题】：若提供了背景材料或语音转写，严格依据原文细节推导；无原文听力题按四六级听力同义替换与命题规律反推。',
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

        GM_xmlhttpRequest({
            method: 'POST',
            url: CONFIG.apiUrl,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${STATE.apiKey}`
            },
            data: JSON.stringify(payload),
            onload: (res) => {
                STATE.isAnalyzing = false;
                try {
                    if (res.status !== 200) {
                        updateStatusBadge(`❌ API 请求失败 (HTTP ${res.status})，请检查 API Key 或余额`);
                        return;
                    }
                    const data = JSON.parse(res.responseText);
                    const rawContent = data.choices?.[0]?.message?.content || '{}';
                    const parsed = parseModelJsonSafely(rawContent);

                    bindParsedTargets(parsed, options, inputs);
                } catch (err) {
                    console.error('[DeepSeek Pro 3.5] 解析响应出错:', err);
                    updateStatusBadge(`❌ 解析返回数据失败，可按 ${MOD_KEY_LABEL}+Q 重试`);
                }
            },
            onerror: (err) => {
                STATE.isAnalyzing = false;
                console.error('[DeepSeek Pro 3.5] 网络错误:', err);
                updateStatusBadge('❌ 网络请求失败，请检查网络连接');
            }
        });
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

        // 即使页面使用了特殊的非标伪元素，只要模型算出了答案，也在右下角清晰展示出来！
        if (queue.length === 0) {
            updateStatusBadge(
                `💡 解析答案：<b>${escapeHtml(answers.join(' / ') || '未知')}</b><br>` +
                `<span style="color:#94a3b8">直接参考此答案作答 | 按 <b>${MOD_KEY_LABEL}+Q</b> 继续分析下一题</span>`
            );
            return;
        }

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