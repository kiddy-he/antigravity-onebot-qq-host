import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanConversationText, cleanDisplayName, createAgentTextExec } from '../src/src/text-boundary.js';
import { createGroupHistory } from '../src/src/group-history.js';

const binaryName = '\n\b\x12\x06示例\n\b\n\x06User\x10\x00';
test('binary QQ nicknames cannot inject control bytes or extra history rows', () => {
    assert.equal(cleanDisplayName(binaryName), '示例 User');
    assert.equal(cleanDisplayName('\x00\x06', '90101'), '90101');
    assert.equal(cleanConversationText('中文🐱♪\n\t原文\r\n\x00\x08\x12'), '中文🐱♪\n\t原文\r\n');
    const history = createGroupHistory();
    history.record('700000012', { senderId: '90101', senderName: binaryName, text: '测试\x00文本' });
    const context = history.formatContext('700000012');
    assert.match(context, /示例 User: 测试文本/u);
    assert.doesNotMatch(context, /[\x00-\x08\x0b\x0c\x0e-\x1f]/u);
});
test('old poisoned context remains usable by review, Qwen, Grok and persona CLI calls without changing tool arguments', async () => {
    const seen = [];
    const exec = createAgentTextExec(async (file, args, options) => { seen.push({ file, args, options }); return { stdout: 'accepted' }; });
    const payload = `最近对话：${binaryName}\n台词：测试台词\n特殊文本：$() \\n`;
    for (const model of ['antigravity/gemini-3.5-flash-lite', 'example/qwen-test', 'grok/grok-4.7']) {
        const args = ['agent', '--agent', 'public-helper', '--model', model, '--message', payload];
        const options = { timeout: 60000, shell: false };
        await exec('/usr/local/bin/openclaw', args, options);
        assert.equal(args.at(-1), payload, 'caller data is not mutated');
        assert.equal(seen.at(-1).args.at(-1), cleanConversationText(payload));
        assert.equal(seen.at(-1).args[2], 'public-helper'); assert.equal(seen.at(-1).options, options);
    }
    await exec('/bin/sh', ['-c', 'printf \\0']);
    assert.deepEqual(seen.at(-1).args, ['-c', 'printf \\0']);
    await exec('/usr/local/bin/openclaw', ['gateway', 'call', 'x', '--params', '{"text":"\\u0000"}']);
    assert.equal(seen.at(-1).args.at(-1), '{"text":"\\u0000"}');
});
