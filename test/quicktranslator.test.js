// QuickTranslator 回归测试：无需安装依赖，Node / Bun 均可直接运行。
//   node test/quicktranslator.test.js
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const PLUGIN_PATH = path.resolve(__dirname, '..', 'QuickTranslator.js');
const PLUGIN_SOURCE = fs.readFileSync(PLUGIN_PATH, 'utf8');
const tempDirs = [];
const tests = [];

function test(name, fn) {
    tests.push({ name, fn });
}

function boot(dict, options) {
    options = options || {};
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qt-test-'));
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, 'js', 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dict.json'), JSON.stringify(dict), 'utf8');

    const runtime = { window: null };
    const handlers = {};
    const window = {
        location: { href: pathToFileURL(path.join(dir, 'index.html')).href },
        addEventListener: function(event, fn) { handlers[event] = fn; },
        $dataActors: options.actors || null,
        $gameActors: null
    };
    runtime.window = window;

    function Game_Message() {
        this._texts = [];
        this._speakerName = '';
        this._choices = [];
    }
    Game_Message.prototype.add = function(text) { this._texts.push(text); };
    Game_Message.prototype.allText = function() { return this._texts.join('\n'); };
    Game_Message.prototype.clear = function() {
        this._texts = [];
        this._speakerName = '';
        this._choices = [];
    };
    Game_Message.prototype.setSpeakerName = function(name) { this._speakerName = name; };
    Game_Message.prototype.speakerName = function() { return this._speakerName; };
    Game_Message.prototype.setChoices = function(choices) { this._choices = choices; };

    function Window_Base() {
        this.lastDrawEx = null;
        this.lastDraw = null;
    }
    Window_Base.prototype.drawTextEx = function(text, x, y, width) {
        this.lastDrawEx = { text: text, x: x, y: y, width: width };
        return text;
    };
    Window_Base.prototype.drawText = function(text, x, y, maxWidth, align) {
        this.lastDraw = { text: text, x: x, y: y, maxWidth: maxWidth, align: align };
        return text;
    };
    Window_Base.prototype.convertEscapeCharacters = function(text) {
        return text.replace(/\\N\[(\d+)\]/gi, function(match, id) {
            const actors = runtime.window.$dataActors;
            const actor = actors && actors[Number(id)];
            return actor ? actor.name : '';
        });
    };
    Window_Base.prototype.standardFontFace = function() {
        return 'GameFont';
    };

    function Game_Actor(name) {
        this._name = name;
        this._nickname = '';
        this._profile = '';
    }
    Game_Actor.prototype.name = function() { return this._name; };
    Game_Actor.prototype.nickname = function() { return this._nickname; };
    Game_Actor.prototype.profile = function() { return this._profile; };

    const DataManager = {
        onLoad: function(object) { this.lastLoaded = object; },
        extractSaveContents: function(contents) { return contents; }
    };

    const timers = [];
    function fakeSetTimeout(fn, ms) {
        timers.push({ fn: fn, ms: ms });
        return timers.length;
    }
    function fakeClearTimeout(id) {
        if (id && timers[id - 1]) timers[id - 1].fn = null;
    }
    function runTimers() {
        const list = timers.splice(0, timers.length);
        for (const timer of list) {
            if (timer.fn) timer.fn();
        }
    }

    const context = {
        console: { log: function() {}, warn: function() {} },
        require: require,
        process: { cwd: function() { return dir; } },
        URL: URL,
        document: { currentScript: { src: pathToFileURL(path.join(dir, 'js', 'plugins', 'QuickTranslator.js')).href } },
        window: window,
        Game_Message: Game_Message,
        Window_Base: Window_Base,
        Game_Actor: Game_Actor,
        DataManager: DataManager,
        setTimeout: fakeSetTimeout,
        clearTimeout: fakeClearTimeout
    };
    vm.createContext(context);
    vm.runInContext(PLUGIN_SOURCE, context, { filename: 'QuickTranslator.js' });

    function missing() {
        if (typeof handlers.beforeunload === 'function') handlers.beforeunload();
        const file = path.join(dir, 'missing.json');
        if (!fs.existsSync(file)) return {};
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }

    return {
        dir: dir,
        window: window,
        Game_Message: Game_Message,
        Window_Base: Window_Base,
        Game_Actor: Game_Actor,
        DataManager: DataManager,
        runTimers: runTimers,
        missing: missing
    };
}

