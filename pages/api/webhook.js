// pages/api/webhook.js

import { createClient } from '@supabase/supabase-js';
import { Telegraf, Markup } from 'telegraf';

// --- INISIALISASI DARI ENVIRONMENT VARIABLES ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; 
const BOT_TOKEN = process.env.BOT_TOKEN;
const STORAGE_BUCKET = 'eviden-bot'; // Ganti dengan nama bucket Anda

if (!SUPABASE_URL || !SUPABASE_KEY || !BOT_TOKEN) {
  throw new Error('Environment variables SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and BOT_TOKEN must be set.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const bot = new Telegraf(BOT_TOKEN);

// --- HANDLER UTAMA VERCEL ---
export default async (req, res) => {
  if (req.method === 'POST') {
    // Memproses webhook dari Telegram
    await bot.handleUpdate(req.body);
    res.status(200).send('OK');
  } else {
    // Endpoint selain POST (hanya untuk pengujian)
    res.status(200).json({ status: 'Bot running, waiting for webhook...' });
  }
};
// pages/api/webhook.js (lanjutan)

// ------------------------------------
// FUNGSI UTILITY SESI SUPABASE
// ------------------------------------

// Mengambil sesi berdasarkan user_id
async function getSession(userId) {
  const { data, error } = await supabase
    .from('bot_sessions')
    .select('*')
    .eq('user_id', userId)
    .single();
  
  // Jika sesi tidak ditemukan atau error (selain 'not found'), kembalikan sesi default
  if (error && error.code !== 'PGRST116') { // PGRST116 = tidak ditemukan (not found)
    console.error('Error fetching session:', error);
    return { user_id: userId, state: 'start', data: {} };
  }
  
  return data || { user_id: userId, state: 'start', data: {} };
}

// Menyimpan atau mengupdate sesi
async function saveSession(session) {
  const { error } = await supabase
    .from('bot_sessions')
    .upsert({ 
      user_id: session.user_id, 
      state: session.state, 
      data: session.data 
    }, { onConflict: 'user_id' }); // Gunakan upsert untuk insert/update
  
  if (error) {
    console.error('Error saving session:', error);
  }
}
// pages/api/webhook.js (lanjutan)

bot.command('lapor', async (ctx) => {
  const userId = ctx.from.id;
  const session = await getSession(userId);

  // Ambil data Segmentasi dari Supabase
  const { data: segmentasi, error } = await supabase
    .from('segmentasi_jalur')
    .select('id, nama_segmen');

  if (error || !segmentasi.length) {
    return ctx.reply('⚠️ Error: Data segmentasi tidak ditemukan atau terjadi kesalahan database.');
  }

  // Buat tombol inline
  const buttons = segmentasi.map(s => [
    Markup.button.callback(s.nama_segmen, `SEGMENTASI_${s.id}`)
  ]);
  
  // Update Sesi
  session.state = 'waiting_segmentasi';
  session.data = {}; // Kosongkan data laporan lama
  await saveSession(session);

  ctx.reply('➡️ **TAHAP 1: Pilih Segmentasi Jalur**', {
    ...Markup.inlineKeyboard(buttons),
    parse_mode: 'Markdown'
  });
});
// pages/api/webhook.js (lanjutan)

bot.on('callback_query', async (ctx) => {
  const userId = ctx.from.id;
  const session = await getSession(userId);
  const data = ctx.callbackQuery.data;

  // Hentikan proses jika bukan dari bot ini
  if (!data || !data.startsWith('SEGMENTASI_') && !data.startsWith('DESIGNATOR_')) {
    return ctx.answerCbQuery();
  }

  // --- LOGIKA SETELAH PILIH SEGMENTASI ---
  if (data.startsWith('SEGMENTASI_') && session.state === 'waiting_segmentasi') {
    const segmentasiId = parseInt(data.replace('SEGMENTASI_', ''), 10);
    const segmenData = (await supabase.from('segmentasi_jalur').select('nama_segmen').eq('id', segmentasiId).single()).data;

    // Ambil Designator (Designator adalah TEXT/Kode, bukan INT)
    const { data: designator, error } = await supabase
      .from('designator')
      .select('id, kode_designator, uraian_pekerjaan');

    if (error || !designator.length) {
      ctx.editMessageText('⚠️ Error: Data designator tidak ditemukan.');
      return;
    }

    // Buat tombol inline untuk Designator
    const designatorButtons = designator.map(d => [
      Markup.button.callback(d.kode_designator, `DESIGNATOR_${d.id}`)
    ]);

    // Update Sesi: Simpan Segmentasi ID
    session.data.segmentasi_id = segmentasiId;
    session.data.segmentasi_nama = segmenData.nama_segmen;
    session.state = 'waiting_designator';
    await saveSession(session);
    
    ctx.editMessageText(
        `✅ Segmentasi: **${segmenData.nama_segmen}**\n\n➡️ **TAHAP 2: Pilih Designator (Jenis Eviden)**`, {
        ...Markup.inlineKeyboard(designatorButtons),
        parse_mode: 'Markdown'
    });
  } 
  
  // --- LOGIKA SETELAH PILIH DESIGNATOR (Menuju Foto) ---
  else if (data.startsWith('DESIGNATOR_') && session.state === 'waiting_designator') {
    const designatorId = data.replace('DESIGNATOR_', ''); // ID Designator adalah TEXT (Kode)
    
    // Update Sesi: Simpan Designator ID
    session.data.designator_id = designatorId;
    session.state = 'waiting_photo';
    await saveSession(session);

    ctx.editMessageText(
        `✅ Designator: **${designatorId}**\n\n➡️ **TAHAP 3: Kirim Foto Eviden.**`, {
        parse_mode: 'Markdown'
    });
  }

  ctx.answerCbQuery();
});
// pages/api/webhook.js (lanjutan)

// ------------------------------------
// UTILITY: UPLOAD FILE KE SUPABASE STORAGE
// ------------------------------------

async function uploadFileToSupabase(ctx, session) {
  const fileId = ctx.message.photo.pop().file_id; // Ambil resolusi foto tertinggi
  
  // 1. Dapatkan URL File Telegram
  const fileLink = await ctx.telegram.getFileLink(fileId);
  const fileUrl = fileLink.href;

  // 2. Tentukan Path File Terstruktur
  const segmenNama = session.data.segmentasi_nama; // Cth: 'JT.01 - JT.02'
  const designatorKode = session.data.designator_id; // Cth: 'DC-OF-SM-48D'
  const fileName = `${Date.now()}_${ctx.from.id}.jpg`;
  
  // Format Path: EVIDENCE_FOLDER/JT.01 - JT.02/DC-OF-SM-48D/timestamp_userid.jpg
  const storagePath = `EVIDENCE_FOLDER/${segmenNama}/${designatorKode}/${fileName}`;

  // 3. Unduh File dari Telegram
  const fetch = await import('node-fetch').then(mod => mod.default);
  const response = await fetch(fileUrl);
  if (!response.ok) throw new Error(`Failed to fetch photo from Telegram: ${response.statusText}`);
  
  const fileBuffer = await response.arrayBuffer(); // Dapatkan data biner (buffer)

  // 4. Unggah ke Supabase Storage
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, Buffer.from(fileBuffer), {
      contentType: 'image/jpeg',
      upsert: false
    });

  if (error) {
    throw new Error('Supabase Storage Error: ' + error.message);
  }

  // 5. Kembalikan URL Publik (jika bucket public) atau Path Storage
  const { data: publicUrlData } = supabase.storage
      .from(STORAGE_BUCKET)
      .getPublicUrl(storagePath);

  return publicUrlData.publicUrl; 
}
// pages/api/webhook.js (lanjutan)

bot.on('photo', async (ctx) => {
  const userId = ctx.from.id;
  const session = await getSession(userId);

  if (session.state !== 'waiting_photo') {
    return ctx.reply('Silakan ketik /lapor untuk memulai laporan baru.');
  }
  
  try {
    ctx.reply('Memproses foto, mohon tunggu...');
    
    // 1. Unggah dan Dapatkan URL
    const fotoUrl = await uploadFileToSupabase(ctx, session);
    
    // 2. Simpan URL dan Lanjut ke Tahap Keterangan
    session.data.foto_url = fotoUrl;
    session.state = 'waiting_keterangan';
    await saveSession(session);

    ctx.reply(
      '✅ Foto Eviden tersimpan.\n\n➡️ **TAHAP 4: Ketik Keterangan/Deskripsi** laporan Anda.'
    );

  } catch (error) {
    console.error('Photo processing error:', error);
    ctx.reply('❌ Terjadi kesalahan saat mengunggah foto. Silakan coba lagi.');
  }
});
// pages/api/webhook.js (lanjutan)

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const session = await getSession(userId);

  if (session.state === 'waiting_keterangan') {
    const keteranganText = ctx.message.text;
    
    // Simpan Keterangan
    session.data.keterangan = keteranganText;
    session.state = 'waiting_location';
    await saveSession(session);

    ctx.reply(
      '✅ Keterangan tersimpan.\n\n➡️ **TAHAP 5: Kirim Lokasi** (Gunakan fitur "Share Location" di Telegram).'
    );
  }
  // Tidak ada else if lain agar pengguna tetap bisa chat biasa saat tidak dalam sesi
});
// pages/api/webhook.js (lanjutan)

