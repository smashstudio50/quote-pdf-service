# PDF Service Deployment Guide

## Environment Variables Setup

The PDF service requires the following environment variables to be set:

### Required
- `SUPABASE_URL`: Your Supabase project URL (e.g., https://your-project-id.supabase.co)
- `SUPABASE_SERVICE_KEY`: Your Supabase service role key (from Project Settings > API)
- `CORS_ORIGIN`: Comma-separated list of allowed origins for CORS (e.g., https://yourdomain.com,https://localhost:3000)
  - **IMPORTANT**: Must include the EXACT origin including protocol (https://), subdomain, and NO trailing slash
  - For Lovable projects, use your project URL (e.g., `https://e7fa105b-749a-475f-8495-9f5ad5b8c35a.lovableproject.com`)

### Optional
- `PORT`: The port to run the service on (defaults to 3000)
- `NODE_ENV`: The environment (development, production, etc.)
- `PDF_GENERATION_TIMEOUT`: Maximum time in milliseconds for PDF generation (default: 60000)
- `IMAGE_PROCESSING_TIMEOUT`: Maximum time in milliseconds for image processing (default: 30000)
- `REQUEST_TIMEOUT`: Maximum time in milliseconds for the entire request (default: 120000)
- `OPTIMIZE_IMAGES`: Whether to optimize images for better performance (true/false)
- `MAX_IMAGE_WIDTH`: Maximum width for images in PDFs (pixels)
- `MAX_GENERATION_RETRIES`: Number of automatic retries for failed PDF generations (default: 2)
- `DEBUG_MODE`: Enable detailed logging for troubleshooting (true/false)

## CORS Configuration Troubleshooting

If you see errors like:

```
Access to fetch at 'https://quote-pdf-service-production.up.railway.app/...' from origin 'https://your-domain.com' has been blocked by CORS policy
```

Check the following:

1. Ensure the CORS_ORIGIN environment variable in Railway includes your **exact** domain:
   - Must include protocol (https://)
   - Must not have a trailing slash
   - Must match exactly what's in your browser URL bar
   - Example: `https://e7fa105b-749a-475f-8495-9f5ad5b8c35a.lovableproject.com`

2. If using multiple domains, separate them with commas (no spaces):
   ```
   CORS_ORIGIN=https://yourdomain.com,https://staging.yourdomain.com
   ```

3. After updating CORS settings, redeploy the service in Railway for changes to take effect

4. If CORS issues persist, you may need to add a proxy endpoint in your frontend application

## Performance Configuration

If you're experiencing timeouts during PDF generation, especially with documents containing images:

1. Increase the timeout values in your Railway environment variables:
   ```
   PDF_GENERATION_TIMEOUT=120000
   IMAGE_PROCESSING_TIMEOUT=60000
   REQUEST_TIMEOUT=180000
   ```

2. Consider optimizing any images before including them in quotes:
   - Resize large images to appropriate dimensions (e.g., max 1200px width)
   - Compress images to reduce file size
   - Consider using image CDNs or Supabase storage transformations

3. For Railway deployments, you may need to increase the resource allocation:
   - Go to your project settings
   - Increase the memory allocation if available
   - Consider upgrading to a higher service tier if processing large documents

4. Implement frontend strategies for large documents:
   - Enable the 'Fast Mode' option when generating complex PDFs
   - Disable background images when experiencing timeouts
   - Use the 'Optimize Images' option to automatically resize large images

## Setting Up in Railway

1. Go to your project in Railway at [https://railway.app/project](https://railway.app/project)
2. Navigate to the Variables tab
3. Add the required environment variables:
   ```
   SUPABASE_URL=https://your-project-id.supabase.co
   SUPABASE_SERVICE_KEY=your-service-role-key
   CORS_ORIGIN=https://your-frontend-domain.com
   ```
4. Add optional timeout configurations if needed:
   ```
   PDF_GENERATION_TIMEOUT=120000
   IMAGE_PROCESSING_TIMEOUT=60000
   REQUEST_TIMEOUT=180000
   ```
5. Save changes and redeploy

## Service URL

The service is deployed at: [https://quote-pdf-service-production.up.railway.app](https://quote-pdf-service-production.up.railway.app)

## Checking Service Status

You can verify the service is running by visiting:

- `/health` - Returns service health status and memory usage
- `/ping` - Simple ping endpoint (returns "pong", no CORS required)
- `/test-cors` - Tests if CORS is properly configured

## Health Endpoint

The `/health` endpoint returns detailed information about the service:

```json
{
  "status": "ok",
  "uptime": 12345,
  "memoryUsage": {
    "rss": "120MB",
    "heapTotal": "80MB",
    "heapUsed": "65MB"
  },
  "endpoints": {
    "/ping": true,
    "/test-cors": true,
    "/generate-quote-pdf": true
  },
  "version": "1.0.0"
}
```

## Troubleshooting

If you see "supabaseUrl is required" error:
1. Check if the environment variables are properly set in Railway
2. Verify the variable names are exactly as specified above
3. Redeploy after making changes to environment variables

For CORS issues:
1. Ensure your frontend domain is included in the CORS_ORIGIN list
2. Check for any typos in the URLs
3. Remember to include the protocol (https://) in the CORS_ORIGIN list
4. **Important**: The CORS_ORIGIN must include the exact origin, including any subdomains or ports (for example: `https://e7fa105b-749a-475f-8495-9f5ad5b8c35a.lovableproject.com`)
5. Verify that POST endpoints have the CORS middleware applied correctly
6. After updating the CORS_ORIGIN value, redeploy your application in Railway

### 502 Bad Gateway / Timeout Issues

If you encounter a "502 Bad Gateway" error when generating PDFs:
1. This typically indicates that the PDF generation process is taking too long and timing out
2. Check the Railway logs for specific error messages or timeout notifications
3. Increase the timeout values as suggested in the Performance Configuration section
4. For quotes with many images or complex layouts, try reducing complexity or optimizing images
5. Make sure your Railway instance has sufficient memory allocated for image processing
6. Consider adding a retry mechanism in your frontend code for large document generation

### No-CORS Mode Fallback

If you're still encountering CORS issues, you can try a no-CORS mode fallback in your frontend code:

```typescript
// Try with regular CORS mode first
try {
  const response = await fetch(pdfServiceUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data)
  });
  // Process response
} catch (error) {
  console.warn('CORS error, trying with no-cors mode', error);
  // This will only work for GET requests and won't return usable response data
  // but can be used as a fallback for simple pings
  const fallbackResponse = await fetch(pdfServiceUrl, {
    method: 'GET',
    mode: 'no-cors'
  });
  // Handle fallback
}
```

### Debugging PDF Generation Issues

If you're experiencing issues with PDF generation:

1. Set `DEBUG_MODE=true` in your environment variables for detailed logging
2. Check the Railway logs for any error messages
3. Review network requests in your browser's developer tools
4. Try generating with the 'Fast Mode' option enabled
5. Disable background images and rooms for complex quotes
6. Verify that image URLs in your quotes are accessible from the PDF service

## Storage Bucket Setup

Ensure you have a storage bucket named 'quote_pdfs' in your Supabase project:
1. Go to Supabase Dashboard > Storage
2. Create a new bucket called 'quote_pdfs' if it doesn't exist
3. Set appropriate permissions for the bucket
