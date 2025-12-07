import type { proto } from '@whiskeysockets/baileys'
import type { WASocket } from '@whiskeysockets/baileys'
import { downloadMediaMessage } from '@whiskeysockets/baileys'
import Pino from 'pino'
import { storage } from './storage'

// Allowed image MIME types
const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp'
]

// Max file size: 10MB
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

export interface MediaInfo {
  buffer: Buffer
  mimetype: string
  filename: string
}

/**
 * Check if message contains media (image)
 */
export function isImageMessage(message: proto.IMessage): boolean {
  return !!message.imageMessage
}

/**
 * Download image from WhatsApp message
 */
export async function downloadImageFromMessage(
  sock: WASocket,
  msg: proto.IWebMessageInfo  // 👈 sebelumnya: proto.IMessage
): Promise<MediaInfo | null> {
  const message = msg.message

  if (!message?.imageMessage) {
    return null
  }

  try {
    // Check if image message has URL - if not, might be expired
    const imageMsg = message.imageMessage
    if (!imageMsg?.url && !imageMsg?.directPath) {
      throw new Error('Media URL tidak tersedia. Media mungkin sudah expired. Silakan kirim ulang foto.')
    }

    // Download media menggunakan util Baileys
    // Cast IWebMessageInfo to WAMessage (they're compatible)
    let buffer: Buffer
    try {
      buffer = await downloadMediaMessage(
        msg as any,       // 👈 kirim WAMessage / IWebMessageInfo utuh
        'buffer',         // bisa 'buffer' atau 'stream'
        {},
        {
          logger: Pino({ level: 'silent' }), // Use Pino logger (can be silent for minimal logging)
          // penting: agar bisa reupload kalau link media sudah expired
          reuploadRequest: sock.updateMediaMessage
        }
      ) as Buffer
    } catch (downloadError: any) {
      // Handle specific Baileys errors
      const errorMsg = downloadError?.message || downloadError?.toString() || ''
      
      if (errorMsg.includes('url generation failed') || 
          errorMsg.includes('fetch failed') ||
          errorMsg.includes('404') ||
          downloadError?.code === 'FETCH_ERROR' ||
          downloadError?.code === 'ECONNREFUSED') {
        throw new Error('Media tidak dapat diunduh. URL mungkin sudah expired atau media terlalu lama. Silakan kirim ulang foto yang baru.')
      }
      
      // Re-throw other errors
      throw downloadError
    }
    
    if (!buffer || buffer.length === 0) {
      throw new Error('Media kosong atau tidak valid. Silakan kirim ulang foto.')
    }

    // Get mimetype dari imageMessage
    const mimetype = message.imageMessage?.mimetype || 'image/jpeg'
    
    // Validate type
    if (!ALLOWED_IMAGE_TYPES.includes(mimetype)) {
      throw new Error(`Unsupported image type: ${mimetype}`)
    }

    // Validate size
    if (buffer.length > MAX_FILE_SIZE) {
      throw new Error(
        `File too large: ${(buffer.length / 1024 / 1024).toFixed(2)}MB. ` +
        `Max: ${(MAX_FILE_SIZE / 1024 / 1024).toFixed(2)}MB`
      )
    }

    // Generate filename
    const extension = getExtensionFromMimetype(mimetype)
    const timestamp = Date.now()
    const filename = `image_${timestamp}${extension}`

    return {
      buffer,
      mimetype,
      filename
    }
  } catch (error: any) {
    console.error('Error downloading image:', error)
    throw error
  }
}

/**
 * Save image to storage
 */
export async function saveImage(
  buffer: Buffer,
  filename: string,
  reportId: string
): Promise<string> {
  // Organize by report ID: reports/{reportId}/filename
  const filePath = `reports/${reportId}/${filename}`
  
  await storage.save(buffer, filePath)
  
  return storage.getUrl(filePath)
}

/**
 * Get file extension from MIME type
 */
function getExtensionFromMimetype(mimetype: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp'
  }
  
  return map[mimetype] || '.jpg'
}

/**
 * Delete media files for a report
 */
export async function deleteReportMedia(reportId: string, mediaUrls: string[]): Promise<void> {
  for (const url of mediaUrls) {
    // Extract path from URL: /api/media/reports/{reportId}/filename
    const pathMatch = url.match(/\/api\/media\/(.+)$/)
    if (pathMatch && pathMatch[1]) {
      try {
        await storage.delete(pathMatch[1])
      } catch (error) {
        console.error(`Failed to delete media file ${pathMatch[1]}:`, error)
      }
    }
  }
}