function missingKeys(env) {
    return Object.keys(env.missing()).sort();
}

// ============================================================================
// 场景 1：说话人名先被翻译，拼接后的多行块仍要按原始整块命中
// ============================================================================
test('speaker name translated first: whole multi-line key is restored via alias', function() {
    const env = boot({
        'シマエナガ': '北海道长尾山雀',
        'シマエナガ\n「ここは役所です。\nどのような手続きをご希望ですか？」':
            '北海道长尾山雀\n「这里是役所。\n请问您要办理什么手续？」'
    });
    const gm = new env.Game_Message();
    gm.setSpeakerName('シマエナガ');
    assert.strictEqual(gm.speakerName(), '北海道长尾山雀');

    const composite = gm.speakerName() + '\n「ここは役所です。\nどのような手続きをご希望ですか？」';
    const win = new env.Window_Base();
    win.drawTextEx(composite, 0, 0, 640);

    assert.strictEqual(
        win.lastDrawEx.text,
        '北海道长尾山雀\n「这里是役所。\n请问您要办理什么手续？」'
    );
    assert.deepStrictEqual(missingKeys(env), []);
});

// ============================================================================
// 场景 2：整块未命中时，剥离首行后对剩余连续多行子块查表
// ============================================================================
test('newline fallback: strip translated first line, match remaining multi-line block', function() {
    const env = boot({
        'シマエナガ': '北海道长尾山雀',
        '「ここは役所です。\nどのような手続きをご希望ですか？」':
            '「这里是役所。\n请问您要办理什么手续？」'
    });
    const gm = new env.Game_Message();
    gm.setSpeakerName('シマエナガ');
    const composite = gm.speakerName() + '\n「ここは役所です。\nどのような手続きをご希望ですか？」';

    const win = new env.Window_Base();
    win.drawTextEx(composite, 0, 0, 640);

    assert.strictEqual(
        win.lastDrawEx.text,
        '北海道长尾山雀\n「这里是役所。\n请问您要办理什么手续？」'
    );
    assert.deepStrictEqual(missingKeys(env), []);
});

// ============================================================================
// 场景 2b：说话人名作为首行进入消息状态时，allText 仍能用原始整块命中
// ============================================================================
test('speaker name stored as the first message line still matches the whole block', function() {
    const env = boot({
        'シマエナガ\n「ここは役所です。\nどのような手続きをご希望ですか？」':
            '北海道长尾山雀\n「这里是役所。\n请问您要办理什么手续？」'
    });
    const gm = new env.Game_Message();
    gm.add('シマエナガ');
    gm.add('「ここは役所です。');
    gm.add('どのような手続きをご希望ですか？」');

    assert.strictEqual(
        gm.allText(),
        '北海道长尾山雀\n「这里是役所。\n请问您要办理什么手续？」'
    );
    assert.deepStrictEqual(missingKeys(env), []);
});

// ============================================================================
// 场景 2c：首行命中、正文未命中时，必须收集未命中的日文子块并落盘
// ============================================================================
const GODDESS_BODY =
    ' 「わあ～♡ありがとうございます～！\n' +
    'いきなり異世界に召喚して無茶振りかましてるのに\n' +
    '二つ返事で承諾してもらえてほんとによかったです～♡」';

