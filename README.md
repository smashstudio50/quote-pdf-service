
# Quote PDF Generation Microservice

This microservice generates high-quality PDFs for quotes using Puppeteer and Node.js. It's designed to work with the HVAC Maintenance Management System.

## Features

- Generates professional A4 PDFs from quote data
- Integrates with Supabase for authentication and storage
- Includes high-quality formatting with proper page breaks
- Handles rooms and equipment details
- Optimized for performance with caching

## Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Copy `.env.example` to `.env` and configure environment variables:
   ```
   cp .env.example .env
   ```

3. Set required environment variables:
   - `SUPABASE_URL`: Your Supabase project URL
   - `SUPABASE_SERVICE_KEY`: Supabase service role key (for storage access)
   - `PORT`: Port to run the service on (default: 3000)
   - `CORS_ORIGIN`: Your frontend application URL (for CORS)

4. Start the service:
   ```
   npm start
   ```

## API Endpoints

### Generate Quote PDF
```
POST /generate-quote-pdf
```

Request body:
```json
{
  "quoteId": "uuid-of-quote",
  "options": {
    "includeTitle": true,
    "includeLogo": true,
    "includeTerms": true,
    "includePricing": true,
    "includeRooms": true,
    "pageSize": "a4",
    "titlePage": {
      "heading": "Professional Quotation",
      "subheading": "Quote Reference",
      "backgroundColor": "#ffffff",
      "backgroundUrl": "url-to-background-image"
    }
  }
}
```

Response:
```json
{
  "success": true,
  "documentUrl": "https://your-supabase-url/storage/v1/object/...",
  "fileName": "quote-reference-123456.pdf",
  "processingTime": 1234
}
```

### Health Check
```
GET /health
```

Response:
```json
{
  "status": "ok",
  "uptime": 123.45
}
```

## Deployment

This service can be deployed to various platforms:

- Render
- Railway
- Digital Ocean
- AWS
- Heroku
- Any other Node.js hosting platform

## Configuration in Frontend

After deploying, set the `VITE_PDF_SERVICE_URL` environment variable in your frontend project to the URL of this microservice.
