'use strict';
// 아이폰 옵시디언 볼트 ↔ 구글 드라이브 폴더 양방향 동기화.
// 구글 드라이브와는 사용자가 배포한 Apps Script 중계(apps-script/Code.gs)를 통해서만 주고받는다.
// 빌드 없이 그대로 쓰는 일반 JS 플러그인이다 (main.js + manifest.json만 넣으면 됨).
const { Plugin, PluginSettingTab, Setting, Notice, requestUrl, TFile, arrayBufferToBase64, base64ToArrayBuffer } = require('obsidian');

const DEFAULTS = { link: '', intervalMin: 5, state: {}, stateLink: '' };
const GET_CHUNK = 20; // 한 번에 받아 올 파일 수

// 지난 동기화 기록(prev)과 비교해 이 파일에 무엇을 할지 정한다.
// local: {mtime,size}|undefined, remote: {md5}|undefined, prev: {md5,mtime,size}|undefined
function decide(local, remote, prev) {
  if (!prev) {
    if (local && remote) return 'both'; // 처음 보는 양쪽 파일: 내용을 비교해서 처리
    if (local) return 'upload';
    if (remote) return 'download';
    return 'none';
  }
  if (!local && !remote) return 'forget';
  const lc = !!local && (local.mtime !== prev.mtime || local.size !== prev.size);
  const rc = !!remote && remote.md5 !== prev.md5;
  if (!local) return rc ? 'download' : 'deleteRemote';
  if (!remote) return lc ? 'upload' : 'deleteLocal';
  if (lc && rc) return 'both';
  if (lc) return 'upload';
  if (rc) return 'download';
  return 'none';
}

// 볼트가 비었거나 폴더를 잘못 가리켜 한꺼번에 지워지는 사고를 막는다.
function tooManyDeletes(actions, stateCount) {
  const del = actions.filter(([, a]) => a === 'deleteLocal' || a === 'deleteRemote').length;
  return del > 10 && del > stateCount * 0.3;
}

const skip = (p) => p.split('/').some((s) => s.startsWith('.')) || /(^|\/)desktop\.ini$/i.test(p);
const dirname = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

function conflictName(path) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
  const dot = path.lastIndexOf('.');
  const cut = dot > path.lastIndexOf('/') ? dot : path.length;
  return `${path.slice(0, cut)} (아이폰 충돌 ${stamp})${path.slice(cut)}`;
}

function sameBytes(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a), y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

class GDriveSync extends Plugin {
  async onload() {
    this.s = Object.assign({}, DEFAULTS, await this.loadData());
    this.addSettingTab(new SyncTab(this.app, this));
    this.addRibbonIcon('refresh-cw', '구글 드라이브 동기화', () => this.sync(true));
    this.addCommand({ id: 'sync-now', name: '지금 동기화', callback: () => this.sync(true) });
    this.app.workspace.onLayoutReady(() => this.sync(false));
    if (this.s.intervalMin > 0) this.registerInterval(window.setInterval(() => this.sync(false), this.s.intervalMin * 60000));
  }

  save() {
    return this.saveData(this.s);
  }

  // 연결 코드 = 웹 앱 주소#비밀 문자열
  async call(op, args) {
    const [url, key] = this.s.link.split('#');
    const body = JSON.stringify(Object.assign({ key, op }, args));
    let r;
    // 아이폰은 망 전환 등으로 "네트워크 연결이 유실됨"이 잠깐씩 나서 몇 번 다시 시도한다 (모든 작업이 다시 해도 안전함)
    for (let i = 1; ; i++) {
      try { r = await requestUrl({ url, method: 'POST', contentType: 'text/plain', body, throw: false }); break; }
      catch (e) { if (i >= 3) throw e; await new Promise((ok) => setTimeout(ok, 2000 * i)); }
    }
    let j;
    try { j = r.json; } catch (e) { throw new Error(`중계 스크립트 응답이 이상해요 (${r.status}). 연결 코드와 배포 설정을 확인해 주세요`); }
    if (!j.ok) throw new Error(j.error);
    return j.result;
  }

  async upload(path) {
    const data = arrayBufferToBase64(await this.app.vault.adapter.readBinary(path));
    return { md5: await this.call('put', { path, data }) };
  }

