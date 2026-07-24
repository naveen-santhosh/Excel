import io
import base64
import os
import json
import traceback
from fastapi import FastAPI
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional
import xlsxwriter

import google.generativeai as genai
from dotenv import load_dotenv

load_dotenv()
genai.configure(api_key=os.environ.get("GEMINI_API_KEY", ""))

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

@app.get("/api")
async def health_check():
    return {"status": "healthy"}

class ExtractRequest(BaseModel):
    image_base64: str

class ExtractedInfo(BaseModel):
    is_product_page: bool
    color: str = ""
    style_code: str = ""
    mrp: str = ""
    material: str = ""
    sizes: str = ""

@app.post("/api/extract-info", response_model=ExtractedInfo)
async def extract_info(request: ExtractRequest):
    try:
        if request.image_base64.startswith("data:image"):
            base64_data = request.image_base64.split(",")[1]
        else:
            base64_data = request.image_base64
            
        image_bytes = base64.b64decode(base64_data)
        
        model = genai.GenerativeModel("gemini-2.5-flash")
        
        prompt = """
        You are an expert data extractor for product catalogs. Analyze the provided catalog page image.
        1. Determine if this is a "product page". A product page contains a specific product with specs (e.g., Color, Style Code, MRP, Material, Sizes). Introductory pages, brand story pages, or purely lifestyle images without specs are NOT product pages.
        2. If it IS a product page, extract the exact values for the following fields. If a field is missing, leave it as an empty string.
        3. If it is NOT a product page, set "is_product_page" to false and leave all other fields empty.

        Return ONLY a valid JSON object matching this exact schema, with no markdown formatting or backticks:
        {
          "is_product_page": boolean,
          "color": "string",
          "style_code": "string",
          "mrp": "string",
          "material": "string",
          "sizes": "string"
        }
        """
        
        import time
        max_retries = 5
        base_delay = 20
        response = None
        
        for attempt in range(max_retries):
            try:
                response = model.generate_content([
                    {'mime_type': 'image/jpeg', 'data': image_bytes},
                    prompt
                ])
                break
            except Exception as e:
                error_msg = str(e)
                if "Quota exceeded" in error_msg or "429" in error_msg:
                    if attempt == max_retries - 1:
                        raise
                    print(f"Rate limit exceeded (attempt {attempt+1}/{max_retries}). Retrying in {base_delay} seconds...")
                    time.sleep(base_delay)
                    base_delay *= 1.5
                else:
                    raise
        
        text = response.text.strip()
        if text.startswith("```json"):
            text = text[7:]
        if text.endswith("```"):
            text = text[:-3]
            
        data = json.loads(text.strip())
        
        return ExtractedInfo(
            is_product_page=data.get("is_product_page", False),
            color=str(data.get("color", "")),
            style_code=str(data.get("style_code", "")),
            mrp=str(data.get("mrp", "")),
            material=str(data.get("material", "")),
            sizes=str(data.get("sizes", ""))
        )
        
    except Exception as e:
        print(f"Extraction error: {e}")
        traceback.print_exc()
        return ExtractedInfo(is_product_page=False)

class ProductData(BaseModel):
    color: str
    style_code: str
    mrp: str
    material: str
    sizes: str
    image_base64: str
    width: Optional[int] = None
    height: Optional[int] = None

class ExcelRequest(BaseModel):
    products: List[ProductData]

@app.post("/api/generate-excel")
async def generate_excel(request: ExcelRequest):
    output = io.BytesIO()
    workbook = xlsxwriter.Workbook(output)
    worksheet = workbook.add_worksheet()
    
    headers = ["Image", "Color", "Style code", "MRP", "Material", "Sizes"]
    for col_num, header in enumerate(headers):
        worksheet.write(0, col_num, header)
        
    worksheet.set_column('A:A', 60)
    for col in range(1, 6):
        worksheet.set_column(col, col, 25)

    row = 1
    
    try:
        for product in request.products:
            worksheet.set_row(row, 450)
            
            if product.image_base64.startswith("data:image"):
                base64_data = product.image_base64.split(",")[1]
            else:
                base64_data = product.image_base64
                
            image_bytes = base64.b64decode(base64_data)
            img_io = io.BytesIO(image_bytes)
            
            x_scale = 0.6
            y_scale = 0.6
            if product.width and product.height:
                # Cell width 60 is approx 420 pixels, height 450 is approx 600 pixels
                target_width = 400.0
                target_height = 580.0
                scale_w = target_width / product.width
                scale_h = target_height / product.height
                scale = min(scale_w, scale_h)
                x_scale = scale
                y_scale = scale
            
            worksheet.insert_image(row, 0, f"img_{row}.png", {'image_data': img_io, 'x_scale': x_scale, 'y_scale': y_scale, 'positioning': 1})
            
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
        
    output.seek(0)
    
    headers = {
        'Content-Disposition': 'attachment; filename="catalog_output.xlsx"'
    }
    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=headers
    )

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
