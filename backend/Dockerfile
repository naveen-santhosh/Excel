# Use a full Python 3.10 base image (has compiler and system tools pre-installed)
FROM python:3.10

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PORT=8000
ENV U2NET_HOME=/tmp
ENV OMP_NUM_THREADS=1
ENV MKL_NUM_THREADS=1
ENV OPENBLAS_NUM_THREADS=1
ENV VECLIB_MAXIMUM_THREADS=1
ENV NUMEXPR_NUM_THREADS=1

# Set working directory
WORKDIR /app

# Install system dependencies needed for OpenCV, PyMuPDF, and easyocr


# Copy requirements and install python packages
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application code
COPY . .

# Expose the API port
EXPOSE 8000

# Command to run the application using uvicorn
CMD uvicorn main:app --host 0.0.0.0 --port $PORT
