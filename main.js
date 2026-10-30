'use strict';
// 아이폰 옵시디언 볼트 ↔ 구글 드라이브 폴더 양방향 동기화.
// 빌드 없이 그대로 쓰는 일반 JS 플러그인이다 (main.js + manifest.json만 넣으면 됨).
const { Plugin, PluginSettingTab, Setting, Notice, requestUrl, TFile } = require('obsidian');

const REDIRECT = 'http://localhost'; // 데스크톱 OAuth 클라이언트가 허용하는 주소. 아이폰에선 안 열리지만 주소창의 code만 쓰면 된다
const SCOPE = 'https://www.googleapis.com/auth/drive'; // 남이 만든 공유 폴더 파일까지 보려면 drive 전체 범위가 필요
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
const ALL = 'supportsAllDrives=true';

const DEFAULTS = { clientId: '', clientSecret: '', folderId: '', refreshToken: '', intervalMin: 5, state: {}, stateFolder: '' };

// 지난 동기화 기록(prev)과 비교해 이 파일에 무엇을 할지 정한다.
// local: {mtime,size}|undefined, remote: {id,md5}|undefined, prev: {md5,mtime,size}|undefined
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
const basename = (p) => p.slice(p.lastIndexOf('/') + 1);

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

function folderIdFrom(text) {
  const m = text.match(/folders\/([\w-]+)/);
  return m ? m[1] : text.trim();
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

  // ---------- 로그인 ----------
  authUrl() {
    return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id: this.s.clientId, redirect_uri: REDIRECT, response_type: 'code',
      scope: SCOPE, access_type: 'offline', prompt: 'consent',
    });
  }

  async finishLogin(pasted) {
    let code = pasted.trim();
    try { code = new URL(code).searchParams.get('code') || code; } catch (e) { /* code만 붙여 넣은 경우 */ }
    const r = await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT });
    if (!r.refresh_token) throw new Error('refresh_token을 받지 못했어요. 다시 로그인해 주세요');
    this.s.refreshToken = r.refresh_token;
    this.accessToken = null;
    await this.save();
  }

  async tokenRequest(params) {
    const body = new URLSearchParams(Object.assign({ client_id: this.s.clientId, client_secret: this.s.clientSecret }, params)).toString();
    const r = await requestUrl({ url: 'https://oauth2.googleapis.com/token', method: 'POST', contentType: 'application/x-www-form-urlencoded', body, throw: false });
    if (r.status >= 400) throw new Error('구글 로그인 실패: ' + r.text.slice(0, 200));
    return r.json;
  }

  async token() {
    if (this.accessToken && Date.now() < this.accessExp) return this.accessToken;
    if (!this.s.refreshToken) throw new Error('먼저 설정에서 구글 로그인을 해 주세요');
    const r = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: this.s.refreshToken });
    this.accessToken = r.access_token;
    this.accessExp = Date.now() + (r.expires_in - 60) * 1000;
    return this.accessToken;
  }

  async api(url, opts = {}) {
    const go = async () => requestUrl({
      url, method: opts.method || 'GET', body: opts.body, contentType: opts.contentType,
      headers: { Authorization: 'Bearer ' + (await this.token()) }, throw: false,
    });
    let r = await go();
    if (r.status === 401) { this.accessToken = null; r = await go(); }
    if (r.status >= 400) throw new Error(`구글 드라이브 오류 ${r.status}: ${r.text.slice(0, 200)}`);
    return r;
  }

  // ---------- 구글 드라이브 쪽 ----------
  async listRemote() {
    const files = new Map(), folders = new Map([['', this.s.folderId]]);
    const walk = async (id, prefix) => {
      let pageToken = '';
      do {
        const q = encodeURIComponent(`'${id}' in parents and trashed=false`);
        const r = await this.api(`${API}/files?q=${q}&fields=nextPageToken,files(id,name,mimeType,md5Checksum)&pageSize=1000&${ALL}&includeItemsFromAllDrives=true` + (pageToken ? `&pageToken=${pageToken}` : ''));
        for (const f of r.json.files) {
          const p = prefix + f.name;
          if (skip(p)) continue;
          if (f.mimeType === FOLDER) { folders.set(p, f.id); await walk(f.id, p + '/'); }
          else if (!f.mimeType.startsWith('application/vnd.google-apps')) files.set(p, { id: f.id, md5: f.md5Checksum }); // 구글 문서·바로가기는 건너뜀
        }
        pageToken = r.json.nextPageToken;
      } while (pageToken);
    };
    await walk(this.s.folderId, '');
    return { files, folders };
  }

  async ensureRemoteFolder(dir, folders) {
    if (folders.has(dir)) return folders.get(dir);
    const parent = await this.ensureRemoteFolder(dirname(dir), folders);
    const r = await this.api(`${API}/files?fields=id&${ALL}`, {
      method: 'POST', contentType: 'application/json',
      body: JSON.stringify({ name: basename(dir), mimeType: FOLDER, parents: [parent] }),
    });
    folders.set(dir, r.json.id);
    return r.json.id;
  }

  async upload(path, remote, folders) {
    const data = await this.app.vault.adapter.readBinary(path);
    let id = remote && remote.id;
    if (!id) {
      const parent = await this.ensureRemoteFolder(dirname(path), folders);
      const r = await this.api(`${API}/files?fields=id&${ALL}`, {
        method: 'POST', contentType: 'application/json', body: JSON.stringify({ name: basename(path), parents: [parent] }),
      });
      id = r.json.id;
    }
    const r = await this.api(`${UPLOAD}/files/${id}?uploadType=media&fields=id,md5Checksum&${ALL}`, {
      method: 'PATCH', contentType: 'application/octet-stream', body: data,
    });
    return { id, md5: r.json.md5Checksum };
  }

  async download(id) {
    return (await this.api(`${API}/files/${id}?alt=media&${ALL}`)).arrayBuffer;
  }

  // ---------- 볼트 쪽 ----------
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

  // ---------- 동기화 ----------
  async sync(manual) {
    if (this.busy) return;
    if (!this.s.folderId || !this.s.refreshToken) {
      if (manual) new Notice('설정에서 폴더 주소와 구글 로그인을 먼저 해 주세요');
      return;
    }
    this.busy = true;
    const n = { up: 0, down: 0, del: 0, conflict: 0 }, errors = [];
    try {
      if (this.s.stateFolder !== this.s.folderId) { this.s.state = {}; this.s.stateFolder = this.s.folderId; } // 폴더를 바꾸면 기록을 새로 시작
      const { files: remote, folders } = await this.listRemote();
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
        new Notice('지울 파일이 너무 많아서 동기화를 멈췄어요. 폴더 설정을 확인해 주세요.', 15000);
        return;
      }
      for (const [p, act] of actions) {
        try {
          const r = remote.get(p);
          if (act === 'upload') { await this.record(p, await this.upload(p, r, folders)); n.up++; }
          else if (act === 'download') { await this.writeLocal(p, await this.download(r.id)); await this.record(p, r); n.down++; }
          else if (act === 'deleteLocal') { await this.app.vault.trash(this.app.vault.getAbstractFileByPath(p), false); delete state[p]; n.del++; } // 볼트의 .trash로 이동
          else if (act === 'deleteRemote') {
            delete state[p];
            await this.api(`${API}/files/${r ? r.id : ''}?${ALL}`, { method: 'PATCH', contentType: 'application/json', body: '{"trashed":true}' }); // 드라이브 휴지통으로
            n.del++;
          }
          else if (act === 'forget') delete state[p];
          else if (act === 'both') {
            const remoteBuf = await this.download(r.id);
            const localBuf = await this.app.vault.adapter.readBinary(p);
            if (!sameBytes(localBuf, remoteBuf)) {
              // 양쪽이 다르게 고쳐졌으면 아이폰 쪽을 사본으로 남기고 원래 이름엔 드라이브 내용을 둔다
              const copy = conflictName(p);
              await this.app.vault.createBinary(copy, localBuf);
              await this.record(copy, await this.upload(copy, null, folders));
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
    const text = (name, desc, key, password) => new Setting(el).setName(name).setDesc(desc).addText((t) => {
      if (password) t.inputEl.type = 'password';
      t.setValue(s[key]).onChange(async (v) => { s[key] = key === 'folderId' ? folderIdFrom(v) : v.trim(); await p.save(); });
    });
    text('클라이언트 ID', 'Google Cloud에서 만든 데스크톱 앱 OAuth 클라이언트 ID', 'clientId');
    text('클라이언트 보안 비밀', '같은 클라이언트의 보안 비밀번호', 'clientSecret', true);
    text('드라이브 폴더', '볼트로 쓸 구글 드라이브 폴더 주소(drive.google.com/drive/folders/...) 또는 ID', 'folderId');
    new Setting(el).setName('자동 동기화 간격(분)').setDesc('0이면 끔. 바꾼 뒤 옵시디언을 다시 열어야 적용돼요').addText((t) =>
      t.setValue(String(s.intervalMin)).onChange(async (v) => { s.intervalMin = Math.max(0, Number(v) || 0); await p.save(); }));

    new Setting(el).setName('1. 구글 로그인 열기')
      .setDesc(s.refreshToken ? '로그인되어 있어요. 다시 하려면 눌러요.' : '로그인 후 "연결할 수 없음" 페이지가 나오면 그 주소창 주소를 통째로 복사해요.')
      .addButton((b) => b.setButtonText('로그인').onClick(() => {
        if (!s.clientId) return new Notice('클라이언트 ID를 먼저 넣어 주세요');
        window.open(p.authUrl());
      }));
    let pasted = '';
    new Setting(el).setName('2. 복사한 주소 붙여넣기').setDesc('http://localhost/?code=... 로 시작하는 주소')
      .addText((t) => t.onChange((v) => { pasted = v; }))
      .addButton((b) => b.setButtonText('확인').setCta().onClick(async () => {
        try { await p.finishLogin(pasted); new Notice('구글 로그인 완료'); this.display(); }
        catch (e) { new Notice(e.message, 10000); }
      }));
    new Setting(el).setName('지금 동기화').addButton((b) => b.setButtonText('동기화').onClick(() => p.sync(true)));
  }
}

module.exports = GDriveSync;
module.exports.decide = decide; // 자체 검사(test.js)용
module.exports.tooManyDeletes = tooManyDeletes;
module.exports.conflictName = conflictName;
