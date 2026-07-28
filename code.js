// ==UserScript==
// @name         洛谷题解格式检查助手
// @namespace    http://tampermonkey.net/
// @version      1.2.1
// @description  检查洛谷题解格式，辅助通过审核
// @match        https://www.luogu.com.cn/article/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// @author       Sunny_boybgfcxc
// ==/UserScript==

(function () {
    'use strict';

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

    const BUILTIN_API_KEY = 'e168cc4ee11749ce97e7717cb250b23d.HJKaI14oGuCyrRAK';

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
        const textarea = document.querySelector('textarea[name=content], textarea#content, textarea');
        if (textarea) return textarea.value || '';
        const cmTextarea = document.querySelector('.CodeMirror textarea');
        if (cmTextarea) return cmTextarea.value || '';
        const prose = document.querySelector('.ProseMirror,[contenteditable="true"]');
        if (prose) return prose.innerText || prose.textContent || '';
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
        const results = [];
        const commaMatch = text.match(/[\u4e00-\u9fff],[\u4e00-\u9fff]|[\u4e00-\u9fff],|,[\u4e00-\u9fff]/);
        if (commaMatch) {
            results.push({
                type: RESULT_TYPE.SUGGEST,
                message: '检测到中文上下文中使用半角逗号，建议改为中文全角逗号“，”。',
                highlight: commaMatch[0]
            });
        }
        const dotMatch = text.match(/[\u4e00-\u9fff]\.[\u4e00-\u9fff]|[\u4e00-\u9fff]\.|\\.[\u4e00-\u9fff]/);
        if (dotMatch) {
            results.push({
                type: RESULT_TYPE.SUGGEST,
                message: '检测到中文上下文中使用半角句号，建议改为中文全角句号“。”。',
                highlight: dotMatch[0]
            });
        }
        const fullWidthMatch = text.match(/　/);
        if (fullWidthMatch) {
            results.push({
                type: RESULT_TYPE.SUGGEST,
                message: '检测到全角空格，建议改为半角空格。',
                highlight: fullWidthMatch[0]
            });
        }
        const fullWidthCharMatch = text.match(/[Ａ-Ｚａ-ｚ０-９]/);
        if (fullWidthCharMatch) {
            results.push({
                type: RESULT_TYPE.SUGGEST,
                message: '检测到全角英文字母或数字，建议改为半角。',
                highlight: fullWidthCharMatch[0]
            });
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
            if (/\bN\b/.test(formula) && /\\in/.test(formula) && !/\\mathbb\{N\}/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '集合符号建议使用 \\mathbb{N} / \\mathbb{Z} 等形式表示，例如 $\\mathbb{N}$。',
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
            if (/\d\s*x\s*\d/.test(formula) && !/\\times/.test(formula)) {
                results.push({
                    type: RESULT_TYPE.SUGGEST,
                    message: '若表示乘法请使用 \\times 而非字母 x，例如 $\\times$。',
                    highlight: 'x'
                });
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
        }
        return results;
    }

    function checkFormulaStyle(text) {
        const results = [];
        const formulas = extractFormulas(text);
        for (const formula of formulas) {
            if (/\$[^$]+\$\s*\+\s*\$[^$]+\$/.test(formula) || /\$[^$]+\$\s*=\s*\$[^$]+\$/.test(formula) || /\$[^$]+\$\s*<\s*\$[^$]+\$/.test(formula)) {
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

    function extractAiJsonPayload(text) {
        if (typeof text !== 'string' || !text.trim()) return null;

        let cleaned = text
            .replace(/\u200B|\u200C|\u200D|\uFEFF/g, '') // 移除零宽字符
            .replace(/&nbsp;/g, ' ') // HTML 实体转空格
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
            .trim();

        // 1. 直接解析
        try { return JSON.parse(cleaned); } catch (e) { }

        // 2. 提取 ```json ... ``` 代码块
        const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenced) {
            try { return JSON.parse(fenced[1].trim()); } catch (e) { }
        }

        // 3. 提取第一个 JSON 数组或对象（增强：允许多余文字）
        const jsonMatch = cleaned.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
        if (jsonMatch) {
            let jsonStr = jsonMatch[1];
            // 修复常见问题：尾部多余逗号、键名缺少引号
            jsonStr = jsonStr.replace(/,\s*}/g, '}').replace(/,\s*\]/g, ']');
            jsonStr = jsonStr.replace(/(['"])?([a-zA-Z0-9_]+)(['"])?\s*:/g, '"$2":');
            try { return JSON.parse(jsonStr); } catch (e) { }
        }

        // 4. 提取中文冒号后的数组（如 "结果："）
        const chineseArray = cleaned.match(/[：:]\s*(\[[\s\S]*\])/);
        if (chineseArray) {
            try { return JSON.parse(chineseArray[1]); } catch (e) { }
        }

        // 5. 暴力遍历所有看起来像 JSON 的片段
        const candidates = cleaned.match(/(\[[\s\S]*?\]|\{[\s\S]*?\})/g);
        if (candidates) {
            for (const candidate of candidates) {
                let c = candidate.replace(/,\s*}/g, '}').replace(/,\s*\]/g, ']');
                try { return JSON.parse(c); } catch (e) { }
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
                <div id="luogu-format-ai-progress-bar" style="height:100%;width:0%;background:linear-gradient(90deg,#409eff,#67c23a);transition:width 0.25s ease;border-radius:999px;"></div>
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

    function callAI(prompt) {
        //const apiKey = getStoredApiKey();
        const apiKey = BUILTIN_API_KEY.trim();
        if (!apiKey) {
            return Promise.reject(new Error('未配置 API Key'));
        }
        return new Promise((resolve, reject) => {
            console.log('callAI: 请求发送（prompt 前5000字符）', (prompt || '').slice(0, 5000));
            GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`
                },
                data: JSON.stringify({
                    model: 'glm-4-flash',
                    messages: [
                        {
                            role: 'user',
                            content: prompt
                        }
                    ],
                    max_tokens: 800
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
        const CONTEXT_SNIPPET = (textContext || '').slice(0, 5000);

        const prompt = `
你是洛谷题解格式检查助手，目标是结合全文上下文与 LaTeX 公式给出更主观且有价值的建议。
请基于下面内容执行检查并返回 JSON 数组（严格的 JSON，不要额外文本）。数组元素为对象，字段：
- type: "🔴 硬性错误" 或 "🟡 建议修改" 或 "🔵 提示信息"
- message: 问题说明（尽量简短）
- highlight: 问题片段（便于高亮）
- context: 所在句子或段落（便于展示）
- rule: 可选，表明是哪条规则（例如 "heading-abuse", "operator-operator", "special-char"）

请检查（但不限于）：
1) 是否滥用标题行（例如大量无实际内容的 H2/H3、把段落拆成过多标题、章节层级跳跃、或使用标题行来强调与解题无关的内容），如果是，请指出相关标题片段并给出建议。
2) 公式中是否将函数名、操作名直接写为普通字符而未使用 \\operatorname{}（例如写 'lcm'、'mod' 等而未 math 环境中使用 \\operatorname{}），或是否缺少应有的 \\mathrm/\\operatorname 包裹。
3) 是否在公式中直接写了英文专有名词、变量应该用斜体但写成普通文字，或出现特殊字符未用对应 LaTeX 命令（如 ~、| 等）。
4) 是否存在主观性的结构或风格问题（例如不当的标题拆分、重复的短标题、段落过短等），并给出建议与可定位片段。
5) 是否存在对于非函数名、变量名及常数的英文单词、人名或缩写使用公式的情况，如 Catalan 写成 $Catalan$，并给出修改建议及可定位片段。
6) 是否存在大量无关内容，如 '求管理员通过' 或 '蒟蒻的第一篇题解' 。

特别注意：
- 你只需要判断是否存在以上情况，其它的事情都不关你事。
- 不应出现两条相似的建议。
- 忽略代码,但不要忘记该题解有代码实现。
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

以下是题目解说的上下文（供理解整体内容），你的任务是检查从这行以下的文本。
${CONTEXT_SNIPPET}

以下是正文中已提取出的公式片段（供参考，这些公式本身已经是 LaTeX 格式，请勿重复检查这些片段，只把它们作为上下文来理解作者意图）：
${formulas.join('\n')}

请返回 JSON 数组，而且请**只返回** JSON 数组，**不要**添加任何解释文字、Markdown 标记或额外内容。
你的回复必须是一个合法的 JSON 数组，以 '[' 开头，以 ']' 结尾。
        `.trim();

        return callAI(prompt)
            .then(response => {
                if (!response || typeof response !== 'string') return [];

                const parsed = extractAiJsonPayload(response);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    // 直接映射成我们需要的格式
                    return parsed
                        .filter(item => item.message && item.message.trim())
                        .map(item => ({
                            type: item.type || RESULT_TYPE.SUGGEST,
                            message: item.message.trim(),
                            highlight: item.highlight || '',
                            context: item.context || '',
                            rule: item.rule || ''
                        }));
                }

                // 如果解析失败，返回空数组（不显示任何东西）
                return [];
            })
            .catch(err => {
                console.warn('AI 公式检查失败：', err);
                return [];
            });
    }

    let lastCheckedText = '';

    async function runCheck() {
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
            ...checkRequiredSections(strippedText, isTemplate),
            ...checkIrrelevantContent(strippedText),
            ...checkHeadings(strippedText),
            ...checkBold(strippedText),
            ...checkLists(strippedText),
            ...checkPunctuation(textWithoutFormulas),
            ...checkSpacing(textWithoutFormulas),
            ...checkOperators(strippedText),
            ...checkProperNouns(strippedText),
            ...checkMathSymbols(strippedText),
            ...checkFormulaStyle(strippedText),
            ...checkCodeStyle(rawText)
        ];

        // 仅在有 API Key 时调用 AI 检查；并捕获错误以防止阻断主流程
        var aiResults = [];
        if (getStoredApiKey()) {
            var aiOverlay = null;
            try {
                aiOverlay = showAiThinkingOverlay();
                aiResults = await runAICheck(formulas, aiText) || [];
            } catch (err) {
                console.warn('调用 AI 检查出错：', err);
                aiResults = [];
            } finally {
                hideAiThinkingOverlay(aiOverlay);
            }
        } else {
            console.warn('未配置 API Key，已跳过 AI 检查。');
        }

        var allResults = results.concat(aiResults);

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

        // 拖拽逻辑（Pointer Events）
        let dragging = false;
        let startX = 0, startY = 0;
        let startLeft = 0, startTop = 0;
        let moved = false;

        function getNumStyle(v) {
            return v ? parseFloat(v.replace('px', '')) : NaN;
        }

        function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

        btn.addEventListener('pointerdown', function (ev) {
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

        // resize 时确保按钮仍在可视区域
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
            // 把换行也当作标点边界
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

        // 新增：返回带索引的片段，便于高亮定位
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

        function escapeHtml(str) {
            return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }

        // 返回已转义并对 highlight 部分进行 <mark> 高亮的 HTML 字符串
        function getSnippetHtml(issue) {
            if (issue.context) return escapeHtml(issue.context);

            const quoteMatch = issue.message && issue.message.match(/[“"‘']([^“"‘']+)[”"’']/);
            const fallback = quoteMatch ? quoteMatch[1] : '';

            if (!issue.highlight) {
                return escapeHtml(fallback || '');
            }

            const base = issue.highlight;
            if (lastCheckedText) {
                const ranges = findFormulaRanges(lastCheckedText);
                const idx = findSafeIndex(lastCheckedText, base, ranges);
                if (idx !== -1) {
                    const { left, right, excerpt } = expandByPunctuationWithIndices(lastCheckedText, idx, idx + base.length, ranges);
                    const relStart = idx - left;
                    const relEnd = relStart + base.length;
                    const before = escapeHtml(excerpt.slice(0, relStart));
                    const key = escapeHtml(excerpt.slice(relStart, relEnd));
                    const after = escapeHtml(excerpt.slice(relEnd));
                    // 高亮样式可自定义
                    return `${before}<mark style="background:#fff2a8;color:#000;border-radius:3px;padding:0 4px;">${key}</mark>${after}`;
                }
            }

            // 未能定位到上下文则仅返回高亮文本本身
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

        // 在浮窗最上端显示题目名称
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
        content.style.cssText = `
            padding: 12px 16px;
            overflow-y: auto;
            flex: 1;
            cursor: auto;
            user-select: text;
            line-height: 1.6;
        `;

        for (const issue of results) {
            const item = document.createElement('div');
            item.style.cssText = `
                padding: 6px 0;
                border-bottom: 1px solid #f0f0f0;
                font-size: 13px;
            `;
            const snippetHtml = getSnippetHtml(issue);
            item.innerHTML = `
                <div style="display:flex;align-items:flex-start;gap:6px;">
                    <span style="flex-shrink:0;">${issue.type}</span>
                    <span style="word-break:break-word;">${escapeHtml(issue.message)}</span>
                </div>
                ${snippetHtml ? `<div style="margin-top:6px;font-size:12px;color:#333;background:#f7f8fa;padding:6px 10px;border-radius:6px;font-family:monospace;">📌 ${snippetHtml}</div>` : ''}
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

        document.getElementById('luogu-format-panel-close').addEventListener('click', () => panel.remove());
        document.getElementById('luogu-format-panel-refresh').addEventListener('click', () => {
            panel.remove();
            runCheck();
        });

        let isDragging = false;
        let offsetX = 0;
        let offsetY = 0;

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

        // 让 header、titleBar（和 panel 顶部）都能启动拖拽，增强可点击区域
        [header, titleBar].forEach(el => {
            el.style.cursor = 'move';
            el.addEventListener('pointerdown', startDrag);
        });
        document.addEventListener('pointermove', onDrag);
        document.addEventListener('pointerup', endDrag);
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

    //runCheck();
})();