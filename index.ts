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
const userStateKey = (phone: string) => `state:user:${phone}`;
const draftOrderKey = (phone: string) => `order:draft:${phone}`;

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
        const location = msg.message.locationMessage;

        const reply = async (textMsg: string) => {
            await sock.sendMessage(msg.key.remoteJid!, { text: textMsg });
        };

        const currentState = await redis.get<string>(userStateKey(senderPhone));

        // Jika menerima Location (Sharelock)
        if (location) {
            if (currentState === 'AWAITING_PICKUP_LOC') {
                await redis.hset(draftOrderKey(senderPhone), { 
                    pickupLat: location.degreesLatitude, 
                    pickupLng: location.degreesLongitude 
                });
                await reply('Titik jemput berhasil disimpan ✅\n\nSekarang kirimkan Share Location (Titik Antar) 📍');
                await redis.set(userStateKey(senderPhone), 'AWAITING_DROPOFF_LOC', { ex: 3600 });
            } else if (currentState === 'AWAITING_DROPOFF_LOC') {
                await reply('Titik antar disimpan ✅\nMencari pengemudi Siyap terdekat... 🛵');
                
                const draft = await redis.hgetall(draftOrderKey(senderPhone));
                if (draft) {
                    try {
                        // Menyimpan pesanan resmi ke Supabase
                        const res = await pool.query(`
                            INSERT INTO orders (status, order_type, pickup_geom, dropoff_geom, shipping_fee, app_commission)
                            VALUES ('SEARCHING_DRIVER', $1, ST_SetSRID(ST_MakePoint($2, $3), 4326), ST_SetSRID(ST_MakePoint($4, $5), 4326), 15000, 3000)
                            RETURNING id
                        `, [draft.type, draft.pickupLng, draft.pickupLat, location.degreesLongitude, location.degreesLatitude]);
                        
                        await reply(`Pesanan Anda berhasil masuk ke Database dengan ID: ${res.rows[0].id}\nKami akan memberi tahu Anda jika driver sudah ditemukan.`);
                    } catch (e) {
                        console.error(e);
                        await reply('Ups, ada gangguan koneksi ke Supabase, tapi alur aplikasi berjalan lancar!');
                    }
                }
                await redis.del(userStateKey(senderPhone));
            } else {
                await reply('Lokasi diterima! Namun Anda belum berada dalam sesi pemesanan. Ketik "halo" untuk mulai.');
            }
            return;
        }

        // Jika menerima Teks Biasa
        if (text) {
            const lowerText = text.trim().toLowerCase();
            
            if (lowerText === 'halo') {
                await redis.set(userStateKey(senderPhone), 'MAIN_MENU', { ex: 3600 });
                await reply("Selamat datang di Siyap.id! 🚀\nMau kirim apa hari ini?\n\n1️⃣ Kirim Barang\n2️⃣ Kirim Hadiah\n3️⃣ Minta Belanjain\n\n*Balas dengan angka (1, 2, atau 3)*");
                return;
            }

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
                    await reply('Anda memilih Minta Belanjain. Silakan ketik detail barang yang mau dibeli:');
                    await redis.set(userStateKey(senderPhone), 'AWAITING_SHOPPING_NOTES', { ex: 3600 });
                } else {
                    await reply('Pilihan tidak valid. Balas dengan angka 1, 2, atau 3.');
                }
                return;
            }

            if (currentState === 'AWAITING_GIFT_RECEIVER') {
                await redis.hset(draftOrderKey(senderPhone), { receiverPhone: text });
                await reply('Nomor penerima dicatat. Silakan kirimkan Share Location (Titik Jemput) 📍');
                await redis.set(userStateKey(senderPhone), 'AWAITING_PICKUP_LOC', { ex: 3600 });
                return;
            }

            if (currentState === 'AWAITING_SHOPPING_NOTES') {
                await redis.hset(draftOrderKey(senderPhone), { shoppingNotes: text });
                await reply('Catatan belanja diterima! Silakan kirimkan Share Location (Titik Jemput toko) 📍');
                await redis.set(userStateKey(senderPhone), 'AWAITING_PICKUP_LOC', { ex: 3600 });
                return;
            }
        }
    });
}
startBot().catch(console.error);
