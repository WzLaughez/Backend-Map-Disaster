import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } from '@whiskeysockets/baileys'
import Pino from 'pino'
import { prisma } from './db'
import qrcode from 'qrcode-terminal'
import { EventEmitter } from 'events'
import { promises as fs } from 'fs'
import { formatKecamatanList, formatVillageList, getKecamatanByNumber, getVillageByNumber } from './locations'

// In-memory form storage (JID -> FormData)
interface ReportForm {
  reporterWa: string
  name?: string
  disasterType?: string
  description?: string
  severity?: string
  happenedAt?: Date
  address?: string
  lat?: number
  lon?: number
  kecamatan?: string
  desa?: string
  accuracy?: number
  isLive?: boolean
  liveExpiresAt?: Date | null
  waMessageId?: string
  waTimestamp?: Date
  nextStep: 'name' | 'type' | 'location' | 'kecamatan' | 'desa' | 'time' | 'desc' | 'severity' | 'confirm'
  updatedAt: number // ms, untuk TTL
}


const activeForms = new Map<string, ReportForm>()

function extractText(m:any): string {
  return m.message?.conversation
    || m.message?.extendedTextMessage?.text
    || m.message?.buttonsResponseMessage?.selectedDisplayText
    || m.message?.listResponseMessage?.singleSelectReply?.selectedRowId
    || ''
}

function normalizeType(s:string) {
  const t = (s||'').toLowerCase()
  if (t.includes('banjir')) return 'banjir'
  if (t.includes('kebakar')) return 'kebakaran'
  if (t.includes('longsor')) return 'longsor'
  if (t.includes('angin kencang')) return 'angin kencang'
  if (t.includes('gempa')) return 'gempa'
  return 'lainnya'
}

// Pilihan jenis bencana (untuk input nomor)
const DISASTER_TYPES = ['banjir','kebakaran','longsor','angin kencang','gempa','lainnya'] as const
type DisasterType = typeof DISASTER_TYPES[number]
function formatDisasterTypeList(): string {
  return DISASTER_TYPES.map((t, i) => `${i+1}. ${t}`).join('\n')
}
function normalizeTypeFromNumberOrText(input: string): DisasterType {
  const txt = (input || '').trim().toLowerCase()
  // numeric?
  const num = parseInt(txt, 10)
  if (!isNaN(num) && num >= 1 && num <= DISASTER_TYPES.length) {
    return DISASTER_TYPES[num - 1] as DisasterType
  }
  // fallback text normalization
  const n = normalizeType(txt)
  return (DISASTER_TYPES as readonly string[]).includes(n) ? (n as DisasterType) : 'lainnya' as DisasterType
}

// Global error handlers to prevent crashes
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason)
  // Don't exit - keep service running
})

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error)
  // Log but don't exit for critical errors
  // In production, you might want to exit and let a process manager restart
})