test('partial multi-line hit collects the unhit Japanese body into missing.json', function() {
    const env = boot({ '女神': '女神大人' });
    const gm = new env.Game_Message();
    gm.add('女神');
    gm.add(' 「わあ～♡ありがとうございます～！');
    gm.add('いきなり異世界に召喚して無茶振りかましてるのに');
    gm.add('二つ返事で承諾してもらえてほんとによかったです～♡」');

    // add 阶段不收集；只有整块完全译出时才允许标记为已翻译。
    const all = gm.allText();
    assert.ok(all.indexOf('女神大人') === 0);
    assert.ok(all.indexOf('わあ～♡') >= 0, 'untranslated body must stay visible');

    assert.deepStrictEqual(missingKeys(env), [GODDESS_BODY]);
    assert.ok(fs.existsSync(path.join(env.dir, 'missing.json')), 'missing.json must be written');

    // 下游再经 convertEscapeCharacters / drawTextEx，不能把这次收集丢掉。
    const win = new env.Window_Base();
    const converted = win.convertEscapeCharacters(gm.allText());
    win.drawTextEx(converted, 0, 0, 640);
    assert.deepStrictEqual(missingKeys(env), [GODDESS_BODY]);
});

test('missing.json is generated from add even if allText is never called', function() {
    const env = boot({ '女神': '女神大人' });
    const gm = new env.Game_Message();
    gm.add('女神');
    gm.add(' 「わあ～♡ありがとうございます～！');
    gm.add('いきなり異世界に召喚して無茶振りかましてるのに');
    gm.add('二つ返事で承諾してもらえてほんとによかったです～♡」');

    // 模拟不调用 allText、只读 _texts 的消息插件：finalize 定时器兜底收集并写盘。
    assert.strictEqual(gm._texts[0], '女神大人');
    env.runTimers();
    const file = path.join(env.dir, 'missing.json');
    assert.ok(fs.existsSync(file), 'finalize timer must write missing.json without beforeunload');
    assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))), [GODDESS_BODY]);
    assert.deepStrictEqual(missingKeys(env), [GODDESS_BODY]);
});

test('multi-line dict key matches after trimming per-line leading spaces', function() {
    const env = boot({
        '女神': '女神',
        [GODDESS_BODY.slice(1)]:
            '「哇～♡谢谢您～！\n突然把您召唤到异世界还强人所难\n您却二话不说就答应了，真是太好了～♡」'
    });
    const gm = new env.Game_Message();
    gm.add('女神');
    gm.add(' 「わあ～♡ありがとうございます～！');
    gm.add('いきなり異世界に召喚して無茶振りかましてるのに');
    gm.add('二つ返事で承諾してもらえてほんとによかったです～♡」');

    assert.strictEqual(
        gm.allText(),
        '女神\n「哇～♡谢谢您～！\n突然把您召唤到异世界还强人所难\n您却二话不说就答应了，真是太好了～♡」'
    );
    assert.deepStrictEqual(missingKeys(env), []);
});

// ============================================================================
// 场景 3：add 先逐行命中首行，allText 仍按未变脏的原始多行块查表
// ============================================================================
test('Game_Message.allText matches the original multi-line block, not the per-line result', function() {
    const env = boot({
        '「ここは役所です。': '「这里是役所。',
        '「ここは役所です。\nどのような手続きをご希望ですか？」':
            '「这里是役所。\n请问您要办理什么手续？」'
    });
    const gm = new env.Game_Message();
    gm.add('「ここは役所です。');
    gm.add('どのような手続きをご希望ですか？」');

    // add 阶段只翻译、不收集；整块仍保留原始日文
    assert.strictEqual(gm._texts[0], '「这里是役所。');
    assert.deepStrictEqual(missingKeys(env), []);

    assert.strictEqual(
        gm.allText(),
        '「这里是役所。\n请问您要办理什么手续？」'
    );
    assert.deepStrictEqual(missingKeys(env), []);
});

