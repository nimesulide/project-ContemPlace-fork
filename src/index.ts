import type { Env, TelegramUpdate, TelegramPhotoSize, ServiceCaptureResult, UndoResult } from './types';
import type { Config } from './config';
import { loadConfig } from './config';
import { sendTelegramMessage, sendTypingAction, getFilePath, downloadTelegramFile } from './telegram';
import { createSupabaseClient, tryClaimUpdate, lookupTelegramUser, validateLinkToken, createTelegramConnection, deleteLinkToken } from './db';

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

    // ── 4. Extract text / caption ────────────────────────────────────────────
    const text = message.text ?? message.caption;

    // ── 5. Guard non-text messages ───────────────────────────────────────────
    if (!text) {
      const hint = message.photo
        ? 'Photos need a caption to be captured. Resend with a description of what you\'re capturing.'
        : 'I can only process text for now. Send a text message.';
      ctx.waitUntil(sendTelegramMessage(config, chatId, hint));
      return new Response('ok', { status: 200 });
    }

    // ── 6. /start command (deep link support) ────────────────────────────────
    const trimmed = text.trim();
    if (trimmed === '/start' || trimmed.startsWith('/start ')) {
      const payload = trimmed.slice('/start'.length).trim();
      ctx.waitUntil(handleStart(config, env, chatId, payload));
      return new Response('ok', { status: 200 });
    }

    // ── 7. DB lookup: resolve chatId → userId ────────────────────────────────
    const db = createSupabaseClient(config);
    const userId = await lookupTelegramUser(db, chatId);

    if (!userId) {
      ctx.waitUntil(
        sendTelegramMessage(
          config,
          chatId,
          'To use this bot, connect your Telegram account in the ContemPlace web app settings.',
        ),
      );
      return new Response('ok', { status: 200 });
    }

    // ── 8. /undo command ─────────────────────────────────────────────────────
    if (trimmed === '/undo') {
      ctx.waitUntil(processUndo(env, config, chatId, userId));
      return new Response('ok', { status: 200 });
    }

    // ── 9. Dedup check ───────────────────────────────────────────────────────
    const isNew = await tryClaimUpdate(db, update.update_id);
    if (!isNew) {
      return new Response('ok', { status: 200 });
    }

    // ── 10. Return 200, process capture in background ────────────────────────
    ctx.waitUntil(processCapture(env, config, chatId, text, userId, message.photo));
    return new Response('ok', { status: 200 });
  },
} satisfies ExportedHandler<Env>;

/**
 * Handle the /start command. Supports deep links for account connection.
 * - No payload: instruct user to connect via web app.
 * - With token payload: validate, create connection, delete token.
 */
async function handleStart(
  config: Config,
  env: Env,
  chatId: number,
  payload: string,
): Promise<void> {
  if (!payload) {
    await sendTelegramMessage(
      config,
      chatId,
      'To connect your Telegram account, visit your ContemPlace web app settings and click \'Connect Telegram\'.',
    );
    return;
  }

  // Deep link with token
  const db = createSupabaseClient(config);
  const result = await validateLinkToken(db, payload);

  if (!result) {
    await sendTelegramMessage(
      config,
      chatId,
      'This link has expired or is invalid. Generate a new one from your ContemPlace web app settings.',
    );
    return;
  }

  try {
    await createTelegramConnection(db, result.userId, chatId);
  } catch (err: unknown) {
    // Unique constraint violation on chat_id — already connected
    const code = (err as { code?: string })?.code;
    if (code === '23505') {
      await sendTelegramMessage(
        config,
        chatId,
        'This Telegram chat is already connected to a ContemPlace account.',
      );
      return;
    }
    // Unexpected error
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: 'telegram_connection_error', error: errorMessage, chatId }));
    await sendTelegramMessage(config, chatId, 'Something went wrong connecting your account. Please try again.');
    return;
  }

  await deleteLinkToken(db, payload);

  await sendTelegramMessage(
    config,
    chatId,
    'Connected! You can now send messages here and they\'ll appear in your ContemPlace dashboard.',
  );
}

