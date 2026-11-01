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
//     命中任一情况都不再记入 missing；missing.json 记录带标签的完整原文。
//   * 已翻译过的结果不会被二次翻译（add -> drawTextEx 不会链式替换）。
//   * MZ 的说话人名字在 setSpeakerName 处翻译，名字框才能按译文宽度测量。
//=============================================================================
(function() {
    'use strict';

    // ---- 配置 ------------------------------------------------------------
    var DICT_NAME = 'dict.json';
    var MISSING_NAME = 'missing.json';
    var FLUSH_DELAY = 800;            // 未翻译文本写盘去抖 (毫秒)
    var COLLECT_ONLY_JAPANESE = true; // 只收集含日文的文本；英文/纯数字源请改为 false
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

    // ---- 字典 ------------------------------------------------------------
    var dict = Object.create(null); // 无原型，避免 constructor / __proto__ 之类的键误命中
    var entryCount = 0;

    function readObject(file) {
        var raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
        var data = JSON.parse(raw);
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            throw new Error('顶层必须是 JSON 对象');
        }
        return data;
    }

    if (dictPath) {
        try {
            var data = readObject(dictPath);
            Object.keys(data).forEach(function(key) {
                var value = data[key];
                // 空译文 = 待翻译占位，按未翻译处理
                if (!key || typeof value !== 'string' || value === '') return;
                dict[key] = value;
                entryCount++;
            });
            console.log('[QuickTranslator] 字典已加载: ' + dictPath + ' (' + entryCount + ' 条)');
        } catch (e) {
            console.warn('[QuickTranslator] dict.json 解析失败: ' + e.message);
        }
    } else {
        console.warn('[QuickTranslator] 未找到 ' + DICT_NAME + '，已尝试: ' + dirs.join(' | '));
    }

    // ---- 未翻译文本收集 --------------------------------------------------
    var missing = new Set();
    var dirty = false;
    var flushTimer = null;

    if (fs.existsSync(missingPath)) {
        try {
            var previous = readObject(missingPath);
            Object.keys(previous).forEach(function(key) {
                if (key && dict[key] === undefined) missing.add(key);
            });
            dirty = true; // 顺带清理已补进字典的旧条目
        } catch (e) {
            console.warn('[QuickTranslator] missing.json 读取失败，将重新生成: ' + e.message);
        }
    }

    var JP_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/;
    var ESCAPE_RE = /\\[A-Za-z]+(?:\[\d+\])?|\\[.!#$%&*+\-\/<=>@^_|~{}\\]/g;

    function isCollectable(text) {
        if (!text) return false;
        if (COLLECT_ONLY_JAPANESE && !JP_RE.test(text)) return false;
        return !!text.replace(ESCAPE_RE, '').trim(); // 纯控制符/空白不收集
    }

    function collect(text) {
        if (missing.has(text) || dict[text] !== undefined || !isCollectable(text)) return;
        missing.add(text);
        dirty = true;
        scheduleFlush();
    }

    function scheduleFlush() {
        if (flushTimer !== null) return;
        flushTimer = setTimeout(flush, FLUSH_DELAY);
    }

    function flush() {
        flushTimer = null;
        if (!dirty) return;
        dirty = false;
        try {
            var out = {};
            missing.forEach(function(key) { out[key] = ''; });
            fs.writeFileSync(missingPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
            console.log('[QuickTranslator] 未翻译文本 ' + missing.size + ' 条 -> ' + missingPath);
        } catch (e) {
            dirty = true;
            console.warn('[QuickTranslator] 写入 missing.json 失败: ' + e.message);
        }
    }

    // ---- 翻译 ------------------------------------------------------------
    var translated = new Set(); // 译文结果，防止 add -> drawTextEx 二次翻译

    // 头部控制标签：\SP[normal]、\C[1]、\N[2] 等，允许连续多个
    var LEAD_TAGS_RE = /^(?:\\[A-Za-z]+(?:\[[^\]]*\])?)+/;
    // 内嵌控制标签切分用：捕获组让 split 结果按 文本/标签/文本… 交替
    var TAG_SPLIT_RE = /(\\[A-Za-z]+(?:\[[^\]]*\])?)/;

    function translate(text) {
        if (typeof text !== 'string' || text === '') return text;
        if (translated.has(text)) return text;

        // 第一阶段：完整原文匹配（字典本身带标签）
        if (dict[text] !== undefined) {
            translated.add(dict[text]);
            return dict[text];
        }

        // 第二阶段：剥离头部标签，用主体文本匹配，命中后把标签拼回
        var tags = LEAD_TAGS_RE.exec(text);
        if (tags) {
            var prefix = tags[0];
            var body = text.slice(prefix.length);
            var hit = body ? dict[body] : undefined;
            if (hit === undefined && body) {
                var trimmedBody = body.trim();
                if (trimmedBody !== body) hit = dict[trimmedBody];
            }
            if (hit !== undefined) {
                var joined = prefix + hit;
                translated.add(joined);
                return joined;
            }
        }

        // 第三阶段：按内嵌控制符切分，逐段查表后原样拼合。
        // 只要有一段命中即视为整句翻译成功，不再记入 missing。
        var parts = text.split(TAG_SPLIT_RE);
        if (parts.length > 1) {
            var hitAny = false;
            for (var p = 0; p < parts.length; p++) {
                var part = parts[p];
                if (!part || p % 2 === 1) continue; // 奇数索引是标签，原样保留
                var segment = dict[part];
                if (segment === undefined) {
                    var trimmedPart = part.trim();
                    if (trimmedPart !== part) segment = dict[trimmedPart];
                }
                if (segment !== undefined) {
                    parts[p] = segment;
                    hitAny = true;
                }
            }
            if (hitAny) {
                var composed = parts.join('');
                translated.add(composed);
                return composed;
            }
        }

        // 无标签文本的首尾空白回退
        var key = text.trim();
        if (key !== text && dict[key] !== undefined) {
            translated.add(dict[key]);
            return dict[key];
        }

        // 所有阶段都未命中：missing 记录带标签的完整原文
        collect(key);
        return text;
    }

    // ---- 钩子 ------------------------------------------------------------
    // 1. 剧情文本：在控制符被解析之前替换
    var _Game_Message_add = Game_Message.prototype.add;
    Game_Message.prototype.add = function(text) {
        var args = Array.prototype.slice.call(arguments);
        args[0] = translate(text);
        return _Game_Message_add.apply(this, args);
    };

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

    // 关窗时立即落盘，避免去抖定时器来不及触发
    if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('beforeunload', flush);
    }

    if (dirty) scheduleFlush();
})();
