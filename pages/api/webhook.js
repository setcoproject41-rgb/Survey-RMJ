import { createClient } from '@supabase/supabase-js';
import { Telegraf, Markup } from 'telegraf';
import fetch from 'node-fetch'; // Pastikan 'node-fetch' sudah terinstal di package.json

// --- 1. INISIALISASI DARI ENVIRONMENT VARIABLES ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; 
const BOT_TOKEN = process.env.BOT_TOKEN;
const STORAGE_BUCKET = 'eviden-bot'; // Ganti dengan nama bucket Anda

// Cek Kunci (akan throw error jika environment variable hilang)
if (!SUPABASE_URL || !SUPABASE_KEY || !BOT_TOKEN) {
  throw new Error('Environment variables SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and BOT_TOKEN must be set.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const bot = new Telegraf(BOT_TOKEN);

// --- 2. FUNGSI UTILITY SESI SUPABASE ---

// Mengambil sesi berdasarkan user_id
async function getSession(userId) {
  const { data, error } = await supabase
    .from('bot_sessions')
    .select('*')
    .eq('user_id', userId)
    .single();
  
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
    }, { onConflict: 'user_id' }); 
  
  if (error) {
    console.error('Error saving session:', error);
  }
}

// --- 3. UTILITY: UPLOAD FILE KE SUPABASE STORAGE ---

async function uploadFileToSupabase(ctx, session) {
  const fileId = ctx.message.photo.pop().file_id; 
  
  // 1. Dapatkan URL File Telegram
  const fileLink = await ctx.telegram.getFileLink(fileId);
  const fileUrl = fileLink.href;

  // 2. Tentukan Path File Terstruktur
  const segmenNama = session.data.segmentasi_nama;
  const designatorKode = session.data.designator_id; 
  const fileName = `${Date.now()}_${ctx.from.id}.jpg`;
  
  // Path: BUCKET/EVIDENCE_FOLDER/JT.01 - JT.02/DC-OF-SM-48D/timestamp_userid.jpg
  const storagePath = `EVIDENCE_FOLDER/${segmenNama}/${designatorKode}/${fileName}`;

  // 3. Unduh File dari Telegram
  const response = await fetch(fileUrl);
  if (!response.ok) throw new Error(`Failed to fetch photo from Telegram: ${response.statusText}`);
  
  const fileBuffer = await response.arrayBuffer(); 

  // 4. Unggah ke Supabase Storage
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, Buffer.from(fileBuffer), {
      contentType: 'image/jpeg',
      upsert: false
    });

  if (error) {
    throw new Error('Supabase Storage Error: ' + error.message);
  }

  // 5. Kembalikan URL Publik
  const { data: publicUrlData } = supabase.storage
      .from(STORAGE_BUCKET)
      .getPublicUrl(storagePath);

  return publicUrlData.publicUrl; 
}


// --- 4. LOGIKA BOT (HANDLER/LISTENER) ---
// HARUS DI ATAS export default AGAR LISTENER DIDAFTARKAN!

// Perintah /lapor (TAHAP 1: Pilih Segmentasi)
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

// Callback Query (TAHAP 2: Pilih Designator & Lanjut ke Foto)
bot.on('callback_query', async (ctx) => {
  const userId = ctx.from.id;
  const session = await getSession(userId);
  const data = ctx.callbackQuery.data;

  // Hentikan proses jika bukan dari bot ini
  if (!data || (!data.startsWith('SEGMENTASI_') && !data.startsWith('DESIGNATOR_'))) {
    return ctx.answerCbQuery();
  }

  // --- LOGIKA SETELAH PILIH SEGMENTASI ---
  if (data.startsWith('SEGMENTASI_') && session.state === 'waiting_segmentasi') {
    const segmentasiId = parseInt(data.replace('SEGMENTASI_', ''), 10);
    const segmenData = (await supabase.from('segmentasi_jalur').select('nama_segmen').eq('id', segmentasiId).single()).data;

    // Ambil Designator
    const { data: designator, error } = await supabase
      .from('designator')
      .select('id, kode_designator, uraian_pekerjaan'); // Sesuaikan dengan skema Anda

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

// Menangani Foto (TAHAP 3: Upload ke Supabase & Lanjut Keterangan)
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

// Menangani Teks (TAHAP 4: Simpan Keterangan & Lanjut Lokasi)
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
});

// Menangani Lokasi (TAHAP 5: Finalisasi & INSERT ke rekap_data)
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


// --- 5. HANDLER UTAMA VERCEL ---
export default async (req, res) => {
  if (req.method === 'POST') {
    // Memproses webhook dari Telegram setelah semua listeners didefinisikan
    await bot.handleUpdate(req.body);
    res.status(200).send('OK');
  } else {
    // Endpoint selain POST (untuk pengujian)
    res.status(200).json({ status: 'Bot running, waiting for webhook...' });
  }
};
