//=============================================================================
// QuickTranslator.js - 轻量级离线字典汉化插件 (RPG Maker MV / MZ, NW.js)
//=============================================================================
// 用法:
//   1. 把本插件放进 js/plugins/ 并在插件管理器中启用。
//   2. 在插件目录或游戏根目录 (www/) 放 dict.json:
//        { "日文原文": "中文译文" }
//   3. 字典里没有的文本会自动收集到 dict.json 同目录的 missing.json:
//        { "未翻译原文": "" }
//      译文为空字符串的条目同样视为未翻译，不会让界面文字消失。
//   4. 把 missing.json 的内容补全后并入 dict.json 即可，无需改脚本。
//
// 说明:
//   * 翻译发生在 \C[x] / \N[x] 等控制符被解析 (convertEscapeCharacters)
//     之前，因此字典键可以直接写含控制符的原文。
//   * 只改写 Game_Message / Window_Base 的运行期状态并写出独立 JSON 文件，
//     不写入任何存档数据。
//   * 先按完整原文匹配；未命中时剥离头部控制标签（如 \SP[normal]）用主体查表；
//     仍未命中则按内嵌控制符（如 \c[18]）切分，逐段查表后原样拼合。
//     多行文本另有 \n 降级链：整块 -> 剥离首行后的连续子块 ->
//     最后一个控制符之后的整块 -> 逐行，保留换行。
//     键匹配对控制符字母大小写不敏感（\n[1] = \N[1]），并对 〜/～ 兜底。
//     命中任一段都不再记入 missing；missing.json 记录原始完整文本，不记录碎片。
//   * 日文 locale 下 standardFontFace 被改成中文字体优先的字体栈，
//     避免 GameFont (mplus) 缺「异 / 您」等简体字时画成空白。
//   * 已翻译过的结果与 \N[x] 展开后的结果都会被标记，不会二次翻译或误收集。
//   * MZ 的说话人名字在 setSpeakerName 处翻译，名字框才能按译文宽度测量。
//   * 数据库角色名（$dataActors / $gameActors）在加载时翻译，避免 \N[x] 展开残留日文。
//=============================================================================
(function() {
    'use strict';

    // ---- 配置 ------------------------------------------------------------
    var DICT_NAME = 'dict.json';
    var MISSING_NAME = 'missing.json';
    var FLUSH_DELAY = 800;            // 未翻译文本写盘去抖 (毫秒)
    var COLLECT_ONLY_JAPANESE = true; // 只收集含日文的文本；英文/纯数字源请改为 false
    var QT_DEBUG = false;             // true: 诊断日志直接追加到 <游戏根>/qt_debug.log
    // MV 默认 GameFont (mplus-1m-regular.ttf) 没有「异 / 您」等简体字，会直接画成空白。
    // 因此把中文字体排在最前，GameFont 只作为假名/CJK 回退，最后再退到系统 sans-serif。
    var CJK_FONT_FACE = '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", ' +
        '"Noto Sans CJK SC", "Source Han Sans SC", "SimHei", "Heiti TC", ' +
        '"Microsoft JhengHei", "GameFont", sans-serif';
    // ----------------------------------------------------------------------

    if (typeof require !== 'function' || typeof process === 'undefined') return;
    if (typeof Game_Message === 'undefined' || typeof Window_Base === 'undefined') {
        console.warn('[QuickTranslator] 核心脚本未加载，插件已停用');
        return;
    }

    var fs = require('fs');
    var path = require('path');

    // ---- 路径定位 --------------------------------------------------------
    function toLocalPath(url) {
        if (!url) return '';
        try {
            var p = decodeURIComponent(new URL(url).pathname);
            return /^\/[A-Za-z]:/.test(p) ? p.slice(1) : p; // Windows: /C:/... -> C:/...
        } catch (e) {
            return '';
        }
    }

    function uniqDirs(list) {
        var seen = Object.create(null);
        var out = [];
        for (var i = 0; i < list.length; i++) {
            if (!list[i]) continue;
            var dir = path.resolve(list[i]);
            if (seen[dir]) continue;
            seen[dir] = true;
            out.push(dir);
        }
        return out;
    }

    var scriptDir = '';
    if (typeof document !== 'undefined' && document.currentScript) {
        var scriptPath = toLocalPath(document.currentScript.src);
        if (scriptPath) scriptDir = path.dirname(scriptPath);
    }
    var rootDir = '';
    if (typeof window !== 'undefined' && window.location) {
        rootDir = toLocalPath(window.location.href);
    }
    if (rootDir) rootDir = path.dirname(rootDir);
    if (!rootDir) rootDir = process.cwd();

    var debugLogPath = '';
    function resolveDebugLogPath() {
        if (debugLogPath) return debugLogPath;
        var candidates = [rootDir, dataDir, process.cwd()];
        for (var i = 0; i < candidates.length; i++) {
            if (!candidates[i]) continue;
            try {
                if (!fs.statSync(candidates[i]).isDirectory()) continue;
            } catch (e) {
                continue;
            }
            debugLogPath = path.join(candidates[i], 'qt_debug.log');
            return debugLogPath;
        }
        debugLogPath = path.join(process.cwd(), 'qt_debug.log');
        return debugLogPath;
    }
    function debugLog() {
        if (!QT_DEBUG) return;
        try {
            var parts = [];
            for (var a = 0; a < arguments.length; a++) {
                var value = arguments[a];
                parts.push(typeof value === 'string' ? value : JSON.stringify(value));
            }
            fs.appendFileSync(resolveDebugLogPath(), new Date().toISOString() + ' ' + parts.join(' ') + '\n', 'utf8');
        } catch (e) {
            // 诊断日志失败绝不能影响游戏
        }
    }

    var dirs = uniqDirs([
        scriptDir,                            // 插件同目录
        path.join(rootDir, 'js', 'plugins'),  // 标准插件目录
        rootDir,                              // 游戏根 / www
        path.join(rootDir, '..'),             // MZ 工程根
        process.cwd()
    ]);

    var dictPath = '';
    for (var i = 0; i < dirs.length && !dictPath; i++) {
        var candidate = path.join(dirs[i], DICT_NAME);
        if (fs.existsSync(candidate)) dictPath = candidate;
    }

    var dataDir = '';
    if (dictPath) {
        dataDir = path.dirname(dictPath);
    } else {
        for (var d = 0; d < dirs.length && !dataDir; d++) {
            if (fs.existsSync(dirs[d])) dataDir = dirs[d];
        }
        dataDir = dataDir || process.cwd();
    }
    var missingPath = path.join(dataDir, MISSING_NAME);
    debugLog('boot', { rootDir: rootDir, cwd: process.cwd(), dirs: dirs, dictPath: dictPath, missingPath: missingPath });

    // ---- 字典 ------------------------------------------------------------
    var dict = Object.create(null); // 无原型，避免 constructor / __proto__ 之类的键误命中
    // 规范化索引（仅在键需要规范化时才建），用于 \n[1] / \N[1] 与 〜/～ 的兼容查表
    var dictNorm = Object.create(null);
    var dictVariant = Object.create(null);
    var entryCount = 0;
    var identitySkipped = 0;
    var metaSkipped = 0;

    function readObject(file) {
        var raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
        var data = JSON.parse(raw);
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            throw new Error('顶层必须是 JSON 对象');
        }
        return data;
    }

    // MV 的 convertEscapeCharacters 用 /gi 展开 \N / \V / \P / \G，
    // obtainEscapeCode 也会把任意控制符转成大写，因此控制符字母大小写等价。
    // 查表时统一成大写；只影响键比较，不改写游戏文本或译文。
    function normalizeControlCase(text) {
        if (typeof text !== 'string' || text.indexOf('\\') < 0) return text;
        return text.replace(/\\([A-Za-z]+)/g, function(match, code) {
            return '\\' + code.toUpperCase();
        });
    }

    // 波浪线 U+301C / U+FF5E 在不同来源里会混用；只在精确查表失败后兜底。
    function normalizeVariant(text) {
        return normalizeControlCase(text).replace(/\u301c/g, '\uff5e');
    }

    if (dictPath) {
        try {
            var data = readObject(dictPath);
            Object.keys(data).forEach(function(key) {
                var value = data[key];
                // MTool 导出的元信息不是游戏文本
                if (!key) return;
                if (key.indexOf('MTool_Meta_') === 0) {
                    metaSkipped++;
                    return;
                }
                // 空译文 = 待翻译占位，按未翻译处理
                if (typeof value !== 'string' || value === '') return;
                // MTool 对未翻译条目会把原文原样写回译文；value === key 不是译文。
                // 若当作已翻译，add 阶段会把这些日文行全部标记为“已处理”，
                // 导致 allText 的多行整块匹配被短路，且 missing.json 永远为空。
                if (value === key) {
                    identitySkipped++;
                    return;
                }
                dict[key] = value;
                entryCount++;
                var normKey = normalizeControlCase(key);
                if (normKey !== key && dictNorm[normKey] === undefined) dictNorm[normKey] = value;
                var variantKey = normalizeVariant(key);
                if (variantKey !== normKey && dictVariant[variantKey] === undefined) dictVariant[variantKey] = value;
            });
            console.log('[QuickTranslator] 字典已加载: ' + dictPath + ' (' + entryCount + ' 条' +
                (identitySkipped ? '，跳过 ' + identitySkipped + ' 条未翻译占位' : '') + ')');
            debugLog('dict', { path: dictPath, entries: entryCount, identitySkipped: identitySkipped, metaSkipped: metaSkipped });
        } catch (e) {
            console.warn('[QuickTranslator] dict.json 解析失败: ' + e.message);
            debugLog('dict-error', e.message);
        }
    } else {
        console.warn('[QuickTranslator] 未找到 ' + DICT_NAME + '，已尝试: ' + dirs.join(' | '));
        debugLog('dict-missing', dirs);
    }

    // ---- 未翻译文本收集 --------------------------------------------------
    var missing = new Set();
    var dirty = false;
    var flushTimer = null;
    // add 时只翻译不收集；若某条消息路径不调用 allText，由这里兜底做一次整块收集。
    var pendingMessages = [];
    var finalizeTimer = null;

    if (fs.existsSync(missingPath)) {
        try {
            var previous = readObject(missingPath);
            Object.keys(previous).forEach(function(key) {
                if (key && lookup(key) === undefined) missing.add(key);
            });
            dirty = true; // 顺带清理已补进字典的旧条目
        } catch (e) {
            console.warn('[QuickTranslator] missing.json 读取失败，将重新生成: ' + e.message);
        }
    }

    // 只认假名与日文专有符号（々〆〻、半角片假名）；CJK 标点「」。、与通用汉字都不算日文。
    var JP_RE = /[\u3040-\u309f\u30a0-\u30ff\u3005\u3006\u303b\uff66-\uff9f]/;
    // 汉字区单独用于“是否可能仍是日文”的保守判断（不用于 missing 收集）。
    var HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
    var ESCAPE_RE = /\\[A-Za-z]+(?:\[\d+\])?|\\[.!#$%&*+\-\/<=>@^_|~{}\\]/g;
    var MIN_COLLECT_LENGTH = 2; // 单个假名/单个控制符多是插件逐字绘制的碎片，不收集

    function isCollectable(text) {
        if (!text) return false;
        if (COLLECT_ONLY_JAPANESE && !JP_RE.test(text)) return false;
        var body = text.replace(ESCAPE_RE, '').trim();
        if (!body) return false; // 纯控制符/空白
        if (body.length < MIN_COLLECT_LENGTH) return false;
        return true;
    }

    function collect(text) {
        if (missing.has(text) || isProcessedOutput(text) || lookup(text) !== undefined || !isCollectable(text)) return;
        missing.add(text);
        dirty = true;
        debugLog('collect', text);
        scheduleFlush();
    }

    function scheduleFlush() {
        if (flushTimer !== null) return;
        flushTimer = setTimeout(flush, FLUSH_DELAY);
    }

    function finalizePendingMessages() {
        if (pendingMessages.length === 0) return;
        var list = pendingMessages;
        pendingMessages = [];
        for (var i = 0; i < list.length; i++) {
            var message = list[i];
            if (!message || message._qtFinalized) continue;
            var source = message._qtSourceTexts;
            if (source && source.length > 0) {
                translate(source.join('\n'), false);
            }
            message._qtFinalized = true;
        }
    }

    function scheduleMessageFinalize() {
        clearTimeout(finalizeTimer);
        finalizeTimer = setTimeout(function() {
            finalizeTimer = null;
            finalizePendingMessages();
            flush();
        }, FLUSH_DELAY);
    }

    function flush() {
        flushTimer = null;
        if (finalizeTimer !== null) {
            clearTimeout(finalizeTimer);
            finalizeTimer = null;
        }
        finalizePendingMessages();
        if (flushTimer !== null) {
            clearTimeout(flushTimer);
            flushTimer = null;
        }
        if (!dirty) return;
        dirty = false;
        try {
            var out = {};
            missing.forEach(function(key) { out[key] = ''; });
            fs.writeFileSync(missingPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
            console.log('[QuickTranslator] 未翻译文本 ' + missing.size + ' 条 -> ' + missingPath);
            debugLog('flush', { path: missingPath, count: missing.size });
        } catch (e) {
            dirty = true;
            console.warn('[QuickTranslator] 写入 missing.json 失败: ' + e.message);
            debugLog('flush-error', e.message);
        }
    }

    // ---- 翻译 ------------------------------------------------------------
    // translated: 本插件产出的译文（多行译文拆成每一行也记录），二次进入直接短路。
    // alias:      译文 -> 原始文本，用于说话人名已翻译后还原整块原文再查表。
    var translated = new Set();
    var alias = new Map();
    // 本插件产出过的显示文本（含局部译文拼接串）。只用于阻止半成品写进 missing.json。
    var processedOutputs = new Set();
    // 角色名 -> \N[id]，用于识别“中文译文 + \N[x] 展开后的人名”这种半成品行。
    var actorNameControls = [];

    // 头部控制标签：\SP[normal]、\C[1]、\N[2] 等，允许连续多个
    var LEAD_TAGS_RE = /^(?:\\[A-Za-z]+(?:\[[^\]]*\])?)+/;
    // 内嵌控制标签切分用：捕获组让 split 结果按 文本/标签/文本… 交替
    var TAG_SPLIT_RE = /(\\[A-Za-z]+(?:\[[^\]]*\])?)/;
    // 全局扫描用（控制符后缀链）
    var TAG_ALL_RE = /\\[A-Za-z]+(?:\[[^\]]*\])?/g;

    function lookup(key) {
        if (!key) return undefined;
        if (dict[key] !== undefined) return dict[key];
        var norm = normalizeControlCase(key);
        if (norm !== key && dict[norm] !== undefined) return dict[norm];
        if (dictNorm[norm] !== undefined) return dictNorm[norm];
        var variant = normalizeVariant(key);
        if (variant !== norm) {
            if (dict[variant] !== undefined) return dict[variant];
            if (dictNorm[variant] !== undefined) return dictNorm[variant];
        }
        if (dictVariant[variant] !== undefined) return dictVariant[variant];
        return undefined;
    }

    // 译文集合：同时收录控制符大写形式，\n[1] / \N[1] 不会因大小写不同而二次翻译。
    function rememberTranslated(text) {
        if (typeof text !== 'string' || text === '') return;
        translated.add(text);
        var norm = normalizeControlCase(text);
        if (norm !== text) translated.add(norm);
    }

    function wasTranslated(text) {
        if (translated.has(text)) return true;
        var norm = normalizeControlCase(text);
        return norm !== text && translated.has(norm);
    }

    function rememberProcessedOutput(text) {
        if (typeof text !== 'string' || text === '') return;
        processedOutputs.add(text);
        var norm = normalizeControlCase(text);
        if (norm !== text) processedOutputs.add(norm);
    }

    function isProcessedOutput(text) {
        if (processedOutputs.has(text)) return true;
        var norm = normalizeControlCase(text);
        return norm !== text && processedOutputs.has(norm);
    }

    function aliasGet(key) {
        if (alias.has(key)) return { found: true, value: alias.get(key) };
        var norm = normalizeControlCase(key);
        if (norm !== key && alias.has(norm)) return { found: true, value: alias.get(norm) };
        return { found: false, value: undefined };
    }

    function rememberAlias(key, source) {
        if (!key || key === source || alias.has(key)) return;
        alias.set(key, source);
        var norm = normalizeControlCase(key);
        if (norm !== key && !alias.has(norm)) alias.set(norm, source);
    }

    function markTranslated(out, source) {
        if (typeof out !== 'string' || out === '') return out;
        rememberTranslated(out);
        var outLines = out.split('\n');
        var srcLines = typeof source === 'string' ? source.split('\n') : null;
        for (var i = 0; i < outLines.length; i++) {
            var line = outLines[i];
            if (!line) continue;
            rememberTranslated(line);
            if (srcLines && srcLines[i] !== undefined && srcLines[i] !== line) {
                rememberAlias(line, srcLines[i]);
            }
        }
        if (typeof source === 'string' && source !== out) {
            rememberAlias(out, source);
        }
        return out;
    }

    function restoreOriginal(text) {
        if (alias.size === 0) return text;
        var whole = aliasGet(text);
        if (whole.found) return whole.value;
        var lines = text.split('\n');
        var changed = false;
        for (var i = 0; i < lines.length; i++) {
            var lineAlias = aliasGet(lines[i]);
            if (lineAlias.found) {
                lines[i] = lineAlias.value;
                changed = true;
            }
        }
        return changed ? lines.join('\n') : text;
    }

    // 多行候选：先按原样查，再按逐行 trim 后的形态查（游戏里常见 " 「わあ…" 这种行首空格）。
    function lookupLines(lines) {
        var raw = lines.join('\n');
        var hit = lookup(raw);
        if (hit !== undefined) return { hit: hit, source: raw };

        var trimmed = [];
        var changed = false;
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (line !== lines[i]) changed = true;
            trimmed.push(line);
        }
        if (changed) {
            var normalized = trimmed.join('\n');
            hit = lookup(normalized);
            if (hit !== undefined) return { hit: hit, source: normalized };
        }
        return null;
    }

    // 控制符在文本中的结束位置（从后往前尝试）。MTool 的多行键通常从最后一个
    // 控制符之后开始，所以只需保证最后一次切分能被尝试到。
    function controlSuffixEnds(text) {
        var ends = [];
        TAG_ALL_RE.lastIndex = 0;
        var match;
        while ((match = TAG_ALL_RE.exec(text)) !== null) {
            ends.push(match.index + match[0].length);
        }
        return ends;
    }

    function registerActorName(name, actorId) {
        if (!name || !actorId) return;
        for (var i = 0; i < actorNameControls.length; i++) {
            if (actorNameControls[i].name === name) return;
        }
        actorNameControls.push({ name: name, control: '\\N[' + actorId + ']' });
    }

    function canonicalizeActorNames(text) {
        if (!text || actorNameControls.length === 0) return text;
        var out = text;
        for (var i = 0; i < actorNameControls.length; i++) {
            var item = actorNameControls[i];
            if (out.indexOf(item.name) >= 0) out = out.split(item.name).join(item.control);
        }
        return out;
    }

    // \N[x] 展开后的人名与译文模板只差人名本身；规范化后能命中 translated 的行不是原文。
    function isKnownTranslatedLine(line) {
        if (wasTranslated(line)) return true;
        var canonical = canonicalizeActorNames(line);
        return canonical !== line && wasTranslated(canonical);
    }

    // 多行文本的每一行都已是译文，或确无假名/汉字（标点、数字）：
    // 视为处理过的拼接结果，直接放行。
    function isProcessedComposite(text) {
        if (text.indexOf('\n') < 0) return false;
        var lines = text.split('\n');
        var sawKnown = false;
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (!line) continue;
            if (isKnownTranslatedLine(line)) {
                sawKnown = true;
                continue;
            }
            var plain = line.replace(ESCAPE_RE, '');
            // 汉字无法区分中文与“纯汉字日文”，不能当作已处理；只有确无汉字的标点/数字行可跳过。
            if (HAN_RE.test(plain)) return false;
            if (!JP_RE.test(plain)) continue;
            return false;
        }
        return sawKnown;
    }

    // 单行匹配链：整行 -> 剥头部标签 -> 按内嵌控制符分段 -> 首尾空白。
    // 返回值 hit 表示有可用译文；dictHit 表示确实命中了字典（用于决定是否收集）。
    function translateSimple(text) {
        if (wasTranslated(text)) {
            return { text: text, hit: true, dictHit: false };
        }

        var hit = lookup(text);
        if (hit !== undefined) {
            return { text: markTranslated(hit, text), hit: true, dictHit: true };
        }

        var tags = LEAD_TAGS_RE.exec(text);
        if (tags) {
            var prefix = tags[0];
            var body = text.slice(prefix.length);
            var bodyHit = body ? lookup(body) : undefined;
            if (bodyHit === undefined && body) {
                var trimmedBody = body.trim();
                if (trimmedBody !== body) bodyHit = lookup(trimmedBody);
            }
            if (bodyHit !== undefined) {
                return { text: markTranslated(prefix + bodyHit, text), hit: true, dictHit: true };
            }
        }

        var parts = text.split(TAG_SPLIT_RE);
        if (parts.length > 1) {
            var hitAny = false;
            for (var p = 0; p < parts.length; p++) {
                var part = parts[p];
                if (!part || p % 2 === 1) continue; // 奇数索引是标签，原样保留
                var segment = lookup(part);
                if (segment === undefined) {
                    var trimmedPart = part.trim();
                    if (trimmedPart !== part) segment = lookup(trimmedPart);
                }
                if (segment !== undefined) {
                    parts[p] = segment;
                    hitAny = true;
                }
            }
            if (hitAny) {
                return { text: markTranslated(parts.join(''), text), hit: true, dictHit: true };
            }
        }

        var key = text.trim();
        var keyHit = key !== text ? lookup(key) : undefined;
        if (keyHit !== undefined) {
            return { text: markTranslated(keyHit, text), hit: true, dictHit: true };
        }

        return { text: text, hit: false, dictHit: false };
    }

    // 多行降级链：整块（含恢复原始人名后的整块）-> 剥首行后的连续多行子块
    // -> 最后一个控制符之后的整块 -> 逐行。
    // 换行符一律保留。局部命中时，未命中的连续日文行必须照常收集，不能被首行命中吞掉；
    // 只有整块不存在未译日文行时才把完整译文加入 translated，避免半成品被下游短路。
    function translateMultiline(text, deferCollect) {
        var lines = text.split('\n');
        var block = lookupLines(lines);
        if (block) {
            return { text: markTranslated(block.hit, block.source), hit: true, dictHit: true, translatedAny: false };
        }

        var restored = restoreOriginal(text);
        if (restored !== text) {
            block = lookupLines(restored.split('\n'));
            if (block) {
                return { text: markTranslated(block.hit, block.source), hit: true, dictHit: true, translatedAny: false };
            }
        }

        if (lines.length > 1) {
            var restLines = lines.slice(1);
            var rest = restLines.join('\n');
            var restBlock = lookupLines(restLines);
            if (!restBlock) {
                var restRestored = restoreOriginal(rest);
                if (restRestored !== rest) {
                    restBlock = lookupLines(restRestored.split('\n'));
                }
            }
            if (restBlock) {
                var restOut = markTranslated(restBlock.hit, restBlock.source);
                var head = lines[0];
                var headHasJapanese = false;
                if (!isKnownTranslatedLine(head)) {
                    var headResult = translateSimple(head);
                    head = headResult.text;
                    if (!headResult.hit && JP_RE.test(head.replace(ESCAPE_RE, ''))) {
                        headHasJapanese = true;
                    }
                }
                var suffixComposed = head + '\n' + restOut;
                if (!headHasJapanese) {
                    markTranslated(suffixComposed, text);
                } else if (!deferCollect) {
                    collect(restoreOriginal(head));
                }
                return {
                    text: suffixComposed,
                    hit: true,
                    dictHit: true,
                    translatedAny: false
                };
            }
        }

        // MTool 导出时会把 \n[1] / \N[1] 这类控制符从键里剥掉，
        // 多行键往往从“最后一个控制符之后”开始（如 "さんのお家です♡\nさっそく…"）。
        // 前缀单独走逐行/分段翻译，控制符本身原样保留。
        var suffixEnds = controlSuffixEnds(text);
        for (var s = suffixEnds.length - 1; s >= 0; s--) {
            var end = suffixEnds[s];
            if (end >= text.length) continue;
            var suffix = text.slice(end);
            var lead = '';
            var leadMatch = /^\n+/.exec(suffix);
            if (leadMatch) {
                lead = leadMatch[0];
                suffix = suffix.slice(lead.length);
            }
            if (!suffix) continue;
            var suffixBlock = lookupLines(suffix.split('\n'));
            if (!suffixBlock) {
                var suffixRestored = restoreOriginal(suffix);
                if (suffixRestored !== suffix) suffixBlock = lookupLines(suffixRestored.split('\n'));
            }
            if (!suffixBlock) continue;
            var prefix = text.slice(0, end);
            var headBlock = translateLines(prefix.split('\n'), deferCollect, prefix);
            var tailOut = markTranslated(suffixBlock.hit, suffixBlock.source);
            var combined = headBlock.text + lead + tailOut;
            if (!headBlock.hasUnhitJapanese) {
                markTranslated(combined, text);
            }
            return {
                text: combined,
                hit: true,
                dictHit: true,
                translatedAny: headBlock.translatedAny,
                hasUnhitJapanese: headBlock.hasUnhitJapanese
            };
        }

        return translateLines(lines, deferCollect, text);
    }

    // 逐行翻译：整块/子块都未命中时的最终降级，也用于控制符前缀。
    // wholeText 是全未命中时写入 missing.json 的原始文本（保留多行，不记碎片）。
    function translateLines(lines, deferCollect, wholeText) {
        var outLines = [];
        var anyDictHit = false;
        var anyTranslated = false;
        var hasUnhitJapanese = false;
        var runs = [];
        var run = [];

        function flushRun() {
            if (run.length > 0) {
                runs.push(run.join('\n'));
                run = [];
            }
        }

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (wasTranslated(line)) {
                flushRun();
                outLines.push(line);
                anyTranslated = true;
                continue;
            }
            var result = translateSimple(line);
            outLines.push(result.text);
            if (result.dictHit) {
                flushRun();
                anyDictHit = true;
                anyTranslated = true;
            } else if (result.hit) {
                flushRun();
                anyTranslated = true;
            } else if (isKnownTranslatedLine(line)) {
                // 例如 "\N[1]" 已展开成日文人名的中文译文行；不是待翻译原文。
                flushRun();
                anyTranslated = true;
            } else if (JP_RE.test(line.replace(ESCAPE_RE, ''))) {
                hasUnhitJapanese = true;
                run.push(line);
            } else {
                flushRun();
            }
        }
        flushRun();

        var composed = outLines.join('\n');
        if ((anyDictHit || anyTranslated) && !hasUnhitJapanese) {
            markTranslated(composed, wholeText);
        }
        if (!deferCollect) {
            if (!anyDictHit && !anyTranslated) {
                // 全未命中：收原始完整文本，而不是逐行碎片。
                if (hasUnhitJapanese) collect(restoreOriginal(wholeText));
            } else {
                // 局部命中：只收未命中且含日文的原始连续子块（如首行"女神"命中后的 2-4 行）。
                for (var r = 0; r < runs.length; r++) {
                    collect(restoreOriginal(runs[r]));
                }
            }
        }
        return {
            text: composed,
            hit: anyDictHit || anyTranslated,
            dictHit: anyDictHit,
            translatedAny: anyTranslated,
            hasUnhitJapanese: hasUnhitJapanese
        };
    }

    // fromMessage: Game_Message.allText 的原始行块。必须先尝试整块/子块字典，
    // 不能被 add 阶段逐行命中的 translated 标记短路，否则多行译文永远轮不到。
    function translate(text, deferCollect, fromMessage) {
        if (typeof text !== 'string' || text === '') return text;
        if (wasTranslated(text)) return text;

        if (text.indexOf('\n') >= 0) {
            if (!fromMessage && isProcessedComposite(text)) {
                markTranslated(text);
                return text;
            }
            var multilineOut = translateMultiline(text, !!deferCollect).text;
            if (multilineOut !== text) rememberProcessedOutput(multilineOut);
            return multilineOut;
        }

        var result = translateSimple(text);
        if (!result.hit && !deferCollect) {
            collect(text.trim());
        }
        if (result.text !== text) rememberProcessedOutput(result.text);
        return result.text;
    }

    // ---- 钩子 ------------------------------------------------------------
    // 1. 剧情文本：保存原始行后逐行翻译；收集延后到 allText，避免多行键被拆碎误收。
    var _Game_Message_add = Game_Message.prototype.add;
    Game_Message.prototype.add = function(text) {
        var args = Array.prototype.slice.call(arguments);
        if (typeof text === 'string') {
            // 正常情况下 clear 已重置；若被插件绕过了 clear，至少在新消息开头对齐一次。
            if (!Array.isArray(this._qtSourceTexts) || !this._texts || this._texts.length === 0) {
                this._qtSourceTexts = [];
            }
            this._qtSourceTexts.push(text);
            this._qtAllCache = null;
            this._qtFinalized = false;
            if (pendingMessages.indexOf(this) < 0) pendingMessages.push(this);
            scheduleMessageFinalize();
        }
        args[0] = translate(text, true);
        if (typeof text === 'string') debugLog('add', { source: text, out: args[0] });
        return _Game_Message_add.apply(this, args);
    };

    // 整块优先：add 的逐行翻译不会污染原始多行块；allText 用未变脏的原始行整体查表，
    // 整块未命中再进入 \n 降级链（剥首行子块 -> 逐行）。
    var _Game_Message_allText = Game_Message.prototype.allText;
    if (typeof _Game_Message_allText === 'function') {
        Game_Message.prototype.allText = function() {
            var source = this._qtSourceTexts;
            var texts = this._texts || [];
            var out;
            if (source && source.length > 0 && source.length === texts.length) {
                var cache = this._qtAllCache;
                if (cache && cache.length === source.length) {
                    this._qtFinalized = true;
                    return cache.text;
                }
                out = translate(source.join('\n'), false, true);
                debugLog('allText', { source: source.join('\n'), out: out });
                this._qtAllCache = { length: source.length, text: out };
            } else {
                out = translate(_Game_Message_allText.apply(this, arguments), false);
            }
            this._qtFinalized = true;
            return out;
        };
    }

    var _Game_Message_clear = Game_Message.prototype.clear;
    if (typeof _Game_Message_clear === 'function') {
        Game_Message.prototype.clear = function() {
            var result = _Game_Message_clear.apply(this, arguments);
            this._qtSourceTexts = [];
            this._qtAllCache = null;
            this._qtFinalized = true;
            return result;
        };
    }

    // MZ：说话人名字同样写入消息状态，名字框才能按译文测量宽度
    if (typeof Game_Message.prototype.setSpeakerName === 'function') {
        var _Game_Message_setSpeakerName = Game_Message.prototype.setSpeakerName;
        Game_Message.prototype.setSpeakerName = function(name) {
            return _Game_Message_setSpeakerName.call(this, translate(name));
        };
    }

    // 2. 选项文本：写入状态时替换，选项窗口按译文宽度自适应
    var _Game_Message_setChoices = Game_Message.prototype.setChoices;
    Game_Message.prototype.setChoices = function(choices, defaultType, cancelType) {
        if (Array.isArray(choices)) {
            choices = choices.map(function(choice) {
                return typeof choice === 'string' ? translate(choice) : choice;
            });
        }
        return _Game_Message_setChoices.call(this, choices, defaultType, cancelType);
    };

    // 3. 带控制符的绘制（帮助、描述、选项等）：先匹配原文，再交给原逻辑转义
    var _Window_Base_drawTextEx = Window_Base.prototype.drawTextEx;
    Window_Base.prototype.drawTextEx = function(text) {
        var args = Array.prototype.slice.call(arguments);
        args[0] = translate(text);
        // MZ 的第 4 个参数 width 必须原样透传
        return _Window_Base_drawTextEx.apply(this, args);
    };

    // 4. 菜单、道具名与系统 UI
    var _Window_Base_drawText = Window_Base.prototype.drawText;
    Window_Base.prototype.drawText = function(text) {
        var args = Array.prototype.slice.call(arguments);
        args[0] = translate(text);
        return _Window_Base_drawText.apply(this, args);
    };

    // 4.5 字体：日文 locale 下 standardFontFace 返回 GameFont，而 mplus 没有
    //     「异」「您」等简体字，canvas 会直接画成空白。统一改成中文字体优先的字体栈，
    //     GameFont 只作为假名/CJK 回退；可用文件顶部 CJK_FONT_FACE 覆盖。
    if (typeof Window_Base.prototype.standardFontFace === 'function') {
        Window_Base.prototype.standardFontFace = function() {
            return CJK_FONT_FACE;
        };
    }

    // 5. 控制符展开：\N[x] 会把译文里的占位展开成运行期人名。
    //    只要输入已被本插件处理，展开结果也标记为已处理，防止二次查表/误收集。
    var _Window_Base_convertEscapeCharacters = Window_Base.prototype.convertEscapeCharacters;
    if (typeof _Window_Base_convertEscapeCharacters === 'function') {
        Window_Base.prototype.convertEscapeCharacters = function(text) {
            var out = _Window_Base_convertEscapeCharacters.call(this, text);
            if (typeof text === 'string' && typeof out === 'string' && out !== text) {
                if (wasTranslated(text) || isProcessedOutput(text) || isProcessedComposite(text)) {
                    rememberProcessedOutput(out);
                    markTranslated(out);
                }
            }
            return out;
        };
    }

    // 6. 数据库角色名：\N[x] 展开取的是 $dataActors / $gameActors 的名字，
    //    只在 draw 时翻译字符串不够，必须在数据层先换掉。
    var ACTOR_FIELDS = ['name', 'nickname', 'profile'];
    var GAME_ACTOR_FIELDS = ['_name', '_nickname', '_profile'];

    function translateActorEntry(actor, fields, actorId) {
        if (!actor || typeof actor !== 'object') return;
        for (var i = 0; i < fields.length; i++) {
            var field = fields[i];
            if (typeof actor[field] !== 'string' || !actor[field]) continue;
            var isName = field === 'name' || field === '_name';
            if (isName) registerActorName(actor[field], actorId);
            var value = translate(actor[field]);
            if (value !== actor[field]) actor[field] = value;
            if (isName) registerActorName(actor[field], actorId);
        }
    }

    function translateActorDatabase() {
        if (typeof window === 'undefined' || !Array.isArray(window.$dataActors)) return;
        for (var i = 1; i < window.$dataActors.length; i++) {
            translateActorEntry(window.$dataActors[i], ACTOR_FIELDS, i);
        }
    }

    function translateGameActors() {
        if (typeof window === 'undefined' || !window.$gameActors) return;
        var data = window.$gameActors._data;
        if (!Array.isArray(data)) return;
        for (var i = 1; i < data.length; i++) {
            translateActorEntry(data[i], GAME_ACTOR_FIELDS, data[i]._actorId || i);
        }
    }

    if (typeof DataManager !== 'undefined') {
        if (typeof DataManager.onLoad === 'function') {
            var _DataManager_onLoad = DataManager.onLoad;
            DataManager.onLoad = function(object) {
                var result = _DataManager_onLoad.apply(this, arguments);
                if (typeof window !== 'undefined' && object === window.$dataActors) {
                    translateActorDatabase();
                }
                return result;
            };
        }
        if (typeof DataManager.extractSaveContents === 'function') {
            var _DataManager_extractSaveContents = DataManager.extractSaveContents;
            DataManager.extractSaveContents = function(contents) {
                var result = _DataManager_extractSaveContents.apply(this, arguments);
                translateGameActors();
                return result;
            };
        }
    }

    // 老存档里的 Game_Actor._name 可能早于字典加载；名字 getter 再兜一层。
    if (typeof Game_Actor !== 'undefined' && Game_Actor.prototype) {
        for (var f = 0; f < ACTOR_FIELDS.length; f++) {
            var fieldName = ACTOR_FIELDS[f];
            if (typeof Game_Actor.prototype[fieldName] !== 'function') continue;
            Game_Actor.prototype[fieldName] = (function(original) {
                return function() {
                    var value = original.apply(this, arguments);
                    return typeof value === 'string' ? translate(value) : value;
                };
            })(Game_Actor.prototype[fieldName]);
        }
    }

    // 关窗时立即落盘，避免去抖定时器来不及触发
    if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('beforeunload', flush);
    }

    if (dirty) scheduleFlush();
})();
