import io
import base64
import xlsxwriter
from firebase_functions import https_fn
from firebase_admin import initialize_app
from pydantic import BaseModel
from typing import List
from flask import send_file, jsonify

initialize_app()

class ProductData(BaseModel):
    color: str
    style_code: str
    mrp: str
    material: str
    sizes: str
    image_base64: str

class ExcelRequest(BaseModel):
    products: List[ProductData]

@https_fn.on_request(cors=https_fn.CorsOptions(cors_origins=["*"], cors_methods=["*"]))
def generate_excel(req: https_fn.Request) -> https_fn.Response:
    if req.method == "OPTIONS":
        return https_fn.Response(status=204)
        
    try:
        data = req.get_json()
        if not data:
            return https_fn.Response("No JSON data provided", status=400)
            
        request_data = ExcelRequest(**data)
    except Exception as e:
        return https_fn.Response(f"Invalid Request: {str(e)}", status=400)
        
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
        for product in request_data.products:
            worksheet.set_row(row, 300)
            
            # Decode base64 image
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
    
    return send_file(
        output,
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        as_attachment=True,
        download_name="catalog_output.xlsx"
    )
