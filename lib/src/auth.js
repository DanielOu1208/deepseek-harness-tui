import { Context } from '@deepseek-ai/cordis';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local';
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment';
import { createInterface } from 'node:readline/promises';
export const DEEPSEEK_API_KEY_REF = credentialRef('DEEPSEEK_API_KEY');
export async function openOfficialCredentialService() {
    const root = new Context();
    root.provide(DSH_LAUNCH_ENVIRONMENT_KEY, loadLayeredEnv('deepseek'));
    await root.plugin(LocalCredentialProvider, { watch: false });
    const credentials = root.get('credentials');
    if (credentials === undefined) {
        await root.fiber.dispose();
        throw new Error('deepseek: the official Harness credential service did not start');
    }
    return {
        credentials,
        close: async () => { await root.fiber.dispose(); },
    };
}
export async function readMaskedSecret(input = process.stdin, output = process.stderr) {
    if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
        throw new Error('deepseek auth requires an interactive terminal so the API key can be entered without echoing it');
    }
    output.write('DeepSeek API key: ');
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    return await new Promise((resolve, reject) => {
        let secret = '';
        const cleanup = () => {
            input.off('data', onData);
            input.setRawMode(Boolean(wasRaw));
            input.pause();
        };
        const finish = (error) => {
            cleanup();
            output.write('\n');
            if (error !== undefined)
                reject(error);
            else
                resolve(secret);
        };
        const onData = (chunk) => {
            for (const character of String(chunk)) {
                if (character === '\r' || character === '\n')
                    return finish();
                if (character === '\u0003')
                    return finish(new Error('authentication cancelled'));
                if (character === '\u007f' || character === '\b') {
                    if (secret.length > 0) {
                        secret = secret.slice(0, -1);
                        output.write('\b \b');
                    }
                    continue;
                }
                if (character >= ' ') {
                    secret += character;
                    output.write('*');
                }
            }
        };
        input.on('data', onData);
    });
}
export async function confirmCredentialLogout(input = process.stdin, output = process.stderr) {
    if (!input.isTTY || !output.isTTY) {
        throw new Error('deepseek auth logout requires an interactive terminal for confirmation');
    }
    const prompt = createInterface({ input, output, terminal: true });
    try {
        const answer = await prompt.question('Remove the stored DeepSeek API key? [y/N] ');
        return answer.trim().toLocaleLowerCase() === 'y' || answer.trim().toLocaleLowerCase() === 'yes';
    }
    finally {
        prompt.close();
    }
}
export function describeCredential(info) {
    if (!info.configured)
        return 'Not authenticated. Run `deepseek auth` to store a DeepSeek API key.';
    if (!info.writable) {
        return `Authenticated from ${info.source ?? 'the launch environment'} (read-only). Unset DEEPSEEK_API_KEY in that environment to manage the stored credential.`;
    }
    return `Authenticated from ${info.source ?? 'the official Harness credential store'}.`;
}
