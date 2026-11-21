import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

/**
 * Encrypted JSON file store for the Test Console's secrets (LLM provider,
 * model and API keys).
 *
 * - AES-256-GCM (authenticated): any modification of the file is detected.
 * - A fresh random 96-bit IV per write; the format/version are bound as AAD.
 * - The 256-bit master key lives OUTSIDE the project (default
 *   ~/.playwright-test-console/master.key, created on first use with 0600
 *   permissions), so a copied/zipped/committed project folder holds only
 *   ciphertext. Alternatively a passphrase (CONSOLE_MASTER_KEY) is stretched
 *   with scrypt and a per-file random salt (useful for containers/CI).
 * - Files are written atomically (temp file + rename) with 0600 permissions.
 */

export interface SecretStoreOptions {
  /** Encrypted payload file. */
  file: string;
  /** Master key file (32 random bytes, base64). Created on first write if missing. */
  keyFile?: string;
  /** Passphrase alternative to the key file (min. 16 characters). */
  passphrase?: string;
}

export class SecretStoreError extends Error {
  override readonly name = 'SecretStoreError';
}

const FORMAT = 'pw-test-console-secrets';
const VERSION = 1;
const AAD = Buffer.from(`${FORMAT}:v${VERSION}`);
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

const envelopeSchema = z
  .object({
    format: z.literal(FORMAT),
    version: z.literal(VERSION),
    cipher: z.literal('aes-256-gcm'),
    kdf: z.enum(['keyfile', 'scrypt']),
    salt: z.base64().optional(),
    iv: z.base64(),
    tag: z.base64(),
    data: z.base64(),
    updatedAt: z.string(),
  })
  .strict();
type Envelope = z.infer<typeof envelopeSchema>;

export class EncryptedFileStore {
  constructor(private readonly options: SecretStoreOptions) {
    if (!options.keyFile && !options.passphrase)
      throw new SecretStoreError('either a master key file or a passphrase is required');
    if (options.passphrase !== undefined && options.passphrase.length < 16)
      throw new SecretStoreError('the master passphrase must be at least 16 characters');
  }

  get file(): string {
    return this.options.file;
  }

  /** Human-readable description of where the key comes from (no secret material). */
  get keySource(): string {
    return this.options.passphrase ? 'passphrase (CONSOLE_MASTER_KEY)' : `key file ${this.options.keyFile}`;
  }

  exists(): boolean {
    return existsSync(this.options.file);
  }

  /** Decrypts and returns the stored value, or undefined when nothing is stored. */
  read(): unknown {
    if (!this.exists()) return undefined;
    let envelope: Envelope;
    try {
      envelope = envelopeSchema.parse(JSON.parse(readFileSync(this.options.file, 'utf8')));
    } catch {
      throw new SecretStoreError('the secrets file is corrupted or has an unknown format');
    }
    if ((envelope.kdf === 'scrypt') !== Boolean(this.options.passphrase))
      throw new SecretStoreError(
        `the secrets file was encrypted with a ${envelope.kdf === 'scrypt' ? 'passphrase' : 'key file'}, ` +
          `but ${this.keySource} is configured`,
      );
    const key = this.deriveKey(envelope.salt ? Buffer.from(envelope.salt, 'base64') : undefined, false);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAAD(AAD);
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
      try {
        return JSON.parse(plain.toString('utf8')) as unknown;
      } finally {
        plain.fill(0);
      }
    } catch {
      throw new SecretStoreError(
        'cannot decrypt the secrets file (wrong master key or the file was modified)',
      );
    } finally {
      key.fill(0);
    }
  }

  write(value: unknown): void {
    const salt = this.options.passphrase ? randomBytes(16) : undefined;
    const key = this.deriveKey(salt, true);
    const iv = randomBytes(12);
    const plain = Buffer.from(JSON.stringify(value), 'utf8');
    try {
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(AAD);
      const data = Buffer.concat([cipher.update(plain), cipher.final()]);
      const envelope: Envelope = {
        format: FORMAT,
        version: VERSION,
        cipher: 'aes-256-gcm',
        kdf: salt ? 'scrypt' : 'keyfile',
        ...(salt ? { salt: salt.toString('base64') } : {}),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64'),
        updatedAt: new Date().toISOString(),
      };
      writePrivate(this.options.file, `${JSON.stringify(envelope, null, 2)}\n`);
    } finally {
      plain.fill(0);
      key.fill(0);
    }
  }

  clear(): void {
    rmSync(this.options.file, { force: true });
  }

  private deriveKey(salt: Buffer | undefined, create: boolean): Buffer {
    if (this.options.passphrase) {
      if (!salt) throw new SecretStoreError('missing scrypt salt');
      return scryptSync(this.options.passphrase.normalize('NFKC'), salt, 32, SCRYPT);
    }
    const keyFile = this.options.keyFile!;
    if (!existsSync(keyFile)) {
      if (!create) throw new SecretStoreError(`master key file not found: ${keyFile}`);
      try {
        writePrivate(keyFile, randomBytes(32).toString('base64'), 'wx');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const key = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64');
    if (key.length !== 32) throw new SecretStoreError(`master key file is invalid: ${keyFile}`);
    return key;
  }
}

/** Writes a file readable by the current user only; atomic unless an exclusive create is requested. */
function writePrivate(file: string, content: string, flag?: 'wx'): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (flag) {
    writeFileSync(file, content, { mode: 0o600, flag });
    return;
  }
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, content, { mode: 0o600 });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}
