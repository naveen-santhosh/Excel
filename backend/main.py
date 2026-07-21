import io
import re
import os
import asyncio
import gc
from fastapi import FastAPI, File, UploadFile
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
import fitz  # PyMuPDF
from rembg import remove, new_session
import onnxruntime as ort
import xlsxwriter
from PIL import Image
import easyocr
import numpy as np
import torch

# Optimize PyTorch for low-memory CPU environments
torch.set_num_threads(1)
torch.set_num_interop_threads(1)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "https://pdf-to-excel-xi-six.vercel.app"
    ],
    allow_origin_regex=r"https://pdf-to-excel-.*\.vercel\.app",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
async def health_check():
    return {"status": "healthy"}

# We will instantiate models locally and destroy them to save memory

def parse_text(text: str):
    """Attempt to parse specific fields from the text using a robust block-finding algorithm."""
    text_norm = text.replace("\n", " ").strip()
    text_norm = re.sub(r'Re[ec]bok', '', text_norm, flags=re.IGNORECASE).strip()
    
    details = {
        "Color": "",
        "Style code": "",
        "MRP": "",
        "Material": "",
        "Sizes": ""
    }
    
    # Aggressive OCR misspelling matching
    keywords = {
        "Color": [r"color", r"colour", r"olor", r"colar", r"colur"],
        "Style code": [r"style\s*code", r"style\s*no", r"style", r"tyle\s*code", r"syk\s*code", r"stlye", r"sytle", r"code"],
        "MRP": [r"\bmrp\b", r"\brp\b", r"price", r"m\.r\.p"],
        "Material": [r"material", r"fabric", r"aterial", r"matenal", r"hatenal", r"uatenal", r"atenal"],
        "Sizes": [r"sizes", r"size", r"izes", r"ize", r"s1ze"]
    }
    
    found_fields = []
    text_lower = text_norm.lower()
    
    for field, patterns in keywords.items():
        for pattern in patterns:
            for match in re.finditer(pattern, text_lower):
                # Ensure we don't double count a field
                if not any(f["field"] == field for f in found_fields):
                    found_fields.append({
                        "field": field,
                        "start": match.start(),
                        "end": match.end()
                    })
                break
            if any(f["field"] == field for f in found_fields):
                break
                
    # Sort found fields by their appearance in the text
    found_fields.sort(key=lambda x: x["start"])
    
    # Catch any text that appears BEFORE the first keyword
    if found_fields and found_fields[0]["start"] > 0:
        pre_text = text_norm[0:found_fields[0]["start"]].strip()
        # Clean up any trailing colons or dashes from the pre_text
        pre_text = re.sub(r'[\s:\-]+$', '', pre_text).strip()
        
        if pre_text:
            logical_order = ["Color", "Style code", "MRP", "Material", "Sizes"]
            for field in logical_order:
                if not any(f["field"] == field for f in found_fields):
                    details[field] = pre_text
                    break
    
    # Extract the values between the found keyword positions
    for i in range(len(found_fields)):
        current = found_fields[i]
        field_name = current["field"]
        
        start_idx = current["end"]
        # Skip colon, dash, or space immediately after keyword
        while start_idx < len(text_norm) and text_norm[start_idx] in [' ', ':', '-']:
            start_idx += 1
            
        if i + 1 < len(found_fields):
            end_idx = found_fields[i+1]["start"]
        else:
            end_idx = len(text_norm)
            
        val = text_norm[start_idx:end_idx].strip()
        details[field_name] = val
        
    # Final cleanup sweeps
    for key in details:
        # Remove stray colons or dashes that might have ended up at the end of values
        details[key] = re.sub(r'[\s:\-]+$', '', details[key]).strip()
        
    if details["MRP"]:
        # Specific cleanup for MRP to extract just the number if possible, or remove common OCR artifacts
        details["MRP"] = re.sub(r'[\s/\-]+$', '', details["MRP"]).strip()
        
    if details["Sizes"]:
        details["Sizes"] = details["Sizes"].replace('I', '/')
        
    return details