bot.on('location', async (ctx) => {
  const userId = ctx.from.id;
  const session = await getSession(userId);

  if (session.state !== 'waiting_location') {
    return ctx.reply('Silakan ketik /lapor untuk memulai laporan baru.');
  }
  
  const location = ctx.message.location;

  // 1. Ambil semua data dari sesi
  const finalData = session.data;
  
  // 2. INSERT ke tabel rekap_data
  const { error } = await supabase
    .from('rekap_data')
    .insert([{
      telegram_user_id: userId,
      segmentasi_id: finalData.segmentasi_id,
      designator_id: finalData.designator_id,
      keterangan: finalData.keterangan,
      lokasi_latitude: location.latitude,
      lokasi_longitude: location.longitude,
      foto_url: finalData.foto_url
    }]);

  if (error) {
    console.error('Final INSERT error:', error);
    return ctx.reply('❌ Laporan GAGAL disimpan ke database. Mohon coba lagi.');
  }

  // 3. Bersihkan Sesi
  session.state = 'start';
  session.data = {};
  await saveSession(session);

  // 4. Konfirmasi
  ctx.reply(
    '🎉 **Laporan Berhasil Disimpan!**\n\n' +
    'Data evidensi dan lokasi Anda telah direkap dan file tersimpan dengan rapi di Supabase Storage.' +
    '\n\nKetik /lapor untuk membuat laporan baru.'
  );
});