// ============================================================================
// 场景 4：\N[1] 展开后的中文拼接结果不得二次收集；角色名从 $dataActors 翻译
// ============================================================================
test('expanded \\N[1] translation is not re-collected and actor name is translated', function() {
    const env = boot({
        'シマエナガ': '北海道长尾山雀',
        'たねお': '种子夫',
        '「新しい名前は、\\N[1]大人ですね。\nたしかに、受け付けました」':
            '「新的姓名是，\\N[1]大人，对吧。\n确实，已经受理了」'
    }, {
        actors: [null, { name: 'たねお', nickname: '', profile: '' }]
    });

    env.DataManager.onLoad(env.window.$dataActors);
    assert.strictEqual(env.window.$dataActors[1].name, '种子夫');

    const gm = new env.Game_Message();
    gm.setSpeakerName('シマエナガ');
    gm.add('「新しい名前は、\\N[1]大人ですね。');
    gm.add('たしかに、受け付けました」');
    assert.strictEqual(
        gm.allText(),
        '「新的姓名是，\\N[1]大人，对吧。\n确实，已经受理了」'
    );

    const win = new env.Window_Base();
    const converted = win.convertEscapeCharacters(gm.speakerName() + '\n' + gm.allText());
    assert.ok(converted.indexOf('种子夫') >= 0, '\\N[1] should expand to the translated actor name');
    assert.ok(converted.indexOf('たねお') < 0, 'no Japanese actor name should remain');

    win.drawTextEx(converted, 0, 0, 640);
    assert.deepStrictEqual(missingKeys(env), []);
});

// ============================================================================
// 场景 5：字典缺角色名时只收集人名本身，不收集拼接后的整段译文
// ============================================================================
test('missing Japanese actor name is collected alone, never the Chinese composite', function() {
    const env = boot({
        'シマエナガ': '北海道长尾山雀',
        '「新しい名前は、\\N[1]大人ですね。\nたしかに、受け付けました」':
            '「新的姓名是，\\N[1]大人，对吧。\n确实，已经受理了」'
    }, {
        actors: [null, { name: 'たねお', nickname: '', profile: '' }]
    });

    env.DataManager.onLoad(env.window.$dataActors);
    assert.deepStrictEqual(missingKeys(env), ['たねお']);

    const gm = new env.Game_Message();
    gm.setSpeakerName('シマエナガ');
    gm.add('「新しい名前は、\\N[1]大人ですね。');
    gm.add('たしかに、受け付けました」');

    const win = new env.Window_Base();
    const converted = win.convertEscapeCharacters(gm.speakerName() + '\n' + gm.allText());
    win.drawTextEx(converted, 0, 0, 640);

    assert.deepStrictEqual(missingKeys(env), ['たねお']);
});

// ============================================================================
// 场景 5a：JsonEx 还原的未入队角色槽位是 null，读档提取不得因此抛错
// ============================================================================
test('extractSaveContents skips null actor slots and translates loaded actors', function() {
    const env = boot({
        'たねお': '种子夫',
        'タネコ': '种子子'
    });
    env.window.$gameActors = {
        _data: [
            null,
            { _actorId: 1, _name: 'たねお', _nickname: '', _profile: '' },
            null,
            { _actorId: 2, _name: 'タネコ', _nickname: '', _profile: '' }
        ]
    };

    env.DataManager.extractSaveContents({});

    assert.deepStrictEqual(
        env.window.$gameActors._data.map(function(actor) { return actor && actor._name; }),
        [null, '种子夫', null, '种子子']
    );
});

// ============================================================================
// 场景 5b：\N[1] 已被外部展开但未经过 convert Hook 时，仍不得收集中文译文行
// ============================================================================
test('expanded actor-name template is recognized without convert Hook marking', function() {
    const env = boot({
        'シマエナガ': '北海道长尾山雀',
        '「新しい名前は、\\N[1]大人ですね。\nたしかに、受け付けました」':
            '「新的姓名是，\\N[1]大人，对吧。\n确实，已经受理了」'
    }, {
        actors: [null, { name: 'たねお', nickname: '', profile: '' }]
    });
    env.DataManager.onLoad(env.window.$dataActors);

    const gm = new env.Game_Message();
    gm.setSpeakerName('シマエナガ');
    gm.add('「新しい名前は、\\N[1]大人ですね。');
    gm.add('たしかに、受け付けました」');
    const translatedBlock = gm.allText();
    const composite = '北海道长尾山雀\n' + translatedBlock.replace('\\N[1]', 'たねお');

    const win = new env.Window_Base();
    win.drawTextEx(composite, 0, 0, 640);
    assert.deepStrictEqual(missingKeys(env), ['たねお']);
});

