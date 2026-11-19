import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../../', import.meta.url));
export const onebotRoot = resolve(process.env.ONEBOT_CONFIG_ROOT || join(homedir(), '.config', 'onebot-qq'));
export function onebotPath(...parts) {
    const path = join(...(parts.length ? parts : ['.']));
    if (path === 'onebot-onebot-custom') return project;
    if (path.startsWith('onebot-onebot-custom/')) return join(project, path.slice('onebot-onebot-custom/'.length));
    return join(onebotRoot, path);
}
