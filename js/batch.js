/* 错题本 · 整页切题（批量录入）
   一张卷子拍一次 → 自动切成多道题 → 逐题确认入库
   切分算法纯本地：灰度 + Otsu 二值化 + 行/列投影空白带检测，不需要联网、不需要大模型

   结构：一棵区域树（region tree）
     节点沿一个方向切分 —— 'h' 横切（上下叠）、'v' 竖切（左右排）
     没有 dir 的节点就是叶子，一片叶子 = 一道题
   所以：
     · 横切：点哪一块，就只在那块里横着切一刀
     · 竖切：点哪一块，就只把这一块竖着分成左右两半（不再一竖到底）
     · 只有勾了「贯穿整页」才整页分栏（语文/英语那种双栏排版用）
*/
(function () {
  'use strict';

  function api() { return window.CTB; }
  function $(s) { return document.querySelector(s); }
  function $$(s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }

  var B = {
    src: '',
    img: null,
    root: null,          // 区域树的根
    items: [],
    unified: { subject: '', source: '', code: '' },
    mode: 'single',
    vMode: false,        // 竖切模式
    vAll: false,         // 竖切：贯穿整页（整页分栏）
    twoCol: false,       // 像是两栏排版
    busy: false
  };

  var MAX_SEGS = 30;     // 超过这个数说明切碎了，重切

  /* 切一刀之后最少留多宽 / 多高：跟着块自身尺寸走，小块也切得动 */
  function minGap(span) { return Math.max(0.006, Math.abs(span) * 0.08); }

  var S = null;          // 采样缓存 { gray, W, H, T, el }
  var LINES = {};        // 边界线 id → { node, i }（每次渲染重建）
  var dragEndAt = 0;     // 刚拖完的时间戳，用来吞掉紧随其后的 click

  var HINT_H = '点页面任意位置横切一刀 · 拖那条蓝线上下微调 · 点线尾的 × 去掉这条线';
  var HINT_V = '点某一块，只把这一块竖着分成两半 · 拖竖线调宽窄 · 想把整页分栏才勾「贯穿整页」';

  /* ================= 图像采样与分析 ================= */

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

  /* 采样成灰度图，返回 {gray, W, H, hist} */
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

  /* 同一张图只采样一次，后面每次切分都复用 */
  function sample(imgEl) {
    if (S && S.el === imgEl) return S;
    var s = sampling(imgEl, 640);
    var T = otsu(s.hist, s.W * s.H);
    // 纸面拍照常带阴影，Otsu 可能把浅灰当墨迹；收上限保证只认深色
    s.T = Math.min(168, Math.max(70, T));
    s.el = imgEl;
    S = s;
    return s;
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* 区域内（像素框）内容的左右边界：只在这个 y 带里数墨迹，
     这样一块里的窄题目不会被同页别的长行撑到整页宽 */
  function contentX(px0, px1, py0, py1) {
    var s = S;
    var W = s.W, gray = s.gray, T = s.T;
    px0 = clamp(px0, 0, W - 2);
    px1 = clamp(px1, px0 + 1, W - 1);
    py0 = clamp(py0, 0, s.H - 2);
    py1 = clamp(py1, py0 + 1, s.H - 1);

    var h = py1 - py0 + 1;
    var ink = new Float32Array(px1 - px0 + 1);
    for (var y = py0; y <= py1; y++) {
      var base = y * W;
      for (var x = px0; x <= px1; x++) if (gray[base + x] < T) ink[x - px0]++;
    }

    var th = Math.max(2, h * 0.004);
    var pad = Math.round(W * 0.012);
    var xL = -1, xR = -1, i;
    for (i = 0; i < ink.length; i++) if (ink[i] > th) { xL = px0 + i; break; }
    for (i = ink.length - 1; i >= 0; i--) if (ink[i] > th) { xR = px0 + i; break; }
    if (xL < 0 || xR < 0) {
      return { cx0: px0 / W, cx1: (px1 + 1) / W, xL: px0, xR: px1 };
    }
    var a = Math.max(px0, xL - pad), b = Math.min(px1, xR + pad);
    return { cx0: a / W, cx1: (b + 1) / W, xL: a, xR: b };
  }

  function applyContent(leaf) {
    if (!S) return leaf;
    var H = S.H, W = S.W;
    var r = contentX(Math.round(leaf.x0 * W), Math.round(leaf.x1 * W) - 1,
      Math.round(leaf.y0 * H), Math.round(leaf.y1 * H) - 1);
    leaf.cx0 = r.cx0; leaf.cx1 = r.cx1;
    return leaf;
  }

  function refreshContent(node) {
    if (!S || !node) return;
    leavesOf(node).forEach(applyContent);
  }

  /* 在一个纵向区间里按行切块，返回 'h' 节点（没有内容时返回叶子） */
  function analyzeRegionH(x0, x1, y0, y1) {
    var node = { x0: x0, x1: x1, y0: y0, y1: y1, dir: null, cx0: x0, cx1: x1 };
    var s = S;
    if (!s) return node;
    var W = s.W, H = s.H, gray = s.gray, T = s.T;
    var px0 = clamp(Math.round(x0 * W), 0, W - 2);
    var px1 = clamp(Math.round(x1 * W) - 1, px0 + 1, W - 1);
    var py0 = clamp(Math.round(y0 * H), 0, H - 2);
    var py1 = clamp(Math.round(y1 * H) - 1, py0 + 1, H - 1);

    var cx = contentX(px0, px1, py0, py1);
    node.cx0 = cx.cx0; node.cx1 = cx.cx1;

    // 行墨迹：只在本区内容宽度内统计（排除页面外的深色桌面）
    var Hs = py1 - py0 + 1;
    var rowInk = new Float32Array(Hs);
    var w = Math.max(1, cx.xR - cx.xL + 1);
    for (var y = py0; y <= py1; y++) {
      var base = y * W, d = 0;
      for (var x = cx.xL; x <= cx.xR; x++) if (gray[base + x] < T) d++;
      rowInk[y - py0] = d / w;
    }

    // 页码 / 装订线 / 扫描污点：孤立的小块墨迹会干扰切分，先剔掉
    dropOrphans(rowInk, Hs);

    // 空白行阈值：正常文字行 5%~30%，空白行≈0
    var segs = splitByRows(rowInk, Hs, 0.008).segs;
    if (segs.length > MAX_SEGS) segs = splitByRows(rowInk, Hs, 0.016).segs;
    if (!segs.length) return node;

    // 相邻块共用一条边界（不各自收缩），这样拖动那条线时两块严丝合缝地跟着走
    node.dir = 'h';
    node.kids = segs.map(function (sg) {
      return {
        x0: x0, x1: x1,
        y0: y0 + sg.y0 * (y1 - y0),
        y1: y0 + sg.y1 * (y1 - y0),
        dir: null, cx0: cx.cx0, cx1: cx.cx1
      };
    });
    return node;
  }

  /* 整页分析：默认单栏，从上到下按行切 */
  function analyzeAll(imgEl) {
    sample(imgEl);
    B.twoCol = detectTwoCol();
    B.root = analyzeRegionH(0, 1, 0, 1);
    if (!B.root.kids) B.root = { x0: 0, x1: 1, y0: 0, y1: 1, dir: null, cx0: 0, cx1: 1 };
    return B.root;
  }

  /* 顺手判断「这是不是两栏排版」：中间一条竖带几乎没有墨迹，两侧都有 */
  function detectTwoCol() {
    var s = S;
    if (!s) return false;
    var W = s.W, H = s.H, gray = s.gray, T = s.T;
    var colInk = new Uint32Array(W);
    for (var y = 0; y < H; y += 2) {
      var base = y * W;
      for (var x = 0; x < W; x++) if (gray[base + x] < T) colInk[x]++;
    }
    function dens(a, b) {
      var sum = 0;
      for (var k = a; k <= b; k++) sum += colInk[k];
      return sum / Math.max(1, (b - a + 1));
    }
    var lm = dens(Math.round(W * 0.08), Math.round(W * 0.42));
    var rm = dens(Math.round(W * 0.58), Math.round(W * 0.92));
    var mm = dens(Math.round(W * 0.46), Math.round(W * 0.54));
    return Math.min(lm, rm) > (H / 2) * 0.02 && mm < Math.min(lm, rm) * 0.25;
  }

  /* 兼容旧调用：单栏分析，不改动当前状态 */
  function analyze(imgEl) {
    var keep = B.root;
    sample(imgEl);
    var r = analyzeRegionH(0, 1, 0, 1);
    B.root = keep;
    return { segs: leavesOf(r), bounds: { x0: r.cx0, x1: r.cx1 } };
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

  /* 从空白带的长度分布里找出「题间空白」的门槛。
     行距造成的短空白和题与题之间的长空白会形成两级分布，
     排序后最大的那个跳变点就是分界；没有明显两级时退回中位数法。 */
  function pickGapThreshold(runs, H) {
    var maxRun = Math.round(H * 0.25);        // 超过整块 1/4 的不算题间空白（那是页脚白）
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
    if (cuts.length < 2) return { segs: [] };

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

    return { segs: out.map(function (s) { return { y0: s.y0 / H, y1: s.y1 / H }; }) };
  }

  /* ================= 区域树工具 ================= */

  /* 按阅读顺序取叶子：横切从上到下，竖切从左到右，嵌套时依次展开 */
  function leavesOf(node, out) {
    out = out || [];
    if (!node) return out;
    if (!node.dir || !node.kids || !node.kids.length) { out.push(node); return out; }
    node.kids.forEach(function (k) { leavesOf(k, out); });
    return out;
  }

  function isLeaf(n) { return !n || !n.dir || !n.kids || !n.kids.length; }

  function locate(node, x, y) {
    if (!node) return null;
    if (isLeaf(node)) return node;
    for (var i = 0; i < node.kids.length; i++) {
      var k = node.kids[i];
      if (x >= k.x0 - 1e-9 && x <= k.x1 + 1e-9 && y >= k.y0 - 1e-9 && y <= k.y1 + 1e-9) {
        var r = locate(k, x, y);
        if (r) return r;
      }
    }
    return null;
  }

  function replaceNode(oldN, newN) {
    if (B.root === oldN) { B.root = newN; return true; }
    return (function rec(n) {
      if (!n || !n.kids) return false;
      for (var i = 0; i < n.kids.length; i++) {
        if (n.kids[i] === oldN) { n.kids[i] = newN; return true; }
        if (rec(n.kids[i])) return true;
      }
      return false;
    })(B.root);
  }

  /* 按轴把节点（连同所有子孙）的坐标从 [f0,f1] 线性映射到 [t0,t1] */
  function remap(node, axis, f0, f1, t0, t1) {
    var k = (t1 - t0) / Math.max(1e-6, f1 - f0);
    (function rec(n) {
      if (axis === 'y') { n.y0 = t0 + (n.y0 - f0) * k; n.y1 = t0 + (n.y1 - f0) * k; }
      else { n.x0 = t0 + (n.x0 - f0) * k; n.x1 = t0 + (n.x1 - f0) * k; }
      if (n.kids) n.kids.forEach(rec);
    })(node);
  }

  /* ================= 切分动作 ================= */

  function reanalyze() {
    if (!B.img) return;
    try { analyzeAll(B.img); } catch (e) { /* 分析失败就保留原切点 */ }
    renderCrop();
  }

  function autoSegment(silent) {
    if (!B.img) return;
    try {
      analyzeAll(B.img);
      renderCrop();
      if (!silent) {
        var n = leavesOf(B.root).length;
        if (B.twoCol) {
          api().toast('像是两栏排版：切到「竖切」勾上「贯穿整页」，点中间那条缝');
        } else if (n > 1) {
          api().toast('自动切成 ' + n + ' 题，切错可以调');
        } else {
          api().toast('只切出一块。点一下要切的位置就能切开');
        }
      }
    } catch (e) {
      api().toast('自动切分失败：' + e.message);
      B.root = { x0: 0, x1: 1, y0: 0, y1: 1, dir: null, cx0: 0, cx1: 1 };
      renderCrop();
    }
  }

  /* 横切：只切点中的那一块 */
  function splitLeafH(x, y) {
    var leaf = locate(B.root, x, y);
    if (!leaf) { api().toast('点在题目那一块上才能切'); return false; }
    var mg = minGap(leaf.y1 - leaf.y0);
    if (y - leaf.y0 < mg || leaf.y1 - y < mg) {
      api().toast('这一块太矮了，离边远一点再点');
      return false;
    }
    var a = { x0: leaf.x0, x1: leaf.x1, y0: leaf.y0, y1: y, dir: null };
    var b = { x0: leaf.x0, x1: leaf.x1, y0: y, y1: leaf.y1, dir: null };
    applyContent(a); applyContent(b);
    replaceNode(leaf, {
      x0: leaf.x0, x1: leaf.x1, y0: leaf.y0, y1: leaf.y1,
      dir: 'h', kids: [a, b]
    });
    renderCrop();
    return true;
  }

  /* 竖切：只把点中的那一块分成左右两半，上下别的不动 */
  function splitLeafV(x, y) {
    var leaf = locate(B.root, x, y);
    if (!leaf) { api().toast('点在题目那一块上才能切'); return false; }
    var mg = minGap(leaf.x1 - leaf.x0);
    if (x - leaf.x0 < mg || leaf.x1 - x < mg) {
      api().toast('离左右边太近，往中间点点');
      return false;
    }
    var a = { x0: leaf.x0, x1: x, y0: leaf.y0, y1: leaf.y1, dir: null };
    var b = { x0: x, x1: leaf.x1, y0: leaf.y0, y1: leaf.y1, dir: null };
    applyContent(a); applyContent(b);
    replaceNode(leaf, {
      x0: leaf.x0, x1: leaf.x1, y0: leaf.y0, y1: leaf.y1,
      dir: 'v', kids: [a, b]
    });
    renderCrop();
    return true;
  }

  /* 贯穿整页：整页分栏（两栏排版专用） */
  function splitPageV(x) {
    var node = B.root, guard = 0, kid;
    while (node && node.dir === 'v' && guard++ < 20) {
      kid = null;
      for (var i = 0; i < node.kids.length; i++) {
        if (x > node.kids[i].x0 + 1e-6 && x < node.kids[i].x1 - 1e-6) { kid = node.kids[i]; break; }
      }
      if (!kid) break;
      node = kid;
    }
    if (!node) return false;
    if (x - node.x0 < minGap(node.x1 - node.x0) || node.x1 - x < minGap(node.x1 - node.x0)) {
      api().toast('离左右边太近，往中间点点');
      return false;
    }
    // 这一层原来可能是横切的，重新按左右两半分析（旧的横切点会丢，属于预期）
    var a = analyzeRegionH(node.x0, x, node.y0, node.y1);
    var b = analyzeRegionH(x, node.x1, node.y0, node.y1);
    if (!a.dir || !b.dir) {          // 某一边根本没内容（单栏页硬分栏），别切
      api().toast('这一半没有题目，换个位置切');
      return false;
    }
    node.dir = 'v';
    node.kids = [a, b];
    renderCrop();
    return true;
  }

  /* 点线尾的 ×：把相邻两块并成一块 */
  function mergeLine(id) {
    var L = LINES[id];
    if (!L) return;
    var n = L.node, i = L.i;
    var a = n.kids[i], b = n.kids[i + 1];
    if (!a || !b) return;
    var u = {
      x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1),
      y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1),
      dir: null
    };
    applyContent(u);
    n.kids.splice(i, 2, u);
    if (n.kids.length === 1) {
      // 这条线是这一层最后一条：整层收回成一块
      u.x0 = n.x0; u.x1 = n.x1; u.y0 = n.y0; u.y1 = n.y1;
      applyContent(u);
      replaceNode(n, u);
    }
    renderCrop();
  }

  /* ================= 渲染 ================= */

  function pct(v) { return (v * 100).toFixed(3) + '%'; }

  function renderCrop() {
    var wrap = $('#cropWrap');
    var all = leavesOf(B.root);
    if (!all.length) { wrap.hidden = true; return; }
    wrap.hidden = false;

    LINES = {};
    var parts = [];

    // 题目块
    all.forEach(function (l, idx) {
      l._id = 's' + (idx + 1);
      var tiny = (l.y1 - l.y0) < 0.035;
      parts.push('<div class="crop-seg' + (tiny ? ' tiny' : '') + '" data-seg="' + l._id + '" style="' +
        'left:' + pct(l.x0) + ';top:' + pct(l.y0) + ';width:' + pct(l.x1 - l.x0) + ';height:' + pct(l.y1 - l.y0) + '">' +
        '<span class="no">' + (idx + 1) + '</span></div>');
    });

    // 边界线（可拖、可删）
    var li = 0;
    (function walk(n) {
      if (isLeaf(n)) return;
      n.kids.forEach(walk);
      for (var i = 0; i < n.kids.length - 1; i++) {
        var id = 'L' + (++li);
        LINES[id] = { node: n, i: i };
        var a = n.kids[i];
        if (n.dir === 'h') {
          parts.push('<div class="crop-cut" data-line="' + id + '" style="' +
            'left:' + pct(n.x0) + ';width:' + pct(n.x1 - n.x0) + ';top:' + pct(a.y1) + '">' +
            '<button type="button" class="kill" data-kill="' + id + '" aria-label="去掉这条线">×</button>' +
            '</div>');
        } else {
          parts.push('<div class="crop-vcut' + (B.vMode ? ' act' : '') + '" data-line="' + id + '" style="' +
            'left:' + pct(a.x1) + ';top:' + pct(n.y0) + ';height:' + pct(n.y1 - n.y0) + '">' +
            '<button type="button" class="vkill" data-kill="' + id + '" aria-label="去掉这条线">×</button>' +
            '</div>');
        }
      }
    })(B.root);

    var layer = $('#cropLayer');
    layer.innerHTML = parts.join('');
    layer.classList.toggle('vmode', B.vMode);
    var btn = $('#btnToItems');
    if (btn) btn.textContent = '下一步：逐题确认（' + all.length + ' 题）';
  }

  /* 拖拽过程中只挪框和线，不重建 DOM */
  function layout() {
    if (!B.root) return;
    var layer = $('#cropLayer');
    leavesOf(B.root).forEach(function (l) {
      var el = layer.querySelector('[data-seg="' + l._id + '"]');
      if (!el) return;
      el.style.left = pct(l.x0); el.style.top = pct(l.y0);
      el.style.width = pct(l.x1 - l.x0); el.style.height = pct(l.y1 - l.y0);
    });
    Object.keys(LINES).forEach(function (id) {
      var L = LINES[id], n = L.node, a = n.kids[L.i];
      if (!a) return;
      var el = layer.querySelector('[data-line="' + id + '"]');
      if (!el) return;
      if (n.dir === 'h') {
        el.style.left = pct(n.x0); el.style.width = pct(n.x1 - n.x0); el.style.top = pct(a.y1);
      } else {
        el.style.top = pct(n.y0); el.style.height = pct(n.y1 - n.y0); el.style.left = pct(a.x1);
      }
    });
  }

  function relY(clientY) {
    var r = $('#cropInner').getBoundingClientRect();
    if (!r.height) return 0;
    return Math.min(1, Math.max(0, (clientY - r.top) / r.height));
  }
  function relX(clientX) {
    var r = $('#cropInner').getBoundingClientRect();
    if (!r.width) return 0;
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  }

  /* ================= 交互 ================= */

  function bindCropLayer() {
    var layer = $('#cropLayer');

    layer.addEventListener('click', function (e) {
      var kill = e.target.closest('[data-kill]');
      if (kill) {
        e.stopPropagation();
        mergeLine(kill.getAttribute('data-kill'));
        return;
      }
      // 拖完的那一下不算点切
      if (Date.now() - dragEndAt < 400) return;
      if (e.target.closest('[data-line]')) return;

      var x = relX(e.clientX), y = relY(e.clientY);
      if (B.vMode) {
        if (B.vAll) splitPageV(x); else splitLeafV(x, y);
      } else {
        splitLeafH(x, y);
      }
    });

    layer.addEventListener('pointerdown', function (e) {
      if (e.target.closest('[data-kill]')) return;   // 交给 click
      var ln = e.target.closest('[data-line]');
      if (!ln) return;
      var L = LINES[ln.getAttribute('data-line')];
      if (!L) return;
      var n = L.node, i = L.i;
      var a = n.kids[i], b = n.kids[i + 1];
      if (!a || !b) return;
      if (n.dir === 'v' && !B.vMode) return;         // 横切模式下竖线只做提示

      e.preventDefault();
      e.stopPropagation();

      var axis = n.dir === 'h' ? 'y' : 'x';
      var span = axis === 'y' ? (b.y1 - a.y0) : (b.x1 - a.x0);
      var mg = minGap(span);
      var minB = (axis === 'y' ? a.y0 : a.x0) + mg;
      var maxB = (axis === 'y' ? b.y1 : b.x1) - mg;
      var moved = false;

      function onMove(ev) {
        var v = axis === 'y' ? relY(ev.clientY) : relX(ev.clientX);
        v = Math.min(maxB, Math.max(minB, v));
        if (Math.abs(v - (axis === 'y' ? a.y1 : a.x1)) < 0.0006) return;
        if (axis === 'y') {
          // 上块下边 = 下块上边 = 这条线：两块严丝合缝一起走
          remap(a, 'y', a.y0, a.y1, a.y0, v);
          remap(b, 'y', b.y0, b.y1, v, b.y1);
        } else {
          remap(a, 'x', a.x0, a.x1, a.x0, v);
          remap(b, 'x', b.x0, b.x1, v, b.x1);
        }
        moved = true;
        layout();
      }
      function onUp() {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
        if (!moved) return;
        dragEndAt = Date.now();
        refreshContent(a);
        refreshContent(b);
        renderCrop();
      }
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
    });
  }

  /* ================= 裁剪出单题图 ================= */

  function cropOne(leaf, maxW, quality) {
    return new Promise(function (resolve, reject) {
      try {
        var img = B.img;
        var iw = img.naturalWidth, ih = img.naturalHeight;
        var x0 = Math.round(iw * (leaf.cx0 != null ? leaf.cx0 : leaf.x0));
        var x1 = Math.round(iw * (leaf.cx1 != null ? leaf.cx1 : leaf.x1));
        var y0 = Math.round(ih * leaf.y0);
        var y1 = Math.round(ih * leaf.y1);
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
    var all = leavesOf(B.root);
    if (!all.length) return;
    if (B.busy) return;
    B.busy = true;
    $('#btnToItems').disabled = true;
    $('#btnToItems').textContent = '正在裁剪…';

    var prev = B.items;                    // AI 切题预填的字段，数目对得上就沿用
    var keepPrev = prev.length === all.length;

    var jobs = all.map(function (f) { return cropOne(f, 1200, 0.82); });
    Promise.all(jobs).then(function (imgs) {
      var hts = all.map(function (f) { return f.y1 - f.y0; }).sort(function (a, b) { return a - b; });
      var medH = hts[Math.floor(hts.length / 2)] || 0;
      B.items = imgs.map(function (src, i) {
        var h = all[i].y1 - all[i].y0;
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
    var St = api().S;
    if (St.pending && St.pending.subject) return St.pending.subject;
    var qs = St.questions || [];
    var last = qs[qs.length - 1];
    if (last && St.subjects.indexOf(last.subject) >= 0) return last.subject;
    return St.subjects[0] || '数学';
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
    api().aiChat([
      { role: 'user', content: [{ type: 'text', text: PROMPT_SEG }, api().imagePart(B.src)] }
    ], 2000).then(function (txt) {
      var j = api().extractJSON(txt);
      if (!j || !Array.isArray(j.items) || !j.items.length) throw new Error('没识别出题目');
      var items = j.items
        .filter(function (x) { return typeof x.y0 === 'number' && typeof x.y1 === 'number' && x.y1 > x.y0; })
        .sort(function (a, b) { return a.y0 - b.y0; });
      if (!items.length) throw new Error('返回的位置信息不完整');

      // AI 只按整页纵切，回到单栏，再用整页的内容左右边界
      sample(B.img);
      var kids = items.map(function (x) {
        return applyContent({
          x0: 0, x1: 1, dir: null,
          y0: Math.max(0, x.y0), y1: Math.min(1, x.y1)
        });
      });
      B.root = { x0: 0, x1: 1, y0: 0, y1: 1, dir: 'h', kids: kids };
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
      api().toast('AI 切出 ' + B.root.kids.length + ' 题，请核对');
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
    var scope = $('#vScopeRow');
    if (scope) scope.hidden = !B.vMode;
    var hint = $('#cropHint');
    if (hint) hint.textContent = B.vMode ? HINT_V : HINT_H;
    if ($('#cropLayer') && B.root) renderCrop();
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
        S = null;
        B.root = null;
        setSegMode('h');
        $('#vScopeRow').hidden = true;
        $('#vAll').checked = false;
        B.vAll = false;
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
    B.root = null;
    S = null;
    B.items = [];
    B.unified = { subject: '', source: '', code: '' };
    B.vMode = false;
    B.vAll = false;
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
    $('#vScopeRow').hidden = true;
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

    var vAll = $('#vAll');
    if (vAll) vAll.addEventListener('change', function () {
      B.vAll = !!vAll.checked;
      api().toast(B.vAll ? '下次点竖线会贯穿整页' : '只切点中的那一块');
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
    // 兼容旧接口：state.segs 仍是「按阅读顺序的块」
    Object.defineProperty(B, 'segs', {
      get: function () {
        return leavesOf(B.root).map(function (l) { return { y0: l.y0, y1: l.y1 }; });
      },
      set: function (v) {
        var kids = (v || []).map(function (s) {
          return { x0: 0, x1: 1, y0: s.y0, y1: s.y1, dir: null, cx0: 0, cx1: 1 };
        });
        B.root = kids.length
          ? { x0: 0, x1: 1, y0: 0, y1: 1, dir: 'h', kids: kids }
          : null;
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
