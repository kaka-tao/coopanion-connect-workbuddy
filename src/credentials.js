/**
 * WorkBuddy 桌面端凭据读取。
 *
 * 桌面端 5.6.0 起把 `auth.accessToken` / `auth.refreshToken` 存成
 * `{"$wbEncrypted":1,"envelope":"<base64(JSON)>"}`，envelope 为
 * `{suite,keyId,nonce,authTag,ciphertext}`，AES-256-GCM，12 字节 nonce / 16 字节 tag。
 * 字段密钥由桌面端构建期常量的 SHA-256 派生（keyId = 该哈希前 16 位 hex），
 * 该常量可以由桌面端二进制自己吐出来，所以本扩展不需要用户手填任何 Key。
 *
 * 算法与 `cortico-world-workbuddy` 的 src/credentials.js 一致（同一份上游实现）。
 */

import { execFile } from 'node:child_process';
import { createDecipheriv, createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const AAD_DOMAIN = Buffer.from('WB-AAD\0', 'ascii');
const SYMMETRIC_SCHEME = 'sym-v1';
const FRAMING_FIELD = 2;
const FORMAT_FIELD = 'WBEV1';

const STORE_FILE_RE = /(?:auth|session|state|storage|token|user).*\.(?:json|info)$|^(?:config|store)\.json$|^workbuddy-desktop.*\.info$/i;
const SCANNABLE_EXT = /\.(?:json|info)$/i;

/** 桌面端可能落凭据的地方，越靠前越优先。 */
export function candidateCredentialDirs() {
  const home = homedir();
  const env = process.env;
  const dirs = [];
  const os = platform();
  if (os === 'win32') {
    if (env.LOCALAPPDATA) {
      dirs.push(join(env.LOCALAPPDATA, 'CodeBuddyExtension', 'Data', 'Public', 'auth'));
      dirs.push(join(env.LOCALAPPDATA, 'CodeBuddyExtension', 'Data', 'Public'));
    }
    for (const name of ['WorkBuddy', 'workbuddy', 'WorkBuddyAI', 'WorkBuddy AI', 'workbuddy-ai']) {
      if (env.APPDATA) dirs.push(join(env.APPDATA, name));
    }
  } else if (os === 'darwin') {
    for (const name of ['CodeBuddyExtension', 'WorkBuddy']) {
      dirs.push(join(home, 'Library', 'Application Support', name, 'Data', 'Public', 'auth'));
      dirs.push(join(home, 'Library', 'Application Support', name));
    }
  }
  for (const name of ['WorkBuddy', 'workbuddy', 'WorkBuddyAI', 'workbuddy-ai']) {
    dirs.push(join(home, '.config', name));
  }
  return [...new Set(dirs)];
}

export function isEncryptedWrapper(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === 2 && keys[0] === '$wbEncrypted' && keys[1] === 'envelope'
    && value.$wbEncrypted === 1 && typeof value.envelope === 'string';
}

function strOr(value) {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function findAuthSection(node, depth) {
  if (!node || typeof node !== 'object' || depth > 3) return null;
  if (typeof node.accessToken === 'string' || isEncryptedWrapper(node.accessToken)
    || typeof node.access_token === 'string' || isEncryptedWrapper(node.access_token)) {
    return node;
  }
  for (const key of ['auth', 'session', 'login', 'user', 'account', 'state']) {
    const hit = findAuthSection(node[key], depth + 1);
    if (hit) return hit;
  }
  return null;
}

function pickAccount(parsed) {
  const user = parsed?.user ?? parsed?.account ?? parsed?.profile;
  if (!user || typeof user !== 'object') return undefined;
  return {
    name: strOr(user.name ?? user.nickname ?? user.username ?? user.email),
    uid: strOr(user.uid ?? user.id ?? user.userId),
  };
}

function extractCredential(parsed) {
  const auth = findAuthSection(parsed, 0);
  if (!auth) return null;
  const access = auth.accessToken ?? auth.access_token;
  const refresh = auth.refreshToken ?? auth.refresh_token;
  const encryptedFields = {};
  if (isEncryptedWrapper(access)) encryptedFields.accessToken = access;
  if (isEncryptedWrapper(refresh)) encryptedFields.refreshToken = refresh;
  const hasEncrypted = Object.keys(encryptedFields).length > 0;
  if (typeof access !== 'string' && !encryptedFields.accessToken) return null;
  return {
    credential: {
      accessToken: typeof access === 'string' ? access : undefined,
      refreshToken: typeof refresh === 'string' ? refresh : undefined,
      encryptedFields: hasEncrypted ? encryptedFields : undefined,
      account: pickAccount(parsed),
    },
    encrypted: hasEncrypted,
  };
}

/**
 * 扫描候选目录，按「最近写入」排出所有带登录态的凭据文件。
 *
 * 顺序很重要：登录过多个账号时目录里会并存多份 `.info`，只有最后登录那份的令牌能用，
 * 而它的修改时间最新。`*.observation.json` 等旁挂文件没有令牌，`extractCredential` 会跳过。
 */
export function discoverAllCredentials(overrideDir) {
  const dirs = overrideDir ? [overrideDir] : candidateCredentialDirs();
  const found = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    const files = [];
    for (const name of names) {
      const file = join(dir, name);
      try {
        const info = statSync(file);
        if (!info.isFile()) continue;
        files.push({ file, mtime: info.mtimeMs });
      } catch {
        // 跳过着不到的文件
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    for (const { file } of files) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        const credential = extractCredential(parsed);
        if (credential) found.push({ dir, file, credential: credential.credential, encrypted: credential.encrypted });
      } catch {
        // 不是凭据文件
      }
    }
  }
  return found;
}

/** 最近一次登录的凭据；没有时返回 null。 */
export function discoverCredentials(overrideDir) {
  return discoverAllCredentials(overrideDir)[0] ?? null;
}

function encodeUint32(value) {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function encodeLengthPrefixed(value) {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([encodeUint32(bytes.length), bytes]);
}

/** AAD 转录：域 + 格式版本 + 套件名 + suite + keyId + 分帧标记 + 无 sequence + final=undefined。 */
function fieldAad(keyId, suite) {
  return Buffer.concat([
    AAD_DOMAIN,
    Buffer.from([1]),
    encodeLengthPrefixed(FORMAT_FIELD),
    encodeLengthPrefixed(SYMMETRIC_SCHEME),
    encodeUint32(suite),
    encodeLengthPrefixed(keyId),
    Buffer.from([FRAMING_FIELD]),
    Buffer.from([0]),
    Buffer.from([0]),
  ]);
}

export function deriveAtRestKeyId(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** 密钥负载里的 atRestSecretKey 是 base64 文本，哈希的是这段文本本身。 */
export function deriveAtRestKey(payloadJson) {
  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    throw new Error('at-rest 密钥负载不是合法 JSON');
  }
  const secret = payload?.atRestSecretKey;
  if (typeof secret !== 'string' || secret === '') throw new Error('at-rest 密钥负载里没有 atRestSecretKey');
  return createHash('sha256').update(secret, 'utf8').digest();
}

function openEncryptedField(field, key) {
  let envelope;
  try {
    envelope = JSON.parse(Buffer.from(field.envelope, 'base64').toString('utf8'));
  } catch {
    throw new Error('加密字段 envelope 不是合法 JSON');
  }
  const { suite, keyId, nonce, authTag, ciphertext } = envelope ?? {};
  if (typeof suite !== 'number' || typeof keyId !== 'string' || typeof nonce !== 'string'
    || typeof authTag !== 'string' || typeof ciphertext !== 'string') {
    throw new Error('加密字段 envelope 缺少必要字段');
  }
  const expected = deriveAtRestKeyId(key);
  if (keyId !== expected) {
    throw new Error(`加密字段属于另一把密钥（${keyId} ≠ ${expected}）`);
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64'), { authTagLength: 16 });
  decipher.setAAD(fieldAad(keyId, suite));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** 明文优先；有 encryptedFields 时才需要密钥负载。 */
export function resolveTokens(credential, payloadJson = process.env.WORKBUDDY_AT_REST_KEY) {
  const account = credential?.account;
  if (typeof credential?.accessToken === 'string' && credential.accessToken !== '') {
    return { accessToken: credential.accessToken, refreshToken: credential.refreshToken, source: 'plain', account };
  }
  if (!credential?.encryptedFields?.accessToken) return { source: 'none', account };
  if (!payloadJson) {
    // 局域网/离线也能给出可读原因：不是「没登录」，是「没有解封密钥」。
    return { source: 'none', account, reason: 'unseal-key-missing' };
  }
  try {
    const key = deriveAtRestKey(payloadJson);
    const accessToken = openEncryptedField(credential.encryptedFields.accessToken, key);
    const refreshToken = credential.encryptedFields.refreshToken
      ? openEncryptedField(credential.encryptedFields.refreshToken, key)
      : credential.refreshToken;
    return { accessToken, refreshToken, source: 'decrypted', account };
  } catch {
    return { source: 'none', account };
  }
}

/** 桌面端可执行文件候选，用来向它索取 at-rest 密钥负载。 */
export function candidateAppExecutables() {
  const env = process.env;
  const home = homedir();
  const os = platform();
  const out = [];
  if (os === 'win32') {
    for (const root of [env.LOCALAPPDATA, env.PROGRAMFILES, env.PROGRAMW6432, env['PROGRAMFILES(X86)']]) {
      if (!root) continue;
      for (const dir of ['WorkBuddy', 'WorkBuddy AI']) {
        for (const bin of ['WorkBuddy.exe', 'WorkBuddy AI.exe']) {
          out.push(join(root, 'Programs', dir, bin));
          out.push(join(root, dir, bin));
        }
      }
    }
  } else if (os === 'darwin') {
    out.push('/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy');
    out.push(join(home, 'Applications', 'WorkBuddy.app', 'Contents', 'MacOS', 'WorkBuddy'));
  } else {
    out.push('/opt/WorkBuddy/workbuddy');
    out.push('/usr/bin/workbuddy');
  }
  if (typeof env.WORKBUDDY_APP_EXECUTABLE === 'string' && env.WORKBUDDY_APP_EXECUTABLE !== '') {
    out.unshift(env.WORKBUDDY_APP_EXECUTABLE);
  }
  return [...new Set(out)];
}

const KEY_SCRIPT = "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}catch(e){process.exitCode=3;process.stderr.write(String(e&&e.message||e))}";

/** 让桌面端二进制以 Node 模式跑一小段脚本，把 at-rest 密钥负载打到 stdout。 */
export function fetchAtRestKeyPayload() {
  const executable = candidateAppExecutables().find((p) => existsSync(p));
  if (!executable) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      executable,
      ['-e', KEY_SCRIPT],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 20_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        const payload = String(stdout ?? '').trim();
        resolve(error === null && payload !== '' ? payload : null);
      },
    );
  });
}

const KEY_CACHE_MS = 60_000;
let cachedKeyPayload = null;
let cachedKeyAt = 0;

/** 明文 → 进程环境 → 向桌面端要密钥，成功与失败都缓存 60 秒。 */
export async function resolveTokensWithKey(credential) {
  const plain = resolveTokens(credential);
  if (plain.accessToken || !credential?.encryptedFields?.accessToken) return plain;
  const fresh = cachedKeyPayload !== null && Date.now() - cachedKeyAt < KEY_CACHE_MS;
  if (!fresh) {
    const payload = await fetchAtRestKeyPayload();
    if (payload !== null) {
      cachedKeyPayload = payload;
      cachedKeyAt = Date.now();
    }
  }
  if (cachedKeyPayload === null) return plain;
  return resolveTokens(credential, cachedKeyPayload);
}

export function maskToken(token) {
  if (typeof token !== 'string' || token === '') return '(空)';
  if (token.length <= 12) return `(${token.length} 字符)`;
  return `${token.slice(0, 4)}…${token.slice(-4)} (${token.length} 字符)`;
}
