// 옵시디언 "구글 드라이브 폴더 동기화" 플러그인의 중계 스크립트.
// script.google.com에 붙여 넣고 웹 앱(실행: 나, 액세스: 모든 사용자)으로 배포한다.
const KEY = '여기에_비밀_문자열'; // 플러그인 연결 코드의 # 뒤 부분과 같아야 한다
const PARENT_ID = '14ZUu58dIURcIPX6t4EgDnQnaml7QQlHV'; // 공유받은 "7. 안전 서류" 폴더
const ROOT_NAME = '안전담당자 공유메모'; // 그 안의 볼트 폴더
const FOLDER = 'application/vnd.google-apps.folder';
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const ALL = 'supportsAllDrives=true';

function doPost(e) {
  let out;
  try {
    const req = JSON.parse(e.postData.contents);
    if (req.key !== KEY) throw new Error('연결 코드가 맞지 않아요');
    out = { ok: true, result: OPS[req.op](req) };
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

// DriveApp을 쓰면 drive 권한이 자동으로 잡히고, 그 토큰으로 REST API를 바로 부른다(고급 서비스 설정 불필요).
function api(url, opts) {
  const r = UrlFetchApp.fetch(url, Object.assign({ headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true }, opts));
  if (r.getResponseCode() >= 400) throw new Error('드라이브 오류 ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 200));
  return JSON.parse(r.getContentText() || '{}');
}

// 볼트 폴더 전체를 훑어 경로 → {id, md5} 표를 만든다. 점(.)으로 시작하는 폴더·파일과 구글 문서는 뺀다.
function scan() {
  const rootId = DriveApp.getFolderById(PARENT_ID).getFoldersByName(ROOT_NAME).next().getId();
  const files = {}, folders = { '': rootId };
  const walk = (id, prefix) => {
    let pageToken = '';
    do {
      const q = encodeURIComponent(`'${id}' in parents and trashed=false`);
      const r = api(`${API}?q=${q}&fields=nextPageToken,files(id,name,mimeType,md5Checksum)&pageSize=1000&${ALL}&includeItemsFromAllDrives=true` + (pageToken ? '&pageToken=' + pageToken : ''));
      for (const f of r.files) {
        if (f.name.startsWith('.')) continue;
        const p = prefix + f.name;
        if (f.mimeType === FOLDER) { folders[p] = f.id; walk(f.id, p + '/'); }
        else if (!f.mimeType.startsWith('application/vnd.google-apps')) files[p] = { id: f.id, md5: f.md5Checksum };
      }
      pageToken = r.nextPageToken;
    } while (pageToken);
  };
  walk(rootId, '');
  return { files, folders };
}

function create(meta) {
  return api(`${API}?fields=id&${ALL}`, { method: 'post', contentType: 'application/json', payload: JSON.stringify(meta) }).id;
}

// 파일이 들어갈 폴더 id. 없으면 위에서부터 만든다.
function folderFor(path, folders) {
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  if (folders[dir]) return folders[dir];
  const parent = folderFor(dir, folders);
  folders[dir] = create({ name: dir.slice(dir.lastIndexOf('/') + 1), mimeType: FOLDER, parents: [parent] });
  return folders[dir];
}

const OPS = {
  list() {
    const { files } = scan();
    const out = {};
    for (const p in files) out[p] = files[p].md5;
    return out;
  },
  get(req) {
    const { files } = scan();
    const out = {};
    for (const p of req.paths) if (files[p]) out[p] = Utilities.base64Encode(DriveApp.getFileById(files[p].id).getBlob().getBytes());
    return out;
  },
  put(req) {
    const { files, folders } = scan();
    const name = req.path.slice(req.path.lastIndexOf('/') + 1);
    const id = files[req.path] ? files[req.path].id : create({ name, parents: [folderFor(req.path, folders)] });
    const r = api(`${UPLOAD}/${id}?uploadType=media&fields=md5Checksum&${ALL}`, {
      method: 'patch', contentType: req.path.endsWith('.md') ? 'text/markdown' : 'application/octet-stream',
      payload: Utilities.base64Decode(req.data),
    });
    return r.md5Checksum;
  },
  trash(req) {
    const f = scan().files[req.path];
    if (f) api(`${API}/${f.id}?${ALL}`, { method: 'patch', contentType: 'application/json', payload: '{"trashed":true}' }); // 드라이브 휴지통으로
    return true;
  },
};

// 편집기에서 한 번 실행해 권한을 승인하고 볼트가 보이는지 확인하는 용도
function test() {
  Logger.log(Object.keys(OPS.list()).length + '개 파일');
}

// 호출하지 않는다. 이 줄이 있어야 권한 자동 감지가 읽기 전용이 아닌 drive(쓰기) 권한을 요청한다.
function needWriteScope_() {
  DriveApp.createFile('x', '');
}
