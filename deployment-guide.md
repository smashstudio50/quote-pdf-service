
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

## Authentication

The PDF service requires authentication using Supabase JWT tokens. Users must be authenticated with Supabase to generate PDFs.

1. The frontend application must include a valid JWT token in the Authorization header
2. Requests without a valid token will return a 401 Unauthorized error
3. Make sure that your `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are correctly set for token validation

For testing purposes, you can verify your authentication flow is working by checking the Supabase session:

```javascript
const { data: { session } } = await supabase.auth.getSession();
console.log("Auth session:", session ? "Valid" : "Not authenticated");
```

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

## Storage Bucket Setup

Ensure you have a storage bucket named 'quote_pdfs' in your Supabase project:
1. Go to Supabase Dashboard > Storage
2. Create a new bucket called 'quote_pdfs' if it doesn't exist
3. Set appropriate permissions for the bucket

## Troubleshooting

### "Unauthorized - No token provided" Error
This error occurs when:
1. The user is not authenticated with Supabase
2. The JWT token isn't included in the request
3. The token is invalid or expired

To fix:
1. Make sure users are logged in before generating PDFs
2. Verify the `Authorization` header is being sent with the JWT token
3. Check that your Supabase credentials are correct in your Railway environment

### 502 Bad Gateway / Timeout Issues

If you encounter a "502 Bad Gateway" error when generating PDFs:
1. This typically indicates that the PDF generation process is taking too long and timing out
2. Check the Railway logs for specific error messages or timeout notifications
3. Increase the timeout values as suggested in the Performance Configuration section
4. For quotes with many images or complex layouts, try reducing complexity or optimizing images
5. Make sure your Railway instance has sufficient memory allocated for image processing
6. Consider adding a retry mechanism in your frontend code for large document generation