@app.post("/api/upload")
async def upload_pdf(file: UploadFile = File(...)):
    pdf_path = f"temp_{file.filename}"
    with open(pdf_path, "wb") as f:
        f.write(await file.read())
        
    excel_filename = f"output_{file.filename}.xlsx"
    workbook = xlsxwriter.Workbook(excel_filename)
    worksheet = workbook.add_worksheet()
    
    headers = ["Image", "Color", "Style code", "MRP", "Material", "Sizes"]
    for col_num, header in enumerate(headers):
        worksheet.write(0, col_num, header)
        
    worksheet.set_column('A:A', 30)
    for col in range(1, 6):
        worksheet.set_column(col, col, 20)

    try:
        pdf_document = fitz.open(pdf_path)
        row = 1
        
        for page_num in range(len(pdf_document)):
            # Skip the first page (banner page) as requested by the user
            if page_num == 0:
                continue
                
            page = pdf_document.load_page(page_num)
            
            # Render the whole page to a high-res image
            pix = page.get_pixmap(dpi=150)
            img_data = pix.tobytes("png")
            img = Image.open(io.BytesIO(img_data))
            
            width, height = img.size
            
            # Crop the left 50% for the main model image
            model_crop = img.crop((0, 0, int(width * 0.50), height))
            
            # Crop the bottom right for the text box
            # Starting x at 35% ensures we absolutely don't cut off the first letters
            text_crop = img.crop((int(width * 0.35), int(height * 0.55), width, height))
            
            # Extract text using OCR under no_grad to reduce memory usage
            text_np = np.array(text_crop)
            with torch.no_grad():
                # Initialize reader locally so it can be garbage collected
                reader = easyocr.Reader(['en'], model_storage_directory='/tmp/easyocr_models', gpu=False)
                ocr_results = reader.readtext(text_np, detail=0)
                del reader
                gc.collect()
            ocr_text = "\n".join(ocr_results)
            
            parsed_data = parse_text(ocr_text)
            
            # Remove background from the model crop
            model_bytes = io.BytesIO()
            model_crop.save(model_bytes, format="PNG")
            best_img_bytes = model_bytes.getvalue()
            
            # Use the single-threaded low-memory rembg session
            def process_rembg(img_b):
                opts = ort.SessionOptions()
                opts.intra_op_num_threads = 1
                opts.inter_op_num_threads = 1
                opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
                sess = new_session("u2net", providers=["CPUExecutionProvider"], sess_opts=opts)
                res = remove(img_b, session=sess)
                del sess
                return res
            
            output_img_bytes = await asyncio.to_thread(process_rembg, best_img_bytes)
            gc.collect()
            
            temp_img_path = f"temp_img_{page_num}.png"
            img_io = io.BytesIO(output_img_bytes)
            with Image.open(img_io) as pil_img:
                pil_img.save(temp_img_path, format="PNG")
                
            worksheet.set_row(row, 150)
            worksheet.insert_image(row, 0, temp_img_path, {'x_scale': 0.15, 'y_scale': 0.15, 'positioning': 1})
            
            # Write text data
            worksheet.write(row, 1, parsed_data["Color"])
            worksheet.write(row, 2, parsed_data["Style code"])
            worksheet.write(row, 3, parsed_data["MRP"])
            worksheet.write(row, 4, parsed_data["Material"])
            worksheet.write(row, 5, parsed_data["Sizes"])
            
            row += 1
            
            # Clean up memory immediately after processing each page
            del page
            del model_crop
            del text_crop
            gc.collect()
            
    except Exception as e:
        print(f"Error: {e}")
    finally:
        if 'pdf_document' in locals():
            pdf_document.close()
        workbook.close()
        
        if os.path.exists(pdf_path):
            os.remove(pdf_path)
            
        for f in os.listdir("."):
            if f.startswith("temp_img_") and f.endswith(".png"):
                try:
                    os.remove(f)
                except:
                    pass

    return FileResponse(
        path=excel_filename, 
        filename="catalog_output.xlsx",
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
