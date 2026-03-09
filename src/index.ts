import type { Env, TelegramUpdate } from './types';
import { loadConfig, type Config } from './config';
import { sendTelegramMessage, sendTypingAction } from './telegram';
import { createOpenAIClient, embedText, buildEmbeddingInput } from './embed';
import { createSupabaseClient, tryClaimUpdate, findRelatedNotes, insertNote, insertLinks, logEnrichments, getCaptureVoice, type SupabaseClientType } from './db';
import { runCaptureAgent } from './capture';

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const config = loadConfig(env);

    // ── 1. Verify webhook secret ─────────────────────────────────────────────
    const incomingSecret = request.headers.get('x-telegram-bot-api-secret-token');
    if (!incomingSecret || incomingSecret !== config.telegramWebhookSecret) {
      return new Response('Forbidden', { status: 403 });
    }

    // ── 2. Parse body ────────────────────────────────────────────────────────
    let update: TelegramUpdate;
    try {
      const raw: unknown = await request.json();
      update = raw as TelegramUpdate;
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    // ── 3. Guard non-message updates ─────────────────────────────────────────
    if (!update.message) {
      return new Response('ok', { status: 200 });
    }

    const message = update.message;
    const chatId = message.chat.id;

    // ── 4. Chat ID whitelist ─────────────────────────────────────────────────
    if (config.allowedChatIds.length > 0 && !config.allowedChatIds.includes(chatId)) {
      console.warn(JSON.stringify({ event: 'unauthorized_chat', chatId }));
      return new Response('ok', { status: 200 });
    }

    // ── 5. Guard non-text messages ───────────────────────────────────────────
    const text = message.text ?? message.caption;
    if (!text) {
      ctx.waitUntil(
        sendTelegramMessage(config, chatId, 'I can only process text for now. Send a text message.')
      );
      return new Response('ok', { status: 200 });
    }

    // ── 6. /start command ────────────────────────────────────────────────────
    if (text.trim() === '/start') {
      ctx.waitUntil(
        sendTelegramMessage(config, chatId, 'ContemPlace is running. Send me any text to capture it as a note.')
      );
      return new Response('ok', { status: 200 });
    }

    // ── 7. Dedup check ───────────────────────────────────────────────────────
    const db = createSupabaseClient(config);
    const isNew = await tryClaimUpdate(db, update.update_id);
    if (!isNew) {
      return new Response('ok', { status: 200 });
    }

    // ── 8. Return 200, process in background ─────────────────────────────────
    ctx.waitUntil(processCapture(config, chatId, text, db));
    return new Response('ok', { status: 200 });
  },
} satisfies ExportedHandler<Env>;

async function processCapture(
  config: Config,
  chatId: number,
  text: string,
  db: SupabaseClientType,
): Promise<void> {
  try {
    const openai = createOpenAIClient(config);

    // Step 1: Embed raw text + fetch capture voice + send typing (all independent)
    const [rawEmbedding, captureVoice] = await Promise.all([
      embedText(openai, config, text),
      getCaptureVoice(db),
      sendTypingAction(config, chatId),
    ]);

    // Step 2: Find related notes using raw embedding
    const relatedNotes = await findRelatedNotes(db, rawEmbedding, config.matchThreshold);

    // Step 3: Run capture LLM (capture voice from DB, not hardcoded)
    const capture = await runCaptureAgent(openai, config, text, relatedNotes, captureVoice);

    if (capture.corrections?.length) {
      console.log(JSON.stringify({ event: 'corrections', corrections: capture.corrections, chatId }));
    }

    // Step 4: Re-embed with metadata augmentation, fall back to raw on failure [Review fix 12-§5d]
    let storedEmbedding: number[];
    let embeddingType = 'augmented';
    try {
      const augmentedInput = buildEmbeddingInput(text, capture);
      storedEmbedding = await embedText(openai, config, augmentedInput);
    } catch (embedErr) {
      console.warn(JSON.stringify({
        event: 'augmented_embed_fallback',
        error: embedErr instanceof Error ? embedErr.message : String(embedErr),
        chatId,
      }));
      storedEmbedding = rawEmbedding;
      embeddingType = 'raw_fallback';
    }

    // Step 5: Insert note and links
    const noteId = await insertNote(db, capture, storedEmbedding, text);
    await insertLinks(db, noteId, capture.links);

    // Step 6: Build HTML confirmation reply
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const sep = '──────────────────────';

    const lines: string[] = [
      `<b>${esc(capture.title)}</b>`,
      sep,
      esc(capture.body),
      '',
      `<i>${capture.type} · ${capture.intent} · ${capture.tags.map(esc).join(', ')}</i>`, // tags escaped [Review fix 08-§3.1]
    ];

    const linkedTitles = capture.links
      .map(l => {
        const matched = relatedNotes.find(n => n.id === l.to_id);
        return matched ? `[[${esc(matched.title)}]]` : null;
      })
      .filter((t): t is string => t !== null);

    if (linkedTitles.length > 0) {
      lines.push(`Linked: ${linkedTitles.join(', ')}`);
    }

    if (capture.corrections?.length) {
      lines.push(`Corrections: ${capture.corrections.map(esc).join(', ')}`);
    }

    if (capture.source_ref) {
      lines.push(`Source: ${esc(capture.source_ref)}`);
    }

    if (capture.entities.length > 0) {
      const entityNames = capture.entities.map(e => esc(e.name)).join(', ');
      lines.push(`Entities: ${entityNames}`);
    }

    const reply = lines.join('\n').slice(0, 4096); // cap at Telegram limit [Review fix 08-§1.2]

    // Step 7: Log enrichment and send reply in parallel [Review fix 11-§1]
    await Promise.all([
      logEnrichments(db, noteId, [
        { enrichment_type: 'capture', model_used: config.captureModel },
        { enrichment_type: `embedding_${embeddingType}`, model_used: config.embedModel },
      ]),
      sendTelegramMessage(config, chatId, reply, 'HTML'),
    ]);
  } catch (err: unknown) {
    // Generic error to user, detailed log to console [Review fix 08-§6.1]
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({
      event: 'capture_error',
      error: errorMessage,
      chatId,
      textPreview: text.slice(0, 100),
    }));
    await sendTelegramMessage(
      config,
      chatId,
      'Something went wrong capturing your note. Check the Worker logs for details.',
    );
  }
}
