/**
 * Baseten models via Cloudflare AI Gateway (OpenAI-compatible chat completions).
 * @see https://developers.cloudflare.com/ai-gateway/usage/providers/baseten/
 */
import { DEFAULT_CF_AI_GATEWAY_ACCOUNT_ID, DEFAULT_CF_AI_GATEWAY_ID, } from './defaults';
export const DEFAULT_NEMOTRON_ULTRA_BASETEN_MODEL = 'nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B';
/** /au Nemotron: allow longer answers than Workers-default 1024. */
export const DEFAULT_NEMOTRON_MAX_COMPLETION_TOKENS = 8192;
export function buildBasetenChatCompletionsUrl(accountId = DEFAULT_CF_AI_GATEWAY_ACCOUNT_ID, gatewayId = DEFAULT_CF_AI_GATEWAY_ID) {
    return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/baseten/v1/chat/completions`;
}
function gatewayHeaders(config, stream) {
    const headers = {
        Authorization: config.upstreamAuthorization,
        'Content-Type': 'application/json',
        Accept: stream ? 'text/event-stream' : 'application/json',
    };
    if (config.gatewayAuthToken) {
        headers['cf-aig-authorization'] = `Bearer ${config.gatewayAuthToken}`;
    }
    return headers;
}
function clampMaxTokens(maxCompletionTokens) {
    const requested = maxCompletionTokens ?? DEFAULT_NEMOTRON_MAX_COMPLETION_TOKENS;
    return Math.max(DEFAULT_NEMOTRON_MAX_COMPLETION_TOKENS, Math.min(16_384, requested));
}
function extractChatCompletionText(data) {
    const choices = data.choices;
    if (!Array.isArray(choices) || choices.length === 0)
        return '';
    const first = choices[0];
    if (!first || typeof first !== 'object')
        return '';
    const row = first;
    const message = row.message;
    if (message && typeof message === 'object') {
        const content = message.content;
        if (typeof content === 'string')
            return content;
    }
    const delta = row.delta;
    if (delta && typeof delta === 'object') {
        const content = delta.content;
        if (typeof content === 'string')
            return content;
    }
    const text = row.text;
    if (typeof text === 'string')
        return text;
    return '';
}
function extractChatStreamDelta(data) {
    if (data === '[DONE]')
        return '';
    try {
        const parsed = JSON.parse(data);
        return extractChatCompletionText(parsed);
    }
    catch {
        return '';
    }
}
/** Parse OpenAI chat-completions SSE into plain text chunks. */
export function openAiChatCompletionsEventStreamToText() {
    const decoder = new TextDecoder();
    let buffer = '';
    function processLine(line, controller) {
        const trimmed = line.trimEnd();
        if (trimmed === '')
            return;
        if (trimmed.startsWith('data:')) {
            const text = extractChatStreamDelta(trimmed.slice('data:'.length).trim());
            if (text)
                controller.enqueue(text);
            return;
        }
        if (/^(event|id|retry):/.test(trimmed))
            return;
    }
    return new TransformStream({
        transform(chunk, controller) {
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? '';
            for (const line of lines)
                processLine(line, controller);
        },
        flush(controller) {
            buffer += decoder.decode();
            if (buffer)
                processLine(buffer, controller);
        },
    });
}
export async function completeViaGatewayChatCompletions(config, messages, maxCompletionTokens, stream) {
    const body = {
        model: config.chatModel,
        messages,
        stream,
        max_tokens: clampMaxTokens(maxCompletionTokens),
    };
    const res = await fetch(config.chatCompletionsUrl, {
        method: 'POST',
        headers: gatewayHeaders(config, stream),
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Baseten gateway HTTP ${res.status}: ${errText.slice(0, 500)}`);
    }
    if (!stream) {
        const json = (await res.json());
        const text = extractChatCompletionText(json);
        return new Response(JSON.stringify({ response: text }), {
            headers: { 'Content-Type': 'application/json' },
        });
    }
    if (!res.body)
        throw new Error('Baseten gateway stream missing body');
    return res;
}
export async function streamViaGatewayChatCompletions(config, messages, maxCompletionTokens) {
    const res = await completeViaGatewayChatCompletions(config, messages, maxCompletionTokens, true);
    if (!res.body)
        throw new Error('Baseten gateway stream missing body');
    return res.body;
}
