import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOST_NAME = 'dev.agentropy.buu';

export const buuHome = process.env.BUU_HOME ?? join(homedir(), '.buu');
export const runDir = join(buuHome, 'run');
export const logDir = join(buuHome, 'logs');
export const shotsDir = join(buuHome, 'shots');
export const binDir = join(buuHome, 'bin');
export const wrapperPath = join(binDir, 'buu-host');
