import { makeWASocket, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import * as dotenv from 'dotenv';
import pino from 'pino';
import * as qrcode from 'qrcode-terminal';
import { Pool } from 'pg';
import { Redis } from '@upstash/redis';
import { usePostgresAuthState } from './usePostgresAuthState';
import * as http from 'http';

dotenv.config();

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Siyap.id WhatsApp Bot is alive!\n');
}).listen(PORT, () => {
    console.log(`Ping server listening on port ${PORT}`);
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const logger = pino({ level: 'silent' });

async function startBot() {
    const { state, saveCreds } = await usePostgresAuthState(pool);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: true,
        auth: state,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrcode.generate(qr, { small: true });
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error as any)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('✅ BOT BERHASIL TERHUBUNG KE WHATSAPP 24/7!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const senderPhone = msg.key.remoteJid!.replace('@s.whatsapp.net', '');
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

        const reply = async (text: string) => {
            await sock.sendMessage(msg.key.remoteJid!, { text });
        };

        if (text.trim().toLowerCase() === 'halo') {
            await reply("Selamat datang di Siyap.id! 🚀\nMau kirim apa hari ini?\n\n1️⃣ Kirim Barang\n2️⃣ Kirim Hadiah\n3️⃣ Minta Belanjain\n\n*Balas dengan angka (1, 2, atau 3)*");
        }
    });
}
startBot().catch(console.error);
