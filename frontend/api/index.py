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
    item_box: Optional[List[float]] = None

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
        You are an expert data extractor for commercial product & corporate gift catalogs (such as FUZO, stationery, gadgets & electronics, kitchenware & utensils, bags & backpacks, home decor, and office utilities). Analyze the provided catalog page image.
        1. Determine if this is a "product page". A page showcasing a specific product item (e.g. lamp, charger, clock, bottle, mug, notebook, pen, backpack, speaker, organizer, tool) with a product title or features IS A PRODUCT PAGE. Only cover pages, table of contents, pure lifestyle banners without products, or copyright back covers are NOT product pages.
        2. Extract exact values for:
           - style_code: Main Product Title / Model Name / SKU / Item Code (e.g. "TRINITY", "VIVID", "ROVER", "CASA", "BREWSTER", "CANETA", "BEACON", "THE CUSTODIAN"). If a dedicated code is not listed, use the main Product Name Title!
           - material: Product Subtitle / Description / Features (e.g., "3 in 1 Portable Wireless Charging Station", "Borosilicate Glass Bottle with Hydration Reminder", "Metal Pen with Bamboo Grip", "6 in 1: Multi-Functional Bamboo Desk Utility").
           - color: Color / Finish if mentioned (or empty string if missing).
           - mrp: MRP / Price if mentioned (or empty string if missing).
           - sizes: Sizes / Dimensions / Capacity / Pack Qty if mentioned (or empty string if missing).
        3. CRITICAL: Provide `item_box`: [ymin, xmin, ymax, xmax] as percentage numbers from 0 to 100 that tightly wraps ONLY the physical product object(s) visible in the photo/render. The box must:
           - Include the COMPLETE product with no part cut off (top, bottom, left, right)
           - EXCLUDE ALL text: brand logo (e.g. "FUZO"), product name/title text, subtitle/feature text, price text, dimension text, social media URLs, and any overlaid captions
           - EXCLUDE decorative borders, background color blocks, and page margins
           - If multiple product views are shown (e.g. front + back), include ALL views in one box
           - Make the box generous enough that the full product is inside with a small margin
        4. If it is NOT a product page, set "is_product_page" to false and leave all other fields empty.

        Return ONLY a valid JSON object matching this exact schema:
        {
          "is_product_page": boolean,
          "color": "string",
          "style_code": "string",
          "mrp": "string",
          "material": "string",
          "sizes": "string",
          "item_box": [ymin, xmin, ymax, xmax]
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
        
        item_box = data.get("item_box")
        if isinstance(item_box, list) and len(item_box) == 4:
            try:
                item_box = [float(v) for v in item_box]
            except Exception:
                item_box = None
        else:
            item_box = None

        return ExtractedInfo(
            is_product_page=data.get("is_product_page", False),
            color=str(data.get("color", "")),
            style_code=str(data.get("style_code", "")),
            mrp=str(data.get("mrp", "")),
            material=str(data.get("material", "")),
            sizes=str(data.get("sizes", "")),
            item_box=item_box
        )
        
    except Exception as e:
        print(f"Extraction error: {e}")
        traceback.print_exc()
        return ExtractedInfo(is_product_page=False)

class BatchExtractRequest(BaseModel):
    images_base64: List[str]

class BatchExtractedInfo(BaseModel):
    results: List[ExtractedInfo]

@app.post("/api/extract-info-batch", response_model=BatchExtractedInfo)
async def extract_info_batch(request: BatchExtractRequest):
    try:
        model = genai.GenerativeModel("gemini-2.5-flash")
        
        contents = []
        for img_b64 in request.images_base64:
            if img_b64.startswith("data:image"):
                b64_data = img_b64.split(",")[1]
            else:
                b64_data = img_b64
            img_bytes = base64.b64decode(b64_data)
            contents.append({'mime_type': 'image/jpeg', 'data': img_bytes})
            
        prompt = f"""
        You are an expert data extractor for commercial product & corporate gift catalogs (such as FUZO, stationery, gadgets & electronics, kitchenware & utensils, bags & backpacks, home decor, and office utilities). Analyze the provided {len(contents)} catalog page images in the exact order they are provided.
        1. Determine if each page is a "product page". A page showcasing a specific product item (e.g. lamp, charger, clock, bottle, mug, notebook, pen, backpack, speaker, organizer, tool) with a product title or features IS A PRODUCT PAGE. Only cover pages, table of contents, pure lifestyle banners without products, or copyright back covers are NOT product pages.
        2. Extract exact values for:
           - style_code: Main Product Title / Model Name / SKU / Item Code (e.g. "TRINITY", "VIVID", "ROVER", "CASA", "BREWSTER", "CANETA", "BEACON", "THE CUSTODIAN"). Use the main Product Name Title!
           - material: Product Subtitle / Description / Features (e.g., "3 in 1 Portable Wireless Charging Station", "Borosilicate Glass Bottle with Hydration Reminder", "Metal Pen with Bamboo Grip", "6 in 1: Multi-Functional Bamboo Desk Utility").
           - color: Color / Finish if mentioned (or empty string if missing).
           - mrp: MRP / Price if mentioned (or empty string if missing).
           - sizes: Sizes / Dimensions / Capacity / Pack Qty if mentioned (or empty string if missing).
        3. CRITICAL: Provide `item_box`: [ymin, xmin, ymax, xmax] as percentage numbers from 0 to 100 that tightly wraps ONLY the physical product object(s) visible in the photo/render on each page. The box must:
           - Include the COMPLETE product with no part cut off (top, bottom, left, right)
           - EXCLUDE ALL text: brand logo (e.g. "FUZO"), product name/title text, subtitle/feature text, price text, dimension text, social media URLs, and any overlaid captions
           - EXCLUDE decorative borders, background color blocks, and page margins
           - If multiple product views are shown (e.g. front + back), include ALL views in one box
           - Make the box generous enough that the full product is inside with a small margin
        4. If NOT a product page, set "is_product_page" to false and leave all other fields empty.

        Return ONLY a valid JSON ARRAY containing exactly {len(contents)} objects in the same order as the images, matching this exact schema:
        [
          {{
            "is_product_page": boolean,
            "color": "string",
            "style_code": "string",
            "mrp": "string",
            "material": "string",
            "sizes": "string",
            "item_box": [ymin, xmin, ymax, xmax]
          }}
        ]
        Do not use markdown formatting or backticks. Just the raw JSON array.
        """
        
        contents.append(prompt)
        
        import time
        max_retries = 5
        base_delay = 20
        response = None
        
        for attempt in range(max_retries):
            try:
                response = model.generate_content(contents)
                break
            except Exception as e:
                error_msg = str(e)
                if "Quota exceeded" in error_msg or "429" in error_msg:
                    if attempt == max_retries - 1:
                        raise
                    print(f"Rate limit exceeded on batch (attempt {attempt+1}/{max_retries}). Retrying in {base_delay} seconds...")
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
        
        results = []
        for item in data:
            item_box = item.get("item_box")
            if isinstance(item_box, list) and len(item_box) == 4:
                try:
                    item_box = [float(v) for v in item_box]
                except Exception:
                    item_box = None
            else:
                item_box = None

            results.append(ExtractedInfo(
                is_product_page=item.get("is_product_page", False),
                color=str(item.get("color", "")),
                style_code=str(item.get("style_code", "")),
                mrp=str(item.get("mrp", "")),
                material=str(item.get("material", "")),
                sizes=str(item.get("sizes", "")),
                item_box=item_box
            ))
            
        return BatchExtractedInfo(results=results)
        
    except Exception as e:
        print(f"Batch Extraction error: {e}")
        traceback.print_exc()
        # Return all false if batch fails
        return BatchExtractedInfo(results=[ExtractedInfo(is_product_page=False) for _ in request.images_base64])

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
    
    # Define formats for larger text and clean alignment
    header_format = workbook.add_format({
        'bold': True,
        'font_size': 18,
        'font_name': 'Segoe UI',
        'font_color': '#FFFFFF',
        'bg_color': '#4F46E5',
        'align': 'center',
        'valign': 'vcenter',
        'border': 1
    })

    data_format = workbook.add_format({
        'font_size': 16,
        'font_name': 'Segoe UI',
        'font_color': '#0F172A',
        'align': 'center',
        'valign': 'vcenter',
        'text_wrap': True,
        'border': 1
    })

    bold_data_format = workbook.add_format({
        'bold': True,
        'font_size': 16,
        'font_name': 'Segoe UI',
        'font_color': '#0F172A',
        'align': 'center',
        'valign': 'vcenter',
        'text_wrap': True,
        'border': 1
    })

    worksheet.set_row(0, 35)

    headers = ["Image", "Color", "Style code", "MRP", "Material", "Sizes"]
    for col_num, header in enumerate(headers):
        worksheet.write(0, col_num, header, header_format)
        
    worksheet.set_column('A:A', 60)
    for col in range(1, 6):
        worksheet.set_column(col, col, 30)

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
                target_width = 400.0
                target_height = 580.0
                scale_w = target_width / product.width
                scale_h = target_height / product.height
                scale = min(scale_w, scale_h)
                x_scale = scale
                y_scale = scale
            
            worksheet.insert_image(row, 0, f"img_{row}.png", {'image_data': img_io, 'x_scale': x_scale, 'y_scale': y_scale, 'positioning': 1})
            
            worksheet.write(row, 1, product.color, data_format)
            worksheet.write(row, 2, product.style_code, bold_data_format)
            worksheet.write(row, 3, product.mrp, bold_data_format)
            worksheet.write(row, 4, product.material, data_format)
            worksheet.write(row, 5, product.sizes, data_format)
            
            row += 1
            
    except Exception as e:
        import traceback
        err_msg = f"Error: {str(e)}"
        print(err_msg)
        traceback.print_exc()
        worksheet.write(row, 0, "An error occurred during processing!", data_format)
        worksheet.write(row + 1, 0, err_msg, data_format)
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
