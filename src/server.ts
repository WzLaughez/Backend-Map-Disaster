import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { prisma } from './db'
import path from 'path'

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
        disasterType: true,
        description: true,
        address: true,
        kecamatan: true,
        desa: true,
        severity: true,
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
        type: r.disasterType,
        desc: r.description,
        address: r.address,
        kecamatan: r.kecamatan,
        desa: r.desa,
        severity: r.severity,
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
        select: { id:true, disasterType:true, address:true, description:true, severity:true, happenedAt:true, createdAt:true, lat:true, lon:true, kecamatan:true, desa:true }
      }),
      prisma.report.count({ where: { NOT: { status: 'invalid' } } })
    ])
    res.json({ items, page, size, total })
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
})

const PORT = Number(process.env.PORT || 3000)
app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`))
