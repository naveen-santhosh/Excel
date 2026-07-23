import { useState, useCallback } from 'react'
import { UploadCloud, FileType, CheckCircle, AlertCircle, Loader2, Download } from 'lucide-react'
import * as pdfjsLib from 'pdfjs-dist'
import Tesseract from 'tesseract.js'
import { removeBackground } from '@imgly/background-removal'
import './App.css'

pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`

function App() {
  const [file, setFile] = useState(null)
  const [isDragging, setIsDragging] = useState(false)
  const [status, setStatus] = useState('idle') // idle, processing, success, error
  const [errorMsg, setErrorMsg] = useState('')
  const [downloadUrl, setDownloadUrl] = useState('')
  const [progressMsg, setProgressMsg] = useState('')
  const [progress, setProgress] = useState(0)

  const handleDragOver = useCallback((e) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e) => {
    e.preventDefault()
    setIsDragging(false)
  }, [])

  const handleDrop = useCallback((e) => {
    e.preventDefault()
    setIsDragging(false)
    const droppedFiles = e.dataTransfer.files
    if (droppedFiles.length > 0 && droppedFiles[0].type === 'application/pdf') {
      setFile(droppedFiles[0])
      resetState()
    } else {
      setErrorMsg('Please upload a valid PDF file.')
      setStatus('error')
    }
  }, [])

  const handleFileChange = (e) => {
    const selectedFile = e.target.files[0]
    if (selectedFile && selectedFile.type === 'application/pdf') {
      setFile(selectedFile)
      resetState()
    } else if (selectedFile) {
      setErrorMsg('Please upload a valid PDF file.')
      setStatus('error')
    }
  }

  const resetState = () => {
    setStatus('idle')
    setErrorMsg('')
    setProgressMsg('')
    setProgress(0)
    if (downloadUrl) {
      URL.revokeObjectURL(downloadUrl)
      setDownloadUrl('')
    }
  }

  const parseText = (text) => {
    let textNorm = text.replace(/\n/g, ' ').trim()
    textNorm = textNorm.replace(/Re[ec]bok/gi, '').trim()
    
    let details = { "color": "", "style_code": "", "mrp": "", "material": "", "sizes": "" }
    
    const keywords = {
      "color": [/color/i, /colour/i, /olor/i, /colar/i, /colur/i],
      "style_code": [/style\s*code/i, /style\s*no/i, /style/i, /tyle\s*code/i, /syk\s*code/i, /stlye/i, /sytle/i, /code/i],
      "mrp": [/\bmrp\b/i, /\brp\b/i, /price/i, /m\.r\.p/i],
      "material": [/material/i, /fabric/i, /aterial/i, /matenal/i, /hatenal/i, /uatenal/i, /atenal/i],
      "sizes": [/sizes/i, /size/i, /izes/i, /ize/i, /s1ze/i]
    }
    
    let foundFields = []
    
    for (const [field, patterns] of Object.entries(keywords)) {
      for (const pattern of patterns) {
        const match = pattern.exec(textNorm)
        if (match) {
          if (!foundFields.some(f => f.field === field)) {
            foundFields.push({ field, start: match.index, end: match.index + match[0].length })
          }
          break
        }
      }
    }
    
    foundFields.sort((a, b) => a.start - b.start)
    
    if (foundFields.length > 0 && foundFields[0].start > 0) {
      let preText = textNorm.substring(0, foundFields[0].start).trim()
      preText = preText.replace(/[\s:\-]+$/, '').trim()
      if (preText) {
        const logicalOrder = ["color", "style_code", "mrp", "material", "sizes"]
        for (const field of logicalOrder) {
          if (!foundFields.some(f => f.field === field)) {
            details[field] = preText
            break
          }
        }
      }
    }
    
    for (let i = 0; i < foundFields.length; i++) {
      const current = foundFields[i]
      const fieldName = current.field
      
      let startIdx = current.end
      while (startIdx < textNorm.length && [' ', ':', '-'].includes(textNorm[startIdx])) {
        startIdx++
      }
      
      let endIdx = (i + 1 < foundFields.length) ? foundFields[i+1].start : textNorm.length
      details[fieldName] = textNorm.substring(startIdx, endIdx).trim()
    }
    
    for (const key of Object.keys(details)) {
      details[key] = details[key].replace(/[\s:\-]+$/, '').trim()
    }
    
    if (details.mrp) {
      details.mrp = details.mrp.replace(/[\s/\-]+$/, '').trim()
    }
    if (details.sizes) {
      details.sizes = details.sizes.replace(/I/g, '/')
    }
    
    return details
  }

  const handleUpload = async () => {
    if (!file) return

    setStatus('processing')
    setProgressMsg('Loading PDF...')

    try {
      setProgressMsg('Initializing text recognition engine...')
      const worker = await Tesseract.createWorker('eng')
      
      const arrayBuffer = await file.arrayBuffer()
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
      const products = []

      for (let i = 1; i <= pdf.numPages; i++) {
        // Skip first page if multiple pages
        if (i === 1 && pdf.numPages > 1) continue

        setProgressMsg(`Processing page ${i} of ${pdf.numPages}...`)
        setProgress(Math.round(((i - 1) / pdf.numPages) * 100))
        
        const page = await pdf.getPage(i)
        const viewport = page.getViewport({ scale: 2.0 }) // High res
        
        // Render to canvas
        const canvas = document.createElement('canvas')
        const context = canvas.getContext('2d')
        canvas.width = viewport.width
        canvas.height = viewport.height
        
        await page.render({ canvasContext: context, viewport }).promise

        // Crop model image (left 50%)
        const imgCanvas = document.createElement('canvas')
        const imgCtx = imgCanvas.getContext('2d')
        imgCanvas.width = canvas.width * 0.5
        imgCanvas.height = canvas.height
        imgCtx.drawImage(canvas, 0, 0, imgCanvas.width, imgCanvas.height, 0, 0, imgCanvas.width, imgCanvas.height)

        // Crop text (bottom right)
        const textCanvas = document.createElement('canvas')
        const textCtx = textCanvas.getContext('2d')
        const tWidth = canvas.width * 0.65
        const tHeight = canvas.height * 0.45
        textCanvas.width = tWidth
        textCanvas.height = tHeight
        
        // Apply filter to improve OCR accuracy by maximizing contrast
        textCtx.filter = 'grayscale(100%) contrast(200%) brightness(110%)'
        textCtx.drawImage(canvas, canvas.width * 0.35, canvas.height * 0.55, tWidth, tHeight, 0, 0, tWidth, tHeight)
        textCtx.filter = 'none'

        setProgressMsg(`Extracting text from page ${i}...`)
        const { data: { text } } = await worker.recognize(textCanvas.toDataURL())
        const parsedData = parseText(text)

        setProgressMsg(`Removing background from page ${i}...`)
        
        // Downscale image proportionally before background removal to prevent browser OOM
        const MAX_DIM = 600
        const scale = Math.min(MAX_DIM / imgCanvas.width, MAX_DIM / imgCanvas.height)
        const smallCanvas = document.createElement('canvas')
        const smallCtx = smallCanvas.getContext('2d')
        smallCanvas.width = imgCanvas.width * scale
        smallCanvas.height = imgCanvas.height * scale
        smallCtx.drawImage(imgCanvas, 0, 0, smallCanvas.width, smallCanvas.height)
        
        const blob = await new Promise(resolve => smallCanvas.toBlob(resolve, 'image/png'))
        
        // Use lightweight quantized model in the browser
        const bgRemovedBlob = await removeBackground(blob, { model: "isnet_quint8" })
        
        const base64data = await new Promise(resolve => {
          const reader = new FileReader()
          reader.onloadend = () => resolve(reader.result)
          reader.readAsDataURL(bgRemovedBlob)
        })

        products.push({
          color: parsedData.color,
          style_code: parsedData.style_code,
          mrp: parsedData.mrp,
          material: parsedData.material,
          sizes: parsedData.sizes,
          image_base64: base64data
        })
      }
      
      await worker.terminate()

      setProgressMsg('Generating Excel file on the server...')
      setProgress(100)
      const isDev = import.meta.env.DEV
      const apiEndpoint = isDev ? 'http://127.0.0.1:8000/api/generate-excel' : '/api/generate-excel'
      
      const response = await fetch(apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ products })
      })

      if (!response.ok) {
        throw new Error('Failed to generate Excel file on the server.')
      }

      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      setDownloadUrl(url)
      setStatus('success')
    } catch (err) {
      console.error(err)
      setErrorMsg(err.message || 'An error occurred during local processing.')
      setStatus('error')
    }
  }

  return (
    <div className="app-container">
      <div className="background-shapes">
        <div className="shape shape-1"></div>
        <div className="shape shape-2"></div>
        <div className="shape shape-3"></div>
      </div>

      <main className="main-content">
        <header className="header">
          <h1>PDF to Excel <span>Generator</span></h1>
          <p>Extract products, remove backgrounds, and build your catalog instantly.</p>
        </header>

        <div className="upload-card">
          <div 
            className={`dropzone ${isDragging ? 'dragging' : ''} ${file ? 'has-file' : ''}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            {!file ? (
              <div className="dropzone-content">
                <div className="icon-container">
                  <UploadCloud size={48} />
                </div>
                <h3>Drag & Drop your PDF here</h3>
                <p>or</p>
                <label className="browse-btn">
                  Browse Files
                  <input type="file" accept="application/pdf" onChange={handleFileChange} hidden />
                </label>
              </div>
            ) : (
              <div className="file-info">
                <FileType size={40} className="file-icon" />
                <div className="file-details">
                  <h4>{file.name}</h4>
                  <p>{(file.size / (1024 * 1024)).toFixed(2)} MB</p>
                </div>
                {status === 'idle' && (
                  <button className="change-file-btn" onClick={() => setFile(null)}>
                    Change File
                  </button>
                )}
              </div>
            )}
          </div>

          {status === 'processing' && (
            <div className="status-box processing">
              <Loader2 className="spinner" size={24} />
              <div className="status-text" style={{ width: '100%' }}>
                <h4>{progressMsg}</h4>
                <div className="progress-bar-container" style={{ width: '100%', height: '8px', backgroundColor: '#e2e8f0', borderRadius: '4px', marginTop: '10px', overflow: 'hidden' }}>
                  <div className="progress-bar-fill" style={{ width: `${progress}%`, height: '100%', backgroundColor: '#3b82f6', transition: 'width 0.3s ease' }}></div>
                </div>
                <p style={{ marginTop: '8px' }}>This is happening entirely on your computer! No heavy server uploads needed.</p>
              </div>
            </div>
          )}

          {status === 'error' && (
            <div className="status-box error">
              <AlertCircle size={24} />
              <div className="status-text">
                <h4>Processing Failed</h4>
                <p>{errorMsg}</p>
              </div>
            </div>
          )}

          {status === 'success' && (
            <div className="status-box success">
              <CheckCircle size={24} />
              <div className="status-text">
                <h4>Processing Complete!</h4>
                <p>Your Excel catalog has been generated successfully.</p>
              </div>
            </div>
          )}

          <div className="actions">
            {status === 'idle' && file && (
              <button className="primary-btn" onClick={handleUpload}>
                Generate Excel Sheet
              </button>
            )}
            
            {status === 'success' && downloadUrl && (
              <a href={downloadUrl} download={`catalog_${file.name.replace('.pdf', '')}.xlsx`} className="download-btn">
                <Download size={20} />
                Download Excel File
              </a>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}

export default App
