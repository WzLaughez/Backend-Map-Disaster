import { promises as fs } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// Storage abstraction interface
export interface StorageAdapter {
  save(buffer: Buffer, filePath: string): Promise<string>
  getUrl(filePath: string): string
  delete(filePath: string): Promise<void>
  exists(filePath: string): Promise<boolean>
}

// Local filesystem storage implementation
export class LocalStorage implements StorageAdapter {
  private baseDir: string

  constructor(baseDir: string = './uploads/media') {
    this.baseDir = baseDir
    this.ensureDirectoryExists(baseDir)
  }

  private async ensureDirectoryExists(dirPath: string): Promise<void> {
    try {
      await fs.mkdir(dirPath, { recursive: true })
    } catch (error: any) {
      if (error.code !== 'EEXIST') {
        throw error
      }
    }
  }

  async save(buffer: Buffer, filePath: string): Promise<string> {
    const fullPath = path.join(this.baseDir, filePath)
    const dir = path.dirname(fullPath)
    
    // Ensure directory exists
    await this.ensureDirectoryExists(dir)
    
    // Write file
    await fs.writeFile(fullPath, buffer)
    
    return filePath
  }

  getUrl(filePath: string): string {
    // Return path that can be used with /api/media/ endpoint
    return `/api/media/${filePath}`
  }

  async delete(filePath: string): Promise<void> {
    const fullPath = path.join(this.baseDir, filePath)
    try {
      await fs.unlink(fullPath)
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        throw error
      }
    }
  }

  async exists(filePath: string): Promise<boolean> {
    const fullPath = path.join(this.baseDir, filePath)
    try {
      await fs.access(fullPath)
      return true
    } catch {
      return false
    }
  }

  getFullPath(filePath: string): string {
    return path.join(this.baseDir, filePath)
  }
}

// Initialize storage based on environment
const storageType = process.env.MEDIA_STORAGE_TYPE || 'local'
const uploadDir = process.env.MEDIA_UPLOAD_DIR || './uploads/media'

export const storage: StorageAdapter = new LocalStorage(uploadDir)

