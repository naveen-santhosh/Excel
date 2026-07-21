import { useState, useCallback } from 'react'
import { UploadCloud, FileType, CheckCircle, AlertCircle, Loader2, Download } from 'lucide-react'
import './App.css'

function App() {
  const [file, setFile] = useState(null)
  const [isDragging, setIsDragging] = useState(false)
  const [status, setStatus] = useState('idle') // idle, uploading, processing, success, error
  const [errorMsg, setErrorMsg] = useState('')
  const [downloadUrl, setDownloadUrl] = useState('')

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
    if (downloadUrl) {
      URL.revokeObjectURL(downloadUrl)
      setDownloadUrl('')
    }
  }

  const handleUpload = async () => {
    if (!file) return

    setStatus('processing')
    const formData = new FormData()
    formData.append('file', file)

    try {
      let apiBaseUrl = import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000';
      if (apiBaseUrl && !apiBaseUrl.startsWith('http://') && !apiBaseUrl.startsWith('https://')) {
        apiBaseUrl = `https://${apiBaseUrl}`;
      }
      const response = await fetch(`${apiBaseUrl}/api/upload`, {
        method: 'POST',
        body: formData,
      })

      if (!response.ok) {
        throw new Error('Failed to process the PDF. Please try again.')
      }

      // Get the file as a blob
      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      setDownloadUrl(url)
      setStatus('success')
    } catch (err) {
      setErrorMsg(err.message || 'An error occurred during processing.')
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
              <div className="status-text">
                <h4>Processing your catalog...</h4>
                <p>Extracting images, removing backgrounds, and parsing text. This might take a few minutes for large files.</p>
              </div>
            </div>
          )}

          {status === 'error' && (
            <div className="status-box error">
              <AlertCircle size={24} />
              <div className="status-text">
                <h4>Upload Failed</h4>
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