// ====== Waktu: parser sederhana untuk berbagai format umum ======
function parseIndonesianDate(textRaw: string): Date | null {
  const text = (textRaw || '').trim().toLowerCase()
  const now = new Date()
  if (!text) return null
  if (text === 'sekarang') return now
  if (text === 'hari ini') return now
  if (text.startsWith('kemarin')) {
    const base = new Date(now)
    base.setDate(base.getDate() - 1)
    // extract time if provided e.g. "kemarin 14:30" or "kemarin jam 14:30"
    const m = text.match(/(\d{1,2})[:.](\d{2})/)
    if (m) {
      const [, hhStr, mmStr] = m
      const hh = parseInt(hhStr || '0', 10)
      const mm = parseInt(mmStr || '0', 10)
      base.setHours(isFinite(hh) ? hh : 0, isFinite(mm) ? mm : 0, 0, 0)
    } else {
      base.setHours(12, 0, 0, 0) // tengah hari default
    }
    return base
  }
  // Only time -> assume today, "14:30" or "07.15"
  let m = text.match(/^(\d{1,2})[:.](\d{2})$/)
  if (m) {
    const [, hhStr, mmStr] = m
    const hh = parseInt(hhStr || '0', 10)
    const mm = parseInt(mmStr || '0', 10)
    if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
      const d = new Date(now)
      d.setHours(hh, mm, 0, 0)
      return d
    }
  }
  // Prefix "jam 14:30"
  m = text.match(/^jam\s+(\d{1,2})[:.](\d{2})$/)
  if (m) {
    const [, hhStr, mmStr] = m
    const hh = parseInt(hhStr || '0', 10)
    const mm = parseInt(mmStr || '0', 10)
    const d = new Date(now)
    d.setHours(hh, mm, 0, 0)
    return d
  }
  // DD/MM/YYYY [HH:mm]
  m = text.match(/^(\d{1,2})[\/](\d{1,2})[\/](\d{4})(?:\s+(\d{1,2})[:.](\d{2}))?$/)
  if (m) {
    const [, ddStr, mmStr, yyyyStr, hhStr, minStr] = m
    const dd = parseInt(ddStr || '1', 10)
    const MM = parseInt(mmStr || '1', 10)
    const yyyy = parseInt(yyyyStr || String(now.getFullYear()), 10)
    const hh = hhStr ? parseInt(hhStr, 10) : 12
    const mm2 = minStr ? parseInt(minStr, 10) : 0
    const d = new Date(yyyy, MM - 1, dd, hh, mm2, 0, 0)
    return isNaN(d.getTime()) ? null : d
  }
  // DD-MM-YYYY [HH:mm]
  m = text.match(/^(\d{1,2})-(\d{1,2})-(\d{4})(?:\s+(\d{1,2})[:.](\d{2}))?$/)
  if (m) {
    const [, ddStr, mmStr, yyyyStr, hhStr, minStr] = m
    const dd = parseInt(ddStr || '1', 10)
    const MM = parseInt(mmStr || '1', 10)
    const yyyy = parseInt(yyyyStr || String(now.getFullYear()), 10)
    const hh = hhStr ? parseInt(hhStr, 10) : 12
    const mm2 = minStr ? parseInt(minStr, 10) : 0
    const d = new Date(yyyy, MM - 1, dd, hh, mm2, 0, 0)
    return isNaN(d.getTime()) ? null : d
  }
  // YYYY-MM-DD [HH:mm]
  m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2})[:.](\d{2}))?$/)
  if (m) {
    const [, yyyyStr, mmStr, ddStr, hhStr, minStr] = m
    const yyyy = parseInt(yyyyStr || String(now.getFullYear()), 10)
    const MM = parseInt(mmStr || '1', 10)
    const dd = parseInt(ddStr || '1', 10)
    const hh = hhStr ? parseInt(hhStr, 10) : 12
    const mm2 = minStr ? parseInt(minStr, 10) : 0
    const d = new Date(yyyy, MM - 1, dd, hh, mm2, 0, 0)
    return isNaN(d.getTime()) ? null : d
  }
  // 12 Nov 2025 [14:30] (bulan Indonesia)
  const bulan: Record<string, number> = {
    'jan': 1, 'januari': 1,
    'feb': 2, 'februari': 2,
    'mar': 3, 'maret': 3,
    'apr': 4, 'april': 4,
    'mei': 5,
    'jun': 6, 'juni': 6,
    'jul': 7, 'juli': 7,
    'agu': 8, 'agustus': 8,
    'sep': 9, 'september': 9,
    'okt': 10, 'oktober': 10,
    'nov': 11, 'november': 11,
    'des': 12, 'desember': 12
  }
  m = text.match(/^(\d{1,2})\s+([a-zA-Z]+)\s+(\d{4})(?:\s+(\d{1,2})[:.](\d{2}))?$/)
  if (m) {
    const [, ddStr, monthStr, yyyyStr, hhStr, minStr] = m
    const dd = parseInt(ddStr || '1', 10)
    const monKey = (monthStr || '').toLowerCase()
    const MM = bulan[monKey]
    const yyyy = parseInt(yyyyStr || String(now.getFullYear()), 10)
    const hh = hhStr ? parseInt(hhStr, 10) : 12
    const mm2 = minStr ? parseInt(minStr, 10) : 0
    if (MM) {
      const d = new Date(yyyy, MM - 1, dd, hh, mm2, 0, 0)
      return isNaN(d.getTime()) ? null : d
    }
  }
  // Fallback native Date (last resort)
  const tryNative = new Date(textRaw)
  if (!isNaN(tryNative.getTime())) return tryNative
  return null
}

function timePromptText(): string {
  return 'Kapan kejadiannya? Balas:\n' +
    '• SEKARANG\n' +
    'atau tulis tanggal dan jam seperti: 12 Nov 2025 14:30\n' 
}

// ===== QR streaming support for frontend =====
export const qrEvents = new EventEmitter()
let latestQR: string | null = null
export function getLatestQR(): string | null {
  return latestQR
}
let currentSock: ReturnType<typeof makeWASocket> | null = null

function getAuthDir(): string {
  return process.env.BAILEYS_AUTH_DIR || './auth'
}

