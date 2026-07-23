import io
import base64
from fastapi import FastAPI
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List
import xlsxwriter

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

class ProductData(BaseModel):
    color: str
    style_code: str
    mrp: str
    material: str
    sizes: str
    image_base64: str

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
        
    worksheet.set_column('A:A', 45)
    for col in range(1, 6):
        worksheet.set_column(col, col, 25)

    row = 1
    
    try:
        for product in request.products:
            worksheet.set_row(row, 300)
            
            if product.image_base64.startswith("data:image"):
                base64_data = product.image_base64.split(",")[1]
            else:
                base64_data = product.image_base64
                
            image_bytes = base64.b64decode(base64_data)
            img_io = io.BytesIO(image_bytes)
            
            worksheet.insert_image(row, 0, f"img_{row}.png", {'image_data': img_io, 'x_scale': 0.35, 'y_scale': 0.35, 'positioning': 1})
            
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