// ============================================================================
// 场景 6：纯中文（含 CJK 标点/通用汉字）不得被判为日文并收集
// ============================================================================
test('pure Chinese, kanji-only text and CJK punctuation are not collected', function() {
    const env = boot({});
    const win = new env.Window_Base();

    win.drawTextEx('北海道长尾山雀\n「那么，请将新的姓名\n填写在这张表格上」', 0, 0, 640);
    win.drawText('漢字');
    win.drawText('「」。、');
    assert.deepStrictEqual(missingKeys(env), []);

    win.drawText('ここは役所です');
    win.drawText('カタカナ');
    assert.deepStrictEqual(missingKeys(env), ['ここは役所です', 'カタカナ'].sort());
});

// ============================================================================
// 场景 7：单字符假名 "を" 是逐字绘制/参数调用的碎片，不进入 missing
// ============================================================================
test('isolated single-kana fragment "を" is not collected', function() {
    const env = boot({});
    const win = new env.Window_Base();

    win.drawText('を');
    win.drawTextEx('を');
    assert.strictEqual(win.lastDraw.text, 'を');
    assert.deepStrictEqual(missingKeys(env), []);
});

// ============================================================================
// 场景 8：分段匹配只按整条原文收集；任一段命中即不收集
// ============================================================================
test('segmented match with one hit never collects the full text or fragments', function() {
    const env = boot({ '魔王': '魔王大人' });
    const win = new env.Window_Base();

    win.drawTextEx('\\C[18]魔王\\C[0]が復活した！', 0, 0, 640);
    assert.ok(win.lastDrawEx.text.indexOf('魔王大人') >= 0);
    assert.deepStrictEqual(missingKeys(env), []);
});

// ============================================================================
// 场景 10：MTool 未翻译条目 value === key，不得当作译文短路多行整块匹配
// ============================================================================
test('MTool identity placeholders do not mask a real multi-line translation', function() {
    const env = boot({
        '女神': '女神',
        '「私はこの世界を管理している女神です♡': '「私はこの世界を管理している女神です♡',
        'とつぜんですが、あなたに大事なお願いがあって': 'とつぜんですが、あなたに大事なお願いがあって',
        'こちらの世界に召喚させてもらいました♡」': 'こちらの世界に召喚させてもらいました♡」',
        ['「私はこの世界を管理している女神です♡\n' +
        'とつぜんですが、あなたに大事なお願いがあって\n' +
        'こちらの世界に召喚させてもらいました♡」']:
            '「我是管理这个世界的女神♡\n虽然很突然，但我有件重要的事情想拜托您，\n所以才把您召唤到了这个世界♡」'
    });
    const gm = new env.Game_Message();
    gm.add('\\F[megami1]女神');
    gm.add('「私はこの世界を管理している女神です♡');
    gm.add('とつぜんですが、あなたに大事なお願いがあって');
    gm.add('こちらの世界に召喚させてもらいました♡」');

    const all = gm.allText();
    assert.ok(all.indexOf('我是管理这个世界的女神') >= 0, 'multi-line translation must win');
    assert.ok(all.indexOf('とつぜんですが') < 0, 'identity placeholder must not block the block lookup');
    assert.deepStrictEqual(missingKeys(env), []);
});

test('identity placeholder counts as untranslated and is collected', function() {
    const env = boot({ 'ここは役所です': 'ここは役所です' });
    const win = new env.Window_Base();

    win.drawText('ここは役所です');
    assert.strictEqual(win.lastDraw.text, 'ここは役所です');
    assert.deepStrictEqual(missingKeys(env), ['ここは役所です']);
});

// ============================================================================
// 场景 9：从存档恢复的 Game_Actor 名字 getter 也翻译
// ============================================================================
test('Game_Actor name getter translates names loaded from old saves', function() {
    const env = boot({ 'たねお': '种子夫' });
    const actor = new env.Game_Actor('たねお');
    assert.strictEqual(actor.name(), '种子夫');
    assert.deepStrictEqual(missingKeys(env), []);
});

