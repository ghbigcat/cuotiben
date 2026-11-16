/* 错题本 · 导出 PDF —— 按学科分册，A4 打印版式
   零依赖：生成打印文档 → 调起浏览器打印 → 选「另存为 PDF」
   对外：window.CTB_PDF = { open, print } */
(function () {
  'use strict';

  var CTB = window.CTB;
  var S = CTB.S;
  var esc = CTB.esc;

  var CFG = {
    subs: null,         // null = 全部学科
    scope: 'active',    // active | repeat | mastered | all
    images: true,
    group: 'knowledge'  // knowledge | time
  };

  var SCOPE = [
    { k: 'active', n: '在册' },
    { k: 'repeat', n: '反复错' },
    { k: 'mastered', n: '已斩' },
    { k: 'all', n: '全部' }
  ];
  var GROUP = [
    { k: 'knowledge', n: '按知识点聚' },
    { k: 'time', n: '按录入时间' }
  ];
  var DIFF = ['', '易', '中', '难'];

  /* ---------- 小工具 ---------- */
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function d2(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtD(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }
  function fmtYMD(ts) {
    var d = new Date(ts);
    return d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
  }
  function subjOf(q) { return q.subject || '未分科'; }
  function subjIdx(s) {
    var i = (S.subjects || []).indexOf(s);
    return i < 0 ? 99 : i;
  }
  function codeName(id) {
    var c = (S.codes || []).filter(function (x) { return x.id === id; })[0];
    return c ? c.name : '';
  }
  function wrongOf(q) { return q.wrongCount || 1; }

  /* ---------- 取数 ---------- */
  function pick() {
    var list = (S.questions || []).slice();
    if (CFG.subs && CFG.subs.length) {
      list = list.filter(function (q) { return CFG.subs.indexOf(subjOf(q)) >= 0; });
    }
    if (CFG.scope === 'active') {
      list = list.filter(function (q) { return q.status === 'active'; });
    } else if (CFG.scope === 'repeat') {
      list = list.filter(function (q) { return q.status === 'active' && wrongOf(q) >= 2; });
    } else if (CFG.scope === 'mastered') {
      list = list.filter(function (q) { return q.status === 'mastered'; });
    }
    return list;
  }

  function groupBy(list) {
    var w = {};
    list.forEach(function (q) {
      var k = subjOf(q) + '|' + (q.knowledge || '未分类');
      w[k] = (w[k] || 0) + wrongOf(q);
    });
    list.sort(function (a, b) {
      var sa = subjIdx(subjOf(a)), sb = subjIdx(subjOf(b));
      if (sa !== sb) return sa - sb;
      if (CFG.group === 'knowledge') {
        var ka = subjOf(a) + '|' + (a.knowledge || '未分类');
        var kb = subjOf(b) + '|' + (b.knowledge || '未分类');
        if (w[ka] !== w[kb]) return w[kb] - w[ka];
      }
      return (a.createdAt || 0) - (b.createdAt || 0);
    });
    var out = [], cur = null;
    list.forEach(function (q) {
      var s = subjOf(q);
      if (!cur || cur.subject !== s) { cur = { subject: s, items: [] }; out.push(cur); }
      cur.items.push(q);
    });
    return out;
  }

  /* ---------- 渲染 ---------- */
  function cardHTML(q, i) {
    var hasImg = !!(CFG.images && q.image);
    var rep = (wrongOf(q) >= 2 && q.status === 'active')
      ? '<span class="cq-rep">反复错 ' + wrongOf(q) + '</span>' : '';
    var code = q.errorCode
      ? '<span class="cq-code">' + esc(q.errorCode) + ' ' + esc(codeName(q.errorCode)) + '</span>' : '';

    var img = hasImg ? '<div class="cq-img"><img src="' + q.image + '" alt=""></div>' : '';
    var stem = q.stem ? '<div class="cq-stem">' + esc(q.stem) + '</div>' : '';
    // 无图无题干：留出贴原题 / 抄题的空白
    var space = (!hasImg && !q.stem) ? '<div class="cq-blank"><span>原题</span></div>' : '';
    var note = q.note
      ? '<div class="cq-note"><b>卡住我的 / 正确解法</b><span>' + esc(q.note) + '</span></div>'
      : '<div class="cq-note blank"><b>卡住我的 / 正确解法</b><span>&nbsp;</span></div>';

    var trail = (q.attempts || []).slice(-5).map(function (a) { return a.ok ? '○' : '●'; }).join('') || '—';
    var meta = [
      fmtD(q.createdAt),
      q.source ? esc(q.source) : '',
      '错 ' + wrongOf(q) + ' 次',
      '重做 ' + trail + ((q.attempts || []).length > 5 ? '…' : '')
    ].filter(Boolean).join(' · ');

    return '<div class="card-q">' +
      '<div class="cq-top">' +
      '<span class="cq-no">' + d2(i + 1) + '</span>' +
      '<span class="cq-kn">' + esc(q.knowledge || '未分类') + '</span>' +
      '<span class="cq-diff">' + DIFF[q.difficulty || 2] + '</span>' +
      rep + code +
      '</div>' + img + stem + space + note +
      '<div class="cq-foot">' + meta + '</div></div>';
  }

  function secHTML(g) {
    var n = g.items.length;
    var reps = g.items.filter(function (q) { return wrongOf(q) >= 2; }).length;
    var wrong = g.items.reduce(function (s, q) { return s + wrongOf(q); }, 0);
    var kn = {};
    g.items.forEach(function (q) {
      var k = q.knowledge || '未分类';
      kn[k] = (kn[k] || 0) + 1;
    });
    var knList = Object.keys(kn).sort(function (a, b) { return kn[b] - kn[a]; })
      .slice(0, 6).join(' · ');

    return '<div class="sec-head">' +
      '<div class="sec-t"><h2>' + esc(g.subject) + '</h2><span>' + n + ' 题</span></div>' +
      '<div class="sec-m">反复错 ' + reps + ' 题 · 累计错 ' + wrong + ' 次 · ' + esc(knList) + '</div>' +
      '</div>' + g.items.map(cardHTML).join('');
  }

  function coverHTML(groups, total) {
    var reps = 0, wrong = 0, repList = [];
    groups.forEach(function (g) {
      g.items.forEach(function (q) {
        wrong += wrongOf(q);
        if (wrongOf(q) >= 2) { reps++; repList.push(q); }
      });
    });
    repList.sort(function (a, b) { return wrongOf(b) - wrongOf(a); });

    var rows = groups.map(function (g) {
      var w = 0, r = 0;
      g.items.forEach(function (q) { w += wrongOf(q); if (wrongOf(q) >= 2) r++; });
      return '<div class="s"><b>' + esc(g.subject) + '</b>' +
        '<span>' + g.items.length + ' 题 · 反复错 ' + r + ' · 错 ' + w + ' 次</span></div>';
    }).join('');

    var first = repList.length
      ? '<ol>' + repList.slice(0, 4).map(function (q) {
        return '<li><span class="s">' + esc(subjOf(q)) + '</span>' +
          '<span class="n">' + esc(q.knowledge || '未分类') + '</span>' +
          '<em>错 ' + wrongOf(q) + ' 次</em></li>';
      }).join('') + '</ol>'
      : '<div class="none">这一叠里没有反复错的题，按顺序过一遍就行。</div>';

    return '<section class="cover">' +
      '<div class="cv-kicker">错题本 · 复习册</div>' +
      '<h1>' + esc(CFG.subs && CFG.subs.length === 1 ? CFG.subs[0] : '全科') + '错题集</h1>' +
      '<div class="cv-sub">' + fmtYMD(Date.now()) + ' 生成 · 共 ' + total + ' 道</div>' +
      '<div class="cv-stat">' +
      '<div><b>' + total + '</b><span>道错题</span></div>' +
      '<div><b>' + reps + '</b><span>待攻克</span></div>' +
      '<div><b>' + wrong + '</b><span>累计错次</span></div>' +
      '</div>' +
      '<div class="cv-subs">' + rows + '</div>' +
      '<div class="cv-first"><b>优先攻克 · 反复错的最前面</b>' + first + '</div>' +
      '<div class="cv-how"><b>这一叠怎么用</b>' +
      '<ol>' +
      '<li>先遮住「卡住我的 / 正确解法」，只看原题，自己做一遍。</li>' +
      '<li>做对了在右下角写日期；做错了加一个 ●，页边记下又卡在哪一步。</li>' +
      '<li>连续两次都做对，且能合上书把思路讲清楚，才划掉这道题。</li>' +
      '<li>同一学科的题排在一起，错因码相同的放一堆看，比逐题重做有用。</li>' +
      '</ol></div>' +
      '<div class="cv-code">错因码：E1 概念不清 · E2 公式记错 · E3 审题失误 · E4 计算错误 · E5 方法选错 · ' +
      'E6 步骤跳步 · E7 单位换算 · E8 时间不够 · E9 答题不规范</div>' +
      '</section>';
  }

  /* 离屏量真实高度，再按「卡片不跨页」的规则模拟装箱，估出的页数基本等于实际打印页数 */
  function estPages(html) {
    var probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;left:-99999px;top:0;width:184mm;visibility:hidden;pointer-events:none';
    probe.innerHTML = html;
    document.body.appendChild(probe);

    var paper = probe.querySelector('.paper');
    if (paper) { paper.style.width = 'auto'; paper.style.padding = '0'; paper.style.margin = '0'; }
    var cover = probe.querySelector('.cover');

    var avail = (297 - 28) * 96 / 25.4;   // A4 高减去上下 14mm 边距，px
    var mb = function (el) { return parseFloat(getComputedStyle(el).marginBottom) || 0; };

    var pages = 1, used = 0;
    var coverPages = 0;
    if (cover) {
      coverPages = Math.max(1, Math.ceil(cover.getBoundingClientRect().height / avail));
      used = 0;
    }

    var kids = paper
      ? Array.prototype.slice.call(paper.children).filter(function (el) { return el !== cover; })
      : [];
    var bodyPages = 0, cur = 0;
    var i = 0;
    while (i < kids.length) {
      var el = kids[i];
      var h = el.getBoundingClientRect().height + mb(el);
      // 章节标题必须和它下面第一张卡同页
      if (el.classList.contains('sec-head') && kids[i + 1]) {
        h += kids[i + 1].getBoundingClientRect().height + mb(kids[i + 1]);
        i += 2;
      } else {
        i++;
      }
      if (bodyPages === 0) { bodyPages = 1; cur = 0; }
      if (cur > 0 && cur + h > avail) { bodyPages++; cur = 0; }
      cur += h;
      while (cur > avail + 1) { bodyPages++; cur -= avail; }
    }
    pages = coverPages + Math.max(1, bodyPages);

    probe.remove();
    return { pages: pages, avail: avail, used: cur };
  }

  function buildHTML() {
    var list = pick();
    if (!list.length) return null;
    var groups = groupBy(list);
    var html = '<div class="paper">' + coverHTML(groups, list.length);
    groups.forEach(function (g) { html += secHTML(g); });
    html += '</div>';
    var m = estPages(html);
    return { html: html, total: list.length, pages: m.pages, _m: m };
  }

  /* ---------- 打开预览 ---------- */
  function show() {
    var r = buildHTML();
    if (!r) return CTB.toast('这个范围下没有题，换个范围试试');

    var root = $('#printRoot');
    root.innerHTML =
      '<div class="pv-bar">' +
      '<div class="t"><b>共 ' + r.total + ' 题</b> · 约 ' + r.pages + ' 页 A4</div>' +
      '<button class="btn btn-sm btn-ghost" id="pvClose">返回</button>' +
      '<button class="btn btn-sm btn-primary" id="pvPrint">打印 / 存为 PDF</button>' +
      '</div>' +
      '<p class="pv-tip">点「打印 / 存为 PDF」后，在弹出的对话框里把「目标打印机」改成 <b>另存为 PDF</b>，' +
      '纸张 A4、边距默认、勾上「背景图形」，然后保存。</p>' +
      r.html;

    document.body.classList.add('pv-open');
    window.scrollTo(0, 0);
    CTB.closeSheet();

    $('#pvClose').onclick = close;
    $('#pvPrint').onclick = print;
    root.scrollTop = 0;
  }

  function close() {
    document.body.classList.remove('pv-open');
    var root = $('#printRoot');
    if (root) root.innerHTML = '';
  }

  function print() {
    var imgs = $$('#printRoot img');
    var pending = imgs.filter(function (im) { return !im.complete; });
    var wait = pending.map(function (im) {
      return new Promise(function (res) { im.onload = im.onerror = res; });
    });
    Promise.all(wait).then(function () {
      setTimeout(function () { window.print(); }, 120);
    });
  }

  /* ---------- 配置面板 ---------- */
  function open() {
    if (!S.questions || !S.questions.length) return CTB.toast('题库还是空的，先录几道题');

    var have = {};
    S.questions.forEach(function (q) {
      var s = subjOf(q);
      have[s] = (have[s] || 0) + 1;
    });
    var subs = (S.subjects || []).filter(function (s) { return have[s]; });

    var subChips = '<button class="chip" data-s="__all">全部 ' + S.questions.length + '</button>' +
      subs.map(function (s) {
        var on = CFG.subs && CFG.subs.indexOf(s) >= 0;
        return '<button class="chip' + (on ? ' on' : '') + '" data-s="' + esc(s) + '">' +
          esc(s) + ' ' + have[s] + '</button>';
      }).join('');

    var scopeChips = SCOPE.map(function (x) {
      return '<button class="chip flat' + (CFG.scope === x.k ? ' on' : '') + '" data-scope="' + x.k + '">' +
        x.n + '</button>';
    }).join('');

    var groupChips = GROUP.map(function (x) {
      return '<button class="chip flat' + (CFG.group === x.k ? ' on' : '') + '" data-group="' + x.k + '">' +
        x.n + '</button>';
    }).join('');

    var imgChips = '<button class="chip flat' + (CFG.images ? ' on' : '') + '" data-img="1">带上原题图</button>' +
      '<button class="chip flat' + (!CFG.images ? ' on' : '') + '" data-img="0">只排文字</button>';

    CTB.openSheet(
      '<h2>导出 PDF</h2>' +
      '<div class="sub">按学科分册，A4 打印版式，用来打印装订成纸质复习册。</div>' +

      '<div class="field"><label>学科 <span class="hint">不选就是全部</span></label>' +
      '<div class="chips" id="pvSubs">' + subChips + '</div></div>' +

      '<div class="field"><label>收录范围</label>' +
      '<div class="chips" id="pvScope">' + scopeChips + '</div></div>' +

      '<div class="field"><label>排列方式</label>' +
      '<div class="chips" id="pvGroup">' + groupChips + '</div></div>' +

      '<div class="field"><label>原题图片</label>' +
      '<div class="chips" id="pvImg">' + imgChips + '</div>' +
      '<div class="hint" style="margin-top:7px">带图更直观，但页数翻倍、也更费墨。只排文字适合已经抄过题的本子。</div>' +
      '</div>' +

      '<div class="btn-row"><button class="btn btn-ghost" id="pvCancel">取消</button>' +
      '<button class="btn btn-primary" id="pvGo">生成预览</button></div>'
    );

    $('#pvCancel').onclick = CTB.closeSheet;

    $('#pvSubs').addEventListener('click', function (e) {
      var b = e.target.closest('[data-s]');
      if (!b) return;
      var v = b.getAttribute('data-s');
      if (v === '__all') {
        CFG.subs = null;
      } else if (!CFG.subs) {
        CFG.subs = [v];
      } else {
        var i = CFG.subs.indexOf(v);
        if (i >= 0) CFG.subs.splice(i, 1);
        else CFG.subs.push(v);
        if (!CFG.subs.length) CFG.subs = null;
      }
      // 重绘学科 chips
      var all = $('#pvSubs');
      $$('[data-s]', all).forEach(function (x) {
        var k = x.getAttribute('data-s');
        if (k === '__all') x.classList.toggle('on', !CFG.subs);
        else x.classList.toggle('on', !!CFG.subs && CFG.subs.indexOf(k) >= 0);
      });
    });

    $('#pvScope').addEventListener('click', function (e) {
      var b = e.target.closest('[data-scope]');
      if (!b) return;
      CFG.scope = b.getAttribute('data-scope');
      $$('[data-scope]', $('#pvScope')).forEach(function (x) {
        x.classList.toggle('on', x === b);
      });
    });

    $('#pvGroup').addEventListener('click', function (e) {
      var b = e.target.closest('[data-group]');
      if (!b) return;
      CFG.group = b.getAttribute('data-group');
      $$('[data-group]', $('#pvGroup')).forEach(function (x) {
        x.classList.toggle('on', x === b);
      });
    });

    $('#pvImg').addEventListener('click', function (e) {
      var b = e.target.closest('[data-img]');
      if (!b) return;
      CFG.images = b.getAttribute('data-img') === '1';
      $$('[data-img]', $('#pvImg')).forEach(function (x) {
        x.classList.toggle('on', x === b);
      });
    });

    $('#pvGo').onclick = show;

    // 默认高亮「全部」
    var allChip = $('#pvSubs [data-s="__all"]');
    if (allChip) allChip.classList.toggle('on', !CFG.subs);
  }

  window.CTB_PDF = { open: open, print: print, close: close, show: show, cfg: CFG, build: buildHTML };
})();
