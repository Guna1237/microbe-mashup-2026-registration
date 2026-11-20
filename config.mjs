import { existsSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

const specified = process.env.MASHUP_ENV_FILE;
const managedHome = /^(\/home\/[^/]+)\/domains\//.exec(fileURLToPath(import.meta.url))?.[1];
const file = specified || join(managedHome || homedir(), 'microbe-mashup-data', 'runtime.env');

if (specified || (process.platform === 'linux' && process.env.DEMO !== '1' && existsSync(file))) {
  if (!isAbsolute(file)) throw new Error('MASHUP_ENV_FILE must use an absolute path.');
  const metadata = lstatSync(file);
  const uid = process.getuid?.();
  if (!metadata.isFile() || (uid !== undefined && (metadata.uid !== uid || (metadata.mode & 0o077)))) {
    throw new Error('The private runtime environment file must be owned by the application user and have mode 600.');
  }
  loadEnvFile(file);
}
