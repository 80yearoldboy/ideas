// ==UserScript==
// @name         洛谷题解格式检查助手
// @namespace    http://tampermonkey.net/
// @version      1.5.2
// @description  检查洛谷题解格式，辅助通过审核
// @match        https://www.luogu.com.cn/article/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @require      https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js
// @require      https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js
// @require      https://cdn.jsdelivr.net/npm/marked/marked.min.js
// @require      https://cdn.jsdelivr.net/npm/dompurify/dist/purify.min.js
// @resource     katexCSS https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css
// @grant        GM_addStyle
// @grant        GM_getResourceText
// @run-at       document-start
// ==/UserScript==

(function () {//contributor: DeepSeek,Copilot Free,Sunny_boybgfcxc (luogu uid 1144516)
    'use strict';

    var katexCss = GM_getResourceText('katexCSS');
    var fixedCss = katexCss.replace(/url\(fonts\//g, 'url(https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/fonts/');
    GM_addStyle(fixedCss);

    const RESULT_TYPE = {
        HARD: '🔴 硬性错误',
        SUGGEST: '🟡 建议修改',
        INFO: '🔵 提示信息'
    };

    const COMMON_IRRELEVANT = [
        '蒟蒻的第一篇题解', '求赞', '求管理员通过', '点赞', '收藏', '关注',
        '吃瓜', '闲聊', '吐槽', '加戏', '爆肝', '下饭'
    ];

    const SPECIFIC_PROPER_NOUNS = [
        'Catalan', 'Euler', 'Gauss', 'Fibonacci', 'Pythagoras', 'Newton', 'Legendre', 'Dirichlet'
    ];

    const OPERATOR_MAP = {
        gcd: '\\gcd',
        lcm: '\\operatorname{lcm}',
        max: '\\max',
        min: '\\min',
        log: '\\log',
        ln: '\\ln',
        lg: '\\lg',
        sin: '\\sin',
        cos: '\\cos',
        tan: '\\tan',
        det: '\\det',
        mod: '\\bmod'
    };

    const BUILTIN_API_KEY = (function () {
        try {
            const encoded = 'ZTE2OGNjNGVlMTE3NDljZTk3ZTc3MTdjYjI1MGIyM2QuSEpLYUkxNG9HdUN5clJBSw==';
            return atob(encoded);
        } catch (e) {
            return '';
        }
    })();

    const AI_CHAT_SYSTEM_PROMPT = `
你是洛谷题解格式检查助手，目标是结合全文上下文与 LaTeX 公式给出更主观且有价值的建议。
请基于用户问题与当前题解原文内容给出中文回答，不要返回 JSON 数组。
关注点：
1) 题解结构是否合理，标题层级是否规范，有无标题滥用或章节拆分过度；
2) 公式中是否直接使用未转义的函数名/运算符（如 lcm、mod、xor、and、or 等）；
3) 是否把专有名词、普通英文词写在公式中，或者使用了不规范的 Unicode 数学符号；
4) 是否包含“求赞”“求管理员通过”等无关内容；
5) 是否存在逻辑不清、段落过短、重复标题、过度加粗等风格问题；
6) 请尽量给出具体、可执行的建议。
    `.trim();

    const aiChatState = {
        history: [{ role: 'system', content: AI_CHAT_SYSTEM_PROMPT }],
        lastEditorText: '',
        lastAiCheckSummary: '',
        aiCheckSummaryInjected: false
    };

    function createAiCheckSummary(aiResults) {
        if (!Array.isArray(aiResults) || aiResults.length === 0) return '';
        const lines = aiResults.slice(0, 6).map((item, index) => {
            const type = (item.type || '').trim();
            const msg = (item.message || '').replace(/\s+/g, ' ').trim();
            const hint = item.highlight ? ` [${item.highlight}]` : '';
            return `${index + 1}. ${type} ${msg}${hint}`;
        }).filter(Boolean);
        if (!lines.length) return '';
        return `以下是之前 AI 格式检查结果，供本次聊天参考：\n${lines.join('\n')}\n\n`;
    }

    function getStoredApiKey() {
        let key = GM_getValue('luogu_ai_api_key', '');
        if (!key && BUILTIN_API_KEY.trim()) {
            key = BUILTIN_API_KEY.trim();
            GM_setValue('luogu_ai_api_key', key);
        }
        return key;
    }

    function stripCodeBlocks(text) {
        let result = text.replace(/```[\s\S]*?```/g, ' ');
        result = result.replace(/^( {4}|\t).*$/gm, ' ');
        result = result.replace(/`[^`]*`/g, ' ');
        return result;
    }

    function removeLastCodeBlock(text) {
        if (typeof text !== 'string' || !text.trim()) return text;
        const matches = [...text.matchAll(/```[\s\S]*?```/g)];
        if (!matches.length) return text;

        const lastMatch = matches[matches.length - 1];
        const before = text.slice(0, lastMatch.index).replace(/\s*$/, '');
        const after = text.slice(lastMatch.index + lastMatch[0].length);
        return `${before}${after}`.replace(/\n{3,}/g, '\n\n').trim();
    }

    function extractFormulas(text) {
        const regex = /\$\$[\s\S]*?\$\$|\$[^$\n]+\$/g;
        const matches = text.match(regex);
        return matches || [];
    }

    function extractCodeBlocks(text) {
        const regex = /```[\s\S]*?```/g;
        const matches = text.match(regex);
        return matches || [];
    }

    function getEditorContent() {
        // 1. 优先匹配 contenteditable（洛谷当前编辑器）
        let el = document.querySelector('[contenteditable="true"]');
        if (el) {
            const text = el.innerText || el.textContent || '';
            if (text.trim()) return text;
        }

        // 2. 再尝试 textarea
        el = document.querySelector('textarea[name="content"], textarea#content, textarea');
        if (el && el.value) return el.value;

        // 3. 再尝试 CodeMirror
        el = document.querySelector('.CodeMirror textarea');
        if (el && el.value) return el.value;

        // 4. 再尝试 ProseMirror
        el = document.querySelector('.ProseMirror');
        if (el) return el.innerText || el.textContent || '';

        // 5. 最后兜底：所有可见 textarea 中取内容最长的
        const allTextareas = document.querySelectorAll('textarea:not([hidden])');
        let best = '';
        for (let ta of allTextareas) {
            if (ta.value && ta.value.length > best.length) {
                best = ta.value;
            }
        }
        if (best) return best;

        return '';
    }

    function getTitle() {
        const titleInput = document.querySelector('input[name=title], input#title, input[placeholder*="标题"], input[type="text"]');
        if (titleInput && titleInput.value) return titleInput.value.trim();
        const titleElement = document.querySelector('.title-input, .article-title, input.title');
        if (titleElement) return (titleElement.value || titleElement.textContent || '').trim();
        return document.title || '';
    }

    function annotateIssues(issues) {
        showResultPanel(issues);
    }

    function checkRequiredSections(text, isTemplate) {
        const results = [];
        const lower = text.toLowerCase();
        if (isTemplate) {
            if (!/算法介绍|算法分析|解法介绍/.test(lower)) {
                results.push({
                    type: RESULT_TYPE.HARD,
                    message: '模板题应包含“算法介绍”章节，建议添加算法思路与核心实现思路。'
                });
            }
            if (!/正确性证明|正确性分析|证明/.test(lower)) {
                results.push({
                    type: RESULT_TYPE.HARD,
                    message: '模板题应包含“正确性证明”章节，建议补充说明解法为何正确。'
                });
            }
            if (!/复杂度分析|时间复杂度|空间复杂度/.test(lower)) {
                results.push({
                    type: RESULT_TYPE.INFO,
                    message: '模板题建议包含“复杂度分析”章节，说明时间复杂度和空间复杂度。'
                });
            }
        } else {
            if (!/解题思路|思路分析|题解思路/.test(lower)) {
                results.push({
                    type: RESULT_TYPE.HARD,
                    message: '普通题目应包含“解题思路”章节，建议补充主要思路与关键步骤。'
                });
            }
            if (!/题意简述|题意描述|题意/.test(lower)) {
                results.push({
                    type: RESULT_TYPE.INFO,
                    message: '建议添加“题意简述”章节，避免直接完整复制题面。'
                });
            }
            if (!/代码实现|代码|实现|示例代码/.test(lower)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '建议包含“代码实现”内容，方便审核时确认解法可复现。'
                });
            }
        }
        return results;
    }

    function checkIrrelevantContent(text) {
        const results = [];
        for (const phrase of COMMON_IRRELEVANT) {
            if (new RegExp(phrase, 'i').test(text)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: `检测到无关内容“${phrase}”，建议删除与题解无关的闲聊与求赞内容。`,
                    highlight: phrase
                });
            }
        }
        const match = text.match(/求赞|求收藏|求管理员/gi);
        if (match && match.length >= 1) {
            results.push({
                type: RESULT_TYPE.HARD,
                message: '题解不应出现求赞、求管理员通过等内容，建议删除。',

                highlight: match[0]
            });
        }
        return results;
    }

    function checkHeadings(text) {
        const results = [];
        const lines = text.split('\n');
        let prevLevel = 0;
        let sameLevelCount = 0;
        let lastLevel = 0;
        let h2Count = 0;
        let h2AllowedCount = 0;
        let prevTitle = '';

        // 如果全文只有一个 H1，则不对一级标题进行任何报错或计数
        const h1Matches = text.match(/^\s*#\s+.+$/gm) || [];
        const h1Count = h1Matches.length;
        let seenFirstH1 = false;

        const allowedH2 = [
            '解题思路', '题意简述', '题意描述', '题意',
            '代码实现', '示例代码', '解法1', '解法2',
            '算法介绍', '算法分析', '算法简介',
            '正确性证明', '正确性分析', '证明',
            '复杂度分析', '时间复杂度', '空间复杂度', '复杂度',
        ];

        // 若二级标题包含白名单关键词（如 "解题思路(简单版)"）也应视为白名单
        function isAllowedH2(title) {
            if (!title) return false;
            const normalize = s => (s || '').toString().toLowerCase()
                // 去掉常见的分隔符、括号与标点，便于包含匹配
                .replace(/[\s\-\u2013\u2014()（）\[\]【】:：.。,，;；!！?？'"]/g, '')
                // 保留中文、字母与数字，其它字符移除
                .replace(/[^\w\u4e00-\u9fff]/g, '');
            const t = normalize(title);
            return allowedH2.some(k => {
                const kk = normalize(k);
                if (!kk) return false;
                return t.includes(kk);
            });
        }

        for (const line of lines) {
            const match = line.match(/^(#{1,6})\s*(.+)$/);
            if (!match) continue;

            const level = match[1].length;
            const title = match[2].trim();

            // 忽略第一个出现的一级标题；若全文仅有一个 H1 则完全忽略该 H1（不报错、不影响计数）
            if (level === 1) {
                if (h1Count === 1) {
                    // 将其视为已处理，但不作为后续层级跳跃检查的“异常来源"
                    seenFirstH1 = true;
                    prevLevel = 1;
                    lastLevel = 1;
                    sameLevelCount = 1;
                    prevTitle = title;
                    continue;
                }
                if (!seenFirstH1) {
                    seenFirstH1 = true;
                    continue;
                }
                prevLevel = level;
                lastLevel = level;
                sameLevelCount = 1;
                prevTitle = title;
                continue;
            }

            // 二级及更深标题常规检查
            if (title.length < 2) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: `标题“${title}”过短，不建议少于 2 个汉字。`,
                    highlight: title
                });
            }
            if (/[。．！？：:]$/.test(title)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: `标题“${title}”末尾不应加句号或冒号。`,
                    highlight: title
                });
            }

            if (level === 2) {
                h2Count += 1;
                if (isAllowedH2(title)) h2AllowedCount += 1;
            }

            // 标题层级跳跃检查：允许从一级开始，且当上级为符合规则或白名单的二级时允许出现更深层级
            if (prevLevel !== 0 && level > prevLevel + 1) {
                const prevIsTopLevel = prevLevel === 1;
                const prevIsValidH2 = prevLevel === 2 && prevTitle && (isAllowedH2(prevTitle) || (prevTitle.length >= 2 && !/[。．！？：:]$/.test(prevTitle)));
                if (!(prevIsTopLevel || prevIsValidH2)) {
                    results.push({
                        type: RESULT_TYPE.SUGGEST,
                        message: `标题层级不能跳跃：从 ${'#'.repeat(prevLevel)} 到 ${'#'.repeat(level)}。`,
                        highlight: line.trim()
                    });
                }
            }

            // 连续相同层级计数：当当前是白名单二级标题时不计入重复出现次数
            if (level === lastLevel) {
                if (!(level === 2 && isAllowedH2(title))) {
                    sameLevelCount += 1;
                } else {
                    // 不把白名单二级标题视为“重复出现"
                    sameLevelCount = 1;
                }
            } else {
                sameLevelCount = 1;
            }
            if (sameLevelCount > 2) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: `连续出现超过 2 个相同层级标题，可能过度使用标题格式。`,
                    highlight: line.trim()
                });
            }

            prevLevel = level;
            lastLevel = level;
            prevTitle = title;
        }

        // 只有排除白名单后的二级标题过多才提示
        const h2NonAllowed = Math.max(0, h2Count - h2AllowedCount);
        if (h2NonAllowed > 5) {
            results.push({
                type: RESULT_TYPE.SUGGEST,
                message: `二级标题数量已超过 5 个（排除常见应包含章节），建议控制在 2-4 个左右。`
            });
        }

        // 检测行内错误使用 #（不是以 # 开头的标题），保持对单个 H1 的兼容
        const misuse = text.match(/^(?!\s*#).*#.*$/m);
        if (misuse) {
            results.push({
                type: RESULT_TYPE.SUGGEST,
                message: '标题应以 #、##、###、#### 等形式书写，避免将 # 用作强调。',

                highlight: misuse[0]
            });
        }

        return results;
    }

    function checkBold(text) {
        const results = [];
        const boldMatches = [...text.matchAll(/\*\*(.+?)\*\*/gs)];
        for (const match of boldMatches) {
            const content = match[1];
            if (content.length > 50) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '检测到大段加粗内容，建议不要大片使用加粗格式。',

                    highlight: match[0]
                });
                break;
            }
        }
        if (boldMatches.length > 10) {
            results.push({
                type: RESULT_TYPE.SUGGEST,
                message: '加粗次数较多，建议仅对重点内容进行适度强调。'
            });
        }
        return results;
    }

    function checkLists(text) {
        const results = [];
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const match = line.match(/^(\s*[-+*]|\s*\d+\.)\s?(.*)$/);
            if (match) {
                if (!/^(\s*[-+*]|\s*\d+\.)\s/.test(line)) {
                    results.push({
                        type: RESULT_TYPE.SUGGEST,
                        message: `列表项“${line.trim()}”后应保留一个空格。`,
                        highlight: line.trim()
                    });
                }
                const nextLine = lines[i + 1] || '';
                if (/^#{1,6}\s/.test(nextLine)) {
                    results.push({
                        type: RESULT_TYPE.SUGGEST,
                        message: '列表后接标题时建议在中间留一个空行。',

                        highlight: line.trim()
                    });
                }
                if (/^`/.test(nextLine) || /^```/.test(nextLine)) {
                    results.push({
                        type: RESULT_TYPE.SUGGEST,
                        message: '列表后接代码块时建议在中间留一个空行。',

                        highlight: line.trim()
                    });
                }
            }
        }
        return results;
    }

    function checkPunctuation(text) {
        text = text.replace(/&nbsp;/g, ' ');// 新增
        const results = [];

        // 1. 半角逗号
        const commaMatch = text.match(/[\u4e00-\u9fff],[\u4e00-\u9fff]|[\u4e00-\u9fff],|,[\u4e00-\u9fff]/);
        if (commaMatch) {
            results.push({
                type: RESULT_TYPE.SUGGEST,
                message: '检测到中文上下文中使用半角逗号，建议改为中文全角逗号“，”。',
                highlight: commaMatch[0]
            });
        }

        // 2. 半角句号
        const dotMatch = text.match(/[\u4e00-\u9fff]\.[\u4e00-\u9fff]|[\u4e00-\u9fff]\.|\\.[\u4e00-\u9fff]/);
        if (dotMatch) {
            results.push({
                type: RESULT_TYPE.SUGGEST,
                message: '检测到中文上下文中使用半角句号，建议改为中文全角句号“。”。',
                highlight: dotMatch[0]
            });
        }

        // 3. 全角空格
        const fullWidthMatch = text.match(/　/);
        if (fullWidthMatch) {
            results.push({
                type: RESULT_TYPE.SUGGEST,
                message: '检测到全角空格，建议改为半角空格。',

                highlight: fullWidthMatch[0]
            });
        }

        // 4. 全角字母数字
        const fullWidthCharMatch = text.match(/[Ａ-Ｚａ-ｚ０-９]/);
        if (fullWidthCharMatch) {
            results.push({
                type: RESULT_TYPE.SUGGEST,
                message: '检测到全角英文字母或数字，建议改为半角。',

                highlight: fullWidthCharMatch[0]
            });
        }

        // 5. 英文冒号
        const colonMatch = text.match(/[\u4e00-\u9fff]:[\u4e00-\u9fff]|[\u4e00-\u9fff]:|:[\u4e00-\u9fff]/);
        if (colonMatch) {
            results.push({
                type: RESULT_TYPE.SUGGEST,
                message: '检测到中文上下文中使用英文冒号，建议改为中文全角冒号“：”。',
                highlight: colonMatch[0]
            });
        }

        // 6. 英文分号
        const semicolonMatch = text.match(/[\u4e00-\u9fff];[\u4e00-\u9fff]|[\u4e00-\u9fff];|;[\u4e00-\u9fff]/);
        if (semicolonMatch) {
            results.push({
                type: RESULT_TYPE.SUGGEST,
                message: '检测到中文上下文中使用英文分号，建议改为中文全角分号“；”。',
                highlight: semicolonMatch[0]
            });
        }

        // 7. 英文双引号
        const doubleQuoteMatch = text.match(/[\u4e00-\u9fff]"[^"]*"[\u4e00-\u9fff]|[\u4e00-\u9fff]"|"[\u4e00-\u9fff]/);
        if (doubleQuoteMatch) {
            results.push({
                type: RESULT_TYPE.SUGGEST,
                message: '检测到中文上下文中使用英文双引号，建议改为中文双引号“ ”（即 “内容” ）。',

                highlight: doubleQuoteMatch[0]
            });
        }

        // 8. 英文单引号
        const singleQuoteMatch = text.match(/[\u4e00-\u9fff]'[^']*'[\u4e00-\u9fff]|[\u4e00-\u9fff]'|'[\u4e00-\u9fff]/);
        if (singleQuoteMatch) {
            results.push({
                type: RESULT_TYPE.SUGGEST,
                message: '检测到中文上下文中使用英文单引号，建议改为中文单引号‘ ’（即 ‘内容’ ）。',

                highlight: singleQuoteMatch[0]
            });
        }

        // 9. 中文句子末尾标点检查（跳过标题、列表、代码行等）
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();
            if (!line) continue;
            // 跳过包含代码特征的行（如 //、/*、#include、变量声明等）
            if (/\/\/|\/\*|\*\/|#include|int |long |double |char |bool |const /.test(line)) continue;
            if (/^```/.test(line) || /^ {4,}/.test(line) || /^\t/.test(line)) continue;
            if (/^#+ /.test(line)) continue;
            if (/^\$\$/.test(line) || /^\$.+\$$/.test(line)) continue;
            if (/^[-+*]\s/.test(line) || /^\d+\.\s/.test(line)) continue;
            if (/^\[.+?\]\(.+?\)$/.test(line)) continue;
            if (/^!\[.*?\]\(.+?\)$/.test(line)) continue;
            line = line.replace(/^(&nbsp;)+/, '');
            if (line.length < 5) continue;
            const hasChinese = /[\u4e00-\u9fff]/.test(line);
            if (hasChinese) {
                const lastChar = line.slice(-1);
                if (/[。！？]$/.test(line)) {
                    // 正确
                } else if (/[.!?]$/.test(line)) {
                    let suggest = '';
                    if (lastChar === '.') suggest = '“。”';
                    else if (lastChar === '!') suggest = '“！”';
                    else if (lastChar === '?') suggest = '“？”';
                    results.push({
                        type: RESULT_TYPE.SUGGEST,
                        message: `中文句子末尾建议使用中文标点${suggest}，避免使用英文标点“${lastChar}”。`,
                        highlight: line.slice(-10)
                    });
                } else {
                    if (!/[：:；;]$/.test(line)) {
                        results.push({
                            type: RESULT_TYPE.SUGGEST,
                            message: '中文句子末尾缺少句号，建议添加“。”。',
                            highlight: line.slice(-20)
                        });
                    }
                }
            }
        }

        return results;
    }

    function checkSpacing(text) {
        const results = [];
        const match = text.match(/[\u4e00-\u9fff](?=[A-Za-z0-9`])|(?<=[A-Za-z0-9`])[\u4e00-\u9fff]/);
        if (match) {
            results.push({
                type: RESULT_TYPE.SUGGEST,
                message: '中文与英文、数字之间建议使用半角空格分隔。',

                highlight: match[0]
            });
        }
        return results;
    }

    function checkOperators(text) {
        const results = [];
        const formulas = extractFormulas(text);
        for (const formula of formulas) {
            for (const key in OPERATOR_MAP) {
                const regex = new RegExp(`\\b${key}\\b`, 'g');
                if (regex.test(formula) && !new RegExp(`\\\\${key}\\b`).test(formula) && !/\\operatorname\{/.test(formula)) {
                    results.push({
                        type: RESULT_TYPE.HARD,
                        message: `公式中检测到“${key}”，建议改为“${OPERATOR_MAP[key]}”。`,
                        highlight: key
                    });
                }
            }
            if (/\bmod\b/.test(formula) && !/\\bmod/.test(formula) && !/\\pmod/.test(formula) && !/\\operatorname/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.HARD,
                    message: '取模运算应使用 \\bmod，例如 $a \\bmod b = c$。',

                    highlight: 'mod'
                });
            }
            // 2) 检测 \mod（带空格）建议改用 \bmod
            if (/\\mod\b/.test(formula) && !/\\bmod/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '取模运算建议使用 \\bmod 而非 \\mod。',

                    highlight: '\\mod'
                });
            }
            // 3) 检测同余符号 ≡
            if (/≡/.test(formula) && !/\\equiv/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '同余符号应使用 \\equiv，避免使用 Unicode ≡。',

                    highlight: '≡'
                });
            }
            // 4) 检测 \pmod 是否缺少（若有 ≡ 但无 \pmod，提示）
            if (/≡/.test(formula) && !/\\pmod/.test(formula) && !/\\equiv/.test(formula)) {
                // 已经提示 ≡ 了，不用重复，但可额外提示使用 \pmod
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '同余应使用 \\pmod{...} 表示模数，例如 $a \\equiv c \\pmod b$。',

                    highlight: '≡'
                });
            }
            // 5) 检测 (mod 写法，如 a ≡ c (mod b) 建议改为 \pmod
            if (/\(mod\b/.test(formula) && !/\\pmod/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '同余模数应使用 \\pmod{...}，避免使用 "(mod ...)"。',

                    highlight: '(mod'
                });
            }
        }
        return results;
    }

    function checkProperNouns(text) {
        const results = [];
        const formulas = extractFormulas(text);
        for (const formula of formulas) {
            for (const noun of SPECIFIC_PROPER_NOUNS) {
                if (new RegExp(`\\b${noun}\\b`, 'i').test(formula)) {
                    results.push({
                        type: RESULT_TYPE.SUGGEST,
                        message: `公式中检测到专有名词“${noun}”，建议移出公式或使用 \\text{${noun}} 包裹。`,
                        highlight: noun
                    });
                }
            }
        }
        return results;
    }

    function checkMathSymbols(text) {
        const results = [];
        const formulas = extractFormulas(text);

        for (const formula of formulas) {
            // 现有检查保留
            // 检测公式中是否出现大写数集字母但未使用 \mathbb{}
            const setLetters = ['N', 'Z', 'Q', 'R', 'C'];
            let hasIssue = false;
            for (const letter of setLetters) {
                const regex = new RegExp(`\\b${letter}\\b`, 'g');
                if (regex.test(formula) && !new RegExp(`\\\\mathbb\\{${letter}\\}`).test(formula)) {
                    const match = formula.match(new RegExp(`\\b${letter}\\b`));
                    if (match) {
                        const idx = match.index;
                        const before = formula.slice(0, idx);
                        if (new RegExp(`\\\\operatorname\\{${letter}\\}`).test(formula)) continue;
                        if (new RegExp(`\\\\mathrm\\{${letter}\\}`).test(formula)) continue;
                        if (new RegExp(`\\\\text\\{${letter}\\}`).test(formula)) continue;
                        hasIssue = true;
                        break;
                    }
                }
            }
            if (hasIssue) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '数集符号（如 N、Z、Q、R、C）应使用 \\mathbb{} 表示，例如 \\mathbb{N}。请检查公式中的数集字母。',

                    highlight: formula
                });
            }
            if (/\*/.test(formula) && !/\\times/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '公式中的乘号建议使用 \\times 而不是 *。',

                    highlight: '*'
                });
            }
            if (/<=(?!\\le)/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '公式中建议使用 \\le 代替 <=。',

                    highlight: '<='
                });
            }
            if (/>=(?!\\ge)/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '公式中建议使用 \\ge 代替 >=。',

                    highlight: '>='
                });
            }
            if (/[^\\]\\~/.test(formula) || /(?<!\\)~/.test(formula)) {
                if (!/\\sim/.test(formula)) {
                    results.push({
                        type: RESULT_TYPE.SUGGEST,
                        message: '波浪线建议使用 \\sim。',

                        highlight: '~'
                    });
                }
            }

            // 新增更全面的运算符与符号建议检查
            // 1) +- 或 +/-
            if (/\+\-/.test(formula) || /\+\/-/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '请使用 \\pm 表示正负号，例如 $\\pm$，避免写成 "+-" 或 "+/-"。',

                    highlight: formula.match(/\+\-|\+\/-/)[0]
                });
            }
            // 2) 非转义竖线 |（建议用 \mid / \vert / \mid 表示整除或条件分隔）
            if (/(^|[^\\])\|/.test(formula) && !/\\mid|\\vert|\\lvert|\\rvert/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '竖线建议使用 \\mid/\\vert 等 LaTeX 命令（视语境表示整除或条件），避免直接使用 |。',

                    highlight: '|'
                });
            }
            // 3) · 或 ⋅ 建议用 \cdot
            if (/[·⋅]/.test(formula) && !/\\cdot/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '点乘建议使用 \\cdot，例如 $\\cdot$。',

                    highlight: formula.match(/[·⋅]/)[0]
                });
            }
            // 4) 数字间用 x 作为乘号（如 3 x 4）建议用 \\times
            if (/\b[a-zA-Z]\s*x\s*[a-zA-Z]\b/.test(formula) && !/\\times/.test(formula)) {
                const matched = formula.match(/\b[a-zA-Z]\s*x\s*[a-zA-Z]\b/)[0];
                // 如果这个片段包含 xor、max、min 等，跳过
                const combined = matched.replace(/\s/g, '').toLowerCase();
                if (!/(xor|max|min|and|or)/.test(combined)) {
                    results.push({
                        type: RESULT_TYPE.SUGGEST,
                        message: '字母间的乘号建议使用 \\times 而不是 x。',

                        highlight: 'x'
                    });
                }
            }
            // 5) != 建议使用 \ne
            if (/!=/.test(formula) && !/\\ne/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '不等号建议使用 \\ne，避免使用 !=。',

                    highlight: '!='
                });
            }
            // 6) 连续三个点 ... 建议使用 \ldots
            if (/\.{3,}/.test(formula) && !/\\ldots/.test(formula)) {
                const dots = formula.match(/\.{3,}/)[0];
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '省略号建议使用 \\ldots 而非连续英文句点。',

                    highlight: dots
                });
            }
            // 7) 简单分式形式 a/b（复杂表达建议用 \\frac）
            if (/[A-Za-z0-9\)\]\}]\s*\/\s*[A-Za-z0-9\(\[\{]/.test(formula) && !/\\frac\{/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '复杂分式建议使用 \\frac{...}{...} 提高可读性，简单 a/b 可视情况保留。',

                    highlight: '/'
                });
            }
            // 检查 Unicode 不等号 ≠
            if (/≠/.test(formula) && !/\\ne/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '不等号建议使用 \\ne，避免使用 Unicode 字符 ≠。',

                    highlight: '≠'
                });
            }

            // 检查 Unicode 小于等于 ≤
            if (/≤/.test(formula) && !/\\le/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '小于等于建议使用 \\le，避免使用 Unicode 字符 ≤。',

                    highlight: '≤'
                });
            }

            // 检查 Unicode 大于等于 ≥
            if (/≥/.test(formula) && !/\\ge/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '大于等于建议使用 \\ge，避免使用 Unicode 字符 ≥。',

                    highlight: '≥'
                });
            }
            // --- 集合运算符号的 Unicode 检查 ---
            // ∈
            if (/∈/.test(formula) && !/\\in/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '属于符号建议使用 \\in，避免使用 Unicode ∈。',

                    highlight: '∈'
                });
            }
            // ∉
            if (/∉/.test(formula) && !/\\notin/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '不包含于符号建议使用 \\notin，避免使用 Unicode ∉。',

                    highlight: '∉'
                });
            }
            // ⊆
            if (/⊆/.test(formula) && !/\\subseteq/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '子集符号建议使用 \\subseteq，避免使用 Unicode ⊆。',

                    highlight: '⊆'
                });
            }
            // ⊂
            if (/⊂/.test(formula) && !/\\subset/.test(formula) && !/\\subseteq/.test(formula)) {
                // 注意 ⊂ 可能被用作真子集或子集，根据上下文建议 \subset 或 \subseteq
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '子集符号建议使用 \\subset 或 \\subseteq，避免使用 Unicode ⊂。',

                    highlight: '⊂'
                });
            }
            // ⊊
            if (/⊊/.test(formula) && !/\\subsetneq/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '真子集符号建议使用 \\subsetneq，避免使用 Unicode ⊊。',

                    highlight: '⊊'
                });
            }
            // ∪
            if (/∪/.test(formula) && !/\\cup/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '并集符号建议使用 \\cup，避免使用 Unicode ∪。',

                    highlight: '∪'
                });
            }
            // ∩
            if (/∩/.test(formula) && !/\\cap/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '交集符号建议使用 \\cap，避免使用 Unicode ∩。',

                    highlight: '∩'
                });
            }
            // ========== 统一处理所有 Unicode 数学符号 ==========

            // 1. 赋值与箭头
            if (/←/.test(formula) && !/\\gets|\\leftarrow/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '赋值符号建议使用 \\gets 或 \\leftarrow，避免使用 Unicode ←。',

                    highlight: '←'
                });
            }
            if (/→/.test(formula) && !/\\to|\\rightarrow/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '箭头建议使用 \\to 或 \\rightarrow，避免使用 Unicode →。',

                    highlight: '→'
                });
            }
            if (/∀/.test(formula) && !/\\forall/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '全称量词建议使用 \\forall，避免使用 Unicode ∀。',

                    highlight: '∀'
                });
            }
            if (/∃/.test(formula) && !/\\exists/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '存在量词建议使用 \\exists，避免使用 Unicode ∃。',

                    highlight: '∃'
                });
            }

            // 2. 逻辑符号
            if (/¬/.test(formula) && !/\\neg|\\lnot/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '逻辑非建议使用 \\neg 或 \\lnot，避免使用 Unicode ¬。',

                    highlight: '¬'
                });
            }
            if (/∧/.test(formula) && !/\\wedge|\\land/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '逻辑与建议使用 \\wedge 或 \\land，避免使用 Unicode ∧。',

                    highlight: '∧'
                });
            }
            if (/∨/.test(formula) && !/\\vee|\\lor/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '逻辑或建议使用 \\vee 或 \\lor，避免使用 Unicode ∨。',

                    highlight: '∨'
                });
            }
            if (/⊕/.test(formula) && !/\\oplus/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '异或建议使用 \\oplus，避免使用 Unicode ⊕。',

                    highlight: '⊕'
                });
            }

            // 3. 关系与集合（补充已有检查）
            if (/⊆/.test(formula) && !/\\subseteq/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '子集符号建议使用 \\subseteq，避免使用 Unicode ⊆。',

                    highlight: '⊆'
                });
            }
            if (/⊊/.test(formula) && !/\\subsetneq/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '真子集符号建议使用 \\subsetneq，避免使用 Unicode ⊊。',

                    highlight: '⊊'
                });
            }
            // ⊂ 可能被误用，给出通用建议
            if (/⊂/.test(formula) && !/\\subset/.test(formula) && !/\\subseteq/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '子集符号建议使用 \\subset 或 \\subseteq，避免使用 Unicode ⊂。',

                    highlight: '⊂'
                });
            }
            // ∪ 和 ∩ 已有检查，但再保一遍
            if (/∪/.test(formula) && !/\\cup/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '并集符号建议使用 \\cup，避免使用 Unicode ∪。',

                    highlight: '∪'
                });
            }
            if (/∩/.test(formula) && !/\\cap/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '交集符号建议使用 \\cap，避免使用 Unicode ∩。',

                    highlight: '∩'
                });
            }

            // 4. 其他常用符号
            if (/∞/.test(formula) && !/\\infty/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '无穷符号建议使用 \\infty，避免使用 Unicode ∞。',

                    highlight: '∞'
                });
            }
            if (/±/.test(formula) && !/\\pm/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '正负号建议使用 \\pm，避免使用 Unicode ±。',

                    highlight: '±'
                });
            }
            if (/∓/.test(formula) && !/\\mp/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '负正号建议使用 \\mp，避免使用 Unicode ∓。',

                    highlight: '∓'
                });
            }
            if (/∠/.test(formula) && !/\\angle/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '角度符号建议使用 \\angle，避免使用 Unicode ∠。',

                    highlight: '∠'
                });
            }
            if (/∅/.test(formula) && !/\\emptyset|\\varnothing/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '空集建议使用 \\emptyset 或 \\varnothing，避免使用 Unicode ∅。',

                    highlight: '∅'
                });
            }
            if (/∵/.test(formula) && !/\\because/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '因为符号建议使用 \\because，避免使用 Unicode ∵。',

                    highlight: '∵'
                });
            }
            if (/∴/.test(formula) && !/\\therefore/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '所以符号建议使用 \\therefore，避免使用 Unicode ∴。',

                    highlight: '∴'
                });
            }
            // 定义符号 := 或 =: 建议使用 \coloneqq 或 \eqqcolon
            if (/:=[^=]/.test(formula) && !/\\coloneqq/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '赋值定义建议使用 \\coloneqq (:=)，避免使用普通冒号等号。',

                    highlight: ':='
                });
            }
            // ========== 大型运算符 ==========
            // ∑ → \sum
            if (/∑/.test(formula) && !/\\sum/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '求和符号建议使用 \\sum，避免使用 Unicode ∑。',

                    highlight: '∑'
                });
            }
            // ∏ → \prod
            if (/∏/.test(formula) && !/\\prod/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '求积符号建议使用 \\prod，避免使用 Unicode ∏。',

                    highlight: '∏'
                });
            }
            // ⋃ → \bigcup
            if (/⋃/.test(formula) && !/\\bigcup/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '并集符号建议使用 \\bigcup，避免使用 Unicode ⋃。',

                    highlight: '⋃'
                });
            }
            // ⋂ → \bigcap
            if (/⋂/.test(formula) && !/\\bigcap/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '交集符号建议使用 \\bigcap，避免使用 Unicode ⋂。',

                    highlight: '⋂'
                });
            }
            // ⨁ → \bigoplus（异或求和）
            if (/⨁/.test(formula) && !/\\bigoplus/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '异或求和建议使用 \\bigoplus，避免使用 Unicode ⨁。',

                    highlight: '⨁'
                });
            }
            // ⨂ → \bigotimes（张量积）
            if (/⨂/.test(formula) && !/\\bigotimes/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '张量积符号建议使用 \\bigotimes，避免使用 Unicode ⨂。',

                    highlight: '⨂'
                });
            }
            // ⨆ → \bigsqcup（不相交并）
            if (/⨆/.test(formula) && !/\\bigsqcup/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '不相交并集建议使用 \\bigsqcup，避免使用 Unicode ⨆。',

                    highlight: '⨆'
                });
            }
            // --- 检查普通文本中的波浪号 ~ 和竖线 | ---
            // 跳过代码块，只在纯文本中检测
            const plainText = text.replace(/```[\s\S]*?```/g, ' ');
            // 检查 ~（不在公式中）
            if (/~/.test(plainText) && !/\$.*~.*\$/.test(plainText)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '检测到波浪号 ~，如果在公式中应使用 \\sim；在普通文本中建议改为中文连接号“至”或保留。',

                    highlight: '~'
                });
            }
            // 检查 |（不在公式中）
            if (/\|/.test(plainText) && !/\$.*\|.*\$/.test(plainText)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '检测到竖线 |，如果在公式中应使用 \\mid 或 \\vert；在普通文本中建议改为中文标点或保留。',

                    highlight: '|'
                });
            }
        }
        return results;
    }
    function checkFormulaCommonErrors(text) {
        const results = [];
        const formulas = extractFormulas(text);

        for (const formula of formulas) {
            // 省略号
            if (/\.{3}/.test(formula) && !/\\ldots/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '省略号建议使用 \\ldots 而非三个点。',

                    highlight: formula.match(/\.{3,}/)[0]
                });
            }
            // 乘号
            if (/\*/.test(formula) && !/\\times/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '乘号建议使用 \\times 而不是 *。',

                    highlight: '*'
                });
            }
            // 等号前后空格
            if (/[^ ]=[^ ]/.test(formula) && !/==/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.INFO,
                    message: '公式中的等号前后建议保留空格，例如 $a = b$。',

                    highlight: '='
                });
            }
            // 科学计数法
            if (/\d+e\d+/.test(formula) && !/\\times/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '科学计数法建议使用 \\times 10^{...}，例如 $5 \\times 10^9$。',

                    highlight: formula.match(/\d+e\d+/)[0]
                });
            }
            // 字母间 x 作为乘号
            // 避免误报字母间的 x（如 xor、max 等）
            if (/[0-9]\s*x\s*[0-9]/.test(formula) && !/\\times/.test(formula)) {
                // 数字 × 数字
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '数字间的乘号建议使用 \\times 而不是 x。',

                    highlight: formula.match(/[0-9]\s*x\s*[0-9]/)[0]
                });
            } else if (/[0-9]\s*x\s*[a-zA-Z]/.test(formula) && !/\\times/.test(formula)) {
                // 数字 × 字母
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '数字与字母间的乘号建议使用 \\times 而不是 x。',

                    highlight: formula.match(/[0-9]\s*x\s*[a-zA-Z]/)[0]
                });
            } else if (/[a-zA-Z]\s*x\s*[0-9]/.test(formula) && !/\\times/.test(formula)) {
                // 字母 × 数字
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '字母与数字间的乘号建议使用 \\times 而不是 x。',

                    highlight: formula.match(/[a-zA-Z]\s*x\s*[0-9]/)[0]
                });
            }
            // 字母 × 字母 的情况容易误报（如 xor），不再检测
        }

        return results;
    }

    function checkFormulaStyle(text) {
        const results = [];
        const formulas = extractFormulas(text);

        // 匹配拆分公式的常见模式：$...$ 运算符 $...$
        const splitPattern = /\$[^$]+\$\s*([+\-=>≤≥≠∈⊆⊂∪∩∧∨]|\b(?:le|ge|ne|in|subseteq|subset|cup|cap|land|lor)\b)\s*\$[^$]+\$/;
        // 同时检测连续多个 $...$ 但没有运算符的情况，也可能是拆分
        const multipleFormulas = /(\$[^$]+\$){2,}/;

        for (const formula of formulas) {
            if (splitPattern.test(formula) || multipleFormulas.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '建议将同一个数学表达式写在一个 LaTeX 公式环境内，不要拆成多个 $...$。',

                    highlight: formula
                });
                break;
            }
        }

        return results;
    }

    function checkMathEnvironment(text) {
        const results = [];
        const formulas = extractFormulas(text);

        for (const formula of formulas) {
            // 1) 连等式：检测是否包含多个 = 但未使用 aligned 或 split 环境
            const eqCount = (formula.match(/=/g) || []).length;
            if (eqCount >= 2 && !/\\begin\{aligned\}|\\begin\{split\}|\\begin\{align\}/.test(formula)) {
                // 排除那些本身就是一行多公式的情况（如 a=b, c=d），但一般不会出现在一个公式中
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '连等式建议使用 \\begin{aligned} ... \\end{aligned} 环境，将多行等式对齐。',

                    highlight: formula
                });
            }

            // 2) 分段函数：检测是否包含 \cases 或 \begin{cases} 但未使用
            // 检测是否有 \left\{ ... \right. 或 \begin{array} 但未用 cases
            if (/\\left\\\{/.test(formula) && /\\right\\./.test(formula) && !/\\begin\{cases\}/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '分段函数建议使用 \\begin{cases} ... \\end{cases} 环境，避免手动构造花括号。',

                    highlight: formula
                });
            }
            // 检测是否有 \begin{array} 但用于分段函数（通常 array 应改为 cases）
            if (/\\begin\{array\}/.test(formula) && /\\left\\\{/.test(formula) && !/\\begin\{cases\}/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '分段函数建议使用 \\begin{cases} 代替 \\begin{array}，更简洁规范。',

                    highlight: formula
                });
            }

            // 3) 矩阵：检测是否包含矩阵相关命令但未使用 bmatrix
            // 检测 \begin{pmatrix} 或 \begin{bmatrix} 等未用 bmatrix
            if (/\\begin\{pmatrix\}/.test(formula) && !/\\begin\{bmatrix\}/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '矩阵建议使用 \\begin{bmatrix} ... \\end{bmatrix} 环境，括号更美观。',

                    highlight: '\\begin{pmatrix}'
                });
            }
            // 检测 \begin{array} 但用于矩阵（应改为 bmatrix）
            if (/\\begin\{array\}/.test(formula) && /[()\[\]]/.test(formula) && !/\\begin\{bmatrix\}/.test(formula)) {
                // 简单判断：如果 array 前后有括号，且未用 bmatrix
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '矩阵建议使用 \\begin{bmatrix} ... \\end{bmatrix} 环境，避免手动构造括号。',

                    highlight: formula
                });
            }
            // 检测 \left[ \right] 包围的 array 但未用 bmatrix
            if (/\\left\[/.test(formula) && /\\begin\{array\}/.test(formula) && !/\\begin\{bmatrix\}/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '矩阵建议使用 \\begin{bmatrix} 环境，避免手动构造方括号。',

                    highlight: formula
                });
            }
        }

        return results;
    }

    function checkCodeStyle(text) {
        const results = [];
        const codeBlocks = extractCodeBlocks(text);
        for (const block of codeBlocks) {
            if (/(?:int|long|bool)\s+[a-zA-Z]{1,2}\b/.test(block) && /(\/\/|\/\*)/.test(block)) {
                results.push({
                    type: RESULT_TYPE.INFO,
                    message: '建议代码中使用有意义变量名和简洁注释，避免过度混淆。',

                    highlight: block.slice(0, 80)
                });
                break;
            }
            const antiMatch = block.match(/\/\/.*防抄袭|\/\*.*防抄袭/);
            if (antiMatch) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '检测到可能的防抄袭内容，建议删除无意义或混淆性的代码注释。',

                    highlight: antiMatch[0]
                });
            }
        }
        return results;
    }

    function extractBalancedJsonCandidate(text, startIndex) {
        if (typeof text !== 'string' || startIndex < 0 || startIndex >= text.length) return null;

        const stack = [];
        let inString = false;
        let escape = false;

        for (let i = startIndex; i < text.length; i++) {
            const ch = text[i];

            if (inString) {
                if (escape) {
                    escape = false;
                } else if (ch === '\\') {
                    escape = true;
                } else if (ch === '"') {
                    inString = false;
                }
                continue;
            }

            if (ch === '"') {
                inString = true;
            } else if (ch === '[' || ch === '{') {
                stack.push(ch);
            } else if (ch === ']' || ch === '}') {
                const open = stack.pop();
                if (!open || (open === '[' && ch !== ']') || (open === '{' && ch !== '}')) {
                    return null;
                }
                if (stack.length === 0) {
                    return text.slice(startIndex, i + 1).trim();
                }
            }
        }

        return null;
    }
    function safeJsonParse(str) {
        if (typeof str !== 'string') return null;

        // 先尝试直接解析
        try { return JSON.parse(str); } catch (e) { }

        // 1. 转义所有未转义的反斜杠（后面跟着字母的）
        let fixed = str.replace(/\\(?![\\"\/bfnrtu])/g, '\\\\');
        try { return JSON.parse(fixed); } catch (e) { }

        // 2. 转义控制字符
        fixed = fixed
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r')
            .replace(/\t/g, '\\t');
        try { return JSON.parse(fixed); } catch (e) { }

        // 3. 如果还失败，尝试把所有反斜杠双写（更暴力）
        let doubleEscaped = str.replace(/\\/g, '\\\\');
        try { return JSON.parse(doubleEscaped); } catch (e) { }

        // 4. 尝试修复尾随逗号
        let noTrailingComma = str.replace(/,\s*([}\]])/g, '$1');
        try { return JSON.parse(noTrailingComma); } catch (e) { }

        // 5. 尝试修复键名未加引号
        let quotedKeys = str.replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');
        try { return JSON.parse(quotedKeys); } catch (e) { }

        return null;
    }
    function extractAiJsonPayload(text) {
        if (typeof text !== 'string' || !text.trim()) return null;

        let cleaned = text
            .replace(/\u200B|\u200C|\u200D|\uFEFF/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '')
            .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
            .trim();

        // 1. 先尝试直接解析（原样）
        let result = safeJsonParse(cleaned);
        if (result !== null) return result;

        // 2. 提取 ```json ... ``` 或 ``` ... ```
        const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenced) {
            result = safeJsonParse(fenced[1].trim());
            if (result !== null) return result;
        }

        // 3. 提取第一个 JSON 数组或对象（去除前缀后缀）
        const jsonMatch = cleaned.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
        if (jsonMatch) {
            let jsonStr = jsonMatch[1]
                .replace(/,\s*}/g, '}').replace(/,\s*\]/g, ']')
                .replace(/(['"])?([a-zA-Z0-9_]+)(['"])?\s*:/g, '"$2":');
            result = safeJsonParse(jsonStr);
            if (result !== null) return result;
        }

        // 4. 暴力遍历所有候选 JSON
        const candidates = cleaned.match(/(\[[\s\S]*?\]|\{[\s\S]*?\})/g);
        if (candidates) {
            for (let c of candidates) {
                let fixed = c
                    .replace(/,\s*}/g, '}').replace(/,\s*\]/g, ']')
                    .replace(/(['"])?([a-zA-Z0-9_]+)(['"])?\s*:/g, '"$2":');
                result = safeJsonParse(fixed);
                if (result !== null) return result;
            }
        }

        // 5. 最后尝试：如果整个文本被包裹在 ```json 中但未正常闭合，尝试补全
        if (cleaned.includes('```json')) {
            const start = cleaned.indexOf('```json') + 7;
            const end = cleaned.indexOf('```', start);
            if (end !== -1) {
                const inner = cleaned.slice(start, end).trim();
                result = safeJsonParse(inner);
                if (result !== null) return result;
            }
        }

        return null;
    }

    function splitAiIssues(items) {
        const results = [];
        const normalizeIssue = (item) => {
            const obj = item || {};
            const typeRaw = (obj.type || obj.level || '').toString();
            let type = RESULT_TYPE.SUGGEST;
            const lower = (typeRaw || '').toLowerCase();

            if (/(🔴|硬性|hard|error|danger|严重)/.test(lower)) {
                const message = (obj.message || obj.content || obj.desc || '').toString();
                const hardSignal = /(求赞|求收藏|求管理员|管理员通过|明显不合格|完全没有|缺少.*(思路|代码|证明)|不完整|无法使用)/i.test(message);
                type = hardSignal ? RESULT_TYPE.HARD : RESULT_TYPE.SUGGEST;
            } else if (/(🔵|提示|info|notice)/.test(lower)) {
                type = RESULT_TYPE.INFO;
            } else if (/(🟡|建议|suggest|warning)/.test(lower)) {
                type = RESULT_TYPE.SUGGEST;
            }

            const message = (obj.message || obj.content || obj.desc || '').toString().trim();
            if (!message) return null;

            return {
                type,
                message,
                highlight: obj.highlight || obj.fragment || obj.loc || '',
                context: obj.context || obj.reason || '',
                rule: obj.rule || obj.category || ''
            };
        };

        (Array.isArray(items) ? items : []).forEach(item => {
            const base = normalizeIssue(item);
            if (!base) return;

            const text = base.message.trim();

            const bulletLines = text.split(/\n+/)
                .map(s => s.trim())
                .filter(Boolean)
                .filter(line => /^[-*•]\s+/.test(line) || /^\d+[.)]\s+/.test(line));

            if (bulletLines.length > 1) {
                bulletLines.forEach(line => {
                    const clean = line.replace(/^[-*•]\s*/, '').replace(/^\d+[.)]\s*/, '').trim();
                    if (clean) results.push({ ...base, message: clean });
                });
                return;
            }

            const semicolonParts = text
                .split(/[；;]/)
                .map(s => s.trim())
                .filter(Boolean);

            const hasChineseSentenceEnd = /[。！？]/.test(text);
            if (semicolonParts.length > 1 && semicolonParts.every(part => part.length >= 4 && part.length <= 80) && !hasChineseSentenceEnd) {
                semicolonParts.forEach(part => results.push({ ...base, message: part }));
                return;
            }

            results.push(base);
        });

        return dedupeIssues(results);
    }

    function showAiThinkingOverlay() {
        hideAiThinkingOverlay();
        const overlay = document.createElement('div');
        overlay.id = 'luogu-format-ai-progress';
        overlay.style.cssText = `
            position: fixed;
            right: 20px;
            bottom: 20px;
            z-index: 999999;
            width: 280px;
            max-width: calc(100vw - 40px);
            background: rgba(255,255,255,0.97);
            border: 1px solid rgba(0,0,0,0.08);
            border-radius: 12px;
            box-shadow: 0 10px 24px rgba(0,0,0,0.16);
            padding: 12px 14px;
            font-size: 13px;
            color: #222;
            user-select: none;
            pointer-events: none;
        `;

        overlay.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;">
                <span style="font-weight:600;">🤖 AI 检查中</span>
                <span id="luogu-format-ai-progress-text" style="color:#409eff;font-weight:600;">0%</span>
            </div>
            <div style="height:8px;background:#eef2f7;border-radius:999px;overflow:hidden;">
                <div id="luogu-format-ai-progress-bar" style="height:100%;width:0%;background:linear-gradient(90deg,#409eff,#67c23a);transition:width 0.25s ease,border-radius:999px;"></div>
            </div>
            <div id="luogu-format-ai-progress-meta" style="margin-top:8px;color:#666;font-size:12px;">预计耗时：60 秒</div>
        `;

        document.body.appendChild(overlay);

        const durationMs = 60 * 1000;
        const start = Date.now();
        const bar = overlay.querySelector('#luogu-format-ai-progress-bar');
        const text = overlay.querySelector('#luogu-format-ai-progress-text');
        const timer = setInterval(() => {
            const elapsed = Date.now() - start;
            const progress = Math.min(100, Math.round((elapsed / durationMs) * 100));
            if (bar) bar.style.width = progress + '%';
            if (text) text.textContent = progress + '%';
        }, 250);

        return { overlay, timer, bar, text };
    }

    function hideAiThinkingOverlay(ctrl) {
        const existing = ctrl && ctrl.overlay ? ctrl.overlay : document.getElementById('luogu-format-ai-progress');
        if (ctrl && ctrl.timer) clearInterval(ctrl.timer);
        if (existing && existing.parentNode) {
            existing.parentNode.removeChild(existing);
        }
    }

    function callAI(messages) {
        const apiKey = BUILTIN_API_KEY.trim();
        if (!apiKey) {
            return Promise.reject(new Error('未配置 API Key'));
        }

        let dataMessages;
        if (typeof messages === 'string') {
            dataMessages = [{ role: 'user', content: messages }];
        } else if (Array.isArray(messages)) {
            dataMessages = messages;
        } else {
            return Promise.reject(new Error('callAI: invalid message payload'));
        }

        return new Promise((resolve, reject) => {
            console.log('callAI: 请求发送（prompt 前5000字符）', (JSON.stringify(dataMessages) || '').slice(0, 5000));
            GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`
                },
                data: JSON.stringify({
                    model: 'glm-4-flash',
                    messages: dataMessages,
                    max_tokens: 2000
                }),
                timeout: 60000,
                onload(response) {
                    const raw = response.responseText || '';
                    console.log('callAI: status', response.status, 'raw', raw.slice(0, 300));

                    if (response.status < 200 || response.status >= 300) {
                        let msg = `HTTP ${response.status}`;
                        try {
                            const err = JSON.parse(raw);
                            if (err.error?.message) msg += ': ' + err.error.message;
                            else if (err.message) msg += ': ' + err.message;
                        } catch (e) {
                            msg += ': ' + raw.slice(0, 100);
                        }
                        reject(new Error(msg));
                        return;
                    }

                    let data;
                    try {
                        data = JSON.parse(raw);
                    } catch (e) {
                        reject(new Error('AI 返回内容不是有效 JSON: ' + raw.slice(0, 200)));
                        return;
                    }

                    const content = data?.choices?.[0]?.message?.content;
                    if (content) {
                        resolve(content);
                    } else {
                        reject(new Error('AI 返回数据缺少 choices 字段: ' + raw.slice(0, 200)));
                    }
                },
                onerror(err) {
                    console.error('callAI: 请求错误', err);
                    reject(err);
                },
                ontimeout() {
                    console.error('callAI: 请求超时');
                    reject(new Error('AI 请求超时'));
                }
            });
        });
    }

    function runAICheck(formulas, textContext) {
        formulas = Array.isArray(formulas) ? formulas : [];
        const CONTEXT_SNIPPET = (textContext || '')
            .replace(/\r\n?/g, '\n')

        const prompt = `
你是洛谷题解格式检查助手，目标是结合全文上下文与 LaTeX 公式给出更主观且有价值的建议。
请基于下面内容执行检查并返回 JSON 数组（严格的 JSON，不要额外文本）。数组元素为对象，字段：
- type: "🔴 硬性错误" 或 "🟡 建议修改" 或 "🔵 提示信息"
- message: 问题说明（尽量简短）
- highlight: 问题片段（便于高亮）
- context: 所在句子或段落（便于展示）
- rule: 可选，表明是哪条规则（例如 "heading-abuse", "operator-operator", "special-char"）

请检查（但不限于）：
1) 是否滥用标题行（例如大量无实际内容的 H2/H3、把段落拆成过多标题、章节层级跳跃、或使用标题行来强调与解题无关的内容），如果是，请指出相关标题片段并给出建议。注意：标题行是单独的一行，以 # 开头，内容仅限该行本身，不应包含后续段落。当你要为标题问题提供 highlight 和 context 时，**必须只提取该标题行的原文本（例如 "## 题意简述"），不允许包含下一行的任何内容。**另：标题行的功能是标明章节主题，不要求标题本身包含详细信息。如果标题行本身很简短（如“题意简述”、“代码实现”），这是**合理的、符合规范的写法**，不应因此建议“精简标题”或“扩充标题”。只有当标题行超过 20 个字符时，才可酌情建议精简。**特别地，标题行中如果包含冒号（如“题解：测试AI题解”），冒号后的内容属于标题的一部分，不应视为“内容过多”。请勿仅因标题包含冒号而建议精简。**
2) 检查公式中是否**直接写了未转义的函数名**（如单独出现 'lcm'、'mod'、'xor'、'and'、'or' 等，而没有被 '\\operatorname{}' 或 '\\mathrm{}' 包裹）。**注意：如果已经使用了 '\\operatorname{}' 或 '\\mathrm{}'，则视为正确，不需要建议修改。**
3) 是否在公式中直接写了英文专有名词、变量应该用斜体但写成普通文字，或出现特殊字符未用对应 LaTeX 命令（如 ~、| 等）。
4) 是否存在主观性的结构或风格问题（例如不当的标题拆分、重复的短标题、段落过短等），并给出建议与可定位片段。
5) 检查是否存在将专有名词（如人名 Catalan、Euler）、普通英文单词或缩写错误地写在 $...$ 公式中的情况。正确的做法是移出公式改为正文，而不是在公式中保留并修改字体。例如：$Catalan$ 应改为正文中的 Catalan（不加公式）。
6) 是否存在大量无关内容，如 '求管理员通过' 或 '蒟蒻的第一篇题解' 。
7) 检查题解的思路是否逻辑清晰，其推理是否严谨且无漏洞，你需检查其逻辑性并在出现逻辑漏洞时明确指出。
8) 是否在文本中出现了大量加粗（一般超出一句话），并请指出。
9) 检测 \\left 和 \\right 是否匹配（比如 \\left( 但没有对应的 \\right)，或者 \\{ 没有对应的 \\}  ）。
特别注意：
- 你只需要判断是否存在以上情况，其它的事情都不关你事。
- 不应出现两条相似的建议。
- 你要检查文本前后是否具有逻辑性，是否连贯以及是否通俗易懂。
- 你应当只注重代码的可读性，应忽略代码的结构和变量命名，特别的是，代码不是公式，不应去检查其格式。
- 公式列表仅作为上下文参考，不要把它们当成需要逐条检查的“待点评对象”。如果某个公式不在当前可定位上下文内，或者你无法确定它与前文的对应关系，请不要给出评价。
- 只有在确实存在明确、可验证的格式/LaTeX 规范问题时，才给出修改建议。不要误报、不要把普通变量、中文术语、常数、专有名词或不确定的写法强行改成 LaTeX 命令。
- 对函数名/操作符的修改建议要准确：只有当它们明确作为数学函数或运算符出现时，才建议使用 \\operatorname{}、\\mathrm{}、\\log 等；普通变量名或一般文字不应被误判。
- 对集合/数域的写法建议要准确：只有上下文明确是集合或数域时，才建议使用 \\mathbb{N}、\\mathbb{Z}、\\mathbb{R} 等。
- 如果没有足够依据，请返回空数组 '[]'，不要胡乱生成建议。
- 如果你要给出建议，请尽量让建议具体、可执行、且能对应到正文中的具体片段。
- 请不要随意使用硬性错误，只有文章结构严重错误或出现大量无关内容时才可以使用硬性错误，有关 LaTeX 公式正确性的用建议修改，代码建议使用提示信息。
- 请在返回内容中明确标注出现错误的位置。
- 如果全文过长，仅针对能定位到的问题返回片段；context 字段应为人类可阅读的句子/段落片段。
- 对每一条问题尽量提供 highlight 或 context 以便前端高亮显示。
- 你要保证 highlight 的长度小于 context 的长度。
- 请尽量把每条问题拆成更小的、可单独展示的条目；如果一个建议包含多个子问题，请拆成多条 JSON 对象，注意这些对象万万不能相同。
- 对于专有名词（如 Catalan、Euler）误入公式的情况，建议“移出公式改为正文”，而不是“改为斜体”或“改为正体”。
- 对于标题行相关的问题，highlight 和 context 字段必须严格限制在该标题行自身的文本范围内（即从 # 到该行结尾），不得包含该标题行之后任何段落的内容。如果标题行本身内容过短（少于 5 个字符），可以在 message 中说明，但 highlight 仍只取标题行本身。
- 标题行是独立的行，以 # 开头，即使多个标题行连续出现，也必须将它们视为单独的标题分别评估，不得合并。

以下是题目解说的上下文（供理解整体内容），你的任务是检查从这行以下的文本。请将下面内容按原始换行文本处理，不要把它压成一整段：

\`\`\`text
${CONTEXT_SNIPPET}
\`\`\`

以下是正文中已提取出的公式片段（供参考，这些公式本身已经是 LaTeX 格式，请勿重复检查这些片段，只把它们作为上下文来理解作者意图）：
${formulas.join('\n')}

请返回 JSON 数组，而且请**只返回** JSON 数组，**不要**添加任何解释文字、Markdown 标记或额外内容。
你的回复必须是一个合法的 JSON 数组，以 '[' 开头，以 ']' 结尾。
`.trim();

        return callAI(prompt)
            .then(response => {
                if (!response || typeof response !== 'string') {
                    console.warn('AI 回复为空');
                    return [{
                        type: RESULT_TYPE.INFO,
                        message: 'AI 未返回有效内容，请重试。',
                        highlight: '',
                        context: ''
                    }];
                }

                console.log('AI 原始回复:', response);

                let parsed = null;
                try {
                    parsed = JSON.parse(response);
                    console.log('直接解析成功', parsed);
                } catch (e) {
                    console.warn('直接解析失败，尝试 extractAiJsonPayload', e);
                    parsed = extractAiJsonPayload(response);
                    console.log('extractAiJsonPayload 结果', parsed);
                }

                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    parsed = [parsed];
                    console.log('已转换为数组:', parsed);
                }

                if (Array.isArray(parsed) && parsed.length > 0) {
                    const mapped = parsed
                        .filter(item => item.message && item.message.trim())
                        .map(item => ({
                            type: item.type || RESULT_TYPE.SUGGEST,
                            message: item.message.trim(),
                            highlight: item.highlight || '',
                            context: item.context || '',
                            rule: item.rule || ''
                        }))
                        .filter(item => {
                            const msg = item.message || '';
                            const hl = item.highlight || '';

                            // 1. 过滤：已用 \operatorname 但 AI 仍报“未转义”
                            if (/未转义/.test(msg) && /\\operatorname/.test(hl)) {
                                console.log('过滤AI误报：已用 \\operatorname 但AI仍报', hl);
                                return false;
                            }

                            // 2. 过滤：标题行被误判为“内容过多”
                            if (/标题行内容过多/.test(msg) && /^#+ /.test(hl)) {
                                console.log('过滤AI误报：标题行被误判为内容过多', hl);
                                return false;
                            }

                            // 3. 过滤：标题行被误判为“无关内容”
                            if (/无关内容/.test(msg) && /^#+ /.test(hl)) {
                                console.log('过滤AI误报：标题行被误判为无关内容', hl);
                                return false;
                            }

                            return true;
                        });

                    if (mapped.length > 0) {
                        console.log('AI 建议数量（过滤后）:', mapped.length);
                        return mapped;
                    }
                    return [{
                        type: RESULT_TYPE.INFO,
                        message: 'AI 返回了空建议（可能全被过滤），请查看控制台原始回复。',
                        highlight: '',
                        context: ''
                    }];
                }

                return [{
                    type: RESULT_TYPE.INFO,
                    message: 'AI 建议解析失败，请查看控制台原始回复。',
                    highlight: '',
                    context: ''
                }];
            })
    }

    let lastCheckedText = '';

    function getAiCheckEnabled() {
        try {
            const saved = GM_getValue('luogu_format_ai_enabled', null);
            if (saved === null || saved === undefined) return true;
            return saved === true || saved === 'true' || saved === 1 || saved === '1';
        } catch (e) {
            return true;
        }
    }

    function setAiCheckEnabled(enabled) {
        try {
            GM_setValue('luogu_format_ai_enabled', !!enabled);
        } catch (e) {
            // ignore
        }
    }

    function getAiChatEnabled() {
        try {
            const saved = GM_getValue('luogu_format_ai_chat_enabled', null);
            if (saved === null || saved === undefined) return false;
            return saved === true || saved === 'true' || saved === 1 || saved === '1';
        } catch (e) {
            return false;
        }
    }

    function setAiChatEnabled(enabled) {
        try {
            GM_setValue('luogu_format_ai_chat_enabled', !!enabled);
        } catch (e) {
            // ignore
        }
    }

    function updateAiChatButtonState() {
        const enabled = getAiChatEnabled();
        const existing = document.getElementById('luogu-ai-chat-button');
        if (existing) existing.remove();
        const panel = document.getElementById('luogu-ai-chat-panel');
        if (!enabled && panel) panel.remove();
        updateAiChatOpenButtonState();
    }

    function updateAiChatOpenButtonState() {
        const openBtn = document.getElementById('luogu-format-ai-chat-open');
        if (!openBtn) return;
        const enabled = getAiChatEnabled();
        openBtn.disabled = !enabled;
        openBtn.style.opacity = enabled ? '1' : '0.6';
        openBtn.style.cursor = enabled ? 'pointer' : 'not-allowed';
    }

    function escapeHtml(str) {
        return (str || '').toString()
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // 主渲染函数
    function renderAiChatBubbleContent(bubble, content) {
        if (!bubble) return;
        if (!content) {
            bubble.textContent = '';
            return;
        }

        try {
            var katex = window.katex || unsafeWindow?.katex;
            // 1. 先用 marked 解析 Markdown
            var html = window.marked.parse(content, { breaks: true });
            html = window.DOMPurify.sanitize(html);
            bubble.innerHTML = html;

            // 2. 手动处理 $$...$$（在 DOM 中查找并替换）
            var walker = document.createTreeWalker(
                bubble,
                NodeFilter.SHOW_TEXT,
                {
                    acceptNode: function(node) {
                        return node.nodeValue && node.nodeValue.includes('$$')
                            ? NodeFilter.FILTER_ACCEPT
                            : NodeFilter.FILTER_REJECT;
                    }
                }
            );
            var textNodes = [];
            while (walker.nextNode()) {
                textNodes.push(walker.currentNode);
            }

            for (var i = 0; i < textNodes.length; i++) {
                var node = textNodes[i];
                var text = node.nodeValue;
                var regex = /\$\$([\s\S]+?)\$\$/g;
                var fragment = document.createDocumentFragment();
                var lastIndex = 0;
                var match;

                while ((match = regex.exec(text)) !== null) {
                    if (match.index > lastIndex) {
                        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
                    }
                    var formula = match[1].replace(/^[\r\n]+|[\r\n]+$/g, '');
                    if (katex && typeof katex.renderToString === 'function') {
                        try {
                            var container = document.createElement('div');
                            container.style.textAlign = 'center';
                            container.style.margin = '8px 0';
                            container.innerHTML = katex.renderToString(formula, {
                                displayMode: true,
                                throwOnError: false
                            });
                            fragment.appendChild(container);
                        } catch (e) {
                            fragment.appendChild(document.createTextNode(match[0]));
                        }
                    } else {
                        fragment.appendChild(document.createTextNode(match[0]));
                    }
                    lastIndex = match.index + match[0].length;
                }
                if (lastIndex < text.length) {
                    fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
                }
                node.parentNode.replaceChild(fragment, node);
            }

            // 3. 用 auto-render 处理行内公式 $...$（如果可用）
            if (typeof renderMathInElement !== 'undefined') {
                window.renderMathInElement(bubble, {
                    delimiters: [
                        { left: '$', right: '$', display: false },
                        { left: '\\(', right: '\\)', display: false }
                    ],
                    throwOnError: false
                });
            }

        } catch (e) {
            console.warn('[渲染] 渲染失败，降级为纯文本', e);
            bubble.textContent = content;
        }
    }

    function renderSingleMessage(container) {
        if (!container) return;
        renderAiChatBubbleContent(container, container.textContent);
    }

    function renderAiChatMath(container) {
        renderSingleMessage(container);
    }

    function createAiChatButton() {
        const btn = document.createElement('button');
        btn.id = 'luogu-ai-chat-button';
        btn.title = 'AI 聊天';
        btn.innerText = '🗨';
        btn.style.position = 'fixed';
        btn.style.right = '20px';
        btn.style.bottom = '80px';
        btn.style.zIndex = '99999';
        btn.style.width = '44px';
        btn.style.height = '44px';
        btn.style.padding = '0';
        btn.style.display = 'flex';
        btn.style.alignItems = 'center';
        btn.style.justifyContent = 'center';
        btn.style.background = '#67c23a';
        btn.style.color = '#fff';
        btn.style.border = 'none';
        btn.style.borderRadius = '50%';
        btn.style.cursor = 'pointer';
        btn.style.boxShadow = '0 6px 18px rgba(0,0,0,0.18)';
        btn.style.fontSize = '18px';
        btn.style.userSelect = 'none';
        btn.addEventListener('click', function (ev) {
            ev.preventDefault();
            openAiChatPanel();
        });
        document.body.appendChild(btn);
    }

    function createAiChatPanel() {
        const panel = document.createElement('div');
        panel.id = 'luogu-ai-chat-panel';
        panel.style.cssText = `
            position: fixed;
            right: 20px;
            bottom: 140px;
            z-index: 999999;
            width: 340px;
            max-width: calc(100vw - 40px);
            height: 420px;
            background: #fff;
            border: 1px solid rgba(0,0,0,0.12);
            border-radius: 12px;
            box-shadow: 0 14px 40px rgba(0,0,0,0.18);
            display: flex;
            flex-direction: column;
            overflow: hidden;
            font-size: 13px;
        `;
        panel.innerHTML = `
            <div id="luogu-ai-chat-header" style="
                padding:10px 12px;
                background:#409eff;
                color:#fff;
                display:flex;
                align-items:center;
                justify-content:space-between;
                cursor:grab;
            ">
                <span style="font-weight:600;">AI 聊天</span>
                <button id="luogu-ai-chat-close" style="background:none;border:none;color:#fff;font-size:18px;cursor:pointer;padding:0;">×</button>
            </div>
            <div id="luogu-ai-chat-messages" style="
                flex:1;
                padding:10px;
                overflow-y:auto;
                background:#f7f8fa;
                color:#222;
            "></div>
            <div style="padding:10px;background:#fff;border-top:1px solid #ebeef5;">
                <textarea id="luogu-ai-chat-input" rows="3" placeholder="输入你的问题..." style="
                    width:100%;
                    resize:none;
                    border:1px solid #d9d9d9;
                    border-radius:8px;
                    padding:8px 10px;
                    font-size:13px;
                    box-sizing:border-box;
                "></textarea>
                <button id="luogu-ai-chat-send" style="margin-top:8px;width:100%;padding:8px 0;border:none;border-radius:8px;background:#409eff;color:#fff;cursor:pointer;font-size:13px;">发送</button>
            </div>
        `;
        document.body.appendChild(panel);

        panel.querySelector('#luogu-ai-chat-close').addEventListener('click', function (ev) {
            ev.stopPropagation();
            panel.style.display = 'none';
        });

        const input = panel.querySelector('#luogu-ai-chat-input');
        const sendButton = panel.querySelector('#luogu-ai-chat-send');
        const header = panel.querySelector('#luogu-ai-chat-header');

        function submitChat() {
            const value = input.value.trim();
            if (!value) return;
            sendAiChatMessage(value);
        }

        sendButton.addEventListener('click', submitChat);
        input.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter') {
                if (ev.ctrlKey) {
                    const start = input.selectionStart;
                    const end = input.selectionEnd;
                    const value = input.value;
                    input.value = value.slice(0, start) + '\n' + value.slice(end);
                    input.selectionStart = input.selectionEnd = start + 1;
                    return;
                }
                if (!ev.shiftKey) {
                    ev.preventDefault();
                    submitChat();
                }
            }
        });

        const dragState = {
            active: false,
            offsetX: 0,
            offsetY: 0
        };

        function clamp(value, min, max) {
            return Math.max(min, Math.min(max, value));
        }

        header.addEventListener('pointerdown', function (ev) {
            if (ev.button !== 0) return;
            if (ev.target.closest('#luogu-ai-chat-close')) return;
            ev.preventDefault();
            const rect = panel.getBoundingClientRect();
            dragState.active = true;
            dragState.offsetX = ev.clientX - rect.left;
            dragState.offsetY = ev.clientY - rect.top;
            panel.style.left = rect.left + 'px';
            panel.style.top = rect.top + 'px';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
            panel.setPointerCapture(ev.pointerId);
        });

        function onPointerMove(ev) {
            if (!dragState.active) return;
            ev.preventDefault();
            const left = clamp(ev.clientX - dragState.offsetX, 8, window.innerWidth - panel.offsetWidth - 8);
            const top = clamp(ev.clientY - dragState.offsetY, 8, window.innerHeight - panel.offsetHeight - 8);
            panel.style.left = left + 'px';
            panel.style.top = top + 'px';
        }

        function endDrag(ev) {
            if (!dragState.active) return;
            dragState.active = false;
            try { panel.releasePointerCapture(ev.pointerId); } catch (e) { }
        }

        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', endDrag);
        document.addEventListener('pointercancel', endDrag);

        return panel;
    }

    function openAiChatPanel() {
        if (!getAiChatEnabled()) return;
        let panel = document.getElementById('luogu-ai-chat-panel');
        if (!panel) {
            panel = createAiChatPanel();
        }
        panel.style.display = 'flex';
        const input = panel.querySelector('#luogu-ai-chat-input');
        if (input) input.focus();
    }

    async function sendAiChatMessage(message) {
        const panel = document.getElementById('luogu-ai-chat-panel');
        if (!panel) return;
        const messages = panel.querySelector('#luogu-ai-chat-messages');
        const input = panel.querySelector('#luogu-ai-chat-input');
        const sendButton = panel.querySelector('#luogu-ai-chat-send');
        if (!messages || !input || !sendButton) return;

        const trimmedMessage = (message || '').trim();
        if (!trimmedMessage) return;

        appendAiChatBubble('user', trimmedMessage);
        input.value = '';
        input.disabled = true;
        sendButton.disabled = true;

        const loading = appendAiChatBubble('assistant', '', true);

        try {
            const editorText = getEditorContent();

            if (editorText && editorText !== aiChatState.lastEditorText) {
                aiChatState.lastEditorText = editorText;

                const contextContent = `当前题解正文（请以此为上下文回答）：\n${editorText}`;

                const existingContextIndex = aiChatState.history.findIndex(
                    item => item && item.role === 'user' && item.content && item.content.startsWith('当前题解正文')
                );

                const contextMessage = {
                    role: 'user',
                    content: contextContent
                };

                if (existingContextIndex >= 0) {
                    aiChatState.history[existingContextIndex] = contextMessage;
                } else {
                    aiChatState.history.push(contextMessage);
                }
            }

            if (aiChatState.lastAiCheckSummary && !aiChatState.aiCheckSummaryInjected) {
                aiChatState.history.push({
                    role: 'user',
                    content: aiChatState.lastAiCheckSummary
                });
                aiChatState.aiCheckSummaryInjected = true;
            }

            aiChatState.history.push({ role: 'user', content: trimmedMessage });

            const response = await callAI(aiChatState.history);
            aiChatState.history.push({ role: 'assistant', content: response.trim() });

            if (loading && loading.parentNode) {
                const bubble = loading.querySelector('div');
                if (bubble) {
                    renderAiChatBubbleContent(bubble, response.trim());
                }
            } else {
                appendAiChatBubble('assistant', response.trim());
            }
        } catch (err) {
            if (loading && loading.parentNode) {
                const bubble = loading.querySelector('div');
                if (bubble) {
                    bubble.innerHTML = escapeHtml(`AI 聊天失败：${err.message || err}`);
                }
            } else {
                appendAiChatBubble('assistant', `AI 聊天失败：${err.message || err}`);
            }
        } finally {
            input.disabled = false;
            sendButton.disabled = false;
            input.focus();
        }
    }

    function appendAiChatBubble(role, content, isLoading) {
        ensureAiChatStyles();

        const messages = document.getElementById('luogu-ai-chat-messages');
        if (!messages) return null;

        const item = document.createElement('div');
        item.style.marginBottom = '10px';
        item.style.display = 'flex';
        item.style.flexDirection = 'column';
        item.style.alignItems = role === 'user' ? 'flex-end' : 'flex-start';

        const bubble = document.createElement('div');
        bubble.style.maxWidth = '100%';
        bubble.style.padding = '8px 12px';
        bubble.style.borderRadius = '12px';
        bubble.style.whiteSpace = 'pre-wrap';
        bubble.style.wordBreak = 'break-word';
        bubble.style.background = role === 'user' ? '#409eff' : '#fff';
        bubble.style.color = role === 'user' ? '#fff' : '#333';
        bubble.style.border = role === 'assistant' ? '1px solid rgba(0,0,0,0.08)' : 'none';

        if (isLoading) {
            bubble.innerHTML = `
                <div class="luogu-ai-chat-loading-bubble">
                    <span>AI 正在生成回答</span>
                    <span class="luogu-ai-chat-loading-dots">
                        <span></span><span></span><span></span>
                    </span>
                </div>
            `;
        } else {
            renderAiChatBubbleContent(bubble, content);
        }

        if (isLoading) {
            item.classList.add('luogu-ai-chat-loading');
        }

        item.appendChild(bubble);
        messages.appendChild(item);
        messages.scrollTop = messages.scrollHeight;

        return item;
    }

    async function runCheck() {
        // 先关闭已有的浮窗
        const oldPanel = document.getElementById('luogu-format-result-panel');
        if (oldPanel) oldPanel.remove();
        let rawText = getEditorContent();
        if (!rawText) {
            console.log('编辑器尚未加载，等待 2 秒后重试...');
            await new Promise(resolve => setTimeout(resolve, 2000));
            rawText = getEditorContent();
            if (!rawText) {
                console.warn('未能获取题解内容，请确认是否在编辑页面。');
                return;
            }
        }
        lastCheckedText = rawText;
        var title = getTitle();
        var isTemplate = isTemplateProblem(title);
        var strippedText = stripCodeBlocks(rawText);
        var aiText = removeLastCodeBlock(rawText);
        var formulas = extractFormulas(strippedText);
        var textWithoutFormulas = strippedText.replace(/\$\$[\s\S]*?\$\$|\$[^$\n]+\$/g, ' ');

        var results = [
            ...checkRequiredSections(rawText, isTemplate),
            ...checkIrrelevantContent(strippedText),
            ...checkHeadings(strippedText),
            ...checkBold(strippedText),
            ...checkLists(strippedText),
            ...checkPunctuation(textWithoutFormulas),
            ...checkSpacing(textWithoutFormulas),
            ...checkOperators(strippedText),
            ...checkProperNouns(strippedText),
            ...checkMathSymbols(strippedText),
            ...checkFormulaCommonErrors(strippedText),
            ...checkFormulaStyle(strippedText),
            ...checkCodeStyle(rawText),
            ...checkMathEnvironment(strippedText)
        ];
        // AI 检查已移除，仅保留正则检查
        var aiResults = [];
        console.log('AI 检查已禁用，仅使用正则检查');
        var allResults = results.concat(aiResults);
        // 注意：不过滤已忽略，让它们在面板中显示并由 showResultPanel 决定是否显示恢复按钮
        // allResults = allResults.filter(issue => !isIgnored(issue));
        if (allResults.length === 0) {
            allResults.push({
                type: RESULT_TYPE.INFO,
                message: '未检测到明显格式问题，建议人工再检查一遍题解结构与内容。'
            });
        }

        annotateIssues(dedupeIssues(allResults));
    }

    function isTemplateProblem(title) {
        if (!title) {
            return false;
        }
        return title.includes('【模板】') || title.includes('[模板]');
    }

    function addCheckButton() {
        if (document.getElementById('luogu-format-check-button')) return true;
        var body = document.body || document.documentElement;
        if (!body) return false;

        var btn = document.createElement('button');
        btn.id = 'luogu-format-check-button';
        btn.title = '🔍 检查格式（拖动可移动）';
        btn.innerText = '🔍';
        btn.style.position = 'fixed';
        btn.style.zIndex = '99999';
        btn.style.width = '48px';
        btn.style.height = '48px';
        btn.style.padding = '0';
        btn.style.display = 'flex';
        btn.style.alignItems = 'center';
        btn.style.justifyContent = 'center';
        btn.style.background = '#409eff';
        btn.style.color = '#fff';
        btn.style.border = 'none';
        btn.style.borderRadius = '50%';
        btn.style.cursor = 'pointer';
        btn.style.boxShadow = '0 6px 18px rgba(0,0,0,0.18)';
        btn.style.fontSize = '18px';
        btn.style.userSelect = 'none';
        btn.style.transition = 'left 220ms ease, top 220ms ease';
        btn.style.touchAction = 'none';

        // 初始位置：优先使用持久化位置
        try {
            const saved = GM_getValue('luogu_format_btn_pos', null);
            if (saved) {
                const p = typeof saved === 'string' ? JSON.parse(saved) : saved;
                if (p && typeof p.left === 'number' && typeof p.top === 'number') {
                    btn.style.left = p.left + 'px';
                    btn.style.top = p.top + 'px';
                } else {
                    btn.style.right = '20px';
                    btn.style.bottom = '20px';
                }
            } else {
                btn.style.right = '20px';
                btn.style.bottom = '20px';
            }
        } catch (e) {
            btn.style.right = '20px';
            btn.style.bottom = '20px';
        }

        body.appendChild(btn);

        // --- 选项面板 ---
        const optionsPanel = document.createElement('div');
        optionsPanel.id = 'luogu-format-options-panel';
        optionsPanel.style.cssText = `
            position: fixed;
            z-index: 999999;
            width: 220px;
            padding: 10px 12px;
            background: #fff;
            border: 1px solid #e5e7eb;
            border-radius: 10px;
            box-shadow: 0 10px 22px rgba(0,0,0,.16);
            opacity: 0;
            pointer-events: none;
            transform: translateY(4px);
            transition: opacity .16s ease, transform .16s ease;
        `;
        optionsPanel.innerHTML = `
            <div style="font-size:12px;font-weight:600;color:#333;margin-bottom:8px;">选项</div>
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:#222;cursor:pointer;">
                <input id="luogu-format-ai-chat-toggle" type="checkbox">
                <span>启用 AI 聊天</span>
            </label>
            <button id="luogu-format-ai-chat-open" style="
                display:block;
                width:100%;
                padding:6px 0;
                margin-top:6px;
                border:none;
                border-radius:6px;
                background:#67c23a;
                color:#fff;
                cursor:pointer;
                font-size:12px;
            ">打开 AI 聊天</button>
            <button id="luogu-format-options-run" style="
                display:block;
                width:100%;
                padding:6px 0;
                margin-top:8px;
                border:none;
                border-radius:6px;
                background:#409eff;
                color:#fff;
                cursor:pointer;
                font-size:12px;
            ">立即检查</button>
            <button id="luogu-format-options-reset-ignore" style="
                display:block;
                width:100%;
                padding:6px 0;
                margin-top:6px;
                border:none;
                border-radius:6px;
                background:#f56c6c;
                color:#fff;
                cursor:pointer;
                font-size:12px;
            ">重置忽略</button>
        `;
        body.appendChild(optionsPanel);

        let optionsPanelHideTimer = null;

        function clampPanelValue(v, a, b) {
            return Math.max(a, Math.min(b, v));
        }

        function clearOptionsPanelHideTimer() {
            if (optionsPanelHideTimer) {
                clearTimeout(optionsPanelHideTimer);
                optionsPanelHideTimer = null;
            }
        }

        function scheduleOptionsPanelHide() {
            clearOptionsPanelHideTimer();
            optionsPanelHideTimer = setTimeout(hideOptionsPanel, 120);
        }

        function updateOptionsPanelPosition() {
            const rect = btn.getBoundingClientRect();
            const panelWidth = optionsPanel.offsetWidth || 220;
            const panelHeight = optionsPanel.offsetHeight || 140;
            let left, top;

            // 优先放在按钮上方
            if (rect.top - panelHeight - 10 > 0) {
                left = rect.left + (rect.width - panelWidth) / 2;
                top = rect.top - panelHeight - 10;
            } else {
                left = rect.left + (rect.width - panelWidth) / 2;
                top = rect.bottom + 10;
            }

            left = clampPanelValue(left, 8, window.innerWidth - panelWidth - 8);
            top = clampPanelValue(top, 8, window.innerHeight - panelHeight - 8);

            optionsPanel.style.left = left + 'px';
            optionsPanel.style.top = top + 'px';
        }

        function showOptionsPanel() {
            clearOptionsPanelHideTimer();
            optionsPanel.style.opacity = '1';
            optionsPanel.style.pointerEvents = 'auto';
            optionsPanel.style.transform = 'translateY(0)';
            requestAnimationFrame(updateOptionsPanelPosition);
        }

        function hideOptionsPanel() {
            clearOptionsPanelHideTimer();
            optionsPanel.style.opacity = '0';
            optionsPanel.style.pointerEvents = 'none';
            optionsPanel.style.transform = 'translateY(4px)';
        }

        // ---- AI 聊天开关 ----
        const aiChatToggle = optionsPanel.querySelector('#luogu-format-ai-chat-toggle');
        if (aiChatToggle) {
            aiChatToggle.checked = getAiChatEnabled();
            aiChatToggle.addEventListener('change', function () {
                setAiChatEnabled(aiChatToggle.checked);
                updateAiChatButtonState();
            });
        }

        // ---- 打开 AI 聊天按钮 ----
        const aiChatOpenBtn = optionsPanel.querySelector('#luogu-format-ai-chat-open');
        if (aiChatOpenBtn) {
            aiChatOpenBtn.addEventListener('click', function (ev) {
                ev.preventDefault();
                if (!getAiChatEnabled()) return;
                openAiChatPanel();
            });
            updateAiChatOpenButtonState();
        }

        // ---- 立即检查按钮 ----
        const runPanelBtn = optionsPanel.querySelector('#luogu-format-options-run');
        if (runPanelBtn) {
            runPanelBtn.addEventListener('click', function (ev) {
                ev.preventDefault();
                ev.stopPropagation();
                showOptionsPanel();
                runCheck();
            });
        }

        // ---- 重置忽略按钮 ----
        const resetIgnoreBtn = optionsPanel.querySelector('#luogu-format-options-reset-ignore');
        if (resetIgnoreBtn) {
            resetIgnoreBtn.addEventListener('click', function (ev) {
                ev.preventDefault();
                ev.stopPropagation();
                if (confirm('确定重置所有忽略的建议吗？')) {
                    clearIgnoredKeys();
                    hideOptionsPanel();
                    runCheck();
                }
            });
        }

        // ---- 按钮悬停显示面板 ----
        btn.addEventListener('pointerenter', showOptionsPanel);
        btn.addEventListener('pointerleave', function (ev) {
            const related = ev.relatedTarget || ev.toElement || null;
            if (related && (btn.contains(related) || optionsPanel.contains(related))) {
                return;
            }
            scheduleOptionsPanelHide();
        });

        optionsPanel.addEventListener('pointerenter', showOptionsPanel);
        optionsPanel.addEventListener('pointerleave', function (ev) {
            const related = ev.relatedTarget || ev.toElement || null;
            if (related && (btn.contains(related) || optionsPanel.contains(related))) {
                return;
            }
            scheduleOptionsPanelHide();
        });

        document.addEventListener('pointerdown', function (ev) {
            const target = ev.target;
            if (btn.contains(target) || optionsPanel.contains(target)) return;
            hideOptionsPanel();
        }, true);

        // ---- 按钮拖拽逻辑（与面板互不干扰） ----
        let dragging = false;
        let startX = 0, startY = 0;
        let startLeft = 0, startTop = 0;
        let moved = false;

        function getNumStyle(v) {
            return v ? parseFloat(v.replace('px', '')) : NaN;
        }

        function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

        btn.addEventListener('pointerdown', function (ev) {
            // 拖动开始时强制隐藏面板并取消任何定时显示
            hideOptionsPanel();
            clearOptionsPanelHideTimer();

            if (ev.button !== 0) return;
            ev.preventDefault();
            btn.setPointerCapture(ev.pointerId);
            dragging = true;
            moved = false;
            startX = ev.clientX;
            startY = ev.clientY;

            let left = getNumStyle(btn.style.left);
            let top = getNumStyle(btn.style.top);
            if (isNaN(left)) {
                const rr = getNumStyle(btn.style.right);
                left = isNaN(rr) ? (window.innerWidth - 68) : (window.innerWidth - rr - btn.offsetWidth);
            }
            if (isNaN(top)) {
                const bb = getNumStyle(btn.style.bottom);
                top = isNaN(bb) ? (window.innerHeight - 68) : (window.innerHeight - bb - btn.offsetHeight);
            }
            startLeft = left;
            startTop = top;
            btn.style.left = startLeft + 'px';
            btn.style.top = startTop + 'px';
            btn.style.right = 'auto';
            btn.style.bottom = 'auto';
            btn.style.transition = 'none';
        });

        document.addEventListener('pointermove', function (ev) {
            if (!dragging) return;
            ev.preventDefault();
            const dx = ev.clientX - startX;
            const dy = ev.clientY - startY;
            if (!moved && Math.hypot(dx, dy) > 4) moved = true;
            let left = clamp(startLeft + dx, 8, window.innerWidth - btn.offsetWidth - 8);
            let top = clamp(startTop + dy, 8, window.innerHeight - btn.offsetHeight - 8);
            btn.style.left = left + 'px';
            btn.style.top = top + 'px';
        });

        btn.addEventListener('pointerup', function (ev) {
            if (!dragging) return;
            ev.preventDefault();
            try { btn.releasePointerCapture(ev.pointerId); } catch (e) { }
            dragging = false;
            btn.style.transition = 'left 220ms ease, top 220ms ease';

            if (!moved) {
                const apiKey = getStoredApiKey();
                if (!apiKey) {
                    console.error('未配置 API Key，请在 code.js 中填写 BUILTIN_API_KEY。');
                    return;
                }
                runCheck();
                return;
            }

            const rect = btn.getBoundingClientRect();
            const finalLeft = clamp(rect.left, 8, window.innerWidth - btn.offsetWidth - 8);
            const finalTop = clamp(rect.top, 8, window.innerHeight - btn.offsetHeight - 8);
            btn.style.left = finalLeft + 'px';
            btn.style.top = finalTop + 'px';

            try {
                GM_setValue('luogu_format_btn_pos', JSON.stringify({ left: finalLeft, top: finalTop }));
            } catch (e) {
                // ignore
            }
        });

        document.addEventListener('pointercancel', function () {
            dragging = false;
            btn.style.transition = 'left 220ms ease, top 220ms ease';
        });

        window.addEventListener('resize', function () {
            try {
                const saved = GM_getValue('luogu_format_btn_pos', null);
                if (!saved) return;
                const p = typeof saved === 'string' ? JSON.parse(saved) : saved;
                if (!p) return;
                let left = p.left;
                let top = p.top;
                left = clamp(left, 8, window.innerWidth - btn.offsetWidth - 8);
                top = clamp(top, 8, window.innerHeight - btn.offsetHeight - 8);
                btn.style.left = left + 'px';
                btn.style.top = top + 'px';
                GM_setValue('luogu_format_btn_pos', JSON.stringify({ left, top }));
            } catch (e) { }
        });

        updateAiChatButtonState();

        return true;
    }

    function initButton() {
        if (addCheckButton()) return;
        var observer = new MutationObserver(function () {
            if (addCheckButton()) {
                observer.disconnect();
            }
        });
        observer.observe(document.documentElement || document.body || document, { childList: true, subtree: true });
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initButton();
    } else {
        window.addEventListener('DOMContentLoaded', initButton);
        window.addEventListener('load', initButton);
    }

    function showResultPanel(results) {
        const oldPanel = document.getElementById('luogu-format-result-panel');
        if (oldPanel) oldPanel.remove();

        if (results.length === 0) {
            results.push({
                type: RESULT_TYPE.INFO,
                message: '未检测到明显格式问题，建议人工再检查一遍题解结构与内容。'
            });
        }

        const hardCount = results.filter(r => r.type === RESULT_TYPE.HARD).length;
        const suggestCount = results.filter(r => r.type === RESULT_TYPE.SUGGEST).length;
        const infoCount = results.filter(r => r.type === RESULT_TYPE.INFO).length;

        function findFormulaRanges(text) {
            const ranges = [];
            const regex = /\$\$[\s\S]*?\$\$|\$[^$\n]+\$/g;
            let match;
            while ((match = regex.exec(text))) {
                ranges.push([match.index, match.index + match[0].length]);
            }
            return ranges;
        }

        function isInFormula(pos, ranges) {
            return ranges.some(([start, end]) => pos >= start && pos < end);
        }

        function findSafeIndex(text, needle, ranges) {
            if (!needle) return -1;
            let from = 0;
            while (true) {
                const idx = text.indexOf(needle, from);
                if (idx === -1) return -1;
                let inside = false;
                for (let i = idx; i < idx + needle.length; i++) {
                    if (isInFormula(i, ranges)) {
                        inside = true;
                        break;
                    }
                }
                if (!inside) return idx;
                from = idx + 1;
            }
        }

        function expandByPunctuation(text, start, end, ranges) {
            const punct = /[。．！？：:；;,.?!\r\n]/;
            let left = start;
            while (left > 0) {
                if (punct.test(text[left - 1]) && !isInFormula(left - 1, ranges)) {
                    break;
                }
                left--;
            }
            let right = end;
            while (right < text.length) {
                if (punct.test(text[right]) && !isInFormula(right, ranges)) {
                    right++;
                    break;
                }
                right++;
            }
            return text.slice(left, right).trim();
        }

        function expandByPunctuationWithIndices(text, start, end, ranges) {
            const punct = /[。．！？：:；;,.?!\r\n]/;
            let left = start;
            while (left > 0) {
                if (punct.test(text[left - 1]) && !isInFormula(left - 1, ranges)) {
                    break;
                }
                left--;
            }
            let right = end;
            while (right < text.length) {
                if (punct.test(text[right]) && !isInFormula(right, ranges)) {
                    right++;
                    break;
                }
                right++;
            }
            return { left, right, excerpt: text.slice(left, right) };
        }

        function getSnippetHtml(issue) {
            if (issue.context) return escapeHtml(issue.context);
            const base = issue.highlight;
            if (!base) return '';
            if (lastCheckedText) {
                const sentences = lastCheckedText.split(/(?<=[。！？\n])/);
                for (const sentence of sentences) {
                    if (sentence.includes(base)) {
                        const idx = sentence.indexOf(base);
                        const before = escapeHtml(sentence.slice(0, idx));
                        const key = escapeHtml(sentence.slice(idx, idx + base.length));
                        const after = escapeHtml(sentence.slice(idx + base.length));
                        return `${before}<mark style="background:#fff2a8;color:#000;border-radius:3px;padding:0 4px;">${key}</mark>${after}`;
                    }
                }
            }
            return `<mark style="background:#fff2a8;color:#000;border-radius:3px;padding:0 4px;">${escapeHtml(base)}</mark>`;
        }

        const panel = document.createElement('div');
        panel.id = 'luogu-format-result-panel';
        panel.style.cssText = `
            position: fixed;
            top: 80px;
            right: 20px;
            z-index: 99999;
            width: 420px;
            max-height: 70vh;
            background: #fff;
            border-radius: 12px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.18);
            font-size: 14px;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            cursor: move;
            user-select: none;
        `;

        const titleBar = document.createElement('div');
        titleBar.style.cssText = `
            padding: 8px 14px;
            background: rgba(0,0,0,0.03);
            color: #222;
            font-size: 13px;
            font-weight: 600;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            border-top-left-radius:12px;
            border-top-right-radius:12px;
        `;
        const problemTitle = escapeHtml(getTitle() || '（未检测到题目名称）');
        titleBar.innerHTML = `📌 ${problemTitle}`;
        panel.appendChild(titleBar);

        const header = document.createElement('div');
        header.style.cssText = `
            padding: 14px 18px;
            background: #409eff;
            color: #fff;
            font-weight: 600;
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-shrink: 0;
            cursor: move;
        `;
        header.innerHTML = `
            <span>📋 格式检查结果</span>
            <span style="font-size:12px;font-weight:400;opacity:0.85;">
                🔴${hardCount} 🟡${suggestCount} 🔵${infoCount}
            </span>
            <button id="luogu-format-panel-close" style="
                background: none;
                border: none;
                color: #fff;
                font-size: 18px;
                cursor: pointer;
                padding: 0 4px;
                opacity: 0.7;
            ">×</button>
        `;
        panel.appendChild(header);

        const content = document.createElement('div');
        content.className = 'luogu-format-panel-content';
        content.style.cssText = `
            padding: 12px 16px;
            overflow-y: auto;
            flex: 1;
            cursor: auto;
            user-select: text;
            line-height: 1.6;
        `;
        // ---- 渲染每条建议（包括已忽略的） ----
        for (const issue of results) {
            const isIgnoredNow = isIgnored(issue);
            const key = getIssueKey(issue);
            const item = document.createElement('div');
            item.style.cssText = `
                padding: 6px 0;
                border-bottom: 1px solid #f0f0f0;
                font-size: 13px;
                opacity: ${isIgnoredNow ? '0.5' : '1'};
            `;
            const snippetHtml = getSnippetHtml(issue);
            item.innerHTML = `
                <div style="display:flex;align-items:flex-start;gap:6px;justify-content:space-between;">
                    <div style="display:flex;align-items:flex-start;gap:6px;flex:1;">
                        <span style="flex-shrink:0;">${issue.type}</span>
                        <span style="word-break:break-word;">${escapeHtml(issue.message)}</span>
                    </div>
                    <button class="luogu-ignore-btn" data-key="${escapeHtml(key)}" style="
                        background: none;
                        border: none;
                        color: ${isIgnoredNow ? '#409eff' : '#999'};
                        cursor: pointer;
                        font-size: 14px;
                        padding: 0 4px;
                        flex-shrink: 0;
                        line-height: 1;
                    " title="${isIgnoredNow ? '恢复此建议' : '忽略此建议'}">
                        ${isIgnoredNow ? '↩' : '✕'}
                    </button>
                </div>
                ${snippetHtml ? `<div style="margin-top:6px;font-size:12px;color:#333;background:#f7f8fa;padding:6px 10px;border-radius:6px;font-family:monospace;">📌 ${snippetHtml}</div>` : ''}
                ${isIgnoredNow ? `<div style="margin-top:4px;font-size:11px;color:#999;">（已忽略，点击 ↩ 恢复）</div>` : ''}
            `;
            content.appendChild(item);
        }

        panel.appendChild(content);

        const footer = document.createElement('div');
        footer.style.cssText = `
            padding: 10px 16px;
            border-top: 1px solid #f0f0f0;
            display: flex;
            justify-content: flex-end;
            gap: 10px;
            flex-shrink: 0;
            background: #fafbfc;
        `;
        footer.innerHTML = `
            <button id="luogu-format-panel-refresh" style="
                padding: 4px 14px;
                background: #409eff;
                color: #fff;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 13px;
            ">重新检查</button>
        `;
        panel.appendChild(footer);

        document.body.appendChild(panel);

        // ---- 关闭按钮 ----
        document.getElementById('luogu-format-panel-close').addEventListener('click', () => panel.remove());

        // ---- 重新检查按钮 ----
        document.getElementById('luogu-format-panel-refresh').addEventListener('click', () => {
            panel.remove();
            runCheck();
        });

        // ---- 忽略/恢复按钮事件委托 ----
        panel.addEventListener('click', function (e) {
            const btn = e.target.closest('.luogu-ignore-btn');
            if (!btn) return;
            const key = btn.dataset.key;
            if (!key) return;

            // ---- 保存当前滚动位置 ----
            const contentEl = panel.querySelector('.luogu-format-panel-content');
            const scrollTop = contentEl ? contentEl.scrollTop : 0;

            // ---- 切换忽略状态 ----
            const currentIgnored = getIgnoredKeys();
            const isNowIgnored = currentIgnored.includes(key);
            if (isNowIgnored) {
                removeIgnoredKey(key);
            } else {
                addIgnoredKey(key);
            }

            // ---- 获取问题内容用于提示 ----
            const issue = results.find(r => getIssueKey(r) === key);
            const issueMsg = issue ? issue.message : '';

            // ---- 重新渲染面板 ----
            panel.remove();
            showResultPanel(results);

            // ---- 恢复滚动位置 ----
            const newPanel = document.getElementById('luogu-format-result-panel');
            const newContent = newPanel ? newPanel.querySelector('.luogu-format-panel-content') : null;
            if (newContent && scrollTop > 0) {
                newContent.scrollTop = scrollTop;
            }

            // ---- Toast 提示 ----
            const action = isNowIgnored ? '已恢复' : '已忽略';
            const emoji = isNowIgnored ? '↩' : '✅';
            showToast(`${emoji} ${action}：${issueMsg}`, isNowIgnored ? '#409eff' : '#52c41a');
        });

        // ---- 拖拽逻辑 ----
        let isDragging = false;
        let offsetX = 0, offsetY = 0;

        function getClient(e) {
            return {
                x: (e.clientX !== undefined) ? e.clientX : (e.touches && e.touches[0] && e.touches[0].clientX),
                y: (e.clientY !== undefined) ? e.clientY : (e.touches && e.touches[0] && e.touches[0].clientY)
            };
        }

        function startDrag(e) {
            if (e.target && e.target.tagName === 'BUTTON') return;
            const c = getClient(e);
            if (c.x == null || c.y == null) return;
            isDragging = true;
            const rect = panel.getBoundingClientRect();
            offsetX = c.x - rect.left;
            offsetY = c.y - rect.top;
            panel.style.cursor = 'grabbing';
            e.preventDefault();
        }

        function onDrag(e) {
            if (!isDragging) return;
            const c = getClient(e);
            if (c.x == null || c.y == null) return;
            let left = c.x - offsetX;
            let top = c.y - offsetY;
            left = Math.max(0, Math.min(left, window.innerWidth - panel.offsetWidth));
            top = Math.max(0, Math.min(top, window.innerHeight - panel.offsetHeight));
            panel.style.left = left + 'px';
            panel.style.top = top + 'px';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
            e.preventDefault();
        }

        function endDrag() {
            isDragging = false;
            panel.style.cursor = 'move';
        }

        [header, titleBar].forEach(el => {
            el.style.cursor = 'move';
            el.addEventListener('pointerdown', startDrag);
        });
        document.addEventListener('pointermove', onDrag);
        document.addEventListener('pointerup', endDrag);
    }

    function showToast(message, color = '#52c41a') {
        // 移除已有 toast
        const oldToast = document.getElementById('luogu-format-toast');
        if (oldToast) oldToast.remove();

        const toast = document.createElement('div');
        toast.id = 'luogu-format-toast';
        toast.style.cssText = `
            position: fixed;
            bottom: 80px;
            left: 50%;
            transform: translateX(-50%);
            z-index: 9999999;
            padding: 10px 24px;
            background: ${color};
            color: #fff;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 500;
            box-shadow: 0 4px 16px rgba(0,0,0,0.2);
            opacity: 0;
            transition: opacity 0.3s ease, transform 0.3s ease;
            pointer-events: none;
            max-width: 80vw;
            text-align: center;
        `;
        toast.textContent = message;
        document.body.appendChild(toast);

        // 触发淡入
        requestAnimationFrame(() => {
            toast.style.opacity = '1';
            toast.style.transform = 'translateX(-50%) translateY(-4px)';
        });

        // 1.8 秒后淡出并移除
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(-50%) translateY(0)';
            setTimeout(() => {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
            }, 300);
        }, 1800);
    }

    function dedupeIssues(issues) {
        const seen = new Set();
        return (issues || []).filter(issue => {
            const key = `${issue.type || ''}||${issue.message || ''}||${issue.highlight || ''}||${issue.context || ''}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }
    // ----- 忽略列表管理 -----
    function getIgnoredKeys() {
        try {
            const val = GM_getValue('luogu_ignored_issues', '[]');
            return JSON.parse(val) || [];
        } catch (e) {
            return [];
        }
    }

    function addIgnoredKey(key) {
        const keys = getIgnoredKeys();
        if (!keys.includes(key)) {
            keys.push(key);
            GM_setValue('luogu_ignored_issues', JSON.stringify(keys));
        }
    }

    function removeIgnoredKey(key) {
        let keys = getIgnoredKeys();
        keys = keys.filter(k => k !== key);
        GM_setValue('luogu_ignored_issues', JSON.stringify(keys));
    }

    function clearIgnoredKeys() {
        GM_setValue('luogu_ignored_issues', '[]');
    }

    function isIgnored(issue) {
        const key = `${issue.type || ''}||${issue.message || ''}||${issue.highlight || ''}`;
        return getIgnoredKeys().includes(key);
    }

    function getIssueKey(issue) {
        return `${issue.type || ''}||${issue.message || ''}||${issue.highlight || ''}`;
    }
    function ensureAiChatStyles() {
        if (document.getElementById('luogu-ai-chat-styles')) return;
        const style = document.createElement('style');
        style.id = 'luogu-ai-chat-styles';
        style.textContent = `
        .luogu-ai-chat-loading-bubble {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            color: #666;
        }
        .luogu-ai-chat-loading-dots {
            display: inline-flex;
            gap: 4px;
        }
        .luogu-ai-chat-loading-dots span {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: #409eff;
            animation: luogu-ai-chat-bounce 1.2s infinite ease-in-out;
        }
        .luogu-ai-chat-loading-dots span:nth-child(2) {
            animation-delay: .18s;
        }
        .luogu-ai-chat-loading-dots span:nth-child(3) {
            animation-delay: .36s;
        }
        @keyframes luogu-ai-chat-bounce {
            0%, 80%, 100% {
                transform: scale(0.7);
                opacity: 0.45;
            }
            40% {
                transform: scale(1);
                opacity: 1;
            }
        }
    `;
        document.head.appendChild(style);
    }
    //runCheck();
}());