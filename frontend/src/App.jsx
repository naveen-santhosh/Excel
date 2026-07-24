import { useState, useCallback } from 'react'
import { UploadCloud, FileType, CheckCircle, AlertCircle, Loader2, Download } from 'lucide-react'
import * as pdfjsLib from 'pdfjs-dist'
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
  const [eta, setEta] = useState('')

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
    setEta('')
    if (downloadUrl) {
      URL.revokeObjectURL(downloadUrl)
      setDownloadUrl('')
    }
  }

  const handleUpload = async () => {
    if (!file) return

    setStatus('processing')
    setProgressMsg('Loading PDF...')

    try {
      const arrayBuffer = await file.arrayBuffer()
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
      const products = []

      const startTime = Date.now()

      for (let i = 1; i <= pdf.numPages; i++) {
        // Skip first page if multiple pages
        if (i === 1 && pdf.numPages > 1) continue

        const pagesDone = i - (pdf.numPages > 1 ? 2 : 1)
        if (pagesDone > 0) {
          const elapsed = Date.now() - startTime
          const timePerPage = elapsed / pagesDone
          const pagesLeft = pdf.numPages - i + 1
          const etaSec = Math.round((timePerPage * pagesLeft) / 1000)
          const m = Math.floor(etaSec / 60)
          const s = etaSec % 60
          setEta(`~${m > 0 ? `${m}m ` : ''}${s}s remaining`)
        }

        setProgressMsg(`Analyzing page ${i} of ${pdf.numPages} with AI...`)
        setProgress(Math.round(((i - 1) / pdf.numPages) * 100))
        
        const page = await pdf.getPage(i)
        
        // Extract Image for AI Analysis
        const viewport = page.getViewport({ scale: 3.0 }) // High res for better quality
        const canvas = document.createElement('canvas')
        const context = canvas.getContext('2d')
        canvas.width = viewport.width
        canvas.height = viewport.height
        
        await page.render({ canvasContext: context, viewport }).promise

        // Send full page image to AI Backend
        const aiCanvas = document.createElement('canvas')
        const aiCtx = aiCanvas.getContext('2d')
        const MAX_AI_DIM = 800 // Compress to save bandwidth
        const aiScale = Math.min(MAX_AI_DIM / canvas.width, MAX_AI_DIM / canvas.height)
        aiCanvas.width = canvas.width * aiScale
        aiCanvas.height = canvas.height * aiScale
        aiCtx.fillStyle = '#FFFFFF'
        aiCtx.fillRect(0, 0, aiCanvas.width, aiCanvas.height)
        aiCtx.drawImage(canvas, 0, 0, aiCanvas.width, aiCanvas.height)
        
        const aiBase64 = aiCanvas.toDataURL('image/jpeg', 0.8)
        
        const isDev = import.meta.env.DEV
        const aiEndpoint = isDev ? 'http://127.0.0.1:8000/api/extract-info' : '/api/extract-info'
        
        const aiResponse = await fetch(aiEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image_base64: aiBase64 })
        })
        
        if (!aiResponse.ok) {
            console.warn(`AI extraction failed for page ${i}`)
            continue;
        }
        
        const aiData = await aiResponse.json()
        
        if (!aiData.is_product_page) {
            console.log(`Page ${i} is not a product page. Skipping.`)
            // Throttle slightly even for skips to avoid bursting
            await new Promise(r => setTimeout(r, 1000));
            continue; // Skip intro pages!
        }
        
        console.log(`Extracted from page ${i}:`, aiData)

        // Process Product Image
        setProgressMsg(`Removing background for product on page ${i}...`)
        
        // Crop left 70% to avoid edge text
        const imgCanvas = document.createElement('canvas')
        const imgCtx = imgCanvas.getContext('2d')
        imgCanvas.width = canvas.width * 0.70
        imgCanvas.height = canvas.height
        imgCtx.drawImage(canvas, 0, 0, imgCanvas.width, imgCanvas.height, 0, 0, imgCanvas.width, imgCanvas.height)

        // Downscale image proportionally before background removal
        // 800 is the sweet spot: high quality for Excel, but fast enough for local browser processing
        const MAX_DIM = 800
        const scale = Math.min(1, Math.min(MAX_DIM / imgCanvas.width, MAX_DIM / imgCanvas.height))
        const smallCanvas = document.createElement('canvas')
        const smallCtx = smallCanvas.getContext('2d')
        smallCanvas.width = imgCanvas.width * scale
        smallCanvas.height = imgCanvas.height * scale
        
        smallCtx.fillStyle = '#FFFFFF'
        smallCtx.fillRect(0, 0, smallCanvas.width, smallCanvas.height)
        smallCtx.drawImage(imgCanvas, 0, 0, smallCanvas.width, smallCanvas.height)
        
        const blob = await new Promise(resolve => smallCanvas.toBlob(resolve, 'image/jpeg', 1.0))
        
        const bgRemovedBlob = await removeBackground(blob, { model: "isnet_quint8" })
        const imageData = await new Promise(resolve => {
          const img = new Image()
          img.onload = () => {
            const finalCanvas = document.createElement('canvas')
            finalCanvas.width = img.width
            finalCanvas.height = img.height
            const ctx = finalCanvas.getContext('2d')
            ctx.fillStyle = '#FFFFFF'
            ctx.fillRect(0, 0, finalCanvas.width, finalCanvas.height)
            ctx.drawImage(img, 0, 0)
            resolve({
              base64: finalCanvas.toDataURL('image/jpeg', 1.0),
              width: finalCanvas.width,
              height: finalCanvas.height
            })
          }
          img.src = URL.createObjectURL(bgRemovedBlob)
        })

        products.push({
          color: aiData.color || "",
          style_code: aiData.style_code || "",
          mrp: aiData.mrp || "",
          material: aiData.material || "",
          sizes: aiData.sizes || "",
          image_base64: imageData.base64,
          width: imageData.width,
          height: imageData.height
        })
      }

      setProgressMsg('Generating Excel file on the server...')
      setProgress(100)
      setEta('')
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
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h4>{progressMsg}</h4>
                  <span style={{ fontWeight: 'bold', color: '#3b82f6' }}>{progress}%</span>
                </div>
                <div className="progress-bar-container" style={{ width: '100%', height: '8px', backgroundColor: '#e2e8f0', borderRadius: '4px', marginTop: '10px', overflow: 'hidden' }}>
                  <div className="progress-bar-fill" style={{ width: `${progress}%`, height: '100%', backgroundColor: '#3b82f6', transition: 'width 0.3s ease' }}></div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '8px', fontSize: '0.9em', color: '#64748b' }}>
                  <p>Running entirely on your computer...</p>
                  {eta && <p style={{ fontWeight: '500' }}>{eta}</p>}
                </div>
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
