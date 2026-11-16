/* 数据层：IndexedDB 优先，file:// 下自动降级到 localStorage */
(function (global) {
  'use strict';

  var DB_NAME = 'cuotiben_db';
  var DB_VER = 1;
  var idb = null;
  var mode = 'idb'; // 'idb' | 'ls'

  function openIDB() {
    return new Promise(function (resolve, reject) {
      if (!global.indexedDB) return reject(new Error('no-indexeddb'));
      var req;
      try { req = indexedDB.open(DB_NAME, DB_VER); } catch (e) { return reject(e); }
      var settled = false;
      var timer = setTimeout(function () {
        if (!settled) { settled = true; reject(new Error('idb-timeout')); }
      }, 2500);
      req.onupgradeneeded = function (ev) {
        var db = ev.target.result;
        if (!db.objectStoreNames.contains('questions')) {
          db.createObjectStore('questions', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('kv')) {
          db.createObjectStore('kv', { keyPath: 'k' });
        }
      };
      req.onsuccess = function () {
        if (settled) return;
        settled = true; clearTimeout(timer);
        resolve(req.result);
      };
      req.onerror = function () {
        if (settled) return;
        settled = true; clearTimeout(timer);
        reject(req.error || new Error('idb-open-failed'));
      };
      req.onblocked = function () { /* 等待旧版本关闭 */ };
    });
  }

  function tx(storeName, mode2) {
    var t = idb.transaction(storeName, mode2);
    return t.objectStore(storeName);
  }

  function wrap(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  /* ---------- localStorage 兜底 ---------- */
  var LS_Q = 'ctb.questions';
  var LS_KV = 'ctb.kv';

  function lsRead(key, dflt) {
    try {
      var v = localStorage.getItem(key);
      return v ? JSON.parse(v) : dflt;
    } catch (e) { return dflt; }
  }
  function lsWrite(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
      return true;
    } catch (e) {
      return false;
    }
  }

  var Store = {
    get mode() { return mode; },

    init: function () {
      return openIDB().then(function (db) {
        idb = db;
        mode = 'idb';
        return mode;
      }).catch(function () {
        mode = 'ls';
        return mode;
      });
    },

    allQuestions: function () {
      if (mode === 'ls') return Promise.resolve(lsRead(LS_Q, []));
      return wrap(tx('questions', 'readonly').getAll()).catch(function () { return []; });
    },

    putQuestion: function (q) {
      if (mode === 'ls') {
        var arr = lsRead(LS_Q, []);
        var i = arr.findIndex(function (x) { return x.id === q.id; });
        if (i >= 0) arr[i] = q; else arr.push(q);
        var ok = lsWrite(LS_Q, arr);
        return Promise.resolve(ok);
      }
      return wrap(tx('questions', 'readwrite').put(q));
    },

    delQuestion: function (id) {
      if (mode === 'ls') {
        var arr = lsRead(LS_Q, []).filter(function (x) { return x.id !== id; });
        lsWrite(LS_Q, arr);
        return Promise.resolve(true);
      }
      return wrap(tx('questions', 'readwrite').delete(id));
    },

    clearQuestions: function () {
      if (mode === 'ls') { lsWrite(LS_Q, []); return Promise.resolve(true); }
      return wrap(tx('questions', 'readwrite').clear());
    },

    kvGet: function (k, dflt) {
      if (mode === 'ls') {
        var obj = lsRead(LS_KV, {});
        return Promise.resolve(obj[k] === undefined ? dflt : obj[k]);
      }
      return wrap(tx('kv', 'readonly').get(k)).then(function (r) {
        return r ? r.v : dflt;
      }).catch(function () { return dflt; });
    },

    kvSet: function (k, v) {
      if (mode === 'ls') {
        var obj = lsRead(LS_KV, {});
        obj[k] = v;
        return Promise.resolve(lsWrite(LS_KV, obj));
      }
      return wrap(tx('kv', 'readwrite').put({ k: k, v: v }));
    }
  };

  global.Store = Store;
})(window);