// ============================================================================
// 场景 11：\n[1]（小写）与 \N[1]（大写）必须互相命中，且模板/展开后不二次收集
// ============================================================================
const NAME_TEMPLATE_LINES = [
    '「新しい名前は、\\n[1]大人ですね。',
    'たしかに、受け付けました」'
];
const NAME_TEMPLATE_RESULT = '「新的姓名是，\\N[1]大人，对吧。\n确实，已经受理了」';

test('lowercase \\n[1] message matches an uppercase \\N[1] dict template', function() {
    const env = boot({
        'たねお': '种子夫',
        '「新しい名前は、\\N[1]大人ですね。\nたしかに、受け付けました」':
            '「新的姓名是，\\N[1]大人，对吧。\n确实，已经受理了」'
    }, {
        actors: [null, { name: 'たねお', nickname: '', profile: '' }]
    });
    env.DataManager.onLoad(env.window.$dataActors);

    const gm = new env.Game_Message();
    gm.add(NAME_TEMPLATE_LINES[0]);
    gm.add(NAME_TEMPLATE_LINES[1]);
    assert.strictEqual(gm.allText(), NAME_TEMPLATE_RESULT);

    const win = new env.Window_Base();
    const converted = win.convertEscapeCharacters(gm.allText());
    assert.ok(converted.indexOf('种子夫') >= 0, 'lowercase \\n[1] must still expand at runtime');
    win.drawTextEx(converted, 0, 0, 640);
    assert.deepStrictEqual(missingKeys(env), []);
});

test('uppercase \\N[1] message matches a lowercase \\n[1] dict template', function() {
    const env = boot({
        'たねお': '种子夫',
        '「新しい名前は、\\n[1]大人ですね。\nたしかに、受け付けました」':
            '「新的姓名是，\\n[1]大人，对吧。\n确实，已经受理了」'
    }, {
        actors: [null, { name: 'たねお', nickname: '', profile: '' }]
    });
    env.DataManager.onLoad(env.window.$dataActors);

    const gm = new env.Game_Message();
    gm.add('「新しい名前は、\\N[1]大人ですね。');
    gm.add('たしかに、受け付けました」');
    assert.strictEqual(
        gm.allText(),
        '「新的姓名是，\\n[1]大人，对吧。\n确实，已经受理了」'
    );

    const win = new env.Window_Base();
    const converted = win.convertEscapeCharacters(gm.allText());
    assert.ok(converted.indexOf('种子夫') >= 0);
    win.drawTextEx(converted, 0, 0, 640);
    assert.deepStrictEqual(missingKeys(env), []);
});

// ============================================================================
// 场景 12：MTool 多行键从最后一个控制符之后开始（键里没有 \n[1]），仍要命中
// ============================================================================
const MTOOL_SPLIT_DICT = {
    '「ここが': '「这里就是',
    'さんのお家です♡\nさっそく中へ入ってみてください♡驚きますよ～♡\nなにせいも……驚きますよ～♡」':
        '先生的家哦♡\n请马上进去看看吧♡会吓一跳哦～♡\n毕竟妹妹也……会吓一跳哦～♡」',
    '「うふふ♡': '「呵呵♡',
    'さんならそう言ってくれると信じていましたよ♡\nよかったですね、ひまりさん♡」':
        '只要是你的话，我就相信您一定会这么说呢♡\n太好了呢，日鞠小姐♡」',
    'さん♡まあ、なんて素敵なお名前♡\nまさに種馬になるために生まれてきたような名前ですね♡」':
        '您♡哎呀，这是多么美妙的名字♡\n简直就像是为了成为种马而出生的名字呢♡」'
};

