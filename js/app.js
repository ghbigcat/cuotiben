/* 错题本 · 拍 录 做 批 斩  —— 主程序 */
(function () {
  'use strict';

  /* ============ 状态 ============ */
  var S = {
    questions: [],
    subjects: [],
    codes: [],
    knowledge: {},     // { 学科: [知识点] }
    settings: {},
    view: 'today',
    filter: { subject: '全部学科', tab: 'all' },
    pending: { img: null, ai: null },
    redo: null,
    busy: false
  };

  var LS_KEYS = { subjects: 'subjects', codes: 'codes', knowledge: 'knowledge', settings: 'settings' };

  var DEF_SUBJECTS = ['语文', '数学', '英语', '物理', '化学', '生物', '道法', '历史', '地理'];

  var DEF_CODES = [
    { id: 'E1', name: '概念不清', desc: '定义、边界条件记混' },
    { id: 'E2', name: '公式记错', desc: '公式写错、适用条件不明' },
    { id: 'E3', name: '审题失误', desc: '看漏条件、问非所答' },
    { id: 'E4', name: '计算错误', desc: '移项、符号、算错' },
    { id: 'E5', name: '方法选错', desc: '思路方向就不对' },
    { id: 'E6', name: '步骤跳步', desc: '中间步骤省略导致漏解' },
    { id: 'E7', name: '单位换算', desc: '单位没统一、量纲错' },
    { id: 'E8', name: '时间不够', desc: '会做但没做完' },
    { id: 'E9', name: '答题不规范', desc: '术语缺失、不分点、只抄材料' }
  ];

  var DEF_KNOWLEDGE = {
    '数学': ['分式方程与增根', '一元二次方程', '函数图像与性质', '全等三角形', '圆的切线'],
    '物理': ['凸透镜成像', '压强与浮力', '串并联电路', '欧姆定律', '功与功率'],
    '化学': ['化学方程式配平', '质量守恒', '溶液浓度', '酸碱盐性质', '气体制备'],
    '英语': ['时态辨析', '非谓语动词', '定语从句', '完形填空', '书面表达'],
    '语文': ['阅读作用题', '文言实词', '病句修改', '作文审题', '诗歌鉴赏'],
    '生物': ['光合作用与呼吸作用', '细胞结构', '遗传规律', '生态系统', '实验变量'],
    '道法': ['权利义务', '材料题答题结构', '法律与秩序', '国情国策', '价值判断'],
    '历史': ['近代化探索', '时间线梳理', '事件影响', '史料分析', '改革开放'],
    '地理': ['降水空间分布', '气候类型', '等高线判读', '区域特征', '人口迁移']
  };

  var DEF_SETTINGS = {
    apiBase: '',
    apiKey: '',
    model: '',
    dailyQuota: 3,
    dailyCap: 15
  };

  /* ============ 小工具 ============ */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function uid() {
    return 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  var DAY = 86400000;
  function today0() {
    var d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime();
  }
  function dayKey(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }
  function fmtShort(ts) {
    if (!ts) return '';
    var d = new Date(ts), n = new Date();
    var diff = Math.round((new Date(ts).setHours(0, 0, 0, 0) - today0()) / DAY);
    if (diff === 0) return '今天';
    if (diff === 1) return '明天';
    if (diff === -1) return '昨天';
    if (diff < -1 && diff > -8) return Math.abs(diff) + ' 天前';
    if (diff > 1 && diff < 8) return diff + ' 天后';
    return (d.getMonth() + 1) + '/' + d.getDate();
  }
  function toast(msg, ms) {
    var t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.hidden = true; }, ms || 1900);
  }

  /* ============ 图片压缩 ============ */
  function compressImage(file, maxSide, quality) {
    maxSide = maxSide || 1400;
    quality = quality || 0.8;
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type || '')) return reject(new Error('不是图片文件'));
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var w = img.naturalWidth, h = img.naturalHeight;
        var scale = Math.min(1, maxSide / Math.max(w, h));
        var cw = Math.round(w * scale), ch = Math.round(h * scale);
        var cv = document.createElement('canvas');
        cv.width = cw; cv.height = ch;
        var ctx = cv.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, cw, ch);
        ctx.drawImage(img, 0, 0, cw, ch);
        try {
          resolve(cv.toDataURL('image/jpeg', quality));
        } catch (e) { reject(e); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
      img.src = url;
    });
  }

  /* ============ AI 调用 ============ */
  function aiReady() {
    return !!(S.settings.apiKey && S.settings.model && S.settings.apiBase);
  }
  function aiEndpoint() {
    var b = (S.settings.apiBase || '').trim().replace(/\/+$/, '');
    if (!b) return '';
    if (/\/chat\/completions$/.test(b)) return b;
    return b + '/chat/completions';
  }
  function aiChat(messages, maxTokens) {
    var url = aiEndpoint();
    if (!url) return Promise.reject(new Error('未配置接口地址'));
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + S.settings.apiKey
      },
      body: JSON.stringify({
        model: S.settings.model,
        messages: messages,
        temperature: 0.2,
        max_tokens: maxTokens || 1200
      })
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error('接口返回 ' + res.status + '：' + t.slice(0, 140));
        });
      }
      return res.json();
    }).then(function (data) {
      var c = data && data.choices && data.choices[0];
      var txt = c && c.message && c.message.content;
      if (Array.isArray(txt)) {
        txt = txt.map(function (p) { return p.text || ''; }).join('');
      }
      return txt || '';
    });
  }
  function extractJSON(text) {
    if (!text) return null;
    var s = String(text).replace(/```json/gi, '```').replace(/```/g, '');
    var a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
  }
  function imagePart(dataUrl) {
    return { type: 'image_url', image_url: { url: dataUrl } };
  }

  var PROMPT_RECOGNIZE = [
    '你是初中错题录入助手。请识别图片中的这道题，只输出一个 JSON 对象，不要任何解释。',
    '字段：',
    'stem: 完整题干文字（含选项，可换行）；看不清的用 [?] 代替',
    'subject: 学科，只能是 语文/数学/英语/物理/化学/生物/道法/历史/地理 之一',
    'knowledge: 知识点，6字以内，如「分式方程增根」「凸透镜成像」',
    'errorCode: 错因码编号。E1概念不清 E2公式记错 E3审题失误 E4计算错误 E5方法选错 E6步骤跳步 E7单位换算 E8时间不够 E9答题不规范',
    'difficulty: 1易 2中 3难',
    'reason: 一句话说明这道题最容易错在哪'
  ].join('\n');

  function aiRecognize(dataUrl) {
    return aiChat([
      { role: 'user', content: [{ type: 'text', text: PROMPT_RECOGNIZE }, imagePart(dataUrl)] }
    ], 800).then(function (txt) {
      var j = extractJSON(txt);
      if (!j) throw new Error('识别结果不是有效 JSON');
      return j;
    });
  }

  var PROMPT_JUDGE = [
    '你是初中老师，正在批改学生的重做。',
    '第一张图是原题（含原答案标注或不含），第二张图是学生这次重做的作答。',
    '只输出一个 JSON：',
    '{"ok": true/false, "reason": "一句话说明对或错在哪", "answer": "正确答案要点，40字内"}',
    '判断从严：最终结果错、关键步骤漏、单位缺失导致错误，都算 false。'
  ].join('\n');

  function aiJudge(qImg, ansImg) {
    var content = [{ type: 'text', text: PROMPT_JUDGE }];
    if (qImg) content.push(imagePart(qImg));
    if (ansImg) content.push(imagePart(ansImg));
    return aiChat([{ role: 'user', content: content }], 600).then(function (txt) {
      var j = extractJSON(txt);
      if (!j) throw new Error('判定结果不是有效 JSON');
      return j;
    });
  }

  var PROMPT_VARIANT = [
    '你是初中出题老师。基于下面这道错题，出 2 道同类变式题，用来检验同一个知识点是否真的掌握了。',
    '要求：同一知识点、同等难度、换数字或换情境，不要出原题；每题给出答案要点。',
    '只输出 JSON：{"variants":[{"stem":"题目","answer":"答案要点"}]}'
  ].join('\n');

  function aiVariants(q) {
    var body = '学科：' + q.subject + '\n知识点：' + q.knowledge + '\n原题：\n' + (q.stem || q.note || '（无文本）');
    return aiChat([
      { role: 'user', content: [{ type: 'text', text: PROMPT_VARIANT + '\n\n' + body }] }
    ], 1200).then(function (txt) {
      var j = extractJSON(txt);
      if (!j || !j.variants) throw new Error('变式题生成失败');
      return j.variants;
    });
  }

  /* ============ 存储读写 ============ */
  function loadAll() {
    return Store.init().then(function () {
      return Promise.all([
        Store.allQuestions(),
        Store.kvGet(LS_KEYS.subjects, null),
        Store.kvGet(LS_KEYS.codes, null),
        Store.kvGet(LS_KEYS.knowledge, null),
        Store.kvGet(LS_KEYS.settings, null)
      ]);
    }).then(function (r) {
      S.questions = r[0] || [];
      S.subjects = r[1] || DEF_SUBJECTS.slice();
      S.codes = r[2] || DEF_CODES.slice();
      S.knowledge = r[3] || JSON.parse(JSON.stringify(DEF_KNOWLEDGE));
      S.settings = Object.assign({}, DEF_SETTINGS, r[4] || {});
      // 首次写入默认值
      var jobs = [];
      if (!r[1]) jobs.push(Store.kvSet(LS_KEYS.subjects, S.subjects));
      if (!r[2]) jobs.push(Store.kvSet(LS_KEYS.codes, S.codes));
      if (!r[3]) jobs.push(Store.kvSet(LS_KEYS.knowledge, S.knowledge));
      if (!r[4]) jobs.push(Store.kvSet(LS_KEYS.settings, S.settings));
      return Promise.all(jobs);
    });
  }
  function saveSettings() { return Store.kvSet(LS_KEYS.settings, S.settings); }
  function saveCodes() { return Store.kvSet(LS_KEYS.codes, S.codes); }
  function saveSubjects() { return Store.kvSet(LS_KEYS.subjects, S.subjects); }
  function saveKnowledge() { return Store.kvSet(LS_KEYS.knowledge, S.knowledge); }

  /* ============ 业务规则 ============ */
  function codeName(id) {
    var c = S.codes.filter(function (x) { return x.id === id; })[0];
    return c ? c.name : id;
  }
  function isRepeat(q) { return (q.wrongCount || 1) >= 2; }
  function dueOf(q) { return q.dueAt || q.createdAt; }
  function isDue(q) {
    return q.status === 'active' && dueOf(q) < today0() + DAY;
  }
  function dueList() {
    return S.questions.filter(isDue).sort(function (a, b) {
      var d = (b.wrongCount || 1) - (a.wrongCount || 1);
      if (d) return d;
      return dueOf(a) - dueOf(b);
    });
  }

  /* 录入一题 */
  function createQuestion(d) {
    var now = Date.now();
    var q = {
      id: uid(),
      subject: d.subject,
      knowledge: d.knowledge || '未分类',
      errorCode: d.errorCode || '',
      difficulty: d.difficulty || 2,
      source: d.source || '',
      stem: d.stem || '',
      image: d.image || '',
      note: d.note || '',
      createdAt: now,
      status: 'active',
      wrongCount: 1,
      streak: 0,
      lastOkAt: 0,
      dueAt: today0() + DAY,     // 第二天才重做
      attempts: [],
      variantOf: d.variantOf || null
    };
    S.questions.push(q);
    return Store.putQuestion(q).then(function () { return q; });
  }

  /* 判定一次重做 */
  function gradeQuestion(q, ok, judge, evidence) {
    var now = Date.now();
    q.attempts = q.attempts || [];
    q.attempts.push({ at: now, ok: !!ok, judge: judge || 'manual', evidence: evidence || '' });
    if (ok) {
      q.streak = (q.streak || 0) + 1;
      q.lastOkAt = now;
      q.dueAt = now + (q.streak >= 2 ? 3 : 2) * DAY;
      if (q.streak >= 3) q.dueAt = now + 7 * DAY;
    } else {
      q.wrongCount = (q.wrongCount || 1) + 1;
      q.streak = 0;
      q.dueAt = now + DAY;
    }
    return Store.putQuestion(q).then(function () { return q; });
  }

  function cutQuestion(q) {
    q.status = 'mastered';
    q.masteredAt = Date.now();
    return Store.putQuestion(q);
  }

  /* ============ 视图切换 ============ */
  var TITLES = {
    today: ['今天', '拍 · 录 · 做 · 批 · 斩'],
    add: ['录题', '拍一张，自动归档'],
    bank: ['题库', '按知识点和错因翻'],
    stats: ['统计', '哪块最薄弱，看得见'],
    settings: ['设置', '识别、错因码、数据'],
    redo: ['重做', '不看答案，先自己做']
  };

  function go(view) {
    S.view = view;
    $$('.view').forEach(function (v) { v.hidden = true; });
    var el = $('#view-' + view);
    if (el) el.hidden = false;
    $$('#tabbar button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-view') === view);
    });
    var t = TITLES[view] || ['', ''];
    $('#pageTitle').textContent = t[0];
    $('#pageSub').textContent = t[1];
    $('#btnQuickAdd').classList.toggle('hide', view === 'add' || view === 'redo');
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });

    if (view === 'today') renderToday();
    if (view === 'add') renderAdd();
    if (view === 'bank') renderBank();
    if (view === 'stats') renderStats();
    if (view === 'settings') renderSettings();
    if (view === 'redo') renderRedo();
  }

  /* ============ 今天 ============ */
  function renderToday() {
    var list = dueList();
    var active = S.questions.filter(function (q) { return q.status === 'active'; });
    var reps = active.filter(isRepeat);
    var mastered = S.questions.filter(function (q) { return q.status === 'mastered'; });
    var quota = S.settings.dailyQuota || 3;
    var cap = S.settings.dailyCap || 15;
    var todayDone = S.questions.filter(function (q) {
      return (q.attempts || []).some(function (a) { return dayKey(a.at) === dayKey(Date.now()); });
    }).length;
    var shown = list.slice(0, cap);

    var hero = '' +
      '<div class="hero">' +
      '<div class="hero-kicker">今天要做</div>' +
      '<div class="hero-num">' + list.length + '<small>题待重做</small></div>' +
      '<div class="hero-row">' +
      '<span>建议 <b>' + Math.min(quota, list.length) + '</b> 题</span>' +
      '<span>反复错 <b>' + reps.length + '</b> 道</span>' +
      '<span>已斩 <b>' + mastered.length + '</b> 道</span>' +
      '</div>' +
      '<div class="hero-actions">' +
      '<button class="btn btn-primary on-dark" id="btnStartRedo"' + (list.length ? '' : ' disabled') + '>开始重做</button>' +
      '<button class="btn btn-ghost on-dark" id="btnGoAdd">拍题录入</button>' +
      '</div>' +
      '</div>' +
      '<div class="stat-grid">' +
      '<div class="stat-cell"><b>' + active.length + '</b><span>在册错题</span></div>' +
      '<div class="stat-cell warn"><b>' + reps.length + '</b><span>反复错</span></div>' +
      '<div class="stat-cell"><b>' + todayDone + '</b><span>今日已练</span></div>' +
      '</div>';

    $('#todayHero').innerHTML = hero;

    var body = '';
    if (!shown.length) {
      body = '<div class="empty"><div class="ico">✓</div><p>今天没有待重做的题</p>' +
        '<small>去拍一道今天卷子上的错题，或者载入示例看看怎么用</small>' +
        '<div class="btn-row" style="max-width:280px;margin:14px auto 0">' +
        '<button class="btn btn-primary btn-sm" id="emptyAdd">拍题</button>' +
        '<button class="btn btn-ghost btn-sm" id="emptyDemo">载入示例</button>' +
        '</div></div>';
    } else {
      body = '<div class="block-title"><h2>待重做</h2><span class="side">按错得多排序</span></div>';
      body += shown.map(function (q) { return qCardHTML(q, 'redo'); }).join('');
      if (list.length > cap) {
        body += '<div class="footnote">还有 ' + (list.length - cap) + ' 道排在后面。每日封顶 ' + cap + ' 题，做多了记不住。</div>';
      }
    }
    $('#todayList').innerHTML = body;
    $('#todayFoot').innerHTML = '规则：连对两次（间隔 3 天以上）＋ 讲得清，才可以把这道题斩掉。';

    var b1 = $('#btnStartRedo');
    if (b1) b1.onclick = startRedo;
    var b2 = $('#btnGoAdd');
    if (b2) b2.onclick = function () { go('add'); };
    var b3 = $('#emptyAdd');
    if (b3) b3.onclick = function () { go('add'); };
    var b4 = $('#emptyDemo');
    if (b4) b4.onclick = loadDemo;
  }

  function qCardHTML(q, mode) {
    var thumb = q.image
      ? '<div class="thumb"><img src="' + q.image + '" alt=""></div>'
      : '<div class="thumb"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 6.5h14M5 12h10M5 17.5h7"/></svg></div>';
    var tags = '<span class="tag">' + esc(q.subject) + '</span>';
    if (q.knowledge) tags += '<span class="tag code">' + esc(q.knowledge) + '</span>';
    if (q.errorCode) tags += '<span class="tag gray">' + esc(q.errorCode) + '</span>';
    if (isRepeat(q) && q.status === 'active') tags += '<span class="tag rep">反复错 ' + q.wrongCount + '</span>';
    if (q.status === 'mastered') tags += '<span class="tag done">已斩</span>';

    var title = q.stem ? esc(q.stem).slice(0, 120) : (q.knowledge ? esc(q.knowledge) + ' · 图形题' : '（无题干文本）');
    var meta = '';
    if (mode === 'redo') {
      var d = dueOf(q);
      var late = d < today0();
      meta = '<div class="q-meta"><span class="due' + (late ? ' late' : '') + '">' + (late ? '已逾期 ' + fmtShort(d) : fmtShort(d) + '到期') + '</span><span>已错 ' + (q.wrongCount || 1) + ' 次</span></div>';
    } else {
      meta = '<div class="q-meta"><span>' + (q.source ? esc(q.source) + ' · ' : '') + fmtShort(q.createdAt) + '</span><span>错 ' + (q.wrongCount || 1) + ' 次</span><span>' + (q.attempts || []).length + ' 次重做</span></div>';
    }
    return '<div class="qcard' + (isRepeat(q) && q.status === 'active' ? ' repeat' : '') + '" data-id="' + q.id + '">' +
      thumb + '<div class="q-main"><div class="q-line1">' + tags + '</div>' +
      '<div class="q-title">' + title + '</div>' + meta + '</div></div>';
  }

  /* ============ 录题 ============ */
  function renderAdd() {
    if (!S.pending.subject) S.pending.subject = S.subjects[0] || '数学';
    renderSubjectChips();
    renderCodeChips();
    renderKnowledgeList();
    updateAIState();
    updatePreview();
  }

  function renderSubjectChips() {
    var cur = S.pending.subject || S.subjects[0];
    $('#subjectChips').innerHTML = S.subjects.map(function (s) {
      return '<button type="button" class="chip' + (s === cur ? ' on' : '') + '" data-sub="' + esc(s) + '">' + esc(s) + '</button>';
    }).join('');
  }
  function renderCodeChips() {
    var cur = S.pending.code || '';
    $('#codeChips').innerHTML = S.codes.map(function (c) {
      return '<button type="button" class="chip' + (c.id === cur ? ' on' : '') + '" data-code="' + esc(c.id) + '" title="' + esc(c.desc || '') + '">' + esc(c.id) + ' ' + esc(c.name) + '</button>';
    }).join('');
  }
  function renderKnowledgeList() {
    var sub = S.pending.subject || '';
    var k = S.knowledge[sub] || [];
    $('#knowledgeList').innerHTML = k.map(function (x) { return '<option value="' + esc(x) + '">'; }).join('');
  }
  function updateAIState() {
    var ok = aiReady();
    $('#aiDot').className = 'dot' + (ok ? ' on' : '');
    $('#aiState').textContent = ok
      ? (S.settings.model + ' 已就绪')
      : '未配置大模型，手动录入也能用';
    $('#btnRecognize').disabled = !ok || !S.pending.img;
  }
  function updatePreview() {
    var has = !!S.pending.img;
    $('#upEmpty').hidden = has;
    $('#upPreview').hidden = !has;
    if (has) $('#previewImg').src = S.pending.img;
    $('#btnRecognize').disabled = !aiReady() || !has;
  }

  function handleFiles(files) {
    var f = files && files[0];
    if (!f) return;
    toast('处理图片…', 900);
    compressImage(f).then(function (dataUrl) {
      S.pending.img = dataUrl;
      updatePreview();
      toast('已添加，可以识别或直接填表');
    }).catch(function (e) {
      toast('图片处理失败：' + e.message);
    });
  }

  function resetAddForm() {
    S.pending.img = null;
    S.pending.ai = null;
    $('#fKnowledge').value = '';
    $('#fSource').value = '';
    $('#fStem').value = '';
    $('#fNote').value = '';
    $('#fileInput').value = '';
    $('#camInput').value = '';
    updatePreview();
  }

  function rememberKnowledge(subject, knowledge) {
    if (!subject || !knowledge) return;
    var arr = S.knowledge[subject] || (S.knowledge[subject] = []);
    if (arr.indexOf(knowledge) < 0) { arr.push(knowledge); saveKnowledge(); }
  }

  function saveQuestion() {
    var knowledge = $('#fKnowledge').value.trim();
    if (!knowledge) { toast('知识点必填'); $('#fKnowledge').focus(); return; }
    if (!S.pending.img && !$('#fStem').value.trim()) {
      toast('至少要有题目图片或题干文本');
      return;
    }
    var d = {
      subject: S.pending.subject,
      knowledge: knowledge,
      errorCode: S.pending.code || '',
      difficulty: S.pending.diff || 2,
      source: $('#fSource').value.trim(),
      stem: $('#fStem').value.trim(),
      note: $('#fNote').value.trim(),
      image: S.pending.img || ''
    };
    createQuestion(d).then(function () {
      // 记住知识点，下次可补全
      rememberKnowledge(d.subject, knowledge);
      resetAddForm();
      toast('已存入题库，明天出现在待重做里');
      go('bank');
    });
  }

  function loadDemo() {
    var now = Date.now();
    var demos = [
      {
        subject: '数学', knowledge: '分式方程与增根', errorCode: 'E6', difficulty: 2, source: '示例',
        stem: '解方程 1/(x-2) + 3 = (x-1)/(x-2)。\n错误做法：两边同乘 (x-2) 得 1 + 3(x-2) = x-1，解得 x = 2，直接写「x = 2」。',
        note: '忘了验根，x=2 让分母为 0，是增根，原方程无解。',
        wrongCount: 2, streak: 0
      },
      {
        subject: '物理', knowledge: '凸透镜成像', errorCode: 'E1', difficulty: 2, source: '示例',
        stem: '物体放在凸透镜前 15 cm 处，透镜焦距 10 cm，所成的像是（　）\nA. 倒立缩小实像　B. 倒立放大实像　C. 正立放大虚像　D. 正立等大实像',
        note: 'f=10, u=15，落在 f 与 2f 之间 → 倒立放大实像，选 B。错选了 A，把 u>2f 的规律套错。',
        wrongCount: 1, streak: 0
      },
      {
        subject: '道法', knowledge: '材料题答题结构', errorCode: 'E9', difficulty: 2, source: '示例',
        stem: '材料：某小区推行垃圾分类，居民按规定分类投放可获积分兑换生活用品。\n设问：结合材料，说明公民应如何正确处理权利与义务的关系。（6 分）',
        note: '只抄了材料，没写「权利义务相统一」的知识点，6 分只得 2 分。',
        wrongCount: 2, streak: 0
      }
    ];
    var jobs = demos.map(function (d) {
      return createQuestion(d).then(function (q) {
        q.wrongCount = d.wrongCount;
        if (d.wrongCount >= 2) q.dueAt = Date.now() - 3600 * 1000;
        return Store.putQuestion(q);
      });
    });
    Promise.all(jobs).then(function () {
      toast('已载入 3 道示例题');
      renderToday();
      go('today');
    });
  }

  /* ============ 题库 ============ */
  function renderBank() {
    var subs = ['全部学科'].concat(S.subjects);
    var tabs = [
      { k: 'all', n: '全部' },
      { k: 'due', n: '待重做' },
      { k: 'repeat', n: '反复错' },
      { k: 'mastered', n: '已斩' }
    ];
    var row1 = subs.map(function (s) {
      return '<button class="chip' + (s === S.filter.subject ? ' on' : '') + '" data-sub="' + esc(s) + '">' + esc(s) + '</button>';
    }).join('');
    var row2 = tabs.map(function (t) {
      return '<button class="chip flat' + (t.k === S.filter.tab ? ' on' : '') + '" data-tab="' + t.k + '">' + t.n + '</button>';
    }).join('');
    $('#bankFilters').innerHTML =
      '<div class="filters">' + row1 + '</div>' +
      '<div class="filters filters-tab">' + row2 + '</div>' +
      '<div class="bank-tools"><button class="btn btn-sm btn-ghost" data-act="pdf">导出 PDF · 打印</button></div>';

    var list = S.questions.slice().sort(function (a, b) { return b.createdAt - a.createdAt; });
    if (S.filter.subject !== '全部学科') {
      list = list.filter(function (q) { return q.subject === S.filter.subject; });
    }
    if (S.filter.tab === 'due') list = list.filter(isDue);
    if (S.filter.tab === 'repeat') list = list.filter(function (q) { return isRepeat(q) && q.status === 'active'; });
    if (S.filter.tab === 'mastered') list = list.filter(function (q) { return q.status === 'mastered'; });

    if (!list.length) {
      $('#bankList').innerHTML = '<div class="empty"><div class="ico">◻</div><p>这个筛选下没有题</p><small>换个学科，或者先去录一道题</small></div>';
      return;
    }
    $('#bankList').innerHTML =
      '<div class="block-title"><h2>共 ' + list.length + ' 道</h2><span class="side">点开看详情</span></div>' +
      list.map(function (q) { return qCardHTML(q, 'bank'); }).join('');
  }

  /* ============ 统计 ============ */
  function renderStats() {
    var all = S.questions;
    var active = all.filter(function (q) { return q.status === 'active'; });
    if (!all.length) {
      $('#statsBody').innerHTML = '<div class="empty"><div class="ico">◔</div><p>还没有数据</p><small>录入几道错题，这里就会出现知识点排行和错因分布</small></div>';
      return;
    }
    var mastered = all.filter(function (q) { return q.status === 'mastered'; });
    var reps = active.filter(isRepeat);
    var totalWrong = all.reduce(function (s, q) { return s + (q.wrongCount || 1); }, 0);
    var attempts = all.reduce(function (s, q) { return s + (q.attempts || []).length; }, 0);
    var okCount = all.reduce(function (s, q) {
      return s + (q.attempts || []).filter(function (a) { return a.ok; }).length;
    }, 0);
    var rate = attempts ? Math.round(okCount / attempts * 100) : 0;

    // 知识点排行
    var kn = {};
    all.forEach(function (q) {
      var key = q.subject + '·' + (q.knowledge || '未分类');
      if (!kn[key]) kn[key] = { sub: q.subject, name: q.knowledge || '未分类', cnt: 0, wrong: 0 };
      kn[key].cnt += 1;
      kn[key].wrong += (q.wrongCount || 1);
    });
    var knRank = Object.keys(kn).map(function (k) { return kn[k]; })
      .sort(function (a, b) { return b.wrong - a.wrong; }).slice(0, 8);
    var maxKn = knRank.length ? knRank[0].wrong : 1;

    // 错因分布
    var cd = {};
    all.forEach(function (q) {
      var k = q.errorCode || '未标';
      cd[k] = (cd[k] || 0) + (q.wrongCount || 1);
    });
    var cdRank = Object.keys(cd).map(function (k) {
      return { id: k, name: k === '未标' ? '未标错因' : codeName(k), v: cd[k] };
    }).sort(function (a, b) { return b.v - a.v; }).slice(0, 6);

    // 近 7 天
    var days = [];
    for (var i = 6; i >= 0; i--) {
      var t0 = today0() - i * DAY;
      var label = (new Date(t0).getMonth() + 1) + '/' + new Date(t0).getDate();
      var n = all.reduce(function (s, q) {
        return s + (q.attempts || []).filter(function (a) {
          var d = new Date(a.at); d.setHours(0, 0, 0, 0);
          return d.getTime() === t0;
        }).length;
      }, 0);
      days.push({ label: label, n: n });
    }
    var maxDay = Math.max.apply(null, days.map(function (d) { return d.n; }).concat([1]));

    var html = '';
    html += '<div class="card"><h3>总览 <span>累计</span></h3>' +
      '<div class="kv-list">' +
      '<div class="kv"><b>' + all.length + '</b><span>在册错题</span></div>' +
      '<div class="kv"><b>' + reps.length + '</b><span>反复错（≥2 次）</span></div>' +
      '<div class="kv"><b>' + totalWrong + '</b><span>累计错误次数</span></div>' +
      '<div class="kv"><b>' + rate + '%</b><span>重做正确率</span></div>' +
      '</div></div>';

    html += '<div class="card"><h3>知识点排行 <span>按累计错次</span></h3>' +
      knRank.map(function (k) {
        var w = Math.max(4, Math.round(k.wrong / maxKn * 100));
        return '<div class="bar-row"><span class="nm" title="' + esc(k.sub + ' ' + k.name) + '">' + esc(k.name) + '</span>' +
          '<span class="tr"><span class="fl' + (k.wrong >= 3 ? ' warn' : '') + '" style="width:' + w + '%"></span></span>' +
          '<span class="vl">' + k.wrong + '</span></div>';
      }).join('') + '</div>';

    html += '<div class="card"><h3>错因分布 <span>按累计错次</span></h3>' +
      cdRank.map(function (c) {
        var w = Math.max(4, Math.round(c.v / cdRank[0].v * 100));
        return '<div class="bar-row"><span class="nm">' + esc(c.name) + '</span>' +
          '<span class="tr"><span class="fl' + (c.id === 'E3' || c.id === 'E9' ? ' warn' : '') + '" style="width:' + w + '%"></span></span>' +
          '<span class="vl">' + c.v + '</span></div>';
      }).join('') + '</div>';

    html += '<div class="card"><h3>近 7 天重做量 <span>共 ' +
      days.reduce(function (s, d) { return s + d.n; }, 0) + ' 次</span></h3>' +
      '<div class="trend">' + days.map(function (d) {
        var h = Math.max(3, Math.round(d.n / maxDay * 100));
        return '<div class="col"><div class="bar' + (d.n ? ' has' : '') + '" style="height:' + h + '%"></div>' +
          '<span class="lb">' + d.label + '</span></div>';
      }).join('') + '</div></div>';

    // 反复错清单
    html += '<div class="card"><h3>反复错清单 <span>优先处理</span></h3>';
    if (!reps.length) {
      html += '<div style="font-size:13px;color:var(--muted);padding:4px 0">暂时没有反复错的题，保持住。</div>';
    } else {
      html += reps.sort(function (a, b) { return b.wrongCount - a.wrongCount; }).slice(0, 8).map(function (q) {
        return '<div class="bar-row" data-id="' + q.id + '">' +
          '<span class="nm" style="width:auto;flex:1">' + esc(q.subject + '·' + q.knowledge) + '</span>' +
          '<span class="tag rep">错 ' + q.wrongCount + ' 次</span></div>';
      }).join('');
    }
    html += '</div>';
    $('#statsBody').innerHTML = html;
  }

  /* ============ 设置 ============ */
  function renderSettings() {
    var s = S.settings;
    var html = '';
    html += '<div class="card"><h3>自动识别 <span>' + (aiReady() ? '已配置' : '未配置') + '</span></h3>' +
      '<div class="set-row"><div><div class="lbl">接口地址</div><div class="sub">OpenAI 兼容的 /v1 地址，支持视觉模型</div></div>' +
      '<button class="btn btn-sm btn-ghost" data-act="editAI">设置</button></div>' +
      '<div class="set-row"><div><div class="lbl">当前模型</div><div class="sub">' + esc(s.model || '未填写') + '</div></div>' +
      '<span class="val">' + (s.apiKey ? '••••' + esc(String(s.apiKey).slice(-4)) : '无密钥') + '</span></div>' +
      '<div class="set-row"><div><div class="lbl">本地手动模式</div><div class="sub">不配模型也能用：自己填知识点、自己判对错</div></div>' +
      '<span class="val">' + (aiReady() ? '可用' : '当前生效') + '</span></div>' +
      '</div>';

    html += '<div class="card"><h3>每日节奏</h3>' +
      '<div class="set-row"><div><div class="lbl">建议每日题额</div><div class="sub">超过这个数，记忆效果下降</div></div>' +
      '<button class="btn btn-sm btn-ghost" data-act="quota">' + (s.dailyQuota || 3) + ' 题</button></div>' +
      '<div class="set-row"><div><div class="lbl">每日封顶</div><div class="sub">单日最多推送多少道待重做</div></div>' +
      '<button class="btn btn-sm btn-ghost" data-act="cap">' + (s.dailyCap || 15) + ' 题</button></div>' +
      '</div>';

    html += '<div class="card"><h3>错因码 <span>' + S.codes.length + ' 个</span></h3>' +
      S.codes.map(function (c) {
        return '<div class="code-item"><span class="cid">' + esc(c.id) + '</span>' +
          '<span class="cn">' + esc(c.name) + '</span>' +
          '<span class="cd">' + esc(c.desc || '') + '</span>' +
          '<button class="mini-x" data-delcode="' + esc(c.id) + '">×</button></div>';
      }).join('') +
      '<div class="btn-row"><button class="btn btn-sm btn-ghost" data-act="addCode">新增错因码</button></div></div>';

    html += '<div class="card"><h3>学科 <span>' + S.subjects.length + ' 个</span></h3>' +
      '<div class="chips">' + S.subjects.map(function (x) { return '<span class="chip">' + esc(x) + '</span>'; }).join('') + '</div>' +
      '<div class="btn-row"><button class="btn btn-sm btn-ghost" data-act="addSubject">新增学科</button></div></div>';

    html += '<div class="card"><h3>数据</h3>' +
      '<div class="set-row"><div><div class="lbl">存储方式</div><div class="sub">' + (Store.mode === 'idb' ? '本机 IndexedDB，图片也存本地' : '本机 localStorage（容量有限）') + '</div></div>' +
      '<span class="val">' + S.questions.length + ' 题</span></div>' +
      '<div class="set-row"><div><div class="lbl">导出 PDF</div><div class="sub">按学科分册，A4 版式，打印装订成纸质册</div></div>' +
      '<button class="btn btn-sm btn-ghost" data-act="pdf">导出</button></div>' +
      '<div class="set-row"><div><div class="lbl">导出备份</div><div class="sub">JSON 文件，换手机时导入</div></div>' +
      '<button class="btn btn-sm btn-ghost" data-act="export">导出</button></div>' +
      '<div class="set-row"><div><div class="lbl">导入备份</div><div class="sub">合并到当前题库，按 id 去重</div></div>' +
      '<button class="btn btn-sm btn-ghost" data-act="import">导入</button></div>' +
      '<div class="set-row"><div><div class="lbl" style="color:var(--danger)">清空题库</div><div class="sub">不可恢复，先导出备份</div></div>' +
      '<button class="btn btn-sm btn-danger-ghost" data-act="clear">清空</button></div>' +
      '</div>';

    html += '<div class="footnote">错题本 v1 · 数据只存在这台设备上，不上传服务器。<br>想手机拍、电脑看，需要再加云端同步。</div>';
    $('#settingsBody').innerHTML = html;
  }

  /* ============ 重做流程 ============ */
  function startRedo() {
    var list = dueList();
    if (!list.length) return toast('今天没有待重做的题');
    var quota = Math.min(S.settings.dailyQuota || 3, list.length);
    S.redo = {
      queue: list.slice(0, quota).map(function (q) { return q.id; }),
      total: list.length,
      i: 0,
      answerImg: null,
      graded: null
    };
    go('redo');
  }

  function curQ() {
    if (!S.redo) return null;
    return S.questions.filter(function (q) { return q.id === S.redo.queue[S.redo.i]; })[0] || null;
  }

  function renderRedo() {
    var q = curQ();
    if (!q) {
      $('#redoBody').innerHTML = '<div class="empty"><div class="ico">✓</div><p>今天的重做做完了</p><small>明天再来。连着两天都对，就可以斩了。</small>' +
        '<div class="btn-row" style="max-width:240px;margin:12px auto 0"><button class="btn btn-primary btn-sm" id="redoBack">回到今天</button></div></div>';
      var b = $('#redoBack');
      if (b) b.onclick = function () { S.redo = null; go('today'); };
      return;
    }
    var prog = S.redo.queue.map(function (id, idx) {
      return '<i class="' + (idx < S.redo.i ? 'done' : idx === S.redo.i ? 'now' : '') + '"></i>';
    }).join('');

    var head = '<div class="redo-head"><div class="redo-prog">' + prog + '</div>' +
      '<span style="font-size:12.5px;color:var(--muted)">' + (S.redo.i + 1) + '/' + S.redo.queue.length + '</span></div>';

    var tags = '<span class="tag">' + esc(q.subject) + '</span><span class="tag code">' + esc(q.knowledge) + '</span>' +
      (q.errorCode ? '<span class="tag gray">' + esc(q.errorCode) + ' ' + esc(codeName(q.errorCode)) + '</span>' : '') +
      (isRepeat(q) ? '<span class="tag rep">已错 ' + q.wrongCount + ' 次</span>' : '');

    var visual = q.image
      ? '<img class="qimg" src="' + q.image + '" alt="原题">'
      : '<div style="background:var(--block);border-radius:11px;padding:14px;font-size:14px;line-height:1.7;white-space:pre-wrap;margin-bottom:11px">' + esc(q.stem || '（无题干）') + '</div>';

    var zone;
    if (S.redo.graded) {
      var v = S.redo.graded;
      zone = '<div class="verdict ' + (v.ok ? 'ok' : 'no') + '">' +
        '<b>' + (v.ok ? '这次做对了' : '还是错的') + '</b>' +
        esc(v.reason || '') +
        (v.answer ? '<div style="margin-top:6px;opacity:.85">正确答案：' + esc(v.answer) + '</div>' : '') +
        (!v.ok && q.wrongCount >= 2 ? '<div><span class="repeat-flag">已标为「反复错」，明天再练</span></div>' : '') +
        '</div>' +
        '<div class="btn-row"><button class="btn btn-primary" id="redoNext">' +
        (S.redo.i + 1 >= S.redo.queue.length ? '完成' : '下一题') + '</button></div>';
    } else {
      zone = '<p class="redo-ask">先在本子上自己做一遍，做完拍照上传；系统会判对错。' +
        '<br><span style="color:var(--muted);font-size:12.5px">不看答案、不看原解，这一步没做到就等于抄。</span></p>' +
        '<div class="answer-zone" id="answerZone">' +
        (S.redo.answerImg
          ? '<img src="' + S.redo.answerImg + '" alt="作答">'
          : '<div style="font-size:13px;color:var(--muted);padding:8px 0">还没有上传作答</div>') +
        '<div class="btn-row" style="margin-top:4px">' +
        '<button class="btn btn-sm btn-ghost" id="btnAnsCam">拍照</button>' +
        '<button class="btn btn-sm btn-ghost" id="btnAnsPick">相册</button>' +
        '</div></div>' +
        '<input type="file" id="ansCam" accept="image/*" capture="environment" hidden>' +
        '<input type="file" id="ansPick" accept="image/*" hidden>' +
        '<div class="btn-row">' +
        (aiReady()
          ? '<button class="btn btn-ai" id="btnAIJudge"' + (S.redo.answerImg ? '' : ' disabled') + '>AI 判对错</button>'
          : '') +
        '<button class="btn btn-primary" id="btnMarkOk">做对了</button>' +
        '<button class="btn btn-danger-ghost" id="btnMarkNo">做错了</button>' +
        '</div>' +
        '<div class="btn-row"><button class="btn btn-sm btn-ghost" id="btnSkip">跳过这题</button></div>';
    }

    $('#redoBody').innerHTML = head +
      '<div class="redo-panel"><div class="q-line1" style="margin-bottom:9px">' + tags + '</div>' +
      visual + zone + '</div>';
    bindRedo(q);
  }

  function bindRedo(q) {
    var b;
    if ((b = $('#btnAnsCam'))) pickNote(b, '#ansCam', function (d) { S.redo.answerImg = d; renderRedo(); });
    if ((b = $('#btnAnsPick'))) pickNote(b, '#ansPick', function (d) { S.redo.answerImg = d; renderRedo(); });

    if ((b = $('#btnAIJudge'))) {
      b.onclick = function () {
        if (!S.redo.answerImg) return toast('先上传作答照片');
        b.disabled = true; b.textContent = '判定中…';
        aiJudge(q.image, S.redo.answerImg).then(function (r) {
          doGrade(q, !!r.ok, 'ai', S.redo.answerImg, r.reason, r.answer);
        }).catch(function (e) {
          b.disabled = false; b.textContent = 'AI 判对错';
          toast('AI 判定失败：' + e.message, 3200);
        });
      };
    }
    if ((b = $('#btnMarkOk'))) b.onclick = function () { doGrade(q, true, 'manual', S.redo.answerImg, '自己确认做对了', ''); };
    if ((b = $('#btnMarkNo'))) b.onclick = function () { doGrade(q, false, 'manual', S.redo.answerImg, '自己确认还是做错', ''); };
    if ((b = $('#btnSkip'))) {
      b.onclick = function () {
        S.redo.i++; S.redo.answerImg = null; S.redo.graded = null;
        renderRedo();
      };
    }
    if ((b = $('#redoNext'))) {
      b.onclick = function () {
        S.redo.i++; S.redo.answerImg = null; S.redo.graded = null;
        if (S.redo.i >= S.redo.queue.length) { S.redo = null; go('today'); toast('今日重做完成'); }
        else renderRedo();
      };
    }
  }
  function pickNote(btn, inputSel, cb) {
    btn.onclick = function () {
      var inp = $(inputSel);
      inp.onchange = function () {
        var f = inp.files && inp.files[0];
        if (!f) return;
        toast('处理图片…', 800);
        compressImage(f, 1200, 0.78).then(function (d) { cb(d); inp.value = ''; })
          .catch(function (e) { toast(e.message); });
      };
      inp.click();
    };
  }

  function doGrade(q, ok, judge, evidence, reason, answer) {
    gradeQuestion(q, ok, judge, evidence).then(function () {
      S.redo.graded = { ok: ok, reason: reason || '', answer: answer || '' };
      if (!ok) renderStatsLater();
      renderRedo();
      toast(ok ? '已记录：这次对了' : '已记录：仍错，反复错 +1');
    });
  }
  function renderStatsLater() { /* 占位，统计在切页时重算 */ }

  /* ============ 详情面板 ============ */
  function openDetail(id) {
    var q = S.questions.filter(function (x) { return x.id === id; })[0];
    if (!q) return;
    var attempts = (q.attempts || []).slice().reverse();
    var html = '<h2>' + esc(q.subject) + ' · ' + esc(q.knowledge) + '</h2>' +
      '<div class="sub">录入 ' + new Date(q.createdAt).toLocaleDateString() +
      (q.source ? ' · 来自' + esc(q.source) : '') + ' · 累计错 ' + (q.wrongCount || 1) + ' 次</div>';
    if (q.image) html += '<img class="big" src="' + q.image + '" alt="原题">';
    if (q.stem) html += '<div style="font-size:13.5px;line-height:1.7;white-space:pre-wrap;background:var(--block);padding:12px;border-radius:11px;margin-bottom:12px">' + esc(q.stem) + '</div>';
    html += '<div class="q-line1" style="margin-bottom:12px">' +
      '<span class="tag">' + esc(q.subject) + '</span>' +
      (q.errorCode ? '<span class="tag gray">' + esc(q.errorCode) + ' ' + esc(codeName(q.errorCode)) + '</span>' : '') +
      '<span class="tag gray">' + ['', '易', '中', '难'][q.difficulty || 2] + '</span>' +
      (isRepeat(q) && q.status === 'active' ? '<span class="tag rep">反复错</span>' : '') +
      (q.status === 'mastered' ? '<span class="tag done">已斩</span>' : '<span class="tag gray">在册</span>') +
      '</div>';
    if (q.note) html += '<div style="font-size:13px;color:#3C3C43;line-height:1.65;margin-bottom:12px">' + esc(q.note) + '</div>';

    html += '<div class="hr"></div><div style="font-size:12.5px;font-weight:700;margin-bottom:8px">重做记录</div>';
    if (!attempts.length) {
      html += '<div style="font-size:12.5px;color:var(--muted);margin-bottom:10px">还没重做过。</div>';
    } else {
      html += attempts.map(function (a) {
        return '<div style="display:flex;gap:8px;align-items:center;font-size:12.5px;padding:5px 0;border-bottom:1px dashed var(--line-2)">' +
          '<span class="tag ' + (a.ok ? 'done' : 'rep') + '">' + (a.ok ? '○ 对' : '● 错') + '</span>' +
          '<span style="color:var(--muted)">' + new Date(a.at).toLocaleString() + '</span>' +
          '<span style="margin-left:auto;color:var(--muted)">' + (a.judge === 'ai' ? 'AI 判' : '自判') + '</span></div>';
      }).join('');
    }

    html += '<div class="hr"></div><div class="btn-row">';
    if (q.status === 'active') {
      html += '<button class="btn btn-primary btn-sm" data-act="cut"' + ((q.streak || 0) >= 2 ? '' : ' disabled') + '>斩掉这题</button>';
    } else {
      html += '<button class="btn btn-ghost btn-sm" data-act="uncut">恢复在册</button>';
    }
    html += '<button class="btn btn-ghost btn-sm" data-act="variant">出变式题</button>' +
      '<button class="btn btn-danger-ghost btn-sm" data-act="del">删除</button></div>';
    if (q.status === 'active' && (q.streak || 0) < 2) {
      html += '<div style="font-size:11.5px;color:var(--muted);margin-top:8px">当前连对 ' + (q.streak || 0) + ' 次，连对两次且间隔 3 天以上才能斩。</div>';
    }
    html += '<div id="variantBox"></div>';

    openSheet(html);
    $('#sheet').onclick = function (e) {
      var act = e.target.getAttribute && e.target.getAttribute('data-act');
      if (!act) return;
      if (act === 'cut') {
        cutQuestion(q).then(function () { closeSheet(); refreshAll(); toast('已斩，这一道从待办里消失了'); });
      } else if (act === 'uncut') {
        q.status = 'active'; q.streak = 0; q.dueAt = Date.now() + DAY;
        Store.putQuestion(q).then(function () { closeSheet(); refreshAll(); toast('已恢复在册'); });
      } else if (act === 'del') {
        if (!confirm('删除这道题？记录一起没掉。')) return;
        Store.delQuestion(q.id).then(function () {
          S.questions = S.questions.filter(function (x) { return x.id !== q.id; });
          closeSheet(); refreshAll(); toast('已删除');
        });
      } else if (act === 'variant') {
        genVariants(q);
      }
    };
  }

  function genVariants(q) {
    var box = $('#variantBox');
    if (!aiReady()) { toast('需要先在设置里配置大模型'); return; }
    if (!q.stem) { toast('这题没有题干文本，先补录题干'); return; }
    box.innerHTML = '<div style="font-size:12.5px;color:var(--muted);padding:10px 0">正在出变式题…</div>';
    aiVariants(q).then(function (list) {
      box.innerHTML = '<div class="hr"></div><div style="font-size:12.5px;font-weight:700;margin-bottom:8px">变式题</div>' +
        list.map(function (v, i) {
          return '<div style="background:var(--block);border-radius:11px;padding:11px;margin-bottom:8px">' +
            '<div style="font-size:13px;line-height:1.65;white-space:pre-wrap">' + esc(v.stem) + '</div>' +
            '<div style="font-size:11.5px;color:var(--muted);margin-top:6px">答案：' + esc(v.answer || '') + '</div></div>';
        }).join('');
    }).catch(function (e) {
      box.innerHTML = '<div style="font-size:12.5px;color:var(--danger);padding:8px 0">生成失败：' + esc(e.message) + '</div>';
    });
  }

  function openSheet(html) {
    $('#sheet').innerHTML = '<div class="sheet-grab"></div>' + html;
    $('#sheetHost').hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeSheet() {
    $('#sheetHost').hidden = true;
    $('#sheet').innerHTML = '';
    document.body.style.overflow = '';
  }

  /* ============ 通用刷新 ============ */
  function refreshAll() {
    if (S.view === 'today') renderToday();
    else if (S.view === 'bank') renderBank();
    else if (S.view === 'stats') renderStats();
    else if (S.view === 'settings') renderSettings();
    else if (S.view === 'add') { updateAIState(); updatePreview(); }
  }

  /* ============ 事件绑定 ============ */
  function bindGlobal() {
    $('#tabbar').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      go(b.getAttribute('data-view'));
    });
    $('#btnQuickAdd').addEventListener('click', function () { go('add'); });

    // 上传
    $('#btnCam').onclick = function () { $('#camInput').click(); };
    $('#btnPick').onclick = function () { $('#fileInput').click(); };
    $('#fileInput').onchange = function () { handleFiles(this.files); };
    $('#camInput').onchange = function () { handleFiles(this.files); };
    $('#btnReplace').onclick = function () { $('#fileInput').click(); };
    $('#btnDrop').onclick = function () { S.pending.img = null; updatePreview(); };

    var up = $('#uploader');
    ['dragenter', 'dragover'].forEach(function (ev) {
      up.addEventListener(ev, function (e) { e.preventDefault(); up.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      up.addEventListener(ev, function (e) { e.preventDefault(); up.classList.remove('drag'); });
    });
    up.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
    });

    // 粘贴截图（整页切题模式下由 batch.js 接管）
    document.addEventListener('paste', function (e) {
      if (window.CTB_BATCH && window.CTB_BATCH.state.mode === 'batch') return;
      var items = (e.clipboardData || {}).items || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf('image') === 0) {
          var f = items[i].getAsFile();
          if (f) {
            e.preventDefault();
            if (S.view !== 'add') go('add');
            handleFiles([f]);
            toast('已粘贴截图');
            return;
          }
        }
      }
    });

    // 录题表单
    $('#subjectChips').addEventListener('click', function (e) {
      var b = e.target.closest('[data-sub]');
      if (!b) return;
      S.pending.subject = b.getAttribute('data-sub');
      renderSubjectChips(); renderKnowledgeList();
    });
    $('#codeChips').addEventListener('click', function (e) {
      var b = e.target.closest('[data-code]');
      if (!b) return;
      var v = b.getAttribute('data-code');
      S.pending.code = (S.pending.code === v) ? '' : v;
      renderCodeChips();
    });
    $('#diffSeg').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      S.pending.diff = parseInt(b.getAttribute('data-v'), 10);
      $$('#diffSeg button').forEach(function (x) { x.classList.toggle('on', x === b); });
    });
    $('#addForm').addEventListener('submit', function (e) {
      e.preventDefault();
      saveQuestion();
    });
    $('#btnRecognize').onclick = function () {
      if (!S.pending.img) return toast('先上传图片');
      var b = $('#btnRecognize');
      S.busy = true;
      b.disabled = true; b.textContent = '识别中…';
      $('#aiDot').className = 'dot busy';
      $('#aiState').textContent = '正在识别题目…';
      aiRecognize(S.pending.img).then(function (r) {
        if (r.subject && S.subjects.indexOf(r.subject) >= 0) {
          S.pending.subject = r.subject;
          renderSubjectChips(); renderKnowledgeList();
        }
        if (r.knowledge) $('#fKnowledge').value = r.knowledge;
        if (r.errorCode && S.codes.some(function (c) { return c.id === r.errorCode; })) {
          S.pending.code = r.errorCode;
          renderCodeChips();
        }
        if (r.difficulty) {
          S.pending.diff = parseInt(r.difficulty, 10) || 2;
          $$('#diffSeg button').forEach(function (x) {
            x.classList.toggle('on', parseInt(x.getAttribute('data-v'), 10) === S.pending.diff);
          });
        }
        if (r.stem) $('#fStem').value = r.stem;
        if (r.reason && !$('#fNote').value.trim()) $('#fNote').value = '卡住我的是：' + r.reason;
        if (r.reason) toast('识别完成：' + r.reason, 3000);
        else toast('识别完成，请核对');
      }).catch(function (e) {
        toast('识别失败：' + e.message, 3600);
      }).then(function () {
        S.busy = false;
        b.disabled = false; b.textContent = '自动识别';
        updateAIState();
      });
    };

    // 题库筛选
    $('#bankFilters').addEventListener('click', function (e) {
      var act = e.target.closest('[data-act]');
      if (act && act.getAttribute('data-act') === 'pdf') {
        if (window.CTB_PDF) window.CTB_PDF.open();
        return;
      }
      var b = e.target.closest('.chip');
      if (!b) return;
      var sub = b.getAttribute('data-sub');
      var tab = b.getAttribute('data-tab');
      if (sub) S.filter.subject = sub;
      if (tab) S.filter.tab = tab;
      renderBank();
    });
    // 卡片点击进详情
    document.addEventListener('click', function (e) {
      var card = e.target.closest('.qcard');
      if (card) {
        var id = card.getAttribute('data-id');
        if (id) openDetail(id);
        return;
      }
      var row = e.target.closest('.bar-row[data-id]');
      if (row) { openDetail(row.getAttribute('data-id')); return; }
    });

    // 面板
    $('#sheetMask').onclick = closeSheet;

    // 设置动作
    $('#settingsBody').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act],[data-delcode]');
      if (!b) return;
      var dc = b.getAttribute('data-delcode');
      if (dc) {
        S.codes = S.codes.filter(function (c) { return c.id !== dc; });
        saveCodes(); renderSettings(); toast('已删除错因码');
        return;
      }
      var act = b.getAttribute('data-act');
      if (act === 'editAI') editAI();
      else if (act === 'quota' || act === 'cap') editNumber(act);
      else if (act === 'addCode') addCode();
      else if (act === 'addSubject') addSubject();
      else if (act === 'export') exportData();
      else if (act === 'pdf') { if (window.CTB_PDF) window.CTB_PDF.open(); }
      else if (act === 'import') importData();
      else if (act === 'clear') clearData();
    });

    // 滚动阴影
    window.addEventListener('scroll', function () {
      $('.topbar').classList.toggle('scrolled', window.scrollY > 4);
    }, { passive: true });
  }

  /* ============ 设置里的交互 ============ */
  function editAI() {
    var s = S.settings;
    openSheet('<h2>自动识别</h2><div class="sub">填 OpenAI 兼容接口。不填也能用，只是要手动录入。</div>' +
      '<div class="field"><label>接口地址</label><input id="aiBase" placeholder="https://api.openai.com/v1" value="' + esc(s.apiBase) + '"></div>' +
      '<div class="field"><label>模型名</label><input id="aiModel" placeholder="需支持图片输入，如 gpt-4o-mini / qwen-vl-max" value="' + esc(s.model) + '"></div>' +
      '<div class="field"><label>API Key</label><input id="aiKey" placeholder="sk-..." value="' + esc(s.apiKey) + '"></div>' +
      '<div style="font-size:11.5px;color:var(--muted);line-height:1.6;margin-bottom:12px">' +
      '注意：浏览器直连部分厂商会被跨域策略拦住；如果报 Failed to fetch，改用支持浏览器直连的服务，或走一个自己的转发地址。</div>' +
      '<div class="btn-row"><button class="btn btn-ghost" id="aiCancel">取消</button>' +
      '<button class="btn btn-primary" id="aiSave">保存</button></div>');
    $('#aiCancel').onclick = closeSheet;
    $('#aiSave').onclick = function () {
      S.settings.apiBase = $('#aiBase').value.trim();
      S.settings.model = $('#aiModel').value.trim();
      S.settings.apiKey = $('#aiKey').value.trim();
      saveSettings();
      closeSheet(); renderSettings(); updateAIState();
      toast(aiReady() ? '已保存，回录题页试一张' : '已保存（信息不全，仍是手动模式）');
    };
  }

  function editNumber(which) {
    var isQ = which === 'quota';
    var cur = isQ ? S.settings.dailyQuota : S.settings.dailyCap;
    var v = prompt(isQ ? '建议每日题额（1-10）' : '每日封顶（5-50）', cur);
    if (v === null) return;
    var n = parseInt(v, 10);
    if (!n || n < 1) return toast('请输入数字');
    if (isQ) S.settings.dailyQuota = Math.min(n, 10);
    else S.settings.dailyCap = Math.min(n, 50);
    saveSettings(); renderSettings();
  }

  function addCode() {
    var last = S.codes.length ? S.codes[S.codes.length - 1].id : 'E0';
    var num = parseInt(String(last).replace(/\D/g, ''), 10) || 0;
    var nid = 'E' + (num + 1);
    openSheet('<h2>新增错因码</h2><div class="sub">错因要能一眼分清，别超过 12 个。</div>' +
      '<div class="field"><label>编号</label><input id="cId" value="' + esc(nid) + '"></div>' +
      '<div class="field"><label>名称</label><input id="cName" placeholder="如：抄错题"></div>' +
      '<div class="field"><label>典型表现</label><input id="cDesc" placeholder="如：从卷子抄到本子时漏条件"></div>' +
      '<div class="btn-row"><button class="btn btn-ghost" id="cCancel">取消</button>' +
      '<button class="btn btn-primary" id="cSave">保存</button></div>');
    $('#cCancel').onclick = closeSheet;
    $('#cSave').onclick = function () {
      var id = $('#cId').value.trim(), nm = $('#cName').value.trim(), ds = $('#cDesc').value.trim();
      if (!id || !nm) return toast('编号和名称必填');
      if (S.codes.some(function (c) { return c.id === id; })) return toast('编号已存在');
      S.codes.push({ id: id, name: nm, desc: ds });
      saveCodes(); closeSheet(); renderSettings();
      renderCodeChips();
      toast('已添加');
    };
  }

  function addSubject() {
    var v = prompt('新增学科名称');
    if (!v) return;
    v = v.trim();
    if (!v) return;
    if (S.subjects.indexOf(v) >= 0) return toast('已存在');
    S.subjects.push(v);
    saveSubjects(); renderSettings();
    toast('已添加');
  }

  function exportData() {
    var pack = {
      app: 'cuotiben',
      version: 1,
      exportedAt: new Date().toISOString(),
      subjects: S.subjects,
      codes: S.codes,
      knowledge: S.knowledge,
      questions: S.questions
    };
    var blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '错题本备份-' + dayKey(Date.now()) + '.json';
    document.body.appendChild(a); a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href); a.remove();
    }, 800);
    toast('已导出');
  }

  function importData() {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,application/json';
    inp.onchange = function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        var data;
        try { data = JSON.parse(fr.result); } catch (e) { return toast('文件不是有效 JSON'); }
        if (!data || !Array.isArray(data.questions)) return toast('备份文件格式不对');
        var existing = {};
        S.questions.forEach(function (q) { existing[q.id] = true; });
        var added = 0;
        data.questions.forEach(function (q) {
          if (!existing[q.id]) { S.questions.push(q); added++; }
        });
        if (Array.isArray(data.subjects)) {
          data.subjects.forEach(function (s) { if (S.subjects.indexOf(s) < 0) S.subjects.push(s); });
          saveSubjects();
        }
        if (Array.isArray(data.codes)) {
          data.codes.forEach(function (c) {
            if (!S.codes.some(function (x) { return x.id === c.id; })) S.codes.push(c);
          });
          saveCodes();
        }
        if (data.knowledge) {
          Object.keys(data.knowledge).forEach(function (k) {
            S.knowledge[k] = S.knowledge[k] || [];
            data.knowledge[k].forEach(function (x) {
              if (S.knowledge[k].indexOf(x) < 0) S.knowledge[k].push(x);
            });
          });
          saveKnowledge();
        }
        Promise.all(S.questions.map(function (q) { return Store.putQuestion(q); })).then(function () {
          renderSettings(); toast('已导入 ' + added + ' 道题');
        });
      };
      fr.readAsText(f);
    };
    inp.click();
  }

  function clearData() {
    if (!confirm('清空全部错题？这个操作不能撤销。')) return;
    if (!confirm('再确认一次：所有题目和重做记录都会删掉。')) return;
    Store.clearQuestions().then(function () {
      S.questions = [];
      renderSettings(); toast('已清空');
    });
  }

  /* ============ 启动 ============ */
  function boot() {
    bindGlobal();
    loadAll().then(function () {
      if (Store.mode === 'ls') {
        console.warn('IndexedDB 不可用，已降级到 localStorage');
      }
      go('today');
    }).catch(function (e) {
      document.body.insertAdjacentHTML('afterbegin',
        '<div style="padding:14px;background:#FFEBEA;color:#D70015;font-size:13px">初始化失败：' + esc(e.message) + '</div>');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else boot();

  /* 对外接口：供批量切题模块（js/batch.js）复用 */
  window.CTB = {
    S: S,
    Store: Store,
    createQuestion: createQuestion,
    compressImage: compressImage,
    rememberKnowledge: rememberKnowledge,
    toast: toast,
    esc: esc,
    go: go,
    aiReady: aiReady,
    aiChat: aiChat,
    imagePart: imagePart,
    extractJSON: extractJSON,
    openSheet: openSheet,
    closeSheet: closeSheet
  };

  // 暴露给调试
  window.__CTB = S;
})();
