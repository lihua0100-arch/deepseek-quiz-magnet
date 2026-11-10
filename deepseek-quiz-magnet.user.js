// ==UserScript==
// @name         DeepSeek 智能题库解析与磁吸自瞄助手 Pro (3.1 U校园/选词填空精准定位版)
// @namespace    https://tampermonkey.net/
// @version      3.2.2
// @updateURL    https://raw.githubusercontent.com/lihua0100-arch/deepseek-quiz-magnet/main/deepseek-quiz-magnet.user.js
// @downloadURL  https://raw.githubusercontent.com/lihua0100-arch/deepseek-quiz-magnet/main/deepseek-quiz-magnet.user.js
// @description  修复U校园等平台多空选词填空“指第5空却识别到第6空/漏识别空格位置”的问题：精准将<input>原位转写为[[👉当前目标空格👈]]标记、自动抓取滚动区上方词库框(words in the box)、支持单行题块与已填词排除法。
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

    if (window.self !== window.top && (window.innerWidth < 120 || window.innerHeight < 80)) {
        return;
    }

    const IS_MAC = /Mac|iPod|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
    const MOD_KEY_LABEL = IS_MAC ? '⌃Ctrl(或⌥Opt)' : 'Alt';

    /********************************************************************
     * 1. 配置参数与跨页面持久状态管理
     ********************************************************************/
    const CONFIG = {
        apiUrl: 'https://api.deepseek.com/chat/completions',
        magnetRadius: 340,        // 磁吸触发半径（像素）
        lockRadius: 36,           // 强吸附锁定半径（像素）
        pullStrength: 0.18,       // 每帧磁吸牵引系数 (0.05 ~ 0.35)
        showVisualHint: true,     // 是否显示虚拟准星与状态栏
        enableStealthTyping: true // 填空/翻译/简答题是否开启“任意键伪装盲打”
    };

    const STATE = {
        apiKey: GM_getValue('DEEPSEEK_API_KEY', ''),
        model: GM_getValue('DEEPSEEK_MODEL', 'deepseek-chat'),
        savedPassage: GM_getValue('DEEPSEEK_SAVED_PASSAGE', ''),
        listeningTranscript: '',
        isListeningASR: false,
        asrInstance: null,

        enabled: true,
        spacePressed: false,
        typingUnlocked: false,
        pickerMode: false,
        hoveredScopeEl: null,
        autoTypingTimer: null,
        isAnalyzing: false,
        rawMouse: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
        virtualMouse: { x: window.innerWidth / 2, y: window.innerHeight / 2 },

        questionType: 'choice',   // 'choice' | 'input' | 'translate' | 'essay'
        targetQueue: [],          // [{ el, text, altFormats: [], completed: false }]
        currentQueueIdx: 0,
        altFormatIdx: 0,
        typingCursorIndex: 0,
        isRedirectingClick: false
    };

    /********************************************************************
     * 2. 油猴扩展菜单注册
     ********************************************************************/
    GM_registerMenuCommand('🔑 设置 DeepSeek API Key', () => {
        const key = prompt('请输入您的 DeepSeek API Key (sk-...):', STATE.apiKey);
        if (key !== null) {
            STATE.apiKey = key.trim();
            GM_setValue('DEEPSEEK_API_KEY', STATE.apiKey);
            updateStatusBadge(STATE.apiKey ? `✅ API Key 已保存 (${MOD_KEY_LABEL}+Q 分析题目)` : '⚠️ 未配置 API Key');
        }
    });

    GM_registerMenuCommand(`🎯 智能分析鼠标指向的题目/空格 (${MOD_KEY_LABEL}+Q)`, () => {
        analyzeCurrentPageQuestion();
    });

    GM_registerMenuCommand(`📚 跨页记忆当前阅读文章/词库 (${MOD_KEY_LABEL}+C)`, () => {
        captureReadingPassageToMemory();
    });

    GM_registerMenuCommand(`🗑️ 清空已记忆的跨页阅读文章 (${MOD_KEY_LABEL}+X)`, () => {
        clearSavedReadingPassage();
    });

    GM_registerMenuCommand(`🎧 开启/停止听力实时语音识别 (${MOD_KEY_LABEL}+L)`, () => {
        toggleListeningSpeechRecognition();
    });

    GM_registerMenuCommand(`🔍 开启“指哪打哪”选题瞄准器 (${MOD_KEY_LABEL}+S)`, () => {
        toggleScopePickerMode();
    });

    GM_registerMenuCommand(`🤖 启动/暂停拟真自动打字机 (${MOD_KEY_LABEL}+A)`, () => {
        toggleAutoHumanTyping();
    });

    GM_registerMenuCommand(`🧠 切换模型: V3极速 / R1深度推理 (${MOD_KEY_LABEL}+M)`, () => {
        toggleModelMode();
    });

    GM_registerMenuCommand(`👁️ 切换准星与状态栏显示 (${MOD_KEY_LABEL}+H)`, () => {
        CONFIG.showVisualHint = !CONFIG.showVisualHint;
        toggleVisualUI(CONFIG.showVisualHint);
    });

    function toggleModelMode() {
        STATE.model = STATE.model === 'deepseek-chat' ? 'deepseek-reasoner' : 'deepseek-chat';
        GM_setValue('DEEPSEEK_MODEL', STATE.model);
        const label = STATE.model === 'deepseek-reasoner'
            ? '🧠 已切换至 <b>R1 深度推理</b>：适合复杂选词填空、阅读与听力推理'
            : '⚡ 已切换至 <b>V3 极速模式</b>：适合常规题库秒回';
        updateStatusBadge(label);
    }

    /********************************************************************
     * 3. 虚拟磁吸光标、解除网页禁选限制与 UI 构建
     ********************************************************************/
    const styleEl = document.createElement('style');
    styleEl.textContent = `
        html, body, body * {
            -webkit-user-select: text !important;
            -moz-user-select: text !important;
            user-select: text !important;
        }
        body.ds-magnet-active, body.ds-magnet-active * {
            cursor: none !important;
        }
        #ds-virtual-cursor {
            position: fixed;
            top: 0;
            left: 0;
            width: 22px;
            height: 22px;
            pointer-events: none !important;
            z-index: 2147483647;
            transform: translate(-3px, -2px);
            transition: filter 0.15s ease;
            display: none;
        }
        #ds-virtual-cursor.ds-locked {
            filter: drop-shadow(0 0 6px rgba(16, 185, 129, 0.95));
        }
        #ds-virtual-cursor.ds-unlocked-space {
            filter: drop-shadow(0 0 6px rgba(245, 158, 11, 0.9));
        }
        #ds-status-badge {
            position: fixed;
            bottom: 16px;
            right: 16px;
            z-index: 2147483646;
            background: rgba(15, 23, 42, 0.92);
            color: #f8fafc;
            font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", system-ui, sans-serif;
            font-size: 12px;
            line-height: 1.5;
            padding: 8px 12px;
            border-radius: 8px;
            border: 1px solid rgba(148, 163, 184, 0.25);
            box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
            backdrop-filter: blur(6px);
            -webkit-backdrop-filter: blur(6px);
            user-select: none !important;
            max-width: 400px;
        }
        .ds-correct-option-hint {
            outline: 2px dashed rgba(16, 185, 129, 0.75) !important;
            outline-offset: 2px !important;
            background-color: rgba(16, 185, 129, 0.06) !important;
        }
        .ds-secondary-option-hint {
            outline: 1px dotted rgba(56, 189, 248, 0.5) !important;
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

    const cursorEl = document.createElement('div');
    cursorEl.id = 'ds-virtual-cursor';
    cursorEl.innerHTML = `
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M4 2L20 11L12.5 13.5L16 21L13 22.2L9.5 14.8L4 19V2Z"
                  fill="#ffffff" stroke="#0f172a" stroke-width="1.8" stroke-linejoin="round"/>
            <circle id="ds-cursor-dot" cx="10" cy="10" r="2.2" fill="#10b981" opacity="0"/>
        </svg>
    `;
    document.body.appendChild(cursorEl);

    const badgeEl = document.createElement('div');
    badgeEl.id = 'ds-status-badge';
    badgeEl.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;gap:6px;">
            <span style="font-weight:600;color:#38bdf8;">🎯 DeepSeek 磁吸/自瞄 3.1</span>
            <div style="display:flex;gap:4px;">
                <span id="ds-mem-tag" style="font-size:10px;background:#065f46;padding:1px 5px;border-radius:4px;color:#a7f3d0;display:${STATE.savedPassage ? 'inline-block' : 'none'};">📚已存阅读(${STATE.savedPassage.length}字)</span>
                <span id="ds-asr-tag" style="font-size:10px;background:#991b1b;padding:1px 5px;border-radius:4px;color:#fecaca;display:none;">🎙️听力收音中</span>
                <span id="ds-model-tag" style="font-size:10px;background:#1e293b;padding:1px 6px;border-radius:4px;color:#94a3b8;">${STATE.model === 'deepseek-reasoner' ? 'R1推理' : 'V3极速'}</span>
            </div>
        </div>
        <div id="ds-status-text">指题/指空按 <b>${MOD_KEY_LABEL}+Q</b> | 存阅读/词库 <b>${MOD_KEY_LABEL}+C</b></div>
    `;
    document.body.appendChild(badgeEl);

    function updateStatusBadge(msg) {
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
            asrTag.style.display = STATE.isListeningASR ? 'inline-block' : 'none';
        }
    }

    /********************************************************************
     * 4. 跨页面长阅读 / 词库记忆库 (Ctrl/Alt + C 存入，Ctrl/Alt + X 清空)
     ********************************************************************/
    function captureReadingPassageToMemory() {
        let text = window.getSelection()?.toString().trim() || '';

        if (!text) {
            const hitEl = document.elementFromPoint(STATE.rawMouse.x, STATE.rawMouse.y);
            const passageContainer = hitEl?.closest('article, .passage, .reading-content, .article-content, .material, [class*="passage"], [class*="article"], [class*="reading"], [class*="word"]');
            if (passageContainer) {
                text = extractRichTextWithBlanks(passageContainer);
            } else {
                const blocks = querySelectorAllDeep('article, section, div, p').filter(el => {
                    const r = el.getBoundingClientRect();
                    return r.width > 200 && r.height > 60 && el.children.length < 30;
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
     * 5. 听力题双引擎解决方案 (Ctrl/Alt + L)
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
        document.querySelectorAll('[class*="script"], [class*="transcript"], [class*="listening-text"], [class*="lyric"]').forEach(el => {
            const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (t.length > 20 && t.length < 3000) clues.push(t);
        });
        if (STATE.listeningTranscript) {
            clues.push(`【实时语音转写听力原文】：${STATE.listeningTranscript}`);
        }
        return clues.join('\n');
    }

    /********************************************************************
     * 6. 核心升级：带 <input> 原位占位标记的富文本提取器 + 滚动容器全景上下文抓取
     *    彻底解决 U校园 等选词填空题：
     *    1) <input> 在 innerText 中消失导致模型不知道横线在哪的问题；
     *    2) 其它题已填单词(如 arrangement, ambitious)被吞掉导致无法排除的问题；
     *    3) 方框词库(words in the box)滚出屏幕上方导致模型看不见备选词的问题。
     ********************************************************************/
    function extractRichTextWithBlanks(node, targetBlankEl = null) {
        if (!node) return '';

        // 在真实 DOM 上临时写入 data-ds-blank-marker 属性，克隆后再替换为文本占位符，最后清理属性
        const inputSelector = 'input, textarea, [contenteditable="true"], [role="textbox"]';
        const liveInputs = Array.from(node.querySelectorAll ? node.querySelectorAll(inputSelector) : []);
        const cleanupList = [];

        liveInputs.forEach((inp, idx) => {
            if (inp.type === 'hidden' || inp.type === 'radio' || inp.type === 'checkbox' || inp.type === 'button' || inp.type === 'submit') {
                return;
            }
            const curVal = (inp.isContentEditable ? inp.innerText : inp.value || '').trim();
            let marker = '';
            if (targetBlankEl && inp === targetBlankEl) {
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

        // 若 node 本身就是一个 input
        if (liveInputs.length === 0 && isEditableElement(node)) {
            const curVal = (node.isContentEditable ? node.innerText : node.value || '').trim();
            return curVal ? `[[👉当前目标空格(已填:"${curVal}")👈]]` : `[[👉当前需要作答的目标空格👈]]`;
        }

        const clone = node.cloneNode(true);

        // 清理真实 DOM 上的临时属性
        cleanupList.forEach(inp => inp.removeAttribute('data-ds-blank-marker'));

        // 1. 将克隆树中的空格标记替换为清晰的显式文本占位符
        clone.querySelectorAll('[data-ds-blank-marker]').forEach(el => {
            const markerText = el.getAttribute('data-ds-blank-marker') || ' [[空格]] ';
            el.replaceWith(markerText);
        });

        // 2. 提取 KaTeX / MathML 中的 TeX 源码
        clone.querySelectorAll('annotation[encoding="application/x-tex"]').forEach(ann => {
            ann.replaceWith(` $${ann.textContent.trim()}$ `);
        });
        clone.querySelectorAll('.katex-html, .MathJax_Preview').forEach(el => el.remove());

        // 3. 提取 MathJax 或 data-latex 公式
        clone.querySelectorAll('script[type^="math/tex"], [data-latex], [data-math], [data-tex]').forEach(el => {
            const tex = el.getAttribute('data-latex') || el.getAttribute('data-math') || el.getAttribute('data-tex') || el.textContent;
            if (tex) el.replaceWith(` $${tex.trim()}$ `);
        });

        // 4. 提取图片 alt / title
        clone.querySelectorAll('img').forEach(img => {
            const alt = img.getAttribute('alt') || img.getAttribute('title') || img.getAttribute('data-latex') || '';
            if (alt && alt.trim().length > 0) {
                img.replaceWith(` [图片:${alt.trim()}] `);
            }
        });

        return (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
    }

    // 抓取当前题块所在的整个滚动容器文本（含滚出视野上方的 Directions、方框词库 words in the box 以及同组其它句子）
    function extractScrollContainerFullContext(scopeRoot, primaryInputEl) {
        let curr = scopeRoot || primaryInputEl;
        let scrollContainer = null;

        while (curr && curr !== document.body) {
            const style = window.getComputedStyle(curr);
            const isScrollable = /(auto|scroll)/i.test(style.overflowY + style.overflow) || curr.scrollHeight > curr.clientHeight + 40;
            const textLen = (curr.innerText || '').length;
            if (isScrollable && textLen >= 100 && textLen <= 8000) {
                scrollContainer = curr;
                break;
            }
            if (textLen >= 250 && textLen <= 5000) {
                scrollContainer = curr;
            }
            curr = curr.parentElement;
        }

        if (!scrollContainer) {
            scrollContainer = document.querySelector('.ant-tabs-tabpane-active, .el-tab-pane, main, article') || document.body;
        }

        return extractRichTextWithBlanks(scrollContainer, primaryInputEl).slice(0, 3500);
    }

    function extractSectionHeaderAndDirections(scopeRoot) {
        const headers = [];
        let curr = scopeRoot;
        while (curr && curr !== document.body) {
            let prev = curr.previousElementSibling;
            let steps = 0;
            while (prev && steps < 8) {
                // 不受视口顶部限制，即使 Directions 滚到了上方也照样提取
                const txt = extractRichTextWithBlanks(prev);
                if (txt.length >= 2 && txt.length <= 500 &&
                    /翻译|译成|译文|Translate|Translation|阅读|Reading|听力|Listening|选词填空|完形|Cloze|简答|写作|Writing|Part|Section|Directions|words in the box/i.test(txt)) {
                    headers.unshift(txt);
                }
                prev = prev.previousElementSibling;
                steps++;
            }
            curr = curr.parentElement;
        }

        document.querySelectorAll('h1, h2, h3, h4, [class*="section-title"], [class*="part-title"], [class*="directions"], [class*="word-box"], [class*="word-bank"]').forEach(el => {
            const t = extractRichTextWithBlanks(el);
            if (t.length >= 2 && t.length <= 500 && !headers.includes(t)) {
                headers.push(t);
            }
        });

        return headers.slice(0, 5).join(' | ');
    }

    function findSamePageReadingPassage(scopeRoot) {
        const candidates = querySelectorAllDeep(
            'article, .passage, .reading-passage, .article-body, [class*="passage"], [class*="reading"], [class*="material"], [class*="word-box"], [class*="word-bank"]'
        );
        for (const el of candidates) {
            if (scopeRoot && scopeRoot.contains(el)) continue;
            const t = extractRichTextWithBlanks(el);
            if (t.length >= 30 && t.length <= 6500) {
                return t;
            }
        }
        return '';
    }

    /********************************************************************
     * 7. 精准定位鼠标指向的单个空格 / 单行题块（修复 U校园 单行高度 <28px 漏判）
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
        badgeEl.style.display = visible ? 'block' : 'none';
        refreshTargetHighlights();
    }

    function getCurrentTargetItem() {
        return STATE.targetQueue[STATE.currentQueueIdx] || null;
    }

    // 找到离当前鼠标指针最近（或当前已点击聚焦）的单个输入框
    function findNearestInputToMouse(inputsList) {
        if (!inputsList || inputsList.length === 0) return null;

        // 1. 如果用户当前已经点击聚焦了其中某个输入框，且鼠标离它不远(<220px)，优先以聚焦框为准
        const activeEl = document.activeElement;
        const focusedItem = inputsList.find(item => item.el === activeEl || item.el.contains(activeEl));
        if (focusedItem) {
            const r = focusedItem.el.getBoundingClientRect();
            const distToMouse = Math.hypot(
                (r.left + r.width / 2) - STATE.rawMouse.x,
                (r.top + r.height / 2) - STATE.rawMouse.y
            );
            if (distToMouse < 220) return focusedItem;
        }

        // 2. 计算可视区域所有输入框与当前鼠标 (rawMouse.x, rawMouse.y) 的几何距离，取最近的那个框！
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
        // 支持 U校园 等单行填空句子（高度放宽至 >=16px）
        if (rect.width < 90 || rect.height < 16) return { valid: false };
        if (rect.height > window.innerHeight * 0.92 && node.children.length > 4) return { valid: false };

        const options = extractOptionsInsideScope(node, false);
        const inputs = extractInputsInsideScope(node, false);
        const fullText = extractRichTextWithBlanks(node);

        const hasInteractiveItems = options.length >= 2 || inputs.length >= 1;
        const hasStemOrPureListening = fullText.length >= 4 || options.length >= 3;

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

        let curr = hitEl;
        let depth = 0;
        let fallbackCandidate = null;

        while (curr && curr !== document.body && depth < 12) {
            const evalRes = scoreQuestionContainer(curr);
            if (evalRes.valid) {
                // 如果找到了刚好只包含 1 个填空输入框的单句容器（如 U校园 的第 5 题整句），立刻精准返回！
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

        const commonSelectors = [
            '.question-item', '.question-box', '.question-card', '.exam-item',
            '.subject-item', '.q-item', '.ti-item', '.problem-item',
            '[class*="question"]', '[class*="subject"]', '[class*="topic"]',
            'fieldset', 'article', 'li', 'p', 'div'
        ];
        const candidates = querySelectorAllDeep(commonSelectors.join(',')).filter(el => {
            const r = el.getBoundingClientRect();
            return r.width > 140 && r.height >= 16 && r.height < window.innerHeight * 0.85 &&
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
            // 优先奖励只含 1 个输入框的紧凑单句容器
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
        if (smartScope && smartScope !== STATE.hoveredScopeEl && smartScope !== badgeEl && !badgeEl.contains(smartScope)) {
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
     * 8. 输入框赋值器、拟真自动打字机与多版本切换
     ********************************************************************/
    function isEditableElement(el) {
        if (!el) return false;
        const tag = el.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable || el.getAttribute?.('role') === 'textbox';
    }

    function setNativeInputValue(el, newText) {
        if (!el) return;
        const lastChar = newText.slice(-1) || '';

        el.dispatchEvent(new KeyboardEvent('keydown', { key: lastChar, bubbles: true }));
        el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: lastChar, bubbles: true }));

        if (el.isContentEditable || el.getAttribute?.('role') === 'textbox') {
            el.innerText = newText;
        } else {
            const proto = el.tagName === 'TEXTAREA'
                ? window.HTMLTextAreaElement.prototype
                : window.HTMLInputElement.prototype;
            const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (nativeSetter) {
                nativeSetter.call(el, newText);
            } else {
                el.value = newText;
            }
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
     * 9. 鼠标磁吸、全局快捷键与盲打推进
     ********************************************************************/
    window.addEventListener('mousemove', (e) => {
        STATE.rawMouse.x = e.clientX;
        STATE.rawMouse.y = e.clientY;

        if (!document.body.classList.contains('ds-magnet-active')) {
            document.body.classList.add('ds-magnet-active');
            cursorEl.style.display = 'block';
        }

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
            analyzeCurrentPageQuestion();
            return;
        }
        if (isShortcutMod && e.code === 'KeyC') {
            e.preventDefault();
            e.stopPropagation();
            captureReadingPassageToMemory();
            return;
        }
        if (isShortcutMod && e.code === 'KeyX') {
            e.preventDefault();
            e.stopPropagation();
            clearSavedReadingPassage();
            return;
        }
        if (isShortcutMod && e.code === 'KeyL') {
            e.preventDefault();
            e.stopPropagation();
            toggleListeningSpeechRecognition();
            return;
        }
        if (isShortcutMod && e.code === 'KeyS') {
            e.preventDefault();
            e.stopPropagation();
            toggleScopePickerMode();
            return;
        }
        if (isShortcutMod && e.code === 'KeyA') {
            e.preventDefault();
            e.stopPropagation();
            toggleAutoHumanTyping();
            return;
        }
        if (isShortcutMod && e.code === 'KeyW') {
            e.preventDefault();
            e.stopPropagation();
            fillTargetInputInstantly();
            return;
        }
        if (isShortcutMod && e.code === 'KeyE') {
            e.preventDefault();
            e.stopPropagation();
            cycleAlternativeAnswerFormat();
            return;
        }
        if (isShortcutMod && e.code === 'KeyM') {
            e.preventDefault();
            e.stopPropagation();
            toggleModelMode();
            return;
        }
        if (isShortcutMod && e.code === 'KeyH') {
            e.preventDefault();
            e.stopPropagation();
            CONFIG.showVisualHint = !CONFIG.showVisualHint;
            toggleVisualUI(CONFIG.showVisualHint);
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

        if (e.code === 'Space' && !isInputFocused && curItem) {
            e.preventDefault();
            if (!STATE.spacePressed) {
                STATE.spacePressed = true;
                cursorEl.classList.add('ds-unlocked-space');
                cursorEl.classList.remove('ds-locked');
                updateStatusBadge('🔓 <b>空格已按住</b>：鼠标磁吸已解锁，可自由移动');
            }
        }
    }, { capture: true });

    window.addEventListener('keyup', (e) => {
        if (e.code === 'Space' && STATE.spacePressed) {
            STATE.spacePressed = false;
            cursorEl.classList.remove('ds-unlocked-space');
            if (getCurrentTargetItem()) {
                renderQueueStatus();
            }
        }
    }, { capture: true });

    function getTargetCenter() {
        const curItem = getCurrentTargetItem();
        if (!curItem || !curItem.el || !document.body.contains(curItem.el)) {
            return null;
        }
        const rect = curItem.el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            rect
        };
    }

    function updateMagnetPhysics() {
        const target = getTargetCenter();
        const dotEl = document.getElementById('ds-cursor-dot');

        if (!STATE.enabled || !target || STATE.spacePressed || STATE.pickerMode) {
            STATE.virtualMouse.x += (STATE.rawMouse.x - STATE.virtualMouse.x) * 0.45;
            STATE.virtualMouse.y += (STATE.rawMouse.y - STATE.virtualMouse.y) * 0.45;
            cursorEl.classList.remove('ds-locked');
            if (dotEl) dotEl.setAttribute('opacity', '0');
        } else {
            const dxRaw = target.x - STATE.rawMouse.x;
            const dyRaw = target.y - STATE.rawMouse.y;
            const distFromRaw = Math.hypot(dxRaw, dyRaw);

            if (distFromRaw <= CONFIG.magnetRadius) {
                const normalizedDist = Math.max(0, Math.min(1, 1 - distFromRaw / CONFIG.magnetRadius));
                const magnetWeight = Math.pow(normalizedDist, 1.35);

                const desiredX = STATE.rawMouse.x + dxRaw * Math.min(0.96, magnetWeight * 1.15);
                const desiredY = STATE.rawMouse.y + dyRaw * Math.min(0.96, magnetWeight * 1.15);

                const pull = CONFIG.pullStrength + magnetWeight * 0.14;
                STATE.virtualMouse.x += (desiredX - STATE.virtualMouse.x) * pull;
                STATE.virtualMouse.y += (desiredY - STATE.virtualMouse.y) * pull;

                const distVirtual = Math.hypot(target.x - STATE.virtualMouse.x, target.y - STATE.virtualMouse.y);
                if (distVirtual <= CONFIG.lockRadius) {
                    cursorEl.classList.add('ds-locked');
                    if (dotEl) dotEl.setAttribute('opacity', '1');
                } else {
                    cursorEl.classList.remove('ds-locked');
                    if (dotEl) dotEl.setAttribute('opacity', '0.5');
                }
            } else {
                STATE.virtualMouse.x += (STATE.rawMouse.x - STATE.virtualMouse.x) * 0.4;
                STATE.virtualMouse.y += (STATE.rawMouse.y - STATE.virtualMouse.y) * 0.4;
                cursorEl.classList.remove('ds-locked');
                if (dotEl) dotEl.setAttribute('opacity', '0');
            }
        }

        cursorEl.style.transform = `translate3d(${STATE.virtualMouse.x - 3}px, ${STATE.virtualMouse.y - 2}px, 0)`;
        // 触屏设备：先点“选题”，再点题目；不拦截普通滚动和点击。
    if (/iPad/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
        const panel = document.createElement('div');
        panel.setAttribute('data-ds-touch-panel', '');
        panel.style.cssText = 'position:fixed;z-index:2147483647;left:8px;bottom:12px;display:flex;gap:4px;flex-wrap:wrap;max-width:95vw;background:#172235ee;padding:6px;border-radius:10px;box-shadow:0 2px 10px #0006';
        let armed = false;
        function addTouchButton(label, action) {
            const b = document.createElement('button');
            b.type = 'button'; b.textContent = label;
            b.style.cssText = 'font:14px sans-serif;color:white;background:#30557d;border:0;border-radius:6px;padding:9px 10px;touch-action:manipulation';
            b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); action(); });
            panel.appendChild(b); return b;
        }
        const selectButton = addTouchButton('选题分析', () => {
            armed = !armed;
            selectButton.textContent = armed ? '取消选题' : '选题分析';
            updateStatusBadge(armed ? '👆 请点击要分析的题目或空格' : '已取消选题');
        });
        addTouchButton('填写', fillTargetInputInstantly);
        addTouchButton('记文章', captureReadingPassageToMemory);
        addTouchButton('设置Key', () => {
            const key = prompt('请输入您的 DeepSeek API Key：', STATE.apiKey);
            if (key !== null) { STATE.apiKey = key.trim(); GM_setValue('DEEPSEEK_API_KEY', STATE.apiKey); updateStatusBadge(STATE.apiKey ? '✅ API Key 已保存' : '⚠️ 未配置 API Key'); }
        });
        addTouchButton('收起', () => {
            const hidden = panel.dataset.collapsed === '1';
            panel.dataset.collapsed = hidden ? '0' : '1';
            Array.from(panel.children).forEach((el, i) => { if (i < panel.children.length - 1) el.style.display = hidden ? '' : 'none'; });
            panel.lastElementChild.textContent = hidden ? '收起' : '展开';
        });
        document.body.appendChild(panel);
        window.addEventListener('click', e => {
            if (!armed || panel.contains(e.target)) return;
            e.preventDefault(); e.stopImmediatePropagation();
            armed = false; selectButton.textContent = '选题分析';
            STATE.rawMouse.x = e.clientX; STATE.rawMouse.y = e.clientY;
            const scope = findSmartScopeFromMousePoint(e.clientX, e.clientY) || e.target;
            analyzeCurrentPageQuestion(scope);
        }, true);
        window.addEventListener('touchstart', e => {
            if (panel.contains(e.target) || !e.touches.length) return;
            STATE.rawMouse.x = e.touches[0].clientX; STATE.rawMouse.y = e.touches[0].clientY;
            STATE.virtualMouse.x = STATE.rawMouse.x; STATE.virtualMouse.y = STATE.rawMouse.y;
        }, {passive: true});
    }

    requestAnimationFrame(updateMagnetPhysics);
    }
    requestAnimationFrame(updateMagnetPhysics);

    /********************************************************************
     * 10. 点击事件拦截
     ********************************************************************/
    window.addEventListener('click', (e) => {
        if (e.target instanceof Element && e.target.closest('[data-ds-touch-panel]')) return;
        if (STATE.pickerMode) {
            e.stopPropagation();
            e.preventDefault();
            const chosenScope = STATE.hoveredScopeEl;
            toggleScopePickerMode(false);
            if (chosenScope) {
                analyzeCurrentPageQuestion(chosenScope);
            }
            return;
        }

        if (STATE.isRedirectingClick || !STATE.enabled || STATE.spacePressed) {
            return;
        }
        const curItem = getCurrentTargetItem();
        if (!curItem || !curItem.el) return;

        const offsetDist = Math.hypot(STATE.virtualMouse.x - e.clientX, STATE.virtualMouse.y - e.clientY);
        const targetUnderVirtual = document.elementFromPoint(STATE.virtualMouse.x, STATE.virtualMouse.y);
        const isHittingTarget = targetUnderVirtual &&
            (curItem.el.contains(targetUnderVirtual) || targetUnderVirtual.contains(curItem.el));

        if (offsetDist > 4 && isHittingTarget) {
            e.stopPropagation();
            e.preventDefault();

            STATE.isRedirectingClick = true;
            try {
                if (STATE.questionType !== 'choice') {
                    curItem.el.focus();
                } else {
                    const clickable = curItem.el.querySelector('input, label, a, button') || curItem.el;
                    clickable.click();
                    curItem.completed = true;
                    advanceQueueIfNeeded();
                }
            } finally {
                STATE.isRedirectingClick = false;
            }
        } else if (isHittingTarget && STATE.questionType === 'choice') {
            setTimeout(() => {
                curItem.completed = true;
                advanceQueueIfNeeded();
            }, 60);
        }
    }, true);

    /********************************************************************
     * 11. DOM 提取器与 DeepSeek 选词填空/单空精准锁定引擎
     ********************************************************************/
    function querySelectorAllDeep(selector, root = document) {
        const results = Array.from(root.querySelectorAll(selector));
        const allNodes = root.querySelectorAll('*');
        for (const node of allNodes) {
            if (node.shadowRoot) {
                results.push(...querySelectorAllDeep(selector, node.shadowRoot));
            }
        }
        return results;
    }

    function extractInputsInsideScope(scopeRoot, allowGlobalFallback = true) {
        const inputSelectors = [
            'textarea',
            '[contenteditable="true"]',
            '[role="textbox"]',
            '.ql-editor', '.w-e-text', '.ProseMirror', '.edui-body-container',
            'input[type="text"]', 'input:not([type])', 'input[type="search"]', 'input[type="number"]', 'input[type="tel"]'
        ];
        let rawInputs = querySelectorAllDeep(inputSelectors.join(','), scopeRoot);
        if (rawInputs.length === 0 && allowGlobalFallback && scopeRoot !== document.body) {
            rawInputs = querySelectorAllDeep(inputSelectors.join(','), document);
        }

        const validInputs = [];
        const seenInputEls = new Set();
        for (const el of rawInputs) {
            if (seenInputEls.has(el) || el.disabled || el.readOnly) continue;
            if (el.type === 'hidden' || el.type === 'radio' || el.type === 'checkbox') continue;
            const rect = el.getBoundingClientRect();
            if (rect.width < 18 || rect.height < 12) continue;
            if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
            seenInputEls.add(el);

            const isLargeBox = el.tagName === 'TEXTAREA' || el.isContentEditable || rect.height >= 55 || rect.width >= 320;
            const placeholder = el.getAttribute('placeholder') || el.getAttribute('aria-label') || '';
            const currentValue = (el.isContentEditable ? el.innerText : el.value || '').trim();
            validInputs.push({ el, placeholder, isLargeBox, currentValue });
            if (validInputs.length >= 15) break;
        }
        return validInputs;
    }

    function extractOptionsInsideScope(scopeRoot, allowHeuristic = true) {
        const optionSelectors = [
            '.option', '.options li', '.question-option', '.answer-item',
            '.el-radio', '.el-checkbox', '.ant-radio-wrapper', '.ant-checkbox-wrapper',
            'label', 'li[role="option"]', 'div[role="radio"]', 'div[role="checkbox"]',
            '[class*="option-item"]', '[class*="optionItem"]', '[class*="choice-item"]'
        ];

        let rawCandidates = querySelectorAllDeep(optionSelectors.join(','), scopeRoot);

        if (rawCandidates.length === 0 && allowHeuristic) {
            const optionPrefixRegex = /^\s*([A-H][.、．:：\s)]|[（(][A-H][)）]|[①②③④⑤⑥])/i;
            const allBlocks = querySelectorAllDeep('li, div, p, span', scopeRoot);
            for (const node of allBlocks) {
                if (node.children.length > 6) continue;
                const txt = extractRichTextWithBlanks(node);
                if (txt.length >= 1 && txt.length <= 240 && optionPrefixRegex.test(txt)) {
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

        // 核心修复：如果当前区域有多个填空框（例如 U校园 1~6 题），精准找出离鼠标指针最近（或已聚焦）的那一个目标输入框！
        const primaryInputObj = findNearestInputToMouse(allScopeInputs);
        const primaryInputEl = primaryInputObj ? primaryInputObj.el : null;

        // 如果成功锁定了鼠标指向的目标输入框，则将 validInputs 精确收敛为该目标输入框（避免再把答案错绑到第6题上！）
        const targetInputs = primaryInputObj ? [primaryInputObj] : allScopeInputs;

        const sectionHeader = extractSectionHeaderAndDirections(scopeRoot);
        const samePagePassage = findSamePageReadingPassage(scopeRoot);
        const listeningClues = extractHiddenListeningClues();

        // 提取带有 [[👉当前需要作答的目标空格👈]] 显式标记的题目文本与同组上下文（含已填单词与上方词库框）
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

        if (options.length === 0 && inputs.length === 0) {
            updateStatusBadge(`⚠️ 未在鼠标指向处检测到选项或输入框，可按 <b>${MOD_KEY_LABEL}+S</b> 手动框定题块`);
            return;
        }

        // 一旦触发分析且锁定了鼠标指向的空格，立即先把绿框移到该空格上给用户视觉反馈！
        if (inputs.length > 0 && options.length === 0) {
            clearTargetHighlights();
            if (CONFIG.showVisualHint) {
                inputs[0].el.classList.add('ds-correct-option-hint');
            }
        }

        STATE.isAnalyzing = true;
        const stemPreview = escapeHtml(questionText.replace(/\[\[.*?\]\]/g, '___').slice(0, 22));
        updateStatusBadge(`⏳ 已锁定目标空格「<b>${stemPreview}...</b>」，正在请求 ${STATE.model === 'deepseek-reasoner' ? 'R1' : 'V3'}...`);

        const numberedOptions = options.length > 0
            ? options.map((opt, idx) => `[${idx}] ${opt.text}`).join('\n')
            : '（无选择题选项）';
        const numberedInputs = inputs.length > 0
            ? inputs.map((inp, idx) => `[目标输入框 ${idx}] 类型=${inp.isLargeBox ? '多行文本框' : '单行填空框'} placeholder="${inp.placeholder}" 当前框内值="${inp.currentValue}"`).join('\n')
            : '（无输入框）';

        const combinedPassage = [
            STATE.savedPassage ? `【跨页记忆阅读/词库材料】：\n${STATE.savedPassage}` : '',
            fullScrollContext && fullScrollContext.length > questionText.length + 30
                ? `【同页完整题组与上方词库上下文（注意区分“已填”与“👉当前需要作答的目标空格👈” Complete the sentences）】：\n${fullScrollContext}`
                : '',
            samePagePassage && !fullScrollContext.includes(samePagePassage.slice(0, 50))
                ? `【同页关联阅读/词库材料】：\n${samePagePassage}`
                : '',
            listeningClues ? `【听力线索/实时语音转写】：\n${listeningClues}` : ''
        ].filter(Boolean).join('\n\n');

        const systemPrompt = [
            '你是一个专为大学英语四六级(CET-4/6)、U校园(Unipus)、考研英语及各类网课设计的全能题库解析引擎。',
            '请重点遵守以下四大核心判别规则：',
            '1.【单空/选词填空精准定位】：题目文本中标记为 `[[👉当前需要作答的目标空格_X👈]]` 的位置，就是用户当前鼠标指向并要求你解答的唯一空格！其它标记为 `[[空格_Y(已填:"...")]]` 的是页面上其它题已经填好的单词（可用来辅助判断首字母规律或排除词库中已用过的词）。请务必只针对 `[[👉当前需要作答的目标空格👈]]` 所在的这一句话给出最准确的填入单词，绝不要把其它句子的答案（如第6题的 activities）张冠李戴！',
            '2.【翻译题精准识别】：若大题标题含“翻译/译成英语/Translation”或 placeholder 含“输入你的英文译文/译文/English”，必须将 questionType 设为 "translate"，且 answers[0] 只输出纯英文译文。',
            '3.【长阅读/跨页阅读与词库】：若提供了【跨页记忆阅读/词库材料】或【同页完整题组与上方词库上下文】，必须结合词库(words in the box)及语法词性变形(Change the form where necessary)给出准确变形后的单词。',
            '4.【听力题专项处理】：若提供了实时语音转写，依据转写选答案；若仅有 A/B/C/D 选项而无题干，运用四六级听力同义替换与选项逻辑反推法选出最优项。',
            '必须严格返回如下 JSON 格式（不要输出任何多余解释或代码块标记）：',
            '{',
            '  "questionType": "choice" 或 "input" 或 "translate" 或 "essay",',
            '  "bestIndices": [0],',
            '  "answers": ["针对👉当前需要作答的目标空格👈的唯一准确答案（如 apart）"],',
            '  "altFormats": ["首选最佳答案(如 apart)", "备选同义/变形词2(如 separated)", "备选词3(如 away)"]',
            '}'
        ].join('\n');

        const userPrompt = [
            sectionHeader ? `【所属大题标题与答题要求】：\n${sectionHeader}` : '',
            combinedPassage,
            `【当前锁定题目内容（请重点看 👉当前需要作答的目标空格👈 所在句子）】：\n${questionText}`,
            `【候选选项列表】：\n${numberedOptions}`,
            `【当前锁定的目标输入框】：\n${numberedInputs}`
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
                    console.error('[DeepSeek Magnet Pro] 解析响应出错:', err);
                    updateStatusBadge(`❌ 解析返回数据失败，可按 ${MOD_KEY_LABEL}+Q 重试`);
                }
            },
            onerror: (err) => {
                STATE.isAnalyzing = false;
                console.error('[DeepSeek Magnet Pro] 网络错误:', err);
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

        if (queue.length === 0) {
            updateStatusBadge(`💡 解析答案：<b>${escapeHtml(answers.join(' / ') || '未知')}</b> (未匹配到页面元素)`);
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
                `🌐 ${stepTag}英文译文已就绪：<b>${escapeHtml(cur.text.slice(0, 34))}...</b><br>` +
                `<span style="color:#94a3b8">聚焦敲任意键盲打 | <b>${MOD_KEY_LABEL}+A</b> 自动打字 | <b>${MOD_KEY_LABEL}+E</b> 换译文 | <b>Tab</b> 秒填</span>`
            );
        } else if (STATE.questionType === 'essay') {
            updateStatusBadge(
                `📝 ${stepTag}简答已就绪 (${cur.text.length}字)：<b>${escapeHtml(cur.text.slice(0, 22))}...</b><br>` +
                `<span style="color:#94a3b8">聚焦敲任意键按词盲打 | <b>${MOD_KEY_LABEL}+A</b> 自动打字 | <b>${MOD_KEY_LABEL}+E</b> 换版本 | <b>Tab</b> 秒填</span>`
            );
        } else if (STATE.questionType === 'input') {
            const altCount = cur.altFormats?.length || 1;
            const altHint = altCount > 1 ? ` | <b>${MOD_KEY_LABEL}+E</b> 备选词(${altCount})` : '';
            updateStatusBadge(
                `⌨️ ${stepTag}填空答案：<b>${escapeHtml(cur.text.slice(0, 26))}</b><br>` +
                `<span style="color:#94a3b8">点击该空敲任意键输入 | <b>Tab</b> 秒填${altHint} | <b>Esc</b> 解锁</span>`
            );
        } else {
            const multiHint = total > 1 ? ' (多选：点击后自动吸附下一项)' : '';
            updateStatusBadge(
                `✅ ${stepTag}锁定选项：<b>${escapeHtml(cur.text.slice(0, 24))}</b>${multiHint}<br>` +
                `<span style="color:#94a3b8">靠近选项自动吸附 | 按住 <b>空格</b> 解锁鼠标</span>`
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