async function clearAuthDir() {
  const dir = getAuthDir()
  try {
    await fs.rm(dir, { recursive: true, force: true })
    console.log('Cleared Baileys auth dir:', dir)
  } catch (e) {
    console.error('Failed to clear Baileys auth dir:', e)
  }
}

export async function forceRelogin() {
  try {
    await currentSock?.logout?.()
  } catch (e) {
    console.error('Error during logout:', e)
  }
  latestQR = null
  qrEvents.emit('qr', '')
  start()
}

async function start() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(process.env.BAILEYS_AUTH_DIR || './auth')
    const { version } = await fetchLatestBaileysVersion()
  
    const sock = makeWASocket({
      version,
      auth: state,
      // printQRInTerminal deprecated; QR handled via connection.update
      logger: Pino({ level: 'info' })
    })
    currentSock = sock
  
    sock.ev.on('creds.update', saveCreds)
  
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update
  
      // ✅ Tampilkan QR manual saat tersedia
      if (qr) {
        console.log('Scan QR berikut di WhatsApp > Linked devices:')
        qrcode.generate(qr, { small: true })
        // Simpan & broadcast untuk frontend
        latestQR = qr
        qrEvents.emit('qr', qr)
      }
  
      if (connection === 'close') {
        const code = (lastDisconnect?.error as any)?.output?.statusCode
        if (code === DisconnectReason.loggedOut) {
          // Session revoked from phone – clear local creds and restart to get a fresh QR
          await clearAuthDir()
          start()
        } else {
          start() // auto-reconnect
        }
      } else if (connection === 'open') {
        console.log('✅ WhatsApp socket connected')
        // Hapus QR ketika sudah terhubung
        latestQR = null
        qrEvents.emit('qr', '')
      }
    })
  

  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const m = messages?.[0]; if (!m || m.key.fromMe) return
      const jid = m.key.remoteJid as string
      const txt = extractText(m)

      // Get active form or start new one
      let form = activeForms.get(jid)
      
      // Global reset: "ULANGI" to restart from beginning at any step
      if (/^ulangi$/i.test(txt)) {
        const fresh: ReportForm = {
          reporterWa: jid,
          nextStep: 'name',
          updatedAt: Date.now()
        }
        activeForms.set(jid, fresh)
        await sock.sendMessage(jid, { text: 'Baik, kita mulai ulang.\nSiapa nama Anda sebagai pelapor?' })
        return
      }
      
      if (!form && /^(lapor|bencana)$/i.test(txt)) {
        form = {
          reporterWa: jid,
          nextStep: 'name',
          updatedAt: Date.now()
        }
        activeForms.set(jid, form)
        await sock.sendMessage(jid, { text: 'Halo! Siapa nama Anda sebagai pelapor?' })
        return
      }
      
      if (!form) {
        await sock.sendMessage(jid, { text: 'Ketik "LAPOR" untuk memulai laporan bencana.' })
        return
      }

    switch (form.nextStep) {
      case 'name': {
        if (!txt || txt.trim().length === 0) {
          await sock.sendMessage(jid, { text: 'Tolong berikan nama Anda.' })
          break
        }
        form.name = txt.trim()
        form.nextStep = 'type'
        await sock.sendMessage(jid, { text: 'Jenis bencana?\n' + formatDisasterTypeList() + '\n\nKetik nomor (1-6) atau tulis jenis.' })
        break
      }

      case 'type': {
        form.disasterType = normalizeTypeFromNumberOrText(txt)
        form.nextStep = 'location'
        await sock.sendMessage(jid, { text:'Kirim *Lokasi* via Share Location (WA) atau ketik alamat lengkap.' })
        break
      }

      case 'location': {
        const msgId = m.key.id;
        const tsMs = Number(m.messageTimestamp) * 1000;
      
        // 1) Deteksi dua tipe: pin location & live location
        const pin = m.message?.locationMessage as any;           // pin biasa
        const live = (m.message as any)?.liveLocationMessage as any; // live location
      
        // Helper ambil lat/lon dgn validasi
        const pickCoords = (obj:any) => ({
          lat: typeof obj?.degreesLatitude === 'number' ? obj.degreesLatitude : null,
          lon: typeof obj?.degreesLongitude === 'number' ? obj.degreesLongitude : null
        });
      
        if (pin || live) {
          const src = pin || live;
          const { lat, lon } = pickCoords(src);
      
          if (lat == null || lon == null || !isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
            await sock.sendMessage(jid, { text: 'Lokasi tidak valid, coba kirim ulang via Share Location ya.' });
            break;
          }
      
          // 2) Normalisasi angka (opsional: 6–7 desimal cukup)
          const nlat = Number(lat.toFixed(7));
          const nlon = Number(lon.toFixed(7));
      
          // 3) Kumpulkan metadata (opsional)
          const meta = {
            address: src.name || src.address || '',
            url: src.url || '',
            accuracy: typeof src.accuracyInMeters === 'number' ? src.accuracyInMeters : null,
            isLive: Boolean(live),
            liveExpiresAt: live?.expiration ? new Date(Number(live.expiration)) : null,
            waMessageId: msgId,
            waTimestamp: new Date(tsMs)
          };
      
      
          // 5) Update in-memory state (kalau masih pakai 'form' di RAM)
          form.lat = nlat;
          form.lon = nlon;
          form.address = meta.address ?? '';
          form.nextStep = 'kecamatan';
      
          await sock.sendMessage(jid, { text: `Pilih Kecamatan:\n${formatKecamatanList()}\n\nKetik nomor (1-15) atau "LEWATI" untuk melewati.` });
          break;
        }
      
        // 6) Alamat teks → (opsional) geocode atau simpan dulu sebagai teks
        const txtAddress = extractText(m); // fungsi yang sudah kamu punya
        if (txtAddress) {
          // // (opsional) TODO: geocode(txt) -> (lat,lon,address) lalu simpan seperti di atas
          // await prisma.report.update({
          //   where: { id: form.id },
          //   data: { address: txt, nextStep: 'time' }
          // });
          form.address = txtAddress;
          form.nextStep = 'kecamatan';
          await sock.sendMessage(jid, { text: `Alamat dicatat. Untuk akurasi, sebaiknya Share Location.\n\nPilih Kecamatan:\n${formatKecamatanList()}\n\nKetik nomor (1-15) atau "LEWATI" untuk melewati.` });
        } else {
          await sock.sendMessage(jid, { text:'Butuh lokasi. Share Location atau ketik alamat.' });
        }
        break;
      }

      case 'kecamatan': {
        if (/^lewati$/i.test(txt)) {
          form.nextStep = 'time'
          await sock.sendMessage(jid, { text: timePromptText() })
          break
        }
        
        const num = parseInt(txt.trim())
        if (isNaN(num) || num < 1 || num > 15) {
          await sock.sendMessage(jid, { text: 'Nomor tidak valid. Ketik nomor 1-15 atau "LEWATI".' })
          break
        }
        
        const selectedKecamatan = getKecamatanByNumber(num)
        if (!selectedKecamatan) {
          await sock.sendMessage(jid, { text: 'Kecamatan tidak ditemukan. Coba lagi.' })
          break
        }
        
        form.kecamatan = selectedKecamatan.kecamatan
        form.nextStep = 'desa'
        
        const villageList = formatVillageList(selectedKecamatan.kecamatan)
        await sock.sendMessage(jid, { text: `Kecamatan: ${selectedKecamatan.kecamatan}\n\nPilih Desa/Kelurahan:\n${villageList}\n\nKetik nomor atau "LEWATI" untuk melewati.` })
        break
      }

      case 'desa': {
        if (/^lewati$/i.test(txt)) {
          form.nextStep = 'time'
          await sock.sendMessage(jid, { text: timePromptText() })
          break
        }
        
        if (!form.kecamatan) {
          form.nextStep = 'time'
          await sock.sendMessage(jid, { text: timePromptText() })
          break
        }
        
        const num = parseInt(txt.trim())
        if (isNaN(num)) {
          await sock.sendMessage(jid, { text: 'Nomor tidak valid. Ketik nomor atau "LEWATI".' })
          break
        }
        
        const selectedDesa = getVillageByNumber(form.kecamatan, num)
        if (!selectedDesa) {
          await sock.sendMessage(jid, { text: 'Desa/Kelurahan tidak ditemukan. Coba lagi atau ketik "LEWATI".' })
          break
        }
        
        form.desa = selectedDesa
        form.nextStep = 'time'
        await sock.sendMessage(jid, { text: `Desa/Kelurahan: ${selectedDesa}\n\nKapan kejadiannya? ${timePromptText()}` })
        break
      }

      case 'time': {
        const parsed = parseIndonesianDate(txt)
        if (!parsed) {
          await sock.sendMessage(jid, { text: 'Format waktu tidak dikenali. Contoh:\n' + timePromptText() })
          break
        }
        form.happenedAt = parsed
        form.nextStep = 'desc'
        await sock.sendMessage(jid, { text:'Deskripsi singkat (≤ 500 karakter):' })
        break
      }

      case 'desc':
        if (!txt) {
          await sock.sendMessage(jid, { text:'Tolong tulis deskripsi singkat.' })
          break
        }
        form.description = txt.slice(0, 500)
        form.nextStep = 'severity'
        await sock.sendMessage(jid, { text:'Keparahan? (Rendah/Sedang/Tinggi) atau balas "LEWATI"' })
        break

      case 'severity':
        if (!/^lewati$/i.test(txt) && txt) {
          form.severity = txt
        }
        form.nextStep = 'confirm'
        const locationInfo = form.address || (form.lat && form.lon ? `${form.lat},${form.lon}` : '-')
        const kecamatanInfo = form.kecamatan || '-'
        const desaInfo = form.desa || '-'
        await sock.sendMessage(jid, { text:
          `Cek ringkasan:\n• Nama: ${form.name || '-'}\n• Jenis: ${form.disasterType}\n• Alamat: ${locationInfo}\n• Kecamatan: ${kecamatanInfo}\n• Desa/Kelurahan: ${desaInfo}\n• Waktu: ${form.happenedAt || 'sekarang'}\n• Deskripsi: ${form.description}\n• Severity: ${form.severity || '-'}\n\nBalas KIRIM untuk kirim atau ULANGI untuk memulai ulang.`
        })
        break

      case 'confirm':
        if (/^kirim$/i.test(txt)) {
          // Create report in database only when confirmed (simple lat/lon, no PostGIS)
          try {
            const report = await prisma.report.create({
              data: {
                reporterWa: form.reporterWa,
                name: form.name || null,
                disasterType: form.disasterType || 'lainnya',
                description: form.description || null,
                severity: form.severity || null,
                happenedAt: form.happenedAt || new Date(),
                address: form.address || null,
                lat: form.lat || 0,
                lon: form.lon || 0,
                kecamatan: form.kecamatan || null,
                desa: form.desa || null,
                mediaUrls: [],
                status: 'new'
              }
            })
            
            await sock.sendMessage(jid, { text:`Terima kasih. ID: ${report.id}\nPeta: https://map.domain.id/report/${report.id}` })
            
            // Clean up form only after successful save
            activeForms.delete(jid)
          } catch (dbError: any) {
            console.error('Database error saving report:', dbError)
            
            // Check if it's a connection error vs validation error
            const isConnectionError = dbError.code === 'P1001' || dbError.code === 'ECONNREFUSED' || dbError.message?.includes('connect')
            
            if (isConnectionError) {
              // Database is down - keep form in memory and notify user
              await sock.sendMessage(jid, { 
                text: '⚠️ Server database sedang bermasalah. Data Anda masih tersimpan sementara. Silakan coba lagi dalam beberapa saat atau hubungi admin.\n\nForm Anda akan tetap tersimpan sampai bisa disimpan ke database.' 
              })
              // Don't delete form - keep it for retry
            } else {
              // Other database error (validation, constraint, etc.)
              await sock.sendMessage(jid, { 
                text: '⚠️ Terjadi kesalahan saat menyimpan laporan. Silakan coba lagi atau hubungi admin.\n\nForm Anda masih tersimpan, silakan coba kirim lagi.' 
              })
              // Keep form for retry
            }
          }
        } else if (/^ubah/i.test(txt)) {
          await sock.sendMessage(jid, { text:'Tulis bagian yang ingin diubah: JENIS/LOKASI/WAKTU/DESKRIPSI/SEVERITY' })
          // (Sederhana: tidak implement UBAH detail di MVP)
        } else {
          await sock.sendMessage(jid, { text:'Balas KIRIM untuk mengirim. Atau ULANGI untuk memulai ulang.' })
        }
        break
    }
    } catch (error) {
      // Log error but don't crash the service
      console.error('Error processing message:', error)
      
      // Try to notify user if we have their JID
      const jid = messages?.[0]?.key?.remoteJid as string | undefined
      if (jid) {
        try {
          await sock.sendMessage(jid, { 
            text: 'Maaf, terjadi kesalahan saat memproses pesan Anda. Silakan coba lagi atau hubungi admin.' 
          })
        } catch (sendError) {
          console.error('Failed to send error message to user:', sendError)
        }
      }
    }
  })
  } catch (error) {
    console.error('Error starting Baileys socket:', error)
    // Retry after 5 seconds
    setTimeout(() => {
      console.log('Retrying Baileys connection...')
      start()
    }, 5000)
  }
}
start()
