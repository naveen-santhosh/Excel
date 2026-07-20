# Use a slim Python 3.10 image
FROM python:3.10-slim

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PORT=8000

# Set working directory
WORKDIR /app

# Install system dependencies needed for OpenCV, PyMuPDF, and easyocr
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libgl1-mesa-glx \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install python packages
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download ML models during build to speed up container startup and runtime requests
RUN python -c "import easyocr; easyocr.Reader(['en'])"
RUN python -c "from rembg import new_session; new_session('u2net')"

# Copy the rest of the application code
COPY . .

# Expose the API port
EXPOSE 8000

# Command to run the application using uvicorn
CMD uvicorn main:app --host 0.0.0.0 --port $PORT
