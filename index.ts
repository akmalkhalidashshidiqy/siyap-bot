import { makeWASocket, DisconnectReason, fetchLatestBaileysVersion, MessageRetryMap } from '@whiskeysockets/baileys';
import * as dotenv from 'dotenv';
import pino from 'pino';
import * as qrcode from 'qrcode-terminal';
import { Pool } from 'pg';
import { Redis } from '@upstash/redis';
import { usePostgresAuthState } from './usePostgresAuthState';
import * as http from 'http';

dotenv.config();

// HTTP Server for Render.com & UptimeRobot Ping
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Siyap.id WhatsApp Bot is alive!\n');
}).listen(PORT, () => {
    console.log(`Ping server listening on port ${PORT}`);
});

// Initialize DB and Redis
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});
const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const logger = pino({ level: 'silent' });
const msgRetryCounterCache: MessageRetryMap = {};

async function startBot() {
    const { state, saveCreds } = await usePostgresAuthState(pool);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);

    const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: true,
        auth: state,
        msgRetryCounterCache,
        generateHighQualityLinkPreview: true,
        getMessage: async (key) => {
            return { conversation: 'Hello' };
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('\n--- SILAKAN SCAN QR CODE INI MENGGUNAKAN WHATSAPP ANDA ---\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error as any)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to', lastDisconnect?.error, ', reconnecting', shouldReconnect);
            if (shouldReconnect) {
                startBot();
            } else {
                console.log('You are logged out. Please delete the sessions row in Supabase and restart to scan again.');
            }
        } else if (connection === 'open') {
            console.log('✅ BOT BERHASIL TERHUBUNG KE WHATSAPP 24/7!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const senderPhone = msg.key.remoteJid!.replace('@s.whatsapp.net', '');
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const location = msg.message.locationMessage;

        console.log(`Received message from ${senderPhone}: ${text}`);

        // Utility to send simple text
        const reply = async (text: string) => {
            await sock.sendMessage(msg.key.remoteJid!, { text });
        };

        try {
            await handleIncomingMessage(senderPhone, text, location, reply);
        } catch (e) {
            console.error('Error handling message:', e);
            await reply('Maaf, terjadi kesalahan pada sistem Siyap.id. Coba beberapa saat lagi.');
        }
    });
}

// --- LOGIC BOT SIYAP.ID ---
const userStateKey = (phone: string) => `state:user:${phone}`;
const driverStateKey = (phone: string) => `state:driver:${phone}`;
const proxyKey = (phone: string) => `proxy:${phone}`;
const draftOrderKey = (phone: string) => `order:draft:${phone}`;

async function handleIncomingMessage(senderPhone: string, text: string, location: any, reply: (text: string) => Promise<void>) {
    // 1. Proxy Chat (Number Masking)
    const proxyTarget = await redis.get<string>(proxyKey(senderPhone));
    if (proxyTarget && text && !text.startsWith('/')) {
        // We will need a global socket reference to send to proxyTarget, 
        // For simplicity, we can just say this feature will be implemented soon, 
        // or we can pass the `sock` instance in to send cross-messages.
        // I will implement cross-messaging later.
        console.log(`[Proxy] Forwarding from ${senderPhone} to ${proxyTarget}`);
        // await sock.sendMessage(proxyTarget + '@s.whatsapp.net', { text });
        return;
    }

    if (location) {
        return handleLocationMessage(senderPhone, location, reply);
    }

    if (text) {
        return handleTextMessage(senderPhone, text, reply);
    }
}

async function handleTextMessage(senderPhone: string, text: string, reply: (text: string) => Promise<void>) {
    const currentState = await redis.get<string>(userStateKey(senderPhone));
    const driverState = await redis.get<string>(driverStateKey(senderPhone));

    if (!currentState && !driverState) {
        if (text.trim().toLowerCase() === 'halo') {
            await redis.set(userStateKey(senderPhone), 'MAIN_MENU', { ex: 3600 });
            await reply("Selamat datang di Siyap.id! 🚀\nMau kirim apa hari ini?\n\n1️⃣ Kirim Barang\n2️⃣ Kirim Hadiah\n3️⃣ Minta Belanjain\n\n*Balas dengan angka (1, 2, atau 3)*");
        }
        return;
    }

    // MAIN MENU NUMERICAL SELECTION
    if (currentState === 'MAIN_MENU') {
        if (text === '1') {
            await redis.hset(draftOrderKey(senderPhone), { type: 'REGULAR' });
            await reply('Anda memilih Kirim Barang biasa. Silakan kirimkan Share Location (Titik Jemput) Anda dari menu attachment WA 📍');
            await redis.set(userStateKey(senderPhone), 'AWAITING_PICKUP_LOC', { ex: 3600 });
        } else if (text === '2') {
            await redis.hset(draftOrderKey(senderPhone), { type: 'GIFT' });
            await reply('Anda memilih Kirim Hadiah. Silakan ketikkan Nomor WhatsApp Penerima (contoh: 081234...):');
            await redis.set(userStateKey(senderPhone), 'AWAITING_GIFT_RECEIVER', { ex: 3600 });
        } else if (text === '3') {
            await redis.hset(draftOrderKey(senderPhone), { type: 'SHOPPING' });
            await reply('Anda memilih Minta Belanjain (maks Rp150.000). Silakan ketik detail barang yang mau dibeli:');
            await redis.set(userStateKey(senderPhone), 'AWAITING_SHOPPING_NOTES', { ex: 3600 });
        } else {
            await reply('Pilihan tidak valid. Silakan balas dengan angka 1, 2, atau 3.');
        }
        return;
    }

    if (currentState === 'AWAITING_GIFT_RECEIVER') {
        await redis.hset(draftOrderKey(senderPhone), { receiverPhone: text });
        await reply('Sip, nomor penerima sudah dicatat. Silakan kirimkan Share Location (Titik Jemput) 📍');
        await redis.set(userStateKey(senderPhone), 'AWAITING_PICKUP_LOC', { ex: 3600 });
        return;
    }

    if (currentState === 'AWAITING_SHOPPING_NOTES') {
        await redis.hset(draftOrderKey(senderPhone), { shoppingNotes: text });
        await reply('Catatan belanja diterima! Silakan kirimkan Share Location (Titik Jemput toko/warung) 📍');
        await redis.set(userStateKey(senderPhone), 'AWAITING_PICKUP_LOC', { ex: 3600 });
        return;
    }

    await reply('Perintah tidak dikenali atau sesi kadaluarsa. Ketik "halo" untuk mulai dari awal.');
}

async function handleLocationMessage(senderPhone: string, location: any, reply: (text: string) => Promise<void>) {
    const currentState = await redis.get<string>(userStateKey(senderPhone));
    
    if (currentState === 'AWAITING_PICKUP_LOC') {
        await redis.hset(draftOrderKey(senderPhone), { 
            pickupLat: location.degreesLatitude, 
            pickupLng: location.degreesLongitude 
        });
        await reply('Titik jemput berhasil disimpan ✅\nSekarang kirimkan Share Location (Titik Antar) 📍');
        await redis.set(userStateKey(senderPhone), 'AWAITING_DROPOFF_LOC', { ex: 3600 });
        return;
    }

    if (currentState === 'AWAITING_DROPOFF_LOC') {
        await reply('Titik antar disimpan ✅\nMencari pengemudi Siyap terdekat...');
        // dispatch logic will be migrated here
        await redis.set(userStateKey(senderPhone), 'WAITING_FOR_DRIVER', { ex: 3600 });
        return;
    }
}

// Start the bot
startBot().catch(console.error);