  async writeLocal(path, buf) {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) return this.app.vault.modifyBinary(f, buf);
    const dir = dirname(path);
    if (dir && !(await this.app.vault.adapter.exists(dir))) await this.app.vault.createFolder(dir);
    await this.app.vault.createBinary(path, buf);
  }

  async record(path, remote) {
    const st = await this.app.vault.adapter.stat(path);
    this.s.state[path] = { md5: remote.md5, mtime: st.mtime, size: st.size };
  }

  async sync(manual) {
    if (this.busy) return;
    if (!this.s.link.includes('#')) {
      if (manual) new Notice('설정에 연결 코드를 먼저 넣어 주세요');
      return;
    }
    this.busy = true;
    const n = { up: 0, down: 0, del: 0, conflict: 0 }, errors = [];
    try {
      if (this.s.stateLink !== this.s.link) { this.s.state = {}; this.s.stateLink = this.s.link; } // 연결을 바꾸면 기록을 새로 시작
      const remote = new Map(Object.entries(await this.call('list')).filter(([p]) => !skip(p)).map(([p, md5]) => [p, { md5 }]));
      const local = new Map();
      for (const f of this.app.vault.getFiles()) {
        if (skip(f.path)) continue;
        const st = await this.app.vault.adapter.stat(f.path);
        local.set(f.path, { mtime: st.mtime, size: st.size });
      }
      const state = this.s.state;
      const paths = new Set([...local.keys(), ...remote.keys(), ...Object.keys(state)]);
      const actions = [...paths].map((p) => [p, decide(local.get(p), remote.get(p), state[p])]).filter(([, a]) => a !== 'none');
      if (tooManyDeletes(actions, Object.keys(state).length)) {
        new Notice('지울 파일이 너무 많아서 동기화를 멈췄어요. 연결 코드를 확인해 주세요.', 15000);
        return;
      }
      // 드라이브 내용이 필요한 파일은 몇 개씩 묶어서 미리 받아 둔다
      const need = actions.filter(([, a]) => a === 'download' || a === 'both').map(([p]) => p);
      const fetched = new Map();
      for (let i = 0; i < need.length; i += GET_CHUNK) {
        const got = await this.call('get', { paths: need.slice(i, i + GET_CHUNK) });
        for (const p in got) fetched.set(p, base64ToArrayBuffer(got[p]));
      }
      for (const [p, act] of actions) {
        try {
          const r = remote.get(p);
          if ((act === 'download' || act === 'both') && !fetched.has(p)) throw new Error('드라이브에서 받지 못했어요');
          if (act === 'upload') { await this.record(p, await this.upload(p)); n.up++; }
          else if (act === 'download') { await this.writeLocal(p, fetched.get(p)); await this.record(p, r); n.down++; }
          else if (act === 'deleteLocal') { await this.app.vault.trash(this.app.vault.getAbstractFileByPath(p), false); delete state[p]; n.del++; } // 볼트의 .trash로 이동
          else if (act === 'deleteRemote') { delete state[p]; await this.call('trash', { path: p }); n.del++; } // 드라이브 휴지통으로
          else if (act === 'forget') delete state[p];
          else if (act === 'both') {
            const remoteBuf = fetched.get(p);
            const localBuf = await this.app.vault.adapter.readBinary(p);
            if (!sameBytes(localBuf, remoteBuf)) {
              // 양쪽이 다르게 고쳐졌으면 아이폰 쪽을 사본으로 남기고 원래 이름엔 드라이브 내용을 둔다
              const copy = conflictName(p);
              await this.app.vault.createBinary(copy, localBuf);
              await this.record(copy, await this.upload(copy));
              await this.app.vault.modifyBinary(this.app.vault.getAbstractFileByPath(p), remoteBuf);
              n.conflict++;
            }
            await this.record(p, r);
          }
        } catch (e) {
          errors.push(`${p}: ${e.message}`);
        }
        await this.save();
      }
    } catch (e) {
      new Notice('동기화 실패: ' + e.message, 15000);
      return;
    } finally {
      this.busy = false;
    }
    if (errors.length) { console.error('[gdrive-sync]', errors); new Notice(`동기화 중 ${errors.length}개 실패:\n` + errors.slice(0, 3).join('\n'), 15000); }
    const changed = n.up + n.down + n.del + n.conflict;
    if (manual || changed) new Notice(changed ? `동기화 완료: 올림 ${n.up} · 받음 ${n.down} · 삭제 ${n.del} · 충돌 ${n.conflict}` : '동기화 완료: 바뀐 것 없음');
  }
}

class SyncTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const p = this.plugin, s = p.s, el = this.containerEl;
    el.empty();
    new Setting(el).setName('연결 코드').setDesc('https://script.google.com/macros/s/.../exec#비밀문자열 형태로 받은 값을 통째로 붙여 넣어요')
      .addText((t) => { t.inputEl.type = 'password'; t.setValue(s.link).onChange(async (v) => { s.link = v.trim(); await p.save(); }); });
    new Setting(el).setName('자동 동기화 간격(분)').setDesc('0이면 끔. 바꾼 뒤 옵시디언을 다시 열어야 적용돼요').addText((t) =>
      t.setValue(String(s.intervalMin)).onChange(async (v) => { s.intervalMin = Math.max(0, Number(v) || 0); await p.save(); }));
    new Setting(el).setName('지금 동기화').addButton((b) => b.setButtonText('동기화').setCta().onClick(() => p.sync(true)));
  }
}

module.exports = GDriveSync;
module.exports.decide = decide; // 자체 검사(test.js)용
module.exports.tooManyDeletes = tooManyDeletes;
module.exports.conflictName = conflictName;
