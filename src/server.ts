import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { prisma } from './db'
import path from 'path'
import { storage } from './storage'

// Jalankan socket Baileys dan ambil API (import supaya start)
import { qrEvents, getLatestQR, forceRelogin } from './baileys'

const app = express()
app.use(cors())
app.use(express.json())

// GeoJSON untuk peta (simple lat/lon, no PostGIS needed)
app.get('/api/reports.geojson', async (_req, res) => {
  try {
    const reports = await prisma.report.findMany({
      where: { 
        status: { not: 'invalid' },
        lat: { not: 0 },
        lon: { not: 0 }
      },
      orderBy: { createdAt: 'desc' },
      take: 1000,
      select: {
        id: true,
        name: true,
        reporterWa: true,
        disasterType: true,
        description: true,
        address: true,
        kecamatan: true,
        desa: true,
        createdAt: true,
        lat: true,
        lon: true
      }
    })
    
    const features = reports.map(r => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [r.lon, r.lat] // GeoJSON: [longitude, latitude]
      },
      properties: {
        id: r.id,
        name: r.name,
        reporterWa: r.reporterWa,
        type: r.disasterType,
        desc: r.description,
        address: r.address,
        kecamatan: r.kecamatan,
        desa: r.desa,
        created_at: r.createdAt
      }
    }))
    
    res.json({ type: 'FeatureCollection', features })
  } catch (error) {
    console.error('Error fetching reports for GeoJSON:', error)
    res.status(500).json({ error: 'Failed to fetch reports' })
  }
})

// List tabel (paging)
app.get('/api/reports', async (req, res) => {
  try {
    const page = Math.max(parseInt(String(req.query.page||'1')),1)
    const size = Math.min(Math.max(parseInt(String(req.query.size||'50')),1),200)
    const skip = (page-1)*size

    const [items, total] = await Promise.all([
      prisma.report.findMany({
        where: { NOT: { status: 'invalid' } },
        orderBy: { createdAt: 'desc' },
        skip, take: size,
        select: { id:true, name:true, reporterWa:true, disasterType:true, address:true, description:true, createdAt:true, lat:true, lon:true, kecamatan:true, desa:true, mediaUrls:true }
      }),
      prisma.report.count({ where: { NOT: { status: 'invalid' } } })
    ])
    
    // Ensure mediaUrls is always an array (handle JSON parsing if needed)
    // MySQL JSON column might return as string, object, or already parsed array
    const normalizedItems = items.map(item => {
      let mediaUrls: string[] = []
      const rawMediaUrls = item.mediaUrls
      
      if (Array.isArray(rawMediaUrls)) {
        // Already an array - filter to ensure all are strings
        mediaUrls = rawMediaUrls.filter((url): url is string => typeof url === 'string')
      } else if (typeof rawMediaUrls === 'string') {
        // String - try to parse it
        try {
          const parsed = JSON.parse(rawMediaUrls)
          if (Array.isArray(parsed)) {
            mediaUrls = parsed.filter((url): url is string => typeof url === 'string')
          }
        } catch {
          // If parsing fails, treat as empty array
          mediaUrls = []
        }
      }
      // If null, undefined, or other types, default to empty array
      
      return {
        ...item,
        mediaUrls
      }
    })
    
    res.json({ items: normalizedItems, page, size, total })
  } catch (error) {
    console.error('Error fetching reports:', error)
    res.status(500).json({ error: 'Failed to fetch reports' })
  }
})

// Delete a report by ID
app.delete('/api/reports/:id', async (req, res) => {
  try {
    const { id } = req.params
    
    // Check if report exists
    const report = await prisma.report.findUnique({
      where: { id }
    })
    
    if (!report) {
      return res.status(404).json({ error: 'Report not found' })
    }
    
    // Delete the report
    await prisma.report.delete({
      where: { id }
    })
    
    res.json({ success: true, message: 'Report deleted successfully' })
  } catch (error) {
    console.error('Error deleting report:', error)
    res.status(500).json({ error: 'Failed to delete report' })
  }
})

// (opsional) healthcheck
app.get('/health', (_req, res) => res.json({ ok: true }))

// ====== WA QR: simple polling endpoint ======
app.get('/api/wa/qr', (_req, res) => {
  const qr = getLatestQR()
  res.json({ qr })
})

// ====== WA QR: Server-Sent Events (live stream) ======
app.get('/api/wa/qr/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  ;(res as any).flushHeaders?.()
  // initial comment to open stream across proxies
  res.write(': connected\n\n')

  const send = (qr: string) => {
    const data = JSON.stringify({ qr })
    res.write(`data: ${data}\n\n`)
  }

  // Send the latest QR immediately (if any)
  const current = getLatestQR()
  if (typeof current === 'string') send(current)

  // Subscribe to updates
  const onQr = (qr: string) => send(qr)
  qrEvents.on('qr', onQr)

  // heartbeat every 20s
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n')
  }, 20000)

  // Cleanup on client disconnect
  req.on('close', () => {
    qrEvents.off('qr', onQr)
    clearInterval(heartbeat)
    res.end()
  })
})

// Force relogin to generate a fresh QR
app.post('/api/wa/relogin', async (_req, res) => {
  try {
    await forceRelogin()
    res.json({ ok: true })
  } catch (e) {
    console.error('Failed to force relogin:', e)
    res.status(500).json({ ok: false })
  }
})// Serve media files - catch-all route for /api/media/**
app.get('/api/media/*filePath', async (req, res) => {
  try {
    // filePath bisa string atau string[]
    let filePath = (req.params as any).filePath as string | string[] | undefined

    console.log('Media request - Original URL:', req.url)
    console.log('Media request - req.path:', req.path)
    console.log('Media request - req.params.filePath:', filePath)

    // Normalisasi ke string
    if (!filePath) {
      console.error('Invalid filePath: undefined')
      return res.status(400).json({ error: 'File path required', received: filePath })
    }

    if (Array.isArray(filePath)) {
      filePath = filePath.join('/')
    }

    if (typeof filePath !== 'string' || filePath.length === 0) {
      console.error('Invalid filePath:', typeof filePath, filePath)
      return res.status(400).json({ error: 'File path required', received: filePath })
    }

    // Security: Prevent path traversal
    if (filePath.includes('..')) {
      return res.status(400).json({ error: 'Invalid file path - path traversal detected' })
    }

    // filePath seharusnya: "reports/{reportId}/image_....jpg"
    const cleanPath = filePath

    const fullPath = (storage as any).getFullPath(cleanPath)
    console.log('Media request - Full path:', fullPath)
    console.log('Media request - Resolved path:', path.resolve(fullPath))

    const fs = require('fs')
    if (!fs.existsSync(fullPath)) {
      console.error('Media file not found:', fullPath)
      console.error('Requested path:', cleanPath)
      return res.status(404).json({ error: 'File not found', path: cleanPath, fullPath })
    }

    // Optional: detect mime type dinamis kalau mau
    res.setHeader('Content-Type', 'image/jpeg')
    res.setHeader('Cache-Control', 'public, max-age=31536000')

    res.sendFile(path.resolve(fullPath), (err) => {
      if (err) {
        console.error('Error serving media file:', err)
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to serve file' })
        }
      }
    })
  } catch (error) {
    console.error('Error serving media:', error)
    res.status(500).json({ error: 'Failed to serve media file' })
  }
})

const PORT = Number(process.env.PORT || 3000)
app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`))