async function processCapture(
  env: Env,
  config: Config,
  chatId: number,
  text: string,
  userId: string,
  photos?: TelegramPhotoSize[],
): Promise<void> {
  try {
    // Send typing indicator while the pipeline runs
    await sendTypingAction(config, chatId);

    // If a photo is present, download from Telegram and upload to R2
    let imageUrl: string | undefined;
    if (photos && photos.length > 0) {
      imageUrl = await uploadPhoto(env, config, photos);
    }

    // Delegate capture to MCP Worker via Service Binding RPC
    const options: { imageUrl?: string; userId: string } = { userId };
    if (imageUrl) options.imageUrl = imageUrl;
    const result: ServiceCaptureResult = await env.CAPTURE_SERVICE.capture(text, 'telegram', options);

    if (result.corrections?.length) {
      console.log(JSON.stringify({ event: 'corrections', corrections: result.corrections, chatId }));
    }

    // Format HTML reply from the rich result
    const reply = formatTelegramReply(result);

    await sendTelegramMessage(config, chatId, reply, 'HTML');
  } catch (err: unknown) {
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
      'Something went wrong capturing that. Check the Worker logs for details.',
    );
  }
}

/**
 * Download the largest photo variant from Telegram, upload to R2, return the public URL.
 * Returns undefined on any failure — the capture proceeds text-only.
 */
async function uploadPhoto(
  env: Env,
  config: Config,
  photos: TelegramPhotoSize[],
): Promise<string | undefined> {
  try {
    // Pick the largest variant (last element in the array)
    const largest = photos[photos.length - 1]!;

    // Resolve file_id → file_path
    const filePath = await getFilePath(config, largest.file_id);
    if (!filePath) return undefined;

    // Download from Telegram
    const response = await downloadTelegramFile(config, filePath);
    if (!response?.body) return undefined;

    // Upload to R2 with a unique key
    const key = `${crypto.randomUUID()}.jpg`;
    await env.IMAGE_BUCKET.put(key, response.body, {
      httpMetadata: { contentType: 'image/jpeg' },
    });

    // Construct public URL from R2_PUBLIC_URL env var (e.g., "https://pub-<hash>.r2.dev")
    if (!env.R2_PUBLIC_URL) {
      console.warn(JSON.stringify({ event: 'r2_public_url_not_set', key }));
      return undefined;
    }

    const imageUrl = `${env.R2_PUBLIC_URL}/${key}`;
    console.log(JSON.stringify({ event: 'image_uploaded', key, fileSize: largest.file_size }));
    return imageUrl;
  } catch (err) {
    console.error(JSON.stringify({ event: 'image_upload_error', error: String(err) }));
    return undefined;
  }
}

async function processUndo(
  env: Env,
  config: Config,
  chatId: number,
  userId: string,
): Promise<void> {
  try {
    const result: UndoResult = await env.CAPTURE_SERVICE.undoLatest('telegram', userId);

    let reply: string;
    switch (result.action) {
      case 'deleted':
        reply = `Undone: <b>${escapeHtml(result.title!)}</b>`;
        break;
      case 'grace_period_passed':
        reply = 'The grace period has passed. To archive a note, use an MCP session.';
        break;
      case 'none':
        reply = 'Nothing to undo — no recent Telegram captures.';
        break;
    }

    await sendTelegramMessage(config, chatId, reply, 'HTML');
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: 'undo_error', error: errorMessage, chatId }));
    await sendTelegramMessage(config, chatId, 'Something went wrong with undo. Try again.');
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Visual indicators for Telegram reply ─────────────────────────────────────
// Emojis give each classification a consistent visual anchor so the user can
// spot behavioral patterns at a glance without reading every label.

const LINK_EMOJI: Record<string, string> = {
  contradicts: '⚡', related: '🔗',
};
function formatTelegramReply(result: ServiceCaptureResult): string {
  const esc = escapeHtml;
  const sep = '──────────────────────';

  // Title and body are prominent — everything else is italic metadata
  const lines: string[] = [
    `<b>${esc(result.title)}</b>`,
    '',
    esc(result.body),
    '',
    sep,
    `<i>🏷️ ${result.tags.map(esc).join(', ')}</i>`,
  ];

  const linkedEntries = result.links
    .filter(l => l.to_title)
    .map(l => {
      const icon = LINK_EMOJI[l.link_type] ?? '🔗';
      return `<i>${icon} ${esc(l.to_title)} (${l.link_type})</i>`;
    });

  if (linkedEntries.length > 0) {
    lines.push(linkedEntries.join('\n'));
  }

  if (result.corrections?.length) {
    lines.push(`<i>✏️ ${result.corrections.map(esc).join(', ')}</i>`);
  }

  if (result.image_url) {
    lines.push(`<i>📷 image attached</i>`);
  }

  if (result.source_ref) {
    lines.push(`<i>📎 ${esc(result.source_ref)}</i>`);
  }

  return lines.join('\n').slice(0, 4096);
}
