/* 错题本 · 整页切题（批量录入）
   一张卷子拍一次 → 自动切成多道题 → 逐题确认入库
   切分算法纯本地：灰度 + Otsu 二值化 + 行投影空白带检测，不需要联网、不需要大模型
   两种切法：横切（逐行，默认）与竖切（先分栏，栏内再按行切）
*/
(function () {
  'use strict';

  function api() { return window.CTB; }
  function $(s) { return document.querySelector(s); }
  function $$(s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }

  var B = {
    src: '',
    img: null,
    /* 分栏：每栏有自己的行切点与左右裁切边界
       x0/x1 = 用户定的栏边界（0..1）；cx0/cx1 = 去掉白边后的实际裁切边界 */
    cols: [{ x0: 0, x1: 1, cx0: 0, cx1: 1, segs: [] }],
    bounds: { x0: 0, x1: 1 },
    items: [],
    unified: { subject: '', source: '', code: '' },
    mode: 'single',
    vMode: false,      // 竖切模式
    busy: false
  };

  var MIN_SEG = 0.02;    // 单块最小高度（整图比例）
  var MIN_COL = 0.10;    // 单栏最小宽度（整图比例）
  var MAX_SEGS = 30;     // 超过这个数说明切碎了，重切

  var HINT_H = '点页面任意位置横切一刀 · 拖动蓝线调整边界 · 点 × 把这块并到下一块';
  var HINT_V = '点页面添一条竖线，把一页分成几栏；每栏内部仍按行切。拖动竖线调栏宽，点 × 合并两栏';

  /* ================= 图像分析 ================= */

  function otsu(hist, total) {
    var sum = 0, i;
    for (i = 0; i < 256; i++) sum += i * hist[i];
    var sumB = 0, wB = 0, best = 0, T = 127;
    for (i = 0; i < 256; i++) {
      wB += hist[i];
      if (!wB) continue;
      var wF = total - wB;
      if (!wF) break;
      sumB += i * hist[i];
      var mB = sumB / wB, mF = (sum - sumB) / wF;
      var v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; T = i; }
    }
    return T;
  }

  /* 采样成灰度图，返回 {gray, W, H} */
  function sampling(imgEl, targetW) {
    var W = targetW || 640;
    var sc = W / imgEl.naturalWidth;
    var H = Math.max(80, Math.round(imgEl.naturalHeight * sc));
    if (H > 6000) {              // 超长图降采样，避免卡顿
      var k = 6000 / H;
      W = Math.round(W * k); H = 6000;
    }
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(imgEl, 0, 0, W, H);
    var d = ctx.getImageData(0, 0, W, H).data;
    var gray = new Uint8Array(W * H);
    var hist = new Uint32Array(256);
    for (var i = 0, p = 0; i < gray.length; i++, p += 4) {
      var g = (d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114) | 0;
      gray[i] = g; hist[g]++;
    }
    return { gray: gray, W: W, H: H, hist: hist };
  }

  /* 主分析：按当前分栏逐栏找左右内容边界 + 行切点 */
  function analyzeAll(imgEl) {
    var s = sampling(imgEl, 640);
    var W = s.W, H = s.H, gray = s.gray;
    var T = otsu(s.hist, W * H);
    // 纸面拍照常带阴影，Otsu 可能把浅灰当墨迹；收上限保证只认深色
    T = Math.min(T, 168);
    T = Math.max(T, 70);

    // 全宽列墨迹，用来定每一栏的内容左右边界
    var colInk = new Uint32Array(W);
    var y, x, base;
    for (y = 0; y < H; y++) {
      base = y * W;
      for (x = 0; x < W; x++) if (gray[base + x] < T) colInk[x]++;
    }

    var colTh = Math.max(2, H * 0.004);
    var padX = Math.round(W * 0.012);

    // 单栏时顺手判断「这是不是两栏排版」：中间一条竖带几乎没有墨迹，两侧都有
    B.twoCol = false;
    if (B.cols.length === 1) {
      var dens = function (a, b) {
        var sum = 0;
        for (var k = a; k <= b; k++) sum += colInk[k];
        return sum / Math.max(1, (b - a + 1));
      };
      var lm = dens(Math.round(W * 0.08), Math.round(W * 0.42));
      var rm = dens(Math.round(W * 0.58), Math.round(W * 0.92));
      var mm = dens(Math.round(W * 0.46), Math.round(W * 0.54));
      B.twoCol = Math.min(lm, rm) > H * 0.02 && mm < Math.min(lm, rm) * 0.25;
    }

    var out = B.cols.map(function (col) {
      var px0 = Math.max(0, Math.min(W - 2, Math.round(col.x0 * W)));
      var px1 = Math.max(px0 + 1, Math.min(W - 1, Math.round(col.x1 * W) - 1));

      var xL = px0, xR = px1, found = false;
      for (x = px0; x <= px1; x++) { if (colInk[x] > colTh) { xL = x; found = true; break; } }
      for (x = px1; x >= px0; x--) { if (colInk[x] > colTh) { xR = x; break; } }
      if (!found) { xL = px0; xR = px1; }
      xL = Math.max(px0, xL - padX);
      xR = Math.min(px1, xR + padX);

      // 整栏几乎没有墨迹（比如把单栏页硬切成两半）：不产出题目，留着边界可合并回去
      var inkSum = 0;
      for (x = px0; x <= px1; x++) inkSum += colInk[x];
      if (inkSum < H) {
        return { x0: col.x0, x1: col.x1, cx0: px0 / W, cx1: (px1 + 1) / W, segs: [] };
      }

      // 只在本栏内容宽度内算行墨迹（排除页面外的深色桌面）
      var rowInk = new Float32Array(H);
      var w = xR - xL + 1;
      for (y = 0; y < H; y++) {
        base = y * W;
        var d2 = 0;
        for (x = xL; x <= xR; x++) { if (gray[base + x] < T) d2++; }
        rowInk[y] = d2 / w;
      }

      // 页码 / 装订线 / 扫描污点：孤立的小块墨迹会干扰切分，先剔掉
      dropOrphans(rowInk, H);

      // 空白行阈值：正常文字行 5%~30%，空白行≈0
      var r1 = splitByRows(rowInk, H, 0.008);
      var segs = r1.segs;
      if (segs.length > MAX_SEGS) segs = splitByRows(rowInk, H, 0.016).segs;
      if (!segs.length) segs = [{ y0: 0, y1: 1 }];
      segs = shrinkToContent(segs, rowInk, H, 0.003);
      if (!segs.length) segs = [{ y0: 0, y1: 1 }];

      return { x0: col.x0, x1: col.x1, cx0: xL / W, cx1: (xR + 1) / W, segs: segs };
    });

    // 全部栏都是空的（极少见）：兜底给一整块，别让切题区变成空白
    if (!out.some(function (c) { return c.segs.length; })) {
      out[0].cx0 = 0; out[0].cx1 = 1; out[0].segs = [{ y0: 0, y1: 1 }];
    }

    B.cols = out;
    B.bounds = { x0: out[0].cx0, x1: out[out.length - 1].cx1 };
    return out;
  }

  /* 兼容旧调用：单栏分析，不改动当前状态 */
  function analyze(imgEl) {
    var keepCols = B.cols, keepBounds = B.bounds;
    B.cols = [{ x0: 0, x1: 1, cx0: 0, cx1: 1, segs: [] }];
    var r = analyzeAll(imgEl);
    B.cols = keepCols; B.bounds = keepBounds;
    return { segs: r[0].segs, bounds: { x0: r[0].cx0, x1: r[0].cx1 } };
  }

  /* 剔除孤立墨迹：与上下都有很大间距、自身又很矮的元素（页码、页眉、污点） */
  function dropOrphans(rowInk, H) {
    var th = 0.003;
    var groups = [];
    var y = 0;
    while (y < H) {
      if (rowInk[y] >= th) {
        var st = y;
        while (y < H && rowInk[y] >= th) y++;
        groups.push({ st: st, end: y });
      } else y++;
    }
    if (groups.length < 2) return;

    // 先把挨得很近的小组合并（同一行字被抗锯齿切成几段的情况）
    var merged = [];
    for (var m = 0; m < groups.length; m++) {
      var last = merged[merged.length - 1];
      if (last && groups[m].st - last.end < H * 0.02) last.end = groups[m].end;
      else merged.push({ st: groups[m].st, end: groups[m].end });
    }
    groups = merged;

    var maxH = H * 0.03, minGap = H * 0.12;
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      var h = g.end - g.st;
      var gapPrev = i > 0 ? g.st - groups[i - 1].end : 1e9;
      var gapNext = i < groups.length - 1 ? groups[i + 1].st - g.end : 1e9;
      if (h < maxH && Math.min(gapPrev, gapNext) > minGap) {
        for (var k = g.st; k < g.end; k++) rowInk[k] = 0;
      }
    }
  }

  /* 每块收缩到自己的内容范围，避免切点落在空白中间导致上下留一大片白 */
  function shrinkToContent(segs, rowInk, H, inkTh) {
    return segs.map(function (s) {
      var y0 = Math.round(s.y0 * H);
      var y1 = Math.round(s.y1 * H);
      var a = y0, b = y1, y;
      for (y = y0; y < y1; y++) { if (rowInk[y] >= inkTh) { a = y; break; } }
      for (y = y1 - 1; y >= y0; y--) { if (rowInk[y] >= inkTh) { b = y + 1; break; } }
      var pad = Math.max(4, Math.round((b - a) * 0.04));
      a = Math.max(0, a - pad);
      b = Math.min(H, b + pad);
      return { y0: a / H, y1: b / H };
    }).filter(function (s) { return s.y1 - s.y0 > 0.004; });
  }

  /* 从空白带的长度分布里找出「题间空白」的门槛。
     行距造成的短空白和题与题之间的长空白会形成两级分布，
     排序后最大的那个跳变点就是分界；没有明显两级时退回中位数法。 */
  function pickGapThreshold(runs, H) {
    var maxRun = Math.round(H * 0.25);        // 超过整页 1/4 的不算题间空白（那是页脚白）
    var lens = runs
      .filter(function (r) { return r.len >= 3 && r.len <= maxRun; })
      .map(function (r) { return r.len; })
      .sort(function (a, b) { return a - b; });

    if (lens.length < 3) return Math.max(8, Math.round(H * 0.018));

    var i, jump, bestJump = 0, idx = -1;
    for (i = 1; i < lens.length; i++) {
      jump = lens[i] - lens[i - 1];
      if (jump > bestJump) { bestJump = jump; idx = i; }
    }
    if (idx > 0 && bestJump >= Math.max(4, lens[idx - 1] * 0.6)) {
      return Math.round((lens[idx - 1] + lens[idx]) / 2);
    }

    var med = lens[Math.floor(lens.length / 2)];
    var th = Math.max(Math.round(med * 2.2), Math.round(H * 0.012), 8);
    return Math.min(th, Math.round(H * 0.09));
  }

  function splitByRows(rowInk, H, blankTh) {
    // 1) 收集所有空白带
    var runs = [];
    var y = 0;
    while (y < H) {
      if (rowInk[y] < blankTh) {
        var st = y;
        while (y < H && rowInk[y] < blankTh) y++;
        runs.push({ st: st, end: y, len: y - st, mid: Math.round((st + y) / 2) });
      } else y++;
    }

    // 2) 内容上下边界：顶部页眉白、底部页脚白都切掉
    var top = 0, bottom = H;
    for (var a = 0; a < H; a++) { if (rowInk[a] >= blankTh) { top = a; break; } }
    for (var b = H - 1; b >= 0; b--) { if (rowInk[b] >= blankTh) { bottom = b + 1; break; } }
    if (bottom <= top) return { segs: [], dbg: { top: top, bottom: bottom } };

    // 3) 只保留内容区内部、且达到门槛的空白
    var gapTh = pickGapThreshold(runs, H);
    var cuts = [top];
    var edge = Math.max(20, Math.round(H * 0.03));
    runs.forEach(function (r) {
      if (r.st <= top || r.end >= bottom) return;
      if (r.mid < top + edge || r.mid > bottom - edge) return;
      if (r.len >= gapTh) cuts.push(r.mid);
    });
    cuts.push(bottom);

    cuts = cuts.filter(function (v, i, arr) { return i === 0 || v > arr[i - 1]; });
    var dbg = {
      top: top, bottom: bottom, gapTh: gapTh, cuts: cuts.slice(), edge: edge,
      runs: runs.map(function (r) { return r.len; }).filter(function (l) { return l >= 3; })
    };
    if (cuts.length < 2) return { segs: [], dbg: dbg };

    // 4) 生成区间并合并过小的块
    var minH = Math.max(22, Math.round(H * 0.028));
    var out = [];
    for (var i = 0; i < cuts.length - 1; i++) {
      var y0 = cuts[i], y1 = cuts[i + 1];
      if (y1 - y0 < 2) continue;
      var ink = 0;
      for (var k = y0; k < y1; k++) ink += rowInk[k];
      if (ink / (y1 - y0) < 0.003) {          // 纯空白块并进上一块
        if (out.length) out[out.length - 1].y1 = y1;
        continue;
      }
      if (y1 - y0 < minH && out.length) { out[out.length - 1].y1 = y1; continue; }
      out.push({ y0: y0, y1: y1 });
    }

    if (out.length > 1 && (out[0].y1 - out[0].y0) < minH) {
      out[1].y0 = out[0].y0;
      out.shift();
    }

    return {
      segs: out.map(function (s) { return { y0: s.y0 / H, y1: s.y1 / H }; }),
      dbg: dbg
    };
  }

  /* ================= 结构工具 ================= */

  /* 按阅读顺序展开：先左栏从上到下，再右栏 */
  function flatSegs() {
    var out = [];
    B.cols.forEach(function (col, ci) {
      col.segs.forEach(function (seg, si) { out.push({ c: ci, i: si, col: col, seg: seg }); });
    });
    return out;
  }
  function totalSegs() { return flatSegs().length; }

  function colAt(x) {
    for (var i = 0; i < B.cols.length; i++) {
      if (x >= B.cols[i].x0 && x < B.cols[i].x1) return B.cols[i];
    }
    return B.cols[B.cols.length - 1];
  }

  function reanalyze() {
    if (!B.img) return;
    try { analyzeAll(B.img); } catch (e) { /* 分析失败就保留原切点 */ }
    renderCrop();
  }

  /* ================= 交互：切题舞台 ================= */

  function autoSegment(silent) {
    if (!B.img) return;
    try {
      analyzeAll(B.img);
      renderCrop();
      if (!silent) {
        var n = totalSegs();
        if (n > 1) {
          api().toast(B.twoCol
            ? '自动切成 ' + n + ' 题。像是两栏排版，切到「竖切」分栏更准'
            : '自动切成 ' + n + ' 题，切错可以调');
        } else {
          api().toast('只切出一块。点一下要切的位置就能切；两栏排版切到「竖切」先分栏');
        }
      }
    } catch (e) {
      api().toast('自动切分失败：' + e.message);
      B.cols.forEach(function (c) { c.segs = [{ y0: 0, y1: 1 }]; });
      renderCrop();
    }
  }

  function renderCrop() {
    var wrap = $('#cropWrap');
    var all = flatSegs();
    if (!all.length) { wrap.hidden = true; return; }
    wrap.hidden = false;

    var html = all.map(function (f, idx) {
      var left = (f.col.x0 * 100).toFixed(3);
      var w = ((f.col.x1 - f.col.x0) * 100).toFixed(3);
      var top = (f.seg.y0 * 100).toFixed(3);
      var h = ((f.seg.y1 - f.seg.y0) * 100).toFixed(3);
      var tiny = (f.seg.y1 - f.seg.y0) < 0.035;
      var lastInCol = f.i === f.col.segs.length - 1;
      return '<div class="crop-seg' + (tiny ? ' tiny' : '') + '" data-c="' + f.c + '" data-i="' + f.i + '"' +
        ' style="left:' + left + '%;width:' + w + '%;top:' + top + '%;height:' + h + '%">' +
        '<span class="no">' + (idx + 1) + '</span>' +
        (f.col.segs.length > 1
          ? '<button type="button" class="kill" data-kill-c="' + f.c + '" data-kill-i="' + f.i + '" aria-label="合并">×</button>'
          : '') +
        (lastInCol ? '' : '<div class="crop-cut" data-cut-c="' + f.c + '" data-cut-i="' + f.i + '"></div>') +
        '</div>';
    }).join('');

    // 栏边界：始终显示，竖切模式下可拖、可合并
    for (var i = 0; i < B.cols.length - 1; i++) {
      html += '<div class="crop-vcut' + (B.vMode ? ' act' : '') + '" data-vcut="' + i + '"' +
        ' style="left:' + (B.cols[i].x1 * 100).toFixed(3) + '%">' +
        '<span class="vtag">' + (i + 1) + '|' + (i + 2) + '</span>' +
        '<button type="button" class="vkill" data-vkill="' + i + '" aria-label="合并两栏">×</button>' +
        '</div>';
    }

    var layer = $('#cropLayer');
    layer.innerHTML = html;
    layer.classList.toggle('vmode', B.vMode);   // 竖切模式下横线不再拦截点击
    $('#btnToItems').textContent = '下一步：逐题确认（' + all.length + ' 题）';
  }

  function relY(clientY) {
    var inner = $('#cropInner');
    var r = inner.getBoundingClientRect();
    if (!r.height) return 0;
    return Math.min(1, Math.max(0, (clientY - r.top) / r.height));
  }
  function relX(clientX) {
    var inner = $('#cropInner');
    var r = inner.getBoundingClientRect();
    if (!r.width) return 0;
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  }

  function cutRowAt(x, y) {
    var col = colAt(x);
    for (var i = 0; i < col.segs.length; i++) {
      var s = col.segs[i];
      if (y > s.y0 + MIN_SEG && y < s.y1 - MIN_SEG) {
        col.segs.splice(i, 1, { y0: s.y0, y1: y }, { y0: y, y1: s.y1 });
        renderCrop();
        return true;
      }
    }
    return false;
  }

  function cutColAt(x) {
    for (var i = 0; i < B.cols.length; i++) {
      var c = B.cols[i];
      if (x > c.x0 + MIN_COL && x < c.x1 - MIN_COL) {
        B.cols.splice(i, 1,
          { x0: c.x0, x1: x, cx0: c.x0, cx1: x, segs: [] },
          { x0: x, x1: c.x1, cx0: x, cx1: c.x1, segs: [] });
        reanalyze();     // 两栏各自重新按行切
        return true;
      }
    }
    return false;
  }

  function mergeRowAt(ci, i) {
    var col = B.cols[ci];
    if (!col || col.segs.length <= 1) return;
    if (i < col.segs.length - 1) {
      col.segs[i + 1].y0 = col.segs[i].y0;   // 并到下一块
      col.segs.splice(i, 1);
    } else {
      col.segs[i - 1].y1 = col.segs[i].y1;   // 最后一块并到上一块
      col.segs.splice(i, 1);
    }
    renderCrop();
  }

  function mergeColAt(i) {
    if (B.cols.length <= 1) return;
    var a = B.cols[i], b = B.cols[i + 1];
    if (!a || !b) return;
    B.cols.splice(i, 2, { x0: a.x0, x1: b.x1, cx0: a.cx0, cx1: b.cx1, segs: [] });
    reanalyze();
  }

  function bindCropLayer() {
    var layer = $('#cropLayer');

    // 点击：横切 / 竖切 / 合并
    layer.addEventListener('click', function (e) {
      var kill = e.target.closest('.kill');
      if (kill) {
        e.stopPropagation();
        mergeRowAt(+kill.getAttribute('data-kill-c'), +kill.getAttribute('data-kill-i'));
        return;
      }
      var vkill = e.target.closest('.vkill');
      if (vkill) {
        e.stopPropagation();
        mergeColAt(+vkill.getAttribute('data-vkill'));
        return;
      }
      if (e.target.closest('.crop-cut') || e.target.closest('.crop-vcut')) return;

      var x = relX(e.clientX), y = relY(e.clientY);
      if (B.vMode) {
        if (!cutColAt(x)) api().toast('离边界太近，换个位置点');
        return;
      }
      if (!cutRowAt(x, y)) api().toast('离边界太近，换个位置点');
    });

    // 拖拽：栏边界 / 行边界
    layer.addEventListener('pointerdown', function (e) {
      var vc = e.target.closest('.crop-vcut');
      if (vc) {
        if (!B.vMode) return;            // 横切模式下竖线只做提示，不响应拖动
        e.preventDefault();
        e.stopPropagation();
        var ci = +vc.getAttribute('data-vcut');
        var A = B.cols[ci], Bc = B.cols[ci + 1];
        var movedV = false;
        function onMoveV(ev) {
          var x = relX(ev.clientX);
          x = Math.min(Bc.x1 - MIN_COL, Math.max(A.x0 + MIN_COL, x));
          A.x1 = x; Bc.x0 = x;
          movedV = true;
          vc.style.left = (x * 100).toFixed(3) + '%';
          $$('#cropLayer .crop-seg[data-c="' + ci + '"]').forEach(function (el) {
            el.style.width = ((A.x1 - A.x0) * 100).toFixed(3) + '%';
          });
          $$('#cropLayer .crop-seg[data-c="' + (ci + 1) + '"]').forEach(function (el) {
            el.style.left = (x * 100).toFixed(3) + '%';
            el.style.width = ((Bc.x1 - Bc.x0) * 100).toFixed(3) + '%';
          });
        }
        function onUpV() {
          document.removeEventListener('pointermove', onMoveV);
          document.removeEventListener('pointerup', onUpV);
          if (movedV) reanalyze();          // 栏宽变了，重新按行切
        }
        document.addEventListener('pointermove', onMoveV);
        document.addEventListener('pointerup', onUpV);
        return;
      }

      var cut = e.target.closest('.crop-cut');
      if (!cut) return;
      e.preventDefault();
      e.stopPropagation();
      var ci2 = +cut.getAttribute('data-cut-c');
      var i2 = +cut.getAttribute('data-cut-i');
      var col = B.cols[ci2];
      if (!col) return;
      var s0 = col.segs[i2], s1 = col.segs[i2 + 1];
      if (!s0 || !s1) return;
      var segEls = $$('#cropLayer .crop-seg[data-c="' + ci2 + '"]');
      var moved2 = false;

      function onMove(ev) {
        var y = relY(ev.clientY);
        y = Math.min(s1.y1 - MIN_SEG, Math.max(s0.y0 + MIN_SEG, y));
        s0.y1 = y; s1.y0 = y;
        moved2 = true;
        if (segEls[i2]) segEls[i2].style.height = ((s0.y1 - s0.y0) * 100).toFixed(3) + '%';
        if (segEls[i2 + 1]) {
          segEls[i2 + 1].style.top = (y * 100).toFixed(3) + '%';
          segEls[i2 + 1].style.height = ((s1.y1 - y) * 100).toFixed(3) + '%';
        }
      }
      function onUp() {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        if (moved2) renderCrop();
      }
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
  }

  /* ================= 裁剪出单题图 ================= */

  function cropOne(col, seg, maxW, quality) {
    return new Promise(function (resolve, reject) {
      try {
        var img = B.img;
        var iw = img.naturalWidth, ih = img.naturalHeight;
        var x0 = Math.round(iw * col.cx0);
        var x1 = Math.round(iw * col.cx1);
        var y0 = Math.round(ih * seg.y0);
        var y1 = Math.round(ih * seg.y1);
        var padY = Math.round((y1 - y0) * 0.05);
        var padX = Math.round((x1 - x0) * 0.03);
        x0 = Math.max(0, x0 - padX);
        x1 = Math.min(iw, x1 + padX);
        y0 = Math.max(0, y0 - padY);
        y1 = Math.min(ih, y1 + padY);
        var cw = Math.max(1, x1 - x0), ch = Math.max(1, y1 - y0);
        var k = Math.min(1, (maxW || 1200) / cw, 1600 / ch);
        var cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(cw * k));
        cv.height = Math.max(1, Math.round(ch * k));
        var ctx = cv.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.drawImage(img, x0, y0, cw, ch, 0, 0, cv.width, cv.height);
        resolve(cv.toDataURL('image/jpeg', quality || 0.82));
      } catch (e) { reject(e); }
    });
  }

  /* ================= 批量确认区 ================= */

  function toItems() {
    var all = flatSegs();
    if (!all.length) return;
    if (B.busy) return;
    B.busy = true;
    $('#btnToItems').disabled = true;
    $('#btnToItems').textContent = '正在裁剪…';

    var prev = B.items;                    // AI 切题预填的字段，数目对得上就沿用
    var keepPrev = prev.length === all.length;

    var jobs = all.map(function (f) { return cropOne(f.col, f.seg, 1200, 0.82); });
    Promise.all(jobs).then(function (imgs) {
      var hts = all.map(function (f) { return f.seg.y1 - f.seg.y0; }).sort(function (a, b) { return a - b; });
      var medH = hts[Math.floor(hts.length / 2)] || 0;
      B.items = imgs.map(function (src, i) {
        var h = all[i].seg.y1 - all[i].seg.y0;
        var old = keepPrev ? prev[i] : null;
        return {
          tiny: medH > 0 && h < medH * 0.6,
          key: 'b' + i + '_' + Date.now().toString(36),
          img: src,
          subject: (old && old.subject) || B.unified.subject || guessSubject(),
          knowledge: (old && old.knowledge) || '',
          code: (old && old.code) || B.unified.code || '',
          difficulty: (old && old.difficulty) || 2,
          source: (old && old.source) || B.unified.source || '',
          stem: (old && old.stem) || '',
          note: (old && old.note) || ''
        };
      });
      renderItems();
      $('#cropWrap').hidden = true;
      $('#batchItems').hidden = false;
      setTimeout(function () {
        window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
      }, 30);
    }).catch(function (e) {
      api().toast('裁剪失败：' + e.message);
    }).then(function () {
      B.busy = false;
      $('#btnToItems').disabled = false;
      if ($('#batchItems').hidden) renderCrop();
    });
  }

  /* 没指定过学科时：优先用录题页里选的那个，其次上一道题，最后第一科 */
  function guessSubject() {
    var S = api().S;
    if (S.pending && S.pending.subject) return S.pending.subject;
    var qs = S.questions || [];
    var last = qs[qs.length - 1];
    if (last && S.subjects.indexOf(last.subject) >= 0) return last.subject;
    return S.subjects[0] || '数学';
  }

  /* 拍照前选过学科，就带进整页切题；没选过则留空让 AI / 上一题兜底
     force = 一换新图就按当前所选学科重来（「拍照前选了」优先于上次的统一设置） */
  function seedSubject(force) {
    var pend = api().S.pending && api().S.pending.subject;
    if (force) {
      if (pend) B.unified.subject = pend;
      return;
    }
    if (B.unified.subject) return;
    if (pend) B.unified.subject = pend;
  }

  function subjectOptions(cur) {
    return api().S.subjects.map(function (s) {
      return '<option value="' + api().esc(s) + '"' + (s === cur ? ' selected' : '') + '>' + api().esc(s) + '</option>';
    }).join('');
  }
  function codeOptions(cur) {
    return '<option value="">未选</option>' + api().S.codes.map(function (c) {
      return '<option value="' + api().esc(c.id) + '"' + (c.id === cur ? ' selected' : '') + '>' +
        api().esc(c.id + ' ' + c.name) + '</option>';
    }).join('');
  }

  function renderItems() {
    var n = B.items.length;
    var subj = B.unified.subject || guessSubject();
    var bar = '' +
      '<div class="batch-bar">' +
      '<div class="t">共有 ' + n + ' 题待入库 · 先统一，再逐题改</div>' +
      '<div class="row"><label>学科</label><select id="uSubject">' + subjectOptions(subj) + '</select>' +
      '<button class="btn btn-sm btn-ghost" id="uApplySub">全用这个</button></div>' +
      '<div class="row"><label>错因</label><select id="uCode">' + codeOptions(B.unified.code) + '</select>' +
      '<button class="btn btn-sm btn-ghost" id="uApplyCode">全用这个</button></div>' +
      '<div class="row"><label>来源</label><input id="uSource" placeholder="如：期中卷 第 2 页" value="' + api().esc(B.unified.source) + '"></div>' +
      '</div>';

    var cards = B.items.map(function (it, i) {
      return '' +
        '<div class="bq-card" data-i="' + i + '">' +
        '<div class="bq-head">' +
        '<img class="bq-thumb" data-zoom="' + i + '" src="' + (it.img || '') + '" alt="第' + (i + 1) + '题">' +
        '<div class="bq-t"><b>第 ' + (i + 1) + ' 题</b>' +
        '<div class="sub">' + (it.tiny
          ? '<span style="color:var(--warn-ink)">像是页眉/页码，建议移除</span>'
          : api().esc(it.subject) + ' · 点图看大图') + '</div></div>' +
        '<button class="bq-kill" data-del="' + i + '">移除</button>' +
        '</div>' +
        '<div class="bq-fields">' +
        '<div class="f"><label>学科</label><select data-f="subject" data-i="' + i + '">' + subjectOptions(it.subject) + '</select></div>' +
        '<div class="f"><label>错因码</label><select data-f="code" data-i="' + i + '">' + codeOptions(it.code) + '</select></div>' +
        '<div class="f wide"><label>知识点（留空记为「未分类」）</label>' +
        '<input data-f="knowledge" data-i="' + i + '" list="bqKL" value="' + api().esc(it.knowledge) + '" placeholder="如：分式方程增根"></div>' +
        '</div>' +
        '<button class="bq-more-btn" data-more="' + i + '">＋ 补题干 / 关键一步</button>' +
        '<div class="bq-more" data-morebox="' + i + '" hidden>' +
        '<div class="bq-fields">' +
        '<div class="f wide"><label>题干（有文本才能出变式题）</label>' +
        '<textarea data-f="stem" data-i="' + i + '" rows="2" placeholder="可留空，看图也能重做">' + api().esc(it.stem) + '</textarea></div>' +
        '<div class="f wide"><label>关键一步 / 正确解法</label>' +
        '<input data-f="note" data-i="' + i + '" value="' + api().esc(it.note) + '" placeholder="卡住我的是：…"></div>' +
        '</div></div>' +
        '</div>';
    }).join('');

    var foot = '' +
      '<div class="btn-row" style="margin-top:4px">' +
      '<button class="btn btn-ghost" id="bqBack">回到切题</button>' +
      '<button class="btn btn-primary" id="bqSave">全部存入题库</button>' +
      '</div>' +
      '<p class="crop-hint" style="text-align:center">入库后统一排在明天开始重做</p>';

    $('#batchItems').innerHTML = bar + cards + foot +
      '<datalist id="bqKL">' + knowledgeOptions(subj) + '</datalist>';

    bindItems();
  }

  function knowledgeOptions(subject) {
    var arr = (api().S.knowledge || {})[subject] || [];
    return arr.map(function (k) { return '<option value="' + api().esc(k) + '">'; }).join('');
  }

  function bindItems() {
    var host = $('#batchItems');

    host.addEventListener('change', onFieldChange);
    host.addEventListener('input', onFieldChange);

    function onFieldChange(e) {
      var el = e.target;
      var i = el.getAttribute('data-i');
      var f = el.getAttribute('data-f');
      if (i == null || !f) {
        if (el.id === 'uSubject') {
          B.unified.subject = el.value;
          var dl = $('#bqKL');
          if (dl) dl.innerHTML = knowledgeOptions(el.value);
        }
        if (el.id === 'uCode') B.unified.code = el.value;
        if (el.id === 'uSource') B.unified.source = el.value;
        return;
      }
      var it = B.items[+i];
      if (!it) return;
      it[f] = el.value;
      if (f === 'subject') {
        var dl2 = $('#bqKL');
        if (dl2) dl2.innerHTML = knowledgeOptions(el.value);
      }
    }

    host.addEventListener('click', function (e) {
      var del = e.target.closest('[data-del]');
      if (del) {
        var i = +del.getAttribute('data-del');
        B.items.splice(i, 1);
        if (!B.items.length) {
          api().toast('都移除了，回到切题重新选');
          $('#batchItems').hidden = true;
          $('#cropWrap').hidden = false;
          renderCrop();
        } else renderItems();
        return;
      }
      if (e.target.id === 'uApplySub') {
        var s = $('#uSubject').value;
        B.unified.subject = s;
        B.items.forEach(function (it) { it.subject = s; });
        renderItems(); api().toast('学科统一为 ' + s);
        return;
      }
      if (e.target.id === 'uApplyCode') {
        var c = $('#uCode').value;
        B.unified.code = c;
        B.items.forEach(function (it) { it.code = c; });
        renderItems(); api().toast(c ? '错因统一为 ' + c : '已清空错因');
        return;
      }
      var more = e.target.closest('[data-more]');
      if (more) {
        var mi = more.getAttribute('data-more');
        var box = host.querySelector('[data-morebox="' + mi + '"]');
        if (box) {
          box.hidden = !box.hidden;
          more.textContent = box.hidden ? '＋ 补题干 / 关键一步' : '收起';
        }
        return;
      }
      var zoom = e.target.closest('[data-zoom]');
      if (zoom) {
        var zi = +zoom.getAttribute('data-zoom');
        var zImg = B.items[zi] && B.items[zi].img;
        if (zImg) api().openSheet(
          '<h2>第 ' + (zi + 1) + ' 题</h2>' +
          '<p class="sub">切下来的原图，看是否切全了</p>' +
          '<img class="big" src="' + zImg + '" alt="题目">'
        );
        return;
      }
      if (e.target.id === 'bqBack') {
        $('#batchItems').hidden = true;
        $('#cropWrap').hidden = false;
        renderCrop();
        return;
      }
      if (e.target.id === 'bqSave') saveAll();
    });
  }

  function saveAll() {
    if (!B.items.length) return;
    var empty = B.items.filter(function (it) { return !String(it.knowledge || '').trim(); }).length;
    if (empty && !confirm('有 ' + empty + ' 题没填知识点，会记为「未分类」。\n还能在题库里补，继续？')) return;

    var btn = $('#bqSave');
    btn.disabled = true;
    btn.textContent = '正在入库…';

    var chain = Promise.resolve();
    B.items.forEach(function (it) {
      chain = chain.then(function () {
        return api().createQuestion({
          subject: it.subject,
          knowledge: String(it.knowledge || '').trim() || '未分类',
          errorCode: it.code || '',
          difficulty: it.difficulty || 2,
          source: it.source || B.unified.source || '',
          stem: it.stem || '',
          note: it.note || '',
          image: it.img || ''
        }).then(function () {
          if (it.knowledge) api().rememberKnowledge(it.subject, String(it.knowledge).trim());
        });
      });
    });

    chain.then(function () {
      var n = B.items.length;
      api().toast('已存入 ' + n + ' 题，明天开始重做');
      resetBatch();
      api().go('bank');
    }).catch(function (e) {
      api().toast('入库失败：' + e.message);
      btn.disabled = false;
      btn.textContent = '全部存入题库';
    });
  }

  /* ================= AI 切题（可选增强） ================= */

  var PROMPT_SEG = [
    '你是初中试卷切题助手。图中是一整页试题，通常有 3 到 8 道彼此独立的题目。',
    '请找出每道独立题目的纵向区域，并识别其内容。只输出一个 JSON 对象，不要任何解释：',
    '{"items":[{"y0":0.03,"y1":0.19,"stem":"题干文字含选项","subject":"数学","knowledge":"知识点6字内","errorCode":"E6","difficulty":2}]}',
    'y0/y1 是该题在图中的纵向起止位置，用 0 到 1 的相对比例表示（图最上方=0，最下方=1），按从上到下顺序排列。',
    'subject 只能是 语文/数学/英语/物理/化学/生物/道法/历史/地理 之一。',
    'errorCode：E1概念不清 E2公式记错 E3审题失误 E4计算错误 E5方法选错 E6步骤跳步 E7单位换算 E8时间不够 E9答题不规范。',
    '看不清的字段填空字符串；不要把页眉、页码当成题目。'
  ].join('\n');

  function aiSeg() {
    if (!api().aiReady()) { api().toast('设置里配好接口和密钥才能用 AI 切题'); return; }
    if (!B.src) return;
    var btn = $('#btnAiSeg');
    btn.disabled = true;
    btn.textContent = '识别中…';
    var hadCols = B.cols.length > 1;
    api().aiChat([
      { role: 'user', content: [{ type: 'text', text: PROMPT_SEG }, api().imagePart(B.src)] }
    ], 2000).then(function (txt) {
      var j = api().extractJSON(txt);
      if (!j || !Array.isArray(j.items) || !j.items.length) throw new Error('没识别出题目');
      var items = j.items
        .filter(function (x) { return typeof x.y0 === 'number' && typeof x.y1 === 'number' && x.y1 > x.y0; })
        .sort(function (a, b) { return a.y0 - b.y0; });
      if (!items.length) throw new Error('返回的位置信息不完整');

      // AI 只按整页纵切，先回到单栏，复用单栏的左右内容边界
      B.cols = [{ x0: 0, x1: 1, cx0: 0, cx1: 1, segs: [] }];
      try { analyzeAll(B.img); } catch (e) { /* 忽略：cx 用默认整宽 */ }
      B.cols[0].segs = items.map(function (x) {
        return { y0: Math.max(0, x.y0), y1: Math.min(1, x.y1) };
      });
      B.bounds = { x0: B.cols[0].cx0, x1: B.cols[0].cx1 };
      renderCrop();

      // 预先带回识别到的字段；拍照前选过学科时以用户为准
      B.items = items.map(function (x, i) {
        return {
          key: 'a' + i,
          img: '',
          subject: B.unified.subject || (api().S.subjects.indexOf(x.subject) >= 0 ? x.subject : guessSubject()),
          knowledge: x.knowledge || '',
          code: x.code || x.errorCode || '',
          difficulty: x.difficulty || 2,
          source: B.unified.source || '',
          stem: x.stem || '',
          note: ''
        };
      });
      api().toast((hadCols ? 'AI 按单栏重切了 ' : 'AI 切出 ') + B.cols[0].segs.length + ' 题，请核对');
    }).catch(function (e) {
      api().toast('AI 切题失败：' + e.message);
    }).then(function () {
      btn.disabled = false;
      btn.textContent = 'AI 切题';
    });
  }

  /* ================= 切法切换 ================= */

  function setSegMode(m) {
    B.vMode = m === 'v';
    $$('#segSwitch button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-seg') === m);
    });
    var hint = $('#cropHint');
    if (hint) hint.textContent = B.vMode ? HINT_V : HINT_H;
    if ($('#cropLayer') && totalSegs()) renderCrop();
  }

  /* ================= 上传与流程 ================= */

  function handleFile(f) {
    if (!f) return;
    api().toast('处理整页图…', 1200);
    seedSubject(true);
    api().compressImage(f, 2000, 0.88).then(function (dataUrl) {
      B.src = dataUrl;
      var img = new Image();
      img.onload = function () {
        B.img = img;
        B.cols = [{ x0: 0, x1: 1, cx0: 0, cx1: 1, segs: [] }];
        B.bounds = { x0: 0, x1: 1 };
        setSegMode('h');
        $('#bEmpty').hidden = true;
        $('#bPreview').hidden = true;
        $('#bUploader').hidden = true;
        $('#bTools').hidden = false;
        $('#cropImg').src = dataUrl;
        $('#batchItems').hidden = true;
        $('#cropWrap').hidden = false;
        autoSegment();
      };
      img.onerror = function () { api().toast('图片读取失败'); };
      img.src = dataUrl;
    }).catch(function (e) {
      api().toast('图片处理失败：' + e.message);
    });
  }

  function resetBatch() {
    B.src = '';
    B.img = null;
    B.cols = [{ x0: 0, x1: 1, cx0: 0, cx1: 1, segs: [] }];
    B.bounds = { x0: 0, x1: 1 };
    B.items = [];
    B.unified = { subject: '', source: '', code: '' };
    B.vMode = false;
    $('#bEmpty').hidden = false;
    $('#bPreview').hidden = true;
    $('#bUploader').hidden = false;
    $('#bTools').hidden = true;
    $('#cropWrap').hidden = true;
    $('#batchItems').hidden = true;
    $('#batchItems').innerHTML = '';
    $('#bFile').value = '';
    $('#bCam').value = '';
    $('#cropLayer').innerHTML = '';
  }

  function setMode(m) {
    B.mode = m;
    $$('#addMode button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-mode') === m);
    });
    $('#singleWrap').hidden = m !== 'single';
    $('#batchWrap').hidden = m !== 'batch';
    if (m === 'batch') {
      seedSubject();                    // 拍照前选的学科，带进整页切题
      $('#btnAiSeg').disabled = !api() || !api().aiReady();
    }
  }

  function bind() {
    $('#addMode').addEventListener('click', function (e) {
      var b = e.target.closest('[data-mode]');
      if (b) setMode(b.getAttribute('data-mode'));
    });

    $('#bBtnCam').addEventListener('click', function () { $('#bCam').click(); });
    $('#bBtnPick').addEventListener('click', function () { $('#bFile').click(); });
    $('#bReplace').addEventListener('click', function () { $('#bFile').click(); });
    $('#bDrop').addEventListener('click', function () { resetBatch(); api().toast('已移除'); });
    $('#bFile').addEventListener('change', function (e) { handleFile(e.target.files && e.target.files[0]); });
    $('#bCam').addEventListener('change', function (e) { handleFile(e.target.files && e.target.files[0]); });

    $('#segSwitch').addEventListener('click', function (e) {
      var b = e.target.closest('[data-seg]');
      if (b) setSegMode(b.getAttribute('data-seg'));
    });

    $('#btnAutoSeg').addEventListener('click', function () {
      if (!B.img) return;
      B.items = [];
      autoSegment();
    });
    $('#btnAiSeg').addEventListener('click', aiSeg);
    $('#btnToItems').addEventListener('click', toItems);

    bindCropLayer();

    // 粘贴 / 拖拽也支持整页
    document.addEventListener('paste', function (e) {
      if (B.mode !== 'batch') return;
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf('image') === 0) {
          handleFile(items[i].getAsFile());
          e.preventDefault();
          return;
        }
      }
    });

    // 把整页图拖进页面任意位置
    document.addEventListener('dragover', function (e) {
      if (B.mode !== 'batch') return;
      if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0) {
        e.preventDefault();
      }
    });
    document.addEventListener('drop', function (e) {
      if (B.mode !== 'batch') return;
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) { e.preventDefault(); handleFile(f); }
    });
  }

  function init() {
    if (!document.getElementById('batchWrap')) return;
    // 兼容旧接口：state.segs / state.bounds 仍指向第一栏
    Object.defineProperty(B, 'segs', {
      get: function () { return (B.cols[0] && B.cols[0].segs) || []; },
      set: function (v) {
        B.cols = [{ x0: 0, x1: 1, cx0: 0, cx1: 1, segs: v || [] }];
        B.bounds = { x0: 0, x1: 1 };
      }
    });
    bind();
    window.CTB_BATCH = {
      state: B,
      open: function () { setMode('batch'); },
      autoSegment: autoSegment,
      analyze: analyze,
      segMode: setSegMode
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else init();
})();