test('MTool multi-line keys starting after the last \\n[id] control are matched', function() {
    const env = boot(MTOOL_SPLIT_DICT);

    const house = new env.Game_Message();
    house.add('「ここが\\n[1]さんのお家です♡');
    house.add('さっそく中へ入ってみてください♡驚きますよ～♡');
    house.add('なにせいも……驚きますよ～♡」');
    assert.strictEqual(
        house.allText(),
        '「这里就是\\n[1]先生的家哦♡\n请马上进去看看吧♡会吓一跳哦～♡\n毕竟妹妹也……会吓一跳哦～♡」'
    );

    const praise = new env.Game_Message();
    praise.add('「うふふ♡');
    praise.add('\\n[1]さんならそう言ってくれると信じていましたよ♡');
    praise.add('よかったですね、ひまりさん♡」');
    assert.strictEqual(
        praise.allText(),
        '「呵呵♡\n\\n[1]只要是你的话，我就相信您一定会这么说呢♡\n太好了呢，日鞠小姐♡」'
    );

    const name = new env.Game_Message();
    name.add('「\\n[1]さん♡まあ、なんて素敵なお名前♡');
    name.add('まさに種馬になるために生まれてきたような名前ですね♡」');
    assert.strictEqual(
        name.allText(),
        '「\\n[1]您♡哎呀，这是多么美妙的名字♡\n简直就像是为了成为种马而出生的名字呢♡」'
    );

    assert.deepStrictEqual(missingKeys(env), []);
});

// ============================================================================
// 场景 12b：局部译文拼接串（控制符已展开成人名）不得写进 missing.json
// ============================================================================
test('partially translated composite with expanded names is never collected', function() {
    const env = boot({
        'たねお': '种子夫',
        'ひまり': '日鞠',
        'でほぐし、精液でヌルヌルに\nすることで出産をサポートできますよ！」':
            '用性爱棒来放松，再用精液弄得滑溜溜的\n这样就能帮助生产哦！」'
    }, {
        actors: [
            null,
            { name: 'たねお', nickname: '', profile: '' },
            { name: 'ひまり', nickname: '', profile: '' }
        ]
    });
    env.DataManager.onLoad(env.window.$dataActors);

    const gm = new env.Game_Message();
    gm.add('\\n[1]を\\n[2]でほぐし、精液でヌルヌルに');
    gm.add('することで出産をサポートできますよ！」');
    const all = gm.allText();
    assert.ok(all.indexOf('用性爱棒来放松') >= 0, 'suffix block must be translated');

    const win = new env.Window_Base();
    const converted = win.convertEscapeCharacters(all);
    assert.ok(converted.indexOf('种子夫') >= 0 && converted.indexOf('日鞠') >= 0);
    win.drawTextEx(converted, 0, 0, 640);

    assert.deepStrictEqual(missingKeys(env), []);
});

// ============================================================================
// 场景 13：波浪线 U+301C / U+FF5E 的差异只在精确查表失败后兜底
// ============================================================================
test('wave dash variant 〜 in the dict matches ～ in the game text', function() {
    const env = boot({ '「わあ\u301c\u2661': '「哇\u301c\u2661' });
    const win = new env.Window_Base();
    win.drawTextEx('「わあ\uff5e\u2661', 0, 0, 640);
    assert.strictEqual(win.lastDrawEx.text, '「哇\u301c\u2661');
    assert.deepStrictEqual(missingKeys(env), []);
});

// ============================================================================
// 场景 14：GameFont (mplus) 缺简体字，standardFontFace 必须回退到中文字体
// ============================================================================
test('standardFontFace prefers Chinese fonts and keeps GameFont as fallback', function() {
    const env = boot({});
    const face = new env.Window_Base().standardFontFace();

    assert.strictEqual(typeof face, 'string');
    assert.notStrictEqual(face, 'GameFont');
    ['Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', 'SimHei', 'GameFont', 'sans-serif']
        .forEach(function(name) {
            assert.ok(face.indexOf(name) >= 0, name + ' missing from: ' + face);
        });
    assert.ok(
        face.indexOf('GameFont') > face.indexOf('SimHei'),
        'GameFont must be a fallback behind Chinese fonts: ' + face
    );
});

const done = (async function main() {
    let failed = 0;
    for (const item of tests) {
        try {
            await item.fn();
            console.log('ok - ' + item.name);
        } catch (err) {
            failed++;
            console.error('not ok - ' + item.name);
            console.error(err && err.stack ? err.stack : err);
        }
    }
    for (const dir of tempDirs) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) {}
    }
    if (failed > 0) {
        throw new Error(failed + ' test(s) failed');
    }
    console.log('\n' + tests.length + ' tests passed');
})();

if (typeof module !== 'undefined' && module.exports) module.exports = done;
