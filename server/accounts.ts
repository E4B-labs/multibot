// Konta użytkowników — DRUGA warstwa autoryzacji obok master tokena
// (cfg.auth.token, rola "owner"). Każde konto ma własne hasło
// (username + password) i własne tokeny sesji. Persystencja: plik JSON
// ~/.openmausbot/accounts.json, zapis przez tmp + rename z mode 0600
// (jak w server/config.ts, byt bezpieczny na sekrety haseł).
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";

export type AccountRole = "owner" | "member";

export interface ServerAccount {
  id: string;
  username: string;
  // zapis jako "scrypt$:" + saltHex + ":" + hashHex
  passHash: string;
  role: AccountRole;
  createdAt: number;
  // tokeny sesji konta (randomBytes(32).toString("hex"))
  sessions: string[];
}

export interface AccountsFile {
  version: number;
  accounts: ServerAccount[];
}

const ACCOUNTS_PATH = join(DATA_DIR, "accounts.json");
const SCRYPT_KEYLEN = 64;
const SCRYPT_PREFIX = "scrypt$:";

function chmodPrivate(path: string, mode: number): void {
  if (process.platform !== "win32" && existsSync(path)) chmodSync(path, mode);
}

// multibot: dane są wrażliwe (hasła) — zapis jak config.json: tmp + rename,
// mode 0600. Na win32 chmod pomijamy (API plików inaczej chroni).
export function loadAccounts(): AccountsFile {
  try {
    const raw = JSON.parse(readFileSync(ACCOUNTS_PATH, "utf8"));
    if (raw && Array.isArray(raw.accounts)) return raw as AccountsFile;
  } catch {
    /* pierwszy start — brak pliku */
  }
  return { version: 1, accounts: [] };
}

export function saveAccounts(file: AccountsFile): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  chmodPrivate(DATA_DIR, 0o700);
  const tmp = join(DATA_DIR, `.accounts.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  chmodPrivate(tmp, 0o600);
  renameSync(tmp, ACCOUNTS_PATH);
  chmodPrivate(ACCOUNTS_PATH, 0o600);
}

export function hashPassword(p: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(p, salt, SCRYPT_KEYLEN);
  return `${SCRYPT_PREFIX}${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(p: string, stored: string): boolean {
  if (typeof stored !== "string" || !stored.startsWith(SCRYPT_PREFIX)) return false;
  const rest = stored.slice(SCRYPT_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep === -1) return false;
  const salt = Buffer.from(rest.slice(0, sep), "hex");
  const expected = Buffer.from(rest.slice(sep + 1), "hex");
  const actual = scryptSync(p, salt, SCRYPT_KEYLEN);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Nowe konto. Pierwsze w pliku = "owner", każde następne = "member".
export function createAccount(username: string, password: string, roleOverride?: AccountRole): ServerAccount {
  const file = loadAccounts();
  const role: AccountRole = roleOverride ?? (file.accounts.length === 0 ? "owner" : "member");
  const account: ServerAccount = {
    id: randomBytes(8).toString("hex"),
    username,
    passHash: hashPassword(password),
    role,
    createdAt: Date.now(),
    sessions: [],
  };
  file.accounts.push(account);
  saveAccounts(file);
  return account;
}

export function findAccountByUsername(username: string): ServerAccount | null {
  const file = loadAccounts();
  return file.accounts.find((a) => a.username === username) ?? null;
}

export function findAccountById(id: string): ServerAccount | null {
  const file = loadAccounts();
  return file.accounts.find((a) => a.id === id) ?? null;
}

export function findAccountByToken(token: string): ServerAccount | null {
  const file = loadAccounts();
  return file.accounts.find((a) => a.sessions.includes(token)) ?? null;
}

export function addAccountSession(acc: ServerAccount, token: string): void {
  const file = loadAccounts();
  const stored = file.accounts.find((a) => a.id === acc.id);
  if (!stored) return;
  if (!stored.sessions.includes(token)) stored.sessions.push(token);
  saveAccounts(file);
}

export function removeAccountSession(acc: ServerAccount, token: string): void {
  const file = loadAccounts();
  const stored = file.accounts.find((a) => a.id === acc.id);
  if (!stored) return;
  stored.sessions = stored.sessions.filter((t) => t !== token);
  saveAccounts(file);
}

export function deleteAccount(id: string): boolean {
  const file = loadAccounts();
  const before = file.accounts.length;
  file.accounts = file.accounts.filter((a) => a.id !== id);
  if (file.accounts.length === before) return false;
  saveAccounts(file);
  return true;
}
