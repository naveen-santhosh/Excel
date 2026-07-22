import io
import re
import os
import asyncio
import gc
from fastapi import FastAPI, File, UploadFile
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
import fitz  # PyMuPDF
import xlsxwriter
from PIL import Image
import numpy as np

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
        
class ProductData(BaseModel):
    color: str
    style_code: str
    mrp: str
    material: str
    sizes: str
    image_base64: str

class ExcelRequest(BaseModel):
    products: List[ProductData]

@app.post("/generate-excel")
async def generate_excel(request: ExcelRequest):
    excel_filename = "catalog_output.xlsx"
    workbook = xlsxwriter.Workbook(excel_filename)
    worksheet = workbook.add_worksheet()
    
    headers = ["Image", "Color", "Style code", "MRP", "Material", "Sizes"]
    for col_num, header in enumerate(headers):
        worksheet.write(0, col_num, header)
        
    worksheet.set_column('A:A', 30)
    for col in range(1, 6):
        worksheet.set_column(col, col, 20)

    row = 1
    
    try:
        for product in request.products:
            worksheet.set_row(row, 150)
            
            # Decode base64 image
            if product.image_base64.startswith("data:image"):
                base64_data = product.image_base64.split(",")[1]
            else:
                base64_data = product.image_base64
                
            image_bytes = base64.b64decode(base64_data)
            img_io = io.BytesIO(image_bytes)
            
            worksheet.insert_image(row, 0, f"img_{row}.png", {'image_data': img_io, 'x_scale': 0.15, 'y_scale': 0.15, 'positioning': 1})
            
            worksheet.write(row, 1, product.color)
            worksheet.write(row, 2, product.style_code)
            worksheet.write(row, 3, product.mrp)
            worksheet.write(row, 4, product.material)
            worksheet.write(row, 5, product.sizes)
            
            row += 1
            
    except Exception as e:
        import traceback
        err_msg = f"Error: {str(e)}"
        print(err_msg)
        traceback.print_exc()
        worksheet.write(row, 0, "An error occurred during processing!")
        worksheet.write(row + 1, 0, err_msg)
    finally:
        workbook.close()
        
    return FileResponse(
        path=excel_filename, 
        filename="catalog_output.xlsx",
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
