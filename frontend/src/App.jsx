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

        // Crop left 60% to avoid edge text and side badges
        const imgCanvas = document.createElement('canvas')
        const imgCtx = imgCanvas.getContext('2d')
        imgCanvas.width = canvas.width * 0.60
        imgCanvas.height = canvas.height
        imgCtx.drawImage(canvas, 0, 0, imgCanvas.width, imgCanvas.height, 0, 0, imgCanvas.width, imgCanvas.height)

        // Send full page image to AI Backend (compressed)
        const aiCanvas = document.createElement('canvas')
        const aiCtx = aiCanvas.getContext('2d')
        const MAX_AI_DIM = 800
        const aiScale = Math.min(MAX_AI_DIM / canvas.width, MAX_AI_DIM / canvas.height)
        aiCanvas.width = canvas.width * aiScale
        aiCanvas.height = canvas.height * aiScale
        aiCtx.fillStyle = '#FFFFFF'
        aiCtx.fillRect(0, 0, aiCanvas.width, aiCanvas.height)
        aiCtx.drawImage(canvas, 0, 0, aiCanvas.width, aiCanvas.height)
        
        const aiBase64 = aiCanvas.toDataURL('image/jpeg', 0.8)
        
        if (!window.batchImages) window.batchImages = []
        if (!window.batchContexts) window.batchContexts = []
        
        window.batchImages.push(aiBase64)
        window.batchContexts.push({ pageNum: i, imgCanvas: imgCanvas })
        
        const BATCH_SIZE = 15
        
        if (window.batchImages.length === BATCH_SIZE || i === pdf.numPages) {
            setProgressMsg(`Analyzing batch of ${window.batchImages.length} pages with AI...`)
            const isDev = import.meta.env.DEV
            const aiEndpoint = isDev ? 'http://127.0.0.1:8000/api/extract-info-batch' : '/api/extract-info-batch'
            
            const aiResponse = await fetch(aiEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ images_base64: window.batchImages })
            })
            
            let batchResults = []
            if (aiResponse.ok) {
                const data = await aiResponse.json()
                batchResults = data.results || []
            }
            
            for (let j = 0; j < window.batchContexts.length; j++) {
                const bCtx = window.batchContexts[j]
                const aiData = batchResults[j] || { is_product_page: false }
                
                if (!aiData.is_product_page) {
                    console.log(`Page ${bCtx.pageNum} is not a product page. Skipping.`)
                    continue;
                }
                
                setProgressMsg(`Removing background for product on page ${bCtx.pageNum}...`)
                const imgCanvas = bCtx.imgCanvas

                // Downscale image for HIGH RES final output (800)
                const HIGH_RES_DIM = 800
                const hrScale = Math.min(1, Math.min(HIGH_RES_DIM / imgCanvas.width, HIGH_RES_DIM / imgCanvas.height))
                const hrCanvas = document.createElement('canvas')
                const hrCtx = hrCanvas.getContext('2d')
                hrCanvas.width = imgCanvas.width * hrScale
                hrCanvas.height = imgCanvas.height * hrScale
                hrCtx.fillStyle = '#FFFFFF'
                hrCtx.fillRect(0, 0, hrCanvas.width, hrCanvas.height)
                hrCtx.drawImage(imgCanvas, 0, 0, hrCanvas.width, hrCanvas.height)

                // Downscale image drastically for FAST background removal (256)
                const FAST_DIM = 256
                const lrScale = Math.min(1, Math.min(FAST_DIM / imgCanvas.width, FAST_DIM / imgCanvas.height))
                const lrCanvas = document.createElement('canvas')
                const lrCtx = lrCanvas.getContext('2d')
                lrCanvas.width = imgCanvas.width * lrScale
                lrCanvas.height = imgCanvas.height * lrScale
                lrCtx.fillStyle = '#FFFFFF'
                lrCtx.fillRect(0, 0, lrCanvas.width, lrCanvas.height)
                lrCtx.drawImage(imgCanvas, 0, 0, lrCanvas.width, lrCanvas.height)
                
                const blob = await new Promise(resolve => lrCanvas.toBlob(resolve, 'image/jpeg', 0.8))
                const bgRemovedBlob = await removeBackground(blob, { model: "isnet_quint8" })
                const finalUrl = URL.createObjectURL(bgRemovedBlob)
                
                const imageData = await new Promise(resolve => {
                  const img = new Image()
                  img.onload = () => {
                    const finalCanvas = document.createElement('canvas')
                    const finalCtx = finalCanvas.getContext('2d')
                    finalCanvas.width = hrCanvas.width
                    finalCanvas.height = hrCanvas.height
                    
                    // Computer Vision: Clean the mask using Connected Components (BFS)
                    const BFS_DIM = 200
                    const maskCanvas = document.createElement('canvas')
                    const maskCtx = maskCanvas.getContext('2d')
                    maskCanvas.width = BFS_DIM
                    maskCanvas.height = BFS_DIM
                    maskCtx.drawImage(img, 0, 0, BFS_DIM, BFS_DIM)
                    
                    const maskData = maskCtx.getImageData(0, 0, BFS_DIM, BFS_DIM)
                    const data = maskData.data
                    const visited = new Uint8Array(BFS_DIM * BFS_DIM)
                    let maxArea = 0
                    let maxComponent = []
                    
                    // Threshold mask heavily to destroy faint ghost text
                    for (let i = 3; i < data.length; i += 4) {
                        data[i] = data[i] > 100 ? 255 : 0
                    }
                    
                    // BFS to find the largest contiguous blob (the product/person)
                    for (let y = 0; y < BFS_DIM; y++) {
                        for (let x = 0; x < BFS_DIM; x++) {
                            const idx = y * BFS_DIM + x
                            if (!visited[idx] && data[idx * 4 + 3] === 255) {
                                const queue = [idx]
                                visited[idx] = 1
                                const component = []
                                let head = 0
                                
                                while (head < queue.length) {
                                    const curr = queue[head++]
                                    component.push(curr)
                                    
                                    const cx = curr % BFS_DIM
                                    const cy = Math.floor(curr / BFS_DIM)
                                    
                                    if (cx > 0) {
                                        const nIdx = curr - 1
                                        if (!visited[nIdx] && data[nIdx * 4 + 3] === 255) { visited[nIdx] = 1; queue.push(nIdx) }
                                    }
                                    if (cx < BFS_DIM - 1) {
                                        const nIdx = curr + 1
                                        if (!visited[nIdx] && data[nIdx * 4 + 3] === 255) { visited[nIdx] = 1; queue.push(nIdx) }
                                    }
                                    if (cy > 0) {
                                        const nIdx = curr - BFS_DIM
                                        if (!visited[nIdx] && data[nIdx * 4 + 3] === 255) { visited[nIdx] = 1; queue.push(nIdx) }
                                    }
                                    if (cy < BFS_DIM - 1) {
                                        const nIdx = curr + BFS_DIM
                                        if (!visited[nIdx] && data[nIdx * 4 + 3] === 255) { visited[nIdx] = 1; queue.push(nIdx) }
                                    }
                                }
                                
                                if (component.length > maxArea) {
                                    maxArea = component.length
                                    maxComponent = component
                                }
                            }
                        }
                    }
                    
                    // Erase everything
                    for (let i = 3; i < data.length; i += 4) {
                        data[i] = 0
                    }
                    // Restore ONLY the largest blob
                    for (let i = 0; i < maxComponent.length; i++) {
                        const idx = maxComponent[i]
                        data[idx * 4 + 0] = 255
                        data[idx * 4 + 1] = 255
                        data[idx * 4 + 2] = 255
                        data[idx * 4 + 3] = 255
                    }
                    
                    maskCtx.putImageData(maskData, 0, 0)
                    
                    // Stretch the perfectly clean mask back to High-Res size
                    const hrMaskCanvas = document.createElement('canvas')
                    hrMaskCanvas.width = hrCanvas.width
                    hrMaskCanvas.height = hrCanvas.height
                    const hrMaskCtx = hrMaskCanvas.getContext('2d')
                    hrMaskCtx.drawImage(maskCanvas, 0, 0, hrMaskCanvas.width, hrMaskCanvas.height)
                    
                    finalCtx.drawImage(hrCanvas, 0, 0)
                    finalCtx.globalCompositeOperation = 'destination-in'
                    finalCtx.drawImage(hrMaskCanvas, 0, 0)
                    
                    finalCtx.globalCompositeOperation = 'destination-over'
                    finalCtx.fillStyle = '#FFFFFF'
                    finalCtx.fillRect(0, 0, finalCanvas.width, finalCanvas.height)
                    
                    resolve({
                      base64: finalCanvas.toDataURL('image/jpeg', 0.95),
                      width: finalCanvas.width,
                      height: finalCanvas.height
                    })
                  }
                  img.src = finalUrl
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
            
            // Clear batch
            window.batchImages = []
            window.batchContexts = []
        }
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
